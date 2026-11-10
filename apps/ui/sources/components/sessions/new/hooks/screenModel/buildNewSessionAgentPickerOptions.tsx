import * as React from 'react';
import type { ConnectedServiceBindingsV2 } from '@happier-dev/protocol/connect/connected-service-bindings';

import { useUnistyles } from 'react-native-unistyles';

import type { AgentInputChipPickerOption } from '@/components/sessions/agentInput/components/AgentInputChipPickerTypes';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import type { NewSessionProfileAvailabilityReason } from '@/components/sessions/new/modules/newSessionAgentSelection';
import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import type { OptionPickerProbeState } from '@/components/sessions/pickers/OptionPickerOverlay';
import type { FavoriteModelSelectionV1 } from '@/sync/domains/models/favoriteModelSelections';
import type { NewSessionAgentPickerViewV1 } from '@/sync/domains/state/newSessionInteractionSchemas';
import type { SessionModelSelectionV1 } from '@happier-dev/protocol/providers/selection/v1';
import type { SessionModelPickerExperimentalConfirmationController } from '@/components/sessions/modelPicker/SessionModelPicker';
import type { NewSessionEngineOptionDetailProps } from '@/components/sessions/new/components/NewSessionEngineOptionDetail';
import { Icon } from '@/components/ui/icons/Icon';
import { t } from '@/text';
import { buildSessionAgentPickerOptions } from '@/components/sessions/agentPicker/buildSessionAgentPickerOptions';
import { mergeOptionPickerProbes } from '@/components/sessions/pickers/mergeOptionPickerProbes';
import type { MachineAgent } from '@/agents/machineAgents/machineAgentTypes';
import type { MachineAgentsSnapshot } from '@/agents/machineAgents/machineAgentInventoryStore';
import { resolveMachineAgentPickerPlacement, type MachineAgentPickerPlacement } from '@/components/machines/agents/machineAgentPresentation';
import { MachineAgentPickerMarker } from '@/components/machines/agents/MachineAgentPickerMarker';
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
    providerProjection?: NewSessionEngineOptionDetailProps['providerProjection'];
    teamModels?: NewSessionEngineOptionDetailProps['teamModels'];
    /** Known only for the selected Agent: the hook that resolves it follows the selection. */
    selectedNativeSourceLabel?: string | null;
    selectedConnectedServices?: ConnectedServiceBindingsV2 | null;
    experimentalConfirmation?: SessionModelPickerExperimentalConfirmationController;
    /** The agent on the composer's machine, from the one inventory owner (null: nothing known yet). */
    getBackendEntryMachineAgent?: (entry: ResolvedBackendCatalogEntry) => MachineAgent | null;
    /** The compact setup form for an agent that isn't ready here, shown in the right pane instead of its models. */
    renderMachineAgentSetup?: (entry: ResolvedBackendCatalogEntry, agent: MachineAgent) => React.ReactNode;
    /** Install from the rail's download glyph, through the install Action and its own confirmation. */
    installMachineAgent?: (agent: MachineAgent) => void;
    /** The composer's machine name, for the rail group headings. */
    selectedMachineName?: string | null;
    /**
     * The composer machine's inventory status, from the one inventory owner (`useMachineAgents`). While it has no
     * ready report, Agents are unready with no per-row reason; the open Agent's pane says why once.
     */
    machineAgentsStatus?: MachineAgentsSnapshot['status'];
}>;

type MachineAgentsPaneStatus = Readonly<{
    modelSummary?: string;
    refreshProbe?: OptionPickerProbeState | null;
}>;

/**
 * Why the strip's Agents are unready when the machine has not given a ready report, said once in the open Agent's
 * pane. The inventory owner's status is the only input; the per-entry `agent-not-ready` reason (the selection owner's
 * classification) only decides whether any Agent is waiting on it. A read failure is the pane's one failure line, whose
 * Retry is the caller's existing refresh (`refreshProbe`, which carries the inventory owner's refresh).
 */
