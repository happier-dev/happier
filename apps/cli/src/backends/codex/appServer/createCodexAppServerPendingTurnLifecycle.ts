import { randomUUID } from 'node:crypto';

import type { ApiSessionClient } from '@/api/session/sessionClient';
import { configuration } from '@/configuration';

import {
    formatCodexAppServerErrorForUi,
    readThreadId,
    readTurnId,
} from './readCodexAppServerRpcFields';
import {
    captureCompletedTurnSeqRange,
    type CompletedTurnSeqRange,
} from './rollbackMetadata';

export type CodexAppServerPendingTurn = Readonly<{
    threadId: string;
    turnId: string | null;
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: Error) => void;
}>;

export type CodexAppServerStreamUpdateContext = Readonly<{
    sidechainId: string | null;
    streamScopeId: string;
}>;

export function createCodexAppServerPendingTurnLifecycle(params: Readonly<{
    session: ApiSessionClient;
    completedTurnSeqRanges: CompletedTurnSeqRange[];
    assistantReasoningProjector: Readonly<{
        flush: (reason: 'turn-end' | 'abort') => Promise<void>;
    }>;
    turnDiffProjector: Readonly<{
        emitCompletedTurn: (params: Readonly<{
            threadId: string;
            turnId: string;
            completedTurnStartSeqInclusive: number;
        }>) => void;
        beginTurn: () => void;
    }>;
    runBridgeWork: <T>(work: () => Promise<T>) => Promise<T>;
    setThinking: (thinking: boolean) => void;
    setTurnInFlight: (inFlight: boolean) => void;
    readLastObservedMessageSeq: () => number;
    readLastObservedUserMessageSeq: () => number;
    getPendingTurn: () => CodexAppServerPendingTurn | null;
    setPendingTurn: (turn: CodexAppServerPendingTurn | null) => void;
    getLatestPendingTurnId: () => string | null;
    setLatestPendingTurnId: (turnId: string | null) => void;
    getPendingTurnStartSeqInclusive: () => number | null;
    setPendingTurnStartSeqInclusive: (value: number | null) => void;
    getPendingTurnFinalizationTimer: () => ReturnType<typeof setTimeout> | null;
    setPendingTurnFinalizationTimer: (timer: ReturnType<typeof setTimeout> | null) => void;
    getScheduledPendingTurnFlushReason: () => 'turn-end' | 'abort' | null;
    setScheduledPendingTurnFlushReason: (reason: 'turn-end' | 'abort' | null) => void;
}>): Readonly<{
    finishPendingTurn: (options?: Readonly<{
        error?: Error;
        flushReason?: 'turn-end' | 'abort';
        insideBridgeWork?: boolean;
    }>) => Promise<void>;
    schedulePendingTurnFinalization: (flushReason: 'turn-end' | 'abort') => void;
    abortPendingTurnWithFailure: (failure: Error) => Promise<void>;
    notificationMatchesPendingTurn: (notificationParams: unknown) => boolean;
    resolveStreamUpdateContext: (notificationParams: unknown) => CodexAppServerStreamUpdateContext | null;
}> {
    const finishPendingTurn = async (options?: Readonly<{
        error?: Error;
        flushReason?: 'turn-end' | 'abort';
        insideBridgeWork?: boolean;
    }>): Promise<void> => {
        const pendingTurnFinalizationTimer = params.getPendingTurnFinalizationTimer();
        if (pendingTurnFinalizationTimer) {
            clearTimeout(pendingTurnFinalizationTimer);
            params.setPendingTurnFinalizationTimer(null);
        }
        params.setScheduledPendingTurnFlushReason(null);
        const activeTurn = params.getPendingTurn();
        const completedTurnStartSeqInclusive = params.getPendingTurnStartSeqInclusive();
        params.setPendingTurn(null);
        params.setPendingTurnStartSeqInclusive(null);
        params.setTurnInFlight(false);
        params.setThinking(false);
        if (options?.flushReason) {
            if (options.insideBridgeWork === true) {
                await params.assistantReasoningProjector.flush(options.flushReason);
            } else {
                await params.runBridgeWork(async () => {
                    await params.assistantReasoningProjector.flush(options.flushReason!);
                });
            }
        }
        if (options?.flushReason === 'turn-end' && activeTurn) {
            params.turnDiffProjector.emitCompletedTurn({
                threadId: activeTurn.threadId,
                turnId: activeTurn.turnId ?? params.getLatestPendingTurnId() ?? `codex-app-server-turn-${Date.now()}`,
                completedTurnStartSeqInclusive: completedTurnStartSeqInclusive ?? 0,
            });
        } else {
            params.turnDiffProjector.beginTurn();
        }
        params.setLatestPendingTurnId(null);
        if (options?.flushReason === 'turn-end' && completedTurnStartSeqInclusive !== null) {
            const completedTurnUserMessageSeq = params.readLastObservedUserMessageSeq();
            const completedTurnSeqRange = captureCompletedTurnSeqRange({
                userMessageSeq: completedTurnUserMessageSeq > 0 ? completedTurnUserMessageSeq : completedTurnStartSeqInclusive,
                startSeqInclusive: completedTurnStartSeqInclusive,
                endSeqInclusive: params.readLastObservedMessageSeq(),
            });
            if (completedTurnSeqRange) {
                params.completedTurnSeqRanges.push(completedTurnSeqRange);
            }
        }
        if (!activeTurn) return;
        if (options?.error) {
            activeTurn.reject(options.error);
            return;
        }
        activeTurn.resolve();
    };

    const schedulePendingTurnFinalization = (flushReason: 'turn-end' | 'abort'): void => {
        if (!params.getPendingTurn()) return;
        params.setScheduledPendingTurnFlushReason(
            params.getScheduledPendingTurnFlushReason() === 'abort' || flushReason === 'abort'
                ? 'abort'
                : 'turn-end',
        );
        if (params.getPendingTurnFinalizationTimer()) {
            return;
        }
        const pendingTurnFinalizationTimer = setTimeout(() => {
            params.setPendingTurnFinalizationTimer(null);
            const nextFlushReason = params.getScheduledPendingTurnFlushReason() ?? flushReason;
            params.setScheduledPendingTurnFlushReason(null);
            void params.runBridgeWork(async () => {
                if (!params.getPendingTurn()) return;
                await finishPendingTurn({
                    flushReason: nextFlushReason,
                    insideBridgeWork: true,
                });
            });
        }, configuration.codexAppServerTurnCompletionSettleMs);
        pendingTurnFinalizationTimer.unref?.();
        params.setPendingTurnFinalizationTimer(pendingTurnFinalizationTimer);
    };

    const abortPendingTurnWithFailure = async (failure: Error): Promise<void> => {
        params.session.sendCodexMessage({
            type: 'message',
            message: formatCodexAppServerErrorForUi(failure),
        });
        params.session.sendCodexMessage({
            type: 'turn_aborted',
            id: randomUUID(),
        });
        await finishPendingTurn({
            error: failure,
            flushReason: 'abort',
            insideBridgeWork: true,
        });
    };

    const notificationMatchesPendingTurn = (notificationParams: unknown): boolean => {
        const activeTurn = params.getPendingTurn();
        if (!activeTurn) return false;
        const notificationThreadId = readThreadId(notificationParams);
        if (notificationThreadId && notificationThreadId !== activeTurn.threadId) {
            return false;
        }
        const notificationTurnId = readTurnId(notificationParams);
        return !notificationTurnId || !activeTurn.turnId || notificationTurnId === activeTurn.turnId;
    };

    const resolveStreamUpdateContext = (notificationParams: unknown): CodexAppServerStreamUpdateContext | null => {
        const activeTurn = params.getPendingTurn();
        if (!activeTurn) return null;
        const notificationThreadId = readThreadId(notificationParams);
        if (notificationThreadId && notificationThreadId !== activeTurn.threadId) {
            return {
                sidechainId: notificationThreadId,
                streamScopeId: notificationThreadId,
            };
        }
        return {
            sidechainId: null,
            streamScopeId: activeTurn.threadId,
        };
    };

    return {
        finishPendingTurn,
        schedulePendingTurnFinalization,
        abortPendingTurnWithFailure,
        notificationMatchesPendingTurn,
        resolveStreamUpdateContext,
    };
}
