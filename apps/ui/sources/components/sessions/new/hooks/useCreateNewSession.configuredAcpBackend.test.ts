import 'fake-indexeddb/auto';
import { createAuthoringMemoryHttpBoundary } from '@/dev/testkit/mocks/authoringMemoryHttp';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import React from 'react';
import { createNewSessionPromptStore } from '@/components/sessions/new/hooks/screenModel/newSessionPromptStore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildNewSessionAuthoringDraft } from '@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters';
import type { PermissionMode, ModelMode } from '@/sync/domains/permissions/permissionTypes';
import type { Settings } from '@/sync/domains/settings/settings';
import type { UseMachineEnvPresenceResult } from '@/hooks/machine/useMachineEnvPresence';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installNewSessionScreenModelCommonModuleMocks, selectNewSessionTestHome } from './newSessionScreenModelTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type SpawnPayloadCapture = {
    backendTarget?:
        | { kind: 'backend'; backendId: string; configuredBackendId?: string; sourceKind?: 'built_in' | 'configured' };
    accountSettingsVersionHint?: number;
} | null;

type ConfiguredBackendHarnessOptions = Readonly<{
    deferFollowUp?: boolean;
    spawnSuccess?: boolean;
}>;

type ConfiguredBackendStorageState = ReturnType<(typeof import('@/sync/domains/state/storageStore'))['storage']['getState']>;

const clearNewSessionDraftMock = vi.hoisted(() => vi.fn());
const sessionCreationRequestSpy = vi.hoisted(() => vi.fn());
const configuredBackendHarnessModuleState = vi.hoisted(() => ({
    sync: null as typeof import('@/sync/sync').sync | null,
    captured: null as { value: SpawnPayloadCapture } | null,
    createdAutomationRecipe: null as { value: Record<string, unknown> | null } | null,
    storageState: null as ConfiguredBackendStorageState | null,
    spawnSuccess: false,
    followUpPending: Promise.resolve() as Promise<void>,
}));

// Bridge the bundler-only singleton require to the same real Vitest-loaded owner.
vi.mock('@/sync/runtime/getSyncSingleton', () => ({
    getSyncSingleton: () => {
        if (!configuredBackendHarnessModuleState.sync) throw new Error('Sync test owner is not initialized');
        return configuredBackendHarnessModuleState.sync;
    },
}));
let loadedUseCreateNewSessionOwner: typeof import('./useCreateNewSession')['useCreateNewSession'] | null = null;

