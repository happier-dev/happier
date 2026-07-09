import React from 'react';
import { Platform, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLaunchSelectionMachines, useMachineListByServerId, useSessions, storage, useSetting, useSettingMutable, useSettings } from '@/sync/domains/state/storage';
import { useActiveServerAccountScope } from '@/sync/store/hooks';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { useRouter, useLocalSearchParams, useNavigation, usePathname } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { useHeaderHeight } from '@/utils/platform/responsive';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { sync } from '@/sync/sync';
import { getTempData, type NewSessionData } from '@/utils/sessions/tempDataStore';
import { readBackendNewSessionOptionStateByTargetKey } from '@/utils/sessions/backendNewSessionOptionState';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { runAfterInteractionsWithFallback } from '@/utils/timing/runAfterInteractionsWithFallback';
import { Modal } from '@/modal';
import { type PermissionMode, type ModelMode } from '@/sync/domains/permissions/permissionTypes';
import {
    getProfileEnvironmentVariables,
    isProfileCompatibleWithBackendTarget,
    type AIBackendProfile,
} from '@/sync/domains/profiles/profileCompatibility';
import { getBuiltInProfile, DEFAULT_PROFILES, getProfilePrimaryCli, isProfileEnabled } from '@/sync/domains/profiles/profileUtils';
import { DEFAULT_AGENT_ID, getAgentCore, isAgentId, type AgentId } from '@/agents/catalog/catalog';
import { useEnabledAgentIds } from '@/agents/hooks/useEnabledAgentIds';
import { buildBackendTargetRouteParams, resolveBackendTargetFromRouteParams } from '@/agents/backendCatalog/backendTargetRouteParams';
import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';

import { loadNewSessionDraft, type NewSessionDraft } from '@/sync/domains/state/persistence';
import { NewSessionEngineOptionDetail } from '@/components/sessions/new/components/NewSessionEngineOptionDetail';
import { normalizeOptionalParam } from '@/profileRouteParams';
import { useFocusEffect } from '@react-navigation/native';
import { useMachineEnvPresence } from '@/hooks/machine/useMachineEnvPresence';
import { normalizeSessionAuthoringConnectedServices } from '@/sync/domains/sessionAuthoring/sessionAuthoringNormalization';
import type { CapabilityId } from '@/sync/api/capabilities/capabilitiesProtocol';
import { getSecretSatisfaction } from '@/utils/secrets/secretSatisfaction';
import { isMobileLayoutWidth } from '@/components/sessions/layout/isMobileLayoutWidth';
import { resolveNewSessionShouldBottomAnchor } from '@/components/sessions/new/navigation/newSessionPresentation';
import { useProfileMap } from '@/components/sessions/new/modules/profileHelpers';
import { newSessionScreenStyles } from '@/components/sessions/new/newSessionScreenStyles';
import { resolveNewSessionCapabilityServerId } from '@/components/sessions/new/modules/resolveNewSessionCapabilityServerId';
import type { NewSessionTranscriptStorage } from '@/components/sessions/new/modules/newSessionTranscriptStorage';
import type { AgentInputChipPickerOption } from '@/components/sessions/agentInput/components/AgentInputChipPickerTypes';
import { useAutomationsSupport } from '@/hooks/server/useAutomationsSupport';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import {
    buildNewSessionAuthoringDraftFromPersistedDraft,
    buildNewSessionAuthoringDraftFromTempData,
} from '@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters';
import { useNewSessionServerTargetState } from '@/components/sessions/new/hooks/serverTarget/useNewSessionServerTargetState';
import { useNewSessionActiveServerSource } from '@/components/sessions/new/hooks/serverTarget/useNewSessionActiveServerSource';
import { useNewSessionBackendTargetState } from '@/components/sessions/new/hooks/screenModel/useNewSessionBackendTargetState';
import { useNewSessionMachinePathState } from '@/components/sessions/new/hooks/screenModel/useNewSessionMachinePathState';
import { useNewSessionRepoScmSnapshot } from '@/components/sessions/new/hooks/screenModel/useNewSessionRepoScmSnapshot';
import {
    buildAcpConfigOptionOverridesV1,
    type AcpConfigOptionOverridesV1,
    type WindowsRemoteSessionLaunchMode,
} from '@happier-dev/protocol';
import { useNewSessionMcpSelection } from '@/components/sessions/new/hooks/useNewSessionMcpSelection';
import { resolveEffectiveWindowsRemoteSessionLaunchMode } from '@/sync/domains/session/spawn/windowsRemoteSessionLaunchMode';
import { useNewSessionAvailabilityState } from '@/components/sessions/new/hooks/screenModel/useNewSessionAvailabilityState';
import { useNewSessionMachineRefreshState } from '@/components/sessions/new/hooks/screenModel/useNewSessionMachineRefreshState';
import { useNewSessionCheckoutSelectionState } from '@/components/sessions/new/hooks/screenModel/useNewSessionCheckoutSelectionState';
import { useNewSessionProfileEditPersistence } from '@/components/sessions/new/hooks/screenModel/useNewSessionProfileEditPersistence';
import { buildNewSessionScreenVariantModel } from '@/components/sessions/new/hooks/screenModel/buildNewSessionScreenVariantModel';
import { useNewSessionTranscriptStorageState } from '@/components/sessions/new/hooks/screenModel/useNewSessionTranscriptStorageState';
import { useNewSessionAgentAuthoringOptionsState } from '@/components/sessions/new/hooks/screenModel/useNewSessionAgentAuthoringOptionsState';
import { useNewSessionPermissionModeState } from '@/components/sessions/new/hooks/screenModel/useNewSessionPermissionModeState';
import { useNewSessionPromptAutomationState } from '@/components/sessions/new/hooks/screenModel/useNewSessionPromptAutomationState';
import { useNewSessionSecretSelectionState } from '@/components/sessions/new/hooks/screenModel/useNewSessionSecretSelectionState';
import { buildSecretRequirementRouteParams } from '@/components/sessions/new/navigation/newSessionRouteParams';
import { useNewSessionHappyRouteFlag } from '@/components/sessions/new/hooks/screenModel/useNewSessionHappyRouteFlag';
import { useRouteBackendTargetSelectionSync } from '@/components/sessions/new/hooks/screenModel/useRouteBackendTargetSelectionSync';
import { useNewSessionInputPopovers } from '@/components/sessions/new/hooks/screenModel/useNewSessionInputPopovers';
import { useNewSessionAgentSelectionModelModeReconciliation } from '@/components/sessions/new/hooks/screenModel/useNewSessionAgentSelectionModelModeReconciliation';
import { useNewSessionProfileBackendReconciliation } from '@/components/sessions/new/hooks/screenModel/useNewSessionProfileBackendReconciliation';
import { useNewSessionProfileSelectionPresentation } from '@/components/sessions/new/hooks/screenModel/useNewSessionProfileSelectionPresentation';
import { useNewSessionProfileActions } from '@/components/sessions/new/hooks/screenModel/useNewSessionProfileActions';
import { resolveServerScopedMachines } from '@/sync/domains/machines/resolveServerScopedMachines';
import { useNewSessionProfilePopover } from '@/components/sessions/new/hooks/screenModel/useNewSessionProfilePopover';
import { useNewSessionCreateSessionAction } from '@/components/sessions/new/hooks/screenModel/useNewSessionCreateSessionAction';
import { useNewSessionScreenAgentInputPresentation } from '@/components/sessions/new/hooks/screenModel/useNewSessionScreenAgentInputPresentation';
import { useNewSessionScreenAuthoringState } from '@/components/sessions/new/hooks/screenModel/useNewSessionScreenAuthoringState';
import { useNewSessionScreenSimplePanelProps } from '@/components/sessions/new/hooks/screenModel/useNewSessionScreenSimplePanelProps';
import { useNewSessionScreenWizardProps } from '@/components/sessions/new/hooks/screenModel/useNewSessionScreenWizardProps';
import { useNewSessionConnectedServicesAgentOptions } from '@/components/sessions/new/hooks/screenModel/useNewSessionConnectedServicesAgentOptions';
import { useNewSessionScreenPreflightState } from '@/components/sessions/new/hooks/screenModel/useNewSessionScreenPreflightState';
import { buildNewSessionLaunchStatusBadges } from '@/components/sessions/new/hooks/screenModel/newSessionLaunchStatusBadges';
import type { NewSessionScreenModel } from '@/components/sessions/new/hooks/newSessionScreenModelTypes';
import type { OptionPickerProbeState } from '@/components/sessions/pickers/OptionPickerOverlay';
import type { AgentInputAutocompleteSelectionHandler } from '@/components/sessions/agentInput';
import { resolvePromptInvocationAutocompleteSelection } from '@/sync/domains/input/slashCommands/promptInvocationSuggestion';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { isProfileCompatibleWithResolvedBackendEntry } from '@/components/profiles/edit/profileBackendEntryStorage';
import {
    readRememberedEngineSelection,
    type RememberedEngineSelectionV1,
} from '@/sync/domains/session/authoring/rememberedEngineSelections';
import { useDeferredRememberedEngineSelection } from '@/components/sessions/new/hooks/screenModel/useDeferredRememberedEngineSelection';
import { resolveLocalFeaturePolicyEnabled } from '@/sync/domains/features/featureLocalPolicy';
import { getCommandSuggestions } from '@/components/autocomplete/commandSuggestions';
import type { NewSessionLaunchAttempt } from '@/components/sessions/new/modules/newSessionLaunchAttempt';


