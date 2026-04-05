import { getServerProfileById } from '../domains/server/serverProfiles';
import { getActiveServerSnapshot } from '../domains/server/serverRuntime';
import { buildSessionListViewData, type SessionListViewItem } from '../domains/session/listing/sessionListViewData';
import type { MachineDisplayRenderable } from '../domains/machines/machineDisplayRenderable';
import {
    type MachineResolutionContext,
    buildMachineResolutionContextFromRecord,
    resolveSessionMachineRpcTarget,
    normalizeSessionPathForComparison,
} from '../domains/session/resolveSessionReachableMachineId';
import type { SessionListRenderableSession } from '../domains/session/listing/sessionListRenderable';
import type { Machine, Session } from '../domains/state/storageTypes';

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

type SessionMachineRpcTarget = Readonly<{
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

type NormalizedSessionPeerProjection = Readonly<Pick<
    NormalizedSessionProjectionInput,
    'sessionMachineId' | 'sessionHostHint' | 'projectMachineId'
> & Readonly<{
    comparableProjectPath: string | null;
    comparableBasePath: string | null;
}>>;

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

type ReachableTargetPeerSession = Readonly<{
    id: string;
    active: boolean;
    updatedAt: number;
    machineId: string | null;
    hostHint: string | null;
    projectMachineId: string | null;
}>;

type ReachableTargetFallbackEntry = Readonly<{
    sessionId: string;
    normalizedProjectionInput: NormalizedSessionProjectionInput;
    directTarget: SessionMachineRpcTarget;
}>;

const EMPTY_REACHABLE_TARGET_PEER_SESSIONS: readonly ReachableTargetPeerSession[] = [];

function applySessionOverrideMap(
    sessions: Record<string, SessionListRenderableSession>,
    overrides: ReadonlyMap<string, SessionListRenderableSession> | null | undefined,
): Record<string, SessionListRenderableSession> {
    if (!overrides || overrides.size === 0) {
        return sessions;
    }
    const nextSessions = { ...sessions };
    for (const [sessionId, session] of overrides) {
        nextSessions[sessionId] = session;
    }
    return nextSessions;
}

function normalizeNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function buildNormalizedSessionRecordMetadata(sessionRecord: Session): NormalizedSessionRecordMetadata {
    const metadata = sessionRecord.metadata ?? null;
    const sessionPath = normalizeNonEmptyString(metadata?.path);
    const sessionHomeDir = normalizeNonEmptyString(metadata?.homeDir);
    return {
        sessionMachineId: normalizeNonEmptyString(metadata?.machineId),
        sessionHostHint: normalizeNonEmptyString(metadata?.host),
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
        homeDir: normalizeNonEmptyString(machine?.metadata?.homeDir),
        host: normalizeNonEmptyString(machine?.metadata?.host),
    } satisfies NormalizedTargetMachineMetadata;
    input.cache.set(input.machineId, metadata);
    return metadata;
}

function buildNormalizedSessionProjectionInput(input: Readonly<{
    normalizedSessionMetadata: NormalizedSessionRecordMetadata;
    project: ProjectLookupResult;
}>): NormalizedSessionProjectionInput {
    const projectPath = normalizeNonEmptyString(input.project?.key?.rootPath);
    const comparableProjectPath = normalizeSessionPathForComparison(projectPath, input.normalizedSessionMetadata.sessionHomeDir);
    return {
        sessionMachineId: input.normalizedSessionMetadata.sessionMachineId,
        sessionHostHint: input.normalizedSessionMetadata.sessionHostHint,
        sessionPath: input.normalizedSessionMetadata.sessionPath,
        sessionHomeDir: input.normalizedSessionMetadata.sessionHomeDir,
        projectMachineId: normalizeNonEmptyString(input.project?.key?.machineId),
        projectPath,
        comparableProjectPath,
        comparableBasePath: comparableProjectPath ?? input.normalizedSessionMetadata.comparableSessionPath,
    };
}

function buildNormalizedSessionPeerProjection(input: Readonly<{
    normalizedSessionMetadata: NormalizedSessionRecordMetadata;
    project: ProjectLookupResult;
}>): NormalizedSessionPeerProjection {
    const projectPath = normalizeNonEmptyString(input.project?.key?.rootPath);
    const comparableProjectPath = normalizeSessionPathForComparison(projectPath, input.normalizedSessionMetadata.sessionHomeDir);
    return {
        sessionMachineId: input.normalizedSessionMetadata.sessionMachineId,
        sessionHostHint: input.normalizedSessionMetadata.sessionHostHint,
        projectMachineId: normalizeNonEmptyString(input.project?.key?.machineId),
        comparableProjectPath,
        comparableBasePath: comparableProjectPath ?? input.normalizedSessionMetadata.comparableSessionPath,
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

    let normalizedProjectionInputBySessionId: Map<string, NormalizedSessionProjectionInput> | null = null;
    let normalizedPeerProjectionBySessionId: Map<string, NormalizedSessionPeerProjection> | null = null;
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
    const readNormalizedProjectionInput = (sessionId: string, sessionRecord: Session): NormalizedSessionProjectionInput => {
        const cache = normalizedProjectionInputBySessionId ?? (normalizedProjectionInputBySessionId = new Map());
        const cached = cache.get(sessionId);
        if (cached) {
            return cached;
        }
        const normalizedProjectionInput = buildNormalizedSessionProjectionInput({
            normalizedSessionMetadata: readNormalizedSessionMetadata(sessionId, sessionRecord),
            project: params.getProjectForSession?.(sessionId) ?? null,
        });
        cache.set(sessionId, normalizedProjectionInput);
        return normalizedProjectionInput;
    };
    const readNormalizedPeerProjection = (sessionId: string, sessionRecord: Session): NormalizedSessionPeerProjection => {
        const fullProjection = normalizedProjectionInputBySessionId?.get(sessionId);
        if (fullProjection) {
            return fullProjection;
        }
        const cache = normalizedPeerProjectionBySessionId ?? (normalizedPeerProjectionBySessionId = new Map());
        const cached = cache.get(sessionId);
        if (cached) {
            return cached;
        }
        const normalizedPeerProjection = buildNormalizedSessionPeerProjection({
            normalizedSessionMetadata: readNormalizedSessionMetadata(sessionId, sessionRecord),
            project: params.getProjectForSession?.(sessionId) ?? null,
        });
        cache.set(sessionId, normalizedPeerProjection);
        return normalizedPeerProjection;
    };
    const readCachedNormalizedTargetMachineMetadata = (machineId: string): NormalizedTargetMachineMetadata =>
        readNormalizedTargetMachineMetadata({
            machineId,
            machineRecords,
            cache: normalizedTargetMachineMetadataById ?? (normalizedTargetMachineMetadataById = new Map()),
        });

    let directProjectedOverrides: Map<string, SessionListRenderableSession> | null = null;
    let peerFallbackEntries: ReachableTargetFallbackEntry[] | null = null;
    let unresolvedComparableBasePaths: Set<string> | null = null;
    let machineResolutionContext: MachineResolutionContext | undefined;

    for (const sessionId in params.sessions) {
        const session = params.sessions[sessionId];
        const sessionRecord = sessionRecords[sessionId];
        if (!sessionRecord || !session.metadata) {
            continue;
        }
        const normalizedProjectionInput = readNormalizedProjectionInput(sessionId, sessionRecord);
        if (!normalizedProjectionInput.sessionPath && !normalizedProjectionInput.projectPath) {
            continue;
        }
        if (!machineResolutionContext) {
            machineResolutionContext = buildMachineResolutionContextFromRecord(machineRecords);
            if (machineResolutionContext.machineIds.size === 0) {
                return params.sessions;
            }
        }
        const directTarget = resolveSessionMachineRpcTarget({
            sessionId,
            sessionMachineId: normalizedProjectionInput.sessionMachineId,
            sessionHostHint: normalizedProjectionInput.sessionHostHint,
            sessionPath: normalizedProjectionInput.sessionPath,
            sessionHomeDir: normalizedProjectionInput.sessionHomeDir,
            comparableBasePath: normalizedProjectionInput.comparableBasePath,
            projectMachineId: normalizedProjectionInput.projectMachineId,
            projectPath: normalizedProjectionInput.projectPath,
            machineResolutionContext,
        });

        if (!directTarget || !machineRecords[directTarget.machineId]) {
            if (directTarget && !normalizedProjectionInput.comparableBasePath) {
                const projectedSession = projectSessionRenderableMetadata({
                    session,
                    targetMachineId: directTarget.machineId,
                    targetBasePath: directTarget.basePath,
                    targetMachineMetadata: readCachedNormalizedTargetMachineMetadata(directTarget.machineId),
                });
                if (projectedSession !== session) {
                    (directProjectedOverrides ??= new Map()).set(sessionId, projectedSession);
                }
                continue;
            }
            if (!directTarget && !normalizedProjectionInput.comparableBasePath) {
                continue;
            }
            (peerFallbackEntries ??= []).push({
                sessionId,
                normalizedProjectionInput,
                directTarget,
            });
            if (normalizedProjectionInput.comparableBasePath) {
                (unresolvedComparableBasePaths ??= new Set()).add(normalizedProjectionInput.comparableBasePath);
            }
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

    if (!peerFallbackEntries || peerFallbackEntries.length === 0) {
        return applySessionOverrideMap(params.sessions, directProjectedOverrides);
    }

    const peerSessionsByComparableBasePath = new Map<string, ReachableTargetPeerSession[]>();
    const unresolvedComparableBasePathsSet = unresolvedComparableBasePaths!;
    if (unresolvedComparableBasePathsSet.size > 0) {
        for (const sessionId in sessionRecords) {
            const session = sessionRecords[sessionId];
            const normalizedSessionMetadata = readNormalizedSessionMetadata(session.id, session);
            const comparableMetadataPath = normalizedSessionMetadata.comparableSessionPath;
            if (comparableMetadataPath && !unresolvedComparableBasePathsSet.has(comparableMetadataPath)) {
                continue;
            }
            let normalizedPeerProjection: NormalizedSessionPeerProjection;
            let comparablePeerBasePath: string | null = null;
            if (comparableMetadataPath) {
                comparablePeerBasePath = comparableMetadataPath;
                normalizedPeerProjection = readNormalizedPeerProjection(sessionId, session);
            } else {
                normalizedPeerProjection = readNormalizedPeerProjection(sessionId, session);
                const comparableProjectPath = normalizedPeerProjection.comparableProjectPath;
                if (!comparableProjectPath || !unresolvedComparableBasePathsSet.has(comparableProjectPath)) {
                    continue;
                }
                comparablePeerBasePath = normalizedPeerProjection.comparableBasePath;
            }

            const peerComparableBasePath = comparablePeerBasePath;
            if (!peerComparableBasePath) {
                continue;
            }

            let peerSessions = peerSessionsByComparableBasePath.get(peerComparableBasePath);
            if (!peerSessions) {
                peerSessions = [];
                peerSessionsByComparableBasePath.set(peerComparableBasePath, peerSessions);
            }
            peerSessions.push({
                id: session.id,
                active: session.active,
                updatedAt: session.updatedAt,
                machineId: normalizedPeerProjection.sessionMachineId,
                hostHint: normalizedPeerProjection.sessionHostHint,
                projectMachineId: normalizedPeerProjection.projectMachineId,
            });
        }

        for (const peerSessions of peerSessionsByComparableBasePath.values()) {
            if (peerSessions.length > 1) {
                peerSessions.sort((a, b) => {
                    const activeDelta = Number(Boolean(b.active)) - Number(Boolean(a.active));
                    if (activeDelta !== 0) {
                        return activeDelta;
                    }
                    return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
                });
            }
        }
    }

    let nextSessions = applySessionOverrideMap(params.sessions, directProjectedOverrides);
    let nextSessionsChanged = (directProjectedOverrides?.size ?? 0) > 0;
    const resolvedMachineResolutionContext = machineResolutionContext;
    if (!resolvedMachineResolutionContext) {
        return nextSessions;
    }
    for (const peerFallbackEntry of peerFallbackEntries) {
        const { sessionId, normalizedProjectionInput, directTarget } = peerFallbackEntry;
        const session = params.sessions[sessionId];
        const peerSessions = normalizedProjectionInput.comparableBasePath
            ? (peerSessionsByComparableBasePath.get(normalizedProjectionInput.comparableBasePath)
                ?? EMPTY_REACHABLE_TARGET_PEER_SESSIONS)
            : EMPTY_REACHABLE_TARGET_PEER_SESSIONS;
        const target = (!normalizedProjectionInput.comparableBasePath || peerSessions.length === 0)
            ? directTarget
            : resolveSessionMachineRpcTarget({
                sessionId,
                sessionMachineId: normalizedProjectionInput.sessionMachineId,
                sessionHostHint: normalizedProjectionInput.sessionHostHint,
                sessionPath: normalizedProjectionInput.sessionPath,
                sessionHomeDir: normalizedProjectionInput.sessionHomeDir,
                comparableBasePath: normalizedProjectionInput.comparableBasePath,
                projectMachineId: normalizedProjectionInput.projectMachineId,
                projectPath: normalizedProjectionInput.projectPath,
                machineResolutionContext: resolvedMachineResolutionContext,
                peerSessions,
                peerSessionsSorted: true,
                peerSessionsComparablePathFiltered: true,
            });

        if (!target) {
            continue;
        }

        const projectedSession = projectSessionRenderableMetadata({
            session,
            targetMachineId: target.machineId,
            targetBasePath: target.basePath,
            targetMachineMetadata: readCachedNormalizedTargetMachineMetadata(target.machineId),
        });
        if (projectedSession === session) {
            continue;
        }

        if (!nextSessionsChanged) {
            nextSessions = { ...params.sessions };
            nextSessionsChanged = true;
        }
        nextSessions[sessionId] = projectedSession;
    }

    return nextSessionsChanged ? nextSessions : params.sessions;
}

export function buildSessionListViewDataWithServerScope(params: {
    sessions: Record<string, SessionListRenderableSession>;
    sessionRecords?: Record<string, Session>;
    machines: Record<string, MachineDisplayRenderable>;
    machineRecords?: Record<string, Machine>;
    groupInactiveSessionsByProject: boolean;
    activeGroupingV1?: 'project' | 'date';
    inactiveGroupingV1?: 'project' | 'date';
    getProjectForSession?: (sessionId: string) => ProjectLookupResult;
}): SessionListViewItem[] {
    const snapshot = getActiveServerSnapshot();
    const profile = getServerProfileById(snapshot.serverId);
    const reachableSessions = applyReachableTargetsToSessionListRenderables({
        sessions: params.sessions,
        sessionRecords: params.sessionRecords,
        machineRecords: params.machineRecords,
        getProjectForSession: params.getProjectForSession,
    });

    return buildSessionListViewData(
        reachableSessions,
        params.machines,
        {
            groupInactiveSessionsByProject: params.groupInactiveSessionsByProject,
            activeGroupingV1: params.activeGroupingV1,
            inactiveGroupingV1: params.inactiveGroupingV1,
            serverScope: {
                serverId: snapshot.serverId,
                serverName: profile?.name,
            },
        }
    );
}
