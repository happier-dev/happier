import React from 'react';
import { View, useWindowDimensions, InteractionManager } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAllMachines, storage, useSetting, useSettingMutable, useSettings } from '@/sync/domains/state/storage';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { useRouter, useLocalSearchParams, useNavigation, usePathname } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { useHeaderHeight } from '@/utils/platform/responsive';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Modal } from '@/modal';
import { sync } from '@/sync/sync';
import { getTempData, type NewSessionData } from '@/utils/sessions/tempDataStore';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { tryShowDaemonUnavailableAlertForRpcError } from '@/utils/errors/daemonUnavailableAlert';
import { type PermissionMode, type ModelMode } from '@/sync/domains/permissions/permissionTypes';
import { normalizePermissionModeForAgentType } from '@/sync/domains/permissions/permissionModeOptions';
import {
    getProfileEnvironmentVariables,
    isProfileCompatibleWithBackendTarget,
    type AIBackendProfile,
} from '@/sync/domains/profiles/profileCompatibility';
import { getBuiltInProfile, DEFAULT_PROFILES, getProfilePrimaryCli } from '@/sync/domains/profiles/profileUtils';
import { DEFAULT_AGENT_ID, getAgentCore, isAgentId, resolveAgentIdFromCliDetectKey, type AgentId } from '@/agents/catalog/catalog';
import { useEnabledAgentIds } from '@/agents/hooks/useEnabledAgentIds';
import {
    getResolvedBackendCatalogEntries,
    resolveBuiltInAgentIdForBackendTarget,
} from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';

import { loadNewSessionDraft } from '@/sync/domains/state/persistence';
import { NewSessionEngineOptionDetail } from '@/components/sessions/new/components/NewSessionEngineOptionDetail';
import { consumeProfileIdParam } from '@/profileRouteParams';
import { normalizeOptionalParam } from '@/profileRouteParams';
import { useFocusEffect } from '@react-navigation/native';
import { useMachineEnvPresence } from '@/hooks/machine/useMachineEnvPresence';
import { normalizeSessionAuthoringConnectedServices } from '@/sync/domains/sessionAuthoring/sessionAuthoringNormalization';
import type { CapabilityId } from '@/sync/api/capabilities/capabilitiesProtocol';
import {
    buildNewSessionOptionsFromUiState,
} from '@/agents/catalog/catalog';
import { getSecretSatisfaction } from '@/utils/secrets/secretSatisfaction';
import { useKeyboardHeight } from '@/hooks/ui/useKeyboardHeight';
import { computeNewSessionInputMaxHeight } from '@/components/sessions/agentInput/inputMaxHeight';
import { useProfileMap } from '@/components/sessions/new/modules/profileHelpers';
import { newSessionScreenStyles } from '@/components/sessions/new/newSessionScreenStyles';
import { coerceNewSessionModelMode } from '@/components/sessions/new/hooks/newSessionModelModePolicy';
import { useCreateNewSession } from '@/components/sessions/new/hooks/useCreateNewSession';
import { useNewSessionSimplePanelProps } from '@/components/sessions/new/hooks/useNewSessionSimplePanelProps';
import { useNewSessionWizardProps } from '@/components/sessions/new/hooks/useNewSessionWizardProps';
import { buildNewSessionProfileSelectionPopover } from '@/components/sessions/new/components/buildNewSessionProfileSelectionPopover';
import { useNewSessionAgentPickerControls } from '@/components/sessions/new/hooks/screenModel/useNewSessionAgentPickerControls';
import { resolveNewSessionCapabilityServerId } from '@/components/sessions/new/modules/resolveNewSessionCapabilityServerId';
import { resolveNewSessionCapabilityProbeContext } from '@/components/sessions/new/modules/newSessionCapabilityProbeContext';
import { buildCliAvailabilityProbeState } from '@/components/sessions/new/modules/buildCliAvailabilityProbeState';
import type { NewSessionTranscriptStorage } from '@/components/sessions/new/modules/newSessionTranscriptStorage';
import {
    resolveNextSelectableBackendEntryForNewSession,
} from '@/components/sessions/new/modules/newSessionAgentSelection';
import type { AgentInputChipPickerOption } from '@/components/sessions/agentInput/components/AgentInputChipPickerTypes';
import { getActiveServerSnapshot, subscribeActiveServer } from '@/sync/domains/server/serverRuntime';
import { useAutomationsSupport } from '@/hooks/server/useAutomationsSupport';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useNewSessionConnectedServices } from '@/components/sessions/new/modules/useNewSessionConnectedServices';
import {
    buildNewSessionAuthoringDraftFromPersistedDraft,
    buildNewSessionAuthoringDraftFromTempData,
} from '@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters';
import { useNewSessionServerTargetState } from '@/components/sessions/new/hooks/serverTarget/useNewSessionServerTargetState';
import { useNewSessionBackendTargetState } from '@/components/sessions/new/hooks/screenModel/useNewSessionBackendTargetState';
import { useNewSessionMachinePathState } from '@/components/sessions/new/hooks/screenModel/useNewSessionMachinePathState';
import { useNewSessionPreflightModelsState } from '@/components/sessions/new/hooks/screenModel/useNewSessionPreflightModelsState';
import { useNewSessionPreflightConfigOptionsState } from '@/components/sessions/new/hooks/screenModel/useNewSessionPreflightConfigOptionsState';
import { useNewSessionPreflightSessionModesState } from '@/components/sessions/new/hooks/screenModel/useNewSessionPreflightSessionModesState';
import { useNewSessionRepoScmSnapshot } from '@/components/sessions/new/hooks/screenModel/useNewSessionRepoScmSnapshot';
import {
    buildBackendTargetKey,
    type BackendTargetRefV1,
    type WindowsRemoteSessionLaunchMode,
} from '@happier-dev/protocol';
import { useNewSessionMcpSelection } from '@/components/sessions/new/hooks/useNewSessionMcpSelection';
import { resolveEffectiveWindowsRemoteSessionLaunchMode } from '@/sync/domains/session/spawn/windowsRemoteSessionLaunchMode';
import { useNewSessionAvailabilityState } from '@/components/sessions/new/hooks/screenModel/useNewSessionAvailabilityState';
import { useNewSessionMachineRefreshState } from '@/components/sessions/new/hooks/screenModel/useNewSessionMachineRefreshState';
import { useNewSessionAuthoringState } from '@/components/sessions/new/hooks/screenModel/useNewSessionAuthoringState';
import { useNewSessionCheckoutSelectionState } from '@/components/sessions/new/hooks/screenModel/useNewSessionCheckoutSelectionState';
import { useNewSessionProfileEditPersistence } from '@/components/sessions/new/hooks/screenModel/useNewSessionProfileEditPersistence';
import { buildNewSessionScreenVariantModel } from '@/components/sessions/new/hooks/screenModel/buildNewSessionScreenVariantModel';
import { useNewSessionAgentInputPresentation } from '@/components/sessions/new/hooks/screenModel/useNewSessionAgentInputPresentation';
import { useNewSessionTranscriptStorageState } from '@/components/sessions/new/hooks/screenModel/useNewSessionTranscriptStorageState';
import { useNewSessionAgentAuthoringOptionsState } from '@/components/sessions/new/hooks/screenModel/useNewSessionAgentAuthoringOptionsState';
import { useNewSessionPermissionModeState } from '@/components/sessions/new/hooks/screenModel/useNewSessionPermissionModeState';
import { useNewSessionPromptAutomationState } from '@/components/sessions/new/hooks/screenModel/useNewSessionPromptAutomationState';
import { useNewSessionSecretSelectionState } from '@/components/sessions/new/hooks/screenModel/useNewSessionSecretSelectionState';
import { useNewSessionHappyRouteFlag } from '@/components/sessions/new/hooks/screenModel/useNewSessionHappyRouteFlag';
import type { NewSessionScreenModel } from '@/components/sessions/new/hooks/newSessionScreenModelTypes';
import { randomUUID } from '@/platform/randomUUID';
import { NewSessionPathSelectionContent } from '@/components/sessions/new/components/NewSessionPathSelectionContent';
import { NewSessionMachineSelectionContent } from '@/components/sessions/new/components/NewSessionMachineSelectionContent';
import { NewSessionResumeSelectionContent } from '@/components/sessions/new/components/NewSessionResumeSelectionContent';
import type { AgentInputContentPopoverConfig } from '@/components/sessions/agentInput/components/AgentInputContentPopover';
import { useServerScopedMachineOptions } from '@/components/sessions/new/hooks/machines/useServerScopedMachineOptions';
import { useProfile as useAccountProfile } from '@/sync/store/hooks';
import { openDirectSessionsResumeIdPickerModal } from '@/components/sessions/directSessions/browse/openDirectSessionsResumeIdPickerModal';
import { canBrowseDirectSessions, resolveDirectBrowseLockedSource } from '@/components/sessions/directSessions/browse/resolveDirectBrowseLockedSourceOption';


