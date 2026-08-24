import { z } from 'zod';

import {
  assertPublicActionSdkMethodNames,
  resolveActionSdkMethodName,
} from './actionSdkMethodNames.js';

export { resolveActionSdkMethodName } from './actionSdkMethodNames.js';

import { ActionOperationDeclarationV1Schema } from './operations/v1.js';
import { AgentsBackendsListOutputSchema } from './agentBackendInventory.js';
import {
  ActionExecutionPlacementSchema,
  ActionInputHintsSchema,
  ActionRequiredAuthoritySchema,
  ActionSurfaceSchema,
  ActionToolExposureModeSchema,
  ActionToolExposureSchema,
  ActionToolExposureSurfaceSchema,
  type ActionExecutionPlacement,
  type ActionInputHints,
  type ActionRequiredAuthority,
  type ActionSurfaces,
  type ActionToolExposure,
  type ActionToolExposureMode,
  type ActionToolExposureSurface,
} from './metadata.js';

import type { ActionCaller } from './executor/types.js';
import type { ExternalActionTargetV1 } from './externalActionApi.js';
import { ActionSafetySchema } from './safety.js';
import {
  ConversationTurnOriginV1Schema,
  type ConversationTurnOriginV1,
} from '../messages/structured/conversationTurnOriginV1.js';
import {
  ACTION_IDS,
  ACTION_ID_FAMILIES_V1,
  ActionIdSchema,
  PLUGIN_DEV_LOOP_ACTION_IDS_V1,
  RUNTIME_ACTION_IDS_V1,
  isRuntimeActionIdV1,
  type ActionId,
  type PluginDevLoopActionIdV1,
  type RuntimeActionIdV1,
} from './actionIds.js';
import { ActionUiPlacementSchema, type ActionUiPlacement } from './actionUiPlacements.js';
import { ReviewStartInputSchema } from '../reviews/reviewStart.js';
import {
  REVIEW_COMMENT_ACTION_IDS_V1,
  ReviewCommentActionInputSchemasV1,
  ReviewCommentActionOutputSchemasV1,
  type ReviewCommentActionIdV1,
} from '../reviews/comments/actions.js';
import {
  PLUGIN_PERMISSION_GRANT_ACTION_IDS_V1,
  PluginPermissionGrantActionInputSchemasV1,
  PluginPermissionGrantActionOutputSchemasV1,
  type PluginPermissionGrantActionIdV1,
} from '../plugins/permissions/actions.js';
import { PluginPermissionSubjectV1Schema } from '../plugins/permissions/grants.js';
import {
  PLUGIN_WEBHOOK_ACTION_IDS_V1,
  PluginWebhookActionHttpPathsV1,
  PluginWebhookActionInputSchemasV1,
  PluginWebhookActionOutputSchemasV1,
  type PluginWebhookActionIdV1,
  type PluginWebhookPresentUserActionIdV1,
} from '../plugins/webhooks/endpointV1.js';
import {
  PluginAccountDataEraseActionInputV1Schema,
  PluginAccountDataEraseActionOutputV1Schema,
} from '../plugins/data/accountEraseV1.js';
import {
  AccountSessionsSignOutEverywhereActionInputV1Schema,
  AccountSessionsSignOutEverywhereActionOutputV1Schema,
} from '../auth/accountSessions.js';
import {
  AccountApiTokensCreateActionInputV1Schema,
  AccountApiTokensCreateActionOutputV1Schema,
  AccountApiTokensListActionInputV1Schema,
  AccountApiTokensListActionOutputV1Schema,
  AccountApiTokensRevokeActionInputV1Schema,
  AccountApiTokensRevokeActionOutputV1Schema,
  AccountApiTokensRevokeAllActionInputV1Schema,
  AccountApiTokensRevokeAllActionOutputV1Schema,
} from '../auth/accountApiTokens.js';
import {
  PLUGIN_SETTINGS_ADMINISTRATION_ACTION_IDS_V1,
  PluginSettingsAdministrationActionInputSchemasV1,
  PluginSettingsAdministrationActionOutputV1Schema,
  type PluginSettingsAdministrationActionIdV1,
} from '../plugins/settingsAdministration.js';
import {
  AUTOMATION_CONVERSATION_ACTION_IDS_V1,
  AutomationConversationActionInputSchemasV1,
  AutomationConversationActionOutputSchemasV1,
  type AutomationConversationActionIdV1,
  AUTOMATION_EVENT_ACTION_IDS_V1,
  AutomationEventActionInputSchemasV1,
  AutomationEventActionOutputSchemasV1,
  type AutomationEventActionIdV1,
} from '../automations/automationActionSpecsV1.js';
import {
  PluginContributionIdentityV1Schema,
  PluginContributionLocalIdSchema,
} from '../plugins/contributionIdentity.js';
import { PluginIdSchema } from '../plugins/pluginId.js';
import { CurrentUiContextSnapshotV1Schema } from '../plugins/ui/currentUiContext.js';
import {
  ActionInputFieldHintSchema,
  ActionInputOptionSchema,
  ActionInputOptionValueSchema,
  ActionInputWidgetSchema,
  readActionInputOptionValue,
  type ActionInputFieldHint,
  type ActionInputOption,
  type ActionInputOptionValue,
  type ActionInputWidget,
} from './actionInputHints.js';
import {
  MemorySearchQueryV1Schema,
  MemorySearchResultV1Schema,
} from '../memory/memorySearch.js';
import { MemoryWindowV1Schema } from '../memory/memoryWindow.js';
import {
  ApprovalRequestCreatedBySchema,
  ApprovalRequestOriginV1Schema,
  ApprovalRequestStatusSchema,
} from '../approvals/approvalRequestV1.js';
import {
  PromptRegistryConfiguredSourceV1Schema,
  PromptRegistryInstallRequestV1Schema,
  PromptRegistryScanSourceRequestV1Schema,
} from '../prompts/library/promptRegistriesV1.js';
import {
  PromptAssetDeleteRequestSchema,
  PromptAssetDiscoverRequestSchema,
  PromptAssetInstallModeV1Schema,
  PromptAssetScopeV1Schema,
} from '../prompts/library/promptAssetsV1.js';
import {
  DaemonFilesystemListDirectoryRequestSchema,
} from '../machines/fileBrowser.js';
import { BackendTargetKeySchema } from '../backends/targets/backendTargetRef.js';
import { BackendTargetKeyV2Schema, BackendTargetRefV2Schema } from '../backends/targets/backendTargetRefV2.js';
import { ConnectedServiceBindingsV1Schema } from '../connect/connectedServiceBindings.js';
import { normalizeConnectedServiceSelectionInput } from '../connect/normalizeConnectedServiceSelectionInput.js';
import { ExecutionRunListRequestSchema } from '../execution/runs/listRequest.js';
import {
  ExecutionRunGetResponseSchema,
  ExecutionRunListResponseSchema,
  ExecutionRunSendResponseSchema,
  ExecutionRunStartResponseSchema,
  ExecutionRunStopResponseSchema,
  ExecutionRunWaitResultSchema,
} from '../execution/runs/responseSchemas.js';
import {
  ExecutionRunTurnStreamCancelResponseSchema,
  ExecutionRunTurnStreamReadResponseSchema,
  ExecutionRunTurnStreamStartResponseSchema,
} from '../execution/runs/index.js';
import {
  ActionDefinitionSummaryV1Schema,
  ActionDefinitionV1Schema,
} from './actionDefinitionV1.js';
import {
  ExecutionRunStartRequestBaseSchema,
  ExecutionRunStartRequestSchema,
  refineExecutionRunStartRequest,
} from '../execution/runs/startRequest.js';
import { SessionMcpSelectionV1Schema } from '../mcp/servers/sessionSelectionV1.js';
import { AcpConfigOptionOverridesV1Schema } from '../sessions/metadata/metadataOverridesV1.js';
import { RuntimeDescriptorV1Schema } from '../sessions/metadata/runtimeDescriptorV1.js';
import {
  SessionSpawnNewInputV2Schema,
} from '../sessions/creation/sessionSpawnNewInputV2.js';
import { SessionSpawnNewResultV1Schema } from '../sessions/creation/sessionSpawnNewResultV1.js';
import { SessionCreationKeyV1Schema } from '../sessions/creation/sessionCreationIdentityV1.js';
import {
  PluginSessionInputIdempotencyKeyV1Schema,
  PluginSessionInputSourceV1Schema,
  SessionInputAdmissionResultV1Schema,
} from '../sessions/messages/sessionInputAdmission.js';
import { ExternalShareableTranscriptPageV1Schema } from '../sessions/messages/sessionExternalShareableTranscriptV1.js';
import { PendingLocalIdSchema } from '../sessions/pending/pendingLocalId.js';
import { PendingRequestedActionV1Schema } from '../sessions/pending/pendingRequestedActionV1.js';
import {
  SessionPermissionRemoteGrantRevokeInputV1Schema,
  SessionPermissionRemoteGrantRevokeOutputV1Schema,
  SessionPermissionRemoteGrantsListInputV1Schema,
  SessionPermissionRemoteGrantsListOutputV1Schema,
  SessionPermissionRemotePendingListInputV1Schema,
  SessionPermissionRemotePendingListOutputV1Schema,
  SessionPermissionRemoteRespondInputV1Schema,
  SessionPermissionRemoteRespondOutputV1Schema,
} from '../sessions/permissions/v1.js';
import { ProviderConnectionIdSchema } from '../providers/ids.js';
import {
  SpawnConfigOptionValueSchema,
  findSpawnConfigOptionAliasConflicts,
} from './sessionSpawnConfigOptions.js';
import {
  EXECUTION_RUN_ACTION_PERMISSION_MODES,
  EXECUTION_RUN_ACTION_PERMISSION_MODE_DESCRIPTION,
  ExecutionRunActionPermissionModeSchema,
} from './executionRunActionPermissionMode.js';
import { SessionWorkStateStatusV1Schema } from '../sessions/work/state/sessionWorkStateV1.js';
import { StructuredQuestionAnswersV1Schema } from '../tools/structuredQuestionAnswersV1.js';
import {
  SessionUsageLimitCheckNowRequestV1Schema,
  SessionUsageLimitConsumeResetCreditRequestV1Schema,
  SessionUsageLimitWaitResumeCancelRequestV1Schema,
  SessionUsageLimitWaitResumeEnableRequestV1Schema,
} from '../sessions/work/state/sessionWorkStateRpc.js';
import {
  ExternalSessionAttachRequestSchema,
  ExternalSessionAttachResponseSchema,
  ExternalSessionBackgroundFollowActionInputV1Schema,
  ExternalSessionBackgroundFollowActionResultV1Schema,
  ExternalSessionDetachRequestSchema,
  ExternalSessionDetachResponseSchema,
  ExternalSessionFollowPolicySetRequestSchema,
  ExternalSessionFollowPolicySetResponseSchema,
  ExternalSessionLinkEnsureRequestSchema,
  ExternalSessionLinkEnsureResponseSchema,
  ExternalSessionsCandidatesListRequestSchema,
  ExternalSessionsCandidatesListResponseSchema,
  ExternalSessionStatusGetRequestSchema,
  ExternalSessionStatusGetResponseSchema,
  ExternalSessionStatusActionInputV1Schema,
  ExternalSessionStatusActionResultV1Schema,
  ExternalSessionTranscriptPageRequestSchema,
  ExternalSessionTranscriptPageResponseSchema,
  ExternalSessionTranscriptReadAfterRequestSchema,
  ExternalSessionTranscriptReadAfterResponseSchema,
  ExternalSessionViewerFollowActionInputV1Schema,
  ExternalSessionViewerFollowActionResultV1Schema,
  ExternalSessionViewerUnfollowActionInputV1Schema,
  ExternalSessionViewerUnfollowActionResultV1Schema,
} from '../sessions/external/daemonRpcV1.js';
import {
  ExternalSessionTranscriptRefreshReadAfterRequestV1Schema,
  ExternalSessionTranscriptRefreshReadAfterResponseV1Schema,
} from '../sessions/external/secureRefreshV1.js';
import {
  ScmPullRequestCheckoutRequestSchema,
  ScmPullRequestCheckoutResponseSchema,
  ScmPullRequestGetRequestSchema,
  ScmPullRequestGetResponseSchema,
  ScmPullRequestListRequestSchema,
  ScmPullRequestListResponseSchema,
  ScmPullRequestOpenComposeRequestSchema,
  ScmPullRequestOpenComposeResponseSchema,
  ScmPullRequestOpenOrReuseRequestSchema,
  ScmPullRequestOpenOrReuseResponseSchema,
  ScmPullRequestPrepareWorktreeRequestSchema,
  ScmPullRequestPrepareWorktreeResponseSchema,
  ScmPullRequestRunStackedRequestSchema,
  ScmPullRequestRunStackedResponseSchema,
} from '../scm/pullRequests.js';
import {
  ScmRepositoryCloneInputSchema,
  ScmRepositoryCloneOutputSchema,
  SourceControlCloneProtocolSchema,
  type SourceControlCloneProtocol,
} from '../scm/repositoryClone.js';
import {
  ScmHostingRepositoryDescribePublishTargetsRequestSchema,
  ScmHostingRepositoryDescribePublishTargetsResponseSchema,
  ScmHostingRepositoryPublishRequestSchema,
  ScmHostingRepositoryPublishResponseSchema,
  ScmRepositoryInitRequestSchema,
  ScmRepositoryInitResponseSchema,
  ScmRepositoryRemoveIndexLockRequestSchema,
  ScmRepositoryRemoveIndexLockResponseSchema,
} from '../scm/repositoryProvisioning.js';
import {
  ScmDiffSummaryGenerateInputSchema,
  ScmDiffSummaryGenerateOutputSchema,
} from '../scm/diffSummary.js';
import {
  SkillCatalogItemV1Schema,
  SkillCatalogV1Schema,
  VendorPluginCatalogItemV1Schema,
  VendorPluginCatalogV1Schema,
} from '../runtime/catalog/index.js';
import {
  ExternalSessionTakeoverInputV1Schema,
  ExternalSessionTakeoverResultV1Schema,
} from '../sessions/external/takeoverV1.js';
import {
  ExternalSessionMaterializeStartInputV1Schema,
  ExternalSessionMaterializeActionInputV1Schema,
  ExternalSessionMaterializeActionResultV1Schema,
  ExternalSessionOperationActionResultV1Schema,
  ExternalSessionOperationActionResponseV1Schema,
  ExternalSessionOperationCancelInputV1Schema,
  ExternalSessionOperationDiscardInputV1Schema,
  ExternalSessionOperationResumeInputV1Schema,
  ExternalSessionOperationRetryInputV1Schema,
  ExternalSessionOperationStatusInputV1Schema,
  ExternalSessionOperationTransportReferenceV1Schema,
  ExternalSessionTakeoverStartInputV1Schema,
  projectExternalSessionMaterializeActionResultV1,
  projectExternalSessionOperationActionResultV1,
} from '../sessions/external/operationActionSchemasV1.js';
import {
  PLUGIN_SESSION_HOOK_STATUS_INVENTORY_DEFAULT_LIMIT,
  PLUGIN_SESSION_HOOK_STATUS_INVENTORY_MAX_ROWS,
  PluginSessionHookInstallActionInputV1Schema,
  PluginSessionHookInstallInputV1Schema,
  PluginSessionHookInstallResponseV1Schema,
  PluginSessionHookInstallationMutationActionInputV1Schema,
  PluginSessionHookInstallationMutationInputV1Schema,
  PluginSessionHookStatusActionInputV1Schema,
  PluginSessionHookStatusInputV1Schema,
  PluginSessionHookStatusResponseV1Schema,
  PluginSessionHookToggleResponseV1Schema,
  PluginSessionHookUninstallResponseV1Schema,
} from '../sessions/external/hookManagementV1.js';
import {
  SubagentLifecycleDetailV1Schema,
  SubagentRefInputV1Schema,
  SubagentRefV1Schema,
  SubagentStatusV1Schema,
} from '../sessions/subagents/subagentRefV1.js';
import { SessionRollbackTargetSchema } from '../sessions/rollback.js';
import {
  CheckpointCodeRollbackRequestSchema,
  CheckpointCodeRollbackActionRequestSchema,
  CheckpointCodeRollbackResultSchema,
} from '../sessions/control/rollback/checkpointCodeRollback.js';
import {
  SessionCheckpointRequestV1Schema,
  SessionCheckpointResultV1Schema,
  SessionRestoreRequestV1Schema,
  SessionRestoreResultV1Schema,
} from '../sessions/control/checkpoints/v1.js';
import {
  SessionTerminalComposerClearRequestV1Schema,
  SessionTerminalComposerClearResultV1Schema,
} from '../sessions/control/terminalComposerClearV1.js';
import {
  SessionPendingInputInterruptAndRunRequestV1Schema,
  SessionPendingInputInterruptAndRunResultV1Schema,
} from '../sessions/control/pendingInputInterruptAndRunV1.js';
import {
  SessionHandoffAbortRequestSchema,
  SessionHandoffCommitRequestSchema,
  SessionHandoffPrepareTargetResultGetRequestSchema,
  SessionHandoffPrepareTargetResultGetResponseSchema,
  SessionHandoffPrepareTargetRequestSchema,
  SessionHandoffPrepareTargetResumeRequestSchema,
  SessionHandoffPrepareTargetResumeResponseSchema,
  SessionHandoffStatusGetRequestSchema,
  SessionHandoffWorkspaceTransferSchema,
} from '../sessions/control/handoff/handoffSchemas.js';
import { SessionContinueWithReplayRpcParamsSchema } from '../sessions/continueWithReplay.js';
import { RPC_METHODS, SESSION_RPC_METHODS } from '../rpc/methods.js';
import { resolveActionBackendTargetSelection } from './resolveActionBackendTargetSelection.js';
import {
  RUNTIME_ACTION_INPUT_SCHEMAS,
  RUNTIME_ACTION_OUTPUT_SCHEMAS,
  RUNTIME_ACTION_SPECS,
} from './specs/index.js';
import { ActionApprovalSchema, type ActionApproval } from './actionApprovalMetadata.js';
import { StrictJsonValueSchema } from '../json/strictJsonValue.js';
import { asProtocolZod } from "../plugins/actions/internalProtocolZodAdapter.js";
import {
  ActionContextualDefaultsSchema,
  type ActionContextualDefaults,
} from './contextualDefaults.js';

export {
  ActionContextualDefaultsSchema,
  type ActionContextualDefaults,
} from './contextualDefaults.js';

export {
  RuntimeActionHostEffectClassSchema,
  resolveRuntimeActionHostEffectClass,
  type RuntimeActionHostEffectClass,
} from './safety.js';

export {
  ActionApprovalFlowSchema,
  ActionApprovalResultSchema,
  ActionApprovalSchema,
  resolveActionApprovalFlow,
  type ActionApproval,
  type ActionApprovalFlow,
  type ActionApprovalResult,
} from './actionApprovalMetadata.js';

const ZodSchemaLike = z.custom<z.ZodTypeAny>((value) => {
  if (!value || typeof value !== 'object') return false;
  const v = value as any;
  return typeof v.safeParse === 'function' && typeof v.parse === 'function';
}, { message: 'Expected a Zod schema' });

export type ActionSurfaceBindingCaller = ActionCaller;

export type ActionSurfaceBindingContext = Readonly<{
  actionId: ActionId;
  surface: 'api' | 'rpc' | 'plugin';
  caller: ActionSurfaceBindingCaller;
  defaultSessionId?: string | null;
  serverId?: string | null;
  externalActionTarget?: ExternalActionTargetV1;
  signal?: AbortSignal;
  input?: unknown;
}>;

export type ActionSurfaceBindingTransform = (
  value: unknown,
  context: ActionSurfaceBindingContext,
) => unknown | Promise<unknown>;

const ActionSurfaceBindingTransformSchema = z.custom<ActionSurfaceBindingTransform>(
  (value) => typeof value === 'function',
  { message: 'Expected an Action surface binding transform' },
);

export const ActionSpecSurfaceBindingsSchema = z.object({
  api: z.object({
    inputSchema: ZodSchemaLike,
    bindInput: ActionSurfaceBindingTransformSchema.optional(),
    inputHints: ActionInputHintsSchema.optional(),
  }).strict().optional(),
  rpc: z.object({
    inputSchema: ZodSchemaLike,
    decodeInput: ActionSurfaceBindingTransformSchema,
    outputSchema: ZodSchemaLike,
    encodeOutput: ActionSurfaceBindingTransformSchema,
  }).strict().optional(),
  plugin: z.object({
    inputSchema: ZodSchemaLike.optional(),
    bindInput: ActionSurfaceBindingTransformSchema.optional(),
    outputSchema: ZodSchemaLike.optional(),
    projectOutput: ActionSurfaceBindingTransformSchema.optional(),
  }).strict().optional(),
}).strict();
export type ActionSpecSurfaceBindings = z.infer<typeof ActionSpecSurfaceBindingsSchema>;

const ActionPluginCallerAdministrativeSelectorSchema = z.object({
  pluginId: asProtocolZod(PluginIdSchema),
  contributionLocalId: asProtocolZod(PluginContributionLocalIdSchema),
}).strict();

/**
 * A host Action's explicit authority contract when it is callable by a
 * plugin. `caller` requires a current host-stamped plugin caller at the
 * canonical executor: the host proves the call really came from the claimed
 * plugin materialization. Further identity projection occurs only where an
 * incumbent domain owner has caller-dependent authorization — for example the
 * Account-scoped Automation owner, which fences its own reads by Account and
 * current materialization rather than by which plugin is asking — and it never
 * grants authority over another plugin. `self_or_inspector_admin` is reserved
 * for the one plugin-targeted host Action and makes its exceptional Inspector
 * administration visible at the Action declaration owner.
 */
export const ActionPluginCallerPolicySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('caller'),
  }).strict(),
  z.object({
    kind: z.literal('self_or_inspector_admin'),
    targetPluginIdField: z.literal('pluginId'),
    administrativeCallers: z.array(ActionPluginCallerAdministrativeSelectorSchema).min(1),
  }).strict(),
]);
export type ActionPluginCallerPolicy = z.infer<typeof ActionPluginCallerPolicySchema>;

export { ActionSafetySchema, type ActionSafety } from './safety.js';
export {
  ActionExecutionPlacementSchema,
  ActionInputHintsSchema,
  ActionRequiredAuthoritySchema,
  ActionSurfaceSchema,
  ActionToolExposureModeSchema,
  ActionToolExposureSchema,
  ActionToolExposureSurfaceSchema,
  type ActionExecutionPlacement,
  type ActionInputHints,
  type ActionRequiredAuthority,
  type ActionSurfaces,
  type ActionToolExposure,
  type ActionToolExposureMode,
  type ActionToolExposureSurface,
} from './metadata.js';
export {
  ActionInputFieldHintSchema,
  ActionInputOptionSchema,
  ActionInputOptionValueSchema,
  ActionInputWidgetSchema,
  readActionInputOptionValue,
  type ActionInputFieldHint,
  type ActionInputOption,
  type ActionInputOptionValue,
  type ActionInputWidget,
} from './actionInputHints.js';

export const ActionPromptingSchema = z
  .object({
    voiceHotPath: z.boolean().optional(),
  })
  .passthrough();
export type ActionPrompting = z.infer<typeof ActionPromptingSchema>;

export const ActionSpecSchema = z.object({
  id: ActionIdSchema,
  title: z.string().min(1),
  description: z.string().min(1).optional(),
  safety: ActionSafetySchema,
  approval: ActionApprovalSchema,
  // UI placements where the action can appear when the relevant surface is enabled.
  placements: z.array(ActionUiPlacementSchema).default([]),
  // Optional stable slash command token for UI slash-command placement.
  slash: z.object({
    tokens: z.array(z.string().min(1)),
  }).passthrough().optional(),
  bindings: z.object({
    // Tool name the voice client is allowed to expose (surface.voice).
    voiceClientToolName: z.string().min(1).optional(),
    // Tool name for MCP surface (surface.mcp).
    mcpToolName: z.string().min(1).optional(),
    // Optional generated SDK method-name override. Most public Actions derive
    // their path from the canonical Action id; overrides only resolve a real
    // namespace collision.
    sdkMethod: z.string().min(1).optional(),
    // RPC method exposed when surface.rpc is true.
    rpcMethod: z.string().min(1).optional(),
    // Wire aliases accepted alongside the canonical method until their owning compatibility packet removes them.
    rpcMethodAliases: z.array(z.string().min(1)).optional(),
  }).passthrough().optional(),
  surfaceBindings: ActionSpecSurfaceBindingsSchema.optional(),
  outputSchema: ZodSchemaLike.optional(),
  execution: z
    .object({
      handler: z.string().min(1).optional(),
      transport: z.enum(['host', 'plugin', 'rpc', 'api']).optional(),
    })
    .passthrough()
    .optional(),
  sideEffectClass: z.enum(['none', 'read', 'write', 'external', 'danger']).optional(),
  examples: z
    .object({
      voice: z
        .object({
          argsExample: z.string().min(1).optional(),
        })
        .passthrough()
        .optional(),
      mcp: z
        .object({
          argsExample: z.string().min(1).optional(),
        })
        .passthrough()
        .optional(),
      sdk: z
        .object({
          codeExample: z.string().min(1).optional(),
        })
        .passthrough()
        .optional(),
    })
    .passthrough()
    .optional(),
  prompting: ActionPromptingSchema.optional(),
  toolExposure: ActionToolExposureSchema.optional(),
  contextualDefaults: ActionContextualDefaultsSchema.optional(),
  operation: ActionOperationDeclarationV1Schema.optional(),
  /** Host-owned admission floor; public callers never supply this in Action input. */
  requiredAuthority: ActionRequiredAuthoritySchema.optional(),
  /** Host-owned routing placement; public callers never supply this in Action input. */
  executionPlacement: ActionExecutionPlacementSchema.optional(),
  /** Explicit host-stamped caller authority for a Plugin Action. */
  pluginCallerPolicy: ActionPluginCallerPolicySchema.optional(),
  surfaces: ActionSurfaceSchema,
  inputSchema: ZodSchemaLike,
  inputHints: ActionInputHintsSchema.optional(),
}).passthrough().superRefine((value, ctx) => {
  if ((value.placements?.length ?? 0) > 0 && !value.surfaces.ui) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'placements require surface.ui',
      path: ['surfaces', 'ui'],
    });
  }
  if (value.surfaces.rpc && !value.bindings?.rpcMethod) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'surface.rpc requires bindings.rpcMethod',
      path: ['bindings', 'rpcMethod'],
    });
  }
  if (value.surfaces.mcp && !value.bindings?.mcpToolName) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'surface.mcp requires bindings.mcpToolName',
      path: ['bindings', 'mcpToolName'],
    });
  }
  if (value.surfaces.mcp && !value.outputSchema) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'surface.mcp requires outputSchema',
      path: ['outputSchema'],
    });
  }
  if (value.surfaces.plugin && !value.outputSchema) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'surface.plugin requires outputSchema',
      path: ['outputSchema'],
    });
  }
  if (value.surfaces.plugin && value.inputSchema instanceof z.ZodUnknown) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'surface.plugin requires a representable input schema',
      path: ['inputSchema'],
    });
  }
  if (value.surfaces.plugin && value.outputSchema instanceof z.ZodUnknown) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'surface.plugin requires a representable output schema',
      path: ['outputSchema'],
    });
  }
  const nonSafePluginAction = value.surfaces.plugin && value.safety !== 'safe';
  if (nonSafePluginAction && !value.pluginCallerPolicy) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'non-safe surface.plugin requires pluginCallerPolicy',
      path: ['pluginCallerPolicy'],
    });
  }
  if (!value.surfaces.plugin && value.pluginCallerPolicy) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'pluginCallerPolicy requires a surface.plugin Action',
      path: ['pluginCallerPolicy'],
    });
  }
  if (value.surfaceBindings?.rpc && !value.surfaces.rpc) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'surfaceBindings.rpc requires surface.rpc',
      path: ['surfaceBindings', 'rpc'],
    });
  }
  if (value.surfaceBindings?.plugin && !value.surfaces.plugin) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'surfaceBindings.plugin requires surface.plugin',
      path: ['surfaceBindings', 'plugin'],
    });
  }
  if (value.surfaceBindings?.plugin?.bindInput && !value.surfaceBindings.plugin.inputSchema) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'surfaceBindings.plugin.bindInput requires a caller input schema',
      path: ['surfaceBindings', 'plugin', 'inputSchema'],
    });
  }
});

export type ActionSpec = z.infer<typeof ActionSpecSchema> & Readonly<{
  placements: ActionUiPlacement[];
  requiredAuthority: ActionRequiredAuthority;
  executionPlacement: ActionExecutionPlacement;
}>;

/**
 * Evaluates the declaration-owned policy against host-stamped caller
 * provenance. Action input never manufactures, widens, or narrows caller
 * authority: it is read only to name the plugin the call *targets*, and the
 * target is then compared against the stamped caller.
 */
export function isPluginActionCallerPolicySatisfied(
  policy: ActionPluginCallerPolicy | undefined,
  input: unknown,
  caller: ActionCaller | undefined,
): boolean {
  if (!policy || caller?.kind !== 'plugin') return false;
  if (policy.kind === 'caller') return true;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;

  const targetPluginId = (input as Readonly<Record<string, unknown>>)[policy.targetPluginIdField];
  if (typeof targetPluginId !== 'string') return false;
  if (targetPluginId === caller.pluginId) return true;

  return policy.administrativeCallers.some((administrator) => (
    administrator.pluginId === caller.pluginId
    && administrator.contributionLocalId === caller.contributionLocalId
  ));
}

type ParsedActionSpec = z.infer<typeof ActionSpecSchema>;
export type ActionSpecWithoutApproval = Readonly<{
  id: ParsedActionSpec['id'];
  title: ParsedActionSpec['title'];
  description?: ParsedActionSpec['description'];
  safety: ParsedActionSpec['safety'];
  placements: readonly ActionUiPlacement[];
  slash?: ParsedActionSpec['slash'];
  bindings?: ParsedActionSpec['bindings'];
  surfaceBindings?: ParsedActionSpec['surfaceBindings'];
  outputSchema?: ParsedActionSpec['outputSchema'];
  execution?: ParsedActionSpec['execution'];
  sideEffectClass?: ParsedActionSpec['sideEffectClass'];
  examples?: ParsedActionSpec['examples'];
  prompting?: ParsedActionSpec['prompting'];
  toolExposure?: ParsedActionSpec['toolExposure'];
  contextualDefaults?: ParsedActionSpec['contextualDefaults'];
  operation?: ParsedActionSpec['operation'];
  requiredAuthority?: ParsedActionSpec['requiredAuthority'];
  executionPlacement?: ParsedActionSpec['executionPlacement'];
  pluginCallerPolicy?: ParsedActionSpec['pluginCallerPolicy'];
  surfaces: ParsedActionSpec['surfaces'];
  inputSchema: ParsedActionSpec['inputSchema'];
  inputHints?: ParsedActionSpec['inputHints'];
}>;

/**
 * Author-owned Action rows intentionally omit the derived API and Plugin
 * exposure bits. Those values are assigned once by normalizeActionPublicExposure
 * from the canonical internal/provenance classification below.
 */
export type PreNormalizedActionSurfaces = Omit<ActionSurfaces, 'api' | 'plugin'> & Readonly<{
  api?: never;
  plugin?: never;
}>;
export type ActionSpecDefinition = Omit<ActionSpecWithoutApproval, 'surfaces'> & Readonly<{
  surfaces: PreNormalizedActionSurfaces;
}>;
export type PreNormalizedActionSpec = ActionSpecDefinition;
type NormalizedActionSpec = ActionSpecWithoutApproval;

/**
 * Keeps each registry row's literal id and concrete Zod schema types intact.
 * Runtime validation still goes through ActionSpecSchema; this helper exists so
 * generated author projections do not widen back to ActionId/ZodTypeAny.
 */
export function defineActionSpecs<const TSpecs extends readonly PreNormalizedActionSpec[]>(
  specs: TSpecs,
): TSpecs {
  return specs;
}

const DAEMON_ADMIN_RPC_SURFACES = Object.freeze({
  ui: false,
  voice: false,
  agent: false,
  mcp: false,
  cli: false,
  rpc: true,
} satisfies PreNormalizedActionSurfaces);

const DAEMON_ADMIN_INPUT_HINTS = Object.freeze({
  fields: [],
} satisfies ActionInputHints);

const EmptyObjectSchema = z.object({}).strict();
const PassthroughEmptyObjectSchema = z.object({}).passthrough();
const DaemonFilesystemReadFileInputSchema = z.object({
  path: z.string().min(1),
}).passthrough();
const DaemonFilesystemWriteFileInputSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  expectedHash: z.string().nullable().optional(),
}).passthrough();
const DaemonFilesystemListDirectoryInputSchema = z.object({
  path: z.string().min(1),
}).passthrough();
const DaemonFilesystemGetDirectoryTreeInputSchema = z.object({
  path: z.string().min(1),
  maxDepth: z.number().int().min(0),
}).passthrough();
const BugReportGetLogTailInputSchema = z.object({
  path: z.string().min(1).optional(),
  maxBytes: z.number().int().min(1024).max(1_000_000).optional(),
}).passthrough();
const BugReportUploadArtifactInputSchema = z.object({
  uploadUrl: z.string().optional(),
}).passthrough();
const OptionalSessionIdInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
}).passthrough();

const SessionIdRequiredInputSchema = z.object({
  sessionId: z.string().min(1),
}).passthrough();

const SessionTitleSetInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  title: z.string().trim().min(1),
}).passthrough();

const SessionPermissionModeSetInputSchema = z.object({
  sessionId: z.string().min(1),
  permissionMode: z.string().trim().min(1),
}).passthrough();

const SessionModelSetInputSchema = z.object({
  sessionId: z.string().min(1),
  modelId: z.string().trim().min(1),
  providerConnectionId: ProviderConnectionIdSchema.nullable().optional(),
}).passthrough();

const SessionStatusGetInputSchema = z.object({
  sessionId: z.string().min(1),
  live: z.boolean().optional(),
}).passthrough();

const SessionHistoryGetInputSchema = z.object({
  sessionId: z.string().min(1),
  limit: z.number().int().min(1).max(250).optional(),
  format: z.enum(['compact', 'raw']).optional(),
  includeMeta: z.boolean().optional(),
  includeStructuredPayload: z.boolean().optional(),
}).passthrough();

const SessionTranscriptRoleSchema = z.enum(['user', 'assistant']);
const SessionStoredTranscriptRoleSchema = z.enum(['user', 'agent', 'event', 'unknown']);

const SessionTranscriptGetExternalShareableProjectionSchema = z.literal('externalShareableV1');

/**
 * The largest page `session.transcript.get` will return for one request.
 *
 * Named here because the bound has consumers outside the schema: the reader
 * clamps to it, and a caller that wants the fewest possible round trips asks
 * for exactly it. Each of those was carrying its own copy of the number, so
 * lowering the bound left them confidently over-asking.
 */
export const SESSION_TRANSCRIPT_GET_MAX_LIMIT = 100;

const SessionTranscriptGetInputShape = {
  sessionId: z.string().min(1),
  projection: SessionTranscriptGetExternalShareableProjectionSchema.optional(),
  limit: z.number().int().min(1).max(SESSION_TRANSCRIPT_GET_MAX_LIMIT).optional(),
  cursor: z.string().min(1).nullable().optional(),
  direction: z.enum(['before', 'after']).optional(),
  scope: z.enum(['main', 'sidechain', 'all']).optional(),
  sidechainId: z.string().min(1).nullable().optional(),
  roles: z.array(SessionTranscriptRoleSchema).optional(),
  includeTools: z.boolean().optional(),
  includeReasoning: z.boolean().optional(),
  includeEvents: z.boolean().optional(),
  includeMeta: z.boolean().optional(),
  includeStructuredPayload: z.boolean().optional(),
  includeRaw: z.boolean().optional(),
  maxCharsPerMessage: z.number().int().min(0).max(50_000).nullable().optional(),
  maxRawPayloadChars: z.number().int().min(1).max(32768).nullable().optional(),
};

/** Exact public input for the closed external-shareable transcript projection. */
export const SessionTranscriptGetExternalShareableInputV1Schema = z.object({
  sessionId: SessionTranscriptGetInputShape.sessionId,
  projection: SessionTranscriptGetExternalShareableProjectionSchema,
  limit: SessionTranscriptGetInputShape.limit,
  cursor: SessionTranscriptGetInputShape.cursor,
}).strict();
export type SessionTranscriptGetExternalShareableInputV1 = z.infer<
  typeof SessionTranscriptGetExternalShareableInputV1Schema
>;

export const SessionTranscriptGetInputSchema = z.object(SessionTranscriptGetInputShape).passthrough().superRefine((value, context) => {
  if (value.projection !== 'externalShareableV1') return;
  const allowedKeys = new Set(['sessionId', 'projection', 'cursor', 'limit']);
  for (const key of Object.keys(value)) {
    if (allowedKeys.has(key)) continue;
    context.addIssue({
      code: 'custom',
      path: [key],
      message: `${key} is not accepted by the externalShareableV1 projection`,
    });
  }
});
export type SessionTranscriptGetInput = z.infer<typeof SessionTranscriptGetInputSchema>;
const SessionTranscriptSemanticRoleSchema = z.enum([
  'user',
  'assistant',
  'tool',
  'event',
  'reasoning',
  'unknown',
]);
const SessionTranscriptStoredMessageRoleSchema = z.enum(['user', 'agent', 'event', 'unknown']);
const SessionTranscriptGetItemSchema = z.object({
  id: z.string(),
  seq: z.number().int().nonnegative().optional(),
  createdAt: z.number().int().nonnegative(),
  storedMessageRole: SessionTranscriptStoredMessageRoleSchema.optional(),
  semanticRole: SessionTranscriptSemanticRoleSchema,
  role: SessionTranscriptSemanticRoleSchema,
  kind: z.string(),
  origin: ConversationTurnOriginV1Schema.optional(),
  provider: z.string().optional(),
  text: z.string().optional(),
  summary: z.string().optional(),
  toolName: z.string().optional(),
  callId: z.string().optional(),
  raw: z.unknown().optional(),
  truncated: z.boolean().optional(),
  rawTruncated: z.boolean().optional(),
}).strict();
export type SessionTranscriptGetItem = z.infer<typeof SessionTranscriptGetItemSchema>;

const SessionTranscriptGetSemanticSuccessSchema = z.object({
  ok: z.literal(true),
  sessionId: z.string().min(1),
  items: z.array(SessionTranscriptGetItemSchema).readonly(),
  nextCursor: z.string().min(1).nullable(),
  hasMore: z.boolean(),
  diagnostics: z.object({
    rawRowsScanned: z.number().int().nonnegative(),
    pagesFetched: z.number().int().nonnegative(),
    scanLimitReached: z.boolean(),
    payloadTruncations: z.number().int().nonnegative(),
  }).strict(),
}).strict();

export const SessionTranscriptGetExternalShareableResultV1Schema = ExternalShareableTranscriptPageV1Schema.extend({
  ok: z.literal(true),
  sessionId: z.string().min(1),
  projection: z.literal('externalShareableV1'),
}).strict();

