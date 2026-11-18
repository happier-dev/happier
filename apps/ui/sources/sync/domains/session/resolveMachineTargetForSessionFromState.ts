import type { SessionListLookupStateLike } from '@/sync/domains/session/listing/sessionListLookupState';
import { resolveSessionListPreferredSessionMetadataFromState } from '@/sync/domains/session/listing/sessionListLookupState';
import { readSessionListRowForServerId, type SessionListRowStateByServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { machineCollectionValues, findMachineInCollection, type MachineCollection } from '@/sync/domains/machines/identity/machineCollection';
import { resolveSessionMachineId } from '@/sync/domains/session/external/resolveSessionMachineId';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { resolveSessionWorkspaceRootForMachine } from '@happier-dev/protocol/sessions/metadata/sessionWorkspaceLocationV1';
import {
    resolveSessionBasePathForMachine,
    resolveSessionDisplayTarget,
    resolveSessionRpcTarget,
} from '@/sync/domains/machines/identity/resolveSessionMachineTargets';
import { normalizeKnownProjectMachineId } from '@/sync/runtime/orchestration/projectManager';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { readSessionListRenderableOwnerMetadataView } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';
import type { Metadata } from '@happier-dev/session-core/state';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveServerScopedMachineInventory, resolveServerScopedMachines } from '@/sync/domains/machines/resolveServerScopedMachines';
import { isMachineOnline } from '@/sync/domains/machines/reachability/machinePresence';

type MachineTargetLikeState = SessionListLookupStateLike & Readonly<{
    sessions?: Record<string, {
        id?: string;
        serverId?: string;
        active?: boolean;
        updatedAt?: number;
        metadata?: SessionTargetMetadataLike;
        metadataLayoutVersion?: number;
        ownerMetadataView?: Metadata | null;
    }>;
    sessionListRowsByServerId?: SessionListRowStateByServerId;
    machines?: Record<string, Machine>;
    machineListByServerId?: Readonly<Record<string, readonly Machine[] | null | undefined>>;
    machineListStatusByServerId?: Readonly<Record<string, 'idle' | 'loading' | 'signedOut' | 'error' | undefined>>;
    getProjectForSession?: (sessionId: string, serverId?: string | null) => { key?: { machineId?: string; rootPath?: string } } | null;
}>;

export type SessionMachineTargetState = MachineTargetLikeState;

export type ExactSessionMachineTargetIdentity = Readonly<{
    serverId: string;
    accountId: string;
    sessionId: string;
}>;

export type SessionMachineTargetIdentity = string | SessionAddress | ExactSessionMachineTargetIdentity;

export type SessionMachineControlTarget = Readonly<{
    machineId: string;
    basePath: string;
    agentBasePath?: string;
    confidence: 'reachable' | 'metadata_direct';
}>;

export type SessionMachineTarget = Readonly<{
    machineId: string;
    basePath: string;
    agentBasePath?: string;
}>;

export type SessionTargetMetadataLike = Readonly<{
    machineId?: string | null;
    path?: string | null;
    host?: string | null;
    homeDir?: string | null;
    sessionWorkspaceLocationV1?: unknown;
    externalSessionV1?: Readonly<{
        v?: number;
        agentId?: string | null;
        machineId?: string | null;
        remoteSessionId?: string | null;
    }> | null;
}> | null | undefined;

function normalizeNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function toSessionTargetMetadataLike(value: unknown): SessionTargetMetadataLike {
    return value && typeof value === 'object' ? value as SessionTargetMetadataLike : null;
}

/**
 * The store's own id-keyed record, handed over as-is. Identity resolution needs a lookup, not a
 * list, and this runs once per session on the store write path — flattening it here rebuilt the
 * machine index per session.
 */
function readMachines(state: SessionMachineTargetState): Readonly<Record<string, Machine>> {
    return state.machines ?? {};
}

function readSessionMachines(state: SessionMachineTargetState, serverId?: string | null): MachineCollection<Machine> {
    if (!serverId) return readMachines(state);
    return resolveServerScopedMachines({
        serverId,
        activeServerId: getActiveServerSnapshot().serverId,
        get activeMachines() { return Object.values(state.machines ?? {}); },
        machineListByServerId: state.machineListByServerId ?? {},
        machineListStatusByServerId: state.machineListStatusByServerId,
    }) ?? [];
}

/**
 * Structural Machine facts Session display attribution reads. Live RPC availability
 * belongs to the activity slice and does not change display attribution.
 */
