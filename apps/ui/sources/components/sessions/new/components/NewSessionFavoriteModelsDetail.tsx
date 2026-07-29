import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { formatBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { getAgentCore } from '@/agents/catalog/catalog';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { getAgentPickerIconScale } from '@/agents/registry/registryUi';
import {
    OptionPickerOverlay,
    type OptionPickerFavoriteOptions,
    type OptionPickerProbeState,
} from '@/components/sessions/pickers/OptionPickerOverlay';
import { mergeOptionPickerProbes } from '@/components/sessions/pickers/mergeOptionPickerProbes';
import { sanitizeNewSessionConfigOverridesForModelSelection } from '@/components/sessions/new/modules/newSessionConfigOptionOverrideSanitization';
import {
    buildSessionModelPickerSections,
    hiddenModelVisibilityKeys,
} from '@/components/sessions/modelPicker/buildSessionModelPickerSections';
import { useNewSessionPreflightModelsState } from '@/components/sessions/new/hooks/screenModel/useNewSessionPreflightModelsState';
import {
    resolveNewSessionCapabilityProbeContext,
} from '@/components/sessions/new/modules/newSessionCapabilityProbeContext';
import { computeAcpConfigOptionControlsForProvider } from '@/sync/domains/sessionControl/configOptionsControl';
import type { Settings } from '@/sync/domains/settings/settings';
import {
    readProviderSettingsFromAccountSettingsV1,
    serializeModelVisibilityRefV1,
    type SessionModelSelectionV1,
} from '@happier-dev/protocol';
import type {
    SessionConfigOptionControl,
    SessionConfigOptionValueId,
} from '@/sync/domains/sessionControl/configOptionsControl';
import {
    buildFavoriteModelAvailabilityById,
    favoriteModelSelectionMatchesBackend,
    getFavoriteModelRef,
    isFavoriteModelSelectableId,
    normalizeFavoriteModelId,
    resolveAvailableFavoriteModelsForBackend,
    type AvailableFavoriteModel,
    type FavoriteModelAvailability,
    type FavoriteModelSelectionV1,
} from '@/sync/domains/models/favoriteModelSelections';
import { buildFavoriteBackendIdentity } from '@/sync/domains/models/favoriteModelBackendIdentity';
import { t } from '@/text';
import { sessionModelSelectionKey } from '@/components/sessions/modelPicker/sessionModelSelectionKey';
import { useProviderModelProjection } from '@/providers/hooks/useProviderModelProjection';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';

type FavoriteModelTogglePayload = Readonly<{
    modelId: string;
    modelLabel: string;
}>;

type FavoriteModelOption = Readonly<{
    value: string;
    label: string;
    icon?: React.ReactNode;
    description: string;
    accessibilityLabel?: string;
}>;

type FavoriteModelSnapshot = Readonly<{
    entry: ResolvedBackendCatalogEntry;
    modelOptions: ReturnType<typeof useNewSessionPreflightModelsState>['modelOptions'];
    options: readonly FavoriteModelOption[];
    favoriteValues: readonly string[];
    availableValues: readonly string[];
    staleFavoriteByValue: ReadonlyMap<string, FavoriteModelSelectionV1>;
    modelByValue: ReadonlyMap<string, FavoriteModelTogglePayload & {
        modelId: string;
        modelSelection: SessionModelSelectionV1;
    }>;
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
    selectedModelSelection?: SessionModelSelectionV1 | null;
    selectedConfigOverrides?: Readonly<Record<string, string>>;
    selectedMachineId: string | null;
    capabilityServerId: string;
    cwd?: string | null;
    settings: Settings;
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
        valueId: SessionConfigOptionValueId,
    ) => void;
    onToggleFavoriteModel: (entry: ResolvedBackendCatalogEntry, model: FavoriteModelTogglePayload) => void;
    onRemoveFavoriteModelSelection?: (favorite: FavoriteModelSelectionV1) => void;
}>;

function buildFavoriteOptionValue(modelSelection: SessionModelSelectionV1): string {
    return sessionModelSelectionKey(modelSelection.ref);
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
    if (a.entry.backendTargetKey !== b.entry.backendTargetKey) return false;
    if (a.entry.iconAgentId !== b.entry.iconAgentId) return false;
    if (a.entry.catalogAgentId !== b.entry.catalogAgentId) return false;
    if (a.entry.builtInAgentId !== b.entry.builtInAgentId) return false;
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
            || left.accessibilityLabel !== right.accessibilityLabel
        ) {
            return false;
        }
    }
    return true;
}

