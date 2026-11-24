import * as React from 'react';
import type { PluginTargetedContributionSelectionV1 } from '@happier-dev/plugin-sdk/contributions';
import {
  DATABASE_INSIGHTS_BRIEF_BUILD_ACTION_ID_V1,
  databaseActionLocalIdV1,
} from '@happier-dev/database-protocol';
import {
  DatabaseFindingBriefBuildResultV1Schema,
  type DatabaseFindingBriefBuildResultV1,
  type DatabaseTargetV1,
} from '@happier-dev/plugin-sdk/database';
import { projectNativeJsonValueForTransport, ProtocolWorkspaceAddressV1Schema } from '@happier-dev/plugin-sdk/protocol';
import { SessionInputHandoffResultV1Schema, type SessionInputHandoffInputV1 } from '@happier-dev/plugin-sdk/sessions';
import type { PluginUiActionControlExecution } from '@happier-dev/plugin-sdk/ui';
import { Action, Button, ErrorState, Markdown, Row, Stack, usePluginTranslation, useSurfaceContext } from '@happier-dev/plugin-ui';
import { isPluginActionConfirmationDeclined, projectPluginActionControlExecutionV1, useExecutePluginAction } from '@happier-dev/plugin-ui/hostApi';
import { createDatabaseBriefHandoffControl } from '../../../insights/migration.js';
import { statementByKey } from './statements.js';

const buildAction = databaseActionLocalIdV1(DATABASE_INSIGHTS_BRIEF_BUILD_ACTION_ID_V1);
type Brief = Extract<DatabaseFindingBriefBuildResultV1, { ok: true }>['brief'];

export function FindingBrief({ target, recordKey, sourceSelection }: Readonly<{
  target: DatabaseTargetV1; recordKey: string; sourceSelection?: PluginTargetedContributionSelectionV1;
}>) {
  const t = usePluginTranslation();
  const surface = useSurfaceContext();
  const build = useExecutePluginAction(buildAction);
  const [brief, setBrief] = React.useState<Brief | null>(null);
  const [error, setError] = React.useState<{ title: string; details?: string } | null>(null);
  const missing = t('plugins.database.insights.briefUnavailable', 'The finding brief could not be prepared.');
  const prepare = async () => {
    setError(null);
    const input = sourceSelection ? { target, recordKey, sourceSelection } : { target, recordKey, request: statementByKey(recordKey) };
    const result = await build.execute(projectNativeJsonValueForTransport(input));
    if (result.status === 'pending') return;
    if (result.status !== 'success') {
      setError({ title: 'message' in result ? result.message : missing });
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
  const settled = (execution: PluginUiActionControlExecution) => {
    const result = projectPluginActionControlExecutionV1(execution, t);
    if (isPluginActionConfirmationDeclined(result)) return;
    const message = 'message' in result ? result.message
      : t('plugins.database.insights.composerUnavailable', 'The brief could not be opened in the Composer.');
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
  const workspace = target.kind === 'worktree' ? ProtocolWorkspaceAddressV1Schema.safeParse(target.workspace) : undefined;
  const newSession: SessionInputHandoffInputV1['newSession'] = { kind: 'new',
    seed: workspace?.success ? { placement: {
      kind: 'exactTarget', serverId: workspace.data.serverId, machineId: workspace.data.machineId, directory: workspace.data.rootPath,
    } } : {},
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
    {error ? <ErrorState layout="line" {...error} /> : null}
  </Stack>;
}
