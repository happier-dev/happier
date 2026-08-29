import {
    ProtocolCollectionOpaqueCursorV1Schema,
    defineProtocolArray,
    defineProtocolLiteral,
    defineProtocolObject,
    defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';
import {
    MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1,
    TriageConfiguredSourceInstanceV1Schema,
    TriageEntryRefV1Schema,
    TriageLinkedSessionProjectionV1Schema,
    TriageSourceInstanceIdV1Schema,
} from '@happier-dev/triage-protocol/v1';

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
 * It is declared here rather than in `@happier-dev/triage-protocol` for the same
 * reason the aggregate list Action is: it has exactly one caller family — this
 * plugin's own mounted surfaces — and publishing it cross-plugin would invite a
 * second reader of another source's private configured payload. The handler
 * enforces that caller rule; this file only describes the wire.
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
 * Source descriptor and operation/surface facts do not cross this wire. The
 * mounted host already supplies their one exact generation in
 * `SurfaceContext.targetedContributions`; rereading them here would create a
 * second descriptor authority and make this durable Account read require a
 * daemon.
 */
export const TriageReadEntryDetailResultV1Schema = defineProtocolUnion([
    defineProtocolObject({
        kind: defineProtocolLiteral('read'),
        instance: TriageConfiguredSourceInstanceV1Schema,
        linkedSessions: defineProtocolArray(TriageLinkedSessionProjectionV1Schema, {
            maxItems: MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1,
        }),
        /** The Collection owner's opaque continuation; absent means this page completed the relation. */
        linkedSessionsNextCursor: ProtocolCollectionOpaqueCursorV1Schema.optional(),
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
