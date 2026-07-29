import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import type { StorageState } from '@/sync/store/types';
import { usePendingSetupIntent } from './usePendingSetupIntent';

async function activateServerAccount(serverUrl: string, accountId: string) {
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    const { createServerAccountScope } = await import('@/sync/domains/scope/serverAccountScope');
    const { registerStorageStateReader } = await import('@/sync/domains/state/storageStateReaderBridge');

    const server = upsertAndActivateServer({
        serverUrl,
        source: 'manual',
        scope: 'device',
        replaceEquivalentStoredUrl: true,
    });
    const scope = createServerAccountScope(server.id, accountId);
    expect(scope).not.toBeNull();
    registerStorageStateReader(() => ({ profileScope: scope } as unknown as StorageState));
}

afterEach(async () => {
    const { clearPendingSetupIntent } = await import('@/sync/domains/pending/pendingSetupIntent');
    clearPendingSetupIntent();
    vi.restoreAllMocks();
    standardCleanup();
});

describe('usePendingSetupIntent with the real getter', () => {
    it('keeps the present-intent snapshot stable across renders', async () => {
        const { clearPendingSetupIntent, setPendingSetupIntent } = await import('@/sync/domains/pending/pendingSetupIntent');
        await activateServerAccount('https://relay.example.test', 'account-a');
        clearPendingSetupIntent();
        setPendingSetupIntent({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.example.test/',
        });

        const snapshotWarnings: string[] = [];
        vi.spyOn(console, 'error').mockImplementation((message: unknown, ...args: unknown[]) => {
            const rendered = [message, ...args].map(String).join(' ');
            if (rendered.includes('getSnapshot')) {
                snapshotWarnings.push(rendered);
            }
        });

        let renderCount = 0;
        const hook = await renderHook(() => {
            renderCount += 1;
            return usePendingSetupIntent();
        }, {
            flushOptions: { cycles: 1, turns: 2 },
        });

        const firstSnapshot = hook.getCurrent();
        expect(firstSnapshot).toEqual({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.example.test',
        });

        await hook.rerender();

        expect(hook.getCurrent()).toBe(firstSnapshot);
        expect(snapshotWarnings).toEqual([]);
        expect(renderCount).toBeLessThanOrEqual(2);
        await hook.unmount();
    });
});
