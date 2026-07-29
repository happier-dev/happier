import { describe, expect, it } from 'vitest';

import { GROK_MCP_SERVERS_UPDATED_METHOD, handleGrokMcpServersUpdated } from './mcpServersUpdated.js';

describe('Grok MCP status notification', () => {
  it('strictly validates and acknowledges the observed status without importing provider state', () => {
    expect(handleGrokMcpServersUpdated({
      mcpServers: [{ name: 'argent', source: 'local', type: 'stdio', command: 'argent', args: ['mcp'] }],
    }, { method: GROK_MCP_SERVERS_UPDATED_METHOD })).toBeUndefined();
  });

  it('rejects malformed status payloads', () => {
    expect(() => handleGrokMcpServersUpdated({ mcpServers: 'bad' }, {
      method: GROK_MCP_SERVERS_UPDATED_METHOD,
    })).toThrow('Invalid Grok MCP server update notification');
    expect(() => handleGrokMcpServersUpdated({ mcpServers: [{ type: 'stdio' }] }, {
      method: GROK_MCP_SERVERS_UPDATED_METHOD,
    })).toThrow('server name');
  });
});
