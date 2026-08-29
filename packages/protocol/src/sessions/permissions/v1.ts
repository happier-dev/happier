import { z } from 'zod';

import { PluginContributionLocalIdSchema } from '../../plugins/contributionIdentity.js';
import { PluginIdSchema } from '../../plugins/pluginId.js';
import { AgentPermissionIntentV1Schema } from '../../runtime/permissionIntentV1.js';
import { SessionIdSchema, TurnIdSchema } from '../idsV1.js';
import { asProtocolZod } from "../../plugins/actions/internalProtocolZodAdapter.js";

const UTF8_ENCODER = new TextEncoder();

function boundedNfcIdentifier(maxBytes: number, label: string) {
  return z.string()
    .refine((value) => value === value.normalize('NFC'), `${label} must be NFC-normalized`)
    .refine((value) => value === value.trim() && value.length > 0, `${label} must be trimmed and nonempty`)
    .refine((value) => UTF8_ENCODER.encode(value).byteLength <= maxBytes, `${label} exceeds its UTF-8 byte limit`);
}

function boundedNfcText(maxBytes: number, label: string) {
  return z.string()
    .refine((value) => value === value.normalize('NFC'), `${label} must be NFC-normalized`)
    .refine((value) => value.trim().length > 0, `${label} must be nonempty`)
    .refine((value) => UTF8_ENCODER.encode(value).byteLength <= maxBytes, `${label} exceeds its UTF-8 byte limit`);
}

export const SessionPermissionRequestIdV1Schema = boundedNfcIdentifier(256, 'Permission request ids');
export const SessionPermissionSettlementIdV1Schema = boundedNfcIdentifier(256, 'Permission settlement ids');
export const SessionPermissionGrantIdV1Schema = boundedNfcIdentifier(256, 'Permission grant ids');
export const SessionPermissionSourceRefV1Schema = boundedNfcIdentifier(256, 'Permission source references');
export const SessionPermissionSourceRevisionOrEpochV1Schema = boundedNfcIdentifier(128, 'Permission source revisions');
export const SessionPermissionIdempotencyKeyV1Schema = boundedNfcIdentifier(256, 'Permission idempotency keys');
export const SessionPermissionExternalPrincipalNamespaceV1Schema = boundedNfcIdentifier(64, 'External principal namespaces');
export const SessionPermissionExternalPrincipalIdV1Schema = boundedNfcIdentifier(256, 'External principal ids');

export const SessionPermissionAccountIdV1Schema = boundedNfcIdentifier(191, 'Account ids');
const SessionPermissionCursorV1Schema = boundedNfcIdentifier(1_024, 'Permission cursors');

export const SessionPermissionAccountUserDecisionActorV1Schema = z.object({
  kind: z.literal('accountUser'),
  accountId: SessionPermissionAccountIdV1Schema,
  relationship: z.enum(['owner', 'sharedApprover']),
}).strict();
export type SessionPermissionAccountUserDecisionActorV1 = z.infer<
  typeof SessionPermissionAccountUserDecisionActorV1Schema
>;

export const SessionPermissionExternalHumanDecisionActorV1Schema = z.object({
  kind: z.literal('externalHuman'),
  assurance: z.literal('pluginAsserted'),
  namespace: SessionPermissionExternalPrincipalNamespaceV1Schema,
  principalId: SessionPermissionExternalPrincipalIdV1Schema,
  assertedBy: z.object({
    pluginId: asProtocolZod(PluginIdSchema),
    contributionLocalId: asProtocolZod(PluginContributionLocalIdSchema),
  }).strict(),
}).strict();
export type SessionPermissionExternalHumanDecisionActorV1 = z.infer<
  typeof SessionPermissionExternalHumanDecisionActorV1Schema
>;

