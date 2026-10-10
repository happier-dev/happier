import React from 'react';
import { ViewStyle, Linking, Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { type AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import { normalizeProfileDefaultPermissionMode, type PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { getPermissionModeOptionsForAgentType, normalizePermissionModeForAgentType } from '@/sync/domains/permissions/permissionModeOptions';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useAcpCatalog } from '@/sync/store/useAcpCatalog';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import type { AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { Switch } from '@/components/ui/forms/Switch';
import { getBuiltInProfileDocumentation } from '@/sync/domains/profiles/profileUtils';
import { EnvironmentVariablesList } from '@/components/profiles/environmentVariables/EnvironmentVariablesList';
import { useSetting, useSettings, useAllMachines, useMachine, useSettingMutable } from '@/sync/domains/state/storage';
import { Modal } from '@/modal';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { useMachineAgents } from '@/agents/machineAgents/useMachineAgents';
import { projectMachineAgentsToCliAvailability } from '@/agents/machineAgents/machineAgentCliAvailability';
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
import { LegacyProfileDefaultsSections } from './LegacyProfileDefaultsSections';
import { LegacyProfileBackendCompatibilitySection } from './LegacyProfileBackendCompatibilitySection';
import { buildLegacyProfileSave } from './buildLegacyProfileSave';
import { useLegacyProfileSecretRequirements } from './useLegacyProfileSecretRequirements';
import { ProfileNameSection } from '../ProfileNameSection';
import { ProfileEditActions } from '../ProfileEditActions';
import { Icon } from '@/components/ui/icons/Icon';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';

export interface LegacyProfileEditFormProps {
    profile: AIBackendProfile;
    machineId: string | null;
    /**
     * Resolve true when the profile was acknowledged, or false when saving failed.
     */
    onSave: (profile: AIBackendProfile, secretBindings: Readonly<Record<string, string>>) => boolean | Promise<boolean>;
    onCancel: () => void;
    onDirtyChange?: (isDirty: boolean) => void;
    containerStyle?: ViewStyle;
    saveRef?: React.MutableRefObject<(() => boolean | Promise<boolean>) | null>;
    /**
     * The host's page header (entity header with Save). When present the host owns saving and
     * leaving, so the editor renders no action row of its own.
     */
    header?: React.ReactNode;
    /** The name as it is typed, for a host that shows it (a collection's draft row). */
    onNameChange?: (name: string) => void;
    /** A captured compatibility clone permits only source-preserving Save As. */
    sourcePreservingClone?: boolean;
}

function catalogAvailability(catalog: AcpCatalogSnapshotV1 | undefined) {
    const loading = !catalog || catalog.status === 'loading';
    return <SurfaceStateCard testID="profile-legacy-catalog-availability" kind={loading ? 'loading' : 'unavailable'}
        title={t(loading ? 'common.loading' : 'common.error')}
        diagnosticCode={catalog && 'reason' in catalog ? catalog.reason : undefined} />;
}

export function LegacyProfileEditForm(props: LegacyProfileEditFormProps) {
    const scope = useAccountSettingsScope();
    const { snapshot } = useAcpCatalog(scope);
    const scopeKey = scope ? serverAccountScopeKeySuffix(scope) : null;
    const mountedScope = React.useRef<string | null>(null);
    // Initial field defaults require a real catalog. Subsequent refreshes must
    // keep that same editor mounted so an unsaved draft is never replaced.
    if (snapshot?.catalog.status === 'ready' && !snapshot.stale) mountedScope.current = scopeKey;
    if (!scopeKey || mountedScope.current !== scopeKey) {
        return <ItemList>{props.header}{catalogAvailability(snapshot?.catalog)}</ItemList>;
    }
    return <LegacyProfileEditFormReady key={scopeKey} {...props} acpCatalogSnapshot={snapshot?.stale ? undefined : snapshot?.catalog} />;
}

function LegacyProfileEditFormReady({
    profile,
    machineId,
    onSave,
    onCancel,
    onDirtyChange,
    containerStyle,
    saveRef,
    header,
    onNameChange,
    sourcePreservingClone = false,
    acpCatalogSnapshot,
}: LegacyProfileEditFormProps & Readonly<{ acpCatalogSnapshot: AcpCatalogSnapshotV1 | undefined }>) {
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
    const backendCatalogAvailable = acpCatalogSnapshot?.status === 'ready';
    const resolvedBackendEntries = React.useMemo(() => {
        return getResolvedBackendCatalogEntries({
            enabledAgentIds,
            acpCatalogSnapshot,
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
        acpCatalogSnapshot,
    ]);
    const machineAgents = useMachineAgents({
        machineId: resolvedMachineId,
        serverId: activeServerId,
    });
    const cliDetection = React.useMemo(() => projectMachineAgentsToCliAvailability(machineAgents), [machineAgents]);

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
    React.useEffect(() => {
        onNameChange?.(name);
    }, [name, onNameChange]);
    const {
        sourceRequirementsByName,
        derivedEnvVarRequirements,
        profileSecretBindings,
        getDefaultSecretNameForSourceVar,
        openDefaultSecretModalForSourceVar,
        updateSourceRequirement,
    } = useLegacyProfileSecretRequirements({ profile, profileName: name, environmentVariables, preserveSourceDefinition: sourcePreservingClone });
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
            const machineLoginKey = getAgentCore(runtimeCarrierAgentId ?? '')?.cli?.machineLoginKey;
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
        if (sourcePreservingClone || !backendCatalogAvailable) return;
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
    }, [authMode, canSelectMachineLogin, effectiveAuthMode, machineLoginRequirement.machineLoginKey, requiresMachineLogin, sourcePreservingClone, backendCatalogAvailable]);

    const bodySnapshot = React.useMemo(() => JSON.stringify({ environmentVariables, defaultPermissionModesByTargetKey,
        defaultTranscriptStorageModesByTargetKey, compatibilityByTargetKeyState, authMode, requiresMachineLogin,
        derivedEnvVarRequirements, secretBindings: profileSecretBindings }), [
        authMode,
        compatibilityByTargetKeyState,
        defaultPermissionModesByTargetKey,
        defaultTranscriptStorageModesByTargetKey,
        environmentVariables,
        derivedEnvVarRequirements,
        requiresMachineLogin,
        profileSecretBindings,
    ]);
    const initialBodySnapshotRef = React.useRef(bodySnapshot);
    const initialNameRef = React.useRef(name);
    const bodyUnchanged = bodySnapshot === initialBodySnapshotRef.current;
    const isDirty = !bodyUnchanged || name !== initialNameRef.current;

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

    const handleSave = React.useCallback((): boolean | Promise<boolean> => {
        if (!backendCatalogAvailable) return false;
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
            preserveSourceDefinition: sourcePreservingClone && bodyUnchanged,
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
        sourcePreservingClone,
        bodyUnchanged,
        backendCatalogAvailable,
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

    if (!backendCatalogAvailable) return <ItemList>{header}{catalogAvailability(acpCatalogSnapshot)}</ItemList>;

    return (
        <ItemList ref={popoverBoundaryRef} style={containerStyle} keyboardShouldPersistTaps="handled">
            {header}
            <ProfileNameSection testIDPrefix="profile-legacy" name={name} onChangeName={setName} />

            {profile.isBuiltIn && profileDocs?.setupGuideUrl && (
                <ItemGroup title={t('profiles.setupInstructions.title')} description={profileDocs.description}>
                    <Item
                        title={t('profiles.setupInstructions.viewCloudGuide')}
                        icon={<Icon name="book" />}
                        onPress={() => void openSetupGuide()}
                    />
                </ItemGroup>
            )}

            <ItemGroup title={t('profiles.requirements.sectionTitle')} description={t('profiles.requirements.sectionSubtitle')}>
                <Item
                    title={t('profiles.machineLogin.title')}
                    subtitle={t('profiles.machineLogin.subtitle')}
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
                        detail={getMachineDisplayName(resolvedMachine) ?? undefined}
                        detailStyle={resolvedMachine
                            ? { color: isMachineOnline(resolvedMachine) ? theme.colors.status.connected : theme.colors.status.disconnected }
                            : undefined}
                        onPress={showMachinePreviewPicker}
                    />
                </ItemGroup>
            )}

            <EnvironmentVariablesList
                environmentVariables={environmentVariables}
                machineId={resolvedMachineId}
                machineName={getMachineDisplayName(resolvedMachine)}
                profileDocs={profileDocs}
                onChange={setEnvironmentVariables}
                sourceRequirementsByName={sourceRequirementsByName}
                onUpdateSourceRequirement={updateSourceRequirement}
                getDefaultSecretNameForSourceVar={getDefaultSecretNameForSourceVar}
                onPickDefaultSecretForSourceVar={openDefaultSecretModalForSourceVar}
            />

            {header ? null : (
                <ProfileEditActions saveAs={profile.isBuiltIn === true} onSave={handleSave} onCancel={onCancel} />
            )}
        </ItemList>
    );
}
