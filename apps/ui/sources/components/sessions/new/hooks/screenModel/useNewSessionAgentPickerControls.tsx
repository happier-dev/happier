import * as React from 'react';

import type { AgentInputChipPickerOption } from '@/components/sessions/agentInput/components/AgentInputChipPickerTypes';
import { buildAcpConfigOptionOverridesV1, type BackendTargetRefV2 } from '@happier-dev/protocol';
import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import type { ModelMode } from '@/sync/domains/permissions/permissionTypes';
import type { Settings } from '@/sync/domains/settings/settings';
import type { NewSessionAgentPickerViewV1 } from '@/sync/domains/settings/registry/account/accountSessionCreationSettingDefinitions';
import { toggleFavoriteBackendTargetKey } from '@/sync/domains/session/authoring/favoriteBackendTargets';
import type { OptionPickerProbeState } from '@/components/sessions/pickers/OptionPickerOverlay';
import type { RememberedEngineSelectionsByScopeV1 } from '@/sync/domains/session/authoring/rememberedEngineSelections';
import {
    favoriteModelSelectionMatchesBackend,
    normalizeFavoriteModelId,
    toggleFavoriteModelSelection,
    type FavoriteModelSelectionV1,
} from '@/sync/domains/models/favoriteModelSelections';
import { buildNewSessionAgentPickerOptions } from './buildNewSessionAgentPickerOptions';
import {
    buildFavoriteBackendIdentity,
    FAVORITE_MODELS_AGENT_PICKER_OPTION_ID,
    type FavoriteModelTogglePayload,
} from './newSessionFavoriteModelsPickerOption';
import {
    resolveNewSessionAgentPickerEntryByTargetKey,
    resolveNewSessionAgentPickerSingleSelectFallbackEntry,
} from './resolveNewSessionAgentPickerDispatch';
import { useNewSessionAgentPickerEngineSelectionState } from './useNewSessionAgentPickerEngineSelectionState';

