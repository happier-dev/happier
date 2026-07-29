import { join } from 'node:path';

import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import {
  resolveDaemonServiceChannelSegment,
  resolveDaemonServiceLaunchdLabel,
  resolveDaemonServiceSystemdUnitName,
  resolveLaunchAgentPlistPath,
  resolveSystemdSystemUnitPath,
  resolveSystemdUserUnitPath,
  resolveWindowsDaemonServiceLogPaths,
  resolveWindowsDaemonTaskName,
  resolveWindowsDaemonWrapperPath,
  type DaemonServiceMode,
  type DaemonServiceTargetMode,
} from './plan';

export type SupportedPlatform = 'darwin' | 'linux' | 'win32';

export type DaemonServiceCliRuntime = Readonly<{
  platform: SupportedPlatform;
  channel: PublicReleaseRingId;
  targetMode: DaemonServiceTargetMode;
  instanceId: string;
  activeServerId: string;
  uid: number | null;
  userHomeDir: string;
  happierHomeDir: string;
  serverUrl: string;
  webappUrl: string;
  publicServerUrl: string;
  nodePath: string;
  entryPath: string;
}>;

export type DaemonServiceInstallationSnapshot = Readonly<{
  platform: SupportedPlatform;
  installed: boolean;
  installedPath: string;
  label: string;
}>;

export type DaemonServiceListEntry = Readonly<{
  serverId: string;
  name: string;
  relayUrl?: string | null;
  installed: boolean;
  path: string;
  platform: SupportedPlatform;
  mode?: DaemonServiceMode;
  happierHomeDir?: string | null;
  releaseChannel: PublicReleaseRingId;
  label: string;
  targetMode: DaemonServiceTargetMode;
  installedDefinitionMatchesExpected?: boolean;
}>;

export type DaemonServiceInventoryEntry = Readonly<{
  serviceType: 'daemon';
  platform: SupportedPlatform;
  serverId: string;
  name: string;
  relayUrl?: string | null;
  path: string;
  mode?: DaemonServiceMode;
  label: string;
  ring: PublicReleaseRingId;
  targetMode: DaemonServiceTargetMode;
  installed: boolean;
  running: boolean;
  configuredCliVersion: string | null;
  runningCliVersion: string | null;
}>;

export function resolveDaemonServicePaths(
  runtime: DaemonServiceCliRuntime,
  options: Readonly<{ mode?: DaemonServiceMode }> = {},
): Readonly<{
  platform: SupportedPlatform;
  label: string;
  unitName: string;
  plistPath: string;
  unitPath: string;
  wrapperPath: string;
  taskName: string;
  installedPath: string;
  stdoutPath: string;
  stderrPath: string;
}> {
  const mode: DaemonServiceMode = options.mode === 'system' ? 'system' : 'user';
  const label = resolveDaemonServiceLaunchdLabel(runtime.instanceId, runtime.channel, runtime.targetMode);
  const unitName = resolveDaemonServiceSystemdUnitName(runtime.instanceId, runtime.channel, runtime.targetMode);
  const plistPath = resolveLaunchAgentPlistPath({
    userHomeDir: runtime.userHomeDir,
    instanceId: runtime.instanceId,
    channel: runtime.channel,
    targetMode: runtime.targetMode,
  });
  const unitPath =
    runtime.platform === 'linux' && mode === 'system'
      ? resolveSystemdSystemUnitPath({ instanceId: runtime.instanceId, channel: runtime.channel, targetMode: runtime.targetMode })
      : resolveSystemdUserUnitPath({
          userHomeDir: runtime.userHomeDir,
          instanceId: runtime.instanceId,
          channel: runtime.channel,
          targetMode: runtime.targetMode,
        });
  const wrapperPath = runtime.platform === 'win32'
    ? resolveWindowsDaemonWrapperPath({
        happierHomeDir: runtime.happierHomeDir,
        instanceId: runtime.instanceId,
        channel: runtime.channel,
        targetMode: runtime.targetMode,
      })
    : '';
  const taskName = runtime.platform === 'win32'
    ? resolveWindowsDaemonTaskName({ instanceId: runtime.instanceId, channel: runtime.channel, targetMode: runtime.targetMode })
    : '';
  const installedPath = runtime.platform === 'darwin'
    ? plistPath
    : runtime.platform === 'linux'
      ? unitPath
      : wrapperPath;
  const logPaths = runtime.platform === 'win32'
    ? resolveWindowsDaemonServiceLogPaths({
        happierHomeDir: runtime.happierHomeDir,
        instanceId: runtime.instanceId,
        channel: runtime.channel,
        targetMode: runtime.targetMode,
      })
    : (() => {
        const logPrefix = runtime.targetMode === 'default-following'
          ? ''
          : (() => {
              const channelSegment = resolveDaemonServiceChannelSegment(runtime.channel);
              return channelSegment ? `${channelSegment}.` : '';
            })();
        const logInstanceId = runtime.targetMode === 'default-following' ? 'default' : runtime.instanceId;
        return {
          stdoutPath: join(runtime.happierHomeDir, 'logs', `daemon-service.${logPrefix}${logInstanceId}.out.log`),
          stderrPath: join(runtime.happierHomeDir, 'logs', `daemon-service.${logPrefix}${logInstanceId}.err.log`),
        };
      })();
  return {
    platform: runtime.platform,
    label,
    unitName,
    plistPath,
    unitPath,
    wrapperPath,
    taskName,
    installedPath,
    stdoutPath: logPaths.stdoutPath,
    stderrPath: logPaths.stderrPath,
  };
}
