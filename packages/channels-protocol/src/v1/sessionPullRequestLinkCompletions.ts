import type { ContributionAdmittedEntry, TargetedContributionPointRef } from '@happier-dev/plugin-sdk/contributions';
import { defineContributionPoint, defineContributionProtocol } from '@happier-dev/plugin-sdk/contributions';
import { defineProtocolLiteral, defineProtocolObject, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';
import { ActionSessionAddressV1Schema } from '@happier-dev/plugin-sdk/sessions';

import { CONVERSATION_CORE_PLUGIN_ID_V1 } from './bounds.js';

export const SESSION_PULL_REQUEST_LINK_COMPLETIONS_CONTRIBUTION_POINT_ID_V1 = 'session-pull-request-link-completions-v1';
const protocolId = 'happier.channels/session-pull-request-link-completions';
const descriptor = defineProtocolObject({}, { policy: 'closed' });

/** An acknowledged explicit link, never an instruction to create or repair one. */
export const SessionPullRequestLinkCompletionInputV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1), session: ActionSessionAddressV1Schema,
}, { policy: 'closed' });
export type SessionPullRequestLinkCompletionInputV1 = ReturnType<typeof SessionPullRequestLinkCompletionInputV1Schema.parse>;

/** Optional presentation cannot change the already acknowledged link outcome. */
export const SessionPullRequestLinkCompletionResultV1Schema = defineProtocolUnion([
    defineProtocolObject({ kind: defineProtocolLiteral('added') }, { policy: 'closed' }),
    defineProtocolObject({ kind: defineProtocolLiteral('present') }, { policy: 'closed' }),
    defineProtocolObject({ kind: defineProtocolLiteral('unavailable') }, { policy: 'closed' }),
]);
export type SessionPullRequestLinkCompletionResultV1 = ReturnType<typeof SessionPullRequestLinkCompletionResultV1Schema.parse>;
export const SessionPullRequestLinkCompletionInputV1JsonSchema = /* @__PURE__ */ (() => SessionPullRequestLinkCompletionInputV1Schema.jsonSchema)();
export const SessionPullRequestLinkCompletionResultV1JsonSchema = /* @__PURE__ */ (() => SessionPullRequestLinkCompletionResultV1Schema.jsonSchema)();

const operations = {
    complete: {
        required: true,
        input: { kind: 'protocolDefined', schema: SessionPullRequestLinkCompletionInputV1Schema },
        resultSchema: SessionPullRequestLinkCompletionResultV1Schema,
        action: { surfaces: ['plugin'], dangerLevel: 'safe' },
    },
} as const;

/** Contributors run through the same admitted Action and caller custody. */
export const SessionPullRequestLinkCompletionsContributionProtocolV1 = defineContributionProtocol({
    id: protocolId, version: 1, descriptor, operations,
});
export const SessionPullRequestLinkCompletionsContributionPointV1 = defineContributionPoint([
    SessionPullRequestLinkCompletionsContributionProtocolV1,
]);

export type SessionPullRequestLinkCompletionContributionV1 = ContributionAdmittedEntry<
    typeof operations, {}, typeof descriptor, typeof SESSION_PULL_REQUEST_LINK_COMPLETIONS_CONTRIBUTION_POINT_ID_V1
>;

/** Equality-qualified target-local discovery, not an executable operation handle. */
export const SESSION_PULL_REQUEST_LINK_COMPLETIONS_CONTRIBUTION_POINT_REF_V1: TargetedContributionPointRef<SessionPullRequestLinkCompletionContributionV1> = Object.freeze({
    targetPluginId: CONVERSATION_CORE_PLUGIN_ID_V1,
    id: SESSION_PULL_REQUEST_LINK_COMPLETIONS_CONTRIBUTION_POINT_ID_V1,
    protocol: Object.freeze({ id: protocolId, version: 1 }),
});
