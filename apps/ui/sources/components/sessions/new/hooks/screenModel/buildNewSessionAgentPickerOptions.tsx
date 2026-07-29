import * as React from 'react';

import type { AgentInputChipPickerOption } from '@/components/sessions/agentInput/components/AgentInputChipPickerTypes';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import type { NewSessionProfileAvailabilityReason } from '@/components/sessions/new/modules/newSessionAgentSelection';
import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import type { OptionPickerProbeState } from '@/components/sessions/pickers/OptionPickerOverlay';
import type { FavoriteModelSelectionV1 } from '@/sync/domains/models/favoriteModelSelections';
import type { Settings } from '@/sync/domains/settings/settings';
import type { NewSessionAgentPickerViewV1 } from '@/sync/domains/settings/registry/account/accountSessionCreationSettingDefinitions';
import type { SessionModelSelectionV1 } from '@happier-dev/protocol';
import type { SessionModelPickerExperimentalConfirmationController } from '@/components/sessions/modelPicker/SessionModelPicker';
import { sortItemsByFavoriteTargetKey } from '@/sync/domains/session/authoring/favoriteBackendTargets';
import type { NewSessionAgentPickerSelection } from './buildNewSessionAgentPickerDetailContent';
import { buildNewSessionAgentPickerResolvedOptions } from './buildNewSessionAgentPickerResolvedOptions';
import {
    buildNewSessionFavoriteModelsPickerOption,
    type FavoriteModelTogglePayload,
} from './newSessionFavoriteModelsPickerOption';
import { partitionNewSessionAgentPickerOptions } from './partitionNewSessionAgentPickerOptions';
import { resolveNewSessionAgentPickerSelectionContext } from './resolveNewSessionAgentPickerSelectionContext';

type BuildNewSessionAgentPickerOptionsParams = Readonly<{
    useProfiles: boolean;
    selectedProfileId: string | null;
    profileMap: ReadonlyMap<string, AIBackendProfile>;
    resolvedBackendEntries: readonly ResolvedBackendCatalogEntry[];
    getCompatibleProfileBackendEntries: (profile: AIBackendProfile) => readonly ResolvedBackendCatalogEntry[];
    isBackendEntrySelectable: (entry: ResolvedBackendCatalogEntry) => boolean;
    getBackendEntryUnavailabilityReason?: (entry: ResolvedBackendCatalogEntry) => NewSessionProfileAvailabilityReason | null;
    getEngineSelectionForTargetKey: (targetKey: string) => NewSessionAgentPickerSelection;
    selectEngineSelection: (entry: ResolvedBackendCatalogEntry, selection: NewSessionAgentPickerSelection) => void;
    selectedMachineId: string | null;
    capabilityServerId: string;
    selectedPath: string | null;
    selectedBackendTargetKey: string;
    selectedModelId: string;
    selectedModelSelection?: SessionModelSelectionV1 | null;
    selectedConfigOverrides?: Readonly<Record<string, string>>;
    settings: Settings;
    refreshProbe?: OptionPickerProbeState | null;
    favoriteModelSelections?: readonly FavoriteModelSelectionV1[];
    favoriteBackendTargetKeys?: ReadonlyArray<string>;
    onSelectFavoriteModel?: (
        entry: ResolvedBackendCatalogEntry,
        modelSelection: SessionModelSelectionV1,
        configOverrides?: Readonly<Record<string, string>>,
    ) => void;
    onSelectFavoriteModelOptionValue?: (
        entry: ResolvedBackendCatalogEntry,
        modelSelection: SessionModelSelectionV1,
        configId: string,
        valueId: string,
    ) => void;
    onToggleFavoriteModel?: (entry: ResolvedBackendCatalogEntry, model: FavoriteModelTogglePayload) => void;
    onToggleFavoriteBackendTarget?: (targetKey: string) => void;
    onRemoveFavoriteModelSelection?: (favorite: FavoriteModelSelectionV1) => void;
    onRememberAgentPickerView?: (view: NewSessionAgentPickerViewV1) => void;
    experimentalConfirmation?: SessionModelPickerExperimentalConfirmationController;
}>;

