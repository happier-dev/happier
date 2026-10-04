import {
  NonBlankOpaqueIdentifierSchema,
  readNonBlankOpaqueIdentifier,
} from '../../strings/opaqueIdentifier.js';
import { z } from 'zod';

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
import { SessionMcpSelectionV1Schema } from '../../mcp/servers/sessionSelectionV1.js';
import { hasLegacyCustomAcpConcreteBackendId, isLegacyCustomAcpId } from '../../backends/targets/compat/customAcp.js';
import { HappierReplayStrategySchema } from '../../sessions/continueWithReplay.js';
import {
  HappierReplayRecentMessagesCountSchema,
  HappierReplayWireMaxSeedCharsSchema,
} from '../../sessions/replaySeedBudget.js';
import { LlmTaskRunnerConfigV1Schema } from '../../llm/tasks/llmTaskRunnerConfigV1.js';
import {
  ScmDiffSummaryGenerateInputSchema,
  ScmDiffSummaryGenerateOutputSchema,
} from '../../scm/diffSummary.js';
import { TurnChangeSetSchema } from '../../sessions/changes/schemas.js';
import { StrictJsonValueSchema } from '../../json/strictJsonValue.js';
import { PluginJsonSchemaV2Schema } from '../../plugins/contributions/publicTypes.js';
import { SessionDiscussionSelectionSourceV1Schema } from '../../sessions/discussions/content.js';
import {
  ExecutionRunClassSchema,
  ExecutionRunIntentSchema,
  ExecutionRunIoModeSchema,
  ExecutionRunRetentionPolicySchema,
} from './runPrimitives.js';
import { ExecutionRunResultContractV1Schema } from './resultContractV1.js';
import { TeamCredentialProviderModelSelectionV1Schema } from '../../teams/credentials/resourceV1.js';
import { SecretReferenceOverlayV1Schema } from '../../profiles/secretReferenceOverlayV1.js';
import { HappierStructuredInputV1Schema } from '../../runtime/input/structuredInputV1.js';
import { PluginSourceCustodyV1Schema } from '../../plugins/runtime/sourceCustody.js';

export const ExecutionRunTeamCredentialSessionBindingConsentV1Schema = z.object({
  v: z.literal(1),
  sessionId: z.string().trim().min(1),
  teamId: z.string().trim().min(1),
  resourceId: z.string().trim().min(1),
  expectedResourceRevision: z.number().int().nonnegative(),
}).strict();
export type ExecutionRunTeamCredentialSessionBindingConsentV1 = z.infer<
  typeof ExecutionRunTeamCredentialSessionBindingConsentV1Schema
>;

/**
 * An attached long-lived Agent or SCM narrator Run may be created before its first turn so
 * the caller can durably bind the Run identity, then admit the exact prompt
 * through the owning Session Pending queue. Omission retains the ordinary
 * start-with-instructions contract.
 */
export const ExecutionRunInitialInputV1Schema = z.object({
  kind: z.literal('deferred_session_pending'),
}).strict();
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

export const ExecutionRunKindSchema = z.enum([
  'scm_commit_message.v1',
  'scm_diff_summary.v1',
]);
export type ExecutionRunKind = z.infer<typeof ExecutionRunKindSchema>;

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

const ExecutionRunResumeHandleProviderSessionV1SchemaCore = z.object({
  kind: z.literal(PROVIDER_SESSION_RESUME_HANDLE_KIND),
  backendTarget: z.preprocess(normalizeBackendTargetRefV2InputToV2, BackendTargetRefV2Schema),
  providerSessionId: NonBlankOpaqueIdentifierSchema,
}).passthrough().superRefine((value, ctx) => {
  if (hasLegacyCustomAcpConcreteBackendId(value.backendTarget)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'backendTarget must identify a concrete backend',
      path: ['backendTarget'],
    });
  }
});
export const ExecutionRunResumeHandleProviderSessionV1Schema = z.preprocess(
  normalizeLegacyExecutionRunBackendTargetInput,
  ExecutionRunResumeHandleProviderSessionV1SchemaCore,
);
export type ExecutionRunResumeHandleProviderSessionV1 = z.infer<typeof ExecutionRunResumeHandleProviderSessionV1Schema>;

