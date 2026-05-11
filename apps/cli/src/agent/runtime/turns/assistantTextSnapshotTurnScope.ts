import { randomUUID } from 'node:crypto';

import type { TurnAssistantTextSnapshotStore } from '@/api/session/turns/assistantTextSnapshot';

export type AssistantTextSnapshotTurnSession = Readonly<{
  getLastObservedMessageSeq?: () => number;
  getTurnAssistantTextSnapshotStore?: () => TurnAssistantTextSnapshotStore;
}>;

export type AssistantTextSnapshotTurnScope = Readonly<{
  turnToken: string;
  startSeqExclusive: number | null;
}>;

function normalizeSeq(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

export function beginAssistantTextSnapshotTurnScope(
  session: AssistantTextSnapshotTurnSession,
): AssistantTextSnapshotTurnScope | null {
  const store = session.getTurnAssistantTextSnapshotStore?.();
  if (!store) return null;
  const turnToken = randomUUID();
  const startSeqExclusive = normalizeSeq(session.getLastObservedMessageSeq?.());
  store.beginTurn({
    turnToken,
    startSeqExclusive,
    startedAtMs: Date.now(),
  });
  return { turnToken, startSeqExclusive };
}

export function completeAssistantTextSnapshotTurnScope(
  session: AssistantTextSnapshotTurnSession,
  scope: AssistantTextSnapshotTurnScope | null,
): void {
  if (!scope) return;
  session.getTurnAssistantTextSnapshotStore?.()?.completeTurn({ turnToken: scope.turnToken });
}

export function resetAssistantTextSnapshotTurnScope(
  session: AssistantTextSnapshotTurnSession,
  reason: 'abort' | 'mode_change' | 'clear' | 'session_end',
): void {
  session.getTurnAssistantTextSnapshotStore?.()?.reset({ reason });
}
