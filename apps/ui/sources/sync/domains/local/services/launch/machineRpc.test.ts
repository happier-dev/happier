import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DaemonLocalServiceLauncherStartRequestV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { markRpcRequestDisposition } from '@happier-dev/sync-client';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (...args: readonly unknown[]) =>
        machineRpcWithServerScopeMock(...args),
}));

await Promise.all([
    import('./machineRpc'),
    import('../actions/runtimeActionExecutor'),
    import('@/sync/ops/actions/defaultRuntimeActionExecutor'),
]);

const snapshot = {
    v: 1 as const,
    machineId: 'machine_1',
    sessionId: 'session_1',
    updatedAt: 1_000,
    targets: [],
};

const startResponse = {
    protocolVersion: 1 as const,
    machineId: 'machine_1',
    targetId: 'target_1',
    status: 'succeeded' as const,
    snapshot: {
        ...snapshot,
        updatedAt: 2_000,
        targets: [{
            id: 'target_1',
            source: 'managed_service' as const,
            machineId: 'machine_1',
            sessionId: 'session_1',
            title: 'Managed preview',
            confidence: 'medium' as const,
            state: 'starting' as const,
            actions: [],
        }],
    },
};

describe('local service launcher machine RPC client', () => {
    afterEach(() => {
        machineRpcWithServerScopeMock.mockReset();
    });

    it.each(['throw', 'result'] as const)('keeps temporary routing loss distinct from an unsupported launcher (%s)', async carrier => {
        const { openLocalServiceLauncherPreviewViaMachineRpc, fetchLocalServiceLauncherSnapshotViaMachineRpc,
            startLocalServiceLauncherTargetViaMachineRpc } = await import('./machineRpc');
        const target = { machineId: 'machine_1', serverId: 'server_1', targetId: 'target_1' };
        if (carrier === 'throw') machineRpcWithServerScopeMock.mockRejectedValue({ rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE });
        else machineRpcWithServerScopeMock.mockResolvedValue({ errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE, error: 'Method not found' });
        expect(await openLocalServiceLauncherPreviewViaMachineRpc(target)).toEqual({ ok: false, reason: 'request_failed' });
        expect(await fetchLocalServiceLauncherSnapshotViaMachineRpc(target)).toEqual({ ok: false, reason: 'request_failed' });
        expect(await startLocalServiceLauncherTargetViaMachineRpc(target)).toEqual({ ok: false, reason: 'request_failed' });
        machineRpcWithServerScopeMock.mockRejectedValueOnce({ rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
        expect(await openLocalServiceLauncherPreviewViaMachineRpc(target)).toEqual({ ok: false, reason: 'unavailable' });
    });

    it.each(['outcomeUnknown', 'unclassified', 'invalid_response'] as const)
    ('preserves uncertain native Start custody through the real Action-to-RPC composition (%s)', async disposition => {
        if (disposition === 'invalid_response') machineRpcWithServerScopeMock.mockResolvedValueOnce({ ...startResponse, targetId: 'wrong-target' });
        else machineRpcWithServerScopeMock.mockRejectedValueOnce(disposition === 'outcomeUnknown'
            ? markRpcRequestDisposition(new Error('acknowledgement_lost'), disposition)
            : new Error('acknowledgement_lost'));
        const { createDefaultRuntimeActionExecutor } = await import('@/sync/ops/actions/defaultRuntimeActionExecutor');
        await expect(createDefaultRuntimeActionExecutor()({ actionId: 'localServices.launcher.start',
            input: { machineId: 'machine_1', targetId: 'target_1' },
            context: { surface: 'ui', serverId: 'server_1', actionRequestId: 'start-request' },
        })).resolves.toMatchObject({ ok: false, errorCode: 'action_outcome_unknown', details: { requestId: 'start-request' } });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
    });

    it('keeps positive Start nonacceptance distinct from uncertain native custody', async () => {
        machineRpcWithServerScopeMock.mockRejectedValueOnce(markRpcRequestDisposition(new Error('not_connected'), 'notSent'));
        const { createDefaultRuntimeActionExecutor } = await import('@/sync/ops/actions/defaultRuntimeActionExecutor');
        await expect(createDefaultRuntimeActionExecutor()({ actionId: 'localServices.launcher.start',
            input: { machineId: 'machine_1', targetId: 'target_1' }, context: { surface: 'ui', serverId: 'server_1' },
        })).resolves.toMatchObject({ ok: false, errorCode: 'runtime_action_disabled' });
    });

    it('does not turn a cancelled observation into proof that an issued native Start was cancelled', async () => {
        const cancellation = new AbortController();
        machineRpcWithServerScopeMock.mockImplementationOnce(async () => {
            cancellation.abort();
            throw markRpcRequestDisposition(new Error('native_cancellation_unconfirmed'), 'outcomeUnknown');
        });
        const { createDefaultRuntimeActionExecutor } = await import('@/sync/ops/actions/defaultRuntimeActionExecutor');
        const { executeLocalServiceActionWithAdmission } = await import('@/components/sessions/localServices/localServiceActionAdmission');
        const runtime = createDefaultRuntimeActionExecutor();
        await expect(executeLocalServiceActionWithAdmission({
            // This carrier test admits only its named runtime leaf, not the full Action catalog.
            execute: args => args.actionId === 'localServices.launcher.start'
                ? runtime({ ...args, actionId: args.actionId })
                : Promise.resolve({ ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' }),
            request: { actionId: 'localServices.launcher.start', input: { machineId: 'machine_1', targetId: 'target_1' },
                context: { surface: 'ui', serverId: 'server_1' } },
            admission: { signal: cancellation.signal },
        })).resolves.toMatchObject({ ok: false, errorCode: 'action_outcome_unknown' });
    });

    it('routes the reviewed exact destination through the real launcher while preserving SOURCE declaration custody', async () => {
        const choice = { kind: 'workers', destination: { kind: 'machine', machineId: 'reviewed-worker' } } as const;
        // Only the Machine transport is replaced; parsing and both UI clients remain real.
        machineRpcWithServerScopeMock.mockImplementationOnce(async ({ machineId, payload }) => {
            expect(machineId).toBe('reviewed-worker');
            expect(payload).toMatchObject({ machineId: 'reviewed-worker', choice,
                workspace: { machineId: 'machine_1', workspaceId: 'source-ref' }, declaration: { workspaceRefId: 'source-ref' } });
            return { ...startResponse, machineId, status: 'denied', reasonCode: 'native_boundary_observed',
                snapshot: { ...startResponse.snapshot, machineId } };
        });
        const { startLocalServiceLauncherTargetViaMachineRpc } = await import('./machineRpc');
        const { createLocalServicesRuntimeActionExecutor } = await import('../actions/runtimeActionExecutor');
        const runtime = createLocalServicesRuntimeActionExecutor();
        const { buildLocalServiceLauncherStartRequest } = await import('@/components/sessions/localServices/launcherStartAction');
        const execute = createLocalServicesRuntimeActionExecutor({ startLauncherTarget: startLocalServiceLauncherTargetViaMachineRpc });
        const request = buildLocalServiceLauncherStartRequest({ target: { ...startResponse.snapshot.targets[0]!,
            workspace: { serverId: 'server_1', machineId: 'machine_1', workspaceId: 'source-ref', rootPath: '/source' },
            declaration: { workspaceRefId: 'source-ref', selection: { kind: 'manifest', name: 'server' } } }, choice });
        await expect(execute({ actionId: 'localServices.launcher.start', input: request,
            context: { surface: 'ui', serverId: 'server_1' } })).resolves.toMatchObject({ status: 'denied', reasonCode: 'native_boundary_observed' });
    });

    it.each(['localServices.launcher.history.clear', 'localServices.launcher.snapshot', 'localServices.launcher.start'] as const)
    ('keeps %s scoped to its workspace without replacing another workspace feed', async (actionId) => {
        const store = await import('./sharedStore');
        store.resetLocalServiceLauncherStoreForTests();
        const selectedKey = { machineId: 'machine_1', serverId: 'server_1', scope: 'workspace' as const, workspaceRoot: '/repo/web' };
        const otherKey = { ...selectedKey, workspaceRoot: '/repo/web-other' };
        const target = (id: string) => ({ id, source: 'inventory_entry' as const, machineId: 'machine_1',
            title: id, confidence: 'high' as const, state: 'available' as const, actions: [],
        });
        const selectedSnapshot = { v: 1 as const, machineId: 'machine_1', updatedAt: 1_000, targets: [target('selected-service')] };
        const otherSnapshot = { ...selectedSnapshot, targets: [target('other-service')] };
        // Only remote Machine transport is replaced. The runtime Action, strict
        // request/response clients and scoped subscription publication stay real.
        machineRpcWithServerScopeMock.mockImplementation(async ({ method, payload }: { method: string; payload: unknown }) => {
            const matches = payload !== null && typeof payload === 'object'
                && 'scope' in payload && payload.scope === 'workspace'
                && 'workspaceRoot' in payload && payload.workspaceRoot === selectedKey.workspaceRoot;
            if (method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT) {
                return { protocolVersion: 1, snapshot: matches ? selectedSnapshot : otherSnapshot };
            }
            if (method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START) {
                return { protocolVersion: 1, machineId: 'machine_1', targetId: 'selected-service', status: 'succeeded', snapshot: selectedSnapshot };
            }
            return { protocolVersion: 1, cleared: matches ? 1 : 0, snapshot: selectedSnapshot };
        });
        const unsubscribeSelected = store.subscribeLocalServiceLauncherStore(selectedKey, () => {});
        const unsubscribeOther = store.subscribeLocalServiceLauncherStore(otherKey, () => {});
        await new Promise<void>(resolve => queueMicrotask(resolve));
        await new Promise<void>(resolve => queueMicrotask(resolve));
        expect(store.getLocalServiceLauncherState(selectedKey).targetsById.has('selected-service')).toBe(true);
        const beforeOther = store.getLocalServiceLauncherState(otherKey);
        try {
            const { createDefaultRuntimeActionExecutor } = await import('@/sync/ops/actions/defaultRuntimeActionExecutor');
            const result = await createDefaultRuntimeActionExecutor()({ actionId,
                input: actionId === 'localServices.launcher.start' ? {
                    machineId: selectedKey.machineId, targetId: 'selected-service',
                    workspace: { serverId: selectedKey.serverId, machineId: selectedKey.machineId, workspaceId: 'workspace_1', rootPath: selectedKey.workspaceRoot },
                    declaration: { workspaceRefId: 'workspace_1', selection: { kind: 'manifest', name: 'web' } },
                } : { machineId: selectedKey.machineId, scope: selectedKey.scope, workspaceRoot: selectedKey.workspaceRoot },
                context: { surface: 'ui', serverId: selectedKey.serverId },
            });
            expect(result).toMatchObject(actionId === 'localServices.launcher.snapshot'
                ? { targets: selectedSnapshot.targets }
                : actionId === 'localServices.launcher.start' ? { protocolVersion: 1, status: 'succeeded' } : { protocolVersion: 1, cleared: 1 });
            expect(store.getLocalServiceLauncherState(otherKey)).toBe(beforeOther);
            expect(store.getLocalServiceLauncherState(selectedKey).targetsById.has('selected-service')).toBe(true);
        } finally { unsubscribeSelected(); unsubscribeOther(); store.resetLocalServiceLauncherStoreForTests(); }
    });

    it('keeps scoped history admission bound to the initiating Account and cancellation', async () => {
        const { renderHook } = await import('@/dev/testkit');
        const { useLocalServiceLauncherHistoryClearAction } = await import('@/components/sessions/localServices/lifecycleActions');
        const { createLocalServicesRuntimeActionExecutor } = await import('../actions/runtimeActionExecutor');
        const runtime = createLocalServicesRuntimeActionExecutor();
        const cancellation = new AbortController();
        machineRpcWithServerScopeMock.mockImplementationOnce(async (request) => {
            const admitted = request.accountId === 'initiating-account' && request.signal === cancellation.signal
                && request.payload.scope === 'workspace' && request.payload.workspaceRoot === '/repo/web';
            return { protocolVersion: 1, cleared: admitted ? 1 : 0, snapshot: { ...snapshot, sessionId: undefined } };
        });
        const hook = await renderHook(() => useLocalServiceLauncherHistoryClearAction({
            runtimeActionExecute: args => args.actionId === 'localServices.launcher.history.clear'
                ? runtime({ ...args, actionId: args.actionId })
                : Promise.resolve({ ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' }),
            machineId: 'machine_1', serverId: 'server_1', scope: 'workspace', workspaceRoot: '/repo/web',
            expectedAccountId: 'initiating-account', signal: cancellation.signal,
        }));
        try {
            const clear = hook.getCurrent();
            if (!clear) throw new Error('Expected a qualified workspace history action');
            await expect(clear()).resolves.toMatchObject({ protocolVersion: 1, cleared: 1 });
            cancellation.abort();
            await expect(clear()).resolves.toMatchObject({ ok: false, errorCode: 'cancelled' });
        } finally { await hook.unmount(); }
    });

    it('retains accepted native declaration and reviewed effect through the real runtime-to-RPC carrier', async () => {
        const workspace = { serverId: 'server_1', workspaceId: 'workspace_1', machineId: 'machine_1', rootPath: '/accepted/project' };
        const declaration = { workspaceRefId: 'workspace_1', selection: {
            kind: 'native' as const, source: { kind: 'native' as const, tool: 'package_script' as const, file: 'package.json', target: 'dev' },
        } };
        const expectedEffectDigest = 'a'.repeat(64);
        // Only the remote Machine RPC boundary is replaced. The runtime, strict request/response
        // schemas and launcher client are real; the receiver refuses a missing accepted declaration.
        machineRpcWithServerScopeMock.mockImplementation(async ({ payload }: { payload: unknown }) => {
            const request = DaemonLocalServiceLauncherStartRequestV1Schema.parse(payload);
            if (!request.workspace || !request.declaration) {
                return { ...startResponse, status: 'denied', reasonCode: 'launcher_start_declaration_unavailable' };
            }
            const reviewed = JSON.stringify(request.workspace) === JSON.stringify(workspace)
                && JSON.stringify(request.declaration) === JSON.stringify(declaration)
                && request.expectedEffectDigest === expectedEffectDigest;
            return reviewed ? startResponse : { ...startResponse, status: 'denied', reasonCode: 'project_service_effect_changed' };
        });
        const { startLocalServiceLauncherTargetViaMachineRpc } = await import('./machineRpc');
        const { createLocalServicesRuntimeActionExecutor } = await import('../actions/runtimeActionExecutor');
        const runtime = createLocalServicesRuntimeActionExecutor();
        const execute = createLocalServicesRuntimeActionExecutor({ startLauncherTarget: startLocalServiceLauncherTargetViaMachineRpc });
        const input = { machineId: 'machine_1', targetId: 'target_1', workspace, declaration, expectedEffectDigest, choice: { kind: 'primary' } };
        await expect(execute({ actionId: 'localServices.launcher.start', input,
            context: { surface: 'ui', serverId: 'server_1' } })).resolves.toMatchObject({ status: 'succeeded' });
        await expect(execute({ actionId: 'localServices.launcher.start', input: { ...input, expectedEffectDigest: 'invalid' },
            context: { surface: 'ui', serverId: 'server_1' } })).resolves.toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    });

    it('fetches daemon-owned launcher snapshots through machine RPC', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ protocolVersion: 1, snapshot });
        const { fetchLocalServiceLauncherSnapshotViaMachineRpc } = await import('./machineRpc');

        await expect(fetchLocalServiceLauncherSnapshotViaMachineRpc({
            machineId: 'machine_1',
            serverId: 'server_1',
            sessionId: 'session_1',
        })).resolves.toEqual({ ok: true, snapshot });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'machine_1',
            serverId: 'server_1',
            method: RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT,
            payload: { machineId: 'machine_1', sessionId: 'session_1' },
        });
    });

    it('requires the complete native read mode and captured Account at the remote snapshot boundary', async () => {
        const signal = new AbortController().signal;
        machineRpcWithServerScopeMock.mockImplementationOnce(async ({ accountId, signal: carriedSignal, payload }) => {
            if (accountId !== 'captured-owner' || carriedSignal !== signal || payload.projection !== 'managed_bindings') {
                return { errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE };
            }
            return { protocolVersion: 1, snapshot };
        });
        const { fetchLocalServiceLauncherSnapshotViaMachineRpc } = await import('./machineRpc');
        const input = { machineId: 'machine_1', serverId: 'server_1', accountId: 'captured-owner', signal,
            projection: 'managed_bindings' as const, workspaceRoot: '/accepted' };
        await expect(fetchLocalServiceLauncherSnapshotViaMachineRpc(input)).resolves.toEqual({ ok: true, snapshot });
    });

    it('fails closed for unavailable and mismatched daemon launcher responses', async () => {
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({
                errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
                error: 'Method not found',
            })
            .mockResolvedValueOnce({
                protocolVersion: 1,
                snapshot: { ...snapshot, machineId: 'machine_2' },
            });
        const { fetchLocalServiceLauncherSnapshotViaMachineRpc } = await import('./machineRpc');

        await expect(fetchLocalServiceLauncherSnapshotViaMachineRpc({
            machineId: 'machine_1',
        })).resolves.toEqual({ ok: false, reason: 'unavailable' });
        await expect(fetchLocalServiceLauncherSnapshotViaMachineRpc({
            machineId: 'machine_1',
        })).resolves.toEqual({ ok: false, reason: 'invalid_response' });
    });

    it('starts daemon-owned launcher targets through machine RPC', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce(startResponse);
        const { startLocalServiceLauncherTargetViaMachineRpc } = await import('./machineRpc');

        await expect(startLocalServiceLauncherTargetViaMachineRpc({
            machineId: 'machine_1',
            serverId: 'server_1',
            targetId: 'target_1',
            sessionId: 'session_1',
            workspaceId: 'workspace_1',
        })).resolves.toEqual({ ok: true, response: startResponse });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'machine_1',
            serverId: 'server_1',
            method: RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START,
            operationTimeoutMs: null,
            payload: {
                machineId: 'machine_1',
                targetId: 'target_1',
                sessionId: 'session_1',
                workspaceId: 'workspace_1',
            },
        });
    });

    it('opens a launcher preview through the LSV-1 leaf machine RPC method', async () => {
        const openPreviewResponse = {
            protocolVersion: 1 as const,
            status: 'opened' as const,
            targetId: 'target_1',
        };
        machineRpcWithServerScopeMock.mockResolvedValueOnce(openPreviewResponse);
        const { openLocalServiceLauncherPreviewViaMachineRpc } = await import('./machineRpc');

        await expect(openLocalServiceLauncherPreviewViaMachineRpc({
            machineId: 'machine_1',
            serverId: 'server_1',
            targetId: 'target_1',
            sessionId: 'session_1',
        })).resolves.toEqual({ ok: true, response: openPreviewResponse });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'machine_1',
            serverId: 'server_1',
            method: RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_OPEN_PREVIEW,
            payload: { machineId: 'machine_1', targetId: 'target_1', sessionId: 'session_1' },
        });
    });

    it('registers a launcher preview through the LSV-1 leaf machine RPC method', async () => {
        const registerPreviewResponse = {
            protocolVersion: 1 as const,
            status: 'registered' as const,
            targetId: 'inventory:entry_1',
            previewId: 'preview_1',
        };
        machineRpcWithServerScopeMock.mockResolvedValueOnce(registerPreviewResponse);
        const { registerLocalServiceLauncherPreviewViaMachineRpc } = await import('./machineRpc');

        await expect(registerLocalServiceLauncherPreviewViaMachineRpc({
            machineId: 'machine_1',
            targetId: 'inventory:entry_1',
        })).resolves.toEqual({ ok: true, response: registerPreviewResponse });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'machine_1',
            serverId: undefined,
            method: RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_REGISTER_PREVIEW,
            payload: { machineId: 'machine_1', targetId: 'inventory:entry_1' },
        });
    });

    it('clears launcher history through the LSV-1 leaf machine RPC method', async () => {
        const historyClearResponse = {
            protocolVersion: 1 as const,
            cleared: 2,
            snapshot,
        };
        machineRpcWithServerScopeMock.mockResolvedValueOnce(historyClearResponse);
        const { clearLocalServiceLauncherHistoryViaMachineRpc } = await import('./machineRpc');

        await expect(clearLocalServiceLauncherHistoryViaMachineRpc({
            machineId: 'machine_1',
            serverId: 'server_1',
            sessionId: 'session_1',
        })).resolves.toEqual({ ok: true, response: historyClearResponse });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'machine_1',
            serverId: 'server_1',
            method: RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_HISTORY_CLEAR,
            payload: { machineId: 'machine_1', sessionId: 'session_1' },
        });
    });

    it('fails launcher leaves closed for unavailable daemon responses', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            error: 'RPC method not available',
        });
        const { openLocalServiceLauncherPreviewViaMachineRpc } = await import('./machineRpc');

        await expect(openLocalServiceLauncherPreviewViaMachineRpc({
            machineId: 'machine_1',
            targetId: 'target_1',
        })).resolves.toEqual({ ok: false, reason: 'request_failed' });
    });

    it('fails closed for unavailable and mismatched daemon launcher start responses', async () => {
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({
                errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
                error: 'Method not found',
            })
            .mockResolvedValueOnce({
                errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
                error: 'RPC method not available',
            })
            .mockResolvedValueOnce({
                ...startResponse,
                targetId: 'target_2',
            });
        const { startLocalServiceLauncherTargetViaMachineRpc } = await import('./machineRpc');

        await expect(startLocalServiceLauncherTargetViaMachineRpc({
            machineId: 'machine_1',
            targetId: 'target_1',
        })).resolves.toEqual({ ok: false, reason: 'unavailable' });
        await expect(startLocalServiceLauncherTargetViaMachineRpc({
            machineId: 'machine_1',
            targetId: 'target_1',
        })).resolves.toEqual({ ok: false, reason: 'request_failed' });
        await expect(startLocalServiceLauncherTargetViaMachineRpc({
            machineId: 'machine_1',
            targetId: 'target_1',
        })).resolves.toEqual({ ok: false, reason: 'invalid_response' });
    });
});
