import { afterEach, expect, it, vi } from 'vitest';

import { act, renderHook, standardCleanup } from '@/dev/testkit';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { prepareAccountSettingsScopeForActivation, saveAccountSettings } from '@/sync/domains/state/accountSettingsPersistence';
import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';

import { useExactHomeAccountSettings } from './useExactHomeAccountSettings';

afterEach(standardCleanup);

it('shares one persisted settings read across a Home candidate batch and observes policy edits', async () => {
    const scope = { serverId: 'delivery-home', accountId: 'delivery-account' };
    const other = { serverId: 'other-home', accountId: 'other-account' };
    saveAccountSettings(scope, settingsDefaults, 1);
    saveAccountSettings(other, settingsDefaults, 1);
    const audienceScopes = new Map([[scope.serverId, scope], [other.serverId, other]]);
    const keys = ['analyticsOptOut'] as const;
    let renders = 0;
    const hook = await renderHook((scopes: typeof audienceScopes) => {
        renders += 1;
        return useExactHomeAccountSettings(scopes, keys);
    }, { initialProps: audienceScopes });
    // Genuine native storage boundary; scope resolution, persistence and parsing remain real.
    const reads = vi.spyOn(getPersistenceStorage(), 'getString');
    const original = hook.getCurrent()(scope.serverId);
    expect(original).not.toBeNull();
    reads.mockClear();

    // A batch repeats one Home lookup; it must not repeat full settings I/O and parsing.
    for (let index = 0; index < 279; index++) hook.getCurrent()(scope.serverId);
    expect(reads.mock.calls.length).toBe(0);
    expect(hook.getCurrent()(scope.serverId)).toBe(original);
    const otherSettings = hook.getCurrent()(other.serverId);
    expect(hook.getCurrent()('unavailable-home')).toBeNull();

    const settledRenders = renders;
    for (let version = 2; version <= 102; version++) {
        await act(async () => saveAccountSettings(scope, {
            ...settingsDefaults, useProfiles: version % 2 === 1,
        }, version));
    }
    expect(renders).toBe(settledRenders);
    expect(hook.getCurrent()(scope.serverId)).toBe(original);
    // An unrelated parent render must retain the consumed policy too.
    await hook.rerender(new Map(audienceScopes));
    expect(hook.getCurrent()(scope.serverId)).toBe(original);

    await act(async () => saveAccountSettings(scope, {
        ...settingsDefaults,
        analyticsOptOut: !settingsDefaults.analyticsOptOut,
    }, 1));
    const updated = hook.getCurrent()(scope.serverId);
    expect(updated?.analyticsOptOut).toBe(!settingsDefaults.analyticsOptOut);
    expect(updated).not.toBe(original);
    expect(hook.getCurrent()(other.serverId)).toBe(otherSettings);
    reads.mockClear();
    for (let index = 0; index < 279; index++) hook.getCurrent()(scope.serverId);
    expect(reads.mock.calls.length).toBe(0);

    // Reusing a server ID for another Account must never reuse the former Account's policy.
    const replacement = { ...scope, accountId: 'replacement-account' };
    saveAccountSettings(replacement, settingsDefaults, 1);
    await hook.rerender(new Map([[replacement.serverId, replacement]]));
    expect(hook.getCurrent()(replacement.serverId)?.analyticsOptOut).toBe(settingsDefaults.analyticsOptOut);
    expect(hook.getCurrent()(other.serverId)).toBeNull();
});

it('keeps an unknown exact Account unavailable until its persisted policy arrives', async () => {
    const scope = { serverId: 'late-policy-home', accountId: 'late-policy-account' };
    const scopes = new Map([[scope.serverId, scope]]);
    // The real legacy activation writes an unsynchronized exact-Home envelope.
    getPersistenceStorage().set('settings', JSON.stringify({ settings: settingsDefaults, version: 1 }));
    await prepareAccountSettingsScopeForActivation(scope);
    const hook = await renderHook(() => useExactHomeAccountSettings(scopes, ['analyticsOptOut']));
    expect(hook.getCurrent()(scope.serverId)).toBeNull();
    await act(async () => saveAccountSettings(scope, settingsDefaults, 1));
    expect(hook.getCurrent()(scope.serverId)?.analyticsOptOut).toBe(settingsDefaults.analyticsOptOut);
});
