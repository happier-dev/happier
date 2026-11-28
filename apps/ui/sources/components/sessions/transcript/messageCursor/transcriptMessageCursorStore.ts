import * as React from 'react';

import type { KeyboardCommandId } from '@/keyboard/types';
import {
  areSessionAddressesEqual,
  type SessionAddress,
} from '@/sync/domains/session/sessionAddress';

import type { CommittedMessageActionId } from '../messageActions/useCommittedMessageActions';

/**
 * The keyboard message cursor (#1031): which committed user or agent message holds the transcript's keyboard
 * cursor, if any. One cursor exists at a time, as one keyboard focus does. Rows read it through
 * {@link useTranscriptMessageCursorFocused}, a primitive per-row snapshot, so a move renders the row it leaves
 * and the row it lands on, never the list.
 */
export type TranscriptMessageCursorTarget = Readonly<{
  sessionAddress: SessionAddress;
  messageId: string;
  routeMessageId: string;
}>;

/** Every committed action a key can run on the focused message; the row's ⋯ plugin menu is not one action. */
export type TranscriptMessageCursorActionId = Exclude<
  CommittedMessageActionId,
  'plugins'
>;

export const TRANSCRIPT_MESSAGE_CURSOR_ACTION_COMMANDS = {
  copy: 'transcript.message.copy',
  pin: 'transcript.message.pin',
  select: 'transcript.message.select',
  fork: 'transcript.message.fork',
  rollback: 'transcript.message.rollback',
  readAloud: 'transcript.message.readAloud',
  savePrompt: 'transcript.message.savePrompt',
  saveDecision: 'transcript.message.saveDecision',
  discuss: 'transcript.message.discuss',
  secondOpinion: 'transcript.message.secondOpinion',
  makeRepeatable: 'transcript.message.makeRepeatable',
} as const satisfies Record<TranscriptMessageCursorActionId, KeyboardCommandId>;

export type TranscriptMessageCursorAction = Readonly<{
  id: TranscriptMessageCursorActionId;
  commandId: KeyboardCommandId;
  title: string;
  run: () => void;
}>;

/** The focused row's admitted actions, published by the row itself (the one action owner). */
export type TranscriptMessageCursorActionRunner = Readonly<{
  list: () => readonly TranscriptMessageCursorAction[];
}>;

let target: TranscriptMessageCursorTarget | null = null;
let runner: Readonly<{
  messageId: string;
  value: TranscriptMessageCursorActionRunner;
}> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

export function subscribeTranscriptMessageCursor(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function readTranscriptMessageCursor(): TranscriptMessageCursorTarget | null {
  return target;
}

export function setTranscriptMessageCursor(
  next: TranscriptMessageCursorTarget,
): void {
  if (
    target &&
    target.messageId === next.messageId &&
    areSessionAddressesEqual(target.sessionAddress, next.sessionAddress)
  )
    return;
  target = next;
  if (runner && runner.messageId !== next.messageId) runner = null;
  notify();
}

export function clearTranscriptMessageCursor(
  sessionAddress?: SessionAddress,
): void {
  if (!target) return;
  if (
    sessionAddress &&
    !areSessionAddressesEqual(target.sessionAddress, sessionAddress)
  )
    return;
  target = null;
  runner = null;
  notify();
}

export function isTranscriptMessageCursorActiveFor(
  sessionAddress: SessionAddress | null,
): boolean {
  return (
    target !== null &&
    sessionAddress !== null &&
    areSessionAddressesEqual(target.sessionAddress, sessionAddress)
  );
}

/** The focused row registers its actions while it holds the cursor; a stale row's registration is ignored. */
export function registerTranscriptMessageCursorActions(
  messageId: string,
  value: TranscriptMessageCursorActionRunner,
): () => void {
  const entry = { messageId, value };
  if (target?.messageId === messageId) runner = entry;
  return () => {
    if (runner === entry) runner = null;
  };
}

export function readTranscriptMessageCursorActions(): readonly TranscriptMessageCursorAction[] {
  if (!target || runner?.messageId !== target.messageId) return [];
  return runner.value.list();
}

/** Runs one committed action on the focused message; false when that message does not offer it now. */
export function runTranscriptMessageCursorAction(
  id: TranscriptMessageCursorActionId,
): boolean {
  const action = readTranscriptMessageCursorActions().find(
    (candidate) => candidate.id === id,
  );
  if (!action) return false;
  action.run();
  return true;
}

/** Per-row: whether this row holds the cursor. A primitive snapshot, so only the two rows a move touches render. */
export function useTranscriptMessageCursorFocused(
  sessionAddress: SessionAddress | null,
  routeMessageId: string | null,
): boolean {
  const getSnapshot = React.useCallback(
    () =>
      target !== null &&
      routeMessageId !== null &&
      sessionAddress !== null &&
      target.routeMessageId === routeMessageId &&
      areSessionAddressesEqual(target.sessionAddress, sessionAddress),
    [sessionAddress, routeMessageId],
  );
  return React.useSyncExternalStore(
    subscribeTranscriptMessageCursor,
    getSnapshot,
    getSnapshot,
  );
}
