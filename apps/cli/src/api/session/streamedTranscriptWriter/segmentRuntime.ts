import type { StreamedTranscriptSegmentKey, StreamedTranscriptSegmentKind } from './segmentKey';
import type { LiveDeliveryState } from './liveDeliveryState';

export type StreamedTranscriptSegmentState = 'streaming' | 'complete' | 'interrupted';

export type StreamedTranscriptSegmentRuntime = {
  key: StreamedTranscriptSegmentKey;
  kind: StreamedTranscriptSegmentKind;
  sidechainId: string | null;
  segmentLocalId: string;
  startedAtMs: number;
  accumulatedText: string;
  textVersion: number;
  didWriteDurable: boolean;
  appendOnlySinceLastDurableSnapshot: boolean;
  lastDurableText: string;
  lastCheckpointAtMs: number;
  lastCheckpointTextLen: number;
  lastCommittedTextVersion: number;
  lastCommittedState: StreamedTranscriptSegmentState | null;
  lastCommitFailedAtMs: number;
  liveDelivery: LiveDeliveryState;
  durableCheckpointTimer: ReturnType<typeof setTimeout> | null;
  liveSnapshotTimer: ReturnType<typeof setTimeout> | null;
  isTerminalizing: boolean;
  isCommittingDurable: boolean;
  pendingDurableCommit: { state: StreamedTranscriptSegmentState; interruptedReason?: string } | null;
  idleWaiters: Array<() => void>;
};

export function waitForSegmentDrain(segment: StreamedTranscriptSegmentRuntime): Promise<void> {
  if (!segment.isCommittingDurable && !segment.pendingDurableCommit) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    segment.idleWaiters.push(resolve);
  });
}
