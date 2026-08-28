import * as React from 'react';

import { useUnistyles } from 'react-native-unistyles';

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
import { Icon } from '@/components/ui/icons/Icon';
import { t } from '@/text';
import { buildSessionAgentPickerOptions } from '@/components/sessions/agentPicker/buildSessionAgentPickerOptions';
import type { SessionAgentPickerSelection } from '@/components/sessions/agentPicker/buildSessionAgentPickerDetailContent';
import { buildNewSessionAgentPickerOptionInteractions } from './buildNewSessionAgentPickerOptionInteractions';
import {
    buildNewSessionFavoriteModelsPickerOption,
    type FavoriteModelTogglePayload,
} from './newSessionFavoriteModelsPickerOption';
import { resolveNewSessionAgentPickerOptionPresentation } from './resolveNewSessionAgentPickerOptionPresentation';
import { resolveNewSessionAgentPickerSelectionContext } from './resolveNewSessionAgentPickerSelectionContext';

const ENGINE_FAVORITE_RAIL_ICON_SIZE = 14;

type BuildNewSessionAgentPickerOptionsParams = Readonly<{
    useProfiles: boolean;
    selectedProfileId: string | null;
    profileMap: ReadonlyMap<string, AIBackendProfile>;
    resolvedBackendEntries: readonly ResolvedBackendCatalogEntry[];
    getCompatibleProfileBackendEntries: (profile: AIBackendProfile) => readonly ResolvedBackendCatalogEntry[];
    isBackendEntrySelectable: (entry: ResolvedBackendCatalogEntry) => boolean;
    getBackendEntryUnavailabilityReason?: (entry: ResolvedBackendCatalogEntry) => NewSessionProfileAvailabilityReason | null;
    getEngineSelectionForTargetKey: (targetKey: string) => SessionAgentPickerSelection;
    selectEngineSelection: (entry: ResolvedBackendCatalogEntry, selection: SessionAgentPickerSelection) => void;
    selectedMachineId: string | null;
    capabilityServerId: string;
    projectionCurrent: boolean;
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

function EngineFavoritePickerIcon(props: Readonly<{ favorite: boolean }>) {
    const { theme } = useUnistyles();
    const selectedColor = theme.dark ? theme.colors.text.primary : theme.colors.button.primary.background;
    return (
        <Icon
            name="star"
            size={ENGINE_FAVORITE_RAIL_ICON_SIZE}
            color={props.favorite ? selectedColor : theme.colors.text.secondary}
            weight={props.favorite ? 'fill' : 'regular'}
        />
    );
}

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
            projectionCurrent: params.projectionCurrent,
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
        agentPickerOptions: buildSessionAgentPickerOptions({
            entries: sessionCapableBackendEntries,
            identityScope: {
                machineId: params.selectedMachineId,
                serverId: params.capabilityServerId,
                current: params.projectionCurrent,
            },
            favoriteBackendTargetKeys: params.favoriteBackendTargetKeys ?? [],
            leadingOptions: favoriteOption ? [favoriteOption] : [],
            resolvePresentation: (entry) => {
                const selectable = params.isBackendEntrySelectable(entry);
                return resolveNewSessionAgentPickerOptionPresentation({
                    entry,
                    profileForAgentSelection,
                    compatibleBackendTargetKeys,
                    selectable,
                    unavailabilityReason: selectable
                        ? null
                        : params.getBackendEntryUnavailabilityReason?.(entry) ?? null,
                });
            },
            resolveRailAction: ({ entry, favorite }) => (params.onToggleFavoriteBackendTarget ? {
                testID: `new-session-engine-favorite-rail:${entry.backendTargetKey}`,
                accessibilityLabel: favorite
                    ? t('profiles.actions.removeFromFavorites')
                    : t('profiles.actions.addToFavorites'),
                selected: favorite,
                icon: <EngineFavoritePickerIcon favorite={favorite} />,
                onPress: () => {
                    params.onToggleFavoriteBackendTarget?.(entry.backendTargetKey);
                },
            } : undefined),
            resolveBehavior: ({ entry, presentation, favorite }) => buildNewSessionAgentPickerOptionInteractions({
                entry,
                disabled: presentation.disabled,
                selectedMachineId: params.selectedMachineId,
                capabilityServerId: params.capabilityServerId,
                selectedPath: params.selectedPath,
                settings: params.settings,
                refreshProbe: params.refreshProbe,
                favoriteModelSelections: params.favoriteModelSelections ?? [],
                onToggleFavoriteModel: params.onToggleFavoriteModel,
                favoriteEngine: params.onToggleFavoriteBackendTarget ? {
                    favorite,
                    onToggle: () => {
                        params.onToggleFavoriteBackendTarget?.(entry.backendTargetKey);
                    },
                } : undefined,
                experimentalConfirmation: params.experimentalConfirmation,
                onRememberAgentPickerView: params.onRememberAgentPickerView,
                getEngineSelectionForTargetKey: params.getEngineSelectionForTargetKey,
                selectEngineSelection: params.selectEngineSelection,
            }),
        }),
        selectableBackendEntries,
    };
}
