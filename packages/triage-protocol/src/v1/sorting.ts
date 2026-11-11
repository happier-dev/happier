import {
    defineProtocolLiteral,
    defineProtocolObject,
    defineProtocolUnion,
    defineProtocolUniqueArray,
} from '@happier-dev/plugin-sdk/protocol';

/** The source-owned fields that can be used to order a Triage list page. */
export const TRIAGE_LIST_SORT_FIELDS_V1 = Object.freeze([
    'updated',
    'created',
    'status',
    'repository',
    'due',
] as const);

/** Both directions are explicit so a source can order before it paginates. */
export const TRIAGE_LIST_SORT_DIRECTIONS_V1 = Object.freeze(['asc', 'desc'] as const);

export const TriageListSortFieldV1Schema = defineProtocolUnion(
    TRIAGE_LIST_SORT_FIELDS_V1.map((field) => defineProtocolLiteral(field)),
);
export type TriageListSortFieldV1 = (typeof TRIAGE_LIST_SORT_FIELDS_V1)[number];

export const TriageListSortDirectionV1Schema = defineProtocolUnion(
    TRIAGE_LIST_SORT_DIRECTIONS_V1.map((direction) => defineProtocolLiteral(direction)),
);
export type TriageListSortDirectionV1 = (typeof TRIAGE_LIST_SORT_DIRECTIONS_V1)[number];

/** One closed source order. A source must apply it before returning a page. */
export const TriageListSortV1Schema = defineProtocolObject({
    field: TriageListSortFieldV1Schema,
    direction: TriageListSortDirectionV1Schema,
}, { policy: 'closed' });
export type TriageListSortV1 = ReturnType<typeof TriageListSortV1Schema.parse>;

/** The descriptor capability set; duplicate fields are not meaningful. */
export const TriageListSortFieldsV1Schema = defineProtocolUniqueArray(TriageListSortFieldV1Schema, {
    // A unique subset cannot exceed the closed field vocabulary. The wire
    // allocation owner needs this finite cardinality to size list results.
    maxItems: TRIAGE_LIST_SORT_FIELDS_V1.length,
});
