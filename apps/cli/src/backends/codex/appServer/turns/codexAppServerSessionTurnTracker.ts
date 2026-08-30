import type { Metadata } from '@/api/types';
import type { SessionTurnLifecycle } from '@/agent/runtime/session/turn/types';
import type { SessionRuntimeIssueV1 } from '@happier-dev/protocol';
import {
    buildCodexAppServerRollbackEvidenceSet,
    resolveCodexAppServerRollbackPlan,
    type CodexAppServerRollbackPlan,
    type CodexAppServerRollbackEvidenceEntry,
    type CodexAppServerRollbackEvidenceSet,
} from './resolveCodexAppServerRollbackPlan';
import type { SessionRollbackTarget } from '@happier-dev/protocol';

const CODEX_APP_SERVER_SESSION_TURN_EVIDENCE_SESSION_ID = 'codex-app-server';
const CODEX_APP_SERVER_BACKEND_ID = 'codex-app-server';
const CODEX_AGENT_ID = 'codex';
const CODEX_APP_SERVER_ROLLBACK_RANGES_METADATA_KEY = 'sessionRollbackRangesV1';
const MAX_RETAINED_CODEX_APP_SERVER_TURN_ENTRIES = 200;
const MAX_RETAINED_CODEX_APP_SERVER_USER_MESSAGE_SEQS_PER_TURN = 50;
const COMMITTED_USER_MESSAGE_SEQ_WAIT_TIMEOUT_MS = 10_000;

type CodexAppServerSessionTurnTranscriptAnchors = Readonly<{
    startUserMessageSeq?: number;
    userMessageSeqs?: readonly number[];
    startSeqInclusive?: number;
    endSeqInclusive?: number | null;
}>;

type CodexAppServerSessionTurnTrackerSession = Readonly<{
    getMetadataSnapshot?: () => Metadata | null;
    getCommittedUserMessageSeq?: (localId: string) => number | null;
    waitForCommittedUserMessageSeq?: (
        localId: string,
        options?: Readonly<{ timeoutMs?: number }>,
    ) => Promise<number | null>;
    sessionTurnLifecycle?: SessionTurnLifecycle;
}>;

type ActiveTurn =
    | Readonly<{ kind: 'tracked'; turnId: string; providerTurnId: string | null }>
    | Readonly<{
        kind: 'unavailable';
        turnId: string | null;
        providerTurnId: string | null;
        startUserMessageSeq: number | null;
        startSeqInclusive: number | null;
    }>;