async function setupHarness(options?: ConfiguredBackendHarnessOptions) {
    const captured: { value: SpawnPayloadCapture } = { value: null };
    const createdAutomationRecipe: { value: Record<string, unknown> | null } = { value: null };
    const routerReplaceSpy = vi.fn();
    let resolveFollowUp: (() => void) | null = null;
    const followUpPending = options?.deferFollowUp
        ? new Promise<void>((resolve) => {
            resolveFollowUp = resolve;
        })
        : Promise.resolve();
    configuredBackendHarnessModuleState.captured = captured;
    configuredBackendHarnessModuleState.createdAutomationRecipe = createdAutomationRecipe;
    configuredBackendHarnessModuleState.spawnSuccess = options?.spawnSuccess === true;
    configuredBackendHarnessModuleState.followUpPending = followUpPending;

    installNewSessionScreenModelCommonModuleMocks({
        text: async () => {
            const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
            return createTextModuleMock({
                translate: (key: string) => key,
            });
        },
        modal: async () => {
            const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
            return createModalModuleMock({
                spies: {
                    alert: vi.fn(),
                    confirm: vi.fn(async () => false),
                },
            }).module;
        },
    });
    vi.doUnmock('@/sync/domains/state/storage');
    vi.doUnmock('@/sync/sync');
    vi.doUnmock('@/sync/store/settingsWriters');
    vi.doUnmock('@/sync/domains/state/persistence');
    await selectNewSessionTestHome();
    const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    const authoringMemoryHttp = createAuthoringMemoryHttpBoundary();
    setRuntimeFetch(async (input, init) => {
        const authoringResponse = await authoringMemoryHttp.handle(input, init);
        if (authoringResponse) return authoringResponse;
        const url = String(input);
        if (url.endsWith('/v3/automations') && init?.method === 'POST') {
            const body = JSON.parse(String(init.body)) as { executionRecipe: Record<string, unknown> };
            createdAutomationRecipe.value = body.executionRecipe;
        }
        if (url.endsWith('/v1/auth/ping') || url.endsWith('/health')) return Response.json({ ok: true });
        if (url.endsWith('/v1/account/encryption')) return Response.json({ mode: 'plain', updatedAt: 1 });
        if (url.endsWith('/v2/account/settings') && (!init?.method || init.method === 'GET')) return Response.json({ content: null, version: 1 });
        return Response.json({ error: 'not_found' }, { status: 404 });
    });
    const { storage } = await import('@/sync/domains/state/storageStore');
    const { sync } = await import('@/sync/syncEngine');
    configuredBackendHarnessModuleState.sync = sync;
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account-a' })).toString('base64url')}.signature`;
    await sync.switchServer({ token });
    storage.getState().applySettings(storage.getState().settings, 1);
    storage.getState().applyMachines([createMachineFixture({ id: 'm1' })], true, { sourceServerId: 'server-a' });
    const storageState = storage.getState();
    configuredBackendHarnessModuleState.storageState = storageState;
    const persistence = await import('@/sync/domains/state/persistence');
    const clearNewSessionDraft = persistence.clearNewSessionDraft;
    vi.spyOn(persistence, 'clearNewSessionDraft').mockImplementation((...args) => {
        clearNewSessionDraftMock(...args);
        return clearNewSessionDraft(...args);
    });
    vi.doMock('@/sync/domains/features/featureLocalPolicy', () => ({
        resolveLocalFeaturePolicyEnabled: vi.fn(() => false),
    }));
    vi.doMock('@/utils/profiles/profileConfigRequirements', () => ({
        getMissingRequiredConfigEnvVarNames: vi.fn(() => []),
    }));
    vi.doMock('@/utils/secrets/secretSatisfaction', () => ({
        getSecretSatisfaction: vi.fn(() => ({ isSatisfied: true, items: [] })),
    }));
    vi.doMock('@/sync/domains/profiles/profileUtils', () => ({
        getBuiltInProfile: vi.fn(() => null),
    }));
    vi.doMock('@/sync/domains/session/spawn/windowsRemoteSessionConsole', () => ({
        resolveWindowsRemoteSessionConsoleFromMachineMetadata: vi.fn(() => undefined),
    }));
    vi.doMock('@/components/sessions/new/modules/profileHelpers', () => ({
        transformProfileToEnvironmentVars: vi.fn(() => ({})),
    }));
    vi.doMock('@/sync/runtime/time', () => ({
        nowServerMs: vi.fn(() => Date.now()),
    }));
    vi.doMock('@/sync/domains/automations/encodeAutomationTemplateCiphertextForAccount', () => ({
        encodeAutomationTemplateCiphertextForAccount: vi.fn(async ({ template }: { template: unknown }) => JSON.stringify(template)),
    }));
    vi.doMock('@/sync/api/account/apiAccountEncryptionMode', () => ({
        fetchAccountEncryptionMode: vi.fn(async () => ({ mode: 'plain', updatedAt: 0 })),
    }));
    vi.doMock('@/sync/domains/input/slashCommands/resolveSessionComposerSend', () => ({
        resolveSessionComposerSend: vi.fn(({ input }: { input: string }) => ({ kind: 'send', text: input })),
    }));
    vi.doMock('@/sync/domains/input/slashCommands/expandPromptTemplateInvocation', () => ({
        expandPromptTemplateInvocation: vi.fn(async () => 'expanded template'),
    }));
    vi.doMock('@/utils/errors/daemonUnavailableAlert', () => ({
        showDaemonUnavailableAlert: vi.fn(),
    }));
    vi.doMock('@/hooks/ui/useMountedRef', () => ({
        useMountedRef: vi.fn(() => ({ current: true })),
    }));
    vi.doMock('@/sync/domains/settings/terminalSettings', () => ({
        resolveTerminalSpawnOptions: vi.fn(() => null),
    }));
    vi.doMock('@/hooks/server/useMachineCapabilitiesCache', () => ({
        getMachineCapabilitiesSnapshot: vi.fn(() => ({ supported: true, response: { protocolVersion: 1, results: {} } })),
    }));
    vi.doMock('@/agents/catalog/catalog', async (importOriginal) => {
        const actual = await importOriginal<typeof import('@/agents/catalog/catalog')>();
        return {
            ...actual,
            getAgentCore: vi.fn(() => ({
                model: { supportsSelection: false },
                sessionModes: { kind: 'staticAgentModes' },
            })),
            buildSpawnEnvironmentVariablesFromUiState: vi.fn((opts: { environmentVariables?: Record<string, string> }) => opts.environmentVariables),
            getAgentResumeExperimentsFromSettings: vi.fn(() => ({})),
            getNewSessionPreflightIssues: vi.fn(() => []),
            buildResumeCapabilityOptionsFromUiState: vi.fn(() => ({})),
        };
    });
    vi.doMock('@/sync/ops', () => ({}));
    const { apiSocket } = await import('@/sync/api/session/apiSocket');
    // The network adapter is the boundary; Action policy and launch custody stay real.
    vi.spyOn(apiSocket, 'machineRPC').mockImplementation(async (_machineId, _method, input) => {
        sessionCreationRequestSpy(input);
        captured.value = {};
        throw new Error('Unexpected Session creation request');
    });
    vi.doMock('@/sync/runtime/orchestration/serverScopedRpc/followUpSpawnedSession', () => ({
        followUpSpawnedSessionWithServerScope: vi.fn(async () => configuredBackendHarnessModuleState.followUpPending),
    }));

    loadedUseCreateNewSessionOwner ??= (await import('./useCreateNewSession')).useCreateNewSession;
    const useCreateNewSessionOwner = loadedUseCreateNewSessionOwner;
    const useCreateNewSession: typeof useCreateNewSessionOwner = (params) => useCreateNewSessionOwner({
        ...params,
        draftScope: params.draftScope ?? { serverId: 'server-a', accountId: 'account-a' },
    });
    return {
        useCreateNewSession,
        captured,
        createdAutomationRecipe,
        routerReplaceSpy,
        storageState,
        storage,
        resolveFollowUp: () => resolveFollowUp?.(),
    };
}

