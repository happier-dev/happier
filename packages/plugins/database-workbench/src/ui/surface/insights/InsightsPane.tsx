import * as React from 'react';
import type { DatabaseDescriptorV1, DatabaseStatsObservationV1 } from '@happier-dev/plugin-sdk/database';
import {
  ErrorState,
  FreshnessLine,
  Icon,
  IconButton,
  PageHeader,
  Stack,
  Tabs,
  usePluginTranslation,
  type PageHeaderMetaFact,
  type PluginTranslate,
} from '@happier-dev/plugin-ui';
import {
  useDatabaseInsights,
  useStatementsLastLook,
  useWorkbenchInstance,
  useWorkbenchLocation,
} from '../../hooks.js';
import { ActivityView } from './ActivityView.js';
import { formatMoment } from './format.js';
import { InsightsSetup } from './InsightsSetup.js';
import {
  projectStatements,
  STATEMENTS_BY_TOTAL_TIME,
  type StatementsObservation,
} from './statements.js';
import { StatementsView } from './StatementsView.js';
import { TablesView } from './TablesView.js';

type InsightsTab = 'statements' | 'tables' | 'activity';
const NO_KEYS: readonly string[] = Object.freeze([]);

/** Statements read once per open; the comparison is the host's device-local last look (R13). */
export function useInsightsStatements(targetKey: string) {
  const stats = useDatabaseInsights(targetKey, STATEMENTS_BY_TOTAL_TIME);
  const observation = stats.observation as
    | DatabaseStatsObservationV1
    | undefined;
  const available: StatementsObservation | null =
    observation?.status === 'available' && observation.group === 'statements'
      ? observation
      : null;
  const unavailable =
    observation?.status === 'unavailable' ? observation : null;
  const keys = React.useMemo(
    () => available?.data.map((row) => row.key) ?? NO_KEYS,
    [available],
  );
  const look = useStatementsLastLook(
    targetKey,
    available ?? unavailable ?? undefined,
    keys,
  );
  const views = React.useMemo(
    () => (available ? projectStatements(available, look?.comparison) : []),
    [available, look],
  );
  return {
    stats,
    available,
    unavailable,
    comparison: look?.comparison ?? null,
    views,
  };
}

/** "as of 14:05", then what the numbers compare with, said once (R13). */
export function statementsFacts(
  translate: PluginTranslate,
  statements: ReturnType<typeof useInsightsStatements>,
): PageHeaderMetaFact[] {
  const facts: PageHeaderMetaFact[] = [];
  if (statements.available) {
    facts.push({
      key: 'asOf',
      text: translate('plugins.database.insights.asOf', 'as of {time}', {
        time: formatMoment(statements.available.observedAtMs),
      }),
    });
    const comparison = statements.comparison;
    if (comparison?.status === 'available') {
      facts.push({
        key: 'compared',
        text: translate(
          'plugins.database.insights.comparedWith',
          'compared with your last look, {time}',
          {
            time: formatMoment(comparison.fromMs),
          },
        ),
      });
    } else if (comparison?.status === 'unavailable' && comparison.reason === 'previous_sample_required') {
      facts.push({
        key: 'compared',
        text: translate(
          'plugins.database.insights.firstLook',
          'your first look; changes show next time',
        ),
      });
    } else if (
      comparison?.status === 'unavailable' &&
      (comparison.reason === 'counter_reset' || comparison.reason === 'comparison_unavailable')
    ) {
      facts.push({
        key: 'compared',
        text: translate(
          'plugins.database.insights.resetSince',
          'statistics restarted since your last look',
        ),
      });
    }
  }
  return facts;
}

/**
 * Insights (F6): where the database spends its time, its tables and indexes, and what runs now. One home for query
 * performance (decision A). The workbench page and the rail's details tab mount this same pane.
 */
