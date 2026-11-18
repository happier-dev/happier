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
import { formatDeclaredPlanPrice, formatDeclaredPlanSource } from '@/components/ui/presentation/providerCostPresentation';
import { useQualifiedConnectedAccountQuota } from '@/hooks/server/connectedServices/useQualifiedConnectedAccountQuota';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualifiedConnectedAccountPersistence';

import type { DeploymentPlatformTarget } from './platformTargetLink';

type Plans = NonNullable<DeploymentPlatformTarget['plans']>;

const sourceLine = (source: Plans[number]['source']) => formatDeclaredPlanSource(source);

const words = (value: string) => value.trim().toLowerCase().split(/[\s_-]+/).filter(Boolean).join(' ');

/**
 * The declared plan the connected account is on: the provider's plan name matched to a declared plan's id or title,
 * ignoring case and separators ("Workers Paid" is the plan id `workers-paid`). A plugin names an account-wide plan by
 * its own plan id, so a Workers plan never reads as the Pages plan. An unmapped or absent name matches nothing, and
 * the facts stand alone (deploy auto-mode U4).
 */
export function matchAccountPlan(plans: Plans, planLabel: string | null | undefined): Plans[number] | null {
  const name = planLabel ? words(planLabel) : '';
  if (!name) return null;
  return plans.find((plan) => words(plan.id) === name || words(plan.title) === name) ?? null;
}

/** A fact's value: a priced fact through the shared cost presenter, any other as the plugin wrote it. */
const factValue = (fact: Plans[number]['facts'][number]) => 'price' in fact ? formatDeclaredPlanPrice(fact.price) : fact.value;

/**
 * A platform's declared plans in its Where card (journey-deploy where): each plan's title, its price through the shared
 * cost presenter, its facts as the plugin wrote them, and where and when they were read; What's included opens them
 * side by side (wherePeek). These are dated declared facts (Protocol DeploymentTargetPlanV1), never a live quote.
 */
type DeploymentTargetPlansProps = Readonly<{
  plans: Plans;
  /** The platform's name, for the comparison's title. */
  platform: string;
  columns: boolean;
  phone: boolean;
  /** The card's test id; the link and the comparison take `:included` and `:compare`. */
  testID: string;
  /** The plan the connected account reports, by the provider's name for it ("Pro"); shown only when it is declared. */
  accountPlanLabel?: string | null;
}>;

/**
 * The plans with the plan the connected account is on (deploy auto-mode U4, F8): one read through the account's
 * existing quota owner while shown, never polled; no account, no read.
 */
export function DeploymentTargetPlansForAccount(props: Omit<DeploymentTargetPlansProps, 'accountPlanLabel'>
  & Readonly<{ account: QualifiedConnectedAccountRef }>) {
  const { account, ...plans } = props;
  const quota = useQualifiedConnectedAccountQuota(account, { fetchPolicy: 'once' });
  return <DeploymentTargetPlans {...plans} accountPlanLabel={quota.snapshot?.planLabel ?? null} />;
}

export function DeploymentTargetPlans(props: DeploymentTargetPlansProps) {
  const { theme } = useUnistyles();
  const [comparing, setComparing] = React.useState(false);
  const anchorRef = React.useRef<View>(null);
  const title = t('newApp.deploy.plan.includedTitle', { platform: props.platform });
  const yourPlan = matchAccountPlan(props.plans, props.accountPlanLabel);
  return (
    <View style={styles.body}>
      {yourPlan ? (
        <Text testID={`${props.testID}:yourPlan`} variant="meta" emphasis="medium">
          {`${t('newApp.deploy.plan.yourPlan')} · ${yourPlan.title}`}
        </Text>
      ) : null}
      <View style={[styles.plans, props.columns ? styles.plansColumns : null]}>
        {props.plans.map((plan) => (
          <View key={plan.id} style={[styles.plan, props.columns ? styles.planColumn : null]}>
            <Text variant="meta" emphasis="medium">{plan.title}</Text>
            {plan.price ? (
              <FieldLayout label={t('newApp.deploy.plan.price')} columns>
                <FieldValue value={formatDeclaredPlanPrice(plan.price)} />
              </FieldLayout>
            ) : null}
            {plan.facts.map((fact, index) => (
              <FieldLayout key={`${index}:${fact.label}`} label={fact.label} columns>
                <FieldValue value={factValue(fact)} />
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
        {props.plans.some((plan) => plan.price) ? row(':price', t('newApp.deploy.plan.price'),
          props.plans.map((plan) => plan.price ? formatDeclaredPlanPrice(plan.price) : '—')) : null}
        {labels.map((label) => row(label, label,
          props.plans.map((plan) => {
            const fact = plan.facts.find((candidate) => candidate.label === label);
            return fact ? factValue(fact) : '—';
          })))}
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
