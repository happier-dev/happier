import type {
  TurnAssistantTextSnapshot,
  TurnAssistantTextSnapshotInput,
  TurnAssistantTextSnapshotSource,
  TurnAssistantTextSnapshotStore,
} from './assistantTextSnapshot';
import { DEFAULT_TURN_ASSISTANT_TEXT_SNAPSHOT_MAX_CHARS, normalizeAssistantTextSnapshotText } from './assistantTextSnapshot';

type ActiveTurn = Readonly<{
  turnToken: string;
  startSeqExclusive: number | null;
  startedAtMs: number;
  completedAtMs: number | null;
}>;

const SOURCE_PRIORITY: Record<TurnAssistantTextSnapshotSource, number> = {
  streaming: 1,
  ephemeral: 2,
  socket: 3,
  committed: 4,
};

function normalizeSeq(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

function normalizeTime(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : Date.now();
}

function normalizeNullableString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function shouldReplaceSnapshot(
  current: TurnAssistantTextSnapshot | null,
  next: TurnAssistantTextSnapshot,
): boolean {
  if (!current) return true;
  const currentPriority = SOURCE_PRIORITY[current.source];
  const nextPriority = SOURCE_PRIORITY[next.source];
  if (nextPriority !== currentPriority) return nextPriority > currentPriority;
  if (next.seq !== null && current.seq !== null && next.seq !== current.seq) return next.seq > current.seq;
  if (next.seq !== null && current.seq === null) return true;
  return next.observedAtMs >= current.observedAtMs;
}

export function createTurnAssistantTextSnapshotStore(params?: Readonly<{
  maxTextChars?: number;
}>): TurnAssistantTextSnapshotStore {
  const maxTextChars = params?.maxTextChars ?? DEFAULT_TURN_ASSISTANT_TEXT_SNAPSHOT_MAX_CHARS;
  let activeTurn: ActiveTurn | null = null;
  let activeSnapshot: TurnAssistantTextSnapshot | null = null;

  const resolveTurnToken = (input: TurnAssistantTextSnapshotInput): string | null => {
    const explicit = normalizeNullableString(input.turnToken);
    if (explicit) return explicit;
    if (!activeTurn) return null;
    if (normalizeSeq(input.seq) !== null) return activeTurn.turnToken;
    const localId = normalizeNullableString(input.localId);
    if (
      input.source === 'committed'
      && activeSnapshot
      && activeSnapshot.turnToken === activeTurn.turnToken
      && activeSnapshot.localId !== null
      && activeSnapshot.localId === localId
    ) {
      return activeTurn.turnToken;
    }
    return input.source === 'streaming' || input.source === 'ephemeral'
      ? activeTurn.turnToken
      : null;
  };

  return {
    beginTurn(input) {
      const turnToken = normalizeNullableString(input.turnToken);
      if (!turnToken) return;
      activeTurn = {
        turnToken,
        startSeqExclusive: normalizeSeq(input.startSeqExclusive),
        startedAtMs: normalizeTime(input.startedAtMs),
        completedAtMs: null,
      };
      activeSnapshot = null;
    },

    observe(input) {
      const turnToken = resolveTurnToken(input);
      if (!turnToken) return;
      if (!activeTurn || activeTurn.turnToken !== turnToken) return;

      const sidechainId = normalizeNullableString(input.sidechainId);
      if (sidechainId !== null) return;

      const normalizedText = normalizeAssistantTextSnapshotText(input.text, { maxTextChars });
      if (!normalizedText) return;

      const seq = normalizeSeq(input.seq);
      if (seq !== null && activeTurn.startSeqExclusive !== null && seq <= activeTurn.startSeqExclusive) {
        return;
      }

      const snapshot: TurnAssistantTextSnapshot = {
        text: normalizedText,
        normalizedText,
        observedAtMs: normalizeTime(input.observedAtMs),
        turnToken,
        startSeqExclusive: activeTurn.startSeqExclusive,
        seq,
        localId: normalizeNullableString(input.localId),
        sidechainId: null,
        provider: normalizeNullableString(input.provider),
        source: input.source,
      };

      if (shouldReplaceSnapshot(activeSnapshot, snapshot)) {
        activeSnapshot = snapshot;
      }
    },

    getCurrentTurnSnapshot(input) {
      if (!activeSnapshot) return null;
      const turnToken = normalizeNullableString(input?.turnToken);
      if (turnToken && activeSnapshot.turnToken !== turnToken) return null;
      return activeSnapshot;
    },

    getSnapshotAfter(input) {
      if (!activeSnapshot) return null;
      const turnToken = normalizeNullableString(input.turnToken);
      if (turnToken && activeSnapshot.turnToken !== turnToken) return null;
      const startSeqExclusive = normalizeSeq(input.startSeqExclusive);
      if (activeSnapshot.seq !== null && startSeqExclusive !== null && activeSnapshot.seq <= startSeqExclusive) {
        return null;
      }
      return activeSnapshot;
    },

    clearSnapshot(input) {
      if (!activeSnapshot) return;
      const turnToken = normalizeNullableString(input?.turnToken);
      if (turnToken && activeSnapshot.turnToken !== turnToken) return;
      activeSnapshot = null;
    },

    completeTurn(input) {
      const turnToken = normalizeNullableString(input.turnToken);
      if (!turnToken || activeTurn?.turnToken !== turnToken) return;
      activeTurn = { ...activeTurn, completedAtMs: Date.now() };
    },

    reset() {
      activeTurn = null;
      activeSnapshot = null;
    },
  };
}
