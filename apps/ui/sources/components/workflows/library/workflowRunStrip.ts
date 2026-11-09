import type { WorkflowRunSourceSummariesResultV1 } from '@happier-dev/protocol/workflows/actionsV1';

import { inboxItemViewV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { resolveWorkStatusTone } from '@/components/work/status/resolveWorkStatusTone';
import { readWorkflowRunWorkStatusFacts } from '@/components/work/status/workflowWorkStatusFacts';
import { describeWorkflowRunState } from '@/components/workflows/presentation/workflowLifecyclePresentation';
import { t } from '@/text';

/**
 * How many recent runs a library row's strip shows: the lab `nav-N1` reference's strip, passed to
 * `workflow.run.summaries` as `recent`. A presentation value (07 S2), not a server bound.
 */
export const WORKFLOW_RUN_STRIP_LENGTH = 8;

export type WorkflowRunStripCellKind = 'none' | 'ok' | 'failed' | 'needsYou';

export type WorkflowRunStrip = Readonly<{
    /** Oldest to newest, always {@link WORKFLOW_RUN_STRIP_LENGTH} cells so the row never reflows. */
    cells: readonly Readonly<{ kind: WorkflowRunStripCellKind; runId: string | null }>[];
    accessibilityLabel: string;
}>;

type SummaryInput = Pick<WorkflowRunSourceSummariesResultV1['summaries'][number], 'recent' | 'needsYouCount' | 'needsYouRunId'>;

/** Running membership reads lifecycle; a concurrent actionable hold retains its separate Needs-you view. */
export function hasWorkingWorkflowLibraryRun(summary: Pick<SummaryInput, 'recent'> | undefined): boolean {
    return summary?.recent.some((run) => resolveWorkStatusTone({
        kind: 'workflow_run', facts: { state: run.state, workflowCustodyState: run.workflowCustodyState, word: '' },
    }).bucket === 'working') ?? false;
}

/**
 * One saved workflow's run strip from its summary. Healthy runs, and a stop you chose, stay neutral;
 * only a failed run and the run that needs you take tone (07 §2.3 item 27), each from the shared
 * status owner, never from a local reading of the state.
 */
export function projectWorkflowRunStrip(summary: SummaryInput): WorkflowRunStrip {
    const recent = summary.recent.slice(0, WORKFLOW_RUN_STRIP_LENGTH);
    let completed = 0;
    let failed = 0;
    const runCells = recent.map((run) => {
        if (run.state === 'succeeded') completed += 1;
        // Acknowledgement clears emphasis; the accessible history still names the failed outcome.
        if (describeWorkflowRunState(run.state).variant === 'danger') failed += 1;
        const status = resolveWorkStatusTone({ kind: 'workflow_run', facts: readWorkflowRunWorkStatusFacts(run) });
        if (status.tone === 'danger') {
            return { kind: 'failed' as const, runId: run.runId };
        }
        if (status.bucket === 'needs_you' && status.attentionType !== null && inboxItemViewV1(status.attentionType) === 'needs_you') {
            return { kind: 'needsYou' as const, runId: run.runId };
        }
        return { kind: 'ok' as const, runId: run.runId };
    }).reverse();
    const padding = Array.from({ length: WORKFLOW_RUN_STRIP_LENGTH - runCells.length }, () => ({ kind: 'none' as const, runId: null }));
    const parts = [
        completed > 0 ? t('workflows.destination.strip.completed', { count: completed }) : null,
        failed > 0 ? t('workflows.destination.strip.failed', { count: failed }) : null,
        summary.needsYouCount > 0 ? t('workflows.destination.strip.needsYou', { count: summary.needsYouCount }) : null,
    ].filter((part): part is string => part !== null);
    return {
        cells: [...padding, ...runCells],
        accessibilityLabel: parts.length === 0
            ? t('workflows.destination.strip.labelPlain', { count: recent.length })
            : t('workflows.destination.strip.label', { count: recent.length, parts: parts.join(t('workflows.destination.strip.separator')) }),
    };
}
