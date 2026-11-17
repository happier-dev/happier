import * as zMini from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import {
  NonBlankOpaqueIdentifierSchema,
  readNonBlankOpaqueIdentifier,
} from '../../strings/opaqueIdentifier.js';
import { z } from '../../zodRuntimePolicy.js';

import {
  BackendTargetRefV2Schema,
  BackendTargetKeyV2Schema,
  PersistedAgentTargetRefV1Schema,
  PersistedBackendTargetRefV2Schema,
  buildBackendTargetKeyV2,
  normalizeBackendTargetRefV2InputToV2,
  parseBackendTargetKeyV2,
} from '../../backends/targets/backendTargetRefV2.js';
import { ProviderBoundModelRefSchema } from '../../providers/selection/v1.js';
import { ConnectedServiceBindingsV2IngressSchema } from '../../connect/connectedServiceBindings.js';
import { AcpConfigOptionOverridesV1Schema } from '../../sessions/metadata/metadataOverridesV1.js';
import { SessionCapabilitySelectionAuthoringV1Schema } from '../../reach/sessionCapabilitySelectionV1.js';
import { hasLegacyCustomAcpConcreteBackendId, isLegacyCustomAcpId } from '../../backends/targets/compat/customAcp.js';
import { HappierReplayStrategySchema } from '../../sessions/continueWithReplay.js';
import {
  HappierReplayRecentMessagesCountSchema,
  HappierReplayWireMaxSeedCharsSchema,
} from '../../sessions/replaySeedBudget.js';
import { LlmTaskRunnerChoiceV1Schema } from '../../llm/tasks/llmTaskRunnerConfigV1.js';
import {
  ScmDiffSummaryGenerateInputSchema,
  ScmDiffSummaryGenerateOutputSchema,
  ScmDiffSummaryOutputKindSchema,
} from '../../scm/diffSummary.js';
import { TurnChangeSetSchema } from '../../sessions/changes/schemas.js';
import { StrictJsonValueSchema } from '../../json/strictJsonValue.js';
import { PluginJsonSchemaV2Schema } from '../../plugins/contributions/publicTypes.js';
import { DiscussionSelectionSourceV1Schema } from '../../discussions/content.js';
import {
  ExecutionRunClassSchema,
  ExecutionRunIntentSchema,
  ExecutionRunIoModeSchema,
  ExecutionRunRetentionPolicySchema,
  type ExecutionRunIntent,
} from './runPrimitives.js';
import { ExecutionRunResultContractV1Schema } from './resultContractV1.js';
import { TeamCredentialProviderModelSelectionV1Schema } from '../../teams/credentials/resourceV1.js';
import { SecretReferenceOverlayV1Schema } from '../../profiles/secretReferenceOverlayV1.js';
import { HappierStructuredInputV1Schema } from '../../runtime/input/structuredInputV1.js';
import { PluginSourceCustodyV1Schema } from '../../plugins/runtime/sourceCustody.js';
import { AgentSessionToolPolicyShapeV1 } from '../../runtime/permissionIntentV1.js';
import { ApprovalProfileIdV1Schema } from '../../actions/approvalProfiles.js';
import { ProjectSessionDefaultsContextSelectionV1Schema } from '../../projects/projectSessionDefaultsSelectionV1.js';

export const ExecutionRunTeamCredentialSessionBindingConsentV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  sessionId: z.string().check(z.trim(), z.minLength(1)),
  teamId: z.string().check(z.trim(), z.minLength(1)),
  resourceId: z.string().check(z.trim(), z.minLength(1)),
  expectedResourceRevision: z.number().check(z.int(), z.nonnegative()),
}));
export type ExecutionRunTeamCredentialSessionBindingConsentV1 = z.infer<
  typeof ExecutionRunTeamCredentialSessionBindingConsentV1Schema
>;

/** Existing Run control's attach/detach operand; selection is a reference only. */
export const ExecutionRunApprovalProfileSetInputSchema = lazyZodSchema(() => z.strictObject({
  approvalProfileId: z.nullable(ApprovalProfileIdV1Schema),
}));

/** Select the safe start operation; admission remains the model/source resolver. */
export function requiresProviderSafeExecutionRunStartRpc(
  request: Readonly<{ modelSelection?: unknown; teamCredentialModel?: unknown; modelId?: unknown;
    connectedServices?: unknown; connectedServicesDefaultServiceIds?: unknown }>,
  attached: boolean,
): boolean {
  // Exact model references and native resets use the safe selection operation.
  if (request.modelSelection !== undefined) return true;
  // Team selection already uses its separate exact custody capability.
  if (request.teamCredentialModel !== undefined) return false;
  if (!attached) return false;
  const explicitModel = typeof request.modelId === 'string' && request.modelId.trim().length > 0;
  const explicitRoute = request.connectedServices !== undefined
    || (Array.isArray(request.connectedServicesDefaultServiceIds) && request.connectedServicesDefaultServiceIds.length > 0);
  return !explicitModel || !explicitRoute;
}

/**
 * An attached long-lived Agent or SCM narrator Run may be created before its first turn so
 * the caller can durably bind the Run identity, then admit the exact prompt
 * through the owning Session Pending queue. Omission retains the ordinary
 * start-with-instructions contract.
 */
export const ExecutionRunInitialInputV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('deferred_session_pending'),
}));
export type ExecutionRunInitialInputV1 = z.infer<typeof ExecutionRunInitialInputV1Schema>;

export {
  ExecutionRunClassSchema,
  ExecutionRunIntentSchema,
  ExecutionRunIoModeSchema,
  ExecutionRunRetentionPolicySchema,
  type ExecutionRunClass,
  type ExecutionRunIntent,
  type ExecutionRunIoMode,
  type ExecutionRunRetentionPolicy,
} from './runPrimitives.js';

