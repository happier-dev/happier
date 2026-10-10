import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import { decodeBase64, encodeBase64 } from '../crypto/base64.js';
import { HomeConnectionDescriptorV1Schema, type HomeConnectionDescriptorV1 } from './accountDirectory.js';

export const TERMINAL_CONNECT_LINK_WIRE_VERSION_V4 = 4 as const;
const TERMINAL_CONNECT_LINK_V4_PARAMETER = 'v4' as const;
const TERMINAL_CONNECT_LINK_V4_MAX_PAYLOAD_UTF8_BYTES = 16 * 1024;

function canonicalBase64UrlBytesSchema(expectedBytes: number): z.ZodType<string> {
  return z.string().min(1).max(Math.ceil(expectedBytes / 3) * 4).refine((value) => {
    if (!/^[A-Za-z0-9_-]+$/u.test(value)) return false;
    try {
      const decoded = decodeBase64(value, 'base64url');
      return decoded.byteLength === expectedBytes && encodeBase64(decoded, 'base64url') === value;
    } catch {
      return false;
    }
  }, `must be canonical base64url encoding of ${expectedBytes} bytes`);
}

const TimestampMsSchema = lazyZodSchema(() => z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));

/**
 * The pairing context remains V3: V4 versions only the authority-bearing link
 * envelope. Its Home identity is the credential destination and must match the
 * strict connection descriptor below.
 */
export const TerminalConnectPairingContextV3Schema = lazyZodSchema(() => z.object({
  v: z.literal(3),
  secretB64Url: canonicalBase64UrlBytesSchema(32),
  createdAtMs: TimestampMsSchema,
  expiresAtMs: TimestampMsSchema,
  homeServerIdentityId: HomeConnectionDescriptorV1Schema.shape.homeServerIdentityId,
  supportsTokenOnly: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.expiresAtMs <= value.createdAtMs) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['expiresAtMs'],
      message: 'Pairing expiry must be after creation',
    });
  }
}));
export type TerminalConnectPairingContextV3 = z.infer<typeof TerminalConnectPairingContextV3Schema>;

export const TerminalConnectLinkV4EnvelopeSchema = lazyZodSchema(() => z.object({
  v: z.literal(TERMINAL_CONNECT_LINK_WIRE_VERSION_V4),
  publicKeyB64Url: canonicalBase64UrlBytesSchema(32),
  pairing: TerminalConnectPairingContextV3Schema,
  homeConnectionDescriptor: HomeConnectionDescriptorV1Schema,
}).strict().superRefine((value, context) => {
  if (value.pairing.homeServerIdentityId !== value.homeConnectionDescriptor.homeServerIdentityId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['pairing', 'homeServerIdentityId'],
      message: 'V3 pairing credential destination must match the Home descriptor identity',
    });
  }
}));
export type TerminalConnectLinkV4Envelope = z.infer<typeof TerminalConnectLinkV4EnvelopeSchema>;

export type TerminalConnectLinkV4CredentialDestination = Readonly<{
  homeServerIdentityId: string;
  descriptor: HomeConnectionDescriptorV1;
}>;

/**
 * Decides the credential destination from the one validated V4 authority
 * envelope. A mismatch fails closed; consumers never derive a URL fallback.
 */
export function readTerminalConnectLinkV4CredentialDestination(
  value: unknown,
): TerminalConnectLinkV4CredentialDestination | null {
  const parsed = TerminalConnectLinkV4EnvelopeSchema.safeParse(value);
  if (!parsed.success) return null;
  return {
    homeServerIdentityId: parsed.data.pairing.homeServerIdentityId,
    descriptor: parsed.data.homeConnectionDescriptor,
  };
}

export function encodeTerminalConnectLinkV4Payload(value: TerminalConnectLinkV4Envelope): string {
  const parsed = TerminalConnectLinkV4EnvelopeSchema.parse(value);
  const bytes = new TextEncoder().encode(JSON.stringify(parsed));
  if (bytes.byteLength > TERMINAL_CONNECT_LINK_V4_MAX_PAYLOAD_UTF8_BYTES) {
    throw new Error('Terminal connect V4 payload exceeds its bounded wire size');
  }
  return encodeBase64(bytes, 'base64url');
}

export function decodeTerminalConnectLinkV4Payload(payload: string): TerminalConnectLinkV4Envelope | null {
  if (!payload || !/^[A-Za-z0-9_-]+$/u.test(payload)) return null;
  try {
    const bytes = decodeBase64(payload, 'base64url');
    if (
      bytes.byteLength > TERMINAL_CONNECT_LINK_V4_MAX_PAYLOAD_UTF8_BYTES
      || encodeBase64(bytes, 'base64url') !== payload
    ) {
      return null;
    }
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const parsed = TerminalConnectLinkV4EnvelopeSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function parseParameters(parameters: string | URLSearchParams): URLSearchParams {
  return typeof parameters === 'string'
    ? new URLSearchParams(parameters.replace(/^[?#]/u, ''))
    : parameters;
}

export function parseTerminalConnectLinkV4Parameters(
  parameters: string | URLSearchParams,
): TerminalConnectLinkV4Envelope | null {
  const parsed = parseParameters(parameters);
  const keys = [...parsed.keys()];
  if (keys.length !== 1 || keys[0] !== TERMINAL_CONNECT_LINK_V4_PARAMETER) return null;
  const payloads = parsed.getAll(TERMINAL_CONNECT_LINK_V4_PARAMETER);
  return payloads.length === 1 ? decodeTerminalConnectLinkV4Payload(payloads[0]!) : null;
}

export type TerminalConnectLinkParameterClassification = 'v4' | 'legacy' | 'unknown';

export function classifyTerminalConnectLinkParameters(
  parameters: string | URLSearchParams,
): TerminalConnectLinkParameterClassification {
  const parsed = parseParameters(parameters);
  if (parseTerminalConnectLinkV4Parameters(parsed)) return 'v4';
  if (!parsed.has(TERMINAL_CONNECT_LINK_V4_PARAMETER) && (parsed.get('key') ?? '').trim()) return 'legacy';
  return 'unknown';
}
