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
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import { useSettingMutable } from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import {
  useSessionMachineChoicePopover,
  useSessionPathChoicePopover,
  type SessionPathChoiceParams,
} from './sessionPlacementPopovers';

const NO_STRINGS: readonly string[] = Object.freeze([]);
const NO_MACHINE_PATHS: NewSessionMachinePickerInventory['recentMachinePaths'] =
  Object.freeze([]);

/**
 * The Machine chip and the folder chip, as New Session shows them, for a host that is not a composer
 * (an inline recipe, a recipe sheet). Each opens New Session's own picker anchored to itself; the host
 * owns the values and decides what a choice does (owner 2026-11-12: Machine and folder are two chips).
 */
export function SessionPlacementChips(
  props: Readonly<{
    serverId: string;
    machine: Machine | null;
    /** The folder; empty means no folder. */
    path: string;
    /** Absent: the Machine is fixed by the host and its chip only names it. */
    onSelectMachine?: (machine: Machine, serverId: string | null) => void;
    onSelectPath: (path: string) => void;
    /** Offers "No folder" in the folder picker. */
    onSelectNoFolder?: () => void;
    /** Saved projects the folder picker lists first (New Session's "Suggested"); one may move the Machine. */
    placementCandidates?: SessionPathChoiceParams['placementCandidates'];
  }>,
): React.ReactElement {
  const machineAnchor = React.useRef<View | null>(null);
  const folderAnchor = React.useRef<View | null>(null);
  const [open, setOpen] = React.useState<'machine' | 'folder' | null>(null);
  const chip = useSessionAuthoringChipRenderContext(machineAnchor);
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
  const machinePopover = useSessionMachineChoicePopover({
    selectedMachine: props.machine,
    selectedServerId: props.serverId,
    targetServerId: props.serverId,
    selectMachineTarget: selectMachine,
    machineInventory,
    useMachinePickerSearch: true,
  });
  const pathPopover = useSessionPathChoicePopover({
    selectedMachine: props.machine,
    targetServerId: props.serverId,
    selectedPath: props.path,
    setSelectedPath: selectPath,
    noFolderSelected: props.path.trim() === '',
    onSelectNoFolder: props.onSelectNoFolder,
    placementCandidates: props.placementCandidates,
    favoriteDirectories,
    setFavoriteDirectories,
  });
  const folderState: AgentInputFolderChipState = props.path.trim()
    ? { kind: 'folder', path: props.path.trim() }
    : { kind: 'none' };
  const close = React.useCallback(() => setOpen(null), []);
  return (
    <View style={styles.row}>
      {createMachineActionChip({
        anchorRef: machineAnchor,
        machineName: props.machine
          ? getMachineDisplayName(props.machine)
          : null,
        tint: chip.iconColor,
        showLabel: true,
        chipStyle: chip.chipStyle,
        textStyle: chip.textStyle,
        onPress: () => setOpen('machine'),
        disabled: props.onSelectMachine === undefined,
      })}
      <AgentInputFolderChip
        anchorRef={folderAnchor}
        state={folderState}
        tint={chip.iconColor}
        chipStyle={chip.chipStyle}
        textStyle={chip.textStyle}
        onPress={() => setOpen('folder')}
        layout="wrap"
      />
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
