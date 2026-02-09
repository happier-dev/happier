import type { Capability } from '@/capabilities/service';
import { buildCliCapabilityData } from '@/capabilities/probes/cliBase';
import { probeAcpAgentCapabilities } from '@/capabilities/probes/acpProbe';
import { buildAcpCapabilitySnapshot } from '@/capabilities/probes/acpCapabilitySnapshot';
import { resolveAcpProbeTimeoutMs } from '@/capabilities/utils/acpProbeTimeout';
import { qwenTransport } from '@/backends/qwen/acp/transport';

export const cliCapability: Capability = {
  descriptor: { id: 'cli.qwen', kind: 'cli', title: 'Qwen Code CLI' },
  detect: async ({ request, context }) => {
    const entry = context.cliSnapshot?.clis?.qwen;
    const base = buildCliCapabilityData({ request, entry });

    const includeAcpCapabilities = Boolean((request.params ?? {}).includeAcpCapabilities);
    if (!includeAcpCapabilities || base.available !== true || !base.resolvedPath) {
      return base;
    }

    const probe = await probeAcpAgentCapabilities({
      command: base.resolvedPath,
      args: ['--acp'],
      cwd: process.cwd(),
      env: {
        // Keep output clean to avoid ACP stdout pollution.
        NODE_ENV: 'production',
        DEBUG: '',
      },
      transport: qwenTransport,
      timeoutMs: resolveAcpProbeTimeoutMs('qwen'),
    });

    const acp = buildAcpCapabilitySnapshot(probe);

    return { ...base, acp };
  },
};
