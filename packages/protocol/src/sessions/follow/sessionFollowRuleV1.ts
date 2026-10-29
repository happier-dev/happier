import { z } from 'zod/mini';

import { lazyZodSchema } from '../../lazyZodSchema.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { SessionIdSchema } from '../idsV1.js';
import { isAccountScopedBlobCiphertextForKind } from '../../crypto/accountScopedCipherEnvelope.js';
import { SessionListFilterDaemonRuleV1Schema } from '../listFilter/sessionListFilterV1.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { FollowPolicyV1Schema } from './sessionFollowPolicyV1.js';
import { FollowReceiverRefV1Schema, type FollowReceiverRefV1 } from './sessionDeliveryMuteV1.js';
import { SessionFollowFrontierV1Schema } from './sessionFollowFrontierV1.js';
import { SessionFollowPublisherGenerationV1Schema, SessionFollowSourceMessageV1Schema, SessionFollowSourceRequestsV1Schema, SessionFollowSourceTurnV1Schema, SessionFollowStalledOccurrenceV1Schema } from './sessionFollowSourceOccurrenceV1.js';
import { SessionFollowSelectedDeliveryV1Schema } from './sessionFollowSelectedDeliveryV1.js';
import { ExecutionRunFollowOriginalV1Schema, WorkflowRunFollowOriginalV1Schema } from './sessionFollowInputV1.js';
import { DiscussionMessageRefV1Schema } from '../../discussions/messageRefs.js';

