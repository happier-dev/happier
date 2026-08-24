/** @moduleRealm daemon */
import {
  createAcpToolNameInferencePreset as canonicalCreateAcpToolNameInferencePreset,
  normalizeAcpPermissionIntent as canonicalNormalizeAcpPermissionIntent,
  resolveAcpToolPermissionPolicy as canonicalResolveAcpToolPermissionPolicy,
} from '@happier-dev/agents/acpPresets';
import {
  AgentRuntimeJsonValueSchema as canonicalAgentRuntimeJsonValueSchema,
  AgentSessionProviderBindingV1Schema as canonicalAgentSessionProviderBindingV1Schema,
  AgentSessionRuntimeEventSchema as canonicalAgentSessionRuntimeEventSchema,
} from '@happier-dev/protocol/runtime';
import type {
  AcpForkSessionRequestV1,
  AcpLoadSessionRequestV1,
  AttachSessionMetadataV1,
  BackendSurfaceBaseFailureCodeV1,
  BackendSurfaceDiagnosticV1,
  CheckpointAvailabilityOperationV1,
  CheckpointAvailabilityRequestV1,
  CheckpointDescriptorV1,
  CheckpointProviderTargetRefV1,
  CheckpointRestoreAnchorEvidenceV1,
  CheckpointRestoreAnchorV1,
  CheckpointRestoreScopeV1,
  CheckpointTimingV1,
  CreateCheckpointRequestV1,
  ForkSessionMetadataV1,
  ForkPointV1,
  HandoffExportSessionMetadataV1,
  HandoffExportResultV1,
  HandoffFailureCodeV1,
  HandoffImportRequestV1,
  ListCheckpointsRequestV1,
  ResolveCheckpointRestoreTargetRequestV1,
  RestoreCheckpointByAnchorRequestV1,
  RestoreCheckpointByTargetRequestV1,
  RestoreCheckpointFailureCodeV1,
  RestoreCheckpointRequestV1,
} from '@happier-dev/agents';
import type {
  AgentProviderBindingLaunchMaterializationV1,
  BackendSurfaceAvailabilityV1,
} from '@happier-dev/protocol';

import type {
  AgentPermissionIntent,
  AgentSessionProviderBinding,
  AgentSessionProviderBindingUpstream,
  AgentSessionRuntimeEvent,
} from './session.js';
import type { AgentAcpToolNameInference } from './acpTypes.js';
import type { JsonValue } from '../identity.js';

/** @realm any */
export { buildAgentAccountUsageRecordId } from './accountUsage.js';
/**
 * The canonical public name stays stable while the declaration itself is the
 * SDK-owned structural projection, so an external author's emitted closure
 * never reaches into the private Protocol package. `projections.test.ts` holds
 * this alias equal to `@happier-dev/protocol`'s settings-owned type.
 */
