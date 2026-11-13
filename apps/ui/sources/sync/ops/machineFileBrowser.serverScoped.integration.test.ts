import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@/dev/testkit';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createRpcCallError, MACHINE_RPC_TIMEOUT_ERROR_CODE } from '@happier-dev/protocol/rpcErrors';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { FILESYSTEM_BROWSER_ACTION_IDS_V1 } from '@happier-dev/protocol/actions/filesystemActionFamily';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { readActionFailureEnvelope } from '@happier-dev/protocol/actions/executor/actionFailureEnvelope';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';

// Only socket/HTTP transport and device credential storage are replaced. Home
// admission, routing, response decoding and the file-browser owners stay real.
const boundary = await installSessionOpsNetworkBoundary();
const { createCliActionDeps } = await import('../../../../cli/src/session/actions/createCliActionDeps');
const { decodeStoredCredentials } = await import('../../../../cli/src/persistence');
const { socketRpcCodec } = await import('@happier-dev/sync-client');
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
const { machineFilesystemListRoots, machineFilesystemListDirectory } = await import('./machineFileBrowser');
const { callAdmittedFilesystemActionRpc } = await import('./actions/filesystemActionDeps');
const { resolveFilesystemErrorReason } = await import('@/components/ui/filesystemBrowser/filesystemErrorReason');
const { t } = await import('@/text');
let home: Awaited<ReturnType<typeof boundary.addHome>>;
let actionHomes: Awaited<ReturnType<typeof serveActionHomes>> | undefined;

beforeEach(async () => {
    boundary.resetRequests();
    resetScopedMachineTransportCacheForTests();
    const serverUrl = 'https://filesystem.example.test';
    const serverIdentityId = 'srv_filesystem_home';
    home = await boundary.addHome(serverUrl, 'account-a', { serverIdentityId });
    const actionsSettingsV1 = ActionsSettingsV1Schema.parse({ v: 1, actions: {},
        approvalWaivedSurfaces: Object.fromEntries(Object.values(FILESYSTEM_BROWSER_ACTION_IDS_V1)
            .map(actionId => [actionId, ['ui', 'agent']])),
    });
    const actions = await Promise.all(Object.values(FILESYSTEM_BROWSER_ACTION_IDS_V1).map(actionId =>
        createExternalActionAccountHttpBoundary({ serverUrl, serverIdentityId, accountId: 'account-a',
            machineId: 'machine-1', actionId, tokenEpoch: 0, requesterInvocation: 'required',
            failure: readActionFailureEnvelope,
            execute: async (input, context) => {
                expect(context.invocation).toMatchObject({ surface: 'ui', authority: 'present_user' });
                const credentials = decodeStoredCredentials(context.requesterAccountContext);
                if (!credentials) throw new Error('Requester credentials unavailable');
                // Native Action projection and settlement stay real; only its OS
                // effect crosses the fixture's scoped Socket transport boundary.
                const executor = createActionExecutor(createCliActionDeps({
                    token: credentials.token, credentials, sessionId: '', mode: 'plain', ctx: null,
                    serverId: home.id, serverIdentityId, serverHttpBaseUrl: serverUrl,
                    actionsSettingsProvider: { getActionsSettings: () => actionsSettingsV1,
                        getAccountSettings: () => accountSettingsParse({ actionsSettingsV1 }) },
                    machineActionDirectTargetTransport: { machineId: context.target.machineId,
                        invoke: async (_method, request, options) => await callAdmittedFilesystemActionRpc({
                            actionId, machineId: context.target.machineId, serverId: home.id,
                            accountId: 'account-a', input: request, requestId: context.requestId,
                            signal: options?.signal,
                        }),
                    },
                }));
                const result = await executor.execute(actionId, input, {
                    ...context.invocation, actionCaller: context.invocation.caller,
                    serverId: home.id, runtimeAccountId: 'account-a',
                    externalActionTarget: context.target, actionRequestId: context.requestId,
                    signal: context.signal ?? undefined,
                });
                return result.ok ? result.result : result;
            },
        })));
    actionHomes = await serveActionHomes({ homes: [{ key: 'filesystem', serverUrl, serverIdentityId,
        accountId: 'account-a', currentAccount: true, settings: {
            actionsSettingsV1,
        },
    }], route: async request => {
        const init = { method: request.method, headers: request.headers,
            ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }), signal: request.signal };
        for (const action of actions) {
            const response = await action.handle(request.url, init);
            if (response) return response;
        }
        return await boundary.request(request.url, init);
    } });
});
afterEach(async () => {
    await serverScopedRpcSocketPool.stopAll();
    await resetServerReachabilitySupervisors();
    await actionHomes?.dispose();
    actionHomes = undefined;
});
afterAll(() => boundary.dispose());

