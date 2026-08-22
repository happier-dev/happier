export {
  ACTION_ID_FAMILIES_V1,
  ACTION_IDS,
  ActionIdSchema,
  PLUGIN_DEV_LOOP_ACTION_IDS_V1,
  RUNTIME_ACTION_IDS_V1,
  RuntimeActionIdV1Schema,
  isPluginDevLoopActionIdV1,
  isRuntimeActionIdV1,
  type ActionId,
  type ActionIdFamilyV1,
  type PluginDevLoopActionIdV1,
  type RuntimeActionIdV1,
} from './actionIds.js';
export type { ActionExecuteResult } from './actionExecutionResult.js';
export { ACTION_UI_PLACEMENTS, ActionUiPlacementSchema, type ActionUiPlacement } from './actionUiPlacements.js';
export {
  ACTION_SETTINGS_OPT_IN_PLACEMENTS,
  ActionsSettingsV1Schema,
  isActionSettingsOptInPlacement,
  isActionEnabledByActionsSettings,
  type ActionsSettingsV1,
} from './actionSettings.js';
export {
  isAgentInitiatedApprovalRequiredByDefault,
  isApprovalRequiredByActionsSettings,
  resolveActionApprovalRouting,
  AGENT_INITIATED_APPROVAL_REQUIRED_ACTION_IDS,
  EGRESS_SENSITIVE_AGENT_FLOOR,
  type ActionApprovalRoutingDecision,
  type ResolveActionApprovalRoutingArgs,
} from './actionApprovalPolicy.js';
export {
  ACTION_SPECS,
  PLUGIN_ACTION_INPUT_SCHEMAS,
  PLUGIN_ACTION_OUTPUT_SCHEMAS,
  PLUGIN_INVOCABLE_ACTION_IDS,
  PluginInvocableActionIdSchema,
  ActionApprovalFlowSchema,
  ActionApprovalResultSchema,
  ActionApprovalSchema,
  ActionSafetySchema,
  ActionSpecSchema,
  ActionSpecSurfaceBindingsSchema,
  ActionSurfaceSchema,
  ActionToolExposureModeSchema,
  ActionToolExposureSchema,
  ActionToolExposureSurfaceSchema,
  ActionInputFieldHintSchema,
  ActionInputHintsSchema,
  ActionInputOptionSchema,
  ActionInputOptionValueSchema,
  readActionInputOptionValue,
  ActionInputWidgetSchema,
  PluginScaffoldUiModeSchema,
  SESSION_TRANSCRIPT_GET_MAX_LIMIT,
  SessionEventsGetInputSchema,
  SessionTranscriptGetExternalShareableInputV1Schema,
  SessionTranscriptGetInputSchema,
  SessionTranscriptGetResultSchema,
  getActionSpec,
  actionAcceptsContextualSessionId,
  isVoicePromptHotPathSpec,
  isVoiceSdkSafeActionSpec,
  isActionSpecSurfacedOn,
  listActionSpecs,
  listActionSpecsForSurface,
  listVoiceActionBlockSpecs,
  listVoiceClientToolNames,
  listVoicePromptHotPathSpecs,
  listVoiceSdkSafeToolActionSpecs,
  listVoiceToolActionSpecs,
  resolveActionApprovalFlow,
  type ActionApproval,
  type ActionApprovalFlow,
  type ActionApprovalResult,
  type ActionSafety,
  type ActionInputFieldHint,
  type ActionInputHints,
  type ActionInputOption,
  type ActionInputOptionValue,
  type ActionInputWidget,
  type ActionSpec,
  type ActionSpecSurfaceBindings,
  type ActionSurfaceBindingCaller,
  type ActionSurfaceBindingContext,
  type ActionSurfaceBindingTransform,
  type ActionSurfaces,
  type ActionToolExposure,
  type ActionToolExposureMode,
  type ActionToolExposureSurface,
  type CanonicalActionSpecDefinition,
  type PluginActionInputById,
  type PluginActionResultById,
  type PluginInvocableActionId,
  type PluginInvocableActionSpecDefinition,
  type PluginScaffoldUiMode,
  type SessionEventsGetInput,
  type SessionEventsGetItem,
  type SessionEventsGetOutput,
  type SessionTranscriptGetExternalShareableInputV1,
  type SessionTranscriptGetInput,
  type SessionTranscriptGetExternalShareableResultV1,
  type SessionTranscriptGetItem,
  type SessionTranscriptGetOutput,
  type SessionTranscriptGetResult,
} from './actionSpecs.js';

/**
 * Converts one admitted localized Action-form descriptor into the canonical
 * string form consumed by host presentation. The caller owns text resolution;
 * this owner retains the field/options shape and validation rules.
 */
export { normalizeActionInputHintsText } from './actionInputHints.js';

