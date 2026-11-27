import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import type { AgentInputChipPickerOption } from '@/components/sessions/agentInput/components/AgentInputChipPickerTypes';
import { NewSessionFavoriteModelsDetail, type NewSessionFavoriteModelsDetailProps } from '@/components/sessions/new/components/NewSessionFavoriteModelsDetail';
import type { OptionPickerProbeState } from '@/components/sessions/pickers/OptionPickerOverlay';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import type { NewSessionAgentPickerViewV1 } from '@/sync/domains/state/newSessionInteractionSchemas';
import { deferAgentInputPopoverClose } from '@/components/sessions/agentInput/selection/deferAgentInputPopoverClose';
import type { SessionModelSelectionV1 } from '@happier-dev/protocol/providers/selection/v1';
import {
    favoriteModelSelectionMatchesBackend,
    type FavoriteProviderDisplaySnapshot,
    type FavoriteModelSelectionV1,
} from '@/sync/domains/models/favoriteModelSelections';
import { buildFavoriteBackendIdentity } from '@/sync/domains/models/favoriteModelBackendIdentity';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';
import { useAgentUiSettings } from '@/agents/catalog/useAgentUiSettings';

export const FAVORITE_MODELS_AGENT_PICKER_OPTION_ID = 'favorite-models';

export type FavoriteModelTogglePayload = Readonly<{
    modelId: string;
    modelLabel: string;
    modelSelection?: FavoriteModelSelectionV1['selection'];
    providerDisplaySnapshot?: FavoriteProviderDisplaySnapshot;
    reasoningEffort?: FavoriteModelSelectionV1['reasoningEffort'];
}>;

function NewSessionFavoriteModelsPickerDetail(props: Omit<NewSessionFavoriteModelsDetailProps, 'settings'>) {
    const detail = props;
    const settings = useAgentUiSettings({ agentIds: props.resolvedBackendEntries.map(entry => entry.agentId),
        machineId: props.selectedMachineId, domain: 'runtime' });
    return <NewSessionFavoriteModelsDetail {...detail} settings={settings} />;
}

function FavoriteModelsPickerIcon(props: Readonly<{ size?: number }>) {
    const { theme } = useUnistyles();
    return (
        <Icon
            name="star"
            size={props.size ?? 12}
            color={theme.dark ? theme.colors.text.primary : theme.colors.button.primary.background}
            weight={theme.dark ? 'fill' : 'regular'}
        />
    );
}

export function buildNewSessionFavoriteModelsPickerOption(params: Readonly<{
    favoriteModelSelections: readonly FavoriteModelSelectionV1[];
    resolvedBackendEntries: readonly ResolvedBackendCatalogEntry[];
    compatibleBackendTargetKeys: ReadonlySet<string>;
    selectedBackendTargetKey: string;
    selectedModelId: string;
    selectedModelSelection?: NewSessionFavoriteModelsDetailProps['selectedModelSelection'];
    selectedConfigOverrides?: Readonly<Record<string, string>>;
    selectedMachineId: string | null;
    capabilityServerId: string;
    projectionCurrent: boolean;
    selectedPath: string | null;
    refreshProbe?: OptionPickerProbeState | null;
    onSelectFavoriteModel: (
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
    onToggleFavoriteModel: (entry: ResolvedBackendCatalogEntry, model: FavoriteModelTogglePayload) => void;
    onUpdateFavoriteModelReasoningEffort?: NewSessionFavoriteModelsDetailProps['onUpdateFavoriteModelReasoningEffort'];
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
        view: true,
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
        renderDetailContent: ({ onRequestClose }) => (
            <NewSessionFavoriteModelsPickerDetail
                favoriteModelSelections={params.favoriteModelSelections}
                resolvedBackendEntries={compatibleResolvedBackendEntries}
                selectedBackendTargetKey={params.selectedBackendTargetKey}
                selectedModelId={params.selectedModelId}
                selectedModelSelection={params.selectedModelSelection}
                selectedConfigOverrides={params.selectedConfigOverrides}
                selectedMachineId={params.selectedMachineId}
                capabilityServerId={params.capabilityServerId}
                projectionCurrent={params.projectionCurrent}
                cwd={params.selectedPath}
                refreshProbe={params.refreshProbe ?? null}
                onSelectFavoriteModel={(entry, modelSelection, configOverrides) => {
                    params.onSelectFavoriteModel(entry, modelSelection, configOverrides);
                    deferAgentInputPopoverClose(onRequestClose);
                }}
                onSelectFavoriteModelOptionValue={params.onSelectFavoriteModelOptionValue}
                onUpdateFavoriteModelReasoningEffort={params.onUpdateFavoriteModelReasoningEffort}
                onToggleFavoriteModel={params.onToggleFavoriteModel}
                onRemoveFavoriteModelSelection={params.onRemoveFavoriteModelSelection}
            />
        ),
    };
}
