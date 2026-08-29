import { describe, expect, it } from 'vitest';
import {
    AutomationDefinitionDetailSchema,
    AutomationSourceSelectorIdV1Schema,
    AutomationTriggerIdSchema,
    type AutomationDefinitionDetail,
} from '@happier-dev/protocol';

import {
    automationEditorDraftFromDetail,
    createAutomationEditorLifetimeIdentity,
    isAutomationEditorLifetimeIdentityCurrent,
    replaceAutomationEditorExecutionRecipe,
    shouldValidateAutomationEditorLifecycleTrigger,
    type AutomationEditorTriggerDefinitionSeed,
} from './automationEditorDraft';

const timestamp = 1_786_257_600_000;
const recipe = {
    v: 1 as const,
    templateVersion: 8,
    template: { t: 'plain' as const, v: { v: 1 as const, prompt: 'Review the current work.' } },
    triggerEvidence: null,
    target: { kind: 'existingSession' as const, sessionId: 'target-session' },
};

function detail(): AutomationDefinitionDetail {
    return AutomationDefinitionDetailSchema.parse({
        id: 'automation-hydrated',
        name: 'Hydrated plural automation',
        description: null,
        enabled: true,
        targetType: 'existingSession',
        existingSessionId: 'target-session',
        templateVersion: 8,
        lastRunAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        assignments: [{ machineId: 'machine-1', enabled: true, priority: 0, updatedAt: timestamp }],
        executionRecipe: recipe,
        triggers: [
            {
                id: 'schedule-persisted',
                revision: 3,
                enabled: false,
                createdAt: timestamp,
                updatedAt: timestamp,
                kind: 'schedule',
                schedule: { kind: 'interval', scheduleExpr: null, everyMs: 60_000, timezone: null },
                nextRunAt: timestamp + 60_000,
                triggerDefinitionEnvelope: null,
            },
            {
                id: 'event-persisted',
                revision: 9,
                enabled: true,
                createdAt: timestamp,
                updatedAt: timestamp,
                kind: 'pluginEvent',
                eventRef: { pluginId: 'example.github', localId: 'pull-request-opened-v1' },
                sourceSelectorId: 'repository-42',
                sourceContractVersion: 1,
                observation: {
                    kind: 'durablePush',
                    webhookEndpointId: 'webhook-1',
                    endpointMaterializationRef: null,
                    observationStartsAt: timestamp,
                },
                sourceStatus: null,
                sourceCatalogStatus: null,
                triggerDefinitionEnvelope: 'sealed-private-definition',
            },
        ],
    });
}

