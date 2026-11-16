import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { prepareHostMcpStdioTransport, type PrepareMcpStdioTransport } from '@/mcp/runtime/supervisedStdioTransport';
import { buildScopedProcessEnv } from '@/utils/processEnv/buildScopedProcessEnv';

import type { McpServerConfig } from '@/agent';

export async function createCustomMcpClientTransport(
  config: McpServerConfig,
  processEnv: NodeJS.ProcessEnv,
  options: Readonly<{ signal?: AbortSignal; prepareTransport?: PrepareMcpStdioTransport }> = {},
): Promise<Transport> {
  options.signal?.throwIfAborted();
  const prepared = options.prepareTransport ? await options.prepareTransport(config, options.signal)
    : prepareHostMcpStdioTransport({ command: config.command, args: config.args,
      environment: buildScopedProcessEnv({ baseEnv: processEnv, explicitEnv: config.env }), signal: options.signal });
  try {
    options.signal?.throwIfAborted();
    prepared.stderr?.resume();
    return prepared.transport;
  } catch (error) {
    await prepared.transport.close();
    throw error;
  }
}