export const ExecutionRunKindSchema = lazyZodSchema(() => z.enum([
  'scm_commit_message.v1',
  'scm_diff_summary.v1',
]));
export type ExecutionRunKind = z.infer<typeof ExecutionRunKindSchema>;

/** The typed Run kind an intent requires; intents absent here are untyped. */
export const EXECUTION_RUN_KIND_BY_INTENT = {
  scm_commit_message: 'scm_commit_message.v1',
  scm_diff_summary: 'scm_diff_summary.v1',
} as const satisfies Partial<Record<ExecutionRunIntent, ExecutionRunKind>>;

export function executionRunKindForIntent(intent: ExecutionRunIntent): ExecutionRunKind | undefined {
  return (EXECUTION_RUN_KIND_BY_INTENT as Partial<Record<ExecutionRunIntent, ExecutionRunKind>>)[intent];
}

const PROVIDER_SESSION_RESUME_HANDLE_KIND = 'provider_session.v1';
const LEGACY_VENDOR_SESSION_RESUME_HANDLE_KIND = 'vendor_session.v1';

export function normalizeLegacyExecutionRunBackendTargetInput(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  // Presence only: this decides which legacy field supplies the handle. The
  // selected value is forwarded unchanged.
  const providerSessionId = readNonBlankOpaqueIdentifier(record.providerSessionId) ?? '';
  const legacyVendorSessionId = readNonBlankOpaqueIdentifier(record.vendorSessionId) ?? '';
  const hasProviderSessionResumeHandleKind = record.kind === PROVIDER_SESSION_RESUME_HANDLE_KIND
    || record.kind === LEGACY_VENDOR_SESSION_RESUME_HANDLE_KIND;
  const normalizedResumeHandleFields = hasProviderSessionResumeHandleKind
    ? (() => {
        const { vendorSessionId: _legacyVendorSessionId, ...rest } = record;
        const next = record.kind === LEGACY_VENDOR_SESSION_RESUME_HANDLE_KIND
          ? { ...rest, kind: PROVIDER_SESSION_RESUME_HANDLE_KIND }
          : rest;
        if (providerSessionId || !legacyVendorSessionId) {
          return next;
        }
        return {
          ...next,
          providerSessionId: legacyVendorSessionId, // legacy vendorSessionId read-compat
        };
      })()
    : record.kind === 'voice_agent_sessions.v1'
      ? (() => {
          // Presence only: these select which legacy field supplies each handle.
          const chatProviderSessionId = readNonBlankOpaqueIdentifier(record.chatProviderSessionId) ?? '';
          const commitProviderSessionId = readNonBlankOpaqueIdentifier(record.commitProviderSessionId) ?? '';
          const legacyChatVendorSessionId = readNonBlankOpaqueIdentifier(record.chatVendorSessionId) ?? '';
          const legacyCommitVendorSessionId = readNonBlankOpaqueIdentifier(record.commitVendorSessionId) ?? '';
          const {
            chatVendorSessionId: _legacyChatVendorSessionId,
            commitVendorSessionId: _legacyCommitVendorSessionId,
            ...rest
          } = record;
          return {
            ...rest,
            ...(!chatProviderSessionId && legacyChatVendorSessionId
              ? { chatProviderSessionId: legacyChatVendorSessionId }
              : {}),
            ...(!commitProviderSessionId && legacyCommitVendorSessionId
              ? { commitProviderSessionId: legacyCommitVendorSessionId }
              : {}),
          };
        })()
      : record;
  if (record.backendTarget !== undefined) {
    return normalizedResumeHandleFields === record ? value : normalizedResumeHandleFields;
  }
  const legacyBackendId = typeof record.backendId === 'string' ? record.backendId.trim() : '';
  if (!legacyBackendId) {
    return normalizedResumeHandleFields === record ? value : normalizedResumeHandleFields;
  }
  const legacyConfiguredBackendId = typeof record.configuredBackendId === 'string'
    ? record.configuredBackendId.trim()
    : '';
  if (record.sourceKind === 'configured' || legacyConfiguredBackendId) {
    return {
      ...normalizedResumeHandleFields,
      backendTarget: {
        kind: 'backend',
        backendId: legacyConfiguredBackendId || legacyBackendId,
        configuredBackendId: legacyConfiguredBackendId || legacyBackendId,
        sourceKind: 'configured',
      },
    };
  }
  if (isLegacyCustomAcpId(legacyBackendId)) {
    return normalizedResumeHandleFields === record ? value : normalizedResumeHandleFields;
  }
  return {
    ...normalizedResumeHandleFields,
    backendTarget: {
      kind: 'backend',
      backendId: legacyBackendId,
      sourceKind: 'built_in',
    },
  };
}

const ExecutionRunResumeHandleProviderSessionV1SchemaCore = lazyZodSchema(() => z.looseObject({
  kind: z.literal(PROVIDER_SESSION_RESUME_HANDLE_KIND),
  backendTarget: (<I extends zMini.core.$ZodType, O extends zMini.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as zMini.ZodMiniPipe<I, O>)(z.transform(normalizeBackendTargetRefV2InputToV2), BackendTargetRefV2Schema),
  providerSessionId: NonBlankOpaqueIdentifierSchema,
}).check(z.superRefine((value, ctx) => {
  if (hasLegacyCustomAcpConcreteBackendId(value.backendTarget)) {
    ctx.addIssue({
      code: "custom",
      message: 'backendTarget must identify a concrete backend',
      path: ['backendTarget'],
    });
  }
})));
export const ExecutionRunResumeHandleProviderSessionV1Schema = lazyZodSchema(() => (<I extends zMini.core.$ZodType, O extends zMini.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as zMini.ZodMiniPipe<I, O>)(z.transform(normalizeLegacyExecutionRunBackendTargetInput), ExecutionRunResumeHandleProviderSessionV1SchemaCore));
export type ExecutionRunResumeHandleProviderSessionV1 = z.infer<typeof ExecutionRunResumeHandleProviderSessionV1Schema>;

