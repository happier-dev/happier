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
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useFloatingChromeClearance } from '@/components/ui/layout/useFloatingChromeClearance';
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
      testID: string;
    }>,
  ) {
    const channel = useLiveValueChannel(props.receipt);
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
  const insets = useSafeAreaInsets();
  const { theme } = useUnistyles();
  // The phone's floating tab bar covers the page's bottom by its measured height: the bar stands above it,
  // as a pinned page bar does, and above the system safe area where no such chrome overlays the page.
  const chromeClearance = useFloatingChromeClearance();
  const bottomClearance = chromeClearance > 0 ? theme.space.s12 + chromeClearance : Math.max(insets.bottom, 12);
  // A floating, inset bar (lab m-config Ap): it stands on the floating material and rim, like every
  // surface that floats over the page, and its summary says it opens the receipt.
  return (
    <View testID={`${props.testID}.frame`} style={[styles.barFrame, { marginBottom: bottomClearance }]}>
      <GlassSurface surfaceGroup="floating" style={styles.bar}>
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
  barFrame: {
    marginHorizontal: theme.space.s12,
    borderRadius: FLOATING_OVERLAY_METRICS.radiusPx,
    ...shadowLevelStyle(theme.colors.shadowLevels[2]),
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s12,
    paddingHorizontal: theme.space.s16,
    paddingVertical: theme.space.s10,
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
