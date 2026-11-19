import {
    ProtocolCollectionOpaqueCursorV1Schema,
    defineProtocolArray,
    defineProtocolLiteral,
    defineProtocolObject,
    defineProtocolUnion,
    TriageIdentifierV1ProtocolSchema,
} from '@happier-dev/plugin-sdk/protocol';
import {
    TriageAdmittedReviewV1Schema,
    TriageConfiguredSourceInstanceV1Schema,
    TriageEntryRefV1Schema,
    TriageLinkedSessionProjectionV1Schema,
    TriageSourceInstanceIdV1Schema,
} from '@happier-dev/triage-protocol/v1';

export const TRIAGE_READ_PULL_REQUEST_STATUS_ACTION_LOCAL_ID_V1 = 'entries/read-pull-request-status-v1';

/**
 * The durable half of one mounted detail input.
 *
 * Two of the three members the published `TriageDetailSurfaceInputV1` requires
 * are Account Collection state: the configured source instance and the entry's
 * Session links. A mounted UI that has the generic Account data client reads
 * them through the same domain owner directly; this Action is the daemon
 * transport when that client is unavailable. The third member, the applied
 * observation, is already in the reader's device-local projection. Both paths
 * compose the strict input through the one boundary builder.
 *
 * Same-Account callers use this exact contract. The handler enforces admitted
 * source/kind selection and configured-instance correspondence.
 */

export const TriageReadEntryDetailInputV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    /** The canonical entry the reader selected. */
    entryRef: TriageEntryRefV1Schema,
    /**
     * The exact connection the row was rendered from. It is required and never
     * inferred: with several configured connections observing one logical entry,
     * choosing "the first" would silently show a different provider's truth.
     */
    sourceInstanceId: TriageSourceInstanceIdV1Schema,
    /** A known private row address; the stored row still owns identity and lifecycle. */
    sourceInstanceRowId: TriageIdentifierV1ProtocolSchema.optional(),
    /** Absent reads the first linked-Session page; present continues it opaquely. */
    linkedSessionsCursor: ProtocolCollectionOpaqueCursorV1Schema.optional(),
}, { policy: 'closed' });
export type TriageReadEntryDetailInputV1 = ReturnType<
    typeof TriageReadEntryDetailInputV1Schema.parse
>;

/**
 * `unavailable` is the honest answer for a selection whose connection is no
 * longer active — removed, reconfigured onto a different account or key, or
 * owned by a source that is no longer admitted. The surface keeps the selection
 * and renders the aggregate fallback (`core/SURFACE.md` §3.1); it does not fall
 * through to another connection, which would open a different provider's answer
 * under the entry the reader chose.
 *
 * `linkedSessions` is required and `[]` means no links — never "unknown".
 * A retained link whose generic Session summary is unavailable or tombstoned
 * keeps its `sessionId` and omits the two presentation fields, exactly as
 * `CONTRACT.md` §7 requires; no reader may infer that such a Session was never
 * linked.
 *
 * Source descriptors and operation/surface facts do not cross this wire.
 * Mounted self reads remain independent of daemon contribution availability;
 * host automated callers resolve the existing admitted source owner before
 * reading private configuration.
 */
export const TriageReadEntryDetailResultV1Schema = defineProtocolUnion([
    defineProtocolObject({
        kind: defineProtocolLiteral('read'),
        instance: TriageConfiguredSourceInstanceV1Schema,
        linkedSessions: defineProtocolArray(TriageLinkedSessionProjectionV1Schema),
        /** The Collection owner's opaque continuation; absent means this page completed the relation. */
        linkedSessionsNextCursor: ProtocolCollectionOpaqueCursorV1Schema.optional(),
        /** The entry's latest admitted PR Review and round; absent when none was admitted through Triage. */
        admittedReview: TriageAdmittedReviewV1Schema.optional(),
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('unavailable'),
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('invalidCaller'),
    }, { policy: 'closed' }),
]);
export type TriageReadEntryDetailResultV1 = ReturnType<
    typeof TriageReadEntryDetailResultV1Schema.parse
>;

/** The detail read's plugin-local contribution id. */
export const TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1 = 'entries/read-detail-v1';
