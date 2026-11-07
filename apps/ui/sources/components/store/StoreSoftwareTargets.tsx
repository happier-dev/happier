import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { MachineRowMark } from '@/components/sessions/new/components/machineSelection/MachineSelectionRowAccessory';
import { SelectionListFilterChip } from '@/components/ui/selectionList';
import { ICON_SIZE } from '@/components/ui/icons/Icon';
import {
  useReachMachines,
  type ReachMachine,
} from '@/sync/domains/capabilities/reach/useReachProjection';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { t } from '@/text';

import type { StoreSoftwareTarget } from './catalog/storeSoftware';

/** The Machines a Software page can name, in one order: reachable first, then by name. */
export type SoftwareMachines = Readonly<{
  targets: readonly SoftwareMachineTarget[];
}>;
export type SoftwareMachineTarget = Readonly<{
  machine: ReachMachine;
  target: StoreSoftwareTarget;
}>;

export function softwareMachineName(machine: ReachMachine): string {
  return machine.name ?? t('storeInstalled.machineFallback');
}

/** Why a Machine cannot take part now, in words; null while it is reachable. */
export function softwareMachineUnavailableReason(
  machine: ReachMachine,
): string | null {
  if (machine.online === false)
    return t('capabilities.store.softwarePage.targetOffline');
  if (machine.online === null)
    return t('capabilities.store.softwarePage.targetUnknown');
  return null;
}

/**
 * The one line Software shows when no Machine can be chosen to read from (every Machine offline or unreachable), in
 * place of a chooser that cannot succeed. Null while one can be chosen, or when the Account has none to name.
 */
export function softwareMachinesUnreachableLine(machines: SoftwareMachines): string | null {
  const { targets } = machines;
  if (targets.length === 0 || targets.some((entry) => entry.machine.online === true)) return null;
  if (targets.length > 1) return t('capabilities.store.softwarePage.noneReachable');
  const only = targets[0]!.machine;
  const machine = softwareMachineName(only);
  return only.online === false
    ? t('capabilities.store.softwarePage.offline', { machine })
    : t('capabilities.store.softwarePage.unknown', { machine });
}

/** A reachable Machine's platform facts ("Linux · x64"); an unreachable one says why instead. */
export function softwareMachineFacts(machine: ReachMachine): string {
  const reason = softwareMachineUnavailableReason(machine);
  if (reason) return reason;
  const os =
    machine.os === 'linux'
      ? 'Linux'
      : machine.os === 'darwin'
        ? 'macOS'
        : machine.os === 'win32'
          ? 'Windows'
          : machine.os;
  return [os, machine.arch].filter(Boolean).join(' · ');
}

/**
 * The listing's Install on rows: reachable and unknown Machines stay; offline ones fold behind one line, said once,
 * because a fleet keeps dozens of sleeping Machines (as the Machines index folds them). One already turned on stays
 * so it can be turned off.
 */
export function foldOfflineSoftwareTargets(
  targets: readonly SoftwareMachineTarget[],
  chosen: Pick<ReadonlySet<string>, 'has'>,
): Readonly<{ shown: readonly SoftwareMachineTarget[]; offline: readonly SoftwareMachineTarget[] }> {
  const shown: SoftwareMachineTarget[] = [];
  const offline: SoftwareMachineTarget[] = [];
  for (const entry of targets) {
    if (entry.machine.online === false && !chosen.has(entry.machine.machineId)) offline.push(entry);
    else shown.push(entry);
  }
  return { shown, offline };
}

/** The Account's Machines as exact Software targets, from the one reach owner (no daemon reads). */
export function useSoftwareMachines(): SoftwareMachines {
  const reach = useReachMachines();
  return React.useMemo(() => {
    const scope = reach.scope;
    const serverIdentityId = scope
      ? getServerProfileById(scope.serverId)?.serverIdentityId
      : undefined;
    if (!scope || !serverIdentityId) return { targets: [] };
    const rank = (machine: ReachMachine) =>
      machine.online === true ? 0 : machine.online === null ? 1 : 2;
    const targets = [...reach.machines]
      .sort(
        (left, right) =>
          rank(left) - rank(right) ||
          softwareMachineName(left).localeCompare(softwareMachineName(right)),
      )
      .map((machine) => ({
        machine,
        target: {
          scope,
          machine: { serverIdentityId, machineId: machine.machineId },
        },
      }));
    return { targets };
  }, [reach.scope, reach.machines]);
}

