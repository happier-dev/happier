import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import {
  AgentInputContentPopover,
  type AgentInputContentPopoverConfig,
} from '@/components/sessions/agentInput/components/AgentInputContentPopover';
import {
  AgentInputFolderChip,
  type AgentInputFolderChipState,
} from '@/components/sessions/agentInput/definitions/AgentInputFolderChip';
import { createMachineActionChip } from '@/components/sessions/agentInput/definitions/createMachineActionChip';
import { useSessionAuthoringChipRenderContext } from '@/components/sessions/authoring/controls/SessionAuthoringControls';
import { useNewSessionActiveServerSource } from '@/components/sessions/new/hooks/serverTarget/useNewSessionActiveServerSource';
import type { NewSessionMachinePickerInventory } from '@/components/sessions/new/hooks/screenModel/useNewSessionMachinePickerInventory';
import { buildServerScopedMachine } from '@/components/sessions/new/hooks/machines/useServerScopedMachineOptions';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import { useSettingMutable } from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';
import {
  useSessionMachineChoicePopover,
  useSessionPathChoicePopover,
  type SessionPathChoiceParams,
} from './sessionPlacementPopovers';

export type SessionPlacementChipsHandle = Readonly<{
  open: (picker: 'machine' | 'folder') => void;
  close: () => void;
}>;

const NO_STRINGS: readonly string[] = Object.freeze([]);
const NO_MACHINE_PATHS: NewSessionMachinePickerInventory['recentMachinePaths'] =
  Object.freeze([]);

/** What a host tells New Session's Machine and folder pickers: its values and what a choice does. */
export type SessionPlacementChoiceProps = Readonly<{
    serverId: string;
    machine: Machine | null;
    /** The folder; empty means no folder. */
    path: string;
    /** The host's own eligible Machines (a workflow's); absent: this Home's launch Machines. */
    machines?: readonly Machine[];
    /** The Machine's name when the host holds no Machine record for it. */
    machineName?: string | null;
    /** The folder base when it is not the Machine's own home (a shared Machine's requester folder). */
    machineHomeDir?: string | null;
    /** This Machine's recent folders, offered first by the folder picker. */
    recentPaths?: readonly string[];
    /** Machine picker rows read `${testIDPrefix}-machine-option:<id>`. */
    testIDPrefix?: string;
    /** Exposes the Machine list to an agent's UI commands as `${scope}.machine`. */
    currentUiContextCommandScope?: string;
    /** Absent: the Machine is fixed by the host and its chip only names it. */
    onSelectMachine?: (machine: Machine, serverId: string | null) => void;
    onSelectPath: (path: string) => void;
    /** Offers "No folder" in the folder picker. */
    onSelectNoFolder?: () => void;
    /** Saved projects the folder picker lists first (New Session's "Suggested"); one may move the Machine. */
    placementCandidates?: SessionPathChoiceParams['placementCandidates'];
}>;

/** New Session's Machine and folder popovers for a host's place; the chips and run-composer chips open these. */
export function useSessionPlacementPopovers(props: SessionPlacementChoiceProps): Readonly<{
  machinePopover: AgentInputContentPopoverConfig;
  pathPopover: AgentInputContentPopoverConfig;
}> {
  const activeServer = useNewSessionActiveServerSource();
  const [favoriteDirectoriesSetting, setFavoriteDirectories] =
    useSettingMutable('favoriteDirectories');
  const favoriteDirectories = Array.isArray(favoriteDirectoriesSetting)
    ? favoriteDirectoriesSetting
    : NO_STRINGS;
  // The open picker resolves this Home's Machines itself, as New Session's simple composer does.
  const machineInventory = React.useMemo(
    () => ({
      allowedServerIds: [props.serverId],
      activeServerId: activeServer.activeServerId,
      refreshToken: activeServer.serverProfilesSignature,
      targetServerId: props.serverId,
      recentMachinePaths: NO_MACHINE_PATHS,
      favoriteMachineIds: NO_STRINGS,
    }),
    [
      activeServer.activeServerId,
      activeServer.serverProfilesSignature,
      props.serverId,
    ],
  );
  const selectMachine = useEventCallback(
    (machine: Machine, serverId: string | null) =>
      props.onSelectMachine?.(machine, serverId),
  );
  const selectPath = useEventCallback((path: string) =>
    props.onSelectPath(path),
  );
  const hostMachines = props.machines;
  // A host's own list is grouped the way MachineSelector groups it; otherwise the open picker resolves the Home.
  const machineGroups = React.useMemo(() => hostMachines === undefined ? undefined : [{
    serverId: props.serverId, serverName: '', loading: false, signedOut: false,
    machines: hostMachines.map((machine) => buildServerScopedMachine(machine, { serverId: props.serverId, serverName: '' })),
  }], [hostMachines, props.serverId]);
  const machinePopover = useSessionMachineChoicePopover({
    selectedMachine: props.machine,
    selectedServerId: props.serverId,
    targetServerId: props.serverId,
    selectMachineTarget: selectMachine,
    ...(machineGroups === undefined ? { machineInventory } : { machineGroups }),
    useMachinePickerSearch: true,
    ...(props.testIDPrefix === undefined ? {} : { testIdPrefix: `${props.testIDPrefix}-machine` }),
    ...(props.currentUiContextCommandScope === undefined ? {} : { currentUiContextCommandScope: `${props.currentUiContextCommandScope}.machine` }),
  });
  const pathPopover = useSessionPathChoicePopover({
    selectedMachine: props.machine,
    targetServerId: props.serverId,
    machineHomeDir: props.machineHomeDir,
    recentPaths: props.recentPaths,
    selectedPath: props.path,
    setSelectedPath: selectPath,
    noFolderSelected: props.path.trim() === '',
    onSelectNoFolder: props.onSelectNoFolder,
    placementCandidates: props.placementCandidates,
    favoriteDirectories,
    setFavoriteDirectories,
  });
  return { machinePopover, pathPopover };
}

