import type { ExecutionRunHostMessageV1 } from '@happier-dev/plugin-sdk';
import { describe, expect, it } from 'vitest';

import { createSingleShotExecutionRunHostBackend } from './singleShot';

function createModelOutputMessage(fullText: string): ExecutionRunHostMessageV1 {
  return { type: 'model-output', fullText } as unknown as ExecutionRunHostMessageV1;
}

describe('execution-run single-shot host adapter', () => {
  it('uses the shared single-shot backend lifecycle for host runtime messages', async () => {
    const backend = createSingleShotExecutionRunHostBackend({
      backendId: 'sample',
      sessionIdPrefix: 'sample',
      run: async ({ emit, prompt }) => {
        emit(createModelOutputMessage(`direct:${prompt}`));
        return { messages: [createModelOutputMessage(`returned:${prompt}`)] };
      },
    });
    const messages: ExecutionRunHostMessageV1[] = [];
    const unsubscribe = backend.subscribeMessages((message) => {
      messages.push(message);
    });

    const provisioned = await backend.provisionSession();
    await backend.sendPrompt(provisioned.sessionId, 'hello');
    unsubscribe();
    await backend.dispose();

    expect(messages).toEqual([
      createModelOutputMessage('direct:hello'),
      createModelOutputMessage('returned:hello'),
    ]);
  });
});