function resolveMachineAgentsPaneStatus(params: Readonly<{
    status: MachineAgentsSnapshot['status'] | undefined;
    machineName: string | null | undefined;
    anyAgentWaitingOnMachine: boolean;
    refreshProbe: OptionPickerProbeState | null | undefined;
}>): MachineAgentsPaneStatus | null {
    if (!params.anyAgentWaitingOnMachine) return null;
    switch (params.status) {
        case undefined:
        case 'ready':
            return null;
        case 'offline':
            return { modelSummary: params.machineName
                ? t('machineAgents.offlineNote', { machine: params.machineName })
                : t('machineAgents.offlineUnknown') };
        // `idle` is the instant before the open picker's demand starts the check: the same fact for the person.
        case 'idle':
        case 'loading':
            return { modelSummary: t('machineAgents.checkingAgents') };
        case 'error':
            return { refreshProbe: mergeOptionPickerProbes([
                params.refreshProbe,
                { phase: 'idle', failed: true, refreshErrorMessage: t('machineAgents.unknown') },
            ]) ?? null };
    }
}

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

    const machineAgentsPaneStatus = resolveMachineAgentsPaneStatus({
        status: params.machineAgentsStatus,
        machineName: params.selectedMachineName,
        anyAgentWaitingOnMachine: sessionCapableBackendEntries.some((entry) => (
            params.getBackendEntryUnavailabilityReason?.(entry)?.startsWith('agent-not-ready:') === true
        )),
        refreshProbe: params.refreshProbe,
    });

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
                const setup = resolveMachineAgentSetupOption(params, entry);
                if (setup) {
                    return {
                        disabled: false,
                        muted: setup.placement.group !== 'onMachine',
                        ...(setup.placement.group === 'onMachine' ? {} : {
                            section: setup.placement.group === 'notOnMachine'
                                ? { id: 'notOnMachine', label: t('machineAgents.notOnThisMachineYet'), rank: 1 }
                                : { id: 'cantRun', label: t('machineAgents.cantRunOnThisMachine'), rank: 2 },
                        }),
                        statusMarker: <MachineAgentPickerMarker marker={setup.placement.marker} />,
                        ...(setup.placement.marker === 'download' && setup.agent.install.available && params.installMachineAgent ? {
                            statusAction: {
                                testID: `new-session-engine-install-rail:${entry.backendTargetKey}`,
                                accessibilityLabel: t('machineAgents.installAgent', { agent: setup.agent.title }),
                                onPress: () => params.installMachineAgent?.(setup.agent),
                            },
                        } : {}),
                    };
                }
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
            resolveBehavior: ({ entry, presentation, favorite }) => {
                // Ineligible executables open setup. Credential choice stays in
                // model/source detail and is admitted separately at Start.
                const setup = resolveMachineAgentSetupOption(params, entry);
                if (setup && params.renderMachineAgentSetup) {
                    const renderSetup = params.renderMachineAgentSetup;
                    return {
                        closeOnSelectImmediate: false,
                        renderDetailContent: () => renderSetup(entry, setup.agent),
                    };
                }
                return buildNewSessionAgentPickerOptionInteractions({
                entry,
                disabled: presentation.disabled,
                selectedMachineId: params.selectedMachineId,
                capabilityServerId: params.capabilityServerId,
                selectedPath: params.selectedPath,
                        refreshProbe: params.refreshProbe,
                favoriteModelSelections: params.favoriteModelSelections ?? [],
                onToggleFavoriteModel: params.onToggleFavoriteModel,
                favoriteEngine: params.onToggleFavoriteBackendTarget ? {
                    favorite,
                    onToggle: () => {
                        params.onToggleFavoriteBackendTarget?.(entry.backendTargetKey);
                    },
                } : undefined,
                ...(params.providerProjection ? { providerProjection: params.providerProjection } : {}),
                teamModels: params.teamModels,
                nativeSourceLabel: entry.backendTargetKey === params.selectedBackendTargetKey ? params.selectedNativeSourceLabel : null,
                ...(entry.backendTargetKey === params.selectedBackendTargetKey && 'selectedConnectedServices' in params
                    ? { connectedServices: params.selectedConnectedServices } : {}),
                experimentalConfirmation: params.experimentalConfirmation,
                onRememberAgentPickerView: params.onRememberAgentPickerView,
                getEngineSelectionForTargetKey: params.getEngineSelectionForTargetKey,
                selectEngineSelection: params.selectEngineSelection,
                modelSummary: machineAgentsPaneStatus?.modelSummary,
                ...(machineAgentsPaneStatus?.refreshProbe ? { refreshProbe: machineAgentsPaneStatus.refreshProbe } : {}),
                });
            },
        }),
        selectableBackendEntries,
    };
}

function resolveMachineAgentSetupOption(
    params: Pick<BuildNewSessionAgentPickerOptionsParams, 'getBackendEntryMachineAgent' | 'renderMachineAgentSetup' | 'isBackendEntrySelectable'>,
    entry: ResolvedBackendCatalogEntry,
): Readonly<{ agent: MachineAgent; placement: MachineAgentPickerPlacement }> | null {
    if (!params.renderMachineAgentSetup || params.isBackendEntrySelectable(entry)) return null;
    const agent = params.getBackendEntryMachineAgent?.(entry) ?? null;
    const placement = resolveMachineAgentPickerPlacement(agent);
    return agent && placement.opensSetup ? { agent, placement } : null;
}
