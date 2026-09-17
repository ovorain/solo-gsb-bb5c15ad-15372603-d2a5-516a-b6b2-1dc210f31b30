import { parseTime, formatTime } from '../src/lib/time'
import { parseSrt, buildSrt } from '../src/lib/srt'
import { buildAnchors, mapTimestamp, mapCues, validateMapped } from '../src/lib/anchor'
import {
  PLAN_VERSION,
  buildPlan,
  isApplicable,
  matchPlan,
  normalizeText,
  parsePlan,
  serializePlan,
} from '../src/lib/plan'
import { SAMPLE_SRT } from '../src/sample'

let failures = 0
const assert = (cond: boolean, msg: string) => {
  if (cond) {
    console.log('  ✓', msg)
  } else {
    failures++
    console.error('  ✗ FAIL:', msg)
  }
}

// ---- time ----
console.log('time 解析/格式化')
assert(parseTime('00:00:01,500') === 1500, '1.5s 解析')
assert(parseTime('01:02:03.04') === 3723040, '点号分隔 1:02:03.04')
assert(parseTime('bad') === null, '非法时间返回 null')
assert(formatTime(3723040) === '01:02:03,040', '格式化')
assert(formatTime(-1500) === '-00:00:01,500', '负时间格式化带 -')
assert(parseTime(formatTime(123456789)) === 123456789, '往返一致')

// ---- map ----
console.log('无锚点：恒等')
assert(mapTimestamp(5000, []) === 5000, '保留原值')

console.log('单锚点：整体平移')
assert(mapTimestamp(1000, [{ source: 5000, target: 7000 }]) === 3000, '之前 +2000')
assert(mapTimestamp(9000, [{ source: 5000, target: 3000 }]) === 7000, '之后 -2000')

console.log('多锚点：分段线性 + 外推')
const a = [
  { source: 1000, target: 2000 },
  { source: 3000, target: 5000 },
  { source: 6000, target: 6000 },
]
assert(mapTimestamp(1000, a) === 2000, '锚点本身')
assert(mapTimestamp(2000, a) === 3500, '中点插值 (1k-3k 段斜率 1.5)')
assert(Math.abs(mapTimestamp(5000, a) - (5000 + 2000 / 3)) < 1e-9, '3k-6k 段插值 (斜率 1/3) ≈ 5666.67')
// 头部外推：斜率 1.5，t=0 => 2000 + (0-1000)*1.5 = 500
assert(mapTimestamp(0, a) === 500, '头部斜率外推')
// 尾部外推：斜率 1/3，t=9000 => 6000 + 3000/3 = 7000
assert(mapTimestamp(9000, a) === 7000, '尾部斜率外推')

console.log('锚点严格递增校验')
assert(buildAnchors([[1, 2]]) !== null, '单个锚点合法')
assert(buildAnchors([[1, 5], [2, 6]]) !== null, '双递增合法（乱序输入自动排序）')
assert(buildAnchors([[1, 5], [1, 6]]) === null, 'source 重复非法')
assert(buildAnchors([[1, 5], [2, 5]]) === null, 'target 相等非法')
assert(buildAnchors([[1, 5], [2, 4]]) === null, 'target 递减非法')
assert(buildAnchors([[2, 6], [1, 5]]) !== null, '乱序输入自动排序后合法')

// ---- SRT 解析 ----
console.log('SRT 解析')
const { cues, skipped } = parseSrt(SAMPLE_SRT)
assert(cues.length === 7, `示例解析出 7 条（实际 ${cues.length}）`)
assert(skipped === 0, '无跳过块')
assert(cues[0].id === '1' && cues[0].start === 1000 && cues[0].end === 4000, '第一条字段正确')
assert(cues[0].text.startsWith('欢迎使用'), '文本正确')

const crlf = parseSrt('1\r\n00:00:01,000 --> 00:00:02,000\r\nhi\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nbye')
assert(crlf.cues.length === 2, 'CRLF 解析')
const dot = parseSrt('1\n00:00:01.500 --> 00:00:02.000\nx')
assert(dot.cues.length === 1 && dot.cues[0].start === 1500, '点号毫秒解析')
const bad = parseSrt('1\nnot a timing\nx\n\n2\n00:00:01,000 --> 00:00:02,000\ny')
assert(bad.cues.length === 1 && bad.skipped === 1, '非法块跳过并计数')
const bom = parseSrt('﻿1\n00:00:01,000 --> 00:00:02,000\nx')
assert(bom.cues.length === 1 && bom.cues[0].id === '1', 'UTF-8 BOM 被正确去除')

