import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { FieldLayout, FieldValue } from '@/components/ui/lists/FieldRow';
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

/**
 * A platform's declared plans in its Where card (journey-deploy where): each plan's title, its facts as the plugin
 * wrote them, and where and when they were read. These are dated display facts (Protocol DeploymentTargetPlanV1),
 * printed as declared: nothing here computes a price.
 */
export function DeploymentTargetPlans(props: Readonly<{ plans: Plans; columns: boolean; testID?: string }>) {
  const { theme } = useUnistyles();
  return (
    <View testID={props.testID} style={[styles.plans, props.columns ? styles.plansColumns : null]}>
      {props.plans.map((plan) => (
        <View key={plan.id} style={[styles.plan, props.columns ? styles.planColumn : null]}>
          <Text variant="meta" emphasis="medium">{plan.title}</Text>
          {plan.facts.map((fact, index) => (
            <FieldLayout key={`${index}:${fact.label}`} label={fact.label} columns>
              <FieldValue value={fact.value} />
            </FieldLayout>
          ))}
          <Text variant="meta" style={{ color: theme.colors.text.secondary }}>
            {t('managedMachines.price.checked', { provider: sourceHost(plan.source.url), time: checkedDay(plan.source.checkedAt) })}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  plans: { gap: theme.space.s12 },
  plansColumns: { flexDirection: 'row', flexWrap: 'wrap', columnGap: theme.space.s16 },
  plan: { gap: theme.space.s4 },
  planColumn: { flexGrow: 1, flexBasis: 0 },
}));