describe('automationEditorDraftFromDetail', () => {
    it('binds a mounted draft to its exact Account, server, and definition identity', () => {
        const mounted = createAutomationEditorLifetimeIdentity(
            { serverId: 'server-a', accountId: 'account-a' },
            'automation-a',
        );
        expect(isAutomationEditorLifetimeIdentityCurrent(
            mounted,
            { serverId: 'server-a', accountId: 'account-a' },
            'automation-a',
        )).toBe(true);
        expect(isAutomationEditorLifetimeIdentityCurrent(
            mounted,
            { serverId: 'server-a', accountId: 'account-b' },
            'automation-a',
        )).toBe(false);
        expect(isAutomationEditorLifetimeIdentityCurrent(
            mounted,
            { serverId: 'server-b', accountId: 'account-a' },
            'automation-a',
        )).toBe(false);
        expect(isAutomationEditorLifetimeIdentityCurrent(
            mounted,
            { serverId: 'server-a', accountId: 'account-a' },
            'automation-b',
        )).toBe(false);
        expect(isAutomationEditorLifetimeIdentityCurrent(null, null, 'automation-a')).toBe(false);
    });

    it('hydrates heterogeneous rows with stable persisted identity and keeps retained Event continuity', () => {
        const hydrated = automationEditorDraftFromDetail(detail(), new Map<string, AutomationEditorTriggerDefinitionSeed>([
            ['schedule-persisted', {
                definition: {
                    kind: 'schedule' as const,
                    enabled: false,
                    schedule: { kind: 'interval' as const, scheduleExpr: null, everyMs: 60_000, timezone: null },
                },
            }],
            ['event-persisted', {
                definition: null,
                retainedEvent: {
                    kind: 'pluginEvent' as const,
                    enabled: true,
                    displayLabel: 'Pull request opened',
                    eventRef: { pluginId: 'example.github', localId: 'pull-request-opened-v1' },
                },
                eventSourceBinding: {
                    sourceSelectorId: AutomationSourceSelectorIdV1Schema.parse('11111111-1111-4111-8111-111111111111'),
                    sourceInstanceId: 'repository-42',
                },
            }],
        ]));

        expect(hydrated).not.toBeNull();
        expect(hydrated?.triggers).toEqual([
            expect.objectContaining({
                clientId: 'schedule-persisted',
                persisted: { id: 'schedule-persisted', revision: 3 },
                definition: expect.objectContaining({ kind: 'schedule', enabled: false }),
            }),
            {
                clientId: 'event-persisted',
                persisted: { id: 'event-persisted', revision: 9 },
                definition: null,
                retainedEvent: {
                    kind: 'pluginEvent',
                    enabled: true,
                    displayLabel: 'Pull request opened',
                    eventRef: { pluginId: 'example.github', localId: 'pull-request-opened-v1' },
                },
                eventSourceBinding: {
                    sourceSelectorId: '11111111-1111-4111-8111-111111111111',
                    sourceInstanceId: 'repository-42',
                },
            },
        ]);
        expect(hydrated).toMatchObject({
            automationId: 'automation-hydrated',
            pendingAutomationId: null,
            expectedTemplateVersion: 8,
            removedTriggers: [],
            executionRecipe: { templateVersion: 8 },
        });
    });

    it('fails closed instead of dropping a loaded trigger whose private authoring seed is unavailable', () => {
        const hydrated = automationEditorDraftFromDetail(detail(), new Map<string, AutomationEditorTriggerDefinitionSeed>([
            ['schedule-persisted', {
                definition: {
                    kind: 'schedule' as const,
                    enabled: false,
                    schedule: { kind: 'interval' as const, scheduleExpr: null, everyMs: 60_000, timezone: null },
                },
            }],
        ]));

        expect(hydrated).toBeNull();
    });

    it('owns the exact next-version transition for semantic recipe edits', () => {
        const triggerSeeds = new Map<string, AutomationEditorTriggerDefinitionSeed>([
            ['schedule-persisted', {
                definition: {
                    kind: 'schedule',
                    enabled: false,
                    schedule: { kind: 'interval', scheduleExpr: null, everyMs: 60_000, timezone: null },
                },
            }],
            ['event-persisted', {
                definition: null,
                retainedEvent: {
                    kind: 'pluginEvent',
                    enabled: true,
                    displayLabel: 'Pull request opened',
                    eventRef: { pluginId: 'example.github', localId: 'pull-request-opened-v1' },
                },
                eventSourceBinding: {
                    sourceSelectorId: AutomationSourceSelectorIdV1Schema.parse('11111111-1111-4111-8111-111111111111'),
                    sourceInstanceId: 'repository-42',
                },
            }],
        ]);
        const current = automationEditorDraftFromDetail(detail(), triggerSeeds)!;
        const next = replaceAutomationEditorExecutionRecipe(current, {
            ...current.executionRecipe,
            templateVersion: 9,
        });

        expect(next.recipeDirty).toBe(true);
        expect(next.executionRecipe.templateVersion).toBe(9);
        expect(() => replaceAutomationEditorExecutionRecipe(current, current.executionRecipe)).toThrow();
    });

    it('revalidates exact-turn currentness only for new or changed rows', () => {
        const lifecycle = {
            clientId: 'turn-trigger',
            persisted: { id: AutomationTriggerIdSchema.parse('turn-trigger'), revision: 4 },
            definition: {
                kind: 'sessionLifecycle' as const,
                enabled: true,
                event: 'parentTurnCompleted' as const,
                scope: { kind: 'exactTurn' as const, sourceSessionId: 'source', sourceTurnId: 'turn' },
                consumption: 'once' as const,
            },
        };

        expect(shouldValidateAutomationEditorLifecycleTrigger(lifecycle)).toBe(false);
        expect(shouldValidateAutomationEditorLifecycleTrigger({ ...lifecycle, isDirty: true })).toBe(true);
        expect(shouldValidateAutomationEditorLifecycleTrigger({ ...lifecycle, persisted: null })).toBe(true);
    });
});
