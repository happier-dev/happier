import type { WorkflowRunStateV1 } from '@happier-dev/protocol/workflows/workflowRunStateV1';

import type { AutomationDefinition, AutomationDefinitionRun } from '@/sync/domains/automations/automationTypes';
import { resolveWorkStatusTone, type WorkStatusTone } from '@/components/work/status/resolveWorkStatusTone';

/**
 * How a Run reads at a glance, which picks its glyph: done well, under way, went wrong, one the person
 * should look at (its outcome is uncertain, or it expired or was missed), or nothing to act on.
 */
export type LatestAutomationRunTone = 'succeeded' | 'active' | 'failed' | 'attention' | 'neutral';

/**
 * The glance follows the shared work status vocabulary (`resolveWorkStatusTone`, which owns how a Run
 * state reads); only the glyph split — a success apart from the other quiet ends — is this list's own.
 */
export function automationRunTone(state: WorkflowRunStateV1): LatestAutomationRunTone {
    const status = resolveWorkStatusTone({ kind: 'workflow_run', facts: { state, word: state } });
    if (status.tone === 'danger') return 'failed';
    if (status.tone === 'attention') return 'attention';
    if (status.bucket === 'working') return 'active';
    return state === 'succeeded' ? 'succeeded' : 'neutral';
}

/** The status tone a glance is drawn in: only failure and what the person should look at carry colour. */
export function automationRunStatusTone(tone: LatestAutomationRunTone): WorkStatusTone {
    if (tone === 'failed') return 'danger';
    if (tone === 'attention') return 'attention';
    return 'neutral';
}

export type LatestAutomationRunRow = Readonly<{
    run: AutomationDefinitionRun;
    automationName: string | null;
    targetType: AutomationDefinition['targetType'] | null;
    /** Creation time, which also orders the server's Run page. */
    at: number;
    tone: LatestAutomationRunTone;
}>;

export function projectLatestAutomationRuns(input: Readonly<{
    automations: readonly AutomationDefinition[];
    runs: readonly AutomationDefinitionRun[];
    count: number;
}>): LatestAutomationRunRow[] {
    const byId = new Map(input.automations.map((automation) => [automation.id, automation]));
    const rows: LatestAutomationRunRow[] = [];
    for (const run of input.runs) {
        const automation = byId.get(run.automationId);
        rows.push({
            run,
            automationName: automation?.name ?? null,
            targetType: automation?.targetType ?? null,
            at: run.createdAt,
            tone: automationRunTone(run.workflowRunState ?? run.state),
        });
    }
    return rows.slice(0, Math.max(0, input.count));
}
