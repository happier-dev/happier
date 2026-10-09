import * as React from 'react';
import {
  Platform,
  View,
  type LayoutChangeEvent,
  type ViewStyle,
} from 'react-native';
import {
  HAPPIER_COLUMN_MIN_WIDTH_PX,
  HAPPIER_PAGE_METRICS,
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
 * The receipt column: the lab's 304px receipt sheet plus the sheet inset every `ItemGroup` already
 * carries on both sides (lab `m-config`/`m-detail`, `.fm-cfg`). The sections beside it keep at least
 * the list-row column floor; narrower than both, the receipt moves below the sections.
 */
const RECEIPT_SHEET_WIDTH_PX = 304;
const RECEIPT_COLUMN_WIDTH_PX =
  RECEIPT_SHEET_WIDTH_PX + 2 * HAPPIER_PAGE_METRICS.sheetInsetPx;
const SIDE_BY_SIDE_MIN_WIDTH_PX =
  RECEIPT_COLUMN_WIDTH_PX + HAPPIER_COLUMN_MIN_WIDTH_PX;

/**
 * A machine's choices beside their receipt (configurator, preset, created machine). Desktop keeps the
 * receipt in its own column that stays in view while the sections scroll, so the consequence never
 * leaves the screen; a phone (or a pane too narrow for both) reads the sections first and the receipt
 * after. `compact` is the caller's phone decision; width alone decides side by side otherwise.
 */
export const ManagedReceiptColumns = React.memo(function ManagedReceiptColumns(
  props: Readonly<{
    children: React.ReactNode;
    receipt: ManagedReceiptModel | null;
    compact: boolean;
    testID: string;
  }>,
) {
  // Split panes are wide enough by construction, so the first paint is already final there.
  const [wide, setWide] = React.useState(!props.compact);
  const onLayout = React.useCallback((event: LayoutChangeEvent) => {
    const width = event.nativeEvent.layout.width;
    if (!Number.isFinite(width) || width <= 0) return;
    const next = width >= SIDE_BY_SIDE_MIN_WIDTH_PX;
    setWide((current) => (current === next ? current : next));
  }, []);
  const receipt = props.receipt ? (
    <MachineConfigurationReceipt
      model={props.receipt}
      testID={`${props.testID}.receipt`}
    />
  ) : null;
  if (props.compact || !receipt) {
    return (
      <>
        {props.children}
        {receipt}
      </>
    );
  }
  return (
    <View onLayout={onLayout} style={wide ? styles.row : undefined}>
      <View style={wide ? styles.main : undefined}>{props.children}</View>
      <View style={wide ? styles.aside : undefined}>{receipt}</View>
    </View>
  );
});

/**
 * A page about a machine's choices: the header, then the sections beside their receipt.
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
    return (
      <ItemList testID={props.testID}>
        <PageHeader {...props.header} />
        <ManagedReceiptColumns
          receipt={props.receipt}
          compact={props.compact}
          testID={props.testID}
        >
          {props.children}
        </ManagedReceiptColumns>
      </ItemList>
    );
  },
);

// Web only: the page's one scroll owner keeps the receipt pinned below its top edge (lab `.fm-cfg .r`).
// React Native Web passes `sticky` through to CSS; native platforms scroll it with the page.
const stickyAside: ViewStyle =
  Platform.OS === 'web'
    ? {
        position: 'sticky' as 'relative',
        top: HAPPIER_PAGE_METRICS.sheetInsetPx,
      }
    : {};

const styles = {
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  main: {
    flex: 1,
    minWidth: 0,
  },
  aside: {
    width: RECEIPT_COLUMN_WIDTH_PX,
    flexShrink: 0,
    ...stickyAside,
  },
} satisfies Record<string, ViewStyle>;
