import React from 'react';
import { View, ViewStyle, Linking, Platform, Pressable } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { type AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import { normalizeProfileDefaultPermissionMode, type PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { getPermissionModeOptionsForAgentType, normalizePermissionModeForAgentType } from '@/sync/domains/permissions/permissionModeOptions';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { Switch } from '@/components/ui/forms/Switch';
import { getBuiltInProfileDocumentation } from '@/sync/domains/profiles/profileUtils';
import { EnvironmentVariablesList } from '@/components/profiles/environmentVariables/EnvironmentVariablesList';
import { useSetting, useSettings, useAllMachines, useMachine, useSettingMutable } from '@/sync/domains/state/storage';
import { Modal } from '@/modal';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { useCLIDetection } from '@/hooks/auth/useCLIDetection';
import { getActiveServerId } from '@/sync/domains/server/serverProfiles';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useEnabledAgentIds } from '@/agents/hooks/useEnabledAgentIds';
import { getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import { getResolvedBackendCatalogEntries, type ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { buildBackendTargetRouteParams } from '@/agents/backendCatalog/backendTargetRouteParams';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { supportsDirectTranscriptStorageForNewSession } from '@/components/sessions/new/modules/newSessionTranscriptStorage';
import { readAccountTranscriptStorageDefaults, type SessionTranscriptStorageMode } from '@/sync/domains/session/transcriptStorageDefaults';
import { MachinePreviewModal } from '../MachinePreviewModal';
import { resolveMachineLoginRequirementForProfileTargets } from '../resolveMachineLoginRequirementForProfileTargets';
import {
    isProfileCompatibleWithResolvedBackendEntry,
    readProfileTargetKeyValueForEntry,
    resolveProfileBackendTargetKeyForEntry,
} from '../profileBackendEntryStorage';
import { Text, TextInput } from '@/components/ui/text/Text';
import { LegacyProfileDefaultsSections } from './LegacyProfileDefaultsSections';
import { LegacyProfileBackendCompatibilitySection } from './LegacyProfileBackendCompatibilitySection';
import { buildLegacyProfileSave } from './buildLegacyProfileSave';
import { useLegacyProfileSecretRequirements } from './useLegacyProfileSecretRequirements';
import { Icon } from '@/components/ui/icons/Icon';

export interface LegacyProfileEditFormProps {
    profile: AIBackendProfile;
    machineId: string | null;
    /**
     * Return true when the profile was successfully saved.
     * Return false when saving failed (e.g. validation error).
     */
    onSave: (profile: AIBackendProfile, secretBindings: Readonly<Record<string, string>>) => boolean;
    onCancel: () => void;
    onDirtyChange?: (isDirty: boolean) => void;
    containerStyle?: ViewStyle;
    saveRef?: React.MutableRefObject<(() => boolean) | null>;
}

export function LegacyProfileEditForm({
    profile,
    machineId,
    onSave,
    onCancel,
    onDirtyChange,
    containerStyle,
    saveRef,
}: LegacyProfileEditFormProps) {
    const { theme, rt } = useUnistyles();
    const router = useRouter();
    const routeParams = useLocalSearchParams<{
        agentType?: string | string[];
        backendTarget?: string | string[];
        backendTargetKey?: string | string[];
        previewMachineId?: string | string[];
    }>();
    const previewMachineIdParam = Array.isArray(routeParams.previewMachineId) ? routeParams.previewMachineId[0] : routeParams.previewMachineId;
    const previewMachineRouteParams = React.useMemo(() => {
        const agentType = Array.isArray(routeParams.agentType) ? routeParams.agentType[0] : routeParams.agentType;
        const backendTarget = Array.isArray(routeParams.backendTarget) ? routeParams.backendTarget[0] : routeParams.backendTarget;
        const backendTargetKey = Array.isArray(routeParams.backendTargetKey) ? routeParams.backendTargetKey[0] : routeParams.backendTargetKey;
        return buildBackendTargetRouteParams({
            agentType,
            backendTarget,
            backendTargetKey,
            fallbackTarget: null,
        });
    }, [routeParams.agentType, routeParams.backendTarget, routeParams.backendTargetKey]);
    const selectedIndicatorColor = rt.themeName === 'dark' ? theme.colors.text.primary : theme.colors.button.primary.background;
    const styles = stylesheet;
    const popoverBoundaryRef = React.useRef<any>(null);
    const enabledAgentIds = useEnabledAgentIds();
    const machines = useAllMachines();
    const settings = useSettings();
    const externalSessionsEnabled = useFeatureEnabled('sessions.direct');
    const [favoriteMachines, setFavoriteMachines] = useSettingMutable('favoriteMachines');
    const routeMachine = machineId;
    const [previewMachineId, setPreviewMachineId] = React.useState<string | null>(routeMachine);

    React.useEffect(() => {
        setPreviewMachineId(routeMachine);
    }, [routeMachine]);

    React.useEffect(() => {
        if (routeMachine) return;
        if (typeof previewMachineIdParam !== 'string') return;
        const trimmed = previewMachineIdParam.trim();
        if (trimmed.length === 0) {
            setPreviewMachineId(null);
            return;
        }
        setPreviewMachineId(trimmed);
    }, [previewMachineIdParam, routeMachine]);

    const resolvedMachineId = routeMachine ?? previewMachineId;
    const resolvedMachine = useMachine(resolvedMachineId ?? '');
    const activeServerId = getActiveServerId();
    const daemonMergedProjection = useDaemonMergedProjectionInputs({
        machineId: resolvedMachineId,
        serverId: activeServerId,
        enabled: Boolean(resolvedMachineId),
        staleMs: 60_000,
    });
    const backendEnabledByTargetKey = settings.backendEnabledByTargetKey;
    const resolvedBackendEntries = React.useMemo(() => {
        return getResolvedBackendCatalogEntries({
            enabledAgentIds,
            acpCatalogSettingsV1: settings.acpCatalogSettingsV1,
            backendEnabledByTargetKey,
            discoveredBackendIds: daemonMergedProjection.inputs?.discoveredBackendIds ?? undefined,
            mergedProviderProjectionById: daemonMergedProjection.inputs?.mergedProviderProjectionById ?? null,
            mergedBackendProjectionById: daemonMergedProjection.inputs?.mergedBackendProjectionById ?? null,
        });
    }, [
        backendEnabledByTargetKey,
        daemonMergedProjection.inputs?.discoveredBackendIds,
        daemonMergedProjection.inputs?.mergedBackendProjectionById,
        daemonMergedProjection.inputs?.mergedProviderProjectionById,
        enabledAgentIds,
        settings.acpCatalogSettingsV1,
    ]);
    const cliDetection = useCLIDetection(resolvedMachineId, {
        includeLoginStatus: Boolean(resolvedMachineId),
        serverId: activeServerId,
    });

    const getPermissionAgentIdForEntry = React.useCallback((entry: ResolvedBackendCatalogEntry): string => {
        return entry.builtInAgentId ?? entry.catalogAgentId ?? entry.agentId;
    }, []);

    const getRuntimeCarrierAgentIdForEntry = React.useCallback((entry: ResolvedBackendCatalogEntry): AgentId | null => {
        return entry.builtInAgentId ?? entry.catalogAgentId ?? null;
    }, []);

    const getDisplayAgentIdForEntry = React.useCallback((entry: ResolvedBackendCatalogEntry): AgentId | null => {
        return entry.iconAgentId ?? entry.builtInAgentId ?? entry.catalogAgentId ?? null;
    }, []);

    const getDisplayAgentIconNameForEntry = React.useCallback((entry: ResolvedBackendCatalogEntry): string => {
        const displayAgentId = getDisplayAgentIdForEntry(entry);
        return getAgentCore(displayAgentId ?? '')?.ui.agentPickerIconName ?? 'layers-outline';
    }, [getDisplayAgentIdForEntry]);

    const toggleFavoriteMachineId = React.useCallback((machineIdToToggle: string) => {
        if (favoriteMachines.includes(machineIdToToggle)) {
            setFavoriteMachines(favoriteMachines.filter((id: string) => id !== machineIdToToggle));
        } else {
            setFavoriteMachines([machineIdToToggle, ...favoriteMachines]);
        }
    }, [favoriteMachines, setFavoriteMachines]);

    const MachinePreviewModalWrapper = React.useCallback(({ onClose }: { onClose: () => void }) => {
        return (
            <MachinePreviewModal
                machines={machines}
                favoriteMachineIds={favoriteMachines}
                selectedMachineId={previewMachineId}
                onSelect={setPreviewMachineId}
                onToggleFavorite={toggleFavoriteMachineId}
                onClose={onClose}
            />
        );
    }, [favoriteMachines, machines, previewMachineId, toggleFavoriteMachineId]);

    const showMachinePreviewPicker = React.useCallback(() => {
        if (Platform.OS !== 'web') {
            const params = {
                ...previewMachineRouteParams,
                ...(previewMachineId ? { selectedId: previewMachineId } : {}),
            };
            router.push({ pathname: '/new/pick/preview-machine', params } as any);
            return;
        }
        Modal.show({
            component: MachinePreviewModalWrapper,
            props: {},
            chrome: {
                kind: 'card',
                title: t('profiles.previewMachine.title'),
                dimensions: { width: 560, maxHeightRatio: 0.85, size: 'md' as const },
            },
        });
    }, [MachinePreviewModalWrapper, previewMachineId, previewMachineRouteParams, router]);

    const profileDocs = React.useMemo(() => {
        if (!profile.isBuiltIn) return null;
        return getBuiltInProfileDocumentation(profile.id);
    }, [profile.id, profile.isBuiltIn]);

    const [environmentVariables, setEnvironmentVariables] = React.useState<Array<{ name: string; value: string; isSecret?: boolean }>>(
        profile.environmentVariables || [],
    );

    const [name, setName] = React.useState(profile.name || '');
    const {
        sourceRequirementsByName,
        derivedEnvVarRequirements,
        profileSecretBindings,
        getDefaultSecretNameForSourceVar,
        openDefaultSecretModalForSourceVar,
        updateSourceRequirement,
    } = useLegacyProfileSecretRequirements({ profile, profileName: name, environmentVariables });
    const sessionDefaultPermissionModeByTargetKey = useSetting('sessionDefaultPermissionModeByTargetKey');
    const newSessionDefaultPersistenceModeV1 = useSetting('newSessionDefaultPersistenceModeV1');
    const newSessionDefaultPersistenceModeByTargetKeyV1 = useSetting('newSessionDefaultPersistenceModeByTargetKeyV1');

    const [defaultPermissionModesByTargetKey, setDefaultPermissionModesByTargetKey] = React.useState<Record<string, PermissionMode | null>>(() => {
        const explicitByTargetKey = (profile.defaultPermissionModeByTargetKey as Record<string, PermissionMode | undefined>) ?? {};
        const out: Record<string, PermissionMode | null> = {};

        for (const entry of resolvedBackendEntries) {
            const permissionAgentId = getPermissionAgentIdForEntry(entry);
            const explicit = readProfileTargetKeyValueForEntry(explicitByTargetKey, entry);
            out[resolveProfileBackendTargetKeyForEntry(entry)] = explicit
                ? normalizePermissionModeForAgentType(explicit, permissionAgentId)
                : null;
        }

        const hasAnyExplicit = resolvedBackendEntries.some((entry) => Boolean(out[resolveProfileBackendTargetKeyForEntry(entry)]));
        if (hasAnyExplicit) return out;

        const legacyRaw = profile.defaultPermissionMode as PermissionMode | undefined;
        const legacy = legacyRaw ? normalizeProfileDefaultPermissionMode(legacyRaw) : undefined;
        if (!legacy) return out;

        for (const entry of resolvedBackendEntries) {
            const isCompat = isProfileCompatibleWithResolvedBackendEntry(profile, entry);
            if (!isCompat) continue;
            out[resolveProfileBackendTargetKeyForEntry(entry)] = normalizePermissionModeForAgentType(legacy, getPermissionAgentIdForEntry(entry));
        }

        return out;
    });
    const transcriptStorageSettings = React.useMemo(() => ({
        opencodeBackendMode: (settings as Record<string, unknown>).opencodeBackendMode,
    }), [settings]);
    const [defaultTranscriptStorageModesByTargetKey, setDefaultTranscriptStorageModesByTargetKey] = React.useState<Record<string, SessionTranscriptStorageMode | null>>(() => {
        const explicitByTargetKey = (profile.defaultPersistenceModeByTargetKey as Record<string, SessionTranscriptStorageMode | undefined>) ?? {};
        const out: Record<string, SessionTranscriptStorageMode | null> = {};

        for (const entry of resolvedBackendEntries) {
            const permissionAgentId = getPermissionAgentIdForEntry(entry);
            const explicit = readProfileTargetKeyValueForEntry(explicitByTargetKey, entry);
            const profileTargetKey = resolveProfileBackendTargetKeyForEntry(entry);
            out[profileTargetKey] = explicit === 'direct' || explicit === 'persisted' ? explicit : null;
            if (!supportsDirectTranscriptStorageForNewSession({
                agentId: permissionAgentId,
                machineId: resolvedMachineId,
                settings: transcriptStorageSettings,
            })) {
                out[profileTargetKey] = null;
            }
        }

        return out;
    });

    const [compatibilityByTargetKeyState, setCompatibilityByTargetKeyState] = React.useState<Record<string, boolean>>(() => {
        const out: Record<string, boolean> = {};
        for (const entry of resolvedBackendEntries) {
            out[resolveProfileBackendTargetKeyForEntry(entry)] = isProfileCompatibleWithResolvedBackendEntry(profile, entry);
        }
        if (resolvedBackendEntries.length > 0 && resolvedBackendEntries.every((entry) => out[resolveProfileBackendTargetKeyForEntry(entry)] !== true)) {
            out[resolveProfileBackendTargetKeyForEntry(resolvedBackendEntries[0]!)] = true;
        }
        return out;
    });

    React.useEffect(() => {
        setCompatibilityByTargetKeyState((prev) => {
            let changed = false;
            const next = { ...prev };
            for (const entry of resolvedBackendEntries) {
                const profileTargetKey = resolveProfileBackendTargetKeyForEntry(entry);
                if (typeof next[profileTargetKey] !== 'boolean') {
                    next[profileTargetKey] = profile.isBuiltIn ? false : entry.kind === 'builtInAgent';
                    changed = true;
                }
            }
            return changed ? next : prev;
        });
    }, [profile.isBuiltIn, resolvedBackendEntries]);

    const [authMode, setAuthMode] = React.useState<AIBackendProfile['authMode']>(profile.authMode);
    const [requiresMachineLogin, setRequiresMachineLogin] = React.useState<AIBackendProfile['requiresMachineLogin']>(profile.requiresMachineLogin);
    const compatibleBackendEntries = React.useMemo(() => {
        return resolvedBackendEntries.filter((entry) => {
            const profileTargetKey = resolveProfileBackendTargetKeyForEntry(entry);
            return compatibilityByTargetKeyState[profileTargetKey] === true;
        });
    }, [compatibilityByTargetKeyState, resolvedBackendEntries]);
    const compatibleMachineLoginTargets = React.useMemo(() => {
        return compatibleBackendEntries.flatMap((entry) => {
            const runtimeCarrierAgentId = getRuntimeCarrierAgentIdForEntry(entry);
            const machineLoginKey = getAgentCore(runtimeCarrierAgentId ?? '')?.cli.machineLoginKey;
            if (!machineLoginKey) return [];
            return [{
                targetKey: resolveProfileBackendTargetKeyForEntry(entry),
                machineLoginKey,
            }];
        });
    }, [compatibleBackendEntries, getRuntimeCarrierAgentIdForEntry]);
    const machineLoginRequirement = React.useMemo(() => {
        return resolveMachineLoginRequirementForProfileTargets({
            compatibleTargets: compatibleMachineLoginTargets,
        });
    }, [compatibleMachineLoginTargets]);

    const [openPermissionProvider, setOpenPermissionProvider] = React.useState<null | string>(null);
    const [openStorageProvider, setOpenStorageProvider] = React.useState<null | string>(null);

    const canSelectMachineLogin = machineLoginRequirement.selectableTargetKey !== null;
    const effectiveAuthMode = authMode === 'machineLogin' && canSelectMachineLogin ? 'machineLogin' : undefined;

    const setDefaultPermissionModeForTarget = React.useCallback((targetKey: string, next: PermissionMode | null) => {
        setDefaultPermissionModesByTargetKey((prev) => {
            if (prev[targetKey] === next) return prev;
            return { ...prev, [targetKey]: next };
        });
    }, []);

    const supportedDirectBackendEntries = React.useMemo(() => {
        return resolvedBackendEntries.filter((entry) => {
            const runtimeCarrierAgentId = getRuntimeCarrierAgentIdForEntry(entry);
            return runtimeCarrierAgentId !== null && supportsDirectTranscriptStorageForNewSession({
                agentId: runtimeCarrierAgentId,
                machineId: resolvedMachineId,
                settings: transcriptStorageSettings,
            });
        });
    }, [getRuntimeCarrierAgentIdForEntry, resolvedBackendEntries, resolvedMachineId, transcriptStorageSettings]);

    const accountTranscriptStorageDefaults = React.useMemo(() => {
        return readAccountTranscriptStorageDefaults({
            globalDefault: newSessionDefaultPersistenceModeV1,
            byTargetKey: newSessionDefaultPersistenceModeByTargetKeyV1,
            enabledBackendTargets: supportedDirectBackendEntries.map((entry) => entry.backendTarget),
        });
    }, [newSessionDefaultPersistenceModeByTargetKeyV1, newSessionDefaultPersistenceModeV1, supportedDirectBackendEntries]);

    const setDefaultTranscriptStorageModeForTarget = React.useCallback((
        targetKey: string,
        next: SessionTranscriptStorageMode | null,
    ) => {
        setDefaultTranscriptStorageModesByTargetKey((prev) => {
            if (prev[targetKey] === next) return prev;
            return { ...prev, [targetKey]: next };
        });
    }, []);

    const accountDefaultPermissionModes = React.useMemo(() => {
        const out: Record<string, PermissionMode> = {};
        for (const agentId of enabledAgentIds) {
            try {
                const targetKey = buildBackendTargetKeyV2({
                    kind: 'backend',
                    backendId: agentId,
                    sourceKind: 'built_in',
                });
                const raw = (sessionDefaultPermissionModeByTargetKey as any)?.[targetKey] as PermissionMode | undefined;
                out[agentId] = normalizePermissionModeForAgentType((raw ?? 'default') as PermissionMode, agentId);
            } catch {
                // Ignore legacy compat agent ids (e.g. `customAcp`).
            }
        }
        return out;
    }, [enabledAgentIds, sessionDefaultPermissionModeByTargetKey]);

    const getPermissionIconNameForAgent = React.useCallback((agent: string, mode: PermissionMode) => {
        return getPermissionModeOptionsForAgentType(agent).find((opt) => opt.value === mode)?.icon ?? 'shield-outline';
    }, []);

    React.useEffect(() => {
        if (authMode === 'machineLogin' && !canSelectMachineLogin) {
            setAuthMode(undefined);
        }
        if (effectiveAuthMode !== 'machineLogin') {
            if (!requiresMachineLogin) return;
            setRequiresMachineLogin(undefined);
            return;
        }
        if (!machineLoginRequirement.machineLoginKey) return;
        if (requiresMachineLogin !== machineLoginRequirement.machineLoginKey) {
            setRequiresMachineLogin(machineLoginRequirement.machineLoginKey);
        }
    }, [authMode, canSelectMachineLogin, effectiveAuthMode, machineLoginRequirement.machineLoginKey, requiresMachineLogin]);

    const initialSnapshotRef = React.useRef<string | null>(null);
    if (initialSnapshotRef.current === null) {
        initialSnapshotRef.current = JSON.stringify({
            name,
            environmentVariables,
            defaultPermissionModesByTargetKey,
            defaultTranscriptStorageModesByTargetKey,
            compatibilityByTargetKeyState,
            authMode,
            requiresMachineLogin,
            derivedEnvVarRequirements,
            // Bindings are settings-level but edited here; include for dirty tracking.
            secretBindings: profileSecretBindings,
        });
    }

    const isDirty = React.useMemo(() => {
        const currentSnapshot = JSON.stringify({
            name,
            environmentVariables,
            defaultPermissionModesByTargetKey,
            defaultTranscriptStorageModesByTargetKey,
            compatibilityByTargetKeyState,
            authMode,
            requiresMachineLogin,
            derivedEnvVarRequirements,
            secretBindings: profileSecretBindings,
        });
        return currentSnapshot !== initialSnapshotRef.current;
    }, [
        authMode,
        compatibilityByTargetKeyState,
        defaultPermissionModesByTargetKey,
        defaultTranscriptStorageModesByTargetKey,
        environmentVariables,
        name,
        derivedEnvVarRequirements,
        requiresMachineLogin,
        profileSecretBindings,
    ]);

    React.useEffect(() => {
        onDirtyChange?.(isDirty);
    }, [isDirty, onDirtyChange]);

    const toggleCompatibility = React.useCallback((targetKey: string) => {
        setCompatibilityByTargetKeyState((prev) => {
            const next = { ...prev, [targetKey]: !prev[targetKey] };
            const enabledCount = resolvedBackendEntries.filter((entry) => next[resolveProfileBackendTargetKeyForEntry(entry)] === true).length;
            if (enabledCount === 0) {
                Modal.alert(t('common.error'), t('profiles.aiBackend.selectAtLeastOneError'));
                return prev;
            }
            return next;
        });
    }, [resolvedBackendEntries]);

    const openSetupGuide = React.useCallback(async () => {
        const url = profileDocs?.setupGuideUrl;
        if (!url) return;
        try {
            if (Platform.OS === 'web') {
                window.open(url, '_blank');
            } else {
                await Linking.openURL(url);
            }
        } catch (error) {
            console.error('Failed to open URL:', error);
        }
    }, [profileDocs?.setupGuideUrl]);

    const handleSave = React.useCallback((): boolean => {
        if (!name.trim()) {
            Modal.alert(t('common.error'), t('profiles.nameRequired'));
            return false;
        }
        return onSave(buildLegacyProfileSave({
            profile,
            name,
            environmentVariables,
            envVarRequirements: derivedEnvVarRequirements,
            authMode: effectiveAuthMode,
            machineLoginTargetKey: machineLoginRequirement.selectableTargetKey,
            resolvedBackendEntries,
            supportedDirectBackendEntries,
            defaultPermissionModesByTargetKey,
            defaultTranscriptStorageModesByTargetKey,
            compatibilityByTargetKey: compatibilityByTargetKeyState,
            updatedAt: Date.now(),
        }), profileSecretBindings);
    }, [
        compatibilityByTargetKeyState,
        defaultPermissionModesByTargetKey,
        defaultTranscriptStorageModesByTargetKey,
        derivedEnvVarRequirements,
        effectiveAuthMode,
        environmentVariables,
        machineLoginRequirement.selectableTargetKey,
        name,
        onSave,
        profile,
        profileSecretBindings,
        resolvedBackendEntries,
        supportedDirectBackendEntries,
    ]);

    React.useEffect(() => {
        if (!saveRef) {
            return;
        }
        saveRef.current = handleSave;
        return () => {
            saveRef.current = null;
        };
    }, [handleSave, saveRef]);

    return (
        <ItemList ref={popoverBoundaryRef} style={containerStyle} keyboardShouldPersistTaps="handled">
            <ItemGroup title={t('profiles.profileName')}>
                <React.Fragment>
                    <View style={styles.inputContainer}>
                        <TextInput
                            style={styles.textInput}
                            placeholder={t('profiles.enterName')}
                            placeholderTextColor={theme.colors.input.placeholder}
                            value={name}
                            onChangeText={setName}
                        />
                    </View>
                </React.Fragment>
            </ItemGroup>

            {profile.isBuiltIn && profileDocs?.setupGuideUrl && (
                <ItemGroup title={t('profiles.setupInstructions.title')} footer={profileDocs.description}>
                    <Item
                        title={t('profiles.setupInstructions.viewCloudGuide')}
                        icon={<Icon name="book" size={29} color={theme.colors.button.secondary.tint} />}
                        onPress={() => void openSetupGuide()}
                    />
                </ItemGroup>
            )}

            <ItemGroup title={t('profiles.requirements.sectionTitle')} footer={t('profiles.requirements.sectionSubtitle')}>
                <Item
                    title={t('profiles.machineLogin.title')}
                    subtitle={t('profiles.machineLogin.subtitle')}
                    leftElement={<Icon name="terminal" size={24} color={theme.colors.text.secondary} />}
                    rightElement={(
                        <Switch
                            value={effectiveAuthMode === 'machineLogin'}
                            disabled={!canSelectMachineLogin}
                            onValueChange={(next) => {
                                if (!canSelectMachineLogin) return;
                                if (!next) {
                                    setAuthMode(undefined);
                                    setRequiresMachineLogin(undefined);
                                    return;
                                }
                                setAuthMode('machineLogin');
                                setRequiresMachineLogin(undefined);
                            }}
                        />
                    )}
                    showChevron={false}
                    onPress={() => {
                        if (!canSelectMachineLogin) return;
                        const next = effectiveAuthMode !== 'machineLogin';
                        if (!next) {
                            setAuthMode(undefined);
                            setRequiresMachineLogin(undefined);
                            return;
                        }
                        setAuthMode('machineLogin');
                        setRequiresMachineLogin(undefined);
                    }}
                    showDivider={false}
                />
            </ItemGroup>

            <LegacyProfileBackendCompatibilitySection
                entries={resolvedBackendEntries}
                compatibilityByTargetKey={compatibilityByTargetKeyState}
                machineLoginEnabled={effectiveAuthMode === 'machineLogin'}
                resolvedMachineId={resolvedMachineId}
                loginByAgentId={cliDetection.login}
                getRuntimeCarrierAgentId={getRuntimeCarrierAgentIdForEntry}
                getDisplayAgentId={getDisplayAgentIdForEntry}
                getDisplayAgentIconName={getDisplayAgentIconNameForEntry}
                toggleCompatibility={toggleCompatibility}
            />
            <LegacyProfileDefaultsSections
                resolvedBackendEntries={resolvedBackendEntries}
                supportedDirectBackendEntries={supportedDirectBackendEntries}
                compatibilityByTargetKey={compatibilityByTargetKeyState}
                defaultPermissionModesByTargetKey={defaultPermissionModesByTargetKey}
                sessionDefaultPermissionModeByTargetKey={sessionDefaultPermissionModeByTargetKey}
                accountDefaultPermissionModes={accountDefaultPermissionModes}
                defaultTranscriptStorageModesByTargetKey={defaultTranscriptStorageModesByTargetKey}
                accountTranscriptStorageDefaults={accountTranscriptStorageDefaults}
                externalSessionsEnabled={externalSessionsEnabled}
                openPermissionTargetKey={openPermissionProvider}
                setOpenPermissionTargetKey={setOpenPermissionProvider}
                openStorageTargetKey={openStorageProvider}
                setOpenStorageTargetKey={setOpenStorageProvider}
                popoverBoundaryRef={popoverBoundaryRef}
                getPermissionAgentId={getPermissionAgentIdForEntry}
                getDisplayAgentIconName={getDisplayAgentIconNameForEntry}
                getPermissionIconName={getPermissionIconNameForAgent}
                setDefaultPermissionMode={setDefaultPermissionModeForTarget}
                setDefaultTranscriptStorageMode={setDefaultTranscriptStorageModeForTarget}
            />

            {!routeMachine && (
                <ItemGroup title={t('profiles.previewMachine.title')}>
                    <Item
                        title={t('profiles.previewMachine.itemTitle')}
                        subtitle={resolvedMachine ? t('profiles.previewMachine.resolveSubtitle') : t('profiles.previewMachine.selectSubtitle')}
                        detail={resolvedMachine ? (resolvedMachine.metadata?.displayName || resolvedMachine.metadata?.host || resolvedMachine.id) : undefined}
                        detailStyle={resolvedMachine
                            ? { color: isMachineOnline(resolvedMachine) ? theme.colors.status.connected : theme.colors.status.disconnected }
                            : undefined}
                        icon={<Icon name="desktop" size={29} color={theme.colors.button.secondary.tint} />}
                        onPress={showMachinePreviewPicker}
                    />
                </ItemGroup>
            )}

            <EnvironmentVariablesList
                environmentVariables={environmentVariables}
                machineId={resolvedMachineId}
                machineName={resolvedMachine ? (resolvedMachine.metadata?.displayName || resolvedMachine.metadata?.host || resolvedMachine.id) : null}
                profileDocs={profileDocs}
                onChange={setEnvironmentVariables}
                sourceRequirementsByName={sourceRequirementsByName}
                onUpdateSourceRequirement={updateSourceRequirement}
                getDefaultSecretNameForSourceVar={getDefaultSecretNameForSourceVar}
                onPickDefaultSecretForSourceVar={openDefaultSecretModalForSourceVar}
            />

            <View style={{ paddingHorizontal: Platform.select({ ios: 16, default: 12 }), paddingTop: 12 }}>
                <View style={{ flexDirection: 'row', gap: 12 }}>
                    <View style={{ flex: 1 }}>
                        <Pressable
                            onPress={onCancel}
                            style={({ pressed }) => ({
                                backgroundColor: theme.colors.surface.base,
                                borderRadius: 10,
                                paddingVertical: 12,
                                alignItems: 'center',
                                opacity: pressed ? 0.85 : 1,
                            })}
                        >
                            <Text style={{ color: theme.colors.text.primary, ...Typography.default('semiBold') }}>
                                {t('common.cancel')}
                            </Text>
                        </Pressable>
                    </View>
                    <View style={{ flex: 1 }}>
                        <Pressable
                            onPress={handleSave}
                            style={({ pressed }) => ({
                                backgroundColor: theme.colors.button.primary.background,
                                borderRadius: 10,
                                paddingVertical: 12,
                                alignItems: 'center',
                                opacity: pressed ? 0.85 : 1,
                            })}
                        >
                            <Text style={{ color: theme.colors.button.primary.tint, ...Typography.default('semiBold') }}>
                                {profile.isBuiltIn ? t('common.saveAs') : t('common.save')}
                            </Text>
                        </Pressable>
                    </View>
                </View>
            </View>
        </ItemList>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    inputContainer: {
        paddingHorizontal: 16,
        paddingVertical: 12,
    },
    textInput: {
        ...Typography.default('regular'),
        backgroundColor: theme.colors.input.background,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: Platform.select({ ios: 10, default: 12 }),
        fontSize: Platform.select({ ios: 17, default: 16 }),
        lineHeight: Platform.select({ ios: 22, default: 24 }),
        letterSpacing: Platform.select({ ios: -0.41, default: 0.15 }),
        color: theme.colors.input.text,
        ...(Platform.select({
            web: {
                outline: 'none',
                outlineStyle: 'none',
                outlineWidth: 0,
                outlineColor: 'transparent',
                boxShadow: 'none',
                WebkitBoxShadow: 'none',
                WebkitAppearance: 'none',
            },
            default: {},
        }) as object),
    },
}));
