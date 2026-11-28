import * as React from 'react';
import { isPluginError } from '@happier-dev/plugin-sdk';
import type { PluginTargetedContributionSelectionV1 } from '@happier-dev/plugin-sdk/contributions';
import {
  DATABASE_INSIGHTS_BRIEF_BUILD_ACTION_ID_V1,
  DATABASE_INSIGHTS_FINDINGS_READ_ACTION_ID_V1,
  databaseActionLocalIdV1,
} from '@happier-dev/database-protocol';
import {
  DatabaseFindingBriefBuildResultV1Schema,
  DatabaseFindingReadResultV1Schema,
  type DatabaseFindingV1,
  type DatabaseFindingBriefBuildResultV1,
  type DatabaseStatsReadV1,
  type DatabaseTargetV1,
} from '@happier-dev/plugin-sdk/database';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import { SessionInputHandoffResultV1Schema, type SessionInputHandoffInputV1 } from '@happier-dev/plugin-sdk/sessions';
import type { PluginUiActionControlExecution } from '@happier-dev/plugin-sdk/ui';
import { Action, Button, ErrorState, Markdown, Row, Stack, usePluginTranslation, useSurfaceContext } from '@happier-dev/plugin-ui';
import { isPluginActionConfirmationDeclined, projectPluginActionControlExecutionV1, useExecutePluginAction, usePluginHostApi, type PluginActionExecution } from '@happier-dev/plugin-ui/hostApi';
import { buildDatabaseFindingWorkflowSeed } from '../../../insights/findingEventSource.js';
import { createDatabaseBriefHandoffControl, parseDatabaseWorktreeDraftPlacement } from '../../../insights/migration.js';
import { useWorkbenchInstance } from '../../hooks.js';
import { statementByKey } from './statements.js';

const buildAction = databaseActionLocalIdV1(DATABASE_INSIGHTS_BRIEF_BUILD_ACTION_ID_V1);
const readAction = databaseActionLocalIdV1(DATABASE_INSIGHTS_FINDINGS_READ_ACTION_ID_V1);
type Brief = Extract<DatabaseFindingBriefBuildResultV1, { ok: true }>['brief'];

