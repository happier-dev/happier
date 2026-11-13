import * as React from 'react';

import type { AgentInputContentPopoverConfig } from '@/components/sessions/agentInput/components/AgentInputContentPopover';
import { NewSessionPathSelectionContent } from '@/components/sessions/new/components/NewSessionPathSelectionContent';
import {
  NewSessionMachineSelectionContent,
  type MachineSelectionDefaultOption,
  type NewSessionMachineSelectionContentProps,
} from '@/components/sessions/new/components/NewSessionMachineSelectionContent';
import type { ServerScopedMachineGroup } from '@/components/sessions/new/hooks/machines/useServerScopedMachineOptions';
import type { ServerScopedMachinePoolGroup } from '@/components/sessions/new/components/machineSelection/useMachineSelectionListModel';
import { useMachinePoolSelection } from '@/components/sessions/new/hooks/machines/useMachinePoolSelection';
import type { TemporaryComputerAvailability } from '@/components/sessions/new/hooks/useTemporaryComputerAvailability';
import type { TemporaryComputerLaunchBlock } from '@/components/sessions/new/hooks/temporaryComputerLaunchReadiness';
import {
  describeTemporaryComputerLaunchBlock,
  describeTemporaryComputerUnavailability,
} from '@/components/sessions/new/hooks/temporaryComputerCopy';
import { buildTemporaryComputerSelectionRows } from '@/components/sessions/new/components/machineSelection/buildTemporaryComputerSelectionRows';
import {
  managedMachineSelectionOptionId,
  type ManagedMachineSelectionDraft,
  type ManagedMachineSelectionOffer,
  type ManagedMachineUse,
} from '@/components/sessions/new/components/machineSelection/managedMachineSelection';
import { createNewSessionPlacementCandidatesSection } from '@/components/sessions/new/newSessionPlacementSelectionStep';
import type { SessionPlacementCandidateRow } from '@/components/sessions/new/serverStartDraftCandidateSelection';
import { useNewSessionPlacementSessions } from '@/components/sessions/new/hooks/screenModel/useNewSessionPlacementSessions';
import {
  useNewSessionMachinePickerInventory,
  type NewSessionMachinePickerInventory,
} from '@/components/sessions/new/hooks/screenModel/useNewSessionMachinePickerInventory';
import { announceAccessibilityMessage } from '@/components/ui/accessibility/announceAccessibilityMessage';
import { SELECTION_LIST_LARGE_POPOVER_SIZE } from '@/components/ui/selectionList';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';
import type { PluginUiSessionPlacementCandidateV1 } from '@happier-dev/protocol/plugins/ui';
import type { SessionAuthoringExecutionTargetV2 } from '@happier-dev/protocol/sessions/authoring/fieldCatalog';
import type { RunnerArtifactTarget } from '@happier-dev/protocol/ephemeralRunner/runnerArtifact';
import type { ManagedSessionPlacementV1 } from '@happier-dev/protocol/teams/managedDefaults';

/**
 * Where a Session runs, as New Session asks it: the Machine popover and the folder popover. They are
 * the one Machine and folder choice every host reuses (owner 2026-11-12: two chips everywhere), so
 * New Session-only rows (Pools, managed and temporary computers, saved projects) are optional inputs
 * and a host that has none still opens the same pickers.
 */

type MachineSelectionContentProps =
  NewSessionMachineSelectionContentProps<Machine>;

function NewSessionPopoverMachineInventoryContent(
  params: MachineSelectionContentProps &
    Readonly<{
      inventory: NewSessionMachinePickerInventory;
    }>,
) {
  const { inventory, ...content } = params;
  const { groups, poolGroups, recentMachines, favoriteMachineItems } =
    useNewSessionMachinePickerInventory(inventory);
  return (
    <NewSessionMachineSelectionContent
      {...content}
      groups={groups}
      poolGroups={poolGroups}
      recentMachines={recentMachines}
      favoriteMachines={favoriteMachineItems}
    />
  );
}

