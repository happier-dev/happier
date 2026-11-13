import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import type { PreviewEnvResponse } from '@/sync/ops/machines';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

const REQUIRED_KEYS = ['OPENAI_API_KEY'];
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const presenceByOrigin = new Map<string, boolean>();
installSessionActionRpcBoundary((request, context) => {
    if (!request.method.endsWith('preview-env')) return {};
    if (!context.serverUrl) throw new Error('The scoped RPC boundary must identify its Home');
    const isSet = presenceByOrigin.get(new URL(context.serverUrl).origin) ?? false;
    return {
        policy: 'redacted',
        values: { OPENAI_API_KEY: { value: null, isSet, isSensitive: true,
            isForcedSensitive: true, sensitivitySource: 'forced', display: isSet ? 'redacted' : 'unset' } },
    } satisfies PreviewEnvResponse;
});

await (await import('@/dev/testkit/harness/syncSingletonLoader')).loadSyncSingletonForTests();
const { invalidateMachineEnvPresence, useMachineEnvPresence } = await import('./useMachineEnvPresence');

let account: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let serverA: string;
let serverB: string;
const originA = 'https://presence-a.test';
const originB = 'https://presence-b.test';

async function readPresence(serverId: string, isSet: boolean) {
    const hook = await renderHook(() => useMachineEnvPresence('m1', REQUIRED_KEYS, { ttlMs: 60_000, serverId }));
    try {
        await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({
            isLoading: false, isPreviewEnvSupported: true,
            meta: { OPENAI_API_KEY: { isSet, display: isSet ? 'redacted' : 'unset' } },
            refreshedAt: expect.any(Number),
        }));
    } finally { await hook.unmount(); }
}

describe('useMachineEnvPresence', () => {
    beforeEach(async () => {
        invalidateMachineEnvPresence();
        presenceByOrigin.set(originA, true);
        presenceByOrigin.set(originB, false);
        serverA = await homes.addHome({ name: 'Presence A', serverUrl: originA, accountId: 'account-a' });
        serverB = await homes.addHome({ name: 'Presence B', serverUrl: originB, accountId: 'account-b' });
        homes.answer(serverA, '/v1/machines/m1', { body: { machine: createPlainMachineRowFixture({ id: 'm1', accountId: 'account-a' }) } });
        homes.answer(serverB, '/v1/machines/m1', { body: { machine: createPlainMachineRowFixture({ id: 'm1', accountId: 'account-b' }) } });
        account = await restoreServerAccountForTest({ serverUrl: originB, accountId: 'account-b', request: homes.request });
        installHomeGovernanceBoundaries(homes);
    });

    afterEach(async () => {
        (await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool')).serverScopedRpcSocketPool.resetForTests();
        (await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool')).resetScopedMachineTransportCacheForTests();
        await account?.dispose();
        account = undefined;
        await homes.reset();
        invalidateMachineEnvPresence();
        presenceByOrigin.clear();
        vi.restoreAllMocks();
    });

    it('refreshes every Home cache entry for a Machine when invalidating by Machine id', async () => {
        await readPresence(serverA, true);
        await readPresence(serverB, false);
        presenceByOrigin.set(originA, false);
        presenceByOrigin.set(originB, true);

        invalidateMachineEnvPresence({ machineId: 'm1' });

        await readPresence(serverA, false);
        await readPresence(serverB, true);
    });

    it('refreshes only the invalidated Home while retaining another Home cache entry', async () => {
        await readPresence(serverA, true);
        await readPresence(serverB, false);
        presenceByOrigin.set(originA, false);
        presenceByOrigin.set(originB, true);

        invalidateMachineEnvPresence({ machineId: 'm1', serverId: serverA });

        await readPresence(serverB, false);
        await readPresence(serverA, false);
    });
});
