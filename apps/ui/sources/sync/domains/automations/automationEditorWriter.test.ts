import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    AutomationSourceSelectorIdV1Schema,
    AutomationTriggerDetailSchema,
    AutomationTriggerIdSchema,
    type AutomationDefinitionDetail,
} from '@happier-dev/protocol';

import {
    createAutomationDefinition,
    reconcileAutomationDefinition,
} from '@/sync/api/automations/apiAutomations';
import { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
import { automationEditorDraftFromDetail, type AutomationEditorDraft } from './automationEditorDraft';
import { AutomationEditorSaveStaleError, saveAutomationEditorDraft } from './automationEditorWriter';

vi.mock('@/sync/api/automations/apiAutomations', () => ({
    createAutomationDefinition: vi.fn(),
    reconcileAutomationDefinition: vi.fn(),
    isAutomationApiErrorCode: (error: unknown, code: string) => (
        typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
    ),
}));
vi.mock('@/sync/api/account/apiAccountEncryptionMode', () => ({
    fetchAccountEncryptionMode: vi.fn(),
}));

const credentials = { token: 'token-1', secret: 'secret-1' };
const timestamp = 1_786_257_600_000;
const triggerId = (value: string) => AutomationTriggerIdSchema.parse(value);
const sourceSelectorId = AutomationSourceSelectorIdV1Schema.parse('a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d');
const recipe = {
    v: 1 as const,
    templateVersion: 4,
    template: { t: 'plain' as const, v: { v: 1 as const, prompt: 'Review the current work.' } },
    triggerEvidence: null,
    target: { kind: 'existingSession' as const, sessionId: 'target-session' },
};
const scheduleDefinition = {
    kind: 'schedule' as const,
    enabled: true,
    schedule: { kind: 'interval' as const, scheduleExpr: null, everyMs: 60_000, timezone: null },
};
const lifecycleDefinition = {
    kind: 'sessionLifecycle' as const,
    enabled: true,
    event: 'parentTurnCompleted' as const,
    scope: { kind: 'exactTurn' as const, sourceSessionId: 'source-session', sourceTurnId: 'turn-7' },
    consumption: 'once' as const,
};

function scheduleTrigger(id: string, revision: number) {
    return AutomationTriggerDetailSchema.parse({
        id,
        revision,
        enabled: true,
        createdAt: timestamp,
        updatedAt: timestamp,
        kind: 'schedule' as const,
        schedule: scheduleDefinition.schedule,
        nextRunAt: timestamp + 60_000,
        triggerDefinitionEnvelope: null,
    });
}

function lifecycleTrigger(id: string, revision: number) {
    return AutomationTriggerDetailSchema.parse({
        id,
        revision,
        enabled: true,
        createdAt: timestamp,
        updatedAt: timestamp,
        kind: 'sessionLifecycle' as const,
        event: 'parentTurnCompleted' as const,
        scope: lifecycleDefinition.scope,
        consumption: 'once' as const,
        status: { state: 'waiting' as const, runId: null },
        triggerDefinitionEnvelope: null,
    });
}

function eventTrigger(id: string, revision: number) {
    return AutomationTriggerDetailSchema.parse({
        id,
        revision,
        enabled: true,
        createdAt: timestamp,
        updatedAt: timestamp,
        kind: 'pluginEvent' as const,
        eventRef: { pluginId: 'example.github', localId: 'push' },
        sourceSelectorId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
        sourceContractVersion: 1,
        observation: {
            kind: 'checkpointedPull' as const,
            watcher: {
                machineId: 'machine-1',
                machineInstallationId: 'github-installation',
                pluginId: 'example.github',
                materializationId: 'github-1',
            },
        },
        sourceStatus: null,
        sourceCatalogStatus: null,
        triggerDefinitionEnvelope: 'opaque-existing-envelope',
    });
}

function detail(triggers: AutomationDefinitionDetail['triggers']): AutomationDefinitionDetail {
    return {
        id: 'automation-1',
        name: 'Review work',
        description: null,
        enabled: true,
        targetType: 'existingSession',
        existingSessionId: 'target-session',
        templateVersion: 4,
        lastRunAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        assignments: [{ machineId: 'machine-1', enabled: true, priority: 0, updatedAt: timestamp }],
        triggers,
        retiredTriggers: [],
        executionRecipe: recipe,
    };
}

function draft(overrides: Partial<AutomationEditorDraft> = {}): AutomationEditorDraft {
    return {
        automationId: 'automation-1',
        pendingAutomationId: null,
        expectedTemplateVersion: 4,
        removedTriggers: [],
        name: 'Review work',
        description: null,
        enabled: true,
        executionRecipe: recipe,
        assignments: [{ machineId: 'machine-1', enabled: true, priority: 0 }],
        triggers: [],
        ...overrides,
    };
}

describe('saveAutomationEditorDraft', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(fetchAccountEncryptionMode).mockResolvedValue({ mode: 'plain', updatedAt: 1 });
    });

    it('creates a valid manual-only Automation with an explicit empty trigger set', async () => {
        const created = detail([]);
        vi.mocked(createAutomationDefinition).mockResolvedValue(created);

        await expect(saveAutomationEditorDraft({
            credentials,
            draft: draft({ automationId: null, pendingAutomationId: 'automation-new', expectedTemplateVersion: null }),
        })).resolves.toBe(created);

        expect(createAutomationDefinition).toHaveBeenCalledWith(credentials, expect.objectContaining({
            automationId: 'automation-new',
            name: 'Review work',
            triggers: [],
        }));
        expect(reconcileAutomationDefinition).not.toHaveBeenCalled();
    });

    it('reconciles heterogeneous rows by persisted identity without deleting and recreating retained triggers', async () => {
        const final = detail([scheduleTrigger('schedule-1', 3), lifecycleTrigger('turn-2', 1)]);
        vi.mocked(reconcileAutomationDefinition).mockResolvedValue(final);

        await expect(saveAutomationEditorDraft({
            credentials,
            draft: draft({
                name: 'Review work now',
                removedTriggers: [{ id: triggerId('turn-1'), revision: 5 }],
                triggers: [
                    {
                        clientId: 'stable-schedule-row',
                        persisted: { id: triggerId('schedule-1'), revision: 2 },
                        isDirty: true,
                        definition: { ...scheduleDefinition, enabled: false },
                    },
                    { clientId: 'new-turn-row', persisted: null, definition: lifecycleDefinition },
                ],
            }),
        })).resolves.toBe(final);

        expect(reconcileAutomationDefinition).toHaveBeenCalledWith(credentials, 'automation-1', expect.objectContaining({
            name: 'Review work now',
            triggers: [
                {
                    kind: 'existing',
                    triggerId: 'schedule-1',
                    expectedRevision: 2,
                    enabled: false,
                    trigger: { kind: 'schedule', schedule: scheduleDefinition.schedule },
                },
                { kind: 'new', triggerId: 'new-turn-row', trigger: lifecycleDefinition },
            ],
            removedTriggers: [{ triggerId: 'turn-1', expectedRevision: 5 }],
        }));
    });

    it('keeps two stable trigger ids across one edit/disable/remove save and the reload that follows it', async () => {
        const final = {
            ...detail([scheduleTrigger('schedule-1', 3), lifecycleTrigger('turn-2', 1)]),
            retiredTriggers: [{ id: triggerId('turn-1'), kind: 'sessionLifecycle' as const, revision: 5, retiredAt: timestamp }],
        };
        vi.mocked(reconcileAutomationDefinition).mockResolvedValue(final);

        // One plural-editor save: edit the interval, disable the schedule row,
        // and remove the lifecycle row in the same submit.
        const saved = await saveAutomationEditorDraft({
            credentials,
            draft: draft({
                name: 'Review work now',
                removedTriggers: [{ id: triggerId('turn-1'), revision: 5 }],
                triggers: [
                    {
                        clientId: 'stable-schedule-row',
                        persisted: { id: triggerId('schedule-1'), revision: 2 },
                        isDirty: true,
                        definition: { ...scheduleDefinition, enabled: false },
                    },
                    {
                        clientId: 'stable-lifecycle-row',
                        persisted: { id: triggerId('turn-2'), revision: 1 },
                        definition: lifecycleDefinition,
                    },
                ],
            }),
        });
        expect(vi.mocked(reconcileAutomationDefinition).mock.calls[0]?.[2]).toMatchObject({
            triggers: [
                { kind: 'existing', triggerId: 'schedule-1', expectedRevision: 2, enabled: false },
                { kind: 'existing', triggerId: 'turn-2', expectedRevision: 1 },
            ],
            removedTriggers: [{ triggerId: 'turn-1', expectedRevision: 5 }],
        });

        // Reload: the exact saved server bytes hydrate back into the editor
        // with both surviving trigger identities and their post-save revisions.
        const reloaded = automationEditorDraftFromDetail(saved, new Map([
            ['schedule-1', { definition: { ...scheduleDefinition, enabled: false } }],
            ['turn-2', { definition: lifecycleDefinition }],
        ]));
        expect(reloaded).not.toBeNull();
        expect(reloaded?.triggers.map((row) => ({
            clientId: row.clientId,
            persisted: row.persisted,
        }))).toEqual([
            { clientId: 'schedule-1', persisted: { id: triggerId('schedule-1'), revision: 3 } },
            { clientId: 'turn-2', persisted: { id: triggerId('turn-2'), revision: 1 } },
        ]);
        expect(reloaded?.removedTriggers).toEqual([]);
        // The removed row stays retired on the saved bytes and is never
        // resurrected into the mutable trigger set by the reload.
        expect(saved.triggers.some((row) => row.id === 'turn-1')).toBe(false);
        expect(saved.retiredTriggers.map((row) => row.id)).toEqual([triggerId('turn-1')]);
    });

    it('does not rewrite clean persisted triggers while saving Automation metadata', async () => {
        const before = detail([scheduleTrigger('schedule-1', 2)]);
        const final = { ...before, description: 'Updated description' };
        vi.mocked(reconcileAutomationDefinition).mockResolvedValue(final);

        await expect(saveAutomationEditorDraft({
            credentials,
            draft: draft({
                description: 'Updated description',
                triggers: [{
                    clientId: 'stable-schedule-row',
                    persisted: { id: triggerId('schedule-1'), revision: 2 },
                    definition: scheduleDefinition,
                }],
            }),
        })).resolves.toBe(final);

        expect(reconcileAutomationDefinition).toHaveBeenCalledWith(credentials, 'automation-1', expect.objectContaining({
            expectedTemplateVersion: 4,
            description: 'Updated description',
            triggers: [{ kind: 'existing', triggerId: 'schedule-1', expectedRevision: 2 }],
        }));
        expect(vi.mocked(reconcileAutomationDefinition).mock.calls[0]?.[2]).not.toHaveProperty('executionRecipe');
    });

    it('does not require trigger crypto for an E2EE metadata-only save', async () => {
        vi.mocked(fetchAccountEncryptionMode).mockResolvedValue({ mode: 'e2ee', updatedAt: 1 });
        const final = detail([eventTrigger('event-trigger-1', 4)]);
        vi.mocked(reconcileAutomationDefinition).mockResolvedValue(final);

        await expect(saveAutomationEditorDraft({
            credentials,
            draft: draft({
                name: 'Renamed encrypted automation',
                triggers: [{
                    clientId: 'event-trigger-1',
                    persisted: { id: triggerId('event-trigger-1'), revision: 4 },
                    definition: null,
                    retainedEvent: {
                        kind: 'pluginEvent',
                        enabled: true,
                        displayLabel: 'Repository',
                        eventRef: { pluginId: 'example.github', localId: 'push' },
                    },
                }],
            }),
        })).resolves.toBe(final);
    });

    it('submits only a canonically resealed next-version recipe as a recipe mutation', async () => {
        const nextRecipe = { ...recipe, templateVersion: 5 };
        const final = { ...detail([]), templateVersion: 5, executionRecipe: nextRecipe };
        vi.mocked(reconcileAutomationDefinition).mockResolvedValue(final);

        await expect(saveAutomationEditorDraft({
            credentials,
            draft: draft({ recipeDirty: true, executionRecipe: nextRecipe }),
        })).resolves.toBe(final);

        expect(reconcileAutomationDefinition).toHaveBeenCalledWith(credentials, 'automation-1', expect.objectContaining({
            expectedTemplateVersion: 4,
            executionRecipe: nextRecipe,
        }));
    });

    it('seals Event private source facts to the client-stable create identity for E2EE', async () => {
        const created = detail([]);
        const seal = vi.fn(() => ({ t: 'encrypted' as const, c: 'opaque-trigger-definition' }));
        vi.mocked(createAutomationDefinition).mockResolvedValue(created);
        vi.mocked(fetchAccountEncryptionMode).mockResolvedValue({ mode: 'e2ee', updatedAt: 1 });
        const eventDefinition = {
            kind: 'pluginEvent' as const,
            enabled: true,
            eventRef: { pluginId: 'example.github', localId: 'push' },
            sourceInstanceId: 'repository-42',
            sourceContractVersion: 1,
            sourceConfig: { owner: 'happier-dev', repository: 'happier' },
            displayLabel: 'happier-dev/happier',
            observationTransport: {
                kind: 'checkpointedPull' as const,
                watcherMaterializationRef: {
                    machineId: 'machine-1',
                    materializationId: 'github-1',
                    pluginId: 'example.github',
                },
            },
            filter: null,
            maximumObservationAgeMs: null,
        };
        await saveAutomationEditorDraft({
            credentials,
            draft: draft({
                automationId: null,
                pendingAutomationId: 'automation-new',
                expectedTemplateVersion: null,
                triggers: [{
                    clientId: 'event-trigger-new',
                    persisted: null,
                    definition: eventDefinition,
                    eventSourceBinding: {
                        sourceSelectorId,
                        sourceInstanceId: 'repository-42',
                    },
                }],
            }),
            sealAutomationTriggerDefinition: seal,
        });

        expect(seal).toHaveBeenCalledWith(expect.objectContaining({
            binding: expect.objectContaining({
                automationId: 'automation-new',
                triggerId: 'event-trigger-new',
                triggerRevision: 0,
                sourceSelectorId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
            }),
            definition: expect.objectContaining({
                sourceInstanceId: 'repository-42',
                sourceConfig: eventDefinition.sourceConfig,
            }),
        }));
        expect(createAutomationDefinition).toHaveBeenCalledWith(credentials, expect.objectContaining({
            triggers: [{
                triggerId: 'event-trigger-new',
                trigger: expect.objectContaining({
                    kind: 'pluginEvent',
                    sourceSelectorId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
                    triggerDefinitionEnvelope: { t: 'encrypted', c: 'opaque-trigger-definition' },
                }),
            }],
        }));
        const request = vi.mocked(createAutomationDefinition).mock.calls[0]?.[1];
        expect(JSON.stringify(request)).not.toContain('repository-42');
        expect(JSON.stringify(request)).not.toContain('happier-dev/happier');
    });

    it('keeps the semantic Event arm for a plain Account even when the crypto owner is mounted', async () => {
        vi.mocked(createAutomationDefinition).mockResolvedValue(detail([]));
        const seal = vi.fn(() => ({ t: 'encrypted' as const, c: 'must-not-be-used' }));
        const eventDefinition = {
            kind: 'pluginEvent' as const,
            enabled: true,
            eventRef: { pluginId: 'example.github', localId: 'push' },
            sourceInstanceId: 'repository-42',
            sourceContractVersion: 1,
            sourceConfig: { repository: 'happier-dev/happier' },
            displayLabel: 'happier-dev/happier',
            observationTransport: {
                kind: 'checkpointedPull' as const,
                watcherMaterializationRef: {
                    machineId: 'machine-1', materializationId: 'github-1', pluginId: 'example.github',
                },
            },
            filter: null,
            maximumObservationAgeMs: null,
        };
        await saveAutomationEditorDraft({
            credentials,
            draft: draft({
                automationId: null,
                pendingAutomationId: 'automation-new',
                expectedTemplateVersion: null,
                triggers: [{
                    clientId: 'event-trigger-new',
                    persisted: null,
                    definition: eventDefinition,
                    eventSourceBinding: {
                        sourceSelectorId,
                        sourceInstanceId: 'repository-42',
                    },
                }],
            }),
            sealAutomationTriggerDefinition: seal,
        });

        expect(seal).not.toHaveBeenCalled();
        expect(createAutomationDefinition).toHaveBeenCalledWith(credentials, expect.objectContaining({
            triggers: [{ triggerId: 'event-trigger-new', trigger: eventDefinition }],
        }));
    });

    it('binds an E2EE Event edit to the exact next trigger revision', async () => {
        const final = detail([eventTrigger('event-trigger-1', 5)]);
        vi.mocked(fetchAccountEncryptionMode).mockResolvedValue({ mode: 'e2ee', updatedAt: 1 });
        vi.mocked(reconcileAutomationDefinition).mockResolvedValue(final);
        const seal = vi.fn(() => ({ t: 'encrypted' as const, c: 'next-revision-envelope' }));
        const sourceConfig = { repository: 'happier-dev/happier' };

        await saveAutomationEditorDraft({
            credentials,
            draft: draft({
                triggers: [{
                    clientId: 'event-trigger-1',
                    persisted: { id: triggerId('event-trigger-1'), revision: 4 },
                    isDirty: true,
                    eventSourceBinding: {
                        sourceSelectorId,
                        sourceInstanceId: 'repository-42',
                    },
                    definition: {
                        kind: 'pluginEvent',
                        enabled: false,
                        eventRef: { pluginId: 'example.github', localId: 'push' },
                        sourceInstanceId: 'repository-42',
                        sourceContractVersion: 1,
                        sourceConfig,
                        displayLabel: 'happier-dev/happier',
                        observationTransport: {
                            kind: 'checkpointedPull',
                            watcherMaterializationRef: {
                                machineId: 'machine-1',
                                materializationId: 'github-1',
                                pluginId: 'example.github',
                            },
                        },
                        filter: null,
                        maximumObservationAgeMs: null,
                    },
                }],
            }),
            sealAutomationTriggerDefinition: seal,
        });

        expect(seal).toHaveBeenCalledWith(expect.objectContaining({
            binding: expect.objectContaining({
                triggerId: 'event-trigger-1',
                triggerRevision: 5,
            }),
            definition: expect.objectContaining({ sourceConfig }),
        }));
        const patch = vi.mocked(reconcileAutomationDefinition).mock.calls[0]?.[2].triggers[0];
        expect(patch).toMatchObject({
            kind: 'existing',
            triggerId: 'event-trigger-1',
            expectedRevision: 4,
            enabled: false,
            trigger: {
                kind: 'pluginEvent',
                triggerDefinitionEnvelope: { t: 'encrypted', c: 'next-revision-envelope' },
            },
        });
        expect(JSON.stringify(patch)).not.toContain('happier-dev/happier');
        expect(JSON.stringify(patch)).not.toContain('repository-42');
    });

    it('reseals the exact retained Event payload for an E2EE enable-only revision', async () => {
        const final = detail([eventTrigger('event-trigger-1', 5)]);
        vi.mocked(fetchAccountEncryptionMode).mockResolvedValue({ mode: 'e2ee', updatedAt: 1 });
        vi.mocked(reconcileAutomationDefinition).mockResolvedValue(final);
        const seal = vi.fn(() => ({ t: 'encrypted' as const, c: 'enable-only-next-revision' }));
        const retainedPayload = {
            v: 1 as const,
            sourceInstanceId: 'repository-42',
            sourceConfig: { repository: 'happier-dev/happier' },
            displayLabel: 'happier-dev/happier',
            filter: null,
            maximumObservationAgeMs: null,
        };

        await saveAutomationEditorDraft({
            credentials,
            draft: draft({
                triggers: [{
                    clientId: 'event-trigger-1',
                    persisted: { id: triggerId('event-trigger-1'), revision: 4 },
                    isDirty: true,
                    definition: null,
                    retainedEvent: {
                        kind: 'pluginEvent',
                        enabled: false,
                        displayLabel: 'happier-dev/happier',
                        eventRef: { pluginId: 'example.github', localId: 'push' },
                    },
                    eventSourceBinding: {
                        sourceSelectorId,
                        sourceInstanceId: 'repository-42',
                    },
                    retainedEventPrivateDefinition: retainedPayload,
                }],
            }),
            sealAutomationTriggerDefinition: seal,
        });

        expect(seal).toHaveBeenCalledWith({
            binding: expect.objectContaining({ triggerId: 'event-trigger-1', triggerRevision: 5 }),
            definition: retainedPayload,
        });
        expect(reconcileAutomationDefinition).toHaveBeenCalledWith(credentials, 'automation-1', expect.objectContaining({
            triggers: [{
                kind: 'existing',
                triggerId: 'event-trigger-1',
                expectedRevision: 4,
                enabled: false,
                triggerDefinitionEnvelope: { t: 'encrypted', c: 'enable-only-next-revision' },
            }],
        }));
    });

    it('surfaces a server-owned stale recipe conflict without a client-side authority read', async () => {
        vi.mocked(reconcileAutomationDefinition).mockRejectedValue({
            code: 'automation_template_version_conflict',
        });

        await expect(saveAutomationEditorDraft({ credentials, draft: draft() }))
            .rejects.toBeInstanceOf(AutomationEditorSaveStaleError);

        expect(reconcileAutomationDefinition).toHaveBeenCalledTimes(1);
    });

    it('does not use a fresh read to authorize deleting a concurrently added or edited trigger', async () => {
        vi.mocked(reconcileAutomationDefinition).mockRejectedValue(new AutomationEditorSaveStaleError());

        await expect(saveAutomationEditorDraft({
            credentials,
            draft: draft({
                triggers: [{
                    clientId: 'stable-schedule-row',
                    persisted: { id: triggerId('schedule-1'), revision: 2 },
                    definition: scheduleDefinition,
                }],
            }),
        })).rejects.toBeInstanceOf(AutomationEditorSaveStaleError);

        expect(reconcileAutomationDefinition).toHaveBeenCalledTimes(1);
    });

    it('fails closed when server, Account, or route authority changes before the save request', async () => {
        const currentness = [true, false];

        await expect(saveAutomationEditorDraft({
            credentials,
            draft: draft(),
            isCurrent: () => currentness.shift() ?? false,
        })).rejects.toBeInstanceOf(AutomationEditorSaveStaleError);

        expect(reconcileAutomationDefinition).not.toHaveBeenCalled();
    });

    it('does not consume an atomically saved response after route authority changes', async () => {
        vi.mocked(reconcileAutomationDefinition).mockResolvedValue(detail([scheduleTrigger('schedule-1', 3)]));
        const currentness = [true, true, false];

        await expect(saveAutomationEditorDraft({
            credentials,
            draft: draft({
                triggers: [{
                    clientId: 'stable-schedule-row',
                    persisted: { id: triggerId('schedule-1'), revision: 2 },
                    isDirty: true,
                    definition: { ...scheduleDefinition, enabled: false },
                }],
            }),
            isCurrent: () => currentness.shift() ?? false,
        })).rejects.toBeInstanceOf(AutomationEditorSaveStaleError);

        expect(reconcileAutomationDefinition).toHaveBeenCalledTimes(1);
    });
});