function areMachineTargetFactsEqual(previous: Machine | undefined, next: Machine | undefined): boolean {
    if (previous === next) return true;
    if (!previous || !next) return false;
    return previous.id === next.id
        && Boolean(previous.revokedAt && previous.revokedAt > 0) === Boolean(next.revokedAt && next.revokedAt > 0)
        && normalizeNonEmptyString(previous.replacedByMachineId) === normalizeNonEmptyString(next.replacedByMachineId)
        && normalizeNonEmptyString(previous.metadata?.host) === normalizeNonEmptyString(next.metadata?.host)
        && normalizeNonEmptyString(previous.metadata?.homeDir) === normalizeNonEmptyString(next.metadata?.homeDir);
}

/**
 * Whether two Machine inventories give every Session the same display target.
 * Display readers compare these structural facts rather than inventory identity;
 * live RPC/control readers observe activity separately.
 */
export function areSessionMachineTargetInputsEqual(
    previous: MachineCollection<Machine> | null | undefined,
    next: MachineCollection<Machine> | null | undefined,
): boolean {
    if (previous === next) return true;
    if (!previous || !next || Array.isArray(previous) !== Array.isArray(next)) return false;
    const left = machineCollectionValues(previous);
    const right = machineCollectionValues(next);
    return left.length === right.length && left.every((machine, index) => areMachineTargetFactsEqual(machine, right[index]));
}

function resolveUniqueActiveMachineByHost(
    machines: MachineCollection<Machine>,
    host: string | null,
): Machine | null {
    if (!host) return null;
    const matches = machineCollectionValues(machines).filter((machine) => {
        const machineHost = normalizeNonEmptyString(machine.metadata?.host);
        return isMachineOnline(machine) === true
            && !machine.replacedByMachineId
            && machineHost === host;
    });
    return matches.length === 1 ? matches[0] ?? null : null;
}

function readSessionTargetInputForMetadata(
    state: SessionMachineTargetState,
    sessionId: string,
    metadata: SessionTargetMetadataLike,
    options?: Readonly<{
        serverId?: string | null;
        sessionActive?: boolean;
        allowProjectLookup?: boolean;
        machines?: MachineCollection<Machine>;
    }>,
) {
    const directSession = state.sessions?.[sessionId];
    const session = options?.serverId
        ? readSessionListRowForServerId(state.sessionListRowsByServerId, options.serverId, sessionId)
            ?? (areServerProfileIdentifiersEquivalent(directSession?.serverId, options.serverId) ? directSession : null)
        : directSession;
    const getProjectForSession = options?.allowProjectLookup === false
        ? null
        : typeof state.getProjectForSession === 'function' ? state.getProjectForSession : null;
    const project = getProjectForSession
        ? (options?.serverId ? getProjectForSession(sessionId, options.serverId) : getProjectForSession(sessionId))
        : null;

    return {
        metadata,
        sessionActive: options?.sessionActive ?? session?.active === true,
        sessionMachineId: resolveSessionMachineId(metadata),
        sessionPath: normalizeNonEmptyString(metadata?.path),
        sessionWorkspaceMetadata: metadata,
        projectMachineId: normalizeKnownProjectMachineId(project?.key?.machineId),
        projectPath: normalizeNonEmptyString(project?.key?.rootPath),
        machines: options?.machines ?? readSessionMachines(state, options?.serverId),
    };
}

function resolveLegacyHostMachineTarget(
    input: ReturnType<typeof readSessionTargetInputForMetadata>,
): { machineId: string; basePath: string } | null {
    if (input.sessionMachineId) return null;
    if (normalizeNonEmptyString(input.projectMachineId)) return null;

    const machine = resolveUniqueActiveMachineByHost(input.machines, normalizeNonEmptyString(input.metadata?.host));
    if (!machine) return null;
    const basePath = resolveSessionBasePathForMachine({
        ...input,
        // Host-only legacy attribution cannot transfer a host-scoped project root.
        projectPath: null,
        originMachineId: input.sessionMachineId,
        targetMachineId: machine.id,
    });
    return basePath ? { machineId: machine.id, basePath } : null;
}

function resolveWorkspaceLocationForMachineTarget(
    metadata: SessionTargetMetadataLike,
    target: Readonly<{ machineId: string; basePath: string }> | null,
): SessionMachineTarget | null {
    if (!target) return null;
    const resolved = resolveSessionWorkspaceRootForMachine({
        metadata,
        machineId: target.machineId,
        candidatePath: target.basePath,
    });
    if (!resolved.agentPath || resolved.machinePath === resolved.agentPath) {
        return {
            machineId: target.machineId,
            basePath: target.basePath,
        };
    }
    return {
        machineId: target.machineId,
        basePath: resolved.machinePath,
        agentBasePath: resolved.agentPath,
    };
}

