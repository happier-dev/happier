import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';

const candidatesListSpy = vi.hoisted(() => vi.fn());

vi.mock('@/sync/ops/machineExternalSessions', () => ({
    machineExternalSessionsCandidatesList: (...args: unknown[]) => candidatesListSpy(...args),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

import { registerStorageStateReader } from '@/sync/domains/state/storageStateReaderBridge';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { StorageState } from '@/sync/store/types';

const params = {
    machineId: 'machine-1',
    providerId: 'codex' as const,
    source: { kind: 'codexHome' as const, home: 'user' as const },
};

/**
 * The canonical Account scope owner reads the registered storage state. Driving the
 * real owner (rather than mocking it) is what makes this an Account-switch test and
 * not a restatement of the hook's own branches.
 */
let profileScope: ServerAccountScope | null = null;

describe('useExternalSessionBrowseCandidates Account lifetime', () => {
    beforeEach(() => {
        candidatesListSpy.mockReset();
        const profile = upsertAndActivateServer({ serverUrl: 'https://account-lifetime.test' });
        profileScope = { serverId: profile.id, accountId: 'account-a' };
        registerStorageStateReader(() => ({ profileScope } as unknown as StorageState));
    });

    afterEach(() => {
        profileScope = null;
        registerStorageStateReader(() => (null as unknown as StorageState));
        standardCleanup();
    });

    it('does not publish rows captured under one Account after a switch to another', async () => {
        const inFlight = createDeferred<{
            ok: true;
            candidates: readonly { remoteSessionId: string; title: string; updatedAtMs: number }[];
            nextCursor: string | null;
        }>();
        candidatesListSpy.mockImplementationOnce(() => inFlight.promise);
        const { useExternalSessionBrowseCandidates } = await import('./useExternalSessionBrowseCandidates');
        const hook = await renderHook(() => useExternalSessionBrowseCandidates(params));

        expect(candidatesListSpy).toHaveBeenCalledTimes(1);

        // The user switches Account while the listing request is in flight. The
        // canonical owner's scope moves; the request still carries Account A's machine.
        profileScope = { serverId: profileScope!.serverId, accountId: 'account-b' };

        await act(async () => {
            inFlight.resolve({
                ok: true,
                candidates: [{ remoteSessionId: 'account-a-only', title: 'Account A session', updatedAtMs: 1 }],
                nextCursor: 'account-a-cursor',
            });
            await flushHookEffects();
        });

        expect(hook.getCurrent().candidates).toEqual([]);
        expect(hook.getCurrent().candidatesAuthoritative).toBe(false);
        expect(hook.getCurrent().nextCursor).toBeNull();
    });

    it('publishes rows normally while the capturing Account is still current', async () => {
        candidatesListSpy.mockResolvedValueOnce({
            ok: true,
            candidates: [{ remoteSessionId: 'same-account', title: 'Same Account session', updatedAtMs: 1 }],
            nextCursor: null,
        });
        const { useExternalSessionBrowseCandidates } = await import('./useExternalSessionBrowseCandidates');
        const hook = await renderHook(() => useExternalSessionBrowseCandidates(params));

        await flushHookEffects();

        expect(hook.getCurrent().candidates.map((candidate) => candidate.remoteSessionId))
            .toEqual(['same-account']);
        expect(hook.getCurrent().candidatesAuthoritative).toBe(true);
    });
});
