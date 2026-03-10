import React from 'react';
import { View, Platform, useWindowDimensions, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAllMachines, storage, useSetting, useSettingMutable, useSettings } from '@/sync/domains/state/storage';
import { useRouter, useLocalSearchParams, useNavigation, usePathname } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { useHeaderHeight } from '@/utils/platform/responsive';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Modal } from '@/modal';
import { sync } from '@/sync/sync';
import { getTempData, type NewSessionData } from '@/utils/sessions/tempDataStore';
import { fireAndForget } from '@/utils/system/fireAndForget';
import {
    DEFAULT_NEW_SESSION_AUTOMATION_DRAFT,
    sanitizeNewSessionAutomationDraft,
    type NewSessionAutomationDraft,
} from '@/sync/domains/automations/automationDraft';
import { isPermissionMode, type PermissionMode, type ModelMode } from '@/sync/domains/permissions/permissionTypes';
import { normalizePermissionModeForAgentType } from '@/sync/domains/permissions/permissionModeOptions';
import { readAccountPermissionDefaults, resolveNewSessionDefaultPermissionMode } from '@/sync/domains/permissions/permissionDefaults';
import { parseNewSessionWorkspaceDraft } from '@/sync/domains/state/newSessionWorkspaceDraft';
import {
    getProfileEnvironmentVariables,
    isProfileCompatibleWithBackendTarget,
    type AIBackendProfile,
} from '@/sync/domains/profiles/profileCompatibility';
import { type SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import { getBuiltInProfile, DEFAULT_PROFILES, getProfilePrimaryCli } from '@/sync/domains/profiles/profileUtils';
import { useCLIDetection } from '@/hooks/auth/useCLIDetection';
import { DEFAULT_AGENT_ID, getAgentCore, isAgentId, resolveAgentIdFromCliDetectKey, type AgentId } from '@/agents/catalog/catalog';
import { useEnabledAgentIds } from '@/agents/hooks/useEnabledAgentIds';
import {
    getResolvedBackendCatalogEntries,
    resolveBuiltInAgentIdForBackendTarget,
} from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { applyCliWarningDismissal, isCliWarningDismissed } from '@/agents/runtime/cliWarnings';
import { canAgentResume } from '@/agents/runtime/resumeCapabilities';

import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { loadNewSessionDraft, saveNewSessionDraft } from '@/sync/domains/state/persistence';
import { EnvironmentVariablesPreviewModal } from '@/components/sessions/new/components/EnvironmentVariablesPreviewModal';
import { consumeProfileIdParam, consumeSecretIdParam } from '@/profileRouteParams';
import { useFocusEffect } from '@react-navigation/native';
import { getRecentPathsForMachine } from '@/utils/sessions/recentPaths';
import { useMachineEnvPresence } from '@/hooks/machine/useMachineEnvPresence';
import { InteractionManager } from 'react-native';
import { runAfterInteractionsWithFallback } from '@/utils/timing/runAfterInteractionsWithFallback';
import { getMachineCapabilitiesSnapshot, prefetchMachineCapabilities, prefetchMachineCapabilitiesIfStale, useMachineCapabilitiesCache } from '@/hooks/server/useMachineCapabilitiesCache';
import { CAPABILITIES_REQUEST_NEW_SESSION } from '@/capabilities/requests';
import { getInstallablesRegistryEntries } from '@/capabilities/installablesRegistry';
import { resolveTerminalSpawnOptions } from '@/sync/domains/settings/terminalSettings';
import type { CapabilityId } from '@/sync/api/capabilities/capabilitiesProtocol';
import { ensureAgentInstallablesBackground } from '@/capabilities/ensureAgentInstallablesBackground';
import {
    buildResumeCapabilityOptionsFromUiState,
    getAgentResumeExperimentsFromSettings,
    buildNewSessionOptionsFromUiState,
    canSelectAgentWithoutDetectedCli,
    getNewSessionAgentInputExtraActionChips,
    getNewSessionRelevantInstallableDepKeys,
} from '@/agents/catalog/catalog';
import type { SecretChoiceByProfileIdByEnvVarName } from '@/utils/secrets/secretRequirementApply';
import { getSecretSatisfaction } from '@/utils/secrets/secretSatisfaction';
import { useKeyboardHeight } from '@/hooks/ui/useKeyboardHeight';
import { computeNewSessionInputMaxHeight } from '@/components/sessions/agentInput/inputMaxHeight';
import { useProfileMap, transformProfileToEnvironmentVars } from '@/components/sessions/new/modules/profileHelpers';
import { newSessionScreenStyles } from '@/components/sessions/new/newSessionScreenStyles';
import { useSecretRequirementFlow } from '@/components/sessions/new/hooks/useSecretRequirementFlow';
import { coerceNewSessionModelMode, resolveInitialNewSessionModelMode } from '@/components/sessions/new/hooks/newSessionModelModePolicy';
import { useNewSessionCapabilitiesPrefetch } from '@/components/sessions/new/hooks/useNewSessionCapabilitiesPrefetch';
import { useNewSessionDraftAutoPersist } from '@/components/sessions/new/hooks/useNewSessionDraftAutoPersist';
import { useCreateNewSession } from '@/components/sessions/new/hooks/useCreateNewSession';
import { useNewSessionWizardProps } from '@/components/sessions/new/hooks/useNewSessionWizardProps';
import { getAutomationChipLabel } from '@/components/sessions/new/modules/automationChipModel';
import { canCreateNewSession } from '@/components/sessions/new/modules/canCreateNewSession';
import { resolveNewSessionCapabilityServerId } from '@/components/sessions/new/modules/resolveNewSessionCapabilityServerId';
import { resolveEffectiveAutomationDraft, shouldShowAutomationActionChips } from '@/components/sessions/new/modules/automationFeatureGate';
import { coerceNewSessionTranscriptStorage, supportsDirectTranscriptStorageForNewSession, type NewSessionTranscriptStorage } from '@/components/sessions/new/modules/newSessionTranscriptStorage';
import {
    isAgentSelectableForNewSession,
    resolveNextSelectableBackendEntryForNewSession,
    resolveProfileAvailabilityForNewSession,
} from '@/components/sessions/new/modules/newSessionAgentSelection';
import { listAgentInputActionChipActionIds } from '@/components/sessions/agentInput/actionChips/listAgentInputActionChipActionIds';
import { useAutomationPickerAutoOpen } from '@/components/sessions/new/modules/useAutomationPickerAutoOpen';
import { buildMachinePickerRouteParams, buildProfilePickerRouteParams, buildServerPickerRouteParams } from '@/components/sessions/new/navigation/newSessionRouteParams';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/AgentInput';
import { DEFAULT_OPTION_CHIP_CYCLE_MAX_OPTIONS, resolveChipOptionInteraction } from '@/components/sessions/agentInput/chipOptionInteraction';
import { ChipOptionPickerModal } from '@/components/sessions/agentInput/components/ChipOptionPickerModal';
import { getActiveServerSnapshot, subscribeActiveServer } from '@/sync/domains/server/serverRuntime';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { useAutomationsSupport } from '@/hooks/server/useAutomationsSupport';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useNewSessionConnectedServices } from '@/components/sessions/new/modules/useNewSessionConnectedServices';
import { useNewSessionServerTargetState } from '@/components/sessions/new/hooks/serverTarget/useNewSessionServerTargetState';
import { useNewSessionBackendTargetState } from '@/components/sessions/new/hooks/screenModel/useNewSessionBackendTargetState';
import { useNewSessionMachinePathState } from '@/components/sessions/new/hooks/screenModel/useNewSessionMachinePathState';
import { useNewSessionPreflightModelsState } from '@/components/sessions/new/hooks/screenModel/useNewSessionPreflightModelsState';
import { useNewSessionPreflightSessionModesState } from '@/components/sessions/new/hooks/screenModel/useNewSessionPreflightSessionModesState';
import {
    buildBackendTargetKey,
    getActionSpec,
    type BackendTargetRefV1,
    SessionMcpSelectionV1Schema,
    type WindowsRemoteSessionLaunchMode,
} from '@happier-dev/protocol';
import { buildActionDraftInput } from '@/sync/domains/actions/buildActionDraftInput';
import { Text } from '@/components/ui/text/Text';
import { useNewSessionMcpSelection } from '@/components/sessions/new/hooks/useNewSessionMcpSelection';
import { readAccountTranscriptStorageDefaults, resolveNewSessionDefaultTranscriptStorage } from '@/sync/domains/session/transcriptStorageDefaults';
import { resolveEffectiveWindowsRemoteSessionLaunchMode } from '@/sync/domains/session/spawn/windowsRemoteSessionLaunchMode';
import {
    WINDOWS_REMOTE_SESSION_LAUNCH_MODE_OPTIONS,
    cycleWindowsRemoteSessionLaunchMode,
} from '@/sync/domains/session/spawn/windowsRemoteSessionLaunchModeOptions';


// Configuration constants
const RECENT_PATHS_DEFAULT_VISIBLE = 5;
const styles = newSessionScreenStyles;

