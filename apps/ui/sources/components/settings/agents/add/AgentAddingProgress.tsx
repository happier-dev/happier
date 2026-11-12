import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { formatHappierDataBytes } from '@happier-dev/plugin-ui/presentation';

import type { MachineAgentJob } from '@/agents/machineAgents/machineAgentTypes';
import { useAgentInstallJob } from '@/agents/machineAgents/installJobs/useAgentInstallJob';
import { AgentInstallJobRpcError } from '@/agents/machineAgents/installJobs/api';
import { presentAgentInstallJobFailure, presentAgentInstallJobRpcFailure } from '@/agents/machineAgents/installJobs/presentAgentInstallJobFailure';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { MeterBar } from '@/components/ui/lists/MeterBar';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import type { AgentAddMachine } from './agentAddRows';

/** One machine's install, in the words the Adding details use (lab aa X, F4). */
export type AgentInstallProgress =
  | Readonly<{ phase: 'waiting' }>
  | Readonly<{
      phase: 'downloading';
      bytesDone: number | null;
      bytesTotal: number | null;
    }>
  | Readonly<{ phase: 'checking' }>
  | Readonly<{ phase: 'installed' }>
  | Readonly<{ phase: 'failed'; message: string }>
  | Readonly<{ phase: 'cancelled' }>
  | Readonly<{ phase: 'offline' }>
  | Readonly<{ phase: 'firstUse' }>;

/**
 * The job owner's state for one machine as a phase. A machine that was not asked to install now reads "installs on
 * first use" (offline when it is away); a machine asked now waits until its job appears, then follows its steps.
 */
export function presentAgentInstallProgress(
  input: Readonly<{
    job: MachineAgentJob | null;
    installingNow: boolean;
    offline: boolean;
  }>,
): AgentInstallProgress {
  const { job } = input;
  if (job?.outcome?.kind === 'succeeded') return { phase: 'installed' };
  if (job?.outcome?.kind === 'failed') {
    return job.outcome.code === 'cancelled'
      ? { phase: 'cancelled' }
      : { phase: 'failed', message: presentAgentInstallJobFailure(job.outcome).body };
  }
  if (job?.readFailure) return { phase: 'failed', message: presentAgentInstallJobRpcFailure(new AgentInstallJobRpcError(job.readFailure)).body };
  if (!job) {
    if (input.offline) return { phase: 'offline' };
    return input.installingNow ? { phase: 'waiting' } : { phase: 'firstUse' };
  }
  const running = job.steps.find((step) => step.state === 'running') ?? null;
  if (running && (running.bytesTotal !== null || running.bytesDone !== null)) {
    return {
      phase: 'downloading',
      bytesDone: running.bytesDone,
      bytesTotal: running.bytesTotal,
    };
  }
  // Past the download, the daemon starts the agent once to check it before it calls it installed.
  const downloaded = job.steps.some(
    (step) => step.state === 'done' && step.bytesTotal !== null,
  );
  return downloaded
    ? { phase: 'checking' }
    : { phase: 'downloading', bytesDone: null, bytesTotal: null };
}

/**
 * "Installing": one row per machine with its live install (lab aa X). Every row keeps its place while its status
 * word changes, so the section never reflows under the person.
 */
export function AgentAddingProgress(
  props: Readonly<{
    name: string;
    definitionId: string;
    serverId: string | null;
    machines: readonly AgentAddMachine[];
    /** The machines the add asked to install now (online ones, Install: Now). */
    installOn: readonly string[];
    failures?: readonly Readonly<{ machineId: string; errorCode: string }>[];
    onRetryInstall: (machineId: string) => Promise<void>;
    testID: string;
  }>,
): React.ReactElement {
  const failures = new Map(props.failures?.map(failure => [failure.machineId, failure]));
  return (
    <AgentAddingFrame name={props.name} testID={props.testID}>
      {props.machines.map((machine) => (
        <AgentInstallProgressRow
          key={machine.machineId}
          machine={machine}
          definitionId={props.definitionId}
          serverId={props.serverId}
          installingNow={props.installOn.includes(machine.machineId)}
          failure={failures.get(machine.machineId)}
          onRetryInstall={props.onRetryInstall}
          testID={`${props.testID}.machine.${machine.machineId}`}
        />
      ))}
    </AgentAddingFrame>
  );
}

