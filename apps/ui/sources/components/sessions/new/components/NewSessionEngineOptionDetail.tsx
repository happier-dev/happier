import * as React from 'react';
import { Platform } from 'react-native';

import {
    readProviderSettingsFromAccountSettingsV1,
    type BackendTargetRefV2,
    type SessionModelSelectionV1,
} from '@happier-dev/protocol';

import { resolveCatalogAgentIdForBackendTarget } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { getAgentCore, isAgentId, type AgentId } from '@/agents/catalog/catalog';
import { formatBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { AgentInputEngineDetail } from '@/components/sessions/agentInput/components/AgentInputEngineDetail';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
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
    getFavoriteModelRef,
    type FavoriteProviderDisplaySnapshot,
    type FavoriteModelSelectionV1,
} from '@/sync/domains/models/favoriteModelSelections';
import { buildFavoriteBackendIdentity } from '@/sync/domains/models/favoriteModelBackendIdentity';
import {
    findModelOptionForEffectiveModelId,
    resolveCanonicalModelOptionId,
    resolveCanonicalNativeModelSelectionRef,
} from '@/sync/domains/models/modelOptions';
import { t } from '@/text';
import { useProviderModelProjection } from '@/providers/hooks/useProviderModelProjection';
import {
    SessionModelPicker,
    type SessionModelPickerExperimentalConfirmationController,
} from '@/components/sessions/modelPicker/SessionModelPicker';
import { hiddenModelVisibilityKeys } from '@/components/sessions/modelPicker/buildSessionModelPickerSections';
import { sessionModelSelectionKey } from '@/components/sessions/modelPicker/sessionModelSelectionKey';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useSettings } from '@/sync/domains/state/storage';
import { IconButton } from '@/components/ui/buttons/IconButton';

