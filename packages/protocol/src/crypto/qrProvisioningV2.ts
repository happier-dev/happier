import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha2';
import tweetnacl from 'tweetnacl';

import {
  ACCOUNT_DIRECTORY_MAX_LABEL_UTF8_BYTES,
  HomeConnectionDescriptorV1Schema,
  type HomeConnectionDescriptorV1,
} from '../auth/accountDirectory.js';
import { decodeBase64, encodeBase64 } from './base64.js';
import { encodeCanonicalLengthDelimited } from './canonicalDigest.js';
import { createCanonicalJsonSigningInput } from './canonicalJson.js';

/**
 * Single canonical owner of the Home QR V2 invite payload, rendezvous/binding
 * derivations, and binding proof (lane-05 §6.2, A6 known-target amendment).
 *
 * One random 32-byte QR-only secret is domain separated into:
 *   rendezvousSecret = HMAC-SHA256(qrSecret, "happier/qr/rendezvous/v2")
 *   bindingKey       = HMAC-SHA256(qrSecret, "happier/qr/binding/v2")
 *
 * The relay sees only the SHA-256 verifier of the rendezvous secret; it never
 * receives the raw secret or the binding key, so it cannot derive the binding
 * proof. The JSON/base64url invite encoding is implemented exactly once here;
 * consumers must not hand-roll it.
 *
 * A6: every invite carries a strict display direction,
 * `trusted_home_displays | requester_displays`, and the direction is
 * part of the canonical HMAC binding input. For requester-displayed invites the
 * requester is a credentialless but known-target client: it generates the
 * CSPRNG pair-ID candidate, QR secret, ephemeral box keypair, and bounded exact
 * expiry, and the enrolled scanner authenticates the existing pairing-start
 * route with that proposed tuple. The direction itself is never a server-side
 * decision; it is enforced by verifying the direction-bound proof.
 */

export const HOME_QR_RENDEZVOUS_DOMAIN_V2 = 'happier/qr/rendezvous/v2' as const;
export const HOME_QR_BINDING_DOMAIN_V2 = 'happier/qr/binding/v2' as const;

export const HOME_QR_SECRET_V2_BYTES = 32;
/** Requester X25519 box public key length bound into the proof and the sealed response. */
export const HOME_QR_REQUESTER_PUBLIC_KEY_V2_BYTES = 32;
/** Bounded invite lifetime; matches the existing pairing policy TTL clamp maximum (600s). */
export const HOME_QR_INVITE_V2_MAX_TTL_MS = 600_000;
/** Default pairing window, aligned with the Home pairing policy's production default. */
const HOME_QR_INVITE_V2_DEFAULT_TTL_MS = 120_000;
/** Narrow clock tolerance for an invite issued slightly in the future. */
export const HOME_QR_INVITE_V2_MAX_FUTURE_ISSUANCE_SKEW_MS = 30_000;
/** Bounded opaque payload budget for QR/deep-link carriers. */
export const HOME_QR_INVITE_V2_MAX_PAYLOAD_UTF8_BYTES = 16 * 1024;

const HOME_QR_BINDING_PROTOCOL_VERSION_V2 = 'v2';
const HOME_QR_BINDING_INTENT_V2 = 'home_device';

/** Strict display direction; the value is required and bound into the HMAC input. */
export const HOME_QR_INVITE_DIRECTIONS_V2 = ['trusted_home_displays', 'requester_displays'] as const;
export type HomeQrInviteDirectionV2 = (typeof HOME_QR_INVITE_DIRECTIONS_V2)[number];

const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

const HomeQrInviteV2CommonShape = {
  v: z.literal(2),
  intent: z.literal('home_device'),
  pairId: z.string().min(1).max(128).superRefine((value, context) => {
    if (UTF8_ENCODER.encode(value).byteLength > 128) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Pair ID exceeds its UTF-8 byte limit' });
    }
  }),
  home: HomeConnectionDescriptorV1Schema,
  qrSecretBase64Url: z.string().regex(/^[A-Za-z0-9_-]+$/u).max(64),
  issuedAtMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  expiresAtMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  requestedDeviceLabel: z.string().min(1).superRefine((value, context) => {
    if (UTF8_ENCODER.encode(value).byteLength > ACCOUNT_DIRECTORY_MAX_LABEL_UTF8_BYTES) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Requested device label exceeds its UTF-8 byte limit' });
    }
  }).optional(),
} as const;