const SessionTranscriptGetErrorSchema = z.object({
  ok: z.literal(false),
  errorCode: z.string().min(1),
  errorMessage: z.string().min(1),
  candidates: z.array(z.string().min(1)).readonly().optional(),
}).strict();

/** Canonical strict result envelope for every session.transcript.get Action path. */
export const SessionTranscriptGetResultSchema = z.union([
  SessionTranscriptGetSemanticSuccessSchema,
  SessionTranscriptGetExternalShareableResultV1Schema,
  SessionTranscriptGetErrorSchema,
]);
export type SessionTranscriptGetResult = z.infer<typeof SessionTranscriptGetResultSchema>;
export type SessionTranscriptGetExternalShareableResultV1 = z.infer<
  typeof SessionTranscriptGetExternalShareableResultV1Schema
>;
export type SessionTranscriptGetOutput = SessionTranscriptGetResult;

export const SessionEventsGetInputSchema = z.object({
  sessionId: z.string().min(1),
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).nullable().optional(),
  direction: z.enum(['before', 'after']).optional(),
  scope: z.enum(['main', 'sidechain', 'all']).optional(),
  sidechainId: z.string().min(1).nullable().optional(),
  roles: z.array(SessionStoredTranscriptRoleSchema).optional(),
  kinds: z.array(z.string().min(1)).optional(),
  format: z.enum(['compact', 'raw']).optional(),
  includeMeta: z.boolean().optional(),
  includeStructuredPayload: z.boolean().optional(),
  includeRaw: z.boolean().optional(),
  maxTextChars: z.number().int().min(0).max(4000).optional(),
  maxPayloadChars: z.number().int().min(1).max(32768).optional(),
}).passthrough();
export type SessionEventsGetInput = z.infer<typeof SessionEventsGetInputSchema>;
export type SessionEventsGetItem = Readonly<{
  id: string;
  seq?: number;
  createdAt: number;
  storedMessageRole?: 'user' | 'agent' | 'event' | 'unknown';
  semanticRole: 'user' | 'assistant' | 'tool' | 'event' | 'reasoning' | 'unknown';
  kind: string;
  origin?: ConversationTurnOriginV1;
  provider?: string;
  text?: string;
  summary?: string;
  toolName?: string;
  callId?: string;
  raw?: unknown;
  truncated?: boolean;
  rawTruncated?: boolean;
}>;
export type SessionEventsGetOutput =
  | Readonly<{
      ok: true;
      sessionId: string;
      items: readonly SessionEventsGetItem[];
      nextCursor: string | null;
      hasMore: boolean;
      diagnostics?: Readonly<{
        rawRowsScanned: number;
        pagesFetched: number;
        scanLimitReached: boolean;
        payloadTruncations: number;
      }>;
    }>
  | Readonly<{
      ok: false;
      errorCode: string;
      errorMessage: string;
      candidates?: readonly string[];
    }>;

const SessionWaitIdleInputSchema = z.object({
  sessionId: z.string().min(1),
  timeoutSeconds: z.number().int().min(1).max(3600).optional(),
}).passthrough();

const SessionGoalSetInputSchema = z.object({
  sessionId: z.string().min(1),
  objective: z.string().trim().min(1).max(4000).optional(),
  status: SessionWorkStateStatusV1Schema.optional(),
  tokenBudget: z.number().finite().positive().nullable().optional(),
}).passthrough().refine((value) => (
  typeof value.objective === 'string'
  || typeof value.status === 'string'
  || Object.prototype.hasOwnProperty.call(value, 'tokenBudget')
), { message: 'At least one goal mutation field is required' });

const SessionCatalogListInputSchema = z.object({
  sessionId: z.string().min(1),
  cwd: z.string().min(1).optional(),
}).passthrough();

const SessionVendorPluginCatalogListOutputSchema = z.object({
  supported: z.boolean().optional(),
  unsupported: z.literal(true).optional(),
  vendorPlugins: z.array(VendorPluginCatalogItemV1Schema).readonly(),
  catalog: VendorPluginCatalogV1Schema.optional(),
  diagnostic: z.string().min(1).optional(),
}).passthrough();

const SessionSkillCatalogListOutputSchema = z.object({
  supported: z.boolean().optional(),
  unsupported: z.literal(true).optional(),
  skills: z.array(SkillCatalogItemV1Schema).readonly(),
  catalog: SkillCatalogV1Schema.optional(),
  diagnostic: z.string().min(1).optional(),
}).passthrough();

const BackendTargetKeyInputSchema = z.union([BackendTargetKeySchema, BackendTargetKeyV2Schema]);

const IntentStartCommonSchema = z.object({
  sessionId: z.string().min(1).optional(),
  backendTargetKeys: z.array(BackendTargetKeyInputSchema).min(1),
  instructions: z.string().trim().min(1),
  permissionMode: ExecutionRunActionPermissionModeSchema.optional(),
  retentionPolicy: z.enum(['ephemeral', 'resumable']).optional(),
  runClass: z.enum(['bounded', 'long_lived']).optional(),
  ioMode: z.enum(['request_response', 'streaming']).optional(),
  /**
   * Optional model selection applied to EVERY started run, reusing the canonical session-spawn
   * `modelId` vocabulary. Omitted ⇒ each backend's default model.
   */
  modelId: z.string().min(1).optional(),
  /**
   * Optional canonical agent config-option overrides (e.g. reasoning effort) applied to every
   * started run — the SAME `AcpConfigOptionOverridesV1` shape session spawn uses.
   */
  sessionConfigOptionOverrides: AcpConfigOptionOverridesV1Schema.optional(),
  /**
   * Ergonomic shorthand for `sessionConfigOptionOverrides` (id → value). Merged into the canonical
   * overrides at the action boundary; a value conflicting with `sessionConfigOptionOverrides`
   * fails with `invalid_parameters`.
   */
  configOptions: z.record(z.string(), SpawnConfigOptionValueSchema).optional(),
  /**
   * Optional per-backend-target connected-services selection, keyed by the SAME backend target
   * key strings passed in `backendTargetKeys`. Each value may be an agent-friendly simple string
   * (`"<service>:group:<id>"`, `"<service>:<profileId>"`, `"<service>:native"`), an array of those,
   * or the full `ConnectedServiceBindingsV1` object — normalized at the action boundary. Targets
   * without an entry apply the session-spawn account-settings defaulting; connected selections fail
   * closed at run start.
   */
  connectedServicesByBackendTargetKey: z
    .record(z.string(), StrictJsonValueSchema)
    .optional(),
}).passthrough();

const PlanStartInputSchema = IntentStartCommonSchema.extend({
  permissionMode: ExecutionRunActionPermissionModeSchema.default('read_only'),
  retentionPolicy: z.enum(['ephemeral', 'resumable']).default('ephemeral'),
  runClass: z.enum(['bounded', 'long_lived']).default('bounded'),
  ioMode: z.enum(['request_response', 'streaming']).default('request_response'),
}).passthrough();

const DelegateStartInputSchema = IntentStartCommonSchema.extend({
  permissionMode: ExecutionRunActionPermissionModeSchema.default('workspace_write'),
  retentionPolicy: z.enum(['ephemeral', 'resumable']).default('ephemeral'),
  runClass: z.enum(['bounded', 'long_lived']).default('bounded'),
  ioMode: z.enum(['request_response', 'streaming']).default('request_response'),
}).passthrough();

const VoiceAgentStartInputSchema = IntentStartCommonSchema.extend({
  permissionMode: ExecutionRunActionPermissionModeSchema.default('read_only'),
  retentionPolicy: z.enum(['ephemeral', 'resumable']).default('ephemeral'),
  runClass: z.enum(['bounded', 'long_lived']).default('long_lived'),
  ioMode: z.enum(['request_response', 'streaming']).default('streaming'),
}).passthrough();

/**
 * Scope is intentionally tri-state: an omitted field resolves to the caller's
 * current Session when one exists; explicit `null` means detached; and a string
 * identifies one exact Session. Keep the property optional so the action owner
 * can distinguish omission from explicit `null` by property presence.
 */
const ExecutionRunScopeSessionIdSchema = z.string().min(1).refine(
  (sessionId) => sessionId.trim().length > 0,
  { message: 'sessionId must not be whitespace only' },
).nullable().optional();

const ExecutionRunIdInputSchema = z.object({
  sessionId: ExecutionRunScopeSessionIdSchema,
  runId: z.string().min(1),
}).passthrough();

/**
 * Normalize the agent-friendly `connectedServices` simple-form (string / array) into the canonical
 * `ConnectedServiceBindingsV1` object BEFORE the strict run-request schema validates it. A malformed
 * value is left untouched so the strict schema rejects it (→ `invalid_parameters`). Non-simple
 * (already-object) values pass through unchanged. This keeps the run REQUEST schema strict while the
 * action input accepts the ergonomic forms an agent can produce from the spec alone.
 */
function preprocessRunStartConnectedServicesInput(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const record = raw as Record<string, unknown>;
  const selection = record.connectedServices;
  if (typeof selection !== 'string' && !Array.isArray(selection)) return raw;
  const normalized = normalizeConnectedServiceSelectionInput(selection);
  if (!normalized.ok) return raw;
  return { ...record, connectedServices: normalized.bindings };
}

const ExecutionRunStartActionRequestSchema = ExecutionRunStartRequestBaseSchema.extend({
  sessionId: ExecutionRunScopeSessionIdSchema,
  waitForCompletion: z.boolean().optional(),
  waitTimeoutSeconds: z.number().int().min(1).optional(),
  /**
   * Ergonomic shorthand for `sessionConfigOptionOverrides` (id → value). Merged into the canonical
   * overrides at the action boundary; conflicting values fail with `invalid_parameters`.
   */
  configOptions: z.record(z.string(), SpawnConfigOptionValueSchema).optional(),
}).superRefine(refineExecutionRunStartRequest).superRefine((value, ctx) => {
  if (value.waitTimeoutSeconds !== undefined && value.waitForCompletion !== true) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'waitTimeoutSeconds requires waitForCompletion=true',
      path: ['waitTimeoutSeconds'],
    });
  }
});

const ExecutionRunStartPluginInputSchema = ExecutionRunStartRequestBaseSchema.extend({
  sessionId: ExecutionRunScopeSessionIdSchema,
  waitForCompletion: z.boolean().optional(),
  waitTimeoutSeconds: z.number().int().min(1).optional(),
  configOptions: z.record(z.string(), SpawnConfigOptionValueSchema).optional(),
  connectedServices: z.union([
    ConnectedServiceBindingsV1Schema,
    z.string(),
    z.array(z.string()),
  ]).optional(),
}).superRefine(refineExecutionRunStartRequest).superRefine((value, ctx) => {
  if (value.waitTimeoutSeconds !== undefined && value.waitForCompletion !== true) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'waitTimeoutSeconds requires waitForCompletion=true',
      path: ['waitTimeoutSeconds'],
    });
  }
});

const ExecutionRunStartInputSchema = z.preprocess<
  unknown,
  typeof ExecutionRunStartActionRequestSchema,
  z.input<typeof ExecutionRunStartPluginInputSchema>
>(
  preprocessRunStartConnectedServicesInput,
  ExecutionRunStartActionRequestSchema,
);

const ExecutionRunGetInputSchema = ExecutionRunIdInputSchema.extend({
  includeStructured: z.boolean().optional(),
}).passthrough();

const ExecutionRunSendInputSchema = ExecutionRunIdInputSchema.extend({
  message: z.string().min(1),
  resume: z.boolean().optional(),
}).passthrough();

const ExecutionRunEnsureInputSchema = ExecutionRunIdInputSchema.extend({
  resume: z.boolean().optional(),
}).passthrough();

const ExecutionRunEnsureOrStartInputSchema = z.object({
  sessionId: ExecutionRunScopeSessionIdSchema,
  runId: z.string().min(1).nullable().optional(),
  start: ExecutionRunStartRequestSchema.optional(),
  resume: z.boolean().optional(),
}).passthrough().superRefine((value, ctx) => {
  const runId = typeof value.runId === 'string' ? value.runId.trim() : '';
  if (!runId && !value.start) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'start is required when runId is missing' });
  }
});

const ExecutionRunStreamStartInputSchema = ExecutionRunIdInputSchema.extend({
  message: z.string().min(1),
  displayMessage: z.string().min(1).optional(),
  resume: z.boolean().optional(),
}).passthrough();

const ExecutionRunStreamReadInputSchema = ExecutionRunIdInputSchema.extend({
  streamId: z.string().min(1),
  cursor: z.number().int().min(0),
  maxEvents: z.number().int().min(1).max(256).optional(),
}).passthrough();

const ExecutionRunStreamCancelInputSchema = ExecutionRunIdInputSchema.extend({
  streamId: z.string().min(1),
}).passthrough();

const ExecutionRunActionInputSchema = ExecutionRunIdInputSchema.extend({
  actionId: z.string().min(1),
  input: StrictJsonValueSchema.optional(),
}).passthrough();

const ExecutionRunWaitInputSchema = ExecutionRunIdInputSchema.extend({
  timeoutSeconds: z.number().int().min(1).optional(),
  pollIntervalMs: z.number().int().min(100).max(60_000).optional(),
}).passthrough();

const SessionOpenInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  sessionTitle: z.string().trim().min(1).optional(),
}).passthrough().superRefine((value, ctx) => {
  if (!(typeof value.sessionId === 'string' && value.sessionId.trim().length > 0) && !(typeof value.sessionTitle === 'string' && value.sessionTitle.trim().length > 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'sessionId or sessionTitle is required',
      path: ['sessionId'],
    });
  }
});

const SessionForkInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
}).passthrough();

const SessionRollbackInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  target: SessionRollbackTargetSchema.optional(),
}).passthrough();

const SessionHandoffInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  targetMachineId: z.string().min(1).optional(),
  targetSessionStorageMode: z.enum(['direct', 'persisted']).optional(),
  workspaceTransfer: SessionHandoffWorkspaceTransferSchema.optional(),
}).passthrough();

const SessionSpawnNewInputSchema = SessionSpawnNewInputV2Schema;
const SessionSpawnNewApiInputSchema = SessionSpawnNewInputV2Schema.omit({
  executionTarget: true,
}).strict();
const SessionSpawnNewInputHints = {
  title: 'Create a new session',
  fields: [
    { path: 'creationKey', title: 'Creation key', widget: 'text' },
    { path: 'executionTarget.serverId', title: 'Server id', widget: 'text', required: true, optionsSourceId: 'sessions.spawn.servers.available' },
    { path: 'executionTarget.machineId', title: 'Machine id', widget: 'text', required: true, optionsSourceId: 'sessions.spawn.machines.available' },
    { path: 'directory', title: 'Directory', widget: 'text', required: true, optionsSourceId: 'sessions.spawn.paths.recent' },
    { path: 'organizationPlacement', title: 'Organization placement', widget: 'json' },
    { path: 'agentTarget', title: 'Agent target', widget: 'json', required: true, optionsSourceId: 'agents.backends.enabled' },
    { path: 'modelSelection', title: 'Model selection', widget: 'json', optionsSourceId: 'agents.models.available' },
    { path: 'title', title: 'Title', widget: 'text' },
    { path: 'permissionMode', title: 'Permission mode', widget: 'text' },
    { path: 'agentModeId', title: 'Agent mode', widget: 'text', optionsSourceId: 'agents.session_modes.available' },
    { path: 'configuration', title: 'Configuration', widget: 'json', optionsSourceId: 'agents.config_options.available' },
    { path: 'profileId', title: 'Profile id', widget: 'text', optionsSourceId: 'sessions.spawn.profiles.available' },
    { path: 'connectedServices', title: 'Connected services', widget: 'json', optionsSourceId: 'sessions.spawn.connected_services.available' },
    { path: 'mcpSelection', title: 'MCP selection', widget: 'json', optionsSourceId: 'sessions.spawn.mcp_servers.preview' },
    { path: 'transcriptStorage', title: 'Transcript storage', widget: 'text' },
    { path: 'terminal', title: 'Terminal', widget: 'json' },
    { path: 'checkoutCreationDraft', title: 'Checkout creation', widget: 'json' },
    { path: 'initialMessage', title: 'Initial message', widget: 'textarea' },
    { path: 'agentSessionStartupInstructionsV1', title: 'Startup instructions', widget: 'json' },
  ],
} satisfies ActionInputHints;
const SessionSpawnNewApiInputHints = {
  ...SessionSpawnNewInputHints,
  fields: SessionSpawnNewInputHints.fields.filter((field) => (
    field.path !== 'executionTarget.serverId' && field.path !== 'executionTarget.machineId'
  )),
} satisfies ActionInputHints;

/**
 * The sole canonical-to-public projection for a Session creation request that
 * was already admitted on a local Action surface. Execution placement remains
 * transport metadata: the public input cannot carry it, while the selected
 * machine reaches the API envelope as its exact target.
 */
export function projectSessionSpawnNewApiRequest(
  value: unknown,
): Readonly<{
  input: z.input<typeof SessionSpawnNewApiInputSchema>;
  target: Extract<ExternalActionTargetV1, { kind: 'machine' }>;
}> {
  const canonicalInput = SessionSpawnNewInputV2Schema.parse(value);
  const { executionTarget, ...apiInput } = canonicalInput;
  return {
    input: SessionSpawnNewApiInputSchema.parse(apiInput),
    target: {
      kind: 'machine',
      machineId: executionTarget.machineId,
    },
  };
}

// Action invocations may derive a key from their durable request identity, but
// RPC retries have no such identity. The transport therefore requires the
// caller's one logical creation key rather than synthesizing one per attempt.
const SessionSpawnNewRpcInputSchema = SessionSpawnNewInputV2Schema.extend({
  creationKey: SessionCreationKeyV1Schema,
});

function bindApiSessionSpawnNewInput(
  value: unknown,
  context: ActionSurfaceBindingContext,
): unknown {
  const input = SessionSpawnNewApiInputSchema.parse(value);
  const serverId = context.serverId;
  const target = context.externalActionTarget;
  if (
    context.caller.kind !== 'host'
    || typeof serverId !== 'string'
    || serverId.trim().length === 0
    || target?.kind !== 'machine'
  ) {
    throw new Error('API session spawn requires a host-stamped machine target and server id');
  }

  return {
    ...input,
    executionTarget: {
      serverId,
      machineId: target.machineId,
    },
  };
}

function validateAgentIdAndBackendTargetKeySelection(
  value: Readonly<{
    agentId?: string;
    backendTargetKey?: string;
    backendTarget?: z.infer<typeof BackendTargetRefV2Schema>;
    runtimeDescriptorV1?: z.infer<typeof RuntimeDescriptorV1Schema>;
  }>,
  ctx: z.RefinementCtx,
): void {
  const resolved = resolveActionBackendTargetSelection(value);
  if (!resolved.ok) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: resolved.message,
      path: [resolved.path],
    });
  }
}

function validateStringAliasPair(
  value: Readonly<Record<string, unknown>>,
  ctx: z.RefinementCtx,
  params: Readonly<{ primary: string; alias: string }>,
): void {
  const primaryValue = value[params.primary];
  const aliasValue = value[params.alias];
  if (typeof primaryValue !== 'string' || typeof aliasValue !== 'string') return;
  if (primaryValue.trim() === aliasValue.trim()) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: `${params.primary} and ${params.alias} must match when both are provided`,
    path: [params.alias],
  });
}

const PathsListRecentInputSchema = z.object({
  machineId: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(50).optional(),
}).passthrough();

const MachinesListInputSchema = z.object({
  limit: z.number().int().min(1).max(200).optional(),
}).passthrough();

const ServersListInputSchema = z.object({
  limit: z.number().int().min(1).max(200).optional(),
}).passthrough();

const ReviewEnginesListInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  includeDisabled: z.boolean().optional(),
}).passthrough();

const AgentsBackendsListInputSchema = z.object({
  includeDisabled: z.boolean().optional(),
  limit: z.number().int().min(1).max(200).optional(),
}).passthrough();

const AgentsModelsListInputSchema = z.object({
  agentId: z.string().min(1).optional(),
  backendTargetKey: z.union([BackendTargetKeySchema, BackendTargetKeyV2Schema]).optional(),
  machineId: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(200).optional(),
}).passthrough().superRefine((value, ctx) => {
  if (!value.agentId && !value.backendTargetKey) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'agentId or backendTargetKey is required',
      path: ['agentId'],
    });
  }
  validateAgentIdAndBackendTargetKeySelection(value, ctx);
});

const AgentSpawnOptionsListInputBaseSchema = z.object({
  agentId: z.string().min(1).optional(),
  backendTargetKey: z.union([BackendTargetKeySchema, BackendTargetKeyV2Schema]).optional(),
  machineId: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

const AgentSpawnOptionsListInputSchema = AgentSpawnOptionsListInputBaseSchema.passthrough().superRefine((value, ctx) => {
  if (!value.agentId && !value.backendTargetKey) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'agentId or backendTargetKey is required',
      path: ['agentId'],
    });
  }
  validateAgentIdAndBackendTargetKeySelection(value, ctx);
});

const AgentsConfigOptionsListInputSchema = AgentSpawnOptionsListInputBaseSchema.extend({
  modelId: z.string().min(1).optional(),
}).passthrough().superRefine((value, ctx) => {
  if (!value.agentId && !value.backendTargetKey) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'agentId or backendTargetKey is required',
      path: ['agentId'],
    });
  }
  validateAgentIdAndBackendTargetKeySelection(value, ctx);
});

const SpawnConnectedServicesListInputSchema = AgentSpawnOptionsListInputBaseSchema.extend({
  includeUnavailable: z.boolean().optional(),
}).passthrough().superRefine((value, ctx) => {
  if (!value.agentId && !value.backendTargetKey) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'agentId or backendTargetKey is required',
      path: ['agentId'],
    });
  }
  validateAgentIdAndBackendTargetKeySelection(value, ctx);
});

const SpawnMcpServersPreviewInputSchema = z.object({
  agentId: z.string().min(1).optional(),
  backendTargetKey: z.union([BackendTargetKeySchema, BackendTargetKeyV2Schema]).optional(),
  machineId: z.string().min(1).optional(),
  directory: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  selection: SessionMcpSelectionV1Schema.optional(),
  limit: z.number().int().min(1).max(200).optional(),
}).passthrough().superRefine((value, ctx) => {
  if (!value.agentId && !value.backendTargetKey) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'agentId or backendTargetKey is required',
      path: ['agentId'],
    });
  }
  validateAgentIdAndBackendTargetKeySelection(value, ctx);
});

const ActionSpecSearchInputSchema = z.object({
  query: z.string().trim().optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).passthrough();

const ActionSpecGetInputSchema = z.object({
  id: z.string().min(1),
}).passthrough();

const ActionSpecSearchResultSchema = z.object({
  actionSpecs: z.array(ActionDefinitionSummaryV1Schema),
}).strict();

const ActionSpecGetResultSchema = z.object({
  actionSpec: ActionDefinitionV1Schema,
}).strict();

const ActionOptionsResolveInputSchema = z.object({
  actionId: z.string().min(1).optional(),
  fieldPath: z.string().min(1).optional(),
  optionsSourceId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  query: z.string().trim().optional(),
}).passthrough().superRefine((value, ctx) => {
  const actionId = typeof value.actionId === 'string' ? value.actionId.trim() : '';
  const fieldPath = typeof value.fieldPath === 'string' ? value.fieldPath.trim() : '';
  const optionsSourceId = typeof value.optionsSourceId === 'string' ? value.optionsSourceId.trim() : '';
  if (!optionsSourceId && !(actionId && fieldPath)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'actionId + fieldPath or optionsSourceId is required',
      path: ['actionId'],
    });
  }
});

/** One generic dynamic Action bridge; selection and policy remain executor-owned. */
const ActionInvokeInputSchema = z.object({
  action: asProtocolZod(PluginContributionIdentityV1Schema),
  input: StrictJsonValueSchema.optional(),
}).strict();

/** Current-UI semantic payloads stay behind the ephemeral opaque command handle. */
const CurrentUiContextCommandInvokeInputSchema = z.object({
  commandId: z.string().trim().min(1),
}).strict();

const SessionSendMessageInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  message: z.string().min(1),
  requestedAction: PendingRequestedActionV1Schema.optional(),
  /**
   * The caller-retained stable identity for this durable input. Resubmitting
   * the same localId rejoins the existing pending input instead of queueing a
   * second message, so an ambiguous send can be retried safely. Plugin callers
   * cannot supply it: their identity is host-derived from `idempotencyKey`.
   */
  localId: PendingLocalIdSchema.optional(),
  idempotencyKey: PluginSessionInputIdempotencyKeyV1Schema.optional(),
  source: PluginSessionInputSourceV1Schema.optional(),
  permissionModeOverride: z.string().trim().min(1).optional(),
  modelOverride: z.union([z.string().trim().min(1), z.null()]).optional(),
  providerConnectionId: ProviderConnectionIdSchema.nullable().optional(),
  wait: z.boolean().optional(),
  timeoutSeconds: z.number().int().min(1).max(3600).optional(),
}).passthrough().superRefine((value, ctx) => {
  if (value.providerConnectionId !== undefined
    && value.providerConnectionId !== null
    && typeof value.modelOverride !== 'string') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['modelOverride'],
      message: 'modelOverride must be a concrete model id when providerConnectionId is set',
    });
  }
});

/** Plugin Session messages carry only host-attributed admission intent. */
const SessionSendMessagePluginInputV1Schema = z.object({
  sessionId: z.string().min(1),
  message: z.string().min(1),
  idempotencyKey: PluginSessionInputIdempotencyKeyV1Schema,
  source: PluginSessionInputSourceV1Schema.optional(),
}).strict();

const SessionPermissionRespondInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  decision: z.enum(['allow', 'deny']),
  requestId: z.string().min(1).optional(),
}).passthrough();

const SessionUserActionAnswerItemSchema = z.object({
  question: z.string().min(1).refine((value) => value.trim().length > 0, {
    message: 'question must not be blank',
  }),
  values: z.array(z.string()).min(1).optional(),
  // Compatibility for clients through the released 0.2.2 preview. Remove `answer`
  // after that preview leaves the supported mixed-version window.
  answer: z.string().min(1).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.answer !== undefined && value.values !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'answer and values cannot both be provided' });
  }
  if (value.answer === undefined && value.values === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'answer or values is required' });
  }
});

function validateSessionUserActionAnswer(
  value: Readonly<{
    decision?: 'approve' | 'reject' | 'request_changes';
    reason?: string;
    answers?: readonly Readonly<{
      question: string;
      values?: readonly string[];
      answer?: string;
    }>[];
  }>,
  ctx: z.RefinementCtx,
): void {
  const hasAnswers = Array.isArray(value.answers) && value.answers.length > 0;
  const structuredAnswers = Object.create(null) as Record<string, readonly string[]>;
  for (const [index, entry] of (value.answers ?? []).entries()) {
    if (Object.prototype.hasOwnProperty.call(structuredAnswers, entry.question)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'duplicate question',
        path: ['answers', index, 'question'],
      });
      continue;
    }
    structuredAnswers[entry.question] = entry.values ?? [entry.answer!];
  }
  if (hasAnswers && !StructuredQuestionAnswersV1Schema.safeParse(structuredAnswers).success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'invalid structured answers',
      path: ['answers'],
    });
  }
  if (!hasAnswers && value.decision === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'decision or answers is required',
      path: ['decision'],
    });
  }
  if (value.decision === 'request_changes'
    && !(typeof value.reason === 'string' && value.reason.trim().length > 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'reason is required when decision=request_changes',
      path: ['reason'],
    });
  }
}

const SessionUserActionAnswerInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  requestId: z.string().min(1).optional(),
  decision: z.enum(['approve', 'reject', 'request_changes']).optional(),
  reason: z.string().trim().min(1).optional(),
  answers: z.array(SessionUserActionAnswerItemSchema).min(1).optional(),
  updatedPermissions: StrictJsonValueSchema.optional(),
}).passthrough().superRefine(validateSessionUserActionAnswer);

const SessionUserActionAnswerPluginInputSchema = z.object({
  requestId: z.string().min(1),
  decision: z.enum(['approve', 'reject', 'request_changes']).optional(),
  reason: z.string().trim().min(1).optional(),
  answers: z.array(SessionUserActionAnswerItemSchema).min(1).optional(),
}).strict().superRefine(validateSessionUserActionAnswer);

const SessionInteractionResponseSuccessSchema = z.object({
  ok: z.literal(true),
}).strict();

const SessionModeSetInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  modeId: z.string().min(1),
}).passthrough();

const SessionPrimaryTargetInputSchema = z.object({
  sessionId: z.string().min(1).nullable().optional(),
  sessionTitle: z.string().trim().min(1).optional(),
}).passthrough().superRefine((value, ctx) => {
  const hasSessionId = value.sessionId === null || (typeof value.sessionId === 'string' && value.sessionId.trim().length > 0);
  const hasSessionTitle = typeof value.sessionTitle === 'string' && value.sessionTitle.trim().length > 0;
  if (!hasSessionId && !hasSessionTitle) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'sessionId or sessionTitle is required',
      path: ['sessionId'],
    });
  }
});

const SessionTrackedTargetsInputSchema = z.object({
  sessionIds: z.array(z.string().min(1)).max(50),
}).passthrough();

const SessionListInputSchema = z.object({
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).nullable().optional(),
  includeLastMessagePreview: z.boolean().optional(),
  activeOnly: z.boolean().optional(),
  archivedOnly: z.boolean().optional(),
  includeSystem: z.boolean().optional(),
  resumableOnly: z.boolean().optional(),
  includeRows: z.boolean().optional(),
}).passthrough();

const SessionActivityInputSchema = z.object({
  sessionId: z.string().min(1),
  windowSeconds: z.number().int().min(1).max(86_400).optional(),
}).passthrough();

const SessionRecentMessagesInputSchema = z.object({
  sessionId: z.string().min(1),
  limit: z.number().int().min(1).max(50).optional(),
  cursor: z.string().min(1).nullable().optional(),
  includeUser: z.boolean().optional(),
  includeAssistant: z.boolean().optional(),
  maxCharsPerMessage: z.number().int().min(0).max(50_000).nullable().optional(),
}).passthrough();

const SessionLogTailInputSchema = z.object({
  path: z.string().min(1),
  maxBytes: z.number().int().min(1).max(1_000_000).optional(),
  offset: z.number().int().min(0).optional(),
}).passthrough();

const TranscriptPageInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  cursor: z.string().min(1).nullable().optional(),
  maxBytes: z.number().int().min(1).max(1_000_000).optional(),
  maxItems: z.number().int().min(1).max(500).optional(),
}).passthrough();

const TranscriptReadAfterInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  cursor: z.string().min(1),
  maxBytes: z.number().int().min(1).max(1_000_000).optional(),
  maxItems: z.number().int().min(1).max(500).optional(),
}).passthrough();

const TranscriptFollowInputSchema = TranscriptReadAfterInputSchema.extend({
  leaseId: z.string().min(1).optional(),
  idleTtlMs: z.number().int().min(1).max(3_600_000).optional(),
}).passthrough();

const TranscriptUnfollowInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  leaseId: z.string().min(1),
}).strict();

const TranscriptImportInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  importId: z.string().trim().min(1).optional(),
  items: z.array(StrictJsonValueSchema).min(1).max(500),
  maxItems: z.number().int().min(1).max(500).optional(),
}).passthrough();

const TranscriptSearchInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  query: z.string().trim().min(1),
  cursor: z.string().min(1).optional(),
  maxBytes: z.number().int().min(1).max(1_000_000).optional(),
  maxItems: z.number().int().min(1).max(100).optional(),
  maxReads: z.number().int().min(1).max(50).optional(),
}).passthrough();

const TranscriptPageOutputSchema = z.object({
  ok: z.boolean().optional(),
  items: z.array(StrictJsonValueSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean().optional(),
  tailCursor: z.string().nullable().optional(),
  truncated: z.boolean(),
}).passthrough();

const TranscriptReadAfterOutputSchema = z.object({
  ok: z.boolean().optional(),
  items: z.array(StrictJsonValueSchema),
  nextCursor: z.string().nullable(),
  truncated: z.boolean(),
}).passthrough();

const TranscriptFollowOutputSchema = TranscriptReadAfterOutputSchema.extend({
  leaseId: z.string().min(1).optional(),
}).passthrough();

const TranscriptUnfollowOutputSchema = z.object({
  ok: z.literal(true),
  released: z.boolean(),
}).strict();

const TranscriptImportOutputSchema = z.object({
  ok: z.boolean(),
  imported: z.number().int().min(0).optional(),
  cursor: z.string().nullable().optional(),
}).passthrough();

const SessionLogTailOutputSchema = z.object({
  success: z.boolean().optional(),
  ok: z.boolean().optional(),
  path: z.string().optional(),
  tail: z.string().optional(),
  truncated: z.boolean().optional(),
  error: z.string().optional(),
}).passthrough();

const SubagentListInputSchema = z.object({
  parentSessionId: z.string().trim().min(1).optional(),
  groupId: z.string().trim().min(1).nullable().optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).passthrough();

const SubagentGetInputSchema = z.object({
  id: z.string().trim().min(1),
  parentSessionId: z.string().trim().min(1).optional(),
}).passthrough();

const SubagentWatchInputSchema = z.object({
  parentSessionId: z.string().trim().min(1).optional(),
  id: z.string().trim().min(1).optional(),
}).passthrough();

const SubagentStatusUpdateInputSchema = z.object({
  id: z.string().trim().min(1),
  parentSessionId: z.string().trim().min(1),
  status: SubagentStatusV1Schema,
  lifecycleDetail: SubagentLifecycleDetailV1Schema.optional(),
  completedAt: z.number().int().nonnegative().optional(),
}).passthrough();

const SubagentCompleteInputSchema = z.object({
  id: z.string().trim().min(1),
  parentSessionId: z.string().trim().min(1),
  status: z.enum(['completed', 'failed', 'aborted']).optional(),
  lifecycleDetail: SubagentLifecycleDetailV1Schema.optional(),
  completedAt: z.number().int().nonnegative().optional(),
}).passthrough();

const SubagentWatchSnapshotOutputSchema = z.object({
  kind: z.literal('snapshot'),
  subagents: z.array(SubagentRefV1Schema),
}).passthrough();

const MemorySearchInputSchema = z.object({
  machineId: z.string().min(1),
  query: MemorySearchQueryV1Schema,
}).passthrough();

const MemoryGetWindowInputSchema = z.object({
  machineId: z.string().min(1),
  sessionId: z.string().min(1),
  seqFrom: z.number().int().min(0),
  seqTo: z.number().int().min(0),
}).passthrough().superRefine((value, ctx) => {
  if (value.seqFrom > value.seqTo) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'seqFrom must be <= seqTo', path: ['seqFrom'] });
  }
});

const MemoryEnsureUpToDateInputSchema = z.object({
  machineId: z.string().min(1),
  sessionId: z.string().min(1).optional(),
}).passthrough();

const MemoryEnsureUpToDateOutputSchema = z.object({
  ok: z.boolean(),
}).passthrough();

const ApprovalRequestCreateInputSchema = z.object({
  actionId: ActionIdSchema,
  actionArgs: StrictJsonValueSchema,
  summary: z.string().min(1),
  createdBy: ApprovalRequestCreatedBySchema,
  origin: ApprovalRequestOriginV1Schema.optional(),
  preview: StrictJsonValueSchema.optional(),
}).passthrough();

const ApprovalRequestListInputSchema = z.object({
  status: ApprovalRequestStatusSchema.optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).passthrough();

const ApprovalRequestGetInputSchema = z.object({
  artifactId: z.string().min(1),
}).passthrough();

const ApprovalRequestDecideInputSchema = z.object({
  artifactId: z.string().min(1),
  decision: z.enum(['approve', 'reject']),
}).passthrough();

const PromptDocUpdateInputSchema = z.object({
  artifactId: z.string().min(1),
  title: z.string().min(1),
  markdown: z.string(),
  folderId: z.string().min(1).nullable().optional(),
  tags: z.array(z.string().min(1)).optional(),
}).passthrough();

const PromptBundleUpdateInputSchema = z.object({
  artifactId: z.string().min(1),
  title: z.string().min(1),
  skillMarkdown: z.string(),
  folderId: z.string().min(1).nullable().optional(),
  tags: z.array(z.string().min(1)).optional(),
}).passthrough();

const PromptAssetExportInputSchema = z.object({
  artifactId: z.string().min(1),
  machineId: z.string().min(1),
  assetTypeId: z.string().min(1),
  scope: PromptAssetScopeV1Schema,
  directory: z.string().min(1).optional(),
  targetPath: z.string().min(1).optional(),
  targetName: z.string().min(1).optional(),
  installMode: PromptAssetInstallModeV1Schema.optional(),
}).passthrough().superRefine((value, ctx) => {
  const hasDocTarget = typeof value.targetPath === 'string' && value.targetPath.trim().length > 0;
  const hasBundleTarget = typeof value.targetName === 'string' && value.targetName.trim().length > 0;
  if (!hasDocTarget && !hasBundleTarget) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'targetPath or targetName is required',
      path: ['targetPath'],
    });
  }
});

const PromptRegistryInstallInputSchema = z.object({
  machineId: z.string().min(1),
  sourceId: z.string().min(1),
  itemId: z.string().min(1),
  configuredSources: z.array(PromptRegistryConfiguredSourceV1Schema).default([]),
  installTarget: z.object({
    assetTypeId: z.string().min(1),
    scope: PromptAssetScopeV1Schema,
    directory: z.string().min(1).optional(),
    targetName: z.string().min(1),
    installMode: PromptAssetInstallModeV1Schema.optional(),
  }).optional(),
}).passthrough();

const ExternalSessionTakeoverActionInputSchema = ExternalSessionTakeoverInputV1Schema;

const APPROVAL_RESULT_REQUIRED: ActionApproval = Object.freeze({ result: 'required' });
const APPROVAL_RESULT_NONE: ActionApproval = Object.freeze({ result: 'none' });
const APPROVAL_RESULT_NONE_DEFERRED: ActionApproval = Object.freeze({ result: 'none', flow: 'deferred' });
const APPROVAL_RESULT_OPTIONAL_DEFERRED: ActionApproval = Object.freeze({ result: 'optional', flow: 'deferred' });

const RESULT_NONE_DEFERRED_APPROVAL_ACTION_IDS = [
  'session.usageLimit.waitResume.enable',
  'session.usageLimit.waitResume.cancel',
] as const satisfies readonly ActionId[];

