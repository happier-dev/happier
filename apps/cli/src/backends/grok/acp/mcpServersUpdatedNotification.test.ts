import { describe, expect, it } from 'vitest';

import type { AcpExtensionHandlerContext } from '@/agent/acp/AcpBackend';
import {
  GROK_MCP_SERVERS_UPDATED_METHOD,
  handleGrokMcpServersUpdatedNotification,
} from './mcpServersUpdatedNotification';

function context(method: string = GROK_MCP_SERVERS_UPDATED_METHOD): AcpExtensionHandlerContext {
  return {
    method,
    sessionId: null,
    signal: new AbortController().signal,
    agentName: 'grok',
  };
}

function observedPayload(): Record<string, unknown> {
  return {
    mcpServers: [{
      name: 'argent',
      source: 'local',
      type: 'stdio',
      command: 'argent',
      args: ['mcp'],
    }],
  };
}

describe('Grok MCP servers-updated notification', () => {
  it('acknowledges the observed bounded status payload without returning state', () => {
    expect(handleGrokMcpServersUpdatedNotification(observedPayload(), context())).toBeUndefined();
  });

  it('rejects a different extension method', () => {
    expect(() => handleGrokMcpServersUpdatedNotification(
      observedPayload(),
      context('x.ai/mcp/servers_updated'),
    )).toThrow('Unsupported Grok MCP server update notification method');
  });

  it.each([
    { label: 'non-array server list', payload: { mcpServers: 'not-an-array' } },
    { label: 'unexpected top-level state', payload: { ...observedPayload(), active: true } },
    { label: 'entry without a stable name', payload: { mcpServers: [{ type: 'stdio' }] } },
    {
      label: 'too many servers',
      payload: { mcpServers: Array.from({ length: 129 }, (_, index) => ({ name: `server-${index}` })) },
    },
    {
      label: 'too many command arguments',
      payload: { mcpServers: [{ name: 'argent', args: Array.from({ length: 129 }, () => 'arg') }] },
    },
    {
      label: 'oversized command argument',
      payload: { mcpServers: [{ name: 'argent', args: ['x'.repeat(16_385)] }] },
    },
  ])('rejects $label', ({ payload }) => {
    expect(() => handleGrokMcpServersUpdatedNotification(payload, context()))
      .toThrow('Invalid Grok MCP server update notification');
  });

  it('accepts and discards unknown entry metadata for forward-compatible status updates', () => {
    expect(handleGrokMcpServersUpdatedNotification({
      mcpServers: [{
        name: 'remote-provider',
        providerMetadata: { future: true },
      }],
    }, context())).toBeUndefined();
  });
});