function readTrimmedString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normalizeSeq(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readRollbackRangesFromMetadata(metadata: Metadata | null | undefined): readonly Readonly<{
    startSeqInclusive: number;
    endSeqInclusive: number;
}>[] {
    const raw = readRecord(metadata)?.[CODEX_APP_SERVER_ROLLBACK_RANGES_METADATA_KEY];
    const ranges = readRecord(raw)?.ranges;
    if (!Array.isArray(ranges)) return [];
    return ranges.flatMap((range) => {
        const record = readRecord(range);
        const startSeqInclusive = normalizeSeq(record?.startSeqInclusive);
        const endSeqInclusive = normalizeSeq(record?.endSeqInclusive);
        return startSeqInclusive !== null && endSeqInclusive !== null
            ? [{ startSeqInclusive, endSeqInclusive }]
            : [];
    });
}

function createEmptySessionTurnEvidence(providerThreadId: string | null, updatedAt: number): CodexAppServerRollbackEvidenceSet {
    return buildCodexAppServerRollbackEvidenceSet({
        sessionId: CODEX_APP_SERVER_SESSION_TURN_EVIDENCE_SESSION_ID,
        backendId: CODEX_APP_SERVER_BACKEND_ID,
        agentId: CODEX_AGENT_ID,
        ...(providerThreadId ? { providerThreadId } : {}),
        updatedAt,
        entries: [],
        recentMutationIds: [],
    });
}

function boundEntries(
    entries: readonly CodexAppServerRollbackEvidenceEntry[],
): readonly CodexAppServerRollbackEvidenceEntry[] {
    if (entries.length <= MAX_RETAINED_CODEX_APP_SERVER_TURN_ENTRIES) return entries;
    return entries.slice(-MAX_RETAINED_CODEX_APP_SERVER_TURN_ENTRIES);
}

function appendBoundedUserMessageSeq(seqs: readonly number[], seq: number): number[] {
    const uniqueSeqs = seqs.includes(seq) ? [...seqs] : [...seqs, seq];
    if (uniqueSeqs.length <= MAX_RETAINED_CODEX_APP_SERVER_USER_MESSAGE_SEQS_PER_TURN) return uniqueSeqs;
    const [startSeq, ...steerSeqs] = uniqueSeqs;
    if (typeof startSeq !== 'number') return uniqueSeqs.slice(-MAX_RETAINED_CODEX_APP_SERVER_USER_MESSAGE_SEQS_PER_TURN);
    return [
        startSeq,
        ...steerSeqs.slice(-(MAX_RETAINED_CODEX_APP_SERVER_USER_MESSAGE_SEQS_PER_TURN - 1)),
    ];
}

function buildSessionTurnEvidence(params: Readonly<{
    current: CodexAppServerRollbackEvidenceSet;
    providerThreadId: string | null;
    updatedAt: number;
    entries: readonly CodexAppServerRollbackEvidenceEntry[];
}>): CodexAppServerRollbackEvidenceSet {
    return buildCodexAppServerRollbackEvidenceSet({
        ...params.current,
        sessionId: params.current.sessionId || CODEX_APP_SERVER_SESSION_TURN_EVIDENCE_SESSION_ID,
        backendId: CODEX_APP_SERVER_BACKEND_ID,
        agentId: CODEX_AGENT_ID,
        ...(params.providerThreadId ? { providerThreadId: params.providerThreadId } : {}),
        updatedAt: params.updatedAt,
        entries: boundEntries(params.entries),
        recentMutationIds: params.current.recentMutationIds,
    });
}

function readLifecycleBeginTurnId(value: Awaited<ReturnType<SessionTurnLifecycle['beginTurn']>>): string | null {
    return readTrimmedString(value && typeof value === 'object' ? value.turnId : null);
}

function readEntryStartSeq(entry: CodexAppServerRollbackEvidenceEntry): number | null {
    return normalizeSeq(entry.transcriptAnchors?.startSeqInclusive) ?? normalizeSeq(entry.transcriptAnchors?.startUserMessageSeq);
}

function readEntryEndSeq(entry: CodexAppServerRollbackEvidenceEntry): number | null {
    return normalizeSeq(entry.transcriptAnchors?.endSeqInclusive ?? null);
}

function buildRolledBackSessionTurnEvidence(params: Readonly<{
    current: CodexAppServerRollbackEvidenceSet;
    providerThreadId: string | null;
    updatedAt: number;
    numTurns: number;
}>): CodexAppServerRollbackEvidenceSet | null {
    const completedTurnIds = params.current.entries
        .filter((entry) => entry.status === 'completed' && readEntryEndSeq(entry) !== null)
        .slice(-params.numTurns)
        .map((entry) => entry.turnId);
    if (completedTurnIds.length === 0) return null;
    const completedTurnIdSet = new Set(completedTurnIds);
    return buildSessionTurnEvidence({
        current: params.current,
        providerThreadId: params.providerThreadId,
        updatedAt: params.updatedAt,
        entries: params.current.entries.map((entry) => completedTurnIdSet.has(entry.turnId)
            ? { ...entry, rollback: { ...(entry.rollback ?? {}), state: 'rolled_back', updatedAt: params.updatedAt }, updatedAt: params.updatedAt }
            : entry),
    });
}

function entryOverlapsRollbackRange(
    entry: CodexAppServerRollbackEvidenceEntry,
    range: Readonly<{ startSeqInclusive: number; endSeqInclusive: number }>,
): boolean {
    const turnStart = readEntryStartSeq(entry);
    const turnEnd = readEntryEndSeq(entry);
    if (turnStart === null || turnEnd === null) return false;
    return turnStart <= range.endSeqInclusive && turnEnd >= range.startSeqInclusive;
}

export function createCodexAppServerSessionTurnTracker(params: Readonly<{
    session: CodexAppServerSessionTurnTrackerSession;
    getProviderThreadId: () => string | null;
    now?: () => number;
    onMetadataWriteError?: (error: unknown) => void;
}>) {
    const now = params.now ?? Date.now;
    let sessionTurnEvidence = createEmptySessionTurnEvidence(params.getProviderThreadId(), now());
    let activeTurn: ActiveTurn | null = null;
    let activeTurnGeneration = 0;
    let pendingStartAnchorResolution: Promise<void> | null = null;

    const applyLocalSessionTurnEvidenceMutation = (
        mutate: (
            current: CodexAppServerRollbackEvidenceSet,
            timestamp: number,
        ) => CodexAppServerRollbackEvidenceSet,
    ): void => {
        sessionTurnEvidence = mutate(sessionTurnEvidence, now());
    };

    const readCommittedUserMessageSeq = (localId: string | null | undefined): number | null => {
        const trimmedLocalId = readTrimmedString(localId);
        if (!trimmedLocalId) return null;
        return normalizeSeq(params.session.getCommittedUserMessageSeq?.(trimmedLocalId) ?? null);
    };

    const waitForCommittedUserMessageSeq = async (localId: string | null | undefined): Promise<number | null> => {
        const trimmedLocalId = readTrimmedString(localId);
        if (!trimmedLocalId) return null;
        return normalizeSeq(await params.session.waitForCommittedUserMessageSeq?.(trimmedLocalId, {
            timeoutMs: COMMITTED_USER_MESSAGE_SEQ_WAIT_TIMEOUT_MS,
        }) ?? null);
    };

    const resolveCommittedUserMessageSeq = async (localId: string | null | undefined): Promise<number | null> =>
        readCommittedUserMessageSeq(localId) ?? await waitForCommittedUserMessageSeq(localId);

    const buildInitialTranscriptAnchors = (
        startUserMessageSeq: number,
        startSeqInclusive: number | null,
    ): CodexAppServerSessionTurnTranscriptAnchors => ({
        startUserMessageSeq,
        userMessageSeqs: [startUserMessageSeq],
        startSeqInclusive: startSeqInclusive ?? startUserMessageSeq,
        endSeqInclusive: null,
    });

    const upsertInProgressSessionTurnEvidence = (
        turnId: string,
        transcriptAnchors: CodexAppServerSessionTurnTranscriptAnchors,
    ): void => {
        applyLocalSessionTurnEvidenceMutation((current, timestamp) => {
            const nextEntry: CodexAppServerRollbackEvidenceEntry = {
                turnId,
                status: 'in_progress',
                startedAt: timestamp,
                updatedAt: timestamp,
                transcriptAnchors,
                rollback: { state: 'not_eligible', updatedAt: timestamp },
            };
            const hasExistingEntry = current.entries.some((entry) => entry.turnId === turnId);
            return buildSessionTurnEvidence({
                current,
                providerThreadId: params.getProviderThreadId(),
                updatedAt: timestamp,
                entries: hasExistingEntry
                    ? current.entries.map((entry) => entry.turnId === turnId ? {
                        ...entry,
                        updatedAt: timestamp,
                        transcriptAnchors: {
                            ...(entry.transcriptAnchors ?? {}),
                            ...transcriptAnchors,
                            userMessageSeqs: (transcriptAnchors.userMessageSeqs ?? []).reduce(
                                (seqs, seq) => appendBoundedUserMessageSeq(seqs, seq),
                                entry.transcriptAnchors?.userMessageSeqs ?? [],
                            ),
                        },
                    } : entry)
                    : [...current.entries, nextEntry],
            });
        });
    };

    const mergeBeginIntoActiveTurn = async (paramsForTurn: Readonly<{
        providerTurnId: string | null;
        startUserMessageSeq: number | null;
        startSeqInclusive: number | null;
    }>): Promise<boolean> => {
        if (!activeTurn) return false;
        const providerTurnId = paramsForTurn.providerTurnId ?? activeTurn.providerTurnId;
        const startUserMessageSeq = normalizeSeq(paramsForTurn.startUserMessageSeq);
        const startSeqInclusive = normalizeSeq(paramsForTurn.startSeqInclusive);
        if (activeTurn.kind === 'unavailable') {
            activeTurn = {
                kind: 'unavailable',
                turnId: activeTurn.turnId,
                providerTurnId,
                startUserMessageSeq,
                startSeqInclusive: startSeqInclusive ?? startUserMessageSeq,
            };
            return true;
        }

        const activeTurnId = activeTurn.turnId;
        const lifecycle = params.session.sessionTurnLifecycle;
        if (startUserMessageSeq !== null) {
            const transcriptAnchors = buildInitialTranscriptAnchors(startUserMessageSeq, startSeqInclusive);
            if (lifecycle) {
                try {
                    await lifecycle.appendTranscriptAnchors({
                        provider: CODEX_AGENT_ID,
                        transcriptAnchors,
                    });
                    upsertInProgressSessionTurnEvidence(activeTurnId, transcriptAnchors);
                } catch (error) {
                    params.onMetadataWriteError?.(error);
                }
            } else {
                upsertInProgressSessionTurnEvidence(activeTurnId, transcriptAnchors);
            }
        }

        if (providerTurnId && activeTurn.providerTurnId !== providerTurnId) {
            if (lifecycle) {
                try {
                    await lifecycle.attachProviderTurnId({
                        provider: CODEX_AGENT_ID,
                        providerTurnId,
                    });
                } catch (error) {
                    params.onMetadataWriteError?.(error);
                }
            } else {
                applyLocalSessionTurnEvidenceMutation((current, timestamp) => buildSessionTurnEvidence({
                    current,
                    providerThreadId: params.getProviderThreadId(),
                    updatedAt: timestamp,
                    entries: current.entries.map((entry) => entry.turnId === activeTurnId
                        ? { ...entry, turnId: providerTurnId, updatedAt: timestamp }
                        : entry),
                }));
            }
            activeTurn = { kind: 'tracked', turnId: lifecycle ? activeTurnId : providerTurnId, providerTurnId };
        }
        return true;
    };

    const scheduleStartAnchorResolution = (paramsForTurn: Readonly<{
        localId: string | null | undefined;
        startSeqInclusive: number | null;
        generation: number;
    }>): void => {
        if (!readTrimmedString(paramsForTurn.localId) || !params.session.waitForCommittedUserMessageSeq) return;
        const resolution = (async () => {
            const startUserMessageSeq = await waitForCommittedUserMessageSeq(paramsForTurn.localId);
            if (startUserMessageSeq === null || paramsForTurn.generation !== activeTurnGeneration) return;
            await mergeBeginIntoActiveTurn({
                providerTurnId: null,
                startUserMessageSeq,
                startSeqInclusive: paramsForTurn.startSeqInclusive,
            });
        })().catch((error) => {
            params.onMetadataWriteError?.(error);
        });
        pendingStartAnchorResolution = resolution;
        void resolution.finally(() => {
            if (pendingStartAnchorResolution === resolution) pendingStartAnchorResolution = null;
        });
    };

    const drainStartAnchorResolution = async (): Promise<void> => {
        const resolution = pendingStartAnchorResolution;
        if (resolution) await resolution;
    };

    const readRollbackPlanningEvidence = (): CodexAppServerRollbackEvidenceSet => {
        const metadataSnapshot = params.session.getMetadataSnapshot?.();
        const rollbackRanges = readRollbackRangesFromMetadata(metadataSnapshot);
        if (rollbackRanges.length === 0) return sessionTurnEvidence;

        const timestamp = now();
        return buildSessionTurnEvidence({
            current: sessionTurnEvidence,
            providerThreadId: params.getProviderThreadId(),
            updatedAt: timestamp,
            entries: sessionTurnEvidence.entries.map((entry) => {
                if (entry.status !== 'completed') return entry;
                if (!rollbackRanges.some((range) => entryOverlapsRollbackRange(entry, range))) return entry;
                return { ...entry, rollback: { ...(entry.rollback ?? {}), state: 'rolled_back', updatedAt: timestamp }, updatedAt: timestamp };
            }),
        });
    };

    return {
        initializeFromCurrentMetadata(): void {
            sessionTurnEvidence = createEmptySessionTurnEvidence(params.getProviderThreadId(), now());
            activeTurn = null;
            activeTurnGeneration += 1;
            pendingStartAnchorResolution = null;
        },

        async beginTurn(paramsForTurn: Readonly<{
            turnId: string | null;
            startUserMessageLocalId?: string | null;
            startUserMessageSeq?: number | null;
            startSeqInclusive: number | null;
        }>): Promise<void> {
            const providerTurnId = readTrimmedString(paramsForTurn.turnId);
            const suppliedStartUserMessageSeq = normalizeSeq(paramsForTurn.startUserMessageSeq);
            const startUserMessageSeq = suppliedStartUserMessageSeq
                ?? readCommittedUserMessageSeq(paramsForTurn.startUserMessageLocalId);
            const startSeqInclusive = normalizeSeq(paramsForTurn.startSeqInclusive);
            if (await mergeBeginIntoActiveTurn({ providerTurnId, startUserMessageSeq, startSeqInclusive })) return;
            activeTurnGeneration += 1;
            const turnGeneration = activeTurnGeneration;
            const lifecycle = params.session.sessionTurnLifecycle;
            if (startUserMessageSeq === null) {
                if (lifecycle) {
                    try {
                        const beginResult = await lifecycle.beginTurn({
                            provider: CODEX_AGENT_ID,
                            ...(providerTurnId ? { providerTurnId } : {}),
                        });
                        const sessionTurnId = readLifecycleBeginTurnId(beginResult) ?? providerTurnId;
                        activeTurn = sessionTurnId
                            ? { kind: 'tracked', turnId: sessionTurnId, providerTurnId }
                            : { kind: 'unavailable', turnId: null, providerTurnId, startUserMessageSeq, startSeqInclusive };
                    } catch (error) {
                        params.onMetadataWriteError?.(error);
                        activeTurn = { kind: 'unavailable', turnId: null, providerTurnId, startUserMessageSeq, startSeqInclusive };
                    }
                    scheduleStartAnchorResolution({
                        localId: paramsForTurn.startUserMessageLocalId,
                        startSeqInclusive,
                        generation: turnGeneration,
                    });
                    return;
                }
                activeTurn = { kind: 'unavailable', turnId: null, providerTurnId, startUserMessageSeq, startSeqInclusive };
                scheduleStartAnchorResolution({ localId: paramsForTurn.startUserMessageLocalId, startSeqInclusive, generation: turnGeneration });
                return;
            }
            const resolvedStartSeqInclusive = startSeqInclusive ?? startUserMessageSeq;
            const transcriptAnchors = buildInitialTranscriptAnchors(startUserMessageSeq, resolvedStartSeqInclusive);
            if (lifecycle) {
                try {
                    const beginResult = await lifecycle.beginTurn({
                        provider: CODEX_AGENT_ID,
                        ...(providerTurnId ? { providerTurnId } : {}),
                        transcriptAnchors,
                    });
                    const sessionTurnId = readLifecycleBeginTurnId(beginResult) ?? providerTurnId;
                    if (!sessionTurnId) {
                        activeTurn = { kind: 'unavailable', turnId: null, providerTurnId, startUserMessageSeq, startSeqInclusive: resolvedStartSeqInclusive };
                        return;
                    }
                    upsertInProgressSessionTurnEvidence(sessionTurnId, transcriptAnchors);
                    activeTurn = { kind: 'tracked', turnId: sessionTurnId, providerTurnId };
                } catch (error) {
                    params.onMetadataWriteError?.(error);
                    activeTurn = { kind: 'unavailable', turnId: null, providerTurnId, startUserMessageSeq, startSeqInclusive: resolvedStartSeqInclusive };
                }
                return;
            }
            if (!providerTurnId) {
                activeTurn = { kind: 'unavailable', turnId: null, providerTurnId, startUserMessageSeq, startSeqInclusive: resolvedStartSeqInclusive };
                return;
            }
            upsertInProgressSessionTurnEvidence(providerTurnId, transcriptAnchors);
            activeTurn = { kind: 'tracked', turnId: providerTurnId, providerTurnId };
        },

        async updateActiveTurnId(turnId: string | null): Promise<void> {
            const nextTurnId = readTrimmedString(turnId);
            if (!nextTurnId || !activeTurn || activeTurn.providerTurnId === nextTurnId) return;
            const lifecycle = params.session.sessionTurnLifecycle;
            if (activeTurn.kind === 'unavailable') {
                const startUserMessageSeq = normalizeSeq(activeTurn.startUserMessageSeq);
                const startSeqInclusive = normalizeSeq(activeTurn.startSeqInclusive);
                if (startUserMessageSeq === null) {
                    activeTurn = { kind: 'unavailable', turnId: activeTurn.turnId, providerTurnId: nextTurnId, startUserMessageSeq, startSeqInclusive: startSeqInclusive ?? null };
                    return;
                }
                const resolvedStartSeqInclusive = startSeqInclusive ?? startUserMessageSeq;
                const transcriptAnchors = {
                    startUserMessageSeq,
                    userMessageSeqs: [startUserMessageSeq],
                    startSeqInclusive: resolvedStartSeqInclusive,
                    endSeqInclusive: null,
                } as const satisfies CodexAppServerSessionTurnTranscriptAnchors;
                if (lifecycle) {
                    try {
                        const beginResult = await lifecycle.beginTurn({
                            provider: CODEX_AGENT_ID,
                            providerTurnId: nextTurnId,
                            transcriptAnchors,
                        });
                        const sessionTurnId = readLifecycleBeginTurnId(beginResult) ?? activeTurn.turnId ?? nextTurnId;
                        await lifecycle.attachProviderTurnId({
                            provider: CODEX_AGENT_ID,
                            providerTurnId: nextTurnId,
                        });
                        applyLocalSessionTurnEvidenceMutation((current, timestamp) => {
                            const nextEntry: CodexAppServerRollbackEvidenceEntry = {
                                turnId: sessionTurnId,
                                status: 'in_progress',
                                startedAt: timestamp,
                                updatedAt: timestamp,
                                transcriptAnchors,
                                rollback: { state: 'not_eligible', updatedAt: timestamp },
                            };
                            return buildSessionTurnEvidence({
                                current,
                                providerThreadId: params.getProviderThreadId(),
                                updatedAt: timestamp,
                                entries: [...current.entries.filter((entry) => entry.turnId !== sessionTurnId), nextEntry],
                            });
                        });
                        activeTurn = { kind: 'tracked', turnId: sessionTurnId, providerTurnId: nextTurnId };
                    } catch (error) {
                        params.onMetadataWriteError?.(error);
                        activeTurn = { kind: 'unavailable', turnId: activeTurn.turnId, providerTurnId: nextTurnId, startUserMessageSeq, startSeqInclusive: resolvedStartSeqInclusive };
                    }
                    return;
                }
                applyLocalSessionTurnEvidenceMutation((current, timestamp) => {
                    const nextEntry: CodexAppServerRollbackEvidenceEntry = {
                        turnId: nextTurnId,
                        status: 'in_progress',
                        startedAt: timestamp,
                        updatedAt: timestamp,
                        transcriptAnchors,
                        rollback: { state: 'not_eligible', updatedAt: timestamp },
                    };
                    return buildSessionTurnEvidence({
                        current,
                        providerThreadId: params.getProviderThreadId(),
                        updatedAt: timestamp,
                        entries: [...current.entries.filter((entry) => entry.turnId !== nextTurnId), nextEntry],
                    });
                });
                activeTurn = { kind: 'tracked', turnId: nextTurnId, providerTurnId: nextTurnId };
                return;
            }
            const previousTurnId = activeTurn.turnId;
            if (lifecycle) {
                try {
                    await lifecycle.attachProviderTurnId({
                        provider: CODEX_AGENT_ID,
                        providerTurnId: nextTurnId,
                    });
                    applyLocalSessionTurnEvidenceMutation((current, timestamp) => buildSessionTurnEvidence({
                        current,
                        providerThreadId: params.getProviderThreadId(),
                        updatedAt: timestamp,
                        entries: current.entries.map((entry) => entry.turnId === previousTurnId
                            ? { ...entry, updatedAt: timestamp }
                            : entry),
                    }));
                    activeTurn = { kind: 'tracked', turnId: previousTurnId, providerTurnId: nextTurnId };
                } catch (error) {
                    params.onMetadataWriteError?.(error);
                }
                return;
            }
            applyLocalSessionTurnEvidenceMutation((current, timestamp) => buildSessionTurnEvidence({
                current,
                providerThreadId: params.getProviderThreadId(),
                updatedAt: timestamp,
                entries: current.entries.map((entry) => entry.turnId === previousTurnId
                    ? { ...entry, turnId: nextTurnId, updatedAt: timestamp }
                    : entry),
            }));
            activeTurn = { kind: 'tracked', turnId: nextTurnId, providerTurnId: nextTurnId };
        },

        async appendSteerMessage(paramsForSteer: Readonly<{ localId?: string | null }>): Promise<void> {
            if (!activeTurn || activeTurn.kind !== 'tracked') return;
            const steerSeq = await resolveCommittedUserMessageSeq(paramsForSteer.localId);
            if (steerSeq === null) return;
            const activeTurnId = activeTurn.turnId;
            const lifecycle = params.session.sessionTurnLifecycle;
            if (lifecycle) {
                try {
                    await lifecycle.appendTranscriptAnchors({
                        provider: CODEX_AGENT_ID,
                        transcriptAnchors: { userMessageSeqs: [steerSeq] },
                    });
                    applyLocalSessionTurnEvidenceMutation((current, timestamp) => buildSessionTurnEvidence({
                        current,
                        providerThreadId: params.getProviderThreadId(),
                        updatedAt: timestamp,
                        entries: current.entries.map((entry) => {
                            if (entry.turnId !== activeTurnId || entry.status !== 'in_progress') return entry;
                            const anchors = entry.transcriptAnchors;
                            return {
                                ...entry,
                                transcriptAnchors: {
                                    ...(anchors ?? {}),
                                    userMessageSeqs: appendBoundedUserMessageSeq(anchors?.userMessageSeqs ?? [], steerSeq),
                                },
                                updatedAt: timestamp,
                            };
                        }),
                    }));
                } catch (error) {
                    params.onMetadataWriteError?.(error);
                }
                return;
            }
            applyLocalSessionTurnEvidenceMutation((current, timestamp) => buildSessionTurnEvidence({
                current,
                providerThreadId: params.getProviderThreadId(),
                updatedAt: timestamp,
                entries: current.entries.map((entry) => {
                    if (entry.turnId !== activeTurnId || entry.status !== 'in_progress') return entry;
                    const anchors = entry.transcriptAnchors;
                    return {
                        ...entry,
                        transcriptAnchors: {
                            ...(anchors ?? {}),
                            userMessageSeqs: appendBoundedUserMessageSeq(anchors?.userMessageSeqs ?? [], steerSeq),
                        },
                        updatedAt: timestamp,
                    };
                }),
            }));
        },

        async completeActiveTurn(paramsForCompletion: Readonly<{ endSeqInclusive: number | null }>): Promise<void> {
            await drainStartAnchorResolution();
            if (!activeTurn || activeTurn.kind !== 'tracked') {
                activeTurn = null;
                return;
            }
            const completedTurnId = activeTurn.turnId;
            const endSeqInclusive = normalizeSeq(paramsForCompletion.endSeqInclusive);
            const lifecycle = params.session.sessionTurnLifecycle;
            if (lifecycle) {
                let rollbackAnchors: CodexAppServerSessionTurnTranscriptAnchors | null = null;
                const buildCompletedEvidence = (
                    timestamp: number,
                    rollbackState: 'not_eligible' | 'eligible',
                ): CodexAppServerRollbackEvidenceSet => buildSessionTurnEvidence({
                    current: sessionTurnEvidence,
                    providerThreadId: params.getProviderThreadId(),
                    updatedAt: timestamp,
                    entries: sessionTurnEvidence.entries.map((entry) => {
                        if (entry.turnId !== completedTurnId) return entry;
                        const transcriptAnchors: CodexAppServerRollbackEvidenceEntry['transcriptAnchors'] = {
                            ...(entry.transcriptAnchors ?? {}),
                            endSeqInclusive,
                        };
                        rollbackAnchors = transcriptAnchors;
                        return {
                            ...entry,
                            status: 'completed',
                            terminalAt: timestamp,
                            updatedAt: timestamp,
                            transcriptAnchors,
                            rollback: { ...(entry.rollback ?? {}), state: rollbackState, updatedAt: timestamp },
                        };
                    }),
                });
                try {
                    await lifecycle.completeTurn({
                        provider: CODEX_AGENT_ID,
                    });
                    const completedTimestamp = now();
                    sessionTurnEvidence = buildCompletedEvidence(completedTimestamp, 'not_eligible');
                    activeTurn = null;
                    if (rollbackAnchors) {
                        await lifecycle.markRollbackEligible({
                            turnId: completedTurnId,
                            provider: CODEX_AGENT_ID,
                            transcriptAnchors: rollbackAnchors,
                        });
                        sessionTurnEvidence = buildCompletedEvidence(completedTimestamp, 'eligible');
                    }
                } catch (error) {
                    params.onMetadataWriteError?.(error);
                }
                return;
            }
            applyLocalSessionTurnEvidenceMutation((current, timestamp) => buildSessionTurnEvidence({
                current,
                providerThreadId: params.getProviderThreadId(),
                updatedAt: timestamp,
                entries: current.entries.map((entry) => entry.turnId === completedTurnId && entry.status === 'in_progress'
                    ? {
                        ...entry,
                        status: 'completed',
                        terminalAt: timestamp,
                        updatedAt: timestamp,
                        transcriptAnchors: {
                            ...(entry.transcriptAnchors ?? {}),
                            endSeqInclusive,
                        },
                        rollback: { ...(entry.rollback ?? {}), state: 'eligible', updatedAt: timestamp },
                    }
                    : entry),
            }));
            activeTurn = null;
        },

        async interruptActiveTurn(paramsForInterruption: Readonly<{ endSeqInclusive: number | null }>): Promise<void> {
            await drainStartAnchorResolution();
            if (!activeTurn || activeTurn.kind !== 'tracked') {
                activeTurn = null;
                return;
            }
            const interruptedTurnId = activeTurn.turnId;
            const endSeqInclusive = normalizeSeq(paramsForInterruption.endSeqInclusive);
            const lifecycle = params.session.sessionTurnLifecycle;
            if (lifecycle) {
                applyLocalSessionTurnEvidenceMutation((current, timestamp) => buildSessionTurnEvidence({
                    current,
                    providerThreadId: params.getProviderThreadId(),
                    updatedAt: timestamp,
                    entries: current.entries.map((entry) => entry.turnId === interruptedTurnId && entry.status === 'in_progress'
                        ? {
                            ...entry,
                            status: 'cancelled',
                            terminalAt: timestamp,
                            updatedAt: timestamp,
                            transcriptAnchors: {
                                ...(entry.transcriptAnchors ?? {}),
                                endSeqInclusive,
                            },
                        }
                        : entry),
                }));
                try {
                    await lifecycle.cancelTurn({
                        provider: CODEX_AGENT_ID,
                    });
                    activeTurn = null;
                } catch (error) {
                    params.onMetadataWriteError?.(error);
                }
                return;
            }
            applyLocalSessionTurnEvidenceMutation((current, timestamp) => buildSessionTurnEvidence({
                current,
                providerThreadId: params.getProviderThreadId(),
                updatedAt: timestamp,
                entries: current.entries.map((entry) => entry.turnId === interruptedTurnId && entry.status === 'in_progress'
                    ? {
                        ...entry,
                        status: 'cancelled',
                        terminalAt: timestamp,
                        updatedAt: timestamp,
                        transcriptAnchors: {
                            ...(entry.transcriptAnchors ?? {}),
                            endSeqInclusive,
                        },
                    }
                    : entry),
            }));
            activeTurn = null;
        },

        async failActiveTurn(paramsForFailure: Readonly<{
            endSeqInclusive: number | null;
            issue?: SessionRuntimeIssueV1 | null;
        }>): Promise<void> {
            await drainStartAnchorResolution();
            if (!activeTurn || activeTurn.kind !== 'tracked') {
                activeTurn = null;
                return;
            }
            const failedTurnId = activeTurn.turnId;
            const endSeqInclusive = normalizeSeq(paramsForFailure.endSeqInclusive);
            const lifecycle = params.session.sessionTurnLifecycle;
            applyLocalSessionTurnEvidenceMutation((current, timestamp) => buildSessionTurnEvidence({
                current,
                providerThreadId: params.getProviderThreadId(),
                updatedAt: timestamp,
                entries: current.entries.map((entry) => entry.turnId === failedTurnId && entry.status === 'in_progress'
                    ? {
                        ...entry,
                        status: 'failed',
                        terminalAt: timestamp,
                        updatedAt: timestamp,
                        transcriptAnchors: {
                            ...(entry.transcriptAnchors ?? {}),
                            endSeqInclusive,
                        },
                    }
                    : entry),
            }));
            if (lifecycle) {
                try {
                    await lifecycle.failTurn({
                        provider: CODEX_AGENT_ID,
                        ...(activeTurn.providerTurnId ? { providerTurnId: activeTurn.providerTurnId } : {}),
                        ...(paramsForFailure.issue ? { issue: paramsForFailure.issue } : {}),
                    });
                } catch (error) {
                    params.onMetadataWriteError?.(error);
                }
            }
            activeTurn = null;
        },

        resolveRollbackPlan(target: SessionRollbackTarget): CodexAppServerRollbackPlan | null {
            return resolveCodexAppServerRollbackPlan({ target, sessionTurnEvidence: readRollbackPlanningEvidence() });
        },

        async markRolledBack(rollbackPlan: CodexAppServerRollbackPlan): Promise<void> {
            const rollbackTurnIds = sessionTurnEvidence.entries
                .filter((entry) => entry.status === 'completed' && readEntryEndSeq(entry) !== null)
                .slice(-rollbackPlan.numTurns)
                .map((entry) => entry.turnId);
            const fallbackTimestamp = now();
            const fallbackSessionTurnEvidence = buildRolledBackSessionTurnEvidence({
                current: sessionTurnEvidence,
                providerThreadId: params.getProviderThreadId(),
                updatedAt: fallbackTimestamp,
                numTurns: rollbackPlan.numTurns,
            });
            if (!fallbackSessionTurnEvidence) return;

            const lifecycle = params.session.sessionTurnLifecycle;
            if (lifecycle) {
                sessionTurnEvidence = fallbackSessionTurnEvidence;
                for (const turnId of rollbackTurnIds) {
                    await lifecycle.markRolledBack({ turnId, provider: CODEX_AGENT_ID });
                }
                return;
            }

            const nextSessionTurnEvidence = buildRolledBackSessionTurnEvidence({
                current: sessionTurnEvidence,
                providerThreadId: params.getProviderThreadId(),
                updatedAt: now(),
                numTurns: rollbackPlan.numTurns,
            });
            sessionTurnEvidence = nextSessionTurnEvidence ?? fallbackSessionTurnEvidence;
        },
    };
}
