import type { ACPMessageData, ACPProvider } from './sessionMessageTypes';
import type { TurnAssistantTextSnapshotStore } from './turns/assistantTextSnapshot';
import type { SendAgentSessionMediaCommittedRequest } from './client/transcript/sessionMediaBridge';

export type TranscriptSessionPort = Readonly<{
  turnAssistantTextSnapshotStore?: TurnAssistantTextSnapshotStore;
  sendAgentMessage?: (
    provider: ACPProvider,
    body: ACPMessageData,
    opts?: { localId?: string; meta?: Record<string, unknown> },
  ) => void;
  sendAgentMessageEphemeral?: (
    provider: ACPProvider,
    body: ACPMessageData,
    opts: {
      localId: string;
      meta?: Record<string, unknown>;
      createdAt: number;
      updatedAt?: number;
      /** Live-stream tick this full snapshot corresponds to (delta-chaining checkpoint anchor). */
      tick?: number;
    },
  ) => void | Promise<void>;
  /**
   * Emit a live delta tick: `body` carries ONLY the text appended since the previous live emission
   * for this segment. Sessions that do not implement this receive full snapshots on every live
   * emission (the pre-delta behavior); the streamed transcript writer only emits deltas when this
   * method exists.
   */
  sendAgentMessageEphemeralDelta?: (
    provider: ACPProvider,
    body: ACPMessageData,
    opts: {
      localId: string;
      tick: number;
      baseLength: number;
      createdAt: number;
      updatedAt?: number;
      meta?: Record<string, unknown>;
    },
  ) => void | Promise<void>;
  /**
   * Monotonic counter that increases whenever the underlying live transport (re)connects. The
   * streamed transcript writer emits a full snapshot after an epoch change so receivers resync
   * after reconnects.
   */
  getEphemeralStreamConnectionEpoch?: () => number;
  enqueueAgentMessageCommitted?: (
    provider: ACPProvider,
    body: ACPMessageData,
    opts: { localId: string; meta?: Record<string, unknown> },
  ) => Promise<Readonly<{ persisted: boolean; delivered: boolean }>>;
  sendAgentMessageCommitted: (
    provider: ACPProvider,
    body: ACPMessageData,
    opts: { localId: string; meta?: Record<string, unknown> },
  ) => Promise<void>;
  sendAgentSessionMediaCommitted?: (
    provider: ACPProvider,
    request: SendAgentSessionMediaCommittedRequest,
  ) => Promise<void>;
}>;
