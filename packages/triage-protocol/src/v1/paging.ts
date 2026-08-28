/**
 * The JSON envelope a source scan continuation travels in.
 *
 * `CONTRACT.md` §5.1 makes the token source-private: only its minting source
 * parses it, and the target copies it back without granting it authority. What is
 * NOT source-private is the envelope: it is one closed object and one JSON
 * codec shared by every source. Its byte ceiling is derived from the real
 * aggregate Action carrier so the complete maximum-lane continuation set fits
 * beside a full list window; it is not guessed from provider cursor examples.
 *
 * Sources had each re-spelled that envelope privately — three spellings of
 * "measure UTF-8" and one `JSON.parse` guard apiece. Owning it once keeps the
 * JSON-object rule symmetric without duplicating transport policy.
 *
 * The frontier *inside* the envelope stays with each source, because that is the
 * part that genuinely differs: a lane set, a keyset cursor, a per-environment
 * offset map, and each source's own validation of what it may resume from.
 *
 * Every V1 source that mints a scan continuation reaches this owner: GitHub,
 * GitLab, Bitbucket, Azure DevOps, PostHog and Sentry. There is no carve-out,
 * and a private re-spelling is not one either — Sentry's outlived this owner and
 * threw where the codec returns `null`, so its caller settled a
 * cursor-*syntax* verdict for a page that was still valid JSON. If a
 * source ever does need its own envelope, name it here with the reason, the way
 * `httpHeaders.ts` names its one dependency-boundary carve-out; a roster that
 * silently omits a straggler is what let that one survive.
 */

import { MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1 } from './bounds.js';

const encoder = new TextEncoder();

/**
 * Projects a source's own frontier record into its opaque token.
 *
 * `null` means JSON cannot represent the frontier inside the schema-derived
 * aggregate-envelope share. The caller settles the walk as incomplete rather
 * than truncating an opaque cursor or minting a continuation it cannot return.
 */
export function encodeTriagePagingTokenV1(frontier: unknown): string | null {
    const token = JSON.stringify(frontier);
    if (token === undefined) return null;
    return encoder.encode(token).byteLength <= MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1
        ? token
        : null;
}

/**
 * Reads a token this same source minted back into its record, or `null` when it
 * is not a JSON object. Every field check stays with the source, which is the
 * half that carries the resume authority.
 */
export function decodeTriagePagingTokenV1(token: string): Readonly<Record<string, unknown>> | null {
    if (encoder.encode(token).byteLength > MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(token);
    } catch {
        return null;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Readonly<Record<string, unknown>>;
}
