import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { estimateTokensV1 } from '@happier-dev/protocol/capabilities/estimateTokensV1';
import { codeModeStdioServer, openCodeModeMcpFixture } from './codeModeMcp.testkit';
import { connectSessionMcpClient } from './sessionMcpLocalClient';

function measure(tools: readonly Tool[]) {
  const prompt = JSON.stringify(tools);
  return { tools: tools.length, bytes: Buffer.byteLength(prompt, 'utf8'), chars: prompt.length, estimatedTokens: estimateTokensV1(prompt) };
}

describe('on-demand prompt payload', () => {
  it('replaces 25 real upstream definitions with the three discovery tools', async () => {
    vi.stubEnv('HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT', '1');
    const server = codeModeStdioServer('records', Array.from({ length: 25 }, (_, i) => `record_collection_${i + 1}`));
    const measureDelivery = async (loading: 'every_turn' | 'on_demand') => {
      const fixture = await openCodeModeMcpFixture({ featureEnabled: true, servers: [{
        ...server, tools: { default: 'ask', overrides: {}, loading },
      }] });
      try {
        const context = fixture.profile.sessionMcpContext;
        if (!context) throw new Error('Session MCP listener not available');
        const session = await connectSessionMcpClient(context);
        try {
          const baseline = (await session.client.listTools()).tools;
          const native = fixture.profile.mcpServers.records;
          if (!native) return { baseline, upstream: [] };
          const client = new Client({ name: 'prompt-measurement', version: '1' });
          const transport = new StdioClientTransport({ command: native.command, args: native.args ?? [], env: native.env });
          try {
            await client.connect(transport);
            return { baseline, upstream: (await client.listTools()).tools };
          } finally { await client.close(); await transport.close(); }
        } finally { await session.close(); }
      } finally { await fixture.close(); }
    };
    try {
      const every = await measureDelivery('every_turn');
      const lazy = await measureDelivery('on_demand');
      expect(every.upstream).toHaveLength(25);
      expect(lazy.upstream).toHaveLength(0);
      const baseline = new Set(every.baseline.map(tool => tool.name));
      const bootstrap = lazy.baseline.filter(tool => !baseline.has(tool.name));
      expect(bootstrap.map(tool => tool.name).sort()).toEqual(['tools_call', 'tools_describe', 'tools_search']);
      const everyTurn = measure(every.upstream);
      const onDemand = measure(bootstrap);
      const fullEveryTurn = measure([...every.baseline, ...every.upstream]);
      const fullOnDemand = measure(lazy.baseline);
      const savings = (before: ReturnType<typeof measure>, after: ReturnType<typeof measure>) => ({
        bytesPercent: 100 * (before.bytes - after.bytes) / before.bytes,
        estimatedTokensPercent: 100 * (before.estimatedTokens - after.estimatedTokens) / before.estimatedTokens,
      });
      console.info(JSON.stringify({ everyTurn, onDemand, ...savings(everyTurn, onDemand),
        fullEveryTurn, fullOnDemand, fullSavings: savings(fullEveryTurn, fullOnDemand) }));
      expect(onDemand.estimatedTokens).toBeLessThan(everyTurn.estimatedTokens);
    } finally { vi.unstubAllEnvs(); }
  });
});
