import { randomUUID } from 'node:crypto';
import { PluginError } from '@happier-dev/plugin-sdk';
import type { PluginMcpPort } from '@/mcp/runtime/pluginMcpPort';
import { parseMcpPluginItemIdV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';
import { RunnerPluginMcpResultSchema, type RunnerPluginMcpOperation } from './runnerPluginMcpProtocol';
import type { AgentRuntimeDaemonServiceResponseV1 } from './agentRuntimeDaemonServiceProtocol';

export function createRunnerPluginMcpPort(input: Readonly<{
  sessionId: string;
  signal: AbortSignal;
  dispatch(operation: RunnerPluginMcpOperation, signal?: AbortSignal): Promise<AgentRuntimeDaemonServiceResponseV1>;
}>) {
  const preparations = new Map<string, () => Promise<void>>();
  const dispatch = async (operation: RunnerPluginMcpOperation, signal?: AbortSignal) => {
    const response = await input.dispatch(operation, signal);
    if (!response.ok) throw new PluginError({ code: response.error.code, message: 'Plugin MCP preparation is unavailable' });
    return RunnerPluginMcpResultSchema.parse(response.result);
  };
  const port: PluginMcpPort = {
    async prepare({ catalog, directory, signal }) {
      const lifetime = signal ? AbortSignal.any([input.signal, signal]) : input.signal;
      lifetime.throwIfAborted();
      const preparationId = randomUUID();
      const dispose = async () => {
        if (!preparations.has(preparationId)) return;
        const result = await dispatch({ kind: 'mcp.plugin.close', preparationId });
        if (result.kind !== 'mcp.plugin.closed') throw new Error('plugin_mcp_retirement_failed');
        preparations.delete(preparationId);
      };
      // Retain the issuing identity before dispatch: a lost/cancelled response
      // still retires that exact daemon-owned preparation, never its successor.
      preparations.set(preparationId, dispose);
      try {
        const projected = await dispatch({ kind: 'mcp.plugin.prepare', preparationId, directory,
          catalog: { bindings: catalog.bindings.filter(rule => parseMcpPluginItemIdV1(rule.serverId)),
            ...(catalog.pluginServers ? { pluginServers: catalog.pluginServers } : {}) } }, lifetime);
        if (projected.kind !== 'mcp.plugin.prepared') throw new Error('plugin_mcp_projection_unavailable');
        lifetime.throwIfAborted();
        return {
          items: projected.items,
          async discoverNativeServers() {
            lifetime.throwIfAborted();
            if (!preparations.has(preparationId)) throw new Error('plugin_mcp_preparation_unavailable');
            const result = await dispatch({ kind: 'mcp.plugin.discover', preparationId }, lifetime);
            if (result.kind !== 'mcp.plugin.discovered') throw new Error('plugin_mcp_discovery_unavailable');
            lifetime.throwIfAborted();
            return result.detectedServers;
          },
          async materialize(servers) {
            if (!preparations.has(preparationId)) throw new Error('plugin_mcp_preparation_unavailable');
            const result = await dispatch({ kind: 'mcp.plugin.materialize', preparationId,
              servers: servers.map(({ id, name, title, transport }) => {
                if (transport.kind === 'hosted') throw new Error('plugin_mcp_transport_unavailable');
                return { id, name, ...(title === undefined ? {} : { title }), transport };
              }) }, lifetime);
            if (result.kind !== 'mcp.plugin.materialized') throw new Error('plugin_mcp_materialization_unavailable');
            lifetime.throwIfAborted();
            return result.servers.map(server => ({ ...server, scope: { sessionId: input.sessionId, directory } }));
          },
          dispose,
        };
      } catch (error) {
        await dispose();
        throw error;
      }
    },
  };
  return { port, async dispose() {
    const results = await Promise.allSettled([...preparations.values()].map(dispose => dispose()));
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, 'Plugin MCP preparation retirement failed');
  } };
}
