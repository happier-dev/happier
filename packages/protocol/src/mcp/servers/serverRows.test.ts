import { describe, expect, it } from 'vitest';
import { McpServersSettingsV1Schema } from './settingsV1.js';

describe('MCP catalog complete inventory admission', () => {
  it('rejects a retained binding whose definition is missing instead of activating a partial catalog', () => {
    // Actual 0.2 shape, HEAD 37a6541578749067b49d4579be8c752c9591b8c8,
    // packages/protocol/src/mcpServers/settingsV1.ts (clean scoped worktree).
    const retained = { v: 1, strictMode: true, servers: [], bindings: [{
      id: 'binding', serverId: 'missing', enabled: true,
      target: { t: 'workspace', machineId: 'machine', workspaceRoot: 'C:\\Users\\alice\\project' },
      overrides: { envPatch: { TOKEN: null } }, createdAt: 1, updatedAt: 2,
    }] };
    expect(McpServersSettingsV1Schema.safeParse(retained).success).toBe(false);
  });
});
