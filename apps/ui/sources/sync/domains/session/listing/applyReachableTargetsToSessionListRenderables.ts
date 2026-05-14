import { normalizeTrimmedString } from '@/sync/domains/session/listing/normalizeTrimmedString';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import {
    buildMachineResolutionContextFromRecord,
    normalizeSessionPathForComparison,
    type MachineResolutionContext,
} from '@/sync/domains/session/resolveSessionReachableMachineId';
import { resolveSessionDisplayTarget } from '@/sync/domains/machines/identity/resolveSessionMachineTargets';
import { resolveSessionMachineId } from '@/sync/domains/session/external/resolveSessionMachineId';
import type { Machine, Session } from '@/sync/domains/state/storageTypes';

type ProjectLookupResult = {
    key?: {
        machineId?: string | null;
        rootPath?: string | null;
    } | null;
} | null;

type ReachableSessionProjectionParams = Readonly<{
    sessions: Record<string, SessionListRenderableSession>;
    sessionRecords?: Record<string, Session>;
    machineRecords?: Record<string, Machine>;
    getProjectForSession?: (sessionId: string) => ProjectLookupResult;
}>;

type SessionMachineDisplayTarget = Readonly<{
    machineId: string;
    basePath: string;
}> | null;

type NormalizedSessionProjectionInput = Readonly<{
    sessionMachineId: string | null;
    sessionHostHint: string | null;
    sessionPath: string | null;
    sessionHomeDir: string | null;
    projectMachineId: string | null;
    projectPath: string | null;
    comparableProjectPath: string | null;
    comparableBasePath: string | null;
}>;

type NormalizedSessionProjectionArtifacts = Readonly<{
    input: NormalizedSessionProjectionInput;
}>;

type NormalizedSessionRecordMetadata = Readonly<{
    sessionMachineId: string | null;
    sessionHostHint: string | null;
    sessionPath: string | null;
    sessionHomeDir: string | null;
    comparableSessionPath: string | null;
}>;

type NormalizedTargetMachineMetadata = Readonly<{
    homeDir: string | null;
    host: string | null;
}>;

function buildNormalizedSessionRecordMetadata(sessionRecord: Session): NormalizedSessionRecordMetadata {
    const metadata = sessionRecord.metadata ?? null;
    const sessionPath = normalizeTrimmedString(metadata?.path) || null;
    const sessionHomeDir = normalizeTrimmedString(metadata?.homeDir) || null;
    return {
        sessionMachineId: resolveSessionMachineId(metadata),
        sessionHostHint: normalizeTrimmedString(metadata?.host) || null,
        sessionPath,
        sessionHomeDir,
        comparableSessionPath: normalizeSessionPathForComparison(sessionPath, sessionHomeDir),
    };
}

function projectSessionRenderableMetadata(input: Readonly<{
    session: SessionListRenderableSession;
    targetMachineId: string;
    targetBasePath: string;
    targetMachineMetadata: NormalizedTargetMachineMetadata;
}>): SessionListRenderableSession {
    const metadata = input.session.metadata;
    if (!metadata) {
        return input.session;
    }

    const nextHomeDir = input.targetMachineMetadata.homeDir ?? metadata.homeDir ?? null;
    const nextHost = input.targetMachineMetadata.host ?? metadata.host ?? null;
    if (
        input.targetMachineId === metadata.machineId
        && input.targetBasePath === metadata.path
        && nextHomeDir === (metadata.homeDir ?? null)
        && nextHost === (metadata.host ?? null)
    ) {
        return input.session;
    }

    return {
        ...input.session,
        metadata: {
            ...metadata,
            machineId: input.targetMachineId,
            path: input.targetBasePath,
            homeDir: nextHomeDir,
            host: nextHost,
        },
    };
}

function readNormalizedTargetMachineMetadata(input: Readonly<{
    machineId: string;
    machineRecords: Record<string, Machine>;
    cache: Map<string, NormalizedTargetMachineMetadata>;
}>): NormalizedTargetMachineMetadata {
    const cached = input.cache.get(input.machineId);
    if (cached) {
        return cached;
    }
    const machine = input.machineRecords[input.machineId];
    const metadata = {
        homeDir: normalizeTrimmedString(machine?.metadata?.homeDir) || null,
        host: normalizeTrimmedString(machine?.metadata?.host) || null,
    } satisfies NormalizedTargetMachineMetadata;
    input.cache.set(input.machineId, metadata);
    return metadata;
}

