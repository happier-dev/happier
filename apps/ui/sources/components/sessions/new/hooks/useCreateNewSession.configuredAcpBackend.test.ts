import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createAuthoringMemoryHttpBoundary } from '@/dev/testkit/mocks/authoringMemoryHttp';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { buildNewSessionAuthoringDraft } from '@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters';
import { createNewSessionPromptStore } from './screenModel/newSessionPromptStore';
import { installNewSessionScreenModelCommonModuleMocks } from './newSessionScreenModelTestHelpers';
import type { useCreateNewSession } from './useCreateNewSession';
import type { RuntimeFetch } from '@/utils/system/runtimeFetch';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';

type CreateParams = Parameters<typeof useCreateNewSession>[0];
const configuredTarget = {
    kind: 'backend',
    backendId: 'custom-kiro-preset',
    configuredBackendId: 'custom-kiro-preset',
    sourceKind: 'configured',
} as const;
let authoringHttp: ReturnType<typeof createAuthoringMemoryHttpBoundary>;
const httpRequests: Array<{ path: string; method: string; body: unknown }> = [];
const rpcRequests: Array<{ method: string; params: unknown }> = [];
beforeEach(() => {
    authoringHttp = createAuthoringMemoryHttpBoundary();
    httpRequests.length = 0;
    rpcRequests.length = 0;
});
installNewSessionScreenModelCommonModuleMocks();
const runtime = installSessionPaneRuntimeTestHarness({
    request: async (...args: Parameters<RuntimeFetch>) => {
        const [input, init] = args;
        const path = new URL(String(input)).pathname;
        httpRequests.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
        if (path === '/v1/machines/m1') return Response.json({ machine: { id: 'm1', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } });
        return await authoringHttp.handle(input, init);
    },
    configureSocket: (socket) => {
        // Socket.IO is the external daemon boundary; no Action or Sync owner is replaced.
        socket.connected = true;
        vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event, payload) => {
            if (event !== SOCKET_RPC_EVENTS.CALL) return { v: 1, ok: true, admittedSessionIds: [] };
            if (!payload || typeof payload !== 'object' || !('method' in payload)
                || typeof payload.method !== 'string' || !('params' in payload)) {
                throw new Error('Malformed daemon RPC');
            }
            rpcRequests.push({ method: payload.method, params: payload.params });
            return { ok: false, error: 'RPC method not found', errorCode: 'METHOD_NOT_FOUND' };
        });
    },
});

async function mount(overrides: Partial<CreateParams> = {}) {
    const { storage } = await import('@/sync/domains/state/storageStore');
    const { useCreateNewSession: owner } = await import('./useCreateNewSession');
    const machine = createMachineFixture({ id: 'm1' });
    storage.getState().applyMachines([machine], true, { sourceServerId: runtime.serverId });
    const scope = { serverId: runtime.serverId, accountId: 'account-a' };
    const router = { push: vi.fn(), replace: vi.fn() };
    const disableDraftPersistence = vi.fn();
    const params: CreateParams = {
        launchIntentSignature: 'test-launch-intent',
        router,
        selectedMachineId: machine.id,
        selectedPath: '/tmp',
        selectedMachine: machine,
        setIsCreating: vi.fn(),
        setIsResumeSupportChecking: vi.fn(),
        settings: storage.getState().settings,
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'customAcp',
        backendTarget: configuredTarget,
        permissionMode: 'default',
        modelMode: 'default',
        promptStore: createNewSessionPromptStore(''),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence: {
            isPreviewEnvSupported: false, isLoading: false, meta: {}, refreshedAt: null, refresh: () => {},
        },
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        resolveSavedSecretReference: (ref) => ({
            ref, kind: 'personal', status: 'temporarily_unavailable',
            entry: null, secret: null, revision: null, fingerprint: null,
        }),
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: null,
        targetServerId: runtime.serverId,
        allowedTargetServerIds: [runtime.serverId],
        draftScope: scope,
        disableDraftPersistence,
        ...overrides,
    };
    const hook = await renderHook(() => owner(params), {
        wrapper: runtime.Wrapper,
    });
    return {
        params, router, disableDraftPersistence, storage,
        async create() {
            await act(async () => {
                await Promise.resolve(hook.getCurrent().handleCreateSession());
            });
        },
    };
}

function expectNoSpawn() {
    expect(rpcRequests.filter((request) => request.method.endsWith(':' + RPC_METHODS.SESSION_SPAWN_NEW))).toEqual([]);
    expect(httpRequests.filter((request) => request.path === '/v3/automations' && request.method === 'POST')).toEqual([]);
    expect(httpRequests.filter((request) => /\/(pending|messages)$/.test(request.path) && request.method === 'POST')).toEqual([]);
}

