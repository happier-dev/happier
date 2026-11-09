import * as React from 'react';
import type { Message } from '@happier-dev/session-core/messages';

import { filterVisibleContextCompactionLifecycleMessageIds } from './contextCompactionLifecycleProjection';
import {
  isRuntimeIssueMessageMeta,
  readRuntimeIssueMessageMeta,
} from './runtimeIssueMessage';

export type TranscriptRuntimeIssueRepeatCountByMessageId = Readonly<
  Record<string, number>
>;

const EMPTY_REPEAT_COUNTS: TranscriptRuntimeIssueRepeatCountByMessageId =
  Object.freeze({});

/** Two failure rows repeat each other when they say the same thing for the same typed cause. */
function readRuntimeIssueRepeatKey(
  message: Message | undefined,
): string | null {
  if (
    message?.kind !== 'agent-text' ||
    message.isThinking === true ||
    !isRuntimeIssueMessageMeta(message.meta)
  )
    return null;
  const issue = readRuntimeIssueMessageMeta(message.meta);
  return JSON.stringify([
    issue?.code ?? message.meta?.runtimeIssueCode ?? null,
    issue?.source ?? null,
    message.text,
  ]);
}

/**
 * A run of identical runtime failure rows with nothing visible between them (a Session that failed the
 * same way turn after turn) reads as one row: the latest, carrying the run's size. The persisted rows
 * are untouched; only which of them is drawn is decided here.
 */
function collectRuntimeIssueRepeatRuns(
  visibleMessageIdsOldestFirst: readonly string[],
  messagesById: Readonly<Record<string, Message>>,
): Readonly<{
  hidden: ReadonlySet<string>;
  counts: TranscriptRuntimeIssueRepeatCountByMessageId;
}> | null {
  let hidden: Set<string> | null = null;
  let counts: Record<string, number> | null = null;
  let previousKey: string | null = null;
  let previousId: string | null = null;
  let runLength = 0;
  for (const messageId of visibleMessageIdsOldestFirst) {
    const key = readRuntimeIssueRepeatKey(messagesById[messageId]);
    if (key !== null && key === previousKey && previousId !== null) {
      (hidden ??= new Set()).add(previousId);
      runLength += 1;
      counts ??= {};
      delete counts[previousId];
      counts[messageId] = runLength;
    } else {
      runLength = 1;
    }
    previousKey = key;
    previousId = messageId;
  }
  return hidden && counts ? { hidden, counts } : null;
}

/** The transcript's one row-visibility decision for committed messages, shared by linear and turn grouping. */
export function filterVisibleTranscriptMessageIds(
  messageIdsOldestFirst: readonly string[],
  messagesById: Readonly<Record<string, Message>>,
): string[] {
  const visible = filterVisibleContextCompactionLifecycleMessageIds(
    messageIdsOldestFirst,
    messagesById,
  );
  const runs = collectRuntimeIssueRepeatRuns(visible, messagesById);
  return runs
    ? visible.filter((messageId) => !runs.hidden.has(messageId))
    : visible;
}

/** How many identical failures the drawn row of each repeated run stands for (absent for a single failure). */
export function resolveTranscriptRuntimeIssueRepeatCountByMessageId(
  input: Readonly<{
    messageIdsOldestFirst: readonly string[];
    messagesById: Readonly<Record<string, Message>>;
  }>,
): TranscriptRuntimeIssueRepeatCountByMessageId {
  const visible = filterVisibleContextCompactionLifecycleMessageIds(
    input.messageIdsOldestFirst,
    input.messagesById,
  );
  return (
    collectRuntimeIssueRepeatRuns(visible, input.messagesById)?.counts ??
    EMPTY_REPEAT_COUNTS
  );
}

/** The transcript root's repeat counts, read only by failure rows. */
export const TranscriptRuntimeIssueRepeatCountsContext = React.createContext<TranscriptRuntimeIssueRepeatCountByMessageId>(EMPTY_REPEAT_COUNTS);

export function useTranscriptRuntimeIssueRepeatCount(messageId: string): number | null {
    const count = React.useContext(TranscriptRuntimeIssueRepeatCountsContext)[messageId];
    return typeof count === 'number' && count > 1 ? count : null;
}