function readPrivateSessionTargetInputs(state: SessionMachineTargetState, sessionId: string) {
    const directSession = state.sessions?.[sessionId];
    const directMetadataValue = directSession
        ? readSessionOwnerMetadataView({
            metadataLayoutVersion: directSession.metadataLayoutVersion,
            metadata: directSession.metadata as Metadata | null,
            ownerMetadataView: directSession.ownerMetadataView,
        })
        : null;
    const directMetadata = toSessionTargetMetadataLike(directMetadataValue);
    const isLayout1 = directSession?.metadataLayoutVersion === 1;
    const preferredMetadata = isLayout1
        ? null
        : toSessionTargetMetadataLike(resolveSessionListPreferredSessionMetadataFromState(state, sessionId));

    return [
        directMetadata ? readSessionTargetInputForMetadata(state, sessionId, directMetadata) : null,
        preferredMetadata ? readSessionTargetInputForMetadata(state, sessionId, preferredMetadata) : null,
    ].filter((input): input is NonNullable<typeof input> => input !== null);
}

function normalizeExactSessionTargetIdentity(
    target: SessionMachineTargetIdentity,
): SessionAddress | null {
    if (typeof target === 'string') return null;
    const serverId = normalizeNonEmptyString(target.serverId);
    if ('accountId' in target && !normalizeNonEmptyString(target.accountId)) return null;
    const sessionId = normalizeSessionId(target.sessionId);
    return serverId && sessionId ? { serverId, sessionId } : null;
}

function readExactSessionTargetInputs(
    state: SessionMachineTargetState,
    target: SessionAddress,
) {
    const machines = readSessionMachines(state, target.serverId);
    const directSession = state.sessions?.[target.sessionId];
    if (directSession && areServerProfileIdentifiersEquivalent(directSession.serverId, target.serverId)) {
        const metadata = toSessionTargetMetadataLike(readSessionOwnerMetadataView(directSession));
        return metadata
            ? [readSessionTargetInputForMetadata(state, target.sessionId, metadata, {
                serverId: target.serverId,
                sessionActive: directSession.active === true,
                allowProjectLookup: false,
                machines,
            })]
            : [];
    }
    const scopedRow = readSessionListRowForServerId(
        state.sessionListRowsByServerId,
        target.serverId,
        target.sessionId,
    );
    if (scopedRow) {
        const metadata = toSessionTargetMetadataLike(readSessionListRenderableOwnerMetadataView(scopedRow));
        return metadata
            ? [readSessionTargetInputForMetadata(state, target.sessionId, metadata, {
                serverId: target.serverId,
                sessionActive: scopedRow.active === true,
                // Control targets use scoped Session facts, not display attribution.
                allowProjectLookup: false,
                machines,
            })]
            : [];
    }
    return [];
}

function readSessionTargetInputs(
    state: SessionMachineTargetState,
    target: SessionMachineTargetIdentity,
) {
    const exact = normalizeExactSessionTargetIdentity(target);
    if (typeof target !== 'string') {
        return exact ? readExactSessionTargetInputs(state, exact) : [];
    }
    return readPrivateSessionTargetInputs(state, normalizeSessionId(target));
}

function readSessionDisplayTargetInput(state: SessionMachineTargetState, sessionId: string, serverId?: string | null) {
    const normalizedServerId = normalizeNonEmptyString(serverId);
    const target = normalizedServerId ? { serverId: normalizedServerId, sessionId } : sessionId;
    const preferredMetadata = toSessionTargetMetadataLike(resolveSessionListPreferredSessionMetadataFromState(state, target));
    return readSessionTargetInputForMetadata(state, sessionId, preferredMetadata, { serverId: normalizedServerId });
}

function readPrivateSessionTargetInput(state: SessionMachineTargetState, sessionId: string) {
    return readPrivateSessionTargetInputs(state, sessionId)[0] ?? null;
}

/** The retained rows whose liveness can change this Session's RPC/control target. */
export function readSessionMachineTargetActivityInputs(
    state: SessionMachineTargetState,
    target: SessionMachineTargetIdentity,
): readonly Machine[] {
    const machines = new Set<Machine>();
    for (const input of readSessionTargetInputs(state, target)) {
        const direct = resolveSessionDisplayTarget(input);
        const directMachine = direct && findMachineInCollection(input.machines, direct.machineId);
        if (directMachine) machines.add(directMachine);
        const host = normalizeNonEmptyString(input.metadata?.host);
        const usesLegacyHost = !input.sessionMachineId && !input.projectMachineId;
        if (!host || !usesLegacyHost) continue;
        for (const machine of machineCollectionValues(input.machines)) {
            if (machine.revokedAt || machine.replacedByMachineId) continue;
            if (normalizeNonEmptyString(machine.metadata?.host) === host) machines.add(machine);
        }
    }
    return [...machines];
}

