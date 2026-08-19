import { describe, expect, it, vi } from 'vitest';
import type { PromptResponse } from '@agentclientprotocol/sdk';

import {
  AcpBackend,
  AcpPromptSubmissionPhaseError,
} from '../AcpBackend';
import { createAcpTestTransportHandler } from '../testkit/subprocessHarness';

function createBackend(agentName = 'test'): AcpBackend {
  return new AcpBackend({
    agentName,
    cwd: process.cwd(),
    command: process.execPath,
    args: [],
    transportHandler: createAcpTestTransportHandler({ agentName, idleTimeoutMs: 1 }),
  });
}

function installPromptPeer(
  backend: AcpBackend,
  prompt: () => Promise<PromptResponse>,
  cancel: () => Promise<unknown> = async () => ({}),
): {
  handleSessionUpdate: (params: unknown) => Promise<void>;
} {
  const internals = backend as unknown as {
    connection: unknown;
    acpSessionId: string | null;
    handleSessionUpdate: (params: unknown) => Promise<void>;
  };
  internals.acpSessionId = 'test-session';
  internals.connection = {
    peer: {
      prompt,
      cancel,
    },
    close: () => {},
    closed: Promise.resolve(),
  };
  return internals;
}

async function readPromiseState(
  evidence: Promise<unknown>,
): Promise<'resolved' | 'pending'> {
  let resolved = false;
  void evidence.then(
    () => {
      resolved = true;
    },
    () => {
      resolved = true;
    },
  );
  await Promise.resolve();
  return resolved ? 'resolved' : 'pending';
}

