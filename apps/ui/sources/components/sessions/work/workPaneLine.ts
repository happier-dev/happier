import type { PaneHeaderLineSegment } from '@/components/appShell/panes/paneHeaderSlot';
import { t } from '@/text';

import type { WorkSummary } from './workProjection';

/**
 * The Work pane header's live line (lab `convo-W1`: "1 needs you · 6 working"): what waits on the
 * person first, in the attention ink, then what is still working. Once everything has settled it
 * counts what this Session leads ("4 sessions · 3 runs"). Stalled work is said by its own row, not here.
 */
export function describeWorkPaneLine(summary: WorkSummary): PaneHeaderLineSegment[] {
    const working = Math.max(0, summary.outstanding - summary.needsYou - summary.stalled);
    const live: PaneHeaderLineSegment[] = [];
    if (summary.needsYou > 0) live.push({ text: t('sessionWork.strip.needsYou', { count: summary.needsYou }), attention: true });
    if (working > 0) live.push(t('sessionWork.list.reportsWorking', { count: working }));
    if (live.length > 0) return live;
    const counts: PaneHeaderLineSegment[] = [];
    if (summary.sessions > 0) counts.push(t('sessionWork.subtitle.sessions', { count: summary.sessions }));
    if (summary.runs > 0) counts.push(t('sessionWork.subtitle.runs', { count: summary.runs }));
    return counts;
}
