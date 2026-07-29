import type { SessionListLookupStateLike } from '@/sync/domains/session/listing/sessionListLookupState';
import { resolveSessionListPreferredSessionMetadataFromState } from '@/sync/domains/session/listing/sessionListLookupState';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { resolveSessionMachineId } from '@/sync/domains/session/external/resolveSessionMachineId';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { isSameMachineLocality } from '@happier-dev/protocol';
import {
    resolveSessionDisplayTarget,
    resolveSessionRpcTarget,
} from '@/sync/domains/machines/identity/resolveSessionMachineTargets';
import { normalizeKnownProjectMachineId } from '@/sync/runtime/orchestration/projectManager';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import type { Metadata } from '@/sync/domains/state/storageTypes';

type MachineTargetLikeState = SessionListLookupStateLike & Readonly<{
    sessions?: Record<string, {
        active?: boolean;
        updatedAt?: number;
        metadata?: SessionTargetMetadataLike;
        metadataLayoutVersion?: number;
        ownerMetadataView?: Metadata | null;
    }>;
    machines?: Record<string, Machine>;
    getProjectForSession?: (sessionId: string) => { key?: { machineId?: string; rootPath?: string } } | null;
}>;

export type SessionMachineTargetState = MachineTargetLikeState;

export type SessionMachineControlTarget = Readonly<{
    machineId: string;
    basePath: string;
    confidence: 'reachable' | 'metadata_direct';
}>;