/** The Adding body around its machine rows: the "is in your agents" line, then the Installing section. */
export function AgentAddingFrame(
  props: Readonly<{ name: string; testID: string; children: React.ReactNode }>,
): React.ReactElement {
  const { theme } = useUnistyles();
  return (
    <View style={styles.root}>
      <View style={styles.callout} testID={`${props.testID}.added`}>
        <Icon
          name="check-circle"
          size={ICON_SIZE.sm}
          color={theme.colors.state.success.foreground}
        />
        <Text variant="reading" style={styles.calloutText}>
          <Text variant="reading" emphasis="semiBold">
            {t('capabilities.agentAdd.adding.inYourAgents', {
              name: props.name,
            })}
          </Text>
          {` ${t('capabilities.agentAdd.adding.inYourAgentsBody')}`}
        </Text>
      </View>
      <ItemGroup
        title={t('capabilities.agentAdd.adding.title')}
        description={t('capabilities.agentAdd.adding.body')}
      >
        {props.children}
      </ItemGroup>
    </View>
  );
}

function AgentInstallProgressRow(
  props: Readonly<{
    machine: AgentAddMachine;
    definitionId: string;
    serverId: string | null;
    installingNow: boolean;
    failure?: Readonly<{ machineId: string; errorCode: string }>;
    onRetryInstall: (machineId: string) => Promise<void>;
    testID: string;
  }>,
): React.ReactElement {
  const { job, cancel, refresh } = useAgentInstallJob({
    serverId: props.serverId ?? '',
    machineId: props.machine.machineId,
    agentId: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1.localId,
    definitionId: props.definitionId,
  });
  const [retrying, setRetrying] = React.useState(false);
  const [retryFailure, setRetryFailure] = React.useState<string | null>(null);
  const progress: AgentInstallProgress = retryFailure ? { phase: 'failed', message: retryFailure } : props.failure ? {
    phase: 'failed',
    message: presentAgentInstallJobRpcFailure(new AgentInstallJobRpcError(props.failure.errorCode)).body,
  } : presentAgentInstallProgress({
    job,
    installingNow: props.installingNow,
    offline: props.machine.offline,
  });
  return (
    <AgentInstallProgressItem
      machine={props.machine}
      progress={progress}
      retrying={retrying}
      onRetry={() => {
        if (retrying) return;
        setRetrying(true);
        setRetryFailure(null);
        void (async () => {
          try {
            if (job?.readFailure) await refresh();
            else await props.onRetryInstall(props.machine.machineId);
          } catch (error) {
            setRetryFailure(presentAgentInstallJobRpcFailure(error).body);
          }
          finally { setRetrying(false); }
        })();
      }}
      onCancel={() => {
        void cancel().catch(() => undefined);
      }}
      testID={props.testID}
    />
  );
}

