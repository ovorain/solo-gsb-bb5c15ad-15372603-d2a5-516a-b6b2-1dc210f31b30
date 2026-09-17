import type { PlanMatch } from '../lib/plan'
import { isApplicable } from '../lib/plan'
import { formatTime } from '../lib/time'

interface Props {
  matches: PlanMatch[]
  fileName: string
  onApply: () => void
  onCancel: () => void
}

const KIND_LABEL: Record<PlanMatch['kind'], string> = {
  exact: '直接匹配',
  moved: '迁移',
  missing: '冲突',
  duplicate: '冲突',
  order: '冲突',
}

/** 锚点方案导入预览：逐条展示匹配结果，确认后仅应用有效项。 */
export default function PlanPreview({ matches, fileName, onApply, onCancel }: Props) {
  const valid = matches.filter(isApplicable).length
  const moved = matches.filter((m) => m.kind === 'moved').length
  const conflicts = matches.length - valid

  return (
    <div className="modal-mask" onClick={onCancel}>
      <div className="modal" role="dialog" aria-label="锚点方案预览" onClick={(e) => e.stopPropagation()}>
        <h2>导入锚点方案 · 预览</h2>
        <p className="modal-summary">
          文件：{fileName} ｜ 共 {matches.length} 个锚点：
          <span className="ok-text"> {valid} 个可应用</span>
          {moved > 0 ? `（其中 ${moved} 个为迁移）` : ''}
          {conflicts > 0 ? <span className="error-text">，{conflicts} 个冲突将被跳过</span> : ''}
          。应用将以有效项替换当前锚点（作为一次操作进入撤销历史），不会修改任何字幕文本。
        </p>
        <div className="plan-list-wrap">
          <table className="plan-table">
            <thead>
              <tr>
                <th className="col-no">#</th>
                <th>方案原始时间</th>
                <th>目标时间</th>
                <th>匹配结果</th>
                <th>规范化文本</th>
              </tr>
            </thead>
            <tbody>
              {matches.map((m, i) => {
                const applicable = isApplicable(m)
                const cls = applicable ? (m.kind === 'moved' ? 'plan-moved' : '') : 'plan-conflict'
                return (
                  <tr key={i} className={cls}>
                    <td className="col-no">{i + 1}</td>
                    <td className="mono">{formatTime(m.anchor.source)}</td>
                    <td className="mono">{formatTime(m.anchor.target)}</td>
                    <td>
                      <span className={'plan-kind plan-kind-' + (applicable ? m.kind : 'conflict')}>
                        {KIND_LABEL[m.kind]}
                      </span>{' '}
                      {describe(m)}
                    </td>
                    <td className="plan-text">{m.anchor.text || '（空文本）'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={onCancel}>
            取消
          </button>
          <button className="btn btn-primary" disabled={valid === 0} onClick={onApply}>
            应用 {valid} 个有效锚点
          </button>
        </div>
      </div>
    </div>
  )
}

function describe(m: PlanMatch): string {
  if (m.kind === 'exact') return `→ 第 ${m.cueId} 条字幕`
  if (m.kind === 'moved' && m.source !== null) {
    return `→ 第 ${m.cueId} 条字幕（新原始时间 ${formatTime(m.source)}）`
  }
  return m.reason ?? ''
}
