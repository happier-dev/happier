import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { setServerProfileIdentityForUrl, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { getStorage } from '@/sync/domains/state/storageStore';
import { buildSessionOrganizationSessionKey } from '@/sync/domains/session/organization/keys';
import { useSessionViewedLifecycle, type UseSessionViewedLifecycleInput } from './useSessionViewedLifecycle';

const api = vi.hoisted(() => ({ setSessionAttentionStanding: vi.fn() }));
// HTTP is the system boundary; viewing, scope resolution, and optimistic state remain real.
vi.mock('@/sync/api/session/sessionOrganizationApi', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/api/session/sessionOrganizationApi')>(),
    setSessionAttentionStanding: api.setSessionAttentionStanding,
}));

afterEach(() => { standardCleanup(); vi.restoreAllMocks(); });
describe('session viewed reminder lifecycle', () => {
    it('clears the due reminder on focused opening without a read cursor and preserves Keep in Needs attention', async () => {
        const profile = await upsertServerProfile({ serverUrl: 'https://reminder-lifecycle.example' });
        await setServerProfileIdentityForUrl(profile.serverUrl, 'srv_lifecycle');
        const address = { serverId: 'srv_lifecycle', sessionId: 'reminded-session' };
        const key = buildSessionOrganizationSessionKey(address.serverId, address.sessionId);
        const store = getStorage();
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token: 'token', secret: 'secret' });
        const recordId = store.getState().setSessionAttentionStandingOptimistic(address.serverId, address.sessionId, {
            sessionId: address.sessionId, standing: true, remindAt: 1, updatedAt: 1,
        });
        store.getState().commitSessionOrganizationOptimistic(recordId);
        api.setSessionAttentionStanding.mockResolvedValue({ standing: { sessionId: address.sessionId, standing: true, updatedAt: 2 } });
        const initialProps: UseSessionViewedLifecycleInput = { address, surfaceFocused: false, visibleReadSeq: null };
        const hook = await renderHook((input: UseSessionViewedLifecycleInput) => useSessionViewedLifecycle(input), { initialProps });
        expect(store.getState().sessionOrganizationAttentionStandingsBySessionKey[key]?.remindAt).toBe(1);
        await hook.rerender({ address, surfaceFocused: true, visibleReadSeq: null });
        await vi.waitFor(() => expect(store.getState().sessionOrganizationAttentionStandingsBySessionKey[key])
            .toEqual({ sessionId: address.sessionId, standing: true, updatedAt: 2 }));
        await hook.unmount();
        expect(api.setSessionAttentionStanding).toHaveBeenCalledTimes(1);
        store.getState().clearSessionOrganizationForServer(address.serverId);
    });
});
