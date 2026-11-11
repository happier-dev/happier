import { isMachineRequestReachabilityFailureV1, type MachinePresenceV1 } from '@happier-dev/protocol/machines/machineReachabilityV1';
import { isMachineOnline, type MachinePresenceCounts } from '@/utils/sessions/machineUtils';
import { isMachineVisibleForLaunchSelection } from '@/sync/domains/machines/identity/filterVisibleMachines';
import { readMachinePresenceAnswer } from '@/sync/domains/machines/machineActivity';
import { createServerAccountScope, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent, resolveServerProfileScopeIdForIdentifier, type ProfileScopeResolver } from '@/sync/domains/server/serverProfiles';
import type { SessionMachineReachability } from './resolveSessionMachineReachability';

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
};

// Index the identity parts directly: reads do not rebuild encoded resource keys.
const scopes = new Map<string, Map<string, ScopeReachability>>();
export type MachineRequestReachabilityChange = Readonly<{
    scope: MachineReachabilityScope;
    /** Absence means the whole Account's request observations were retired. */
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
    if (!state || state.relay.size > 0 || state.direct.size > 0) return;
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

/** Transport lifecycle adapter: losing the Account socket supplies no new Machine presence fact. */
export function withdrawMachinePresenceForScope(_scope: MachineReachabilityScope): void {
    // Keep the last admitted activity and request verdict; only their producers can replace them.
}

/** Ingress adapter for existing readers; applying their rows/activity already publishes the presence fact. */
export function captureMachinePresenceObservation(_scope: MachineReachabilityScope | null): (machineIds: readonly string[]) => void {
    return () => {
        // No second observation set or publication alongside the activity owner.
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
    machine: MachinePresenceV1 & Readonly<{ id: string }>,
    nowMs: number = Date.now(),
    resolveScopeId?: ProfileScopeResolver,
): boolean {
    return resolveMachineReachability(scope, machine, nowMs, resolveScopeId) === 'reachable';
}

/**
 * Shared presence verdict; a missing Account scope cannot supply execution admission.
 * A socket lifecycle change retains the last Machine activity, request and revocation facts.
 */
export function resolveMachineReachability(
    scope: MachineReachabilityScope | null | undefined,
    machine: Parameters<typeof isMachineReachable>[1],
    nowMs: number = Date.now(),
    resolveScopeId?: ProfileScopeResolver,
): SessionMachineReachability {
    const normalized = normalizeScope(scope, resolveScopeId);
    const state = normalized ? readScope(normalized) : undefined;
    const requestOutcome = readObservation(state, machine.id)?.outcome;
    if ((typeof machine.revokedAt === 'number' && Number.isFinite(machine.revokedAt) && machine.revokedAt > 0)
        || requestOutcome === 'failed') return 'unreachable';
    if (readMachinePresenceAnswer(machine) === false) return 'unknown';
    const reachable = isMachineOnline(machine, nowMs);
    if (!reachable) return 'unreachable';
    if (!normalized) return 'unknown';
    return 'reachable';
}

/** Connectivity summaries count the current persistent fleet; retained history is still displayable. */
export type MachineFleetPresence = Readonly<{
    member: boolean;
    online: boolean | null;
    reachability: SessionMachineReachability;
}>;

export function resolveMachineFleetPresence(
    scope: MachineReachabilityScope | null | undefined,
    machine: Parameters<typeof resolveMachineReachability>[1] & Parameters<typeof isMachineVisibleForLaunchSelection>[0],
    nowMs?: number,
    resolveScopeId?: ProfileScopeResolver,
): MachineFleetPresence {
    const reachability = resolveMachineReachability(scope, machine, nowMs, resolveScopeId);
    return { member: isMachineVisibleForLaunchSelection(machine), reachability,
        online: reachability === 'unknown' ? null : reachability === 'reachable' };
}

/** All fleet counts and offline folds consume the same membership and connection projection. */
export function partitionMachineFleetPresence<Row>(rows: readonly Row[], readPresence: (row: Row) => Pick<MachineFleetPresence, 'member' | 'online'> | null | undefined): Readonly<{
    online: readonly Row[];
    offline: readonly Row[];
    unknown: readonly Row[];
    other: readonly Row[];
    counts: MachinePresenceCounts;
}> {
    const online: Row[] = [];
    const offline: Row[] = [];
    const unknown: Row[] = [];
    const other: Row[] = [];
    for (const row of rows) {
        const presence = readPresence(row);
        if (!presence?.member) other.push(row);
        else if (presence.online === null) unknown.push(row);
        else (presence.online ? online : offline).push(row);
    }
    return { online, offline, unknown, other, counts: { online: online.length, offline: offline.length, unknown: unknown.length } };
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
    let changed = false;
    for (const accounts of scopes.values()) {
        for (const state of accounts.values()) {
            changed ||= state.relay.size > 0 || state.direct.size > 0;
        }
    }
    scopes.clear();
    if (!changed) return;
    publishReachabilityChange(null, { answer: true });
}

// Each test starts with fresh request observations. Vitest's setup registers
// this reset only once this module loads.
(globalThis as unknown as { [key: symbol]: Map<string, () => void> | undefined })[Symbol.for('happier.vitest.testResets')]
    ?.set('machineRequestReachability', clearMachineRequestReachabilityForTest);
