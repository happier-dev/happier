import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { getMachineDropdownMenuItems } from '@/components/settings/pickers/machineDropdownItems';
import { Icon } from '@/components/ui/icons/Icon';
import { SelectionListFilterChip } from '@/components/ui/selectionList/SelectionListFilterChips';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useMachinePresenceSummary } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { useMachineListForServerSelection } from '@/sync/store/hooks';
import { t } from '@/text';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { resolveMachineActionCandidates } from '@/utils/sessions/resolveMachineActionCandidates';

import { PATH_BROWSER_MODAL_TEST_ID } from './pathBrowserTestIds';

const allMachines = (machines: readonly Machine[]) => machines;

/**
 * Which Machine the folder picker is browsing: its name and presence. A caller that takes the Machine back
 * (`onChange`) gets the shared Machine list as the chooser when the Home has more than one launch Machine.
 */
export function MachinePathBrowserMachineChip(
  props: Readonly<{
    serverId?: string | null;
    machineId: string;
    onChange?: (machineId: string) => void;
  }>,
) {
  const { theme } = useUnistyles();
  const activeServerId = useActiveServerSnapshot().serverId;
  const serverId = props.serverId ?? activeServerId ?? '';
  const accountScope = useActiveServerAccountScope();
  const machines = useMachineListForServerSelection(serverId, allMachines);
  const presence = useMachinePresenceSummary(serverId, props.machineId);
  const { onChange, machineId } = props;
  const { items, browsable } = React.useMemo(() => {
    const scope = selectActiveServerAccountScopeForServer(
      accountScope ?? null,
      serverId,
    );
    // Only a Machine that can work can be browsed; the others stay listed with their state.
    const browsable = new Set(
      resolveMachineActionCandidates(scope, machines).map((machine) => machine.id),
    );
    const items = getMachineDropdownMenuItems({
      // The Machines that can work lead, as wherever a Machine is chosen; offline ones stay below.
      machines: resolveMachineActionCandidates(scope, machines, {
        onlineOnly: false,
      }),
      scope,
      iconColor: theme.colors.text.secondary,
      iconSize: 16,
      onlineLabel: t('status.online'),
      offlineLabel: t('status.offline'),
    });
    return { items, browsable };
  }, [accountScope, machines, serverId, theme.colors.text.secondary]);
  const options = React.useMemo(
    () =>
      onChange && items.length > 1
        ? items.map((item) => ({
            id: item.id,
            label: item.title,
            subtitle: item.subtitle,
            icon: item.icon,
            ...(item.id !== machineId && !browsable.has(item.id)
              ? { disabled: true }
              : {}),
          }))
        : undefined,
    [browsable, items, machineId, onChange],
  );
  const choose = React.useCallback(
    (id: string) => {
      if (id !== machineId) onChange?.(id);
    },
    [machineId, onChange],
  );
  const valueLabel =
    items.find((item) => item.id === machineId)?.title ??
    presence.name ??
    getMachineDisplayName({ id: machineId, absence: 'unlisted' });
  return (
    <SelectionListFilterChip
      filter={{
        id: 'pathBrowserMachine',
        label: t('newSession.pathPicker.machine'),
        valueLabel,
        icon: (
          <Icon name="desktop" size={14} color={theme.colors.text.secondary} />
        ),
        reservePresence: true,
        ...(presence.reachability === 'reachable'
          ? { presence: 'online' as const }
          : presence.reachability === 'unreachable'
            ? { presence: 'offline' as const }
            : {}),
        ...(options
          ? { options, selectedId: machineId, onChange: choose }
          : {}),
        testID: `${PATH_BROWSER_MODAL_TEST_ID}.machine`,
      }}
    />
  );
}
