import type { McpServerConfig } from '@/agent';
import { RunnerMcpMaterialV1Schema } from '@happier-dev/protocol/ephemeralRunner/runnerMcpMaterial';
import type { RunnerMcpMaterialV1 } from '@happier-dev/protocol/ephemeralRunner/runnerMcpMaterial';

import { materializeMcpServerConfigRecord } from './materializeMcpServerConfigRecord';

/** Installs creator-resolved reviewed material through the ordinary MCP materializer. */
export async function materializeRunnerMcpMaterial(input: Readonly<{
  material: RunnerMcpMaterialV1 | null;
  directory: string;
  processEnv: NodeJS.ProcessEnv;
  tmpDir: string;
}>): Promise<Record<string, McpServerConfig>> {
  if (input.material === null) return {};
  const material = RunnerMcpMaterialV1Schema.parse(input.material);
  const serversByName = Object.fromEntries(material.servers.map((server) => [server.config.name, {
    serverId: server.serverId,
    name: server.config.name,
    bindingId: server.bindingId,
    enabled: true,
    config: server.config,
  }]));
  const result = await materializeMcpServerConfigRecord({
    resolved: { directory: input.directory, strictMode: material.strictMode, serversByName },
    processEnv: input.processEnv,
    tmpDir: input.tmpDir,
    strictMode: material.strictMode,
  });
  if (result.warnings.length > 0) throw new Error('runner_mcp_materialization_incomplete');
  return result.mcpServers;
}