const ExecutionRunResumeHandleVoiceAgentSessionsV1SchemaCore = lazyZodSchema(() => z.looseObject({
  kind: z.literal('voice_agent_sessions.v1'),
  backendTarget: (<I extends zMini.core.$ZodType, O extends zMini.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as zMini.ZodMiniPipe<I, O>)(z.transform(normalizeBackendTargetRefV2InputToV2), BackendTargetRefV2Schema),
  chatProviderSessionId: z.string().check(z.minLength(1)),
  commitProviderSessionId: z.string().check(z.minLength(1)),
}).check(z.superRefine((value, ctx) => {
  if (hasLegacyCustomAcpConcreteBackendId(value.backendTarget)) {
    ctx.addIssue({
      code: "custom",
      message: 'backendTarget must identify a concrete backend',
      path: ['backendTarget'],
    });
  }
})));
export const ExecutionRunResumeHandleVoiceAgentSessionsV1Schema = lazyZodSchema(() => (<I extends zMini.core.$ZodType, O extends zMini.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as zMini.ZodMiniPipe<I, O>)(z.transform(normalizeLegacyExecutionRunBackendTargetInput), ExecutionRunResumeHandleVoiceAgentSessionsV1SchemaCore));
export type ExecutionRunResumeHandleVoiceAgentSessionsV1 = z.infer<typeof ExecutionRunResumeHandleVoiceAgentSessionsV1Schema>;

const ExecutionRunResumeHandleSchemaCore = lazyZodSchema(() => z.discriminatedUnion('kind', [
  ExecutionRunResumeHandleProviderSessionV1SchemaCore,
  ExecutionRunResumeHandleVoiceAgentSessionsV1SchemaCore,
]));
export const ExecutionRunResumeHandleSchema = lazyZodSchema(() => (<I extends zMini.core.$ZodType, O extends zMini.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as zMini.ZodMiniPipe<I, O>)(z.transform(normalizeLegacyExecutionRunBackendTargetInput), ExecutionRunResumeHandleSchemaCore));
export type ExecutionRunResumeHandle = z.infer<typeof ExecutionRunResumeHandleSchema>;

export const ExecutionRunDisplaySchema = lazyZodSchema(() => z.looseObject({
  /**
   * Optional user-facing label/title for the run (used for future group chat + participant labeling).
   */
  title: z.optional(z.string().check(z.minLength(1), z.maxLength(200))),
  /**
   * Optional short participant label (e.g. "Reviewer A") for merged/group views.
   */
  participantLabel: z.optional(z.string().check(z.minLength(1), z.maxLength(80))),
  /**
   * Optional group ID used to render multiple runs as a logical "group chat" in UI.
   */
  groupId: z.optional(z.string().check(z.minLength(1), z.maxLength(120))),
}));
export type ExecutionRunDisplay = z.infer<typeof ExecutionRunDisplaySchema>;

export const ExecutionRunDraftCorrelationIdSchema = lazyZodSchema(() => DiscussionSelectionSourceV1Schema.shape.draftCorrelationId._zod.def.innerType);
export type ExecutionRunDraftCorrelationId = z.infer<typeof ExecutionRunDraftCorrelationIdSchema>;

export const ExecutionRunLaunchOriginSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('session'),
    sessionId: z.string().check(z.trim(), z.minLength(1)),
    draftCorrelationId: zMini.optional(ExecutionRunDraftCorrelationIdSchema),
  }),
  DiscussionSelectionSourceV1Schema,
  z.strictObject({
    kind: z.literal('external'),
    source: z.optional(z.enum(['cli', 'mcp', 'action'])),
  }),
]));
export type ExecutionRunLaunchOrigin = z.infer<typeof ExecutionRunLaunchOriginSchema>;

export const ExecutionRunReplaySeedRequestSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.looseObject({
    kind: z.literal('voice_session.v1'),
    previousSessionId: z.string().check(z.minLength(1)),
    transcriptEpoch: z.number().check(z.int(), z.minimum(0)),
    strategy: zMini.optional(HappierReplayStrategySchema),
    recentMessagesCount: zMini.optional(HappierReplayRecentMessagesCountSchema),
    maxSeedChars: zMini.optional(HappierReplayWireMaxSeedCharsSchema),
    summaryRunner: zMini.optional(LlmTaskRunnerChoiceV1Schema),
  }),
]));
export type ExecutionRunReplaySeedRequest = z.infer<typeof ExecutionRunReplaySeedRequestSchema>;

/**
 * Voice owns two independently re-resolvable Agent/Provider/model compositions.
 * The generic top-level `modelSelection` is the chat composition; the commit
 * composition stays in the Voice intent input because it creates a second runtime.
 */
export const ExecutionRunVoiceAgentIntentInputV1Schema = lazyZodSchema(() => z.strictObject({
  commitModelSelection: zMini.optional(ProviderBoundModelRefSchema),
  commitTeamCredentialModel: zMini.optional(TeamCredentialProviderModelSelectionV1Schema),
  voicePolicy: z.optional(z.strictObject({
    assistantLanguage: z.nullable(z.string().check(z.trim(), z.minLength(1))),
    welcome: z.strictObject({
      enabled: z.boolean(),
      mode: z.enum(['immediate', 'on_first_turn']),
      /** Admitted greeting bytes; omission retains model-generated/default behavior. */
      text: z.optional(z.string()),
    }),
  })),
}));
export type ExecutionRunVoiceAgentIntentInputV1 = z.infer<typeof ExecutionRunVoiceAgentIntentInputV1Schema>;

