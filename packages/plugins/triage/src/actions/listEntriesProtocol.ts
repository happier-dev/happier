import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';
import {
    defineProtocolArray,
    defineProtocolLiteral,
    defineProtocolNumber,
    defineProtocolObject,
    defineProtocolString,
    defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';
import { PluginContributionIdentityV1Schema } from '@happier-dev/plugin-sdk/manifest';
import {
    MAX_TRIAGE_COLLISION_SCOPE_UTF8_BYTES_V1,
    MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
    MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
    TRIAGE_COMPOSITE_IDENTIFIER_PATTERN_V1,
    TRIAGE_SINGLE_LINE_STRING_PATTERN_V1,
    TriageEntryLocatorV1Schema,
    TriageEntryRefV1Schema,
    TriageSourceEntrySnapshotV1Schema,
    TriageSourceFailureV1Schema,
    TriageSourceInstanceIdV1Schema,
    TriageSourceScanEvidenceV1Schema,
    TriageSourceViewerFactsV1Schema,
} from '@happier-dev/triage-protocol/v1';

import { MAX_TRIAGE_CONFIGURED_SOURCE_INSTANCES_V1 } from '../corpus/configuration/administerConfiguredSourceInstance.js';
import { MAX_TRIAGE_LIST_WINDOW_ROWS_V1 } from '../projection/listWindow.js';
import { MAX_TRIAGE_SAVED_VIEW_FACET_VALUES_V1 } from '../settings/savedViews.js';

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
 */

const triageIdentifier = defineProtocolString({
    minLength: 1,
    maxLength: MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
    pattern: TRIAGE_SINGLE_LINE_STRING_PATTERN_V1,
});

const triageCollisionScope = defineProtocolString({
    minLength: 1,
    maxLength: MAX_TRIAGE_COLLISION_SCOPE_UTF8_BYTES_V1,
    pattern: TRIAGE_COMPOSITE_IDENTIFIER_PATTERN_V1,
});

const triageText = defineProtocolString({
    minLength: 1,
    maxLength: MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
    pattern: TRIAGE_SINGLE_LINE_STRING_PATTERN_V1,
});

/**
 * One filter facet on the wire.
 *
 * It is bounded by the saved-view owner's own facet maximum rather than by a
 * second number: `savedViews.ts` rejects a view whose facet exceeds it, so a
 * wider wire array could only ever carry a lens that could not be saved — and a
 * facet the list would query with but the user could never keep is two
 * spellings of one vocabulary.
 */
const facetArray = <TSchema extends Parameters<typeof defineProtocolArray>[0]>(schema: TSchema) => (
    defineProtocolArray(schema, { maxItems: MAX_TRIAGE_SAVED_VIEW_FACET_VALUES_V1 })
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
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('selected'),
        sourceInstanceIds: defineProtocolArray(TriageSourceInstanceIdV1Schema, {
            maxItems: MAX_TRIAGE_CONFIGURED_SOURCE_INSTANCES_V1,
        }),
    }, { policy: 'closed' }),
]);

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
     * The settled search text. There is deliberately no window cursor: a scan
     * continuation is invocation-local, and a cursor that outlived the pass
     * would be exactly the durable checkpoint `INV-03` forbids. A deeper window
     * is a larger `limit`, bounded by the published row maximum.
     */
    query: triageText.optional(),
    filters: TriageListFilterSelectionV1Schema.optional(),
}, { policy: 'closed' });
export type TriageListEntriesInputV1 = ReturnType<typeof TriageListEntriesInputV1Schema.parse>;
export const TriageListEntriesInputV1JsonSchema: PluginJsonSchema =
    TriageListEntriesInputV1Schema.jsonSchema;

const TriageObservationKindV1Schema = defineProtocolUnion([
    defineProtocolLiteral('present'),
    defineProtocolLiteral('absent'),
    defineProtocolLiteral('merged'),
    defineProtocolLiteral('unresolved'),
]);

/**
 * One connection's complete answer for one entry.
 *
 * Absence carries no `basis` member: `CONTRACT.md` §4 fixes its serialized
 * shape at exactly `{ kind, localRef }` and makes the operation the basis,
 * because only an authoritative `get` may answer `absent` at all.
 */
