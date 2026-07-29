import { describe, expect, it, vi } from 'vitest';

import type { Update } from '../types';
import { handleSessionNewMessageUpdate } from './sessionNewMessageUpdate';

function createUserUpdate(): Update {
  return {
    id: 'update-1',
    seq: 1,
    createdAt: 1_000,
    body: {
      t: 'new-message',
      sid: 'session-1',
      message: {
        id: 'message-1',
        seq: 7,
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'observation only' },
            localId: 'local-1',
            meta: { source: 'cli' },
          },
        },
        localId: 'local-1',
        createdAt: 1_000,
        updatedAt: 1_000,
      },
    },
  } as Update;
}

function handle(update: Update, overrides: Partial<Parameters<typeof handleSessionNewMessageUpdate>[0]> = {}) {
  return handleSessionNewMessageUpdate({
    update,
    sessionId: 'session-1',
    encryptionKey: new Uint8Array(32),
    encryptionVariant: 'legacy',
    receivedMessageIds: new Set<string>(),
    lastObservedMessageSeq: 0,
    lastObservedUserMessageSeq: 0,
    emit: vi.fn(),
    debug: vi.fn(),
    debugLargeJson: vi.fn(),
    ...overrides,
  });
}

describe('handleSessionNewMessageUpdate', () => {
  it('projects transcript user rows as observation only', () => {
    const emit = vi.fn();

    const result = handle(createUserUpdate(), { emit });

    expect(emit).toHaveBeenCalledWith('user-message', expect.objectContaining({ localId: 'local-1' }));
    expect(result.lastObservedUserMessageSeq).toBe(7);
  });

  it('does not let the legacy string marker forge catch-up history classification', () => {
    const update = createUserUpdate();
    if (update.body?.t !== 'new-message') throw new Error('unexpected fixture');
    Reflect.set(update.body.message, 'transcriptObservationProvenance', 'history');
    const emit = vi.fn();
    const observeMessage = vi.fn();
    const observeCommittedUserMessageSeq = vi.fn();
    const onConnectedServiceTurnLifecycleEvent = vi.fn();

    const result = handle(update, {
      emit,
      observeMessage,
      observeCommittedUserMessageSeq,
      onConnectedServiceTurnLifecycleEvent,
    });

    expect(emit).toHaveBeenCalledWith('user-message', expect.objectContaining({ localId: 'local-1' }));
    expect(observeMessage).toHaveBeenCalledOnce();
    expect(observeCommittedUserMessageSeq).toHaveBeenCalledOnce();
    expect(onConnectedServiceTurnLifecycleEvent).toHaveBeenCalledOnce();
    expect(result.lastObservedUserMessageSeq).toBe(7);
  });

  it('does not let an ordinary live update forge history classification', () => {
    const update = createUserUpdate();
    if (update.body?.t !== 'new-message') throw new Error('unexpected fixture');
    update.body.message.sourceCreatedAt = 123;
    update.body.message.sourceUpdatedAt = 456;
    update.body.message.transcriptObservationProvenance = { kind: 'non_dependent', source: 'history' };
    const observeMessage = vi.fn();
    const observeCommittedUserMessageSeq = vi.fn();
    const onConnectedServiceTurnLifecycleEvent = vi.fn();

    handle(update, {
      observeMessage,
      observeCommittedUserMessageSeq,
      onConnectedServiceTurnLifecycleEvent,
    });

    expect(observeMessage).toHaveBeenCalledOnce();
    expect(observeCommittedUserMessageSeq).toHaveBeenCalledOnce();
    expect(onConnectedServiceTurnLifecycleEvent).toHaveBeenCalledOnce();
  });

  it('logs an invalid envelope by shape without leaking its string contents', () => {
    const debug = vi.fn();
    const update = createUserUpdate();
    if (update.body?.t !== 'new-message') throw new Error('unexpected fixture');
    update.body.message.content = { secret: 'DO_NOT_LOG' } as never;

    handle(update, { debug });

    const logged = JSON.stringify(debug.mock.calls);
    expect(logged).toContain('secret');
    expect(logged).not.toContain('DO_NOT_LOG');
  });
});
