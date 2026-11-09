import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import {
    CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION} from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import {
    MACHINE_PLAIN_DATA_KEY_MARKER,
    encodePlainMachineStoredContent} from '@happier-dev/protocol/machines/machineStoredContent';
import {
    type MachinePoolSelectionOriginV1,
} from '@happier-dev/protocol/machines/pools/v1';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { projectSessionSpawnNewActionInputV2 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { createExistingSessionDirectoryPreflightResult } from '@/dev/testkit/fixtures/sessionFixtures';
import { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { getStorage } from '@/sync/domains/state/storage';
import { fetchAndApplyMachines } from '@/sync/engine/machines/syncMachines';
import { buildNewSessionAuthoringDraft, buildSessionSpawnNewInputV2FromAuthoringDraft } from '@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters';
import { createDefaultActionExecutor } from './defaultActionExecutor';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { MachineAccessGrantsListResponseV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
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

// The transport owners are static imports; bind Socket.IO before their graph loads.
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

// Keep the real Socket.IO client and exact Account-scoped RPC owner. Only
// network connection and daemon acknowledgements are substituted.
installDisconnectedServerSocketBoundary((socket) => {
    configureConnectedServerSocketBoundary(socket);
    vi.spyOn(socket, 'timeout').mockReturnValue(socket);
    vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event: string, payload: SocketRpcRequestPayload) => {
        if (event !== SOCKET_RPC_EVENTS.CALL) return { v: 1, ok: true, admittedSessionIds: [] };
        if (payload.method === `machine-a:${RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT}`) {
            return { ok: true, result: createExistingSessionDirectoryPreflightResult(payload.params) };
        }
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
        modelSelection: null, capabilitySelection: null, connectedServices: null, terminal: null,
        windowsRemoteSessionLaunchMode: null, windowsRemoteSessionConsole: null,
        windowsTerminalWindowName: null, runtimeDescriptorV1: null, acpSessionModeId: null,
        sessionConfigOptionOverrides: null, automation: null,
    });
    return projectSessionSpawnNewActionInputV2(buildSessionSpawnNewInputV2FromAuthoringDraft({
        draft, creationKey: 'creation-a', permissionMode: 'default', configurationUpdatedAtMs: 1, initialMessage: 'Hello',
    }));
}

describe('Session spawn first-dispatch placement origin', () => {
    let serverId: string;
    let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
    beforeEach(async () => {
        getStorage().setState(initialState, true);
        resetServerFeaturesClientForTests();
        invalidateAccountEncryptionModeCache();
        const request = async (url: RequestInfo | URL, init?: RequestInit) => {
            const pathname = new URL(String(url)).pathname;
            if (pathname === '/health' || pathname === '/v1/auth/ping') return Response.json({ ok: true });
            if (pathname === '/v1/features' || pathname === '/v1/features/authenticated') return Response.json(features);
            if (pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (pathname === '/v1/machines/machine-a/access') return Response.json(MachineAccessGrantsListResponseV1Schema.parse({
                machineId: 'machine-a', custodian: { accountId: 'alice', displayName: 'Alice' },
                access: { custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' },
                canManage: true, grants: [], ownDirectGrant: false, ownAccessSources: [],
            }));
            if (pathname === '/v1/machines/read-batch' && init?.method === 'POST') {
                return createMachineReadBatchResponseFixture(init.body, id => id === 'machine-a'
                    ? createPlainMachineRowFixture({ id, accountId: 'alice' }) : null);
            }
            if (pathname === '/v1/machines/machine-a') return Response.json({
                machine: createPlainMachineRowFixture({ id: 'machine-a', accountId: 'alice' }),
            });
            // Unimplemented background endpoints are HTTP refusals, not a
            // failed network dial that marks this otherwise reachable Home offline.
            return Response.json({ error: 'not_found' }, { status: 404 });
        };
        connection = await restoreServerAccountForTest({ serverUrl: 'https://spawn-origin.test', accountId: 'alice', credentials: { token }, request });
        serverId = connection.serverId;
        outgoingServerId = serverId;
        setRuntimeFetch(request);
        vi.stubGlobal('fetch', vi.fn(request));
        await getServerFeaturesSnapshot({ serverId, force: true });
        outgoing.length = 0;
    });
    afterEach(async () => {
        await connection.dispose();
        await serverScopedRpcSocketPool.stopAll();
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
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { type: 'success' } });
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