export type {
  AgentConnectedServicesProviderStateSharingPolicy as ConnectedServicesProviderStateSharingPolicyV1,
} from './session.js';
export type {
  AgentAcpAuthenticationContext,
  AgentAcpAuthenticationDefinition,
  AgentAcpAuthenticationSelection,
  AgentAcpCompletionEvidenceOutcome,
  AgentAcpExtensionContext,
  AgentAcpInFlightSteerDefinition,
  AgentAcpModel,
  AgentAcpModelControls,
  AgentAcpModelOption,
  AgentAcpNotificationExtension,
  AgentAcpPromptUsageDefinition,
  AgentAcpRequestExtension,
  AgentAcpRuntimeDefinition,
  AgentAcpRuntimeComposer,
  AgentAcpRuntimeExtensions,
  AgentAcpRuntimeOptions,
  AgentAcpToolUpdateContentSanitizer,
  AgentAcpToolUpdatePolicy,
  AgentRuntimeProtocolComposers,
} from './acp.js';
export type {
  AgentAccountUsageRecordKey,
  AgentAccountUsageDiagnostic,
  AgentAccountUsageMeter,
  AgentAccountUsageQuotaConfidence,
  AgentAccountUsageQuotaSource,
  AgentAccountUsageRecoveryCredit,
  AgentAccountUsageRecoveryCredits,
  AgentAccountUsageSnapshot,
} from './accountUsage.js';
export type {
  AgentAccountUsageAdoptionProof,
  AgentAccountUsageAdoptProvisionalRecordInput,
  AgentAccountUsageAdoptProvisionalRecordResult,
  AgentAccountUsageRecordSnapshotInput,
  AgentAccountUsageRecordSnapshotResult,
  AgentAccountUsageService,
  AgentAccountUsageSourceContext,
  AgentAccountUsageSourceContextInput,
  AgentFeatureDecisionService,
  AgentRuntimeContext,
  AgentRuntimeFactoryContext,
  AgentSessionAuthRefreshClassification,
  AgentSessionAuthRefreshError,
  AgentSessionAuthRefreshPayload,
  AgentSessionAuthRefreshRecovery,
  AgentSessionAuthRefreshRequest,
  AgentSessionAuthRefreshResult,
  AgentSessionAuthRefreshSelection,
  AgentSessionHookForwarderAssets,
  AgentSessionHookPluginFile,
  AgentSessionHookServerHandle,
  AgentSessionHookServerStartRequest,
  AgentSessionHooksService,
  AgentSessionHostServices,
  AgentSessionHappierToolsService,
  AgentSessionNativeToolBridgeConfig,
  AgentSessionNativeToolDescriptor,
  AgentTerminalHostCreateOrAttachRequest,
  AgentTerminalHostDisposeIntent,
  AgentTerminalHostLaunchInput,
  AgentTerminalHostResolutionReason,
  AgentTerminalHostResolveRequest,
  AgentTerminalHostResolveResult,
  AgentTerminalHostService,
  AgentSessionMcpServer,
  AgentSessionMcpService,
  AgentSessionMcpTransport,
  AgentSessionRuntimeContext,
  AgentToolExecutionBeforeRequest,
  AgentToolExecutionBeforeResult,
  AgentToolExecutionService,
  AgentTranscriptFileFollowHandle,
  AgentTranscriptFileFollowInput,
  AgentTranscriptFileFollowService,
  AgentTranscriptSessionEventPublicationResult,
  AgentTranscriptSessionEventPublisher,
  TerminalControlPort,
  TerminalHostHandle,
  TerminalHostKind,
  TerminalHostLiveness,
  TerminalHostPreference,
  TerminalInputInjectionResult,
  TerminalInputState,
  TerminalPromptInput,
} from './context.js';
export type {
  AgentRuntimeFactory,
  AgentSessionCatalogControl,
  AgentSessionCatalogRequest,
  AgentSessionCatalogResult,
  AgentSessionContinuationControl,
  AgentSessionContinuationProbeResult,
  AgentSessionControlContext,
  AgentSessionControlFailure,
  AgentSessionConversationRollbackControl,
  AgentSessionConversationRollbackReconciliationResult,
  AgentSessionConversationRollbackRequest,
  AgentSessionConversationRollbackResult,
  AgentSessionGoalCommittedResult,
  AgentSessionGoalControl,
  AgentSessionGoalControlContext,
  AgentSessionGoalMutation,
  AgentSessionGoalMutationResult,
  AgentSessionGoalRefreshResult,
  AgentSessionRuntimeFactory,
  AgentSessionSkillCatalogItem,
  AgentSessionUsageLimitRecoveryControl,
  AgentSessionUsageLimitRecoveryRequest,
  AgentSessionUsageLimitRecoveryResult,
  AgentSessionVendorPluginCatalogItem,
} from './controls.js';
export type {
  AgentExecutionRunEvent,
  AgentExecutionRunOpenRequest,
  AgentExecutionRunRuntime,
  AgentExecutionRunRuntimeFactory,
  AgentExecutionRunSendResult,
  AgentExecutionRunStopResult,
} from './executionRun.js';
export type {
    AgentRuntime,
    AgentToolExecutionLifecycle,
} from './runtime.js';
export type {
  AgentProviderBindingAdapter,
  AgentProviderBindingCredential,
  AgentProviderBindingMaterialization,
  AgentProviderBindingMaterializeInput,
  AgentProviderBindingPrepareInput,
  AgentProviderBindingPrepared,
  AgentProviderBindingResolvedFacts,
  AgentProviderCredentialTransport,
} from './providerBinding.js';
export type {
  AgentDaemonResolvedToolV1,
  AgentDaemonRunToolResultV1,
  AgentDaemonSpawnConnectedServiceBindingV1,
  AgentDaemonSpawnConnectedServicesV1,
  AgentDaemonSpawnDiagnosticV1,
  AgentDaemonSpawnHooks,
  AgentDaemonSpawnRuntimeSelectionV1,
  AgentDaemonSpawnToolResolutionContextV1,
  AgentDaemonSpawnValidationResult,
  AgentRuntimeRegistrationOptions,
  AgentSessionRunnerFactoryLocatorV1,
} from './registration.js';
export type {
  AgentConfigurationScalar,
  AgentLaunchEnvironment,
  AgentPermissionIntent,
  AgentSessionCancelResult,
  AgentSessionCompactRequest,
  AgentSessionCompactResult,
  AgentSessionConfigurationResult,
  AgentSessionConfigurationSnapshot,
  AgentSessionConfigurationUpdate,
  AgentSessionConnectedAccountSelection,
  AgentSessionInput,
  AgentSessionMcpLaunchConfig,
  AgentSessionOpenRequest,
  AgentSessionProviderBinding,
  AgentSessionProviderBindingUpstream,
  AgentSessionRuntime,
  AgentSessionRuntimeAuthApplyRequest,
  AgentSessionRuntimeAuthApplyResult,
  AgentSessionRuntimeAuthControl,
  AgentSessionRuntimeAuthIdentityRequest,
  AgentSessionRuntimeAuthIdentityResult,
  AgentSessionRuntimeEvent,
  AgentSessionSendRequest,
  AgentSessionSendResult,
  AgentSessionStartupInstructions,
  TimestampedAgentValue,
} from './session.js';
export type {
  AgentRuntimeSurfaces,
  AgentRuntimeForkSurface,
  AgentRuntimeHandoffSurface,
  AgentTerminalControlPresentation,
  AgentTerminalLaunchMetadata,
  AgentTerminalLaunchPlan,
  AgentTerminalLaunchRequest,
  AgentTerminalSurface,
} from './surfaces.js';

