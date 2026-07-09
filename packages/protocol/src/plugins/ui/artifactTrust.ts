import { z } from 'zod';
import tweetnacl from 'tweetnacl';

import { decodeBase64 } from '../../crypto/base64.js';
import { createCanonicalJsonSigningInput } from '../../machines/peer/mediation/directRouteGrantV1.js';
import { PluginUiArtifactContributionFamilyV1Schema, PluginUiArtifactKindV1Schema } from '../contributions/ui/artifacts.js';
import { PluginUiChannelV1Schema, PluginUiPlatformV1Schema } from '../contributions/ui/compatibility.js';
import { PluginUiExecutableArtifactManifestV1Schema } from './artifacts.js';

const Base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]+$/u);
const PluginUiArtifactSignatureDigestV1Schema = z.string().trim().regex(/^sha256:[a-f0-9]{64}$/u);

export const PluginUiArtifactTrustRootKeyV1Schema = z.object({
  keyId: z.string().trim().min(1),
  alg: z.literal('ed25519'),
  publicKeyBase64Url: Base64UrlSchema,
}).strict();
export type PluginUiArtifactTrustRootKeyV1 = z.infer<typeof PluginUiArtifactTrustRootKeyV1Schema>;

export const PluginUiArtifactTrustRootV1Schema = z.object({
  id: z.string().trim().min(1),
  keys: z.array(PluginUiArtifactTrustRootKeyV1Schema).min(1),
}).strict();
export type PluginUiArtifactTrustRootV1 = z.infer<typeof PluginUiArtifactTrustRootV1Schema>;

export const PluginUiArtifactSignaturePayloadV1Schema = z.object({
  t: z.literal('happier.pluginUi.artifactSignaturePayload.v1'),
  pluginId: z.string().trim().min(1),
  contributionId: z.string().trim().min(1),
  contributionFamily: PluginUiArtifactContributionFamilyV1Schema,
  artifactKind: PluginUiArtifactKindV1Schema,
  platform: PluginUiPlatformV1Schema,
  channel: PluginUiChannelV1Schema,
  digest: PluginUiArtifactSignatureDigestV1Schema,
  byteSize: z.number().int().positive(),
  contentType: z.string().trim().min(1),
  sourceMapDigest: PluginUiArtifactSignatureDigestV1Schema.optional(),
  hostAppVersion: z.string().trim().min(1),
  hostUiApiVersion: z.string().trim().min(1),
  reactVersion: z.string().trim().min(1).optional(),
  reactNativeVersion: z.string().trim().min(1).optional(),
  expoRuntimeVersion: z.string().trim().min(1).optional(),
  hermesVersion: z.string().trim().min(1).optional(),
  // RN-HARDEN item 2: supportedChannels is a channel-GATE input, so a signed
  // artifact must bind it — otherwise the declaration could be widened after
  // signing without invalidating the signature. Optional so artifacts (and
  // checked-in proof fixtures) predating the declaration keep byte-identical
  // canonical payloads.
  supportedChannels: z.array(PluginUiChannelV1Schema).min(1).optional(),
  nativeCapabilities: z.array(z.string().trim().min(1)),
}).strict();
export type PluginUiArtifactSignaturePayloadV1 =
  z.infer<typeof PluginUiArtifactSignaturePayloadV1Schema>;

export const PluginUiArtifactSignatureEnvelopeV1Schema = z.object({
  t: z.literal('happier.pluginUi.artifactSignature.v1'),
  alg: z.literal('ed25519'),
  keyId: z.string().trim().min(1),
  trustRootId: z.string().trim().min(1),
  payload: PluginUiArtifactSignaturePayloadV1Schema,
  signature: Base64UrlSchema,
}).strict();
export type PluginUiArtifactSignatureEnvelopeV1 =
  z.infer<typeof PluginUiArtifactSignatureEnvelopeV1Schema>;

export type VerifyPluginUiArtifactSignatureV1Result =
  | Readonly<{
      valid: true;
      payload: PluginUiArtifactSignaturePayloadV1;
      keyId: string;
      trustRootId: string;
    }>
  | Readonly<{
      valid: false;
      reasonCode:
        | 'signature_invalid'
        | 'trust_root_missing'
        | 'signing_key_missing'
        | 'invalid_public_key'
        | 'invalid_signature'
        | 'bad_signature';
    }>;

export type VerifyPluginUiArtifactSignatureForArtifactV1Result =
  | VerifyPluginUiArtifactSignatureV1Result
  | Readonly<{ valid: false; reasonCode: 'artifact_invalid' | 'payload_mismatch' }>;

function decodeBase64UrlStrict(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) return null;
  try {
    return decodeBase64(value, 'base64url');
  } catch {
    return null;
  }
}

function normalizeNativeCapabilities(capabilities: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(capabilities.map((capability) => capability.trim()).filter(Boolean))].sort());
}

