import * as React from 'react';
import {
  DATABASE_READ_ACCESS_ATTACH_ACTION_ID_V1,
  DATABASE_READ_ACCESS_CREATE_ACTION_ID_V1,
  DatabaseReadAccessAttachInputV1Schema,
  DatabaseReadAccessSetupResultV1Schema,
  type DatabaseManagedDeploymentTargetV1,
  type DatabaseReadAccessSetupResultV1,
} from '@happier-dev/plugin-sdk/database';
import { databaseActionLocalIdV1, isPluginActionApprovalRequestCreated } from '@happier-dev/plugin-sdk/actions';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import type { PluginUiActionControlExecution } from '@happier-dev/plugin-sdk/ui';
import { Action, Button, CodeBlock, ErrorState, PageHeader, Row, ScrollArea, Stack, SurfaceState, Text, usePluginTranslation } from '@happier-dev/plugin-ui';
import { SavedSecretChoiceList, type SavedSecretChoiceSelection } from '@happier-dev/plugin-ui/components';
import { isPluginActionConfirmationDeclined, projectPluginActionControlExecutionV1, useHostDatabaseWorkbench, type PluginActionExecution } from '@happier-dev/plugin-ui/hostApi';
import { translateUnverifiedServerNotice } from './connectionCopy.js';
import type { WorkbenchTargetDisplay } from './subPath.js';
import { databaseFacts } from './engines.js';
import { renderWorkbenchWriteSetup } from './writeSetup.js';

const attachAction = databaseActionLocalIdV1(DATABASE_READ_ACCESS_ATTACH_ACTION_ID_V1);
const createAction = databaseActionLocalIdV1(DATABASE_READ_ACCESS_CREATE_ACTION_ID_V1);