export {
  ACP_AGENT_CLI_TRANSPORT_TIMEOUTS,
  ACP_HAPPIER_MCP_BRIDGE_STATIC_APPROVAL_TOOL_NAMES,
  ACP_WRITE_LIKE_PERMISSION_KINDS,
} from '@happier-dev/agents/acpPresets';
export const createAcpToolNameInferencePreset: (
  options?: Readonly<{ shellBridgeHint?: boolean }>,
) => AgentAcpToolNameInference = canonicalCreateAcpToolNameInferencePreset;
export const normalizeAcpPermissionIntent: (
  permissionMode: string | null | undefined,
  fallback?: AgentPermissionIntent,
) => AgentPermissionIntent = canonicalNormalizeAcpPermissionIntent;
export const resolveAcpToolPermissionPolicy: (
  permissionMode: string | null | undefined,
) => Readonly<Record<string, 'allow' | 'ask' | 'deny'>> = canonicalResolveAcpToolPermissionPolicy;
export const AgentRuntimeJsonValueSchema: Readonly<{
  parse(value: unknown): JsonValue;
  safeParse(value: unknown):
    | Readonly<{ success: true; data: JsonValue }>
    | Readonly<{
        success: false;
        error: Readonly<{
          issues: readonly Readonly<{ message: string }>[];
        }>;
      }>;
}> =
  canonicalAgentRuntimeJsonValueSchema;
/** @realm any */
export const AgentSessionProviderBindingV1Schema: Readonly<{
  parse(value: unknown): AgentSessionProviderBinding;
  safeParse(value: unknown):
    | Readonly<{ success: true; data: AgentSessionProviderBinding }>
    | Readonly<{
        success: false;
        error: Readonly<{
          issues: readonly Readonly<{ message: string }>[];
        }>;
      }>;
}> =
  canonicalAgentSessionProviderBindingV1Schema;
