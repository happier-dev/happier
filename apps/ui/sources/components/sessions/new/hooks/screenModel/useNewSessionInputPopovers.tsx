import * as React from 'react';

import { useModalPortalTarget } from '@/modal/portal/ModalPortalTarget';
import type { AgentInputContentPopoverConfig } from '@/components/sessions/agentInput/components/AgentInputContentPopover';
import { NewSessionPathSelectionContent } from '@/components/sessions/new/components/NewSessionPathSelectionContent';
import { NewSessionMachineSelectionContent, type NewSessionMachineSelectionContentProps } from '@/components/sessions/new/components/NewSessionMachineSelectionContent';
import { NewSessionResumeSelectionContent } from '@/components/sessions/new/components/NewSessionResumeSelectionContent';
import type { ServerScopedMachineGroup } from '@/components/sessions/new/hooks/machines/useServerScopedMachineOptions';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { getStorage } from '@/sync/domains/state/storageStore';
import { useProfile as useAccountProfile } from '@/sync/store/hooks';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { getConnectedMetadataCatalog } from '@/sync/store/settings/connectedMetadataCatalogSnapshot';
import { t } from '@/text';
import { announceAccessibilityMessage } from '@/components/ui/accessibility/announceAccessibilityMessage';
import { openExternalSessionsResumeIdPickerModal } from '@/components/sessions/external/browse/openExternalSessionsResumeIdPickerModal';
import { canBrowseExternalSessions, resolveExternalSessionBrowseLockedSource } from '@/components/sessions/external/browse/resolveExternalSessionBrowseLockedSourceOption';
import type { PluginProjectionV2} from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { SessionAuthoringExecutionTargetV2 } from '@happier-dev/protocol/sessions/authoring/fieldCatalog';
import type { RunnerArtifactTarget } from '@happier-dev/protocol/ephemeralRunner/runnerArtifact';
import type { ManagedSessionPlacementV1 } from '@happier-dev/protocol/teams/managedDefaults';
import type { ServerScopedMachinePoolGroup } from '@/components/sessions/new/components/machineSelection/useMachineSelectionListModel';
import { useMachinePoolSelection } from '@/components/sessions/new/hooks/machines/useMachinePoolSelection';
import type { TemporaryComputerAvailability } from '@/components/sessions/new/hooks/useTemporaryComputerAvailability';
import type { TemporaryComputerLaunchBlock } from '@/components/sessions/new/hooks/temporaryComputerLaunchReadiness';
import {
    describeTemporaryComputerLaunchBlock,
    describeTemporaryComputerUnavailability,
} from '@/components/sessions/new/hooks/temporaryComputerCopy';
import { buildTemporaryComputerSelectionRows } from '@/components/sessions/new/components/machineSelection/buildTemporaryComputerSelectionRows';
import { managedMachineSelectionOptionId, type ManagedMachineSelectionDraft, type ManagedMachineSelectionOffer, type ManagedMachineUse } from '@/components/sessions/new/components/machineSelection/managedMachineSelection';
import { SELECTION_LIST_LARGE_POPOVER_SIZE } from '@/components/ui/selectionList';
import { useNewSessionPlacementSessions } from './useNewSessionPlacementSessions';
import { createNewSessionPlacementCandidatesSection } from '@/components/sessions/new/newSessionPlacementSelectionStep';
import type { SessionPlacementCandidateRow } from '@/components/sessions/new/serverStartDraftCandidateSelection';
import type { PluginUiSessionPlacementCandidateV1 } from '@happier-dev/protocol/plugins/ui';
import { useNewSessionMachinePickerInventory, type NewSessionMachinePickerInventory } from './useNewSessionMachinePickerInventory';

type MachineSelectionContentProps = NewSessionMachineSelectionContentProps<Machine>;

function NewSessionPopoverMachineInventoryContent(params: MachineSelectionContentProps & Readonly<{
    inventory: NewSessionMachinePickerInventory;
}>) {
    const { inventory, ...content } = params;
    const { groups, poolGroups, recentMachines, favoriteMachineItems } = useNewSessionMachinePickerInventory(inventory);
    return <NewSessionMachineSelectionContent {...content} groups={groups} poolGroups={poolGroups}
        recentMachines={recentMachines} favoriteMachines={favoriteMachineItems} />;
}

