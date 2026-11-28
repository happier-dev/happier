import { getBuiltInAcpConfig } from '@happier-dev/agents';
import { runCommandCapture } from '@happier-dev/cli-common/process';

import { resolveAcpCatalogTransportHandler } from '@/agent/acp/catalog/transport/resolveAcpCatalogTransportHandler';
import type { DaemonSpawnHooks } from '@/daemon/spawnHooks';
import { buildMissingProviderCliCommandErrorMessage } from '@/runtime/managedTools/requireProviderCliCommand';
import { resolveProviderCliLaunchSpec } from '@/runtime/managedTools/requireProviderCliLaunchSpec';

export const agyDaemonSpawnHooks: DaemonSpawnHooks = {
  validateSpawn: async ({ directory, environmentVariables }) => {
    const env = { ...process.env, ...environmentVariables };
    const launch = resolveProviderCliLaunchSpec('agy', { processEnv: env });
    if (!launch) {
      return { ok: false, errorMessage: buildMissingProviderCliCommandErrorMessage('agy', { processEnv: env }) };
    }
    const config = getBuiltInAcpConfig('agy');
    if (!config) throw new Error('Missing built-in Antigravity ACP configuration');
    const probe = await runCommandCapture({
      cmd: launch.command,
      args: [...launch.args, ...config.launcher.args, '--help'],
      cwd: directory,
      env,
      timeoutMs: resolveAcpCatalogTransportHandler(config.transportProfile, 'agy').getInitTimeout(),
    });
    if (probe.kind === 'exited' && probe.status === 0) {
      // Some installations print help to stderr. Generic top-level help is not ACP support.
      if (/^Usage:\s+agy\s+acp(?:\s|$)/mi.test(probe.stdout + '\n' + probe.stderr)) return { ok: true };
    }
    return {
      ok: false,
      reasonCode: 'agy_native_acp_unavailable',
      errorMessage: 'The installed Antigravity CLI could not run agy acp --help. Use Antigravity CLI 1.5.0 or newer (agy update).',
    };
  },
};
