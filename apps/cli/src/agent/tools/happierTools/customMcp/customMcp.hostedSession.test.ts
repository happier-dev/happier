import { describe, expect, it } from 'vitest';
import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { probeMcpStdioServerTools } from '@/mcp/servers/probeMcpStdioServerTools';
import { callResolvedCustomHappierTool } from './callResolvedCustomHappierTool';
import { listResolvedCustomHappierTools } from './listResolvedCustomHappierTools';

// The MCP server is a real subprocess: discovery, protocol handling and calls
// remain on their production paths, including their default environment.
const server = String.raw`
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const scope = process.env.HAPPIER_MCP_SCOPE_TEST || 'missing';
  const result = request.method === 'initialize'
    ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'scope', version: '1' } }
    : request.method === 'tools/list' ? { tools: [{ name: 'scope_' + scope, inputSchema: { type: 'object' } }] }
    : request.method === 'tools/call' ? { content: [{ type: 'text', text: scope }] } : undefined;
  if (result) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
});
`;

describe('custom MCP hosted Session environment', () => {
  it.each([false, true])('keeps concurrent discovery and calls in their Session (explicit override: %s)', async explicit => {
    await Promise.all(['first', 'second'].map(scope => runAddedHostedSession({
      environment: { ...process.env, HAPPIER_MCP_SCOPE_TEST: scope },
      workingDirectory: process.cwd(), end: () => undefined,
    }, async () => {
      const expected = explicit ? 'override' : scope;
      const processEnv = explicit ? { ...process.env, HAPPIER_MCP_SCOPE_TEST: expected } : undefined;
      const config = { command: process.execPath, args: ['-e', server] };
      const mcpServers = { scoped: config };
      const [listed, called, probed] = await Promise.all([
        listResolvedCustomHappierTools({ mcpServers, processEnv }),
        callResolvedCustomHappierTool({ mcpServers, processEnv, source: 'scoped', toolName: `scope_${expected}`,
          args: {}, operationContext: { isCurrent: async () => true } }),
        probeMcpStdioServerTools({ config, baseEnv: processEnv }),
      ]);
      expect.soft(listed).toMatchObject({ warnings: [], tools: [{ source: 'scoped', name: `scope_${expected}` }] });
      expect.soft(called).toMatchObject({ ok: true, result: { content: [{ type: 'text', text: expected }] } });
      expect.soft(probed.tools.map(tool => tool.name)).toEqual([`scope_${expected}`]);
    })));
  });
});
