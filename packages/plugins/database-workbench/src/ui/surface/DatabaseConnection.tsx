import * as React from 'react';
import {
  DATABASE_DESCRIBE_ACTION_ID_V1, DATABASE_TARGETS_CONNECT_ACTION_ID_V1,
  DATABASE_TARGETS_FORGET_ACTION_ID_V1, DatabaseTargetsForgetResultV1Schema,
} from '@happier-dev/database-protocol';
import { databaseActionLocalIdV1, isPluginActionApprovalRequestCreated } from '@happier-dev/plugin-sdk/actions';
import { DatabaseDescriptorV1Schema, type DatabaseDescriptorV1 } from '@happier-dev/plugin-sdk/database';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import { Action, Button, ErrorState, Form, Row, SelectionTiles, Stack, Text, TextField, usePluginTranslation } from '@happier-dev/plugin-ui';
import { SavedSecretChoiceList } from '@happier-dev/plugin-ui/components';
import {
  projectPluginActionControlExecutionV1, projectPluginActionRejectionV1, usePluginHostApi, type PluginActionExecution,
} from '@happier-dev/plugin-ui/hostApi';
import { databaseActionSettlement } from '../actionSettlement.js';
import { WorkbenchOperationError } from '../workbench.js';
import type { WorkbenchLaunchInput } from './mount.js';
import { openWorkbenchPage } from './openWorkbench.js';

const connectAction = databaseActionLocalIdV1(DATABASE_TARGETS_CONNECT_ACTION_ID_V1);
const describeAction = databaseActionLocalIdV1(DATABASE_DESCRIBE_ACTION_ID_V1);
const forgetAction = databaseActionLocalIdV1(DATABASE_TARGETS_FORGET_ACTION_ID_V1);
type WorktreeScope = Extract<WorkbenchLaunchInput['scope'], { kind: 'worktree' }>;

export function DatabaseConnection({ scope, onConnected, onFileOpened, onCancel }: Readonly<{
  scope: WorktreeScope;
  onConnected(descriptor: DatabaseDescriptorV1): void;
  onFileOpened(): void;
  onCancel(): void;
}>) {
  const t = usePluginTranslation();
  const [source, selectSource] = React.useState<'server' | 'file'>('server');

  // What to connect is one visible choice (lab dbFind-connectFile engine tiles), never a toggle that swaps the form.
  return <Stack gap="small">
    <SelectionTiles testID="database-connect-source" density="compact" maximumColumns={2}
      accessibilityLabel={t('plugins.database.connect.source', 'What to connect')}
      value={source} onChange={selectSource} options={[
        { id: 'server', icon: 'database', title: t('plugins.database.connect.sourceServer', 'A database server'),
          subtitle: t('plugins.database.connect.sourceServerDetail', 'Its address, kept as a Saved Secret') },
        { id: 'file', icon: 'file', title: t('plugins.database.connect.sourceFile', 'A SQLite file'),
          subtitle: t('plugins.database.connect.sourceFileDetail', 'A file in this checkout') },
      ]} />
    {source === 'file'
      ? <SQLiteFileConnection scope={scope} onOpened={onFileOpened} onCancel={onCancel} />
      : <SavedSecretConnection scope={scope} onConnected={onConnected} onForgot={onCancel} onCancel={onCancel} />}
  </Stack>;
}

/** The form's own action row: its one operation, then Cancel (Form.Actions), with what the row will do beneath. */
function ConnectActions(props: Readonly<{ children: React.ReactNode; onCancel(): void; footnote?: string }>) {
  const t = usePluginTranslation();
  return <Form.Actions {...(props.footnote ? { footnote: props.footnote } : {})}>
    {props.children}
    <Button title={t('plugins.database.cancel', 'Cancel')} variant="secondary" onPress={props.onCancel} />
  </Form.Actions>;
}

