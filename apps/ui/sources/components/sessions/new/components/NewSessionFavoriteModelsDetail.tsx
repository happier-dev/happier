import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { getAgentCore } from '@/agents/catalog/catalog';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { getAgentPickerIconScale } from '@/agents/registry/registryUi';
import { OptionPickerOverlay, type OptionPickerProbeState } from '@/components/sessions/pickers/OptionPickerOverlay';
import { mergeOptionPickerProbes } from '@/components/sessions/pickers/mergeOptionPickerProbes';
import { sanitizeNewSessionConfigOverridesForModelSelection } from '@/components/sessions/new/modules/newSessionConfigOptionOverrideSanitization';
import { useNewSessionPreflightModelsState } from '@/components/sessions/new/hooks/screenModel/useNewSessionPreflightModelsState';
import {
    resolveNewSessionCapabilityProbeContext,
} from '@/components/sessions/new/modules/newSessionCapabilityProbeContext';
import type { Settings } from '@/sync/domains/settings/settings';
import type { ConnectedServiceBindingsV1 } from '@happier-dev/protocol';
import { computeSessionConfigOptionControlsForProvider } from '@/sync/domains/sessionControl/configOptionsControl';
import type {
    SessionConfigOptionControl,
    SessionConfigOptionValueId,
} from '@/sync/domains/sessionControl/configOptionsControl';
import {
    buildFavoriteModelAvailabilityById,
    favoriteModelSelectionMatchesBackend,
    isFavoriteModelSelectableId,
    normalizeFavoriteModelId,
    resolveAvailableFavoriteModelsForBackend,
    type AvailableFavoriteModel,
    type FavoriteModelBackendIdentity,
    type FavoriteModelSelectionV1,
} from '@/sync/domains/models/favoriteModelSelections';
import { t } from '@/text';

type FavoriteModelTogglePayload = Readonly<{
    modelId: string;
    modelLabel: string;
}>;

type FavoriteModelOption = Readonly<{
    value: string;
    label: string;
    icon?: React.ReactNode;
    description: string;
}>;

type FavoriteModelSnapshot = Readonly<{
    entry: ResolvedBackendCatalogEntry;
    modelOptions: ReturnType<typeof useNewSessionPreflightModelsState>['modelOptions'];
    options: readonly FavoriteModelOption[];
    favoriteValues: readonly string[];
    availableValues: readonly string[];
    staleFavoriteByValue: ReadonlyMap<string, FavoriteModelSelectionV1>;
    modelByValue: ReadonlyMap<string, FavoriteModelTogglePayload & { modelId: string }>;
    selectedOptionControls: readonly SessionConfigOptionControl[] | null;
    selectedValue: string;
    selectedLabel?: string;
    probe: OptionPickerProbeState | null;
}>;

export type NewSessionFavoriteModelsDetailProps = Readonly<{
    favoriteModelSelections: readonly FavoriteModelSelectionV1[];
    resolvedBackendEntries: readonly ResolvedBackendCatalogEntry[];
    selectedBackendTargetKey: string;
    selectedModelId: string;
    selectedConfigOverrides?: Readonly<Record<string, string>>;
    selectedMachineId: string | null;
    capabilityServerId: string;
    cwd?: string | null;
    profileId?: string | null;
    settings: Settings;
    connectedServicesByTargetKey?: Readonly<Record<string, ConnectedServiceBindingsV1 | null | undefined>>;
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
        valueId: SessionConfigOptionValueId,
    ) => void;
    onToggleFavoriteModel: (entry: ResolvedBackendCatalogEntry, model: FavoriteModelTogglePayload) => void;
    onRemoveFavoriteModelSelection?: (favorite: FavoriteModelSelectionV1) => void;
}>;

function buildFavoriteBackendIdentity(entry: ResolvedBackendCatalogEntry): FavoriteModelBackendIdentity {
    return {
        backendTargetKey: entry.targetKey,
        providerAgentId: entry.providerAgentId,
        builtInAgentId: entry.builtInAgentId,
        configuredBackendId: entry.target.kind === 'configuredAcpBackend' ? entry.target.backendId : null,
    };
}

const FAVORITE_OPTION_VALUE_SEPARATOR = '\x1f';

