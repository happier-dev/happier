import { afterEach, expect, it } from 'vitest';

import { serveActionHomes } from './actionHomesHttpHarness';
import { initializeRealAppRuntimeForTests } from './realAppRuntimeHarness';

let served: Awaited<ReturnType<typeof serveActionHomes>> | null = null;
afterEach(async () => {
    await served?.dispose();
    served = null;
});

it('restores a genuine focused Account and retires its captured lifetime on replacement', async () => {
    await initializeRealAppRuntimeForTests();
    served = await serveActionHomes({ homes: [
        { key: 'other', serverUrl: 'https://action-other.test', accountId: 'account-other', serverIdentityId: 'srv_action_other' },
        { key: 'focused', serverUrl: 'https://action-focused.test', accountId: 'account-a', serverIdentityId: 'srv_action_focused' },
    ], route: () => undefined });
    const { captureActiveServerAccountScopeLifetime, getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
    const { resolveServerCredentialAccountScope } = await import('@/sync/domains/scope/serverCredentialAccountScope');
    expect(getActiveServerAccountScope()).toEqual({ serverId: served.homes.focused!.id, accountId: 'account-a' });
    expect(served.homes.focused!.id).toBe('srv_action_focused');
    expect(served.homes.focused!.profileId).not.toBe(served.homes.focused!.id);
    expect(await resolveServerCredentialAccountScope(served.homes.other!.id)).toMatchObject({ kind: 'bound', scope: { accountId: 'account-other' } });
    const captured = captureActiveServerAccountScopeLifetime();
    expect(captured?.isCurrent()).toBe(true);
    await served.switchAccount('focused', 'account-b');
    expect(captured?.isCurrent()).toBe(false);
    expect(getActiveServerAccountScope()).toEqual({ serverId: served.homes.focused!.id, accountId: 'account-b' });
    expect(await resolveServerCredentialAccountScope(served.homes.other!.id)).toMatchObject({ kind: 'bound', scope: { accountId: 'account-other' } });
    const replacement = captureActiveServerAccountScopeLifetime();
    expect(replacement?.isCurrent()).toBe(true);
    await served.dispose();
    expect(replacement?.isCurrent()).toBe(false);
    expect(getActiveServerAccountScope()).toBeNull();
});
