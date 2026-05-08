import {
    resolveSessionRollbackPlan,
    type CompletedConversationTurn,
    type SessionRollbackRpcParams,
    type SessionRollbackRpcResult,
} from '@happier-dev/protocol';

import type { ApiSessionClient } from '@/api/session/sessionClient';
import { logger } from '@/ui/logger';

import {
    captureCompletedTurnSeqRange,
    publishLatestTurnRollbackRangeMetadata,
    publishRollbackRangeMetadata,
    type CompletedTurnSeqRange,
} from './rollbackMetadata';
import { readRollbackUnsupportedErrorMessage } from './readCodexAppServerRpcFields';

export async function rollbackCodexAppServerConversation(params: Readonly<{
    threadId: string | null;
    pendingTurn: unknown;
    request: SessionRollbackRpcParams;
    completedTurnSeqRanges: CompletedTurnSeqRange[];
    ensureClient: () => Promise<Readonly<{
        request: (method: string, params: unknown) => Promise<unknown>;
    }>>;
    finishPendingTurn: (params?: Readonly<{ flushReason?: 'abort' }>) => Promise<void>;
    session: ApiSessionClient;
}>): Promise<SessionRollbackRpcResult> {
    const activeThreadId = params.threadId;
    if (!activeThreadId) {
        return {
            ok: false,
            errorCode: 'thread_not_started',
            errorMessage: 'Codex app-server rollback requires an active thread',
        };
    }
    if (params.pendingTurn) {
        return {
            ok: false,
            errorCode: 'turn_in_flight',
            errorMessage: 'Cannot roll back while a turn is still in flight',
        };
    }

    const target = params.request.target;
    const rollbackPlan = resolveSessionRollbackPlan({
        target,
        completedTurns: params.completedTurnSeqRanges as readonly CompletedConversationTurn[],
    });
    if (!rollbackPlan) {
        return {
            ok: false,
            errorCode: 'invalid_parameters',
            errorMessage: 'Rollback target is not available in the active conversation',
        };
    }

    const client = await params.ensureClient();
    try {
        await client.request('thread/rollback', {
            threadId: activeThreadId,
            numTurns: rollbackPlan.numTurns,
        });
    } catch (error) {
        const unsupportedMessage = readRollbackUnsupportedErrorMessage(error);
        if (unsupportedMessage) {
            return { ok: false, errorCode: 'unsupported_action', errorMessage: unsupportedMessage };
        }
        throw error;
    }
    await params.finishPendingTurn({ flushReason: 'abort' });

    params.completedTurnSeqRanges.splice(-rollbackPlan.numTurns, rollbackPlan.numTurns);
    const range = captureCompletedTurnSeqRange({
        userMessageSeq: rollbackPlan.targetUserMessageSeq,
        startSeqInclusive: rollbackPlan.range.startSeqInclusive,
        endSeqInclusive: rollbackPlan.range.endSeqInclusive,
    });
    if (range) {
        if (target.type === 'latest_turn') {
            await publishLatestTurnRollbackRangeMetadata({
                session: params.session,
                range,
            }).catch((error) => {
                logger.debug('[codex-app-server] Failed to publish rollback range metadata (non-fatal)', error);
            });
        } else {
            await publishRollbackRangeMetadata({
                session: params.session,
                target,
                range,
            }).catch((error) => {
                logger.debug('[codex-app-server] Failed to publish rollback range metadata (non-fatal)', error);
            });
        }
    }
    return { ok: true, target: params.request.target, threadId: activeThreadId };
}
