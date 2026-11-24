import * as React from 'react';
import {
  DATABASE_INSIGHTS_FINDINGS_DISMISS_ACTION_ID_V1,
  DATABASE_INSIGHTS_FINDINGS_LIST_ACTION_ID_V1,
  DATABASE_INSIGHTS_FINDINGS_READ_ACTION_ID_V1,
  databaseActionLocalIdV1,
} from '@happier-dev/database-protocol';
import {
  DatabaseFindingDismissResultV1ProtocolSchema,
  DatabaseFindingReadResultV1Schema,
  DatabaseFindingsListResultV1Schema,
  type DatabaseFailureV1,
  type DatabaseRelationV1,
  type DatabaseStatsReadV1,
  type DatabaseTargetV1,
} from '@happier-dev/plugin-sdk/database';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import { isPluginError } from '@happier-dev/plugin-sdk';
import { Button, EmptyState, ErrorState, Item, ItemGroup, Row, Select, Stack, Text, usePluginTranslation } from '@happier-dev/plugin-ui';
import { useExecutePluginAction } from '@happier-dev/plugin-ui/hostApi';
import { displayDatabaseStatementShape } from '@happier-dev/databases/statements';
import { useWorkbenchInstance } from '../../hooks.js';
import { ACTIVITY_READ } from './ActivityView.js';
import { FindingBrief } from './FindingBrief.js';
import { formatCount, formatDuration, formatMoment } from './format.js';
import { STATEMENTS_BY_TOTAL_TIME } from './statements.js';
import { InsightsSchemaSelection, insightsSchemaStatsSelection } from './TablesView.js';

const listAction = databaseActionLocalIdV1(DATABASE_INSIGHTS_FINDINGS_LIST_ACTION_ID_V1);
const readAction = databaseActionLocalIdV1(DATABASE_INSIGHTS_FINDINGS_READ_ACTION_ID_V1);
const dismissAction = databaseActionLocalIdV1(DATABASE_INSIGHTS_FINDINGS_DISMISS_ACTION_ID_V1);
type EvidenceGroup = 'statements' | 'tables' | 'indexes' | 'activity';

function useFindingAction(action: typeof listAction | typeof readAction,
  target: DatabaseTargetV1, request: DatabaseStatsReadV1, recordKey?: string) {
  const { client } = useWorkbenchInstance();
  const { execute, execution } = useExecutePluginAction(action);
  const [demandError, setDemandError] = React.useState<{ details?: string } | null>(null);
  const [revision, refresh] = React.useReducer(value => value + 1, 0);
  React.useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    setDemandError(null);
    async function read() {
      try {
        const subscriptionId = await client.readDemandSubscriptionId?.(target, signal);
        if (signal.aborted) return;
        await execute(projectNativeJsonValueForTransport({ target, request,
          ...(recordKey === undefined ? {} : { recordKey }),
          ...(subscriptionId === undefined ? {} : { subscriptionId }),
        }), { signal });
      } catch (error) {
        if (!signal.aborted) setDemandError({
          details: isPluginError(error) ? `${error.code} (${error.message})` : error instanceof Error ? error.message : undefined,
        });
      }
    }
    void read();
    return () => controller.abort();
  }, [client, execute, target, request, recordKey, revision]);
  return { execution, refresh, demandError };
}

function Failure({ details, retry }: Readonly<{ details?: string; retry: () => void }>) {
  const t = usePluginTranslation();
  return <ErrorState layout="line" title={t('plugins.database.insights.findingsUnavailable', 'Findings could not be read')}
    details={details} onRetry={retry} retryLabel={t('plugins.database.retry', 'Try again')} />;
}

function failureDetails(failure: DatabaseFailureV1): string {
  const reason = ('cause' in failure ? failure.cause?.message : undefined) ?? ('reason' in failure ? failure.reason : undefined);
  return reason ? `${failure.code} (${reason})` : failure.code;
}

export function NativeFindings({ target, targetKey }: Readonly<{
  target: DatabaseTargetV1; targetKey: string;
}>) {
  const t = usePluginTranslation();
  const [group, setGroup] = React.useState<EvidenceGroup>('statements');
  const groups = [
    { value: 'statements', label: t('plugins.database.insights.statements', 'Statements') },
    { value: 'tables', label: t('plugins.database.insights.tables', 'Tables') },
    { value: 'indexes', label: t('plugins.database.insights.indexes', 'Indexes') },
    { value: 'activity', label: t('plugins.database.insights.activity', 'Activity') },
  ] as const;
  return <Stack gap="medium" grow>
    <Select label={t('plugins.database.insights.findingGroup', 'Evidence')} options={groups} value={group}
      onChange={value => { const selected = groups.find(option => option.value === value); if (selected) setGroup(selected.value); }} />
    {group === 'tables' || group === 'indexes' ? (
      <InsightsSchemaSelection targetKey={targetKey}>
        {schema => <SchemaFindings key={JSON.stringify([group, schema])} target={target} group={group} schema={schema} />}
      </InsightsSchemaSelection>
    ) : <FindingsGroup key={group} target={target} request={group === 'statements' ? STATEMENTS_BY_TOTAL_TIME : ACTIVITY_READ} />}
  </Stack>;
}

function SchemaFindings({ target, group, schema }: Readonly<{
  target: DatabaseTargetV1; group: 'tables' | 'indexes'; schema: string;
}>) {
  const request = React.useMemo<DatabaseStatsReadV1>(() => ({
    kind: 'stats.read', group, selection: insightsSchemaStatsSelection(schema),
  }), [group, schema]);
  return <FindingsGroup target={target} request={request} />;
}

