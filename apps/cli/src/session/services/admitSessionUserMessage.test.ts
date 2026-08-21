import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  decryptSessionPayload,
  type SessionEncryptionContext,
} from '@/session/transport/encryption/sessionEncryptionContext';

/**
 * Sealing determinism and delivery mode are independent contracts.
 *
 * A retry that lost only its acknowledgement re-seals the SAME localId and the
 * SAME text; the message owner reconciles it by comparing stored content, so a
 * re-seal that differs by one random nonce byte is refused as a conflict and the
 * admission never resolves. Determinism therefore belongs to every admission,
 * not only to the one that also asks for a delivery condition.
 */

type EnqueueBody = Readonly<{
  localId: string;
  ciphertext?: string;
  content?: unknown;
  deliveryMode?: string;
}>;

describe('admitSessionUserMessageToPendingQueue', () => {
  const ctx: SessionEncryptionContext = {
    encryptionKey: new Uint8Array(32).fill(7),
    encryptionVariant: 'dataKey',
  };
  const machineKey = new Uint8Array(32).fill(1);
  const credentials = {
    token: 'token',
    encryption: { type: 'dataKey', publicKey: machineKey, machineKey },
  } as const;

  afterEach(() => {
    vi.doUnmock('@/api/session/pendingQueueV2Transport');
    vi.resetModules();
    vi.clearAllMocks();
  });

  async function loadAdmit() {
    // The HTTP enqueue is the genuine system boundary; everything beneath it,
    // including the real sealing, stays live.
    const enqueue = vi.fn(async (_request: Readonly<{ body: EnqueueBody }>) => undefined);
    vi.doMock('@/api/session/pendingQueueV2Transport', () => ({
      enqueuePendingQueueV2MessageViaHttp: enqueue,
    }));
    const { admitSessionUserMessageToPendingQueue } = await import('./admitSessionUserMessage');
    const bodies = (): readonly EnqueueBody[] => enqueue.mock.calls.map((call) => call[0].body);
    return { admit: admitSessionUserMessageToPendingQueue, enqueue, bodies };
  }

  function transitionAdmission(overrides: Readonly<{ text?: string; localId?: string }> = {}) {
    return {
      credentials,
      sessionId: 'sess-1',
      mode: 'e2ee' as const,
      ctx,
      localId: overrides.localId ?? 'transition-local-1',
      text: overrides.text ?? 'switch agent and continue',
      permissionIntent: 'default' as const,
    };
  }

  it('re-seals an Agent-transition retry byte-identically for the same local id and text', async () => {
    const { admit, bodies } = await loadAdmit();

    // The same-Session Agent transition admits the user's own prompt and asks
    // for no delivery condition. A lost acknowledgement makes it retry with the
    // identical localId and text.
    await expect(admit(transitionAdmission())).resolves.toEqual({ status: 'admitted' });
    await expect(admit(transitionAdmission())).resolves.toEqual({ status: 'admitted' });

    const [first, retry] = bodies();
    expect(first?.ciphertext).toEqual(expect.any(String));
    expect(retry?.ciphertext).toBe(first?.ciphertext);
    expect(decryptSessionPayload({ ctx, ciphertextBase64: String(first?.ciphertext) })).toMatchObject({
      role: 'user',
      content: { type: 'text', text: 'switch agent and continue' },
    });
  });

  it('derives a different sealing when the same local id carries different text', async () => {
    const { admit, bodies } = await loadAdmit();

    await admit(transitionAdmission({ text: 'first intent' }));
    await admit(transitionAdmission({ text: 'edited intent' }));

    const [first, changed] = bodies();
    // The plaintext is an input to the derived nonce, so a changed payload can
    // never reuse the nonce that sealed the previous one under the same key.
    expect(changed?.ciphertext).not.toBe(first?.ciphertext);
    expect(decryptSessionPayload({ ctx, ciphertextBase64: String(first?.ciphertext) })).toMatchObject({
      content: { type: 'text', text: 'first intent' },
    });
    expect(decryptSessionPayload({ ctx, ciphertextBase64: String(changed?.ciphertext) })).toMatchObject({
      content: { type: 'text', text: 'edited intent' },
    });
  });

  it('applies the delivery condition only to the continuation nudge', async () => {
    const { admit, bodies } = await loadAdmit();

    await admit(transitionAdmission());
    await admit({
      ...transitionAdmission({ localId: 'connected-service-continuation:test', text: 'continue' }),
      requestedAction: { v: 1, kind: 'send_now' } as const,
      pendingAdmissionMode: 'continuation_if_no_queued_user_input' as const,
    });
    await admit({
      ...transitionAdmission({ localId: 'connected-service-continuation:test', text: 'continue' }),
      requestedAction: { v: 1, kind: 'send_now' } as const,
      pendingAdmissionMode: 'continuation_if_no_queued_user_input' as const,
    });

    const [transition, nudge, nudgeRetry] = bodies();
    // The user's own prompt must never inherit "yield to any queued user input".
    expect(transition).not.toHaveProperty('deliveryMode');
    expect(nudge?.deliveryMode).toBe('continuation_if_no_queued_user_input');
    expect(nudgeRetry?.deliveryMode).toBe('continuation_if_no_queued_user_input');
    expect(nudgeRetry?.ciphertext).toBe(nudge?.ciphertext);
  });

  it('carries the delivery condition on a plain-mode session without sealing it', async () => {
    const { admit, bodies } = await loadAdmit();

    await admit({ ...transitionAdmission(), mode: 'plain' as const });
    await admit({
      ...transitionAdmission({ localId: 'connected-service-continuation:test', text: 'continue' }),
      mode: 'plain' as const,
      pendingAdmissionMode: 'continuation_if_no_queued_user_input' as const,
    });

    const [transition, nudge] = bodies();
    expect(transition?.ciphertext).toBeUndefined();
    expect(transition?.content).toMatchObject({ t: 'plain', v: { role: 'user' } });
    expect(transition).not.toHaveProperty('deliveryMode');
    expect(nudge?.deliveryMode).toBe('continuation_if_no_queued_user_input');
  });
});
