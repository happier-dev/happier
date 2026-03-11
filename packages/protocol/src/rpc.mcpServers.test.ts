import { describe, expect, it } from 'vitest';

import { RPC_METHODS } from './rpc.js';

describe('RPC_METHODS (daemon mcp servers)', () => {
  it('includes daemon.mcpServers.* methods', () => {
    expect((RPC_METHODS as any).DAEMON_MCP_SERVERS_TEST).toBe('daemon.mcpServers.test');
    expect((RPC_METHODS as any).DAEMON_MCP_SERVERS_DETECT).toBe('daemon.mcpServers.detect');
  });
});

