import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

import { PluginContributionLocalIdSchema } from '../../plugins/contributionIdentity.js';
import { PluginIdSchema } from '../../plugins/pluginId.js';
import { AgentPermissionIntentV1Schema } from '../../runtime/permissionIntentV1.js';
import { SessionIdSchema, TurnIdSchema } from '../idsV1.js';
import { NativePermissionChoiceAnswerV1Schema, NativePermissionChoicesV1Schema, NativePermissionChoiceAvailabilityV1Schema } from './respondRpcParamsV1.js';
import { asProtocolZod } from "../../plugins/actions/internalProtocolZodAdapter.js";

const UTF8_ENCODER = new TextEncoder();

/** Host-admitted native tool approval whose presentation permits Session persistence. */
export const NATIVE_TOOL_APPROVAL_REQUEST_SOURCE = 'native_tool_approval';

/** Host-admitted native tool approval that cannot create reusable authority. */
export const NATIVE_TOOL_APPROVAL_ONCE_REQUEST_SOURCE = 'native_tool_approval_once';

function boundedNfcIdentifier(maxBytes: number, label: string) {
  return z.string().check(z.refine((value) => value === value.normalize('NFC'), `${label} must be NFC-normalized`), z.refine((value) => value === value.trim() && value.length > 0, `${label} must be trimmed and nonempty`), z.refine((value) => UTF8_ENCODER.encode(value).byteLength <= maxBytes, `${label} exceeds its UTF-8 byte limit`));
}

function boundedNfcText(maxBytes: number, label: string) {
  return z.string().check(z.refine((value) => value === value.normalize('NFC'), `${label} must be NFC-normalized`), z.refine((value) => value.trim().length > 0, `${label} must be nonempty`), z.refine((value) => UTF8_ENCODER.encode(value).byteLength <= maxBytes, `${label} exceeds its UTF-8 byte limit`));
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

export const SessionPermissionAccountUserDecisionActorV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('accountUser'),
  accountId: SessionPermissionAccountIdV1Schema,
  relationship: z.enum(['owner', 'sharedApprover']),
}));
export type SessionPermissionAccountUserDecisionActorV1 = z.infer<
  typeof SessionPermissionAccountUserDecisionActorV1Schema
>;

export const SessionPermissionExternalHumanDecisionActorV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('externalHuman'),
  assurance: z.literal('pluginAsserted'),
  namespace: SessionPermissionExternalPrincipalNamespaceV1Schema,
  principalId: SessionPermissionExternalPrincipalIdV1Schema,
  assertedBy: z.strictObject({
    pluginId: asProtocolZod(PluginIdSchema),
    contributionLocalId: asProtocolZod(PluginContributionLocalIdSchema),
  }),
}));
export type SessionPermissionExternalHumanDecisionActorV1 = z.infer<
  typeof SessionPermissionExternalHumanDecisionActorV1Schema
>;

export const SessionPermissionApprovalReviewerDecisionActorV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('approvalReviewer'),
}));

/** A reviewer may answer this request once; it cannot grant future authority. */
export const SessionPermissionApprovalReviewerClaimV1Schema = lazyZodSchema(() => z.strictObject({
  version: z.literal(1),
  origin: z.literal('approvalReviewer'),
  turnId: z.optional(TurnIdSchema),
  decision: z.literal('approved'),
  scope: z.literal('request'),
}));
export type SessionPermissionApprovalReviewerClaimV1 = z.infer<typeof SessionPermissionApprovalReviewerClaimV1Schema>;

export const SessionPermissionDecisionActorV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  SessionPermissionAccountUserDecisionActorV1Schema,
  SessionPermissionExternalHumanDecisionActorV1Schema,
  SessionPermissionApprovalReviewerDecisionActorV1Schema,
]));
export type SessionPermissionDecisionActorV1 = z.infer<typeof SessionPermissionDecisionActorV1Schema>;

