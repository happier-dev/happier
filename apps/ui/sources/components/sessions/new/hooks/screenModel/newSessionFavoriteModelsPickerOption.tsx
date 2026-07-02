import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import type { AgentInputChipPickerOption } from '@/components/sessions/agentInput/components/AgentInputChipPickerTypes';
import { NewSessionFavoriteModelsDetail } from '@/components/sessions/new/components/NewSessionFavoriteModelsDetail';
import type { OptionPickerProbeState } from '@/components/sessions/pickers/OptionPickerOverlay';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import type { Settings } from '@/sync/domains/settings/settings';
import type { NewSessionAgentPickerViewV1 } from '@/sync/domains/settings/registry/account/accountSessionCreationSettingDefinitions';
import {
    favoriteModelSelectionMatchesBackend,
    type FavoriteModelBackendIdentity,
    type FavoriteModelSelectionV1,
} from '@/sync/domains/models/favoriteModelSelections';
import { t } from '@/text';

export const FAVORITE_MODELS_AGENT_PICKER_OPTION_ID = 'favorite-models';

export type FavoriteModelTogglePayload = Readonly<{
    modelId: string;
    modelLabel: string;
}>;

export function buildFavoriteBackendIdentity(entry: ResolvedBackendCatalogEntry): FavoriteModelBackendIdentity {
    return {
        backendTargetKey: entry.backendTargetKey,
        providerAgentId: entry.providerAgentId,
        builtInAgentId: entry.builtInAgentId,
        configuredBackendId: entry.backendTarget.configuredBackendId ?? null,
    };
}

function FavoriteModelsPickerIcon() {
    const { theme } = useUnistyles();
    return (
        <Ionicons
            name="star"
            size={12}
            color={theme.dark ? theme.colors.text.primary : theme.colors.button.primary.background}
        />
    );
}

export function buildNewSessionFavoriteModelsPickerOption(params: Readonly<{
    favoriteModelSelections: readonly FavoriteModelSelectionV1[];
    resolvedBackendEntries: readonly ResolvedBackendCatalogEntry[];
    compatibleBackendTargetKeys: ReadonlySet<string>;
    selectedBackendTargetKey: string;
    selectedModelId: string;
    selectedConfigOverrides?: Readonly<Record<string, string>>;
    selectedMachineId: string | null;
    capabilityServerId: string;
    selectedPath: string | null;
    settings: Settings;
    refreshProbe?: OptionPickerProbeState | null;
    onSelectFavoriteModel: (
        entry: ResolvedBackendCatalogEntry,
        modelId: string,
        configOverrides?: Readonly<Record<string, string>>,
    ) => void;
    onSelectFavoriteModelOptionValue?: (
        entry: ResolvedBackendCatalogEntry,
        modelId: string,
        configId: string,
        valueId: string,
    ) => void;
    onToggleFavoriteModel: (entry: ResolvedBackendCatalogEntry, model: FavoriteModelTogglePayload) => void;
    onRemoveFavoriteModelSelection?: (favorite: FavoriteModelSelectionV1) => void;
    onRememberAgentPickerView?: (view: NewSessionAgentPickerViewV1) => void;
}>): AgentInputChipPickerOption | null {
    if (params.favoriteModelSelections.length === 0) {
        return null;
    }

    const compatibleResolvedBackendEntries = params.resolvedBackendEntries.filter((entry) => (
        params.compatibleBackendTargetKeys.has(entry.backendTargetKey)
    ));
    const hasCompatibleFavoriteSelections = compatibleResolvedBackendEntries.some((entry) => {
        const backendIdentity = buildFavoriteBackendIdentity(entry);
        return params.favoriteModelSelections.some((favorite) => (
            favoriteModelSelectionMatchesBackend(favorite, backendIdentity)
        ));
    });
    if (!hasCompatibleFavoriteSelections) {
        return null;
    }

    return {
        id: FAVORITE_MODELS_AGENT_PICKER_OPTION_ID,
        label: t('profiles.groups.favorites'),
        icon: <FavoriteModelsPickerIcon />,
        closeOnSelectImmediate: false,
        deferRenderDetailContent: true,
        deferredDetailContentCacheKey: [
            'new-session-favorite-models',
            params.capabilityServerId,
            params.selectedMachineId ?? '',
            params.selectedPath ?? '',
        ].join(':'),
        preserveFocusOnExternalSelectionChange: true,
        onSelectImmediate: () => {
            params.onRememberAgentPickerView?.({ kind: 'favoriteModels' });
        },
        renderDetailContent: () => (
            <NewSessionFavoriteModelsDetail
                favoriteModelSelections={params.favoriteModelSelections}
                resolvedBackendEntries={compatibleResolvedBackendEntries}
                selectedBackendTargetKey={params.selectedBackendTargetKey}
                selectedModelId={params.selectedModelId}
                selectedConfigOverrides={params.selectedConfigOverrides}
                selectedMachineId={params.selectedMachineId}
                capabilityServerId={params.capabilityServerId}
                cwd={params.selectedPath}
                settings={params.settings}
                refreshProbe={params.refreshProbe ?? null}
                onSelectFavoriteModel={params.onSelectFavoriteModel}
                onSelectFavoriteModelOptionValue={params.onSelectFavoriteModelOptionValue}
                onToggleFavoriteModel={params.onToggleFavoriteModel}
                onRemoveFavoriteModelSelection={params.onRemoveFavoriteModelSelection}
            />
        ),
    };
}
