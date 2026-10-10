import { canCreateSessionWithInitialAccess, useSessionCollaborationAvailability } from '@/hooks/session/useSessionCollaborationAvailability';
import * as React from 'react';

import { t } from '@/text';
import { Modal } from '@/modal';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { resolveAgentCatalogProjection } from '@/agents/backendCatalog/agentCatalogProjection';
import { machineCollectionHref } from '@/components/settings/machines/collection/machineCollectionModel';
import { sync } from '@/sync/sync';
import { actionOperationPresentationCoordinator } from '@/components/inbox/actionOperations/actionOperationPresentationRuntime';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { useApplyAuthoringMemoryDelta, useApplySettings } from '@/sync/store/settingsWriters';
import { storage } from '@/sync/domains/state/storage';
import { resolveTerminalSpawnOptions } from '@/sync/domains/settings/terminalSettings';
import { CREATED_SESSION_NOT_AVAILABLE_LOCALLY_ERROR } from '@/sync/runtime/sessionMessageDeliveryErrors';
import { areServerProfileIdentifiersEquivalent, getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveNewSessionServerTarget } from '@/sync/domains/server/selection/serverSelectionResolver';
import { getMissingRequiredConfigEnvVarNames } from '@/utils/profiles/profileConfigRequirements';
import type { SecretChoiceByProfileIdByEnvVarName } from '@/utils/secrets/secretRequirementApply';
import { getBuiltInProfile } from '@/sync/domains/profiles/profileUtils';
import { isProfileCompatibleWithBackendTarget, type AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import type { Settings } from '@/sync/domains/settings/settings';
import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import type { SavedSecretReferenceResolution } from '@/sync/store/settings/savedSecretCatalogSnapshot';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { captureActiveServerAccountScopeLifetime, getActiveServerAccountScope, selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import { getPromptLibraryCatalogValue } from '@/sync/store/settings/promptLibraryCatalogSnapshot';
import { refreshPromptLibraryCatalog } from '@/sync/engine/settings/promptLibraryCatalogEngine';
import type { ZenTaskSource } from '@/sync/domains/todos/todoStoredContent';
import { linkTaskToSession } from '@/sync/domains/todos/taskSessionLink';
import { TodoSessionLinkError } from '@/sync/domains/todos/todoOps';
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
import type { UseMachineEnvPresenceResult } from '@/hooks/machine/useMachineEnvPresence';
import { getMachineCapabilitiesSnapshot } from '@/hooks/server/useMachineCapabilitiesCache';
import type { PermissionMode, ModelMode } from '@/sync/domains/permissions/permissionTypes';
import { getModelOptionsForAgentType, type PreflightModelList } from '@/sync/domains/models/modelOptions';
import {
    type BackendTargetRefV2,
    type BackendTargetRefV2Input,
    type PersistedBackendTargetRefV2,
    type ProviderErrorV1,
    type SecretReferenceOverlayV1,
    type WindowsRemoteSessionLaunchMode,
} from '@happier-dev/protocol';
import type { AcpConfigOptionOverridesV1, ComposerSnapshotV1, RawIngressStructuredInputV1 } from '@happier-dev/protocol';
import type { SessionSpawnNewInitialInputV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import type { SessionManagedCreationV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import type { AttachmentDraft } from '@/components/sessions/attachments/attachmentDraftModel';
import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { parsePermissionIntentAlias } from '@happier-dev/agents';
import { nowServerMs } from '@/sync/runtime/time';
import { resolveSessionComposerSend } from '@/sync/domains/input/slashCommands/resolveSessionComposerSend';
import { executeSessionComposerResolution } from '@/sync/domains/input/slashCommands/executeSessionComposerResolution';
import { expandPromptTemplateInvocation } from '@/sync/domains/input/slashCommands/expandPromptTemplateInvocation';
import { resolvePromptInvocationComposerSendAction } from '@/sync/domains/input/slashCommands/promptInvocationBehavior';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import {
    classifyLaunchRetryFailure,
    promptDaemonUnavailableRetry,
    showDaemonUnavailableAlert,
} from '@/utils/errors/daemonUnavailableAlert';
import { captureExceptionIfEnabled } from '@/utils/system/sentry';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useMountedRef } from '@/hooks/ui/useMountedRef';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { useNewSessionEmbeddedHost, useNewSessionHostCreationProfile, useNewSessionHostSpawnExecutor } from '@/components/sessions/new/navigation/newSessionHost';
import { isHostBoundNewSessionMachine } from '@/components/sessions/new/modules/canCreateNewSession';
import { createNewSessionActionOperationOrigin } from '@/components/sessions/new/navigation/newSessionActionOperationOrigin';
import {
    presentCreatedNewSession,
    projectAcceptedNewSessionFirstTurn,
} from '@/components/sessions/new/navigation/presentCreatedNewSession';
import {
    CreatedNewSessionCompletionError,
    createCreatedNewSessionCompletion,
} from '@/components/sessions/new/navigation/completeCreatedNewSession';
import type { SessionMcpSelectionV1 } from '@happier-dev/protocol';
import type { SessionSpawnSourceContextV1 } from '@happier-dev/protocol';
import type { NewSessionCheckoutCreationDraft } from '@/sync/domains/state/newSessionCheckoutDraft';
import { resolveNewSessionOperationalBackendTarget } from '@/components/sessions/new/modules/newSessionCapabilityProbeContext';
import {
    buildNewSessionLaunchScopeKey,
    normalizeLaunchScopePart,
} from '@/components/sessions/new/modules/newSessionLaunchScope';
import { resolveServerIdForSessionIdFromLocalCache } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';
import {
    buildNewSessionAuthoringDraftFromResolvedInputs,
    buildSessionServerStartSpawnDraftV1FromAuthoringDraft,
    buildSessionSpawnNewInputV2FromAuthoringDraft,
    buildManagedAcquireAgentStartV1FromAuthoringDraft,
} from '@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters';
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
    resolveSessionSpawnNewActionFailureMessage,
    resolveSessionSpawnNewResultFailureMessage,
    type ManualSessionSpawnNewActionCustody,
} from '@/sync/ops/actions/sessionSpawnNewAction';
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
import type { UploadedAttachment } from '@/components/sessions/attachments/uploadAttachmentDraftsToSession';
import type { NewSessionDraft } from '@/sync/domains/state/persistence';
import { persistCreatedSessionAuthoringOrigin } from '@/components/sessions/new/modules/newSessionAuthoringOrigin';
import type { ManagedMachineSelectionDraft, ManagedMachineAcquisitionDraft } from '@/sync/domains/state/newSessionManagedMachineDraft';
import { managedMachineCreationIntent } from '@/sync/domains/state/newSessionManagedMachineDraft';
import { runManagedMachineCreation, type ManagedMachineCreationProgress } from '@/components/settings/machines/managed/managedMachineCreation';
import { bindNewManagedMachineCreationScope } from '@/sync/ops/actions/managedCreationScopeBinding';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { captureLazyActionAccountContext, type LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { sessionInstructionsActions, type SessionInstructionsAuthoringDraft } from '@/sync/ops/promptLibrary/sessionInstructions';
import { NewSessionInstructionsPreparationError } from '@/components/sessions/new/modules/newSessionInstructionsPreparation';
import { SessionPromptStackV1Schema, writeSessionContextIntentV1ToMetadata, type SessionPromptStackV1 } from '@happier-dev/protocol/sessions/context/sessionContextV1';
import { buildSessionInstructionsContextIntentV1 } from '@happier-dev/protocol/actions/sessionStateFieldActions';
import { readNewSessionDraftFromRepository, writeNewSessionInstructionsToRepository } from '@/components/sessions/composer/newSessionDraftRepositoryAdapter';

type MutableSettingsDelta = {
    -readonly [TKey in keyof Settings]?: Settings[TKey];
};

export type CreatedSessionFollowUpContext = Readonly<{
    sessionId: string;
    effectiveSpawnServerId: string | null;
    launchAttempt: NewSessionLaunchAttempt;
    /**
     * Runner creation has already uploaded and digest-verified its immutable
     * staged bytes. The incumbent post-create owner consumes this projection
     * instead of opening the mutable attachment drafts a second time.
     */
    preuploadedAttachments?: readonly UploadedAttachment[];
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
    complete: (sessionId: string, uploaded: readonly UploadedAttachment[]) => Promise<void>;
    /** Called when the activation is definitively abandoned or closed. */
    reject: () => void;
}>;

export type HandleCreateSessionOptions = Readonly<{
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
     * A semantic document coordinator will exact-snapshot clear after accepted
     * create. The incumbent whole-draft clear must stay inactive so a newer
     * document revision remains persistable.
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

type ProviderLaunchErrorScopeParams = Readonly<{
    selectedMachineId: string | null;
    targetServerId?: string | null;
    allowedTargetServerIds?: ReadonlyArray<string>;
    agentType: string;
    backendTarget?: PersistedBackendTargetRefV2;
    spawnBackendTarget?: BackendTargetRefV2Input;
    useProfiles: boolean;
    selectedProfileId: string | null;
    authoringDraft?: SessionAuthoringDraft | null;
    modelMode: ModelMode;
}>;

function resolveStaticAgentId(params: Readonly<{
    agentType: string;
    staticAgentId?: AgentId | null;
}>): AgentId | null {
    if (isBundledAgentId(params.staticAgentId)) {
        return params.staticAgentId;
    }
    return isBundledAgentId(params.agentType) ? params.agentType : null;
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

function buildProviderLaunchErrorScopeKey(
    params: ProviderLaunchErrorScopeParams,
    resolvedTargetServerId?: string,
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
        modelRef?.agentTargetKey ?? null,
        modelRef?.providerConnectionId ?? null,
        modelRef?.modelId ?? params.modelMode,
    ]);
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
    /** Resolves only after the enrolled target's own authoritative projection is ready. */
    onManagedMachineEnrolled?: (machineId: string, signal: AbortSignal) => Promise<void>;
    onManagedMachineDeleteRequested?: () => void;

    setIsCreating: (v: boolean) => void;
    setIsResumeSupportChecking: (v: boolean) => void;

    /**
     * Legacy compatibility only.
     * New-session checkout materialization is now driven exclusively by `checkoutCreationDraft`.
     */
    checkoutCreationDraft?: NewSessionCheckoutCreationDraft | null;
    settings: Settings;
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

    promptStore: NewSessionPromptStore;
    /** Leaf-local title edits are captured at Send, before any asynchronous placement. */
    getSessionName?: () => string;
    getInstructionsDraft?: () => SessionInstructionsAuthoringDraft | null;
    getInstructionsPromptStack?: () => SessionPromptStackV1 | undefined;
    /** Flushes the mounted input into its canonical draft before an asynchronous handoff. */
    flushComposerInput?: () => void;
    setSessionPrompt?: (prompt: string) => void;
    resumeSessionId: string;
    agentNewSessionOptions?: Record<string, unknown> | null;
    authoringDraft?: SessionAuthoringDraft | null;
    authoringCommitPending?: boolean;
    /** Fresh admission of inherited Connected Account purpose defaults; explicit choices bypass in their owner. */
    requireConnectedAccountDefaultsReady?: () => void;
    mcpSelection?: SessionMcpSelectionV1 | null;
    windowsRemoteSessionLaunchModeOverride?: WindowsRemoteSessionLaunchMode | null;

    machineEnvPresence: UseMachineEnvPresenceResult;
    secrets: SavedSecret[];
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
    zenTaskSource?: ZenTaskSource | null;
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
    launchIntentSignature: string;
    launchUserAttemptId?: string | null;
    onLaunchUserAttemptIdChange?: (userAttemptId: string | null) => void;
    /**
     * Continuation recipe when this draft was seeded from another Session. It is
     * required semantics: the target daemon resolves the source transcript
     * before creating the child, and the authoring draft/chip survives failure.
     * The UI never retries without it.
     */
    sourceContext?: SessionSpawnSourceContextV1 | null;
    /** Canonical Temporary-computer activation owner. Automation never reaches this callback. */
    temporaryComputerLaunch?: (
        submission: NonNullable<HandleCreateSessionOptions['temporaryComputerSubmission']>,
        settlement: TemporaryComputerCreatorSettlement,
    ) => Promise<void>;
}>): Readonly<{
    handleCreateSession: (opts?: HandleCreateSessionOptions) => void;
    providerLaunchError: ProviderErrorV1 | null;
    retryProviderLaunch: () => void;
    managedMachineCreationProgress: ManagedMachineCreationProgress;
    retryManagedMachineInstallation: () => void;
    retryManagedMachineSetup: () => void;
    continueWithoutManagedMachineSetup: () => void;
    deleteManagedMachineAfterFailedSetup: () => void;
    cancelManagedMachineCreation: () => void;
}> {
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
    const applySettings = useApplySettings();
    const applyAuthoringMemory = useApplyAuthoringMemoryDelta();
    const [providerLaunchFailure, setProviderLaunchFailure] = React.useState<Readonly<{
        error: ProviderErrorV1;
        scopeKey: string;
    }> | null>(null);
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
    const managedAbortRef = React.useRef<AbortController | null>(null);
    const managedAcquisitionRef = React.useRef(params.managedMachineAcquisition ?? null);
    const managedAcquisitionPropRef = React.useRef(params.managedMachineAcquisition);
    if (managedAcquisitionPropRef.current !== params.managedMachineAcquisition) {
        managedAcquisitionPropRef.current = params.managedMachineAcquisition;
        managedAcquisitionRef.current = params.managedMachineAcquisition ?? null;
    }
    const [managedProgress, setManagedProgress] = React.useState<Readonly<{ signature: string; value: ManagedMachineCreationProgress }>>({
        signature: launchIntentSignature, value: { kind: 'idle' },
    });
    const managedOperationId = params.managedMachineAcquisition?.operation?.operationId;
    const managedOperationServerId = params.targetAccountScope?.serverId ?? params.draftScope?.serverId ?? params.targetServerId ?? null;
    const managedOperationAccountId = (params.targetAccountScope ?? params.draftScope)?.accountId;
    const managedOperationControllerId = params.managedMachineSelection?.receipt.controller.machineId;
    const managedAcquisitionMatchesSelection = Boolean(params.managedMachineSelection && params.managedMachineAcquisition
        && sameStrictJsonValue(params.managedMachineSelection.selection, params.managedMachineAcquisition.selection));
    const readManagedOperation = React.useCallback(() => {
        if (!managedOperationId || !managedAcquisitionMatchesSelection) return null;
        const operation = actionOperationSelectors.selectById(actionOperationStore.getSnapshot(), {
            serverId: managedOperationServerId, operationId: managedOperationId,
        });
        return operation?.snapshot.scope.accountId === managedOperationAccountId
            && operation.snapshot.scope.machineId === managedOperationControllerId ? operation : null;
    }, [managedOperationId, managedOperationServerId, managedOperationAccountId, managedOperationControllerId, managedAcquisitionMatchesSelection]);
    const managedOperation = React.useSyncExternalStore(actionOperationStore.subscribe, readManagedOperation, readManagedOperation);
    const onManagedApprovalExecuted = React.useCallback(() => {}, []);
    const managedApproval = useActionApprovalContinuation({
        scopeKey: `new-session-managed:${params.targetAccountScope?.accountId ?? params.draftScope?.accountId ?? ''}:${launchIntentSignature}`,
        serverId: params.targetAccountScope?.serverId ?? params.targetServerId ?? params.draftScope?.serverId ?? '',
        onExecuted: onManagedApprovalExecuted,
    });
    React.useEffect(() => () => { managedAbortRef.current?.abort(); }, [launchIntentSignature]);
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
        let current = latestParamsRef.current;
        let managedCreation: SessionManagedCreationV1 | undefined;
        const submittedSessionName = current.getSessionName?.() ?? current.authoringDraft?.sessionName;
        const submittedInstructionsDraft = current.getInstructionsDraft
            ? current.getInstructionsDraft() : current.authoringDraft?.instructionsDraft;
        let submittedPromptStack = current.getInstructionsPromptStack
            ? current.getInstructionsPromptStack() : current.authoringDraft?.promptStack;
        const submittedDraftScope = current.draftScope;
        const submittedDraftId = current.draftId;
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
                writeNewSessionInstructionsToRepository({ scope: submittedDraftScope, draftId: submittedDraftId,
                    promptStack: submittedPromptStack,
                    instructionsDraft: live?.title === submittedInstructionsDraft.title && live.markdown === submittedInstructionsDraft.markdown
                        ? null : live ?? null });
            }
            const latest = latestParamsRef.current;
            if (!retained || !mountedRef.current || latest.draftId !== submittedDraftId
                || !areServerAccountScopesEqual(latest.draftScope, submittedDraftScope)) {
                throw new Error('instructions_draft_retired');
            }
        };
        if (current.authoringCommitPending === true) {
            reportAfterCreatedSettlement({ status: 'rejected' });
            return;
        }
        try {
            current.requireConnectedAccountDefaultsReady?.();
        } catch {
            Modal.alert(t('common.error'), t('common.unavailable'));
            reportAfterCreatedSettlement({ status: 'rejected' });
            return;
        }
        if (!canCreateSessionWithInitialAccess(current.authoringDraft?.access, collaborationAvailabilityRef.current)) {
            Modal.alert(t('common.error'), t('session.collaboration.accessUnavailableReason'));
            reportAfterCreatedSettlement({ status: 'rejected' });
            return;
        }
        if (current.managedMachineSelection) {
            const submitted = current;
            const managedDraft = current.managedMachineSelection;
            const signature = current.launchIntentSignature;
            const scope = current.targetAccountScope ?? current.draftScope;
            const cancellation = new AbortController();
            managedAbortRef.current?.abort();
            managedAbortRef.current = cancellation;
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
                if (managedAbortRef.current === cancellation) managedAbortRef.current = null;
            };
            cancellation.signal.addEventListener('abort', releaseAccount, { once: true });
            releaseManagedAccountOnRejection = releaseAccount;
            const isCurrent = () => mountedRef.current && !cancellation.signal.aborted
                && latestParamsRef.current.launchIntentSignature === signature
                && sameStrictJsonValue(managedMachineCreationIntent(latestParamsRef.current.managedMachineSelection), managedMachineCreationIntent(managedDraft))
                && areServerAccountScopesEqual(latestParamsRef.current.targetAccountScope ?? latestParamsRef.current.draftScope, scope)
                && (account === null || account.accountLifetime.isCurrent());
            const progress = (value: ManagedMachineCreationProgress) => {
                if (isCurrent()) setManagedProgress({ signature, value });
            };
            if (managedDraft.archiveEffect !== 'keep' && !managedDraft.receipt.retentionCapabilities.supportedIntents.includes(managedDraft.archiveEffect)) {
                progress({ kind: 'failed', code: 'native_intent_unsupported' });
                reportAfterCreatedSettlement({ status: 'rejected' });
                return;
            }
            if (!scope || !current.onManagedMachineAcquisitionChange || !current.onManagedMachineEnrolled) {
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
                if (!acquisition.managedId && !submitted.authoringDraft) {
                    progress({ kind: 'failed', code: 'managed_continuation_unavailable' });
                    reportAfterCreatedSettlement({ status: 'rejected' });
                    return;
                }
                const result = await runManagedMachineCreation({
                    draft: managedDraft, acquisition, scope, signal: cancellation.signal, isCurrent,
                    ...(!acquisition.managedId && submitted.authoringDraft ? {
                        agentStart: buildManagedAcquireAgentStartV1FromAuthoringDraft({
                            draft: { ...submitted.authoringDraft, sessionName: submittedSessionName,
                                promptStack: submittedPromptStack, prompt: opts.inputTextOverride ?? '',
                                displayText: opts.inputTextOverride ?? '' },
                            creationKey: buildManualSessionCreationKey(acquisition.requestId),
                            permissionMode: parsePermissionIntentAlias(submitted.permissionMode) ?? 'default',
                            configurationUpdatedAtMs: submitted.authoringDraft.permissionModeUpdatedAt ?? nowServerMs(),
                            initialMessage: opts.initialMessage === 'skip' ? null : opts.inputTextOverride,
                            initialStructuredInput: opts.initialInputStructuredInput,
                            initialReviewComments: opts.initialInputReviewComments,
                            sourceContext: submitted.sourceContext ?? null,
                        }),
                    } : {}),
                    retryInstallation: opts.managedMachineRetryInstallation,
                    setupRecovery: opts.managedMachineSetupRecovery,
                    reviewDelete: census => Modal.confirm(t('managedMachines.actions.deleteMachine'), [
                        managedDraft.receipt.launch.name, t('managedMachines.dependencies.help'),
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
                    reportAfterCreatedSettlement({ status: 'rejected' });
                    return;
                }
                managedCreation = { homeId: result.machine.homeId, managedId: result.machine.id,
                    controller: result.machine.controller };
                await submitted.onManagedMachineEnrolled(result.machine.enrolledMachineId, cancellation.signal);
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
                let verifiedUploadedAttachments: readonly UploadedAttachment[] | null = null;
                const ensureCreatedSessionCompletion = (sessionId: string) => {
                    if (createdSessionId !== null && createdSessionId !== sessionId) {
                        throw new Error('runner_creator_materialized_session_changed');
                    }
                    if (createdSessionId === null) {
                        createdSessionId = sessionId;
                        launchAttempt = markNewSessionLaunchAttemptCreated(launchAttempt, { createdSessionId: sessionId });
                        publishLaunchAttempt(launchAttempt);
                    }
                    createdSessionCompletion ??= createCreatedNewSessionCompletion({
                        ...(current.zenTaskSource || current.authoringOrigin || opts.afterCreated
                            ? { followUp: async (): Promise<void> => {
                                if (verifiedUploadedAttachments === null) {
                                    throw new Error('runner_creator_attachments_not_verified');
                                }
                                if (current.authoringOrigin) {
                                    await persistCreatedSessionAuthoringOrigin({
                                        sessionId,
                                        serverId: capturedTargetScope.serverId,
                                        origin: current.authoringOrigin,
                                        shouldContinue: () => authoringOriginLifetime?.isCurrent() === true,
                                        updateSessionMetadataWithRetry: sync.patchSessionMetadataWithRetry,
                                    });
                                }
                                if (current.zenTaskSource) {
                                    await linkTaskToSession({
                                        source: current.zenTaskSource,
                                        session: { scope: capturedTargetScope, sessionId },
                                    });
                                }
                                await opts.afterCreated?.({
                                    sessionId,
                                    effectiveSpawnServerId: resolvedTargetServerId,
                                    launchAttempt,
                                    preuploadedAttachments: verifiedUploadedAttachments,
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
                        ...(!opts.deferAcceptedDraftClearToDocument && capturedDraftScope && capturedDraftId
                            ? { clearCapturedDraft: async () => {
                                if (mountedRef.current) current.disableDraftPersistence?.();
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
                publishLaunchAttempt(launchAttempt);
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
                            publishLaunchAttempt(null);
                            reportAfterCreatedSettlement({ status: 'accepted', sessionId });
                        } catch (error) {
                            launchAttempt = markNewSessionLaunchAttemptFailed(launchAttempt, {
                                phase: error instanceof CreatedNewSessionCompletionError && error.stage === 'follow_up'
                                    ? 'uploading_attachments'
                                    : 'created',
                                error,
                                retryable: true,
                            });
                            publishLaunchAttempt(launchAttempt);
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
        setProviderLaunchFailure(null);
        createInFlightRef.current = true;
        current.setIsCreating(true);
        let settlementOwnedByCanonicalOperation = false;
        let disposeOrdinaryDraftLifetime: (() => void) | undefined;
        let capturedOrdinarySourceAccount: LazyActionAccountContext | undefined;
        let capturedOrdinaryTargetAccount: LazyActionAccountContext | undefined;
        const submittedDraftCurrentness = current.draftScope && current.draftId
            ? captureNewSessionDraftWorkflowCurrentness({
                scope: current.draftScope,
                draftId: current.draftId,
            })
            : null;
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
            const resolvedTargetServerId = resolveNewSessionLaunchTargetServerId(current);
            if (!resolvedTargetServerId) {
                Modal.alert(t('common.error'), t('newSession.failedToStart'));
                current.setIsCreating(false);
                return;
            }
            const sourceDraftCancellation = new AbortController();
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
                mountedRef.current && isLaunchScopeStillCurrent()
            );
            const sessionPrompt = opts?.inputTextOverride ?? current.promptStore.getPrompt();
            const shouldSendInitialMessage = (opts?.initialMessage ?? 'send') !== 'skip';
            const shouldPrepareInitialMessage = shouldSendInitialMessage && sessionPrompt.trim();
            const invocationScope = current.draftScope ?? selectActiveServerAccountScopeForServer(getActiveServerAccountScope(), resolvedTargetServerId);
            if (shouldPrepareInitialMessage && invocationScope) await refreshPromptLibraryCatalog(invocationScope);
            if (!isLaunchScopeStillActive() || (invocationScope && !areServerAccountScopesEqual(invocationScope,
                latestParamsRef.current.draftScope ?? selectActiveServerAccountScopeForServer(getActiveServerAccountScope(), resolvedTargetServerId)))) return;
            await prepareSubmittedInstructions();
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
                Modal.alert(t('common.error'), t('newSession.noMachineSelected'));
                reportAfterCreatedSettlement({ status: 'rejected' });
                current.setIsCreating(false);
                return;
            }

            const profilesActive = current.useProfiles;
            const settingsUpdate: MutableSettingsDelta = {};
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
                Object.assign(settingsUpdate, buildLastUsedBackendTargetSettings({
                    backendTarget: current.backendTarget,
                    selectedBuiltInAgentId: staticAgentId,
                }));
            }
            if (Object.keys(settingsUpdate).length > 0) applySettings(settingsUpdate);

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
            if (profilesActive && current.selectedProfileId) {
                const selectedProfile = current.profileMap.get(current.selectedProfileId) || getBuiltInProfile(current.selectedProfileId);
                if (selectedProfile) {
                    if (!isProfileCompatibleWithBackendTarget(selectedProfile, selectedBackendTarget)) {
                        Modal.alert(t('common.error'), t('newSession.aiBackendNotCompatibleWithSelectedProfile'));
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
                            Modal.alert(
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
                        Modal.alert(t('common.error'), t('profiles.requirements.modalBody'));
                        current.setIsCreating(false);
                        return;
                    }
                    secretReferenceOverlay = profileSecretReadiness.secretReferenceOverlay;
                }
            }

            if (spawnBehaviorAgentId) {
                environmentVariables = buildSpawnEnvironmentVariablesFromUiState({
                    agentId: spawnBehaviorAgentId,
                    settings: current.settings,
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
                settings: storage.getState().settings,
                machineId: selectedMachineId,
            });

            const machineCapsSnapshot = getMachineCapabilitiesSnapshot(selectedMachineId, resolvedTargetServerId);
            const machineCapsResults = machineCapsSnapshot?.response.results as any;
            const preflightIssues = spawnBehaviorAgentId
                ? getNewSessionPreflightIssues({
                    agentId: spawnBehaviorAgentId,
                    experiments: getAgentResumeExperimentsFromSettings(spawnBehaviorAgentId, current.settings, selectedMachineId, current.pluginSettings),
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
                    Modal.alert(t(blockingIssue.titleKey), t(blockingIssue.messageKey));
                    current.setIsCreating(false);
                    return;
                }
                const openMachine = await Modal.confirm(
                    t(blockingIssue.titleKey),
                    t(blockingIssue.messageKey),
                    { confirmText: t(blockingIssue.confirmTextKey) }
                );
                if (openMachine && blockingIssue.action === 'openMachine') {
                    current.router.push(`/machine/${selectedMachineId}` as any);
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
                settings: current.settings,
                sessionOverride: current.windowsRemoteSessionLaunchModeOverride ?? undefined,
            }).mode;
            const windowsTerminalWindowName = typeof current.settings.sessionWindowsTerminalWindowName === 'string'
                ? current.settings.sessionWindowsTerminalWindowName.trim()
                : '';
            const normalizedSessionPrompt = sessionPrompt.trim();
            const spawnSessionExtras: ReturnType<typeof buildSpawnSessionExtrasFromUiState> = spawnBehaviorAgentId
                ? buildSpawnSessionExtrasFromUiState({
                    agentId: spawnBehaviorAgentId,
                    settings: current.settings,
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
                ...(submittedPromptStack !== undefined ? { promptStack: submittedPromptStack } : {}),
                executionTarget: selectedMachineId ? {
                    kind: 'machine',
                    target: { serverId: resolvedTargetServerId, machineId: selectedMachineId },
                    ...(retainedSelectionOrigin ? { selectionOrigin: retainedSelectionOrigin } : {}),
                } : null,
                directory: effectiveSelectedPath,
                directoryKind: current.directoryKind,
                checkoutCreationDraft: current.checkoutCreationDraft ?? null,
                organizationPlacement: current.authoringDraft?.organizationPlacement ?? { folderId: null, tagIds: [] },
                access: current.authoringDraft?.access,
                primaryTeamId: current.authoringDraft?.primaryTeamId,
                teamCredentialBindings: current.authoringDraft?.teamCredentialBindings,
                initialTriggers: current.authoringDraft?.initialTriggers,
                prompt: normalizedSessionPrompt,
                displayText: normalizedSessionPrompt,
                agentTarget,
                transcriptStorage: current.transcriptStorage ?? null,
                profileId: profilesActive ? (current.selectedProfileId ?? '') : null,
                environmentVariables: environmentVariables ?? null,
                resumeSessionId: resumeId ?? null,
                permissionMode: spawnPermissionMode,
                permissionModeUpdatedAt: spawnPermissionModeUpdatedAt,
                modelSelection: spawnModelSelection,
                mcpSelection: current.mcpSelection ?? null,
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
                Modal.alert(t('common.error'), t('newSession.failedToStart'));
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
                publishLaunchAttempt(null);
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
                current.onLaunchUserAttemptIdChange?.(null);
            };
            publishLaunchAttempt(launchAttempt);
            let createdSessionId = launchAttempt.createdSessionId;
            let manualActionCustody: ManualSessionSpawnNewActionCustody | null = null;
            let initialInputLocalId: string | null = null;
            let initialMessageText = '';
            let initialInputWasNotAccepted = false;

            const adoptCanonicalActionOperationSettlement = (): boolean => {
                const executionAccountId = executionAccountScope.accountId.trim();
                const canonicalOperation = executionAccountId
                    ? actionOperationSelectors.selectSnapshotByRequestId(
                        actionOperationStore.getSnapshot(),
                        launchAttempt.attemptId,
                        executionAccountScope.serverId,
                        executionAccountId,
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
                launchAttempt = markNewSessionLaunchAttemptSpawning(launchAttempt);
                publishLaunchAttempt(launchAttempt);
                if (!agentTarget) {
                    launchAttempt = markNewSessionLaunchAttemptFailed(launchAttempt, {
                        phase: 'spawning',
                        error: new Error('The selected Agent is unavailable on this machine.'),
                        retryable: false,
                    });
                    endLaunchAttemptWithoutSession();
                    Modal.alert(t('common.error'), t('newSession.failedToStart'));
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
                        sourceContext: current.sourceContext ?? null,
                        secretReferenceOverlay,
                    });
                const spawnInput = { ...authoredSpawnInput, ...(managedCreation ? { managedCreation } : {}) };
                const releaseUserRequestLease = sync.acquireUserRequestLease();
                actionOperationPresentationCoordinator.register({
                    serverId: resolvedTargetServerId,
                    accountId: executionAccountScope.accountId,
                    requestId: launchAttempt.attemptId,
                    onStart: 'current',
                    ...(current.draftScope && current.draftId
                        ? { origin: createNewSessionActionOperationOrigin(current.draftScope, current.draftId) }
                        : {}),
                });
                const actionResult = await (async () => {
                    try {
                        if (!current.draftScope) {
                            throw new Error('Manual Session launch custody requires an active Account scope');
                        }
                        const execution = await executeManualSessionSpawnNewAction(spawnInput, {
                            surface: 'ui',
                            actionRequestId: launchAttempt.attemptId,
                        }, {
                            scope: executionAccountScope,
                            ...(capturedOrdinarySourceAccount ? { sourceAccountLifetime: capturedOrdinarySourceAccount.accountLifetime } : {}),
                            machineHomeDir: typeof current.selectedMachine?.metadata?.homeDir === 'string'
                                ? current.selectedMachine.metadata.homeDir
                                : '',
                            userAttemptId: launchAttempt.attemptId,
                            seedNonce: launchAttempt.spawnNonce,
                            ...(hostSpawnExecutorRef.current ? { executeAction: hostSpawnExecutorRef.current } : {}),
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
                        publishLaunchAttempt(launchAttempt);
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
                if (!actionResult.ok) {
                    if (adoptCanonicalActionOperationSettlement()) {
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
                    // Action failure; ordinary UI creation never falls back.
                    Modal.alert(
                        t('common.error'),
                        resolveSessionSpawnNewActionFailureMessage(actionResult),
                    );
                    current.setIsCreating(false);
                    return;
                }
                if (actionResult.result.type === 'pending') {
                    launchAttempt = markNewSessionLaunchAttemptFailed(launchAttempt, {
                        phase: 'spawning',
                        error: new Error('Session creation is pending.'),
                        retryable: true,
                    });
                    publishLaunchAttempt(launchAttempt);
                    Modal.alert(
                        t('common.error'),
                        resolveSessionSpawnNewResultFailureMessage(actionResult.result),
                    );
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
                        publishLaunchAttempt(launchAttempt);
                    } else {
                        endLaunchAttemptWithoutSession();
                    }
                    if ('terminalHostError' in actionResult.result && actionResult.result.terminalHostError?.kind === 'terminal_host_unavailable') {
                        Modal.alert(
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
                            titleKey: 'newSession.daemonRpcUnavailableTitle',
                            bodyKey: 'newSession.daemonRpcUnavailableBody',
                            machine: current.selectedMachine,
                            onRetry: actionResult.result.retryable ? () => { void handleCreateSession(opts); } : null,
                            shouldContinue: () => (
                                isLaunchScopeStillActive()
                                && latestParamsRef.current.launchIntentSignature === current.launchIntentSignature
                                && areServerAccountScopesEqual(current.draftScope, latestParamsRef.current.draftScope)
                            ),
                        });
                        current.setIsCreating(false);
                        return;
                    }
                    if (actionResult.result.code === 'spawn_failed' && actionResult.result.providerError) {
                        const failureScopeKey = buildProviderLaunchErrorScopeKey(current, resolvedTargetServerId);
                        if (
                            isLaunchScopeStillActive()
                            && failureScopeKey === buildProviderLaunchErrorScopeKey(latestParamsRef.current)
                        ) {
                            setProviderLaunchFailure({
                                error: actionResult.result.providerError,
                                scopeKey: failureScopeKey,
                            });
                        }
                        current.setIsCreating(false);
                        return;
                    }
                    // The agent isn't on the machine or is signed out (typed by the daemon's spawn
                    // precondition): say which, keep the draft, and lead to its setup (lab agent-setup ST).
                    if (
                        (actionResult.result.code === 'agent_cli_missing' || actionResult.result.code === 'agent_signed_out')
                        && actionResult.result.agentId
                        && selectedMachineId
                    ) {
                        const agentTitle = resolveAgentCatalogProjection(actionResult.result.agentId, { enabledAgentIds: [] }).title;
                        const machineName = getMachineDisplayName(current.selectedMachine) ?? selectedMachineId;
                        const setupHref = machineCollectionHref({ machineId: selectedMachineId, serverId: resolvedTargetServerId });
                        Modal.alert(
                            actionResult.result.code === 'agent_cli_missing'
                                ? t('machineAgents.spawnCliMissing', { agent: agentTitle, machine: machineName })
                                : t('machineAgents.spawnSignedOut', { agent: agentTitle, machine: machineName }),
                            t('machineAgents.draftKept'),
                            [
                                { text: t('machineAgents.actionCancel'), style: 'cancel' },
                                ...(!presentsInPlaceRef.current ? [{
                                    text: actionResult.result.code === 'agent_cli_missing' ? t('machineAgents.setUp') : t('machineAgents.actionSignIn'),
                                    onPress: () => current.router.push(setupHref as never),
                                }] : []),
                            ],
                        );
                        current.setIsCreating(false);
                        return;
                    }
                    Modal.alert(
                        t('common.error'),
                        resolveSessionSpawnNewResultFailureMessage(actionResult.result),
                    );
                    current.setIsCreating(false);
                    return;
                }

                createdSessionId = actionResult.result.sessionId;
                initialInputLocalId = (
                    actionResult.result.initialInput.status === 'accepted'
                    || actionResult.result.initialInput.status === 'alreadyAccepted'
                )
                    ? actionResult.result.initialInput.localId
                    : null;
                initialInputWasNotAccepted = Boolean(spawnInput.initialInput) && initialInputLocalId === null;
                if (launchAttempt.createdSessionId !== createdSessionId) {
                    launchAttempt = markNewSessionLaunchAttemptCreated(launchAttempt, { createdSessionId });
                    publishLaunchAttempt(launchAttempt);
                }
            }

            if (createdSessionId) {
                if (!isLaunchScopeStillCurrent()) {
                    publishLaunchAttempt(null);
                    current.setIsCreating(false);
                    return;
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
                let createdSessionRouteOpened = false;

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
                        requestId: launchAttempt.attemptId,
                        router: current.router,
                        href: postSpawnReplacementHref ?? buildCreatedSessionRoute(),
                        isStillActive: isLaunchScopeStillActive,
                        prepareDestination: options?.projectFirstTurn === true || initialInputLocalId !== null
                            ? projectCreatedSessionFirstTurnForRoute
                            : undefined,
                    });
                    createdSessionRouteOpened = presentation === 'opened';
                    return presentation;
                };

                const runAfterCreatedFollowUp = async (): Promise<void> => {
                    try {
                        // This is the incumbent post-create setup checkpoint. A
                        // retained retry must not replay a completed built-in action.
                        postSpawnFailurePhase = 'uploading_attachments';
                        if (current.authoringOrigin) {
                            await persistCreatedSessionAuthoringOrigin({
                                sessionId: createdSessionId,
                                serverId: resolvedTargetServerId,
                                origin: current.authoringOrigin,
                                shouldContinue: () => authoringOriginLifetime?.isCurrent() === true && isLaunchScopeStillActive(),
                                updateSessionMetadataWithRetry: sync.patchSessionMetadataWithRetry,
                            });
                        }
                        if (current.zenTaskSource) {
                            const targetScope = current.targetAccountScope ?? current.draftScope;
                            if (!targetScope || !areServerProfileIdentifiersEquivalent(targetScope.serverId, resolvedTargetServerId)) {
                                throw new TodoSessionLinkError('task_scope_mismatch');
                            }
                            await linkTaskToSession({
                                source: current.zenTaskSource,
                                session: { scope: targetScope, sessionId: createdSessionId },
                            });
                        }
                        await opts?.afterCreated?.({
                            sessionId: createdSessionId,
                            effectiveSpawnServerId: resolvedTargetServerId,
                            launchAttempt,
                        });
                    } catch (error) {
                        postSpawnFollowUpError = error;
                        postSpawnFollowUpRetryRef.current = runAfterCreatedFollowUp;
                        throw error;
                    }
                };
                const createdSessionCompletion = createCreatedNewSessionCompletion({
                    ...(current.zenTaskSource || current.authoringOrigin || opts?.afterCreated ? { followUp: runAfterCreatedFollowUp } : {}),
                    present: () => presentCreatedSessionRoute(),
                    ...(!opts?.deferAcceptedDraftClearToDocument
                        ? { clearCapturedDraft: async () => {
                            if (mountedRef.current) current.disableDraftPersistence?.();
                            await clearCompletedDraft(launchAttempt.attemptId);
                        } }
                        : {}),
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
                        });

                        await executeSessionComposerResolution({
                            resolved: resolvedInitialMessage,
                            sessionId: createdSessionId,
                            accountScope: executionAccountScope,
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
                            navigateToPetSettings: () => {
                                postSpawnReplacementHref = '/settings/pets';
                            },
                            modalAlert: (title, message) => Modal.alert(title, message),
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

                if (!postSpawnFollowUpError && (current.zenTaskSource || current.authoringOrigin || opts?.afterCreated)) {
                    try {
                        await createdSessionCompletion.followUp();
                    } catch (error) {
                        postSpawnFollowUpError = error;
                    }
                }

                const classifyCurrentPostSpawnFailure = (failure: unknown) => failure instanceof TodoSessionLinkError && failure.code === 'task_link_failed'
                    ? {
                        kind: 'retryable' as const,
                        titleKey: 'common.error' as const,
                        bodyKey: 'inbox.actionOperations.followUpNeedsAttention' as const,
                    }
                    : classifyLaunchRetryFailure({
                    phase: postSpawnFailurePhase === 'uploading_attachments' ? 'upload' : 'send',
                    failure,
                });

                while (
                    postSpawnFollowUpError
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

                if (!isLaunchScopeStillCurrent()) {
                    publishLaunchAttempt(null);
                    current.setIsCreating(false);
                    return;
                }

                if (postSpawnFollowUpError) {
                    const draftScope = current.draftScope;
                    if (draftScope) {
                        actionOperationStore.markFollowUpNeedsAttention({
                            serverId: executionAccountScope.serverId,
                            accountId: executionAccountScope.accountId,
                            requestId: launchAttempt.attemptId,
                            message: t('inbox.actionOperations.followUpNeedsAttention'),
                        });
                    }
                    const retryFailureClassification = classifyCurrentPostSpawnFailure(postSpawnFollowUpError);
                    launchAttempt = markNewSessionLaunchAttemptFailed(launchAttempt, {
                        phase: postSpawnFailurePhase,
                        error: postSpawnFollowUpError,
                        retryable: retryFailureClassification.kind === 'retryable',
                    });
                    publishLaunchAttempt(launchAttempt);
                    if (!suppressPostSpawnFollowUpAlert) {
                        Modal.alert(
                            t('common.error'),
                            postSpawnFollowUpError instanceof Error ? postSpawnFollowUpError.message : t('common.error'),
                        );
                    }
                    if (initialInputWasNotAccepted) {
                        preserveCreatedSessionDraftAfterUnacceptedFirstTurn({
                            sessionId: createdSessionId,
                            draftText: initialMessageText || sessionPrompt,
                            scope: executionAccountScope,
                        });
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
                    if (opts?.onAfterCreatedSettled && mountedRef.current && isLaunchScopeStillActive()) {
                        reportAfterCreatedSettlement(initialInputWasNotAccepted
                            ? { status: 'rejected' }
                            : { status: 'accepted', sessionId: createdSessionId });
                    }
                }

                if (initialInputWasNotAccepted) {
                    preserveCreatedSessionDraftAfterUnacceptedFirstTurn({
                        sessionId: createdSessionId,
                        draftText: initialMessageText || sessionPrompt,
                        scope: executionAccountScope,
                    });
                }

                if (!createdSessionRouteOpened && isLaunchScopeStillActive()) {
                    try {
                        await createdSessionCompletion.present();
                    } catch {
                        if (!isLaunchScopeStillActive()) {
                            publishLaunchAttempt(null);
                            current.setIsCreating(false);
                            return;
                        }
                        throw new Error(CREATED_SESSION_NOT_AVAILABLE_LOCALLY_ERROR);
                    }
                }
                if (manualActionCustody) {
                    await completeManualSessionSpawnNewActionCustody(manualActionCustody);
                    manualActionCustody = null;
                }
                publishLaunchAttempt(null);
                await createdSessionCompletion.clearCapturedDraft();
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
            if (!mountedRef.current) return;
            // Instructions that could not be prepared keep the draft and say so (60s2/61s1).
            let errorMessage = error instanceof NewSessionInstructionsPreparationError
                ? t('bots.create.documentFailed')
                : error instanceof Error
                    ? error.message
                    : t('newSession.failedToStart');
            if (error instanceof Error) {
                if (error.message.includes('timeout')) {
                    errorMessage = 'Session startup timed out. The machine may be slow or the daemon may not be responding.';
                } else if (error.message.includes('Socket not connected')) {
                    errorMessage = 'Not connected to server. Check your internet connection.';
                }
            }
            Modal.alert(t('common.error'), errorMessage);
            latestParamsRef.current.setIsCreating(false);
        } finally {
            disposeOrdinaryDraftLifetime?.();
            capturedOrdinarySourceAccount?.dispose();
            capturedOrdinaryTargetAccount?.dispose();
            if (!settlementOwnedByCanonicalOperation) {
                reportAfterCreatedSettlement({ status: 'rejected' });
            }
            createInFlightRef.current = false;
        }
    }, [applyAuthoringMemory, applySettings, mountedRef, publishLaunchAttempt, managedApproval.requestApproval]);

    const currentProviderLaunchErrorScopeKey = buildProviderLaunchErrorScopeKey(params);
    React.useEffect(() => {
        setProviderLaunchFailure((currentFailure) => (
            currentFailure && currentFailure.scopeKey !== currentProviderLaunchErrorScopeKey
                ? null
                : currentFailure
        ));
    }, [currentProviderLaunchErrorScopeKey]);
    const providerLaunchError = providerLaunchFailure?.scopeKey === currentProviderLaunchErrorScopeKey
        ? providerLaunchFailure.error
        : null;
    const retryProviderLaunch = React.useCallback(() => {
        if (providerLaunchFailure?.scopeKey !== buildProviderLaunchErrorScopeKey(latestParamsRef.current)) {
            return;
        }
        void handleCreateSession(lastCreateOptionsRef.current);
    }, [handleCreateSession, providerLaunchFailure]);

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
        managedAbortRef.current?.abort();
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
    const managedMachineCreationProgress: ManagedMachineCreationProgress = recoveredManagedProgress.kind === 'acquiring' && managedOperation
        ? { ...recoveredManagedProgress, operation: managedOperation.snapshot, operationObservation: managedOperation.observation } : recoveredManagedProgress;
    return { handleCreateSession, providerLaunchError, retryProviderLaunch, managedMachineCreationProgress,
        retryManagedMachineInstallation, retryManagedMachineSetup, continueWithoutManagedMachineSetup,
        deleteManagedMachineAfterFailedSetup, cancelManagedMachineCreation };
}
