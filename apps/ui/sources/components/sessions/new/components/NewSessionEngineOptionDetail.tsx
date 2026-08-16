import * as React from 'react';
import { Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { buildBackendTargetKey, type BackendTargetRefV1, type ConnectedServiceBindingsV1 } from '@happier-dev/protocol';

import { resolveProviderAgentIdForBackendTarget } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { getAgentCore } from '@/agents/catalog/catalog';
import { AgentInputEngineDetail } from '@/components/sessions/agentInput/components/AgentInputEngineDetail';
import { mergeOptionPickerProbes } from '@/components/sessions/pickers/mergeOptionPickerProbes';
import type { OptionPickerProbeState } from '@/components/sessions/pickers/OptionPickerOverlay';
import { useNewSessionPreflightConfigOptionsState } from '@/components/sessions/new/hooks/screenModel/useNewSessionPreflightConfigOptionsState';
import {
    useNewSessionPreflightModelsState,
} from '@/components/sessions/new/hooks/screenModel/useNewSessionPreflightModelsState';
import type { NewSessionCapabilityProbeContext } from '@/components/sessions/new/modules/newSessionCapabilityProbeContext';
import { collectNewSessionModelScopedOptionIds } from '@/components/sessions/new/modules/collectNewSessionModelScopedOptionIds';
import { sanitizeNewSessionConfigOverridesForModelSelection } from '@/components/sessions/new/modules/newSessionConfigOptionOverrideSanitization';
import { computeSessionConfigOptionControlsForProvider, type SessionConfigOptionControl } from '@/sync/domains/sessionControl/configOptionsControl';
import {
    buildFavoriteModelAvailabilityById,
    resolveAvailableFavoriteModelsForBackend,
    type FavoriteModelBackendIdentity,
    type FavoriteModelSelectionV1,
} from '@/sync/domains/models/favoriteModelSelections';
import { t } from '@/text';
import { readNonBlankSessionControlIdentifier } from '@/sync/domains/sessionControl/opaqueIdentifiers';
import { Icon } from '@/components/ui/icons/Icon';
import {
    findModelOptionForEffectiveModelId,
    resolveCanonicalModelOptionId,
} from '@/sync/domains/models/modelOptions';

export type NewSessionEngineOptionDetailProps = Readonly<{
    backendTarget: BackendTargetRefV1;
    selectedMachineId: string | null;
    capabilityServerId: string;
    cwd?: string | null;
    profileId?: string | null;
    capabilityProbeContext?: NewSessionCapabilityProbeContext | null;
    connectedServices?: ConnectedServiceBindingsV1 | null;
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
    return readNonBlankSessionControlIdentifier(value) ?? 'default';
}

function areSelectedConfigOverridesEqual(
    current: Readonly<Record<string, string>>,
    next: Readonly<Record<string, string>>,
): boolean {
    if (current === next) return true;
    const currentKeys = Object.keys(current);
    const nextKeys = Object.keys(next);
    if (currentKeys.length !== nextKeys.length) return false;
    for (const key of currentKeys) {
        if (current[key] !== next[key]) return false;
    }
    return true;
}

function areSelectionsEqual(
    current: Readonly<{
        modelId: string;
        sessionModeId: string;
        configOverrides: Readonly<Record<string, string>>;
    }>,
    next: Readonly<{
        modelId: string;
        sessionModeId: string;
        configOverrides: Readonly<Record<string, string>>;
    }>,
): boolean {
    return current.modelId === next.modelId
        && current.sessionModeId === next.sessionModeId
        && areSelectedConfigOverridesEqual(current.configOverrides, next.configOverrides);
}

function removeModelScopedConfigControls(params: Readonly<{
    controls: ReadonlyArray<SessionConfigOptionControl> | null;
    modelOptions: ReadonlyArray<{
        modelOptions?: ReadonlyArray<{ id: string }>;
    }>;
}>): ReadonlyArray<SessionConfigOptionControl> | null {
    const modelScopedOptionIds = collectNewSessionModelScopedOptionIds(params.modelOptions);
    if (!params.controls || params.controls.length === 0 || modelScopedOptionIds.size === 0) {
        return params.controls;
    }

    const filtered = params.controls.filter((control) => !modelScopedOptionIds.has(control.option.id));
    return filtered.length > 0 ? filtered : null;
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
            <Icon
                name="star"
                size={20}
                color={props.favorite ? selectedColor : theme.colors.text.secondary}
                weight={props.favorite ? 'fill' : 'regular'}
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
        profileId: props.profileId ?? null,
        probeContext: props.capabilityProbeContext ?? null,
        connectedServices: props.connectedServices ?? null,
    });
    const { configOptions, probe: configProbe } = useNewSessionPreflightConfigOptionsState({
        backendTarget: props.backendTarget,
        selectedMachineId: props.selectedMachineId,
        capabilityServerId: props.capabilityServerId,
        cwd: props.cwd ?? null,
        probeContext: props.capabilityProbeContext ?? null,
        connectedServices: props.connectedServices ?? null,
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
        setSelectedModelId((current) => current === nextModelId ? current : nextModelId);
    }, [props.selectedModelId]);

    React.useEffect(() => {
        const nextSessionModeId = normalizeSelectedOptionId(props.selectedSessionModeId);
        selectionRef.current = {
            ...selectionRef.current,
            sessionModeId: nextSessionModeId,
        };
        setSelectedSessionModeId((current) => current === nextSessionModeId ? current : nextSessionModeId);
    }, [props.selectedSessionModeId]);

    React.useEffect(() => {
        const nextConfigOverrides = props.selectedConfigOverrides ?? {};
        selectionRef.current = {
            ...selectionRef.current,
            configOverrides: nextConfigOverrides,
        };
        setSelectedConfigOverrides((current) => {
            return areSelectedConfigOverridesEqual(current, nextConfigOverrides)
                ? current
                : nextConfigOverrides;
        });
    }, [props.selectedConfigOverrides]);

    const publishSelection = React.useCallback((nextSelection: Readonly<{
        modelId: string;
        sessionModeId: string;
        configOverrides: Readonly<Record<string, string>>;
    }>) => {
        if (areSelectionsEqual(selectionRef.current, nextSelection)) {
            return;
        }
        selectionRef.current = nextSelection;
        setSelectedModelId((current) => current === nextSelection.modelId ? current : nextSelection.modelId);
        setSelectedSessionModeId((current) => current === nextSelection.sessionModeId ? current : nextSelection.sessionModeId);
        setSelectedConfigOverrides((current) => {
            return areSelectedConfigOverridesEqual(current, nextSelection.configOverrides)
                ? current
                : nextSelection.configOverrides;
        });
        props.onSelectionChange?.(nextSelection);
    }, [props.onSelectionChange]);

    const providerAgentId = React.useMemo(
        () => resolveProviderAgentIdForBackendTarget(props.backendTarget),
        [props.backendTarget],
    );
    const providerCore = React.useMemo(() => getAgentCore(providerAgentId), [providerAgentId]);
    const providerId = props.backendTarget.kind === 'configuredAcpBackend'
        ? props.backendTarget.backendId
        : props.backendTarget.agentId;
    const providerSupportsFreeform = providerCore.model.supportsFreeform === true;
    const canEnterCustomModel = preflightModels?.supportsFreeform === true || providerSupportsFreeform;
    const canonicalSelectedModelId = React.useMemo(
        () => resolveCanonicalModelOptionId(modelOptions, selectedModelId),
        [modelOptions, selectedModelId],
    );
    const configControls = React.useMemo(
        () => removeModelScopedConfigControls({
            controls: computeSessionConfigOptionControlsForProvider({
                providerId,
                configOptions,
                overrides: Object.fromEntries(
                    Object.entries(selectedConfigOverrides).map(([optionId, value]) => [optionId, { value }]),
                ),
                hideModeOption: true,
                hideModelOption: true,
            }) ?? null,
            modelOptions,
        }),
        [configOptions, modelOptions, providerId, selectedConfigOverrides],
    );

    const selectedModelOptionControls = React.useMemo(() => {
        const selectedModel = findModelOptionForEffectiveModelId(modelOptions, canonicalSelectedModelId);
        if (!selectedModel?.modelOptions?.length) return null;
        return computeSessionConfigOptionControlsForProvider({
            providerId,
            configOptions: selectedModel.modelOptions,
            overrides: Object.fromEntries(
                Object.entries(selectedConfigOverrides).map(([optionId, value]) => [optionId, { value }]),
            ),
        }) ?? null;
    }, [canonicalSelectedModelId, modelOptions, providerId, selectedConfigOverrides]);

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

    React.useEffect(() => {
        if (canonicalSelectedModelId === selectionRef.current.modelId) return;
        publishSelection({
            ...selectionRef.current,
            modelId: canonicalSelectedModelId,
            configOverrides: sanitizeConfigOverridesForModel(
                canonicalSelectedModelId,
                selectionRef.current.configOverrides,
            ),
        });
    }, [canonicalSelectedModelId, publishSelection, sanitizeConfigOverridesForModel]);

    const favoriteBackendIdentity = React.useMemo<FavoriteModelBackendIdentity>(() => ({
        backendTargetKey: buildBackendTargetKey(props.backendTarget),
        providerAgentId,
        builtInAgentId: props.backendTarget.kind === 'builtInAgent' ? props.backendTarget.agentId : null,
        configuredBackendId: props.backendTarget.kind === 'configuredAcpBackend' ? props.backendTarget.backendId : null,
    }), [props.backendTarget, providerAgentId]);

    const favoriteModelAvailabilityById = React.useMemo(() => buildFavoriteModelAvailabilityById({
        mode: providerCore.model.dynamicProbe === 'static-only' ? 'static-only' : 'dynamic',
        modelOptions,
        preflightModels,
    }), [modelOptions, preflightModels, providerCore.model.dynamicProbe]);

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
            selectedModelId={canonicalSelectedModelId}
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
                const canonicalModelId = resolveCanonicalModelOptionId(modelOptions, modelId);
                const configOverrides = sanitizeConfigOverridesForModel(canonicalModelId, selectionRef.current.configOverrides);
                publishSelection({
                    ...selectionRef.current,
                    modelId: canonicalModelId,
                    configOverrides,
                });
            }}
            onSubmitCustomValue={canEnterCustomModel ? (modelId) => {
                const canonicalModelId = resolveCanonicalModelOptionId(modelOptions, modelId);
                const configOverrides = sanitizeConfigOverridesForModel(canonicalModelId, selectionRef.current.configOverrides);
                publishSelection({
                    ...selectionRef.current,
                    modelId: canonicalModelId,
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
