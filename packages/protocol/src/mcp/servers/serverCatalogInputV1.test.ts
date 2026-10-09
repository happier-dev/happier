import { describe, expect, it } from 'vitest';
import { McpServerCatalogEntryV1Schema, McpServerBindingV1Schema } from './settingsV1.js';

describe('MCP canonical executable inputs', () => {
  it('rejects unknown executable and binding fields at nested ingress boundaries', () => {
    const server = { id: 'stdio', name: 'stdio', transport: 'stdio', stdio: { command: 'mcp-tool', args: [], ignored: true },
      env: {}, createdAt: 1, updatedAt: 1 };
    expect(McpServerCatalogEntryV1Schema.safeParse(server).success).toBe(false);
    const binding = { id: 'binding', serverId: 'stdio', enabled: true, target: { t: 'allMachines', ignored: true },
      createdAt: 1, updatedAt: 1 };
    expect(McpServerBindingV1Schema.safeParse(binding).success).toBe(false);
  });
});
