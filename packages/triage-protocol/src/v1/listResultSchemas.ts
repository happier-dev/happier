import {
    ProtocolCollectionOpaqueCursorV1Schema,
    TriageEntryRefV1Schema,
    TriageSourceInstanceIdV1Schema,
    TriageIdentifierV1ProtocolSchema,
    defineProtocolArray,
    defineProtocolLiteral,
    defineProtocolNumber,
    defineProtocolObject,
    defineProtocolUnion,
    type ProtocolComposableSchema,
} from '@happier-dev/plugin-sdk/protocol';
import { PluginContributionIdentityV1Schema } from '@happier-dev/plugin-sdk/manifest';
import { MAX_TRIAGE_LIST_WINDOW_ROWS_V1 } from './constants.js';
import { defineTriageSingleLineStringV1 } from './strings.js';
import { TriageListSortFieldsV1Schema } from './sorting.js';
import type { createTriageListSourceSchemasV1 } from './listSourceSchemas.js';

type TriageListResultSourceSchemasV1 = Pick<ReturnType<typeof createTriageListSourceSchemasV1>,
    'TriageEntryLocatorV1Schema' | 'TriageEntryRepositoryRefV1Schema'
    | 'TriageSourceEntrySnapshotV1Schema' | 'TriageSourceFailureV1Schema'
    | 'TriageListInvocationErrorV1Schema' | 'TriageScanContinuationV1Schema'
    | 'TriageSourceScanEvidenceV1Schema' | 'TriageSourceViewerFactsV1Schema'>;

// Preserve the DSL's separate authored-input/admitted-output projections. Named
// boundaries prevent the same snapshot type expanding through rows and arrays.
type ClosedSchemaV1<TFields extends Readonly<Record<string, ProtocolComposableSchema<unknown, unknown>>>> =
    ReturnType<typeof defineProtocolObject<TFields, { policy: 'closed' }>>;

function laneContinuationFields(sourceSchemas: TriageListResultSourceSchemasV1) {
    const { TriageScanContinuationV1Schema } = sourceSchemas;
    return {
        sourceInstanceId: TriageSourceInstanceIdV1Schema,
        /** The per-page geometry retained for this lane's next request. */
        pageLimit: defineProtocolNumber({
            integer: true,
            minimum: 1,
            maximum: MAX_TRIAGE_LIST_WINDOW_ROWS_V1,
        }),
        /** Absent when the previous window had no capacity to start this lane. */
        continuation: TriageScanContinuationV1Schema.optional(),
    };
}
type LaneContinuationSchemaV1 = ClosedSchemaV1<ReturnType<typeof laneContinuationFields>>;

function projectedObservationFields(sourceSchemas: TriageListResultSourceSchemasV1) {
    const { TriageEntryLocatorV1Schema, TriageEntryRepositoryRefV1Schema, TriageSourceEntrySnapshotV1Schema,
        TriageSourceViewerFactsV1Schema, TriageSourceFailureV1Schema } = sourceSchemas;
    return {
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
    };
}
type ProjectedObservationSchemaV1 = ClosedSchemaV1<ReturnType<typeof projectedObservationFields>>;

function listRowFields(fieldBytes: number, TriageProjectedObservationV1Schema: ProjectedObservationSchemaV1) {
    const triageIdentifier = TriageIdentifierV1ProtocolSchema;
    const triageText = defineTriageSingleLineStringV1(fieldBytes);
    return {
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
        otherObservations: defineProtocolArray(TriageProjectedObservationV1Schema),
        /**
         * How many distinct connections answered for this entry.
         */
        observedByCount: defineProtocolNumber({
            integer: true,
            minimum: 1,
        }),
    };
}
type ListRowSchemaV1 = ClosedSchemaV1<ReturnType<typeof listRowFields>>;

function listLaneFields(sourceSchemas: TriageListResultSourceSchemasV1) {
    const { TriageSourceScanEvidenceV1Schema, TriageSourceFailureV1Schema, TriageListInvocationErrorV1Schema } = sourceSchemas;
    return {
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
                error: TriageListInvocationErrorV1Schema.optional(),
            }, { policy: 'closed' }),
        ]),
        exhausted: defineProtocolUnion([
            defineProtocolLiteral(true),
            defineProtocolLiteral(false),
        ]),
    };
}
type ListLaneSchemaV1 = ClosedSchemaV1<ReturnType<typeof listLaneFields>>;

function configuredSourceFields<TScope>(fieldBytes: number, configuredScope: ProtocolComposableSchema<TScope>,
    sourceSchemas: TriageListResultSourceSchemasV1) {
    const triageIdentifier = TriageIdentifierV1ProtocolSchema;
    const triageText = defineTriageSingleLineStringV1(fieldBytes);
    return {
        sourceInstanceId: TriageSourceInstanceIdV1Schema,
        /** Existing opaque Collection row address; no configured payload is disclosed. */
        configurationRowId: triageIdentifier,
        source: PluginContributionIdentityV1Schema,
        /**
         * Server-authoritative revision of the exact configured Collection row.
         *
         * The mounted acquisition owner compares this with the revision that minted
         * its rows/frontier. It exposes no configured payload and creates no new
         * generation: it is the currentness identity the Collection already owns.
         * Optional only for older in-process fixtures; the canonical Action always
         * publishes it.
         */
        configurationRevision: defineProtocolNumber({ integer: true, minimum: 1 }).optional(),
        displayLabel: triageText.optional(),
        projectionTruncated: defineProtocolLiteral(true).optional(),
        scope: configuredScope.optional(),
        sortFields: TriageListSortFieldsV1Schema.optional(),
        /** Supplied upstream admission cause; omission never manufactures an inventory diagnosis. */
        availabilityFailure: sourceSchemas.TriageSourceFailureV1Schema.optional(),
        /** Whether an admitted V1 source contribution can currently be invoked for it. */
        available: defineProtocolUnion([
            defineProtocolLiteral(true),
            defineProtocolLiteral(false),
        ]),
    };
}
type ConfiguredSourceSchemaV1<TScope> = ClosedSchemaV1<ReturnType<typeof configuredSourceFields<TScope>>>;

