import { sha256 } from '@noble/hashes/sha2';
import tweetnacl from 'tweetnacl';
import { z } from 'zod';

import {
  PEER_ROUTE_EPHEMERAL_ED25519_KIND_V2,
  SignedDirectRouteGrantV2Schema,
  createSignedDirectRouteGrantDigestInputV2,
  type SignedDirectRouteGrantV2,
} from './directRouteGrantV2.js';
import { decodeCanonicalBase64UrlFixedLength, encodeCanonicalBase64Url } from './strictBase64Url.js';

export const PEER_ROUTE_PROOF_DOMAIN_V2 = 'happier-peer-route-proof-v2\0' as const;
const PEER_ROUTE_EPHEMERAL_SEED_BYTES_V2 = 32;
const PEER_ROUTE_PROOF_DIGEST_BYTES_V2 = 32;
const PEER_ROUTE_PROOF_NONCE_BYTES_V2 = 16;
const PEER_ROUTE_PROOF_SIGNATURE_BYTES_V2 = 64;

function fixedBase64UrlSchema(decodedLength: number): z.ZodString {
  return z.string().refine(
    (value) => decodeCanonicalBase64UrlFixedLength(value, decodedLength) !== null,
    `Expected canonical unpadded base64url encoding of ${decodedLength} bytes`,
  );
}

export const PeerRouteEphemeralProofV2Schema = z
  .object({
    v: z.literal(2),
    kind: z.literal(PEER_ROUTE_EPHEMERAL_ED25519_KIND_V2),
    signedGrantDigestBase64Url: fixedBase64UrlSchema(PEER_ROUTE_PROOF_DIGEST_BYTES_V2),
    nonceBase64Url: fixedBase64UrlSchema(PEER_ROUTE_PROOF_NONCE_BYTES_V2),
    signatureBase64Url: fixedBase64UrlSchema(PEER_ROUTE_PROOF_SIGNATURE_BYTES_V2),
  })
  .strict();

export type PeerRouteEphemeralProofV2 = z.infer<typeof PeerRouteEphemeralProofV2Schema>;

export type EphemeralPeerRouteProofHandleV2 = Readonly<{
  publicKeyBase64Url: string;
  sign(grant: SignedDirectRouteGrantV2): PeerRouteEphemeralProofV2;
  dispose(): void;
}>;

export type PeerRouteEphemeralProofV2VerifyReasonCode =
  | 'proof_invalid'
  | 'proof_grant_invalid'
  | 'proof_grant_digest_mismatch'
  | 'proof_bad_signature';

export function digestSignedDirectRouteGrantV2(grant: SignedDirectRouteGrantV2): Uint8Array {
  return sha256(createSignedDirectRouteGrantDigestInputV2(grant));
}

export function createPeerRouteProofSigningInputV2(input: Readonly<{
  digest: Uint8Array;
  nonce: Uint8Array;
}>): Uint8Array {
  if (input.digest.length !== PEER_ROUTE_PROOF_DIGEST_BYTES_V2) {
    throw new Error('peer_route_proof_digest_length_invalid');
  }
  if (input.nonce.length !== PEER_ROUTE_PROOF_NONCE_BYTES_V2) {
    throw new Error('peer_route_proof_nonce_length_invalid');
  }
  const domain = new TextEncoder().encode(PEER_ROUTE_PROOF_DOMAIN_V2);
  const signingInput = new Uint8Array(domain.length + input.digest.length + input.nonce.length);
  signingInput.set(domain, 0);
  signingInput.set(input.digest, domain.length);
  signingInput.set(input.nonce, domain.length + input.digest.length);
  return signingInput;
}