const ExecutionRunResumeHandleVoiceAgentSessionsV1SchemaCore = z.object({
  kind: z.literal('voice_agent_sessions.v1'),
  backendTarget: z.preprocess(normalizeBackendTargetRefV2InputToV2, BackendTargetRefV2Schema),
  chatProviderSessionId: z.string().min(1),
  commitProviderSessionId: z.string().min(1),
}).passthrough().superRefine((value, ctx) => {
  if (hasLegacyCustomAcpConcreteBackendId(value.backendTarget)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'backendTarget must identify a concrete backend',
      path: ['backendTarget'],
    });
  }
});
export const ExecutionRunResumeHandleVoiceAgentSessionsV1Schema = z.preprocess(
  normalizeLegacyExecutionRunBackendTargetInput,
  ExecutionRunResumeHandleVoiceAgentSessionsV1SchemaCore,
);
export type ExecutionRunResumeHandleVoiceAgentSessionsV1 = z.infer<typeof ExecutionRunResumeHandleVoiceAgentSessionsV1Schema>;

const ExecutionRunResumeHandleSchemaCore = z.discriminatedUnion('kind', [
  ExecutionRunResumeHandleProviderSessionV1SchemaCore,
  ExecutionRunResumeHandleVoiceAgentSessionsV1SchemaCore,
]);
export const ExecutionRunResumeHandleSchema = z.preprocess(
  normalizeLegacyExecutionRunBackendTargetInput,
  ExecutionRunResumeHandleSchemaCore,
);
export type ExecutionRunResumeHandle = z.infer<typeof ExecutionRunResumeHandleSchema>;

export const ExecutionRunDisplaySchema = z.object({
  /**
   * Optional user-facing label/title for the run (used for future group chat + participant labeling).
   */
  title: z.string().min(1).max(200).optional(),
  /**
   * Optional short participant label (e.g. "Reviewer A") for merged/group views.
   */
  participantLabel: z.string().min(1).max(80).optional(),
  /**
   * Optional group ID used to render multiple runs as a logical "group chat" in UI.
   */
  groupId: z.string().min(1).max(120).optional(),
}).passthrough();
export type ExecutionRunDisplay = z.infer<typeof ExecutionRunDisplaySchema>;

export const ExecutionRunDraftCorrelationIdSchema = SessionDiscussionSelectionSourceV1Schema.shape.draftCorrelationId.unwrap();
export type ExecutionRunDraftCorrelationId = z.infer<typeof ExecutionRunDraftCorrelationIdSchema>;

export const ExecutionRunLaunchOriginSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('session'),
    sessionId: z.string().trim().min(1),
    draftCorrelationId: ExecutionRunDraftCorrelationIdSchema.optional(),
  }).strict(),
  SessionDiscussionSelectionSourceV1Schema,
  z.object({
    kind: z.literal('external'),
    source: z.enum(['cli', 'mcp', 'action']).optional(),
  }).strict(),
]);
export type ExecutionRunLaunchOrigin = z.infer<typeof ExecutionRunLaunchOriginSchema>;

export const ExecutionRunReplaySeedRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('voice_session.v1'),
    previousSessionId: z.string().min(1),
    transcriptEpoch: z.number().int().min(0),
    strategy: HappierReplayStrategySchema.optional(),
    recentMessagesCount: HappierReplayRecentMessagesCountSchema.optional(),
    maxSeedChars: HappierReplayWireMaxSeedCharsSchema.optional(),
    summaryRunner: LlmTaskRunnerConfigV1Schema.optional(),
  }).passthrough(),
]);
export type ExecutionRunReplaySeedRequest = z.infer<typeof ExecutionRunReplaySeedRequestSchema>;

/**
 * Voice owns two independently re-resolvable Agent/Provider/model compositions.
 * The generic top-level `modelSelection` is the chat composition; the commit
 * composition stays in the Voice intent input because it creates a second runtime.
 */
export const ExecutionRunVoiceAgentIntentInputV1Schema = z.object({
  commitModelSelection: ProviderBoundModelRefSchema.optional(),
}).strict();
export type ExecutionRunVoiceAgentIntentInputV1 = z.infer<typeof ExecutionRunVoiceAgentIntentInputV1Schema>;

/**
 * The generic task profile uses the replay seed's existing 200k-character
 * public prompt ceiling. Structured input stays under StrictJsonValue's
 * canonical depth/node/aggregate-byte limits.
 */
export const EXECUTION_RUN_TASK_INSTRUCTIONS_MAX_CHARS = 200_000;

