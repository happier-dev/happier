import * as React from 'react';
import type { DatabaseStatsObservationV1, DatabaseStatsReadV1 } from '@happier-dev/plugin-sdk/database';
import { Metric, Row, usePluginTranslation } from '@happier-dev/plugin-ui';
import { usePluginSurfaceActivity } from '@happier-dev/plugin-ui/hostApi';
import { useDatabaseActivity, useDatabaseInsights } from '../hooks.js';
import { ACTIVITY_READ, ConnectionsMetric } from './insights/ActivityView.js';
import { isStatsSetupReason } from './insights/InsightsSetup.js';
import { STATEMENTS_BY_TOTAL_TIME } from './insights/statements.js';
import { bytesLabel } from './sizes.js';

const SIZE_READ: Extract<DatabaseStatsReadV1, { group: 'size' }> = {
  kind: 'stats.read',
  group: 'size',
  selection: {},
};

type Activity = Extract<
  DatabaseStatsObservationV1,
  { status: 'available'; group: 'activity' }
>;

/**
 * The database at a glance (lab directory header): its size, its connections and whether statement statistics are
 * on. Each fact is the Insights owner's own read (the same resources Insights opens), so nothing is read twice;
 * Connections refreshes while the Overview is on screen, as Activity does. A fact the database does not share says
 * so in its tile rather than disappearing, so the row never reflows as reads land.
 */
export function OverviewFacts(props: Readonly<{ targetKey: string }>) {
  const translate = usePluginTranslation();
  const size = useDatabaseInsights(props.targetKey, SIZE_READ).observation as
    | DatabaseStatsObservationV1
    | undefined;
  const statements = useDatabaseInsights(
    props.targetKey,
    STATEMENTS_BY_TOTAL_TIME,
  ).observation as DatabaseStatsObservationV1 | undefined;
  const activity = useDatabaseActivity(props.targetKey, ACTIVITY_READ, usePluginSurfaceActivity().active);
  const sessions =
    (activity.observation as DatabaseStatsObservationV1 | undefined)?.status ===
    'available'
      ? (activity.observation as Activity).data
      : null;
  const bytes =
    size?.status === 'available' && size.group === 'size'
      ? bytesLabel(size.data.bytes)
      : null;
  const unknown = '—';
  const statementsOn = statements?.status === 'available';
  const statementsCaption =
    statements?.status === 'unavailable'
      ? isStatsSetupReason(statements.reason)
        ? translate(
            'plugins.database.overview.statementsSetup',
            'Needs pg_stat_statements',
          )
        : translate(
            'plugins.database.overview.statementsUnavailable',
            'Not shared by this database',
          )
      : undefined;
  return (
    <Row gap="large" wrap>
      <Metric
        size="stat"
        showLabel
        label={translate('plugins.database.overview.size', 'Size')}
        value={bytes ?? unknown}
      />
      {sessions ? (
        <ConnectionsMetric sessions={sessions} />
      ) : (
        <Metric
          size="stat"
        showLabel
          label={translate(
            'plugins.database.activity.connections',
            'Connections',
          )}
          value={unknown}
        />
      )}
      <Metric
        size="stat"
        showLabel
        label={translate(
          'plugins.database.overview.statements',
          'Statement statistics',
        )}
        value={
          statements === undefined
            ? unknown
            : statementsOn
              ? translate('plugins.database.overview.on', 'On')
              : translate('plugins.database.overview.off', 'Off')
        }
        {...(statementsCaption ? { caption: statementsCaption } : {})}
      />
    </Row>
  );
}