const HomeQrRequesterPublicKeyBase64UrlV2Schema = lazyZodSchema(() => z.string()
  .regex(/^[A-Za-z0-9_-]+$/u)
  .max(64)
  .superRefine((value, context) => {
    try {
      const publicKeyBytes = decodeBase64(value, 'base64url');
      if (publicKeyBytes.length !== HOME_QR_REQUESTER_PUBLIC_KEY_V2_BYTES) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Requester public key must be 32 bytes' });
      } else if (encodeBase64(publicKeyBytes, 'base64url') !== value) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Requester public key must be canonical base64url' });
      }
    } catch {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid requester public key' });
    }
  }));

export const HomeQrInviteV2Schema = lazyZodSchema(() => z.discriminatedUnion('direction', [
  z.object({
    ...HomeQrInviteV2CommonShape,
    direction: z.literal('trusted_home_displays'),
  }).strict(),
  z.object({
    ...HomeQrInviteV2CommonShape,
    direction: z.literal('requester_displays'),
    requesterPublicKeyBase64Url: HomeQrRequesterPublicKeyBase64UrlV2Schema,
  }).strict(),
]).superRefine((value, context) => {
  try {
    const secretBytes = decodeBase64(value.qrSecretBase64Url, 'base64url');
    if (secretBytes.length !== HOME_QR_SECRET_V2_BYTES) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'QR secret must be 32 bytes' });
    } else if (encodeBase64(secretBytes, 'base64url') !== value.qrSecretBase64Url) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'QR secret must be canonical base64url' });
    }
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid QR secret' });
  }
  if (value.expiresAtMs <= value.issuedAtMs) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid invite expiry' });
  } else if (value.expiresAtMs - value.issuedAtMs > HOME_QR_INVITE_V2_MAX_TTL_MS) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invite TTL exceeds the pairing maximum' });
  }
}));
export type HomeQrInviteV2 = z.infer<typeof HomeQrInviteV2Schema>;

export type HomeQrBindingContextV2 = Readonly<{
  direction: HomeQrInviteDirectionV2;
  pairId: string;
  homeServerIdentityId: string;
  requesterPublicKey: Uint8Array;
  expiresAtMs: number;
}>;

export type HomeQrBindingParamsV2 = Readonly<HomeQrBindingContextV2 & {
  qrSecret: Uint8Array;
}>;

const CanonicalHomeQrPairingExpiryV2Schema = lazyZodSchema(() => z.string().superRefine((value, context) => {
  const timestamp = Date.parse(value);
  if (!Number.isSafeInteger(timestamp) || new Date(timestamp).toISOString() !== value) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Pairing expiry must be a canonical ISO timestamp' });
  }
}));

const CanonicalHomeQrRequesterPublicKeyV2Schema = lazyZodSchema(() => z.string().superRefine((value, context) => {
  try {
    const bytes = decodeBase64(value, 'base64');
    if (bytes.length !== HOME_QR_REQUESTER_PUBLIC_KEY_V2_BYTES || encodeBase64(bytes, 'base64') !== value) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Requester public key must be canonical padded base64 for 32 bytes' });
    }
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid requester public key' });
  }
}));

const CanonicalHomeQrBindingProofV2Schema = lazyZodSchema(() => z.string().superRefine((value, context) => {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid binding proof' });
    return;
  }
  try {
    const bytes = decodeBase64(value, 'base64url');
    if (bytes.length !== 32 || encodeBase64(bytes, 'base64url') !== value) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Binding proof must be canonical base64url for 32 bytes' });
    }
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid binding proof' });
  }
}));

const HomeQrPairingStatusPairIdV2Schema = lazyZodSchema(() => z.string().min(1).max(128).superRefine((value, context) => {
  if (UTF8_ENCODER.encode(value).byteLength > 128) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Pair ID exceeds its UTF-8 byte limit' });
  }
}));

