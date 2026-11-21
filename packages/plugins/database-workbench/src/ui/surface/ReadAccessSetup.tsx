import * as React from 'react';
import {
  DATABASE_READ_ACCESS_ATTACH_ACTION_ID_V1,
  DATABASE_READ_ACCESS_CREATE_ACTION_ID_V1,
  DatabaseReadAccessSetupResultV1Schema,
  type DatabaseManagedDeploymentTargetV1,
} from '@happier-dev/plugin-sdk/database';
import { databaseActionLocalIdV1, isPluginActionApprovalRequestCreated } from '@happier-dev/plugin-sdk/actions';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import type { PluginUiActionControlExecution } from '@happier-dev/plugin-sdk/ui';
import { Action, Button, CodeBlock, ErrorState, PageHeader, ScrollArea, Stack, SurfaceState, Text, usePluginTranslation } from '@happier-dev/plugin-ui';
import { SavedSecretChoiceList, type SavedSecretChoiceSelection } from '@happier-dev/plugin-ui/components';
import { isPluginActionConfirmationDeclined, projectPluginActionControlExecutionV1, useExecutePluginAction } from '@happier-dev/plugin-ui/hostApi';

const attachAction = databaseActionLocalIdV1(DATABASE_READ_ACCESS_ATTACH_ACTION_ID_V1);
const createAction = databaseActionLocalIdV1(DATABASE_READ_ACCESS_CREATE_ACTION_ID_V1);

export function ReadAccessSetup({ target, onConfigured }: Readonly<{
  target: DatabaseManagedDeploymentTargetV1;
  onConfigured(): void;
}>) {
  const t = usePluginTranslation();
  const preview = useExecutePluginAction(createAction);
  const [attaching, setAttaching] = React.useState(false);
  const [secret, setSecret] = React.useState<SavedSecretChoiceSelection | null>(null);
  const [notice, setNotice] = React.useState<Readonly<{ kind: 'pending' | 'error'; text: string }> | null>(null);
  const title = t('plugins.database.readSetup.title', 'Set up read-only access');
  const attachTitle = t('plugins.database.readSetup.attach', 'Use existing read-only login');
  const createTitle = t('plugins.database.readSetup.create', 'Create read-only login');
  const unexpected = t('plugins.database.readSetup.unknown', 'Could not verify the setup result.');
  const parsedPreview = preview.execution.status === 'success'
    ? DatabaseReadAccessSetupResultV1Schema.safeParse(preview.execution.result) : undefined;
  const review = parsedPreview?.success && parsedPreview.data.status === 'review' ? parsedPreview.data : null;

  function settled(execution: PluginUiActionControlExecution) {
    const result = projectPluginActionControlExecutionV1(execution, t);
    if (result.status === 'success') {
      if (isPluginActionApprovalRequestCreated(result.result)) {
        setNotice({ kind: 'pending', text: t('plugins.database.readSetup.pending', 'Waiting for approval.') });
        return;
      }
      const parsed = DatabaseReadAccessSetupResultV1Schema.safeParse(result.result);
      if (parsed.success && parsed.data.status === 'configured') {
        onConfigured();
        return;
      }
      setNotice({ kind: 'error', text: unexpected });
    } else if (isPluginActionConfirmationDeclined(result)) {
      setNotice(null);
    } else if (result.status === 'error' || result.status === 'outcomeUnknown') {
      setNotice({ kind: 'error', text: result.message });
    }
  }

  if (!attaching && !review) {
    const outcome = preview.execution;
    const error = outcome.status === 'error' || outcome.status === 'outcomeUnknown'
      ? outcome.message : outcome.status === 'success' ? unexpected : null;
    return <SurfaceState kind="unavailable" size="page" title={title}
      description={t('plugins.database.readSetup.description', 'Choose a read-only login for {database} so you can browse its tables.', { database: target.database })}
      action={{ label: attachTitle, disabled: outcome.status === 'pending', onPress: () => { preview.reset(); setAttaching(true); } }}
      secondaryAction={{ label: createTitle, onPress: () => preview.execute(projectNativeJsonValueForTransport({ target, mode: 'preview' })) }}
      body={error ? <ErrorState layout="line" title={error} /> : undefined} />;
  }

  const input = attaching
    ? secret && projectNativeJsonValueForTransport({ target, savedSecretRef: secret.ref, resourceRevision: secret.resourceRevision })
    : review && projectNativeJsonValueForTransport({ target, mode: 'apply', role: review.role, statements: review.statements });
  return <Stack gap="medium" grow>
    <PageHeader title={attaching ? attachTitle : t('plugins.database.readSetup.review', 'Review the read-only login')}
      description={attaching
        ? t('plugins.database.readSetup.savedSecret', 'Choose the connection URL for a read-only login to {database}. If it isn’t listed, save it in Saved Secrets first.', { database: target.database })
        : t('plugins.database.readSetup.reviewDescription', 'These statements will create {role} and grant it read access to {database}.', { role: review?.role ?? '', database: target.database })} />
    {attaching
      ? <SavedSecretChoiceList testIDPrefix="database-read-access-secret" selectedRef={secret?.ref ?? null}
          onSelect={(next) => { setNotice(null); setSecret(next); }} />
      : review && <ScrollArea><CodeBlock language="sql" code={review.statements.join('\n\n')} /></ScrollArea>}
    {notice?.kind === 'error' ? <ErrorState layout="line" title={notice.text} /> : null}
    {notice?.kind === 'pending' ? <Text tone="secondary" value={notice.text} /> : null}
    <Stack gap="small" align="flex-start">
      {input === null ? null : <Action.Control
        action={attaching ? attachAction : createAction}
        title={attaching ? t('plugins.database.readSetup.confirmAttach', 'Use this login') : createTitle}
        variant="primary"
        disabled={notice?.kind === 'pending'}
        reviewedInput={input}
        controller={{ prepare: () => { setNotice(null); return { input }; }, onSettled: settled }}
        fallback={<Text tone="secondary" value={t('plugins.database.readSetup.actionUnavailable', 'This host can’t confirm the read-only login.')}/>} />}
      <Button title={t('plugins.database.readSetup.back', 'Back to setup options')} variant="plain"
        onPress={() => { setNotice(null); preview.reset(); setAttaching(false); }} />
    </Stack>
  </Stack>;
}
