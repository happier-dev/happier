import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { FieldLayout, FieldValue } from '@/components/ui/lists/FieldRow';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS, Popover } from '@/components/ui/popover';
import { resolveThemeHairlineBorderStyle } from '@/components/ui/surfaces/resolveThemeHairlineBorderStyle';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { formatCalendarDate } from '@/utils/datetime/cachedIntlFormatters';

import type { DeploymentPlatformTarget } from './platformTargetLink';

type Plans = NonNullable<DeploymentPlatformTarget['plans']>;

/** "vercel.com" from a plan's public source, so the line names where the facts were read. */
function sourceHost(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** A plan's `checkedAt` (an ISO calendar date) as the reader's calendar day, never shifted by a time zone. */
function checkedDay(checkedAt: string): string {
  const [year, month, day] = checkedAt.split('-').map(Number);
  return formatCalendarDate(new Date(year!, month! - 1, day!));
}

function sourceLine(source: Plans[number]['source']): string {
  return t('managedMachines.price.checked', { provider: sourceHost(source.url), time: checkedDay(source.checkedAt) });
}

/**
 * A platform's declared plans in its Where card (journey-deploy where): each plan's title, its facts as the plugin
 * wrote them, and where and when they were read; What's included opens them side by side (wherePeek). These are dated
 * display facts (Protocol DeploymentTargetPlanV1), printed as declared: nothing here computes a price.
 */
export function DeploymentTargetPlans(props: Readonly<{
  plans: Plans;
  /** The platform's name, for the comparison's title. */
  platform: string;
  columns: boolean;
  phone: boolean;
  /** The card's test id; the link and the comparison take `:included` and `:compare`. */
  testID: string;
}>) {
  const { theme } = useUnistyles();
  const [comparing, setComparing] = React.useState(false);
  const anchorRef = React.useRef<View>(null);
  const title = t('newApp.deploy.plan.includedTitle', { platform: props.platform });
  return (
    <View style={styles.body}>
      <View style={[styles.plans, props.columns ? styles.plansColumns : null]}>
        {props.plans.map((plan) => (
          <View key={plan.id} style={[styles.plan, props.columns ? styles.planColumn : null]}>
            <Text variant="meta" emphasis="medium">{plan.title}</Text>
            {plan.facts.map((fact, index) => (
              <FieldLayout key={`${index}:${fact.label}`} label={fact.label} columns>
                <FieldValue value={fact.value} />
              </FieldLayout>
            ))}
            <Text variant="meta" style={{ color: theme.colors.text.secondary }}>{sourceLine(plan.source)}</Text>
          </View>
        ))}
      </View>
      <View ref={anchorRef} collapsable={false} style={styles.peek}>
        <TextLinkButton testID={`${props.testID}:included`} size="meta" label={t('newApp.deploy.plan.whatsIncluded')}
          onPress={() => setComparing(true)} />
      </View>
      {comparing ? (
        // On demand (wherePeek): anchored to its link on a wide window, the shared bottom sheet on a phone.
        <Popover open anchorRef={anchorRef} boundaryRef={null} placement="auto-vertical" phonePresentation="sheet"
          accessibilityLabel={title} portal={MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS}
          onRequestClose={() => setComparing(false)}>
          {({ maxHeight, maxWidth }) => (
            <FloatingOverlay maxHeight={maxHeight} surfaceChrome="theme" containerStyle={{ width: maxWidth }}>
              <DeploymentTargetPlanComparison plans={props.plans} title={props.phone ? null : title}
                testID={`${props.testID}:compare`} />
            </FloatingOverlay>
          )}
        </Popover>
      ) : null}
    </View>
  );
}

/**
 * The plans side by side: one row per declared fact label (in the order the plans declare them), one column per plan,
 * an empty cell where a plan declares no such fact, then what each plan includes and where the facts were read.
 */
function DeploymentTargetPlanComparison(props: Readonly<{ plans: Plans; title: string | null; testID: string }>) {
  const { theme } = useUnistyles();
  const labels = React.useMemo(() => [...new Set(props.plans.flatMap((plan) => plan.facts.map((fact) => fact.label)))],
    [props.plans]);
  const included = props.plans.some((plan) => plan.included?.length);
  const sources = [...new Set(props.plans.map((plan) => sourceLine(plan.source)))];
  const secondary = { color: theme.colors.text.secondary };
  const hairline = resolveThemeHairlineBorderStyle(theme.colors.border.subtle).borderWidth;
  const row = (key: string, label: string | null, cells: readonly string[]) => (
    <View key={key} style={[styles.row, { borderTopColor: theme.colors.border.subtle, borderTopWidth: hairline }]}>
      <Text variant="meta" style={[styles.cell, secondary]}>{label ?? ''}</Text>
      {cells.map((value, index) => <Text key={index} variant="meta" style={styles.cell}>{value}</Text>)}
    </View>
  );
  return (
    <View testID={props.testID} style={styles.comparison}>
      {props.title ? <Text variant="body" emphasis="medium">{props.title}</Text> : null}
      <View>
        <View style={styles.headerRow}>
          <View style={styles.cell} />
          {props.plans.map((plan) => <Text key={plan.id} variant="meta" emphasis="medium" style={styles.cell}>{plan.title}</Text>)}
        </View>
        {labels.map((label) => row(label, label,
          props.plans.map((plan) => plan.facts.find((fact) => fact.label === label)?.value ?? '—')))}
        {included ? row(':included', t('newApp.deploy.plan.includedLabel'),
          props.plans.map((plan) => plan.included?.join('\n') || '—')) : null}
      </View>
      {sources.map((line) => <Text key={line} variant="meta" style={secondary}>{line}</Text>)}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.space.s8 },
  plans: { gap: theme.space.s12 },
  plansColumns: { flexDirection: 'row', flexWrap: 'wrap', columnGap: theme.space.s16 },
  plan: { gap: theme.space.s4 },
  planColumn: { flexGrow: 1, flexBasis: 0 },
  peek: { alignSelf: 'flex-start' },
  comparison: { gap: theme.space.s12, padding: theme.space.s16 },
  headerRow: { flexDirection: 'row', gap: theme.space.s12, paddingBottom: theme.space.s8 },
  row: { flexDirection: 'row', gap: theme.space.s12, paddingVertical: theme.space.s8 },
  cell: { flex: 1 },
}));
