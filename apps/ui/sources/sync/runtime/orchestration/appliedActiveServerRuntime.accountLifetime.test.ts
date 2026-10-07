import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore, type StoreApi } from 'zustand/vanilla';

import { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { registerStorageStateReader } from '@/sync/domains/state/storageStateReaderBridge';
import { createProfileDomain, type ProfileDomain } from '@/sync/store/domains/profile';
import type { StorageState } from '@/sync/store/types';
import {
    publishAppliedActiveServerRuntimeAvailability,
    publishAppliedActiveServerSnapshot,
    subscribeAppliedActiveServerRuntimeAvailability,
} from './appliedActiveServerRuntime';

describe('active Account retirement at its state producers', () => {
    const scopeA = { serverId: 'srv_account_test', accountId: 'account-a' };
    const scopeB = { serverId: 'srv_account_test', accountId: 'account-b' };
    let profile: StoreApi<ProfileDomain>;

    beforeEach(() => {
        retireActiveServerAccountScopeLifetime();
        profile = createStore<ProfileDomain>((set, get) => createProfileDomain({ set, get }));
        // The registered reader is a storage boundary fixture. These owners read only profileScope.
        registerStorageStateReader(() => profile.getState() as StorageState);
        publishAppliedActiveServerSnapshot({ serverId: scopeA.serverId, serverUrl: 'https://home.example.test', generation: 1 });
        profile.getState().activateProfileScope(scopeA);
    });

    afterEach(() => { retireActiveServerAccountScopeLifetime(); });

    it.each(['switch', 'clear'] as const)('retires Account before profile subscribers read a %s', (transition) => {
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Expected current Account lifetime');
        const retired = vi.fn();
        lifetime.onRetire(retired);
        const observations: number[] = [];
        const unsubscribe = profile.subscribe(() => {
            // A React consumer can capture here; retirement must already have occurred.
            observations.push(retired.mock.calls.length);
            captureActiveServerAccountScopeLifetime();
        });
        if (transition === 'switch') profile.getState().activateProfileScope(scopeB);
        else profile.getState().clearProfileScope();
        unsubscribe();
        expect(observations).toEqual([1]);
        expect(lifetime.isCurrent()).toBe(false);
        expect(captureActiveServerAccountScopeLifetime()?.scope ?? null).toEqual(transition === 'switch' ? scopeB : null);
    });

    it('keeps the lifetime through a profile refresh in the same Account', () => {
        const lifetime = captureActiveServerAccountScopeLifetime();
        const retired = vi.fn();
        lifetime?.onRetire(retired);
        profile.getState().activateProfileScope({ ...scopeA });
        expect(captureActiveServerAccountScopeLifetime()).toBe(lifetime);
        expect(retired).not.toHaveBeenCalled();
    });

    it('retires Account before runtime-unavailable subscribers can capture during render', () => {
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Expected current Account lifetime');
        const retired = vi.fn();
        lifetime.onRetire(retired);
        const observations: number[] = [];
        const unsubscribe = subscribeAppliedActiveServerRuntimeAvailability(() => {
            observations.push(retired.mock.calls.length);
            captureActiveServerAccountScopeLifetime();
        });
        publishAppliedActiveServerRuntimeAvailability(false);
        unsubscribe();
        expect(observations).toEqual([1]);
        expect(lifetime.isCurrent()).toBe(false);
        expect(captureActiveServerAccountScopeLifetime()).toBeNull();
    });
});
