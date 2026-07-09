import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import tweetnacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';

import {
    createPluginUiArtifactRevocationFeedSigningInputV1,
    encodeBase64,
    type PluginUiArtifactRevocationFeedBodyV1,
    type PluginUiArtifactRevocationFeedEnvelopeV1,
    type PluginUiArtifactRevocationV1,
    type PluginUiArtifactTrustRootV1,
} from '@happier-dev/protocol';

import {
    createPluginUiArtifactRevocationFeedStore,
    isPluginUiArtifactRevoked,
    recordPluginUiArtifactRevocations,
    recordSignedPluginUiArtifactRevocationFeed,
    resolvePluginUiArtifactRevocationStateFromFeed,
} from './revocation';

const signingKeyRevocation = {
    id: 'revoke-signing-key',
    scope: { kind: 'signingKey', signingKeyId: 'rn-key-1' },
    reason: 'compromised',
    revokedAt: '2026-06-15T00:00:00.000Z',
} satisfies PluginUiArtifactRevocationV1;

function signedFeed(body: PluginUiArtifactRevocationFeedBodyV1) {
    const keyPair = tweetnacl.sign.keyPair();
    const envelope: PluginUiArtifactRevocationFeedEnvelopeV1 = {
        t: 'happier.pluginUi.artifactRevocationFeed.v1',
        alg: 'ed25519',
        keyId: 'feed-key-1',
        trustRootId: 'happier-rn-root-v1',
        body,
        signature: encodeBase64(
            tweetnacl.sign.detached(
                new TextEncoder().encode(createPluginUiArtifactRevocationFeedSigningInputV1(body)),
                keyPair.secretKey,
            ),
            'base64url',
        ),
    };
    const trustRoot: PluginUiArtifactTrustRootV1 = {
        id: 'happier-rn-root-v1',
        keys: [{
            keyId: 'feed-key-1',
            alg: 'ed25519',
            publicKeyBase64Url: encodeBase64(keyPair.publicKey, 'base64url'),
        }],
    };
    return { envelope, trustRoot };
}

describe('plugin UI artifact revocation feed', () => {
    it('persists feed revocations with a generation and resolves them into runtime revocation state', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-ui-revocation-feed-'));
        const store = createPluginUiArtifactRevocationFeedStore({ happyHomeDir });

        await recordPluginUiArtifactRevocations({
            store,
            generation: 3,
            revocations: [signingKeyRevocation],
        });

        const reloaded = await createPluginUiArtifactRevocationFeedStore({ happyHomeDir }).read();
        expect(reloaded.generation).toBe(3);
        expect(reloaded.revocations['revoke-signing-key']).toEqual(signingKeyRevocation);

        const state = resolvePluginUiArtifactRevocationStateFromFeed(reloaded);
        expect(state.generation).toBe(3);
        expect(isPluginUiArtifactRevoked({
            pluginId: 'acme.preview',
            contributionId: 'native-preview',
            digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            signingKeyId: 'rn-key-1',
        }, state)).toBe(true);
        expect(isPluginUiArtifactRevoked({
            pluginId: 'acme.preview',
            contributionId: 'native-preview',
            digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            signingKeyId: 'rn-key-2',
        }, state)).toBe(false);
    });

    it('records only valid signed feeds and rejects stale generations', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-ui-signed-revocation-feed-'));
        const store = createPluginUiArtifactRevocationFeedStore({ happyHomeDir });
        const body = {
            t: 'happier.pluginUi.artifactRevocationFeed.body.v1',
            schemaVersion: 1,
            generation: 4,
            issuedAt: '2026-06-20T00:00:00.000Z',
            revocations: [signingKeyRevocation],
        } satisfies PluginUiArtifactRevocationFeedBodyV1;
        const signed = signedFeed(body);

        await expect(recordSignedPluginUiArtifactRevocationFeed({
            store,
            envelope: signed.envelope,
            trustRoots: [signed.trustRoot],
        })).resolves.toMatchObject({
            ok: true,
            feed: {
                generation: 4,
                revocations: { 'revoke-signing-key': signingKeyRevocation },
            },
        });

        const tampered = {
            ...signed.envelope,
            body: { ...body, generation: 5 },
        };
        await expect(recordSignedPluginUiArtifactRevocationFeed({
            store,
            envelope: tampered,
            trustRoots: [signed.trustRoot],
        })).resolves.toEqual({ ok: false, code: 'revocation_feed_invalid' });

        const stale = signedFeed({ ...body, generation: 3 });
        await expect(recordSignedPluginUiArtifactRevocationFeed({
            store,
            envelope: stale.envelope,
            trustRoots: [stale.trustRoot],
        })).resolves.toEqual({ ok: false, code: 'revocation_feed_stale' });
    });

    it('does not let equal-generation signed feeds overwrite existing revocation ids', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-ui-signed-revocation-replay-'));
        const store = createPluginUiArtifactRevocationFeedStore({ happyHomeDir });
        const strongBody = {
            t: 'happier.pluginUi.artifactRevocationFeed.body.v1',
            schemaVersion: 1,
            generation: 4,
            issuedAt: '2026-06-20T00:00:00.000Z',
            revocations: [signingKeyRevocation],
        } satisfies PluginUiArtifactRevocationFeedBodyV1;
        const strong = signedFeed(strongBody);

        await expect(recordSignedPluginUiArtifactRevocationFeed({
            store,
            envelope: strong.envelope,
            trustRoots: [strong.trustRoot],
        })).resolves.toMatchObject({ ok: true });

        const weakerRevocation = {
            ...signingKeyRevocation,
            scope: { kind: 'digest', digest: `sha256:${'b'.repeat(64)}` },
            reason: 'unknown',
        } satisfies PluginUiArtifactRevocationV1;
        const replay = signedFeed({
            ...strongBody,
            revocations: [weakerRevocation],
        });

        await expect(recordSignedPluginUiArtifactRevocationFeed({
            store,
            envelope: replay.envelope,
            trustRoots: [replay.trustRoot],
        })).resolves.toEqual({ ok: false, code: 'revocation_feed_stale' });

        await expect(store.read()).resolves.toMatchObject({
            generation: 4,
            revocations: {
                'revoke-signing-key': signingKeyRevocation,
            },
        });
    });
});
