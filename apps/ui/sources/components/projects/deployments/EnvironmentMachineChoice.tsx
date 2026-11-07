import * as React from 'react';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { useMachineListForServer } from '@/sync/store/hooks';
import { t } from '@/text';
import { getSettledMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { useDeviceType } from '@/utils/platform/responsive';

/**
 * A Machine setting as a value and a menu of this Home's Machines (the link sheet's same select); choosing one is
 * the change. A Machine away right now stays choosable and says so.
 */
export function EnvironmentMachineChoice(
  props: Readonly<{
    testID: string;
    serverId: string;
    icon: React.ReactNode;
    title: string;
    currentMachineId: string | null;
    fallback: string;
    subtitle?: string;
    showDivider?: boolean;
    defaultChoice?: Readonly<{ title: string; onChoose: () => void }>;
    disabled: boolean;
    onChoose: (machineId: string) => void;
  }>,
) {
  const all = useMachineListForServer(props.serverId);
  const phone = useDeviceType() === 'phone';
  const [open, setOpen] = React.useState(false);
  const items = React.useMemo((): DropdownMenuItem[] => {
    const machines = all ?? [];
    // A Machine still being read has no name to choose by; the current one keeps the page's name for it.
    const known = props.currentMachineId === null || machines.some((machine) => machine.id === props.currentMachineId);
    const missing: DropdownMenuItem[] = known ? [] : [{ id: props.currentMachineId!, title: props.fallback, checked: true }];
    return [...(props.defaultChoice ? [{ id: '', title: props.defaultChoice.title }] : []), ...missing, ...machines.flatMap((machine) => {
      const current = machine.id === props.currentMachineId;
      const name = getSettledMachineDisplayName(machine, machines) ?? (current ? props.fallback : null);
      return name ? [{
        id: machine.id,
        testID: `${props.testID}.${machine.id}`,
        title: name,
        subtitle: isMachineOnline(machine) ? undefined : t('projects.deployments.machineAway'),
        checked: current,
      }] : [];
    })];
  }, [all, props.currentMachineId, props.defaultChoice, props.fallback, props.testID]);
  return (
    <DropdownMenu
      testID={props.testID}
      open={open}
      onOpenChange={(next) => setOpen(next && !props.disabled)}
      items={items}
      selectedId={props.currentMachineId ?? (props.defaultChoice ? '' : null)}
      onSelect={(machineId) => {
        setOpen(false);
        if (props.disabled) return;
        if (machineId === '' && props.defaultChoice) { props.defaultChoice.onChoose(); return; }
        if (machineId !== props.currentMachineId) props.onChoose(machineId);
      }}
      itemTrigger={{
        title: props.title,
        subtitle: props.subtitle,
        icon: props.icon,
        showSelectedSubtitle: false,
        detailFormatter: (selected) => selected?.title ?? props.fallback,
        // A field select is wider than a short value: on a phone it always sits beneath its label.
        itemProps: { accessoryLayout: phone ? 'stacked' : 'adaptive', disabled: props.disabled, showDivider: props.showDivider },
      }}
    />
  );
}