/**
 * The Machine chip and the folder chip, as New Session shows them, for a host that is not a composer
 * (an inline recipe, a recipe sheet). Each opens New Session's own picker anchored to itself; the host
 * owns the values and decides what a choice does (owner 2026-11-12: Machine and folder are two chips).
 */
export function SessionPlacementChips(
  props: SessionPlacementChoiceProps & Readonly<{
    /** Opens either picker from elsewhere (a "Choose where it runs" action, an agent's command). */
    handleRef?: React.Ref<SessionPlacementChipsHandle>;
  }>,
): React.ReactElement {
  const machineAnchor = React.useRef<View | null>(null);
  const folderAnchor = React.useRef<View | null>(null);
  const [open, setOpen] = React.useState<'machine' | 'folder' | null>(null);
  const chip = useSessionAuthoringChipRenderContext(machineAnchor);
  const { machinePopover, pathPopover } = useSessionPlacementPopovers(props);
  // The chip reads the folder home-relative, as New Session's own (whose paths already are).
  const folderHome = props.machineHomeDir ?? props.machine?.metadata?.homeDir ?? undefined;
  const folderState: AgentInputFolderChipState = props.path.trim()
    ? { kind: 'folder', path: formatPathRelativeToHome(props.path.trim(), folderHome) }
    : { kind: 'none' };
  const close = React.useCallback(() => setOpen(null), []);
  React.useImperativeHandle(props.handleRef, () => ({ open: (picker) => setOpen(picker), close }), [close]);
  // A folder is chosen for one Machine: when the host's Machine changes underneath, its pickers close.
  const machineId = props.machine?.id ?? null;
  React.useEffect(() => setOpen(null), [machineId]);
  return (
    <View style={styles.row}>
      {createMachineActionChip({
        anchorRef: machineAnchor,
        machineName: props.machine
          ? getMachineDisplayName(props.machine)
          : (props.machineName ?? null),
        tint: chip.iconColor,
        showLabel: true,
        chipStyle: chip.chipStyle,
        textStyle: chip.textStyle,
        onPress: () => setOpen('machine'),
        disabled: props.onSelectMachine === undefined,
      })}
      {/* A folder belongs to a Machine: until one is chosen, only the Machine chip asks. */}
      {props.machine !== null || props.machineName ? (
        <AgentInputFolderChip
          anchorRef={folderAnchor}
          state={folderState}
          tint={chip.iconColor}
          chipStyle={chip.chipStyle}
          textStyle={chip.textStyle}
          onPress={() => setOpen('folder')}
          layout="wrap"
        />
      ) : null}
      {open === 'machine' ? (
        <PlacementPopover
          config={machinePopover}
          anchorRef={machineAnchor}
          onClose={close}
        />
      ) : null}
      {open === 'folder' ? (
        <PlacementPopover
          config={pathPopover}
          anchorRef={folderAnchor}
          onClose={close}
        />
      ) : null}
    </View>
  );
}

function PlacementPopover(
  props: Readonly<{
    config: AgentInputContentPopoverConfig;
    anchorRef: React.RefObject<View | null>;
    onClose: () => void;
  }>,
): React.ReactElement {
  const { config, onClose } = props;
  const requestClose = React.useCallback(() => {
    config.onRequestClose?.();
    onClose();
  }, [config, onClose]);
  return (
    <AgentInputContentPopover
      open
      anchorRef={props.anchorRef}
      content={config.renderContent}
      onRequestClose={requestClose}
      {...(config.header === undefined ? {} : { header: config.header })}
      {...(config.maxHeightCap === undefined
        ? {}
        : { maxHeightCap: config.maxHeightCap })}
      {...(config.maxWidthCap === undefined
        ? {}
        : { maxWidthCap: config.maxWidthCap })}
      {...(config.scrollEnabled === undefined
        ? {}
        : { scrollEnabled: config.scrollEnabled })}
      {...(config.keyboardShouldPersistTaps === undefined
        ? {}
        : { keyboardShouldPersistTaps: config.keyboardShouldPersistTaps })}
      {...(config.edgeFades === undefined
        ? {}
        : { edgeFades: config.edgeFades })}
      {...(config.edgeIndicators === undefined
        ? {}
        : { edgeIndicators: config.edgeIndicators })}
      {...(config.initialVisibility === undefined
        ? {}
        : { initialVisibility: config.initialVisibility })}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: theme.space.s6,
  },
}));
