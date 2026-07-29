import { beforeEach, describe, expect, it, vi } from 'vitest';

import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { encodeAutomationTemplateCiphertextForAccount } from './encodeAutomationTemplateCiphertextForAccount';

const serverFetchSpy = vi.fn(async (..._args: unknown[]) => ({
  ok: true,
  status: 200,
  json: async () => ({ mode: 'plain', updatedAt: 1 }),
}));

vi.mock('@/sync/http/client', () => ({
  serverFetch: (...args: unknown[]) => serverFetchSpy(...args),
}));

describe('encodeAutomationTemplateCiphertextForAccount', () => {
  beforeEach(() => {
    invalidateAccountEncryptionModeCache();
    serverFetchSpy.mockClear();
  });

  it('returns plaintext envelope for plain accounts without calling encryptRaw', async () => {
    const encryptRaw = vi.fn(async () => 'ciphertext-base64');
    serverFetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ mode: 'plain', updatedAt: 1 }),
    });

    const templateCiphertext = await encodeAutomationTemplateCiphertextForAccount({
      credentials: { token: 't' } as any,
      template: { directory: '/tmp/project', prompt: 'Hi', transcriptStorage: 'direct', existingSessionId: 'session-1' },
      encryptRaw,
    });

    const envelope = JSON.parse(templateCiphertext);
    expect(envelope.kind).toBe('happier_automation_template_plain_v1');
    expect(envelope.payload).toEqual(expect.objectContaining({ directory: '/tmp/project', prompt: 'Hi', transcriptStorage: 'direct', existingSessionId: 'session-1' }));
    expect(encryptRaw).not.toHaveBeenCalled();
  });

  it('returns encrypted envelope for e2ee accounts and calls encryptRaw', async () => {
    const encryptRaw = vi.fn(async () => 'ciphertext-base64');
    serverFetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ mode: 'e2ee', updatedAt: 1 }),
    });

    const templateCiphertext = await encodeAutomationTemplateCiphertextForAccount({
      credentials: { token: 't' } as any,
      template: { directory: '/tmp/project', prompt: 'Hi', existingSessionId: 'session-1' },
      encryptRaw,
    });

    const envelope = JSON.parse(templateCiphertext);
    expect(envelope.kind).toBe('happier_automation_template_encrypted_v1');
    expect(envelope.payloadCiphertext).toBe('ciphertext-base64');
    expect(encryptRaw).toHaveBeenCalled();
  });
});
