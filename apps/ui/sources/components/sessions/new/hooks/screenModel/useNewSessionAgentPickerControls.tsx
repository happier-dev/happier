import * as React from 'react';

import type { AgentInputChipPickerOption } from '@/components/sessions/agentInput/components/AgentInputChipPickerTypes';
import { buildAcpConfigOptionOverridesV1, type BackendTargetRefV2, type SessionModelSelectionV1 } from '@happier-dev/protocol';
import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import type { NewSessionProfileAvailabilityReason } from '@/components/sessions/new/modules/newSessionAgentSelection';
import type { ModelMode } from '@/sync/domains/permissions/permissionTypes';
import type { Settings } from '@/sync/domains/settings/settings';
import type { NewSessionAgentPickerViewV1 } from '@/sync/domains/settings/registry/account/accountSessionCreationSettingDefinitions';
import { toggleFavoriteBackendTargetKey } from '@/sync/domains/session/authoring/favoriteBackendTargets';
import type { OptionPickerProbeState } from '@/components/sessions/pickers/OptionPickerOverlay';
import type { RememberedEngineSelectionsByScopeV1 } from '@/sync/domains/session/authoring/rememberedEngineSelections';
import {
    favoriteModelSelectionMatchesBackend,
    getFavoriteModelRef,
    normalizeFavoriteModelId,
    toggleFavoriteModelSelection,
    type FavoriteModelSelectionV1,
} from '@/sync/domains/models/favoriteModelSelections';
import { buildNewSessionAgentPickerOptions } from './buildNewSessionAgentPickerOptions';
import {
    FAVORITE_MODELS_AGENT_PICKER_OPTION_ID,
    type FavoriteModelTogglePayload,
} from './newSessionFavoriteModelsPickerOption';
import { buildFavoriteBackendIdentity } from '@/sync/domains/models/favoriteModelBackendIdentity';
import { resolveNewSessionAgentPickerSingleSelectFallbackEntry } from './resolveNewSessionAgentPickerDispatch';
import { useSessionAgentPickerControls } from '@/components/sessions/agentPicker/useSessionAgentPickerControls';
import { useNewSessionAgentPickerEngineSelectionState } from './useNewSessionAgentPickerEngineSelectionState';
import type { SessionModelPickerExperimentalConfirmationController } from '@/components/sessions/modelPicker/SessionModelPicker';