export const SESSION_FOLLOW_RULES_ROUTE_V1 = '/v2/account/session-follow-rules' as const;
export const SESSION_FOLLOW_RULE_ACCOUNT_PREFIX_V1 = '@happier/account/session-follow-rules/v1/' as const;
export const SESSION_FOLLOW_RULE_CIPHER_KIND_V1 = 'account_session_follow_rule' as const;
export const SessionFollowRuleIdV1Schema = lazyZodSchema(() => z.string().check(z.minLength(1)));
const version = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)));
export const SessionFollowRuleWitnessV1Schema = lazyZodSchema(() => z.strictObject({
  ruleId: SessionFollowRuleIdV1Schema, ruleVersion: version,
}));
export type SessionFollowRuleWitnessV1 = z.infer<typeof SessionFollowRuleWitnessV1Schema>;
export const SESSION_FOLLOW_PERSONAL_PROGRESS_ROUTE_V1 = `${SESSION_FOLLOW_RULES_ROUTE_V1}/personal-progress` as const;
/** Private settlement by the source executor or the authenticated person receiver. */
export const SessionFollowPersonalProgressRequestV1Schema = lazyZodSchema(() => {
  const fields = {
    sourceSessionId: asProtocolZod(SessionIdSchema), expectedSourcePublisherGeneration: SessionFollowPublisherGenerationV1Schema,
    machineId: z.string().check(z.minLength(1)), installationId: z.string().check(z.trim(), z.minLength(1)),
  };
  const messageRules = z.array(SessionFollowRuleWitnessV1Schema).check(z.refine(rules => new Set(rules.map(rule => rule.ruleId)).size === rules.length));
  const requestRules = z.array(z.strictObject({ ruleId: SessionFollowRuleIdV1Schema, ruleVersion: version,
    requestIds: z.array(z.string().check(z.minLength(1))).check(z.minLength(1), z.refine(ids => new Set(ids).size === ids.length)),
  })).check(z.refine(rules => new Set(rules.map(rule => rule.ruleId)).size === rules.length));
  const receiver = { evaluation: z.literal('receiver'), production: z.enum(['source', 'recovery']),
    sourceSessionId: asProtocolZod(SessionIdSchema) };
  return z.union([
    // Private daemon admission. This records selected interest, never accepted
    // provider consumption; rule identities stay at this Account boundary.
    z.strictObject({ kind: z.literal('session_stalled'), sourceSessionId: asProtocolZod(SessionIdSchema),
      destinationSessionId: asProtocolZod(SessionIdSchema), presence: SessionFollowStalledOccurrenceV1Schema,
      rules: z.array(z.strictObject({ ruleId: SessionFollowRuleIdV1Schema, ruleVersion: version,
        selectedDelivery: SessionFollowSelectedDeliveryV1Schema })).check(z.minLength(1),
        z.refine(rules => new Set(rules.map(rule => rule.ruleId)).size === rules.length)) }),
    z.strictObject({ ...receiver, rules: messageRules.check(z.minLength(1)), sourceMessage: SessionFollowSourceMessageV1Schema,
      sourceRequests: z.optional(z.never()) }),
    z.strictObject({ ...receiver, rules: messageRules.check(z.minLength(1)), sourceTurn: SessionFollowSourceTurnV1Schema,
      terminalSourceMessage: SessionFollowSourceMessageV1Schema }),
    z.strictObject({ ...receiver, rules: requestRules.check(z.minLength(1)), sourceRequests: SessionFollowSourceRequestsV1Schema,
      sourceMessage: z.optional(z.never()) }),
    z.strictObject({ discussion: z.strictObject({ original: DiscussionMessageRefV1Schema,
      seq: z.number().check(z.int(), z.positive()) }) }),
    z.strictObject({ original: z.union([ExecutionRunFollowOriginalV1Schema, WorkflowRunFollowOriginalV1Schema]) }),
    z.strictObject({ ...fields, rules: messageRules, sourceTurn: SessionFollowSourceTurnV1Schema,
      terminalSourceMessage: SessionFollowSourceMessageV1Schema }),
    z.strictObject({ ...fields, rules: messageRules, sourceMessage: SessionFollowSourceMessageV1Schema, sourceRequests: z.optional(z.never()) }),
    z.strictObject({ ...fields, rules: requestRules, sourceRequests: SessionFollowSourceRequestsV1Schema, sourceMessage: z.optional(z.never()) }),
  ]);
});
export type SessionFollowPersonalProgressRequestV1 = z.infer<typeof SessionFollowPersonalProgressRequestV1Schema>;
export const SessionFollowPersonalProgressResponseV1Schema = lazyZodSchema(() => z.strictObject({
  accepted: z.boolean(), alreadyRepresented: z.boolean(),
  reason: z.optional(z.enum(['other_evaluator', 'recovery_unverified'])),
}).check(z.refine(value => (value.accepted || !value.alreadyRepresented) && (!value.reason || !value.accepted))));
export type SessionFollowPersonalProgressResponseV1 = z.infer<typeof SessionFollowPersonalProgressResponseV1Schema>;
/** Server-owned start of a route, independent of authoring edits and accepted progress. */
export const SessionFollowRuleInceptionV1Schema = lazyZodSchema(() => z.strictObject({
  createdAt: version, accountChangeCursor: z.optional(version),
}));

