import { afterEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { RpcError } from '@happier-dev/protocol/rpcErrors';
import * as scopeKeys from '@/sync/domains/scope/serverAccountScope';
import { captureServerProfileScopeResolver } from '@/sync/domains/server/serverProfiles';
import { publishMachineActivity } from '@/sync/domains/machines/machineActivity';

import {
    clearMachineRequestReachabilityForTest,
    clearMachineRequestReachabilityForScope,
    clearMachineRequestReachabilityForMachine,
    isMachineReachable,
    isMachineRequestReachabilityFailure,
    readMachineRequestReachabilityObservation,
    recordMachineRequestFailed,
    recordMachineRequestSucceeded,
    subscribeMachineRequestReachability,
    resolveMachineReachability,
    withdrawMachinePresenceForScope,
    captureMachinePresenceObservation,
} from './machineReachability';

afterEach(() => {
    clearMachineRequestReachabilityForTest();
    vi.unstubAllEnvs();
});

describe('machine reachability', () => {
    const negotiated = { presenceProtocolVersion: 1 as const };
    it('pushes completed-answer time only to its exact demand and retains it through a later failure', () => {
        const scope = { serverId: 'home', accountId: 'account-a' };
        const ordinary = vi.fn();
        const answered = vi.fn();
        // Call through the existing API before its typed demand parameter lands; no owner logic is replaced.
        const stopAnswered: () => void = Reflect.apply(subscribeMachineRequestReachability, undefined,
            [answered, { scope, machineId: 'selected', fact: 'lastAnsweredAtMs' }]);
        const stops = [subscribeMachineRequestReachability(ordinary), stopAnswered];
        try {
            recordMachineRequestSucceeded({ ...scope, machineId: 'selected', route: 'loopback_direct', observedAtMs: 10 });
            expect(readMachineRequestReachabilityObservation(scope, 'selected')).toBeNull();
            expect(answered).not.toHaveBeenCalled();
            ordinary.mockClear();
            recordMachineRequestSucceeded({ ...scope, machineId: 'selected', observedAtMs: 20 });
            recordMachineRequestSucceeded({ ...scope, machineId: 'selected', observedAtMs: 30 });
            recordMachineRequestSucceeded({ ...scope, machineId: 'selected', observedAtMs: 30 });
            expect(ordinary).toHaveBeenCalledTimes(1);
            expect(answered).toHaveBeenCalledTimes(2);
            expect(readMachineRequestReachabilityObservation(scope, 'selected')).toHaveProperty('lastAnsweredAtMs', 30);
            recordMachineRequestFailed({ ...scope, machineId: 'selected', observedAtMs: 40 });
            recordMachineRequestSucceeded({ ...scope, machineId: 'selected', observedAtMs: 25 });
            expect(readMachineRequestReachabilityObservation(scope, 'selected')).toEqual({
                outcome: 'failed', observedAtMs: 40, lastAnsweredAtMs: 30,
            });
            expect(ordinary).toHaveBeenCalledTimes(2);
            expect(answered).toHaveBeenCalledTimes(2);
            for (let index = 0; index < 138; index++) recordMachineRequestSucceeded({ ...scope, machineId: `other-${index}`, observedAtMs: 50 });
            recordMachineRequestSucceeded({ ...scope, accountId: 'account-b', machineId: 'selected', observedAtMs: 60 });
            recordMachineRequestSucceeded({ ...scope, serverId: 'other-home', machineId: 'selected', observedAtMs: 70 });
            expect(answered).toHaveBeenCalledTimes(2);
            clearMachineRequestReachabilityForScope(scope);
            expect(readMachineRequestReachabilityObservation(scope, 'selected')).toBeNull();
            expect(answered).toHaveBeenCalledTimes(3);
        } finally { stops.forEach(stop => stop()); }
    });
    it('invalidates a retained verdict when pushed activity changes without changing its timestamp', () => {
        const scope = { serverId: 'home', accountId: 'account-a' };
        // Without a heartbeat timestamp the protocol uses the explicit active bit.
        const machine = { id: 'controller', active: true, activeAt: 0 };
        expect(resolveMachineReachability(scope, machine, 100)).toBe('reachable');
        publishMachineActivity(machine, { active: false, activeAt: 0 }, []);
        expect(resolveMachineReachability(scope, machine, 101)).toBe('unreachable');
        publishMachineActivity(machine, { active: true, activeAt: 0 }, []);
        expect(resolveMachineReachability(scope, machine, 102)).toBe('reachable');
    });

    it('uses authoritative activity while keeping request failures and scope withdrawal live', () => {
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_MACHINE_ONLINE_GRACE_MS', '60000');
        const scope = { serverId: 'home', accountId: 'account-a' };
        const machines = Array.from({ length: 138 }, (_, index) => ({ id: `machine-${index}`, active: true, activeAt: 100, ...negotiated }));
        const resolveScope = captureServerProfileScopeResolver();
        const clock = vi.spyOn(Date, 'now');
        try {
            for (const machine of machines) expect(resolveMachineReachability(scope, machine, 110, resolveScope)).toBe('reachable');
            clock.mockClear();
            for (let publication = 0; publication < 5; publication += 1) {
                machines[publication]!.activeAt += 1;
                for (const machine of machines) expect(resolveMachineReachability(scope, machine, 120 + publication, resolveScope)).toBe('reachable');
            }
            expect(clock).not.toHaveBeenCalled();

            const machine = machines[0]!;
            expect(resolveMachineReachability(scope, machine, machine.activeAt + 60_000, resolveScope)).toBe('reachable');
            expect(resolveMachineReachability(scope, machine, machine.activeAt + 60_001, resolveScope)).toBe('reachable');
            // Neither wall-clock direction nor in-place timestamps change activity.
            expect(resolveMachineReachability(scope, machine, 110, resolveScope)).toBe('reachable');
            machine.activeAt = 70_000;
            expect(resolveMachineReachability(scope, machine, 70_000, resolveScope)).toBe('reachable');
            recordMachineRequestFailed({ ...scope, machineId: machine.id, observedAtMs: 70_001 });
            expect(resolveMachineReachability(scope, machine, 70_001, resolveScope)).toBe('unreachable');
            recordMachineRequestSucceeded({ ...scope, machineId: machine.id, observedAtMs: 70_002 });
            expect(resolveMachineReachability(scope, machine, 70_002, resolveScope)).toBe('reachable');
            expect(resolveMachineReachability({ ...scope, accountId: 'account-b' }, machine, 70_002, resolveScope)).toBe('reachable');
            withdrawMachinePresenceForScope(scope);
            expect(resolveMachineReachability(scope, machine, 70_002, resolveScope)).toBe('reachable');
            captureMachinePresenceObservation(scope)([machine.id]);
            expect(resolveMachineReachability(scope, machine, 70_002, resolveScope)).toBe('reachable');
            const mutable = { ...machine, revokedAt: 0 };
            expect(resolveMachineReachability(scope, mutable, 70_002, resolveScope)).toBe('reachable');
            mutable.revokedAt = 1;
            expect(resolveMachineReachability(scope, mutable, 70_002, resolveScope)).toBe('unreachable');
            machine.active = false;
            expect(resolveMachineReachability(scope, machine, 70_002, resolveScope)).toBe('unreachable');
            // A released Home without the presence marker still uses the legacy heartbeat grace.
            const legacy = { id: 'legacy-home-machine', active: true, activeAt: 100 };
            expect(resolveMachineReachability(scope, legacy, 60_100, resolveScope)).toBe('reachable');
            expect(resolveMachineReachability(scope, legacy, 60_101, resolveScope)).toBe('unreachable');
        } finally {
            clock.mockRestore();
        }
    });

    it('reads a 138-Machine publication without rebuilding scoped keys or resolving each scope twice', () => {
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_MACHINE_ONLINE_GRACE_MS', '60000');
        const scope = { serverId: 'home', accountId: 'account-a' };
        const machines = Array.from({ length: 138 }, (_, index) => ({ id: `machine-${index}`, active: true, activeAt: 100, ...negotiated }));
        const resolveScope = vi.fn(captureServerProfileScopeResolver());
        recordMachineRequestSucceeded({ ...scope, machineId: machines[0]!.id, observedAtMs: 100 });
        const observation = readMachineRequestReachabilityObservation(scope, machines[0]!.id);
        const encode = vi.spyOn(scopeKeys, 'serverAccountScopedResourceKey');
        try {
            for (let publication = 0; publication < 3; publication += 1) {
                // An unrelated Machine change must not rebuild the other rows' identity keys.
                machines[137]!.activeAt += 1;
                recordMachineRequestSucceeded({ ...scope, machineId: machines[137]!.id, observedAtMs: 101 + publication });
                for (const machine of machines) expect(resolveMachineReachability(scope, machine, 110, resolveScope)).toBe('reachable');
                expect(readMachineRequestReachabilityObservation(scope, machines[0]!.id)).toBe(observation);
            }
            expect(resolveScope).toHaveBeenCalledTimes(138 * 3);
            expect(encode).not.toHaveBeenCalled();
        } finally {
            encode.mockRestore();
        }

        // Time alone keeps the verdict; explicit activity and revocation remain live.
        const machine = machines[0]!;
        expect(resolveMachineReachability(scope, machine, 60_101)).toBe('reachable');
        publishMachineActivity(machine, { active: false, activeAt: 60_101 }, []);
        expect(resolveMachineReachability(scope, machine, 60_101)).toBe('unreachable');
        publishMachineActivity(machine, { active: true, activeAt: 60_102 }, []);
        expect(resolveMachineReachability(scope, machine, 60_102)).toBe('reachable');
        expect(resolveMachineReachability(scope, { ...machine, revokedAt: 1 }, 60_101)).toBe('unreachable');

        withdrawMachinePresenceForScope(scope);
        const observe = captureMachinePresenceObservation(scope);
        expect(resolveMachineReachability(scope, machine, 60_101)).toBe('reachable');
        withdrawMachinePresenceForScope(scope);
        observe([machine.id]);
        expect(resolveMachineReachability(scope, machine, 60_101)).toBe('reachable');
        captureMachinePresenceObservation(scope)([machine.id]);
        expect(resolveMachineReachability(scope, machine, 60_101)).toBe('reachable');
        expect(resolveMachineReachability(scope, machines[1]!, 110)).toBe('reachable');
        expect(resolveMachineReachability({ ...scope, accountId: 'account-b' }, machines[1]!, 110)).toBe('reachable');
    });

    it('retains a failed direct route across relay success and clears it at the exact reconnect edge', () => {
        const scope = { serverId: 'home', accountId: 'account-a' };
        const route = 'loopback_direct' as const;
        recordMachineRequestFailed({ ...scope, machineId: 'machine', route, observedAtMs: 20 });
        expect(readMachineRequestReachabilityObservation({ serverId: ' home ', accountId: ' account-a ' }, ' machine ', route)?.outcome).toBe('failed');
        recordMachineRequestSucceeded({ ...scope, machineId: 'machine', observedAtMs: 30 });
        expect(isMachineReachable(scope, { id: 'machine', active: true }, 30)).toBe(true);
        expect(readMachineRequestReachabilityObservation(scope, 'machine', route)?.outcome).toBe('failed');
        expect(readMachineRequestReachabilityObservation({ ...scope, accountId: 'account-b' }, 'machine', route)).toBeNull();
        expect(readMachineRequestReachabilityObservation({ ...scope, serverId: 'other-home' }, 'machine', route)).toBeNull();
        recordMachineRequestFailed({ ...scope, machineId: 'machine2', route, observedAtMs: 20 });
        clearMachineRequestReachabilityForMachine(scope, 'machine');
        expect(readMachineRequestReachabilityObservation(scope, 'machine', route)).toBeNull();
        expect(readMachineRequestReachabilityObservation(scope, 'machine2', route)?.outcome).toBe('failed');
        recordMachineRequestSucceeded({ ...scope, machineId: 'machine2', route, observedAtMs: 40 });
        expect(readMachineRequestReachabilityObservation(scope, 'machine2', route)?.outcome).toBe('succeeded');
        clearMachineRequestReachabilityForScope(scope);
        expect(readMachineRequestReachabilityObservation(scope, 'machine2', route)).toBeNull();
    });

    it('publishes admission changes without retriggering readers for repeated successful replies', () => {
        const scope = { serverId: 'home', accountId: 'account-a' };
        const listener = vi.fn();
        const unsubscribe = subscribeMachineRequestReachability(listener);
        recordMachineRequestSucceeded({ ...scope, machineId: 'machine', observedAtMs: 20 });
        recordMachineRequestSucceeded({ ...scope, machineId: 'machine', observedAtMs: 30 });
        recordMachineRequestSucceeded({ ...scope, machineId: 'machine', observedAtMs: 40 });
        expect(listener).toHaveBeenCalledTimes(1);
        expect(readMachineRequestReachabilityObservation(scope, 'machine')).toEqual({ outcome: 'succeeded', observedAtMs: 40, lastAnsweredAtMs: 40 });
        recordMachineRequestFailed({ ...scope, machineId: 'machine', observedAtMs: 35 });
        expect(listener).toHaveBeenCalledTimes(1);
        recordMachineRequestFailed({ ...scope, machineId: 'machine', observedAtMs: 45 });
        expect(listener).toHaveBeenCalledTimes(2);
        // Transport withdrawal does not replace a settled Machine observation.
        recordMachineRequestSucceeded({ ...scope, machineId: 'machine', observedAtMs: 46 });
        listener.mockClear();
        withdrawMachinePresenceForScope(scope);
        const machine = { id: 'machine', active: true, activeAt: 47 };
        recordMachineRequestSucceeded({ ...scope, machineId: machine.id, observedAtMs: 48 });
        expect(readMachineRequestReachabilityObservation(scope, machine.id)?.outcome).toBe('succeeded');
        expect(resolveMachineReachability(scope, machine, 48)).toBe('reachable');
        captureMachinePresenceObservation(scope)([machine.id]);
        expect(resolveMachineReachability(scope, machine, 48)).toBe('reachable');
        captureMachinePresenceObservation(scope)([machine.id, 'newly-observed']);
        expect(listener).not.toHaveBeenCalled();
        unsubscribe();
    });

    it('retains all 65 online and offline Machine verdicts through socket withdrawal until a new observation', () => {
        const scope = { serverId: 'home', accountId: 'account-a' };
        const machines = Array.from({ length: 65 }, (_, index) => ({
            id: `machine-${index}`, active: index < 2, activeAt: index < 2 ? 1_000_000 : 903_000, ...negotiated,
        }));
        const verdicts = machines.map(machine => resolveMachineReachability(scope, machine, 1_000_000));
        expect(verdicts.filter(verdict => verdict === 'reachable')).toHaveLength(2);
        expect(verdicts.filter(verdict => verdict === 'unreachable')).toHaveLength(63);
        withdrawMachinePresenceForScope(scope);
        for (const nowMs of [100_000_000, 0]) {
            expect(machines.map(machine => resolveMachineReachability(scope, machine, nowMs))).toEqual(verdicts);
        }
        publishMachineActivity(machines[0]!, { active: false, activeAt: 999_999 }, []);
        publishMachineActivity(machines[64]!, { active: true, activeAt: 902_999 }, []);
        captureMachinePresenceObservation(scope)([machines[0]!.id, machines[64]!.id]);
        expect(resolveMachineReachability(scope, machines[0]!, 0)).toBe('unreachable');
        expect(resolveMachineReachability(scope, machines[64]!, 1_000_000)).toBe('reachable');
        expect(resolveMachineReachability(null, machines[0]!, 0)).toBe('unreachable');
        expect(resolveMachineReachability(null, machines[1]!, 0)).toBe('unknown');
    });

    it('keeps a request failure unreachable across newer heartbeats until a request succeeds', () => {
        const listener = vi.fn();
        const unsubscribe = subscribeMachineRequestReachability(listener);
        const scope = { serverId: 'home', accountId: 'account-a' };
        const machine = { id: 'machine', active: true, activeAt: 10 };
        recordMachineRequestFailed({ ...scope, machineId: machine.id, observedAtMs: 20 });
        for (const activeAt of [10, 20, 21, null]) {
            expect(isMachineReachable(scope, { ...machine, activeAt }, 21)).toBe(false);
        }
        expect(isMachineReachable(scope, { ...machine, active: false, activeAt: 21 }, 21)).toBe(false);

        recordMachineRequestSucceeded({ ...scope, machineId: machine.id, observedAtMs: 22 });
        expect(isMachineReachable(scope, machine, 22)).toBe(true);
        expect(listener).toHaveBeenCalledTimes(2);
        unsubscribe();
    });

    it('isolates observations by Home and Account, including a late completion from another Account', () => {
        const accountA = { serverId: 'home', accountId: 'account-a' };
        const accountB = { serverId: 'home', accountId: 'account-b' };
        const machine = { id: 'machine', active: true, activeAt: 100 };
        recordMachineRequestFailed({ ...accountA, machineId: machine.id, observedAtMs: 20 });
        expect(isMachineReachable(accountA, machine, 100)).toBe(false);
        expect(isMachineReachable(accountB, machine, 100)).toBe(true);
        expect(isMachineReachable({ ...accountA, serverId: 'other-home' }, machine, 100)).toBe(true);
        recordMachineRequestFailed({ ...accountB, machineId: machine.id, observedAtMs: 30 });
        recordMachineRequestSucceeded({ ...accountA, machineId: machine.id, observedAtMs: 40 });
        expect(isMachineReachable(accountA, machine, 100)).toBe(true);
        expect(isMachineReachable(accountB, machine, 100)).toBe(false);
    });

    it('classifies transport unavailability without treating capability or encryption errors as offline', () => {
        // A dispatched operation can exceed its response budget while the daemon remains online.
        expect(isMachineRequestReachabilityFailure({ code: 'MACHINE_RPC_TIMEOUT' })).toBe(false);
        expect(isMachineRequestReachabilityFailure({ rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE' })).toBe(false);
        expect(isMachineRequestReachabilityFailure({ code: 'target_unavailable' })).toBe(true);
        expect(isMachineRequestReachabilityFailure({ rpcErrorCode: 'machine_offline' })).toBe(true);
        expect(isMachineRequestReachabilityFailure({ rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE' })).toBe(false);
        expect(isMachineRequestReachabilityFailure({ rpcErrorCode: 'MACHINE_ENCRYPTION_UNAVAILABLE' })).toBe(false);
        // Both the decoded daemon refusal and its transport Error are request-scoped facts.
        expect(isMachineRequestReachabilityFailure({ errorCode: RPC_ERROR_CODES.FORBIDDEN, admissionPredicate: 'machine_currentness' })).toBe(false);
        expect(isMachineRequestReachabilityFailure(new RpcError('Forbidden', RPC_ERROR_CODES.FORBIDDEN))).toBe(false);
    });

    it('clears reconnect failures only for the reconnected Machine or exact Account socket', () => {
        const scope = { serverId: 'home', accountId: 'account-a' };
        const anotherAccount = { ...scope, accountId: 'account-b' };
        const anotherHome = { ...scope, serverId: 'other-home' };
        for (const identity of [scope, anotherAccount, anotherHome]) {
            for (const machineId of ['first', 'second']) recordMachineRequestFailed({ ...identity, machineId });
        }
        clearMachineRequestReachabilityForMachine(scope, 'first');
        expect(readMachineRequestReachabilityObservation(scope, 'first')).toBeNull();
        expect(readMachineRequestReachabilityObservation(scope, 'second')?.outcome).toBe('failed');
        clearMachineRequestReachabilityForScope(scope);
        expect(readMachineRequestReachabilityObservation(scope, 'second')).toBeNull();
        expect(readMachineRequestReachabilityObservation(anotherAccount, 'first')?.outcome).toBe('failed');
        expect(readMachineRequestReachabilityObservation(anotherHome, 'first')?.outcome).toBe('failed');
    });

});