/** One machine's row: name and system, what is happening there, and the one thing to do about it. */
export function AgentInstallProgressItem(
  props: Readonly<{
    machine: AgentAddMachine;
    progress: AgentInstallProgress;
    retrying?: boolean;
    onRetry: () => void;
    onCancel: () => void;
    testID: string;
  }>,
): React.ReactElement {
  const { theme } = useUnistyles();
  const { progress } = props;
  const quiet = { color: theme.colors.text.secondary };
  const status = (icon: React.ReactNode, label: string) => (
    <View style={styles.status} testID={`${props.testID}.status`}>
      {icon}
      <Text variant="meta" style={quiet}>
        {label}
      </Text>
    </View>
  );
  const spinner = (
    <ActivitySpinner size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
  );
  let subtitle: React.ReactNode = null;
  let right: React.ReactNode = null;
  switch (progress.phase) {
    case 'waiting':
      right = status(spinner, t('capabilities.agentAdd.adding.waiting'));
      subtitle = t('capabilities.agentAdd.adding.thenChecks');
      break;
    case 'downloading': {
      const fraction =
        progress.bytesDone !== null && progress.bytesTotal
          ? progress.bytesDone / progress.bytesTotal
          : 0;
      right = (
        <View style={styles.status}>
          {status(spinner, t('capabilities.agentAdd.adding.downloading'))}
          <RoundButton
            size="small"
            display="secondary"
            title={t('capabilities.agentAdd.adding.cancel')}
            onPress={props.onCancel}
            testID={`${props.testID}.cancel`}
          />
        </View>
      );
      subtitle = (
        <View style={styles.progress}>
          <View style={styles.meterRow}>
            <MeterBar
              tone="neutral"
              fillFraction={fraction}
              fillColor={theme.colors.text.primary}
              height={4}
              progressAccessibilityLabel={t(
                'capabilities.agentAdd.adding.downloading',
              )}
              style={styles.meter}
            />
            {progress.bytesDone !== null && progress.bytesTotal ? (
              <Text variant="meta" style={[quiet, styles.bytes]}>
                {t('capabilities.agentAdd.adding.bytes', {
                  done: formatHappierDataBytes(progress.bytesDone, {
                    kind: 'storage',
                  }),
                  total: formatHappierDataBytes(progress.bytesTotal, {
                    kind: 'storage',
                  }),
                })}
              </Text>
            ) : null}
          </View>
          <Text variant="meta" style={quiet}>
            {t('capabilities.agentAdd.adding.thenChecks')}
          </Text>
        </View>
      );
      break;
    }
    case 'checking':
      right = status(spinner, t('capabilities.agentAdd.adding.checking'));
      break;
    case 'installed':
      right = status(
        <Icon
          name="check-circle"
          size={ICON_SIZE.xs}
          color={theme.colors.state.success.foreground}
        />,
        t('capabilities.agentAdd.adding.installed'),
      );
      subtitle = t('capabilities.agentAdd.adding.installedBody');
      break;
    case 'failed':
      right = (
        <RoundButton
          size="small"
          display="secondary"
          title={t('capabilities.agentAdd.adding.tryAgain')}
          onPress={props.onRetry}
          testID={`${props.testID}.retry`}
          loading={props.retrying}
          disabled={props.retrying}
        />
      );
      subtitle = (
        <Text
          variant="meta"
          style={{ color: theme.colors.status.error }}
          numberOfLines={2}
        >
          {`${t('capabilities.agentAdd.adding.failed')} · ${progress.message}`}
        </Text>
      );
      break;
    case 'cancelled':
      right = (
        <RoundButton
          size="small"
          display="secondary"
          title={t('capabilities.agentAdd.adding.install')}
          onPress={props.onRetry}
          testID={`${props.testID}.retry`}
          loading={props.retrying}
          disabled={props.retrying}
        />
      );
      subtitle = t('capabilities.agentAdd.adding.cancelled');
      break;
    case 'offline':
      right = status(
        <Icon
          name="clock"
          size={ICON_SIZE.xs}
          color={theme.colors.text.secondary}
        />,
        t('capabilities.agentAdd.adding.offline'),
      );
      subtitle = t('capabilities.agentAdd.adding.offlineBody');
      break;
    case 'firstUse':
      right = status(null, t('capabilities.agentAdd.adding.firstUse'));
      subtitle = t('capabilities.agentAdd.adding.firstUseBody');
      break;
  }
  return (
    <Item
      testID={props.testID}
      title={props.machine.name}
      titleQualifier={formatMachineOs(props.machine.platform)}
      titleStyle={props.machine.offline ? quiet : undefined}
      subtitle={subtitle ?? undefined}
      icon={
        <Icon
          name={machineGlyph(props.machine.platform)}
          size={20}
          color={theme.colors.text.secondary}
        />
      }
      rightElement={right}
      accessoryLayout="adaptive"
      showChevron={false}
    />
  );
}

export function formatMachineOs(platform: string | null): string | null {
  if (platform === 'darwin' || platform === 'macos') return 'macOS';
  if (platform === 'linux') return 'Linux';
  if (platform === 'win32' || platform === 'windows') return 'Windows';
  return null;
}

export function machineGlyph(platform: string | null) {
  return platform === 'linux'
    ? ('hard-drives' as const)
    : platform === 'win32'
      ? ('desktop' as const)
      : ('laptop' as const);
}

const styles = StyleSheet.create((theme) => ({
  root: { gap: theme.space.s24 },
  callout: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.space.s8,
  },
  calloutText: { flex: 1, minWidth: 0, color: theme.colors.text.secondary },
  status: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
  progress: { gap: theme.space.s4, paddingTop: theme.space.s4 },
  meterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s12,
  },
  meter: { flex: 1, maxWidth: 360 },
  bytes: { fontVariant: ['tabular-nums'] },
}));
