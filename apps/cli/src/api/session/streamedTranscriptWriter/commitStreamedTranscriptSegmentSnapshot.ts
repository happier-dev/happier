import { logger } from '../../../ui/logger';
import { serializeAxiosErrorForLog } from '../../client/serializeAxiosErrorForLog';

import type { ACPProvider } from '../sessionMessageTypes';
import type { StreamedTranscriptWriterSession } from './types';
import type { StreamedTranscriptSegmentRuntime, StreamedTranscriptSegmentState } from './segmentRuntime';
import type { CommittedTranscriptAdmission } from '../transcriptPort';
import {
  buildStreamedTranscriptSegmentDeltaBody,
  buildStreamedTranscriptSegmentSnapshotBody,
  buildStreamedTranscriptSegmentSnapshotMeta,
} from './buildStreamedTranscriptSegmentSnapshot';

export function commitStreamedTranscriptSegmentSnapshot(params: {
  provider: ACPProvider;
  session: StreamedTranscriptWriterSession;
  segment: StreamedTranscriptSegmentRuntime;
  state: StreamedTranscriptSegmentState;
  interruptedReason?: string;
  failureRetryDelayMs?: number;
  onStreamingCommitFailure?: () => void;
  admission?: CommittedTranscriptAdmission;
  runtimeTurnId?: string;
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
  const meta = {
    ...buildStreamedTranscriptSegmentSnapshotMeta({ segment, state, interruptedReason, nowMs }),
    ...(params.runtimeTurnId ? { runtimeTurnId: params.runtimeTurnId } : {}),
  };
  // The source timestamp Home stores for this commit (see enqueueAgentMessageCommitted).
  const commitSourceUpdatedAtMs = Math.max(segment.startedAtMs, nowMs);
  // Home holds the last acknowledged commit and the text has only grown since: name that base
  // and carry just the appended text for live consumers. Home still stores the full body.
  const baseUpdatedAt = segment.lastCommittedSourceUpdatedAtMs;
  const append = segment.didWriteDurable
    && segment.lastCommittedDelivered
    && segment.appendOnlySinceLastDurableSnapshot
    && baseUpdatedAt !== undefined
    // A rewrite racing an in-flight commit can be lost from the append-only flag; the prefix
    // check (once per durable commit) keeps the named base exact.
    && commitText.startsWith(segment.lastDurableText)
    ? {
        body: buildStreamedTranscriptSegmentDeltaBody(segment, commitText.slice(segment.lastDurableText.length)),
        baseLength: segment.lastDurableText.length,
        baseUpdatedAt,
        length: commitTextLen,
      }
    : undefined;

  const markDurablyPersisted = (delivered: boolean, committedSequence?: number) => {
    segment.didWriteDurable = true;
    segment.lastDurableText = commitText;
    segment.lastCheckpointAtMs = Date.now();
    segment.lastCheckpointTextLen = commitTextLen;
    segment.lastCommittedTextVersion = commitVersion;
    segment.lastCommittedState = state;
    segment.lastCommittedDelivered = delivered;
    segment.lastCommittedSequence = delivered ? committedSequence : undefined;
    segment.lastCommittedSourceUpdatedAtMs = delivered ? commitSourceUpdatedAtMs : undefined;
    segment.appendOnlySinceLastDurableSnapshot = true;
    segment.durableRetryNotBeforeMs = 0;
    const recovered = segment.durableCommitFailure;
    segment.durableCommitFailure = null;
    if (recovered) {
      logger.debug('[StreamedTranscriptWriter] Durable snapshot commit recovered', {
        failureCount: recovered.count,
        suppressedFailureCount: recovered.suppressedCount,
        firstError: recovered.firstError,
        localId: durableLocalId,
        kind: segment.kind,
        sidechainId: segment.sidechainId,
      });
    }
  };

  let committedSnapshotPromise: Promise<void>;
  try {
    if (typeof session.enqueueAgentMessageCommitted === 'function') {
      committedSnapshotPromise = session
        .enqueueAgentMessageCommitted(provider, body, {
          localId: durableLocalId,
          meta,
          ...(append ? { append } : {}),
          ...(params.admission ? { admission: params.admission } : {}),
          provenance: {
            kind: 'non_dependent',
            source: segment.sidechainId ? 'sidechain' : 'external',
          },
        })
        .then((result) => {
          if (result.persisted && (!params.admission?.requireDelivery || result.delivered)) {
            markDurablyPersisted(result.delivered, result.committedSequence);
          }
        });
    } else {
      throw new Error('enqueueAgentMessageCommitted unavailable');
    }
  } catch (error) {
    committedSnapshotPromise = Promise.reject(error);
  }

  let commitFailed = false;
  void committedSnapshotPromise
    .catch((error) => {
      commitFailed = true;
      segment.lastCommitFailedAtMs = Date.now();
      if (state === 'streaming' && params.failureRetryDelayMs !== undefined) {
        segment.durableRetryNotBeforeMs = Date.now() + params.failureRetryDelayMs;
      }
      const serializedError = serializeAxiosErrorForLog(error);
      const failure = segment.durableCommitFailure;
      if (failure) {
        failure.count += 1;
        failure.suppressedCount += 1;
        return;
      }
      segment.durableCommitFailure = {
        firstError: serializedError,
        count: 1,
        suppressedCount: 0,
      };
      logger.debug('[StreamedTranscriptWriter] Durable snapshot commit failed (non-fatal)', {
        error: serializedError,
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
      if (pendingCommit && (!commitFailed || pendingCommit.state !== 'streaming')) {
        commitStreamedTranscriptSegmentSnapshot({
          provider,
          session,
          segment,
          state: pendingCommit.state,
          interruptedReason: pendingCommit.interruptedReason,
          failureRetryDelayMs: params.failureRetryDelayMs,
          onStreamingCommitFailure: params.onStreamingCommitFailure,
          admission: params.admission,
          runtimeTurnId: params.runtimeTurnId,
        });
        return;
      }
      if (commitFailed && state === 'streaming') {
        params.onStreamingCommitFailure?.();
      }
      if (segment.idleWaiters.length === 0) return;
      const waiters = segment.idleWaiters.splice(0, segment.idleWaiters.length);
      for (const waiter of waiters) {
        waiter();
      }
    });
}
