import type { StreamedTranscriptSegmentKey, StreamedTranscriptSegmentKind } from './segmentKey';

export type StreamedTranscriptSegmentState = 'streaming' | 'complete' | 'interrupted';

export type StreamedTranscriptSegmentRuntime = {
  key: StreamedTranscriptSegmentKey;
  kind: StreamedTranscriptSegmentKind;
  sidechainId: string | null;
  segmentLocalId: string;
  startedAtMs: number;
  accumulatedText: string;
  didWriteDurable: boolean;
  didWriteLive: boolean;
  lastCheckpointAtMs: number;
  lastCheckpointTextLen: number;
  lastLiveSnapshotAtMs: number;
  lastLiveSnapshotTextLen: number;
  lastLiveSnapshotText: string;
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
