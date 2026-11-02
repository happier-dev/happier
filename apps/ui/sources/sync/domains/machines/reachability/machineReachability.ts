import { isMachineReachableV1, isMachineRequestReachabilityFailureV1 } from '@happier-dev/protocol/machines/machineReachabilityV1';
import { readMachineOnlineGraceMsFromEnv } from '@/utils/sessions/machineUtils';
import { createServerAccountScope, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent, resolveServerProfileScopeIdForIdentifier, type ProfileScopeResolver } from '@/sync/domains/server/serverProfiles';
import type { SessionMachineReachability } from './resolveSessionMachineReachability';
import { readMachineActivity } from '@/sync/domains/machines/machineActivity';

export type MachineReachabilityScope = ServerAccountScope;

export type MachineRequestReachabilityObservation = Readonly<{
    outcome: 'succeeded' | 'failed';
    observedAtMs: number;
    /** Completed authenticated RPC reply; direct-route OPTIONS is not an answer. */
    lastAnsweredAtMs?: number;
}>;

type MachineRequestObservationInput = MachineReachabilityScope & Readonly<{
    machineId: string;
    observedAtMs?: number;
    /** A transport failure does not make a Machine unreachable through another route. */
    route?: 'loopback_direct';
}>;

type ScopeReachability = {
    relay: Map<string, MachineRequestReachabilityObservation>;
    direct: Map<string, MachineRequestReachabilityObservation>;
    // A transport withdrawal invalidates retained presence, not Machine identity.
    // Each fresh ingress/read re-observes only its own Machine in that exact scope.
    observedSinceWithdrawal?: Set<string>;
};

// Index the identity parts directly: reads do not rebuild encoded resource keys.
const scopes = new Map<string, Map<string, ScopeReachability>>();
type MachinePresence = Parameters<typeof isMachineReachable>[1];
type DerivedReachability = {
    serverId: string;
    accountId: string;
    machineId: string;
    active: boolean;
    activeAt: number | null | undefined;
    revokedAt: number | null | undefined;
    observation: MachineRequestReachabilityObservation | null;
    graceMs: number;
    evaluatedAtMs: number;
    reachable: boolean;
};
// A row's descriptive verdict is derived again only when its own inputs change.
// Scope, request failure, revocation and withdrawal remain live checks on every read.
let derivedReachability = new WeakMap<MachinePresence, DerivedReachability>();
export type MachineRequestReachabilityChange = Readonly<{
    scope: MachineReachabilityScope;
    /** Absence means the whole Account's observation changed (withdrawal or retirement). */
    machineIds?: readonly string[];
}>;
type ReachabilitySubscription = Readonly<{
    scope?: MachineReachabilityScope;
    machineId?: string | null;
    fact?: 'lastAnsweredAtMs';
}>;
const listeners = new Map<(change: MachineRequestReachabilityChange | null) => void, ReachabilitySubscription>();
const recoveryListeners = new Set<(scope: MachineReachabilityScope, machineId: string) => void>();
let revision = 0;

function normalizeScope(scope: MachineReachabilityScope | null | undefined, resolveScopeId: ProfileScopeResolver = resolveServerProfileScopeIdForIdentifier): MachineReachabilityScope | null {
    return createServerAccountScope(resolveScopeId(scope?.serverId), scope?.accountId);
}

function readScope(scope: MachineReachabilityScope): ScopeReachability | undefined {
    return scopes.get(scope.serverId)?.get(scope.accountId);
}

function ensureScope(scope: MachineReachabilityScope): ScopeReachability {
    let accounts = scopes.get(scope.serverId);
    if (!accounts) scopes.set(scope.serverId, accounts = new Map());
    let state = accounts.get(scope.accountId);
    if (!state) {
        state = { relay: new Map(), direct: new Map() };
        accounts.set(scope.accountId, state);
    }
    return state;
}

function retireEmptyScope(scope: MachineReachabilityScope, state: ScopeReachability | undefined): void {
    if (!state || state.relay.size > 0 || state.direct.size > 0 || state.observedSinceWithdrawal) return;
    const accounts = scopes.get(scope.serverId);
    accounts?.delete(scope.accountId);
    if (accounts?.size === 0) scopes.delete(scope.serverId);
}

function readObservation(state: ScopeReachability | undefined, machineId: string | null | undefined, route?: MachineRequestObservationInput['route']): MachineRequestReachabilityObservation | null {
    const id = String(machineId ?? '').trim();
    return state && id ? (route ? state.direct : state.relay).get(id) ?? null : null;
}

function publishReachabilityChange(change: MachineRequestReachabilityChange | null,
    facts: Readonly<{ reachability?: boolean; answer?: boolean }> = {}): void {
    if (facts.reachability !== false) revision += 1;
    for (const [listener, demand] of listeners) {
        if (demand.fact === 'lastAnsweredAtMs' ? !facts.answer : facts.reachability === false) continue;
        if (demand.scope && change && (!areServerProfileIdentifiersEquivalent(change.scope.serverId, demand.scope.serverId)
            || demand.scope.accountId !== change.scope.accountId
            || demand.machineId && change.machineIds && !change.machineIds.includes(demand.machineId))) continue;
        listener(change);
    }
}

