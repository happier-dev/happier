import { defineProtocolLiteral, defineProtocolObject, defineProtocolString, defineProtocolUnion, ScmHostingRepositoryIdentityV1ProtocolSchema } from '@happier-dev/plugin-sdk/protocol';
import { ActionSessionAddressV1Schema, SessionAcceptedWorkspaceV1Schema } from '@happier-dev/plugin-sdk/sessions';
import { TriageLocationV1ProtocolSchema } from './identity.js';

const selector = defineProtocolString({ minLength: 1, pattern: '^[^\\u0000]+$' });

/** Proven workflow selectors, never hosted run or job identifiers. */
export const TriagePullRequestLocalCauseV1Schema = defineProtocolObject({
    repository: ScmHostingRepositoryIdentityV1ProtocolSchema,
    workflowPath: selector.optional(),
    sourceHeadSha: selector.optional(),
}, { policy: 'closed' });
export type TriagePullRequestLocalCauseV1 = ReturnType<typeof TriagePullRequestLocalCauseV1Schema.parse>;

/** The selected source opens its own form; opening never admits execution. */
export const TriagePullRequestLocalFormInputV1Schema = defineProtocolObject({
    operation: defineProtocolObject({
        kind: defineProtocolLiteral('openPullRequest'),
        session: ActionSessionAddressV1Schema,
        acceptedWorkspace: SessionAcceptedWorkspaceV1Schema,
        pullRequestUrl: TriageLocationV1ProtocolSchema,
        cause: TriagePullRequestLocalCauseV1Schema.optional(),
    }, { policy: 'closed' }),
}, { policy: 'closed' });
export type TriagePullRequestLocalFormInputV1 = ReturnType<typeof TriagePullRequestLocalFormInputV1Schema.parse>;

export const TriagePullRequestLocalFormResultV1Schema = defineProtocolUnion([
    defineProtocolObject({ kind: defineProtocolLiteral('opened'), mountId: selector }, { policy: 'closed' }),
    defineProtocolObject({ kind: defineProtocolLiteral('unavailable') }, { policy: 'closed' }),
]);
export type TriagePullRequestLocalFormResultV1 = ReturnType<typeof TriagePullRequestLocalFormResultV1Schema.parse>;
