import { describe, expect, it } from 'vitest';

import {
    buildMachineAdministrationTargetRouteParams,
    isMachineAdministrationCandidateExplicitlySelectable,
    isMachineAdministrationCandidateSelectable,
    readMachineAdministrationTargetRouteParams,
    resolveMachineAdministrationTargetLabel,
    resolveMachineAdministrationTargetState,
    type MachineAdministrationCandidateV1,
} from './targetSelection';

describe('machine Administration route target', () => {
    it('round-trips the complete portable identity and rejects machine-only or ambiguous params', () => {
        const target = { serverIdentityId: 'srv_two', machineId: 'machine-shared' };
        expect(readMachineAdministrationTargetRouteParams(
            buildMachineAdministrationTargetRouteParams(target),
        )).toEqual(target);
        expect(readMachineAdministrationTargetRouteParams({ machineId: 'machine-shared' }))
            .toBeNull();
        expect(readMachineAdministrationTargetRouteParams({
            serverIdentityId: ['srv_one', 'srv_two'],
            machineId: 'machine-shared',
        })).toBeNull();
    });
});

function candidate(input: Readonly<{
    serverIdentityId: string;
    machineId: string;
    availability?: MachineAdministrationCandidateV1['availability'];
    observation?: MachineAdministrationCandidateV1['observation'];
    replacementTarget?: MachineAdministrationCandidateV1['replacementTarget'];
}>): MachineAdministrationCandidateV1 {
    return {
        target: {
            serverIdentityId: input.serverIdentityId,
            machineId: input.machineId,
        },
        displayName: input.machineId,
        serverLabel: input.serverIdentityId,
        availability: input.availability ?? 'online',
        observation: input.observation ?? 'live',
        observedAt: 100,
        ...(input.replacementTarget ? { replacementTarget: input.replacementTarget } : {}),
    };
}

describe('resolveMachineAdministrationTargetLabel', () => {
    it('names the exact selected machine and server, not another candidate with the same machine id', () => {
        // One machine id observed under two server identities is the case a
        // machine-scoped confirmation must not blur: an irreversible change
        // confirmed against `srv_two` must not be described with `srv_one`'s row.
        const onSrvOne: MachineAdministrationCandidateV1 = {
            ...candidate({ serverIdentityId: 'srv_one', machineId: 'machine-shared' }),
            displayName: 'Laptop',
            serverLabel: 'Server One',
        };
        const onSrvTwo: MachineAdministrationCandidateV1 = {
            ...candidate({ serverIdentityId: 'srv_two', machineId: 'machine-shared' }),
            displayName: 'Build box',
            serverLabel: 'Server Two',
        };

        expect(resolveMachineAdministrationTargetLabel({
            target: { serverIdentityId: 'srv_two', machineId: 'machine-shared' },
            candidates: [onSrvOne, onSrvTwo],
        })).toEqual({ machine: 'Build box', server: 'Server Two' });
        expect(resolveMachineAdministrationTargetLabel({
            target: { serverIdentityId: 'srv_one', machineId: 'machine-shared' },
            candidates: [onSrvOne, onSrvTwo],
        })).toEqual({ machine: 'Laptop', server: 'Server One' });
    });

    it('falls back to the portable target ids rather than omitting the target', () => {
        expect(resolveMachineAdministrationTargetLabel({
            target: { serverIdentityId: 'srv_gone', machineId: 'machine-gone' },
            candidates: [candidate({ serverIdentityId: 'srv_one', machineId: 'machine-a' })],
        })).toEqual({ machine: 'machine-gone', server: 'srv_gone' });
        expect(resolveMachineAdministrationTargetLabel({
            target: null,
            candidates: [candidate({ serverIdentityId: 'srv_one', machineId: 'machine-a' })],
        })).toBeNull();
    });
});

