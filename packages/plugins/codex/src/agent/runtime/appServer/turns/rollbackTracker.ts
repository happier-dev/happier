import type {
    CodexAppServerEvent,
    CodexAppServerRollbackTarget,
    CodexAppServerSessionTurn,
} from '../core.js';

import {
    resolveCodexAppServerRollbackPlanFromSessionTurns,
    type CodexAppServerRollbackPlan,
} from './rollbackPlan.js';

const MAX_RETAINED_USER_MESSAGE_SEQS_PER_TURN = 50;

type SessionTurnRollbackTrackerSession = Readonly<{
    getCommittedUserMessageSeq?: (localId: string) => number | null;
}>;

type TurnBoundary = Readonly<{
    startUserMessageSeq: number;
    startSeqInclusive: number;
    endSeqInclusive: number;
}>;

function readTrimmedString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normalizeSeq(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
}

function appendBoundedUserMessageSeq(
    seqs: readonly number[],
    seq: number,
): number[] {
    const uniqueSeqs = seqs.includes(seq) ? [...seqs] : [...seqs, seq];
    if (uniqueSeqs.length <= MAX_RETAINED_USER_MESSAGE_SEQS_PER_TURN) {
        return uniqueSeqs;
    }

    const [startSeq, ...steerSeqs] = uniqueSeqs;
    if (typeof startSeq !== 'number') {
        return uniqueSeqs.slice(-MAX_RETAINED_USER_MESSAGE_SEQS_PER_TURN);
    }
    return [
        startSeq,
        ...steerSeqs.slice(-(MAX_RETAINED_USER_MESSAGE_SEQS_PER_TURN - 1)),
    ];
}

function createDraftTurn(turnId: string, now: number): CodexAppServerSessionTurn {
    return {
        turnId,
        status: 'in_progress',
        startedAt: now,
        updatedAt: now,
    };
}

function mergeTranscriptAnchors(
    current: CodexAppServerSessionTurn['transcriptAnchors'],
    next: NonNullable<CodexAppServerSessionTurn['transcriptAnchors']>,
): CodexAppServerSessionTurn['transcriptAnchors'] {
    const currentUserSeqs = current?.userMessageSeqs ?? [];
    return {
        ...current,
        ...next,
        ...(next.userMessageSeqs
            ? {
                userMessageSeqs: next.userMessageSeqs.reduce(
                    (seqs, seq) => appendBoundedUserMessageSeq(seqs, seq),
                    currentUserSeqs,
                ),
            }
            : {}),
    };
}

