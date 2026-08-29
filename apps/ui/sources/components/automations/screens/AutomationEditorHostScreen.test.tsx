import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { installAutomationScreensCommonModuleMocks } from './automationScreensTestHelpers';
import type { StorageState } from '@/sync/store/types';
import React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    AutomationStoredDefinitionExecutionRecipeV1Schema,
    AutomationTriggerDetailSchema,
} from '@happier-dev/protocol';

import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const syncSpies = vi.hoisted(() => ({
    refreshAutomationDefinitionDetail: vi.fn(),
    saveAutomationEditorDraft: vi.fn(),
    refreshSessions: vi.fn(async () => {}),
    getCredentials: vi.fn(() => ({ token: 'token-1', secret: 'secret-1' })),
}));
const authorityState = vi.hoisted(() => ({ current: true }));
const authorityCaptures = vi.hoisted(() => ({ list: [] as Array<{ serverId: string; accountId: string }> }));
const routerSetParamsSpy = vi.hoisted(() => vi.fn());
const routerReplaceSpy = vi.hoisted(() => vi.fn());
const routerBackSpy = vi.hoisted(() => vi.fn());
const navigateWithBlurOnWebSpy = vi.hoisted(() => vi.fn((action: () => void) => action()));
const modalAlertSpy = vi.hoisted(() => vi.fn(async () => {}));
const modalConfirmSpy = vi.hoisted(() => vi.fn(async () => false));
const storageState = vi.hoisted(() => ({
    value: {} as Record<string, unknown>,
}));
const automationState = vi.hoisted(() => ({
    definition: null as any,
}));
const latestEditorProps = vi.hoisted(() => ({
    value: null as any,
}));

vi.mock('@/components/automations/editor/AutomationPluralEditorScreen', () => ({
    AutomationPluralEditorScreen: (props: any) => {
        latestEditorProps.value = props;
        return React.createElement('AutomationPluralEditorScreen', props);
    },
}));
vi.mock('@/components/automations/editor/PluginEventAutomationEditor', () => ({
    PluginEventAutomationEditor: (props: any) => React.createElement('PluginEventAutomationEditor', props),
}));
vi.mock('@/sync/sync', () => ({
    sync: syncSpies,
}));
vi.mock('@/sync/api/account/apiAccountEncryptionMode', () => ({
    fetchAccountEncryptionMode: vi.fn(async () => ({ mode: 'plain', updatedAt: 1 })),
}));
vi.mock('@/sync/api/automations/apiAutomations', () => ({
    isAutomationApiErrorCode: (error: unknown, code: string) => (
        typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
    ),
}));
vi.mock('@/sync/domains/scope/activeServerAccountScope', () => ({
    captureActiveServerAccountScopeLifetime: () => {
        const scope = (storageState.value as {
            profileScope?: { serverId: string; accountId: string };
        }).profileScope;
        if (!scope) return null;
        return {
            scope,
            isCurrent: () => {
                const current = (storageState.value as {
                    profileScope?: { serverId: string; accountId: string };
                }).profileScope;
                return current?.serverId === scope.serverId && current?.accountId === scope.accountId;
            },
            onRetire: () => ({ dispose: () => undefined }),
        };
    },
}));
// Lifetime-sensitive authority mock: each capture binds the serverId+accountId
// scope live at capture time and isCurrent() re-reads the current scope, so a
// same-server Account A→B switch retires every A-era authority exactly like
// the real captureSessionAutomationAuthority owner.
vi.mock('@/sync/domains/automations/sessionAutomationAuthority', () => ({
    captureSessionAutomationAuthority: (params: {
        routeSessionId?: string | null;
        routeServerId?: string | null;
    }) => {
        const scope = (storageState.value as {
            profileScope?: { serverId: string; accountId: string };
        }).profileScope;
        if (!authorityState.current || !scope) return null;
        const captured = { serverId: scope.serverId, accountId: scope.accountId };
        authorityCaptures.list.push(captured);
        return {
            sessionId: params?.routeSessionId ?? null,
            serverId: captured.serverId,
            accountLifetime: { onRetire: () => ({ dispose: () => undefined }) },
            isCurrent: () => {
                if (!authorityState.current) return false;
                const current = (storageState.value as {
                    profileScope?: { serverId: string; accountId: string };
                }).profileScope;
                return !!current
                    && current.serverId === captured.serverId
                    && current.accountId === captured.accountId;
            },
        };
    },
}));
vi.mock('@/sync/domains/server/serverRuntime', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/domains/server/serverRuntime')>(),
    getActiveServerSnapshot: () => ({ serverId: 'server-1' }),
}));
vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({
    useActiveServerSnapshot: () => ({ serverId: 'server-1' }),
}));
vi.mock('@/hooks/server/useAutomationsSupport', () => ({
    useAutomationsSupport: () => ({ enabled: true }),
}));
vi.mock('@/utils/platform/deferOnWeb', () => ({
    navigateWithBlurOnWeb: navigateWithBlurOnWebSpy,
}));

installAutomationScreensCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: { back: routerBackSpy, replace: routerReplaceSpy, setParams: routerSetParamsSpy },
        }).module;
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: modalAlertSpy,
                confirm: modalConfirmSpy,
                prompt: vi.fn(),
            },
        }).module;
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useAutomation: () => automationState.definition,
            useSessions: () => Object.values(
                (storageState.value as { sessions?: Record<string, unknown> }).sessions ?? {},
            ),
            useActiveServerAccountScope: () => (
                (storageState.value as { profileScope?: unknown }).profileScope ?? null
            ),
            storage: Object.assign(
                ((selector?: (value: StorageState) => unknown) => (
                    typeof selector === 'function'
                        ? selector(storageState.value as unknown as StorageState)
                        : (storageState.value as unknown as StorageState)
                )),
                {
                    getState: () => storageState.value as unknown as StorageState,
                    getInitialState: () => storageState.value as unknown as StorageState,
                    setState: () => undefined,
                    subscribe: () => () => undefined,
                    destroy: () => undefined,
                },
            ),
        });
    },
});

const timestamp = 1_786_257_600_000;

const recipe = AutomationStoredDefinitionExecutionRecipeV1Schema.parse({
    v: 1,
    templateVersion: 4,
    template: { t: 'plain', v: { v: 1, prompt: 'Ship notes' } },
    triggerEvidence: null,
    target: { kind: 'existingSession', sessionId: 'session-target' },
});

function detailTriggers() {
    return {
        schedule: AutomationTriggerDetailSchema.parse({
            id: 'trigger-schedule-1',
            revision: 2,
            enabled: true,
            createdAt: timestamp,
            updatedAt: timestamp,
            kind: 'schedule' as const,
            schedule: { kind: 'interval' as const, scheduleExpr: null, everyMs: 3_600_000, timezone: null },
            nextRunAt: null,
            triggerDefinitionEnvelope: null,
        }),
        lifecycle: AutomationTriggerDetailSchema.parse({
            id: 'trigger-turn-1',
            revision: 1,
            enabled: true,
            createdAt: timestamp,
            updatedAt: timestamp,
            kind: 'sessionLifecycle' as const,
            event: 'parentTurnCompleted' as const,
            scope: {
                kind: 'exactTurn' as const,
                sourceSessionId: 'source-session-b',
                sourceTurnId: 'turn-old',
            },
            consumption: 'once' as const,
            status: { state: 'waiting' as const, runId: null },
            triggerDefinitionEnvelope: null,
        }),
    };
}

function definitionDetailValue() {
    const triggers = detailTriggers();
    return {
        id: 'automation-1',
        name: 'Ship notes',
        description: null,
        enabled: true,
        targetType: 'existingSession' as const,
        existingSessionId: 'session-target',
        templateVersion: 4,
        lastRunAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        assignments: [{ machineId: 'machine-1', enabled: true, priority: 0, updatedAt: timestamp }],
        triggers: [triggers.schedule, triggers.lifecycle],
        executionRecipe: recipe,
    };
}

