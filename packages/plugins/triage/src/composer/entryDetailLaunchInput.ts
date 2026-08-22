import {
    ProtocolComposerRefV1Schema,
    defineProtocolLiteral,
    defineProtocolObject,
} from '@happier-dev/plugin-sdk/protocol';
import type { ProtocolComposerRefV1 } from '@happier-dev/plugin-sdk/protocol';
import {
    TriageEntryRefV1Schema,
    TriageSourceInstanceRefV1Schema,
} from '@happier-dev/triage-protocol/v1';
import type { TriageEntryRefV1, TriageSourceInstanceRefV1 } from '@happier-dev/triage-protocol/v1';

import { sameTriageSourceIdentity } from '../corpus/identity/components.js';

/**
 * The strict private launch input of the Triage app page
 * (`core/COMPOSER.md` §2.1).
 *
 * It is the whole boundary between "some surface asked to open a detail" and
 * "Triage selected this exact entry under this exact connection". The generic
 * qualified-destination navigation owner carries this value unchanged and never
 * inspects it, so nothing downstream is strict if this parser is not.
 *
 * The shape is deliberately CLOSED rather than additive. An additive policy
 * silently drops what it does not know, which turns "the opener sent a field
 * this build cannot honour" into "the opener sent nothing" — precisely the
 * failure mode that would let a Triage-local mirror of a platform type slip in
 * unnoticed.
 *
 * ## The Composer-origin address
 *
 * `core/COMPOSER.md` §2.1 and PEP `03d1` §17.8 give a Composer-origin launch
 * exactly one extra field, `originComposer`, and place it HERE — inside this
 * closed private launch input — rather than on the source detail surface
 * envelope. That envelope is `additive-open/drop`, which is right for a
 * forward-compatible presentation payload and wrong for an address: a
 * destination that resolves the value with an exact `get(originComposer)` would
 * be handed a silently emptied launch instead of a refusal. Closed fails loudly,
 * which is what an address needs.
 *
 * The declared value is the canonical composable projection
 * `ProtocolComposerRefV1Schema` from `@happier-dev/plugin-sdk/protocol` — the
 * one host parser, not a copy (`/ui`'s `ComposerRefV1Schema` is the same
 * canonical value published declaration-only for reading Host API payloads, and
 * stays uncomposable by design). A Triage-local mirror or adoption wrapper
 * remains forbidden.
 *
 * It is an address and nothing more: not attestation, not mutation authority,
 * not route state, and not a persisted origin. Contributor admission, scope
 * availability, and snapshot revision stay with the canonical Composer owner,
 * which is why a supplied `originComposer` still cannot excuse a mismatched
 * entry/connection pair below.
 */

export type TriageEntryDetailLaunchInputV1 = Readonly<{
    v: 1;
    kind: 'entryDetail';
    entryRef: TriageEntryRefV1;
    sourceInstance: TriageSourceInstanceRefV1;
    originComposer?: ProtocolComposerRefV1;
}>;

/**
 * Composed from the canonical published refs rather than restating their
 * grammar. Source/instance agreement is not expressible in a closed object
 * shape, so it lives in `parseTriageEntryDetailLaunchInput`, the only reader.
 */
export const TriageEntryDetailLaunchInputV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    kind: defineProtocolLiteral('entryDetail'),
    entryRef: TriageEntryRefV1Schema,
    sourceInstance: TriageSourceInstanceRefV1Schema,
    originComposer: ProtocolComposerRefV1Schema.optional(),
}, { policy: 'closed' });

export type TriageEntryDetailLaunchInputParseResultV1 =
    | Readonly<{ status: 'valid'; input: TriageEntryDetailLaunchInputV1 }>
    | Readonly<{ status: 'invalid'; reason: 'shape' | 'sourceMismatch' }>;

/**
 * Build the input from facts the caller already holds.
 *
 * It deliberately returns the unvalidated literal: `openEntryDetails` admits it
 * through the parser below before it reaches the navigation owner, so there is
 * exactly one gate rather than a builder that is trusted because it is a
 * builder.
 */
export function buildTriageEntryDetailLaunchInput(input: Readonly<{
    entryRef: TriageEntryRefV1;
    sourceInstance: TriageSourceInstanceRefV1;
    /** Present only when a mounted Composer opened this detail. */
    originComposer?: ProtocolComposerRefV1;
}>): TriageEntryDetailLaunchInputV1 {
    // An app-origin launch omits the key rather than carrying `undefined`: the
    // absent address and the unresolvable one are different facts downstream.
    return input.originComposer === undefined
        ? {
            v: 1,
            kind: 'entryDetail',
            entryRef: input.entryRef,
            sourceInstance: input.sourceInstance,
        }
        : {
            v: 1,
            kind: 'entryDetail',
            entryRef: input.entryRef,
            sourceInstance: input.sourceInstance,
            originComposer: input.originComposer,
        };
}

export function parseTriageEntryDetailLaunchInput(
    value: unknown,
): TriageEntryDetailLaunchInputParseResultV1 {
    const parsed = TriageEntryDetailLaunchInputV1Schema.safeParse(value);
    if (!parsed.success) return { status: 'invalid', reason: 'shape' };

    const candidate = parsed.data as TriageEntryDetailLaunchInputV1;
    const { entryRef, sourceInstance } = candidate;
    // A connection to another source could never have observed this entry, so
    // the pair is a refusal rather than a substitution — the same rule the
    // attachment value enforces, through the same predicate.
    if (!sameTriageSourceIdentity(sourceInstance.source, entryRef.source)) {
        return { status: 'invalid', reason: 'sourceMismatch' };
    }
    return { status: 'valid', input: candidate };
}
