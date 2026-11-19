import * as React from 'react';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import type { DatabaseStatsObservationV1 } from '@happier-dev/plugin-sdk/database';
import {
  ErrorState,
  Icon,
  IconButton,
  Item,
  ItemGroup,
  LoadingState,
  Row,
  Stack,
  Text,
  usePluginTranslation,
} from '@happier-dev/plugin-ui';
import { useDatabaseInsights, useWorkbenchInstance } from '../../hooks.js';
import type { WorkbenchLaunchInput } from '../mount.js';
import { formatPercent } from './format.js';
import { InsightsSetup } from './InsightsSetup.js';
import { InsightsPane, statementsFacts, useInsightsStatements } from './InsightsPane.js';
import { StatementDetail } from './StatementDetail.js';
import {
  projectStatements,
  statementByKey,
  type StatementChange,
  type StatementView,
} from './statements.js';
import { statementTitle } from './StatementsView.js';

/** Rows shown in the narrow rail; the details tab and the page hold the rest. */
const RAIL_STATEMENTS = 8;
const STATEMENT_PLACE = 'statement';

export function encodeStatementPlace(key: string): string {
  return `${STATEMENT_PLACE}/${encodeURIComponent(key)}`;
}
export function decodeStatementPlace(
  subPath: string | undefined,
): string | null {
  const [kind, key] = (subPath ?? '').replace(/^\/+/, '').split('/');
  return kind === STATEMENT_PLACE && key ? decodeURIComponent(key) : null;
}

/**
 * The Insights rail tab (D23/D24): its own database choice, then the statements that cost the most, ranked by the
 * producer. A statement opens as a Session details tab. Setup is P4's one diagnosed state, the same as the page.
 */
export function InsightsRailList(
  props: Readonly<{
    context: RenderContext;
    launch: WorkbenchLaunchInput;
    targetKey: string;
    detailsView: string | null;
  }>,
) {
  const translate = usePluginTranslation();
  const instance = useWorkbenchInstance();
  const statements = useInsightsStatements(props.targetKey);
  const [opened, setOpened] = React.useState<string | null>(null);
  const open = React.useCallback(
    (view: StatementView) => {
      if (!props.detailsView) return;
      const place = encodeStatementPlace(view.row.key);
      setOpened(view.row.key);
      void props.context.hostApi.openSurface(
        props.detailsView,
        projectNativeJsonValueForTransport({
          scope: props.launch.scope,
          descriptor: instance.target(props.targetKey),
          ...(view.change ? { change: view.change } : {}),
        }),
        {
          subPath: place,
          instanceKey: `${instance.target(props.targetKey).label}/${place}`,
        },
      );
    },
    [
      instance,
      props.context,
      props.detailsView,
      props.launch.scope,
      props.targetKey,
    ],
  );
  const { stats, unavailable, views } = statements;
  if (unavailable)
    return <InsightsSetup observation={unavailable} size="pane" />;
  if (stats.status === 'loading' && views.length === 0)
    return <LoadingState layout="line" rows={6} rowShape="compact" />;
  if (stats.status === 'unavailable') {
    return (
      <ErrorState
        layout="line"
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
  const facts = statementsFacts(translate, statements).map((fact) => fact.text);
  return (
    <Stack gap="medium">
      <ItemGroup
        surface="none"
        title={translate(
          'plugins.database.insights.topStatements',
          'Top statements',
        )}
      >
        {views.slice(0, RAIL_STATEMENTS).map((view) => (
          <Item
            key={view.row.key}
            title={statementTitle(view, translate)}
            titleNumberOfLines={1}
            detail={formatPercent(view.share) ?? undefined}
            selected={opened === view.row.key}
            onPress={() => open(view)}
          />
        ))}
      </ItemGroup>
      {views.length === 0 ? (
        <Text
          tone="secondary"
          variant="meta"
          value={translate(
            'plugins.database.insights.noStatements',
            'No statements yet. They appear here as your apps run them.',
          )}
        />
      ) : null}
      <Row gap="small" align="center" justify="space-between">
        <Text tone="secondary" variant="meta" value={facts.join(' · ')} />
        <IconButton
          accessibilityLabel={translate('plugins.database.refresh', 'Refresh')}
          icon={<Icon name="refresh" />}
          onPress={() => instance.refresh(props.targetKey)}
        />
      </Row>
    </Stack>
  );
}

/** The change since the last look travels with the open; the details tab never moves the last look itself. */
function readChange(context: RenderContext): StatementChange | undefined {
  const input = context.launchInput ?? context.launch?.input;
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    return undefined;
  const change = (input as Readonly<Record<string, unknown>>).change;
  if (typeof change !== 'object' || change === null) return undefined;
  const fields = change as Readonly<Record<string, unknown>>;
  return typeof fields.key === 'string' &&
    typeof fields.calls === 'string' &&
    typeof fields.totalTimeMs === 'number' &&
    typeof fields.rows === 'string' &&
    (fields.meanTimeMs === null || typeof fields.meanTimeMs === 'number')
    ? {
        key: fields.key,
        calls: fields.calls,
        totalTimeMs: fields.totalTimeMs,
        rows: fields.rows,
        meanTimeMs: fields.meanTimeMs,
      }
    : undefined;
}

/** The details tab the rail opened: the statement, reread by its key through the same producer. */
export function InsightsDetailsTab(props: Readonly<{ context: RenderContext; targetKey: string }>) {
  const statementKey = decodeStatementPlace(props.context.subPath);
  if (!statementKey) return <InsightsPane targetKey={props.targetKey} />;
  return <StatementDetailsTab context={props.context} targetKey={props.targetKey} statementKey={statementKey} />;
}

function StatementDetailsTab(props: Readonly<{ context: RenderContext; targetKey: string; statementKey: string }>) {
  const translate = usePluginTranslation();
  const statementKey = props.statementKey;
  const stats = useDatabaseInsights(
    props.targetKey,
    statementByKey(statementKey),
  );
  const change = readChange(props.context);
  const observation = stats.observation as
    | DatabaseStatsObservationV1
    | undefined;
  const view = React.useMemo(() => {
    if (
      observation?.status !== 'available' ||
      observation.group !== 'statements'
    )
      return null;
    const comparison = change
      ? {
          status: 'available' as const,
          fromMs: 0,
          toMs: observation.observedAtMs,
          rows: [change],
          missingKeys: [],
        }
      : null;
    return (
      projectStatements(observation, comparison).find(
        (item) => item.row.key === statementKey,
      ) ?? null
    );
  }, [observation, change?.key, statementKey]); // eslint-disable-line react-hooks/exhaustive-deps
  if (observation?.status === 'unavailable')
    return <InsightsSetup observation={observation} size="details" />;
  if (stats.status === 'loading')
    return <LoadingState layout="line" rows={4} />;
  if (!view) {
    return (
      <ErrorState
        kind="unavailable"
        title={translate(
          'plugins.database.insights.statementGone',
          'This statement is no longer in the statistics',
        )}
        description={translate(
          'plugins.database.insights.statementGoneLine',
          'Statistics restart with postgres and drop rarely used statements. It returns when your apps run it again.',
        )}
        onRetry={stats.refresh}
        retryLabel={translate('plugins.database.retry', 'Try again')}
      />
    );
  }
  return <StatementDetail view={view} />;
}
