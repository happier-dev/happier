import * as React from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';
import { HappierPressable, happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { PageHeader } from '@/components/ui/layout/PageHeader';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import type { CustomModalInjectedProps } from '@/modal/types';
import { t } from '@/text';

import {
  MachineConfigurationReceipt,
  type ManagedReceiptModel,
} from './MachineConfigurationReceipt';
import { ManagedReceiptPageLayout } from './ManagedReceiptPageLayout';
import { useLiveValue, useLiveValueChannel, type LiveValueChannel } from './liveValueChannel';

/** What the phone's sticky bar says about the draft: its price (or "No bill") and the choices in one line. */
export type ManagedConfiguratorSummary = Readonly<{
  value: string;
  unit: string;
  spec: string;
}>;

/**
 * One configurator for every provisioner (plan 51, lab `m-config`): the page header, the provider's
 * choice sections (account, size, image, location — composed by the caller from the shared choice
 * owners), and the receipt. Desktop keeps the receipt beside the choices so the consequence never
 * leaves view; a phone keeps a sticky summary bar whose press opens the receipt as a sheet. Opening
 * or closing the sheet never creates or cancels anything; Create is the receipt's one primary action.
 */
export const ManagedMachineConfigurator = React.memo(
  function ManagedMachineConfigurator(
    props: Readonly<{
      title: string;
      description: string;
      mark: React.ReactNode;
      children: React.ReactNode;
      receipt: ManagedReceiptModel;
      summary: ManagedConfiguratorSummary;
      compact: boolean;
      testID: string;
    }>,
  ) {
    const channel = useLiveValueChannel(props.receipt);
    const receiptSheet = React.useRef<string | null>(null);
    React.useEffect(() => () => {
      if (receiptSheet.current) Modal.hide(receiptSheet.current);
    }, []);
    if (!props.compact) {
    return (
      <ManagedReceiptPageLayout
        header={{ title: props.title, description: props.description, leading: props.mark }}
        receipt={props.receipt}
        compact={false}
        testID={props.testID}
      >
        {props.children}
      </ManagedReceiptPageLayout>
    );
  }
  return (
      <View style={styles.phone} testID={props.testID}>
        <ItemList style={styles.phoneList}>
          <PageHeader
            title={props.title}
            description={props.description}
            leading={props.mark}
          />
          {props.children}
        </ItemList>
        <SummaryBar
          summary={props.summary}
          primary={props.receipt.primary}
          onOpen={() => {
            if (receiptSheet.current) Modal.hide(receiptSheet.current);
            receiptSheet.current = showReceiptSheet(channel, `${props.testID}.receipt`);
          }}
          testID={`${props.testID}.summary`}
        />
      </View>
    );
  },
);

function SummaryBar(
  props: Readonly<{
    summary: ManagedConfiguratorSummary;
    primary: ManagedReceiptModel['primary'];
    onOpen: () => void;
    testID: string;
  }>,
) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, 12) }]}>
      <HappierPressable
        testID={props.testID}
        accessibilityRole="button"
        accessibilityLabel={`${props.summary.value} ${props.summary.unit}, ${props.summary.spec}`}
        accessibilityHint={t('managedMachines.receipt.openSummary')}
        hasPopup="dialog"
        onPress={props.onOpen}
        style={styles.barSummary}
      >
        <View style={styles.barValueRow}>
          <Text style={styles.barValue}>{props.summary.value}</Text>
          <Text style={styles.barUnit}>{props.summary.unit}</Text>
        </View>
        <Text style={styles.barSpec} numberOfLines={1}>
          {props.summary.spec}
        </Text>
      </HappierPressable>
      {props.primary ? (
        <RoundButton
          testID={props.primary.testID ?? `${props.testID}.create`}
          size="normal"
          title={props.primary.label}
          accessibilityLabel={props.primary.label}
          disabled={props.primary.disabled}
          loading={props.primary.loading}
          onPress={props.primary.onPress}
        />
      ) : null}
    </View>
  );
}

function showReceiptSheet(channel: LiveValueChannel<ManagedReceiptModel>, testID: string) {
  return Modal.show({ component: ReceiptSheet, props: { channel, testID } });
}

function ReceiptSheet(
  props: Readonly<{ channel: LiveValueChannel<ManagedReceiptModel>; testID: string }> &
    CustomModalInjectedProps,
) {
  const model = useLiveValue(props.channel);
  const { setChrome } = props;
  React.useEffect(() => {
    setChrome?.({
      kind: 'card',
      header: 'none',
      title: t('managedMachines.receipt.summary'),
      phonePresentation: 'sheet',
    });
  }, [setChrome]);
  return <MachineConfigurationReceipt model={model} testID={props.testID} />;
}

const styles = StyleSheet.create((theme) => ({
  phone: {
    flex: 1,
  },
  phoneList: {
    flex: 1,
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.subtle,
    backgroundColor: theme.colors.surface.base,
  },
  barSummary: {
    flex: 1,
    minWidth: 0,
  },
  barValueRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 4,
  },
  barValue: {
    ...Typography.default('bold'),
    ...Typography.tabular(),
    ...happierPageTextMetrics('sectionTitle'),
    color: theme.colors.text.primary,
  },
  barUnit: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.secondary,
  },
  barSpec: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.secondary,
  },
}));