export function createPluginUiArtifactSignaturePayloadV1(
  artifact: unknown,
): PluginUiArtifactSignaturePayloadV1 {
  const parsed = PluginUiExecutableArtifactManifestV1Schema.parse(artifact);
  const integrity = parsed.integrity;
  if (!integrity) {
    throw new z.ZodError([{
      code: z.ZodIssueCode.custom,
      path: ['integrity'],
      message: 'Plugin UI artifact signatures require immutable artifact integrity',
    }]);
  }
  return PluginUiArtifactSignaturePayloadV1Schema.parse({
    t: 'happier.pluginUi.artifactSignaturePayload.v1',
    pluginId: parsed.pluginId,
    contributionId: parsed.contributionId,
    contributionFamily: parsed.contributionFamily,
    artifactKind: parsed.artifactKind,
    platform: parsed.platform,
    channel: parsed.channel,
    digest: integrity.digest,
    byteSize: parsed.byteSize,
    contentType: parsed.contentType,
    ...(parsed.sourceMapDigest ? { sourceMapDigest: parsed.sourceMapDigest } : {}),
    hostAppVersion: parsed.compatibility.hostAppVersion,
    hostUiApiVersion: parsed.compatibility.hostUiApiVersion,
    ...(parsed.compatibility.reactVersion ? { reactVersion: parsed.compatibility.reactVersion } : {}),
    ...(parsed.compatibility.reactNativeVersion
      ? { reactNativeVersion: parsed.compatibility.reactNativeVersion }
      : {}),
    ...(parsed.compatibility.expoRuntimeVersion
      ? { expoRuntimeVersion: parsed.compatibility.expoRuntimeVersion }
      : {}),
    ...(parsed.compatibility.hermesVersion ? { hermesVersion: parsed.compatibility.hermesVersion } : {}),
    ...(parsed.compatibility.supportedChannels?.length
      ? { supportedChannels: Object.freeze([...new Set(parsed.compatibility.supportedChannels)].sort()) }
      : {}),
    nativeCapabilities: normalizeNativeCapabilities(parsed.compatibility.nativeCapabilities),
  });
}

export function createPluginUiArtifactSignatureSigningInputV1(
  payload: PluginUiArtifactSignaturePayloadV1,
): string {
  const parsed = PluginUiArtifactSignaturePayloadV1Schema.parse({
    ...payload,
    nativeCapabilities: normalizeNativeCapabilities(payload.nativeCapabilities),
  });
  return createCanonicalJsonSigningInput(parsed);
}

export function verifyPluginUiArtifactSignatureV1(input: Readonly<{
  signature: unknown;
  trustRoots: readonly PluginUiArtifactTrustRootV1[];
}>): VerifyPluginUiArtifactSignatureV1Result {
  const parsed = PluginUiArtifactSignatureEnvelopeV1Schema.safeParse(input.signature);
  if (!parsed.success) return { valid: false, reasonCode: 'signature_invalid' };

  const envelope = parsed.data;
  const trustRoot = input.trustRoots.find((candidate) => candidate.id === envelope.trustRootId);
  if (!trustRoot) return { valid: false, reasonCode: 'trust_root_missing' };

  const key = trustRoot.keys.find((candidate) => candidate.keyId === envelope.keyId && candidate.alg === envelope.alg);
  if (!key) return { valid: false, reasonCode: 'signing_key_missing' };

  const publicKey = decodeBase64UrlStrict(key.publicKeyBase64Url);
  if (!publicKey || publicKey.byteLength !== tweetnacl.sign.publicKeyLength) {
    return { valid: false, reasonCode: 'invalid_public_key' };
  }

  const signature = decodeBase64UrlStrict(envelope.signature);
  if (!signature || signature.byteLength !== tweetnacl.sign.signatureLength) {
    return { valid: false, reasonCode: 'invalid_signature' };
  }

  const signingInput = new TextEncoder().encode(
    createPluginUiArtifactSignatureSigningInputV1(envelope.payload),
  );
  return tweetnacl.sign.detached.verify(signingInput, signature, publicKey)
    ? {
        valid: true,
        payload: envelope.payload,
        keyId: envelope.keyId,
        trustRootId: envelope.trustRootId,
      }
    : { valid: false, reasonCode: 'bad_signature' };
}

export function verifyPluginUiArtifactSignatureForArtifactV1(input: Readonly<{
  artifact: unknown;
  signature: unknown;
  trustRoots: readonly PluginUiArtifactTrustRootV1[];
}>): VerifyPluginUiArtifactSignatureForArtifactV1Result {
  const parsedArtifact = PluginUiExecutableArtifactManifestV1Schema.safeParse(input.artifact);
  if (!parsedArtifact.success) return { valid: false, reasonCode: 'artifact_invalid' };
  if (!parsedArtifact.data.integrity) return { valid: false, reasonCode: 'artifact_invalid' };

  const verification = verifyPluginUiArtifactSignatureV1({
    signature: input.signature,
    trustRoots: input.trustRoots,
  });
  if (!verification.valid) return verification;

  const expectedPayload = createPluginUiArtifactSignaturePayloadV1(parsedArtifact.data);
  const expectedSigningInput = createPluginUiArtifactSignatureSigningInputV1(expectedPayload);
  const actualSigningInput = createPluginUiArtifactSignatureSigningInputV1(verification.payload);
  if (expectedSigningInput !== actualSigningInput) {
    return { valid: false, reasonCode: 'payload_mismatch' };
  }

  return verification;
}
