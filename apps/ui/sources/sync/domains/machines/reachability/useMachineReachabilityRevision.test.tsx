import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import {
    clearMachineRequestReachabilityForTest,
    readMachineRequestReachabilityRevision,
    recordMachineRequestFailed,
    recordMachineRequestSucceeded,
} from './machineReachability';
import { useMachineReachabilityRevision } from './useMachineReachabilityRevision';
import { removeServerProfile, setServerProfileIdentityForUrl, upsertServerProfile } from '@/sync/domains/server/serverProfiles';

afterEach(() => {
    standardCleanup();
    clearMachineRequestReachabilityForTest();
});

describe('useMachineReachabilityRevision', () => {
    it('keeps a mounted profile-id subscription live when its canonical Home identity arrives', async () => {
        const profile = await upsertServerProfile({ serverUrl: 'https://last-answer-alias.example.test' });
        const scope = { serverId: profile.id, accountId: 'account-a' };
        const hook = await renderHook(() => useMachineReachabilityRevision(true, scope, 'machine'));
        try {
            await act(async () => recordMachineRequestSucceeded({ ...scope, machineId: 'machine', observedAtMs: 1 }));
            const beforeIdentity = hook.getCurrent();
            await act(async () => { await setServerProfileIdentityForUrl(profile.serverUrl, 'srv_last_answer_alias'); });
            await act(async () => recordMachineRequestFailed({ serverId: 'srv_last_answer_alias', accountId: scope.accountId,
                machineId: 'machine', observedAtMs: 2 }));
            expect(hook.getCurrent()).toBeGreaterThan(beforeIdentity);
            expect(hook.getCurrent()).toBe(readMachineRequestReachabilityRevision());
        } finally {
            await hook.unmount();
            await removeServerProfile(profile.id);
        }
    });
    it('keeps disabled readers quiet and acquires current reachability when enabled', async () => {
        let renders = 0;
        const hook = await renderHook((props: { enabled: boolean }) => {
            renders += 1;
            return useMachineReachabilityRevision(props.enabled);
        }, { initialProps: { enabled: false } });
        const idleRenders = renders;
        const idleRevision = hook.getCurrent();
        await act(async () => {
            recordMachineRequestFailed({ serverId: 'home', accountId: 'account-a', machineId: 'machine', observedAtMs: 1 });
            recordMachineRequestSucceeded({ serverId: 'home', accountId: 'account-a', machineId: 'machine', observedAtMs: 2 });
        });
        expect(renders).toBe(idleRenders);
        expect(hook.getCurrent()).toBe(idleRevision);

        await hook.rerender({ enabled: true });
        expect(hook.getCurrent()).toBe(readMachineRequestReachabilityRevision());
        await act(async () => {
            recordMachineRequestFailed({ serverId: 'home', accountId: 'account-a', machineId: 'machine', observedAtMs: 3 });
        });
        expect(hook.getCurrent()).toBe(readMachineRequestReachabilityRevision());

        await hook.rerender({ enabled: false });
        const disabledRenders = renders;
        await act(async () => {
            recordMachineRequestSucceeded({ serverId: 'home', accountId: 'account-a', machineId: 'machine', observedAtMs: 4 });
        });
        expect(renders).toBe(disabledRenders);
        await hook.unmount();
    });

    it('retains subscription and freshness for callers using the enabled default', async () => {
        const hook = await renderHook(() => useMachineReachabilityRevision());
        const initialRevision = hook.getCurrent();
        await act(async () => {
            recordMachineRequestSucceeded({ serverId: 'home', accountId: 'account-a', machineId: 'default-reader', observedAtMs: 1 });
        });
        expect(hook.getCurrent()).toBeGreaterThan(initialRevision);
        expect(hook.getCurrent()).toBe(readMachineRequestReachabilityRevision());
        await hook.unmount();
    });
});
