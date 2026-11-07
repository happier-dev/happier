import { PluginContributionIdentityV1Schema } from '@happier-dev/plugin-sdk/manifest';
import { defineProtocolLiteral, defineProtocolObject, defineProtocolString, defineProtocolUnion, ScmHostingRepositoryIdentityV1ProtocolSchema, TriageIdentifierV1ProtocolSchema } from '@happier-dev/plugin-sdk/protocol';
import { SessionTargetV1Schema } from '@happier-dev/plugin-sdk/sessions';
import {
    TriageEntryLocatorV1Schema,
    TriageEntryRefV1Schema,
    TriageSourceInstanceIdV1Schema,
    TriageTaskCreateFieldsV1Schema,
    TriageTaskFieldsV1Schema,
    TriageTaskWriteResultV1Schema,
    TriageTaskTransitionFieldValuesV1Schema,
} from '@happier-dev/triage-protocol/v1';
import { TriageListKindIdV1Schema } from './listEntriesProtocol.js';
import { TriageTaskOriginErrorV1Schema } from './taskOriginProtocol.js';

export const TRIAGE_TASKS_LIST_ACTION_LOCAL_ID_V1 = 'tasks/list-v1';
export const TRIAGE_TASKS_CREATE_ACTION_LOCAL_ID_V1 = 'tasks/create-v1';
export const TRIAGE_TASKS_EDIT_ACTION_LOCAL_ID_V1 = 'tasks/edit-v1';
export const TRIAGE_TASKS_TRANSITION_ACTION_LOCAL_ID_V1 = 'tasks/transition-v1';
export const TRIAGE_TASKS_LINK_ACTION_LOCAL_ID_V1 = 'tasks/link-v1';
export const TRIAGE_TASKS_OPEN_CREATE_ACTION_LOCAL_ID_V1 = 'tasks/open-create-v1';
export const TRIAGE_TASKS_CHECK_WRITE_ACTION_LOCAL_ID_V1 = 'tasks/check-write-v1';
export const TriageCheckTaskWriteInputV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1), entryRef: TriageEntryRefV1Schema,
}, { policy: 'closed' });
/** Reviewable draft text, never a provider write or an imported task. */
export const TriageTaskDraftOriginV1Schema = defineProtocolObject({
    sessionId: defineProtocolString({ minLength: 1 }),
    serverId: defineProtocolString({ minLength: 1 }).optional(),
    sessionTitle: defineProtocolString().optional(),
    messageId: defineProtocolString({ minLength: 1 }),
    observedRevision: defineProtocolString({ minLength: 1 }),
    role: defineProtocolUnion([defineProtocolLiteral('user'), defineProtocolLiteral('agent'), defineProtocolLiteral('event'), defineProtocolLiteral('unknown')]),
    quote: defineProtocolString().optional(),
    /** A suggestion only, taken from the Session's accepted checkout. */
    repository: ScmHostingRepositoryIdentityV1ProtocolSchema.optional(),
}, { policy: 'closed' });
export const TriageTaskDraftV1Schema = defineProtocolObject({
    title: defineProtocolString().optional(), body: defineProtocolString().optional(),
    origin: TriageTaskDraftOriginV1Schema.optional(),
    originError: TriageTaskOriginErrorV1Schema.optional(),
    linkSession: SessionTargetV1Schema.optional(),
}, { policy: 'closed' });
export type TriageTaskDraftV1 = ReturnType<typeof TriageTaskDraftV1Schema.parse>;
export const TriageTaskDraftLaunchV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1), kind: defineProtocolLiteral('createTask'), draftId: defineProtocolString(),
}, { policy: 'closed' });

/** Callers name a configured address; only the Account owner supplies its configuration. */
export const TriageCreateTaskActionInputV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    source: PluginContributionIdentityV1Schema,
    sourceInstanceId: TriageSourceInstanceIdV1Schema,
    kindId: TriageListKindIdV1Schema,
    fields: TriageTaskCreateFieldsV1Schema,
    /** An id from this place's taskCapabilities.initialStatuses; absent uses its default. */
    initialStatusId: TriageIdentifierV1ProtocolSchema.optional(),
    /** A separate, optional relationship write after confirmed creation only. */
    linkSession: SessionTargetV1Schema.optional(),
    originError: TriageTaskOriginErrorV1Schema.optional(),
}, { policy: 'closed' });
export type TriageCreateTaskActionInputV1 = ReturnType<typeof TriageCreateTaskActionInputV1Schema.parse>;

/** Provider writes keep their canonical result; the aggregate reports both phases. */
export const TriageCreateTaskActionResultV1Schema = defineProtocolUnion([
    TriageTaskWriteResultV1Schema,
    defineProtocolObject({
        kind: defineProtocolLiteral('createdAndLinkAttempted'),
        creation: TriageTaskWriteResultV1Schema,
        sessionLink: defineProtocolUnion([defineProtocolLiteral('linked'), defineProtocolLiteral('failed'), defineProtocolLiteral('unknown')]).optional(),
        originErrorLink: defineProtocolUnion([defineProtocolLiteral('linked'), defineProtocolLiteral('failed'), defineProtocolLiteral('unknown')]).optional(),
    }, { policy: 'closed' }),
]);
export type TriageCreateTaskActionResultV1 = ReturnType<typeof TriageCreateTaskActionResultV1Schema.parse>;

const entryAddress = {
    v: defineProtocolLiteral(1),
    sourceInstanceId: TriageSourceInstanceIdV1Schema,
    entryRef: TriageEntryRefV1Schema,
    lastKnownLocator: TriageEntryLocatorV1Schema.optional(),
};
export const TriageEditTaskActionInputV1Schema = defineProtocolObject({
    ...entryAddress,
    fields: TriageTaskFieldsV1Schema,
}, { policy: 'closed' });
export type TriageEditTaskActionInputV1 = ReturnType<typeof TriageEditTaskActionInputV1Schema.parse>;

export const TriageTransitionTaskActionInputV1Schema = defineProtocolObject({
    ...entryAddress,
    transitionId: TriageListKindIdV1Schema,
    fieldValues: TriageTaskTransitionFieldValuesV1Schema.optional(),
}, { policy: 'closed' });
export type TriageTransitionTaskActionInputV1 = ReturnType<typeof TriageTransitionTaskActionInputV1Schema.parse>;
