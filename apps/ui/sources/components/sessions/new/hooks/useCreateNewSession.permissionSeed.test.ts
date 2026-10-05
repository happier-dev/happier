import 'fake-indexeddb/auto';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import React from 'react';
import { createAuthoringMemoryHttpBoundary } from '@/dev/testkit/mocks/authoringMemoryHttp';
import { createNewSessionPromptStore } from '@/components/sessions/new/hooks/screenModel/newSessionPromptStore';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { buildNewSessionAuthoringDraft } from '@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters';
import type { PermissionMode, ModelMode } from '@/sync/domains/permissions/permissionTypes';
import type { Settings } from '@/sync/domains/settings/settings';
import type { NewSessionAutomationDraft } from '@/sync/domains/automations/automationDraft';
import type { UseMachineEnvPresenceResult } from '@/hooks/machine/useMachineEnvPresence';
import { normalizeSessionAuthoringConnectedServices } from '@/sync/domains/sessionAuthoring/sessionAuthoringNormalization';
import {
    buildBackendTargetKey,
    buildBackendTargetKeyV2,
    buildQualifiedPluginContributionKey,
    buildMentionRefForKindV1,
    MENTION_KIND_V1,
    MACHINE_PLAIN_DATA_KEY_MARKER,
    SessionModelSelectionV1Schema,
    SessionSpawnNewInputV2Schema,
    type SessionMcpSelectionV1,
    type SessionSpawnNewInputV2,
    type SessionSpawnNewResultV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { AIBackendProfileSchema } from '@/sync/domains/profiles/profileCompatibility';
import { renderScreen } from '@/dev/testkit';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import type { AutomationEditorDraft } from '@/sync/domains/automations/automationEditorDraft';
import type { ServerScopedMachineRpcParams } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes';
import type {
    HandleCreateSessionOptions,
    NewSessionAfterCreatedSettlement,
} from './useCreateNewSession';

import { installNewSessionScreenModelCommonModuleMocks, selectNewSessionTestHome } from './newSessionScreenModelTestHelpers';

const ANTHROPIC_CONNECTED_ACCOUNT_KEY = buildQualifiedPluginContributionKey({
    pluginId: 'happier.agent.claude',
    localId: 'anthropic',
});
const GITHUB_CONNECTED_ACCOUNT_KEY = buildQualifiedPluginContributionKey({
    pluginId: 'happier.scm.forge.github',
    localId: 'github-account',
});


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function invokeHandleCreateSession(
    handleCreateSession: null | ((options?: HandleCreateSessionOptions) => void),
    options?: HandleCreateSessionOptions,
): Promise<void> {
    // The UI handler intentionally exposes a void callback to production callers,
    // while its async implementation remains observable to this hook test.
    await Promise.resolve(handleCreateSession?.(options));
}

const routerSearchParamsState = vi.hoisted(() => ({
    value: {} as Record<string, string | string[] | undefined>,
}));
const syncSingletonBridge = vi.hoisted(() => ({
    current: null as typeof import('@/sync/sync').sync | null,
}));
vi.mock('@/sync/runtime/getSyncSingleton', () => ({
    getSyncSingleton: () => {
        if (!syncSingletonBridge.current) throw new Error('Test Sync singleton is not loaded');
        return syncSingletonBridge.current;
    },
}));

type SpawnPayloadCapture = SessionSpawnNewInputV2 | null;
type SessionSpawnNewRpcRequest = ServerScopedMachineRpcParams<SessionSpawnNewInputV2>;
type SessionSpawnNewSuccessResult = Extract<SessionSpawnNewResultV1, Readonly<{ type: 'success' }>>;

type AutomationEditorSaveCapture = AutomationEditorDraft | null;

function createCompatibleTestProfile(id = 'profile-test') {
    return AIBackendProfileSchema.parse({
        id,
        name: 'Profile Test',
        description: undefined,
        environmentVariables: [],
        envVarRequirements: [],
        compatibility: {},
        defaultPermissionModeByAgent: {},
        defaultPermissionModeByTargetKey: {},
        defaultPersistenceModeByAgent: {},
        defaultPersistenceModeByTargetKey: {},
        compatibilityByTargetKey: {
            [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'codex' })]: true,
        },
        isBuiltIn: false,
        createdAt: 1,
        updatedAt: 1,
        version: '1.0.0',
    });
}

function createScheduleAutomationDraft(params: Readonly<{
    name: string;
    description?: string;
    everyMinutes?: number;
}>): NewSessionAutomationDraft {
    return {
        pendingAutomationId: 'automation-11111111-1111-4111-8111-111111111111',
        enabled: true,
        name: params.name,
        description: params.description ?? '',
        triggers: [{
            clientId: '22222222-2222-4222-8222-222222222222',
            definition: {
                kind: 'schedule',
                enabled: true,
                schedule: {
                    kind: 'interval',
                    everyMs: (params.everyMinutes ?? 15) * 60_000,
                    scheduleExpr: null,
                    timezone: null,
                },
            },
        }],
    };
}

function buildAutomationAuthoringDraft(params: Readonly<{
    prompt: string;
    modelMode: ModelMode;
    permissionMode: PermissionMode;
    permissionModeUpdatedAt?: number | null;
    automation: NewSessionAutomationDraft;
    connectedServices?: unknown;
    mcpSelection?: SessionMcpSelectionV1 | null;
    transcriptStorage?: 'persisted' | 'direct' | null;
    checkoutCreationDraft?: {
        kind: 'git_worktree';
        displayName: string;
        baseRef: string | null;
    } | null;
    acpSessionModeId?: string | null;
}>){
    return buildNewSessionAuthoringDraft({
        executionTarget: null,
        directory: '/tmp',
        checkoutCreationDraft: params.checkoutCreationDraft ?? null,
        organizationPlacement: { folderId: null, tagIds: [] },
        prompt: params.prompt,
        displayText: params.prompt,
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        transcriptStorage: params.transcriptStorage ?? null,
        profileId: null,
        environmentVariables: null,
        resumeSessionId: null,
        permissionMode: params.permissionMode,
        permissionModeUpdatedAt: params.permissionModeUpdatedAt ?? null,
        modelId: params.modelMode === 'default' ? null : params.modelMode,
        modelUpdatedAt: null,
        mcpSelection: params.mcpSelection ?? null,
        connectedServices: normalizeSessionAuthoringConnectedServices(params.connectedServices ?? null),
        terminal: null,
        windowsRemoteSessionLaunchMode: null,
        windowsRemoteSessionConsole: null,
        acpSessionModeId: params.acpSessionModeId ?? null,
        sessionConfigOptionOverrides: null,
        automation: params.automation,
    });
}

