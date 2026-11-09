import {
    defineProtocolLiteral,
    defineProtocolJsonValue,
    defineProtocolArray,
    defineProtocolNumber,
    defineProtocolObject,
    defineProtocolString,
    defineProtocolUnion,
    type ProtocolComposableSchema,
} from '@happier-dev/plugin-sdk/protocol';
import { ScmComparisonSourceSchema } from '@happier-dev/plugin-sdk/scm';
import { SessionInputForgeEvidenceV1Schema } from '@happier-dev/plugin-sdk/sessions';

import { TriageSourceFailureV1Schema } from './diagnostics.js';
import { TriageTaskFieldChoicesV1Schema, TriageTaskFieldsV1Schema } from './tasks.js';
import {
    TriageEntryLocatorV1Schema,
    TriageIdentifierV1ProtocolSchema,
    TriageSourceEntryLocalRefV1Schema,
} from './identity.js';
import {
    TriageConfiguredSourceConnectedAccountInstanceV1Schema,
    TriageConfiguredSourceCredentialInstanceV1Schema,
    TriageConfiguredSourceInstanceV1Schema,
} from './instances.js';
import {
    TriageScanContinuationV1Schema,
    TriageScanObservationsV1ProtocolSchema,
    TriageSourceAbsentObservationV1ProtocolSchema,
    TriageSourceMergedObservationV1ProtocolSchema,
    TriageSourcePresentObservationV1Fields,
    TriageSourceUnresolvedObservationV1ProtocolSchema,
    TriageSourceScanEvidenceV1Schema,
} from './observations.js';

/**
 * One scan page request.
 *
 * The initial arm carries the caller's page `limit`; the continuation arm
 * carries only the source's bounded opaque continuation, which already binds
 * that limit and the provider-native page geometry. Omitting `limit` from the
 * continuation arm is deliberate: it makes a mid-scan limit change
 * unrepresentable (`CONTRACT.md` §5.1).
 */
function defineTriageScanInputV1<TInput, TOutput>(instance: ProtocolComposableSchema<TInput, TOutput>) {
    // A completion window selects current task membership, never a change watermark.
    const completed = defineProtocolObject({
        kindIds: defineProtocolArray(TriageIdentifierV1ProtocolSchema, { minItems: 1 }),
        // ECMAScript Date's representable positive range; sources format this instant for native queries.
        sinceMs: defineProtocolNumber({ integer: true, minimum: 0, maximum: 8640000000000000 }),
    }, { policy: 'closed' }).optional();
    return defineProtocolUnion([
        defineProtocolObject({
            v: defineProtocolLiteral(1),
            instance,
            completed,
            // Optional source-side text narrowing. The aggregate still applies its
            // matcher and retains the source's completeness evidence.
            query: defineProtocolString().optional(),
            page: defineProtocolObject({
                kind: defineProtocolLiteral('initial'),
                limit: defineProtocolNumber({
                    integer: true,
                    minimum: 1,
                }),
            }, { policy: 'closed' }),
        }, { policy: 'closed' }),
        defineProtocolObject({
            v: defineProtocolLiteral(1),
            instance,
            completed,
            query: defineProtocolString().optional(),
            page: defineProtocolObject({
                kind: defineProtocolLiteral('continuation'),
                continuation: TriageScanContinuationV1Schema,
            }, { policy: 'closed' }),
        }, { policy: 'closed' }),
    ]);
}
export const TriageScanInputV1Schema = defineTriageScanInputV1(TriageConfiguredSourceInstanceV1Schema);
export const TriageScanConnectedAccountInputV1Schema = defineTriageScanInputV1(
    TriageConfiguredSourceConnectedAccountInstanceV1Schema,
);
export const TriageScanCredentialInputV1Schema = defineTriageScanInputV1(TriageConfiguredSourceCredentialInstanceV1Schema);
export type TriageScanInputV1 = ReturnType<typeof TriageScanInputV1Schema.parse>;

/**
 * One settled scan page.
 *
 * `page` continues the same in-memory invocation; `complete` ends it. Neither
 * successful arm can express a retry deadline — that fact belongs only to a
 * `TriageSourceFailureV1`, so a provider "retry later" response ends the walk
 * rather than delaying a successful page (`CONTRACT.md` §5.1, §5.2).
 */
