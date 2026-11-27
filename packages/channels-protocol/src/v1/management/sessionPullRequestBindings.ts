import { defineProtocolArray, defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';
import { SessionIdSchema, SessionTargetV1Schema } from '@happier-dev/plugin-sdk/sessions';
import { AutomationIdV1Schema } from '@happier-dev/plugin-sdk/automations';
import { ConversationQualifiedConnectedAccountRefV1ProtocolSchema } from '../provider/connection.js';
import { ConversationBindingIdV1ProtocolSchema, ConversationCollectionRowRevisionV1ProtocolSchema } from '../identity.js';
import type { ConversationBindingV1 } from './targets.js';
import type { ConversationProviderDescriptorV1 } from '../provider/descriptor.js';
import { SessionPullRequestLinkCompletionFailureV1Schema } from '../sessionPullRequestLinkCompletions.js';
import { formatConversationPullRequestUrlV1 } from '../provider/pullRequestUrls.js';

import {
    ConversationPullRequestV1Fields,
    ConversationPullRequestV1Schema,
    ConversationPullRequestFixResolutionV1Schema,
    ConversationPullRequestStateV1Fields,
    ConversationPullRequestStateV1Schema,
    SessionPullRequestLinkV1Schema,
} from '@happier-dev/plugin-sdk/protocol';

export {
    ConversationPullRequestV1Schema,
    ConversationPullRequestFixResolutionV1Schema,
    ConversationPullRequestStateV1Schema,
    SessionPullRequestLinkV1Schema,
};

export const SESSION_PULL_REQUEST_BINDING_ACTION_ID_V1 = 'session-pull-request-binding-v1';
export const SESSION_PULL_REQUEST_LINKS_ACTION_ID_V1 = 'session-pull-request-links-v1';
export const SESSION_PULL_REQUEST_RELATIONS_ACTION_ID_V1 = 'session-pull-request-relations-v1';
export const SESSION_PULL_REQUEST_NATIVE_RELATIONS_ACTION_ID_V1 = 'session-pull-request-relations-native-v1';
export const ConversationPullRequestV1JsonSchema = /* @__PURE__ */ (() => ConversationPullRequestV1Schema.jsonSchema)();

/** Shared URL ingress for the GitHub provider and the Session link owner. */
export function parseGithubConversationUrlV1(value: string): Readonly<{
  kind: 'githubIssue' | 'githubPullRequest'; repository: string; number: number;
}> | null {
  try {
    const url = new URL(value.trim());
    if (url.origin !== 'https://github.com') return null;
    const match = /^\/([^/]+)\/([^/]+)\/(issues|pull)\/([1-9][0-9]*)\/?$/u.exec(url.pathname);
    if (match === null) return null;
    const number = Number(match[4]);
    if (!Number.isSafeInteger(number)) return null;
    return { kind: match[3] === 'pull' ? 'githubPullRequest' : 'githubIssue',
      repository: `${match[1]}/${match[2]}`, number };
  } catch { return null; }
}
export const ConversationPullRequestFixResolutionV1JsonSchema = /* @__PURE__ */ (() => ConversationPullRequestFixResolutionV1Schema.jsonSchema)();
export type ConversationPullRequestFixResolutionV1 = ReturnType<typeof ConversationPullRequestFixResolutionV1Schema.parse>;

export const ConversationPullRequestStateV1JsonSchema = /* @__PURE__ */ (() => ConversationPullRequestStateV1Schema.jsonSchema)();
export const ConversationScopedPullRequestTriggerV1Schema = defineProtocolObject({
  sessionId: SessionIdSchema,
  triggerId: defineProtocolString({ minLength: 1 }),
  triggerRevision: defineProtocolNumber({ integer: true, minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  triggerKind: defineProtocolUnion([defineProtocolLiteral('prComment'), defineProtocolLiteral('ciFailed')]),
  principalPolicy: defineProtocolLiteral('repositoryWriters'),
  pullRequest: ConversationPullRequestV1Schema,
}, { policy: 'closed' });
export type ConversationScopedPullRequestTriggerV1 = ReturnType<typeof ConversationScopedPullRequestTriggerV1Schema.parse>;
export const ConversationScopedPullRequestTriggerV1JsonSchema = /* @__PURE__ */ (() => ConversationScopedPullRequestTriggerV1Schema.jsonSchema)();
const sessionPullRequestBulkAttachFieldsV1 = {
  kind: defineProtocolLiteral('attach'), sessionId: SessionTargetV1Schema,
  credentialRef: ConversationQualifiedConnectedAccountRefV1ProtocolSchema.nullable().optional(),
  expectedRepositoryId: defineProtocolString({ pattern: '^[1-9][0-9]*$' }).optional(),
};
const sessionPullRequestAttachFieldsV1 = {
  ...sessionPullRequestBulkAttachFieldsV1,
  target: defineProtocolObject({
      automationId: AutomationIdV1Schema, triggerId: defineProtocolString({ minLength: 1 }),
      triggerRevision: defineProtocolNumber({ integer: true, minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
      triggerKind: defineProtocolUnion([defineProtocolLiteral('prComment'), defineProtocolLiteral('ciFailed')]),
      origin: defineProtocolLiteral('automatic').optional(),
  }, { policy: 'closed' }).optional(),
};
const sessionPullRequestRelationFieldsV1 = {
  kind: defineProtocolLiteral('readRelations'),
  credentialRef: ConversationQualifiedConnectedAccountRefV1ProtocolSchema.nullable(),
};
const exactPullRequestV1 = defineProtocolObject({
  repositoryId: defineProtocolString({ pattern: '^[1-9][0-9]*$' }),
  number: ConversationPullRequestV1Fields.number,
}, { policy: 'closed' });
export const SessionPullRequestRelationsInputV1Schema = defineProtocolUnion([
  defineProtocolObject({ ...sessionPullRequestRelationFieldsV1, pullRequest: exactPullRequestV1 }, { policy: 'closed' }),
  defineProtocolObject({ ...sessionPullRequestRelationFieldsV1,
    sessionIds: defineProtocolArray(SessionIdSchema, { minItems: 1 }),
  }, { policy: 'closed' }),
]);
export type SessionPullRequestRelationsInputV1 = ReturnType<typeof SessionPullRequestRelationsInputV1Schema.parse>;
export const SessionPullRequestBindingInputV1Schema = defineProtocolUnion([
  defineProtocolObject({
    ...sessionPullRequestAttachFieldsV1, pullRequest: ConversationPullRequestV1Schema,
  }, { policy: 'closed' }),
  defineProtocolObject({
    ...sessionPullRequestAttachFieldsV1, pullRequestUrl: defineProtocolString({ minLength: 1 }),
  }, { policy: 'closed' }),
  defineProtocolObject({
    ...sessionPullRequestBulkAttachFieldsV1, pullRequests: defineProtocolArray(ConversationPullRequestV1Schema, { minItems: 1 }),
  }, { policy: 'closed' }),
  defineProtocolObject({
    ...sessionPullRequestBulkAttachFieldsV1, pullRequestUrls: defineProtocolArray(defineProtocolString({ minLength: 1 }), { minItems: 1 }),
  }, { policy: 'closed' }),
  defineProtocolObject({ kind: defineProtocolLiteral('list'), sessionId: SessionTargetV1Schema }, { policy: 'closed' }),
  defineProtocolObject({ kind: defineProtocolLiteral('readRelations'),
    credentialRef: ConversationQualifiedConnectedAccountRefV1ProtocolSchema.nullable(), sessionId: SessionTargetV1Schema.optional(),
    pullRequest: exactPullRequestV1.optional(),
  }, { policy: 'closed' }),
  defineProtocolObject({ kind: defineProtocolLiteral('unlink'), sessionId: SessionTargetV1Schema,
    bindingId: ConversationBindingIdV1ProtocolSchema,
    expectedRevision: ConversationCollectionRowRevisionV1ProtocolSchema,
  }, { policy: 'closed' }),
  defineProtocolObject({ kind: defineProtocolLiteral('unlink'), sessionId: SessionTargetV1Schema,
    bindings: defineProtocolArray(defineProtocolObject({
      bindingId: ConversationBindingIdV1ProtocolSchema,
      expectedRevision: ConversationCollectionRowRevisionV1ProtocolSchema,
    }, { policy: 'closed' }), { minItems: 1 }),
  }, { policy: 'closed' }),
  defineProtocolObject({ kind: defineProtocolLiteral('unlink'), sessionId: SessionTargetV1Schema,
    states: defineProtocolArray(ConversationPullRequestStateV1Fields.state, { minItems: 1 }),
  }, { policy: 'closed' }),
  defineProtocolObject({ kind: defineProtocolLiteral('removeTrigger'), sessionId: SessionTargetV1Schema, triggerId: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' }),
  defineProtocolObject({ kind: defineProtocolLiteral('removeTrigger'), sessionId: SessionTargetV1Schema,
    automationId: AutomationIdV1Schema, triggerId: defineProtocolString({ minLength: 1 }).optional(),
  }, { policy: 'closed' }),
]);
export type SessionPullRequestBindingInputV1 = ReturnType<typeof SessionPullRequestBindingInputV1Schema.parse>;
export const SessionPullRequestBindingInputV1JsonSchema = /* @__PURE__ */ (() => SessionPullRequestBindingInputV1Schema.jsonSchema)();
export const SessionPullRequestLinkV1JsonSchema = /* @__PURE__ */ (() => SessionPullRequestLinkV1Schema.jsonSchema)();
const sessionPullRequestLinksFieldsV1 = {
  sessionId: SessionIdSchema,
  pullRequestLinks: defineProtocolArray(SessionPullRequestLinkV1Schema),
};
export const SessionPullRequestLinksV1Schema = defineProtocolObject(sessionPullRequestLinksFieldsV1, { policy: 'closed' });
export type SessionPullRequestLinksV1 = ReturnType<typeof SessionPullRequestLinksV1Schema.parse>;
export const SessionPullRequestLinksV1JsonSchema = /* @__PURE__ */ (() => SessionPullRequestLinksV1Schema.jsonSchema)();

/** Canonical distinct/freshness projection for both retained bindings and public Watch metadata. */
export function resolveDistinctPullRequestLinksV1(input: readonly SessionPullRequestLinksV1['pullRequestLinks'][number][]): SessionPullRequestLinksV1['pullRequestLinks'] {
  const links: Array<SessionPullRequestLinksV1['pullRequestLinks'][number]> = [];
  const positions = new Map<string, number>();
  for (const link of input) {
    const key = JSON.stringify([link.provider, link.repository, link.number]);
    const position = positions.get(key);
    if (position === undefined) {
      positions.set(key, links.length);
      links.push({ ...link });
    } else if (link.state !== undefined && link.observedAt !== undefined && link.observedAt > (links[position]?.observedAt ?? -1)) {
      links[position] = { ...links[position]!, state: link.state, observedAt: link.observedAt };
    }
  }
  return links;
}

/** Opened PR links are a projection of retained bindings, not trigger enablement. */
export function resolveSessionPullRequestLinksV1(bindings: readonly ConversationBindingV1[], provider: NonNullable<ConversationProviderDescriptorV1['pullRequests']>): SessionPullRequestLinksV1[] {
  type PullRequestLink = SessionPullRequestLinksV1['pullRequestLinks'][number];
  const linksBySession = new Map<string, PullRequestLink[]>();
  for (const binding of [...bindings].sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))) {
    if (binding.deletionState !== 'none'
      || (binding.target.kind !== 'session' && binding.target.kind !== 'automation')) continue;
    const sessionId = binding.target.kind === 'session' ? binding.target.sessionId : binding.target.scopedTrigger?.sessionId;
    const pullRequest = binding.target.kind === 'session' ? binding.target.pullRequestLink : binding.target.scopedTrigger?.pullRequest;
    if (sessionId === undefined || pullRequest === undefined) continue;
    let links = linksBySession.get(sessionId);
    if (links === undefined) {
      links = [];
      linksBySession.set(sessionId, links);
    }
    const observation = binding.endpoint.kind === 'githubPullRequest'
      && binding.endpoint.pullRequest?.repository === pullRequest.repository
      && binding.endpoint.pullRequest?.number === pullRequest.number ? binding.endpoint.pullRequestState : undefined;
    links.push({ provider: provider.repositoryKind, ...pullRequest, url: formatConversationPullRequestUrlV1(provider, pullRequest),
      ...(observation === undefined ? {} : { state: observation.state, observedAt: observation.observedAt }) });
  }
  return [...linksBySession].map(([sessionId, pullRequestLinks]) => ({ sessionId, pullRequestLinks: resolveDistinctPullRequestLinksV1(pullRequestLinks) }));
}

export const SessionPullRequestLinksInputV1Schema = defineProtocolObject({
  sessionId: SessionIdSchema,
}, { policy: 'closed' });
const completionFailures = defineProtocolArray(SessionPullRequestLinkCompletionFailureV1Schema).optional();
export const SessionPullRequestLinksResultV1Schema = defineProtocolObject({
  kind: defineProtocolLiteral('links'), completionFailures,
  ...sessionPullRequestLinksFieldsV1,
}, { policy: 'closed' });

export const SessionPullRequestBindingResultV1Schema = defineProtocolUnion([
  defineProtocolObject({ kind: defineProtocolLiteral('attached'), bindingId: ConversationBindingIdV1ProtocolSchema, completionFailures }, { policy: 'closed' }),
  SessionPullRequestLinksResultV1Schema,
  defineProtocolObject({ kind: defineProtocolLiteral('removed') }, { policy: 'closed' }),
  defineProtocolObject({ kind: defineProtocolLiteral('relations'), links: defineProtocolArray(defineProtocolObject({
    sessionId: SessionIdSchema, bindingId: ConversationBindingIdV1ProtocolSchema,
    revision: ConversationCollectionRowRevisionV1ProtocolSchema,
    pullRequest: ConversationPullRequestV1Schema, repositoryId: defineProtocolString({ pattern: '^[1-9][0-9]*$' }),
    linkedAtMs: defineProtocolNumber({ integer: true, minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    url: defineProtocolString({ minLength: 1 }).optional(),
  }, { policy: 'closed' })), failures: defineProtocolArray(defineProtocolObject({
    sessionId: SessionIdSchema, code: defineProtocolString({ minLength: 1 }),
    requestId: defineProtocolString({ minLength: 1 }).optional(),
  }, { policy: 'closed' })).optional() }, { policy: 'closed' }),
]);
export type SessionPullRequestBindingResultV1 = ReturnType<typeof SessionPullRequestBindingResultV1Schema.parse>;
export const SessionPullRequestBindingResultV1JsonSchema = /* @__PURE__ */ (() => SessionPullRequestBindingResultV1Schema.jsonSchema)();