export function resolveMachineTargetForSessionFromState(
    state: SessionMachineTargetState,
    target: SessionMachineTargetIdentity,
): SessionMachineTarget | null {
    const inputs = readSessionTargetInputs(state, target);
    for (const input of inputs) {
        const target = resolveSessionRpcTarget(input);
        if (!target) continue;
        return resolveWorkspaceLocationForMachineTarget(input.metadata, {
            machineId: target.machineId,
            basePath: target.basePath,
        });
    }
    for (const input of inputs) {
        const target = resolveLegacyHostMachineTarget(input);
        if (target) return resolveWorkspaceLocationForMachineTarget(input.metadata, target);
    }
    // Host/home strings can be shared by distinct VMs. Explicit Machine identity
    // follows only the canonical replacement chain, including while it is offline.
    return null;
}

function hasKnownRetiredMachineState(machine: Machine | undefined): boolean {
    return Boolean(machine?.revokedAt || machine?.replacedByMachineId);
}

function hasConflictingDirectSessionMachine(input: ReturnType<typeof readPrivateSessionTargetInput>): boolean {
    if (!input) return false;
    const sessionMachineId = normalizeNonEmptyString(input.sessionMachineId);
    const projectMachineId = normalizeNonEmptyString(input.projectMachineId);
    if (!sessionMachineId) return false;
    if (!projectMachineId) return false;
    return sessionMachineId !== projectMachineId;
}

export function resolveMachineControlTargetForSessionFromState(
    state: SessionMachineTargetState,
    target: SessionMachineTargetIdentity,
): SessionMachineControlTarget | null {
    const resolvedSessionId = typeof target === 'string'
        ? normalizeSessionId(target)
        : normalizeSessionId(target.sessionId);
    const reachableTarget = resolveMachineTargetForSessionFromState(state, target);
    if (reachableTarget) {
        return {
            ...reachableTarget,
            confidence: 'reachable',
        };
    }

    const input = readSessionTargetInputs(state, target)[0]
        ?? (typeof target === 'string' ? readPrivateSessionTargetInput(state, resolvedSessionId) : null);
    if (!input) return null;
    const displayTarget = resolveSessionDisplayTarget(input);
    const machineId = displayTarget?.machineId;
    if (!machineId) return null;
    if (hasConflictingDirectSessionMachine(input)) return null;

    const knownMachine = findMachineInCollection(input.machines, machineId) ?? undefined;
    // Control routing needs identity even while the Machine sleeps; Home owns
    // wake admission. RPC routing above still requires answered reachability.
    if (hasKnownRetiredMachineState(knownMachine)) return null;
    const basePath = resolveSessionBasePathForMachine({
        ...input, originMachineId: input.sessionMachineId, targetMachineId: machineId,
    });
    if (!basePath) return null;

    const workspaceTarget = resolveWorkspaceLocationForMachineTarget(input.metadata, { machineId, basePath });
    if (!workspaceTarget) return null;
    return {
        ...workspaceTarget,
        confidence: 'metadata_direct',
    };
}

/** A null control target can mean either hydration or a settled refusal to choose a Machine. */
export function resolveMachineControlTargetStateForSessionFromState(
    state: SessionMachineTargetState,
    identity: SessionMachineTargetIdentity,
): Readonly<{ status: 'ready' } & SessionMachineControlTarget>
    | Readonly<{ status: 'loading' | 'unavailable' }> {
    const target = resolveMachineControlTargetForSessionFromState(state, identity);
    if (target) return { status: 'ready', ...target };
    const input = readSessionTargetInputs(state, identity)[0];
    if (!input) return { status: 'loading' };
    const serverId = typeof identity === 'string' ? null : identity.serverId;
    if (serverId) {
        const inventory = resolveServerScopedMachineInventory({
            serverId, activeServerId: getActiveServerSnapshot().serverId,
            activeMachines: Object.values(state.machines ?? {}),
            machineListByServerId: state.machineListByServerId ?? {},
            machineListStatusByServerId: state.machineListStatusByServerId,
        });
        if (inventory.status === 'loading' || (inventory.machines === null && inventory.status === undefined)) {
            return { status: 'loading' };
        }
    }
    return { status: 'unavailable' };
}

