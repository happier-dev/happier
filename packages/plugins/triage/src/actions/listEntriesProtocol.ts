import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';
import {
    defineProtocolArray,
    defineProtocolLiteral,
    defineProtocolNumber,
    defineProtocolObject,
    defineProtocolUnion,
    defineProtocolUtf8String,
} from '@happier-dev/plugin-sdk/protocol';
import { PluginContributionIdentityV1Schema } from '@happier-dev/plugin-sdk/manifest';
import {
    MAX_TRIAGE_COLLISION_SCOPE_UTF8_BYTES_V1,
    MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
    MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
    TRIAGE_COMPOSITE_IDENTIFIER_PATTERN_V1,
    TRIAGE_SINGLE_LINE_STRING_PATTERN_V1,
    TriageEntryLocatorV1Schema,
    TriageEntryRepositoryRefV1Schema,
    TriageEntryRefV1Schema,
    TriageSourceEntrySnapshotV1Schema,
    TriageSourceFailureV1Schema,
    TriageSourceInstanceIdV1Schema,
    TriageScanContinuationV1Schema,
    TriageSourceScanEvidenceV1Schema,
    TriageSourceViewerFactsV1Schema,
} from '@happier-dev/triage-protocol/v1';

import { TriageCollectionCursorV1Schema } from './collectionCursorProtocol.js';
import { MAX_TRIAGE_LIST_WINDOW_ROWS_V1 } from '../projection/listWindow.js';

/**
 * The most configured sources one `entries/list-v1` invocation carries.
 *
 * This is a transport batch, not a configured-source membership limit. The
 * schema-derived worst-case response for this shape is measured by
 * `maximumEncodedActionValue.test.ts` against the canonical public Action
 * response envelope. A
 * mounted store pages the Collection through this same Action and schedules
 * successive selected batches through its one refresh coordinator.
 */
export const MAX_TRIAGE_LIST_SOURCE_BATCH_V1 = 32;

/**
 * The strict input and result contract of the one aggregate PRs & Issues list
 * Action.
 *
 * It is declared here rather than in `@happier-dev/triage-protocol` on purpose.
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

const triageCollisionScope = defineProtocolUtf8String({
    maxUtf8Bytes: MAX_TRIAGE_COLLISION_SCOPE_UTF8_BYTES_V1,
    minLength: 1,
    pattern: TRIAGE_COMPOSITE_IDENTIFIER_PATTERN_V1,
});

const triageText = defineProtocolUtf8String({
    maxUtf8Bytes: MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
    minLength: 1,
    pattern: TRIAGE_SINGLE_LINE_STRING_PATTERN_V1,
});

/**
 * One filter facet on the wire.
 *
 * It has no independent member-count ceiling. The saved-view form remains
 * bounded by its local 64 KiB serialized Settings value. Adding another count here
 * would make a valid lens behave differently depending on whether it was live,
 * routed, or saved.
 */
const facetArray = <TSchema extends Parameters<typeof defineProtocolArray>[0]>(schema: TSchema) => (
    defineProtocolArray(schema)
);

/**
 * The one source-neutral filter vocabulary on the wire.
 *
 * Exported so the saved-view Action persists the exact same shape the list
 * Action queries with: a second spelling of a facet is how a saved lens and a
 * live lens start to disagree.
 */
export const TriageListFilterSelectionV1Schema = defineProtocolObject({
    sources: facetArray(defineProtocolObject({
        source: PluginContributionIdentityV1Schema,
    }, { policy: 'closed' })),
    types: facetArray(defineProtocolObject({
        source: PluginContributionIdentityV1Schema,
        kindId: triageIdentifier,
    }, { policy: 'closed' })),
    scopes: facetArray(defineProtocolObject({
        source: PluginContributionIdentityV1Schema,
        collisionScope: triageCollisionScope,
    }, { policy: 'closed' })),
    states: facetArray(defineProtocolUnion([
        defineProtocolLiteral('open'),
        defineProtocolLiteral('done'),
        defineProtocolLiteral('absent'),
        defineProtocolLiteral('unresolved'),
    ])),
    attention: facetArray(defineProtocolUnion([
        defineProtocolLiteral('required'),
        defineProtocolLiteral('suggested'),
        defineProtocolLiteral('none'),
    ])),
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
        defineProtocolLiteral('attention'),
        defineProtocolLiteral('activity'),
    ]), { minItems: 2, maxItems: 2 }),
}, { policy: 'closed' });

