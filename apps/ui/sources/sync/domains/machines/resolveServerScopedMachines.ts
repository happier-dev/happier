import type { MachineAdministrationTargetV1 } from '@happier-dev/protocol';

import {
    areServerProfileIdentifiersEquivalent,
    captureServerProfileScopeResolver,
    resolveServerProfileForPortableIdentity,
    type ProfileScopeResolver,
    type ServerProfile,
} from '@/sync/domains/server/serverProfiles';

type MachineLike = Readonly<{
    revokedAt?: number | null;
}>;

type MachineWithId = MachineLike & Readonly<{
    id: string;
    availability?: Readonly<{ kind: string }>;
    metadata?: unknown;
    metadataVersion?: number;
    daemonStateVersion?: number;
    keyBasis?: Readonly<{ metadataVersion: number; daemonStateVersion: number }> | null;
}>;

type MachineInventoryRowReadiness = 'available' | 'pending' | 'unavailable';
const rowReadiness = new WeakMap<MachineWithId, Readonly<{
    metadata: unknown;
    availabilityKind: string | undefined;
    metadataVersion: number | undefined;
    daemonStateVersion: number | undefined;
    keyBasis: MachineWithId['keyBasis'];
    keyMetadataVersion: number | undefined;
    keyDaemonStateVersion: number | undefined;
    readiness: MachineInventoryRowReadiness;
}>>();

/** A newer published hint must be opened before its content can authorize execution. */
export function hasCurrentMachineContent(machine: MachineWithId): boolean {
    return machine.metadata != null && (!machine.keyBasis
        || ((machine.metadataVersion ?? 0) >= machine.keyBasis.metadataVersion
            && (machine.daemonStateVersion ?? 0) >= machine.keyBasis.daemonStateVersion));
}

/** Content admission is independent of list settlement and presence. */
export function readMachineInventoryRowReadiness(machine: MachineWithId): MachineInventoryRowReadiness {
    const { metadata, metadataVersion, daemonStateVersion, keyBasis } = machine;
    const availabilityKind = machine.availability?.kind;
    const keyMetadataVersion = keyBasis?.metadataVersion;
    const keyDaemonStateVersion = keyBasis?.daemonStateVersion;
    const previous = rowReadiness.get(machine);
    if (previous && previous.metadata === metadata && previous.availabilityKind === availabilityKind
        && previous.metadataVersion === metadataVersion && previous.daemonStateVersion === daemonStateVersion
        && previous.keyBasis === keyBasis && previous.keyMetadataVersion === keyMetadataVersion
        && previous.keyDaemonStateVersion === keyDaemonStateVersion) return previous.readiness;
    const readiness = availabilityKind === 'locked' || (availabilityKind === 'available' && metadata == null)
        ? 'unavailable' : availabilityKind === 'available' && hasCurrentMachineContent(machine) ? 'available' : 'pending';
    rowReadiness.set(machine, { metadata, availabilityKind, metadataVersion, daemonStateVersion,
        keyBasis, keyMetadataVersion, keyDaemonStateVersion, readiness });
    return readiness;
}

const liveRowsByInventory = new WeakMap<readonly MachineWithId[], {
    current?: ReadonlySet<MachineWithId>;
    opened?: ReadonlySet<MachineWithId>;
}>();
const EMPTY_LIVE_MACHINE_ROWS: ReadonlySet<never> = new Set();

function isLiveMachineInventoryRow(machine: MachineWithId, retainOpenedContent: boolean): boolean {
    return readMachineInventoryRowReadiness(machine) === 'available'
        || (retainOpenedContent && machine.availability?.kind === 'available' && machine.metadata != null);
}

/**
 * Resolves the Account-portable target at the existing profile and machine
 * inventory owners. The returned `serverId` is device-local routing data only;
 * callers must never persist it back into the portable target.
 */