export type NewSessionEngineOptionDetailProps = Readonly<{
    backendTarget: BackendTargetRefV2;
    runtimeCarrierAgentId?: AgentId | null;
    selectedMachineId: string | null;
    capabilityServerId: string;
    cwd?: string | null;
    capabilityProbeContext?: NewSessionCapabilityProbeContext | null;
    /**
     * Optional additional probe surface to merge into the model section's refresh affordance.
     * New-session wants one refresh button that can also refresh CLI detection.
     */
    refreshProbe?: OptionPickerProbeState | null;
    /**
     * One short line under the model section's label. Surface-supplied because it
     * is the only part of this pane whose truth depends on the caller: nothing is
     * running on the New Session screen, and something is in a live Session.
     */
    modelSummary?: string;
    selectedModelId?: string | null;
    selectedModelSelection?: SessionModelSelectionV1 | null;
    selectedSessionModeId?: string | null;
    selectedConfigOverrides?: Readonly<Record<string, string>>;
    favoriteModelSelections?: readonly FavoriteModelSelectionV1[];
    onToggleFavoriteModel?: (model: Readonly<{
        modelId: string;
        modelLabel: string;
        modelSelection?: SessionModelSelectionV1;
        providerDisplaySnapshot?: FavoriteProviderDisplaySnapshot;
    }>) => void;
    favoriteEngine?: Readonly<{
        favorite: boolean;
        onToggle: () => void;
    }>;
    experimentalConfirmation?: SessionModelPickerExperimentalConfirmationController;
    onSelectionChange?: (selection: Readonly<{
        modelId: string;
        modelSelection: SessionModelSelectionV1 | null;
        sessionModeId: string;
        configOverrides: Readonly<Record<string, string>>;
        /**
         * What this pane CALLS the selected model, or null while the selection is the
         * Agent's own settings rather than a named model.
         *
         * Published because a surface that has to name the choice elsewhere — the
         * composer's engine chip, once an Agent switch is armed — must use the words
         * the reader just read here. Resolving the label again from a second model
         * list is how the same model ends up with two names in one screen.
         */
        modelLabel: string | null;
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
    const actionLabel = props.favorite
        ? t('profiles.actions.removeFromFavorites')
        : t('profiles.actions.addToFavorites');
    return (
        <IconButton
            testID="new-session-engine-favorite-toggle"
            iconName={'star'}
            accessibilityLabel={actionLabel}
            tooltip={actionLabel}
            iconSize={20}
            minimumInteractiveTargetSize={resolveMinimumInteractiveTargetSize(Platform.OS)}
            interactiveTargetGapPx={4}
            tone={props.favorite ? 'primary' : 'default'}
            variant="plain"
            onPress={props.onToggle}
        />
    );
}

export function NewSessionEngineOptionDetail(props: NewSessionEngineOptionDetailProps) {
    const settings = useSettings();
    const { modelOptions, preflightModels, probe: modelProbe } = useNewSessionPreflightModelsState({
        backendTarget: props.backendTarget,
        providerConnectionId: props.selectedModelSelection?.ref.providerConnectionId ?? null,
        runtimeCarrierAgentId: props.runtimeCarrierAgentId ?? null,
        selectedMachineId: props.selectedMachineId,
        capabilityServerId: props.capabilityServerId,
        cwd: props.cwd ?? null,
        probeContext: props.capabilityProbeContext ?? null,
    });
    const { configOptions, unavailable: configOptionsUnavailable, probe: configProbe } = useNewSessionPreflightConfigOptionsState({
        backendTarget: props.backendTarget,
        runtimeCarrierAgentId: props.runtimeCarrierAgentId ?? null,
        selectedMachineId: props.selectedMachineId,
        capabilityServerId: props.capabilityServerId,
        cwd: props.cwd ?? null,
        probeContext: props.capabilityProbeContext ?? null,
    });

    const [selectedModelId, setSelectedModelId] = React.useState(() => normalizeSelectedOptionId(props.selectedModelId));
    const [selectedModelSelection, setSelectedModelSelection] = React.useState<SessionModelSelectionV1 | null>(
        () => props.selectedModelSelection ?? null,
    );
    const [selectedSessionModeId, setSelectedSessionModeId] = React.useState(() => normalizeSelectedOptionId(props.selectedSessionModeId));
    const [selectedConfigOverrides, setSelectedConfigOverrides] = React.useState<Readonly<Record<string, string>>>(() => props.selectedConfigOverrides ?? {});
    const selectionRef = React.useRef<Readonly<{
        modelId: string;
        modelSelection: SessionModelSelectionV1 | null;
        sessionModeId: string;
        configOverrides: Readonly<Record<string, string>>;
    }>>({
        modelId: normalizeSelectedOptionId(props.selectedModelId),
        modelSelection: props.selectedModelSelection ?? null,
        sessionModeId: normalizeSelectedOptionId(props.selectedSessionModeId),
        configOverrides: props.selectedConfigOverrides ?? {},
    });

    React.useEffect(() => {
        const nextModelId = normalizeSelectedOptionId(props.selectedModelId);
        selectionRef.current = {
            ...selectionRef.current,
            modelId: nextModelId,
            modelSelection: props.selectedModelSelection ?? null,
        };
        setSelectedModelId(nextModelId);
        setSelectedModelSelection(props.selectedModelSelection ?? null);
    }, [props.selectedModelId, props.selectedModelSelection]);

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
        modelSelection: SessionModelSelectionV1 | null;
        sessionModeId: string;
        configOverrides: Readonly<Record<string, string>>;
    }>) => {
        selectionRef.current = nextSelection;
        setSelectedModelId(nextSelection.modelId);
        setSelectedModelSelection(nextSelection.modelSelection);
        setSelectedSessionModeId(nextSelection.sessionModeId);
        setSelectedConfigOverrides(nextSelection.configOverrides);
        props.onSelectionChange?.({
            ...nextSelection,
            modelLabel: nextSelection.modelId === 'default'
                ? null
                : resolveEffectiveModelLabel(modelOptions, nextSelection.modelId),
        });
    }, [modelOptions, props.onSelectionChange]);

    const catalogAgentId = React.useMemo<AgentId | null>(() => {
        if (isAgentId(props.runtimeCarrierAgentId)) {
            return props.runtimeCarrierAgentId;
        }
        return resolveCatalogAgentIdForBackendTarget(props.backendTarget)
            ?? (isAgentId(props.backendTarget.backendId) ? props.backendTarget.backendId : null);
    }, [props.backendTarget, props.runtimeCarrierAgentId]);
    const providerCore = React.useMemo(() => (
        catalogAgentId ? getAgentCore(catalogAgentId) : null
    ), [catalogAgentId]);
    const providerId = props.backendTarget.configuredBackendId ?? props.backendTarget.backendId;
    const providerSupportsFreeform = React.useMemo(() => {
        if (props.backendTarget.configuredBackendId) return true;
        return providerCore?.model.supportsFreeform === true;
    }, [props.backendTarget.configuredBackendId, providerCore?.model.supportsFreeform]);
    const canEnterCustomModel = preflightModels?.unavailable === true
        ? false
        : preflightModels?.supportsFreeform === true || providerSupportsFreeform;
    const canonicalSelectedModelId = React.useMemo(() => (
        selectedModelSelection?.ref.providerConnectionId
            ? selectedModelId
            : resolveCanonicalModelOptionId(modelOptions, selectedModelId)
    ), [modelOptions, selectedModelId, selectedModelSelection?.ref.providerConnectionId]);
    const effectiveModelLabel = React.useMemo(
        () => resolveEffectiveModelLabel(modelOptions, canonicalSelectedModelId),
        [canonicalSelectedModelId, modelOptions],
    );
    // The caller's one line leads, then anything the probe has to report. One
    // section label, one subtitle, then the models — never a paragraph.
    const modelNotes = React.useMemo(
        () => [
            ...(props.modelSummary ? [props.modelSummary] : []),
            ...(preflightModels?.unavailable === true && modelProbe.phase === 'idle'
                ? [t('agentInput.model.unavailable')]
                : []),
        ],
        [modelProbe.phase, preflightModels?.unavailable, props.modelSummary],
    );
    const configNotes = React.useMemo(
        () => configOptionsUnavailable
            ? [t('agentInput.acp.optionsUnavailable')]
            : [],
        [configOptionsUnavailable],
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
        const selectedModel = findModelOptionForEffectiveModelId(modelOptions, canonicalSelectedModelId);
        if (!selectedModel?.modelOptions?.length) return null;
        return computeAcpConfigOptionControlsForProvider({
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

    const favoriteBackendIdentity = React.useMemo(() => buildFavoriteBackendIdentity({
        backendTargetKey: formatBackendTargetKeyV2(props.backendTarget),
        backendTarget: props.backendTarget,
        catalogAgentId,
        builtInAgentId: props.backendTarget.configuredBackendId ? null : catalogAgentId,
    }), [props.backendTarget, catalogAgentId]);
    const agentTargetKey = favoriteBackendIdentity.backendTargetKey;
    const canonicalSelectedRef = React.useMemo(() => {
        if (selectedModelSelection) {
            return resolveCanonicalNativeModelSelectionRef(modelOptions, selectedModelSelection.ref);
        }
        if (canonicalSelectedModelId === 'default') return null;
        return {
            agentTargetKey,
            providerConnectionId: null,
            modelId: canonicalSelectedModelId,
        };
    }, [agentTargetKey, canonicalSelectedModelId, modelOptions, selectedModelSelection]);

    React.useEffect(() => {
        if (canonicalSelectedModelId === selectedModelId) return;
        if (selectedModelSelection?.ref.providerConnectionId) return;
        publishSelection({
            ...selectionRef.current,
            modelId: canonicalSelectedModelId,
            modelSelection: canonicalSelectedRef
                ? { v: 1, updatedAt: Date.now(), ref: canonicalSelectedRef }
                : null,
            configOverrides: sanitizeConfigOverridesForModel(
                canonicalSelectedModelId,
                selectionRef.current.configOverrides,
            ),
        });
    }, [
        canonicalSelectedModelId,
        canonicalSelectedRef,
        publishSelection,
        sanitizeConfigOverridesForModel,
        selectedModelId,
        selectedModelSelection?.ref.providerConnectionId,
    ]);
    const providersFeatureEnabled = useFeatureEnabled('providers', {
        scopeKind: 'spawn',
        serverId: props.capabilityServerId,
    });
    const providerProjection = useProviderModelProjection({
        enabled: providersFeatureEnabled && props.selectedMachineId !== null,
        machineId: props.selectedMachineId,
        serverId: props.capabilityServerId,
        agentTargetKey,
        ...(selectedModelSelection ? { currentSelection: selectedModelSelection.ref } : {}),
    });

    const unifiedProbe = React.useMemo(() => {
        return mergeOptionPickerProbes([
            props.refreshProbe ?? null,
            modelProbe ?? null,
            configProbe ?? null,
            providersFeatureEnabled
                ? providerProjection.loading
                    ? { phase: 'loading' as const }
                    : { phase: 'idle' as const, onRefresh: () => { void providerProjection.refresh(); } }
                : null,
        ]);
    }, [
        configProbe,
        modelProbe,
        props.refreshProbe,
        providerProjection.loading,
        providerProjection.refresh,
        providersFeatureEnabled,
    ]);

    const providerFavoriteKeys = React.useMemo(() => new Set(
        (props.favoriteModelSelections ?? [])
            .map((favorite) => getFavoriteModelRef(favorite))
            .filter((ref) => ref.agentTargetKey === agentTargetKey)
            .map(sessionModelSelectionKey),
    ), [agentTargetKey, props.favoriteModelSelections]);
    const providerGroups = providersFeatureEnabled ? (providerProjection.data?.groups ?? []) : [];
    const hiddenNativeModelKeys = React.useMemo(() => hiddenModelVisibilityKeys(
        readProviderSettingsFromAccountSettingsV1(settings).settings,
        { providersFeatureEnabled },
    ), [providersFeatureEnabled, settings]);
    const modelHeaderAccessory = props.favoriteEngine ? (
        <EngineFavoriteToggle
            favorite={props.favoriteEngine.favorite}
            onToggle={props.favoriteEngine.onToggle}
        />
    ) : undefined;
    const providerPicker = (
        <SessionModelPicker
            fillAvailableSpace
            multiColumn
            agentTargetKey={agentTargetKey}
            nativeModels={modelOptions}
            providerGroups={providerGroups}
            providerProjectionAuthoritative={providerProjection.status === 'success'}
            projectionError={providersFeatureEnabled ? providerProjection.error : null}
            retryProjection={providersFeatureEnabled ? providerProjection.refresh : null}
            currentSelectionRecovery={providersFeatureEnabled
                ? providerProjection.data?.currentSelectionRecovery ?? null
                : null}
            hiddenNativeModelKeys={hiddenNativeModelKeys}
            selected={canonicalSelectedRef}
            effectiveLabel={selectedModelSelection?.ref.providerConnectionId
                ? providerGroups.flatMap((group) => group.rows)
                    .find((row) => sessionModelSelectionKey(row.ref) === sessionModelSelectionKey(selectedModelSelection.ref))
                    ?.descriptor.name ?? selectedModelSelection.ref.modelId
                : effectiveModelLabel}
            canEnterCustomNativeValue={canEnterCustomModel}
            notes={modelNotes}
            probe={unifiedProbe}
            headerAccessory={modelHeaderAccessory}
            favoriteKeys={props.onToggleFavoriteModel ? providerFavoriteKeys : undefined}
            selectedOptionControls={selectedModelOptionControls ?? undefined}
            onSelectOptionControlValue={(configId, valueId) => {
                publishSelection({
                    ...selectionRef.current,
                    configOverrides: {
                        ...selectionRef.current.configOverrides,
                        [configId]: valueId,
                    },
                });
            }}
            experimentalConfirmation={props.experimentalConfirmation}
            onToggleFavorite={props.onToggleFavoriteModel ? (ref) => {
                const group = providerGroups.find((candidate) => candidate.rows.some((row) => (
                    sessionModelSelectionKey(row.ref) === sessionModelSelectionKey(ref)
                )));
                const row = group?.rows.find((candidate) => (
                    sessionModelSelectionKey(candidate.ref) === sessionModelSelectionKey(ref)
                ));
                props.onToggleFavoriteModel?.({
                    modelId: ref.modelId,
                    modelLabel: row?.descriptor.name ?? ref.modelId,
                    modelSelection: { v: 1, updatedAt: Date.now(), ref },
                    ...(group ? {
                        providerDisplaySnapshot: {
                            providerName: group.providerName,
                            connectionName: group.connectionName,
                            connectionRole: group.connectionRole,
                            connectionDisplayNameMode: group.connectionDisplayNameMode,
                        },
                    } : {}),
                });
            } : undefined}
            onSelect={(ref) => {
                const selectedId = ref?.modelId ?? 'default';
                const modelId = ref?.providerConnectionId
                    ? selectedId
                    : resolveCanonicalModelOptionId(modelOptions, selectedId);
                const canonicalRef = ref && modelId !== ref.modelId
                    ? { ...ref, modelId }
                    : ref;
                const configOverrides = sanitizeConfigOverridesForModel(modelId, selectionRef.current.configOverrides);
                publishSelection({
                    ...selectionRef.current,
                    modelId,
                    modelSelection: canonicalRef ? { v: 1, updatedAt: Date.now(), ref: canonicalRef } : null,
                    configOverrides,
                });
            }}
        />
    );

    return (
        <AgentInputEngineDetail
            fillAvailableSpace
            modelContentOverride={providerPicker}
            configControls={configControls}
            configNotes={configNotes}
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
