import { describe, expect, it } from 'vitest';
import type { Message } from '@happier-dev/session-core/messages';

import {
  NO_WALKTHROUGH_STOP_EXCHANGES,
  projectWalkthroughStopExchanges,
  sameWalkthroughStopExchanges,
} from './walkthroughStopExchangesModel';

const RUN = 'run-1';
const RESULT = 'result-1';

function question(
  localId: string,
  stopIds: string[],
  text: string,
  createdAt: number,
  extra?: Partial<{ resultId: string; runId: string }>,
): Message {
  return {
    kind: 'user-text',
    id: `m-${localId}`,
    localId,
    createdAt,
    // What the generator received is the evidence-bearing prompt; the person saw their question.
    text: `<evidence>\n${text}`,
    displayText: text,
    meta: {
      displayText: text,
      happier: {
        kind: 'participant_message.v1',
        payload: {
          recipient: { kind: 'execution_run', runId: extra?.runId ?? RUN },
        },
      },
      scmWalkthroughQuestionV1: {
        resultId: extra?.resultId ?? RESULT,
        revision: 2,
        stopIds,
      },
    },
  } as Message;
}

function reply(
  id: string,
  inputIds: string[],
  text: string,
  createdAt: number,
  isThinking = false,
): Message {
  return {
    kind: 'agent-text',
    id,
    localId: null,
    createdAt,
    text,
    isThinking,
    meta: {
      happierExecutionRunInputTurnV1: {
        turnId: `turn-${inputIds[0]}`,
        inputIds,
        state: 'completed',
      },
    },
  } as Message;
}

describe('walkthrough stop exchanges (lab WT3-D1: answers under their stop)', () => {
  it('puts each question under the stop it was asked about with the reply to that exact turn', () => {
    const projected = projectWalkthroughStopExchanges({
      runId: RUN,
      resultId: RESULT,
      stopIds: new Set(['stop-a', 'stop-b']),
      messages: [
        question('q1', ['stop-b'], 'Why memoize on route?', 10),
        question('q2', ['stop-a'], 'Is this tested?', 30),
      ],
      runMessages: [
        reply('r0', ['q1'], 'Thinking about keys', 11, true),
        reply('r1', ['q1'], 'Because section routes carry the id.', 12),
        reply('r1b', ['q1'], 'Keying on kind alone would reuse one modal.', 13),
      ],
    });
    expect(projected.get('stop-b')).toEqual([
      {
        id: 'q1',
        question: 'Why memoize on route?',
        askedAtMs: 10,
        answer: 'Keying on kind alone would reuse one modal.',
        answeredAtMs: 13,
      },
    ]);
    // Asked, not yet answered: the question shows and the answer is still to come.
    expect(projected.get('stop-a')).toEqual([
      {
        id: 'q2',
        question: 'Is this tested?',
        askedAtMs: 30,
        answer: null,
        answeredAtMs: null,
      },
    ]);
  });

  it('quietly drops questions about a stop the reading no longer has, another walkthrough, or another run', () => {
    const projected = projectWalkthroughStopExchanges({
      runId: RUN,
      resultId: RESULT,
      stopIds: new Set(['stop-a']),
      messages: [
        question('merged', ['stop-gone'], 'About a merged stop', 1),
        question('other-result', ['stop-a'], 'About another walkthrough', 2, {
          resultId: 'result-2',
        }),
        question('other-run', ['stop-a'], 'To another run', 3, {
          runId: 'run-2',
        }),
        {
          kind: 'user-text',
          id: 'plain',
          localId: 'plain',
          createdAt: 4,
          text: 'An ordinary message',
        } as Message,
      ],
      runMessages: [reply('r', ['merged'], 'An answer', 5)],
    });
    expect(projected).toBe(NO_WALKTHROUGH_STOP_EXCHANGES);
  });

  it('reads a question committed in the run transcript once, even when the Session holds it too', () => {
    const asked = question('q1', ['stop-a'], 'Why?', 1);
    const projected = projectWalkthroughStopExchanges({
      runId: RUN,
      resultId: RESULT,
      stopIds: new Set(['stop-a']),
      messages: [asked],
      runMessages: [asked, reply('r', ['q1'], 'Because.', 2)],
    });
    expect(projected.get('stop-a')).toHaveLength(1);
  });

  it('treats an unchanged projection as the same, so unrelated transcript rows re-render nothing', () => {
    const input = {
      runId: RUN,
      resultId: RESULT,
      stopIds: new Set(['stop-a']),
      messages: [question('q1', ['stop-a'], 'Why?', 1)],
      runMessages: [reply('r', ['q1'], 'Because.', 2)],
    };
    const first = projectWalkthroughStopExchanges(input);
    const unrelated = projectWalkthroughStopExchanges({
      ...input,
      messages: [
        ...input.messages,
        {
          kind: 'agent-text',
          id: 'x',
          localId: null,
          createdAt: 9,
          text: 'Elsewhere',
        } as Message,
      ],
    });
    expect(sameWalkthroughStopExchanges(first, unrelated)).toBe(true);
    const answered = projectWalkthroughStopExchanges({
      ...input,
      runMessages: [
        ...input.runMessages,
        reply('r2', ['q1'], 'Because, more.', 3),
      ],
    });
    expect(sameWalkthroughStopExchanges(first, answered)).toBe(false);
  });
});
