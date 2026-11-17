import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RpcError } from '@happier-dev/protocol/rpcErrors';
import { MachineStoragePileResultV1Schema, MachineStoragePileSetInputV1Schema, PileApplyResultV1Schema, TrashEmptyResultV1Schema } from '@happier-dev/protocol/storage/storageV1';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

// Only the authenticated network is replaced; registration, Account admission, Action policy and decoding stay real.
const boundary = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(boundary.rpc);
});
const storageRpc = await import('./machineRpc');
const { machineStorageStore } = await import('./machineStorageStore');
const { Modal } = await import('@/modal');
// Load the real executor graph during collection rather than spending the first test's deadline on imports.
await import('@/sync/ops/actions/defaultActionExecutor');
const { fetchMachineStorageSummaryViaAction, fetchMachineStorageCategoryViaAction, refreshMachineStorageSizeViaAction, watchMachineStorageViaMachineRpc } = storageRpc;

const HOME = 'srv_storage_action';
const key = { serverId: HOME, machineId: 'machine-a', expectedAccountId: 'account-a' };
beforeEach(async () => {
    await homes.reset();
    boundary.rpc.mockReset().mockRejectedValue(new Error('Unexpected Machine mutation'));
    machineStorageStore.reset();
    vi.mocked(Modal.confirm).mockClear().mockResolvedValue(false);
    key.serverId = await homes.addHome({ name: 'Storage', serverUrl: 'https://storage-action.test',
        serverIdentityId: HOME, accountId: key.expectedAccountId, currentAccount: true });
});
afterEach(async () => { boundary.rpc.mockReset(); await homes.reset(); });