/**
 * The generic task profile uses the replay seed's existing 200k-character
 * public prompt ceiling. Structured input stays under StrictJsonValue's
 * canonical depth/node/aggregate-byte limits.
 */
export const EXECUTION_RUN_TASK_INSTRUCTIONS_MAX_CHARS = 200_000;

export const ExecutionRunTaskIntentInputV1Schema = lazyZodSchema(() => z.strictObject({
  input: zMini.optional(StrictJsonValueSchema),
  resultSchema: zMini.optional(PluginJsonSchemaV2Schema),
}));
export type ExecutionRunTaskIntentInputV1 = z.infer<typeof ExecutionRunTaskIntentInputV1Schema>;

export const ExecutionRunAgentIntentInputV1Schema = lazyZodSchema(() => z.strictObject({
  input: zMini.optional(StrictJsonValueSchema),
  /** Compatibility shorthand for the initial turn's JSON result contract. */
  resultSchema: zMini.optional(PluginJsonSchemaV2Schema),
  resultContract: zMini.optional(ExecutionRunResultContractV1Schema),
}).check(z.superRefine((value, ctx) => {
  if (value.resultSchema && value.resultContract) {
    ctx.addIssue({
      code: "custom",
      path: ['resultContract'],
      message: 'agent resultSchema and resultContract are mutually exclusive',
    });
  }
})));
export type ExecutionRunAgentIntentInputV1 = z.infer<typeof ExecutionRunAgentIntentInputV1Schema>;

export const ExecutionRunScmCommitMessageScopeV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('paths'),
  include: z.optional(z.array(z.string().check(z.minLength(1))).check(z.maxLength(200))),
}));
export type ExecutionRunScmCommitMessageScopeV1 = z.infer<typeof ExecutionRunScmCommitMessageScopeV1Schema>;

export const ExecutionRunScmCommitMessageInputV1Schema = lazyZodSchema(() => z.strictObject({
  instructions: z.optional(z.string()),
  scope: z.optional(ExecutionRunScmCommitMessageScopeV1Schema),
  maxFiles: z.optional(z.number().check(z.int(), z.positive(), z.maximum(100))),
  maxTotalDiffChars: z.optional(z.number().check(z.int(), z.positive(), z.maximum(400_000))),
}));
export type ExecutionRunScmCommitMessageInputV1 = z.infer<typeof ExecutionRunScmCommitMessageInputV1Schema>;

export const ExecutionRunScmCommitMessageResultV1Schema = lazyZodSchema(() => z.looseObject({
  title: z.string().check(z.minLength(1), z.maxLength(200)),
  body: z.string().check(z.maxLength(20_000)),
  message: z.string().check(z.minLength(1)),
  confidence: z.optional(z.number().check(z.minimum(0), z.maximum(1))),
}));
export type ExecutionRunScmCommitMessageResultV1 = z.infer<typeof ExecutionRunScmCommitMessageResultV1Schema>;

export const ExecutionRunScmDiffSummaryInputV1Schema = lazyZodSchema(() => (<T extends zMini.ZodMiniObject>(schema: T) => zMini.core.clone(schema, { ...schema._zod.def, catchall: zMini.unknown() }) as zMini.ZodMiniObject<T['shape'], zMini.core.$loose>)(zMini.safeExtend(ScmDiffSummaryGenerateInputSchema, {
  // A saved-result conversation requests no structured output. Generation still
  // requires a nonempty selection at ScmDiffSummaryGenerateInputSchema.
  outputs: z.optional(z.array(ScmDiffSummaryOutputKindSchema)),
  turnChangeSet: zMini.optional(TurnChangeSetSchema),
  resultId: z.optional(z.string().check(z.minLength(1))),
  expectedRevision: z.optional(z.number().check(z.int(), z.nonnegative())),
  instructions: z.optional(z.string().check(z.minLength(1))),
  stopIds: z.optional(z.array(z.string().check(z.minLength(1))).check(z.minLength(1), z.refine((ids) => new Set(ids).size === ids.length, 'Stop ids must be unique'))),
  seededFromRunId: z.optional(z.string().check(z.minLength(1))),
  /** Scoped saved-owner request reference, never caller-authored explanation provenance. */
  reviewExplanationInputId: z.optional(z.string().check(z.minLength(1))),
})).check(z.refine(input => input.outputs?.length !== 0 || Boolean(input.resultId), 'Discussion requires a saved result')));
export type ExecutionRunScmDiffSummaryInputV1 = z.infer<typeof ExecutionRunScmDiffSummaryInputV1Schema>;

export const ExecutionRunScmDiffSummaryResultV1Schema = lazyZodSchema(() => ScmDiffSummaryGenerateOutputSchema);
export type ExecutionRunScmDiffSummaryResultV1 = z.infer<typeof ExecutionRunScmDiffSummaryResultV1Schema>;

/**
 * Start requests retain the canonical manifest-qualified Agent identity. The
 * daemon that owns the current plugin catalog resolves that identity to its
 * process-local routing id exactly once at admission. Released backend and key
 * inputs continue to normalize through the existing compatibility reader.
 */
export function normalizeExecutionRunStartBackendTargetInput(input: unknown): unknown {
  const agentTarget = PersistedAgentTargetRefV1Schema.safeParse(input);
  if (agentTarget.success) return agentTarget.data;

  if (typeof input === 'string') {
    const targetKey = BackendTargetKeyV2Schema.safeParse(input);
    if (targetKey.success) return parseBackendTargetKeyV2(targetKey.data);
  }

  return normalizeBackendTargetRefV2InputToV2(input);
}

