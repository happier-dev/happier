import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
    MACHINE_PLAIN_DATA_KEY_MARKER,
    decodePlainArtifactStoredContent,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { getStorage } from '@/sync/domains/state/storage';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

const machineRpcWithServerScope = vi.hoisted(() => vi.fn());

// Record daemon requests at Socket.IO; scoped routing, codecs and Action owners run normally.
vi.mock('socket.io-client', async (importOriginal) => {
    const actual = await importOriginal<typeof import('socket.io-client')>();
    const { createSocketIoBoundaryStub } = await import('@/dev/testkit/mocks/socketIo');
    const { SOCKET_RPC_EVENTS } = await import('@happier-dev/protocol/socketRpc');
    return { ...actual, io: (serverUrl: string) => {
        const { socket } = createSocketIoBoundaryStub();
        socket.emitWithAck.mockImplementation(async (event, payload) => {
            if (event !== SOCKET_RPC_EVENTS.CALL || !payload || typeof payload !== 'object') {
                return { v: 1, ok: true, admittedSessionIds: [] };
            }
            const request = payload as { method: string; params: unknown };
            const separator = request.method.indexOf(':');
            try {
                return { ok: true, result: await machineRpcWithServerScope({
                    machineId: request.method.slice(0, separator),
                    method: request.method.slice(separator + 1),
                    payload: request.params,
                    serverUrl,
                }) };
            } catch (error) {
                if (!(error instanceof Error)) throw error;
                const errorCode: unknown = Reflect.get(error, 'rpcErrorCode');
                return { ok: false, error: error.message, ...(typeof errorCode === 'string' ? { errorCode } : {}) };
            }
        });
        return socket;
    } };
});

import {
    resolveWorkspaceSyncConflict,
    getWorkspaceSyncStatus,
    listWorkspaceSyncConflicts,
    listWorkspaceSyncStatuses,
    readWorkspaceSyncFile,
    disableWorkspaceSyncRelationship,
    enableWorkspaceSyncRelationship,
    terminatePersistedWorkspaceSyncRelationship,
    inspectWorkspaceSyncLegacyState,
    inspectWorkspaceSyncConflict,
} from './workspaceSync';

const status = {
    relationshipId: 'relationship-1',
    controllerMachineId: 'machine-controller',
    state: 'watching' as const,
    alphaPath: '/alpha',
    betaPath: '/beta',
    mode: 'keep_synced' as const,
    endpointStates: {
        alpha: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
        beta: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
    },
    conflictCount: 1,
    lastCycleObservedAtMs: 42,
};

const initialStorageState = getStorage().getState();
const accountToken = createAccountTokenForTests('workspace-sync-account');
const features = {
    features: {},
    capabilities: {
        accountStoredContentCompatibility: {
            v: 1,
            minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
            currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
            declarationTransport: 'http-header-and-socket-auth-v1',
        },
    },
};