const listings = [
    ['roots', (serverId: string) => machineFilesystemListRoots('machine-1', { serverId, accountId: 'account-a' })],
    ['directory', (serverId: string) => machineFilesystemListDirectory('machine-1', {
        path: '/home/happier/happier-dev', includeFiles: false,
    }, { serverId, accountId: 'account-a' })],
] as const;

describe('file-browser failures across the scoped network boundary', () => {
    it.each([
        [{ ok: false, error: "ENOENT: no such file or directory, scandir '/private/project'" }, 'ENOENT', 'errors.fileNotFound'],
        [{ ok: false, error: "EACCES: permission denied, scandir '/private/project'" }, 'EACCES', 'errors.permissionDenied'],
        [{ ok: false, error: "EPERM: operation not permitted, scandir 'C:\\private\\project'" }, 'EPERM', 'errors.permissionDenied'],
        [{ ok: false, error: 'private daemon diagnostic', errorCode: 'ENOENT' }, 'ENOENT', 'errors.fileNotFound'],
        [{ ok: false, error: 'ENOENT: misleading diagnostic', errorCode: 'EACCES' }, 'EACCES', 'errors.permissionDenied'],
        [{ ok: false, error: 'ENOENT: misleading diagnostic', errorCode: 'future_filesystem_failure' }, 'future_filesystem_failure', 'errors.operationFailed'],
    ] as const)('carries a daemon listing failure code through the tree without its diagnostic path (%j)', async (failure, code, reasonKey) => {
        const { useWorkspaceRepositoryTreeBrowser } = await import('@/hooks/workspaces/files/useWorkspaceRepositoryTreeBrowser');
        boundary.setRpcResponder(async request => {
            const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, request.payload, `${request.targetId}:${request.method}`);
            return socketRpcCodec.encodeResponse({ mode: 'plain' }, failure, decoded.callId);
        });
        for (const [, list] of listings) {
            expect(await list(home.id)).toMatchObject({ ok: false, error: code, errorCode: code });
        }
        const requestsBeforeTree = boundary.requests.length;
        const scope = { serverId: home.id, machineId: 'machine-1', rootPath: `/listing-failure-${code}` };
        const hook = await renderHook(() => useWorkspaceRepositoryTreeBrowser({ scope, enabled: true }));
        try {
            await vi.waitFor(() => expect(hook.getCurrent().rootLoading).toBe(false));
            expect(hook.getCurrent().rootError).toBe(code);
            expect(resolveFilesystemErrorReason(hook.getCurrent().rootError)).toBe(t(reasonKey));
            expect(boundary.requests.length - requestsBeforeTree).toBe(1);
        } finally {
            await hook.unmount();
        }
    });

    it.each(listings)('does not infer an OS code from arbitrary %s diagnostic text', async (_name, list) => {
        const failure = { ok: false, error: 'Could not read a file named ENOENT:notes' };
        boundary.setRpcResponder(async request => {
            const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, request.payload, `${request.targetId}:${request.method}`);
            return socketRpcCodec.encodeResponse({ mode: 'plain' }, failure, decoded.callId);
        });
        expect(await list(home.id)).toEqual(failure);
    });

    it('retires a stuck tree read on disable and loads again when reopened', async () => {
        const { useWorkspaceRepositoryTreeBrowser } = await import('@/hooks/workspaces/files/useWorkspaceRepositoryTreeBrowser');
        const { SOCKET_RPC_EVENTS } = await import('@happier-dev/protocol/socketRpc');
        boundary.setRpcResponder(async () => new Promise(() => {}));
        const scope = { serverId: home.id, machineId: 'machine-1', rootPath: '/tree-lifetime' };
        const hook = await renderHook(({ enabled }) => useWorkspaceRepositoryTreeBrowser({ scope, enabled }), {
            initialProps: { enabled: true },
        });
        await vi.waitFor(() => expect(boundary.requests).toHaveLength(1));
        expect(hook.getCurrent().rootLoading).toBe(true);
        await hook.rerender({ enabled: false });
        await vi.waitFor(() => expect(boundary.socketBoundaries.some(({ socket }) =>
            socket.emit.mock.calls.some(([event]) => event === SOCKET_RPC_EVENTS.CANCEL))).toBe(true));
        expect(hook.getCurrent().rootLoading).toBe(false);
        boundary.setRpcResponder(async request => {
            const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, request.payload, `${request.targetId}:${request.method}`);
            return socketRpcCodec.encodeResponse({ mode: 'plain' }, { ok: true, path: scope.rootPath,
                entries: [{ name: 'ready.ts', path: `${scope.rootPath}/ready.ts`, type: 'file' }], truncated: false }, decoded.callId);
        });
        await hook.rerender({ enabled: true });
        await vi.waitFor(() => expect(hook.getCurrent().nodes.map(node => node.path)).toEqual(['ready.ts']));
        await hook.unmount();
    });

    it('keeps a shared warm read for another browser and retires it when the last browser leaves', async () => {
        const { warmMachineFileBrowserDirectoryCache } = await import('@/sync/domains/input/machineFileBrowser');
        const { SOCKET_RPC_EVENTS } = await import('@happier-dev/protocol/socketRpc');
        boundary.setRpcResponder(async () => new Promise(() => {}));
        const first = new AbortController();
        const second = new AbortController();
        const input = { machineId: 'machine-1', serverId: home.id, directoryPath: '/warm-lifetime', includeFiles: true };
        let firstRetired = false;
        let secondRetired = false;
        const a = warmMachineFileBrowserDirectoryCache({ ...input, signal: first.signal }).catch(() => { firstRetired = true; });
        const b = warmMachineFileBrowserDirectoryCache({ ...input, signal: second.signal }).catch(() => { secondRetired = true; });
        await vi.waitFor(() => expect(boundary.requests).toHaveLength(1));
        first.abort();
        await vi.waitFor(() => expect(firstRetired).toBe(true));
        expect(secondRetired).toBe(false);
        expect(boundary.socketBoundaries.some(({ socket }) => socket.emit.mock.calls.some(([event]) => event === SOCKET_RPC_EVENTS.CANCEL))).toBe(false);
        second.abort();
        await vi.waitFor(() => expect(secondRetired).toBe(true));
        expect(boundary.socketBoundaries.some(({ socket }) => socket.emit.mock.calls.some(([event]) => event === SOCKET_RPC_EVENTS.CANCEL))).toBe(true);
        await Promise.all([a, b]);
        boundary.setRpcResponder(async request => {
            const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, request.payload, `${request.targetId}:${request.method}`);
            return socketRpcCodec.encodeResponse({ mode: 'plain' }, { ok: true, path: input.directoryPath,
                entries: [], truncated: false }, decoded.callId);
        });
        expect(await warmMachineFileBrowserDirectoryCache(input)).toEqual({ ok: true, entries: [], truncated: false });
        expect(boundary.requests).toHaveLength(2);
    });

    it('retires a terminal stream observation without closing the live terminal', async () => {
        const { createMachineRpcTerminalStreamCarrier } = await import('@/sync/domains/terminal/stream/carrier');
        const { SOCKET_RPC_EVENTS } = await import('@happier-dev/protocol/socketRpc');
        const controller = new AbortController();
        boundary.setRpcResponder(async () => new Promise(() => {}));
        const carrier = createMachineRpcTerminalStreamCarrier({ machineId: 'machine-1', serverId: home.id, signal: controller.signal });
        let retired = false;
        const read = carrier.read({ terminalId: 'term-1', cursor: { mode: 'byte-offset', value: 0 } }).catch(() => { retired = true; });
        await vi.waitFor(() => expect(boundary.requests).toHaveLength(1));
        await act(async () => controller.abort());
        await vi.waitFor(() => expect(retired).toBe(true));
        expect(boundary.socketBoundaries.some(({ socket }) => socket.emit.mock.calls.some(([event]) => event === SOCKET_RPC_EVENTS.CANCEL))).toBe(true);
        expect(boundary.requests.map(request => request.method)).toEqual([RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES]);
        await read;
    });

    it('retires the mounted terminal read when its view leaves', async () => {
        const { useMachineTerminalSession } = await import('@/hooks/machine/useMachineTerminalSession');
        const { SOCKET_RPC_EVENTS } = await import('@happier-dev/protocol/socketRpc');
        boundary.setRpcResponder(async () => new Promise(() => {}));
        const terminalRef = { current: { write: () => {}, clear: () => {} } };
        const hook = await renderHook(() => useMachineTerminalSession({ machineId: 'machine-1',
            serverId: home.id, cwd: null, terminalKey: 'borrowed-lifetime', terminalRef, attachedTerminalId: 'term-1',
            readOnly: true, closeOnUnmount: true }));
        // This Home does not advertise byte streaming, so the mounted owner
        // uses its supported legacy stream; cancellation applies to both.
        await vi.waitFor(() => expect(boundary.requests.map(request => request.method)).toEqual([RPC_METHODS.DAEMON_TERMINAL_STREAM_READ]));
        await hook.unmount();
        await vi.waitFor(() => expect(boundary.socketBoundaries.some(({ socket }) =>
            socket.emit.mock.calls.some(([event]) => event === SOCKET_RPC_EVENTS.CANCEL))).toBe(true));
        expect(boundary.requests.map(request => request.method)).toEqual([RPC_METHODS.DAEMON_TERMINAL_STREAM_READ]);
    });

    it.each(listings)('lists %s on the selected Home with unavailable features', async (_name, list) => {
        boundary.setRpcResponder(async request => {
            const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, request.payload, `${request.targetId}:${request.method}`);
            const result = request.method === RPC_METHODS.DAEMON_FILESYSTEM_LIST_ROOTS
                ? { ok: true, roots: [{ id: '/', label: '/', path: '/' }] }
                : { ok: true, path: '/home/happier/happier-dev', entries: [], truncated: false };
            return await socketRpcCodec.encodeResponse({ mode: 'plain' }, result, decoded.callId);
        });
        expect(await list(home.id)).toMatchObject({ ok: true });
        expect(boundary.requests).toContainEqual(expect.objectContaining({ serverUrl: home.serverUrl, targetId: 'machine-1' }));
    });

    it.each(listings)('keeps an untyped relay exception as a generic Action failure for %s', async (_name, list) => {
        boundary.setRpcAckResponder(async () => ({ ok: false, error: 'verifiedWorkspaceSyncTargetContinuation is not defined' }));
        const result = await list(home.id);
        expect(boundary.requests.length).toBeGreaterThan(0);
        expect(result).toEqual({ ok: false, error: 'action_failed', errorCode: 'action_failed' });
        if (!result.ok) expect(resolveFilesystemErrorReason(result.error)).toBeUndefined();
    });

    it.each([
        [RPC_ERROR_CODES.FORBIDDEN, 'errors.permissionDenied'],
        [RPC_ERROR_CODES.METHOD_NOT_AVAILABLE, 'errors.daemonUnavailableBody'],
        [RPC_ERROR_CODES.METHOD_NOT_FOUND, null],
    ] as const)('preserves the %s failure class without exposing server exception text', async (code, key) => {
        boundary.setRpcAckResponder(async () => ({ ok: false, error: 'private server internals', errorCode: code }));
        for (const [, list] of listings) {
            const result = await list(home.id);
            expect(boundary.requests.length).toBeGreaterThan(0);
            expect(result).toMatchObject({ ok: false, errorCode: code });
            if (result.ok) throw new Error('Expected listing refusal');
            expect(result.error).not.toContain('private server internals');
            expect(resolveFilesystemErrorReason(result.error)).toBe(key ? t(key) : undefined);
        }
        expect(resolveFilesystemErrorReason(RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE)).toBe(t('errors.daemonUnavailableBody'));
    });

    // A guest read on a Machine that cannot run it under member isolation is refused by the daemon
    // handler with this exact envelope (no `ok`); the tree names that cause, not a generic failure.
    it('presents the daemon isolation refusal as its own reason, not a format or generic failure', async () => {
        boundary.setRpcResponder(async request => {
            const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, request.payload, `${request.targetId}:${request.method}`);
            return socketRpcCodec.encodeResponse({ mode: 'plain' }, {
                error: 'Requester execution protection is unavailable', errorCode: 'agent_isolation_unavailable',
            }, decoded.callId);
        });
        for (const [, list] of listings) {
            const result = await list(home.id);
            expect(result).toMatchObject({ ok: false, errorCode: 'agent_isolation_unavailable' });
            if (result.ok) throw new Error('Expected listing refusal');
            expect(result.error).not.toContain('Requester execution protection');
            const reason = resolveFilesystemErrorReason(result.error);
            expect(reason).toBe(t('errors.agentIsolationUnavailable'));
            expect([t('errors.operationFailed'), t('errors.invalidFormat')]).not.toContain(reason);
        }
    });

    it('distinguishes an acknowledgement timeout from unsupported methods', async () => {
        // The native CLI transport converts its Socket ACK deadline into this
        // typed RPC failure before the Action executor settles it.
        boundary.setRpcAckResponder(async () => { throw createRpcCallError({
            error: 'Machine RPC call timeout', errorCode: MACHINE_RPC_TIMEOUT_ERROR_CODE,
        }); });
        const result = await machineFilesystemListRoots('machine-1', { serverId: home.id, timeoutMs: 1_000 });
        expect(result).toEqual({ ok: false, error: 'MACHINE_RPC_TIMEOUT', errorCode: 'MACHINE_RPC_TIMEOUT' });
        if (!result.ok) expect(resolveFilesystemErrorReason(result.error)).toBe(t('errors.connectionTimeout'));
    });

    it('classifies a failed socket connection as unreachable without disclosing its exception', async () => {
        boundary.setSocketConfigurator(({ socket, trigger }) => {
            socket.connect.mockImplementation(() => trigger('connect_error', new Error('private transport details')));
        });
        const result = await machineFilesystemListRoots('machine-1', { serverId: home.id });
        expect(result).toEqual({ ok: false, error: 'MACHINE_RPC_UNREACHABLE', errorCode: 'MACHINE_RPC_UNREACHABLE' });
        if (!result.ok) expect(resolveFilesystemErrorReason(result.error)).toBe(t('errors.networkError'));
    });

    it('preserves caller cancellation rather than presenting a listing failure', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(machineFilesystemListRoots('machine-1', { serverId: home.id, signal: controller.signal })).rejects.toThrow();
    });
});