export const ExecutionRunStartRequestBaseSchema = lazyZodSchema(() => z.looseObject({
  ...AgentSessionToolPolicyShapeV1,
  kind: z.optional(ExecutionRunKindSchema),
  roleId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  /** Launch Profile selection; profileId remains the plugin execution Profile. */
  launchProfileId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  intent: ExecutionRunIntentSchema,
  backendTarget: (<I extends zMini.core.$ZodType, O extends zMini.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as zMini.ZodMiniPipe<I, O>)(z.transform(normalizeExecutionRunStartBackendTargetInput), PersistedBackendTargetRefV2Schema),
  instructions: z.optional(z.string()),
  initialInput: z.optional(ExecutionRunInitialInputV1Schema),
  display: z.optional(ExecutionRunDisplaySchema),
  launchOrigin: z.optional(ExecutionRunLaunchOriginSchema),
  permissionMode: z.string().check(z.minLength(1)),
  /** Reference only; null explicitly opts out of inherited selection. */
  approvalProfileId: z.optional(z.nullable(ApprovalProfileIdV1Schema)),
  projectContext: z.optional(ProjectSessionDefaultsContextSelectionV1Schema),
  retentionPolicy: ExecutionRunRetentionPolicySchema,
  runClass: ExecutionRunClassSchema,
  ioMode: ExecutionRunIoModeSchema,
  profileId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  profileSourceCustody: zMini.optional(PluginSourceCustodyV1Schema),
  /** Value-free Saved Secret binding overrides for this launch only. */
  secretReferenceOverlay: zMini.optional(SecretReferenceOverlayV1Schema),
  initialContext: z.optional(z.string()),
  initialContextMode: z.optional(z.enum(['bootstrap', 'first_turn'])),
  bootstrapMode: z.optional(z.enum(['none', 'ready_handshake'])),
  resumeHandle: z.optional(z.nullable(ExecutionRunResumeHandleSchema)),
  replay: z.optional(ExecutionRunReplaySeedRequestSchema),
  intentInput: z.optional(z.unknown()),
  /** Canonical host-owned structured input for the initial native turn. */
  structuredInput: zMini.optional(HappierStructuredInputV1Schema),
  /** Stable host-authored identity for the initial native input. */
  localInputId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  /** Exact result requested for the initial native turn only. */
  resultContract: zMini.optional(ExecutionRunResultContractV1Schema),
  /** Authored execution cwd; the daemon validates and binds it before start. */
  cwd: z.optional(z.string().check(z.trim(), z.minLength(1))),
  /** Canonical capability selection bound to this Run's working location. */
  capabilitySelection: zMini.optional(SessionCapabilitySelectionAuthoringV1Schema),
  /**
   * Optional model selection for the run backend, reusing the SAME canonical `modelId` vocabulary
   * as session spawn (`SessionSpawnNewInputSchema.modelId`). Attached omission is resolved
   * by host child admission; independent starts use the backend's default model.
   * Threaded to the plugin backend spawn through the unified execution-run runtime; per-provider
   * application lives at each plugin's config seam (never a name-branch in shared runtime core).
   */
  modelId: z.optional(z.string().check(z.minLength(1))),
  /**
   * Exact Agent/Provider/model tuple for a Provider-bound bounded Agent run.
   * The run owner persists this re-resolvable reference and creates ephemeral
   * authorization/materialization state for every start or resume.
   * Explicit null requests native settings; omission permits attached inheritance.
   */
  modelSelection: zMini.optional(zMini.nullable(ProviderBoundModelRefSchema)),
  /** Explicit Account-default choice after attached inheritance requires a decision. */
  childSelection: z.optional(z.literal('agentDefault')),
  /** Account snapshots are supplied by host admission, never authored Run input. */
  accountSettings: z.optional(z.never()),
  /**
   * Exact recipient-safe Team resource/model selection for this Run. This is
   * mutually exclusive with an Account-local Provider selection and is
   * re-authorized by the Team resource owner for every start or resume.
   */
  teamCredentialModel: zMini.optional(TeamCredentialProviderModelSelectionV1Schema),
  /**
   * Explicit consent for the attached parent Session transaction that may be
   * required by the selected Team resource's visibility policy. The exact
   * Session/resource/revision witness prevents a stale launcher decision from
   * authorizing a different selection. Detached starts deliberately omit it.
   */
  teamCredentialSessionBindingConsent: z.optional(ExecutionRunTeamCredentialSessionBindingConsentV1Schema),
  /** Voice's chat model; when Provider-bound it must match top-level modelSelection. */
  chatModelId: z.optional(z.string().check(z.minLength(1))),
  /** Voice's independently selected commit model. */
  commitModelId: z.optional(z.string().check(z.minLength(1))),
  /**
   * Optional agent config-option overrides (e.g. reasoning effort) for the run backend, reusing the
   * SAME canonical `AcpConfigOptionOverridesV1` shape as session spawn — NOT a second vocabulary.
   * Action inputs may also pass a `configOptions` shorthand which is merged into this canonical
   * shape at the action boundary before the request is built.
   */
  sessionConfigOptionOverrides: zMini.optional(AcpConfigOptionOverridesV1Schema),
  /**
   * Optional connected-services selection for the run backend (profile|group per serviceId),
   * mirroring session-spawn connected-services bindings. When omitted, the runtime applies the
   * SAME account-settings defaulting as session spawn. Null is the explicit all-services native
   * opt-out produced by the agent-friendly `"native"` shorthand. Connected selections fail closed:
   * the run does not start when the daemon cannot resolve + materialize the selected auth.
   */
  connectedServices: zMini.optional(zMini.nullable(ConnectedServiceBindingsV2IngressSchema)),
  /**
   * Bare per-service default tokens (RO-F5): serviceIds asking for their STORED account default. Set by
   * the action boundary alongside `connectedServices` so the run-start owner resolves each named
   * service's stored default and merges it UNDER explicit pins. Mixed bare+explicit thus resolves
   * instead of failing closed. Missing stored default fails closed at the run-start owner. On resume
   * this stays empty — the persisted selection already carries the resolved concrete bindings.
   */
  connectedServicesDefaultServiceIds: z.optional(z.array(z.string())),
  notifyParentOnCompletion: z.optional(z.boolean()),
}));