export function InsightsPane(props: Readonly<{ targetKey: string }>) {
  const translate = usePluginTranslation();
  const instance = useWorkbenchInstance();
  const location = useWorkbenchLocation();
  const descriptor = instance.target(props.targetKey);
  const [tab, setTab] = React.useState<InsightsTab>('statements');
  const statements = useInsightsStatements(props.targetKey);
  const openConsole = React.useCallback(
    async (sql: string) => {
      await instance.console(props.targetKey).setText(sql);
      await location.navigate({ mode: 'console' });
    },
    [instance, location, props.targetKey],
  );
  const facts: PageHeaderMetaFact[] = [
    { key: 'database', text: descriptor.label },
    ...(tab === 'statements' ? statementsFacts(translate, statements) : []),
    ...(tab === 'activity'
      ? [
          {
            key: 'live',
            text: translate(
              'plugins.database.activity.live',
              'refreshing while this is open',
            ),
          },
        ]
      : []),
  ];
  return (
    <Stack gap="large" grow>
      <PageHeader
        title={translate('plugins.database.insights.title', 'Insights')}
        meta={facts}
        actions={
          tab === 'activity' ? null : (
            <IconButton
              accessibilityLabel={translate(
                'plugins.database.refresh',
                'Refresh',
              )}
              icon={<Icon name="refresh" />}
              onPress={() => instance.refresh(props.targetKey)}
            />
          )
        }
      />
      <Tabs
        value={tab}
        onValueChange={(value) =>
          setTab(
            value === 'tables' || value === 'activity' ? value : 'statements',
          )
        }
        ariaLabel={translate('plugins.database.insights.title', 'Insights')}
        layout="fill"
      >
        <Tabs.Item
          value="statements"
          title={translate(
            'plugins.database.insights.statements',
            'Statements',
          )}
          {...(statements.available
            ? { badge: String(statements.available.data.length) }
            : {})}
        >
          <StatementsPanel
            descriptor={descriptor}
            statements={statements}
            onOpenConsole={openConsole}
          />
        </Tabs.Item>
        <Tabs.Item
          value="tables"
          title={translate(
            'plugins.database.insights.tablesAndIndexes',
            'Tables and indexes',
          )}
        >
          <TablesView
            targetKey={props.targetKey}
            onOpenTable={(relation) => void location.navigate({ mode: 'data', relation })}
          />
        </Tabs.Item>
        <Tabs.Item
          value="activity"
          title={translate('plugins.database.insights.activity', 'Activity')}
        >
          <ActivityView targetKey={props.targetKey} />
        </Tabs.Item>
      </Tabs>
    </Stack>
  );
}

function StatementsPanel(
  props: Readonly<{
    statements: ReturnType<typeof useInsightsStatements>;
    descriptor: DatabaseDescriptorV1;
    onOpenConsole: (sql: string) => void;
  }>,
) {
  const translate = usePluginTranslation();
  const { stats, available, unavailable, views } = props.statements;
  if (unavailable) return <InsightsSetup observation={unavailable} />;
  if (stats.status === 'unavailable') {
    return (
      <ErrorState
        kind="unavailable"
        title={translate(
          'plugins.database.insights.failed',
          'Statement statistics could not be read',
        )}
        details={stats.error instanceof Error ? stats.error.message : undefined}
        onRetry={stats.refresh}
        retryLabel={translate('plugins.database.retry', 'Try again')}
      />
    );
  }
  return (
    <Stack gap="medium" grow>
      {stats.status === 'stale' && available ? (
        <FreshnessLine
          asOf={available.observedAtMs}
          tone="warning"
          reason={translate('plugins.database.insights.stale', 'The database isn’t answering; these are the last numbers Happier saw')}
          action={{ label: translate('plugins.database.retry', 'Try again'), onPress: stats.refresh }}
        />
      ) : null}
      <StatementsView
        views={views}
        target={props.descriptor.target}
        complete={available?.completeness.complete === true}
        loading={stats.status === 'loading'}
        onOpenConsole={props.onOpenConsole}
      />
    </Stack>
  );
}
