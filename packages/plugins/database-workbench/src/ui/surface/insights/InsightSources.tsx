import * as React from 'react';
import { isPluginError } from '@happier-dev/plugin-sdk';
import { databaseActionLocalIdV1 } from '@happier-dev/plugin-sdk/actions';
import type { PluginTargetedContributionSelectionV1 } from '@happier-dev/plugin-sdk/contributions';
import {
  DATABASE_INSIGHTS_SOURCES_READ_ACTION_ID_V1,
  DATABASE_INSIGHT_SOURCES_POINT_REF_V1,
  DatabaseInsightSourceDescriptorV1ProtocolSchema,
  DatabaseInsightSourceOperationSchemasV1 as schemas,
  type DatabaseDescriptorV1,
  type DatabaseFailureV1,
  type DatabaseTargetV1,
} from '@happier-dev/plugin-sdk/database';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import {
  pluginUiTargetedContributionOperationKey,
  selectTargetedContributionOperation,
  type PluginUiJsonObjectV1,
  type PluginUiTargetedContributionOperationV1,
  type PluginUiTargetedContributionsV1,
} from '@happier-dev/plugin-sdk/ui';
import { Button, EmptyState, ErrorState, Item, ItemGroup, Stack, Text, usePluginTranslation, useSurfaceContext } from '@happier-dev/plugin-ui';
import { usePluginHostApi } from '@happier-dev/plugin-ui/hostApi';
import { displayDatabaseStatementShape, formatCount } from './format.js';
import { FindingBrief } from './FindingBrief.js';

function projectSources(snapshot: PluginUiTargetedContributionsV1 | undefined, database: DatabaseDescriptorV1) {
  if (!snapshot) return [];
  const { pointId, protocol } = DATABASE_INSIGHT_SOURCES_POINT_REF_V1;
  const contributions = snapshot.points.find(point => point.pointId === pointId)?.protocols.find(entry => (
    entry.protocol.id === protocol.id && entry.protocol.version === protocol.version
  ))?.contributions ?? [];
  return contributions.flatMap(entry => {
    const parsed = DatabaseInsightSourceDescriptorV1ProtocolSchema.safeParse(entry.descriptor);
    if (!parsed.success) return [];
    const descriptor = parsed.data;
    if ((descriptor.targetKinds && !descriptor.targetKinds.includes(database.target.kind))
      || (descriptor.engineIds && !descriptor.engineIds.includes(database.engine))) return [];
    const selector = { pointId, protocol, contributor: entry.contributor };
    const list = selectTargetedContributionOperation(snapshot, { ...selector, role: 'list' });
    const detail = selectTargetedContributionOperation(snapshot, { ...selector, role: 'detail' });
    if (!list || !detail) return [];
    return [{ title: descriptor.displayName, list, detail,
      key: JSON.stringify([pluginUiTargetedContributionOperationKey(list), pluginUiTargetedContributionOperationKey(detail)]) }];
  });
}

type Source = ReturnType<typeof projectSources>[number];

export function useInsightSources(database: DatabaseDescriptorV1) {
  const { targetedContributions } = useSurfaceContext();
  return React.useMemo(() => projectSources(targetedContributions, database), [targetedContributions, database]);
}

const sourceReadAction = {
  pluginId: DATABASE_INSIGHT_SOURCES_POINT_REF_V1.pluginId,
  localId: databaseActionLocalIdV1(DATABASE_INSIGHTS_SOURCES_READ_ACTION_ID_V1),
} as const;

type ReadState<TResult> = { kind: 'pending' | 'cancelled' }
  | { kind: 'result'; result: TResult; selection: PluginTargetedContributionSelectionV1 }
  | { kind: 'failed'; error: unknown };

function useSourceRead<TResult>(operation: PluginUiTargetedContributionOperationV1, draft: PluginUiJsonObjectV1, parse: (raw: unknown) => TResult) {
  const host = usePluginHostApi();
  const [state, setState] = React.useState<ReadState<TResult>>({ kind: 'pending' });
  const [revision, refresh] = React.useReducer(value => value + 1, 0);
  React.useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    setState({ kind: 'pending' });
    async function read() {
      try {
        const selected = await host.selectActionInput({ operation, draft }, { signal });
        if (signal.aborted) return;
        if (selected.kind !== 'submitted') {
          setState({ kind: 'cancelled' });
          return;
        }
        const raw = await host.executeAction(sourceReadAction, {
          ...draft, role: operation.role, sourceSelection: selected.selection,
        }, { signal, selectedActionInput: { operation, result: selected } });
        if (!signal.aborted) setState({ kind: 'result', result: parse(raw), selection: selected.selection });
      } catch (error) {
        if (!signal.aborted) setState({ kind: 'failed', error });
      }
    }
    void read();
    return () => controller.abort();
  }, [host, operation, draft, revision, parse]);
  return { state, refresh };
}

