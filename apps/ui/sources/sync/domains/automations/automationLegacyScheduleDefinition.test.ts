import type { AutomationDefinitionDetail } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { createAutomationDefinitionFromDetail } from './automationDefinitionProjection';
import { readLegacyScheduleAutomationDefinition } from './automationLegacyScheduleDefinition';

const scheduleDefinition = {
    id: 'legacy-schedule-definition',
    name: 'Hourly review',
    description: 'Retained predecessor schedule',
    enabled: true,
    trigger: {
        kind: 'schedule' as const,
        schedule: {
            kind: 'interval' as const,
            scheduleExpr: null,
            everyMs: 60_000,
            timezone: null,
        },
    },
    targetType: 'existingSession' as const,
    existingSessionId: null,
    templateVersion: 4,
    nextRunAt: 1_786_261_200_000,
    lastRunAt: 1_786_257_600_000,
    createdAt: 1_786_250_400_000,
    updatedAt: 1_786_257_600_000,
    assignments: [{ machineId: 'machine-1', enabled: true, priority: 10, updatedAt: null }],
    triggerDefinitionEnvelope: null,
};

describe('readLegacyScheduleAutomationDefinition', () => {
    it('adapts only a direct retained V2 schedule definition, never a current strict recipe', () => {
        const retained = createAutomationDefinitionFromDetail({
            ...scheduleDefinition,
            templateCiphertext: '{"kind":"happier_automation_template_plain_v1","payload":{"directory":"/repo"}}',
        } satisfies AutomationDefinitionDetail);
        const strict = createAutomationDefinitionFromDetail({
            ...scheduleDefinition,
            executionRecipe: {
                v: 1,
                templateVersion: 4,
                template: { t: 'plain', v: { directory: '/repo' } },
                triggerEvidence: null,
                target: { kind: 'existingSession', sessionId: 'session-1' },
            },
        } satisfies AutomationDefinitionDetail);

        expect(readLegacyScheduleAutomationDefinition(retained)).toEqual({
            id: 'legacy-schedule-definition',
            name: 'Hourly review',
            description: 'Retained predecessor schedule',
            enabled: true,
            schedule: {
                kind: 'interval',
                scheduleExpr: null,
                everyMs: 60_000,
                timezone: null,
            },
            targetType: 'existing_session',
            templateCiphertext: '{"kind":"happier_automation_template_plain_v1","payload":{"directory":"/repo"}}',
            linkedExistingSessionId: null,
            templateVersion: 4,
            nextRunAt: 1_786_261_200_000,
            lastRunAt: 1_786_257_600_000,
            createdAt: 1_786_250_400_000,
            updatedAt: 1_786_257_600_000,
            assignments: [{ machineId: 'machine-1', enabled: true, priority: 10, updatedAt: null }],
        });
        expect(readLegacyScheduleAutomationDefinition(strict)).toBeNull();
    });

    it('fails closed if a malformed stored record pairs a schedule summary with a non-schedule direct detail', () => {
        const retained = createAutomationDefinitionFromDetail({
            ...scheduleDefinition,
            templateCiphertext: '{"kind":"happier_automation_template_plain_v1","payload":{"directory":"/repo"}}',
        } satisfies AutomationDefinitionDetail);
        const malformed = { ...retained };
        if (malformed.detail.kind !== 'available') {
            throw new Error('Expected a direct retained detail');
        }

        Object.defineProperty(malformed.detail, 'value', {
            value: {
                ...malformed.detail.value,
                trigger: {
                    kind: 'pluginEvent',
                    eventRef: { pluginId: 'happier.scm.github', localId: 'repository-event-v1' },
                    sourceSelectorId: 'selector-1',
                    sourceContractVersion: 1,
                    observation: { kind: 'checkpointedPull', watcher: null },
                },
                triggerDefinitionEnvelope: '{"t":"plain","v":{}}',
            } satisfies AutomationDefinitionDetail,
        });

        expect(readLegacyScheduleAutomationDefinition(malformed)).toBeNull();
    });
});
