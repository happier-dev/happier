import * as React from 'react';

import { t } from '@/text';
import { Modal } from '@/modal';
import { sync } from '@/sync/sync';
import { useApplySettings } from '@/sync/store/settingsWriters';
import { storage } from '@/sync/domains/state/storage';
import {
    completeMachineSpawnAttemptCustody,
    machineBash,
    machineSpawnNewSession,
    resetMachineSpawnAttemptCustody,
} from '@/sync/ops';
import type { MachineSpawnAttemptCustody } from '@/sync/ops/machines';
import { resolveTerminalSpawnOptions } from '@/sync/domains/settings/terminalSettings';
import { normalizeSessionAuthoringConnectedServices } from '@/sync/domains/sessionAuthoring/sessionAuthoringNormalization';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveNewSessionServerTarget } from '@/sync/domains/server/selection/serverSelectionResolver';
import { getMissingRequiredConfigEnvVarNames } from '@/utils/profiles/profileConfigRequirements';
import { getSecretSatisfaction } from '@/utils/secrets/secretSatisfaction';
import type { SecretChoiceByProfileIdByEnvVarName } from '@/utils/secrets/secretRequirementApply';
import { getBuiltInProfile } from '@/sync/domains/profiles/profileUtils';
import { isProfileCompatibleWithBackendTarget, type AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import type { Settings } from '@/sync/domains/settings/settings';
import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { resolveEffectiveWindowsRemoteSessionLaunchMode } from '@/sync/domains/session/spawn/windowsRemoteSessionLaunchMode';
import { getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import { buildSpawnEnvironmentVariablesFromUiState, buildSpawnSessionExtrasFromUiState, getAgentResumeExperimentsFromSettings, getNewSessionPreflightIssues } from '@/agents/catalog/catalog';
import { transformProfileToEnvironmentVars } from '@/components/sessions/new/modules/profileHelpers';
import type { NewSessionPromptStore } from '@/components/sessions/new/hooks/screenModel/newSessionPromptStore';
import type { UseMachineEnvPresenceResult } from '@/hooks/machine/useMachineEnvPresence';
import { getMachineCapabilitiesSnapshot } from '@/hooks/server/useMachineCapabilitiesCache';
import type { PermissionMode, ModelMode } from '@/sync/domains/permissions/permissionTypes';
import { SPAWN_SESSION_ERROR_CODES, type ActionOperationSnapshotV1, type BackendTargetRefV1, type WindowsRemoteSessionLaunchMode } from '@happier-dev/protocol';
import type { AcpConfigOptionOverridesV1 } from '@happier-dev/protocol';
import type { SessionSpawnSourceContextV1 } from '@happier-dev/protocol';
import { parsePermissionIntentAlias } from '@happier-dev/agents';
import type { CodexBackendMode } from '@happier-dev/agents';
import { nowServerMs } from '@/sync/runtime/time';
import { encodeAutomationTemplateCiphertextForAccount } from '@/sync/domains/automations/encodeAutomationTemplateCiphertextForAccount';
import { resolveSessionComposerSend } from '@/sync/domains/input/slashCommands/resolveSessionComposerSend';
import { expandPromptTemplateInvocation } from '@/sync/domains/input/slashCommands/expandPromptTemplateInvocation';
import { executeSessionComposerResolution } from '@/sync/domains/input/slashCommands/executeSessionComposerResolution';
import { resolvePromptInvocationComposerSendAction } from '@/sync/domains/input/slashCommands/promptInvocationBehavior';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { resolveServerIdForSessionIdFromLocalCache } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';
import { isSocketIoAckTimeoutError } from '@/sync/runtime/socketIoAckTimeout';
import { readNonBlankSessionControlIdentifier } from '@/sync/domains/sessionControl/opaqueIdentifiers';
import type { PreflightModelList } from '@/sync/domains/models/modelOptions';
import { getModelOptionsForAgentType } from '@/sync/domains/models/modelOptions';

function getActiveNewSessionDraftScope() {
    return storage.getState().profileScope ?? null;
}

import {
    buildAutomationScheduleFromDraft,
    normalizeAutomationDescription,
    normalizeAutomationName,
    validateAutomationTemplateTarget,
} from '@/sync/domains/automations/automationValidation';
import {
    classifyLaunchRetryFailure,
    isDaemonUnavailableAlertError,
    promptDaemonUnavailableRetry,
    showDaemonUnavailableAlert,
} from '@/utils/errors/daemonUnavailableAlert';
import { captureExceptionIfEnabled } from '@/utils/system/sentry';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useMountedRef } from '@/hooks/ui/useMountedRef';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import type { SessionMcpSelectionV1 } from '@happier-dev/protocol';
import type { NewSessionCheckoutCreationDraft } from '@/sync/domains/state/newSessionCheckoutDraft';
import { materializeNewSessionCheckout } from '@/components/sessions/new/modules/materializeNewSessionCheckout';
import { rollbackNewSessionArtifacts } from '@/components/sessions/new/modules/rollbackNewSessionArtifacts';
import { resolveConnectedServiceSwitchUnavailablePresentation } from '@/components/sessions/new/modules/connectedServiceSwitchUnavailable';
import { translateConnectedServiceUxDiagnosticBody } from '@/components/sessions/connectedServices/diagnostics/connectedServiceUxDiagnostics';
import {
    followUpSpawnedSessionWithServerScope,
    requireSpawnedSessionVisibleForRoute,
} from '@/sync/runtime/orchestration/serverScopedRpc/followUpSpawnedSession';
import {
    buildOutgoingUserTextRecord,
    projectLocalOutboundUserMessage,
} from '@/sync/domains/messages/outgoingUserMessage';
import { resolveSentFrom } from '@/sync/domains/messages/sentFrom';
import { mergeMessageMetaOverrides } from '@/components/sessions/agentInput/structuredInputMentions';
import { supportsSpawnPendingFirstInput } from '@/sync/domains/session/spawn/spawnSessionPayload';
import {
    buildAutomationTemplateFromSessionAuthoringDraft,
    buildNewSessionAuthoringDraftFromResolvedInputs,
    buildSpawnSessionOptionsFromAuthoringDraft,
} from '@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters';
import type { SessionAuthoringDraft } from '@/components/sessions/authoring/draft/sessionAuthoringDraft';
import {
    adoptNewSessionLaunchAttemptCustody,
    createNewSessionLaunchAttempt,
    isNewSessionLaunchAttemptInScope,
    markNewSessionLaunchAttemptComplete,
    markNewSessionLaunchAttemptCreated,
    markNewSessionLaunchAttemptFailed,
    markNewSessionLaunchAttemptSendingFirstTurn,
    markNewSessionLaunchAttemptSpawning,
    shouldSpawnForNewSessionLaunchAttempt,
    type NewSessionLaunchAttempt,
} from '@/components/sessions/new/modules/newSessionLaunchAttempt';
import {
    actionOperationReentry,
    resolvePersistedNewSessionOperationIdentity,
    type PersistedNewSessionOperationIdentity,
    type NewSessionOperationReentryRegistration,
} from '@/sync/domains/actionOperations/actionOperationReentry';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { acknowledgeActionOperationPresented } from '@/sync/domains/actionOperations/acknowledgeActionOperationPresented';
import { reconcileSpawnAttemptCustodyFromOperation } from '@/sync/domains/session/spawn/spawnAttemptNonceStore';
import {
    captureSessionDraftLaunchCurrentness,
    captureSessionDraftCurrentness,
    clearSessionDraftLaunchCurrentness,
    clearSessionDraftCurrentness,
    getSessionDraftSnapshot,
    readSessionDraftLaunchCurrentness,
    type SessionDraftCurrentness,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';

type MutableSettingsDelta = {
    -readonly [TKey in keyof Settings]?: Settings[TKey];
};

export type CreatedSessionFollowUpContext = Readonly<{
    sessionId: string;
    effectiveSpawnServerId: string | null;
    launchAttempt: NewSessionLaunchAttempt;
}>;

export type HandleCreateSessionOptions = Readonly<{
    initialMessage?: 'send' | 'skip';
    inputTextOverride?: string;
    /**
     * The composer's structured-input envelope for the first turn (`mentions[]` and the legacy
     * projection of it). This hook owns the first turn, so it is the only place that envelope
     * can reach the message: without it an `@session` reference composed before the session
     * existed would arrive as bare text with no envelope entry, which INV-5 renders as nothing.
     *
     * Ranges are validated against the SUBMITTED text at the request boundary
     * (`sanitizeSessionUserMessageSendMeta`), element-wise, so a first turn this hook rewrites
     * — a `/template` expansion, a `/goal` — drops the references that no longer describe their
     * own token and keeps the rest (INV-4). That decision has one owner and is not repeated here.
     */
    structuredInputMetaOverrides?: Record<string, unknown>;
    afterCreated?: (context: CreatedSessionFollowUpContext) => void | Promise<void>;
    /**
     * D2: relaunch under the newly-selected connected-service account WITHOUT resume continuity, after
     * the "switch unavailable" dialog offered "start fresh". Drops the vendor resume reference so the
     * new account begins a clean conversation instead of fail-closing again on an unreachable resume.
     */
    startFreshUnderNewAccount?: boolean;
}>;

function normalizeLaunchScopePart(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function buildNewSessionLaunchScopeKey(params: Readonly<{
    machineId: string | null;
    serverId: string | null;
    selectedPath: string;
    useProfiles: boolean;
    selectedProfileId: string | null;
}>): string {
    return [
        `machine:${normalizeLaunchScopePart(params.machineId)}`,
        `server:${normalizeLaunchScopePart(params.serverId)}`,
        `path:${normalizeLaunchScopePart(params.selectedPath)}`,
        `profiles:${params.useProfiles ? 'on' : 'off'}`,
        `profile:${normalizeLaunchScopePart(params.selectedProfileId)}`,
    ].join('|');
}

function isFirstTurnFollowUpTimeout(error: unknown): boolean {
    return isSocketIoAckTimeoutError(error);
}

function readTrackedSpawnCreatedSessionId(operation: ActionOperationSnapshotV1): string | null {
    if (operation.state !== 'succeeded' || !operation.result || typeof operation.result !== 'object') return null;
    const sessionId = (operation.result as Readonly<Record<string, unknown>>).sessionId;
    return typeof sessionId === 'string' && sessionId.trim().length > 0 ? sessionId.trim() : null;
}

function findPresentedSpawnOperation(params: Readonly<{
    accountId?: string | null;
    machineId: string;
    requestId: string;
    sessionId: string;
}>): ActionOperationSnapshotV1 | null {
    const candidates = Array.from(actionOperationStore.getState().operationsById.values()).filter((operation) => (
        operation.actionId === 'session.spawn_new'
        && operation.state === 'succeeded'
        && operation.scope.machineId === params.machineId
        && (!params.accountId || operation.scope.accountId === params.accountId)
        && operation.requestId === params.requestId
        && readTrackedSpawnCreatedSessionId(operation) === params.sessionId
    ));
    return candidates.length === 1 ? candidates[0]! : null;
}

function isDetachedTrackedSpawnTransportError(error: unknown): boolean {
    if (isSocketIoAckTimeoutError(error)) return true;
    if (!(error instanceof Error)) return false;
    const message = error.message.toLowerCase();
    return message.includes('socket not connected') || message.includes('socket disconnected');
}

function readNewSessionConnectedServicesOption(
    agentNewSessionOptions: Record<string, unknown> | null | undefined,
): SessionAuthoringDraft['connectedServices'] {
    return normalizeSessionAuthoringConnectedServices(agentNewSessionOptions?.connectedServices ?? null);
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

    agentType: AgentId;
    backendTarget?: BackendTargetRefV1;
    transcriptStorage?: 'persisted' | 'direct';
    permissionMode: PermissionMode;
    modelMode: ModelMode;
    /**
     * Optional: seed ACP "agent mode" (e.g. OpenCode plan/build) at session start.
     * Applied before the first message is sent.
     */
    acpSessionModeId?: string | null;
    sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1 | null;

    /**
     * Live composer text handle. Read at submit time rather than taken as a render
     * dependency, so typing does not re-run the new-session screen model.
     */
    promptStore: NewSessionPromptStore;
    setSessionPrompt?: (prompt: string) => void;
    resumeSessionId: string;
    agentNewSessionOptions?: Record<string, unknown> | null;
    executionRunsEnabled?: boolean;
    authoringDraft?: SessionAuthoringDraft | null;
    automationEditId?: string | null;
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
    draftScope?: ServerAccountScope | null;
    draftId: string;
    disableDraftPersistence?: () => void;
    persistDraftForLaunch?: () => void | Promise<void>;
    launchIntentSignature: string;
    launchUserAttemptId?: string | null;
    onLaunchUserAttemptIdChange?: (userAttemptId: string | null) => void;
    persistedOperationReentry?: PersistedNewSessionOperationIdentity | null;
    /**
     * "Create this Session as a continuation of that one." Required semantics,
     * not an ignorable hint: it is carried on the spawn options rather than
     * dropped when the user leaves the chip attached.
     */
    sourceContext?: SessionSpawnSourceContextV1 | null;
    /**
     * Wizard preflight model list for the selected backend target. After a successful spawn it
     * seeds `sessionModelsV1` for dynamic-probe agents without a static catalog (e.g. Pi), whose
     * in-session picker would otherwise stay empty until the runtime publishes on first prompt.
     */
    preflightModels?: PreflightModelList | null;
}>): Readonly<{
    handleCreateSession: (opts?: HandleCreateSessionOptions) => void;
    resumePersistedLaunchKey: string | null;
}> {
    const mountedRef = useMountedRef();
    const applySettings = useApplySettings();
    const latestParamsRef = React.useRef(params);
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
    const handledTerminalReentryRevisionRef = React.useRef<string | null>(null);
    // Keep the latest params available synchronously so event handlers can't observe
    // a stale snapshot in the window between rerender and effect flush.
    latestParamsRef.current = params;
    const operationReentryRevision = React.useSyncExternalStore(
        actionOperationReentry.subscribe,
        actionOperationReentry.getRevision,
        actionOperationReentry.getRevision,
    );

    const handleCreateSession = React.useCallback(async (opts?: HandleCreateSessionOptions) => {
        if (createInFlightRef.current) return;
        const current = latestParamsRef.current;
        const requestedPath = typeof current.getRequestedPath === 'function'
            ? current.getRequestedPath()
            : current.selectedPath;
        const effectiveSelectedPath = (typeof requestedPath === 'string'
            ? requestedPath
            : current.selectedPath).trim();
        const trimmedEffectiveSelectedPath = effectiveSelectedPath;
        let rollbackActualPath: string | null = null;
        let rollbackServerId: string | null = current.targetServerId ?? null;
        let confirmedCreatedSessionId: string | null = null;
        let operationReentryRegistration: NewSessionOperationReentryRegistration | null = null;
        let launchDraftCurrentness: SessionDraftCurrentness | null = null;
        const isRepoNativeWorktreeLaunch = current.checkoutCreationDraft?.kind === 'git_worktree';

        if (!current.selectedMachineId) {
            Modal.alert(t('common.error'), t('newSession.noMachineSelected'));
            return;
        }
        if (trimmedEffectiveSelectedPath.length === 0) {
            Modal.alert(t('common.error'), t('newSession.noPathSelected'));
            return;
        }

        const persistedOperationReentry = current.persistedOperationReentry;
        if (persistedOperationReentry) {
            operationReentryRegistration = actionOperationReentry.registerNewSession({
                requestId: persistedOperationReentry.custody.nonce,
                draftScope: persistedOperationReentry.custody.scope,
                draftId: current.draftId,
            });
            if (!operationReentryRegistration) {
                current.setIsCreating(false);
                return;
            }
        }
        createInFlightRef.current = true;
        current.setIsCreating(true);

        try {
            const targetServerId = typeof current.targetServerId === 'string' ? current.targetServerId.trim() : '';
            const snapshot = getActiveServerSnapshot();
            const allowedTargetServerIds = Array.isArray(current.allowedTargetServerIds)
                ? current.allowedTargetServerIds
                : [snapshot.serverId];
            const targetResolution = resolveNewSessionServerTarget({
                requestedServerId: targetServerId,
                activeServerId: snapshot.serverId,
                allowedServerIds: allowedTargetServerIds,
            });
            const resolvedTargetServerId = typeof targetResolution.targetServerId === 'string'
                && targetResolution.targetServerId.trim().length > 0
                ? targetResolution.targetServerId
                : snapshot.serverId;
            rollbackServerId = resolvedTargetServerId;
            const launchScopeKey = buildNewSessionLaunchScopeKey({
                machineId: current.selectedMachineId,
                serverId: resolvedTargetServerId,
                selectedPath: trimmedEffectiveSelectedPath,
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
                const latestTargetServerId = typeof latest.targetServerId === 'string' ? latest.targetServerId.trim() : '';
                const latestSnapshot = getActiveServerSnapshot();
                const latestAllowedTargetServerIds = Array.isArray(latest.allowedTargetServerIds)
                    ? latest.allowedTargetServerIds
                    : [latestSnapshot.serverId];
                const latestTargetResolution = resolveNewSessionServerTarget({
                    requestedServerId: latestTargetServerId,
                    activeServerId: latestSnapshot.serverId,
                    allowedServerIds: latestAllowedTargetServerIds,
                });
                const latestResolvedTargetServerId = typeof latestTargetResolution.targetServerId === 'string'
                    && latestTargetResolution.targetServerId.trim().length > 0
                    ? latestTargetResolution.targetServerId
                    : latestSnapshot.serverId;
                return buildNewSessionLaunchScopeKey({
                    machineId: latest.selectedMachineId,
                    serverId: latestResolvedTargetServerId,
                    selectedPath: latestEffectiveSelectedPath,
                    useProfiles: latest.useProfiles,
                    selectedProfileId: latest.useProfiles ? latest.selectedProfileId : null,
                });
            };
            const isLaunchScopeStillActive = (): boolean => resolveCurrentLaunchScopeKey() === launchScopeKey;

            const sessionPromptText = typeof opts?.inputTextOverride === 'string'
                ? opts.inputTextOverride
                : current.promptStore.getPrompt();
            const shouldSendInitialMessage = (opts?.initialMessage ?? 'send') !== 'skip';
            const shouldPrepareInitialMessage = shouldSendInitialMessage && sessionPromptText.trim();
            const resolvedInitialMessage = shouldPrepareInitialMessage
                ? resolveSessionComposerSend({
                    input: sessionPromptText,
                    executionRunsEnabled: current.executionRunsEnabled === true,
                    // A new session has no live runtime registry yet. Preserve the user's text and
                    // let the provider handle `/goal` until the attached runner can advertise the
                    // callable controls used by the local goal UI.
                    goalControlsAvailable: false,
                    promptInvocationsV1: storage.getState().settings.promptInvocationsV1,
                })
                : null;

            if (
                resolvedInitialMessage?.kind === 'template'
                && resolvePromptInvocationComposerSendAction(resolvedInitialMessage.behavior) === 'insert'
            ) {
                const expanded = await expandPromptTemplateInvocation({
                    targetArtifactId: resolvedInitialMessage.targetArtifactId,
                    argsText: resolvedInitialMessage.rest,
                });
                current.setSessionPrompt?.(expanded);
                current.setIsCreating(false);
                return;
            }

            const updatedPaths = [
                { machineId: current.selectedMachineId, path: effectiveSelectedPath },
                ...current.recentMachinePaths.filter((rp) => (
                    rp.machineId !== current.selectedMachineId || rp.path !== effectiveSelectedPath
                )),
            ].slice(0, 10);
            const profilesActive = current.useProfiles;

            const settingsUpdate: MutableSettingsDelta = {
                recentMachinePaths: updatedPaths,
                lastUsedAgent: current.agentType,
                lastUsedBackendTarget: current.backendTarget,
            };
            if (profilesActive) {
                settingsUpdate.lastUsedProfile = current.selectedProfileId;
            }
            applySettings(settingsUpdate);

            const backendTarget: BackendTargetRefV1 = current.backendTarget ?? { kind: 'builtInAgent', agentId: current.agentType };
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

            environmentVariables = buildSpawnEnvironmentVariablesFromUiState({
                agentId: current.agentType,
                settings: current.settings,
                environmentVariables,
                newSessionOptions: {
                    ...(current.agentNewSessionOptions ?? {}),
                    targetServerId: resolvedTargetServerId,
                },
            });
            const connectedServices = readNewSessionConnectedServicesOption(current.agentNewSessionOptions);

            const terminal = resolveTerminalSpawnOptions({
                settings: storage.getState().settings,
                machineId: current.selectedMachineId,
            });

            const machineCapsSnapshot = getMachineCapabilitiesSnapshot(current.selectedMachineId, resolvedTargetServerId);
            const machineCapsResults = machineCapsSnapshot?.response.results as any;
            const experiments = getAgentResumeExperimentsFromSettings(current.agentType, current.settings);
            const preflightIssues = getNewSessionPreflightIssues({
                agentId: current.agentType,
                experiments,
                resumeSessionId: current.resumeSessionId,
                results: machineCapsResults,
            });
            const blockingIssue = preflightIssues[0] ?? null;
            if (blockingIssue) {
                const openMachine = await Modal.confirm(
                    t(blockingIssue.titleKey),
                    t(blockingIssue.messageKey),
                    { confirmText: t(blockingIssue.confirmTextKey) }
                );
                if (openMachine && blockingIssue.action === 'openMachine') {
                    current.router.push(`/machine/${current.selectedMachineId}` as any);
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
            const normalizedAcpModeId = readNonBlankSessionControlIdentifier(current.acpSessionModeId) ?? '';
            const spawnModelId =
                getAgentCore(current.agentType).model.supportsSelection === true &&
                typeof current.modelMode === 'string' &&
                current.modelMode.trim().length > 0 &&
                current.modelMode !== 'default'
                    ? current.modelMode
                    : undefined;
            const spawnModelUpdatedAt = spawnModelId ? spawnPermissionModeUpdatedAt : undefined;
            const windowsRemoteSessionLaunchMode = resolveEffectiveWindowsRemoteSessionLaunchMode({
                machineMetadata: current.selectedMachine?.metadata,
                settings: current.settings,
                sessionOverride: current.windowsRemoteSessionLaunchModeOverride ?? undefined,
            }).mode;
            const windowsTerminalWindowName = typeof current.settings.sessionWindowsTerminalWindowName === 'string'
                ? current.settings.sessionWindowsTerminalWindowName.trim()
                : '';
            const normalizedSessionPrompt = sessionPromptText.trim();
            const spawnSessionExtras = buildSpawnSessionExtrasFromUiState({
                agentId: current.agentType,
                settings: current.settings,
                // Honor the D2 "start fresh" drop: when relaunching fresh under the new account, the
                // resume-derived extras must not carry the old resume reference either.
                resumeSessionId: resumeId ?? '',
            });
            const authoringDraft = buildNewSessionAuthoringDraftFromResolvedInputs({
                directory: effectiveSelectedPath,
                checkoutCreationDraft: current.checkoutCreationDraft ?? null,
                prompt: normalizedSessionPrompt,
                displayText: normalizedSessionPrompt,
                agentId: current.agentType,
                backendTarget,
                transcriptStorage: current.transcriptStorage ?? null,
                profileId: profilesActive ? (current.selectedProfileId ?? '') : null,
                environmentVariables: environmentVariables ?? null,
                resumeSessionId: resumeId ?? null,
                permissionMode: spawnPermissionMode,
                permissionModeUpdatedAt: spawnPermissionModeUpdatedAt,
                modelId: spawnModelId ?? null,
                modelUpdatedAt: spawnModelUpdatedAt ?? null,
                mcpSelection: current.mcpSelection ?? null,
                connectedServices: connectedServices ?? null,
                connectedServicesUpdatedAt: connectedServices ? spawnPermissionModeUpdatedAt : null,
                terminal: terminal ?? null,
                windowsRemoteSessionLaunchMode: windowsRemoteSessionLaunchMode ?? null,
                windowsRemoteSessionConsole: null,
                windowsTerminalWindowName: windowsTerminalWindowName || null,
                codexBackendMode: typeof spawnSessionExtras.codexBackendMode === 'string'
                    ? spawnSessionExtras.codexBackendMode as CodexBackendMode
                    : null,
                acpSessionModeId: normalizedAcpModeId || null,
                sessionConfigOptionOverrides: current.sessionConfigOptionOverrides ?? null,
                automation: current.authoringDraft?.automation ?? null,
            });

            const activeAutomationDraft = authoringDraft.automation ?? null;

            if (activeAutomationDraft?.enabled === true) {
                await current.persistDraftForLaunch?.();
                if (current.draftScope) {
                    launchDraftCurrentness = captureSessionDraftCurrentness({
                        scope: current.draftScope,
                        address: { kind: 'newSession', draftId: current.draftId },
                    });
                }
                const schedule = buildAutomationScheduleFromDraft(activeAutomationDraft);
                const template = buildAutomationTemplateFromSessionAuthoringDraft({
                    ...authoringDraft,
                    ...spawnSessionExtras,
                    windowsTerminalWindowName: windowsTerminalWindowName || null,
                });
                validateAutomationTemplateTarget({
                    targetType: 'new_session',
                    template,
                });
                const templateCiphertext = await encodeAutomationTemplateCiphertextForAccount({
                    credentials: sync.getCredentials(),
                    template,
                    encryptRaw: (value) => sync.encryption.encryptAutomationTemplateRaw(value),
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
                    await sync.updateAutomation(automationEditId, normalizedAutomationInput);
                    current.disableDraftPersistence?.();
                    if (current.draftScope && launchDraftCurrentness) {
                        await clearSessionDraftCurrentness({
                            scope: current.draftScope,
                            address: { kind: 'newSession', draftId: current.draftId },
                            currentness: launchDraftCurrentness,
                        });
                    }
                    current.onLaunchUserAttemptIdChange?.(null);
                    await sync.refreshAutomations();
                    current.router.replace(`/automations/${automationEditId}` as any);
                    return;
                }

                await sync.createAutomation({
                    ...normalizedAutomationInput,
                    targetType: 'new_session',
                    assignments: [{ machineId: current.selectedMachineId, enabled: true, priority: 100 }],
                });
                current.disableDraftPersistence?.();
                if (current.draftScope && launchDraftCurrentness) {
                    await clearSessionDraftCurrentness({
                        scope: current.draftScope,
                        address: { kind: 'newSession', draftId: current.draftId },
                        currentness: launchDraftCurrentness,
                    });
                }
                current.onLaunchUserAttemptIdChange?.(null);
                await sync.refreshAutomations();
                current.router.replace('/automations' as any);
                return;
            }

            // A retryable attempt may only be reused for the same text. The launch-intent
            // signature deliberately excludes the live composer text (it is no longer a render
            // input), so the text comparison that used to happen through the signature happens
            // here, at the only place the previous attempt's identity is actually reused.
            let restoredOperationCustody = current.persistedOperationReentry?.custody ?? null;
            const trackedOperation = current.persistedOperationReentry?.operation ?? null;
            if (trackedOperation?.state === 'succeeded') {
                const createdSessionId = readTrackedSpawnCreatedSessionId(trackedOperation);
                if (createdSessionId && restoredOperationCustody) {
                    const reconciliation = await reconcileSpawnAttemptCustodyFromOperation({
                        scope: restoredOperationCustody.scope,
                        machineId: trackedOperation.scope.machineId,
                        userAttemptId: restoredOperationCustody.userAttemptId,
                        requestId: trackedOperation.requestId ?? '',
                        outcome: { kind: 'succeeded', createdSessionId },
                    });
                    if (reconciliation.status === 'reconciled') {
                        restoredOperationCustody = reconciliation.record;
                    } else {
                        operationReentryRegistration?.markSetupNeedsAttention(createdSessionId);
                        current.setIsCreating(false);
                        return;
                    }
                } else {
                    if (createdSessionId) {
                        operationReentryRegistration?.markSetupNeedsAttention(createdSessionId);
                    }
                    current.setIsCreating(false);
                    return;
                }
            }
            const retryableLaunchAttempt = launchAttemptRef.current?.status === 'failed_retryable'
                && isNewSessionLaunchAttemptInScope(launchAttemptRef.current, launchScopeKey)
                && launchAttemptRef.current.prompt.prompt === normalizedSessionPrompt
                ? launchAttemptRef.current
                : null;
            let launchAttempt = retryableLaunchAttempt ?? createNewSessionLaunchAttempt({
                prompt: normalizedSessionPrompt,
                displayText: normalizedSessionPrompt,
                scopeKey: launchScopeKey,
                meta: null,
                attemptId: launchUserAttemptIdForCurrentIntentRef.current,
                spawnNonce: restoredOperationCustody?.nonce,
            });
            if (restoredOperationCustody) {
                launchAttempt = adoptNewSessionLaunchAttemptCustody(launchAttempt, {
                    userAttemptId: restoredOperationCustody.userAttemptId,
                    spawnNonce: restoredOperationCustody.nonce,
                    targetFingerprint: restoredOperationCustody.targetFingerprint,
                    createdSessionId: restoredOperationCustody.createdSessionId,
                    firstTurnLocalId: restoredOperationCustody.firstTurnLocalId,
                    attachmentMessageLocalId: restoredOperationCustody.attachmentMessageLocalId,
                });
            }
            if (!retryableLaunchAttempt && launchUserAttemptIdForCurrentIntentRef.current !== launchAttempt.attemptId) {
                current.onLaunchUserAttemptIdChange?.(launchAttempt.attemptId);
            }
            launchAttemptRef.current = launchAttempt;
            const launchDraftScope = Object.prototype.hasOwnProperty.call(current, 'draftScope')
                ? current.draftScope
                : getActiveNewSessionDraftScope();
            if (launchDraftScope) {
                launchDraftCurrentness = current.persistedOperationReentry
                    ? current.persistedOperationReentry.launchCurrentness
                    : readSessionDraftLaunchCurrentness({
                        scope: launchDraftScope,
                        address: { kind: 'newSession', draftId: current.draftId },
                        userAttemptId: launchAttempt.attemptId,
                    });
                if (!current.persistedOperationReentry && !launchDraftCurrentness) {
                    await current.persistDraftForLaunch?.();
                    launchDraftCurrentness = captureSessionDraftLaunchCurrentness({
                        scope: launchDraftScope,
                        address: { kind: 'newSession', draftId: current.draftId },
                        userAttemptId: launchAttempt.attemptId,
                    });
                }
            }
            if (launchDraftScope && !operationReentryRegistration) {
                operationReentryRegistration = actionOperationReentry.registerNewSession({
                    requestId: launchAttempt.spawnNonce,
                    draftScope: launchDraftScope,
                    draftId: current.draftId,
                });
                if (!operationReentryRegistration) {
                    current.setIsCreating(false);
                    return;
                }
            }

            const daemonOwnsFirstTurn = supportsSpawnPendingFirstInput(
                current.selectedMachine?.daemonState?.startedWithCliVersion,
            );
            const firstTurnMetaOverrides = mergeMessageMetaOverrides((() => {
                const agentCore = getAgentCore(current.agentType);
                if (
                    agentCore.model.supportsSelection
                    && agentCore.model.nonAcpApplyScope === 'next_prompt'
                    && current.modelMode
                    && current.modelMode !== 'default'
                ) {
                    return { model: current.modelMode };
                }

                return null;
            })(), opts?.structuredInputMetaOverrides) ?? null;
            const pendingFirstInputMeta = {
                ...(firstTurnMetaOverrides ?? {}),
                ...(profilesActive && current.selectedProfileId
                    ? { profileId: current.selectedProfileId }
                    : {}),
            };
            let daemonFirstTurnText = '';
            if (resolvedInitialMessage) {
                if (daemonOwnsFirstTurn && resolvedInitialMessage.kind === 'template') {
                    daemonFirstTurnText = (await expandPromptTemplateInvocation({
                        targetArtifactId: resolvedInitialMessage.targetArtifactId,
                        argsText: resolvedInitialMessage.rest,
                    })).trim();
                } else if (resolvedInitialMessage.kind === 'send') {
                    daemonFirstTurnText = resolvedInitialMessage.text.trim();
                }
            }
            let handedFirstTurnToDaemon = false;

            let actualPath = effectiveSelectedPath;
            let result: Awaited<ReturnType<typeof machineSpawnNewSession>>;
            let operationCustody: MachineSpawnAttemptCustody | undefined;
            let shouldPreserveLaunchAttemptForSpawnRetry = false;

            if (shouldSpawnForNewSessionLaunchAttempt(launchAttempt)) {
                launchAttempt = markNewSessionLaunchAttemptSpawning(launchAttempt);
                launchAttemptRef.current = launchAttempt;

                const checkoutResult = await materializeNewSessionCheckout({
                    machineId: current.selectedMachineId,
                    selectedPath: effectiveSelectedPath,
                    checkoutCreationDraft: current.checkoutCreationDraft,
                });

                if (!checkoutResult.success) {
                    launchAttemptRef.current = null;
                    if (checkoutResult.error === 'Not a Git repository') {
                        Modal.alert(t('common.error'), t('newSession.worktree.notGitRepo'));
                    } else {
                        Modal.alert(t('common.error'), t('newSession.worktree.failed', { error: checkoutResult.error || 'Unknown error' }));
                    }
                    current.setIsCreating(false);
                    return;
                }
                actualPath = checkoutResult.path;
                const sessionPath = checkoutResult.sessionPath.trim() || trimmedEffectiveSelectedPath;
                rollbackActualPath = actualPath;

                const spawnOptions = {
                    ...buildSpawnSessionOptionsFromAuthoringDraft({
                        draft: {
                            ...authoringDraft,
                            directory: sessionPath,
                        },
                        machineId: current.selectedMachineId,
                        serverId: resolvedTargetServerId,
                        approvedNewDirectoryCreation: true,
                        agentModeUpdatedAt: normalizedAcpModeId ? spawnPermissionModeUpdatedAt : null,
                        sourceContext: current.sourceContext ?? null,
                    }),
                    ...spawnSessionExtras,
                    spawnNonce: launchAttempt.spawnNonce,
                    userAttemptId: launchAttempt.attemptId,
                    firstTurnLocalId: launchAttempt.firstTurnLocalId,
                    attachmentMessageLocalId: launchAttempt.attachmentMessageLocalId,
                    ...(daemonFirstTurnText
                        ? {
                            pendingFirstInput: {
                                text: daemonFirstTurnText,
                                localId: launchAttempt.firstTurnLocalId,
                                ...(Object.keys(pendingFirstInputMeta).length > 0
                                    ? { meta: pendingFirstInputMeta }
                                    : {}),
                            },
                        }
                        : {}),
                };
                const releaseUserRequestLease = sync.acquireUserRequestLease();
                try {
                    result = await machineSpawnNewSession(spawnOptions);
                } finally {
                    releaseUserRequestLease();
                }
                handedFirstTurnToDaemon = result.type === 'success'
                    && daemonFirstTurnText.length > 0
                    && (
                        result.pendingFirstInputTransferred === true
                        || (result.pendingFirstInputTransferred === undefined && daemonOwnsFirstTurn)
                    );

                operationCustody = result.spawnAttemptCustody;
                if (
                    operationCustody?.status === 'unresolved'
                    || operationCustody?.status === 'completed'
                ) {
                    if (operationCustody.userAttemptId !== launchAttempt.attemptId) {
                        result = {
                            type: 'error',
                            errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                            errorMessage: t('newSession.failedToStart'),
                        };
                    } else {
                        launchAttempt = adoptNewSessionLaunchAttemptCustody(launchAttempt, {
                            userAttemptId: operationCustody.userAttemptId,
                            spawnNonce: operationCustody.spawnNonce,
                            targetFingerprint: operationCustody.targetFingerprint,
                            createdSessionId: operationCustody.createdSessionId,
                            firstTurnLocalId: operationCustody.firstTurnLocalId,
                            attachmentMessageLocalId: operationCustody.attachmentMessageLocalId,
                        });
                        launchAttemptRef.current = launchAttempt;
                    }
                }
                if (
                    result.type === 'error'
                    && (
                        result.errorCode === SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT
                        || operationCustody?.status === 'unresolved'
                    )
                ) {
                    shouldPreserveLaunchAttemptForSpawnRetry = true;
                }
            } else {
                const retrySessionId = launchAttempt.createdSessionId;
                if (!retrySessionId) {
                    throw new Error('Cannot resume a new-session launch attempt without a created session id.');
                }
                result = {
                    type: 'success',
                    sessionId: retrySessionId,
                };
                if (launchAttempt.spawnTargetFingerprint) {
                    operationCustody = {
                        status: 'completed',
                        userAttemptId: launchAttempt.attemptId,
                        spawnNonce: launchAttempt.spawnNonce,
                        targetFingerprint: launchAttempt.spawnTargetFingerprint,
                        createdSessionId: retrySessionId,
                        firstTurnLocalId: launchAttempt.firstTurnLocalId,
                        attachmentMessageLocalId: launchAttempt.attachmentMessageLocalId,
                    };
                }
            }

            const rollbackSpawnArtifacts = async (): Promise<string | null> => {
                try {
                    await rollbackNewSessionArtifacts({
                        machineId: current.selectedMachineId!,
                        selectedPath: effectiveSelectedPath,
                        actualPath,
                        checkoutCreationDraft: current.checkoutCreationDraft,
                        serverId: resolvedTargetServerId,
                        machineBash,
                    });
                    return null;
                } catch (error) {
                    return error instanceof Error ? error.message : 'Failed to clean up created worktree artifacts';
                }
            };

            if (result.type === 'success' && result.sessionId) {
                confirmedCreatedSessionId = result.sessionId;
                // Session custody is now authoritative. The checkout belongs to
                // that session and must not be rolled back by a later UI-only
                // follow-up or navigation failure.
                rollbackActualPath = null;
                if (launchAttempt.createdSessionId !== result.sessionId) {
                    launchAttempt = markNewSessionLaunchAttemptCreated(launchAttempt, {
                        createdSessionId: result.sessionId,
                    });
                    launchAttemptRef.current = launchAttempt;
                }
                if (!isLaunchScopeStillActive()) {
                    operationReentryRegistration?.markSetupNeedsAttention(result.sessionId);
                    launchAttemptRef.current = null;
                    current.setIsCreating(false);
                    return;
                }
                let postSpawnFollowUpError: unknown = null;
                let postSpawnFollowUpRetry: (() => Promise<void>) | null = null;
                let suppressPostSpawnFollowUpAlert = false;
                let postSpawnFailurePhase: 'sending_first_turn' | 'uploading_attachments' = 'sending_first_turn';
                let preserveLaunchAttemptForFirstTurnRetry = false;
                let initialMessageText = '';
                let postSpawnSessionRouteSuffix = '';
                let postSpawnReplacementHref: string | null = null;
                const createdSessionId = result.sessionId;
                const shouldRunBuiltInPostSpawnFollowUp = !retryableLaunchAttempt?.phaseErrors.uploading_attachments;

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
                        postSpawnFollowUpError = error;
                        postSpawnFailurePhase = 'uploading_attachments';
                        postSpawnFollowUpRetry = runAfterCreatedFollowUp;
                        throw error;
                    }
                };

                const runBuiltInPostSpawnFollowUp = async (): Promise<void> => {
                    launchAttempt = markNewSessionLaunchAttemptSendingFirstTurn(launchAttempt);
                    launchAttemptRef.current = launchAttempt;

                    if (!handedFirstTurnToDaemon && resolvedInitialMessage) {
                        if (resolvedInitialMessage.kind === 'template') {
                            initialMessageText = await expandPromptTemplateInvocation({
                                targetArtifactId: resolvedInitialMessage.targetArtifactId,
                                argsText: resolvedInitialMessage.rest,
                            });
                        } else if (resolvedInitialMessage.kind === 'send') {
                            initialMessageText = resolvedInitialMessage.text;
                        } else if (resolvedInitialMessage.kind === 'noop') {
                            initialMessageText = '';
                        } else {
                            initialMessageText = '';
                        }
                    }

                    if (!handedFirstTurnToDaemon) {
                        await followUpSpawnedSessionWithServerScope({
                            sessionId: createdSessionId,
                            targetServerId: resolvedTargetServerId,
                            initialMessageText,
                            messageLocalId: launchAttempt.firstTurnLocalId,
                            metaOverrides: firstTurnMetaOverrides,
                            profileId: profilesActive ? (current.selectedProfileId ?? '') : null,
                        });
                    }

                    if (
                        resolvedInitialMessage
                        && (resolvedInitialMessage.kind === 'action' || resolvedInitialMessage.kind === 'goal')
                    ) {
                        const actionExecutor = createDefaultActionExecutor({
                            resolveServerIdForSessionId: (sessionId) => {
                                if (sessionId === createdSessionId && resolvedTargetServerId) {
                                    return resolvedTargetServerId;
                                }
                                return resolveServerIdForSessionIdFromLocalCache(sessionId);
                            },
                            openSession: (sessionId) => {
                                if (sessionId === createdSessionId) {
                                    postSpawnReplacementHref = buildScopedSessionRouteHref({
                                        sessionId,
                                        serverId: resolvedTargetServerId,
                                    });
                                }
                            },
                        });

                        await executeSessionComposerResolution({
                            resolved: resolvedInitialMessage,
                            sessionId: createdSessionId,
                            agentId: current.agentType,
                            backendTarget: current.backendTarget ?? null,
                            permissionMode: current.permissionMode,
                            actionExecutor,
                            previousMessage: sessionPromptText,
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

                if (shouldRunBuiltInPostSpawnFollowUp) {
                    try {
                        await runBuiltInPostSpawnFollowUp();
                    } catch (error) {
                        postSpawnFollowUpError = error;
                        postSpawnFailurePhase = 'sending_first_turn';
                        postSpawnFollowUpRetry = async () => {
                            await runBuiltInPostSpawnFollowUp();
                            await runAfterCreatedFollowUp();
                        };
                    }
                }

                storage.getState().updateSessionPermissionMode(result.sessionId, current.permissionMode);
                if (getAgentCore(current.agentType).model.supportsSelection && current.modelMode && current.modelMode !== 'default') {
                    storage.getState().updateSessionModelMode(result.sessionId, current.modelMode);
                }

                // Seed the session's model list from the wizard probe. Providers without a static
                // catalog publish `sessionModelsV1` only once their runtime starts (first prompt),
                // so without this seed the in-session model picker offers nothing but the current
                // model, "Use CLI settings", and freeform custom until then. Best-effort and
                // seed-only: the runtime publish stays authoritative, a lost race is a no-op, and
                // a failed seed merely leaves the picker as it is today.
                const preflightModelsForSeed = current.preflightModels;
                const agentModelConfig = getAgentCore(current.agentType).model;
                // `getModelOptionsForAgentType` always includes the `default` pseudo-entry, so
                // "no option besides default" is exactly "no curated static catalog" — the
                // agents whose picker would otherwise be empty until the runtime publishes.
                const hasCuratedStaticModels = getModelOptionsForAgentType(current.agentType)
                    .some((option) => option.value !== 'default');
                if (
                    preflightModelsForSeed
                    && preflightModelsForSeed.availableModels.length > 0
                    && backendTarget.kind === 'builtInAgent'
                    && agentModelConfig.supportsSelection === true
                    && agentModelConfig.dynamicProbe !== 'static-only'
                    && !hasCuratedStaticModels
                ) {
                    fireAndForget(sync.publishSessionModelsSeedToMetadata({
                        sessionId: createdSessionId,
                        serverId: resolvedTargetServerId,
                        agentId: current.agentType,
                        currentModelId: spawnModelId ?? 'default',
                        availableModels: preflightModelsForSeed.availableModels,
                        updatedAt: spawnPermissionModeUpdatedAt,
                    }), {
                        tag: 'new-session-model-list-seed',
                        onError: captureExceptionIfEnabled,
                    });
                }

                if (!postSpawnFollowUpError && opts?.afterCreated) {
                    try {
                        await runAfterCreatedFollowUp();
                    } catch (error) {
                        postSpawnFollowUpError = error;
                    }
                }

                const retryFailurePhaseByAttemptPhase = {
                    uploading_attachments: 'upload',
                    sending_first_turn: 'send',
                } as const;
                const classifyCurrentPostSpawnFailure = (failure: unknown) => classifyLaunchRetryFailure({
                    phase: retryFailurePhaseByAttemptPhase[postSpawnFailurePhase],
                    failure,
                });

                while (
                    postSpawnFollowUpError
                    && postSpawnFollowUpRetry
                    && isDaemonUnavailableAlertError(postSpawnFollowUpError)
                    && classifyCurrentPostSpawnFailure(postSpawnFollowUpError).kind === 'retryable'
                ) {
                    current.setIsCreating(false);
                    const retryResolution = await promptDaemonUnavailableRetry({
                        titleKey: 'newSession.daemonRpcUnavailableTitle',
                        bodyKey: 'newSession.daemonRpcUnavailableBody',
                        machine: current.selectedMachine,
                    });
                    suppressPostSpawnFollowUpAlert = true;

                    if (retryResolution !== 'retry' || !mountedRef.current) {
                        break;
                    }

                    if (!isLaunchScopeStillActive()) {
                        operationReentryRegistration?.markSetupNeedsAttention(createdSessionId);
                        launchAttemptRef.current = null;
                        current.setIsCreating(false);
                        return;
                    }

                    current.setIsCreating(true);
                    try {
                        await postSpawnFollowUpRetry();
                        postSpawnFollowUpError = null;
                        postSpawnFollowUpRetry = null;
                    } catch (error) {
                        suppressPostSpawnFollowUpAlert = false;
                        postSpawnFollowUpError = error;
                    }
                }

                if (!isLaunchScopeStillActive()) {
                    operationReentryRegistration?.markSetupNeedsAttention(createdSessionId);
                    launchAttemptRef.current = null;
                    current.setIsCreating(false);
                    return;
                }

                if (
                    postSpawnFollowUpError
                    && postSpawnFailurePhase === 'sending_first_turn'
                    && isFirstTurnFollowUpTimeout(postSpawnFollowUpError)
                ) {
                    launchAttempt = markNewSessionLaunchAttemptFailed(launchAttempt, {
                        phase: postSpawnFailurePhase,
                        error: postSpawnFollowUpError,
                        retryable: true,
                    });
                    launchAttemptRef.current = launchAttempt;
                    postSpawnFollowUpError = null;
                    postSpawnFollowUpRetry = null;
                    suppressPostSpawnFollowUpAlert = true;
                    preserveLaunchAttemptForFirstTurnRetry = true;
                }

                if (postSpawnFollowUpError) {
                    operationReentryRegistration?.markSetupNeedsAttention(createdSessionId);
                    const retryFailureClassification = classifyCurrentPostSpawnFailure(postSpawnFollowUpError);
                    launchAttempt = markNewSessionLaunchAttemptFailed(launchAttempt, {
                        phase: postSpawnFailurePhase,
                        error: postSpawnFollowUpError,
                        retryable: retryFailureClassification.kind === 'retryable',
                    });
                    launchAttemptRef.current = launchAttempt;

                    if (!suppressPostSpawnFollowUpAlert) {
                        const followUpDetail = postSpawnFollowUpError instanceof Error
                            ? postSpawnFollowUpError.message
                            : t('common.error');
                        Modal.alert(
                            t('newSession.createdWithSetupIssueTitle'),
                            `${t('newSession.createdWithSetupIssueBody')}\n\n${t('common.details')}: ${followUpDetail}`,
                        );
                    }

                    current.setIsCreating(false);
                    return;
                }

                if (!preserveLaunchAttemptForFirstTurnRetry) {
                    launchAttempt = markNewSessionLaunchAttemptComplete(launchAttempt);
                }

                await requireSpawnedSessionVisibleForRoute({
                    sessionId: createdSessionId,
                    serverId: resolvedTargetServerId,
                    getStoredSession: (sessionId) => storage.getState().sessions[sessionId] ?? null,
                    ensureSessionVisibleForMessageRoute: sync.ensureSessionVisibleForMessageRoute,
                });

                const firstTurnTextForRoute = handedFirstTurnToDaemon
                    ? daemonFirstTurnText
                    : initialMessageText.trim();
                if (firstTurnTextForRoute && !preserveLaunchAttemptForFirstTurnRetry) {
                    const state = storage.getState();
                    const session = state.sessions[createdSessionId] ?? null;
                    if (session) {
                        state.markSessionOptimisticThinking(createdSessionId);
                    }
                    projectLocalOutboundUserMessage({
                        sessionId: createdSessionId,
                        localId: launchAttempt.firstTurnLocalId,
                        text: firstTurnTextForRoute,
                        displayText: firstTurnTextForRoute,
                        rawRecord: buildOutgoingUserTextRecord({
                            text: firstTurnTextForRoute,
                            sentFrom: resolveSentFrom(),
                            displayText: firstTurnTextForRoute,
                            agentId: current.agentType,
                            modelMode: current.modelMode,
                            permissionMode: current.permissionMode,
                            settings: state.settings,
                            session,
                            metaOverrides: pendingFirstInputMeta,
                        }),
                        deliveryStatus: 'accepted',
                    });
                }

                const sessionRoute = buildScopedSessionRouteHref({
                    sessionId: createdSessionId,
                    serverId: resolvedTargetServerId,
                    suffix: postSpawnSessionRouteSuffix,
                });

                current.router.replace(postSpawnReplacementHref ?? sessionRoute, {
                    dangerouslySingular() {
                        return 'session';
                    },
                });

                if (!preserveLaunchAttemptForFirstTurnRetry) {
                    if (operationCustody?.status === 'completed') {
                        await completeMachineSpawnAttemptCustody({
                            machineId: current.selectedMachineId,
                            serverId: resolvedTargetServerId,
                            custody: operationCustody,
                        });
                    }
                    launchAttemptRef.current = null;
                    current.disableDraftPersistence?.();
                    if (launchDraftScope && launchDraftCurrentness) {
                        await clearSessionDraftCurrentness({
                            scope: launchDraftScope,
                            address: { kind: 'newSession', draftId: current.draftId },
                            currentness: launchDraftCurrentness,
                        });
                    }
                    if (launchDraftScope) {
                        clearSessionDraftLaunchCurrentness({
                            scope: launchDraftScope,
                            address: { kind: 'newSession', draftId: current.draftId },
                            userAttemptId: launchAttempt.attemptId,
                        });
                    }
                    current.onLaunchUserAttemptIdChange?.(null);
                    operationReentryRegistration?.markWorkflowComplete(createdSessionId);
                }
                const persistedPresentedOperation = current.persistedOperationReentry?.operation;
                const presentedOperation = persistedPresentedOperation?.state === 'succeeded'
                    && readTrackedSpawnCreatedSessionId(persistedPresentedOperation) === createdSessionId
                    ? persistedPresentedOperation
                    : findPresentedSpawnOperation({
                        accountId: current.draftScope?.accountId,
                        machineId: current.selectedMachineId,
                        requestId: launchAttempt.spawnNonce,
                        sessionId: createdSessionId,
                    });
                if (presentedOperation) {
                    acknowledgeActionOperationPresented(presentedOperation);
                }
            } else if (result.type === 'requestToApproveDirectoryCreation') {
                launchAttemptRef.current = null;
                const rollbackErrorMessage = await rollbackSpawnArtifacts();
                const rollbackDetail = rollbackErrorMessage ? `\n\n${t('common.details')}: ${rollbackErrorMessage}` : '';
                Modal.alert(t('common.error'), `${t('newSession.failedToStart')}${rollbackDetail}`);
                current.setIsCreating(false);
            } else if (result.type === 'error') {
                if (
                    shouldPreserveLaunchAttemptForSpawnRetry
                    && result.errorCode === SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT
                ) {
                    launchAttempt = markNewSessionLaunchAttemptFailed(launchAttempt, {
                        phase: 'spawning',
                        error: result.errorMessage,
                        retryable: true,
                    });
                    launchAttemptRef.current = launchAttempt;
                    current.setIsCreating(false);
                    showDaemonUnavailableAlert({
                        titleKey: 'newSession.launchStillPendingTitle',
                        bodyKey: 'newSession.launchStillPendingBody',
                        machine: current.selectedMachine,
                        onRetry: () => {
                            void handleCreateSession(opts);
                        },
                        shouldContinue: () => mountedRef.current,
                    });
                    return;
                }

                launchAttemptRef.current = null;
                const rollbackErrorMessage = await rollbackSpawnArtifacts();
                if (result.spawnAttemptCustody?.status === 'corrupt') {
                    const shouldReset = await Modal.confirm(
                        t('common.error'),
                        result.errorMessage,
                        {
                            cancelText: t('common.cancel'),
                            confirmText: t('common.reset'),
                        },
                    );
                    if (shouldReset) {
                        await resetMachineSpawnAttemptCustody({ serverId: resolvedTargetServerId });
                    }
                    current.setIsCreating(false);
                    return;
                }
                // D2: a connected-service auth switch fail-closed because the resumed session could not
                // be carried over under the new account. Recognize the STRUCTURED detail (never parse
                // the message), explain WHY, and offer "start fresh under the new account".
                const switchUnavailable = resolveConnectedServiceSwitchUnavailablePresentation(result);
                if (switchUnavailable) {
                    current.setIsCreating(false);
                    const startFreshAction = switchUnavailable.actions.find((action) => action.kind === 'start_fresh');
                    const diagnosticBody = translateConnectedServiceUxDiagnosticBody({
                        presentation: switchUnavailable,
                        translate: t,
                    });
                    Modal.alert(
                        t(switchUnavailable.titleKey),
                        diagnosticBody,
                        [
                            ...(startFreshAction
                                ? [{
                                    text: t(startFreshAction.labelKey),
                                    onPress: () => {
                                        if (!mountedRef.current) return;
                                        // Start fresh under the new account: relaunch the session WITHOUT
                                        // resume continuity so the new account begins a clean conversation.
                                        void handleCreateSession({ ...opts, startFreshUnderNewAccount: true });
                                    },
                                }]
                                : []),
                            { text: t('common.cancel'), style: 'cancel' as const },
                        ],
                    );
                    return;
                }
                if (result.errorCode === SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE) {
                    current.setIsCreating(false);
                    showDaemonUnavailableAlert({
                        titleKey: 'newSession.daemonRpcUnavailableTitle',
                        bodyKey: 'newSession.daemonRpcUnavailableBody',
                        machine: current.selectedMachine,
                        onRetry: () => {
                            void handleCreateSession(opts);
                        },
                        shouldContinue: () => mountedRef.current,
                    });
                    return;
                }
                const extraDetail = (() => {
                    switch (result.errorCode) {
                        case SPAWN_SESSION_ERROR_CODES.RESUME_NOT_SUPPORTED:
                            return 'Resume is not supported for this agent on this machine.';
                        case SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK:
                            return 'The agent process exited before it could connect. Check that the agent CLI is installed and available to the daemon (PATH).';
                        case SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT:
                            return 'Session startup timed out. The machine may be slow or the agent CLI may be stuck starting.';
                        default:
                            return null;
                    }
                })();
                const detail = extraDetail ? `\n\n${t('common.details')}: ${extraDetail}` : '';
                const rollbackDetail = rollbackErrorMessage ? `\n\n${t('common.details')}: ${rollbackErrorMessage}` : '';
                Modal.alert(t('common.error'), `${result.errorMessage}${detail}${rollbackDetail}`);
                current.setIsCreating(false);
            } else {
                throw new Error('Session spawning failed - no session ID returned.');
            }
        } catch (error) {
            const currentDraftScope = Object.prototype.hasOwnProperty.call(current, 'draftScope')
                ? current.draftScope ?? null
                : getActiveNewSessionDraftScope();
            const currentDraftSnapshot = currentDraftScope
                ? getSessionDraftSnapshot(currentDraftScope, { kind: 'newSession', draftId: current.draftId })
                : null;
            const currentTrackedReentry = current.persistedOperationReentry ?? resolvePersistedNewSessionOperationIdentity({
                draftScope: currentDraftScope,
                draftId: current.draftId,
                draft: currentDraftSnapshot?.localSupplement
                    ?? (current.launchUserAttemptId ? { launchUserAttemptId: current.launchUserAttemptId } : null),
                operations: actionOperationStore.getState().operationsById.values(),
            });
            if (
                !confirmedCreatedSessionId
                && currentTrackedReentry
                && currentTrackedReentry.operation.state !== 'failed'
                && currentTrackedReentry.operation.state !== 'cancelled'
                && isDetachedTrackedSpawnTransportError(error)
            ) {
                rollbackActualPath = null;
                latestParamsRef.current.setIsCreating(false);
                return;
            }
            if (rollbackActualPath) {
                try {
                    await rollbackNewSessionArtifacts({
                        machineId: current.selectedMachineId,
                        selectedPath: effectiveSelectedPath,
                        actualPath: rollbackActualPath,
                        checkoutCreationDraft: current.checkoutCreationDraft,
                        serverId: rollbackServerId,
                        machineBash,
                    });
                } catch (rollbackError) {
                    captureExceptionIfEnabled(rollbackError, {
                        tags: {
                            area: 'new_session',
                            action: 'rollback_artifacts',
                        },
                        extra: {
                            phase: 'rollback_artifacts',
                            machineId: current.selectedMachineId,
                            selectedPath: effectiveSelectedPath,
                            actualPath: rollbackActualPath,
                        },
                    });
                }
            }
            captureExceptionIfEnabled(error, {
                tags: {
                    area: 'new_session',
                    action: 'create_session',
                },
                extra: {
                    phase: 'create_session',
                    machineId: current.selectedMachineId,
                    selectedPath: effectiveSelectedPath,
                    hadRollbackPath: rollbackActualPath !== null,
                },
            });
            let errorMessage = error instanceof Error
                ? error.message
                : 'Failed to start session. Make sure the daemon is running on the target machine.';
            if (error instanceof Error) {
                if (error.message.includes('timeout')) {
                    errorMessage = 'Session startup timed out. The machine may be slow or the daemon may not be responding.';
                } else if (error.message.includes('Socket not connected')) {
                    errorMessage = 'Not connected to server. Check your internet connection.';
                }
            }
            if (confirmedCreatedSessionId) {
                operationReentryRegistration?.markSetupNeedsAttention(confirmedCreatedSessionId);
                Modal.alert(
                    t('newSession.createdWithSetupIssueTitle'),
                    `${t('newSession.createdWithSetupIssueBody')}\n\n${t('common.details')}: ${errorMessage}`,
                );
            } else {
                Modal.alert(t('common.error'), errorMessage);
            }
            latestParamsRef.current.setIsCreating(false);
        } finally {
            createInFlightRef.current = false;
            operationReentryRegistration?.release();
        }
    }, [applySettings, mountedRef]);

    React.useEffect(() => {
        const reentry = params.persistedOperationReentry;
        const operation = reentry?.operation;
        if (!reentry || !operation) return;
        if (operation.state === 'accepted' || operation.state === 'running') return;
        if (operation.state === 'succeeded') return;
        const revisionKey = `${operation.operationId}:${operation.revision}`;
        if (handledTerminalReentryRevisionRef.current === revisionKey) return;
        if (createInFlightRef.current) return;
        if (!actionOperationReentry.canAutomaticallyReenterNewSession(operation)) return;
        const workflowClaim = actionOperationReentry.registerNewSession({
            requestId: reentry.custody.nonce,
            draftScope: reentry.custody.scope,
            draftId: params.draftId,
        });
        if (!workflowClaim) return;
        handledTerminalReentryRevisionRef.current = revisionKey;

        void reconcileSpawnAttemptCustodyFromOperation({
            scope: reentry.custody.scope,
            machineId: reentry.custody.machineId,
            userAttemptId: reentry.custody.userAttemptId,
            requestId: operation.requestId ?? '',
            outcome: { kind: operation.state },
        }).finally(() => {
            latestParamsRef.current.setIsCreating(false);
            workflowClaim.release();
        });
    }, [handleCreateSession, operationReentryRevision, params.persistedOperationReentry]);

    const terminalSuccessOperation = params.persistedOperationReentry?.operation.state === 'succeeded'
        ? params.persistedOperationReentry.operation
        : null;
    const resumePersistedLaunchKey = terminalSuccessOperation
        && actionOperationReentry.canAutomaticallyReenterNewSession(terminalSuccessOperation)
        ? `${terminalSuccessOperation.operationId}:${terminalSuccessOperation.revision}`
        : null;

    return { handleCreateSession, resumePersistedLaunchKey };
}