const RESULT_REQUIRED_APPROVAL_ACTION_IDS = [
  'action.spec.search',
  'action.spec.get',
  'action.options.resolve',
  'action.invoke',
  'ui.current_context.read',
  'ui.current_context.command.invoke',
  'account.plugins.data.erase',
  'account.sessions.signOutEverywhere',
  'account.apiTokens.create',
  'account.apiTokens.list',
  'account.apiTokens.revoke',
  'account.apiTokens.revokeAll',
  'sessions.subagents.list',
  'sessions.subagents.get',
  'sessions.subagents.watch',
  'execution.run.list',
  'execution.run.get',
  'execution.run.stream.read',
  'execution.run.wait',
  'session.handoff.prepare_target_result.get',
  'session.handoff.status.get',
  'paths.list_recent',
  'machines.list',
  'servers.list',
  'review.engines.list',
  'agents.backends.list',
  'agents.models.list',
  'agents.config_options.list',
  'agents.session_modes.list',
  'sessions.spawn.profiles.list',
  'sessions.spawn.connected_services.list',
  'sessions.spawn.mcp_servers.preview',
  'session.status.get',
  'session.work_state.get',
  'session.goal.get',
  'session.usageLimit.checkNow',
  'session.usageLimit.consumeResetCredit',
  'session.terminalComposer.clear',
  'session.pendingInput.interruptAndRun',
  'session.vendor_plugin_catalog.list',
  'session.skill_catalog.list',
  'session.history.get',
  'session.transcript.get',
  'session.events.get',
  'session.wait.idle',
  'session.list',
  'session.activity.get',
  'session.messages.recent.get',
  'memory.search',
  'memory.get_window',
  'memory.ensure_up_to_date',
  'daemon.promptAssets.discover',
  'daemon.promptRegistry.scanSource',
  'daemon.filesystem.readFile',
  'daemon.filesystem.listDirectory',
  'daemon.filesystem.getDirectoryTree',
  'daemon.filesystem.listRoots',
  'daemon.filesystem.browseDirectory',
  'bugreport.collectDiagnostics',
  'bugreport.getLogTail',
  'approval.request.list',
  'approval.request.get',
  'plugins.list',
  'plugins.change.status',
  'plugins.settings.list',
  'plugins.settings.get',
  'plugins.settings.secret.status',
  'plugin.webhook.endpoint.read',
  'plugin.webhook.endpoint.checkCorrespondence',
  'plugins.sessionHooks.status.get',
  'plugins.permissions.grants.list',
  'session.log.tail',
  'transcript.page',
  'transcript.readAfter',
  'transcript.follow',
  'transcript.search',
  'sessions.external.candidates.list',
  'sessions.external.status.get',
  'sessions.external.operation.status.get',
  'sessions.external.transcript.page',
  'sessions.external.transcript.readAfter',
  'scm.pullRequest.list',
  'scm.pullRequest.get',
  'scm.pullRequest.openCompose',
  'scm.hostingRepository.describePublishTargets',
  'scm.diffSummary.generate',
  'browser.session.create',
  'browser.session.close',
  'browser.view.open',
  'browser.view.close',
  'browser.view.focus',
  'browser.target.set',
  'browser.navigate',
  'browser.reload',
  'browser.goBack',
  'browser.goForward',
  'browser.stop',
  'browser.diagnostics.snapshot',
  'browser.diagnostics.clear',
  'browser.diagnostics.pause',
  'browser.diagnostics.resume',
  'browser.diagnostics.eval',
  'browser.diagnostics.getProperties',
  'browser.diagnostics.releaseObjectGroup',
  'browser.diagnostics.elementPicker.start',
  'browser.diagnostics.elementPicker.cancel',
  'browser.context.capturePage',
  'browser.context.captureScreenshot',
  'browser.context.captureSelectedElement',
  'browser.context.captureNetworkSummary',
  'browser.context.captureConsoleSummary',
  'browser.context.annotation.start',
  'browser.context.annotation.cancel',
  'browser.context.annotation.captureRegion',
  'browser.context.annotation.captureElement',
  'browser.context.annotation.attachComment',
  'browser.context.annotation.attachStroke',
  'browser.context.annotation.attachStyleIntent',
  'browser.context.attachToComposer',
  'browser.context.attachToAgentTurn',
  'browser.context.clear',
  'browser.automation.status',
  'browser.automation.snapshot',
  'browser.automation.semanticSnapshot',
  'browser.automation.queryElements',
  'browser.automation.waitFor',
  'browser.automation.timeline.get',
  'browser.automation.cancelActive',
  'browser.automation.navigate',
  'browser.automation.reload',
  'browser.automation.goBack',
  'browser.automation.goForward',
  'browser.automation.click',
  'browser.automation.tap',
  'browser.automation.type',
  'browser.automation.press',
  'browser.automation.scroll',
  'browser.automation.hover',
  'browser.automation.focus',
  'browser.automation.select',
  'browser.automation.setValue',
  'browser.automation.upload',
  'browser.automation.drag',
  'browser.recording.start',
  'browser.recording.stop',
  'browser.recording.cancel',
  'browser.recording.status',
  'browser.recording.listForView',
  'browser.recording.discard',
  'browser.recording.cleanupExpired',
  'browser.recording.attachToComposer',
  'localServices.inventory.list',
  'localServices.inventory.refresh',
  'localServices.launcher.snapshot',
  'localServices.launcher.start',
  'localServices.launcher.openPreview',
  'localServices.launcher.registerPreview',
  'localServices.launcher.history.clear',
  'localServices.preview.openOrCreate',
  'localServices.preview.status',
  'localServices.preview.revoke',
  'localServices.publicPreview.create',
  'localServices.publicPreview.status',
  'localServices.publicPreview.revoke',
  'localServices.publicPreview.copyUrl',
  'localServices.actions.copyUrl',
  'localServices.actions.openPreview',
  'localServices.actions.forget',
  'localServices.actions.stopManaged',
  'localServices.actions.restartManaged',
  'localServices.actions.terminateDetected',
  'peerMediation.observability.snapshot',
  'peerMediation.observability.subscribe',
  'peerMediation.observability.unsubscribe',
  'devices.simulator.list',
  'devices.simulator.stream.keyframe',
  'devices.simulator.stream.snapshot',
  'devices.simulator.stream.quality.set',
  'devices.simulator.stream.fps.set',
  'devices.simulator.stream.scale.set',
  'devices.simulator.lease.acquire',
  'devices.simulator.lease.renew',
  'devices.simulator.lease.release',
  'devices.simulator.input.tap',
  'devices.simulator.input.swipe',
  'devices.simulator.input.text',
  'devices.simulator.input.key',
  'devices.simulator.input.button',
  'devices.simulator.input.orientation',
  'devices.simulator.input.pinch',
  'devices.simulator.input.rotate',
  'devices.simulator.sideband.request',
] as const satisfies readonly ActionId[];

const RESULT_NONE_APPROVAL_ACTION_IDS = [
  'session.stop',
  'session.title.set',
  'session.permission_mode.set',
  'session.model.set',
  'session.archive',
  'session.unarchive',
  'session.goal.set',
  'session.goal.clear',
  'transcript.unfollow',
  'ui.voice_global.reset',
  'ui.pet.choose',
  'prompt_doc.update',
  'prompt_bundle.update',
  'prompt_asset.export',
  'prompt_registry.install',
  'approval.request.create',
  'approval.request.decide',
  'plugins.permissions.grants.request',
  'plugins.permissions.grants.grant',
  'plugins.permissions.grants.revoke',
  'plugins.permissions.grants.dismissRequest',
  'plugins.settings.set',
  'plugins.settings.reset',
  'plugins.settings.secret.bind',
  'plugins.settings.secret.unbind',
  'plugins.settings.secret.delete',
  'plugin.webhook.endpoint.ensure',
  'plugin.webhook.endpoint.revoke',
  'plugin.webhook.endpoint.retarget',
  'plugin.webhook.delivery.movePending',
  'plugin.webhook.endpoint.credential.configure',
  'plugin.webhook.endpoint.credential.rotate',
  'plugin.webhook.endpoint.credential.finishRotation',
  'automation.event.sources.list',
  'automation.event.admit',
  'automation.event.source.status.report',
  'automation.conversation.targets.list',
  'automation.conversation.target.verify',
  'automation.conversation.admit',
  'session.permission.remote.pending.list',
  'session.permission.remote.respond',
  'session.permission.remote.grants.list',
  'session.permission.remote.grants.revoke',
  ...REVIEW_COMMENT_ACTION_IDS_V1,
] as const satisfies readonly ActionId[];

const RESULT_OPTIONAL_DEFERRED_APPROVAL_ACTION_IDS = [
  'review.start',
  'subagents.plan.start',
  'subagents.delegate.start',
  'voice_agent.start',
  'sessions.subagents.upsert',
  'sessions.subagents.updateStatus',
  'sessions.subagents.complete',
  'execution.run.start',
  'execution.run.send',
  'execution.run.ensure',
  'execution.run.ensure_or_start',
  'execution.run.stream.start',
  'execution.run.stream.cancel',
  'execution.run.stop',
  'execution.run.action',
  'session.open',
  'session.fork',
  'session.continue_with_replay',
  'session.rollback',
  'session.checkpoint_code_rollback',
  'session.checkpoint',
  'session.restore',
  'session.handoff',
  'session.handoff.prepare_target',
  'session.handoff.prepare_target.resume',
  'session.handoff.commit',
  'session.handoff.abort',
  'session.spawn_new',
  'session.message.send',
  'session.permission.respond',
  'session.user_action.answer',
  'session.mode.set',
  'session.target.primary.set',
  'session.target.tracked.set',
  'ui.voice_agent.teleport',
  'daemon.promptAssets.delete',
  'daemon.promptRegistry.install',
  'daemon.filesystem.writeFile',
  'bugreport.uploadArtifact',
  'transcript.import',
  'sessions.external.link.ensure',
  'sessions.external.follow',
  'sessions.external.unfollow',
  'sessions.external.backgroundFollow.set',
  'sessions.external.takeover',
  'sessions.external.materialize.start',
  'sessions.external.takeover.start',
  'sessions.external.operation.cancel',
  'sessions.external.operation.resume',
  'sessions.external.operation.retry',
  'sessions.external.operation.discard',
  'scm.pullRequest.openOrReuse',
  'scm.pullRequest.checkout',
  'scm.pullRequest.prepareWorktree',
  'scm.pullRequest.runStacked',
  'scm.repository.clone',
  'scm.repository.init',
  'scm.repository.removeIndexLock',
  'scm.hostingRepository.publish',
  'plugins.scaffold',
  'plugins.install',
  'plugins.uninstall',
  'plugins.dev',
  'plugins.author.install',
  'plugins.author.typecheck',
  'plugins.author.build',
  'plugins.author.test',
  'plugins.doctor',
  'plugins.pack',
  'plugins.reload',
  'plugins.sessionHooks.install',
  'plugins.sessionHooks.disable',
  'plugins.sessionHooks.enable',
  'plugins.sessionHooks.uninstall',
] as const satisfies readonly ActionId[];

const RESULT_REQUIRED_APPROVAL_ACTION_ID_SET = new Set<ActionId>(RESULT_REQUIRED_APPROVAL_ACTION_IDS);
const RESULT_NONE_APPROVAL_ACTION_ID_SET = new Set<ActionId>(RESULT_NONE_APPROVAL_ACTION_IDS);
const RESULT_NONE_DEFERRED_APPROVAL_ACTION_ID_SET = new Set<ActionId>(RESULT_NONE_DEFERRED_APPROVAL_ACTION_IDS);
const RESULT_OPTIONAL_DEFERRED_APPROVAL_ACTION_ID_SET = new Set<ActionId>(RESULT_OPTIONAL_DEFERRED_APPROVAL_ACTION_IDS);

const CHECKPOINT_SCOPE_INPUT_OPTIONS: ActionInputOption[] = [
  { value: 'conversation', label: 'Conversation' },
  { value: 'workspace', label: 'Workspace' },
];

const CHECKPOINT_SOURCE_INPUT_OPTIONS: ActionInputOption[] = [
  { value: 'provider', label: 'Provider' },
  { value: 'happier_scm', label: 'Happier SCM' },
  { value: 'composed', label: 'Composed' },
];

const REVIEW_COMMENT_ACTION_TITLES: Readonly<Record<ReviewCommentActionIdV1, string>> = Object.freeze({
  'reviews.comments.create': 'Create review comment',
  'reviews.comments.list': 'List review comments',
  'reviews.comments.get': 'Get review comment',
  'reviews.comments.transition': 'Transition review comment',
  'reviews.comments.edit': 'Edit review comment',
  'reviews.comments.reply': 'Reply to review comment',
  'reviews.comments.redact': 'Redact review comment',
  'reviews.comments.setDisposition': 'Set review comment disposition',
  'reviews.comments.attachEvidence': 'Attach review comment evidence',
  'reviews.comments.bulkTransition': 'Bulk transition review comments',
});

const REVIEW_COMMENT_ACTION_SDK_METHODS: Readonly<Record<ReviewCommentActionIdV1, string>> = Object.freeze({
  'reviews.comments.create': 'reviews.comments.create',
  'reviews.comments.list': 'reviews.comments.list',
  'reviews.comments.get': 'reviews.comments.get',
  'reviews.comments.transition': 'reviews.comments.transition',
  'reviews.comments.edit': 'reviews.comments.edit',
  'reviews.comments.reply': 'reviews.comments.reply',
  'reviews.comments.redact': 'reviews.comments.redact',
  'reviews.comments.setDisposition': 'reviews.comments.setDisposition',
  'reviews.comments.attachEvidence': 'reviews.comments.attachEvidence',
  'reviews.comments.bulkTransition': 'reviews.comments.bulkTransition',
});

const REVIEW_COMMENT_ACTION_RPC_METHODS: Readonly<Record<ReviewCommentActionIdV1, string>> = Object.freeze({
  'reviews.comments.create': RPC_METHODS.REVIEW_COMMENTS_CREATE,
  'reviews.comments.list': RPC_METHODS.REVIEW_COMMENTS_LIST,
  'reviews.comments.get': RPC_METHODS.REVIEW_COMMENTS_GET,
  'reviews.comments.transition': RPC_METHODS.REVIEW_COMMENTS_TRANSITION,
  'reviews.comments.edit': RPC_METHODS.REVIEW_COMMENTS_EDIT,
  'reviews.comments.reply': RPC_METHODS.REVIEW_COMMENTS_REPLY,
  'reviews.comments.redact': RPC_METHODS.REVIEW_COMMENTS_REDACT,
  'reviews.comments.setDisposition': RPC_METHODS.REVIEW_COMMENTS_SET_DISPOSITION,
  'reviews.comments.attachEvidence': RPC_METHODS.REVIEW_COMMENTS_ATTACH_EVIDENCE,
  'reviews.comments.bulkTransition': RPC_METHODS.REVIEW_COMMENTS_BULK_TRANSITION,
});

const PluginSessionHookAgentPluginInputSchema = z.object({
  localId: asProtocolZod(PluginContributionLocalIdSchema),
}).strict();
const PluginSessionHookStatusPluginInputV1Schema = z.discriminatedUnion('intent', [
  z.object({
    intent: z.literal('passive_inventory'),
    agent: PluginSessionHookAgentPluginInputSchema.optional(),
    cursor: z.string().min(1).max(4_096).optional(),
    limit: z.number()
      .int()
      .min(1)
      .max(PLUGIN_SESSION_HOOK_STATUS_INVENTORY_MAX_ROWS)
      .default(PLUGIN_SESSION_HOOK_STATUS_INVENTORY_DEFAULT_LIMIT),
  }).strict(),
  z.object({
    intent: z.literal('install_preview'),
    agent: PluginSessionHookAgentPluginInputSchema,
  }).strict(),
  z.object({
    intent: z.literal('installation_recheck'),
    agent: PluginSessionHookAgentPluginInputSchema,
    installationId: z.string().trim().min(1).max(512),
  }).strict(),
]);
const PluginSessionHookInstallPluginInputV1Schema = z.object({
  agent: PluginSessionHookAgentPluginInputSchema,
  expectedPreviewId: z.string().regex(/^hook-install-preview:v1:[0-9a-f]{64}$/u),
}).strict();
const PluginSessionHookMutationPluginInputV1Schema = z.object({
  agent: PluginSessionHookAgentPluginInputSchema,
  installationId: z.string().trim().min(1).max(512),
}).strict();

function bindPluginSessionHookAgent(
  value: unknown,
  context: ActionSurfaceBindingContext,
): unknown {
  const caller = requirePluginBindingCaller(context);
  const input = z.object({
    agent: PluginSessionHookAgentPluginInputSchema.optional(),
  }).passthrough().parse(value);
  return {
    ...input,
    ...(input.agent
      ? { agent: { pluginId: caller.pluginId, localId: input.agent.localId } }
      : {}),
  };
}

function projectPluginSessionHookStatus(
  value: unknown,
  context: ActionSurfaceBindingContext,
): unknown {
  const caller = requirePluginBindingCaller(context);
  const response = PluginSessionHookStatusResponseV1Schema.parse(value);
  return response.ok
    ? {
        ...response,
        rows: response.rows.filter((row) => row.agent.pluginId === caller.pluginId),
      }
    : response;
}

const PluginSessionHookRpcSurfaceBinding = {
  inputSchema: PluginSessionHookStatusInputV1Schema,
  decodeInput: (value: unknown) => value,
  outputSchema: PluginSessionHookStatusResponseV1Schema,
  encodeOutput: (value: unknown) => value,
} as const;

const PLUGIN_PERMISSION_GRANT_ACTION_TITLES: Readonly<Record<PluginPermissionGrantActionIdV1, string>> = Object.freeze({
  'plugins.permissions.grants.list': 'List plugin permission grants',
  'plugins.permissions.grants.request': 'Request plugin permission grant',
  'plugins.permissions.grants.grant': 'Grant plugin permission',
  'plugins.permissions.grants.revoke': 'Revoke plugin permission',
  'plugins.permissions.grants.dismissRequest': 'Dismiss plugin permission request',
});

const PLUGIN_PERMISSION_GRANT_ACTION_RPC_METHODS: Readonly<Record<PluginPermissionGrantActionIdV1, string>> = Object.freeze({
  'plugins.permissions.grants.list': RPC_METHODS.PLUGIN_PERMISSION_GRANTS_LIST,
  'plugins.permissions.grants.request': RPC_METHODS.PLUGIN_PERMISSION_GRANTS_REQUEST,
  'plugins.permissions.grants.grant': RPC_METHODS.PLUGIN_PERMISSION_GRANTS_GRANT,
  'plugins.permissions.grants.revoke': RPC_METHODS.PLUGIN_PERMISSION_GRANTS_REVOKE,
  'plugins.permissions.grants.dismissRequest': RPC_METHODS.PLUGIN_PERMISSION_GRANTS_DISMISS_REQUEST,
});

const PluginPermissionSubjectPluginInputSchema = z.discriminatedUnion('kind', [
  PluginPermissionSubjectV1Schema.options[0],
  PluginPermissionSubjectV1Schema.options[1].omit({ contribution: true }).extend({
    contribution: z.object({ localId: asProtocolZod(PluginContributionLocalIdSchema) }).strict(),
  }).strict(),
]);
const PluginPermissionGrantListPluginInputSchema =
  PluginPermissionGrantActionInputSchemasV1['plugins.permissions.grants.list']
    .omit({ pluginId: true, grantId: true, subject: true })
    .extend({ subject: PluginPermissionSubjectPluginInputSchema.optional() })
    .strict();
const PluginPermissionGrantRequestPluginInputSchema =
  PluginPermissionGrantActionInputSchemasV1['plugins.permissions.grants.request'].omit({
    pluginId: true,
    requester: true,
    subject: true,
  }).extend({ subject: PluginPermissionSubjectPluginInputSchema }).strict();
const PLUGIN_PERMISSION_GRANT_PLUGIN_INPUT_SCHEMAS = Object.freeze({
  'plugins.permissions.grants.list': PluginPermissionGrantListPluginInputSchema,
  'plugins.permissions.grants.request': PluginPermissionGrantRequestPluginInputSchema,
  'plugins.permissions.grants.revoke': PluginPermissionGrantActionInputSchemasV1['plugins.permissions.grants.revoke'],
});

function requirePluginBindingCaller(context: ActionSurfaceBindingContext): Readonly<{
  kind: 'plugin';
  pluginId: string;
}> {
  if (context.caller.kind !== 'plugin') {
    throw new Error('plugin_surface_caller_required');
  }
  return context.caller;
}

function bindPluginCurrentSessionInput(
  value: unknown,
  context: ActionSurfaceBindingContext,
): unknown {
  requirePluginBindingCaller(context);
  const sessionId = typeof context.defaultSessionId === 'string'
    ? context.defaultSessionId.trim()
    : '';
  if (!sessionId) throw new Error('plugin_current_session_required');
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('plugin_session_interaction_input_invalid');
  }
  return { ...value, sessionId };
}

function projectPluginSessionInteractionResponse(value: unknown): unknown {
  if (value === undefined || value === null) return { ok: true };
  const parsed = SessionInteractionResponseSuccessSchema.safeParse(value);
  if (!parsed.success) throw new Error('plugin_session_interaction_result_invalid');
  return parsed.data;
}

function bindPluginPermissionSubject(
  subject: z.infer<typeof PluginPermissionSubjectPluginInputSchema> | undefined,
  pluginId: string,
): unknown {
  if (!subject || subject.kind === 'general') return subject;
  return {
    ...subject,
    contribution: {
      pluginId,
      localId: subject.contribution.localId,
    },
  };
}

/**
 * The single vocabulary for the plugin scaffold's UI mode. Every surface that
 * accepts `--ui` (CLI parser, `plugins.scaffold` action input, scaffold engine)
 * resolves the mode through this schema.
 */
export const PluginScaffoldUiModeSchema = z.enum(['hostedWeb', 'reactNative']);
export type PluginScaffoldUiMode = z.infer<typeof PluginScaffoldUiModeSchema>;

const PluginScaffoldActionInputSchema = z.object({
  targetDir: z.string().trim().min(1),
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  ui: PluginScaffoldUiModeSchema.optional(),
}).strict();

const PluginInstallActionInputSchema = z.object({
  path: z.string().trim().min(1),
  dev: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  force: z.boolean().optional(),
}).strict();

const PluginUninstallActionInputSchema = z.object({
  pluginId: z.string().trim().min(1),
}).strict();

const PluginReloadActionInputSchema = z.object({
  pluginId: z.string().trim().min(1),
}).strict();

const PluginDevActionInputSchema = z.object({
  projectRoot: z.string().trim().min(1),
  sdkRegistryOrigin: z.string().trim().min(1).optional(),
}).strict();

const PluginAuthorActionInputSchema = z.object({
  projectRoot: z.string().trim().min(1),
  sdkRegistryOrigin: z.string().trim().min(1).optional(),
}).strict();

const PluginDoctorActionInputSchema = z.object({
  locator: z.string().trim().min(1),
}).strict();

const PluginPackActionInputSchema = z.object({
  locator: z.string().trim().min(1),
  outPath: z.string().trim().min(1).optional(),
  sdkRegistryOrigin: z.string().trim().min(1).optional(),
}).strict();

const PluginListActionInputSchema = z.object({}).strict();

const PluginChangeStatusActionInputSchema = z.object({
  pendingChangeId: z.string().trim().min(1),
}).strict();

const PluginDevLoopActionInputSchemas = {
  'plugins.scaffold': PluginScaffoldActionInputSchema,
  'plugins.install': PluginInstallActionInputSchema,
  'plugins.uninstall': PluginUninstallActionInputSchema,
  'plugins.dev': PluginDevActionInputSchema,
  'plugins.author.install': PluginAuthorActionInputSchema,
  'plugins.author.typecheck': PluginAuthorActionInputSchema,
  'plugins.author.build': PluginAuthorActionInputSchema,
  'plugins.author.test': PluginAuthorActionInputSchema,
  'plugins.doctor': PluginDoctorActionInputSchema,
  'plugins.pack': PluginPackActionInputSchema,
  'plugins.reload': PluginReloadActionInputSchema,
  'plugins.list': PluginListActionInputSchema,
  'plugins.change.status': PluginChangeStatusActionInputSchema,
} as const satisfies Readonly<Record<PluginDevLoopActionIdV1, z.ZodTypeAny>>;

const PluginDevLoopActionResultKindSchema = z.enum([
  'plugins_scaffold',
  'plugins_install',
  'plugins_uninstall',
  'plugins_dev',
  'plugins_author_install',
  'plugins_author_typecheck',
  'plugins_author_build',
  'plugins_author_test',
  'plugins_doctor',
  'plugins_pack',
  'plugins_reload',
  'plugins_list',
  'plugins_change_status',
]);

const PluginDevLoopPendingReviewSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('sourceRootReviewRequired'),
    pendingChangeId: z.string().trim().min(1),
    // The daemon/CLI change owner retains the source-review payload contract.
    // Action consumers receive it only as an opaque, nested projection.
    review: z.object({}).passthrough(),
  }).passthrough(),
  z.object({
    kind: z.literal('reviewRequired'),
    pendingChangeId: z.string().trim().min(1),
    // The daemon/CLI change owner retains the package-review payload contract.
    review: z.object({}).passthrough(),
  }).passthrough(),
]);

const PluginDevLoopReviewRequiredActionOutputSchema = z.object({
  ok: z.literal(false),
  kind: z.enum(['plugins_install', 'plugins_dev', 'plugins_reload']),
  outcome: z.literal('reviewRequired'),
  // A pending daemon candidate is one nested value. An Action may report it,
  // but never decides it or supplies authenticated user interaction evidence.
  pendingReview: PluginDevLoopPendingReviewSchema,
  pendingChangeId: z.never().optional(),
  review: z.never().optional(),
}).passthrough();

const PluginDevLoopChangeStatusActionOutputSchema = z.object({
  ok: z.literal(true),
  kind: z.literal('plugins_change_status'),
  // Status is daemon-lifetime state owned by the CLI change client. Keep its
  // state/result payload opaque here instead of introducing a second owner.
  status: z.object({}).passthrough(),
}).passthrough();

const PluginDevLoopOrdinaryActionOutputSchema = z.object({
  ok: z.boolean(),
  kind: PluginDevLoopActionResultKindSchema.exclude(['plugins_change_status']),
  // Only install currently emits an ordinary outcome. Keeping this bounded
  // prevents a review-required result from bypassing its typed envelope.
  outcome: z.enum(['applied', 'failed']).optional(),
  pendingReview: z.never().optional(),
  pendingChangeId: z.never().optional(),
  review: z.never().optional(),
}).passthrough();

const PluginDevLoopActionOutputSchema = z.union([
  PluginDevLoopReviewRequiredActionOutputSchema,
  PluginDevLoopChangeStatusActionOutputSchema,
  PluginDevLoopOrdinaryActionOutputSchema,
]);

const PLUGIN_DEV_LOOP_ACTION_TITLES: Readonly<Record<PluginDevLoopActionIdV1, string>> = Object.freeze({
  'plugins.scaffold': 'Scaffold plugin',
  'plugins.install': 'Install plugin',
  'plugins.uninstall': 'Uninstall plugin',
  'plugins.dev': 'Submit plugin development snapshot',
  'plugins.author.install': 'Prepare plugin author dependencies',
  'plugins.author.typecheck': 'Typecheck plugin author source',
  'plugins.author.build': 'Build plugin author source',
  'plugins.author.test': 'Test plugin author source',
  'plugins.doctor': 'Diagnose plugin author source',
  'plugins.pack': 'Pack plugin',
  'plugins.reload': 'Reload plugin',
  'plugins.list': 'List plugins',
  'plugins.change.status': 'Get plugin change status',
});

const PLUGIN_DEV_LOOP_ACTION_DESCRIPTIONS: Readonly<Record<PluginDevLoopActionIdV1, string>> = Object.freeze({
  'plugins.scaffold': 'Create a local plugin scaffold from the first-party template.',
  'plugins.install': 'Install a local plugin source and optionally enable the dev reload loop.',
  'plugins.uninstall': 'Remove a local installed plugin through the daemon-owned plugin lifecycle.',
  'plugins.dev': 'Inspect a local plugin source and submit its current snapshot to the daemon-owned development cycle without starting a watcher.',
  'plugins.author.install': 'Prepare external plugin-author dependencies through the managed runtime.',
  'plugins.author.typecheck': 'Run the managed TypeScript check for an external plugin-author source.',
  'plugins.author.build': 'Build an external plugin-author source through the managed runtime.',
  'plugins.author.test': 'Run the external plugin-author test command through the managed runtime.',
  'plugins.doctor': 'Evaluate and diagnose an external plugin-author source.',
  'plugins.pack': 'Validate and package a local plugin into an installable archive.',
  'plugins.reload': 'Reload one local development plugin through the daemon-owned plugin lifecycle.',
  'plugins.list': 'List installed plugins with source and load diagnostics.',
  'plugins.change.status': 'Read one daemon-issued pending plugin change without creating or deciding it.',
});

function createPluginDevLoopActionSpec(actionId: PluginDevLoopActionIdV1): PreNormalizedActionSpec {
  const isRead = actionId === 'plugins.list' || actionId === 'plugins.change.status';
  const isInspectorUiAction = actionId === 'plugins.list'
    || actionId === 'plugins.reload'
    || actionId === 'plugins.change.status';
  const inputSchema = PluginDevLoopActionInputSchemas[actionId];

  return {
    id: actionId,
    title: PLUGIN_DEV_LOOP_ACTION_TITLES[actionId],
    description: PLUGIN_DEV_LOOP_ACTION_DESCRIPTIONS[actionId],
    safety: isRead ? 'safe' : 'danger',
    placements: [],
    bindings: {
      mcpToolName: actionId.replaceAll('.', '_'),
    },
    surfaces: {
      ui: isInspectorUiAction,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    sideEffectClass: actionId === 'plugins.uninstall' ? 'danger' : isRead ? 'read' : 'write',
    outputSchema: PluginDevLoopActionOutputSchema,
    inputSchema,
    inputHints: { fields: [] },
  };
}

const PLUGIN_SETTINGS_ADMINISTRATION_ACTION_TITLES: Readonly<Record<
  PluginSettingsAdministrationActionIdV1,
  string
>> = Object.freeze({
  'plugins.settings.list': 'List plugin settings',
  'plugins.settings.get': 'Get plugin setting',
  'plugins.settings.set': 'Set plugin setting',
  'plugins.settings.reset': 'Reset plugin setting',
  'plugins.settings.secret.status': 'Get plugin secret status',
  'plugins.settings.secret.bind': 'Bind existing saved secret',
  'plugins.settings.secret.unbind': 'Unbind plugin secret',
  'plugins.settings.secret.delete': 'Delete plugin secret',
});

const PLUGIN_SETTINGS_ADMINISTRATION_ACTION_DESCRIPTIONS: Readonly<Record<
  PluginSettingsAdministrationActionIdV1,
  string
>> = Object.freeze({
  'plugins.settings.list': 'List declared plugin Settings for one exact Account or daemon scope.',
  'plugins.settings.get': 'Read one declared non-secret plugin Setting from one exact scope.',
  'plugins.settings.set': 'Compare-and-set one declared non-secret plugin Setting.',
  'plugins.settings.reset': 'Reset one declared non-secret plugin Setting to its owner default.',
  'plugins.settings.secret.status': 'Read safe configured status for one declared plugin secret.',
  'plugins.settings.secret.bind': 'Bind one plugin secret to an existing SavedSecret identity without exposing its value.',
  'plugins.settings.secret.unbind': 'Remove the binding for one plugin secret without exposing its value.',
  'plugins.settings.secret.delete': 'Delete one plugin secret through its declared custody owner without exposing its value.',
});

function createPluginSettingsAdministrationActionSpec(
  actionId: PluginSettingsAdministrationActionIdV1,
): PreNormalizedActionSpec {
  const isRead = actionId === 'plugins.settings.list'
    || actionId === 'plugins.settings.get'
    || actionId === 'plugins.settings.secret.status';

  return {
    id: actionId,
    title: PLUGIN_SETTINGS_ADMINISTRATION_ACTION_TITLES[actionId],
    description: PLUGIN_SETTINGS_ADMINISTRATION_ACTION_DESCRIPTIONS[actionId],
    safety: isRead ? 'safe' : 'danger',
    placements: [],
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: true,
      rpc: false,
    },
    sideEffectClass: isRead ? 'read' : 'write',
    outputSchema: PluginSettingsAdministrationActionOutputV1Schema,
    inputSchema: PluginSettingsAdministrationActionInputSchemasV1[actionId],
    inputHints: { fields: [] },
  };
}

function createPluginPermissionGrantActionSpec(actionId: PluginPermissionGrantActionIdV1): PreNormalizedActionSpec {
  const isRead = actionId === 'plugins.permissions.grants.list';
  const pluginBinding = actionId === 'plugins.permissions.grants.list'
    ? {
        inputSchema: PluginPermissionGrantListPluginInputSchema,
        bindInput(value: unknown, context: ActionSurfaceBindingContext) {
          const caller = requirePluginBindingCaller(context);
          const input = value as z.infer<typeof PluginPermissionGrantListPluginInputSchema>;
          return {
            ...input,
            pluginId: caller.pluginId,
            ...(input.subject
              ? { subject: bindPluginPermissionSubject(input.subject, caller.pluginId) }
              : {}),
          };
        },
      }
    : actionId === 'plugins.permissions.grants.request'
      ? {
          inputSchema: PluginPermissionGrantRequestPluginInputSchema,
          bindInput(value: unknown, context: ActionSurfaceBindingContext) {
            const caller = requirePluginBindingCaller(context);
            const input = value as z.infer<typeof PluginPermissionGrantRequestPluginInputSchema>;
            return {
              ...input,
              pluginId: caller.pluginId,
              subject: bindPluginPermissionSubject(input.subject, caller.pluginId),
              requester: {
                kind: 'plugin' as const,
                pluginId: caller.pluginId,
                ...(context.defaultSessionId ? { sessionId: context.defaultSessionId } : {}),
              },
            };
          },
        }
      : actionId === 'plugins.permissions.grants.revoke'
        ? {
            inputSchema: PLUGIN_PERMISSION_GRANT_PLUGIN_INPUT_SCHEMAS[actionId],
          }
        : undefined;
  return {
    id: actionId,
    title: PLUGIN_PERMISSION_GRANT_ACTION_TITLES[actionId],
    description: 'Manage durable user-approved optional plugin permission grants.',
    safety: isRead ? 'safe' : 'danger',
    placements: [],
    bindings: {
      rpcMethod: PLUGIN_PERMISSION_GRANT_ACTION_RPC_METHODS[actionId],
      sdkMethod: actionId,
    },
    ...(pluginBinding ? { surfaceBindings: { plugin: pluginBinding } } : {}),
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: isRead ? 'read' : 'write',
    outputSchema: PluginPermissionGrantActionOutputSchemasV1[actionId],
    inputSchema: PluginPermissionGrantActionInputSchemasV1[actionId],
    inputHints: { fields: [] },
  };
}

const PLUGIN_WEBHOOK_ACTION_TITLES: Readonly<Record<PluginWebhookActionIdV1, string>> = Object.freeze({
  'plugin.webhook.endpoint.ensure': 'Ensure webhook endpoint',
  'plugin.webhook.endpoint.read': 'Read webhook endpoint',
  'plugin.webhook.endpoint.revoke': 'Revoke webhook endpoint',
  'plugin.webhook.endpoint.retarget': 'Retarget webhook endpoint',
  'plugin.webhook.endpoint.checkCorrespondence': 'Check webhook endpoint correspondence',
  'plugin.webhook.delivery.movePending': 'Move pending webhook deliveries',
  'plugin.webhook.endpoint.credential.configure': 'Configure webhook credential',
  'plugin.webhook.endpoint.credential.rotate': 'Rotate webhook credential',
  'plugin.webhook.endpoint.credential.finishRotation': 'Finish webhook credential rotation',
});

function createPluginWebhookActionSpec(actionId: PluginWebhookActionIdV1): PreNormalizedActionSpec {
  const isCorrespondenceCheck = actionId === 'plugin.webhook.endpoint.checkCorrespondence';
  const readOnly = actionId === 'plugin.webhook.endpoint.read' || isCorrespondenceCheck;
  return {
    id: actionId,
    title: PLUGIN_WEBHOOK_ACTION_TITLES[actionId],
    description: 'Manage one Account-owned webhook endpoint through the canonical Webhook ingress owner.',
    safety: readOnly ? 'safe' : 'danger',
    placements: [],
    surfaces: {
      ui: !isCorrespondenceCheck,
      voice: false,
      agent: false,
      mcp: false,
      cli: !isCorrespondenceCheck,
      rpc: false,
    },
    sideEffectClass: readOnly ? 'read' : 'write',
    outputSchema: PluginWebhookActionOutputSchemasV1[actionId],
    inputSchema: PluginWebhookActionInputSchemasV1[actionId],
    inputHints: { fields: [] },
  };
}

const AUTOMATION_EVENT_ACTION_TITLES: Readonly<Record<AutomationEventActionIdV1, string>> = Object.freeze({
  'automation.event.sources.list': 'List Automation Event sources',
  'automation.event.admit': 'Admit Automation Event occurrence',
  'automation.event.source.status.report': 'Report Automation Event source status',
});

function createAutomationEventActionSpec(actionId: AutomationEventActionIdV1): PreNormalizedActionSpec {
  const readOnly = actionId === 'automation.event.sources.list';
  return {
    id: actionId,
    title: AUTOMATION_EVENT_ACTION_TITLES[actionId],
    description: 'Read or update Event Automation state through the canonical Automation owner.',
    safety: readOnly ? 'safe' : 'danger',
    placements: [],
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: false,
    },
    sideEffectClass: readOnly ? 'read' : 'write',
    outputSchema: AutomationEventActionOutputSchemasV1[actionId],
    inputSchema: AutomationEventActionInputSchemasV1[actionId],
    inputHints: { fields: [] },
  };
}

const AUTOMATION_CONVERSATION_ACTION_TITLES: Readonly<
  Record<AutomationConversationActionIdV1, string>
> = Object.freeze({
  'automation.conversation.targets.list': 'List Automation conversation targets',
  'automation.conversation.target.verify': 'Verify Automation conversation target',
  'automation.conversation.admit': 'Admit Automation conversation occurrence',
});

function createAutomationConversationActionSpec(
  actionId: AutomationConversationActionIdV1,
): PreNormalizedActionSpec {
  const readOnly = actionId === 'automation.conversation.targets.list'
    || actionId === 'automation.conversation.target.verify';
  const description = actionId === 'automation.conversation.targets.list'
    ? 'List current selectable Automation conversation targets through the canonical Automation owner.'
    : readOnly
      ? 'Verify an Automation conversation target through the canonical Automation owner.'
      : 'Admit a conversation occurrence through the canonical Automation owner.';
  return {
    id: actionId,
    title: AUTOMATION_CONVERSATION_ACTION_TITLES[actionId],
    description,
    safety: readOnly ? 'safe' : 'danger',
    placements: [],
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: false,
    },
    sideEffectClass: readOnly ? 'read' : 'write',
    outputSchema: AutomationConversationActionOutputSchemasV1[actionId],
    inputSchema: AutomationConversationActionInputSchemasV1[actionId],
    inputHints: { fields: [] },
  };
}

