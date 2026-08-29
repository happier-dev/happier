import { z } from 'zod';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha2';
import { decodeBase64, encodeBase64 } from './base64.js';
import { encodeCanonicalLengthDelimited } from './canonicalDigest.js';
import { HomeConnectionDescriptorV1Schema } from '../auth/accountDirectory.js';

export const HOME_QR_RENDEZVOUS_DOMAIN_V2 = 'happier/qr/rendezvous/v2' as const;
export const HOME_QR_BINDING_DOMAIN_V2 = 'happier/qr/binding/v2' as const;

export const HomeQrInviteV2Schema = z.object({
  v: z.literal(2),
  intent: z.literal('home_device'),
  pairId: z.string().min(1).max(128),
  home: HomeConnectionDescriptorV1Schema,
  qrSecretBase64Url: z.string().regex(/^[A-Za-z0-9_-]+$/u),
  issuedAtMs: z.number().int().nonnegative(),
  expiresAtMs: z.number().int().nonnegative(),
  requestedDeviceLabel: z.string().min(1).max(120).optional(),
}).strict().superRefine((value, ctx) => {
  try {
    if (decodeBase64(value.qrSecretBase64Url, 'base64url').length !== 32) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'QR secret must be 32 bytes' });
    }
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid QR secret' });
  }
  if (value.expiresAtMs <= value.issuedAtMs) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid invite expiry' });
  }
});
export type HomeQrInviteV2 = z.infer<typeof HomeQrInviteV2Schema>;

export function deriveHomeQrRendezvousSecretV2(qrSecret: Uint8Array): Uint8Array {
  if (qrSecret.length !== 32) throw new Error('QR secret must be 32 bytes');
  return hmac(sha256, qrSecret, new TextEncoder().encode(HOME_QR_RENDEZVOUS_DOMAIN_V2));
}

export function deriveHomeQrBindingKeyV2(qrSecret: Uint8Array): Uint8Array {
  if (qrSecret.length !== 32) throw new Error('QR secret must be 32 bytes');
  return hmac(sha256, qrSecret, new TextEncoder().encode(HOME_QR_BINDING_DOMAIN_V2));
}

function bindingInput(params: Readonly<{ pairId: string; homeServerIdentityId: string; requesterPublicKey: Uint8Array; expiresAtMs: number }>): Uint8Array {
  return encodeCanonicalLengthDelimited([
    HOME_QR_BINDING_DOMAIN_V2,
    params.pairId,
    params.homeServerIdentityId,
    params.requesterPublicKey,
    String(params.expiresAtMs),
  ]);
}

export function computeHomeQrBindingProofV2(params: Readonly<{ qrSecret: Uint8Array; pairId: string; homeServerIdentityId: string; requesterPublicKey: Uint8Array; expiresAtMs: number }>): string {
  return encodeBase64(hmac(sha256, deriveHomeQrBindingKeyV2(params.qrSecret), bindingInput(params)), 'base64url');
}

export function computeHomeQrConfirmationCodeV2(params: Readonly<{ qrSecret: Uint8Array; pairId: string; homeServerIdentityId: string; requesterPublicKey: Uint8Array; expiresAtMs: number }>): string {
  const digest = hmac(sha256, deriveHomeQrBindingKeyV2(params.qrSecret), bindingInput(params));
  const value = new DataView(digest.buffer, digest.byteOffset).getUint32(0, false) % 1_000_000;
  return String(value).padStart(6, '0');
}
