import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';
import {
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
    TriageSourceDescriptorV1Schema,
    TriageSourceInstanceIdV1Schema,
} from '@happier-dev/triage-protocol/v1';

/**
 * The durable half of one mounted detail input.
 *
 * A mounted surface holds a Host API with no storage member, so an Action is
 * the only transport into an Account Collection. Two of the three members the
 * published `TriageDetailSurfaceInputV1` requires are exactly that — the
 * configured source instance and the entry's Session links — while the third,
 * the applied observation, is already in the reader's own device-local
 * projection. This Action returns the two the surface cannot reach, and the
 * surface composes them into the strict input through the one boundary builder.
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
}, { policy: 'closed' });
export type TriageReadEntryDetailInputV1 = ReturnType<
    typeof TriageReadEntryDetailInputV1Schema.parse
>;
export const TriageReadEntryDetailInputV1JsonSchema: PluginJsonSchema =
    TriageReadEntryDetailInputV1Schema.jsonSchema;

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
 * `sourceDescriptor` is the entry's own source's declared descriptor, exactly
 * as the target parsed it from the admitted snapshot — the same typed value the
 * aggregate list Action reads its declared kind vocabulary from. It is carried
 * here rather than on the aggregate list result because it is bounded per
 * *entry* here and per *configured connection* there. Keeping the descriptor on
 * detail avoids repeating a large source vocabulary in every aggregate list
 * result without taking that vocabulary away from the reader.
 *
 * It is optional and absent means "no admitted V1 contribution from that source
 * right now" — never a placeholder, and never a claim that the source declared
 * nothing. The reader that has it names the source and the entry kind in the
 * source's own words; the reader that does not says neither.
 */
export const TriageReadEntryDetailResultV1Schema = defineProtocolUnion([
    defineProtocolObject({
        kind: defineProtocolLiteral('read'),
        instance: TriageConfiguredSourceInstanceV1Schema,
        linkedSessions: defineProtocolArray(TriageLinkedSessionProjectionV1Schema, {
            maxItems: MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1,
        }),
        linkedSessionsHasMore: defineProtocolUnion([
            defineProtocolLiteral(true),
            defineProtocolLiteral(false),
        ]),
        sourceDescriptor: TriageSourceDescriptorV1Schema.optional(),
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
export const TriageReadEntryDetailResultV1JsonSchema: PluginJsonSchema =
    TriageReadEntryDetailResultV1Schema.jsonSchema;

/** The detail read's plugin-local contribution id. */
export const TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1 = 'entries/read-detail-v1';
