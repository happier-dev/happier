import type { SessionListLookupStateLike } from '@/sync/domains/session/listing/sessionListLookupState';
import { resolveSessionListPreferredSessionMetadataFromState } from '@/sync/domains/session/listing/sessionListLookupState';
import { readSessionListRowForServerId, type SessionListRowStateByServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { machineCollectionValues, findMachineInCollection, type MachineCollection } from '@/sync/domains/machines/identity/machineCollection';
import { resolveSessionMachineId } from '@/sync/domains/session/external/resolveSessionMachineId';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { isSameMachineLocality } from '@happier-dev/protocol/machines/identity/machineLocality';
import { resolveSessionWorkspaceRootForMachine } from '@happier-dev/protocol/sessions/metadata/sessionWorkspaceLocationV1';
import {
    resolveSessionDisplayTarget,
    resolveSessionRpcTarget,
} from '@/sync/domains/machines/identity/resolveSessionMachineTargets';
import { normalizeKnownProjectMachineId } from '@/sync/runtime/orchestration/projectManager';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import type { Metadata } from '@happier-dev/session-core/state';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveServerScopedMachines } from '@/sync/domains/machines/resolveServerScopedMachines';

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
        activeMachines: Object.values(state.machines ?? {}),
        machineListByServerId: state.machineListByServerId ?? {},
        machineListStatusByServerId: state.machineListStatusByServerId,
    }) ?? [];
}

function resolveUniqueActiveMachineByHost(
    machines: MachineCollection<Machine>,
    host: string | null,
): Machine | null {
    if (!host) return null;
    const matches = machineCollectionValues(machines).filter((machine) => {
        const machineHost = normalizeNonEmptyString(machine.metadata?.host);
        return machine.active === true
            && !machine.revokedAt
            && !machine.replacedByMachineId
            && machineHost === host;
    });
    return matches.length === 1 ? matches[0] ?? null : null;
}

function resolveUniqueActiveMachineByLocality(input: Readonly<{
    machines: MachineCollection<Machine>;
    sessionHost: string | null;
    sessionHomeDir: string | null;
}>): Machine | null {
    if (!input.sessionHost || !input.sessionHomeDir) return null;
    const matches = machineCollectionValues(input.machines).filter((machine) => {
        const machineHost = normalizeNonEmptyString(machine.metadata?.host);
        const machineHomeDir = normalizeNonEmptyString(machine.metadata?.homeDir);
        return machine.active === true
            && !machine.revokedAt
            && !machine.replacedByMachineId
            && isSameMachineLocality({
                sessionHost: input.sessionHost,
                sessionHomeDir: input.sessionHomeDir,
                currentHost: machineHost,
                currentHomeDir: machineHomeDir,
                homeDir: machineHomeDir,
            });
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
        projectMachineId: normalizeKnownProjectMachineId(project?.key?.machineId),
        projectPath: normalizeNonEmptyString(project?.key?.rootPath),
        machines: options?.machines ?? readSessionMachines(state, options?.serverId),
    };
}

function resolveLegacyHostMachineTarget(input: Readonly<{
    metadata: SessionTargetMetadataLike;
    projectMachineId?: string | null;
    machines: MachineCollection<Machine>;
}>): { machineId: string; basePath: string } | null {
    if (resolveSessionMachineId(input.metadata)) return null;
    if (normalizeNonEmptyString(input.projectMachineId)) return null;

    const basePath = normalizeNonEmptyString(input.metadata?.path);
    if (!basePath) return null;

    const machine = resolveUniqueActiveMachineByHost(input.machines, normalizeNonEmptyString(input.metadata?.host));
    return machine ? { machineId: machine.id, basePath } : null;
}

function resolveSameLocalityReplacementMachineTarget(input: Readonly<{
    metadata: SessionTargetMetadataLike;
    machines: MachineCollection<Machine>;
}>): { machineId: string; basePath: string } | null {
    if (!resolveSessionMachineId(input.metadata)) return null;

    const basePath = normalizeNonEmptyString(input.metadata?.path);
    if (!basePath) return null;

    const machine = resolveUniqueActiveMachineByLocality({
        machines: input.machines,
        sessionHost: normalizeNonEmptyString(input.metadata?.host),
        sessionHomeDir: normalizeNonEmptyString(input.metadata?.homeDir),
    });
    return machine ? { machineId: machine.id, basePath } : null;
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
    const scopedRow = readSessionListRowForServerId(
        state.sessionListRowsByServerId,
        target.serverId,
        target.sessionId,
    );
    if (scopedRow) {
        const metadata = toSessionTargetMetadataLike(scopedRow.metadata);
        return metadata
            ? [readSessionTargetInputForMetadata(state, target.sessionId, metadata, {
                sessionActive: scopedRow.active === true,
                // Control targets use scoped Session facts, not display attribution.
                allowProjectLookup: false,
                machines,
            })]
            : [];
    }

    const directSession = state.sessions?.[target.sessionId];
    if (
        !directSession
        || !areServerProfileIdentifiersEquivalent(directSession.serverId, target.serverId)
    ) return [];
    const metadataValue = readSessionOwnerMetadataView({
        metadataLayoutVersion: directSession.metadataLayoutVersion,
        metadata: directSession.metadata as Metadata | null,
        ownerMetadataView: directSession.ownerMetadataView,
    });
    const metadata = toSessionTargetMetadataLike(metadataValue);
    return metadata
        ? [readSessionTargetInputForMetadata(state, target.sessionId, metadata, {
            sessionActive: directSession.active === true,
            allowProjectLookup: false,
            machines,
        })]
        : [];
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
        const target = resolveLegacyHostMachineTarget({
            metadata: input.metadata,
            projectMachineId: input.projectMachineId,
            machines: input.machines,
        });
        if (target) return resolveWorkspaceLocationForMachineTarget(input.metadata, target);
    }
    for (const input of inputs) {
        const target = resolveSameLocalityReplacementMachineTarget({
            metadata: input.metadata,
            machines: input.machines,
        });
        if (target) return resolveWorkspaceLocationForMachineTarget(input.metadata, target);
    }
    return null;
}

function hasKnownUnavailableMachineState(machine: Machine | undefined): boolean {
    if (!machine) return false;
    if (machine.revokedAt && machine.revokedAt > 0) return true;
    if (machine.replacedByMachineId) return true;
    return machine.active !== true;
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
    if (!displayTarget) return null;
    if (hasConflictingDirectSessionMachine(input)) return null;

    const knownMachine = findMachineInCollection(input.machines, displayTarget.machineId) ?? undefined;
    if (hasKnownUnavailableMachineState(knownMachine)) return null;

    const workspaceTarget = resolveWorkspaceLocationForMachineTarget(input.metadata, displayTarget);
    if (!workspaceTarget) return null;
    return {
        ...workspaceTarget,
        confidence: 'metadata_direct',
    };
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
    return {
        machineId: target?.machineId || resolveSessionMachineId(input.metadata) || '',
        basePath: target?.basePath || normalizeNonEmptyString(input.metadata?.path) || '',
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
    const basePath = normalizeNonEmptyString(input.metadata?.path);
    if (!machineId || !basePath) return null;
    return { machineId, basePath };
}

export function resolveDisplayPathForSessionFromState(input: Readonly<{
    state: SessionMachineTargetState;
    serverId?: string | null;
    sessionId?: string | null;
    metadata?: SessionTargetMetadataLike;
}>): string {
    return resolveDisplayIdentityForSessionFromState(input).basePath;
}
