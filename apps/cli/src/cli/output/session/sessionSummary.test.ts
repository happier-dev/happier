import { describe, expect, it } from 'vitest';

import { encodeBase64, encryptLegacy } from '@/api/encryption';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { summarizeSessionRow } from '@/cli/output/session/sessionSummary';

describe('summarizeSessionRow', () => {
  const credentials = {
    token: 'token',
    encryption: {
      type: 'legacy',
      secret: new Uint8Array(32).fill(5),
    },
  } satisfies {
    token: string;
    encryption: {
      type: 'legacy';
      secret: Uint8Array;
    };
  };

  it('adds system session fields when metadata includes systemSessionV1', () => {
    const metadata = encodeBase64(encryptLegacy({
      tag: 'MySession',
      systemSessionV1: {
        v: 1,
        key: 'voice_carrier',
        hidden: true,
      },
    }, credentials.encryption.secret));

    const session = summarizeSessionRow({
      credentials,
      row: createSessionRecordFixture({
        id: 'session-system',
        metadata,
        metadataVersion: 1,
      }),
    });

    expect(session.isSystem).toBe(true);
    expect(session.systemPurpose).toBe('voice_carrier');
  });

  it('omits system session fields when metadata is missing systemSessionV1', () => {
    const metadata = encodeBase64(encryptLegacy({ tag: 'MySession' }, credentials.encryption.secret));
    const session = summarizeSessionRow({
      credentials,
      row: createSessionRecordFixture({
        id: 'session-user',
        metadata,
        metadataVersion: 1,
      }),
    });

    expect(session.isSystem).toBeUndefined();
    expect(session.systemPurpose).toBeUndefined();
  });

  it('is tolerant of malformed metadata', () => {
    const session = summarizeSessionRow({
      credentials,
      row: createSessionRecordFixture({
        id: 'session-malformed',
        metadata: 'not-base64',
      }),
    });

    expect(session.isSystem).toBeUndefined();
    expect(session.systemPurpose).toBeUndefined();
    expect(session).not.toHaveProperty('machineId');
    expect(session).not.toHaveProperty('permissionMode');
  });

  it('rejects encrypted rows without account key material even when metadata is empty', () => {
    expect(() => summarizeSessionRow({
      credentials: { token: 'token', encryption: null },
      row: createSessionRecordFixture({
        id: 'session-encrypted-keyless',
        encryptionMode: 'e2ee',
        metadata: '',
      }),
    })).toThrow(expect.objectContaining({ code: 'ACCOUNT_ENCRYPTION_KEY_REQUIRED' }));
  });

  it.each([
    ['read-only', 'read-only'],
    ['safe-yolo', 'safe-yolo'],
    ['yolo', 'yolo'],
    ['plan', 'plan'],
    ['default', 'default'],
    ['acceptEdits', 'safe-yolo'],
    ['bypassPermissions', 'yolo'],
  ])('projects the Machine binding and canonical permission intent for %s', (permissionMode, expectedMode) => {
    const metadata = encodeBase64(encryptLegacy({
      machineId: ' machine-target ',
      permissionMode,
      permissionModeUpdatedAt: 123,
    }, credentials.encryption.secret));
    const session = summarizeSessionRow({
      credentials,
      row: createSessionRecordFixture({ id: 'session-binding', metadata }),
    });

    expect(session.machineId).toBe('machine-target');
    expect(session.permissionMode).toBe(expectedMode);
  });

  it.each([
    {},
    { machineId: '  ', permissionMode: 'unknown' },
    { machineId: 123, permissionMode: null },
    { host: 'machine-target', path: '/workspace' },
  ])('omits summary authority when metadata does not supply it: %j', (value) => {
    const metadata = encodeBase64(encryptLegacy(value, credentials.encryption.secret));
    const session = summarizeSessionRow({
      credentials,
      row: createSessionRecordFixture({ id: 'session-missing-authority', metadata }),
    });

    expect(session).not.toHaveProperty('machineId');
    expect(session).not.toHaveProperty('permissionMode');
  });

  it.each([credentials, { token: 'token', encryption: null }])('projects plaintext metadata and encryption from the row mode', (accountCredentials) => {
    const session = summarizeSessionRow({
      credentials: accountCredentials,
      row: createSessionRecordFixture({
        id: 'session-plain-binding',
        encryptionMode: 'plain',
        metadata: JSON.stringify({ machineId: 'machine-target', permissionMode: 'unknown' }),
      }),
    });

    expect(session.machineId).toBe('machine-target');
    expect(session.encryption.type).toBe('plain');
    expect(session).not.toHaveProperty('permissionMode');
  });
});