function failureDetails(failure: DatabaseFailureV1): string {
  const reason = ('cause' in failure ? failure.cause?.message : undefined) ?? ('reason' in failure ? failure.reason : undefined);
  return reason ? `${failure.code} (${reason})` : failure.code;
}

function SourceReadStatus<TResult extends { ok: true } | DatabaseFailureV1>({ state, refresh }: Readonly<{
  state: ReadState<TResult>; refresh: () => void;
}>) {
  const t = usePluginTranslation();
  if (state.kind === 'pending') return <Text tone="secondary">{t('plugins.database.insights.sourceLoading', 'Loading findings…')}</Text>;
  if (state.kind === 'cancelled') return <Button size="small" variant="secondary"
    title={t('plugins.database.retry', 'Try again')} onPress={refresh} />;
  const details = state.kind === 'failed'
    ? isPluginError(state.error) ? `${state.error.code} (${state.error.message})` : undefined
    : state.kind === 'result' && !state.result.ok ? failureDetails(state.result) : undefined;
  return <ErrorState layout="line"
    title={t('plugins.database.insights.sourceUnavailable', 'The source could not be read')}
    details={details} onRetry={refresh} retryLabel={t('plugins.database.retry', 'Try again')} />;
}

export function InsightSources({ sources, target }: Readonly<{ sources: readonly Source[]; target: DatabaseTargetV1 }>) {
  const [selectedKey, select] = React.useState<string | null>(null);
  const selected = sources.find(source => source.key === selectedKey);
  return <Stack gap="medium" grow>
    <ItemGroup>
      {sources.map(source => <Item key={source.key} title={source.title} selected={source.key === selectedKey}
        onPress={() => select(source.key)} />)}
    </ItemGroup>
    {selected ? <SourceFindings key={selected.key} source={selected} target={target} /> : null}
  </Stack>;
}

function SourceFindings({ source, target }: Readonly<{ source: Source; target: DatabaseTargetV1 }>) {
  const t = usePluginTranslation();
  const [recordKey, selectFinding] = React.useState<string | null>(null);
  const draft = React.useMemo(() => ({ target: projectNativeJsonValueForTransport(target) }), [target]);
  const read = useSourceRead(source.list, draft, schemas.listResult.parse);
  if (read.state.kind !== 'result' || !read.state.result.ok) return <SourceReadStatus {...read} />;
  const { findings } = read.state.result;
  const selected = findings.find(finding => finding.recordKey === recordKey);
  return <Stack gap="medium" grow>
    <Button size="small" variant="secondary" title={t('plugins.database.refresh', 'Refresh')} onPress={read.refresh} />
    {findings.length === 0 ? <EmptyState layout="line" title={t('plugins.database.insights.sourceEmpty', 'No findings')} /> : <ItemGroup>
      {findings.map(finding => <Item key={finding.recordKey} title={finding.title} accessibilityLabel={finding.title}
        subtitle={t('plugins.database.insights.sourceRecords', '{count} records', {
          count: formatCount(finding.summary.records) ?? String(finding.summary.records),
        })} selected={recordKey === finding.recordKey} onPress={() => selectFinding(finding.recordKey)} />)}
    </ItemGroup>}
    {selected ? <SourceFinding key={selected.recordKey} source={source} target={target} recordKey={selected.recordKey} /> : null}
  </Stack>;
}

function SourceFinding({ source, target, recordKey }: Readonly<{ source: Source; target: DatabaseTargetV1; recordKey: string }>) {
  const draft = React.useMemo(() => ({ target: projectNativeJsonValueForTransport(target), recordKey }), [target, recordKey]);
  const read = useSourceRead(source.detail, draft, schemas.detailResult.parse);
  if (read.state.kind !== 'result' || !read.state.result.ok) return <SourceReadStatus {...read} />;
  const { finding } = read.state.result;
  const shape = finding.normalizedShape ? displayDatabaseStatementShape(finding.normalizedShape) : undefined;
  return <Stack gap="small">
    {shape || finding.omittedTextReason ? <Text>{shape ?? finding.omittedTextReason}</Text> : null}
    {finding.exercise ? <Text tone="secondary">{finding.exercise}</Text> : null}
    <FindingBrief target={target} recordKey={recordKey} sourceSelection={read.state.selection} />
  </Stack>;
}
