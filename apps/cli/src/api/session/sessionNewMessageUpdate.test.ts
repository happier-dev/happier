import { describe, expect, it, vi } from 'vitest';

import type { Update } from '../types';
import { encrypt } from '../encryption';
import { handleSessionNewMessageUpdate } from './sessionNewMessageUpdate';

describe('handleSessionNewMessageUpdate', () => {
  it('logs invalid content envelope shapes without leaking string contents', () => {
    const pendingMessages: any[] = [];
    const emitted: any[] = [];
    const debug = vi.fn();

    const update = {
      id: 'u1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 'sess_1',
        message: {
          id: 'm1',
          seq: 1,
          content: { foo: 'bar', secret: 'SUPER_SECRET_VALUE' },
          localId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    } as unknown as Update;

    handleSessionNewMessageUpdate({
      update,
      sessionId: 'sess_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      receivedMessageIds: new Set<string>(),
      lastObservedMessageSeq: 0,
      lastObservedUserMessageSeq: 0,
      hasSelfEchoSuppressedLocalId: () => false,
      hasAgentQueueEchoSuppressedLocalId: () => false,
      markAgentQueueEchoSuppressedLocalId: () => void 0,
      hasPendingQueueMaterializedLocalId: () => false,
      deleteMaterializedLocalId: () => void 0,
      pendingMessageCallback: null,
      pendingMessages,
      emit: (event, payload) => emitted.push({ event, payload }),
      debug,
      debugLargeJson: () => void 0,
    });

    expect(debug).toHaveBeenCalled();
    const calls = JSON.stringify(debug.mock.calls);
    expect(calls).toContain('secret');
    expect(calls).not.toContain('SUPER_SECRET_VALUE');
    expect(pendingMessages).toHaveLength(0);
    expect(emitted.some((e: any) => e.event === 'user-message')).toBe(false);
  });

  it('delivers legacy string user prompts to the agent queue', () => {
    const pendingMessages: any[] = [];
    const emitted: any[] = [];

    const update = {
      id: 'u1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 'sess_1',
        message: {
          id: 'm1',
          seq: 1,
          content: { t: 'plain', v: { role: 'user', content: 'hello legacy' } },
          localId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    } as unknown as Update;

    handleSessionNewMessageUpdate({
      update,
      sessionId: 'sess_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      receivedMessageIds: new Set<string>(),
      lastObservedMessageSeq: 0,
      lastObservedUserMessageSeq: 0,
      hasSelfEchoSuppressedLocalId: () => false,
      hasAgentQueueEchoSuppressedLocalId: () => false,
      markAgentQueueEchoSuppressedLocalId: () => void 0,
      hasPendingQueueMaterializedLocalId: () => false,
      deleteMaterializedLocalId: () => void 0,
      pendingMessageCallback: null,
      pendingMessages,
      emit: (event, payload) => emitted.push({ event, payload }),
      debug: () => void 0,
      debugLargeJson: () => void 0,
    });

    expect(pendingMessages).toHaveLength(1);
    expect(pendingMessages[0]?.content?.type).toBe('text');
    expect(pendingMessages[0]?.content?.text).toBe('hello legacy');
    expect(emitted.some((e: any) => e.event === 'user-message')).toBe(true);
  });

  it('delivers legacy ciphertext string content envelopes to the agent queue', () => {
    const pendingMessages: any[] = [];
    const emitted: any[] = [];

    const encryptionKey = new Uint8Array(32);
    encryptionKey.fill(7);

    const rawBody = {
      role: 'user',
      content: { type: 'text', text: 'hello encrypted' },
    };
    const ciphertextBytes = encrypt(encryptionKey, 'legacy', rawBody);
    const ciphertext = Buffer.from(ciphertextBytes).toString('base64');

    const update = {
      id: 'u1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 'sess_1',
        message: {
          id: 'm1',
          seq: 1,
          // Legacy server/client shape: `content` was just ciphertext.
          content: ciphertext,
          localId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    } as unknown as Update;

    handleSessionNewMessageUpdate({
      update,
      sessionId: 'sess_1',
      encryptionKey,
      encryptionVariant: 'legacy',
      receivedMessageIds: new Set<string>(),
      lastObservedMessageSeq: 0,
      lastObservedUserMessageSeq: 0,
      hasSelfEchoSuppressedLocalId: () => false,
      hasAgentQueueEchoSuppressedLocalId: () => false,
      markAgentQueueEchoSuppressedLocalId: () => void 0,
      hasPendingQueueMaterializedLocalId: () => false,
      deleteMaterializedLocalId: () => void 0,
      pendingMessageCallback: null,
      pendingMessages,
      emit: (event, payload) => emitted.push({ event, payload }),
      debug: () => void 0,
      debugLargeJson: () => void 0,
    });

    expect(pendingMessages).toHaveLength(1);
    expect(pendingMessages[0]?.content?.type).toBe('text');
    expect(pendingMessages[0]?.content?.text).toBe('hello encrypted');
    expect(emitted.some((e: any) => e.event === 'user-message')).toBe(true);
  });

  it('does not drop user prompts when agent-queue echo suppression is set but no callback is attached', () => {
    const pendingMessages: any[] = [];
    const emitted: any[] = [];

    const update = {
      id: 'u1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 'sess_1',
        message: {
          id: 'm1',
          seq: 1,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'hello' },
              localId: 'l1',
              meta: { source: 'ui', sentFrom: 'ios' },
            },
          },
          localId: 'l1',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    } as unknown as Update;

    handleSessionNewMessageUpdate({
      update,
      sessionId: 'sess_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      receivedMessageIds: new Set<string>(),
      lastObservedMessageSeq: 0,
      lastObservedUserMessageSeq: 0,
      hasSelfEchoSuppressedLocalId: () => false,
      hasAgentQueueEchoSuppressedLocalId: () => true,
      markAgentQueueEchoSuppressedLocalId: () => void 0,
      hasPendingQueueMaterializedLocalId: () => false,
      deleteMaterializedLocalId: () => void 0,
      pendingMessageCallback: null,
      pendingMessages,
      emit: (event, payload) => emitted.push({ event, payload }),
      debug: () => void 0,
      debugLargeJson: () => void 0,
    });

    expect(pendingMessages).toHaveLength(1);
    expect(pendingMessages[0]?.content?.type).toBe('text');
    expect(pendingMessages[0]?.content?.text).toBe('hello');
    expect(emitted.some((e: any) => e.event === 'user-message')).toBe(true);
  });

  it('delivers daemon-initial-prompt user messages even when they originate from the CLI', () => {
    const pendingMessages: any[] = [];
    const emitted: any[] = [];
    const pendingMessageCallback = (msg: any) => pendingMessages.push(msg);

    const update = {
      id: 'u1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 'sess_1',
        message: {
          id: 'm1',
          seq: 1,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'daemon initial prompt' },
              localId: 'l1',
              meta: { source: 'daemon-initial-prompt', sentFrom: 'cli' },
            },
          },
          localId: 'l1',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    } as unknown as Update;

    handleSessionNewMessageUpdate({
      update,
      sessionId: 'sess_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      receivedMessageIds: new Set<string>(),
      lastObservedMessageSeq: 0,
      lastObservedUserMessageSeq: 0,
      hasSelfEchoSuppressedLocalId: () => true,
      hasAgentQueueEchoSuppressedLocalId: () => false,
      markAgentQueueEchoSuppressedLocalId: () => void 0,
      hasPendingQueueMaterializedLocalId: () => false,
      deleteMaterializedLocalId: () => void 0,
      pendingMessageCallback,
      pendingMessages: [],
      emit: (event, payload) => emitted.push({ event, payload }),
      debug: () => void 0,
      debugLargeJson: () => void 0,
    });

    expect(pendingMessages).toHaveLength(1);
    expect(pendingMessages[0]?.content?.type).toBe('text');
    expect(pendingMessages[0]?.content?.text).toBe('daemon initial prompt');
    expect(emitted.some((e: any) => e.event === 'user-message')).toBe(true);
  });
});