/** A Machine's own mark (this computer, a created Machine's provider, else the device glyph). */
export function SoftwareMachineMark(
  props: Readonly<{ entry: SoftwareMachineTarget; size?: number }>,
): React.ReactElement {
  const { theme } = useUnistyles();
  return (
    <MachineRowMark
      machineId={props.entry.machine.machineId}
      serverId={props.entry.target.scope?.serverId ?? ''}
      size={props.size ?? ICON_SIZE.md}
      color={
        props.entry.machine.online === true
          ? theme.colors.text.secondary
          : theme.colors.text.tertiary
      }
    />
  );
}

/**
 * Which Machine a Software browse reads (its plugins say what can be installed). One owner for the kind page and
 * Search: unreachable Machines keep their place, say why, and cannot be chosen.
 */
export function SoftwareMachineSelect(
  props: Readonly<{
    testID: string;
    machines: SoftwareMachines;
    selectedId: string | null;
    onSelect: (entry: SoftwareMachineTarget) => void;
    /** Search names no Machine until the person chooses one. */
    placeholder?: string;
  }>,
): React.ReactNode {
  const { machines, onSelect } = props;
  const options = React.useMemo(
    () =>
      machines.targets.map((entry) => {
        const reason = softwareMachineUnavailableReason(entry.machine);
        return {
          id: entry.machine.machineId,
          label: softwareMachineName(entry.machine),
          icon: <SoftwareMachineMark entry={entry} size={ICON_SIZE.sm} />,
          ...(reason ? { subtitle: reason, disabled: true } : {}),
        };
      }),
    [machines.targets],
  );
  const select = React.useCallback(
    (id: string) => {
      const entry = machines.targets.find(
        (candidate) => candidate.machine.machineId === id,
      );
      if (entry && entry.machine.online === true) onSelect(entry);
    },
    [machines.targets, onSelect],
  );
  return (
    <SelectionListFilterChip filter={{
      id: 'store-software-machine',
      testID: props.testID,
      label: t('capabilities.store.softwarePage.machineLabel'),
      options,
      selectedId: props.selectedId,
      onChange: select,
      // Search names no Machine until the person chooses one.
      ...(props.placeholder && !options.some((option) => option.id === props.selectedId)
        ? { valueLabel: props.placeholder, muted: true }
        : {}),
    }} />
  );
}

type TargetsDraft = Readonly<{
  chosen: ReadonlyMap<string, StoreSoftwareTarget>;
  setChosen: React.Dispatch<
    React.SetStateAction<ReadonlyMap<string, StoreSoftwareTarget>>
  >;
}>;
const TargetsDraftContext = React.createContext<TargetsDraft | null>(null);
const NO_TARGETS: ReadonlyMap<string, StoreSoftwareTarget> = new Map();

/**
 * The Machines a person turned on for Install on…, held by the Store page while it is mounted: closing one listing
 * and opening it (or another) again keeps them. Ephemeral; nothing is written anywhere.
 */
export function SoftwareTargetsDraftProvider(
  props: Readonly<{ children: React.ReactNode }>,
): React.ReactNode {
  const scope = useAccountSettingsScope();
  return <SoftwareTargetsDraft key={scope ? serverAccountScopeKeySuffix(scope) : 'unbound'}>{props.children}</SoftwareTargetsDraft>;
}

function SoftwareTargetsDraft(props: Readonly<{ children: React.ReactNode }>): React.ReactNode {
  const [chosen, setChosen] =
    React.useState<ReadonlyMap<string, StoreSoftwareTarget>>(NO_TARGETS);
  const value = React.useMemo(() => ({ chosen, setChosen }), [chosen]);
  return (
    <TargetsDraftContext.Provider value={value}>
      {props.children}
    </TargetsDraftContext.Provider>
  );
}

/** The page's Install on… choice, or the listing's own when no Store page holds one (a listing opened as a page). */
export function useSoftwareTargetsDraft(): TargetsDraft {
  const page = React.useContext(TargetsDraftContext);
  const [chosen, setChosen] =
    React.useState<ReadonlyMap<string, StoreSoftwareTarget>>(NO_TARGETS);
  return page ?? { chosen, setChosen };
}
