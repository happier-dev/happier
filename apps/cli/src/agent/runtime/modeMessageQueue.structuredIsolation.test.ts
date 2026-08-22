import { describe, expect, it } from 'vitest';

import { MessageQueue2 } from './modeMessageQueue';

type Prompt = Readonly<{
  id: string;
  structured: boolean;
}>;

function createQueue() {
  return new MessageQueue2<string, Prompt>(
    (mode) => mode,
    {
      batcher: (prompts) => ({
        id: prompts.map((prompt) => prompt.id).join('+'),
        structured: prompts.some((prompt) => prompt.structured),
      }),
    },
  );
}

describe('MessageQueue2 structured-input isolation', () => {
  it('isolates each structured prompt without dropping or reordering queued peers', async () => {
    const queue = createQueue();

    queue.push({ id: 'prose-before', structured: false }, 'default');
    queue.pushIsolate({ id: 'reference-only', structured: true }, 'default');
    queue.push({ id: 'prose-between', structured: false }, 'default');
    queue.pushIsolate({ id: 'attachment-only', structured: true }, 'default');
    queue.pushIsolate({ id: 'second-attachment', structured: true }, 'default');
    queue.push({ id: 'prose-after', structured: false }, 'default');

    const drained = [];
    while (queue.size() > 0) {
      drained.push(await queue.waitForMessagesAndGetAsString());
    }

    expect(drained).toEqual([
      expect.objectContaining({
        message: { id: 'prose-before', structured: false },
        isolate: false,
      }),
      expect.objectContaining({
        message: { id: 'reference-only', structured: true },
        isolate: true,
      }),
      expect.objectContaining({
        message: { id: 'prose-between', structured: false },
        isolate: false,
      }),
      expect.objectContaining({
        message: { id: 'attachment-only', structured: true },
        isolate: true,
      }),
      expect.objectContaining({
        message: { id: 'second-attachment', structured: true },
        isolate: true,
      }),
      expect.objectContaining({
        message: { id: 'prose-after', structured: false },
        isolate: false,
      }),
    ]);
  });
});