export function useNewSessionAgentPickerControls(params: Readonly<{
    useProfiles: boolean;
    selectedProfileId: string | null;
    profileMap: ReadonlyMap<string, AIBackendProfile>;
    resolvedBackendEntries: readonly ResolvedBackendCatalogEntry[];
    getCompatibleProfileBackendEntries: (profile: AIBackendProfile) => readonly ResolvedBackendCatalogEntry[];
    isBackendEntrySelectable: (entry: ResolvedBackendCatalogEntry) => boolean;
    getBackendEntryUnavailabilityReason?: (entry: ResolvedBackendCatalogEntry) => NewSessionProfileAvailabilityReason | null;
    selectedBackendEntry: ResolvedBackendCatalogEntry | null;
    selectedBackendTargetKey: string;
    setBackendTarget: React.Dispatch<React.SetStateAction<BackendTargetRefV2>>;
    modelMode: ModelMode;
    modelSelection?: SessionModelSelectionV1 | null;
    setModelMode: React.Dispatch<React.SetStateAction<ModelMode>>;
    acpSessionModeId: string | null;
    setAcpSessionModeId: React.Dispatch<React.SetStateAction<string | null>>;
    sessionConfigOptionOverrides: ReturnType<typeof buildAcpConfigOptionOverridesV1> | null;
    setSessionConfigOptionOverrides: React.Dispatch<React.SetStateAction<ReturnType<typeof buildAcpConfigOptionOverridesV1> | null>>;
    setEngineSelectionForBackendTarget?: Parameters<typeof useNewSessionAgentPickerEngineSelectionState>[0]['setEngineSelectionForBackendTarget'];
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
    experimentalConfirmation?: SessionModelPickerExperimentalConfirmationController;
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
        modelSelection: params.modelSelection ?? null,
        acpSessionModeId: params.acpSessionModeId,
        sessionConfigOptionOverrides: params.sessionConfigOptionOverrides,
        setBackendTarget: params.setBackendTarget,
        setModelMode: params.setModelMode,
        setAcpSessionModeId: params.setAcpSessionModeId,
        setSessionConfigOptionOverrides: params.setSessionConfigOptionOverrides,
        setEngineSelectionForBackendTarget: params.setEngineSelectionForBackendTarget,
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
            modelRef: model.modelSelection?.ref ?? {
                agentTargetKey: entry.backendTargetKey,
                providerConnectionId: null,
                modelId: model.modelId,
            },
            modelLabel: model.modelLabel,
            backendLabel: entry.title,
            providerDisplaySnapshot: model.providerDisplaySnapshot,
            addedAtMs: Date.now(),
        }));
    }, [
        params.favoriteModelSelections,
        params.setFavoriteModelSelections,
    ]);

    const handleSelectFavoriteModel = React.useCallback((
        entry: ResolvedBackendCatalogEntry,
        modelSelection: SessionModelSelectionV1,
        configOverrides?: Readonly<Record<string, string>>,
    ) => {
        const nextSelection = {
            ...getEngineSelectionForTargetKey(entry.backendTargetKey),
            modelId: modelSelection.ref.modelId,
            modelSelection,
            ...(configOverrides ? { configOverrides } : {}),
        };
        selectEngineSelection(entry, nextSelection);
    }, [getEngineSelectionForTargetKey, selectEngineSelection]);

    const handleSelectFavoriteModelOptionValue = React.useCallback((
        entry: ResolvedBackendCatalogEntry,
        modelSelection: SessionModelSelectionV1,
        configId: string,
        valueId: string,
    ) => {
        const currentSelection = getEngineSelectionForTargetKey(entry.backendTargetKey);
        selectEngineSelection(entry, {
            ...currentSelection,
            modelId: modelSelection.ref.modelId,
            modelSelection,
            configOverrides: {
                ...currentSelection.configOverrides,
                [configId]: valueId,
            },
        });
    }, [getEngineSelectionForTargetKey, selectEngineSelection]);

    const handleRemoveFavoriteModelSelection = React.useCallback((favorite: FavoriteModelSelectionV1) => {
        if (!params.setFavoriteModelSelections) return;
        const favoriteRef = getFavoriteModelRef(favorite);
        const favoriteModelId = normalizeFavoriteModelId(favoriteRef.modelId);
        params.setFavoriteModelSelections((params.favoriteModelSelections ?? []).filter((candidate) => (
            normalizeFavoriteModelId(getFavoriteModelRef(candidate).modelId) !== favoriteModelId
            || getFavoriteModelRef(candidate).providerConnectionId !== favoriteRef.providerConnectionId
            || getFavoriteModelRef(candidate).agentTargetKey !== favoriteRef.agentTargetKey
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
        getBackendEntryUnavailabilityReason: params.getBackendEntryUnavailabilityReason,
        getEngineSelectionForTargetKey,
        selectEngineSelection,
        selectedMachineId: params.selectedMachineId,
        capabilityServerId: params.capabilityServerId,
        selectedPath: params.selectedPath,
        selectedBackendTargetKey,
        selectedModelId: String(params.modelMode),
        selectedModelSelection: params.modelSelection ?? null,
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
        experimentalConfirmation: params.experimentalConfirmation,
    }), [
        getEngineSelectionForTargetKey,
        handleSelectFavoriteModelOptionValue,
        params.capabilityServerId,
        params.favoriteBackendTargetKeys,
        params.favoriteModelSelections,
        params.getBackendEntryUnavailabilityReason,
        params.getCompatibleProfileBackendEntries,
        params.isBackendEntrySelectable,
        params.modelMode,
        params.modelSelection,
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
        params.experimentalConfirmation,
        handleSelectFavoriteModel,
        handleRemoveFavoriteModelSelection,
        handleToggleFavoriteBackendTarget,
        handleToggleFavoriteModel,
        selectEngineSelection,
    ]);

    const fallbackOptionId = params.selectedBackendEntry?.backendTargetKey ?? params.selectedBackendTargetKey;
    const rememberedAgentPickerView = params.rememberedAgentPickerView;
    const preferredOptionId = React.useMemo(() => {
        if (rememberedAgentPickerView?.kind === 'favoriteModels') {
            return FAVORITE_MODELS_AGENT_PICKER_OPTION_ID;
        }
        // A remembered backend view only survives while it still matches the selected
        // engine; an external change to the selection must not restore a stale detail pane.
        if (rememberedAgentPickerView?.kind === 'backend' && rememberedAgentPickerView.backendTargetKey === fallbackOptionId) {
            return rememberedAgentPickerView.backendTargetKey;
        }
        return null;
    }, [fallbackOptionId, rememberedAgentPickerView]);

    const {
        agentPickerSelectedOptionId,
        handleAgentPickerSelect,
    } = useSessionAgentPickerControls({
        options: agentPickerOptions,
        selectableEntries: selectableBackendEntries,
        fallbackOptionId,
        preferredOptionId,
        onSelectEntry: (nextEntry) => {
            params.onRememberAgentPickerView?.({
                kind: 'backend',
                backendTargetKey: nextEntry.backendTargetKey,
            });
            selectEngineSelection(nextEntry, getEngineSelectionForTargetKey(nextEntry.backendTargetKey));
        },
        onSelectNonEntryOption: (selectedId) => {
            if (selectedId !== FAVORITE_MODELS_AGENT_PICKER_OPTION_ID) return;
            params.onRememberAgentPickerView?.({ kind: 'favoriteModels' });
        },
    });

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
