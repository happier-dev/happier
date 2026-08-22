import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveSessionTransportContext: vi.fn(),
  fetchEncryptedTranscriptMessagesPage: vi.fn(),
  decryptSessionPayload: vi.fn(),
}));

vi.mock('@/session/services/resolveSessionTransportContext', () => ({
  resolveSessionTransportContext: mocks.resolveSessionTransportContext,
}));
vi.mock('@/session/replay/fetchEncryptedTranscriptMessages', () => ({
  fetchEncryptedTranscriptMessagesPage: mocks.fetchEncryptedTranscriptMessagesPage,
}));
vi.mock('@/session/transport/encryption/sessionEncryptionContext', () => ({
  decryptSessionPayload: mocks.decryptSessionPayload,
}));

import { readCurrentMessageActionReferenceRowV1 } from './messageActionReference';

const credentials = { token: 'account-token', encryption: null } as const;
const reference = {
  v: 1,
  sessionId: 'session_1',
  messageId: 'message_1',
  observedRevision: 'message-updated-at:10',
} as const;
const durableMessage = {
  sessionId: reference.sessionId,
  messageId: reference.messageId,
  observedRevision: reference.observedRevision,
  seq: 7,
  messageRole: 'agent' as const,
};

describe('readCurrentMessageActionReferenceRowV1', () => {
  beforeEach(() => {
    mocks.resolveSessionTransportContext.mockReset();
    mocks.fetchEncryptedTranscriptMessagesPage.mockReset();
    mocks.decryptSessionPayload.mockReset();
  });

  it('uses the session crypto owner and rechecks the exact durable sequence row', async () => {
    const signal = new AbortController().signal;
    mocks.resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: reference.sessionId,
      mode: 'e2ee',
      ctx: { encryptionKey: new Uint8Array([1]), encryptionVariant: 'dataKey' },
    });
    mocks.fetchEncryptedTranscriptMessagesPage.mockResolvedValue({
      messages: [{
        id: reference.messageId,
        seq: durableMessage.seq,
        messageRole: durableMessage.messageRole,
        messageActionReference: reference,
        content: { t: 'encrypted', c: 'ciphertext' },
      }],
      hasMore: false,
      nextBeforeSeq: null,
      nextAfterSeq: null,
    });
    const decryptedContent = { role: 'agent', content: { type: 'text', text: 'Fresh text' } };
    mocks.decryptSessionPayload.mockReturnValue(decryptedContent);

    await expect(readCurrentMessageActionReferenceRowV1({
      credentials,
      token: credentials.token,
      reference,
      durableMessage,
      signal,
    })).resolves.toEqual({
      sessionId: reference.sessionId,
      messageId: reference.messageId,
      observedRevision: reference.observedRevision,
      seq: durableMessage.seq,
      messageRole: 'agent',
      decryptedContent,
    });
    expect(mocks.resolveSessionTransportContext).toHaveBeenCalledWith({
      credentials,
      idOrPrefix: reference.sessionId,
    });
    expect(mocks.fetchEncryptedTranscriptMessagesPage).toHaveBeenCalledWith({
      token: credentials.token,
      sessionId: reference.sessionId,
      afterSeq: 6,
      limit: 1,
      scope: 'all',
      signal,
    });
    expect(mocks.decryptSessionPayload).toHaveBeenCalledWith({
      ctx: { encryptionKey: new Uint8Array([1]), encryptionVariant: 'dataKey' },
      ciphertextBase64: 'ciphertext',
    });
  });

  it('fails closed on an envelope that disagrees with the session encryption mode', async () => {
    mocks.resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: reference.sessionId,
      mode: 'e2ee',
      ctx: { encryptionKey: new Uint8Array([1]), encryptionVariant: 'dataKey' },
    });
    mocks.fetchEncryptedTranscriptMessagesPage.mockResolvedValue({
      messages: [{
        id: reference.messageId,
        seq: durableMessage.seq,
        messageRole: durableMessage.messageRole,
        messageActionReference: reference,
        content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'wrong envelope' } } },
      }],
      hasMore: false,
      nextBeforeSeq: null,
      nextAfterSeq: null,
    });

    await expect(readCurrentMessageActionReferenceRowV1({
      credentials,
      token: credentials.token,
      reference,
      durableMessage,
    })).resolves.toBeNull();
    expect(mocks.decryptSessionPayload).not.toHaveBeenCalled();
  });
});
