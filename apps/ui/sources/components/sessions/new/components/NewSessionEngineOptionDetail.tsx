import * as React from 'react';
import { Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { BackendTargetRefV2 } from '@happier-dev/protocol';

import { getAgentCore, isAgentId } from '@/agents/catalog/catalog';
import { formatBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { AgentInputEngineDetail } from '@/components/sessions/agentInput/components/AgentInputEngineDetail';
import { mergeOptionPickerProbes } from '@/components/sessions/pickers/mergeOptionPickerProbes';
import type { OptionPickerProbeState } from '@/components/sessions/pickers/OptionPickerOverlay';
import { useNewSessionPreflightConfigOptionsState } from '@/components/sessions/new/hooks/screenModel/useNewSessionPreflightConfigOptionsState';
import {
    useNewSessionPreflightModelsState,
} from '@/components/sessions/new/hooks/screenModel/useNewSessionPreflightModelsState';
import type { NewSessionCapabilityProbeContext } from '@/components/sessions/new/modules/newSessionCapabilityProbeContext';
import { sanitizeNewSessionConfigOverridesForModelSelection } from '@/components/sessions/new/modules/newSessionConfigOptionOverrideSanitization';
import { computeAcpConfigOptionControlsForProvider } from '@/sync/domains/sessionControl/configOptionsControl';
import {
    buildFavoriteModelAvailabilityById,
    resolveAvailableFavoriteModelsForBackend,
    type FavoriteModelBackendIdentity,
    type FavoriteModelSelectionV1,
} from '@/sync/domains/models/favoriteModelSelections';
import { t } from '@/text';

export type NewSessionEngineOptionDetailProps = Readonly<{
    backendTarget: BackendTargetRefV2;
    selectedMachineId: string | null;
    capabilityServerId: string;
    cwd?: string | null;
    capabilityProbeContext?: NewSessionCapabilityProbeContext | null;
    /**
     * Optional additional probe surface to merge into the model section's refresh affordance.
     * New-session wants one refresh button that can also refresh CLI detection.
     */
    refreshProbe?: OptionPickerProbeState | null;
    selectedModelId?: string | null;
    selectedSessionModeId?: string | null;
    selectedConfigOverrides?: Readonly<Record<string, string>>;
    favoriteModelSelections?: readonly FavoriteModelSelectionV1[];
    onToggleFavoriteModel?: (model: Readonly<{
        modelId: string;
        modelLabel: string;
    }>) => void;
    favoriteEngine?: Readonly<{
        favorite: boolean;
        onToggle: () => void;
    }>;
    onSelectionChange?: (selection: Readonly<{
        modelId: string;
        sessionModeId: string;
        configOverrides: Readonly<Record<string, string>>;
    }>) => void;
}>;

function normalizeSelectedOptionId(value: string | null | undefined): string {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return trimmed.length > 0 ? trimmed : 'default';
}

function resolveEffectiveModelLabel(
    modelOptions: ReadonlyArray<{ value: string; label: string }>,
    selectedModelId: string,
): string {
    const matched = modelOptions.find((option) => option.value === selectedModelId);
    if (matched) {
        return matched.label;
    }
    return selectedModelId === 'default'
        ? t('agentInput.model.useCliSettings')
        : selectedModelId;
}

function EngineFavoriteToggle(props: Readonly<{
    favorite: boolean;
    onToggle: () => void;
}>) {
    const { theme } = useUnistyles();
    const selectedColor = theme.dark ? theme.colors.text.primary : theme.colors.button.primary.background;
    return (
        <Pressable
            testID="new-session-engine-favorite-toggle"
            accessibilityRole="button"
            accessibilityLabel={props.favorite ? t('profiles.actions.removeFromFavorites') : t('profiles.actions.addToFavorites')}
            accessibilityState={{ selected: props.favorite }}
            onPress={props.onToggle}
            style={styles.engineFavoriteButton}
        >
            <Ionicons
                name={props.favorite ? 'star' : 'star-outline'}
                size={20}
                color={props.favorite ? selectedColor : theme.colors.text.secondary}
            />
        </Pressable>
    );
}

export function NewSessionEngineOptionDetail(props: NewSessionEngineOptionDetailProps) {
    const { modelOptions, preflightModels, probe: modelProbe } = useNewSessionPreflightModelsState({
        backendTarget: props.backendTarget,
        selectedMachineId: props.selectedMachineId,
        capabilityServerId: props.capabilityServerId,
        cwd: props.cwd ?? null,
        probeContext: props.capabilityProbeContext ?? null,
    });
    const { configOptions, probe: configProbe } = useNewSessionPreflightConfigOptionsState({
        backendTarget: props.backendTarget,
        selectedMachineId: props.selectedMachineId,
        capabilityServerId: props.capabilityServerId,
        cwd: props.cwd ?? null,
        probeContext: props.capabilityProbeContext ?? null,
    });

    const [selectedModelId, setSelectedModelId] = React.useState(() => normalizeSelectedOptionId(props.selectedModelId));
    const [selectedSessionModeId, setSelectedSessionModeId] = React.useState(() => normalizeSelectedOptionId(props.selectedSessionModeId));
    const [selectedConfigOverrides, setSelectedConfigOverrides] = React.useState<Readonly<Record<string, string>>>(() => props.selectedConfigOverrides ?? {});
    const selectionRef = React.useRef<Readonly<{
        modelId: string;
        sessionModeId: string;
        configOverrides: Readonly<Record<string, string>>;
    }>>({
        modelId: normalizeSelectedOptionId(props.selectedModelId),
        sessionModeId: normalizeSelectedOptionId(props.selectedSessionModeId),
        configOverrides: props.selectedConfigOverrides ?? {},
    });

    React.useEffect(() => {
        const nextModelId = normalizeSelectedOptionId(props.selectedModelId);
        selectionRef.current = {
            ...selectionRef.current,
            modelId: nextModelId,
        };
        setSelectedModelId(nextModelId);
    }, [props.selectedModelId]);

    React.useEffect(() => {
        const nextSessionModeId = normalizeSelectedOptionId(props.selectedSessionModeId);
        selectionRef.current = {
            ...selectionRef.current,
            sessionModeId: nextSessionModeId,
        };
        setSelectedSessionModeId(nextSessionModeId);
    }, [props.selectedSessionModeId]);

    React.useEffect(() => {
        const nextConfigOverrides = props.selectedConfigOverrides ?? {};
        selectionRef.current = {
            ...selectionRef.current,
            configOverrides: nextConfigOverrides,
        };
        setSelectedConfigOverrides(nextConfigOverrides);
    }, [props.selectedConfigOverrides]);

    const publishSelection = React.useCallback((nextSelection: Readonly<{
        modelId: string;
        sessionModeId: string;
        configOverrides: Readonly<Record<string, string>>;
    }>) => {
        selectionRef.current = nextSelection;
        setSelectedModelId(nextSelection.modelId);
        setSelectedSessionModeId(nextSelection.sessionModeId);
        setSelectedConfigOverrides(nextSelection.configOverrides);
        props.onSelectionChange?.(nextSelection);
    }, [props.onSelectionChange]);

    const providerAgentId = React.useMemo(() => (
        isAgentId(props.backendTarget.backendId) ? props.backendTarget.backendId : null
    ), [props.backendTarget.backendId]);
    const providerCore = React.useMemo(() => (
        providerAgentId ? getAgentCore(providerAgentId) : null
    ), [providerAgentId]);
    const providerId = props.backendTarget.configuredBackendId ?? props.backendTarget.backendId;
    const providerSupportsFreeform = React.useMemo(() => {
        if (props.backendTarget.configuredBackendId) return true;
        return providerCore?.model.supportsFreeform === true;
    }, [props.backendTarget.configuredBackendId, providerCore?.model.supportsFreeform]);
    const canEnterCustomModel = preflightModels?.supportsFreeform === true || providerSupportsFreeform;
    const effectiveModelLabel = React.useMemo(
        () => resolveEffectiveModelLabel(modelOptions, selectedModelId),
        [modelOptions, selectedModelId],
    );

    const configControls = React.useMemo(
        () => computeAcpConfigOptionControlsForProvider({
            providerId,
            configOptions,
            overrides: Object.fromEntries(
                Object.entries(selectedConfigOverrides).map(([optionId, value]) => [optionId, { value }]),
            ),
        }) ?? [],
        [configOptions, providerId, selectedConfigOverrides],
    );

    const selectedModelOptionControls = React.useMemo(() => {
        const selectedModel = modelOptions.find((option) => option.value === selectedModelId) ?? null;
        if (!selectedModel?.modelOptions?.length) return null;
        return computeAcpConfigOptionControlsForProvider({
            providerId,
            configOptions: selectedModel.modelOptions,
            overrides: Object.fromEntries(
                Object.entries(selectedConfigOverrides).map(([optionId, value]) => [optionId, { value }]),
            ),
        }) ?? null;
    }, [modelOptions, providerId, selectedConfigOverrides, selectedModelId]);

    const sanitizeConfigOverridesForModel = React.useCallback((
        modelId: string,
        configOverrides: Readonly<Record<string, string>>,
    ) => sanitizeNewSessionConfigOverridesForModelSelection({
        providerId,
        configOptions,
        modelOptions,
        selectedModelId: modelId,
        selectedConfigOverrides: configOverrides,
    }), [configOptions, modelOptions, providerId]);

    const favoriteBackendIdentity = React.useMemo<FavoriteModelBackendIdentity>(() => ({
        backendTargetKey: formatBackendTargetKeyV2(props.backendTarget),
        providerAgentId,
        builtInAgentId: props.backendTarget.configuredBackendId ? null : providerAgentId,
        configuredBackendId: props.backendTarget.configuredBackendId ?? null,
    }), [props.backendTarget, providerAgentId]);

    const favoriteModelAvailabilityById = React.useMemo(() => buildFavoriteModelAvailabilityById({
        mode: providerCore?.model.dynamicProbe === 'static-only' ? 'static-only' : 'dynamic',
        modelOptions,
        preflightModels,
    }), [modelOptions, preflightModels, providerCore?.model.dynamicProbe]);

    const favoriteModelValues = React.useMemo(() => {
        const availableFavorites = resolveAvailableFavoriteModelsForBackend({
            favorites: props.favoriteModelSelections ?? [],
            backend: favoriteBackendIdentity,
            availabilityById: favoriteModelAvailabilityById,
        });
        return new Set(availableFavorites.map((model) => model.modelId));
    }, [
        favoriteBackendIdentity,
        favoriteModelAvailabilityById,
        props.favoriteModelSelections,
    ]);

    const isModelFavoritable = React.useCallback((option: { value: string }) => {
        return favoriteModelAvailabilityById.has(option.value);
    }, [favoriteModelAvailabilityById]);

    const unifiedProbe = React.useMemo(() => {
        return mergeOptionPickerProbes([
            props.refreshProbe ?? null,
            modelProbe ?? null,
            configProbe ?? null,
        ]);
    }, [configProbe, modelProbe, props.refreshProbe]);

    return (
        <AgentInputEngineDetail
            modelOptions={modelOptions}
            selectedModelId={selectedModelId}
            effectiveModelLabel={effectiveModelLabel}
            modelNotes={[]}
            modelEmptyText={t('agentInput.model.configureInCli')}
            canEnterCustomModel={canEnterCustomModel}
            modelProbe={unifiedProbe}
            modelHeaderAccessory={props.favoriteEngine ? (
                <EngineFavoriteToggle
                    favorite={props.favoriteEngine.favorite}
                    onToggle={props.favoriteEngine.onToggle}
                />
            ) : undefined}
            favoriteModelValues={props.onToggleFavoriteModel ? favoriteModelValues : undefined}
            isModelFavoritable={isModelFavoritable}
            onToggleFavoriteModel={props.onToggleFavoriteModel ? (option) => {
                props.onToggleFavoriteModel?.({
                    modelId: option.value,
                    modelLabel: option.label,
                });
            } : undefined}
            onSelectModel={(modelId) => {
                const configOverrides = sanitizeConfigOverridesForModel(modelId, selectionRef.current.configOverrides);
                publishSelection({
                    ...selectionRef.current,
                    modelId,
                    configOverrides,
                });
            }}
            onSubmitCustomValue={canEnterCustomModel ? (modelId) => {
                const configOverrides = sanitizeConfigOverridesForModel(modelId, selectionRef.current.configOverrides);
                publishSelection({
                    ...selectionRef.current,
                    modelId,
                    configOverrides,
                });
            } : undefined}
            selectedModelOptionControls={selectedModelOptionControls}
            onSelectModelOptionValue={(configId, valueId) => {
                publishSelection({
                    ...selectionRef.current,
                    configOverrides: {
                        ...selectionRef.current.configOverrides,
                        [configId]: valueId,
                    },
                });
            }}
            configControls={configControls}
            onSelectConfigValue={(configId, valueId) => {
                publishSelection({
                    ...selectionRef.current,
                    configOverrides: {
                        ...selectionRef.current.configOverrides,
                        [configId]: valueId,
                    },
                });
            }}
            sectionOrder={['model', 'config']}
        />
    );
}

const styles = StyleSheet.create(() => ({
    engineFavoriteButton: {
        width: 32,
        height: 32,
        alignItems: 'center',
        justifyContent: 'center',
    },
}));
