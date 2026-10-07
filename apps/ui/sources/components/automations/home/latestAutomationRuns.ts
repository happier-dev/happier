import type { AutomationRunStateV3 } from '@happier-dev/protocol';

import type { AutomationDefinition, AutomationDefinitionRun } from '@/sync/domains/automations/automationTypes';
import { getAutomationDefinitionRunCauseAt } from '@/sync/domains/automations/automationRunCause';
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
export function automationRunTone(state: AutomationRunStateV3): LatestAutomationRunTone {
    const status = resolveWorkStatusTone({ kind: 'workflow_run', facts: { state, word: state } });
    if (status.bucket === 'working') return 'active';
    if (status.tone === 'danger') return 'failed';
    if (status.tone === 'attention') return 'attention';
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
    automationName: string;
    targetType: AutomationDefinition['targetType'];
    /** The Run's occurrence (its cause), the same chronology an Automation's history orders by. */
    at: number;
    tone: LatestAutomationRunTone;
}>;

type LatestRunSource = Pick<AutomationDefinition, 'id' | 'lastRunAt'>;

/**
 * The Automations whose Run windows hold the Account's newest Runs.
 *
 * The server stamps `lastRunAt` when a Run of that Automation settles, so the `count` newest settled
 * Runs all belong to the `count` Automations that settled most recently: an Automation outside them
 * settled no later than each of them. A Run still in progress does not move `lastRunAt`; it shows here
 * only when its Automation is among those (the Account has no cross-Automation Run query today).
 */
export function selectLatestRunAutomationIds(automations: readonly LatestRunSource[], count: number): string[] {
    return automations
        .filter((automation): automation is LatestRunSource & { lastRunAt: number } => automation.lastRunAt !== null)
        .sort((left, right) => right.lastRunAt - left.lastRunAt || left.id.localeCompare(right.id))
        .slice(0, Math.max(0, count))
        .map((automation) => automation.id);
}

/** The newest `count` Runs across the given Automations' Run windows, newest occurrence first. */
export function projectLatestAutomationRuns(input: Readonly<{
    automations: readonly AutomationDefinition[];
    runs: readonly AutomationDefinitionRun[];
    count: number;
}>): LatestAutomationRunRow[] {
    const byId = new Map(input.automations.map((automation) => [automation.id, automation]));
    const rows: LatestAutomationRunRow[] = [];
    for (const run of input.runs) {
        const automation = byId.get(run.automationId);
        if (!automation) continue;
        rows.push({
            run,
            automationName: automation.name,
            targetType: automation.targetType,
            at: getAutomationDefinitionRunCauseAt(run),
            tone: automationRunTone(run.state),
        });
    }
    return rows
        .sort((left, right) => right.at - left.at || right.run.updatedAt - left.run.updatedAt)
        .slice(0, Math.max(0, input.count));
}