describe('useCreateNewSession configured ACP backend spawning', () => {
    it('fails closed without a private spawn when a configured backend target is unrepresentable', async () => {
        const harness = await mount();
        await harness.create();
        expectNoSpawn();
        await vi.waitFor(() => expect(harness.storage.getState().authoringMemory.recentMachinePaths)
            .toEqual([{ machineId: 'm1', path: '/tmp' }]));
        expect(harness.storage.getState().settings.lastUsedBackendTarget).toEqual(configuredTarget);
    });

    it('does not prepare account settings for an unrepresentable configured backend target', async () => {
        const harness = await mount({ targetServerId: undefined });
        await harness.create();
        expectNoSpawn();
        expect(httpRequests.filter((request) => request.path === '/v2/account/settings' && request.method === 'POST')).toEqual([]);
    });

    it('retains recent-path selection while fail-closing an unrepresentable configured backend target', async () => {
        const harness = await mount({
            recentMachinePaths: [
                { machineId: 'm1', path: '/old/a' }, { machineId: 'm1', path: '/tmp' },
                { machineId: 'm2', path: '/other' },
            ],
        });
        await harness.create();
        await vi.waitFor(() => expect(harness.storage.getState().authoringMemory.recentMachinePaths).toEqual([
            { machineId: 'm1', path: '/tmp' }, { machineId: 'm1', path: '/old/a' },
            { machineId: 'm2', path: '/other' },
        ]));
        expect(harness.storage.getState().settings.lastUsedBackendTarget).toEqual(configuredTarget);
        expectNoSpawn();
    });

    it('fails closed without private spawning for an unresolved plugin backend target', async () => {
        const target = { kind: 'backend', backendId: 'acme.review.backend' } as const;
        const harness = await mount({ agentType: 'claude', backendTarget: target, spawnBackendTarget: target });
        await harness.create();
        expectNoSpawn();
        await vi.waitFor(() => expect(harness.storage.getState().authoringMemory.recentMachinePaths)
            .toEqual([{ machineId: 'm1', path: '/tmp' }]));
        expect(harness.storage.getState().settings.lastUsedBackendTarget).toEqual(target);
    });

    it('does not save an automation for an unrepresentable configured ACP target', async () => {
        const harness = await mount({
            authoringDraft: buildNewSessionAuthoringDraft({
                executionTarget: null, organizationPlacement: { folderId: null, tagIds: [] },
                directory: '/tmp', checkoutCreationDraft: null, prompt: '', displayText: '',
                agentTarget: null, transcriptStorage: null, profileId: null,
                environmentVariables: null, resumeSessionId: null, permissionMode: 'default',
                permissionModeUpdatedAt: null, modelId: null, modelUpdatedAt: null,
                mcpSelection: null, connectedServices: null, terminal: null,
                windowsRemoteSessionLaunchMode: null, windowsRemoteSessionConsole: null,
                acpSessionModeId: null, sessionConfigOptionOverrides: null,
                automation: {
                    pendingAutomationId: 'automation-11111111-1111-4111-8111-111111111111',
                    enabled: true, name: 'Nightly', description: '',
                    triggers: [{ clientId: '22222222-2222-4222-8222-222222222222', definition: {
                        kind: 'schedule', enabled: true,
                        schedule: { kind: 'interval', everyMs: 60 * 60_000, scheduleExpr: null, timezone: null },
                    } }],
                },
            }),
        });
        await harness.create();
        expectNoSpawn();
    });

    it('retains the configured backend selection state when only legacy customAcp carriers remain', async () => {
        const target = { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot', sourceKind: 'configured' } as const;
        const harness = await mount({ backendTarget: target });
        await harness.create();
        await vi.waitFor(() => expect(harness.storage.getState().authoringMemory.recentMachinePaths)
            .toEqual([{ machineId: 'm1', path: '/tmp' }]));
        expect(harness.storage.getState().settings.lastUsedBackendTarget).toEqual(target);
        expectNoSpawn();
    });

    it('does not enter the private first-turn follow-up path for an unrepresentable configured target', async () => {
        const harness = await mount({ promptStore: createNewSessionPromptStore('launch the session') });
        const { saveNewSessionDraft, loadNewSessionDraft } = await import('@/sync/domains/state/persistence');
        saveNewSessionDraft({
            input: 'launch the session', selectedMachineId: 'm1', selectedPath: '/tmp',
            selectedProfileId: null, agentType: 'customAcp', backendTarget: configuredTarget,
            selectedSecretId: null, acpSessionModeId: null,
            permissionMode: 'default', modelMode: 'default', updatedAt: 1,
        }, harness.params.draftScope);
        const before = loadNewSessionDraft(harness.params.draftScope);
        await harness.create();
        expectNoSpawn();
        expect(harness.router.replace).not.toHaveBeenCalled();
        expect(harness.storage.getState().sessionPending).toEqual({});
        expect(loadNewSessionDraft(harness.params.draftScope)).toEqual(before);
        expect(harness.disableDraftPersistence).not.toHaveBeenCalled();
    });

    it('does not enter route hydration for an unrepresentable configured backend target', async () => {
        const harness = await mount({ promptStore: createNewSessionPromptStore('launch the session') });
        const before = harness.storage.getState().sessions;
        await harness.create();
        expectNoSpawn();
        expect(harness.storage.getState().sessions).toEqual(before);
        expect(harness.storage.getState().sessionPending).toEqual({});
        expect(harness.router.replace).not.toHaveBeenCalled();
    });
});