describe('AcpBackend prompt submission evidence', () => {
  it('types a local precondition failure as rejected before effect', async () => {
    const backend = createBackend();

    await expect(backend.sendPromptWithEvidence('test-session', 'hello')).rejects.toMatchObject({
      name: 'AcpPromptSubmissionPhaseError',
      phase: 'rejected_before_effect',
      message: 'Session not started',
    });

    await backend.dispose();
  });

  it('returns exact final-response evidence when the prompt response wins the liveness race', async () => {
    const backend = createBackend();
    installPromptPeer(backend, async () => ({ stopReason: 'end_turn' }));

    try {
      await expect(backend.sendPromptWithEvidence('test-session', 'hello')).resolves.toEqual({
        kind: 'exact_final_response',
        response: { stopReason: 'end_turn' },
      });
    } finally {
      await backend.dispose();
    }
  });

  it('returns accepted evidence when the prompt transport write succeeds before the turn response', async () => {
    const backend = createBackend();
    let resolvePrompt!: (response: PromptResponse) => void;
    const promptResponse = new Promise<PromptResponse>((resolve) => {
      resolvePrompt = resolve;
    });
    const internals = backend as unknown as {
      observeAcpTransportMessageWritten(message: unknown): void;
    };
    installPromptPeer(backend, () => {
      internals.observeAcpTransportMessageWritten({
        jsonrpc: '2.0',
        id: 1,
        method: 'session/prompt',
        params: { sessionId: 'test-session', prompt: [] },
      });
      return promptResponse;
    });

    try {
      await expect(backend.sendPromptWithEvidence('test-session', 'hello')).resolves.toEqual({
        kind: 'accepted_without_exact_final_response',
      });
    } finally {
      resolvePrompt({ stopReason: 'end_turn' });
      await backend.dispose();
    }
  });

  it('returns from an in-flight steer when its transport write succeeds', async () => {
    const backend = createBackend();
    let resolvePrompt!: (response: PromptResponse) => void;
    const promptResponse = new Promise<PromptResponse>((resolve) => {
      resolvePrompt = resolve;
    });
    const internals = backend as unknown as {
      observeAcpTransportMessageWritten(message: unknown): void;
    };
    installPromptPeer(backend, () => {
      internals.observeAcpTransportMessageWritten({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/prompt',
        params: { sessionId: 'test-session', prompt: [] },
      });
      return promptResponse;
    });

    try {
      await expect(Promise.race([
        backend.sendSteerPrompt('test-session', 'follow up').then(() => 'written' as const),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 25)),
      ])).resolves.toBe('written');
    } finally {
      resolvePrompt({ stopReason: 'end_turn' });
      await backend.dispose();
    }
  });

  it('keeps cancellation pending until the raw prompt RPC settles and rejects an overlapping prompt', async () => {
    const backend = createBackend();
    let settleFirstPrompt!: (response: PromptResponse) => void;
    const firstPrompt = new Promise<PromptResponse>((resolve) => {
      settleFirstPrompt = resolve;
    });
    let promptCalls = 0;
    const internals = backend as unknown as {
      connection: unknown;
      acpSessionId: string | null;
    };
    internals.acpSessionId = 'test-session';
    internals.connection = {
      peer: {
        prompt: () => {
          promptCalls += 1;
          return promptCalls === 1
            ? firstPrompt
            : Promise.resolve({ stopReason: 'end_turn' });
        },
        cancel: async () => ({}),
      },
      close: () => {},
      closed: Promise.resolve(),
    };

    try {
      const firstSubmission = backend.sendPromptWithEvidence('test-session', 'first');
      await Promise.resolve();
      let cancellationSettled = false;
      const cancellation = backend.cancel('test-session').then(() => {
        cancellationSettled = true;
      });
      await Promise.resolve();

      expect(cancellationSettled).toBe(false);
      await expect(backend.sendPromptWithEvidence('test-session', 'overlap')).rejects.toMatchObject({
        phase: 'rejected_before_effect',
        message: 'Previous ACP prompt RPC is still settling',
      });
      expect(promptCalls).toBe(1);

      settleFirstPrompt({ stopReason: 'cancelled' });
      await cancellation;
      await firstSubmission;
      await expect(backend.sendPromptWithEvidence('test-session', 'next')).resolves.toMatchObject({
        kind: 'exact_final_response',
      });
      expect(promptCalls).toBe(2);
    } finally {
      await backend.dispose();
    }
  });

  it('bounds a hanging cancel acknowledgement with the raw prompt and closes the uncorrelated connection', async () => {
    vi.useFakeTimers();
    const backend = createBackend();
    const close = vi.fn();
    let promptCalls = 0;
    const internals = backend as unknown as {
      connection: unknown;
      acpSessionId: string | null;
    };
    internals.acpSessionId = 'test-session';
    internals.connection = {
      peer: {
        prompt: () => {
          promptCalls += 1;
          return new Promise<PromptResponse>(() => {});
        },
        cancel: () => new Promise(() => {}),
      },
      close,
      closed: Promise.resolve(),
    };

    try {
      void backend.sendPromptWithEvidence('test-session', 'first').catch(() => {});
      await Promise.resolve();
      const cancellation = backend.cancel('test-session');
      await Promise.resolve();

      await expect(backend.sendPromptWithEvidence('test-session', 'overlap')).rejects.toMatchObject({
        phase: 'rejected_before_effect',
        message: 'Previous ACP prompt RPC is still settling',
      });
      expect(close).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5_000);
      await cancellation;

      expect(close).toHaveBeenCalledOnce();
      await expect(backend.sendPromptWithEvidence('test-session', 'after-close')).rejects.toMatchObject({
        phase: 'rejected_before_effect',
        message: 'Session not started',
      });
      expect(promptCalls).toBe(1);
    } finally {
      vi.useRealTimers();
      await backend.dispose();
    }
  });

  it('keeps auxiliary first-update liveness ambiguous and types a later lost response as effect may have occurred', async () => {
    const backend = createBackend();
    let rejectPrompt!: (error: Error) => void;
    const promptResponse = new Promise<PromptResponse>((_resolve, reject) => {
      rejectPrompt = reject;
    });
    let internals!: ReturnType<typeof installPromptPeer>;
    let updateHandled: Promise<void> | null = null;
    internals = installPromptPeer(backend, () => {
      updateHandled = internals.handleSessionUpdate({
        sessionId: 'test-session',
        update: {
          sessionUpdate: 'usage_update',
          used: 1,
          size: 10,
        },
      });
      return promptResponse;
    });

    try {
      const evidence = await backend.sendPromptWithEvidence('test-session', 'hello');
      expect(evidence.kind).toBe('effect_may_have_occurred');
      if (evidence.kind !== 'effect_may_have_occurred') return;
      await updateHandled;

      expect(await readPromiseState(evidence.finalResponseEvidence)).toBe('pending');

      rejectPrompt(new Error('prompt response lost'));

      await expect(evidence.finalResponseEvidence).rejects.toBeInstanceOf(AcpPromptSubmissionPhaseError);
      await expect(evidence.finalResponseEvidence).rejects.toMatchObject({
        phase: 'effect_may_have_occurred',
        message: 'prompt response lost',
      });
      await expect(backend.waitForResponseComplete(250)).rejects.toThrow('prompt response lost');
    } finally {
      await backend.dispose();
    }
  });

  it('keeps an exact Gemini empty-response error ambiguous when only generic output was observed', async () => {
    const backend = createBackend('gemini');
    let rejectPrompt!: (error: unknown) => void;
    const promptResponse = new Promise<PromptResponse>((_resolve, reject) => {
      rejectPrompt = reject;
    });
    let internals!: ReturnType<typeof installPromptPeer>;
    let updateHandled: Promise<void> | null = null;
    internals = installPromptPeer(backend, () => {
      updateHandled = internals.handleSessionUpdate({
        sessionId: 'test-session',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'uncorrelated Gemini output' },
        },
      });
      return promptResponse;
    });

    try {
      const evidence = await backend.sendPromptWithEvidence('test-session', 'hello');
      expect(evidence.kind).toBe('effect_may_have_occurred');
      if (evidence.kind !== 'effect_may_have_occurred') return;
      await updateHandled;

      rejectPrompt({
        code: -32603,
        message: 'Internal error',
        data: { details: 'Model stream ended with empty response text.' },
      });

      await expect(evidence.finalResponseEvidence).rejects.toMatchObject({
        phase: 'effect_may_have_occurred',
      });
    } finally {
      await backend.dispose();
    }
  });

  it('does not turn malformed liveness or a post-cancel stale content update into provider-effect evidence', async () => {
    const backend = createBackend();
    let settlePrompt!: (response: PromptResponse) => void;
    const promptResponse = new Promise<PromptResponse>((resolve) => {
      settlePrompt = resolve;
    });
    let internals!: ReturnType<typeof installPromptPeer>;
    let updateHandled: Promise<void> | null = null;
    internals = installPromptPeer(backend, () => {
      updateHandled = internals.handleSessionUpdate({
        sessionId: 'test-session',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: '' },
        },
      });
      return promptResponse;
    }, async () => {
      settlePrompt({ stopReason: 'cancelled' });
    });

    try {
      const evidence = await backend.sendPromptWithEvidence('test-session', 'hello');
      expect(evidence.kind).toBe('effect_may_have_occurred');
      if (evidence.kind !== 'effect_may_have_occurred') return;
      await updateHandled;
      expect(await readPromiseState(evidence.finalResponseEvidence)).toBe('pending');

      await backend.cancel('test-session');
      await internals.handleSessionUpdate({
        sessionId: 'test-session',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'late prior-turn output' },
        },
      });

      await expect(backend.waitForResponseComplete(250)).rejects.toMatchObject({
        name: 'AbortError',
        message: 'Cancelled by user',
      });
    } finally {
      await backend.dispose();
    }
  });

  it.each([
    ['agent_message_chunk', 'visible provider output'],
    ['agent_thought_chunk', 'provider reasoning'],
  ] as const)(
    'keeps uncorrelated handled active %s ambiguous before cancellation',
    async (sessionUpdate, text) => {
      const backend = createBackend();
      let settlePrompt!: (response: PromptResponse) => void;
      const promptResponse = new Promise<PromptResponse>((resolve) => {
        settlePrompt = resolve;
      });
      let internals!: ReturnType<typeof installPromptPeer>;
      let updateHandled: Promise<void> | null = null;
      internals = installPromptPeer(backend, () => {
        updateHandled = internals.handleSessionUpdate({
          sessionId: 'test-session',
          update: {
            sessionUpdate,
            content: { type: 'text', text },
          },
        });
        return promptResponse;
      }, async () => {
        settlePrompt({ stopReason: 'cancelled' });
      });

      try {
        const evidence = await backend.sendPromptWithEvidence('test-session', 'hello');
        expect(evidence.kind).toBe('effect_may_have_occurred');
        if (evidence.kind !== 'effect_may_have_occurred') return;
        await updateHandled;

        expect(await readPromiseState(evidence.finalResponseEvidence)).toBe('pending');

        await backend.cancel('test-session');
        await expect(backend.waitForResponseComplete(250)).rejects.toMatchObject({
          name: 'AbortError',
          message: 'Cancelled by user',
        });
      } finally {
        await backend.dispose();
      }
    },
  );

});