export const ExecutionRunTaskIntentInputV1Schema = z.object({
  input: StrictJsonValueSchema.optional(),
  resultSchema: PluginJsonSchemaV2Schema.optional(),
}).strict();
export type ExecutionRunTaskIntentInputV1 = z.infer<typeof ExecutionRunTaskIntentInputV1Schema>;

export const ExecutionRunAgentIntentInputV1Schema = z.object({
  input: StrictJsonValueSchema.optional(),
  /** Compatibility shorthand for the initial turn's JSON result contract. */
  resultSchema: PluginJsonSchemaV2Schema.optional(),
  resultContract: ExecutionRunResultContractV1Schema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.resultSchema && value.resultContract) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['resultContract'],
      message: 'agent resultSchema and resultContract are mutually exclusive',
    });
  }
});
export type ExecutionRunAgentIntentInputV1 = z.infer<typeof ExecutionRunAgentIntentInputV1Schema>;

export const ExecutionRunScmCommitMessageScopeV1Schema = z.object({
  kind: z.literal('paths'),
  include: z.array(z.string().min(1)).max(200).optional(),
}).strict();
export type ExecutionRunScmCommitMessageScopeV1 = z.infer<typeof ExecutionRunScmCommitMessageScopeV1Schema>;

export const ExecutionRunScmCommitMessageInputV1Schema = z.object({
  instructions: z.string().optional(),
  scope: ExecutionRunScmCommitMessageScopeV1Schema.optional(),
  maxFiles: z.number().int().positive().max(100).optional(),
  maxTotalDiffChars: z.number().int().positive().max(400_000).optional(),
}).strict();
export type ExecutionRunScmCommitMessageInputV1 = z.infer<typeof ExecutionRunScmCommitMessageInputV1Schema>;

export const ExecutionRunScmCommitMessageResultV1Schema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().max(20_000),
  message: z.string().min(1),
  confidence: z.number().min(0).max(1).optional(),
}).passthrough();
export type ExecutionRunScmCommitMessageResultV1 = z.infer<typeof ExecutionRunScmCommitMessageResultV1Schema>;

export const ExecutionRunScmDiffSummaryInputV1Schema = ScmDiffSummaryGenerateInputSchema.extend({
  turnChangeSet: TurnChangeSetSchema.optional(),
  resultId: z.string().min(1).optional(),
  expectedRevision: z.number().int().nonnegative().optional(),
  instructions: z.string().min(1).optional(),
  stopIds: z.array(z.string().min(1)).min(1)
    .refine((ids) => new Set(ids).size === ids.length, 'Stop ids must be unique').optional(),
  seededFromRunId: z.string().min(1).optional(),
  /** Scoped saved-owner request reference, never caller-authored explanation provenance. */
  reviewExplanationInputId: z.string().min(1).optional(),
}).passthrough();
export type ExecutionRunScmDiffSummaryInputV1 = z.infer<typeof ExecutionRunScmDiffSummaryInputV1Schema>;

export const ExecutionRunScmDiffSummaryResultV1Schema = ScmDiffSummaryGenerateOutputSchema;
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

