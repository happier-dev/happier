import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { removeServerProfile, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { storage } from '@/sync/domains/state/storage';
import {
    ServerCredentialAccountScopeBindingProvider,
    useServerCredentialAccountScopeBinding,
    type ServerCredentialAccountScopeBindingState,
} from './useServerCredentialAccountScopes';

const homes: Array<Readonly<{ id: string; serverUrl: string }>> = [];

afterEach(async () => {
    vi.restoreAllMocks();
    standardCleanup();
    for (const home of homes.splice(0)) {
        await TokenStorage.removeCredentialsForServerUrl(home.serverUrl, { serverId: home.id });
        await removeServerProfile(home.id);
    }
    storage.setState(storage.getInitialState(), true);
});

describe('inherited Home credential binding', () => {
    it('lets readers below a bound Home scope share its one resolution instead of reading the credential again', async () => {
        const home = await upsertServerProfile({ serverUrl: 'https://credential-inherited-binding.example.test' });
        homes.push(home);
        const token = `e30.${Buffer.from(JSON.stringify({ sub: 'account-a' })).toString('base64url')}.signature`;
        expect(await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, { token })).toBe(true);
        const reads = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl');
        let parent: ServerCredentialAccountScopeBindingState | null = null;
        const children: ServerCredentialAccountScopeBindingState[][] = [[], [], [], []];
        function Reader(props: Readonly<{ index: number }>) {
            const state = useServerCredentialAccountScopeBinding(home.id);
            children[props.index]!.push(state);
            return null;
        }
        function Scope() {
            parent = useServerCredentialAccountScopeBinding(home.id);
            // The Board's record, approval, plugin and hosted-HTML readers sit below the Session's scope.
            return <ServerCredentialAccountScopeBindingProvider serverId={home.id} state={parent}>
                <Reader index={0} /><Reader index={1} /><Reader index={2} /><Reader index={3} />
            </ServerCredentialAccountScopeBindingProvider>;
        }

        await renderScreen(<Scope />);
        await flushHookEffects({ cycles: 4 });

        expect(reads).toHaveBeenCalledTimes(1);
        const bound = parent!.binding;
        expect(bound?.isCurrent()).toBe(true);
        for (const states of children) {
            // Each reader observes the scope's own states: resolving, then the same bound lifetime.
            expect(states.at(-1)?.binding).toBe(bound);
            expect(new Set(states.map(state => state.resolution.kind))).toEqual(new Set(['resolving', 'bound']));
        }
    });
});