describe('storage Action and Machine RPC boundary', () => {
    it('preserves the teardown refusal and its closed recovery facts at the Storage receiver', async () => {
        const details = { kind: 'finiteCommand', phase: 'teardown', step: 0, exitCode: 7, signal: null };
        boundary.rpc.mockResolvedValueOnce({ ok: false, errorCode: 'project_setup_step_failed', error: 'Cleanup failed', details });
        expect(await storageRpc.deleteMachineStorageNowViaAction({ ...key, items: [reviewed()], reviewedByPerson: true }))
            .toMatchObject({ ok: false, reason: 'request_failed', errorCode: 'project_setup_step_failed', details });
    });

    it('preserves typed non-permission failures through Action reads and parked watches', async () => {
        const failureCause = { phase: 'dispatch' as const, errorClass: 'RpcError', errorCode: RPC_ERROR_CODES.FORBIDDEN, httpStatus: 403 };
        boundary.rpc.mockRejectedValue(new RpcError('Forbidden', RPC_ERROR_CODES.FORBIDDEN, failureCause));
        const failure = { ok: false, reason: 'request_failed', errorCode: RPC_ERROR_CODES.FORBIDDEN, failureCause };
        expect(await fetchMachineStorageSummaryViaAction(key)).toEqual(failure);
        expect(await watchMachineStorageViaMachineRpc(key)).toEqual(failure);
    });

    it('preserves unavailable policy through Action reads, effects and the parked watch', async () => {
        boundary.rpc.mockRejectedValue(new RpcError('Storage policy is unavailable', 'policy_unavailable'));
        expect(await fetchMachineStorageSummaryViaAction(key)).toMatchObject({ ok: false, reason: 'policy_unavailable' });
        expect(await storageRpc.checkMachineStorageItemsViaAction({ ...key, refs: [] })).toMatchObject({ ok: false, reason: 'policy_unavailable' });
        expect(await storageRpc.deleteMachineStorageNowViaAction({ ...key, items: [reviewed()], reviewedByPerson: true }))
            .toMatchObject({ ok: false, reason: 'policy_unavailable' });
        expect(await watchMachineStorageViaMachineRpc(key)).toMatchObject({ ok: false, reason: 'policy_unavailable' });
        boundary.rpc.mockResolvedValueOnce({ status: 'unavailable', reason: 'policy_unavailable' });
        expect(await storageRpc.addMachineStorageProtectedFolderViaAction({ ...key, path: '/protected' }))
            .toMatchObject({ ok: false, reason: 'policy_unavailable' });
        boundary.rpc.mockResolvedValueOnce({ status: 'unavailable', reason: 'transport_unavailable' });
        expect(await storageRpc.addMachineStorageProtectedFolderViaAction({ ...key, path: '/protected' }))
            .toEqual({ ok: true, value: { status: 'unavailable', reason: 'transport_unavailable' } });
    });
    const reviewed = () => ({ ref: { itemId: 'log', path: '/logs/old', identity: { dev: '1', ino: '2', kind: 'file' as const },
        collectedAt: 100, collectedBy: { accountId: key.expectedAccountId, kind: 'person' as const } }, expect: 'checked-log' });

    it('treats the review sheet as the one confirmation of a permanent delete', async () => {
        const item = reviewed();
        const receipt = PileApplyResultV1Schema.parse({ batchId: 'delete-a', mode: 'delete', inTrashBytes: 0, freedBytes: 64, outcomes: [{ itemId: item.ref.itemId, status: 'deleted' }] });
        boundary.rpc.mockResolvedValueOnce(receipt);
        expect(await machineStorageStore.applyPile({ ...key, mode: 'delete', items: [item] })).toEqual({ ok: true, value: receipt });
        expect(Modal.confirm).not.toHaveBeenCalled();
        expect(boundary.rpc).toHaveBeenLastCalledWith(expect.objectContaining({ method: RPC_METHODS.DAEMON_STORAGE_DELETE_NOW,
            payload: { machineId: key.machineId, serverId: HOME, items: [{ ref: item.ref, expect: 'checked-log' }] } }));
    });

    it('sends a reviewed Docker cleanup once through its Action and returns the owner\'s typed result', async () => {
        const completed = { kind: 'completed', buildCache: 'unsupported', removed: ['sha256:a'], kept: ['sha256:b'] };
        boundary.rpc.mockResolvedValueOnce(completed);
        expect(await storageRpc.pruneMachineStorageDockerViaAction({ ...key, selection: { kind: 'unusedBuildCacheAndUnreferencedImages' }, reviewedByPerson: true }))
            .toEqual({ ok: true, value: completed });
        expect(Modal.confirm).not.toHaveBeenCalled();
        expect(boundary.rpc).toHaveBeenCalledOnce();
        expect(boundary.rpc).toHaveBeenLastCalledWith(expect.objectContaining({ method: RPC_METHODS.DAEMON_STORAGE_DOCKER_PRUNE,
            payload: { machineId: key.machineId, serverId: HOME, selection: { kind: 'unusedBuildCacheAndUnreferencedImages' } } }));
        const unsupported = { kind: 'unsupported', reason: 'native_runtime_unavailable', removed: [], kept: [] };
        boundary.rpc.mockResolvedValueOnce(unsupported);
        expect(await storageRpc.pruneMachineStorageDockerViaAction({ ...key, selection: { kind: 'unusedBuildCacheAndUnreferencedImages' }, reviewedByPerson: true }))
            .toEqual({ ok: true, value: unsupported });
    });

    it('deletes the reviewed items even if the caller changes its draft while admission loads', async () => {
        const item = reviewed();
        const receipt = PileApplyResultV1Schema.parse({ batchId: 'delete-reviewed', mode: 'delete', inTrashBytes: 0,
            freedBytes: 64, outcomes: [{ itemId: item.ref.itemId, status: 'deleted' }] });
        boundary.rpc.mockResolvedValueOnce(receipt);
        const pending = storageRpc.deleteMachineStorageNowViaAction({ ...key, items: [item], reviewedByPerson: true });
        item.expect = 'changed-after-confirmation';
        expect(await pending).toEqual({ ok: true, value: receipt });
        expect(boundary.rpc).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({
            items: [expect.objectContaining({ expect: 'checked-log' })],
        }) }));
        expect(Modal.confirm).not.toHaveBeenCalled();
    });

    it('still asks for an unreviewed permanent delete, and an explicit Ask first goes to approval without a receipt or mutation', async () => {
        const item = reviewed();
        expect(await storageRpc.deleteMachineStorageNowViaAction({ ...key, items: [item] })).toMatchObject({ ok: false, reason: 'declined' });
        expect(Modal.confirm).toHaveBeenCalledOnce();
        vi.mocked(Modal.confirm).mockClear();
        await homes.requireUiApproval(key.serverId, 'machines.storage.deleteNow');
        // An explicit Ask first is the person's own Action policy and the review does not replace it: the request waits
        // for that approval, and nothing reaches the machine until it is given.
        expect(await machineStorageStore.applyPile({ ...key, mode: 'delete', items: [item] })).toEqual({ ok: false, reason: 'approval_requested' });
        expect(Modal.confirm).not.toHaveBeenCalled();
        expect(boundary.rpc).not.toHaveBeenCalled();
        expect(machineStorageStore.getReceipt(key)).toBeNull();
    });

    it('lets shared policy decline Empty without changing the machine or producing a receipt', async () => {
        expect(await machineStorageStore.emptyTrash({ ...key, entryIds: ['entry-a'] }))
            .toMatchObject({ ok: false, reason: 'declined' });
        expect(Modal.confirm).toHaveBeenCalledOnce();
        expect(boundary.rpc).not.toHaveBeenCalled();
        expect(machineStorageStore.getReceipt(key)).toBeNull();
    });

    it('honors Allowed reviewed deletion and sends only the exact selected items through the strict Action', async () => {
        homes.answer(key.serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {
            actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1, actions: {},
                approvalWaivedSurfaces: { 'machines.storage.deleteNow': ['ui'], 'machines.storage.trash.empty': ['ui'] } }),
        } }, version: 1 } });
        const ref = { itemId: 'log', path: '/logs/old', identity: { dev: '1', ino: '2', kind: 'file' as const },
            collectedAt: 100, collectedBy: { accountId: key.expectedAccountId, kind: 'person' as const } };
        const receipt = PileApplyResultV1Schema.parse({ batchId: 'delete-a', mode: 'delete', inTrashBytes: 0, freedBytes: 64, outcomes: [{ itemId: ref.itemId, status: 'deleted' }] });
        boundary.rpc.mockResolvedValueOnce(receipt);
        expect(await machineStorageStore.applyPile({ ...key, mode: 'delete', items: [{ ref, expect: 'checked-log', claimedVerdict: 'keep' }] }))
            .toEqual({ ok: true, value: receipt });
        expect(boundary.rpc).toHaveBeenLastCalledWith(expect.objectContaining({ method: RPC_METHODS.DAEMON_STORAGE_DELETE_NOW,
            payload: { machineId: key.machineId, serverId: HOME, items: [{ ref, expect: 'checked-log' }] } }));
        expect(machineStorageStore.getReceipt(key)).toMatchObject({ kind: 'applied', result: receipt });
        const emptied = TrashEmptyResultV1Schema.parse({ outcomes: [{ entryId: 'entry-a', status: 'deleted' }], freedBytes: 32 });
        boundary.rpc.mockResolvedValueOnce(emptied);
        expect(await machineStorageStore.emptyTrash({ ...key, entryIds: ['entry-a'] })).toEqual({ ok: true, value: emptied });
        expect(boundary.rpc).toHaveBeenLastCalledWith(expect.objectContaining({ method: RPC_METHODS.DAEMON_STORAGE_TRASH_EMPTY,
            payload: { machineId: key.machineId, serverId: HOME, entryIds: ['entry-a'] } }));
        expect(Modal.confirm).not.toHaveBeenCalled();
    });

    it('collects a served reference through the real registered Action and decodes the daemon pile receipt', async () => {
        const served = { itemId: 'log', path: '/logs/old' };
        const receipt = MachineStoragePileResultV1Schema.parse({ revision: 2, items: [{ ...served,
            identity: { dev: '1', ino: '2', kind: 'file' }, collectedAt: 100,
            collectedBy: { accountId: 'account-a', kind: 'person' } }],
            summary: { count: 1, freesBytes: 64, droppedSinceLastView: [] } });
        const received: unknown[] = [];
        boundary.rpc.mockImplementation(async (input) => {
            expect(input).toMatchObject({ serverId: HOME, accountId: key.expectedAccountId, machineId: key.machineId,
                method: RPC_METHODS.DAEMON_STORAGE_PILE_SET });
            received.push(MachineStoragePileSetInputV1Schema.parse(input.payload));
            return receipt;
        });
        expect(await storageRpc.setMachineStoragePileViaAction({ ...key, add: [served], daemonStateVersion: 4,
            signal: new AbortController().signal }))
            .toEqual({ ok: true, value: receipt });
        expect(received).toEqual([{ serverId: HOME, machineId: key.machineId, add: [served] }]);
    });
    it('fails unavailable scan and protection operations closed without a direct RPC fallback', async () => {
        boundary.rpc.mockRejectedValue(new RpcError('Method not found', RPC_ERROR_CODES.METHOD_NOT_FOUND));
        expect(await storageRpc.fetchMachineStorageScanViaAction({ ...key, view: { tab: 'old', depth: 1, olderThanDays: 1000 } }))
            .toMatchObject({ ok: false, reason: 'older_happier' });
        expect(await storageRpc.startMachineStorageScanViaAction({ ...key, target: { folderPath: '/folder' } }))
            .toMatchObject({ ok: false, reason: 'older_happier' });
        expect(await storageRpc.addMachineStorageProtectedFolderViaAction({ ...key, path: '/folder' }))
            .toMatchObject({ ok: false, reason: 'older_happier' });
        expect(boundary.rpc.mock.calls.map(([input]) => input.method)).toEqual([
            RPC_METHODS.DAEMON_STORAGE_SCAN_GET, RPC_METHODS.DAEMON_STORAGE_SCAN_START, RPC_METHODS.DAEMON_STORAGE_PROTECTED_ADD,
        ]);
        expect(boundary.rpc.mock.calls[0][0].payload).toEqual({ machineId: key.machineId, serverId: HOME, view: { tab: 'old', depth: 1, olderThanDays: 1000 } });
    });

    it('distinguishes unavailable transport from a predecessor missing operation without issuing a fallback RPC', async () => {
        for (const code of [RPC_ERROR_CODES.METHOD_NOT_FOUND, RPC_ERROR_CODES.METHOD_NOT_AVAILABLE]) {
            boundary.rpc.mockReset().mockRejectedValue(new RpcError('Unavailable operation', code));
            const reason = code === RPC_ERROR_CODES.METHOD_NOT_FOUND ? 'older_happier' : 'request_failed';
            expect(await fetchMachineStorageSummaryViaAction(key)).toMatchObject({ ok: false, reason });
            expect(await fetchMachineStorageCategoryViaAction({ ...key, categoryId: 'logs', cursor: 'daemon-cursor' })).toMatchObject({ ok: false, reason });
            expect(await refreshMachineStorageSizeViaAction({ ...key, categoryId: 'logs' })).toMatchObject({ ok: false, reason });
            expect(boundary.rpc.mock.calls.map(([input]) => input.method)).toEqual([
                RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET, RPC_METHODS.DAEMON_STORAGE_CATEGORY_LIST, RPC_METHODS.DAEMON_STORAGE_SIZE_REFRESH,
            ]);
            expect(boundary.rpc.mock.calls[1][0]).toMatchObject({ serverId: HOME, accountId: key.expectedAccountId,
                payload: { serverId: HOME, machineId: key.machineId, categoryId: 'logs', cursor: 'daemon-cursor' } });
        }
    });

    it('parks on canonical Machine RPC with caller cancellation and rejects malformed replies', async () => {
        const controller = new AbortController();
        boundary.rpc.mockResolvedValueOnce({ changed: false });
        expect(await watchMachineStorageViaMachineRpc({ ...key, sinceRevision: 3, signal: controller.signal })).toEqual({ ok: true, value: { changed: false } });
        expect(boundary.rpc).toHaveBeenLastCalledWith(expect.objectContaining({
            serverId: key.serverId, accountId: key.expectedAccountId, machineId: key.machineId, method: RPC_METHODS.DAEMON_STORAGE_WATCH,
            payload: { serverId: key.serverId, machineId: key.machineId, sinceRevision: 3 }, signal: controller.signal,
        }));
        boundary.rpc.mockResolvedValueOnce({ changed: true });
        expect(await watchMachineStorageViaMachineRpc(key)).toMatchObject({ ok: false, reason: 'invalid_response' });
        boundary.rpc.mockRejectedValueOnce(new RpcError('Method not found', RPC_ERROR_CODES.METHOD_NOT_FOUND));
        expect(await watchMachineStorageViaMachineRpc(key)).toMatchObject({ ok: false, reason: 'older_happier' });
        controller.abort();
        expect(await watchMachineStorageViaMachineRpc({ ...key, signal: controller.signal })).toMatchObject({ ok: false, reason: 'request_failed' });
    });

    it('uses the scoped Action front door for pile deltas and retains only daemon-validated results', async () => {
        const value = MachineStoragePileResultV1Schema.parse({ revision: 2, items: [], summary: { count: 0, freesBytes: 0, droppedSinceLastView: [] } });
        boundary.rpc.mockResolvedValueOnce(value);
        expect(await storageRpc.setMachineStoragePileViaAction({ ...key, clear: true })).toEqual({ ok: true, value });
        expect(boundary.rpc).toHaveBeenLastCalledWith(expect.objectContaining({
            method: RPC_METHODS.DAEMON_STORAGE_PILE_SET, accountId: key.expectedAccountId,
            payload: { machineId: key.machineId, serverId: HOME, clear: true },
        }));
        boundary.rpc.mockResolvedValueOnce({ ...value, items: [{ path: '/unproven' }] });
        expect(await storageRpc.setMachineStoragePileViaAction({ ...key, clear: true })).toMatchObject({ ok: false, reason: 'invalid_response' });
    });

    it('refuses a wrong Account, disabled Action and cancelled intent before touching the machine', async () => {
        expect(await storageRpc.setMachineStoragePileViaAction({ ...key, expectedAccountId: 'another-account', clear: true }))
            .toMatchObject({ ok: false, reason: 'request_failed' });
        homes.answer(key.serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {
            actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1, actions: { 'machines.storage.pile.set': { enabled: false } } }),
        } }, version: 1 } });
        expect(await storageRpc.setMachineStoragePileViaAction({ ...key, clear: true }))
            .toMatchObject({ ok: false, reason: 'request_failed' });
        const controller = new AbortController();
        controller.abort();
        expect(await storageRpc.setMachineStoragePileViaAction({ ...key, clear: true, signal: controller.signal }))
            .toMatchObject({ ok: false, reason: 'request_failed' });
        expect(boundary.rpc).not.toHaveBeenCalled();
    });
});
