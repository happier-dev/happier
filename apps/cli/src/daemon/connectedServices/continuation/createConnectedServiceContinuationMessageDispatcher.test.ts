import { describe, expect, it, vi } from 'vitest';

import { readPendingLocalId } from '@happier-dev/protocol';
import type { Credentials } from '@/persistence';

import { createConnectedServiceContinuationMessageDispatcher } from './createConnectedServiceContinuationMessageDispatcher';

describe('createConnectedServiceContinuationMessageDispatcher', () => {
  const credentials: Credentials = {
    token: 'token',
    encryption: { type: 'legacy', secret: new Uint8Array(32) },
  };

  it('delegates continuation prompts to the durable session-message owner with the supplied local id', async () => {
    const sendMessage = vi.fn(async () => ({
      ok: true as const,
      sessionId: 'session-1',
      localId: 'connected-service-continuation:test',
      waited: false,
    }));
    const dispatcher = createConnectedServiceContinuationMessageDispatcher({
      credentials,
      sendMessage,
    });

    await dispatcher.sendContinuationPrompt({
      sessionId: 'session-1',
      prompt: 'continue',
      localId: 'connected-service-continuation:test',
    });

    expect(sendMessage).toHaveBeenCalledWith({
      credentials,
      idOrPrefix: 'session-1',
      message: 'continue',
      localId: 'connected-service-continuation:test',
      pendingAdmissionMode: 'continuation_if_no_queued_user_input',
      resumeInactiveSession: false,
      wait: false,
      timeoutMs: 1,
    });
  });

  it('authors only one ordinary Pending identity for an interrupted origin and never reconstructs original input', async () => {
    const sendMessage = vi.fn(async (input: Readonly<{ localId?: string }>) => ({
      ok: true as const,
      sessionId: 'session-1',
      localId: input.localId ?? 'missing',
      waited: false,
    }));
    const dispatcher = createConnectedServiceContinuationMessageDispatcher({
      credentials,
      sendMessage: sendMessage as typeof import('@/session/services/sendSessionMessage').sendSessionMessage,
    });

    const first = await dispatcher.enqueueInterruptedOriginContinuation({
      sessionId: 'session-1',
      attemptId: 'switch-attempt-1',
      interruptedOriginId: 'failure-boundary-1',
      interruption: 'forced_turn_cancelled',
      resumePromptMode: 'custom',
      customResumePrompt: 'Frozen custom continuation',
    });
    const duplicate = await dispatcher.enqueueInterruptedOriginContinuation({
      sessionId: 'session-1',
      attemptId: 'switch-attempt-1',
      interruptedOriginId: 'failure-boundary-1',
      interruption: 'forced_turn_cancelled',
      resumePromptMode: 'custom',
      customResumePrompt: 'Frozen custom continuation',
    });

    expect(first).toEqual({ status: 'enqueued', localId: expect.any(String) });
    expect(first.status === 'enqueued' ? readPendingLocalId(first.localId) : null)
      .toBe(first.status === 'enqueued' ? first.localId : null);
    expect(duplicate).toEqual(first);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({
      message: 'Frozen custom continuation',
      localId: first.status === 'enqueued' ? first.localId : 'unexpected',
      resumeInactiveSession: false,
    });
    expect(sendMessage.mock.calls[1]?.[0]).toEqual(sendMessage.mock.calls[0]?.[0]);
    expect(Reflect.get(dispatcher, 'retryOriginalUserMessage')).toBeUndefined();

    const distinctOrigin = await dispatcher.enqueueInterruptedOriginContinuation({
      sessionId: 'session-1',
      attemptId: 'switch-attempt-1',
      interruptedOriginId: 'failure-boundary-2',
      interruption: 'forced_turn_cancelled',
      resumePromptMode: 'custom',
      customResumePrompt: 'Frozen custom continuation',
    });
    expect(distinctOrigin).toEqual({ status: 'enqueued', localId: expect.any(String) });
    expect(distinctOrigin.status === 'enqueued' && first.status === 'enqueued'
      ? distinctOrigin.localId
      : null).not.toBe(first.status === 'enqueued' ? first.localId : null);
  });

  it('derives distinct identities for exact origin tuples that contain separator bytes', async () => {
    const sendMessage = vi.fn(async (input: Readonly<{ localId?: string }>) => ({
      ok: true as const,
      sessionId: 'session-1',
      localId: input.localId ?? 'missing',
      waited: false,
    }));
    const dispatcher = createConnectedServiceContinuationMessageDispatcher({
      credentials,
      sendMessage: sendMessage as typeof import('@/session/services/sendSessionMessage').sendSessionMessage,
    });

    const first = await dispatcher.enqueueInterruptedOriginContinuation({
      sessionId: 'session-1',
      attemptId: 'attempt-a\0attempt-b',
      interruptedOriginId: 'turn-c',
      interruption: 'provider_failed_turn',
      resumePromptMode: 'standard',
    });
    const second = await dispatcher.enqueueInterruptedOriginContinuation({
      sessionId: 'session-1',
      attemptId: 'attempt-a',
      interruptedOriginId: 'attempt-b\0turn-c',
      interruption: 'provider_failed_turn',
      resumePromptMode: 'standard',
    });

    expect(first.status).toBe('enqueued');
    expect(second.status).toBe('enqueued');
    expect(first.status === 'enqueued' && second.status === 'enqueued'
      ? first.localId
      : null).not.toBe(second.status === 'enqueued' ? second.localId : null);
  });

  it('rejects an interrupted replacement without a nonblank exact origin identity', async () => {
    const sendMessage = vi.fn();
    const dispatcher = createConnectedServiceContinuationMessageDispatcher({ credentials, sendMessage });

    await expect(dispatcher.enqueueInterruptedOriginContinuation({
      sessionId: 'session-1',
      attemptId: 'switch-attempt-1',
      interruptedOriginId: '   ',
      interruption: 'provider_failed_turn',
      resumePromptMode: 'standard',
    })).rejects.toThrow('connected_service_continuation_identity_invalid');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    { interruption: 'none' as const, resumePromptMode: 'standard' as const, status: 'not_interrupted' },
    { interruption: 'clean_boundary' as const, resumePromptMode: 'standard' as const, status: 'not_interrupted' },
    { interruption: 'provider_failed_turn' as const, resumePromptMode: 'off' as const, status: 'disabled' },
  ])('does not enqueue for $status', async ({ interruption, resumePromptMode, status }) => {
    const sendMessage = vi.fn();
    const dispatcher = createConnectedServiceContinuationMessageDispatcher({ credentials, sendMessage });

    await expect(dispatcher.enqueueInterruptedOriginContinuation({
      sessionId: 'session-1',
      attemptId: 'switch-attempt-1',
      interruptedOriginId: 'failure-boundary-1',
      interruption,
      resumePromptMode,
    })).resolves.toEqual({ status });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('freezes the usage-limit recovery prompt before handing the row to Pending', async () => {
    const sendMessage = vi.fn(async (input: Readonly<{ localId?: string }>) => ({
      ok: true as const,
      sessionId: 'session-1',
      localId: input.localId ?? 'missing',
      waited: false,
    }));
    const dispatcher = createConnectedServiceContinuationMessageDispatcher({
      credentials,
      sendMessage: sendMessage as typeof import('@/session/services/sendSessionMessage').sendSessionMessage,
    });

    await dispatcher.enqueueInterruptedOriginContinuation({
      sessionId: 'session-1',
      attemptId: 'switch-attempt-standard',
      interruptedOriginId: 'failure-boundary-standard',
      interruption: 'provider_failed_turn',
      resumePromptMode: 'standard',
      recoveryKind: 'usage_limit',
    });

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Usage limits are lifted. Continue where you left off.',
    }));
  });

  it('keeps the standard continuation truthful for non-limit auth recovery', async () => {
    const sendMessage = vi.fn(async (input: Readonly<{ localId?: string }>) => ({
      ok: true as const,
      sessionId: 'session-1',
      localId: input.localId ?? 'missing',
      waited: false,
    }));
    const dispatcher = createConnectedServiceContinuationMessageDispatcher({
      credentials,
      sendMessage: sendMessage as typeof import('@/session/services/sendSessionMessage').sendSessionMessage,
    });

    await dispatcher.enqueueInterruptedOriginContinuation({
      sessionId: 'session-1',
      attemptId: 'switch-attempt-auth',
      interruptedOriginId: 'failure-boundary-auth',
      interruption: 'provider_failed_turn',
      resumePromptMode: 'standard',
      recoveryKind: 'auth_expired',
    });

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Continue where you left off',
    }));
  });

  it('reports atomic Pending admission suppression without a transcript pre-check', async () => {
    const sendMessage = vi.fn(async () => ({
      ok: true as const,
      sessionId: 'session-1',
      localId: 'connected-service-continuation:test',
      waited: false,
      suppressed: true as const,
    }));
    const dispatcher = createConnectedServiceContinuationMessageDispatcher({ credentials, sendMessage });

    await expect(dispatcher.enqueueInterruptedOriginContinuation({
      sessionId: 'session-1',
      attemptId: 'switch-attempt-1',
      interruptedOriginId: 'failure-boundary-1',
      interruption: 'provider_failed_turn',
      resumePromptMode: 'standard',
    })).resolves.toEqual({ status: 'suppressed_newer_user_input' });
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
