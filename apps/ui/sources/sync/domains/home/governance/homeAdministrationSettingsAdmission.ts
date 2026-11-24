import type { HomeGovernanceProjectionV1 } from '@happier-dev/protocol/home/governance';

import {
    isAuthoritativeScopedSnapshotRefusal,
    type ScopedSnapshotError,
} from '@/sync/domains/scope/scopedSnapshotFacts';

import { resolveHomeAdministrationAdmission } from './homeAdministrationAdmission';

/**
 * What this device knows about one Home in the exact set, as one value.
 *
 * `scope` is a fact about this device's own credentials and `projection` is the
 * Home's own answer. Keeping both means the surface can say "you are signed out
 * of this Home" instead of the far less useful "this Home is unavailable".
 */
export type HomeAdministrationHomeObservation = Readonly<{
    scope: 'resolving' | 'unknown_home' | 'unavailable' | 'signed_out' | 'bound';
    /**
     * Who this Account is there: the last projection this Home returned, retained through refresh and failure, or
     * until it answers in this process, how it answered last on this device. A refusal withdraws both.
     */
    projection: Pick<HomeGovernanceProjectionV1, 'viewer' | 'capabilities' | 'setupState'> | null;
    error: ScopedSnapshotError | null;
    stale: boolean;
}>;

/**
 * Why one Home in the exact set is, or is not, offering Home Administration.
 *
 * `denied` is a settled answer — this Account has no authority there, or that
 * Home has no administration at all. `unresolved` is not an answer yet, and the
 * two must never be shown as the same thing.
 */
export type HomeAdministrationHomeEntry =
    | Readonly<{ serverId: string; state: 'admitted'; reason: 'capability' | 'owner_setup_required' }>
    | Readonly<{ serverId: string; state: 'denied' }>
    | Readonly<{
        serverId: string;
        state: 'unresolved';
        reason: 'loading' | 'signed_out' | 'unknown_home' | 'unreachable';
    }>;

export type HomeAdministrationSettingsAdmission = Readonly<{
    /** True when the exact Home set contains at least one administrable Home. */
    admitted: boolean;
    /** One entry per Home in the exact set, in the caller's order. */
    homes: readonly HomeAdministrationHomeEntry[];
    admittedServerIds: readonly string[];
    unresolvedServerIds: readonly string[];
}>;

const EMPTY_ADMISSION: HomeAdministrationSettingsAdmission = Object.freeze({
    admitted: false,
    homes: Object.freeze([]) as readonly HomeAdministrationHomeEntry[],
    admittedServerIds: Object.freeze([]) as readonly string[],
    unresolvedServerIds: Object.freeze([]) as readonly string[],
});

function normalizeServerIds(serverIds: readonly (string | null | undefined)[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of serverIds) {
        const serverId = typeof raw === 'string' ? raw.trim() : '';
        if (!serverId || seen.has(serverId)) continue;
        seen.add(serverId);
        out.push(serverId);
    }
    return out;
}

function resolveHomeEntry(
    serverId: string,
    observation: HomeAdministrationHomeObservation | undefined,
): HomeAdministrationHomeEntry {
    if (!observation) return { serverId, state: 'unresolved', reason: 'loading' };

    switch (observation.scope) {
        case 'unknown_home':
            return { serverId, state: 'unresolved', reason: 'unknown_home' };
        case 'signed_out':
            return { serverId, state: 'unresolved', reason: 'signed_out' };
        case 'resolving':
            return { serverId, state: 'unresolved', reason: 'loading' };
        case 'unavailable':
            return { serverId, state: 'unresolved', reason: 'unreachable' };
        case 'bound':
            break;
    }

    if (observation.error?.code === 'home_governance_setup_required') {
        return { serverId, state: 'admitted', reason: 'owner_setup_required' };
    }

    // An authoritative refusal outranks anything retained. A Home that is merely
    // offline keeps its projection deciding — losing the connection does not
    // remove an administrator's authority — but a Home that answered "not you",
    // "not with that credential" or "no such operation" has withdrawn it, and
    // offering the destination from the superseded projection would be a false
    // promise the route would then have to refuse.
    if (isAuthoritativeScopedSnapshotRefusal(observation.error)) return { serverId, state: 'denied' };

    if (observation.projection) {
        const admission = resolveHomeAdministrationAdmission(observation.projection);
        return admission.state === 'admitted'
            ? { serverId, state: 'admitted', reason: admission.reason }
            : { serverId, state: 'denied' };
    }

    return {
        serverId,
        state: 'unresolved',
        reason: observation.error ? 'unreachable' : 'loading',
    };
}

/**
 * The Settings admission decision for the Home Administration destination over
 * the exact set of Homes the user is looking at.
 *
 * Each Home decides for itself from its own projection and its own Account:
 * being an owner of one Home says nothing about another, and no feature bit or
 * focused-Home role takes part. This is one narrow runtime admission predicate
 * for what to offer, never a substitute for the authorization each Home
 * performs on the request itself.
 */
export function resolveHomeAdministrationSettingsAdmission(params: Readonly<{
    serverIds: readonly (string | null | undefined)[];
    observationsByServerId: Readonly<Record<string, HomeAdministrationHomeObservation | undefined>>;
}>): HomeAdministrationSettingsAdmission {
    const serverIds = normalizeServerIds(params.serverIds);
    if (serverIds.length === 0) return EMPTY_ADMISSION;

    const homes: HomeAdministrationHomeEntry[] = [];
    const admittedServerIds: string[] = [];
    const unresolvedServerIds: string[] = [];

    for (const serverId of serverIds) {
        const entry = resolveHomeEntry(serverId, params.observationsByServerId[serverId]);
        homes.push(entry);
        if (entry.state === 'admitted') admittedServerIds.push(serverId);
        else if (entry.state === 'unresolved') unresolvedServerIds.push(serverId);
    }

    return Object.freeze({
        admitted: admittedServerIds.length > 0,
        homes: Object.freeze(homes) as readonly HomeAdministrationHomeEntry[],
        admittedServerIds: Object.freeze(admittedServerIds) as readonly string[],
        unresolvedServerIds: Object.freeze(unresolvedServerIds) as readonly string[],
    });
}
