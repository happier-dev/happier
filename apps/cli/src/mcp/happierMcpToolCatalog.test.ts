import { describe, expect, it } from 'vitest';

import { getActionSpec, listActionSpecs } from '@happier-dev/protocol';

import { HAPPIER_MCP_TOOLS, HAPPIER_MCP_TOOL_NAMES } from './happierMcpToolCatalog';

describe('HAPPIER_MCP_TOOL_NAMES', () => {
  it('includes every ActionSpec mcpToolName for surfaces.mcp actions', () => {
    const expected = listActionSpecs()
      .filter((spec) => spec.surfaces.mcp === true)
      .map((spec) => String(spec.bindings?.mcpToolName ?? '').trim())
      .filter((name) => name.length > 0);

    for (const name of expected) {
      expect(HAPPIER_MCP_TOOL_NAMES).toContain(name);
    }
  });

  it('reuses ActionSpec inputSchema objects for mcp start actions (no schema drift)', () => {
    const byName = new Map(HAPPIER_MCP_TOOLS.map((t) => [t.name, t]));

    expect(byName.get('review_start')?.inputSchema).toBe(getActionSpec('review.start').inputSchema);
    expect(byName.get('plan_start')?.inputSchema).toBe(getActionSpec('plan.start').inputSchema);
    expect(byName.get('delegate_start')?.inputSchema).toBe(getActionSpec('delegate.start').inputSchema);
    expect(byName.get('voice_agent_start')?.inputSchema).toBe(getActionSpec('voice_agent.start').inputSchema);
  });

  it('reuses ActionSpec inputSchema objects for execution run tools (no schema drift)', () => {
    const byName = new Map(HAPPIER_MCP_TOOLS.map((t) => [t.name, t]));

    expect(byName.get('execution_run_list')?.inputSchema).toBe(getActionSpec('execution.run.list').inputSchema);
    expect(byName.get('execution_run_get')?.inputSchema).toBe(getActionSpec('execution.run.get').inputSchema);
    expect(byName.get('execution_run_send')?.inputSchema).toBe(getActionSpec('execution.run.send').inputSchema);
    expect(byName.get('execution_run_stop')?.inputSchema).toBe(getActionSpec('execution.run.stop').inputSchema);
    expect(byName.get('execution_run_action')?.inputSchema).toBe(getActionSpec('execution.run.action').inputSchema);
  });
});