export type PortableMachineAdministrationTargetResolution<T extends MachineWithId> =
    | Readonly<{
        kind: 'resolved';
        target: MachineAdministrationTargetV1;
        serverId: string;
        profile: ServerProfile;
        machine: T;
    }>
    | Readonly<{
        kind: 'missingServer';
        target: MachineAdministrationTargetV1;
    }>
    | Readonly<{
        kind: 'ambiguousServer';
        target: MachineAdministrationTargetV1;
        profiles: readonly ServerProfile[];
    }>
    | Readonly<{
        kind: 'missingMachine';
        target: MachineAdministrationTargetV1;
        serverId: string;
        profile: ServerProfile;
    }>;

/** Raw scoped membership shared by presentation and fresh invocation admission. */
export function readLiveMachineInventoryRows<T extends MachineWithId>(params: Readonly<{
    activeServerId: string;
    activeMachines: readonly T[];
    machineListByServerId: Readonly<Record<string, readonly T[] | null | undefined>>;
    machineListStatusByServerId: Readonly<Record<string, 'idle' | 'loading' | 'signedOut' | 'error' | undefined>>;
    profile: ServerProfile;
    serverIdentityId: string;
    /** Presentation may retain opened content while a newer hint is pending; never grants fresh invocation authority. */
    retainOpenedContent?: boolean;
}>, resolveScopeId: ProfileScopeResolver = captureServerProfileScopeResolver()): ReadonlySet<T> {
    const inventory = resolveServerScopedMachineInventory({
        ...params,
        // Presentation's active fallback is not evidence of scoped membership.
        activeServerId: '',
        serverId: params.serverIdentityId,
        serverIdAliases: [params.profile.id, ...(params.profile.legacyServerIds ?? [])],
    }, resolveScopeId);
    // A failed list read (`error`) never proves a retained row gone; only an unobserved or signed-out Home admits nothing.
    if (inventory.status !== 'idle' && inventory.status !== 'loading' && inventory.status !== 'error') return EMPTY_LIVE_MACHINE_ROWS;
    // A row's admitted content need not wait for unrelated fleet hydration.
    // Use scoped membership here: the active display fallback may still contain
    // an older row or a socket-only presence shell absent from the current list.
    // A refresh may retain the previous idle list status while newer content is
    // pending, so the row's readiness is required for both list states.
    const machines = inventory.machines;
    if (!machines) return EMPTY_LIVE_MACHINE_ROWS;
    const retainOpenedContent = params.retainOpenedContent === true;
    const mode = retainOpenedContent ? 'opened' : 'current';
    const cached = liveRowsByInventory.get(machines);
    const previous = cached?.[mode];
    if (previous) {
        let admittedCount = 0;
        let unchanged = true;
        for (const machine of machines) {
            const admitted = isLiveMachineInventoryRow(machine, retainOpenedContent);
            if (admitted) admittedCount += 1;
            if (previous.has(machine) !== admitted) { unchanged = false; break; }
        }
        // The cache is keyed by this exact array of T; only its original rows
        // are ever inserted. Scope/status were resolved fresh before this read.
        if (unchanged && admittedCount === previous.size) return previous as ReadonlySet<T>;
    }
    const rows = new Set<T>();
    for (const machine of machines) {
        if (isLiveMachineInventoryRow(machine, retainOpenedContent)) rows.add(machine);
    }
    const next = cached ?? { current: undefined, opened: undefined };
    next[mode] = rows;
    liveRowsByInventory.set(machines, next);
    return rows;
}

/** The same ordered Home keys drive inventory reads and their subscription signatures. */
export function resolveServerScopedMachineInventoryKeys(params: Readonly<{
    serverId: string;
    serverIdAliases?: readonly string[];
    machineListByServerId: Readonly<Record<string, unknown>>;
}>, resolveScopeId: ProfileScopeResolver = captureServerProfileScopeResolver()): readonly string[] {
    const requestedServerIds = [params.serverId, ...(params.serverIdAliases ?? [])]
        .map((serverId) => String(serverId ?? '').trim())
        .filter((serverId, index, ids) => serverId.length > 0 && ids.indexOf(serverId) === index);
    // Scoped inventories can be keyed by either the portable Home identity or
    // this device's profile id. Resolve that correspondence once for every reader.
    const canonicalServerId = resolveScopeId(params.serverId);
    return [...new Set([
        canonicalServerId,
        ...[...requestedServerIds, ...Object.keys(params.machineListByServerId)].sort().filter((key) => requestedServerIds.some((serverId) => (
            key === serverId || areServerProfileIdentifiersEquivalent(key, serverId, resolveScopeId)
        ))),
    ])].filter(Boolean);
}