export const SessionPermissionRemoteActorInputV1Schema = lazyZodSchema(() => z.strictObject({
  namespace: SessionPermissionExternalPrincipalNamespaceV1Schema,
  principalId: SessionPermissionExternalPrincipalIdV1Schema,
}));
export type SessionPermissionRemoteActorInputV1 = z.infer<typeof SessionPermissionRemoteActorInputV1Schema>;

const SessionPermissionRemoteAllowedScopesV1Schema = lazyZodSchema(() => z.union([
  z.tuple([z.literal('request')]),
  z.tuple([z.literal('request'), z.literal('session')]),
]));

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

const SessionPermissionRemoteQuestionSummaryV1Schema = lazyZodSchema(() => z.strictObject({
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
  )).check(z.maxLength(SESSION_PERMISSION_REMOTE_SUMMARY_MAX_CHOICES_PER_QUESTION)),
}));

const SessionPermissionRemotePermissionSummaryV1Schema = lazyZodSchema(() => z.strictObject({
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
}));

const SessionPermissionRemoteUserActionSummaryV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('user_action'),
  questions: z.array(SessionPermissionRemoteQuestionSummaryV1Schema).check(z.maxLength(SESSION_PERMISSION_REMOTE_SUMMARY_MAX_QUESTIONS)),
  /** Above the existing remote caps, render only this link to the complete form. */
  fullForm: z.optional(z.strictObject({
    questionCount: z.number().check(z.int(), z.positive()),
    url: z.url({ protocol: /^https?$/ }),
  })),
}).check(z.refine((summary) => summary.fullForm
  ? summary.questions.length === 0
  : summary.questions.length > 0, 'Full-form requests must not contain inline questions')));

const SessionPermissionRemoteAgentRequestSummaryV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  SessionPermissionRemotePermissionSummaryV1Schema,
  SessionPermissionRemoteUserActionSummaryV1Schema,
]));
export type SessionPermissionRemoteAgentRequestSummaryV1 = z.infer<
  typeof SessionPermissionRemoteAgentRequestSummaryV1Schema
>;

export const SessionPermissionRemotePendingListInputV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: asProtocolZod(SessionIdSchema),
  sourceRef: SessionPermissionSourceRefV1Schema,
  sourceRevisionOrEpoch: SessionPermissionSourceRevisionOrEpochV1Schema,
  /**
   * Keyset continuation from a prior page's `nextCursor`. Omit it to read from
   * the oldest request. The bounded page is not the whole projection, so a
   * mediator holding custody for a request beyond the first page continues
   * here rather than waiting for older requests to settle.
   */
  cursor: z.optional(z.nullable(SessionPermissionCursorV1Schema)),
}));
export type SessionPermissionRemotePendingListInputV1 = z.infer<typeof SessionPermissionRemotePendingListInputV1Schema>;

const SessionPermissionRemotePendingPermissionRequestV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('permission'),
  nativeChoices: z.optional(NativePermissionChoicesV1Schema),
  nativeChoiceAvailability: z.optional(z.array(NativePermissionChoiceAvailabilityV1Schema)),
  permissionOwnerLabel: z.optional(z.string()),
  requestId: SessionPermissionRequestIdV1Schema,
  /**
   * Host-stamped turn custody. Remote mediators correlate a pending
   * permission by (sessionId, turnId, requestId), never by requestId alone.
   */
  turnId: TurnIdSchema,
  createdAtMs: z.number().check(z.int(), z.nonnegative()),
  allowedScopes: SessionPermissionRemoteAllowedScopesV1Schema,
  agentRequestSummary: SessionPermissionRemotePermissionSummaryV1Schema,
}));

const SessionPermissionRemotePendingUserActionRequestV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('user_action'),
  requestId: SessionPermissionRequestIdV1Schema,
  turnId: TurnIdSchema,
  createdAtMs: z.number().check(z.int(), z.nonnegative()),
  agentRequestSummary: SessionPermissionRemoteUserActionSummaryV1Schema,
}));

