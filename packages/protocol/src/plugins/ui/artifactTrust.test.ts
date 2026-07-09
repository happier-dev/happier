import tweetnacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';

import { encodeBase64 } from '../../crypto/base64.js';
import {
  createPluginUiArtifactSignaturePayloadV1,
  createPluginUiArtifactSignatureSigningInputV1,
  verifyPluginUiArtifactSignatureForArtifactV1,
  verifyPluginUiArtifactSignatureV1,
} from './artifactTrust.js';

const artifact = {
  id: 'native-preview-ios',
  pluginId: 'acme.preview',
  contributionId: 'native-preview',
  contributionFamily: 'reactNativeBundles',
  artifactKind: 'reactNativeBundle',
  platform: 'ios',
  channel: 'internal',
  integrity: {
    digest: `sha256:${'a'.repeat(64)}`,
    signingKeyId: 'rn-key-1',
  },
  compatibility: {
    hostAppVersion: '2.0.0',
    hostUiApiVersion: '1.0.0',
    reactVersion: '19.0.0',
    reactNativeVersion: '0.83.4',
    expoRuntimeVersion: '0.2.0-native',
    hermesVersion: '0.15.0',
    nativeCapabilities: ['haptics', 'clipboard'],
  },
  byteSize: 1024,
  contentType: 'application/javascript',
  assetPath: 'react-native/native-preview/ios.bundle.js',
  sourceMapDigest: `sha256:${'b'.repeat(64)}`,
} as const;

function signPayload(payload: ReturnType<typeof createPluginUiArtifactSignaturePayloadV1>) {
  const keyPair = tweetnacl.sign.keyPair();
  const signingInput = new TextEncoder().encode(createPluginUiArtifactSignatureSigningInputV1(payload));
  return {
    envelope: {
      t: 'happier.pluginUi.artifactSignature.v1',
      alg: 'ed25519',
      keyId: 'rn-key-1',
      trustRootId: 'happier-rn-root-v1',
      payload,
      signature: encodeBase64(tweetnacl.sign.detached(signingInput, keyPair.secretKey), 'base64url'),
    },
    trustRoot: {
      id: 'happier-rn-root-v1',
      keys: [{
        keyId: 'rn-key-1',
        alg: 'ed25519',
        publicKeyBase64Url: encodeBase64(keyPair.publicKey, 'base64url'),
      }],
    },
  } as const;
}

describe('plugin UI artifact trust', () => {
  it('verifies an Ed25519 artifact signature over the exact canonical payload', () => {
    const payload = createPluginUiArtifactSignaturePayloadV1(artifact);
    const signed = signPayload(payload);

    expect(verifyPluginUiArtifactSignatureV1({
      signature: signed.envelope,
      trustRoots: [signed.trustRoot],
    })).toEqual({
      valid: true,
      payload,
      keyId: 'rn-key-1',
      trustRootId: 'happier-rn-root-v1',
    });

    expect(verifyPluginUiArtifactSignatureForArtifactV1({
      artifact,
      signature: signed.envelope,
      trustRoots: [signed.trustRoot],
    })).toMatchObject({ valid: true });
  });

  it('rejects signatures when any artifact-bound payload field changes', () => {
    const payload = createPluginUiArtifactSignaturePayloadV1(artifact);
    const signed = signPayload(payload);

    expect(verifyPluginUiArtifactSignatureForArtifactV1({
      artifact: { ...artifact, integrity: { ...artifact.integrity, digest: `sha256:${'c'.repeat(64)}` } },
      signature: signed.envelope,
      trustRoots: [signed.trustRoot],
    })).toEqual({ valid: false, reasonCode: 'payload_mismatch' });

    expect(verifyPluginUiArtifactSignatureV1({
      signature: {
        ...signed.envelope,
        payload: { ...payload, pluginId: 'acme.other' },
      },
      trustRoots: [signed.trustRoot],
    })).toEqual({ valid: false, reasonCode: 'bad_signature' });
  });

  it('rejects non-canonical artifact digests before signature verification', () => {
    expect(() => createPluginUiArtifactSignaturePayloadV1({
      ...artifact,
      integrity: { ...artifact.integrity, digest: 'sha256:bundle' },
    })).toThrow();
  });

  it('rejects development devUrl artifacts without immutable integrity at the signing boundary', () => {
    const signed = signPayload(createPluginUiArtifactSignaturePayloadV1(artifact));
    const developmentArtifact = {
      ...artifact,
      channel: 'development',
      integrity: undefined,
      assetPath: undefined,
      devUrl: 'http://127.0.0.1:8082/index.bundle?platform=ios&dev=true',
    };

    expect(() => createPluginUiArtifactSignaturePayloadV1(developmentArtifact)).toThrow(/integrity/i);
    expect(verifyPluginUiArtifactSignatureForArtifactV1({
      artifact: developmentArtifact,
      signature: signed.envelope,
      trustRoots: [signed.trustRoot],
    })).toEqual({ valid: false, reasonCode: 'artifact_invalid' });
  });

  it('creates deterministic canonical signing input independent of insertion order', () => {
    const payload = createPluginUiArtifactSignaturePayloadV1(artifact);
    const reorderedPayload = {
      nativeCapabilities: [...payload.nativeCapabilities].reverse(),
      contentType: payload.contentType,
      byteSize: payload.byteSize,
      digest: payload.digest,
      channel: payload.channel,
      platform: payload.platform,
      artifactKind: payload.artifactKind,
      contributionFamily: payload.contributionFamily,
      contributionId: payload.contributionId,
      pluginId: payload.pluginId,
      t: payload.t,
      hostAppVersion: payload.hostAppVersion,
      hostUiApiVersion: payload.hostUiApiVersion,
      reactVersion: payload.reactVersion,
      reactNativeVersion: payload.reactNativeVersion,
      expoRuntimeVersion: payload.expoRuntimeVersion,
      hermesVersion: payload.hermesVersion,
      sourceMapDigest: payload.sourceMapDigest,
    };

    expect(createPluginUiArtifactSignatureSigningInputV1(reorderedPayload))
      .toBe(createPluginUiArtifactSignatureSigningInputV1(payload));
  });
});