function FindingsGroup({ target, request }: Readonly<{
  target: DatabaseTargetV1; request: DatabaseStatsReadV1;
}>) {
  const t = usePluginTranslation();
  const [recordKey, select] = React.useState<string | null>(null);
  const [hidden, setHidden] = React.useState<ReadonlySet<string>>(() => new Set());
  const { execution, refresh, demandError } = useFindingAction(listAction, target, request);
  if (demandError) return <Failure details={demandError.details} retry={refresh} />;
  if (execution.status === 'idle' || execution.status === 'pending') {
    return <Text tone="secondary">{t('plugins.database.insights.sourceLoading', 'Loading findings…')}</Text>;
  }
  if (execution.status !== 'success') {
    return <Failure details={'message' in execution ? execution.message : undefined} retry={refresh} />;
  }
  const parsed = DatabaseFindingsListResultV1Schema.safeParse(execution.result);
  if (!parsed.success) return <Failure retry={refresh} />;
  if (!parsed.data.ok) return <Failure details={failureDetails(parsed.data)} retry={refresh} />;
  const { observation } = parsed.data;
  const findings = parsed.data.findings.filter(finding => !finding.dismissalKey || !hidden.has(finding.dismissalKey));
  const selected = findings.find(finding => finding.recordKey === recordKey);
  return <Stack gap="medium" grow>
    <Text tone="secondary">{formatMoment(observation.observedWindow.toMs)}</Text>
    <Button size="small" variant="secondary" title={t('plugins.database.refresh', 'Refresh')} onPress={refresh} />
    {findings.length === 0 ? <EmptyState layout="line" title={t('plugins.database.insights.sourceEmpty', 'No findings')} /> : <ItemGroup>
      {findings.map(finding => {
        const { object, summary } = finding;
        const title = object ? object.kind === 'index' ? object.name : object.relation.name
          : summary.blocking ? t('plugins.database.insights.findingBlockers', '{count} blockers', { count: String(summary.blocking.blockers) })
          : summary.calls === undefined ? t('plugins.database.insights.sourceRecords', '{count} records', { count: String(summary.records) })
            : t('plugins.database.insights.findingCalls', '{count} calls', { count: formatCount(summary.calls, { full: true }) ?? summary.calls });
        return <Item key={finding.recordKey} title={title} accessibilityLabel={title} subtitle={formatDuration(summary.totalTimeMs) ?? undefined}
          onPress={() => select(finding.recordKey)} selected={finding.recordKey === recordKey} />;
      })}
    </ItemGroup>}
    {selected ? <NativeFinding key={selected.recordKey} target={target} request={request} recordKey={selected.recordKey}
      relation={selected.object?.relation} dismissalKey={selected.dismissalKey} onDismiss={key => {
        setHidden(current => new Set([...current, key]));
        select(null);
      }} /> : null}
  </Stack>;
}

function NativeFinding({ target, request, recordKey, relation, dismissalKey, onDismiss }: Readonly<{
  target: DatabaseTargetV1; request: DatabaseStatsReadV1; recordKey: string;
  relation?: DatabaseRelationV1;
  dismissalKey?: string; onDismiss: (key: string) => void;
}>) {
  const t = usePluginTranslation();
  const selectedRequest = React.useMemo(() => {
    if (relation && (request.group === 'tables' || request.group === 'indexes')) {
      return { ...request, selection: { relation } };
    }
    return request;
  }, [relation, request]);
  const { execution, refresh, demandError } = useFindingAction(readAction, target, selectedRequest, recordKey);
  const dismiss = useExecutePluginAction(dismissAction);
  const [dismissError, setDismissError] = React.useState<string | null>(null);
  if (demandError) return <Failure details={demandError.details} retry={refresh} />;
  if (execution.status === 'idle' || execution.status === 'pending') {
    return <Text tone="secondary">{t('plugins.database.insights.sourceLoading', 'Loading findings…')}</Text>;
  }
  if (execution.status !== 'success') {
    return <Failure details={'message' in execution ? execution.message : undefined} retry={refresh} />;
  }
  const parsed = DatabaseFindingReadResultV1Schema.safeParse(execution.result);
  if (!parsed.success) return <Failure retry={refresh} />;
  if (!parsed.data.ok) return <Failure details={failureDetails(parsed.data)} retry={refresh} />;
  const { finding } = parsed.data;
  const shape = finding.normalizedShape ? displayDatabaseStatementShape(finding.normalizedShape) : finding.omittedTextReason;
  const dismissFinding = async () => {
    if (!dismissalKey) return;
    setDismissError(null);
    const result = await dismiss.execute(projectNativeJsonValueForTransport({ target, dismissalKey }));
    if (result.status === 'pending') return;
    if (result.status === 'success' && DatabaseFindingDismissResultV1ProtocolSchema.safeParse(result.result).success) {
      onDismiss(dismissalKey);
    } else {
      setDismissError('message' in result ? result.message
        : t('plugins.database.insights.dismissFailed', 'The finding could not be dismissed.'));
    }
  };
  return <Stack gap="small">
    {shape ? <Text>{shape}</Text> : null}
    {finding.coverage.status === 'partial' ? <Text tone="secondary">{finding.coverage.reasons.join(', ')}</Text> : null}
    <Row gap="small" wrap>
      <FindingBrief target={target} recordKey={recordKey} request={selectedRequest} />
      {dismissalKey ? <Button size="small" variant="secondary" busy={dismiss.execution.status === 'pending'}
        title={t('plugins.database.insights.dismissFinding', 'Dismiss finding')} onPress={dismissFinding} /> : null}
    </Row>
    {dismissError ? <ErrorState layout="line" title={dismissError} /> : null}
  </Stack>;
}