function SavedSecretConnection({ scope, onConnected, onForgot, onCancel }: Readonly<{
  scope: WorktreeScope;
  onConnected(descriptor: DatabaseDescriptorV1): void;
  onForgot(): void;
  onCancel(): void;
}>) {
  const t = usePluginTranslation();
  const [ref, setRef] = React.useState<string | null>(null);
  const [name, setName] = React.useState('');
  const [execution, setExecution] = React.useState<PluginActionExecution>({ status: 'idle' });
  const awaitingApproval = execution.status === 'success' && isPluginActionApprovalRequestCreated(execution.result);
  const failed = execution.status === 'error' || execution.status === 'outcomeUnknown';
  const connectionName = t('plugins.database.connect.name', 'Connection name');

  return <>
    <SavedSecretChoiceList testIDPrefix="database-connect-secret" selectedRef={ref}
      connectionStringLabel={t('plugins.database.connect.connectionString', 'Connection string')}
      onSelect={({ ref: next }) => { setExecution({ status: 'idle' }); setRef(next); }} />
    {ref ? <Form.Field label={connectionName}>
      <TextField label={connectionName} value={name} onChange={setName} />
    </Form.Field> : null}
    <Action.Failure execution={execution} />
    {awaitingApproval ? <Text tone="secondary" value={t('plugins.database.connect.pending', 'Waiting for approval.')} /> : null}
    <ConnectActions onCancel={onCancel} footnote={t('plugins.database.connect.footnote', 'The address stays in your Saved Secrets.')}>
    <Action.Control action={connectAction}
      title={failed ? t('plugins.database.retry', 'Try again') : t('plugins.database.connect.test', 'Test and connect')}
      disabled={!ref || awaitingApproval}
      controller={{
        prepare: () => ref ? { input: projectNativeJsonValueForTransport({
          scope, savedSecretRef: ref, label: name.trim() || t('plugins.database.connect.defaultName', 'Database'),
        }) } : null,
        onSettled: value => {
          const result = projectPluginActionControlExecutionV1(value, t);
          setExecution(result);
          if (result.status !== 'success') return;
          const accepted = DatabaseDescriptorV1Schema.safeParse(result.result);
          if (accepted.success) onConnected(accepted.data);
        },
      }} />
    </ConnectActions>
    {failed && ref ? <DatabaseForget target={{ kind: 'manual', accountId: scope.accountId, installationId: scope.installationId,
      projectKey: scope.projectKey, workspace: scope.workspace, savedSecretId: ref }} onForgot={onForgot} /> : null}
  </>;
}

function SQLiteFileConnection({ scope, onOpened, onCancel }: Readonly<{ scope: WorktreeScope; onOpened(): void; onCancel(): void }>) {
  const t = usePluginTranslation();
  const host = usePluginHostApi();
  const [path, setPath] = React.useState('');
  const [execution, setExecution] = React.useState<PluginActionExecution>({ status: 'idle' });
  const [picking, setPicking] = React.useState(false);
  const [unavailable, setUnavailable] = React.useState<'checkout_unavailable' | 'outside_checkout' | null>(null);
  // The host's checkout picker fills the same field typing does: a dismissal changes nothing and is not an error, and a
  // checkout the host cannot offer says its typed reason (Host API 1.3 pickWorkspaceFile).
  const pick = async () => {
    setPicking(true);
    try {
      const picked = await host.pickWorkspaceFile();
      if (picked.kind === 'picked') {
        setUnavailable(null);
        setPath(picked.relativePath);
      } else if (picked.kind === 'unavailable') {
        setUnavailable(picked.reason);
      }
    } catch (error) {
      setExecution(projectPluginActionRejectionV1(error, t));
    } finally {
      setPicking(false);
    }
  };

  return <>
    <Row gap="small" align="flex-end">
      <Stack grow>
        <TextField
          label={t('plugins.database.connect.filePath', 'SQLite file path')}
          placeholder={t('plugins.database.connect.filePathPlaceholder', 'Path relative to the checkout')}
          value={path}
          onChange={setPath}
        />
      </Stack>
      <Button variant="secondary" title={t('plugins.database.connect.chooseFile', 'Choose file…')} busy={picking}
        disabled={picking} onPress={() => { void pick(); }} />
    </Row>
    {unavailable === null ? null : <ErrorState layout="line" title={unavailable === 'outside_checkout'
      ? t('plugins.database.connect.fileOutsideCheckout', 'That file is outside this checkout')
      : t('plugins.database.connect.checkoutUnavailable', 'This checkout isn’t available on its Machine right now')} />}
    <Action.Failure execution={execution} />
    <ConnectActions onCancel={onCancel}>
    <Action.Control
      action={describeAction}
      title={t('plugins.database.connect.openFile', 'Open SQLite file')}
      disabled={!path.trim() || execution.status === 'pending'}
      controller={{
        prepare: () => {
          return path.trim() ? { input: projectNativeJsonValueForTransport({
            operation: 'describe',
            target: { ...scope, source: { kind: 'sqlite_file', path } },
          }) } : null;
        },
        onSettled: value => {
          const settled = databaseActionSettlement(value, 'describe');
          if (settled.status !== 'success') {
            setExecution(settled);
            return;
          }
          const result = settled.result;
          if (!result.ok) {
            setExecution(projectPluginActionRejectionV1(new WorkbenchOperationError(result), t));
            return;
          }
          if (result.operation === 'describe') {
            setExecution({ status: 'pending' });
            void openWorkbenchPage(host, result.descriptor).then(onOpened, error => {
              setExecution(projectPluginActionRejectionV1(error, t));
            });
          }
        },
      }}
    />
    </ConnectActions>
  </>;
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
