import { describe, expect, it } from 'vitest';

import type { Credentials } from '@/persistence';
import { encryptStoredSessionPayload, resolveSessionEncryptionContextFromCredentials } from '@/session/transport/encryption/sessionEncryptionContext';

import { resolveVendorResumeIdForExistingSession } from './resolveVendorResumeIdForExistingSession';

describe('resolveVendorResumeIdForExistingSession', () => {
  it('derives the Claude resume id from the persisted id alone', () => {
    // `AM-24`: no continuity proof gate. The persisted id is the whole claim,
    // and a dead one fails loudly at the first turn like any other resume.
    const rawSession = {
      encryptionMode: 'plain',
      metadata: JSON.stringify({ flavor: 'claude', claudeSessionId: 'claude-session-1' }),
      dataEncryptionKey: null,
    };

    expect(resolveVendorResumeIdForExistingSession({ agent: 'claude', credentials: null, rawSession }))
      .toBe('claude-session-1');

    expect(resolveVendorResumeIdForExistingSession({
      agent: 'claude',
      credentials: null,
      rawSession: {
        ...rawSession,
        metadata: JSON.stringify({
          flavor: 'claude',
          claudeSessionId: 'claude-session-1',
          claudeTranscriptPath: '/tmp/claude-session-1.jsonl',
        }),
      },
    })).toBe('claude-session-1');
  });

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

  it('ignores legacy customAcp explicit agents and uses canonical metadata inference instead', () => {
    const rawSession = {
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        flavor: 'customAcp',
        agentRuntimeDescriptorV1: {
          v: 1,
          agentId: 'codex',
          provider: { backendMode: 'appServer', providerSessionId: 'vendor-compat-1' },
        },
        codexSessionId: 'vendor-compat-1',
      }),
      dataEncryptionKey: null,
    };

    expect(resolveVendorResumeIdForExistingSession({ agent: 'customAcp', credentials: null, rawSession })).toBe(
      'vendor-compat-1',
    );
  });
});