/** Called by the existing Account socket's transport-withdrawal edge. Reconnect alone is not a presence observation. */
export function withdrawMachinePresenceForScope(scope: MachineReachabilityScope): void {
    const normalized = normalizeScope(scope);
    if (!normalized) return;
    ensureScope(normalized).observedSinceWithdrawal = new Set();
    publishReachabilityChange({ scope: normalized });
}

/** Capture before an HTTP read so a pre-withdrawal response cannot restore old presence. */
export function captureMachinePresenceObservation(scope: MachineReachabilityScope | null): (machineIds: readonly string[]) => void {
    const normalized = normalizeScope(scope);
    const state = normalized ? readScope(normalized) : undefined;
    const captured = state?.observedSinceWithdrawal;
    return machineIds => {
        if (!captured || state?.observedSinceWithdrawal !== captured) return;
        const changedMachineIds: string[] = [];
        for (const machineId of machineIds) {
            if (!captured.has(machineId)) { captured.add(machineId); changedMachineIds.push(machineId); }
        }
        if (changedMachineIds.length > 0 && normalized) publishReachabilityChange({ scope: normalized, machineIds: changedMachineIds });
    };
}

function recordMachineRequestObservation(
    input: MachineRequestObservationInput,
    outcome: MachineRequestReachabilityObservation['outcome'],
): void {
    const normalized = normalizeScope(input);
    const id = String(input.machineId ?? '').trim();
    if (!normalized || !id) return;
    const state = ensureScope(normalized);
    const observations = input.route ? state.direct : state.relay;
    const observedAtMs = input.observedAtMs ?? Date.now();
    const previous = observations.get(id);
    if (previous && previous.observedAtMs > observedAtMs) return;
    if (previous?.outcome === outcome && previous.observedAtMs === observedAtMs) return;
    const lastAnsweredAtMs = outcome === 'succeeded' && !input.route ? observedAtMs : previous?.lastAnsweredAtMs;
    observations.set(id, { outcome, observedAtMs, ...(lastAnsweredAtMs === undefined ? {} : { lastAnsweredAtMs }) });
    const reachability = previous?.outcome !== outcome;
    const answer = previous?.lastAnsweredAtMs !== lastAnsweredAtMs;
    // Repeated replies update only consumers asking for the answer time, never automatic readers.
    if (reachability || answer) publishReachabilityChange({ scope: normalized, machineIds: [id] }, { reachability, answer });
}

export function recordMachineRequestFailed(input: MachineRequestObservationInput): void {
    recordMachineRequestObservation(input, 'failed');
}

export function recordMachineRequestSucceeded(input: MachineRequestObservationInput): void {
    recordMachineRequestObservation(input, 'succeeded');
}

export function readMachineRequestReachabilityObservation(
    scope: MachineReachabilityScope | null | undefined,
    machineId: string | null | undefined,
    route?: MachineRequestObservationInput['route'],
    resolveScopeId?: ProfileScopeResolver,
): MachineRequestReachabilityObservation | null {
    const normalized = normalizeScope(scope, resolveScopeId);
    return normalized ? readObservation(readScope(normalized), machineId, route) : null;
}

export function readMachineLastAnsweredAt(scope: MachineReachabilityScope | null | undefined, machineId: string | null | undefined): number | null {
    return readMachineRequestReachabilityObservation(scope, machineId)?.lastAnsweredAtMs ?? null;
}

export function subscribeMachineRequestReachability(listener: (change: MachineRequestReachabilityChange | null) => void,
    demand: ReachabilitySubscription = {}): () => void {
    const scope = demand.scope ? normalizeScope(demand.scope) : null;
    if (demand.scope && !scope) return () => {};
    listeners.set(listener, { ...demand, ...(scope ? { scope } : {}), machineId: demand.machineId?.trim() });
    return () => listeners.delete(listener);
}

/** Authenticated daemon reconnects wake retired reads even when no failed request was cached. */
export function subscribeMachineRequestRecovery(listener: (scope: MachineReachabilityScope, machineId: string) => void): () => void {
    recoveryListeners.add(listener);
    return () => { recoveryListeners.delete(listener); };
}

export function readMachineRequestReachabilityRevision(): number {
    return revision;
}

/**
 * The one Home/Account-scoped admission predicate for UI and Action readers.
 * Pushed presence proves the daemon is alive; a failed request overrides it until a later
 * reply or authenticated socket reconnect. Advancing heartbeats never clear that failure.
 */
export function isMachineReachable(
    scope: MachineReachabilityScope | null | undefined,
    machine: Readonly<{ id: string; active: boolean; activeAt?: number | null; revokedAt?: number | null }>,
    nowMs: number = Date.now(),
    resolveScopeId?: ProfileScopeResolver,
): boolean {
    return resolveMachineReachability(scope, machine, nowMs, resolveScopeId) === 'reachable';
}

