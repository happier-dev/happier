import type { TransportHandler } from '@/agent/transport';
import type { AcpRuntimeDefinitionBridgeV1 } from '@/agent/acp/runtime/definition';
import type { CatalogAgentId } from '@/backends/types';
import { resolveAcpProbeTimeoutMs } from '@/capabilities/utils/acpProbeTimeout';
import { buildAcpCapabilitySnapshot } from '@/capabilities/probes/acpCapabilitySnapshot';
import { buildCliCapabilityData } from '@/capabilities/probes/cliBase';
import { probeAcpAgentCapabilities } from '@/capabilities/probes/acpProbe';
import { probeAcpRuntimeDefinitionBridgeCapabilities } from '@/capabilities/probes/acpBackend';
import type { Capability } from '@/capabilities/service';
import { requireProviderCliLaunchSpec } from '@/packagedRuntime/managedTools/requireProviderCliLaunchSpec';

function resolveAcpProbeLaunch(agentId: CatalogAgentId, resolvedPath: string): Readonly<{
  command: string;
  args: readonly string[];
}> {
  try {
    const launch = requireProviderCliLaunchSpec(agentId, { processEnv: process.env });
    if (launch.resolvedPath === resolvedPath) {
      return {
        command: launch.command,
        args: launch.args,
      };
    }
  } catch {
    // Fallback to the detected CLI path when the managed launch spec is unavailable.
  }

  return {
    command: resolvedPath,
    args: [],
  };
}

export function createAcpCliCapability(params: {
  agentId: CatalogAgentId;
  title: string;
  acpArgs?: string[];
  transport?: TransportHandler;
  runtimeDefinitionBridge?: AcpRuntimeDefinitionBridgeV1;
  resolveAcpProbeEnv?: (params: Readonly<{ defaultEnv: NodeJS.ProcessEnv }>) => NodeJS.ProcessEnv;
}): Capability {
  return {
    descriptor: { id: `cli.${params.agentId}`, kind: 'cli', title: params.title },
    detect: async ({ request, context }) => {
      const entry = context.cliSnapshot?.clis?.[params.agentId];
      const base = buildCliCapabilityData({ request, entry });

      const includeAcpCapabilities = Boolean((request.params ?? {}).includeAcpCapabilities);
      if (!includeAcpCapabilities) {
        return base;
      }

      const defaultEnv: NodeJS.ProcessEnv = {
        // Keep output clean to avoid ACP stdout pollution.
        NODE_ENV: 'production',
        DEBUG: '',
      };
      const env = params.resolveAcpProbeEnv?.({ defaultEnv }) ?? defaultEnv;

      if (params.runtimeDefinitionBridge) {
        const probe = await probeAcpRuntimeDefinitionBridgeCapabilities({
          agentId: params.agentId,
          bridge: params.runtimeDefinitionBridge,
          cwd: process.cwd(),
          env,
        });

        const acp = buildAcpCapabilitySnapshot(probe);
        return { ...base, acp };
      }

      if (base.available !== true || !base.resolvedPath || !params.transport || !params.acpArgs) {
        return base;
      }

      const launch = resolveAcpProbeLaunch(params.agentId, base.resolvedPath);

      const probe = await probeAcpAgentCapabilities({
        command: launch.command,
        args: [...launch.args, ...params.acpArgs],
        cwd: process.cwd(),
        env,
        transport: params.transport,
        timeoutMs: resolveAcpProbeTimeoutMs(params.agentId, params.transport.getInitTimeout()),
      });

      const acp = buildAcpCapabilitySnapshot(probe);
      return { ...base, acp };
    },
  };
}
