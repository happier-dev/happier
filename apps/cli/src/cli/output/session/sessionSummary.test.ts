import { describe, expect, it } from 'vitest';

import {
  createPlainSessionOwnerMetadataEnvelopeV1,
  SessionOwnerMetadataV1Schema,
} from '@happier-dev/protocol';
import { encodeBase64, encryptLegacy } from '@/api/encryption';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import {
  summarizeSessionRow as summarizeSessionRowOwner,
} from '@/cli/output/session/sessionSummary';

function summarizeSessionRow(
  params: Omit<
    Parameters<typeof summarizeSessionRowOwner>[0],
    'accountEncryptionMode'
  > & Partial<Pick<
    Parameters<typeof summarizeSessionRowOwner>[0],
    'accountEncryptionMode'
  >>,
) {
  return summarizeSessionRowOwner({
    ...params,
    accountEncryptionMode: params.accountEncryptionMode ?? 'plain',
  });
}

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

  it('summarizes shared and owner fields from a sealed layout-v1 owner envelope', () => {
    const ownerMetadata = SessionOwnerMetadataV1Schema.parse({
      v: 1,
      workspace: {
        path: '/private/worktree',
        host: 'private-host',
      },
      nativeSession: {
        tag: 'private-tag',
      },
      system: {
        systemSessionV1: {
          v: 1,
          key: 'voice_carrier',
          hidden: true,
        },
      },
    });
    const ownerMetadataEnvelope =
      createPlainSessionOwnerMetadataEnvelopeV1(ownerMetadata);
    const row = createSessionRecordFixture({
      id: 'session-layout-v1-owner',
      encryptionMode: 'plain',
      metadataLayoutVersion: 1,
      metadata: JSON.stringify({
        v: 1,
        summary: {
          text: 'Recipient-safe title',
          updatedAt: 10,
        },
      }),
      ownerMetadata: ownerMetadataEnvelope,
    });

    expect(summarizeSessionRow({ credentials, row })).toMatchObject({
      title: 'Recipient-safe title',
      tag: 'private-tag',
      path: '/private/worktree',
      host: 'private-host',
      isSystem: true,
      systemPurpose: 'voice_carrier',
    });

    const unreadableOwnerSummary = summarizeSessionRow({
      credentials,
      row: {
        ...row,
        ownerMetadata: {
          t: 'encrypted',
          c: 'not-owner-ciphertext',
        },
      },
    });
    expect(unreadableOwnerSummary.title).toBe('Recipient-safe title');
    for (const key of ['tag', 'path', 'host', 'isSystem', 'systemPurpose'] as const) {
      expect(unreadableOwnerSummary).not.toHaveProperty(key);
    }

    const futureLayoutSummary = summarizeSessionRow({
      credentials,
      row: {
        ...row,
        metadataLayoutVersion: 2,
      } as any,
    });
    for (const key of ['title', 'tag', 'path', 'host', 'isSystem', 'systemPurpose'] as const) {
      expect(futureLayoutSummary).not.toHaveProperty(key);
    }
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
  });

  it('summarizes a plain Session with token-only credentials without fabricating encryption material', () => {
    const session = summarizeSessionRow({
      credentials: {
        token: 'token-only',
        encryption: null,
      },
      row: createSessionRecordFixture({
        id: 'session-plain-token-only',
        encryptionMode: 'plain',
        metadata: JSON.stringify({
          tag: 'PlainSession',
          summary: {
            text: 'Plain session',
            updatedAt: 10,
          },
          path: '/worktree',
          host: 'plain-host',
        }),
      }),
    });

    expect(session).toMatchObject({
      id: 'session-plain-token-only',
      encryptionMode: 'plain',
      encryption: null,
      tag: 'PlainSession',
      title: 'Plain session',
      path: '/worktree',
      host: 'plain-host',
    });
  });

  it('keeps a retained E2EE Session visible when token-only credentials cannot open its metadata', () => {
    const session = summarizeSessionRow({
      credentials: {
        token: 'token-only',
        encryption: null,
      },
      row: createSessionRecordFixture({
        id: 'session-e2ee-token-only',
        encryptionMode: 'e2ee',
        metadata: 'retained-ciphertext',
      }),
    });

    expect(session).toMatchObject({
      id: 'session-e2ee-token-only',
      encryptionMode: 'e2ee',
      encryption: null,
    });
    expect(session.title).toBeUndefined();
    expect(session.path).toBeUndefined();
  });
});
