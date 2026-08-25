import type { MachineAdministrationTargetV1 } from '@happier-dev/protocol';

export type MachineAdministrationCandidateAvailabilityV1 =
    | 'online'
    | 'offline'
    | 'locked'
    | 'missing'
    | 'replaced'
    | 'revoked';

export type MachineAdministrationCandidateV1 = Readonly<{
    target: MachineAdministrationTargetV1;
    displayName: string;
    serverLabel: string;
    availability: MachineAdministrationCandidateAvailabilityV1;
    observation: 'live' | 'stale';
    observedAt: number | null;
    replacementTarget?: MachineAdministrationTargetV1;
}>;

export type MachineAdministrationTargetStateV1 =
    | Readonly<{ kind: 'unselected'; candidates: readonly MachineAdministrationCandidateV1[] }>
    | Readonly<{ kind: 'online'; target: MachineAdministrationTargetV1; machine: MachineAdministrationCandidateV1 }>
    | Readonly<{ kind: 'offline'; target: MachineAdministrationTargetV1; snapshot: MachineAdministrationCandidateV1 }>
    | Readonly<{ kind: 'locked'; target: MachineAdministrationTargetV1; snapshot: MachineAdministrationCandidateV1 }>
    | Readonly<{ kind: 'missing'; target: MachineAdministrationTargetV1; snapshot: MachineAdministrationCandidateV1 | null }>
    | Readonly<{
        kind: 'replaced';
        target: MachineAdministrationTargetV1;
        snapshot: MachineAdministrationCandidateV1;
        replacementTarget?: MachineAdministrationTargetV1;
    }>
    | Readonly<{ kind: 'revoked'; target: MachineAdministrationTargetV1; snapshot: MachineAdministrationCandidateV1 }>;

/**
 * Explicit changes may only name a currently live executable candidate.
 * Tombstones remain displayable through the selected target state, but they
 * can never be promoted into a new persisted authority.
 */
export function isMachineAdministrationCandidateSelectable(
    candidate: MachineAdministrationCandidateV1,
): boolean {
    return candidate.observation === 'live' && candidate.availability === 'online';
}

export function machineAdministrationTargetsEqual(
    left: MachineAdministrationTargetV1,
    right: MachineAdministrationTargetV1,
): boolean {
    return left.serverIdentityId === right.serverIdentityId && left.machineId === right.machineId;
}

/**
 * How the picker names the machine and server a target points at.
 *
 * A confirmation for an irreversible machine-scoped change must say which
 * machine and which server it lands on: the same wording against a different
 * selection is a different action. The candidate inventory owns those labels,
 * so callers reuse them instead of inventing a second naming rule. A target
 * that is no longer in the inventory still has its own portable ids, and those
 * are the truthful fallback rather than an omission.
 */
export function resolveMachineAdministrationTargetLabel(params: Readonly<{
    target: MachineAdministrationTargetV1 | null;
    candidates: readonly MachineAdministrationCandidateV1[];
}>): Readonly<{ machine: string; server: string }> | null {
    const target = params.target;
    if (!target) return null;
    const candidate = params.candidates.find((entry) => (
        machineAdministrationTargetsEqual(entry.target, target)
    )) ?? null;
    return Object.freeze({
        machine: candidate?.displayName ?? target.machineId,
        server: candidate?.serverLabel ?? target.serverIdentityId,
    });
}

function compareCandidates(left: MachineAdministrationCandidateV1, right: MachineAdministrationCandidateV1): number {
    const serverOrder = left.target.serverIdentityId.localeCompare(right.target.serverIdentityId);
    return serverOrder !== 0 ? serverOrder : left.target.machineId.localeCompare(right.target.machineId);
}

/**
 * Administration's sole zero/one/many target decision. Ordering is presentation
 * only: it never selects among multiple candidates. A stored target remains the
 * authority even while unavailable, so another online machine cannot inherit
 * consequential work.
 */
export function resolveMachineAdministrationTargetState(params: Readonly<{
    storedTarget: MachineAdministrationTargetV1 | null;
    candidates: readonly MachineAdministrationCandidateV1[];
    allowSoleCandidate?: boolean;
}>): MachineAdministrationTargetStateV1 {
    const candidates = [...params.candidates].sort(compareCandidates);
    if (params.storedTarget === null) {
        const only = candidates[0];
        if (
            params.allowSoleCandidate === false
            || candidates.length !== 1
            || only?.availability !== 'online'
            || only.observation !== 'live'
        ) {
            return Object.freeze({ kind: 'unselected', candidates: Object.freeze(candidates) });
        }
        return projectCandidateState(only.target, only);
    }

    const selected = candidates.find((candidate) => (
        machineAdministrationTargetsEqual(candidate.target, params.storedTarget!)
    ));
    if (!selected) {
        return Object.freeze({ kind: 'missing', target: params.storedTarget, snapshot: null });
    }
    return projectCandidateState(params.storedTarget, selected);
}

function projectCandidateState(
    target: MachineAdministrationTargetV1,
    candidate: MachineAdministrationCandidateV1,
): MachineAdministrationTargetStateV1 {
    if (candidate.observation === 'stale' && candidate.availability === 'online') {
        return Object.freeze({ kind: 'offline', target, snapshot: candidate });
    }
    switch (candidate.availability) {
        case 'online':
            return Object.freeze({ kind: 'online', target, machine: candidate });
        case 'offline':
            return Object.freeze({ kind: 'offline', target, snapshot: candidate });
        case 'locked':
            return Object.freeze({ kind: 'locked', target, snapshot: candidate });
        case 'missing':
            return Object.freeze({ kind: 'missing', target, snapshot: candidate });
        case 'replaced':
            return Object.freeze({
                kind: 'replaced',
                target,
                snapshot: candidate,
                ...(candidate.replacementTarget ? { replacementTarget: candidate.replacementTarget } : {}),
            });
        case 'revoked':
            return Object.freeze({ kind: 'revoked', target, snapshot: candidate });
    }
}
