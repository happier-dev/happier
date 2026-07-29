import { afterEach, describe, expect, it, vi } from 'vitest';

import { AcpBackend } from '../AcpBackend';
import { createAcpTestTransportHandler } from '../testkit/subprocessHarness';

describe('AcpBackend raw prompt ownership', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function createPendingPromptBackend(params: Readonly<{
    cancel?: ReturnType<typeof vi.fn<() => Promise<void>>>;
  }> = {}) {
    vi.useFakeTimers();
    const prompt = vi.fn(() => new Promise<never>(() => {}));
    const cancel = params.cancel ?? vi.fn<() => Promise<void>>(async () => undefined);
    const close = vi.fn();
    const backend = new AcpBackend({
      agentName: 'test',
      cwd: process.cwd(),
      command: process.execPath,
      args: [],
      transportHandler: createAcpTestTransportHandler({
        idleTimeoutMs: 1,
        promptLivenessTimeoutMs: 1_000,
      }),
    });
    Reflect.set(backend, 'connection', {
      peer: { prompt, cancel },
      close,
      closed: Promise.resolve(),
    });
    Reflect.set(backend, 'acpSessionId', 'session-1');
    return { backend, prompt, cancel, close };
  }

  async function emitUpdate(
    backend: AcpBackend,
    sessionUpdate: 'agent_message_chunk' | 'user_message_chunk',
    text: string,
  ): Promise<void> {
    const handleSessionUpdate = Reflect.get(backend, 'handleSessionUpdate');
    if (typeof handleSessionUpdate !== 'function') {
      throw new Error('AcpBackend test fixture could not reach handleSessionUpdate');
    }
    await handleSessionUpdate.call(backend, {
      sessionId: 'session-1',
      update: {
        sessionUpdate,
        content: { type: 'text', text },
      },
    });
  }

  async function acceptPendingPrompt(backend: AcpBackend): Promise<void> {
    const firstPrompt = backend.sendPrompt('session-1', 'first');
    await Promise.resolve();
    await emitUpdate(backend, 'agent_message_chunk', 'first update');
    expect(backend.submitCompletionEvidence({ kind: 'completed' })).toBe(true);
    await expect(firstPrompt).resolves.toEqual({
      kind: 'accepted_by_correlated_provider_effect',
    });
  }

  it('rejects a successor while the raw predecessor prompt RPC is still settling', async () => {
    const { backend, prompt } = createPendingPromptBackend();
    await acceptPendingPrompt(backend);

    const successor = backend.sendPrompt('session-1', 'must not overlap');
    await Promise.resolve();
    expect(prompt).toHaveBeenCalledOnce();
    await expect(successor).rejects.toThrow(
      'Previous ACP prompt request is still settling',
    );
  });

  it('releases cancelled raw prompt ownership so a successor can start before the old response settles', async () => {
    const { backend, prompt, cancel, close } = createPendingPromptBackend();
    await acceptPendingPrompt(backend);

    await expect(backend.cancel('session-1')).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    expect(prompt).toHaveBeenCalledOnce();

    const successor = backend.sendPrompt('session-1', 'successor');
    await Promise.resolve();
    expect(prompt).toHaveBeenCalledTimes(2);
    await emitUpdate(backend, 'user_message_chunk', 'successor');
    expect(backend.submitCompletionEvidence({ kind: 'completed' })).toBe(true);
    await expect(successor).resolves.toEqual({
      kind: 'accepted_by_correlated_provider_effect',
    });
  });

  it('fails closed on transport loss while the cancelled raw prompt remains unsettled', async () => {
    const cancel = vi.fn(async () => {
      throw new Error('transport lost');
    });
    const { backend, prompt, close } = createPendingPromptBackend({ cancel });
    await acceptPendingPrompt(backend);

    const cancellation = backend.cancel('session-1');
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(cancellation).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
    expect(prompt).toHaveBeenCalledOnce();
    await expect(backend.sendPrompt('session-1', 'detached stream')).rejects.toThrow('Session not started');
  });

  it('does not publish a late duplicate cancel acknowledgement over a successor turn', async () => {
    let acknowledgeFirstCancel!: () => void;
    let acknowledgeSecondCancel!: () => void;
    const firstCancel = new Promise<void>((resolve) => {
      acknowledgeFirstCancel = resolve;
    });
    const secondCancel = new Promise<void>((resolve) => {
      acknowledgeSecondCancel = resolve;
    });
    const cancel = vi.fn<() => Promise<void>>(async () => undefined)
      .mockImplementationOnce(async () => await firstCancel)
      .mockImplementationOnce(async () => await secondCancel);
    const { backend, prompt } = createPendingPromptBackend({ cancel });
    await acceptPendingPrompt(backend);

    const firstCancellation = backend.cancel('session-1');
    const secondCancellation = backend.cancel('session-1');
    acknowledgeFirstCancel();
    await firstCancellation;

    const statuses: string[] = [];
    backend.onMessage((message) => {
      if (message.type === 'status') statuses.push(message.status);
    });
    const successor = backend.sendPrompt('session-1', 'successor');
    await Promise.resolve();
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(statuses).toEqual(['running']);

    acknowledgeSecondCancel();
    await secondCancellation;
    expect(statuses).toEqual(['running']);

    await emitUpdate(backend, 'user_message_chunk', 'successor');
    expect(backend.submitCompletionEvidence({ kind: 'completed' })).toBe(true);
    await expect(successor).resolves.toEqual({
      kind: 'accepted_by_correlated_provider_effect',
    });
  });

  it('does not publish an old cancel acknowledgement over a replaced connection', async () => {
    let acknowledgeCancel!: () => void;
    const cancelAcknowledgement = new Promise<void>((resolve) => {
      acknowledgeCancel = resolve;
    });
    const cancel = vi.fn(async () => await cancelAcknowledgement);
    const { backend } = createPendingPromptBackend({ cancel });
    await acceptPendingPrompt(backend);

    const statuses: string[] = [];
    backend.onMessage((message) => {
      if (message.type === 'status') statuses.push(message.status);
    });
    const cancellation = backend.cancel('session-1');
    Reflect.set(backend, 'connection', {
      peer: {
        prompt: vi.fn(() => new Promise<never>(() => {})),
        cancel: vi.fn(async () => undefined),
      },
      close: vi.fn(),
      closed: Promise.resolve(),
    });
    Reflect.set(backend, 'acpSessionId', 'session-2');

    acknowledgeCancel();
    await cancellation;
    expect(statuses).toEqual([]);
  });
});
