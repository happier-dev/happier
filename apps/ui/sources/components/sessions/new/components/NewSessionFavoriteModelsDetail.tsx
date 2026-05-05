import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { formatBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { getAgentCore } from '@/agents/catalog/catalog';
import { OptionPickerOverlay, type OptionPickerProbeState } from '@/components/sessions/pickers/OptionPickerOverlay';
import { mergeOptionPickerProbes } from '@/components/sessions/pickers/mergeOptionPickerProbes';
import { useNewSessionPreflightModelsState } from '@/components/sessions/new/hooks/screenModel/useNewSessionPreflightModelsState';
import {
    resolveNewSessionCapabilityProbeContext,
} from '@/components/sessions/new/modules/newSessionCapabilityProbeContext';
import type { Settings } from '@/sync/domains/settings/settings';
import {
    buildFavoriteModelAvailabilityById,
    favoriteModelSelectionMatchesBackend,
    isFavoriteModelSelectableId,
    normalizeFavoriteModelId,
    resolveAvailableFavoriteModelsForBackend,
    type FavoriteModelBackendIdentity,
    type FavoriteModelSelectionV1,
} from '@/sync/domains/models/favoriteModelSelections';
import { t } from '@/text';

type FavoriteModelTogglePayload = Readonly<{
    modelId: string;
    modelLabel: string;
}>;

export type NewSessionFavoriteModelsDetailProps = Readonly<{
    favoriteModelSelections: readonly FavoriteModelSelectionV1[];
    resolvedBackendEntries: readonly ResolvedBackendCatalogEntry[];
    selectedBackendTargetKey: string;
    selectedModelId: string;
    selectedMachineId: string | null;
    capabilityServerId: string;
    cwd?: string | null;
    settings: Settings;
    refreshProbe?: OptionPickerProbeState | null;
    onSelectFavoriteModel: (entry: ResolvedBackendCatalogEntry, modelId: string) => void;
    onToggleFavoriteModel: (entry: ResolvedBackendCatalogEntry, model: FavoriteModelTogglePayload) => void;
    onRemoveFavoriteModelSelection?: (favorite: FavoriteModelSelectionV1) => void;
}>;

function buildFavoriteBackendIdentity(entry: ResolvedBackendCatalogEntry): FavoriteModelBackendIdentity {
    return {
        backendTargetKey: entry.backendTargetKey,
        providerAgentId: entry.providerAgentId,
        builtInAgentId: entry.builtInAgentId,
        configuredBackendId: entry.backendTarget.configuredBackendId ?? null,
    };
}

function FavoriteBackendModelsSection(props: Readonly<{
    entry: ResolvedBackendCatalogEntry;
    favoriteModelSelections: readonly FavoriteModelSelectionV1[];
    selectedBackendTargetKey: string;
    selectedModelId: string;
    selectedMachineId: string | null;
    capabilityServerId: string;
    cwd?: string | null;
    settings: Settings;
    refreshProbe?: OptionPickerProbeState | null;
    onSelectFavoriteModel: (entry: ResolvedBackendCatalogEntry, modelId: string) => void;
    onToggleFavoriteModel: (entry: ResolvedBackendCatalogEntry, model: FavoriteModelTogglePayload) => void;
    onRemoveFavoriteModelSelection?: (favorite: FavoriteModelSelectionV1) => void;
}>) {
    const backendIdentity = React.useMemo(() => buildFavoriteBackendIdentity(props.entry), [props.entry]);
    const capabilityProbeContext = React.useMemo(() => resolveNewSessionCapabilityProbeContext({
        backendTarget: props.entry.backendTarget,
        settings: props.settings,
    }), [props.entry.backendTarget, props.settings]);

    const { modelOptions, preflightModels, probe: modelProbe } = useNewSessionPreflightModelsState({
        backendTarget: props.entry.backendTarget,
        selectedMachineId: props.selectedMachineId,
        capabilityServerId: props.capabilityServerId,
        cwd: props.cwd ?? null,
        probeContext: capabilityProbeContext,
    });

    const providerCore = React.useMemo(() => (
        props.entry.providerAgentId ? getAgentCore(props.entry.providerAgentId) : null
    ), [props.entry.providerAgentId]);
    const availabilityById = React.useMemo(() => buildFavoriteModelAvailabilityById({
        mode: providerCore?.model.dynamicProbe === 'static-only' ? 'static-only' : 'dynamic',
        modelOptions,
        preflightModels,
    }), [modelOptions, preflightModels, providerCore?.model.dynamicProbe]);

    const availableFavorites = React.useMemo(() => resolveAvailableFavoriteModelsForBackend({
        favorites: props.favoriteModelSelections,
        backend: backendIdentity,
        availabilityById,
        backendLabel: props.entry.title,
    }), [
        availabilityById,
        backendIdentity,
        props.entry.title,
        props.favoriteModelSelections,
    ]);

    const matchingFavorites = React.useMemo(() => props.favoriteModelSelections.filter((favorite) => (
        favoriteModelSelectionMatchesBackend(favorite, backendIdentity)
    )), [backendIdentity, props.favoriteModelSelections]);

    const staleFavorites = React.useMemo(() => {
        const availableIds = new Set(availableFavorites.map((model) => model.modelId));
        const seen = new Set<string>();
        const out: FavoriteModelSelectionV1[] = [];
        for (const favorite of matchingFavorites) {
            const modelId = normalizeFavoriteModelId(favorite.modelId);
            if (!isFavoriteModelSelectableId(modelId) || availableIds.has(modelId) || seen.has(modelId)) continue;
            seen.add(modelId);
            out.push(favorite);
        }
        return out;
    }, [availableFavorites, matchingFavorites]);

    const favoriteModelValues = React.useMemo(
        () => new Set([
            ...availableFavorites.map((model) => model.modelId),
            ...staleFavorites.map((favorite) => normalizeFavoriteModelId(favorite.modelId)),
        ]),
        [availableFavorites, staleFavorites],
    );

    const options = React.useMemo(() => [
        ...availableFavorites.map((model) => ({
            value: model.modelId,
            label: model.modelLabel,
            description: model.modelDescription,
        })),
        ...staleFavorites.map((favorite) => {
            const modelId = normalizeFavoriteModelId(favorite.modelId);
            return {
                value: modelId,
                label: favorite.modelLabel || modelId,
                description: t('agentInput.model.configureInCli'),
            };
        }),
    ], [availableFavorites, staleFavorites]);

    const selectedValue = props.selectedBackendTargetKey === props.entry.backendTargetKey
        ? props.selectedModelId
        : '';
    const selectedOption = options.find((option) => option.value === selectedValue) ?? null;
    const unifiedProbe = React.useMemo(() => mergeOptionPickerProbes([
        props.refreshProbe ?? null,
        modelProbe ?? null,
    ]), [modelProbe, props.refreshProbe]);

    if (options.length === 0 && unifiedProbe?.phase === 'idle') {
        return null;
    }

    return (
        <OptionPickerOverlay
            title={props.entry.title}
            effectiveLabel={selectedOption?.label}
            notes={[]}
            options={options}
            selectedValue={selectedValue}
            emptyText={t('agentInput.model.configureInCli')}
            canEnterCustomValue={false}
            optionTestIDPrefix={`new-session-favorite-model-option:${props.entry.backendTargetKey}`}
            refreshTestID={`new-session-favorite-model-refresh:${props.entry.backendTargetKey}`}
            probe={unifiedProbe ?? undefined}
            favoriteOptions={{
                values: favoriteModelValues,
                isFavoritable: (option) => favoriteModelValues.has(option.value) || availabilityById.has(option.value),
                onToggle: (option) => {
                    const staleFavorite = staleFavorites.find((favorite) => (
                        normalizeFavoriteModelId(favorite.modelId) === option.value
                    ));
                    if (staleFavorite) {
                        props.onRemoveFavoriteModelSelection?.(staleFavorite);
                        return;
                    }
                    props.onToggleFavoriteModel(props.entry, {
                        modelId: option.value,
                        modelLabel: option.label,
                    });
                },
            }}
            onSelect={(modelId) => {
                if (!availabilityById.has(modelId)) return;
                props.onSelectFavoriteModel(props.entry, modelId);
            }}
        />
    );
}

export function NewSessionFavoriteModelsDetail(props: NewSessionFavoriteModelsDetailProps) {
    const favoriteBackendEntries = React.useMemo(() => props.resolvedBackendEntries.filter((entry) => {
        const backendIdentity = buildFavoriteBackendIdentity(entry);
        return props.favoriteModelSelections.some((favorite) => favoriteModelSelectionMatchesBackend(favorite, backendIdentity));
    }), [props.favoriteModelSelections, props.resolvedBackendEntries]);

    return (
        <View style={styles.container}>
            {favoriteBackendEntries.map((entry) => (
                <FavoriteBackendModelsSection
                    key={formatBackendTargetKeyV2(entry.backendTarget)}
                    entry={entry}
                    favoriteModelSelections={props.favoriteModelSelections}
                    selectedBackendTargetKey={props.selectedBackendTargetKey}
                    selectedModelId={props.selectedModelId}
                    selectedMachineId={props.selectedMachineId}
                    capabilityServerId={props.capabilityServerId}
                    cwd={props.cwd}
                    settings={props.settings}
                    refreshProbe={props.refreshProbe}
                    onSelectFavoriteModel={props.onSelectFavoriteModel}
                    onToggleFavoriteModel={props.onToggleFavoriteModel}
                    onRemoveFavoriteModelSelection={props.onRemoveFavoriteModelSelection}
                />
            ))}
        </View>
    );
}

const styles = StyleSheet.create(() => ({
    container: {
        gap: 12,
    },
}));