function NewSessionPopoverMachineSelectionContent(
  params: MachineSelectionContentProps &
    Readonly<{
      inventory?: NewSessionMachinePickerInventory;
    }>,
) {
  const { inventory, ...content } = params;
  return inventory ? (
    <NewSessionPopoverMachineInventoryContent
      {...content}
      inventory={inventory}
    />
  ) : (
    <NewSessionMachineSelectionContent {...content} />
  );
}

function NewSessionPopoverPathSelectionContent(
  params: React.ComponentProps<typeof NewSessionPathSelectionContent> &
    Readonly<{
      readRecentPaths?: () => ReadonlyArray<string>;
    }>,
) {
  const { readRecentPaths, ...content } = params;
  useNewSessionPlacementSessions(Boolean(readRecentPaths));
  return (
    <NewSessionPathSelectionContent
      {...content}
      recentPaths={readRecentPaths?.() ?? content.recentPaths}
    />
  );
}

export const LARGE_PICKER_LAYOUT: Pick<
  AgentInputContentPopoverConfig,
  | 'maxHeightCap'
  | 'maxWidthCap'
  | 'keyboardShouldPersistTaps'
  | 'edgeFades'
  | 'edgeIndicators'
  | 'initialVisibility'
> = {
  ...SELECTION_LIST_LARGE_POPOVER_SIZE,
  keyboardShouldPersistTaps: 'handled',
  edgeFades: { top: true, bottom: true, size: 28 },
  edgeIndicators: true,
  initialVisibility: { top: true, bottom: true },
};