function renderFavoriteModelOptionIcon(entry: ResolvedBackendCatalogEntry): React.ReactNode {
    const agentId = entry.iconAgentId ?? entry.catalogAgentId ?? entry.builtInAgentId;
    if (!agentId) return null;
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
    selectedModelSelection?: SessionModelSelectionV1 | null;
    selectedConfigOverrides?: Readonly<Record<string, string>>;
    selectedMachineId: string | null;
    capabilityServerId: string;
    cwd?: string | null;
    settings: Settings;
    refreshProbe?: OptionPickerProbeState | null;
    onSnapshot: (targetKey: string, snapshot: FavoriteModelSnapshot) => void;
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
        props.entry.catalogAgentId ? getAgentCore(props.entry.catalogAgentId) : null
    ), [props.entry.catalogAgentId]);
    const rawAvailabilityById = React.useMemo(() => buildFavoriteModelAvailabilityById({
        mode: providerCore?.model.dynamicProbe === 'static-only' ? 'static-only' : 'dynamic',
        modelOptions,
        preflightModels,
    }), [modelOptions, preflightModels, providerCore?.model.dynamicProbe]);
    const providersFeatureEnabled = useFeatureEnabled('providers', {
        scopeKind: 'spawn',
        serverId: props.capabilityServerId,
    });
    const providerProjection = useProviderModelProjection({
        enabled: providersFeatureEnabled && props.selectedMachineId !== null,
        machineId: props.selectedMachineId,
        serverId: props.capabilityServerId,
        agentTargetKey: props.entry.backendTargetKey,
    });
    const hiddenNativeKeys = React.useMemo(() => hiddenModelVisibilityKeys(
        readProviderSettingsFromAccountSettingsV1(props.settings).settings,
        { providersFeatureEnabled },
    ), [props.settings, providersFeatureEnabled]);
    const selectableModelAvailability = React.useMemo(() => {
        const sections = buildSessionModelPickerSections({
            agentTargetKey: props.entry.backendTargetKey,
            nativeModels: Array.from(rawAvailabilityById.values()).map((model) => ({
                value: model.modelId,
                label: model.modelLabel,
                description: model.modelDescription,
            })),
            providerGroups: providersFeatureEnabled
                ? (providerProjection.data?.groups ?? [])
                : [],
            providerProjectionAuthoritative: providerProjection.status === 'success',
            hiddenNativeModelKeys: hiddenNativeKeys,
            canConfirmExperimental: false,
        });
        const native = new Map<string, FavoriteModelAvailability>();
        const provider = new Map<string, FavoriteModelAvailability>();
        const providerAccessibilityLabelByRefKey = new Map<string, string>();
        for (const option of sections.flatMap((section) => section.options)) {
            if (option.disabled === true || option.value === null) continue;
            const availability = {
                modelId: option.value.modelId,
                modelLabel: option.label || option.value.modelId,
                modelDescription: option.description ?? '',
            };
            if (option.value.providerConnectionId === null) {
                native.set(option.value.modelId, availability);
            } else {
                const refKey = sessionModelSelectionKey(option.value);
                provider.set(refKey, availability);
                if (option.accessibilityLabel) {
                    providerAccessibilityLabelByRefKey.set(refKey, option.accessibilityLabel);
                }
            }
        }
        return { native, provider, providerAccessibilityLabelByRefKey };
    }, [
        hiddenNativeKeys,
        props.entry.backendTargetKey,
        providerProjection.data?.groups,
        providerProjection.status,
        providersFeatureEnabled,
        rawAvailabilityById,
    ]);
    const availabilityById = selectableModelAvailability.native;
    const providerAvailabilityByRefKey = selectableModelAvailability.provider;
    const providerAccessibilityLabelByRefKey = selectableModelAvailability.providerAccessibilityLabelByRefKey;

    const availableFavorites = React.useMemo(() => resolveAvailableFavoriteModelsForBackend({
        favorites: props.favoriteModelSelections,
        backend: backendIdentity,
        availabilityById,
        providerAvailabilityByRefKey,
        backendLabel: props.entry.title,
    }), [
        availabilityById,
        providerAvailabilityByRefKey,
        backendIdentity,
        props.entry.title,
        props.favoriteModelSelections,
    ]);

    const matchingFavorites = React.useMemo(() => props.favoriteModelSelections.filter((favorite) => (
        favoriteModelSelectionMatchesBackend(favorite, backendIdentity)
    )), [backendIdentity, props.favoriteModelSelections]);

    const provisionalFavorites = React.useMemo((): readonly AvailableFavoriteModel[] => {
        const hasResolvedDynamicModels = (preflightModels?.availableModels.length ?? 0) > 0;
        const canUseProvisionalFavorites = providerCore?.model.dynamicProbe !== 'static-only'
            && !hasResolvedDynamicModels
            && modelProbe.phase !== 'idle';
        if (!canUseProvisionalFavorites) return [];

        const availableIds = new Set(availableFavorites.map((model) => model.modelId));
        const seen = new Set<string>(availableIds);
        const out: AvailableFavoriteModel[] = [];
        for (const favorite of matchingFavorites) {
            const modelRef = getFavoriteModelRef(favorite);
            const modelId = normalizeFavoriteModelId(modelRef.modelId);
            const hidden = modelRef.providerConnectionId === null && hiddenNativeKeys.has(serializeModelVisibilityRefV1({
                scope: 'agent',
                agentTargetKey: modelRef.agentTargetKey,
                providerConnectionId: null,
                modelId,
            }));
            if (modelRef.providerConnectionId !== null || hidden || !isFavoriteModelSelectableId(modelId) || seen.has(modelId)) continue;
            seen.add(modelId);
            out.push({
                modelSelection: favorite.selection,
                modelId,
                modelLabel: favorite.modelLabel || modelId,
                modelDescription: '',
                backendLabel: props.entry.title,
            });
        }
        return out;
    }, [availableFavorites, hiddenNativeKeys, matchingFavorites, modelProbe.phase, preflightModels?.availableModels.length, props.entry.title, providerCore?.model.dynamicProbe]);

    const selectableFavorites = React.useMemo(() => (
        provisionalFavorites.length > 0 ? [...availableFavorites, ...provisionalFavorites] : availableFavorites
    ), [availableFavorites, provisionalFavorites]);

    const staleFavorites = React.useMemo(() => {
        const availableIds = new Set(selectableFavorites.map((model) => buildFavoriteOptionValue(model.modelSelection)));
        const seen = new Set<string>();
        const out: FavoriteModelSelectionV1[] = [];
        for (const favorite of matchingFavorites) {
            const modelRef = getFavoriteModelRef(favorite);
            const modelId = normalizeFavoriteModelId(modelRef.modelId);
            const identityKey = buildFavoriteOptionValue(favorite.selection);
            if ((modelRef.providerConnectionId === null && !isFavoriteModelSelectableId(modelId))
                || availableIds.has(identityKey)
                || seen.has(identityKey)) continue;
            seen.add(identityKey);
            out.push(favorite);
        }
        return out;
    }, [matchingFavorites, selectableFavorites]);

    const options = React.useMemo(() => [
        ...selectableFavorites.map((model) => ({
            value: buildFavoriteOptionValue(model.modelSelection),
            label: model.modelLabel,
            icon: renderFavoriteModelOptionIcon(props.entry),
            description: model.backendLabel ?? props.entry.title,
            accessibilityLabel: providerAccessibilityLabelByRefKey.get(
                buildFavoriteOptionValue(model.modelSelection),
            ),
        })),
        ...staleFavorites.map((favorite) => {
            const modelId = normalizeFavoriteModelId(getFavoriteModelRef(favorite).modelId);
            const snapshot = favorite.providerDisplaySnapshot;
            const modelLabel = favorite.modelLabel || modelId;
            return {
                value: buildFavoriteOptionValue(favorite.selection),
                label: modelLabel,
                icon: renderFavoriteModelOptionIcon(props.entry),
                description: snapshot
                    ? snapshot.connectionRole === 'default' && snapshot.connectionDisplayNameMode === 'automatic'
                        ? snapshot.providerName
                        : `${snapshot.providerName} · ${snapshot.connectionName}`
                    : props.entry.title,
                accessibilityLabel: snapshot
                    ? `${snapshot.providerName}, ${snapshot.connectionName}, ${modelLabel}`
                    : undefined,
            };
        }),
    ], [props.entry, providerAccessibilityLabelByRefKey, selectableFavorites, staleFavorites]);

    const favoriteValues = React.useMemo(() => options.map((option) => option.value), [options]);
    const availableValues = React.useMemo(() => selectableFavorites.map((model) => (
        buildFavoriteOptionValue(model.modelSelection)
    )), [props.entry, selectableFavorites]);
    const staleFavoriteByValue = React.useMemo(() => new Map(staleFavorites.map((favorite) => {
        const modelId = normalizeFavoriteModelId(getFavoriteModelRef(favorite).modelId);
        return [buildFavoriteOptionValue(favorite.selection), favorite] as const;
    })), [props.entry, staleFavorites]);
    const modelByValue = React.useMemo(() => new Map(selectableFavorites.map((model) => [
        buildFavoriteOptionValue(model.modelSelection),
        {
            modelSelection: model.modelSelection,
            modelId: model.modelId,
            modelLabel: model.modelLabel,
        },
    ] as const)), [props.entry, selectableFavorites]);
    const modelOptionByValue = React.useMemo(() => new Map(selectableFavorites.flatMap((model) => {
        const option = modelOptions.find((candidate) => candidate.value === model.modelId) ?? null;
        return option ? [[buildFavoriteOptionValue(model.modelSelection), option] as const] : [];
    })), [modelOptions, props.entry, selectableFavorites]);

    const selectedModelSelection = props.selectedModelSelection
        ?? (props.selectedBackendTargetKey === props.entry.backendTargetKey
            && props.selectedModelId.trim().length > 0
            && props.selectedModelId !== 'default'
            ? {
                v: 1 as const,
                updatedAt: 0,
                ref: {
                    agentTargetKey: props.entry.backendTargetKey,
                    providerConnectionId: null,
                    modelId: props.selectedModelId,
                },
            }
            : null);
    const selectedValue = props.selectedBackendTargetKey === props.entry.backendTargetKey
        && selectedModelSelection?.ref.agentTargetKey === props.entry.backendTargetKey
        ? buildFavoriteOptionValue(selectedModelSelection)
        : '';
    const selectedOption = options.find((option) => option.value === selectedValue) ?? null;
    const selectedOptionControls = React.useMemo(() => {
        const selectedModelOption = modelOptionByValue.get(selectedValue) ?? null;
        if (!selectedModelOption?.modelOptions?.length) return null;
        return computeAcpConfigOptionControlsForProvider({
            providerId: props.entry.backendTarget.configuredBackendId ?? props.entry.backendTarget.backendId,
            configOptions: selectedModelOption.modelOptions,
            overrides: Object.fromEntries(
                Object.entries(props.selectedConfigOverrides ?? {}).map(([optionId, value]) => [optionId, { value }]),
            ),
        }) ?? null;
    }, [
        modelOptionByValue,
        props.entry.backendTarget,
        props.selectedConfigOverrides,
        selectedValue,
    ]);
    const unifiedProbe = React.useMemo(() => mergeOptionPickerProbes([
        props.refreshProbe ?? null,
        modelProbe ?? null,
        providerProjection.loading
            ? { phase: 'loading' as const }
            : { phase: 'idle' as const, onRefresh: () => { void providerProjection.refresh(); } },
    ]), [modelProbe, props.refreshProbe, providerProjection.loading, providerProjection.refresh]);

    React.useEffect(() => {
        props.onSnapshot(props.entry.backendTargetKey, {
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
        const allowedTargetKeys = new Set(favoriteBackendEntries.map((entry) => entry.backendTargetKey));
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
        .map((entry) => snapshotsByTargetKey.get(entry.backendTargetKey) ?? null)
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
    const favoriteOptions = React.useMemo<OptionPickerFavoriteOptions<string>>(() => ({
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
    }), [
        availableValues,
        favoriteValues,
        props.onRemoveFavoriteModelSelection,
        props.onToggleFavoriteModel,
        snapshotByOptionValue,
    ]);

    return (
        <View style={styles.container}>
            {favoriteBackendEntries.map((entry) => (
                <FavoriteBackendModelsCollector
                    key={formatBackendTargetKeyV2(entry.backendTarget)}
                    entry={entry}
                    favoriteModelSelections={props.favoriteModelSelections}
                    selectedBackendTargetKey={props.selectedBackendTargetKey}
                    selectedModelId={props.selectedModelId}
                    selectedModelSelection={props.selectedModelSelection}
                    selectedConfigOverrides={props.selectedConfigOverrides}
                    selectedMachineId={props.selectedMachineId}
                    capabilityServerId={props.capabilityServerId}
                    cwd={props.cwd}
                    settings={props.settings}
                    refreshProbe={props.refreshProbe}
                    onSnapshot={handleSnapshot}
                />
            ))}
            {options.length > 0 || unifiedProbe?.phase !== 'idle' ? (
                <OptionPickerOverlay
                    fillAvailableSpace
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
                            model.modelSelection,
                            configId,
                            valueId,
                        );
                    }}
                    favoriteOptions={favoriteOptions}
                    onSelect={(value) => {
                        const snapshot = snapshotByOptionValue.get(value);
                        const model = snapshot?.modelByValue.get(value);
                        if (!snapshot || !model || !availableValues.has(value)) return;
                        const providerId = snapshot.entry.backendTarget.configuredBackendId ?? snapshot.entry.backendTarget.backendId;
                        props.onSelectFavoriteModel(
                            snapshot.entry,
                            model.modelSelection,
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
        flex: 1,
        minHeight: 0,
        gap: 12,
    },
}));
