import { defineProtocolLiteral, defineProtocolObject } from '@happier-dev/plugin-sdk/protocol';
import {
    TriageEntryRefV1Schema,
    TriageSourceInstanceRefV1Schema,
} from '@happier-dev/triage-protocol/v1';
import type { TriageEntryRefV1, TriageSourceInstanceRefV1 } from '@happier-dev/triage-protocol/v1';

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
 * ## The one deliberately absent field
 *
 * `core/COMPOSER.md` §2.1 specifies an optional `originComposer: ComposerRefV1`
 * for a Composer-origin launch. It is NOT declared here, and its presence is a
 * refusal, because the public `ComposerRefV1Schema` is a `PluginUiSchema` and
 * not a validator-neutral `ProtocolComposableSchema`: it cannot be embedded in
 * a `defineProtocolObject` at all. The canonical producer is tracked as
 * `COMPOSER-COMPOSABLE-REF` at the Composer/Main SDK owner. Declaring a
 * Triage-local mirror or an adoption wrapper is explicitly forbidden, so the
 * dependent slice — the Tier-B reference path that would consume the origin —
 * stays blocked while everything else here ships.
 */

export type TriageEntryDetailLaunchInputV1 = Readonly<{
    v: 1;
    kind: 'entryDetail';
    entryRef: TriageEntryRefV1;
    sourceInstance: TriageSourceInstanceRefV1;
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
}>): TriageEntryDetailLaunchInputV1 {
    return {
        v: 1,
        kind: 'entryDetail',
        entryRef: input.entryRef,
        sourceInstance: input.sourceInstance,
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
    // attachment value enforces, for the same reason.
    if (
        sourceInstance.source.pluginId !== entryRef.source.pluginId
        || sourceInstance.source.localId !== entryRef.source.localId
    ) {
        return { status: 'invalid', reason: 'sourceMismatch' };
    }
    return { status: 'valid', input: candidate };
}
