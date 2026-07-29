import { describe, expect, it } from 'vitest';

import { decodeBase64, decrypt } from '@/api/encryption';

import { buildSessionMetadataEnvelopeCreateFields } from './buildSessionMetadataEnvelopeCreateFields';

const credentials = {
  token: 'token',
  encryption: {
    type: 'legacy' as const,
    secret: new Uint8Array(32).fill(7),
  },
};

const metadata = {
  path: '/private/worktree',
  host: 'private-host',
  homeDir: '/private/home',
  happyHomeDir: '/private/home/.happy',
  happyLibDir: '/private/home/.happy/lib',
  happyToolsDir: '/private/home/.happy/tools',
  summary: {
    text: 'Recipient-safe title',
    updatedAt: 10,
  },
  codexSessionId: 'private-native-session',
};

describe('buildSessionMetadataEnvelopeCreateFields', () => {
  it('keeps fresh plaintext session creation on the layout-0 compatibility payload while activation is closed', () => {
    const fields = buildSessionMetadataEnvelopeCreateFields({
      credentials,
      metadata,
      agentState: { privateAgentState: 'owner-only' },
      storedContentMode: 'plain',
      encryptionKey: credentials.encryption.secret,
      encryptionVariant: 'legacy',
    });

    expect(fields).not.toHaveProperty('metadataLayoutVersion');
    expect(fields).not.toHaveProperty('sharedMetadata');
    expect(fields).not.toHaveProperty('ownerMetadata');
    expect(JSON.parse(fields.metadata)).toEqual(metadata);
    expect(JSON.parse(fields.agentState!)).toEqual({
      privateAgentState: 'owner-only',
    });
  });

  it('keeps fresh encrypted session creation on the layout-0 transcript envelope while activation is closed', () => {
    const transcriptKey = new Uint8Array(32).fill(9);
    const fields = buildSessionMetadataEnvelopeCreateFields({
      credentials,
      metadata,
      agentState: { privateAgentState: 'owner-only' },
      storedContentMode: 'e2ee',
      encryptionKey: transcriptKey,
      encryptionVariant: 'legacy',
    });

    expect(fields).not.toHaveProperty('metadataLayoutVersion');
    expect(fields).not.toHaveProperty('sharedMetadata');
    expect(fields).not.toHaveProperty('ownerMetadata');
    expect(decrypt(
      transcriptKey,
      'legacy',
      decodeBase64(fields.metadata),
    )).toEqual(metadata);
    expect(decrypt(
      transcriptKey,
      'legacy',
      decodeBase64(fields.agentState!),
    )).toEqual({ privateAgentState: 'owner-only' });
  });
});
