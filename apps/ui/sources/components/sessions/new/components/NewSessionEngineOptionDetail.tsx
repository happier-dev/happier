import * as React from 'react';

import { backendTargetKeysMatch } from '@/agents/backendCatalog/backendTargetKeyV2';
import { isNativeAutomaticModelSelectionInputV1, type SessionModelSelectionV1 } from '@happier-dev/protocol/providers/model-selection';
import { createPersonalSessionModelSelection, isSessionModelRefSourceBound, readSessionModelSelectionProviderConnectionId, type SessionModelSelection } from '@happier-dev/protocol/providers/selection/v2';
import type { QualifiedConnectedAccountPurposeBindingV1 } from '@happier-dev/protocol/connect/connectedAccountPurposeBindings';
import { useProviderSettingsForServer } from '@/providers/hooks/useProviderSettings';
import type { PersistedBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';

import { resolveCatalogAgentIdForBackendTarget } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { getAgentCore, isBundledAgentId, type AgentId } from '@/agents/catalog/catalog';
import { formatBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { AgentInputEngineDetail } from '@/components/sessions/agentInput/components/AgentInputEngineDetail';
import { agentInputChipPickerRailActionsRender } from '@/components/sessions/agentInput/components/AgentInputChipPickerOptionSelector';
import { mergeOptionPickerProbes } from '@/components/sessions/pickers/mergeOptionPickerProbes';
import type { OptionPickerProbeState } from '@/components/sessions/pickers/OptionPickerOverlay';
import { useNewSessionPreflightConfigOptionsState } from '@/components/sessions/new/hooks/screenModel/useNewSessionPreflightConfigOptionsState';
import {
    useNewSessionPreflightModelsState,
} from '@/components/sessions/new/hooks/screenModel/useNewSessionPreflightModelsState';
import type { NewSessionCapabilityProbeContext } from '@/components/sessions/new/modules/newSessionCapabilityProbeContext';
import { resolveNewSessionOperationalBackendTarget, withNewSessionConfigOptionOverrides } from '@/components/sessions/new/modules/newSessionCapabilityProbeContext';
import { sanitizeNewSessionConfigOverridesForModelSelection } from '@/components/sessions/new/modules/newSessionConfigOptionOverrideSanitization';
import { computeAcpConfigOptionControlsForProvider } from '@/sync/domains/sessionControl/configOptionsControl';
import type { FavoriteModelSelectionV1 } from '@/sync/domains/models/favoriteModelSelections';
import { projectFavoriteModelEntries } from '@/components/sessions/modelPicker/favoriteModelEntries';
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
    type SessionModelPickerProps,
    type SessionModelPickerExperimentalConfirmationController,
} from '@/components/sessions/modelPicker/SessionModelPicker';
import { PROVIDER_REASONING_EFFORT_OPTION_ID } from '@happier-dev/protocol/providers/catalog/reasoningEffort';
import { hiddenModelVisibilityKeys, resolveSessionModelSourceDescriptor } from '@/components/sessions/modelPicker/buildSessionModelPickerSections';
import { sessionModelSelectionKey, sessionModelPickerValueFromRef, isTeamCredentialProviderModelPickerValue, type SessionModelPickerValue } from '@/components/sessions/modelPicker/sessionModelSelectionKey';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { OPTION_PICKER_HEADER_ACTION_METRICS } from '@/components/sessions/pickers/OptionPickerOverlay';

import type { FavoriteModelTogglePayload } from '@/components/sessions/new/hooks/screenModel/newSessionFavoriteModelsPickerOption';

export type NewSessionEngineOptionDetailProps = Readonly<{
    backendTarget: PersistedBackendTargetRefV2;
    runtimeCarrierAgentId?: string | null;
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
    /** Several Sessions that run different models: no card is chosen and the running line says so. */
    mixedSelection?: SessionModelPickerProps['mixedSelection'];
    selectedModelId?: string | null;
    selectedModelSelection?: SessionModelSelection | null;
    selectedSessionModeId?: string | null;
    selectedConfigOverrides?: Readonly<Record<string, string>>;
    /** New Session reconciles Machine discovery in its authoring owner. */
    reconcileSelection?: boolean;
    favoriteModelSelections?: readonly FavoriteModelSelectionV1[];
    onToggleFavoriteModel?: (model: FavoriteModelTogglePayload) => void;
    onUpdateFavoriteModelReasoningEffort?: SessionModelPickerProps['onUpdateFavoriteModelReasoningEffort'];
    favoriteEngine?: Readonly<{
        favorite: boolean;
        onToggle: () => void;
    }>;
    /**
     * New Session owns the Provider-model projection for its selected target.
     * In-session callers omit this and retain the detail pane's local projection.
     */
    providerProjection?: ReturnType<typeof useProviderModelProjection>;
    connectedServices?: SessionModelPickerProps['connectedServices'];
    includeProviderConnectedAccounts?: boolean;
    teamModels?: Readonly<Pick<SessionModelPickerProps,
        'teamCredentialResources' | 'teamCredentialDisplayNames' | 'teamNameById' | 'homeNameByTeamId' | 'teamCredentialResourceStatusByKey'
        | 'selectedTeamCredentialModel' | 'onSelectTeamCredentialModel' | 'onRecoverTeamCredentialResource' | 'probe'> & {
        onSelectOtherModel: () => void;
        /** The inherited default's source for this Agent's selected model row; null when the person chose it. */
        modelAttribution?: Readonly<{ agentTargetKey: string; label: string | null }> | null;
    }>;
    /** The account or pool this Agent's own models run through, for the picker's native heading. */
    nativeSourceLabel?: string | null;
    experimentalConfirmation?: SessionModelPickerExperimentalConfirmationController;
    onSelectionChange?: (selection: Readonly<{
        modelId: string;
        modelSelection: SessionModelSelection | null;
        connectedAccountBinding?: QualifiedConnectedAccountPurposeBindingV1;
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
    return typeof value === 'string' && value.trim().length > 0 ? value : 'default';
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
            // The refresh control's twin beside it in the Model header: same box, glyph and touching gap.
            size={OPTION_PICKER_HEADER_ACTION_METRICS.boxPx}
            iconSize={OPTION_PICKER_HEADER_ACTION_METRICS.glyphPx}
            interactiveTargetGapPx={OPTION_PICKER_HEADER_ACTION_METRICS.interactiveTargetGapPx}
            tone={props.favorite ? 'primary' : 'default'}
            variant="plain"
            onPress={props.onToggle}
        />
    );
}

export function NewSessionEngineOptionDetail(props: NewSessionEngineOptionDetailProps) {
    const providerSettings = useProviderSettingsForServer(props.capabilityServerId);
    const [selectedConfigOverrides, setSelectedConfigOverrides] = React.useState<Readonly<Record<string, string>>>(() => props.selectedConfigOverrides ?? {});
    const capabilityProbeContext = withNewSessionConfigOptionOverrides(props.capabilityProbeContext, selectedConfigOverrides);
    const operationalBackendTarget = React.useMemo(() => resolveNewSessionOperationalBackendTarget({
        backendTarget: props.backendTarget,
        runtimeCarrierAgentId: props.runtimeCarrierAgentId,
    }), [props.backendTarget, props.runtimeCarrierAgentId]);
    const { usesNativeCatalog, connectedAccountSelected, modelOptions, preflightModels, probe: modelProbe } = useNewSessionPreflightModelsState({
        backendTarget: operationalBackendTarget,
        providerConnectionId: props.selectedModelSelection ? readSessionModelSelectionProviderConnectionId(props.selectedModelSelection) : null,
        runtimeCarrierAgentId: props.runtimeCarrierAgentId ?? null,
        selectedMachineId: props.selectedMachineId,
        capabilityServerId: props.capabilityServerId,
        cwd: props.cwd ?? null,
        probeContext: capabilityProbeContext,
        selectedTeamCredentialModel: props.teamModels?.selectedTeamCredentialModel,
    });
    const { configOptions, modelConfigOptionId, unavailable: configOptionsUnavailable, probe: configProbe } = useNewSessionPreflightConfigOptionsState({
        backendTarget: operationalBackendTarget,
        runtimeCarrierAgentId: props.runtimeCarrierAgentId ?? null,
        selectedMachineId: props.selectedMachineId,
        capabilityServerId: props.capabilityServerId,
        cwd: props.cwd ?? null,
        probeContext: capabilityProbeContext,
        enabled: usesNativeCatalog,
    });

    const [selectedModelId, setSelectedModelId] = React.useState(() => normalizeSelectedOptionId(props.selectedModelId));
    const [selectedModelSelection, setSelectedModelSelection] = React.useState<SessionModelSelection | null>(
        () => props.selectedModelSelection ?? null,
    );
    const [selectedSessionModeId, setSelectedSessionModeId] = React.useState(() => props.selectedSessionModeId ?? '');
    const selectionRef = React.useRef<Readonly<{
        modelId: string;
        modelSelection: SessionModelSelection | null;
        sessionModeId: string;
        configOverrides: Readonly<Record<string, string>>;
    }>>({
        modelId: normalizeSelectedOptionId(props.selectedModelId),
        modelSelection: props.selectedModelSelection ?? null,
        // An absent mode delegates to the Agent; model's `default` sentinel is not a native mode.
        sessionModeId: props.selectedSessionModeId ?? '',
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
        const nextSessionModeId = props.selectedSessionModeId ?? '';
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
        modelSelection: SessionModelSelection | null;
        sessionModeId: string;
        configOverrides: Readonly<Record<string, string>>;
    }>, connectedAccountBinding?: QualifiedConnectedAccountPurposeBindingV1) => {
        selectionRef.current = nextSelection;
        setSelectedModelId(nextSelection.modelId);
        setSelectedModelSelection(nextSelection.modelSelection);
        setSelectedSessionModeId(nextSelection.sessionModeId);
        setSelectedConfigOverrides(nextSelection.configOverrides);
        props.onSelectionChange?.({
            ...nextSelection,
            ...(connectedAccountBinding ? { connectedAccountBinding } : {}),
            // `default` names the Agent's own automatic model only when no
            // Provider connection is bound; a Provider may serve a model
            // literally named `default`, and that choice keeps its label.
            modelLabel: !(nextSelection.modelSelection && isSessionModelRefSourceBound(nextSelection.modelSelection.ref)) && isNativeAutomaticModelSelectionInputV1({
                providerConnectionId: nextSelection.modelSelection ? readSessionModelSelectionProviderConnectionId(nextSelection.modelSelection) : null,
                modelId: nextSelection.modelId,
            })
                ? null
                : resolveEffectiveModelLabel(modelOptions, nextSelection.modelId),
        });
    }, [modelOptions, props.onSelectionChange]);

    const catalogAgentId = React.useMemo<AgentId | null>(() => {
        if (isBundledAgentId(props.runtimeCarrierAgentId)) {
            return props.runtimeCarrierAgentId;
        }
        return resolveCatalogAgentIdForBackendTarget(operationalBackendTarget)
            ?? (isBundledAgentId(operationalBackendTarget.backendId) ? operationalBackendTarget.backendId : null);
    }, [operationalBackendTarget, props.runtimeCarrierAgentId]);
    const providerCore = React.useMemo(() => (
        catalogAgentId ? getAgentCore(catalogAgentId) : null
    ), [catalogAgentId]);
    const providerId = operationalBackendTarget.configuredBackendId ?? operationalBackendTarget.backendId;
    const providerSupportsFreeform = React.useMemo(() => {
        if (operationalBackendTarget.configuredBackendId) return true;
        return providerCore?.model?.supportsFreeform === true;
    }, [operationalBackendTarget.configuredBackendId, providerCore?.model?.supportsFreeform]);
    const canEnterCustomModel = preflightModels?.unavailable === true
        ? false
        : preflightModels?.supportsFreeform === true || providerSupportsFreeform;
    const selectedPickerValue = React.useMemo(() => sessionModelPickerValueFromRef(selectedModelSelection?.ref), [selectedModelSelection]);
    const sourceModelSelected = connectedAccountSelected || Boolean(
        (selectedModelSelection && isSessionModelRefSourceBound(selectedModelSelection.ref)) || props.teamModels?.selectedTeamCredentialModel,
    );
    const inheritedModel = props.teamModels?.modelAttribution;
    const managedModelSelected = Boolean(inheritedModel
        && backendTargetKeysMatch(inheritedModel.agentTargetKey, formatBackendTargetKeyV2(props.backendTarget)));
    const canonicalSelectedModelId = React.useMemo(() => (
        // Discovery supplies selectable rows; it must not replace inherited intent.
        // The shared picker presents a missing selection as typed unavailable.
        props.reconcileSelection === false || sourceModelSelected || managedModelSelected
            ? selectedModelId
            : resolveCanonicalModelOptionId(modelOptions, selectedModelId, modelProbe.failed || modelProbe.phase !== 'idle' ? null : preflightModels)
    ), [props.reconcileSelection, managedModelSelected, modelOptions, modelProbe.failed, modelProbe.phase, preflightModels, selectedModelId, sourceModelSelected]);
    // The caller's one line leads, then anything the probe has to report. One
    // section label, one subtitle, then the models — never a paragraph.
    const modelNotes = React.useMemo(
        () => [
            ...(props.modelSummary ? [props.modelSummary] : []),
            ...((preflightModels?.unavailable === true && !modelProbe.failed) && modelProbe.phase === 'idle'
                ? [t('agentInput.model.unavailable')]
                : []),
        ],
        [modelProbe.failed, modelProbe.phase, preflightModels?.unavailable, props.modelSummary],
    );
    const configNotes = React.useMemo(
        () => configProbe.failed && configProbe.refreshErrorMessage !== undefined
            ? [configProbe.refreshErrorMessage]
            // The machine that could not list its models could not list these either: one cause, one line.
            : configOptionsUnavailable && !modelProbe.failed && preflightModels?.unavailable !== true
            ? [t('agentInput.acp.optionsUnavailable')]
            : [],
        [configOptionsUnavailable, configProbe.failed, configProbe.refreshErrorMessage, modelProbe.failed, preflightModels?.unavailable],
    );

    const configControls = React.useMemo(
        () => computeAcpConfigOptionControlsForProvider({
            providerId,
            configOptions,
            hideModelOption: modelOptions.length > 0,
            modelConfigOptionId,
            modelDescriptors: modelOptions,
            overrides: Object.fromEntries(
                Object.entries(selectedConfigOverrides).map(([optionId, value]) => [optionId, { value }]),
            ),
        }) ?? [],
        [configOptions, modelConfigOptionId, modelOptions, providerId, selectedConfigOverrides],
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
        selectedModelConfigOptions?: Parameters<typeof sanitizeNewSessionConfigOverridesForModelSelection>[0]['selectedModelConfigOptions'],
    ) => sanitizeNewSessionConfigOverridesForModelSelection({
        providerId,
        configOptions,
        modelOptions,
        selectedModelId: modelId,
        selectedConfigOverrides: configOverrides,
        selectedModelConfigOptions,
    }), [configOptions, modelOptions, providerId]);

    React.useEffect(() => {
        if (props.reconcileSelection === false) return;
        const acceptedSnapshot = preflightModels && preflightModels.unavailable !== true
            && modelProbe.phase === 'idle' && !modelProbe.failed && !configProbe.failed && !configOptionsUnavailable
            && !sourceModelSelected;
        if (configProbe.phase !== 'idle' || !configOptions || (!configProbe.rejectedConfigOptionOverrides && !acceptedSnapshot)) return;
        const current = selectionRef.current.configOverrides;
        const reconciled = sanitizeNewSessionConfigOverridesForModelSelection({
            providerId, configOptions, modelOptions, selectedModelId: selectionRef.current.modelId,
            selectedConfigOverrides: current, rejectedConfigOptionOverrides: configProbe.rejectedConfigOptionOverrides,
        });
        if (Object.keys(current).length === Object.keys(reconciled).length
            && Object.entries(current).every(([id, value]) => reconciled[id] === value)) return;
        publishSelection({ ...selectionRef.current, configOverrides: reconciled });
    }, [props.reconcileSelection, configOptions, configOptionsUnavailable, configProbe.failed, configProbe.phase, configProbe.rejectedConfigOptionOverrides,
        modelOptions, modelProbe.failed, modelProbe.phase, preflightModels, providerId, publishSelection, sourceModelSelected]);

    const favoriteBackendIdentity = React.useMemo(() => buildFavoriteBackendIdentity({
        backendTargetKey: formatBackendTargetKeyV2(props.backendTarget),
        backendId: operationalBackendTarget.backendId,
        kind: operationalBackendTarget.configuredBackendId ? 'configuredBackend' : 'builtInAgent',
        catalogAgentId,
        builtInAgentId: operationalBackendTarget.configuredBackendId ? null : catalogAgentId,
    }), [catalogAgentId, operationalBackendTarget, props.backendTarget]);
    const agentTargetKey = favoriteBackendIdentity.backendTargetKey;
    const canonicalSelectedRef = React.useMemo(() => {
        if (selectedPickerValue) {
            if (sourceModelSelected || isTeamCredentialProviderModelPickerValue(selectedPickerValue)) return selectedPickerValue;
            return resolveCanonicalNativeModelSelectionRef(modelOptions, selectedPickerValue);
        }
        if (canonicalSelectedModelId === 'default') return null;
        return {
            agentTargetKey,
            providerConnectionId: null,
            modelId: canonicalSelectedModelId,
        };
    }, [agentTargetKey, canonicalSelectedModelId, modelOptions, selectedPickerValue, sourceModelSelected]);

    React.useEffect(() => {
        if (canonicalSelectedModelId === selectedModelId) return;
        if (sourceModelSelected || isTeamCredentialProviderModelPickerValue(canonicalSelectedRef)) return;
        const currentSelection = selectionRef.current.modelSelection;
        const modelSelection: SessionModelSelection | null = canonicalSelectedRef
            ? currentSelection?.v === 2 && currentSelection.ref.source === 'native'
                ? { ...currentSelection, updatedAt: Date.now(),
                    ref: { ...currentSelection.ref, modelId: canonicalSelectedRef.modelId } }
                : createPersonalSessionModelSelection(canonicalSelectedRef, Date.now())
            : null;
        publishSelection({
            ...selectionRef.current,
            modelId: canonicalSelectedModelId,
            modelSelection,
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
        sourceModelSelected,
    ]);
    const providersFeatureEnabled = useFeatureEnabled('providers', {
        scopeKind: 'spawn',
        serverId: props.capabilityServerId,
    });
    const localProviderProjection = useProviderModelProjection({
        enabled: !props.providerProjection && providersFeatureEnabled && props.selectedMachineId !== null,
        machineId: props.selectedMachineId,
        serverId: props.capabilityServerId,
        agentTargetKey,
        favoriteSelections: (props.favoriteModelSelections ?? []).map(favorite => favorite.selection.ref)
            .filter(ref => ref.agentTargetKey === agentTargetKey),
        ...(selectedPickerValue ? { currentSelection: selectedPickerValue } : {}),
    });
    const providerProjection = props.providerProjection ?? localProviderProjection;

    const unifiedProbe = React.useMemo(() => {
        return mergeOptionPickerProbes([
            props.refreshProbe ?? null,
            props.teamModels?.probe,
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
        props.teamModels?.probe,
        providerProjection.loading,
        providerProjection.refresh,
        providersFeatureEnabled,
    ]);

    const favoriteEntries = React.useMemo(
        () => projectFavoriteModelEntries(props.favoriteModelSelections ?? [], favoriteBackendIdentity),
        [favoriteBackendIdentity, props.favoriteModelSelections],
    );
    const providerGroups = providersFeatureEnabled ? (providerProjection.data?.groups ?? []) : [];
    const providerSourceBrowse = React.useMemo(() => ({
        machineId: props.selectedMachineId,
        serverId: props.capabilityServerId,
    }), [props.capabilityServerId, props.selectedMachineId]);
    const hiddenNativeModelKeys = React.useMemo(() => hiddenModelVisibilityKeys(
        providerSettings,
        { providersFeatureEnabled },
    ), [providersFeatureEnabled, providerSettings]);
    // Where the Agent rail draws its row star, a second one here would toggle the same favorite.
    const modelHeaderAccessory = props.favoriteEngine && !agentInputChipPickerRailActionsRender() ? (
        <EngineFavoriteToggle
            favorite={props.favoriteEngine.favorite}
            onToggle={props.favoriteEngine.onToggle}
        />
    ) : undefined;
    const modelAttribution = managedModelSelected ? inheritedModel?.label ?? null : null;
    const selectModel = (ref: SessionModelPickerValue, savedEffort?: string, connectedAccountBinding?: QualifiedConnectedAccountPurposeBindingV1) => {
        props.teamModels?.onSelectOtherModel();
        const selectedId = ref?.modelId ?? 'default';
        const modelId = ref && isSessionModelRefSourceBound(ref)
            ? selectedId
            : resolveCanonicalModelOptionId(modelOptions, selectedId);
        const canonicalRef = ref && modelId !== ref.modelId
            ? { ...ref, modelId }
            : ref;
        const sourceDescriptor = resolveSessionModelSourceDescriptor({
            selected: canonicalRef, providerGroups,
            teamCredentialResources: props.teamModels?.teamCredentialResources,
        });
        const overrides = selectionRef.current.configOverrides;
        const configOverrides = sanitizeConfigOverridesForModel(
            modelId,
            savedEffort === undefined ? overrides : { ...overrides, [PROVIDER_REASONING_EFFORT_OPTION_ID]: savedEffort },
            canonicalRef && isSessionModelRefSourceBound(canonicalRef) ? sourceDescriptor?.modelOptions ?? [] : undefined,
        );
        publishSelection({
            ...selectionRef.current,
            modelId,
            modelSelection: canonicalRef ? createPersonalSessionModelSelection(canonicalRef, Date.now()) : null,
            configOverrides,
        }, connectedAccountBinding);
        return true;
    };
    const providerPicker = (
        <SessionModelPicker
            fillAvailableSpace
            multiColumn
            agentTargetKey={agentTargetKey}
            connectedServices={props.connectedServices ?? capabilityProbeContext?.capabilityParams?.connectedServices}
            includeProviderConnectedAccounts={props.includeProviderConnectedAccounts}
            nativeModels={modelOptions}
            nativeSourceLabel={props.nativeSourceLabel}
            providerGroups={providerGroups}
            {...props.teamModels}
            selectedAttribution={modelAttribution}
            providerProjectionAuthoritative={providerProjection.status === 'success'}
            providerProjectionResolving={providerProjection.status === 'pending'}
            projectionError={providersFeatureEnabled ? providerProjection.error : null}
                projectionFailures={providersFeatureEnabled ? providerProjection.refreshFailures : []}
            retryProjection={providersFeatureEnabled ? providerProjection.refresh : null}
            projectionApproval={providersFeatureEnabled ? providerProjection.pendingApproval : null}
            currentSelectionRecovery={providersFeatureEnabled
                ? providerProjection.data?.currentSelectionRecovery ?? null
                : null}
            hiddenNativeModelKeys={hiddenNativeModelKeys}
            hiddenSources={providersFeatureEnabled ? providerProjection.data?.hiddenSources : undefined}
            sourceBrowse={providersFeatureEnabled ? providerSourceBrowse : undefined}
            selected={canonicalSelectedRef}
            mixedSelection={props.mixedSelection}
            canEnterCustomNativeValue={canEnterCustomModel}
            notes={modelNotes}
            probe={unifiedProbe}
            headerAccessory={modelHeaderAccessory}
            favoriteEntries={favoriteEntries}
            onUpdateFavoriteModelReasoningEffort={props.onUpdateFavoriteModelReasoningEffort}
            selectedOptionControls={selectedModelOptionControls ?? undefined}
            modelOptionOverrides={selectedConfigOverrides}
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
            onToggleFavorite={props.onToggleFavoriteModel ? (ref, reasoningEffort) => {
                const group = providerGroups.find((candidate) => candidate.rows.some((row) => (
                    sessionModelSelectionKey(row.ref) === sessionModelSelectionKey(ref)
                )));
                const row = group?.rows.find((candidate) => (
                    sessionModelSelectionKey(candidate.ref) === sessionModelSelectionKey(ref)
                ));
                props.onToggleFavoriteModel?.({
                    modelId: ref.modelId,
                    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
                    modelLabel: row?.descriptor.name ?? (ref.providerConnectionId === null
                        ? modelProbe.retainedModelName?.(ref.modelId)
                            ?? findModelOptionForEffectiveModelId(modelOptions, ref.modelId)?.label
                            ?? ref.modelId
                        : ref.modelId),
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
            onSelect={(ref, binding) => selectModel(ref, undefined, binding)}
            onSelectFavoriteModel={favoriteEntries.length > 0 ? selectModel : undefined}
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
        />
    );
}