type ExecutionRunStartRequestRefinementValue = Pick<
  z.output<typeof ExecutionRunStartRequestBaseSchema>,
  | 'backendTarget'
  | 'intent'
  | 'intentInput'
  | 'localInputId'
  | 'resultContract'
  | 'structuredInput'
  | 'instructions'
  | 'initialInput'
  | 'ioMode'
  | 'kind'
  | 'chatModelId'
  | 'commitModelId'
  | 'modelId'
  | 'modelSelection'
  | 'teamCredentialModel'
  | 'teamCredentialSessionBindingConsent'
  | 'permissionMode'
  | 'profileSourceCustody'
  | 'profileId'
  | 'retentionPolicy'
  | 'runClass'
> & Readonly<Record<string, unknown>>;

export function refineExecutionRunStartRequest(
  value: ExecutionRunStartRequestRefinementValue,
  ctx: z.core.$RefinementCtx,
): void {
  if (value.resultContract && !value.localInputId) {
    ctx.addIssue({
      code: "custom",
      message: 'resultContract requires exact localInputId correspondence',
      path: ['localInputId'],
    });
  }
  if (
    value.modelSelection
    && value.modelSelection.agentTargetKey
      !== buildBackendTargetKeyV2(value.backendTarget)
  ) {
    ctx.addIssue({
      code: "custom",
      message: 'modelSelection must target the execution-run backend',
      path: ['modelSelection', 'agentTargetKey'],
    });
  }
  if (
    value.teamCredentialModel
    && value.teamCredentialModel.agentTargetKey
      !== buildBackendTargetKeyV2(value.backendTarget)
  ) {
    ctx.addIssue({
      code: "custom",
      message: 'teamCredentialModel must target the execution-run backend',
      path: ['teamCredentialModel', 'agentTargetKey'],
    });
  }
  if (value.teamCredentialModel && value.modelSelection !== undefined) {
    ctx.addIssue({
      code: "custom",
      message: 'Select exactly one Provider model source',
      path: ['teamCredentialModel'],
    });
  }
  if (value.teamCredentialSessionBindingConsent) {
    const consent = value.teamCredentialSessionBindingConsent;
    const selection = value.teamCredentialModel;
    if (
      !selection
      || consent.teamId !== selection.teamId
      || consent.resourceId !== selection.resourceId
      || consent.expectedResourceRevision !== selection.expectedResourceRevision
    ) {
      ctx.addIssue({
        code: "custom",
        message: 'Session binding consent must exactly match the selected Team resource revision',
        path: ['teamCredentialSessionBindingConsent'],
      });
    }
  }
  if (
    value.intent === 'voice_agent'
    && (value.modelSelection || value.teamCredentialModel)
    && value.chatModelId !== undefined
    && (value.modelSelection ?? value.teamCredentialModel)?.modelId !== value.chatModelId
  ) {
    ctx.addIssue({
      code: "custom",
      message: 'Voice chat modelSelection modelId must match chatModelId',
      path: ['modelSelection', 'modelId'],
    });
  }
  if (value.intent === 'voice_agent') {
    const parsedInput = ExecutionRunVoiceAgentIntentInputV1Schema.safeParse(value.intentInput ?? {});
    if (!parsedInput.success) {
      ctx.addIssue({
        code: "custom",
        message: 'Invalid voice_agent intentInput',
        path: ['intentInput'],
      });
    } else {
      const commitSelection = parsedInput.data.commitModelSelection ?? parsedInput.data.commitTeamCredentialModel;
      const commitSelectionKey = parsedInput.data.commitTeamCredentialModel ? 'commitTeamCredentialModel' : 'commitModelSelection';
      if (parsedInput.data.commitModelSelection && parsedInput.data.commitTeamCredentialModel) {
        ctx.addIssue({ code: 'custom', message: 'Select exactly one commit Provider model source',
          path: ['intentInput', 'commitTeamCredentialModel'] });
      }
      if (
        commitSelection && commitSelection.agentTargetKey
          !== buildBackendTargetKeyV2(value.backendTarget)
      ) {
        ctx.addIssue({
          code: "custom",
          message: 'Voice commit model selection must target the execution-run backend',
          path: ['intentInput', commitSelectionKey, 'agentTargetKey'],
        });
      }
      if (
        commitSelection && (value.commitModelId === undefined
        || commitSelection.modelId !== value.commitModelId)
      ) {
        ctx.addIssue({
          code: "custom",
          message: 'Voice commit model selection modelId must match commitModelId',
          path: ['intentInput', commitSelectionKey, 'modelId'],
        });
      }
    }
  }
  if (value.intent === 'task') {
    const instructions = typeof value.instructions === 'string' ? value.instructions.trim() : '';
    if (!instructions || instructions.length > EXECUTION_RUN_TASK_INSTRUCTIONS_MAX_CHARS) {
      ctx.addIssue({
        code: "custom",
        message: `task instructions must be between 1 and ${EXECUTION_RUN_TASK_INSTRUCTIONS_MAX_CHARS} characters`,
        path: ['instructions'],
      });
    }
    const parsedInput = ExecutionRunTaskIntentInputV1Schema.safeParse(value.intentInput ?? {});
    if (!parsedInput.success) {
      ctx.addIssue({
        code: "custom",
        message: 'Invalid task intentInput',
        path: ['intentInput'],
      });
    }
    if (value.permissionMode !== 'no_tools' && value.permissionMode !== 'read_only') {
      ctx.addIssue({
        code: "custom",
        message: 'task runs do not allow write-capable permission modes',
        path: ['permissionMode'],
      });
    }
    if (value.retentionPolicy !== 'ephemeral') {
      ctx.addIssue({
        code: "custom",
        message: 'task runs must use ephemeral retention',
        path: ['retentionPolicy'],
      });
    }
    if (value.runClass !== 'bounded') {
      ctx.addIssue({
        code: "custom",
        message: 'task runs must use bounded runClass',
        path: ['runClass'],
      });
    }
    if (value.ioMode !== 'request_response') {
      ctx.addIssue({
        code: "custom",
        message: 'task runs must use request_response ioMode',
        path: ['ioMode'],
      });
    }
  }
  if (value.intent === 'agent') {
    const instructions = typeof value.instructions === 'string' ? value.instructions.trim() : '';
    const defersToSessionPending = value.initialInput?.kind === 'deferred_session_pending';
    if (!defersToSessionPending && (!instructions || instructions.length > EXECUTION_RUN_TASK_INSTRUCTIONS_MAX_CHARS)) {
      ctx.addIssue({
        code: "custom",
        message: `agent instructions must be between 1 and ${EXECUTION_RUN_TASK_INSTRUCTIONS_MAX_CHARS} characters`,
        path: ['instructions'],
      });
    }
    if (defersToSessionPending) {
      if (value.instructions !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: 'deferred Session Pending input must not include start instructions',
          path: ['instructions'],
        });
      }
      if (
        value.localInputId !== undefined
        || value.resultContract !== undefined
        || value.structuredInput !== undefined
        || value.intentInput !== undefined
      ) {
        ctx.addIssue({
          code: "custom",
          message: 'deferred Session Pending input must not embed initial turn content or correspondence',
          path: value.localInputId !== undefined
            ? ['localInputId']
            : value.resultContract !== undefined
              ? ['resultContract']
              : value.structuredInput !== undefined
                ? ['structuredInput']
                : ['intentInput'],
        });
      }
      if (value.runClass !== 'long_lived' || value.retentionPolicy !== 'resumable') {
        ctx.addIssue({
          code: "custom",
          message: 'deferred Session Pending input requires a resumable long-lived Run',
          path: value.runClass !== 'long_lived' ? ['runClass'] : ['retentionPolicy'],
        });
      }
    }
    const parsedInput = ExecutionRunAgentIntentInputV1Schema.safeParse(value.intentInput ?? {});
    if (!parsedInput.success) {
      ctx.addIssue({
        code: "custom",
        message: 'Invalid agent intentInput',
        path: ['intentInput'],
      });
    } else if (
      value.resultContract
      && (parsedInput.data.resultContract || parsedInput.data.resultSchema)
    ) {
      ctx.addIssue({
        code: "custom",
        message: 'agent initial result contract must have one owner',
        path: ['resultContract'],
      });
    }
  }
  if (value.initialInput !== undefined && value.intent === 'scm_diff_summary') {
    if (value.instructions !== undefined || value.localInputId !== undefined || value.resultContract !== undefined || value.structuredInput !== undefined) {
      ctx.addIssue({ code: "custom", message: 'deferred SCM narration must not embed initial turn content or correspondence', path: ['initialInput'] });
    }
    if (value.runClass !== 'long_lived' || value.retentionPolicy !== 'resumable') {
      ctx.addIssue({ code: "custom", message: 'deferred SCM narration requires a resumable long-lived Run', path: ['initialInput'] });
    }
  }
  if (value.initialInput !== undefined && value.intent !== 'agent' && value.intent !== 'scm_diff_summary') {
    ctx.addIssue({
      code: "custom",
      message: 'deferred Session Pending input is available only for Agent and SCM narration runs',
      path: ['initialInput'],
    });
  }
  if (
    value.modelSelection
    && value.modelId !== undefined
    && value.modelSelection.modelId !== value.modelId
  ) {
    ctx.addIssue({
      code: "custom",
      message: 'modelSelection modelId must match modelId',
      path: ['modelSelection', 'modelId'],
    });
  }
  if (
    value.teamCredentialModel
    && value.modelId !== undefined
    && value.teamCredentialModel.modelId !== value.modelId
  ) {
    ctx.addIssue({
      code: "custom",
      message: 'teamCredentialModel modelId must match modelId',
      path: ['teamCredentialModel', 'modelId'],
    });
  }
  if (Object.prototype.hasOwnProperty.call(value, 'agentSessionStartupInstructionsV1')) {
    ctx.addIssue({
      code: "custom",
      message: 'Agent-session startup instructions are not supported for execution runs',
      path: ['agentSessionStartupInstructionsV1'],
    });
  }
  if (Boolean(value.profileId) !== Boolean(value.profileSourceCustody)) {
    ctx.addIssue({
      code: "custom",
      message: 'profileId and profileSourceCustody must be provided together',
      path: value.profileId ? ['profileSourceCustody'] : ['profileId'],
    });
  }
  if (
    value.backendTarget.kind === 'backend'
    && hasLegacyCustomAcpConcreteBackendId({
      backendId: value.backendTarget.backendId,
      configuredBackendId: value.backendTarget.configuredBackendId,
    })
  ) {
    ctx.addIssue({
      code: "custom",
      message: 'backendTarget must identify a concrete backend',
      path: ['backendTarget'],
    });
  }
  if (value.kind === EXECUTION_RUN_KIND_BY_INTENT.scm_commit_message || value.intent === 'scm_commit_message') {
    const kind = EXECUTION_RUN_KIND_BY_INTENT.scm_commit_message;
    if (value.kind !== kind) {
      ctx.addIssue({
        code: "custom",
        message: `kind must be ${kind} for scm_commit_message runs`,
        path: ['kind'],
      });
    }
    if (value.intent !== 'scm_commit_message') {
      ctx.addIssue({
        code: "custom",
        message: `intent must be scm_commit_message for ${kind} runs`,
        path: ['intent'],
      });
    }
    if (value.permissionMode !== 'no_tools' && value.permissionMode !== 'read_only') {
      ctx.addIssue({
        code: "custom",
        message: `${kind} does not allow write-capable permission modes`,
        path: ['permissionMode'],
      });
    }
    if (value.retentionPolicy !== 'ephemeral') {
      ctx.addIssue({
        code: "custom",
        message: `${kind} must use ephemeral retention`,
        path: ['retentionPolicy'],
      });
    }
    if (value.runClass !== 'bounded') {
      ctx.addIssue({
        code: "custom",
        message: `${kind} must use bounded runClass`,
        path: ['runClass'],
      });
    }
    if (value.ioMode !== 'request_response') {
      ctx.addIssue({
        code: "custom",
        message: `${kind} must use request_response ioMode`,
        path: ['ioMode'],
      });
    }
    const parsedInput = ExecutionRunScmCommitMessageInputV1Schema.safeParse(value.intentInput ?? {});
    if (!parsedInput.success) {
      ctx.addIssue({
        code: "custom",
        message: `Invalid ${kind} intentInput`,
        path: ['intentInput'],
      });
    }
  }
  if (value.kind === EXECUTION_RUN_KIND_BY_INTENT.scm_diff_summary || value.intent === 'scm_diff_summary') {
    const kind = EXECUTION_RUN_KIND_BY_INTENT.scm_diff_summary;
    if (value.kind !== kind) {
      ctx.addIssue({
        code: "custom",
        message: `kind must be ${kind} for scm_diff_summary runs`,
        path: ['kind'],
      });
    }
    if (value.intent !== 'scm_diff_summary') {
      ctx.addIssue({
        code: "custom",
        message: `intent must be scm_diff_summary for ${kind} runs`,
        path: ['intent'],
      });
    }
    if (value.permissionMode !== 'no_tools' && value.permissionMode !== 'read_only') {
      ctx.addIssue({
        code: "custom",
        message: `${kind} does not allow write-capable permission modes`,
        path: ['permissionMode'],
      });
    }
    if (value.retentionPolicy !== 'resumable') {
      ctx.addIssue({
        code: "custom",
        message: `${kind} must use resumable retention`,
        path: ['retentionPolicy'],
      });
    }
    if (value.runClass !== 'long_lived') {
      ctx.addIssue({
        code: "custom",
        message: `${kind} must use long_lived runClass`,
        path: ['runClass'],
      });
    }
    if (value.ioMode !== 'request_response' && value.ioMode !== 'streaming') {
      ctx.addIssue({
        code: "custom",
        message: `${kind} must use request_response or streaming ioMode`,
        path: ['ioMode'],
      });
    }
    const parsedInput = ExecutionRunScmDiffSummaryInputV1Schema.safeParse(value.intentInput ?? {});
    if (!parsedInput.success) {
      ctx.addIssue({
        code: "custom",
        message: `Invalid ${kind} intentInput`,
        path: ['intentInput'],
      });
    }
  }
}