export function useNewSessionAgentPickerControls(params: Readonly<{
    useProfiles: boolean;
    selectedProfileId: string | null;
    profileMap: ReadonlyMap<string, AIBackendProfile>;
    resolvedBackendEntries: readonly ResolvedBackendCatalogEntry[];
    getCompatibleProfileBackendEntries: (profile: AIBackendProfile) => readonly ResolvedBackendCatalogEntry[];
    isBackendEntrySelectable: (entry: ResolvedBackendCatalogEntry) => boolean;
    selectedBackendEntry: ResolvedBackendCatalogEntry | null;
    selectedBackendTargetKey: string;
    setBackendTarget: React.Dispatch<React.SetStateAction<BackendTargetRefV2>>;
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
    favoriteBackendTargetKeys?: ReadonlyArray<string>;
    setFavoriteBackendTargetKeys?: (favorites: string[]) => void;
    rememberedAgentPickerView?: NewSessionAgentPickerViewV1;
    onRememberAgentPickerView?: (view: NewSessionAgentPickerViewV1) => void;
    rememberEngineSelectionsEnabled?: boolean;
    rememberedEngineSelectionsByScope?: RememberedEngineSelectionsByScopeV1 | null;
    rememberedEngineSelectionServerId?: string | null;
    onRememberEngineSelection?: Parameters<typeof useNewSessionAgentPickerEngineSelectionState>[0]['onRememberEngineSelection'];
    onExplicitBackendTargetSelection?: Parameters<typeof useNewSessionAgentPickerEngineSelectionState>[0]['onExplicitBackendTargetSelection'];
    /**
     * Optional probe surface to merge into the engine detail pane's refresh affordance.
     * This is used to make the model refresh button also refresh CLI detection.
     */
    refreshProbe?: OptionPickerProbeState | null;
}>): Readonly<{
    agentPickerOptions?: ReadonlyArray<AgentInputChipPickerOption>;
    agentPickerSelectedOptionId?: string | null;
    handleAgentPickerSelect: (selectedId: string) => void;
    handleAgentClick: () => void;
}> {
    const {
        getEngineSelectionForTargetKey,
        selectEngineSelection,
    } = useNewSessionAgentPickerEngineSelectionState({
        selectedBackendEntry: params.selectedBackendEntry,
        selectedBackendTargetKey: params.selectedBackendTargetKey,
        modelMode: params.modelMode,
        acpSessionModeId: params.acpSessionModeId,
        sessionConfigOptionOverrides: params.sessionConfigOptionOverrides,
        setBackendTarget: params.setBackendTarget,
        setModelMode: params.setModelMode,
        setAcpSessionModeId: params.setAcpSessionModeId,
        setSessionConfigOptionOverrides: params.setSessionConfigOptionOverrides,
        rememberEngineSelectionsEnabled: params.rememberEngineSelectionsEnabled,
        rememberedEngineSelectionsByScope: params.rememberedEngineSelectionsByScope,
        rememberedEngineSelectionServerId: params.rememberedEngineSelectionServerId,
        onRememberEngineSelection: params.onRememberEngineSelection,
        onExplicitBackendTargetSelection: params.onExplicitBackendTargetSelection,
    });

    const selectedBackendTargetKey = params.selectedBackendEntry?.backendTargetKey ?? params.selectedBackendTargetKey;

    const handleToggleFavoriteBackendTarget = React.useCallback((targetKey: string) => {
        if (!params.setFavoriteBackendTargetKeys) return;
        params.setFavoriteBackendTargetKeys(toggleFavoriteBackendTargetKey(
            params.favoriteBackendTargetKeys ?? [],
            targetKey,
        ));
    }, [
        params.favoriteBackendTargetKeys,
        params.setFavoriteBackendTargetKeys,
    ]);

    const handleToggleFavoriteModel = React.useCallback((
        entry: ResolvedBackendCatalogEntry,
        model: FavoriteModelTogglePayload,
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

    const handleSelectFavoriteModel = React.useCallback((
        entry: ResolvedBackendCatalogEntry,
        modelId: string,
        configOverrides?: Readonly<Record<string, string>>,
    ) => {
        const nextSelection = {
            ...getEngineSelectionForTargetKey(entry.backendTargetKey),
            modelId,
            ...(configOverrides ? { configOverrides } : {}),
        };
        selectEngineSelection(entry, nextSelection);
    }, [getEngineSelectionForTargetKey, selectEngineSelection]);

    const handleSelectFavoriteModelOptionValue = React.useCallback((
        entry: ResolvedBackendCatalogEntry,
        modelId: string,
        configId: string,
        valueId: string,
    ) => {
        const currentSelection = getEngineSelectionForTargetKey(entry.backendTargetKey);
        selectEngineSelection(entry, {
            ...currentSelection,
            modelId,
            configOverrides: {
                ...currentSelection.configOverrides,
                [configId]: valueId,
            },
        });
    }, [getEngineSelectionForTargetKey, selectEngineSelection]);

    const handleRemoveFavoriteModelSelection = React.useCallback((favorite: FavoriteModelSelectionV1) => {
        if (!params.setFavoriteModelSelections) return;
        const favoriteModelId = normalizeFavoriteModelId(favorite.modelId);
        params.setFavoriteModelSelections((params.favoriteModelSelections ?? []).filter((candidate) => (
            normalizeFavoriteModelId(candidate.modelId) !== favoriteModelId
            || !favoriteModelSelectionMatchesBackend(candidate, favorite)
        )));
    }, [
        params.favoriteModelSelections,
        params.setFavoriteModelSelections,
    ]);

    const {
        agentPickerOptions,
        selectableBackendEntries,
    } = React.useMemo(() => buildNewSessionAgentPickerOptions({
        useProfiles: params.useProfiles,
        selectedProfileId: params.selectedProfileId,
        profileMap: params.profileMap,
        resolvedBackendEntries: params.resolvedBackendEntries,
        getCompatibleProfileBackendEntries: params.getCompatibleProfileBackendEntries,
        isBackendEntrySelectable: params.isBackendEntrySelectable,
        getEngineSelectionForTargetKey,
        selectEngineSelection,
        selectedMachineId: params.selectedMachineId,
        capabilityServerId: params.capabilityServerId,
        selectedPath: params.selectedPath,
        selectedBackendTargetKey,
        selectedModelId: String(params.modelMode),
        settings: params.settings,
        refreshProbe: params.refreshProbe,
        favoriteModelSelections: params.favoriteModelSelections ?? [],
        favoriteBackendTargetKeys: params.favoriteBackendTargetKeys ?? [],
        onSelectFavoriteModel: handleSelectFavoriteModel,
        selectedConfigOverrides: getEngineSelectionForTargetKey(selectedBackendTargetKey).configOverrides,
        onSelectFavoriteModelOptionValue: handleSelectFavoriteModelOptionValue,
        onToggleFavoriteModel: handleToggleFavoriteModel,
        onToggleFavoriteBackendTarget: params.setFavoriteBackendTargetKeys ? handleToggleFavoriteBackendTarget : undefined,
        onRemoveFavoriteModelSelection: handleRemoveFavoriteModelSelection,
        onRememberAgentPickerView: params.onRememberAgentPickerView,
    }), [
        getEngineSelectionForTargetKey,
        handleSelectFavoriteModelOptionValue,
        params.capabilityServerId,
        params.favoriteBackendTargetKeys,
        params.favoriteModelSelections,
        params.getCompatibleProfileBackendEntries,
        params.isBackendEntrySelectable,
        params.modelMode,
        params.profileMap,
        params.refreshProbe,
        params.resolvedBackendEntries,
        params.selectedMachineId,
        params.selectedPath,
        params.selectedProfileId,
        params.setFavoriteBackendTargetKeys,
        selectedBackendTargetKey,
        params.settings,
        params.useProfiles,
        params.onRememberAgentPickerView,
        handleSelectFavoriteModel,
        handleRemoveFavoriteModelSelection,
        handleToggleFavoriteBackendTarget,
        handleToggleFavoriteModel,
        selectEngineSelection,
    ]);

    const agentPickerSelectedOptionId = React.useMemo(() => {
        const fallbackOptionId = params.selectedBackendEntry?.backendTargetKey ?? params.selectedBackendTargetKey;
        const pickerOptions = agentPickerOptions ?? [];
        if (params.rememberedAgentPickerView?.kind === 'favoriteModels') {
            const hasFavoriteModelsOption = pickerOptions.some((option) => option.id === FAVORITE_MODELS_AGENT_PICKER_OPTION_ID);
            if (hasFavoriteModelsOption) {
                return FAVORITE_MODELS_AGENT_PICKER_OPTION_ID;
            }
        }
        const rememberedView = params.rememberedAgentPickerView;
        if (rememberedView?.kind === 'backend') {
            const hasRememberedBackendOption = pickerOptions.some((option) => option.id === rememberedView.backendTargetKey);
            if (hasRememberedBackendOption) {
                return rememberedView.backendTargetKey;
            }
        }
        return fallbackOptionId;
    }, [
        agentPickerOptions,
        params.rememberedAgentPickerView,
        params.selectedBackendEntry?.backendTargetKey,
        params.selectedBackendTargetKey,
    ]);

    const handleAgentPickerSelect = React.useCallback((selectedId: string) => {
        if (selectedId === FAVORITE_MODELS_AGENT_PICKER_OPTION_ID) {
            params.onRememberAgentPickerView?.({ kind: 'favoriteModels' });
            return;
        }
        const nextEntry = resolveNewSessionAgentPickerEntryByTargetKey({
            resolvedBackendEntries: params.resolvedBackendEntries,
            selectedId,
        });
        if (nextEntry) {
            params.onRememberAgentPickerView?.({
                kind: 'backend',
                backendTargetKey: nextEntry.backendTargetKey,
            });
            const nextSelection = getEngineSelectionForTargetKey(nextEntry.backendTargetKey);
            selectEngineSelection(nextEntry, nextSelection);
        }
    }, [getEngineSelectionForTargetKey, params.onRememberAgentPickerView, params.resolvedBackendEntries, selectEngineSelection]);

    const handleAgentClick = React.useCallback(() => {
        const nextEntry = resolveNewSessionAgentPickerSingleSelectFallbackEntry({
            selectableBackendEntries,
            selectedBackendTargetKey,
        });
        if (nextEntry) {
            params.setBackendTarget(nextEntry.backendTarget);
        }
    }, [
        params.setBackendTarget,
        selectedBackendTargetKey,
        selectableBackendEntries,
    ]);

    return {
        agentPickerOptions,
        agentPickerSelectedOptionId,
        handleAgentPickerSelect,
        handleAgentClick,
    };
}
