import { describe, expect, it } from 'vitest';
import {
  openSessionOwnerMetadataEnvelopeV1,
  SESSION_METADATA_LAYOUT_VERSION_V1,
} from '@happier-dev/protocol';

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
  it('creates a layout-1 plaintext tuple with a plain owner envelope and no account key', () => {
    const fields = buildSessionMetadataEnvelopeCreateFields({
      credentials: {
        token: 'token-only',
        encryption: null,
      },
      accountEncryptionMode: 'plain',
      metadata,
      agentState: { privateAgentState: 'owner-only' },
      storedContentMode: 'plain',
    });

    expect(fields.metadataLayoutVersion)
      .toBe(SESSION_METADATA_LAYOUT_VERSION_V1);
    const sharedMetadata = JSON.parse(
      fields.sharedMetadata.ciphertext,
    );
    expect(sharedMetadata).toMatchObject({
      v: 1,
      summary: metadata.summary,
    });
    expect(sharedMetadata).not.toHaveProperty('path');
    expect(sharedMetadata).not.toHaveProperty('host');
    expect(fields.ownerMetadata).toMatchObject({
      t: 'plain',
      v: {
        workspace: {
          path: metadata.path,
          host: metadata.host,
          homeDir: metadata.homeDir,
        },
      },
    });
    expect(JSON.parse(fields.agentState!)).toEqual({
      privateAgentState: 'owner-only',
    });
  });

  it('creates a layout-1 encrypted tuple with an account-sealed owner envelope', () => {
    const transcriptKey = new Uint8Array(32).fill(9);
    const fields = buildSessionMetadataEnvelopeCreateFields({
      credentials,
      accountEncryptionMode: 'e2ee',
      metadata,
      agentState: { privateAgentState: 'owner-only' },
      storedContentMode: 'e2ee',
      encryptionKey: transcriptKey,
      encryptionVariant: 'legacy',
    });

    expect(fields.metadataLayoutVersion)
      .toBe(SESSION_METADATA_LAYOUT_VERSION_V1);
    const sharedMetadata = decrypt(
      transcriptKey,
      'legacy',
      decodeBase64(fields.sharedMetadata.ciphertext),
    );
    expect(sharedMetadata).toMatchObject({
      v: 1,
      summary: metadata.summary,
    });
    expect(sharedMetadata).not.toHaveProperty('path');
    expect(sharedMetadata).not.toHaveProperty('host');
    expect(fields.ownerMetadata.t).toBe('encrypted');
    expect(openSessionOwnerMetadataEnvelopeV1({
      accountMode: 'e2ee',
      envelope: fields.ownerMetadata,
      material: {
        type: 'legacy',
        secret: credentials.encryption.secret,
      },
    })).toMatchObject({
      ok: true,
      ownerMetadata: {
        workspace: {
          path: metadata.path,
          host: metadata.host,
          homeDir: metadata.homeDir,
        },
      },
    });
    expect(decrypt(
      transcriptKey,
      'legacy',
      decodeBase64(fields.agentState!),
    )).toEqual({ privateAgentState: 'owner-only' });
  });

  it('selects the Account-owned envelope independently from Session stored-content mode', () => {
    const accountPlainSessionE2ee = buildSessionMetadataEnvelopeCreateFields({
      credentials,
      accountEncryptionMode: 'plain',
      metadata,
      agentState: null,
      storedContentMode: 'e2ee',
      encryptionKey: credentials.encryption.secret,
      encryptionVariant: 'legacy',
    });
    const accountE2eeSessionPlain = buildSessionMetadataEnvelopeCreateFields({
      credentials,
      accountEncryptionMode: 'e2ee',
      metadata,
      agentState: null,
      storedContentMode: 'plain',
    });

    expect(accountPlainSessionE2ee.ownerMetadata.t).toBe('plain');
    expect(accountE2eeSessionPlain.ownerMetadata.t).toBe('encrypted');
    expect(JSON.parse(accountE2eeSessionPlain.sharedMetadata.ciphertext))
      .toMatchObject({ v: 1, summary: metadata.summary });
  });
});