function seedStoreDefinition() {
    const value = definitionDetailValue();
    automationState.definition = {
        ...value,
        triggers: value.triggers.map(({ triggerDefinitionEnvelope: _envelope, ...summary }) => summary),
        detail: { kind: 'available' as const, templateVersion: 4, value },
        linkedExistingSessionId: 'session-target',
    };
    syncSpies.refreshAutomationDefinitionDetail.mockResolvedValue(
        automationState.definition,
    );
}

function sessionFixture(input: {
    id: string;
    latestTurnId: string;
    latestTurnStatus: 'in_progress' | 'completed';
}) {
    return {
        id: input.id,
        serverId: 'server-1',
        latestTurnId: input.latestTurnId,
        latestTurnStatus: input.latestTurnStatus,
        name: input.id,
        metadata: {
            flavor: 'claude',
            claudeSessionId: `claude-${input.id}`,
            claudeTranscriptPath: `/tmp/${input.id}.jsonl`,
        },
    };
}

function seedStorageSessions() {
    storageState.value = {
        profileScope: { serverId: 'server-1', accountId: 'account-1' },
        sessions: {
            'session-target': sessionFixture({
                id: 'session-target',
                latestTurnId: 'turn-target',
                latestTurnStatus: 'completed',
            }),
            'session-other': sessionFixture({
                id: 'session-other',
                latestTurnId: 'turn-other',
                latestTurnStatus: 'completed',
            }),
            'source-session': sessionFixture({
                id: 'source-session',
                latestTurnId: 'turn-7',
                latestTurnStatus: 'in_progress',
            }),
            'source-session-b': sessionFixture({
                id: 'source-session-b',
                latestTurnId: 'turn-old',
                latestTurnStatus: 'completed',
            }),
            'hidden-history': {
                ...sessionFixture({
                    id: 'hidden-history',
                    latestTurnId: 'turn-hidden',
                    latestTurnStatus: 'in_progress',
                }),
                metadata: {
                    ...sessionFixture({
                        id: 'hidden-history',
                        latestTurnId: 'turn-hidden',
                        latestTurnStatus: 'in_progress',
                    }).metadata,
                    systemSessionV1: { v: 1, key: 'voice_transcript_history', hidden: true },
                },
            },
        },
    };
}

async function flushRender(): Promise<void> {
    await flushHookEffects({ cycles: 3, turns: 3 });
}

async function mountHost(props: {
    automationId?: string;
    exactTurnPrefill?: { sourceSessionId: string; sourceTurnId: string; sourceServerId: string } | null;
}) {
    const { AutomationEditorHostScreen } = await import('./AutomationEditorHostScreen');
    return await renderScreen(
        <AutomationEditorHostScreen
            automationId={props.automationId ?? 'automation-1'}
            exactTurnPrefill={props.exactTurnPrefill ?? null}
        />,
    );
}

