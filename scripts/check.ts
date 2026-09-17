import { parseTime, formatTime } from '../src/lib/time'
import { parseSrt, buildSrt } from '../src/lib/srt'
import { buildAnchors, mapTimestamp, mapCues, validateMapped } from '../src/lib/anchor'
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

console.log(failures === 0 ? '\n全部测试通过 ✅' : `\n${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
