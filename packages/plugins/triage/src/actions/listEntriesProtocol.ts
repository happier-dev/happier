import {
    ProtocolCollectionOpaqueCursorV1Schema,
    defineProtocolArray,
    defineProtocolLiteral,
    defineProtocolNumber,
    defineProtocolObject,
    defineProtocolUnion,
    defineProtocolUtf8String,
} from '@happier-dev/plugin-sdk/protocol';
import { PluginContributionIdentityV1Schema } from '@happier-dev/plugin-sdk/manifest';
import {
    createTriageListResultSchemasV1,
    MAX_TRIAGE_COLLISION_SCOPE_UTF8_BYTES_V1,
    MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
    MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
    MAX_TRIAGE_LIST_SOURCE_BATCH_V1,
    TRIAGE_COMPOSITE_IDENTIFIER_PATTERN_V1,
    TRIAGE_SINGLE_LINE_STRING_PATTERN_V1,
    TriageEntryLocatorV1Schema,
    TriageEntryRepositoryRefV1Schema,
    TriageEntryRefV1Schema,
    TriageSourceEntrySnapshotV1Schema,
    TriageSourceFailureV1Schema,
    TriageListInvocationErrorV1Schema,
    TriageSourceInstanceIdV1Schema,
    TriageScanContinuationV1Schema,
    TriageSourceScanEvidenceV1Schema,
    TriageSourceViewerFactsV1Schema,
    TriageSourceScopeUnitDescriptorV1Schema,
    TriageListScopeUnitsResultV1Schema,
    TriageSourceScopeUnitIdV1Schema,
    TriageListSortV1Schema,
} from '@happier-dev/triage-protocol/v1';

import {
    MAX_TRIAGE_LIST_WINDOW_ROWS_V1,
    TRIAGE_LIST_ORDERS_V1,
    TRIAGE_STATE_FILTER_VALUES_V1,
    TRIAGE_ATTENTION_FILTER_VALUES_V1,
} from '../projection/listWindow.js';
import { CORPUS_SMART_PRECEDENCE_TUPLES_V1 } from '../corpus/query/smartPolicy.js';
import { InternalTaskListProjectionSchema } from '../internalTasks/listProjection.js';

/**
 * The most configured sources one `entries/list-v1` invocation carries.
 *
 * This is a transport batch, not a configured-source membership limit. The
 * bounded presentation/control allocation for this shape is measured with
 * explicit finite provider-collection witnesses by
 * `maximumEncodedActionValue.test.ts` against the canonical public Action
 * response envelope. A mounted store pages the Collection through this Action and schedules
 * successive selected batches through its one refresh coordinator.
 */
export { MAX_TRIAGE_LIST_SOURCE_BATCH_V1 } from '@happier-dev/triage-protocol/v1';

/**
 * The strict input and result contract of the one aggregate PRs & Issues list
 * Action.
 *
 * Business inputs stay here; pure result construction is shared with the
 * source protocol's envelope allocation so its schema cannot drift. Originally
 * this entire Action was declared here rather than in `@happier-dev/triage-protocol`.
 * The published package exists for the *cross-plugin* seams — the source role
 * contract and the source-administration Action a source's own Settings page
 * invokes. This Action has exactly one caller family, the aggregate's own
 * mounted surfaces, so publishing its shape as a source-facing protocol would
 * invite a second aggregation client the contract never intended.
 *
 * Every provider-derived member is composed from the published V1 schemas, so a
 * value that would be rejected on the source wire cannot be re-minted here.
 *
 * The three strings this Action declares itself are bounded the way the source
 * wire bounds them: in UTF-8 bytes, which is what every published V1 maximum
 * counts and what the derived worst-case encoded result is measured in. A
 * length bound counts code points instead, so it would admit a value three or
 * four times over the byte maximum a source is refused for sending.
 */

const triageIdentifier = defineProtocolUtf8String({
    maxUtf8Bytes: MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
    minLength: 1,
    pattern: TRIAGE_SINGLE_LINE_STRING_PATTERN_V1,
});
export const TriageListKindIdV1Schema = triageIdentifier;