describe('AutomationEditorHostScreen', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        authorityState.current = true;
        authorityCaptures.list.length = 0;
        latestEditorProps.value = null;
        seedStoreDefinition();
        seedStorageSessions();
    });

    it('seeds the exact observed prefill as one new row and saves through the one canonical writer', async () => {
        syncSpies.saveAutomationEditorDraft.mockResolvedValue({ id: 'automation-1' });
        const screen = await mountHost({
            exactTurnPrefill: { sourceSessionId: 'source-session', sourceTurnId: 'turn-7', sourceServerId: 'server-1' },
        });
        await flushRender();

        const editor = latestEditorProps.value;
        expect(editor).not.toBeNull();
        expect(editor.variant).toBe('edit');
        const triggers = editor.value.triggers;
        expect(triggers).toHaveLength(3);
        expect(triggers[0]).toMatchObject({ persisted: { id: 'trigger-schedule-1', revision: 2 } });
        expect(triggers[1]).toMatchObject({ persisted: { id: 'trigger-turn-1', revision: 1 } });
        expect(triggers[2]).toMatchObject({
            persisted: null,
            definition: {
                kind: 'sessionLifecycle',
                event: 'parentTurnCompleted',
                scope: { kind: 'exactTurn', sourceSessionId: 'source-session', sourceTurnId: 'turn-7' },
                consumption: 'once',
            },
        });

        await act(async () => editor.onSubmit());
        await flushRender();

        expect(syncSpies.saveAutomationEditorDraft).toHaveBeenCalledTimes(1);
        const [savedDraft, saveOptions] = syncSpies.saveAutomationEditorDraft.mock.calls[0]!;
        expect(savedDraft.triggers[2]).toMatchObject({
            persisted: null,
            definition: { scope: { sourceSessionId: 'source-session', sourceTurnId: 'turn-7' } },
        });
        expect(typeof saveOptions.isCurrent).toBe('function');
        expect(routerReplaceSpy).toHaveBeenCalledWith('/automations/automation-1');
        expect(modalAlertSpy).not.toHaveBeenCalled();
        expect(screen).toBeDefined();
    });

    it('retires the mounted server-bound draft when the active account scope changes', async () => {
        const screen = await mountHost({});
        await flushRender();
        expect(latestEditorProps.value).not.toBeNull();
        const firstScopeDraft = latestEditorProps.value.value;

        storageState.value = {
            ...(storageState.value as Record<string, unknown>),
            profileScope: { serverId: 'server-1', accountId: 'account-2' },
        };
        const { AutomationEditorHostScreen } = await import('./AutomationEditorHostScreen');
        await screen.update(
            <AutomationEditorHostScreen automationId="automation-1" exactTurnPrefill={null} />,
        );

        await flushRender();
        // The host rehydrates a fresh draft for the new scope through the same
        // owner; nothing from the retired draft is reused.
        expect(syncSpies.refreshAutomationDefinitionDetail).toHaveBeenCalledTimes(2);
        expect(latestEditorProps.value.value).not.toBe(firstScopeDraft);
        expect(latestEditorProps.value.value.automationId).toBe('automation-1');
    });

    it('keeps the mounted exact-turn draft alive when the source session updates but the exact turn is unchanged', async () => {
        const screen = await mountHost({
            exactTurnPrefill: { sourceSessionId: 'source-session', sourceTurnId: 'turn-7', sourceServerId: 'server-1' },
        });
        await flushRender();

        const mounted = latestEditorProps.value;
        expect(mounted).not.toBeNull();
        await act(async () => mounted.onChange({
            ...mounted.value,
            name: 'Local edit before live update',
        }));
        const editedDraft = latestEditorProps.value.value;
        expect(editedDraft.name).toBe('Local edit before live update');

        // A live transcript update replaces the Session object while the exact
        // turn is unchanged, and the route re-renders with a semantically equal
        // prefill object. Neither is an authority change, so the mounted draft
        // must survive without rehydration.
        storageState.value = {
            ...(storageState.value as Record<string, unknown>),
            sessions: {
                ...((storageState.value as { sessions?: Record<string, unknown> }).sessions ?? {}),
                'source-session': sessionFixture({
                    id: 'source-session',
                    latestTurnId: 'turn-7',
                    latestTurnStatus: 'in_progress',
                }),
            },
        };
        const { AutomationEditorHostScreen } = await import('./AutomationEditorHostScreen');
        await screen.update(
            <AutomationEditorHostScreen
                automationId="automation-1"
                exactTurnPrefill={{ sourceSessionId: 'source-session', sourceTurnId: 'turn-7', sourceServerId: 'server-1' }}
            />,
        );
        await flushRender();

        expect(syncSpies.refreshAutomationDefinitionDetail).toHaveBeenCalledTimes(1);
        expect(latestEditorProps.value.value).toBe(editedDraft);
        expect(latestEditorProps.value.value.name).toBe('Local edit before live update');
    });

    it('saves an unrelated edit while a clean terminal lifecycle row is present', async () => {
        syncSpies.saveAutomationEditorDraft.mockResolvedValue({ id: 'automation-1' });
        await mountHost({});
        await flushRender();

        const editor = latestEditorProps.value;
        const lifecycleRow = editor.value.triggers[1];
        expect(lifecycleRow.persisted).toEqual({ id: 'trigger-turn-1', revision: 1 });
        expect(lifecycleRow.isDirty).toBeUndefined();
        // The row's source turn is terminal in storage; a clean row is not
        // revalidated locally and must not block an unrelated metadata edit.
        await act(async () => editor.onChange({
            ...editor.value,
            name: 'Renamed without touching triggers',
        }));
        await act(async () => editor.onSubmit());
        await flushRender();

        expect(syncSpies.saveAutomationEditorDraft).toHaveBeenCalledTimes(1);
        const [savedDraft] = syncSpies.saveAutomationEditorDraft.mock.calls[0]!;
        expect(savedDraft.name).toBe('Renamed without touching triggers');
        expect(savedDraft.triggers[1]?.isDirty).toBeUndefined();
        expect(modalAlertSpy).not.toHaveBeenCalled();
    });

    it('refuses to save a changed lifecycle row whose source turn is no longer current', async () => {
        await mountHost({});
        await flushRender();

        const editor = latestEditorProps.value;
        const lifecycleRow = editor.value.triggers[1];
        await act(async () => editor.onChange({
            ...editor.value,
            triggers: editor.value.triggers.map((candidate: any) => (
                candidate.clientId === lifecycleRow.clientId
                ? { ...candidate, isDirty: true, definition: { ...candidate.definition, enabled: false } }
                : candidate
            )),
        }));
        await act(async () => editor.onSubmit());
        await flushRender();

        expect(syncSpies.saveAutomationEditorDraft).not.toHaveBeenCalled();
        expect(syncSpies.refreshSessions).toHaveBeenCalled();
        expect(modalAlertSpy).toHaveBeenCalledWith(
            'automations.exactTurn.staleTitle',
            'automations.exactTurn.staleBody',
        );
    });

    it('presents the existing-session target as non-selectable so the source always differs', async () => {
        await mountHost({});
        await flushRender();

        const editor = latestEditorProps.value;
        expect(editor.value.executionRecipe.target).toEqual({
            kind: 'existingSession',
            sessionId: 'session-target',
        });
        const selectableById = new Map(
            editor.sessionOptions.map((option: any) => [option.sessionId, option.selectable]),
        );
        expect(selectableById.get('session-target')).toBe(false);
        expect(selectableById.get('session-other')).toBe(true);
        expect(selectableById.get('source-session')).toBe(true);
        expect(selectableById.has('hidden-history')).toBe(false);
    });

    it('rebinds the exact-turn authority under the new Account after a same-server Account change', async () => {
        syncSpies.saveAutomationEditorDraft.mockResolvedValue({ id: 'automation-1' });
        const screen = await mountHost({
            exactTurnPrefill: { sourceSessionId: 'source-session', sourceTurnId: 'turn-7', sourceServerId: 'server-1' },
        });
        await flushRender();

        // Authorized under Account A: the observed prefill row is mounted.
        const draftUnderA = latestEditorProps.value.value;
        expect(draftUnderA.triggers.at(-1)).toMatchObject({
            persisted: null,
            definition: { scope: { sourceSessionId: 'source-session', sourceTurnId: 'turn-7' } },
        });
        expect(syncSpies.refreshAutomationDefinitionDetail).toHaveBeenCalledTimes(1);

        // Same server, Account B mounts: the A-era binding retires, B
        // rehydrates exactly once, and the prefill re-authorizes under B.
        storageState.value = {
            ...(storageState.value as Record<string, unknown>),
            profileScope: { serverId: 'server-1', accountId: 'account-2' },
        };
        const { AutomationEditorHostScreen } = await import('./AutomationEditorHostScreen');
        await screen.update(
            <AutomationEditorHostScreen
                automationId="automation-1"
                exactTurnPrefill={{ sourceSessionId: 'source-session', sourceTurnId: 'turn-7', sourceServerId: 'server-1' }}
            />,
        );
        await flushRender();
        await flushRender();

        expect(syncSpies.refreshAutomationDefinitionDetail).toHaveBeenCalledTimes(2);
        expect(latestEditorProps.value.value).not.toBe(draftUnderA);
        expect(latestEditorProps.value.value.triggers.at(-1)).toMatchObject({
            persisted: null,
            definition: { scope: { sourceSessionId: 'source-session', sourceTurnId: 'turn-7' } },
        });
        expect(authorityCaptures.list.at(-1)).toMatchObject({ serverId: 'server-1', accountId: 'account-2' });

        // The mounted draft saves under B's authority; a retired A authority
        // can never authorize this request.
        await act(async () => latestEditorProps.value.onSubmit());
        await flushRender();
        expect(syncSpies.saveAutomationEditorDraft).toHaveBeenCalledTimes(1);
        expect(modalAlertSpy).not.toHaveBeenCalled();
    });

    it('advances only the exact-turn row when explicitly adopting the current turn after staleness', async () => {
        syncSpies.saveAutomationEditorDraft.mockResolvedValue({ id: 'automation-1' });
        const screen = await mountHost({
            exactTurnPrefill: { sourceSessionId: 'source-session', sourceTurnId: 'turn-7', sourceServerId: 'server-1' },
        });
        await flushRender();

        // Unsaved work unrelated to the exact-turn row: name, prompt, and a
        // second trigger row's enablement.
        const mounted = latestEditorProps.value;
        await act(async () => mounted.onChange({
            ...mounted.value,
            name: 'Renamed before staleness',
            executionRecipe: {
                ...mounted.value.executionRecipe,
                template: { t: 'plain', v: { v: 1, prompt: 'Revised prompt before staleness' } },
            },
            triggers: mounted.value.triggers.map((trigger: any, index: number) => (
                index === 0 ? { ...trigger, definition: { ...trigger.definition, enabled: false } } : trigger
            )),
        }));

        // The observed turn completes and a new turn starts: the binding is stale.
        storageState.value = {
            ...(storageState.value as Record<string, unknown>),
            sessions: {
                ...((storageState.value as { sessions?: Record<string, unknown> }).sessions ?? {}),
                'source-session': sessionFixture({
                    id: 'source-session',
                    latestTurnId: 'turn-8',
                    latestTurnStatus: 'in_progress',
                }),
            },
        };
        await act(async () => latestEditorProps.value.onSubmit());
        await flushRender();

        // The stale save is refused locally and typed stale truth is offered.
        expect(syncSpies.saveAutomationEditorDraft).not.toHaveBeenCalled();
        const staleCard = screen.findByProps({ testID: 'automation-edit-exact-turn-stale' });
        expect(staleCard.props.action.label).toBe('automations.exactTurn.useCurrentTurn');

        await act(async () => staleCard.props.action.onPress());
        await flushRender();

        // The mounted draft was NOT rehydrated: only the exact-turn row moved.
        expect(syncSpies.refreshAutomationDefinitionDetail).toHaveBeenCalledTimes(1);
        const draft = latestEditorProps.value.value;
        expect(draft.name).toBe('Renamed before staleness');
        expect(draft.executionRecipe.template).toEqual({ t: 'plain', v: { v: 1, prompt: 'Revised prompt before staleness' } });
        expect(draft.triggers[0]).toMatchObject({ definition: { enabled: false } });
        expect(draft.triggers[1]).toMatchObject({ persisted: { id: 'trigger-turn-1', revision: 1 } });
        expect(draft.triggers.at(-1)).toMatchObject({
            persisted: null,
            definition: { scope: { sourceSessionId: 'source-session', sourceTurnId: 'turn-8' } },
        });
        // Route params stay URL truth for the adopted turn.
        expect(routerSetParamsSpy).toHaveBeenCalledWith({
            sourceSessionId: 'source-session',
            sourceTurnId: 'turn-8',
            sourceServerId: 'server-1',
        });
        expect(screen.findAllByProps({ testID: 'automation-edit-exact-turn-stale' })).toHaveLength(0);

        // The adopted binding authorizes the save with every edit intact.
        await act(async () => latestEditorProps.value.onSubmit());
        await flushRender();
        expect(syncSpies.saveAutomationEditorDraft).toHaveBeenCalledTimes(1);
        const [savedDraft] = syncSpies.saveAutomationEditorDraft.mock.calls[0]!;
        expect(savedDraft.name).toBe('Renamed before staleness');
        expect(savedDraft.triggers.at(-1)?.definition?.scope).toMatchObject({ sourceTurnId: 'turn-8' });
    });
});