/** Private authoring definition; matching and delivery stay at their canonical policy owners. */
export const SessionFollowRuleDefinitionV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), enabled: z.boolean(), filter: SessionListFilterDaemonRuleV1Schema, policy: FollowPolicyV1Schema,
}));
export type SessionFollowRuleDefinitionV1 = z.infer<typeof SessionFollowRuleDefinitionV1Schema>;
export const SessionFollowRuleDefinitionStoredReadV1Schema = createStoredReadSchema(SessionFollowRuleDefinitionV1Schema);
export const SessionFollowRuleContentV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('plain'), v: SessionFollowRuleDefinitionV1Schema }),
  z.strictObject({ t: z.literal('encrypted'), c: z.string().check(z.minLength(1)) }),
]));
export type SessionFollowRuleContentV1 = z.infer<typeof SessionFollowRuleContentV1Schema>;
export const SessionFollowRuleContentStoredReadV1Schema = createStoredReadSchema(SessionFollowRuleContentV1Schema);
const ruleSourcesSchema = lazyZodSchema(() => z.array(z.strictObject({
  sourceSessionId: asProtocolZod(SessionIdSchema), delivered: SessionFollowFrontierV1Schema,
  /** Daemon-selected pending presence; not a cursor, filter or enrollment. */
  stalled: z.optional(z.strictObject({ ruleVersion: version, presence: SessionFollowStalledOccurrenceV1Schema,
    effectiveDelivery: SessionFollowSelectedDeliveryV1Schema })),
})).check(z.superRefine((sources, context) => {
  const seen = new Set<string>();
  for (const [index, source] of sources.entries()) {
    if (seen.has(source.sourceSessionId)) context.addIssue({ code: 'custom', path: [index, 'sourceSessionId'], message: 'Source identity must be unique' });
    seen.add(source.sourceSessionId);
  }
})));
/** Physical row grammar: content-free receiver identity plus one Account-mode definition. */
export const SessionFollowRuleStoredRowV1Schema = lazyZodSchema(() => z.strictObject({
  version, receiver: FollowReceiverRefV1Schema, content: SessionFollowRuleContentStoredReadV1Schema, sources: z.optional(ruleSourcesSchema),
  inception: z.optional(SessionFollowRuleInceptionV1Schema),
}));
export type SessionFollowRuleStoredRowV1 = z.infer<typeof SessionFollowRuleStoredRowV1Schema>;
export const SessionFollowRuleV1Schema = lazyZodSchema(() => z.strictObject({
  ruleId: SessionFollowRuleIdV1Schema, receiver: FollowReceiverRefV1Schema, content: SessionFollowRuleContentStoredReadV1Schema, version,
  sources: z.optional(ruleSourcesSchema),
  inception: z.optional(SessionFollowRuleInceptionV1Schema),
}));
export type SessionFollowRuleV1 = z.infer<typeof SessionFollowRuleV1Schema>;
export const SessionFollowRuleSourceRangesV1Schema = lazyZodSchema(() => z.strictObject({
  status: z.enum(['available', 'unavailable']), sources: z.array(z.strictObject({
    sourceSessionId: asProtocolZod(SessionIdSchema), delivered: SessionFollowFrontierV1Schema, throughSeq: version,
  })),
}));
/** Source discovery is requested only by the admitted destination's recovery reader. */
export const ListSessionFollowRulesRequestV1Schema = lazyZodSchema(() => z.strictObject({
  destinationSessionId: z.optional(asProtocolZod(SessionIdSchema)),
  sourceSessionId: z.optional(asProtocolZod(SessionIdSchema)),
}).check(z.refine(value => value.sourceSessionId === undefined || value.destinationSessionId !== undefined)));
export const ListSessionFollowRulesResponseV1Schema = lazyZodSchema(() => z.strictObject({ rules: z.array(SessionFollowRuleV1Schema),
  sourceRanges: z.optional(SessionFollowRuleSourceRangesV1Schema),
}));
export type ListSessionFollowRulesResponseV1 = z.infer<typeof ListSessionFollowRulesResponseV1Schema>;
export const GetSessionFollowRuleResponseV1Schema = lazyZodSchema(() => z.strictObject({ rule: z.nullable(SessionFollowRuleV1Schema) }));
export type GetSessionFollowRuleResponseV1 = z.infer<typeof GetSessionFollowRuleResponseV1Schema>;
export const SetSessionFollowRuleRequestV1Schema = lazyZodSchema(() => z.strictObject({
  receiver: FollowReceiverRefV1Schema, content: SessionFollowRuleContentV1Schema, expectedVersion: z.union([version, z.literal(-1)]),
}));
export type SetSessionFollowRuleRequestV1 = z.infer<typeof SetSessionFollowRuleRequestV1Schema>;
export const SetSessionFollowRuleResponseV1Schema = lazyZodSchema(() => z.strictObject({ rule: SessionFollowRuleV1Schema }));
export type SetSessionFollowRuleResponseV1 = z.infer<typeof SetSessionFollowRuleResponseV1Schema>;
export const RemoveSessionFollowRuleRequestV1Schema = lazyZodSchema(() => z.strictObject({ receiver: FollowReceiverRefV1Schema, expectedVersion: version }));
export type RemoveSessionFollowRuleRequestV1 = z.infer<typeof RemoveSessionFollowRuleRequestV1Schema>;
export const RemoveSessionFollowRuleResponseV1Schema = lazyZodSchema(() => z.strictObject({ changed: z.boolean(), version }));
export type RemoveSessionFollowRuleResponseV1 = z.infer<typeof RemoveSessionFollowRuleResponseV1Schema>;
export const SessionFollowRuleErrorResponseV1Schema = lazyZodSchema(() => z.strictObject({ error: z.enum([
  'invalid_parameters', 'account_inactive', 'account_inconsistent', 'account_mode_mismatch', 'invalid_stored_content',
  'version_conflict', 'session_not_found', 'session_archived', 'credential_scope_denied',
  'feature_unavailable',
]) }));
export type SessionFollowRuleFailureV1 = z.infer<typeof SessionFollowRuleErrorResponseV1Schema>['error'];

