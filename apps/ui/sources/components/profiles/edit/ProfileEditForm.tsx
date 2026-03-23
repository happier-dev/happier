import React from 'react';
import { View, ViewStyle, Linking, Platform, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet } from 'react-native-unistyles';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { type AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import { type SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import { normalizeProfileDefaultPermissionMode, type PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { getPermissionModeLabelForAgentType, getPermissionModeOptionsForAgentType, normalizePermissionModeForAgentType } from '@/sync/domains/permissions/permissionModeOptions';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { Switch } from '@/components/ui/forms/Switch';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { getBuiltInProfileDocumentation } from '@/sync/domains/profiles/profileUtils';
import { EnvironmentVariablesList } from '@/components/profiles/environmentVariables/EnvironmentVariablesList';
import { useSetting, useSettings, useAllMachines, useMachine, useSettingMutable } from '@/sync/domains/state/storage';
import { Modal } from '@/modal';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { useCLIDetection } from '@/hooks/auth/useCLIDetection';
import { getActiveServerId } from '@/sync/domains/server/serverProfiles';
import { layout } from '@/components/ui/layout/layout';
import { SecretRequirementModal, type SecretRequirementModalResult } from '@/components/secrets/requirements';
import { parseEnvVarTemplate } from '@/utils/profiles/envVarTemplate';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useEnabledAgentIds } from '@/agents/hooks/useEnabledAgentIds';
import { DEFAULT_AGENT_ID, getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import { getResolvedBackendCatalogEntries, type ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { buildBackendTargetKey } from '@happier-dev/protocol';
import { supportsDirectTranscriptStorageForNewSession } from '@/components/sessions/new/modules/newSessionTranscriptStorage';
import { readAccountTranscriptStorageDefaults, type SessionTranscriptStorageMode } from '@/sync/domains/session/transcriptStorageDefaults';
import { MachinePreviewModal } from './MachinePreviewModal';
import { resolveMachineLoginRequirementForProfileTargets } from './resolveMachineLoginRequirementForProfileTargets';
import {
    isProfileCompatibleWithResolvedBackendEntry,
    readProfileTargetKeyValueForEntry,
    stripLegacyProviderSentinelTargetKeys,
} from './profileBackendEntryStorage';
import { Text, TextInput } from '@/components/ui/text/Text';

function stripUndefinedRecordValues<TValue>(
    record: Readonly<Record<string, TValue | undefined>>,
): Record<string, TValue> {
    const next: Record<string, TValue> = {};
    for (const [key, value] of Object.entries(record)) {
        if (value !== undefined) {
            next[key] = value;
        }
    }
    return next;
}


export interface ProfileEditFormProps {
    profile: AIBackendProfile;
    machineId: string | null;
    /**
     * Return true when the profile was successfully saved.
     * Return false when saving failed (e.g. validation error).
     */
    onSave: (profile: AIBackendProfile) => boolean;
    onCancel: () => void;
    onDirtyChange?: (isDirty: boolean) => void;
    containerStyle?: ViewStyle;
    saveRef?: React.MutableRefObject<(() => boolean) | null>;
}

export function ProfileEditForm({
    profile,
    machineId,
    onSave,
    onCancel,
    onDirtyChange,
    containerStyle,
    saveRef,
}: ProfileEditFormProps) {
    const { theme, rt } = useUnistyles();
    const router = useRouter();
    const routeParams = useLocalSearchParams<{ previewMachineId?: string | string[] }>();
    const previewMachineIdParam = Array.isArray(routeParams.previewMachineId) ? routeParams.previewMachineId[0] : routeParams.previewMachineId;
    const selectedIndicatorColor = rt.themeName === 'dark' ? theme.colors.text : theme.colors.button.primary.background;
    const styles = stylesheet;
    const popoverBoundaryRef = React.useRef<any>(null);
    const enabledAgentIds = useEnabledAgentIds();
    const machines = useAllMachines();
    const settings = useSettings();
    const directSessionsEnabled = useFeatureEnabled('sessions.direct');
    const [favoriteMachines, setFavoriteMachines] = useSettingMutable('favoriteMachines');
    const [secrets, setSecrets] = useSettingMutable('secrets');
    const [secretBindingsByProfileId, setSecretBindingsByProfileId] = useSettingMutable('secretBindingsByProfileId');
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
    const backendEnabledByTargetKey = settings.backendEnabledByTargetKey;
    const resolvedBackendEntries = React.useMemo(() => {
        return getResolvedBackendCatalogEntries({
            enabledAgentIds,
            acpCatalogSettingsV1: settings.acpCatalogSettingsV1,
            backendEnabledByTargetKey,
        });
    }, [backendEnabledByTargetKey, enabledAgentIds, settings.acpCatalogSettingsV1]);
    const cliDetection = useCLIDetection(resolvedMachineId, {
        includeLoginStatus: Boolean(resolvedMachineId),
        serverId: activeServerId,
    });

    const getPermissionAgentIdForEntry = React.useCallback((entry: ResolvedBackendCatalogEntry): AgentId => {
        return entry.builtInAgentId ?? entry.iconAgentId;
    }, []);

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
            const params = previewMachineId ? { selectedId: previewMachineId } : {};
            router.push({ pathname: '/new/pick/preview-machine', params } as any);
            return;
        }
        Modal.show({
            component: MachinePreviewModalWrapper,
            props: {},
        });
    }, [MachinePreviewModalWrapper, previewMachineId, router]);

    const profileDocs = React.useMemo(() => {
        if (!profile.isBuiltIn) return null;
        return getBuiltInProfileDocumentation(profile.id);
    }, [profile.id, profile.isBuiltIn]);

    const [environmentVariables, setEnvironmentVariables] = React.useState<Array<{ name: string; value: string; isSecret?: boolean }>>(
        profile.environmentVariables || [],
    );

    const [name, setName] = React.useState(profile.name || '');
    const sessionDefaultPermissionModeByTargetKey = useSetting('sessionDefaultPermissionModeByTargetKey');
    const newSessionDefaultPersistenceModeV1 = useSetting('newSessionDefaultPersistenceModeV1');
    const newSessionDefaultPersistenceModeByTargetKeyV1 = useSetting('newSessionDefaultPersistenceModeByTargetKeyV1');

    const [defaultPermissionModesByTargetKey, setDefaultPermissionModesByTargetKey] = React.useState<Record<string, PermissionMode | null>>(() => {
        const explicitByTargetKey = (profile.defaultPermissionModeByTargetKey as Record<string, PermissionMode | undefined>) ?? {};
        const out: Record<string, PermissionMode | null> = {};

        for (const entry of resolvedBackendEntries) {
            const permissionAgentId = getPermissionAgentIdForEntry(entry);
            const explicit = readProfileTargetKeyValueForEntry(explicitByTargetKey, entry);
            out[entry.targetKey] = explicit ? normalizePermissionModeForAgentType(explicit, permissionAgentId) : null;
        }

        const hasAnyExplicit = resolvedBackendEntries.some((entry) => Boolean(out[entry.targetKey]));
        if (hasAnyExplicit) return out;

        const legacyRaw = profile.defaultPermissionMode as PermissionMode | undefined;
        const legacy = legacyRaw ? normalizeProfileDefaultPermissionMode(legacyRaw) : undefined;
        if (!legacy) return out;

        for (const entry of resolvedBackendEntries) {
            const isCompat = isProfileCompatibleWithResolvedBackendEntry(profile, entry);
            if (!isCompat) continue;
            out[entry.targetKey] = normalizePermissionModeForAgentType(legacy, getPermissionAgentIdForEntry(entry));
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
            out[entry.targetKey] = explicit === 'direct' || explicit === 'persisted' ? explicit : null;
            if (!supportsDirectTranscriptStorageForNewSession({ agentId: permissionAgentId, settings: transcriptStorageSettings })) {
                out[entry.targetKey] = null;
            }
        }

        return out;
    });

    const [compatibilityByTargetKeyState, setCompatibilityByTargetKeyState] = React.useState<Record<string, boolean>>(() => {
        const out: Record<string, boolean> = {};
        for (const entry of resolvedBackendEntries) {
            out[entry.targetKey] = isProfileCompatibleWithResolvedBackendEntry(profile, entry);
        }
        if (resolvedBackendEntries.length > 0 && resolvedBackendEntries.every((entry) => out[entry.targetKey] !== true)) {
            out[resolvedBackendEntries[0]!.targetKey] = true;
        }
        return out;
    });

    React.useEffect(() => {
        setCompatibilityByTargetKeyState((prev) => {
            let changed = false;
            const next = { ...prev };
            for (const entry of resolvedBackendEntries) {
                if (typeof next[entry.targetKey] !== 'boolean') {
                    next[entry.targetKey] = profile.isBuiltIn ? false : entry.family === 'builtInAgent';
                    changed = true;
                }
            }
            return changed ? next : prev;
        });
    }, [profile.isBuiltIn, resolvedBackendEntries]);

    const [authMode, setAuthMode] = React.useState<AIBackendProfile['authMode']>(profile.authMode);
    const [requiresMachineLogin, setRequiresMachineLogin] = React.useState<AIBackendProfile['requiresMachineLogin']>(profile.requiresMachineLogin);
    /**
     * Requirements live in the env-var editor UI, but are persisted in `profile.envVarRequirements`
     * (derived) and `secretBindingsByProfileId` (per-profile default saved secret choice).
     *
     * Attachment model:
     * - When a row uses `${SOURCE_VAR}`, requirements attach to `SOURCE_VAR`
     * - Otherwise, requirements attach to the env var name itself (e.g. `OPENAI_API_KEY`)
     */
    const [sourceRequirementsByName, setSourceRequirementsByName] = React.useState<Record<string, { required: boolean; useSecretVault: boolean }>>(() => {
        const map: Record<string, { required: boolean; useSecretVault: boolean }> = {};
        for (const req of profile.envVarRequirements ?? []) {
            if (!req || typeof (req as any).name !== 'string') continue;
            const name = String((req as any).name).trim().toUpperCase();
            if (!name) continue;
            const kind = ((req as any).kind ?? 'secret') as 'secret' | 'config';
            map[name] = {
                required: Boolean((req as any).required),
                useSecretVault: kind === 'secret',
            };
        }
        return map;
    });

    const usedRequirementVarNames = React.useMemo(() => {
        const set = new Set<string>();
        for (const v of environmentVariables) {
            const tpl = parseEnvVarTemplate(v.value);
            const name = (tpl?.sourceVar ? tpl.sourceVar : v.name).trim().toUpperCase();
            if (name) set.add(name);
        }
        return set;
    }, [environmentVariables]);

    // Prune requirements that no longer correspond to any referenced requirement var name.
    React.useEffect(() => {
        setSourceRequirementsByName((prev) => {
            let changed = false;
            const next: Record<string, { required: boolean; useSecretVault: boolean }> = {};
            for (const [name, state] of Object.entries(prev)) {
                if (usedRequirementVarNames.has(name)) {
                    next[name] = state;
                } else {
                    changed = true;
                }
            }
            return changed ? next : prev;
        });
    }, [usedRequirementVarNames]);

    // Prune default secret bindings when the requirement var name is no longer used or no longer uses the vault.
    React.useEffect(() => {
        const existing = secretBindingsByProfileId[profile.id];
        if (!existing) return;

        let changed = false;
        const nextBindings: Record<string, string> = {};
        for (const [envVarName, secretId] of Object.entries(existing)) {
            const req = sourceRequirementsByName[envVarName];
            const keep = usedRequirementVarNames.has(envVarName) && Boolean(req?.useSecretVault);
            if (keep) {
                if (typeof secretId === 'string') {
                    nextBindings[envVarName] = secretId;
                } else {
                    changed = true;
                }
            } else {
                changed = true;
            }
        }
        if (!changed) return;

        const out = { ...secretBindingsByProfileId };
        if (Object.keys(nextBindings).length === 0) {
            delete out[profile.id];
        } else {
            out[profile.id] = nextBindings;
        }
        setSecretBindingsByProfileId(out);
    }, [profile.id, secretBindingsByProfileId, setSecretBindingsByProfileId, sourceRequirementsByName, usedRequirementVarNames]);

    const derivedEnvVarRequirements = React.useMemo<NonNullable<AIBackendProfile['envVarRequirements']>>(() => {
        const out = Object.entries(sourceRequirementsByName)
            .filter(([name]) => usedRequirementVarNames.has(name))
            .map(([name, state]) => ({
                name,
                kind: state.useSecretVault ? 'secret' as const : 'config' as const,
                required: Boolean(state.required),
            }));
        out.sort((a, b) => a.name.localeCompare(b.name));
        return out;
    }, [sourceRequirementsByName, usedRequirementVarNames]);

    const getDefaultSecretNameForSourceVar = React.useCallback((sourceVarName: string): string | null => {
        const id = secretBindingsByProfileId[profile.id]?.[sourceVarName] ?? null;
        if (!id) return null;
        return secrets.find((s: SavedSecret) => s.id === id)?.name ?? null;
    }, [profile.id, secretBindingsByProfileId, secrets]);

    const openDefaultSecretModalForSourceVar = React.useCallback((sourceVarName: string) => {
        const normalized = sourceVarName.trim().toUpperCase();
        if (!normalized) return;

        // Use derived requirements so the modal reflects the current editor state.
        const previewProfile: AIBackendProfile = {
            ...profile,
            name,
            envVarRequirements: derivedEnvVarRequirements,
        };

        const defaultSecretId = secretBindingsByProfileId[profile.id]?.[normalized] ?? null;

        const setDefaultSecretId = (id: string | null) => {
            const existing = secretBindingsByProfileId[profile.id] ?? {};
            const nextBindings = { ...existing };
            if (!id) {
                delete nextBindings[normalized];
            } else {
                nextBindings[normalized] = id;
            }
            const out = { ...secretBindingsByProfileId };
            if (Object.keys(nextBindings).length === 0) {
                delete out[profile.id];
            } else {
                out[profile.id] = nextBindings;
            }
            setSecretBindingsByProfileId(out);
        };

        const handleResolve = (result: SecretRequirementModalResult) => {
            if (result.action !== 'selectSaved') return;
            setDefaultSecretId(result.secretId);
        };

        Modal.show({
            component: SecretRequirementModal,
            props: {
                profile: previewProfile,
                secretEnvVarName: normalized,
                machineId: null,
                secrets,
                defaultSecretId,
                selectedSavedSecretId: defaultSecretId,
                onSetDefaultSecretId: setDefaultSecretId,
                variant: 'defaultForProfile',
                titleOverride: t('secrets.defineDefaultForProfileTitle'),
                onChangeSecrets: setSecrets,
                allowSessionOnly: false,
                onResolve: handleResolve,
                onRequestClose: () => handleResolve({ action: 'cancel' } as SecretRequirementModalResult),
            },
            closeOnBackdrop: true,
        });
    }, [derivedEnvVarRequirements, name, profile, secretBindingsByProfileId, secrets, setSecretBindingsByProfileId, setSecrets]);

    const updateSourceRequirement = React.useCallback((
        sourceVarName: string,
        next: { required: boolean; useSecretVault: boolean } | null
    ) => {
        const normalized = sourceVarName.trim().toUpperCase();
        if (!normalized) return;

        setSourceRequirementsByName((prev) => {
            const out = { ...prev };
            if (next === null) {
                delete out[normalized];
            } else {
                out[normalized] = { required: Boolean(next.required), useSecretVault: Boolean(next.useSecretVault) };
            }
            return out;
        });

        // If the vault is disabled (or requirement removed), drop any default secret binding immediately.
        if (next === null || next.useSecretVault !== true) {
            const existing = secretBindingsByProfileId[profile.id];
            if (existing && (normalized in existing)) {
                const nextBindings = { ...existing };
                delete nextBindings[normalized];
                const out = { ...secretBindingsByProfileId };
                if (Object.keys(nextBindings).length === 0) {
                    delete out[profile.id];
                } else {
                    out[profile.id] = nextBindings;
                }
                setSecretBindingsByProfileId(out);
            }
        }
    }, [profile.id, secretBindingsByProfileId, setSecretBindingsByProfileId]);

    const compatibleBackendEntries = React.useMemo(() => {
        return resolvedBackendEntries.filter((entry) => compatibilityByTargetKeyState[entry.targetKey] === true);
    }, [compatibilityByTargetKeyState, resolvedBackendEntries]);
    const compatibleMachineLoginTargets = React.useMemo(() => {
        return compatibleBackendEntries.map((entry) => ({
            targetKey: entry.targetKey,
            machineLoginKey: getAgentCore(getPermissionAgentIdForEntry(entry)).cli.machineLoginKey,
        }));
    }, [compatibleBackendEntries, getPermissionAgentIdForEntry]);
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
        return resolvedBackendEntries.filter((entry) => supportsDirectTranscriptStorageForNewSession({
            agentId: getPermissionAgentIdForEntry(entry),
            settings: transcriptStorageSettings,
        }));
    }, [getPermissionAgentIdForEntry, resolvedBackendEntries, transcriptStorageSettings]);

    const accountTranscriptStorageDefaults = React.useMemo(() => {
        return readAccountTranscriptStorageDefaults({
            globalDefault: newSessionDefaultPersistenceModeV1,
            byTargetKey: newSessionDefaultPersistenceModeByTargetKeyV1,
            enabledBackendTargets: supportedDirectBackendEntries.map((entry) => entry.target),
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
        const out: Partial<Record<AgentId, PermissionMode>> = {};
        for (const agentId of enabledAgentIds) {
            const targetKey = buildBackendTargetKey({ kind: 'builtInAgent', agentId });
            const raw = (sessionDefaultPermissionModeByTargetKey as any)?.[targetKey] as PermissionMode | undefined;
            out[agentId] = normalizePermissionModeForAgentType((raw ?? 'default') as PermissionMode, agentId);
        }
        return out;
    }, [enabledAgentIds, sessionDefaultPermissionModeByTargetKey]);

    const getPermissionIconNameForAgent = React.useCallback((agent: AgentId, mode: PermissionMode) => {
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
            secretBindings: secretBindingsByProfileId[profile.id] ?? null,
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
            secretBindings: secretBindingsByProfileId[profile.id] ?? null,
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
        secretBindingsByProfileId,
        profile.id,
    ]);

    React.useEffect(() => {
        onDirtyChange?.(isDirty);
    }, [isDirty, onDirtyChange]);

    const toggleCompatibility = React.useCallback((targetKey: string) => {
        setCompatibilityByTargetKeyState((prev) => {
            const next = { ...prev, [targetKey]: !prev[targetKey] };
            const enabledCount = resolvedBackendEntries.filter((entry) => next[entry.targetKey] === true).length;
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

        const { defaultPermissionModeClaude, defaultPermissionModeCodex, defaultPermissionModeGemini, ...profileBase } = profile as any;
        const defaultPermissionModeByTargetKey = stripLegacyProviderSentinelTargetKeys(
            stripUndefinedRecordValues(
                (profileBase.defaultPermissionModeByTargetKey as Record<string, PermissionMode | undefined>) ?? {},
            ),
            resolvedBackendEntries,
        );
        for (const entry of resolvedBackendEntries) {
            const mode = defaultPermissionModesByTargetKey[entry.targetKey] as PermissionMode | null | undefined;
            if (mode) {
                defaultPermissionModeByTargetKey[entry.targetKey] = mode;
            } else {
                delete defaultPermissionModeByTargetKey[entry.targetKey];
            }
        }
        const defaultPersistenceModeByTargetKey = stripLegacyProviderSentinelTargetKeys(
            stripUndefinedRecordValues(
                (profileBase.defaultPersistenceModeByTargetKey as Record<string, SessionTranscriptStorageMode | undefined>) ?? {},
            ),
            resolvedBackendEntries,
        );
        for (const entry of supportedDirectBackendEntries) {
            const mode = defaultTranscriptStorageModesByTargetKey[entry.targetKey] as SessionTranscriptStorageMode | null | undefined;
            if (mode === 'direct' || mode === 'persisted') {
                defaultPersistenceModeByTargetKey[entry.targetKey] = mode;
            } else {
                delete defaultPersistenceModeByTargetKey[entry.targetKey];
            }
        }
        const compatibilityByTargetKey = stripLegacyProviderSentinelTargetKeys(
            stripUndefinedRecordValues(
                (profileBase.compatibilityByTargetKey as Record<string, boolean | undefined>) ?? {},
            ),
            resolvedBackendEntries,
        );
        for (const entry of resolvedBackendEntries) {
            compatibilityByTargetKey[entry.targetKey] = compatibilityByTargetKeyState[entry.targetKey] === true;
        }

        const persistedAuthMode = effectiveAuthMode;
        return onSave({
            ...profileBase,
            name: name.trim(),
            environmentVariables,
            authMode: persistedAuthMode,
            requiresMachineLoginTargetKey: persistedAuthMode === 'machineLogin'
                ? machineLoginRequirement.selectableTargetKey
                : undefined,
            requiresMachineLogin: undefined,
            envVarRequirements: derivedEnvVarRequirements,
            // Prefer provider-specific defaults; clear legacy field on save.
            defaultPermissionMode: undefined,
            defaultPermissionModeByTargetKey,
            defaultPermissionModeByAgent: {},
            defaultPersistenceModeByTargetKey,
            defaultPersistenceModeByAgent: {},
            compatibilityByTargetKey,
            compatibility: {},
            updatedAt: Date.now(),
        });
    }, [
        compatibilityByTargetKeyState,
        defaultPermissionModesByTargetKey,
        defaultTranscriptStorageModesByTargetKey,
        derivedEnvVarRequirements,
        environmentVariables,
        resolvedBackendEntries,
        name,
        onSave,
        profile,
        authMode,
        effectiveAuthMode,
        machineLoginRequirement.selectableTargetKey,
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
                        icon={<Ionicons name="book-outline" size={29} color={theme.colors.button.secondary.tint} />}
                        onPress={() => void openSetupGuide()}
                    />
                </ItemGroup>
            )}

            <ItemGroup title={t('profiles.requirements.sectionTitle')} footer={t('profiles.requirements.sectionSubtitle')}>
                <Item
                    title={t('profiles.machineLogin.title')}
                    subtitle={t('profiles.machineLogin.subtitle')}
                    leftElement={<Ionicons name="terminal-outline" size={24} color={theme.colors.textSecondary} />}
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

            <ItemGroup title={t('profiles.aiBackend.title')}>
                {(() => {
                    const shouldShowLoginStatus = effectiveAuthMode === 'machineLogin' && Boolean(resolvedMachineId);

                    const renderLoginStatus = (status: boolean) => (
                        <Text style={[styles.aiBackendStatus, { color: status ? theme.colors.status.connected : theme.colors.status.disconnected }]}>
                            {status ? t('profiles.machineLogin.status.loggedIn') : t('profiles.machineLogin.status.notLoggedIn')}
                        </Text>
                    );

                    return (
                        <>
                            {resolvedBackendEntries.map((entry, index) => {
                                const core = getAgentCore(entry.iconAgentId);
                                const permissionAgentId = getPermissionAgentIdForEntry(entry);
                                const defaultSubtitle = entry.subtitle ?? t(core.subtitleKey);
                                const loginStatus = shouldShowLoginStatus ? cliDetection.login[permissionAgentId] : null;
                                const subtitle = shouldShowLoginStatus && typeof loginStatus === 'boolean'
                                    ? renderLoginStatus(loginStatus)
                                    : defaultSubtitle;
                                const enabled = compatibilityByTargetKeyState[entry.targetKey] === true;
                                const showDivider = index < resolvedBackendEntries.length - 1;
                                return (
                                    <Item
                                        key={entry.targetKey}
                                        title={entry.title}
                                        subtitle={subtitle}
                                        leftElement={<Ionicons name={core.ui.agentPickerIconName as any} size={24} color={theme.colors.textSecondary} />}
                                        rightElement={<Switch value={enabled} onValueChange={() => toggleCompatibility(entry.targetKey)} />}
                                        showChevron={false}
                                        onPress={() => toggleCompatibility(entry.targetKey)}
                                        showDivider={showDivider}
                                    />
                                );
                            })}
                        </>
                    );
                })()}
            </ItemGroup>
            <ItemGroup
                title={t('profiles.defaultPermissions.title')}
                footer={t('profiles.defaultPermissions.footer')}
            >
                {resolvedBackendEntries
                    .filter((entry) => compatibilityByTargetKeyState[entry.targetKey] === true)
                    .map((entry, index, items) => {
                        const permissionAgentId = getPermissionAgentIdForEntry(entry);
                        const core = getAgentCore(entry.iconAgentId);
                        const override = defaultPermissionModesByTargetKey[entry.targetKey] as PermissionMode | null | undefined;
                        const accountTargetRaw = (sessionDefaultPermissionModeByTargetKey as any)?.[entry.targetKey] as PermissionMode | undefined;
                        const accountDefault = normalizePermissionModeForAgentType(
                            (accountTargetRaw ?? (accountDefaultPermissionModes as any)?.[permissionAgentId] ?? 'default') as PermissionMode,
                            permissionAgentId,
                        );
                        const effectiveMode = (override ?? accountDefault) as PermissionMode;
                        const showDivider = index < items.length - 1;

                        return (
                            <DropdownMenu
                                key={entry.targetKey}
                                open={openPermissionProvider === entry.targetKey}
                                onOpenChange={(next) => setOpenPermissionProvider(next ? entry.targetKey : null)}
                                popoverBoundaryRef={popoverBoundaryRef}
                                variant="selectable"
                                search={false}
                                showCategoryTitles={false}
                                matchTriggerWidth={true}
                                connectToTrigger={true}
                                rowKind="item"
                                selectedId={override ?? '__account__'}
                                trigger={({ open, toggle }) => (
                                    <Item
                                        selected={false}
                                        title={entry.title}
                                        subtitle={override
                                            ? getPermissionModeLabelForAgentType(permissionAgentId, override)
                                            : t('profiles.defaultPermissions.accountDefaultSubtitle', { label: getPermissionModeLabelForAgentType(permissionAgentId, accountDefault) })
                                        }
                                        icon={<Ionicons name={core.ui.agentPickerIconName as any} size={29} color={theme.colors.textSecondary} />}
                                        rightElement={(
                                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                                                <Ionicons
                                                    name={getPermissionIconNameForAgent(permissionAgentId, effectiveMode) as any}
                                                    size={22}
                                                    color={theme.colors.textSecondary}
                                                />
                                                <Ionicons
                                                    name={open ? 'chevron-up' : 'chevron-down'}
                                                    size={20}
                                                    color={theme.colors.textSecondary}
                                                />
                                            </View>
                                        )}
                                        showChevron={false}
                                        onPress={toggle}
                                        showDivider={showDivider}
                                    />
                                )}
                                items={[
                                    {
                                        id: '__account__',
                                        title: t('profiles.defaultPermissions.useAccountDefault'),
                                        subtitle: t('profiles.defaultPermissions.currently', { label: getPermissionModeLabelForAgentType(permissionAgentId, accountDefault) }),
                                        icon: (
                                            <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                                <Ionicons name="settings-outline" size={22} color={theme.colors.textSecondary} />
                                            </View>
                                        ),
                                    },
                                    ...getPermissionModeOptionsForAgentType(permissionAgentId).map((opt) => ({
                                        id: opt.value,
                                        title: opt.label,
                                        subtitle: opt.description,
                                        icon: (
                                            <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                                <Ionicons name={opt.icon as any} size={22} color={theme.colors.textSecondary} />
                                            </View>
                                        ),
                                    })),
                                ]}
                                onSelect={(id) => {
                                    if (id === '__account__') {
                                        setDefaultPermissionModeForTarget(entry.targetKey, null);
                                    } else {
                                        setDefaultPermissionModeForTarget(entry.targetKey, id as any);
                                    }
                                    setOpenPermissionProvider(null);
                                }}
                            />
                        );
                    })}
            </ItemGroup>

            {directSessionsEnabled && supportedDirectBackendEntries.filter((entry) => compatibilityByTargetKeyState[entry.targetKey] === true).length > 0 ? (
                <ItemGroup
                    title={t('profiles.defaultStorage.title')}
                    footer={t('profiles.defaultStorage.footer')}
                >
                    {supportedDirectBackendEntries
                        .filter((entry) => compatibilityByTargetKeyState[entry.targetKey] === true)
                        .map((entry, index, items) => {
                            const core = getAgentCore(entry.iconAgentId);
                            const override = defaultTranscriptStorageModesByTargetKey[entry.targetKey] as SessionTranscriptStorageMode | null | undefined;
                            const accountDefault = accountTranscriptStorageDefaults.byTargetKey[entry.targetKey]
                                ?? accountTranscriptStorageDefaults.globalDefault;
                            const effectiveMode = override ?? accountDefault;
                            const showDivider = index < items.length - 1;

                            return (
                                <DropdownMenu
                                    key={`storage-${entry.targetKey}`}
                                    open={openStorageProvider === entry.targetKey}
                                    onOpenChange={(next) => setOpenStorageProvider(next ? entry.targetKey : null)}
                                    popoverBoundaryRef={popoverBoundaryRef}
                                    variant="selectable"
                                    search={false}
                                    showCategoryTitles={false}
                                    matchTriggerWidth={true}
                                    connectToTrigger={true}
                                rowKind="item"
                                selectedId={override ?? '__account__'}
                                trigger={({ open, toggle }) => (
                                    <Item
                                        selected={false}
                                        title={entry.title}
                                        subtitle={override
                                            ? t(`sessionsList.storage${override === 'direct' ? 'Direct' : 'Persisted'}Tab`)
                                            : t('profiles.defaultStorage.accountDefaultSubtitle', {
                                                    label: t(`sessionsList.storage${accountDefault === 'direct' ? 'Direct' : 'Persisted'}Tab`),
                                                })
                                            }
                                            icon={<Ionicons name={core.ui.agentPickerIconName as any} size={29} color={theme.colors.textSecondary} />}
                                            rightElement={(
                                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                                                    <Ionicons
                                                        name={effectiveMode === 'direct' ? 'radio-outline' : 'save-outline'}
                                                        size={22}
                                                        color={theme.colors.textSecondary}
                                                    />
                                                    <Ionicons
                                                        name={open ? 'chevron-up' : 'chevron-down'}
                                                        size={20}
                                                        color={theme.colors.textSecondary}
                                                    />
                                                </View>
                                            )}
                                            showChevron={false}
                                            onPress={toggle}
                                            showDivider={showDivider}
                                        />
                                    )}
                                    items={[
                                        {
                                            id: '__account__',
                                            title: t('profiles.defaultStorage.useAccountDefault'),
                                            subtitle: t('profiles.defaultStorage.currently', {
                                                label: t(`sessionsList.storage${accountDefault === 'direct' ? 'Direct' : 'Persisted'}Tab`),
                                            }),
                                            icon: (
                                                <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                                    <Ionicons name="settings-outline" size={22} color={theme.colors.textSecondary} />
                                                </View>
                                            ),
                                        },
                                        {
                                            id: 'persisted',
                                            title: t('sessionsList.storagePersistedTab'),
                                            subtitle: t('settingsSession.defaultStorage.persistedSubtitle'),
                                            icon: (
                                                <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                                    <Ionicons name="save-outline" size={22} color={theme.colors.textSecondary} />
                                                </View>
                                            ),
                                        },
                                        {
                                            id: 'direct',
                                            title: t('sessionsList.storageDirectTab'),
                                            subtitle: t('settingsSession.defaultStorage.directSubtitle'),
                                            icon: (
                                                <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                                    <Ionicons name="radio-outline" size={22} color={theme.colors.textSecondary} />
                                                </View>
                                            ),
                                        },
                                    ]}
                                    onSelect={(id) => {
                                        if (id === '__account__') {
                                            setDefaultTranscriptStorageModeForTarget(entry.targetKey, null);
                                        } else {
                                            setDefaultTranscriptStorageModeForTarget(entry.targetKey, id as SessionTranscriptStorageMode);
                                        }
                                        setOpenStorageProvider(null);
                                    }}
                                />
                            );
                        })}
                </ItemGroup>
            ) : null}

            {!routeMachine && (
                <ItemGroup title={t('profiles.previewMachine.title')}>
                    <Item
                        title={t('profiles.previewMachine.itemTitle')}
                        subtitle={resolvedMachine ? t('profiles.previewMachine.resolveSubtitle') : t('profiles.previewMachine.selectSubtitle')}
                        detail={resolvedMachine ? (resolvedMachine.metadata?.displayName || resolvedMachine.metadata?.host || resolvedMachine.id) : undefined}
                        detailStyle={resolvedMachine
                            ? { color: isMachineOnline(resolvedMachine) ? theme.colors.status.connected : theme.colors.status.disconnected }
                            : undefined}
                        icon={<Ionicons name="desktop-outline" size={29} color={theme.colors.button.secondary.tint} />}
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
                                backgroundColor: theme.colors.surface,
                                borderRadius: 10,
                                paddingVertical: 12,
                                alignItems: 'center',
                                opacity: pressed ? 0.85 : 1,
                            })}
                        >
                            <Text style={{ color: theme.colors.text, ...Typography.default('semiBold') }}>
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
    selectorContainer: {
        paddingHorizontal: 12,
        paddingBottom: 4,
    },
    requirementsHeader: {
        width: '100%',
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
        paddingTop: Platform.select({ ios: 26, default: 20 }),
        paddingBottom: Platform.select({ ios: 8, default: 8 }),
        paddingHorizontal: Platform.select({ ios: 32, default: 24 }),
    },
    requirementsTitle: {
        ...Typography.default('regular'),
        color: theme.colors.groupped.sectionTitle,
        fontSize: Platform.select({ ios: 13, default: 14 }),
        lineHeight: Platform.select({ ios: 18, default: 20 }),
        letterSpacing: Platform.select({ ios: -0.08, default: 0.1 }),
        textTransform: 'uppercase',
        fontWeight: Platform.select({ ios: 'normal', default: '500' }),
    },
    requirementsSubtitle: {
        ...Typography.default('regular'),
        color: theme.colors.groupped.sectionTitle,
        fontSize: Platform.select({ ios: 13, default: 14 }),
        lineHeight: Platform.select({ ios: 18, default: 20 }),
        letterSpacing: Platform.select({ ios: -0.08, default: 0 }),
        marginTop: Platform.select({ ios: 6, default: 8 }),
    },
    requirementsTilesContainer: {
        width: '100%',
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
        paddingHorizontal: Platform.select({ ios: 16, default: 12 }),
        paddingBottom: 8,
    },
    fieldLabel: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        color: theme.colors.groupped.sectionTitle,
        marginBottom: 4,
    },
    aiBackendStatus: {
        ...Typography.default('regular'),
        fontSize: Platform.select({ ios: 15, default: 14 }),
        lineHeight: 20,
        letterSpacing: Platform.select({ ios: -0.24, default: 0.1 }),
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
    multilineInput: {
        ...Typography.default('regular'),
        backgroundColor: theme.colors.input.background,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 12,
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.input.text,
        fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
        minHeight: 120,
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
