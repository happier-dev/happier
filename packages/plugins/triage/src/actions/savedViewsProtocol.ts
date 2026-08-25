import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';
import {
    defineProtocolArray,
    defineProtocolLiteral,
    defineProtocolObject,
    defineProtocolString,
    defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';
import {
    MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
    TRIAGE_SINGLE_LINE_STRING_PATTERN_V1,
} from '@happier-dev/triage-protocol/v1';

import {
    MAX_TRIAGE_SAVED_VIEW_LABEL_UTF8_BYTES_V1,
} from '../settings/savedViews.js';
import { TriageSettingsRevisionV1Schema } from '../settings/actions.js';
import {
    TriageListFilterSelectionV1Schema,
    TriageSmartPolicyV1Schema,
} from './listEntriesProtocol.js';

/**
 * The strict contract of the two saved-view Actions.
 *
 * A mounted surface holds a Host API with actions and no Settings or storage
 * member, so this is the only transport between the reader choosing a lens and
 * the one `triage.savedViews` CAS owner. Nothing here is a second authority:
 * `savedViews.ts` still mints the view id, validates every bound, decides the
 * conflict verdict and owns the atomic clear of a deleted selection.
 *
 * The lens on this wire is the exact source-neutral facet vocabulary the list
 * Action queries with — the same schema value, not a copy — so a saved lens and
 * a live lens cannot drift into two spellings of one concept.
 */

const triageViewLabel = defineProtocolString({
    minLength: 1,
    maxLength: MAX_TRIAGE_SAVED_VIEW_LABEL_UTF8_BYTES_V1,
    pattern: TRIAGE_SINGLE_LINE_STRING_PATTERN_V1,
});

const triageViewId = defineProtocolString({
    minLength: 1,
    maxLength: MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
    pattern: TRIAGE_SINGLE_LINE_STRING_PATTERN_V1,
});

const TriageSavedViewOrderV1Schema = defineProtocolUnion([
    defineProtocolLiteral('newest'),
    defineProtocolLiteral('oldest'),
    defineProtocolLiteral('smart'),
]);

const TriageSavedViewV1Schema = defineProtocolObject({
    viewId: triageViewId,
    label: triageViewLabel,
    filters: TriageListFilterSelectionV1Schema,
    order: TriageSavedViewOrderV1Schema,
    smartPolicy: TriageSmartPolicyV1Schema,
}, { policy: 'closed' });

export const TriageReadSavedViewsInputV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
}, { policy: 'closed' });
export type TriageReadSavedViewsInputV1 = ReturnType<typeof TriageReadSavedViewsInputV1Schema.parse>;
export const TriageReadSavedViewsInputV1JsonSchema: PluginJsonSchema =
    TriageReadSavedViewsInputV1Schema.jsonSchema;

/**
 * `availability` is reported rather than flattened. `unavailable` means the
 * stored value belongs to a writer this build cannot read, which is a different
 * statement from "you have saved no views" — and presenting it as the latter is
 * what would invite a write that destroys it.
 */
const TriageSavedViewsAvailabilityV1Schema = defineProtocolUnion([
    defineProtocolLiteral('absent'),
    defineProtocolLiteral('parsed'),
    defineProtocolLiteral('unavailable'),
]);

export const TriageReadSavedViewsResultV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    availability: TriageSavedViewsAvailabilityV1Schema,
    views: defineProtocolArray(TriageSavedViewV1Schema),
    selectedViewId: defineProtocolUnion([triageViewId, defineProtocolLiteral(null)]),
    revision: TriageSettingsRevisionV1Schema,
}, { policy: 'closed' });
export type TriageReadSavedViewsResultV1 = ReturnType<typeof TriageReadSavedViewsResultV1Schema.parse>;
export const TriageReadSavedViewsResultV1JsonSchema: PluginJsonSchema =
    TriageReadSavedViewsResultV1Schema.jsonSchema;

