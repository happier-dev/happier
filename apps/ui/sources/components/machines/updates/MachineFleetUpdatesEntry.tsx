import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { Item, type ItemProps } from '@/components/ui/lists/Item';

import { useFleetUpdates } from './useFleetUpdates';

/**
 * The Machines column's Updates entry (pfc-redesign mIdx/fUpd): how many Machines have system updates waiting, in
 * amber, from the fleet updates owner. A leaf, so the column's other rows don't redraw when a count changes.
 */
export const MachineFleetUpdatesEntry = React.memo(
  function MachineFleetUpdatesEntry(
    props: Readonly<{
      serverId: string;
      item: Omit<ItemProps, 'detail' | 'detailStyle' | 'subtitle'>;
    }>,
  ) {
    const { theme } = useUnistyles();
    const waiting = useFleetUpdates(props.serverId).summary.withUpdates;
    return (
      <Item
        {...props.item}
        {...(waiting > 0
          ? {
              detail: String(waiting),
              detailStyle: { color: theme.colors.state.warning },
            }
          : {})}
      />
    );
  },
);
