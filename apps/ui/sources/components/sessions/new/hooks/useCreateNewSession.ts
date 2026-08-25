import * as React from 'react';

import { t } from '@/text';
import { Modal } from '@/modal';
import { sync } from '@/sync/sync';
import { actionOperationPresentationCoordinator } from '@/components/inbox/actionOperations/actionOperationPresentationRuntime';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { readLegacyScheduleAutomationDefinition } from '@/sync/domains/automations/automationLegacyScheduleDefinition';
import {
    isAutomationTemplateEncryptionMaterialUnavailableError,
} from '@/sync/domains/automations/automationTemplateAvailability';
import { useApplySettings } from '@/sync/store/settingsWriters';
import { storage } from '@/sync/domains/state/storage';
import { resolveTerminalSpawnOptions } from '@/sync/domains/settings/terminalSettings';
import { CREATED_SESSION_NOT_AVAILABLE_LOCALLY_ERROR } from '@/sync/runtime/sessionMessageDeliveryErrors';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveNewSessionServerTarget } from '@/sync/domains/server/selection/serverSelectionResolver';
import { getMissingRequiredConfigEnvVarNames } from '@/utils/profiles/profileConfigRequirements';
import { getSecretSatisfaction } from '@/utils/secrets/secretSatisfaction';
import type { SecretChoiceByProfileIdByEnvVarName } from '@/utils/secrets/secretRequirementApply';
import { writeExistingSessionDraft } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { getBuiltInProfile } from '@/sync/domains/profiles/profileUtils';
import { isProfileCompatibleWithBackendTarget, type AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import type { Settings } from '@/sync/domains/settings/settings';
import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { resolveEffectiveWindowsRemoteSessionLaunchMode } from '@/sync/domains/session/spawn/windowsRemoteSessionLaunchMode';
import { getAgentCore, isBundledAgentId, type AgentId } from '@/agents/catalog/catalog';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { buildLastUsedBackendTargetSettings } from '@/agents/backendCatalog/buildLastUsedBackendTargetSettings';
import { buildSpawnEnvironmentVariablesFromUiState, buildSpawnSessionExtrasFromUiState, getAgentResumeExperimentsFromSettings, getNewSessionPreflightIssues } from '@/agents/catalog/catalog';
import { resolveNewSessionBehaviorAgentId } from '@/components/sessions/new/modules/newSessionBehaviorAgent';
import { transformProfileToEnvironmentVars } from '@/components/sessions/new/modules/profileHelpers';
import type { UseMachineEnvPresenceResult } from '@/hooks/machine/useMachineEnvPresence';
import { getMachineCapabilitiesSnapshot } from '@/hooks/server/useMachineCapabilitiesCache';
import type { PermissionMode, ModelMode } from '@/sync/domains/permissions/permissionTypes';
import { getModelOptionsForAgentType, type PreflightModelList } from '@/sync/domains/models/modelOptions';
import {
    ConnectedServiceBindingsV1Schema,
    automationRunExecutionTargetDeliversComposerReferencesV1,
    mentionRefV1SurvivesRenderedTokenAlone,
    type BackendTargetRefV2,
    type BackendTargetRefV2Input,
    type ExecutionRunDetachedStartRequestV1,
    type ProviderErrorV1,
    type SessionServerStartSpawnDraftV1,
    type WindowsRemoteSessionLaunchMode,
} from '@happier-dev/protocol';
import type { AcpConfigOptionOverridesV1, MentionRefV1 } from '@happier-dev/protocol';
import type { CodexBackendMode } from '@happier-dev/protocol';
import { parsePermissionIntentAlias } from '@happier-dev/agents';
import { nowServerMs } from '@/sync/runtime/time';
import { encodeAutomationTemplateCiphertextForAccount } from '@/sync/domains/automations/encodeAutomationTemplateCiphertextForAccount';
import { resolveSessionComposerSend } from '@/sync/domains/input/slashCommands/resolveSessionComposerSend';
import { executeSessionComposerResolution } from '@/sync/domains/input/slashCommands/executeSessionComposerResolution';
import { expandPromptTemplateInvocation } from '@/sync/domains/input/slashCommands/expandPromptTemplateInvocation';
import { resolvePromptInvocationComposerSendAction } from '@/sync/domains/input/slashCommands/promptInvocationBehavior';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import {
    buildAutomationScheduleFromDraft,
    normalizeAutomationDescription,
    normalizeAutomationName,
    validateAutomationTemplateTarget,
} from '@/sync/domains/automations/automationValidation';
import {
    classifyLaunchRetryFailure,
    promptDaemonUnavailableRetry,
} from '@/utils/errors/daemonUnavailableAlert';
import { captureExceptionIfEnabled } from '@/utils/system/sentry';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useMountedRef } from '@/hooks/ui/useMountedRef';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { createNewSessionActionOperationOrigin } from '@/components/sessions/new/navigation/newSessionActionOperationOrigin';
import type { SessionMcpSelectionV1 } from '@happier-dev/protocol';
import type { SessionSpawnSourceContextV1 } from '@happier-dev/protocol';
import type { NewSessionCheckoutCreationDraft } from '@/sync/domains/state/newSessionCheckoutDraft';
import { resolveNewSessionCompatAgentType } from '@/components/sessions/new/modules/resolveNewSessionCompatAgentType';
import {
    buildNewSessionLaunchScopeKey,
    normalizeLaunchScopePart,
} from '@/components/sessions/new/modules/newSessionLaunchScope';
import {
    isCreatedSessionUnavailableLocally,
    requireLocalSessionVisibleForRoute,
} from '@/sync/runtime/orchestration/serverScopedRpc/localSessionRouteReadiness';
import {
    buildOutgoingUserTextRecord,
    projectLocalOutboundUserMessage,
} from '@/sync/domains/messages/outgoingUserMessage';
import { resolveServerIdForSessionIdFromLocalCache } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';
import {
    buildAutomationTemplateFromSessionAuthoringDraft,
    buildNewSessionAuthoringDraftFromResolvedInputs,
    buildSessionServerStartSpawnDraftV1FromAuthoringDraft,
    buildSessionSpawnNewInputV2FromAuthoringDraft,
} from '@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters';
import type { SessionAuthoringDraft } from '@/components/sessions/authoring/draft/sessionAuthoringDraft';
import {
    buildPluginEventAutomationDetachedExecutionRunRequest,
    type PluginEventAutomationCreateDraft,
    type PluginEventAutomationEditTarget,
} from '@/components/automations/editor/pluginEventAutomationDraft';
import {
    submitPluginEventAutomation,
} from '@/components/automations/editor/pluginEventAutomationSubmit';
import { confirmPluginEventAutomationSubmission } from '@/components/automations/editor/pluginEventAutomationSubmissionConfirmation';
import type {
    PluginEventAutomationResolvedTarget,
    PluginEventAutomationTargetKind,
} from '@/components/automations/editor/pluginEventAutomationTarget';
import { isAutomationApiErrorCode } from '@/sync/api/automations/apiAutomations';
import {
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
    executeSessionSpawnNewAction,
    resolveSessionSpawnNewActionFailureMessageKey,
    resolveSessionSpawnNewResultFailureMessageKey,
} from '@/sync/ops/actions/sessionSpawnNewAction';
import {
    captureNewSessionDraftLaunchCurrentness,
    captureNewSessionDraftWorkflowCurrentness,
    clearCapturedNewSessionDraftAfterLaunch,
} from '@/components/sessions/new/modules/newSessionDraftLifecycle';
import { actionOperationSelectors } from '@/sync/domains/actionOperations/actionOperationSelectors';

