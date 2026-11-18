import * as React from 'react';

import { useModalPortalTarget } from '@/modal/portal/ModalPortalTarget';
import type { AgentInputContentPopoverConfig } from '@/components/sessions/agentInput/components/AgentInputContentPopover';
import { NewSessionResumeSelectionContent } from '@/components/sessions/new/components/NewSessionResumeSelectionContent';
import type { ServerScopedMachineGroup } from '@/components/sessions/new/hooks/machines/useServerScopedMachineOptions';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { getStorage } from '@/sync/domains/state/storageStore';
import { useProfile as useAccountProfile } from '@/sync/store/hooks';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { getConnectedMetadataCatalog } from '@/sync/store/settings/connectedMetadataCatalogSnapshot';
import { t } from '@/text';
import { openExternalSessionsResumeIdPickerModal } from '@/components/sessions/external/browse/openExternalSessionsResumeIdPickerModal';
import { canBrowseExternalSessions, resolveExternalSessionBrowseLockedSource } from '@/components/sessions/external/browse/resolveExternalSessionBrowseLockedSourceOption';
import type { PluginProjectionV2} from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { SessionAuthoringExecutionTargetV2 } from '@happier-dev/protocol/sessions/authoring/fieldCatalog';
import type { RunnerArtifactTarget } from '@happier-dev/protocol/ephemeralRunner/runnerArtifact';
import type { ManagedSessionPlacementV1 } from '@happier-dev/protocol/teams/managedDefaults';
import type { ServerScopedMachinePoolGroup } from '@/components/sessions/new/components/machineSelection/useMachineSelectionListModel';
import type { TemporaryComputerAvailability } from '@/components/sessions/new/hooks/useTemporaryComputerAvailability';
import type { TemporaryComputerLaunchBlock } from '@/components/sessions/new/hooks/temporaryComputerLaunchReadiness';
import { useSessionMachineChoicePopover, useSessionPathChoicePopover } from '@/components/sessions/new/placement/sessionPlacementPopovers';
import { type ManagedMachineSelectionDraft, type ManagedMachineSelectionOffer, type ManagedMachineUse } from '@/components/sessions/new/components/machineSelection/managedMachineSelection';
import type { SessionPlacementCandidateRow } from '@/components/sessions/new/serverStartDraftCandidateSelection';
import type { PluginUiSessionPlacementCandidateV1 } from '@happier-dev/protocol/plugins/ui';
import type { NewSessionMachinePickerInventory } from './useNewSessionMachinePickerInventory';
import type { MachineIsolationWorkKind } from '@/components/machines/security/isolation/machineIsolationChoices';

type ExternalSessionBrowseLockContext = Parameters<typeof resolveExternalSessionBrowseLockedSource>[0];

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
    /** Which default placed that preset ("Team default"), for its picker row. */
    managedPlacementSourceLabel?: string | null;
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
    /** The work this draft starts; each reachable Machine row says what it does there. */
    isolationWorkKind?: MachineIsolationWorkKind;
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
    const pathPopover = useSessionPathChoicePopover({
        selectedMachine: params.selectedMachine,
        targetServerId: params.targetServerId,
        selectedPath: params.selectedPath,
        setSelectedPath: params.setSelectedPath,
        setDraftSelectedPath: params.setDraftSelectedPath,
        noFolderSelected: params.noFolderSelected,
        onSelectNoFolder: params.onSelectNoFolder,
        placementCandidates: params.placementCandidates,
        recentPaths: params.recentPaths,
        readRecentPaths: params.readRecentPaths,
        usePathPickerSearch: params.usePathPickerSearch,
        pathPickerSearchQuery: params.pathPickerSearchQuery,
        setPathPickerSearchQuery: params.setPathPickerSearchQuery,
        favoriteDirectories: params.favoriteDirectories,
        setFavoriteDirectories: params.setFavoriteDirectories,
    });
    const temporaryComputers = React.useMemo(() => ({
        availability: params.temporaryComputerAvailability,
        launchBlock: params.temporaryComputerLaunchBlock,
        select: params.selectTemporaryComputer,
    }), [params.selectTemporaryComputer, params.temporaryComputerAvailability, params.temporaryComputerLaunchBlock]);
    const machinePopover = useSessionMachineChoicePopover({
        machineInventory: params.machineInventory,
        machineGroups: params.machineGroups,
        selectedMachine: params.selectedMachine,
        selectedServerId: params.selectedServerId,
        targetServerId: params.targetServerId,
        recentMachines: params.recentMachines,
        favoriteMachineItems: params.favoriteMachineItems,
        selectMachineTarget: params.selectMachineTarget,
        toggleFavoriteMachine: params.toggleFavoriteMachine,
        useMachinePickerSearch: params.useMachinePickerSearch,
        executionTarget: params.executionTarget,
        onRefreshMachines: params.onRefreshMachines,
        machinePoolGroups: params.machinePoolGroups,
        machinePoolRequestKey: params.machinePoolRequestKey,
        selectMachinePoolTarget: params.selectMachinePoolTarget,
        onRefreshMachinePools: params.onRefreshMachinePools,
        onOpenMachinePoolSettings: params.onOpenMachinePoolSettings,
        managedMachines: params.managedMachines,
        selectedManagedMachine: params.selectedManagedMachine,
        managedPlacementPreset: params.managedPlacementPreset,
        managedPlacementSourceLabel: params.managedPlacementSourceLabel,
        onSelectManagedMachine: params.onSelectManagedMachine,
        managedMachineStartsSession: params.managedMachineStartsSession,
        temporaryComputers,
        onOpenMachinePresets: params.onOpenMachinePresets,
        onOpenAddMachine: params.onOpenAddMachine,
        isolationWorkKind: params.isolationWorkKind,
    });

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
