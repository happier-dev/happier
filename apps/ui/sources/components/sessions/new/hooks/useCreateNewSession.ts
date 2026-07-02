import * as React from 'react';

import { t } from '@/text';
import { Modal } from '@/modal';
import { sync } from '@/sync/sync';
import { useApplySettings } from '@/sync/store/settingsWriters';
import { storage } from '@/sync/domains/state/storage';
import { machineBash, machineResolveSpawnSessionByNonceUntilSettled, machineSpawnNewSession } from '@/sync/ops';
import { resolveTerminalSpawnOptions } from '@/sync/domains/settings/terminalSettings';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveNewSessionServerTarget } from '@/sync/domains/server/selection/serverSelectionResolver';
import { getMissingRequiredConfigEnvVarNames } from '@/utils/profiles/profileConfigRequirements';
import { getSecretSatisfaction } from '@/utils/secrets/secretSatisfaction';
import type { SecretChoiceByProfileIdByEnvVarName } from '@/utils/secrets/secretRequirementApply';
import { clearNewSessionDraft } from '@/sync/domains/state/persistence';
import { getBuiltInProfile } from '@/sync/domains/profiles/profileUtils';
import { isProfileCompatibleWithBackendTarget, type AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import type { Settings } from '@/sync/domains/settings/settings';
import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { resolveEffectiveWindowsRemoteSessionLaunchMode } from '@/sync/domains/session/spawn/windowsRemoteSessionLaunchMode';
import { DEFAULT_AGENT_ID, getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import { isAgentId } from '@/agents/catalog/catalog';
import { buildSpawnEnvironmentVariablesFromUiState, buildSpawnSessionExtrasFromUiState, getAgentResumeExperimentsFromSettings, getNewSessionPreflightIssues } from '@/agents/catalog/catalog';
import { transformProfileToEnvironmentVars } from '@/components/sessions/new/modules/profileHelpers';
import type { UseMachineEnvPresenceResult } from '@/hooks/machine/useMachineEnvPresence';
import { getMachineCapabilitiesSnapshot } from '@/hooks/server/useMachineCapabilitiesCache';
import type { PermissionMode, ModelMode } from '@/sync/domains/permissions/permissionTypes';
import { SPAWN_SESSION_ERROR_CODES, type BackendTargetRefV2, type BackendTargetRefV2Input, type WindowsRemoteSessionLaunchMode } from '@happier-dev/protocol';
import type { AcpConfigOptionOverridesV1 } from '@happier-dev/protocol';
import { parsePermissionIntentAlias } from '@happier-dev/agents';
import type { CodexBackendMode } from '@happier-dev/agents';
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
    isDaemonUnavailableAlertError,
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
    followUpSpawnedSessionWithServerScope,
} from '@/sync/runtime/orchestration/serverScopedRpc/followUpSpawnedSession';
import { resolveServerIdForSessionIdFromLocalCache } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';
import {
    buildAutomationTemplateFromSessionAuthoringDraft,
    buildNewSessionAuthoringDraftFromResolvedInputs,
    buildSpawnSessionOptionsFromAuthoringDraft,
} from '@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters';
import type { SessionAuthoringDraft } from '@/components/sessions/authoring/draft/sessionAuthoringDraft';
import {
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
}>): Readonly<{
    handleCreateSession: (opts?: HandleCreateSessionOptions) => void;
}> {
    const mountedRef = useMountedRef();
    const applySettings = useApplySettings();
    const latestParamsRef = React.useRef(params);
    const launchAttemptRef = React.useRef<NewSessionLaunchAttempt | null>(null);
    const createInFlightRef = React.useRef(false);
    // Keep the latest params available synchronously so event handlers can't observe
    // a stale snapshot in the window between rerender and effect flush.
    latestParamsRef.current = params;

    const handleCreateSession = React.useCallback(async (opts?: HandleCreateSessionOptions) => {
        if (createInFlightRef.current) return;
        const current = latestParamsRef.current;
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
                selectedPath: effectiveSelectedPath,
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
                const shouldWriteLastUsedAgent =
                    !current.backendTarget.configuredBackendId
                    && isAgentId(current.backendTarget.backendId);
                if (shouldWriteLastUsedAgent) settingsUpdate.lastUsedAgent = canonicalAgentId;
                settingsUpdate.lastUsedBackendTarget = current.backendTarget;
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
                modelId: spawnModelId ?? null,
                modelUpdatedAt: spawnModelUpdatedAt ?? null,
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
                sessionConfigOptionOverrides: current.sessionConfigOptionOverrides ?? null,
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
                meta: null,
            });
            launchAttemptRef.current = launchAttempt;
            let actualPath = effectiveSelectedPath;
            let result: Awaited<ReturnType<typeof machineSpawnNewSession>>;
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
                const sessionPath = checkoutResult.sessionPath.trim() || effectiveSelectedPath;
                rollbackActualPath = actualPath;

                result = await machineSpawnNewSession({
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
                });

                if (result.type === 'error' && result.errorCode === SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT) {
                    const resolvedSpawn = await machineResolveSpawnSessionByNonceUntilSettled({
                        machineId: current.selectedMachineId!,
                        spawnNonce: launchAttempt.spawnNonce,
                        serverId: resolvedTargetServerId,
                    });
                    if (resolvedSpawn.status === 'success') {
                        result = { type: 'success', sessionId: resolvedSpawn.sessionId };
                    } else {
                        shouldPreserveLaunchAttemptForSpawnRetry = true;
                        result = {
                            type: 'error',
                            errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
                            errorMessage: `Session startup timed out (${resolvedSpawn.status})`,
                        };
                    }
                }
            } else {
                const createdSessionId = launchAttempt.createdSessionId;
                if (!createdSessionId) {
                    throw new Error('Created session ID is required to retry launch follow-up.');
                }
                result = { type: 'success', sessionId: createdSessionId };
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
                    launchAttemptRef.current = launchAttempt;
                }
                if (!isLaunchScopeStillActive()) {
                    launchAttemptRef.current = null;
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
                    launchAttemptRef.current = launchAttempt;
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
                    }

                    await followUpSpawnedSessionWithServerScope({
                        sessionId: createdSessionId,
                        targetServerId: resolvedTargetServerId,
                        initialMessageText,
                        messageLocalId: launchAttempt.firstTurnLocalId,
                        metaOverrides: (() => {
                            const agentCore = getAgentCore(canonicalAgentId);
                            if (
                                agentCore.model.supportsSelection
                                && agentCore.model.nonAcpApplyScope === 'next_prompt'
                                && current.modelMode
                                && current.modelMode !== 'default'
                            ) {
                                // Some providers only apply model overrides when processing a user prompt.
                                // Seed the initial message so the first turn uses the selected model.
                                return { model: current.modelMode };
                            }

                            return null;
                        })(),
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
                    launchAttemptRef.current = null;
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
                    launchAttemptRef.current = launchAttempt;
                    if (!suppressPostSpawnFollowUpAlert) {
                        Modal.alert(
                            t('common.error'),
                            postSpawnFollowUpError instanceof Error ? postSpawnFollowUpError.message : t('common.error'),
                        );
                    }

                    current.setIsCreating(false);
                    return;
                } else {
                    launchAttempt = markNewSessionLaunchAttemptComplete(launchAttempt);
                    launchAttemptRef.current = null;
                    current.disableDraftPersistence?.();
                    clearNewSessionDraftForLaunchParams(current);
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
            } else if (result.type === 'requestToApproveDirectoryCreation') {
                launchAttemptRef.current = null;
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
                    launchAttemptRef.current = launchAttempt;
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
                launchAttemptRef.current = null;
                const rollbackErrorMessage = await rollbackSpawnArtifacts();
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
    }, [applySettings, mountedRef]);

    return { handleCreateSession };
}
