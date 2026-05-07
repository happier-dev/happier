import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { NewSessionEngineOptionDetail } from '@/components/sessions/new/components/NewSessionEngineOptionDetail';
import { NewSessionFavoriteModelsDetail } from '@/components/sessions/new/components/NewSessionFavoriteModelsDetail';
import type { AgentInputChipPickerOption } from '@/components/sessions/agentInput/components/AgentInputChipPickerTypes';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { getAgentPickerIconScale } from '@/agents/registry/registryUi';
import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import { getBuiltInProfile } from '@/sync/domains/profiles/profileUtils';
import { buildAcpConfigOptionOverridesV1, type BackendTargetRefV1 } from '@happier-dev/protocol';
import type { ModelMode } from '@/sync/domains/permissions/permissionTypes';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { t } from '@/text';
import type { Settings } from '@/sync/domains/settings/settings';
import { resolveNewSessionCapabilityProbeContext } from '@/components/sessions/new/modules/newSessionCapabilityProbeContext';
import type { OptionPickerProbeState } from '@/components/sessions/pickers/OptionPickerOverlay';
import {
    favoriteModelSelectionMatchesBackend,
    toggleFavoriteModelSelection,
    type FavoriteModelBackendIdentity,
    type FavoriteModelSelectionV1,
} from '@/sync/domains/models/favoriteModelSelections';

type EngineSelection = Readonly<{
    modelId: string;
    sessionModeId: string;
    configOverrides: Readonly<Record<string, string>>;
}>;

const FAVORITE_MODELS_AGENT_PICKER_OPTION_ID = 'favorite-models';

function areConfigOverridesEqual(
    left: Readonly<Record<string, string>>,
    right: Readonly<Record<string, string>>,
): boolean {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    for (const key of leftKeys) {
        if (left[key] !== right[key]) return false;
    }
    return true;
}

function areEngineSelectionsEqual(left: EngineSelection, right: EngineSelection): boolean {
    return left.modelId === right.modelId
        && left.sessionModeId === right.sessionModeId
        && areConfigOverridesEqual(left.configOverrides, right.configOverrides);
}

function FavoriteModelsPickerIcon() {
    const { theme } = useUnistyles();
    return (
        <Ionicons
            name="star"
            size={12}
            color={theme.dark ? theme.colors.text : theme.colors.button.primary.background}
        />
    );
}

function buildFavoriteBackendIdentity(entry: ResolvedBackendCatalogEntry): FavoriteModelBackendIdentity {
    return {
        backendTargetKey: entry.targetKey,
        providerAgentId: entry.providerAgentId,
        builtInAgentId: entry.builtInAgentId,
        configuredBackendId: entry.target.kind === 'configuredAcpBackend' ? entry.target.backendId : null,
    };
}

