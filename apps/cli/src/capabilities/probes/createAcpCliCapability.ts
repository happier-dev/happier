import type { TransportHandler } from '@/agent/transport';
import type { CatalogAgentId } from '@/backends/types';
import { resolveAcpProbeTimeoutMs } from '@/capabilities/utils/acpProbeTimeout';
import { buildAcpCapabilitySnapshot } from '@/capabilities/probes/acpCapabilitySnapshot';
import { buildCliCapabilityData } from '@/capabilities/probes/cliBase';
import { probeAcpAgentCapabilities } from '@/capabilities/probes/acpProbe';
import type { Capability } from '@/capabilities/service';

export function createAcpCliCapability(params: {
  agentId: CatalogAgentId;
  title: string;
  acpArgs: string[];
  transport: TransportHandler;
}): Capability {
  return {
    descriptor: { id: `cli.${params.agentId}`, kind: 'cli', title: params.title },
    detect: async ({ request, context }) => {
      const entry = context.cliSnapshot?.clis?.[params.agentId];
      const base = buildCliCapabilityData({ request, entry });

      const includeAcpCapabilities = Boolean((request.params ?? {}).includeAcpCapabilities);
      if (!includeAcpCapabilities || base.available !== true || !base.resolvedPath) {
        return base;
      }

      const probe = await probeAcpAgentCapabilities({
        command: base.resolvedPath,
        args: params.acpArgs,
        cwd: process.cwd(),
        env: {
          // Keep output clean to avoid ACP stdout pollution.
          NODE_ENV: 'production',
          DEBUG: '',
        },
        transport: params.transport,
        timeoutMs: resolveAcpProbeTimeoutMs(params.agentId),
      });

      const acp = buildAcpCapabilitySnapshot(probe);
      return { ...base, acp };
    },
  };
}
