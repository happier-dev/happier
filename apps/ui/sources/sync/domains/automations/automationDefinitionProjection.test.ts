import { describe, expect, it } from 'vitest';
import { AutomationV3DefinitionDetailSchema } from '@happier-dev/protocol';

import {
    applyAutomationDefinitionDetail,
    attachAutomationDefinitionDetail,
    createAutomationDefinitionFromDetail,
    createAutomationDefinitionSummary,
    markAutomationDefinitionContentUnavailable,
} from './automationDefinitionProjection';

const eventSummary = {
    id: 'automation-event-1',
    name: 'Repository updates',
    description: null,
    enabled: true,
    trigger: {
        kind: 'pluginEvent' as const,
        eventRef: {
            pluginId: 'happier.scm.github',
            localId: 'repository-event-v1',
        },
        sourceSelectorId: 'selector-1',
        sourceContractVersion: 1,
        observation: {
            kind: 'checkpointedPull' as const,
            watcher: {
                machineId: 'machine-1',
                machineInstallationId: 'installation-1',
                pluginId: 'happier.scm.github',
                materializationId: 'materialization-1',
            },
        },
    },
    targetType: 'existingSession' as const,
    templateVersion: 3,
    nextRunAt: null,
    lastRunAt: null,
    createdAt: 1_786_257_600_000,
    updatedAt: 1_786_257_600_000,
    assignments: [{ machineId: 'machine-1', enabled: true, priority: 0, updatedAt: 1_786_257_600_000 }],
};

const executionRecipe = {
    v: 1 as const,
    templateVersion: 3,
    template: {
        t: 'plain' as const,
        v: { v: 1, prompt: 'Review {{input}}' },
    },
    triggerEvidence: null,
    target: {
        kind: 'existingSession' as const,
        sessionId: 'session-1',
    },
};

