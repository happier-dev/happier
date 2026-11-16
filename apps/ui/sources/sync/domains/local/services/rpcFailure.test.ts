import { afterEach, describe, expect, it, vi } from 'vitest';
import { RpcError, RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { markRpcRequestDisposition } from '@happier-dev/sync-client';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () =>
    (await import('@/dev/testkit/mocks/serverScopedRpc')).createServerScopedMachineRpcBoundaryMock(rpc));

import * as launcher from './launch/machineRpc';
import * as preview from './preview/machineRpc';
import * as inventory from './inventory/machineRpc';
import { executeLocalServiceActionViaMachineRpc } from './actions/machineRpc';

const target = { machineId: 'machine_1', targetId: 'target_1' };
const operations = [
    ['launcher snapshot', () => launcher.fetchLocalServiceLauncherSnapshotViaMachineRpc(target)],
    ['launcher watch', () => launcher.watchLocalServiceLauncherSnapshotViaMachineRpc({ ...target, targets: [] })],
    ['launcher start', () => launcher.startLocalServiceLauncherTargetViaMachineRpc(target)],
    ['launcher open', () => launcher.openLocalServiceLauncherPreviewViaMachineRpc(target)],
    ['launcher register', () => launcher.registerLocalServiceLauncherPreviewViaMachineRpc(target)],
    ['launcher history', () => launcher.clearLocalServiceLauncherHistoryViaMachineRpc(target)],
    ['preview snapshot', () => preview.fetchLocalServicePreviewSnapshotViaMachineRpc(target)],
    ['preview open', () => preview.openOrCreateLocalServicePreviewViaMachineRpc({ request: {
        machineId: target.machineId, inventoryEntryId: 'entry_1',
    } })],
    ['preview revoke', () => preview.revokeLocalServicePreviewViaMachineRpc({ request: {
        machineId: target.machineId, previewId: 'preview_1',
    } })],
    ['inventory snapshot', () => inventory.fetchLocalServiceInventorySnapshotViaMachineRpc(target)],
    ['inventory count', () => inventory.fetchLocalServiceInventorySummaryViaMachineRpc(target)],
    ['inventory refresh', () => inventory.fetchLocalServiceInventorySnapshotViaMachineRpc({ ...target, refresh: true })],
    ['inventory watch', () => inventory.watchLocalServiceInventorySnapshotViaMachineRpc(target)],
] as const;

describe('Services transport failure projection', () => {
    afterEach(() => rpc.mockReset());
    it.each(operations)('retains typed refusal evidence in %s for returned and thrown carriers', async (_name, run) => {
        const failureCause = { phase: 'rpc.discovery', errorClass: 'RpcError',
            errorCode: RPC_ERROR_CODES.CLIENT_NOT_AVAILABLE, httpStatus: null };
        const returned = { error: 'private request details', errorCode: RPC_ERROR_CODES.CLIENT_NOT_AVAILABLE, failureCause };
        rpc.mockResolvedValueOnce(returned);
        await expect(run()).resolves.toMatchObject({ ok: false, reason: 'request_failed',
            reasonCode: returned.errorCode, failureCause });
        rpc.mockRejectedValueOnce(markRpcRequestDisposition(new RpcError(returned.error, returned.errorCode, failureCause), 'notSent'));
        await expect(run()).resolves.toMatchObject({ ok: false, reason: 'request_failed',
            reasonCode: returned.errorCode, failureCause });
    });
    it.each(operations)('retains an uncoded handler exception phase in %s', async (_name, run) => {
        const failureCause = { phase: 'rpc.handler' };
        rpc.mockResolvedValueOnce({ error: 'private handler details', failureCause });
        await expect(run()).resolves.toMatchObject({ ok: false, reason: 'request_failed',
            reasonCode: 'action_failed', failureCause });
    });
    it('retains a lost launcher acknowledgement as unknown with its transport cause', async () => {
        const failureCause = { phase: 'rpc.dispatch', errorClass: 'RpcError',
            errorCode: RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE, httpStatus: null };
        rpc.mockRejectedValueOnce(new RpcError('private request details', RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE, failureCause));
        await expect(launcher.startLocalServiceLauncherTargetViaMachineRpc(target)).resolves.toEqual({
            ok: false, reason: 'outcome_unknown', reasonCode: RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE, failureCause,
        });
    });
    it.each(operations.filter(([name]) => name === 'preview open' || name === 'preview revoke'))(
        'preserves the existing lifecycle refusal and authored cause in %s', async (_name, run) => {
            const failureCause = { phase: 'localServices.preview.openOrCreate', errorClass: 'RpcError',
                errorCode: 'preview_target_unresolved', httpStatus: null };
            const errorCode = 'local_service_preview_lifecycle_refused';
            const error = 'local_service_preview_lifecycle_refused:preview_target_unresolved';
            rpc.mockResolvedValueOnce({ error, errorCode, failureCause });
            await expect(run()).resolves.toMatchObject({ ok: false, reason: 'refused:preview_target_unresolved', failureCause });
            rpc.mockRejectedValueOnce(new RpcError(error, errorCode, failureCause));
            await expect(run()).resolves.toMatchObject({ ok: false, reason: 'refused:preview_target_unresolved', failureCause });
        },
    );
    it('keeps Action refusal metadata through the existing failure envelope', async () => {
        const failureCause = { phase: 'rpc.discovery', errorClass: 'RpcError',
            errorCode: RPC_ERROR_CODES.CLIENT_NOT_AVAILABLE, httpStatus: null };
        const request = { requestId: 'request_1', target: { kind: 'inventory_entry' as const,
            inventoryEntryId: 'entry_1', machineId: target.machineId }, action: 'copy_url' as const, force: false };
        rpc.mockRejectedValueOnce(new RpcError('private request details', RPC_ERROR_CODES.CLIENT_NOT_AVAILABLE, failureCause));
        await expect(executeLocalServiceActionViaMachineRpc({ request })).resolves.toMatchObject({
            ok: false, reason: 'refused', failure: { errorCode: RPC_ERROR_CODES.CLIENT_NOT_AVAILABLE, failureCause },
        });
    });
});