function buildPopoverSignature(value: unknown): string {
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

const NO_MACHINES: ReadonlyArray<Machine> = [];
const NO_MACHINE_GROUPS: ReadonlyArray<ServerScopedMachineGroup> = [];
const NO_POOL_GROUPS: ReadonlyArray<ServerScopedMachinePoolGroup> = [];
const NO_STRINGS: ReadonlyArray<string> = [];
const IGNORE_POOL_TARGET = (): void => {};
const IGNORE_SEARCH_QUERY = (): void => {};
// A host whose work waits for an away Machine (a deploy, a backup) keeps it choosable; its row still says it is away.
const AWAY_MACHINE_CHOOSABLE = (): Readonly<{ selectable: true }> => ({ selectable: true });

export type SessionMachineChoiceParams = Readonly<{
  selectedMachine: Machine | null;
  selectedServerId: string | null;
  targetServerId: string | null;
  selectMachineTarget: (machine: Machine, serverId: string | null) => void;
  /**
   * New Session's one resolved Home-group set (Pools and Machines from the same Homes). A host without
   * it passes `machineInventory`, which the open popover resolves itself.
   */
  machineGroups?: ReadonlyArray<ServerScopedMachineGroup>;
  /** Closed simple composers carry intent; full inventory mounts inside the open popover. */
  machineInventory?: NewSessionMachinePickerInventory;
  recentMachines?: ReadonlyArray<Machine>;
  favoriteMachineItems?: ReadonlyArray<Machine>;
  toggleFavoriteMachine?: (machine: Machine) => void;
  useMachinePickerSearch?: boolean;
  executionTarget?: SessionAuthoringExecutionTargetV2 | null;
  /** Existing canonical Machine refresh, used when the Home Machine projection failed. */
  onRefreshMachines?: () => void;
  machinePoolGroups?: ReadonlyArray<ServerScopedMachinePoolGroup>;
  machinePoolRequestKey?: string;
  selectMachinePoolTarget?: (
    target: Readonly<{ serverId: string; poolId: string; machineId: string }>,
  ) => void;
  /** Existing canonical Pool refresh, offered beside a failed or unavailable Pool row. */
  onRefreshMachinePools?: (serverId: string) => void;
  /** Existing Machine Pool settings route, offered when the activated Pool has no enabled member. */
  onOpenMachinePoolSettings?: (
    target: Readonly<{ serverId: string; poolId: string }>,
  ) => void;
  managedMachines?: readonly ManagedMachineSelectionOffer[];
  selectedManagedMachine?: ManagedMachineSelectionDraft | null;
  managedPlacementPreset?: Extract<
    ManagedSessionPlacementV1,
    { kind: 'preset' }
  > | null;
  onSelectManagedMachine?: ManagedMachineUse;
  /** Whether the composer holds a drafted prompt; a getter, so typing never re-renders the picker. */
  managedMachineStartsSession?: () => boolean;
  /** Absent where a Temporary computer is not a destination (only New Session offers one). */
  temporaryComputers?: Readonly<{
    availability: TemporaryComputerAvailability;
    /** Exact launch-readiness block for the current authoring selection, or null. */
    launchBlock: TemporaryComputerLaunchBlock | null;
    select: (
      artifactTarget: RunnerArtifactTarget,
      workspace: Extract<
        SessionAuthoringExecutionTargetV2,
        { kind: 'temporary_computer' }
      >['workspace'],
      packageExpiresAt?: number,
    ) => void;
  }>;
  /** Existing Machines presets route, the managed group's trailing destination. */
  onOpenMachinePresets?: () => void;
  /** Existing Add a machine route, the machine list's last row. */
  onOpenAddMachine?: () => void;
  testIdPrefix?: string;
  /** Exposes the Machine list to an agent's UI commands under this scope. */
  currentUiContextCommandScope?: string;
  /** A Machine away right now stays choosable (work that waits for it); absent: away Machines are not offered, as for a Session. */
  awayMachinesChoosable?: boolean;
  /** The host's choice that is no particular Machine, listed first ("Your usual Machine"). */
  defaultChoice?: Omit<MachineSelectionDefaultOption, 'onSelect'> & Readonly<{ onChoose: () => void }>;
}>;

/** The Machine popover New Session's Machine chip opens; any host's Machine chip opens the same. */
export function useSessionMachineChoicePopover(
  params: SessionMachineChoiceParams,
): AgentInputContentPopoverConfig {
  const machinePopoverGroups = params.machineGroups ?? NO_MACHINE_GROUPS;
  const machinePoolGroups = params.machinePoolGroups ?? NO_POOL_GROUPS;
  const recentMachines = params.recentMachines ?? NO_MACHINES;
  const favoriteMachineItems = params.favoriteMachineItems ?? NO_MACHINES;
  const executionTarget = params.executionTarget ?? null;
  const executionTargetScopeKey = params.selectedManagedMachine
    ? managedMachineSelectionOptionId(params.selectedManagedMachine.selection)
    : params.managedPlacementPreset
      ? [
          'preset',
          params.managedPlacementPreset.homeId,
          params.managedPlacementPreset.presetId,
        ].join('\u0000')
      : executionTarget?.kind === 'machine'
        ? [
            'machine',
            executionTarget.target.serverId,
            executionTarget.target.machineId,
            executionTarget.selectionOrigin?.poolId ?? '',
          ].join('\u0000')
        : executionTarget?.kind === 'temporary_computer'
          ? [
              'temporary_computer',
              executionTarget.serverId,
              executionTarget.artifactTarget,
            ].join('\u0000')
          : 'unselected';
  const machinePoolSelection = useMachinePoolSelection({
    requestKey: params.machinePoolRequestKey ?? '',
    requestKeyAlreadyConsumed:
      executionTarget?.kind === 'machine' &&
      executionTarget.selectionOrigin?.kind === 'machine_pool',
    scopeKey: `${params.targetServerId ?? ''}\u0000${executionTargetScopeKey}`,
    onResolved: params.selectMachinePoolTarget ?? IGNORE_POOL_TARGET,
  });
  const machinePopoverRenderParamsRef = useLatestRef({
    machineInventory: params.machineInventory,
    favoriteMachineItems,
    selectMachineTarget: params.selectMachineTarget,
    toggleFavoriteMachine: params.toggleFavoriteMachine,
    machinePopoverGroups,
    machinePoolGroups,
    machinePoolSelection,
    onRefreshMachines: params.onRefreshMachines,
    onRefreshMachinePools: params.onRefreshMachinePools,
    onOpenMachinePoolSettings: params.onOpenMachinePoolSettings,
    onOpenMachinePresets: params.onOpenMachinePresets,
    onOpenAddMachine: params.onOpenAddMachine,
    recentMachines,
    selectedMachine: params.selectedMachine,
    selectedServerId: params.selectedServerId,
    useMachinePickerSearch: params.useMachinePickerSearch === true,
    executionTarget,
    temporaryComputers: params.temporaryComputers,
    managedMachines: params.managedMachines,
    selectedManagedMachine: params.selectedManagedMachine,
    managedPlacementPreset: params.managedPlacementPreset,
    onSelectManagedMachine: params.onSelectManagedMachine,
    managedMachineStartsSession: params.managedMachineStartsSession,
    testIdPrefix: params.testIdPrefix ?? 'new-session-machine',
    currentUiContextCommandScope: params.currentUiContextCommandScope,
    awayMachinesChoosable: params.awayMachinesChoosable === true,
    defaultChoice: params.defaultChoice,
  });

  const machinePopoverSignature = React.useMemo(
    () =>
      buildPopoverSignature({
        machineInventory: params.machineInventory,
        favoriteMachineItems,
        machinePopoverGroups,
        machinePoolGroups,
        machinePoolSelectionStatus: machinePoolSelection.status,
        recentMachines,
        selectedMachineId: params.selectedMachine?.id ?? null,
        selectedServerId: params.selectedServerId,
        managedMachines: params.managedMachines,
        selectedManagedMachine: params.selectedManagedMachine,
        managedPlacementPreset: params.managedPlacementPreset,
        useMachinePickerSearch: params.useMachinePickerSearch === true,
        awayMachinesChoosable: params.awayMachinesChoosable === true,
        defaultChoice: params.defaultChoice ? { title: params.defaultChoice.title, subtitle: params.defaultChoice.subtitle, selected: params.defaultChoice.selected } : null,
        temporaryComputerTargets:
          params.temporaryComputers?.availability.status === 'available'
            ? params.temporaryComputers.availability.artifacts.map(
                (artifact) => artifact.identity.target,
              )
            : [],
        selectedTemporaryComputer:
          executionTarget?.kind === 'temporary_computer'
            ? executionTarget
            : null,
      }),
    [
      machinePopoverGroups,
      params.machineInventory,
      favoriteMachineItems,
      machinePoolGroups,
      recentMachines,
      params.selectedMachine?.id,
      params.selectedServerId,
      params.managedMachines,
      params.selectedManagedMachine,
      params.managedPlacementPreset,
      executionTarget,
      params.temporaryComputers?.availability,
      params.useMachinePickerSearch,
      params.awayMachinesChoosable,
      params.defaultChoice?.title,
      params.defaultChoice?.subtitle,
      params.defaultChoice?.selected,
      machinePoolSelection.status,
    ],
  );

  return React.useMemo<AgentInputContentPopoverConfig>(
    () => ({
      renderContent: ({ maxHeight, requestClose, inline }) => {
        const renderParams = machinePopoverRenderParamsRef.current;
        const temporary = renderParams.temporaryComputers;
        // One shared row owner with the full-screen picker: the composer
        // popover and the picker route must never disagree about whether
        // Temporary computer is offerable, or why it is not.
        const temporaryComputers = temporary
          ? buildTemporaryComputerSelectionRows({
              serverId: renderParams.selectedServerId,
              availability: temporary.availability,
              selectedTarget:
                renderParams.executionTarget?.kind === 'temporary_computer'
                  ? renderParams.executionTarget
                  : null,
              launchBlockText: temporary.launchBlock
                ? describeTemporaryComputerLaunchBlock(temporary.launchBlock)
                : null,
              unavailableText:
                describeTemporaryComputerUnavailability(
                  temporary.availability,
                ) ??
                t('newSession.temporaryComputer.unavailable.platformRetired'),
              onSelect: (artifactTarget, workspace, packageExpiresAt) => {
                temporary.select(artifactTarget, workspace, packageExpiresAt);
                requestClose();
              },
            })
          : undefined;
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
            managedMachineStartsSession={
              renderParams.managedMachineStartsSession
            }
            // Managed (one-off) Machines are offered only by a host that can start one (New Session).
            onSelectManagedMachine={renderParams.onSelectManagedMachine ? (draft, options) => {
              renderParams.machinePoolSelection.cancelPendingSelection();
              renderParams.onSelectManagedMachine?.(draft, options);
              requestClose();
            } : undefined}
            onOpenManagedPresets={
              renderParams.onOpenMachinePresets
                ? () => {
                    renderParams.machinePoolSelection.cancelPendingSelection();
                    requestClose();
                    renderParams.onOpenMachinePresets?.();
                  }
                : undefined
            }
            // The configurator is its own modal: the picker closes as it opens (lab m-pick).
            onConfigureManagedMachine={renderParams.onSelectManagedMachine ? () => {
              renderParams.machinePoolSelection.cancelPendingSelection();
              requestClose();
            } : undefined}
            onConnectMachine={
              renderParams.onOpenAddMachine
                ? () => {
                    renderParams.machinePoolSelection.cancelPendingSelection();
                    requestClose();
                    renderParams.onOpenAddMachine?.();
                  }
                : undefined
            }
            recentMachines={renderParams.recentMachines}
            favoriteMachines={renderParams.favoriteMachineItems}
            serverId={renderParams.selectedServerId}
            onSelectMachine={(machine) => {
              renderParams.machinePoolSelection.cancelPendingSelection();
              renderParams.selectMachineTarget(
                machine,
                renderParams.selectedServerId,
              );
              requestClose();
            }}
            onSelectScopedMachine={(machine) => {
              renderParams.machinePoolSelection.cancelPendingSelection();
              renderParams.selectMachineTarget(machine, machine.serverId);
              requestClose();
            }}
            onSelectPool={async (selection) => {
              if (await renderParams.machinePoolSelection.selectPool(selection))
                requestClose();
            }}
            onRefreshMachines={renderParams.onRefreshMachines}
            onRefreshPools={renderParams.onRefreshMachinePools}
            onOpenPoolSettings={
              renderParams.onOpenMachinePoolSettings
                ? (target) => {
                    renderParams.machinePoolSelection.cancelPendingSelection();
                    requestClose();
                    renderParams.onOpenMachinePoolSettings?.(target);
                  }
                : undefined
            }
            onDismissPoolSelection={
              renderParams.machinePoolSelection.cancelPendingSelection
            }
            onToggleFavorite={renderParams.toggleFavoriteMachine}
            showSearch={renderParams.useMachinePickerSearch}
            searchPlacement="header"
            testIdPrefix={renderParams.testIdPrefix}
            currentUiContextCommandScope={renderParams.currentUiContextCommandScope}
            currentUiContextForegroundOverlay={renderParams.currentUiContextCommandScope !== undefined}
            maxHeight={maxHeight}
            presentation={inline ? 'inline' : undefined}
            {...(renderParams.awayMachinesChoosable
              ? { disableOfflineMachines: false, resolveMachineAvailability: AWAY_MACHINE_CHOOSABLE }
              : {})}
            {...(renderParams.defaultChoice
              ? {
                  defaultOption: {
                    title: renderParams.defaultChoice.title,
                    ...(renderParams.defaultChoice.subtitle === undefined ? {} : { subtitle: renderParams.defaultChoice.subtitle }),
                    selected: renderParams.defaultChoice.selected,
                    onSelect: () => {
                      renderParams.defaultChoice?.onChoose();
                      requestClose();
                    },
                  },
                }
              : {})}
          />
        );
      },
      ...LARGE_PICKER_LAYOUT,
      onRequestClose: machinePoolSelection.cancelPendingSelection,
    }),
    [machinePopoverRenderParamsRef, machinePopoverSignature],
  );
}