function createReviewCommentActionSpec(actionId: ReviewCommentActionIdV1): PreNormalizedActionSpec {
  const isRead = actionId === 'reviews.comments.list' || actionId === 'reviews.comments.get';
  return {
    id: actionId,
    title: REVIEW_COMMENT_ACTION_TITLES[actionId],
    description: 'Operate on durable review comments through the shared review-comment substrate.',
    safety: isRead ? 'safe' : 'danger',
    placements: [],
    bindings: {
      rpcMethod: REVIEW_COMMENT_ACTION_RPC_METHODS[actionId],
      sdkMethod: REVIEW_COMMENT_ACTION_SDK_METHODS[actionId],
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: isRead ? 'read' : 'write',
    outputSchema: ReviewCommentActionOutputSchemasV1[actionId],
    inputSchema: ReviewCommentActionInputSchemasV1[actionId],
    inputHints: { fields: [] },
  };
}

const PLUGIN_SESSION_HOOK_MANAGEMENT_ACTION_SPECS_V1 = [
  {
    id: 'plugins.sessionHooks.status.get',
    title: 'Get Agent session-hook status inventory',
    description:
      'Read a bounded, paginated inventory of portable External Session hook installation status rows.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.DAEMON_PLUGIN_SESSION_HOOKS_STATUS_GET },
    surfaceBindings: {
      rpc: PluginSessionHookRpcSurfaceBinding,
      plugin: {
        inputSchema: PluginSessionHookStatusPluginInputV1Schema,
        bindInput: bindPluginSessionHookAgent,
        projectOutput: projectPluginSessionHookStatus,
      },
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'read',
    outputSchema: PluginSessionHookStatusResponseV1Schema,
    inputSchema: PluginSessionHookStatusActionInputV1Schema,
    inputHints: { fields: [] },
  },
  {
    id: 'plugins.sessionHooks.install',
    title: 'Install Agent session hooks',
    description: 'Explicitly install External Session hooks for one qualified Agent integration.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.DAEMON_PLUGIN_SESSION_HOOKS_INSTALL },
    surfaceBindings: {
      rpc: {
        inputSchema: PluginSessionHookInstallInputV1Schema,
        decodeInput: (value: unknown) => value,
        outputSchema: PluginSessionHookInstallResponseV1Schema,
        encodeOutput: (value: unknown) => value,
      },
      plugin: {
        inputSchema: PluginSessionHookInstallPluginInputV1Schema,
        bindInput: bindPluginSessionHookAgent,
      },
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'write',
    outputSchema: PluginSessionHookInstallResponseV1Schema,
    inputSchema: PluginSessionHookInstallActionInputV1Schema,
    inputHints: { fields: [] },
  },
  {
    id: 'plugins.sessionHooks.disable',
    title: 'Disable Agent session hooks',
    description: 'Explicitly disable ingestion for one exact Agent hook installation without deleting its owned config.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.DAEMON_PLUGIN_SESSION_HOOKS_DISABLE },
    surfaceBindings: {
      rpc: {
        inputSchema: PluginSessionHookInstallationMutationInputV1Schema,
        decodeInput: (value: unknown) => value,
        outputSchema: PluginSessionHookToggleResponseV1Schema,
        encodeOutput: (value: unknown) => value,
      },
      plugin: {
        inputSchema: PluginSessionHookMutationPluginInputV1Schema,
        bindInput: bindPluginSessionHookAgent,
      },
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'write',
    outputSchema: PluginSessionHookToggleResponseV1Schema,
    inputSchema: PluginSessionHookInstallationMutationActionInputV1Schema,
    inputHints: { fields: [] },
  },
  {
    id: 'plugins.sessionHooks.enable',
    title: 'Enable Agent session hooks',
    description: 'Explicitly enable ingestion for one exact Agent hook installation.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.DAEMON_PLUGIN_SESSION_HOOKS_ENABLE },
    surfaceBindings: {
      rpc: {
        inputSchema: PluginSessionHookInstallationMutationInputV1Schema,
        decodeInput: (value: unknown) => value,
        outputSchema: PluginSessionHookToggleResponseV1Schema,
        encodeOutput: (value: unknown) => value,
      },
      plugin: {
        inputSchema: PluginSessionHookMutationPluginInputV1Schema,
        bindInput: bindPluginSessionHookAgent,
      },
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'write',
    outputSchema: PluginSessionHookToggleResponseV1Schema,
    inputSchema: PluginSessionHookInstallationMutationActionInputV1Schema,
    inputHints: { fields: [] },
  },
  {
    id: 'plugins.sessionHooks.uninstall',
    title: 'Uninstall Agent session hooks',
    description: 'Explicitly remove only the owned entries for one exact External Session hook installation.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.DAEMON_PLUGIN_SESSION_HOOKS_UNINSTALL },
    surfaceBindings: {
      rpc: {
        inputSchema: PluginSessionHookInstallationMutationInputV1Schema,
        decodeInput: (value: unknown) => value,
        outputSchema: PluginSessionHookUninstallResponseV1Schema,
        encodeOutput: (value: unknown) => value,
      },
      plugin: {
        inputSchema: PluginSessionHookMutationPluginInputV1Schema,
        bindInput: bindPluginSessionHookAgent,
      },
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'danger',
    outputSchema: PluginSessionHookUninstallResponseV1Schema,
    inputSchema: PluginSessionHookInstallationMutationActionInputV1Schema,
    inputHints: { fields: [] },
  },
] as const satisfies readonly PreNormalizedActionSpec[];

const EXTERNAL_SESSION_OPERATION_REFERENCE_INPUT_HINT_FIELDS: ActionInputHints['fields'] = [
  { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
  { path: 'operationId', title: 'Operation id', widget: 'text', required: true },
  { path: 'revision', title: 'Revision', widget: 'text', required: true },
];

function identityActionSurfaceValue(value: unknown): unknown {
  return value;
}

function projectExternalSessionOperationResult(
  value: unknown,
  context: ActionSurfaceBindingContext,
): unknown {
  const semantic = ExternalSessionOperationActionResultV1Schema.safeParse(value);
  const materialize = ExternalSessionMaterializeActionInputV1Schema.safeParse(
    context.input,
  );
  const reference = ExternalSessionOperationStatusInputV1Schema.safeParse(
    context.input,
  );
  const sessionId = materialize.success
    ? materialize.data.request.sessionId
    : reference.success
      ? reference.data.sessionId
      : null;
  if (!sessionId) throw new Error('external_session_operation_input_required');
  if (semantic.success) {
    if (
      semantic.data.ok
      && semantic.data.operation.sessionId !== sessionId
    ) {
      throw new Error('external_session_operation_session_mismatch');
    }
    return semantic.data;
  }
  return projectExternalSessionOperationActionResultV1(value, sessionId);
}

function projectExternalSessionMaterializeResult(
  value: unknown,
  context: ActionSurfaceBindingContext,
): unknown {
  const materialize = ExternalSessionMaterializeActionInputV1Schema.parse(
    context.input,
  );
  return projectExternalSessionMaterializeActionResultV1(
    value,
    materialize.request.sessionId,
  );
}

function projectExternalSessionStatusResult(value: unknown): unknown {
  const response = ExternalSessionStatusGetResponseSchema.parse(value);
  return response.ok
    ? ExternalSessionStatusActionResultV1Schema.parse({
        ok: true,
        machineOnline: response.machineOnline,
        runnerActive: response.runnerActive,
        activity: response.activity,
        canTakeOverDirect: response.canTakeOverDirect,
        canTakeOverPersist: response.canTakeOverPersist,
        canForceStop: response.canForceStop,
        ...(response.lastKnownActivityAtMs === undefined
          ? {}
          : { lastKnownActivityAtMs: response.lastKnownActivityAtMs }),
      })
    : ExternalSessionStatusActionResultV1Schema.parse({
        ok: false,
        errorCode: response.errorCode,
        error: response.error,
      });
}

function projectExternalSessionViewerFollowResult(value: unknown): unknown {
  const response = ExternalSessionAttachResponseSchema.parse(value);
  return response.ok
    ? ExternalSessionViewerFollowActionResultV1Schema.parse({
        ok: true,
        leaseId: response.leaseId,
        expiresAtMs: response.expiresAtMs,
        renewed: response.renewed ?? false,
        ...(response.acceptedTailCursor === undefined
          ? {}
          : { acceptedTailCursor: response.acceptedTailCursor }),
      })
    : ExternalSessionViewerFollowActionResultV1Schema.parse({
        ok: false,
        errorCode: response.errorCode,
        error: response.error,
        ...(response.retryable === undefined
          ? {}
          : { retryable: response.retryable }),
      });
}

function projectExternalSessionViewerUnfollowResult(value: unknown): unknown {
  const response = ExternalSessionDetachResponseSchema.parse(value);
  return ExternalSessionViewerUnfollowActionResultV1Schema.parse(response.ok
    ? { ok: true, detached: response.detached }
    : {
        ok: false,
        errorCode: response.errorCode,
        error: response.error,
      });
}

function projectExternalSessionBackgroundFollowResult(value: unknown): unknown {
  const response = ExternalSessionFollowPolicySetResponseSchema.parse(value);
  return ExternalSessionBackgroundFollowActionResultV1Schema.parse(response.ok
    ? {
        ok: true,
        enabled: response.enabled,
        leaseActive: response.leaseActive,
        updatedAtMs: response.updatedAtMs,
      }
    : {
        ok: false,
        errorCode: response.errorCode,
        error: response.error,
      });
}

const EXTERNAL_SESSION_OPERATION_ACTION_SPECS_V1 = [
  {
    id: 'sessions.external.materialize.start',
    title: 'Materialize external session',
    description: 'Start or converge on the canonical external-session materialization operation.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_MATERIALIZE_START },
    surfaceBindings: {
      rpc: {
        inputSchema: ExternalSessionMaterializeStartInputV1Schema,
        decodeInput: identityActionSurfaceValue,
        outputSchema: ExternalSessionOperationActionResponseV1Schema,
        encodeOutput: identityActionSurfaceValue,
      },
      plugin: {
        inputSchema: ExternalSessionMaterializeActionInputV1Schema,
        projectOutput: projectExternalSessionMaterializeResult,
      },
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'write',
    outputSchema: ExternalSessionMaterializeActionResultV1Schema,
    inputSchema: ExternalSessionMaterializeActionInputV1Schema,
    inputHints: {
      title: 'Materialize external session',
      fields: [{ path: 'request', title: 'Operation request', widget: 'textarea', required: true }],
    },
  },
  {
    id: 'sessions.external.takeover.start',
    title: 'Start external session takeover',
    description: 'Start or converge on the canonical external-session takeover operation.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_TAKEOVER_START },
    surfaceBindings: {
      rpc: {
        inputSchema: ExternalSessionTakeoverStartInputV1Schema,
        decodeInput: identityActionSurfaceValue,
        outputSchema: ExternalSessionOperationActionResponseV1Schema,
        encodeOutput: identityActionSurfaceValue,
      },
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'danger',
    outputSchema: ExternalSessionOperationActionResponseV1Schema,
    inputSchema: ExternalSessionTakeoverStartInputV1Schema,
    inputHints: {
      title: 'Start external session takeover',
      fields: [{ path: 'request', title: 'Operation request', widget: 'textarea', required: true }],
    },
  },
  {
    id: 'sessions.external.operation.status.get',
    title: 'Get external session operation status',
    description: 'Passively read the current canonical external-session operation projection.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_STATUS_GET },
    surfaceBindings: {
      rpc: {
        inputSchema: ExternalSessionOperationTransportReferenceV1Schema,
        decodeInput: identityActionSurfaceValue,
        outputSchema: ExternalSessionOperationActionResponseV1Schema,
        encodeOutput: identityActionSurfaceValue,
      },
      plugin: {
        inputSchema: ExternalSessionOperationStatusInputV1Schema,
        projectOutput: projectExternalSessionOperationResult,
      },
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'read',
    outputSchema: ExternalSessionOperationActionResultV1Schema,
    inputSchema: ExternalSessionOperationStatusInputV1Schema,
    inputHints: {
      title: 'Get external session operation status',
      fields: EXTERNAL_SESSION_OPERATION_REFERENCE_INPUT_HINT_FIELDS,
    },
  },
  {
    id: 'sessions.external.operation.cancel',
    title: 'Cancel external session operation',
    description: 'Record an explicit cancellation intent for the current operation revision.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_CANCEL },
    surfaceBindings: {
      rpc: {
        inputSchema: ExternalSessionOperationTransportReferenceV1Schema,
        decodeInput: identityActionSurfaceValue,
        outputSchema: ExternalSessionOperationActionResponseV1Schema,
        encodeOutput: identityActionSurfaceValue,
      },
      plugin: {
        inputSchema: ExternalSessionOperationCancelInputV1Schema,
        projectOutput: projectExternalSessionOperationResult,
      },
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'write',
    outputSchema: ExternalSessionOperationActionResultV1Schema,
    inputSchema: ExternalSessionOperationCancelInputV1Schema,
    inputHints: {
      title: 'Cancel external session operation',
      fields: EXTERNAL_SESSION_OPERATION_REFERENCE_INPUT_HINT_FIELDS,
    },
  },
  {
    id: 'sessions.external.operation.resume',
    title: 'Resume external session operation',
    description: 'Explicitly resume a passively hydrated operation from its durable checkpoint.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_RESUME },
    surfaceBindings: {
      rpc: {
        inputSchema: ExternalSessionOperationTransportReferenceV1Schema,
        decodeInput: identityActionSurfaceValue,
        outputSchema: ExternalSessionOperationActionResponseV1Schema,
        encodeOutput: identityActionSurfaceValue,
      },
      plugin: {
        inputSchema: ExternalSessionOperationResumeInputV1Schema,
        projectOutput: projectExternalSessionOperationResult,
      },
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'write',
    outputSchema: ExternalSessionOperationActionResultV1Schema,
    inputSchema: ExternalSessionOperationResumeInputV1Schema,
    inputHints: {
      title: 'Resume external session operation',
      fields: EXTERNAL_SESSION_OPERATION_REFERENCE_INPUT_HINT_FIELDS,
    },
  },
  {
    id: 'sessions.external.operation.retry',
    title: 'Retry external session operation',
    description: 'Explicitly retry the canonical recovery phase at the current revision.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_RETRY },
    surfaceBindings: {
      rpc: {
        inputSchema: ExternalSessionOperationTransportReferenceV1Schema,
        decodeInput: identityActionSurfaceValue,
        outputSchema: ExternalSessionOperationActionResponseV1Schema,
        encodeOutput: identityActionSurfaceValue,
      },
      plugin: {
        inputSchema: ExternalSessionOperationRetryInputV1Schema,
        projectOutput: projectExternalSessionOperationResult,
      },
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'write',
    outputSchema: ExternalSessionOperationActionResultV1Schema,
    inputSchema: ExternalSessionOperationRetryInputV1Schema,
    inputHints: {
      title: 'Retry external session operation',
      fields: EXTERNAL_SESSION_OPERATION_REFERENCE_INPUT_HINT_FIELDS,
    },
  },
  {
    id: 'sessions.external.operation.discard',
    title: 'Discard external session operation',
    description: 'Destructively discard an eligible initial partial operation and its private staging.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_DISCARD },
    surfaceBindings: {
      rpc: {
        inputSchema: ExternalSessionOperationTransportReferenceV1Schema,
        decodeInput: identityActionSurfaceValue,
        outputSchema: ExternalSessionOperationActionResponseV1Schema,
        encodeOutput: identityActionSurfaceValue,
      },
      plugin: {
        inputSchema: ExternalSessionOperationDiscardInputV1Schema,
        projectOutput: projectExternalSessionOperationResult,
      },
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'danger',
    outputSchema: ExternalSessionOperationActionResultV1Schema,
    inputSchema: ExternalSessionOperationDiscardInputV1Schema,
    inputHints: {
      title: 'Discard external session operation',
      fields: EXTERNAL_SESSION_OPERATION_REFERENCE_INPUT_HINT_FIELDS,
    },
  },
] as const satisfies readonly PreNormalizedActionSpec[];

function resolveApprovalMetadataForActionId(actionId: ActionId): ActionApproval {
  if (RESULT_REQUIRED_APPROVAL_ACTION_ID_SET.has(actionId)) return APPROVAL_RESULT_REQUIRED;
  if (RESULT_NONE_DEFERRED_APPROVAL_ACTION_ID_SET.has(actionId)) return APPROVAL_RESULT_NONE_DEFERRED;
  if (RESULT_NONE_APPROVAL_ACTION_ID_SET.has(actionId)) return APPROVAL_RESULT_NONE;
  if (RESULT_OPTIONAL_DEFERRED_APPROVAL_ACTION_ID_SET.has(actionId)) return APPROVAL_RESULT_OPTIONAL_DEFERRED;
  throw new Error(`Missing action approval metadata for ${actionId}`);
}

const EXECUTION_RUN_SESSION_SCOPE_DESCRIPTION =
  'A nonempty sessionId selects that exact authorized Session. Omitting sessionId inherits the current Action Session, or selects detached scope when none exists. sessionId:null selects detached scope even inside a current Session.';

const EXECUTION_RUN_SESSION_SCOPE_HINT = {
  path: 'sessionId',
  title: 'Session id',
  description: 'Use a nonempty value for an exact authorized Session. Omit it to inherit the current Action Session, or to select detached scope when no current Session exists. Set null to select detached scope even inside a current Session.',
  widget: 'text',
} satisfies ActionInputFieldHint;

const EXECUTION_RUN_WAIT_OBSERVATION_DESCRIPTION =
  'Timeout only ends this observation; it does not stop, retry, or start the run. Cancellation only ends this wait.';

const ACTION_SPECS_WITHOUT_APPROVAL = Object.freeze(defineActionSpecs([
  ...PLUGIN_DEV_LOOP_ACTION_IDS_V1.map(createPluginDevLoopActionSpec),
  ...PLUGIN_SETTINGS_ADMINISTRATION_ACTION_IDS_V1.map(createPluginSettingsAdministrationActionSpec),
  ...PLUGIN_PERMISSION_GRANT_ACTION_IDS_V1.map(createPluginPermissionGrantActionSpec),
  ...PLUGIN_WEBHOOK_ACTION_IDS_V1.map(createPluginWebhookActionSpec),
  ...AUTOMATION_EVENT_ACTION_IDS_V1.map(createAutomationEventActionSpec),
  ...AUTOMATION_CONVERSATION_ACTION_IDS_V1.map(createAutomationConversationActionSpec),
  ...REVIEW_COMMENT_ACTION_IDS_V1.map(createReviewCommentActionSpec),
  ...RUNTIME_ACTION_SPECS,
  ...PLUGIN_SESSION_HOOK_MANAGEMENT_ACTION_SPECS_V1,
  ...EXTERNAL_SESSION_OPERATION_ACTION_SPECS_V1,
  {
    id: 'account.plugins.data.erase',
    title: 'Erase Account plugin data',
    description: 'Erase the current Account’s retained data for one plugin without uninstalling local plugin code.',
    safety: 'danger',
    placements: [],
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: false,
    },
    sideEffectClass: 'danger',
    outputSchema: PluginAccountDataEraseActionOutputV1Schema,
    inputSchema: PluginAccountDataEraseActionInputV1Schema,
    inputHints: {
      title: 'Erase Account plugin data',
      description: 'This permanently removes the current Account’s retained data for the selected plugin.',
      fields: [
        { path: 'pluginId', title: 'Plugin id', widget: 'text', required: true },
      ],
    },
  },
  {
    id: 'account.sessions.signOutEverywhere',
    title: 'Sign out everywhere',
    description: 'Invalidate all signed sessions for the current Account. API tokens remain active.',
    safety: 'danger',
    placements: [],
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: false,
    },
    sideEffectClass: 'danger',
    outputSchema: AccountSessionsSignOutEverywhereActionOutputV1Schema,
    inputSchema: AccountSessionsSignOutEverywhereActionInputV1Schema,
    inputHints: {
      title: 'Sign out everywhere',
      description: 'This invalidates signed sessions for the current Account. API tokens remain active.',
      fields: [],
    },
  },
  {
    id: 'account.apiTokens.create',
    title: 'Create API token',
    description: 'Create a named API token for the current Account. The token secret is shown once.',
    safety: 'danger',
    placements: [],
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: false,
    },
    sideEffectClass: 'danger',
    outputSchema: AccountApiTokensCreateActionOutputV1Schema,
    inputSchema: AccountApiTokensCreateActionInputV1Schema,
    inputHints: {
      title: 'Create API token',
      description: 'The full token is displayed once after creation.',
      fields: [
        { path: 'label', title: 'Label', widget: 'text', required: true },
        { path: 'expiresAt', title: 'Expiry', widget: 'text' },
      ],
    },
  },
  {
    id: 'account.apiTokens.list',
    title: 'List API tokens',
    description: 'List non-secret API-token summaries for the current Account.',
    safety: 'safe',
    placements: [],
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: false,
    },
    sideEffectClass: 'read',
    outputSchema: AccountApiTokensListActionOutputV1Schema,
    inputSchema: AccountApiTokensListActionInputV1Schema,
    inputHints: {
      title: 'List API tokens',
      description: 'Returns labels, prefixes, and timestamps only; no token secret is returned.',
      fields: [],
    },
  },
  {
    id: 'account.apiTokens.revoke',
    title: 'Revoke API token',
    description: 'Revoke one API token for the current Account.',
    safety: 'danger',
    placements: [],
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: false,
    },
    sideEffectClass: 'danger',
    outputSchema: AccountApiTokensRevokeActionOutputV1Schema,
    inputSchema: AccountApiTokensRevokeActionInputV1Schema,
    inputHints: {
      title: 'Revoke API token',
      description: 'The token stops working on the server’s next verification.',
      fields: [
        { path: 'tokenId', title: 'Token id', widget: 'text', required: true },
      ],
    },
  },
  {
    id: 'account.apiTokens.revokeAll',
    title: 'Revoke all API tokens',
    description: 'Revoke every API token for the current Account. Signed sessions are unaffected.',
    safety: 'danger',
    placements: [],
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: false,
    },
    sideEffectClass: 'danger',
    outputSchema: AccountApiTokensRevokeAllActionOutputV1Schema,
    inputSchema: AccountApiTokensRevokeAllActionInputV1Schema,
    inputHints: {
      title: 'Revoke all API tokens',
      description: 'This permanently revokes every API token for the current Account.',
      fields: [],
    },
  },
  {
    id: 'action.spec.search',
    title: 'Search action specs',
    sideEffectClass: 'read',
    description: 'Search available Happier action specs by name, description, bindings, and field hints.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'searchActionSpecs', mcpToolName: 'action_spec_search' },
    examples: {
      voice: { argsExample: '{"query":"plan mode","limit":5}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: false,
      rpc: false,
    },
    inputHints: {
      title: 'Search action specs',
      description: 'Use this before guessing action ids or tool names.',
      fields: [
        { path: 'query', title: 'Query', description: 'Natural-language search text.', widget: 'text' },
        { path: 'limit', title: 'Limit', description: 'Maximum number of action specs to return.', widget: 'text' },
      ],
    },
    outputSchema: ActionSpecSearchResultSchema,
    inputSchema: ActionSpecSearchInputSchema,
  },
  {
    id: 'action.spec.get',
    title: 'Get action spec',
    sideEffectClass: 'read',
    description: 'Get one Happier action spec with input hints and examples.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'getActionSpec', mcpToolName: 'action_spec_get' },
    examples: {
      voice: { argsExample: '{"id":"subagents.plan.start"}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: false,
      rpc: false,
    },
    inputHints: {
      title: 'Get action spec',
      fields: [
        { path: 'id', title: 'Action id', description: 'The exact Happier action id.', widget: 'text', required: true },
      ],
    },
    outputSchema: ActionSpecGetResultSchema,
    inputSchema: ActionSpecGetInputSchema,
  },
  {
    id: 'action.options.resolve',
    title: 'Resolve action options',
    sideEffectClass: 'read',
    description: 'Resolve valid options for an action field, including dynamic options sources.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'resolveActionOptions', mcpToolName: 'action_options_resolve' },
    examples: {
      voice: { argsExample: '{"actionId":"subagents.plan.start","fieldPath":"backendTargetKeys","sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'Resolve action options',
      description: 'Use this when an action field has static options or an optionsSourceId.',
      fields: [
        { path: 'actionId', title: 'Action id', description: 'Optional when optionsSourceId is provided directly.', widget: 'text' },
        { path: 'fieldPath', title: 'Field path', description: 'Dot-path for the action input field.', widget: 'text' },
        { path: 'optionsSourceId', title: 'Options source id', description: 'Direct options source lookup when known.', widget: 'text' },
        { path: 'sessionId', title: 'Session id', description: 'Needed for session-scoped option sources.', widget: 'text' },
        { path: 'query', title: 'Query filter', description: 'Optional search text to filter the returned options.', widget: 'text' },
        { path: 'limit', title: 'Limit', description: 'Maximum number of options to return.', widget: 'text' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: ActionOptionsResolveInputSchema,
  },
  {
    id: 'action.invoke',
    title: 'Invoke contributed action',
    description: 'Invoke one currently available contributed Action through the canonical host dispatcher. If the result is `denied`, the person declined the confirmation: report that and do not invoke it again unless they ask.',
    sideEffectClass: 'external',
    safety: 'safe',
    placements: [],
    bindings: { voiceClientToolName: 'invokeAction' },
    examples: {
      voice: { argsExample: '{"action":{"pluginId":"acme.plugin","localId":"open-details"},"input":{"source":"voice"}}' },
    },
    surfaces: {
      ui: false,
      voice: true,
      agent: false,
      mcp: false,
      cli: false,
      rpc: false,
    },
    inputHints: {
      title: 'Invoke contributed action',
      description: 'Use the exact qualified Action identity returned by action discovery and only its declared input.',
      fields: [
        { path: 'action.pluginId', title: 'Plugin id', widget: 'text', required: true },
        { path: 'action.localId', title: 'Action id', widget: 'text', required: true },
        { path: 'input', title: 'Declared Action input', widget: 'textarea' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: ActionInvokeInputSchema,
  },
  {
    id: 'review.start',
    title: 'Start review',
    sideEffectClass: 'external',
    safety: 'safe',
    placements: ['agent_input_chips', 'session_action_menu', 'command_palette', 'slash_command', 'voice_panel'],
    prompting: { voiceHotPath: true },
    slash: { tokens: ['/review', '/h.review'] },
    bindings: { voiceClientToolName: 'startReview', mcpToolName: 'review_start' },
    inputHints: {
      title: 'Start a code review',
      description: 'Start one or more parallel review runs against the current worktree.',
      fields: [
        {
          path: 'engineIds',
          title: 'Review engines',
          description: 'Select one or more engines. Each engine runs as its own execution run.',
          widget: 'multiselect',
          required: true,
          requireExplicitSelection: true,
          optionsSourceId: 'review.engines.available',
        },
        {
          path: 'instructions',
          title: 'Instructions',
          description: 'What you want the reviewers to focus on.',
          widget: 'textarea',
          required: true,
        },
        {
          path: 'changeType',
          title: 'Change type',
          description: 'Which changes to review.',
          widget: 'select',
          required: true,
          options: [
            { value: 'committed', label: 'Committed' },
            { value: 'uncommitted', label: 'Uncommitted' },
            { value: 'all', label: 'All' },
          ],
        },
        {
          path: 'base.kind',
          title: 'Base selection',
          description: 'How to define the review base for engines that need it.',
          widget: 'select',
          required: true,
          options: [
            { value: 'none', label: 'None' },
            { value: 'branch', label: 'Base branch' },
            { value: 'commit', label: 'Base commit' },
          ],
        },
        {
          path: 'base.baseBranch',
          title: 'Base branch',
          description: 'Branch name to diff against (when base.kind=branch).',
          widget: 'text',
          visibleWhen: { op: 'eq', path: 'base.kind', value: 'branch' },
          requiredWhen: { op: 'eq', path: 'base.kind', value: 'branch' },
        },
        {
          path: 'base.baseCommit',
          title: 'Base commit',
          description: 'Commit SHA to diff against (when base.kind=commit).',
          widget: 'text',
          visibleWhen: { op: 'eq', path: 'base.kind', value: 'commit' },
          requiredWhen: { op: 'eq', path: 'base.kind', value: 'commit' },
        },
      ],
    },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","engineIds":["codex"],"instructions":"Review this.","changeType":"uncommitted","base":{"kind":"none"}}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    outputSchema: StrictJsonValueSchema,
    inputSchema: ReviewStartInputSchema,
  },
  {
    id: 'subagents.plan.start',
    title: 'Start plan run',
    sideEffectClass: 'external',
    safety: 'safe',
    placements: ['agent_input_chips', 'session_action_menu', 'command_palette', 'slash_command', 'voice_panel'],
    prompting: { voiceHotPath: true },
    slash: { tokens: ['/h.plan'] },
    bindings: { voiceClientToolName: 'startPlan', mcpToolName: 'subagents_plan_start' },
    inputHints: {
      title: 'Start a planning run',
      description: 'Start one or more Happier-managed planning runs using selected provider/backend targets; targets are provider choices, not parallelism capacity.',
      fields: [
        {
          path: 'backendTargetKeys',
          title: 'Provider/backend targets',
          description: 'Select provider/backend targets for Happier-managed runs; use repeated launches or provider-native subagents for homogeneous parallelism capacity.',
          widget: 'multiselect',
          required: true,
          optionsSourceId: 'execution.backends.enabled',
          maxSelections: 1,
        },
        {
          path: 'instructions',
          title: 'Instructions',
          description: 'What you want the planner(s) to do.',
          widget: 'textarea',
          required: true,
        },
        {
          path: 'modelId',
          title: 'Model id',
          description: 'Optional model applied to every started run (same vocabulary as session spawn). Omit for the backend default.',
          widget: 'text',
          optionsSourceId: 'agents.models.available',
        },
        {
          path: 'configOptions',
          title: 'Config options (e.g. reasoning effort)',
          description: 'Optional agent config-option overrides applied to every started run, e.g. {"reasoning_effort":"high"}. Merged canonically; a conflict with sessionConfigOptionOverrides fails.',
          widget: 'json',
          optionsSourceId: 'agents.config_options.available',
        },
        {
          path: 'connectedServicesByBackendTargetKey',
          title: 'Connected services per target (json)',
          description: 'Optional connected-services selection per backend target key. Accepts a simple string ("<service>:group:<id>", "<service>:<profileId>", "<service>:native"), an array, or the full object; omitted targets use session-spawn defaulting (literal). Enumerate valid selections via the shared session-spawn options source.',
          widget: 'textarea',
          optionsSourceId: 'sessions.spawn.connected_services.available',
        },
      ],
    },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","backendTargetKeys":["agent:codex"],"instructions":"Plan the changes."}' },
    },
	    surfaces: {
	      ui: true,
	      voice: true,
	      agent: true,
	      mcp: true,
	      cli: true,
	      rpc: false,
	      },
	    outputSchema: StrictJsonValueSchema,
	    inputSchema: PlanStartInputSchema,
	  },
  {
    id: 'subagents.delegate.start',
    title: 'Start delegate run',
    sideEffectClass: 'external',
    safety: 'safe',
    placements: ['agent_input_chips', 'session_action_menu', 'command_palette', 'slash_command', 'voice_panel'],
    prompting: { voiceHotPath: true },
    slash: { tokens: ['/h.delegate'] },
    bindings: { voiceClientToolName: 'startDelegate', mcpToolName: 'subagents_delegate_start' },
    inputHints: {
      title: 'Start a delegation run',
      description: 'Start one or more Happier-managed delegation runs using selected provider/backend targets; targets are provider choices, not parallelism capacity.',
      fields: [
        {
          path: 'backendTargetKeys',
          title: 'Provider/backend targets',
          description: 'Select provider/backend targets for Happier-managed runs; use repeated launches or provider-native subagents for homogeneous parallelism capacity.',
          widget: 'multiselect',
          required: true,
          optionsSourceId: 'execution.backends.enabled',
          maxSelections: 1,
        },
        {
          path: 'instructions',
          title: 'Instructions',
          description: 'What you want the delegate(s) to do.',
          widget: 'textarea',
          required: true,
        },
        {
          path: 'permissionMode',
          title: 'Permission mode',
          description: EXECUTION_RUN_ACTION_PERMISSION_MODE_DESCRIPTION,
          widget: 'select',
          options: EXECUTION_RUN_ACTION_PERMISSION_MODES.map((value) => ({ value, label: value })),
        },
        {
          path: 'modelId',
          title: 'Model id',
          description: 'Optional model applied to every started run (same vocabulary as session spawn). Omit for the backend default.',
          widget: 'text',
          optionsSourceId: 'agents.models.available',
        },
        {
          path: 'configOptions',
          title: 'Config options (e.g. reasoning effort)',
          description: 'Optional agent config-option overrides applied to every started run, e.g. {"reasoning_effort":"high"}. Merged canonically; a conflict with sessionConfigOptionOverrides fails.',
          widget: 'json',
          optionsSourceId: 'agents.config_options.available',
        },
        {
          path: 'connectedServicesByBackendTargetKey',
          title: 'Connected services per target (json)',
          description: 'Optional connected-services selection per backend target key. Accepts a simple string ("<service>:group:<id>", "<service>:<profileId>", "<service>:native"), an array, or the full object; omitted targets use session-spawn defaulting (literal). Enumerate valid selections via the shared session-spawn options source.',
          widget: 'textarea',
          optionsSourceId: 'sessions.spawn.connected_services.available',
        },
      ],
    },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","backendTargetKeys":["agent:codex"],"instructions":"Delegate the task."}' },
    },
	    surfaces: {
	      ui: true,
	      voice: true,
	      agent: true,
	      mcp: true,
	      cli: true,
	      rpc: false,
	      },
	    outputSchema: StrictJsonValueSchema,
	    inputSchema: DelegateStartInputSchema,
	  },
  {
    id: 'voice_agent.start',
    title: 'Start voice agent run',
    sideEffectClass: 'external',
    safety: 'safe',
    placements: ['voice_panel'],
    slash: { tokens: ['/h.voice'] },
    bindings: { voiceClientToolName: 'startVoiceAgentRun', mcpToolName: 'voice_agent_start' },
    inputHints: {
      title: 'Start a voice agent run',
      description: 'Start a voice agent execution run (typically used by the voice control plane).',
      fields: [
        {
          path: 'backendTargetKeys',
          title: 'Provider/backend targets',
          description: 'Select provider/backend targets for the Happier-managed voice agent run; this is not parallelism capacity.',
          widget: 'multiselect',
          required: true,
          optionsSourceId: 'execution.backends.enabled',
          maxSelections: 1,
        },
        {
          path: 'instructions',
          title: 'Instructions',
          description: 'Initial instructions for the voice agent run.',
          widget: 'textarea',
          required: true,
        },
      ],
    },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","backendTargetKeys":["agent:codex"],"instructions":"Start the voice assistant for this workspace."}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    outputSchema: StrictJsonValueSchema,
    inputSchema: VoiceAgentStartInputSchema,
  },
  {
    id: 'sessions.subagents.list',
    title: 'List session subagents',
    description: 'Return bounded provider-neutral subagent projections for a session.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.SESSIONS_SUBAGENTS_LIST },
    sideEffectClass: 'read',
    surfaces: {
      ui: false,
      voice: false,
      agent: true,
      mcp: false,
      cli: false,
      rpc: true,
    },
    outputSchema: z.array(SubagentRefV1Schema),
    inputSchema: SubagentListInputSchema,
    inputHints: {
      title: 'List session subagents',
      description: 'Reads a bounded provider-neutral subagent projection snapshot.',
      fields: [
        { path: 'parentSessionId', title: 'Parent session id', widget: 'text' },
        { path: 'groupId', title: 'Group id', widget: 'text' },
        { path: 'limit', title: 'Limit', widget: 'text' },
      ],
    },
  },
  {
    id: 'sessions.subagents.get',
    title: 'Get session subagent',
    description: 'Return one provider-neutral subagent projection by id.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.SESSIONS_SUBAGENTS_GET },
    sideEffectClass: 'read',
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    outputSchema: SubagentRefV1Schema.nullable(),
    inputSchema: SubagentGetInputSchema,
    inputHints: {
      title: 'Get session subagent',
      fields: [
        { path: 'id', title: 'Subagent id', widget: 'text', required: true },
        { path: 'parentSessionId', title: 'Parent session id', widget: 'text' },
      ],
    },
  },
  {
    id: 'sessions.subagents.watch',
    title: 'Watch session subagents',
    description: 'Register the bounded host subagent watcher path and return its initial typed projection snapshot.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.SESSIONS_SUBAGENTS_WATCH },
    sideEffectClass: 'read',
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    outputSchema: SubagentWatchSnapshotOutputSchema,
    inputSchema: SubagentWatchInputSchema,
    inputHints: {
      title: 'Watch session subagents',
      description: 'Uses the bounded host subagent watcher path and returns the initial snapshot for the RPC caller.',
      fields: [
        { path: 'parentSessionId', title: 'Parent session id', widget: 'text' },
        { path: 'id', title: 'Subagent id', widget: 'text' },
      ],
    },
  },
  {
    id: 'sessions.subagents.upsert',
    title: 'Upsert session subagent',
    description: 'Create or replace a provider-neutral subagent projection with owner-authority enforcement.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.SESSIONS_SUBAGENTS_UPSERT },
    sideEffectClass: 'write',
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    outputSchema: SubagentRefV1Schema,
    inputSchema: SubagentRefInputV1Schema,
    inputHints: {
      title: 'Upsert session subagent',
      fields: [
        { path: 'id', title: 'Subagent id', widget: 'text', required: true },
        { path: 'parentSessionId', title: 'Parent session id', widget: 'text', required: true },
        { path: 'origin', title: 'Origin', widget: 'text', required: true },
        { path: 'kind', title: 'Kind', widget: 'text', required: true },
        { path: 'status', title: 'Status', widget: 'text' },
      ],
    },
  },
  {
    id: 'sessions.subagents.updateStatus',
    title: 'Update session subagent status',
    description: 'Update subagent lifecycle status with owner-authority enforcement.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.SESSIONS_SUBAGENTS_UPDATE_STATUS },
    sideEffectClass: 'write',
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    outputSchema: SubagentRefV1Schema,
    inputSchema: SubagentStatusUpdateInputSchema,
    inputHints: {
      title: 'Update session subagent status',
      fields: [
        { path: 'id', title: 'Subagent id', widget: 'text', required: true },
        { path: 'parentSessionId', title: 'Parent session id', widget: 'text', required: true },
        { path: 'status', title: 'Status', widget: 'text', required: true },
        { path: 'completedAt', title: 'Completed at', widget: 'text' },
      ],
    },
  },
  {
    id: 'sessions.subagents.complete',
    title: 'Complete session subagent',
    description: 'Mark a subagent terminal with owner-authority enforcement.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.SESSIONS_SUBAGENTS_COMPLETE },
    sideEffectClass: 'write',
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    outputSchema: SubagentRefV1Schema,
    inputSchema: SubagentCompleteInputSchema,
    inputHints: {
      title: 'Complete session subagent',
      fields: [
        { path: 'id', title: 'Subagent id', widget: 'text', required: true },
        { path: 'parentSessionId', title: 'Parent session id', widget: 'text', required: true },
        { path: 'status', title: 'Terminal status', widget: 'text' },
        { path: 'completedAt', title: 'Completed at', widget: 'text' },
      ],
    },
  },
  {
    id: 'execution.run.start',
    title: 'Start execution run',
    description: `Start a new execution run. Set waitForCompletion=true to wait for a terminal run result. waitTimeoutSeconds only bounds this observation; it never stops, retries, or starts the run. ${EXECUTION_RUN_SESSION_SCOPE_DESCRIPTION}`,
    safety: 'safe',
    placements: [],
    bindings: {
      rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_START,
      voiceClientToolName: 'startExecutionRun',
      mcpToolName: 'execution_run_start',
    },
    sideEffectClass: 'write',
    examples: {
      mcp: {
        argsExample: '{"sessionId":"{{sessionId}}","intent":"voice_agent","backendTarget":{"kind":"backend","backendId":"codex","sourceKind":"built_in"},"instructions":"Summarize recent changes.","permissionMode":"read_only","retentionPolicy":"ephemeral","runClass":"bounded","ioMode":"request_response","waitForCompletion":true,"waitTimeoutSeconds":60}',
      },
      voice: {
        argsExample: '{"intent":"voice_agent","backendTarget":{"kind":"backend","backendId":"codex","sourceKind":"built_in"},"instructions":"Summarize recent changes.","permissionMode":"read_only","retentionPolicy":"ephemeral","runClass":"bounded","ioMode":"request_response"}',
      },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
      },
    surfaceBindings: {
      plugin: {
        inputSchema: ExecutionRunStartPluginInputSchema,
      },
    },
    inputHints: {
      title: 'Start a run',
      fields: [
        EXECUTION_RUN_SESSION_SCOPE_HINT,
        { path: 'intent', title: 'Intent', widget: 'text', required: true },
        { path: 'backendTarget', title: 'Backend target (json)', widget: 'textarea', required: true },
        { path: 'instructions', title: 'Instructions', widget: 'textarea' },
        { path: 'permissionMode', title: 'Permission mode', widget: 'text', required: true },
        { path: 'retentionPolicy', title: 'Retention policy', widget: 'text', required: true },
        { path: 'runClass', title: 'Run class', widget: 'text', required: true },
        { path: 'ioMode', title: 'IO mode', widget: 'text', required: true },
        {
          path: 'waitForCompletion',
          title: 'Wait for completion',
          description: 'Return the terminal run disposition under wait instead of returning immediately after start.',
          widget: 'boolean',
        },
        {
          path: 'waitTimeoutSeconds',
          title: 'Wait timeout seconds',
          description: 'Optional observation deadline; requires waitForCompletion=true and never stops the run.',
          widget: 'text',
        },
        { path: 'initialContextMode', title: 'Initial context mode', widget: 'text' },
        {
          path: 'modelId',
          title: 'Model id',
          description: 'Optional model for the run backend (same vocabulary as session spawn). Omit for the backend default.',
          widget: 'text',
          optionsSourceId: 'agents.models.available',
        },
        {
          path: 'configOptions',
          title: 'Config options (e.g. reasoning effort)',
          description: 'Optional agent config-option overrides, e.g. {"reasoning_effort":"high"}. Merged into sessionConfigOptionOverrides at the boundary; a conflict fails with invalid_parameters.',
          widget: 'json',
          optionsSourceId: 'agents.config_options.available',
        },
        {
          path: 'connectedServices',
          title: 'Connected services (json)',
          description: 'Optional connected-services selection for the run backend. Accepts a simple string ("<service>:group:<id>", "<service>:<profileId>", "<service>:native"), an array, or the full object; omitted = session-spawn defaulting (literal). Enumerate valid selections via the shared session-spawn options source.',
          widget: 'textarea',
          optionsSourceId: 'sessions.spawn.connected_services.available',
        },
      ],
    },
    outputSchema: ExecutionRunStartResponseSchema,
    inputSchema: ExecutionRunStartInputSchema,
  },
  {
    id: 'execution.run.list',
    title: 'List execution runs',
    description: `List execution runs in the selected scope. ${EXECUTION_RUN_SESSION_SCOPE_DESCRIPTION}`,
    safety: 'safe',
    placements: ['run_list', 'command_palette', 'slash_command', 'voice_panel'],
    prompting: { voiceHotPath: true },
    slash: { tokens: ['/h.runs'] },
    bindings: { rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_LIST, voiceClientToolName: 'listExecutionRuns', mcpToolName: 'execution_run_list' },
    sideEffectClass: 'read',
    inputHints: {
      title: 'List execution runs',
      fields: [
        EXECUTION_RUN_SESSION_SCOPE_HINT,
        { path: 'backendTarget', title: 'Backend target', widget: 'text' },
        {
          path: 'status',
          title: 'Status',
          widget: 'select',
          options: [
            { value: 'running', label: 'Running' },
            { value: 'succeeded', label: 'Succeeded' },
            { value: 'failed', label: 'Failed' },
            { value: 'cancelled', label: 'Cancelled' },
            { value: 'timeout', label: 'Timeout' },
          ],
        },
        { path: 'limit', title: 'Max runs', widget: 'text' },
      ],
    },
    examples: {
      voice: { argsExample: '{"status":"running","limit":10}' },
    },
	    surfaces: {
	      ui: true,
	      voice: true,
	      agent: true,
	      mcp: true,
	      cli: true,
	      rpc: true,
	      },
	    outputSchema: ExecutionRunListResponseSchema,
    inputSchema: ExecutionRunListRequestSchema.extend({
      sessionId: ExecutionRunScopeSessionIdSchema,
    }),
	  },
  {
    id: 'execution.run.get',
    title: 'Get execution run',
    description: `Get one execution run from the selected scope. ${EXECUTION_RUN_SESSION_SCOPE_DESCRIPTION}`,
    safety: 'safe',
    placements: ['run_list', 'run_card', 'command_palette'],
    prompting: { voiceHotPath: true },
    bindings: { rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_GET, voiceClientToolName: 'getExecutionRun', mcpToolName: 'execution_run_get' },
    sideEffectClass: 'read',
    examples: {
      voice: { argsExample: '{"sessionId":null,"runId":"run_123","includeStructured":false}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
      },
    inputHints: {
      title: 'Get a run',
      fields: [
        EXECUTION_RUN_SESSION_SCOPE_HINT,
        { path: 'runId', title: 'Run id', widget: 'text', required: true },
        { path: 'includeStructured', title: 'Include structured output', widget: 'boolean' },
      ],
    },
    outputSchema: ExecutionRunGetResponseSchema,
    inputSchema: ExecutionRunGetInputSchema,
  },
  {
    id: 'execution.run.send',
    title: 'Send to execution run',
    description: `Send a message to one execution run in the selected scope. ${EXECUTION_RUN_SESSION_SCOPE_DESCRIPTION}`,
    safety: 'safe',
    placements: ['run_card'],
    bindings: { rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_SEND, voiceClientToolName: 'sendExecutionRunMessage', mcpToolName: 'execution_run_send' },
    sideEffectClass: 'write',
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","runId":"run_123","message":"Continue and summarize what changed.","resume":false}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
      },
    inputHints: {
      title: 'Send to run',
      fields: [
        EXECUTION_RUN_SESSION_SCOPE_HINT,
        { path: 'runId', title: 'Run id', widget: 'text', required: true },
        { path: 'message', title: 'Message', widget: 'textarea', required: true },
        { path: 'resume', title: 'Resume if needed', widget: 'boolean' },
      ],
    },
    outputSchema: ExecutionRunSendResponseSchema,
    inputSchema: ExecutionRunSendInputSchema,
  },
  {
    id: 'execution.run.ensure',
    title: 'Ensure execution run',
    description: `Ensure an existing execution run is active or resumable. ${EXECUTION_RUN_SESSION_SCOPE_DESCRIPTION}`,
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE },
    sideEffectClass: 'write',
    surfaces: {
      ui: false,
      voice: false,
      agent: true,
      mcp: false,
      cli: false,
      rpc: true,
    },
    inputHints: {
      title: 'Ensure a run',
      fields: [
        EXECUTION_RUN_SESSION_SCOPE_HINT,
        { path: 'runId', title: 'Run id', widget: 'text', required: true },
        { path: 'resume', title: 'Resume if needed', widget: 'boolean' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: ExecutionRunEnsureInputSchema,
  },
  {
    id: 'execution.run.ensure_or_start',
    title: 'Ensure or start execution run',
    description: `Ensure an existing execution run, or start a new one when no run id is supplied. ${EXECUTION_RUN_SESSION_SCOPE_DESCRIPTION}`,
    safety: 'safe',
    placements: [],
    bindings: {
      rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START,
      rpcMethodAliases: [SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1],
    },
    sideEffectClass: 'write',
    surfaces: {
      ui: false,
      voice: false,
      agent: true,
      mcp: false,
      cli: false,
      rpc: true,
    },
    inputHints: {
      title: 'Ensure or start a run',
      fields: [
        EXECUTION_RUN_SESSION_SCOPE_HINT,
        { path: 'runId', title: 'Run id', widget: 'text' },
        { path: 'start', title: 'Start request (json)', widget: 'textarea' },
        { path: 'resume', title: 'Resume if needed', widget: 'boolean' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: ExecutionRunEnsureOrStartInputSchema,
  },
  {
    id: 'execution.run.stream.start',
    title: 'Start execution run stream',
    description: `Start a bounded streaming turn for an execution run. ${EXECUTION_RUN_SESSION_SCOPE_DESCRIPTION}`,
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START },
    sideEffectClass: 'write',
    surfaces: {
      ui: false,
      voice: false,
      agent: true,
      mcp: false,
      cli: false,
      rpc: true,
    },
    inputHints: {
      title: 'Start a run stream',
      fields: [
        EXECUTION_RUN_SESSION_SCOPE_HINT,
        { path: 'runId', title: 'Run id', widget: 'text', required: true },
        { path: 'message', title: 'Message', widget: 'textarea', required: true },
        { path: 'displayMessage', title: 'Display message', widget: 'textarea' },
        { path: 'resume', title: 'Resume if needed', widget: 'boolean' },
      ],
    },
    outputSchema: ExecutionRunTurnStreamStartResponseSchema,
    inputSchema: ExecutionRunStreamStartInputSchema,
  },
  {
    id: 'execution.run.stream.read',
    title: 'Read execution run stream',
    description: `Read bounded deltas from an execution-run stream cursor. ${EXECUTION_RUN_SESSION_SCOPE_DESCRIPTION}`,
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ },
    sideEffectClass: 'read',
    surfaces: {
      ui: false,
      voice: false,
      agent: true,
      mcp: false,
      cli: false,
      rpc: true,
    },
    inputHints: {
      title: 'Read a run stream',
      fields: [
        EXECUTION_RUN_SESSION_SCOPE_HINT,
        { path: 'runId', title: 'Run id', widget: 'text', required: true },
        { path: 'streamId', title: 'Stream id', widget: 'text', required: true },
        { path: 'cursor', title: 'Cursor', widget: 'text' },
        { path: 'maxEvents', title: 'Max events', widget: 'text' },
      ],
    },
    outputSchema: ExecutionRunTurnStreamReadResponseSchema,
    inputSchema: ExecutionRunStreamReadInputSchema,
  },
  {
    id: 'execution.run.stream.cancel',
    title: 'Cancel execution run stream',
    description: `Cancel a bounded streaming turn for an execution run. ${EXECUTION_RUN_SESSION_SCOPE_DESCRIPTION}`,
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL },
    sideEffectClass: 'write',
    surfaces: {
      ui: false,
      voice: false,
      agent: true,
      mcp: false,
      cli: false,
      rpc: true,
    },
    inputHints: {
      title: 'Cancel a run stream',
      fields: [
        EXECUTION_RUN_SESSION_SCOPE_HINT,
        { path: 'runId', title: 'Run id', widget: 'text', required: true },
        { path: 'streamId', title: 'Stream id', widget: 'text', required: true },
      ],
    },
    outputSchema: ExecutionRunTurnStreamCancelResponseSchema,
    inputSchema: ExecutionRunStreamCancelInputSchema,
  },
  {
    id: 'execution.run.stop',
    title: 'Stop execution run',
    description: `Stop one execution run in the selected scope. ${EXECUTION_RUN_SESSION_SCOPE_DESCRIPTION}`,
    safety: 'safe',
    placements: ['run_card', 'run_list'],
    bindings: { rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_STOP, voiceClientToolName: 'stopExecutionRun', mcpToolName: 'execution_run_stop' },
    sideEffectClass: 'write',
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","runId":"run_123"}' },
    },
	    surfaces: {
	      ui: true,
	      voice: true,
	      agent: true,
	      mcp: true,
	      cli: true,
	      rpc: true,
	      },
	    inputHints: {
	      title: 'Stop a run',
	      fields: [
          EXECUTION_RUN_SESSION_SCOPE_HINT,
          { path: 'runId', title: 'Run id', widget: 'text', required: true },
        ],
	    },
	    outputSchema: ExecutionRunStopResponseSchema,
	    inputSchema: ExecutionRunIdInputSchema,
	  },
  {
    id: 'execution.run.action',
    title: 'Apply execution run action',
    description: `Apply an action to one execution run in the selected scope. ${EXECUTION_RUN_SESSION_SCOPE_DESCRIPTION}`,
    safety: 'safe',
    placements: ['run_card'],
    bindings: { rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_ACTION, voiceClientToolName: 'actionExecutionRun', mcpToolName: 'execution_run_action' },
    sideEffectClass: 'write',
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","runId":"run_123","actionId":"voice_agent.commit","input":{"maxChars":1200}}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
      },
    inputHints: {
      title: 'Run action',
      fields: [
        EXECUTION_RUN_SESSION_SCOPE_HINT,
        { path: 'runId', title: 'Run id', widget: 'text', required: true },
        { path: 'actionId', title: 'Action id', widget: 'text', required: true },
        { path: 'input', title: 'Input (JSON)', widget: 'textarea' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: ExecutionRunActionInputSchema,
  },
  {
    id: 'execution.run.wait',
    title: 'Wait for execution run',
    description: `Wait until an execution run reaches a terminal status. Pass timeoutSeconds to bound the wait; omit it for no Happier-side deadline. ${EXECUTION_RUN_WAIT_OBSERVATION_DESCRIPTION} ${EXECUTION_RUN_SESSION_SCOPE_DESCRIPTION}`,
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'execution_run_wait' },
    examples: {
      mcp: { argsExample: '{"sessionId":null,"runId":"run_123"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'Wait for a run',
      fields: [
        EXECUTION_RUN_SESSION_SCOPE_HINT,
        { path: 'runId', title: 'Run id', widget: 'text', required: true },
        { path: 'timeoutSeconds', title: 'Timeout seconds (optional)', widget: 'text' },
        { path: 'pollIntervalMs', title: 'Poll interval (ms)', widget: 'text' },
      ],
    },
    outputSchema: ExecutionRunWaitResultSchema,
    inputSchema: ExecutionRunWaitInputSchema,
  },
  {
    id: 'session.open',
    title: 'Open session',
    sideEffectClass: 'external',
    safety: 'safe',
    placements: ['command_palette', 'session_info', 'voice_panel'],
    bindings: { voiceClientToolName: 'openSession' },
    examples: {
      voice: { argsExample: '{"sessionTitle":"Session Setup"}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: false,
      mcp: false,
      cli: false,
      rpc: false,
      },
    inputHints: {
      title: 'Open a session',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'sessionTitle', title: 'Session title', widget: 'text' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionOpenInputSchema,
  },
  {
    id: 'session.fork',
    operation: {
      version: 1,
      visibility: 'activity',
      progress: 'indeterminate',
      presentation: { onStart: 'current' },
    },
    title: 'Fork session',
    sideEffectClass: 'write',
    description: 'Create a new session from the latest state of the selected session.',
    safety: 'safe',
    placements: ['session_action_menu', 'session_info', 'command_palette', 'slash_command', 'voice_panel', 'agent_input_chips'],
    slash: { tokens: ['fork'] },
    bindings: {
      voiceClientToolName: 'forkSession',
      rpcMethod: 'session.fork',
      rpcMethodAliases: [RPC_METHODS.SESSION_FORK_PROVIDER_SAFE],
    },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      },
    inputHints: {
      title: 'Fork a session',
      description: 'Forks from the latest message in the session.',
      fields: [{ path: 'sessionId', title: 'Session id', widget: 'text' }],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionForkInputSchema,
  },
  {
    id: 'session.continue_with_replay',
    title: 'Continue session with replay',
    description: 'Create a continuation session from a replay seed while preserving the existing RPC wire contract.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'session.continueWithReplay' },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      },
    inputHints: {
      title: 'Continue with replay',
      fields: [
        { path: 'directory', title: 'Directory', widget: 'text', required: true },
        { path: 'backendTarget', title: 'Backend target', widget: 'text', required: true },
        { path: 'replay', title: 'Replay seed', widget: 'textarea', required: true },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionContinueWithReplayRpcParamsSchema,
  },
  {
    id: 'session.rollback',
    title: 'Rollback conversation',
    description: 'Roll back conversation state in the selected session.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: 'session.rollback' },
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      },
    inputHints: {
      title: 'Rollback a session conversation',
      description: 'Rewinds conversation state for the selected session.',
      fields: [{ path: 'sessionId', title: 'Session id', widget: 'text' }],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionRollbackInputSchema,
  },
  {
    id: 'session.checkpoint_code_rollback',
    title: 'Rollback code to checkpoint',
    description: 'Apply a checkpoint-backed code rollback for the selected session turn.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: SESSION_RPC_METHODS.SESSION_CHECKPOINT_CODE_ROLLBACK },
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    inputHints: {
      title: 'Rollback session code to a checkpoint',
      description: 'Creates a mandatory backup checkpoint before applying a same-worktree reverse patch.',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'turnId', title: 'Turn id', widget: 'text', required: true },
        { path: 'cwd', title: 'Working directory', widget: 'text', required: true },
      ],
    },
    outputSchema: CheckpointCodeRollbackResultSchema,
    inputSchema: CheckpointCodeRollbackActionRequestSchema,
  },
  {
    id: 'session.checkpoint',
    title: 'Create checkpoint',
    description: 'Create a source-qualified checkpoint for the selected session.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: SESSION_RPC_METHODS.SESSION_CHECKPOINT },
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    inputHints: {
      title: 'Create a session checkpoint',
      description: 'Creates a checkpoint through a selected provider or Happier SCM source.',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'scopes', title: 'Scopes', widget: 'multiselect', options: CHECKPOINT_SCOPE_INPUT_OPTIONS, required: true },
      ],
    },
    outputSchema: SessionCheckpointResultV1Schema,
    inputSchema: SessionCheckpointRequestV1Schema,
  },
  {
    id: 'session.restore',
    title: 'Restore checkpoint',
    description: 'Restore a selected session checkpoint source.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: SESSION_RPC_METHODS.SESSION_RESTORE },
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    inputHints: {
      title: 'Restore a session checkpoint',
      description: 'Restores from an explicit provider or Happier SCM checkpoint source.',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'scopes', title: 'Scopes', widget: 'multiselect', options: CHECKPOINT_SCOPE_INPUT_OPTIONS, required: true },
        { path: 'candidate.source', title: 'Source', widget: 'select', options: CHECKPOINT_SOURCE_INPUT_OPTIONS, required: true },
      ],
    },
    outputSchema: SessionRestoreResultV1Schema,
    inputSchema: SessionRestoreRequestV1Schema,
  },
  {
    id: 'session.handoff',
    operation: {
      version: 1,
      visibility: 'activity',
      progress: 'reported',
      presentation: { onStart: 'current' },
    },
    title: 'Hand off session',
    description: 'Move the current session to another machine while keeping the same session id.',
    safety: 'safe',
    placements: ['session_action_menu', 'session_info'],
    bindings: { rpcMethod: 'daemon.sessionHandoff.start', sdkMethod: 'session.handoff.start' },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","targetMachineId":"{{machineId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      },
    inputHints: {
      title: 'Hand off a session',
      description: 'Moves the current session to another machine.',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'targetMachineId', title: 'Target machine id', widget: 'text' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionHandoffInputSchema,
  },
  {
    id: 'session.handoff.prepare_target',
    title: 'Prepare session handoff target',
    description: 'Prepare a target machine to receive an in-progress session handoff.',
    safety: 'safe',
    placements: [],
    bindings: {
      rpcMethod: 'daemon.sessionHandoff.prepareTarget',
      sdkMethod: 'session.handoff.prepareTarget.start',
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      },
    inputHints: {
      title: 'Prepare handoff target',
      fields: [
        { path: 'handoffId', title: 'Handoff id', widget: 'text', required: true },
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'sourceMachineId', title: 'Source machine id', widget: 'text', required: true },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionHandoffPrepareTargetRequestSchema,
  },
  {
    id: 'session.handoff.prepare_target_result.get',
    title: 'Get session handoff target preparation result',
    description: 'Read the prepared-target result for an in-progress session handoff.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'daemon.sessionHandoff.prepareTargetResult.get' },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      },
    inputHints: {
      title: 'Get handoff prepare-target result',
      fields: [{ path: 'handoffId', title: 'Handoff id', widget: 'text', required: true }],
    },
    outputSchema: SessionHandoffPrepareTargetResultGetResponseSchema,
    inputSchema: SessionHandoffPrepareTargetResultGetRequestSchema,
  },
  {
    id: 'session.handoff.prepare_target.resume',
    title: 'Resume interrupted session handoff target preparation',
    description: 'Explicitly continue one interrupted prepare-target job at its current durable revision.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'daemon.sessionHandoff.prepareTarget.resume' },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    inputHints: {
      title: 'Resume interrupted handoff preparation',
      fields: [
        { path: 'handoffId', title: 'Handoff id', widget: 'text', required: true },
        { path: 'jobId', title: 'Job id', widget: 'text', required: true },
        { path: 'expectedRevision', title: 'Expected revision', widget: 'text', required: true },
        { path: 'attemptId', title: 'Attempt id', widget: 'text', required: true },
      ],
    },
    outputSchema: SessionHandoffPrepareTargetResumeResponseSchema,
    inputSchema: SessionHandoffPrepareTargetResumeRequestSchema,
  },
  {
    id: 'session.handoff.commit',
    title: 'Commit session handoff',
    description: 'Finalize a prepared session handoff.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'daemon.sessionHandoff.commit' },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      },
    inputHints: {
      title: 'Commit handoff',
      fields: [{ path: 'handoffId', title: 'Handoff id', widget: 'text', required: true }],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionHandoffCommitRequestSchema,
  },
  {
    id: 'session.handoff.abort',
    title: 'Abort session handoff',
    description: 'Cancel an in-progress session handoff.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'daemon.sessionHandoff.abort' },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      },
    inputHints: {
      title: 'Abort handoff',
      fields: [
        { path: 'handoffId', title: 'Handoff id', widget: 'text', required: true },
        { path: 'reason', title: 'Reason', widget: 'text' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionHandoffAbortRequestSchema,
  },
  {
    id: 'session.handoff.status.get',
    title: 'Get session handoff status',
    description: 'Read scalar status for an in-progress session handoff.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'daemon.sessionHandoff.status.get' },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      },
    inputHints: {
      title: 'Get handoff status',
      fields: [{ path: 'handoffId', title: 'Handoff id', widget: 'text', required: true }],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionHandoffStatusGetRequestSchema,
  },
  {
    id: 'session.spawn_new',
    operation: {
      version: 1,
      visibility: 'activity',
      progress: 'reported',
      presentation: { onStart: 'current' },
    },
    title: 'Create session',
    sideEffectClass: 'write',
    safety: 'safe',
    placements: ['command_palette', 'session_info', 'voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: {
      rpcMethod: RPC_METHODS.SESSION_SPAWN_NEW,
      voiceClientToolName: 'spawnSession',
      mcpToolName: 'session_spawn_new',
    },
    surfaceBindings: {
      api: {
        inputSchema: SessionSpawnNewApiInputSchema,
        bindInput: bindApiSessionSpawnNewInput,
        inputHints: SessionSpawnNewApiInputHints,
      },
      rpc: {
        inputSchema: SessionSpawnNewRpcInputSchema,
        decodeInput: identityActionSurfaceValue,
        outputSchema: SessionSpawnNewResultV1Schema,
        encodeOutput: identityActionSurfaceValue,
      },
    },
    examples: {
      voice: { argsExample: '{"executionTarget":{"serverId":"active","machineId":"machine-1"},"directory":"/workspace/project","agentTarget":{"kind":"agent","identity":{"pluginId":"happier.agent.claude","localId":"claude"}},"initialMessage":"Help me inspect this workspace."}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
    },
    inputHints: SessionSpawnNewInputHints,
    outputSchema: SessionSpawnNewResultV1Schema,
    inputSchema: SessionSpawnNewInputSchema,
  },
  {
    id: 'paths.list_recent',
    title: 'List recent paths',
    sideEffectClass: 'read',
    description: 'List recent workspace directory handles (optionally filtered to a machine).',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'listRecentPaths', mcpToolName: 'paths_list_recent' },
    examples: {
      voice: { argsExample: '{"limit":10}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'List recent paths',
      fields: [
        { path: 'machineId', title: 'Machine id', widget: 'text' },
        { path: 'limit', title: 'Limit', widget: 'text' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: PathsListRecentInputSchema,
  },
  {
    id: 'machines.list',
    title: 'List machines',
    sideEffectClass: 'read',
    description: 'List machines available on the active server scope.',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'listMachines' },
    examples: {
      voice: { argsExample: '{"limit":50}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: false,
      cli: false,
      rpc: false,
      },
    inputHints: {
      title: 'List machines',
      fields: [{ path: 'limit', title: 'Limit', widget: 'text' }],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: MachinesListInputSchema,
  },
  {
    id: 'servers.list',
    title: 'List servers',
    sideEffectClass: 'read',
    description: 'List servers configured in the client.',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'listServers' },
    examples: {
      voice: { argsExample: '{"limit":50}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: false,
      cli: false,
      rpc: false,
      },
    inputHints: {
      title: 'List servers',
      fields: [{ path: 'limit', title: 'Limit', widget: 'text' }],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: ServersListInputSchema,
  },
  {
    id: 'review.engines.list',
    title: 'List review engines',
    sideEffectClass: 'read',
    description: 'List review engines currently available for the active session.',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'listReviewEngines' },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","includeDisabled":false}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: false,
      mcp: false,
      cli: false,
      rpc: false,
      },
    inputHints: {
      title: 'List review engines',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'includeDisabled', title: 'Include disabled', widget: 'boolean' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: ReviewEnginesListInputSchema,
  },
  {
    id: 'agents.backends.list',
    title: 'List agent backends',
    sideEffectClass: 'read',
    description: 'List available agent backends (providers) for spawning sessions.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'listAgentBackends', mcpToolName: 'agents_backends_list' },
    examples: {
      voice: { argsExample: '{"includeDisabled":false,"limit":10,"machineId":"{{machineId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      title: 'List agent backends',
      fields: [
        { path: 'includeDisabled', title: 'Include disabled', widget: 'boolean' },
        { path: 'limit', title: 'Max results', widget: 'text' },
        { path: 'machineId', title: 'Machine id (optional)', widget: 'text' },
      ],
    },
    outputSchema: AgentsBackendsListOutputSchema,
    inputSchema: AgentsBackendsListInputSchema,
  },
  {
    id: 'agents.models.list',
    title: 'List agent models',
    sideEffectClass: 'read',
    description: 'List available models for an agent backend.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'listAgentModels', mcpToolName: 'agents_models_list' },
    examples: {
      voice: { argsExample: '{"agentId":"claude","backendTargetKey":"backend:plugin-review-bot","machineId":"{{machineId}}","limit":10}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      title: 'List agent models',
      fields: [
        { path: 'agentId', title: 'Runtime agent id', widget: 'text' },
        { path: 'backendTargetKey', title: 'Backend target key', widget: 'text' },
        { path: 'machineId', title: 'Machine id (optional)', widget: 'text' },
        { path: 'limit', title: 'Max results', widget: 'text' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: AgentsModelsListInputSchema,
  },
  {
    id: 'agents.config_options.list',
    title: 'List agent config options',
    sideEffectClass: 'read',
    description: 'List configurable option definitions for an agent backend without exposing current values.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'listAgentConfigOptions', mcpToolName: 'agents_config_options_list' },
    examples: {
      voice: { argsExample: '{"agentId":"claude","backendTargetKey":"backend:claude","machineId":"{{machineId}}","limit":10}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      title: 'List agent config options',
      fields: [
        { path: 'agentId', title: 'Runtime agent id', widget: 'text' },
        { path: 'backendTargetKey', title: 'Backend target key', widget: 'text' },
        { path: 'modelId', title: 'Model id', widget: 'text' },
        { path: 'machineId', title: 'Machine id (optional)', widget: 'text' },
        { path: 'limit', title: 'Max results', widget: 'text' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: AgentsConfigOptionsListInputSchema,
  },
  {
    id: 'agents.session_modes.list',
    title: 'List agent session modes',
    sideEffectClass: 'read',
    description: 'List session modes available for an agent backend.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'listAgentSessionModes', mcpToolName: 'agents_session_modes_list' },
    examples: {
      voice: { argsExample: '{"agentId":"codex","backendTargetKey":"backend:codex","machineId":"{{machineId}}","limit":10}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      title: 'List agent session modes',
      fields: [
        { path: 'agentId', title: 'Runtime agent id', widget: 'text' },
        { path: 'backendTargetKey', title: 'Backend target key', widget: 'text' },
        { path: 'machineId', title: 'Machine id (optional)', widget: 'text' },
        { path: 'limit', title: 'Max results', widget: 'text' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: AgentSpawnOptionsListInputSchema,
  },
  {
    id: 'sessions.spawn.profiles.list',
    title: 'List spawn profiles',
    sideEffectClass: 'read',
    description: 'List backend profile references available for new sessions without exposing secret bindings.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'listSpawnProfiles', mcpToolName: 'sessions_spawn_profiles_list' },
    examples: {
      voice: { argsExample: '{"agentId":"codex","backendTargetKey":"backend:codex","limit":10}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      title: 'List spawn profiles',
      fields: [
        { path: 'agentId', title: 'Runtime agent id', widget: 'text' },
        { path: 'backendTargetKey', title: 'Backend target key', widget: 'text' },
        { path: 'limit', title: 'Max results', widget: 'text' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: AgentSpawnOptionsListInputSchema,
  },
  {
    id: 'sessions.spawn.connected_services.list',
    title: 'List spawn connected services',
    sideEffectClass: 'read',
    description: 'List connected-service references available for new sessions without exposing credentials.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'listSpawnConnectedServices', mcpToolName: 'sessions_spawn_connected_services_list' },
    examples: {
      voice: { argsExample: '{"agentId":"codex","backendTargetKey":"backend:codex","includeUnavailable":false}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      title: 'List spawn connected services',
      fields: [
        { path: 'agentId', title: 'Runtime agent id', widget: 'text' },
        { path: 'backendTargetKey', title: 'Backend target key', widget: 'text' },
        { path: 'includeUnavailable', title: 'Include unavailable', widget: 'boolean' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SpawnConnectedServicesListInputSchema,
  },
  {
    id: 'sessions.spawn.mcp_servers.preview',
    title: 'Preview spawn MCP servers',
    sideEffectClass: 'read',
    description: 'Preview MCP servers that would be available to a new session.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'previewSpawnMcpServers', mcpToolName: 'sessions_spawn_mcp_servers_preview' },
    examples: {
      voice: { argsExample: '{"agentId":"codex","machineId":"{{machineId}}","directory":"{{path}}"}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      title: 'Preview spawn MCP servers',
      fields: [
        { path: 'agentId', title: 'Runtime agent id', widget: 'text' },
        { path: 'backendTargetKey', title: 'Backend target key', widget: 'text' },
        { path: 'machineId', title: 'Machine id', widget: 'text' },
        { path: 'directory', title: 'Directory', widget: 'text' },
        { path: 'path', title: 'Path', widget: 'text' },
        { path: 'selection', title: 'Selection', widget: 'json' },
        { path: 'limit', title: 'Max results', widget: 'text' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SpawnMcpServersPreviewInputSchema,
  },
  {
    id: 'session.message.send',
    title: 'Send a message to a session',
    sideEffectClass: 'external',
    description: 'Send a user message to the AI coding assistant inside the specified session.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'sendSessionMessage', mcpToolName: 'session_message_send' },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","message":"Please inspect the latest changes."}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      title: 'Send a message',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'message', title: 'Message', widget: 'textarea', required: true },
        { path: 'permissionModeOverride', title: 'Permission mode override (optional)', widget: 'text' },
        { path: 'modelOverride', title: 'Model override (optional)', widget: 'text' },
        { path: 'providerConnectionId', title: 'Provider connection id (optional)', widget: 'text' },
        { path: 'wait', title: 'Wait for idle (optional)', widget: 'boolean' },
        { path: 'timeoutSeconds', title: 'Timeout seconds (optional)', widget: 'text' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionSendMessageInputSchema,
    surfaceBindings: {
      plugin: {
        inputSchema: SessionSendMessagePluginInputV1Schema,
        outputSchema: SessionInputAdmissionResultV1Schema,
      },
    } satisfies ActionSpecSurfaceBindings,
  },
  {
    id: 'session.stop',
    title: 'Stop session',
    description: 'Request that the local daemon stops the specified session.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_stop', rpcMethod: 'stop-session' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
      },
    inputHints: {
      title: 'Stop a session',
      fields: [{ path: 'sessionId', title: 'Session id', widget: 'text', required: true }],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionIdRequiredInputSchema,
  },
  {
    id: 'session.terminalComposer.clear',
    title: 'Clear terminal composer',
    description: 'Clear the pending terminal composer draft for a session runtime.',
    safety: 'danger',
    sideEffectClass: 'danger',
    placements: ['pending_messages'],
    bindings: {
      mcpToolName: 'session_terminal_composer_clear',
      rpcMethod: SESSION_RPC_METHODS.SESSION_TERMINAL_COMPOSER_CLEAR,
    },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: true,
      cli: true,
      rpc: true,
    },
    inputHints: {
      title: 'Clear terminal composer',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'expectedStateAtMs', title: 'Expected state timestamp', widget: 'text' },
      ],
    },
    outputSchema: SessionTerminalComposerClearResultV1Schema,
    inputSchema: SessionTerminalComposerClearRequestV1Schema,
  },
  {
    id: 'session.pendingInput.interruptAndRun',
    title: 'Interrupt and run now',
    description: 'Interrupt the live provider turn so its exact native queued prompt can run now.',
    safety: 'danger',
    sideEffectClass: 'danger',
    placements: ['pending_messages'],
    bindings: {
      rpcMethod: SESSION_RPC_METHODS.SESSION_PENDING_INPUT_INTERRUPT_AND_RUN,
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: true,
      rpc: true,
    },
    inputHints: {
      title: 'Interrupt and run now',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'localId', title: 'Pending message local id', widget: 'text', required: true },
        { path: 'expectedStateAtMs', title: 'Expected state timestamp', widget: 'text' },
      ],
    },
    outputSchema: SessionPendingInputInterruptAndRunResultV1Schema,
    inputSchema: SessionPendingInputInterruptAndRunRequestV1Schema,
  },
  {
    id: 'session.title.set',
    title: 'Set session title',
    description: 'Set the title (summary text) shown for a session.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_title_set' },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","title":"Fix flaky tests"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      title: 'Set title',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'title', title: 'Title', widget: 'text', required: true },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionTitleSetInputSchema,
  },
  {
    id: 'session.permission_mode.set',
    title: 'Set session permission mode',
    description: 'Update the permission intent (read_only/workspace_write/etc) for the specified session.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_permission_mode_set', rpcMethod: 'session.permission_mode.set' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}","permissionMode":"read_only"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
      },
    inputHints: {
      title: 'Set permission mode',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'permissionMode', title: 'Permission mode', widget: 'text', required: true },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionPermissionModeSetInputSchema,
  },
  {
    id: 'session.model.set',
    title: 'Set session model',
    description: 'Set the model override for the specified session.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_model_set' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}","modelId":"default"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      title: 'Set session model',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'modelId', title: 'Model id', widget: 'text', required: true },
        { path: 'providerConnectionId', title: 'Provider connection id', widget: 'text' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionModelSetInputSchema,
  },
  {
    id: 'session.archive',
    title: 'Archive session',
    description: 'Archive the specified session.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_archive' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      title: 'Archive a session',
      fields: [{ path: 'sessionId', title: 'Session id', widget: 'text', required: true }],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionIdRequiredInputSchema,
  },
  {
    id: 'session.unarchive',
    title: 'Unarchive session',
    description: 'Unarchive the specified session.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_unarchive' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      title: 'Unarchive a session',
      fields: [{ path: 'sessionId', title: 'Session id', widget: 'text', required: true }],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionIdRequiredInputSchema,
  },
  {
    id: 'session.status.get',
    title: 'Get session status',
    description: 'Get summary status for a session, optionally refreshing live agent state.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_status_get' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}","live":true}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'Get session status',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'live', title: 'Live', widget: 'boolean' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionStatusGetInputSchema,
  },
  {
    id: 'session.work_state.get',
    title: 'Get session work state',
    description: 'Get the normalized current goal, task, and todo snapshot for a session.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_work_state_get' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'Get session work state',
      fields: [{ path: 'sessionId', title: 'Session id', widget: 'text', required: true }],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionIdRequiredInputSchema,
  },
  {
    id: 'session.goal.get',
    title: 'Get session goal',
    description: 'Get the editable session goal when the provider supports native goals.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_goal_get' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'Get session goal',
      fields: [{ path: 'sessionId', title: 'Session id', widget: 'text', required: true }],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionIdRequiredInputSchema,
  },
  {
    id: 'session.goal.set',
    title: 'Set session goal',
    description: 'Set or update the native session goal.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_goal_set' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}","objective":"Ship goal controls"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'Set session goal',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'objective', title: 'Objective', widget: 'textarea' },
        { path: 'status', title: 'Status', widget: 'text' },
        { path: 'tokenBudget', title: 'Token budget', widget: 'text' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionGoalSetInputSchema,
  },
  {
    id: 'session.goal.clear',
    title: 'Clear session goal',
    description: 'Clear the native session goal.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_goal_clear' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'Clear session goal',
      fields: [{ path: 'sessionId', title: 'Session id', widget: 'text', required: true }],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionIdRequiredInputSchema,
  },
  {
    id: 'session.usageLimit.waitResume.enable',
    title: 'Enable usage-limit wait resume',
    description: 'Arm a durable intent to continue a session when a provider usage limit is lifted.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_usage_limit_wait_resume_enable' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}","remember":true}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'Enable usage-limit wait resume',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'issueFingerprint', title: 'Issue fingerprint', widget: 'text' },
        { path: 'remember', title: 'Remember', widget: 'boolean' },
        {
          path: 'resumePromptMode',
          title: 'Resume prompt mode',
          widget: 'select',
          options: [
            { value: 'standard', label: 'Standard' },
            { value: 'off', label: 'Off' },
            { value: 'custom', label: 'Custom' },
          ],
        },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionUsageLimitWaitResumeEnableRequestV1Schema,
  },
  {
    id: 'session.usageLimit.waitResume.cancel',
    title: 'Cancel usage-limit wait resume',
    description: 'Cancel the active usage-limit wait/resume intent for a session.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_usage_limit_wait_resume_cancel' },
    examples: {
      mcp: {
        argsExample: '{"sessionId":"{{sessionId}}","issueFingerprint":"usage-limit:provider:turn:1:no-reset","armedAtMs":1000,"runtimeAuthRecoveryAttemptId":"runtime-auth-attempt-1"}',
      },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'Cancel usage-limit wait resume',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'issueFingerprint', title: 'Issue fingerprint', widget: 'text' },
        { path: 'armedAtMs', title: 'Armed at (ms)', widget: 'number' },
        { path: 'runtimeAuthRecoveryAttemptId', title: 'Runtime auth recovery attempt id', widget: 'text' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionUsageLimitWaitResumeCancelRequestV1Schema,
  },
  {
    id: 'session.usageLimit.checkNow',
    title: 'Check usage-limit recovery now',
    description: 'Ask the session runtime to perform a safe provider-owned usage-limit recovery check.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_usage_limit_check_now' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'Check usage-limit recovery now',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        {
          path: 'provider',
          title: 'Provider',
          description: 'Optional provider id for provider-scoped recovery controls.',
          widget: 'text',
        },
        {
          path: 'operation',
          title: 'Operation',
          widget: 'select',
          options: [
            { value: 'check_now', label: 'Check now' },
            { value: 'switch_account_now', label: 'Switch account now' },
          ],
        },
        {
          path: 'resumePromptMode',
          title: 'Resume prompt mode',
          widget: 'select',
          options: [
            { value: 'standard', label: 'Standard' },
            { value: 'off', label: 'Off' },
            { value: 'custom', label: 'Custom' },
          ],
        },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionUsageLimitCheckNowRequestV1Schema,
  },
  {
    id: 'session.usageLimit.consumeResetCredit',
    title: 'Apply usage-limit reset credit',
    description: 'Ask the session runtime to spend a connected-service reset credit for usage-limit recovery.',
    safety: 'danger',
    placements: [],
    bindings: { mcpToolName: 'session_usage_limit_consume_reset_credit' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'Apply reset credit',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        {
          path: 'provider',
          title: 'Provider',
          description: 'Optional provider id for provider-scoped recovery controls.',
          widget: 'text',
        },
        {
          path: 'resumePromptMode',
          title: 'Resume prompt mode',
          widget: 'select',
          options: [
            { value: 'standard', label: 'Standard' },
            { value: 'off', label: 'Off' },
            { value: 'custom', label: 'Custom' },
          ],
        },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionUsageLimitConsumeResetCreditRequestV1Schema,
  },
  {
    id: 'session.vendor_plugin_catalog.list',
    title: 'List session vendor plugins',
    description: 'List provider-owned vendor plugins available to the session.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_vendor_plugin_catalog_list' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'List vendor plugins',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'cwd', title: 'Working directory', widget: 'text' },
      ],
    },
    outputSchema: SessionVendorPluginCatalogListOutputSchema,
    inputSchema: SessionCatalogListInputSchema,
  },
  {
    id: 'session.skill_catalog.list',
    title: 'List session skills',
    description: 'List provider-visible skills available to the session.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_skill_catalog_list' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'List skills',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'cwd', title: 'Working directory', widget: 'text' },
      ],
    },
    outputSchema: SessionSkillCatalogListOutputSchema,
    inputSchema: SessionCatalogListInputSchema,
  },
  {
    id: 'session.history.get',
    title: 'Get session history',
    description: 'DEPRECATED: use session_events_get. Returns diagnostic session events with cleaner pagination.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_history_get' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}","limit":50,"format":"compact"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      title: 'Get session history',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'limit', title: 'Limit', widget: 'text' },
        {
          path: 'format',
          title: 'Format',
          widget: 'select',
          options: [
            { value: 'compact', label: 'Compact' },
            { value: 'raw', label: 'Raw' },
          ],
        },
        { path: 'includeMeta', title: 'Include meta', widget: 'boolean' },
        { path: 'includeStructuredPayload', title: 'Include structured payload', widget: 'boolean' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionHistoryGetInputSchema,
  },
  {
    id: 'session.transcript.get',
    title: 'Get session transcript',
    sideEffectClass: 'read',
    description: 'Read the semantic transcript for a session as clean user/assistant messages with optional tool/reasoning/event flags.',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'getSessionTranscript', mcpToolName: 'session_transcript_get' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}","limit":20,"cursor":null,"direction":"before","roles":["user","assistant"],"maxCharsPerMessage":null}' },
      voice: { argsExample: '{"sessionId":"{{sessionId}}","limit":20,"cursor":null,"direction":"before","roles":["user","assistant"],"maxCharsPerMessage":null}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'Get session transcript',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'limit', title: 'Limit', widget: 'text' },
        { path: 'cursor', title: 'Cursor', widget: 'text' },
        {
          path: 'direction',
          title: 'Direction',
          description: 'Page away from the cursor: before reads older items (the default), after reads newer ones.',
          widget: 'select',
          options: [
            { value: 'before', label: 'Before cursor (older)' },
            { value: 'after', label: 'After cursor (newer)' },
          ],
        },
        {
          path: 'maxCharsPerMessage',
          title: 'Message truncation chars',
          description: 'Optional per-message truncation budget. Omit or pass null for full message text.',
          widget: 'text',
        },
      ],
    },
    outputSchema: SessionTranscriptGetResultSchema,
    inputSchema: SessionTranscriptGetInputSchema,
    surfaceBindings: {
      plugin: {
        inputSchema: SessionTranscriptGetExternalShareableInputV1Schema,
        outputSchema: SessionTranscriptGetExternalShareableResultV1Schema,
      },
    } satisfies ActionSpecSurfaceBindings,
  },
  {
    id: 'session.events.get',
    title: 'Get session events',
    description: 'Inspect raw session events (tool calls, tool results, token counts, lifecycle, permission, stream, session events) for diagnostics. Use session_transcript_get for normal transcript reading.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_events_get' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}","limit":50,"kinds":["tool_call","tool_result"]}' },
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      title: 'Get session events',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'limit', title: 'Limit', widget: 'text' },
        { path: 'cursor', title: 'Cursor', widget: 'text' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionEventsGetInputSchema,
  },
  {
    id: 'session.wait.idle',
    title: 'Wait for session idle',
    description: 'Wait until the session becomes idle or the timeout elapses.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_wait_idle' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}","timeoutSeconds":300}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      title: 'Wait for idle',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'timeoutSeconds', title: 'Timeout seconds', widget: 'text' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionWaitIdleInputSchema,
  },
  {
    id: 'session.permission.respond',
    title: 'Respond to permission request',
    sideEffectClass: 'write',
    description: 'Approve or deny an active permission request in a session.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'session.permission.respond' },
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: true,
      rpc: true,
      },
    inputHints: {
      title: 'Respond to permission request',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        {
          path: 'decision',
          title: 'Decision',
          widget: 'select',
          required: true,
          options: [
            { value: 'allow', label: 'Allow' },
            { value: 'deny', label: 'Deny' },
          ],
        },
        { path: 'requestId', title: 'Request id', widget: 'text' },
      ],
    },
    outputSchema: SessionInteractionResponseSuccessSchema,
    inputSchema: SessionPermissionRespondInputSchema,
  },
  {
    id: 'session.permission.remote.pending.list',
    title: 'List remotely mediated permission requests',
    sideEffectClass: 'read',
    description: 'List the caller mediator’s current permission requests for one exact source authority.',
    safety: 'safe',
    placements: [],
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: false,
    },
    inputHints: {
      title: 'List remotely mediated permission requests',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'sourceRef', title: 'Source reference', widget: 'text', required: true },
        { path: 'sourceRevisionOrEpoch', title: 'Source revision', widget: 'text', required: true },
      ],
    },
    outputSchema: SessionPermissionRemotePendingListOutputV1Schema,
    inputSchema: SessionPermissionRemotePendingListInputV1Schema,
  },
  {
    id: 'session.permission.remote.respond',
    title: 'Respond to a remotely mediated permission request',
    sideEffectClass: 'write',
    description: 'Submit an attributed external-human decision for one current permission request.',
    safety: 'safe',
    placements: [],
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: false,
    },
    inputHints: {
      title: 'Respond to a remotely mediated permission request',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'turnId', title: 'Turn id', widget: 'text', required: true },
        { path: 'requestId', title: 'Request id', widget: 'text', required: true },
        { path: 'sourceRef', title: 'Source reference', widget: 'text', required: true },
        { path: 'sourceRevisionOrEpoch', title: 'Source revision', widget: 'text', required: true },
        { path: 'idempotencyKey', title: 'Idempotency key', widget: 'text', required: true },
        { path: 'actor.namespace', title: 'External principal namespace', widget: 'text', required: true },
        { path: 'actor.principalId', title: 'External principal id', widget: 'text', required: true },
        {
          path: 'decision',
          title: 'Decision',
          widget: 'select',
          required: true,
          options: [
            { value: 'allow', label: 'Allow' },
            { value: 'deny', label: 'Deny' },
          ],
        },
        {
          path: 'scope',
          title: 'Scope',
          widget: 'select',
          required: true,
          options: [
            { value: 'request', label: 'This request' },
            { value: 'session', label: 'This session' },
          ],
        },
      ],
    },
    outputSchema: SessionPermissionRemoteRespondOutputV1Schema,
    inputSchema: SessionPermissionRemoteRespondInputV1Schema,
  },
  {
    id: 'session.permission.remote.grants.list',
    title: 'List remotely mediated permission grants',
    sideEffectClass: 'read',
    description: 'List source-scoped remote permission grants visible to the authenticated caller.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'session.permission.remote.grants.list' },
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: true,
      rpc: true,
    },
    inputHints: {
      title: 'List remotely mediated permission grants',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'limit', title: 'Maximum grants', widget: 'text' },
        { path: 'cursor', title: 'Continuation cursor', widget: 'text' },
      ],
    },
    outputSchema: SessionPermissionRemoteGrantsListOutputV1Schema,
    inputSchema: SessionPermissionRemoteGrantsListInputV1Schema,
  },
  {
    id: 'session.permission.remote.grants.revoke',
    title: 'Revoke a remotely mediated permission grant',
    sideEffectClass: 'write',
    description: 'Revoke one source-scoped remote permission grant.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'session.permission.remote.grants.revoke' },
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: true,
      rpc: true,
    },
    inputHints: {
      title: 'Revoke a remotely mediated permission grant',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'turnId', title: 'Turn id', widget: 'text', required: true },
        { path: 'requestId', title: 'Request id', widget: 'text', required: true },
        { path: 'grantId', title: 'Grant id', widget: 'text', required: true },
      ],
    },
    outputSchema: SessionPermissionRemoteGrantRevokeOutputV1Schema,
    inputSchema: SessionPermissionRemoteGrantRevokeInputV1Schema,
  },
  {
    id: 'session.user_action.answer',
    title: 'Respond to user-action request',
    sideEffectClass: 'write',
    description: 'Approve, reject, request changes, or provide structured answers for an active user-action request.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'answerUserActionRequest', mcpToolName: 'session_user_action_answer', rpcMethod: 'session.user_action.answer' },
    examples: {
      voice: {
        argsExample:
          '{"sessionId":"{{sessionId}}","answers":[{"question":"Continue?","values":["Yes"]}]}',
      },
    },
    surfaceBindings: {
      plugin: {
        inputSchema: SessionUserActionAnswerPluginInputSchema,
        bindInput: bindPluginCurrentSessionInput,
        projectOutput: projectPluginSessionInteractionResponse,
      },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
      },
    inputHints: {
      title: 'Respond to user-action request',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'requestId', title: 'Request id', widget: 'text' },
        {
          path: 'decision',
          title: 'Decision',
          description: 'Use approve or reject for general user actions, or request_changes when you need the coding assistant to revise something first.',
          widget: 'select',
          options: [
            { value: 'approve', label: 'Approve' },
            { value: 'reject', label: 'Reject' },
            { value: 'request_changes', label: 'Request changes' },
          ],
        },
        {
          path: 'reason',
          title: 'Reason',
          description: 'Required when requesting changes. Optional extra context for a rejection.',
          widget: 'textarea',
        },
        {
          path: 'answers',
          title: 'Answers',
          description: 'Structured answers for question-style user-action requests such as AskUserQuestion.',
          widget: 'json',
        },
      ],
    },
    outputSchema: SessionInteractionResponseSuccessSchema,
    inputSchema: SessionUserActionAnswerInputSchema,
  },
  {
    id: 'session.mode.set',
    title: 'Set session mode',
    sideEffectClass: 'write',
    description: 'Request a new ACP session mode for the current session when the active provider supports session modes.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'setSessionMode', mcpToolName: 'session_mode_set' },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","modeId":"plan"}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      title: 'Set session mode',
      fields: [
        { path: 'sessionId', title: 'Session id', description: 'Optional when the active target session is already correct.', widget: 'text' },
        {
          path: 'modeId',
          title: 'Mode id',
          description: 'Use default to clear the override and return to the provider default mode.',
          widget: 'select',
          required: true,
          optionsSourceId: 'session.modes.available',
        },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionModeSetInputSchema,
  },
  {
    id: 'session.target.primary.set',
    title: 'Set primary action session',
    sideEffectClass: 'write',
    description: 'Set which session the voice assistant should target by default.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
      bindings: { voiceClientToolName: 'setPrimaryActionSession', mcpToolName: 'session_target_primary_set' },
    examples: {
      voice: { argsExample: '{"sessionTitle":"Session Setup"}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: false,
      mcp: true,
      cli: false,
      rpc: false,
      },
    inputHints: {
      title: 'Set primary action session',
      fields: [
        { path: 'sessionId', title: 'Session id (or null)', widget: 'text' },
        { path: 'sessionTitle', title: 'Session title', widget: 'text' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionPrimaryTargetInputSchema,
  },
  {
    id: 'session.target.tracked.set',
    title: 'Set tracked sessions',
    sideEffectClass: 'write',
    description: 'Set which sessions should be treated as tracked for updates/snippets.',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'setTrackedSessions' },
    examples: {
      voice: { argsExample: '{"sessionIds":["{{sessionId}}"]}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: false,
      mcp: false,
      cli: false,
      rpc: false,
      },
    inputHints: {
      title: 'Set tracked sessions',
      fields: [{ path: 'sessionIds', title: 'Session ids', widget: 'text_list', listSeparator: 'comma', required: true }],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionTrackedTargetsInputSchema,
  },
  {
    id: 'session.list',
    title: 'List sessions',
    sideEffectClass: 'read',
    description: 'List recent sessions the user can target.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'listSessions', mcpToolName: 'session_list' },
    examples: {
      voice: { argsExample: '{"limit":20,"cursor":null}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      title: 'List sessions',
      fields: [
        { path: 'limit', title: 'Limit', widget: 'text' },
        { path: 'cursor', title: 'Cursor', widget: 'text' },
        { path: 'includeLastMessagePreview', title: 'Include last message preview', widget: 'boolean' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionListInputSchema,
  },
  {
    id: 'session.activity.get',
    title: 'Get session activity',
    sideEffectClass: 'read',
    description: 'Get a short activity digest for a session without transcript content.',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'getSessionActivity', mcpToolName: 'session_activity_get' },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      title: 'Get session activity',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'windowSeconds', title: 'Window seconds', widget: 'text' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionActivityInputSchema,
  },
  {
    id: 'session.messages.recent.get',
    title: 'Get recent messages',
    description: 'DEPRECATED: use session_transcript_get. Returns semantic transcript items with cleaner pagination.',
    safety: 'safe',
    placements: [],
    bindings: { voiceClientToolName: 'getSessionRecentMessages', mcpToolName: 'session_messages_recent_get' },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","limit":3,"cursor":null}' },
      },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      title: 'Get recent messages',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'limit', title: 'Limit', widget: 'text' },
        { path: 'cursor', title: 'Cursor', widget: 'text' },
        { path: 'includeUser', title: 'Include user', widget: 'boolean' },
        { path: 'includeAssistant', title: 'Include assistant', widget: 'boolean' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionRecentMessagesInputSchema,
  },
  {
    id: 'ui.voice_global.reset',
    title: 'Reset voice agent',
    sideEffectClass: 'write',
    safety: 'safe',
    placements: ['voice_panel', 'command_palette', 'slash_command'],
    slash: { tokens: ['/h.voice.reset'] },
    bindings: { voiceClientToolName: 'resetGlobalVoiceAgent' },
    inputHints: {
      title: 'Reset voice agent',
      description: 'Reset the global voice agent state (clears the current voice conversation).',
      fields: [],
    },
    examples: {
      voice: { argsExample: '{}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: false,
      mcp: false,
      cli: false,
      rpc: false,
      },
    outputSchema: StrictJsonValueSchema,
    inputSchema: EmptyObjectSchema,
  },
  {
    id: 'ui.pet.choose',
    title: 'Choose pet',
    description: 'Open pet settings so the user can choose or manage their companion.',
    safety: 'safe',
    placements: ['slash_command'],
    slash: { tokens: ['/pet', '/h.pet'] },
    inputHints: {
      title: 'Choose pet',
      description: 'Open pet settings.',
      fields: [],
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: false,
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: EmptyObjectSchema,
  },
  {
    id: 'ui.voice_agent.teleport',
    title: 'Teleport voice agent to session root',
    sideEffectClass: 'write',
    description: 'Move the daemon-backed voice agent into the current or specified session root.',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'teleportVoiceAgentToSessionRoot' },
    inputHints: {
      title: 'Teleport voice agent',
      description: 'Teleport the active voice agent into a session root. Defaults to the current action session when omitted.',
      fields: [{ path: 'sessionId', title: 'Session id', widget: 'text' }],
    },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: false,
      mcp: false,
      cli: false,
      rpc: false,
      },
    outputSchema: StrictJsonValueSchema,
    inputSchema: OptionalSessionIdInputSchema,
  },
  {
    id: 'ui.current_context.read',
    title: 'Read current UI context',
    description: 'Read the current local UI navigation context and its bounded opaque command descriptors.',
    sideEffectClass: 'read',
    safety: 'safe',
    placements: [],
    bindings: { voiceClientToolName: 'readCurrentUiContext' },
    examples: {
      voice: { argsExample: '{}' },
    },
    surfaces: {
      ui: false,
      voice: true,
      agent: false,
      mcp: false,
      cli: false,
      rpc: false,
    },
    inputHints: {
      title: 'Read current UI context',
      description: 'Returns only the current local navigation snapshot and opaque command descriptors.',
      fields: [],
    },
    outputSchema: CurrentUiContextSnapshotV1Schema,
    inputSchema: EmptyObjectSchema,
  },
  {
    id: 'ui.current_context.command.invoke',
    title: 'Invoke current UI command',
    description: 'Invoke one currently available opaque command from the local current UI context. If the result is `denied`, the person declined the confirmation: report that and do not invoke it again unless they ask.',
    sideEffectClass: 'external',
    safety: 'safe',
    placements: [],
    bindings: { voiceClientToolName: 'invokeCurrentUiCommand' },
    examples: {
      voice: { argsExample: '{"commandId":"current-ui:1:0"}' },
    },
    surfaces: {
      ui: false,
      voice: true,
      agent: false,
      mcp: false,
      cli: false,
      rpc: false,
    },
    inputHints: {
      title: 'Invoke current UI command',
      description: 'Use only an opaque command id returned by readCurrentUiContext; semantic command data is never accepted here.',
      fields: [
        { path: 'commandId', title: 'Opaque command id', widget: 'text', required: true },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: CurrentUiContextCommandInvokeInputSchema,
  },
  {
    id: 'memory.search',
    title: 'Search memory',
    sideEffectClass: 'read',
    description: 'Search the local daemon memory index (opt-in).',
    safety: 'safe',
    placements: ['voice_panel', 'command_palette'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'memorySearch', mcpToolName: 'memory_search' },
    inputHints: {
      title: 'Search memory',
      description: 'Search across sessions using the daemon-local memory index.',
      fields: [
        {
          path: 'machineId',
          title: 'Machine id',
          description: 'Machine running the daemon memory index.',
          widget: 'text',
          required: true,
        },
        {
          path: 'query.query',
          title: 'Query',
          description: 'What to search for.',
          widget: 'text',
          required: true,
        },
        {
          path: 'query.mode',
          title: 'Mode',
          description: 'Which index to search.',
          widget: 'select',
          required: true,
          options: [
            { value: 'hints', label: 'Hints' },
            { value: 'deep', label: 'Deep' },
            { value: 'auto', label: 'Auto' },
          ],
        },
      ],
    },
    examples: {
      voice: { argsExample: '{"machineId":"{{machineId}}","query":{"v":1,"query":"openclaw","scope":{"type":"global"},"mode":"hints"}}' },
      mcp: { argsExample: '{"machineId":"{{machineId}}","query":{"v":1,"query":"openclaw","scope":{"type":"global"},"mode":"hints"}}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: false,
      cli: false,
      rpc: false,
      },
    outputSchema: MemorySearchResultV1Schema,
    inputSchema: MemorySearchInputSchema,
  },
  {
    id: 'memory.get_window',
    title: 'Get memory window',
    sideEffectClass: 'read',
    description: 'Fetch and decrypt a transcript window (used to verify/quote a memory hit).',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'memoryGetWindow', mcpToolName: 'memory_get_window' },
    inputHints: {
      title: 'Get memory window',
      description: 'Fetch and decrypt a message range from a specific session.',
      fields: [
        { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'seqFrom', title: 'Seq from', widget: 'text', required: true },
        { path: 'seqTo', title: 'Seq to', widget: 'text', required: true },
      ],
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: false,
      cli: false,
      rpc: false,
      },
    examples: {
      voice: { argsExample: '{"machineId":"{{machineId}}","sessionId":"{{sessionId}}","seqFrom":120,"seqTo":124}' },
      mcp: { argsExample: '{"machineId":"{{machineId}}","sessionId":"{{sessionId}}","seqFrom":120,"seqTo":124}' },
    },
    outputSchema: MemoryWindowV1Schema,
    inputSchema: MemoryGetWindowInputSchema,
  },
  {
    id: 'memory.ensure_up_to_date',
    title: 'Ensure memory up to date',
    sideEffectClass: 'write',
    description: 'Trigger the daemon to sync memory hints for a session (or all active sessions).',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'memoryEnsureUpToDate', mcpToolName: 'memory_ensure_up_to_date' },
    inputHints: {
      title: 'Ensure memory up to date',
      description: 'Forces the daemon memory worker to process new transcript content.',
      fields: [
        { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
        { path: 'sessionId', title: 'Session id (optional)', widget: 'text' },
      ],
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: false,
      cli: false,
      rpc: false,
      },
    examples: {
      voice: { argsExample: '{"machineId":"{{machineId}}","sessionId":"{{sessionId}}"}' },
      mcp: { argsExample: '{"machineId":"{{machineId}}","sessionId":"{{sessionId}}"}' },
    },
    outputSchema: MemoryEnsureUpToDateOutputSchema,
    inputSchema: MemoryEnsureUpToDateInputSchema,
  },
  {
    id: 'prompt_doc.update',
    title: 'Update prompt document',
    description: 'Update a prompt document stored in the Happier prompt library.',
    safety: 'danger',
    placements: [],
    bindings: { mcpToolName: 'prompt_doc_update' },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    outputSchema: StrictJsonValueSchema,
    inputSchema: PromptDocUpdateInputSchema,
    inputHints: {
      title: 'Update prompt document',
      fields: [
        { path: 'artifactId', title: 'Prompt artifact id', widget: 'text', required: true },
        { path: 'title', title: 'Title', widget: 'text', required: true },
        { path: 'markdown', title: 'Markdown', widget: 'textarea', required: true },
        { path: 'folderId', title: 'Folder id', widget: 'text' },
        { path: 'tags', title: 'Tags', widget: 'text_list', listSeparator: 'comma' },
      ],
    },
  },
  {
    id: 'prompt_bundle.update',
    title: 'Update prompt bundle',
    description: 'Update a skill bundle stored in the Happier prompt library.',
    safety: 'danger',
    placements: [],
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: false,
      },
    outputSchema: StrictJsonValueSchema,
    inputSchema: PromptBundleUpdateInputSchema,
    inputHints: {
      title: 'Update prompt bundle',
      fields: [
        { path: 'artifactId', title: 'Bundle artifact id', widget: 'text', required: true },
        { path: 'title', title: 'Title', widget: 'text', required: true },
        { path: 'skillMarkdown', title: 'SKILL.md markdown', widget: 'textarea', required: true },
        { path: 'folderId', title: 'Folder id', widget: 'text' },
        { path: 'tags', title: 'Tags', widget: 'text_list', listSeparator: 'comma' },
      ],
    },
  },
  {
    id: 'prompt_asset.export',
    title: 'Export prompt asset',
    description: 'Export a prompt doc or skill bundle from the Happier library to a provider-native asset.',
    safety: 'danger',
    placements: [],
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: false,
      },
    outputSchema: StrictJsonValueSchema,
    inputSchema: PromptAssetExportInputSchema,
    inputHints: {
      title: 'Export prompt asset',
      fields: [
        { path: 'artifactId', title: 'Artifact id', widget: 'text', required: true },
        { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
        { path: 'assetTypeId', title: 'Asset type id', widget: 'text', required: true },
        {
          path: 'scope',
          title: 'Scope',
          widget: 'select',
          required: true,
          options: [
            { value: 'project', label: 'Project' },
            { value: 'user', label: 'User' },
          ],
        },
        { path: 'directory', title: 'Project directory', widget: 'text' },
        { path: 'targetPath', title: 'Document path', widget: 'text' },
        { path: 'targetName', title: 'Skill name', widget: 'text' },
        {
          path: 'installMode',
          title: 'Install mode',
          widget: 'select',
          options: [
            { value: 'copy', label: 'Copy' },
            { value: 'symlink', label: 'Symlink' },
          ],
        },
      ],
    },
  },
  {
    id: 'prompt_registry.install',
    title: 'Install prompt registry skill',
    description: 'Import a skill bundle from a registry and optionally export it to an external skills location.',
    safety: 'danger',
    placements: [],
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: false,
      },
    outputSchema: StrictJsonValueSchema,
    inputSchema: PromptRegistryInstallInputSchema,
    inputHints: {
      title: 'Install prompt registry skill',
      fields: [
        { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
        { path: 'sourceId', title: 'Source id', widget: 'text', required: true },
        { path: 'itemId', title: 'Item id', widget: 'text', required: true },
        { path: 'configuredSources', title: 'Configured sources (json)', widget: 'textarea' },
        { path: 'installTarget.assetTypeId', title: 'Target asset type', widget: 'text' },
        {
          path: 'installTarget.scope',
          title: 'Target scope',
          widget: 'select',
          options: [
            { value: 'project', label: 'Project' },
            { value: 'user', label: 'User' },
          ],
        },
        { path: 'installTarget.directory', title: 'Project directory', widget: 'text' },
        { path: 'installTarget.targetName', title: 'Target skill name', widget: 'text' },
        {
          path: 'installTarget.installMode',
          title: 'Install mode',
          widget: 'select',
          options: [
            { value: 'copy', label: 'Copy' },
            { value: 'symlink', label: 'Symlink' },
          ],
        },
      ],
    },
  },
  {
    id: 'daemon.promptAssets.discover',
    title: 'Discover prompt assets',
    description: 'Discover provider-native prompt assets through the daemon prompt asset adapter registry.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'daemon.promptAssets.discover' },
    surfaces: DAEMON_ADMIN_RPC_SURFACES,
    sideEffectClass: 'read',
    outputSchema: StrictJsonValueSchema,
    inputSchema: PromptAssetDiscoverRequestSchema,
    inputHints: DAEMON_ADMIN_INPUT_HINTS,
  },
  {
    id: 'daemon.promptAssets.delete',
    title: 'Delete prompt asset',
    description: 'Delete a provider-native prompt asset through the daemon prompt asset adapter registry.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: 'daemon.promptAssets.delete' },
    surfaces: DAEMON_ADMIN_RPC_SURFACES,
    sideEffectClass: 'danger',
    outputSchema: StrictJsonValueSchema,
    inputSchema: PromptAssetDeleteRequestSchema,
    inputHints: DAEMON_ADMIN_INPUT_HINTS,
  },
  {
    id: 'daemon.promptRegistry.scanSource',
    title: 'Scan prompt registry source',
    description: 'Scan a configured prompt registry source through the daemon prompt registry adapter registry.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'daemon.promptRegistry.scanSource' },
    surfaces: DAEMON_ADMIN_RPC_SURFACES,
    sideEffectClass: 'read',
    outputSchema: StrictJsonValueSchema,
    inputSchema: PromptRegistryScanSourceRequestV1Schema,
    inputHints: DAEMON_ADMIN_INPUT_HINTS,
  },
  {
    id: 'daemon.promptRegistry.install',
    title: 'Install prompt registry asset',
    description: 'Install a prompt registry item through bundle-capable prompt asset adapters.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: 'daemon.promptRegistry.install' },
    surfaces: DAEMON_ADMIN_RPC_SURFACES,
    sideEffectClass: 'danger',
    outputSchema: StrictJsonValueSchema,
    inputSchema: PromptRegistryInstallRequestV1Schema,
    inputHints: DAEMON_ADMIN_INPUT_HINTS,
  },
  {
    id: 'daemon.filesystem.readFile',
    title: 'Read file',
    description: 'Read a bounded file through daemon filesystem path authorization.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'readFile' },
    surfaces: DAEMON_ADMIN_RPC_SURFACES,
    sideEffectClass: 'read',
    outputSchema: StrictJsonValueSchema,
    inputSchema: DaemonFilesystemReadFileInputSchema,
    inputHints: DAEMON_ADMIN_INPUT_HINTS,
  },
  {
    id: 'daemon.filesystem.writeFile',
    title: 'Write file',
    description: 'Write a bounded file through daemon filesystem path authorization.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: 'writeFile' },
    surfaces: DAEMON_ADMIN_RPC_SURFACES,
    sideEffectClass: 'danger',
    outputSchema: StrictJsonValueSchema,
    inputSchema: DaemonFilesystemWriteFileInputSchema,
    inputHints: DAEMON_ADMIN_INPUT_HINTS,
  },
  {
    id: 'daemon.filesystem.listDirectory',
    title: 'List directory',
    description: 'List a directory through daemon filesystem path authorization.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'listDirectory' },
    surfaces: DAEMON_ADMIN_RPC_SURFACES,
    sideEffectClass: 'read',
    outputSchema: StrictJsonValueSchema,
    inputSchema: DaemonFilesystemListDirectoryInputSchema,
    inputHints: DAEMON_ADMIN_INPUT_HINTS,
  },
  {
    id: 'daemon.filesystem.getDirectoryTree',
    title: 'Get directory tree',
    description: 'Read a bounded directory tree through daemon filesystem path authorization.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'getDirectoryTree' },
    surfaces: DAEMON_ADMIN_RPC_SURFACES,
    sideEffectClass: 'read',
    outputSchema: StrictJsonValueSchema,
    inputSchema: DaemonFilesystemGetDirectoryTreeInputSchema,
    inputHints: DAEMON_ADMIN_INPUT_HINTS,
  },
  {
    id: 'daemon.filesystem.listRoots',
    title: 'List filesystem roots',
    description: 'List bounded machine file-browser roots resolved from daemon filesystem access policy.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'daemon.filesystem.listRoots' },
    surfaces: DAEMON_ADMIN_RPC_SURFACES,
    sideEffectClass: 'read',
    outputSchema: StrictJsonValueSchema,
    inputSchema: EmptyObjectSchema,
    inputHints: DAEMON_ADMIN_INPUT_HINTS,
  },
  {
    id: 'daemon.filesystem.browseDirectory',
    title: 'Browse filesystem directory',
    description: 'List a machine file-browser directory constrained to a configured browse root.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'daemon.filesystem.listDirectory' },
    surfaces: DAEMON_ADMIN_RPC_SURFACES,
    sideEffectClass: 'read',
    outputSchema: StrictJsonValueSchema,
    inputSchema: DaemonFilesystemListDirectoryRequestSchema,
    inputHints: DAEMON_ADMIN_INPUT_HINTS,
  },
  {
    id: 'bugreport.collectDiagnostics',
    title: 'Collect bug report diagnostics',
    description: 'Collect bounded, redacted daemon diagnostics for a bug report.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'bugreport.collectDiagnostics' },
    surfaces: DAEMON_ADMIN_RPC_SURFACES,
    sideEffectClass: 'read',
    outputSchema: StrictJsonValueSchema,
    inputSchema: PassthroughEmptyObjectSchema,
    inputHints: DAEMON_ADMIN_INPUT_HINTS,
  },
  {
    id: 'bugreport.getLogTail',
    title: 'Read bug report log tail',
    description: 'Read a bounded daemon log tail from diagnostics-approved candidate paths.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'bugreport.getLogTail' },
    surfaces: DAEMON_ADMIN_RPC_SURFACES,
    sideEffectClass: 'read',
    outputSchema: StrictJsonValueSchema,
    inputSchema: BugReportGetLogTailInputSchema,
    inputHints: DAEMON_ADMIN_INPUT_HINTS,
  },
  {
    id: 'bugreport.uploadArtifact',
    title: 'Upload bug report artifact',
    description: 'Return daemon-side bug report artifact upload availability without exposing secret material.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'bugreport.uploadArtifact' },
    surfaces: DAEMON_ADMIN_RPC_SURFACES,
    sideEffectClass: 'none',
    outputSchema: StrictJsonValueSchema,
    inputSchema: BugReportUploadArtifactInputSchema,
    inputHints: DAEMON_ADMIN_INPUT_HINTS,
  },
  {
    id: 'approval.request.list',
    title: 'List approval requests',
    description: 'List approval queue entries from targeted approval artifact headers.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'approval.request.list' },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      },
    sideEffectClass: 'read',
    outputSchema: StrictJsonValueSchema,
    inputSchema: ApprovalRequestListInputSchema,
    inputHints: {
      title: 'List approval requests',
      description: 'Reads bounded approval queue metadata from artifact headers without transcript hydration.',
      fields: [
        {
          path: 'status',
          title: 'Status',
          widget: 'select',
          options: [
            { value: 'open', label: 'Open' },
            { value: 'approved', label: 'Approved' },
            { value: 'rejected', label: 'Rejected' },
            { value: 'executed', label: 'Executed' },
            { value: 'failed', label: 'Failed' },
            { value: 'canceled', label: 'Canceled' },
          ],
        },
        { path: 'limit', title: 'Limit', widget: 'text' },
      ],
    },
  },
  {
    id: 'approval.request.get',
    title: 'Get approval request',
    description: 'Fetch one approval request by approval artifact id.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'approval.request.get' },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      },
    sideEffectClass: 'read',
    outputSchema: StrictJsonValueSchema,
    inputSchema: ApprovalRequestGetInputSchema,
    inputHints: {
      title: 'Get approval request',
      fields: [
        { path: 'artifactId', title: 'Approval artifact id', widget: 'text', required: true },
      ],
    },
  },
  {
    id: 'approval.request.create',
    title: 'Create approval request',
    description: 'Create an approval request for another action to run.',
    safety: 'danger',
    placements: [],
    bindings: { mcpToolName: 'approval_request_create', rpcMethod: 'approval.request.create' },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
      },
    sideEffectClass: 'write',
    outputSchema: StrictJsonValueSchema,
    inputSchema: ApprovalRequestCreateInputSchema,
    inputHints: {
      title: 'Request approval',
      description: 'Create an approval request in the global inbox.',
      fields: [
        { path: 'summary', title: 'Summary', widget: 'textarea', required: true },
        { path: 'actionId', title: 'Action id', widget: 'text', required: true },
        { path: 'actionArgs', title: 'Action args (json)', widget: 'textarea', required: true },
      ],
    },
  },
  {
    id: 'approval.request.decide',
    title: 'Decide approval request',
    description: 'Approve or reject an approval request.',
    safety: 'danger',
    placements: [],
    bindings: { mcpToolName: 'approval_request_decide', rpcMethod: 'approval.request.decide' },
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: true,
      cli: true,
      rpc: true,
      },
    sideEffectClass: 'write',
    outputSchema: StrictJsonValueSchema,
    inputSchema: ApprovalRequestDecideInputSchema,
    inputHints: {
      title: 'Approve or reject',
      fields: [
        { path: 'artifactId', title: 'Approval artifact id', widget: 'text', required: true },
        {
          path: 'decision',
          title: 'Decision',
          widget: 'select',
          required: true,
          options: [
            { value: 'approve', label: 'Approve' },
            { value: 'reject', label: 'Reject' },
          ],
        },
      ],
    },
  },
  {
    id: 'session.log.tail',
    title: 'Tail session log',
    description: 'Read a bounded byte tail from an allowed session log file.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.SESSION_LOG_TAIL },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'read',
    outputSchema: SessionLogTailOutputSchema,
    inputSchema: SessionLogTailInputSchema,
    inputHints: {
      title: 'Tail session log',
      fields: [
        { path: 'path', title: 'Log path', widget: 'text', required: true },
        { path: 'maxBytes', title: 'Maximum bytes', widget: 'text' },
        { path: 'offset', title: 'File offset', widget: 'text' },
      ],
    },
  },
  {
    id: 'transcript.page',
    title: 'Page session transcript',
    description: 'Read a bounded older transcript page using cursor-backed storage.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.TRANSCRIPT_PAGE },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'read',
    outputSchema: TranscriptPageOutputSchema,
    inputSchema: TranscriptPageInputSchema,
    inputHints: {
      title: 'Page session transcript',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'cursor', title: 'Cursor', widget: 'text' },
        { path: 'maxBytes', title: 'Maximum bytes', widget: 'text' },
        { path: 'maxItems', title: 'Maximum items', widget: 'text' },
      ],
    },
  },
  {
    id: 'transcript.readAfter',
    title: 'Read session transcript after cursor',
    description: 'Read bounded transcript deltas after a cursor.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.TRANSCRIPT_READ_AFTER },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'read',
    outputSchema: TranscriptReadAfterOutputSchema,
    inputSchema: TranscriptReadAfterInputSchema,
    inputHints: {
      title: 'Read session transcript after cursor',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'cursor', title: 'Cursor', widget: 'text', required: true },
        { path: 'maxBytes', title: 'Maximum bytes', widget: 'text' },
        { path: 'maxItems', title: 'Maximum items', widget: 'text' },
      ],
    },
  },
  {
    id: 'transcript.follow',
    title: 'Follow session transcript',
    description: 'Create or refresh a retained bounded transcript follow lease.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.TRANSCRIPT_FOLLOW },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'read',
    outputSchema: TranscriptFollowOutputSchema,
    inputSchema: TranscriptFollowInputSchema,
    inputHints: {
      title: 'Follow session transcript',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'cursor', title: 'Cursor', widget: 'text', required: true },
        { path: 'leaseId', title: 'Lease id', widget: 'text' },
        { path: 'maxBytes', title: 'Maximum bytes', widget: 'text' },
        { path: 'maxItems', title: 'Maximum items', widget: 'text' },
        { path: 'idleTtlMs', title: 'Idle TTL milliseconds', widget: 'text' },
      ],
    },
  },
  {
    id: 'transcript.unfollow',
    title: 'Unfollow session transcript',
    description: 'Release a retained transcript follow lease.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.TRANSCRIPT_UNFOLLOW },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'write',
    outputSchema: TranscriptUnfollowOutputSchema,
    inputSchema: TranscriptUnfollowInputSchema,
    inputHints: {
      title: 'Unfollow session transcript',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'leaseId', title: 'Lease id', widget: 'text', required: true },
      ],
    },
  },
  {
    id: 'transcript.import',
    title: 'Import session transcript rows',
    description: 'Import a bounded batch of transcript rows through the session transcript writer owner.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.TRANSCRIPT_IMPORT },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'write',
    outputSchema: TranscriptImportOutputSchema,
    inputSchema: TranscriptImportInputSchema,
    inputHints: {
      title: 'Import session transcript rows',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'importId', title: 'Import id', widget: 'text' },
        { path: 'items', title: 'Transcript rows', widget: 'textarea', required: true },
        { path: 'maxItems', title: 'Maximum items', widget: 'text' },
      ],
    },
  },
  {
    id: 'transcript.search',
    title: 'Search session transcript',
    description: 'Search transcript rows through bounded forward cursor reads.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.TRANSCRIPT_SEARCH },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'read',
    outputSchema: TranscriptReadAfterOutputSchema,
    inputSchema: TranscriptSearchInputSchema,
    inputHints: {
      title: 'Search session transcript',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'query', title: 'Query', widget: 'text', required: true },
        { path: 'cursor', title: 'Cursor', widget: 'text' },
        { path: 'maxBytes', title: 'Maximum bytes', widget: 'text' },
        { path: 'maxItems', title: 'Maximum items', widget: 'text' },
        { path: 'maxReads', title: 'Maximum reads', widget: 'text' },
      ],
    },
  },
  {
    id: 'sessions.external.candidates.list',
    title: 'List external session candidates',
    description: 'List attachable external session candidates through the external-session machine RPC.',
    safety: 'safe',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST,
      rpcMethodAliases: [RPC_METHODS.DAEMON_DIRECT_SESSIONS_CANDIDATES_LIST_LEGACY],
      sdkMethod: 'sessions.external.listCandidates',
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'read',
    outputSchema: ExternalSessionsCandidatesListResponseSchema,
    inputSchema: ExternalSessionsCandidatesListRequestSchema,
    inputHints: {
      title: 'List external session candidates',
      fields: [
        { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
        { path: 'providerId', title: 'Provider id', widget: 'text', required: true },
        { path: 'source', title: 'External source', widget: 'textarea', required: true },
        { path: 'cursor', title: 'Cursor', widget: 'text' },
        { path: 'limit', title: 'Limit', widget: 'text' },
        { path: 'searchTerm', title: 'Search term', widget: 'text' },
      ],
    },
  },
  {
    id: 'sessions.external.link.ensure',
    title: 'Ensure external session link',
    description: 'Create or reuse the Happier link for an external provider session.',
    safety: 'danger',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_LINK_ENSURE,
      rpcMethodAliases: [RPC_METHODS.DAEMON_DIRECT_SESSION_LINK_ENSURE_LEGACY],
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'write',
    outputSchema: ExternalSessionLinkEnsureResponseSchema,
    inputSchema: ExternalSessionLinkEnsureRequestSchema,
    inputHints: {
      title: 'Ensure external session link',
      fields: [
        { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
        { path: 'providerId', title: 'Provider id', widget: 'text', required: true },
        { path: 'remoteSessionId', title: 'Remote session id', widget: 'text', required: true },
        { path: 'source', title: 'External source', widget: 'textarea', required: true },
        { path: 'titleHint', title: 'Title hint', widget: 'text' },
        { path: 'directoryHint', title: 'Directory hint', widget: 'text' },
      ],
    },
  },
  {
    id: 'sessions.external.follow',
    title: 'Follow external session lease',
    description: 'Attach an ephemeral follow lease to an external session link.',
    safety: 'danger',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_ATTACH,
      rpcMethodAliases: [RPC_METHODS.DAEMON_DIRECT_SESSION_ATTACH_LEGACY],
    },
    surfaceBindings: {
      rpc: {
        inputSchema: ExternalSessionAttachRequestSchema,
        decodeInput: identityActionSurfaceValue,
        outputSchema: ExternalSessionAttachResponseSchema,
        encodeOutput: identityActionSurfaceValue,
      },
      plugin: {
        inputSchema: ExternalSessionViewerFollowActionInputV1Schema,
        projectOutput: projectExternalSessionViewerFollowResult,
      },
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'write',
    outputSchema: ExternalSessionViewerFollowActionResultV1Schema,
    inputSchema: ExternalSessionViewerFollowActionInputV1Schema,
    inputHints: {
      title: 'Follow external session lease',
      fields: [
        { path: 'sessionId', title: 'Linked session id', widget: 'text', required: true },
        { path: 'leaseId', title: 'Lease id', widget: 'text' },
        { path: 'ttlMs', title: 'Lease TTL milliseconds', widget: 'text' },
      ],
    },
  },
  {
    id: 'sessions.external.unfollow',
    title: 'Unfollow external session lease',
    description: 'Detach an external-session follow lease.',
    safety: 'danger',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_DETACH,
      rpcMethodAliases: [RPC_METHODS.DAEMON_DIRECT_SESSION_DETACH_LEGACY],
    },
    surfaceBindings: {
      rpc: {
        inputSchema: ExternalSessionDetachRequestSchema,
        decodeInput: identityActionSurfaceValue,
        outputSchema: ExternalSessionDetachResponseSchema,
        encodeOutput: identityActionSurfaceValue,
      },
      plugin: {
        inputSchema: ExternalSessionViewerUnfollowActionInputV1Schema,
        projectOutput: projectExternalSessionViewerUnfollowResult,
      },
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'write',
    outputSchema: ExternalSessionViewerUnfollowActionResultV1Schema,
    inputSchema: ExternalSessionViewerUnfollowActionInputV1Schema,
    inputHints: {
      title: 'Unfollow external session lease',
      fields: [
        { path: 'sessionId', title: 'Linked session id', widget: 'text', required: true },
        { path: 'leaseId', title: 'Lease id', widget: 'text', required: true },
      ],
    },
  },
  {
    id: 'sessions.external.backgroundFollow.set',
    title: 'Set external session follow policy',
    description: 'Enable or disable background following for an external session.',
    safety: 'danger',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_BACKGROUND_FOLLOW_SET,
    },
    surfaceBindings: {
      rpc: {
        inputSchema: ExternalSessionFollowPolicySetRequestSchema,
        decodeInput: identityActionSurfaceValue,
        outputSchema: ExternalSessionFollowPolicySetResponseSchema,
        encodeOutput: identityActionSurfaceValue,
      },
      plugin: {
        inputSchema: ExternalSessionBackgroundFollowActionInputV1Schema,
        projectOutput: projectExternalSessionBackgroundFollowResult,
      },
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'write',
    outputSchema: ExternalSessionBackgroundFollowActionResultV1Schema,
    inputSchema: ExternalSessionBackgroundFollowActionInputV1Schema,
    inputHints: {
      title: 'Set external session follow policy',
      fields: [
        { path: 'sessionId', title: 'Linked session id', widget: 'text', required: true },
        { path: 'enabled', title: 'Enabled', widget: 'boolean', required: true },
      ],
    },
  },
  {
    id: 'sessions.external.status.get',
    title: 'Get external session status',
    description: 'Read bounded status and takeover readiness for a linked external session.',
    safety: 'safe',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_STATUS_GET,
      rpcMethodAliases: [RPC_METHODS.DAEMON_DIRECT_SESSION_STATUS_GET_LEGACY],
    },
    surfaceBindings: {
      rpc: {
        inputSchema: ExternalSessionStatusGetRequestSchema,
        decodeInput: identityActionSurfaceValue,
        outputSchema: ExternalSessionStatusGetResponseSchema,
        encodeOutput: identityActionSurfaceValue,
      },
      plugin: {
        inputSchema: ExternalSessionStatusActionInputV1Schema,
        projectOutput: projectExternalSessionStatusResult,
      },
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'read',
    outputSchema: ExternalSessionStatusActionResultV1Schema,
    inputSchema: ExternalSessionStatusActionInputV1Schema,
    inputHints: {
      title: 'Get external session status',
      fields: [
        { path: 'sessionId', title: 'Linked session id', widget: 'text', required: true },
      ],
    },
  },
  {
    id: 'sessions.external.transcript.page',
    title: 'Page external session transcript',
    description: 'Read a bounded transcript page for an external provider session.',
    safety: 'safe',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_PAGE,
      rpcMethodAliases: [RPC_METHODS.DAEMON_DIRECT_SESSION_TRANSCRIPT_PAGE_LEGACY],
      sdkMethod: 'sessions.external.pageTranscript',
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'read',
    outputSchema: ExternalSessionTranscriptPageResponseSchema,
    inputSchema: ExternalSessionTranscriptPageRequestSchema,
    inputHints: {
      title: 'Page external session transcript',
      fields: [
        { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
        { path: 'providerId', title: 'Provider id', widget: 'text', required: true },
        { path: 'remoteSessionId', title: 'Remote session id', widget: 'text', required: true },
        { path: 'source', title: 'External source', widget: 'textarea', required: true },
        { path: 'direction', title: 'Direction', widget: 'select', required: true, options: [
          { value: 'older', label: 'Older' },
          { value: 'newer', label: 'Newer' },
        ] },
        { path: 'cursor', title: 'Cursor', widget: 'text' },
        { path: 'maxBytes', title: 'Maximum bytes', widget: 'text' },
        { path: 'maxItems', title: 'Maximum items', widget: 'text' },
      ],
    },
  },
  {
    id: 'sessions.external.transcript.readAfter',
    title: 'Read external session transcript after cursor',
    description: 'Read bounded transcript deltas after a cursor for an external provider session.',
    safety: 'safe',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_READ_AFTER,
      rpcMethodAliases: [RPC_METHODS.DAEMON_DIRECT_SESSION_TRANSCRIPT_READ_AFTER_LEGACY],
      sdkMethod: 'sessions.external.readAfterTranscript',
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'read',
    outputSchema: z.union([
      ExternalSessionTranscriptReadAfterResponseSchema,
      ExternalSessionTranscriptRefreshReadAfterResponseV1Schema,
    ]),
    inputSchema: z.union([
      ExternalSessionTranscriptReadAfterRequestSchema,
      ExternalSessionTranscriptRefreshReadAfterRequestV1Schema,
    ]),
    inputHints: {
      title: 'Read external session transcript after cursor',
      fields: [
        { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
        { path: 'providerId', title: 'Provider id', widget: 'text', required: true },
        { path: 'remoteSessionId', title: 'Remote session id', widget: 'text', required: true },
        { path: 'source', title: 'External source', widget: 'textarea', required: true },
        { path: 'cursor', title: 'Cursor', widget: 'text', required: true },
        { path: 'maxBytes', title: 'Maximum bytes', widget: 'text' },
        { path: 'maxItems', title: 'Maximum items', widget: 'text' },
      ],
    },
  },
  {
    id: 'sessions.external.takeover',
    title: 'Take over external session',
    description: 'Move a linked external session into a Happier-managed terminal runtime.',
    safety: 'danger',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_TAKEOVER,
      rpcMethodAliases: [
        RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_LEGACY,
        RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_PERSIST_LEGACY,
      ],
      sdkMethod: 'sessions.external.takeover.execute',
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'danger',
    outputSchema: ExternalSessionTakeoverResultV1Schema,
    inputSchema: ExternalSessionTakeoverActionInputSchema,
    inputHints: {
      title: 'Take over external session',
      fields: [
        { path: 'linkedSessionId', title: 'Linked session id', widget: 'text', required: true },
        { path: 'machineId', title: 'Machine id', widget: 'text' },
        { path: 'targetRuntimeMode', title: 'Target runtime mode', widget: 'select', required: true, options: [
          { value: 'terminal', label: 'Terminal' },
        ] },
        { path: 'storageMode', title: 'Storage mode', widget: 'select', required: true, options: [
          { value: 'external-linked', label: 'External linked' },
          { value: 'persisted', label: 'Persisted' },
        ] },
      ],
    },
  },
  {
    id: 'scm.pullRequest.list',
    title: 'List pull requests',
    description: 'List pull requests for the current source-control repository.',
    safety: 'safe',
    placements: [],
    bindings: {
      rpcMethod: 'scm.pullRequest.list',
      sdkMethod: 'scm.pullRequest.list',
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'read',
    outputSchema: ScmPullRequestListResponseSchema,
    inputSchema: ScmPullRequestListRequestSchema,
    inputHints: {
      title: 'List pull requests',
      fields: [
        { path: 'cwd', title: 'Repository directory', widget: 'text' },
        { path: 'providerId', title: 'Provider id', widget: 'text' },
        { path: 'base', title: 'Base branch', widget: 'text' },
        { path: 'head', title: 'Head branch', widget: 'text' },
        {
          path: 'state',
          title: 'State',
          widget: 'select',
          options: [
            { value: 'open', label: 'Open' },
            { value: 'closed', label: 'Closed' },
            { value: 'merged', label: 'Merged' },
            { value: 'draft', label: 'Draft' },
            { value: 'unknown', label: 'Unknown' },
          ],
        },
      ],
    },
  },
  {
    id: 'scm.pullRequest.get',
    title: 'Get pull request',
    description: 'Read one pull request by number, URL, or head branch.',
    safety: 'safe',
    placements: [],
    bindings: {
      rpcMethod: 'scm.pullRequest.get',
      sdkMethod: 'scm.pullRequest.get',
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'read',
    outputSchema: ScmPullRequestGetResponseSchema,
    inputSchema: ScmPullRequestGetRequestSchema,
    inputHints: {
      title: 'Get pull request',
      fields: [
        { path: 'cwd', title: 'Repository directory', widget: 'text' },
        { path: 'prReference.number', title: 'Pull request number', widget: 'text' },
        { path: 'prReference.url', title: 'Pull request URL', widget: 'text' },
        { path: 'prReference.headBranch', title: 'Head branch', widget: 'text' },
      ],
    },
  },
  {
    id: 'scm.pullRequest.openOrReuse',
    title: 'Open or reuse pull request',
    description: 'Create a pull request or return an existing one for the current branch.',
    safety: 'danger',
    placements: [],
    bindings: {
      rpcMethod: 'scm.pullRequest.openOrReuse',
      sdkMethod: 'scm.pullRequest.openOrReuse',
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'external',
    outputSchema: ScmPullRequestOpenOrReuseResponseSchema,
    inputSchema: ScmPullRequestOpenOrReuseRequestSchema,
    inputHints: {
      title: 'Open or reuse pull request',
      fields: [
        { path: 'cwd', title: 'Repository directory', widget: 'text' },
        { path: 'providerId', title: 'Provider id', widget: 'text' },
        { path: 'base', title: 'Base branch', widget: 'text', required: true },
        { path: 'head', title: 'Head branch', widget: 'text' },
        { path: 'title', title: 'Title', widget: 'text' },
        { path: 'body', title: 'Body', widget: 'textarea' },
      ],
    },
  },
  {
    id: 'scm.pullRequest.openCompose',
    title: 'Open pull-request compose URL',
    description: 'Build a provider-approved compose URL for the current branch.',
    safety: 'safe',
    placements: [],
    bindings: {
      rpcMethod: 'scm.pullRequest.openCompose',
      sdkMethod: 'scm.pullRequest.openCompose',
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'read',
    outputSchema: ScmPullRequestOpenComposeResponseSchema,
    inputSchema: ScmPullRequestOpenComposeRequestSchema,
    inputHints: {
      title: 'Open pull-request compose URL',
      fields: [
        { path: 'cwd', title: 'Repository directory', widget: 'text' },
        { path: 'providerId', title: 'Provider id', widget: 'text' },
        { path: 'base', title: 'Base branch', widget: 'text', required: true },
        { path: 'head', title: 'Head branch', widget: 'text', required: true },
      ],
    },
  },
  {
    id: 'scm.pullRequest.checkout',
    title: 'Check out pull request',
    description: 'Check out a pull request reference in the current repository.',
    safety: 'danger',
    placements: [],
    bindings: {
      rpcMethod: 'scm.pullRequest.checkout',
      sdkMethod: 'scm.pullRequest.checkout',
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'write',
    outputSchema: ScmPullRequestCheckoutResponseSchema,
    inputSchema: ScmPullRequestCheckoutRequestSchema,
    inputHints: {
      title: 'Check out pull request',
      fields: [
        { path: 'cwd', title: 'Repository directory', widget: 'text' },
        { path: 'prReference.number', title: 'Pull request number', widget: 'text' },
        { path: 'prReference.url', title: 'Pull request URL', widget: 'text' },
        { path: 'prReference.headBranch', title: 'Head branch', widget: 'text' },
      ],
    },
  },
  {
    id: 'scm.pullRequest.prepareWorktree',
    title: 'Prepare pull-request worktree',
    description: 'Prepare a local worktree for a pull request reference.',
    safety: 'danger',
    placements: [],
    bindings: {
      rpcMethod: 'scm.pullRequest.prepareWorktree',
      sdkMethod: 'scm.pullRequest.prepareWorktree',
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'write',
    outputSchema: ScmPullRequestPrepareWorktreeResponseSchema,
    inputSchema: ScmPullRequestPrepareWorktreeRequestSchema,
    inputHints: {
      title: 'Prepare pull-request worktree',
      fields: [
        { path: 'cwd', title: 'Repository directory', widget: 'text' },
        { path: 'sourcePath', title: 'Source path', widget: 'text', required: true },
        { path: 'prReference.number', title: 'Pull request number', widget: 'text' },
        { path: 'prReference.url', title: 'Pull request URL', widget: 'text' },
        { path: 'prReference.headBranch', title: 'Head branch', widget: 'text' },
        {
          path: 'mode',
          title: 'Mode',
          widget: 'select',
          options: [
            { value: 'local', label: 'Local checkout' },
            { value: 'worktree', label: 'Worktree' },
          ],
        },
      ],
    },
  },
  {
    id: 'scm.pullRequest.runStacked',
    title: 'Run stacked pull-request workflow',
    description: 'Run a structured branch, commit, push, and pull-request workflow.',
    safety: 'danger',
    placements: [],
    bindings: {
      rpcMethod: 'scm.pullRequest.runStacked',
      sdkMethod: 'scm.pullRequest.runStacked',
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'danger',
    outputSchema: ScmPullRequestRunStackedResponseSchema,
    inputSchema: ScmPullRequestRunStackedRequestSchema,
    inputHints: {
      title: 'Run stacked pull-request workflow',
      fields: [
        { path: 'cwd', title: 'Repository directory', widget: 'text' },
        {
          path: 'action',
          title: 'Action',
          widget: 'select',
          required: true,
          options: [
            { value: 'commit', label: 'Commit' },
            { value: 'push', label: 'Push' },
            { value: 'openOrReuse', label: 'Open or reuse pull request' },
            { value: 'commitAndPush', label: 'Commit and push' },
            { value: 'pushAndOpenOrReuse', label: 'Push and open or reuse pull request' },
            { value: 'commitPushAndOpenOrReuse', label: 'Commit, push, and open or reuse pull request' },
          ],
        },
        { path: 'commitMessage', title: 'Commit message', widget: 'textarea' },
        { path: 'featureBranch', title: 'Feature branch', widget: 'text' },
        { path: 'filePaths', title: 'File paths', widget: 'text_list', listSeparator: 'newline' },
        { path: 'base', title: 'Base branch', widget: 'text' },
        { path: 'head', title: 'Head branch', widget: 'text' },
        { path: 'title', title: 'Pull request title', widget: 'text' },
        { path: 'body', title: 'Pull request body', widget: 'textarea' },
        {
          path: 'defaultBranchPushPolicy',
          title: 'Default-branch push policy',
          widget: 'select',
          options: [
            { value: 'allow', label: 'Allow' },
            { value: 'requires-feature-branch', label: 'Require feature branch' },
            { value: 'deny', label: 'Deny' },
          ],
        },
      ],
    },
  },
  {
    id: 'scm.repository.clone',
    title: 'Clone source-control repository',
    description: 'Clone a hosting-provider repository into an explicitly selected local destination.',
    safety: 'danger',
    placements: [],
    bindings: {
      rpcMethod: 'scm.repository.clone',
      sdkMethod: 'scm.repository.clone',
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'external',
    outputSchema: ScmRepositoryCloneOutputSchema,
    inputSchema: ScmRepositoryCloneInputSchema,
    inputHints: {
      title: 'Clone source-control repository',
      fields: [
        { path: 'provider', title: 'Hosting provider (json)', widget: 'textarea', required: true },
        { path: 'repository', title: 'Repository (json)', widget: 'textarea', required: true },
        { path: 'destinationParentPath', title: 'Destination parent directory', widget: 'text', required: true },
        { path: 'destinationDirectoryName', title: 'Destination directory name', widget: 'text', required: true },
        {
          path: 'protocol',
          title: 'Clone protocol',
          widget: 'select',
          required: true,
          options: SourceControlCloneProtocolSchema.options.map((value: SourceControlCloneProtocol) => ({
            value,
            label: value.toUpperCase(),
          })),
        },
        { path: 'confirmed', title: 'Confirm repository clone', widget: 'boolean', required: true },
        { path: 'authorizationToken', title: 'Authorization token', widget: 'text', required: true },
      ],
    },
  },
  {
    id: 'scm.repository.init',
    title: 'Initialize source-control repository',
    description: 'Initialize source control for a directory through the SCM provisioning route.',
    safety: 'danger',
    placements: [],
    bindings: {
      rpcMethod: 'scm.repository.init',
      sdkMethod: 'scm.repository.init',
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'write',
    outputSchema: ScmRepositoryInitResponseSchema,
    inputSchema: ScmRepositoryInitRequestSchema,
    inputHints: {
      title: 'Initialize source-control repository',
      fields: [
        { path: 'cwd', title: 'Repository directory', widget: 'text', required: true },
        { path: 'initialBranch', title: 'Initial branch', widget: 'text' },
      ],
    },
  },
  {
    id: 'scm.repository.removeIndexLock',
    title: 'Remove stale source-control index lock',
    description: 'Remove a confirmed stale Git index lock using backend-owned path resolution.',
    safety: 'danger',
    placements: [],
    bindings: {
      rpcMethod: 'scm.repository.removeIndexLock',
      sdkMethod: 'scm.repository.removeIndexLock',
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'danger',
    outputSchema: ScmRepositoryRemoveIndexLockResponseSchema,
    inputSchema: ScmRepositoryRemoveIndexLockRequestSchema,
    inputHints: {
      title: 'Remove stale source-control index lock',
      fields: [
        { path: 'cwd', title: 'Repository directory', widget: 'text', required: true },
        { path: 'confirmed', title: 'Confirm stale index-lock removal', widget: 'boolean', required: true },
        { path: 'confirmationToken', title: 'Confirmation token', widget: 'text', required: true },
      ],
    },
  },
  {
    id: 'scm.hostingRepository.describePublishTargets',
    title: 'Describe hosting repository publish targets',
    description: 'Describe authenticated hosting-provider targets that can receive a repository publish.',
    safety: 'safe',
    placements: [],
    bindings: {
      rpcMethod: 'scm.hostingRepository.describePublishTargets',
      sdkMethod: 'scm.hostingRepository.describePublishTargets',
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'read',
    outputSchema: ScmHostingRepositoryDescribePublishTargetsResponseSchema,
    inputSchema: ScmHostingRepositoryDescribePublishTargetsRequestSchema,
    inputHints: {
      title: 'Describe hosting repository publish targets',
      fields: [
        { path: 'cwd', title: 'Repository directory', widget: 'text', required: true },
        {
          path: 'providerKind',
          title: 'Hosting provider',
          widget: 'select',
          options: [
            { value: 'github', label: 'GitHub' },
            { value: 'gitlab', label: 'GitLab' },
            { value: 'bitbucket', label: 'Bitbucket' },
            { value: 'custom', label: 'Custom' },
            { value: 'unknown', label: 'Unknown' },
          ],
        },
      ],
    },
  },
  {
    id: 'scm.hostingRepository.publish',
    title: 'Publish repository to hosting provider',
    description: 'Create or bind a hosting repository and publish the active source-control state.',
    safety: 'danger',
    placements: [],
    bindings: {
      rpcMethod: 'scm.hostingRepository.publish',
      sdkMethod: 'scm.hostingRepository.publish',
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'external',
    outputSchema: ScmHostingRepositoryPublishResponseSchema,
    inputSchema: ScmHostingRepositoryPublishRequestSchema,
    inputHints: {
      title: 'Publish repository to hosting provider',
      fields: [
        { path: 'cwd', title: 'Repository directory', widget: 'text', required: true },
        {
          path: 'providerKind',
          title: 'Hosting provider',
          widget: 'select',
          required: true,
          options: [
            { value: 'github', label: 'GitHub' },
            { value: 'gitlab', label: 'GitLab' },
            { value: 'bitbucket', label: 'Bitbucket' },
            { value: 'custom', label: 'Custom' },
            { value: 'unknown', label: 'Unknown' },
          ],
        },
        { path: 'owner', title: 'Owner', widget: 'text', required: true },
        {
          path: 'ownerKind',
          title: 'Owner kind',
          widget: 'select',
          options: [
            { value: 'user', label: 'User' },
            { value: 'org', label: 'Organization' },
          ],
        },
        { path: 'repositoryName', title: 'Repository name', widget: 'text', required: true },
        {
          path: 'visibility',
          title: 'Visibility',
          widget: 'select',
          required: true,
          options: [
            { value: 'private', label: 'Private' },
            { value: 'public', label: 'Public' },
            { value: 'internal', label: 'Internal' },
          ],
        },
        { path: 'description', title: 'Description', widget: 'textarea' },
        { path: 'remoteName', title: 'Remote name', widget: 'text' },
        {
          path: 'remoteUrlKind',
          title: 'Remote URL kind',
          widget: 'select',
          options: [
            { value: 'https', label: 'HTTPS' },
            { value: 'ssh', label: 'SSH' },
          ],
        },
        {
          path: 'remoteConflictStrategy',
          title: 'Remote conflict strategy',
          widget: 'select',
          options: [
            { value: 'fail', label: 'Fail' },
            { value: 'set-url', label: 'Set URL' },
          ],
        },
        { path: 'pushCurrentBranch', title: 'Push current branch', widget: 'boolean' },
      ],
    },
  },
  {
    id: 'scm.diffSummary.generate',
    title: 'Generate source-control diff summary',
    description: 'Generate a buffered AI summary for checkpoint-backed or working-tree source-control changes.',
    safety: 'safe',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.SCM_DIFF_SUMMARY_GENERATE,
      sdkMethod: 'scm.diffSummary.generate',
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'external',
    outputSchema: ScmDiffSummaryGenerateOutputSchema,
    inputSchema: ScmDiffSummaryGenerateInputSchema,
    inputHints: {
      title: 'Generate diff summary',
      description: 'Summaries for turn checkpoints must resolve CHKPT-2 TurnChangeSet evidence by turn id or checkpoint receipt.',
      fields: [
        { path: 'cwd', title: 'Repository directory', widget: 'text', required: true },
        {
          path: 'source.kind',
          title: 'Summary source',
          widget: 'select',
          required: true,
          options: [
            { value: 'turnCheckpoint', label: 'Turn checkpoint' },
            { value: 'workingTree', label: 'Working tree' },
          ],
        },
        { path: 'turnId', title: 'Turn id', widget: 'text' },
        { path: 'checkpointReceiptId', title: 'Checkpoint receipt id', widget: 'text' },
        { path: 'modelSelector.profileId', title: 'Model profile id', widget: 'text' },
        { path: 'modelSelector.modelId', title: 'Model id', widget: 'text' },
        { path: 'modelSelector.backendTargetKey', title: 'Backend target key', widget: 'text' },
      ],
    },
  },
] as const));

/**
 * The only host Actions that are not genuine user operations. Each entry is
 * deliberately small and names the existing owner that keeps the operation
 * private; every other host Action is public on the `api` and trusted-plugin
 * projections by default.
 */
export const INTERNAL_ACTION_REASONS = Object.freeze({
  'session.handoff.prepare_target': 'Private handoff lifecycle preparation phase; users invoke session.handoff instead.',
  'session.handoff.prepare_target.resume': 'Private handoff lifecycle retry phase; users invoke session.handoff instead.',
  'session.handoff.prepare_target_result.get': 'Private handoff coordination receipt read; session.handoff.status.get is the user projection.',
  'session.handoff.commit': 'Private handoff lifecycle commit phase; users invoke session.handoff instead.',
  'session.handoff.abort': 'Private handoff lifecycle abort phase; users invoke session.handoff instead.',
  'sessions.subagents.upsert': 'Host lifecycle projection maintenance; user operations use the planning/delegation Actions.',
  'sessions.subagents.updateStatus': 'Host lifecycle projection maintenance; user operations use the planning/delegation Actions.',
  'sessions.subagents.complete': 'Host lifecycle projection maintenance; user operations use the planning/delegation Actions.',
  'sessions.external.takeover': 'Released direct-session compatibility stub; current clients use sessions.external.takeover.start.',
  'plugin.webhook.delivery.movePending': 'Private webhook delivery plumbing owned by the webhook worker.',
  'browser.session.create': 'No browser session creator is wired through the ActionExecutor; the runtime owner keeps this fail-closed.',
  'browser.session.close': 'No browser session closer is wired through the ActionExecutor; the runtime owner keeps this fail-closed.',
  'devices.simulator.input.orientation': 'Stock scrcpy has no absolute-orientation producer; the simulator backing owner marks this Action statically unbacked.',
} as const satisfies Readonly<Partial<Record<ActionId, string>>>);

export type InternalActionId = keyof typeof INTERNAL_ACTION_REASONS;

export const INTERNAL_ACTION_IDS = Object.freeze(
  Object.keys(INTERNAL_ACTION_REASONS) as InternalActionId[],
);

const INTERNAL_ACTION_ID_SET = new Set<ActionId>(INTERNAL_ACTION_IDS);

export function isInternalActionId(actionId: string): actionId is InternalActionId {
  return INTERNAL_ACTION_ID_SET.has(actionId as ActionId);
}

/**
 * These are plugin protocol operations, not user-selected API operations: the
 * canonical input intentionally omits the plugin identity and the existing
 * owner derives it from host-stamped plugin provenance. A PAT must never
 * manufacture that omitted identity, so these remain plugin-only until an
 * owner-local user contract exists.
 */
export const PLUGIN_PROVENANCE_ONLY_API_EXCLUSION_REASONS = Object.freeze({
  'automation.event.sources.list': 'Automation source identity is selected from the host-stamped plugin caller.',
  'automation.event.admit': 'Automation event admission persists the host-stamped plugin source identity.',
  'automation.event.source.status.report': 'Automation source status is attributed to the host-stamped plugin caller.',
  'automation.conversation.targets.list': 'Automation conversation targets are selected from the host-stamped plugin caller.',
  'automation.conversation.target.verify': 'Automation conversation target verification requires host-stamped plugin provenance.',
  'automation.conversation.admit': 'Automation conversation admission persists host-stamped plugin provenance.',
  'session.permission.remote.pending.list': 'The remote-permission mediator identity comes only from the host-stamped plugin caller.',
  'session.permission.remote.respond': 'The remote-permission mediator identity comes only from the host-stamped plugin caller.',
  'plugins.permissions.grants.revoke': 'Plugin self-revocation resolves the grant owner from the host-stamped plugin caller.',
  'sessions.external.materialize.start': 'External-session materialization persists plugin-authored intent from the host-stamped caller.',
} as const satisfies Readonly<Partial<Record<ActionId, string>>>);

export type PluginProvenanceOnlyActionId = keyof typeof PLUGIN_PROVENANCE_ONLY_API_EXCLUSION_REASONS;
export type PublicActionId = Exclude<ActionId, InternalActionId | PluginProvenanceOnlyActionId>;

export const PLUGIN_PROVENANCE_ONLY_API_EXCLUSION_ACTION_IDS = Object.freeze(
  Object.keys(PLUGIN_PROVENANCE_ONLY_API_EXCLUSION_REASONS) as PluginProvenanceOnlyActionId[],
);

const PLUGIN_PROVENANCE_ONLY_API_EXCLUSION_ACTION_ID_SET = new Set<ActionId>(
  PLUGIN_PROVENANCE_ONLY_API_EXCLUSION_ACTION_IDS,
);

export function isPluginProvenanceOnlyActionId(actionId: string): actionId is PluginProvenanceOnlyActionId {
  return PLUGIN_PROVENANCE_ONLY_API_EXCLUSION_ACTION_ID_SET.has(actionId as ActionId);
}

/**
 * The mirror of `PLUGIN_PROVENANCE_ONLY_API_EXCLUSION_REASONS` and the only
 * owner of "this Action has no trusted-plugin projection at all". Publishing
 * an Action here that no plugin caller can ever reach would type an author
 * call the executor can only reject, so each entry names why the plugin arm
 * cannot exist. Extend this map rather than adding a second plugin-surface
 * decision-maker.
 *
 * Present-user Actions remain discoverable to trusted plugins. The canonical
 * executor, not this projection, rejects account-automation callers with a
 * typed `present_user_required` result.
 *
 * The External Session rows are host-scoped rather than present-user: their
 * canonical owner selects machine, source, link and contribution-generation
 * authority from host transport context, which the public contextual
 * `SessionsService.external` service deliberately hides. That service — not
 * the raw Action — is the author capability, and the Action executor already
 * serves these only for a host caller.
 */
export const PLUGIN_SURFACE_EXCLUSION_REASONS = Object.freeze({
  'sessions.external.candidates.list': 'Machine/source-scoped discovery seam; authors use SessionsService.external.list, which delegates to this same candidate-query owner.',
  'sessions.external.link.ensure': 'Machine/source-scoped linking seam; authors use SessionsService.external.attach, which delegates to this same idempotent link operation.',
  'sessions.external.transcript.page': 'Machine/source-scoped transcript seam; authors use SessionsService.external.readTranscript.',
  'sessions.external.transcript.readAfter': 'Machine/source-scoped transcript seam; authors use SessionsService.external.readTranscript.',
  'sessions.external.takeover.start': 'Raw durable takeover Start; SessionsService.external.takeover privately delegates to it and is the documented author workflow.',
} as const satisfies Readonly<Partial<Record<ActionId, string>>>);

export type PluginSurfaceExcludedActionId =
  keyof typeof PLUGIN_SURFACE_EXCLUSION_REASONS;

export const PLUGIN_SURFACE_EXCLUSION_ACTION_IDS = Object.freeze(
  Object.keys(PLUGIN_SURFACE_EXCLUSION_REASONS) as PluginSurfaceExcludedActionId[],
);

const PLUGIN_SURFACE_EXCLUSION_ACTION_ID_SET = new Set<ActionId>(
  PLUGIN_SURFACE_EXCLUSION_ACTION_IDS,
);

export function isPluginSurfaceExcludedActionId(
  actionId: string,
): actionId is PluginSurfaceExcludedActionId {
  return PLUGIN_SURFACE_EXCLUSION_ACTION_ID_SET.has(actionId as ActionId);
}

const PRESENT_USER_REQUIRED_ACTION_IDS = new Set<ActionId>([
  'approval.request.decide',
  'session.permission.respond',
  'account.plugins.data.erase',
  'account.sessions.signOutEverywhere',
  'account.apiTokens.create',
  'account.apiTokens.revoke',
  'account.apiTokens.revokeAll',
  'plugins.settings.secret.bind',
  'plugins.settings.secret.unbind',
  'plugins.settings.secret.delete',
  'plugins.install',
  'plugins.dev',
  'plugins.author.install',
  'plugins.permissions.grants.grant',
  'plugins.permissions.grants.dismissRequest',
  ...(Object.keys(PluginWebhookActionHttpPathsV1) as PluginWebhookPresentUserActionIdV1[]),
]);

/**
 * External ingress routes from this registry fact. These groups are by the
 * current execution owner, not by Action-id prefix: each exceptional
 * bootstrap/client/session case is named below so a new Action cannot silently
 * inherit a machine route merely because it was added to a neighboring family.
 */
const RUNTIME_ACTION_IDS_WITHOUT_MACHINE_PLACEMENT = new Set<RuntimeActionIdV1>([
  // These are intentionally host-internal/fail-closed, so client placement is
  // retained only to keep the registry total while no external owner exists.
  'browser.session.create',
  'browser.session.close',
  'devices.simulator.input.orientation',
  // Composer attachment is a Session-media operation, not a machine command.
  'browser.recording.attachToComposer',
]);

const ACTION_EXECUTION_PLACEMENT_BY_ID: ReadonlyMap<ActionId, ActionExecutionPlacement> = (() => {
  const placements = new Map<ActionId, ActionExecutionPlacement>();
  const register = (placement: ActionExecutionPlacement, actionIds: readonly ActionId[]) => {
    for (const actionId of actionIds) {
      if (placements.has(actionId)) {
        throw new Error(`Action ${actionId} has more than one execution placement`);
      }
      placements.set(actionId, placement);
    }
  };

  // Account/server data can run before an exact machine is known.
  register('account', [
    'action.spec.search',
    'action.spec.get',
    'machines.list',
    'session.list',
    'prompt_doc.update',
    'prompt_bundle.update',
    ...ACTION_ID_FAMILIES_V1.approvals,
    ...ACTION_ID_FAMILIES_V1.plugin_permission_grants,
    ...ACTION_ID_FAMILIES_V1.plugin_webhooks,
    ...ACTION_ID_FAMILIES_V1.account_plugin_data,
    ...ACTION_ID_FAMILIES_V1.account_sessions,
    ...ACTION_ID_FAMILIES_V1.account_api_tokens,
    ...ACTION_ID_FAMILIES_V1.automation_events,
    ...ACTION_ID_FAMILIES_V1.automation_conversation,
  ]);

  // These actions require a present client/runtime and are deliberately not
  // forwarded by the public API, even when their input happens to name a Session.
  register('client', [
    'servers.list',
    'session.target.primary.set',
    'session.target.tracked.set',
    'browser.session.create',
    'browser.session.close',
    'devices.simulator.input.orientation',
    ...ACTION_ID_FAMILIES_V1.voice_controls,
    ...ACTION_ID_FAMILIES_V1.current_ui_context,
    ...ACTION_ID_FAMILIES_V1.companion_controls,
  ]);

  // A canonical Session resolves its current machine/daemon owner. Execution
  // runs are intentionally absent: detached runs have no Session owner.
  register('session', [
    ...ACTION_ID_FAMILIES_V1.session_lifecycle.filter((actionId) => actionId !== 'session.spawn_new'),
    'review.engines.list',
    ...ACTION_ID_FAMILIES_V1.messaging,
    ...ACTION_ID_FAMILIES_V1.session_control,
    ...ACTION_ID_FAMILIES_V1.intent_start,
    ...ACTION_ID_FAMILIES_V1.review_comments,
    ...ACTION_ID_FAMILIES_V1.subagent_registry,
    'session.activity.get',
    'session.messages.recent.get',
    ...ACTION_ID_FAMILIES_V1.session_transcripts,
    ...ACTION_ID_FAMILIES_V1.session_permissions,
    'browser.recording.attachToComposer',
    'sessions.external.follow',
    'sessions.external.unfollow',
    'sessions.external.backgroundFollow.set',
    'sessions.external.status.get',
    'sessions.external.transcript.page',
    'sessions.external.transcript.readAfter',
  ]);

  // The remaining operations are daemon/machine-owned. This includes detached
  // execution runs, local indexes/filesystem/plugin/scm owners, and external
  // session operations whose request selects a concrete daemon runtime.
  register('machine', [
    'action.options.resolve',
    'action.invoke',
    'session.spawn_new',
    'paths.list_recent',
    'agents.backends.list',
    'agents.models.list',
    'agents.config_options.list',
    'agents.session_modes.list',
    'sessions.spawn.profiles.list',
    'sessions.spawn.connected_services.list',
    'sessions.spawn.mcp_servers.preview',
    ...ACTION_ID_FAMILIES_V1.execution_run_control,
    ...ACTION_ID_FAMILIES_V1.memory,
    'prompt_asset.export',
    'prompt_registry.install',
    ...ACTION_ID_FAMILIES_V1.daemon_admin,
    ...ACTION_ID_FAMILIES_V1.plugin_dev_loop,
    ...ACTION_ID_FAMILIES_V1.plugin_settings_administration,
    'sessions.external.candidates.list',
    'sessions.external.link.ensure',
    'sessions.external.takeover',
    'sessions.external.materialize.start',
    'sessions.external.takeover.start',
    'sessions.external.operation.status.get',
    'sessions.external.operation.cancel',
    'sessions.external.operation.resume',
    'sessions.external.operation.retry',
    'sessions.external.operation.discard',
    ...ACTION_ID_FAMILIES_V1.scm_pull_request,
    ...ACTION_ID_FAMILIES_V1.scm_repository,
    ...ACTION_ID_FAMILIES_V1.scm_diff_summary,
    ...RUNTIME_ACTION_IDS_V1.filter(
      (actionId) => !RUNTIME_ACTION_IDS_WITHOUT_MACHINE_PLACEMENT.has(actionId),
    ),
  ]);

  const missing = ACTION_IDS.filter((actionId) => !placements.has(actionId));
  if (missing.length > 0) {
    throw new Error(`Action execution placement missing for: ${missing.join(', ')}`);
  }
  return placements;
})();

function resolveActionRequiredAuthority(
  spec: Pick<PreNormalizedActionSpec, 'id' | 'requiredAuthority'>,
): ActionRequiredAuthority {
  return spec.requiredAuthority
    ?? (PRESENT_USER_REQUIRED_ACTION_IDS.has(spec.id) ? 'present_user' : 'account_automation');
}

function resolveActionExecutionPlacement(
  spec: Pick<PreNormalizedActionSpec, 'id' | 'executionPlacement'>,
): ActionExecutionPlacement {
  if (spec.executionPlacement) return spec.executionPlacement;
  const placement = ACTION_EXECUTION_PLACEMENT_BY_ID.get(spec.id);
  if (!placement) {
    throw new Error(`Action execution placement missing for: ${spec.id}`);
  }
  return placement;
}

function normalizeActionPublicExposure(spec: PreNormalizedActionSpec): NormalizedActionSpec {
  const isInternal = isInternalActionId(spec.id);
  const isPluginProvenanceOnly = isPluginProvenanceOnlyActionId(spec.id);
  const isPluginSurfaceExcluded = isPluginSurfaceExcludedActionId(spec.id);
  return {
    ...spec,
    requiredAuthority: resolveActionRequiredAuthority(spec),
    executionPlacement: resolveActionExecutionPlacement(spec),
    surfaces: {
      ...spec.surfaces,
      api: !isInternal && !isPluginProvenanceOnly,
      plugin: !isInternal && !isPluginSurfaceExcluded,
    },
  };
}

const ACTION_SPECS_WITH_PUBLIC_EXPOSURE = Object.freeze(
  ACTION_SPECS_WITHOUT_APPROVAL.map(normalizeActionPublicExposure),
);

/**
 * The generated-family builders above return a broad registry row at runtime.
 * Keep their concrete Zod carriers in this one type-only projection so the
 * public API and Plugin maps remain derived from the same Action ids instead
 * of retaining a second, surface-specific allowlist. Array map cannot retain
 * the correlation between a runtime/generated family id and its indexed schema
 * after the value registry is assembled; changing every builder to a
 * tuple-aware generic would duplicate that machinery across eight existing
 * family owners. This projection therefore reads only their existing schema
 * maps and is constrained below to exact registry-id and runtime-schema
 * equality. It never decides an Action's runtime behavior, exposure,
 * authority, placement, or policy.
 */
type CanonicalActionSchemaDefinition<
  TActionId extends ActionId,
  TInputSchema extends z.ZodTypeAny,
  TOutputSchema extends z.ZodTypeAny,
  TSurfaceBindings = never,
> = Readonly<{
  id: TActionId;
  inputSchema: TInputSchema;
  outputSchema: TOutputSchema;
  surfaceBindings?: TSurfaceBindings;
}>;

type LiteralActionSpecDefinition<TSpec> = TSpec extends Readonly<{
  id: infer TActionId;
}>
  ? ActionId extends TActionId
    ? never
    : TSpec
  : never;

type DirectActionSpecDefinition = LiteralActionSpecDefinition<
  (typeof ACTION_SPECS_WITHOUT_APPROVAL)[number]
>;

type NonRuntimeActionSpecDefinition<TSpec> = TSpec extends Readonly<{
  id: infer TActionId;
}>
  ? TActionId extends RuntimeActionIdV1
    ? never
    : TSpec
  : never;

type NonRuntimeDirectActionSpecDefinition = NonRuntimeActionSpecDefinition<
  DirectActionSpecDefinition
>;

type RuntimeActionSpecDefinition = {
  [TActionId in RuntimeActionIdV1]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof RUNTIME_ACTION_INPUT_SCHEMAS)[TActionId],
    (typeof RUNTIME_ACTION_OUTPUT_SCHEMAS)[TActionId]
  >;
}[RuntimeActionIdV1];

type PluginDevLoopActionSpecDefinition = {
  [TActionId in PluginDevLoopActionIdV1]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof PluginDevLoopActionInputSchemas)[TActionId],
    typeof PluginDevLoopActionOutputSchema
  >;
}[PluginDevLoopActionIdV1];

type PluginSettingsAdministrationActionSpecDefinition = {
  [TActionId in PluginSettingsAdministrationActionIdV1]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof PluginSettingsAdministrationActionInputSchemasV1)[TActionId],
    typeof PluginSettingsAdministrationActionOutputV1Schema
  >;
}[PluginSettingsAdministrationActionIdV1];

type PluginPermissionGrantPluginBoundActionId = keyof typeof PLUGIN_PERMISSION_GRANT_PLUGIN_INPUT_SCHEMAS;
type PluginPermissionGrantPluginBoundActionSpecDefinition = {
  [TActionId in PluginPermissionGrantPluginBoundActionId]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof PluginPermissionGrantActionInputSchemasV1)[TActionId],
    (typeof PluginPermissionGrantActionOutputSchemasV1)[TActionId],
    Readonly<{
      plugin: Readonly<{
        inputSchema: (typeof PLUGIN_PERMISSION_GRANT_PLUGIN_INPUT_SCHEMAS)[TActionId];
      }>;
    }>
  >;
}[PluginPermissionGrantPluginBoundActionId];
type PluginPermissionGrantUnboundActionId = Exclude<
  PluginPermissionGrantActionIdV1,
  PluginPermissionGrantPluginBoundActionId
>;
type PluginPermissionGrantUnboundActionSpecDefinition = {
  [TActionId in PluginPermissionGrantUnboundActionId]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof PluginPermissionGrantActionInputSchemasV1)[TActionId],
    (typeof PluginPermissionGrantActionOutputSchemasV1)[TActionId]
  >;
}[PluginPermissionGrantUnboundActionId];
type PluginPermissionGrantActionSpecDefinition =
  | PluginPermissionGrantPluginBoundActionSpecDefinition
  | PluginPermissionGrantUnboundActionSpecDefinition;

type PluginReviewCommentActionSpecDefinition = {
  [TActionId in ReviewCommentActionIdV1]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof ReviewCommentActionInputSchemasV1)[TActionId],
    (typeof ReviewCommentActionOutputSchemasV1)[TActionId]
  >;
}[ReviewCommentActionIdV1];

type PluginWebhookActionSpecDefinition = {
  [TActionId in PluginWebhookActionIdV1]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof PluginWebhookActionInputSchemasV1)[TActionId],
    (typeof PluginWebhookActionOutputSchemasV1)[TActionId]
  >;
}[PluginWebhookActionIdV1];

type PluginAutomationEventActionSpecDefinition = {
  [TActionId in AutomationEventActionIdV1]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof AutomationEventActionInputSchemasV1)[TActionId],
    (typeof AutomationEventActionOutputSchemasV1)[TActionId]
  >;
}[AutomationEventActionIdV1];

type PluginAutomationConversationActionSpecDefinition = {
  [TActionId in AutomationConversationActionIdV1]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof AutomationConversationActionInputSchemasV1)[TActionId],
    (typeof AutomationConversationActionOutputSchemasV1)[TActionId]
  >;
}[AutomationConversationActionIdV1];

export type CanonicalActionSpecDefinition =
  | NonRuntimeDirectActionSpecDefinition
  | RuntimeActionSpecDefinition
  | PluginDevLoopActionSpecDefinition
  | PluginSettingsAdministrationActionSpecDefinition
  | PluginPermissionGrantActionSpecDefinition
  | PluginReviewCommentActionSpecDefinition
  | PluginWebhookActionSpecDefinition
  | PluginAutomationEventActionSpecDefinition
  | PluginAutomationConversationActionSpecDefinition;

export type PluginInvocableActionId = Exclude<
  ActionId,
  InternalActionId | PluginSurfaceExcludedActionId
>;
export type PluginInvocableActionSpecDefinition = {
  [TActionId in PluginInvocableActionId]: Extract<
    CanonicalActionSpecDefinition,
    Readonly<{ id: TActionId }>
  >;
}[PluginInvocableActionId];

type PluginActionSpecForId<TActionId extends PluginInvocableActionId> = Extract<
  PluginInvocableActionSpecDefinition,
  Readonly<{ id: TActionId }>
>;

export type PluginActionInputById = Readonly<{
  [TActionId in PluginInvocableActionId]: PluginActionSpecForId<TActionId> extends Readonly<{
    surfaceBindings: Readonly<{ plugin: Readonly<{ inputSchema: infer TInputSchema extends z.ZodTypeAny }> }>;
  }>
    ? z.input<TInputSchema>
    : z.input<PluginActionSpecForId<TActionId>['inputSchema']>;
}>;

export type PluginActionResultById = Readonly<{
  [TActionId in PluginInvocableActionId]: PluginActionSpecForId<TActionId> extends Readonly<{
    surfaceBindings: Readonly<{ plugin: Readonly<{ outputSchema: infer TOutputSchema extends z.ZodTypeAny }> }>;
  }>
    ? z.output<TOutputSchema>
    : PluginActionSpecForId<TActionId> extends Readonly<{
      outputSchema: infer TOutputSchema extends z.ZodTypeAny;
  }>
      ? z.output<TOutputSchema>
      : never;
}>;

type PluginActionInputSchemaById = Readonly<{
  [TActionId in PluginInvocableActionId]: PluginActionSpecForId<TActionId> extends Readonly<{
    surfaceBindings: Readonly<{ plugin: Readonly<{ inputSchema: infer TInputSchema extends z.ZodTypeAny }> }>;
  }>
    ? TInputSchema
    : PluginActionSpecForId<TActionId>['inputSchema'];
}>;

type PluginActionOutputSchemaById = Readonly<{
  [TActionId in PluginInvocableActionId]: PluginActionSpecForId<TActionId> extends Readonly<{
    surfaceBindings: Readonly<{ plugin: Readonly<{ outputSchema: infer TOutputSchema extends z.ZodTypeAny }> }>;
  }>
    ? TOutputSchema
    : PluginActionSpecForId<TActionId> extends Readonly<{
      outputSchema: infer TOutputSchema extends z.ZodTypeAny;
    }>
      ? TOutputSchema
      : never;
}>;

type IsUnknown<T> = unknown extends T
  ? ([keyof T] extends [never] ? true : false)
  : false;

type IsNever<T> = [T] extends [never] ? true : false;

type UnknownPluginActionInputId = {
  [TActionId in PluginInvocableActionId]: IsUnknown<PluginActionInputById[TActionId]> extends true
    ? TActionId
    : never;
}[PluginInvocableActionId];

type UnknownPluginActionResultId = {
  [TActionId in PluginInvocableActionId]: IsUnknown<PluginActionResultById[TActionId]> extends true
    ? TActionId
    : never;
}[PluginInvocableActionId];

type NeverPluginActionInputId = {
  [TActionId in PluginInvocableActionId]: IsNever<PluginActionInputById[TActionId]> extends true
    ? TActionId
    : never;
}[PluginInvocableActionId];

type NeverPluginActionResultId = {
  [TActionId in PluginInvocableActionId]: IsNever<PluginActionResultById[TActionId]> extends true
    ? TActionId
    : never;
}[PluginInvocableActionId];

type AssertNever<T extends never> = T;
type AssertTrue<T extends true> = T;
type IsTypeEqual<TLeft, TRight> = (
  <T>() => T extends TLeft ? 1 : 2
) extends (
  <T>() => T extends TRight ? 1 : 2
) ? true : false;

// The type-only generated-family projection must cover the runtime registry
// exactly. Otherwise a newly public Action could silently become `never` in
// the SDK maps even while the runtime array contains it.
type CanonicalActionIdsMustCoverRegistry = AssertTrue<IsTypeEqual<
  CanonicalActionSpecDefinition['id'],
  ActionId
>>;
type CanonicalRuntimeActionInputSchemas = Readonly<{
  [TActionId in RuntimeActionIdV1]: Extract<
    CanonicalActionSpecDefinition,
    Readonly<{ id: TActionId }>
  >['inputSchema'];
}>;
type CanonicalRuntimeActionOutputSchemas = Readonly<{
  [TActionId in RuntimeActionIdV1]: Extract<
    CanonicalActionSpecDefinition,
    Readonly<{ id: TActionId }>
  >['outputSchema'];
}>;
type CanonicalRuntimeActionInputsMustMatchSchemaOwner = AssertTrue<IsTypeEqual<
  CanonicalRuntimeActionInputSchemas,
  typeof RUNTIME_ACTION_INPUT_SCHEMAS
>>;
type CanonicalRuntimeActionOutputsMustMatchSchemaOwner = AssertTrue<IsTypeEqual<
  CanonicalRuntimeActionOutputSchemas,
  typeof RUNTIME_ACTION_OUTPUT_SCHEMAS
>>;

// Plugin-visible author and result carriers are generated from the canonical ActionSpec rows.
// Keep this invariant in the production compilation lane so adding a plugin-backed `z.unknown()`
// or an untyped preprocess schema cannot silently widen the public SDK map.
type PluginActionInputsMustRemainExact = AssertNever<UnknownPluginActionInputId>;
type PluginActionResultsMustRemainExact = AssertNever<UnknownPluginActionResultId>;
type PluginActionInputsMustRemainPresent = AssertNever<NeverPluginActionInputId>;
type PluginActionResultsMustRemainPresent = AssertNever<NeverPluginActionResultId>;
type PluginSessionTranscriptInputMustRemainExternalShareable = AssertTrue<IsTypeEqual<
  PluginActionInputById['session.transcript.get'],
  SessionTranscriptGetExternalShareableInputV1
>>;
type PluginSessionMessageInputMustRemainAdmissionOnly = AssertTrue<IsTypeEqual<
  PluginActionInputById['session.message.send'],
  z.input<typeof SessionSendMessagePluginInputV1Schema>
>>;
type PluginSessionTranscriptResultMustRemainExternalShareable = AssertTrue<IsTypeEqual<
  PluginActionResultById['session.transcript.get'],
  SessionTranscriptGetExternalShareableResultV1
>>;
type PluginRawSessionReadersMustRemainAvailable = AssertTrue<IsTypeEqual<
  Extract<
    PluginInvocableActionId,
    'session.history.get' | 'session.events.get' | 'session.messages.recent.get'
  >,
  'session.history.get' | 'session.events.get' | 'session.messages.recent.get'
>>;

const PLUGIN_INVOCABLE_ACTION_SPECS = ACTION_SPECS_WITH_PUBLIC_EXPOSURE.filter(
  (spec): spec is ActionSpecWithoutApproval & Readonly<{
    surfaces: ActionSpecWithoutApproval['surfaces'] & Readonly<{ plugin: true }>;
    outputSchema: z.ZodTypeAny;
  }> => (
    spec.surfaces.plugin === true && spec.outputSchema !== undefined
  ),
);

/** Runtime companion generated from the same canonical rows as the author type maps. */
export const PLUGIN_INVOCABLE_ACTION_IDS = Object.freeze(
  PLUGIN_INVOCABLE_ACTION_SPECS.map((spec) => spec.id),
) as readonly PluginInvocableActionId[];

const PLUGIN_INVOCABLE_ACTION_ID_SET = new Set<string>(PLUGIN_INVOCABLE_ACTION_IDS);

/** Runtime parser for the ActionSpec rows explicitly surfaced to Plugin authors. */
export const PluginInvocableActionIdSchema = z.custom<PluginInvocableActionId>(
  (actionId) => typeof actionId === 'string' && PLUGIN_INVOCABLE_ACTION_ID_SET.has(actionId),
  { message: 'Action is not available on the Plugin surface' },
);

function projectPluginActionInputSchemas(
  specs: readonly ActionSpecWithoutApproval[],
): PluginActionInputSchemaById;
function projectPluginActionInputSchemas(
  specs: readonly ActionSpecWithoutApproval[],
): object {
  return Object.freeze(Object.fromEntries(
    specs.map((spec) => {
    const surfaceBindings = 'surfaceBindings' in spec
      ? spec.surfaceBindings
      : undefined;
    const pluginBinding = surfaceBindings && 'plugin' in surfaceBindings
      ? surfaceBindings.plugin
      : undefined;
    return [spec.id, pluginBinding?.inputSchema ?? spec.inputSchema];
    }),
  ));
}

function projectPluginActionOutputSchemas(
  specs: readonly ActionSpecWithoutApproval[],
): PluginActionOutputSchemaById;
function projectPluginActionOutputSchemas(
  specs: readonly ActionSpecWithoutApproval[],
): object {
  return Object.freeze(Object.fromEntries(
    specs.map((spec) => {
      const surfaceBindings = 'surfaceBindings' in spec
        ? spec.surfaceBindings
        : undefined;
      const pluginBinding = surfaceBindings && 'plugin' in surfaceBindings
        ? surfaceBindings.plugin
        : undefined;
      const pluginOutputSchema = pluginBinding && 'outputSchema' in pluginBinding
        ? pluginBinding.outputSchema
        : undefined;
      return [spec.id, pluginOutputSchema ?? spec.outputSchema];
    }),
  ));
}

export const PLUGIN_ACTION_INPUT_SCHEMAS: PluginActionInputSchemaById = projectPluginActionInputSchemas(
  PLUGIN_INVOCABLE_ACTION_SPECS,
);

export const PLUGIN_ACTION_OUTPUT_SCHEMAS: PluginActionOutputSchemaById = projectPluginActionOutputSchemas(
  PLUGIN_INVOCABLE_ACTION_SPECS,
);

type PluginActionInputByRuntimeSchemaMap = Readonly<{
  [TActionId in keyof typeof PLUGIN_ACTION_INPUT_SCHEMAS]: z.input<
    (typeof PLUGIN_ACTION_INPUT_SCHEMAS)[TActionId]
  >;
}>;

type PluginActionResultByRuntimeSchemaMap = Readonly<{
  [TActionId in keyof typeof PLUGIN_ACTION_OUTPUT_SCHEMAS]: z.output<
    (typeof PLUGIN_ACTION_OUTPUT_SCHEMAS)[TActionId]
  >;
}>;

// The runtime maps are the one executable projection of the canonical Action
// rows. Preserve the exact per-id schemas here so SDK consumers cannot observe
// a widened `ZodTypeAny` carrier while the type-level maps remain precise.
type PluginActionInputRuntimeSchemaMapMustRemainExact = AssertTrue<IsTypeEqual<
  PluginActionInputByRuntimeSchemaMap,
  PluginActionInputById
>>;
type PluginActionResultRuntimeSchemaMapMustRemainExact = AssertTrue<IsTypeEqual<
  PluginActionResultByRuntimeSchemaMap,
  PluginActionResultById
>>;

/**
 * The authenticated public API is the API-surface projection of the same
 * canonical rows. It excludes only host-internal and plugin-provenance-only
 * Actions, rather than maintaining a second allowlist.
 */
export type PublicActionSpecDefinition = {
  [TActionId in PublicActionId]: Extract<
    CanonicalActionSpecDefinition,
    Readonly<{ id: TActionId }>
  >;
}[PublicActionId];

type PublicActionSpecForId<TActionId extends PublicActionId> = Extract<
  PublicActionSpecDefinition,
  Readonly<{ id: TActionId }>
>;

export type PublicActionInputById = Readonly<{
  [TActionId in PublicActionId]: PublicActionSpecForId<TActionId> extends Readonly<{
    surfaceBindings: Readonly<{ api: Readonly<{ inputSchema: infer TInputSchema extends z.ZodTypeAny }> }>;
  }>
    ? z.input<TInputSchema>
    : z.input<PublicActionSpecForId<TActionId>['inputSchema']>;
}>;

export type PublicActionResultById = Readonly<{
  [TActionId in PublicActionId]: z.output<PublicActionSpecForId<TActionId>['outputSchema']>;
}>;

type PublicActionInputSchemaById = Readonly<{
  [TActionId in PublicActionId]: PublicActionSpecForId<TActionId> extends Readonly<{
    surfaceBindings: Readonly<{ api: Readonly<{ inputSchema: infer TInputSchema extends z.ZodTypeAny }> }>;
  }>
    ? TInputSchema
    : PublicActionSpecForId<TActionId>['inputSchema'];
}>;

type PublicActionOutputSchemaById = Readonly<{
  [TActionId in PublicActionId]: PublicActionSpecForId<TActionId>['outputSchema'];
}>;

type UnknownPublicActionInputId = {
  [TActionId in PublicActionId]: IsUnknown<PublicActionInputById[TActionId]> extends true
    ? TActionId
    : never;
}[PublicActionId];

type UnknownPublicActionResultId = {
  [TActionId in PublicActionId]: IsUnknown<PublicActionResultById[TActionId]> extends true
    ? TActionId
    : never;
}[PublicActionId];

type NeverPublicActionInputId = {
  [TActionId in PublicActionId]: IsNever<PublicActionInputById[TActionId]> extends true
    ? TActionId
    : never;
}[PublicActionId];

type NeverPublicActionResultId = {
  [TActionId in PublicActionId]: IsNever<PublicActionResultById[TActionId]> extends true
    ? TActionId
    : never;
}[PublicActionId];

type PublicActionInputsMustRemainExact = AssertNever<UnknownPublicActionInputId>;
type PublicActionResultsMustRemainExact = AssertNever<UnknownPublicActionResultId>;
type PublicActionInputsMustRemainPresent = AssertNever<NeverPublicActionInputId>;
type PublicActionResultsMustRemainPresent = AssertNever<NeverPublicActionResultId>;

const PUBLIC_ACTION_SPECS = ACTION_SPECS_WITH_PUBLIC_EXPOSURE.filter(
  (spec): spec is ActionSpecWithoutApproval & Readonly<{
    surfaces: ActionSpecWithoutApproval['surfaces'] & Readonly<{ api: true }>;
    outputSchema: z.ZodTypeAny;
  }> => (
    spec.surfaces.api === true && spec.outputSchema !== undefined
  ),
);

/** Runtime companion generated from the same canonical rows as the API type maps. */
export const PUBLIC_ACTION_IDS = Object.freeze(
  PUBLIC_ACTION_SPECS.map((spec) => spec.id),
) as readonly PublicActionId[];

const PUBLIC_ACTION_ID_SET = new Set<string>(PUBLIC_ACTION_IDS);

/** Runtime parser for the ActionSpec rows explicitly surfaced to authenticated API callers. */
export const PublicActionIdSchema = z.custom<PublicActionId>(
  (actionId) => typeof actionId === 'string' && PUBLIC_ACTION_ID_SET.has(actionId),
  { message: 'Action is not available on the public API surface' },
);

function projectPublicActionInputSchemas(
  specs: readonly ActionSpecWithoutApproval[],
): PublicActionInputSchemaById;
function projectPublicActionInputSchemas(
  specs: readonly ActionSpecWithoutApproval[],
): object {
  return Object.freeze(Object.fromEntries(specs.map((spec) => {
    const surfaceBindings = 'surfaceBindings' in spec
      ? spec.surfaceBindings
      : undefined;
    const apiBinding = surfaceBindings && 'api' in surfaceBindings
      ? surfaceBindings.api
      : undefined;
    return [spec.id, apiBinding?.inputSchema ?? spec.inputSchema];
  })));
}

function projectPublicActionOutputSchemas(
  specs: readonly ActionSpecWithoutApproval[],
): PublicActionOutputSchemaById;
function projectPublicActionOutputSchemas(
  specs: readonly ActionSpecWithoutApproval[],
): object {
  return Object.freeze(Object.fromEntries(specs.map((spec) => [spec.id, spec.outputSchema])));
}

export const PUBLIC_ACTION_INPUT_SCHEMAS: PublicActionInputSchemaById = projectPublicActionInputSchemas(
  PUBLIC_ACTION_SPECS,
);

export const PUBLIC_ACTION_OUTPUT_SCHEMAS: PublicActionOutputSchemaById = projectPublicActionOutputSchemas(
  PUBLIC_ACTION_SPECS,
);

type PublicActionInputByRuntimeSchemaMap = Readonly<{
  [TActionId in keyof typeof PUBLIC_ACTION_INPUT_SCHEMAS]: z.input<
    (typeof PUBLIC_ACTION_INPUT_SCHEMAS)[TActionId]
  >;
}>;

type PublicActionResultByRuntimeSchemaMap = Readonly<{
  [TActionId in keyof typeof PUBLIC_ACTION_OUTPUT_SCHEMAS]: z.output<
    (typeof PUBLIC_ACTION_OUTPUT_SCHEMAS)[TActionId]
  >;
}>;

type PublicActionInputRuntimeSchemaMapMustRemainExact = AssertTrue<IsTypeEqual<
  PublicActionInputByRuntimeSchemaMap,
  PublicActionInputById
>>;
type PublicActionResultRuntimeSchemaMapMustRemainExact = AssertTrue<IsTypeEqual<
  PublicActionResultByRuntimeSchemaMap,
  PublicActionResultById
>>;

const HOST_DOMAIN_PLUGIN_CALLER_POLICY: ActionPluginCallerPolicy = {
  kind: 'caller',
};
const PLUGIN_RELOAD_CALLER_POLICY: ActionPluginCallerPolicy = {
  kind: 'self_or_inspector_admin',
  targetPluginIdField: 'pluginId',
  administrativeCallers: [{
    pluginId: 'happier.inspector',
    contributionLocalId: 'inspector-app',
  }],
};
/**
 * The one declaration census for host Actions with a caller policy on the
 * plugin surface.
 * `caller` means the canonical executor requires a current host-stamped
 * plugin caller. A `caller` row names no plugin identity: a built-in plugin
 * and an out-of-tree plugin reach exactly the same host capability. Further
 * identity projection occurs only when the incumbent domain owner has
 * caller-dependent authorization — Account scope, publisher proof, and current
 * materialization are that owner's fences, and they do not depend on which
 * plugin is asking. Reload is the one plugin-*targeted* Action: it administers
 * a peer plugin's development generation, so its self scope and the exact
 * Inspector administrative surface live here rather than in any consumer.
 */
const ACTION_PLUGIN_CALLER_POLICY_BY_ID: Readonly<
  Partial<Record<ActionId, ActionPluginCallerPolicy>>
> = Object.freeze({
  'plugins.reload': PLUGIN_RELOAD_CALLER_POLICY,
  'plugins.permissions.grants.request': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'plugins.permissions.grants.revoke': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'automation.event.admit': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'automation.event.source.status.report': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'automation.conversation.targets.list': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'automation.conversation.target.verify': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'automation.conversation.admit': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'reviews.comments.create': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'reviews.comments.transition': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'reviews.comments.edit': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'reviews.comments.reply': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'reviews.comments.redact': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'reviews.comments.setDisposition': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'reviews.comments.attachEvidence': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'reviews.comments.bulkTransition': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'browser.navigate': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'plugins.sessionHooks.install': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'plugins.sessionHooks.disable': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'plugins.sessionHooks.enable': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'plugins.sessionHooks.uninstall': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'sessions.external.materialize.start': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'sessions.external.operation.cancel': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'sessions.external.operation.resume': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'sessions.external.operation.retry': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'sessions.external.operation.discard': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'session.rollback': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'session.checkpoint_code_rollback': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'session.checkpoint': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'session.restore': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'session.terminalComposer.clear': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'session.pendingInput.interruptAndRun': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'session.usageLimit.consumeResetCredit': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'prompt_doc.update': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'prompt_bundle.update': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'prompt_asset.export': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'prompt_registry.install': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'daemon.promptAssets.delete': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'daemon.promptRegistry.install': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'transcript.import': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'sessions.external.follow': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'sessions.external.unfollow': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'sessions.external.backgroundFollow.set': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'scm.pullRequest.openOrReuse': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'scm.pullRequest.checkout': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'scm.pullRequest.prepareWorktree': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'scm.pullRequest.runStacked': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'scm.repository.clone': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'scm.repository.init': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'scm.repository.removeIndexLock': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'scm.hostingRepository.publish': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
});

function resolveActionPluginCallerPolicy(
  spec: ActionSpecWithoutApproval,
): ActionPluginCallerPolicy | undefined {
  const policy = ACTION_PLUGIN_CALLER_POLICY_BY_ID[spec.id];
  const requiresPolicy = spec.surfaces.plugin && spec.safety !== 'safe';
  if (!spec.surfaces.plugin && policy) {
    throw new Error(`Action ${spec.id} declares pluginCallerPolicy without a plugin surface`);
  }
  // Backed runtime Actions use the same host-stamped Plugin provenance as
  // every other non-safe host Action. Their machine/session routing remains
  // with the runtime owner; callers never supply a plugin identity in input.
  if (requiresPolicy && isRuntimeActionIdV1(spec.id)) {
    return HOST_DOMAIN_PLUGIN_CALLER_POLICY;
  }
  return requiresPolicy ? policy ?? HOST_DOMAIN_PLUGIN_CALLER_POLICY : policy;
}

const CURRENT_SESSION_CONTEXT_ACTION_IDS = new Set<ActionId>([
  'reviews.comments.create',
  'reviews.comments.list',
  'browser.recording.attachToComposer',
  'localServices.inventory.list',
  'localServices.inventory.refresh',
  'localServices.launcher.snapshot',
  'localServices.launcher.start',
  'localServices.launcher.openPreview',
  'localServices.launcher.registerPreview',
  'localServices.launcher.history.clear',
  'localServices.preview.openOrCreate',
  'localServices.preview.status',
  'localServices.preview.revoke',
  'localServices.publicPreview.create',
  'localServices.publicPreview.status',
  'localServices.publicPreview.revoke',
  'localServices.publicPreview.copyUrl',
  'peerMediation.observability.snapshot',
  'sessions.external.operation.status.get',
  'sessions.external.operation.cancel',
  'sessions.external.operation.resume',
  'sessions.external.operation.retry',
  'sessions.external.operation.discard',
  'action.options.resolve',
  'review.start',
  'subagents.plan.start',
  'subagents.delegate.start',
  'voice_agent.start',
  'execution.run.start',
  'execution.run.list',
  'execution.run.get',
  'execution.run.send',
  'execution.run.ensure',
  'execution.run.ensure_or_start',
  'execution.run.stream.start',
  'execution.run.stream.read',
  'execution.run.stream.cancel',
  'execution.run.stop',
  'execution.run.action',
  'execution.run.wait',
  'session.open',
  'session.fork',
  'session.rollback',
  'session.checkpoint_code_rollback',
  'session.checkpoint',
  'session.restore',
  'session.handoff',
  'session.handoff.prepare_target',
  'review.engines.list',
  'session.message.send',
  'session.stop',
  'session.terminalComposer.clear',
  'session.pendingInput.interruptAndRun',
  'session.title.set',
  'session.permission_mode.set',
  'session.model.set',
  'session.archive',
  'session.unarchive',
  'session.status.get',
  'session.work_state.get',
  'session.goal.get',
  'session.goal.set',
  'session.goal.clear',
  'session.usageLimit.waitResume.enable',
  'session.usageLimit.waitResume.cancel',
  'session.usageLimit.checkNow',
  'session.usageLimit.consumeResetCredit',
  'session.vendor_plugin_catalog.list',
  'session.skill_catalog.list',
  'session.history.get',
  'session.transcript.get',
  'session.events.get',
  'session.wait.idle',
  'session.permission.respond',
  'session.permission.remote.pending.list',
  'session.permission.remote.respond',
  'session.permission.remote.grants.list',
  'session.permission.remote.grants.revoke',
  'session.user_action.answer',
  'session.mode.set',
  'session.target.primary.set',
  'session.activity.get',
  'session.messages.recent.get',
  'ui.voice_agent.teleport',
  'memory.ensure_up_to_date',
  'transcript.page',
  'transcript.readAfter',
  'transcript.follow',
  'transcript.unfollow',
  'transcript.import',
  'transcript.search',
  'sessions.external.follow',
  'sessions.external.unfollow',
  'sessions.external.backgroundFollow.set',
  'sessions.external.status.get',
]);

function resolveBuiltInActionContextualDefaults(actionId: ActionId): ActionContextualDefaults | undefined {
  if (actionId === 'memory.search' || actionId === 'memory.get_window') {
    return { machineId: 'current_session_machine' };
  }
  return CURRENT_SESSION_CONTEXT_ACTION_IDS.has(actionId)
    ? { sessionId: 'current_session' }
    : undefined;
}

export const ACTION_SPECS: readonly ActionSpec[] = Object.freeze(
  ACTION_SPECS_WITH_PUBLIC_EXPOSURE.map((spec): ActionSpec => {
    const pluginCallerPolicy = resolveActionPluginCallerPolicy(spec);
    const contextualDefaults = resolveBuiltInActionContextualDefaults(spec.id);
    return {
      ...spec,
      requiredAuthority: resolveActionRequiredAuthority(spec),
      executionPlacement: resolveActionExecutionPlacement(spec),
      ...(pluginCallerPolicy ? { pluginCallerPolicy } : {}),
      ...(contextualDefaults ? { contextualDefaults } : {}),
      placements: [...spec.placements],
      approval: resolveApprovalMetadataForActionId(spec.id),
    };
  }),
);

assertPublicActionSdkMethodNames(ACTION_SPECS, PUBLIC_ACTION_ID_SET);

export function listActionSpecs(): readonly ActionSpec[] {
  return ACTION_SPECS;
}

export function getActionSpec(id: ActionId): ActionSpec {
  const spec = ACTION_SPECS.find((s) => s.id === id);
  if (!spec) {
    // This is a programmer error: all call sites should be type-safe and list-backed.
    throw new Error(`Unknown action spec: ${id}`);
  }
  return spec;
}

export function getActionContextualDefaults(
  action: ActionId | string | ActionSpec,
): ActionContextualDefaults | null {
  const spec = typeof action === 'string'
    ? (() => {
      const parsed = ActionIdSchema.safeParse(action);
      return parsed.success ? getActionSpec(parsed.data) : null;
    })()
    : action;
  if (!spec) return null;
  return spec.contextualDefaults ?? null;
}

/**
 * Is `spec` reachable from `surface`? This is the enablement gate for the whole Action catalog:
 * it backs `createActionExecutor`'s `isActionEnabledBySurface` and both MCP tool bridges.
 *
 * It fails CLOSED on a nullish or unknown surface (INV-1). An unattributed caller is not a
 * wildcard — surface attribution is owned by the host that constructs the executor
 * (`createCliActionExecutor` stamps `'cli'`, `createDefaultActionExecutor` stamps `'ui'`, the
 * MCP servers stamp `'agent'`/`'mcp'`, the RPC adapter stamps `'rpc'`, external ingress stamps
 * `'api'`), so a missing surface means the host forgot, not that every surface is permitted.
 * This resolves the same direction as the consent layer, which already treats an unresolvable
 * surface as `ambiguous` and applies the agent approval floor
 * (`actionApprovalPolicy.ts#resolveApprovalSurface`).
 *
 * Callers that mean "no surface filter requested" must short-circuit before calling this
 * (see `actionCatalog.ts`, which guards every use with `params.surface && …`). That is a
 * different question from "may an unknown caller reach this Action".
 */
export function isActionSpecSurfacedOn(spec: ActionSpec, surface: keyof ActionSurfaces | null | undefined): boolean {
  if (!surface) return false;
  return spec.surfaces[surface] === true;
}

export function listActionSpecsForSurface(surface: keyof ActionSurfaces): readonly ActionSpec[] {
  return ACTION_SPECS.filter((spec) => isActionSpecSurfacedOn(spec, surface));
}

export function listVoiceToolActionSpecs(): readonly ActionSpec[] {
  return listActionSpecsForSurface('voice').filter((spec) => Boolean(spec.bindings?.voiceClientToolName));
}

export { describeActionForVoiceTool } from './actionVoiceToolSummary.js';

/**
 * Canonical tool projection for provider SDK callbacks that cannot retain a
 * stable host call/result identity across reconnects. Such callbacks may
 * expose only none/read actions and must never advertise mutations.
 */
export function isVoiceSdkSafeActionSpec(spec: Pick<ActionSpec, 'sideEffectClass'>): boolean {
  return spec.sideEffectClass === 'none' || spec.sideEffectClass === 'read';
}

export function listVoiceSdkSafeToolActionSpecs(): readonly ActionSpec[] {
  return listVoiceToolActionSpecs().filter(isVoiceSdkSafeActionSpec);
}

export function isVoicePromptHotPathSpec(spec: Pick<ActionSpec, 'prompting'>): boolean {
  return spec.prompting?.voiceHotPath === true;
}

export function listVoicePromptHotPathSpecs(): readonly ActionSpec[] {
  return listVoiceToolActionSpecs().filter(isVoicePromptHotPathSpec);
}

export function listVoiceActionBlockSpecs(): readonly ActionSpec[] {
  return listActionSpecsForSurface('voice').filter((spec) => Boolean(spec.bindings?.voiceClientToolName));
}

export function listVoiceClientToolNames(): readonly string[] {
  const names = listVoiceToolActionSpecs()
    .map((spec) => String(spec.bindings?.voiceClientToolName ?? '').trim())
    .filter((name) => name.length > 0);
  names.sort();
  return names;
}

export function resolveVoiceClientToolNameAlias(value: string): string | null {
  const normalized = String(value ?? '').trim();
  if (!normalized) return null;

  for (const spec of listVoiceToolActionSpecs()) {
    const toolName = String(spec.bindings?.voiceClientToolName ?? '').trim();
    if (!toolName) continue;
    if (toolName === normalized || spec.id === normalized) return toolName;
  }

  return null;
}
