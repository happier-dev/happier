import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { ToolCall } from '@happier-dev/session-core/messages';

import {
  formatRunClock,
  presentProjectRun,
} from '@/components/projects/projectSetup/projectScriptPresentation';
import {
  readTranscriptProjectCommandAcceptance,
  type TranscriptProjectCommandCall,
} from '@/components/sessions/transcript/references/transcriptProjectCommandReference';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Text } from '@/components/ui/text/Text';
import { useElapsedTime } from '@/hooks/ui/useElapsedTime';
import { isActionOperationTerminal } from '@/sync/domains/actionOperations/actionOperationStore';
import { useActionOperation } from '@/sync/domains/actionOperations/useActionOperations';
import { useServerScopedMachine } from '@/sync/store/hooks';
import { t } from '@/text';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';

import { ToolTimelineRowHeader } from './ToolTimelineRowHeader';

type HeaderProps = React.ComponentProps<typeof ToolTimelineRowHeader>;

/**
 * One line per agent call of a finite Project command (lab `s-agent` CARD): "Ran happier project script
 * run test · Accepted · hz-build-1", then the existing `wait` as "Waiting for test · on hz-build-1" with the
 * run's clock. Status comes from the one qualified operation every other surface reads; the recorded tool
 * text is never parsed. Mounted only for rows that are such a call, so ordinary tool rows subscribe to nothing.
 */
export const ProjectCommandToolTimelineRowHeader = React.memo(
  function ProjectCommandToolTimelineRowHeader(
    props: Readonly<{
      header: HeaderProps;
      call: TranscriptProjectCommandCall;
      tool: Pick<ToolCall, 'name' | 'input' | 'state' | 'result'>;
      serverId: string | null | undefined;
    }>,
  ) {
    const { call, tool } = props;
    const acceptance = React.useMemo(
      () =>
        call.kind === 'start'
          ? readTranscriptProjectCommandAcceptance(tool)
          : null,
      [call.kind, tool],
    );
    const operationId =
      call.kind === 'wait'
        ? call.operationId
        : (acceptance?.operationId ?? null);
    const live = useActionOperation({
      serverId: operationId ? (props.serverId ?? null) : null,
      operationId: operationId ?? '',
    });
    const snapshot = live?.snapshot ?? acceptance;
    const attachment =
      snapshot?.domainRef?.kind === 'projectCommand'
        ? snapshot.domainRef
        : null;
    // The actual target this run was admitted to, never the Session's own Machine.
    const machine = useServerScopedMachine(
      attachment?.serverId ?? null,
      attachment?.machineId ?? '',
    );
    const machineName = attachment
      ? machine
        ? getMachineDisplayName(machine)
        : attachment.machineId
      : null;
    const name = attachment?.script?.name ?? snapshot?.title ?? null;

    const title =
      call.kind === 'start'
        ? t('projects.scripts.agentRan', {
            command: describeProjectCommandInvocation(call),
          })
        : name
          ? tool.state === 'running'
            ? t('projects.scripts.agentWaitingFor', { name })
            : t('projects.scripts.agentWaitedFor', { name })
          : props.header.title;
    const subtitle = !snapshot
      ? (props.header.subtitle ?? null)
      : call.kind === 'wait'
        ? machineName
          ? t('projects.scripts.agentOn', { machine: machineName })
          : null
        : !live ||
            (live.snapshot.state === 'accepted' &&
              !live.snapshot.setupReview &&
              !live.snapshot.observation)
          ? [t('projects.scripts.agentAccepted'), machineName]
              .filter(Boolean)
              .join(' · ')
          : presentProjectRun(live, machineName, '').text;
    // Duration needs an observed terminal (plan 21): accepted/queued runs show no clock.
    const startedAt =
      live &&
      !isActionOperationTerminal(live.snapshot.state) &&
      attachment?.terminalId
        ? (live.snapshot.startedAt ?? null)
        : null;
    const rightElement =
      call.kind === 'wait' &&
      live &&
      !isActionOperationTerminal(live.snapshot.state) ? (
        <LiveRunAccessory startedAt={startedAt} />
      ) : (
        props.header.rightElement
      );
    return (
      <ToolTimelineRowHeader
        {...props.header}
        title={title}
        subtitle={subtitle}
        rightElement={rightElement}
      />
    );
  },
);

/** The run's ticking clock and spinner, in its own leaf so only it re-renders every second. */
function LiveRunAccessory(props: Readonly<{ startedAt: number | null }>) {
  const { theme } = useUnistyles();
  return (
    <View style={styles.accessory} testID="project-command-tool.live">
      {props.startedAt !== null ? (
        <RunClock startedAt={props.startedAt} />
      ) : null}
      <ActivitySpinner size="small" color={theme.colors.text.secondary} />
    </View>
  );
}

function RunClock(props: Readonly<{ startedAt: number }>) {
  const { theme } = useUnistyles();
  const seconds = useElapsedTime(props.startedAt);
  return (
    <Text style={[styles.clock, { color: theme.colors.text.tertiary }]}>
      {formatRunClock(seconds)}
    </Text>
  );
}

/** The call as its CLI projection reads (`happier project script run test`), from the spec's canonical path. */
function describeProjectCommandInvocation(
  call: Extract<TranscriptProjectCommandCall, { kind: 'start' }>,
): string {
  const path = getActionSpec(call.actionId).cli?.commands?.[0]?.path ?? [];
  const head = ['happier', ...path].join(' ');
  const input =
    call.input && typeof call.input === 'object'
      ? (call.input as Record<string, unknown>)
      : {};
  if (call.actionId === 'projects.script.run') {
    const selection =
      input.selection && typeof input.selection === 'object'
        ? (input.selection as Record<string, unknown>)
        : null;
    const source =
      selection?.source && typeof selection.source === 'object'
        ? (selection.source as Record<string, unknown>)
        : null;
    const target =
      typeof selection?.name === 'string'
        ? selection.name
        : source &&
            typeof source.file === 'string' &&
            typeof source.target === 'string'
          ? `${source.file}#${source.target}`
          : null;
    return target ? `${head} ${target}` : head;
  }
  if (call.actionId === 'projects.compute.exec') {
    const argv = [
      input.executable,
      ...(Array.isArray(input.argv) ? input.argv : []),
    ].filter((part): part is string => typeof part === 'string');
    return argv.length > 0 ? `${head} -- ${argv.join(' ')}` : head;
  }
  return head;
}

const styles = StyleSheet.create(() => ({
  accessory: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  clock: { fontSize: 12, fontVariant: ['tabular-nums'] },
}));
