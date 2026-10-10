import * as React from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable, happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { PageHeader } from '@/components/ui/layout/PageHeader';
import { GlassSurface } from '@/components/ui/glass/GlassSurface';
import { Icon } from '@/components/ui/icons/Icon';
import { FLOATING_OVERLAY_METRICS } from '@/components/ui/overlays/floatingOverlayMetrics';
import { resolveThemeSurfaceBorderStyle } from '@/components/ui/surfaces/resolveThemeHairlineBorderStyle';
import { SurfaceRim } from '@/components/ui/surfaces/SurfaceRim';
import { surfaceUsesRim } from '@/components/ui/surfaces/surfaceEdgeTreatment';
import { resolveThemeRaisedEdge } from '@/components/ui/surfaces/themeRaisedEdge';
import { shadowLevelStyle } from '@/shadowElevation';
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
      /** The page's one-sentence purpose; a phone shows the title only (lab m-config Ap). */
      description?: string;
      mark: React.ReactNode;
      /** The page scope ("Managed from" chip), in the header's actions slot. */
      actions?: React.ReactNode;
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
        header={{ title: props.title, description: props.description, leading: props.mark, actions: props.actions }}
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
            actions={props.actions}
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
  const { theme } = useUnistyles();
  // A floating, inset bar (lab m-config Ap): it stands on the floating material and rim, like every
  // surface that floats over the page, and its summary says it opens the receipt.
  return (
    <View style={[styles.barFrame, { marginBottom: Math.max(insets.bottom, 12) }]}>
      <GlassSurface surfaceGroup="floating" style={styles.bar}>
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
            <Icon name="caret-up" size={12} color={theme.colors.text.secondary} />
          </View>
          {/* Size, place and Keep it all stay readable beside Create: two lines before it ellipsizes. */}
          <Text style={styles.barSpec} numberOfLines={2}>
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
        <SurfaceRim role="floating" radius={FLOATING_OVERLAY_METRICS.radiusPx} border="modal" />
      </GlassSurface>
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
  barFrame: {
    marginHorizontal: 12,
    borderRadius: FLOATING_OVERLAY_METRICS.radiusPx,
    ...shadowLevelStyle(theme.colors.shadowLevels[2]),
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: FLOATING_OVERLAY_METRICS.radiusPx,
    overflow: 'hidden',
    ...resolveThemeSurfaceBorderStyle({
      borderColor: theme.colors.border.modal,
      edge: resolveThemeRaisedEdge(theme, 'modal'),
      rim: surfaceUsesRim('floating', theme.dark),
    }),
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
