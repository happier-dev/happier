import { defineProtocolArray, defineProtocolNumber, defineProtocolLiteral, defineProtocolObject,
    defineProtocolString, defineProtocolUnion, defineProtocolUniqueArray,
    ProtocolCollectionOpaqueCursorV1Schema } from '@happier-dev/plugin-sdk/protocol';
import { PluginContributionIdentityV1Schema } from '@happier-dev/plugin-sdk/manifest';
import { MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1, MAX_TRIAGE_TEXT_UTF8_BYTES_V1, TRIAGE_SINGLE_LINE_STRING_PATTERN_V1 } from './bounds.js';
import { TriageEntryLocatorV1Schema, TriageEntryRefV1Schema, TriageSourceInstanceIdV1Schema, TriageIdentifierV1ProtocolSchema } from './identity.js';
import { TriageSourceFailureV1Schema, TriageListInvocationErrorV1Schema } from './diagnostics.js';
import { TriageConfigureSourceOfferV1Schema } from './sourceAdministration.js';

const triageSessionId = defineProtocolString({ minLength: 1, maxLength: MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
    pattern: TRIAGE_SINGLE_LINE_STRING_PATTERN_V1 });
const triageText = defineProtocolString({ minLength: 1, maxLength: MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
    pattern: TRIAGE_SINGLE_LINE_STRING_PATTERN_V1 });

/** Source-owned relationships supplement the existing external Collection pager. */
export const TRIAGE_READ_SOURCE_SESSION_LINKS_ACTION_LOCAL_ID_V1 = 'sessions/read-source-links-v1';
export const TriageReadSourceSessionLinksInputV1Schema = defineProtocolUnion([
    defineProtocolObject({ v: defineProtocolLiteral(1), sessionId: triageSessionId }, { policy: 'closed' }),
    defineProtocolObject({ v: defineProtocolLiteral(1), entryRef: TriageEntryRefV1Schema,
        sourceInstanceId: TriageSourceInstanceIdV1Schema.optional(),
    }, { policy: 'closed' }),
    defineProtocolObject({ v: defineProtocolLiteral(1), entries: defineProtocolArray(defineProtocolObject({
        entryRef: TriageEntryRefV1Schema, sourceInstanceId: TriageSourceInstanceIdV1Schema.optional(),
    }, { policy: 'closed' }), { minItems: 1 }) }, { policy: 'closed' }),
]);
export const TriageSourceSessionLinksLaneV1Schema = defineProtocolObject({
    source: PluginContributionIdentityV1Schema,
    sourceInstanceId: TriageSourceInstanceIdV1Schema,
    displayLabel: triageText,
    /** Absent only for an unavailable descriptor or a prior source-wide reply.
     * Such a lane cannot establish complete kind coverage. */
    kindIds: defineProtocolUniqueArray(TriageIdentifierV1ProtocolSchema, { minItems: 1 }).optional(),
    health: defineProtocolUnion([
        defineProtocolObject({ kind: defineProtocolLiteral('complete') }, { policy: 'closed' }),
        defineProtocolObject({ kind: defineProtocolLiteral('partial'),
            unavailableRefs: defineProtocolArray(TriageEntryRefV1Schema, { minItems: 1 }),
        }, { policy: 'closed' }),
        defineProtocolObject({ kind: defineProtocolLiteral('unavailable') }, { policy: 'closed' }),
        defineProtocolObject({ kind: defineProtocolLiteral('failed'), failure: TriageSourceFailureV1Schema,
            invocationError: TriageListInvocationErrorV1Schema.optional(),
        }, { policy: 'closed' }),
    ]),
}, { policy: 'closed' });
export type TriageSourceSessionLinksLaneV1 = ReturnType<typeof TriageSourceSessionLinksLaneV1Schema.parse>;
export const TriageReadSourceSessionLinksResultV1Schema = defineProtocolObject({
    kind: defineProtocolUnion([defineProtocolLiteral('complete'), defineProtocolLiteral('partial'), defineProtocolLiteral('failed')]),
    links: defineProtocolArray(defineProtocolObject({
        entryRef: TriageEntryRefV1Schema, sessionId: triageSessionId,
        sourceInstanceId: TriageSourceInstanceIdV1Schema.optional(),
        sourceInstanceRevision: defineProtocolNumber({ integer: true, minimum: 0 }).optional(),
        /** Exact private configuration lookup, carried by the admitted relation owner. */
        sourceInstanceRowId: TriageIdentifierV1ProtocolSchema.optional(),
        linkedAtMs: defineProtocolNumber({ integer: true }),
        displayPath: defineProtocolString({ minLength: 1, pattern: TRIAGE_SINGLE_LINE_STRING_PATTERN_V1 }),
        locator: TriageEntryLocatorV1Schema.optional(),
    }, { policy: 'closed' })),
    /** Optional so a newly loaded surface can still read a prior daemon reply. */
    lanes: defineProtocolArray(TriageSourceSessionLinksLaneV1Schema).optional(),
    nextCursor: ProtocolCollectionOpaqueCursorV1Schema.optional(),
    /** Already admitted setup destinations; no discovery or configuration write on a read. */
    configureSources: defineProtocolArray(TriageConfigureSourceOfferV1Schema).optional(),
}, { policy: 'closed' });
export type TriageReadSourceSessionLinksInputV1 = ReturnType<typeof TriageReadSourceSessionLinksInputV1Schema.parse>;
export type TriageReadSourceSessionLinksResultV1 = ReturnType<typeof TriageReadSourceSessionLinksResultV1Schema.parse>;

/** Prior source-wide replies have no proof of a covered kind slice. Preserve
 * readable links while making that unknown coverage explicit at this seam. */
export function normalizeTriageSourceSessionLinksCoverageV1(result: TriageReadSourceSessionLinksResultV1): TriageReadSourceSessionLinksResultV1 {
    if (result.kind === 'complete' && result.links.length === 0 && result.lanes?.length === 0 && result.nextCursor === undefined) return result;
    if (result.lanes !== undefined && result.lanes.length > 0 && result.lanes.every(lane => lane.kindIds !== undefined)) return result;
    const lanes = result.lanes?.map(lane => lane.kindIds === undefined && lane.health.kind === 'complete'
        ? { ...lane, health: { kind: 'unavailable' as const } } : lane);
    const readable = result.links.length > 0 || lanes?.some(lane => lane.kindIds !== undefined
        && (lane.health.kind === 'complete' || lane.health.kind === 'partial'));
    return { ...result, kind: readable ? 'partial' : 'failed', ...(lanes === undefined ? {} : { lanes }) };
}
export const TriageReadSourceSessionLinksActionResultV1Schema = defineProtocolUnion([
    TriageReadSourceSessionLinksResultV1Schema,
    defineProtocolObject({ kind: defineProtocolLiteral('entries'), entries: defineProtocolArray(defineProtocolObject({
        entryRef: TriageEntryRefV1Schema, sourceInstanceId: TriageSourceInstanceIdV1Schema.optional(),
        result: TriageReadSourceSessionLinksResultV1Schema,
    }, { policy: 'closed' })) }, { policy: 'closed' }),
]);
export type TriageReadSourceSessionLinksActionResultV1 = ReturnType<typeof TriageReadSourceSessionLinksActionResultV1Schema.parse>;