export {
  ACTION_TOOL_EXPOSURE_SURFACES,
  AGENT_DIRECT_ACTION_TOOL_ALLOW_LIST,
  isActionDirectToolExposedOn,
  isActionDiscoverableOnToolSurface,
  resolveActionToolExposureMode,
  type ActionToolExposureResolutionContext,
} from './actionToolExposure.js';
export {
  ACTION_SURFACE_POLICIES,
  getActionSurfacePolicy,
  getDefaultActionToolExposureMode,
  isActionToolExposureSurface,
  listActionSurfacePolicies,
  resolveActionSurfaceAvailability,
  resolveActionToolExposureModeForSurface,
  type ActionSurfaceAvailability,
  type ActionSurfaceAvailabilityReason,
  type ActionSurfacePolicy,
  type ActionSurfaceSettingsState,
} from './actionSurfaceAvailability.js';

export {
  createActionExecutor,
  type ActionAutomationRunCaller,
  type ActionCaller,
  type ActionExecutorContext,
  type ActionExecutorDeps,
  type ActionPluginCaller,
  type ScmActionExecute,
  type ScmActionId,
  type ApprovalQueueListItemV1,
  type ApprovalQueueListResultV1,
  type ApprovalQueueQueryPlanV1,
} from './actionExecutor.js';
export {
  resolveActionBackendTargetSelection,
  type ActionBackendTargetSelection,
  type ActionBackendTargetSelectionResult,
} from './resolveActionBackendTargetSelection.js';
export {
  createRuntimeActionDisabledResult,
  createUnavailableRuntimeActionExecutor,
  dispatchRuntimeAction,
  resolveRuntimeActionExecutionFamily,
  type RuntimeActionDisabledReason,
  type RuntimeActionExecute,
  type RuntimeActionExecuteArgs,
  type RuntimeActionExecuteArgsFor,
  type RuntimeActionExecutionFamily,
  type RuntimeActionInputById,
  type RuntimeActionResultById,
} from './executor/index.js';

export {
  assertNonEscalatingPermissionMode,
  resolveEffectivePermissionMode,
  resolveNearestPermissionModeAtOrBelow,
  resolvePermissionPrivilegeOrdinal,
  type EffectivePermissionModeFailureReason,
  type EffectivePermissionModeResolution,
  type PermissionEscalationDecision,
  type PermissionPrivilegeOrdinal,
} from './permissionPrivilege.js';

export {
  SpawnConfigOptionValueSchema,
  buildAcpConfigOptionOverridesV1FromConfigOptions,
  findSpawnConfigOptionAliasConflicts,
  mergeSpawnConfigOptionAliases,
  type SpawnConfigOptionValue,
  type SpawnConfigOptionsAliasConflict,
} from './sessionSpawnConfigOptions.js';

export {
  resolveExplicitSessionSpawnMachineTarget,
  type ExplicitSessionSpawnMachineTargetResolution,
  type SessionSpawnMachineTargetCandidate,
} from './sessionSpawnMachineTarget.js';

export {
  normalizeActionInputByFieldHints,
  resolveEffectiveActionInputFields,
  type EffectiveActionInputField,
} from './actionInputHintsRuntime.js';
export {
  ActionInputPathSchema,
  ActionInputPredicateSchema,
  ActionInputPrimitiveSchema,
  readActionInputPath,
  evaluateActionInputPredicate,
  type ActionInputPath,
  type ActionInputPredicate,
  type ActionInputPrimitive,
} from './actionInputPredicates.js';
export { buildActionDraftSeedInput } from './actionDraftSeed.js';
export {
  describeActionInputFieldForVoice,
  getActionInputFieldVoiceNotes,
  getActionVoiceWorkflowNotes,
} from './actionInputVoiceGuidance.js';
export type { VoiceGuidanceAvailability } from './actionInputVoiceGuidance.js';
export { describeActionForVoiceTool } from './actionVoiceToolSummary.js';
export {
  actionSpecToActionDefinitionV1,
  findActionInputFieldHint,
  filterResolvedActionOptions,
  getActionDefinitionForCatalogSurface,
  getActionSpecForCatalogSurface,
  getSerializedActionSpecForSurface,
  listActionDefinitionsForCatalogSurface,
  listActionSpecsForCatalogSurface,
  searchSerializedActionSpecsForSurface,
  serializeActionFieldOptions,
  searchSerializedActionSpecs,
  serializeActionSpec,
  type ResolvedActionOption,
  type SerializedActionSpec,
} from './actionCatalog.js';

export {
  ActionJsonSchemaProjectionError,
  zodSchemaToJsonSchemaObject,
  type JsonSchemaObject,
} from './actionInputJsonSchema.js';
export { resolveRequestedSessionModeId } from './sessionModeIds.js';

export {
  ExecutionRunStartFailureDetailsV1Schema,
  ExecutionRunStartRunCreationSchema,
  readExecutionRunStartRunCreation,
  withExecutionRunStartFailureDetails,
  type ExecutionRunStartFailureDetailsV1,
  type ExecutionRunStartRunCreation,
} from '../execution/runs/index.js';
