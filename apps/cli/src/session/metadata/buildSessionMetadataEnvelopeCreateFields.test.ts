import { describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  openSessionOwnerMetadataEnvelopeV1,
  openSessionOwnerDisplayEnvelopeV1,
  openSessionSharedDisplayEnvelopeV1Sync,
  projectSessionDisplayV1,
  SessionDisplayProjectionV1Schema,
  SessionSharedMetadataV1Schema,
  SESSION_METADATA_LAYOUT_VERSION_V1,
} from '@happier-dev/protocol';

import { decodeBase64, decrypt } from '@/api/encryption';

import { buildSessionMetadataEnvelopeCreateFields } from './buildSessionMetadataEnvelopeCreateFields';
import { logger } from '@/ui/logger';

// Randomness is the external crypto boundary; projection, sealing and full tuple
// production remain real, including the successful owner seal after the failure.
vi.mock('node:crypto', async importOriginal => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomBytes: vi.fn((size: number) => actual.randomBytes(size)) };
});

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
  work: { authoringOriginV1: { kind: 'project' as const, accountId: 'original-account',
    workspace: { serverId: 'original-home', workspaceId: 'original-workspace', machineId: 'original-machine', rootPath: '/private/original' }, page: 'scripts' as const } },
};

describe('buildSessionMetadataEnvelopeCreateFields', () => {
  it('creates the authoritative full tuple with withdrawn display when display sealing fails', () => {
    const warning = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.mocked(randomBytes).mockImplementationOnce(() => { throw new Error('display randomness unavailable'); });
    try {
      const fields = buildSessionMetadataEnvelopeCreateFields({ credentials, accountEncryptionMode: 'e2ee',
        metadata, agentState: null, storedContentMode: 'plain' });
      expect(fields.displayProjectionV1).toBeNull();
      expect(SessionSharedMetadataV1Schema.parse(JSON.parse(fields.sharedMetadata.ciphertext))).toMatchObject({
        summary: { text: metadata.summary.text },
      });
      expect(openSessionOwnerMetadataEnvelopeV1({ accountMode: 'e2ee', envelope: fields.ownerMetadata,
        material: { type: 'legacy', secret: credentials.encryption.secret } }))
        .toMatchObject({ ok: true, ownerMetadata: { workspace: { path: metadata.path } } });
      expect(warning).toHaveBeenCalled();
    } finally { warning.mockRestore(); }
  });

  it('still refuses create when the authoritative owner seal fails after display withdrawal', () => {
    const warning = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.mocked(randomBytes)
      .mockImplementationOnce(() => { throw new Error('display randomness unavailable'); })
      .mockImplementationOnce(() => { throw new Error('full owner randomness unavailable'); });
    try {
      expect(() => buildSessionMetadataEnvelopeCreateFields({ credentials, accountEncryptionMode: 'e2ee',
        metadata, agentState: null, storedContentMode: 'plain' }))
        .toThrow('full owner randomness unavailable');
    } finally { warning.mockRestore(); }
  });

  it.each([
    ['plain', 'plain'],
    ['plain', 'e2ee'],
    ['e2ee', 'plain'],
    ['e2ee', 'e2ee'],
  ] as const)('creates both display leaves before a final Session ID exists (Session %s, Account %s)', (sessionMode, accountMode) => {
    const sessionKey = new Uint8Array(32).fill(19);
    const fields = buildSessionMetadataEnvelopeCreateFields({
      credentials,
      accountEncryptionMode: accountMode,
      metadata,
      agentState: { privateAgentState: 'owner-only' },
      ...(sessionMode === 'plain' ? { storedContentMode: 'plain' as const } : {
        storedContentMode: 'e2ee' as const,
        encryptionKey: sessionKey,
        encryptionVariant: 'dataKey' as const,
      }),
    });
    expect(fields).toHaveProperty('displayProjectionV1');
    const projection = SessionDisplayProjectionV1Schema.parse(Reflect.get(fields, 'displayProjectionV1'));
    expect(projection).toMatchObject({ v: 1, sourceMetadataVersion: 0, metadataLayoutVersion: 1 });
    expect(projection.shared.t).toBe(sessionMode === 'plain' ? 'plain' : 'encrypted');
    expect(projection.owner?.t).toBe(accountMode === 'plain' ? 'plain' : 'encrypted');
    expect(fields.ownerMetadata.t).toBe(accountMode === 'plain' ? 'plain' : 'encrypted');
    const sharedMetadata = SessionSharedMetadataV1Schema.parse(sessionMode === 'plain'
      ? JSON.parse(fields.sharedMetadata.ciphertext)
      : decrypt(sessionKey, 'dataKey', decodeBase64(fields.sharedMetadata.ciphertext)));
    expect(sharedMetadata.summary).toEqual(metadata.summary);
    const openedOwner = openSessionOwnerMetadataEnvelopeV1({ accountMode, envelope: fields.ownerMetadata,
      material: { type: 'legacy', secret: credentials.encryption.secret } });
    if (!openedOwner.ok) throw new Error('Expected the actual create owner tuple to open');
    expect(openedOwner.ownerMetadata.work?.authoringOriginV1).toEqual(metadata.work.authoringOriginV1);
    expect(JSON.stringify(sharedMetadata)).not.toContain('/private/original');
    if (accountMode === 'e2ee') expect(JSON.stringify(fields)).not.toContain('/private/original');
    const expected = projectSessionDisplayV1({ sharedMetadata, ownerMetadata: openedOwner.ownerMetadata });
    const shared = openSessionSharedDisplayEnvelopeV1Sync({ sessionMode, envelope: projection.shared,
      decryptPayload: value => decrypt(sessionKey, 'dataKey', decodeBase64(value)) });
    const owner = openSessionOwnerDisplayEnvelopeV1({ accountMode, envelope: projection.owner,
      material: { type: 'legacy', secret: credentials.encryption.secret } });
    expect(shared).toEqual({ ok: true, display: expected.shared });
    expect(owner).toEqual({ ok: true, display: expected.owner });
    expect(JSON.stringify(shared)).not.toContain(metadata.path);
    expect(JSON.stringify(shared)).not.toContain('privateAgentState');
    expect(JSON.stringify(owner)).not.toContain('privateAgentState');
    expect(JSON.stringify(owner)).toContain(metadata.path);
  });

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

});
