import * as React from 'react';

import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import type { AgentInputChipPickerOption } from '@/components/sessions/agentInput/components/AgentInputChipPickerTypes';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { getAgentPickerIconScale } from '@/agents/registry/registryUi';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import type { NewSessionProfileAvailabilityReason } from '@/components/sessions/new/modules/newSessionAgentSelection';
import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import type { OptionPickerProbeState } from '@/components/sessions/pickers/OptionPickerOverlay';
import type { FavoriteModelSelectionV1 } from '@/sync/domains/models/favoriteModelSelections';
import type { Settings } from '@/sync/domains/settings/settings';
import type { NewSessionAgentPickerViewV1 } from '@/sync/domains/settings/registry/account/accountSessionCreationSettingDefinitions';
import type { SessionModelPickerExperimentalConfirmationController } from '@/components/sessions/modelPicker/SessionModelPicker';
import { t } from '@/text';

import type { NewSessionAgentPickerSelection } from './buildNewSessionAgentPickerDetailContent';
import { buildNewSessionAgentPickerOptionInteractions } from './buildNewSessionAgentPickerOptionInteractions';
import type { FavoriteModelTogglePayload } from './newSessionFavoriteModelsPickerOption';
import { resolveNewSessionAgentPickerOptionPresentation } from './resolveNewSessionAgentPickerOptionPresentation';

const ENGINE_FAVORITE_RAIL_ICON_SIZE = 14;

type BuildNewSessionAgentPickerResolvedOptionsParams = Readonly<{
    profileForAgentSelection: AIBackendProfile | null;
    compatibleBackendTargetKeys: ReadonlySet<string>;
    resolvedBackendEntries: readonly ResolvedBackendCatalogEntry[];
    isBackendEntrySelectable: (entry: ResolvedBackendCatalogEntry) => boolean;
    getBackendEntryUnavailabilityReason?: (entry: ResolvedBackendCatalogEntry) => NewSessionProfileAvailabilityReason | null;
    getEngineSelectionForTargetKey: (targetKey: string) => NewSessionAgentPickerSelection;
    selectEngineSelection: (entry: ResolvedBackendCatalogEntry, selection: NewSessionAgentPickerSelection) => void;
    selectedMachineId: string | null;
    capabilityServerId: string;
    selectedPath: string | null;
    settings: Settings;
    refreshProbe?: OptionPickerProbeState | null;
    favoriteModelSelections?: readonly FavoriteModelSelectionV1[];
    favoriteBackendTargetKeys?: ReadonlyArray<string>;
    onToggleFavoriteModel?: (entry: ResolvedBackendCatalogEntry, model: FavoriteModelTogglePayload) => void;
    onToggleFavoriteBackendTarget?: (targetKey: string) => void;
    onRememberAgentPickerView?: (view: NewSessionAgentPickerViewV1) => void;
    experimentalConfirmation?: SessionModelPickerExperimentalConfirmationController;
}>;

function EngineFavoritePickerIcon(props: Readonly<{ favorite: boolean }>) {
    const { theme } = useUnistyles();
    const selectedColor = theme.dark ? theme.colors.text.primary : theme.colors.button.primary.background;
    return (
        <Ionicons
            name={props.favorite ? 'star' : 'star-outline'}
            size={ENGINE_FAVORITE_RAIL_ICON_SIZE}
            color={props.favorite ? selectedColor : theme.colors.text.secondary}
        />
    );
}

export function buildNewSessionAgentPickerResolvedOptions(
    params: BuildNewSessionAgentPickerResolvedOptionsParams,
): ReadonlyArray<AgentInputChipPickerOption> {
    const favoriteBackendTargetKeySet = new Set(params.favoriteBackendTargetKeys ?? []);
    return params.resolvedBackendEntries.map((entry) => {
        const selectable = params.isBackendEntrySelectable(entry);
        const unavailabilityReason = selectable
            ? null
            : params.getBackendEntryUnavailabilityReason?.(entry) ?? null;
        const isFavoriteBackend = favoriteBackendTargetKeySet.has(entry.backendTargetKey);
        const { subtitle, disabled, muted } = resolveNewSessionAgentPickerOptionPresentation({
            entry,
            profileForAgentSelection: params.profileForAgentSelection,
            compatibleBackendTargetKeys: params.compatibleBackendTargetKeys,
            selectable,
            unavailabilityReason,
        });
        const displayAgentId = entry.iconAgentId ?? entry.catalogAgentId ?? entry.builtInAgentId;

        return {
            id: entry.backendTargetKey,
            label: entry.title,
            icon: displayAgentId ? (
                <AgentIcon
                    agentId={displayAgentId}
                    size={12}
                    style={{ transform: [{ scale: getAgentPickerIconScale(displayAgentId) }] }}
                />
            ) : <Ionicons name="layers-outline" size={14} />,
            subtitle,
            disabled,
            muted,
            railAction: params.onToggleFavoriteBackendTarget ? {
                testID: `new-session-engine-favorite-rail:${entry.backendTargetKey}`,
                accessibilityLabel: isFavoriteBackend ? t('profiles.actions.removeFromFavorites') : t('profiles.actions.addToFavorites'),
                selected: isFavoriteBackend,
                icon: <EngineFavoritePickerIcon favorite={isFavoriteBackend} />,
                onPress: () => {
                    params.onToggleFavoriteBackendTarget?.(entry.backendTargetKey);
                },
            } : undefined,
            ...buildNewSessionAgentPickerOptionInteractions({
                entry,
                disabled,
                selectedMachineId: params.selectedMachineId,
                capabilityServerId: params.capabilityServerId,
                selectedPath: params.selectedPath,
                settings: params.settings,
                refreshProbe: params.refreshProbe,
                favoriteModelSelections: params.favoriteModelSelections ?? [],
                onToggleFavoriteModel: params.onToggleFavoriteModel,
                favoriteEngine: params.onToggleFavoriteBackendTarget ? {
                    favorite: isFavoriteBackend,
                    onToggle: () => {
                        params.onToggleFavoriteBackendTarget?.(entry.backendTargetKey);
                    },
                } : undefined,
                experimentalConfirmation: params.experimentalConfirmation,
                onRememberAgentPickerView: params.onRememberAgentPickerView,
                getEngineSelectionForTargetKey: params.getEngineSelectionForTargetKey,
                selectEngineSelection: params.selectEngineSelection,
            }),
        };
    });
}