export const HomeQrPairingStatusV2Schema = lazyZodSchema(() => z.discriminatedUnion('state', [
  z.object({
    state: z.literal('pending'),
    pairId: HomeQrPairingStatusPairIdV2Schema,
    expiresAt: CanonicalHomeQrPairingExpiryV2Schema,
  }).strict(),
  z.object({
    state: z.literal('requested'),
    pairId: HomeQrPairingStatusPairIdV2Schema,
    expiresAt: CanonicalHomeQrPairingExpiryV2Schema,
    requestedPublicKey: CanonicalHomeQrRequesterPublicKeyV2Schema,
    requestedDeviceLabel: z.string().max(256).nullable(),
    bindingProof: CanonicalHomeQrBindingProofV2Schema,
    homeServerIdentityId: z.string().min(1).max(256),
  }).strict(),
]));
export type HomeQrPairingStatusV2 = z.infer<typeof HomeQrPairingStatusV2Schema>;

/** Strict normalizer for the existing direct-Home pairing status response. */
export function parseHomeQrPairingStatusV2(value: unknown): HomeQrPairingStatusV2 | null {
  const parsed = HomeQrPairingStatusV2Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function assertQrSecretV2(qrSecret: Uint8Array): void {
  if (qrSecret.length !== HOME_QR_SECRET_V2_BYTES) throw new Error('QR secret must be 32 bytes');
}

function assertHomeQrBindingContextV2(context: HomeQrBindingContextV2): void {
  if (!HOME_QR_INVITE_DIRECTIONS_V2.includes(context.direction)) {
    throw new Error('Invalid Home QR invite direction');
  }
  if (context.requesterPublicKey.length !== HOME_QR_REQUESTER_PUBLIC_KEY_V2_BYTES) {
    throw new Error('Requester X25519 box public key must be 32 bytes');
  }
  if (!Number.isSafeInteger(context.expiresAtMs) || context.expiresAtMs < 0) {
    throw new Error('Invalid invite expiry timestamp');
  }
}

/**
 * Canonical binding input, length-delimited in this exact conceptual order:
 * protocol version, intent, display direction, pairId, target
 * homeServerIdentityId, requester X25519 box public key (exactly 32 bytes),
 * expiresAtMs.
 */
export function createHomeQrBindingInputV2(context: HomeQrBindingContextV2): Uint8Array {
  assertHomeQrBindingContextV2(context);
  return encodeCanonicalLengthDelimited([
    HOME_QR_BINDING_PROTOCOL_VERSION_V2,
    HOME_QR_BINDING_INTENT_V2,
    context.direction,
    context.pairId,
    context.homeServerIdentityId,
    context.requesterPublicKey,
    String(context.expiresAtMs),
  ]);
}

export function deriveHomeQrRendezvousSecretV2(qrSecret: Uint8Array): Uint8Array {
  assertQrSecretV2(qrSecret);
  return hmac(sha256, qrSecret, UTF8_ENCODER.encode(HOME_QR_RENDEZVOUS_DOMAIN_V2));
}

export function deriveHomeQrBindingKeyV2(qrSecret: Uint8Array): Uint8Array {
  assertQrSecretV2(qrSecret);
  return hmac(sha256, qrSecret, UTF8_ENCODER.encode(HOME_QR_BINDING_DOMAIN_V2));
}

/**
 * Verifier handed to the relay for the pending pairing row: a plain SHA-256
 * of the high-entropy rendezvous secret. The relay can match the row without
 * learning the secret and can never derive the binding key from it.
 */
export function deriveHomeQrRendezvousVerifierV2(qrSecret: Uint8Array): Uint8Array {
  return sha256(deriveHomeQrRendezvousSecretV2(qrSecret));
}

function equalBytesConstantTime(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

/** Verifies the already-derived rendezvous secret sent by the joining client. */
export function verifyHomeQrRendezvousSecretV2(
  rendezvousSecret: Uint8Array,
  verifier: Uint8Array,
): boolean {
  if (rendezvousSecret.length !== HOME_QR_SECRET_V2_BYTES || verifier.length !== HOME_QR_SECRET_V2_BYTES) {
    return false;
  }
  return equalBytesConstantTime(sha256(rendezvousSecret), verifier);
}

function computeHomeQrBindingProofBytesV2(params: HomeQrBindingParamsV2): Uint8Array {
  assertQrSecretV2(params.qrSecret);
  return hmac(sha256, deriveHomeQrBindingKeyV2(params.qrSecret), createHomeQrBindingInputV2(params));
}

/** Canonical base64url binding proof over the canonical binding input. */
export function computeHomeQrBindingProofV2(params: HomeQrBindingParamsV2): string {
  return encodeBase64(computeHomeQrBindingProofBytesV2(params), 'base64url');
}

/** Constant-time verification; rejects noncanonical or wrong-length proof encodings. */
export function verifyHomeQrBindingProofV2(params: HomeQrBindingParamsV2, proofBase64Url: string): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(proofBase64Url)) return false;
  try {
    const proofBytes = decodeBase64(proofBase64Url, 'base64url');
    if (proofBytes.length !== 32) return false;
    if (encodeBase64(proofBytes, 'base64url') !== proofBase64Url) return false;
    return equalBytesConstantTime(proofBytes, computeHomeQrBindingProofBytesV2(params));
  } catch {
    return false;
  }
}