export function buildSessionFollowRulePhysicalKeyV1(ruleId: string): string {
  return SESSION_FOLLOW_RULE_ACCOUNT_PREFIX_V1 + encodeURIComponent(SessionFollowRuleIdV1Schema.parse(ruleId));
}
export function parseSessionFollowRulePhysicalKeyV1(key: string): string | null {
  if (!key.startsWith(SESSION_FOLLOW_RULE_ACCOUNT_PREFIX_V1)) return null;
  try {
    const parsed = SessionFollowRuleIdV1Schema.safeParse(decodeURIComponent(key.slice(SESSION_FOLLOW_RULE_ACCOUNT_PREFIX_V1.length)));
    return parsed.success && buildSessionFollowRulePhysicalKeyV1(parsed.data) === key ? parsed.data : null;
  } catch { return null; }
}
export function assertSessionFollowRuleContentForModeV1(content: SessionFollowRuleContentV1, mode: 'plain' | 'e2ee'): void {
  if ((mode === 'plain') !== (content.t === 'plain') || content.t === 'encrypted'
    && !isAccountScopedBlobCiphertextForKind({ kind: SESSION_FOLLOW_RULE_CIPHER_KIND_V1, ciphertext: content.c })) {
    throw new Error('account-mode-mismatch');
  }
}
export function equalFollowRuleReceiverV1(left: FollowReceiverRefV1, right: FollowReceiverRefV1): boolean {
  return left.kind === right.kind && (left.kind === 'account' || right.kind === 'session' && left.sessionId === right.sessionId);
}
export const AccountEncryptionMigrateSessionFollowRulesDirectiveV1Schema = lazyZodSchema(() => z.strictObject({
  items: z.array(z.strictObject({ ruleId: SessionFollowRuleIdV1Schema, expectedVersion: version,
    receiver: FollowReceiverRefV1Schema, content: SessionFollowRuleContentV1Schema })),
}).check(z.superRefine((directive, context) => {
  const seen = new Set<string>();
  for (const [index, item] of directive.items.entries()) {
    if (seen.has(item.ruleId)) context.addIssue({ code: 'custom', path: ['items', index, 'ruleId'], message: 'Rule identity must be unique' });
    seen.add(item.ruleId);
  }
})));
export type AccountEncryptionMigrateSessionFollowRulesDirectiveV1 = z.infer<typeof AccountEncryptionMigrateSessionFollowRulesDirectiveV1Schema>;
export const AccountEncryptionMigrateSessionFollowRulesResultV1Schema = ListSessionFollowRulesResponseV1Schema;
export type AccountEncryptionMigrateSessionFollowRulesResultV1 = z.infer<typeof AccountEncryptionMigrateSessionFollowRulesResultV1Schema>;
