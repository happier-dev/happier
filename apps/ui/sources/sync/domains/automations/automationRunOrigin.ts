import type { AutomationDefinitionRun } from './automationTypes';

/** The immutable origin is the only stable chronology for mixed Trigger Runs. */
export function getAutomationDefinitionRunOriginAt(run: AutomationDefinitionRun): number {
    switch (run.origin.kind) {
        case 'scheduled':
            return run.origin.scheduledFor;
        case 'manual':
            return run.origin.invokedAt;
        case 'pluginEvent':
        case 'conversation':
            return run.origin.occurredAt;
    }
}