// Load the production hook once during collection after the boundary mocks are installed.
// Re-importing its large graph inside every test consumed most of the per-test timeout before
// the behavior under test could run; all varying harness inputs are read through the hoisted state.
await setupHarness();

describe('useCreateNewSession configured ACP backend spawning', () => {
    beforeEach(() => {
        vi.resetModules();
        clearNewSessionDraftMock.mockClear();
        sessionCreationRequestSpy.mockReset();
    });

    afterEach(async () => {
        configuredBackendHarnessModuleState.sync?.disconnectServer();
        configuredBackendHarnessModuleState.sync = null;
        const { resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        resetRuntimeFetch();
        standardCleanup();
        vi.clearAllMocks();
    });

    it('fails closed without a private spawn when a configured backend target is unrepresentable', async () => {
        const { useCreateNewSession, captured } = await setupHarness();

        let handleCreateSession: null | (() => Promise<void>) = null;
        const settings = {
            experiments: false,
            lastUsedAgent: 'codex',
        } as unknown as Settings;
        const machineEnvPresence: UseMachineEnvPresenceResult = {
            isPreviewEnvSupported: false,
            isLoading: false,
            meta: {},
            refreshedAt: null,
            refresh: () => {},
        };

        function Test() {
            const hook = useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
                router: { push: vi.fn(), replace: vi.fn() },
                selectedMachineId: 'm1',
                selectedPath: '/tmp',
                selectedMachine: createMachineFixture({ id: 'm1' }),
                setIsCreating: vi.fn(),
                setIsResumeSupportChecking: vi.fn(),
                settings,
                useProfiles: false,
                selectedProfileId: null,
                profileMap: new Map(),
                recentMachinePaths: [],
                agentType: 'customAcp',
                backendTarget: {
                    kind: 'backend',
                    backendId: 'custom-kiro-preset',
                    configuredBackendId: 'custom-kiro-preset',
                    sourceKind: 'configured',
                },
                permissionMode: 'default' as PermissionMode,
                modelMode: 'default' as ModelMode,
                promptStore: createNewSessionPromptStore(''),
                resumeSessionId: '',
                agentNewSessionOptions: null,
                machineEnvPresence,
                secrets: [],
                secretBindingsByProfileId: {},
                selectedSecretIdByProfileIdByEnvVarName: {},
                sessionOnlySecretValueByProfileIdByEnvVarName: {},
                selectedMachineCapabilities: null,
                targetServerId: 'server-a',
                allowedTargetServerIds: ['server-a'],
            } as any);

            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));

        expect(handleCreateSession).toBeTruthy();
        await handleCreateSession!();

        expect(captured.value).toBeNull();
        expect(sessionCreationRequestSpy).not.toHaveBeenCalled();
        const { storage } = await import('@/sync/domains/state/storageStore');
        await vi.waitFor(() => expect(storage.getState().authoringMemory.recentMachinePaths).toEqual([{ machineId: 'm1', path: '/tmp' }]));
        expect(storage.getState().settings.lastUsedBackendTarget).toEqual({ kind: 'backend', backendId: 'custom-kiro-preset', configuredBackendId: 'custom-kiro-preset', sourceKind: 'configured' });
    });

    it('does not prepare account settings for an unrepresentable configured backend target', async () => {
        const { useCreateNewSession, captured } = await setupHarness();

        let handleCreateSession: null | (() => Promise<void>) = null;
        const settings = {
            experiments: false,
            lastUsedAgent: 'codex',
        } as unknown as Settings;
        const machineEnvPresence: UseMachineEnvPresenceResult = {
            isPreviewEnvSupported: false,
            isLoading: false,
            meta: {},
            refreshedAt: null,
            refresh: () => {},
        };

        function Test() {
            const hook = useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
                router: { push: vi.fn(), replace: vi.fn() },
                selectedMachineId: 'm1',
                selectedPath: '/tmp',
                selectedMachine: createMachineFixture({ id: 'm1' }),
                setIsCreating: vi.fn(),
                setIsResumeSupportChecking: vi.fn(),
                settings,
                useProfiles: false,
                selectedProfileId: null,
                profileMap: new Map(),
                recentMachinePaths: [],
                agentType: 'customAcp',
                backendTarget: {
                    kind: 'backend',
                    backendId: 'custom-kiro-preset',
                    configuredBackendId: 'custom-kiro-preset',
                    sourceKind: 'configured',
                },
                permissionMode: 'default' as PermissionMode,
                modelMode: 'default' as ModelMode,
                promptStore: createNewSessionPromptStore(''),
                resumeSessionId: '',
                agentNewSessionOptions: null,
                machineEnvPresence,
                secrets: [],
                secretBindingsByProfileId: {},
                selectedSecretIdByProfileIdByEnvVarName: {},
                sessionOnlySecretValueByProfileIdByEnvVarName: {},
                selectedMachineCapabilities: null,
                targetServerId: undefined,
                allowedTargetServerIds: ['server-a'],
            } as any);

            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));

        expect(handleCreateSession).toBeTruthy();
        await handleCreateSession!();

        expect(captured.value).toBeNull();
        expect(sessionCreationRequestSpy).not.toHaveBeenCalled();
        expect(captured.value).not.toEqual(expect.objectContaining({
            accountSettingsVersionHint: expect.any(Number),
        }));
    });

    it('retains recent-path selection while fail-closing an unrepresentable configured backend target', async () => {
        const { useCreateNewSession, captured } = await setupHarness();

        let handleCreateSession: null | (() => Promise<void>) = null;
        const settings = {
            experiments: false,
            lastUsedAgent: 'codex',
        } as unknown as Settings;
        const machineEnvPresence: UseMachineEnvPresenceResult = {
            isPreviewEnvSupported: false,
            isLoading: false,
            meta: {},
            refreshedAt: null,
            refresh: () => {},
        };

        function Test() {
            const hook = useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
                router: { push: vi.fn(), replace: vi.fn() },
                selectedMachineId: 'm1',
                selectedPath: '/tmp',
                selectedMachine: createMachineFixture({ id: 'm1' }),
                setIsCreating: vi.fn(),
                setIsResumeSupportChecking: vi.fn(),
                settings,
                useProfiles: false,
                selectedProfileId: null,
                profileMap: new Map(),
                recentMachinePaths: [
                    { machineId: 'm1', path: '/old/a' },
                    { machineId: 'm1', path: '/tmp' },
                    { machineId: 'm2', path: '/other' },
                ],
                agentType: 'customAcp',
                backendTarget: {
                    kind: 'backend',
                    backendId: 'custom-kiro-preset',
                    configuredBackendId: 'custom-kiro-preset',
                    sourceKind: 'configured',
                },
                permissionMode: 'default' as PermissionMode,
                modelMode: 'default' as ModelMode,
                promptStore: createNewSessionPromptStore(''),
                resumeSessionId: '',
                agentNewSessionOptions: null,
                machineEnvPresence,
                secrets: [],
                secretBindingsByProfileId: {},
                selectedSecretIdByProfileIdByEnvVarName: {},
                sessionOnlySecretValueByProfileIdByEnvVarName: {},
                selectedMachineCapabilities: null,
                targetServerId: undefined,
                allowedTargetServerIds: ['server-a'],
            } as any);

            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));

        expect(handleCreateSession).toBeTruthy();
        await handleCreateSession!();

        const { storage } = await import('@/sync/domains/state/storageStore');
        await vi.waitFor(() => expect(storage.getState().authoringMemory.recentMachinePaths).toEqual([
                { machineId: 'm1', path: '/tmp' },
                { machineId: 'm1', path: '/old/a' },
                { machineId: 'm2', path: '/other' },
            ]));
        expect(storage.getState().settings.lastUsedBackendTarget).toEqual({
                kind: 'backend',
                backendId: 'custom-kiro-preset',
                configuredBackendId: 'custom-kiro-preset',
                sourceKind: 'configured',
            });
        expect(captured.value).toBeNull();
        expect(sessionCreationRequestSpy).not.toHaveBeenCalled();
    });

    it('fails closed without private spawning for an unresolved plugin backend target', async () => {
        const { useCreateNewSession, captured } = await setupHarness();

        let handleCreateSession: null | (() => Promise<void>) = null;
        const settings = {
            experiments: false,
            lastUsedAgent: 'codex',
        } as unknown as Settings;
        const machineEnvPresence: UseMachineEnvPresenceResult = {
            isPreviewEnvSupported: false,
            isLoading: false,
            meta: {},
            refreshedAt: null,
            refresh: () => {},
        };

        function Test() {
            const hook = useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
                router: { push: vi.fn(), replace: vi.fn() },
                selectedMachineId: 'm1',
                selectedPath: '/tmp',
                selectedMachine: createMachineFixture({ id: 'm1' }),
                setIsCreating: vi.fn(),
                setIsResumeSupportChecking: vi.fn(),
                settings,
                useProfiles: false,
                selectedProfileId: null,
                profileMap: new Map(),
                recentMachinePaths: [],
                agentType: 'claude',
                backendTarget: {
                    kind: 'backend',
                    backendId: 'acme.review.backend',
                },
                spawnBackendTarget: {
                    kind: 'backend',
                    backendId: 'acme.review.backend',
                },
                permissionMode: 'default' as PermissionMode,
                modelMode: 'default' as ModelMode,
                promptStore: createNewSessionPromptStore(''),
                resumeSessionId: '',
                agentNewSessionOptions: null,
                machineEnvPresence,
                secrets: [],
                secretBindingsByProfileId: {},
                selectedSecretIdByProfileIdByEnvVarName: {},
                sessionOnlySecretValueByProfileIdByEnvVarName: {},
                selectedMachineCapabilities: null,
                targetServerId: undefined,
                allowedTargetServerIds: ['server-a'],
            } as any);

            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));

        expect(handleCreateSession).toBeTruthy();
        await handleCreateSession!();

        expect(captured.value).toBeNull();
        expect(sessionCreationRequestSpy).not.toHaveBeenCalled();
        const { storage } = await import('@/sync/domains/state/storageStore');
        await vi.waitFor(() => expect(storage.getState().authoringMemory.recentMachinePaths).toEqual([{ machineId: 'm1', path: '/tmp' }]));
        expect(storage.getState().settings.lastUsedBackendTarget).toEqual({ kind: 'backend', backendId: 'acme.review.backend' });
    });

    it('does not save an automation for an unrepresentable configured ACP target', async () => {
        const { useCreateNewSession, createdAutomationRecipe } = await setupHarness();

        let handleCreateSession: null | (() => Promise<void>) = null;
        const settings = {
            experiments: false,
            lastUsedAgent: 'codex',
        } as unknown as Settings;
        const machineEnvPresence: UseMachineEnvPresenceResult = {
            isPreviewEnvSupported: false,
            isLoading: false,
            meta: {},
            refreshedAt: null,
            refresh: () => {},
        };

        function Test() {
            const hook = useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
                router: { push: vi.fn(), replace: vi.fn() },
                selectedMachineId: 'm1',
                selectedPath: '/tmp',
                selectedMachine: createMachineFixture({ id: 'm1' }),
                setIsCreating: vi.fn(),
                setIsResumeSupportChecking: vi.fn(),
                settings,
                useProfiles: false,
                selectedProfileId: null,
                profileMap: new Map(),
                recentMachinePaths: [],
                agentType: 'customAcp',
                backendTarget: {
                    kind: 'backend',
                    backendId: 'custom-kiro-preset',
                    configuredBackendId: 'custom-kiro-preset',
                    sourceKind: 'configured',
                },
                permissionMode: 'default' as PermissionMode,
                modelMode: 'default' as ModelMode,
                promptStore: createNewSessionPromptStore(''),
                resumeSessionId: '',
                agentNewSessionOptions: null,
                machineEnvPresence,
                secrets: [],
                secretBindingsByProfileId: {},
                selectedSecretIdByProfileIdByEnvVarName: {},
                sessionOnlySecretValueByProfileIdByEnvVarName: {},
                selectedMachineCapabilities: null,
                targetServerId: undefined,
                allowedTargetServerIds: ['server-a'],
                authoringDraft: buildNewSessionAuthoringDraft({
                    executionTarget: null,
                    organizationPlacement: { folderId: null, tagIds: [] },
                    directory: '/tmp',
                    checkoutCreationDraft: null,
                    prompt: '',
                    displayText: '',
                    agentTarget: null,
                    transcriptStorage: null,
                    profileId: null,
                    environmentVariables: null,
                    resumeSessionId: null,
                    permissionMode: 'default',
                    permissionModeUpdatedAt: null,
                    modelId: null,
                    modelUpdatedAt: null,
                    mcpSelection: null,
                    connectedServices: null,
                    terminal: null,
                    windowsRemoteSessionLaunchMode: null,
                    windowsRemoteSessionConsole: null,
                    acpSessionModeId: null,
                    sessionConfigOptionOverrides: null,
                    automation: {
                        pendingAutomationId: 'automation-configured-backend',
                        enabled: true,
                        name: 'Nightly',
                        description: '',
                        triggers: [{
                            clientId: 'trigger-configured-backend',
                            definition: {
                                kind: 'schedule',
                                enabled: true,
                                schedule: {
                                    kind: 'interval',
                                    everyMs: 60 * 60_000,
                                    scheduleExpr: null,
                                    timezone: null,
                                },
                            },
                        }],
                    },
                }),
            } as any);

            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));

        expect(handleCreateSession).toBeTruthy();
        await handleCreateSession!();

        expect(createdAutomationRecipe.value).toBeNull();
        expect(sessionCreationRequestSpy).not.toHaveBeenCalled();
    });

    it('retains the configured backend selection state when only legacy customAcp carriers remain', async () => {
        const { useCreateNewSession } = await setupHarness();

        let handleCreateSession: null | (() => Promise<void>) = null;
        const settings = {
            experiments: false,
            lastUsedAgent: 'customAcp',
        } as unknown as Settings;
        const machineEnvPresence: UseMachineEnvPresenceResult = {
            isPreviewEnvSupported: false,
            isLoading: false,
            meta: {},
            refreshedAt: null,
            refresh: () => {},
        };

        function Test() {
            const hook = useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
                router: { push: vi.fn(), replace: vi.fn() },
                selectedMachineId: 'm1',
                selectedPath: '/tmp',
                selectedMachine: createMachineFixture({ id: 'm1' }),
                setIsCreating: vi.fn(),
                setIsResumeSupportChecking: vi.fn(),
                settings,
                useProfiles: false,
                selectedProfileId: null,
                profileMap: new Map(),
                recentMachinePaths: [],
                agentType: 'customAcp',
                backendTarget: {
                    kind: 'backend',
                    backendId: 'review-bot',
                    configuredBackendId: 'review-bot',
                    sourceKind: 'configured',
                },
                permissionMode: 'default' as PermissionMode,
                modelMode: 'default' as ModelMode,
                promptStore: createNewSessionPromptStore(''),
                resumeSessionId: '',
                agentNewSessionOptions: null,
                machineEnvPresence,
                secrets: [],
                secretBindingsByProfileId: {},
                selectedSecretIdByProfileIdByEnvVarName: {},
                sessionOnlySecretValueByProfileIdByEnvVarName: {},
                selectedMachineCapabilities: null,
                targetServerId: undefined,
                allowedTargetServerIds: ['server-a'],
            } as any);

            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));

        expect(handleCreateSession).toBeTruthy();
        await handleCreateSession!();

        const { storage } = await import('@/sync/domains/state/storageStore');
        await vi.waitFor(() => expect(storage.getState().authoringMemory.recentMachinePaths).toEqual([{ machineId: 'm1', path: '/tmp' }]));
        expect(storage.getState().settings.lastUsedBackendTarget).toEqual({ kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot', sourceKind: 'configured' });
    });

    it('does not enter the private first-turn follow-up path for an unrepresentable configured target', async () => {
        const {
            useCreateNewSession,
            routerReplaceSpy,
            resolveFollowUp,
            captured,
            storageState,
        } = await setupHarness({
            deferFollowUp: true,
            spawnSuccess: true,
        });

        let handleCreateSession: null | (() => Promise<void>) = null;
        const disableDraftPersistence = vi.fn();
        const settings = {
            experiments: false,
            lastUsedAgent: 'codex',
        } as unknown as Settings;
        const machineEnvPresence: UseMachineEnvPresenceResult = {
            isPreviewEnvSupported: false,
            isLoading: false,
            meta: {},
            refreshedAt: null,
            refresh: () => {},
        };

        function Test() {
            const hook = useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
                router: { push: vi.fn(), replace: routerReplaceSpy },
                selectedMachineId: 'm1',
                selectedPath: '/tmp',
                selectedMachine: createMachineFixture({ id: 'm1' }),
                setIsCreating: vi.fn(),
                setIsResumeSupportChecking: vi.fn(),
                settings,
                useProfiles: false,
                selectedProfileId: null,
                profileMap: new Map(),
                recentMachinePaths: [],
                agentType: 'customAcp',
                backendTarget: {
                    kind: 'backend',
                    backendId: 'custom-kiro-preset',
                    configuredBackendId: 'custom-kiro-preset',
                    sourceKind: 'configured',
                },
                permissionMode: 'default' as PermissionMode,
                modelMode: 'default' as ModelMode,
                promptStore: createNewSessionPromptStore('launch the session'),
                resumeSessionId: '',
                agentNewSessionOptions: null,
                machineEnvPresence,
                secrets: [],
                secretBindingsByProfileId: {},
                selectedSecretIdByProfileIdByEnvVarName: {},
                sessionOnlySecretValueByProfileIdByEnvVarName: {},
                selectedMachineCapabilities: null,
                targetServerId: undefined,
                allowedTargetServerIds: ['server-a'],
                disableDraftPersistence,
            } as any);

            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));

        expect(handleCreateSession).toBeTruthy();
        const createPromise = handleCreateSession!();
        for (let attempt = 0; attempt < 40; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 25));
        }

        expect(captured.value).toBeNull();
        expect(sessionCreationRequestSpy).not.toHaveBeenCalled();
        expect(routerReplaceSpy).not.toHaveBeenCalled();
        expect(storageState.sessionPending).toEqual({});
        expect(clearNewSessionDraftMock).not.toHaveBeenCalled();
        expect(disableDraftPersistence).not.toHaveBeenCalled();

        resolveFollowUp();
        await createPromise;

        expect(storageState.sessionPending).toEqual({});
        expect(routerReplaceSpy).not.toHaveBeenCalled();
        expect(clearNewSessionDraftMock).not.toHaveBeenCalled();
        expect(disableDraftPersistence).not.toHaveBeenCalled();
    });

    it('does not enter route hydration for an unrepresentable configured backend target', async () => {
        const {
            useCreateNewSession,
            routerReplaceSpy,
            resolveFollowUp,
            captured,
            storageState,
        } = await setupHarness({
            deferFollowUp: true,
            spawnSuccess: true,
        });
        let handleCreateSession: null | (() => Promise<void>) = null;
        const settings = {
            experiments: false,
            lastUsedAgent: 'codex',
        } as unknown as Settings;
        const machineEnvPresence: UseMachineEnvPresenceResult = {
            isPreviewEnvSupported: false,
            isLoading: false,
            meta: {},
            refreshedAt: null,
            refresh: () => {},
        };

        function Test() {
            const hook = useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
                router: { push: vi.fn(), replace: routerReplaceSpy },
                selectedMachineId: 'm1',
                selectedPath: '/tmp',
                selectedMachine: createMachineFixture({ id: 'm1' }),
                setIsCreating: vi.fn(),
                setIsResumeSupportChecking: vi.fn(),
                settings,
                useProfiles: false,
                selectedProfileId: null,
                profileMap: new Map(),
                recentMachinePaths: [],
                agentType: 'customAcp',
                backendTarget: {
                    kind: 'backend',
                    backendId: 'custom-kiro-preset',
                    configuredBackendId: 'custom-kiro-preset',
                    sourceKind: 'configured',
                },
                permissionMode: 'default' as PermissionMode,
                modelMode: 'default' as ModelMode,
                promptStore: createNewSessionPromptStore('launch the session'),
                resumeSessionId: '',
                agentNewSessionOptions: null,
                machineEnvPresence,
                secrets: [],
                secretBindingsByProfileId: {},
                selectedSecretIdByProfileIdByEnvVarName: {},
                sessionOnlySecretValueByProfileIdByEnvVarName: {},
                selectedMachineCapabilities: null,
                targetServerId: 'server-a',
                allowedTargetServerIds: ['server-a'],
            } as any);

            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));

        expect(handleCreateSession).toBeTruthy();
        const createPromise = handleCreateSession!();
        for (let attempt = 0; attempt < 40; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 25));
        }

        expect(routerReplaceSpy).not.toHaveBeenCalled();
        expect(storageState.sessionPending).toEqual({});

        resolveFollowUp();
        await createPromise;

        expect(captured.value).toBeNull();
        expect(sessionCreationRequestSpy).not.toHaveBeenCalled();
        expect(storageState.sessions).toEqual({});
        expect(storageState.sessionPending).toEqual({});
        expect(routerReplaceSpy).not.toHaveBeenCalled();
    });
});
