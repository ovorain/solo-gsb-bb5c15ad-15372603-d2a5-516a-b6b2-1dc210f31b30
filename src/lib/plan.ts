import type { Anchor } from './anchor'
import type { Cue } from './srt'

/**
 * 锚点方案：把一次校准（锚点集合）序列化为可复用的 JSON 文件，
 * 之后可导入到“修订版 SRT”（时间轴变化、文本基本不变）上自动重建锚点。
 */

/** 方案文件版本号。导入时拒绝一切未知版本。 */
export const PLAN_VERSION = 1

export interface PlanAnchor {
  /** 原始时间（毫秒）：导出方案时锚点绑定字幕的起始时间 */
  source: number
  /** 目标时间（毫秒） */
  target: number
  /** 对应字幕的规范化文本（去除首尾空白、连续空白合并为单个空格） */
  text: string
}

export interface AnchorPlan {
  version: number
  anchors: PlanAnchor[]
}

/** 文本规范化：仅去除首尾空白、合并连续空白，不做任何其它改写。 */
export function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, ' ')
}

/** 由当前锚点与字幕构造方案对象（锚点按原始时间升序）。 */
export function buildPlan(anchors: Anchor[], cues: Cue[]): AnchorPlan {
  const byStart = new Map(cues.map((c) => [c.start, c]))
  return {
    version: PLAN_VERSION,
    anchors: anchors.map((a) => ({
      source: a.source,
      target: a.target,
      text: normalizeText(byStart.get(a.source)?.text ?? ''),
    })),
  }
}

/** 序列化为带缩进的 JSON 文本。 */
export function serializePlan(plan: AnchorPlan): string {
  return JSON.stringify(plan, null, 2) + '\n'
}

export type PlanParseResult = { ok: true; plan: AnchorPlan } | { ok: false; error: string }

/**
 * 解析并校验方案文件。版本未知或字段畸形时返回错误信息（供界面提示），
 * 不做任何容错性猜测。
 */
export function parsePlan(json: string): PlanParseResult {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return { ok: false, error: '文件不是合法的 JSON。' }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: '方案文件顶层必须是 JSON 对象。' }
  }
  const obj = raw as Record<string, unknown>
  if (obj.version === undefined) {
    return { ok: false, error: '方案文件缺少版本号（version 字段）。' }
  }
  if (obj.version !== PLAN_VERSION) {
    return {
      ok: false,
      error: `不支持的方案版本：${JSON.stringify(obj.version)}，当前仅支持版本 ${PLAN_VERSION}。`,
    }
  }
  if (!Array.isArray(obj.anchors)) {
    return { ok: false, error: '方案文件缺少 anchors 数组。' }
  }
  const anchors: PlanAnchor[] = []
  for (let i = 0; i < obj.anchors.length; i++) {
    const item: unknown = obj.anchors[i]
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return { ok: false, error: `第 ${i + 1} 个锚点不是对象。` }
    }
    const { source, target, text } = item as Record<string, unknown>
    if (typeof source !== 'number' || !Number.isFinite(source) || source < 0) {
      return { ok: false, error: `第 ${i + 1} 个锚点的 source 字段畸形（应为非负毫秒数）。` }
    }
    if (typeof target !== 'number' || !Number.isFinite(target) || target < 0) {
      return { ok: false, error: `第 ${i + 1} 个锚点的 target 字段畸形（应为非负毫秒数）。` }
    }
    if (typeof text !== 'string') {
      return { ok: false, error: `第 ${i + 1} 个锚点的 text 字段畸形（应为字符串）。` }
    }
    anchors.push({ source, target, text })
  }
  return { ok: true, plan: { version: PLAN_VERSION, anchors } }
}

/** 匹配结果类别：直接匹配 / 迁移 / 三类冲突（缺失、重复、破坏顺序）。 */
export type MatchKind = 'exact' | 'moved' | 'missing' | 'duplicate' | 'order'

export interface PlanMatch {
  /** 方案中的锚点（按 source 升序排列后的） */
  anchor: PlanAnchor
  /** 匹配成功后在当前字幕中的原始时间；冲突时为 null */
  source: number | null
  /** 匹配到的字幕序号（用于预览展示）；冲突时为 null */
  cueId: string | null
  kind: MatchKind
  /** 冲突原因（kind 为 missing / duplicate / order 时给出） */
  reason: string | null
}

/** 是否为可应用项（直接匹配或迁移）。 */
export function isApplicable(m: PlanMatch): boolean {
  return m.kind === 'exact' || m.kind === 'moved'
}

/**
 * 把方案锚点逐条匹配到当前字幕：
 * 1. 原始时间与规范化文本均相同 → 直接匹配；
 * 2. 否则，仅当规范化文本在全文中唯一时，迁移到该字幕的起始时间；
 * 3. 文本缺失、文本重复（不唯一），或应用后破坏
 *    “原始时间 / 目标时间均严格递增”的锚点顺序 → 标为冲突，不应用。
 *
 * 返回按方案 source 升序排列的匹配结果；可应用项保证能构造合法锚点序列。
 */
export function matchPlan(plan: PlanAnchor[], cues: Cue[]): PlanMatch[] {
  const byExact = new Map<string, Cue>()
  const firstByText = new Map<string, Cue>()
  const textCount = new Map<string, number>()
  for (const cue of cues) {
    const key = normalizeText(cue.text)
    const exactKey = `${cue.start}\n${key}`
    if (!byExact.has(exactKey)) byExact.set(exactKey, cue)
    if (!firstByText.has(key)) firstByText.set(key, cue)
    textCount.set(key, (textCount.get(key) ?? 0) + 1)
  }

  const sorted = [...plan].sort((a, b) => a.source - b.source)
  const matches: PlanMatch[] = []

  // 第一遍：逐条直接匹配 / 迁移 / 标记缺失与重复
  for (const anchor of sorted) {
    const exact = byExact.get(`${anchor.source}\n${anchor.text}`)
    if (exact) {
      matches.push({ anchor, source: anchor.source, cueId: exact.id, kind: 'exact', reason: null })
      continue
    }
    const count = textCount.get(anchor.text) ?? 0
    if (count === 0) {
      matches.push({
        anchor,
        source: null,
        cueId: null,
        kind: 'missing',
        reason: '当前字幕中找不到该文本',
      })
    } else if (count > 1) {
      matches.push({
        anchor,
        source: null,
        cueId: null,
        kind: 'duplicate',
        reason: `该文本在当前字幕中出现 ${count} 次，无法唯一迁移`,
      })
    } else {
      const cue = firstByText.get(anchor.text)
      matches.push({ anchor, source: cue ? cue.start : null, cueId: cue?.id ?? null, kind: 'moved', reason: null })
    }
  }

  // 第二遍：顺序校验。按方案 source 升序贪心筛选，凡使原始时间或目标时间
  // 无法严格递增的项标为冲突（不应用），其余项构成合法递增序列。
  let lastSource = -1
  let lastTarget = -1
  for (const m of matches) {
    if (m.source === null) continue
    if (m.source <= lastSource) {
      m.kind = 'order'
      m.reason = '迁移后与前一有效锚点的原始时间顺序冲突'
      continue
    }
    if (m.anchor.target <= lastTarget) {
      m.kind = 'order'
      m.reason = '目标时间无法保持严格递增'
      continue
    }
    lastSource = m.source
    lastTarget = m.anchor.target
  }

  return matches
}