export { TriageListInvocationErrorV1Schema } from '@happier-dev/triage-protocol/v1';
export type { TriageListInvocationErrorV1 } from '@happier-dev/triage-protocol/v1';

const triageCollisionScope = defineProtocolUtf8String({
    maxUtf8Bytes: MAX_TRIAGE_COLLISION_SCOPE_UTF8_BYTES_V1,
    minLength: 1,
    pattern: TRIAGE_COMPOSITE_IDENTIFIER_PATTERN_V1,
});
export const TriageListCollisionScopeV1Schema = triageCollisionScope;

const triageText = defineProtocolUtf8String({
    maxUtf8Bytes: MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
    minLength: 1,
    pattern: TRIAGE_SINGLE_LINE_STRING_PATTERN_V1,
});

/** The one settled-query shape shared by live and saved list lenses. */
export const TriageListSettledQueryV1Schema = defineProtocolUnion([
    defineProtocolLiteral(''),
    triageText,
]);

export const TriageListOrderV1Schema = defineProtocolUnion([
    defineProtocolLiteral(TRIAGE_LIST_ORDERS_V1[0]),
    defineProtocolLiteral(TRIAGE_LIST_ORDERS_V1[1]),
    ...TRIAGE_LIST_ORDERS_V1.slice(2).map(value => defineProtocolLiteral(value)),
]);

/**
 * One filter facet on the wire.
 *
 * It has no independent member-count ceiling. The saved-view form remains
 * bounded by its Account KV value boundary. Adding another count here
 * would make a valid lens behave differently depending on whether it was live,
 * routed, or saved.
 */
const facetArray = <TSchema extends Parameters<typeof defineProtocolArray>[0]>(schema: TSchema) => (
    defineProtocolArray(schema)
);

export const TriageListSourceFilterValueV1Schema = defineProtocolObject({
    source: PluginContributionIdentityV1Schema,
    sourceInstanceId: TriageSourceInstanceIdV1Schema.optional(),
}, { policy: 'closed' });
export const TriageListScopeFilterValueV1Schema = defineProtocolUnion([
    defineProtocolObject({
        source: PluginContributionIdentityV1Schema,
        sourceInstanceId: TriageSourceInstanceIdV1Schema.optional(),
        collisionScope: triageCollisionScope,
    }, { policy: 'closed' }),
    defineProtocolObject({
        source: PluginContributionIdentityV1Schema,
        sourceInstanceId: TriageSourceInstanceIdV1Schema.optional(),
        unitId: TriageSourceScopeUnitIdV1Schema,
        collisionScope: triageCollisionScope.optional(),
    }, { policy: 'closed' }),
    defineProtocolObject({
        source: PluginContributionIdentityV1Schema,
        sourceInstanceId: TriageSourceInstanceIdV1Schema.optional(),
    }, { policy: 'closed' }),
]);

/**
 * The one source-neutral filter vocabulary on the wire.
 *
 * Exported so the saved-view Action persists the exact same shape the list
 * Action queries with: a second spelling of a facet is how a saved lens and a
 * live lens start to disagree.
 */
const listFilterFields = {
    sources: facetArray(TriageListSourceFilterValueV1Schema),
    types: facetArray(defineProtocolObject({
        source: PluginContributionIdentityV1Schema,
        kindId: triageIdentifier,
    }, { policy: 'closed' })),
    scopes: facetArray(TriageListScopeFilterValueV1Schema),
    states: facetArray(defineProtocolUnion([
        defineProtocolLiteral(TRIAGE_STATE_FILTER_VALUES_V1[0]),
        defineProtocolLiteral(TRIAGE_STATE_FILTER_VALUES_V1[1]),
        ...TRIAGE_STATE_FILTER_VALUES_V1.slice(2).map(value => defineProtocolLiteral(value)),
    ])),
    attention: facetArray(defineProtocolUnion([
        defineProtocolLiteral(TRIAGE_ATTENTION_FILTER_VALUES_V1[0]),
        defineProtocolLiteral(TRIAGE_ATTENTION_FILTER_VALUES_V1[1]),
        ...TRIAGE_ATTENTION_FILTER_VALUES_V1.slice(2).map(value => defineProtocolLiteral(value)),
    ])),
} as const;
export const TriageListFilterSelectionV1Schema = defineProtocolObject(listFilterFields, { policy: 'closed' });
/** The mounted audience joins Session relationships after the shared source window.
 * It is saved/routed and Action-addressable, but never sent as an ignored scan filter. */