const TriageSavedViewDraftV1Schema = {
    label: triageViewLabel,
    filters: TriageListFilterSelectionV1Schema,
    order: TriageSavedViewOrderV1Schema,
    smartPolicy: TriageSmartPolicyV1Schema,
} as const;

/**
 * Explicit CRUD and selection, and nothing else.
 *
 * A temporary route or local lens change is deliberately unrepresentable here:
 * only an explicit save, update, delete or select may rewrite durable user
 * state, so browsing a modified lens can never overwrite the view it started
 * from.
 */
export const TriageAdministerSavedViewInputV1Schema = defineProtocolUnion([
    defineProtocolObject({
        v: defineProtocolLiteral(1),
        kind: defineProtocolLiteral('create'),
        expectedRevision: TriageSettingsRevisionV1Schema,
        ...TriageSavedViewDraftV1Schema,
        select: defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]).optional(),
    }, { policy: 'closed' }),
    defineProtocolObject({
        v: defineProtocolLiteral(1),
        kind: defineProtocolLiteral('update'),
        viewId: triageViewId,
        expectedRevision: TriageSettingsRevisionV1Schema,
        ...TriageSavedViewDraftV1Schema,
    }, { policy: 'closed' }),
    defineProtocolObject({
        v: defineProtocolLiteral(1),
        kind: defineProtocolLiteral('delete'),
        viewId: triageViewId,
        expectedRevision: TriageSettingsRevisionV1Schema,
    }, { policy: 'closed' }),
    defineProtocolObject({
        v: defineProtocolLiteral(1),
        kind: defineProtocolLiteral('select'),
        viewId: defineProtocolUnion([triageViewId, defineProtocolLiteral(null)]),
        expectedRevision: TriageSettingsRevisionV1Schema,
    }, { policy: 'closed' }),
]);
export type TriageAdministerSavedViewInputV1 =
    ReturnType<typeof TriageAdministerSavedViewInputV1Schema.parse>;
export const TriageAdministerSavedViewInputV1JsonSchema: PluginJsonSchema =
    TriageAdministerSavedViewInputV1Schema.jsonSchema;

export const TriageAdministerSavedViewResultV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    /**
     * Every arm is a settled answer, not a thrown failure: `conflict` means
     * another device won and the caller re-reads, `unreadable` means this build
     * declined to overwrite a value it cannot parse, and `rejected` names the
     * bound that refused the write.
     */
    status: defineProtocolUnion([
        defineProtocolLiteral('applied'),
        defineProtocolLiteral('conflict'),
        defineProtocolLiteral('unknownView'),
        defineProtocolLiteral('unreadable'),
        defineProtocolLiteral('rejected'),
    ]),
    reason: defineProtocolUnion([
        defineProtocolLiteral('label'),
        defineProtocolLiteral('duplicateFacetValue'),
        defineProtocolLiteral('filterValue'),
        defineProtocolLiteral('order'),
        defineProtocolLiteral('smartPolicy'),
        defineProtocolLiteral('valueTooLarge'),
    ]).optional(),
    /** The authoritative set after an applied write; omitted otherwise. */
    views: defineProtocolArray(TriageSavedViewV1Schema).optional(),
    selectedViewId: defineProtocolUnion([triageViewId, defineProtocolLiteral(null)]).optional(),
    revision: TriageSettingsRevisionV1Schema.optional(),
}, { policy: 'closed' });
export type TriageAdministerSavedViewResultV1 =
    ReturnType<typeof TriageAdministerSavedViewResultV1Schema.parse>;
export const TriageAdministerSavedViewResultV1JsonSchema: PluginJsonSchema =
    TriageAdministerSavedViewResultV1Schema.jsonSchema;

/** The authoritative saved-view read. */
export const TRIAGE_READ_SAVED_VIEWS_ACTION_LOCAL_ID_V1 = 'views/read-v1';
/** The one explicit create/update/delete/select write. */
export const TRIAGE_ADMINISTER_SAVED_VIEW_ACTION_LOCAL_ID_V1 = 'views/administer-v1';
