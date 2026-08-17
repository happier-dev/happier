import { describe, expect, it } from 'vitest';

import { PluginMcpContributesV1Schema } from './mcp.js';

describe('target MCP contributions', () => {
  it('accepts strict static, dynamic, and discovery descriptors', () => {
    const result = PluginMcpContributesV1Schema.safeParse({
      servers: [
        { id: 'static', title: 'Static', kind: 'static', transport: { kind: 'stdio', executable: { kind: 'systemTool', id: 'tool' }, args: ['serve'] } },
        { id: 'dependency', title: 'Dependency', kind: 'static', transport: { kind: 'stdio', executable: { kind: 'managedDependency', id: 'mcp-server' } } },
        { id: 'dynamic', title: 'Dynamic', kind: 'dynamic' },
      ],
      discoverySources: [{ id: 'discovery', title: 'Discovery' }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects legacy transport and dynamic static metadata', () => {
    expect(PluginMcpContributesV1Schema.safeParse({
      servers: [{ id: 'legacy', kind: 'mcp.server', name: 'legacy', transport: 'stdio', command: 'node' }],
    }).success).toBe(false);
    expect(PluginMcpContributesV1Schema.safeParse({
      servers: [{ id: 'dynamic', title: 'Dynamic', kind: 'dynamic', transport: { kind: 'http', url: 'https://example.test' } }],
    }).success).toBe(false);
  });
});
