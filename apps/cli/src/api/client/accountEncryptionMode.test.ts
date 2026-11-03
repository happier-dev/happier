import axios from 'axios';
import { describe, expect, it, vi } from 'vitest';
import { acquireRequesterAccountEncryptionCurrentness } from './accountEncryptionCurrentnessObservation';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';

import { readAccountEncryptionModeOnce } from './accountEncryptionMode';

const credentials = { token: 't', encryption: null };

describe('readAccountEncryptionModeOnce', () => {
  it('uses only the caller-bound Home transport and bearer', async () => {
    const request = vi.fn(async () => ({ status: 200, data: { mode: 'plain', updatedAt: 1 } }));

    await expect(readAccountEncryptionModeOnce({ credentials, request })).resolves.toEqual({
      kind: 'resolved',
      mode: 'plain',
    });
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([404, 403])('keeps observed Home %s mode-only compatibility without granting currentness', async status => {
    const accountId = `mode-compatibility-${status}`;
    const token = `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.fixture`;
    const serverBaseUrl = `https://mode-compatibility-${status}.test`;
    const channel = await createRequesterCurrentnessSocketHarness();
    vi.spyOn(axios, 'get').mockResolvedValue({ status, data: { error: 'unavailable' } });
    const observation = acquireRequesterAccountEncryptionCurrentness({ accountId, token, serverBaseUrl });
    try {
      await expect(observation.read()).rejects.toMatchObject({ code: 'account_encryption_currentness_unavailable' });
      const request = vi.fn(async () => ({ status: 200, data: { mode: 'plain', updatedAt: 1 } }));
      const result = readAccountEncryptionModeOnce({ credentials: { token, encryption: null },
        scope: { token, serverBaseUrl }, usage: 'identity', request });
      if (status === 404) {
        await expect(result).resolves.toEqual({ kind: 'resolved', mode: 'plain' });
        expect(request).toHaveBeenCalledOnce();
      } else {
        await expect(result).rejects.toMatchObject({ code: 'account_encryption_currentness_unavailable' });
        expect(request).not.toHaveBeenCalled();
      }
      expect(observation.isCurrent({ mode: 'plain', updatedAt: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null })).toBe(false);
    } finally { await observation.dispose(); await channel.close(); vi.restoreAllMocks(); }
  });

  it('retains HTTP and schema failures without interpreting an outage as plain', async () => {
    await expect(readAccountEncryptionModeOnce({
      credentials,
      request: async () => ({ status: 503, data: { mode: 'plain' } }),
    })).resolves.toEqual({ kind: 'http_error', status: 503 });
    await expect(readAccountEncryptionModeOnce({
      credentials,
      request: async () => ({ status: 200, data: { mode: 'unexpected' } }),
    })).resolves.toEqual({ kind: 'invalid_response', status: 200 });
  });
});
