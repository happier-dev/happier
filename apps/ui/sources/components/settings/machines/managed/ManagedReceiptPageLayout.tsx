import * as React from 'react';
import {
  HappierColumn,
  HappierColumns,
} from '@happier-dev/plugin-ui/presentation';

import {
  PageHeader,
  type PageHeaderProps,
} from '@/components/ui/layout/PageHeader';
import { ItemList } from '@/components/ui/lists/ItemList';

import {
  MachineConfigurationReceipt,
  type ManagedReceiptModel,
} from './MachineConfigurationReceipt';

/**
 * A page about a machine's choices (configurator, preset, created machine): the header, the page's own
 * sections, and the receipt beside them where there is room — below them where there is not, so a
 * phone reads the work first and the recipe after.
 */
export const ManagedReceiptPageLayout = React.memo(
  function ManagedReceiptPageLayout(
    props: Readonly<{
      header: PageHeaderProps;
      children: React.ReactNode;
      receipt: ManagedReceiptModel | null;
      compact: boolean;
      testID: string;
    }>,
  ) {
    const receipt = props.receipt ? (
      <MachineConfigurationReceipt
        model={props.receipt}
        testID={`${props.testID}.receipt`}
      />
    ) : null;
    return (
      <ItemList testID={props.testID}>
        <PageHeader {...props.header} />
        {props.compact || !receipt ? (
          <>
            {props.children}
            {receipt}
          </>
        ) : (
          <HappierColumns columns={3} minColumnWidthPx={300}>
            <HappierColumn span={2}>{props.children}</HappierColumn>
            <HappierColumn span={1}>{receipt}</HappierColumn>
          </HappierColumns>
        )}
      </ItemList>
    );
  },
);