/**
 * Client-neutral trusted-device admission for a requested pairing status.
 * Returns the exact requester key only after the wire, identity, expiry, optional
 * expected requester, and QR-secret-bound proof all agree.
 */
export function verifyHomeQrRequesterProofV2(input: Readonly<Omit<HomeQrBindingParamsV2, 'requesterPublicKey'> & {
  issuedAtMs: number;
  nowMs: number;
  status: Extract<HomeQrPairingStatusV2, { state: 'requested' }>;
  expectedRequesterPublicKey?: Uint8Array;
}>): Uint8Array | null {
  const parsedStatus = HomeQrPairingStatusV2Schema.safeParse(input.status);
  if (!parsedStatus.success || parsedStatus.data.state !== 'requested') return null;
  if (!Number.isSafeInteger(input.issuedAtMs) || !Number.isSafeInteger(input.nowMs)) return null;
  if (input.nowMs < input.issuedAtMs || input.nowMs >= input.expiresAtMs) return null;
  if (
    parsedStatus.data.pairId !== input.pairId
    || parsedStatus.data.homeServerIdentityId !== input.homeServerIdentityId
    || Date.parse(parsedStatus.data.expiresAt) !== input.expiresAtMs
  ) return null;

  const requesterPublicKey = decodeBase64(parsedStatus.data.requestedPublicKey, 'base64');
  if (input.expectedRequesterPublicKey !== undefined) {
    if (input.expectedRequesterPublicKey.length !== HOME_QR_REQUESTER_PUBLIC_KEY_V2_BYTES) return null;
    if (!equalBytesConstantTime(requesterPublicKey, input.expectedRequesterPublicKey)) return null;
  }
  return verifyHomeQrBindingProofV2({
    direction: input.direction,
    qrSecret: input.qrSecret,
    pairId: input.pairId,
    homeServerIdentityId: input.homeServerIdentityId,
    requesterPublicKey,
    expiresAtMs: input.expiresAtMs,
  }, parsedStatus.data.bindingProof)
    ? requesterPublicKey
    : null;
}

/** Constant-time verifier check against a stored relay verifier. */
export function verifyHomeQrRendezvousVerifierV2(qrSecret: Uint8Array, verifier: Uint8Array): boolean {
  try {
    return verifyHomeQrRendezvousSecretV2(deriveHomeQrRendezvousSecretV2(qrSecret), verifier);
  } catch {
    return false;
  }
}

/**
 * Canonical deterministic invite encoding: strict schema validation, canonical
 * JSON key order, bounded payload, unpadded base64url. Throws on invalid
 * producers (caller-owned invite construction) and oversized payloads.
 */
export function encodeHomeQrInviteV2Payload(invite: HomeQrInviteV2): string {
  const parsed = HomeQrInviteV2Schema.parse(invite);
  const bytes = UTF8_ENCODER.encode(createCanonicalJsonSigningInput(parsed));
  if (bytes.byteLength > HOME_QR_INVITE_V2_MAX_PAYLOAD_UTF8_BYTES) {
    throw new Error('Home QR invite payload exceeds its size limit');
  }
  return encodeBase64(bytes, 'base64url');
}