function buildFavoriteOptionValue(entry: ResolvedBackendCatalogEntry, modelId: string): string {
    return `${entry.targetKey}${FAVORITE_OPTION_VALUE_SEPARATOR}${modelId}`;
}

function areStringArraysEqual(a: readonly string[], b: readonly string[]): boolean {
    if (a.length !== b.length) return false;
    for (let index = 0; index < a.length; index += 1) {
        if (a[index] !== b[index]) return false;
    }
    return true;
}

function areFavoriteModelMapsEqual(
    a: FavoriteModelSnapshot['modelByValue'],
    b: FavoriteModelSnapshot['modelByValue'],
): boolean {
    if (a.size !== b.size) return false;
    for (const [value, left] of a.entries()) {
        const right = b.get(value);
        if (!right) return false;
        if (left.modelId !== right.modelId || left.modelLabel !== right.modelLabel) return false;
    }
    return true;
}

function areFavoriteModelSnapshotsEqual(a: FavoriteModelSnapshot, b: FavoriteModelSnapshot): boolean {
    if (a.entry.targetKey !== b.entry.targetKey) return false;
    if (a.entry.iconAgentId !== b.entry.iconAgentId) return false;
    if (a.selectedValue !== b.selectedValue) return false;
    if (a.selectedLabel !== b.selectedLabel) return false;
    if (a.probe?.phase !== b.probe?.phase) return false;
    if (!areStringArraysEqual(a.favoriteValues, b.favoriteValues)) return false;
    if (!areStringArraysEqual(a.availableValues, b.availableValues)) return false;
    if (!areFavoriteModelMapsEqual(a.modelByValue, b.modelByValue)) return false;
    if ((a.selectedOptionControls?.length ?? 0) !== (b.selectedOptionControls?.length ?? 0)) return false;
    for (let index = 0; index < (a.selectedOptionControls?.length ?? 0); index += 1) {
        const left = a.selectedOptionControls?.[index];
        const right = b.selectedOptionControls?.[index];
        if (
            left?.option.id !== right?.option.id
            || left?.effectiveValue !== right?.effectiveValue
            || left?.requestedValue !== right?.requestedValue
        ) {
            return false;
        }
    }
    if (a.options.length !== b.options.length) return false;
    for (let index = 0; index < a.options.length; index += 1) {
        const left = a.options[index]!;
        const right = b.options[index]!;
        if (
            left.value !== right.value
            || left.label !== right.label
            || left.description !== right.description
        ) {
            return false;
        }
    }
    return true;
}

function renderFavoriteModelOptionIcon(entry: ResolvedBackendCatalogEntry): React.ReactNode {
    const agentId = entry.iconAgentId;
    return (
        <AgentIcon
            agentId={agentId}
            size={20}
            style={{ transform: [{ scale: getAgentPickerIconScale(agentId) }] }}
        />
    );
}