export function FindingBrief({ target, recordKey, sourceSelection, request, finding }: Readonly<{
  target: DatabaseTargetV1; recordKey: string; sourceSelection?: PluginTargetedContributionSelectionV1; request?: DatabaseStatsReadV1;
  finding?: DatabaseFindingV1;
}>) {
  const t = usePluginTranslation();
  const surface = useSurfaceContext();
  const host = usePluginHostApi();
  const { client } = useWorkbenchInstance();
  const build = useExecutePluginAction(buildAction);
  const read = useExecutePluginAction(readAction);
  const [brief, setBrief] = React.useState<Brief | null>(null);
  const [error, setError] = React.useState<{ title: string; details?: string } | PluginActionExecution | null>(null);
  const missing = t('plugins.database.insights.briefUnavailable', 'The finding brief could not be prepared.');
  const prepareInput = async () => {
    if (sourceSelection) return projectNativeJsonValueForTransport({ target, recordKey, sourceSelection });
    const subscriptionId = await client.readDemandSubscriptionId?.(target);
    return projectNativeJsonValueForTransport({ target, recordKey, request: request ?? statementByKey(recordKey),
      ...(subscriptionId === undefined ? {} : { subscriptionId }) });
  };
  const prepare = async () => {
    setError(null);
    let result: Awaited<ReturnType<typeof build.execute>>;
    try {
      result = await build.execute(await prepareInput());
    } catch (cause) {
      setError({ title: missing, details: isPluginError(cause) ? `${cause.code} (${cause.message})`
        : cause instanceof Error ? cause.message : undefined });
      return;
    }
    if (result.status === 'pending') return;
    if (result.status !== 'success') {
      setError('code' in result ? result : { title: missing });
      return;
    }
    const prepared = DatabaseFindingBriefBuildResultV1Schema.safeParse(result.result);
    if (!prepared.success) { setError({ title: missing }); return; }
    if (!prepared.data.ok) {
      const failure = prepared.data;
      const details = 'reason' in failure && failure.reason ? `${failure.code} (${failure.reason})` : failure.code;
      setError({ title: missing, details });
      return;
    }
    setBrief(prepared.data.brief);
  };
  const createWorkflow = async () => {
    setError(null);
    const title = t('plugins.database.insights.workflowUnavailable', 'The Workflow editor could not be opened.');
    try {
      let selected = finding;
      if (!selected) {
        const result = await read.execute(await prepareInput());
        if (result.status === 'pending') return;
        if (result.status !== 'success') {
          setError('code' in result ? result : { title });
          return;
        }
        const parsed = DatabaseFindingReadResultV1Schema.safeParse(result.result);
        if (!parsed.success || !parsed.data.ok) {
          setError({ title, details: parsed.success && !parsed.data.ok ? parsed.data.code : undefined });
          return;
        }
        selected = parsed.data.finding;
      }
      const seed = buildDatabaseFindingWorkflowSeed(selected);
      await host.openAutomationEvent(seed);
    } catch (cause) {
      setError({ title, details: isPluginError(cause) ? `${cause.code} (${cause.message})`
        : cause instanceof Error ? cause.message : undefined });
    }
  };
  const settled = (execution: PluginUiActionControlExecution) => {
    const result = projectPluginActionControlExecutionV1(execution, t);
    if (isPluginActionConfirmationDeclined(result)) return;
    if ('code' in result) {
      setError(result);
      return;
    }
    const message = t('plugins.database.insights.composerUnavailable', 'The brief could not be opened in the Composer.');
    const handoff = result.status === 'success' ? SessionInputHandoffResultV1Schema.safeParse(result.result) : null;
    const kind = handoff?.success ? handoff.data.kind : null;
    setError(kind === 'composed' || kind === 'authoringResult' || kind === 'cancelled' ? null : { title: message });
  };
  const openDraft = (prepared: Brief, handoff: Omit<SessionInputHandoffInputV1, 'input' | 'idempotencyKey'>) =>
    createDatabaseBriefHandoffControl(() => prepared, { handoff, idempotencyKey: () => globalThis.crypto.randomUUID(), onSettled: settled });
  const currentSession = surface.target.kind === 'session' ? surface.target.sessionId : null;
  const sessionChoice: SessionInputHandoffInputV1['sessionChoice'] | null = currentSession ? {
    kind: 'existing',
    session: surface.accountScope ? { selector: 'sessions', addresses: [{ serverId: surface.accountScope.serverId, sessionId: currentSession }] } : currentSession,
  } : null;
  const placement = target.kind === 'worktree' ? parseDatabaseWorktreeDraftPlacement(target.workspace) : undefined;
  const newSession: SessionInputHandoffInputV1['newSession'] = {
    kind: 'new', seed: placement ? { placement } : {},
  };
  return <Stack gap="small">
    {brief ? <>
      <Markdown value={brief.text} />
      <Row gap="small" wrap>
        {sessionChoice ? <Action.Control
          {...openDraft(brief, { v: 1, sessionChoice, delivery: 'compose' })}
          title={t('plugins.database.insights.sendBrief', 'Send brief')} variant="secondary" /> : null}
        <Action.Control {...openDraft(brief, { v: 1, sessionChoice: { kind: 'new' }, delivery: 'compose', newSession })}
          title={t('plugins.database.insights.askInvestigation', 'Ask for investigation')} variant="secondary" />
      </Row>
    </> : <Button size="small" variant="secondary" busy={build.execution.status === 'pending'}
      title={t('plugins.database.insights.prepareBrief', 'Prepare brief')} onPress={prepare} />}
    {!sourceSelection ? <Button size="small" variant="secondary" busy={read.execution.status === 'pending'}
      title={t('plugins.database.insights.createWorkflow', 'Create workflow from finding')} onPress={createWorkflow} /> : null}
    {error && ('status' in error ? <Action.Failure execution={error} /> : <ErrorState layout="line" {...error} />)}
  </Stack>;
}