export const AgentSessionRuntimeEventSchema: Readonly<{
  parse(value: unknown): AgentSessionRuntimeEvent;
  safeParse(value: unknown):
    | Readonly<{ success: true; data: AgentSessionRuntimeEvent }>
    | Readonly<{
        success: false;
        error: Readonly<{
          issues: readonly Readonly<{ message: string }>[];
        }>;
      }>;
}> =
  canonicalAgentSessionRuntimeEventSchema;
export {
  parsePermissionIntentAlias,
} from '@happier-dev/agents/permissions';
export {
  isRuntimeConfigUpdateOutcomeApplied,
} from '@happier-dev/agents/runtime/session/runtimeConfigUpdateOutcome';
export {
  resolveRecoverableTurnFailureRetryDecision,
  resolveRecoverableTurnFailureSecondFailure,
} from '@happier-dev/agents/runtime/session/recoverableTurnFailurePolicy';
export {
  buildShellCommand,
} from '@happier-dev/agents/process/shellCommand';
export {
  createAgentSessionPreAdmissionBuffer,
} from '@happier-dev/agents/runtime/session/preAdmissionBuffer';

/** @realm any */
export type { AgentSessionRealtimeStartRequestV1 } from '@happier-dev/protocol/runtime';
/** @realm any */
export {
    AgentProviderBindingMaterializationV1Schema,
    AgentSessionRealtimeStartRequestV1Schema,
    AgentSessionRealtimeStartResultV1Schema,
} from '@happier-dev/protocol/runtime';
export {
    SessionContextUsageSnapshotV1Schema,
    UsageObservationContextSchema,
    UsageObservationCostSchema,
    UsageObservationScopeSchema,
    UsageObservationTokensSchema,
} from '@happier-dev/protocol/runtime';

/** @realm any */
export {
  assertExperimentalAgentSessionRealtimeRuntime as assertAgentSessionRealtimeRuntime,
} from '../experimental/agentRuntime/realtime.js';
export { buildUsageObservationEffect } from '../usage.js';

export type { AgentAcpHistorySession } from './acp.js';
export type {
  AgentAcpMcpInputPolicy,
  AgentAcpStderrMatchRule,
  AgentAcpStderrRules,
  AgentAcpStderrStatusErrorRule,
  AgentAcpTimeouts,
  AgentAcpToolNameInference,
  AgentAcpToolNamePattern,
  AgentAcpToolNameResolver,
} from './acpTypes.js';
export type {
  AgentProviderBindingEnvironmentEntry,
  AgentProviderBindingModel,
} from './providerBinding.js';
export type {
  AgentSessionDisposeReason,
  AgentSessionProviderCheckpoint,
} from './session.js';
export type {
  AgentSessionActiveInputBinding,
  AgentSessionActiveInputService,
  AgentSessionActiveInputStatus,
  AgentSessionHookPluginDirCreateRequest,
  AgentSessionHookProviderPayload,
  AgentSessionInFlightConfigurationOutcome,
  AgentSessionModel,
  AgentSessionModelOption,
  AgentSessionModelOptionChoice,
  AgentSessionModelsService,
  AgentSessionModelsSnapshot,
  AgentSessionModelsSource,
  AgentSessionProviderTranscriptPublishRequest,
  AgentSessionTerminalComposerClearOutcome,
  AgentSessionWorkflowActivityService,
  AgentTranscriptFileFollowLine,
} from './context.js';
/** @realm any */
export type {
  ExperimentalAgentSessionRealtimeRuntime as AgentSessionRealtimeRuntime,
  AgentSessionRealtimeAvailability,
  AgentSessionRealtimeConversation,
  AgentSessionRealtimeHandle,
  AgentSessionRealtimeLifecycleEvent,
  AgentSessionRealtimeStartInput,
  AgentSessionRealtimeStartResult,
  AgentSessionRealtimeStopResult,
} from '../experimental/agentRuntime/realtime.js';
/** @realm any */
export type { UsageObservationEffectV1 } from '../usage.js';

export type {
  AgentSessionPreAdmissionBuffer,
  AgentSessionPreAdmissionBufferResult,
} from '@happier-dev/agents/runtime/session/preAdmissionBuffer';

