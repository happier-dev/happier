import { describe, expect, it } from 'vitest';
import { AutomationRunLifecycleTriggerSchema } from '@happier-dev/protocol/automations/automationRunLifecycle';
import { decodeAutomationRunLifecycleConfiguration } from './automationRunLifecycleConfigurationCodec';

const configuration = {
    kind: 'runLifecycle',
    source: { kind: 'workflow_run', runId: 'run-1' },
    condition: 'terminal',
};

describe('stored Run lifecycle configuration', () => {
    it('keeps a mixed-revision list readable while dropping additive stored fields', () => {
        const executionConfiguration = {
            ...configuration,
            source: { kind: 'execution_run', machineId: 'machine-1', runId: 'run-1' },
        };
        const rows = [configuration, {
            ...configuration, displayHint: 'newer writer',
            source: { ...configuration.source, displayHint: 'newer source' },
        }, {
            ...executionConfiguration, displayHint: 'newer writer',
            source: { ...executionConfiguration.source, displayHint: 'newer source' },
        }];
        expect(rows.map(value => decodeAutomationRunLifecycleConfiguration({
            runLifecycleConfigurationJson: JSON.stringify(value),
        }))).toEqual([configuration, configuration, executionConfiguration]);
        // Stored tolerance must never relax publication admission.
        expect(AutomationRunLifecycleTriggerSchema.safeParse(rows[1]).success).toBe(false);
    });

    it('still refuses unknown routing arms and invalid known source identity', () => {
        for (const source of [{ kind: 'future_run', runId: 'run-1' }, { kind: 'workflow_run', runId: '' }]) {
            expect(() => decodeAutomationRunLifecycleConfiguration({
                runLifecycleConfigurationJson: JSON.stringify({ ...configuration, source }),
            })).toThrow();
        }
    });
});