async function createUseCreateNewSessionHarness(accountMode: 'plain' | 'e2ee' = 'e2ee') {
    const accountId = accountMode === 'plain' ? 'account-plain' : 'account-a';
    const captured: { value: SpawnPayloadCapture } = { value: null };
    const sessionSpawnNewRpcRequest: { value: SessionSpawnNewRpcRequest | null } = { value: null };
    let scopeStorage: (typeof import('@/sync/domains/state/storageStore'))['storage'];
    const modalAlertSpy = vi.fn((..._args: unknown[]) => {});
    const modalConfirmSpy = vi.fn(async () => false);
    const captureSessionSpawnNewRequest = (request: SessionSpawnNewRpcRequest): void => {
        sessionSpawnNewRpcRequest.value = request;
        captured.value = request.payload;
    };
    const sessionSpawnNewRpcSpy = vi.fn(async (request: SessionSpawnNewRpcRequest): Promise<SessionSpawnNewResultV1> => {
        captureSessionSpawnNewRequest(request);
        return { type: 'error', code: 'spawn_failed', retryable: false };
    });
    const mockSessionSpawnSuccess = (sessionId: string): void => {
        sessionSpawnNewRpcSpy.mockImplementationOnce(async (
            request: SessionSpawnNewRpcRequest,
        ): Promise<SessionSpawnNewSuccessResult> => {
            captureSessionSpawnNewRequest(request);
            scopeStorage.getState().applySessions([createSessionFixture({
                id: sessionId,
                encryptionMode: 'plain',
                serverId: request.payload.executionTarget.serverId,
            })]);
            return {
                type: 'success',
                disposition: 'created',
                sessionId,
                executionTarget: request.payload.executionTarget,
                organizationPlacement: request.payload.organizationPlacement ?? { folderId: null, tagIds: [] },
                initialInput: request.payload.initialInput
                    ? { status: 'accepted', localId: `input-${sessionId}` }
                    : { status: 'notRequested' },
            };
        });
    };
    const machineBashSpy = vi.fn<(...args: unknown[]) => Promise<{
        success: boolean;
        stderr: string;
        stdout: string;
        exitCode: number;
    }>>(async () => ({
        success: true,
        stderr: '',
        stdout: '',
        exitCode: 0,
    }));
    let lastCreatedAutomation: Record<string, unknown> | null = null;
    const authoringMemoryHttp = createAuthoringMemoryHttpBoundary();
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const authoringResponse = await authoringMemoryHttp.handle(input, init);
        if (authoringResponse) return authoringResponse;
        const url = String(input instanceof Request ? input.url : input);
        const method = input instanceof Request ? input.method : (init?.method ?? 'GET');
        if (url.endsWith('/health')) {
            return Response.json({ status: 'ok' });
        }
        if (url.endsWith('/v1/auth/ping')) {
            return Response.json({ ok: true });
        }
        if (url.endsWith('/v1/machines/m1')) {
            return Response.json({ machine: { id: 'm1', kind: 'persistent', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } });
        }
        if (url.endsWith('/v1/account/encryption')) {
            return Response.json({ mode: accountMode, updatedAt: 1 });
        }
        if (url.endsWith('/v2/account/settings') && method === 'GET') {
            return Response.json({ content: null, version: 1 });
        }
        if (url.includes('/v3/automations?')) {
            const automation = lastCreatedAutomation
                ? (() => {
                    const { executionRecipe: _recipe, triggers, ...summary } = lastCreatedAutomation;
                    return {
                        ...summary,
                        triggers: (triggers as ReadonlyArray<Record<string, unknown>>).map((trigger) => {
                            const { triggerDefinitionEnvelope: _privateEnvelope, ...publicTrigger } = trigger;
                            return publicTrigger;
                        }),
                    };
                })()
                : null;
            return Response.json({
                automations: automation ? [automation] : [],
                nextCursor: null,
            });
        }
        if (url.endsWith('/v3/automations') && method === 'POST') {
            const body = input instanceof Request
                ? await input.clone().text()
                : String(init?.body ?? '{}');
            const request = JSON.parse(body) as Record<string, any>;
            const createdAt = 1_786_257_600_000;
            const executionRecipe = request.executionRecipe as Record<string, any>;
            const target = executionRecipe.target as Record<string, any>;
            const created = {
                id: request.automationId,
                name: request.name,
                description: request.description ?? null,
                enabled: request.enabled,
                targetType: target.kind,
                existingSessionId: target.kind === 'existingSession' ? target.sessionId : null,
                templateVersion: executionRecipe.templateVersion,
                lastRunAt: null,
                createdAt,
                updatedAt: createdAt,
                assignments: (request.assignments ?? []).map((assignment: Record<string, unknown>) => ({
                    ...assignment,
                    enabled: assignment.enabled ?? true,
                    priority: assignment.priority ?? 0,
                    updatedAt: createdAt,
                })),
                executionRecipe,
                triggers: (request.triggers ?? []).map((entry: Record<string, any>) => ({
                    id: entry.triggerId,
                    revision: 0,
                    enabled: entry.trigger.enabled,
                    createdAt,
                    updatedAt: createdAt,
                    ...entry.trigger,
                    nextRunAt: null,
                    triggerDefinitionEnvelope: null,
                })),
            };
            lastCreatedAutomation = created;
            return Response.json(created);
        }
        return Response.json({ error: 'not_found' }, { status: 404 });
    });

    installNewSessionScreenModelCommonModuleMocks({
        // The default testkit translate renders `key(param=value)`, so an alert
        // that names WHICH reference it refused stays observable here. A key
        // called without params still renders as the bare key.
        text: () => createTextModuleMock(),
        modal: async () => ({
            Modal: {
                alert: modalAlertSpy,
                confirm: modalConfirmSpy,
            },
        }),
        routerConfig: {
            router: {
                push: vi.fn(),
                replace: vi.fn(),
                back: vi.fn(),
                setParams: vi.fn(),
            },
            params: () => routerSearchParamsState.value,
            navigation: {},
            pathname: '/new',
        },
    });
    vi.stubGlobal('fetch', fetchSpy);
    const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    setRuntimeFetch(fetchSpy);
    vi.doUnmock('@/sync/domains/state/storage');
    vi.doUnmock('@/sync/domains/state/persistence');
    const persistence = await import('@/sync/domains/state/persistence');
    const clearNewSessionDraftSpy = vi.spyOn(persistence, 'clearNewSessionDraft');
    const saveSessionDraftsSpy = vi.spyOn(persistence, 'saveSessionDrafts');
    await selectNewSessionTestHome();
    ({ storage: scopeStorage } = await import('@/sync/domains/state/storageStore'));
    // Automation authoring captures the same canonical Account lifetime that owns
    // stored-content availability. The test server and credential fixtures
    // above are both for server-a/account-a, so mount that scope through the
    // incumbent store owner instead of registering a test-only reader.
    scopeStorage.getState().activateProfileScope({ serverId: 'server-a', accountId });
    scopeStorage.getState().activateSettingsScope({ serverId: 'server-a', accountId });
    scopeStorage.getState().applySettings(scopeStorage.getState().settings, 1);
    scopeStorage.getState().applyMachines([createMachineFixture({ id: 'm1' })], true, { sourceServerId: 'server-a' });
    const upsertPendingMessageSpy = vi.spyOn(scopeStorage.getState(), 'upsertPendingMessage');
    const markSessionOptimisticThinkingSpy = vi.spyOn(scopeStorage.getState(), 'markSessionOptimisticThinking');
    const { sync } = await import('@/sync/syncEngine');
    syncSingletonBridge.current = sync;
    const secret = new Uint8Array(32).fill(7);
    const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    const credentials = accountMode === 'plain' ? { token } : { token, secret: Buffer.from(secret).toString('base64url') };
    await sync.switchServer(credentials);
    scopeStorage.getState().applySettings(scopeStorage.getState().settings, 1);
    scopeStorage.getState().applyMachines([createMachineFixture({ id: 'm1' })], true, { sourceServerId: 'server-a' });
    // Scheduled Automation persistence uses the real Account-encryption reader,
    // which in turn uses the canonical reachability-supervised fetch boundary.
    // Retain the same Home lifetime a mounted application would own so those
    // tests exercise the real writer without waiting for an absent app shell.
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    const activeHome = getActiveServerSnapshot();
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const saveHomeCredentials = async () => {
        expect(await TokenStorage.setCredentialsForServerUrl(activeHome.serverUrl, {
            serverId: activeHome.serverId,
        }, credentials)).toBe(true);
    };
    await saveHomeCredentials();
    const {
        acquireServerReachabilitySupervisor,
        peekServerReachabilityState,
        waitForServerReachable,
    } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
    const reachabilityLease = await acquireServerReachabilitySupervisor({
        serverUrl: activeHome.serverUrl,
        token,
    });
    await waitForServerReachable({
        serverUrl: activeHome.serverUrl,
        token,
        timeoutMs: 1_000,
    });
    // Session creation tests substitute daemon/network I/O. Once the mocked
    // spawn has projected its Session into the canonical store, the route
    // hydration boundary must report that same projection as available rather
    // than starting a real reachability-supervised HTTP read.
    vi.spyOn(sync, 'ensureSessionVisibleForMessageRoute').mockImplementation(async (sessionId) => (
        scopeStorage.getState().sessions[sessionId]
            ? { kind: 'available' as const, sessionId }
            : { kind: 'missing' as const, sessionId, cause: 'not_found' as const }
    ));
    const saveAutomationEditorDraftSpy = vi.spyOn(sync, 'saveAutomationEditorDraft');
    const refreshAutomationsSpy = vi.spyOn(sync, 'refreshAutomations');
    const syncSendMessageSpy = vi.spyOn(sync, 'sendMessage');
    const automationCaptured: { readonly value: AutomationEditorSaveCapture } = {
        get value() {
            return saveAutomationEditorDraftSpy.mock.calls.at(-1)?.[0] ?? null;
        },
    };
    // The daemon transport is the boundary; Action dispatch and local launch custody stay real.
    const { apiSocket } = await import('@/sync/api/session/apiSocket');
    vi.spyOn(apiSocket, 'machineRPC').mockImplementation(async (machineId, method, input) => {
        if (method === 'bash') {
            const request = input as Readonly<{ command?: string; argv?: readonly string[]; cwd: string }>;
            return await machineBashSpy(machineId, request, request.cwd, { serverId: 'server-a' });
        }
        const payload = SessionSpawnNewInputV2Schema.parse(input);
        return await sessionSpawnNewRpcSpy({
            serverId: payload.executionTarget.serverId,
            machineId,
            method,
            payload,
        });
    });
    const { createSocketIoBoundaryStub } = await import('@/dev/testkit/mocks/socketIo');
    const socketFactory = await import('@/sync/runtime/orchestration/serverScopedRpc/createEphemeralServerSocketClient');
    // The remote socket is the network boundary; scoped credential/encryption/RPC owners stay real.
    vi.spyOn(socketFactory, 'createEphemeralServerSocketClient').mockImplementation(async () => {
        const { socket } = createSocketIoBoundaryStub();
        socket.emitWithAck.mockImplementation(async (event, input) => {
            expect(event).toBe('rpc-call');
            // This remote-server fixture receives the canonical plain Socket RPC envelope.
            const request = input as Readonly<{ method: string; params: unknown }>;
            expect(request.method).toBe(`m1:${RPC_METHODS.SESSION_SPAWN_NEW}`);
            const payload = SessionSpawnNewInputV2Schema.parse(request.params);
            const result = await sessionSpawnNewRpcSpy({
                serverId: payload.executionTarget.serverId, machineId: 'm1',
                method: RPC_METHODS.SESSION_SPAWN_NEW, payload,
            });
            return { ok: true, result };
        });
        // The real pool returns an acquired, connected socket to the RPC owner.
        socket.connect();
        return { ...socket, getSocketId: () => socket.id };
    });
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const { executeSessionSpawnNewAction } = await import('@/sync/ops/actions/sessionSpawnNewAction');
    const { NewSessionEmbeddedHostProvider } = await import('../navigation/newSessionHost');
    const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
    const actionExecutor = createDefaultActionExecutor();
    const spawnActions: Array<Awaited<ReturnType<typeof executeSessionSpawnNewAction>>> = [];
    const { useCreateNewSession: useCreateNewSessionOwner } = await import('./useCreateNewSession');
    type UseCreateNewSessionTestParams = Omit<Parameters<typeof useCreateNewSessionOwner>[0], 'resolveSavedSecretReference'> & Readonly<{
        resolveSavedSecretReference?: Parameters<typeof useCreateNewSessionOwner>[0]['resolveSavedSecretReference'];
    }>;
    const useCreateNewSession = (params: UseCreateNewSessionTestParams) => useCreateNewSessionOwner({
        ...params,
        draftScope: params.draftScope ?? { serverId: 'server-a', accountId },
        resolveSavedSecretReference: params.resolveSavedSecretReference ?? ((ref) => {
            const secret = params.secrets.find((candidate) => candidate.id === ref) ?? null;
            return {
                ref,
                kind: 'personal' as const,
                status: secret ? 'ready' as const : 'temporarily_unavailable' as const,
                entry: null,
                secret,
                revision: secret ? 1 : null,
                fingerprint: secret ? `test:${ref}` : null,
            };
        }),
    });
    const initialStore = scopeStorage.getState();
    const defaultSpawn = sessionSpawnNewRpcSpy.getMockImplementation()!;
    return {
        async reset() {
            syncSingletonBridge.current = sync;
            authoringMemoryHttp.reset();
            captured.value = null;
            spawnActions.length = 0;
            sessionSpawnNewRpcRequest.value = null;
            lastCreatedAutomation = null;
            sessionSpawnNewRpcSpy.mockReset().mockImplementation(defaultSpawn);
            saveAutomationEditorDraftSpy.mockClear();
            refreshAutomationsSpy.mockClear();
            syncSendMessageSpy.mockClear();
            scopeStorage.setState({ ...initialStore, sessions: {}, sessionPending: {} });
            const { actionOperationStore } = await import('@/sync/domains/actionOperations/actionOperationStore');
            actionOperationStore.reset();
            vi.stubGlobal('fetch', fetchSpy);
            setRuntimeFetch(fetchSpy);
            await selectNewSessionTestHome();
            await saveHomeCredentials();
            await sync.switchServer(credentials);
            scopeStorage.getState().applySettings(
                scopeStorage.getState().settings,
                Math.max(scopeStorage.getState().settingsVersion ?? 0, 1),
            );
            scopeStorage.getState().applyMachines([createMachineFixture({ id: 'm1' })], true, { sourceServerId: 'server-a' });
            // The shared Vitest setup resets `runtimeFetch` and unstubs `fetch`
            // after every test, while the retained reachability supervisor above
            // keeps probing through that boundary. Re-arm it before each test so a
            // real-owner write (scheduled Automation persistence) reaches this
            // fixture instead of the platform network, which would first mark
            // server-a unreachable and then burn the full reachability wait.
            vi.stubGlobal('fetch', fetchSpy);
            setRuntimeFetch(fetchSpy);
            expect(peekServerReachabilityState(activeHome.serverUrl, token)?.phase).toBe('online');
        },
        useCreateNewSession,
        renderWithActionExecutor: async (children: React.ReactElement) => await renderScreen(
            React.createElement(InjectedAuthProvider, {
                credentials,
                children: React.createElement(NewSessionEmbeddedHostProvider, {
                    host: {
                        params: {}, setParams() {}, openDraft() {}, onHandedOff() {}, demanded: true,
                        // Exercise real Action admission; only replace the bundler-only lazy module load.
                        executeSpawnAction: async (input, context) => {
                            const result = await executeSessionSpawnNewAction(input, context, actionExecutor);
                            spawnActions.push(result);
                            return result;
                        },
                    },
                    children,
                }),
            }),
        ),
        spawnActions,
        storage: scopeStorage,
        setLocalSearchParams(nextParams: Record<string, string | string[] | undefined>) {
            routerSearchParamsState.value = { ...nextParams };
        },
        captured,
        automationCaptured,
        saveAutomationEditorDraftSpy,
        modalAlertSpy,
        modalConfirmSpy,
        clearNewSessionDraftSpy,
        refreshAutomationsSpy,
        upsertPendingMessageSpy,
        markSessionOptimisticThinkingSpy,
        saveSessionDraftsSpy,
        syncSendMessageSpy,
        sessionSpawnNewRpcSpy,
        sessionSpawnNewRpcRequest,
        mockSessionSpawnSuccess,
        machineBashSpy,
        automationTemplateEncryption: sync.encryption!,
        dispose: async () => await reachabilityLease.release(),
    };
}

