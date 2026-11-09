import { createWorkspaceSyncRelationshipsListFixture } from '@/dev/testkit/harness/workspaceSyncHarness';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION} from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import {
    computeWorkspaceSyncPolicyDigest} from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import {
    decodePlainArtifactStoredContent,
} from '@happier-dev/protocol/storage/artifactStoredContent';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { readWorkspaceSyncErrorCode } from '@/sync/domains/sessionHandoff/workspaceSyncPresentation';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { getActiveServerSnapshot, upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { getStorage } from '@/sync/domains/state/storage';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { serverScopedRpcSocketPool } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool';
import { publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';

const machineRpcWithServerScope = vi.hoisted(() => vi.fn());

vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
// Metro's deferred module loader is the boundary; the mounted/default executors remain real.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async importOriginal => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
    return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});

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
    watchWorkspaceSyncStatuses,
    readWorkspaceSyncFile,
    disableWorkspaceSyncRelationship,
    enableWorkspaceSyncRelationship,
    terminatePersistedWorkspaceSyncRelationship,
    inspectWorkspaceSyncLegacyState,
    inspectWorkspaceSyncConflict,
} from './workspaceSync';
import * as workspaceSyncOperations from './workspaceSync';

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
    let accountActionsSettings: unknown;
    const artifacts = createArtifactStoreBoundary({
        ownerAccountId: () => 'workspace-sync-account',
        encryptionMode: 'plain',
    });

    beforeEach(async () => {
        accountActionsSettings = undefined;
        getStorage().setState(initialStorageState, true);
        resetServerFeaturesClientForTests();
        invalidateAccountEncryptionModeCache();
        actionServerId = (await upsertAndActivateServer({ serverUrl: 'https://workspace-sync-action.test', name: 'Home' })).id;
        getStorage().getState().activateProfileScope({ serverId: actionServerId, accountId: 'workspace-sync-account' });
        getStorage().setState({ settingsScope: { serverId: actionServerId, accountId: 'workspace-sync-account' } });
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token: accountToken });
        vi.stubGlobal('fetch', vi.fn(async () => Response.json(features)));
        await getServerFeaturesSnapshot({ serverId: actionServerId, force: true });
        artifacts.clear();
        setRuntimeFetch(async (url, init) => {
            const pathname = new URL(String(url)).pathname;
            if (pathname === '/v1/features') return Response.json(features);
            if (pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (pathname === '/v1/auth/ping') return Response.json({ ok: true });
            if (pathname === '/v2/account/settings') return Response.json(accountActionsSettings
                ? { content: { t: 'plain', v: { actionsSettingsV1: accountActionsSettings } }, version: 1 }
                : { content: null, version: 0 });
            if (pathname === '/v1/machines/read-batch' && init?.method === 'POST') {
                return createMachineReadBatchResponseFixture(init.body, id => id === 'machine-controller'
                    ? createPlainMachineRowFixture({ id, accountId: 'workspace-sync-account' }) : null);
            }
            if (pathname === '/v1/machines/machine-controller') {
                return Response.json({ machine: createPlainMachineRowFixture({ id: 'machine-controller', accountId: 'workspace-sync-account' }) });
            }
            const artifactResponse = artifacts.handle(pathname, init);
            if (artifactResponse) return await artifactResponse;
            throw new Error(`Unexpected workspace sync Action request: ${pathname}`);
        });
        machineRpcWithServerScope.mockReset();
    });

    afterEach(async () => {
        // This suite retires its mocked network boundary after every case. The
        // real pool must release retained sockets before their mock is restored.
        await serverScopedRpcSocketPool.stopAll();
        publishAppliedActiveServerRuntimeAvailability(false);
        resetRuntimeFetch();
        resetServerFeaturesClientForTests();
        invalidateAccountEncryptionModeCache();
        getStorage().setState(initialStorageState, true);
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it.each([
        ['relationships', () => listWorkspaceSyncStatuses({ controllerMachineId: 'machine-controller' })],
        ['conflicts', () => listWorkspaceSyncConflicts({ controllerMachineId: 'machine-controller', relationshipId: 'relationship-1' })],
        ['inspection', () => inspectWorkspaceSyncConflict({ controllerMachineId: 'machine-controller', request: { workspaceRefId: 'alpha', path: 'file.txt' } })],
    ] as const)('preserves a daemon refusal through %s Action admission without retries', async (_label, read) => {
        machineRpcWithServerScope.mockResolvedValue({ error: 'Workspace relationship is unavailable', errorCode: 'relationship_not_ready' });
        const failure = await read().then(() => null, error => error);
        expect(readWorkspaceSyncErrorCode(failure)).toBe('relationship_not_ready');
        expect(machineRpcWithServerScope).toHaveBeenCalledTimes(1);
    });

    it('preserves modern daemon refusal envelopes before parsing flush status', () => {
        expect(() => workspaceSyncOperations.assertWorkspaceSyncRpcSuccess({
            error: 'Requester authority is unavailable', errorCode: 'project_requester_authority_unavailable',
            effectAttempted: false, failureCause: { phase: 'rpc.handler', errorClass: 'Error', errorCode: 'project_requester_authority_unavailable', httpStatus: null },
        })).toThrow(expect.objectContaining({ rpcErrorCode: 'project_requester_authority_unavailable', effectAttempted: false }));
    });

    it('builds the existing retirement input only from a strictly bound readonly target preview', async () => {
        const contentPolicy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [],
            policyDigest: computeWorkspaceSyncPolicyDigest({ v: 1, selection: 'all_files', extraIgnorePatterns: [], extraIncludePatterns: [] }) };
        const request = { kind: 'preview' as const, workspace: { serverId: actionServerId, refId: 'workspace-alpha' },
            machineId: 'machine-controller', targetMachineId: 'machine-target', targetWorkspaceRefId: 'workspace-beta',
            expectedRelationship: { v: 1 as const, relationshipId: 'relationship-1', controllerMachineId: 'machine-controller',
                alphaWorkspaceRefId: 'workspace-alpha', betaWorkspaceRefId: 'workspace-beta', mode: 'keep_synced' as const,
                contentPolicy, enabled: true, createdAtMs: 1, updatedAtMs: 1 } };
        const preview = { targetMachineId: 'machine-target', workspaceRefId: 'workspace-beta', rootFingerprint: 'a'.repeat(64), sizeBytes: 27 };
        machineRpcWithServerScope.mockResolvedValueOnce({ ok: true, preview });
        await expect(workspaceSyncOperations.getWorkspaceSyncCommittedCopyPreview({ accountId: 'workspace-sync-account', request }))
            .resolves.toEqual({ ok: true, preview, retirementInput: {
                workspace: request.workspace, machineId: request.machineId, expectedRelationship: request.expectedRelationship,
                removeTargetCopy: { workspaceRefId: preview.workspaceRefId, rootFingerprint: preview.rootFingerprint },
            } });
        expect(machineRpcWithServerScope).toHaveBeenCalledWith({ machineId: 'machine-controller',
            serverUrl: 'https://workspace-sync-action.test', method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_INSPECT, payload: request });
        machineRpcWithServerScope.mockResolvedValueOnce({ ok: true, preview: { ...preview, workspaceRefId: 'unrelated-workspace' } });
        await expect(workspaceSyncOperations.getWorkspaceSyncCommittedCopyPreview({ accountId: 'workspace-sync-account', request }))
            .rejects.toThrow();
        machineRpcWithServerScope.mockResolvedValueOnce({ ok: true, preview: { ...preview, canonicalRoot: '/private/path' } });
        await expect(workspaceSyncOperations.getWorkspaceSyncCommittedCopyPreview({ accountId: 'workspace-sync-account', request }))
            .rejects.toThrow();
        machineRpcWithServerScope.mockResolvedValueOnce({ ok: false, errorCode: 'workspace_copy_not_owned' });
        await expect(workspaceSyncOperations.getWorkspaceSyncCommittedCopyPreview({ accountId: 'workspace-sync-account', request }))
            .resolves.toEqual({ ok: false, errorCode: 'workspace_copy_not_owned' });
    });

    it.each([
        ['workspace.sync.relationships.list', () => listWorkspaceSyncStatuses({ controllerMachineId: 'machine-controller' })],
        ['workspace.sync.conflicts.list', () => listWorkspaceSyncConflicts({ controllerMachineId: 'machine-controller', relationshipId: 'relationship-1' })],
        ['workspace.sync.conflict.inspect', () => inspectWorkspaceSyncConflict({ controllerMachineId: 'machine-controller', request: { workspaceRefId: 'alpha', path: 'file.txt' } })],
    ] as const)('honors disabled UI admission for %s before any daemon read', async (actionId, read) => {
        accountActionsSettings = ActionsSettingsV1Schema.parse({ v: 1, actions: { [actionId]: { disabledSurfaces: ['ui'] } } });
        getStorage().getState().applySettingsLocal({ actionsSettingsV1: ActionsSettingsV1Schema.parse(accountActionsSettings) });
        machineRpcWithServerScope.mockResolvedValue({ statuses: [] });
        await expect(read()).rejects.toMatchObject({ code: 'action_disabled' });
        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
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
        // A later check must preserve the producer's historical clean completion, not relabel 42 as synced.
        const cleanStatus = { ...status, lastCleanSyncAtMs: 17 };
        machineRpcWithServerScope
            .mockResolvedValueOnce(createWorkspaceSyncRelationshipsListFixture([cleanStatus]))
            .mockResolvedValueOnce({ status: cleanStatus });

        await expect(listWorkspaceSyncStatuses({
            controllerMachineId: 'machine-controller',
            serverId: actionServerId,
        })).resolves.toEqual([cleanStatus]);
        await expect(getWorkspaceSyncStatus({
            controllerMachineId: 'machine-controller',
            serverId: actionServerId,
            relationshipId: 'relationship-1',
        })).resolves.toEqual(cleanStatus);

        expect(machineRpcWithServerScope).toHaveBeenNthCalledWith(1, {
            machineId: 'machine-controller',
            serverUrl: 'https://workspace-sync-action.test',
            method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIPS_LIST,
            payload: {},
        });
        expect(machineRpcWithServerScope).toHaveBeenNthCalledWith(2, {
            machineId: 'machine-controller',
            serverUrl: 'https://workspace-sync-action.test',
            method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_GET,
            payload: { relationshipId: 'relationship-1' },
        });
    });

    it('reads parked watch replies through the current controller and preserves the revision cursor', async () => {
        const snapshot = { revision: 42, statuses: [status] };
        machineRpcWithServerScope.mockResolvedValueOnce({ changed: true, snapshot }).mockResolvedValueOnce({ changed: false });
        const scope = { controllerMachineId: 'machine-controller', serverId: actionServerId };
        await expect(watchWorkspaceSyncStatuses(scope)).resolves.toEqual({ changed: true, snapshot });
        await expect(watchWorkspaceSyncStatuses({ ...scope, sinceRevision: 42 })).resolves.toEqual({ changed: false });
        expect(machineRpcWithServerScope.mock.calls.map(([request]) => [request.method, request.payload])).toEqual([
            [RPC_METHODS.DAEMON_WORKSPACE_SYNC_WATCH, {}],
            [RPC_METHODS.DAEMON_WORKSPACE_SYNC_WATCH, { sinceRevision: 42 }],
        ]);
    });

    it.each([
        { changed: true, snapshot: { revision: 42, statuses: [{ ...status, controllerMachineId: 'another-machine' }] } },
        { changed: true, snapshot: { revision: 42, statuses: [status], privateData: 'unexpected' } },
        { changed: false, statuses: [status] },
    ])('rejects a watch reply outside its strict controller-scoped envelope', async reply => {
        machineRpcWithServerScope.mockResolvedValueOnce(reply);
        await expect(watchWorkspaceSyncStatuses({ controllerMachineId: 'machine-controller', serverId: actionServerId })).rejects.toThrow();
        expect(machineRpcWithServerScope).toHaveBeenCalledOnce();
    });

    it('maps an explicitly Ask-configured conflict resolution through the persisted approval and daemon effect', async () => {
        // The ordinary UI default no longer manufactures an approval Artifact; this case exercises an explicit Ask.
        accountActionsSettings = ActionsSettingsV1Schema.parse({ v: 1, actions: {
            'workspace.sync.conflict.resolve': { approvalRequiredSurfaces: ['ui'] },
        } });
        getStorage().getState().applySettingsLocal({ actionsSettingsV1: ActionsSettingsV1Schema.parse(accountActionsSettings) });
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
        if (typeof persistedApproval?.body !== 'string') throw new Error('Workspace conflict approval body was not persisted');
        const persistedBodyEnvelope = decodePlainArtifactStoredContent(persistedApproval.body);
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
            .mockResolvedValueOnce({ ...createWorkspaceSyncRelationshipsListFixture([status]), relationships: [{
                ...createWorkspaceSyncRelationshipsListFixture([status]).relationships[0], status: { ...status, state: 'invented' },
            }] });

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
        })).rejects.toThrow();
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

    it.each([
        ['terminate', RPC_METHODS.DAEMON_WORKSPACE_SYNC_TERMINATE, { terminated: true }],
        ['disable', RPC_METHODS.DAEMON_WORKSPACE_SYNC_PAUSE, { enabled: false }],
        ['enable', RPC_METHODS.DAEMON_WORKSPACE_SYNC_RESUME, { enabled: true }],
        ['flush', RPC_METHODS.DAEMON_WORKSPACE_SYNC_FLUSH, { status }],
    ] as const)('preserves a committed %s receipt after the captured credential retires', async (operation, method, receipt) => {
        const { createDeferred } = await import('@/dev/testkit');
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const committed = createDeferred<void>();
        const response = createDeferred<void>();
        let effects = 0;
        machineRpcWithServerScope.mockImplementation(async request => {
            expect(request.method).toBe(method);
            effects++;
            committed.resolve();
            await response.promise;
            return operation === 'flush' ? { status } : { ok: true };
        });
        const actionId = `workspace.sync.relationship.${operation}` as const;
        const input = { controllerMachineId: 'machine-controller', relationshipId: 'relationship-1' };
        const context = { serverId: actionServerId, expectedAccountId: 'workspace-sync-account', surface: 'ui' as const };
        const executor = createDefaultActionExecutor({ presentUserActionConfirmation: async () => true });
        const pending = executor.execute(actionId, input, context);
        try {
            await committed.promise;
            await TokenStorage.setCredentialsForServerUrl('https://workspace-sync-action.test', { serverId: actionServerId }, {
                token: createAccountTokenForTests('replacement-account'),
            });
        } finally { response.resolve(); }
        const settled = await pending;
        expect(settled, JSON.stringify(settled)).toMatchObject({ ok: true, result: { v: 1, relationshipId: input.relationshipId, ...receipt } });
        expect(effects).toBe(1);
        // The next request uses the new credential; it cannot borrow the original Account's admission.
        vi.mocked(TokenStorage.getCredentialsForServerUrl).mockResolvedValue({ token: createAccountTokenForTests('replacement-account') });
        await expect(executor.execute(actionId, input, context)).resolves.toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
        expect(effects).toBe(1);
    });

    it.each(['disable', 'enable', 'flush'] as const)('keeps the default relationship adapter %s receipt after its active lifetime retires', async operation => {
        const { createDeferred } = await import('@/dev/testkit');
        const { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const actions = await import('@/sync/ops/actions/workspaceSyncRelationshipActions');
        const run = { disable: actions.disableWorkspaceSyncRelationshipAction, enable: actions.enableWorkspaceSyncRelationshipAction,
            flush: actions.flushWorkspaceSyncRelationshipAction }[operation];
        const lifetime = captureActiveServerAccountScopeLifetime();
        expect(lifetime?.isCurrent()).toBe(true);
        const committed = createDeferred<void>();
        const response = createDeferred<void>();
        let effects = 0;
        machineRpcWithServerScope.mockImplementation(async () => {
            effects++;
            committed.resolve();
            await response.promise;
            return operation === 'flush' ? { status } : { ok: true };
        });
        const input = { controllerMachineId: 'machine-controller', relationshipId: 'relationship-1' };
        const pending = run(input, lifetime);
        try {
            await committed.promise;
            retireActiveServerAccountScopeLifetime();
            expect(lifetime?.isCurrent()).toBe(false);
        } finally { response.resolve(); }
        await expect(pending).resolves.toMatchObject({ ok: true, relationshipId: input.relationshipId });
        await expect(run(input, lifetime)).resolves.toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
        expect(effects).toBe(1);
    });

    it('delivers a relationship receipt through the mounted executor after the active Home lifetime retires', async () => {
        const { createDeferred, renderHook } = await import('@/dev/testkit');
        const { useMountedActionExecution } = await import('@/components/approvals/useMountedActionExecution');
        const { enableWorkspaceSyncRelationshipAction } = await import('@/sync/ops/actions/workspaceSyncRelationshipActions');
        const { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const committed = createDeferred<void>();
        const response = createDeferred<void>();
        let effects = 0;
        machineRpcWithServerScope.mockImplementation(async () => {
            effects++;
            committed.resolve();
            await response.promise;
            return { ok: true };
        });
        const hook = await renderHook(() => useMountedActionExecution(actionServerId));
        await vi.waitFor(() => expect(hook.getCurrent().ready).toBe(true));
        const execute = hook.getCurrent().execute;
        const activeLifetime = captureActiveServerAccountScopeLifetime();
        expect(activeLifetime?.isCurrent()).toBe(true);
        const input = { controllerMachineId: 'machine-controller', relationshipId: 'relationship-1' };
        const pending = enableWorkspaceSyncRelationshipAction(input, null, execute);
        try {
            await committed.promise;
            // Focused Sync retires independently of this explicitly captured Account's invocation.
            retireActiveServerAccountScopeLifetime();
            expect(activeLifetime?.isCurrent()).toBe(false);
            response.resolve();
            await expect(pending).resolves.toMatchObject({ ok: true, relationshipId: input.relationshipId, enabled: true });
        } finally { response.resolve(); await hook.unmount(); }
        await expect(enableWorkspaceSyncRelationshipAction(input, null, execute)).resolves.toMatchObject({
            ok: false, errorCode: 'action_account_scope_changed',
        });
        expect(effects).toBe(1);
    });

    it('keeps the daemon\'s typed refusal of a lifecycle command from the transport to the Action result', async () => {
        const scope = {
            controllerMachineId: 'machine-controller',
            serverId: actionServerId,
            relationshipId: 'relationship-1',
        };
        // An encrypted transport delivers a handler refusal as the response value, not as a thrown error.
        machineRpcWithServerScope.mockResolvedValue({ error: 'Workspace relationship is unavailable', errorCode: 'relationship_not_ready' });

        await expect(disableWorkspaceSyncRelationship(scope)).rejects.toMatchObject({ rpcErrorCode: 'relationship_not_ready' });
        await expect(enableWorkspaceSyncRelationship(scope)).rejects.toMatchObject({ rpcErrorCode: 'relationship_not_ready' });
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        await expect(createDefaultActionExecutor().execute('workspace.sync.relationship.disable', {
            controllerMachineId: scope.controllerMachineId,
            relationshipId: scope.relationshipId,
        }, { serverId: actionServerId, surface: 'ui' })).resolves.toMatchObject({ ok: false, errorCode: 'relationship_not_ready' });
    });
});
