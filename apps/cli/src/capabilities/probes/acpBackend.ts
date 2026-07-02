import type { AcpRuntimeDefinitionBridgeV1 } from '@/agent/acp/runtime/definition';
import { resolveAcpRuntimeDefinitionProbeLaunch } from '@/agent/acp/runtime/definition';
import type { CatalogAgentId } from '@/backends/types';
import { resolveAcpProbeTimeoutMs } from '@/capabilities/utils/acpProbeTimeout';

import { probeAcpAgentCapabilities } from './acpProbe';

export async function probeAcpRuntimeDefinitionBridgeCapabilities(params: Readonly<{
  agentId: CatalogAgentId;
  bridge: AcpRuntimeDefinitionBridgeV1;
  cwd: string;
  env?: Readonly<Record<string, string | undefined>>;
  timeoutMs?: number;
}>): Promise<Awaited<ReturnType<typeof probeAcpAgentCapabilities>>> {
  const resolved = await resolveAcpRuntimeDefinitionProbeLaunch({
    bridge: params.bridge,
    cwd: params.cwd,
    ...(params.env ? { env: params.env } : {}),
  });
  return await probeAcpAgentCapabilities({
    command: resolved.launch.command,
    args: resolved.launch.args,
    cwd: params.cwd,
    env: { ...resolved.launch.env },
    transport: resolved.transport,
    timeoutMs: params.timeoutMs ?? resolveAcpProbeTimeoutMs(
      params.agentId,
      resolved.transport.getInitTimeout(),
    ),
  });
}
