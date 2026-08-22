/**
 * The bounded JSON envelope a source scan continuation travels in.
 *
 * `CONTRACT.md` §5.1 makes the token source-private: only its minting source
 * parses it, and the target copies it back without granting it authority. What is
 * NOT source-private is the envelope — the token is a protocol member with a
 * protocol bound (`MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1`), enforced inside a
 * closed object, so a token one byte over rejects the **whole** scan result and
 * the user sees no list at all.
 *
 * Sources had each re-spelled that envelope privately — three spellings of
 * "measure UTF-8", a bound enforced on the way out but not on the way back in,
 * and one `JSON.parse` guard apiece. Owning it once makes the two halves
 * symmetric: bytes no source will mint are bytes no source will re-admit.
 *
 * The frontier *inside* the envelope stays with each source, because that is the
 * part that genuinely differs: a lane set, a keyset cursor, a per-environment
 * offset map, and each source's own validation of what it may resume from.
 *
 * Every V1 source that mints a scan continuation reaches this owner: GitHub,
 * GitLab, Bitbucket, Azure DevOps, PostHog and Sentry. There is no carve-out,
 * and a private re-spelling is not one either — Sentry's outlived this owner and
 * threw where the codec returns `null`, so its caller settled a
 * cursor-*syntax* verdict for a page that had merely outgrown the bound. If a
 * source ever does need its own envelope, name it here with the reason, the way
 * `httpHeaders.ts` names its one dependency-boundary carve-out; a roster that
 * silently omits a straggler is what let that one survive.
 */

import { MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1 } from './bounds.js';

const encoder = new TextEncoder();

/**
 * Projects a source's own frontier record into its bounded token.
 *
 * `null` means the walk cannot be continued within the bound. The caller then
 * settles a truthful resumable-`partial` coverage claim rather than presenting a
 * truncated walk as a finished one, and never emits an over-bound token that
 * would discard the page it belongs to.
 */
export function encodeTriagePagingTokenV1(frontier: unknown): string | null {
    const token = JSON.stringify(frontier);
    if (token === undefined) return null;
    return encoder.encode(token).byteLength > MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1 ? null : token;
}

/**
 * Reads a token this same source minted back into its record, or `null` when the
 * bytes are not a bounded JSON object.
 *
 * The bound is checked before parsing: a token wider than the contract admits was
 * not minted by a conforming source at this version, and parsing it first would
 * spend the work anyway. Every field check stays with the source, which is the
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