export const SessionPermissionDecisionActorV1Schema = z.discriminatedUnion('kind', [
  SessionPermissionAccountUserDecisionActorV1Schema,
  SessionPermissionExternalHumanDecisionActorV1Schema,
]);
export type SessionPermissionDecisionActorV1 = z.infer<typeof SessionPermissionDecisionActorV1Schema>;

export const SessionPermissionRemoteActorInputV1Schema = z.object({
  namespace: SessionPermissionExternalPrincipalNamespaceV1Schema,
  principalId: SessionPermissionExternalPrincipalIdV1Schema,
}).strict();
export type SessionPermissionRemoteActorInputV1 = z.infer<typeof SessionPermissionRemoteActorInputV1Schema>;

const SessionPermissionRemoteAllowedScopesV1Schema = z.union([
  z.tuple([z.literal('request')]),
  z.tuple([z.literal('request'), z.literal('session')]),
]);

/**
 * The remote pending projection is deliberately a bounded reviewer surface,
 * not a copy of the internal tool-input payload.  The host owns derivation
 * and applies its canonical credential redactor before bounded truncation and
 * this Action boundary; mediators only render these approval-relevant semantic
 * facts and send indexed answers back to the current Session owner. Command,
 * path, prompt, and choice text may appear only through that one summary.
 */
export const SESSION_PERMISSION_REMOTE_SUMMARY_TOOL_LABEL_UTF8_BYTES = 256;
export const SESSION_PERMISSION_REMOTE_SUMMARY_TITLE_UTF8_BYTES = 1_024;
export const SESSION_PERMISSION_REMOTE_SUMMARY_DETAIL_UTF8_BYTES = 1_024;
export const SESSION_PERMISSION_REMOTE_QUESTION_TEXT_UTF8_BYTES = 1_024;
export const SESSION_PERMISSION_REMOTE_QUESTION_CHOICE_UTF8_BYTES = 256;
export const SESSION_PERMISSION_REMOTE_SUMMARY_MAX_QUESTIONS = 4;
export const SESSION_PERMISSION_REMOTE_SUMMARY_MAX_CHOICES_PER_QUESTION = 8;

const SessionPermissionRemoteQuestionSummaryV1Schema = z.object({
  question: boundedNfcText(
    SESSION_PERMISSION_REMOTE_QUESTION_TEXT_UTF8_BYTES,
    'Remote question text',
  ),
  selection: z.enum(['text', 'single', 'multiple']),
  required: z.boolean(),
  allowCustom: z.boolean(),
  choices: z.array(boundedNfcText(
    SESSION_PERMISSION_REMOTE_QUESTION_CHOICE_UTF8_BYTES,
    'Remote question choices',
  )).max(SESSION_PERMISSION_REMOTE_SUMMARY_MAX_CHOICES_PER_QUESTION),
}).strict();

const SessionPermissionRemotePermissionSummaryV1Schema = z.object({
  kind: z.literal('permission'),
  toolLabel: boundedNfcText(
    SESSION_PERMISSION_REMOTE_SUMMARY_TOOL_LABEL_UTF8_BYTES,
    'Remote permission tool labels',
  ),
  title: boundedNfcText(
    SESSION_PERMISSION_REMOTE_SUMMARY_TITLE_UTF8_BYTES,
    'Remote permission titles',
  ),
  detail: boundedNfcText(
    SESSION_PERMISSION_REMOTE_SUMMARY_DETAIL_UTF8_BYTES,
    'Remote permission details',
  ),
}).strict();

const SessionPermissionRemoteUserActionSummaryV1Schema = z.object({
  kind: z.literal('user_action'),
  questions: z.array(SessionPermissionRemoteQuestionSummaryV1Schema)
    .min(1)
    .max(SESSION_PERMISSION_REMOTE_SUMMARY_MAX_QUESTIONS),
}).strict();

const SessionPermissionRemoteAgentRequestSummaryV1Schema = z.discriminatedUnion('kind', [
  SessionPermissionRemotePermissionSummaryV1Schema,
  SessionPermissionRemoteUserActionSummaryV1Schema,
]);
export type SessionPermissionRemoteAgentRequestSummaryV1 = z.infer<
  typeof SessionPermissionRemoteAgentRequestSummaryV1Schema