/**
 * Author-safe metadata supplied to Agent attach callbacks.
 * @realm any
 */
export type AttachSessionMetadata = AttachSessionMetadataV1;

/**
 * Author-safe parent metadata supplied to Agent fork callbacks.
 * @realm any
 */
export type ForkSessionMetadata = ForkSessionMetadataV1;

/**
 * Author-safe Session metadata supplied to Agent handoff exports.
 * @realm any
 */
export type HandoffExportSessionMetadata = HandoffExportSessionMetadataV1;

export type AgentTerminalSessionIdentityFieldId =
  | 'identity.runtimeDescriptor'
  | 'identity.providerSessionId';

export type AgentTerminalSessionStateUpdate =
  | Readonly<{
      fieldId: 'identity.runtimeDescriptor';
      value: Readonly<{
        v: 1;
        agentId: string;
        agent: Readonly<Record<string, unknown>>;
      } & Record<string, unknown>>;
      updatedAt?: number;
    }>
  | Readonly<{
      fieldId: 'identity.providerSessionId';
      value: string;
      updatedAt?: number;
    }>;

/** Author-safe receipt emitted by Agent-owned Session surfaces. */
export type BackendSurfaceOperationReceiptV1 = Readonly<{
  operationId?: string;
  providerOperationId?: string;
  diagnostics?: readonly BackendSurfaceDiagnosticV1[];
  sessionStateUpdates?: readonly AgentTerminalSessionStateUpdate[];
}>;

export type BackendSurfaceResultV1<
  TValue,
  TCode extends string = BackendSurfaceBaseFailureCodeV1,
> =
  | Readonly<{
      ok: true;
      value: TValue;
      receipt?: BackendSurfaceOperationReceiptV1;
    }>
  | Readonly<{
      ok: false;
      code: TCode | BackendSurfaceBaseFailureCodeV1;
      message?: string;
      retryable?: boolean;
      receipt?: BackendSurfaceOperationReceiptV1;
      diagnostics?: readonly BackendSurfaceDiagnosticV1[];
    }>;

export type AttachAvailabilityRequest = Readonly<{
  operation: 'attach';
  sessionId: string;
  metadata: AttachSessionMetadata;
  currentMachineId?: string | null;
  sessionMachineId?: string | null;
  hasLocalAttachmentInfo?: boolean;
  depth?: 'metadata' | 'live';
}>;

export type AttachRequest = Readonly<{
  sessionId: string;
  metadata: AttachSessionMetadata;
}>;

export type AttachFailureCode =
  | 'attach_target_unreachable'
  | 'local_attachment_required'
  | 'attach_failed';

export type AttachSurface = Readonly<{
  evaluateAvailability?: (
    request: AttachAvailabilityRequest,
  ) => BackendSurfaceAvailabilityV1 | Promise<BackendSurfaceAvailabilityV1>;
  attach: (
    request: AttachRequest,
  ) => BackendSurfaceResultV1<Readonly<{ exitCode: number | null }>, AttachFailureCode>
    | Promise<BackendSurfaceResultV1<Readonly<{ exitCode: number | null }>, AttachFailureCode>>;
}>;

export type AgentAuthorRestoreCheckpointResult =
  | Readonly<{
      ok: true;
      outcome: 'completed' | 'partial';
      restoredScopes: readonly CheckpointRestoreScopeV1[];
      failedScopes?: readonly Readonly<{
        scope: CheckpointRestoreScopeV1;
        code: RestoreCheckpointFailureCodeV1;
        message?: string;
      }>[];
      receipt?: BackendSurfaceOperationReceiptV1;
      diagnostics?: readonly BackendSurfaceDiagnosticV1[];
    }>
  | Readonly<{
      ok: false;
      code: RestoreCheckpointFailureCodeV1;
      message?: string;
      retryable?: boolean;
      receipt?: BackendSurfaceOperationReceiptV1;
      diagnostics?: readonly BackendSurfaceDiagnosticV1[];
    }>;

