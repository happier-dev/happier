import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable, happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { PageHeader } from '@/components/ui/layout/PageHeader';
import { PagePinnedBar } from '@/components/ui/layout/PagePinnedBar';
import { Icon } from '@/components/ui/icons/Icon';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { ModalCardFooterActions } from '@/modal/components/card/ModalCardFooterActions';
import type { CustomModalInjectedProps } from '@/modal/types';
import { t } from '@/text';

import {
  MachineConfigurationReceipt,
  type ManagedReceiptModel,
} from './MachineConfigurationReceipt';
import { ManagedReceiptPageLayout } from './ManagedReceiptPageLayout';
import { ManagedScopeRow } from './ManagedScopeRow';
import { useLiveValue, useLiveValueChannel, type LiveValueChannel } from './liveValueChannel';

/** What the phone's sticky bar says about the draft: its price (or "No bill") and the choices in one line. */
export type ManagedConfiguratorSummary = Readonly<{
  value: string;
  unit: string;
  spec: string;
}>;

export type ManagedConfiguratorBlocker = Readonly<{
  kind: 'needsApp';
  title: string;
  /** Why, in the person's words, so the page still says what stands between them and Create. */
  reason?: string;
  action: Readonly<{ label: string; onPress(): void }>;
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
      /** The page's one-sentence purpose; a phone shows the title only (lab m-config Ap). */
      description?: string;
      mark: React.ReactNode;
      /** The page scope ("Managed from" chip): the header's actions slot, or its own row on a phone. */
      actions?: React.ReactNode;
      children: React.ReactNode;
      receipt: ManagedReceiptModel;
      summary: ManagedConfiguratorSummary;
      /** The owning model's next step, drawn in the form column by the surface owner. */
      blocker?: ManagedConfiguratorBlocker;
      compact: boolean;
      /**
       * Nothing is left to choose (a delegated preset's review): the receipt is the page body at every width, with its
       * own Create, instead of an aside beside an empty column or a summary bar over an empty phone page (TH MB-4).
       */
      receiptIsBody?: boolean;
      /**
       * Authored inside a sheet (Machine Isolation's add flow, lab add frame): one column, the receipt's facts and
       * rename at its foot, and its Save and the way out published as the sheet's footer through this setter.
       */
      sheetFooter?: (footer: React.ReactNode | null) => void;
      testID: string;
    }>,
  ) {
    const channel = useLiveValueChannel(props.receipt);
    const { sheetFooter, testID } = props;
    React.useEffect(() => {
      if (!sheetFooter) return;
      // One footer element per sheet: it reads the live receipt, so the sheet's chrome is published once.
      sheetFooter(<ReceiptSheetFooter channel={channel} testID={testID} />);
      return () => sheetFooter(null);
    }, [sheetFooter, channel, testID]);
    const sheetReceipt = React.useMemo(() => sheetFooter ? { ...props.receipt, primary: undefined, secondary: undefined } : null,
      [sheetFooter, props.receipt]);
    const receiptSheet = React.useRef<string | null>(null);
    React.useEffect(() => () => {
      if (receiptSheet.current) Modal.hide(receiptSheet.current);
    }, []);
    // While something blocks the page, its one line and action are the form column: choices that could not be
    // used are not drawn (R8-9). The receipt keeps its disabled Create and says the same reason.
    const form = props.blocker ? (
      <ItemGroup surface="none">
        <SurfaceStateCard
          testID={`${props.testID}.blocker`}
          kind="unavailable"
          size="line"
          title={props.blocker.title}
          reason={props.blocker.reason}
          action={{ ...props.blocker.action, testID: `${props.testID}.blocker.action` }}
        />
      </ItemGroup>
    ) : props.children;
    if (sheetReceipt) {
      return (
        <ItemList testID={props.testID}>
          <PageHeader title={props.title} description={props.description} leading={props.mark} actions={props.actions} />
          {form}
          <ItemGroup surface="none">
            <MachineConfigurationReceipt model={sheetReceipt} testID={`${props.testID}.receipt`} />
          </ItemGroup>
        </ItemList>
      );
    }
    if (props.receiptIsBody) {
      return (
        <ItemList testID={props.testID}>
          <PageHeader title={props.title} description={props.description} leading={props.mark} actions={props.actions} />
          {form}
          <ItemGroup surface="none">
            <MachineConfigurationReceipt model={props.receipt} testID={`${props.testID}.receipt`} />
          </ItemGroup>
        </ItemList>
      );
    }
    if (!props.compact) {
    return (
      <ManagedReceiptPageLayout
        header={{ title: props.title, description: props.description, leading: props.mark, actions: props.actions }}
        receipt={props.receipt}
        compact={false}
        testID={props.testID}
      >
        {form}
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
          {/* The header folds its actions into the navigation overflow on a phone; the scope stays in view as its own row. */}
          {props.actions ? <ManagedScopeRow testID={`${props.testID}.scope`} chip={props.actions} /> : null}
          {form}
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
  const { theme } = useUnistyles();
  // The page's pinned bar owns the floating tab bar's clearance and the safe area; its summary says it opens the receipt.
  return (
    <PagePinnedBar testID={`${props.testID}.frame`}>
      <View style={styles.bar}>
        <HappierPressable
          testID={props.testID}
          accessibilityRole="button"
          accessibilityLabel={[`${props.summary.value} ${props.summary.unit}`.trim(), props.summary.spec].filter(Boolean).join(', ')}
          accessibilityHint={t('managedMachines.receipt.openSummary')}
          hasPopup="dialog"
          onPress={props.onOpen}
          style={styles.barSummary}
        >
          {/* Until a price is known the choices lead, with the caret that says the bar opens the receipt. */}
          <View style={styles.barValueRow}>
            {props.summary.value ? (
              <>
                <Text style={styles.barValue}>{props.summary.value}</Text>
                <Text style={styles.barUnit}>{props.summary.unit}</Text>
              </>
            ) : (
              <Text style={styles.barSpecLead} numberOfLines={2}>
                {props.summary.spec}
              </Text>
            )}
            <Icon name="caret-up" size={12} color={theme.colors.text.secondary} />
          </View>
          {/* Size, place and Keep it all stay readable beside Create: two lines before it ellipsizes. */}
          {props.summary.value ? (
            <Text style={styles.barSpec} numberOfLines={2}>
              {props.summary.spec}
            </Text>
          ) : null}
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
    </PagePinnedBar>
  );
}

/** The sheet form's footer: the receipt's way out and its one primary, with why the primary is off as the note. */
function ReceiptSheetFooter(props: Readonly<{ channel: LiveValueChannel<ManagedReceiptModel>; testID: string }>) {
  const model = useLiveValue(props.channel);
  const primary = model.primary;
  return (
    <ModalCardFooterActions note={primary?.footnote ?? null} noteTestID={`${props.testID}.footer-note`}>
      {(model.secondary ?? []).map(action => (
        <RoundButton key={action.testID ?? action.label} testID={action.testID} size="normal" display="secondary"
          title={action.label} disabled={action.disabled} loading={action.loading} onPress={action.onPress} />
      ))}
      {primary ? (
        <RoundButton testID={primary.testID} size="normal" title={primary.label} disabled={primary.disabled}
          loading={primary.loading} onPress={primary.onPress} />
      ) : null}
    </ModalCardFooterActions>
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
  // The sheet is the card: the receipt lies flat on it, keeping its section dividers.
  return <MachineConfigurationReceipt model={model} surface="flat" testID={props.testID} />;
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
    gap: theme.space.s12,
  },
  barSummary: {
    flex: 1,
    minWidth: 0,
  },
  barValueRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: theme.space.s4,
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
  barSpecLead: {
    ...Typography.default('semiBold'),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.primary,
    flexShrink: 1,
  },
  barSpec: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.secondary,
  },
}));
