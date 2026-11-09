import { describe, expect, it } from 'vitest';
import { listResolvedCustomHappierTools } from '@/agent/tools/happierTools/customMcp/listResolvedCustomHappierTools';
import { callResolvedCustomHappierTool } from '@/agent/tools/happierTools/customMcp/callResolvedCustomHappierTool';
import { createSupervisedMcpStdioTransport, type PrepareMcpStdioTransport } from '@/mcp/runtime/supervisedStdioTransport';
import { spawnSupervisedPluginProcess, type SupervisedPluginProcess } from '@/plugins/runtime/exec/processSupervisor';
import { PluginError } from '@happier-dev/plugin-sdk/errors';

// This suite exercises only the transport consumer seam. The installed Machine
// suite owns Account custody and identity selection; subprocess IO stays real.
const server = String.raw`
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result = request.method === 'initialize'
    ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'admitted', version: '1' } }
    : request.method === 'tools/list' ? { tools: [{ name: 'member_ready', inputSchema: { type: 'object' } }] }
    : request.method === 'tools/call' ? { content: [{ type: 'text', text: 'member_tool_result' }] } : undefined;
  if (result) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
});
`;

describe('custom MCP consumers use the admitted stdio transport', () => {
  it('lists and calls useful tools through supervised children without raw SDK spawning', async () => {
    const processes: SupervisedPluginProcess[] = [];
    const prepareTransport: PrepareMcpStdioTransport = async (_config, signal) => {
      const supervised = spawnSupervisedPluginProcess({ command: process.execPath,
        args: ['-e', server], env: process.env, signals: signal ? [signal] : [],
        maxStdoutBytes: 0, maxStderrBytes: 0 });
      processes.push(supervised);
      return { transport: createSupervisedMcpStdioTransport(supervised), stderr: supervised.child.stderr };
    };
    const mcpServers = { member: { command: 'must-not-execute-raw-config', args: [] } };
    try {
      const listed = await listResolvedCustomHappierTools({ mcpServers, processEnv: {}, prepareTransport });
      expect(listed.warnings).toEqual([]);
      expect(listed.tools.map(tool => ({ source: tool.source, name: tool.name })))
        .toEqual([{ source: 'member', name: 'member_ready' }]);
      const called = await callResolvedCustomHappierTool({ mcpServers, source: 'member', toolName: 'member_ready', args: {},
        operationContext: { isCurrent: async () => true }, processEnv: {}, prepareTransport });
      expect(called).toMatchObject({ ok: true, result: { content: [{ type: 'text', text: 'member_tool_result' }] } });
      expect(processes).toHaveLength(2);
      for (const supervised of processes) {
        expect(supervised.child.exitCode !== null || supervised.child.signalCode !== null).toBe(true);
        expect((await supervised.waitForSettlement()).remainder).toBeUndefined();
      }
    } finally { await Promise.all(processes.map(supervised => supervised.dispose())); }
  });

  it('preserves the safe native refusal code rather than returning a generic tool warning', async () => {
    const mcpServers = { member: { command: 'must-not-execute-raw-config', args: [] } };
    const prepareTransport: PrepareMcpStdioTransport = async () => {
      throw new PluginError({ code: 'agent_isolation_unavailable', message: 'Native transport unavailable', retryable: false,
        details: { phase: 'requester_mcp_native_launch', reason: 'agent_launch_kind_unavailable' } });
    };
    await expect(listResolvedCustomHappierTools({ mcpServers, processEnv: {}, prepareTransport }))
      .rejects.toMatchObject({ code: 'agent_isolation_unavailable', retryable: false });
    await expect(callResolvedCustomHappierTool({ mcpServers, source: 'member', toolName: 'member_ready', args: {},
      operationContext: { isCurrent: async () => true }, processEnv: {}, prepareTransport }))
      .rejects.toMatchObject({ code: 'agent_isolation_unavailable', retryable: false });
  });
});
