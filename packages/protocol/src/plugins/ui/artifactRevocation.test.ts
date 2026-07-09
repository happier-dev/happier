import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';

import { encodeBase64 } from '../../crypto/base64.js';
import {
  createPluginUiArtifactRevocationFeedSigningInputV1,
  verifyPluginUiArtifactRevocationFeedV1,
} from './artifactRevocation.js';
import { PluginUiArtifactRevocationV1Schema } from './artifactRevocation.js';

describe('plugin UI artifact revocations', () => {
  it('uses the same sha256 digest contract for digest-scoped revocations as artifact integrity', () => {
    expect(PluginUiArtifactRevocationV1Schema.safeParse({
      id: 'revoke-bundle',
      scope: { kind: 'digest', digest: `sha256:${'b'.repeat(64)}` },
      reason: 'compromised',
      revokedAt: '2026-06-09T19:00:00.000Z',
    }).success).toBe(true);

    expect(PluginUiArtifactRevocationV1Schema.safeParse({
      id: 'revoke-bundle',
      scope: { kind: 'digest', digest: 'bundle' },
      reason: 'compromised',
      revokedAt: '2026-06-09T19:00:00.000Z',
    }).success).toBe(false);
  });

  it('verifies a signed revocation feed envelope and rejects invalid signatures', () => {
    const keyPair = tweetnacl.sign.keyPair();
    const body = {
      t: 'happier.pluginUi.artifactRevocationFeed.body.v1',
      schemaVersion: 1,
      generation: 7,
      issuedAt: '2026-06-20T00:00:00.000Z',
      revocations: [{
        id: 'revoke-digest',
        scope: { kind: 'digest', digest: `sha256:${'d'.repeat(64)}` },
        reason: 'compromised',
        revokedAt: '2026-06-20T00:00:00.000Z',
      }],
    } as const;
    const signature = encodeBase64(
      tweetnacl.sign.detached(
        new TextEncoder().encode(createPluginUiArtifactRevocationFeedSigningInputV1(body)),
        keyPair.secretKey,
      ),
      'base64url',
    );
    const trustRoot = {
      id: 'happier-rn-root-v1',
      keys: [{
        keyId: 'feed-key-1',
        alg: 'ed25519',
        publicKeyBase64Url: encodeBase64(keyPair.publicKey, 'base64url'),
      }],
    } as const;

    expect(verifyPluginUiArtifactRevocationFeedV1({
      envelope: {
        t: 'happier.pluginUi.artifactRevocationFeed.v1',
        alg: 'ed25519',
        keyId: 'feed-key-1',
        trustRootId: 'happier-rn-root-v1',
        body,
        signature,
      },
      trustRoots: [trustRoot],
      minGeneration: 6,
    })).toEqual({ valid: true, body });

    expect(verifyPluginUiArtifactRevocationFeedV1({
      envelope: {
        t: 'happier.pluginUi.artifactRevocationFeed.v1',
        alg: 'ed25519',
        keyId: 'feed-key-1',
        trustRootId: 'happier-rn-root-v1',
        body: { ...body, generation: 8 },
        signature,
      },
      trustRoots: [trustRoot],
      minGeneration: 6,
    })).toEqual({ valid: false, reasonCode: 'bad_signature' });

    expect(verifyPluginUiArtifactRevocationFeedV1({
      envelope: {
        t: 'happier.pluginUi.artifactRevocationFeed.v1',
        alg: 'ed25519',
        keyId: 'feed-key-1',
        trustRootId: 'happier-rn-root-v1',
        body: { ...body, generation: 5 },
        signature,
      },
      trustRoots: [trustRoot],
      minGeneration: 6,
    })).toEqual({ valid: false, reasonCode: 'stale_generation' });
  });
});