>;

export const SessionPermissionRemotePendingListInputV1Schema = z.object({
  sessionId: asProtocolZod(SessionIdSchema),
  sourceRef: SessionPermissionSourceRefV1Schema,
  sourceRevisionOrEpoch: SessionPermissionSourceRevisionOrEpochV1Schema,
  /**
   * Keyset continuation from a prior page's `nextCursor`. Omit it to read from
   * the oldest request. The bounded page is not the whole projection, so a
   * mediator holding custody for a request beyond the first page continues
   * here rather than waiting for older requests to settle.
   */
  cursor: SessionPermissionCursorV1Schema.nullable().optional(),
}).strict();
export type SessionPermissionRemotePendingListInputV1 = z.infer<typeof SessionPermissionRemotePendingListInputV1Schema>;

const SessionPermissionRemotePendingPermissionRequestV1Schema = z.object({
  kind: z.literal('permission'),
  requestId: SessionPermissionRequestIdV1Schema,
  /**
   * Host-stamped turn custody. Remote mediators correlate a pending
   * permission by (sessionId, turnId, requestId), never by requestId alone.
   */
  turnId: TurnIdSchema,
  createdAtMs: z.number().int().nonnegative(),
  allowedScopes: SessionPermissionRemoteAllowedScopesV1Schema,
  agentRequestSummary: SessionPermissionRemotePermissionSummaryV1Schema,
}).strict();

const SessionPermissionRemotePendingUserActionRequestV1Schema = z.object({
  kind: z.literal('user_action'),
  requestId: SessionPermissionRequestIdV1Schema,
  turnId: TurnIdSchema,
  createdAtMs: z.number().int().nonnegative(),
  agentRequestSummary: SessionPermissionRemoteUserActionSummaryV1Schema,
}).strict();

export const SessionPermissionRemotePendingListOutputV1Schema = z.object({
  requests: z.array(z.discriminatedUnion('kind', [
    SessionPermissionRemotePendingPermissionRequestV1Schema,
    SessionPermissionRemotePendingUserActionRequestV1Schema,
  ])).max(32),
  /**
   * `true` means the host is withholding a durable source-matched request
   * until its live permission waiter has reattached. Callers must not infer
   * that a missing request is absent while this is set, and it is a whole-
   * projection fact rather than a per-page one. Further *pages* are reported
   * by `nextCursor`, never by this flag.
   */
  truncated: z.boolean(),
  /**
   * Keyset continuation for the next bounded page, or `null` at the end of the
   * projection. An undecodable continuation returns an empty `truncated` page
   * so a caller can never read it as a proof of absence.
   */
  nextCursor: SessionPermissionCursorV1Schema.nullable(),
}).strict();
export type SessionPermissionRemotePendingListOutputV1 = z.infer<typeof SessionPermissionRemotePendingListOutputV1Schema>;

export const SessionPermissionRemoteRespondInputV1Schema = z.object({
  sessionId: asProtocolZod(SessionIdSchema),
  turnId: TurnIdSchema,
  requestId: SessionPermissionRequestIdV1Schema,
  sourceRef: SessionPermissionSourceRefV1Schema,
  sourceRevisionOrEpoch: SessionPermissionSourceRevisionOrEpochV1Schema,
  idempotencyKey: SessionPermissionIdempotencyKeyV1Schema,
  actor: SessionPermissionRemoteActorInputV1Schema,
  decision: z.enum(['allow', 'deny']),
  scope: z.enum(['request', 'session']),
}).strict();
export type SessionPermissionRemoteRespondInputV1 = z.infer<typeof SessionPermissionRemoteRespondInputV1Schema>;