function preserveCreatedSessionDraft(params: Readonly<{
    sessionId: string;
    draftText: string;
    scope: ServerAccountScope | null | undefined;
}>): void {
    const draftText = params.draftText.trim();
    if (!draftText || !params.scope) return;
    writeExistingSessionDraft({
        scope: params.scope,
        sessionId: params.sessionId,
        patch: { text: draftText },
        materializationIntent: 'seeded',
    });
}

type MutableSettingsDelta = {
    -readonly [TKey in keyof Settings]?: Settings[TKey];
};

export type CreatedSessionFollowUpContext = Readonly<{
    sessionId: string;
    effectiveSpawnServerId: string | null;
    launchAttempt: NewSessionLaunchAttempt;
}>;

export type NewSessionAfterCreatedSettlement =
    /**
     * `sessionId` is null exactly when the accepted writer created no Session:
     * every Automation arm persists a definition and navigates to it. Reporting
     * a fabricated id, or reporting `rejected` for a save that succeeded, would
     * tell the Composer document owner its submitted snapshot never landed.
     */
    | Readonly<{ status: 'accepted'; sessionId: string | null }>
    | Readonly<{ status: 'rejected' }>;

export type HandleCreateSessionOptions = Readonly<{
    initialMessage?: 'send' | 'skip';
    inputTextOverride?: string;
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
     * This detached semantic submission includes generic Composer attachments.
     * Automation authoring has no attachment owner, so its writer branches
     * reject this attempt before they can clear the New Session document.
     */
    hasComposerAttachments?: boolean;
    /**
     * The structured Composer references this detached semantic submission
     * carries, already reduced to the canonical positionless identity shape by
     * the one structured-input envelope builder. The strict V3 execution recipe
     * persists them verbatim, so an Event Automation keeps what the user
     * picked. The legacy V2 template stores the rendered prompt program alone
     * and therefore refuses exactly the references that program cannot express;
     * a reference the token DOES carry — a `@docs/README.md` file mention — is
     * passed through everywhere, because refusing it would remove a flow that
     * works today. `mentionRefV1SurvivesRenderedTokenAlone` owns the per-kind
     * split next to the kinds themselves.
     */
    composerReferences?: readonly MentionRefV1[];
    /**
     * D2: relaunch under the newly-selected connected-service account WITHOUT resume continuity, after
     * the "switch unavailable" dialog offered "start fresh". Drops the vendor resume reference so the
     * new account begins a clean conversation instead of fail-closing again on an unreachable resume.
     */
    startFreshUnderNewAccount?: boolean;
}>;

type ProviderLaunchErrorScopeParams = Readonly<{
    selectedMachineId: string | null;
    targetServerId?: string | null;
    allowedTargetServerIds?: ReadonlyArray<string>;
    agentType: string;
    backendTarget?: BackendTargetRefV2;
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
}>): string {
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
    return typeof targetResolution.targetServerId === 'string'
        && targetResolution.targetServerId.trim().length > 0
        ? targetResolution.targetServerId
        : snapshot.serverId;
}

function buildProviderLaunchErrorScopeKey(
    params: ProviderLaunchErrorScopeParams,
    resolvedTargetServerId?: string,
): string {
    const modelRef = params.authoringDraft?.modelSelection?.ref ?? null;
    const backendTarget = params.spawnBackendTarget
        ?? params.backendTarget
        ?? { kind: 'backend' as const, backendId: params.agentType };
    return JSON.stringify([
        normalizeLaunchScopePart(params.selectedMachineId),
        resolvedTargetServerId ?? resolveNewSessionLaunchTargetServerId(params),
        params.agentType,
        resolveBackendTargetKeyV2(backendTarget),
        params.useProfiles,
        normalizeLaunchScopePart(params.selectedProfileId),
        modelRef?.agentTargetKey ?? null,
        modelRef?.providerConnectionId ?? null,
        modelRef?.modelId ?? params.modelMode,
    ]);
}

const CREATED_SESSION_ROUTE_RECOVERY_ATTEMPTS = 6;
const CREATED_SESSION_ROUTE_RECOVERY_DELAY_MS = 500;

function waitForCreatedSessionRouteRecoveryDelay(): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, CREATED_SESSION_ROUTE_RECOVERY_DELAY_MS);
    });
}

