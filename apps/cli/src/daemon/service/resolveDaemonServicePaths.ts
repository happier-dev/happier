import { join } from 'node:path';

import {
  resolveLaunchAgentPlistPath,
  resolveSystemdUserUnitPath,
  resolveSystemdSystemUnitPath,
  resolveWindowsDaemonWrapperPath,
  resolveWindowsDaemonTaskName,
  resolveDaemonServiceLaunchdLabel,
  resolveDaemonServiceSystemdUnitName,
  resolveDaemonServiceChannelSegment,
  type DaemonServiceMode,
} from './plan';

import type { DaemonServiceCliRuntime } from './cli';

export function resolveDaemonServicePaths(
  runtime: DaemonServiceCliRuntime,
  options: Readonly<{ mode?: DaemonServiceMode }> = {},
): Readonly<{
  platform: DaemonServiceCliRuntime['platform'];
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
  const logPrefix = runtime.targetMode === 'default-following'
    ? ''
    : (() => {
      const channelSegment = resolveDaemonServiceChannelSegment(runtime.channel);
      return channelSegment ? `${channelSegment}.` : '';
    })();
  const logInstanceId = runtime.targetMode === 'default-following' ? 'default' : runtime.instanceId;
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
  return {
    platform: runtime.platform,
    label,
    unitName,
    plistPath,
    unitPath,
    wrapperPath,
    taskName,
    installedPath,
    stdoutPath: join(runtime.happierHomeDir, 'logs', `daemon-service.${logPrefix}${logInstanceId}.out.log`),
    stderrPath: join(runtime.happierHomeDir, 'logs', `daemon-service.${logPrefix}${logInstanceId}.err.log`),
  };
}
