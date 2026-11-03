import { defineProtocolArray, defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';
import { SessionIdSchema, SessionTargetV1Schema } from '@happier-dev/plugin-sdk/sessions';
import { AutomationIdV1Schema } from '@happier-dev/plugin-sdk/automations';
import { ConversationQualifiedConnectedAccountRefV1ProtocolSchema } from '../provider/connection.js';
import { ConversationBindingIdV1ProtocolSchema, ConversationCollectionRowRevisionV1ProtocolSchema } from '../identity.js';
import type { ConversationBindingV1 } from './targets.js';
import type { ConversationProviderDescriptorV1 } from '../provider/descriptor.js';
import { formatConversationPullRequestUrlV1 } from '../provider/pullRequestUrls.js';
import { ScmHostingProviderKindProtocolSchema } from '@happier-dev/plugin-sdk/scm';

export const SESSION_PULL_REQUEST_BINDING_ACTION_ID_V1 = 'session-pull-request-binding-v1';
const conversationPullRequestFieldsV1 = {
  repository: defineProtocolString({ minLength: 1, pattern: '^[^\\s/]+/[^\\s/]+$' }),
  number: defineProtocolNumber({ integer: true, minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
};
export const ConversationPullRequestV1Schema = defineProtocolObject(conversationPullRequestFieldsV1, { policy: 'closed' });
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
/** Current-head source evidence; unknown or incomplete evidence cannot end a fix sequence. */
export const ConversationPullRequestFixResolutionV1Schema = defineProtocolObject({
  headRevision: defineProtocolString({ minLength: 1 }),
  resolved: defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]),
  incomplete: defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]),
}, { policy: 'closed' });
export const ConversationPullRequestFixResolutionV1JsonSchema = /* @__PURE__ */ (() => ConversationPullRequestFixResolutionV1Schema.jsonSchema)();
export type ConversationPullRequestFixResolutionV1 = ReturnType<typeof ConversationPullRequestFixResolutionV1Schema.parse>;

const conversationPullRequestStateFieldsV1 = {
  state: defineProtocolUnion([defineProtocolLiteral('open'), defineProtocolLiteral('merged'), defineProtocolLiteral('closed'), defineProtocolLiteral('unknown')]),
  observedAt: defineProtocolNumber({ integer: true, minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  fixResolution: ConversationPullRequestFixResolutionV1Schema.optional(),
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
  }, { policy: 'closed' }).optional(),
};
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
    pullRequest: defineProtocolObject({ repositoryId: defineProtocolString({ pattern: '^[1-9][0-9]*$' }),
      number: conversationPullRequestFieldsV1.number }, { policy: 'closed' }).optional(),
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
    states: defineProtocolArray(conversationPullRequestStateFieldsV1.state, { minItems: 1 }),
  }, { policy: 'closed' }),
  defineProtocolObject({ kind: defineProtocolLiteral('removeTrigger'), sessionId: SessionTargetV1Schema, triggerId: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' }),
]);
export type SessionPullRequestBindingInputV1 = ReturnType<typeof SessionPullRequestBindingInputV1Schema.parse>;
export const SessionPullRequestBindingInputV1JsonSchema = /* @__PURE__ */ (() => SessionPullRequestBindingInputV1Schema.jsonSchema)();
export const SessionPullRequestLinkV1Schema = defineProtocolObject({
    provider: ScmHostingProviderKindProtocolSchema,
    ...conversationPullRequestFieldsV1,
    url: defineProtocolString({ minLength: 1 }),
    state: conversationPullRequestStateFieldsV1.state.optional(),
    observedAt: conversationPullRequestStateFieldsV1.observedAt.optional(),
  }, { policy: 'closed' });
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

export const SessionPullRequestBindingResultV1Schema = defineProtocolUnion([
  defineProtocolObject({ kind: defineProtocolLiteral('attached'), bindingId: ConversationBindingIdV1ProtocolSchema }, { policy: 'closed' }),
  defineProtocolObject({
    kind: defineProtocolLiteral('links'),
    ...sessionPullRequestLinksFieldsV1,
  }, { policy: 'closed' }),
  defineProtocolObject({ kind: defineProtocolLiteral('removed') }, { policy: 'closed' }),
  defineProtocolObject({ kind: defineProtocolLiteral('relations'), links: defineProtocolArray(defineProtocolObject({
    sessionId: SessionIdSchema, bindingId: ConversationBindingIdV1ProtocolSchema,
    revision: ConversationCollectionRowRevisionV1ProtocolSchema,
    pullRequest: ConversationPullRequestV1Schema, repositoryId: defineProtocolString({ pattern: '^[1-9][0-9]*$' }),
    linkedAtMs: defineProtocolNumber({ integer: true, minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  }, { policy: 'closed' })) }, { policy: 'closed' }),
]);
export type SessionPullRequestBindingResultV1 = ReturnType<typeof SessionPullRequestBindingResultV1Schema.parse>;
export const SessionPullRequestBindingResultV1JsonSchema = /* @__PURE__ */ (() => SessionPullRequestBindingResultV1Schema.jsonSchema)();
