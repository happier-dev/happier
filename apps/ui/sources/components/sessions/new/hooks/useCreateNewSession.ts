import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import { resolveMachineRetentionNativeIntentV1 } from '@happier-dev/protocol/machines/managed/resolveMachineRetentionPolicyV1';
import { useOpenExecutionRunLauncherDraft } from '@/components/sessions/runs/launcher/useOpenExecutionRunLauncherDraft';
import { sessionModelPickerValueFromRef, sessionModelSelectionKey } from '@/components/sessions/modelPicker/sessionModelSelectionKey';
import { canCreateSessionWithInitialAccess, useSessionCollaborationAvailability } from '@/hooks/session/useSessionCollaborationAvailability';
import * as React from 'react';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';

import { t } from '@/text';
import { getErrorMessage } from '@/utils/errors/getErrorMessage';
import { Modal } from '@/modal';
import { createPluginActionCallerContext } from '@/components/plugins/surfaces/pluginActionCallerContext';
import { getMachineSentenceName } from '@/utils/sessions/machineDisplayNames';
import { resolveAgentCatalogProjection } from '@/agents/backendCatalog/agentCatalogProjection';
import { presentMachineAgentStartRefusal, presentMachineAgentUpdateNotice } from '@/components/machines/agents/presentMachineAgentStartRefusal';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { confirmAgentInstallChange } from '@/components/settings/agents/install/agentInstallChangeConfirm';
import { readMachineAgentsForScope, type MachineAgentsSnapshot } from '@/agents/machineAgents/useMachineAgents';
import { resolveMachineAgentAcquireIntentV1, resolveMachineAgentExecutionStateV1 } from '@happier-dev/protocol/capabilities/machineAgentInventory';
import { sync } from '@/sync/sync';
import { actionOperationPresentationCoordinator } from '@/components/inbox/actionOperations/actionOperationPresentationRuntime';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { useAccountSettingsScope, useApplyAuthoringMemoryDelta } from '@/sync/store/settingsWriters';
import { rememberLastUsedBackendSelection } from '@/sync/domains/state/newSessionTargetUiState';
import { storage, useSetting } from '@/sync/domains/state/storage';
import { resolveTerminalSpawnOptions } from '@/sync/domains/settings/terminalSettings';
import { areServerProfileIdentifiersEquivalent, getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveNewSessionServerTarget } from '@/sync/domains/server/selection/serverSelectionResolver';
import { getMissingRequiredConfigEnvVarNames } from '@/utils/profiles/profileConfigRequirements';
import type { SecretChoiceByProfileIdByEnvVarName } from '@/utils/secrets/secretRequirementApply';
import { getBuiltInProfile } from '@/sync/domains/profiles/profileUtils';
import { isProfileCompatibleWithBackendTarget, type AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import type { SavedSecretReferenceResolution } from '@/sync/store/settings/savedSecretCatalogSnapshot';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { captureActiveServerAccountScopeLifetime, getActiveServerAccountScope, selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import { getPromptLibraryCatalogValue } from '@/sync/store/settings/promptLibraryCatalogSnapshot';
import { readCurrentPromptLibraryCatalogValue } from '@/sync/engine/settings/promptLibraryCatalogEngine';
import { resolveEffectiveWindowsRemoteSessionLaunchMode } from '@/sync/domains/session/spawn/windowsRemoteSessionLaunchMode';
import { getAgentCore, isBundledAgentId, type AgentId } from '@/agents/catalog/catalog';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { buildLastUsedBackendTargetSettings } from '@/agents/backendCatalog/buildLastUsedBackendTargetSettings';
import { buildSpawnEnvironmentVariablesFromUiState, buildSpawnSessionExtrasFromUiState, getAgentResumeExperimentsFromSettings, getNewSessionPreflightIssues } from '@/agents/catalog/catalog';
import type {
    AgentPluginSettingsReadiness,
    AgentPluginSettingsSnapshot,
} from '@/agents/registry/registryUiBehavior';
import { resolveNewSessionBehaviorAgentId } from '@/components/sessions/new/modules/newSessionBehaviorAgent';
import { resolveStrictV2ProfileSecretReadiness } from '@/components/sessions/new/modules/resolveStrictV2ProfileSecretReadiness';
import { isLaunchProfileReviewCurrent } from '@/components/sessions/new/modules/profileHelpers';
import type { UseMachineEnvPresenceResult } from '@/hooks/machine/useMachineEnvPresence';
import { getMachineCapabilitiesSnapshot } from '@/hooks/server/useMachineCapabilitiesCache';
import type { PermissionMode, ModelMode } from '@/sync/domains/permissions/permissionTypes';
import { getModelOptionsForAgentType, type PreflightModelList } from '@/sync/domains/models/modelOptions';
import {
    type BackendTargetRefV2,
    type BackendTargetRefV2Input,
    type PersistedBackendTargetRefV2} from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import {
    type ProviderErrorV1} from '@happier-dev/protocol/providers/errors';
import {
    type SecretReferenceOverlayV1} from '@happier-dev/protocol/profiles/secretReferenceOverlayV1';
import {
    type WindowsRemoteSessionLaunchMode,
} from '@happier-dev/protocol/sessions/metadata/windowsRemoteSessionLaunchMode';
import type { AcpConfigOptionOverridesV1} from '@happier-dev/protocol/sessions/metadata/overrides';
import type { ComposerSnapshotV1} from '@happier-dev/protocol/plugins/ui/composer';
import type { RawIngressStructuredInputV1 } from '@happier-dev/protocol/runtime/input/structuredInputV1';
import type { SessionSpawnNewInitialInputV1, SessionSpawnNewInputV2 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import type { SessionAgentUpdateNoticeV1, SessionSpawnNewInitialInputDispositionV1, SessionSpawnNewResultV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { awaitManualSessionSpawnOperation, readManualSessionSpawnOperation } from '@/sync/domains/session/spawn/manualSessionSpawnOperation';
import { getSessionInputFailureLabelKey } from '@/components/sessions/pending/pendingMessageVisualState';
import type { SessionManagedCreationV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import type { AttachmentDraft } from '@/components/sessions/attachments/attachmentDraftModel';
import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { parsePermissionIntentAlias } from '@happier-dev/agents';
import { nowServerMs } from '@/sync/runtime/time';
import { canInvokePromptTemplate, resolveSessionComposerSend } from '@/sync/domains/input/slashCommands/resolveSessionComposerSend';
import { executeSessionComposerResolution } from '@/sync/domains/input/slashCommands/executeSessionComposerResolution';
import { expandPromptTemplateInvocation } from '@/sync/domains/input/slashCommands/expandPromptTemplateInvocation';
import { resolvePromptInvocationComposerSendAction } from '@/sync/domains/input/slashCommands/promptInvocationBehavior';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { bindPluginUiNewSessionPostCreateActionV1 } from '@happier-dev/protocol/plugins/ui';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import { formatActionFailureDetails } from '@/utils/errors/alertActionFailure';
import { randomUUID } from '@/platform/randomUUID';
import {
    classifyLaunchRetryFailure,
    promptDaemonUnavailableRetry,
    showDaemonUnavailableAlert,
} from '@/utils/errors/daemonUnavailableAlert';
import { captureExceptionIfEnabled } from '@/utils/system/sentry';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { moveSessionApprovalConsentsOnContinue } from '@/sync/ops/actions/moveSessionApprovalConsentsOnContinue';
import { useMountedRef } from '@/hooks/ui/useMountedRef';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { useNewSessionEmbeddedHost, useNewSessionHostCreationProfile, useNewSessionHostSpawnExecutor } from '@/components/sessions/new/navigation/newSessionHost';
import { isHostBoundNewSessionMachine } from '@/components/sessions/new/modules/canCreateNewSession';
import { createNewSessionActionOperationOrigin } from '@/components/sessions/new/navigation/newSessionActionOperationOrigin';
import { createSubmittedDraftLaunchPublication } from '@/components/sessions/new/modules/newSessionLaunchPublication';
import { resolveNewSessionAfterSend } from '@/components/sessions/new/modules/newSessionAfterSend';
import { newSessionBackgroundLaunches } from '@/components/sessions/new/modules/newSessionBackgroundLaunches';
import type { NewSessionAfterSendMode } from '@/sync/domains/settings/registry/account/accountSessionCreationSettingDefinitions';
import { createPresentedFirstTurnSettlement } from '@/components/sessions/new/modules/presentedFirstTurnSettlement';
import { ConnectedServiceBindingsV2IngressSchema } from '@happier-dev/protocol/connect/connected-service-bindings';
import {
    clearLaunchingNewSessionFirstTurn,
    presentCreatedNewSession,
    projectAcceptedNewSessionFirstTurn,
    projectLaunchingNewSessionFirstTurn,
    settleNewSessionFirstTurnLaunch,
} from '@/components/sessions/new/navigation/presentCreatedNewSession';
import {
    CreatedNewSessionCompletionError,
    createCreatedNewSessionCompletion,
} from '@/components/sessions/new/navigation/completeCreatedNewSession';
import type { SessionCapabilitySelectionV1 } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';
import type { SessionSpawnSourceContextV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnSourceContextV1';
import type { NewSessionCheckoutCreationDraft } from '@/sync/domains/state/newSessionCheckoutDraft';
import { resolveNewSessionOperationalBackendTarget } from '@/components/sessions/new/modules/newSessionCapabilityProbeContext';
import {
    buildNewSessionLaunchScopeKey,
    normalizeLaunchScopePart,
} from '@/components/sessions/new/modules/newSessionLaunchScope';
import { resolveServerIdForSessionIdFromLocalCache } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';
import { runWithHomeCredentialRequestSignal } from '@/sync/runtime/orchestration/serverScopedRpc/serverAccountScopeRequestGuard';
import {
    buildNewSessionAuthoringDraftFromResolvedInputs,
    buildNewSessionTempDataFromAuthoringDraft,
    buildSessionServerStartSpawnDraftV1FromAuthoringDraft,
    buildSessionSpawnNewInputV2FromAuthoringDraft,
    buildManagedAcquireAgentStartV1FromAuthoringDraft,
} from '@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters';
import { buildNewSessionConfigurationDraft } from '@/components/sessions/authoring/draft/sessionConfigurationSeed';
import { seedAndOpenNewSession } from '@/components/sessions/new/newSessionSeedComposer';
import { buildNewSessionLaunchRouteParams } from '@/components/sessions/new/navigation/newSessionRouteParams';
import type { NewSessionConnectedServicesResult } from '../modules/useNewSessionConnectedServices';
import type { SessionAuthoringDraft } from '@/components/sessions/authoring/draft/sessionAuthoringDraft';
import {
    adoptNewSessionLaunchAttemptCustody,
    createNewSessionLaunchAttempt,
    isNewSessionLaunchAttemptInScope,
    markNewSessionLaunchAttemptComplete,
    markNewSessionLaunchAttemptCreated,
    markNewSessionLaunchAttemptFailed,
    markNewSessionLaunchAttemptSpawning,
    shouldSpawnForNewSessionLaunchAttempt,
    type NewSessionLaunchAttempt,
} from '@/components/sessions/new/modules/newSessionLaunchAttempt';
import { resolveAgentExecutionTargetForBackendTarget } from '@/agents/backendCatalog/resolveAgentExecutionTargetForBackendTarget';
import type { DaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import type { NewSessionPromptStore } from '@/components/sessions/new/hooks/screenModel/newSessionPromptStore';
import {
    buildSessionModelsSeedRequest,
    publishSessionModelsSeedToMetadata,
} from '@/sync/domains/models/sessionModelsSeed';
import {
    buildManualSessionCreationKey,
    completeManualSessionSpawnNewActionCustody,
    executeManualSessionSpawnNewAction,
    executeSessionSpawnNewAction,
    projectManualSessionSpawnOperationResult,
    resolveSessionSpawnNewActionFailureMessage,
    resolveSessionSpawnNewResultFailureMessage,
    resolveSessionSpawnNewInitialInputFailureMessage,
    type ManualSessionSpawnNewActionCustody,
    type SessionSpawnNewActionResult,
    type SessionSpawnNewCommittedReceipt,
} from '@/sync/ops/actions/sessionSpawnNewAction';
import { isSessionSpawnGuestReconnectFailure, presentSessionCredentialReconnectFailure,
    presentSessionSpawnNewAgentIsolationFailure, readSessionSpawnNewFailure } from '@/sync/ops/actions/sessionSpawnFailurePresentation';
import {
    captureNewSessionDraftLaunchCurrentness,
    captureNewSessionDraftWorkflowCurrentness,
    clearCapturedNewSessionDraftAfterLaunch,
    preserveCreatedSessionDraftAfterUnacceptedFirstTurn,
    preserveCreatedSessionSuccessorDraft,
    readNewSessionDraftLaunchConfigurationUpdatedAtMs,
    releaseNewSessionDraftLaunchAttempt,
} from '@/components/sessions/new/modules/newSessionDraftLifecycle';
import { actionOperationSelectors } from '@/sync/domains/actionOperations/actionOperationSelectors';
import type { IssuedUploadedAttachment } from '@/components/sessions/attachments/uploadAttachmentDraftsToSession';
import type { ExactSessionMachineTargetIdentity } from '@/sync/ops/sessionMachineTarget';
import type { NewSessionDraft } from '@/sync/domains/state/persistence';
import { persistCreatedSessionAuthoringOrigin } from '@/components/sessions/new/modules/newSessionAuthoringOrigin';
import { supportsMachineOperationProtocolCapabilityV1 } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';
import { readSpawnAttemptCustodyState } from '@/sync/domains/session/spawn/spawnAttemptNonceStore';
import type { ManagedMachineSelectionDraft, ManagedMachineAcquisitionDraft } from '@/sync/domains/state/newSessionManagedMachineDraft';
import { isDeferredManagedMachineAuthorPresetDraft, readManagedMachineSelectionReceipt, readManagedMachineSelectionName, managedMachineCreationIntent } from '@/sync/domains/state/newSessionManagedMachineDraft';
import { getSessionDraftSnapshot } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import type { NewSessionPreparedInstructions } from '../modules/newSessionLaunchIntent';
import { runManagedMachineCreation, type ManagedMachineCreationProgress } from '@/components/settings/machines/managed/managedMachineCreation';
import { describeManagedMachineDeleteWork } from '@/components/settings/machines/managed/managedMachineDeleteReview';
import { prepareNewSessionSpaceMembership } from '../organization/prepareNewSessionSpaceMembership';
import { useManagedMachineInventory } from '@/components/settings/machines/managed/useManagedMachineInventory';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { bindNewManagedMachineCreationScope } from '@/sync/ops/actions/managedCreationScopeBinding';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { awaitActionApprovalResult, createActionApprovalContinuation, type ActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import { readActionApprovalRequestCreatedError } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { captureLazyActionAccountContext, type LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { sessionInstructionsActions } from '@/sync/ops/promptLibrary/sessionInstructions';
import type { SessionInstructionsAuthoringDraft } from '@/sync/domains/state/sessionInstructionsDraft';
import { NewSessionInstructionsPreparationError } from '@/components/sessions/new/modules/newSessionInstructionsPreparation';
import { SessionPromptStackV1Schema, writeSessionContextIntentV1ToMetadata, type SessionPromptStackV1 } from '@happier-dev/protocol/sessions/context/sessionContextV1';
import { buildSessionInstructionsContextIntentV1 } from '@happier-dev/protocol/actions/sessionStateFieldActions';
import { readNewSessionDraftFromRepository, takeNewSessionDraftPostCreateAction, writeNewSessionInstructionsToRepository } from '@/components/sessions/composer/newSessionDraftRepositoryAdapter';
import { machinePageHref } from '@/components/settings/machines/collection/machineCollectionModel';
export type CreatedSessionFollowUpContext = Readonly<{
    sessionId: string;
    sessionTarget: ExactSessionMachineTargetIdentity;
    /** Accepted creation follow-up borrows Account custody beyond route presentation. */
    signal?: AbortSignal;
    effectiveSpawnServerId: string | null;
    launchAttempt: NewSessionLaunchAttempt;
    /**
     * Runner creation has already uploaded and digest-verified its immutable
     * staged bytes. The incumbent post-create owner consumes this projection
     * instead of opening the mutable attachment drafts a second time.
     */
    preuploadedAttachments?: readonly IssuedUploadedAttachment[];
}>;

export type NewSessionAfterCreatedSettlement =
    /**
     * Reporting a fabricated id, or reporting `rejected` for a submission that
     * was accepted, would tell the Composer document owner its submitted
     * snapshot never landed.
     */
    | Readonly<{ status: 'accepted'; sessionId: string | null }>
    | Readonly<{ status: 'rejected' }>;

export type TemporaryComputerCreatorSettlement = Readonly<{
    attachmentMessageLocalId: string;
    firstTurnLocalId: string;
    /** Presents the already-materialized ordinary Session before transfer work. */
    present: (sessionId: string) => Promise<void>;
    /** Completes digest-gated prompt admission and captured-draft settlement. */
    complete: (sessionId: string, uploaded: readonly IssuedUploadedAttachment[]) => Promise<void>;
    /** Called when the activation is definitively abandoned or closed. */
    reject: () => void;
}>;

export type HandleCreateSessionOptions = Readonly<{
    /** Create the reviewed Machine and keep this composer draft without starting a Session. */
    managedMachineOnly?: boolean;
    /** What follows this Send, overriding the "After sending" setting. */
    afterSend?: NewSessionAfterSendMode;
    managedMachineRetryInstallation?: boolean;
    managedMachineSetupRecovery?: 'retry' | 'skip' | 'delete';
    initialMessage?: 'send' | 'skip';
    inputTextOverride?: string;
    initialInputStructuredInput?: RawIngressStructuredInputV1;
    initialInputReviewComments?: SessionSpawnNewInitialInputV1['reviewComments'];
    afterCreated?: (context: CreatedSessionFollowUpContext) => void | Promise<void>;
    /**
     * Optional projection of this call's incumbent post-create follow-up terminal result.
     * It never changes create, retry, navigation, or persistence behavior.
     */
    onAfterCreatedSettled?: (settlement: NewSessionAfterCreatedSettlement) => void;
    /**
     * A mounted composer document owns the visible draft and clears its accepted
     * snapshot itself; launch settlement must not switch off that document's
     * persistence, so edits made after Send stay persistable. Settlement still
     * retires the sent draft once its Session exists.
     */
    deferAcceptedDraftClearToDocument?: boolean;
    /**
     * D2: relaunch under the newly-selected connected-service account WITHOUT resume continuity, after
     * the "switch unavailable" dialog offered "start fresh". Drops the vendor resume reference so the
     * new account begins a clean conversation instead of fail-closing again on an unreachable resume.
     */
    startFreshUnderNewAccount?: boolean;
    temporaryComputerSubmission?: Readonly<{
        composer: ComposerSnapshotV1;
        /**
         * Review comments frozen at Send. The mounted composer owner is the only
         * place they can still be read, and a Temporary-computer launch settles
         * after that owner may have unmounted, so the exact included set travels
         * with the prepared submission instead of being reread later.
         */
        reviewComments: Readonly<{
            workspace: WorkspaceScopeBase;
            comments: readonly ReviewCommentDraft[];
        }> | null;
        attachmentDrafts: readonly AttachmentDraft[];
        attachmentDestination: Readonly<{
            uploadLocation: 'workspace' | 'os_temp';
            workspaceRelativeDir: string;
            vcsIgnoreStrategy: 'git_info_exclude' | 'gitignore' | 'none';
            vcsIgnoreWritesEnabled: boolean;
        }>;
        maxFileBytes: number;
    }>;
}>;

type LaunchErrorScopeParams = Readonly<{
    selectedMachineId: string | null;
    targetServerId?: string | null;
    allowedTargetServerIds?: ReadonlyArray<string>;
    agentType: string;
    backendTarget?: PersistedBackendTargetRefV2;
    spawnBackendTarget?: BackendTargetRefV2Input;
    useProfiles: boolean;
    selectedProfileId: string | null;
    authoringDraft?: SessionAuthoringDraft | null;
    /** Canonical creation context already read by the mounted authoring owner. */
    managedDefaultsContext?: NonNullable<ActionExecutorContext['sessionCreationDefaults']>['context'];
    managedDefaultsUnavailable?: NonNullable<ActionExecutorContext['sessionCreationDefaults']>['unavailableDefaults'];
    /** Original authored choices, before automatic placement and Agent defaults. */
    managedDefaultsAuthoredChoices?: NonNullable<ActionExecutorContext['sessionCreationDefaults']>['authoredChoices'];
    modelMode: ModelMode;
}>;

type NewSessionLaunchFailure = Readonly<{ scopeKey: string }> & (
    | Readonly<{ kind: 'provider'; error: ProviderErrorV1 }>
    | Readonly<{ kind: 'profile'; profileId: string; message: string; profile: AIBackendProfile | null }>
);

/**
 * Only an ordinary Machine launch may outlive its screen. A Temporary computer keeps its visible, stoppable
 * acquisition on the draft that started it, and an embed's host-owned creation ends with its host.
 */
function isNewSessionLaunchBackgroundable(
    params: Readonly<{
        authoringOrigin?: unknown;
        managedMachineSelection?: unknown;
        authoringDraft?: SessionAuthoringDraft | null;
    }>,
    embeddedHost: ReturnType<typeof useNewSessionEmbeddedHost>,
    hostSpawnExecutor: unknown,
): boolean {
    return !hostSpawnExecutor
        && !params.authoringOrigin
        && !params.managedMachineSelection
        && params.authoringDraft?.automation?.enabled !== true
        && params.authoringDraft?.executionTarget?.kind !== 'temporary_computer'
        && (embeddedHost?.kind === 'docked' || embeddedHost?.createdSessionPresentation !== 'inPlace');
}

function resolveStaticAgentId(params: Readonly<{
    agentType: string;
    staticAgentId?: AgentId | null;
}>): AgentId | null {
    if (isBundledAgentId(params.staticAgentId)) {
        return params.staticAgentId;
    }
    return isBundledAgentId(params.agentType) ? params.agentType : null;
}

function readLaunchIntent(params: Readonly<{
    launchIntentSignature: string;
    readLaunchIntentSignature?: (preparedInstructions?: NewSessionPreparedInstructions) => string;
}>, preparedInstructions?: NewSessionPreparedInstructions): string {
    return params.readLaunchIntentSignature?.(preparedInstructions) ?? params.launchIntentSignature;
}

function resolveNewSessionLaunchTargetServerId(params: Readonly<{
    targetServerId?: string | null;
    allowedTargetServerIds?: ReadonlyArray<string>;
}>): string | null {
    if (params.targetServerId === null) return null;
    const requestedServerId = typeof params.targetServerId === 'string' ? params.targetServerId.trim() : '';
    const snapshot = getActiveServerSnapshot();
    const allowedServerIds = Array.isArray(params.allowedTargetServerIds)
        ? params.allowedTargetServerIds
        : [snapshot.serverId];
    const targetResolution = resolveNewSessionServerTarget({
        requestedServerId,
        activeServerId: snapshot.serverId,
        allowedServerIds,
    });
    return targetResolution.targetServerId;
}

function buildLaunchErrorScopeKey(
    params: LaunchErrorScopeParams,
    resolvedTargetServerId?: string,
    kind: NewSessionLaunchFailure['kind'] = 'provider',
): string {
    const modelRef = params.authoringDraft?.modelSelection?.ref ?? null;
    const backendTarget = params.backendTarget
        ?? params.spawnBackendTarget
        ?? { kind: 'backend' as const, backendId: params.agentType };
    return JSON.stringify([
        normalizeLaunchScopePart(params.selectedMachineId),
        resolvedTargetServerId ?? resolveNewSessionLaunchTargetServerId(params) ?? 'no-target',
        params.agentType,
        resolveBackendTargetKeyV2(backendTarget),
        params.useProfiles,
        normalizeLaunchScopePart(params.selectedProfileId),
        ...(kind === 'provider' ? [modelRef
            ? sessionModelSelectionKey(sessionModelPickerValueFromRef(modelRef)) : params.modelMode] : []),
    ]);
}

function readCurrentLaunchFailure(failure: NewSessionLaunchFailure | null,
    params: LaunchErrorScopeParams & Readonly<{ profileMap: ReadonlyMap<string, AIBackendProfile> }>): NewSessionLaunchFailure | null {
    if (!failure || failure.scopeKey !== buildLaunchErrorScopeKey(params, undefined, failure.kind)) return null;
    if (failure.kind === 'provider') return failure;
    const profile = params.useProfiles && params.selectedProfileId
        ? params.profileMap.get(params.selectedProfileId) ?? getBuiltInProfile(params.selectedProfileId) ?? null : null;
    return failure.profile === profile || isLaunchProfileReviewCurrent(failure.profile, profile) ? failure : null;
}

export function useCreateNewSession(params: Readonly<{
    router: { push: (options: any) => void; replace: (path: any, options?: any) => void };

    selectedMachineId: string | null;
    /** The authored folder; with `directoryKind: 'managed'` it is only remembered, never launched in. */
    selectedPath: string;
    /** `managed`: no folder; the target machine keeps a private one for the session. */
    directoryKind?: 'path' | 'managed';
    getRequestedPath?: () => string;
    selectedMachine: any;
    managedMachineSelection?: ManagedMachineSelectionDraft | null;
    managedMachineAcquisition?: ManagedMachineAcquisitionDraft | null;
    onManagedMachineAcquisitionChange?: (value: ManagedMachineAcquisitionDraft | null) => void;
    /** Session continuation waits for the enrolled Agent; Machine-only creation just adopts the target. */
    onManagedMachineEnrolled?: (machineId: string, signal: AbortSignal, options?: Readonly<{ waitForAgent?: boolean }>) => Promise<void>;
    onManagedMachineDeleteRequested?: () => void;

    setIsCreating: (v: boolean) => void;
    setIsResumeSupportChecking: (v: boolean) => void;

    /**
     * Legacy compatibility only.
     * New-session checkout materialization is now driven exclusively by `checkoutCreationDraft`.
     */
    checkoutCreationDraft?: NewSessionCheckoutCreationDraft | null;
    useProfiles: boolean;
    selectedProfileId: string | null;
    profileMap: Map<string, AIBackendProfile>;

    recentMachinePaths: Array<{ machineId: string; path: string }>;

    /** Runtime/catalog identity. This can be a projected external Agent id. */
    agentType: string;
    /** Explicit bundled behavior backing; absent for unbacked external Agents. */
    staticAgentId?: AgentId | null;
    /**
     * The OPERATIONAL Agent identity of the current selection — the Agent that
     * owns the backend at runtime, bundled or installed. It is the same identity
     * the composer renders this Agent's declared options under, so the spawn
     * envelope is built from the declaration the user actually saw.
     */
    runtimeCarrierAgentId?: string | null;
    /** Exact scoped Settings values for the selected operational Agent. */
    pluginSettings?: AgentPluginSettingsSnapshot | null;
    /** Readiness of that exact scoped Settings record; defaults are not launch-safe. */
    pluginSettingsReadiness?: AgentPluginSettingsReadiness | null;
    backendTarget?: PersistedBackendTargetRefV2;
    spawnBackendTarget?: BackendTargetRefV2Input;
    transcriptStorage?: 'persisted' | 'direct';
    executionRunsEnabled?: boolean;
    permissionMode: PermissionMode;
    modelMode: ModelMode;
    /**
     * Optional: seed ACP "agent mode" (e.g. OpenCode plan/build) at session start.
     * Applied before the first message is sent.
     */
    acpSessionModeId?: string | null;
    sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1 | null;
    preflightModels?: PreflightModelList | null;
    preflightModelsTargetKey?: string | null;
    presentConnectedAccountPoolFailure?: NewSessionConnectedServicesResult['presentConnectedAccountPoolFailure'];

    promptStore: NewSessionPromptStore;
    /** Leaf-local title edits are captured at Send, before any asynchronous placement. */
    getSessionName?: () => string;
    getInstructionsDraft?: () => SessionInstructionsAuthoringDraft | null;
    getInstructionsPromptStack?: () => SessionPromptStackV1 | undefined;
    /** Flushes the mounted input into its canonical draft before an asynchronous handoff. */
    flushComposerInput?: () => void;
    /** Commits the submitted selections before capturing revision-safe launch custody. */
    flushAuthoringDraft?: () => void;
    setSessionPrompt?: (prompt: string) => void;
    resumeSessionId: string;
    agentNewSessionOptions?: Record<string, unknown> | null;
    authoringDraft?: SessionAuthoringDraft | null;
    /** Public source names already read by the mounted recipient catalog. Never executable input. */
    teamCredentialPresentation?: ActionExecutorContext['teamCredentialPresentation'];
    spaceMembership?: import('@happier-dev/protocol/actions').SessionSpaceMembershipTargetV1 | null;
    authoringCommitPending?: boolean;
    /** Fresh admission of inherited Connected Account purpose defaults; explicit choices bypass in their owner. */
    requireConnectedAccountDefaultsReady?: () => void;
    teamCredentialModelReady?: boolean;
    capabilitySelection?: SessionCapabilitySelectionV1 | null;
    windowsRemoteSessionLaunchModeOverride?: WindowsRemoteSessionLaunchMode | null;

    machineEnvPresence: UseMachineEnvPresenceResult;
    secrets: readonly SavedSecret[];
    secretBindingsByProfileId: Record<string, Record<string, string>>;
    selectedSecretIdByProfileIdByEnvVarName: SecretChoiceByProfileIdByEnvVarName;
    resolveSavedSecretReference: (ref: string) => SavedSecretReferenceResolution;
    sessionOnlySecretValueByProfileIdByEnvVarName: SecretChoiceByProfileIdByEnvVarName;

    selectedMachineCapabilities: any;
    targetServerId?: string | null;
    allowedTargetServerIds?: ReadonlyArray<string>;
    /**
     * Authoritative-only projection inputs for spawn-target qualification. The
     * New Session screen model passes null unless the selected machine's
     * projection phase is `ready`, so a generation that is loading, errored,
     * retired, or not yet fetched can never qualify a non-bundled target here
     * and the spawn fails closed instead of launching a stale qualified Agent.
     * Callers that hand the machine's retained inputs straight through re-open
     * that bypass.
     */
    daemonMergedProjectionInputs?: Pick<
        DaemonMergedProjectionInputs,
        'mergedBackendProjectionById' | 'mergedProviderProjectionById'
    > | null;
    draftScope?: ServerAccountScope | null;
    authoringOrigin?: NewSessionDraft['authoringOrigin'];
    /** Qualified target Account captured by the creator, including cross-Home launches. */
    targetAccountScope?: ServerAccountScope | null;
    /** Qualified target authority for Temporary-computer activation and Session presentation. */
    temporaryComputerTargetScope?: ServerAccountScope | null;
    /** Commits the exact draft into the target Account before activation custody can begin. */
    prepareTemporaryComputerLaunchDraft?: (input: Readonly<{
        sourceScope: ServerAccountScope;
        targetScope: ServerAccountScope;
        draftId: string;
    }>) => Promise<void>;
    draftId?: string;
    disableDraftPersistence?: () => void;
    onLaunchAttemptChange?: (attempt: NewSessionLaunchAttempt | null) => void;
    /** Opens a fresh draft in this surface; the launch handed to the background keeps running. */
    onStartAnother?: () => void;
    launchIntentSignature: string;
    /** The same authored identity, read from live composer input at Send. */
    readLaunchIntentSignature?: (preparedInstructions?: NewSessionPreparedInstructions) => string;
    launchUserAttemptId?: string | null;
    onLaunchUserAttemptIdChange?: (userAttemptId: string | null) => void;
    /** Retains the original creation completion while the exact approval is pending. */
    onLaunchApprovalPending?: (approval: ActionApprovalContinuation) => void;
    /**
     * Continuation recipe when this draft was seeded from another Session. It is
     * required semantics: the target daemon resolves the source transcript
     * before creating the child, and the authoring draft/chip survives failure.
     * The UI never retries without it.
     */
    sourceContext?: SessionSpawnSourceContextV1 | null;
    /** Continue after a failed resume: the source Session whose approval rows move to the child. */
    continuationSourceSessionId?: string | null;
    /** Canonical Temporary-computer activation owner. Automation never reaches this callback. */
    temporaryComputerLaunch?: (
        submission: NonNullable<HandleCreateSessionOptions['temporaryComputerSubmission']>,
        settlement: TemporaryComputerCreatorSettlement,
    ) => Promise<void>;
}>): Readonly<{
    handleCreateSession: (opts?: HandleCreateSessionOptions) => Promise<void>;
    /** What Send does once a backgroundable launch starts; undefined when this launch cannot outlive its screen. */
    newSessionAfterSendMode: NewSessionAfterSendMode | undefined;
    /** Lets the in-flight launch outlive this screen (Send and start another). */
    handOffLaunchToBackground: () => void;
    providerLaunchError: ProviderErrorV1 | null;
    profileLaunchFailure: Readonly<{ profileId: string; message: string }> | null;
    retryProviderLaunch: () => void;
    managedMachineCreationProgress: ManagedMachineCreationProgress;
    /** The draft's retained resource row while no operation reports for it: its stages and "Setup interrupted" (58d U5). */
    retainedManagedMachine: Readonly<{ machine: ManagedMachineV1; serverId: string }> | null;
    retryManagedMachineInstallation: () => void;
    retryManagedMachineSetup: () => void;
    continueWithoutManagedMachineSetup: () => void;
    deleteManagedMachineAfterFailedSetup: () => void;
    cancelManagedMachineCreation: () => void;
}> {
    const openExecutionRunDraft = useOpenExecutionRunLauncherDraft();
    // Final Session creation with initial grants is an action admission and intentionally fails closed while unresolved.
    const collaborationAvailability = useSessionCollaborationAvailability(params.targetServerId ?? '');
    // The embedding host's creation executor (the embed's new chat), read at Send through the ref.
    const hostSpawnExecutor = useNewSessionHostSpawnExecutor();
    const embeddedHost = useNewSessionEmbeddedHost();
    const presentsInPlaceRef = React.useRef(false);
    presentsInPlaceRef.current = embeddedHost?.createdSessionPresentation === 'inPlace';
    const hostSpawnExecutorRef = React.useRef(hostSpawnExecutor);
    hostSpawnExecutorRef.current = hostSpawnExecutor;
    const hostCreationProfile = useNewSessionHostCreationProfile();
    const hostCreationProfileRef = React.useRef(hostCreationProfile);
    hostCreationProfileRef.current = hostCreationProfile;
    const collaborationAvailabilityRef = React.useRef(collaborationAvailability);
    collaborationAvailabilityRef.current = collaborationAvailability;
    const mountedRef = useMountedRef();
    const expectedSettingsScope = useAccountSettingsScope();
    const applyAuthoringMemory = useApplyAuthoringMemoryDelta();
    const [launchFailure, setLaunchFailure] = React.useState<NewSessionLaunchFailure | null>(null);
    const latestParamsRef = React.useRef(params);
    const lastCreateOptionsRef = React.useRef<HandleCreateSessionOptions | undefined>(undefined);
    const launchAttemptRef = React.useRef<NewSessionLaunchAttempt | null>(null);
    const launchIntentSignature = params.launchIntentSignature;
    const launchIntentSignatureRef = React.useRef(launchIntentSignature);
    const invalidatedLaunchUserAttemptIdRef = React.useRef<string | null>(null);
    if (launchIntentSignatureRef.current !== launchIntentSignature) {
        launchIntentSignatureRef.current = launchIntentSignature;
        launchAttemptRef.current = null;
        invalidatedLaunchUserAttemptIdRef.current = typeof params.launchUserAttemptId === 'string'
            ? params.launchUserAttemptId.trim() || null
            : null;
    }
    const normalizedLaunchUserAttemptId = typeof params.launchUserAttemptId === 'string'
        ? params.launchUserAttemptId.trim() || null
        : null;
    if (
        invalidatedLaunchUserAttemptIdRef.current !== null
        && normalizedLaunchUserAttemptId !== invalidatedLaunchUserAttemptIdRef.current
    ) {
        invalidatedLaunchUserAttemptIdRef.current = null;
    }
    const launchUserAttemptIdForCurrentIntent = normalizedLaunchUserAttemptId === invalidatedLaunchUserAttemptIdRef.current
        ? null
        : normalizedLaunchUserAttemptId;
    const launchUserAttemptIdForCurrentIntentRef = React.useRef(launchUserAttemptIdForCurrentIntent);
    launchUserAttemptIdForCurrentIntentRef.current = launchUserAttemptIdForCurrentIntent;
    const createInFlightRef = React.useRef(false);
    const launchAbortRef = React.useRef<AbortController | null>(null);
    const launchAbortIntentRef = React.useRef<{ signature: string } | null>(null);
    // An ordinary launch that may outlive its screen is in flight, and whether it was handed off. Without a
    // hand-off, leaving the screen retires the launch; with one, it runs on and only stops presenting here.
    const backgroundableLaunchInFlightRef = React.useRef(false);
    const launchOutlivesSurfaceRef = React.useRef(false);
    const handOffLaunchToBackground = React.useCallback(() => {
        if (!backgroundableLaunchInFlightRef.current || launchOutlivesSurfaceRef.current) return;
        launchOutlivesSurfaceRef.current = true;
        newSessionBackgroundLaunches.begin();
    }, []);
    const managedAcquisitionRef = React.useRef(params.managedMachineAcquisition ?? null);
    const managedAcquisitionPropRef = React.useRef(params.managedMachineAcquisition);
    if (managedAcquisitionPropRef.current !== params.managedMachineAcquisition) {
        managedAcquisitionPropRef.current = params.managedMachineAcquisition;
        managedAcquisitionRef.current = params.managedMachineAcquisition ?? null;
    }
    const [managedProgress, setManagedProgress] = React.useState<Readonly<{ signature: string; value: ManagedMachineCreationProgress }>>({
        signature: launchIntentSignature, value: { kind: 'idle' },
    });
    const sessionOperationAddress = managedProgress.signature === launchIntentSignature && managedProgress.value.kind === 'session_starting'
        ? managedProgress.value.operationAddress : undefined;
    const managedOperationId = sessionOperationAddress?.operationId ?? params.managedMachineAcquisition?.operation?.operationId;
    const managedOperationServerId = params.targetAccountScope?.serverId ?? params.draftScope?.serverId ?? params.targetServerId ?? null;
    const managedOperationAccountId = (params.targetAccountScope ?? params.draftScope)?.accountId;
    const managedOperationControllerId = readManagedMachineSelectionReceipt(params.managedMachineSelection)?.controller?.machineId;
    const managedAcquisitionMatchesSelection = Boolean(params.managedMachineSelection && params.managedMachineAcquisition
        && sameStrictJsonValue(params.managedMachineSelection.selection, params.managedMachineAcquisition.selection));
    const readManagedOperation = React.useCallback(() => {
        if (!managedOperationId || !sessionOperationAddress && !managedAcquisitionMatchesSelection) return null;
        const operation = actionOperationSelectors.selectById(actionOperationStore.getSnapshot(), {
            serverId: sessionOperationAddress?.serverId ?? managedOperationServerId, operationId: managedOperationId,
        });
        return operation && operation.snapshot.scope.accountId === managedOperationAccountId
            && operation.snapshot.scope.machineId === (sessionOperationAddress?.machineId ?? managedOperationControllerId) ? operation : null;
    }, [managedOperationId, managedOperationServerId, managedOperationAccountId, managedOperationControllerId, managedAcquisitionMatchesSelection, sessionOperationAddress]);
    const managedOperation = React.useSyncExternalStore(actionOperationStore.subscribe, readManagedOperation, readManagedOperation);
    const onManagedApprovalExecuted = React.useCallback(() => {}, []);
    const managedApproval = useActionApprovalContinuation({
        scopeKey: `new-session-managed:${params.targetAccountScope?.accountId ?? params.draftScope?.accountId ?? ''}:${launchIntentSignature}`,
        serverId: params.targetAccountScope?.serverId ?? params.targetServerId ?? params.draftScope?.serverId ?? '',
        onExecuted: onManagedApprovalExecuted,
    });
    // Compare against what Send read synchronously, rather than aborting from
    // the previous render's cleanup when the first Starting render catches up.
    React.useEffect(() => {
        if (launchAbortIntentRef.current !== null && launchAbortIntentRef.current.signature !== launchIntentSignature) {
            launchAbortRef.current?.abort();
        }
    }, [launchIntentSignature]);
    // Admission can publish the target binding for the draft's same Account
    // while its host-owned Send is in flight. Cancel on authority changes,
    // not when that existing authority becomes explicitly projected.
    // A handed-off launch survives the unmount; its captured Account still retires it, and a change of
    // authority while this hook stays mounted still cancels it. (`mountedRef` clears first: declared earlier.)
    React.useEffect(() => () => {
        if (mountedRef.current || !launchOutlivesSurfaceRef.current) launchAbortRef.current?.abort();
    }, [
        params.draftId, params.draftScope?.serverId, params.draftScope?.accountId,
        params.targetAccountScope?.serverId ?? params.draftScope?.serverId,
        params.targetAccountScope?.accountId ?? params.draftScope?.accountId,
    ]);
    // Keep the latest params available synchronously so event handlers can't observe
    // a stale snapshot in the window between rerender and effect flush.
    latestParamsRef.current = params;

    const publishLaunchAttempt = React.useCallback((attempt: NewSessionLaunchAttempt | null) => {
        launchAttemptRef.current = attempt;
        if (mountedRef.current) {
            latestParamsRef.current.onLaunchAttemptChange?.(attempt);
        }
    }, [mountedRef]);

    const handleCreateSession = React.useCallback(async (opts?: HandleCreateSessionOptions): Promise<void> => {
        let afterCreatedSettlementReported = false;
        let releaseManagedAccountOnRejection: (() => void) | undefined;
        const reportAfterCreatedSettlement = (settlement: NewSessionAfterCreatedSettlement): void => {
            if (afterCreatedSettlementReported) {
                return;
            }
            afterCreatedSettlementReported = true;
            if (settlement.status === 'rejected') releaseManagedAccountOnRejection?.();
            try {
                opts?.onAfterCreatedSettled?.(settlement);
            } catch {
                // This optional observer must not alter the incumbent creation path.
            }
        };

        if (createInFlightRef.current) {
            reportAfterCreatedSettlement({ status: 'rejected' });
            return;
        }
        if (readCurrentLaunchFailure(launchFailure, latestParamsRef.current)?.kind === 'profile') {
            reportAfterCreatedSettlement({ status: 'rejected' });
            return;
        }
        let current = latestParamsRef.current;
        const createsMachineOnly = opts?.managedMachineOnly === true && !!current.managedMachineSelection;
        if (!createsMachineOnly && current.teamCredentialModelReady === false) {
            reportAfterCreatedSettlement({ status: 'rejected' });
            return;
        }
        // Launch progress is published only onto the draft this Send submitted (never a renewed host draft).
        const submittedLaunch = createSubmittedDraftLaunchPublication<NewSessionLaunchAttempt>({
            submittedDraftId: current.draftId ?? null,
            readShownDraftId: () => latestParamsRef.current.draftId ?? null,
            publishAttempt: publishLaunchAttempt,
            publishAttemptId: (userAttemptId) => current.onLaunchUserAttemptIdChange?.(userAttemptId),
        });
        const admitLaunchIntent = () => {
            const signature = readLaunchIntent(current);
            if (launchIntentSignatureRef.current !== signature) {
                launchAttemptRef.current = null;
                invalidatedLaunchUserAttemptIdRef.current = typeof current.launchUserAttemptId === 'string'
                    ? current.launchUserAttemptId.trim() || null : null;
                launchUserAttemptIdForCurrentIntentRef.current = null;
            }
            launchIntentSignatureRef.current = signature;
            const admitted = { signature };
            launchAbortIntentRef.current = admitted;
            return admitted;
        };
        const settings = storage.getState().settings;
        let managedCreation: SessionManagedCreationV1 | undefined;
        let managedAgentUpdate: SessionAgentUpdateNoticeV1 | undefined;
        let agentInstallConsent: SessionSpawnNewInputV2['agentInstallConsent'];
        const collectAgentInstallConsent = async (machineName: string, knownAgents?: MachineAgentsSnapshot): Promise<boolean> => {
            if (agentInstallConsent?.vendorRecipe) return true;
            const target = current.backendTarget ?? current.spawnBackendTarget ?? { kind: 'backend', backendId: current.agentType };
            const agent = resolveAgentCatalogProjection(resolveBackendTargetKeyV2(target), {
                enabledAgentIds: [], ...current.daemonMergedProjectionInputs,
            });
            if (agent.cli?.install.manual.kind !== 'vendor_recipe') return true;
            const definitionId = typeof target !== 'string' && 'definitionId' in target ? target.definitionId : undefined;
            const knownAgent = knownAgents?.status === 'ready' ? knownAgents.agents.find(row =>
                row.agentId === agent.agentId && row.definitionId === definitionId) : undefined;
            if (knownAgent && (resolveMachineAgentAcquireIntentV1(knownAgent) === null
                || resolveMachineAgentExecutionStateV1({ ...knownAgent, authenticationRequired: false }) === 'ready')) return true;
            if (!await confirmAgentInstallChange({ name: agent.title, nowMachines: [], firstUseMachines: [machineName], vendorRecipe: true })) return false;
            agentInstallConsent = { vendorRecipe: true };
            return true;
        };
        const submittedSessionName = current.getSessionName?.() ?? current.authoringDraft?.sessionName;
        const submittedInstructionsDraft = current.getInstructionsDraft
            ? current.getInstructionsDraft() : current.authoringDraft?.instructionsDraft;
        let submittedPromptStack = current.getInstructionsPromptStack
            ? current.getInstructionsPromptStack() : current.authoringDraft?.promptStack;
        const submittedDraftScope = current.draftScope;
        const submittedDraftId = current.draftId;
        const runSeededPostCreateAction = async (input: Readonly<{
            scope: ServerAccountScope;
            sessionId: string;
            requestId: string;
            signal: AbortSignal;
            alert: typeof Modal.alert;
        }>, draftScope = submittedDraftScope): Promise<void> => {
            if (!draftScope || !submittedDraftId || input.signal.aborted) return;
            // A lost create acknowledgement never reaches this checkpoint. The
            // entry can still be linked manually once the Session is found.
            const seededAction = takeNewSessionDraftPostCreateAction({ scope: draftScope, draftId: submittedDraftId });
            if (!seededAction) return;
            let failureCode: string | null;
            let actionRequestId: string | undefined;
            if (seededAction.authoringScope.accountId !== input.scope.accountId
                || !areServerProfileIdentifiersEquivalent(seededAction.authoringScope.serverId, input.scope.serverId)) {
                failureCode = 'action_account_scope_changed';
            } else {
                actionRequestId = randomUUID();
                const failure = await createDefaultActionExecutor().execute(
                    'action.invoke',
                    bindPluginUiNewSessionPostCreateActionV1(seededAction.intent, input.sessionId),
                    { ...createPluginActionCallerContext({
                        pluginId: seededAction.pluginId,
                        ...(seededAction.contributionLocalId === undefined ? {} : { contributionLocalId: seededAction.contributionLocalId }),
                    }),
                        surface: 'ui', serverId: input.scope.serverId, expectedAccountId: input.scope.accountId,
                        defaultSessionId: input.sessionId, actionRequestId, signal: input.signal },
                ).then(result => result.ok ? null : result, normalizeActionExecutorThrownError);
                failureCode = failure ? failure.failureCause?.errorCode ?? failure.errorCode : null;
                actionRequestId = failure?.requestId ?? actionRequestId;
            }
            if (!failureCode || input.signal.aborted) return;
            const message = [
                t('inbox.actionOperations.followUpNeedsAttention'),
                formatActionFailureDetails({ code: failureCode, context: { requestId: actionRequestId ?? null } }),
            ].join('\n');
            actionOperationStore.markFollowUpNeedsAttention({ ...input.scope, requestId: input.requestId, message });
            input.alert(t('common.error'), message);
        };
        const prepareSubmittedInstructions = async (): Promise<void> => {
            if (!submittedInstructionsDraft) return;
            if (!submittedDraftScope || !submittedDraftId) throw new NewSessionInstructionsPreparationError('instructions_draft_unavailable');
            const created = await sessionInstructionsActions.create(submittedDraftScope.serverId, submittedInstructionsDraft,
                undefined, submittedDraftScope.accountId);
            if (!created.createdRef) throw new NewSessionInstructionsPreparationError(created.result.ok
                ? 'instructions_creation_pending' : created.result.errorCode);
            const metadata = writeSessionContextIntentV1ToMetadata({ work: { promptStack: submittedPromptStack ?? [] } },
                buildSessionInstructionsContextIntentV1(created.createdRef));
            submittedPromptStack = SessionPromptStackV1Schema.parse(metadata.work.promptStack);
            const retained = readNewSessionDraftFromRepository({ scope: submittedDraftScope, draftId: submittedDraftId });
            if (retained) {
                const live = retained.instructionsDraft;
                if (launchAbortIntentRef.current !== null && readLaunchIntent(latestParamsRef.current) !== launchAbortIntentRef.current.signature) {
                    launchAbortRef.current?.abort();
                    throw new Error('instructions_draft_retired');
                }
                const preparedInstructions = {
                    promptStack: submittedPromptStack,
                    instructionsDraft: live?.title === submittedInstructionsDraft.title && live.markdown === submittedInstructionsDraft.markdown
                        ? null : live ?? null,
                };
                // Advance the same admitted identity before publishing our own
                // body-to-reference normalization. A real intervening edit was
                // checked above and cannot be adopted as part of this launch.
                const preparedSignature = readLaunchIntent(latestParamsRef.current, preparedInstructions);
                if (launchAbortIntentRef.current) launchAbortIntentRef.current.signature = preparedSignature;
                launchIntentSignatureRef.current = preparedSignature;
                writeNewSessionInstructionsToRepository({ scope: submittedDraftScope, draftId: submittedDraftId,
                    ...preparedInstructions });
            }
            const latest = latestParamsRef.current;
            if (!retained || !(mountedRef.current || launchOutlivesSurfaceRef.current) || latest.draftId !== submittedDraftId
                || !areServerAccountScopesEqual(latest.draftScope, submittedDraftScope)) {
                throw new Error('instructions_draft_retired');
            }
        };
        if (current.authoringCommitPending === true) {
            reportAfterCreatedSettlement({ status: 'rejected' });
            return;
        }
        try {
            if (!createsMachineOnly) current.requireConnectedAccountDefaultsReady?.();
        } catch {
            Modal.alert(t('common.error'), t('common.unavailable'));
            reportAfterCreatedSettlement({ status: 'rejected' });
            return;
        }
        if (!createsMachineOnly && !canCreateSessionWithInitialAccess(current.authoringDraft?.access, collaborationAvailabilityRef.current)) {
            Modal.alert(t('common.error'), t('session.collaboration.accessUnavailableReason'));
            reportAfterCreatedSettlement({ status: 'rejected' });
            return;
        }
        if (current.managedMachineSelection) {
            const submitted = current;
            const onManagedMachineEnrolled = submitted.onManagedMachineEnrolled;
            const managedDraft = current.managedMachineSelection;
            const admittedIntent = admitLaunchIntent();
            const signature = admittedIntent.signature;
            const scope = current.targetAccountScope ?? current.draftScope;
            const cancellation = new AbortController();
            launchAbortRef.current?.abort();
            launchAbortRef.current = cancellation;
            let account: LazyActionAccountContext | null = null;
            let accountRetirement: Readonly<{ dispose(): void }> | null = null;
            let accountRetainedForBinding = false;
            let accountReleased = false;
            const releaseAccount = () => {
                if (accountReleased) return;
                accountReleased = true;
                accountRetirement?.dispose();
                account?.dispose();
                cancellation.signal.removeEventListener('abort', releaseAccount);
                if (launchAbortRef.current === cancellation) launchAbortRef.current = null;
            };
            cancellation.signal.addEventListener('abort', releaseAccount, { once: true });
            releaseManagedAccountOnRejection = releaseAccount;
            const isCurrent = () => mountedRef.current && !cancellation.signal.aborted
                && readLaunchIntent(latestParamsRef.current) === admittedIntent.signature
                && sameStrictJsonValue(managedMachineCreationIntent(latestParamsRef.current.managedMachineSelection), managedMachineCreationIntent(managedDraft))
                && areServerAccountScopesEqual(latestParamsRef.current.targetAccountScope ?? latestParamsRef.current.draftScope, scope)
                && (account === null || account.accountLifetime.isCurrent());
            const progress = (value: ManagedMachineCreationProgress) => {
                if (isCurrent()) setManagedProgress({ signature, value });
            };
            if (!isDeferredManagedMachineAuthorPresetDraft(managedDraft) && managedDraft.archiveEffect !== 'keep'
                && resolveMachineRetentionNativeIntentV1(managedDraft.archiveEffect, managedDraft.receipt.retentionCapabilities.supportedIntents) === null) {
                progress({ kind: 'failed', code: 'native_intent_unsupported' });
                reportAfterCreatedSettlement({ status: 'rejected' });
                return;
            }
            if (!scope || !current.onManagedMachineAcquisitionChange || !onManagedMachineEnrolled) {
                progress({ kind: 'failed', code: 'managed_continuation_unavailable' });
                reportAfterCreatedSettlement({ status: 'rejected' });
                return;
            }
            opts = { ...opts, inputTextOverride: opts?.inputTextOverride ?? current.promptStore.getPrompt() };
            lastCreateOptionsRef.current = opts;
            createInFlightRef.current = true;
            current.setIsCreating(true);
            try {
                account = await captureLazyActionAccountContext(scope.serverId, cancellation.signal);
                if (accountReleased) { account.dispose(); throw new Error('continuation_retired'); }
                if (!isCurrent() || account.accountId !== scope.accountId || account.serverIdentityId !== managedDraft.selection.homeId) {
                    progress({ kind: 'failed', code: 'managed_target_scope_changed' });
                    reportAfterCreatedSettlement({ status: 'rejected' });
                    return;
                }
                accountRetirement = account.accountLifetime.onRetire(() => cancellation.abort());
                const retained = managedAcquisitionRef.current;
                if (retained && !sameStrictJsonValue(retained.selection, managedDraft.selection)) {
                    progress({ kind: 'failed', code: 'request_conflict' });
                    reportAfterCreatedSettlement({ status: 'rejected' });
                    return;
                }
                const acquisition = retained ?? {
                    requestId: launchUserAttemptIdForCurrentIntentRef.current ?? createNewSessionLaunchAttempt({
                        prompt: opts.inputTextOverride ?? '', displayText: opts.inputTextOverride ?? '',
                        scopeKey: signature, configurationUpdatedAtMs: nowServerMs(),
                    }).attemptId,
                    selection: managedDraft.selection,
                };
                managedAcquisitionRef.current = acquisition;
                current.onManagedMachineAcquisitionChange(acquisition);
                current.onLaunchUserAttemptIdChange?.(acquisition.requestId);
                if (!createsMachineOnly && !acquisition.managedId && !submitted.authoringDraft) {
                    progress({ kind: 'failed', code: 'managed_continuation_unavailable' });
                    reportAfterCreatedSettlement({ status: 'rejected' });
                    return;
                }
                if (!createsMachineOnly && !acquisition.managedId && (!await collectAgentInstallConsent(readManagedMachineSelectionName(managedDraft) ?? t('managedMachines.picker.newMachine')) || !isCurrent())) {
                    reportAfterCreatedSettlement({ status: 'rejected' });
                    return;
                }
                const preparedOrganizationPlacement = !createsMachineOnly && !acquisition.managedId ? await prepareNewSessionSpaceMembership({
                    spaceMembership: submitted.spaceMembership,
                    organizationPlacement: submitted.authoringDraft?.organizationPlacement ?? { folderId: null, tagIds: [] },
                    scope, signal: cancellation.signal,
                }) : submitted.authoringDraft?.organizationPlacement ?? { folderId: null, tagIds: [] };
                if (!isCurrent()) return;
                const result = await runManagedMachineCreation({
                    draft: managedDraft, acquisition, scope, signal: cancellation.signal, isCurrent,
                    teamCredentialPresentation: current.teamCredentialPresentation,
                    ...(!createsMachineOnly && !acquisition.managedId && submitted.authoringDraft ? {
                        agentStart: buildManagedAcquireAgentStartV1FromAuthoringDraft({
                            draft: { ...submitted.authoringDraft, organizationPlacement: preparedOrganizationPlacement,
                                sessionName: submittedSessionName,
                                promptStack: submittedPromptStack, prompt: opts.inputTextOverride ?? '',
                                displayText: opts.inputTextOverride ?? '' },
                            creationKey: buildManualSessionCreationKey(acquisition.requestId),
                            permissionMode: parsePermissionIntentAlias(submitted.permissionMode) ?? 'default',
                            configurationUpdatedAtMs: submitted.authoringDraft.permissionModeUpdatedAt ?? nowServerMs(),
                            initialMessage: opts.initialMessage === 'skip' ? null : opts.inputTextOverride,
                            initialStructuredInput: opts.initialInputStructuredInput,
                            initialReviewComments: opts.initialInputReviewComments,
                            sourceContext: submitted.sourceContext ?? null,
                            agentInstallConsent,
                        }),
                    } : {}),
                    retryInstallation: opts.managedMachineRetryInstallation,
                    setupRecovery: opts.managedMachineSetupRecovery,
                    reviewDelete: census => Modal.confirm(t('managedMachines.actions.deleteMachine'), [
                        readManagedMachineSelectionName(managedDraft) ?? t('managedMachines.picker.newMachine'), t('managedMachines.dependencies.help'),
                        ...(census.machineId ? [describeManagedMachineDeleteWork(scope, census.machineId)] : []),
                        census.references.length ? census.references.map(reference => reference.name || reference.id).join('\n')
                            : t('managedMachines.dependencies.empty'),
                        ...(census.coverage === 'partial' ? [t('managedMachines.dependencies.partial')] : []),
                    ].join('\n\n'), { cancelText: t('common.cancel'), confirmText: t('common.delete'), destructive: true }),
                    onAcquisitionChange: value => {
                        managedAcquisitionRef.current = value;
                        if (isCurrent()) submitted.onManagedMachineAcquisitionChange?.(value);
                    }, onProgress: progress, onApprovalPending: managedApproval.requestApproval,
                });
                if (isCurrent() && result.kind === 'delete_requested') {
                    // Ordinary Delete owns the resource; retire only this composer's existing continuation.
                    managedAcquisitionRef.current = null;
                    submitted.onManagedMachineAcquisitionChange?.(null);
                    invalidatedLaunchUserAttemptIdRef.current = acquisition.requestId;
                    launchUserAttemptIdForCurrentIntentRef.current = null;
                    if (submitted.draftScope && submitted.draftId) releaseNewSessionDraftLaunchAttempt({
                        scope: submitted.draftScope, draftId: submitted.draftId, launchUserAttemptId: acquisition.requestId,
                    });
                    submitted.onLaunchUserAttemptIdChange?.(null);
                    submitted.onManagedMachineDeleteRequested?.();
                    reportAfterCreatedSettlement({ status: 'rejected' });
                    return;
                }
                if (!isCurrent() || result.kind !== 'enrolled') {
                    if (isCurrent() && result.kind === 'failed' && result.agentStartFailure) {
                        const { machineId, agentId } = result.agentStartFailure;
                        const machine = resolveServerScopedMachine(storage.getState(), scope.serverId, machineId);
                        presentMachineAgentStartRefusal({
                            code: result.code,
                            agentTitle: resolveAgentCatalogProjection(agentId, { enabledAgentIds: [] }).title,
                            machineName: machine ? getMachineSentenceName(machine) : readManagedMachineSelectionName(managedDraft) ?? t('managedMachines.picker.newMachine'),
                            setupOwnerName: !machine ? null
                                : machine.access?.role === 'use' ? machine.access.custodian.displayName?.trim() || null : undefined,
                            setupTarget: presentsInPlaceRef.current ? null : { machineId, serverId: scope.serverId },
                            openSetup: href => submitted.router.push(href as never),
                        });
                    }
                    reportAfterCreatedSettlement({ status: 'rejected' });
                    return;
                }
                managedCreation = { homeId: result.machine.homeId, managedId: result.machine.id,
                    controller: result.machine.controller };
                managedAgentUpdate = result.agentUpdate;
                if (createsMachineOnly) {
                    await onManagedMachineEnrolled(result.machine.enrolledMachineId, cancellation.signal, { waitForAgent: false });
                    return;
                }
                await onManagedMachineEnrolled(result.machine.enrolledMachineId, cancellation.signal);
                const enrolled = latestParamsRef.current;
                if (!isCurrent() || enrolled.selectedMachineId !== result.machine.enrolledMachineId
                    || enrolled.selectedMachine?.id !== result.machine.enrolledMachineId || !enrolled.daemonMergedProjectionInputs) {
                    progress({ kind: 'failed', code: 'enrolled_target_not_ready' });
                    reportAfterCreatedSettlement({ status: 'rejected' });
                    return;
                }
                // The submitted authoring values stay in ordinary custody; only
                // the actual enrolled Machine's runtime observations are refreshed.
                current = { ...submitted,
                    selectedMachineId: enrolled.selectedMachineId, selectedMachine: enrolled.selectedMachine,
                    daemonMergedProjectionInputs: enrolled.daemonMergedProjectionInputs,
                    machineEnvPresence: enrolled.machineEnvPresence, selectedMachineCapabilities: enrolled.selectedMachineCapabilities,
                    pluginSettings: enrolled.pluginSettings, pluginSettingsReadiness: enrolled.pluginSettingsReadiness,
                    ...(submitted.authoringDraft && enrolled.authoringDraft ? { authoringDraft: {
                        ...submitted.authoringDraft, executionTarget: enrolled.authoringDraft.executionTarget,
                    } } : {}),
                };
                const afterCreated = opts.afterCreated;
                let bindingSettled = false;
                accountRetainedForBinding = true;
                opts = { ...opts, afterCreated: async created => {
                    if (bindingSettled) { await afterCreated?.(created); return; }
                    const selected = latestParamsRef.current.managedMachineSelection;
                    if (!selected || !isCurrent()) throw new Error('continuation_retired');
                    const binding = await bindNewManagedMachineCreationScope({ draft: selected, machine: result.machine,
                        source: { kind: 'session', sessionId: created.sessionId }, scope,
                        signal: cancellation.signal, isCurrent, onApprovalPending: managedApproval.requestApproval });
                    if (binding.kind === 'incomplete') {
                        progress({ kind: 'failed', code: binding.code, managedId: result.machine.id });
                        throw Object.assign(new Error(binding.code), { code: binding.code });
                    }
                    // Owner-only archive automation is an unavailable choice:
                    // the accepted Session/resource still succeeds with Keep.
                    // Only genuine failed/unknown FIN writes fail the follow-up.
                    bindingSettled = true;
                    releaseAccount();
                    await afterCreated?.(created);
                } };
            } catch {
                progress({ kind: 'failed', code: 'managed_creation_failed' });
                reportAfterCreatedSettlement({ status: 'rejected' });
                return;
            } finally {
                if (!accountRetainedForBinding) releaseAccount();
                createInFlightRef.current = false;
                submitted.setIsCreating(false);
            }
        }
        const authoringOriginLifetime = current.authoringOrigin ? captureActiveServerAccountScopeLifetime() : null;
        if (current.authoringOrigin && (
            !authoringOriginLifetime?.isCurrent()
            || !current.draftScope
            || !areServerAccountScopesEqual(authoringOriginLifetime.scope, current.draftScope)
        )) {
            Modal.alert(t('common.error'), t('newSession.failedToStart'));
            reportAfterCreatedSettlement({ status: 'rejected' });
            return;
        }
        if (!canCreateSessionWithInitialAccess(current.authoringDraft?.access, collaborationAvailabilityRef.current)) {
            Modal.alert(t('common.error'), t('session.collaboration.accessUnavailableReason'));
            reportAfterCreatedSettlement({ status: 'rejected' });
            return;
        }
        const staticAgentId = resolveStaticAgentId(current);
        const spawnBehaviorAgentId = resolveNewSessionBehaviorAgentId(current);
        const selectedMachineId = current.selectedMachineId;
        if (current.authoringCommitPending === true) {
            reportAfterCreatedSettlement({ status: 'rejected' });
            return;
        }
        if (current.authoringDraft?.executionTarget?.kind === 'temporary_computer') {
            if (
                current.authoringDraft.automation != null
                || !current.temporaryComputerLaunch
                || !opts?.temporaryComputerSubmission
                || !opts.afterCreated
            ) {
                Modal.alert(t('common.error'), t('newSession.failedToStart'));
                reportAfterCreatedSettlement({ status: 'rejected' });
                return;
            }
            createInFlightRef.current = true;
            current.setIsCreating(true);
            try {
                const resolvedTargetServerId = resolveNewSessionLaunchTargetServerId(current);
                if (!resolvedTargetServerId) throw new Error('runner_creator_server_unavailable');
                const sourceDraftScope = current.draftScope;
                const capturedTargetScope = current.temporaryComputerTargetScope;
                if (!sourceDraftScope || !capturedTargetScope
                    || !areServerProfileIdentifiersEquivalent(capturedTargetScope.serverId, resolvedTargetServerId)) {
                    throw new Error('runner_creator_target_scope_unavailable');
                }
                const capturedDraftId = current.draftId;
                if (!capturedDraftId) throw new Error('runner_creator_draft_unavailable');
                await prepareSubmittedInstructions();
                if (!current.prepareTemporaryComputerLaunchDraft) {
                    if (!areServerAccountScopesEqual(sourceDraftScope, capturedTargetScope)) {
                        throw new Error('runner_creator_draft_move_unavailable');
                    }
                } else {
                    await current.prepareTemporaryComputerLaunchDraft({
                        sourceScope: sourceDraftScope,
                        targetScope: capturedTargetScope,
                        draftId: capturedDraftId,
                    });
                }
                const capturedDraftScope = capturedTargetScope;
                const presentationAccountLifetime = captureActiveServerAccountScopeLifetime();
                const submittedDraftCurrentness = captureNewSessionDraftWorkflowCurrentness({
                    scope: capturedDraftScope,
                    draftId: capturedDraftId,
                });
                let launchAttempt = createNewSessionLaunchAttempt({
                    prompt: opts.temporaryComputerSubmission.composer.text,
                    displayText: opts.temporaryComputerSubmission.composer.text,
                    scopeKey: `temporary-computer:${capturedTargetScope.serverId}:${capturedTargetScope.accountId}:${current.draftId ?? 'unsaved'}`,
                    attemptId: launchUserAttemptIdForCurrentIntentRef.current,
                    configurationUpdatedAtMs: nowServerMs(),
                    meta: null,
                });
                let createdSessionCompletion: ReturnType<typeof createCreatedNewSessionCompletion> | null = null;
                let createdSessionId: string | null = null;
                let verifiedUploadedAttachments: readonly IssuedUploadedAttachment[] | null = null;
                const ensureCreatedSessionCompletion = (sessionId: string) => {
                    if (createdSessionId !== null && createdSessionId !== sessionId) {
                        throw new Error('runner_creator_materialized_session_changed');
                    }
                    if (createdSessionId === null) {
                        createdSessionId = sessionId;
                        launchAttempt = markNewSessionLaunchAttemptCreated(launchAttempt, { createdSessionId: sessionId });
                        submittedLaunch.attempt(launchAttempt);
                    }
                    createdSessionCompletion ??= createCreatedNewSessionCompletion({
                        ...(current.authoringOrigin || opts.afterCreated
                            ? { followUp: async (): Promise<void> => {
                                if (verifiedUploadedAttachments === null) {
                                    throw new Error('runner_creator_attachments_not_verified');
                                }
                                const preuploadedAttachments = verifiedUploadedAttachments;
                                if (current.authoringOrigin) {
                                    await persistCreatedSessionAuthoringOrigin({
                                        sessionId,
                                        serverId: capturedTargetScope.serverId,
                                        origin: current.authoringOrigin,
                                        // Runner activation does not carry the ordinary Machine spawn input.
                                        originPersistence: 'legacy-checkpoint',
                                        shouldContinue: () => authoringOriginLifetime?.isCurrent() === true,
                                        updateSessionMetadataWithRetry: sync.patchSessionMetadataWithRetry,
                                    });
                                }
                                await runWithHomeCredentialRequestSignal(capturedTargetScope.serverId, async signal => {
                                    await opts.afterCreated?.({
                                        sessionId,
                                        sessionTarget: { ...capturedTargetScope, sessionId },
                                        effectiveSpawnServerId: resolvedTargetServerId,
                                        launchAttempt,
                                        preuploadedAttachments,
                                        signal,
                                    });
                                    await runSeededPostCreateAction({
                                        scope: capturedTargetScope, sessionId, requestId: launchAttempt.attemptId,
                                        signal, alert: Modal.alert,
                                    }, capturedDraftScope);
                                });
                            } }
                            : {}),
                        present: () => presentCreatedNewSession({
                            sessionId,
                            serverId: capturedTargetScope.serverId,
                            accountId: capturedTargetScope.accountId,
                            requestId: launchAttempt.attemptId,
                            router: current.router,
                            isStillActive: () => mountedRef.current
                                && presentationAccountLifetime?.isCurrent() === true
                                && launchAttemptRef.current?.attemptId === launchAttempt.attemptId,
                        }),
                        ...(capturedDraftScope && capturedDraftId
                            ? { clearCapturedDraft: async () => {
                                if (mountedRef.current && !opts.deferAcceptedDraftClearToDocument) current.disableDraftPersistence?.();
                                await clearCapturedNewSessionDraftAfterLaunch({
                                    scope: capturedDraftScope,
                                    draftId: capturedDraftId,
                                    launchUserAttemptId: launchAttempt.attemptId,
                                });
                            } }
                            : {}),
                    });
                    return createdSessionCompletion;
                };
                captureNewSessionDraftLaunchCurrentness({
                    scope: capturedDraftScope,
                    draftId: capturedDraftId,
                    launchUserAttemptId: launchAttempt.attemptId,
                    currentness: submittedDraftCurrentness,
                });
                submittedLaunch.attempt(launchAttempt);
                current.requireConnectedAccountDefaultsReady?.();
                await current.temporaryComputerLaunch(opts.temporaryComputerSubmission, {
                    attachmentMessageLocalId: launchAttempt.attachmentMessageLocalId,
                    firstTurnLocalId: launchAttempt.firstTurnLocalId,
                    present: async (sessionId) => {
                        await ensureCreatedSessionCompletion(sessionId).present();
                    },
                    complete: async (sessionId, uploaded) => {
                        try {
                            const completion = ensureCreatedSessionCompletion(sessionId);
                            verifiedUploadedAttachments = uploaded;
                            // Presentation may already have completed before a slow transfer;
                            // an idempotent retry never opens the Session twice.
                            await completion.present();
                            await completion.complete();
                            launchAttempt = markNewSessionLaunchAttemptComplete(launchAttempt);
                            submittedLaunch.attempt(null);
                            reportAfterCreatedSettlement({ status: 'accepted', sessionId });
                        } catch (error) {
                            launchAttempt = markNewSessionLaunchAttemptFailed(launchAttempt, {
                                phase: error instanceof CreatedNewSessionCompletionError && error.stage === 'follow_up'
                                    ? 'uploading_attachments'
                                    : 'created',
                                error,
                                retryable: true,
                            });
                            submittedLaunch.attempt(launchAttempt);
                            throw error;
                        }
                    },
                    reject: () => reportAfterCreatedSettlement({ status: 'rejected' }),
                });
                // The canonical draft remains visible until materialization; there is no
                // Session to settle or clear yet.
            } catch {
                Modal.alert(t('common.error'), t('newSession.failedToStart'));
                reportAfterCreatedSettlement({ status: 'rejected' });
            } finally {
                createInFlightRef.current = false;
                current.setIsCreating(false);
            }
            return;
        }
        const launchesWithoutFolder = current.directoryKind === 'managed';
        const requestedPath = typeof current.getRequestedPath === 'function' && !launchesWithoutFolder
            ? current.getRequestedPath()
            : current.selectedPath;
        const effectiveSelectedPath = (typeof requestedPath === 'string'
            ? requestedPath
            : current.selectedPath).trim();
        const usesHostBoundMachine = Boolean(hostSpawnExecutorRef.current) && isHostBoundNewSessionMachine({
            selectedMachineId,
            directoryKind: current.directoryKind,
            hostBoundMachineId: hostCreationProfileRef.current?.machineId,
        });
        if (!selectedMachineId || (!usesHostBoundMachine && (!current.selectedMachine || current.selectedMachine.id !== selectedMachineId))) {
            Modal.alert(t('common.error'), t('newSession.noMachineSelected'));
            reportAfterCreatedSettlement({ status: 'rejected' });
            return;
        }
        if (!launchesWithoutFolder && effectiveSelectedPath.length === 0) {
            Modal.alert(t('common.error'), t('newSession.noPathSelected'));
            reportAfterCreatedSettlement({ status: 'rejected' });
            return;
        }

        lastCreateOptionsRef.current = opts;
        setLaunchFailure(null);
        createInFlightRef.current = true;
        current.setIsCreating(true);
        // Capture the submitted launch before preparation; automatic handoff waits for acceptance.
        backgroundableLaunchInFlightRef.current = isNewSessionLaunchBackgroundable(current, embeddedHost, hostSpawnExecutorRef.current);
        const afterSend = resolveNewSessionAfterSend({
            configured: storage.getState().settings.newSessionAfterSendV1,
            requested: opts?.afterSend,
            docked: embeddedHost?.kind === 'docked',
            backgroundable: backgroundableLaunchInFlightRef.current,
        });
        const opensDestination = embeddedHost?.kind === 'docked' && backgroundableLaunchInFlightRef.current && afterSend === 'open';
        const handOffAdmittedLaunch = () => {
            if (afterSend !== 'startAnother' || launchOutlivesSurfaceRef.current) return;
            handOffLaunchToBackground();
            current.onStartAnother?.();
        };
        let backgroundLaunchSettled = false;
        // Set once this launch opened its committed Session: from then on the Session itself (its
        // start-failure banner and first message) says why it did not start, so no dialog repeats it.
        let presentedSessionHref: string | null = null;
        // While the launch has a surface it speaks there; once handed off it reports to the composer's line
        // and never interrupts the next prompt. The draft keeps the text either way.
        const launchDialogs = {
            alert: ((title: string, message?: string, buttons?: Parameters<typeof Modal.alert>[2]) => {
                if (!launchOutlivesSurfaceRef.current) { if (!presentedSessionHref) Modal.alert(title, message, buttons); return; }
                backgroundLaunchSettled = true;
                newSessionBackgroundLaunches.failed(message ?? title, current.draftId ?? null, presentedSessionHref);
            }) as typeof Modal.alert,
            confirm: ((title: string, message?: string, options?: Parameters<typeof Modal.confirm>[2]) => {
                if (!launchOutlivesSurfaceRef.current) return presentedSessionHref ? Promise.resolve(false) : Modal.confirm(title, message, options);
                backgroundLaunchSettled = true;
                newSessionBackgroundLaunches.failed(message ?? title, current.draftId ?? null, presentedSessionHref);
                return Promise.resolve(false);
            }) as typeof Modal.confirm,
        };
        const launchRouter = {
            replace: (path: unknown, options?: Record<string, unknown>) => {
                if (launchOutlivesSurfaceRef.current) {
                    backgroundLaunchSettled = true;
                    newSessionBackgroundLaunches.started(String(path));
                    return;
                }
                current.router.replace(path as never, { ...options, ...(opensDestination ? { opensDestination: true } : {}) } as never);
            },
        };
        let settlementOwnedByCanonicalOperation = false;
        let disposeOrdinaryDraftLifetime: (() => void) | undefined;
        // Settles a first message this launch presented at commit, on every exit (the `finally` below).
        let settlePresentedFirstTurnOnExit: (() => void) | undefined;
        let capturedOrdinarySourceAccount: LazyActionAccountContext | undefined;
        let capturedOrdinaryTargetAccount: LazyActionAccountContext | undefined;
        let submittedDraftCurrentness: ReturnType<typeof captureNewSessionDraftWorkflowCurrentness> | null = null;
        const clearCompletedDraft = async (launchUserAttemptId?: string): Promise<void> => {
            if (!current.draftScope || !current.draftId) return;
            await clearCapturedNewSessionDraftAfterLaunch({
                scope: current.draftScope,
                draftId: current.draftId,
                currentness: submittedDraftCurrentness,
                launchUserAttemptId,
            });
        };

        try {
            // Autosave may still hold a debounced selection snapshot. Commit
            // exactly what Send admitted before any asynchronous handoff or
            // capture, so reopening and clearing refer to that same authoring.
            current.flushComposerInput?.();
            current.flushAuthoringDraft?.();
            const submittedIntent = admitLaunchIntent();
            const sourceDraft = current.draftScope && current.draftId
                ? getSessionDraftSnapshot(current.draftScope, { kind: 'newSession', draftId: current.draftId })
                : null;
            const sourceDraftExisted = sourceDraft !== null;
            const sessionCreationReview = current.draftScope && current.draftId
                ? readNewSessionDraftFromRepository({ scope: current.draftScope, draftId: current.draftId })?.creationReview
                : undefined;
            const hasSeededPostCreateAction = sourceDraft?.localSupplement.newSessionLocalState?.postCreateAction !== undefined;
            // Keep the submitted draft available for its one-shot Action and notice before handing it off.
            const handOffBeforeFollowUp = hasSeededPostCreateAction ? undefined : handOffAdmittedLaunch;
            submittedDraftCurrentness = current.draftScope && current.draftId
                ? captureNewSessionDraftWorkflowCurrentness({
                    scope: current.draftScope,
                    draftId: current.draftId,
                })
                : null;
            const resolvedTargetServerId = resolveNewSessionLaunchTargetServerId(current);
            if (!resolvedTargetServerId) {
                launchDialogs.alert(t('common.error'), t('newSession.failedToStart'));
                current.setIsCreating(false);
                return;
            }
            const sourceDraftCancellation = new AbortController();
            launchAbortRef.current = sourceDraftCancellation;
            if (current.draftScope && !hostSpawnExecutorRef.current) {
                capturedOrdinarySourceAccount = await captureLazyActionAccountContext(current.draftScope.serverId, sourceDraftCancellation.signal);
                if (capturedOrdinarySourceAccount.accountId !== current.draftScope.accountId) {
                    throw new Error('action_account_scope_changed');
                }
                const sourceDraftRetirement = capturedOrdinarySourceAccount.accountLifetime.onRetire(() => sourceDraftCancellation.abort());
                disposeOrdinaryDraftLifetime = () => sourceDraftRetirement.dispose();
            }
            // A pre-Session creation host owns its admitted frame credential and
            // grant lifecycle; no UI Account login or Session context exists yet.
            let resolvedExecutionAccountScope = current.targetAccountScope
                && areServerProfileIdentifiersEquivalent(current.targetAccountScope.serverId, resolvedTargetServerId)
                ? current.targetAccountScope
                : current.draftScope && areServerProfileIdentifiersEquivalent(current.draftScope.serverId, resolvedTargetServerId)
                    ? current.draftScope : null;
            if (!resolvedExecutionAccountScope) {
                capturedOrdinaryTargetAccount = await captureLazyActionAccountContext(resolvedTargetServerId, sourceDraftCancellation.signal);
                resolvedExecutionAccountScope = capturedOrdinaryTargetAccount.accountLifetime.scope;
            }
            const executionAccountScope = resolvedExecutionAccountScope;
            const launchScopeKey = buildNewSessionLaunchScopeKey({
                machineId: selectedMachineId,
                serverId: resolvedTargetServerId,
                selectedPath: effectiveSelectedPath,
                directoryKind: current.directoryKind,
                selectedMachineMetadata: current.selectedMachine?.metadata,
                useProfiles: current.useProfiles,
                selectedProfileId: current.useProfiles ? current.selectedProfileId : null,
            });
            const resolveCurrentLaunchScopeKey = (): string => {
                const latest = latestParamsRef.current;
                const latestRequestedPath = typeof latest.getRequestedPath === 'function'
                    ? latest.getRequestedPath()
                    : latest.selectedPath;
                const latestEffectiveSelectedPath = (typeof latestRequestedPath === 'string'
                    ? latestRequestedPath
                    : latest.selectedPath).trim();
                const latestResolvedTargetServerId = resolveNewSessionLaunchTargetServerId(latest);
                if (!latestResolvedTargetServerId) return 'no-target';
                return buildNewSessionLaunchScopeKey({
                    machineId: latest.selectedMachineId,
                    serverId: latestResolvedTargetServerId,
                    selectedPath: latestEffectiveSelectedPath,
                    directoryKind: latest.directoryKind,
                    selectedMachineMetadata: latest.selectedMachine?.metadata,
                    useProfiles: latest.useProfiles,
                    selectedProfileId: latest.useProfiles ? latest.selectedProfileId : null,
                });
            };
            const isLaunchScopeStillCurrent = (): boolean => (
                resolveCurrentLaunchScopeKey() === launchScopeKey
            );
            const isLaunchScopeStillActive = (): boolean => (
                (mountedRef.current || launchOutlivesSurfaceRef.current) && isLaunchScopeStillCurrent()
            );
            const sessionPrompt = opts?.inputTextOverride ?? current.promptStore.getPrompt();
            const shouldSendInitialMessage = (opts?.initialMessage ?? 'send') !== 'skip';
            const shouldPrepareInitialMessage = shouldSendInitialMessage && sessionPrompt.trim();
            const invocationScope = current.draftScope ?? selectActiveServerAccountScopeForServer(getActiveServerAccountScope(), resolvedTargetServerId);
            // Only a `/token` prompt reads the catalog, so any other launch never waits on it.
            if (shouldPrepareInitialMessage && invocationScope && canInvokePromptTemplate(sessionPrompt)) await readCurrentPromptLibraryCatalogValue(invocationScope, 'invocations');
            if (!isLaunchScopeStillActive() || (invocationScope && !areServerAccountScopesEqual(invocationScope,
                latestParamsRef.current.draftScope ?? selectActiveServerAccountScopeForServer(getActiveServerAccountScope(), resolvedTargetServerId)))) return;
            const inventoryLifetime = capturedOrdinaryTargetAccount?.accountLifetime
                ?? capturedOrdinarySourceAccount?.accountLifetime ?? captureActiveServerAccountScopeLifetime();
            const knownAgents = inventoryLifetime && areServerAccountScopesEqual(inventoryLifetime.scope, executionAccountScope)
                ? readMachineAgentsForScope(inventoryLifetime, selectedMachineId) : undefined;
            if (!await collectAgentInstallConsent(current.selectedMachine ? getMachineSentenceName(current.selectedMachine) : selectedMachineId, knownAgents)
                || !isLaunchScopeStillActive() || sourceDraftCancellation.signal.aborted
                || readLaunchIntent(latestParamsRef.current) !== submittedIntent.signature) {
                reportAfterCreatedSettlement({ status: 'rejected' });
                current.setIsCreating(false);
                return;
            }
            await prepareSubmittedInstructions();
            if (!isLaunchScopeStillActive()) return;
            const preparedOrganizationPlacement = await prepareNewSessionSpaceMembership({
                spaceMembership: current.spaceMembership,
                organizationPlacement: current.authoringDraft?.organizationPlacement ?? { folderId: null, tagIds: [] },
                scope: executionAccountScope, signal: sourceDraftCancellation.signal,
            });
            if (!isLaunchScopeStillActive()) return;
            const invocationCatalog = getPromptLibraryCatalogValue(invocationScope, 'invocations');
            const resolvedInitialMessage = shouldPrepareInitialMessage
                ? resolveSessionComposerSend({
                    input: sessionPrompt,
                    sessionId: null,
                    executionRunsEnabled: current.executionRunsEnabled === true,
                    // A new session has no live runtime registry yet. Preserve the user's text and
                    // let the Agent handle `/goal` until the attached runner can advertise the
                    // callable controls used by the local goal UI.
                    goalControlsAvailable: false,
                    promptInvocationsV1: invocationCatalog.status === 'ready' && !invocationCatalog.stale ? invocationCatalog.value : null,
                })
                : null;
            if (
                resolvedInitialMessage?.kind === 'template' &&
                resolvePromptInvocationComposerSendAction(resolvedInitialMessage.behavior) === 'insert'
            ) {
                const expanded = await expandPromptTemplateInvocation({
                    targetArtifactId: resolvedInitialMessage.targetArtifactId,
                    argsText: resolvedInitialMessage.rest,
                    serverId: resolvedInitialMessage.targetServerId ?? invocationScope?.serverId,
                });
                current.setSessionPrompt?.(expanded);
                current.setIsCreating(false);
                return;
            }

            if (!selectedMachineId) {
                launchDialogs.alert(t('common.error'), t('newSession.noMachineSelected'));
                reportAfterCreatedSettlement({ status: 'rejected' });
                current.setIsCreating(false);
                return;
            }

            const profilesActive = current.useProfiles;
            // This history stores local Machine IDs, so its Account Settings
            // scope must be the Home where those IDs were selected.
            // A private folder is never a recent folder: only a chosen one is remembered.
            if (!launchesWithoutFolder && areServerProfileIdentifiersEquivalent(
                storage.getState().settingsScope?.serverId,
                resolvedTargetServerId,
            )) {
                const recentMachinePaths = [
                    { machineId: selectedMachineId, path: effectiveSelectedPath },
                    ...current.recentMachinePaths.filter((rp) => (
                        rp.machineId !== selectedMachineId || rp.path !== effectiveSelectedPath
                    )),
                ].slice(0, 10);
                fireAndForget(applyAuthoringMemory({ recentMachinePaths }), { tag: 'useCreateNewSession.recentPaths' });
            }
            if (current.backendTarget) {
                rememberLastUsedBackendSelection(expectedSettingsScope, buildLastUsedBackendTargetSettings({
                    backendTarget: current.backendTarget,
                    selectedBuiltInAgentId: staticAgentId,
                }));
            }

            const selectedBackendTarget: PersistedBackendTargetRefV2 = current.backendTarget ?? {
                kind: 'backend',
                backendId: staticAgentId ?? current.agentType,
            };
            const backendTarget: BackendTargetRefV2 = resolveNewSessionOperationalBackendTarget({
                backendTarget: selectedBackendTarget,
                runtimeCarrierAgentId: current.runtimeCarrierAgentId,
            });
            let environmentVariables = undefined;
            let secretReferenceOverlay: SecretReferenceOverlayV1 | undefined;
            const selectedProfile = profilesActive && current.selectedProfileId
                ? current.profileMap.get(current.selectedProfileId) ?? getBuiltInProfile(current.selectedProfileId) ?? null : null;
            if (profilesActive && current.selectedProfileId) {
                if (selectedProfile) {
                    if (!isProfileCompatibleWithBackendTarget(selectedProfile, selectedBackendTarget)) {
                        launchDialogs.alert(t('common.error'), t('newSession.aiBackendNotCompatibleWithSelectedProfile'));
                        current.setIsCreating(false);
                        return;
                    }

                    const selectedSecretIdByEnvVarName = current.selectedSecretIdByProfileIdByEnvVarName[current.selectedProfileId] ?? {};
                    const sessionOnlySecretValueByEnvVarName = current.sessionOnlySecretValueByProfileIdByEnvVarName[current.selectedProfileId] ?? {};
                    const machineEnvReadyByName = Object.fromEntries(
                        Object.entries(current.machineEnvPresence.meta ?? {}).map(([k, v]) => [k, Boolean(v?.isSet)]),
                    );

                    if (current.machineEnvPresence.isPreviewEnvSupported && !current.machineEnvPresence.isLoading) {
                        const missingConfig = getMissingRequiredConfigEnvVarNames(selectedProfile, machineEnvReadyByName);
                        if (missingConfig.length > 0) {
                            launchDialogs.alert(
                                t('common.error'),
                                t('profiles.requirements.missingConfigForProfile', { env: missingConfig.join(', ') })
                            );
                            current.setIsCreating(false);
                            return;
                        }
                    }

                    const profileSecretReadiness = resolveStrictV2ProfileSecretReadiness({
                        profile: selectedProfile,
                        defaultBindings: current.secretBindingsByProfileId[current.selectedProfileId] ?? null,
                        selectedSecretIds: selectedSecretIdByEnvVarName,
                        sessionOnlyValues: sessionOnlySecretValueByEnvVarName,
                        machineEnvReadyByName,
                        resolveSavedSecretReference: current.resolveSavedSecretReference,
                    });
                    if (!profileSecretReadiness.ok) {
                        launchDialogs.alert(t('common.error'), t('profiles.requirements.modalBody'));
                        current.setIsCreating(false);
                        return;
                    }
                    secretReferenceOverlay = profileSecretReadiness.secretReferenceOverlay;
                }
            }

            if (spawnBehaviorAgentId) {
                environmentVariables = buildSpawnEnvironmentVariablesFromUiState({
                    agentId: spawnBehaviorAgentId,
                    settings,
                    pluginSettings: current.pluginSettings,
                    machineId: selectedMachineId,
                    environmentVariables,
                    newSessionOptions: {
                        ...(current.agentNewSessionOptions ?? {}),
                        targetServerId: resolvedTargetServerId,
                    },
                });
            }
            const connectedServices = (current.agentNewSessionOptions as any)?.connectedServices;

            const terminal = resolveTerminalSpawnOptions({
                settings,
                machineId: selectedMachineId,
            });

            const machineCapsSnapshot = getMachineCapabilitiesSnapshot(selectedMachineId, resolvedTargetServerId);
            const machineCapsResults = machineCapsSnapshot?.response.results as any;
            const preflightIssues = spawnBehaviorAgentId
                ? getNewSessionPreflightIssues({
                    agentId: spawnBehaviorAgentId,
                    experiments: getAgentResumeExperimentsFromSettings(spawnBehaviorAgentId, settings, selectedMachineId, current.pluginSettings),
                    resumeSessionId: current.resumeSessionId,
                    results: machineCapsResults,
                    machineId: selectedMachineId,
                    pluginSettings: current.pluginSettings,
                    pluginSettingsReadiness: current.pluginSettingsReadiness,
                })
                : [];
            const blockingIssue = preflightIssues[0] ?? null;
            if (blockingIssue) {
                if (presentsInPlaceRef.current) {
                    launchDialogs.alert(t(blockingIssue.titleKey), t(blockingIssue.messageKey));
                    current.setIsCreating(false);
                    return;
                }
                const openMachine = await launchDialogs.confirm(
                    t(blockingIssue.titleKey),
                    t(blockingIssue.messageKey),
                    { confirmText: t(blockingIssue.confirmTextKey) }
                );
                if (openMachine && blockingIssue.action === 'openMachine') {
                    current.router.push(machinePageHref({ door: 'rail', target: { machineId: selectedMachineId } }) as never);
                }
                current.setIsCreating(false);
                return;
            }

            // D2: when "start fresh under the new account" was chosen, drop the resume reference so the
            // relaunch creates a clean session bound to the now-active connected-service account.
            const startFreshUnderNewAccount = opts?.startFreshUnderNewAccount === true;
            // Presence only: a resume id is an opaque Agent-issued session identity
            // whose one rule owner is Protocol's `NonBlankOpaqueIdentifierSchema`.
            // Carrying a trimmed value here would corrupt the Agent's own bytes.
            const resumeId = !startFreshUnderNewAccount && current.resumeSessionId.trim().length > 0
                ? current.resumeSessionId
                : undefined;
            const spawnPermissionMode = parsePermissionIntentAlias(current.permissionMode) ?? 'default';
            const retryableLaunchAttempt = launchAttemptRef.current?.status === 'failed_retryable'
                && isNewSessionLaunchAttemptInScope(launchAttemptRef.current, launchScopeKey)
                ? launchAttemptRef.current
                : null;
            // An attempt id is the daemon's Action request identity, which rejects a
            // reused id carrying different input. Every submission of one attempt,
            // including after a reload, replays the timestamp captured when it began.
            const reusedLaunchUserAttemptId = retryableLaunchAttempt?.attemptId
                ?? launchUserAttemptIdForCurrentIntentRef.current;
            const spawnPermissionModeUpdatedAt = (
                reusedLaunchUserAttemptId !== null
                && launchAttemptRef.current?.attemptId === reusedLaunchUserAttemptId
                    ? launchAttemptRef.current.configurationUpdatedAtMs
                    : null
            ) ?? (
                reusedLaunchUserAttemptId !== null && current.draftScope && current.draftId
                    ? readNewSessionDraftLaunchConfigurationUpdatedAtMs({
                        scope: current.draftScope,
                        draftId: current.draftId,
                        launchUserAttemptId: reusedLaunchUserAttemptId,
                    })
                    : null
            ) ?? nowServerMs();
            const normalizedAcpModeId = typeof current.acpSessionModeId === 'string' ? current.acpSessionModeId.trim() : '';
            const spawnModelId =
                staticAgentId !== null &&
                getAgentCore(staticAgentId)?.model?.supportsSelection !== false &&
                typeof current.modelMode === 'string' &&
                current.modelMode.trim().length > 0 &&
                current.modelMode !== 'default'
                    ? current.modelMode
                    : undefined;
            const canonicalSpawnBackendTarget = current.spawnBackendTarget ?? backendTarget;
            const agentTarget = resolveAgentExecutionTargetForBackendTarget({
                backendTarget: canonicalSpawnBackendTarget,
                daemonMergedProjectionInputs: current.daemonMergedProjectionInputs,
            });
            const spawnModelUpdatedAt = spawnModelId ? spawnPermissionModeUpdatedAt : undefined;
            const hasCanonicalModelSelection = current.authoringDraft != null
                && Object.prototype.hasOwnProperty.call(current.authoringDraft, 'modelSelection');
            const spawnModelSelection = hasCanonicalModelSelection
                ? current.authoringDraft?.modelSelection ?? null
                : spawnModelId
                    ? {
                        v: 1 as const,
                        updatedAt: spawnModelUpdatedAt ?? spawnPermissionModeUpdatedAt,
                        ref: {
                            agentTargetKey: agentTarget
                                ? resolveBackendTargetKeyV2(agentTarget)
                                : resolveBackendTargetKeyV2(canonicalSpawnBackendTarget),
                            providerConnectionId: null,
                            modelId: spawnModelId,
                        },
                    }
                    : null;
            const windowsRemoteSessionLaunchMode = resolveEffectiveWindowsRemoteSessionLaunchMode({
                machineMetadata: current.selectedMachine?.metadata,
                settings,
                sessionOverride: current.windowsRemoteSessionLaunchModeOverride ?? undefined,
            }).mode;
            const windowsTerminalWindowName = typeof settings.sessionWindowsTerminalWindowName === 'string'
                ? settings.sessionWindowsTerminalWindowName.trim()
                : '';
            const normalizedSessionPrompt = sessionPrompt.trim();
            const spawnSessionExtras: ReturnType<typeof buildSpawnSessionExtrasFromUiState> = spawnBehaviorAgentId
                ? buildSpawnSessionExtrasFromUiState({
                    agentId: spawnBehaviorAgentId,
                    settings,
                    pluginSettings: current.pluginSettings,
                    machineId: selectedMachineId,
                    resumeSessionId: current.resumeSessionId,
                    newSessionOptions: {
                        ...(current.agentNewSessionOptions ?? {}),
                        targetServerId: resolvedTargetServerId,
                    },
                    sessionConfigOptionOverrides: current.sessionConfigOptionOverrides,
                    updatedAt: spawnPermissionModeUpdatedAt,
                })
                : {};
            const retainedSelectionOrigin = current.authoringDraft?.executionTarget?.kind === 'machine'
                && current.authoringDraft.executionTarget.target.serverId === resolvedTargetServerId
                && current.authoringDraft.executionTarget.target.machineId === selectedMachineId
                ? current.authoringDraft.executionTarget.selectionOrigin
                : undefined;
            const authoringDraft = buildNewSessionAuthoringDraftFromResolvedInputs({
                sessionName: submittedSessionName,
                initialSessionFacts: current.authoringDraft?.initialSessionFacts,
                memoryEnabled: current.authoringDraft?.memoryEnabled,
                isolationOverride: current.authoringDraft?.isolationOverride,
                sessionPlacement: current.authoringDraft?.sessionPlacement,
                ...(submittedPromptStack !== undefined ? { promptStack: submittedPromptStack } : {}),
                executionTarget: selectedMachineId ? {
                    kind: 'machine',
                    target: { serverId: resolvedTargetServerId, machineId: selectedMachineId },
                    ...(retainedSelectionOrigin ? { selectionOrigin: retainedSelectionOrigin } : {}),
                } : null,
                directory: effectiveSelectedPath,
                directoryKind: current.directoryKind,
                checkoutCreationDraft: current.checkoutCreationDraft ?? null,
                organizationPlacement: preparedOrganizationPlacement,
                access: current.authoringDraft?.access,
                primaryTeamId: current.authoringDraft?.primaryTeamId,
                projectContext: current.authoringDraft?.projectContext,
                teamCredentialBindings: current.authoringDraft?.teamCredentialBindings,
                initialTriggers: current.authoringDraft?.initialTriggers,
                prompt: normalizedSessionPrompt,
                displayText: normalizedSessionPrompt,
                agentTarget,
                transcriptStorage: current.transcriptStorage ?? null,
                profileId: profilesActive ? (current.selectedProfileId ?? '') : null,
                approvalProfileId: current.authoringDraft?.approvalProfileId,
                environmentVariables: environmentVariables ?? null,
                resumeSessionId: resumeId ?? null,
                permissionMode: spawnPermissionMode,
                permissionModeUpdatedAt: spawnPermissionModeUpdatedAt,
                modelSelection: spawnModelSelection,
                capabilitySelection: current.capabilitySelection ?? null,
                connectedServices: connectedServices ?? null,
                terminal: terminal ?? null,
                windowsRemoteSessionLaunchMode: windowsRemoteSessionLaunchMode ?? null,
                windowsRemoteSessionConsole: null,
                windowsTerminalWindowName: windowsTerminalWindowName || null,
                acpSessionModeId: normalizedAcpModeId || null,
                sessionConfigOptionOverrides:
                    spawnSessionExtras.sessionConfigOptionOverrides
                    ?? current.sessionConfigOptionOverrides
                    ?? null,
                automation: current.authoringDraft?.automation ?? null,
            });
            const strictV2ConfigurationOptionKeys = new Set(
                Object.keys(spawnSessionExtras.sessionConfigOptionOverrides?.overrides ?? {}),
            );
            const legacyOnlySpawnExtras = Object.keys(spawnSessionExtras).filter(
                (key) => key !== 'runtimeDescriptorV1'
                    && key !== 'sessionConfigOptionOverrides'
                    && !strictV2ConfigurationOptionKeys.has(key),
            );
            const hasLegacyOnlyEnvironment = Object.keys(environmentVariables ?? {}).length > 0;
            if (
                hasLegacyOnlyEnvironment
                || legacyOnlySpawnExtras.length > 0
            ) {
                // Environment overrides and noncanonical Agent-specific extras
                // have no strict-V2 owner. The canonical runtime descriptor and
                // config-option overrides above do, and continue through the
                // host-owned Session Action path.
                launchDialogs.alert(t('common.error'), t('newSession.failedToStart'));
                current.setIsCreating(false);
                return;
            }

            let launchAttempt = retryableLaunchAttempt ?? createNewSessionLaunchAttempt({
                prompt: normalizedSessionPrompt,
                displayText: normalizedSessionPrompt,
                scopeKey: launchScopeKey,
                attemptId: launchUserAttemptIdForCurrentIntentRef.current,
                configurationUpdatedAtMs: spawnPermissionModeUpdatedAt,
                meta: null,
            });
            if (!retryableLaunchAttempt && launchUserAttemptIdForCurrentIntentRef.current !== launchAttempt.attemptId) {
                current.onLaunchUserAttemptIdChange?.(launchAttempt.attemptId);
            }
            if (current.draftScope && current.draftId && submittedDraftCurrentness) {
                captureNewSessionDraftLaunchCurrentness({
                    scope: current.draftScope,
                    draftId: current.draftId,
                    launchUserAttemptId: launchAttempt.attemptId,
                    currentness: submittedDraftCurrentness,
                    configurationUpdatedAtMs: launchAttempt.configurationUpdatedAtMs,
                });
            }
            /**
             * A terminal failure before any Session exists ends this attempt: the
             * next submission must mint a new id instead of replaying one the
             * daemon may already hold with different input.
             */
            const endLaunchAttemptWithoutSession = (): void => {
                const endedAttemptId = launchAttempt.attemptId;
                submittedLaunch.attempt(null);
                invalidatedLaunchUserAttemptIdRef.current = endedAttemptId;
                if (launchUserAttemptIdForCurrentIntentRef.current === endedAttemptId) {
                    launchUserAttemptIdForCurrentIntentRef.current = null;
                }
                if (current.draftScope && current.draftId) {
                    releaseNewSessionDraftLaunchAttempt({
                        scope: current.draftScope,
                        draftId: current.draftId,
                        launchUserAttemptId: endedAttemptId,
                    });
                }
                submittedLaunch.attemptId(null);
            };
            submittedLaunch.attempt(launchAttempt);
            let createdSessionId = launchAttempt.createdSessionId;
            let manualActionCustody: ManualSessionSpawnNewActionCustody | null = null;
            let initialInputLocalId: string | null = null;
            let initialMessageText = '';
            let initialInputWasNotAccepted = false;
            let initialInputFailure: Extract<SessionSpawnNewInitialInputDispositionV1, { status: 'rejected' | 'outcomeUnknown' }> | null = null;
            // Set once the committed Session was presented at its commit receipt (before the launch settled).
            const presentedFirstTurn = createPresentedFirstTurnSettlement({
                draftId: current.draftId ?? null,
                readCanonicalOperation: () => readManualSessionSpawnOperation(executionAccountScope, launchAttempt.attemptId),
                write: (presented, settlement) => {
                    if (presented.firstTurnLocalId) settleNewSessionFirstTurnLaunch({
                        sessionId: presented.sessionId, localId: presented.firstTurnLocalId, settlement });
                },
            });
            settlePresentedFirstTurnOnExit = () => presentedFirstTurn.settle({ final: true, acceptedLocalId: initialInputLocalId });

            const adoptCanonicalActionOperationSettlement = (): boolean => {
                const executionAccountId = executionAccountScope.accountId.trim();
                const canonicalOperation = executionAccountId
                    ? readManualSessionSpawnOperation(
                        executionAccountScope,
                        launchAttempt.attemptId,
                    )
                    : null;
                if (
                    canonicalOperation?.actionId !== 'session.spawn_new'
                    || (
                        canonicalOperation.state !== 'accepted'
                        && canonicalOperation.state !== 'running'
                        && canonicalOperation.state !== 'succeeded'
                        && canonicalOperation.state !== 'failed'
                        && canonicalOperation.state !== 'cancelled'
                    )
                ) {
                    return false;
                }
                settlementOwnedByCanonicalOperation = canonicalOperation.state === 'accepted'
                    || canonicalOperation.state === 'running'
                    || canonicalOperation.state === 'succeeded';
                return true;
            };

            if (resolvedInitialMessage?.kind === 'template') {
                initialMessageText = await expandPromptTemplateInvocation({
                    targetArtifactId: resolvedInitialMessage.targetArtifactId,
                    argsText: resolvedInitialMessage.rest,
                    serverId: resolvedInitialMessage.targetServerId ?? invocationScope?.serverId,
                });
            } else if (resolvedInitialMessage?.kind === 'send') {
                initialMessageText = resolvedInitialMessage.text.trim();
            }

            if (shouldSpawnForNewSessionLaunchAttempt(launchAttempt)) {
                if (!agentTarget) {
                    launchAttempt = markNewSessionLaunchAttemptFailed(launchAttempt, {
                        phase: 'spawning',
                        error: new Error('The selected Agent is unavailable on this machine.'),
                        retryable: false,
                    });
                    endLaunchAttemptWithoutSession();
                    launchDialogs.alert(t('common.error'), t('newSession.failedToStart'));
                    current.setIsCreating(false);
                    return;
                }

                current.requireConnectedAccountDefaultsReady?.();
                const authoredSpawnInput = buildSessionSpawnNewInputV2FromAuthoringDraft({
                        draft: authoringDraft,
                        creationKey: buildManualSessionCreationKey(launchAttempt.attemptId),
                        permissionMode: spawnPermissionMode,
                        configurationUpdatedAtMs: spawnPermissionModeUpdatedAt,
                        initialMessage: initialMessageText || null,
                        initialStructuredInput: opts?.initialInputStructuredInput,
                        initialReviewComments: opts?.initialInputReviewComments,
                        sourceContext: current.sourceContext ? { ...current.sourceContext,
                            ...(current.continuationSourceSessionId ? { continuation: true as const } : {}),
                        } : null,
                        agentInstallConsent,
                        secretReferenceOverlay,
                    });
                const birthOrigin = current.authoringOrigin && supportsMachineOperationProtocolCapabilityV1(
                    current.selectedMachine?.operationProtocolCapabilities, 'sessionSpawnAuthoringOrigin',
                ) ? current.authoringOrigin : undefined;
                const spawnInput = { ...authoredSpawnInput, ...(managedCreation ? { managedCreation } : {}),
                    ...(birthOrigin ? { authoringOrigin: birthOrigin } : {}) };
                // Readiness and strict input construction may refuse before dispatch.
                // Publish spawning only after those synchronous admissions succeed.
                launchAttempt = markNewSessionLaunchAttemptSpawning(launchAttempt);
                submittedLaunch.attempt(launchAttempt);
                const releaseUserRequestLease = sync.acquireUserRequestLease();
                for (const requestId of [launchAttempt.attemptId, spawnInput.creationKey]) {
                    actionOperationPresentationCoordinator.register({
                        serverId: resolvedTargetServerId,
                        accountId: executionAccountScope.accountId,
                        requestId,
                        onStart: 'current',
                        ...(current.draftScope && current.draftId
                            ? { origin: createNewSessionActionOperationOrigin(current.draftScope, current.draftId) }
                            : {}),
                    });
                }
                // A committed Session can open with a pending first turn when no launcher follow-up
                // is needed. A docked or background "Session started" receipt waits for terminal success.
                const presentsAtCommit = !hostSpawnExecutorRef.current
                    && !opts?.afterCreated && !current.authoringOrigin && !managedCreation
                    && !hasSeededPostCreateAction && resolvedInitialMessage?.kind !== 'action';
                const canOpenCommittedSession = () => isLaunchScopeStillActive()
                    && !sourceDraftCancellation.signal.aborted
                    && !launchOutlivesSurfaceRef.current
                    && (!presentsInPlaceRef.current || opensDestination);
                const presentCommittedSession = async (receipt: SessionSpawnNewCommittedReceipt): Promise<void> => {
                    if (!canOpenCommittedSession()) return;
                    // Creation now belongs to the committed Session. Route unmount
                    // retires the launcher, while its Account still owns settlement.
                    launchAbortRef.current = null;
                    const firstTurnText = spawnInput.initialInput
                        ? opts?.initialInputReviewComments?.displayText ?? initialMessageText : '';
                    const firstTurnLocalId = firstTurnText ? receipt.firstTurnLocalId ?? null : null;
                    const href = buildScopedSessionRouteHref({ sessionId: receipt.sessionId, serverId: resolvedTargetServerId });
                    const presentation = await presentCreatedNewSession({
                        sessionId: receipt.sessionId,
                        serverId: resolvedTargetServerId,
                        accountId: executionAccountScope.accountId,
                        requestId: readManualSessionSpawnOperation(executionAccountScope, launchAttempt.attemptId)?.requestId
                            ?? launchAttempt.attemptId,
                        router: launchRouter,
                        href,
                        isStillActive: canOpenCommittedSession,
                        // The launch still owns the first input: unconfirmed, and no optimistic thinking.
                        prepareDestination: firstTurnLocalId ? () => projectLaunchingNewSessionFirstTurn({
                            sessionId: receipt.sessionId,
                            localId: firstTurnLocalId,
                            text: firstTurnText,
                            fallbackAgentId: current.agentType,
                            fallbackPermissionMode: current.permissionMode,
                            fallbackModelMode: current.modelMode,
                        }) : undefined,
                    });
                    if (presentation === 'opened') {
                        presentedFirstTurn.present({ sessionId: receipt.sessionId, firstTurnLocalId });
                        presentedSessionHref = href;
                    }
                };
                let actionResult = await (async () => {
                    try {
                        if (!current.draftScope) {
                            throw new Error('Manual Session launch custody requires an active Account scope');
                        }
                        const execution = await executeManualSessionSpawnNewAction(spawnInput, {
                            surface: 'ui',
                            ...(sessionCreationReview === undefined ? {} : { sessionCreationReview }),
                            ...(current.managedDefaultsContext ? { sessionCreationDefaults: {
                                context: current.managedDefaultsContext,
                                ...(current.managedDefaultsUnavailable ? { unavailableDefaults: current.managedDefaultsUnavailable } : {}),
                                authoredChoices: current.managedDefaultsAuthoredChoices ?? {},
                            } } : {}),
                            teamCredentialPresentation: current.teamCredentialPresentation,
                            actionRequestId: launchAttempt.attemptId,
                            signal: sourceDraftCancellation.signal,
                        }, {
                            scope: executionAccountScope,
                            ...(capturedOrdinarySourceAccount ? { sourceAccountLifetime: { isCurrent: () => {
                                // A draft may disappear or live input may change without a
                                // React commit before custody completes. Retire the same
                                // invocation signal used by approvals and Account capture.
                                if (readLaunchIntent(latestParamsRef.current) !== submittedIntent.signature
                                    || (sourceDraftExisted && current.draftScope && current.draftId
                                        && !getSessionDraftSnapshot(current.draftScope, { kind: 'newSession', draftId: current.draftId }))) {
                                    sourceDraftCancellation.abort();
                                }
                                return capturedOrdinarySourceAccount?.accountLifetime.isCurrent() === true;
                            } } } : {}),
                            machineHomeDir: typeof current.selectedMachine?.metadata?.homeDir === 'string'
                                ? current.selectedMachine.metadata.homeDir
                                : '',
                            userAttemptId: launchAttempt.attemptId,
                            seedNonce: launchAttempt.spawnNonce,
                            ...(current.authoringOrigin ? { authoringOriginPersistence: birthOrigin
                                ? 'daemon-birth' as const : 'legacy-checkpoint' as const } : {}),
                            observation: {
                                onAccepted: receipt => {
                                    if (!isLaunchScopeStillActive() || sourceDraftCancellation.signal.aborted) return;
                                    if (receipt.operation) setManagedProgress({ signature: submittedIntent.signature,
                                        value: { kind: 'session_starting', operationAddress: receipt.operation } });
                                    handOffBeforeFollowUp?.();
                                },
                                ...(presentsAtCommit ? {
                                    operationProtocolCapabilities: current.selectedMachine?.operationProtocolCapabilities,
                                    onCommitted: presentCommittedSession,
                                } : {}),
                            },
                            executeAction: async (input, context, observation) => {
                                try {
                                    const hostSpawnExecutor = hostSpawnExecutorRef.current;
                                    return hostSpawnExecutor
                                        ? await hostSpawnExecutor(input, context)
                                        : await executeSessionSpawnNewAction(input, context, undefined, observation);
                                } catch (error) {
                                    const deferred = readActionApprovalRequestCreatedError(error);
                                    const onApprovalPending = latestParamsRef.current.onLaunchApprovalPending;
                                    if (!deferred || !onApprovalPending) throw error;
                                    // The approved receipt resumes this same custody and completion
                                    // closure, including attachments and first-turn admission.
                                    releaseUserRequestLease();
                                    const result = await awaitActionApprovalResult<SessionSpawnNewResultV1, SessionSpawnNewActionResult>({
                                        signal: sourceDraftCancellation.signal,
                                        execute: async callbacks => {
                                            onApprovalPending(createActionApprovalContinuation({
                                                artifactId: deferred.artifactId,
                                                actionId: 'session.spawn_new',
                                                scope: executionAccountScope,
                                                expectedRequestId: launchAttempt.attemptId,
                                                expectedInput: input,
                                                refreshAfterExecution: false,
                                                signal: sourceDraftCancellation.signal,
                                                onSucceeded: callbacks.onApprovalSucceeded,
                                                onFailed: callbacks.onApprovalFailed,
                                            }));
                                            return { approvalPending: true };
                                        },
                                        succeeded: value => ({ ok: true, result: value }),
                                        failed: (code, failure) => failure ?? { ok: false, errorCode: code, error: code },
                                        aborted: () => ({ ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' }),
                                    });
                                    return result;
                                }
                            },
                        });
                        if (execution.status === 'custody_unavailable') {
                            throw new Error(
                                execution.reason === 'corrupt'
                                    ? 'Saved launch recovery state is corrupt. No Session was started.'
                                    : 'This client cannot safely coordinate Session launch recovery. No Session was started.',
                            );
                        }
                        manualActionCustody = execution.custody;
                        launchAttempt = adoptNewSessionLaunchAttemptCustody(launchAttempt, {
                            userAttemptId: execution.custody.userAttemptId,
                            spawnNonce: execution.custody.nonce,
                            createdSessionId: execution.custody.createdSessionId,
                            firstTurnLocalId: execution.custody.firstTurnLocalId,
                            attachmentMessageLocalId: execution.custody.attachmentMessageLocalId,
                        });
                        submittedLaunch.attempt(launchAttempt);
                        return execution.action;
                    } catch (error) {
                        if (adoptCanonicalActionOperationSettlement()) {
                            if (mountedRef.current) {
                                current.setIsCreating(false);
                            }
                            return null;
                        }
                        throw error;
                    } finally {
                        releaseUserRequestLease();
                    }
                })();
                if (actionResult === null) return;
                // After presentation at commit, the launch settles on the destination the person now sees.
                presentedFirstTurn.observe(actionResult);
                const lateLaunchFailure = presentedFirstTurn.presented() !== null && isLaunchScopeStillCurrent()
                    && !(actionResult.ok && actionResult.result.type === 'success');
                // A route presentation unmounted the launcher, so the destination row carries the outcome.
                // An in-place host stays on screen: its alerts still speak, and Retry only while the
                // submitted draft is the one shown (a renewed draft must not re-run this launch).
                const launcherLeftForDestination = lateLaunchFailure && !presentsInPlaceRef.current;
                const launcherCanRetry = !lateLaunchFailure
                    || (presentsInPlaceRef.current && submittedLaunch.isSubmittedDraftShown());
                // A received creation fact transfers completion to the original
                // Account, even when route presentation has already unmounted.
                const canCompleteReceivedCreation = actionResult.ok && actionResult.result.type === 'success'
                    && presentedFirstTurn.ownsCompletion(isLaunchScopeStillCurrent())
                    && (capturedOrdinarySourceAccount != null || capturedOrdinaryTargetAccount != null)
                    && capturedOrdinarySourceAccount?.accountOnlyLifetime.isCurrent() !== false
                    && capturedOrdinaryTargetAccount?.accountOnlyLifetime.isCurrent() !== false;
                if ((!isLaunchScopeStillActive() || sourceDraftCancellation.signal.aborted) && !canCompleteReceivedCreation && !lateLaunchFailure) {
                    // Retiring the local observer cannot reject an attempt the
                    // canonical daemon operation already owns.
                    const canonicalSettlementAdopted = adoptCanonicalActionOperationSettlement();
                    if (!canonicalSettlementAdopted && mountedRef.current
                        && !actionResult.ok && actionResult.errorCode === 'action_account_scope_changed') {
                        // The custody owner refused dispatch, so there is no
                        // canonical operation to settle this mounted composer.
                        endLaunchAttemptWithoutSession();
                        launchDialogs.alert(t('common.error'), resolveSessionSpawnNewActionFailureMessage(actionResult));
                    }
                    if (!canonicalSettlementAdopted && isLaunchScopeStillActive()
                        && actionResult.ok && actionResult.result.type === 'success') {
                        // A direct receipt still proves creation. Retire its local
                        // follow-up without borrowing replacement Account authority.
                        launchAttempt = markNewSessionLaunchAttemptCreated(launchAttempt, {
                            createdSessionId: actionResult.result.sessionId,
                        });
                        launchAttempt = markNewSessionLaunchAttemptFailed(launchAttempt, {
                            phase: 'uploading_attachments',
                            error: new Error('continuation_retired'),
                            retryable: false,
                        });
                        submittedLaunch.attempt(launchAttempt);
                    }
                    if (mountedRef.current) {
                        current.setIsCreating(false);
                    }
                    return;
                }
                let observedCanonicalSettlement = false;
                if (actionResult.ok && actionResult.result.type === 'pending' && actionResult.result.outcome === 'accepted') {
                    const operation = await awaitManualSessionSpawnOperation(
                        executionAccountScope, launchAttempt.attemptId, sourceDraftCancellation.signal, spawnInput.executionTarget.machineId,
                    );
                    if (!operation || (!lateLaunchFailure && (!isLaunchScopeStillActive() || sourceDraftCancellation.signal.aborted))) {
                        adoptCanonicalActionOperationSettlement();
                        if (mountedRef.current) {
                            current.setIsCreating(false);
                        }
                        return;
                    }
                    observedCanonicalSettlement = true;
                    actionResult = 'type' in operation ? { ok: true, result: operation }
                        : projectManualSessionSpawnOperationResult(operation, spawnInput.executionTarget);
                }
                presentedFirstTurn.observe(actionResult);
                presentedFirstTurn.settle({ final: false });
                const spawnFailure = actionResult.ok
                    ? actionResult.result.type === 'error' ? actionResult.result : null
                    : actionResult.errorCode === 'spawn_failed' ? readSessionSpawnNewFailure(actionResult) : null;
                if (spawnFailure && isSessionSpawnGuestReconnectFailure(spawnFailure)) {
                    launchAttempt = markNewSessionLaunchAttemptFailed(launchAttempt, {
                        phase: 'spawning', error: new Error('spawn_failed'), retryable: true,
                    });
                    submittedLaunch.attempt(launchAttempt);
                    const message = resolveSessionSpawnNewResultFailureMessage(spawnFailure,
                        (!actionResult.ok ? actionResult.requestId : undefined)
                        ?? readManualSessionSpawnOperation(executionAccountScope, launchAttempt.attemptId)?.requestId
                        ?? launchAttempt.attemptId);
                    if (!launcherLeftForDestination) {
                        launchDialogs.alert(t('common.error'), message, [
                            ...(launcherCanRetry ? [{ text: t('common.retry'), onPress: () => {
                                if (isLaunchScopeStillActive()
                                    && readLaunchIntent(latestParamsRef.current) === submittedIntent.signature
                                    && areServerAccountScopesEqual(current.draftScope, latestParamsRef.current.draftScope)) {
                                    void handleCreateSession(opts);
                                }
                            } }] : []),
                            { text: t('common.cancel'), style: 'cancel' },
                        ]);
                    }
                    current.setIsCreating(false);
                    return;
                }
                if (!actionResult.ok) {
                    if (isActionApprovalDeclinedErrorCode(actionResult.errorCode)
                        || (observedCanonicalSettlement && actionResult.errorCode === 'action_cancelled')) {
                        endLaunchAttemptWithoutSession();
                        if (manualActionCustody) await completeManualSessionSpawnNewActionCustody(manualActionCustody);
                        manualActionCustody = null;
                        current.setIsCreating(false);
                        return;
                    }
                    if (!observedCanonicalSettlement && adoptCanonicalActionOperationSettlement()) {
                        if (mountedRef.current) {
                            current.setIsCreating(false);
                        }
                        return;
                    }
                    launchAttempt = markNewSessionLaunchAttemptFailed(launchAttempt, {
                        phase: 'spawning',
                        error: new Error(actionResult.error),
                        retryable: false,
                    });
                    endLaunchAttemptWithoutSession();
                    // An older CLI returning method-unavailable remains a typed
                    // Action failure; ordinary UI creation never falls back. A
                    // presented Session already says it on its first message.
                    if (!launcherLeftForDestination) {
                        launchDialogs.alert(
                            t('common.error'),
                            resolveSessionSpawnNewActionFailureMessage(actionResult),
                        );
                    }
                    current.setIsCreating(false);
                    return;
                }
                if (actionResult.result.type === 'pending') {
                    launchAttempt = markNewSessionLaunchAttemptFailed(launchAttempt, {
                        phase: 'spawning',
                        error: new Error('Session creation is pending.'),
                        retryable: true,
                    });
                    submittedLaunch.attempt(launchAttempt);
                    if (!launcherLeftForDestination) {
                        launchDialogs.alert(
                            t('common.error'),
                            resolveSessionSpawnNewResultFailureMessage(actionResult.result,
                                readManualSessionSpawnOperation(executionAccountScope, launchAttempt.attemptId)?.requestId
                                    ?? launchAttempt.attemptId),
                        );
                    }
                    current.setIsCreating(false);
                    return;
                }
                if (actionResult.result.type === 'error') {
                    launchAttempt = markNewSessionLaunchAttemptFailed(launchAttempt, {
                        phase: 'spawning',
                        error: new Error(actionResult.result.code),
                        retryable: actionResult.result.retryable,
                    });
                    if (actionResult.result.retryable) {
                        submittedLaunch.attempt(launchAttempt);
                    } else {
                        endLaunchAttemptWithoutSession();
                        if (manualActionCustody?.terminalResult) {
                            await completeManualSessionSpawnNewActionCustody(manualActionCustody);
                        }
                    }
                    if ('terminalHostError' in actionResult.result && actionResult.result.terminalHostError?.kind === 'terminal_host_unavailable') {
                        launchDialogs.alert(
                            t('newSession.terminalHostUnavailableTitle'),
                            t('newSession.terminalHostUnavailableBody', {
                                host: actionResult.result.terminalHostError.host === 'herdr' ? 'Herdr' : 'Zellij',
                            }),
                        );
                        current.setIsCreating(false);
                        return;
                    }
                    if (actionResult.result.code === 'machine_offline') {
                        showDaemonUnavailableAlert({
                            titleKey: 'errors.daemonUnavailableTitle',
                            bodyKey: 'newSession.daemonRpcUnavailableBody',
                            machine: current.selectedMachine,
                            // The launcher is gone after presentation; its draft owns the retry.
                            onRetry: actionResult.result.retryable && launcherCanRetry ? () => { void handleCreateSession(opts); } : null,
                            shouldContinue: () => (
                                isLaunchScopeStillActive()
                                && readLaunchIntent(latestParamsRef.current) === submittedIntent.signature
                                && areServerAccountScopesEqual(current.draftScope, latestParamsRef.current.draftScope)
                            ),
                        });
                        current.setIsCreating(false);
                        return;
                    }
                    const recoveryLifetime = captureActiveServerAccountScopeLifetime();
                    if (!launchOutlivesSurfaceRef.current && current.presentConnectedAccountPoolFailure?.(actionResult.result, (serviceId, binding) => {
                        if (mountedRef.current && submittedLaunch.isSubmittedDraftShown()) return false;
                        // A committed Session can retire/renew the launcher before its Pool refusal arrives.
                        // Recover through the ordinary draft owner instead of writing the retired screen's state.
                        seedAndOpenNewSession({
                            seed: { placement: { kind: 'exactTarget', serverId: resolvedTargetServerId,
                                    machineId: spawnInput.executionTarget.machineId } },
                            configurationDraft: buildNewSessionConfigurationDraft(buildNewSessionTempDataFromAuthoringDraft({
                                draft: { ...authoringDraft, connectedServices: { v: 2, bindingsByServiceId: {
                                    // The authored payload is JSON at this seam; the canonical ingress parser types it.
                                    ...ConnectedServiceBindingsV2IngressSchema.safeParse(authoringDraft.connectedServices).data?.bindingsByServiceId,
                                    [serviceId]: binding,
                                } } },
                                machineId: spawnInput.executionTarget.machineId,
                            })),
                            scope: current.draftScope ?? executionAccountScope,
                            isCurrent: () => recoveryLifetime?.isCurrent() === true
                                && areServerAccountScopesEqual(recoveryLifetime.scope, current.draftScope ?? executionAccountScope),
                            navigateToNewSession: ({ draftId }) => current.router.push({ pathname: '/new',
                                params: buildNewSessionLaunchRouteParams({ draftId, targetServerId: resolvedTargetServerId }) }),
                        });
                        return true;
                    })) {
                        current.setIsCreating(false);
                        return;
                    }
                    if (actionResult.result.code === 'spawn_failed' && actionResult.result.launchError?.profileRefusal) {
                        const failureScopeKey = buildLaunchErrorScopeKey(current, resolvedTargetServerId, 'profile');
                        if (isLaunchScopeStillActive()
                            && failureScopeKey === buildLaunchErrorScopeKey(latestParamsRef.current, undefined, 'profile')) {
                            setLaunchFailure({ kind: 'profile', scopeKey: failureScopeKey,
                                profileId: actionResult.result.launchError.profileRefusal.profileId,
                                message: resolveSessionSpawnNewResultFailureMessage(actionResult.result,
                                    readManualSessionSpawnOperation(executionAccountScope, launchAttempt.attemptId)?.requestId
                                        ?? launchAttempt.attemptId),
                                profile: selectedProfile });
                        }
                        current.setIsCreating(false);
                        return;
                    }
                    if (actionResult.result.code === 'spawn_failed' && actionResult.result.providerError) {
                        const failureScopeKey = buildLaunchErrorScopeKey(current, resolvedTargetServerId);
                        if (
                            isLaunchScopeStillActive()
                            && failureScopeKey === buildLaunchErrorScopeKey(latestParamsRef.current)
                        ) {
                            setLaunchFailure({
                                kind: 'provider',
                                error: actionResult.result.providerError,
                                scopeKey: failureScopeKey,
                            });
                        }
                        current.setIsCreating(false);
                        return;
                    }
                    if (presentSessionCredentialReconnectFailure({
                        errorCode: actionResult.result.code === 'spawn_failed' ? actionResult.result.launchError?.code : undefined,
                        message: resolveSessionSpawnNewResultFailureMessage(actionResult.result),
                    }, () => current.router.push('/(app)/settings/connected-services'), launchDialogs.alert)) {
                        current.setIsCreating(false);
                        return;
                    }
                    const refusedAgentId = 'agentId' in actionResult.result ? actionResult.result.agentId : null;
                    if (
                        refusedAgentId
                        && selectedMachineId
                        && presentMachineAgentStartRefusal({
                            code: actionResult.result.code,
                            agentTitle: resolveAgentCatalogProjection(refusedAgentId, { enabledAgentIds: [] }).title,
                            machineName: current.selectedMachine ? getMachineSentenceName(current.selectedMachine) : selectedMachineId,
                            setupOwnerName: current.selectedMachine?.access?.role === 'use'
                                ? current.selectedMachine.access.custodian.displayName?.trim() || null : undefined,
                            setupTarget: presentsInPlaceRef.current ? null : { machineId: selectedMachineId, serverId: resolvedTargetServerId },
                            openSetup: (href) => current.router.push(href as never),
                        })
                    ) {
                        current.setIsCreating(false);
                        return;
                    }
                    if (!launcherLeftForDestination && !presentSessionSpawnNewAgentIsolationFailure(actionResult.result,
                        href => current.router.push(href), launchDialogs.alert,
                        readManualSessionSpawnOperation(executionAccountScope, launchAttempt.attemptId)?.requestId
                            ?? launchAttempt.attemptId)) {
                        launchDialogs.alert(
                            t('common.error'),
                            resolveSessionSpawnNewResultFailureMessage(actionResult.result,
                                readManualSessionSpawnOperation(executionAccountScope, launchAttempt.attemptId)?.requestId
                                    ?? launchAttempt.attemptId),
                        );
                    }
                    current.setIsCreating(false);
                    return;
                }

                createdSessionId = actionResult.result.sessionId;
                if (current.continuationSourceSessionId) {
                    fireAndForget(moveSessionApprovalConsentsOnContinue({ scope: executionAccountScope,
                        fromSessionId: current.continuationSourceSessionId, toSessionId: createdSessionId }),
                        { tag: 'newSession.continuation.sessionApprovalConsents' });
                }
                const agentUpdate = actionResult.result.agentUpdate ?? managedAgentUpdate;
                if (agentUpdate) {
                    presentMachineAgentUpdateNotice({
                        status: agentUpdate.status,
                        requestId: agentUpdate.requestId
                            ?? readManualSessionSpawnOperation(executionAccountScope, launchAttempt.attemptId)?.requestId
                            ?? launchAttempt.attemptId,
                        agentTitle: resolveAgentCatalogProjection(agentUpdate.agentId, { enabledAgentIds: [] }).title,
                        machineName: current.selectedMachine ? getMachineSentenceName(current.selectedMachine) : selectedMachineId,
                    });
                }
                initialInputLocalId = (
                    actionResult.result.initialInput.status === 'accepted'
                    || actionResult.result.initialInput.status === 'alreadyAccepted'
                )
                    ? actionResult.result.initialInput.localId
                    : null;
                initialInputWasNotAccepted = Boolean(spawnInput.initialInput) && initialInputLocalId === null;
                initialInputFailure = actionResult.result.initialInput.status === 'rejected'
                    || actionResult.result.initialInput.status === 'outcomeUnknown'
                    ? actionResult.result.initialInput
                    : null;
                if (launchAttempt.createdSessionId !== createdSessionId) {
                    launchAttempt = markNewSessionLaunchAttemptCreated(launchAttempt, { createdSessionId });
                    submittedLaunch.attempt(launchAttempt);
                }
            }

            if (createdSessionId) {
                if (!presentedFirstTurn.ownsCompletion(isLaunchScopeStillCurrent())) {
                    submittedLaunch.attempt(null);
                    current.setIsCreating(false);
                    return;
                }
                // Hosts and recovered custody may return success without a live acceptance observer.
                handOffBeforeFollowUp?.();
                if (initialInputWasNotAccepted) {
                    // Preserve the draft and distinguish a proven rejection from
                    // uncertain admission before navigation unmounts the launcher.
                    preserveCreatedSessionDraftAfterUnacceptedFirstTurn({
                        sessionId: createdSessionId,
                        draftText: initialMessageText || sessionPrompt,
                        scope: executionAccountScope,
                    });
                    const rejectionLabel = getSessionInputFailureLabelKey({
                        code: initialInputFailure?.status === 'rejected' ? initialInputFailure.code : null,
                    });
                    const message = t(rejectionLabel ?? 'newSession.initialInputNotConfirmed');
                    // The Session exists and the draft is kept, so the title names what happened to the
                    // first message, never a bare "Error" (DESIGN.md error copy; lab `convo-ST`).
                    launchDialogs.alert(
                        t(rejectionLabel ? 'newSession.initialInputRejectedTitle' : 'newSession.initialInputNotConfirmedTitle'),
                        initialInputFailure ? resolveSessionSpawnNewInitialInputFailureMessage(initialInputFailure, message) : message,
                    );
                }
                if (profilesActive) {
                    fireAndForget(applyAuthoringMemory({ lastUsedProfile: current.selectedProfileId }), { tag: 'useCreateNewSession.lastUsedProfile' });
                }
                const spawnedBackendTargetKey = resolveBackendTargetKeyV2(selectedBackendTarget);
                const modelPolicyAgentId = current.staticAgentId ?? current.agentType;
                const modelsSeed = buildSessionModelsSeedRequest({
                    agentId: modelPolicyAgentId,
                    currentTargetKey: spawnedBackendTargetKey,
                    preflightTargetKey: current.preflightModelsTargetKey ?? null,
                    preflightModels: current.preflightModels,
                    currentModelId: spawnModelSelection?.ref.modelId ?? 'default',
                    hasCuratedStaticModels: getModelOptionsForAgentType(modelPolicyAgentId)
                        .some((option) => option.value !== 'default'),
                    updatedAt: spawnPermissionModeUpdatedAt,
                });
                if (modelsSeed) {
                    fireAndForget(publishSessionModelsSeedToMetadata({
                        sessionId: createdSessionId,
                        serverId: resolvedTargetServerId,
                        seed: modelsSeed,
                        updateSessionMetadataWithRetry: (sessionId, updater, options) => (
                            sync.patchSessionMetadataWithRetry(sessionId, updater, options)
                        ),
                    }), {
                        tag: 'new-session-model-list-seed',
                        onError: captureExceptionIfEnabled,
                    });
                }
                let postSpawnFollowUpError: unknown = null;
                const postSpawnFollowUpRetryRef: { current: (() => Promise<void>) | null } = { current: null };
                let suppressPostSpawnFollowUpAlert = false;
                let postSpawnFailurePhase: 'created' | 'uploading_attachments' = 'created';
                let postSpawnSessionRouteSuffix = '';
                let postSpawnReplacementHref: string | null = null;
                const presentedAtCommit = presentedFirstTurn.presented()?.sessionId === createdSessionId
                    ? presentedFirstTurn.presented() : null;
                let createdSessionRouteOpened = presentedAtCommit !== null;

                const buildCreatedSessionRoute = () => buildScopedSessionRouteHref({
                    sessionId: createdSessionId,
                    serverId: resolvedTargetServerId,
                    suffix: postSpawnSessionRouteSuffix,
                });

                const projectCreatedSessionFirstTurnForRoute = (): void => {
                    if (!initialMessageText || !initialInputLocalId) {
                        return;
                    }
                    projectAcceptedNewSessionFirstTurn({
                        sessionId: createdSessionId,
                        localId: initialInputLocalId,
                        text: opts?.initialInputReviewComments?.displayText ?? initialMessageText,
                        fallbackAgentId: current.agentType,
                        fallbackPermissionMode: current.permissionMode,
                        fallbackModelMode: current.modelMode,
                    });
                };

                const presentCreatedSessionRoute = async (options?: Readonly<{ projectFirstTurn?: boolean }>) => {
                    const presentation = await presentCreatedNewSession({
                        sessionId: createdSessionId,
                        serverId: resolvedTargetServerId,
                        accountId: executionAccountScope.accountId,
                        requestId: readManualSessionSpawnOperation(executionAccountScope, launchAttempt.attemptId)?.requestId
                            ?? launchAttempt.attemptId,
                        router: launchRouter,
                        href: postSpawnReplacementHref ?? buildCreatedSessionRoute(),
                        isStillActive: isLaunchScopeStillActive,
                        prepareDestination: options?.projectFirstTurn === true || initialInputLocalId !== null
                            ? projectCreatedSessionFirstTurnForRoute
                            : undefined,
                    });
                    createdSessionRouteOpened = presentation === 'opened';
                    return presentation;
                };

                if (presentedAtCommit) {
                    // Settle the launch-owned first message in place: accepted input replaces it,
                    // anything else hands it to the owner that kept the text (the Session draft).
                    if (presentedAtCommit.firstTurnLocalId && presentedAtCommit.firstTurnLocalId !== initialInputLocalId) {
                        clearLaunchingNewSessionFirstTurn({ sessionId: createdSessionId, localId: presentedAtCommit.firstTurnLocalId });
                    }
                    if (initialInputLocalId) projectCreatedSessionFirstTurnForRoute();
                    presentedFirstTurn.markSettled();
                }

                const runAfterCreatedFollowUp = async (): Promise<void> => {
                    const cancellation = new AbortController();
                    const accounts = [capturedOrdinarySourceAccount, capturedOrdinaryTargetAccount].filter(
                        (account): account is LazyActionAccountContext => account != null,
                    );
                    const retirements = accounts.map(account => account.accountOnlyLifetime.onRetire(() => cancellation.abort()));
                    // Pre-Session embedded creation has host-owned authority in
                    // place of UI Account custody and remains bound to that host.
                    const abortFromHost = () => cancellation.abort();
                    if (accounts.length === 0) {
                        sourceDraftCancellation.signal.addEventListener('abort', abortFromHost, { once: true });
                        if (sourceDraftCancellation.signal.aborted) cancellation.abort();
                    }
                    try {
                        cancellation.signal.throwIfAborted();
                        // This is the incumbent post-create setup checkpoint. A
                        // retained retry must not replay a completed built-in action.
                        postSpawnFailurePhase = 'uploading_attachments';
                        if (current.authoringOrigin) {
                            const custodyState = manualActionCustody ? null : readSpawnAttemptCustodyState(executionAccountScope);
                            const retained = custodyState?.status === 'valid' ? Object.values(custodyState.attempts).filter(
                                attempt => attempt.userAttemptId === launchAttempt.attemptId && attempt.machineId === selectedMachineId,
                            ) : [];
                            await persistCreatedSessionAuthoringOrigin({
                                sessionId: createdSessionId,
                                serverId: resolvedTargetServerId,
                                origin: current.authoringOrigin,
                                originPersistence: manualActionCustody?.authoringOriginPersistence
                                    ?? (retained.length === 1 ? retained[0]?.authoringOriginPersistence : undefined) ?? 'unknown',
                                shouldContinue: () => authoringOriginLifetime?.isCurrent() === true && isLaunchScopeStillActive(),
                                updateSessionMetadataWithRetry: sync.patchSessionMetadataWithRetry,
                            });
                        }
                        await opts?.afterCreated?.({
                            sessionId: createdSessionId,
                            sessionTarget: { ...executionAccountScope, sessionId: createdSessionId },
                            signal: cancellation.signal,
                            effectiveSpawnServerId: resolvedTargetServerId,
                            launchAttempt,
                        });
                        if (hasSeededPostCreateAction) {
                            await runSeededPostCreateAction({
                                scope: executionAccountScope,
                                sessionId: createdSessionId,
                                requestId: readManualSessionSpawnOperation(executionAccountScope, launchAttempt.attemptId)?.requestId
                                    ?? launchAttempt.attemptId,
                                signal: cancellation.signal,
                                alert: launchDialogs.alert,
                            });
                        }
                    } catch (error) {
                        postSpawnFollowUpError = error;
                        postSpawnFollowUpRetryRef.current = runAfterCreatedFollowUp;
                        throw error;
                    } finally {
                        for (const retirement of retirements) retirement.dispose();
                        sourceDraftCancellation.signal.removeEventListener('abort', abortFromHost);
                    }
                };
                const hasPostCreateFollowUp = current.authoringOrigin || opts?.afterCreated || hasSeededPostCreateAction;
                const createdSessionCompletion = createCreatedNewSessionCompletion({
                    ...(hasPostCreateFollowUp ? { followUp: runAfterCreatedFollowUp } : {}),
                    present: () => presentCreatedSessionRoute(),
                });

                const runBuiltInPostSpawnFollowUp = async (): Promise<void> => {
                    if (resolvedInitialMessage?.kind === 'action') {
                        const actionExecutor = createDefaultActionExecutor({
                            resolveServerIdForSessionId: (sessionId) => {
                                if (sessionId === createdSessionId && resolvedTargetServerId) {
                                    return resolvedTargetServerId;
                                }
                                return resolveServerIdForSessionIdFromLocalCache(sessionId);
                            },
                            openSession: (sessionId, options) => {
                                postSpawnReplacementHref = buildScopedSessionRouteHref({
                                    sessionId,
                                    query: options?.query,
                                    serverId: options?.serverId
                                        ?? (sessionId === createdSessionId
                                            ? resolvedTargetServerId
                                            : resolveServerIdForSessionIdFromLocalCache(sessionId)),
                                });
                            },
                            openRoute: (route) => {
                                postSpawnReplacementHref = route;
                            },
                        });

                        await executeSessionComposerResolution({
                            resolved: resolvedInitialMessage,
                            sessionId: createdSessionId,
                            accountScope: executionAccountScope,
                            openExecutionRunDraft,
                            agentId: current.agentType,
                            backendTarget,
                            permissionMode: current.permissionMode,
                            actionExecutor,
                            previousMessage: sessionPrompt,
                            setMessage: () => {},
                            clearDraft: () => {},
                            trackMessageSent: () => {},
                            navigateToRuns: () => {
                                postSpawnSessionRouteSuffix = '/runs';
                            },
                            modalAlert: (title, message) => launchDialogs.alert(title, message),
                        });
                    }
                };

                const shouldRunBuiltInPostSpawnFollowUp = !retryableLaunchAttempt?.phaseErrors.uploading_attachments;
                if (shouldRunBuiltInPostSpawnFollowUp) {
                    try {
                        await runBuiltInPostSpawnFollowUp();
                    } catch (error) {
                        postSpawnFailurePhase = 'created';
                        postSpawnFollowUpError = error;
                        postSpawnFollowUpRetryRef.current = async () => {
                            await runBuiltInPostSpawnFollowUp();
                            await runAfterCreatedFollowUp();
                        };
                    }
                }

                storage.getState().updateSessionPermissionMode(createdSessionId, current.permissionMode);
                if (staticAgentId && getAgentCore(staticAgentId)?.model?.supportsSelection !== false && current.modelMode && current.modelMode !== 'default') {
                    storage.getState().updateSessionModelMode(createdSessionId, current.modelMode);
                }

                if (!postSpawnFollowUpError && hasPostCreateFollowUp) {
                    try {
                        await createdSessionCompletion.followUp();
                    } catch (error) {
                        postSpawnFollowUpError = error;
                    }
                }

                const classifyCurrentPostSpawnFailure = (failure: unknown) => classifyLaunchRetryFailure({
                    phase: postSpawnFailurePhase === 'uploading_attachments' ? 'upload' : 'send',
                    failure,
                });

                while (
                    postSpawnFollowUpError
                    && !launchOutlivesSurfaceRef.current
                    && postSpawnFollowUpRetryRef.current
                ) {
                    const retryFailureClassification = classifyCurrentPostSpawnFailure(postSpawnFollowUpError);
                    if (retryFailureClassification.kind !== 'retryable') {
                        break;
                    }
                    current.setIsCreating(false);
                    const retryResolution = await promptDaemonUnavailableRetry({
                        titleKey: retryFailureClassification.titleKey,
                        bodyKey: retryFailureClassification.bodyKey,
                        machine: current.selectedMachine,
                    });
                    suppressPostSpawnFollowUpAlert = true;

                    if (retryResolution !== 'retry' || !mountedRef.current) {
                        break;
                    }

                    if (!isLaunchScopeStillActive()) {
                        postSpawnFollowUpError = null;
                        postSpawnFollowUpRetryRef.current = null;
                        suppressPostSpawnFollowUpAlert = true;
                        break;
                    }

                    current.setIsCreating(true);
                    const retryFollowUp = postSpawnFollowUpRetryRef.current;
                    try {
                        await retryFollowUp();
                        postSpawnFollowUpError = null;
                        postSpawnFollowUpRetryRef.current = null;
                    } catch (error) {
                        suppressPostSpawnFollowUpAlert = false;
                        if (!postSpawnFollowUpError) {
                            postSpawnFollowUpError = error;
                        }
                    }
                }

                if (!presentedFirstTurn.ownsCompletion(isLaunchScopeStillCurrent())) {
                    submittedLaunch.attempt(null);
                    current.setIsCreating(false);
                    return;
                }

                if (postSpawnFollowUpError) {
                    const draftScope = current.draftScope;
                    if (draftScope) {
                        actionOperationStore.markFollowUpNeedsAttention({
                            serverId: executionAccountScope.serverId,
                            accountId: executionAccountScope.accountId,
                            requestId: readManualSessionSpawnOperation(executionAccountScope, launchAttempt.attemptId)?.requestId
                                ?? launchAttempt.attemptId,
                            message: t('inbox.actionOperations.followUpNeedsAttention'),
                        });
                    }
                    const retryFailureClassification = classifyCurrentPostSpawnFailure(postSpawnFollowUpError);
                    launchAttempt = markNewSessionLaunchAttemptFailed(launchAttempt, {
                        phase: postSpawnFailurePhase,
                        error: postSpawnFollowUpError,
                        retryable: retryFailureClassification.kind === 'retryable',
                    });
                    submittedLaunch.attempt(launchAttempt);
                    if (!suppressPostSpawnFollowUpAlert) {
                        launchDialogs.alert(
                            t('common.error'),
                            postSpawnFollowUpError instanceof Error ? postSpawnFollowUpError.message : t('common.error'),
                        );
                    }
                    if (mountedRef.current) {
                        current.setIsCreating(false);
                    }
                    return;
                } else {
                    if (hostSpawnExecutorRef.current && current.draftScope && current.draftId && isLaunchScopeStillActive()) {
                        current.flushComposerInput?.();
                        preserveCreatedSessionSuccessorDraft({
                            scope: current.draftScope,
                            draftId: current.draftId,
                            launchUserAttemptId: launchAttempt.attemptId,
                            sessionId: createdSessionId,
                        });
                    }
                    launchAttempt = markNewSessionLaunchAttemptComplete(launchAttempt);
                    // Draft consumption belongs to successful launch settlement. Destination hydration
                    // and opening are independent, and later edits still belong to the draft.
                    if (!opts?.deferAcceptedDraftClearToDocument && mountedRef.current && submittedLaunch.isSubmittedDraftShown()) {
                        current.disableDraftPersistence?.();
                    }
                    await clearCompletedDraft(launchAttempt.attemptId);
                    if (hasSeededPostCreateAction) handOffAdmittedLaunch();
                    if (opts?.onAfterCreatedSettled && isLaunchScopeStillActive()) {
                        reportAfterCreatedSettlement(initialInputWasNotAccepted
                            ? { status: 'rejected' }
                            : { status: 'accepted', sessionId: createdSessionId });
                    }
                }

                if (!createdSessionRouteOpened && isLaunchScopeStillActive()) {
                    try {
                        await createdSessionCompletion.present();
                    } catch (error) {
                        if (!isLaunchScopeStillActive()) {
                            submittedLaunch.attempt(null);
                            current.setIsCreating(false);
                            return;
                        }
                        throw error;
                    }
                }
                if (manualActionCustody) {
                    await completeManualSessionSpawnNewActionCustody(manualActionCustody);
                    manualActionCustody = null;
                }
                submittedLaunch.attempt(null);
            } else {
                throw new Error('Created session ID is required to complete launch.');
            }
        } catch (error) {
            captureExceptionIfEnabled(error, {
                tags: {
                    area: 'new_session',
                    action: 'create_session',
                },
                extra: {
                    phase: 'create_session',
                    machineId: current.selectedMachineId,
                    selectedPath: effectiveSelectedPath,
                },
            });
            if (!mountedRef.current && !launchOutlivesSurfaceRef.current) return;
            // Instructions that could not be prepared keep the draft and say so (60s2/61s1).
            let errorMessage = error instanceof NewSessionInstructionsPreparationError
                ? t('bots.create.documentFailed')
                : error instanceof Error
                    ? getErrorMessage(error)
                    : t('newSession.failedToStart');
            if (error instanceof Error) {
                if (error.message.includes('timeout')) {
                    errorMessage = 'Session startup timed out. The machine may be slow or the daemon may not be responding.';
                } else if (error.message.includes('Socket not connected')) {
                    errorMessage = 'Not connected to server. Check your internet connection.';
                }
            }
            launchDialogs.alert(t('common.error'), errorMessage);
            latestParamsRef.current.setIsCreating(false);
        } finally {
            try {
                settlePresentedFirstTurnOnExit?.();
            } catch (error) {
                captureExceptionIfEnabled(error, { tags: { area: 'new_session', action: 'settle_presented_first_turn' } });
            }
            disposeOrdinaryDraftLifetime?.();
            capturedOrdinarySourceAccount?.dispose();
            capturedOrdinaryTargetAccount?.dispose();
            if (!settlementOwnedByCanonicalOperation) {
                reportAfterCreatedSettlement({ status: 'rejected' });
            }
            if (launchOutlivesSurfaceRef.current && !backgroundLaunchSettled) newSessionBackgroundLaunches.ended();
            backgroundableLaunchInFlightRef.current = false;
            createInFlightRef.current = false;
            launchAbortIntentRef.current = null;
        }
    }, [embeddedHost, handOffLaunchToBackground, applyAuthoringMemory, expectedSettingsScope, mountedRef, publishLaunchAttempt, managedApproval.requestApproval, openExecutionRunDraft, launchFailure]);

    const visibleLaunchFailure = readCurrentLaunchFailure(launchFailure, params);
    React.useEffect(() => {
        if (launchFailure && !visibleLaunchFailure) {
            setLaunchFailure(current => current === launchFailure ? null : current);
        }
    }, [launchFailure, visibleLaunchFailure]);
    const providerLaunchError = visibleLaunchFailure?.kind === 'provider' ? visibleLaunchFailure.error : null;
    const profileLaunchFailure = React.useMemo(() => visibleLaunchFailure?.kind === 'profile'
        ? { profileId: visibleLaunchFailure.profileId, message: visibleLaunchFailure.message } : null, [visibleLaunchFailure]);
    const retryProviderLaunch = React.useCallback(() => {
        if (readCurrentLaunchFailure(launchFailure, latestParamsRef.current)?.kind !== 'provider') {
            return;
        }
        void handleCreateSession(lastCreateOptionsRef.current);
    }, [handleCreateSession, launchFailure]);

    const retryManagedMachineInstallation = React.useCallback(() => {
        void handleCreateSession({ ...lastCreateOptionsRef.current, managedMachineRetryInstallation: true, managedMachineSetupRecovery: undefined });
    }, [handleCreateSession]);
    const retryManagedMachineSetup = React.useCallback(() => {
        if (!managedAcquisitionRef.current?.managedId || !latestParamsRef.current.managedMachineSelection) return;
        void handleCreateSession({ ...lastCreateOptionsRef.current, managedMachineRetryInstallation: undefined, managedMachineSetupRecovery: 'retry' });
    }, [handleCreateSession]);
    const continueWithoutManagedMachineSetup = React.useCallback(() => {
        if (!managedAcquisitionRef.current?.managedId || !latestParamsRef.current.managedMachineSelection) return;
        void handleCreateSession({ ...lastCreateOptionsRef.current, managedMachineRetryInstallation: undefined, managedMachineSetupRecovery: 'skip' });
    }, [handleCreateSession]);
    const deleteManagedMachineAfterFailedSetup = React.useCallback(() => {
        if (!managedAcquisitionRef.current?.managedId || !latestParamsRef.current.managedMachineSelection) return;
        void handleCreateSession({ ...lastCreateOptionsRef.current, managedMachineRetryInstallation: undefined, managedMachineSetupRecovery: 'delete' });
    }, [handleCreateSession]);
    const cancelManagedMachineCreation = React.useCallback(() => {
        // Local cancellation must retire custody before a late install can settle,
        // not wait for React to commit removal of the selected draft.
        launchAbortRef.current?.abort();
        latestParamsRef.current.setIsCreating(false);
    }, []);
    const visibleManagedProgress: ManagedMachineCreationProgress = managedProgress.signature === launchIntentSignature
        ? managedProgress.value : { kind: 'idle' };
    const retainedManagedId = params.managedMachineAcquisition?.managedId;
    const recoveredManagedProgress: ManagedMachineCreationProgress = visibleManagedProgress.kind === 'idle' && retainedManagedId && managedOperation
        ? managedOperation.snapshot.state === 'failed' || managedOperation.snapshot.state === 'cancelled'
            ? { kind: 'failed', managedId: retainedManagedId, operation: managedOperation.snapshot,
                operationObservation: managedOperation.observation,
                code: managedOperation.snapshot.error?.errorCode ?? (managedOperation.snapshot.state === 'cancelled' ? 'creation_canceled' : 'installation_failed') }
            : { kind: 'acquiring', managedId: retainedManagedId, operation: managedOperation.snapshot, operationObservation: managedOperation.observation }
        : visibleManagedProgress;
    const managedMachineCreationProgress: ManagedMachineCreationProgress = (recoveredManagedProgress.kind === 'acquiring' || recoveredManagedProgress.kind === 'session_starting') && managedOperation
        ? { ...recoveredManagedProgress, operation: managedOperation.snapshot, operationObservation: managedOperation.observation } : recoveredManagedProgress;
    // A creation no operation reports for (the Account recipe this device runs, or one whose app was closed):
    // its one retained row's recorded facts are the stages (58B-U1) and say when it was interrupted.
    const unreportedProgress = managedMachineCreationProgress.kind === 'idle' || managedMachineCreationProgress.kind === 'acquiring';
    const unreportedManagedId = unreportedProgress && !managedOperation && managedAcquisitionMatchesSelection
        ? (managedMachineCreationProgress.kind === 'acquiring' ? managedMachineCreationProgress.managedId : undefined) ?? retainedManagedId
        : undefined;
    const retainedInventory = useManagedMachineInventory(unreportedManagedId && managedOperationServerId ? [managedOperationServerId] : [],
        unreportedManagedId);
    const retainedRow = unreportedManagedId && managedOperationServerId
        ? retainedInventory.machinesByServerId[managedOperationServerId]?.find(machine => machine.id === unreportedManagedId) : undefined;
    const retainedManagedMachine = React.useMemo(() => retainedRow && managedOperationServerId
        ? { machine: retainedRow, serverId: managedOperationServerId } : null, [retainedRow, managedOperationServerId]);
    const configuredNewSessionAfterSend = useSetting('newSessionAfterSendV1');
    const newSessionAfterSendBackgroundable = isNewSessionLaunchBackgroundable(params, embeddedHost, hostSpawnExecutor);
    const newSessionAfterSendMode = newSessionAfterSendBackgroundable ? resolveNewSessionAfterSend({
        configured: configuredNewSessionAfterSend,
        docked: embeddedHost?.kind === 'docked',
        backgroundable: true,
    }) : undefined;

    return { handleCreateSession, newSessionAfterSendMode, handOffLaunchToBackground, providerLaunchError, profileLaunchFailure, retryProviderLaunch, managedMachineCreationProgress, retainedManagedMachine,
        retryManagedMachineInstallation, retryManagedMachineSetup, continueWithoutManagedMachineSetup,
        deleteManagedMachineAfterFailedSetup, cancelManagedMachineCreation };
}
