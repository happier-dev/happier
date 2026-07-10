import { describe, expect, it, vi } from 'vitest';

import { createTestExecutionRunHostRuntime } from './runtime';

describe('createTestExecutionRunHostRuntime', () => {
  it('creates a runtime-native harness with message delivery and override hooks', async () => {
    const sendPrompt = vi.fn((_sessionId: string, prompt: string, actions) => {
      actions.emit({ type: 'model-output', fullText: prompt.toUpperCase() });
    });
    const harness = createTestExecutionRunHostRuntime({
      sessionId: 'session_1',
      sendPrompt,
    });
    const messages: unknown[] = [];

    const unsubscribe = harness.runtime.subscribeMessages((message) => {
      messages.push(message);
    });

    await harness.runtime.provisionSession();
    await harness.runtime.sendPrompt('session_1', 'ok');
    unsubscribe();
    harness.emit({ type: 'model-output', fullText: 'ignored' });

    expect(sendPrompt).toHaveBeenCalledWith('session_1', 'ok', { emit: harness.emit }, undefined);
    expect(messages).toEqual([{ type: 'model-output', fullText: 'OK' }]);
  });
});
