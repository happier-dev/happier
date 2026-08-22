import { z } from 'zod';

import {
  BackendTargetRefV2Schema,
  buildBackendTargetKeyV2,
  normalizeBackendTargetRefV2InputToV2,
} from '../../backends/targets/backendTargetRefV2.js';
import { ProviderBoundModelRefSchema } from '../../providers/selection/v1.js';
import { ConnectedServiceBindingsV1Schema } from '../../connect/connectedServiceBindings.js';
import { AcpConfigOptionOverridesV1Schema } from '../../sessions/metadata/metadataOverridesV1.js';
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
import {
  ExecutionRunClassSchema,
  ExecutionRunIntentSchema,
  ExecutionRunIoModeSchema,
  ExecutionRunRetentionPolicySchema,
} from './runPrimitives.js';

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
  const providerSessionId = typeof record.providerSessionId === 'string' ? record.providerSessionId.trim() : '';
  const legacyVendorSessionId = typeof record.vendorSessionId === 'string' ? record.vendorSessionId.trim() : '';
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
          const chatProviderSessionId = typeof record.chatProviderSessionId === 'string'
            ? record.chatProviderSessionId.trim()
            : '';
          const commitProviderSessionId = typeof record.commitProviderSessionId === 'string'
            ? record.commitProviderSessionId.trim()
            : '';
          const legacyChatVendorSessionId = typeof record.chatVendorSessionId === 'string'
            ? record.chatVendorSessionId.trim()
            : '';
          const legacyCommitVendorSessionId = typeof record.commitVendorSessionId === 'string'
            ? record.commitVendorSessionId.trim()
            : '';
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
  providerSessionId: z.string().min(1),
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
  maxFiles: z.number().int().positive().max(100).optional(),
  maxTotalDiffChars: z.number().int().positive().max(400_000).optional(),
}).passthrough().superRefine((value, ctx) => {
  if (value.source.kind === 'turnCheckpoint' && !value.turnChangeSet) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'scm_diff_summary.v1 turnCheckpoint runs require CHKPT-2 TurnChangeSet evidence',
      path: ['turnChangeSet'],
    });
  }
});
export type ExecutionRunScmDiffSummaryInputV1 = z.infer<typeof ExecutionRunScmDiffSummaryInputV1Schema>;

export const ExecutionRunScmDiffSummaryResultV1Schema = ScmDiffSummaryGenerateOutputSchema;
export type ExecutionRunScmDiffSummaryResultV1 = z.infer<typeof ExecutionRunScmDiffSummaryResultV1Schema>;

export const ExecutionRunStartRequestBaseSchema = z.object({
  kind: ExecutionRunKindSchema.optional(),
  intent: ExecutionRunIntentSchema,
  backendTarget: z.preprocess(normalizeBackendTargetRefV2InputToV2, BackendTargetRefV2Schema),
  instructions: z.string().optional(),
  display: ExecutionRunDisplaySchema.optional(),
  permissionMode: z.string().min(1),
  retentionPolicy: ExecutionRunRetentionPolicySchema,
  runClass: ExecutionRunClassSchema,
  ioMode: ExecutionRunIoModeSchema,
  profileId: z.string().trim().min(1).optional(),
  profileGenerationId: z.string().trim().min(1).optional(),
  initialContext: z.string().optional(),
  initialContextMode: z.enum(['bootstrap', 'first_turn']).optional(),
  bootstrapMode: z.enum(['none', 'ready_handshake']).optional(),
  resumeHandle: ExecutionRunResumeHandleSchema.nullable().optional(),
  replay: ExecutionRunReplaySeedRequestSchema.optional(),
  intentInput: z.unknown().optional(),
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
   * SAME account-settings defaulting as session spawn. Connected selections fail closed: the
   * run does not start when the daemon cannot resolve + materialize the selected auth.
   */
  connectedServices: ConnectedServiceBindingsV1Schema.optional(),
  /**
   * Bare per-service default tokens (RO-F5): serviceIds asking for their STORED account default. Set by
   * the action boundary alongside `connectedServices` so the run-start owner resolves each named
   * service's stored default and merges it UNDER explicit pins. Mixed bare+explicit thus resolves
   * instead of failing closed. Missing stored default fails closed at the run-start owner. On resume
   * this stays empty — the persisted selection already carries the resolved concrete bindings.
   */
  connectedServicesDefaultServiceIds: z.array(z.string()).optional(),
}).passthrough();

type ExecutionRunStartRequestRefinementValue = Pick<
  z.output<typeof ExecutionRunStartRequestBaseSchema>,
  | 'backendTarget'
  | 'intent'
  | 'intentInput'
  | 'instructions'
  | 'ioMode'
  | 'kind'
  | 'chatModelId'
  | 'commitModelId'
  | 'modelId'
  | 'modelSelection'
  | 'permissionMode'
  | 'profileGenerationId'
  | 'profileId'
  | 'retentionPolicy'
  | 'runClass'
> & Readonly<Record<string, unknown>>;

export function refineExecutionRunStartRequest(
  value: ExecutionRunStartRequestRefinementValue,
  ctx: z.RefinementCtx,
): void {
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
  if (Object.prototype.hasOwnProperty.call(value, 'agentSessionStartupInstructionsV1')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Agent-session startup instructions are not supported for execution runs',
      path: ['agentSessionStartupInstructionsV1'],
    });
  }
  if (Boolean(value.profileId) !== Boolean(value.profileGenerationId)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'profileId and profileGenerationId must be provided together',
      path: value.profileId ? ['profileGenerationId'] : ['profileId'],
    });
  }
  if (hasLegacyCustomAcpConcreteBackendId(value.backendTarget)) {
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
    if (value.retentionPolicy !== 'ephemeral') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'scm_diff_summary.v1 must use ephemeral retention',
        path: ['retentionPolicy'],
      });
    }
    if (value.runClass !== 'bounded') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'scm_diff_summary.v1 must use bounded runClass',
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
