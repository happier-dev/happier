import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
    MACHINE_PLAIN_DATA_KEY_MARKER,
    encodePlainMachineStoredContent,
    type MachinePoolSelectionOriginV1,
} from '@happier-dev/protocol';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import type { SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { getStorage } from '@/sync/domains/state/storage';
import { fetchAndApplyMachines } from '@/sync/engine/machines/syncMachines';
import { buildNewSessionAuthoringDraft, buildSessionSpawnNewInputV2FromAuthoringDraft } from '@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters';
import { createDefaultActionExecutor } from './defaultActionExecutor';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { resetScopedMachineTransportCacheForTests } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool';
import { serverScopedRpcSocketPool } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool';

const initialState = getStorage().getState();
const outgoing: SocketRpcRequestPayload[] = [];
const token = createAccountTokenForTests('alice');
const origin = { kind: 'machine_pool', poolId: '00000000-0000-4000-8000-000000000001' } satisfies MachinePoolSelectionOriginV1;
const features = {
    features: {},
    capabilities: { accountStoredContentCompatibility: {
        v: 1, minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
        currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
        declarationTransport: 'http-header-and-socket-auth-v1',
    } },
};

// Keep the real Socket.IO client and exact Account-scoped RPC owner. Only
// network connection and daemon acknowledgements are substituted.
installDisconnectedServerSocketBoundary((socket) => {
    socket.connected = true;
    vi.spyOn(socket, 'timeout').mockReturnValue(socket);
    vi.spyOn(socket, 'emitWithAck').mockImplementation(async (_event: string, payload: SocketRpcRequestPayload) => {
        outgoing.push(payload);
        return { ok: true, result: {
            type: 'success', disposition: 'created', sessionId: 'session-created',
            executionTarget: { serverId: outgoingServerId, machineId: 'machine-a' },
            organizationPlacement: { folderId: null, tagIds: [] },
            initialInput: { status: 'accepted', localId: 'initial-message-a' },
        } };
    });
});
let outgoingServerId = '';

function buildSpawnInput(serverId: string) {
    const draft = buildNewSessionAuthoringDraft({
        executionTarget: { kind: 'machine', target: { serverId, machineId: 'machine-a' }, selectionOrigin: origin },
        organizationPlacement: { folderId: null, tagIds: [] }, directory: '/workspace',
        checkoutCreationDraft: null, prompt: 'Hello', displayText: 'Hello',
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        transcriptStorage: 'persisted', profileId: null, environmentVariables: null,
        resumeSessionId: null, permissionMode: 'default', permissionModeUpdatedAt: 1,
        modelSelection: null, mcpSelection: null, connectedServices: null, terminal: null,
        windowsRemoteSessionLaunchMode: null, windowsRemoteSessionConsole: null,
        windowsTerminalWindowName: null, runtimeDescriptorV1: null, acpSessionModeId: null,
        sessionConfigOptionOverrides: null, automation: null,
    });
    return buildSessionSpawnNewInputV2FromAuthoringDraft({
        draft, creationKey: 'creation-a', permissionMode: 'default', configurationUpdatedAtMs: 1, initialMessage: 'Hello',
    });
}

describe('Session spawn first-dispatch placement origin', () => {
    let serverId: string;
    beforeEach(async () => {
        getStorage().setState(initialState, true);
        resetServerFeaturesClientForTests();
        invalidateAccountEncryptionModeCache();
        serverId = (await upsertAndActivateServer({ serverUrl: 'https://spawn-origin.test', name: 'Home' })).id;
        outgoingServerId = serverId;
        getStorage().getState().activateProfileScope({ serverId, accountId: 'alice' });
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const request = async (url: RequestInfo | URL) => {
            const pathname = new URL(String(url)).pathname;
            if (pathname === '/health' || pathname === '/v1/auth/ping') return Response.json({ ok: true });
            if (pathname === '/v1/features') return Response.json(features);
            if (pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (pathname === '/v1/machines/machine-a') return Response.json({ machine: {
                id: 'machine-a', kind: 'persistent', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
            } });
            throw new Error(`Unexpected spawn preflight request: ${pathname}`);
        };
        setRuntimeFetch(request);
        vi.stubGlobal('fetch', vi.fn(request));
        await getServerFeaturesSnapshot({ serverId, force: true });
        outgoing.length = 0;
    });
    afterEach(() => {
        serverScopedRpcSocketPool.resetForTests();
        resetScopedMachineTransportCacheForTests();
        getStorage().setState(initialState, true);
        resetServerFeaturesClientForTests();
        invalidateAccountEncryptionModeCache();
        resetRuntimeFetch();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it.each([
        ['supported', { sessionSpawn: { protocolVersions: [1] }, sessionSpawnPlacementOrigin: { protocolVersions: [1] } }, true],
        ['absent', { sessionSpawn: { protocolVersions: [1] } }, false],
        ['unknown version', { sessionSpawn: { protocolVersions: [1] }, sessionSpawnPlacementOrigin: { protocolVersions: [2] } }, false],
    ] as const)('sends exact spawn with origin only when %s', async (_label, capabilities, expectedOrigin) => {
        await fetchAndApplyMachines({
            credentials: { token }, encryption: null, machineDataKeys: new Map(),
            request: async () => Response.json([{
                id: 'machine-a', metadata: encodePlainMachineStoredContent({ host: 'host-a' }),
                metadataVersion: 1, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
                seq: 1, active: true, activeAt: 1, createdAt: 1, updatedAt: 1,
                revokedAt: null, replacedByMachineId: null,
                operationProtocolCapabilities: capabilities, operationProtocolCapabilitiesRevision: 1,
            }]),
            applyMachines: (machines, replace) => getStorage().getState().applyMachines(machines, replace, { sourceServerId: serverId }),
            replace: true,
        });
        const input = buildSpawnInput(serverId);
        const result = await createDefaultActionExecutor().execute('session.spawn_new', input, { surface: 'ui', serverId });
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
        expect(outgoing).toHaveLength(1);
        expect(outgoing[0]?.method).toBe(`machine-a:${RPC_METHODS.SESSION_SPAWN_NEW}`);
        expect(outgoing[0]?.params).toMatchObject({ executionTarget: { serverId, machineId: 'machine-a' }, creationKey: 'creation-a' });
        if (expectedOrigin) expect(outgoing[0]?.params).toHaveProperty('placementOrigin', origin);
        else expect(outgoing[0]?.params).not.toHaveProperty('placementOrigin');
    });

    it('returns a typed update requirement before dispatching a Saved Secret overlay to a V1 daemon', async () => {
        await fetchAndApplyMachines({
            credentials: { token }, encryption: null, machineDataKeys: new Map(),
            request: async () => Response.json([{
                id: 'machine-a', metadata: encodePlainMachineStoredContent({ host: 'host-a' }),
                metadataVersion: 1, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
                seq: 1, active: true, activeAt: 1, createdAt: 1, updatedAt: 1,
                revokedAt: null, replacedByMachineId: null,
                operationProtocolCapabilities: { sessionSpawn: { protocolVersions: [1] } },
                operationProtocolCapabilitiesRevision: 1,
            }]),
            applyMachines: (machines, replace) => getStorage().getState().applyMachines(machines, replace, { sourceServerId: serverId }),
            replace: true,
        });

        const result = await createDefaultActionExecutor().execute('session.spawn_new', {
            ...buildSpawnInput(serverId),
            secretReferenceOverlay: { v: 1, bindings: { API_KEY: { ref: 'personal-secret' } } },
        }, { surface: 'ui', serverId });

        expect(result).toEqual({
            ok: true,
            result: {
                type: 'error',
                code: 'update_required',
                retryable: false,
                details: {
                    kind: 'update_required',
                    operation: 'session.spawn_new',
                    component: 'daemon',
                    reason: 'session_secret_reference_overlay_update_required',
                },
            },
        });
        expect(outgoing).toHaveLength(0);
    });
});