export function useNewSessionAgentPickerControls(params: Readonly<{
    useProfiles: boolean;
    selectedProfileId: string | null;
    profileMap: ReadonlyMap<string, AIBackendProfile>;
    resolvedBackendEntries: readonly ResolvedBackendCatalogEntry[];
    getCompatibleProfileBackendEntries: (profile: AIBackendProfile) => readonly ResolvedBackendCatalogEntry[];
    isBackendEntrySelectable: (entry: ResolvedBackendCatalogEntry) => boolean;
    selectedBackendEntry: ResolvedBackendCatalogEntry | null;
    selectedBackendTargetKey: string;
    setBackendTarget: React.Dispatch<React.SetStateAction<BackendTargetRefV1>>;
    modelMode: ModelMode;
    setModelMode: React.Dispatch<React.SetStateAction<ModelMode>>;
    acpSessionModeId: string | null;
    setAcpSessionModeId: React.Dispatch<React.SetStateAction<string | null>>;
    sessionConfigOptionOverrides: ReturnType<typeof buildAcpConfigOptionOverridesV1> | null;
    setSessionConfigOptionOverrides: React.Dispatch<React.SetStateAction<ReturnType<typeof buildAcpConfigOptionOverridesV1> | null>>;
    selectedMachineId: string | null;
    capabilityServerId: string;
    selectedPath: string | null;
    settings: Settings;
    favoriteModelSelections?: readonly FavoriteModelSelectionV1[];
    setFavoriteModelSelections?: (favorites: FavoriteModelSelectionV1[]) => void;
    /**
     * Optional probe surface to merge into the engine detail pane's refresh affordance.
     * This is used to make the model refresh button also refresh CLI detection.
     */
    refreshProbe?: OptionPickerProbeState | null;
}>): Readonly<{
    agentPickerOptions?: ReadonlyArray<AgentInputChipPickerOption>;
    handleAgentPickerSelect: (selectedId: string) => void;
    handleAgentClick: () => void;
}> {
    const profileForAgentSelection = React.useMemo(() => {
        if (!params.useProfiles || params.selectedProfileId === null) return null;
        return params.profileMap.get(params.selectedProfileId) || getBuiltInProfile(params.selectedProfileId);
    }, [params.profileMap, params.selectedProfileId, params.useProfiles]);

    const compatibleBackendEntries = React.useMemo(() => {
        return profileForAgentSelection
            ? params.getCompatibleProfileBackendEntries(profileForAgentSelection)
            : params.resolvedBackendEntries;
    }, [params.getCompatibleProfileBackendEntries, profileForAgentSelection, params.resolvedBackendEntries]);

    const compatibleBackendTargetKeys = React.useMemo(() => {
        return new Set(compatibleBackendEntries.map((entry) => entry.targetKey));
    }, [compatibleBackendEntries]);

    const selectableBackendEntries = React.useMemo(() => {
        return params.resolvedBackendEntries.filter((entry) => (
            params.isBackendEntrySelectable(entry)
            && (
                !profileForAgentSelection
                || compatibleBackendTargetKeys.has(entry.targetKey)
            )
        ));
    }, [compatibleBackendTargetKeys, params, profileForAgentSelection]);

    const engineSelectionByTargetKeyRef = React.useRef(new Map<string, EngineSelection>());
    const pendingAppliedSelectionRef = React.useRef<Readonly<{
        targetKey: string;
        selection: EngineSelection;
    }> | null>(null);

    const buildInitialEngineSelection = React.useCallback((targetKey: string): EngineSelection => ({
        modelId: targetKey === (params.selectedBackendEntry?.targetKey ?? params.selectedBackendTargetKey) ? String(params.modelMode) : 'default',
        sessionModeId: targetKey === (params.selectedBackendEntry?.targetKey ?? params.selectedBackendTargetKey)
            ? (params.acpSessionModeId ?? 'default')
            : 'default',
        configOverrides: targetKey === (params.selectedBackendEntry?.targetKey ?? params.selectedBackendTargetKey)
            ? Object.fromEntries(
                Object.entries(params.sessionConfigOptionOverrides?.overrides ?? {})
                    .map(([configId, override]) => [configId, typeof override?.value === 'string' ? override.value.trim() : ''])
                    .filter(([, value]) => value.length > 0),
            )
            : {},
    }), [
        params.acpSessionModeId,
        params.modelMode,
        params.selectedBackendEntry,
        params.selectedBackendTargetKey,
        params.sessionConfigOptionOverrides?.overrides,
    ]);

    React.useEffect(() => {
        const currentTargetKey = params.selectedBackendEntry?.targetKey ?? params.selectedBackendTargetKey;
        const nextSelection = buildInitialEngineSelection(currentTargetKey);
        const pendingAppliedSelection = pendingAppliedSelectionRef.current;
        if (pendingAppliedSelection?.targetKey === currentTargetKey) {
            if (!areEngineSelectionsEqual(nextSelection, pendingAppliedSelection.selection)) {
                engineSelectionByTargetKeyRef.current.set(currentTargetKey, pendingAppliedSelection.selection);
                return;
            }
            pendingAppliedSelectionRef.current = null;
        }
        engineSelectionByTargetKeyRef.current.set(currentTargetKey, nextSelection);
    }, [buildInitialEngineSelection, params.selectedBackendEntry?.targetKey, params.selectedBackendTargetKey]);

    const getEngineSelectionForTargetKey = React.useCallback((targetKey: string) => {
        const existing = engineSelectionByTargetKeyRef.current.get(targetKey);
        if (existing) return existing;
        const initialSelection = buildInitialEngineSelection(targetKey);
        engineSelectionByTargetKeyRef.current.set(targetKey, initialSelection);
        return initialSelection;
    }, [buildInitialEngineSelection]);

    const applyEngineSelection = React.useCallback((entry: ResolvedBackendCatalogEntry, selection: EngineSelection) => {
        const nextConfigOverrides: Readonly<Record<string, string>> = selection.configOverrides ?? {};
        pendingAppliedSelectionRef.current = {
            targetKey: entry.targetKey,
            selection,
        };
        params.setBackendTarget(entry.target);
        params.setModelMode(selection.modelId as ModelMode);
        params.setAcpSessionModeId(selection.sessionModeId);
        if (Object.keys(nextConfigOverrides).length === 0) {
            params.setSessionConfigOptionOverrides(null);
            return;
        }
        const updatedAt = Date.now();
        params.setSessionConfigOptionOverrides(buildAcpConfigOptionOverridesV1({
            updatedAt,
            overrides: Object.fromEntries(
                Object.entries(nextConfigOverrides).map(([configId, value]) => [
                    configId,
                    { updatedAt, value },
                ]),
            ),
        }));
    }, [params]);

    const handleToggleFavoriteModel = React.useCallback((
        entry: ResolvedBackendCatalogEntry,
        model: Readonly<{ modelId: string; modelLabel: string }>,
    ) => {
        if (!params.setFavoriteModelSelections) return;
        params.setFavoriteModelSelections(toggleFavoriteModelSelection({
            favorites: params.favoriteModelSelections ?? [],
            backend: buildFavoriteBackendIdentity(entry),
            modelId: model.modelId,
            modelLabel: model.modelLabel,
            backendLabel: entry.title,
            addedAtMs: Date.now(),
        }));
    }, [
        params.favoriteModelSelections,
        params.setFavoriteModelSelections,
    ]);

    const handleSelectFavoriteModel = React.useCallback((entry: ResolvedBackendCatalogEntry, modelId: string) => {
        const nextSelection = {
            ...getEngineSelectionForTargetKey(entry.targetKey),
            modelId,
        };
        engineSelectionByTargetKeyRef.current.set(entry.targetKey, nextSelection);
        applyEngineSelection(entry, nextSelection);
    }, [applyEngineSelection, getEngineSelectionForTargetKey]);

    const handleSelectFavoriteModelOptionValue = React.useCallback((
        entry: ResolvedBackendCatalogEntry,
        modelId: string,
        configId: string,
        valueId: string,
    ) => {
        const currentSelection = getEngineSelectionForTargetKey(entry.targetKey);
        const nextSelection = {
            ...currentSelection,
            modelId,
            configOverrides: {
                ...currentSelection.configOverrides,
                [configId]: valueId,
            },
        };
        engineSelectionByTargetKeyRef.current.set(entry.targetKey, nextSelection);
        applyEngineSelection(entry, nextSelection);
    }, [applyEngineSelection, getEngineSelectionForTargetKey]);

    const handleRemoveFavoriteModelSelection = React.useCallback((favorite: FavoriteModelSelectionV1) => {
        if (!params.setFavoriteModelSelections) return;
        params.setFavoriteModelSelections((params.favoriteModelSelections ?? []).filter((item) => item !== favorite));
    }, [
        params.favoriteModelSelections,
        params.setFavoriteModelSelections,
    ]);

    const agentPickerOptions = React.useMemo<ReadonlyArray<AgentInputChipPickerOption> | undefined>(() => {
        if (params.resolvedBackendEntries.length <= 1) {
            return undefined;
        }
        const resolved = params.resolvedBackendEntries.map((entry) => {
            const isCompatibleWithSelectedProfile = !profileForAgentSelection || compatibleBackendTargetKeys.has(entry.targetKey);
            const selectable = params.isBackendEntrySelectable(entry);
            const disabled = !isCompatibleWithSelectedProfile;
            const muted = !selectable && !disabled;
            const subtitle = !isCompatibleWithSelectedProfile
                ? t('newSession.aiBackendNotCompatibleWithSelectedProfile')
                : undefined;

            return {
                id: entry.targetKey,
                label: entry.title,
                icon: (
                    <AgentIcon
                        agentId={entry.iconAgentId}
                        size={12}
                        style={{ transform: [{ scale: getAgentPickerIconScale(entry.iconAgentId) }] }}
                    />
                ),
                subtitle,
                disabled,
                muted: muted || disabled,
                closeOnSelectImmediate: false,
                onSelectImmediate: () => {
                    if (disabled) return;
                    const nextSelection = getEngineSelectionForTargetKey(entry.targetKey);
                    applyEngineSelection(entry, nextSelection);
                },
                renderDetailContent: () => {
                    const selection = getEngineSelectionForTargetKey(entry.targetKey);
                    const capabilityProbeContext = resolveNewSessionCapabilityProbeContext({
                        backendTarget: entry.target,
                        settings: params.settings,
                    });
                    return (
                        <NewSessionEngineOptionDetail
                            backendTarget={entry.target}
                            selectedMachineId={params.selectedMachineId}
                            capabilityServerId={params.capabilityServerId}
                            cwd={params.selectedPath}
                            capabilityProbeContext={capabilityProbeContext}
                            refreshProbe={params.refreshProbe}
                            selectedModelId={selection.modelId}
                            selectedSessionModeId={selection.sessionModeId}
                            selectedConfigOverrides={selection.configOverrides}
                            favoriteModelSelections={params.favoriteModelSelections ?? []}
                            onToggleFavoriteModel={params.setFavoriteModelSelections ? (model) => {
                                handleToggleFavoriteModel(entry, model);
                            } : undefined}
                            onSelectionChange={(nextSelection) => {
                                engineSelectionByTargetKeyRef.current.set(entry.targetKey, nextSelection);
                                applyEngineSelection(entry, nextSelection);
                            }}
                        />
                    );
                },
            };
        });
        const available: AgentInputChipPickerOption[] = [];
        const muted: AgentInputChipPickerOption[] = [];
        const disabledOptions: AgentInputChipPickerOption[] = [];
        for (const option of resolved) {
            if (option.disabled) {
                disabledOptions.push(option);
            } else if (option.muted) {
                muted.push(option);
            } else {
                available.push(option);
            }
        }
        const favoriteModelSelections = params.favoriteModelSelections ?? [];
        const favoriteBackendEntries = params.resolvedBackendEntries.filter((entry) => (
            !profileForAgentSelection || compatibleBackendTargetKeys.has(entry.targetKey)
        ));
        const favoriteModelSelectionsForVisibleBackends = favoriteModelSelections.filter((favorite) => (
            favoriteBackendEntries.some((entry) => (
                favoriteModelSelectionMatchesBackend(favorite, buildFavoriteBackendIdentity(entry))
            ))
        ));
        const favoriteModelsOption: AgentInputChipPickerOption[] = favoriteModelSelectionsForVisibleBackends.length > 0
            ? [{
                id: FAVORITE_MODELS_AGENT_PICKER_OPTION_ID,
                label: t('profiles.groups.favorites'),
                icon: <FavoriteModelsPickerIcon />,
                closeOnSelectImmediate: false,
                preserveFocusOnExternalSelectionChange: true,
                onSelectImmediate: () => {},
                renderDetailContent: () => (
                    <NewSessionFavoriteModelsDetail
                        favoriteModelSelections={favoriteModelSelectionsForVisibleBackends}
                        resolvedBackendEntries={favoriteBackendEntries}
                        selectedBackendTargetKey={params.selectedBackendEntry?.targetKey ?? params.selectedBackendTargetKey}
                        selectedModelId={String(params.modelMode)}
                        selectedConfigOverrides={getEngineSelectionForTargetKey(
                            params.selectedBackendEntry?.targetKey ?? params.selectedBackendTargetKey,
                        ).configOverrides}
                        selectedMachineId={params.selectedMachineId}
                        capabilityServerId={params.capabilityServerId}
                        cwd={params.selectedPath}
                        settings={params.settings}
                        refreshProbe={params.refreshProbe ?? null}
                        onSelectFavoriteModel={handleSelectFavoriteModel}
                        onSelectFavoriteModelOptionValue={handleSelectFavoriteModelOptionValue}
                        onToggleFavoriteModel={handleToggleFavoriteModel}
                        onRemoveFavoriteModelSelection={handleRemoveFavoriteModelSelection}
                    />
                ),
            }]
            : [];
        return [...favoriteModelsOption, ...available, ...muted, ...disabledOptions];
    }, [
        applyEngineSelection,
        compatibleBackendTargetKeys,
        handleSelectFavoriteModel,
        handleSelectFavoriteModelOptionValue,
        handleToggleFavoriteModel,
        handleRemoveFavoriteModelSelection,
        getEngineSelectionForTargetKey,
        params.capabilityServerId,
        params.favoriteModelSelections,
        params.isBackendEntrySelectable,
        params.modelMode,
        params.refreshProbe,
        params.resolvedBackendEntries,
        params.selectedBackendEntry?.targetKey,
        params.selectedMachineId,
        params.selectedPath,
        params.selectedBackendTargetKey,
        params.setFavoriteModelSelections,
        params.settings,
        profileForAgentSelection,
    ]);

    const handleAgentPickerSelect = React.useCallback((selectedId: string) => {
        if (selectedId === FAVORITE_MODELS_AGENT_PICKER_OPTION_ID) {
            return;
        }
        const nextEntry = params.resolvedBackendEntries.find((entry) => entry.targetKey === selectedId) ?? null;
        if (nextEntry) {
            const nextSelection = getEngineSelectionForTargetKey(nextEntry.targetKey);
            applyEngineSelection(nextEntry, nextSelection);
        }
    }, [applyEngineSelection, getEngineSelectionForTargetKey, params.resolvedBackendEntries]);

    const handleAgentClick = React.useCallback(() => {
        if (selectableBackendEntries.length === 0) {
            return;
        }

        if (selectableBackendEntries.length === 1) {
            const nextEntry = selectableBackendEntries[0] ?? null;
            if (nextEntry && nextEntry.targetKey !== (params.selectedBackendEntry?.targetKey ?? params.selectedBackendTargetKey)) {
                params.setBackendTarget(nextEntry.target);
            }
        }
    }, [
        params.selectedBackendEntry,
        params.selectedBackendTargetKey,
        params.setBackendTarget,
        selectableBackendEntries,
    ]);

    return {
        agentPickerOptions,
        handleAgentPickerSelect,
        handleAgentClick,
    };
}
