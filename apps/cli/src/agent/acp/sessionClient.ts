import type { TranscriptSessionPort } from '@/api/session/transcriptPort';
import type { Metadata } from '@/api/types';

/**
 * Minimal session client surface required by ACP runtimes + replay importers.
 *
 * This is intentionally a stable seam: ACP code should depend on this small interface
 * instead of the full `ApiSessionClient` concrete class to keep tests and adapters
 * lightweight and deterministic.
 */
export type AcpReplaySidechainSessionClient = Pick<TranscriptSessionPort, 'sendAgentMessageCommitted'>;

export type AcpReplayHistorySessionClient = AcpReplaySidechainSessionClient & Readonly<{
  sendUserTextMessageCommitted: (
    text: string,
    opts: { localId: string; meta?: Record<string, unknown> },
  ) => Promise<void>;
  updateMetadata: (handler: (metadata: Metadata) => Metadata) => Promise<void> | void;
  fetchRecentTranscriptTextItemsForAcpImport: (
    opts?: { take?: number },
  ) => Promise<Array<{ role: 'user' | 'agent'; text: string }>>;
}>;

export type AcpRuntimeSessionClient = AcpReplayHistorySessionClient & Readonly<{
  sessionId?: string;
  keepAlive: (thinking: boolean, mode: 'local' | 'remote') => void;
  sendAgentMessage: NonNullable<TranscriptSessionPort['sendAgentMessage']>;
  sendAgentMessageEphemeral?: TranscriptSessionPort['sendAgentMessageEphemeral'];
  sendAgentMessageEphemeralDelta?: TranscriptSessionPort['sendAgentMessageEphemeralDelta'];
  getEphemeralStreamConnectionEpoch?: TranscriptSessionPort['getEphemeralStreamConnectionEpoch'];
  sendAgentSessionMediaCommitted?: TranscriptSessionPort['sendAgentSessionMediaCommitted'];
}>;
