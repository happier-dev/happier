import { defineProtocolArray, defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';
import { SessionIdSchema } from '@happier-dev/plugin-sdk/sessions';
import { AutomationIdV1Schema } from '@happier-dev/plugin-sdk/automations';
import { ConversationBindingIdV1ProtocolSchema } from '../identity.js';
import type { ConversationBindingV1 } from './targets.js';

export const SESSION_PULL_REQUEST_BINDING_ACTION_ID_V1 = 'session-pull-request-binding-v1';
const conversationPullRequestFieldsV1 = {
  repository: defineProtocolString({ minLength: 1, pattern: '^[^\\s/]+/[^\\s/]+$' }),
  number: defineProtocolNumber({ integer: true, minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
};
export const ConversationPullRequestV1Schema = defineProtocolObject(conversationPullRequestFieldsV1, { policy: 'closed' });
export const ConversationPullRequestV1JsonSchema = /* @__PURE__ */ (() => ConversationPullRequestV1Schema.jsonSchema)();
const conversationPullRequestStateFieldsV1 = {
  state: defineProtocolUnion([defineProtocolLiteral('open'), defineProtocolLiteral('merged'), defineProtocolLiteral('closed'), defineProtocolLiteral('unknown')]),
  observedAt: defineProtocolNumber({ integer: true, minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
};
export const ConversationPullRequestStateV1Schema = defineProtocolObject(conversationPullRequestStateFieldsV1, { policy: 'closed' });
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
export const SessionPullRequestBindingInputV1Schema = defineProtocolUnion([
  defineProtocolObject({
    kind: defineProtocolLiteral('attach'), sessionId: SessionIdSchema, pullRequest: ConversationPullRequestV1Schema,
    target: defineProtocolObject({
      automationId: AutomationIdV1Schema, triggerId: defineProtocolString({ minLength: 1 }),
      triggerRevision: defineProtocolNumber({ integer: true, minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
      triggerKind: defineProtocolUnion([defineProtocolLiteral('prComment'), defineProtocolLiteral('ciFailed')]),
    }, { policy: 'closed' }).optional(),
  }, { policy: 'closed' }),
  defineProtocolObject({ kind: defineProtocolLiteral('list'), sessionId: SessionIdSchema }, { policy: 'closed' }),
  defineProtocolObject({ kind: defineProtocolLiteral('removeTrigger'), sessionId: SessionIdSchema, triggerId: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' }),
]);
export type SessionPullRequestBindingInputV1 = ReturnType<typeof SessionPullRequestBindingInputV1Schema.parse>;
export const SessionPullRequestBindingInputV1JsonSchema = /* @__PURE__ */ (() => SessionPullRequestBindingInputV1Schema.jsonSchema)();
const sessionPullRequestLinksFieldsV1 = {
  sessionId: SessionIdSchema,
  pullRequestLinks: defineProtocolArray(defineProtocolObject({
    provider: defineProtocolLiteral('github'),
    ...conversationPullRequestFieldsV1,
    url: defineProtocolString({ minLength: 1 }),
    state: conversationPullRequestStateFieldsV1.state.optional(),
    observedAt: conversationPullRequestStateFieldsV1.observedAt.optional(),
  }, { policy: 'closed' })),
};
export const SessionPullRequestLinksV1Schema = defineProtocolObject(sessionPullRequestLinksFieldsV1, { policy: 'closed' });
export type SessionPullRequestLinksV1 = ReturnType<typeof SessionPullRequestLinksV1Schema.parse>;
export const SessionPullRequestLinksV1JsonSchema = /* @__PURE__ */ (() => SessionPullRequestLinksV1Schema.jsonSchema)();

/** Opened PR links are a projection of retained bindings, not trigger enablement. */
export function resolveSessionPullRequestLinksV1(bindings: readonly ConversationBindingV1[]): SessionPullRequestLinksV1[] {
  type PullRequestLink = SessionPullRequestLinksV1['pullRequestLinks'][number];
  const linksBySession = new Map<string, PullRequestLink[]>();
  const seen = new Map<string, Map<string, number>>();
  for (const binding of [...bindings].sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))) {
    if (binding.deletionState !== 'none' || binding.target.kind === 'threadRouter') continue;
    const sessionId = binding.target.kind === 'session' ? binding.target.sessionId : binding.target.scopedTrigger?.sessionId;
    const pullRequest = binding.target.kind === 'session' ? binding.target.pullRequestLink : binding.target.scopedTrigger?.pullRequest;
    if (sessionId === undefined || pullRequest === undefined) continue;
    let links = linksBySession.get(sessionId);
    if (links === undefined) {
      links = [];
      linksBySession.set(sessionId, links);
      seen.set(sessionId, new Map());
    }
    const key = JSON.stringify([pullRequest.repository, pullRequest.number]);
    const distinct = seen.get(sessionId)!;
    const observation = binding.endpoint.kind === 'githubPullRequest'
      && binding.endpoint.pullRequest?.repository === pullRequest.repository
      && binding.endpoint.pullRequest?.number === pullRequest.number ? binding.endpoint.pullRequestState : undefined;
    const existingIndex = distinct.get(key);
    if (existingIndex !== undefined) {
      if (observation !== undefined && observation.observedAt > (links[existingIndex]?.observedAt ?? -1)) {
        links[existingIndex] = { ...links[existingIndex]!, ...observation };
      }
      continue;
    }
    distinct.set(key, links.length);
    const repositoryPath = pullRequest.repository.split('/').map(encodeURIComponent).join('/');
    links.push({ provider: 'github', ...pullRequest, url: `https://github.com/${repositoryPath}/pull/${pullRequest.number}`,
      ...(observation === undefined ? {} : observation) });
  }
  return [...linksBySession].map(([sessionId, pullRequestLinks]) => ({ sessionId, pullRequestLinks }));
}

export const SessionPullRequestBindingResultV1Schema = defineProtocolUnion([
  defineProtocolObject({ kind: defineProtocolLiteral('attached'), bindingId: ConversationBindingIdV1ProtocolSchema }, { policy: 'closed' }),
  defineProtocolObject({
    kind: defineProtocolLiteral('links'),
    ...sessionPullRequestLinksFieldsV1,
  }, { policy: 'closed' }),
  defineProtocolObject({ kind: defineProtocolLiteral('removed') }, { policy: 'closed' }),
]);
export type SessionPullRequestBindingResultV1 = ReturnType<typeof SessionPullRequestBindingResultV1Schema.parse>;
export const SessionPullRequestBindingResultV1JsonSchema = /* @__PURE__ */ (() => SessionPullRequestBindingResultV1Schema.jsonSchema)();
