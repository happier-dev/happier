import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

/**
 * Canonical Iroh endpoint sub-descriptor (V1).
 *
 * This module is the single wire definition for the Iroh endpoint entry inside
 * `HomeConnectionDescriptorV1`. The outer descriptor composition (account
 * directory) consumes and re-exports it; native packages adapt to it. There
 * must never be a second Iroh descriptor shape or permissive parser.
 *
 * Wire contract (00-ARCHITECTURE.md / lane-06 §7.2): the parent descriptor `v`
 * is the only version field — no nested duplicate version. The descriptor is
 * strict/bounded and carries transport identity only: no bearer tokens, Home
 * credentials, account credentials, arbitrary headers, local paths, target
 * ports, ALPN arrays, or expiry fields.
 */

export const IROH_ENDPOINT_DESCRIPTOR_VERSION_V1 = 1 as const;

export const IROH_DESCRIPTOR_MAX_URL_UTF8_BYTES = 512;

const UTF8_ENCODER = new TextEncoder();

function boundedUtf8(value: string, maxBytes: number): boolean {
  return UTF8_ENCODER.encode(value).byteLength <= maxBytes;
}

/**
 * Lexical transport-identity grammar. Iroh 1.1 `EndpointId::Display` emits a
 * 32-byte key as 64 lowercase hex characters, while `FromStr` also admits the
 * exact-length unpadded RFC4648 base32 form (52 chars = 32 bytes). The native
 * validator delegates to that parser after this wire-level lexical check. This
 * is layered validation only: the native Iroh parser remains the final
 * cryptographic authority.
 */
const IROH_ENDPOINT_ID_HEX_PATTERN = /^[0-9a-f]{64}$/u;
const IROH_ENDPOINT_ID_BASE32_PATTERN = /^[a-z2-7]{52}$/u;

function isValidIrohEndpointIdEncoding(value: string): boolean {
  return IROH_ENDPOINT_ID_HEX_PATTERN.test(value) || IROH_ENDPOINT_ID_BASE32_PATTERN.test(value);
}

/** Strict IPv4 grammar (mirrors the Rust std parser: 0-255 octets, no leading zeros). */
function isValidIpv4Address(value: string): boolean {
  const octets = value.split('.');
  if (octets.length !== 4) return false;
  return octets.every((octet) => {
    if (!/^[0-9]{1,3}$/u.test(octet)) return false;
    if (octet.length > 1 && octet.startsWith('0')) return false;
    return Number(octet) <= 255;
  });
}

/** Groups of 1-4 hex digits; returns the group count, or null when malformed. */
function parseIpv6Groups(section: string): number | null {
  if (section === '') return 0;
  const groups = section.split(':');
  for (const group of groups) {
    if (!/^[0-9A-Fa-f]{1,4}$/u.test(group)) return null;
  }
  return groups.length;
}

/** Lexical IPv6 grammar: one optional `::` compression, optional embedded IPv4 tail. */
function isValidIpv6Address(value: string): boolean {
  if (!value) return false;
  let body = value;
  let tailGroups = 0;
  const lastColonIndex = value.lastIndexOf(':');
  const possibleTail = lastColonIndex >= 0 ? value.slice(lastColonIndex + 1) : value;
  if (possibleTail.includes('.')) {
    // Embedded IPv4 tail (`::ffff:192.0.2.1`) encodes the final two groups.
    if (lastColonIndex < 0 || !isValidIpv4Address(possibleTail)) return false;
    tailGroups = 2;
    body = value.slice(0, lastColonIndex);
  }
  const sections = body.split('::');
  if (sections.length > 2) return false;
  if (sections.length === 1) {
    const groups = parseIpv6Groups(sections[0] ?? '');
    return groups !== null && groups + tailGroups === 8;
  }
  const left = parseIpv6Groups(sections[0] ?? '');
  const right = parseIpv6Groups(sections[1] ?? '');
  if (left === null || right === null) return false;
  // `::` must stand for at least one group.
  return left + right + tailGroups <= 7;
}

/**
 * V1 direct address hints are IP socket addresses only (strict `IPv4:port` or
 * bracketed `[IPv6]:port`, port 1..65535 in canonical decimal form). No DNS
 * names, URLs, paths, credentials, zero ports, leading-zero ports, or
 * unbracketed IPv6: the Home tunnel dials exactly these explicit addresses and
 * its native socket parser consumes the same grammar.
 */