export type SessionPathChoiceParams = Readonly<{
  selectedMachine: Machine | null;
  /** The folder base when it is not the Machine's own home (a shared Machine's requester folder). */
  machineHomeDir?: string | null;
  targetServerId: string | null;
  selectedPath: string;
  setSelectedPath: (path: string) => void;
  setDraftSelectedPath?: (path: string) => void;
  /** The draft has no folder; the picker marks "No folder". */
  noFolderSelected?: boolean;
  /** Chooses no folder; absent where no-folder is not offered (Temporary computer). */
  onSelectNoFolder?: () => void;
  /** A seeded draft's unresolved saved projects: the folder picker lists them first. */
  placementCandidates?: Readonly<{
    rows: readonly SessionPlacementCandidateRow[];
    onSelect: (candidate: PluginUiSessionPlacementCandidateV1) => void;
  }>;
  recentPaths?: ReadonlyArray<string>;
  readRecentPaths?: () => ReadonlyArray<string>;
  usePathPickerSearch?: boolean;
  pathPickerSearchQuery?: string;
  setPathPickerSearchQuery?: (query: string) => void;
  favoriteDirectories: ReadonlyArray<string>;
  setFavoriteDirectories: (value: string[]) => void;
}>;

/** The folder popover New Session's folder chip opens; any host's folder chip opens the same. */
export function useSessionPathChoicePopover(
  params: SessionPathChoiceParams,
): AgentInputContentPopoverConfig {
  return React.useMemo<AgentInputContentPopoverConfig>(
    () => ({
      renderContent: ({ maxHeight, requestClose }) => (
        <NewSessionPopoverPathSelectionContent
          machineHomeDir={params.machineHomeDir || params.selectedMachine?.metadata?.homeDir || '/home'}
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
            announceAccessibilityMessage(
              t('newSession.folder.a11y.set', { path: nextPath }),
            );
            requestClose();
          }}
          recentPaths={params.recentPaths ?? NO_STRINGS}
          readRecentPaths={params.readRecentPaths}
          usePickerSearch={params.usePathPickerSearch === true}
          searchQuery={params.pathPickerSearchQuery ?? ''}
          onChangeSearchQuery={
            params.setPathPickerSearchQuery ?? IGNORE_SEARCH_QUERY
          }
          favoriteDirectories={params.favoriteDirectories}
          onChangeFavoriteDirectories={params.setFavoriteDirectories}
          focusInputOnSelect={false}
          leadingSections={
            params.placementCandidates &&
            params.placementCandidates.rows.length > 0
              ? [
                  createNewSessionPlacementCandidatesSection({
                    rows: params.placementCandidates.rows,
                    title: t('newSession.pathPicker.suggestedTitle'),
                    onSelect: (candidate) => {
                      params.placementCandidates?.onSelect(candidate);
                      requestClose();
                    },
                  }),
                ]
              : undefined
          }
          noFolderOption={
            params.onSelectNoFolder
              ? {
                  selected: params.noFolderSelected === true,
                  onSelect: () => {
                    params.onSelectNoFolder?.();
                    requestClose();
                  },
                }
              : undefined
          }
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
    }),
    [
      params.favoriteDirectories,
      params.noFolderSelected,
      params.onSelectNoFolder,
      params.placementCandidates,
      params.pathPickerSearchQuery,
      params.recentPaths,
      params.readRecentPaths,
      params.selectedMachine?.id,
      params.selectedMachine?.metadata?.homeDir,
      params.machineHomeDir,
      params.selectedPath,
      params.setDraftSelectedPath,
      params.setFavoriteDirectories,
      params.setPathPickerSearchQuery,
      params.setSelectedPath,
      params.targetServerId,
      params.usePathPickerSearch,
    ],
  );
}
