import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createMachineStorageStore } from '@/sync/domains/machines/storage/machineStorageStore';
import { fetchMachineStorageSummaryViaAction, moveMachineStorageToTrashViaAction } from '@/sync/domains/machines/storage/machineRpc';
import { DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes';

const rpc = vi.hoisted(() => ({ machine: vi.fn() }));
// Daemon transport and its deadline are the system boundary; Actions, schemas,
// scope capture, the Storage adapters and receipt store remain real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(rpc.machine);
});
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
// Load the cold module graph after boundary installation, before per-test
// lifecycle hooks. Each test still resets its Home and rebinds the real bridge.
await loadSyncSingletonForTests();

beforeEach(async () => { await homes.reset(); await loadSyncSingletonForTests(); rpc.machine.mockReset(); });
afterEach(async () => { vi.useRealTimers(); await homes.reset(); });

describe('Storage receipt through the captured UI Action Home', () => {
    it.each(['EACCES', 'EPERM', 'carried cause wins', 'returned Action failure'] as const)(
        'preserves the observed legacy daemon %s cause through the real UI Action and permission remedy', async variant => {
            const serverId = await homes.addHome({ name: 'Storage Home', serverUrl: 'https://legacy-storage-cause.test', accountId: 'owner', currentAccount: true });
            // Live old dd5 summary reply on #76: live-rows-post76-argv.jsonl,
            // 2026-11-06T13:26:48Z. Only the Machine network reply is replaced.
            const legacyCause = { phase: 'dispatch', errorClass: 'Error', errorCode: variant === 'EPERM' ? 'EPERM' : 'EACCES', httpStatus: null };
            const carriedCause = { phase: 'rpc.handler', errorClass: 'Error', errorCode: 'EPERM', httpStatus: null };
            const cause = variant === 'carried cause wins' ? carriedCause : legacyCause;
            rpc.machine.mockResolvedValue({ error: 'Permission denied /private/storage', errorCode: 'action_failed',
                details: { kind: 'actionException', ...legacyCause },
                ...(variant === 'returned Action failure' ? { ok: false } : {}),
                ...(variant === 'carried cause wins' ? { failureCause: carriedCause } : {}) });
            const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
            const result = await createDefaultActionExecutor().execute('machines.storage.summary.get', { machineId: 'machine' },
                { surface: 'ui', serverId, expectedAccountId: 'owner' });
            expect(result).toMatchObject({ ok: false, errorCode: 'action_failed', failureCause: cause });
            const client = await fetchMachineStorageSummaryViaAction({ serverId, expectedAccountId: 'owner', machineId: 'machine' });
            expect(client).toMatchObject({ ok: false, reason: 'permission_denied', errorCode: 'action_failed', failureCause: cause });
            expect(JSON.stringify(client)).not.toContain('/private/storage');
            if (client.ok) throw new Error('Expected the typed permission refusal');
            const { describeStorageFailure } = await import('@/components/machines/storage/storageViewModel');
            expect(describeStorageFailure(client).reason).toMatch(/permission.*try again/i);
        });

    it('keeps a qualified UI terminal read on its terminal RPC rather than original daemon admission', async () => {
        const serverId = await homes.addHome({ name: 'Terminal Home', serverUrl: 'https://terminal-home-wire.test', accountId: 'owner', currentAccount: true });
        homes.answer(serverId, 'POST /v1/machines/read-batch', { body: { results: [{ machineId: 'terminal-machine', status: 'found',
            machine: createPlainMachineRowFixture({ id: 'terminal-machine', accountId: 'owner' }) }] } });
        const receipt = { ok: true, terminals: [] };
        rpc.machine.mockResolvedValue(receipt);
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        expect(await createDefaultActionExecutor().execute('machines.terminal.list', { serverId, machineId: 'terminal-machine' },
            { surface: 'ui', authority: 'present_user', actionRequestId: 'terminal-read', expectedAccountId: 'owner' })).toEqual({ ok: true, result: receipt });
        expect(rpc.machine).toHaveBeenCalledTimes(1);
        expect(rpc.machine.mock.calls[0]?.[0]).toMatchObject({ serverId, machineId: 'terminal-machine', method: RPC_METHODS.DAEMON_TERMINAL_LIST });
        expect(homes.requestsFor('/v1/actions/machines.terminal.list')).toHaveLength(0);
    });

    it('dispatches a fresh isolation CHECK through the captured exact Machine Action port', async () => {
        const serverId = await homes.addHome({ name: 'Machine Home', serverUrl: 'https://isolation-check-wire.test', accountId: 'owner', currentAccount: true });
        const preview = { kind: 'ready', policy: { enabled: true }, metadataVersion: 5,
            plan: { roots: [], ancestorAcls: [], sessionsToReplace: 0, requiresAdmin: false, planDigest: 'successor-check' },
            status: { kind: 'applying', phase: 'runtime_replacement' } };
        rpc.machine.mockResolvedValue(preview);
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        expect(await createDefaultActionExecutor().execute('machines.agentIsolation.preview', { serverId, machineId: 'machine', enabled: true },
            { surface: 'ui', serverId, expectedAccountId: 'owner' })).toEqual({ ok: true, result: preview });
        expect(rpc.machine).toHaveBeenCalledTimes(1);
        expect(rpc.machine.mock.calls[0]?.[0]).toMatchObject({ machineId: 'machine', serverId,
            method: 'machines.agentIsolation.preview', payload: { serverId, machineId: 'machine', enabled: true } });
    });
    it.each([
        { reply: { error: 'Policy unavailable', errorCode: 'policy_unavailable' }, expected: { ok: false, errorCode: 'policy_unavailable',
            failureCause: { phase: 'dispatch', errorClass: 'RpcError', errorCode: 'policy_unavailable', httpStatus: null } } },
        { reply: { error: 'Daemon disconnected', errorCode: 'target_unavailable' }, expected: { ok: true, result: { ok: false, reason: 'machine_unreachable' } } },
        { reply: { error: 'Method not found', errorCode: 'RPC_METHOD_NOT_FOUND', unexpected: true }, expected: { ok: true, result: { ok: false, reason: 'invalid_input' } } },
    ])('admits capability preview Machine refusals through the shared boundary: $reply', async ({ reply, expected }) => {
        const serverId = await homes.addHome({ name: 'Machine Home', serverUrl: 'https://capability-refusal.test', accountId: 'owner', currentAccount: true });
        rpc.machine.mockResolvedValue(reply);
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        expect(await createDefaultActionExecutor().execute('sessions.spawn.capabilities.preview', { machineId: 'machine', agentId: 'codex' },
            { surface: 'ui', serverId, expectedAccountId: 'owner' })).toMatchObject(expected);
        expect(rpc.machine).toHaveBeenCalledTimes(1);
    });

    it.each(['set', 'inspect'] as const)('dispatches administrator access %s through the captured exact Machine', async operation => {
        const serverId = await homes.addHome({ name: 'Machine Home', serverUrl: 'https://admin-access-wire.test', accountId: 'owner', currentAccount: true });
        const controller = new AbortController();
        const actionId = operation === 'set' ? 'machines.setup.adminAccess.set' : 'machines.setup.adminAccess.inspect';
        const input = operation === 'set' ? { machineId: 'machine', serverId, expectedMetadataVersion: 1,
            expectedAdminAccess: { version: 1 as const, mode: 'none' as const }, adminAccess: { version: 1 as const, mode: 'preauthorized' as const }, comparison: 'field' as const }
            : { machineId: 'machine', serverId };
        const observation = { version: 1, observedAt: 20, daemonUid: 1001, daemonUsername: 'happier',
            daemonIdentity: 'nonRoot', rootEquivalentGroups: [], passwordlessSudoToRoot: 'allowed', managedDropIn: 'valid',
            tailscaledOperator: { authorization: 'denied' } } as const;
        const receipt = operation === 'set' ? { status: 'applied', policy: input.adminAccess, metadataVersion: 2 }
            : { observation, checkedAt: 20 };
        rpc.machine.mockImplementationOnce(async () => {
            controller.abort();
            return receipt;
        });
        const { createDefaultActionExecutor, resolveDefaultActionInvocationServerId } = await import('./defaultActionExecutor');
        expect(resolveDefaultActionInvocationServerId(actionId, input, { surface: 'agent' })).toBe(serverId);
        const settled = await createDefaultActionExecutor().execute(actionId, input, {
            surface: 'ui', authority: 'present_user', expectedAccountId: 'owner', signal: controller.signal,
            actionRequestId: 'admin-operation', ...(operation === 'set' ? { presentUserConfirmation: { actionId } } : {}),
        }).then(result => ({ result }), error => ({ error }));
        if (operation === 'set') expect(settled).toEqual({ result: { ok: true, result: receipt } });
        else expect(settled).toHaveProperty('error.name', 'AbortError');
        expect(rpc.machine).toHaveBeenCalledTimes(1);
        expect(rpc.machine).toHaveBeenCalledWith(expect.objectContaining({ serverId, accountId: 'owner',
            machineId: 'machine', method: actionId, payload: input, requestId: 'admin-operation',
            ...(operation === 'set' ? { operationTimeoutMs: null } : {}) }));
    });

    it.each([
        { reply: { error: 'Unknown error' }, code: 'action_failed' },
        { reply: { error: 'malformed', errorCode: 7 }, code: 'invalid_action_output' },
        { reply: { error: 'unknown shape', errorCode: 'refused', unexpected: true }, code: 'invalid_action_output' },
        { reply: { ok: true, error: 'not a scan', errorCode: 'refused' }, code: 'invalid_action_output' },
    ])('keeps legacy refusals typed and malformed successes closed: $code / $reply', async ({ reply, code }) => {
        const serverId = await homes.addHome({ name: 'Storage Home', serverUrl: 'https://storage-wire.test', accountId: 'owner', currentAccount: true });
        rpc.machine.mockResolvedValue(reply);
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        expect(await createDefaultActionExecutor().execute('machines.storage.scan.get', { machineId: 'machine' },
            { surface: 'ui', serverId, expectedAccountId: 'owner' })).toMatchObject({ ok: false, errorCode: code });
    });
    it.each(['machines.processes.list', 'machines.guard.get', 'machines.vitals.get'] as const)(
        'retains a daemon refusal at the neighboring %s binding', async actionId => {
            const serverId = await homes.addHome({ name: 'Machine Home', serverUrl: 'https://machine-refusal.test', accountId: 'owner', currentAccount: true });
            rpc.machine.mockResolvedValue({ error: 'Policy unavailable', errorCode: 'policy_unavailable' });
            const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
            expect(await createDefaultActionExecutor().execute(actionId, { machineId: 'machine' },
                { surface: 'ui', serverId, expectedAccountId: 'owner' }))
                .toMatchObject({ ok: false, errorCode: 'policy_unavailable',
                    failureCause: { phase: 'dispatch', errorClass: 'RpcError', errorCode: 'policy_unavailable', httpStatus: null } });
        });
    it('preserves a daemon-stop refusal from the Machine connection Action binding', async () => {
        const serverId = await homes.addHome({ name: 'Machine Home', serverUrl: 'https://machine-stop-refusal.test', accountId: 'owner', currentAccount: true });
        const { storage } = await import('@/sync/domains/state/storage');
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        const previousScope = storage.getState().profileScope;
        const previousApplied = getAppliedActiveServerSnapshot();
        const previousAvailable = isAppliedActiveServerRuntimeAvailable();
        storage.setState({ profileScope: { serverId, accountId: 'owner' } });
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        rpc.machine.mockResolvedValue({ error: 'Forbidden', errorCode: 'RPC_FORBIDDEN' });
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        try {
            expect(await createDefaultActionExecutor().execute('machines.daemon.stop', { machineId: 'machine', serverId },
                { surface: 'ui', authority: 'present_user', serverId, expectedAccountId: 'owner',
                    presentUserConfirmation: { actionId: 'machines.daemon.stop' } }))
                .toMatchObject({ ok: false, errorCode: 'RPC_FORBIDDEN',
                    failureCause: { phase: 'dispatch', errorClass: 'RpcError', errorCode: 'RPC_FORBIDDEN', httpStatus: null } });
        } finally {
            storage.setState({ profileScope: previousScope });
            publishAppliedActiveServerSnapshot(previousApplied, previousAvailable);
        }
    });
    it('preserves the serialized daemon scan refusal through the browser Action', async () => {
        const serverId = await homes.addHome({ name: 'Storage Home', serverUrl: 'https://storage-refusal.test', accountId: 'owner', currentAccount: true });
        // Captured from Restart #79: j8n-scan-wire-refusal.json, 2026-10-26
        // 04:45:17Z. Only transport is replaced; browser admission and schemas are real.
        rpc.machine.mockResolvedValue({ error: 'Whole-disk scan disabled', errorCode: 'storage_whole_disk_disabled' });
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        expect(await createDefaultActionExecutor().execute('machines.storage.scan.start', {
            machineId: 'machine', target: { folderPath: '/owned-fixture' },
        }, { surface: 'ui', authority: 'present_user', serverId, expectedAccountId: 'owner' }))
            .toMatchObject({ ok: false, errorCode: 'storage_whole_disk_disabled',
                    failureCause: { phase: 'dispatch', errorClass: 'RpcError', errorCode: 'storage_whole_disk_disabled', httpStatus: null } });
        // A non-retryable refusal settles once without reissuing the request.
        expect(rpc.machine).toHaveBeenCalledTimes(1);
    });
    it('keeps retired reads closed rather than disclosing their Account content', async () => {
        const serverId = await homes.addHome({ name: 'Storage Home', serverUrl: 'https://storage-read.test', accountId: 'owner', currentAccount: true });
        const controller = new AbortController();
        rpc.machine.mockImplementationOnce(async () => {
            controller.abort();
            return { revision: 1, sizedAt: 1, volumes: [], categories: [], suggestionsTop: [],
                pile: { count: 0, freesBytes: 0, droppedSinceLastView: [] }, trash: { count: 0, allocatedBytes: 0 }, wholeDisk: { enabled: false, scans: [] } };
        });
        expect(await fetchMachineStorageSummaryViaAction({ serverId, expectedAccountId: 'owner', machineId: 'machine', signal: controller.signal }))
            .toEqual({ ok: false, reason: 'request_failed' });
    });
    it('retains a consumed cleanup acknowledgement when its caller retires afterward', async () => {
        const serverId = await homes.addHome({ name: 'Storage Home', serverUrl: 'https://storage-ack.test', accountId: 'owner', currentAccount: true });
        const controller = new AbortController();
        const receipt = { batchId: 'batch', mode: 'trash', outcomes: [{ itemId: 'cache', status: 'moved' }], inTrashBytes: 4096, freedBytes: 0 };
        rpc.machine.mockImplementationOnce(async () => { controller.abort(); return receipt; });
        const ref = { itemId: 'cache', path: '/cache', identity: { dev: '1', ino: '2', kind: 'directory' as const },
            collectedAt: 1, collectedBy: { accountId: 'owner', kind: 'person' as const } };
        expect(await moveMachineStorageToTrashViaAction({ serverId, expectedAccountId: 'owner', machineId: 'machine',
            signal: controller.signal, items: [{ ref, expect: 'checked', claimedVerdict: 'safe' }] }))
            .toEqual({ ok: true, value: receipt });
    });
    it('waits for the accepted cleanup beyond the read deadline, retains the batch and restores it with Undo', async () => {
        const serverId = await homes.addHome({ name: 'Storage Home', serverUrl: 'https://storage-receipt.test', accountId: 'owner', currentAccount: true });
        const key = { serverId, expectedAccountId: 'owner', machineId: 'machine' };
        const receipt = { batchId: 'batch', mode: 'trash', outcomes: [{ itemId: 'cache', status: 'moved' }], inTrashBytes: 4096, freedBytes: 0 };
        let entered!: () => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        rpc.machine.mockImplementationOnce((request: { operationTimeoutMs?: null }) => {
            entered();
            return new Promise((resolve, reject) => {
                const deadline = request.operationTimeoutMs === null ? null : setTimeout(() => reject(new Error('MACHINE_RPC_TIMEOUT')), DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS);
                setTimeout(() => { if (deadline) clearTimeout(deadline); resolve(receipt); }, DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS + 1000);
            });
        });
        const summary = { revision: 1, sizedAt: 1, volumes: [], categories: [], suggestionsTop: [],
            pile: { count: 0, freesBytes: 0, droppedSinceLastView: [] }, trash: { count: 0, allocatedBytes: 0 }, wholeDisk: { enabled: false, scans: [] } };
        const store = createMachineStorageStore({ summaryClient: async () => ({ ok: true, value: summary }),
            categoryClient: async () => ({ ok: false, reason: 'request_failed' }), refreshClient: async () => ({ ok: true, value: summary }),
            watchClient: async () => ({ ok: true, value: { changed: false } }) });
        const ref = { itemId: 'cache', path: '/cache', identity: { dev: '1', ino: '2', kind: 'directory' as const },
            collectedAt: 1, collectedBy: { accountId: 'owner', kind: 'person' as const } };
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            const applied = store.applyPile({ ...key, mode: 'trash', items: [{ ref, expect: 'reviewed', claimedVerdict: 'safe' }] });
            await started;
            await vi.advanceTimersByTimeAsync(DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS + 1000);
            expect(await applied).toEqual({ ok: true, value: receipt });
            expect(store.getReceipt(key)).toMatchObject({ kind: 'applied', result: receipt });
            rpc.machine.mockImplementationOnce(async (request: { method: string; payload: { batchId?: string } }) => {
                if (request.method !== RPC_METHODS.DAEMON_STORAGE_TRASH_RESTORE || request.payload.batchId !== receipt.batchId) throw new Error('Wrong batch');
                return { outcomes: [{ entryId: 'entry', status: 'restored', path: ref.path }] };
            });
            expect(await store.undoReceipt(key)).toEqual({ ok: true, value: { outcomes: [{ entryId: 'entry', status: 'restored', path: ref.path }] } });
            expect(store.getReceipt(key)).toBeNull();
        } finally { store.reset(); }
    });
});
