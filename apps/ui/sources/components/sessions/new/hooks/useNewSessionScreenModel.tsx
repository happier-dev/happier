import React from 'react';
import { View, useWindowDimensions, InteractionManager } from 'react-native';
import { useLaunchSelectionMachines, useSessionRecentPathEntries, storage, useSetting, useSettingMutable, useSettings } from '@/sync/domains/state/storage';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { useRouter, useLocalSearchParams, useNavigation, usePathname } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { useHeaderHeight } from '@/utils/platform/responsive';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
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
import { getBuiltInProfile, DEFAULT_PROFILES, getProfilePrimaryCli, isProfileEnabled } from '@/sync/domains/profiles/profileUtils';
import { DEFAULT_AGENT_ID, getAgentCore, isAgentId, resolveAgentIdFromCliDetectKey, type AgentId } from '@/agents/catalog/catalog';
import { useEnabledAgentIds } from '@/agents/hooks/useEnabledAgentIds';
import { resolveBackendTargetFromRouteParams } from '@/agents/backendCatalog/backendTargetRouteParams';
import {
    getResolvedBackendCatalogEntries,
    resolveBuiltInAgentIdForBackendTarget,
} from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';

import { loadNewSessionDraft, type NewSessionDraft } from '@/sync/domains/state/persistence';
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
import { isMobileLayoutWidth } from '@/components/sessions/layout/isMobileLayoutWidth';
import { useProfileMap } from '@/components/sessions/new/modules/profileHelpers';
import { newSessionScreenStyles } from '@/components/sessions/new/newSessionScreenStyles';
import { coerceNewSessionModelMode } from '@/components/sessions/new/hooks/newSessionModelModePolicy';
import { useCreateNewSession } from '@/components/sessions/new/hooks/useCreateNewSession';
import { toggleHomeAwareDirectoryFavorite } from '@/components/sessions/new/hooks/favoriteDirectoriesToggle';
import { useNewSessionSimplePanelProps } from '@/components/sessions/new/hooks/useNewSessionSimplePanelProps';
import { useNewSessionWizardProps } from '@/components/sessions/new/hooks/useNewSessionWizardProps';
import { buildNewSessionProfileSelectionPopover } from '@/components/sessions/new/components/buildNewSessionProfileSelectionPopover';
import { useNewSessionAgentPickerControls } from '@/components/sessions/new/hooks/screenModel/useNewSessionAgentPickerControls';
import { resolveNewSessionCapabilityServerId } from '@/components/sessions/new/modules/resolveNewSessionCapabilityServerId';
import { resolveNewSessionCapabilityProbeContext } from '@/components/sessions/new/modules/newSessionCapabilityProbeContext';
import type { NewSessionTranscriptStorage } from '@/components/sessions/new/modules/newSessionTranscriptStorage';
import {
    resolveNextSelectableBackendEntryForNewSession,
} from '@/components/sessions/new/modules/newSessionAgentSelection';
import type { AgentInputChipPickerOption } from '@/components/sessions/agentInput/components/AgentInputChipPickerTypes';
import type { OptionPickerProbeState } from '@/components/sessions/pickers/OptionPickerOverlay';
import { useAutomationsSupport } from '@/hooks/server/useAutomationsSupport';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { resolveLocalFeaturePolicyEnabled } from '@/sync/domains/features/featureLocalPolicy';
import { useNewSessionConnectedServices } from '@/components/sessions/new/modules/useNewSessionConnectedServices';
import {
    buildNewSessionAuthoringDraftFromPersistedDraft,
    buildNewSessionAuthoringDraftFromTempData,
} from '@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters';
import {
    readNonBlankSessionControlIdentifier,
    readSessionControlValueId,
} from '@/sync/domains/sessionControl/opaqueIdentifiers';
import { useNewSessionServerTargetState } from '@/components/sessions/new/hooks/serverTarget/useNewSessionServerTargetState';
import { useNewSessionActiveServerSource } from '@/components/sessions/new/hooks/serverTarget/useNewSessionActiveServerSource';
import { useNewSessionBackendTargetState } from '@/components/sessions/new/hooks/screenModel/useNewSessionBackendTargetState';
import { useNewSessionMachinePathState } from '@/components/sessions/new/hooks/screenModel/useNewSessionMachinePathState';
import { useNewSessionPreflightModelsState } from '@/components/sessions/new/hooks/screenModel/useNewSessionPreflightModelsState';
import { useNewSessionPreflightConfigOptionsState } from '@/components/sessions/new/hooks/screenModel/useNewSessionPreflightConfigOptionsState';
import { useNewSessionPreflightSessionModesState } from '@/components/sessions/new/hooks/screenModel/useNewSessionPreflightSessionModesState';
import { useNewSessionRepoScmSnapshot } from '@/components/sessions/new/hooks/screenModel/useNewSessionRepoScmSnapshot';
import {
    buildAcpConfigOptionOverridesV1,
    buildBackendTargetKey,
    type AcpConfigOptionOverridesV1,
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
import { useNewSessionSourceContext } from '@/components/sessions/new/sourceContext/useNewSessionSourceContext';
import { useNewSessionTranscriptStorageState } from '@/components/sessions/new/hooks/screenModel/useNewSessionTranscriptStorageState';
import { useNewSessionAgentAuthoringOptionsState } from '@/components/sessions/new/hooks/screenModel/useNewSessionAgentAuthoringOptionsState';
import { useNewSessionPermissionModeState } from '@/components/sessions/new/hooks/screenModel/useNewSessionPermissionModeState';
import { useNewSessionPromptAutomationState } from '@/components/sessions/new/hooks/screenModel/useNewSessionPromptAutomationState';
import { useNewSessionSecretSelectionState } from '@/components/sessions/new/hooks/screenModel/useNewSessionSecretSelectionState';
import { useNewSessionHappyRouteFlag } from '@/components/sessions/new/hooks/screenModel/useNewSessionHappyRouteFlag';
import type { NewSessionScreenModel } from '@/components/sessions/new/hooks/newSessionScreenModelTypes';
import { serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { NewSessionPathSelectionContent } from '@/components/sessions/new/components/NewSessionPathSelectionContent';
import { machineMetadataPlatformToTarget } from '@/utils/path/machinePlatform';
import { NewSessionMachineSelectionContent } from '@/components/sessions/new/components/NewSessionMachineSelectionContent';
import { NewSessionResumeSelectionContent } from '@/components/sessions/new/components/NewSessionResumeSelectionContent';
import type { AgentInputContentPopoverConfig } from '@/components/sessions/agentInput/components/AgentInputContentPopover';
import { deferAgentInputPopoverClose } from '@/components/sessions/agentInput/selection/deferAgentInputPopoverClose';
import { useServerScopedMachineOptions } from '@/components/sessions/new/hooks/machines/useServerScopedMachineOptions';
import { useActiveServerAccountScope, useProfile as useAccountProfile } from '@/sync/store/hooks';
import { openDirectSessionsResumeIdPickerModal } from '@/components/sessions/directSessions/browse/openDirectSessionsResumeIdPickerModal';
import { canBrowseDirectSessions, resolveDirectBrowseLockedSource } from '@/components/sessions/directSessions/browse/resolveDirectBrowseLockedSourceOption';
import { deferOnWeb } from '@/utils/platform/deferOnWeb';
import { readRememberedEngineSelection } from '@/sync/domains/sessionAuthoring/rememberedEngineSelections';
import {
    useDeferredRememberedEngineSelection,
} from '@/components/sessions/new/hooks/screenModel/useDeferredRememberedEngineSelection';
import { getSuggestions } from '@/components/autocomplete/suggestions';
import type { ComposerSuggestionKindId } from '@/components/autocomplete/composerSuggestionKinds';
import { resolveNewSessionFileSuggestionScope } from '@/components/sessions/new/modules/resolveNewSessionFileSuggestionScope';


import { useStableValueBySignature } from '@/hooks/ui/useStableValueBySignature';

// Configuration constants
const RECENT_PATHS_DEFAULT_VISIBLE = 5;
// R-9: plugins and skills are session metadata published after spawn, so this host cannot offer
// them — there is no session to read a catalog from.
//
// `file` IS offered, because files are not session state: a file search is scoped by machine and
// folder, and this host has both (the user picks them before composing). It resolves through the
// same registry path an existing session's composer uses, with no host-specific branch. Until a
// machine and directory are chosen the `workspace` scope is null and the kind contributes nothing.
//
// `session` is different, and is offered here: the session list is an ACCOUNT/SERVER-level
// projection, not session-scoped state, so the only thing this host lacks is the session that
// would have named its server. It names that server directly instead (`targetServerId`, the
// server this new session will spawn on), which keeps D-8's same-server rule exact rather than
// approximate. The reference itself stays relative (`session:<id>`) and carries no server.
const NEW_SESSION_COMPOSER_SUGGESTION_KINDS: readonly ComposerSuggestionKindId[] = ['file', 'session', 'slashCommand'];
const styles = newSessionScreenStyles;

function buildNewSessionPopoverSignature(value: unknown): string {
    try {
        return JSON.stringify(value) ?? 'null';
    } catch {
        return 'unserializable';
    }
}

function buildNewSessionDraftSignature(draft: NewSessionDraft | null): string {
    if (draft === null) return 'null';
    try {
        return JSON.stringify(draft) ?? 'null';
    } catch {
        return 'unserializable';
    }
}

function resolveNewSessionAttachmentFlowId(params: Readonly<{
    dataId: string | string[] | undefined;
    draftScope: ServerAccountScope | null;
}>): string {
    if (typeof params.dataId === 'string') {
        const trimmedDataId = params.dataId.trim();
        if (trimmedDataId.length > 0) return `data:${trimmedDataId}`;
    }

    if (params.draftScope) {
        return `scope:${serverAccountScopeKeySuffix(params.draftScope)}`;
    }

    return 'legacy';
}

function useLatestRef<Value>(value: Value): React.MutableRefObject<Value> {
    const ref = React.useRef(value);
    ref.current = value;
    return ref;
}

function setNavigationParams(navigation: unknown, params: Record<string, unknown>): boolean {
    if (navigation === null || typeof navigation !== 'object') return false;
    const setParams = (navigation as { setParams?: (nextParams: Record<string, unknown>) => void }).setParams;
    if (typeof setParams !== 'function') return false;
    setParams(params);
    return true;
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
    const shouldBottomAnchor = isMobileLayoutWidth(screenWidth);

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
    const recentMachinePaths = useSetting('recentMachinePaths');
    const lastUsedAgent = useSetting('lastUsedAgent');
    const lastUsedBackendTarget = useSetting('lastUsedBackendTarget');
    const newSessionDefaultPersistenceModeV1 = useSetting('newSessionDefaultPersistenceModeV1');
    const newSessionDefaultPersistenceModeByTargetKeyV1 = useSetting('newSessionDefaultPersistenceModeByTargetKeyV1');
    const rememberLastEngineSelections = useSetting('rememberLastEngineSelectionsV1') !== false;
    const [lastEngineSelectionsByScope, setLastEngineSelectionsByScope] = useSettingMutable('lastEngineSelectionsByScopeV1');

    // A/B Test Flag - determines which wizard UI to show
    // Control A (false): Simpler AgentInput-driven layout
    // Variant B (true): Enhanced profile-first wizard with sections
    const useEnhancedSessionWizard = useSetting('useEnhancedSessionWizard');

    useNewSessionHappyRouteFlag(pathname);

    const sessionPromptInputMaxHeight = undefined;
    const useProfiles = useSetting('useProfiles');
    const [secrets, setSecrets] = useSettingMutable('secrets');
    const [secretBindingsByProfileId, setSecretBindingsByProfileId] = useSettingMutable('secretBindingsByProfileId');
    const sessionDefaultPermissionModeByTargetKey = useSetting('sessionDefaultPermissionModeByTargetKey');
    const settings = useSettings() ?? settingsDefaults;
    const accountProfile = useAccountProfile();
    const activeServerSource = useNewSessionActiveServerSource();
    const draftScope = useActiveServerAccountScope();

    // Try to get data from temporary store first
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

    // Load persisted draft state (survives remounts/screen navigation)
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
    const [launchUserAttemptId, setLaunchUserAttemptId] = React.useState<string | null>(() => (
        typeof persistedDraft?.launchUserAttemptId === 'string'
            ? persistedDraft.launchUserAttemptId
            : null
    ));
    React.useEffect(() => {
        setLaunchUserAttemptId(
            typeof persistedDraft?.launchUserAttemptId === 'string'
                ? persistedDraft.launchUserAttemptId
                : null,
        );
    }, [draftScope, persistedDraft?.launchUserAttemptId]);
    const requestedSpawnServerId = React.useMemo(() => {
        const normalizedRouteServerId = normalizeOptionalParam(spawnServerIdParam);
        const routeServerId = typeof normalizedRouteServerId === 'string' ? normalizedRouteServerId.trim() : '';
        if (routeServerId) return routeServerId;
        return typeof persistedDraft?.targetServerId === 'string' ? persistedDraft.targetServerId : null;
    }, [persistedDraft?.targetServerId, spawnServerIdParam]);
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
            spawnServerIdParam: requestedSpawnServerId,
        },
    });
    // New-session capability gating should be evaluated in spawn scope (target server),
    // not in main selection scope (which can be a multi-server group).
    // The continuation recipe rides the same one-shot temp-data channel as every
    // other rich New Session handoff; removing the chip clears only this value.
    const sourceContextState = useNewSessionSourceContext({
        seed: tempSessionData,
        targetServerId: targetServerId ?? null,
    });
    const automationsSupport = useAutomationsSupport({ scopeKind: 'spawn', serverId: targetServerId });
    const automationFeatureEnabled = automationsSupport?.enabled === true;

    const capabilityServerId = React.useMemo(() => {
        return resolveNewSessionCapabilityServerId({
            targetServerId,
            activeServerId: activeServerSource.activeServerId,
        });
    }, [activeServerSource.activeServerId, targetServerId]);
    const directSessionsFeatureEnabled = useFeatureEnabled('sessions.direct', { scopeKind: 'spawn', serverId: targetServerId });
    const connectedServicesFeatureEnabled = useFeatureEnabled('connectedServices', { scopeKind: 'spawn', serverId: targetServerId });
    const connectedServicesAccountGroupsFeatureEnabled = useFeatureEnabled('connectedServices.accountGroups', { scopeKind: 'spawn', serverId: targetServerId });
    const executionRunsEnabled = resolveLocalFeaturePolicyEnabled('execution.runs', settings);
    const useMachinePickerSearch = useSetting('useMachinePickerSearch');
    const usePathPickerSearch = useSetting('usePathPickerSearch');
    const newSessionWizardSectionPresentation = useSetting('newSessionWizardSectionPresentationV1');
    const newSessionWizardColumnsEnabled = useSetting('newSessionWizardColumnsEnabled');
    const newSessionDefaultCheckoutMode = useSetting('newSessionDefaultCheckoutModeV1');
    const [profiles, setProfiles] = useSettingMutable('profiles');
    const lastUsedProfile = useSetting('lastUsedProfile');
    const [favoriteDirectories, setFavoriteDirectories] = useSettingMutable('favoriteDirectories');
    const [favoriteMachines, setFavoriteMachines] = useSettingMutable('favoriteMachines');
    const [favoriteProfileIds, setFavoriteProfileIds] = useSettingMutable('favoriteProfiles');
    const [favoriteModelSelections, setFavoriteModelSelections] = useSettingMutable('favoriteModelSelectionsV1');
    const [favoriteBackendTargetKeys, setFavoriteBackendTargetKeys] = useSettingMutable('favoriteBackendTargetKeysV1');
    const [lastNewSessionAgentPickerView, setLastNewSessionAgentPickerView] = useSettingMutable('lastNewSessionAgentPickerViewV1');
    const [dismissedCLIWarnings, setDismissedCLIWarnings] = useSettingMutable('dismissedCLIWarnings');
    const effectiveAttachmentFlowId = React.useMemo(() => resolveNewSessionAttachmentFlowId({
        dataId,
        draftScope,
    }), [dataId, draftScope]);
    const previousDraftScopeRef = React.useRef(draftScope);
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
    const routeBackendTarget = React.useMemo(() => {
        return resolveBackendTargetFromRouteParams({
            backendTarget: backendTargetParam,
            backendTargetKey: backendTargetKeyParam,
            agentType: agentTypeParam,
        });
    }, [agentTypeParam, backendTargetKeyParam, backendTargetParam]);

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
    const resolvedBackendEntriesRaw = React.useMemo(() => {
        return getResolvedBackendCatalogEntries({
            enabledAgentIds,
            acpCatalogSettingsV1: settings.acpCatalogSettingsV1,
            backendEnabledByTargetKey: settings.backendEnabledByTargetKey,
            collapseConfiguredBackendProviderSentinels: true,
        });
    }, [enabledAgentIds, settings.acpCatalogSettingsV1, settings.backendEnabledByTargetKey]);
    const resolvedBackendEntriesSignature = React.useMemo(
        () => buildNewSessionPopoverSignature(resolvedBackendEntriesRaw.map((entry) => ({
            target: entry.target,
            targetKey: entry.targetKey,
            title: entry.title,
            subtitle: entry.subtitle,
            providerAgentId: entry.providerAgentId,
            builtInAgentId: entry.builtInAgentId,
            iconAgentId: entry.iconAgentId,
            family: entry.family,
        }))),
        [resolvedBackendEntriesRaw],
    );
    const resolvedBackendEntries = useStableValueBySignature(
        resolvedBackendEntriesRaw,
        resolvedBackendEntriesSignature,
    );

    useFocusEffect(
        React.useCallback(() => {
            setLoadedScopedPersistedDraft(loadScopedNewSessionDraft());
            // Ensure newly-registered machines show up without requiring an app restart.
            // Throttled to avoid spamming the server when navigating back/forth.
            // Defer until after interactions so the screen feels instant on iOS.
            InteractionManager.runAfterInteractions(() => {
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
        const builtInProfiles = DEFAULT_PROFILES.map(bp => getBuiltInProfile(bp.id)!);
        return [...builtInProfiles, ...profiles];
    }, [profiles]);

    const profileMap = useProfileMap(allProfiles);
    const selectableProfiles = React.useMemo(() => {
        return allProfiles.filter((profile) => isProfileEnabled(profile, settings.profileEnabledById));
    }, [allProfiles, settings.profileEnabledById]);
    const selectableProfileMap = useProfileMap(selectableProfiles);
    const machines = useLaunchSelectionMachines();
    const sessionRecentPathEntries = useSessionRecentPathEntries();
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
        if (resolvedBackendEntries.some((entry) => isProfileCompatibleWithBackendTarget(selected, entry.target))) {
            return;
        }
        setSelectedProfileId(null);
    }, [profileMap, resolvedBackendEntries, selectedProfileId, settings.profileEnabledById, useProfiles]);
    const effectiveMachineIdParam = React.useMemo(() => {
        const normalizedMachineIdParam = normalizeOptionalParam(machineIdParam);
        const raw = typeof normalizedMachineIdParam === 'string' ? normalizedMachineIdParam.trim() : '';
        if (raw) return raw;
        const temp = typeof tempSessionData?.machineId === 'string' ? tempSessionData.machineId.trim() : '';
        if (temp) return temp;
        return null;
    }, [machineIdParam, tempSessionData?.machineId]);

    const effectivePathParam = React.useMemo(() => {
        const normalizedDirectoryParam = normalizeOptionalParam(directoryParam);
        const directory = typeof normalizedDirectoryParam === 'string' ? normalizedDirectoryParam.trim() : '';
        if (directory) return directory;

        const normalizedPathParam = normalizeOptionalParam(pathParam);
        const raw = typeof normalizedPathParam === 'string' ? normalizedPathParam.trim() : '';
        if (raw) return raw;
        const temp = typeof hydratedTempAuthoringDraft?.directory === 'string' ? hydratedTempAuthoringDraft.directory.trim() : '';
        if (temp) return temp;
        return null;
    }, [directoryParam, hydratedTempAuthoringDraft?.directory, pathParam]);

    const effectiveWorktreeRouteMode = React.useMemo(() => {
        const normalizedWorktreeParam = normalizeOptionalParam(worktreeParam);
        const raw = typeof normalizedWorktreeParam === 'string' ? normalizedWorktreeParam.trim() : '';
        return raw || null;
    }, [worktreeParam]);

    const { backendTarget, setBackendTarget, builtInAgentId: agentType } = useNewSessionBackendTargetState({
        entries: resolvedBackendEntries,
        lastUsedAgent,
        lastUsedBackendTarget,
        routeBackendTarget,
        persistedBackendTarget: hydratedPersistedAuthoringDraft?.backendTarget,
        tempBackendTarget: routeBackendTarget ?? hydratedTempAuthoringDraft?.backendTarget ?? tempSessionData?.backendTarget,
        tempAgentType: hydratedTempAuthoringDraft?.agentId ?? agentTypeParam ?? hydratedPersistedAuthoringDraft?.agentId,
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
    const rememberedEngineSelection = React.useMemo(() => readRememberedEngineSelection({
        enabled: rememberLastEngineSelections,
        selectionsByScope: lastEngineSelectionsByScope,
        serverId: capabilityServerId,
        backendTarget,
    }), [
        backendTarget,
        capabilityServerId,
        lastEngineSelectionsByScope,
        rememberLastEngineSelections,
    ]);

    const {
        modelMode,
        setModelMode,
        acpSessionModeId,
        setAcpSessionModeId,
        sessionConfigOptionOverrides,
        setSessionConfigOptionOverrides,
        setSessionConfigOptionOverride,
        mcpSelection,
        setMcpSelection,
    } = useNewSessionAgentAuthoringOptionsState({
        agentType,
        backendTarget,
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

    const rememberCurrentEngineSelection = React.useCallback((selection: Readonly<{
        modelId?: string | null;
        acpSessionModeId?: string | null;
        sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1 | null;
    }>) => {
        const hasModelId = Object.prototype.hasOwnProperty.call(selection, 'modelId');
        const hasAcpSessionModeId = Object.prototype.hasOwnProperty.call(selection, 'acpSessionModeId');
        const hasSessionConfigOptionOverrides = Object.prototype.hasOwnProperty.call(selection, 'sessionConfigOptionOverrides');
        rememberEngineSelection(backendTarget, {
            modelId: hasModelId ? selection.modelId : modelMode,
            acpSessionModeId: hasAcpSessionModeId ? selection.acpSessionModeId : acpSessionModeId,
            sessionConfigOptionOverrides: hasSessionConfigOptionOverrides ? selection.sessionConfigOptionOverrides : sessionConfigOptionOverrides,
        });
    }, [
        acpSessionModeId,
        backendTarget,
        modelMode,
        rememberEngineSelection,
        sessionConfigOptionOverrides,
    ]);
    const setRememberedModelMode = React.useCallback<React.Dispatch<React.SetStateAction<ModelMode>>>((next) => {
        const nextModelMode = typeof next === 'function' ? next(modelMode) : next;
        setModelMode(nextModelMode);
        rememberCurrentEngineSelection({ modelId: nextModelMode });
    }, [modelMode, rememberCurrentEngineSelection, setModelMode]);
    const setRememberedAcpSessionModeId = React.useCallback<React.Dispatch<React.SetStateAction<string | null>>>((next) => {
        const nextSessionModeId = typeof next === 'function' ? next(acpSessionModeId) : next;
        setAcpSessionModeId(nextSessionModeId);
        rememberCurrentEngineSelection({ acpSessionModeId: nextSessionModeId });
    }, [acpSessionModeId, rememberCurrentEngineSelection, setAcpSessionModeId]);
    const setRememberedSessionConfigOptionOverrides = React.useCallback<React.Dispatch<React.SetStateAction<AcpConfigOptionOverridesV1 | null>>>((next) => {
        const nextOverrides = typeof next === 'function' ? next(sessionConfigOptionOverrides) : next;
        setSessionConfigOptionOverrides(nextOverrides);
        rememberCurrentEngineSelection({ sessionConfigOptionOverrides: nextOverrides });
    }, [rememberCurrentEngineSelection, sessionConfigOptionOverrides, setSessionConfigOptionOverrides]);
    const setRememberedSessionConfigOptionOverride = React.useCallback((configId: string, value: string) => {
        const normalizedConfigId = readNonBlankSessionControlIdentifier(configId) ?? '';
        const normalizedValue = readSessionControlValueId(value) ?? '';
        if (!normalizedConfigId || !normalizedValue) return;

        const currentRawValue = sessionConfigOptionOverrides?.overrides?.[normalizedConfigId]?.value;
        const currentValue = readSessionControlValueId(currentRawValue) ?? '';
        if (currentValue === normalizedValue) return;

        const updatedAt = Date.now();
        const nextOverrides = buildAcpConfigOptionOverridesV1({
            updatedAt,
            overrides: {
                ...(sessionConfigOptionOverrides?.overrides ?? {}),
                [normalizedConfigId]: {
                    updatedAt,
                    value: normalizedValue,
                },
            },
        });
        setSessionConfigOptionOverrides(nextOverrides);
        rememberCurrentEngineSelection({ sessionConfigOptionOverrides: nextOverrides });
    }, [rememberCurrentEngineSelection, sessionConfigOptionOverrides, setSessionConfigOptionOverrides]);

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
        sessions: sessionRecentPathEntries,
        machineIdParam: effectiveMachineIdParam,
        pathParam: effectivePathParam,
        persistedMachineId: persistedDraft?.selectedMachineId ?? null,
        persistedPath: hydratedPersistedAuthoringDraft?.directory ?? null,
        cacheScopeKey: capabilityServerId,
    });

    const emptyAutocompleteKinds = NEW_SESSION_COMPOSER_SUGGESTION_KINDS;

    const getBestPathForMachineRef = React.useRef(getBestPathForMachine);
    React.useEffect(() => {
        getBestPathForMachineRef.current = getBestPathForMachine;
    }, [getBestPathForMachine]);
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
        defaultCheckoutMode: newSessionDefaultCheckoutMode,
        autoOpenWorktreePickerKey: effectiveWorktreeRouteMode === 'new'
            ? `route:new:${selectedMachineId ?? ''}:${selectedPath}`
            : null,
    });
    const selectedMachine = React.useMemo(() => {
        if (!selectedMachineId) return null;
        return machines.find(m => m.id === selectedMachineId) ?? null;
    }, [selectedMachineId, machines]);
    const selectedMachineHomeDir = selectedMachine?.metadata?.homeDir ?? null;
    // Routed through the registry like every other composer host: the eligible-kind
    // subset is the only thing that decides which triggers resolve here (INV-1),
    // and a hand-rolled `startsWith('/')` would be a second decision-maker.
    const emptyAutocompleteSuggestions = React.useCallback(
        (query: string, signal: AbortSignal) => getSuggestions(null, query, {
            kinds: NEW_SESSION_COMPOSER_SUGGESTION_KINDS,
            // There is genuinely no session yet, so say so rather than passing a fake id. The
            // spawn target is the only correct scope for `@session` here (D-8).
            serverId: targetServerId,
            // The machine and folder the user has chosen for the session about to be spawned:
            // the same addressing an existing session resolves for itself.
            workspace: resolveNewSessionFileSuggestionScope({
                targetServerId,
                selectedMachineId,
                selectedMachineHomeDir,
                selectedPath,
            }),
            signal,
        }),
        [selectedMachineId, selectedMachineHomeDir, selectedPath, targetServerId],
    );
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
        getCompatibleProfileBackendEntries,
        profileAvailabilityById,
        selectedMachineIsWindows,
        selectedMachineSpawnReadiness,
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
    const refreshCliAvailabilityRef = useLatestRef(cliAvailability.refresh);
    const refreshCliAvailability = React.useCallback(() => {
        void refreshCliAvailabilityRef.current({ bypassCache: true });
    }, [refreshCliAvailabilityRef]);

    const cliAvailabilityProbePhase: OptionPickerProbeState['phase'] = cliAvailability.isDetecting
        ? (cliAvailability.timestamp > 0 ? 'refreshing' : 'loading')
        : 'idle';
    const cliAvailabilityProbe = React.useMemo(() => (
        selectedMachineId
            ? {
                phase: cliAvailabilityProbePhase,
                onRefresh: refreshCliAvailability,
            }
            : undefined
    ), [cliAvailabilityProbePhase, refreshCliAvailability, selectedMachineId]);
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
        targetServerId,
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

    const { preflightModels, preflightModelsTargetKey, modelOptions, probe: modelOptionsProbeState } = useNewSessionPreflightModelsState({
        backendTarget,
        selectedMachineId,
        capabilityServerId,
        cwd: selectedPath,
        profileId: useProfiles ? selectedProfileId : null,
        probeContext: resolveNewSessionCapabilityProbeContext({ backendTarget, settings }),
        connectedServices: connectedServicesBindingsPayload,
    });

    const { preflightModes: preflightSessionModes, modeOptions: acpSessionModeOptions, probe: acpSessionModeProbeState } =
        useNewSessionPreflightSessionModesState({
            backendTarget,
            selectedMachineId,
            capabilityServerId,
            cwd: selectedPath,
            probeContext: resolveNewSessionCapabilityProbeContext({ backendTarget, settings }),
            connectedServices: connectedServicesBindingsPayload,
        });
    const { configOptions: acpConfigOptions, probe: acpConfigOptionsProbeState } = useNewSessionPreflightConfigOptionsState({
        backendTarget,
        selectedMachineId,
        capabilityServerId,
        cwd: selectedPath,
        probeContext: resolveNewSessionCapabilityProbeContext({ backendTarget, settings }),
        connectedServices: connectedServicesBindingsPayload,
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
        promptStore,
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

    const [windowsRemoteSessionLaunchModeOverrideDraft, setWindowsRemoteSessionLaunchModeOverrideDraft] =
        React.useState<NewSessionDraft['windowsRemoteSessionLaunchModeOverride']>(() => {
            const persistedOverride = persistedDraft?.windowsRemoteSessionLaunchModeOverride ?? null;
            if (!persistedOverride || persistedOverride.machineId !== selectedMachineId) return null;
            return persistedOverride;
        });

    React.useEffect(() => {
        setWindowsRemoteSessionLaunchModeOverrideDraft((current) => {
            if (!current || current.machineId === selectedMachineId) return current;
            return null;
        });
    }, [selectedMachineId]);
    const windowsRemoteSessionLaunchModeOverride = windowsRemoteSessionLaunchModeOverrideDraft?.machineId === selectedMachineId
        ? windowsRemoteSessionLaunchModeOverrideDraft.mode
        : null;
    const setWindowsRemoteSessionLaunchModeOverride = React.useCallback((nextMode: WindowsRemoteSessionLaunchMode | null) => {
        if (!selectedMachineId || !nextMode) {
            setWindowsRemoteSessionLaunchModeOverrideDraft(null);
            return;
        }
        setWindowsRemoteSessionLaunchModeOverrideDraft({
            machineId: selectedMachineId,
            mode: nextMode,
        });
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
        sessions: sessionRecentPathEntries,
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
        activeServerId: activeServerSource.activeServerId,
        activeMachines: machines,
        refreshToken: activeServerSource.serverProfilesSignature,
    });
    // RUX-3 + FR4-7: bridge `useSettingMutable('favoriteDirectories')` into the
    // path popover so every row exposes a star toggle. The setter is the
    // canonical settings-sync hook (it routes through `sealSecretsDeep` + the
    // pending-delta machinery), so we just hand it the next array. The
    // home-aware comparison is delegated to `toggleHomeAwareDirectoryFavorite`
    // so a stored shorthand like `~/src/app` is correctly removed when the
    // user toggles its absolute equivalent (and vice versa). The home dir is
    // read from the bound machine at call time so the toggle stays correct
    // even if the user switches machines while the popover is open.
    const handleToggleFavoriteDirectory = React.useCallback((absolutePath: string) => {
        const homeDir = selectedMachine?.metadata?.homeDir ?? null;
        const next = toggleHomeAwareDirectoryFavorite(
            favoriteDirectories,
            absolutePath,
            homeDir,
        );
        setFavoriteDirectories([...next]);
    }, [favoriteDirectories, selectedMachine?.metadata?.homeDir, setFavoriteDirectories]);
    const pathPopoverSignature = React.useMemo(() => buildNewSessionPopoverSignature({
        favoriteDirectories,
        recentPaths,
        selectedMachineId: selectedMachine?.id ?? null,
        selectedMachineHomeDir: selectedMachine?.metadata?.homeDir ?? null,
        selectedMachinePlatform: selectedMachine?.metadata?.platform ?? null,
        selectedPath,
        targetServerId: targetServerId ?? null,
    }), [
        favoriteDirectories,
        recentPaths,
        selectedMachine?.id,
        selectedMachine?.metadata?.homeDir,
        selectedMachine?.metadata?.platform,
        selectedPath,
        targetServerId,
    ]);

    const pathPopover = React.useMemo<AgentInputContentPopoverConfig>(() => ({
        renderContent: ({ requestClose, maxHeight }) => (
            <NewSessionPathSelectionContent
                machineHomeDir={selectedMachine?.metadata?.homeDir || '/home'}
                selectedPath={selectedPath}
                initialSuggestionMode="history"
                onCommit={(nextPath) => {
                    setSelectedPath(nextPath);
                    requestClose();
                }}
                onChangeDraftSelectedPath={setDraftSelectedPath}
                recentPaths={recentPaths}
                favoriteDirectories={favoriteDirectories}
                onToggleFavoriteDirectory={handleToggleFavoriteDirectory}
                machineId={selectedMachine?.id ?? null}
                serverId={targetServerId ?? null}
                machinePlatform={machineMetadataPlatformToTarget(selectedMachine?.metadata?.platform)}
                onRequestClose={requestClose}
                // FR3-10: do NOT pass requestClose as onBeforeBrowseMachinePath.
                // Pre-closing the popover before opening MachinePathBrowserModal
                // destroyed popover state (see the plan §363) so the user could
                // not return to the popover after dismissing the modal. The modal
                // already renders above the popover in the shared modal stack
                // (Radix Dialog on web, portal-style overlay on native), so
                // leaving the popover mounted underneath is safe. Omit the prop
                // entirely so PathSelectionList.handleOpenTreeBrowser skips its
                // optional pre-close await.
                // RUX-8: thread the popover's computed maxHeight into the
                // SelectionList so the body scrolls within the surface and
                // the footer (keyboard hints) stays pinned to the bottom.
                maxHeight={maxHeight}
            />
        ),
        maxHeightCap: 560,
        maxWidthCap: 560,
        scrollEnabled: false,
        keyboardShouldPersistTaps: 'handled',
    }), [
        pathPopoverSignature,
        setDraftSelectedPath,
        setSelectedPath,
    ]);
    const machinePopoverSignature = React.useMemo(() => buildNewSessionPopoverSignature({
        favoriteMachineItems,
        machinePopoverGroups,
        recentMachines,
        selectedMachineId: selectedMachine?.id ?? null,
        selectedServerId,
        useMachinePickerSearch,
    }), [
        favoriteMachineItems,
        machinePopoverGroups,
        recentMachines,
        selectedMachine?.id,
        selectedServerId,
        useMachinePickerSearch,
    ]);

    const machinePopover = React.useMemo<AgentInputContentPopoverConfig>(() => ({
        renderContent: ({ requestClose, maxHeight }) => (
            <NewSessionMachineSelectionContent
                groups={machinePopoverGroups}
                selectedMachine={selectedMachine ?? null}
                selectedServerId={selectedServerId}
                recentMachines={recentMachines}
                favoriteMachines={favoriteMachineItems}
                serverId={selectedServerId}
                onSelectMachine={(machine) => {
                    setSelectedMachineId(machine.id);
                    setSelectedPath(getBestPathForMachineRef.current(machine.id));
                    deferAgentInputPopoverClose(requestClose);
                }}
                onSelectScopedMachine={(machine) => {
                    setSelectedMachineId(machine.id);
                    setSelectedPath(getBestPathForMachineRef.current(machine.id));
                    deferAgentInputPopoverClose(requestClose);
                }}
                showSearch={useMachinePickerSearch}
                searchPlacement="header"
                testIdPrefix="new-session-machine"
                maxHeight={maxHeight}
            />
        ),
        maxHeightCap: 560,
        maxWidthCap: 560,
        scrollEnabled: false,
        keyboardShouldPersistTaps: 'handled',
        edgeFades: { top: true, bottom: true, size: 28 },
        edgeIndicators: true,
        initialVisibility: { top: true, bottom: true },
    }), [
        machinePopoverSignature,
        setSelectedMachineId,
        setSelectedPath,
    ]);

    const resolvePreferredCompatibleProfileBackendEntry = React.useCallback((profile: AIBackendProfile) => {
        const compatibleBackendEntries = getCompatibleProfileBackendEntries(profile);
        const currentCompatible = compatibleBackendEntries.some((entry) => entry.targetKey === selectedBackendTargetKey);

        if (compatibleBackendEntries.length === 0 || currentCompatible) {
            return null;
        }

        return resolveNextSelectableBackendEntryForNewSession({
            candidateBackendEntries: compatibleBackendEntries,
            currentTargetKey: selectedBackendTargetKey,
            detectionTimestamp: cliAvailability.timestamp,
            availabilityById: cliAvailability.available,
            authStatusById: cliAvailability.authStatus,
            installableDepKeyCountByAgentId,
            selectableWithoutCliByAgentId,
        });
    }, [
        cliAvailability.authStatus,
        cliAvailability.available,
        cliAvailability.timestamp,
        getCompatibleProfileBackendEntries,
        installableDepKeyCountByAgentId,
        selectableWithoutCliByAgentId,
        selectedBackendTargetKey,
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

            const nextEntry = resolvePreferredCompatibleProfileBackendEntry(profile);
            if (nextEntry) {
                setBackendTarget(nextEntry.target);
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
        profileMap,
        resolvePreferredCompatibleProfileBackendEntry,
        selectedProfileId,
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

    const canSelectProfile = React.useCallback((profileId: string): boolean => {
        const profile = profileMap.get(profileId) ?? getBuiltInProfile(profileId);
        if (!profile) {
            return false;
        }
        // Keep profiles selectable when they still have structural backend support,
        // even if all compatible backends are currently logged out or undiscovered.
        return getCompatibleProfileBackendEntries(profile).length > 0;
    }, [getCompatibleProfileBackendEntries, profileMap]);

    const getProfileDisabled = React.useCallback((profile: { id: string }) => {
        return !canSelectProfile(profile.id);
    }, [canSelectProfile]);

    const getProfileSubtitleExtra = React.useCallback((profile: { id: string }) => {
        const availability = profileAvailabilityById.get(profile.id) ?? { available: true };
        if (availability.available || !availability.reason) return null;
        if (availability.reason.startsWith('logged-out:')) {
            return t('profiles.machineLogin.status.notLoggedIn');
        }
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
        if (!canSelectProfile(profile.id)) return;
        selectProfile(profile.id);
    }, [canSelectProfile, selectProfile]);

    // Handle profile route param from picker screens
    React.useEffect(() => {
        if (!useProfiles) {
            return;
        }

        const { nextSelectedProfileId, shouldClearParam } = consumeProfileIdParam({
            profileIdParam,
            selectedProfileId,
        });
        const rejectedProfileIdParam = typeof nextSelectedProfileId === 'string' && !canSelectProfile(nextSelectedProfileId);

        if (nextSelectedProfileId === null) {
            if (selectedProfileId !== null) {
                setSelectedProfileId(null);
            }
        } else if (typeof nextSelectedProfileId === 'string' && !rejectedProfileIdParam) {
            selectProfile(nextSelectedProfileId);
        }

        if (shouldClearParam || rejectedProfileIdParam) {
            if (setNavigationParams(navigation, { profileId: undefined })) {
                return;
            }
            navigation.dispatch({
                type: 'SET_PARAMS',
                payload: { params: { profileId: undefined } },
            } as never);
        }
    }, [canSelectProfile, navigation, profileIdParam, selectedProfileId, selectProfile, setSelectedProfileId, useProfiles]);

    // Keep agentType compatible with the currently selected profile.
    React.useEffect(() => {
        if (!useProfiles || selectedProfileId === null) {
            return;
        }

        const profile = profileMap.get(selectedProfileId) || getBuiltInProfile(selectedProfileId);
        if (!profile) {
            return;
        }

        const nextEntry = resolvePreferredCompatibleProfileBackendEntry(profile);
        if (nextEntry) {
            setBackendTarget(nextEntry.target);
        }
    }, [profileMap, resolvePreferredCompatibleProfileBackendEntry, selectedProfileId, setBackendTarget, useProfiles]);

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
            modelConfig: {
                defaultMode: core.model.defaultMode,
                allowedModes: core.model.allowedModes,
                supportsFreeform: core.model.supportsFreeform,
                dynamicProbe: core.model.dynamicProbe ?? 'auto',
            },
            preflight: preflightModels
                ? {
                    availableModels: preflightModels.availableModels.map((m) => ({ id: m.id })),
                    supportsFreeform: preflightModels.supportsFreeform === true,
                    targetKey: preflightModelsTargetKey,
                }
                : null,
            currentTargetKey: selectedBackendEntry?.targetKey ?? selectedBackendTargetKey,
        });
        if (next !== modelMode) {
            setModelMode(next as ModelMode);
        }
    }, [agentType, modelMode, preflightModels, preflightModelsTargetKey, selectedBackendEntry?.targetKey, selectedBackendTargetKey]);

    const clearBackendTargetRouteParamsAfterExplicitSelection = React.useCallback(() => {
        if (
            typeof agentTypeParam !== 'string'
            && typeof backendTargetParam !== 'string'
            && typeof backendTargetKeyParam !== 'string'
        ) {
            return;
        }

        const paramsToClear = {
            agentType: undefined,
            backendTarget: undefined,
            backendTargetKey: undefined,
        };
        if (setNavigationParams(navigation, paramsToClear)) {
            return;
        }
        navigation.dispatch({
            type: 'SET_PARAMS',
            payload: { params: paramsToClear },
        } as never);
    }, [agentTypeParam, backendTargetKeyParam, backendTargetParam, navigation]);

    const {
        agentPickerOptions,
        agentPickerSelectedOptionId,
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
        accountProfileConnectedServicesV2: accountProfile?.connectedServicesV2 ?? [],
        connectedServicesFeatureEnabled,
        connectedServicesAccountGroupsFeatureEnabled,
        agentNewSessionOptionStateByAgentId,
        favoriteModelSelections,
        setFavoriteModelSelections,
        favoriteBackendTargetKeys,
        setFavoriteBackendTargetKeys,
        rememberedAgentPickerView: lastNewSessionAgentPickerView,
        onRememberAgentPickerView: setLastNewSessionAgentPickerView,
        refreshProbe: cliAvailabilityProbe ?? null,
        rememberEngineSelectionsEnabled: rememberLastEngineSelections,
        rememberedEngineSelectionsByScope: lastEngineSelectionsByScope,
        rememberedEngineSelectionServerId: capabilityServerId,
        onRememberEngineSelection: rememberEngineSelection,
        onExplicitBackendTargetSelection: clearBackendTargetRouteParamsAfterExplicitSelection,
    });

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
                        onBrowse: async ({ webPortalTarget }) => {
                            if (!selectedMachineId) return null;
                            const source = resolveDirectBrowseLockedSource({
                                providerId: agentType as any,
                                agentOptionState,
                                profile: accountProfile,
                                settings,
                            });
                            if (!source) return null;
                            requestClose();
                            await new Promise<void>((resolve) => {
                                deferOnWeb(() => {
                                    deferOnWeb(resolve);
                                });
                            });
                            return await openDirectSessionsResumeIdPickerModal({
                                lockScope: {
                                    machineId: selectedMachineId,
                                    serverId: targetServerId ?? null,
                                    providerId: agentType as any,
                                    source,
                                },
                                title: t('directSessions.browseTitle'),
                                webPortalTarget,
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
        canCreate: canCreateFromAuthoring,
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
        selectedMachineSpawnReadiness,
        selectedPath,
        checkoutCreationDraft,
        promptStore,
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
        targetServerId: targetServerId ?? null,
        windowsRemoteSessionLaunchModeOverride: windowsRemoteSessionLaunchModeOverrideDraft?.machineId === selectedMachineId
            ? windowsRemoteSessionLaunchModeOverrideDraft
            : null,
        acpSessionModeId,
        sessionConfigOptionOverrides,
        automationEditId,
        automationRequestedByRoute,
        selectedSecretId,
        selectedSecretIdByProfileIdByEnvVarName,
        getSessionOnlySecretValueEncByProfileIdByEnvVarName: () => getSessionOnlySecretValueEncByProfileIdByEnvVarName() ?? {},
        agentNewSessionOptionStateByAgentId,
        draftScope,
        launchUserAttemptId,
    });

    // V1 requires the source Session and the target to share a server. Block
    // submission rather than silently dropping the continuation recipe; the user
    // can switch back or remove the chip.
    const canCreate = canCreateFromAuthoring && !sourceContextState.serverMismatch;

    const onLaunchUserAttemptIdChange = React.useCallback((nextUserAttemptId: string | null) => {
        const normalized = typeof nextUserAttemptId === 'string' && nextUserAttemptId.trim().length > 0
            ? nextUserAttemptId.trim()
            : null;
        setLaunchUserAttemptId(normalized);
        const currentDraft = buildCurrentPersistedDraft();
        if (normalized) {
            persistDraftIfEnabled({ ...currentDraft, launchUserAttemptId: normalized });
            return;
        }
        const nextDraft = { ...currentDraft };
        delete nextDraft.launchUserAttemptId;
        persistDraftIfEnabled(nextDraft);
    }, [buildCurrentPersistedDraft, persistDraftIfEnabled]);
    // The signature covers everything about the launch intent EXCEPT the live composer text:
    // the text is no longer a render input, so including it here would make the signature
    // change at arbitrary render boundaries instead of at the keystroke. Text changes are
    // handled by the two places that consume the signature's text meaning — the retryable
    // launch attempt (compared against its own recorded prompt in `useCreateNewSession`) and
    // the persisted user-attempt id (invalidated by the store subscription below).
    const launchIntentSignature = React.useMemo(() => {
        const { prompt: _prompt, displayText: _displayText, ...launchIntentWithoutText } = currentAuthoringDraft;
        return JSON.stringify({
            draft: launchIntentWithoutText,
            machineId: selectedMachineId,
            targetServerId: targetServerId ?? null,
            sourceContext: sourceContextState.sourceContext,
        });
    }, [currentAuthoringDraft, selectedMachineId, sourceContextState.sourceContext, targetServerId]);
    const previousLaunchIntentSignatureRef = React.useRef(launchIntentSignature);
    React.useEffect(() => {
        if (previousLaunchIntentSignatureRef.current === launchIntentSignature) return;
        previousLaunchIntentSignatureRef.current = launchIntentSignature;
        if (launchUserAttemptId) {
            onLaunchUserAttemptIdChange(null);
        }
    }, [launchIntentSignature, launchUserAttemptId, onLaunchUserAttemptIdChange]);

    // Editing the prompt invalidates a persisted user-attempt id exactly as a launch-intent
    // change does — without rendering this hook while the user types.
    const launchUserAttemptIdRef = React.useRef(launchUserAttemptId);
    launchUserAttemptIdRef.current = launchUserAttemptId;
    const onLaunchUserAttemptIdChangeRef = React.useRef(onLaunchUserAttemptIdChange);
    onLaunchUserAttemptIdChangeRef.current = onLaunchUserAttemptIdChange;
    React.useEffect(() => promptStore.subscribe(() => {
        if (!launchUserAttemptIdRef.current) return;
        onLaunchUserAttemptIdChangeRef.current(null);
    }), [promptStore]);

    const draftTextSource = React.useMemo(() => ({
        getLength: () => promptStore.getPrompt().length,
        subscribe: promptStore.subscribe,
    }), [promptStore]);

    const { handleCreateSession } = useCreateNewSession({
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
        permissionMode,
        modelMode,
        acpSessionModeId,
        sessionConfigOptionOverrides,
        promptStore,
        setSessionPrompt,
        automationEditId,
        resumeSessionId,
        agentNewSessionOptions,
        executionRunsEnabled,
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
        draftScope,
        disableDraftPersistence,
        launchIntentSignature,
        launchUserAttemptId,
        onLaunchUserAttemptIdChange,
        sourceContext: sourceContextState.sourceContext,
        preflightModels,
    });

    const {
        connectionStatus,
        agentInputExtraActionChips,
    } = useNewSessionAgentInputPresentation({
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
        promptStore,
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
        sourceContextChip: sourceContextState.chip,
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
        draftText: draftTextSource,
        draftChangeKey: launchIntentSignature,
    });

    const submitAccessibilityLabel = newSessionAuthoringContext.submitAccessibilityLabelKey
        ? t(newSessionAuthoringContext.submitAccessibilityLabelKey)
        : undefined;
    const modelOptionsProbe = React.useMemo(() => ({
        phase: modelOptionsProbeState.phase,
        onRefresh: modelOptionsProbeState.onRefresh,
    }), [modelOptionsProbeState.onRefresh, modelOptionsProbeState.phase]);
    const acpSessionModeProbe = React.useMemo(() => ({
        phase: acpSessionModeProbeState.phase,
        onRefresh: acpSessionModeProbeState.onRefresh,
    }), [acpSessionModeProbeState.onRefresh, acpSessionModeProbeState.phase]);
    const acpConfigOptionsProbe = React.useMemo(() => ({
        phase: acpConfigOptionsProbeState.phase,
        onRefresh: acpConfigOptionsProbeState.onRefresh,
    }), [acpConfigOptionsProbeState.onRefresh, acpConfigOptionsProbeState.phase]);

    const {
        profiles: wizardProfilesProps,
        wizardSections,
    } = useNewSessionWizardProps({
        enabled: useEnhancedSessionWizard,
        theme,
        styles,
        safeAreaTop: safeArea.top,
        safeAreaBottom: safeArea.bottom,
        headerHeight,
        newSessionTopPadding: simpleNewSessionTopPadding,
        newSessionSidePadding,
        newSessionBottomPadding,
        shouldBottomAnchor,
        sectionPresentation: newSessionWizardSectionPresentation,
        useColumnLayout: newSessionWizardColumnsEnabled === true,

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
        agentType,
        agentLabel,
        setAgentType,
        agentPickerOptions,
        agentPickerSelectedOptionId,
        onAgentPickerSelect: handleAgentPickerSelect,
        selectedBackendEntry,
        modelOptions,
        modelOptionsProbe,
        favoriteModelSelections,
        setFavoriteModelSelections,
        acpSessionModeOptions,
        acpSessionModeProbe,
        acpSessionModeId,
        setAcpSessionModeId: setRememberedAcpSessionModeId,
        acpConfigOptions: acpConfigOptions ?? undefined,
        acpConfigOptionsProbe,
        acpConfigOptionOverrides: sessionConfigOptionOverrides,
        setSessionConfigOptionOverride: setRememberedSessionConfigOptionOverride,
        modelMode,
        setModelMode: setRememberedModelMode,
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
        setDraftSelectedPath,
        pathPopover,
        favoriteMachines,
        setFavoriteMachines,
        selectedPath,
        recentPaths,
        usePathPickerSearch,
        favoriteDirectories,
        setFavoriteDirectories,

        promptStore,
        setSessionPrompt,
        handleCreateSession,
        canCreate,
        isCreating,
        submitAccessibilityLabel,
        emptyAutocompleteKinds,
        emptyAutocompleteSuggestions,
        connectionStatus,
        machinePopover,
        resumeSessionId,
        resumePopover,
        isResumeSupportChecking,
        sessionPromptInputMaxHeight,
        agentInputExtraActionChips,
        attachmentFlowId: effectiveAttachmentFlowId,
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
        shouldBottomAnchor,
        containerStyle: styles.container as any,
        promptStore,
        setSessionPrompt,
        handleCreateSession,
        canCreate,
        isCreating,
        submitAccessibilityLabel,
        emptyAutocompleteKinds,
        emptyAutocompleteSuggestions,
        sessionPromptInputMaxHeight,
        agentType,
        agentLabel,
        handleAgentClick,
        agentPickerOptions,
        agentPickerSelectedOptionId,
        onAgentPickerSelect: handleAgentPickerSelect,
        agentPickerProbe: cliAvailabilityProbe,
        permissionMode,
        handlePermissionModeChange,
        modelMode,
        setModelMode: setRememberedModelMode,
        modelOptions,
        modelOptionsProbe,
        acpSessionModeOptions,
        acpSessionModeProbe,
        acpSessionModeId,
        setAcpSessionModeId: setRememberedAcpSessionModeId,
        acpConfigOptions: acpConfigOptions ?? undefined,
        acpConfigOptionsProbe,
        acpConfigOptionOverrides: sessionConfigOptionOverrides,
        setSessionConfigOptionOverride: setRememberedSessionConfigOptionOverride,
        connectionStatus,
        machineName: selectedMachine?.metadata?.displayName || selectedMachine?.metadata?.host,
        machinePopover,
        selectedMachineId,
        selectedMachineHomeDir: selectedMachine?.metadata?.homeDir ?? null,
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
        attachmentFlowId: effectiveAttachmentFlowId,
    });

    return buildNewSessionScreenVariantModel({
        useEnhancedSessionWizard,
        popoverBoundaryRef,
        simplePanelProps,
        checkoutCreationDraft,
        setCheckoutCreationDraft,
        wizardProfilesProps,
        wizardSections,
    });
}
