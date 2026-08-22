import { logger } from '../../../ui/logger';
import { serializeAxiosErrorForLog } from '../../client/serializeAxiosErrorForLog';

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
  const commitVersion = segment.textVersion;
  const commitText = segment.accumulatedText;
  const commitTextLen = commitText.length;
  const durableLocalId = segment.segmentLocalId;
  const body = buildStreamedTranscriptSegmentSnapshotBody(segment);
  const meta = buildStreamedTranscriptSegmentSnapshotMeta({ segment, state, interruptedReason, nowMs });

  const markDurablyPersisted = () => {
    segment.didWriteDurable = true;
    segment.lastDurableText = commitText;
    segment.lastCheckpointAtMs = Date.now();
    segment.lastCheckpointTextLen = commitTextLen;
    segment.lastCommittedTextVersion = commitVersion;
    segment.lastCommittedState = state;
    segment.appendOnlySinceLastDurableSnapshot = true;
  };

  let committedSnapshotPromise: Promise<void>;
  try {
    if (typeof session.enqueueAgentMessageCommitted === 'function') {
      committedSnapshotPromise = session
        .enqueueAgentMessageCommitted(provider, body, {
          localId: durableLocalId,
          meta,
          provenance: {
            kind: 'non_dependent',
            source: segment.sidechainId ? 'sidechain' : 'external',
          },
        })
        .then((result) => {
          if (result.persisted) markDurablyPersisted();
        });
    } else {
      throw new Error('enqueueAgentMessageCommitted unavailable');
    }
  } catch (error) {
    committedSnapshotPromise = Promise.reject(error);
  }

  void committedSnapshotPromise
    .catch((error) => {
      segment.lastCommitFailedAtMs = Date.now();
      logger.debug('[StreamedTranscriptWriter] Durable snapshot commit failed (non-fatal)', {
        error: serializeAxiosErrorForLog(error),
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
