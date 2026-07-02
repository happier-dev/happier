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
    opts: { localId: string; meta?: Record<string, unknown>; createdAt: number; updatedAt: number },
  ) => void | Promise<void>;
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
