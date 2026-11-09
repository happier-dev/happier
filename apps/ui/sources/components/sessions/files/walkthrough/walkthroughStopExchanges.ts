import { readParticipantRecipientRoutingIdentityV1 } from '@happier-dev/protocol/messages/structured/participantMessageV1';
import { ExecutionRunInputTurnV1Schema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import {
  SCM_WALKTHROUGH_QUESTION_META_KEY_V1,
  ScmWalkthroughQuestionMetaV1Schema,
} from '@happier-dev/protocol/sessions/messages/sessionMessageMeta';
import { readMessageDisplayText, type Message } from '@happier-dev/session-core/messages';

/** One question asked about a stop and the generator's reply to it, read from the run's transcript (lab WT3-D1). */
export type WalkthroughStopExchange = Readonly<{
  id: string;
  question: string;
  askedAtMs: number;
  /** Absent while the generator has not answered that exact turn yet. */
  answer: string | null;
  answeredAtMs: number | null;
}>;

export type WalkthroughStopExchanges = ReadonlyMap<
  string,
  readonly WalkthroughStopExchange[]
>;

export const NO_WALKTHROUGH_STOP_EXCHANGES: WalkthroughStopExchanges =
  new Map();

/**
 * The questions the person asked the generating run about this walkthrough's stops, each under the stop it was
 * asked about, with the run's reply to that exact turn. The transcript is the only source: a question names its
 * saved result and stops on its own row, and a reply names the inputs of its turn. A stop that no longer exists in
 * the current reading (merged or rewritten) quietly drops its exchanges; a stop whose lines moved keeps them.
 */
export function projectWalkthroughStopExchanges(
  params: Readonly<{
    runId: string;
    resultId: string;
    stopIds: ReadonlySet<string>;
    /** The Session's own rows, where a question to the run is committed. */
    messages: readonly Message[];
    /** The run's transcript rows, where its replies (and possibly the question) are committed. */
    runMessages: readonly Message[];
  }>,
): WalkthroughStopExchanges {
  const questions = new Map<
    string,
    Readonly<{ stopId: string; message: Message & { kind: 'user-text' } }>
  >();
  for (const message of [...params.messages, ...params.runMessages]) {
    if (
      message.kind !== 'user-text' ||
      !message.localId ||
      questions.has(message.localId)
    )
      continue;
    const asked = ScmWalkthroughQuestionMetaV1Schema.safeParse(
      message.meta?.[SCM_WALKTHROUGH_QUESTION_META_KEY_V1],
    );
    if (!asked.success || asked.data.resultId !== params.resultId) continue;
    const recipient = readParticipantRecipientRoutingIdentityV1(
      message.meta,
      'stored',
    );
    if (
      recipient &&
      (recipient.kind !== 'execution_run' || recipient.runId !== params.runId)
    )
      continue;
    const stopId = asked.data.stopIds.find((id: string) => params.stopIds.has(id));
    if (stopId) questions.set(message.localId, { stopId, message });
  }
  if (questions.size === 0) return NO_WALKTHROUGH_STOP_EXCHANGES;

  const replies = new Map<string, Message & { kind: 'agent-text' }>();
  for (const message of params.runMessages) {
    if (
      message.kind !== 'agent-text' ||
      message.isThinking ||
      !message.text.trim()
    )
      continue;
    const turn = ExecutionRunInputTurnV1Schema.safeParse(
      message.meta?.happierExecutionRunInputTurnV1,
    );
    if (!turn.success) continue;
    for (const inputId of turn.data.inputIds) {
      const previous = replies.get(inputId);
      // A turn can stream several text rows; its reply is the last one.
      if (
        questions.has(inputId) &&
        (!previous || previous.createdAt <= message.createdAt)
      )
        replies.set(inputId, message);
    }
  }

  const byStop = new Map<string, WalkthroughStopExchange[]>();
  for (const [localId, { stopId, message }] of [...questions].sort(
    (a, b) => a[1].message.createdAt - b[1].message.createdAt,
  )) {
    const reply = replies.get(localId);
    const list = byStop.get(stopId) ?? [];
    list.push({
      id: localId,
      question: readMessageDisplayText(message),
      askedAtMs: message.createdAt,
      answer: reply?.text ?? null,
      answeredAtMs: reply?.createdAt ?? null,
    });
    byStop.set(stopId, list);
  }
  return byStop;
}

/** Keeps the previous projection when nothing a reader sees changed, so unrelated transcript rows re-render nothing. */
export function sameWalkthroughStopExchanges(
  left: WalkthroughStopExchanges,
  right: WalkthroughStopExchanges,
): boolean {
  if (left === right) return true;
  if (left.size !== right.size) return false;
  for (const [stopId, exchanges] of left) {
    const other = right.get(stopId);
    if (!other || other.length !== exchanges.length) return false;
    for (let index = 0; index < exchanges.length; index += 1) {
      const a = exchanges[index]!;
      const b = other[index]!;
      if (
        a.id !== b.id ||
        a.question !== b.question ||
        a.answer !== b.answer ||
        a.answeredAtMs !== b.answeredAtMs
      )
        return false;
    }
  }
  return true;
}