export function createCodexAppServerSessionTurnRollbackTracker(params: Readonly<{
    session: SessionTurnRollbackTrackerSession;
    now?: () => number;
}>) {
    const now = params.now ?? Date.now;
    let turns: CodexAppServerSessionTurn[] = [];

    const upsertTurn = (
        turnId: string,
        update: (turn: CodexAppServerSessionTurn) => CodexAppServerSessionTurn,
    ): void => {
        const existingIndex = turns.findIndex((turn) => turn.turnId === turnId);
        const current = existingIndex >= 0 ? turns[existingIndex] : createDraftTurn(turnId, now());
        const next = update(current);
        turns = existingIndex >= 0
            ? turns.map((turn, index) => index === existingIndex ? next : turn)
            : [...turns, next];
    };

    const hydrateTurn = (turn: CodexAppServerSessionTurn): void => {
        const turnId = readTrimmedString(turn.turnId);
        if (!turnId) return;
        const existingIndex = turns.findIndex((candidate) => candidate.turnId === turnId);
        if (existingIndex < 0) {
            turns = [...turns, turn];
            return;
        }
        if (turns[existingIndex]!.updatedAt <= turn.updatedAt) {
            turns = turns.map((candidate, index) => index === existingIndex ? turn : candidate);
        }
    };

    const resolveCommittedUserMessageSeq = async (localId: string | null | undefined): Promise<number | null> => {
        const trimmedLocalId = readTrimmedString(localId);
        if (!trimmedLocalId) return null;
        return normalizeSeq(params.session.getCommittedUserMessageSeq?.(trimmedLocalId) ?? null);
    };

    const readBoundary = (turnId: string, endSeqInclusive: number | null): TurnBoundary | null => {
        const endSeq = normalizeSeq(endSeqInclusive);
        if (endSeq === null) return null;
        const turn = turns.find((candidate) => candidate.turnId === turnId);
        const startUserMessageSeq = normalizeSeq(turn?.transcriptAnchors?.startUserMessageSeq);
        if (startUserMessageSeq === null) return null;
        return {
            startUserMessageSeq,
            startSeqInclusive: normalizeSeq(turn?.transcriptAnchors?.startSeqInclusive) ?? startUserMessageSeq,
            endSeqInclusive: endSeq,
        };
    };

    return {
        async recordTurnStartAnchors(turn: Readonly<{
            sessionTurnId: string;
            startUserMessageLocalId?: string | null;
            startSeqInclusive: number | null;
        }>): Promise<void> {
            const startUserMessageSeq = await resolveCommittedUserMessageSeq(turn.startUserMessageLocalId);
            if (startUserMessageSeq === null) return;
            const startSeqInclusive = normalizeSeq(turn.startSeqInclusive) ?? startUserMessageSeq;
            upsertTurn(turn.sessionTurnId, (current) => ({
                ...current,
                transcriptAnchors: mergeTranscriptAnchors(current.transcriptAnchors, {
                    startUserMessageSeq,
                    userMessageSeqs: [startUserMessageSeq],
                    startSeqInclusive,
                }),
                updatedAt: now(),
            }));
        },

        async recordInputAppend(input: Readonly<{
            sessionTurnId: string;
            localId?: string | null;
        }>): Promise<number | null> {
            const userMessageSeq = await resolveCommittedUserMessageSeq(input.localId);
            if (userMessageSeq === null) return null;
            upsertTurn(input.sessionTurnId, (current) => ({
                ...current,
                transcriptAnchors: mergeTranscriptAnchors(current.transcriptAnchors, {
                    userMessageSeqs: [userMessageSeq],
                }),
                updatedAt: now(),
            }));
            return userMessageSeq;
        },

        completeTurnBoundary(completion: Readonly<{
            sessionTurnId: string;
            endSeqInclusive: number | null;
        }>): TurnBoundary | null {
            return readBoundary(completion.sessionTurnId, completion.endSeqInclusive);
        },

        resolveRollbackPlan(target: CodexAppServerRollbackTarget): CodexAppServerRollbackPlan | null {
            return resolveCodexAppServerRollbackPlanFromSessionTurns({ target, turns });
        },

        hydrateFromSessionTurns(sessionTurns: readonly CodexAppServerSessionTurn[]): void {
            for (const turn of sessionTurns) {
                hydrateTurn(turn);
            }
        },

        observeRuntimeEvent(event: CodexAppServerEvent): void {
            const eventTurnId = 'turnId' in event && typeof event.turnId === 'string' ? event.turnId : null;
            if (eventTurnId) {
                upsertTurn(eventTurnId, (current) => {
                    const timestamp = event.emittedAtMs;
                    if (event.kind === 'turn-start') {
                        return {
                            ...current,
                            agentId: 'codex',
                            ...(event.agentTurnId ? { agentTurnId: event.agentTurnId } : {}),
                            status: 'in_progress',
                            startedAt: current.startedAt || timestamp,
                            updatedAt: timestamp,
                        };
                    }
                    if (event.kind === 'turn-agent-id-observed') {
                        return {
                            ...current,
                            agentTurnId: event.agentTurnId,
                            updatedAt: timestamp,
                        };
                    }
                    if (event.kind === 'turn-input-appended') {
                        return {
                            ...current,
                            ...(event.agentTurnId ? { agentTurnId: event.agentTurnId } : {}),
                            transcriptAnchors: typeof event.userMessageSeq === 'number'
                                ? mergeTranscriptAnchors(current.transcriptAnchors, {
                                    userMessageSeqs: [event.userMessageSeq],
                                })
                                : current.transcriptAnchors,
                            updatedAt: timestamp,
                        };
                    }
                    if (event.kind === 'turn-complete') {
                        return {
                            ...current,
                            ...(event.agentTurnId ? { agentTurnId: event.agentTurnId } : {}),
                            status: 'completed',
                            terminalAt: timestamp,
                            updatedAt: timestamp,
                        };
                    }
                    if (event.kind === 'turn-failed') {
                        return {
                            ...current,
                            ...(event.agentTurnId ? { agentTurnId: event.agentTurnId } : {}),
                            status: 'failed',
                            terminalAt: timestamp,
                            lastRuntimeIssue: event.issue,
                            updatedAt: timestamp,
                        };
                    }
                    if (event.kind === 'turn-cancelled') {
                        return {
                            ...current,
                            ...(event.agentTurnId ? { agentTurnId: event.agentTurnId } : {}),
                            status: 'cancelled',
                            terminalAt: timestamp,
                            updatedAt: timestamp,
                        };
                    }
                    if (event.kind === 'turn-rollback-boundary-observed') {
                        return {
                            ...current,
                            ...(event.agentTurnId ? { agentTurnId: event.agentTurnId } : {}),
                            transcriptAnchors: mergeTranscriptAnchors(current.transcriptAnchors, {
                                ...(typeof event.startUserMessageSeq === 'number'
                                    ? { startUserMessageSeq: event.startUserMessageSeq }
                                    : {}),
                                ...(typeof event.startSeqInclusive === 'number'
                                    ? { startSeqInclusive: event.startSeqInclusive }
                                    : {}),
                                ...(event.endSeqInclusive !== undefined
                                    ? { endSeqInclusive: event.endSeqInclusive }
                                    : {}),
                            }),
                            rollback: {
                                state: 'eligible',
                                ...(typeof event.agentRollbackOrdinal === 'number'
                                    ? { agentRollbackOrdinal: event.agentRollbackOrdinal }
                                    : {}),
                                ...(event.providerCheckpoint !== undefined
                                    ? { providerCheckpoint: event.providerCheckpoint }
                                    : {}),
                                updatedAt: timestamp,
                            },
                            updatedAt: timestamp,
                        };
                    }
                    if (event.kind === 'turn-rollback-applied') {
                        return {
                            ...current,
                            rollback: {
                                state: 'rolled_back',
                                ...(typeof event.agentRollbackOrdinal === 'number'
                                    ? { agentRollbackOrdinal: event.agentRollbackOrdinal }
                                    : {}),
                                updatedAt: timestamp,
                            },
                            updatedAt: timestamp,
                        };
                    }
                    return current;
                });
            }
        },
    };
}
