import * as React from 'react';
import {
  DATABASE_CAPTURE_CLEAR_ACTION_ID_V1,
  DATABASE_CAPTURE_CONFIGURE_ACTION_ID_V1,
  DATABASE_CAPTURE_RESOURCE_REF_V1,
  DATABASE_CAPTURE_STATUS_ACTION_ID_V1,
  databaseActionLocalIdV1,
  type DatabaseActionIdV1,
} from '@happier-dev/database-protocol';
import {
  DatabaseCaptureClearResultV1Schema,
  DatabaseCaptureConfigureResultV1Schema,
  DatabaseCaptureStatusResultV1Schema,
  type DatabaseTargetsListInputV1,
} from '@happier-dev/plugin-sdk/database';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import { isPluginActionApprovalRequestCreated } from '@happier-dev/plugin-sdk/actions';
import { Action, Button, ErrorState, ItemGroup, Row, Stack, Text, usePluginTranslation } from '@happier-dev/plugin-ui';
import { isPluginActionConfirmationDeclined, projectPluginActionControlExecutionV1, useExecutePluginAction, usePluginSurfaceActivity } from '@happier-dev/plugin-ui/hostApi';
import type { PluginUiActionControlExecution } from '@happier-dev/plugin-sdk/ui';

const telemetryAction = (id: DatabaseActionIdV1) => ({
  pluginId: DATABASE_CAPTURE_RESOURCE_REF_V1.pluginId,
  localId: databaseActionLocalIdV1(id),
});
const statusAction = telemetryAction(DATABASE_CAPTURE_STATUS_ACTION_ID_V1);
const configureAction = telemetryAction(DATABASE_CAPTURE_CONFIGURE_ACTION_ID_V1);
const clearAction = telemetryAction(DATABASE_CAPTURE_CLEAR_ACTION_ID_V1);

export function CaptureConfiguration({ scope }: Readonly<{
  scope: Extract<DatabaseTargetsListInputV1['scope'], { kind: 'worktree' }>;
}>) {
  const t = usePluginTranslation();
  const active = usePluginSurfaceActivity().active;
  const project = { serverId: scope.workspace.serverId, machineId: scope.workspace.machineId, projectId: scope.projectKey };
  const { serverId, machineId, projectId } = project;
  const workspaceId = scope.workspace.workspaceId;
  const input = React.useMemo(() => projectNativeJsonValueForTransport({
    source: { kind: 'worktree', serverId, machineId, projectId, workspaceId },
  }), [serverId, machineId, projectId, workspaceId]);
  const { execute: readStatus, execution } = useExecutePluginAction(statusAction, input);
  const [notice, setNotice] = React.useState<Readonly<{ error: boolean; text: string }> | null>(null);
  React.useEffect(() => { if (active) void readStatus(); }, [active, readStatus]);
  const parsed = execution.status === 'success' ? DatabaseCaptureStatusResultV1Schema.safeParse(execution.result) : null;
  const status = parsed?.success && parsed.data.ok ? parsed.data : null;
  const enabled = status?.enabled;
  const unavailable = t('plugins.database.capture.unavailable', 'Capture status is unavailable.');
  const statusText = enabled === undefined ? unavailable : enabled
    ? t('plugins.database.capture.on', 'Capture is on')
    : t('plugins.database.capture.off', 'Capture is off');
  const onSettled = (kind: 'configure' | 'clear') => (result: PluginUiActionControlExecution) => {
    const settled = projectPluginActionControlExecutionV1(result, t);
    if (isPluginActionConfirmationDeclined(settled)) return;
    if (settled.status === 'success' && isPluginActionApprovalRequestCreated(settled.result)) {
      setNotice({ error: false, text: t('plugins.database.capture.pending', 'Waiting for approval.') });
      return;
    }
    if (settled.status === 'success') {
      const confirmation = (kind === 'configure' ? DatabaseCaptureConfigureResultV1Schema : DatabaseCaptureClearResultV1Schema)
        .safeParse(settled.result);
      if (confirmation.success && confirmation.data.ok) {
        setNotice(kind === 'clear' ? { error: false, text: t('plugins.database.capture.cleared', 'Capture cleared for this worktree.') } : null);
        if (active) void readStatus();
        return;
      }
    }
    setNotice({ error: true, text: 'message' in settled ? settled.message
      : t('plugins.database.capture.changeFailed', 'The capture change could not be confirmed.') });
  };
  const toggleInput = enabled === undefined ? null : projectNativeJsonValueForTransport({ project, enabled: !enabled });
  const retryInput = projectNativeJsonValueForTransport({ project, enabled: true, retry: true });
  const pending = execution.status === 'pending';
  return <ItemGroup surface="none" title={t('plugins.database.capture.title', 'Local capture')}>
    <Stack gap="small">
      <Text tone="secondary" value={pending
        ? t('plugins.database.capture.checking', 'Checking capture status…') : statusText} />
      {status?.coverage.reason ? <Text tone="secondary" value={t(
        'plugins.database.capture.incomplete', 'Capture coverage is incomplete ({reason}).',
        { reason: status.coverage.reason.replaceAll('_', ' ') },
      )} /> : null}
      {status && status.coverage.lostObservations > 0 ? <Text tone="secondary" value={t(
        'plugins.database.capture.lost', '{count} observations were missed', { count: String(status.coverage.lostObservations) },
      )} /> : null}
      {notice?.error ? <ErrorState layout="line" title={notice.text} /> : notice ? <Text tone="secondary" value={notice.text} /> : null}
      <Row gap="small" wrap>
        {toggleInput === null ? null : <Action.Control action={configureAction} variant="secondary"
          title={enabled ? t('plugins.database.capture.turnOff', 'Turn off capture') : t('plugins.database.capture.turnOn', 'Turn on capture')}
          reviewedInput={toggleInput} controller={{ prepare: () => ({ input: toggleInput }), onSettled: onSettled('configure') }} />}
        {enabled && status?.coverage.reason ? <Action.Control action={configureAction} variant="secondary"
          title={t('plugins.database.capture.retry', 'Retry capture')}
          reviewedInput={retryInput} controller={{ prepare: () => ({ input: retryInput }), onSettled: onSettled('configure') }} /> : null}
        <Button variant="plain" size="small" busy={pending}
          title={t('plugins.database.capture.status', 'Check capture status')} onPress={() => readStatus()} />
        {status ? <Action.Control action={clearAction} variant="destructive"
          title={t('plugins.database.capture.clear', 'Clear capture')}
          reviewedInput={input} controller={{ prepare: () => ({ input }), onSettled: onSettled('clear') }} /> : null}
      </Row>
    </Stack>
  </ItemGroup>;
}
