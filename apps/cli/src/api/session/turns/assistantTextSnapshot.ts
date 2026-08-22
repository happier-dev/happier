export type TurnAssistantTextSnapshotSource =
  | 'streaming'
  | 'ephemeral'
  | 'committed'
  | 'socket';

export type TurnAssistantTextSnapshot = Readonly<{
  text: string;
  normalizedText: string;
  observedAtMs: number;
  turnToken: string;
  startSeqExclusive: number | null;
  seq: number | null;
  localId: string | null;
  sidechainId: string | null;
  provider: string | null;
  source: TurnAssistantTextSnapshotSource;
}>;

export type TurnAssistantTextSnapshotInput = Readonly<{
  text: unknown;
  turnToken?: string | null;
  seq?: number | null;
  localId?: string | null;
  sidechainId?: string | null;
  provider?: string | null;
  source: TurnAssistantTextSnapshotSource;
  observedAtMs?: number;
}>;

export interface TurnAssistantTextSnapshotStore {
  beginTurn(input: { turnToken: string; startSeqExclusive: number | null; startedAtMs: number }): void;
  observe(input: TurnAssistantTextSnapshotInput): void;
  clearSnapshot(input?: { turnToken?: string | null; reason: 'media_only_commit' | 'clear' }): void;
  getCurrentTurnSnapshot(input?: { turnToken?: string | null }): TurnAssistantTextSnapshot | null;
  getSnapshotAfter(input: { turnToken?: string | null; startSeqExclusive: number | null }): TurnAssistantTextSnapshot | null;
  completeTurn(input: { turnToken: string }): void;
  reset(input: { reason: 'abort' | 'mode_change' | 'clear' | 'session_end' }): void;
}

export const DEFAULT_TURN_ASSISTANT_TEXT_SNAPSHOT_MAX_CHARS = 500;

export function normalizeAssistantTextSnapshotText(
  value: unknown,
  params: Readonly<{ maxTextChars: number }>,
): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  const maxTextChars = Math.max(1, Math.trunc(params.maxTextChars));
  return normalized.length > maxTextChars ? normalized.slice(0, maxTextChars) : normalized;
}