describe('resolveMachineAdministrationTargetState', () => {
    it('admits only a live online candidate for an explicit target change', () => {
        expect(isMachineAdministrationCandidateSelectable(candidate({
            serverIdentityId: 'srv_one',
            machineId: 'machine-online',
        }))).toBe(true);
        expect(isMachineAdministrationCandidateSelectable(candidate({
            serverIdentityId: 'srv_one',
            machineId: 'machine-stale',
            observation: 'stale',
        }))).toBe(false);
        expect(isMachineAdministrationCandidateSelectable(candidate({
            serverIdentityId: 'srv_one',
            machineId: 'machine-locked',
            availability: 'locked',
        }))).toBe(false);
    });

    it('lets a consumer that shows last-known state opt in to choosing an offline machine, never a locked one', () => {
        const offline = candidate({ serverIdentityId: 'srv_one', machineId: 'machine-offline', availability: 'offline' });
        const stale = candidate({ serverIdentityId: 'srv_one', machineId: 'machine-stale', observation: 'stale' });
        const locked = candidate({ serverIdentityId: 'srv_one', machineId: 'machine-locked', availability: 'locked' });
        const online = candidate({ serverIdentityId: 'srv_one', machineId: 'machine-online' });

        expect(isMachineAdministrationCandidateExplicitlySelectable(offline, 'live')).toBe(false);
        expect(isMachineAdministrationCandidateExplicitlySelectable(offline, 'lastKnown')).toBe(true);
        expect(isMachineAdministrationCandidateExplicitlySelectable(stale, 'lastKnown')).toBe(true);
        expect(isMachineAdministrationCandidateExplicitlySelectable(locked, 'lastKnown')).toBe(false);
        expect(isMachineAdministrationCandidateExplicitlySelectable(online, 'live')).toBe(true);
    });

    it('does not choose the first candidate when several portable targets exist', () => {
        const machineA = candidate({ serverIdentityId: 'srv_one', machineId: 'machine-a' });
        const machineB = candidate({ serverIdentityId: 'srv_one', machineId: 'machine-b' });

        const first = resolveMachineAdministrationTargetState({
            storedTarget: null,
            candidates: [machineB, machineA],
        });
        const reordered = resolveMachineAdministrationTargetState({
            storedTarget: null,
            candidates: [machineA, machineB],
        });

        expect(first).toEqual({ kind: 'unselected', candidates: [machineA, machineB] });
        expect(reordered).toEqual(first);
    });

    it('selects the sole portable candidate by default without treating array position as authority', () => {
        const only = candidate({ serverIdentityId: 'srv_one', machineId: 'machine-a' });

        expect(resolveMachineAdministrationTargetState({
            storedTarget: null,
            candidates: [only],
        })).toEqual({ kind: 'online', target: only.target, machine: only });
    });

    it('leaves a sole candidate unselected when its consumer requires an explicit choice', () => {
        const only = candidate({ serverIdentityId: 'srv_one', machineId: 'machine-a' });

        expect(resolveMachineAdministrationTargetState({
            storedTarget: null,
            candidates: [only],
            allowSoleCandidate: false,
        })).toEqual({ kind: 'unselected', candidates: [only] });
    });

    it('does not initialize an unavailable sole candidate as an executable target', () => {
        const offline = candidate({
            serverIdentityId: 'srv_one',
            machineId: 'machine-offline',
            availability: 'offline',
        });

        expect(resolveMachineAdministrationTargetState({
            storedTarget: null,
            candidates: [offline],
        })).toEqual({ kind: 'unselected', candidates: [offline] });
    });

    it('does not initialize a sole candidate while another profile inventory is unresolved', () => {
        const onlyObserved = candidate({ serverIdentityId: 'srv_one', machineId: 'machine-online' });

        expect(resolveMachineAdministrationTargetState({
            storedTarget: null,
            candidates: [onlyObserved],
            allowSoleCandidate: false,
        })).toEqual({ kind: 'unselected', candidates: [onlyObserved] });
    });

    it('projects a stale cached online row as offline and never executable', () => {
        const stale = candidate({
            serverIdentityId: 'srv_one',
            machineId: 'machine-stale',
            observation: 'stale',
        });

        expect(resolveMachineAdministrationTargetState({
            storedTarget: stale.target,
            candidates: [stale],
        })).toEqual({ kind: 'offline', target: stale.target, snapshot: stale });
    });

    it('keeps an offline stored target selected while another machine is online', () => {
        const machineA = candidate({
            serverIdentityId: 'srv_one',
            machineId: 'machine-a',
            availability: 'offline',
        });
        const machineB = candidate({ serverIdentityId: 'srv_one', machineId: 'machine-b' });

        expect(resolveMachineAdministrationTargetState({
            storedTarget: machineA.target,
            candidates: [machineB, machineA],
        })).toEqual({ kind: 'offline', target: machineA.target, snapshot: machineA });
    });

    it('does not call a saved target missing when no caller says its Home\'s list was read', () => {
        const storedTarget = { serverIdentityId: 'srv_one', machineId: 'machine-a' };
        expect(resolveMachineAdministrationTargetState({ storedTarget, candidates: [] }))
            .toEqual({ kind: 'missing', target: storedTarget, snapshot: null, inventoryKnown: false });
    });

    it('does not call a saved target missing while its Home\'s machine list is unread', () => {
        const storedTarget = { serverIdentityId: 'srv_one', machineId: 'machine-a' };
        const other = candidate({ serverIdentityId: 'srv_two', machineId: 'machine-b' });

        expect(resolveMachineAdministrationTargetState({
            storedTarget,
            candidates: [other],
            isInventoryKnown: (serverIdentityId) => serverIdentityId === 'srv_two',
        })).toEqual({ kind: 'missing', target: storedTarget, snapshot: null, inventoryKnown: false });
        // Once that Home's list is read and the machine is still absent, it is really gone.
        expect(resolveMachineAdministrationTargetState({
            storedTarget,
            candidates: [other],
            isInventoryKnown: () => true,
        })).toEqual({ kind: 'missing', target: storedTarget, snapshot: null });
    });

    it.each(['loading', 'error', 'signedOut'] as const)('preserves the saved target and its inventory %s without authorizing execution', (inventoryStatus) => {
        const storedTarget = { serverIdentityId: 'srv_one', machineId: 'machine-a' };
        expect(resolveMachineAdministrationTargetState({
            storedTarget, candidates: [], readInventoryStatus: () => inventoryStatus,
        })).toEqual({ kind: 'missing', target: storedTarget, snapshot: null, inventoryKnown: false, inventoryStatus });
    });

    it('keeps missing and replaced targets as tombstones instead of roaming', () => {
        const storedTarget = { serverIdentityId: 'srv_one', machineId: 'machine-a' };
        const replacement = candidate({ serverIdentityId: 'srv_one', machineId: 'machine-b' });

        expect(resolveMachineAdministrationTargetState({
            isInventoryKnown: () => true,
            storedTarget,
            candidates: [replacement],
        })).toEqual({ kind: 'missing', target: storedTarget, snapshot: null });

        const replaced = candidate({
            serverIdentityId: 'srv_one',
            machineId: 'machine-a',
            availability: 'replaced',
            replacementTarget: replacement.target,
        });
        expect(resolveMachineAdministrationTargetState({
            storedTarget,
            candidates: [replacement, replaced],
        })).toEqual({
            kind: 'replaced',
            target: storedTarget,
            snapshot: replaced,
            replacementTarget: replacement.target,
        });
    });

    it('keeps duplicate machine ids distinct across portable server identities', () => {
        const first = candidate({ serverIdentityId: 'srv_one', machineId: 'machine-shared' });
        const second = candidate({ serverIdentityId: 'srv_two', machineId: 'machine-shared' });

        expect(resolveMachineAdministrationTargetState({
            storedTarget: second.target,
            candidates: [first, second],
        })).toEqual({ kind: 'online', target: second.target, machine: second });
    });

});
