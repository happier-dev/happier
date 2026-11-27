import { useEffect, useRef } from 'react';
import {
  DATABASE_STATS_READ_ACTION_ID_V1,
  databaseActionLocalIdV1,
} from '@happier-dev/database-protocol';
import {
  DatabaseOperationResultV1Schema,
  type DatabaseStatsReasonV1,
  type DatabaseTargetV1,
} from '@happier-dev/plugin-sdk/database';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import { Action, Button, ErrorState, Metric, Row, Stack, Text, usePluginTranslation } from '@happier-dev/plugin-ui';
import { useExecutePluginAction } from '@happier-dev/plugin-ui/hostApi';

const action = databaseActionLocalIdV1(DATABASE_STATS_READ_ACTION_ID_V1);
const cost = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

function unavailableMessage(reason: DatabaseStatsReasonV1, t: ReturnType<typeof usePluginTranslation>) {
  switch (reason) {
    case 'hypopg_missing':
      return t('plugins.database.insights.adviceMissing', 'Index suggestions need the hypopg extension');
    case 'visibility_restricted':
      return t('plugins.database.insights.adviceHidden', 'The database login cannot read the evidence needed for this estimate.');
    case 'row_evicted':
      return t('plugins.database.insights.adviceExpired', 'This statement is no longer visible in the database statistics.');
    case 'index_advice_statement_unsupported':
      return t('plugins.database.insights.adviceShape', 'This statement’s query shape is outside the supported set.');
    case 'unsupported_transport':
    case 'unsupported_engine':
    case 'unsupported_group':
      return t('plugins.database.insights.adviceTransport', 'This check needs a direct connection to PostgreSQL 16 or later.');
    default:
      return t('plugins.database.insights.adviceUnavailable', 'Index suggestions are unavailable.');
  }
}

export function StatementIndexAdvice({ target, statementKey }: Readonly<{ target: DatabaseTargetV1; statementKey: string }>) {
  const t = usePluginTranslation();
  const { execute, execution } = useExecutePluginAction(action);
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => () => {
    lifetime.current?.abort();
    lifetime.current = null;
  }, []);
  const run = async () => {
    lifetime.current ??= new AbortController();
    await execute(projectNativeJsonValueForTransport({
      operation: 'stats.read', target,
      request: { kind: 'stats.read', group: 'indexAdvice', selection: { statementKey } },
    }), { signal: lifetime.current.signal });
  };
  const checkLabel = t('plugins.database.insights.adviceCheck', 'Check for index suggestions');
  const retryLabel = t('plugins.database.insights.adviceRetry', 'Retry');
  if (execution.status === 'idle' || execution.status === 'pending') {
    return <Button variant="secondary" size="small"
      title={execution.status === 'pending' ? t('plugins.database.insights.adviceChecking', 'Checking for index suggestions…') : checkLabel}
      disabled={execution.status === 'pending'} onPress={run} />;
  }
  if (execution.status === 'error' || execution.status === 'outcomeUnknown') {
    return <Action.Failure execution={execution} onRetry={run} retryLabel={retryLabel} />;
  }
  const parsed = DatabaseOperationResultV1Schema.safeParse(execution.result);
  const result = parsed.success ? parsed.data : undefined;
  const observation = result?.ok && result.operation === 'stats.read' ? result.observation : undefined;
  if (observation?.group !== 'indexAdvice') {
    return <ErrorState layout="line" kind="unavailable"
      title={t('plugins.database.insights.adviceUnavailable', 'Index suggestions are unavailable.')}
      details={result && !result.ok ? result.code : undefined}
      onRetry={run} retryLabel={retryLabel} />;
  }
  if (observation.status === 'unavailable') {
    return <ErrorState layout="line" kind="unavailable" title={unavailableMessage(observation.reason, t)}
      description={observation.reason === 'hypopg_missing'
        ? t('plugins.database.insights.adviceSetup', 'Ask your database administrator to make HypoPG available on the server and run CREATE EXTENSION hypopg in this database. Then retry.')
        : observation.remediation}
      onRetry={run} retryLabel={retryLabel} />;
  }
  if (observation.data.length === 0) {
    return <Text tone="secondary"
      value={t('plugins.database.insights.adviceNone', 'No single-column index halved the estimated cost.')} />;
  }
  return (
    <Stack gap="medium">
      {observation.data.map(({ relation, column, baselineCost, candidateCost }) => (
        <Stack gap="small" key={column}>
          <Text variant="label" value={t('plugins.database.insights.adviceColumn', '{table} · {column}', {
            table: `${relation.schema}.${relation.name}`, column,
          })} />
          <Row gap="large" wrap>
            <Metric size="stat" showLabel label={t('plugins.database.insights.adviceBefore', 'Estimated cost before')} value={cost.format(baselineCost)} />
            <Metric size="stat" showLabel label={t('plugins.database.insights.adviceAfter', 'Estimated cost after')} value={cost.format(candidateCost)} />
          </Row>
        </Stack>
      ))}
      <Text variant="meta" tone="secondary" value={t('plugins.database.insights.adviceCaveat',
        'PostgreSQL planner estimates can differ from actual query latency.')} />
    </Stack>
  );
}