describe('Automation V3 definition projection', () => {
    it('keeps a manual definition correlated without inventing schedule or event state', () => {
        const detail = AutomationV3DefinitionDetailSchema.parse({
            ...eventSummary,
            name: 'On demand',
            trigger: { kind: 'manual' },
            executionRecipe,
            triggerDefinitionEnvelope: null,
        });

        expect(createAutomationDefinitionFromDetail(detail)).toMatchObject({
            trigger: { kind: 'manual' },
            nextRunAt: null,
            detail: { kind: 'available' },
        });
    });

    it('keeps private Event source content out of a summary and attaches it only from matching direct detail', () => {
        const summary = createAutomationDefinitionSummary(eventSummary);

        expect(summary).toMatchObject({
            id: 'automation-event-1',
            trigger: expect.objectContaining({
                kind: 'pluginEvent',
                eventRef: eventSummary.trigger.eventRef,
                sourceSelectorId: 'selector-1',
            }),
            detail: { kind: 'unloaded', templateVersion: 3 },
        });
        expect(summary).not.toHaveProperty('triggerDefinitionEnvelope');
        expect(summary).not.toHaveProperty('sourceConfig');
        expect(summary).not.toHaveProperty('displayLabel');

        const attached = attachAutomationDefinitionDetail(summary, {
            ...eventSummary,
            executionRecipe,
            triggerDefinitionEnvelope: JSON.stringify({
                t: 'plain',
                v: {
                    sourceInstanceId: 'github:repository:1234',
                    sourceConfig: { repository: 'happier-dev/happier' },
                    displayLabel: 'happier-dev/happier',
                    filter: null,
                    maximumObservationAgeMs: 60_000,
                },
            }),
        });

        expect(attached).toMatchObject({
            linkedExistingSessionId: 'session-1',
            detail: {
                kind: 'available',
                templateVersion: 3,
                value: expect.objectContaining({
                    triggerDefinitionEnvelope: expect.any(String),
                }),
            },
        });
        expect(attached).not.toHaveProperty('sourceConfig');
        expect(attached).not.toHaveProperty('displayLabel');
    });

    it('rejects a direct detail response for a different Automation revision', () => {
        const summary = createAutomationDefinitionSummary(eventSummary);
        const staleDetail = {
            ...eventSummary,
            templateVersion: 4,
            executionRecipe: { ...executionRecipe, templateVersion: 4 },
            triggerDefinitionEnvelope: '{"t":"plain","v":{}}',
        };

        expect(attachAutomationDefinitionDetail(summary, staleDetail)).toBeNull();
    });

    it('rejects a schema-valid direct recipe whose template revision does not match its definition', () => {
        const summary = createAutomationDefinitionSummary(eventSummary);
        const mismatchedDetail = AutomationV3DefinitionDetailSchema.parse({
            ...eventSummary,
            executionRecipe: {
                ...executionRecipe,
                templateVersion: eventSummary.templateVersion - 1,
            },
            triggerDefinitionEnvelope: '{"t":"plain","v":{}}',
        });

        expect(mismatchedDetail.executionRecipe?.templateVersion).toBe(2);
        expect(attachAutomationDefinitionDetail(summary, mismatchedDetail)).toBeNull();
    });

    it('does not derive an existing-session link from a schema-valid mismatched recipe revision', () => {
        const mismatchedDetail = AutomationV3DefinitionDetailSchema.parse({
            ...eventSummary,
            executionRecipe: {
                ...executionRecipe,
                templateVersion: eventSummary.templateVersion - 1,
            },
            triggerDefinitionEnvelope: '{"t":"plain","v":{}}',
        });

        expect(createAutomationDefinitionFromDetail(mismatchedDetail).linkedExistingSessionId).toBeNull();
    });

    it('rejects equal-revision Event detail from a different source selector instead of creating a hybrid projection', () => {
        const summary = createAutomationDefinitionSummary(eventSummary);
        const mismatchedDetail = {
            ...eventSummary,
            trigger: {
                ...eventSummary.trigger,
                sourceSelectorId: 'selector-2',
            },
            executionRecipe,
            triggerDefinitionEnvelope: '{"t":"plain","v":{}}',
        };

        expect(attachAutomationDefinitionDetail(summary, mismatchedDetail)).toBeNull();
    });

    it('rejects equal-revision checkpointed-pull detail from a different watcher materialization', () => {
        const summary = createAutomationDefinitionSummary(eventSummary);
        const mismatchedDetail = {
            ...eventSummary,
            trigger: {
                ...eventSummary.trigger,
                observation: {
                    ...eventSummary.trigger.observation,
                    watcher: {
                        ...eventSummary.trigger.observation.watcher,
                        materializationId: 'materialization-2',
                    },
                },
            },
            executionRecipe,
            triggerDefinitionEnvelope: '{"t":"plain","v":{}}',
        };

        expect(attachAutomationDefinitionDetail(summary, mismatchedDetail)).toBeNull();
    });

    it('rejects equal-revision schedule detail with a different schedule shape', () => {
        const scheduleSummary = {
            ...eventSummary,
            trigger: {
                kind: 'schedule' as const,
                schedule: {
                    kind: 'interval' as const,
                    scheduleExpr: null,
                    everyMs: 60_000,
                    timezone: null,
                },
            },
        };
        const summary = createAutomationDefinitionSummary(scheduleSummary);
        const mismatchedDetail = {
            ...scheduleSummary,
            trigger: {
                ...scheduleSummary.trigger,
                schedule: {
                    ...scheduleSummary.trigger.schedule,
                    everyMs: 120_000,
                },
            },
            executionRecipe,
            triggerDefinitionEnvelope: null,
        };

        expect(attachAutomationDefinitionDetail(summary, mismatchedDetail)).toBeNull();
    });

    it('rejects equal-revision durable-push detail with a different webhook endpoint', () => {
        const durablePushSummary = {
            ...eventSummary,
            trigger: {
                ...eventSummary.trigger,
                observation: {
                    kind: 'durablePush' as const,
                    webhookEndpointId: 'endpoint-1',
                    observationStartsAt: 1_786_257_600_000,
                },
            },
        };
        const summary = createAutomationDefinitionSummary(durablePushSummary);
        const mismatchedDetail = {
            ...durablePushSummary,
            trigger: {
                ...durablePushSummary.trigger,
                observation: {
                    ...durablePushSummary.trigger.observation,
                    webhookEndpointId: 'endpoint-2',
                },
            },
            executionRecipe,
            triggerDefinitionEnvelope: '{"t":"plain","v":{}}',
        };

        expect(attachAutomationDefinitionDetail(summary, mismatchedDetail)).toBeNull();
    });

    it('rejects equal-revision direct detail for a different target instead of exposing its existing-session link', () => {
        const summary = createAutomationDefinitionSummary({
            ...eventSummary,
            targetType: 'newSession',
        });
        const existingSessionDetail = {
            ...eventSummary,
            executionRecipe,
            triggerDefinitionEnvelope: '{"t":"plain","v":{}}',
        };

        expect(attachAutomationDefinitionDetail(summary, existingSessionDetail)).toBeNull();
    });

    it('projects a lifecycle direct result into the same record and clears private LKG on typed content unavailability', () => {
        const detail = {
            ...eventSummary,
            executionRecipe,
            triggerDefinitionEnvelope: '{"t":"plain","v":{}}',
        };
        const fromMutation = createAutomationDefinitionFromDetail(detail);

        expect(fromMutation).toMatchObject({
            id: 'automation-event-1',
            detail: {
                kind: 'available',
                templateVersion: 3,
                value: expect.objectContaining({ triggerDefinitionEnvelope: expect.any(String) }),
            },
            linkedExistingSessionId: 'session-1',
        });
        expect(fromMutation).not.toHaveProperty('triggerDefinitionEnvelope');

        expect(markAutomationDefinitionContentUnavailable(fromMutation)).toMatchObject({
            id: 'automation-event-1',
            detail: {
                kind: 'unavailable',
                templateVersion: 3,
                code: 'automation_stored_content_unavailable',
            },
            linkedExistingSessionId: null,
        });
    });

    it('does not let a stale direct response regress a newer summary revision', () => {
        const current = createAutomationDefinitionSummary({
            ...eventSummary,
            templateVersion: 4,
        });
        const staleDetail = {
            ...eventSummary,
            executionRecipe,
            triggerDefinitionEnvelope: '{"t":"plain","v":{}}',
        };

        expect(applyAutomationDefinitionDetail(current, staleDetail)).toBe(current);
        expect(applyAutomationDefinitionDetail(null, staleDetail)).toMatchObject({
            templateVersion: 3,
            detail: { kind: 'available', templateVersion: 3 },
        });
    });

    it('keeps a typed unavailable result fail-closed when an equal-revision direct response arrives late', () => {
        const unavailable = markAutomationDefinitionContentUnavailable(
            createAutomationDefinitionSummary(eventSummary),
        );
        const lateDetail = {
            ...eventSummary,
            executionRecipe,
            triggerDefinitionEnvelope: '{"t":"plain","v":{}}',
        };

        expect(applyAutomationDefinitionDetail(unavailable, lateDetail)).toBe(unavailable);
    });

    it('does not let an equal-revision direct response overwrite a current definition', () => {
        const current = createAutomationDefinitionFromDetail({
            ...eventSummary,
            enabled: false,
            updatedAt: eventSummary.updatedAt + 1,
            assignments: [{
                machineId: 'machine-2',
                enabled: true,
                priority: 100,
                updatedAt: eventSummary.updatedAt + 1,
            }],
            executionRecipe,
            triggerDefinitionEnvelope: '{"t":"plain","v":{"sourceInstanceId":"github:repository:1234"}}',
        });
        const lateDetail = {
            ...eventSummary,
            executionRecipe,
            triggerDefinitionEnvelope: '{"t":"plain","v":{"sourceInstanceId":"github:repository:1234"}}',
        };

        expect(applyAutomationDefinitionDetail(current, lateDetail)).toBe(current);
    });

    it('attaches equal-revision private detail without regressing a newer unloaded summary', () => {
        const current = createAutomationDefinitionSummary({
            ...eventSummary,
            enabled: false,
            updatedAt: eventSummary.updatedAt + 1,
            assignments: [{
                machineId: 'machine-2',
                enabled: true,
                priority: 100,
                updatedAt: eventSummary.updatedAt + 1,
            }],
        });
        const lateDetail = {
            ...eventSummary,
            executionRecipe,
            triggerDefinitionEnvelope: '{"t":"plain","v":{"sourceInstanceId":"github:repository:1234"}}',
        };

        expect(applyAutomationDefinitionDetail(current, lateDetail)).toMatchObject({
            enabled: false,
            updatedAt: eventSummary.updatedAt + 1,
            assignments: [{ machineId: 'machine-2' }],
            detail: {
                kind: 'available',
                value: {
                    enabled: false,
                    updatedAt: eventSummary.updatedAt + 1,
                    assignments: [{ machineId: 'machine-2' }],
                },
            },
        });
    });

    it('accepts an authoritative equal-revision lifecycle mutation response', () => {
        const current = createAutomationDefinitionFromDetail({
            ...eventSummary,
            executionRecipe,
            triggerDefinitionEnvelope: '{"t":"plain","v":{}}',
        });
        const paused = {
            ...eventSummary,
            enabled: false,
            updatedAt: eventSummary.updatedAt + 1,
            executionRecipe,
            triggerDefinitionEnvelope: '{"t":"plain","v":{}}',
        };

        expect(applyAutomationDefinitionDetail(current, paused, { replaceEqualRevision: true })).toMatchObject({
            enabled: false,
            updatedAt: eventSummary.updatedAt + 1,
            detail: {
                kind: 'available',
                value: { enabled: false },
            },
        });
    });

    it('keeps the current definition when an equal-revision detail has a mismatched trigger kind', () => {
        const current = createAutomationDefinitionSummary({
            ...eventSummary,
            trigger: {
                kind: 'schedule' as const,
                schedule: {
                    kind: 'interval' as const,
                    scheduleExpr: null,
                    everyMs: 60_000,
                    timezone: null,
                },
            },
        });
        const mismatchedDetail = {
            ...eventSummary,
            executionRecipe,
            triggerDefinitionEnvelope: '{"t":"plain","v":{}}',
        };

        expect(applyAutomationDefinitionDetail(current, mismatchedDetail)).toBe(current);
    });
});