function buildNormalizedSessionProjectionArtifacts(input: Readonly<{
    normalizedSessionMetadata: NormalizedSessionRecordMetadata;
    project: ProjectLookupResult;
}>): NormalizedSessionProjectionArtifacts {
    const projectPath = normalizeTrimmedString(input.project?.key?.rootPath) || null;
    const sessionMachineId = input.normalizedSessionMetadata.sessionMachineId;
    const sessionHostHint = input.normalizedSessionMetadata.sessionHostHint;
    const projectMachineId = normalizeTrimmedString(input.project?.key?.machineId) || null;
    const comparableProjectPath = normalizeSessionPathForComparison(projectPath, input.normalizedSessionMetadata.sessionHomeDir);
    const inputProjection = {
        sessionMachineId,
        sessionHostHint,
        sessionPath: input.normalizedSessionMetadata.sessionPath,
        sessionHomeDir: input.normalizedSessionMetadata.sessionHomeDir,
        projectMachineId,
        projectPath,
        comparableProjectPath,
        comparableBasePath: comparableProjectPath ?? input.normalizedSessionMetadata.comparableSessionPath,
    } satisfies NormalizedSessionProjectionInput;
    return {
        input: inputProjection,
    };
}

export function applyReachableTargetsToSessionListRenderables(
    params: ReachableSessionProjectionParams,
): Record<string, SessionListRenderableSession> {
    const sessionRecords = params.sessionRecords;
    const machineRecords = params.machineRecords;
    if (!sessionRecords || !machineRecords) {
        return params.sessions;
    }

    let normalizedProjectionArtifactsBySessionId: Map<string, NormalizedSessionProjectionArtifacts> | null = null;
    let normalizedSessionMetadataBySessionId: Map<string, NormalizedSessionRecordMetadata> | null = null;
    let normalizedTargetMachineMetadataById: Map<string, NormalizedTargetMachineMetadata> | null = null;
    const readNormalizedSessionMetadata = (sessionId: string, sessionRecord: Session): NormalizedSessionRecordMetadata => {
        const cache = normalizedSessionMetadataBySessionId ?? (normalizedSessionMetadataBySessionId = new Map());
        const cached = cache.get(sessionId);
        if (cached) {
            return cached;
        }
        const normalizedSessionMetadata = buildNormalizedSessionRecordMetadata(sessionRecord);
        cache.set(sessionId, normalizedSessionMetadata);
        return normalizedSessionMetadata;
    };
    const readNormalizedProjectionArtifacts = (sessionId: string, sessionRecord: Session): NormalizedSessionProjectionArtifacts => {
        const cache = normalizedProjectionArtifactsBySessionId ?? (normalizedProjectionArtifactsBySessionId = new Map());
        const cached = cache.get(sessionId);
        if (cached) {
            return cached;
        }
        const normalizedProjectionArtifacts = buildNormalizedSessionProjectionArtifacts({
            normalizedSessionMetadata: readNormalizedSessionMetadata(sessionId, sessionRecord),
            project: params.getProjectForSession?.(sessionId) ?? null,
        });
        cache.set(sessionId, normalizedProjectionArtifacts);
        return normalizedProjectionArtifacts;
    };
    const readCachedNormalizedTargetMachineMetadata = (machineId: string): NormalizedTargetMachineMetadata =>
        readNormalizedTargetMachineMetadata({
            machineId,
            machineRecords,
            cache: normalizedTargetMachineMetadataById ?? (normalizedTargetMachineMetadataById = new Map()),
        });

    let directProjectedOverrides: Map<string, SessionListRenderableSession> | null = null;
    let machineResolutionContext: MachineResolutionContext | undefined;

    for (const sessionId in params.sessions) {
        const session = params.sessions[sessionId];
        const sessionRecord = sessionRecords[sessionId];
        if (!sessionRecord || !session.metadata) {
            continue;
        }
        const normalizedProjectionArtifacts = readNormalizedProjectionArtifacts(sessionId, sessionRecord);
        const normalizedProjectionInput = normalizedProjectionArtifacts.input;
        if (!normalizedProjectionInput.sessionPath && !normalizedProjectionInput.projectPath) {
            continue;
        }
        if (!machineResolutionContext) {
            machineResolutionContext = buildMachineResolutionContextFromRecord(machineRecords);
            if (machineResolutionContext.machineIds.size === 0) {
                return params.sessions;
            }
        }
        const directTarget: SessionMachineDisplayTarget = resolveSessionDisplayTarget({
            sessionActive: sessionRecord.active === true,
            sessionMachineId: normalizedProjectionInput.sessionMachineId,
            sessionPath: normalizedProjectionInput.sessionPath,
            projectMachineId: normalizedProjectionInput.projectMachineId,
            projectPath: normalizedProjectionInput.projectPath,
            machines: Object.values(machineRecords),
        });

        if (!directTarget || !machineRecords[directTarget.machineId]) {
            continue;
        }

        const projectedSession = projectSessionRenderableMetadata({
            session,
            targetMachineId: directTarget.machineId,
            targetBasePath: directTarget.basePath,
            targetMachineMetadata: readCachedNormalizedTargetMachineMetadata(directTarget.machineId),
        });
        if (projectedSession !== session) {
            (directProjectedOverrides ??= new Map()).set(sessionId, projectedSession);
        }
    }

    if (!directProjectedOverrides || directProjectedOverrides.size === 0) {
        return params.sessions;
    }

    const nextSessions = { ...params.sessions };
    for (const [sessionId, session] of directProjectedOverrides) {
        nextSessions[sessionId] = session;
    }
    return nextSessions;
}
