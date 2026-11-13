import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

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
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { resolveFieldBoxColors } from '@/components/ui/forms/fieldBox';
import { renderDropdownItemTriggerRightElement } from '@/components/ui/forms/dropdown/renderDropdownItemTriggerRightElement';
import { SelectionListFilterChip } from '@/components/ui/selectionList';
import { t } from '@/text';
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
 * Where a Session runs, as New Session asks it: a Machine and a folder, each opening New Session's own
 * picker anchored to itself; the host owns the values and decides what a choice does (owner
 * 2026-11-12). One owner, two presentations chosen by context (as `SessionAuthoringControls`):
 * `chips` in chip rows (composers, headers, Discuss Add agent), taking the host row's chip look, and
 * `fields` in forms and phone editors: one row, its label, then the Machine and folder fields.
 */
export function SessionPlacementChips(
  props: SessionPlacementChoiceProps & Readonly<{
    /** Opens either picker from elsewhere (a "Choose where it runs" action, an agent's command). */
    handleRef?: React.Ref<SessionPlacementChipsHandle>;
    presentation?: 'chips' | 'fields';
    /** `chips`: the host row's look; `bordered` where the row's other chips are bordered (an editor header). */
    chipVariant?: 'composer' | 'bordered';
    /** `fields`: the row's label and its consequence. */
    title?: string;
    subtitle?: string;
    rowTestID?: string;
    /** What follows the Machine and folder in the same row (a workflow's checkout picker). */
    trailing?: React.ReactNode;
  }>,
): React.ReactElement {
  const machineAnchor = React.useRef<View | null>(null);
  const folderAnchor = React.useRef<View | null>(null);
  const [open, setOpen] = React.useState<'machine' | 'folder' | null>(null);
  const chip = useSessionAuthoringChipRenderContext(machineAnchor);
  const { machinePopover, pathPopover } = useSessionPlacementPopovers(props);
  const machineLabel = props.machine ? getMachineDisplayName(props.machine) : (props.machineName ?? null);
  const machineKnown = props.machine !== null || Boolean(props.machineName);
  // The folder reads home-relative, as New Session's own (whose paths already are).
  const folderHome = props.machineHomeDir ?? props.machine?.metadata?.homeDir ?? undefined;
  const path = props.path.trim();
  const folderState: AgentInputFolderChipState = !machineKnown
    ? { kind: 'machine_required' }
    : path ? { kind: 'folder', path: formatPathRelativeToHome(path, folderHome) } : { kind: 'none' };
  const folderLabel = !machineKnown ? t('newSession.folder.chooseMachineFirst')
    : path ? formatPathRelativeToHome(path, folderHome, { homeLabel: t('workspacePresentation.homeFolder') })
      : t('newSession.folder.noFolder');
  const machineChoosable = props.onSelectMachine !== undefined;
  const close = React.useCallback(() => setOpen(null), []);
  React.useImperativeHandle(props.handleRef, () => ({ open: (picker) => setOpen(picker), close }), [close]);
  // A folder is chosen for one Machine: when the host's Machine changes underneath, its pickers close.
  const machineId = props.machine?.id ?? null;
  React.useEffect(() => setOpen(null), [machineId]);
  const popovers = (
    <>
      {open === 'machine' ? <PlacementPopover config={machinePopover} anchorRef={machineAnchor} onClose={close} /> : null}
      {open === 'folder' ? <PlacementPopover config={pathPopover} anchorRef={folderAnchor} onClose={close} /> : null}
    </>
  );

  if (props.presentation === 'fields') {
    return (
      <Item
        {...(props.rowTestID === undefined ? {} : { testID: props.rowTestID })}
        title={props.title ?? t('newSession.wizardSection.machine')}
        {...(props.subtitle === undefined ? {} : { subtitle: props.subtitle, subtitleLines: 0 })}
        accessoryLayout="stacked"
        showChevron={false}
        selected={false}
        rightElement={
          <View style={styles.fields}>
            <PlacementField anchorRef={machineAnchor} testID="agent-input-machine-chip"
              label={t('newSession.wizardSection.machine')} value={machineLabel} placeholder={t('agentInput.runOn')}
              open={open === 'machine'} disabled={!machineChoosable} onPress={() => setOpen('machine')} />
            <PlacementField anchorRef={folderAnchor} testID="agent-input-path-chip"
              label={t('newSession.wizardSection.folder')} value={folderLabel} placeholder={folderLabel}
              open={open === 'folder'} disabled={!machineKnown} onPress={() => setOpen('folder')} />
            {props.trailing}
            {popovers}
          </View>
        }
      />
    );
  }

  if (props.chipVariant === 'bordered') {
    return (
      <View style={styles.row}>
        <SelectionListFilterChip filter={{
          id: 'session-placement-machine',
          label: t('newSession.wizardSection.machine'),
          valueLabel: machineLabel ?? t('agentInput.runOn'),
          icon: <PlacementIcon name="desktop" />,
          muted: machineLabel === null,
          disabled: !machineChoosable,
          open: open === 'machine',
          onOpenChange: (next) => setOpen(next ? 'machine' : null),
          renderPopoverContent: (context) => renderPlacementContent(machinePopover, context),
          testID: 'agent-input-machine-chip',
        }} />
        <SelectionListFilterChip filter={{
          id: 'session-placement-folder',
          label: t('newSession.wizardSection.folder'),
          valueLabel: folderLabel,
          icon: <PlacementIcon name="folder" />,
          muted: !machineKnown || !path,
          disabled: !machineKnown,
          open: open === 'folder',
          onOpenChange: (next) => setOpen(next ? 'folder' : null),
          renderPopoverContent: (context) => renderPlacementContent(pathPopover, context),
          testID: 'agent-input-path-chip',
        }} />
        {props.trailing}
      </View>
    );
  }

  return (
    <View style={styles.row}>
      {createMachineActionChip({
        anchorRef: machineAnchor,
        machineName: machineLabel,
        tint: chip.iconColor,
        showLabel: true,
        chipStyle: chip.chipStyle,
        textStyle: chip.textStyle,
        onPress: () => setOpen('machine'),
        disabled: !machineChoosable,
      })}
      {/* Until a Machine is chosen the folder stays in place, disabled, so nothing jumps. */}
      <AgentInputFolderChip
        anchorRef={folderAnchor}
        state={folderState}
        tint={chip.iconColor}
        chipStyle={chip.chipStyle}
        textStyle={chip.textStyle}
        onPress={() => setOpen('folder')}
        layout="wrap"
      />
      {props.trailing}
      {popovers}
    </View>
  );
}

