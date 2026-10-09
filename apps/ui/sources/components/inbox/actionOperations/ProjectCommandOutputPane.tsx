import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { WorkspaceEmbeddedTerminalPane } from '@/components/projects/panes/details/views/WorkspaceEmbeddedTerminalPane';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
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
            props.onOpenInTerminal ? (
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
            ) : undefined
          }
        />
      </View>
    );
  },
);

const styles = StyleSheet.create(() => ({
  pane: { minHeight: 0, overflow: 'hidden' },
}));