function FavoriteBackendModelsCollector(props: Readonly<{
    entry: ResolvedBackendCatalogEntry;
    favoriteModelSelections: readonly FavoriteModelSelectionV1[];
    selectedBackendTargetKey: string;
    selectedModelId: string;
    selectedConfigOverrides?: Readonly<Record<string, string>>;
    selectedMachineId: string | null;
    capabilityServerId: string;
    cwd?: string | null;
    profileId?: string | null;
    settings: Settings;
    connectedServices?: ConnectedServiceBindingsV1 | null;
    refreshProbe?: OptionPickerProbeState | null;
    onSnapshot: (targetKey: string, snapshot: FavoriteModelSnapshot) => void;
}>) {
    const backendIdentity = React.useMemo(() => buildFavoriteBackendIdentity(props.entry), [props.entry]);

    const capabilityProbeContext = React.useMemo(() => resolveNewSessionCapabilityProbeContext({
        backendTarget: props.entry.target,
        settings: props.settings,
    }), [props.entry.target, props.settings]);

    const { modelOptions, preflightModels, probe: modelProbe } = useNewSessionPreflightModelsState({
        backendTarget: props.entry.target,
        selectedMachineId: props.selectedMachineId,
        capabilityServerId: props.capabilityServerId,
        cwd: props.cwd ?? null,
        profileId: props.profileId ?? null,
        probeContext: capabilityProbeContext,
        connectedServices: props.connectedServices ?? null,
    });

    const providerCore = React.useMemo(() => getAgentCore(props.entry.providerAgentId), [props.entry.providerAgentId]);
    const availabilityById = React.useMemo(() => buildFavoriteModelAvailabilityById({
        mode: providerCore.model.dynamicProbe === 'static-only' ? 'static-only' : 'dynamic',
        modelOptions,
        preflightModels,
    }), [modelOptions, preflightModels, providerCore.model.dynamicProbe]);

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

    const provisionalFavorites = React.useMemo((): readonly AvailableFavoriteModel[] => {
        const hasResolvedDynamicModels = (preflightModels?.availableModels.length ?? 0) > 0;
        const canUseProvisionalFavorites = providerCore.model.dynamicProbe !== 'static-only'
            && !hasResolvedDynamicModels
            && modelProbe.phase !== 'idle';
        if (!canUseProvisionalFavorites) return [];

        const availableIds = new Set(availableFavorites.map((model) => model.modelId));
        const seen = new Set<string>(availableIds);
        const out: AvailableFavoriteModel[] = [];
        for (const favorite of matchingFavorites) {
            const modelId = normalizeFavoriteModelId(favorite.modelId);
            if (!isFavoriteModelSelectableId(modelId) || seen.has(modelId)) continue;
            seen.add(modelId);
            out.push({
                modelId,
                modelLabel: favorite.modelLabel || modelId,
                modelDescription: '',
                backendLabel: props.entry.title,
            });
        }
        return out;
    }, [availableFavorites, matchingFavorites, modelProbe.phase, preflightModels?.availableModels.length, props.entry.title, providerCore.model.dynamicProbe]);

    const selectableFavorites = React.useMemo(() => (
        provisionalFavorites.length > 0 ? [...availableFavorites, ...provisionalFavorites] : availableFavorites
    ), [availableFavorites, provisionalFavorites]);

    const staleFavorites = React.useMemo(() => {
        const availableIds = new Set(selectableFavorites.map((model) => model.modelId));
        const seen = new Set<string>();
        const out: FavoriteModelSelectionV1[] = [];
        for (const favorite of matchingFavorites) {
            const modelId = normalizeFavoriteModelId(favorite.modelId);
            if (!isFavoriteModelSelectableId(modelId) || availableIds.has(modelId) || seen.has(modelId)) continue;
            seen.add(modelId);
            out.push(favorite);
        }
        return out;
    }, [matchingFavorites, selectableFavorites]);

    const options = React.useMemo(() => [
        ...selectableFavorites.map((model) => ({
            value: buildFavoriteOptionValue(props.entry, model.modelId),
            label: model.modelLabel,
            icon: renderFavoriteModelOptionIcon(props.entry),
            description: model.backendLabel ?? props.entry.title,
        })),
        ...staleFavorites.map((favorite) => {
            const modelId = normalizeFavoriteModelId(favorite.modelId);
            return {
                value: buildFavoriteOptionValue(props.entry, modelId),
                label: favorite.modelLabel || modelId,
                icon: renderFavoriteModelOptionIcon(props.entry),
                description: props.entry.title,
            };
        }),
    ], [props.entry, selectableFavorites, staleFavorites]);

    const favoriteValues = React.useMemo(() => options.map((option) => option.value), [options]);
    const availableValues = React.useMemo(() => selectableFavorites.map((model) => (
        buildFavoriteOptionValue(props.entry, model.modelId)
    )), [props.entry, selectableFavorites]);
    const staleFavoriteByValue = React.useMemo(() => new Map(staleFavorites.map((favorite) => {
        const modelId = normalizeFavoriteModelId(favorite.modelId);
        return [buildFavoriteOptionValue(props.entry, modelId), favorite] as const;
    })), [props.entry, staleFavorites]);
    const modelByValue = React.useMemo(() => new Map(selectableFavorites.map((model) => [
        buildFavoriteOptionValue(props.entry, model.modelId),
        {
            modelId: model.modelId,
            modelLabel: model.modelLabel,
        },
    ] as const)), [props.entry, selectableFavorites]);
    const modelOptionByValue = React.useMemo(() => new Map(selectableFavorites.flatMap((model) => {
        const option = modelOptions.find((candidate) => candidate.value === model.modelId) ?? null;
        return option ? [[buildFavoriteOptionValue(props.entry, model.modelId), option] as const] : [];
    })), [modelOptions, props.entry, selectableFavorites]);

    const selectedValue = props.selectedBackendTargetKey === props.entry.targetKey
        ? buildFavoriteOptionValue(props.entry, props.selectedModelId)
        : '';
    const selectedOption = options.find((option) => option.value === selectedValue) ?? null;
    const selectedOptionControls = React.useMemo(() => {
        const selectedModelOption = modelOptionByValue.get(selectedValue) ?? null;
        if (!selectedModelOption?.modelOptions?.length) return null;
        return computeSessionConfigOptionControlsForProvider({
            providerId:
                props.entry.target.kind === 'configuredAcpBackend'
                    ? props.entry.target.backendId
                    : props.entry.target.agentId,
            configOptions: selectedModelOption.modelOptions,
            overrides: Object.fromEntries(
                Object.entries(props.selectedConfigOverrides ?? {}).map(([optionId, value]) => [optionId, { value }]),
            ),
        }) ?? null;
    }, [
        modelOptionByValue,
        props.entry.target,
        props.selectedConfigOverrides,
        selectedValue,
    ]);
    const unifiedProbe = React.useMemo(() => mergeOptionPickerProbes([
        props.refreshProbe ?? null,
        modelProbe ?? null,
    ]), [modelProbe, props.refreshProbe]);

    React.useEffect(() => {
        props.onSnapshot(props.entry.targetKey, {
            entry: props.entry,
            modelOptions,
            options,
            favoriteValues,
            availableValues,
            staleFavoriteByValue,
            modelByValue,
            selectedOptionControls,
            selectedValue,
            ...(selectedOption?.label ? { selectedLabel: selectedOption.label } : {}),
            probe: unifiedProbe ?? null,
        });
    }, [
        availableValues,
        favoriteValues,
        modelByValue,
        modelOptions,
        options,
        props,
        selectedOptionControls,
        selectedOption?.label,
        selectedValue,
        staleFavoriteByValue,
        unifiedProbe,
    ]);

    return null;
}