// Configuration constants
const RECENT_PATHS_DEFAULT_VISIBLE = 5;
const NEW_SESSION_COMMAND_SUGGESTION_SESSION_ID = '__new_session__';
const styles = newSessionScreenStyles;

function useLatestRef<Value>(value: Value): React.MutableRefObject<Value> {
    const ref = React.useRef(value);
    ref.current = value;
    return ref;
}

function buildNewSessionDraftSignature(draft: NewSessionDraft | null): string {
    if (draft === null) return 'null';
    try {
        return JSON.stringify(draft) ?? 'null';
    } catch {
        return 'unserializable';
    }
}

type EngineSelectionRememberPatch = Readonly<{
    modelMode?: ModelMode;
    acpSessionModeId?: string | null;
    sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1 | null;
}>;

function resolvePersistedWindowsLaunchOverrideForMachine(
    draft: NewSessionDraft | null,
    machineId: string | null,
): WindowsRemoteSessionLaunchMode | null {
    if (!draft?.windowsRemoteSessionLaunchModeOverride || !machineId) return null;
    return draft.windowsRemoteSessionLaunchModeOverride.machineId === machineId
        ? draft.windowsRemoteSessionLaunchModeOverride.mode
        : null;
}

export function useNewSessionScreenModel(): NewSessionScreenModel {
    const { theme, rt } = useUnistyles();
    const router = useRouter();
    const navigation = useNavigation();
    const pathname = usePathname();
    const safeArea = useChromeSafeAreaInsets();
    const headerHeight = useHeaderHeight();
    const { width: screenWidth } = useWindowDimensions();
    const selectedIndicatorColor = rt.themeName === 'dark' ? theme.colors.text.primary : theme.colors.button.primary.background;
    const popoverBoundaryRef = React.useRef<View>(null!);

    const newSessionSidePadding = 16;
    const newSessionBottomPadding = Math.max(screenWidth < 420 ? 8 : 16, safeArea.bottom);
    const isNewSessionMobileLayoutWidth = isMobileLayoutWidth(screenWidth);

    // Simple (non-wizard) new-session screen spacing.
    // Keep wizard spacing unchanged (the wizard layout benefits from wider margins).
    const simpleNewSessionTopPadding = screenWidth < 420 ? 20 : 28;
    const simpleNewSessionSidePadding = screenWidth < 420 ? 16 : 24;
    const simpleNewSessionBottomPadding = 8;
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
        agentType: agentTypeParam,
        backendTarget: backendTargetParam,
        backendTargetKey: backendTargetKeyParam,
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
        agentType?: string;
        backendTarget?: string;
        backendTargetKey?: string;
    }>();
    const draftScope = useActiveServerAccountScope();
    const attachmentFlowId = React.useMemo(() => {
        if (typeof dataId === 'string' && dataId.trim().length > 0) {
            return dataId.trim();
        }
        return `default:${draftScope ? serverAccountScopeKeySuffix(draftScope) : 'legacy'}`;
    }, [dataId, draftScope]);
    // Try to get data from temporary store first so server-target hydration can decide
    // whether route/temp selections should replace saved draft selections.
    const tempSessionData = React.useMemo(() => {
        if (dataId) {
            return getTempData<NewSessionData>(dataId);
        }
        return null;
    }, [dataId]);
    const shouldReplacePersistedDraftSelections = tempSessionData?.replacePersistedDraftSelections === true;
    const loadScopedNewSessionDraft = React.useCallback(() => {
        return draftScope ? loadNewSessionDraft(draftScope) : null;
    }, [draftScope]);

    // Load persisted draft state (survives remounts/screen navigation).
    const [scopedPersistedDraft, setScopedPersistedDraft] = React.useState(() => loadScopedNewSessionDraft());
    const scopedPersistedDraftSignatureRef = React.useRef(buildNewSessionDraftSignature(scopedPersistedDraft));
    const setLoadedScopedPersistedDraft = React.useCallback((nextDraft: NewSessionDraft | null) => {
        const nextSignature = buildNewSessionDraftSignature(nextDraft);
        if (scopedPersistedDraftSignatureRef.current === nextSignature) {
            return;
        }
        scopedPersistedDraftSignatureRef.current = nextSignature;
        setScopedPersistedDraft(nextDraft);
    }, []);
    const persistedDraft = shouldReplacePersistedDraftSelections ? null : scopedPersistedDraft;
    const previousDraftScopeRef = React.useRef(draftScope);

    const recentMachinePaths = useSetting('recentMachinePaths');
    const lastUsedAgent = useSetting('lastUsedAgent');
    const lastUsedBackendTarget = useSetting('lastUsedBackendTarget');
    const newSessionDefaultPersistenceModeV1 = useSetting('newSessionDefaultPersistenceModeV1');
    const newSessionDefaultPersistenceModeByTargetKeyV1 = useSetting('newSessionDefaultPersistenceModeByTargetKeyV1');

    // A/B Test Flag - determines which wizard UI to show
    // Control A (false): Simpler AgentInput-driven layout
    // Variant B (true): Enhanced profile-first wizard with sections
    const useEnhancedSessionWizard = useSetting('useEnhancedSessionWizard');
    const newSessionPresentationModeV1 = useSetting('newSessionPresentationModeV1');
    const newSessionWizardSectionPresentationV1 = useSetting('newSessionWizardSectionPresentationV1');
    const newSessionWizardColumnsEnabled = useSetting('newSessionWizardColumnsEnabled');
    const shouldBottomAnchor = resolveNewSessionShouldBottomAnchor({
        mode: newSessionPresentationModeV1,
        platformOs: Platform.OS,
        isMobileLayoutWidth: isNewSessionMobileLayoutWidth,
    });

    useNewSessionHappyRouteFlag(pathname);

    const sessionPromptInputMaxHeight = undefined;
    const useProfiles = useSetting('useProfiles');
    const [secrets, setSecrets] = useSettingMutable('secrets');
    const [secretBindingsByProfileId, setSecretBindingsByProfileId] = useSettingMutable('secretBindingsByProfileId');
    const sessionDefaultPermissionModeByTargetKey = useSetting('sessionDefaultPermissionModeByTargetKey');
    const settings = useSettings() ?? settingsDefaults;
    const executionRunsEnabled = resolveLocalFeaturePolicyEnabled('execution.runs', settings);
    const activeServerSource = useNewSessionActiveServerSource();
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
        activeServerId: activeServerSource.activeServerId,
        serverProfiles: activeServerSource.serverProfiles,
        request: {
            spawnServerIdParam,
            persistedTargetServerId: persistedDraft?.targetServerId,
        },
    });
    // New-session capability gating should be evaluated in spawn scope (target server),
    // not in main selection scope (which can be a multi-server group).
    const automationsSupport = useAutomationsSupport({ scopeKind: 'spawn', serverId: targetServerId });
    const automationFeatureEnabled = automationsSupport?.enabled === true;

    const capabilityServerId = React.useMemo(() => {
        return resolveNewSessionCapabilityServerId({
            targetServerId,
            activeServerId: activeServerSource.activeServerId,
        });
    }, [activeServerSource.activeServerId, targetServerId]);
    const externalSessionsFeatureEnabled = useFeatureEnabled('sessions.direct', { scopeKind: 'spawn', serverId: targetServerId });
    const useMachinePickerSearch = useSetting('useMachinePickerSearch');
    const usePathPickerSearch = useSetting('usePathPickerSearch');
    const [profiles, setProfiles] = useSettingMutable('profiles');
    const lastUsedProfile = useSetting('lastUsedProfile');
    const [favoriteDirectories, setFavoriteDirectories] = useSettingMutable('favoriteDirectories');
    const [favoriteMachines, setFavoriteMachines] = useSettingMutable('favoriteMachines');
    const [favoriteProfileIds, setFavoriteProfileIds] = useSettingMutable('favoriteProfiles');
    const [favoriteModelSelections, setFavoriteModelSelections] = useSettingMutable('favoriteModelSelectionsV1');
    const [favoriteBackendTargetKeys, setFavoriteBackendTargetKeys] = useSettingMutable('favoriteBackendTargetKeysV1');
    const [lastNewSessionAgentPickerView, setLastNewSessionAgentPickerView] = useSettingMutable('lastNewSessionAgentPickerViewV1');
    const rememberLastEngineSelections = useSetting('rememberLastEngineSelectionsV1') !== false;
    const [lastEngineSelectionsByScope, setLastEngineSelectionsByScope] = useSettingMutable('lastEngineSelectionsByScopeV1');
    const [dismissedCLIWarnings, setDismissedCLIWarnings] = useSettingMutable('dismissedCLIWarnings');

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
    const hydratedPersistedContentAuthoringDraft = React.useMemo(() => {
        return scopedPersistedDraft
            ? buildNewSessionAuthoringDraftFromPersistedDraft(scopedPersistedDraft)
            : null;
    }, [scopedPersistedDraft]);
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

    const [backendNewSessionOptionStateByTargetKey, setBackendNewSessionOptionStateByTargetKey] = React.useState<
        Record<string, Record<string, unknown>>
    >(() => {
        return readBackendNewSessionOptionStateByTargetKey(tempSessionData)
            ?? readBackendNewSessionOptionStateByTargetKey(persistedDraft)
            ?? {};
    });

    const routeBackendTarget = React.useMemo(() => {
        return resolveBackendTargetFromRouteParams({
            backendTarget: backendTargetParam,
            backendTargetKey: backendTargetKeyParam,
            agentType: agentTypeParam,
        });
    }, [agentTypeParam, backendTargetKeyParam, backendTargetParam]);

    useFocusEffect(
        React.useCallback(() => {
            setLoadedScopedPersistedDraft(loadScopedNewSessionDraft());
            // Ensure newly-registered machines show up without requiring an app restart.
            // Throttled to avoid spamming the server when navigating back/forth.
            // Defer until after interactions so the screen feels instant on iOS;
            // the timeout fallback guarantees the refresh still runs when
            // interactions never settle (hang class).
            runAfterInteractionsWithFallback(() => {
                fireAndForget(sync.refreshMachinesThrottled({ staleMs: 15_000 }), { tag: 'NewSessionScreenModel.refreshMachinesThrottled.focus' });
            });
        }, [loadScopedNewSessionDraft, setLoadedScopedPersistedDraft])
    );

    React.useEffect(() => {
        if (previousDraftScopeRef.current === draftScope) {
            return;
        }
        previousDraftScopeRef.current = draftScope;
        setLoadedScopedPersistedDraft(loadScopedNewSessionDraft());
    }, [draftScope, loadScopedNewSessionDraft, setLoadedScopedPersistedDraft]);

    // (prefetch effect moved below, after machines/recent/favorites are defined)

    // Combined profiles (built-in + custom)
    const allProfiles = React.useMemo(() => {
        const builtInProfiles = DEFAULT_PROFILES.flatMap((bp) => {
            const profile = getBuiltInProfile(bp.id);
            return profile ? [profile] : [];
        });
        return [...builtInProfiles, ...profiles];
    }, [profiles]);

    const profileMap = useProfileMap(allProfiles);
    const selectableProfiles = React.useMemo(() => {
        return allProfiles.filter((profile) => isProfileEnabled(profile, settings.profileEnabledById));
    }, [allProfiles, settings.profileEnabledById]);
    const selectableProfileMap = useProfileMap(selectableProfiles);
    const activeMachines = useLaunchSelectionMachines();
    const sessions = useSessions();
    const machineListByServerId = useMachineListByServerId();
    const machines = React.useMemo(() => {
        const resolvedTargetServerId = String(targetServerId ?? '').trim();
        const resolvedActiveServerId = String(activeServerSource.activeServerId ?? '').trim();
        if (!resolvedTargetServerId) {
            return activeMachines;
        }

        const scopedMachines = resolveServerScopedMachines({
            serverId: resolvedTargetServerId,
            activeServerId: resolvedActiveServerId,
            activeMachines,
            machineListByServerId,
        });
        if (scopedMachines) {
            return [...scopedMachines];
        }

        return Object.prototype.hasOwnProperty.call(machineListByServerId, resolvedTargetServerId)
            ? []
            : activeMachines;
    }, [activeMachines, activeServerSource.activeServerId, machineListByServerId, targetServerId]);
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
        return Boolean(draftProfileId && selectableProfileMap.has(draftProfileId));
    }, [hydratedPersistedAuthoringDraft?.profileId, hydratedTempAuthoringDraft?.profileId, selectableProfileMap, useProfiles]);
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
        if (draftProfileId && selectableProfileMap.has(draftProfileId)) {
            return draftProfileId;
        }
        if (lastUsedProfile && selectableProfileMap.has(lastUsedProfile)) {
            return lastUsedProfile;
        }
        return null;
    }, [hydratedPersistedAuthoringDraft?.profileId, hydratedTempAuthoringDraft?.profileId, lastUsedProfile, selectableProfileMap, useProfiles]);

    // Wizard state
    const [selectedProfileId, setSelectedProfileId] = React.useState<string | null>(() => initialImplicitProfileId);
    const hasUserTouchedProfileSelectionRef = React.useRef<boolean>(hasExplicitSeededProfileSelection);

    React.useEffect(() => {
        if (!useProfiles && selectedProfileId !== null) {
            setSelectedProfileId(null);
        }
    }, [useProfiles, selectedProfileId]);

    const emptyAutocompletePrefixes = React.useMemo(() => ['/'], []);
    const emptyAutocompleteSuggestions = React.useCallback(async (query: string) => {
        if (!query.startsWith('/')) {
            return [];
        }
        return getCommandSuggestions(NEW_SESSION_COMMAND_SUGGESTION_SESSION_ID, query);
    }, []);
    const handleAutocompleteSuggestionSelect = React.useCallback<AgentInputAutocompleteSelectionHandler>(async (args) => {
        try {
            return await resolvePromptInvocationAutocompleteSelection(args);
        } catch (error) {
            Modal.alert(t('common.error'), error instanceof Error ? error.message : t('errors.failedToSendMessage'));
            return { handled: true };
        }
    }, []);

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

    const {
        selectedMachineId,
        setSelectedMachineId,
        selectedPath,
        setSelectedPath,
        setDraftSelectedPath,
        getRequestedPath,
        getBestPathForMachine,
    } = useNewSessionMachinePathState({
        machines,
        recentMachinePaths,
        sessions,
        machineIdParam: effectiveMachineIdParam,
        pathParam: effectivePathParam,
        persistedMachineId: persistedDraft?.selectedMachineId ?? tempSessionData?.machineId,
        persistedPath: hydratedPersistedAuthoringDraft?.directory ?? hydratedTempAuthoringDraft?.directory,
        cacheScopeKey: capabilityServerId,
    });
    const daemonMergedProjection = useDaemonMergedProjectionInputs({
        machineId: selectedMachineId,
        serverId: targetServerId,
        enabled: Boolean(selectedMachineId),
    });
    const enabledAgentIds = useEnabledAgentIds();
    const resolvedBackendEntries = React.useMemo(() => {
        return getResolvedBackendCatalogEntries({
            enabledAgentIds,
            acpCatalogSettingsV1: settings.acpCatalogSettingsV1,
            backendEnabledByTargetKey: settings.backendEnabledByTargetKey,
            collapseConfiguredBackendProviderSentinels: true,
            mergedProviderProjectionById: daemonMergedProjection.inputs?.mergedProviderProjectionById ?? null,
            mergedBackendProjectionById: daemonMergedProjection.inputs?.mergedBackendProjectionById ?? null,
            discoveredBackendIds: daemonMergedProjection.inputs?.discoveredBackendIds,
        });
    }, [
        daemonMergedProjection.inputs?.discoveredBackendIds,
        daemonMergedProjection.inputs?.mergedBackendProjectionById,
        daemonMergedProjection.inputs?.mergedProviderProjectionById,
        enabledAgentIds,
        settings.acpCatalogSettingsV1,
        settings.backendEnabledByTargetKey,
    ]);
    const {
        backendTarget,
        setBackendTarget,
        selectedProviderAgentId: agentType,
        selectedRuntimeCarrierAgentId,
        selectedUiAgentType,
    } = useNewSessionBackendTargetState({
        entries: resolvedBackendEntries,
        lastUsedAgent,
        lastUsedBackendTarget,
        routeBackendTarget,
        persistedBackendTarget: hydratedPersistedAuthoringDraft?.backendTarget,
        tempBackendTarget: routeBackendTarget ?? hydratedTempAuthoringDraft?.backendTarget ?? tempSessionData?.backendTarget,
        tempAgentType: hydratedTempAuthoringDraft?.agentId ?? agentTypeParam ?? hydratedPersistedAuthoringDraft?.agentId,
        projectionPhase: daemonMergedProjection.phase,
    });
    const setAgentType = React.useCallback((next: React.SetStateAction<AgentId>) => {
        setBackendTarget((prevTarget) => {
            const prevAgentId = isAgentId(prevTarget.backendId) ? prevTarget.backendId : DEFAULT_AGENT_ID;
            const nextAgentId = typeof next === 'function' ? next(prevAgentId) : next;
            return { kind: 'backend', backendId: nextAgentId };
        });
    }, [setBackendTarget]);
    const selectedBackendTargetKey = React.useMemo(() => resolveBackendTargetKeyV2(backendTarget), [backendTarget]);
    const agentOptionState = backendNewSessionOptionStateByTargetKey[selectedBackendTargetKey] ?? null;
    const selectedBackendEntry = React.useMemo(() => {
        return resolvedBackendEntries.find((entry) => entry.backendTargetKey === selectedBackendTargetKey) ?? null;
    }, [resolvedBackendEntries, selectedBackendTargetKey]);
    const rememberedEngineSelection = React.useMemo(() => readRememberedEngineSelection({
        enabled: rememberLastEngineSelections,
        selectionsByScope: lastEngineSelectionsByScope,
        serverId: capabilityServerId,
        backendTarget: selectedBackendEntry?.backendTarget ?? backendTarget,
    }), [
        backendTarget,
        capabilityServerId,
        lastEngineSelectionsByScope,
        rememberLastEngineSelections,
        selectedBackendEntry?.backendTarget,
    ]);
    const agentLabel = selectedBackendEntry?.title ?? t(getAgentCore(selectedUiAgentType as AgentId).displayNameKey);

    React.useEffect(() => {
        if (!useProfiles) return;
        if (!selectedProfileId) return;
        const selected = profileMap.get(selectedProfileId) ?? getBuiltInProfile(selectedProfileId);
        if (!selected) {
            setSelectedProfileId(null);
            return;
        }
        if (!isProfileEnabled(selected, settings.profileEnabledById)) {
            setSelectedProfileId(null);
            return;
        }
        if (resolvedBackendEntries.some((entry) => isProfileCompatibleWithResolvedBackendEntry(selected, entry))) {
            return;
        }
        setSelectedProfileId(null);
    }, [profileMap, resolvedBackendEntries, selectedProfileId, settings.profileEnabledById, useProfiles]);

    useRouteBackendTargetSelectionSync({
        routeBackendTarget,
        resolvedBackendEntries,
        selectedBackendTargetKey,
        setBackendTarget,
    });

    const {
        modelMode,
        setModelMode,
        acpSessionModeId,
        setAcpSessionModeId,
        sessionConfigOptionOverrides,
        setSessionConfigOptionOverrides,
        setEngineSelectionForBackendTarget,
        setAcpConfigOptionOverride,
        mcpSelection,
        setMcpSelection,
    } = useNewSessionAgentAuthoringOptionsState({
        agentType,
        backendTargetKey: selectedBackendTargetKey,
        allowTargetlessDraftEngineSelection: routeBackendTarget === null,
        hydratedTempAuthoringDraft,
        hydratedPersistedAuthoringDraft,
        rememberedEngineSelection,
    });
    const rememberEngineSelection = useDeferredRememberedEngineSelection({
        enabled: rememberLastEngineSelections,
        selectionsByScope: lastEngineSelectionsByScope,
        serverId: capabilityServerId,
        commit: setLastEngineSelectionsByScope,
    });
    const currentEngineSelectionRef = useLatestRef({
        backendTarget: selectedBackendEntry?.backendTarget ?? backendTarget,
        modelMode,
        acpSessionModeId,
        sessionConfigOptionOverrides,
    });
    const rememberCurrentEngineSelection = React.useCallback((patch: EngineSelectionRememberPatch = {}) => {
        const current = currentEngineSelectionRef.current;
        rememberEngineSelection(current.backendTarget, {
            modelId: String(patch.modelMode ?? current.modelMode),
            acpSessionModeId: Object.prototype.hasOwnProperty.call(patch, 'acpSessionModeId')
                ? patch.acpSessionModeId ?? null
                : current.acpSessionModeId,
            sessionConfigOptionOverrides: Object.prototype.hasOwnProperty.call(patch, 'sessionConfigOptionOverrides')
                ? patch.sessionConfigOptionOverrides ?? null
                : current.sessionConfigOptionOverrides,
        });
    }, [currentEngineSelectionRef, rememberEngineSelection]);
    const setModelModeAndRemember = React.useCallback<React.Dispatch<React.SetStateAction<ModelMode>>>((next) => {
        const current = currentEngineSelectionRef.current.modelMode;
        const value = typeof next === 'function'
            ? (next as (value: ModelMode) => ModelMode)(current)
            : next;
        setModelMode(value);
        rememberCurrentEngineSelection({ modelMode: value });
    }, [currentEngineSelectionRef, rememberCurrentEngineSelection, setModelMode]);
    const setAcpSessionModeIdAndRemember = React.useCallback<React.Dispatch<React.SetStateAction<string | null>>>((next) => {
        const current = currentEngineSelectionRef.current.acpSessionModeId;
        const value = typeof next === 'function'
            ? (next as (value: string | null) => string | null)(current)
            : next;
        setAcpSessionModeId(value);
        rememberCurrentEngineSelection({ acpSessionModeId: value });
    }, [currentEngineSelectionRef, rememberCurrentEngineSelection, setAcpSessionModeId]);
    const setAcpConfigOptionOverrideAndRemember = React.useCallback((configId: string, value: string) => {
        const normalizedConfigId = typeof configId === 'string' ? configId.trim() : '';
        const normalizedValue = typeof value === 'string' ? value.trim() : '';
        if (!normalizedConfigId || !normalizedValue) return;
        const updatedAt = Date.now();
        const sessionConfigOptionOverrides = buildAcpConfigOptionOverridesV1({
            updatedAt,
            overrides: {
                ...(currentEngineSelectionRef.current.sessionConfigOptionOverrides?.overrides ?? {}),
                [normalizedConfigId]: {
                    updatedAt,
                    value: normalizedValue,
                },
            },
        });
        setSessionConfigOptionOverrides(sessionConfigOptionOverrides);
        rememberCurrentEngineSelection({ sessionConfigOptionOverrides });
    }, [currentEngineSelectionRef, rememberCurrentEngineSelection, setSessionConfigOptionOverrides]);

    const [pathPickerSearchQuery, setPathPickerSearchQuery] = React.useState('');
    const selectedMachine = React.useMemo(() => {
        if (!selectedMachineId) return null;
        return machines.find(m => m.id === selectedMachineId) ?? null;
    }, [selectedMachineId, machines]);
    const repoScmSnapshot = useNewSessionRepoScmSnapshot({
        machineId: selectedMachineId,
        path: selectedPath,
        machineHomeDir: selectedMachine?.metadata?.homeDir ?? null,
        machinePlatform: selectedMachine?.metadata?.platform ?? null,
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
        machineHomeDir: selectedMachine?.metadata?.homeDir ?? null,
        machinePlatform: selectedMachine?.metadata?.platform ?? null,
        repoScmSnapshot,
        autoOpenWorktreePickerKey: effectiveWorktreeRouteMode === 'new'
            ? `route:new:${selectedMachineId ?? ''}:${selectedPath}`
            : null,
    });
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
        getBackendEntryUnavailabilityReason,
        isCliBannerDismissed,
        dismissCliBanner,
        getCompatibleProfileBackendEntries,
        profileAvailabilityById,
        selectedMachineIsWindows,
        selectedMachineSpawnReadiness,
        windowsTerminalAvailable,
    } = useNewSessionAvailabilityState({
        selectedMachineId,
        selectedMachine,
        capabilityServerId,
        externalSessionsFeatureEnabled,
        settings,
        agentType,
        resumeSessionId,
        enabledAgentIds,
        backendNewSessionOptionStateByTargetKey,
        resolvedBackendEntries,
        selectedBackendEntry,
        setBackendTarget,
        machines,
        dismissedCliWarnings: dismissedCLIWarnings,
        setDismissedCliWarnings: setDismissedCLIWarnings,
        allProfiles,
    });
    const refreshCliAvailabilityRef = useLatestRef(cliAvailability.refresh);
    const refreshCliAvailability = React.useCallback(() => {
        void refreshCliAvailabilityRef.current({ bypassCache: true });
    }, [refreshCliAvailabilityRef]);
    const cliAvailabilityProbePhase: OptionPickerProbeState['phase'] = cliAvailability.isDetecting
        ? (cliAvailability.timestamp > 0 ? 'refreshing' : 'loading')
        : 'idle';

    const cliAvailabilityProbe = React.useMemo<OptionPickerProbeState | undefined>(() => {
        if (!selectedMachineId) return undefined;
        return {
            phase: cliAvailabilityProbePhase,
            onRefresh: refreshCliAvailability,
        };
    }, [cliAvailabilityProbePhase, refreshCliAvailability, selectedMachineId]);
    const {
        setAgentOptionStateForCurrentAgent,
        connectedServicesAuthChip,
        agentNewSessionOptions,
    } = useNewSessionConnectedServicesAgentOptions({
        agentType,
        targetServerId,
        selectedBackendTargetKey,
        setBackendNewSessionOptionStateByTargetKey,
        agentOptionState,
        settings,
        router,
    });
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
    const {
        preflightModels,
        preflightModelsTargetKey,
        modelOptions,
        modelOptionsProbeState,
        acpSessionModeOptions,
        acpSessionModeProbeState,
        acpConfigOptions,
        acpConfigOptionsProbeState,
    } = useNewSessionScreenPreflightState({
        backendTarget,
        runtimeCarrierAgentId: selectedRuntimeCarrierAgentId,
        settings,
        selectedMachineId,
        capabilityServerId,
        cwd: selectedPath,
        connectedServices: agentNewSessionOptions?.connectedServices ?? null,
    });

    const allProfilesRequirementNames = React.useMemo(() => {
        const names = new Set<string>();
        for (const p of selectableProfiles) {
            for (const req of p.envVarRequirements ?? []) {
                const name = typeof req?.name === 'string' ? req.name : '';
                if (name) names.add(name);
            }
        }
        return Array.from(names);
    }, [selectableProfiles]);

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
        persistedDraftEntryIntent: scopedPersistedDraft?.entryIntent,
        hydratedTempAuthoringDraft,
        hydratedPersistedAuthoringDraft: hydratedPersistedContentAuthoringDraft,
    });
    const [isCreating, setIsCreating] = React.useState(false);
    const [isResumeSupportChecking, setIsResumeSupportChecking] = React.useState(false);
    const [pendingLaunchAttempt, setPendingLaunchAttempt] = React.useState<NewSessionLaunchAttempt | null>(null);

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
        return selectableProfiles.filter((profile) => isProfileCompatibleWithBackendTarget(profile, backendTarget));
    }, [selectableProfiles, backendTarget]);
    const selectedProfile = React.useMemo(() => {
        if (!selectedProfileId) {
            return null;
        }
        if (profileMap.has(selectedProfileId)) {
            const profile = profileMap.get(selectedProfileId)!;
            return isProfileEnabled(profile, settings.profileEnabledById) ? profile : null;
        }
        const builtInProfile = getBuiltInProfile(selectedProfileId);
        return builtInProfile && isProfileEnabled(builtInProfile, settings.profileEnabledById) ? builtInProfile : null;
    }, [selectedProfileId, profileMap, settings.profileEnabledById]);

    const persistedWindowsRemoteSessionLaunchModeOverride = resolvePersistedWindowsLaunchOverrideForMachine(
        persistedDraft,
        selectedMachineId,
    );
    const [windowsRemoteSessionLaunchModeOverride, setWindowsRemoteSessionLaunchModeOverride] =
        React.useState<WindowsRemoteSessionLaunchMode | null>(() => persistedWindowsRemoteSessionLaunchModeOverride);

    const persistedWindowsRemoteSessionLaunchModeOverrideMachineId = persistedDraft?.windowsRemoteSessionLaunchModeOverride?.machineId ?? null;
    const persistedWindowsRemoteSessionLaunchModeOverrideMode = persistedDraft?.windowsRemoteSessionLaunchModeOverride?.mode ?? null;
    React.useEffect(() => {
        setWindowsRemoteSessionLaunchModeOverride(
            resolvePersistedWindowsLaunchOverrideForMachine(persistedDraft, selectedMachineId),
        );
    }, [
        persistedDraft,
        persistedWindowsRemoteSessionLaunchModeOverrideMachineId,
        persistedWindowsRemoteSessionLaunchModeOverrideMode,
        selectedMachineId,
    ]);
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
        routeBackendParams: buildBackendTargetRouteParams({
            agentType: agentTypeParam,
            backendTarget: backendTargetParam,
            backendTargetKey: backendTargetKeyParam,
            fallbackTarget: backendTarget,
        }),
        routeContextParams: buildSecretRequirementRouteParams({
            dataId: typeof dataId === 'string' ? dataId : undefined,
            selectedMachineId,
            targetServerId,
        }),
        secretIdParam: typeof secretIdParam === 'string' ? secretIdParam : undefined,
        secretSessionOnlyId: typeof secretSessionOnlyId === 'string' ? secretSessionOnlyId : undefined,
        secretRequirementResultId: typeof secretRequirementResultId === 'string' ? secretRequirementResultId : undefined,
    });

    // NOTE: we intentionally do NOT clear per-profile secret overrides when profile changes.
    // Users may resolve secrets for multiple profiles and then switch between them before creating a session.

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
        resolvedBackendTargets: resolvedBackendEntries.map((entry) => entry.backendTarget),
        agentType,
        backendTarget,
        settings,
        externalSessionsFeatureEnabled,
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

    // Profile/backend reconciliation and permission-mode fallback logic is owned by the
    // extracted hook so this screen model can keep route-specific profile param handling local.
    const { selectProfile } = useNewSessionProfileBackendReconciliation({
        useProfiles,
        selectedProfileId,
        setSelectedProfileId,
        profileMap,
        getCompatibleProfileBackendEntries,
        selectedBackendTargetKey,
        setBackendTarget,
        cliAvailabilityTimestamp: cliAvailability.timestamp,
        cliAvailabilityByAgentId: cliAvailability.available,
        cliAuthStatusByAgentId: cliAvailability.authStatus,
        installableDepKeyCountByAgentId,
        selectableWithoutCliByAgentId,
        hasUserSelectedPermissionModeRef,
        permissionModeRef,
        applyPermissionMode,
        resolveDefaultPermissionMode,
        prepareSecretPromptForProfileSelection,
        hasUserTouchedProfileSelectionRef,
        agentType,
    });

    const { onPressDefaultEnvironment, handleDeleteProfile } = useNewSessionProfileActions({
        hasUserTouchedProfileSelectionRef,
        setSelectedProfileId,
        profiles,
        selectedProfileId,
        setProfiles,
    });

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
        sessions,
        favoriteMachines,
        useEnhancedSessionWizard,
        refreshMachineEnvPresence,
    });

    const selectedServerId = targetServerId;
    const { pathPopover, machinePopover, resumePopover } = useNewSessionInputPopovers({
        selectedMachine,
        selectedMachineId,
        selectedPath,
        setSelectedPath,
        setDraftSelectedPath,
        recentPaths,
        usePathPickerSearch,
        pathPickerSearchQuery,
        setPathPickerSearchQuery,
        favoriteDirectories,
        setFavoriteDirectories,
        allowedTargetServerIds,
        resolvedSettingsAllowedServerIds: resolvedSettingsTarget.allowedServerIds,
        activeServerId: activeServerSource.activeServerId,
        activeServerProfilesSignature: activeServerSource.serverProfilesSignature,
        activeMachines,
        selectedServerId,
        recentMachines,
        favoriteMachineItems,
        setSelectedMachineId,
        getBestPathForMachine,
        useMachinePickerSearch,
        targetServerId,
        externalSessionsFeatureEnabled,
        resumeSessionId,
        setResumeSessionId,
        agentType,
        agentLabel,
        agentOptionState,
        settings,
    });

    const clearProfileRouteParam = React.useCallback(() => {
        const setParams = (navigation as any)?.setParams;
        if (typeof setParams === 'function') {
            setParams({ profileId: undefined });
            return;
        }
        navigation.dispatch({
            type: 'SET_PARAMS',
            payload: { params: { profileId: undefined } },
        } as never);
    }, [navigation]);

    const clearBackendTargetRouteParamsAfterExplicitSelection = React.useCallback(() => {
        const paramsToClear = {
            agentType: undefined,
            backendTarget: undefined,
            backendTargetKey: undefined,
        };
        if (
            typeof agentTypeParam !== 'string'
            && typeof backendTargetParam !== 'string'
            && typeof backendTargetKeyParam !== 'string'
        ) {
            return;
        }
        const setParams = (navigation as any)?.setParams ?? (router as any)?.setParams;
        if (typeof setParams === 'function') {
            setParams(paramsToClear);
            return;
        }
        const dispatch = (navigation as any)?.dispatch;
        if (typeof dispatch !== 'function') return;
        dispatch({
            type: 'SET_PARAMS',
            payload: { params: paramsToClear },
        } as never);
    }, [agentTypeParam, backendTargetKeyParam, backendTargetParam, navigation, router]);

    const canSelectProfile = React.useCallback((profileId: string): boolean => {
        const profile = profileMap.get(profileId) ?? getBuiltInProfile(profileId);
        if (!profile) {
            return false;
        }
        if (!isProfileEnabled(profile, settings.profileEnabledById)) {
            return false;
        }
        // Keep profiles selectable when they still have structural backend support,
        // even if all compatible backends are currently logged out or undiscovered.
        return getCompatibleProfileBackendEntries(profile).length > 0;
    }, [getCompatibleProfileBackendEntries, profileMap, settings.profileEnabledById]);

    const {
        profilesGroupTitles,
        getProfileDisabled,
        getProfileSubtitleExtra,
        onPressProfile,
    } = useNewSessionProfileSelectionPresentation({
        useProfiles,
        profileIdParam,
        selectedProfileId,
        setSelectedProfileId,
        selectProfile,
        canSelectProfile,
        profileAvailabilityById,
        clearProfileRouteParam,
    });

    const {
        agentPickerOptions,
        agentPickerSelectedOptionId,
        handleAgentPickerSelect,
        handleAgentClick,
    } = useNewSessionAgentSelectionModelModeReconciliation({
        agentType,
        preflightModels,
        preflightModelsTargetKey,
        useProfiles,
        selectedProfileId,
        profileMap,
        resolvedBackendEntries,
        getCompatibleProfileBackendEntries,
        isBackendEntrySelectable,
        getBackendEntryUnavailabilityReason,
        selectedBackendEntry,
        selectedBackendTargetKey,
        setBackendTarget,
        modelMode,
        setModelMode,
        acpSessionModeId,
        setAcpSessionModeId,
        sessionConfigOptionOverrides,
        setSessionConfigOptionOverrides,
        setEngineSelectionForBackendTarget,
        selectedMachineId,
        capabilityServerId,
        selectedPath,
        settings,
        favoriteModelSelections,
        setFavoriteModelSelections,
        favoriteBackendTargetKeys,
        setFavoriteBackendTargetKeys,
        rememberedAgentPickerView: lastNewSessionAgentPickerView,
        onRememberAgentPickerView: setLastNewSessionAgentPickerView,
        rememberEngineSelectionsEnabled: rememberLastEngineSelections,
        rememberedEngineSelectionsByScope: lastEngineSelectionsByScope,
        rememberedEngineSelectionServerId: capabilityServerId,
        onRememberEngineSelection: rememberEngineSelection,
        onExplicitBackendTargetSelection: clearBackendTargetRouteParamsAfterExplicitSelection,
        refreshProbe: cliAvailabilityProbe ?? null,
    });

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
    } = useNewSessionScreenAuthoringState({
        automationDraft,
        automationFeatureEnabled,
        selectedMachineId,
        targetServerId,
        selectedMachine,
        selectedMachineSpawnReadiness,
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
        effectiveWindowsRemoteSessionLaunchMode,
        windowsRemoteSessionLaunchModeOverride: selectedMachineId && windowsRemoteSessionLaunchModeOverride
            ? {
                machineId: selectedMachineId,
                mode: windowsRemoteSessionLaunchModeOverride,
            }
            : null,
        acpSessionModeId,
        sessionConfigOptionOverrides,
        automationEditId,
        automationRequestedByRoute,
        selectedSecretId,
        selectedSecretIdByProfileIdByEnvVarName,
        getSessionOnlySecretValueEncByProfileIdByEnvVarName,
        backendNewSessionOptionStateByTargetKey,
        draftScope,
    });
    const spawnBackendTarget = React.useMemo(() => {
        return selectedBackendEntry?.backendTarget ?? backendTarget;
    }, [backendTarget, selectedBackendEntry?.backendTarget]);

    const { handleCreateSession } = useNewSessionCreateSessionAction({
        router,
        selectedMachineId,
        selectedPath,
        getRequestedPath,
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
        spawnBackendTarget,
        executionRunsEnabled,
        permissionMode,
        modelMode,
        acpSessionModeId,
        sessionConfigOptionOverrides,
        sessionPrompt,
        setSessionPrompt,
        automationEditId,
        resumeSessionId,
        agentNewSessionOptions,
        currentAuthoringDraft,
        mcpSelection,
        windowsRemoteSessionLaunchModeOverride,
        machineEnvPresence,
        secrets,
        secretBindingsByProfileId,
        selectedSecretIdByProfileIdByEnvVarName,
        sessionOnlySecretValueByProfileIdByEnvVarName,
        selectedMachineCapabilities,
        targetServerId,
        allowedTargetServerIds,
        resolvedSettingsAllowedServerIds: resolvedSettingsTarget.allowedServerIds,
        draftScope,
        disableDraftPersistence,
        onLaunchAttemptChange: setPendingLaunchAttempt,
    });

    const {
        connectionStatus,
        agentInputExtraActionChips,
    } = useNewSessionScreenAgentInputPresentation({
        theme,
        selectedMachine,
        selectedMachineSpawnReadiness,
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
        showAutomationActionChipsFromAuthoringContext: newSessionAuthoringContext.showAutomationActionChips,
        showServerPickerChip,
        targetServerId,
        targetServerName,
        mcpChip,
        externalSessionsFeatureEnabled,
        supportsDirectTranscriptStorage,
        transcriptStorage,
        hasUserSelectedTranscriptStorageRef,
        setTranscriptStorage,
        selectedMachineIsWindows,
        effectiveWindowsRemoteSessionLaunchMode,
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
        backendTargetRouteParams: buildBackendTargetRouteParams({
            agentType: agentTypeParam,
            backendTarget: backendTargetParam,
            backendTargetKey: backendTargetKeyParam,
            fallbackTarget: backendTarget,
        }),
        buildCurrentPersistedDraft,
        persistDraftIfEnabled,
        draftPersistenceEnabled,
        draftPersistenceGenerationRef,
        draftTextLength: sessionPrompt.length,
    });

    const submitAccessibilityLabel = newSessionAuthoringContext.submitAccessibilityLabelKey
        ? t(newSessionAuthoringContext.submitAccessibilityLabelKey)
        : undefined;
    const launchStatusBadges = React.useMemo(
        () => buildNewSessionLaunchStatusBadges({ isCreating, translate: t }),
        [isCreating],
    );

    const {
        layout: wizardLayoutProps,
        useColumnLayout: wizardUseColumnLayout,
        profiles: wizardProfilesProps,
        agent: wizardAgentProps,
        machine: wizardMachineProps,
        footer: wizardFooterProps,
    } = useNewSessionScreenWizardProps({
        layout: {
            theme,
            styles,
            safeAreaTop: safeArea.top,
            safeAreaBottom: safeArea.bottom,
            headerHeight,
            newSessionTopPadding: simpleNewSessionTopPadding,
            newSessionSidePadding,
            newSessionBottomPadding,
            shouldBottomAnchor,
        },
        sectionPresentation: newSessionWizardSectionPresentationV1,
        useColumnLayout: newSessionWizardColumnsEnabled === true,
        profiles: {
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
        },
        profileSecrets: {
            machineEnvPresence,
            secrets,
            secretBindingsByProfileId,
            selectedSecretIdByProfileIdByEnvVarName,
            sessionOnlySecretValueByProfileIdByEnvVarName,
        },
        installables: {
            wizardInstallableDeps,
            selectedMachineCapabilities,
        },
        agent: {
            cliAvailability,
            tmuxRequested,
            enabledAgentIds,
            isAgentSelectable,
            isCliBannerDismissed,
            dismissCliBanner,
            agentType: selectedUiAgentType as AgentId,
            agentLabel,
            setAgentType,
            agentPickerOptions,
            agentPickerSelectedOptionId,
            selectedBackendTargetKey,
            selectedBackendEntryTargetKey: selectedBackendEntry?.backendTargetKey,
            onAgentPickerSelect: handleAgentPickerSelect,
            selectedBackendEntry,
            modelOptions,
            modelOptionsProbeState: {
                phase: modelOptionsProbeState.phase,
                onRefresh: modelOptionsProbeState.onRefresh,
            },
            favoriteModelSelections,
            setFavoriteModelSelections,
            acpSessionModeOptions,
            acpSessionModeProbeState: {
                phase: acpSessionModeProbeState.phase,
                onRefresh: acpSessionModeProbeState.onRefresh,
            },
            acpSessionModeId,
            setAcpSessionModeId: setAcpSessionModeIdAndRemember,
            acpConfigOptions: acpConfigOptions ?? undefined,
            acpConfigOptionsProbeState: {
                phase: acpConfigOptionsProbeState.phase,
                onRefresh: acpConfigOptionsProbeState.onRefresh,
            },
            acpConfigOptionOverrides: sessionConfigOptionOverrides,
            setAcpConfigOptionOverride: setAcpConfigOptionOverrideAndRemember,
            modelMode,
            setModelMode: setModelModeAndRemember,
            selectedIndicatorColor,
            profileMap,
            permissionMode,
            handlePermissionModeChange,
        },
        machine: {
            machines,
            targetServerId,
            selectedMachine: selectedMachine ?? null,
            recentMachines,
            favoriteMachineItems,
            useMachinePickerSearch,
            refreshMachineData,
            setSelectedMachineId,
            getBestPathForMachine,
            setSelectedPath,
            setDraftSelectedPath,
            favoriteMachines,
            setFavoriteMachines,
            selectedPath,
            recentPaths,
            usePathPickerSearch,
            favoriteDirectories,
            setFavoriteDirectories,
        },
        footer: {
            sessionPrompt,
            setSessionPrompt,
            handleCreateSession,
            canCreate,
            isCreating,
            pendingLaunchAttempt,
            submitAccessibilityLabel,
            emptyAutocompletePrefixes,
            emptyAutocompleteSuggestions,
            onAutocompleteSuggestionSelect: handleAutocompleteSuggestionSelect,
            connectionStatus,
            statusBadges: launchStatusBadges,
            machinePopover,
            pathPopover,
            resumeSessionId,
            resumePopover,
            isResumeSupportChecking,
            sessionPromptInputMaxHeight,
            agentInputExtraActionChips,
            attachmentFlowId,
        },
    });

    const { profilePopover } = useNewSessionProfilePopover({
        useProfiles,
        profilesProps: wizardProfilesProps,
        serverId: targetServerId,
        machineName: selectedMachine?.metadata?.displayName || selectedMachine?.metadata?.host,
        popoverBoundaryRef,
    });

    const simplePanelProps = useNewSessionScreenSimplePanelProps({
        layout: {
            popoverBoundaryRef,
            headerHeight,
            safeAreaTop: safeArea.top,
            safeAreaBottom: safeArea.bottom,
            newSessionTopPadding: simpleNewSessionTopPadding,
            newSessionSidePadding: simpleNewSessionSidePadding,
            newSessionBottomPadding: simpleNewSessionBottomPadding,
            shouldBottomAnchor,
            containerStyle: styles.container as any,
        },
        creation: {
            sessionPrompt,
            setSessionPrompt,
            handleCreateSession,
            canCreate,
            isCreating,
            pendingLaunchAttempt,
            submitAccessibilityLabel,
            emptyAutocompletePrefixes,
            emptyAutocompleteSuggestions,
            onAutocompleteSuggestionSelect: handleAutocompleteSuggestionSelect,
            sessionPromptInputMaxHeight,
            statusBadges: launchStatusBadges,
        },
        agent: {
            agentInputExtraActionChips,
            agentType: selectedUiAgentType as AgentId,
            agentLabel,
            handleAgentClick,
            agentPickerOptions,
            agentPickerSelectedOptionId,
            onAgentPickerSelect: handleAgentPickerSelect,
            agentPickerProbe: cliAvailabilityProbe,
            selectedBackendTargetKey,
            selectedBackendEntryTargetKey: selectedBackendEntry?.backendTargetKey,
        },
        model: {
            permissionMode,
            handlePermissionModeChange,
            modelMode,
            setModelMode: setModelModeAndRemember,
            modelOptions,
            modelOptionsProbeState: {
                phase: modelOptionsProbeState.phase,
                onRefresh: modelOptionsProbeState.onRefresh,
            },
        },
        acp: {
            acpSessionModeOptions,
            acpSessionModeId,
            setAcpSessionModeId: setAcpSessionModeIdAndRemember,
            acpConfigOptions: acpConfigOptions ?? undefined,
            acpConfigOptionOverrides: sessionConfigOptionOverrides,
            setAcpConfigOptionOverride: setAcpConfigOptionOverrideAndRemember,
            acpSessionModeProbeState: {
                phase: acpSessionModeProbeState.phase,
                onRefresh: acpSessionModeProbeState.onRefresh,
            },
            acpConfigOptionsProbeState: {
                phase: acpConfigOptionsProbeState.phase,
                onRefresh: acpConfigOptionsProbeState.onRefresh,
            },
        },
        machineAndResume: {
            connectionStatus,
            machineDisplayName: selectedMachine?.metadata?.displayName,
            machineHost: selectedMachine?.metadata?.host,
            machinePopover,
            selectedMachineHomeDir: selectedMachine?.metadata?.homeDir ?? null,
            selectedPath,
            pathPopover,
            showResumePicker,
            resumeSessionId,
            resumePopover,
            isResumeSupportChecking,
        },
        profile: {
            useProfiles,
            selectedProfileId,
            selectedMachineId,
            profilePopover,
        },
        targetServerId,
        attachmentFlowId,
    });

    return buildNewSessionScreenVariantModel({
        useEnhancedSessionWizard,
        popoverBoundaryRef,
        simplePanelProps,
        checkoutCreationDraft,
        setCheckoutCreationDraft,
        wizardLayoutProps,
        wizardSectionPresentation: newSessionWizardSectionPresentationV1,
        wizardUseColumnLayout,
        wizardProfilesProps,
        wizardAgentProps,
        wizardMachineProps,
        wizardFooterProps,
    });
}
