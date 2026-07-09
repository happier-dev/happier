import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import tweetnacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';
import {
    encodeBase64,
    verifyPluginUiArtifactSignatureForArtifactV1,
    type PluginUiExecutableArtifactManifestV1,
} from '@happier-dev/protocol';

import {
    createPluginUiArtifactSigningKeyPair,
    signPluginUiArtifactManifest,
} from './artifactSigning';

const proofFixtureDir = join(__dirname, '__fixtures__', 'reactNativeProof');

function readProofFixture(name: string): unknown {
    return JSON.parse(readFileSync(join(proofFixtureDir, name), 'utf8'));
}

const baseArtifact: PluginUiExecutableArtifactManifestV1 = {
    id: 'first-party-proof-ios',
    pluginId: 'happier.firstparty.preview',
    contributionId: 'native-proof',
    contributionFamily: 'reactNativeBundles',
    artifactKind: 'reactNativeBundle',
    platform: 'ios',
    channel: 'internal',
    integrity: {
        digest: `sha256:${'a'.repeat(64)}`,
    },
    compatibility: {
        hostAppVersion: '2.0.0',
        hostUiApiVersion: '1.0.0',
        reactVersion: '19.2.0',
        reactNativeVersion: '0.83.4',
        nativeCapabilities: [],
    },
    byteSize: 1024,
    contentType: 'application/javascript',
    assetPath: 'react-native/native-proof/ios.bundle.js',
};

describe('first-party plugin UI artifact signer', () => {
    it('signs a manifest so it verifies valid against the produced trust root via host-derived payload', () => {
        const keyPair = createPluginUiArtifactSigningKeyPair();
        const result = signPluginUiArtifactManifest({
            artifact: baseArtifact,
            keyPair,
            keyId: 'happier-rn-firstparty-key-1',
            trustRootId: 'happier-rn-firstparty-root-v1',
        });

        const verification = verifyPluginUiArtifactSignatureForArtifactV1({
            artifact: result.artifact,
            signature: result.signature,
            trustRoots: [result.trustRoot],
        });
        expect(verification).toMatchObject({ valid: true });

        // The signed manifest carries the signature + signing key on integrity.
        expect(result.artifact.integrity.signature).toBe(result.signature.signature);
        expect(result.artifact.integrity.signingKeyId).toBe('happier-rn-firstparty-key-1');
        expect(result.trustRoot.keys[0]?.keyId).toBe('happier-rn-firstparty-key-1');
    });

    it('produces a payload_mismatch when any bound field is mutated after signing', () => {
        const keyPair = createPluginUiArtifactSigningKeyPair();
        const result = signPluginUiArtifactManifest({
            artifact: baseArtifact,
            keyPair,
            keyId: 'happier-rn-firstparty-key-1',
            trustRootId: 'happier-rn-firstparty-root-v1',
        });

        const mutatedArtifact = {
            ...result.artifact,
            byteSize: result.artifact.byteSize + 1,
        };

        const verification = verifyPluginUiArtifactSignatureForArtifactV1({
            artifact: mutatedArtifact,
            signature: result.signature,
            trustRoots: [result.trustRoot],
        });
        expect(verification).toEqual({ valid: false, reasonCode: 'payload_mismatch' });
    });

    it('does not verify against an unrelated trust root key', () => {
        const keyPair = createPluginUiArtifactSigningKeyPair();
        const attackerKeyPair = tweetnacl.sign.keyPair();
        const result = signPluginUiArtifactManifest({
            artifact: baseArtifact,
            keyPair,
            keyId: 'happier-rn-firstparty-key-1',
            trustRootId: 'happier-rn-firstparty-root-v1',
        });

        const verification = verifyPluginUiArtifactSignatureForArtifactV1({
            artifact: result.artifact,
            signature: result.signature,
            trustRoots: [{
                id: 'happier-rn-firstparty-root-v1',
                keys: [{
                    keyId: 'happier-rn-firstparty-key-1',
                    alg: 'ed25519',
                    publicKeyBase64Url: encodeBase64(attackerKeyPair.publicKey, 'base64url'),
                }],
            }],
        });
        expect(verification).toMatchObject({ valid: false, reasonCode: 'bad_signature' });
    });

    it('checked-in first-party proof fixture verifies valid against its trust root', () => {
        const artifact = readProofFixture('artifact.json');
        const signature = readProofFixture('signature.json');
        const trustRoot = readProofFixture(
            'trustRoot.json',
        ) as Parameters<typeof verifyPluginUiArtifactSignatureForArtifactV1>[0]['trustRoots'][number];

        const verification = verifyPluginUiArtifactSignatureForArtifactV1({
            artifact,
            signature,
            trustRoots: [trustRoot],
        });
        expect(verification).toMatchObject({ valid: true });
    });

    it('checked-in first-party proof fixture is rejected when its bundle bytes are tampered', () => {
        const artifact = readProofFixture('artifact.json') as PluginUiExecutableArtifactManifestV1;
        const signature = readProofFixture('signature.json');
        const trustRoot = readProofFixture(
            'trustRoot.json',
        ) as Parameters<typeof verifyPluginUiArtifactSignatureForArtifactV1>[0]['trustRoots'][number];

        const tampered = {
            ...artifact,
            integrity: {
                ...artifact.integrity,
                digest: `sha256:${'0'.repeat(64)}`,
            },
        };
        const verification = verifyPluginUiArtifactSignatureForArtifactV1({
            artifact: tampered,
            signature,
            trustRoots: [trustRoot],
        });
        expect(verification).toEqual({ valid: false, reasonCode: 'payload_mismatch' });
    });
});
