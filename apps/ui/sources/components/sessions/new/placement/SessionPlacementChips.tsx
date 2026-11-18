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
import { useMachineListForServerSelection, useServerScopedMachine } from '@/sync/store/hooks';
import { useMachinePresenceSummary } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { useMachineManagedPresence } from '@/components/machines/useMachineManagedPresence';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { resolveFieldBoxColors } from '@/components/ui/forms/fieldBox';
import { renderDropdownItemTriggerRightElement } from '@/components/ui/forms/dropdown/renderDropdownItemTriggerRightElement';
import { SelectionListFilterChip } from '@/components/ui/selectionList';
import { t } from '@/text';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import type { MachineIsolationPolicyV1 } from '@happier-dev/protocol/machines/machineIsolationV1';
import { useMachineIsolationProposedOutcome } from '@/hooks/machine/useMachineIsolationPolicy';
import { readSyncedMachineIsolationPolicy } from '@/sync/domains/machines/machineIsolationPolicy';
import { SessionIsolationOutcomeLine } from './SessionIsolationOutcomeLine';

type MachineIsolationWorkKind = keyof MachineIsolationPolicyV1['workKinds'];
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';
import {
  useSessionMachineChoicePopover,
  useSessionPathChoicePopover,
  type SessionMachineChoiceParams,
  type SessionPathChoiceParams,
} from './sessionPlacementPopovers';

export type SessionPlacementChipsHandle = Readonly<{
  open: (picker: 'machine' | 'folder') => void;
  close: () => void;
}>;

/** One value's trigger, for a host that draws its own (`renderChip`). `value` is `null` while it is missing. */
export type SessionPlacementChipTrigger = Readonly<{
  field: 'machine' | 'folder';
  title: string;
  value: string | null;
  placeholder: string;
  anchorRef: React.RefObject<View | null>;
  open: boolean;
  disabled: boolean;
  onPress: () => void;
  testID: string;
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
    /**
     * The host can place on a cloud preset too: the Machine picker then lists this Home's presets (New Session's
     * own offers and use callback). `managedPlacementPreset` marks the one the host holds.
     */
    managedPlacementPreset?: SessionMachineChoiceParams['managedPlacementPreset'];
    onSelectManagedMachine?: SessionMachineChoiceParams['onSelectManagedMachine'];
}>;

/**
 * A Machine's name as every list of this Home's Machines says it: told apart from a same-named peer
 * ("NLDW3 · 6420"). Peers are the host's list when it has one, else this Home's, read through a selector so
 * the field wakes only when its own label changes.
 */