/**
 * Strict opaque-payload parse for happier:// link consumers. Rejects
 * noncanonical base64url, noncanonical JSON byte forms, unknown/missing/
 * invalid fields, oversized payloads, and non-fresh invites. Returns null on
 * every failure; never throws, never logs payload contents.
 */
export function parseHomeQrInviteV2Payload(
  payload: string,
  options: Readonly<{ nowMs: number }>,
): HomeQrInviteV2 | null {
  if (payload.length > Math.ceil(HOME_QR_INVITE_V2_MAX_PAYLOAD_UTF8_BYTES / 3) * 4) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) return null;
  const bytes = decodeBase64(payload, 'base64url');
  if (bytes.length === 0 || bytes.byteLength > HOME_QR_INVITE_V2_MAX_PAYLOAD_UTF8_BYTES) return null;

  let value: unknown;
  try {
    value = JSON.parse(UTF8_DECODER.decode(bytes));
  } catch {
    return null;
  }
  const parsed = HomeQrInviteV2Schema.safeParse(value);
  if (!parsed.success) return null;
  // Alternate encodings of a schema-valid invite (different key order,
  // duplicate keys, whitespace) are not the canonical payload form.
  if (encodeHomeQrInviteV2Payload(parsed.data) !== payload) return null;

  const { nowMs } = options;
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) return null;
  if (parsed.data.issuedAtMs > nowMs + HOME_QR_INVITE_V2_MAX_FUTURE_ISSUANCE_SKEW_MS) return null;
  if (nowMs > parsed.data.expiresAtMs) return null;
  return parsed.data;
}

export type HomeQrReverseInviteV2Material = Readonly<{
  invite: HomeQrInviteV2;
  qrSecret: Uint8Array;
  requesterPublicKey: Uint8Array;
  requesterSecretKey: Uint8Array;
}>;

/**
 * A6 requester-displayed invite material: the credentialless but known-target
 * requester owns one CSPRNG pair-ID candidate, one 32-byte QR secret, one
 * ephemeral X25519 box keypair, and the bounded exact invite window. The
 * descriptor must already be verified by the caller; the returned invite is
 * encoded canonically through `encodeHomeQrInviteV2Payload` and the pairing is
 * started by the enrolled scanner with the proposed (pairId, verifier, exact
 * expiry) tuple — the server never rewrites the expiry.
 */
export function createHomeQrReverseInviteV2(input: Readonly<{
  home: HomeConnectionDescriptorV1;
  nowMs: number;
  ttlMs?: number;
  requestedDeviceLabel?: string;
}>): HomeQrReverseInviteV2Material {
  const { nowMs } = input;
  const ttlMs = input.ttlMs ?? HOME_QR_INVITE_V2_DEFAULT_TTL_MS;
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('Invalid issuance timestamp');
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > HOME_QR_INVITE_V2_MAX_TTL_MS) {
    throw new Error('Invite TTL exceeds the pairing maximum');
  }
  const qrSecret = new Uint8Array(tweetnacl.randomBytes(HOME_QR_SECRET_V2_BYTES));
  const keyPair = tweetnacl.box.keyPair();
  const invite: HomeQrInviteV2 = {
    v: 2,
    intent: 'home_device',
    direction: 'requester_displays',
    requesterPublicKeyBase64Url: encodeBase64(keyPair.publicKey, 'base64url'),
    pairId: encodeBase64(tweetnacl.randomBytes(HOME_QR_SECRET_V2_BYTES), 'base64url'),
    home: input.home,
    qrSecretBase64Url: encodeBase64(qrSecret, 'base64url'),
    issuedAtMs: nowMs,
    expiresAtMs: nowMs + ttlMs,
    ...(input.requestedDeviceLabel === undefined ? {} : { requestedDeviceLabel: input.requestedDeviceLabel }),
  };
  return {
    invite,
    qrSecret,
    requesterPublicKey: new Uint8Array(keyPair.publicKey),
    requesterSecretKey: new Uint8Array(keyPair.secretKey),
  };
}