export function createEphemeralPeerRouteProofHandleV2(input: Readonly<{
  randomBytes(length: number): Uint8Array;
}>): EphemeralPeerRouteProofHandleV2 {
  const generatedSeed = input.randomBytes(PEER_ROUTE_EPHEMERAL_SEED_BYTES_V2);
  if (generatedSeed.length !== PEER_ROUTE_EPHEMERAL_SEED_BYTES_V2) {
    generatedSeed.fill(0);
    throw new Error('peer_route_ephemeral_csprng_length_invalid');
  }
  const seed = new Uint8Array(generatedSeed);
  generatedSeed.fill(0);
  const keyPair = tweetnacl.sign.keyPair.fromSeed(seed);
  const publicKeyBase64Url = encodeCanonicalBase64Url(keyPair.publicKey);
  keyPair.publicKey.fill(0);
  let secretKey: Uint8Array | null = keyPair.secretKey;
  let disposed = false;

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    seed.fill(0);
    secretKey?.fill(0);
    secretKey = null;
  };

  return Object.freeze({
    publicKeyBase64Url,
    sign(grant) {
      if (disposed || !secretKey) throw new Error('peer_route_ephemeral_handle_disposed');
      let nonce: Uint8Array | null = null;
      let digest: Uint8Array | null = null;
      let signingInput: Uint8Array | null = null;
      let signature: Uint8Array | null = null;
      try {
        const parsedGrant = SignedDirectRouteGrantV2Schema.parse(grant);
        if (parsedGrant.payload.ephemeralPublicKeyBase64Url !== publicKeyBase64Url) {
          throw new Error('peer_route_ephemeral_public_key_mismatch');
        }
        const generatedNonce = input.randomBytes(PEER_ROUTE_PROOF_NONCE_BYTES_V2);
        if (generatedNonce.length !== PEER_ROUTE_PROOF_NONCE_BYTES_V2) {
          generatedNonce.fill(0);
          throw new Error('peer_route_ephemeral_nonce_length_invalid');
        }
        nonce = new Uint8Array(generatedNonce);
        generatedNonce.fill(0);
        digest = digestSignedDirectRouteGrantV2(parsedGrant);
        signingInput = createPeerRouteProofSigningInputV2({ digest, nonce });
        signature = tweetnacl.sign.detached(signingInput, secretKey);
        return PeerRouteEphemeralProofV2Schema.parse({
          v: 2,
          kind: PEER_ROUTE_EPHEMERAL_ED25519_KIND_V2,
          signedGrantDigestBase64Url: encodeCanonicalBase64Url(digest),
          nonceBase64Url: encodeCanonicalBase64Url(nonce),
          signatureBase64Url: encodeCanonicalBase64Url(signature),
        });
      } finally {
        nonce?.fill(0);
        digest?.fill(0);
        signingInput?.fill(0);
        signature?.fill(0);
        dispose();
      }
    },
    dispose,
  });
}

export function verifyPeerRouteEphemeralProofV2(input: Readonly<{
  grant: unknown;
  proof: unknown;
}>): Readonly<{ valid: true }> | Readonly<{
  valid: false;
  reasonCode: PeerRouteEphemeralProofV2VerifyReasonCode;
}> {
  const parsedGrant = SignedDirectRouteGrantV2Schema.safeParse(input.grant);
  if (!parsedGrant.success) return { valid: false, reasonCode: 'proof_grant_invalid' };
  const parsedProof = PeerRouteEphemeralProofV2Schema.safeParse(input.proof);
  if (!parsedProof.success) return { valid: false, reasonCode: 'proof_invalid' };

  const proof = parsedProof.data;
  const expectedDigest = digestSignedDirectRouteGrantV2(parsedGrant.data);
  const proofDigest = decodeCanonicalBase64UrlFixedLength(
    proof.signedGrantDigestBase64Url,
    PEER_ROUTE_PROOF_DIGEST_BYTES_V2,
  );
  if (!proofDigest || !tweetnacl.verify(expectedDigest, proofDigest)) {
    expectedDigest.fill(0);
    proofDigest?.fill(0);
    return { valid: false, reasonCode: 'proof_grant_digest_mismatch' };
  }

  const nonce = decodeCanonicalBase64UrlFixedLength(proof.nonceBase64Url, PEER_ROUTE_PROOF_NONCE_BYTES_V2);
  const signature = decodeCanonicalBase64UrlFixedLength(
    proof.signatureBase64Url,
    PEER_ROUTE_PROOF_SIGNATURE_BYTES_V2,
  );
  const publicKey = decodeCanonicalBase64UrlFixedLength(
    parsedGrant.data.payload.ephemeralPublicKeyBase64Url,
    tweetnacl.sign.publicKeyLength,
  );
  if (!nonce || !signature || !publicKey) {
    expectedDigest.fill(0);
    proofDigest.fill(0);
    nonce?.fill(0);
    signature?.fill(0);
    publicKey?.fill(0);
    return { valid: false, reasonCode: 'proof_invalid' };
  }

  const signingInput = createPeerRouteProofSigningInputV2({ digest: expectedDigest, nonce });
  const valid = tweetnacl.sign.detached.verify(signingInput, signature, publicKey);
  expectedDigest.fill(0);
  proofDigest.fill(0);
  nonce.fill(0);
  signature.fill(0);
  publicKey.fill(0);
  signingInput.fill(0);
  return valid ? { valid: true } : { valid: false, reasonCode: 'proof_bad_signature' };
}