export function NewSessionFavoriteModelsDetail(props: NewSessionFavoriteModelsDetailProps) {
    const favoriteBackendEntries = React.useMemo(() => props.resolvedBackendEntries.filter((entry) => {
        const backendIdentity = buildFavoriteBackendIdentity(entry);
        return props.favoriteModelSelections.some((favorite) => favoriteModelSelectionMatchesBackend(favorite, backendIdentity));
    }), [props.favoriteModelSelections, props.resolvedBackendEntries]);

    const [snapshotsByTargetKey, setSnapshotsByTargetKey] = React.useState<ReadonlyMap<string, FavoriteModelSnapshot>>(() => new Map());

    React.useEffect(() => {
        const allowedTargetKeys = new Set(favoriteBackendEntries.map((entry) => entry.targetKey));
        setSnapshotsByTargetKey((current) => {
            let changed = false;
            const next = new Map<string, FavoriteModelSnapshot>();
            for (const [targetKey, snapshot] of current) {
                if (!allowedTargetKeys.has(targetKey)) {
                    changed = true;
                    continue;
                }
                next.set(targetKey, snapshot);
            }
            return changed ? next : current;
        });
    }, [favoriteBackendEntries]);

    const handleSnapshot = React.useCallback((targetKey: string, snapshot: FavoriteModelSnapshot) => {
        setSnapshotsByTargetKey((current) => {
            const existing = current.get(targetKey);
            if (existing && areFavoriteModelSnapshotsEqual(existing, snapshot)) {
                return current;
            }
            const next = new Map(current);
            next.set(targetKey, snapshot);
            return next;
        });
    }, []);

    const orderedSnapshots = React.useMemo(() => favoriteBackendEntries
        .map((entry) => snapshotsByTargetKey.get(entry.targetKey) ?? null)
        .filter((snapshot): snapshot is FavoriteModelSnapshot => Boolean(snapshot)), [
        favoriteBackendEntries,
        snapshotsByTargetKey,
    ]);
    const options = React.useMemo(() => orderedSnapshots.flatMap((snapshot) => snapshot.options), [orderedSnapshots]);
    const favoriteValues = React.useMemo(() => new Set(orderedSnapshots.flatMap((snapshot) => snapshot.favoriteValues)), [orderedSnapshots]);
    const availableValues = React.useMemo(() => new Set(orderedSnapshots.flatMap((snapshot) => snapshot.availableValues)), [orderedSnapshots]);
    const selectedSnapshot = orderedSnapshots.find((snapshot) => snapshot.selectedValue.length > 0) ?? null;
    const selectedValue = selectedSnapshot?.selectedValue ?? '';
    const unifiedProbe = React.useMemo(() => mergeOptionPickerProbes([
        props.refreshProbe ?? null,
        ...orderedSnapshots.map((snapshot) => snapshot.probe),
    ]), [orderedSnapshots, props.refreshProbe]);
    const snapshotByOptionValue = React.useMemo(() => {
        const out = new Map<string, FavoriteModelSnapshot>();
        for (const snapshot of orderedSnapshots) {
            for (const option of snapshot.options) {
                out.set(option.value, snapshot);
            }
        }
        return out;
    }, [orderedSnapshots]);

    return (
        <View style={styles.container}>
            {favoriteBackendEntries.map((entry) => (
                <FavoriteBackendModelsCollector
                    key={entry.targetKey}
                    entry={entry}
                    favoriteModelSelections={props.favoriteModelSelections}
                    selectedBackendTargetKey={props.selectedBackendTargetKey}
                    selectedModelId={props.selectedModelId}
                    selectedConfigOverrides={props.selectedConfigOverrides}
                    selectedMachineId={props.selectedMachineId}
                    capabilityServerId={props.capabilityServerId}
                    cwd={props.cwd}
                    profileId={props.profileId}
                    settings={props.settings}
                    connectedServices={props.connectedServicesByTargetKey?.[entry.targetKey] ?? null}
                    refreshProbe={props.refreshProbe}
                    onSnapshot={handleSnapshot}
                />
            ))}
            {options.length > 0 || unifiedProbe?.phase !== 'idle' ? (
                <OptionPickerOverlay
                    title={t('profiles.groups.favorites')}
                    effectiveLabel={selectedSnapshot?.selectedLabel}
                    notes={[]}
                    options={options}
                    selectedValue={selectedValue}
                    emptyText={t('agentInput.model.configureInCli')}
                    canEnterCustomValue={false}
                    optionTestIDPrefix="new-session-favorite-model-option"
                    refreshTestID="new-session-favorite-model-refresh"
                    probe={unifiedProbe ?? undefined}
                    selectedOptionControls={selectedSnapshot?.selectedOptionControls ?? undefined}
                    onSelectOptionControlValue={(configId, valueId) => {
                        if (!selectedSnapshot || selectedValue.length === 0) return;
                        const model = selectedSnapshot.modelByValue.get(selectedValue);
                        if (!model) return;
                        props.onSelectFavoriteModelOptionValue?.(
                            selectedSnapshot.entry,
                            model.modelId,
                            configId,
                            valueId,
                        );
                    }}
                    favoriteOptions={{
                        values: favoriteValues,
                        isFavoritable: (option) => favoriteValues.has(option.value) || availableValues.has(option.value),
                        onToggle: (option) => {
                            const snapshot = snapshotByOptionValue.get(option.value);
                            if (!snapshot) return;
                            const staleFavorite = snapshot.staleFavoriteByValue.get(option.value);
                            if (staleFavorite) {
                                props.onRemoveFavoriteModelSelection?.(staleFavorite);
                                return;
                            }
                            const model = snapshot.modelByValue.get(option.value);
                            if (!model) return;
                            props.onToggleFavoriteModel(snapshot.entry, model);
                        },
                    }}
                    onSelect={(value) => {
                        const snapshot = snapshotByOptionValue.get(value);
                        const model = snapshot?.modelByValue.get(value);
                        if (!snapshot || !model || !availableValues.has(value)) return;
                        const providerId = snapshot.entry.target.kind === 'configuredAcpBackend'
                            ? snapshot.entry.target.backendId
                            : snapshot.entry.target.agentId;
                        props.onSelectFavoriteModel(
                            snapshot.entry,
                            model.modelId,
                            sanitizeNewSessionConfigOverridesForModelSelection({
                                providerId,
                                configOptions: null,
                                modelOptions: snapshot.modelOptions,
                                selectedModelId: model.modelId,
                                selectedConfigOverrides: props.selectedConfigOverrides ?? {},
                            }),
                        );
                    }}
                />
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create(() => ({
    container: {
        gap: 12,
    },
}));
