import * as React from 'react';

import { useAccountEncryptionMode } from '@/components/settings/account/useAccountEncryptionMode';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

import { machineDataDisclosure } from './machineDataDisclosure';

/** What leaves this Machine, beneath the ways to add one (lab dConnect #2). Says nothing until the Account's mode is known. */
export const MachineDataDisclosureSection = React.memo(
  function MachineDataDisclosureSection(props: Readonly<{ testID: string }>) {
    const disclosure = machineDataDisclosure(useAccountEncryptionMode());
    if (!disclosure) return null;
    return (
      <ItemGroup
        testID={props.testID}
        title={t('machineDataDisclosure.title')}
        description={disclosure.description}
      >
        {disclosure.rows.map((row) => (
          <Item
            key={row.id}
            testID={`${props.testID}.${row.id}`}
            title={row.title}
            subtitle={row.detail}
            showChevron={false}
            mode="info"
          />
        ))}
      </ItemGroup>
    );
  },
);
