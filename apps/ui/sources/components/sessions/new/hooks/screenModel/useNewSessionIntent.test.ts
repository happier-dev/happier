import { afterEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';

/** Machine RPC delivery boundary: each call stays open until its signal aborts, as the daemon holds it. */
const calls = vi.hoisted(() => [] as Array<{ machineId: string; method: string; signal: AbortSignal; operationTimeoutMs: unknown }>);
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (request: { machineId: string; method: string; signal: AbortSignal; operationTimeoutMs: unknown }) => {
        calls.push(request);
        return new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    },
}));

import { useNewSessionIntent } from './useNewSessionIntent';

const binding = (revision: number) => ({ serverId: 'server-1', accountId: 'account-1', scope: 'server-1:account-1', revision,
    isCurrent: () => true }) as unknown as ServerCredentialAccountScopeBinding;

describe('New Session intent', () => {
    afterEach(async () => {
        calls.length = 0;
        await standardCleanup();
    });

    it('holds one intent call per selected Machine while New Session is open, and releases it on change and close', async () => {
        const hook = await renderHook(useNewSessionIntent, { initialProps: { machineId: 'machine-a', binding: binding(1), enabled: true } });
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ machineId: 'machine-a', method: RPC_METHODS.DAEMON_SESSION_CREATION_INTENT, operationTimeoutMs: null });
        expect(calls[0]!.signal.aborted).toBe(false);

        // Re-renders with equal inputs (a new binding object of the same revision) keep the same call open.
        await hook.rerender({ machineId: 'machine-a', binding: binding(1), enabled: true });
        expect(calls).toHaveLength(1);

        // Another Machine picked: the first intent ends, the second starts.
        await hook.rerender({ machineId: 'machine-b', binding: binding(1), enabled: true });
        expect(calls).toHaveLength(2);
        expect(calls[0]!.signal.aborted).toBe(true);
        expect(calls[1]).toMatchObject({ machineId: 'machine-b' });

        // New Session closed: nothing stays open.
        await hook.unmount();
        expect(calls[1]!.signal.aborted).toBe(true);
    });

    it('sends nothing when the Machine does not host the Session itself', async () => {
        await renderHook(useNewSessionIntent, { initialProps: { machineId: 'shared-machine', binding: binding(1), enabled: false } });
        await renderHook(useNewSessionIntent, { initialProps: { machineId: null, binding: binding(1), enabled: true } });
        expect(calls).toHaveLength(0);
    });
});
