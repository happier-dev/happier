import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { WorkspaceEmbeddedTerminalPane } from '@/components/projects/panes/details/views/WorkspaceEmbeddedTerminalPane';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Modal } from '@/modal';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { useServerScopedMachine } from '@/sync/store/hooks';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { t } from '@/text';
import { readActionOperationOutputAttachment } from './actionOperationDetailPresentation';
import { describeActionOperationStatusLabel, resolveActionOperationStatus } from './actionOperationPresentation';

/**
 * A project command's retained output: the same PTY borrowed read-only from its actual target
 * (plan 21 §8). Closing this view only unsubscribes; it never ensures, restarts or closes the process.
 * Shared by the Scripts row disclosure and the operation detail, so there is one output view.
 */
export const ProjectCommandOutputPane = React.memo(
  function ProjectCommandOutputPane(
    props: Readonly<{
      operation: ActionOperationProjection;
      title: string;
      height?: number;
      onOpenDetail?: () => void;
      /** Opens this output as its host's bottom terminal tab (desktop); preferred over the detail. */
      onOpenInTerminal?: () => void;
    }>,
  ) {
    const { theme } = useUnistyles();
    const execute = React.useMemo(() => createFrontDoorActionExecute(), []);
    const [copying, setCopying] = React.useState(false);
    const copy = async () => {
      if (copying) return;
      setCopying(true);
      try {
        // The Action re-reads custody and resolves the actual retained terminal; never copy a
        // consumer-owned output buffer or supply a terminal id that can retarget the request.
        const result = await execute('projects.execution.output.copy', {
          serverId: props.operation.serverId,
          machineId: props.operation.snapshot.scope.machineId,
          operationId: props.operation.snapshot.operationId,
          byteOffset: 0,
        }, { surface: 'ui', authority: 'present_user', serverId: props.operation.serverId,
          expectedAccountId: props.operation.snapshot.scope.accountId });
        if (!result.ok) Modal.alert(t('common.error'), result.errorCode);
        else if (ActionApprovalRequestCreatedResultSchema.safeParse(result.result).success)
          Modal.alert(t('approvals.title'), t('approvals.status.open'));
      } catch {
        Modal.alert(t('common.error'), t('errors.tryAgain'));
      } finally {
        setCopying(false);
      }
    };
    const attachment = readActionOperationOutputAttachment(props.operation.snapshot);
    const machine = useServerScopedMachine(
      attachment?.serverId ?? null,
      attachment?.machineId ?? '',
    );
    const workspace = React.useMemo(
      () =>
        attachment?.kind === 'projectCommand'
          ? {
              serverId: attachment.serverId,
              workspaceId: attachment.workspaceRefId,
              machineId: attachment.machineId,
              rootPath: attachment.cwd,
            }
          : null,
      [attachment],
    );
    if (!attachment) return null;
    if (!attachment.terminalId) {
      const status = resolveActionOperationStatus(props.operation.snapshot, props.operation.observation);
      const pending = status.tone === 'active';
      return (
        <SurfaceStateCard
          size="line"
          kind={pending ? 'loading' : status.tone === 'danger' ? 'error' : status.tone === 'success' ? 'success' : 'unavailable'}
          title={describeActionOperationStatusLabel(status.label)}
          testID={pending ? 'project-command-output.pending' : 'project-command-output.status'}
        />
      );
    }
    const machineName = machine
      ? getMachineDisplayName(machine)
      : attachment.machineId;
    return (
      <View
        testID="project-command-output"
        style={[
          styles.pane,
          {
            height: props.height ?? 240,
            backgroundColor: theme.colors.surface.base,
          },
        ]}
      >
        <WorkspaceEmbeddedTerminalPane
          scopeId={`project-command:${attachment.serverId}:${props.operation.snapshot.operationId}`}
          workspaceRefId={attachment.kind === 'projectCommand' ? attachment.workspaceRefId : undefined}
          machineId={attachment.machineId}
          serverId={attachment.serverId}
          rootPath={attachment.kind === 'projectCommand' ? attachment.cwd : null}
          attachedTerminalId={attachment.terminalId}
          workspace={workspace ?? undefined}
          terminalKey={`project-command:${attachment.terminalId}`}
          title={`${props.title} · ${machineName}`}
          closeOnUnmount={false}
          toolbarActionsStart={
            <>
            {attachment.kind === 'projectCommand' ? (
              <IconButton
                testID="project-command-output.copy"
                iconName="copy"
                variant="plain"
                accessibilityLabel={t('common.copy')}
                tooltip={t('common.copy')}
                disabled={copying}
                onPress={() => { void copy(); }}
              />
            ) : null}
            {props.onOpenInTerminal ? (
              <IconButton
                testID="project-command-output.openInTerminal"
                iconName="terminal"
                variant="plain"
                accessibilityLabel={t('projects.scripts.output.openInTerminal')}
                tooltip={t('projects.scripts.output.openInTerminal')}
                onPress={props.onOpenInTerminal}
              />
            ) : props.onOpenDetail ? (
              <IconButton
                testID="project-command-output.detail"
                iconName="arrows-out"
                variant="plain"
                accessibilityLabel={t('inbox.actionOperations.details')}
                tooltip={t('inbox.actionOperations.details')}
                onPress={props.onOpenDetail}
              />
            ) : null}
            </>
          }
        />
      </View>
    );
  },
);

const styles = StyleSheet.create(() => ({
  pane: { minHeight: 0, overflow: 'hidden' },
}));
