import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';
import {
    defineProtocolArray,
    defineProtocolLiteral,
    defineProtocolObject,
    defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';

import {
    TRIAGE_ACTION_DRAFT_MEMBERS_V1,
    TriageActionIdV1Schema,
    TriageActionRecordsV1Schema,
    TriageSettingsRevisionV1Schema,
} from '../settings/actions.js';

/**
 * The strict contract of the two action-catalog Actions.
 *
 * A mounted surface holds a Host API with actions and no Settings or storage
 * member, so this is the only transport between the Settings editor a person
 * uses and the one `triage.actions` CAS owner. Nothing here is a second
 * authority: `settings/actions.ts` still mints the action id, validates every
 * bound and closed vocabulary, decides the conflict verdict, and declines to
 * overwrite a stored value this build cannot read.
 *
 * Every member is a reference or a closed vocabulary, exactly as the record is.
 * There is no place on this wire to express a condition, a step, a retry, a
 * variable, a branch or a hook, which is what keeps a composition record from
 * growing into a workflow engine through its transport.
 */

/**
 * Every member below is PROJECTED from the one action grammar in
 * `settings/actions.ts`. These schemas used to restate it, which is exactly how
 * the declared Settings field drifted from the record it declares; a projection
 * cannot drift from its source.
 */
const triageActionId = TriageActionIdV1Schema;
const triageActions = TriageActionRecordsV1Schema;

export const TriageReadActionsInputV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
}, { policy: 'closed' });
export type TriageReadActionsInputV1 = ReturnType<typeof TriageReadActionsInputV1Schema.parse>;
export const TriageReadActionsInputV1JsonSchema: PluginJsonSchema =
    TriageReadActionsInputV1Schema.jsonSchema;

/**
 * `availability` is reported rather than flattened.
 *
 * `absent` means nobody has ever configured the catalog, and the actions it
 * carries are the shipped seed — which is why the headline controls exist with
 * zero writes. `unavailable` means the stored value belongs to a writer this
 * build cannot read, which is a different statement from "you configured no
 * actions", and presenting it as the latter is what would invite a write that
 * destroys it.
 */
const TriageActionsAvailabilityV1Schema = defineProtocolUnion([
    defineProtocolLiteral('absent'),
    defineProtocolLiteral('parsed'),
    defineProtocolLiteral('unavailable'),
]);

export const TriageReadActionsResultV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    availability: TriageActionsAvailabilityV1Schema,
    actions: triageActions,
    /**
     * The revision this catalogue was read at, returned so the editor can state
     * WHICH set its next write means.
     *
     * Without it the only revision a write could name is one read after the
     * person finished editing, which makes the final `set` atomic and notices
     * nothing that changed while the editor was open. It is opaque: the surface
     * carries it back unread.
     */
    revision: TriageSettingsRevisionV1Schema,
}, { policy: 'closed' });
export type TriageReadActionsResultV1 = ReturnType<typeof TriageReadActionsResultV1Schema.parse>;
export const TriageReadActionsResultV1JsonSchema: PluginJsonSchema =
    TriageReadActionsResultV1Schema.jsonSchema;

const TriageActionDraftV1WireSchema = TRIAGE_ACTION_DRAFT_MEMBERS_V1;

/**
 * Explicit create, update, delete and reorder, and nothing else.
 *
 * Rename, disable and reconfigure are all one `update`: they are the same
 * write of the same five answers, and giving each its own command would be
 * three spellings of one mutation that could disagree about what the others
 * leave untouched. A reorder is an exact permutation — nothing is added or
 * dropped through it — because a shorter list would delete actions under the
 * guise of reordering.
 *
 * Every arm carries `expectedRevision`: the catalogue the caller was looking at
 * when it formed the intent. A write against a catalogue that has moved is the
 * same settled `conflict` a losing race produces, and the caller re-reads.
 */
export const TriageAdministerActionInputV1Schema = defineProtocolUnion([
    defineProtocolObject({
        v: defineProtocolLiteral(1),
        kind: defineProtocolLiteral('create'),
        expectedRevision: TriageSettingsRevisionV1Schema,
        ...TriageActionDraftV1WireSchema,
    }, { policy: 'closed' }),
    defineProtocolObject({
        v: defineProtocolLiteral(1),
        kind: defineProtocolLiteral('update'),
        actionId: triageActionId,
        expectedRevision: TriageSettingsRevisionV1Schema,
        ...TriageActionDraftV1WireSchema,
    }, { policy: 'closed' }),
    defineProtocolObject({
        v: defineProtocolLiteral(1),
        kind: defineProtocolLiteral('delete'),
        actionId: triageActionId,
        expectedRevision: TriageSettingsRevisionV1Schema,
    }, { policy: 'closed' }),
    defineProtocolObject({
        v: defineProtocolLiteral(1),
        kind: defineProtocolLiteral('reorder'),
        actionIds: defineProtocolArray(triageActionId),
        expectedRevision: TriageSettingsRevisionV1Schema,
    }, { policy: 'closed' }),
]);
export type TriageAdministerActionInputV1 =
    ReturnType<typeof TriageAdministerActionInputV1Schema.parse>;
export const TriageAdministerActionInputV1JsonSchema: PluginJsonSchema =
    TriageAdministerActionInputV1Schema.jsonSchema;

export const TriageAdministerActionResultV1Schema = defineProtocolObject({
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
        defineProtocolLiteral('unknownAction'),
        defineProtocolLiteral('unreadable'),
        defineProtocolLiteral('rejected'),
    ]),
    reason: defineProtocolUnion([
        defineProtocolLiteral('actionId'),
        defineProtocolLiteral('label'),
        defineProtocolLiteral('enabled'),
        defineProtocolLiteral('appliesTo'),
        defineProtocolLiteral('duplicateSubject'),
        defineProtocolLiteral('profileId'),
        defineProtocolLiteral('workspaceMode'),
        defineProtocolLiteral('target'),
        defineProtocolLiteral('promptInvocationId'),
        defineProtocolLiteral('delivery'),
        defineProtocolLiteral('reorder'),
        defineProtocolLiteral('valueTooLarge'),
    ]).optional(),
    /** The authoritative catalog after an applied write; omitted otherwise. */
    actions: triageActions.optional(),
    /**
     * The revision the applied value now sits at, so the caller's next write
     * names the set it just created rather than the one it replaced. Omitted
     * for every refusal, because nothing moved.
     */
    revision: TriageSettingsRevisionV1Schema.optional(),
}, { policy: 'closed' });
export type TriageAdministerActionResultV1 =
    ReturnType<typeof TriageAdministerActionResultV1Schema.parse>;
export const TriageAdministerActionResultV1JsonSchema: PluginJsonSchema =
    TriageAdministerActionResultV1Schema.jsonSchema;

/** The authoritative configured-action read. */
export const TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1 = 'actions/read-v1';
/** The one explicit create/update/delete/reorder write. */
export const TRIAGE_ADMINISTER_ACTION_ACTION_LOCAL_ID_V1 = 'actions/administer-v1';
