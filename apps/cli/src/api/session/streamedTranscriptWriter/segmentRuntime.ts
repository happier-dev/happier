import type { StreamedTranscriptSegmentKey, StreamedTranscriptSegmentKind } from './segmentKey';

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
  didWriteLive: boolean;
  lastDurableText: string;
  lastCheckpointAtMs: number;
  lastCheckpointTextLen: number;
  lastCommittedTextVersion: number;
  lastCommittedState: StreamedTranscriptSegmentState | null;
  lastCommitFailedAtMs: number;
  lastLiveSnapshotAtMs: number;
  lastLiveSnapshotTextLen: number;
  lastLiveSnapshotText: string;
  durableCheckpointTimer: ReturnType<typeof setTimeout> | null;
  liveSnapshotTimer: ReturnType<typeof setTimeout> | null;
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
