import { z } from 'zod/mini';
export { readOpenedSessionFollowOriginalV1, captureSemanticSessionFollowRuleSourceEvidenceV1,
  readSessionFollowSemanticSourceEventV1, readVerifiedSessionFollowHumanInputOriginalV1, isPotentialSessionFollowHumanInputV1 } from './sessionFollowOriginalV1.js';
export type { SessionFollowOriginalOccurrenceV1, SessionFollowOriginalReadV1 } from './sessionFollowOriginalV1.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { SessionAwarenessPresentationStateV1Schema } from '../awareness/presentationV1.js';
import { matchSessionListFilterV1, type SessionListFilterFactsV1 } from '../listFilter/sessionListFilterV1.js';
import { FollowEventV1Schema, isMessageBackedFollowEventV1, resolveFollowDeliveryV1, type FollowDeliveryDecisionV1, type FollowPolicyV1 } from './sessionFollowPolicyV1.js';
import type { FollowReceiverRefV1 } from './sessionDeliveryMuteV1.js';
import { equalFollowRuleReceiverV1 } from './sessionFollowRuleV1.js';
import type { OpenedSessionFollowRuleV1 } from './actions.js';
export type { OpenedSessionFollowRuleV1 } from './actions.js';
import { SessionMetadataPublisherPreconditionV1Schema } from '../metadata/sessionMetadataSchemasV1.js';
import { SessionFollowSourceMessageV1Schema, SessionFollowSourceRequestsV1Schema, SessionFollowSourceTurnV1Schema } from './sessionFollowSourceOccurrenceV1.js';
import { normalizeSessionFollowDefaultRulesV1, type SessionAutoFollowPreferencesV1, type SessionAutoFollowTriggerV1,
  type SessionFollowDefaultRelationshipsV1 } from './accountFollow.js';

/** Stored inside the original encrypted/plain message, never in an Account change hint. */
export const SESSION_FOLLOW_RULE_EVIDENCE_META_KEY_V1 = 'happierFollowRuleEvidenceV1' as const;
export const SessionFollowRuleSourceEvidenceV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), ownerAccountId: z.string().check(z.minLength(1)), event: FollowEventV1Schema,
  facts: z.strictObject({
    serverId: z.string().check(z.minLength(1)), kind: z.enum(['session', 'run']),
    startedBy: z.optional(z.enum(['you', 'triggers', 'agents', 'other_account', 'non_person'])), attentionRequired: z.optional(z.boolean()),
    status: z.optional(SessionAwarenessPresentationStateV1Schema), source: z.optional(z.enum(['persisted', 'direct'])),
  }),
}));
export type SessionFollowRuleSourceEvidenceV1 = z.infer<typeof SessionFollowRuleSourceEvidenceV1Schema>;
/** Session-key readers are not readers of the source Account's private organization. */
export function projectSessionFollowRuleSharedSourceEvidenceV1(evidence: SessionFollowRuleSourceEvidenceV1): SessionFollowRuleSourceEvidenceV1 {
  const source = evidence.facts;
  return { v: 1, ownerAccountId: evidence.ownerAccountId, event: evidence.event, facts: {
    serverId: source.serverId, kind: source.kind,
    ...(source.startedBy === undefined ? {} : { startedBy: source.startedBy }),
    ...(source.attentionRequired === undefined ? {} : { attentionRequired: source.attentionRequired }),
    ...(source.status === undefined ? {} : { status: source.status }),
    ...(source.source === undefined ? {} : { source: source.source }),
  } };
}
/** The daemon validates this original record through Follow's admitted source-observation owner. */
export const SessionFollowRuleSourceOccurrenceV1Schema = lazyZodSchema(() => {
  const fields = { sourceSessionId: z.string().check(z.minLength(1)), sourcePublisher: SessionMetadataPublisherPreconditionV1Schema };
  return z.union([
    z.strictObject({ ...fields, sourceTurn: SessionFollowSourceTurnV1Schema, evidence: SessionFollowRuleSourceEvidenceV1Schema }),
    z.strictObject({ ...fields, sourceMessage: SessionFollowSourceMessageV1Schema, evidence: SessionFollowRuleSourceEvidenceV1Schema })
      .check(z.refine(value => isMessageBackedFollowEventV1(value.evidence.event), {
        path: ['evidence', 'event'], message: 'Question events require an exact source request',
      })),
    z.strictObject({ ...fields, sourceRequests: SessionFollowSourceRequestsV1Schema,
      requestEvidence: z.array(z.strictObject({ requestId: z.string().check(z.minLength(1)), evidence: z.optional(SessionFollowRuleSourceEvidenceV1Schema) })) }),
  ]);
});
export type SessionFollowRuleSourceOccurrenceV1 = z.infer<typeof SessionFollowRuleSourceOccurrenceV1Schema>;
export type SessionFollowRuleOccurrenceRouteV1 = Readonly<{
  receiver: FollowReceiverRefV1; rules: readonly Readonly<{ ruleId: string; version: number }>[];
  policies: readonly FollowPolicyV1[]; delivery: FollowDeliveryDecisionV1;
  defaultKeys?: readonly SessionAutoFollowTriggerV1[]; defaultPolicies?: readonly FollowPolicyV1[];
}>;
export type SessionFollowRuleOccurrenceEvaluationV1 = Readonly<{ status: 'other_evaluator' }> | Readonly<{
  status: 'evaluated'; routes: readonly SessionFollowRuleOccurrenceRouteV1[]; pendingRuleIds: readonly string[];
  pendingDefaultKeys?: readonly SessionAutoFollowTriggerV1[];
}>;