const SessionUserActionRemoteAnswerValueV1Schema = boundedNfcText(
  SESSION_PERMISSION_REMOTE_QUESTION_TEXT_UTF8_BYTES,
  'Remote user-action answer values',
);

export const SessionUserActionRemoteAnswerInputV1Schema = z.object({
  sessionId: asProtocolZod(SessionIdSchema),
  turnId: TurnIdSchema,
  requestId: SessionPermissionRequestIdV1Schema,
  sourceRef: SessionPermissionSourceRefV1Schema,
  sourceRevisionOrEpoch: SessionPermissionSourceRevisionOrEpochV1Schema,
  /**
   * Questions are identified by their bounded projection index rather than a
   * client-supplied prompt string. The Session owner resolves these indices
   * against its live request before delegating completion to the incumbent
   * `session.user_action.answer` path.
   */
  answers: z.array(z.object({
    questionIndex: z.number().int().min(0).max(SESSION_PERMISSION_REMOTE_SUMMARY_MAX_QUESTIONS - 1),
    values: z.array(SessionUserActionRemoteAnswerValueV1Schema).min(1).max(32),
  }).strict()).min(1).max(SESSION_PERMISSION_REMOTE_SUMMARY_MAX_QUESTIONS)
    .superRefine((answers, context) => {
      const indexes = new Set<number>();
      for (const [index, answer] of answers.entries()) {
        if (indexes.has(answer.questionIndex)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, 'questionIndex'],
            message: 'Remote user-action answers must not repeat a question index',
          });
        }
        indexes.add(answer.questionIndex);
      }
    }),
}).strict();
export type SessionUserActionRemoteAnswerInputV1 = z.infer<typeof SessionUserActionRemoteAnswerInputV1Schema>;

export const SessionUserActionRemoteAnswerOutputV1Schema = z.union([
  z.object({ status: z.literal('applied'), requestId: SessionPermissionRequestIdV1Schema }).strict(),
  z.object({
    status: z.literal('rejected'),
    code: z.enum([
      'requestNotFound',
      'requestNotPending',
      'answerInvalid',
      'mediationStateUnavailable',
      'sessionUnavailable',
      'ownerMachineUnavailable',
      'canceled',
    ]),
  }).strict(),
]);
export type SessionUserActionRemoteAnswerOutputV1 = z.infer<typeof SessionUserActionRemoteAnswerOutputV1Schema>;

const SessionPermissionRemoteRespondSuccessV1Schema = z.discriminatedUnion('decision', [
  z.object({
    status: z.enum(['applied', 'alreadyApplied']),
    settlementId: SessionPermissionSettlementIdV1Schema,
    requestId: SessionPermissionRequestIdV1Schema,
    decision: z.literal('allow'),
    effect: z.union([
      z.object({ kind: z.literal('allowOnce') }).strict(),
      z.object({
        kind: z.literal('sessionGrant'),
        grantId: SessionPermissionGrantIdV1Schema,
        sourceRef: SessionPermissionSourceRefV1Schema,
        sourceRevisionOrEpoch: SessionPermissionSourceRevisionOrEpochV1Schema,
        admittedPermissionCeiling: asProtocolZod(AgentPermissionIntentV1Schema),
      }).strict(),
    ]),
  }).strict(),
  z.object({
    status: z.enum(['applied', 'alreadyApplied']),
    settlementId: SessionPermissionSettlementIdV1Schema,
    requestId: SessionPermissionRequestIdV1Schema,
    decision: z.literal('deny'),
    effect: z.object({ kind: z.literal('deny') }).strict(),
  }).strict(),
]);

export const SessionPermissionRemoteRespondOutputV1Schema = z.union([
  SessionPermissionRemoteRespondSuccessV1Schema,
  z.object({
    status: z.literal('rejected'),
    code: z.enum([
      'requestNotFound',
      'requestNotPending',
      'decisionConflict',
      'remoteApprovalDisabled',
      'scopeExceedsPolicy',
      'sessionScopeUnsupported',
      'sessionGrantCapacityExceeded',
      'permissionCeilingExceeded',
      'actorUnattributable',
      'mediationStateUnavailable',
      'sessionUnavailable',
      'ownerMachineUnavailable',
      'canceled',
    ]),
  }).strict(),
]);
export type SessionPermissionRemoteRespondOutputV1 = z.infer<typeof SessionPermissionRemoteRespondOutputV1Schema>;