type MachineInventoryStatus = 'idle' | 'loading' | 'signedOut' | 'error' | undefined;
type MachineInventoryInput<T extends MachineLike> = Readonly<{
    serverId: string;
    activeServerId: string;
    serverIdAliases?: readonly string[];
    activeMachines: ReadonlyArray<T>;
    machineListByServerId: Readonly<Record<string, ReadonlyArray<T> | null | undefined>>;
    machineListStatusByServerId?: Readonly<Record<string, MachineInventoryStatus>>;
}>;

/** Ordered and exact readers consume one source decision, including the loading fallback. */
function resolveMachineInventorySource(
    params: Omit<MachineInventoryInput<MachineLike>, 'activeMachines'>,
    hasActiveMachines: () => boolean,
    resolveScopeId: ProfileScopeResolver,
): Readonly<{ kind: 'active'; status: MachineInventoryStatus }>
    | Readonly<{ kind: 'scoped'; serverId: string | undefined; status: MachineInventoryStatus }> {
    const activeServerId = String(params.activeServerId ?? '').trim();
    const serverIds = resolveServerScopedMachineInventoryKeys(params, resolveScopeId);
    const statusServerId = serverIds.find((serverId) => params.machineListStatusByServerId?.[serverId] !== undefined);
    const status = statusServerId ? params.machineListStatusByServerId?.[statusServerId] : undefined;
    // A refresh does not surrender the canonical Home's retained answer to an
    // older profile-alias snapshot. Rows and readiness resolve the same ordered keys.
    const scopedServerId = serverIds.find((serverId) => Array.isArray(params.machineListByServerId[serverId]));
    if (scopedServerId && params.machineListStatusByServerId?.[scopedServerId] === 'idle') {
        return { kind: 'scoped', serverId: scopedServerId, status };
    }
    const targetsActiveServer = activeServerId.length > 0
        && serverIds.some((serverId) => areServerProfileIdentifiersEquivalent(serverId, activeServerId, resolveScopeId));
    if (targetsActiveServer && (hasActiveMachines() || status === 'idle')) {
        return { kind: 'active', status };
    }

    return { kind: 'scoped', serverId: scopedServerId, status };
}

export function resolveServerScopedMachineInventory<T extends MachineLike>(params: MachineInventoryInput<T>,
    resolveScopeId: ProfileScopeResolver = captureServerProfileScopeResolver()): Readonly<{
    machines: ReadonlyArray<T> | null;
    status: MachineInventoryStatus;
}> {
    const source = resolveMachineInventorySource(params, () => params.activeMachines.length > 0, resolveScopeId);
    return { machines: source.kind === 'active' ? params.activeMachines
        : source.serverId ? params.machineListByServerId[source.serverId] ?? null : null, status: source.status };
}

export function resolveServerScopedMachines<T extends MachineLike>(params: Parameters<typeof resolveServerScopedMachineInventory<T>>[0], resolveScopeId?: ProfileScopeResolver): ReadonlyArray<T> | null {
    return resolveServerScopedMachineInventory(params, resolveScopeId).machines;
}

/** Select requested rows after scope resolution, keeping the first matching inventory row. */
export function selectMachineInventoryRowsById<T extends Readonly<{ id: string }>>(
    machines: readonly T[] | null | undefined,
    machineIds: readonly string[],
): readonly (T | null)[] {
    if (machineIds.length <= 1) return machineIds.map(id => id ? machines?.find(machine => machine.id === id) ?? null : null);
    const byId = new Map<string, T>();
    for (const machine of machines ?? []) {
        if (!byId.has(machine.id)) byId.set(machine.id, machine);
    }
    return machineIds.map(id => id ? byId.get(id) ?? null : null);
}