export function ReadAccessSetup({ target, display, onConfigured }: Readonly<{
  target: DatabaseManagedDeploymentTargetV1;
  display?: WorkbenchTargetDisplay;
  onConfigured(): void;
}>) {
  const t = usePluginTranslation();
  const host = useHostDatabaseWorkbench();
  const [review, setReview] = React.useState<Extract<DatabaseReadAccessSetupResultV1, { status: 'review' }> | null>(null);
  const [attaching, setAttaching] = React.useState(false);
  const [secret, setSecret] = React.useState<SavedSecretChoiceSelection | null>(null);
  const [notice, setNotice] = React.useState<
    | Readonly<{ kind: 'pending' | 'unexpected'; text: string }>
    | Readonly<{ kind: 'failure'; execution: PluginActionExecution; recovery: SavedSecretChoiceSelection | null }>
    | null
  >(null);
  // The host reports when the write setup a refusal led to has settled; that refusal then no longer stands.
  const [configuredFor, setConfiguredFor] = React.useState<typeof notice>(null);
  const noticeRef = React.useRef(notice);
  noticeRef.current = notice;
  const onWriteConfigured = React.useCallback(() => setConfiguredFor(noticeRef.current), []);
  // The identity line names the database by the label the rail shows (its address name only when the open carried none),
  // then the rail's facts; the description stays generic.
  const identity = [display?.label || target.database, display ? databaseFacts({ engine: display.engine, origin: { label: display.origin } }) : '']
    .filter(Boolean).join(' · ');
  const title = t('plugins.database.readSetup.title', 'Set up read-only access');
  const attachTitle = t('plugins.database.readSetup.attach', 'Use existing read-only login');
  const createTitle = t('plugins.database.readSetup.create', 'Create read-only login');
  const unexpected = t('plugins.database.readSetup.unknown', 'Could not verify the setup result.');
  const unavailable = t('plugins.database.readSetup.actionUnavailable', 'This host can’t confirm the read-only login.');

  function openAttach(selection = secret) {
    setNotice(null);
    setSecret(selection);
    setAttaching(true);
  }

  function settled(execution: PluginUiActionControlExecution, expected: 'review' | 'configured') {
    const result = projectPluginActionControlExecutionV1(execution, t);
    if (result.status === 'success') {
      if (isPluginActionApprovalRequestCreated(result.result)) {
        setNotice({ kind: 'pending', text: t('plugins.database.readSetup.pending', 'Waiting for approval.') });
        return;
      }
      const parsed = DatabaseReadAccessSetupResultV1Schema.safeParse(result.result);
      if (parsed.success && parsed.data.status === expected) {
        if (parsed.data.status === 'review') setReview(parsed.data);
        else onConfigured();
        return;
      }
      setNotice({ kind: 'unexpected', text: unexpected });
    } else if (isPluginActionConfirmationDeclined(result)) {
      setNotice(null);
    } else if (result.status === 'error' || result.status === 'outcomeUnknown') {
      const details = result.code === 'database_read_role_binding_failed' ? result.details : undefined;
      const recovery = details && typeof details === 'object' && 'savedSecretRef' in details && 'resourceRevision' in details
        ? DatabaseReadAccessAttachInputV1Schema.safeParse({ target, savedSecretRef: details.savedSecretRef, resourceRevision: details.resourceRevision })
        : null;
      setNotice({ kind: 'failure', execution: result,
        recovery: recovery?.success ? { ref: recovery.data.savedSecretRef, resourceRevision: recovery.data.resourceRevision } : null });
    }
  }

  // The login already exists and is saved: using it is the one way forward, never a second login.
  const recovery = notice?.kind === 'failure' ? notice.recovery : null;
  // The last refusal guides recovery. The Action decides the Environment's current editing policy on each request.
  const editingOff = notice?.kind === 'failure'
    && (notice.execution.status === 'error' || notice.execution.status === 'outcomeUnknown')
    && notice.execution.code === 'database_editing_off';
  // Creating the login needs the Environment's write connection: its setup is the way forward, the same one a
  // refused Apply leads to. Create stays offered, but is not the filled control until that setup settles.
  const writeSetup = notice?.kind === 'failure' && (notice.execution.status === 'error' || notice.execution.status === 'outcomeUnknown')
    ? renderWorkbenchWriteSetup(host, target, notice.execution.code, onWriteConfigured) : null;
  const writeSetupStands = writeSetup != null && configuredFor !== notice;
  // Editing off forbids creating a login (Create writes to the database; Use existing only reads), so Create is not
  // offered while it stands. The host's Environment wake clears the refusal, so Create returns once editing is on.
  const clearNotice = React.useCallback(() => setNotice(null), []);
  const editingOffWatch = editingOff ? host?.renderEnvironmentAccessObserver?.({ target, onChanged: clearNotice }) : null;
  const failure = recovery
    ? <ErrorState layout="line" title={t('plugins.database.readSetup.recovery',
        'The read-only login {role} was created and saved, but Workbench couldn’t start using it. Use that login to finish setting up.',
        { role: review?.role ?? '' })} />
    : writeSetup ? writeSetup
    // Editing off is the Environment's policy, not a failure: the same line, drawn as a refusal by policy.
    : notice?.kind === 'failure' ? <Action.Failure execution={notice.execution} {...(editingOff ? { kind: 'denied' as const } : {})} />
    : notice?.kind === 'unexpected' ? <ErrorState layout="line" title={notice.text} /> : undefined;
  if (!attaching && !review) {
    // A prerequisite on a reachable database: its mark, not the unavailable kind's offline glyph.
    return <SurfaceState kind="unavailable" icon="database" size="page" title={title}
      description={editingOff
        ? t('plugins.database.readSetup.editingOff', 'Use a read-only login you already have, or ask an Environment manager to turn on database editing.')
        : t('plugins.database.readSetup.description', 'Choose a read-only login so you can browse this database’s tables.')}
      note={identity}
      // The host's write setup is a column of its own; the empty state's centred axis holds it, as it holds a line.
      body={writeSetup && !recovery ? <Stack align="center">{writeSetup}</Stack> : failure}
      live={notice?.kind === 'pending' ? { text: notice.text } : undefined}
      alternative={<Row gap="small" wrap justify="center">
        {editingOffWatch}
        <Button title={attachTitle} variant={editingOff ? 'primary' : 'secondary'} size="small" disabled={notice?.kind === 'pending'}
          onPress={() => openAttach()} />
        {editingOff ? null : <Action.Control action={createAction} title={createTitle} variant={writeSetupStands ? 'secondary' : 'primary'}
          disabled={notice?.kind === 'pending'}
          controller={{
            prepare: () => { setNotice(null); return { input: projectNativeJsonValueForTransport({ target, mode: 'preview' }) }; },
            onSettled: execution => settled(execution, 'review'),
          }}
          fallback={<Text tone="secondary" value={unavailable} />} />}
      </Row>} />;
  }

  const input = attaching
    ? secret && projectNativeJsonValueForTransport({ target, savedSecretRef: secret.ref, resourceRevision: secret.resourceRevision })
    : review && projectNativeJsonValueForTransport({ target, mode: 'apply', role: review.role, statements: review.statements });
  // One column: the header, the notice, the statements and the action that confirms them share the page's width.
  return <ScrollArea><Stack gap="medium">
    <PageHeader title={attaching ? attachTitle : t('plugins.database.readSetup.review', 'Review the read-only login')}
      meta={identity ? [{ key: 'database', text: identity }] : undefined}
      description={attaching
        ? t('plugins.database.readSetup.savedSecret', 'Choose the connection URL for a read-only login to {database}. If it isn’t listed, save it in Saved Secrets first.', { database: target.database })
        : t('plugins.database.readSetup.reviewDescription', 'These statements will create {role} and grant it read access to {database}.', { role: review?.role ?? '', database: target.database })} />
    {!attaching && review?.endpointTrust === 'encrypted_unverified'
      ? <Text tone="secondary" value={translateUnverifiedServerNotice(t)} />
      : null}
    {attaching
      ? <SavedSecretChoiceList testIDPrefix="database-read-access-secret" selectedRef={secret?.ref ?? null}
          onSelect={(next) => { setNotice(null); setSecret(next); }} />
      : review && <CodeBlock language="sql" wrap code={review.statements.join('\n\n')} />}
    {failure}
    {notice?.kind === 'pending' ? <Text tone="secondary" value={notice.text} /> : null}
    <Stack gap="small" align="flex-start">
      {recovery ? <Button title={attachTitle} variant="primary" onPress={() => openAttach(recovery)} />
        : input === null ? null : <Action.Control
        action={attaching ? attachAction : createAction}
        title={attaching ? t('plugins.database.readSetup.confirmAttach', 'Use this login') : createTitle}
        variant={writeSetupStands ? 'secondary' : 'primary'}
        disabled={notice?.kind === 'pending'}
        reviewedInput={input}
        controller={{ prepare: () => { setNotice(null); return { input }; }, onSettled: execution => settled(execution, 'configured') }}
        fallback={<Text tone="secondary" value={unavailable}/>} />}
      <Button title={t('plugins.database.readSetup.back', 'Back to setup options')} variant="plain"
        onPress={() => { setNotice(null); setReview(null); setAttaching(false); }} />
    </Stack>
  </Stack></ScrollArea>;
}