const TriageProjectedObservationV1Schema = defineProtocolObject({
    sourceInstanceId: TriageSourceInstanceIdV1Schema,
    observedAtMs: defineProtocolNumber({ integer: true, minimum: 0 }),
    outcome: defineProtocolUnion([
        defineProtocolObject({
            kind: defineProtocolLiteral('present'),
            locator: TriageEntryLocatorV1Schema,
            snapshot: TriageSourceEntrySnapshotV1Schema,
            viewer: TriageSourceViewerFactsV1Schema,
            sourceUpdatedAtMs: defineProtocolNumber({ integer: true }).optional(),
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

/**
 * How many *other* connections one row reports individually.
 *
 * `REQ-03` is what makes this member exist at all: an entry observed through
 * two configured connections is one entry with two observations, and a row that
 * named only one of them would erase the second connection from the product.
 *
 * The bound exists because the row's content does not fit twice. Every Action
 * result crosses a hard 1 MiB host gate that rejects the whole value rather
 * than truncating it, and a maximal window already spends four fifths of that
 * gate on one snapshot per row. Carrying a second full snapshot for each of
 * `MAX_TRIAGE_CONFIGURED_SOURCE_INSTANCES_V1` connections would exceed the gate
 * more than twentyfold, so every list a user with several connections opened
 * would fail outright. What the row carries instead is the rendered
 * connection's answer in full and every other connection's answer in one line;
 * the full per-connection content is a detail read, under the exact connection
 * chosen, which is where the account authority to make it lives anyway.
 *
 * Four is the count that keeps the maximal window inside the gate with room
 * left over, and `observedByCount` is what keeps a wider set honest rather than
 * silent: a row observed through more connections than this still says how
 * many. `actions/maximumEncodedActionValue.test.ts` is where that arithmetic is
 * checked against the owner that actually enforces it.
 */
export const MAX_TRIAGE_LIST_ROW_OTHER_OBSERVATIONS_V1 = 4;

/**
 * What one other connection answered, without repeating the row's content.
 *
 * It is deliberately the outcome *kind* and nothing more. A successor ref, a
 * failure or a snapshot on this member would be per-connection detail content
 * multiplied by the row count, which is exactly the shape the byte gate
 * rejects; the row's own `presence`, `attention` and `selected` members already
 * carry every cross-connection conclusion the list itself draws.
 */
const TriageRowOtherObservationV1Schema = defineProtocolObject({
    sourceInstanceId: TriageSourceInstanceIdV1Schema,
    observedAtMs: defineProtocolNumber({ integer: true, minimum: 0 }),
    kind: TriageObservationKindV1Schema,
}, { policy: 'closed' });

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
    /** Every other connection that answered, newest answer first. */
    otherObservations: defineProtocolArray(TriageRowOtherObservationV1Schema, {
        maxItems: MAX_TRIAGE_LIST_ROW_OTHER_OBSERVATIONS_V1,
    }),
    /**
     * How many distinct connections answered for this entry. It is stated
     * rather than inferred from the array above so that a row observed through
     * more connections than the row reports individually is visibly, not
     * silently, incomplete.
     */
    observedByCount: defineProtocolNumber({
        integer: true,
        minimum: 1,
        maximum: MAX_TRIAGE_CONFIGURED_SOURCE_INSTANCES_V1,
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
        maxItems: MAX_TRIAGE_CONFIGURED_SOURCE_INSTANCES_V1,
    }),
    /**
     * Whether the array above names the whole active configured set.
     *
     * The array's bound and the lifecycle writer's admission bound are one
     * number, so a set that exceeded the writer's bound cannot be carried here
     * at all. `truncated` says so — reusing the same `complete`/`truncated`
     * vocabulary the generic Connected Accounts listing already answers with —
     * rather than letting the surplus vanish behind a window that reports a
     * finished walk.
     */
    configuredSourcesStatus: defineProtocolUnion([
        defineProtocolLiteral('complete'),
        defineProtocolLiteral('truncated'),
    ]),
    window: defineProtocolObject({
        v: defineProtocolLiteral(1),
        rows: defineProtocolArray(TriageListRowV1Schema, {
            maxItems: MAX_TRIAGE_LIST_WINDOW_ROWS_V1,
        }),
        lanes: defineProtocolArray(TriageListLaneV1Schema, {
            maxItems: MAX_TRIAGE_CONFIGURED_SOURCE_INSTANCES_V1,
        }),
        coverage: defineProtocolUnion([
            defineProtocolLiteral('complete'),
            defineProtocolLiteral('partial'),
        ]),
        assembledAtMs: defineProtocolNumber({ integer: true, minimum: 0 }),
    }, { policy: 'closed' }),
}, { policy: 'closed' });
export type TriageListEntriesResultV1 = ReturnType<typeof TriageListEntriesResultV1Schema.parse>;
export const TriageListEntriesResultV1JsonSchema: PluginJsonSchema =
    TriageListEntriesResultV1Schema.jsonSchema;

/** The one aggregate list Action's plugin-local contribution id. */
export const TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1 = 'entries/list-v1';
