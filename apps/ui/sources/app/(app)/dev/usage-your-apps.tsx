import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Text } from '@/components/ui/text/Text';
import {
  UsageFilterBar,
  usageTokensCostMetricOptions,
} from '@/components/settings/usage/UsageFilterBar';
import {
  USAGE_SCOPE_FILTER_ALL,
  createUsageAppFilters,
  withShowChoice,
  type UsageWidgetPageFilter,
} from '@/components/settings/usage/useUsageWidgetPageFilters';
import type { UsageAppEnvironment } from '@/sync/api/account/usageAppCallsAccounting';
import { t } from '@/text';

/**
 * Development specimen (`/dev/usage-your-apps`, lab p7Cost-usage / p7Cost-sources): the real Usage filter bar and its
 * real filter owner with fixture app Environments, in both states of the exclusive Agents / Your apps choice.
 * Fixture data only; selections are not written anywhere.
 */
const ENVIRONMENTS: readonly UsageAppEnvironment[] = [
  {
    environmentId: 'env-prod',
    serverId: 'specimen',
    name: 'Production',
    projectSourceId: 'billing',
    projectName: 'billing-api',
    collectorMachineId: 'collector',
  },
  {
    environmentId: 'env-staging',
    serverId: 'specimen',
    name: 'Staging',
    projectSourceId: 'billing',
    projectName: 'billing-api',
    collectorMachineId: 'collector',
  },
  {
    environmentId: 'env-preview',
    serverId: 'specimen',
    name: 'Preview #212',
    projectSourceId: 'billing',
    projectName: 'billing-api',
    collectorMachineId: 'collector',
  },
];
const accept = () => true;

function agentFilters(): readonly UsageWidgetPageFilter[] {
  const all = (what: string) => ({
    id: USAGE_SCOPE_FILTER_ALL,
    label: t('usage.board.page.filterAllOf', {
      what: what.toLocaleLowerCase(),
    }),
  });
  const filter = (
    field: UsageWidgetPageFilter['field'],
    key: Parameters<typeof t>[0],
    options: UsageWidgetPageFilter['options'],
  ) =>
    ({
      field,
      title: t(key),
      selected: [],
      options: [all(t(key)), ...options],
      select: accept,
    }) satisfies UsageWidgetPageFilter;
  return [
    withShowChoice(
      filter('sources', 'usage.board.page.filterSources', [
        { id: 'claude', label: 'Claude', agentId: 'claude' },
        { id: 'codex', label: 'Codex', agentId: 'codex' },
      ]),
      ENVIRONMENTS,
      accept,
    ),
    filter('agents', 'usage.board.page.filterAgents', [
      { id: 'claude', label: 'Claude' },
      { id: 'codex', label: 'Codex' },
    ]),
    filter('machines', 'usage.board.page.filterMachines', [
      { id: 'studio', label: 'Studio Mac' },
    ]),
    filter('projects', 'usage.board.page.filterProjects', [
      { id: 'happier', label: 'happier' },
    ]),
  ];
}

function Bar(
  props: Readonly<{
    filters: readonly UsageWidgetPageFilter[];
    testID: string;
  }>,
) {
  const metricOptions = React.useMemo(() => usageTokensCostMetricOptions(), []);
  return (
    <UsageFilterBar
      period="30days"
      costBasis="api_equivalent"
      coverageIncomplete={false}
      scopeFilters={props.filters}
      costBasisOptions={['auto', 'reported', 'estimated', 'api_equivalent']}
      costBasisPending={false}
      onPeriodChange={async () => true}
      onCostBasisChange={async () => true}
      metricOptions={metricOptions}
      metric="cost"
      onMetricChange={() => {}}
      testID={props.testID}
    />
  );
}

export default function UsageYourAppsSpecimen() {
  const agents = React.useMemo(agentFilters, []);
  const apps = React.useMemo(
    () =>
      createUsageAppFilters(
        ENVIRONMENTS,
        ENVIRONMENTS.map((row) => row.environmentId),
        accept,
      ),
    [],
  );
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Text style={styles.note}>
        Development specimen · fixture Environments · not product data
      </Text>
      <View style={styles.state}>
        <Text style={styles.title}>Agents (default)</Text>
        <Bar filters={agents} testID="specimen.agents" />
      </View>
      <View style={styles.state}>
        <Text style={styles.title}>Your apps · billing-api</Text>
        <Bar filters={apps} testID="specimen.apps" />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  page: {
    padding: theme.space.s24,
    gap: theme.space.s32,
    maxWidth: 1180,
    width: '100%',
    alignSelf: 'center',
  },
  note: { color: theme.colors.text.secondary },
  state: { gap: theme.space.s12 },
  title: { color: theme.colors.text.primary },
}));
