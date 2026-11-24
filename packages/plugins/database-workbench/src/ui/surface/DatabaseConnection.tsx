import * as React from 'react';
import {
  DATABASE_TARGETS_CONNECT_ACTION_ID_V1, DATABASE_TARGETS_FORGET_ACTION_ID_V1, DatabaseTargetsForgetResultV1Schema,
} from '@happier-dev/database-protocol';
import { databaseActionLocalIdV1, isPluginActionApprovalRequestCreated } from '@happier-dev/plugin-sdk/actions';
import { DatabaseDescriptorV1Schema, type DatabaseDescriptorV1 } from '@happier-dev/plugin-sdk/database';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import { Action, Button, ErrorState, Stack, Text, TextField, usePluginTranslation } from '@happier-dev/plugin-ui';
import { SavedSecretChoiceList } from '@happier-dev/plugin-ui/components';
import { projectPluginActionControlExecutionV1, useExecutePluginAction } from '@happier-dev/plugin-ui/hostApi';
import type { WorkbenchLaunchInput } from './mount.js';

const connectAction = databaseActionLocalIdV1(DATABASE_TARGETS_CONNECT_ACTION_ID_V1);
const forgetAction = databaseActionLocalIdV1(DATABASE_TARGETS_FORGET_ACTION_ID_V1);
type WorktreeScope = Extract<WorkbenchLaunchInput['scope'], { kind: 'worktree' }>;

export function DatabaseConnection({ scope, onConnected, onCancel }: Readonly<{
  scope: WorktreeScope;
  onConnected(descriptor: DatabaseDescriptorV1): void;
  onCancel(): void;
}>) {
  const t = usePluginTranslation();
  const [ref, setRef] = React.useState<string | null>(null);
  const [name, setName] = React.useState('');
  const { execution, execute, reset } = useExecutePluginAction(connectAction);
  const awaitingApproval = execution.status === 'success' && isPluginActionApprovalRequestCreated(execution.result);
  const busy = awaitingApproval || execution.status === 'pending';
  const failed = execution.status === 'error' || execution.status === 'outcomeUnknown';

  async function connect() {
    if (!ref) return;
    const result = await execute(projectNativeJsonValueForTransport({
      scope, savedSecretRef: ref, label: name.trim() || t('plugins.database.connect.defaultName', 'Database'),
    }));
    if (result.status !== 'success') return;
    const accepted = DatabaseDescriptorV1Schema.safeParse(result.result);
    if (accepted.success) onConnected(accepted.data);
  }

  return <Stack gap="small">
    <SavedSecretChoiceList testIDPrefix="database-connect-secret" selectedRef={ref}
      onConnect={next => { reset(); setRef(next); }} />
    {ref ? <TextField label={t('plugins.database.connect.name', 'Connection name')} value={name} onChange={setName} /> : null}
    {execution.status === 'error' || execution.status === 'outcomeUnknown' ? <ErrorState layout="line"
      title={execution.message} details={execution.code} /> : null}
    {awaitingApproval ? <Text tone="secondary" value={t('plugins.database.connect.pending', 'Waiting for approval.')} /> : null}
    <Button title={failed ? t('plugins.database.retry', 'Try again') : t('plugins.database.connect.test', 'Test and connect')}
      disabled={!ref || busy} onPress={() => { void connect(); }} />
    {failed && ref ? <DatabaseForget target={{ kind: 'manual', accountId: scope.accountId, installationId: scope.installationId,
      projectKey: scope.projectKey, workspace: scope.workspace, savedSecretId: ref }} onForgot={onCancel} /> : null}
    <Button title={t('plugins.database.cancel', 'Cancel')} variant="plain" onPress={onCancel} />
  </Stack>;
}

export function DatabaseForget({ target, onForgot }: Readonly<{
  target: Extract<DatabaseDescriptorV1['target'], { kind: 'manual' }>;
  onForgot(): void;
}>) {
  const t = usePluginTranslation();
  const input = projectNativeJsonValueForTransport({ target });
  return <Action.Control action={forgetAction} title={t('plugins.database.connect.forget', 'Forget database')}
    variant="secondary" reviewedInput={input} controller={{ prepare: () => ({ input }), onSettled: value => {
      const result = projectPluginActionControlExecutionV1(value, t);
      if (result.status === 'success' && DatabaseTargetsForgetResultV1Schema.safeParse(result.result).success) onForgot();
    } }} />;
}
