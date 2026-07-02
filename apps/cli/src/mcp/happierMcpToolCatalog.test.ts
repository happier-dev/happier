import { describe, expect, it } from 'vitest';

import { ActionsSettingsV1Schema, getActionSpec, listActionSpecs } from '@happier-dev/protocol';

import { listBuiltInHappierTools } from '@/agent/tools/happierTools/listBuiltInHappierTools';
import { HAPPIER_MCP_TOOL_CATALOG, HAPPIER_MCP_TOOL_CATALOG_NAMES } from './happierMcpToolCatalog';

describe('HAPPIER_MCP_TOOL_CATALOG_NAMES', () => {
  it('deduplicates overlapping manual and action-backed MCP tool names', () => {
    expect(new Set(HAPPIER_MCP_TOOL_CATALOG_NAMES).size).toBe(HAPPIER_MCP_TOOL_CATALOG_NAMES.length);
  });

  it('keeps the raw ActionSpec tool catalog separate from session-agent direct exposure', () => {
    const expected = listActionSpecs()
      .map((spec) => String(spec.bindings?.mcpToolName ?? '').trim())
      .filter((name) => name.length > 0);

    for (const name of expected) {
      expect(HAPPIER_MCP_TOOL_CATALOG_NAMES).toContain(name);
    }

    const directSessionAgentNames = listBuiltInHappierTools({
      surface: 'session_agent',
      isActionEnabled: () => true,
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: {} }),
    }).map((tool) => tool.name);

    expect(HAPPIER_MCP_TOOL_CATALOG_NAMES).toContain('execution_run_start');
    expect(directSessionAgentNames).toContain('action_spec_search');
    expect(directSessionAgentNames).toContain('action_execute');
    expect(directSessionAgentNames).not.toContain('execution_run_start');
    expect(directSessionAgentNames).not.toContain('subagents_delegate_start');
  });

  it('reuses ActionSpec inputSchema objects for mcp start actions (no schema drift)', () => {
    const byName = new Map(HAPPIER_MCP_TOOL_CATALOG.map((t) => [t.name, t]));

    expect(byName.get('review_start')?.inputSchema).toBe(getActionSpec('review.start').inputSchema);
    expect(byName.get('subagents_plan_start')?.inputSchema).toBe(getActionSpec('subagents.plan.start').inputSchema);
    expect(byName.get('subagents_delegate_start')?.inputSchema).toBe(getActionSpec('subagents.delegate.start').inputSchema);
    expect(byName.get('voice_agent_start')?.inputSchema).toBe(getActionSpec('voice_agent.start').inputSchema);
  });

  it('reuses ActionSpec inputSchema objects for execution run tools (no schema drift)', () => {
    const byName = new Map(HAPPIER_MCP_TOOL_CATALOG.map((t) => [t.name, t]));

    expect(byName.get('action_spec_search')?.inputSchema).toBe(getActionSpec('action.spec.search').inputSchema);
    expect(byName.get('action_spec_get')?.inputSchema).toBe(getActionSpec('action.spec.get').inputSchema);
    expect(byName.get('action_options_resolve')?.inputSchema).toBe(getActionSpec('action.options.resolve').inputSchema);
    expect(byName.get('execution_run_list')?.inputSchema).toBe(getActionSpec('execution.run.list').inputSchema);
    expect(byName.get('execution_run_get')?.inputSchema).toBe(getActionSpec('execution.run.get').inputSchema);
    expect(byName.get('execution_run_send')?.inputSchema).toBe(getActionSpec('execution.run.send').inputSchema);
    expect(byName.get('execution_run_stop')?.inputSchema).toBe(getActionSpec('execution.run.stop').inputSchema);
    expect(byName.get('execution_run_action')?.inputSchema).toBe(getActionSpec('execution.run.action').inputSchema);
  });
});
