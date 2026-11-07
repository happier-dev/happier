import * as React from 'react';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

/**
 * "Managed from" as its own row, for where the page header can't carry the chip: a phone folds header
 * actions into the navigation overflow, and a grouped surface has no section header actions. The chip is
 * wider than a short value beside a label, so it sits beneath the label.
 */
export function ManagedScopeRow(props: Readonly<{ chip: React.ReactNode; testID: string }>) {
  return (
    <ItemGroup>
      <Item
        testID={props.testID}
        title={t('managedMachines.config.managedFrom')}
        mode="info"
        showChevron={false}
        rightElement={props.chip}
        accessoryLayout="stacked"
      />
    </ItemGroup>
  );
}
