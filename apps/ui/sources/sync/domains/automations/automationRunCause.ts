import type { AutomationDefinitionRun } from './automationTypes';

/** Immutable Run cause supplies chronology across every admission kind. */
export function getAutomationDefinitionRunCauseAt(run: AutomationDefinitionRun): number {
    return run.cause.kind === 'manual' ? run.cause.invokedAt : run.cause.occurredAt;
}