/**
 * What a session row shows: the machine it is attributed to and the path under it, each falling
 * back to the session's own metadata when no display target resolves.
 *
 * Both values come out of one target resolution. Asking for them separately resolved the same
 * target — and re-read the project for the same session — twice per row, which is pure waste for
 * any caller that needs both.
 */
export type SessionDisplayIdentity = Readonly<{
    machineId: string;
    basePath: string;
}>;

export function resolveDisplayIdentityForSessionFromState(input: Readonly<{
    state: SessionMachineTargetState;
    serverId?: string | null;
    sessionId?: string | null;
    metadata?: SessionTargetMetadataLike;
    preferProvidedMetadata?: boolean;
}>): SessionDisplayIdentity {
    const sessionId = normalizeNonEmptyString(input.sessionId);
    const targetInput = sessionId
        ? input.preferProvidedMetadata
            ? readSessionTargetInputForMetadata(input.state, sessionId, input.metadata, { allowProjectLookup: false, serverId: input.serverId })
            : readSessionDisplayTargetInput(input.state, sessionId, input.serverId)
        : null;
    const target = targetInput
        ? resolveSessionDisplayTarget(targetInput)
        : null;
    const machineId = target?.machineId || resolveSessionMachineId(input.metadata) || '';
    return {
        machineId,
        basePath: target?.basePath || resolveSessionBasePathForMachine({
            sessionPath: normalizeNonEmptyString(input.metadata?.path),
            sessionWorkspaceMetadata: input.metadata,
            targetMachineId: machineId,
        }) || '',
    };
}

export function resolveDisplayMachineIdForSessionFromState(input: Readonly<{
    state: SessionMachineTargetState;
    serverId?: string | null;
    sessionId?: string | null;
    metadata?: SessionTargetMetadataLike;
}>): string {
    return resolveDisplayIdentityForSessionFromState(input).machineId;
}

export function resolveDisplayMachineTargetForSessionFromState(input: Readonly<{
    state: SessionMachineTargetState;
    serverId?: string | null;
    sessionId?: string | null;
    metadata?: SessionTargetMetadataLike;
}>): { machineId: string; basePath: string } | null {
    const sessionId = normalizeNonEmptyString(input.sessionId);
    const targetInput = sessionId ? readSessionDisplayTargetInput(input.state, sessionId, input.serverId) : null;
    const projectTarget = targetInput?.projectMachineId && targetInput.projectPath
        ? resolveSessionDisplayTarget({
            sessionActive: false,
            sessionMachineId: targetInput.projectMachineId,
            sessionPath: targetInput.projectPath,
            projectMachineId: targetInput.projectMachineId,
            projectPath: targetInput.projectPath,
            machines: targetInput.machines,
        })
        : null;
    if (projectTarget?.machineId && projectTarget.basePath) {
        return {
            machineId: projectTarget.machineId,
            basePath: projectTarget.basePath,
        };
    }

    const target = targetInput ? resolveSessionDisplayTarget(targetInput) : null;
    if (target?.machineId && target.basePath) {
        return {
            machineId: target.machineId,
            basePath: target.basePath,
        };
    }

    const machineId = resolveSessionMachineId(input.metadata);
    const basePath = resolveSessionBasePathForMachine({
        sessionPath: normalizeNonEmptyString(input.metadata?.path),
        sessionWorkspaceMetadata: input.metadata,
        targetMachineId: machineId,
    });
    if (!machineId || !basePath) return null;
    return { machineId, basePath };
}

/** Terminal admission keeps the display binding while offline, but uses the machine-side path. */
export function resolveMachineTerminalTargetForSessionFromState(input: Readonly<{
    state: SessionMachineTargetState;
    serverId?: string | null;
    sessionId?: string | null;
}>): { machineId: string; basePath: string } | null {
    const sessionId = normalizeNonEmptyString(input.sessionId);
    if (!sessionId) return null;
    const displayTarget = resolveDisplayMachineTargetForSessionFromState({
        state: input.state, sessionId, serverId: input.serverId,
    });
    if (!displayTarget) return null;
    const metadata = readSessionDisplayTargetInput(input.state, sessionId, input.serverId)?.metadata;
    return resolveWorkspaceLocationForMachineTarget(metadata, displayTarget);
}

export function resolveDisplayPathForSessionFromState(input: Readonly<{
    state: SessionMachineTargetState;
    serverId?: string | null;
    sessionId?: string | null;
    metadata?: SessionTargetMetadataLike;
}>): string {
    return resolveDisplayIdentityForSessionFromState(input).basePath;
}
