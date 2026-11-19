import { defineProtocolLiteral, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';

/**
 * @internal The one constructor for bounded V1 row-display and identifier strings.
 *
 * Projected strings — display text, identifier, location, and
 * source-private token alike — is bounded, non-empty, and single-line. Routing
 * one constructor through `TRIAGE_SINGLE_LINE_STRING_PATTERN_V1` keeps that a
 * property of the protocol rather than of whichever module happened to declare
 * a field. Task write body documents use their own multiline input schema.
 * For bounded projections it is what makes the worst-case JSON expansion in
 * `maximumEncodedResult.test.ts` a factor of two instead of six
 * (`CONTRACT.md` §2.1).
 *
 * This declares the shape a V1 string must already have. `text.ts` owns the
 * other half — how untrusted provider text reaches that shape — and a source
 * consumes it rather than restating the rule.
 */
export { defineTriageSingleLineStringV1 } from '@happier-dev/plugin-sdk/protocol';

/**
 * @internal The one constructor for a V1 string that carries a source-owned
 * composite key.
 *
 * It differs from every other V1 string in exactly one admitted code point,
 * `U+001F`, because a first-party source really composes two of its keys with
 * it: `collisionScope` (`CONTRACT.md` §6) and `localInstanceKey`
 * (`sources/SENTRY.md` §2.4). Keeping it a separate constructor rather than a
 * relaxed shared one is what confines the sixfold worst-case escaping to the
 * two small bounded fields the derivation budgets for, and routing both through
 * one constructor is what keeps a later composite field from acquiring a
 * similar-but-different grammar.
 */
export { defineTriageCompositeIdentifierStringV1 } from '@happier-dev/plugin-sdk/protocol';

/** Projects the entire owner vocabulary using contribution-compatible literals. */
export function defineTriageStringUnionV1<const T extends string>(
    [first, second, ...rest]: readonly [T, T, ...T[]],
) {
    return defineProtocolUnion([
        defineProtocolLiteral(first),
        defineProtocolLiteral(second),
        ...rest.map(value => defineProtocolLiteral(value)),
    ]);
}