export const TriageSurfaceFilterSelectionV1Schema = defineProtocolObject({
    ...listFilterFields,
    tasks: defineProtocolUnion([
        defineProtocolLiteral('mine'), defineProtocolLiteral('agents'), defineProtocolLiteral('everyone'),
    ]).optional(),
}, { policy: 'closed' });

/**
 * The bounded Smart precedence ladder on the wire.
 *
 * The wire bounds the shape to exactly two of the two named predicates; the one
 * canonical policy owner closes the vocabulary, so a repeated predicate is
 * rejected there rather than silently ranked. There is no weight, decay or
 * dynamically named signal to encode.
 */
export const TriageSmartPolicyV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    precedence: defineProtocolArray(defineProtocolUnion([
        defineProtocolLiteral(CORPUS_SMART_PRECEDENCE_TUPLES_V1[0][0]),
        defineProtocolLiteral(CORPUS_SMART_PRECEDENCE_TUPLES_V1[0][1]),
    ]), { minItems: 2, maxItems: 2 }),
}, { policy: 'closed' });

/**
 * The configured-source selection.
 *
 * Catalog enumeration uses `allConfigured` with a zero row limit. Selected
 * refreshes carry the existing opaque Collection address discovered there;
 * a stable private source id alone cannot address its tuple-keyed row.
 */
const TriageListSourceSelectionV1Schema = defineProtocolUnion([
    defineProtocolObject({
        kind: defineProtocolLiteral('allConfigured'),
        /** Opaque Collection continuation for the next configured-source batch. */
        cursor: ProtocolCollectionOpaqueCursorV1Schema.optional(),
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('selected'),
        sourceInstances: defineProtocolArray(defineProtocolObject({
            sourceInstanceId: TriageSourceInstanceIdV1Schema,
            configurationRowId: triageIdentifier,
        }, { policy: 'closed' })),
    }, { policy: 'closed' }),
]);

/**
 * One lane's frontier, named by the lane it belongs to.
 *
 * The pairing is the whole point: a bare continuation cannot say whose walk it
 * continues, which is why the predecessor could only carry one and only for a
 * request that named one connection. Naming the lane is what lets a mixed
 * multi-source window page through the same rotation that loaded it.
 *
 * A token is opaque here and stays opaque: nothing in this target decodes it,
 * orders by it, or derives anything from it.
 */
const { TriageLaneContinuationV1Schema, TriageProjectedObservationV1Schema, TriageListEntriesResultV1Schema } = createTriageListResultSchemasV1(
    MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
    {
        TriageEntryLocatorV1Schema, TriageEntryRepositoryRefV1Schema,
        TriageSourceEntrySnapshotV1Schema, TriageSourceFailureV1Schema,
        TriageListInvocationErrorV1Schema, TriageScanContinuationV1Schema,
        TriageSourceScanEvidenceV1Schema, TriageSourceViewerFactsV1Schema,
    },
    defineProtocolObject({
        unit: TriageSourceScopeUnitDescriptorV1Schema,
        projection: TriageListScopeUnitsResultV1Schema,
    }, { policy: 'closed' }),
    InternalTaskListProjectionSchema,
);
export { TriageProjectedObservationV1Schema, TriageListEntriesResultV1Schema };

/**
 * The explicit page-size contract, independent of how many lane continuations
 * accompany the result. `bounds.ts` derives the bounded presentation/control
 * allocation against the host envelope including every lane continuation;
 * provider-sized collections still use that envelope as their only governor.
 * No second lane-dependent row quota is imposed beneath the explicit page size.
 */