function isValidIpSocketAddress(value: string): boolean {
  const separatorIndex = value.lastIndexOf(':');
  if (separatorIndex < 0) return false;
  const portRaw = value.slice(separatorIndex + 1);
  if (!/^[0-9]{1,5}$/u.test(portRaw)) return false;
  // Canonical decimal form only: a leading-zero port is an ambiguous encoding
  // the native socket parser must never have to reinterpret.
  if (portRaw.length > 1 && portRaw.startsWith('0')) return false;
  const port = Number(portRaw);
  if (port < 1 || port > 65_535) return false;
  const host = value.slice(0, separatorIndex);
  if (host.startsWith('[')) {
    return host.endsWith(']') && isValidIpv6Address(host.slice(1, -1));
  }
  return !host.includes(':') && isValidIpv4Address(host);
}

/** Absolute HTTP(S) URL without credentials, query material, or a fragment. */
const IrohDescriptorUrlSchema = lazyZodSchema(() => z.string()
  .trim()
  .min(1)
  .max(IROH_DESCRIPTOR_MAX_URL_UTF8_BYTES)
  .superRefine((value, context) => {
    if (!boundedUtf8(value, IROH_DESCRIPTOR_MAX_URL_UTF8_BYTES)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'URL exceeds its UTF-8 byte limit' });
    }
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'URL must use HTTP or HTTPS' });
      }
      if (parsed.username || parsed.password || value.includes('?') || parsed.hash) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'URL must not contain credentials, query material, or a fragment' });
      }
    } catch {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'URL must be absolute' });
    }
  }));

/** Exact transport identifier; its 52/64-character grammar is already its complete bound. */
export const IrohEndpointIdV1Schema = lazyZodSchema(() => z.string()
  .trim()
  .min(1)
  .superRefine((value, context) => {
    if (!isValidIrohEndpointIdEncoding(value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'EndpointId must be 64 lowercase hex or 52 lowercase RFC4648 base32 characters',
      });
    }
  }));

/**
 * Canonical relay-URL equivalence. Two spellings that parse to the same URL are
 * the same relay, so the descriptor compares them in that normalized form
 * (`https://relay.test` and `https://relay.test/` are one entry, not two).
 *
 * This is the same equivalence the native transport owner applies: iroh's
 * `RelayUrl` parser normalizes before `RelaySelection::resolve`
 * (packages/iroh-native/rust/happier-iroh-core/src/endpoint.rs) rejects
 * duplicates. Admitting a pair here that the transport refuses would publish a
 * descriptor that cannot be bound.
 *
 * A value that does not parse has already failed the item schema; it keeps its
 * literal form so the duplicate check never masks that error.
 */
function canonicalRelayUrl(value: string): string {
  try {
    return new URL(value).toString();
  } catch {
    return value;
  }
}

/**
 * Strict hint list: non-empty and free of duplicate entries, compared through
 * `canonical` (identity unless the item type has a normalized form). Item
 * grammar and length stay bounded here; the actual HTTP and QR decoders own
 * their total encoded-body budgets. There is no unrelated semantic item quota.
 */
function IrohHintListSchema(
  item: z.ZodType<string>,
  canonical: (value: string) => string = (value) => value,
) {
  return z.array(item).min(1).superRefine((values, context) => {
    if (new Set(values.map(canonical)).size !== values.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Hint lists must not contain duplicate entries',
      });
    }
  });
}

export const IrohEndpointDescriptorV1Schema = lazyZodSchema(() => z.object({
  endpointId: IrohEndpointIdV1Schema,
  relayUrls: IrohHintListSchema(
    IrohDescriptorUrlSchema,
    canonicalRelayUrl,
  ).optional(),
  directAddresses: IrohHintListSchema(
    z.string().trim().min(1).max(256).superRefine((value, context) => {
      if (!isValidIpSocketAddress(value)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Direct address must be a strict IPv4:port or bracketed [IPv6]:port socket address with a canonical port 1..65535',
        });
      }
    }),
  ).optional(),
}).strict());

export type IrohEndpointDescriptorV1 = z.infer<typeof IrohEndpointDescriptorV1Schema>;

/** Strict, bounded parser for remotely supplied Iroh endpoint descriptors. */
export function parseIrohEndpointDescriptorV1(value: unknown): IrohEndpointDescriptorV1 {
  const result = IrohEndpointDescriptorV1Schema.safeParse(value);
  if (!result.success) throw new TypeError('Invalid Iroh endpoint descriptor');
  return result.data;
}
