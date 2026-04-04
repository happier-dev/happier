import { logger } from '@/ui/logger';

import type { ACPProvider } from '../sessionMessageTypes';
import type { StreamedTranscriptWriterSession } from './types';
import type { StreamedTranscriptSegmentRuntime, StreamedTranscriptSegmentState } from './segmentRuntime';
import {
  buildStreamedTranscriptSegmentSnapshotBody,
  buildStreamedTranscriptSegmentSnapshotMeta,
} from './buildStreamedTranscriptSegmentSnapshot';

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
  const durableLocalId = segment.segmentLocalId;
  const body = buildStreamedTranscriptSegmentSnapshotBody(segment);
  const meta = buildStreamedTranscriptSegmentSnapshotMeta({ segment, state, interruptedReason, nowMs });

  void session
    .sendAgentMessageCommitted(provider, body, { localId: durableLocalId, meta })
    .catch((error) => {
      logger.debug('[StreamedTranscriptWriter] Durable snapshot commit failed (non-fatal)', {
        error,
        localId: durableLocalId,
        segmentLocalId: segment.segmentLocalId,
        kind: segment.kind,
        sidechainId: segment.sidechainId,
      });

      if (typeof session.sendAgentMessage === 'function') {
        try {
          session.sendAgentMessage(provider, body, { localId: durableLocalId, meta });
        } catch (fallbackError) {
          logger.debug('[StreamedTranscriptWriter] Durable snapshot fallback commit failed (non-fatal)', {
            error: fallbackError,
            localId: durableLocalId,
            segmentLocalId: segment.segmentLocalId,
            kind: segment.kind,
            sidechainId: segment.sidechainId,
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

  segment.didWriteDurable = true;
  segment.lastDurableText = segment.accumulatedText;
  segment.lastCheckpointAtMs = nowMs;
  segment.lastCheckpointTextLen = segment.accumulatedText.length;
}