// Configuration constants
const RECENT_PATHS_DEFAULT_VISIBLE = 5;
const styles = newSessionScreenStyles;

export function useNewSessionScreenModel(): NewSessionScreenModel {
    const { theme, rt } = useUnistyles();
    const router = useRouter();
    const navigation = useNavigation();
    const pathname = usePathname();
    const safeArea = useSafeAreaInsets();
    const headerHeight = useHeaderHeight();
    const { width: screenWidth, height: screenHeight } = useWindowDimensions();
    const keyboardHeight = useKeyboardHeight();
    const selectedIndicatorColor = rt.themeName === 'dark' ? theme.colors.text : theme.colors.button.primary.background;
    const popoverBoundaryRef = React.useRef<View>(null!);

    const newSessionSidePadding = 16;
    const newSessionBottomPadding = Math.max(screenWidth < 420 ? 8 : 16, safeArea.bottom);

    // Simple (non-wizard) new-session screen spacing.
    // Keep wizard spacing unchanged (the wizard layout benefits from wider margins).
    const simpleNewSessionTopPadding = screenWidth < 420 ? 20 : 28;
    const simpleNewSessionSidePadding = screenWidth < 420 ? 16 : 24;
    const simpleNewSessionBottomPadding = Math.max(8, safeArea.bottom);
    const {
        prompt,
        dataId,
        machineId: machineIdParam,
        worktree: worktreeParam,
        directory: directoryParam,
        path: pathParam,
        profileId: profileIdParam,
        spawnServerId: spawnServerIdParam,
        automation: automationParam,
        automationEnabled: automationEnabledParam,
        automationName: automationNameParam,
        automationDescription: automationDescriptionParam,
        automationScheduleKind: automationScheduleKindParam,
        automationEveryMinutes: automationEveryMinutesParam,
        automationCronExpr: automationCronExprParam,
        automationTimezone: automationTimezoneParam,
        automationEditId: automationEditIdParam,
        resumeSessionId: resumeSessionIdParam,
        secretId: secretIdParam,
        secretSessionOnlyId,
        secretRequirementResultId,
    } = useLocalSearchParams<{
        prompt?: string;
        dataId?: string;
        machineId?: string | string[];
        worktree?: string | string[];
        directory?: string | string[];
        path?: string | string[];
        profileId?: string;
        spawnServerId?: string;
        automation?: string;
        automationEnabled?: string;
        automationName?: string;
        automationDescription?: string;
        automationScheduleKind?: string;
        automationEveryMinutes?: string;
        automationCronExpr?: string;
        automationTimezone?: string;
        automationEditId?: string;
        resumeSessionId?: string;
        secretId?: string;
        secretSessionOnlyId?: string;
        secretRequirementResultId?: string;
    }>();
    const generatedDataIdRef = React.useRef<string>(randomUUID());
    const effectiveDataId = React.useMemo(() => {
        if (typeof dataId === 'string' && dataId.trim().length > 0) {
            return dataId.trim();
        }
        return generatedDataIdRef.current;
    }, [dataId]);

    const recentMachinePaths = useSetting('recentMachinePaths');
    const lastUsedAgent = useSetting('lastUsedAgent');
    const lastUsedBackendTarget = useSetting('lastUsedBackendTarget');
    const newSessionDefaultPersistenceModeV1 = useSetting('newSessionDefaultPersistenceModeV1');
    const newSessionDefaultPersistenceModeByTargetKeyV1 = useSetting('newSessionDefaultPersistenceModeByTargetKeyV1');

    // A/B Test Flag - determines which wizard UI to show
    // Control A (false): Simpler AgentInput-driven layout
    // Variant B (true): Enhanced profile-first wizard with sections
    const useEnhancedSessionWizard = useSetting('useEnhancedSessionWizard');

    useNewSessionHappyRouteFlag(pathname);

    const sessionPromptInputMaxHeight = React.useMemo(() => {
        return computeNewSessionInputMaxHeight({
            useEnhancedSessionWizard,
            screenHeight,
            keyboardHeight,
        });
    }, [keyboardHeight, screenHeight, useEnhancedSessionWizard]);
    const useProfiles = useSetting('useProfiles');
    const [secrets, setSecrets] = useSettingMutable('secrets');
    const [secretBindingsByProfileId, setSecretBindingsByProfileId] = useSettingMutable('secretBindingsByProfileId');
    const sessionDefaultPermissionModeByTargetKey = useSetting('sessionDefaultPermissionModeByTargetKey');
    const settings = useSettings() ?? settingsDefaults;
    const accountProfile = useAccountProfile();
    const [activeServerSnapshot, setActiveServerSnapshot] = React.useState(() => getActiveServerSnapshot());
    React.useEffect(() => {
        return subscribeActiveServer((snapshot) => {
            setActiveServerSnapshot(snapshot);
        });
    }, []);
    const {
        serverProfiles,
        serverTargets,
        resolvedSettingsTarget,
        allowedTargetServerIds,
        targetServerId,
        targetServerProfile,
        targetServerName,
        showServerPickerChip,
    } = useNewSessionServerTargetState({
        settings,
        activeServerSnapshot,
        request: {
            spawnServerIdParam,
        },
    });
    // New-session capability gating should be evaluated in spawn scope (target server),
    // not in main selection scope (which can be a multi-server group).
    const automationsSupport = useAutomationsSupport({ scopeKind: 'spawn', serverId: targetServerId });
    const automationFeatureEnabled = automationsSupport?.enabled === true;

    const capabilityServerId = React.useMemo(() => {
        return resolveNewSessionCapabilityServerId({
            targetServerId,
            activeServerId: activeServerSnapshot.serverId,
        });
    }, [activeServerSnapshot.serverId, targetServerId]);
    const directSessionsFeatureEnabled = useFeatureEnabled('sessions.direct', { scopeKind: 'spawn', serverId: targetServerId });
    const useMachinePickerSearch = useSetting('useMachinePickerSearch');
    const usePathPickerSearch = useSetting('usePathPickerSearch');
    const [profiles, setProfiles] = useSettingMutable('profiles');
    const lastUsedProfile = useSetting('lastUsedProfile');
    const [favoriteDirectories, setFavoriteDirectories] = useSettingMutable('favoriteDirectories');
    const [favoriteMachines, setFavoriteMachines] = useSettingMutable('favoriteMachines');
    const [favoriteProfileIds, setFavoriteProfileIds] = useSettingMutable('favoriteProfiles');
    const [dismissedCLIWarnings, setDismissedCLIWarnings] = useSettingMutable('dismissedCLIWarnings');

    // Try to get data from temporary store first
    const tempSessionData = React.useMemo(() => {
        if (dataId) {
            return getTempData<NewSessionData>(dataId);
        }
        return null;
    }, [dataId]);

    // Load persisted draft state (survives remounts/screen navigation)
    const [persistedDraft, setPersistedDraft] = React.useState(() => loadNewSessionDraft());
    const hydratedTempAuthoringDraft = React.useMemo(() => {
        return tempSessionData
            ? buildNewSessionAuthoringDraftFromTempData(tempSessionData)
            : null;
    }, [tempSessionData]);
    const hydratedPersistedAuthoringDraft = React.useMemo(() => {
        return persistedDraft
            ? buildNewSessionAuthoringDraftFromPersistedDraft(persistedDraft)
            : null;
    }, [persistedDraft]);
    const hydratedResumeSessionId = React.useMemo(() => {
        if (typeof hydratedTempAuthoringDraft?.resumeSessionId === 'string') {
            return hydratedTempAuthoringDraft.resumeSessionId;
        }
        if (typeof hydratedPersistedAuthoringDraft?.resumeSessionId === 'string') {
            return hydratedPersistedAuthoringDraft.resumeSessionId;
        }
        return typeof resumeSessionIdParam === 'string' ? resumeSessionIdParam : '';
    }, [hydratedPersistedAuthoringDraft?.resumeSessionId, hydratedTempAuthoringDraft?.resumeSessionId, resumeSessionIdParam]);
    const [resumeSessionId, setResumeSessionId] = React.useState(hydratedResumeSessionId);

    const [agentNewSessionOptionStateByAgentId, setAgentNewSessionOptionStateByAgentId] = React.useState<
        Record<string, Record<string, unknown>>
    >(() => {
        const temp = tempSessionData?.agentNewSessionOptionStateByAgentId;
        if (temp && typeof temp === 'object') {
            return temp as Record<string, Record<string, unknown>>;
        }
        const raw = (persistedDraft as any)?.agentNewSessionOptionStateByAgentId;
        return raw && typeof raw === 'object' ? (raw as Record<string, Record<string, unknown>>) : {};
    });
    const enabledAgentIds = useEnabledAgentIds();
    const resolvedBackendEntries = React.useMemo(() => {
        return getResolvedBackendCatalogEntries({
            enabledAgentIds,
            acpCatalogSettingsV1: settings.acpCatalogSettingsV1,
            backendEnabledByTargetKey: settings.backendEnabledByTargetKey,
            collapseConfiguredBackendProviderSentinels: true,
        });
    }, [enabledAgentIds, settings.acpCatalogSettingsV1, settings.backendEnabledByTargetKey]);

    useFocusEffect(
        React.useCallback(() => {
            setPersistedDraft(loadNewSessionDraft());
            // Ensure newly-registered machines show up without requiring an app restart.
            // Throttled to avoid spamming the server when navigating back/forth.
            // Defer until after interactions so the screen feels instant on iOS.
            InteractionManager.runAfterInteractions(() => {
                fireAndForget(sync.refreshMachinesThrottled({ staleMs: 15_000 }), { tag: 'NewSessionScreenModel.refreshMachinesThrottled.focus' });
            });
        }, [])
    );

    // (prefetch effect moved below, after machines/recent/favorites are defined)

    // Combined profiles (built-in + custom)
    const allProfiles = React.useMemo(() => {
        const builtInProfiles = DEFAULT_PROFILES.map(bp => getBuiltInProfile(bp.id)!);
        return [...builtInProfiles, ...profiles];
    }, [profiles]);

    const profileMap = useProfileMap(allProfiles);
    const machines = useAllMachines();
    const hasExplicitSeededProfileSelection = React.useMemo(() => {
        if (!useProfiles) {
            return false;
        }
        const tempProfileId = typeof hydratedTempAuthoringDraft?.profileId === 'string'
            ? hydratedTempAuthoringDraft.profileId.trim()
            : '';
        if (tempProfileId.length > 0) {
            return true;
        }
        const draftProfileId = hydratedPersistedAuthoringDraft?.profileId;
        return Boolean(draftProfileId && profileMap.has(draftProfileId));
    }, [hydratedPersistedAuthoringDraft?.profileId, hydratedTempAuthoringDraft?.profileId, profileMap, useProfiles]);
    const initialImplicitProfileId = React.useMemo(() => {
        if (!useProfiles) {
            return null;
        }
        const tempProfileId = typeof hydratedTempAuthoringDraft?.profileId === 'string'
            ? hydratedTempAuthoringDraft.profileId.trim()
            : '';
        if (tempProfileId.length > 0) {
            return tempProfileId;
        }
        const draftProfileId = hydratedPersistedAuthoringDraft?.profileId;
        if (draftProfileId && profileMap.has(draftProfileId)) {
            return draftProfileId;
        }
        if (lastUsedProfile && profileMap.has(lastUsedProfile)) {
            return lastUsedProfile;
        }
        return null;
    }, [hydratedPersistedAuthoringDraft?.profileId, hydratedTempAuthoringDraft?.profileId, lastUsedProfile, profileMap, useProfiles]);

    // Wizard state
    const [selectedProfileId, setSelectedProfileId] = React.useState<string | null>(() => initialImplicitProfileId);
    const hasUserTouchedProfileSelectionRef = React.useRef<boolean>(hasExplicitSeededProfileSelection);

    React.useEffect(() => {
        if (!useProfiles && selectedProfileId !== null) {
            setSelectedProfileId(null);
        }
    }, [useProfiles, selectedProfileId]);

    React.useEffect(() => {
        if (!useProfiles) return;
        if (!selectedProfileId) return;
        const selected = profileMap.get(selectedProfileId) ?? getBuiltInProfile(selectedProfileId);
        if (!selected) {
            setSelectedProfileId(null);
            return;
        }
        if (resolvedBackendEntries.some((entry) => isProfileCompatibleWithBackendTarget(selected, entry.target))) {
            return;
        }
        setSelectedProfileId(null);
    }, [profileMap, resolvedBackendEntries, selectedProfileId, useProfiles]);
    // AgentInput autocomplete is unused on this screen today, but passing a new
    // function/array each render forces autocomplete hooks to re-sync.
    // Keep these stable to avoid unnecessary work during taps/selection changes.
    const emptyAutocompletePrefixes = React.useMemo(() => [], []);
    const emptyAutocompleteSuggestions = React.useCallback(async () => [], []);

    const effectiveMachineIdParam = React.useMemo(() => {
        const normalizedMachineIdParam = normalizeOptionalParam(machineIdParam);
        const raw = typeof normalizedMachineIdParam === 'string' ? normalizedMachineIdParam.trim() : '';
        if (raw) return raw;
        const temp = typeof tempSessionData?.machineId === 'string' ? tempSessionData.machineId.trim() : '';
        if (temp) return temp;
        const draft = typeof persistedDraft?.selectedMachineId === 'string' ? persistedDraft.selectedMachineId.trim() : '';
        if (draft) return draft;
        return null;
    }, [machineIdParam, persistedDraft?.selectedMachineId, tempSessionData?.machineId]);

    const effectivePathParam = React.useMemo(() => {
        const normalizedDirectoryParam = normalizeOptionalParam(directoryParam);
        const directory = typeof normalizedDirectoryParam === 'string' ? normalizedDirectoryParam.trim() : '';
        if (directory) return directory;

        const normalizedPathParam = normalizeOptionalParam(pathParam);
        const raw = typeof normalizedPathParam === 'string' ? normalizedPathParam.trim() : '';
        if (raw) return raw;
        const temp = typeof hydratedTempAuthoringDraft?.directory === 'string' ? hydratedTempAuthoringDraft.directory.trim() : '';
        if (temp) return temp;

        const draftPath = typeof hydratedPersistedAuthoringDraft?.directory === 'string' ? hydratedPersistedAuthoringDraft.directory.trim() : '';
        if (!draftPath) return null;

        // If this navigation explicitly targets a different machine, avoid applying the old draft path (machine-scoped).
        const normalizedMachineIdParam = normalizeOptionalParam(machineIdParam);
        if (typeof normalizedMachineIdParam === 'string' && normalizedMachineIdParam.trim().length > 0) {
            const draftMachineId = typeof persistedDraft?.selectedMachineId === 'string' ? persistedDraft.selectedMachineId.trim() : '';
            if (draftMachineId && draftMachineId !== normalizedMachineIdParam.trim()) {
                return null;
            }
        }

        return draftPath;
    }, [directoryParam, hydratedPersistedAuthoringDraft?.directory, hydratedTempAuthoringDraft?.directory, machineIdParam, pathParam, persistedDraft?.selectedMachineId]);

    const effectiveWorktreeRouteMode = React.useMemo(() => {
        const normalizedWorktreeParam = normalizeOptionalParam(worktreeParam);
        const raw = typeof normalizedWorktreeParam === 'string' ? normalizedWorktreeParam.trim() : '';
        return raw || null;
    }, [worktreeParam]);

    const { backendTarget, setBackendTarget, builtInAgentId: agentType } = useNewSessionBackendTargetState({
        entries: resolvedBackendEntries,
        lastUsedAgent,
        lastUsedBackendTarget,
        persistedBackendTarget: hydratedPersistedAuthoringDraft?.backendTarget,
        tempBackendTarget: hydratedTempAuthoringDraft?.backendTarget ?? tempSessionData?.backendTarget,
        tempAgentType: hydratedTempAuthoringDraft?.agentId ?? hydratedPersistedAuthoringDraft?.agentId,
    });
    const setAgentType = React.useCallback((next: React.SetStateAction<AgentId>) => {
        setBackendTarget((prevTarget) => {
            const prevAgentId = resolveBuiltInAgentIdForBackendTarget(prevTarget);
            const nextAgentId = typeof next === 'function' ? next(prevAgentId) : next;
            return { kind: 'builtInAgent', agentId: nextAgentId };
        });
    }, [setBackendTarget]);
    const selectedBackendTargetKey = React.useMemo(() => buildBackendTargetKey(backendTarget), [backendTarget]);
    const selectedBackendEntry = React.useMemo(() => {
        return resolvedBackendEntries.find((entry) => entry.targetKey === selectedBackendTargetKey) ?? null;
    }, [resolvedBackendEntries, selectedBackendTargetKey]);
    const agentLabel = selectedBackendEntry?.title ?? t(getAgentCore(agentType).displayNameKey);

    const {
        modelMode,
        setModelMode,
        acpSessionModeId,
        setAcpSessionModeId,
        sessionConfigOptionOverrides,
        setSessionConfigOptionOverrides,
        setAcpConfigOptionOverride,
        mcpSelection,
        setMcpSelection,
    } = useNewSessionAgentAuthoringOptionsState({
        agentType,
        hydratedTempAuthoringDraft,
        hydratedPersistedAuthoringDraft,
    });

    const {
        selectedMachineId,
        setSelectedMachineId,
        selectedPath,
        setSelectedPath,
        getBestPathForMachine,
    } = useNewSessionMachinePathState({
        machines,
        recentMachinePaths,
        machineIdParam: effectiveMachineIdParam,
        pathParam: effectivePathParam,
    });
    const [pathPickerSearchQuery, setPathPickerSearchQuery] = React.useState('');
    const repoScmSnapshot = useNewSessionRepoScmSnapshot({
        machineId: selectedMachineId,
        path: selectedPath,
    });
    const {
        checkoutCreationDraft,
        setCheckoutCreationDraft,
        checkoutPickerOpen,
        setCheckoutPickerOpen,
        pendingGitWorktreeBaseRefRef,
        pendingGitWorktreeSourceKindRef,
        shouldReconcileInitialHydratedCheckoutCreationDraftRef,
        checkoutChipModel,
    } = useNewSessionCheckoutSelectionState({
        persistedDraft,
        hydratedTempAuthoringDraft,
        hydratedPersistedAuthoringDraft,
        selectedMachineId,
        selectedPath,
        repoScmSnapshot,
        autoOpenWorktreePickerKey: effectiveWorktreeRouteMode === 'new'
            ? `route:new:${selectedMachineId ?? ''}:${selectedPath}`
            : null,
    });
    const selectedMachine = React.useMemo(() => {
        if (!selectedMachineId) return null;
        return machines.find(m => m.id === selectedMachineId) ?? null;
    }, [selectedMachineId, machines]);
    const {
        cliAvailability,
        selectedMachineCapabilities,
        selectedMachineCapabilitiesSnapshot,
        tmuxRequested,
        showResumePicker,
        wizardInstallableDeps,
        installableDepKeyCountByAgentId,
        selectableWithoutCliByAgentId,
        isAgentSelectable,
        isBackendEntrySelectable,
        isCliBannerDismissed,
        dismissCliBanner,
        getCompatibleProfileBackendEntries,
        profileAvailabilityById,
        selectedMachineIsWindows,
        windowsTerminalAvailable,
    } = useNewSessionAvailabilityState({
        selectedMachineId,
        selectedMachine,
        capabilityServerId,
        settings,
        agentType,
        resumeSessionId,
        enabledAgentIds,
        agentNewSessionOptionStateByAgentId,
        resolvedBackendEntries,
        selectedBackendEntry,
        setBackendTarget,
        machines,
        dismissedCliWarnings: dismissedCLIWarnings,
        setDismissedCliWarnings: setDismissedCLIWarnings,
        allProfiles,
    });
    const refreshCliAvailability = React.useCallback(() => {
        void cliAvailability.refresh({ bypassCache: true });
    }, [cliAvailability.refresh]);
    React.useEffect(() => {
        if (!useProfiles) {
            return;
        }
        if (hasUserTouchedProfileSelectionRef.current) {
            return;
        }

        const nextProfileId = initialImplicitProfileId;
        if (selectedProfileId === nextProfileId) {
            return;
        }
        setSelectedProfileId(nextProfileId);
    }, [initialImplicitProfileId, selectedProfileId, useProfiles]);
    const { preflightModels, modelOptions, probe: modelOptionsProbeState } = useNewSessionPreflightModelsState({
        backendTarget,
        selectedMachineId,
        capabilityServerId,
        cwd: selectedPath,
        probeContext: resolveNewSessionCapabilityProbeContext({ backendTarget, settings }),
    });

    const { preflightModes: preflightSessionModes, modeOptions: acpSessionModeOptions, probe: acpSessionModeProbeState } =
        useNewSessionPreflightSessionModesState({
            backendTarget,
            selectedMachineId,
            capabilityServerId,
            cwd: selectedPath,
            probeContext: resolveNewSessionCapabilityProbeContext({ backendTarget, settings }),
        });
    const { configOptions: acpConfigOptions, probe: acpConfigOptionsProbeState } = useNewSessionPreflightConfigOptionsState({
        backendTarget,
        selectedMachineId,
        capabilityServerId,
        cwd: selectedPath,
        probeContext: resolveNewSessionCapabilityProbeContext({ backendTarget, settings }),
    });

    const allProfilesRequirementNames = React.useMemo(() => {
        const names = new Set<string>();
        for (const p of allProfiles) {
            for (const req of p.envVarRequirements ?? []) {
                const name = typeof req?.name === 'string' ? req.name : '';
                if (name) names.add(name);
            }
        }
        return Array.from(names);
    }, [allProfiles]);

    const machineEnvPresence = useMachineEnvPresence(
        selectedMachineId ?? null,
        allProfilesRequirementNames,
        { ttlMs: 5 * 60_000, serverId: capabilityServerId },
    );
    const refreshMachineEnvPresence = machineEnvPresence.refresh;

    //
    // Path selection
    //

    const {
        sessionPrompt,
        setSessionPrompt,
        automationDraft,
        setAutomationDraft,
        automationEditId,
        automationRequestedByRoute,
    } = useNewSessionPromptAutomationState({
        prompt,
        dataId,
        automationParam,
        automationEnabledParam,
        automationNameParam,
        automationDescriptionParam,
        automationScheduleKindParam,
        automationEveryMinutesParam,
        automationCronExprParam,
        automationTimezoneParam,
        automationEditIdParam,
        automationFeatureEnabled,
        persistedDraftEntryIntent: persistedDraft?.entryIntent,
        hydratedTempAuthoringDraft,
        hydratedPersistedAuthoringDraft,
    });
    const [isCreating, setIsCreating] = React.useState(false);
    const [isResumeSupportChecking, setIsResumeSupportChecking] = React.useState(false);

    React.useEffect(() => {
        setResumeSessionId(hydratedResumeSessionId);
    }, [hydratedResumeSessionId]);

    // Handle resumeSessionId param from the resume picker screen
    React.useEffect(() => {
        if (typeof resumeSessionIdParam !== 'string') {
            return;
        }
        setResumeSessionId(resumeSessionIdParam);
    }, [resumeSessionIdParam]);

    // Computed values
    const compatibleProfiles = React.useMemo(() => {
        return allProfiles.filter((profile) => isProfileCompatibleWithBackendTarget(profile, backendTarget));
    }, [allProfiles, backendTarget]);
    const selectedProfile = React.useMemo(() => {
        if (!selectedProfileId) {
            return null;
        }
        if (profileMap.has(selectedProfileId)) {
            return profileMap.get(selectedProfileId)!;
        }
        return getBuiltInProfile(selectedProfileId);
    }, [selectedProfileId, profileMap]);

    const [windowsRemoteSessionLaunchModeOverride, setWindowsRemoteSessionLaunchModeOverride] =
        React.useState<WindowsRemoteSessionLaunchMode | null>(null);

    React.useEffect(() => {
        setWindowsRemoteSessionLaunchModeOverride(null);
    }, [selectedMachineId]);
    const effectiveWindowsRemoteSessionLaunchMode = React.useMemo(() => {
        return resolveEffectiveWindowsRemoteSessionLaunchMode({
            machineMetadata: selectedMachine?.metadata,
            settings,
            sessionOverride: windowsRemoteSessionLaunchModeOverride ?? undefined,
        }).mode;
    }, [selectedMachine?.metadata, settings, windowsRemoteSessionLaunchModeOverride]);
    const handleOpenMcpSettings = React.useCallback(() => {
        // `router.push` expects the public route (group segments like `/(app)` are not valid here on web).
        router.push('/settings/mcp' as any);
    }, [router]);
    const { mcpChip } = useNewSessionMcpSelection({
        selectedMachineId,
        selectedPath,
        selectedMachineName: selectedMachine?.metadata?.displayName || selectedMachine?.metadata?.host || null,
        agentType,
        targetServerId,
        mcpSelection,
        setMcpSelection,
        onOpenSettings: handleOpenMcpSettings,
    });

    const {
        selectedSecretIdByProfileIdByEnvVarName,
        setSelectedSecretIdByProfileIdByEnvVarName,
        sessionOnlySecretValueByProfileIdByEnvVarName,
        setSessionOnlySecretValueByProfileIdByEnvVarName,
        getSessionOnlySecretValueEncByProfileIdByEnvVarName,
        openSecretRequirementModal,
        prepareSecretPromptForProfileSelection,
        suppressNextSecretAutoPromptKeyRef,
        selectedSecretId,
        setSelectedSecretId,
        sessionOnlySecretValue,
        setSessionOnlySecretValue,
        selectedSavedSecret,
        activeSecretSource,
        secretRequirements,
        shouldShowSecretSection,
    } = useNewSessionSecretSelectionState({
        persistedDraft,
        selectedProfileId,
        selectedProfile,
        secretBindingsByProfileId,
        setSecretBindingsByProfileId,
        secrets,
        setSecrets,
        selectedMachineId,
        machineEnvPresence,
        useProfiles,
        setSelectedProfileId,
        router,
        navigation: navigation as any,
        secretIdParam: typeof secretIdParam === 'string' ? secretIdParam : undefined,
        secretSessionOnlyId: typeof secretSessionOnlyId === 'string' ? secretSessionOnlyId : undefined,
        secretRequirementResultId: typeof secretRequirementResultId === 'string' ? secretRequirementResultId : undefined,
    });

    // NOTE: we intentionally do NOT clear per-profile secret overrides when profile changes.
    // Users may resolve secrets for multiple profiles and then switch between them before creating a session.

    // On iOS, keep tap handlers extremely light so selection state can commit instantly.
    // We defer any follow-up adjustments (agent/session-type/permission defaults) until after interactions.
    const pendingProfileSelectionRef = React.useRef<{ profileId: string; prevProfileId: string | null } | null>(null);

    const selectProfile = React.useCallback((profileId: string) => {
        prepareSecretPromptForProfileSelection(selectedProfileId);
        const prevSelectedProfileId = selectedProfileId;
        hasUserTouchedProfileSelectionRef.current = true;
        pendingProfileSelectionRef.current = { profileId, prevProfileId: prevSelectedProfileId };
        setSelectedProfileId(profileId);
    }, [prepareSecretPromptForProfileSelection, selectedProfileId]);

    const onPressDefaultEnvironment = React.useCallback(() => {
        hasUserTouchedProfileSelectionRef.current = true;
        setSelectedProfileId(null);
    }, []);

    const {
        transcriptStorage,
        setTranscriptStorage,
        supportsDirectTranscriptStorage,
        hasUserSelectedTranscriptStorageRef,
    } = useNewSessionTranscriptStorageState({
        hydratedTempAuthoringDraft,
        hydratedPersistedAuthoringDraft,
        profileMap,
        selectedProfileId,
        newSessionDefaultPersistenceModeV1,
        newSessionDefaultPersistenceModeByTargetKeyV1,
        resolvedBackendTargets: resolvedBackendEntries.map((entry) => entry.target),
        agentType,
        backendTarget,
        settings,
        directSessionsFeatureEnabled,
    });
    const {
        permissionMode,
        hasUserSelectedPermissionModeRef,
        permissionModeRef,
        applyPermissionMode,
        handlePermissionModeChange,
        resolveDefaultPermissionMode,
    } = useNewSessionPermissionModeState({
        agentType,
        backendTarget,
        hydratedTempAuthoringDraft,
        hydratedPersistedAuthoringDraft,
        selectedProfileId,
        profileMap,
        enabledAgentIds,
        sessionDefaultPermissionModeByTargetKey,
    });

    // NOTE: Permission mode reset on agentType change is handled by the validation useEffect below (lines ~670-681)
    // which intelligently resets only when the current mode is invalid for the new agent type.
    // A duplicate unconditional reset here was removed to prevent race conditions.

    const handleDeleteProfile = React.useCallback((profile: AIBackendProfile) => {
        Modal.alert(
            t('profiles.delete.title'),
            t('profiles.delete.message', { name: profile.name }),
            [
                { text: t('profiles.delete.cancel'), style: 'cancel' },
                {
                    text: t('profiles.delete.confirm'),
                    style: 'destructive',
                    onPress: () => {
                        const updatedProfiles = profiles.filter((p: AIBackendProfile) => p.id !== profile.id);
                        setProfiles(updatedProfiles);
                        if (selectedProfileId === profile.id) {
                            setSelectedProfileId(null);
                        }
                    },
                },
            ],
        );
    }, [profiles, selectedProfileId, setProfiles]);

    const {
        refreshMachineData,
        recentMachines,
        favoriteMachineItems,
        recentPaths,
    } = useNewSessionMachineRefreshState({
        capabilityServerId,
        selectedMachineId,
        machines,
        recentMachinePaths,
        favoriteMachines,
        useEnhancedSessionWizard,
        refreshMachineEnvPresence,
    });

    const selectedServerId = targetServerId;
    const machinePopoverServerIds = allowedTargetServerIds.length > 0
        ? allowedTargetServerIds
        : resolvedSettingsTarget.allowedServerIds;
    const machinePopoverGroups = useServerScopedMachineOptions({
        allowedServerIds: machinePopoverServerIds,
        activeServerId: activeServerSnapshot.serverId,
        activeMachines: machines,
        refreshToken: activeServerSnapshot.generation,
    });

    const pathPopover = React.useMemo<AgentInputContentPopoverConfig>(() => ({
        renderContent: ({ requestClose }) => (
            <NewSessionPathSelectionContent
                machineHomeDir={selectedMachine?.metadata?.homeDir || '/home'}
                selectedPath={selectedPath}
                onChangeSelectedPath={setSelectedPath}
                submitBehavior="confirm"
                onSubmitSelectedPath={(nextPath) => {
                    setSelectedPath(nextPath);
                    requestClose();
                }}
                recentPaths={recentPaths}
                usePickerSearch={usePathPickerSearch}
                searchQuery={pathPickerSearchQuery}
                onChangeSearchQuery={setPathPickerSearchQuery}
                favoriteDirectories={favoriteDirectories}
                onChangeFavoriteDirectories={setFavoriteDirectories}
                focusInputOnSelect={false}
                machineBrowse={{
                    enabled: true,
                    machineId: selectedMachine?.id ?? null,
                    serverId: targetServerId ?? null,
                }}
            />
        ),
        maxHeightCap: 560,
        maxWidthCap: 560,
        keyboardShouldPersistTaps: 'handled',
        edgeFades: { top: true, bottom: true, size: 28 },
        edgeIndicators: true,
        initialVisibility: { top: true, bottom: true },
    }), [
        favoriteDirectories,
        pathPickerSearchQuery,
        recentPaths,
        selectedMachine?.id,
        selectedMachine?.metadata?.homeDir,
        selectedPath,
        setFavoriteDirectories,
        setSelectedPath,
        targetServerId,
        usePathPickerSearch,
    ]);

    const machinePopover = React.useMemo<AgentInputContentPopoverConfig>(() => ({
        renderContent: ({ requestClose }) => (
            <NewSessionMachineSelectionContent
                groups={machinePopoverGroups}
                selectedMachine={selectedMachine ?? null}
                selectedServerId={selectedServerId}
                recentMachines={recentMachines}
                favoriteMachines={favoriteMachineItems}
                serverId={selectedServerId}
                onSelectMachine={(machine) => {
                    setSelectedMachineId(machine.id);
                    setSelectedPath(getBestPathForMachine(machine.id));
                    requestClose();
                }}
                onSelectScopedMachine={(machine) => {
                    setSelectedMachineId(machine.id);
                    setSelectedPath(getBestPathForMachine(machine.id));
                    requestClose();
                }}
                showSearch={useMachinePickerSearch}
                searchPlacement="header"
                testIdPrefix="new-session-machine"
            />
        ),
        maxHeightCap: 560,
        maxWidthCap: 560,
        keyboardShouldPersistTaps: 'handled',
        edgeFades: { top: true, bottom: true, size: 28 },
        edgeIndicators: true,
        initialVisibility: { top: true, bottom: true },
    }), [
        favoriteMachineItems,
        getBestPathForMachine,
        machinePopoverGroups,
        recentMachines,
        selectedMachine,
        selectedServerId,
        setSelectedMachineId,
        setSelectedPath,
        useMachinePickerSearch,
    ]);

    React.useEffect(() => {
        if (!selectedProfileId) return;
        const pending = pendingProfileSelectionRef.current;
        if (!pending || pending.profileId !== selectedProfileId) return;
        pendingProfileSelectionRef.current = null;

        InteractionManager.runAfterInteractions(() => {
            // Ensure nothing changed while we waited.
            if (selectedProfileId !== pending.profileId) return;

            const profile = profileMap.get(pending.profileId) || getBuiltInProfile(pending.profileId);
            if (!profile) return;

            const compatibleBackendEntries = getCompatibleProfileBackendEntries(profile);
            const currentCompatible = compatibleBackendEntries.some((entry) => entry.targetKey === selectedBackendTargetKey);

            if (compatibleBackendEntries.length > 0 && !currentCompatible) {
                const nextEntry = resolveNextSelectableBackendEntryForNewSession({
                    candidateBackendEntries: compatibleBackendEntries,
                    currentTargetKey: selectedBackendTargetKey,
                    detectionTimestamp: cliAvailability.timestamp,
                    availabilityById: cliAvailability.available,
                    installableDepKeyCountByAgentId,
                    selectableWithoutCliByAgentId,
                });
                if (nextEntry) {
                    setBackendTarget(nextEntry.target);
                }
            }

            if (!hasUserSelectedPermissionModeRef.current) {
                applyPermissionMode(resolveDefaultPermissionMode(profile), 'auto');
            }
        });
    }, [
        agentType,
        applyPermissionMode,
        resolveDefaultPermissionMode,
        cliAvailability.available,
        cliAvailability.timestamp,
        installableDepKeyCountByAgentId,
        selectableWithoutCliByAgentId,
        getCompatibleProfileBackendEntries,
        profileMap,
        selectedProfileId,
        selectedBackendTargetKey,
        setBackendTarget,
    ]);

    // Keep ProfilesList props stable to avoid rerendering the whole list on
    // unrelated state updates (iOS perf).
    const profilesGroupTitles = React.useMemo(() => {
        return {
            favorites: t('profiles.groups.favorites'),
            custom: t('profiles.groups.custom'),
            builtIn: t('profiles.groups.builtIn'),
        };
    }, []);

    const getProfileDisabled = React.useCallback((profile: { id: string }) => {
        return !(profileAvailabilityById.get(profile.id) ?? { available: true }).available;
    }, [profileAvailabilityById]);

    const getProfileSubtitleExtra = React.useCallback((profile: { id: string }) => {
        const availability = profileAvailabilityById.get(profile.id) ?? { available: true };
        if (availability.available || !availability.reason) return null;
        if (availability.reason.startsWith('requires-agent:')) {
            const required = availability.reason.split(':')[1];
            const agentLabel = isAgentId(required) ? t(getAgentCore(required).displayNameKey) : required;
            return t('newSession.profileAvailability.requiresAgent', { agent: agentLabel });
        }
        if (availability.reason.startsWith('cli-not-detected:')) {
            const cli = availability.reason.split(':')[1];
            const agentFromCli = resolveAgentIdFromCliDetectKey(cli);
            const cliLabel = agentFromCli ? t(getAgentCore(agentFromCli).displayNameKey) : cli;
            return t('newSession.profileAvailability.cliNotDetected', { cli: cliLabel });
        }
        return availability.reason;
    }, [profileAvailabilityById]);

    const onPressProfile = React.useCallback((profile: { id: string }) => {
        const availability = profileAvailabilityById.get(profile.id) ?? { available: true };
        if (!availability.available) return;
        selectProfile(profile.id);
    }, [profileAvailabilityById, selectProfile]);

    // Handle profile route param from picker screens
    React.useEffect(() => {
        if (!useProfiles) {
            return;
        }

        const { nextSelectedProfileId, shouldClearParam } = consumeProfileIdParam({
            profileIdParam,
            selectedProfileId,
        });

        if (nextSelectedProfileId === null) {
            if (selectedProfileId !== null) {
                setSelectedProfileId(null);
            }
        } else if (typeof nextSelectedProfileId === 'string') {
            selectProfile(nextSelectedProfileId);
        }

        if (shouldClearParam) {
            const setParams = (navigation as any)?.setParams;
            if (typeof setParams === 'function') {
                setParams({ profileId: undefined });
            } else {
                navigation.dispatch({
                    type: 'SET_PARAMS',
                    payload: { params: { profileId: undefined } },
                } as never);
            }
        }
    }, [navigation, profileIdParam, selectedProfileId, selectProfile, setSelectedProfileId, useProfiles]);

    // Keep agentType compatible with the currently selected profile.
    React.useEffect(() => {
        if (!useProfiles || selectedProfileId === null) {
            return;
        }

        const profile = profileMap.get(selectedProfileId) || getBuiltInProfile(selectedProfileId);
        if (!profile) {
            return;
        }

        const compatibleBackendEntries = getCompatibleProfileBackendEntries(profile);
        const currentCompatible = compatibleBackendEntries.some((entry) => entry.targetKey === selectedBackendTargetKey);

        if (compatibleBackendEntries.length > 0 && !currentCompatible) {
            setBackendTarget(compatibleBackendEntries[0]!.target);
        }
    }, [getCompatibleProfileBackendEntries, profileMap, selectedBackendTargetKey, selectedProfileId, setBackendTarget, useProfiles]);

    const prevAgentTypeRef = React.useRef(agentType);

    // When agent type changes, keep the "permission level" consistent by mapping modes across backends.
    React.useEffect(() => {
        const prev = prevAgentTypeRef.current;
        if (prev === agentType) {
            return;
        }
        prevAgentTypeRef.current = agentType;

        // Defaults should only apply in the new-session flow (not in existing sessions),
        // and only if the user hasn't explicitly chosen a mode on this screen.
        if (!hasUserSelectedPermissionModeRef.current) {
            const profile = selectedProfileId ? (profileMap.get(selectedProfileId) || getBuiltInProfile(selectedProfileId)) : null;
            applyPermissionMode(resolveDefaultPermissionMode(profile), 'auto');
            return;
        }

        const current = permissionModeRef.current;
        const mapped = normalizePermissionModeForAgentType(current, agentType);
        applyPermissionMode(mapped, 'auto');
    }, [
        agentType,
        applyPermissionMode,
        profileMap,
        resolveDefaultPermissionMode,
        selectedProfileId,
    ]);

    // Reset model mode when agent type changes to appropriate default
    React.useEffect(() => {
        const core = getAgentCore(agentType);
        const next = coerceNewSessionModelMode({
            modelMode: String(modelMode),
            modelConfig: { defaultMode: core.model.defaultMode, allowedModes: core.model.allowedModes, supportsFreeform: core.model.supportsFreeform },
            preflight: preflightModels
                ? {
                    availableModels: preflightModels.availableModels.map((m) => ({ id: m.id })),
                    supportsFreeform: preflightModels.supportsFreeform === true,
                }
                : null,
        });
        if (next !== modelMode) {
            setModelMode(next as ModelMode);
        }
    }, [agentType, modelMode, preflightModels]);

    const {
        agentPickerOptions,
        handleAgentPickerSelect,
        handleAgentClick,
    } = useNewSessionAgentPickerControls({
        useProfiles,
        selectedProfileId,
        profileMap,
        resolvedBackendEntries,
        getCompatibleProfileBackendEntries,
        isBackendEntrySelectable,
        selectedBackendEntry,
        selectedBackendTargetKey,
        setBackendTarget,
        modelMode,
        setModelMode,
        acpSessionModeId,
        setAcpSessionModeId,
        sessionConfigOptionOverrides,
        setSessionConfigOptionOverrides,
        selectedMachineId,
        capabilityServerId,
        selectedPath,
        settings,
    });

    const agentOptionState = agentNewSessionOptionStateByAgentId[selectedBackendTargetKey] ?? null;
    const agentCore = React.useMemo(() => getAgentCore(agentType), [agentType]);

    const setAgentOptionStateForCurrentAgent = React.useCallback((key: string, value: unknown) => {
        setAgentNewSessionOptionStateByAgentId((prev) => {
            const current = prev[selectedBackendTargetKey] ?? {};
            const nextForTarget = { ...current, [key]: value };
            return { ...prev, [selectedBackendTargetKey]: nextForTarget };
        });
    }, [selectedBackendTargetKey]);

    const { connectedServicesBindingsPayload, connectedServicesAuthChip } = useNewSessionConnectedServices({
        agentCore,
        agentOptionState,
        settings,
        router,
        setAgentOptionStateForCurrentAgent,
    });

    const agentNewSessionOptions = React.useMemo(() => {
        const base = buildNewSessionOptionsFromUiState({ agentId: agentType, agentOptionState }) ?? {};
        const merged: Record<string, unknown> = { ...base };
        if (connectedServicesBindingsPayload) {
            merged.connectedServices = connectedServicesBindingsPayload;
        }
        return Object.keys(merged).length > 0 ? merged : null;
    }, [agentOptionState, agentType, connectedServicesBindingsPayload]);

    const resumePopover = React.useMemo<AgentInputContentPopoverConfig>(() => {
        const browseEnabled = Boolean(selectedMachineId) && canBrowseDirectSessions(agentType);

        return {
            renderContent: ({ requestClose }) => (
                <NewSessionResumeSelectionContent
                    value={resumeSessionId}
                    onChangeValue={setResumeSessionId}
                    onSave={(nextValue) => {
                        setResumeSessionId(nextValue);
                        requestClose();
                    }}
                    onClear={() => {
                        setResumeSessionId('');
                        requestClose();
                    }}
                    onClose={requestClose}
                    agentType={agentType}
                    maxHeight={460}
                    showInlineHeader={false}
                    resumeBrowse={browseEnabled ? {
                        enabled: true,
                        onBrowse: async () => {
                            if (!selectedMachineId) return null;
                            const source = resolveDirectBrowseLockedSource({
                                providerId: agentType as any,
                                agentOptionState,
                                profile: accountProfile,
                                settings,
                            });
                            if (!source) return null;
                            return await openDirectSessionsResumeIdPickerModal({
                                lockScope: {
                                    machineId: selectedMachineId,
                                    serverId: targetServerId ?? null,
                                    providerId: agentType as any,
                                    source,
                                },
                                title: t('directSessions.browseTitle'),
                            });
                        },
                    } : null}
                />
            ),
            maxHeightCap: 460,
            maxWidthCap: 460,
        };
    }, [
        accountProfile,
        agentOptionState,
        agentType,
        resumeSessionId,
        selectedMachineId,
        settings,
        targetServerId,
    ]);

    const {
        authoringContext: newSessionAuthoringContext,
        currentAuthoringDraft,
        effectiveAutomationDraft,
        canCreate,
        buildCurrentPersistedDraft,
        persistDraftIfEnabled,
        disableDraftPersistence,
        draftPersistenceEnabled,
        draftPersistenceGenerationRef,
    } = useNewSessionAuthoringState({
        automationDraft,
        automationFeatureEnabled,
        selectedMachineId,
        selectedMachine,
        selectedPath,
        checkoutCreationDraft,
        sessionPrompt,
        agentType,
        backendTarget,
        transcriptStorage,
        useProfiles,
        selectedProfileId,
        resumeSessionId,
        permissionMode,
        modelMode,
        mcpSelection,
        agentNewSessionOptions,
        settings,
        effectiveWindowsRemoteSessionLaunchMode: effectiveWindowsRemoteSessionLaunchMode ?? null,
        acpSessionModeId,
        sessionConfigOptionOverrides,
        automationEditId,
        automationRequestedByRoute,
        selectedSecretId,
        selectedSecretIdByProfileIdByEnvVarName,
        getSessionOnlySecretValueEncByProfileIdByEnvVarName: () => getSessionOnlySecretValueEncByProfileIdByEnvVarName() ?? {},
        agentNewSessionOptionStateByAgentId,
    });

    const { handleCreateSession } = useCreateNewSession({
        router,
        selectedMachineId,
        selectedPath,
        selectedMachine,
        setIsCreating,
        setIsResumeSupportChecking,
        checkoutCreationDraft,
        transcriptStorage,
        settings,
        useProfiles,
        selectedProfileId,
        profileMap,
        recentMachinePaths,
        agentType,
        backendTarget,
        permissionMode,
        modelMode,
        acpSessionModeId,
        sessionConfigOptionOverrides,
        sessionPrompt,
        automationEditId,
        resumeSessionId,
        agentNewSessionOptions,
        authoringDraft: currentAuthoringDraft,
        mcpSelection,
        windowsRemoteSessionLaunchModeOverride,
        machineEnvPresence,
        secrets,
        secretBindingsByProfileId,
        selectedSecretIdByProfileIdByEnvVarName,
        sessionOnlySecretValueByProfileIdByEnvVarName,
        selectedMachineCapabilities,
        targetServerId,
        allowedTargetServerIds: allowedTargetServerIds.length > 0 ? allowedTargetServerIds : resolvedSettingsTarget.allowedServerIds,
        disableDraftPersistence,
    });

    const {
        connectionStatus,
        automationSection,
        agentInputExtraActionChips,
    } = useNewSessionAgentInputPresentation({
        theme,
        selectedMachine,
        automationFeatureEnabled,
        automationDraft,
        effectiveAutomationDraft,
        setAutomationDraft,
        repoScmSnapshot,
        checkoutChipModel,
        checkoutPickerOpen,
        setCheckoutPickerOpen,
        checkoutCreationDraft,
        selectedMachineId,
        selectedPath,
        setSelectedPath,
        setCheckoutCreationDraft,
        pendingGitWorktreeBaseRefRef,
        pendingGitWorktreeSourceKindRef,
        shouldReconcileInitialHydratedCheckoutCreationDraftRef,
        router,
        sessionPrompt,
        setSessionPrompt,
        handleCreateSession,
        backendTarget,
        agentType,
        agentOptionState,
        setAgentOptionStateForCurrentAgent,
        connectedServicesAuthChip,
        showAutomationActionChips: newSessionAuthoringContext.showAutomationActionChips,
        showServerPickerChip,
        targetServerId,
        targetServerName,
        mcpChip,
        directSessionsFeatureEnabled,
        supportsDirectTranscriptStorage,
        transcriptStorage,
        hasUserSelectedTranscriptStorageRef,
        setTranscriptStorage,
        selectedMachineIsWindows,
        effectiveWindowsRemoteSessionLaunchMode: effectiveWindowsRemoteSessionLaunchMode ?? null,
        windowsTerminalAvailable,
        setWindowsRemoteSessionLaunchModeOverride,
    });

    const {
        openProfileEdit,
        handleAddProfile,
        handleDuplicateProfile,
    } = useNewSessionProfileEditPersistence({
        router,
        selectedMachineId,
        buildCurrentPersistedDraft,
        persistDraftIfEnabled,
        draftPersistenceEnabled,
        draftPersistenceGenerationRef,
    });

    const submitAccessibilityLabel = newSessionAuthoringContext.submitAccessibilityLabelKey
        ? t(newSessionAuthoringContext.submitAccessibilityLabelKey)
        : undefined;

    const {
        layout: wizardLayoutProps,
        profiles: wizardProfilesProps,
        agent: wizardAgentProps,
        machine: wizardMachineProps,
        footer: wizardFooterProps,
    } = useNewSessionWizardProps({
        theme,
        styles,
        safeAreaBottom: safeArea.bottom,
        headerHeight,
        newSessionSidePadding,
        newSessionBottomPadding,

        useProfiles,
        profiles,
        favoriteProfileIds,
        setFavoriteProfileIds,
        selectedProfileId,
        onPressDefaultEnvironment,
        onPressProfile,
        selectedMachineId,
        getProfileDisabled,
        getProfileSubtitleExtra,
        handleAddProfile,
        openProfileEdit,
        handleDuplicateProfile,
        handleDeleteProfile,
        suppressNextSecretAutoPromptKeyRef,
        openSecretRequirementModal,
        profilesGroupTitles,

        machineEnvPresence,
        secrets,
        secretBindingsByProfileId,
        selectedSecretIdByProfileIdByEnvVarName,
        sessionOnlySecretValueByProfileIdByEnvVarName,

        wizardInstallableDeps,
        selectedMachineCapabilities,
        targetServerId,

        cliAvailability,
        tmuxRequested,
        enabledAgentIds,
        isAgentSelectable,
        isCliBannerDismissed,
        dismissCliBanner,
        agentType,
        agentLabel,
        setAgentType,
        agentPickerTitle: t('newSession.selectAiBackendTitle'),
        agentPickerOptions,
        agentPickerSelectedOptionId: selectedBackendEntry?.targetKey ?? selectedBackendTargetKey,
        onAgentPickerSelect: handleAgentPickerSelect,
        modelOptions,
        modelOptionsProbe: {
            phase: modelOptionsProbeState.phase,
            onRefresh: modelOptionsProbeState.onRefresh,
        },
        acpSessionModeOptions,
        acpSessionModeProbe: {
            phase: acpSessionModeProbeState.phase,
            onRefresh: acpSessionModeProbeState.onRefresh,
        },
        acpSessionModeId,
        setAcpSessionModeId,
        acpConfigOptions: acpConfigOptions ?? undefined,
        acpConfigOptionsProbe: {
            phase: acpConfigOptionsProbeState.phase,
            onRefresh: acpConfigOptionsProbeState.onRefresh,
        },
        acpConfigOptionOverrides: sessionConfigOptionOverrides,
        setAcpConfigOptionOverride,
        modelMode,
        setModelMode,
        selectedIndicatorColor,
        profileMap,
        permissionMode,
        handlePermissionModeChange,

        machines,
        selectedMachine: selectedMachine ?? null,
        recentMachines,
        favoriteMachineItems,
        useMachinePickerSearch,
        refreshMachineData,
        setSelectedMachineId,
        getBestPathForMachine,
        setSelectedPath,
        pathPopover,
        favoriteMachines,
        setFavoriteMachines,
        selectedPath,
        recentPaths,
        usePathPickerSearch,
        favoriteDirectories,
        setFavoriteDirectories,

        sessionPrompt,
        setSessionPrompt,
        handleCreateSession,
        canCreate,
        isCreating,
        submitAccessibilityLabel,
        emptyAutocompletePrefixes,
        emptyAutocompleteSuggestions,
        connectionStatus,
        machinePopover,
        resumeSessionId,
        resumePopover,
        isResumeSupportChecking,
        sessionPromptInputMaxHeight,
        automationSection,
        agentInputExtraActionChips,
        attachmentFlowId: effectiveDataId,
    });

    const { profilePopover } = React.useMemo(() => {
        return buildNewSessionProfileSelectionPopover({
            useProfiles,
            profilesProps: wizardProfilesProps,
            serverId: targetServerId,
            machineName: selectedMachine?.metadata?.displayName || selectedMachine?.metadata?.host,
            popoverBoundaryRef,
        });
    }, [
        popoverBoundaryRef,
        selectedMachine?.metadata?.displayName,
        selectedMachine?.metadata?.host,
        targetServerId,
        useProfiles,
        wizardProfilesProps,
    ]);

    const simplePanelProps = useNewSessionSimplePanelProps({
        popoverBoundaryRef,
        headerHeight,
        safeAreaTop: safeArea.top,
        safeAreaBottom: safeArea.bottom,
        newSessionTopPadding: simpleNewSessionTopPadding,
        newSessionSidePadding: simpleNewSessionSidePadding,
        newSessionBottomPadding: simpleNewSessionBottomPadding,
        containerStyle: styles.container as any,
        sessionPrompt,
        setSessionPrompt,
        handleCreateSession,
        canCreate,
        isCreating,
        submitAccessibilityLabel,
        emptyAutocompletePrefixes,
        emptyAutocompleteSuggestions,
        sessionPromptInputMaxHeight,
        automationSection,
        agentType,
        agentLabel,
        handleAgentClick,
        agentPickerTitle: t('newSession.selectAiBackendTitle'),
        agentPickerOptions,
        agentPickerSelectedOptionId: selectedBackendEntry?.targetKey ?? selectedBackendTargetKey,
        onAgentPickerSelect: handleAgentPickerSelect,
        agentPickerProbe: buildCliAvailabilityProbeState({
            selectedMachineId,
            cliAvailability,
            onRefresh: refreshCliAvailability,
        }),
        permissionMode,
        handlePermissionModeChange,
        modelMode,
        setModelMode,
        modelOptions,
        modelOptionsProbe: {
            phase: modelOptionsProbeState.phase,
            onRefresh: modelOptionsProbeState.onRefresh,
        },
        acpSessionModeOptions,
        acpSessionModeProbe: {
            phase: acpSessionModeProbeState.phase,
            onRefresh: acpSessionModeProbeState.onRefresh,
        },
        acpSessionModeId,
        setAcpSessionModeId,
        acpConfigOptions: acpConfigOptions ?? undefined,
        acpConfigOptionsProbe: {
            phase: acpConfigOptionsProbeState.phase,
            onRefresh: acpConfigOptionsProbeState.onRefresh,
        },
        acpConfigOptionOverrides: sessionConfigOptionOverrides,
        setAcpConfigOptionOverride,
        connectionStatus,
        machineName: selectedMachine?.metadata?.displayName || selectedMachine?.metadata?.host,
        machinePopover,
        selectedPath,
        pathPopover,
        showResumePicker,
        resumeSessionId,
        resumePopover,
        isResumeSupportChecking,
        useProfiles,
        selectedProfileId,
        profilePopover,
        agentInputExtraActionChips,
        targetServerId,
        attachmentFlowId: effectiveDataId,
    });

    return buildNewSessionScreenVariantModel({
        useEnhancedSessionWizard,
        popoverBoundaryRef,
        simplePanelProps,
        checkoutCreationDraft,
        setCheckoutCreationDraft,
        wizardLayoutProps,
        wizardProfilesProps,
        wizardAgentProps,
        wizardMachineProps,
        wizardFooterProps,
    });
}
