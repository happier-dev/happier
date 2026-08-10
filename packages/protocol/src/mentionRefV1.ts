import { z } from 'zod';

/**
 * `MentionRefV1` is the one-way persisted, transmitted and publicly exported shape
 * for a composer reference (D-13). Additive changes only.
 *
 * It carries **identity only** — never provider context. Provider context (a skill's
 * `path`, a vendor plugin's label) is reconstructed at send time from canonical state
 * (D-3, INV-9), because a path embedded in a long-lived reference goes stale.
 */

/**
 * Built-in kinds are namespaced so a later plugin-contributed kind cannot collide with
 * one of ours (D-12). `kind` itself stays an OPEN string: a well-formed reference of an
 * unknown kind survives load, save and transmission inert, and is never reinterpreted as
 * a known kind (INV-4).
 */
export const MENTION_KIND_V1 = {
  file: 'happier.file',
  skill: 'happier.skill',
  vendorPlugin: 'happier.vendorPlugin',
  session: 'happier.session',
} as const;

export type BuiltInMentionKindV1 = (typeof MENTION_KIND_V1)[keyof typeof MENTION_KIND_V1];

/** The `<scheme>` each built-in kind's `ref` uses. Derived in EU-D0 from producer state. */
export const MENTION_REF_SCHEME_V1 = {
  [MENTION_KIND_V1.file]: 'file',
  [MENTION_KIND_V1.skill]: 'skill',
  [MENTION_KIND_V1.vendorPlugin]: 'vendorPlugin',
  [MENTION_KIND_V1.session]: 'session',
} as const satisfies Readonly<Record<BuiltInMentionKindV1, string>>;

export const MENTION_BOUNDS = {
  maxPerMessage: 64,
  maxKindChars: 64,
  maxRefChars: 512,
  maxTokenChars: 256,
  maxLabelChars: 256,
  maxReferenceBlockChars: 2_000,
  /** Bounds the sum of all resolved reference context in one message (D-27). */
  maxResolvedContextChars: 2_000,
} as const;

/**
 * Reference grammar (binding): `<scheme>:<opaque>`. No authority, query, fragment or
 * user-info component — the authority form was rejected in D-8 because the nearest
 * server-scope owner falls back to a device-local profile id, which must never enter a
 * persisted cross-device reference.
 *
 * Everything outside this set is percent-encoded in `<opaque>`, `%` included, so the
 * encoding is lossless and the readable case stays readable (`skill:vendor:codex:review`).
 * `:` is deliberately unreserved: the scheme is delimited by the FIRST colon only.
 */
const MENTION_REF_UNRESERVED = /^[A-Za-z0-9._~:@/-]$/;
const MENTION_REF_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*$/;
const MENTION_REF_PERCENT_ESCAPE = /^%[0-9A-Fa-f]{2}/;

