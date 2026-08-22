/**
 * The pure text projections every Triage source detail body needs, in one place.
 *
 * These are functions of this package's own closed vocabularies —
 * `TriageRowFactV1`, `TriageRowFactTimestampFormatV1`,
 * `TriageRowFactNumberFormatV1`, `TriageSourceFailureV1` — so a per-source copy
 * is a place where one declared format quietly starts meaning two things. It
 * already did: six sources each re-spelled the same relative-time table and the
 * same approximate-count rule, and the drift surface was one list showing two
 * conventions for one declared `compact` number.
 *
 * They are here rather than in a UI package because they are contract
 * projections, not components: no React, no theme, no host service. A
 * third-party source author receives the same rendering with the contract
 * (`REQ-09`), which is the whole point of publishing them.
 *
 * What stays with each source is what genuinely differs: its own fact-id label
 * vocabulary, its own sentences for a failed or short walk, and its own panel
 * composition.
 */

import type {
    TriageRowFactImportanceV1,
    TriageRowFactNumberFormatV1,
    TriageRowFactStatusToneV1,
    TriageRowFactTimestampFormatV1,
} from './bounds.js';
import type { TriageSourceFailureV1 } from './diagnostics.js';
import type { TriageRowFactV1 } from './observations.js';

/**
 * The largest unit whose threshold a delta reaches decides the phrase, so the
 * table is descending and `second` is the floor below it.
 */
const RELATIVE_UNITS: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = Object.freeze([
    ['year', 365 * 24 * 60 * 60 * 1000],
    ['month', 30 * 24 * 60 * 60 * 1000],
    ['day', 24 * 60 * 60 * 1000],
    ['hour', 60 * 60 * 1000],
    ['minute', 60 * 1000],
] as const);

/**
 * One provider-native detail row, projected from one `TriageRowFactV1`.
 *
 * `pending` is the projection of a `detailOnly` fact: the list deliberately
 * defers that fact to the detail plane, so rendering it as an empty value would
 * claim the provider has nothing to say about it (`CONTRACT.md` §4).
 */
export type TriageDetailFieldV1 =
    | Readonly<{
        kind: 'text';
        id: string;
        label: string;
        importance: TriageRowFactImportanceV1;
        value: string;
    }>
    | Readonly<{
        kind: 'timestamp';
        id: string;
        label: string;
        importance: TriageRowFactImportanceV1;
        atMs: number;
        format: TriageRowFactTimestampFormatV1;
    }>
    | Readonly<{
        kind: 'number';
        id: string;
        label: string;
        importance: TriageRowFactImportanceV1;
        value: number;
        format: TriageRowFactNumberFormatV1;
        approximate: boolean;
    }>
    | Readonly<{
        kind: 'status';
        id: string;
        label: string;
        importance: TriageRowFactImportanceV1;
        value: string;
        tone: TriageRowFactStatusToneV1;
    }>
    /** A fact the list deliberately defers and this build has not resolved yet. */
    | Readonly<{
        kind: 'pending';
        id: string;
        label: string;
        importance: TriageRowFactImportanceV1;
    }>;

/**
 * `relative` is relative to the reader's present, which is what a triage reader
 * means by "updated 4 minutes ago". `nowMs` is passed in rather than read here so
 * the value is a render input and not a hidden clock read.
 */
export function formatTriageTimestampV1(
    locale: string,
    atMs: number,
    format: TriageRowFactTimestampFormatV1,
    nowMs: number,
): string {
    if (format === 'absolute') {
        return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' })
            .format(new Date(atMs));
    }
    const deltaMs = atMs - nowMs;
    const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    for (const [unit, unitMs] of RELATIVE_UNITS) {
        if (Math.abs(deltaMs) >= unitMs) return relative.format(Math.round(deltaMs / unitMs), unit);
    }
    return relative.format(Math.round(deltaMs / 1000), 'second');
}

/**
 * The declared number format, applied. `compact` is a contract vocabulary, so
 * honouring it in one place is what keeps two sources from presenting the same
 * declared format differently in one list.
 */
export function formatTriageCountV1(
    locale: string,
    value: number,
    format: TriageRowFactNumberFormatV1,
): string {
    return new Intl.NumberFormat(
        locale,
        format === 'compact' ? { notation: 'compact', maximumFractionDigits: 1 } : {},
    ).format(value);
}