export function triageListRowBudgetV1(_laneCount: number): number {
    return MAX_TRIAGE_LIST_WINDOW_ROWS_V1;
}

export const TriageListEntriesInputV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    /** Only the task list Action consumes this lens; PRs & Issues stays open-only. */
    tasks: defineProtocolObject({
        completedSinceMs: defineProtocolNumber({ integer: true, minimum: 0, maximum: 8640000000000000 }),
    }, { policy: 'closed' }).optional(),
    sources: TriageListSourceSelectionV1Schema,
    limit: defineProtocolNumber({
        integer: true,
        minimum: 0,
        maximum: MAX_TRIAGE_LIST_WINDOW_ROWS_V1,
    }),
    order: TriageListOrderV1Schema,
    /** A source-owned field order. Sources apply it before paginating. */
    sort: TriageListSortV1Schema.optional(),
    /**
     * The bounded Smart precedence ladder, as the caller's saved view or
     * unsaved default retains it. Omitted means the retained default; the two
     * closed tuples are the only representable values, so a weight or a
     * dynamically named signal cannot reach the ranker over this wire.
     */
    smartPolicy: TriageSmartPolicyV1Schema.optional(),
    /**
     * Resume each named connection's walk where a previous bounded invocation
     * stopped.
     *
     * A native continuation is the source's own `TriageScanContinuationV1`.
     * An unvisited lane omits it and starts its initial page next time. No
     * second cursor type is minted here, no epoch or delivered-id set
     * rides along, and nothing durable is created. `INV-03` is about
     * *persistence and custody* — a continuation may not outlive the process or
     * be checkpointed — and this member creates neither: the caller that sends
     * one is a mounted surface holding it in memory for the length of one
     * mount, and a lost process simply starts at the first page again.
     *
     * It is a MAP rather than one token, and each entry names its own lane, so a
     * mixed multi-source request pages exactly the way its first page loaded —
     * through the same `scanPass` rotation, with every lane resuming its own
     * frontier. The predecessor admitted a single token only for a request that
     * selected exactly one instance, on the arithmetic that thirty-two maximal
     * tokens would exceed a stale host gate. That derivation was circular:
     * A prior feature-local token ceiling was multiplied by the lane count to
     * manufacture a product restriction. The fixed Action batch is instead
     * measured against the real response transport boundary before the walk —
     * see `triageListRowBudgetV1`.
     *
     * A token naming a connection this request does not walk is ignored rather
     * than refused. It is a stale frontier, not a malformed request, and
     * refusing the invocation over one would cost the caller the whole list.
     *
     * The row bound is unchanged and deliberately not the paging mechanism: a
     * deeper window is successive bounded invocations appended by the caller,
     * never a larger `limit`.
     * With allConfigured, a supplied resume walks only its unfinished lanes.
     * Explicitly selected lanes not in resume still start at their initial page.
    */
    resume: defineProtocolArray(TriageLaneContinuationV1Schema).optional(),
    /** The settled search text. */
    // Empty means no query and stays omitted on this transport. Saved lenses
    // use the wider settled-value schema above because their field is required.
    query: triageText.optional(),
    filters: TriageListFilterSelectionV1Schema.optional(),
}, { policy: 'closed' });
export type TriageListEntriesInputV1 = ReturnType<typeof TriageListEntriesInputV1Schema.parse>;

/**
 * One connection's complete answer for one entry.
 *
 * Absence carries no `basis` member: `CONTRACT.md` §4 fixes its serialized
 * shape at exactly `{ kind, localRef }` and makes the operation the basis,
 * because only an authoritative `get` may answer `absent` at all.
 */
export type TriageProjectedObservationV1 = ReturnType<
    typeof TriageProjectedObservationV1Schema.parse
>;

export type TriageListEntriesResultV1 = ReturnType<typeof TriageListEntriesResultV1Schema.parse>;

/** The one aggregate list Action's plugin-local contribution id. */
export const TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1 = 'entries/list-v1';
