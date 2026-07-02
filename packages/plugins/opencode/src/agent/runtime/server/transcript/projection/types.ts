export type OpenCodeTranscriptProjectionContext =
  | 'live_transcript'
  | 'history_import'
  | 'direct_transcript';

export type OpenCodeMessageProjectionKind =
  | 'user_transcript'
  | 'assistant_transcript'
  | 'compaction_internal'
  | 'ignored_internal'
  | 'unknown';

export type OpenCodeTranscriptRole = 'user' | 'assistant';

export type OpenCodeMessageProjection = Readonly<{
  kind: OpenCodeMessageProjectionKind;
  role: OpenCodeTranscriptRole | null;
  messageId: string;
  createdAtMs: number;
  info: Record<string, unknown> | null;
}>;

export type OpenCodePartProjectionKind =
  | 'transcript_text'
  | 'reasoning_text'
  | 'ignored_internal'
  | 'non_transcript';

export type OpenCodePartProjection = Readonly<{
  kind: OpenCodePartProjectionKind;
  text: string;
  partType: string;
}>;

export type OpenCodeAssistantCompletionKind =
  | 'terminal_success'
  | 'continuation'
  | 'ignored_internal'
  | 'non_terminal';

export type OpenCodeAssistantCompletion = Readonly<{
  kind: OpenCodeAssistantCompletionKind;
  messageId: string;
  completedAtMs: number | null;
  finish: string | null;
}>;
