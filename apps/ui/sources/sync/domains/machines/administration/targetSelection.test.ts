import { describe, expect, it } from 'vitest';

import {
    isMachineAdministrationCandidateSelectable,
    resolveMachineAdministrationTargetState,
    type MachineAdministrationCandidateV1,
} from './targetSelection';

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

    it('keeps missing and replaced targets as tombstones instead of roaming', () => {
        const storedTarget = { serverIdentityId: 'srv_one', machineId: 'machine-a' };
        const replacement = candidate({ serverIdentityId: 'srv_one', machineId: 'machine-b' });

        expect(resolveMachineAdministrationTargetState({
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