export const ExecutionRunStartRequestSchema = lazyZodSchema(() => ExecutionRunStartRequestBaseSchema.check(z.superRefine(refineExecutionRunStartRequest)));
export type ExecutionRunStartRequest = z.infer<typeof ExecutionRunStartRequestSchema>;

/**
 * Provider-visible prompt carriers are deliberately absent from durable
 * detached-start recipes. Their owner renders one bounded prompt separately
 * and supplies it only when composing the live start request.
 */
export const EXECUTION_RUN_DETACHED_START_PROMPT_FIELDS_V1 = Object.freeze([
  'instructions',
  'intentInput',
  'initialContext',
  'initialContextMode',
  'bootstrapMode',
  'replay',
] as const);

/**
 * Strict configuration for a fresh, detached bounded task start. This is the
 * canonical durable-caller projection: it contains target/runtime/policy
 * selection, but no rendered prompt or semantic prompt carrier.
 */
export const ExecutionRunDetachedStartRequestV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(z.omit(ExecutionRunStartRequestBaseSchema, {
  kind: true,
  instructions: true,
  intentInput: true,
  initialContext: true,
  initialContextMode: true,
  bootstrapMode: true,
  replay: true,
  launchOrigin: true,
  teamCredentialSessionBindingConsent: true,
}), {
  intent: z.literal('task'),
  permissionMode: z.enum(['no_tools', 'read_only']),
  retentionPolicy: z.literal('ephemeral'),
  runClass: z.literal('bounded'),
  ioMode: z.literal('request_response'),
})).check(z.superRefine((value, ctx) => {
  refineExecutionRunStartRequest({
    ...value,
    instructions: 'detached prompt supplied at dispatch',
    intentInput: {},
  }, ctx);
})));
export type ExecutionRunDetachedStartRequestV1 = z.infer<typeof ExecutionRunDetachedStartRequestV1Schema>;
