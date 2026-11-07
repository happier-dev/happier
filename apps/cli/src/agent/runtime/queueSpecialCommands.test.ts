import { describe, expect, it, vi } from 'vitest';

import { pushMessageToQueueWithSpecialCommands } from './queueSpecialCommands';
import { MessageQueue2 } from './modeMessageQueue';

describe('pushMessageToQueueWithSpecialCommands', () => {
  it('keeps separately attributed inputs separate through normal, priority and clear enqueue paths', async () => {
    const queue = new MessageQueue2<{ permissionMode: string }>(() => 'same-mode');
    const mode = { permissionMode: 'default' };
    const firstMeta = { happierProvenanceV1: { v: 1, kind: 'happierSession', sourceSessionId: 'first', via: 'mcp' } };
    const secondMeta = { happierProvenanceV1: { v: 1, kind: 'happierSession', sourceSessionId: 'second', via: 'mcp' } };
    pushMessageToQueueWithSpecialCommands({ queue, mode, message: 'second', text: 'second', providerPromptMeta: secondMeta });
    pushMessageToQueueWithSpecialCommands({ queue, mode, message: 'first', text: 'first', providerPromptMeta: firstMeta, prioritize: true });
    expect(await queue.waitForMessagesAndGetAsString()).toMatchObject({ message: 'first', providerPromptMeta: firstMeta });
    expect(await queue.waitForMessagesAndGetAsString()).toMatchObject({ message: 'second', providerPromptMeta: secondMeta });
    pushMessageToQueueWithSpecialCommands({ queue, mode, message: '/clear', text: '/clear', providerPromptMeta: firstMeta });
    expect(await queue.waitForMessagesAndGetAsString()).toMatchObject({ message: '/clear', providerPromptMeta: firstMeta });
  });

  it('pushes clear commands via isolate+clear', () => {
    const queue = {
      push: vi.fn(),
      unshift: vi.fn(),
      pushIsolateAndClear: vi.fn(),
    };

    pushMessageToQueueWithSpecialCommands({
      queue,
      message: '/clear',
      text: '/clear',
      mode: { permissionMode: 'default' },
    });

    expect(queue.push).not.toHaveBeenCalled();
    expect(queue.pushIsolateAndClear).toHaveBeenCalledWith('/clear', { permissionMode: 'default' }, {
      userMessageSeq: null,
      userMessageLocalId: null,
      userMessageLocalIds: null,
    });
  });

  it('pushes non-special text normally', () => {
    const queue = {
      push: vi.fn(),
      unshift: vi.fn(),
      pushIsolateAndClear: vi.fn(),
    };

    pushMessageToQueueWithSpecialCommands({
      queue,
      message: 'hello',
      text: 'hello',
      mode: { permissionMode: 'default' },
    });

    expect(queue.pushIsolateAndClear).not.toHaveBeenCalled();
    expect(queue.push).toHaveBeenCalledWith('hello', { permissionMode: 'default' }, {
      userMessageSeq: null,
      userMessageLocalId: null,
      userMessageLocalIds: null,
    });
  });

  it('preserves user message delivery attribution for normal and clear commands', () => {
    const queue = {
      push: vi.fn(),
      unshift: vi.fn(),
      pushIsolateAndClear: vi.fn(),
    };

    pushMessageToQueueWithSpecialCommands({
      queue,
      message: 'hello',
      text: 'hello',
      mode: { permissionMode: 'default' },
      userMessageSeq: 41,
      userMessageLocalId: 'l41',
    });
    pushMessageToQueueWithSpecialCommands({
      queue,
      message: '/clear',
      text: '/clear',
      mode: { permissionMode: 'default' },
      userMessageSeq: 42,
      userMessageLocalIds: ['l42'],
    });

    expect(queue.push).toHaveBeenCalledWith('hello', { permissionMode: 'default' }, {
      userMessageSeq: 41,
      userMessageLocalId: 'l41',
      userMessageLocalIds: null,
    });
    expect(queue.pushIsolateAndClear).toHaveBeenCalledWith('/clear', { permissionMode: 'default' }, {
      userMessageSeq: 42,
      userMessageLocalId: null,
      userMessageLocalIds: ['l42'],
    });
  });
});