export function encodeMentionRefComponent(value: string): string {
  let encoded = '';
  for (const character of value) {
    if (character.length === 1 && MENTION_REF_UNRESERVED.test(character)) {
      encoded += character;
      continue;
    }
    for (const byte of new TextEncoder().encode(character)) {
      encoded += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return encoded;
}

/** Returns `null` for a malformed escape sequence rather than silently keeping it raw. */
export function decodeMentionRefComponent(value: string): string | null {
  const bytes: number[] = [];
  let index = 0;
  while (index < value.length) {
    const character = value[index] as string;
    if (character !== '%') {
      for (const byte of new TextEncoder().encode(character)) bytes.push(byte);
      index += 1;
      continue;
    }
    const escape = value.slice(index, index + 3);
    if (!MENTION_REF_PERCENT_ESCAPE.test(escape)) return null;
    bytes.push(Number.parseInt(escape.slice(1), 16));
    index += 3;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
}

export function buildMentionRefV1(scheme: string, opaque: string): string {
  return `${scheme}:${encodeMentionRefComponent(opaque)}`;
}

export function parseMentionRefV1(ref: string): Readonly<{ scheme: string; opaque: string }> | null {
  const separator = ref.indexOf(':');
  if (separator <= 0 || separator === ref.length - 1) return null;
  const scheme = ref.slice(0, separator);
  if (!MENTION_REF_SCHEME_PATTERN.test(scheme)) return null;
  const opaque = decodeMentionRefComponent(ref.slice(separator + 1));
  if (opaque === null || opaque.length === 0) return null;
  return { scheme, opaque };
}

/**
 * Range contract (binding): UTF-16 code-unit offsets matching JS `slice`; half-open
 * `[start, end)`; integers with `0 <= start < end <= text.length`;
 * `text.slice(start, end) === token`; sorted and non-overlapping across the array.
 *
 * The bound that needs the message text (`slice === token`) cannot live here, because the
 * protocol sanitizer parses metadata independently of the text it accompanies — it is the
 * composed admission step, `admitMentionRefsV1ForText`.
 *
 * `token` is deliberately NOT trimmed: it must equal the exact slice.
 */
export const MentionRefV1Schema = z.object({
  kind: z.string().trim().min(1).max(MENTION_BOUNDS.maxKindChars),
  ref: z.string().trim().min(1).max(MENTION_BOUNDS.maxRefChars),
  token: z.string().min(1).max(MENTION_BOUNDS.maxTokenChars),
  start: z.number().int().min(0),
  end: z.number().int().min(1),
  label: z.string().trim().min(1).max(MENTION_BOUNDS.maxLabelChars).optional(),
}).passthrough()
  .refine((mention) => mention.start < mention.end, { path: ['end'] })
  .refine((mention) => parseMentionRefV1(mention.ref) !== null, { path: ['ref'] });

export type MentionRefV1 = z.infer<typeof MentionRefV1Schema>;

/**
 * The two directions of a built-in kind's reference, so no consumer has to know which
 * `<scheme>` belongs to which kind. `readMentionRefOpaqueForKindV1` returns `null` when the
 * scheme does not match the kind asked for, which is what keeps a mismatched or unknown
 * reference from being reinterpreted as a known kind (INV-4).
 */
export function buildMentionRefForKindV1(kind: BuiltInMentionKindV1, opaque: string): string {
  return buildMentionRefV1(MENTION_REF_SCHEME_V1[kind], opaque);
}

export function readMentionRefOpaqueForKindV1(kind: BuiltInMentionKindV1, ref: string): string | null {
  const parsed = parseMentionRefV1(ref);
  if (!parsed || parsed.scheme !== MENTION_REF_SCHEME_V1[kind]) return null;
  return parsed.opaque;
}

/**
 * Element-wise sanitization (INV-4). A failing element is dropped **individually**; its
 * siblings survive. Order is canonicalized to sorted-by-range, and an element overlapping
 * an already-accepted one is dropped as malformed.
 */
export function sanitizeMentionRefsV1(value: unknown): MentionRefV1[] {
  if (!Array.isArray(value)) return [];

  const parsed: MentionRefV1[] = [];
  for (const entry of value) {
    const result = MentionRefV1Schema.safeParse(entry);
    if (result.success) parsed.push(result.data);
  }
  parsed.sort((left, right) => (left.start - right.start) || (left.end - right.end));

  const sanitized: MentionRefV1[] = [];
  let boundary = 0;
  for (const mention of parsed) {
    if (sanitized.length >= MENTION_BOUNDS.maxPerMessage) break;
    if (mention.start < boundary) continue;
    sanitized.push(mention);
    boundary = mention.end;
  }
  return sanitized;
}

/**
 * The composed admission step: compares references against the submitted message text.
 * A reference whose range does not describe its own token in that text is rejected; its
 * siblings are admitted (INV-4). `String.prototype.slice` indexes UTF-16 code units, so
 * the offset contract holds for surrogate pairs by construction.
 */
export function admitMentionRefsV1ForText(
  text: string,
  mentions: readonly MentionRefV1[],
): MentionRefV1[] {
  const admitted: MentionRefV1[] = [];
  for (const mention of mentions) {
    if (mention.end > text.length) continue;
    if (text.slice(mention.start, mention.end) !== mention.token) continue;
    admitted.push(mention);
  }
  return admitted;
}
