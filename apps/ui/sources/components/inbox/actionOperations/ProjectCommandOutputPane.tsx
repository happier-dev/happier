import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { joinHappierFacts } from '@happier-dev/plugin-ui/presentation';

import { WorkspaceEmbeddedTerminalPane } from '@/components/projects/panes/details/views/WorkspaceEmbeddedTerminalPane';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Modal } from '@/modal';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { useServerScopedMachine, useWorkspaceRefs } from '@/sync/store/hooks';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { t } from '@/text';
import { readActionOperationOutputAttachment, readProjectCommandOutputWorkspace } from './actionOperationDetailPresentation';
import { useProjectCommandOutputDocked } from './projectCommandOutputHost';
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
      operationStopPending?: boolean;
      title: string;
      height?: number;
      /**
       * `page`: the output is a page's own body: it hugs its output up to `height` instead of filling it.
       */
      presentation?: 'inline' | 'page';
      /** Opt in only when the caller already renders the run's exit outcome. */
      ownerStatesExit?: boolean;
      onOpenDetail?: () => void;
      /** Opens this output as its host's bottom terminal tab (desktop); preferred over the detail. */
      onOpenInTerminal?: () => void;
      /** One reviewed step's own retained terminal (a Machine Setup row), instead of the operation's latest. */
      terminalId?: string;
    }>,
  ) {
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
    const operationAttachment = readActionOperationOutputAttachment(props.operation.snapshot);
    const attachment = React.useMemo(
      () => (operationAttachment && props.terminalId ? { ...operationAttachment, terminalId: props.terminalId } : operationAttachment),
      [operationAttachment, props.terminalId],
    );
    const machine = useServerScopedMachine(
      attachment?.serverId ?? null,
      attachment?.machineId ?? '',
    );
    const workspaceRefs = useWorkspaceRefs();
    const workspace = React.useMemo(
      () =>
        attachment?.kind === 'projectCommand'
          ? readProjectCommandOutputWorkspace(attachment, workspaceRefs)
          : null,
      [attachment, workspaceRefs],
    );
    const docked = useProjectCommandOutputDocked(attachment);
    const page = props.presentation === 'page';
    // Only the web renderer reports its output's height; a native renderer has no intrinsic height, so it
    // keeps the page's full height.
    const hugsOutput = page && Platform.OS === 'web';
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
    // The host's bottom terminal already shows this PTY; the page keeps one surface for it.
    if (docked && props.onOpenInTerminal) {
      return (
        <SurfaceStateCard
          size="line"
          kind="empty"
          title={joinHappierFacts(props.title, machineName)}
          action={{ label: t('projects.scripts.output.openInTerminal'), onPress: props.onOpenInTerminal,
            testID: 'project-command-output.openInTerminal' }}
          testID="project-command-output.docked"
        />
      );
    }
    return (
      <View
        testID="project-command-output"
        style={[
          styles.pane,
          hugsOutput
            ? { maxHeight: props.height }
            : {
                height: props.height ?? 240,
              },
        ]}
      >
        <WorkspaceEmbeddedTerminalPane
          scopeId={`project-command:${attachment.serverId}:${props.operation.snapshot.operationId}${props.terminalId ? `:${props.terminalId}` : ''}`}
          workspaceRefId={attachment.kind === 'projectCommand' ? attachment.workspaceRefId : undefined}
          machineId={attachment.machineId}
          serverId={attachment.serverId}
          rootPath={attachment.kind === 'projectCommand' ? attachment.cwd : null}
          attachedTerminalId={attachment.terminalId}
          operationStopPending={props.operationStopPending}
          workspace={workspace ?? undefined}
          terminalKey={`project-command:${attachment.terminalId}`}
          title={joinHappierFacts(props.title, machineName)}
          closeOnUnmount={false}
          ownerStatesExit={props.ownerStatesExit}
          {...(page ? { sizing: hugsOutput ? 'content' as const : 'fill' as const } : {})}
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
