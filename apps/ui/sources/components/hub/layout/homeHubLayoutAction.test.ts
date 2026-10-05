import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol';
import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import { readHomeReachNudge, recordFailedHomeReach } from '@/sync/runtime/connectivity/homeReachFailures';

describe('device-local Home reachability Action', () => {
    it('permanently dismisses the local reach nudge without reading or writing Account settings', async () => {
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const profile = await profiles.upsertServerProfile({ serverUrl: 'https://nudge-action.example.test', name: 'Home' });
        await profiles.setServerProfileIdentityForUrl(profile.serverUrl, 'srv_nudge_action');
        const { createHomeHubLayoutAction } = await import('./homeHubLayoutAction');
        const action = createHomeHubLayoutAction({
            isClientTargetCurrent: () => true,
        });
        const executor = createActionExecutor({ homeHubLayoutAction: action } as ActionExecutorDeps);
        try {
            for (let index = 0; index < 3; index++) recordFailedHomeReach('srv_nudge_action', Date.now());
            expect(readHomeReachNudge('srv_nudge_action', Date.now()).show).toBe(true);
            expect(await executor.execute('home.reachNudge.dismiss', { homeServerId: profile.id }, { surface: 'agent' })).toMatchObject({
                ok: true, result: { homeIdentityId: 'srv_nudge_action', dismissed: true },
            });
            expect(readHomeReachNudge('srv_nudge_action', Date.now()).show).toBe(false);
            expect(await executor.execute('home.reachNudge.dismiss', { homeServerId: 'unknown' }, { surface: 'agent' })).toMatchObject({
                ok: false, errorCode: 'home_not_found',
            });
        } finally {
            await profiles.removeServerProfile(profile.id);
            getPersistenceStorage().delete('home-reach-failures-v2');
            getPersistenceStorage().delete('home-reach-nudge-dismissed-v1');
        }
    });
});