function usePlacementMachineLabel(serverId: string, machine: Machine | null, hostMachines: readonly Machine[] | undefined): string | null {
  const machineId = machine?.id ?? null;
  const select = React.useCallback((machines: readonly Machine[]) => {
    if (hostMachines !== undefined || machineId === null) return null;
    const own = machines.find((candidate) => candidate.id === machineId);
    return own ? getMachineDisplayName(own, machines) ?? null : null;
  }, [hostMachines, machineId]);
  const homeLabel = useMachineListForServerSelection(serverId, select);
  if (!machine) return null;
  return (hostMachines !== undefined ? getMachineDisplayName(machine, hostMachines) : homeLabel ?? getMachineDisplayName(machine)) ?? null;
}

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
    ...(props.onSelectManagedMachine ? { onSelectManagedMachine: props.onSelectManagedMachine,
      managedPlacementPreset: props.managedPlacementPreset ?? null } : {}),
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
    /**
     * `fields` in a host with its own label track (a workflow's How card): each field on its own row,
     * which the host draws from the field's label and control.
     */
    renderFieldRow?: (field: 'machine' | 'folder', label: string, control: React.ReactNode) => React.ReactNode;
    /**
     * A host that draws its own trigger for each value (a workflow's sentence, round 1116c): the Machine and the
     * folder, each opening the same picker below it. The values, pickers and choices stay here.
     */
    renderChip?: (chip: SessionPlacementChipTrigger) => React.ReactNode;
    /**
     * Which kind of work this placement starts: the chosen Machine's isolation policy for it is said under the
     * chips (`SessionIsolationOutcomeLine`), the same line New Session shows. Hosts that start no Session omit it.
     */
    isolationWorkKind?: MachineIsolationWorkKind;
  }>,
): React.ReactElement {
  const isolationSnapshot = React.useMemo(() => readSyncedMachineIsolationPolicy(props.machine ?? null), [props.machine]);
  const isolationOutcome = useMachineIsolationProposedOutcome(isolationSnapshot, props.isolationWorkKind ?? 'sessions');
  // Offline is the reachability owner's verdict for this Machine, the one New Session reads: the line then says the
  // work waits for it instead of where it would run.
  const presence = useMachinePresenceSummary(props.serverId || null, props.isolationWorkKind ? props.machine?.id ?? null : null,
    undefined, sameReachability);
  const managedPresence = useMachineManagedPresence(props.serverId || null, props.isolationWorkKind ? props.machine : null);
  const outcomeLine = props.isolationWorkKind && props.machine ? (
    <SessionIsolationOutcomeLine serverId={props.serverId || null} machineName={props.machine ? getMachineDisplayName(props.machine) : null}
      snapshot={isolationSnapshot} outcome={isolationOutcome} offline={presence.reachability === 'unreachable'}
      managedPresence={managedPresence}
      testID="session-placement-isolation-outcome" />
  ) : null;
  const machineAnchor = React.useRef<View | null>(null);
  const folderAnchor = React.useRef<View | null>(null);
  const [open, setOpen] = React.useState<'machine' | 'folder' | null>(null);
  const chip = useSessionAuthoringChipRenderContext(machineAnchor);
  const { machinePopover, pathPopover } = useSessionPlacementPopovers(props);
  const qualifiedLabel = usePlacementMachineLabel(props.serverId, props.machine, props.machines);
  const machineLabel = props.machine ? qualifiedLabel : (props.machineName ?? null);
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
  // In a form the pickers hang below their fields; on a chip row they open above, as the composer's do.
  const popoverAnchor = props.presentation === 'fields' ? 'field' as const : undefined;
  const popovers = (
    <>
      {open === 'machine' ? <PlacementPopover config={machinePopover} anchorRef={machineAnchor} onClose={close} {...(popoverAnchor ? { anchor: popoverAnchor } : {})} /> : null}
      {open === 'folder' ? <PlacementPopover config={pathPopover} anchorRef={folderAnchor} onClose={close} {...(popoverAnchor ? { anchor: popoverAnchor } : {})} /> : null}
    </>
  );

  if (props.renderChip !== undefined) {
    return (
      <>
        {props.renderChip({ field: 'machine', title: t('newSession.wizardSection.machine'), value: machineLabel,
          placeholder: t('agentInput.runOn'), anchorRef: machineAnchor, open: open === 'machine', disabled: !machineChoosable,
          onPress: () => setOpen(open === 'machine' ? null : 'machine'), testID: 'agent-input-machine-chip' })}
        {props.renderChip({ field: 'folder', title: t('newSession.wizardSection.folder'), value: machineKnown && path ? folderLabel : null,
          placeholder: folderLabel, anchorRef: folderAnchor, open: open === 'folder', disabled: !machineKnown,
          onPress: () => setOpen(open === 'folder' ? null : 'folder'), testID: 'agent-input-path-chip' })}
        {open === 'machine' ? <PlacementPopover config={machinePopover} anchorRef={machineAnchor} onClose={close} anchor="field" /> : null}
        {open === 'folder' ? <PlacementPopover config={pathPopover} anchorRef={folderAnchor} onClose={close} anchor="field" /> : null}
      </>
    );
  }

  if (props.presentation === 'fields' && props.renderFieldRow !== undefined) {
    const machineTitle = t('newSession.wizardSection.machine');
    const folderTitle = t('newSession.wizardSection.folder');
    return (
      <>
        {/* The outcome line says where the work runs under the Machine it depends on (lab J6), on the field's edge. */}
        {props.renderFieldRow('machine', machineTitle, withOutcome(outcomeLine,
          <PlacementField anchorRef={machineAnchor} testID="agent-input-machine-chip" span="column"
            label={machineTitle} value={machineLabel} placeholder={t('agentInput.runOn')}
            open={open === 'machine'} disabled={!machineChoosable} onPress={() => setOpen('machine')} />))}
        {props.renderFieldRow('folder', folderTitle,
          <PlacementField anchorRef={folderAnchor} testID="agent-input-path-chip" span="column"
            label={folderTitle} value={folderLabel} placeholder={folderLabel}
            open={open === 'folder'} disabled={!machineKnown} onPress={() => setOpen('folder')} />)}
        {props.trailing}
        {popovers}
      </>
    );
  }

  if (props.presentation === 'fields') {
    return (
      <Item
        {...(props.rowTestID === undefined ? {} : { testID: props.rowTestID })}
        title={props.title ?? t('newSession.wizardSection.machine')}
        {...(props.subtitle === undefined ? {} : { subtitle: props.subtitle, subtitleLines: 0 })}
        accessoryLayout="stacked"
        showChevron={false}
        selected={false}
        {...(outcomeLine ? { bottomElement: outcomeLine } : {})}
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
    return withOutcome(outcomeLine,
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
      </View>);
  }

  return withOutcome(outcomeLine,
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
    </View>);
}

/** A chip row with the isolation outcome under it; without one, the row alone (no extra wrapper). */
/** The outcome line reads only whether the Machine answers; other presence facts changing wake nothing. */
function sameReachability(left: Readonly<{ reachability: string }>, right: Readonly<{ reachability: string }>): boolean {
  return left.reachability === right.reachability;
}

function withOutcome(outcomeLine: React.ReactNode, row: React.ReactElement): React.ReactElement {
  return outcomeLine ? <View>{row}{outcomeLine}</View> : row;
}

/**
 * A form's Machine alone (where a deploy, a build or a backup runs; which Machine holds a Provider's
 * login): one field row opening New Session's Machine picker, as the placement fields do. The host owns
 * the value and the list; absent `machines`, the open picker resolves this Home's Machines itself.
 */
export function SessionMachineField(props: Readonly<{
  serverId: string;
  machineId: string | null;
  /** The host's eligible Machines (a deploy's linkable ones); absent: this Home's launch Machines. */
  machines?: readonly Machine[];
  /** The chosen Machine's name when no listed record names it (a Machine no longer known). */
  machineName?: string | null;
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
  placeholder?: string;
  /**
   * Listed first and shown while no Machine is chosen ("Your usual Machine", "Automatic"). `value` is what the
   * field says while it holds, when the host knows more ("Automatic · Studio"). `selected` (default: no Machine
   * chosen) is for a host whose empty value is neither ("Choose…" before a first answer).
   */
  defaultChoice?: Omit<NonNullable<SessionMachineChoiceParams['defaultChoice']>, 'selected'>
    & Readonly<{ value?: string; selected?: boolean }>;
  awayMachinesChoosable?: boolean;
  disabled?: boolean;
  showDivider?: boolean;
  testID?: string;
  /** Absent: the Machine is fixed by the host, and the field only names it. */
  onSelectMachine?: (machine: Machine) => void;
  /** `field` (default): a form row. `chip`: the bordered chip of a page or sheet header ("Runs on ⌄"). */
  presentation?: 'field' | 'chip';
  /** The chip's presence dot follows this Machine (the one a default resolves to); default: the chosen one. */
  presenceMachineId?: string | null;
  /** A host that opens the picker itself (a card asking for a Machine) controls it. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}>): React.ReactElement {
  const anchor = React.useRef<View | null>(null);
  const [ownOpen, setOwnOpen] = React.useState(false);
  const open = props.open ?? ownOpen;
  const { onOpenChange } = props;
  const setOpen = React.useCallback((next: boolean) => {
    setOwnOpen(next);
    onOpenChange?.(next);
  }, [onOpenChange]);
  const choosable = props.onSelectMachine !== undefined && props.disabled !== true;
  const hostMachine = props.machines?.find((machine) => machine.id === props.machineId) ?? null;
  const homeMachine = useServerScopedMachine(props.serverId, props.machines === undefined ? props.machineId : null);
  const machine = hostMachine ?? homeMachine;
  const activeServer = useNewSessionActiveServerSource();
  const machineInventory = React.useMemo(() => ({
    allowedServerIds: [props.serverId],
    activeServerId: activeServer.activeServerId,
    refreshToken: activeServer.serverProfilesSignature,
    targetServerId: props.serverId,
    recentMachinePaths: NO_MACHINE_PATHS,
    favoriteMachineIds: NO_STRINGS,
  }), [activeServer.activeServerId, activeServer.serverProfilesSignature, props.serverId]);
  const hostMachines = props.machines;
  const machineGroups = React.useMemo(() => hostMachines === undefined ? undefined : [{
    serverId: props.serverId, serverName: '', loading: false, signedOut: false,
    machines: hostMachines.map((row) => buildServerScopedMachine(row, { serverId: props.serverId, serverName: '' })),
  }], [hostMachines, props.serverId]);
  // Choosing the value already held is no change.
  const select = useEventCallback((next: Machine) => {
    if (next.id !== props.machineId) props.onSelectMachine?.(next);
  });
  const defaultChoice = props.defaultChoice;
  const defaultSelected = props.machineId === null && defaultChoice?.selected !== false;
  const machinePopover = useSessionMachineChoicePopover({
    selectedMachine: machine,
    selectedServerId: props.serverId,
    targetServerId: props.serverId,
    selectMachineTarget: select,
    ...(machineGroups === undefined ? { machineInventory } : { machineGroups }),
    useMachinePickerSearch: true,
    awayMachinesChoosable: props.awayMachinesChoosable === true,
    ...(defaultChoice ? { defaultChoice: { ...defaultChoice, selected: defaultSelected } } : {}),
    ...(props.testID === undefined ? {} : { testIdPrefix: `${props.testID}-machine` }),
  });
  const machineLabel = usePlacementMachineLabel(props.serverId, machine, props.machines);
  const value = machine ? machineLabel ?? props.machineName ?? null
    : props.machineId !== null ? props.machineName ?? null
      : defaultChoice && defaultSelected ? defaultChoice.value ?? defaultChoice.title : null;
  const close = React.useCallback(() => setOpen(false), [setOpen]);
  const openPicker = React.useCallback(() => setOpen(true), [setOpen]);
  const presence = useMachinePresenceSummary(props.serverId, props.presentation === 'chip'
    ? (props.presenceMachineId ?? props.machineId) : null);
  if (props.presentation === 'chip') {
    const presenceShown = (props.presenceMachineId ?? props.machineId) != null;
    return (
      <SelectionListFilterChip filter={{
        id: props.testID ?? 'session-machine',
        label: props.title,
        showLabel: true,
        valueLabel: value ?? props.placeholder ?? t('agentInput.runOn'),
        icon: <PlacementIcon name="desktop" />,
        ...(presenceShown ? { reservePresence: true } : {}),
        ...(presenceShown && presence.reachability === 'reachable' ? { presence: 'online' as const }
          : presenceShown && presence.reachability === 'unreachable' ? { presence: 'offline' as const } : {}),
        muted: value === null || (props.machineId !== null && machine === null),
        disabled: !choosable,
        open,
        onOpenChange: setOpen,
        renderPopoverContent: (context) => renderPlacementContent(machinePopover, context),
        ...(props.testID === undefined ? {} : { testID: props.testID }),
      }} />
    );
  }
  return (
    <Item
      {...(props.testID === undefined ? {} : { testID: props.testID })}
      title={props.title}
      {...(props.subtitle === undefined ? {} : { subtitle: props.subtitle })}
      {...(props.icon === undefined ? {} : { icon: props.icon })}
      accessoryLayout="adaptive"
      fieldAccessory
      showChevron={false}
      selected={false}
      disabled={!choosable}
      {...(props.showDivider === undefined ? {} : { showDivider: props.showDivider })}
      accessibilityExpanded={open}
      webRole="button"
      {...(choosable ? { onPress: openPicker } : {})}
      rightElement={
        <>
          <PlacementField anchorRef={anchor} testID={`${props.testID ?? 'session-machine-field'}.field`}
            label={props.title} value={value} placeholder={props.placeholder ?? t('agentInput.runOn')}
            open={open} disabled={!choosable} span="column" />
          {open ? <PlacementPopover config={machinePopover} anchorRef={anchor} onClose={close} anchor="field" /> : null}
        </>
      }
    />
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
  /** Absent: the row around the field is the control, and the field only shows the value and anchors the picker. */
  onPress?: () => void;
  /** `row` beneath its label (the placement row); `column` beside it in an adaptive form row. */
  span?: 'row' | 'column';
}>): React.ReactElement {
  const { theme } = useUnistyles();
  const fieldColors = React.useMemo(() => resolveFieldBoxColors(theme), [theme]);
  const box = renderDropdownItemTriggerRightElement({
    detail: props.value,
    open: props.open,
    detailColor: props.disabled ? theme.colors.text.tertiary : theme.colors.text.secondary,
    chevronColor: theme.colors.text.secondary,
    field: fieldColors,
    fieldSpan: props.span ?? 'row',
    placeholder: props.placeholder,
    placeholderColor: theme.colors.input.placeholder,
  });
  return (
    <View ref={props.anchorRef} collapsable={false}>
      {props.onPress === undefined ? box : (
        <HappierPressable
          testID={props.testID}
          accessibilityRole="button"
          accessibilityLabel={`${props.label}: ${props.value ?? props.placeholder}`}
          expanded={props.open}
          disabled={props.disabled}
          {...(props.disabled ? {} : { onPress: props.onPress })}
        >
          {box}
        </HappierPressable>
      )}
    </View>
  );
}

function PlacementPopover(
  props: Readonly<{
    config: AgentInputContentPopoverConfig;
    anchorRef: React.RefObject<View | null>;
    onClose: () => void;
    /** `field`: a form's field, whose picker hangs below it; default: a chip's, above. */
    anchor?: 'field';
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
      {...(props.anchor === undefined ? {} : { anchor: props.anchor })}
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
  // The chips wrap within whatever row holds them: it shrinks there rather than overflowing (F6, phone trigger card).
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: theme.space.s6,
    flexShrink: 1,
    minWidth: 0,
  },
}));