export const SessionPermissionRemoteGrantsListInputV1Schema = z.object({
  sessionId: asProtocolZod(SessionIdSchema),
  limit: z.number().int().min(1).max(200).default(50),
  cursor: SessionPermissionCursorV1Schema.nullable().optional(),
}).strict();
export type SessionPermissionRemoteGrantsListInputV1 = z.infer<typeof SessionPermissionRemoteGrantsListInputV1Schema>;

const SessionPermissionRemoteGrantProjectionV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('mediator') }).strict(),
  z.object({
    kind: z.literal('owner'),
    rule: z.object({
      kind: z.literal('exactTool'),
      identifier: boundedNfcIdentifier(1_024, 'Permission tool identifiers'),
    }).strict(),
    revocationActor: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('accountUser'), accountId: SessionPermissionAccountIdV1Schema }).strict(),
      z.object({ kind: z.literal('mediatorPlugin'), pluginId: asProtocolZod(PluginIdSchema) }).strict(),
    ]).optional(),
  }).strict(),
]);

export const SessionPermissionRemoteGrantSummaryV1Schema = z.object({
  turnId: TurnIdSchema,
  requestId: SessionPermissionRequestIdV1Schema,
  settlementId: SessionPermissionSettlementIdV1Schema,
  grantId: SessionPermissionGrantIdV1Schema,
  sourceRef: SessionPermissionSourceRefV1Schema,
  sourceRevisionOrEpoch: SessionPermissionSourceRevisionOrEpochV1Schema,
  admittedPermissionCeiling: asProtocolZod(AgentPermissionIntentV1Schema),
  actor: SessionPermissionRemoteActorInputV1Schema,
  createdAtMs: z.number().int().nonnegative(),
  revokedAtMs: z.number().int().nonnegative().optional(),
  projection: SessionPermissionRemoteGrantProjectionV1Schema,
}).strict();
export type SessionPermissionRemoteGrantSummaryV1 = z.infer<typeof SessionPermissionRemoteGrantSummaryV1Schema>;

export const SessionPermissionRemoteGrantsListOutputV1Schema = z.object({
  grants: z.array(SessionPermissionRemoteGrantSummaryV1Schema).max(200),
  nextCursor: SessionPermissionCursorV1Schema.nullable(),
}).strict();
export type SessionPermissionRemoteGrantsListOutputV1 = z.infer<typeof SessionPermissionRemoteGrantsListOutputV1Schema>;

export const SessionPermissionRemoteGrantRevokeInputV1Schema = z.object({
  sessionId: asProtocolZod(SessionIdSchema),
  turnId: TurnIdSchema,
  requestId: SessionPermissionRequestIdV1Schema,
  grantId: SessionPermissionGrantIdV1Schema,
}).strict();
export type SessionPermissionRemoteGrantRevokeInputV1 = z.infer<typeof SessionPermissionRemoteGrantRevokeInputV1Schema>;

export const SessionPermissionRemoteGrantRevokeOutputV1Schema = z.union([
  z.object({ status: z.enum(['revoked', 'alreadyRevoked']), grantId: SessionPermissionGrantIdV1Schema }).strict(),
  z.object({
    status: z.literal('rejected'),
    code: z.enum(['notFound', 'sessionUnavailable', 'ownerMachineUnavailable', 'mediationStateUnavailable', 'canceled']),
  }).strict(),
]);
export type SessionPermissionRemoteGrantRevokeOutputV1 = z.infer<typeof SessionPermissionRemoteGrantRevokeOutputV1Schema>;