let harness: Awaited<ReturnType<typeof createUseCreateNewSessionHarness>> | null = null;
async function setupUseCreateNewSessionHarness() {
    if (!harness) {
        throw new Error('useCreateNewSession permission harness was not initialized');
    }
    await harness.reset();
    return harness;
}

describe('useCreateNewSession permission seeding', () => {
    beforeAll(async () => { harness = await createUseCreateNewSessionHarness(); });
    afterAll(async () => {
        await harness?.dispose();
        harness = null;
        syncSingletonBridge.current = null;
        const { resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        resetRuntimeFetch();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });
    beforeEach(() => {
        routerSearchParamsState.value = {};
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it.each(['server', 'acp'] as const)('launches OpenCode %s with strict configuration instead of raw environment', async (mode) => {
        const launchHarness = await createUseCreateNewSessionHarness('plain');
        await launchHarness.reset();
        const { useCreateNewSession, captured, storage, renderWithActionExecutor, spawnActions, modalAlertSpy } = launchHarness;
        let handleCreateSession: (() => Promise<void>) | null = null;
        const telemetry = await import('@/utils/system/sentry');
        const errors = vi.spyOn(telemetry, 'captureExceptionIfEnabled');
        function Test() {
            const hook = useCreateNewSession({
                launchIntentSignature: `opencode-${mode}`,
                router: { push: vi.fn(), replace: vi.fn() },
                selectedMachineId: 'm1', selectedPath: '/tmp',
                selectedMachine: createMachineFixture({ id: 'm1' }),
                setIsCreating: vi.fn(), setIsResumeSupportChecking: vi.fn(),
                settings: storage.getState().settings,
                pluginSettings: { account: {
                    opencodeBackendMode: mode,
                    opencodeServerBaseUrlByServerIdV1: { 'server-a': 'https://opencode.example.test/path' },
                } },
                pluginSettingsReadiness: { ready: true, settled: true, loading: false, error: null },
                useProfiles: false, selectedProfileId: null, profileMap: new Map(), recentMachinePaths: [],
                agentType: 'opencode', permissionMode: 'default', modelMode: 'default',
                promptStore: createNewSessionPromptStore('hello'), resumeSessionId: '', agentNewSessionOptions: null,
                machineEnvPresence: { isPreviewEnvSupported: false, isLoading: false, meta: {}, refreshedAt: null, refresh: () => {} },
                secrets: [], secretBindingsByProfileId: {}, selectedSecretIdByProfileIdByEnvVarName: {},
                sessionOnlySecretValueByProfileIdByEnvVarName: {}, selectedMachineCapabilities: null,
                targetServerId: 'server-a', allowedTargetServerIds: ['server-a'],
            });
            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }
        try {
            await renderWithActionExecutor(React.createElement(Test));
            expect(handleCreateSession).toBeTypeOf('function');
            await act(async () => { await invokeHandleCreateSession(handleCreateSession); });
            expect(captured.value, JSON.stringify({ actions: spawnActions, alerts: modalAlertSpy.mock.calls, errors: errors.mock.calls.map(([error]) => String(error)) })).not.toBeNull();
            expect(captured.value?.configuration?.options).toMatchObject({
                opencodeBackendMode: { value: mode },
                opencodeServerBaseUrl: { value: 'https://opencode.example.test/' },
            });
            expect(captured.value).not.toHaveProperty('environmentVariables');
        } finally {
            await launchHarness.dispose();
        }
    });

    it('passes a canonical permission mode and timestamp into the strict Action request', async () => {
        const { useCreateNewSession, captured, modalAlertSpy } = await setupUseCreateNewSessionHarness();

        let handleCreateSession: null | (() => Promise<void>) = null;
        const settings = { experiments: false } as unknown as Settings;
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
                agentType: 'codex',
                permissionMode: 'acceptEdits' as unknown as PermissionMode,
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
            });

            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));

        await act(async () => {
            await handleCreateSession?.();
        });

        expect(captured.value, JSON.stringify(modalAlertSpy.mock.calls)).not.toBeNull();
        expect(captured.value?.permissionMode).toBe('safe-yolo');
        expect(typeof captured.value?.configuration?.permissionIntent.updatedAtMs).toBe('number');
        expect(Number.isFinite(captured.value?.configuration?.permissionIntent.updatedAtMs)).toBe(true);
        expect((captured.value?.configuration?.permissionIntent.updatedAtMs ?? 0)).toBeGreaterThan(0);
    });

    it('preserves persisted last-used agent settings when the draft has no canonical backendTarget', async () => {
        const { useCreateNewSession, storage } = await setupUseCreateNewSessionHarness();

        let handleCreateSession: null | (() => Promise<void>) = null;
        const settings = {
            experiments: false,
            lastUsedAgent: 'codex',
        } as unknown as Settings;
        storage.getState().applySettings(
            { ...storage.getState().settings, ...settings },
            (storage.getState().settingsVersion ?? 0) + 1,
        );
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
                agentType: 'codex',
                permissionMode: 'acceptEdits' as unknown as PermissionMode,
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
            });

            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));

        await act(async () => {
            await handleCreateSession?.();
        });

        await vi.waitFor(() => expect(storage.getState().authoringMemory.recentMachinePaths).toEqual([{ machineId: 'm1', path: '/tmp' }]));
        expect(storage.getState().settings.lastUsedAgent).toBe('codex');
        expect(storage.getState().settings.lastUsedBackendTarget).toBeNull();
    });

    it('passes resumeSessionId through without pre-spawn capability probing', async () => {
        const { useCreateNewSession, captured } = await setupUseCreateNewSessionHarness();

        let handleCreateSession: null | (() => Promise<void>) = null;
        const settings = { experiments: false } as unknown as Settings;
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
                agentType: 'codex' as any,
                permissionMode: 'default' as PermissionMode,
                modelMode: 'default' as ModelMode,
                promptStore: createNewSessionPromptStore(''),
                // An opaque Agent-issued session id, not a user-shaped token:
                // the spawn request must carry these bytes unchanged.
                resumeSessionId: 'fx/AB+cd==/01JQ',
                agentNewSessionOptions: null,
                machineEnvPresence,
                secrets: [],
                secretBindingsByProfileId: {},
                selectedSecretIdByProfileIdByEnvVarName: {},
                sessionOnlySecretValueByProfileIdByEnvVarName: {},
                selectedMachineCapabilities: null,
                targetServerId: 'server-a',
                allowedTargetServerIds: ['server-a'],
            });

            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));

        await act(async () => {
            await handleCreateSession?.();
        });

        expect(captured.value?.configuration?.providerSessionResume?.providerSessionId).toBe('fx/AB+cd==/01JQ');
    });

    it('includes the selected model and initial message in the strict Action request', async () => {
        const {
            useCreateNewSession,
            captured,
            mockSessionSpawnSuccess,
            syncSendMessageSpy,
        } = await setupUseCreateNewSessionHarness();

        mockSessionSpawnSuccess('sess_target');

        let handleCreateSession: null | (() => Promise<void>) = null;
        const settings = { experiments: false } as unknown as Settings;
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
                agentType: 'codex' as any,
                permissionMode: 'default' as PermissionMode,
                modelMode: 'gpt' as any,
                promptStore: createNewSessionPromptStore('hello'),
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
            });

            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));

        await act(async () => {
            await handleCreateSession?.();
        });

        expect(captured.value).toEqual(expect.objectContaining({
            initialInput: { text: 'hello' },
            configuration: expect.objectContaining({
                model: expect.objectContaining({ value: 'gpt' }),
            }),
        }));
        expect(syncSendMessageSpy).not.toHaveBeenCalled();
    });

    it('uses canonical provider selection in the strict Action request when presentation mode is Automatic', async () => {
        const {
            useCreateNewSession,
            captured,
            mockSessionSpawnSuccess,
            syncSendMessageSpy,
        } = await setupUseCreateNewSessionHarness();

        mockSessionSpawnSuccess('sess_target');

        let handleCreateSession: null | (() => Promise<void>) = null;
        const settings = { experiments: false } as unknown as Settings;
        const machineEnvPresence: UseMachineEnvPresenceResult = {
            isPreviewEnvSupported: false,
            isLoading: false,
            meta: {},
            refreshedAt: null,
            refresh: () => {},
        };
        const authoringDraft = buildNewSessionAuthoringDraft({
            executionTarget: null,
            directory: '/tmp',
            checkoutCreationDraft: null,
            organizationPlacement: { folderId: null, tagIds: [] },
            prompt: 'hello',
            displayText: 'hello',
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
            transcriptStorage: null,
            profileId: null,
            environmentVariables: null,
            resumeSessionId: null,
            permissionMode: 'default',
            permissionModeUpdatedAt: null,
            modelSelection: SessionModelSelectionV1Schema.parse({
                v: 1,
                updatedAt: 456,
                ref: {
                    agentTargetKey: buildBackendTargetKeyV2({ kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } }),
                    providerConnectionId: 'pc_openrouter',
                    modelId: 'default',
                },
            }),
            mcpSelection: null,
            connectedServices: null,
            terminal: null,
            windowsRemoteSessionLaunchMode: null,
            windowsRemoteSessionConsole: null,
            acpSessionModeId: null,
            sessionConfigOptionOverrides: null,
            automation: null,
        });

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
                agentType: 'codex' as any,
                permissionMode: 'default' as PermissionMode,
                modelMode: 'default' as ModelMode,
                promptStore: createNewSessionPromptStore('hello'),
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
                authoringDraft,
            });

            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));
        await act(async () => {
            await handleCreateSession?.();
        });

        expect(captured.value).toEqual(expect.objectContaining({
            initialInput: { text: 'hello' },
            modelSelection: authoringDraft.modelSelection,
        }));
        expect(syncSendMessageSpy).not.toHaveBeenCalled();
    });

    it.each([
        ['matching Home and Machine on a supporting daemon', 'server-a', 'm1', true, true],
        ['matching Home and Machine on an unsupported daemon', 'server-a', 'm1', false, false],
        ['different Home', 'server-b', 'm1', true, false],
        ['different Machine', 'server-a', 'm2', true, false],
    ] as const)('emits Machine Pool origin only for a %s', async (_case, originServerId, originMachineId, supportsOrigin, expectedOrigin) => {
        const { useCreateNewSession, captured, storage } = await setupUseCreateNewSessionHarness();
        let handleCreateSession: null | (() => Promise<void>) = null;
        const poolId = '3a948f0c-bc30-491c-b764-37f0e6744d1f';
        const selectedMachine = createMachineFixture({
            id: 'm1',
            operationProtocolCapabilities: supportsOrigin
                ? { sessionSpawnPlacementOrigin: { protocolVersions: [1] } }
                : null,
        });
        storage.getState().applyMachines([selectedMachine], true, { sourceServerId: 'server-a' });
        const authoringDraft = buildNewSessionAuthoringDraft({
            executionTarget: {
                kind: 'machine',
                target: { serverId: originServerId, machineId: originMachineId },
                selectionOrigin: { kind: 'machine_pool', poolId },
            },
            directory: '/tmp',
            checkoutCreationDraft: null,
            organizationPlacement: { folderId: null, tagIds: [] },
            prompt: 'hello',
            displayText: 'hello',
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
            transcriptStorage: null,
            profileId: null,
            environmentVariables: null,
            resumeSessionId: null,
            permissionMode: 'default',
            permissionModeUpdatedAt: null,
            mcpSelection: null,
            connectedServices: null,
            terminal: null,
            windowsRemoteSessionLaunchMode: null,
            windowsRemoteSessionConsole: null,
            acpSessionModeId: null,
            sessionConfigOptionOverrides: null,
            automation: null,
        });

        function Test() {
            const hook = useCreateNewSession({
                launchIntentSignature: 'test-launch-intent',
                router: { push: vi.fn(), replace: vi.fn() },
                selectedMachineId: 'm1',
                selectedPath: '/tmp',
                selectedMachine,
                setIsCreating: vi.fn(),
                setIsResumeSupportChecking: vi.fn(),
                settings: { experiments: false } as unknown as Settings,
                useProfiles: false,
                selectedProfileId: null,
                profileMap: new Map(),
                recentMachinePaths: [],
                agentType: 'codex',
                permissionMode: 'default' as PermissionMode,
                modelMode: 'default' as ModelMode,
                promptStore: createNewSessionPromptStore('hello'),
                resumeSessionId: '',
                agentNewSessionOptions: null,
                machineEnvPresence: {
                    isPreviewEnvSupported: false,
                    isLoading: false,
                    meta: {},
                    refreshedAt: null,
                    refresh: () => {},
                },
                secrets: [],
                secretBindingsByProfileId: {},
                selectedSecretIdByProfileIdByEnvVarName: {},
                sessionOnlySecretValueByProfileIdByEnvVarName: {},
                selectedMachineCapabilities: null,
                targetServerId: 'server-a',
                allowedTargetServerIds: ['server-a'],
                authoringDraft,
            });
            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));
        await act(async () => {
            await handleCreateSession?.();
        });

        if (expectedOrigin) {
            expect(captured.value?.placementOrigin).toEqual({ kind: 'machine_pool', poolId });
        } else {
            expect(captured.value).not.toHaveProperty('placementOrigin');
        }
    });

    it('runs local slash actions for the created session without sending the slash text as the first message', async () => {
        const {
            useCreateNewSession,
            captured,
            mockSessionSpawnSuccess,
            syncSendMessageSpy,
        } = await setupUseCreateNewSessionHarness();

        mockSessionSpawnSuccess('sess_runs');

        let handleCreateSession: null | (() => Promise<void>) = null;
        const settings = { experiments: false, featureToggles: { 'execution.runs': true } } as unknown as Settings;
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
                agentType: 'codex' as any,
                permissionMode: 'default' as PermissionMode,
                modelMode: 'default' as ModelMode,
                promptStore: createNewSessionPromptStore('/h.runs'),
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
            });

            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));

        await act(async () => {
            await handleCreateSession?.();
        });

        expect(captured.value?.initialInput).toBeUndefined();
        expect(syncSendMessageSpy).not.toHaveBeenCalled();
    });

    it('passes connectedServices bindings into the strict Action request when provided', async () => {
        const { useCreateNewSession, captured } = await setupUseCreateNewSessionHarness();

        let handleCreateSession: null | (() => Promise<void>) = null;
        const settings = { experiments: false } as unknown as Settings;
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
                agentType: 'codex',
                permissionMode: 'acceptEdits' as unknown as PermissionMode,
                modelMode: 'default' as ModelMode,
                promptStore: createNewSessionPromptStore(''),
                resumeSessionId: '',
                agentNewSessionOptions: {
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            [ANTHROPIC_CONNECTED_ACCOUNT_KEY]: {
                                source: 'connected',
                                selection: 'profile',
                                profileId: 'work',
                            },
                        },
                    },
                },
                machineEnvPresence,
                secrets: [],
                secretBindingsByProfileId: {},
                selectedSecretIdByProfileIdByEnvVarName: {},
                sessionOnlySecretValueByProfileIdByEnvVarName: {},
                selectedMachineCapabilities: null,
                targetServerId: 'server-a',
                allowedTargetServerIds: ['server-a'],
            });

            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));

        await act(async () => {
            await handleCreateSession?.();
        });

        expect(captured.value).not.toBeNull();
        expect(captured.value?.connectedServices).toEqual({
            v: 2,
            bindingsByServiceId: {
                [ANTHROPIC_CONNECTED_ACCOUNT_KEY]: {
                    source: 'connected',
                    selection: 'profile',
                    profileId: 'work',
                },
            },
        });
    });

    it('passes mcpSelection into the strict Action request when provided', async () => {
        const { useCreateNewSession, captured } = await setupUseCreateNewSessionHarness();

        let handleCreateSession: null | (() => Promise<void>) = null;
        const settings = { experiments: false } as unknown as Settings;
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
                agentType: 'codex',
                permissionMode: 'default' as PermissionMode,
                modelMode: 'default' as ModelMode,
                promptStore: createNewSessionPromptStore(''),
                resumeSessionId: '',
                agentNewSessionOptions: null,
                mcpSelection: {
                    v: 1,
                    managedServersEnabled: false,
                    forceIncludeServerIds: ['server-portable'],
                    forceExcludeServerIds: [],
                },
                machineEnvPresence,
                secrets: [],
                secretBindingsByProfileId: {},
                selectedSecretIdByProfileIdByEnvVarName: {},
                sessionOnlySecretValueByProfileIdByEnvVarName: {},
                selectedMachineCapabilities: null,
                targetServerId: undefined,
                allowedTargetServerIds: ['server-a'],
            });

            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));

        await act(async () => {
            await handleCreateSession?.();
        });

        expect(captured.value?.mcpSelection).toEqual({
            v: 1,
            managedServersEnabled: false,
            forceIncludeServerIds: ['server-portable'],
            forceExcludeServerIds: [],
        });
    });

    it('passes transcriptStorage through to the strict Action request when requested', async () => {
        const { useCreateNewSession, captured } = await setupUseCreateNewSessionHarness();

        let handleCreateSession: null | (() => Promise<void>) = null;
        const settings = { experiments: false } as unknown as Settings;
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
                permissionMode: 'default' as PermissionMode,
                modelMode: 'default' as ModelMode,
                promptStore: createNewSessionPromptStore(''),
                transcriptStorage: 'direct',
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

        await act(async () => {
            await handleCreateSession?.();
        });

        expect(captured.value?.transcriptStorage).toBe('direct');
    });

    it('routes spawn to the target server without switching global active server', async () => {
        const {
            useCreateNewSession,
            captured,
            sessionSpawnNewRpcRequest,
        } = await setupUseCreateNewSessionHarness();

        let handleCreateSession: null | (() => Promise<void>) = null;
        const settings = { experiments: false } as unknown as Settings;
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
                agentType: 'codex',
                permissionMode: 'acceptEdits' as unknown as PermissionMode,
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
            });

            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));

        await act(async () => {
            await handleCreateSession?.();
        });

        expect(captured.value?.executionTarget.serverId).toBe('server-a');
        expect(sessionSpawnNewRpcRequest.value).toEqual(expect.objectContaining({
            serverId: 'server-a',
            machineId: 'm1',
            method: RPC_METHODS.SESSION_SPAWN_NEW,
            payload: expect.objectContaining({
                executionTarget: { serverId: 'server-a', machineId: 'm1' },
            }),
        }));
    });

    it('does not call the active Home when upstream rejects an explicit device-global target', async () => {
        const {
            useCreateNewSession,
            captured,
            modalAlertSpy,
        } = await setupUseCreateNewSessionHarness();

        let handleCreateSession: null | (() => Promise<void>) = null;
        const settings = { experiments: false } as unknown as Settings;
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
                agentType: 'codex',
                permissionMode: 'acceptEdits' as unknown as PermissionMode,
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
                targetServerId: null,
                allowedTargetServerIds: [],
            });

            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));

        await act(async () => {
            await handleCreateSession?.();
        });

        expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'newSession.failedToStart');
        expect(captured.value).toBeNull();
    });

    it('admits scoped repo-native first prompts atomically through the strict Action', async () => {
        const {
            useCreateNewSession,
            captured,
            syncSendMessageSpy,
            mockSessionSpawnSuccess,
        } = await setupUseCreateNewSessionHarness();

        mockSessionSpawnSuccess('sess_target');

        let handleCreateSession: null | (() => Promise<void>) = null;
        const settings = { experiments: false } as unknown as Settings;
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
                checkoutCreationDraft: {
                    kind: 'git_worktree',
                    displayName: 'feature/scope-fix',
                    baseRef: 'main',
                },
                setIsCreating: vi.fn(),
                setIsResumeSupportChecking: vi.fn(),
                settings,
                useProfiles: false,
                selectedProfileId: null,
                profileMap: new Map(),
                recentMachinePaths: [],
                agentType: 'codex',
                permissionMode: 'acceptEdits' as unknown as PermissionMode,
                modelMode: 'default' as ModelMode,
                promptStore: createNewSessionPromptStore('Ship the scoped follow-up fix'),
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
            });

            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));

        await act(async () => {
            await handleCreateSession?.();
        });

        expect(captured.value).toEqual(expect.objectContaining({
            executionTarget: { serverId: 'server-a', machineId: 'm1' },
            checkoutCreationDraft: {
                kind: 'git_worktree',
                displayName: 'feature/scope-fix',
                baseRef: 'main',
            },
            initialInput: { text: 'Ship the scoped follow-up fix' },
        }));
        expect(syncSendMessageSpy).not.toHaveBeenCalled();
    });

    /**
     * New Session does not write Automations. A draft saved before creation
     * moved to the shared Automation editor can still hydrate with an enabled
     * inline Automation; the screen hands that work to the shared editor, so
     * this submit path never reaches the Automation writer.
     */
    it('never writes an Automation from New Session submit, even for a hydrated enabled draft', async () => {
        const {
            useCreateNewSession,
            automationCaptured,
            refreshAutomationsSpy,
        } = await setupUseCreateNewSessionHarness();

        let handleCreateSession: null | ReturnType<typeof useCreateNewSession>['handleCreateSession'] = null;
        const routerReplace = vi.fn();
        const settings = { experiments: false } as unknown as Settings;
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
                router: { push: vi.fn(), replace: routerReplace },
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
                agentType: 'codex',
                permissionMode: 'acceptEdits' as unknown as PermissionMode,
                modelMode: 'default' as ModelMode,
                promptStore: createNewSessionPromptStore('Run the nightly maintenance checklist'),
                resumeSessionId: '',
                machineEnvPresence,
                secrets: [],
                secretBindingsByProfileId: {},
                selectedSecretIdByProfileIdByEnvVarName: {},
                sessionOnlySecretValueByProfileIdByEnvVarName: {},
                selectedMachineCapabilities: null,
                targetServerId: undefined,
                allowedTargetServerIds: ['server-a'],
                authoringDraft: buildAutomationAuthoringDraft({
                    prompt: 'Run the nightly maintenance checklist',
                    modelMode: 'default' as ModelMode,
                    permissionMode: 'acceptEdits' as unknown as PermissionMode,
                    automation: createScheduleAutomationDraft({ name: 'Nightly', description: 'desc' }),
                }),
            });

            handleCreateSession = hook.handleCreateSession;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));

        await act(async () => {
            await invokeHandleCreateSession(handleCreateSession);
        });

        expect(automationCaptured.value).toBeNull();
        expect(refreshAutomationsSpy).not.toHaveBeenCalled();
        expect(routerReplace).not.toHaveBeenCalledWith('/automations');
    });

    it('keeps vendor resume and the first message in the strict Action request', async () => {
        const {
            useCreateNewSession,
            captured,
            syncSendMessageSpy,
            mockSessionSpawnSuccess,
        } = await setupUseCreateNewSessionHarness();

        mockSessionSpawnSuccess('sess_new');
        const { writeNewSessionDraft, getSessionDraftSnapshot } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
        await prepareSessionDraftPersistenceStorage();
        const draftId = 'permission-success-draft';
        const draftScope = { serverId: 'server-a', accountId: 'account-a' };
        const otherScope = { serverId: 'server-a', accountId: 'other-account' };
        writeNewSessionDraft({ scope: draftScope, draftId, patch: { text: 'PROMPT' }, materializationIntent: 'userEdit' });
        writeNewSessionDraft({ scope: otherScope, draftId, patch: { text: 'Keep this draft' }, materializationIntent: 'userEdit' });


        let handleCreateSession: null | (() => Promise<void>) = null;
        const routerReplace = vi.fn();
        const disableDraftPersistence = vi.fn();
        const settings = {
            experiments: false,
            sessionReplayEnabled: true,
            sessionReplayStrategy: 'recent_messages',
            sessionReplayRecentMessagesCount: 100,
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
                draftScope,
                draftId,
                router: { push: vi.fn(), replace: routerReplace },
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
                agentType: 'codex',
                permissionMode: 'acceptEdits' as unknown as PermissionMode,
                modelMode: 'default' as ModelMode,
                promptStore: createNewSessionPromptStore('PROMPT'),
                resumeSessionId: 'sess_old',
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
            });

            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));

        await act(async () => {
            await handleCreateSession?.();
        });

        expect(disableDraftPersistence).toHaveBeenCalledTimes(1);
        expect(getSessionDraftSnapshot(draftScope, { kind: 'newSession', draftId })?.document.composer.text?.value ?? '').toBe('');
        expect(getSessionDraftSnapshot(otherScope, { kind: 'newSession', draftId })?.document.composer.text?.value).toBe('Keep this draft');
        expect(captured.value).toEqual(expect.objectContaining({
            initialInput: { text: 'PROMPT' },
            configuration: expect.objectContaining({
                providerSessionResume: {
                    kind: 'provider_session.v1',
                    providerSessionId: 'sess_old',
                },
            }),
        }));
        expect(syncSendMessageSpy).not.toHaveBeenCalled();
    });

    it('passes the selected profile id through the strict Action request', async () => {
        const {
            useCreateNewSession,
            captured,
            syncSendMessageSpy,
            mockSessionSpawnSuccess,
        } = await setupUseCreateNewSessionHarness();

        mockSessionSpawnSuccess('sess_new');

        let handleCreateSession: null | (() => Promise<void>) = null;
        const routerReplace = vi.fn();
        const settings = {
            experiments: false,
            sessionReplayEnabled: false,
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
                router: { push: vi.fn(), replace: routerReplace },
                selectedMachineId: 'm1',
                selectedPath: '/tmp',
                selectedMachine: createMachineFixture({ id: 'm1' }),
                setIsCreating: vi.fn(),
                setIsResumeSupportChecking: vi.fn(),
                settings,
                useProfiles: true,
                selectedProfileId: 'profile-test',
                profileMap: new Map([[
                    'profile-test',
                    AIBackendProfileSchema.parse({
                        id: 'profile-test',
                        name: 'Profile Test',
                        description: undefined,
                        environmentVariables: [],
                        envVarRequirements: [],
                        compatibility: {},
                        defaultPermissionModeByAgent: {},
                        defaultPermissionModeByTargetKey: {},
                        defaultPersistenceModeByAgent: {},
                        defaultPersistenceModeByTargetKey: {},
                        compatibilityByTargetKey: {
                            [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'codex' })]: true,
                        },
                        isBuiltIn: false,
                        createdAt: Date.now(),
                        updatedAt: Date.now(),
                        version: '1.0.0',
                    }),
                ]]),
                recentMachinePaths: [],
                agentType: 'codex',
                permissionMode: 'acceptEdits' as unknown as PermissionMode,
                modelMode: 'default' as ModelMode,
                promptStore: createNewSessionPromptStore('PROMPT'),
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
            });

            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));

        await act(async () => {
            await handleCreateSession?.();
        });

        expect(captured.value).toEqual(expect.objectContaining({
            profileId: 'profile-test',
            initialInput: { text: 'PROMPT' },
        }));
        expect(syncSendMessageSpy).not.toHaveBeenCalled();
    });

    it('sends a persisted Profile Saved Secret binding by profile id without browser materialization', async () => {
        const {
            useCreateNewSession,
            captured,
            sessionSpawnNewRpcSpy,
        } = await setupUseCreateNewSessionHarness();

        let handleCreateSession: null | (() => Promise<void>) = null;
        const profile = AIBackendProfileSchema.parse({
            ...createCompatibleTestProfile('profile-with-secret'),
            environmentVariables: [{ name: 'PROFILE_MODE', value: 'reviewed' }],
            envVarRequirements: [{ name: 'ANTHROPIC_API_KEY', required: true, kind: 'secret' }],
        });
        const machineEnvPresence: UseMachineEnvPresenceResult = {
            isPreviewEnvSupported: true,
            isLoading: false,
            meta: { ANTHROPIC_API_KEY: { isSet: false, display: 'unset' } },
            refreshedAt: 1,
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
                settings: { experiments: false } as unknown as Settings,
                useProfiles: true,
                selectedProfileId: profile.id,
                profileMap: new Map([[profile.id, profile]]),
                recentMachinePaths: [],
                agentType: 'codex',
                permissionMode: 'acceptEdits' as unknown as PermissionMode,
                modelMode: 'default' as ModelMode,
                promptStore: createNewSessionPromptStore('PROMPT'),
                resumeSessionId: '',
                agentNewSessionOptions: null,
                machineEnvPresence,
                secrets: [{
                    id: 'personal-profile-secret',
                    name: 'Profile token',
                    kind: 'token',
                    encryptedValue: { _isSecretValue: true, value: 'browser-must-not-send-this' },
                    createdAt: 1,
                    updatedAt: 1,
                }],
                secretBindingsByProfileId: {
                    [profile.id]: { ANTHROPIC_API_KEY: 'personal-profile-secret' },
                },
                selectedSecretIdByProfileIdByEnvVarName: {
                    [profile.id]: { ANTHROPIC_API_KEY: 'personal-profile-secret' },
                },
                sessionOnlySecretValueByProfileIdByEnvVarName: {},
                selectedMachineCapabilities: null,
                targetServerId: 'server-a',
                allowedTargetServerIds: ['server-a'],
            });
            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));
        await act(async () => {
            await handleCreateSession?.();
        });

        expect(sessionSpawnNewRpcSpy).toHaveBeenCalledOnce();
        expect(captured.value).toMatchObject({ profileId: profile.id });
        expect(captured.value).not.toHaveProperty('environmentVariables');
        expect(JSON.stringify(captured.value)).not.toContain('browser-must-not-send-this');
        expect(JSON.stringify(captured.value)).not.toContain('personal-profile-secret');
    });

    it('records the selected profile only after Session creation succeeds', async () => {
        const {
            useCreateNewSession,
            storage,
            mockSessionSpawnSuccess,
            sessionSpawnNewRpcSpy,
        } = await setupUseCreateNewSessionHarness();

        let handleCreateSession: null | (() => Promise<void>) = null;
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
                settings: { experiments: false } as unknown as Settings,
                useProfiles: true,
                selectedProfileId: 'profile-test',
                profileMap: new Map([['profile-test', createCompatibleTestProfile()]]),
                recentMachinePaths: [],
                agentType: 'codex',
                permissionMode: 'acceptEdits' as unknown as PermissionMode,
                modelMode: 'default' as ModelMode,
                promptStore: createNewSessionPromptStore('PROMPT'),
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
            });
            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));
        await act(async () => {
            await handleCreateSession?.();
        });

        expect(sessionSpawnNewRpcSpy).toHaveBeenCalledOnce();
        expect(storage.getState().authoringMemory.lastUsedProfile).not.toBe('profile-test');

        mockSessionSpawnSuccess('sess_profile_success');
        await act(async () => {
            await handleCreateSession?.();
        });

        await vi.waitFor(() => expect(storage.getState().authoringMemory.lastUsedProfile).toBe('profile-test'));
    });

    it('does not record an invalid profile selection as last used', async () => {
        const {
            useCreateNewSession,
            storage,
            sessionSpawnNewRpcSpy,
        } = await setupUseCreateNewSessionHarness();

        let handleCreateSession: null | (() => Promise<void>) = null;
        const incompatibleProfile = AIBackendProfileSchema.parse({
            ...createCompatibleTestProfile(),
            compatibilityByTargetKey: {
                [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'codex' })]: false,
                [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'claude' })]: true,
            },
        });
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
                settings: { experiments: false } as unknown as Settings,
                useProfiles: true,
                selectedProfileId: 'profile-test',
                profileMap: new Map([['profile-test', incompatibleProfile]]),
                recentMachinePaths: [],
                agentType: 'codex',
                permissionMode: 'acceptEdits' as unknown as PermissionMode,
                modelMode: 'default' as ModelMode,
                promptStore: createNewSessionPromptStore('PROMPT'),
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
            });
            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));
        await act(async () => {
            await handleCreateSession?.();
        });

        expect(sessionSpawnNewRpcSpy).not.toHaveBeenCalled();
        expect(storage.getState().authoringMemory.lastUsedProfile).not.toBe('profile-test');
    });

    it('blocks creation when the selected profile is incompatible with the current backend target', async () => {
        const {
            useCreateNewSession,
            modalAlertSpy,
            sessionSpawnNewRpcSpy,
            syncSendMessageSpy,
        } = await setupUseCreateNewSessionHarness();

        let handleCreateSession: null | (() => Promise<void>) = null;
        const settings = {
            experiments: false,
            sessionReplayEnabled: false,
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
                useProfiles: true,
                selectedProfileId: 'profile-test',
                profileMap: new Map([[
                    'profile-test',
                    AIBackendProfileSchema.parse({
                        id: 'profile-test',
                        name: 'Profile Test',
                        description: undefined,
                        environmentVariables: [],
                        envVarRequirements: [],
                        compatibility: {},
                        defaultPermissionModeByAgent: {},
                        defaultPermissionModeByTargetKey: {},
                        defaultPersistenceModeByAgent: {},
                        defaultPersistenceModeByTargetKey: {},
                        compatibilityByTargetKey: {
                            [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'claude' })]: true,
                            [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'codex' })]: false,
                        },
                        isBuiltIn: false,
                        createdAt: Date.now(),
                        updatedAt: Date.now(),
                        version: '1.0.0',
                    }),
                ]]),
                recentMachinePaths: [],
                agentType: 'codex',
                permissionMode: 'acceptEdits' as unknown as PermissionMode,
                modelMode: 'default' as ModelMode,
                promptStore: createNewSessionPromptStore('PROMPT'),
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
            });

            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));

        await act(async () => {
            await handleCreateSession?.();
        });

        expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'newSession.aiBackendNotCompatibleWithSelectedProfile');
        expect(sessionSpawnNewRpcSpy).not.toHaveBeenCalled();
        expect(syncSendMessageSpy).not.toHaveBeenCalled();
    });

    it('can skip sending the initial message when requested', async () => {
        const {
            useCreateNewSession,
            captured,
            syncSendMessageSpy,
            mockSessionSpawnSuccess,
        } = await setupUseCreateNewSessionHarness();

        mockSessionSpawnSuccess('sess_new');

        let handleCreateSession: null | ReturnType<typeof useCreateNewSession>['handleCreateSession'] = null;
        const routerReplace = vi.fn();
        const settings = {
            experiments: false,
            sessionReplayEnabled: false,
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
                router: { push: vi.fn(), replace: routerReplace },
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
                agentType: 'codex',
                permissionMode: 'acceptEdits' as unknown as PermissionMode,
                modelMode: 'default' as ModelMode,
                promptStore: createNewSessionPromptStore('PROMPT'),
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
            });

            handleCreateSession = hook.handleCreateSession;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));

        await act(async () => {
            await invokeHandleCreateSession(handleCreateSession, { initialMessage: 'skip' });
        });

        expect(captured.value?.initialInput).toBeUndefined();
        expect(syncSendMessageSpy).toHaveBeenCalledTimes(0);
        expect(routerReplace).toHaveBeenCalledWith('/session/sess_new?serverId=server-a', expect.anything());
    });

    it('passes the per-session Windows launch-mode override into the strict Action request', async () => {
        const {
            useCreateNewSession,
            captured,
        } = await setupUseCreateNewSessionHarness();

        let handleCreateSession: null | ReturnType<typeof useCreateNewSession>['handleCreateSession'] = null;
        const settings = {
            experiments: false,
            sessionWindowsRemoteSessionLaunchMode: 'hidden',
            sessionWindowsTerminalWindowName: 'happier-qa',
        } as unknown as Settings;
        const machineEnvPresence: UseMachineEnvPresenceResult = {
            isPreviewEnvSupported: false,
            isLoading: false,
            meta: {},
            refreshedAt: null,
            refresh: () => {},
        };
        const canonicalMachineMetadata = createMachineFixture({ id: 'm1' }).metadata;
        if (!canonicalMachineMetadata) {
            throw new Error('createMachineFixture must provide canonical Machine metadata');
        }
        const windowsMachine = createMachineFixture({
            id: 'm1',
            metadata: {
                ...canonicalMachineMetadata,
                platform: 'win32',
                windowsRemoteSessionLaunchMode: 'console',
            },
        });

        function Test() {
            const hook = useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
                router: { push: vi.fn(), replace: vi.fn() },
                selectedMachineId: 'm1',
                selectedPath: '/tmp',
                selectedMachine: windowsMachine,
                setIsCreating: vi.fn(),
                setIsResumeSupportChecking: vi.fn(),
                settings,
                useProfiles: false,
                selectedProfileId: null,
                profileMap: new Map(),
                recentMachinePaths: [],
                agentType: 'codex',
                permissionMode: 'acceptEdits' as unknown as PermissionMode,
                modelMode: 'default' as ModelMode,
                promptStore: createNewSessionPromptStore(''),
                resumeSessionId: '',
                agentNewSessionOptions: null,
                windowsRemoteSessionLaunchModeOverride: 'windows_terminal',
                machineEnvPresence,
                secrets: [],
                secretBindingsByProfileId: {},
                selectedSecretIdByProfileIdByEnvVarName: {},
                sessionOnlySecretValueByProfileIdByEnvVarName: {},
                selectedMachineCapabilities: null,
                targetServerId: undefined,
                allowedTargetServerIds: ['server-a'],
            });

            handleCreateSession = hook.handleCreateSession;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));

        await act(async () => {
            await invokeHandleCreateSession(handleCreateSession, { initialMessage: 'skip' });
        });

        expect(captured.value?.terminal?.windows?.launchMode).toBe('windows_terminal');
        expect(captured.value?.terminal?.windows?.windowName).toBe('happier-qa');
    });
});