export const SessionPermissionRemotePendingListOutputV1Schema = lazyZodSchema(() => z.strictObject({
  requests: z.array(z.discriminatedUnion('kind', [
    SessionPermissionRemotePendingPermissionRequestV1Schema,
    SessionPermissionRemotePendingUserActionRequestV1Schema,
  ])).check(z.maxLength(32)),
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
  nextCursor: z.nullable(SessionPermissionCursorV1Schema),
}));
export type SessionPermissionRemotePendingListOutputV1 = z.infer<typeof SessionPermissionRemotePendingListOutputV1Schema>;

export const SessionPermissionRemoteRespondInputV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: asProtocolZod(SessionIdSchema),
  turnId: TurnIdSchema,
  requestId: SessionPermissionRequestIdV1Schema,
  sourceRef: SessionPermissionSourceRefV1Schema,
  sourceRevisionOrEpoch: SessionPermissionSourceRevisionOrEpochV1Schema,
  idempotencyKey: SessionPermissionIdempotencyKeyV1Schema,
  actor: SessionPermissionRemoteActorInputV1Schema,
  decision: z.optional(z.enum(['allow', 'deny'])),
  scope: z.optional(z.enum(['request', 'session'])),
  nativeChoice: z.optional(NativePermissionChoiceAnswerV1Schema),
}).check(z.refine((value) => value.nativeChoice !== undefined || value.decision !== undefined && value.scope !== undefined, 'A permission answer is required')));
export type SessionPermissionRemoteRespondInputV1 = z.infer<typeof SessionPermissionRemoteRespondInputV1Schema>;

const SessionUserActionRemoteAnswerValueV1Schema = boundedNfcText(
  SESSION_PERMISSION_REMOTE_QUESTION_TEXT_UTF8_BYTES,
  'Remote user-action answer values',
);

export const SessionUserActionRemoteAnswerInputV1Schema = lazyZodSchema(() => z.strictObject({
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
  answers: z.array(z.strictObject({
    questionIndex: z.number().check(z.int(), z.minimum(0), z.maximum(SESSION_PERMISSION_REMOTE_SUMMARY_MAX_QUESTIONS - 1)),
    values: z.array(SessionUserActionRemoteAnswerValueV1Schema).check(z.minLength(1), z.maxLength(32)),
  })).check(z.minLength(1), z.maxLength(SESSION_PERMISSION_REMOTE_SUMMARY_MAX_QUESTIONS), z.superRefine((answers, context) => {
      const indexes = new Set<number>();
      for (const [index, answer] of answers.entries()) {
        if (indexes.has(answer.questionIndex)) {
          context.addIssue({
            code: "custom",
            path: [index, 'questionIndex'],
            message: 'Remote user-action answers must not repeat a question index',
          });
        }
        indexes.add(answer.questionIndex);
      }
    })),
}));
export type SessionUserActionRemoteAnswerInputV1 = z.infer<typeof SessionUserActionRemoteAnswerInputV1Schema>;

export const SessionUserActionRemoteAnswerOutputV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.literal('applied'), requestId: SessionPermissionRequestIdV1Schema }),
  z.strictObject({
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
  }),
]));
export type SessionUserActionRemoteAnswerOutputV1 = z.infer<typeof SessionUserActionRemoteAnswerOutputV1Schema>;

const SessionPermissionRemoteRespondSuccessV1Schema = lazyZodSchema(() => z.discriminatedUnion('decision', [
  z.strictObject({
    status: z.enum(['applied', 'alreadyApplied']),
    settlementId: SessionPermissionSettlementIdV1Schema,
    requestId: SessionPermissionRequestIdV1Schema,
    decision: z.literal('allow'),
    effect: z.union([
      z.strictObject({ kind: z.literal('allowOnce') }),
      z.strictObject({
        kind: z.literal('sessionGrant'),
        grantId: SessionPermissionGrantIdV1Schema,
        sourceRef: SessionPermissionSourceRefV1Schema,
        sourceRevisionOrEpoch: SessionPermissionSourceRevisionOrEpochV1Schema,
        admittedPermissionCeiling: asProtocolZod(AgentPermissionIntentV1Schema),
      }),
    ]),
  }),
  z.strictObject({
    status: z.enum(['applied', 'alreadyApplied']),
    settlementId: SessionPermissionSettlementIdV1Schema,
    requestId: SessionPermissionRequestIdV1Schema,
    decision: z.literal('deny'),
    effect: z.strictObject({ kind: z.literal('deny') }),
  }),
]));