export type NewSessionScreenModel =
    | Readonly<{
        variant: 'simple';
        popoverBoundaryRef: React.RefObject<View>;
        simpleProps: any;
    }>
    | Readonly<{
        variant: 'wizard';
        popoverBoundaryRef: React.RefObject<View>;
        wizardProps: Readonly<{
            layout: any;
            profiles: any;
            agent: any;
            machine: any;
            footer: any;
        }>;
    }>;

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
        automationPicker: automationPickerParam,
        resumeSessionId: resumeSessionIdParam,
        secretId: secretIdParam,
        secretSessionOnlyId,
        secretRequirementResultId,
    } = useLocalSearchParams<{
        prompt?: string;
        dataId?: string;
        machineId?: string;
        path?: string;
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
        automationPicker?: string;
        resumeSessionId?: string;
        secretId?: string;
        secretSessionOnlyId?: string;
        secretRequirementResultId?: string;
    }>();

    // Try to get data from temporary store first
    const tempSessionData = React.useMemo(() => {
        if (dataId) {
            return getTempData<NewSessionData>(dataId);
        }
        return null;
    }, [dataId]);

    // Load persisted draft state (survives remounts/screen navigation)
    const persistedDraft = React.useRef(loadNewSessionDraft()).current;
    const initialWorkspaceDraft = React.useMemo(() => {
        return parseNewSessionWorkspaceDraft({
            ...persistedDraft,
            selectedWorkspaceId: tempSessionData?.workspaceId ?? persistedDraft?.selectedWorkspaceId,
            selectedWorkspaceLocationId: tempSessionData?.workspaceLocationId ?? persistedDraft?.selectedWorkspaceLocationId,
            selectedWorkspaceCheckoutId: tempSessionData?.workspaceCheckoutId ?? persistedDraft?.selectedWorkspaceCheckoutId,
            checkoutCreationDraft: tempSessionData?.checkoutCreationDraft ?? persistedDraft?.checkoutCreationDraft,
        });
    }, [
        persistedDraft?.checkoutCreationDraft,
        persistedDraft?.selectedWorkspaceCheckoutId,
        persistedDraft?.selectedWorkspaceId,
        persistedDraft?.selectedWorkspaceLocationId,
        tempSessionData?.checkoutCreationDraft,
        tempSessionData?.workspaceCheckoutId,
        tempSessionData?.workspaceId,
        tempSessionData?.workspaceLocationId,
    ]);

    const [resumeSessionId, setResumeSessionId] = React.useState(() => {
        if (typeof tempSessionData?.resumeSessionId === 'string') {
            return tempSessionData.resumeSessionId;
        }
        if (typeof persistedDraft?.resumeSessionId === 'string') {
            return persistedDraft.resumeSessionId;
        }
        return typeof resumeSessionIdParam === 'string' ? resumeSessionIdParam : '';
    });

    const [agentNewSessionOptionStateByAgentId, setAgentNewSessionOptionStateByAgentId] = React.useState<
        Record<string, Record<string, unknown>>
    >(() => {
        const raw = (persistedDraft as any)?.agentNewSessionOptionStateByAgentId;
        return raw && typeof raw === 'object' ? (raw as Record<string, Record<string, unknown>>) : {};
    });

    // Settings and state
    const recentMachinePaths = useSetting('recentMachinePaths');
    const lastUsedAgent = useSetting('lastUsedAgent');
    const newSessionDefaultPersistenceModeV1 = useSetting('newSessionDefaultPersistenceModeV1');
    const newSessionDefaultPersistenceModeByTargetKeyV1 = useSetting('newSessionDefaultPersistenceModeByTargetKeyV1');

    // A/B Test Flag - determines which wizard UI to show
    // Control A (false): Simpler AgentInput-driven layout
    // Variant B (true): Enhanced profile-first wizard with sections
    const useEnhancedSessionWizard = useSetting('useEnhancedSessionWizard');

    const previousHappyRouteRef = React.useRef<string | undefined>(undefined);
    const hasCapturedPreviousHappyRouteRef = React.useRef(false);
    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        if (typeof document === 'undefined') return;

        const root = document.documentElement;
        if (!hasCapturedPreviousHappyRouteRef.current) {
            previousHappyRouteRef.current = root.dataset.happyRoute;
            hasCapturedPreviousHappyRouteRef.current = true;
        }

        const previous = previousHappyRouteRef.current;
        if (pathname === '/new') {
            root.dataset.happyRoute = 'new';
        } else {
            if (previous === undefined) {
                delete root.dataset.happyRoute;
            } else {
                root.dataset.happyRoute = previous;
            }
        }
        return () => {
            if (pathname !== '/new') return;
            if (root.dataset.happyRoute !== 'new') return;
            if (previous === undefined) {
                delete root.dataset.happyRoute;
            } else {
                root.dataset.happyRoute = previous;
            }
        };
    }, [pathname]);

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
    const actionsSettingsV1 = useSetting('actionsSettingsV1');
    const settings = useSettings();
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
    const showSessionTypeSelector = useFeatureEnabled('session.typeSelector');
    const directSessionsFeatureEnabled = useFeatureEnabled('sessions.direct');
    const resumeCapabilityOptions = React.useMemo(() => {
        return buildResumeCapabilityOptionsFromUiState({
            settings,
            results: undefined,
        });
    }, [settings]);
    const useMachinePickerSearch = useSetting('useMachinePickerSearch');
    const usePathPickerSearch = useSetting('usePathPickerSearch');
    const [profiles, setProfiles] = useSettingMutable('profiles');
    const lastUsedProfile = useSetting('lastUsedProfile');
    const [favoriteDirectories, setFavoriteDirectories] = useSettingMutable('favoriteDirectories');
    const [favoriteMachines, setFavoriteMachines] = useSettingMutable('favoriteMachines');
    const [favoriteProfileIds, setFavoriteProfileIds] = useSettingMutable('favoriteProfiles');
    const [dismissedCLIWarnings, setDismissedCLIWarnings] = useSettingMutable('dismissedCLIWarnings');
    const terminalUseTmux = useSetting('sessionUseTmux');
    const terminalTmuxByMachineId = useSetting('sessionTmuxByMachineId');

    const enabledAgentIds = useEnabledAgentIds();
    const resolvedBackendEntries = React.useMemo(() => {
        const entries = getResolvedBackendCatalogEntries({
            enabledAgentIds,
            acpCatalogSettingsV1: settings.acpCatalogSettingsV1,
        });
        const hasConfiguredBackends = entries.some((entry) => entry.family === 'configuredAcpBackend');
        if (!hasConfiguredBackends) {
            return entries;
        }
        return entries.filter((entry) => entry.builtInAgentId !== 'customAcp');
    }, [enabledAgentIds, settings.acpCatalogSettingsV1]);

    useFocusEffect(
        React.useCallback(() => {
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

    // Wizard state
    const [selectedProfileId, setSelectedProfileId] = React.useState<string | null>(() => {
        if (!useProfiles) {
            return null;
        }
        const draftProfileId = persistedDraft?.selectedProfileId;
        if (draftProfileId && profileMap.has(draftProfileId)) {
            return draftProfileId;
        }
        if (lastUsedProfile && profileMap.has(lastUsedProfile)) {
            return lastUsedProfile;
        }
        // Default to "no profile" so default session creation remains unchanged.
        return null;
    });

    /**
     * Per-profile per-env-var secret selections for the current flow (multi-secret).
     * This allows the user to resolve secrets for multiple profiles without switching selection.
     *
     * - value === '' means “prefer machine env” for that env var (disallow default saved).
     * - value === savedSecretId means “use saved secret”
     * - null/undefined means “no explicit choice yet”
     */
    const [selectedSecretIdByProfileIdByEnvVarName, setSelectedSecretIdByProfileIdByEnvVarName] = React.useState<SecretChoiceByProfileIdByEnvVarName>(() => {
        const raw = persistedDraft?.selectedSecretIdByProfileIdByEnvVarName;
        if (!raw || typeof raw !== 'object') return {};
        const out: SecretChoiceByProfileIdByEnvVarName = {};
        for (const [profileId, byEnv] of Object.entries(raw)) {
            if (!byEnv || typeof byEnv !== 'object') continue;
            const inner: Record<string, string | null> = {};
            for (const [envVarName, v] of Object.entries(byEnv as any)) {
                if (v === null) inner[envVarName] = null;
                else if (typeof v === 'string') inner[envVarName] = v;
            }
            if (Object.keys(inner).length > 0) out[profileId] = inner;
        }
        return out;
    });
    /**
     * Session-only secrets (never persisted in plaintext), keyed by profileId then env var name.
     */
    const [sessionOnlySecretValueByProfileIdByEnvVarName, setSessionOnlySecretValueByProfileIdByEnvVarName] = React.useState<SecretChoiceByProfileIdByEnvVarName>(() => {
        const raw = persistedDraft?.sessionOnlySecretValueEncByProfileIdByEnvVarName;
        if (!raw || typeof raw !== 'object') return {};
        const out: SecretChoiceByProfileIdByEnvVarName = {};
        for (const [profileId, byEnv] of Object.entries(raw)) {
            if (!byEnv || typeof byEnv !== 'object') continue;
            const inner: Record<string, string | null> = {};
            for (const [envVarName, enc] of Object.entries(byEnv as any)) {
                const decrypted = enc ? sync.decryptSecretValue(enc as any) : null;
                if (typeof decrypted === 'string' && decrypted.trim().length > 0) {
                    inner[envVarName] = decrypted;
                }
            }
            if (Object.keys(inner).length > 0) out[profileId] = inner;
        }
        return out;
    });

    const prevProfileIdBeforeSecretPromptRef = React.useRef<string | null>(null);
    const lastSecretPromptKeyRef = React.useRef<string | null>(null);
    const suppressNextSecretAutoPromptKeyRef = React.useRef<string | null>(null);
    const isSecretRequirementModalOpenRef = React.useRef(false);

    const getSessionOnlySecretValueEncByProfileIdByEnvVarName = React.useCallback(() => {
        const out: Record<string, Record<string, any>> = {};
        for (const [profileId, byEnv] of Object.entries(sessionOnlySecretValueByProfileIdByEnvVarName)) {
            if (!byEnv || typeof byEnv !== 'object') continue;
            for (const [envVarName, value] of Object.entries(byEnv)) {
                const v = typeof value === 'string' ? value.trim() : '';
                if (!v) continue;
                const enc = sync.encryptSecretValue(v);
                if (!enc) continue;
                if (!out[profileId]) out[profileId] = {};
                out[profileId]![envVarName] = enc;
            }
        }
        return Object.keys(out).length > 0 ? out : null;
    }, [sessionOnlySecretValueByProfileIdByEnvVarName]);

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
        const raw = typeof machineIdParam === 'string' ? machineIdParam.trim() : '';
        if (raw) return raw;
        const temp = typeof tempSessionData?.machineId === 'string' ? tempSessionData.machineId.trim() : '';
        if (temp) return temp;
        const draft = typeof persistedDraft?.selectedMachineId === 'string' ? persistedDraft.selectedMachineId.trim() : '';
        if (draft) return draft;
        return null;
    }, [machineIdParam, persistedDraft?.selectedMachineId, tempSessionData?.machineId]);

    const effectivePathParam = React.useMemo(() => {
        const raw = typeof pathParam === 'string' ? pathParam.trim() : '';
        if (raw) return raw;
        const temp = typeof tempSessionData?.path === 'string' ? tempSessionData.path.trim() : '';
        if (temp) return temp;

        const draftPath = typeof persistedDraft?.selectedPath === 'string' ? persistedDraft.selectedPath.trim() : '';
        if (!draftPath) return null;

        // If this navigation explicitly targets a different machine, avoid applying the old draft path (machine-scoped).
        if (typeof machineIdParam === 'string' && machineIdParam.trim().length > 0) {
            const draftMachineId = typeof persistedDraft?.selectedMachineId === 'string' ? persistedDraft.selectedMachineId.trim() : '';
            if (draftMachineId && draftMachineId !== machineIdParam.trim()) {
                return null;
            }
        }

        return draftPath;
    }, [machineIdParam, pathParam, persistedDraft?.selectedMachineId, persistedDraft?.selectedPath, tempSessionData?.path]);

    const { backendTarget, setBackendTarget, builtInAgentId: agentType } = useNewSessionBackendTargetState({
        entries: resolvedBackendEntries,
        lastUsedAgent,
        persistedBackendTarget: (persistedDraft as any)?.backendTarget,
        tempAgentType: tempSessionData?.agentType ?? persistedDraft?.agentType,
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
    const transcriptStorageSettings = React.useMemo(() => ({
        opencodeBackendMode: (settings as Record<string, unknown>).opencodeBackendMode,
    }), [settings]);

    const [sessionType, setSessionType] = React.useState<'simple' | 'worktree'>(() => {
        const raw = tempSessionData?.sessionType ?? persistedDraft?.sessionType;
        return raw === 'worktree' ? 'worktree' : 'simple';
    });
    const [transcriptStorage, setTranscriptStorage] = React.useState<NewSessionTranscriptStorage>(() => {
        const profile = persistedDraft?.selectedProfileId
            ? (profileMap.get(persistedDraft.selectedProfileId) || getBuiltInProfile(persistedDraft.selectedProfileId))
            : null;
        const accountDefaults = readAccountTranscriptStorageDefaults({
            globalDefault: newSessionDefaultPersistenceModeV1,
            byTargetKey: newSessionDefaultPersistenceModeByTargetKeyV1,
            enabledBackendTargets: resolvedBackendEntries.map((entry) => entry.target),
        });
        const resolvedDefault = resolveNewSessionDefaultTranscriptStorage({
            agentType,
            backendTarget,
            accountDefaults,
            profileDefaultsByTargetKey: profile?.defaultPersistenceModeByTargetKey ?? null,
        });
        return coerceNewSessionTranscriptStorage({
            requested: persistedDraft?.transcriptStorage ?? resolvedDefault,
            agentId: agentType,
            settings: transcriptStorageSettings,
            directSessionsEnabled: directSessionsFeatureEnabled,
        });
    });
    const [permissionMode, setPermissionMode] = React.useState<PermissionMode>(() => {
        const accountDefaults = readAccountPermissionDefaults(sessionDefaultPermissionModeByTargetKey, enabledAgentIds);

        // If a profile is pre-selected (e.g. from draft), use its override; otherwise fall back to account defaults.
        const profile = selectedProfileId ? (profileMap.get(selectedProfileId) || getBuiltInProfile(selectedProfileId)) : null;

        const resolvedDefault = resolveNewSessionDefaultPermissionMode({
            agentType,
            backendTarget,
            accountDefaults,
            profileDefaultsByTargetKey: profile?.defaultPermissionModeByTargetKey ?? null,
            legacyProfileDefaultPermissionMode: (profile?.defaultPermissionMode as PermissionMode | undefined) ?? undefined,
        });

        const draft = persistedDraft?.permissionMode;
        if (isPermissionMode(draft)) {
            return normalizePermissionModeForAgentType(draft, agentType);
        }

        return resolvedDefault;
    });

    // NOTE: Permission mode reset on agentType change is handled by the validation useEffect below (lines ~670-681)
    // which intelligently resets only when the current mode is invalid for the new agent type.
    // A duplicate unconditional reset here was removed to prevent race conditions.

    const [modelMode, setModelMode] = React.useState<ModelMode>(() => {
        const core = getAgentCore(agentType);
        const draftMode = typeof persistedDraft?.modelMode === 'string' ? persistedDraft.modelMode : null;
        return resolveInitialNewSessionModelMode({
            draftModelMode: draftMode,
            modelConfig: { defaultMode: core.model.defaultMode, allowedModes: core.model.allowedModes, supportsFreeform: core.model.supportsFreeform },
        }) as ModelMode;
    });

    const [acpSessionModeId, setAcpSessionModeId] = React.useState<string | null>(() => {
        const raw = (persistedDraft as any)?.acpSessionModeId;
        if (raw === null) return null;
        if (typeof raw === 'string') {
            const trimmed = raw.trim();
            return trimmed.length > 0 ? trimmed : null;
        }
        return null;
    });
    const [mcpSelection, setMcpSelection] = React.useState(() => {
        return SessionMcpSelectionV1Schema.parse((persistedDraft as any)?.mcpSelection ?? {});
    });

    const supportsDirectTranscriptStorage = React.useMemo(() => {
        return supportsDirectTranscriptStorageForNewSession({
            agentId: agentType,
            settings: transcriptStorageSettings,
        });
    }, [agentType, transcriptStorageSettings]);

    const accountTranscriptStorageDefaults = React.useMemo(() => {
        return readAccountTranscriptStorageDefaults({
            globalDefault: newSessionDefaultPersistenceModeV1,
            byTargetKey: newSessionDefaultPersistenceModeByTargetKeyV1,
            enabledBackendTargets: resolvedBackendEntries.map((entry) => entry.target),
        });
    }, [newSessionDefaultPersistenceModeByTargetKeyV1, newSessionDefaultPersistenceModeV1, resolvedBackendEntries]);

    const selectedProfileForTranscriptStorage = React.useMemo(() => {
        if (!selectedProfileId) return null;
        return profileMap.get(selectedProfileId) || getBuiltInProfile(selectedProfileId) || null;
    }, [profileMap, selectedProfileId]);

    const selectedProfileTranscriptStorageDefaultsByTargetKey = selectedProfileForTranscriptStorage?.defaultPersistenceModeByTargetKey ?? null;

    const hasUserSelectedTranscriptStorageRef = React.useRef<boolean>(
        persistedDraft?.transcriptStorage === 'direct' || persistedDraft?.transcriptStorage === 'persisted',
    );

    React.useEffect(() => {
        const resolvedDefault = resolveNewSessionDefaultTranscriptStorage({
            agentType,
            backendTarget,
            accountDefaults: accountTranscriptStorageDefaults,
            profileDefaultsByTargetKey: selectedProfileTranscriptStorageDefaultsByTargetKey,
        });
        const requested = hasUserSelectedTranscriptStorageRef.current
            ? transcriptStorage
            : resolvedDefault;
        const coerced = coerceNewSessionTranscriptStorage({
            requested,
            agentId: agentType,
            settings: transcriptStorageSettings,
            directSessionsEnabled: directSessionsFeatureEnabled,
        });
        if (coerced !== transcriptStorage) {
            setTranscriptStorage(coerced);
        }
    }, [
        accountTranscriptStorageDefaults,
        agentType,
        directSessionsFeatureEnabled,
        selectedProfileTranscriptStorageDefaultsByTargetKey,
        transcriptStorageSettings,
        transcriptStorage,
    ]);

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
    const { preflightModels, modelOptions, probe: modelOptionsProbeState } = useNewSessionPreflightModelsState({
        backendTarget,
        selectedMachineId,
        capabilityServerId,
        cwd: selectedPath,
    });

    const { preflightModes: preflightSessionModes, modeOptions: acpSessionModeOptions, probe: acpSessionModeProbeState } =
        useNewSessionPreflightSessionModesState({
            backendTarget,
            selectedMachineId,
            capabilityServerId,
            cwd: selectedPath,
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

    const hasUserSelectedPermissionModeRef = React.useRef<boolean>((() => {
        const draft = persistedDraft?.permissionMode;
        if (isPermissionMode(draft) && draft !== 'default') return true;
        return false;
    })());
    const permissionModeRef = React.useRef(permissionMode);
    React.useEffect(() => {
        permissionModeRef.current = permissionMode;
    }, [permissionMode]);

    const applyPermissionMode = React.useCallback((mode: PermissionMode, source: 'user' | 'auto') => {
        setPermissionMode((prev) => (prev === mode ? prev : mode));
        if (source === 'user') {
            hasUserSelectedPermissionModeRef.current = true;
        }
    }, []);

    const handlePermissionModeChange = React.useCallback((mode: PermissionMode) => {
        applyPermissionMode(mode, 'user');
    }, [applyPermissionMode]);

    //
    // Path selection
    //

    const [sessionPrompt, setSessionPrompt] = React.useState(() => {
        return tempSessionData?.prompt || prompt || persistedDraft?.input || '';
    });
    const [automationDraft, setAutomationDraft] = React.useState<NewSessionAutomationDraft>(() => {
        return sanitizeNewSessionAutomationDraft(persistedDraft?.automationDraft);
    });
    const effectiveAutomationDraft = React.useMemo(
        () => resolveEffectiveAutomationDraft({ draft: automationDraft, automationsEnabled: automationFeatureEnabled }),
        [automationDraft, automationFeatureEnabled],
    );
    const [isCreating, setIsCreating] = React.useState(false);
    const [isResumeSupportChecking, setIsResumeSupportChecking] = React.useState(false);

    React.useEffect(() => {
        if (!automationFeatureEnabled) return;
        const requested = typeof automationParam === 'string'
            && ['1', 'true', 'yes', 'on'].includes(automationParam.trim().toLowerCase());
        if (!requested) return;
        setAutomationDraft((prev) => ({
            ...DEFAULT_NEW_SESSION_AUTOMATION_DRAFT,
            ...prev,
            enabled: true,
            everyMinutes: Math.max(1, prev.everyMinutes),
        }));
    }, [automationFeatureEnabled, automationParam]);

    React.useEffect(() => {
        if (!automationFeatureEnabled) return;

        const hasAnyAutomationParam =
            typeof automationEnabledParam === 'string'
            || typeof automationNameParam === 'string'
            || typeof automationDescriptionParam === 'string'
            || typeof automationScheduleKindParam === 'string'
            || typeof automationEveryMinutesParam === 'string'
            || typeof automationCronExprParam === 'string'
            || typeof automationTimezoneParam === 'string';

        if (!hasAnyAutomationParam) return;

        setAutomationDraft((prev) => {
            const parsed = sanitizeNewSessionAutomationDraft({
                enabled: typeof automationEnabledParam === 'string'
                    ? ['1', 'true', 'yes', 'on'].includes(automationEnabledParam.trim().toLowerCase())
                    : prev.enabled,
                name: typeof automationNameParam === 'string' ? automationNameParam : prev.name,
                description: typeof automationDescriptionParam === 'string' ? automationDescriptionParam : prev.description,
                scheduleKind: typeof automationScheduleKindParam === 'string' ? automationScheduleKindParam : prev.scheduleKind,
                everyMinutes: typeof automationEveryMinutesParam === 'string'
                    ? Number.parseInt(automationEveryMinutesParam, 10)
                    : prev.everyMinutes,
                cronExpr: typeof automationCronExprParam === 'string' ? automationCronExprParam : prev.cronExpr,
                timezone: typeof automationTimezoneParam === 'string' ? automationTimezoneParam : prev.timezone,
            });

            return { ...prev, ...parsed };
        });
    }, [
        automationCronExprParam,
        automationDescriptionParam,
        automationEnabledParam,
        automationEveryMinutesParam,
        automationFeatureEnabled,
        automationNameParam,
        automationScheduleKindParam,
        automationTimezoneParam,
    ]);

    // Handle resumeSessionId param from the resume picker screen
    React.useEffect(() => {
        if (typeof resumeSessionIdParam !== 'string') {
            return;
        }
        setResumeSessionId(resumeSessionIdParam);
    }, [resumeSessionIdParam]);

    // Path selection state - initialize with formatted selected path

    // CLI Detection - automatic, non-blocking detection of installed CLIs on selected machine
    const cliAvailability = useCLIDetection(selectedMachineId, { autoDetect: false, serverId: capabilityServerId });
    const { state: selectedMachineCapabilities } = useMachineCapabilitiesCache({
        machineId: selectedMachineId,
        serverId: capabilityServerId,
        enabled: false,
        request: CAPABILITIES_REQUEST_NEW_SESSION,
    });

    const tmuxRequested = React.useMemo(() => {
        return Boolean(resolveTerminalSpawnOptions({
            settings: storage.getState().settings,
            machineId: selectedMachineId,
        }));
    }, [selectedMachineId, terminalTmuxByMachineId, terminalUseTmux]);

    const selectedMachineCapabilitiesSnapshot = React.useMemo(() => {
        return selectedMachineCapabilities.status === 'loaded'
            ? selectedMachineCapabilities.snapshot
            : selectedMachineCapabilities.status === 'loading'
                ? selectedMachineCapabilities.snapshot
                : selectedMachineCapabilities.status === 'error'
                    ? selectedMachineCapabilities.snapshot
                    : undefined;
    }, [selectedMachineCapabilities]);

    const resumeCapabilityOptionsResolved = React.useMemo(() => {
        return buildResumeCapabilityOptionsFromUiState({
            settings,
            results: selectedMachineCapabilitiesSnapshot?.response.results as any,
        });
    }, [selectedMachineCapabilitiesSnapshot, settings]);

    const showResumePicker = React.useMemo(() => {
        return canAgentResume(agentType, resumeCapabilityOptionsResolved);
    }, [agentType, resumeCapabilityOptionsResolved]);

    const wizardInstallableDeps = React.useMemo(() => {
        if (!selectedMachineId) return [];

        const experiments = getAgentResumeExperimentsFromSettings(agentType, settings);
        const relevantKeys = getNewSessionRelevantInstallableDepKeys({
            agentId: agentType,
            experiments,
            resumeSessionId,
        });
        if (relevantKeys.length === 0) return [];

        const entries = getInstallablesRegistryEntries().filter((e) => relevantKeys.includes(e.key));
        const results = selectedMachineCapabilitiesSnapshot?.response.results;
        return entries.map((entry) => {
            const depStatus = entry.getStatus(results);
            const detectResult = entry.getDetectResult(results);
            return { entry, depStatus, detectResult };
        });
    }, [
        agentType,
        settings,
        resumeSessionId,
        selectedMachineCapabilitiesSnapshot,
        selectedMachineId,
    ]);

    const installableDepKeyCountByAgentId = React.useMemo(() => {
        const out: Partial<Record<AgentId, number>> = {};
        for (const id of enabledAgentIds) {
            const experiments = getAgentResumeExperimentsFromSettings(id, settings);
            const relevantKeys = getNewSessionRelevantInstallableDepKeys({
                agentId: id,
                experiments,
                resumeSessionId,
            });
            out[id] = relevantKeys.length;
        }
        return out;
    }, [enabledAgentIds, settings, resumeSessionId]);

    const selectableWithoutCliByAgentId = React.useMemo(() => {
        const out: Partial<Record<AgentId, boolean>> = {};
        for (const id of enabledAgentIds) {
            out[id] = canSelectAgentWithoutDetectedCli({
                agentId: id,
                settings,
                agentOptionState: agentNewSessionOptionStateByAgentId[id] ?? null,
            });
        }
        return out;
    }, [agentNewSessionOptionStateByAgentId, enabledAgentIds, settings]);

    const isAgentSelectable = React.useCallback((agentId: AgentId): boolean => {
        return isAgentSelectableForNewSession({
            agentId,
            detectionTimestamp: cliAvailability.timestamp,
            availabilityById: cliAvailability.available,
            installableDepKeyCountByAgentId,
            selectableWithoutCliByAgentId,
        });
    }, [cliAvailability.available, cliAvailability.timestamp, installableDepKeyCountByAgentId, selectableWithoutCliByAgentId]);

    const isBackendEntrySelectable = React.useCallback((entry: (typeof resolvedBackendEntries)[number]): boolean => {
        if (entry.family === 'configuredAcpBackend') {
            return true;
        }
        return isAgentSelectable(entry.builtInAgentId ?? resolveBuiltInAgentIdForBackendTarget(entry.target));
    }, [isAgentSelectable, resolvedBackendEntries]);

    React.useEffect(() => {
        if (!selectedMachineId) return;
        if (wizardInstallableDeps.length === 0) return;

        const machine = machines.find((m) => m.id === selectedMachineId);
        if (!machine || !isMachineOnline(machine)) return;

        return runAfterInteractionsWithFallback(() => {
            fireAndForget(
                ensureAgentInstallablesBackground({
                    agentId: agentType,
                    machineId: selectedMachineId,
                    serverId: capabilityServerId,
                    settings,
                    resumeSessionId,
                }),
                { tag: `NewSessionScreenModel.installables.ensure.${agentType}` },
            );
        });
    }, [agentType, capabilityServerId, machines, resumeSessionId, selectedMachineId, settings, wizardInstallableDeps.length]);

    // Auto-correct invalid agent selection after CLI detection completes
    // This handles the case where lastUsedAgent was 'codex' but codex is not installed
    React.useEffect(() => {
        // Only act when detection has completed (timestamp > 0)
        if (cliAvailability.timestamp === 0) return;

        const currentSelectable = selectedBackendEntry ? isBackendEntrySelectable(selectedBackendEntry) : false;
        if (currentSelectable) return;

        const nextEntry = resolvedBackendEntries.find((entry) => isBackendEntrySelectable(entry)) ?? null;
        if (nextEntry) {
            setBackendTarget(nextEntry.target);
            return;
        }
    }, [
        cliAvailability.timestamp,
        isBackendEntrySelectable,
        resolvedBackendEntries,
        selectedBackendEntry,
        setBackendTarget,
    ]);

    const [hiddenCliWarningKeys, setHiddenCliWarningKeys] = React.useState<Record<string, boolean>>({});

    const isCliBannerDismissed = React.useCallback((agentId: AgentId): boolean => {
        const warningKey = getAgentCore(agentId).cli.detectKey;
        if (hiddenCliWarningKeys[warningKey] === true) return true;
        return isCliWarningDismissed({ dismissed: dismissedCLIWarnings as any, machineId: selectedMachineId, warningKey });
    }, [dismissedCLIWarnings, hiddenCliWarningKeys, selectedMachineId]);

    const dismissCliBanner = React.useCallback((agentId: AgentId, scope: 'machine' | 'global' | 'temporary') => {
        const warningKey = getAgentCore(agentId).cli.detectKey;
        if (scope === 'temporary') {
            setHiddenCliWarningKeys((prev) => ({ ...prev, [warningKey]: true }));
            return;
        }
        setDismissedCLIWarnings(
            applyCliWarningDismissal({
                dismissed: dismissedCLIWarnings as any,
                machineId: selectedMachineId,
                warningKey,
                scope,
            }) as any,
        );
    }, [dismissedCLIWarnings, selectedMachineId, setDismissedCLIWarnings]);

    const getCompatibleProfileBackendEntries = React.useCallback((profile: AIBackendProfile) => {
        return resolvedBackendEntries.filter((entry) => isProfileCompatibleWithBackendTarget(profile, entry.target));
    }, [resolvedBackendEntries]);

    // Helper to check if profile is available (CLI detected + experiments gating)
    const isProfileAvailable = React.useCallback((profile: AIBackendProfile): { available: boolean; reason?: string } => {
        return resolveProfileAvailabilityForNewSession({
            candidateBackendEntries: getCompatibleProfileBackendEntries(profile),
            detectionTimestamp: cliAvailability.timestamp,
            availabilityById: cliAvailability.available,
            installableDepKeyCountByAgentId,
            selectableWithoutCliByAgentId,
        });
    }, [cliAvailability.available, cliAvailability.timestamp, getCompatibleProfileBackendEntries, installableDepKeyCountByAgentId, selectableWithoutCliByAgentId]);

    const profileAvailabilityById = React.useMemo(() => {
        const map = new Map<string, { available: boolean; reason?: string }>();
        for (const profile of allProfiles) {
            map.set(profile.id, isProfileAvailable(profile));
        }
        return map;
    }, [allProfiles, isProfileAvailable]);

    // Computed values
    const compatibleProfiles = React.useMemo(() => {
        return allProfiles.filter((profile) => isProfileCompatibleWithBackendTarget(profile, backendTarget));
    }, [allProfiles, backendTarget]);

    const selectedProfile = React.useMemo(() => {
        if (!selectedProfileId) {
            return null;
        }
        // Check custom profiles first
        if (profileMap.has(selectedProfileId)) {
            return profileMap.get(selectedProfileId)!;
        }
        // Check built-in profiles
        return getBuiltInProfile(selectedProfileId);
    }, [selectedProfileId, profileMap]);

    // NOTE: we intentionally do NOT clear per-profile secret overrides when profile changes.
    // Users may resolve secrets for multiple profiles and then switch between them before creating a session.

    const selectedMachine = React.useMemo(() => {
        if (!selectedMachineId) return null;
        return machines.find(m => m.id === selectedMachineId) ?? null;
    }, [selectedMachineId, machines]);
    const [windowsRemoteSessionLaunchModeOverride, setWindowsRemoteSessionLaunchModeOverride] =
        React.useState<WindowsRemoteSessionLaunchMode | null>(null);

    React.useEffect(() => {
        setWindowsRemoteSessionLaunchModeOverride(null);
    }, [selectedMachineId]);

    const selectedMachineIsWindows = selectedMachine?.metadata?.platform === 'win32';
    const windowsTerminalAvailable = React.useMemo(() => {
        if (!selectedMachineIsWindows) return false;
        const result = (selectedMachineCapabilitiesSnapshot?.response.results as Record<string, any> | undefined)?.['tool.windowsTerminal'];
        return result?.ok === true && result?.data?.available === true;
    }, [selectedMachineCapabilitiesSnapshot, selectedMachineIsWindows]);
    const effectiveWindowsRemoteSessionLaunchMode = React.useMemo(() => {
        return resolveEffectiveWindowsRemoteSessionLaunchMode({
            machineMetadata: selectedMachine?.metadata,
            settings,
            sessionOverride: windowsRemoteSessionLaunchModeOverride ?? undefined,
        }).mode;
    }, [selectedMachine?.metadata, settings, windowsRemoteSessionLaunchModeOverride]);
    const handleOpenMcpSettings = React.useCallback(() => {
        router.push('/(app)/settings/mcp' as any);
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

    const secretRequirements = React.useMemo(() => {
        const reqs = selectedProfile?.envVarRequirements ?? [];
        return reqs
            .filter((r) => (r?.kind ?? 'secret') === 'secret')
            .map((r) => ({ name: r.name, required: r.required === true }))
            .filter((r) => typeof r.name === 'string' && r.name.length > 0) as Array<{ name: string; required: boolean }>;
    }, [selectedProfile]);
    const shouldShowSecretSection = secretRequirements.length > 0;

    const { openSecretRequirementModal } = useSecretRequirementFlow({
        router,
        navigation,
        useProfiles,
        selectedProfileId,
        selectedProfile,
        setSelectedProfileId,
        shouldShowSecretSection,
        selectedMachineId,
        machineEnvPresence,
        secrets,
        setSecrets,
        secretBindingsByProfileId,
        setSecretBindingsByProfileId,
        selectedSecretIdByProfileIdByEnvVarName,
        setSelectedSecretIdByProfileIdByEnvVarName,
        sessionOnlySecretValueByProfileIdByEnvVarName,
        setSessionOnlySecretValueByProfileIdByEnvVarName,
        secretRequirementResultId: typeof secretRequirementResultId === 'string' ? secretRequirementResultId : undefined,
        prevProfileIdBeforeSecretPromptRef,
        lastSecretPromptKeyRef,
        suppressNextSecretAutoPromptKeyRef,
        isSecretRequirementModalOpenRef,
    });

    // Legacy convenience: treat the first required secret (or first secret) as the “primary” secret for
    // older single-secret UI paths (e.g. route params, draft persistence). Multi-secret enforcement uses
    // the full maps + `getSecretSatisfaction`.
    const primarySecretEnvVarName = React.useMemo(() => {
        const required = secretRequirements.find((r) => r.required)?.name ?? null;
        return required ?? (secretRequirements[0]?.name ?? null);
    }, [secretRequirements]);

    const selectedSecretId = React.useMemo(() => {
        if (!primarySecretEnvVarName) return null;
        if (!selectedProfileId) return null;
        const v = (selectedSecretIdByProfileIdByEnvVarName[selectedProfileId] ?? {})[primarySecretEnvVarName];
        return typeof v === 'string' ? v : null;
    }, [primarySecretEnvVarName, selectedProfileId, selectedSecretIdByProfileIdByEnvVarName]);

    const setSelectedSecretId = React.useCallback((next: string | null) => {
        if (!primarySecretEnvVarName) return;
        if (!selectedProfileId) return;
        setSelectedSecretIdByProfileIdByEnvVarName((prev) => ({
            ...prev,
            [selectedProfileId]: {
                ...(prev[selectedProfileId] ?? {}),
                [primarySecretEnvVarName]: next,
            },
        }));
    }, [primarySecretEnvVarName, selectedProfileId]);

    const sessionOnlySecretValue = React.useMemo(() => {
        if (!primarySecretEnvVarName) return null;
        if (!selectedProfileId) return null;
        const v = (sessionOnlySecretValueByProfileIdByEnvVarName[selectedProfileId] ?? {})[primarySecretEnvVarName];
        return typeof v === 'string' ? v : null;
    }, [primarySecretEnvVarName, selectedProfileId, sessionOnlySecretValueByProfileIdByEnvVarName]);

    const setSessionOnlySecretValue = React.useCallback((next: string | null) => {
        if (!primarySecretEnvVarName) return;
        if (!selectedProfileId) return;
        setSessionOnlySecretValueByProfileIdByEnvVarName((prev) => ({
            ...prev,
            [selectedProfileId]: {
                ...(prev[selectedProfileId] ?? {}),
                [primarySecretEnvVarName]: next,
            },
        }));
    }, [primarySecretEnvVarName, selectedProfileId]);

    const refreshMachineData = React.useCallback(() => {
        // Treat this as “refresh machine-related data”:
        // - machine list from server (new machines / metadata updates)
        // - CLI detection cache for selected machine (glyphs + login/availability)
        // - machine env presence preflight cache (API key env var presence)
        fireAndForget(sync.refreshMachinesThrottled({ staleMs: 0, force: true }), { tag: 'NewSessionScreenModel.refreshMachinesThrottled.manual' });
        refreshMachineEnvPresence();

        if (selectedMachineId) {
            fireAndForget(prefetchMachineCapabilities({
                machineId: selectedMachineId,
                serverId: capabilityServerId,
                request: CAPABILITIES_REQUEST_NEW_SESSION,
            }), { tag: 'NewSessionScreenModel.prefetchMachineCapabilities' });
        }
    }, [capabilityServerId, refreshMachineEnvPresence, selectedMachineId, sync]);

    const selectedSavedSecret = React.useMemo(() => {
        if (!selectedSecretId) return null;
        return secrets.find((k: SavedSecret) => k.id === selectedSecretId) ?? null;
    }, [secrets, selectedSecretId]);

    React.useEffect(() => {
        if (!selectedProfileId) return;
        if (selectedSecretId !== null) return;
        if (!primarySecretEnvVarName) return;
        const nextDefault = secretBindingsByProfileId[selectedProfileId]?.[primarySecretEnvVarName] ?? null;
        if (typeof nextDefault === 'string' && nextDefault.length > 0) {
            setSelectedSecretId(nextDefault);
        }
    }, [primarySecretEnvVarName, secretBindingsByProfileId, selectedSecretId, selectedProfileId]);

    const activeSecretSource = sessionOnlySecretValue
        ? 'sessionOnly'
        : selectedSecretId
            ? 'saved'
            : 'machineEnv';

    const openProfileEdit = React.useCallback((params: { profileId?: string; cloneFromProfileId?: string }) => {
        // Persisting can block the JS thread on iOS (MMKV). Navigation should be instant,
        // so we persist after the navigation transition.
        const draft = {
            input: sessionPrompt,
            selectedMachineId,
            selectedPath,
            ...(initialWorkspaceDraft.selectedWorkspaceId ? { selectedWorkspaceId: initialWorkspaceDraft.selectedWorkspaceId } : {}),
            ...(initialWorkspaceDraft.selectedWorkspaceLocationId ? { selectedWorkspaceLocationId: initialWorkspaceDraft.selectedWorkspaceLocationId } : {}),
            ...(initialWorkspaceDraft.selectedWorkspaceCheckoutId ? { selectedWorkspaceCheckoutId: initialWorkspaceDraft.selectedWorkspaceCheckoutId } : {}),
            ...(initialWorkspaceDraft.checkoutCreationDraft ? { checkoutCreationDraft: initialWorkspaceDraft.checkoutCreationDraft } : {}),
            selectedProfileId: useProfiles ? selectedProfileId : null,
            selectedSecretId,
            selectedSecretIdByProfileIdByEnvVarName,
            sessionOnlySecretValueEncByProfileIdByEnvVarName: getSessionOnlySecretValueEncByProfileIdByEnvVarName(),
            agentType,
            permissionMode,
            modelMode,
            acpSessionModeId,
            mcpSelection,
            sessionType,
            resumeSessionId,
            agentNewSessionOptionStateByAgentId,
            automationDraft: effectiveAutomationDraft,
            updatedAt: Date.now(),
        };

        router.push({
            pathname: '/new/pick/profile-edit',
            params: {
                ...params,
                ...(selectedMachineId ? { machineId: selectedMachineId } : {}),
            },
        } as any);

        InteractionManager.runAfterInteractions(() => {
            saveNewSessionDraft(draft);
        });
    }, [
        acpSessionModeId,
        agentType,
        agentNewSessionOptionStateByAgentId,
        getSessionOnlySecretValueEncByProfileIdByEnvVarName,
        mcpSelection,
        modelMode,
        effectiveAutomationDraft,
        initialWorkspaceDraft.checkoutCreationDraft,
        initialWorkspaceDraft.selectedWorkspaceCheckoutId,
        initialWorkspaceDraft.selectedWorkspaceId,
        initialWorkspaceDraft.selectedWorkspaceLocationId,
        permissionMode,
        resumeSessionId,
        router,
        selectedMachineId,
        selectedPath,
        selectedProfileId,
        selectedSecretId,
        selectedSecretIdByProfileIdByEnvVarName,
        sessionPrompt,
        sessionType,
        useProfiles,
    ]);

    const handleAddProfile = React.useCallback(() => {
        openProfileEdit({});
    }, [openProfileEdit]);

    const handleDuplicateProfile = React.useCallback((profile: AIBackendProfile) => {
        openProfileEdit({ cloneFromProfileId: profile.id });
    }, [openProfileEdit]);

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

    // Get recent paths for the selected machine
    // Recent machines computed from recentMachinePaths (lightweight; avoids subscribing to sessions updates)
    const recentMachines = React.useMemo(() => {
        if (machines.length === 0) return [];
        if (!recentMachinePaths || recentMachinePaths.length === 0) return [];

        const byId = new Map(machines.map((m) => [m.id, m] as const));
        const seen = new Set<string>();
        const result: typeof machines = [];
        for (const entry of recentMachinePaths) {
            if (seen.has(entry.machineId)) continue;
            const m = byId.get(entry.machineId);
            if (!m) continue;
            seen.add(entry.machineId);
            result.push(m);
        }
        return result;
    }, [machines, recentMachinePaths]);

    const favoriteMachineItems = React.useMemo(() => {
        return machines.filter(m => favoriteMachines.includes(m.id));
    }, [machines, favoriteMachines]);

    // Background refresh on open: pick up newly-installed CLIs without fetching on taps.
    // Keep this fairly conservative to avoid impacting iOS responsiveness.
    const CLI_DETECT_REVALIDATE_STALE_MS = 2 * 60 * 1000; // 2 minutes
    useNewSessionCapabilitiesPrefetch({
        enabled: useEnhancedSessionWizard,
        serverId: capabilityServerId,
        machines,
        favoriteMachineItems,
        recentMachines,
        selectedMachineId,
        isMachineOnline,
        staleMs: CLI_DETECT_REVALIDATE_STALE_MS,
        request: CAPABILITIES_REQUEST_NEW_SESSION,
        prefetchMachineCapabilitiesIfStale,
    });

    const recentPaths = React.useMemo(() => {
        if (!selectedMachineId) return [];
        return getRecentPathsForMachine({
            machineId: selectedMachineId,
            recentMachinePaths,
            sessions: null,
        });
    }, [recentMachinePaths, selectedMachineId]);

    // Validation
    const canCreate = React.useMemo(() => {
        return canCreateNewSession({
            selectedMachineId,
            selectedMachine,
            selectedPath,
        });
    }, [selectedMachine, selectedMachineId, selectedPath]);

    // On iOS, keep tap handlers extremely light so selection state can commit instantly.
    // We defer any follow-up adjustments (agent/session-type/permission defaults) until after interactions.
    const pendingProfileSelectionRef = React.useRef<{ profileId: string; prevProfileId: string | null } | null>(null);

    const selectProfile = React.useCallback((profileId: string) => {
        const prevSelectedProfileId = selectedProfileId;
        prevProfileIdBeforeSecretPromptRef.current = prevSelectedProfileId;
        // Ensure selecting a profile can re-prompt if needed.
        lastSecretPromptKeyRef.current = null;
        pendingProfileSelectionRef.current = { profileId, prevProfileId: prevSelectedProfileId };
        setSelectedProfileId(profileId);
    }, [selectedProfileId]);

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

            if (profile.defaultSessionType) {
                setSessionType(profile.defaultSessionType);
            }

            if (!hasUserSelectedPermissionModeRef.current) {
                const accountDefaults = readAccountPermissionDefaults(sessionDefaultPermissionModeByTargetKey, enabledAgentIds);
                const nextMode = resolveNewSessionDefaultPermissionMode({
                    agentType,
                    backendTarget,
                    accountDefaults,
                    profileDefaultsByTargetKey: profile.defaultPermissionModeByTargetKey ?? null,
                    legacyProfileDefaultPermissionMode: (profile.defaultPermissionMode as PermissionMode | undefined) ?? undefined,
                });
                applyPermissionMode(nextMode, 'auto');
            }
        });
    }, [
        agentType,
        applyPermissionMode,
        cliAvailability.available,
        cliAvailability.timestamp,
        enabledAgentIds,
        installableDepKeyCountByAgentId,
        selectableWithoutCliByAgentId,
        getCompatibleProfileBackendEntries,
        profileMap,
        selectedProfileId,
        selectedBackendTargetKey,
        sessionDefaultPermissionModeByTargetKey,
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

    const onPressDefaultEnvironment = React.useCallback(() => {
        setSelectedProfileId(null);
    }, []);

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
    }, [navigation, profileIdParam, selectedProfileId, selectProfile, useProfiles]);

    // Handle secret route param from picker screens
    React.useEffect(() => {
        const { nextSelectedSecretId, shouldClearParam } = consumeSecretIdParam({
            secretIdParam,
            selectedSecretId,
        });

        if (nextSelectedSecretId === null) {
            if (selectedSecretId !== null) {
                setSelectedSecretId(null);
            }
        } else if (typeof nextSelectedSecretId === 'string') {
            setSelectedSecretId(nextSelectedSecretId);
        }

        if (shouldClearParam) {
            const setParams = (navigation as any)?.setParams;
            if (typeof setParams === 'function') {
                setParams({ secretId: undefined });
            } else {
                navigation.dispatch({
                    type: 'SET_PARAMS',
                    payload: { params: { secretId: undefined } },
                } as never);
            }
        }
    }, [navigation, secretIdParam, selectedSecretId]);

    // Handle session-only secret temp id from picker screens (value is stored in-memory only).
    React.useEffect(() => {
        if (typeof secretSessionOnlyId !== 'string' || secretSessionOnlyId.length === 0) {
            return;
        }

        const entry = getTempData<{ secret?: string }>(secretSessionOnlyId);
        const value = entry?.secret;
        if (typeof value === 'string' && value.length > 0) {
            setSessionOnlySecretValue(value);
            setSelectedSecretId(null);
        }

        const setParams = (navigation as any)?.setParams;
        if (typeof setParams === 'function') {
            setParams({ secretSessionOnlyId: undefined });
        } else {
            navigation.dispatch({
                type: 'SET_PARAMS',
                payload: { params: { secretSessionOnlyId: undefined } },
            } as never);
        }
    }, [navigation, secretSessionOnlyId]);

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
            const accountDefaults = readAccountPermissionDefaults(sessionDefaultPermissionModeByTargetKey, enabledAgentIds);
            const nextMode = resolveNewSessionDefaultPermissionMode({
                agentType,
                backendTarget,
                accountDefaults,
                profileDefaultsByTargetKey: profile?.defaultPermissionModeByTargetKey ?? null,
                legacyProfileDefaultPermissionMode: (profile?.defaultPermissionMode as PermissionMode | undefined) ?? undefined,
            });
            applyPermissionMode(nextMode, 'auto');
            return;
        }

        const current = permissionModeRef.current;
        const mapped = normalizePermissionModeForAgentType(current, agentType);
        applyPermissionMode(mapped, 'auto');
    }, [
        agentType,
        applyPermissionMode,
        profileMap,
        selectedProfileId,
        sessionDefaultPermissionModeByTargetKey,
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

    const openProfileEnvVarsPreview = React.useCallback((profile: AIBackendProfile) => {
        Modal.show({
            component: EnvironmentVariablesPreviewModal,
            props: {
                environmentVariables: getProfileEnvironmentVariables(profile),
                machineId: selectedMachineId,
                serverId: capabilityServerId,
                machineName: selectedMachine?.metadata?.displayName || selectedMachine?.metadata?.host,
                profileName: profile.name,
            },
        });
    }, [capabilityServerId, selectedMachine, selectedMachineId]);

    const handleProfileClick = React.useCallback(() => {
        router.push({
            pathname: '/new/pick/profile',
            params: buildProfilePickerRouteParams({
                selectedProfileId,
                selectedMachineId,
                targetServerId,
            }),
        });
    }, [router, selectedMachineId, selectedProfileId, targetServerId]);

    const handleAgentClick = React.useCallback(() => {
        const profile = useProfiles && selectedProfileId !== null
            ? (profileMap.get(selectedProfileId) || getBuiltInProfile(selectedProfileId))
            : null;
        const candidateBackendEntries = profile
            ? getCompatibleProfileBackendEntries(profile)
            : resolvedBackendEntries;

        if (profile && candidateBackendEntries.length <= 1) {
            Modal.alert(
                t('profiles.aiBackend.title'),
                t('newSession.aiBackendSelectedByProfile'),
                [
                    { text: t('common.ok'), style: 'cancel' },
                    { text: t('newSession.changeProfile'), onPress: handleProfileClick },
                ],
            );
            return;
        }

        const selectableBackendEntries = candidateBackendEntries.filter((entry) => isBackendEntrySelectable(entry));
        const interaction = resolveChipOptionInteraction({
            currentOptionId: selectedBackendEntry?.targetKey ?? selectedBackendTargetKey,
            selectableOptionIds: selectableBackendEntries.map((entry) => entry.targetKey),
            cycleMaxOptions: DEFAULT_OPTION_CHIP_CYCLE_MAX_OPTIONS,
        });
        if (interaction.kind === 'cycle') {
            const nextEntry = selectableBackendEntries.find((entry) => entry.targetKey === interaction.nextOptionId) ?? null;
            if (nextEntry) {
                setBackendTarget(nextEntry.target);
            }
            return;
        }
        if (interaction.kind === 'picker') {
            Modal.show({
                component: ChipOptionPickerModal,
                props: {
                    title: t('newSession.selectAiBackendTitle'),
                    options: interaction.selectableOptionIds.map((id) => {
                        const entry = selectableBackendEntries.find((candidate) => candidate.targetKey === id);
                        return {
                            id,
                            label: entry?.title ?? id,
                        };
                    }),
                    selectedOptionId: selectedBackendEntry?.targetKey ?? selectedBackendTargetKey,
                    onSelect: (selectedId) => {
                        const nextEntry = selectableBackendEntries.find((entry) => entry.targetKey === selectedId) ?? null;
                        if (nextEntry) {
                            setBackendTarget(nextEntry.target);
                        }
                    },
                },
            });
            return;
        }

        if (profile && selectedProfileId !== null) {
            Modal.alert(
                t('profiles.aiBackend.title'),
                t('newSession.aiBackendSelectedByProfile'),
                [
                    { text: t('common.ok'), style: 'cancel' },
                    { text: t('newSession.changeProfile'), onPress: handleProfileClick },
                ],
            );
            return;
        }

        Modal.alert(
            t('profiles.aiBackend.title'),
            t('newSession.aiBackendCliNotDetectedOnMachine', { cli: t(getAgentCore(agentType).displayNameKey) }),
            [{ text: t('common.ok'), style: 'cancel' }],
        );
    }, [
        cliAvailability.available,
        cliAvailability.timestamp,
        getCompatibleProfileBackendEntries,
        handleProfileClick,
        installableDepKeyCountByAgentId,
        isBackendEntrySelectable,
        profileMap,
        resolvedBackendEntries,
        selectedProfileId,
        selectedBackendEntry,
        selectedBackendTargetKey,
        setBackendTarget,
        useProfiles,
    ]);

    const handlePathClick = React.useCallback(() => {
        if (selectedMachineId) {
            router.push({
                pathname: '/new/pick/path',
                params: {
                    machineId: selectedMachineId,
                    selectedPath,
                },
            });
        }
    }, [selectedMachineId, selectedPath, router]);

    const handleResumeClick = React.useCallback(() => {
        router.push({
            pathname: '/new/pick/resume' as any,
            params: {
                currentResumeId: resumeSessionId,
                agentType,
            },
        });
    }, [router, resumeSessionId, agentType]);

    const selectedProfileForEnvVars = React.useMemo(() => {
        if (!useProfiles || !selectedProfileId) return null;
        return profileMap.get(selectedProfileId) || getBuiltInProfile(selectedProfileId) || null;
    }, [profileMap, selectedProfileId, useProfiles]);

    const selectedProfileEnvVars = React.useMemo(() => {
        if (!selectedProfileForEnvVars) return {};
        return transformProfileToEnvironmentVars(selectedProfileForEnvVars) ?? {};
    }, [selectedProfileForEnvVars]);

    const selectedProfileEnvVarsCount = React.useMemo(() => {
        return Object.keys(selectedProfileEnvVars).length;
    }, [selectedProfileEnvVars]);

    const handleEnvVarsClick = React.useCallback(() => {
        if (!selectedProfileForEnvVars) return;
        Modal.show({
            component: EnvironmentVariablesPreviewModal,
            props: {
                environmentVariables: selectedProfileEnvVars,
                machineId: selectedMachineId,
                machineName: selectedMachine?.metadata?.displayName || selectedMachine?.metadata?.host,
                profileName: selectedProfileForEnvVars.name,
            },
        });
    }, [selectedMachine, selectedMachineId, selectedProfileEnvVars, selectedProfileForEnvVars]);

    const handleMachineClick = React.useCallback(() => {
        router.push({
            pathname: '/new/pick/machine',
            params: buildMachinePickerRouteParams({
                selectedMachineId,
                targetServerId,
            }),
        });
    }, [router, selectedMachineId, targetServerId]);

    const handleServerClick = React.useCallback(() => {
        router.push({
            pathname: '/new/pick/server',
            params: buildServerPickerRouteParams({
                targetServerId,
            }),
        });
    }, [router, targetServerId]);

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

    const { handleCreateSession } = useCreateNewSession({
        router,
        selectedMachineId,
        selectedPath,
        selectedMachine,
        setIsCreating,
        setIsResumeSupportChecking,
        sessionType,
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
        sessionPrompt,
        automationDraft: effectiveAutomationDraft,
        resumeSessionId,
        agentNewSessionOptions,
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
    });

    const handleCloseModal = React.useCallback(() => {
        // On web (especially mobile), `router.back()` can be a no-op if the modal is the first history entry.
        // Fall back to home so the user always has an exit.
        if (Platform.OS === 'web') {
            if (typeof window !== 'undefined' && window.history.length > 1) {
                router.back();
            } else {
                router.replace('/');
            }
            return;
        }

        router.back();
    }, [router]);

    // Machine online status for AgentInput (DRY - reused in info box too)
    const connectionStatus = React.useMemo(() => {
        if (!selectedMachine) return undefined;
        const isOnline = isMachineOnline(selectedMachine);

        return {
            text: isOnline ? t('status.online') : t('newSession.machineOfflineCannotStartStatus'),
            color: isOnline ? theme.colors.success : theme.colors.textDestructive,
            dotColor: isOnline ? theme.colors.success : theme.colors.textDestructive,
            isPulsing: isOnline,
        };
    }, [selectedMachine, theme]);

    const serverPickerActionChip = React.useMemo<AgentInputExtraActionChip | null>(() => {
        if (!showServerPickerChip) return null;
        return {
            key: 'new-session-target-server',
            render: ({ chipStyle, iconColor, showLabel, textStyle }) => (
                <Pressable
                    onPress={handleServerClick}
                    hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                    style={(p) => chipStyle(p.pressed)}
                >
                    {normalizeNodeForView(<Ionicons name="server-outline" size={16} color={iconColor} />)}
                    {showLabel ? (
                        <Text numberOfLines={1} style={textStyle}>
                            {targetServerName}
                        </Text>
                    ) : null}
                </Pressable>
            ),
        };
    }, [handleServerClick, showServerPickerChip, targetServerName]);

    const handleAutomationOpen = React.useCallback(() => {
        if (!automationFeatureEnabled) return;
        router.push({
            pathname: '/new/pick/automation',
            params: {
                automationEnabled: automationDraft.enabled ? '1' : '0',
                automationName: automationDraft.name,
                automationDescription: automationDraft.description,
                automationScheduleKind: automationDraft.scheduleKind,
                automationEveryMinutes: String(automationDraft.everyMinutes),
                automationCronExpr: automationDraft.cronExpr,
                automationTimezone: automationDraft.timezone ?? '',
            },
        } as any);
    }, [
        automationDraft.cronExpr,
        automationDraft.description,
        automationDraft.enabled,
        automationDraft.everyMinutes,
        automationDraft.name,
        automationDraft.scheduleKind,
        automationDraft.timezone,
        automationFeatureEnabled,
        router,
    ]);

    const requestedAutomationForScreen = React.useMemo(() => {
        if (typeof automationParam !== 'string') return false;
        const normalized = automationParam.trim().toLowerCase();
        return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
    }, [automationParam]);

    useAutomationPickerAutoOpen({
        automationsEnabled: automationFeatureEnabled,
        openPickerParam: automationPickerParam,
        readyToOpen: !requestedAutomationForScreen || automationDraft.enabled,
        onOpenPicker: handleAutomationOpen,
        clearOpenPickerParam: () => {
            router.setParams({ automationPicker: undefined });
        },
    });

    const automationActionChip = React.useMemo<AgentInputExtraActionChip>(() => {
        const label = getAutomationChipLabel(automationDraft);

        return {
            key: 'new-session-automate',
            render: ({ chipStyle, iconColor, showLabel, textStyle }) => (
                <Pressable
                    onPress={handleAutomationOpen}
                    hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                    style={(p) => chipStyle(p.pressed)}
                >
                    {normalizeNodeForView(<Ionicons name="timer-outline" size={16} color={iconColor} />)}
                    {showLabel ? (
                        <Text numberOfLines={1} style={textStyle}>
                            {label}
                        </Text>
                    ) : null}
                </Pressable>
            ),
        };
    }, [automationDraft, handleAutomationOpen]);

    const storageActionChip = React.useMemo<AgentInputExtraActionChip | null>(() => {
        if (!directSessionsFeatureEnabled || !supportsDirectTranscriptStorage) return null;

        return {
            key: 'new-session-storage',
            render: ({ chipStyle, iconColor, showLabel, textStyle }) => (
                <Pressable
                    onPress={() => {
                        hasUserSelectedTranscriptStorageRef.current = true;
                        setTranscriptStorage((current) => current === 'direct' ? 'persisted' : 'direct');
                    }}
                    hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                    style={(p) => chipStyle(p.pressed)}
                >
                    {normalizeNodeForView(
                        <Ionicons
                            name={transcriptStorage === 'direct' ? 'radio-outline' : 'save-outline'}
                            size={16}
                            color={iconColor}
                        />,
                    )}
                    {showLabel ? (
                        <Text numberOfLines={1} style={textStyle}>
                            {transcriptStorage === 'direct'
                                ? t('sessionsList.storageDirectTab')
                                : t('sessionsList.storagePersistedTab')}
                        </Text>
                    ) : null}
                </Pressable>
            ),
        };
    }, [directSessionsFeatureEnabled, supportsDirectTranscriptStorage, transcriptStorage]);

    const agentInputExtraActionChips = React.useMemo(() => {
        const baseChips = getNewSessionAgentInputExtraActionChips({
            agentId: agentType,
            agentOptionState,
            setAgentOptionState: setAgentOptionStateForCurrentAgent,
        }) ?? [];
        const chips: AgentInputExtraActionChip[] = [];
        if (connectedServicesAuthChip) {
            chips.push(connectedServicesAuthChip);
        }
        if (shouldShowAutomationActionChips({ automationsEnabled: automationFeatureEnabled })) {
            chips.push(automationActionChip);
        }
        if (serverPickerActionChip) chips.push(serverPickerActionChip);
        if (mcpChip) chips.push(mcpChip);
        if (storageActionChip) chips.push(storageActionChip);
        if (selectedMachineIsWindows && effectiveWindowsRemoteSessionLaunchMode) {
            const option = WINDOWS_REMOTE_SESSION_LAUNCH_MODE_OPTIONS.find((entry) => entry.value === effectiveWindowsRemoteSessionLaunchMode);
            chips.push({
                key: 'new-session-windows-remote-session-launch-mode',
                render: ({ chipStyle, iconColor, showLabel, textStyle }) => (
                    <Pressable
                        onPress={() => {
                            setWindowsRemoteSessionLaunchModeOverride((current) => {
                                const base = current ?? effectiveWindowsRemoteSessionLaunchMode;
                                return cycleWindowsRemoteSessionLaunchMode({
                                    current: base,
                                    windowsTerminalAvailable,
                                });
                            });
                        }}
                        hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                        style={(p) => chipStyle(p.pressed)}
                    >
                        {normalizeNodeForView(<Ionicons name="logo-windows" size={16} color={iconColor} />)}
                        {showLabel ? (
                            <Text numberOfLines={1} style={textStyle}>
                                {t(option?.shortLabelKey ?? 'windowsRemoteSessionLaunchMode.shortHidden')}
                            </Text>
                        ) : null}
                    </Pressable>
                ),
            });
        }

        const stateSnapshot = storage.getState() as any;
        const shortcutActionIds = listAgentInputActionChipActionIds(stateSnapshot);
        for (const actionId of shortcutActionIds) {
            const spec = getActionSpec(actionId as any);
            chips.push({
                key: `new-session-action:${actionId}`,
                render: ({ chipStyle, iconColor, showLabel, textStyle }) => (
                    <Pressable
                        onPress={() => {
                            const instructions = String(sessionPrompt ?? '');
                            handleCreateSession({
                                initialMessage: 'skip',
                                afterCreated: async (sessionId) => {
                                    const input = buildActionDraftInput({
                                        actionId: actionId as any,
                                        sessionId,
                                        defaultBackendTarget: backendTarget,
                                        defaultBackendId: agentType,
                                        instructions,
                                    });
                                    storage.getState().createSessionActionDraft(sessionId, {
                                        actionId,
                                        input,
                                    });
                                },
                            });
                        }}
                        hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                        style={(p) => chipStyle(p.pressed)}
                    >
                        {normalizeNodeForView(<Ionicons name="flash-outline" size={16} color={iconColor} />)}
                        {showLabel ? (
                            <Text numberOfLines={1} style={textStyle}>
                                {spec.title}
                            </Text>
                        ) : null}
                    </Pressable>
                ),
            });
        }
        return [...chips, ...baseChips];
    }, [
        agentOptionState,
        agentType,
        actionsSettingsV1,
        automationFeatureEnabled,
        automationActionChip,
        connectedServicesAuthChip,
        effectiveWindowsRemoteSessionLaunchMode,
        handleCreateSession,
        mcpChip,
        sessionPrompt,
        serverPickerActionChip,
        selectedMachineIsWindows,
        storageActionChip,
        setAgentOptionStateForCurrentAgent,
        setWindowsRemoteSessionLaunchModeOverride,
        windowsTerminalAvailable,
    ]);

    const persistDraftNow = React.useCallback(() => {
        saveNewSessionDraft({
            input: sessionPrompt,
            selectedMachineId,
            selectedPath,
            ...(initialWorkspaceDraft.selectedWorkspaceId ? { selectedWorkspaceId: initialWorkspaceDraft.selectedWorkspaceId } : {}),
            ...(initialWorkspaceDraft.selectedWorkspaceLocationId ? { selectedWorkspaceLocationId: initialWorkspaceDraft.selectedWorkspaceLocationId } : {}),
            ...(initialWorkspaceDraft.selectedWorkspaceCheckoutId ? { selectedWorkspaceCheckoutId: initialWorkspaceDraft.selectedWorkspaceCheckoutId } : {}),
            ...(initialWorkspaceDraft.checkoutCreationDraft ? { checkoutCreationDraft: initialWorkspaceDraft.checkoutCreationDraft } : {}),
            selectedProfileId: useProfiles ? selectedProfileId : null,
            selectedSecretId,
            selectedSecretIdByProfileIdByEnvVarName,
            sessionOnlySecretValueEncByProfileIdByEnvVarName: getSessionOnlySecretValueEncByProfileIdByEnvVarName(),
            agentType,
            backendTarget,
            transcriptStorage,
            permissionMode,
            modelMode,
            acpSessionModeId,
            sessionType,
            resumeSessionId,
            agentNewSessionOptionStateByAgentId,
            mcpSelection,
            automationDraft: effectiveAutomationDraft,
            updatedAt: Date.now(),
        });
    }, [
        agentType,
        acpSessionModeId,
        agentNewSessionOptionStateByAgentId,
        backendTarget,
        getSessionOnlySecretValueEncByProfileIdByEnvVarName,
        initialWorkspaceDraft.checkoutCreationDraft,
        initialWorkspaceDraft.selectedWorkspaceCheckoutId,
        initialWorkspaceDraft.selectedWorkspaceId,
        initialWorkspaceDraft.selectedWorkspaceLocationId,
        modelMode,
        mcpSelection,
        permissionMode,
        resumeSessionId,
        effectiveAutomationDraft,
        selectedSecretId,
        selectedSecretIdByProfileIdByEnvVarName,
        selectedMachineId,
        selectedPath,
        selectedProfileId,
        sessionPrompt,
        sessionType,
        transcriptStorage,
        useProfiles,
    ]);

    // Persist the current wizard state so it survives remounts and screen navigation
    // Uses debouncing to avoid excessive writes
    useNewSessionDraftAutoPersist({ persistDraftNow });

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
        openProfileEnvVarsPreview,
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
        modelOptions,
        modelOptionsProbe: {
            phase: modelOptionsProbeState.phase,
            onRefresh: modelOptionsProbeState.refresh,
        },
        acpSessionModeOptions,
        acpSessionModeProbe: {
            phase: acpSessionModeProbeState.phase,
            onRefresh: acpSessionModeProbeState.refresh,
        },
        acpSessionModeId,
        setAcpSessionModeId,
        modelMode,
        setModelMode,
        selectedIndicatorColor,
        profileMap,
        permissionMode,
        handlePermissionModeChange,
        sessionType,
        setSessionType,

        machines,
        selectedMachine: selectedMachine ?? null,
        recentMachines,
        favoriteMachineItems,
        useMachinePickerSearch,
        refreshMachineData,
        setSelectedMachineId,
        getBestPathForMachine,
        setSelectedPath,
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
        emptyAutocompletePrefixes,
        emptyAutocompleteSuggestions,
        connectionStatus,
        selectedProfileEnvVarsCount,
        handleEnvVarsClick,
        resumeSessionId,
        showResumePicker,
        handleResumeClick,
        isResumeSupportChecking,
        sessionPromptInputMaxHeight,
        agentInputExtraActionChips,
    });

    // ========================================================================
    // CONTROL A: Simpler AgentInput-driven layout (flag OFF)
    // Shows machine/path selection via chips that navigate to picker screens
    // ========================================================================
    if (!useEnhancedSessionWizard) {
	        return {
	            variant: 'simple',
	            popoverBoundaryRef,
	            simpleProps: {
	                popoverBoundaryRef,
	                headerHeight,
	                safeAreaTop: safeArea.top,
	                safeAreaBottom: safeArea.bottom,
	                newSessionTopPadding: simpleNewSessionTopPadding,
	                newSessionSidePadding: simpleNewSessionSidePadding,
	                newSessionBottomPadding: simpleNewSessionBottomPadding,
	                containerStyle: styles.container as any,
	                showSessionTypeSelector,
	                sessionType,
                setSessionType,
                sessionPrompt,
                setSessionPrompt,
                handleCreateSession,
                canCreate,
                isCreating,
                emptyAutocompletePrefixes,
                emptyAutocompleteSuggestions,
                sessionPromptInputMaxHeight,
                agentType,
                agentLabel,
                handleAgentClick,
                permissionMode,
                handlePermissionModeChange,
                modelOptions,
                modelOptionsProbe: {
                    phase: modelOptionsProbeState.phase,
                    onRefresh: modelOptionsProbeState.refresh,
                },
                acpSessionModeOptions,
                acpSessionModeProbe: {
                    phase: acpSessionModeProbeState.phase,
                    onRefresh: acpSessionModeProbeState.refresh,
                },
                acpSessionModeId,
                setAcpSessionModeId,
                modelMode,
                setModelMode,
                connectionStatus,
                machineName: selectedMachine?.metadata?.displayName || selectedMachine?.metadata?.host,
                handleMachineClick,
                selectedPath,
                handlePathClick,
                showResumePicker,
                resumeSessionId,
                handleResumeClick,
                isResumeSupportChecking,
                agentInputExtraActionChips,
                useProfiles,
                selectedProfileId,
                handleProfileClick,
                selectedProfileEnvVarsCount,
                handleEnvVarsClick,
            },
        };
    }

    // ========================================================================
    // VARIANT B: Enhanced profile-first wizard (flag ON)
    // Full wizard with numbered sections, profile management, CLI detection
    // ========================================================================

    return {
        variant: 'wizard',
        popoverBoundaryRef,
        wizardProps: {
            layout: wizardLayoutProps,
            profiles: wizardProfilesProps,
            agent: wizardAgentProps,
            machine: wizardMachineProps,
            footer: wizardFooterProps,
        },
    };
}
