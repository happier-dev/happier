import { describe, expect, it } from 'vitest';

import type { Credentials } from '@/persistence';
import { encryptStoredSessionPayload, resolveSessionEncryptionContextFromCredentials } from '@/session/transport/encryption/sessionEncryptionContext';

import { resolveVendorResumeIdForExistingSession } from './resolveVendorResumeIdForExistingSession';

describe('resolveVendorResumeIdForExistingSession', () => {
  it('extracts vendor resume id for plaintext sessions without credentials', () => {
    const rawSession = {
      encryptionMode: 'plain',
      metadata: JSON.stringify({ flavor: 'codex', codexSessionId: 'vendor-plain-1' }),
      dataEncryptionKey: null,
    };

    expect(resolveVendorResumeIdForExistingSession({ agent: 'codex', credentials: null, rawSession })).toBe('vendor-plain-1');
  });

  it('extracts vendor resume id for e2ee sessions using legacy credentials', () => {
    const credentials: Credentials = {
      token: 't',
      encryption: {
        type: 'legacy',
        secret: new Uint8Array(32).fill(7),
      },
    };

    const ctx = resolveSessionEncryptionContextFromCredentials(credentials);
    const ciphertext = encryptStoredSessionPayload({
      mode: 'e2ee',
      ctx,
      payload: { flavor: 'codex', codexSessionId: 'vendor-e2ee-1' },
    });

    const rawSession = {
      encryptionMode: 'e2ee',
      metadata: ciphertext,
      dataEncryptionKey: null,
    };

    expect(resolveVendorResumeIdForExistingSession({ agent: 'codex', credentials, rawSession })).toBe('vendor-e2ee-1');
  });
});

