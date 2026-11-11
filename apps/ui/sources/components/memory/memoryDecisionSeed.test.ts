import { describe, expect, it } from 'vitest';
import type { CoordinationMessageRefV1 } from '@happier-dev/protocol/discussions/messageRefs';

import { seedMemoryDecisionFromMessage } from './memoryDecisionSeed';

const source: CoordinationMessageRefV1 = {
  kind: 'discussion',
  discussion: { serverId: 'server-1', discussionId: 'discussion-1' },
  messageId: 'message-1',
};

const seed = (message: string) =>
  seedMemoryDecisionFromMessage(source, message);

describe('seedMemoryDecisionFromMessage', () => {
  it('leaves the decision empty for an answer that is only a label and a code block, and quotes the answer (owner 03)', () => {
    const answer = 'Result:\n```json\n{\n  "listPinned": false\n}\n```';
    expect(seed(answer)).toEqual({
      sourceMessageRef: source,
      text: '',
      quote: answer,
    });
  });

  it('takes the first prose sentence, without markup, and never prefills the reason', () => {
    const answer =
      '## Plan\n\n**Keep the retry cap at 5.** Backoff ran out too early.\n\n- More detail';
    expect(seed(answer)).toEqual({
      sourceMessageRef: source,
      text: 'Keep the retry cap at 5',
      quote: answer,
    });
  });

  it('skips code fences, tables and label lines to reach prose', () => {
    expect(
      seed(
        '```ts\nconst cap = 5;\n```\n| a | b |\n|---|---|\nSummary:\nUse `Postgres` for the [queue](https://example.com) now.',
      ).text,
    ).toBe('Use Postgres for the queue now');
  });

  it('keeps a list item or quote as prose and keeps a question mark', () => {
    expect(seed('- Should we drop retries? Maybe.').text).toBe(
      'Should we drop retries?',
    );
    expect(seed('> Ship it on Friday').text).toBe('Ship it on Friday');
  });

  it('does not split on a decimal or version number', () => {
    expect(seed('Pin Node 24.1 for the build. Then retry.').text).toBe(
      'Pin Node 24.1 for the build',
    );
  });
});