/** Shared presence verdict; unknown never supplies execution admission. */
export function resolveMachineReachability(
    scope: MachineReachabilityScope | null | undefined,
    machine: Parameters<typeof isMachineReachable>[1],
    nowMs: number = Date.now(),
    resolveScopeId?: ProfileScopeResolver,
): SessionMachineReachability {
    const normalized = normalizeScope(scope, resolveScopeId);
    if (!normalized) return 'unknown';
    const state = readScope(normalized);
    const observation = readObservation(state, machine.id);
    const requestOutcome = observation?.outcome;
    if ((typeof machine.revokedAt === 'number' && Number.isFinite(machine.revokedAt) && machine.revokedAt > 0)
        || requestOutcome === 'failed') return 'unreachable';
    const observedSinceWithdrawal = state?.observedSinceWithdrawal;
    if (observedSinceWithdrawal && !observedSinceWithdrawal.has(machine.id)) return 'unknown';
    const graceMs = readMachineOnlineGraceMsFromEnv();
    const previous = derivedReachability.get(machine);
    const activity = readMachineActivity(machine);
    const activeAt = activity.activeAt;
    if (previous && previous.serverId === normalized.serverId && previous.accountId === normalized.accountId
        && previous.machineId === machine.id && previous.active === activity.active && previous.activeAt === activeAt
        && previous.revokedAt === machine.revokedAt && previous.observation === observation
        && previous.graceMs === graceMs
        && Number.isFinite(nowMs) && nowMs >= previous.evaluatedAtMs
        // Protocol grace is inclusive. A reachable timed verdict must be re-derived
        // after that boundary; an expired verdict stays expired as time advances.
        && (!previous.reachable || graceMs <= 0 || typeof activeAt !== 'number' || !activeAt || !Number.isFinite(activeAt)
            || Math.max(0, nowMs - activeAt) <= graceMs)) {
        return previous.reachable ? 'reachable' : 'unreachable';
    }
    const reachable = isMachineReachableV1({ machine: { active: activity.active, activeAt, revokedAt: machine.revokedAt }, nowMs, graceMs, requestOutcome });
    if (Number.isFinite(nowMs)) {
        derivedReachability.set(machine, {
            serverId: normalized.serverId, accountId: normalized.accountId, machineId: machine.id,
            active: activity.active, activeAt, revokedAt: machine.revokedAt, observation,
            graceMs, evaluatedAtMs: nowMs, reachable,
        });
    }
    return reachable ? 'reachable' : 'unreachable';
}

/** The protocol-owned verdict; a failed request overrides pushed presence until a later reply or reconnect. */
export const isMachineRequestReachabilityFailure = isMachineRequestReachabilityFailureV1;

export function clearMachineRequestReachabilityForMachine(scope: MachineReachabilityScope, machineId: string): void {
    const normalized = normalizeScope(scope);
    const id = String(machineId ?? '').trim();
    if (!normalized || !id) return;
    const state = readScope(normalized);
    const answer = state?.relay.get(id)?.lastAnsweredAtMs !== undefined;
    const changed = state?.relay.delete(id) ?? false;
    const directChanged = state?.direct.delete(id) ?? false;
    retireEmptyScope(normalized, state);
    if (changed || directChanged) {
        publishReachabilityChange({ scope: normalized, machineIds: [id] }, { answer });
    }
    for (const listener of recoveryListeners) listener(scope, machineId);
}

export function clearMachineRequestReachabilityForScope(scope: MachineReachabilityScope): void {
    const normalizedScope = normalizeScope(scope);
    if (!normalizedScope) return;
    const state = readScope(normalizedScope);
    if (!state || (state.relay.size === 0 && state.direct.size === 0)) return;
    state.relay.clear();
    state.direct.clear();
    retireEmptyScope(normalizedScope, state);
    publishReachabilityChange({ scope: normalizedScope }, { answer: true });
}

export function clearMachineRequestReachabilityForTest(): void {
    derivedReachability = new WeakMap();
    let changed = false;
    for (const accounts of scopes.values()) {
        for (const state of accounts.values()) {
            changed ||= state.relay.size > 0 || state.direct.size > 0 || state.observedSinceWithdrawal !== undefined;
            // Retire captured ingress callbacks along with their scope.
            state.observedSinceWithdrawal = undefined;
        }
    }
    scopes.clear();
    if (!changed) return;
    publishReachabilityChange(null, { answer: true });
}

// Each test starts with fresh observations: a prior test's Socket teardown must
// not leave its Home unknown. Vitest's setup runs this only once this module loads.
(globalThis as unknown as { [key: symbol]: Map<string, () => void> | undefined })[Symbol.for('happier.vitest.testResets')]
    ?.set('machineRequestReachability', clearMachineRequestReachabilityForTest);
