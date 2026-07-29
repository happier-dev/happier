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
} from '@/sync/ops';
import { resolveTerminalSpawnOptions } from '@/sync/domains/settings/terminalSettings';
import { CREATED_SESSION_NOT_AVAILABLE_LOCALLY_ERROR } from '@/sync/runtime/sessionMessageDeliveryErrors';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveNewSessionServerTarget } from '@/sync/domains/server/selection/serverSelectionResolver';
import { getMissingRequiredConfigEnvVarNames } from '@/utils/profiles/profileConfigRequirements';
import { getSecretSatisfaction } from '@/utils/secrets/secretSatisfaction';
import type { SecretChoiceByProfileIdByEnvVarName } from '@/utils/secrets/secretRequirementApply';
import { clearNewSessionDraft, saveSessionDrafts } from '@/sync/domains/state/persistence';
import { getBuiltInProfile } from '@/sync/domains/profiles/profileUtils';
import { isProfileCompatibleWithBackendTarget, type AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import type { Settings } from '@/sync/domains/settings/settings';
import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { resolveEffectiveWindowsRemoteSessionLaunchMode } from '@/sync/domains/session/spawn/windowsRemoteSessionLaunchMode';
import { DEFAULT_AGENT_ID, getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { buildLastUsedBackendTargetSettings } from '@/agents/backendCatalog/buildLastUsedBackendTargetSettings';
import { isAgentId } from '@/agents/catalog/catalog';
import { buildSpawnEnvironmentVariablesFromUiState, buildSpawnSessionExtrasFromUiState, getAgentResumeExperimentsFromSettings, getNewSessionPreflightIssues } from '@/agents/catalog/catalog';
import { transformProfileToEnvironmentVars } from '@/components/sessions/new/modules/profileHelpers';
import type { UseMachineEnvPresenceResult } from '@/hooks/machine/useMachineEnvPresence';
import { getMachineCapabilitiesSnapshot } from '@/hooks/server/useMachineCapabilitiesCache';
import type { PermissionMode, ModelMode } from '@/sync/domains/permissions/permissionTypes';
import {
    SPAWN_SESSION_ERROR_DETAIL_KINDS,
    SPAWN_SESSION_ERROR_CODES,
    type BackendTargetRefV2,
    type BackendTargetRefV2Input,
    type ProviderErrorV1,
    type WindowsRemoteSessionLaunchMode,
} from '@happier-dev/protocol';
import type { AcpConfigOptionOverridesV1 } from '@happier-dev/protocol';
import { parsePermissionIntentAlias } from '@happier-dev/agents';
import type { CodexBackendMode } from '@happier-dev/protocol';
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
    showDaemonUnavailableAlert,
} from '@/utils/errors/daemonUnavailableAlert';
import { captureExceptionIfEnabled } from '@/utils/system/sentry';
import { useMountedRef } from '@/hooks/ui/useMountedRef';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import type { SessionMcpSelectionV1 } from '@happier-dev/protocol';
import type { NewSessionCheckoutCreationDraft } from '@/sync/domains/state/newSessionCheckoutDraft';
import { materializeNewSessionCheckout } from '@/components/sessions/new/modules/materializeNewSessionCheckout';
import { rollbackNewSessionArtifacts } from '@/components/sessions/new/modules/rollbackNewSessionArtifacts';
import { resolveConnectedServiceSwitchUnavailablePresentation } from '@/components/sessions/new/modules/connectedServiceSwitchUnavailable';
import { resolveNewSessionCompatAgentType } from '@/components/sessions/new/modules/resolveNewSessionCompatAgentType';
import {
    buildNewSessionLaunchScopeKey,
    normalizeLaunchScopePart,
} from '@/components/sessions/new/modules/newSessionLaunchScope';
import {
    followUpSpawnedSessionWithServerScope,
} from '@/sync/runtime/orchestration/serverScopedRpc/followUpSpawnedSession';
import {
    isCreatedSessionUnavailableLocally,
    requireLocalSessionVisibleForRoute,
} from '@/sync/runtime/orchestration/serverScopedRpc/localSessionRouteReadiness';
import {
    buildOutgoingUserTextRecord,
    projectLocalOutboundUserMessage,
} from '@/sync/domains/messages/outgoingUserMessage';
import { resolveSpawnedFirstPromptFollowUp } from '@/sync/domains/session/spawn/spawnedFirstPromptFollowUp';
import { resolveServerIdForSessionIdFromLocalCache } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';
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

function getActiveNewSessionDraftScope() {
    return storage.getState().profileScope ?? null;
}

function clearNewSessionDraftForLaunchParams(params: Readonly<{
    draftScope?: ServerAccountScope | null;
}>): void {
    const hasExplicitDraftScope = Object.prototype.hasOwnProperty.call(params, 'draftScope');
    const scope = hasExplicitDraftScope ? params.draftScope : getActiveNewSessionDraftScope();
    if (scope) {
        clearNewSessionDraft(scope);
        return;
    }
    clearNewSessionDraft();
}

function isSessionHydratedForDraftRestore(sessionId: string): boolean {
    return Boolean(storage.getState().sessions[sessionId]);
}

function preserveCreatedSessionDraft(params: Readonly<{
    sessionId: string;
    draftText: string;
}>): void {
    const draftText = params.draftText.trim();
    if (!draftText) {
        return;
    }
    saveSessionDrafts({ [params.sessionId]: draftText });
    if (isSessionHydratedForDraftRestore(params.sessionId)) {
        storage.getState().updateSessionDraft(params.sessionId, draftText);
    }
}

function readRecoverableCreatedSessionDraftText(error: unknown): string | null {
    if (!(error instanceof Error)) {
        return null;
    }
    const payload = (error as Error & {
        recoverableFollowUpPayload?: {
            draftText?: unknown;
        };
    }).recoverableFollowUpPayload;
    return typeof payload?.draftText === 'string' && payload.draftText.trim()
        ? payload.draftText
        : null;
}

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
    afterCreated?: (context: CreatedSessionFollowUpContext) => void | Promise<void>;
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
    agentType: AgentId;
    backendTarget?: BackendTargetRefV2;
    spawnBackendTarget?: BackendTargetRefV2Input;
    useProfiles: boolean;
    selectedProfileId: string | null;
    authoringDraft?: SessionAuthoringDraft | null;
    modelMode: ModelMode;
}>;

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

    agentType: AgentId;
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

    sessionPrompt: string;
    setSessionPrompt?: (prompt: string) => void;
    resumeSessionId: string;
    agentNewSessionOptions?: Record<string, unknown> | null;
    authoringDraft?: SessionAuthoringDraft | null;
    authoringCommitPending?: boolean;
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
    disableDraftPersistence?: () => void;
    onLaunchAttemptChange?: (attempt: NewSessionLaunchAttempt | null) => void;
    launchIntentSignature: string;
    launchUserAttemptId?: string | null;
    onLaunchUserAttemptIdChange?: (userAttemptId: string | null) => void;
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
        if (createInFlightRef.current) return;
        const current = latestParamsRef.current;
        if (current.authoringCommitPending === true) return;
        const requestedPath = typeof current.getRequestedPath === 'function'
            ? current.getRequestedPath()
            : current.selectedPath;
        const effectiveSelectedPath = (typeof requestedPath === 'string'
            ? requestedPath
            : current.selectedPath).trim();
        let rollbackActualPath: string | null = null;
        let rollbackServerId: string | null = current.targetServerId ?? null;
        const isRepoNativeWorktreeLaunch = current.checkoutCreationDraft?.kind === 'git_worktree';

        if (!current.selectedMachineId) {
            Modal.alert(t('common.error'), t('newSession.noMachineSelected'));
            return;
        }
        if (effectiveSelectedPath.length === 0) {
            Modal.alert(t('common.error'), t('newSession.noPathSelected'));
            return;
        }

        lastCreateOptionsRef.current = opts;
        setProviderLaunchFailure(null);
        createInFlightRef.current = true;
        current.setIsCreating(true);

        try {
            const resolvedTargetServerId = resolveNewSessionLaunchTargetServerId(current);
            rollbackServerId = resolvedTargetServerId;
            const launchScopeKey = buildNewSessionLaunchScopeKey({
                machineId: current.selectedMachineId,
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
            const isLaunchScopeStillActive = (): boolean => resolveCurrentLaunchScopeKey() === launchScopeKey;

            const sessionPrompt = opts?.inputTextOverride ?? current.sessionPrompt;
            const shouldSendInitialMessage = (opts?.initialMessage ?? 'send') !== 'skip';
            const shouldPrepareInitialMessage = shouldSendInitialMessage && sessionPrompt.trim();
            const resolvedInitialMessage = shouldPrepareInitialMessage
                ? resolveSessionComposerSend({
                    input: sessionPrompt,
                    executionRunsEnabled: current.executionRunsEnabled === true,
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

            const updatedPaths = [
                { machineId: current.selectedMachineId, path: effectiveSelectedPath },
                ...current.recentMachinePaths.filter((rp) => (
                    rp.machineId !== current.selectedMachineId || rp.path !== effectiveSelectedPath
                )),
            ].slice(0, 10);
            const profilesActive = current.useProfiles;
            const canonicalAgentId = resolveNewSessionCompatAgentType({
                backendTarget: current.backendTarget ?? null,
                persistedAgentId: current.settings.lastUsedAgent,
                selectedBuiltInAgentId: isAgentId(current.agentType) ? current.agentType : DEFAULT_AGENT_ID,
            });
            const settingsUpdate: MutableSettingsDelta = {
                recentMachinePaths: updatedPaths,
            };
            if (current.backendTarget) {
                Object.assign(settingsUpdate, buildLastUsedBackendTargetSettings({
                    backendTarget: current.backendTarget,
                    selectedBuiltInAgentId: canonicalAgentId,
                }));
            }
            if (profilesActive) {
                settingsUpdate.lastUsedProfile = current.selectedProfileId;
            }
            applySettings(settingsUpdate);

            const backendTarget: BackendTargetRefV2 = current.backendTarget ?? { kind: 'backend', backendId: canonicalAgentId };
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
                agentId: canonicalAgentId,
                settings: current.settings,
                environmentVariables,
                newSessionOptions: {
                    ...(current.agentNewSessionOptions ?? {}),
                    targetServerId: resolvedTargetServerId,
                },
            });
            const connectedServices = (current.agentNewSessionOptions as any)?.connectedServices;

            const terminal = resolveTerminalSpawnOptions({
                settings: storage.getState().settings,
                machineId: current.selectedMachineId,
            });

            const machineCapsSnapshot = getMachineCapabilitiesSnapshot(current.selectedMachineId, resolvedTargetServerId);
            const machineCapsResults = machineCapsSnapshot?.response.results as any;
            const experiments = getAgentResumeExperimentsFromSettings(canonicalAgentId, current.settings);
            const preflightIssues = getNewSessionPreflightIssues({
                agentId: canonicalAgentId,
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
            const normalizedAcpModeId = typeof current.acpSessionModeId === 'string' ? current.acpSessionModeId.trim() : '';
            const spawnModelId =
                getAgentCore(canonicalAgentId).model.supportsSelection === true &&
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
            const initialMessageMetaOverrides = (() => {
                const agentCore = getAgentCore(canonicalAgentId);
                const selectedModelId = spawnModelSelection?.ref.modelId ?? null;
                if (
                    selectedModelId
                    && agentCore.model.nonAcpApplyScope === 'next_prompt'
                ) {
                    // Some providers only apply model overrides when processing a user prompt.
                    // Keep those first turns on the message-send path so the override is attached.
                    return { model: selectedModelId };
                }

                return null;
            })();
            const windowsRemoteSessionLaunchMode = resolveEffectiveWindowsRemoteSessionLaunchMode({
                machineMetadata: current.selectedMachine?.metadata,
                settings: current.settings,
                sessionOverride: current.windowsRemoteSessionLaunchModeOverride ?? undefined,
            }).mode;
            const windowsTerminalWindowName = typeof current.settings.sessionWindowsTerminalWindowName === 'string'
                ? current.settings.sessionWindowsTerminalWindowName.trim()
                : '';
            const normalizedSessionPrompt = sessionPrompt.trim();
            const spawnSessionExtras = buildSpawnSessionExtrasFromUiState({
                agentId: canonicalAgentId,
                settings: current.settings,
                resumeSessionId: current.resumeSessionId,
                newSessionOptions: current.agentNewSessionOptions,
                sessionConfigOptionOverrides: current.sessionConfigOptionOverrides,
                updatedAt: spawnPermissionModeUpdatedAt,
            });
            const authoringDraft = buildNewSessionAuthoringDraftFromResolvedInputs({
                directory: effectiveSelectedPath,
                checkoutCreationDraft: current.checkoutCreationDraft ?? null,
                prompt: normalizedSessionPrompt,
                displayText: normalizedSessionPrompt,
                agentId: canonicalAgentId,
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

            if (activeAutomationDraft?.enabled === true) {
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
                    clearNewSessionDraftForLaunchParams(current);
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
                clearNewSessionDraftForLaunchParams(current);
                await sync.refreshAutomations();
                current.router.replace('/automations' as any);
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
            publishLaunchAttempt(launchAttempt);
            let actualPath = effectiveSelectedPath;
            let result: Awaited<ReturnType<typeof machineSpawnNewSession>> | null = null;
            let shouldPreserveLaunchAttemptForSpawnRetry = false;

            if (!result && shouldSpawnForNewSessionLaunchAttempt(launchAttempt)) {
                launchAttempt = markNewSessionLaunchAttemptSpawning(launchAttempt);
                publishLaunchAttempt(launchAttempt);
                const checkoutResult = await materializeNewSessionCheckout({
                    machineId: current.selectedMachineId,
                    selectedPath: effectiveSelectedPath,
                    checkoutCreationDraft: current.checkoutCreationDraft,
                    serverId: resolvedTargetServerId,
                });

                if (!checkoutResult.success) {
                    publishLaunchAttempt(null);
                    if (checkoutResult.error === 'Not a Git repository') {
                        Modal.alert(t('common.error'), t('newSession.worktree.notGitRepo'));
                    } else {
                        Modal.alert(t('common.error'), t('newSession.worktree.failed', { error: checkoutResult.error || 'Unknown error' }));
                    }
                    current.setIsCreating(false);
                    return;
                }
                actualPath = checkoutResult.path;
                const sessionPath = checkoutResult.sessionPath.trim() || effectiveSelectedPath;
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
                        spawnBackendTarget: current.spawnBackendTarget,
                    }),
                    ...spawnSessionExtras,
                    spawnNonce: launchAttempt.spawnNonce,
                    userAttemptId: launchAttempt.attemptId,
                };
                result = await machineSpawnNewSession(spawnOptions);
                const operationCustody = result.spawnAttemptCustody;
                if (operationCustody?.status === 'unresolved' || operationCustody?.status === 'completed') {
                    if (current.launchUserAttemptId !== operationCustody.userAttemptId) {
                        current.onLaunchUserAttemptIdChange?.(operationCustody.userAttemptId);
                    }
                    launchAttempt = adoptNewSessionLaunchAttemptCustody(launchAttempt, {
                        userAttemptId: operationCustody.userAttemptId,
                        spawnNonce: operationCustody.spawnNonce,
                        createdSessionId: operationCustody.createdSessionId,
                        firstTurnLocalId: operationCustody.firstTurnLocalId,
                        attachmentMessageLocalId: operationCustody.attachmentMessageLocalId,
                    });
                    publishLaunchAttempt(launchAttempt);
                }
                if (result.type === 'error' && result.errorCode === SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT) {
                    shouldPreserveLaunchAttemptForSpawnRetry = true;
                }
            } else if (!result) {
                const createdSessionId = launchAttempt.createdSessionId;
                if (!createdSessionId) {
                    throw new Error('Created session ID is required to retry launch follow-up.');
                }
                result = {
                    type: 'success',
                    sessionId: createdSessionId,
                };
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
                if (launchAttempt.createdSessionId !== result.sessionId) {
                    launchAttempt = markNewSessionLaunchAttemptCreated(launchAttempt, { createdSessionId: result.sessionId });
                    publishLaunchAttempt(launchAttempt);
                }
                if (!isLaunchScopeStillActive()) {
                    publishLaunchAttempt(null);
                    current.setIsCreating(false);
                    return;
                }
                let postSpawnFollowUpError: unknown = null;
                const postSpawnFollowUpRetryRef: { current: (() => Promise<void>) | null } = { current: null };
                let suppressPostSpawnFollowUpAlert = false;
                let postSpawnFailurePhase: 'sending_first_turn' | 'uploading_attachments' = 'sending_first_turn';
                let initialMessageText = '';
                let postSpawnSessionRouteSuffix = '';
                let postSpawnReplacementHref: string | null = null;
                const createdSessionId = result.sessionId;
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
                    if (resolvedInitialMessage?.kind !== 'send') {
                        return;
                    }
                    const firstTurnText = resolvedInitialMessage.text.trim();
                    if (!firstTurnText) {
                        return;
                    }
                    const followUp = resolveSpawnedFirstPromptFollowUp({
                        sessionId: createdSessionId,
                        fallbackLocalId: launchAttempt.firstTurnLocalId,
                        initialMessageText: firstTurnText,
                        metaOverrides: initialMessageMetaOverrides,
                    });
                    const localId = followUp.messageLocalId ?? launchAttempt.firstTurnLocalId;
                    const state = storage.getState();
                    const session = state.sessions[createdSessionId] ?? null;
                    const agentCore = getAgentCore(canonicalAgentId);
                    const modelMode = session?.modelMode || current.modelMode || agentCore.model.defaultMode;
                    const permissionMode = session?.permissionMode || current.permissionMode || 'default';
                    const rawRecord = buildOutgoingUserTextRecord({
                        text: followUp.initialMessageText,
                        displayText: followUp.initialMessageText,
                        agentId: canonicalAgentId,
                        permissionMode,
                        modelMode,
                        settings: state.settings,
                        session,
                        metaOverrides: followUp.metaOverrides,
                    });
                    if (session) {
                        storage.getState().markSessionOptimisticThinking(createdSessionId);
                    }
                    projectLocalOutboundUserMessage({
                        sessionId: createdSessionId,
                        localId,
                        text: followUp.initialMessageText,
                        displayText: followUp.initialMessageText,
                        rawRecord,
                        deliveryStatus: followUp.optimisticDeliveryStatus,
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
                    if (options?.projectFirstTurn === true || resolvedInitialMessage?.kind === 'send') {
                        projectCreatedSessionFirstTurnForRoute();
                    }
                    current.router.replace(postSpawnReplacementHref ?? buildCreatedSessionRoute(), {
                        dangerouslySingular() {
                            return 'session';
                        },
                    });
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
                    launchAttempt = markNewSessionLaunchAttemptSendingFirstTurn(launchAttempt);
                    publishLaunchAttempt(launchAttempt);
                    let followUpMessageLocalId: string | null = launchAttempt.firstTurnLocalId;
                    let followUpMetaOverrides: Record<string, unknown> | null | undefined = initialMessageMetaOverrides;
                    if (resolvedInitialMessage) {
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
                        if (resolvedInitialMessage.kind === 'send') {
                            const followUp = resolveSpawnedFirstPromptFollowUp({
                                sessionId: createdSessionId,
                                fallbackLocalId: launchAttempt.firstTurnLocalId,
                                initialMessageText,
                                metaOverrides: initialMessageMetaOverrides,
                            });
                            initialMessageText = followUp.initialMessageText;
                            followUpMessageLocalId = followUp.messageLocalId;
                            followUpMetaOverrides = followUp.metaOverrides;
                        }
                    }

                    await followUpSpawnedSessionWithServerScope({
                        sessionId: createdSessionId,
                        targetServerId: resolvedTargetServerId,
                        initialMessageText,
                        messageLocalId: followUpMessageLocalId,
                        metaOverrides: followUpMetaOverrides,
                        profileId: profilesActive ? (current.selectedProfileId ?? '') : null,
                    });

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
                            agentId: canonicalAgentId,
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
                        postSpawnFailurePhase = 'sending_first_turn';
                        postSpawnFollowUpError = error;
                        postSpawnFollowUpRetryRef.current = async () => {
                            await runBuiltInPostSpawnFollowUp();
                            await runAfterCreatedFollowUp();
                        };
                    }
                }

                storage.getState().updateSessionPermissionMode(result.sessionId, current.permissionMode);
                if (getAgentCore(canonicalAgentId).model.supportsSelection && current.modelMode && current.modelMode !== 'default') {
                    storage.getState().updateSessionModelMode(result.sessionId, current.modelMode);
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

                if (!isLaunchScopeStillActive()) {
                    publishLaunchAttempt(null);
                    current.setIsCreating(false);
                    return;
                }

                if (postSpawnFollowUpError) {
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
                    if (postSpawnFailurePhase === 'sending_first_turn') {
                        preserveCreatedSessionDraft({
                            sessionId: createdSessionId,
                            draftText: readRecoverableCreatedSessionDraftText(postSpawnFollowUpError)
                                ?? (initialMessageText || sessionPrompt),
                        });
                    }
                    if (createdSessionRouteOpened && isSessionHydratedForDraftRestore(createdSessionId)) {
                        current.disableDraftPersistence?.();
                        clearNewSessionDraftForLaunchParams(current);
                    }

                    current.setIsCreating(false);
                    return;
                } else {
                    launchAttempt = markNewSessionLaunchAttemptComplete(launchAttempt);
                }

                if (!createdSessionRouteOpened) {
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
                const completedCustody = result.spawnAttemptCustody?.status === 'completed'
                    ? result.spawnAttemptCustody
                    : null;
                if (completedCustody) {
                    const completed = await completeMachineSpawnAttemptCustody(completedCustody);
                    if (!completed) {
                        throw new Error('Created session custody could not be completed.');
                    }
                }
                publishLaunchAttempt(null);
                current.disableDraftPersistence?.();
                clearNewSessionDraftForLaunchParams(current);
            } else if (result.type === 'requestToApproveDirectoryCreation') {
                publishLaunchAttempt(null);
                const rollbackErrorMessage = await rollbackSpawnArtifacts();
                const rollbackDetail = rollbackErrorMessage ? `\n\n${t('common.details')}: ${rollbackErrorMessage}` : '';
                Modal.alert(t('common.error'), `${t('newSession.failedToStart')}${rollbackDetail}`);
                current.setIsCreating(false);
            } else if (result.type === 'error') {
                if (shouldPreserveLaunchAttemptForSpawnRetry && result.errorCode === SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT) {
                    launchAttempt = markNewSessionLaunchAttemptFailed(launchAttempt, {
                        phase: 'spawning',
                        error: new Error(result.errorMessage),
                        retryable: true,
                    });
                    publishLaunchAttempt(launchAttempt);
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
                publishLaunchAttempt(null);
                const rollbackErrorMessage = await rollbackSpawnArtifacts();
                const structuredProviderError = result.errorDetail?.kind === SPAWN_SESSION_ERROR_DETAIL_KINDS.PROVIDER_ERROR
                    ? result.errorDetail.providerError
                    : null;
                if (structuredProviderError) {
                    setProviderLaunchFailure({
                        error: structuredProviderError,
                        scopeKey: buildProviderLaunchErrorScopeKey(current, resolvedTargetServerId),
                    });
                    if (rollbackErrorMessage) {
                        Modal.alert(
                            t('common.error'),
                            `${t('newSession.failedToStart')}\n\n${t('common.details')}: ${rollbackErrorMessage}`,
                        );
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
                    Modal.alert(
                        t(switchUnavailable.titleKey),
                        t(switchUnavailable.bodyKey, switchUnavailable.bodyParams),
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
            Modal.alert(t('common.error'), errorMessage);
            latestParamsRef.current.setIsCreating(false);
        } finally {
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
