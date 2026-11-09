import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { removeServerProfile, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { storage } from '@/sync/domains/state/storage';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { noteSessionComputerMachine, useSessionComputerMachine } from './sessionComputerMachines';

const homes: Array<Readonly<{ id: string; serverUrl: string }>> = [];
const credentials = (accountId: string) => ({
    token: `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`,
});
async function addHome(name: string) {
    const home = await upsertServerProfile({ serverUrl: `https://computer-hint-${name}.example.test` });
    homes.push(home);
    expect(await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, credentials('account-a'))).toBe(true);
    return home;
}
afterEach(async () => {
    standardCleanup();
    for (const home of homes.splice(0)) {
        await TokenStorage.removeCredentialsForServerUrl(home.serverUrl, { serverId: home.id });
        await removeServerProfile(home.id);
    }
    storage.setState(storage.getInitialState(), true);
});

describe('Session computer-use hints', () => {
    it('preserves Home A while the same Session id on Home B changes, without waking unrelated consumers', async () => {
        const homeA = await addHome('a');
        const homeB = await addHome('b');
        const bindings = await renderHook(() => useServerCredentialAccountScopeBindings([homeA.id, homeB.id]));
        const accountA = bindings.getCurrent().get(homeA.id)!;
        const accountB = bindings.getCurrent().get(homeB.id)!;
        const inputA = { sessionId: 'same-session', serverId: homeA.id, accountLifetime: accountA, machineId: 'machine-a', machineName: 'Studio' };
        const inputB = { ...inputA, serverId: homeB.id, accountLifetime: accountB, machineId: 'machine-b' };
        noteSessionComputerMachine(inputA);
        let rendersA = 0;
        const a = await renderHook(() => { rendersA += 1; return useSessionComputerMachine('same-session', accountA, homeA.id); });
        const b = await renderHook(() => useSessionComputerMachine('same-session', accountB, homeB.id));
        const neighbor = await renderHook(() => useSessionComputerMachine('other-session', accountA, homeA.id));
        const initialA = a.getCurrent();
        const baseline = rendersA;
        await act(async () => {
            noteSessionComputerMachine(inputB);
            noteSessionComputerMachine({ ...inputB, machineName: 'Laptop' });
            noteSessionComputerMachine({ ...inputA, sessionId: 'other-session', machineId: 'neighbor' });
        });
        expect(a.getCurrent()).toBe(initialA);
        expect(a.getCurrent()?.machineId).toBe('machine-a');
        expect(b.getCurrent()).toEqual({ machineId: 'machine-b', machineName: 'Laptop' });
        expect(neighbor.getCurrent()?.machineId).toBe('neighbor');
        await act(async () => { noteSessionComputerMachine(inputA); });
        expect(rendersA - baseline).toBe(0);
    });

    it('retires hints with their actual Account binding and never revives them on same-Account sign-in', async () => {
        const home = await addHome('retirement');
        const bindings = await renderHook(() => useServerCredentialAccountScopeBindings([home.id]));
        const accountA = bindings.getCurrent().get(home.id)!;
        const input = { sessionId: 'same-session', serverId: home.id, accountLifetime: accountA, machineId: 'machine-a' };
        noteSessionComputerMachine(input);
        const hint = await renderHook(() => useSessionComputerMachine('same-session', accountA, home.id));
        expect(hint.getCurrent()?.machineId).toBe('machine-a');
        await act(async () => {
            await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, credentials('account-b'));
            noteSessionComputerMachine(input);
        });
        expect(accountA.isCurrent()).toBe(false);
        expect(hint.getCurrent()).toBeNull();
        await act(async () => {
            await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, credentials('account-a'));
        });
        const renewed = bindings.getCurrent().get(home.id)!;
        expect(renewed.isCurrent()).toBe(true);
        const renewedHint = await renderHook(() => useSessionComputerMachine('same-session', renewed, home.id));
        expect(renewedHint.getCurrent()).toBeNull();
    });

    it('refuses absent Account authority and a mismatched Home', async () => {
        const home = await addHome('qualification');
        const bindings = await renderHook(() => useServerCredentialAccountScopeBindings([home.id]));
        const account = bindings.getCurrent().get(home.id)!;
        noteSessionComputerMachine({ sessionId: 'unadmitted', accountLifetime: null, serverId: home.id, machineId: 'wrong' });
        noteSessionComputerMachine({ sessionId: 'mismatch', accountLifetime: account, serverId: 'foreign-home', machineId: 'wrong' });
        const hook = await renderHook(() => ({
            unadmitted: useSessionComputerMachine('unadmitted', account, home.id),
            mismatch: useSessionComputerMachine('mismatch', account, home.id),
        }));
        expect(hook.getCurrent()).toEqual({ unadmitted: null, mismatch: null });
    });
});