export const TriageScanResultV1Schema = defineProtocolUnion([
    defineProtocolObject({
        kind: defineProtocolLiteral('page'),
        observations: TriageScanObservationsV1ProtocolSchema,
        evidence: TriageSourceScanEvidenceV1Schema,
        continuation: TriageScanContinuationV1Schema,
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('complete'),
        observations: TriageScanObservationsV1ProtocolSchema,
        evidence: TriageSourceScanEvidenceV1Schema,
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('failed'),
        failure: TriageSourceFailureV1Schema,
    }, { policy: 'closed' }),
]);
export type TriageScanResultV1 = ReturnType<typeof TriageScanResultV1Schema.parse>;

/**
 * One authoritative read of one local ref through one exact configured
 * instance. The result's `localRef` must equal this input exactly; a different
 * ref is invalid rather than a redirect (`CONTRACT.md` §5, §6).
 *
 * `lastKnownLocator` is the newest locator the target observed for this exact
 * entry, copied back unchanged. An account-wide scan discovers entries across
 * many provider scopes, so the configured instance alone cannot name the one
 * this entry lives in; without the locator a source would have to either
 * re-derive a route from identity — which the locator-only rule forbids — or
 * answer `unresolved`. The locator carries no authority: the source is still
 * the only parser of its own opaque `routingToken`, still reauthorizes the
 * exact account, and still validates the provider response against the
 * requested ref before calling anything `present`. It is absent on a first read
 * and on any entry the target has never observed (`CONTRACT.md` §5, §6).
 */
export const triageGetInputFieldsV1 = {
    localRef: TriageSourceEntryLocalRefV1Schema,
    lastKnownLocator: TriageEntryLocatorV1Schema.optional(),
    /** The detail about to offer task editing; a source with a directory answers with `taskFieldChoices`. */
    includeTaskFieldChoices: defineProtocolLiteral(true).optional(),
} as const;
export const TriageGetInputV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    instance: TriageConfiguredSourceInstanceV1Schema,
    ...triageGetInputFieldsV1,
}, { policy: 'closed' });
export const TriageGetConnectedAccountInputV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    instance: TriageConfiguredSourceConnectedAccountInstanceV1Schema,
    ...triageGetInputFieldsV1,
}, { policy: 'closed' });
export const TriageGetCredentialInputV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    instance: TriageConfiguredSourceCredentialInstanceV1Schema,
    ...triageGetInputFieldsV1,
}, { policy: 'closed' });
export type TriageGetInputV1 = ReturnType<typeof TriageGetInputV1Schema.parse>;

/**
 * `get` is the only operation that may conclude absence, so its result is the
 * complete four-arm observation union. A present read may also return a
 * transient comparison source for this exact invocation. It is not part of
 * the durable observation: source configuration and executable routing remain
 * current read inputs, rather than duplicated in the corpus snapshot.
 */
export const TriageGetResultV1Schema = defineProtocolUnion([
    defineProtocolObject({
        ...TriageSourcePresentObservationV1Fields,
        comparisonSource: ScmComparisonSourceSchema.optional(),
        /** Complete current values for declared task edits. Omitted members are
         * unavailable, never empty or truncated. Exact-read-only, not snapshot,
         * scan, retained projection, or mutation authority. */
        taskFields: TriageTaskFieldsV1Schema.optional(),
        /** What the name-valued task fields can be set to, when the read asked. Exact-read-only, never retained. */
        taskFieldChoices: TriageTaskFieldChoicesV1Schema.optional(),
        /** Source-owned presentation from this exact read, never persisted or used as authority. */
        detailData: defineProtocolJsonValue().optional(),
        /** Fresh source detail for this exact dispatch. Descriptive data only;
         * the containing Action/input owns the byte budget. Never retained in
         * observations or snapshots, and never interpreted as authority. */
        dispatchEvidence: SessionInputForgeEvidenceV1Schema.optional(),
    }, { policy: 'closed' }),
    TriageSourceAbsentObservationV1ProtocolSchema,
    TriageSourceMergedObservationV1ProtocolSchema,
    TriageSourceUnresolvedObservationV1ProtocolSchema,
]);
export type TriageGetResultV1 = ReturnType<typeof TriageGetResultV1Schema.parse>;