export type CheckpointSurface = Readonly<{
  evaluateAvailability?: (
    request: CheckpointAvailabilityRequestV1,
  ) => BackendSurfaceAvailabilityV1 | Promise<BackendSurfaceAvailabilityV1>;
  list?: (
    request: ListCheckpointsRequestV1,
  ) => readonly CheckpointDescriptorV1[] | Promise<readonly CheckpointDescriptorV1[]>;
  resolveRestoreTarget?: (
    request: ResolveCheckpointRestoreTargetRequestV1,
  ) => CheckpointProviderTargetRefV1 | null | Promise<CheckpointProviderTargetRefV1 | null>;
  checkpoint?: (
    request: CreateCheckpointRequestV1,
  ) => CheckpointDescriptorV1 | Promise<CheckpointDescriptorV1>;
  restore?: (
    request: RestoreCheckpointRequestV1,
  ) => AgentAuthorRestoreCheckpointResult | Promise<AgentAuthorRestoreCheckpointResult>;
}>;

export type BackendSessionLaunchHintsV1 = Readonly<{
  directory?: string;
  backendModeHint?: string;
  resumePlanOptions?: Readonly<Record<string, unknown>>;
  environmentVariables?: Readonly<Record<string, string>>;
  sessionStateUpdates?: readonly AgentTerminalSessionStateUpdate[];
}>;

export type AcpLoadSessionResultV1 = BackendSurfaceResultV1<Readonly<{
  providerSessionId: string;
  sessionStateUpdates?: readonly AgentTerminalSessionStateUpdate[];
}>>;

export type AcpForkSessionResultV1 = AcpLoadSessionResultV1;

export type AcpSessionOperationsV1 = Readonly<{
  loadSession(
    request: AcpLoadSessionRequestV1,
  ): AcpLoadSessionResultV1 | Promise<AcpLoadSessionResultV1>;
  forkSession(
    request: AcpForkSessionRequestV1,
  ): AcpForkSessionResultV1 | Promise<AcpForkSessionResultV1>;
}>;

export type ForkResultV1 = Readonly<{
  providerSessionId: string;
  launch: BackendSessionLaunchHintsV1;
}>;

export type HandoffImportResultV1 = Readonly<{
  providerSessionId: string;
  source?: Readonly<{ kind: string }>;
  launch: BackendSessionLaunchHintsV1;
}>;

export type {
  AcpForkSessionRequestV1,
  AcpLoadSessionRequestV1,
  BackendSurfaceBaseFailureCodeV1,
  BackendSurfaceDiagnosticV1,
  CheckpointAvailabilityOperationV1,
  CheckpointAvailabilityRequestV1,
  CheckpointDescriptorV1,
  CheckpointProviderTargetRefV1,
  CheckpointRestoreAnchorEvidenceV1,
  CheckpointRestoreAnchorV1,
  CheckpointRestoreScopeV1,
  CheckpointTimingV1,
  CreateCheckpointRequestV1,
  ForkPointV1,
  HandoffExportResultV1,
  HandoffFailureCodeV1,
  HandoffImportRequestV1,
  ListCheckpointsRequestV1,
  RecoverableTurnFailurePromptMode,
  RecoverableTurnFailureRetryDecision,
  RecoverableTurnFailureSecondFailureDecision,
  ResolveCheckpointRestoreTargetRequestV1,
  RestoreCheckpointByAnchorRequestV1,
  RestoreCheckpointByTargetRequestV1,
  RestoreCheckpointFailureCodeV1,
  RestoreCheckpointRequestV1,
  RuntimeConfigUpdateOutcomeV1,
  RuntimeOutboundTranscriptUsageObservationV1,
  TerminalAttachmentId,
  TerminalControlCapture,
  TerminalControlCaptureResult,
  TerminalControlSendFailureReason,
  TerminalControlSendResult,
  TerminalControlUnsupportedReason,
  TerminalHostAttachMetadata,
  TerminalInjectionDuplicateRisk,
  TerminalInjectionFailurePhase,
  TerminalInputReadinessStatusV1,
  TerminalInputReadinessV1,
  TerminalSpecialKey,
} from '@happier-dev/agents';
export type { ShellCommandDialect } from '@happier-dev/agents/process/shellCommand';
/** @realm any */
export type {
    AgentProviderBindingLaunchMaterializationV1,
    AttachSurfaceStaticMetadataV1,
    ProviderBindingCanonicalJsonValue,
} from '@happier-dev/protocol';
export type {
    BackendSurfaceAvailabilityV1,
    PluginAgentAcpTransport as AgentAcpTransport,
    ProviderBoundModelRef,
    ProviderTranscriptDispatchRequestV1,
    RuntimeConfigOutcomeChangeKeyV1,
    RuntimeConfigOutcomeStatusV1,
    RuntimeConfigOutcomeTimingV1,
    SkillCatalogItemV1,
    SkillCatalogV1,
    TranscriptRawAgentEventV1,
    VendorPluginCatalogItemV1,
    VendorPluginCatalogV1,
} from '@happier-dev/protocol';
/** @realm any */
export type {
  SessionContextUsageSnapshotV1,
  UsageObservationContext,
  UsageObservationCost,
  UsageObservationScope,
  UsageObservationTokens,
} from '@happier-dev/protocol/runtime';