export type SessionTargetMetadataLike = Readonly<{
    machineId?: string | null;
    path?: string | null;
    host?: string | null;
    homeDir?: string | null;
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

function readMachines(state: SessionMachineTargetState): Machine[] {
    return Object.values(state.machines ?? {});
}

function resolveUniqueActiveMachineByHost(
    machines: ReadonlyArray<Machine>,
    host: string | null,
): Machine | null {
    if (!host) return null;
    const matches = machines.filter((machine) => {
        const machineHost = normalizeNonEmptyString(machine.metadata?.host);
        return machine.active === true
            && !machine.revokedAt
            && !machine.replacedByMachineId
            && machineHost === host;
    });
    return matches.length === 1 ? matches[0] ?? null : null;
}

function resolveUniqueActiveMachineByLocality(input: Readonly<{
    machines: ReadonlyArray<Machine>;
    sessionHost: string | null;
    sessionHomeDir: string | null;
}>): Machine | null {
    if (!input.sessionHost || !input.sessionHomeDir) return null;
    const matches = input.machines.filter((machine) => {
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
) {
    const session = state.sessions?.[sessionId];
    const getProjectForSession = typeof state.getProjectForSession === 'function' ? state.getProjectForSession : null;
    const project = getProjectForSession?.(sessionId) ?? null;

    return {
        metadata,
        sessionActive: session?.active === true,
        sessionMachineId: resolveSessionMachineId(metadata),
        sessionPath: normalizeNonEmptyString(metadata?.path),
        projectMachineId: normalizeKnownProjectMachineId(project?.key?.machineId),
        projectPath: normalizeNonEmptyString(project?.key?.rootPath),
        machines: readMachines(state),
    };
}

function resolveLegacyHostMachineTarget(input: Readonly<{
    metadata: SessionTargetMetadataLike;
    projectMachineId?: string | null;
    machines: ReadonlyArray<Machine>;
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
    machines: ReadonlyArray<Machine>;
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

function readSessionDisplayTargetInput(state: SessionMachineTargetState, sessionId: string) {
    const preferredMetadata = toSessionTargetMetadataLike(resolveSessionListPreferredSessionMetadataFromState(state, sessionId));
    return readSessionTargetInputForMetadata(state, sessionId, preferredMetadata);
}

function readPrivateSessionTargetInput(state: SessionMachineTargetState, sessionId: string) {
    return readPrivateSessionTargetInputs(state, sessionId)[0] ?? null;
}

export function resolveMachineTargetForSessionFromState(
    state: SessionMachineTargetState,
    sessionId: string,
): { machineId: string; basePath: string } | null {
    const resolvedSessionId = normalizeSessionId(sessionId);
    const inputs = readPrivateSessionTargetInputs(state, resolvedSessionId);
    for (const input of inputs) {
        const target = resolveSessionRpcTarget(input);
        if (!target) continue;
        return {
            machineId: target.machineId,
            basePath: target.basePath,
        };
    }
    for (const input of inputs) {
        const target = resolveLegacyHostMachineTarget({
            metadata: input.metadata,
            projectMachineId: input.projectMachineId,
            machines: input.machines,
        });
        if (target) return target;
    }
    for (const input of inputs) {
        const target = resolveSameLocalityReplacementMachineTarget({
            metadata: input.metadata,
            machines: input.machines,
        });
        if (target) return target;
    }
    return null;
}

function hasKnownUnavailableMachineState(machine: Machine | undefined): boolean {
    if (!machine) return false;
    if (machine.revokedAt && machine.revokedAt > 0) return true;
    if (machine.replacedByMachineId) return true;
    return machine.active !== true;
}

function hasConflictingDirectSessionMachine(input: ReturnType<typeof readPrivateSessionTargetInput>, machineId: string): boolean {
    if (!input) return false;
    const sessionMachineId = normalizeNonEmptyString(input.sessionMachineId);
    const projectMachineId = normalizeNonEmptyString(input.projectMachineId);
    if (!sessionMachineId) return false;
    if (!projectMachineId) return false;
    return sessionMachineId !== projectMachineId && machineId === projectMachineId;
}

export function resolveMachineControlTargetForSessionFromState(
    state: SessionMachineTargetState,
    sessionId: string,
): SessionMachineControlTarget | null {
    const resolvedSessionId = normalizeSessionId(sessionId);
    const reachableTarget = resolveMachineTargetForSessionFromState(state, resolvedSessionId);
    if (reachableTarget) {
        return {
            ...reachableTarget,
            confidence: 'reachable',
        };
    }

    const input = readPrivateSessionTargetInput(state, resolvedSessionId);
    if (!input) return null;
    const displayTarget = resolveSessionDisplayTarget(input);
    if (!displayTarget) return null;
    if (hasConflictingDirectSessionMachine(input, displayTarget.machineId)) return null;

    const knownMachine = state.machines?.[displayTarget.machineId];
    if (hasKnownUnavailableMachineState(knownMachine)) return null;

    return {
        machineId: displayTarget.machineId,
        basePath: displayTarget.basePath,
        confidence: 'metadata_direct',
    };
}

export function resolveDisplayMachineIdForSessionFromState(input: Readonly<{
    state: SessionMachineTargetState;
    sessionId?: string | null;
    metadata?: SessionTargetMetadataLike;
}>): string {
    const sessionId = normalizeNonEmptyString(input.sessionId);
    const target = sessionId
        ? resolveSessionDisplayTarget(readSessionDisplayTargetInput(input.state, sessionId))
        : null;
    if (target?.machineId) return target.machineId;
    return (
        resolveSessionMachineId(input.metadata)
        ?? ''
    );
}

export function resolveDisplayMachineTargetForSessionFromState(input: Readonly<{
    state: SessionMachineTargetState;
    sessionId?: string | null;
    metadata?: SessionTargetMetadataLike;
}>): { machineId: string; basePath: string } | null {
    const sessionId = normalizeNonEmptyString(input.sessionId);
    const targetInput = sessionId ? readSessionDisplayTargetInput(input.state, sessionId) : null;
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
    sessionId?: string | null;
    metadata?: SessionTargetMetadataLike;
}>): string {
    const sessionId = normalizeNonEmptyString(input.sessionId);
    const target = sessionId
        ? resolveSessionDisplayTarget(readSessionDisplayTargetInput(input.state, sessionId))
        : null;
    if (target?.basePath) return target.basePath;
    return normalizeNonEmptyString(input.metadata?.path) ?? '';
}