/** A bordered chip hosts the same picker in its own popover. */
function renderPlacementContent(
  config: AgentInputContentPopoverConfig,
  context: Readonly<{ close: () => void; maxHeight: number }>,
): React.ReactNode {
  const content = config.renderContent;
  return typeof content === 'function'
    ? content({ maxHeight: context.maxHeight, requestClose: () => { config.onRequestClose?.(); context.close(); } })
    : content;
}

function PlacementIcon(props: Readonly<{ name: 'desktop' | 'folder' }>): React.ReactElement {
  const { theme } = useUnistyles();
  return <Icon name={props.name} size={14} color={theme.colors.text.secondary} />;
}

/** One field of the `fields` presentation: the canonical page field box, pressable, anchoring its picker. */
function PlacementField(props: Readonly<{
  anchorRef: React.RefObject<View | null>;
  testID: string;
  label: string;
  value: string | null;
  placeholder: string;
  open: boolean;
  disabled: boolean;
  onPress: () => void;
}>): React.ReactElement {
  const { theme } = useUnistyles();
  const fieldColors = React.useMemo(() => resolveFieldBoxColors(theme), [theme]);
  return (
    <View ref={props.anchorRef} collapsable={false}>
      <HappierPressable
        testID={props.testID}
        accessibilityRole="button"
        accessibilityLabel={`${props.label}: ${props.value ?? props.placeholder}`}
        expanded={props.open}
        disabled={props.disabled}
        {...(props.disabled ? {} : { onPress: props.onPress })}
      >
        {renderDropdownItemTriggerRightElement({
          detail: props.value,
          open: props.open,
          detailColor: props.disabled ? theme.colors.text.tertiary : theme.colors.text.secondary,
          chevronColor: theme.colors.text.secondary,
          field: fieldColors,
          fieldSpan: 'row',
          placeholder: props.placeholder,
          placeholderColor: theme.colors.input.placeholder,
        })}
      </HappierPressable>
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
  fields: { gap: theme.space.s8, alignSelf: 'stretch' },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: theme.space.s6,
  },
}));