/**
 * The configured-source selection.
 *
 * An empty `selected` list is a real and useful request: it enumerates the
 * configured sources without reading any provider, which is exactly what a
 * cold mount and the Composer picker need in order to be visibly
 * unsynchronized rather than falsely empty (`REQ-14`).
 */
const TriageListSourceSelectionV1Schema = defineProtocolUnion([
    defineProtocolObject({
        kind: defineProtocolLiteral('allConfigured'),
        /** Opaque Collection continuation for the next configured-source batch. */
        cursor: TriageCollectionCursorV1Schema.optional(),
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('selected'),
        sourceInstanceIds: defineProtocolArray(TriageSourceInstanceIdV1Schema, {
            maxItems: MAX_TRIAGE_LIST_SOURCE_BATCH_V1,
        }),
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
const TriageLaneContinuationV1Schema = defineProtocolObject({
    sourceInstanceId: TriageSourceInstanceIdV1Schema,
    continuation: TriageScanContinuationV1Schema,
}, { policy: 'closed' });

/**
 * The explicit page-size contract, independent of how many lane continuations
 * accompany the result. The host Action response has one aggregate transport
 * boundary, proven by the schema-derived maximum for this fixed batch shape;
 * shrinking rows further to reserve a separate continuation budget would add a
 * second unsupported product limit beneath `MAX_TRIAGE_LIST_WINDOW_ROWS_V1`.
 */
export function triageListRowBudgetV1(_laneCount: number): number {
    return MAX_TRIAGE_LIST_WINDOW_ROWS_V1;
}

export const TriageListEntriesInputV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    sources: TriageListSourceSelectionV1Schema,
    limit: defineProtocolNumber({
        integer: true,
        minimum: 0,
        maximum: MAX_TRIAGE_LIST_WINDOW_ROWS_V1,
    }),
    order: defineProtocolUnion([
        defineProtocolLiteral('newest'),
        defineProtocolLiteral('oldest'),
        defineProtocolLiteral('smart'),
    ]),
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
     * Every member is the source's own `TriageScanContinuationV1` and nothing
     * else: no second cursor type is minted here, no epoch or delivered-id set
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
    */
    resume: defineProtocolArray(TriageLaneContinuationV1Schema, {
        maxItems: MAX_TRIAGE_LIST_SOURCE_BATCH_V1,
    }).optional(),
    /** The settled search text. */
    query: triageText.optional(),
    filters: TriageListFilterSelectionV1Schema.optional(),
}, { policy: 'closed' });
export type TriageListEntriesInputV1 = ReturnType<typeof TriageListEntriesInputV1Schema.parse>;
export const TriageListEntriesInputV1JsonSchema: PluginJsonSchema =
    TriageListEntriesInputV1Schema.jsonSchema;

/**
 * One connection's complete answer for one entry.
 *
 * Absence carries no `basis` member: `CONTRACT.md` §4 fixes its serialized
 * shape at exactly `{ kind, localRef }` and makes the operation the basis,
 * because only an authoritative `get` may answer `absent` at all.
 */
export const TriageProjectedObservationV1Schema = defineProtocolObject({
    sourceInstanceId: TriageSourceInstanceIdV1Schema,
    observedAtMs: defineProtocolNumber({ integer: true, minimum: 0 }),
    outcome: defineProtocolUnion([
        defineProtocolObject({
            kind: defineProtocolLiteral('present'),
            locator: TriageEntryLocatorV1Schema,
            snapshot: TriageSourceEntrySnapshotV1Schema,
            viewer: TriageSourceViewerFactsV1Schema,
            sourceUpdatedAtMs: defineProtocolNumber({ integer: true }).optional(),
            // The forge repository this entry belongs to, carried because the
            // mounted surface resolves launch placement from the row it is
            // looking at: the detail Action carries no observation, so a press
            // that had to fetch this separately would resolve placement from a
            // second read of the same entry. `nativeRevision` stays off this
            // wire for the opposite reason — nothing on a list row reads it.
            repository: TriageEntryRepositoryRefV1Schema.optional(),
        }, { policy: 'closed' }),
        defineProtocolObject({
            kind: defineProtocolLiteral('absent'),
        }, { policy: 'closed' }),
        defineProtocolObject({
            kind: defineProtocolLiteral('merged'),
            successor: TriageEntryRefV1Schema,
        }, { policy: 'closed' }),
        defineProtocolObject({
            kind: defineProtocolLiteral('unresolved'),
            failure: TriageSourceFailureV1Schema,
        }, { policy: 'closed' }),
    ]),
}, { policy: 'closed' });
export type TriageProjectedObservationV1 = ReturnType<
    typeof TriageProjectedObservationV1Schema.parse
>;

/**
 * The complete folded answer from every connection other than the one the row
 * renders from.
 *
 * `REQ-03` makes this member necessary: an entry observed through two configured
 * connections is one entry with two observations. The mounted store receives
 * one mixed Action result and rehydrates it through the canonical fold, so a
 * compact marker would erase the facts that determine attention and selection
 * for every non-rendered connection.
 *
 * It remains bounded by the source batch this one Action invocation carries.
 * The fixed batch is measured against the host Action response transport rather
 * than being a configured-source product ceiling.
 */
const TriageListRowV1Schema = defineProtocolObject({
    entryRef: TriageEntryRefV1Schema,
    lane: defineProtocolUnion([
        defineProtocolLiteral('1-open'),
        defineProtocolLiteral('2-done'),
    ]),
    sortAtMs: defineProtocolNumber({ integer: true }),
    presence: defineProtocolObject({
        kind: defineProtocolUnion([
            defineProtocolLiteral('present'),
            defineProtocolLiteral('absent'),
            defineProtocolLiteral('unresolved'),
        ]),
        /** Absent exactly when an unresolved roll-up observed nothing at all. */
        observedAtMs: defineProtocolNumber({ integer: true, minimum: 0 }).optional(),
    }, { policy: 'closed' }),
    attention: defineProtocolObject({
        level: defineProtocolUnion([
            defineProtocolLiteral('required'),
            defineProtocolLiteral('suggested'),
        ]),
        fromSourceInstanceId: TriageSourceInstanceIdV1Schema,
        reasonId: triageIdentifier,
        reasonLabel: triageText,
    }, { policy: 'closed' }).optional(),
    /** Which connection this row's detail and Actions run under, and why. */
    selected: defineProtocolUnion([
        defineProtocolObject({
            kind: defineProtocolLiteral('selected'),
            sourceInstanceId: TriageSourceInstanceIdV1Schema,
            reason: defineProtocolUnion([
                defineProtocolLiteral('override'),
                defineProtocolLiteral('attention'),
                defineProtocolLiteral('onlyPresent'),
                defineProtocolLiteral('deterministicTieBreak'),
            ]),
        }, { policy: 'closed' }),
        defineProtocolObject({
            kind: defineProtocolLiteral('none'),
            reason: defineProtocolUnion([
                defineProtocolLiteral('noPresentObservation'),
                defineProtocolLiteral('allInstancesRetired'),
            ]),
        }, { policy: 'closed' }),
    ]),
    /**
     * The one connection's complete answer this row is rendered from: the
     * `selected` connection's when one was selectable, the newest present one
     * when none was, and otherwise the newest answer of any kind. A row exists
     * because some connection answered for it, so this member is never absent.
     */
    observation: TriageProjectedObservationV1Schema,
    /** Every other connection's complete folded answer. */
    otherObservations: defineProtocolArray(TriageProjectedObservationV1Schema, {
        maxItems: MAX_TRIAGE_LIST_SOURCE_BATCH_V1 - 1,
    }),
    /**
     * How many distinct connections answered for this entry.
     */
    observedByCount: defineProtocolNumber({
        integer: true,
        minimum: 1,
        maximum: MAX_TRIAGE_LIST_SOURCE_BATCH_V1,
    }),
}, { policy: 'closed' });

const TriageListLaneV1Schema = defineProtocolObject({
    sourceInstanceId: TriageSourceInstanceIdV1Schema,
    source: PluginContributionIdentityV1Schema,
    health: defineProtocolUnion([
        TriageSourceScanEvidenceV1Schema,
        defineProtocolObject({
            kind: defineProtocolLiteral('failed'),
            failure: TriageSourceFailureV1Schema,
        }, { policy: 'closed' }),
        defineProtocolObject({
            kind: defineProtocolLiteral('unavailable'),
        }, { policy: 'closed' }),
    ]),
    exhausted: defineProtocolUnion([
        defineProtocolLiteral(true),
        defineProtocolLiteral(false),
    ]),
}, { policy: 'closed' });

/**
 * One active or retired configured source instance, as the aggregate knows it.
 *
 * It deliberately carries no account ref, local instance key or routing
 * configuration: those stay inside the private configured payload and never
 * reach a caller of this Action.
 */
const TriageConfiguredSourceSummaryV1Schema = defineProtocolObject({
    sourceInstanceId: TriageSourceInstanceIdV1Schema,
    source: PluginContributionIdentityV1Schema,
    displayLabel: triageText.optional(),
    /** Whether an admitted V1 source contribution can currently be invoked for it. */
    available: defineProtocolUnion([
        defineProtocolLiteral(true),
        defineProtocolLiteral(false),
    ]),
}, { policy: 'closed' });

export const TriageListEntriesResultV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    configuredSources: defineProtocolArray(TriageConfiguredSourceSummaryV1Schema, {
        maxItems: MAX_TRIAGE_LIST_SOURCE_BATCH_V1,
    }),
    /**
     * Whether this Action invocation names the whole configured-source
     * Collection, or only its current transport batch.
     */
    configuredSourcesStatus: defineProtocolUnion([
        defineProtocolLiteral('complete'),
        defineProtocolLiteral('truncated'),
    ]),
    /** The opaque Collection cursor for the next configured-source batch. */
    configuredSourcesNextCursor: TriageCollectionCursorV1Schema.optional(),
    window: defineProtocolObject({
        v: defineProtocolLiteral(1),
        rows: defineProtocolArray(TriageListRowV1Schema, {
            maxItems: MAX_TRIAGE_LIST_WINDOW_ROWS_V1,
        }),
        lanes: defineProtocolArray(TriageListLaneV1Schema, {
            maxItems: MAX_TRIAGE_LIST_SOURCE_BATCH_V1,
        }),
        coverage: defineProtocolUnion([
            defineProtocolLiteral('complete'),
            defineProtocolLiteral('partial'),
        ]),
        /**
         * Where each walked connection stopped, for every lane that stopped with
         * more to give and nothing wrong.
         *
         * One entry per such lane, so a mixed multi-source window is paged the
         * same way it was loaded rather than one connection at a time. A lane
         * that exhausted, failed, timed out or broke the page contract offers
         * none: resuming a walk that broke is not paging, and the next cycle
         * asks it again from the first page.
         *
         * The array is bounded by the lane count, which is the most frontiers
         * that can exist, and NOTHING cuts it: `triageListRowBudgetV1` reserved
         * the bytes for every one of them before the walk, so the whole set
         * always fits beside the window it belongs to. A set that lost its tail
         * would starve exactly the lanes that lost it, on every page, forever
         * (`PLAN.md` §0a A9a). The result is never rejected whole over a paging
         * token either: whole-result rejection is the other harm.
         */
        continuations: defineProtocolArray(TriageLaneContinuationV1Schema, {
            maxItems: MAX_TRIAGE_LIST_SOURCE_BATCH_V1,
        }).optional(),
        assembledAtMs: defineProtocolNumber({ integer: true, minimum: 0 }),
    }, { policy: 'closed' }),
}, { policy: 'closed' });
export type TriageListEntriesResultV1 = ReturnType<typeof TriageListEntriesResultV1Schema.parse>;
export const TriageListEntriesResultV1JsonSchema: PluginJsonSchema =
    TriageListEntriesResultV1Schema.jsonSchema;

/** The one aggregate list Action's plugin-local contribution id. */
export const TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1 = 'entries/list-v1';
