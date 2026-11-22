import { ensureAgyAcpServerForLaunch } from '@/backends/agy/acp/ensureAgyAcpServerForLaunch';
import { resolveAgyAcpRuntime } from '@/backends/agy/acp/pinnedAgyAcpServer';
import type { DaemonSpawnHooks } from '@/daemon/spawnHooks';
import { validateProviderCliSpawn } from '@/runtime/managedTools/validateProviderCliSpawn';

export const agyDaemonSpawnHooks: DaemonSpawnHooks = {
  validateSpawn: async ({ directory, vendorResumeId, environmentVariables, readinessOnly }) => {
    const runtime = await resolveAgyAcpRuntime({ cwd: directory, vendorResumeId, env: environmentVariables });
    if (runtime === 'native') {
      return await validateProviderCliSpawn({ agentId: 'agy', processEnv: environmentVariables });
    }
    try {
      await ensureAgyAcpServerForLaunch({ env: environmentVariables, ...(readinessOnly ? { readinessOnly: true } : {}) });
    } catch (error) {
      return {
        ok: false,
        reasonCode: 'agy_acp_server_unavailable',
        errorMessage:
          error instanceof Error
            ? error.message
            : 'Agy ACP server is not available. Select Agy again to install the pinned server.',
      };
    }
    return { ok: true };
  },
};
