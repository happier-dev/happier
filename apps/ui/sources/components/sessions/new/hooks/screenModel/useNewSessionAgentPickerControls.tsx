import * as React from 'react';
import type { ConnectedServiceBindingsV2 } from '@happier-dev/protocol/connect/connected-service-bindings';

import type { AgentInputChipPickerOption } from '@/components/sessions/agentInput/components/AgentInputChipPickerTypes';
import { buildAcpConfigOptionOverridesV1 } from '@happier-dev/protocol/sessions/metadata/overrides';
import type { PersistedBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { SessionModelSelectionV1 } from '@happier-dev/protocol/providers/model-selection';
import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import type { NewSessionProfileAvailabilityReason } from '@/components/sessions/new/modules/newSessionAgentSelection';
import type { ModelMode } from '@/sync/domains/permissions/permissionTypes';
import type { NewSessionAgentPickerViewV1 } from '@/sync/domains/state/newSessionInteractionSchemas';
import { favoriteModelRefIdentityKey } from '@happier-dev/protocol/providers/modelFavoritesV1';
import { toggleFavoriteBackendTargetKey } from '@/sync/domains/session/authoring/favoriteBackendTargets';
import type { OptionPickerProbeState } from '@/components/sessions/pickers/OptionPickerOverlay';
import type { RememberedEngineSelectionsByScopeV1 } from '@/sync/domains/session/authoring/rememberedEngineSelections';
import {
    favoriteModelSelectionMatchesBackend,
    getFavoriteModelRef,
    rememberFavoriteModelReasoningEffort,
    toggleFavoriteModelSelection,
    type FavoriteModelSelectionV1,
} from '@/sync/domains/models/favoriteModelSelections';
import { buildNewSessionAgentPickerOptions } from './buildNewSessionAgentPickerOptions';
import type { MachineAgent } from '@/agents/machineAgents/machineAgentTypes';
import type { MachineAgentsSnapshot } from '@/agents/machineAgents/machineAgentInventoryStore';
import { MachineAgentSetupPane } from '@/components/machines/agents/MachineAgentSetupPane';
import { useMachineAgentRowActions } from '@/components/machines/agents/useMachineAgentRowActions';
import { canManageMachine } from '@/sync/domains/machines/canManageMachine';
import { useServerScopedMachine } from '@/sync/store/hooks';
import {
    FAVORITE_MODELS_AGENT_PICKER_OPTION_ID,
    type FavoriteModelTogglePayload,
} from './newSessionFavoriteModelsPickerOption';
import { buildFavoriteBackendIdentity } from '@/sync/domains/models/favoriteModelBackendIdentity';
import { resolveNewSessionAgentPickerSingleSelectFallbackEntry } from './resolveNewSessionAgentPickerDispatch';
import { useSessionAgentPickerControls } from '@/components/sessions/agentPicker/useSessionAgentPickerControls';
import type { useNewSessionAgentPickerEngineSelectionState } from './useNewSessionAgentPickerEngineSelectionState';
import type { SessionModelPickerExperimentalConfirmationController } from '@/components/sessions/modelPicker/SessionModelPicker';
import type { NewSessionEngineOptionDetailProps } from '@/components/sessions/new/components/NewSessionEngineOptionDetail';
import { useEventCallback } from '@/hooks/ui/useEventCallback';

// The picker row is the form here: pressing the install glyph also opens the row.
const openNoForm = () => {};

export function useNewSessionAgentPickerControls(params: Readonly<{
    engineSelectionState: ReturnType<typeof useNewSessionAgentPickerEngineSelectionState>;
    useProfiles: boolean;
    selectedProfileId: string | null;
    profileMap: ReadonlyMap<string, AIBackendProfile>;
    resolvedBackendEntries: readonly ResolvedBackendCatalogEntry[];
    getCompatibleProfileBackendEntries: (profile: AIBackendProfile) => readonly ResolvedBackendCatalogEntry[];
    isBackendEntrySelectable: (entry: ResolvedBackendCatalogEntry) => boolean;
    getBackendEntryUnavailabilityReason?: (entry: ResolvedBackendCatalogEntry) => NewSessionProfileAvailabilityReason | null;
    selectedBackendEntry: ResolvedBackendCatalogEntry | null;
    selectedBackendTargetKey: string;
    setBackendTarget: React.Dispatch<React.SetStateAction<PersistedBackendTargetRefV2>>;
    modelMode: ModelMode;
    modelSelection?: Parameters<typeof useNewSessionAgentPickerEngineSelectionState>[0]['modelSelection'];
    canRetainModelSelection?: Parameters<typeof useNewSessionAgentPickerEngineSelectionState>[0]['canRetainModelSelection'];
    setModelMode: React.Dispatch<React.SetStateAction<ModelMode>>;
    acpSessionModeId: string | null;
    setAcpSessionModeId: React.Dispatch<React.SetStateAction<string | null>>;
    sessionConfigOptionOverrides: ReturnType<typeof buildAcpConfigOptionOverridesV1> | null;
    setSessionConfigOptionOverrides: React.Dispatch<React.SetStateAction<ReturnType<typeof buildAcpConfigOptionOverridesV1> | null>>;
    setEngineSelectionForBackendTarget?: Parameters<typeof useNewSessionAgentPickerEngineSelectionState>[0]['setEngineSelectionForBackendTarget'];
    selectedMachineId: string | null;
    /** The composer machine's display name (rail group headings: "Not on devbox yet"). */
    selectedMachineName?: string | null;
    /** The composer machine's inventory status (`useMachineAgents`): an offline machine is said once in the pane. */
    machineAgentsStatus?: MachineAgentsSnapshot['status'];
    /** The agent on the composer's machine, from the one inventory owner (`useMachineAgents`). */
    getBackendEntryMachineAgent?: (entry: ResolvedBackendCatalogEntry) => MachineAgent | null;
    capabilityServerId: string;
    projectionCurrent: boolean;
    selectedPath: string | null;
    favoriteModelSelections?: readonly FavoriteModelSelectionV1[];
    setFavoriteModelSelections?: (favorites: FavoriteModelSelectionV1[]) => void;
    favoriteBackendTargetKeys?: ReadonlyArray<string>;
    setFavoriteBackendTargetKeys?: (favorites: string[]) => void;
    initialAgentPickerView?: NewSessionAgentPickerViewV1;
    onRememberAgentPickerView?: (view: NewSessionAgentPickerViewV1) => void;
    rememberEngineSelectionsEnabled?: boolean;
    rememberedEngineSelectionsByScope?: RememberedEngineSelectionsByScopeV1 | null;
    rememberedEngineSelectionServerId?: string | null;
    onRememberEngineSelection?: Parameters<typeof useNewSessionAgentPickerEngineSelectionState>[0]['onRememberEngineSelection'];
    onExplicitBackendTargetSelection?: Parameters<typeof useNewSessionAgentPickerEngineSelectionState>[0]['onExplicitBackendTargetSelection'];
    /**
     * Optional probe surface to merge into the engine detail pane's refresh affordance.
     * This is used to make the model refresh button also refresh CLI detection.
     */
    refreshProbe?: OptionPickerProbeState | null;
    providerProjection?: NewSessionEngineOptionDetailProps['providerProjection'];
    teamModels?: NewSessionEngineOptionDetailProps['teamModels'];
    selectedNativeSourceLabel?: string | null;
    selectedConnectedServices?: ConnectedServiceBindingsV2 | null;
    experimentalConfirmation?: SessionModelPickerExperimentalConfirmationController;
}>): Readonly<{
    agentPickerOptions?: ReadonlyArray<AgentInputChipPickerOption>;
    agentPickerSelectedOptionId?: string | null;
    handleAgentPickerSelect: (selectedId: string) => void;
    handleAgentClick: () => void;
}> {
    const canManage = useServerScopedMachine(params.capabilityServerId, params.selectedMachineId, canManageMachine);
    // Focus memory seeds the next opening; it never steers the mounted picker.
    const [rememberedAgentPickerView, setRememberedAgentPickerView] = React.useState(
        () => params.initialAgentPickerView ?? null,
    );
    const rememberAgentPickerView = React.useCallback((view: NewSessionAgentPickerViewV1) => {
        setRememberedAgentPickerView((previous) => {
            if (previous?.kind !== view?.kind) return view;
            if (previous?.kind === 'backend' && view?.kind === 'backend'
                && previous.backendTargetKey !== view.backendTargetKey) return view;
            return previous;
        });
        params.onRememberAgentPickerView?.(view);
    }, [params.onRememberAgentPickerView]);
    const { getEngineSelectionForTargetKey } = params.engineSelectionState;
    // Keep the row projection keyed on presented facts. Its actions still enter the current draft.
    const selectEngineSelection = useEventCallback(params.engineSelectionState.selectEngineSelection);
    const selectBackendTarget = useEventCallback(params.engineSelectionState.selectBackendTarget);

    const selectedBackendTargetKey = params.selectedBackendEntry?.backendTargetKey ?? params.selectedBackendTargetKey;

    // The rail's install glyph starts the same install Action the setup form does; the row's own press
    // opens the setup pane, which follows the job.
    const runMachineAgentAction = useMachineAgentRowActions({
        serverId: params.capabilityServerId,
        machineId: params.selectedMachineId ?? '',
        machineName: params.selectedMachineName ?? '',
        onOpenForm: openNoForm,
    });

    const handleToggleFavoriteBackendTarget = React.useCallback((targetKey: string) => {
        if (!params.setFavoriteBackendTargetKeys) return;
        params.setFavoriteBackendTargetKeys(toggleFavoriteBackendTargetKey(
            params.favoriteBackendTargetKeys ?? [],
            targetKey,
        ));
    }, [
        params.favoriteBackendTargetKeys,
        params.setFavoriteBackendTargetKeys,
    ]);

    const handleToggleFavoriteModel = React.useCallback((
        entry: ResolvedBackendCatalogEntry,
        model: FavoriteModelTogglePayload,
    ) => {
        if (!params.setFavoriteModelSelections) return;
        params.setFavoriteModelSelections(toggleFavoriteModelSelection({
            favorites: params.favoriteModelSelections ?? [],
            backend: buildFavoriteBackendIdentity(entry),
            modelRef: model.modelSelection?.ref ?? {
                agentTargetKey: entry.backendTargetKey,
                providerConnectionId: null,
                modelId: model.modelId,
            },
            modelLabel: model.modelLabel,
            backendLabel: entry.title,
            providerDisplaySnapshot: model.providerDisplaySnapshot,
            reasoningEffort: model.reasoningEffort,
            addedAtMs: Date.now(),
        }));
    }, [
        params.favoriteModelSelections,
        params.setFavoriteModelSelections,
    ]);

    const handleSelectFavoriteModel = React.useCallback((
        entry: ResolvedBackendCatalogEntry,
        modelSelection: SessionModelSelectionV1,
        configOverrides?: Readonly<Record<string, string>>,
    ) => {
        params.teamModels?.onSelectOtherModel();
        const nextSelection = {
            ...getEngineSelectionForTargetKey(entry.backendTargetKey),
            modelId: modelSelection.ref.modelId,
            modelSelection,
            ...(configOverrides ? { configOverrides } : {}),
        };
        selectEngineSelection(entry, nextSelection);
    }, [getEngineSelectionForTargetKey, params.teamModels, selectEngineSelection]);

    const handleSelectFavoriteModelOptionValue = React.useCallback((
        entry: ResolvedBackendCatalogEntry,
        modelSelection: SessionModelSelectionV1,
        configId: string,
        valueId: string,
    ) => {
        params.teamModels?.onSelectOtherModel();
        const currentSelection = getEngineSelectionForTargetKey(entry.backendTargetKey);
        selectEngineSelection(entry, {
            ...currentSelection,
            modelId: modelSelection.ref.modelId,
            modelSelection,
            configOverrides: {
                ...currentSelection.configOverrides,
                [configId]: valueId,
            },
        });
    }, [
        getEngineSelectionForTargetKey,
        params.teamModels,
        selectEngineSelection,
    ]);

    const handleUpdateFavoriteModelReasoningEffort = React.useCallback((
        ref: SessionModelSelectionV1['ref'],
        reasoningEffort: string,
    ) => {
        const nextFavorites = rememberFavoriteModelReasoningEffort(params.favoriteModelSelections ?? [], ref, reasoningEffort);
        if (nextFavorites) params.setFavoriteModelSelections?.(nextFavorites);
    }, [params.favoriteModelSelections, params.setFavoriteModelSelections]);

    const handleRemoveFavoriteModelSelection = React.useCallback((favorite: FavoriteModelSelectionV1) => {
        if (!params.setFavoriteModelSelections) return;
        const identity = favoriteModelRefIdentityKey(getFavoriteModelRef(favorite));
        params.setFavoriteModelSelections((params.favoriteModelSelections ?? []).filter((candidate) => (
            favoriteModelRefIdentityKey(getFavoriteModelRef(candidate)) !== identity
        )));
    }, [
        params.favoriteModelSelections,
        params.setFavoriteModelSelections,
    ]);

    const {
        agentPickerOptions,
        selectableBackendEntries,
    } = React.useMemo(() => buildNewSessionAgentPickerOptions({
        useProfiles: params.useProfiles,
        selectedProfileId: params.selectedProfileId,
        profileMap: params.profileMap,
        resolvedBackendEntries: params.resolvedBackendEntries,
        getCompatibleProfileBackendEntries: params.getCompatibleProfileBackendEntries,
        isBackendEntrySelectable: params.isBackendEntrySelectable,
        getBackendEntryUnavailabilityReason: params.getBackendEntryUnavailabilityReason,
        getEngineSelectionForTargetKey,
        selectEngineSelection,
        selectedMachineId: params.selectedMachineId,
        selectBackendTarget,
        capabilityServerId: params.capabilityServerId,
        projectionCurrent: params.projectionCurrent,
        selectedPath: params.selectedPath,
        selectedBackendTargetKey,
        selectedModelId: String(params.modelMode),
        selectedModelSelection: params.modelSelection ?? null,
        refreshProbe: params.refreshProbe,
        favoriteModelSelections: params.favoriteModelSelections ?? [],
        favoriteBackendTargetKeys: params.favoriteBackendTargetKeys ?? [],
        onSelectFavoriteModel: handleSelectFavoriteModel,
        selectedConfigOverrides: getEngineSelectionForTargetKey(selectedBackendTargetKey).configOverrides,
        onSelectFavoriteModelOptionValue: handleSelectFavoriteModelOptionValue,
        onUpdateFavoriteModelReasoningEffort: params.setFavoriteModelSelections ? handleUpdateFavoriteModelReasoningEffort : undefined,
        onToggleFavoriteModel: handleToggleFavoriteModel,
        onToggleFavoriteBackendTarget: params.setFavoriteBackendTargetKeys ? handleToggleFavoriteBackendTarget : undefined,
        onRemoveFavoriteModelSelection: handleRemoveFavoriteModelSelection,
        onRememberAgentPickerView: rememberAgentPickerView,
        ...(params.providerProjection ? { providerProjection: params.providerProjection } : {}),
        teamModels: params.teamModels,
        selectedNativeSourceLabel: params.selectedNativeSourceLabel,
        ...('selectedConnectedServices' in params ? { selectedConnectedServices: params.selectedConnectedServices } : {}),
        experimentalConfirmation: params.experimentalConfirmation,
        ...(params.getBackendEntryMachineAgent && params.selectedMachineId ? {
            getBackendEntryMachineAgent: params.getBackendEntryMachineAgent,
            selectedMachineName: params.selectedMachineName ?? null,
            machineAgentsStatus: params.machineAgentsStatus,
            installMachineAgent: (agent: MachineAgent) => runMachineAgentAction(agent, { kind: 'install' }),
            canManageMachine: canManage,
            renderMachineAgentSetup: (_entry: ResolvedBackendCatalogEntry, agent: MachineAgent) => (
                <MachineAgentSetupPane
                    agent={agent}
                    serverId={params.capabilityServerId}
                    machineId={params.selectedMachineId!}
                    machineName={params.selectedMachineName ?? ''}
                />
            ),
        } : {}),
    }), [
        canManage,
        params.getBackendEntryMachineAgent,
        params.selectedMachineName,
        params.machineAgentsStatus,
        runMachineAgentAction,
        getEngineSelectionForTargetKey,
        handleSelectFavoriteModelOptionValue,
        handleUpdateFavoriteModelReasoningEffort,
        params.capabilityServerId,
        params.favoriteBackendTargetKeys,
        params.favoriteModelSelections,
        params.getBackendEntryUnavailabilityReason,
        params.getCompatibleProfileBackendEntries,
        params.isBackendEntrySelectable,
        params.modelMode,
        params.modelSelection,
        params.profileMap,
        params.projectionCurrent,
        params.providerProjection,
        params.teamModels,
        params.selectedNativeSourceLabel,
        params.selectedConnectedServices,
        params.refreshProbe,
        params.resolvedBackendEntries,
        params.selectedMachineId,
        params.selectedPath,
        params.selectedProfileId,
        params.setFavoriteBackendTargetKeys,
        params.setFavoriteModelSelections,
        selectedBackendTargetKey,
        params.useProfiles,
        rememberAgentPickerView,
        params.experimentalConfirmation,
        handleSelectFavoriteModel,
        handleRemoveFavoriteModelSelection,
        handleToggleFavoriteBackendTarget,
        handleToggleFavoriteModel,
        selectEngineSelection,
        selectBackendTarget,
    ]);

    const fallbackOptionId = params.selectedBackendEntry?.backendTargetKey ?? params.selectedBackendTargetKey;
    const preferredOptionId = React.useMemo(() => {
        if (rememberedAgentPickerView?.kind === 'favoriteModels') {
            return FAVORITE_MODELS_AGENT_PICKER_OPTION_ID;
        }
        // A remembered backend view only survives while it still matches the selected
        // engine; an external change to the selection must not restore a stale detail pane.
        if (rememberedAgentPickerView?.kind === 'backend' && rememberedAgentPickerView.backendTargetKey === fallbackOptionId) {
            return rememberedAgentPickerView.backendTargetKey;
        }
        return null;
    }, [fallbackOptionId, rememberedAgentPickerView]);

    const {
        agentPickerSelectedOptionId,
        handleAgentPickerSelect,
    } = useSessionAgentPickerControls({
        options: agentPickerOptions,
        selectableEntries: selectableBackendEntries,
        fallbackOptionId,
        preferredOptionId,
        onSelectEntry: (nextEntry) => {
            rememberAgentPickerView({
                kind: 'backend',
                backendTargetKey: nextEntry.backendTargetKey,
            });
            selectBackendTarget(nextEntry);
        },
        onSelectNonEntryOption: (selectedId) => {
            if (selectedId !== FAVORITE_MODELS_AGENT_PICKER_OPTION_ID) return;
            rememberAgentPickerView({ kind: 'favoriteModels' });
        },
    });

    const handleAgentClick = React.useCallback(() => {
        const nextEntry = resolveNewSessionAgentPickerSingleSelectFallbackEntry({
            selectableBackendEntries,
            selectedBackendTargetKey,
        });
        if (nextEntry) {
            selectBackendTarget(nextEntry);
        }
    }, [
        selectBackendTarget,
        selectedBackendTargetKey,
        selectableBackendEntries,
    ]);

    return {
        agentPickerOptions,
        agentPickerSelectedOptionId,
        handleAgentPickerSelect,
        handleAgentClick,
    };
}
