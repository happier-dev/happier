import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { encodeBase64, encrypt } from '@/api/encryption';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { readCurrentMessageActionReferenceRowV1 } from './messageActionReference';

const secret = new Uint8Array(32).fill(3);
const credentials = { token: 'account-token', encryption: { type: 'legacy' as const, secret } };
const reference = {
  v: 1, sessionId: 'c1234567890123456789012345', messageId: 'message_1',
  observedRevision: 'message-updated-at:10',
} as const;
const durableMessage = {
  sessionId: reference.sessionId, messageId: reference.messageId,
  observedRevision: reference.observedRevision, seq: 7, messageRole: 'agent' as const,
};
const decryptedContent = { role: 'agent', content: { type: 'text', text: 'Fresh text' } };

function serveRow(mode: 'plain' | 'e2ee', content: unknown) {
  // Only HTTP is substituted; Session resolution, envelope parsing and crypto remain real.
  vi.spyOn(axios, 'get').mockImplementation(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness') {
      return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
    }
    if (path === `/v2/sessions/${reference.sessionId}`) {
      return { status: 200, data: { session: createSessionRecordFixture({
        id: reference.sessionId, encryptionMode: mode,
      }) } };
    }
    if (path === `/v1/sessions/${reference.sessionId}/messages`) {
      return { status: 200, data: { messages: [{
        id: reference.messageId, seq: durableMessage.seq,
        createdAt: 10, updatedAt: 10,
        messageRole: durableMessage.messageRole,
        messageActionReference: reference, content,
      }], hasMore: false } };
    }
    throw new Error(`Unexpected HTTP request: ${path}`);
  });
}

describe('readCurrentMessageActionReferenceRowV1', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['plain', 'e2ee'] as const)('reads exact %s content through the real Session owner', async (mode) => {
    serveRow(mode, mode === 'plain'
      ? { t: 'plain', v: decryptedContent }
      : { t: 'encrypted', c: encodeBase64(encrypt(secret, 'legacy', decryptedContent)) });
    await expect(readCurrentMessageActionReferenceRowV1({
      credentials: mode === 'plain' ? { token: credentials.token, encryption: null } : credentials,
      token: credentials.token, reference, durableMessage,
    })).resolves.toEqual({ ...durableMessage, decryptedContent });
  });

  it.each(['plain', 'e2ee'] as const)('does not disclose a mismatched envelope under %s mode', async (mode) => {
    serveRow(mode, mode === 'e2ee'
      ? { t: 'plain', v: decryptedContent }
      : { t: 'encrypted', c: encodeBase64(encrypt(secret, 'legacy', decryptedContent)) });
    await expect(readCurrentMessageActionReferenceRowV1({
      credentials, token: credentials.token, reference, durableMessage,
    })).resolves.toBeNull();
  });
});
