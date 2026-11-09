import { describe, expect, it } from 'vitest';

import { deriveDaemonPluginReactNativeBundleCacheIdentityKeyV1 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';

describe('React Native runtime sync domain', () => {
    it('keys the daemon-owned cache identity without re-deciding runtime admission', () => {
        const identity = {
            artifactDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        } as const;

        expect(deriveDaemonPluginReactNativeBundleCacheIdentityKeyV1(identity)).toBe(identity.artifactDigest);
    });
});
