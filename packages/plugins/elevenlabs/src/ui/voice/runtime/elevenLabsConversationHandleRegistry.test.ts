import { describe, expect, it, vi } from 'vitest';

import type { ElevenLabsConversationHandle } from './createElevenLabsConversationHandle.js';
import { createElevenLabsConversationHandleRegistry } from './elevenLabsConversationHandleRegistry.js';

function handle(label: string): ElevenLabsConversationHandle {
  return {
    startSession: vi.fn(async () => label),
    endSession: vi.fn(async () => undefined),
    getId: vi.fn(() => label),
    sendUserMessage: vi.fn(),
    sendContextualUpdate: vi.fn(),
    setMicMuted: vi.fn(),
    readOutboundAudioBytes: vi.fn(async () => null),
    subscribe: vi.fn(() => () => undefined),
    dispose: vi.fn(),
  };
}

describe('ElevenLabs conversation handle registry', () => {
  it('registers voice and text handles independently and stale unregister cannot clear a replacement', () => {
    const registry = createElevenLabsConversationHandleRegistry();
    const first = handle('first');
    const second = handle('second');
    const unregisterFirst = registry.register('voice', first);
    const unregisterText = registry.register('text', first);
    const unregisterSecond = registry.register('voice', second);

    expect(registry.current('voice')).toBe(second);
    expect(registry.current('text')).toBe(first);
    unregisterFirst();
    expect(registry.current('voice')).toBe(second);
    unregisterSecond();
    expect(registry.current('voice')).toBeNull();
    unregisterText();
    expect(registry.current('text')).toBeNull();
  });

  it('waits abortably for the next current handle and releases the waiter after settlement', async () => {
    const registry = createElevenLabsConversationHandleRegistry();
    const controller = new AbortController();
    const pending = registry.waitForCurrent('voice', controller.signal);
    const current = handle('current');
    registry.register('voice', current);
    await expect(pending).resolves.toBe(current);

    const aborted = new AbortController();
    aborted.abort();
    await expect(registry.waitForCurrent('text', aborted.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('bounds a missing handle wait so reconnect cannot hang forever', async () => {
    vi.useFakeTimers();
    const registry = createElevenLabsConversationHandleRegistry();
    const pending = registry.waitForCurrent('voice', new AbortController().signal, 25);
    const assertion = expect(pending).rejects.toThrow('elevenlabs_handle_wait_timeout');
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
    vi.useRealTimers();
  });
});
