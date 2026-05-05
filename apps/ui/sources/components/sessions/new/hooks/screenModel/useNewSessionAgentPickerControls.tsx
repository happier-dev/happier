import * as React from 'react';

import type { AgentInputChipPickerOption } from '@/components/sessions/agentInput/components/AgentInputChipPickerTypes';
import { buildAcpConfigOptionOverridesV1, type BackendTargetRefV2 } from '@happier-dev/protocol';
import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import type { ModelMode } from '@/sync/domains/permissions/permissionTypes';
import type { Settings } from '@/sync/domains/settings/settings';
import type { OptionPickerProbeState } from '@/components/sessions/pickers/OptionPickerOverlay';
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
    });

    const selectedBackendTargetKey = params.selectedBackendEntry?.backendTargetKey ?? params.selectedBackendTargetKey;

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

    const handleSelectFavoriteModel = React.useCallback((entry: ResolvedBackendCatalogEntry, modelId: string) => {
        const nextSelection = {
            ...getEngineSelectionForTargetKey(entry.backendTargetKey),
            modelId,
        };
        selectEngineSelection(entry, nextSelection);
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
        onSelectFavoriteModel: handleSelectFavoriteModel,
        onToggleFavoriteModel: handleToggleFavoriteModel,
        onRemoveFavoriteModelSelection: handleRemoveFavoriteModelSelection,
    }), [
        getEngineSelectionForTargetKey,
        params.capabilityServerId,
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
        selectedBackendTargetKey,
        params.settings,
        params.useProfiles,
        handleSelectFavoriteModel,
        handleRemoveFavoriteModelSelection,
        handleToggleFavoriteModel,
        selectEngineSelection,
    ]);

    const handleAgentPickerSelect = React.useCallback((selectedId: string) => {
        if (selectedId === FAVORITE_MODELS_AGENT_PICKER_OPTION_ID) {
            return;
        }
        const nextEntry = resolveNewSessionAgentPickerEntryByTargetKey({
            resolvedBackendEntries: params.resolvedBackendEntries,
            selectedId,
        });
        if (nextEntry) {
            const nextSelection = getEngineSelectionForTargetKey(nextEntry.backendTargetKey);
            selectEngineSelection(nextEntry, nextSelection);
        }
    }, [getEngineSelectionForTargetKey, params.resolvedBackendEntries, selectEngineSelection]);

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
        handleAgentPickerSelect,
        handleAgentClick,
    };
}