export type ForkAvailabilityRequestV1 = Readonly<{
  operation: 'fork' | 'resolveReplayChildLaunch';
  parentSessionId: string;
  parentMetadata: ForkSessionMetadata;
  directory: string;
  forkPoint: ForkPointV1;
}>;

export type ForkRequestV1 = Readonly<{
  parentSessionId: string;
  parentMetadata: ForkSessionMetadata;
  directory: string;
  forkPoint: ForkPointV1;
  acp?: AcpSessionOperationsV1;
}>;

export type ReplayForkChildLaunchRequestV1 = Readonly<{
  parentSessionId: string;
  parentMetadata: ForkSessionMetadata;
  directory: string;
  forkPoint: ForkPointV1;
}>;

export type ForkSurfaceV1 = Readonly<{
  evaluateAvailability?: (
    request: ForkAvailabilityRequestV1,
  ) => BackendSurfaceAvailabilityV1 | Promise<BackendSurfaceAvailabilityV1>;
  fork?: (request: ForkRequestV1) => ForkResultV1 | null | Promise<ForkResultV1 | null>;
  resolveReplayChildLaunch?: (
    request: ReplayForkChildLaunchRequestV1,
  ) => BackendSessionLaunchHintsV1 | null | Promise<BackendSessionLaunchHintsV1 | null>;
}>;

export type HandoffAvailabilityRequestV1 = Readonly<{
  operation: 'exportBundle' | 'importBundle';
  sessionId?: string;
  metadata?: HandoffExportSessionMetadata;
}>;

export type HandoffExportRequestV1 = Readonly<{
  sessionId: string;
  metadata: HandoffExportSessionMetadata;
  directory: string;
}>;

export type HandoffSurfaceV1 = Readonly<{
  evaluateAvailability?: (
    request: HandoffAvailabilityRequestV1,
  ) => BackendSurfaceAvailabilityV1 | Promise<BackendSurfaceAvailabilityV1>;
  exportBundle: (
    request: HandoffExportRequestV1,
  ) => BackendSurfaceResultV1<HandoffExportResultV1, HandoffFailureCodeV1>
    | Promise<BackendSurfaceResultV1<HandoffExportResultV1, HandoffFailureCodeV1>>;
  importBundle: (
    request: HandoffImportRequestV1,
  ) => BackendSurfaceResultV1<HandoffImportResultV1, HandoffFailureCodeV1>
    | Promise<BackendSurfaceResultV1<HandoffImportResultV1, HandoffFailureCodeV1>>;
}>;

export type RuntimeOutboundTranscriptToolNormalizationV1 = Readonly<{
  normalizeToolCallV2: (params: Readonly<{
    protocol: 'acp' | 'claude' | 'codex';
    provider: string;
    toolName: string;
    rawInput: unknown;
    callId?: string;
  }>) => Readonly<{
    canonicalToolName: string;
    input: unknown;
  }>;
  normalizeToolResultV2: (params: Readonly<{
    protocol: 'acp' | 'claude' | 'codex';
    provider: string;
    rawToolName: string;
    canonicalToolName: string;
    rawOutput: unknown;
  }>) => unknown;
}>;
