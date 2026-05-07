import { logger } from '@/ui/logger';

import type { ACPProvider } from '../sessionMessageTypes';
import type { StreamedTranscriptWriterSession } from './types';
import type { StreamedTranscriptSegmentRuntime, StreamedTranscriptSegmentState } from './segmentRuntime';
import {
  buildStreamedTranscriptSegmentSnapshotBody,
  buildStreamedTranscriptSegmentSnapshotMeta,
} from './buildStreamedTranscriptSegmentSnapshot';

function serializeCommitErrorForLog(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  if (error && typeof error === 'object') {
    const maybeError = error as Record<string, unknown>;
    return {
      name: typeof maybeError.name === 'string' ? maybeError.name : undefined,
      message: typeof maybeError.message === 'string' ? maybeError.message : String(error),
      code: typeof maybeError.code === 'string' ? maybeError.code : undefined,
    };
  }

  return { message: String(error) };
}

export function commitStreamedTranscriptSegmentSnapshot(params: {
  provider: ACPProvider;
  session: StreamedTranscriptWriterSession;
  segment: StreamedTranscriptSegmentRuntime;
  state: StreamedTranscriptSegmentState;
  interruptedReason?: string;
}) {
  const { provider, session, segment, state, interruptedReason } = params;

  if (segment.isCommittingDurable) {
    segment.pendingDurableCommit = { state, interruptedReason };
    return;
  }

  segment.isCommittingDurable = true;

  const nowMs = Date.now();
  const commitVersion = segment.textVersion;
  const commitText = segment.accumulatedText;
  const commitTextLen = segment.accumulatedText.length;
  const durableLocalId = segment.segmentLocalId;
  const body = buildStreamedTranscriptSegmentSnapshotBody(segment);
  const meta = buildStreamedTranscriptSegmentSnapshotMeta({ segment, state, interruptedReason, nowMs });

  let committedSnapshotPromise: Promise<void>;
  try {
    if (typeof session.sendAgentMessageCommitted !== 'function') {
      throw new Error('sendAgentMessageCommitted unavailable');
    }
    committedSnapshotPromise = session.sendAgentMessageCommitted(provider, body, { localId: durableLocalId, meta });
  } catch (error) {
    committedSnapshotPromise = Promise.reject(error);
  }

  void committedSnapshotPromise
    .then(() => {
      segment.didWriteDurable = true;
      segment.lastDurableText = commitText;
      segment.lastCheckpointAtMs = Date.now();
      segment.lastCheckpointTextLen = commitTextLen;
      segment.lastCommittedTextVersion = commitVersion;
      segment.lastCommittedState = state;
    })
    .catch(async (error) => {
      segment.lastCommitFailedAtMs = Date.now();
      logger.debug('[StreamedTranscriptWriter] Durable snapshot commit failed (non-fatal)', {
        error: serializeCommitErrorForLog(error),
        localId: durableLocalId,
        segmentLocalId: segment.segmentLocalId,
        kind: segment.kind,
        sidechainId: segment.sidechainId,
        state,
        textLength: commitTextLen,
        textVersion: commitVersion,
        lastCommittedTextVersion: segment.lastCommittedTextVersion,
        lastCommittedState: segment.lastCommittedState,
      });

      if (typeof session.sendAgentMessage === 'function') {
        try {
          await Promise.resolve(session.sendAgentMessage(provider, body, { localId: durableLocalId, meta }));
        } catch (fallbackError) {
          logger.debug('[StreamedTranscriptWriter] Durable snapshot fallback commit failed (non-fatal)', {
            error: serializeCommitErrorForLog(fallbackError),
            localId: durableLocalId,
            segmentLocalId: segment.segmentLocalId,
            kind: segment.kind,
            sidechainId: segment.sidechainId,
            state,
            textLength: commitTextLen,
            textVersion: commitVersion,
          });
        }
      }
    })
    .finally(() => {
      segment.isCommittingDurable = false;
      const pendingCommit = segment.pendingDurableCommit;
      segment.pendingDurableCommit = null;
      if (pendingCommit) {
        commitStreamedTranscriptSegmentSnapshot({
          provider,
          session,
          segment,
          state: pendingCommit.state,
          interruptedReason: pendingCommit.interruptedReason,
        });
        return;
      }
      if (segment.idleWaiters.length === 0) return;
      const waiters = segment.idleWaiters.splice(0, segment.idleWaiters.length);
      for (const waiter of waiters) {
        waiter();
      }
    });
}
