import type { StoredTranscriptRole } from '@/session/services/transcript/semanticTranscriptItem';

export type MemoryIndexableTranscriptRole = 'user' | 'assistant';

export type MemoryIndexableTranscriptKind =
  | 'user_message'
  | 'assistant_message'
  | 'reasoning'
  | 'tool_summary';

export type MemoryIndexableTranscriptItem = Readonly<{
  sessionId: string;
  id: string;
  seq: number;
  createdAtMs: number;
  role: MemoryIndexableTranscriptRole;
  kind: MemoryIndexableTranscriptKind;
  provider?: string;
  text: string;
  textChars: number;
  sourceStoredMessageRole?: StoredTranscriptRole;
}>;
