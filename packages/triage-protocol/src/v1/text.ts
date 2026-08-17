import { MAX_TRIAGE_TEXT_UTF8_BYTES_V1 } from './bounds.js';

/**
 * One projected display value, plus whether producing it cost content.
 *
 * `truncated` is exactly what `projectionTruncated` reports: content was
 * shortened. Collapsing a control run is not truncation — the words on both
 * sides survive — so normalization alone never sets it.
 */
export type TriageBoundedTextV1 = Readonly<{ value: string; truncated: boolean }>;

/** C0 controls and `U+007F`: the code points no V1 string can represent. */
const CONTROL_RUN = /[\u0000-\u001f\u007f]+/gu;
const REPEATED_SPACE = / {2,}/gu;

const encoder = new TextEncoder();

function utf8ByteLength(value: string): number {
    return encoder.encode(value).byteLength;
}

/**
 * The one owner of the V1 single-line rule: collapse every control run to one
 * space and trim.
 *
 * `TRIAGE_SINGLE_LINE_STRING_PATTERN_V1` states the shape a V1 string must
 * already have; this states how provider text reaches it. Splitting those two
 * halves across packages is what let four sources project raw provider text —
 * a GitHub issue title may contain a newline and a Sentry exception message
 * routinely does — into a result the strict target rejects **atomically**,
 * so one bad row discards every other row on the same scan page and the user
 * sees an unexplained empty list (`CONTRACT.md` §2.1).
 *
 * Collapsing rather than stripping preserves the word boundary the control
 * character stood for, and it is what keeps the entity visible: a title with a
 * newline is normalized, never a reason to drop an identity-valid entry. It is
 * a byte contract too — a control character costs one UTF-8 byte against a
 * bound but six once JSON escapes it, so normalizing before measuring is what
 * keeps the derived worst-case page size honest.
 *
 * An empty result means no display text survived, which is a different answer
 * from a blank required field: the caller supplies its own identity-derived
 * fallback.
 */
export function normalizeTriageSingleLineV1(value: string): string {
    return value.replace(CONTROL_RUN, ' ').replace(REPEATED_SPACE, ' ').trim();
}

/**
 * Truncate to a UTF-8 byte budget on a whole code point, never mid-sequence and
 * never on a surrogate boundary.
 *
 * Cutting mid-sequence produces a replacement character in the UI and silently
 * changes the text the user is reading, so a shortened string stays valid text.
 * Callers projecting provider text want `projectTriageDisplayTextV1`; this is
 * for the ones that must reserve part of the budget for their own suffix.
 */
export function truncateTriageUtf8V1(value: string, maxUtf8Bytes: number): TriageBoundedTextV1 {
    if (maxUtf8Bytes <= 0) return { value: '', truncated: value.length > 0 };
    if (utf8ByteLength(value) <= maxUtf8Bytes) return { value, truncated: false };

    let used = 0;
    let kept = '';
    for (const point of value) {
        const size = utf8ByteLength(point);
        if (used + size > maxUtf8Bytes) break;
        used += size;
        kept += point;
    }
    return { value: kept, truncated: true };
}

/**
 * Project untrusted provider text into one bounded, single-line V1 display
 * string: the whole rule a source owes the contract, in one call.
 *
 * Normalization runs before bounding, because measuring an unnormalized string
 * charges a control character one byte for content that escapes to six. A
 * trailing space stranded by truncation is removed, which cannot reintroduce an
 * overflow.
 */
export function projectTriageDisplayTextV1(
    value: string,
    maxUtf8Bytes: number = MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
): TriageBoundedTextV1 {
    const bounded = truncateTriageUtf8V1(normalizeTriageSingleLineV1(value), maxUtf8Bytes);
    return { value: bounded.value.trimEnd(), truncated: bounded.truncated };
}