function NewSessionPopoverMachineSelectionContent(params: MachineSelectionContentProps & Readonly<{
    inventory?: NewSessionMachinePickerInventory;
}>) {
    const { inventory, ...content } = params;
    return inventory
        ? <NewSessionPopoverMachineInventoryContent {...content} inventory={inventory} />
        : <NewSessionMachineSelectionContent {...content} />;
}

function NewSessionPopoverPathSelectionContent(params: React.ComponentProps<typeof NewSessionPathSelectionContent> & Readonly<{
    readRecentPaths?: () => ReadonlyArray<string>;
}>) {
    const { readRecentPaths, ...content } = params;
    useNewSessionPlacementSessions(Boolean(readRecentPaths));
    return <NewSessionPathSelectionContent {...content} recentPaths={readRecentPaths?.() ?? content.recentPaths} />;
}

export const LARGE_PICKER_LAYOUT: Pick<
    AgentInputContentPopoverConfig,
    'maxHeightCap' | 'maxWidthCap' | 'keyboardShouldPersistTaps' | 'edgeFades' | 'edgeIndicators' | 'initialVisibility' | 'phonePresentation'
> = {
    ...SELECTION_LIST_LARGE_POPOVER_SIZE,
    // A phone gets the shared bottom sheet for the composer's long pickers (lab m-pick Ap), not a
    // floating card squeezed above the chip row.
    phonePresentation: 'sheet',
    keyboardShouldPersistTaps: 'handled',
    edgeFades: { top: true, bottom: true, size: 28 },
    edgeIndicators: true,
    initialVisibility: { top: true, bottom: true },
};

type ExternalSessionBrowseLockContext = Parameters<typeof resolveExternalSessionBrowseLockedSource>[0];

function buildNewSessionPopoverSignature(value: unknown): string {
    try {
        return JSON.stringify(value) ?? 'null';
    } catch {
        return 'unserializable';
    }
}

function useLatestRef<Value>(value: Value): React.MutableRefObject<Value> {
    const ref = React.useRef(value);
    ref.current = value;
    return ref;
}

