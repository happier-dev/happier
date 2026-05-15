import type { RawTranscriptRow } from '@/session/replay/fetchEncryptedTranscriptMessages';

export type TranscriptDirection = 'before' | 'after';
export type TranscriptScope = 'main' | 'sidechain' | 'all';
export type StoredTranscriptRole = 'user' | 'agent' | 'event' | 'unknown';
export type SemanticTranscriptRole = 'user' | 'assistant' | 'tool' | 'event' | 'reasoning' | 'unknown';
export type TranscriptMode = 'transcript' | 'events';

export type TranscriptRawRow = RawTranscriptRow & Readonly<{
  id?: unknown;
  messageRole?: unknown;
  sidechainId?: unknown;
}>;

export type SemanticTranscriptItem = Readonly<{
  id: string;
  seq?: number;
  createdAt: number;
  storedMessageRole?: StoredTranscriptRole;
  semanticRole: SemanticTranscriptRole;
  role: SemanticTranscriptRole;
  kind: string;
  provider?: string;
  text?: string;
  summary?: string;
  toolName?: string;
  callId?: string;
  raw?: unknown;
  truncated?: boolean;
  rawTruncated?: boolean;
}>;

export type SemanticTranscriptDiagnostics = Readonly<{
  rawRowsScanned: number;
  pagesFetched: number;
  scanLimitReached: boolean;
  payloadTruncations: number;
}>;