export function useCreateNewSession(params: Readonly<{
    router: { push: (options: any) => void; replace: (path: any, options?: any) => void };

    selectedMachineId: string | null;
    selectedPath: string;
    getRequestedPath?: () => string;
    selectedMachine: any;

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
    runtimeCarrierAgentId?: AgentId | null;
    backendTarget?: BackendTargetRefV2;
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
    setSessionPrompt?: (prompt: string) => void;
    resumeSessionId: string;
    agentNewSessionOptions?: Record<string, unknown> | null;
    authoringDraft?: SessionAuthoringDraft | null;
    authoringCommitPending?: boolean;
    automationEditId?: string | null;
    eventAutomationDraft?: PluginEventAutomationCreateDraft | null;
    eventAutomationEdit?: PluginEventAutomationEditTarget | null;
    eventAutomationTargetKind?: PluginEventAutomationTargetKind | null;
    resolveEventAutomationTarget?: (input: Readonly<{
        newSessionSpawn?: SessionServerStartSpawnDraftV1 | null;
        executionRun?: Readonly<{
            machineId: string | null;
            request: ExecutionRunDetachedStartRequestV1 | null;
        }> | null;
    }>) => PluginEventAutomationResolvedTarget | null;
    eventAutomationExecutionPermissionMode?: 'no_tools' | 'read_only';
    mcpSelection?: SessionMcpSelectionV1 | null;
    windowsRemoteSessionLaunchModeOverride?: WindowsRemoteSessionLaunchMode | null;

    machineEnvPresence: UseMachineEnvPresenceResult;
    secrets: SavedSecret[];
    secretBindingsByProfileId: Record<string, Record<string, string>>;
    selectedSecretIdByProfileIdByEnvVarName: SecretChoiceByProfileIdByEnvVarName;
    sessionOnlySecretValueByProfileIdByEnvVarName: SecretChoiceByProfileIdByEnvVarName;

    selectedMachineCapabilities: any;
    targetServerId?: string | null;
    allowedTargetServerIds?: ReadonlyArray<string>;
    daemonMergedProjectionInputs?: Pick<
        DaemonMergedProjectionInputs,
        'mergedBackendProjectionById' | 'mergedProviderProjectionById'
    > | null;
    draftScope?: ServerAccountScope | null;
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
}>): Readonly<{
    handleCreateSession: (opts?: HandleCreateSessionOptions) => void;
    providerLaunchError: ProviderErrorV1 | null;
    retryProviderLaunch: () => void;
}> {
    const mountedRef = useMountedRef();
    const applySettings = useApplySettings();
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
    // Keep the latest params available synchronously so event handlers can't observe
    // a stale snapshot in the window between rerender and effect flush.
    latestParamsRef.current = params;

    const publishLaunchAttempt = React.useCallback((attempt: NewSessionLaunchAttempt | null) => {
        launchAttemptRef.current = attempt;
        if (mountedRef.current) {
            latestParamsRef.current.onLaunchAttemptChange?.(attempt);
        }
    }, [mountedRef]);

    const handleCreateSession = React.useCallback(async (opts?: HandleCreateSessionOptions) => {
        let afterCreatedSettlementReported = false;
        const reportAfterCreatedSettlement = (settlement: NewSessionAfterCreatedSettlement): void => {
            if (afterCreatedSettlementReported) {
                return;
            }
            afterCreatedSettlementReported = true;
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
        const current = latestParamsRef.current;
        const staticAgentId = resolveStaticAgentId(current);
        const spawnBehaviorAgentId = resolveNewSessionBehaviorAgentId(current);
        const selectedMachineId = current.selectedMachineId;
        if (current.authoringCommitPending === true) {
            reportAfterCreatedSettlement({ status: 'rejected' });
            return;
        }
        const requestedPath = typeof current.getRequestedPath === 'function'
            ? current.getRequestedPath()
            : current.selectedPath;
        const effectiveSelectedPath = (typeof requestedPath === 'string'
            ? requestedPath
            : current.selectedPath).trim();
        const eventAutomationDraft = current.eventAutomationDraft ?? null;
        const eventAutomationEdit = current.eventAutomationEdit ?? null;
        const eventTargetKind = current.eventAutomationTargetKind ?? 'newSession';
        const hasEventAutomationSubmission = eventAutomationDraft !== null || eventAutomationEdit !== null;
        const eventTargetDoesNotRequireNewSessionInputs = hasEventAutomationSubmission
            && eventTargetKind !== 'newSession';
        if (!eventTargetDoesNotRequireNewSessionInputs && !selectedMachineId) {
            Modal.alert(t('common.error'), t('newSession.noMachineSelected'));
            reportAfterCreatedSettlement({ status: 'rejected' });
            return;
        }
        if (!eventTargetDoesNotRequireNewSessionInputs && effectiveSelectedPath.length === 0) {
            Modal.alert(t('common.error'), t('newSession.noPathSelected'));
            reportAfterCreatedSettlement({ status: 'rejected' });
            return;
        }

        lastCreateOptionsRef.current = opts;
        setProviderLaunchFailure(null);
        createInFlightRef.current = true;
        current.setIsCreating(true);
        let settlementOwnedByCanonicalOperation = false;
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
            const launchScopeKey = buildNewSessionLaunchScopeKey({
                machineId: selectedMachineId,
                serverId: resolvedTargetServerId,
                selectedPath: effectiveSelectedPath,
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
                return buildNewSessionLaunchScopeKey({
                    machineId: latest.selectedMachineId,
                    serverId: latestResolvedTargetServerId,
                    selectedPath: latestEffectiveSelectedPath,
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
            const resolvedInitialMessage = shouldPrepareInitialMessage
                ? resolveSessionComposerSend({
                    input: sessionPrompt,
                    executionRunsEnabled: current.executionRunsEnabled === true,
                    // A new session has no live runtime registry yet. Preserve the user's text and
                    // let the Agent handle `/goal` until the attached runner can advertise the
                    // callable controls used by the local goal UI.
                    goalControlsAvailable: false,
                    promptInvocationsV1: storage.getState().settings.promptInvocationsV1,
                })
                : null;
            if (
                resolvedInitialMessage?.kind === 'template' &&
                resolvePromptInvocationComposerSendAction(resolvedInitialMessage.behavior) === 'insert'
            ) {
                const expanded = await expandPromptTemplateInvocation({
                    targetArtifactId: resolvedInitialMessage.targetArtifactId,
                    argsText: resolvedInitialMessage.rest,
                });
                current.setSessionPrompt?.(expanded);
                current.setIsCreating(false);
                return;
            }

            /**
             * The one place an Automation writer refuses a Composer submission
             * whose semantics it cannot persist. Attachments have no Automation
             * owner at all.
             *
             * References are different per writer, and the difference is a real
             * delivery fact rather than a policy choice. The strict V3 execution
             * recipe stores `AutomationRunTemplateV1.mentions` — the same
             * identity-only `MentionRefV1` list an interactive send persists —
             * and its existing-Session dispatch hands them to the canonical
             * Session sender, so that writer keeps every reference the user
             * picked. The new-Session and execution-Run dispatches take a bare
             * instruction string, and the legacy V2 template envelope stores the
             * rendered prompt program alone; there a reference whose identity
             * that program cannot express would become a look-alike token, so
             * those, and only those, are refused. A `@docs/README.md` file
             * mention IS such text and stays allowed on every route.
             *
             * `automationRunExecutionTargetDeliversComposerReferencesV1` is the
             * Protocol materializer's own answer, so this refusal cannot drift
             * from what dispatch actually delivers, and every branch still fails
             * closed through this one function.
             */
            const unpersistableComposerReferenceForRenderedPromptOnly = opts?.composerReferences
                ?.find((reference) => !mentionRefV1SurvivesRenderedTokenAlone(reference))
                ?? null;
            const eventTargetDeliversComposerReferences =
                automationRunExecutionTargetDeliversComposerReferencesV1(eventTargetKind);
            const eventTargetComposerReferences = eventTargetDeliversComposerReferences
                ? opts?.composerReferences ?? []
                : [];
            const rejectUnsupportedComposerSemanticsForAutomation = (writer: Readonly<{
                persistsComposerReferences: boolean;
            }>): boolean => {
                const unpersistableComposerReference = writer.persistsComposerReferences
                    ? null
                    : unpersistableComposerReferenceForRenderedPromptOnly;
                if (opts?.hasComposerAttachments !== true && !unpersistableComposerReference) {
                    return false;
                }
                Modal.alert(t('common.error'), unpersistableComposerReference
                    ? t('automations.unsupportedReference', {
                        reference: unpersistableComposerReference.token,
                    })
                    : t('newSession.failedToStart'));
                reportAfterCreatedSettlement({ status: 'rejected' });
                current.setIsCreating(false);
                return true;
            };

            if (hasEventAutomationSubmission && eventTargetKind !== 'newSession') {
                if (rejectUnsupportedComposerSemanticsForAutomation({
                    persistsComposerReferences: eventTargetDeliversComposerReferences,
                })) {
                    return;
                }
                if (!eventAutomationDraft || !current.resolveEventAutomationTarget) {
                    Modal.alert(t('common.error'), eventAutomationEdit
                        ? t('automations.edit.updateFailed')
                        : t('newSession.failedToStart'));
                    current.setIsCreating(false);
                    return;
                }
                if (eventTargetKind === 'executionRun' && !selectedMachineId) {
                    Modal.alert(t('common.error'), t('newSession.noMachineSelected'));
                    current.setIsCreating(false);
                    return;
                }
                const eventAuthoringDraft = current.authoringDraft ?? null;
                // Detached Event execution is not a session launcher. It can
                // consume only the strict backend and service selections the
                // authoring draft already owns; legacy launcher inputs would
                // make a second target-normalization path.
                const eventBackendTarget = eventAuthoringDraft?.backendTarget
                    ?? current.backendTarget
                    ?? null;
                const eventConnectedServicesResult = eventAuthoringDraft?.connectedServices == null
                    ? null
                    : ConnectedServiceBindingsV1Schema.safeParse(eventAuthoringDraft.connectedServices);
                if (eventConnectedServicesResult && !eventConnectedServicesResult.success) {
                    Modal.alert(t('common.error'), t('newSession.failedToStart'));
                    current.setIsCreating(false);
                    return;
                }
                const eventConnectedServices = eventConnectedServicesResult?.success
                    ? eventConnectedServicesResult.data
                    : null;
                const eventSubmission = await submitPluginEventAutomation({
                    draft: eventAutomationDraft,
                    editTarget: eventAutomationEdit,
                    automationEditId: current.automationEditId,
                    metadata: eventAuthoringDraft?.automation
                        ? {
                            name: eventAuthoringDraft.automation.name,
                            description: eventAuthoringDraft.automation.description,
                            enabled: eventAuthoringDraft.automation.enabled,
                        }
                        : null,
                    prompt: sessionPrompt.trim(),
                    // The strict recipe writer persists reference identity
                    // beside the rendered program, so the picked references
                    // travel with the Automation instead of surviving only
                    // as look-alike prompt text. Only a target whose dispatch
                    // delivers them is given them: storing a reference the
                    // materializer drops would be persisted dead state.
                    ...(eventTargetComposerReferences.length > 0
                        ? { mentions: eventTargetComposerReferences }
                        : {}),
                    targetKind: eventTargetKind,
                    executionTargetServerId: resolvedTargetServerId,
                    buildNewSessionSpawn: () => null,
                    buildExecutionRun: () => {
                        if (eventTargetKind !== 'executionRun' || !selectedMachineId) return null;
                        return {
                            machineId: selectedMachineId,
                            request: buildPluginEventAutomationDetachedExecutionRunRequest({
                                backendTarget: eventBackendTarget,
                                permissionMode: current.eventAutomationExecutionPermissionMode ?? 'read_only',
                                modelSelection: eventAuthoringDraft?.modelSelection ?? null,
                                sessionConfigOptionOverrides: eventAuthoringDraft?.sessionConfigOptionOverrides ?? null,
                                connectedServices: eventConnectedServices,
                                profileId: eventAuthoringDraft?.profileId ?? null,
                            }),
                        };
                    },
                    resolveTarget: current.resolveEventAutomationTarget,
                    confirmSubmission: confirmPluginEventAutomationSubmission,
                    isCurrent: isLaunchScopeStillActive,
                });
                if (eventSubmission.kind === 'cancelled') {
                    current.setIsCreating(false);
                    return;
                }
                if (eventSubmission.kind === 'unavailable') {
                    if (eventSubmission.reason === 'account') {
                        Modal.alert(
                            t('settingsPlugins.eventAutomationComposer.storedContentUnavailableTitle'),
                            t('settingsPlugins.eventAutomationComposer.storedContentUnavailableBody'),
                        );
                    } else {
                        Modal.alert(t('common.error'), eventAutomationEdit
                            ? t('automations.edit.updateFailed')
                            : t('newSession.failedToStart'));
                    }
                    current.setIsCreating(false);
                    return;
                }
                current.disableDraftPersistence?.();
                await clearCompletedDraft();
                reportAfterCreatedSettlement({ status: 'accepted', sessionId: null });
                current.router.replace((eventSubmission.kind === 'updated'
                    ? `/automations/${eventSubmission.automationId}`
                    : '/automations') as any);
                return;
            }

            // Non-session Event arms return above. Every remaining legacy
            // schedule or session-start path still has one exact machine.
            if (!selectedMachineId) {
                Modal.alert(t('common.error'), t('newSession.noMachineSelected'));
                reportAfterCreatedSettlement({ status: 'rejected' });
                current.setIsCreating(false);
                return;
            }

            const updatedPaths = [
                { machineId: selectedMachineId, path: effectiveSelectedPath },
                ...current.recentMachinePaths.filter((rp) => (
                    rp.machineId !== selectedMachineId || rp.path !== effectiveSelectedPath
                )),
            ].slice(0, 10);
            const profilesActive = current.useProfiles;
            const compatibilityAgentId = resolveNewSessionCompatAgentType({
                backendTarget: current.backendTarget ?? null,
                persistedAgentId: current.settings.lastUsedAgent,
                selectedBuiltInAgentId: staticAgentId,
            });
            const settingsUpdate: MutableSettingsDelta = {
                recentMachinePaths: updatedPaths,
            };
            if (current.backendTarget) {
                Object.assign(settingsUpdate, buildLastUsedBackendTargetSettings({
                    backendTarget: current.backendTarget,
                    selectedBuiltInAgentId: staticAgentId,
                }));
            }
            if (profilesActive) {
                settingsUpdate.lastUsedProfile = current.selectedProfileId;
            }
            applySettings(settingsUpdate);

            const backendTarget: BackendTargetRefV2 = current.backendTarget ?? {
                kind: 'backend',
                backendId: staticAgentId ?? current.agentType,
            };
            let environmentVariables = undefined;
            if (profilesActive && current.selectedProfileId) {
                const selectedProfile = current.profileMap.get(current.selectedProfileId) || getBuiltInProfile(current.selectedProfileId);
                if (selectedProfile) {
                    if (!isProfileCompatibleWithBackendTarget(selectedProfile, backendTarget)) {
                        Modal.alert(t('common.error'), t('newSession.aiBackendNotCompatibleWithSelectedProfile'));
                        current.setIsCreating(false);
                        return;
                    }

                    environmentVariables = transformProfileToEnvironmentVars(selectedProfile);

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

                    const satisfaction = getSecretSatisfaction({
                        profile: selectedProfile,
                        secrets: current.secrets,
                        defaultBindings: current.secretBindingsByProfileId[current.selectedProfileId] ?? null,
                        selectedSecretIds: selectedSecretIdByEnvVarName,
                        sessionOnlyValues: sessionOnlySecretValueByEnvVarName,
                        machineEnvReadyByName,
                    });

                    if (!satisfaction.isSatisfied) {
                        Modal.alert(t('common.error'), t('profiles.requirements.modalBody'));
                        current.setIsCreating(false);
                        return;
                    }

                    for (const item of satisfaction.items) {
                        if (!item.isSatisfied) continue;
                        let injected: string | null = null;

                        if (item.satisfiedBy === 'sessionOnly') {
                            injected = sessionOnlySecretValueByEnvVarName[item.envVarName] ?? null;
                        } else if (
                            item.satisfiedBy === 'selectedSaved' ||
                            item.satisfiedBy === 'rememberedSaved' ||
                            item.satisfiedBy === 'defaultSaved'
                        ) {
                            const id = item.savedSecretId;
                            const secret = id ? (current.secrets.find((key) => key.id === id) ?? null) : null;
                            injected = sync.decryptSecretValue(secret?.encryptedValue ?? null);
                        }

                        if (typeof injected === 'string' && injected.length > 0) {
                            environmentVariables = {
                                ...environmentVariables,
                                [item.envVarName]: injected,
                            };
                        }
                    }
                }
            }

            if (spawnBehaviorAgentId) {
                environmentVariables = buildSpawnEnvironmentVariablesFromUiState({
                    agentId: spawnBehaviorAgentId,
                    settings: current.settings,
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
            const preflightIssues = staticAgentId
                ? getNewSessionPreflightIssues({
                    agentId: staticAgentId,
                    experiments: getAgentResumeExperimentsFromSettings(staticAgentId, current.settings),
                    resumeSessionId: current.resumeSessionId,
                    results: machineCapsResults,
                })
                : [];
            const blockingIssue = preflightIssues[0] ?? null;
            if (blockingIssue) {
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
            const resumeId = !startFreshUnderNewAccount && current.resumeSessionId.trim().length > 0
                ? current.resumeSessionId.trim()
                : undefined;
            const spawnPermissionMode = parsePermissionIntentAlias(current.permissionMode) ?? 'default';
            const spawnPermissionModeUpdatedAt = nowServerMs();
            const normalizedAcpModeId = typeof current.acpSessionModeId === 'string' ? current.acpSessionModeId.trim() : '';
            const spawnModelId =
                staticAgentId !== null &&
                getAgentCore(staticAgentId)?.model.supportsSelection === true &&
                typeof current.modelMode === 'string' &&
                current.modelMode.trim().length > 0 &&
                current.modelMode !== 'default'
                    ? current.modelMode
                    : undefined;
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
                            agentTargetKey: resolveBackendTargetKeyV2(backendTarget),
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
                    machineId: selectedMachineId,
                    resumeSessionId: current.resumeSessionId,
                    newSessionOptions: current.agentNewSessionOptions,
                    sessionConfigOptionOverrides: current.sessionConfigOptionOverrides,
                    updatedAt: spawnPermissionModeUpdatedAt,
                })
                : {};
            const authoringDraft = buildNewSessionAuthoringDraftFromResolvedInputs({
                directory: effectiveSelectedPath,
                checkoutCreationDraft: current.checkoutCreationDraft ?? null,
                prompt: normalizedSessionPrompt,
                displayText: normalizedSessionPrompt,
                agentId: compatibilityAgentId,
                backendTarget,
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
                codexBackendMode: typeof spawnSessionExtras.codexBackendMode === 'string'
                    ? spawnSessionExtras.codexBackendMode as CodexBackendMode
                    : null,
                acpSessionModeId: normalizedAcpModeId || null,
                sessionConfigOptionOverrides:
                    spawnSessionExtras.sessionConfigOptionOverrides
                    ?? current.sessionConfigOptionOverrides
                    ?? null,
                automation: current.authoringDraft?.automation ?? null,
            });
            const activeAutomationDraft = authoringDraft.automation ?? null;
            if (eventAutomationDraft || eventAutomationEdit) {
                if (rejectUnsupportedComposerSemanticsForAutomation({
                    persistsComposerReferences: eventTargetDeliversComposerReferences,
                })) {
                    return;
                }
                if (!eventAutomationDraft || !current.resolveEventAutomationTarget || eventTargetKind !== 'newSession') {
                    Modal.alert(t('common.error'), eventAutomationEdit
                        ? t('automations.edit.updateFailed')
                        : t('newSession.failedToStart'));
                    current.setIsCreating(false);
                    return;
                }
                const eventAuthoringDraft = eventAutomationEdit
                    ? current.authoringDraft ?? null
                    : authoringDraft;
                if (!eventAuthoringDraft) {
                    Modal.alert(t('common.error'), t('automations.edit.updateFailed'));
                    current.setIsCreating(false);
                    return;
                }
                const eventBackendTarget = eventAutomationEdit
                    ? eventAuthoringDraft.backendTarget
                    : current.spawnBackendTarget ?? backendTarget;
                const eventPermissionMode = eventAutomationEdit
                    ? parsePermissionIntentAlias(eventAuthoringDraft.permissionMode ?? '')
                    : spawnPermissionMode;
                const eventPermissionModeUpdatedAt = eventAutomationEdit
                    ? eventAuthoringDraft.permissionModeUpdatedAt
                    : spawnPermissionModeUpdatedAt;
                const eventSubmission = await submitPluginEventAutomation({
                    draft: eventAutomationDraft,
                    editTarget: eventAutomationEdit,
                    automationEditId: current.automationEditId,
                    metadata: activeAutomationDraft
                        ? {
                            name: activeAutomationDraft.name,
                            description: activeAutomationDraft.description,
                            enabled: activeAutomationDraft.enabled,
                        }
                        : null,
                    prompt: normalizedSessionPrompt,
                    // The strict recipe writer persists reference identity
                    // beside the rendered program, so the picked references
                    // travel with the Automation instead of surviving only
                    // as look-alike prompt text. Only a target whose dispatch
                    // delivers them is given them: storing a reference the
                    // materializer drops would be persisted dead state.
                    ...(eventTargetComposerReferences.length > 0
                        ? { mentions: eventTargetComposerReferences }
                        : {}),
                    targetKind: eventTargetKind,
                    executionTargetServerId: resolvedTargetServerId,
                    buildNewSessionSpawn: (currentSpawn) => {
                        if (!selectedMachineId || !eventPermissionMode || eventPermissionModeUpdatedAt === null) {
                            return null;
                        }
                        const agentTarget = eventBackendTarget
                            ? resolveAgentExecutionTargetForBackendTarget({
                                backendTarget: eventBackendTarget,
                                daemonMergedProjectionInputs: current.daemonMergedProjectionInputs,
                            })
                            : null;
                        if (!agentTarget) return null;
                        try {
                            return buildSessionServerStartSpawnDraftV1FromAuthoringDraft({
                                draft: {
                                    ...eventAuthoringDraft,
                                    prompt: normalizedSessionPrompt,
                                    displayText: normalizedSessionPrompt,
                                },
                                executionTarget: currentSpawn?.executionTarget ?? {
                                    serverId: resolvedTargetServerId,
                                    machineId: selectedMachineId,
                                },
                                ...(currentSpawn?.organizationPlacement
                                    ? { organizationPlacement: currentSpawn.organizationPlacement }
                                    : {}),
                                agentTarget,
                                permissionMode: eventPermissionMode,
                                configurationUpdatedAtMs: eventPermissionModeUpdatedAt,
                            });
                        } catch {
                            return null;
                        }
                    },
                    buildExecutionRun: () => null,
                    resolveTarget: current.resolveEventAutomationTarget,
                    confirmSubmission: confirmPluginEventAutomationSubmission,
                    isCurrent: isLaunchScopeStillActive,
                });
                if (eventSubmission.kind === 'cancelled') {
                    current.setIsCreating(false);
                    return;
                }
                if (eventSubmission.kind === 'unavailable') {
                    if (eventSubmission.reason === 'account') {
                        Modal.alert(
                            t('settingsPlugins.eventAutomationComposer.storedContentUnavailableTitle'),
                            t('settingsPlugins.eventAutomationComposer.storedContentUnavailableBody'),
                        );
                    } else {
                        Modal.alert(t('common.error'), eventAutomationEdit
                            ? t('automations.edit.updateFailed')
                            : t('newSession.failedToStart'));
                    }
                    current.setIsCreating(false);
                    return;
                }
                current.disableDraftPersistence?.();
                await clearCompletedDraft();
                reportAfterCreatedSettlement({ status: 'accepted', sessionId: null });
                current.router.replace((eventSubmission.kind === 'updated'
                    ? `/automations/${eventSubmission.automationId}`
                    : '/automations') as any);
                return;
            }

            if (activeAutomationDraft?.enabled === true) {
                if (rejectUnsupportedComposerSemanticsForAutomation({ persistsComposerReferences: false })) {
                    return;
                }
                const schedule = buildAutomationScheduleFromDraft(activeAutomationDraft);
                const template = buildAutomationTemplateFromSessionAuthoringDraft({
                    ...authoringDraft,
                    ...spawnSessionExtras,
                });
                validateAutomationTemplateTarget({
                    targetType: 'new_session',
                    template,
                });
                const templateCiphertext = await encodeAutomationTemplateCiphertextForAccount({
                    credentials: sync.getCredentials(),
                    template,
                    ...(sync.encryption
                        ? {
                            encryptRaw: (value) => sync.encryption!.encryptAutomationTemplateRaw(value),
                        }
                        : {}),
                });

                const normalizedAutomationInput = {
                    enabled: true,
                    name: normalizeAutomationName(activeAutomationDraft.name),
                    description: normalizeAutomationDescription(activeAutomationDraft.description),
                    schedule,
                    templateCiphertext,
                };
                const automationEditId = typeof current.automationEditId === 'string'
                    ? current.automationEditId.trim()
                    : '';

                if (automationEditId.length > 0) {
                    const definition = await sync.refreshAutomationDefinitionDetail(automationEditId);
                    const legacyAutomation = readLegacyScheduleAutomationDefinition(definition);
                    if (legacyAutomation?.id !== automationEditId) {
                        Modal.alert(t('common.error'), t('automations.edit.updateFailed'));
                        current.setIsCreating(false);
                        return;
                    }
                    await sync.updateAutomation(automationEditId, normalizedAutomationInput);
                    current.disableDraftPersistence?.();
                    await clearCompletedDraft();
                    await sync.refreshAutomations();
                    reportAfterCreatedSettlement({ status: 'accepted', sessionId: null });
                    current.router.replace(`/automations/${automationEditId}` as any);
                    return;
                }

                await sync.createAutomation({
                    ...normalizedAutomationInput,
                    targetType: 'new_session',
                    assignments: [{ machineId: selectedMachineId, enabled: true, priority: 100 }],
                });
                current.disableDraftPersistence?.();
                await clearCompletedDraft();
                await sync.refreshAutomations();
                reportAfterCreatedSettlement({ status: 'accepted', sessionId: null });
                current.router.replace('/automations' as any);
                return;
            }

            const strictV2ConfigurationOptionKeys = new Set(
                Object.keys(spawnSessionExtras.sessionConfigOptionOverrides?.overrides ?? {}),
            );
            const legacyOnlySpawnExtras = Object.keys(spawnSessionExtras).filter(
                (key) => key !== 'sessionConfigOptionOverrides' && !strictV2ConfigurationOptionKeys.has(key),
            );
            const hasLegacyOnlyEnvironment = Object.keys(environmentVariables ?? {}).length > 0;
            if (
                hasLegacyOnlyEnvironment
                || legacyOnlySpawnExtras.length > 0
            ) {
                // Environment overrides and Agent-specific extras have no
                // strict-V2 owner yet. Park them rather than silently dropping
                // one or falling back to the private machine-spawn path.
                Modal.alert(t('common.error'), t('newSession.failedToStart'));
                current.setIsCreating(false);
                return;
            }

            const retryableLaunchAttempt = launchAttemptRef.current?.status === 'failed_retryable'
                && isNewSessionLaunchAttemptInScope(launchAttemptRef.current, launchScopeKey)
                ? launchAttemptRef.current
                : null;
            let launchAttempt = retryableLaunchAttempt ?? createNewSessionLaunchAttempt({
                prompt: normalizedSessionPrompt,
                displayText: normalizedSessionPrompt,
                scopeKey: launchScopeKey,
                attemptId: launchUserAttemptIdForCurrentIntentRef.current,
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
                });
            }
            publishLaunchAttempt(launchAttempt);
            let createdSessionId = launchAttempt.createdSessionId;
            let initialInputLocalId: string | null = null;
            let initialMessageText = '';
            let initialInputWasNotAccepted = false;

            if (resolvedInitialMessage?.kind === 'template') {
                initialMessageText = await expandPromptTemplateInvocation({
                    targetArtifactId: resolvedInitialMessage.targetArtifactId,
                    argsText: resolvedInitialMessage.rest,
                });
            } else if (resolvedInitialMessage?.kind === 'send') {
                initialMessageText = resolvedInitialMessage.text.trim();
            }

            if (shouldSpawnForNewSessionLaunchAttempt(launchAttempt)) {
                launchAttempt = markNewSessionLaunchAttemptSpawning(launchAttempt);
                publishLaunchAttempt(launchAttempt);
                const agentTarget = resolveAgentExecutionTargetForBackendTarget({
                    backendTarget: current.spawnBackendTarget ?? backendTarget,
                    daemonMergedProjectionInputs: current.daemonMergedProjectionInputs,
                });
                if (!agentTarget) {
                    launchAttempt = markNewSessionLaunchAttemptFailed(launchAttempt, {
                        phase: 'spawning',
                        error: new Error('The selected Agent is unavailable on this machine.'),
                        retryable: false,
                    });
                    publishLaunchAttempt(null);
                    Modal.alert(t('common.error'), t('newSession.failedToStart'));
                    current.setIsCreating(false);
                    return;
                }

                const spawnInput = buildSessionSpawnNewInputV2FromAuthoringDraft({
                        draft: authoringDraft,
                        creationKey: launchAttempt.attemptId,
                        executionTarget: {
                            serverId: resolvedTargetServerId,
                            machineId: selectedMachineId,
                        },
                        organizationPlacement: { folderId: null, tagIds: [] },
                        agentTarget,
                        permissionMode: spawnPermissionMode,
                        configurationUpdatedAtMs: spawnPermissionModeUpdatedAt,
                        initialMessage: initialMessageText || null,
                        sourceContext: current.sourceContext ?? null,
                    });
                const releaseUserRequestLease = sync.acquireUserRequestLease();
                actionOperationPresentationCoordinator.register({
                    requestId: launchAttempt.attemptId,
                    onStart: 'current',
                    ...(current.draftScope && current.draftId
                        ? { origin: createNewSessionActionOperationOrigin(current.draftScope, current.draftId) }
                        : {}),
                });
                const actionResult = await (async () => {
                    try {
                        return await executeSessionSpawnNewAction(spawnInput, {
                            surface: 'ui',
                            actionRequestId: launchAttempt.attemptId,
                        });
                    } catch (error) {
                        const draftAccountId = current.draftScope?.accountId.trim() ?? '';
                        const canonicalOperation = draftAccountId
                            ? actionOperationSelectors.selectSnapshotByRequestId(
                                actionOperationStore.getSnapshot(),
                                launchAttempt.attemptId,
                                draftAccountId,
                            )
                            : null;
                        if (
                            canonicalOperation?.actionId === 'session.spawn_new'
                            && (
                                canonicalOperation.state === 'accepted'
                                || canonicalOperation.state === 'running'
                                || canonicalOperation.state === 'succeeded'
                                || canonicalOperation.state === 'failed'
                                || canonicalOperation.state === 'cancelled'
                            )
                        ) {
                            settlementOwnedByCanonicalOperation = canonicalOperation.state === 'accepted'
                                || canonicalOperation.state === 'running'
                                || canonicalOperation.state === 'succeeded';
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
                    launchAttempt = markNewSessionLaunchAttemptFailed(launchAttempt, {
                        phase: 'spawning',
                        error: new Error(actionResult.error),
                        retryable: false,
                    });
                    publishLaunchAttempt(null);
                    // An older CLI returning method-unavailable remains a typed
                    // Action failure; ordinary UI creation never falls back.
                    Modal.alert(
                        t('common.error'),
                        t(resolveSessionSpawnNewActionFailureMessageKey(actionResult)),
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
                        t(resolveSessionSpawnNewResultFailureMessageKey(actionResult.result)),
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
                    publishLaunchAttempt(actionResult.result.retryable ? launchAttempt : null);
                    Modal.alert(
                        t('common.error'),
                        t(resolveSessionSpawnNewResultFailureMessageKey(actionResult.result)),
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
                initialInputWasNotAccepted = initialMessageText.length > 0 && initialInputLocalId === null;
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
                const spawnedBackendTargetKey = resolveBackendTargetKeyV2(current.spawnBackendTarget ?? backendTarget);
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

                const ensureCreatedSessionVisibleForRoute = async (): Promise<boolean> => {
                    try {
                        await requireLocalSessionVisibleForRoute({
                            sessionId: createdSessionId,
                            serverId: resolvedTargetServerId,
                            getStoredSession: (sessionId) => storage.getState().sessions[sessionId] ?? null,
                            ensureSessionVisibleForMessageRoute: typeof sync.ensureSessionVisibleForMessageRoute === 'function'
                                ? sync.ensureSessionVisibleForMessageRoute
                                : null,
                        });
                        return true;
                    } catch (error) {
                        if (isCreatedSessionUnavailableLocally(error)) {
                            return false;
                        }
                        throw error;
                    }
                };

                const projectCreatedSessionFirstTurnForRoute = (): void => {
                    if (!initialMessageText || !initialInputLocalId) {
                        return;
                    }
                    const state = storage.getState();
                    const session = state.sessions[createdSessionId] ?? null;
                    const modelMode = session?.modelMode
                        || current.modelMode
                        || (staticAgentId ? getAgentCore(staticAgentId)?.model.defaultMode : null)
                        || 'default';
                    const permissionMode = session?.permissionMode || current.permissionMode || 'default';
                    const rawRecord = buildOutgoingUserTextRecord({
                        text: initialMessageText,
                        displayText: initialMessageText,
                        agentId: current.agentType,
                        permissionMode,
                        modelMode,
                        settings: state.settings,
                        session,
                    });
                    if (session) {
                        storage.getState().markSessionOptimisticThinking(createdSessionId);
                    }
                    projectLocalOutboundUserMessage({
                        sessionId: createdSessionId,
                        localId: initialInputLocalId,
                        text: initialMessageText,
                        displayText: initialMessageText,
                        rawRecord,
                        deliveryStatus: 'queued',
                    });
                };

                const openCreatedSessionRoute = async (options?: Readonly<{ projectFirstTurn?: boolean }>): Promise<boolean> => {
                    const isCreatedSessionVisible = await ensureCreatedSessionVisibleForRoute();
                    if (!isCreatedSessionVisible) {
                        return false;
                    }
                    if (!isLaunchScopeStillActive()) {
                        return false;
                    }
                    if (options?.projectFirstTurn === true || initialInputLocalId !== null) {
                        projectCreatedSessionFirstTurnForRoute();
                    }
                    current.router.replace(postSpawnReplacementHref ?? buildCreatedSessionRoute(), {
                        dangerouslySingular() {
                            return 'session';
                        },
                    });
                    actionOperationPresentationCoordinator.acknowledgeRequestPresented(launchAttempt.attemptId);
                    createdSessionRouteOpened = true;
                    return true;
                };

                const openCreatedSessionRouteWithRecovery = async (options?: Readonly<{ projectFirstTurn?: boolean }>): Promise<boolean> => {
                    for (let attempt = 0; attempt < CREATED_SESSION_ROUTE_RECOVERY_ATTEMPTS; attempt += 1) {
                        const opened = await openCreatedSessionRoute(options);
                        if (opened) {
                            return true;
                        }
                        if (!isLaunchScopeStillActive()) {
                            return false;
                        }
                        if (attempt < CREATED_SESSION_ROUTE_RECOVERY_ATTEMPTS - 1) {
                            await waitForCreatedSessionRouteRecoveryDelay();
                        }
                    }
                    return false;
                };

                const runAfterCreatedFollowUp = async (): Promise<void> => {
                    if (!opts?.afterCreated) {
                        return;
                    }
                    try {
                        await opts.afterCreated({
                            sessionId: createdSessionId,
                            effectiveSpawnServerId: resolvedTargetServerId,
                            launchAttempt,
                        });
                    } catch (error) {
                        postSpawnFailurePhase = 'uploading_attachments';
                        postSpawnFollowUpError = error;
                        postSpawnFollowUpRetryRef.current = runAfterCreatedFollowUp;
                        throw error;
                    }
                };

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
                            agentId: current.agentType,
                            backendTarget: current.backendTarget ?? null,
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
                if (staticAgentId && getAgentCore(staticAgentId)?.model.supportsSelection && current.modelMode && current.modelMode !== 'default') {
                    storage.getState().updateSessionModelMode(createdSessionId, current.modelMode);
                }

                if (!postSpawnFollowUpError && opts?.afterCreated) {
                    try {
                        await runAfterCreatedFollowUp();
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
                    actionOperationStore.markFollowUpNeedsAttention(
                        launchAttempt.attemptId,
                        t('inbox.actionOperations.followUpNeedsAttention'),
                    );
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
                        preserveCreatedSessionDraft({
                            sessionId: createdSessionId,
                            draftText: initialMessageText || sessionPrompt,
                            scope: current.draftScope,
                        });
                    }
                    if (mountedRef.current) {
                        current.setIsCreating(false);
                    }
                    return;
                } else {
                    launchAttempt = markNewSessionLaunchAttemptComplete(launchAttempt);
                    if (opts?.afterCreated && mountedRef.current && isLaunchScopeStillActive()) {
                        reportAfterCreatedSettlement({ status: 'accepted', sessionId: createdSessionId });
                    }
                }

                if (initialInputWasNotAccepted) {
                    preserveCreatedSessionDraft({
                        sessionId: createdSessionId,
                        draftText: initialMessageText || sessionPrompt,
                        scope: current.draftScope,
                    });
                }

                if (!createdSessionRouteOpened && isLaunchScopeStillActive()) {
                    const openedCreatedSessionRoute = await openCreatedSessionRouteWithRecovery();
                    if (!openedCreatedSessionRoute) {
                        if (!isLaunchScopeStillActive()) {
                            publishLaunchAttempt(null);
                            current.setIsCreating(false);
                            return;
                        }
                        throw new Error(CREATED_SESSION_NOT_AVAILABLE_LOCALLY_ERROR);
                    }
                }
                publishLaunchAttempt(null);
                if (!opts?.deferAcceptedDraftClearToDocument) {
                    if (mountedRef.current) {
                        current.disableDraftPersistence?.();
                    }
                    await clearCompletedDraft(launchAttempt.attemptId);
                }
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
            if (isAutomationTemplateEncryptionMaterialUnavailableError(error)) {
                Modal.alert(
                    t('settingsAccount.restoreRequiredTitle'),
                    t('settingsAccount.secretKeyMissing'),
                );
                latestParamsRef.current.setIsCreating(false);
                return;
            }
            if (isAutomationApiErrorCode(error, 'automation_stored_content_unavailable')) {
                Modal.alert(
                    t('settingsPlugins.eventAutomationComposer.storedContentUnavailableTitle'),
                    t('settingsPlugins.eventAutomationComposer.storedContentUnavailableBody'),
                );
                latestParamsRef.current.setIsCreating(false);
                return;
            }
            if (isAutomationApiErrorCode(error, 'automation_template_version_conflict')) {
                Modal.alert(t('common.error'), t('automations.edit.updateFailed'));
                latestParamsRef.current.setIsCreating(false);
                return;
            }
            let errorMessage = error instanceof Error
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
            if (!settlementOwnedByCanonicalOperation) {
                reportAfterCreatedSettlement({ status: 'rejected' });
            }
            createInFlightRef.current = false;
        }
    }, [applySettings, mountedRef, publishLaunchAttempt]);

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

    return { handleCreateSession, providerLaunchError, retryProviderLaunch };
}
