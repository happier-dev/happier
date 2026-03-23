import * as React from 'react';

import { t } from '@/text';
import { Modal } from '@/modal';
import { sync } from '@/sync/sync';
import { useApplySettings } from '@/sync/store/settingsWriters';
import { storage } from '@/sync/domains/state/storage';
import { machineBash, machineSpawnNewSession } from '@/sync/ops';
import { resolveTerminalSpawnOptions } from '@/sync/domains/settings/terminalSettings';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveNewSessionServerTarget } from '@/sync/domains/server/selection/serverSelectionResolver';
import { getMissingRequiredConfigEnvVarNames } from '@/utils/profiles/profileConfigRequirements';
import { getSecretSatisfaction } from '@/utils/secrets/secretSatisfaction';
import type { SecretChoiceByProfileIdByEnvVarName } from '@/utils/secrets/secretRequirementApply';
import { clearNewSessionDraft, loadSessionDrafts, saveSessionDrafts } from '@/sync/domains/state/persistence';
import { storeTempData } from '@/utils/sessions/tempDataStore';
import { getBuiltInProfile } from '@/sync/domains/profiles/profileUtils';
import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import type { Settings } from '@/sync/domains/settings/settings';
import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import { resolveEffectiveWindowsRemoteSessionLaunchMode } from '@/sync/domains/session/spawn/windowsRemoteSessionLaunchMode';
import { getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import { buildSpawnEnvironmentVariablesFromUiState, buildSpawnSessionExtrasFromUiState, getAgentResumeExperimentsFromSettings, getNewSessionPreflightIssues } from '@/agents/catalog/catalog';
import { transformProfileToEnvironmentVars } from '@/components/sessions/new/modules/profileHelpers';
import type { UseMachineEnvPresenceResult } from '@/hooks/machine/useMachineEnvPresence';
import { getMachineCapabilitiesSnapshot } from '@/hooks/server/useMachineCapabilitiesCache';
import type { PermissionMode, ModelMode } from '@/sync/domains/permissions/permissionTypes';
import { SPAWN_SESSION_ERROR_CODES, type BackendTargetRefV1, type WindowsRemoteSessionLaunchMode } from '@happier-dev/protocol';
import type { AcpConfigOptionOverridesV1 } from '@happier-dev/protocol';
import { parsePermissionIntentAlias } from '@happier-dev/agents';
import type { CodexBackendMode } from '@happier-dev/agents';
import { nowServerMs } from '@/sync/runtime/time';
import { encodeAutomationTemplateCiphertextForAccount } from '@/sync/domains/automations/encodeAutomationTemplateCiphertextForAccount';
import { resolveSessionComposerSend } from '@/sync/domains/input/slashCommands/resolveSessionComposerSend';
import { expandPromptTemplateInvocation } from '@/sync/domains/input/slashCommands/expandPromptTemplateInvocation';
import {
    buildAutomationScheduleFromDraft,
    normalizeAutomationDescription,
    normalizeAutomationName,
    validateAutomationTemplateTarget,
} from '@/sync/domains/automations/automationValidation';
import { delay } from '@/utils/timing/time';
import { showDaemonUnavailableAlert } from '@/utils/errors/daemonUnavailableAlert';
import { captureExceptionIfEnabled } from '@/utils/system/sentry';
import { useMountedRef } from '@/hooks/ui/useMountedRef';
import type { SessionMcpSelectionV1 } from '@happier-dev/protocol';
import type { NewSessionCheckoutCreationDraft } from '@/sync/domains/state/newSessionCheckoutDraft';
import { materializeNewSessionCheckout } from '@/components/sessions/new/modules/materializeNewSessionCheckout';
import { rollbackNewSessionArtifacts } from '@/components/sessions/new/modules/rollbackNewSessionArtifacts';
import {
    followUpSpawnedSessionWithServerScope,
    readRecoverableFollowUpPayload,
} from '@/sync/runtime/orchestration/serverScopedRpc/followUpSpawnedSession';
import {
    buildAutomationTemplateFromSessionAuthoringDraft,
    buildNewSessionAuthoringDraftFromResolvedInputs,
    buildSpawnSessionOptionsFromAuthoringDraft,
} from '@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters';
import type { SessionAuthoringDraft } from '@/components/sessions/authoring/draft/sessionAuthoringDraft';
import type { AttachmentDraft } from '@/components/sessions/attachments/attachmentDraftModel';
import { readRecoverableAttachmentDrafts } from '@/components/sessions/attachments/recoverableAttachmentDrafts';

type MutableSettingsDelta = {
    -readonly [TKey in keyof Settings]?: Settings[TKey];
};

function buildRecoveryDataIdFromError(error: unknown): string | null {
    const attachmentDrafts = readRecoverableAttachmentDrafts(error);
    if (!attachmentDrafts || attachmentDrafts.length === 0) {
        return null;
    }

    return storeTempData({
        attachmentDrafts: attachmentDrafts as AttachmentDraft[],
    });
}

export type CreatedSessionFollowUpContext = Readonly<{
    sessionId: string;
    effectiveSpawnServerId: string | null;
}>;

type HandleCreateSessionOptions = Readonly<{
    initialMessage?: 'send' | 'skip';
    afterCreated?: (context: CreatedSessionFollowUpContext) => void | Promise<void>;
}>;

export function useCreateNewSession(params: Readonly<{
    router: { push: (options: any) => void; replace: (path: any, options?: any) => void };

    selectedMachineId: string | null;
    selectedPath: string;
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

    sessionPrompt: string;
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
    disableDraftPersistence?: () => void;
}>): Readonly<{
    handleCreateSession: (opts?: HandleCreateSessionOptions) => void;
}> {
    const mountedRef = useMountedRef();
    const applySettings = useApplySettings();
    const latestParamsRef = React.useRef(params);
    // Keep the latest params available synchronously so event handlers can't observe
    // a stale snapshot in the window between rerender and effect flush.
    latestParamsRef.current = params;

    const handleCreateSession = React.useCallback(async (opts?: HandleCreateSessionOptions) => {
        const current = latestParamsRef.current;
        let rollbackActualPath: string | null = null;
        let rollbackServerId: string | null = current.targetServerId ?? null;
        const isRepoNativeWorktreeLaunch = current.checkoutCreationDraft?.kind === 'git_worktree';

        if (!current.selectedMachineId) {
            Modal.alert(t('common.error'), t('newSession.noMachineSelected'));
            return;
        }
        if (current.selectedPath.trim().length === 0) {
            Modal.alert(t('common.error'), t('newSession.noPathSelected'));
            return;
        }

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

            const updatedPaths = [{ machineId: current.selectedMachineId, path: current.selectedPath }, ...current.recentMachinePaths.filter((rp) => rp.machineId !== current.selectedMachineId)].slice(0, 10);
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

            let environmentVariables = undefined;
            if (profilesActive && current.selectedProfileId) {
                const selectedProfile = current.profileMap.get(current.selectedProfileId) || getBuiltInProfile(current.selectedProfileId);
                if (selectedProfile) {
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
            const backendTarget: BackendTargetRefV1 = current.backendTarget ?? { kind: 'builtInAgent', agentId: current.agentType };
            const connectedServices = (current.agentNewSessionOptions as any)?.connectedServices;

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

            const resumeId = current.resumeSessionId.trim().length > 0 ? current.resumeSessionId.trim() : undefined;
            const spawnPermissionMode = parsePermissionIntentAlias(current.permissionMode) ?? 'default';
            const spawnPermissionModeUpdatedAt = nowServerMs();
            const normalizedAcpModeId = typeof current.acpSessionModeId === 'string' ? current.acpSessionModeId.trim() : '';
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
            const normalizedSessionPrompt = current.sessionPrompt.trim();
            const spawnSessionExtras = buildSpawnSessionExtrasFromUiState({
                agentId: current.agentType,
                settings: current.settings,
                resumeSessionId: current.resumeSessionId,
            });
            const authoringDraft = buildNewSessionAuthoringDraftFromResolvedInputs({
                directory: current.selectedPath,
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
                terminal: terminal ?? null,
                windowsRemoteSessionLaunchMode: windowsRemoteSessionLaunchMode ?? null,
                windowsRemoteSessionConsole: null,
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
                    clearNewSessionDraft();
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
                clearNewSessionDraft();
                await sync.refreshAutomations();
                current.router.replace('/automations' as any);
                return;
            }

            const checkoutResult = await materializeNewSessionCheckout({
                machineId: current.selectedMachineId,
                selectedPath: current.selectedPath,
                checkoutCreationDraft: current.checkoutCreationDraft,
            });

            if (!checkoutResult.success) {
                if (checkoutResult.error === 'Not a Git repository') {
                    Modal.alert(t('common.error'), t('newSession.worktree.notGitRepo'));
                } else {
                    Modal.alert(t('common.error'), t('newSession.worktree.failed', { error: checkoutResult.error || 'Unknown error' }));
                }
                current.setIsCreating(false);
                return;
            }
            const actualPath = checkoutResult.path;
            const sessionPath = checkoutResult.sessionPath.trim() || current.selectedPath.trim();
            rollbackActualPath = actualPath;

            const result = await machineSpawnNewSession({
                ...buildSpawnSessionOptionsFromAuthoringDraft({
                    draft: {
                        ...authoringDraft,
                        directory: sessionPath,
                    },
                    machineId: current.selectedMachineId,
                    serverId: resolvedTargetServerId,
                    approvedNewDirectoryCreation: true,
                    agentModeUpdatedAt: normalizedAcpModeId ? spawnPermissionModeUpdatedAt : null,
                }),
                ...spawnSessionExtras,
            });

            const rollbackSpawnArtifacts = async (): Promise<string | null> => {
                try {
                    await rollbackNewSessionArtifacts({
                        machineId: current.selectedMachineId!,
                        selectedPath: current.selectedPath,
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
                let postSpawnFollowUpError: unknown = null;
                let initialMessageText = '';
                let recoverableCreatedSessionDraft = '';

                try {
                    const shouldSendInitialMessage = (opts?.initialMessage ?? 'send') !== 'skip';
                    const shouldPrepareInitialMessage = shouldSendInitialMessage && current.sessionPrompt.trim();
                    if (shouldPrepareInitialMessage) {
                        const promptInvocationsV1 = storage.getState().settings.promptInvocationsV1;
                        const resolvedInitialMessage = resolveSessionComposerSend({
                            input: current.sessionPrompt,
                            executionRunsEnabled: false,
                            promptInvocationsV1,
                        });

                        initialMessageText = current.sessionPrompt;
                        if (resolvedInitialMessage.kind === 'template') {
                            initialMessageText = await expandPromptTemplateInvocation({
                                targetArtifactId: resolvedInitialMessage.targetArtifactId,
                                argsText: resolvedInitialMessage.rest,
                            });
                        } else if (resolvedInitialMessage.kind === 'send') {
                            initialMessageText = resolvedInitialMessage.text;
                        } else if (resolvedInitialMessage.kind === 'noop') {
                            initialMessageText = '';
                        }
                    }

                    await followUpSpawnedSessionWithServerScope({
                        sessionId: result.sessionId,
                        targetServerId: resolvedTargetServerId,
                        initialMessageText,
                        profileId: profilesActive ? (current.selectedProfileId ?? '') : null,
                    });
                } catch (error) {
                    postSpawnFollowUpError = error;
                    recoverableCreatedSessionDraft = initialMessageText;
                }

                storage.getState().updateSessionPermissionMode(result.sessionId, current.permissionMode);
                if (getAgentCore(current.agentType).model.supportsSelection && current.modelMode && current.modelMode !== 'default') {
                    storage.getState().updateSessionModelMode(result.sessionId, current.modelMode);
                }

                const createdSessionId = result.sessionId;

                const persistCreatedSessionDraftForRecovery = (draft: string) => {
                    const normalizedDraft = draft.trim();
                    if (!normalizedDraft) {
                        return;
                    }

                    const storedSession = storage.getState().sessions[createdSessionId];
                    if (storedSession) {
                        storage.getState().updateSessionDraft(createdSessionId, normalizedDraft);
                        return;
                    }

                    saveSessionDrafts({
                        ...loadSessionDrafts(),
                        [createdSessionId]: normalizedDraft,
                    });
                };

                const ensureCreatedSessionHydratedForNavigation = async (): Promise<boolean> => {
                    if (storage.getState().sessions[createdSessionId]) {
                        return true;
                    }

                    try {
                        await sync.ensureSessionVisibleForMessageRoute(createdSessionId, { forceRefresh: true });
                    } catch {
                        // Best effort only. Navigation is gated on the local session snapshot below.
                    }

                    return Boolean(storage.getState().sessions[createdSessionId]);
                };

                if (!postSpawnFollowUpError && opts?.afterCreated) {
                    try {
                        await opts.afterCreated({
                            sessionId: result.sessionId,
                            effectiveSpawnServerId: resolvedTargetServerId,
                        });
                    } catch (error) {
                        postSpawnFollowUpError = error;
                        const recoverableFollowUpPayload = readRecoverableFollowUpPayload(error)
                            ?? ((error instanceof Error
                                && typeof (error as Error & { recoverableFollowUpPayload?: { draftText?: unknown } }).recoverableFollowUpPayload?.draftText === 'string')
                                ? (error as Error & {
                                    recoverableFollowUpPayload: {
                                        draftText: string;
                                    };
                                }).recoverableFollowUpPayload
                                : null);
                        recoverableCreatedSessionDraft = recoverableFollowUpPayload?.draftText ?? (
                            typeof current.sessionPrompt === 'string'
                                ? current.sessionPrompt
                                : (typeof params.sessionPrompt === 'string' ? params.sessionPrompt : '')
                        );
                    }
                }

                if (postSpawnFollowUpError) {
                    const normalizedRecoveryDraft = typeof recoverableCreatedSessionDraft === 'string'
                        ? recoverableCreatedSessionDraft.trim()
                        : '';

                    if (normalizedRecoveryDraft.length > 0) {
                        persistCreatedSessionDraftForRecovery(normalizedRecoveryDraft);
                    }

                    const createdSessionHydrated = await ensureCreatedSessionHydratedForNavigation();

                    if (createdSessionHydrated && normalizedRecoveryDraft.length > 0) {
                        storage.getState().updateSessionDraft(createdSessionId, normalizedRecoveryDraft);
                    }

                    if (createdSessionHydrated) {
                        current.disableDraftPersistence?.();
                        clearNewSessionDraft();
                    }

                    Modal.alert(
                        t('common.error'),
                        postSpawnFollowUpError instanceof Error ? postSpawnFollowUpError.message : t('common.error'),
                    );

                    if (!createdSessionHydrated) {
                        current.setIsCreating(false);
                        return;
                    }
                } else {
                    current.disableDraftPersistence?.();
                    clearNewSessionDraft();
                }

                const recoveryDataId = postSpawnFollowUpError ? buildRecoveryDataIdFromError(postSpawnFollowUpError) : null;
                const sessionRoute = recoveryDataId
                    ? `/session/${result.sessionId}?recoveryDataId=${encodeURIComponent(recoveryDataId)}`
                    : `/session/${result.sessionId}`;

                current.router.replace(sessionRoute, {
                    dangerouslySingular() {
                        return 'session';
                    },
                });
            } else if (result.type === 'requestToApproveDirectoryCreation') {
                const rollbackErrorMessage = await rollbackSpawnArtifacts();
                const rollbackDetail = rollbackErrorMessage ? `\n\n${t('common.details')}: ${rollbackErrorMessage}` : '';
                Modal.alert(t('common.error'), `${t('newSession.failedToStart')}${rollbackDetail}`);
                current.setIsCreating(false);
            } else if (result.type === 'error') {
                const rollbackErrorMessage = await rollbackSpawnArtifacts();
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
                        selectedPath: current.selectedPath,
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
                            selectedPath: current.selectedPath,
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
                    selectedPath: current.selectedPath,
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
        }
    }, [applySettings, mountedRef]);

    return { handleCreateSession };
}
