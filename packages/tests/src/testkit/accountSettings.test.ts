import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
  parseAccountStoredContentCompatibilityHttpHeadersV1,
} from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import { openAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';

import { upsertEncryptedAccountSettingsV2, upsertPlainAccountSettingsV2 } from './accountSettings';

afterEach(() => vi.unstubAllGlobals());

describe('Account Settings V2 test writers', () => {
  for (const mode of ['plain', 'encrypted'] as const) {
    it(`declares a preserving writer and preserves the complete ${mode} settings document`, async () => {
      const settings = { profiles: [{ id: 'profile', futureField: { enabled: true } }], futureSetting: 42 };
      const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(7) };
      let posted: RequestInit | undefined;
      // Fetch is the HTTP boundary; serialization and account encryption stay real.
      vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
        if (init?.method === 'POST') {
          posted = init;
          return Response.json({ success: true, version: 4 });
        }
        return Response.json({ content: null, version: 3 });
      }));

      const params = { baseUrl: 'http://settings.test', token: 'test-token', settings };
      const version = mode === 'encrypted'
        ? await upsertEncryptedAccountSettingsV2({ ...params, material })
        : await upsertPlainAccountSettingsV2(params);

      expect(version).toBe(4);
      expect(posted).toBeDefined();
      expect(parseAccountStoredContentCompatibilityHttpHeadersV1(
        Object.fromEntries(new Headers(posted?.headers)),
      )).toEqual({ status: 'valid', declaration: CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION });
      // This is the captured JSON HTTP boundary, whose shape is asserted below.
      const body = JSON.parse(String(posted?.body)) as { expectedVersion: number; content: { t: string; c: string; v: unknown } };
      expect(body.expectedVersion).toBe(3);
      expect(body.content.t).toBe(mode);
      const written = mode === 'encrypted'
        ? openAccountScopedBlobCiphertext({ kind: 'account_settings', material, ciphertext: body.content.c })?.value
        : body.content.v;
      expect(written).toEqual(settings);
    });
  }
});