/** Placement follows original production custody, never current daemon availability. */
export function resolveSessionFollowRuleOccurrenceEvaluatorV1(input: Readonly<{
  accountId: string; ownerAccountId: string; production: 'source' | 'recovery';
}>): 'source' | 'receiver' {
  return input.production === 'source' && input.ownerAccountId === input.accountId ? 'source' : 'receiver';
}

/** One source occurrence × the already-opened Account rules; no lookup, enrollment or delivery side effects. */
export function evaluateSessionFollowRuleOccurrenceV1(input: Readonly<{
  accountId: string; evaluator: 'source' | 'receiver'; sourceSessionId: string; production: 'source' | 'recovery';
  evidence: Pick<SessionFollowRuleSourceEvidenceV1, 'ownerAccountId' | 'event'>;
  /** Read now under the evaluator Account's current authority; never retained on the original. */
  currentFacts: SessionListFilterFactsV1;
  rules: readonly OpenedSessionFollowRuleV1[]; mutedReceivers?: readonly FollowReceiverRefV1[];
  defaults?: Readonly<{ preferences: SessionAutoFollowPreferencesV1; relationships: Partial<Readonly<SessionFollowDefaultRelationshipsV1>>;
    hasPersistentFollow?: boolean }>;
  personalFollowSuppressed?: boolean;
}>): SessionFollowRuleOccurrenceEvaluationV1 {
  if (resolveSessionFollowRuleOccurrenceEvaluatorV1({ accountId: input.accountId,
    ownerAccountId: input.evidence.ownerAccountId, production: input.production }) !== input.evaluator) return { status: 'other_evaluator' };
  const pendingRuleIds: string[] = [];
  const candidates = new Map<string, { receiver: FollowReceiverRefV1; rules: { ruleId: string; version: number }[]; policies: FollowPolicyV1[];
    defaultKeys?: SessionAutoFollowTriggerV1[]; defaultPolicies?: FollowPolicyV1[] }>();
  for (const rule of input.rules) {
    if (!rule.definition.enabled) continue;
    if (rule.receiver.kind === 'account' && input.personalFollowSuppressed) continue;
    if (rule.receiver.kind === 'session' && rule.receiver.sessionId === input.sourceSessionId) continue;
    // The immutable source origin's `you` is relative to its owning Account.
    const facts = input.evidence.ownerAccountId === input.accountId
      ? { ...input.currentFacts, scopeMatches: { ...input.currentFacts.scopeMatches, my_work: true } }
      : { ...input.currentFacts, ...(input.currentFacts.startedBy === 'you' ? { startedBy: 'other_account' as const } : {}) };
    const match = matchSessionListFilterV1(rule.definition.filter, facts, 'daemonRule');
    if (match === 'unavailable') { pendingRuleIds.push(rule.ruleId); continue; }
    if (match !== 'match') continue;
    const key = rule.receiver.kind === 'account' ? 'account' : `session:${rule.receiver.sessionId}`;
    let candidate = candidates.get(key);
    if (!candidate) {
      candidate = { receiver: rule.receiver, rules: [], policies: [] };
      candidates.set(key, candidate);
    }
    candidate.rules.push({ ruleId: rule.ruleId, version: rule.version });
    candidate.policies.push(rule.definition.policy);
  }
  const defaults = input.defaults && !input.personalFollowSuppressed
    ? normalizeSessionFollowDefaultRulesV1({ ...input.defaults, serverId: input.currentFacts.serverId }) : null;
  const pendingDefaultKeys = [...(defaults?.pendingKeys ?? [])];
  for (const rule of defaults?.rules ?? []) {
    const match = matchSessionListFilterV1(rule.definition.filter, input.currentFacts, 'daemonRule');
    if (match === 'unavailable') { pendingDefaultKeys.push(rule.key); continue; }
    if (match !== 'match') continue;
    let candidate = candidates.get('account');
    if (!candidate) { candidate = { receiver: rule.receiver, rules: [], policies: [] }; candidates.set('account', candidate); }
    (candidate.defaultKeys ??= []).push(rule.key);
    (candidate.defaultPolicies ??= []).push(rule.definition.policy);
  }
  const routes: SessionFollowRuleOccurrenceRouteV1[] = [];
  for (const candidate of candidates.values()) {
    const delivery = resolveFollowDeliveryV1({ policies: [...candidate.policies, ...candidate.defaultPolicies ?? []], event: input.evidence.event,
      muted: input.mutedReceivers?.some(receiver => equalFollowRuleReceiverV1(receiver, candidate.receiver)) });
    if (delivery.selected) routes.push({ ...candidate, delivery });
  }
  return { status: 'evaluated', routes, pendingRuleIds, ...(input.defaults ? { pendingDefaultKeys } : {}) };
}