/**
 * The value-carrying half of a detail field: exactly what the text projection
 * reads.
 *
 * It is deliberately narrower than `TriageDetailFieldV1`. A source that renders
 * its own field row without an importance or a label — one of the six does — has
 * the same *value* vocabulary, and requiring the presentation half it does not
 * use would push it back into a private copy of this projection.
 */
export type TriageDetailFieldValueTextV1 =
    | Readonly<{ kind: 'text'; value: string }>
    | Readonly<{ kind: 'status'; value: string }>
    | Readonly<{
        kind: 'timestamp';
        atMs: number;
        format: TriageRowFactTimestampFormatV1;
    }>
    | Readonly<{
        kind: 'number';
        value: number;
        format: TriageRowFactNumberFormatV1;
        approximate: boolean;
    }>
    | Readonly<{ kind: 'pending' }>;

/**
 * The reader-facing text of one projected field, or `null` when the field has no
 * value to show.
 */
export function projectTriageDetailFieldTextV1(
    field: TriageDetailFieldValueTextV1,
    locale: string,
    nowMs: number,
): string | null {
    switch (field.kind) {
        case 'text':
        case 'status':
            return field.value;
        case 'number': {
            const formatted = formatTriageCountV1(locale, field.value, field.format);
            // A count the source could not promise as exact is never presented as a total.
            return field.approximate ? `~${formatted}` : formatted;
        }
        case 'timestamp':
            return formatTriageTimestampV1(locale, field.atMs, field.format, nowMs);
        case 'pending':
            return null;
        default:
            return null;
    }
}

/**
 * Projects one row fact into its detail field.
 *
 * `labels` is the source's own fact-id vocabulary, which genuinely differs per
 * source; the fact's own `label` and then its id are the fallbacks. A value arm
 * this build does not know is presentation-only: the row is skipped and the
 * entry kept (`INV-20`).
 *
 * `projectTriageDetailFieldsV1` below is its only caller anywhere, and is what
 * `/v1` publishes: a source renders a snapshot's facts in their declared order,
 * so the plural is the contract and this is one internal step of it.
 */
function projectTriageDetailFieldV1(
    fact: TriageRowFactV1,
    labels?: Readonly<Record<string, string | undefined>>,
): TriageDetailFieldV1 | null {
    const label = labels?.[fact.id] ?? fact.label ?? fact.id;
    const importance = fact.importance;
    switch (fact.value.kind) {
        // An actor is a person or a team; the detail body renders the display name the
        // contract already carries rather than inventing an avatar identity.
        case 'text':
        case 'actor':
            return { kind: 'text', id: fact.id, label, importance, value: fact.value.value };
        case 'timestamp':
            return {
                kind: 'timestamp',
                id: fact.id,
                label,
                importance,
                atMs: fact.value.atMs,
                format: fact.value.format,
            };
        case 'number':
            return {
                kind: 'number',
                id: fact.id,
                label,
                importance,
                value: fact.value.value,
                format: fact.value.format,
                approximate: fact.value.approximate === true,
            };
        case 'status':
            return {
                kind: 'status',
                id: fact.id,
                label,
                importance,
                value: fact.value.value,
                tone: fact.value.tone,
            };
        case 'detailOnly':
            return { kind: 'pending', id: fact.id, label, importance };
        default:
            return null;
    }
}

/** Projects a snapshot's facts in their declared order, skipping the arms this build cannot render. */
export function projectTriageDetailFieldsV1(
    facts: readonly TriageRowFactV1[],
    labels?: Readonly<Record<string, string | undefined>>,
): readonly TriageDetailFieldV1[] {
    return facts
        .map((fact) => projectTriageDetailFieldV1(fact, labels))
        .filter((field): field is TriageDetailFieldV1 => field !== null);
}

/**
 * The one sentence every failed read owes its reader, without echoing a provider
 * body: the caller's own localized sentence, with the classified code beside it.
 */
export function describeTriageSourceFailureV1(
    failure: TriageSourceFailureV1 | null,
    fallback: string,
): string {
    return failure === null ? fallback : `${fallback} (${failure.code})`;
}