export const ExecutionRunStartRequestBaseSchema = z.object({
  kind: ExecutionRunKindSchema.optional(),
  roleId: z.string().trim().min(1).optional(),
  /** Launch Profile selection; profileId remains the plugin execution Profile. */
  launchProfileId: z.string().trim().min(1).optional(),
  intent: ExecutionRunIntentSchema,
  backendTarget: z.preprocess(
    normalizeExecutionRunStartBackendTargetInput,
    PersistedBackendTargetRefV2Schema,
  ),
  instructions: z.string().optional(),
  initialInput: ExecutionRunInitialInputV1Schema.optional(),
  display: ExecutionRunDisplaySchema.optional(),
  launchOrigin: ExecutionRunLaunchOriginSchema.optional(),
  permissionMode: z.string().min(1),
  retentionPolicy: ExecutionRunRetentionPolicySchema,
  runClass: ExecutionRunClassSchema,
  ioMode: ExecutionRunIoModeSchema,
  profileId: z.string().trim().min(1).optional(),
  profileSourceCustody: PluginSourceCustodyV1Schema.optional(),
  /** Value-free Saved Secret binding overrides for this launch only. */
  secretReferenceOverlay: SecretReferenceOverlayV1Schema.optional(),
  initialContext: z.string().optional(),
  initialContextMode: z.enum(['bootstrap', 'first_turn']).optional(),
  bootstrapMode: z.enum(['none', 'ready_handshake']).optional(),
  resumeHandle: ExecutionRunResumeHandleSchema.nullable().optional(),
  replay: ExecutionRunReplaySeedRequestSchema.optional(),
  intentInput: z.unknown().optional(),
  /** Canonical host-owned structured input for the initial native turn. */
  structuredInput: HappierStructuredInputV1Schema.optional(),
  /** Stable host-authored identity for the initial native input. */
  localInputId: z.string().trim().min(1).optional(),
  /** Exact result requested for the initial native turn only. */
  resultContract: ExecutionRunResultContractV1Schema.optional(),
  /** Authored execution cwd; the daemon validates and binds it before start. */
  cwd: z.string().trim().min(1).optional(),
  /** Canonical managed MCP selection bound to this Run's working location. */
  mcpSelection: SessionMcpSelectionV1Schema.optional(),
  /**
   * Optional model selection for the run backend, reusing the SAME canonical `modelId` vocabulary
   * as session spawn (`SessionSpawnNewInputSchema.modelId`). Omitted ⇒ the backend's default model.
   * Threaded to the plugin backend spawn through the unified execution-run runtime; per-provider
   * application lives at each plugin's config seam (never a name-branch in shared runtime core).
   */
  modelId: z.string().min(1).optional(),
  /**
   * Exact Agent/Provider/model tuple for a Provider-bound bounded Agent run.
   * The run owner persists this re-resolvable reference and creates ephemeral
   * authorization/materialization state for every start or resume.
   */
  modelSelection: ProviderBoundModelRefSchema.optional(),
  /**
   * Exact recipient-safe Team resource/model selection for this Run. This is
   * mutually exclusive with an Account-local Provider selection and is
   * re-authorized by the Team resource owner for every start or resume.
   */
  teamCredentialModel: TeamCredentialProviderModelSelectionV1Schema.optional(),
  /**
   * Explicit consent for the attached parent Session transaction that may be
   * required by the selected Team resource's visibility policy. The exact
   * Session/resource/revision witness prevents a stale launcher decision from
   * authorizing a different selection. Detached starts deliberately omit it.
   */
  teamCredentialSessionBindingConsent: ExecutionRunTeamCredentialSessionBindingConsentV1Schema.optional(),
  /** Voice's chat model; when Provider-bound it must match top-level modelSelection. */
  chatModelId: z.string().min(1).optional(),
  /** Voice's independently selected commit model. */
  commitModelId: z.string().min(1).optional(),
  /**
   * Optional agent config-option overrides (e.g. reasoning effort) for the run backend, reusing the
   * SAME canonical `AcpConfigOptionOverridesV1` shape as session spawn — NOT a second vocabulary.
   * Action inputs may also pass a `configOptions` shorthand which is merged into this canonical
   * shape at the action boundary before the request is built.
   */
  sessionConfigOptionOverrides: AcpConfigOptionOverridesV1Schema.optional(),
  /**
   * Optional connected-services selection for the run backend (profile|group per serviceId),
   * mirroring session-spawn connected-services bindings. When omitted, the runtime applies the
   * SAME account-settings defaulting as session spawn. Null is the explicit all-services native
   * opt-out produced by the agent-friendly `"native"` shorthand. Connected selections fail closed:
   * the run does not start when the daemon cannot resolve + materialize the selected auth.
   */
  connectedServices: ConnectedServiceBindingsV2IngressSchema.nullable().optional(),
  /**
   * Bare per-service default tokens (RO-F5): serviceIds asking for their STORED account default. Set by
   * the action boundary alongside `connectedServices` so the run-start owner resolves each named
   * service's stored default and merges it UNDER explicit pins. Mixed bare+explicit thus resolves
   * instead of failing closed. Missing stored default fails closed at the run-start owner. On resume
   * this stays empty — the persisted selection already carries the resolved concrete bindings.
   */
  connectedServicesDefaultServiceIds: z.array(z.string()).optional(),
  notifyParentOnCompletion: z.boolean().optional(),
}).passthrough();

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
  ctx: z.RefinementCtx,
): void {
  if (value.resultContract && !value.localInputId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
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
      code: z.ZodIssueCode.custom,
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
      code: z.ZodIssueCode.custom,
      message: 'teamCredentialModel must target the execution-run backend',
      path: ['teamCredentialModel', 'agentTargetKey'],
    });
  }
  if (value.teamCredentialModel && value.modelSelection) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
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
        code: z.ZodIssueCode.custom,
        message: 'Session binding consent must exactly match the selected Team resource revision',
        path: ['teamCredentialSessionBindingConsent'],
      });
    }
  }
  if (value.intent === 'voice_agent' && value.teamCredentialModel) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'voice_agent does not use the Agent execution-run Provider launch path',
      path: ['teamCredentialModel'],
    });
  }
  if (
    value.intent === 'voice_agent'
    && value.modelSelection
    && value.chatModelId !== undefined
    && value.modelSelection.modelId !== value.chatModelId
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Voice chat modelSelection modelId must match chatModelId',
      path: ['modelSelection', 'modelId'],
    });
  }
  if (value.intent === 'voice_agent') {
    const parsedInput = ExecutionRunVoiceAgentIntentInputV1Schema.safeParse(value.intentInput ?? {});
    if (!parsedInput.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid voice_agent intentInput',
        path: ['intentInput'],
      });
    } else if (parsedInput.data.commitModelSelection) {
      if (
        parsedInput.data.commitModelSelection.agentTargetKey
          !== buildBackendTargetKeyV2(value.backendTarget)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Voice commit model selection must target the execution-run backend',
          path: ['intentInput', 'commitModelSelection', 'agentTargetKey'],
        });
      }
      if (
        value.commitModelId === undefined
        || parsedInput.data.commitModelSelection.modelId !== value.commitModelId
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Voice commit model selection modelId must match commitModelId',
          path: ['intentInput', 'commitModelSelection', 'modelId'],
        });
      }
    }
  }
  if (value.intent === 'task') {
    const instructions = typeof value.instructions === 'string' ? value.instructions.trim() : '';
    if (!instructions || instructions.length > EXECUTION_RUN_TASK_INSTRUCTIONS_MAX_CHARS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `task instructions must be between 1 and ${EXECUTION_RUN_TASK_INSTRUCTIONS_MAX_CHARS} characters`,
        path: ['instructions'],
      });
    }
    const parsedInput = ExecutionRunTaskIntentInputV1Schema.safeParse(value.intentInput ?? {});
    if (!parsedInput.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid task intentInput',
        path: ['intentInput'],
      });
    }
    if (value.permissionMode !== 'no_tools' && value.permissionMode !== 'read_only') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'task runs do not allow write-capable permission modes',
        path: ['permissionMode'],
      });
    }
    if (value.retentionPolicy !== 'ephemeral') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'task runs must use ephemeral retention',
        path: ['retentionPolicy'],
      });
    }
    if (value.runClass !== 'bounded') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'task runs must use bounded runClass',
        path: ['runClass'],
      });
    }
    if (value.ioMode !== 'request_response') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
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
        code: z.ZodIssueCode.custom,
        message: `agent instructions must be between 1 and ${EXECUTION_RUN_TASK_INSTRUCTIONS_MAX_CHARS} characters`,
        path: ['instructions'],
      });
    }
    if (defersToSessionPending) {
      if (value.instructions !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
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
          code: z.ZodIssueCode.custom,
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
          code: z.ZodIssueCode.custom,
          message: 'deferred Session Pending input requires a resumable long-lived Run',
          path: value.runClass !== 'long_lived' ? ['runClass'] : ['retentionPolicy'],
        });
      }
    }
    const parsedInput = ExecutionRunAgentIntentInputV1Schema.safeParse(value.intentInput ?? {});
    if (!parsedInput.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid agent intentInput',
        path: ['intentInput'],
      });
    } else if (
      value.resultContract
      && (parsedInput.data.resultContract || parsedInput.data.resultSchema)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'agent initial result contract must have one owner',
        path: ['resultContract'],
      });
    }
  }
  if (value.initialInput !== undefined && value.intent === 'scm_diff_summary') {
    if (value.instructions !== undefined || value.localInputId !== undefined || value.resultContract !== undefined || value.structuredInput !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'deferred SCM narration must not embed initial turn content or correspondence', path: ['initialInput'] });
    }
    if (value.runClass !== 'long_lived' || value.retentionPolicy !== 'resumable') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'deferred SCM narration requires a resumable long-lived Run', path: ['initialInput'] });
    }
  }
  if (value.initialInput !== undefined && value.intent !== 'agent' && value.intent !== 'scm_diff_summary') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
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
      code: z.ZodIssueCode.custom,
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
      code: z.ZodIssueCode.custom,
      message: 'teamCredentialModel modelId must match modelId',
      path: ['teamCredentialModel', 'modelId'],
    });
  }
  if (Object.prototype.hasOwnProperty.call(value, 'agentSessionStartupInstructionsV1')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Agent-session startup instructions are not supported for execution runs',
      path: ['agentSessionStartupInstructionsV1'],
    });
  }
  if (Boolean(value.profileId) !== Boolean(value.profileSourceCustody)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
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
      code: z.ZodIssueCode.custom,
      message: 'backendTarget must identify a concrete backend',
      path: ['backendTarget'],
    });
  }
  if (value.kind === 'scm_commit_message.v1' || value.intent === 'scm_commit_message') {
    if (value.kind !== 'scm_commit_message.v1') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'kind must be scm_commit_message.v1 for scm_commit_message runs',
        path: ['kind'],
      });
    }
    if (value.intent !== 'scm_commit_message') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'intent must be scm_commit_message for scm_commit_message.v1 runs',
        path: ['intent'],
      });
    }
    if (value.permissionMode !== 'no_tools' && value.permissionMode !== 'read_only') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'scm_commit_message.v1 does not allow write-capable permission modes',
        path: ['permissionMode'],
      });
    }
    if (value.retentionPolicy !== 'ephemeral') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'scm_commit_message.v1 must use ephemeral retention',
        path: ['retentionPolicy'],
      });
    }
    if (value.runClass !== 'bounded') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'scm_commit_message.v1 must use bounded runClass',
        path: ['runClass'],
      });
    }
    if (value.ioMode !== 'request_response') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'scm_commit_message.v1 must use request_response ioMode',
        path: ['ioMode'],
      });
    }
    const parsedInput = ExecutionRunScmCommitMessageInputV1Schema.safeParse(value.intentInput ?? {});
    if (!parsedInput.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid scm_commit_message.v1 intentInput',
        path: ['intentInput'],
      });
    }
  }
  if (value.kind === 'scm_diff_summary.v1' || value.intent === 'scm_diff_summary') {
    if (value.kind !== 'scm_diff_summary.v1') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'kind must be scm_diff_summary.v1 for scm_diff_summary runs',
        path: ['kind'],
      });
    }
    if (value.intent !== 'scm_diff_summary') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'intent must be scm_diff_summary for scm_diff_summary.v1 runs',
        path: ['intent'],
      });
    }
    if (value.permissionMode !== 'no_tools' && value.permissionMode !== 'read_only') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'scm_diff_summary.v1 does not allow write-capable permission modes',
        path: ['permissionMode'],
      });
    }
    if (value.retentionPolicy !== 'resumable') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'scm_diff_summary.v1 must use resumable retention',
        path: ['retentionPolicy'],
      });
    }
    if (value.runClass !== 'long_lived') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'scm_diff_summary.v1 must use long_lived runClass',
        path: ['runClass'],
      });
    }
    if (value.ioMode !== 'request_response' && value.ioMode !== 'streaming') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'scm_diff_summary.v1 must use request_response or streaming ioMode',
        path: ['ioMode'],
      });
    }
    const parsedInput = ExecutionRunScmDiffSummaryInputV1Schema.safeParse(value.intentInput ?? {});
    if (!parsedInput.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid scm_diff_summary.v1 intentInput',
        path: ['intentInput'],
      });
    }
  }
}

export const ExecutionRunStartRequestSchema = ExecutionRunStartRequestBaseSchema.superRefine(
  refineExecutionRunStartRequest,
);
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
export const ExecutionRunDetachedStartRequestV1Schema = ExecutionRunStartRequestBaseSchema.omit({
  kind: true,
  instructions: true,
  intentInput: true,
  initialContext: true,
  initialContextMode: true,
  bootstrapMode: true,
  replay: true,
  launchOrigin: true,
  teamCredentialSessionBindingConsent: true,
}).extend({
  intent: z.literal('task'),
  permissionMode: z.enum(['no_tools', 'read_only']),
  retentionPolicy: z.literal('ephemeral'),
  runClass: z.literal('bounded'),
  ioMode: z.literal('request_response'),
}).strict().superRefine((value, ctx) => {
  refineExecutionRunStartRequest({
    ...value,
    instructions: 'detached prompt supplied at dispatch',
    intentInput: {},
  }, ctx);
});
export type ExecutionRunDetachedStartRequestV1 = z.infer<typeof ExecutionRunDetachedStartRequestV1Schema>;
