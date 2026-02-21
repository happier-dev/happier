import { describe, expect, it } from 'vitest';

import { encodeBase64, encryptLegacy } from '@/api/encryption';
import { makeSessionFixtureRow } from '@/sessionControl/testFixtures';
import { summarizeSessionRow } from '@/sessionControl/sessionSummary';

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
      row: makeSessionFixtureRow({
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
      row: makeSessionFixtureRow({
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
      row: makeSessionFixtureRow({
        id: 'session-malformed',
        metadata: 'not-base64',
      }),
    });

    expect(session.isSystem).toBeUndefined();
    expect(session.systemPurpose).toBeUndefined();
  });
});