export const SessionPermissionRemoteRespondOutputV1Schema = lazyZodSchema(() => z.union([
  SessionPermissionRemoteRespondSuccessV1Schema,
  z.strictObject({
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
  }),
]));
export type SessionPermissionRemoteRespondOutputV1 = z.infer<typeof SessionPermissionRemoteRespondOutputV1Schema>;

export const SessionPermissionRemoteGrantsListInputV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: asProtocolZod(SessionIdSchema),
  limit: z._default(z.number().check(z.int(), z.minimum(1), z.maximum(200)), 50),
  cursor: z.optional(z.nullable(SessionPermissionCursorV1Schema)),
}));
export type SessionPermissionRemoteGrantsListInputV1 = z.infer<typeof SessionPermissionRemoteGrantsListInputV1Schema>;

const SessionPermissionRemoteGrantProjectionV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('mediator') }),
  z.strictObject({
    kind: z.literal('owner'),
    rule: z.strictObject({
      kind: z.literal('exactTool'),
      identifier: boundedNfcIdentifier(1_024, 'Permission tool identifiers'),
    }),
    revocationActor: z.optional(z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('accountUser'), accountId: SessionPermissionAccountIdV1Schema }),
      z.strictObject({ kind: z.literal('mediatorPlugin'), pluginId: asProtocolZod(PluginIdSchema) }),
    ])),
  }),
]));

export const SessionPermissionRemoteGrantSummaryV1Schema = lazyZodSchema(() => z.strictObject({
  turnId: TurnIdSchema,
  requestId: SessionPermissionRequestIdV1Schema,
  settlementId: SessionPermissionSettlementIdV1Schema,
  grantId: SessionPermissionGrantIdV1Schema,
  sourceRef: SessionPermissionSourceRefV1Schema,
  sourceRevisionOrEpoch: SessionPermissionSourceRevisionOrEpochV1Schema,
  admittedPermissionCeiling: asProtocolZod(AgentPermissionIntentV1Schema),
  actor: SessionPermissionRemoteActorInputV1Schema,
  createdAtMs: z.number().check(z.int(), z.nonnegative()),
  revokedAtMs: z.optional(z.number().check(z.int(), z.nonnegative())),
  projection: SessionPermissionRemoteGrantProjectionV1Schema,
}));
export type SessionPermissionRemoteGrantSummaryV1 = z.infer<typeof SessionPermissionRemoteGrantSummaryV1Schema>;

export const SessionPermissionRemoteGrantsListOutputV1Schema = lazyZodSchema(() => z.strictObject({
  grants: z.array(SessionPermissionRemoteGrantSummaryV1Schema).check(z.maxLength(200)),
  nextCursor: z.nullable(SessionPermissionCursorV1Schema),
}));
export type SessionPermissionRemoteGrantsListOutputV1 = z.infer<typeof SessionPermissionRemoteGrantsListOutputV1Schema>;

export const SessionPermissionRemoteGrantRevokeInputV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: asProtocolZod(SessionIdSchema),
  turnId: TurnIdSchema,
  requestId: SessionPermissionRequestIdV1Schema,
  grantId: SessionPermissionGrantIdV1Schema,
}));
export type SessionPermissionRemoteGrantRevokeInputV1 = z.infer<typeof SessionPermissionRemoteGrantRevokeInputV1Schema>;

export const SessionPermissionRemoteGrantRevokeOutputV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.enum(['revoked', 'alreadyRevoked']), grantId: SessionPermissionGrantIdV1Schema }),
  z.strictObject({
    status: z.literal('rejected'),
    code: z.enum(['notFound', 'sessionUnavailable', 'ownerMachineUnavailable', 'mediationStateUnavailable', 'canceled']),
  }),
]));
export type SessionPermissionRemoteGrantRevokeOutputV1 = z.infer<typeof SessionPermissionRemoteGrantRevokeOutputV1Schema>;
export * from './questionV1.js';