// ---- 导出：序号与文本不变 ----
console.log('SRT 导出')
const mapped = mapCues(cues, [])
const out = buildSrt(mapped)
const reparsed = parseSrt(out)
assert(reparsed.cues.length === 7, '导出后仍 7 条')
assert(
  reparsed.cues.every((c, i) => c.id === cues[i].id && c.text === cues[i].text),
  '序号与文本不变',
)
assert(
  reparsed.cues.every((c, i) => c.start === cues[i].start && c.end === cues[i].end),
  '无锚点导出时间不变',
)
assert(out.includes('00:00:01,000 --> 00:00:04,000'), '时间码格式正确')

// ---- 校验 ----
console.log('错误检测')
const noIssue = validateMapped([
  { index: 0, id: '1', start: 0, end: 1000, text: '', newStart: 1000, newEnd: 2000 },
  { index: 1, id: '2', start: 0, end: 1000, text: '', newStart: 2000, newEnd: 3000 },
])
assert(noIssue.size === 0, '正常时间线无错误')

const neg = validateMapped([
  { index: 0, id: '1', start: 0, end: 1000, text: '', newStart: -500, newEnd: 500 },
])
assert(neg.get(0)?.some((i) => i.kind === 'negative'), '负时间标红')

const nonpos = validateMapped([
  { index: 0, id: '1', start: 0, end: 1000, text: '', newStart: 2000, newEnd: 2000 },
])
assert(nonpos.get(0)?.some((i) => i.kind === 'nonpositive'), '零时长标红')

const overlap = validateMapped([
  { index: 0, id: '1', start: 0, end: 1000, text: '', newStart: 1000, newEnd: 3000 },
  { index: 1, id: '2', start: 0, end: 1000, text: '', newStart: 2000, newEnd: 4000 },
])
assert(
  overlap.get(1)?.some((i) => i.kind === 'overlap' && i.withId === '1'),
  '重叠标红并指向前一条 #1',
)

// ---- 端到端：示例 + 双锚点 ----
console.log('端到端')
const e2e = mapCues(cues, [
  { source: cues[0].start, target: 3000 },
  { source: cues[6].start, target: 60000 },
])
const e2eIssues = validateMapped(e2e)
assert(e2e[0].newStart === 3000, '第一条映射到目标 3s')
assert(e2e[6].newStart === 60000, '最后一条映射到目标 60s')
assert(e2e.every((l) => l.newStart >= 0 && l.newEnd > l.newStart), '外推后无非负/非正问题')

// ---- 锚点方案 ----
console.log('锚点方案：文本规范化')
assert(normalizeText('  hello   world  ') === 'hello world', '去首尾空白 + 合并连续空白')
assert(normalizeText('a\nb\t\tc  d') === 'a b c d', '换行/制表符一并合并')
assert(normalizeText('') === '', '空串保持空串')
assert(normalizeText('保持 原样') === '保持 原样', '已规范文本不变')

console.log('锚点方案：导出 / 解析往返')
const planAnchors = [
  { source: cues[0].start, target: 3000 },
  { source: cues[4].start, target: 40000 },
]
const plan = buildPlan(planAnchors, cues)
assert(plan.version === PLAN_VERSION, '写入版本号')
assert(plan.anchors.length === 2, '导出 2 个锚点')
assert(plan.anchors[0].text === normalizeText(cues[0].text), '记录规范化文本')
assert(plan.anchors[0].source === cues[0].start && plan.anchors[0].target === 3000, '记录原始/目标时间')
const roundTrip = parsePlan(serializePlan(plan))
assert(roundTrip.ok && JSON.stringify(roundTrip.plan) === JSON.stringify(plan), '序列化后解析往返一致')