/**
 * Looks up one requested machine after server scope resolution. It deliberately
 * does not choose another machine when the requested id is absent.
 */
export function resolveExactServerScopedMachine<T extends MachineWithId>(params: MachineInventoryInput<T> & Readonly<{
    machineId: string;
    /** The inventory writer publishes these alongside its ordered rows. Partial-state callers may omit them. */
    machineRecordsByServerId?: Readonly<Record<string, Readonly<Record<string, T | undefined>> | undefined>>;
    activeMachineRecords?: Readonly<Record<string, T | undefined>>;
}>): T | null {
    const machineId = String(params.machineId ?? '').trim();
    if (!machineId) return null;

    const source = resolveMachineInventorySource(params, () => {
        if (!params.activeMachineRecords) return params.activeMachines.length > 0;
        if (params.activeMachineRecords[machineId]) return true;
        for (const id in params.activeMachineRecords) if (params.activeMachineRecords[id]) return true;
        return false;
    }, captureServerProfileScopeResolver());
    const records = source.kind === 'active' ? params.activeMachineRecords
        : source.serverId ? params.machineRecordsByServerId?.[source.serverId] : undefined;
    if (records) return records[machineId] ?? null;
    const machines = source.kind === 'active' ? params.activeMachines
        : source.serverId ? params.machineListByServerId[source.serverId] : null;
    return machines?.find((machine) => machine.id === machineId) ?? null;
}

/**
 * Converts an Administration-owned portable `{ serverIdentityId, machineId }`
 * into the incumbent machine-RPC routing pair. It never borrows another Home or
 * chooses a different machine: unavailable profile correspondence and a missing
 * exact machine remain distinct terminal results for the Administration owner.
 * `resolved` proves correspondence only; revoked/replaced/offline/locked facts
 * still require Administration availability admission before any RPC.
 */
export function resolvePortableMachineAdministrationTarget<T extends MachineWithId>(params: Readonly<{
    target: MachineAdministrationTargetV1;
    activeServerId: string;
    activeMachines: ReadonlyArray<T>;
    machineListByServerId: Readonly<Record<string, ReadonlyArray<T> | null | undefined>>;
    machineListStatusByServerId?: Readonly<Record<string, 'idle' | 'loading' | 'signedOut' | 'error' | undefined>>;
}>): PortableMachineAdministrationTargetResolution<T> {
    const profileResolution = resolveServerProfileForPortableIdentity(params.target.serverIdentityId);
    if (profileResolution.kind === 'missing') {
        return Object.freeze({ kind: 'missingServer', target: params.target });
    }
    if (profileResolution.kind === 'ambiguous') {
        return Object.freeze({
            kind: 'ambiguousServer',
            target: params.target,
            profiles: profileResolution.profiles,
        });
    }

    const { profile } = profileResolution;
    const serverIdAliases = [
        params.target.serverIdentityId,
        profile.serverIdentityId,
        ...(profile.legacyServerIds ?? []),
    ].filter((serverId, index, ids): serverId is string => (
        typeof serverId === 'string'
        && serverId.trim().length > 0
        && serverId !== profile.id
        && ids.indexOf(serverId) === index
    ));
    const machine = resolveExactServerScopedMachine<T>({
        machineId: params.target.machineId,
        serverId: profile.id,
        serverIdAliases,
        activeServerId: params.activeServerId,
        activeMachines: params.activeMachines,
        machineListByServerId: params.machineListByServerId,
        machineListStatusByServerId: params.machineListStatusByServerId,
    });
    if (!machine) {
        return Object.freeze({
            kind: 'missingMachine',
            target: params.target,
            serverId: profile.id,
            profile,
        });
    }

    return Object.freeze({
        kind: 'resolved',
        target: params.target,
        serverId: profile.id,
        profile,
        machine,
    });
}

export function filterVisibleMachines<T extends MachineLike>(machines: ReadonlyArray<T>): T[] {
    return machines.filter((machine) => {
        const revokedAt = machine.revokedAt;
        return !(typeof revokedAt === 'number' && Number.isFinite(revokedAt) && revokedAt > 0);
    });
}
