import * as React from 'react';
import { View } from 'react-native';

import { PageAsideColumns } from '@/components/ui/layout/PageAsideColumns';
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
 * A machine's choices beside their receipt (configurator, preset, created machine), in the shared
 * page-aside columns: the receipt stays in view while the sections scroll, so the consequence never
 * leaves the screen; a phone (or a pane too narrow for both) reads the sections first and the receipt
 * after. `compactReceipt="first"` leads a phone with the receipt when the receipt is the thing's
 * identity (a preset is its launch).
 */
export const ManagedReceiptColumns = React.memo(function ManagedReceiptColumns(
  props: Readonly<{
    children: React.ReactNode;
    receipt: ManagedReceiptModel | null;
    compact: boolean;
    closing?: React.ReactNode;
    compactReceipt?: 'first' | 'last';
    /**
     * A review its receipt's own action opened (Delete…): it opens in place under the receipt, beside the
     * button that asked for it, instead of at the far end of the page.
     */
    receiptFollowUp?: React.ReactNode;
    testID: string;
  }>,
) {
  return (
    <PageAsideColumns
      aside={props.receipt ? (
        <View testID={`${props.testID}.receipt-aside`}>
          <MachineConfigurationReceipt
            model={props.receipt}
            testID={`${props.testID}.receipt`}
          />
          {props.receiptFollowUp}
        </View>
      ) : null}
      compact={props.compact}
      closing={props.closing}
      compactAside={props.compactReceipt}
    >
      {props.children}
    </PageAsideColumns>
  );
});

/**
 * A page about a machine's choices: the header, then the sections beside their receipt.
 */
export const ManagedReceiptPageLayout = React.memo(
  function ManagedReceiptPageLayout(
    props: Readonly<{
      header: PageHeaderProps;
      /** The page's state notices (archived, unavailable): above both columns, where a phone also reads them before the receipt. */
      notice?: React.ReactNode;
      children: React.ReactNode;
      receipt: ManagedReceiptModel | null;
      compact: boolean;
      closing?: React.ReactNode;
      compactReceipt?: 'first' | 'last';
      testID: string;
    }>,
  ) {
    return (
      <ItemList testID={props.testID} pageColumn="wide">
        <PageHeader {...props.header} />
        {props.notice}
        <ManagedReceiptColumns
          receipt={props.receipt}
          compact={props.compact}
          closing={props.closing}
          compactReceipt={props.compactReceipt}
          testID={props.testID}
        >
          {props.children}
        </ManagedReceiptColumns>
      </ItemList>
    );
  },
);