function listResultFields<TScope, TTaskProjection>(TriageConfiguredSourceSummaryV1Schema: ConfiguredSourceSchemaV1<TScope>,
    TriageListRowV1Schema: ListRowSchemaV1, TriageListLaneV1Schema: ListLaneSchemaV1,
    TriageLaneContinuationV1Schema: LaneContinuationSchemaV1, taskProjection: ProtocolComposableSchema<TTaskProjection>) {
    return {
        v: defineProtocolLiteral(1),
        configuredSources: defineProtocolArray(TriageConfiguredSourceSummaryV1Schema),
        /**
         * Whether this Action invocation names the whole configured-source
         * Collection, or only its current transport batch.
         */
        configuredSourcesStatus: defineProtocolUnion([
            defineProtocolLiteral('complete'),
            defineProtocolLiteral('truncated'),
        ]),
        /** The opaque Collection cursor for the next configured-source batch. */
        configuredSourcesNextCursor: ProtocolCollectionOpaqueCursorV1Schema.optional(),
        window: defineProtocolObject({
            v: defineProtocolLiteral(1),
            taskProjection: taskProjection.optional(),
            rows: defineProtocolArray(TriageListRowV1Schema, {
                maxItems: MAX_TRIAGE_LIST_WINDOW_ROWS_V1,
            }),
            lanes: defineProtocolArray(TriageListLaneV1Schema),
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
             * The array is bounded by the admitted lane count and nothing cuts its
             * tail. The shared static allocation includes every frontier alongside
             * the bounded presentation/control fields. Unbounded provider
             * collections remain governed by the host envelope, not this finite
             * witness. Dropping a tail token would restart and starve that lane
             * (`PLAN.md` §0a A9a), so it is never used as an overflow workaround.
             */
            continuations: defineProtocolArray(TriageLaneContinuationV1Schema).optional(),
            assembledAtMs: defineProtocolNumber({ integer: true, minimum: 0 }),
        }, { policy: 'closed' }),
    };
}
type ListResultSchemaV1<TScope, TTaskProjection> = ClosedSchemaV1<ReturnType<typeof listResultFields<TScope, TTaskProjection>>>;

export type TriageListResultSchemasV1<TScope, TTaskProjection> = {
    TriageLaneContinuationV1Schema: LaneContinuationSchemaV1;
    TriageProjectedObservationV1Schema: ProjectedObservationSchemaV1;
    TriageListEntriesResultV1Schema: ListResultSchemaV1<TScope, TTaskProjection>;
};

/** Pure result construction; the aggregate retains its business inputs and adjunct schemas. */
export function createTriageListResultSchemasV1<TScope, TTaskProjection>(
    fieldBytes: number,
    sourceSchemas: TriageListResultSourceSchemasV1,
    configuredScope: ProtocolComposableSchema<TScope>,
    taskProjection: ProtocolComposableSchema<TTaskProjection>,
): TriageListResultSchemasV1<TScope, TTaskProjection> {
    const TriageLaneContinuationV1Schema: LaneContinuationSchemaV1 = defineProtocolObject(
        laneContinuationFields(sourceSchemas), { policy: 'closed' },
    );
    const TriageProjectedObservationV1Schema: ProjectedObservationSchemaV1 = defineProtocolObject(
        projectedObservationFields(sourceSchemas), { policy: 'closed' },
    );
    const TriageListRowV1Schema: ListRowSchemaV1 = defineProtocolObject(
        listRowFields(fieldBytes, TriageProjectedObservationV1Schema), { policy: 'closed' },
    );
    const TriageListLaneV1Schema: ListLaneSchemaV1 = defineProtocolObject(
        listLaneFields(sourceSchemas), { policy: 'closed' },
    );
    const TriageConfiguredSourceSummaryV1Schema: ConfiguredSourceSchemaV1<TScope> = defineProtocolObject(
        configuredSourceFields<TScope>(fieldBytes, configuredScope, sourceSchemas), { policy: 'closed' },
    );
    const TriageListEntriesResultV1Schema: ListResultSchemaV1<TScope, TTaskProjection> = defineProtocolObject(
        listResultFields<TScope, TTaskProjection>(TriageConfiguredSourceSummaryV1Schema, TriageListRowV1Schema, TriageListLaneV1Schema,
            TriageLaneContinuationV1Schema, taskProjection),
        { policy: 'closed' },
    );
    return { TriageLaneContinuationV1Schema, TriageProjectedObservationV1Schema, TriageListEntriesResultV1Schema };
}