describe('workspace sync UI operations', () => {
    let actionServerId: string;
    const artifacts = createArtifactStoreBoundary({
        ownerAccountId: () => 'workspace-sync-account',
        encryptionMode: 'plain',
    });

    beforeEach(async () => {
        getStorage().setState(initialStorageState, true);
        resetServerFeaturesClientForTests();
        invalidateAccountEncryptionModeCache();
        actionServerId = (await upsertAndActivateServer({ serverUrl: 'https://workspace-sync-action.test', name: 'Home' })).id;
        getStorage().getState().activateProfileScope({ serverId: actionServerId, accountId: 'workspace-sync-account' });
        getStorage().setState({ settingsScope: { serverId: actionServerId, accountId: 'workspace-sync-account' } });
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token: accountToken });
        vi.stubGlobal('fetch', vi.fn(async () => Response.json(features)));
        await getServerFeaturesSnapshot({ serverId: actionServerId, force: true });
        artifacts.clear();
        setRuntimeFetch(async (url, init) => {
            const pathname = new URL(String(url)).pathname;
            if (pathname === '/v1/features') return Response.json(features);
            if (pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (pathname === '/v1/auth/ping') return Response.json({ ok: true });
            if (pathname === '/v1/machines/machine-controller') {
                return Response.json({ machine: { id: 'machine-controller', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } });
            }
            const artifactResponse = artifacts.handle(pathname, init);
            if (artifactResponse) return await artifactResponse;
            throw new Error(`Unexpected workspace sync Action request: ${pathname}`);
        });
        machineRpcWithServerScope.mockReset();
    });

    afterEach(() => {
        resetRuntimeFetch();
        resetServerFeaturesClientForTests();
        invalidateAccountEncryptionModeCache();
        getStorage().setState(initialStorageState, true);
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('reinspects legacy state without publishing a cleanup mutation', async () => {
        machineRpcWithServerScope.mockResolvedValueOnce({
            status: 'legacy_workspace_sync_state_unsupported',
            classification: 'retired_v1',
            quarantinePath: '/private/state/workspace-replication.retired-123',
            schemaVersion: 1,
        });

        await expect(inspectWorkspaceSyncLegacyState({ controllerMachineId: 'machine-controller' }))
            .resolves.toMatchObject({ classification: 'retired_v1', schemaVersion: 1 });
        expect(machineRpcWithServerScope).toHaveBeenCalledWith({
            machineId: 'machine-controller',
            serverUrl: 'https://workspace-sync-action.test',
            method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_LEGACY_INSPECT,
            payload: {},
        });
    });

    it('reads strictly validated status through the relationship controller machine', async () => {
        machineRpcWithServerScope
            .mockResolvedValueOnce({ statuses: [status] })
            .mockResolvedValueOnce({ status });

        await expect(listWorkspaceSyncStatuses({
            controllerMachineId: 'machine-controller',
            serverId: actionServerId,
        })).resolves.toEqual([status]);
        await expect(getWorkspaceSyncStatus({
            controllerMachineId: 'machine-controller',
            serverId: actionServerId,
            relationshipId: 'relationship-1',
        })).resolves.toEqual(status);

        expect(machineRpcWithServerScope).toHaveBeenNthCalledWith(1, {
            machineId: 'machine-controller',
            serverUrl: 'https://workspace-sync-action.test',
            method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_LIST,
            payload: {},
        });
        expect(machineRpcWithServerScope).toHaveBeenNthCalledWith(2, {
            machineId: 'machine-controller',
            serverUrl: 'https://workspace-sync-action.test',
            method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_GET,
            payload: { relationshipId: 'relationship-1' },
        });
    });

    it('maps transient and conflict commands without inventing client-side state', async () => {
        const phases: string[] = [];
        const resolution = { endpoints: [
            { workspaceRefId: 'workspace-alpha', status: 'applied' as const },
            { workspaceRefId: 'workspace-beta', status: 'applied_paused' as const },
        ] };
        machineRpcWithServerScope
            .mockResolvedValueOnce({
                status: 'page',
                relationshipId: 'relationship-1',
                totalCount: 1,
                nextCursor: null,
                conflicts: [{
                    relationshipId: 'relationship-1',
                    path: 'README.md',
                    alpha: { kind: 'file', digest: 'a'.repeat(40) },
                    beta: { kind: 'file', digest: 'b'.repeat(40) },
                }],
            })
            .mockResolvedValueOnce(resolution);

        await expect(listWorkspaceSyncConflicts({
            controllerMachineId: 'machine-controller',
            serverId: actionServerId,
            relationshipId: 'relationship-1',
        })).resolves.toMatchObject({ status: 'page', totalCount: 1, nextCursor: null });
        await expect(resolveWorkspaceSyncConflict({
            controllerMachineId: 'machine-controller',
            serverId: actionServerId,
            onPhase: (phase) => phases.push(phase),
            request: {
                strategy: 'use_source',
                controllerMachineId: 'machine-controller',
                hubWorkspaceRefId: 'workspace-alpha',
                path: 'README.md',
                source: { workspaceRefId: 'workspace-alpha', expected: { kind: 'file', digest: 'a'.repeat(40), executable: false, size: 12 } },
                targets: [{ workspaceRefId: 'workspace-beta', expected: { kind: 'file', digest: 'b'.repeat(40), executable: true, size: 13 } }],
                relationshipIds: ['relationship-1'],
            },
        })).resolves.toEqual(resolution);
        expect(phases).toEqual(['requesting_approval', 'applying']);
        expect(machineRpcWithServerScope.mock.calls.map(([input]) => input.method)).toEqual([
            RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICTS_LIST,
            RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICT_RESOLVE,
        ]);
        expect(machineRpcWithServerScope.mock.calls[0]?.[0]).toMatchObject({
            payload: { relationshipId: 'relationship-1', limit: 100 },
        });
        const conflictRpc = machineRpcWithServerScope.mock.calls[1]?.[0];
        expect(conflictRpc).toMatchObject({
            machineId: 'machine-controller',
            serverUrl: 'https://workspace-sync-action.test',
            method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICT_RESOLVE,
            payload: {
                actionReceiptId: expect.any(String),
                actionInput: {
                    strategy: 'use_source',
                    controllerMachineId: 'machine-controller',
                    hubWorkspaceRefId: 'workspace-alpha',
                    path: 'README.md',
                    source: { workspaceRefId: 'workspace-alpha', expected: { kind: 'file', digest: 'a'.repeat(40), executable: false, size: 12 } },
                    targets: [{ workspaceRefId: 'workspace-beta', expected: { kind: 'file', digest: 'b'.repeat(40), executable: true, size: 13 } }],
                    relationshipIds: ['relationship-1'],
                },
            },
        });
        const persistedApproval = artifacts.read(conflictRpc.payload.actionReceiptId);
        expect(persistedApproval).toBeDefined();
        const persistedBodyEnvelope = decodePlainArtifactStoredContent(persistedApproval!.body);
        expect(persistedBodyEnvelope).toMatchObject({ body: expect.any(String) });
        if (
            !persistedBodyEnvelope
            || typeof persistedBodyEnvelope !== 'object'
            || !('body' in persistedBodyEnvelope)
            || typeof persistedBodyEnvelope.body !== 'string'
        ) {
            throw new Error('Workspace conflict approval was not persisted through the canonical plain Artifact envelope');
        }
        expect(JSON.parse(persistedBodyEnvelope.body)).toMatchObject({
            actionId: 'workspace.sync.conflict.resolve',
            status: 'executed',
            decision: { kind: 'approve' },
        });
    });

    it('propagates a failed approved conflict execution instead of masking it with a later status read', async () => {
        const conflictChanged = Object.assign(new Error('conflict_changed'), {
            rpcErrorCode: 'conflict_changed',
        });
        machineRpcWithServerScope
            .mockRejectedValueOnce(conflictChanged)
            .mockResolvedValueOnce({ status });

        await expect(resolveWorkspaceSyncConflict({
            controllerMachineId: 'machine-controller',
            serverId: actionServerId,
            request: {
                strategy: 'use_source',
                controllerMachineId: 'machine-controller',
                hubWorkspaceRefId: 'workspace-alpha',
                path: 'README.md',
                source: { workspaceRefId: 'workspace-alpha', expected: { kind: 'file', digest: 'a'.repeat(40), executable: false, size: 12 } },
                targets: [{ workspaceRefId: 'workspace-beta', expected: { kind: 'missing' } }],
                relationshipIds: ['relationship-1'],
            },
        })).rejects.toMatchObject({
            message: 'conflict_changed',
            code: 'conflict_changed',
        });

        expect(machineRpcWithServerScope.mock.calls.map(([input]) => input.method)).toEqual([
            RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICT_RESOLVE,
        ]);
    });

    it('inspects the complete endpoint set before previewing only a selected version', async () => {
        const metadata = {
            controllerMachineId: 'machine-controller', hubWorkspaceRefId: 'workspace-alpha', path: 'README.md',
            endpoints: [
                { workspaceRefId: 'workspace-alpha', outcome: 'observed', observation: { kind: 'file', digest: 'a'.repeat(40), executable: false, size: 12 }, selections: [] },
                { workspaceRefId: 'workspace-beta', outcome: 'observed', observation: { kind: 'missing' }, selections: [] },
            ],
            versions: [
                { endpointWorkspaceRefIds: ['workspace-alpha'], entry: { kind: 'file', digest: 'a'.repeat(40), executable: false, size: 12 } },
                { endpointWorkspaceRefIds: ['workspace-beta'], entry: { kind: 'missing' } },
            ], coverage: { complete: true },
        };
        machineRpcWithServerScope.mockResolvedValueOnce(metadata);
        await expect(inspectWorkspaceSyncConflict({
            controllerMachineId: 'machine-controller', serverId: actionServerId,
            request: { workspaceRefId: 'workspace-beta', path: 'README.md' },
        })).resolves.toEqual(metadata);
        expect(machineRpcWithServerScope).toHaveBeenCalledWith(expect.objectContaining({
            method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICT_INSPECT,
            payload: { workspaceRefId: 'workspace-beta', path: 'README.md' },
        }));
        expect(machineRpcWithServerScope).toHaveBeenCalledTimes(1);
    });

    it('validates bounded file previews and rejects malformed daemon responses', async () => {
        machineRpcWithServerScope
            .mockResolvedValueOnce({
                status: 'text',
                digest: 'c'.repeat(40),
                size: 5,
                text: 'hello',
            })
            .mockResolvedValueOnce({ statuses: [{ ...status, state: 'invented' }] });

        await expect(readWorkspaceSyncFile({
            controllerMachineId: 'machine-controller',
            serverId: actionServerId,
            request: {
                relationshipId: 'relationship-1',
                side: 'alpha',
                path: 'README.md',
                maxBytes: 1024,
            },
        })).resolves.toMatchObject({ status: 'text', text: 'hello' });
        await expect(listWorkspaceSyncStatuses({
            controllerMachineId: 'machine-controller',
            serverId: actionServerId,
        })).rejects.toThrow('Unsupported response');
    });

    it('routes each lifecycle intent through exactly one daemon operation', async () => {
        const scope = {
            controllerMachineId: 'machine-controller',
            serverId: actionServerId,
            relationshipId: 'relationship-1',
        };
        machineRpcWithServerScope
            .mockResolvedValueOnce({ ok: true })
            .mockResolvedValueOnce({ ok: true })
            .mockResolvedValueOnce({ ok: true });

        await expect(disableWorkspaceSyncRelationship(scope)).resolves.toBeUndefined();
        await expect(enableWorkspaceSyncRelationship(scope)).resolves.toBeUndefined();
        await expect(terminatePersistedWorkspaceSyncRelationship(scope)).resolves.toBeUndefined();
        expect(machineRpcWithServerScope.mock.calls.map(([input]) => input.method)).toEqual([
            RPC_METHODS.DAEMON_WORKSPACE_SYNC_PAUSE,
            RPC_METHODS.DAEMON_WORKSPACE_SYNC_RESUME,
            RPC_METHODS.DAEMON_WORKSPACE_SYNC_TERMINATE,
        ]);

        machineRpcWithServerScope.mockResolvedValueOnce({ status });
        await expect(disableWorkspaceSyncRelationship(scope)).rejects.toThrow('Unsupported response');
    });
});