export type NewSessionAgentPickerOptionsState = Readonly<{
    agentPickerOptions?: ReadonlyArray<AgentInputChipPickerOption>;
    selectableBackendEntries: readonly ResolvedBackendCatalogEntry[];
}>;

export function buildNewSessionAgentPickerOptions(
    params: BuildNewSessionAgentPickerOptionsParams,
): NewSessionAgentPickerOptionsState {
    const sessionCapableBackendEntries = params.resolvedBackendEntries.filter((entry) => (
        entry.capabilities?.session?.supported !== false
    ));
    const {
        profileForAgentSelection,
        compatibleBackendTargetKeys,
        selectableBackendEntries,
    } = resolveNewSessionAgentPickerSelectionContext({
        useProfiles: params.useProfiles,
        selectedProfileId: params.selectedProfileId,
        profileMap: params.profileMap,
        resolvedBackendEntries: sessionCapableBackendEntries,
        getCompatibleProfileBackendEntries: params.getCompatibleProfileBackendEntries,
        isBackendEntrySelectable: params.isBackendEntrySelectable,
    });

    const hasNonBuiltInBackend = sessionCapableBackendEntries.some((entry) => entry.kind !== 'builtInAgent');
    if (sessionCapableBackendEntries.length <= 1 && !hasNonBuiltInBackend) {
        return {
            selectableBackendEntries,
        };
    }

    const resolved = buildNewSessionAgentPickerResolvedOptions({
        profileForAgentSelection,
        compatibleBackendTargetKeys,
        resolvedBackendEntries: sortItemsByFavoriteTargetKey(
            sessionCapableBackendEntries,
            params.favoriteBackendTargetKeys ?? [],
            (entry) => entry.backendTargetKey,
        ),
        isBackendEntrySelectable: params.isBackendEntrySelectable,
        getBackendEntryUnavailabilityReason: params.getBackendEntryUnavailabilityReason,
        getEngineSelectionForTargetKey: params.getEngineSelectionForTargetKey,
        selectEngineSelection: params.selectEngineSelection,
        selectedMachineId: params.selectedMachineId,
        capabilityServerId: params.capabilityServerId,
        selectedPath: params.selectedPath,
        settings: params.settings,
        refreshProbe: params.refreshProbe,
        favoriteModelSelections: params.favoriteModelSelections ?? [],
        favoriteBackendTargetKeys: params.favoriteBackendTargetKeys ?? [],
        onToggleFavoriteModel: params.onToggleFavoriteModel,
        onToggleFavoriteBackendTarget: params.onToggleFavoriteBackendTarget,
        onRememberAgentPickerView: params.onRememberAgentPickerView,
        experimentalConfirmation: params.experimentalConfirmation,
    });

    const { available, muted, disabled } = partitionNewSessionAgentPickerOptions(resolved);
    const favoriteOption = params.onSelectFavoriteModel && params.onToggleFavoriteModel
        ? buildNewSessionFavoriteModelsPickerOption({
            favoriteModelSelections: params.favoriteModelSelections ?? [],
            resolvedBackendEntries: sessionCapableBackendEntries,
            compatibleBackendTargetKeys,
            selectedBackendTargetKey: params.selectedBackendTargetKey,
            selectedModelId: params.selectedModelId,
            selectedModelSelection: params.selectedModelSelection,
            selectedConfigOverrides: params.selectedConfigOverrides,
            selectedMachineId: params.selectedMachineId,
            capabilityServerId: params.capabilityServerId,
            selectedPath: params.selectedPath,
            settings: params.settings,
            refreshProbe: params.refreshProbe,
            onSelectFavoriteModel: params.onSelectFavoriteModel,
            onSelectFavoriteModelOptionValue: params.onSelectFavoriteModelOptionValue,
            onToggleFavoriteModel: params.onToggleFavoriteModel,
            onRemoveFavoriteModelSelection: params.onRemoveFavoriteModelSelection,
            onRememberAgentPickerView: params.onRememberAgentPickerView,
        })
        : null;

    return {
        agentPickerOptions: [
            ...(favoriteOption ? [favoriteOption] : []),
            ...available,
            ...muted,
            ...disabled,
        ],
        selectableBackendEntries,
    };
}