export function useNewSessionInputPopovers(params: Readonly<{
    selectedMachine: Machine | null;
    selectedMachineId: string | null;
    selectedPath: string;
    setSelectedPath: React.Dispatch<React.SetStateAction<string>>;
    setDraftSelectedPath: (path: string) => void;
    /** The draft has no folder; the picker marks "No folder". */
    noFolderSelected: boolean;
    /** Chooses no folder; absent where no-folder is not offered (Temporary computer). */
    onSelectNoFolder?: () => void;
    /** A seeded draft's unresolved saved projects: the folder picker lists them first. */
    placementCandidates?: Readonly<{
        rows: readonly SessionPlacementCandidateRow[];
        onSelect: (candidate: PluginUiSessionPlacementCandidateV1) => void;
    }>;
    recentPaths: ReadonlyArray<string>;
    readRecentPaths?: () => ReadonlyArray<string>;
    usePathPickerSearch: boolean;
    pathPickerSearchQuery: string;
    setPathPickerSearchQuery: React.Dispatch<React.SetStateAction<string>>;
    favoriteDirectories: ReadonlyArray<string>;
    setFavoriteDirectories: (value: string[]) => void;
    /**
     * The one resolved Home-group set the screen already used to project Pools. Machines and Pools
     * must never be scoped to different Homes, including explicit-settings-rejected recovery, so the
     * popover consumes that exact set instead of resolving a second one.
     */
    machineGroups: ReadonlyArray<ServerScopedMachineGroup>;
    /** Closed simple composers carry intent; full inventory mounts inside the open popover. */
    machineInventory?: NewSessionMachinePickerInventory;
    selectedServerId: string | null;
    recentMachines: ReadonlyArray<Machine>;
    favoriteMachineItems: ReadonlyArray<Machine>;
    selectMachineTarget: (machine: Machine, serverId: string | null) => void;
    toggleFavoriteMachine: (machine: Machine) => void;
    useMachinePickerSearch: boolean;
    machinePoolGroups: ReadonlyArray<ServerScopedMachinePoolGroup>;
    machinePoolRequestKey: string;
    selectMachinePoolTarget: (target: Readonly<{ serverId: string; poolId: string; machineId: string }>) => void;
    executionTarget: SessionAuthoringExecutionTargetV2 | null;
    managedMachines?: readonly ManagedMachineSelectionOffer[];
    selectedManagedMachine?: ManagedMachineSelectionDraft | null;
    managedPlacementPreset?: Extract<ManagedSessionPlacementV1, { kind: 'preset' }> | null;
    onSelectManagedMachine?: ManagedMachineUse;
    /** Whether the composer holds a drafted prompt; a getter, so typing never re-renders the picker. */
    managedMachineStartsSession?: () => boolean;
    temporaryComputerAvailability: TemporaryComputerAvailability;
    /**
     * Exact launch-readiness block for the current authoring selection, or null.
     * The destination stays offerable either way; this only explains it.
     */
    temporaryComputerLaunchBlock: TemporaryComputerLaunchBlock | null;
    selectTemporaryComputer: (
        artifactTarget: RunnerArtifactTarget,
        workspace: Extract<SessionAuthoringExecutionTargetV2, { kind: 'temporary_computer' }>['workspace'],
        packageExpiresAt?: number,
    ) => void;
    /** Existing canonical Machine refresh, used when the Home Machine projection failed. */
    onRefreshMachines: () => void;
    /** Existing canonical Pool refresh, offered beside a failed or unavailable Pool row. */
    onRefreshMachinePools: (serverId: string) => void;
    /** Existing Machine Pool settings route, offered when the activated Pool has no enabled member. */
    onOpenMachinePoolSettings: (target: Readonly<{ serverId: string; poolId: string }>) => void;
    /** Existing Machines presets route, the managed group's trailing destination. */
    onOpenMachinePresets?: () => void;
    /** Existing Add a machine route, the machine list's last row. */
    onOpenAddMachine?: () => void;
    targetServerId: string | null;
    externalSessionsFeatureEnabled: boolean;
    resumeSessionId: string;
    setResumeSessionId: React.Dispatch<React.SetStateAction<string>>;
    agentType: string;
    agentLabel: string;
    agentOptionState: ExternalSessionBrowseLockContext['agentOptionState'];
    pluginProjectionV2: PluginProjectionV2 | null | undefined;
}>): Readonly<{
    pathPopover: AgentInputContentPopoverConfig;
    machinePopover: AgentInputContentPopoverConfig;
    resumePopover: AgentInputContentPopoverConfig;
}> {
    const modalPortalTarget = useModalPortalTarget();
    const accountProfile = useAccountProfile();
    const machinePopoverGroups = params.machineGroups;
    const executionTargetScopeKey = params.selectedManagedMachine
        ? managedMachineSelectionOptionId(params.selectedManagedMachine.selection)
        : params.managedPlacementPreset
            ? ['preset', params.managedPlacementPreset.homeId, params.managedPlacementPreset.presetId].join('\u0000')
        : params.executionTarget?.kind === 'machine'
        ? [
            'machine',
            params.executionTarget.target.serverId,
            params.executionTarget.target.machineId,
            params.executionTarget.selectionOrigin?.poolId ?? '',
        ].join('\u0000')
        : params.executionTarget?.kind === 'temporary_computer'
            ? ['temporary_computer', params.executionTarget.serverId, params.executionTarget.artifactTarget].join('\u0000')
            : 'unselected';
    const machinePoolSelection = useMachinePoolSelection({
        requestKey: params.machinePoolRequestKey,
        requestKeyAlreadyConsumed: params.executionTarget?.kind === 'machine'
            && params.executionTarget.selectionOrigin?.kind === 'machine_pool',
        scopeKey: `${params.targetServerId ?? ''}\u0000${executionTargetScopeKey}`,
        onResolved: params.selectMachinePoolTarget,
    });
    const machinePopoverRenderParamsRef = useLatestRef({
        machineInventory: params.machineInventory,
        favoriteMachineItems: params.favoriteMachineItems,
        selectMachineTarget: params.selectMachineTarget,
        toggleFavoriteMachine: params.toggleFavoriteMachine,
        machinePopoverGroups,
        machinePoolGroups: params.machinePoolGroups,
        machinePoolSelection,
        onRefreshMachines: params.onRefreshMachines,
        onRefreshMachinePools: params.onRefreshMachinePools,
        onOpenMachinePoolSettings: params.onOpenMachinePoolSettings,
        onOpenMachinePresets: params.onOpenMachinePresets,
        onOpenAddMachine: params.onOpenAddMachine,
        recentMachines: params.recentMachines,
        selectedMachine: params.selectedMachine,
        selectedServerId: params.selectedServerId,
        useMachinePickerSearch: params.useMachinePickerSearch,
        executionTarget: params.executionTarget,
        temporaryComputerAvailability: params.temporaryComputerAvailability,
        temporaryComputerLaunchBlock: params.temporaryComputerLaunchBlock,
        selectTemporaryComputer: params.selectTemporaryComputer,
        managedMachines: params.managedMachines,
        selectedManagedMachine: params.selectedManagedMachine,
        managedPlacementPreset: params.managedPlacementPreset,
        onSelectManagedMachine: params.onSelectManagedMachine,
        managedMachineStartsSession: params.managedMachineStartsSession,
    });

    const pathPopover = React.useMemo<AgentInputContentPopoverConfig>(() => ({
        renderContent: ({ maxHeight, requestClose }) => (
            <NewSessionPopoverPathSelectionContent
                machineHomeDir={params.selectedMachine?.metadata?.homeDir || '/home'}
                selectedPath={params.selectedPath}
                initialSuggestionMode="history"
                onChangeSelectedPath={params.setSelectedPath}
                onChangeDraftSelectedPath={params.setDraftSelectedPath}
                // Keep the path popover mounted under the tree-browser modal so
                // dismissing the browser returns to the same picker state.
                submitBehavior="confirm"
                commitDraftOnBlur={true}
                onSubmitSelectedPath={(nextPath) => {
                    params.setSelectedPath(nextPath);
                    announceAccessibilityMessage(t('newSession.folder.a11y.set', { path: nextPath }));
                    requestClose();
                }}
                recentPaths={params.recentPaths}
                readRecentPaths={params.readRecentPaths}
                usePickerSearch={params.usePathPickerSearch}
                searchQuery={params.pathPickerSearchQuery}
                onChangeSearchQuery={params.setPathPickerSearchQuery}
                favoriteDirectories={params.favoriteDirectories}
                onChangeFavoriteDirectories={params.setFavoriteDirectories}
                focusInputOnSelect={false}
                leadingSections={params.placementCandidates && params.placementCandidates.rows.length > 0 ? [
                    createNewSessionPlacementCandidatesSection({
                        rows: params.placementCandidates.rows,
                        title: t('newSession.pathPicker.suggestedTitle'),
                        onSelect: (candidate) => {
                            params.placementCandidates?.onSelect(candidate);
                            requestClose();
                        },
                    }),
                ] : undefined}
                noFolderOption={params.onSelectNoFolder ? {
                    selected: params.noFolderSelected,
                    onSelect: () => {
                        params.onSelectNoFolder?.();
                        requestClose();
                    },
                } : undefined}
                machineBrowse={{
                    enabled: true,
                    machineId: params.selectedMachine?.id ?? null,
                    serverId: params.targetServerId ?? null,
                }}
                maxHeight={maxHeight}
            />
        ),
        ...LARGE_PICKER_LAYOUT,
        scrollEnabled: false,
        edgeFades: undefined,
        edgeIndicators: undefined,
        initialVisibility: undefined,
    }), [
        modalPortalTarget,
        params.favoriteDirectories,
        params.noFolderSelected,
        params.onSelectNoFolder,
        params.placementCandidates,
        params.pathPickerSearchQuery,
        params.recentPaths,
        params.readRecentPaths,
        params.selectedMachine?.id,
        params.selectedMachine?.metadata?.homeDir,
        params.selectedPath,
        params.setDraftSelectedPath,
        params.setFavoriteDirectories,
        params.setPathPickerSearchQuery,
        params.setSelectedPath,
        params.targetServerId,
        params.usePathPickerSearch,
    ]);

    const machinePopoverSignature = React.useMemo(() => buildNewSessionPopoverSignature({
        machineInventory: params.machineInventory,
        favoriteMachineItems: params.favoriteMachineItems,
        machinePopoverGroups,
        machinePoolGroups: params.machinePoolGroups,
        machinePoolSelectionStatus: machinePoolSelection.status,
        recentMachines: params.recentMachines,
        selectedMachineId: params.selectedMachine?.id ?? null,
        selectedServerId: params.selectedServerId,
        managedMachines: params.managedMachines,
        selectedManagedMachine: params.selectedManagedMachine,
        managedPlacementPreset: params.managedPlacementPreset,
        useMachinePickerSearch: params.useMachinePickerSearch,
        temporaryComputerTargets: params.temporaryComputerAvailability.status === 'available'
            ? params.temporaryComputerAvailability.artifacts.map((artifact) => artifact.identity.target)
            : [],
        selectedTemporaryComputer: params.executionTarget?.kind === 'temporary_computer'
            ? params.executionTarget
            : null,
    }), [
        machinePopoverGroups,
        params.machineInventory,
        params.favoriteMachineItems,
        params.machinePoolGroups,
        params.recentMachines,
        params.selectedMachine?.id,
        params.selectedServerId,
        params.managedMachines,
        params.selectedManagedMachine,
        params.managedPlacementPreset,
        params.executionTarget,
        params.temporaryComputerAvailability,
        params.useMachinePickerSearch,
        machinePoolSelection.status,
    ]);

    const machinePopover = React.useMemo<AgentInputContentPopoverConfig>(() => ({
        renderContent: ({ maxHeight, requestClose, inline }) => {
            const renderParams = machinePopoverRenderParamsRef.current;
            // One shared row owner with the full-screen picker: the composer
            // popover and the picker route must never disagree about whether
            // Temporary computer is offerable, or why it is not.
            const temporaryComputers = buildTemporaryComputerSelectionRows({
                serverId: renderParams.selectedServerId,
                availability: renderParams.temporaryComputerAvailability,
                selectedTarget: renderParams.executionTarget?.kind === 'temporary_computer'
                    ? renderParams.executionTarget
                    : null,
                launchBlockText: renderParams.temporaryComputerLaunchBlock
                    ? describeTemporaryComputerLaunchBlock(renderParams.temporaryComputerLaunchBlock)
                    : null,
                unavailableText: describeTemporaryComputerUnavailability(renderParams.temporaryComputerAvailability)
                    ?? t('newSession.temporaryComputer.unavailable.platformRetired'),
                onSelect: (artifactTarget, workspace, packageExpiresAt) => {
                    renderParams.selectTemporaryComputer(artifactTarget, workspace, packageExpiresAt);
                    requestClose();
                },
            });
            return (
                <NewSessionPopoverMachineSelectionContent
                    inventory={renderParams.machineInventory}
                    groups={renderParams.machinePopoverGroups}
                    poolGroups={renderParams.machinePoolGroups}
                    poolSelectionStatus={renderParams.machinePoolSelection.status}
                    selectedMachine={renderParams.selectedMachine}
                    selectedServerId={renderParams.selectedServerId}
                    temporaryComputers={temporaryComputers}
                    managedMachines={renderParams.managedMachines}
                    selectedManagedMachine={renderParams.selectedManagedMachine}
                    managedPlacementPreset={renderParams.managedPlacementPreset}
                    managedMachineStartsSession={renderParams.managedMachineStartsSession}
                    onSelectManagedMachine={(draft, options) => {
                        renderParams.machinePoolSelection.cancelPendingSelection();
                        renderParams.onSelectManagedMachine?.(draft, options);
                        requestClose();
                    }}
                    onOpenManagedPresets={renderParams.onOpenMachinePresets ? () => {
                        renderParams.machinePoolSelection.cancelPendingSelection();
                        requestClose();
                        renderParams.onOpenMachinePresets?.();
                    } : undefined}
                    // The configurator is its own modal: the picker closes as it opens (lab m-pick).
                    onConfigureManagedMachine={() => {
                        renderParams.machinePoolSelection.cancelPendingSelection();
                        requestClose();
                    }}
                    onConnectMachine={renderParams.onOpenAddMachine ? () => {
                        renderParams.machinePoolSelection.cancelPendingSelection();
                        requestClose();
                        renderParams.onOpenAddMachine?.();
                    } : undefined}
                    recentMachines={renderParams.recentMachines}
                    favoriteMachines={renderParams.favoriteMachineItems}
                    serverId={renderParams.selectedServerId}
                    onSelectMachine={(machine) => {
                        renderParams.machinePoolSelection.cancelPendingSelection();
                        renderParams.selectMachineTarget(machine, renderParams.selectedServerId);
                        requestClose();
                    }}
                    onSelectScopedMachine={(machine) => {
                        renderParams.machinePoolSelection.cancelPendingSelection();
                        renderParams.selectMachineTarget(machine, machine.serverId);
                        requestClose();
                    }}
                    onSelectPool={async (selection) => {
                        if (await renderParams.machinePoolSelection.selectPool(selection)) requestClose();
                    }}
                    onRefreshMachines={renderParams.onRefreshMachines}
                    onRefreshPools={renderParams.onRefreshMachinePools}
                    onOpenPoolSettings={(target) => {
                        renderParams.machinePoolSelection.cancelPendingSelection();
                        requestClose();
                        renderParams.onOpenMachinePoolSettings(target);
                    }}
                    onDismissPoolSelection={renderParams.machinePoolSelection.cancelPendingSelection}
                    onToggleFavorite={renderParams.toggleFavoriteMachine}
                    showSearch={renderParams.useMachinePickerSearch}
                    searchPlacement="header"
                    testIdPrefix="new-session-machine"
                    maxHeight={maxHeight}
                    presentation={inline ? 'inline' : undefined}
                />
            );
        },
        ...LARGE_PICKER_LAYOUT,
        onRequestClose: machinePoolSelection.cancelPendingSelection,
    }), [
        machinePopoverRenderParamsRef,
        machinePopoverSignature,
    ]);

    const resumePopover = React.useMemo<AgentInputContentPopoverConfig>(() => {
        const browseEnabled = params.externalSessionsFeatureEnabled
            && Boolean(params.selectedMachineId)
            && canBrowseExternalSessions({
                agentId: params.agentType,
                projection: params.pluginProjectionV2,
                machineId: params.selectedMachineId,
                // The composer's resume chip only ever picks a remote session
                // id, so resume-only listing sources are in scope here.
                interaction: 'pickRemoteSessionId',
            });
        return {
            renderContent: ({ requestClose }) => (
                <NewSessionResumeSelectionContent
                    value={params.resumeSessionId}
                    onChangeValue={params.setResumeSessionId}
                    onSave={(nextValue) => {
                        params.setResumeSessionId(nextValue);
                        requestClose();
                    }}
                    onClear={() => {
                        params.setResumeSessionId('');
                        requestClose();
                    }}
                    onClose={requestClose}
                    agentType={params.agentType}
                    agentLabel={params.agentLabel}
                    maxHeight={460}
                    showInlineHeader={false}
                    resumeBrowse={browseEnabled ? {
                        enabled: true,
                        onBrowse: async () => {
                            if (!params.selectedMachineId) return null;
                            const accountScope = getActiveServerAccountScope();
                            const source = resolveExternalSessionBrowseLockedSource({
                                accountScope,
                                serverId: params.targetServerId,
                                providerId: params.agentType,
                                machineId: params.selectedMachineId,
                                agentOptionState: params.agentOptionState,
                                profile: accountProfile,
                                labelsByKey: getConnectedMetadataCatalog(accountScope).labelsByKey,
                                agentSettings: getStorage().getState().settings,
                                projection: params.pluginProjectionV2,
                                interaction: 'pickRemoteSessionId',
                            });
                            if (!source) return null;
                            requestClose();
                            const nextResumeSessionId = await openExternalSessionsResumeIdPickerModal({
                                title: t('directSessions.browseTitle'),
                                webPortalTarget: modalPortalTarget,
                                lockScope: {
                                    machineId: params.selectedMachineId,
                                    serverId: params.targetServerId ?? null,
                                    providerId: params.agentType,
                                    source,
                                },
                            });
                            // An Agent-issued session id is opaque identity, not
                            // user input: this surface only decides
                            // present-vs-absent and stores the exact bytes. The
                            // canonical authoring-draft owner
                            // (`buildNewSessionAuthoringDraft` →
                            // `normalizeOptionalString`) is the single normalizer.
                            if (
                                typeof nextResumeSessionId === 'string'
                                && nextResumeSessionId.trim().length > 0
                            ) {
                                params.setResumeSessionId(nextResumeSessionId);
                            }
                            return null;
                        },
                    } : null}
                />
            ),
            maxHeightCap: 460,
            maxWidthCap: 460,
        };
    }, [
        accountProfile,
        modalPortalTarget,
        params.agentLabel,
        params.agentOptionState,
        params.agentType,
        params.externalSessionsFeatureEnabled,
        params.pluginProjectionV2,
        params.resumeSessionId,
        params.selectedMachineId,
        params.setResumeSessionId,
        params.targetServerId,
    ]);

    return {
        pathPopover,
        machinePopover,
        resumePopover,
    };
}
