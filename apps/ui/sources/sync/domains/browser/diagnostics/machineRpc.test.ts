import type { BrowserDiagnosticsSnapshotV1 } from '@happier-dev/protocol/browser/diagnostics/v1';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { afterEach, describe, expect, it, vi } from 'vitest';

const callGuardedMachineRpcWithPolicyMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc', () => ({
    callGuardedMachineRpcWithPolicy: (...args: readonly unknown[]) =>
        callGuardedMachineRpcWithPolicyMock(...args),
}));

function createSnapshot(overrides: Partial<BrowserDiagnosticsSnapshotV1> = {}): BrowserDiagnosticsSnapshotV1 {
    return {
        v: 1,
        machineId: 'machine_1',
        generatedAt: 1_000,
        refreshState: 'idle',
        events: [{
            v: 1,
            eventId: 'evt_console_1',
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 2,
            capturedAtMs: 950,
            family: 'console',
            kind: 'console.entry',
            fidelity: 'cdp',
            trusted: true,
            data: {
                level: 'log',
            },
            redaction: {
                level: 'metadataOnly',
                queryRedacted: true,
                headersRedacted: true,
                truncated: false,
            },
        }],
        diagnostics: [{
            code: 'daemon_browser_diagnostics_snapshot_ready',
        }],
        ...overrides,
    };
}

describe('browser diagnostics daemon snapshot machine RPC client', () => {
    afterEach(() => {
        callGuardedMachineRpcWithPolicyMock.mockReset();
    });

    it('keeps selected-request values in their separate result and rejects a mismatched request', async () => {
        const { fetchBrowserDiagnosticsRequestDetailViaMachineRpc } = await import('./machineRpc');
        const detail = { status: 'available', requestId: 'selected',
            requestBody: { status: 'unavailable', reason: 'not_captured' },
            responseBody: { status: 'available', text: 'fixture-private-body', encoding: 'utf8' },
            requestExtraInfo: [], responseExtraInfo: [] };
        callGuardedMachineRpcWithPolicyMock.mockResolvedValue({ protocolVersion: 1, snapshot: createSnapshot(), requestDetail: detail });
        const input = { machineId: 'machine_1', view: { browserSessionId: 'browser', viewId: 'view', navigationGeneration: 0 }, requestId: 'selected' };
        expect(await fetchBrowserDiagnosticsRequestDetailViaMachineRpc(input)).toEqual({ ok: true, detail });
        expect(await fetchBrowserDiagnosticsRequestDetailViaMachineRpc({ ...input, requestId: 'other' }))
            .toEqual({ ok: false, reason: 'invalid_response' });
    });

    it('returns a typed daemon diagnostics snapshot through guarded machine RPC', async () => {
        const snapshot = createSnapshot();
        callGuardedMachineRpcWithPolicyMock.mockResolvedValueOnce({
            protocolVersion: 1,
            snapshot,
        });
        const { fetchBrowserDiagnosticsSnapshotViaMachineRpc } = await import('./machineRpc');

        await expect(fetchBrowserDiagnosticsSnapshotViaMachineRpc({
            machineId: 'machine_1',
            serverId: 'server_1',
        })).resolves.toEqual({
            ok: true,
            snapshot,
        });

        expect(callGuardedMachineRpcWithPolicyMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine_1',
            serverId: 'server_1',
            method: RPC_METHODS.DAEMON_BROWSER_DIAGNOSTICS_SNAPSHOT,
            payload: { machineId: 'machine_1' },
        }));
    });

    it('keeps a scoped watch on the transport lifetime and returns the owner revision', async () => {
        const snapshot = createSnapshot();
        callGuardedMachineRpcWithPolicyMock.mockResolvedValueOnce({ protocolVersion: 1, snapshot, revision: 8 });
        const { fetchBrowserDiagnosticsSnapshotViaMachineRpc } = await import('./machineRpc');
        const view = { browserSessionId: 'browser_session_1', viewId: 'view_1', navigationGeneration: 2 };
        await expect(fetchBrowserDiagnosticsSnapshotViaMachineRpc({ machineId: 'machine_1', view, sinceRevision: 7 }))
            .resolves.toEqual({ ok: true, snapshot, revision: 8 });
        expect(callGuardedMachineRpcWithPolicyMock).toHaveBeenCalledWith(expect.objectContaining({
            payload: { machineId: 'machine_1', view, sinceRevision: 7 }, operationTimeoutMs: null,
        }));
    });

    it('returns unavailable when the daemon does not expose the snapshot method', async () => {
        callGuardedMachineRpcWithPolicyMock.mockResolvedValueOnce({
            errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
            error: 'Method not found',
        });
        const { fetchBrowserDiagnosticsSnapshotViaMachineRpc } = await import('./machineRpc');

        await expect(fetchBrowserDiagnosticsSnapshotViaMachineRpc({
            machineId: 'machine_1',
        })).resolves.toEqual({
            ok: false,
            reason: 'unavailable',
        });
    });

    it('fails closed for invalid or mismatched snapshot responses', async () => {
        callGuardedMachineRpcWithPolicyMock
            .mockResolvedValueOnce({
                protocolVersion: 1,
                snapshot: {
                    v: 1,
                    machineId: 'machine_1',
                    refreshState: 'idle',
                    events: [],
                    diagnostics: [],
                },
            })
            .mockResolvedValueOnce({
                protocolVersion: 1,
                snapshot: createSnapshot({ machineId: 'machine_2' }),
            });
        const { fetchBrowserDiagnosticsSnapshotViaMachineRpc } = await import('./machineRpc');

        await expect(fetchBrowserDiagnosticsSnapshotViaMachineRpc({
            machineId: 'machine_1',
        })).resolves.toEqual({
            ok: false,
            reason: 'invalid_response',
        });
        await expect(fetchBrowserDiagnosticsSnapshotViaMachineRpc({
            machineId: 'machine_1',
        })).resolves.toEqual({
            ok: false,
            reason: 'invalid_response',
        });
    });

    it('returns request_failed when guarded machine RPC transport throws', async () => {
        callGuardedMachineRpcWithPolicyMock.mockRejectedValueOnce(new Error('socket closed'));
        const { fetchBrowserDiagnosticsSnapshotViaMachineRpc } = await import('./machineRpc');

        await expect(fetchBrowserDiagnosticsSnapshotViaMachineRpc({
            machineId: 'machine_1',
        })).resolves.toEqual({
            ok: false,
            reason: 'request_failed',
        });
    });
});