console.log('锚点方案：拒绝未知版本与畸形字段')
assert(!parsePlan('not json').ok, '非 JSON 拒绝')
assert(!parsePlan('[1,2]').ok, '顶层非对象拒绝')
assert(!parsePlan('{"anchors":[]}').ok, '缺少版本号拒绝')
assert(!parsePlan('{"version":2,"anchors":[]}').ok, '未知版本拒绝')
assert(!parsePlan('{"version":"1","anchors":[]}').ok, '版本号类型畸形拒绝')
assert(!parsePlan('{"version":1}').ok, '缺少 anchors 拒绝')
assert(!parsePlan('{"version":1,"anchors":[{"source":"1","target":2,"text":"x"}]}').ok, 'source 类型畸形拒绝')
assert(!parsePlan('{"version":1,"anchors":[{"source":1,"target":-2,"text":"x"}]}').ok, 'target 为负拒绝')
assert(!parsePlan('{"version":1,"anchors":[{"source":1,"target":2}]}').ok, '缺少 text 拒绝')
const emptyOk = parsePlan('{"version":1,"anchors":[]}')
assert(emptyOk.ok, '空锚点数组为合法文件')

console.log('锚点方案：匹配')
// 同一字幕文件 → 全部直接匹配
const m1 = matchPlan(plan.anchors, cues)
assert(m1.every((m) => m.kind === 'exact'), '原字幕全部直接匹配')
assert(m1.filter(isApplicable).length === 2, '两项均可应用')

// 修订版：时间整体 +1000ms、文本不变 → 全部迁移
const shifted = cues.map((c, i) => ({ ...c, index: i, start: c.start + 1000, end: c.end + 1000 }))
const m2 = matchPlan(plan.anchors, shifted)
assert(m2.every((m) => m.kind === 'moved'), '修订版全部迁移')
assert(m2[0].source === cues[0].start + 1000, '迁移到新的起始时间')
const rebuilt = buildAnchors(m2.filter(isApplicable).map((m) => [m.source ?? 0, m.anchor.target]))
assert(rebuilt !== null && rebuilt.length === 2, '迁移结果可构造合法锚点序列')

// 文本重复且无法直接匹配 → 冲突
const dupCues = [...cues, { id: '8', index: 7, start: 50000, end: 52000, text: cues[0].text }]
const m3 = matchPlan([{ source: 999, target: 3000, text: normalizeText(cues[0].text) }], dupCues)
assert(m3[0].kind === 'duplicate' && !isApplicable(m3[0]), '文本重复 → 冲突不应用')

// 文本缺失 → 冲突
const m4 = matchPlan([{ source: 999, target: 3000, text: '不存在的文本' }], cues)
assert(m4[0].kind === 'missing' && !isApplicable(m4[0]), '文本缺失 → 冲突不应用')

// 目标时间不严格递增 → 后者冲突
const m5 = matchPlan(
  [
    { source: cues[0].start, target: 5000, text: normalizeText(cues[0].text) },
    { source: cues[1].start, target: 5000, text: normalizeText(cues[1].text) },
  ],
  cues,
)
assert(m5[0].kind === 'exact' && m5[1].kind === 'order', '目标时间相等 → 第二项冲突')
assert(
  buildAnchors(m5.filter(isApplicable).map((m) => [m.source ?? 0, m.anchor.target])) !== null,
  '剔除冲突项后序列合法',
)

// 交叉迁移破坏原始时间顺序 → 后者冲突
const swapped = cues.map((c, i) => {
  if (i === 0) return { ...c, text: cues[1].text }
  if (i === 1) return { ...c, text: cues[0].text }
  return c
})
const m6 = matchPlan(
  [
    { source: cues[0].start, target: 3000, text: normalizeText(cues[0].text) },
    { source: cues[1].start, target: 9000, text: normalizeText(cues[1].text) },
  ],
  swapped,
)
assert(m6[0].kind === 'moved' && m6[1].kind === 'order', '交叉迁移 → 后者破坏顺序标冲突')

// 直接匹配优先于唯一文本迁移
const m7 = matchPlan([{ source: cues[2].start, target: 8000, text: normalizeText(cues[2].text) }], cues)
assert(m7[0].kind === 'exact' && m7[0].source === cues[2].start, '时间与文本均相同 → 直接匹配')

console.log(failures === 0 ? '\n全部测试通过 ✅' : `\n${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)