import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { createDeferred, renderHook } from '@/dev/testkit';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { useSessionBoardSnapshot } from './useSessionBoardSnapshot';

describe('useSessionBoardSnapshot identity', () => {
    it('retains loading identity while credential storage is pending and publishes the settled reason', async () => {
        const home = await upsertServerProfile({ name: 'Board identity', serverUrl: 'https://board-identity.example.test' });
        const credentials = createDeferred<Awaited<ReturnType<typeof TokenStorage.getCredentialsForServerUrl>>>();
        // Secure credential storage is the boundary; scope resolution stays real.
        const readCredentials = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockReturnValue(credentials.promise);
        const hook = await renderHook(() => useSessionBoardSnapshot({
            serverId: home.id,
            sessionId: 'session-1',
            boardFeatureEnabled: true,
        }));
        try {
            const loading = hook.getCurrent();
            expect(loading.status).toBe('ready');
            expect(loading.status === 'ready' && loading.snapshot.loading).toBe('initial');
            expect(await hook.rerender()).toBe(loading);
            await act(async () => { credentials.resolve(null); });
            const settled = hook.getCurrent();
            expect(settled).toMatchObject({ status: 'unavailable', reason: 'signed_out' });
            expect(settled).not.toBe(loading);
            expect(await hook.rerender()).toBe(settled);
        } finally {
            await hook.unmount();
            readCredentials.mockRestore();
        }
    });

    it('retains unchanged unavailable fields and publishes feature/address transitions', async () => {
        const hook = await renderHook((boardFeatureEnabled: boolean) => useSessionBoardSnapshot({
            serverId: null,
            sessionId: '',
            boardFeatureEnabled,
        }), { initialProps: false });
        const disabled = hook.getCurrent();
        expect(disabled).toMatchObject({ status: 'unavailable', reason: 'board_feature_disabled' });
        expect(await hook.rerender()).toBe(disabled);
        const invalid = await hook.rerender(true);
        expect(invalid).toMatchObject({ status: 'unavailable', reason: 'invalid_address' });
        expect(invalid).not.toBe(disabled);
        expect(await hook.rerender()).toBe(invalid);
        await hook.unmount();
    });
});
