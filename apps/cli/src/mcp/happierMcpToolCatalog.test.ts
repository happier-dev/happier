import { describe, expect, it } from 'vitest';

import { ActionsSettingsV1Schema, getActionSpec, listActionSpecs } from '@happier-dev/protocol';
import { RUNTIME_ACTION_IDS_V1 } from '@happier-dev/protocol/actions';

import { listBuiltInHappierTools } from '@/agent/tools/happierTools/listBuiltInHappierTools';
import { HAPPIER_MCP_TOOL_CATALOG, HAPPIER_MCP_TOOL_CATALOG_NAMES } from './happierMcpToolCatalog';

describe('HAPPIER_MCP_TOOL_CATALOG_NAMES', () => {
  it('exposes the landed change-explanation operations with their canonical input contracts', () => {
    const catalog = new Map(HAPPIER_MCP_TOOL_CATALOG.map((tool) => [tool.name, tool]));
    for (const [id, name] of [
      ['scm.diffSummary.capture', 'scm_diff_summary_capture'],
      ['scm.diffSummary.generate', 'scm_diff_summary_generate'],
      ['scm.diffSummary.result.read', 'scm_diff_summary_result_read'],
      ['scm.diffSummary.result.edit', 'scm_diff_summary_result_edit'],
      ['scm.diffSummary.result.undo', 'scm_diff_summary_result_undo'],
      ['scm.diffSummary.result.delete', 'scm_diff_summary_result_delete'],
      ['scm.diffSummary.refine', 'scm_diff_summary_refine'],
      ['scm.diffSummary.addOutputs', 'scm_diff_summary_add_outputs'],
      ['scm.diffSummary.discuss', 'scm_diff_summary_discuss'],
      ['scm.diffSummary.reviewed.mark', 'scm_diff_summary_reviewed_mark'],
      ['scm.diffSummary.reviewed.unmark', 'scm_diff_summary_reviewed_unmark'],
    ] as const) {
      expect(catalog.get(name)?.inputSchema, id).toBe(getActionSpec(id).inputSchema);
    }
  });

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
      surface: 'agent',
      isActionEnabled: () => true,
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: {} }),
    }).map((tool) => tool.name);

    expect(HAPPIER_MCP_TOOL_CATALOG_NAMES).toContain('execution_run_start');
    expect(directSessionAgentNames).toContain('action_spec_search');
    expect(directSessionAgentNames).toContain('action_execute');
    expect(directSessionAgentNames).not.toContain('execution_run_start');
    expect(directSessionAgentNames).not.toContain('subagents_delegate_start');
  });

  it('projects backed Local Services operations and does not synthesize undeclared runtime MCP tools', () => {
    const mcpToolNames = new Set(HAPPIER_MCP_TOOL_CATALOG_NAMES);
    const directMcpToolNames = new Set(listBuiltInHappierTools({
      surface: 'mcp',
      isActionEnabled: () => true,
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: {} }),
    }).map((tool) => tool.name));

    for (const actionId of ['localServices.launcher.start', 'localServices.actions.stopManaged',
      'localServices.actions.restartManaged', 'localServices.actions.forget', 'localServices.actions.terminateDetected'] as const) {
      const spec = getActionSpec(actionId);
      expect(spec.surfaces.mcp, actionId).toBe(true);
      expect(mcpToolNames.has(spec.bindings?.mcpToolName ?? ''), actionId).toBe(true);
      expect(directMcpToolNames.has(spec.bindings?.mcpToolName ?? ''), actionId).toBe(true);
    }
    for (const actionId of ['localServices.actions.copyUrl', 'localServices.actions.openPreview'] as const) {
      const spec = getActionSpec(actionId);
      expect(spec.surfaces.mcp).toBe(false);
      const name = spec.bindings?.mcpToolName ?? actionId.replaceAll('.', '_');
      expect(mcpToolNames.has(name)).toBe(false);
      expect(directMcpToolNames.has(name)).toBe(false);
    }
    const closedRuntimeActions = RUNTIME_ACTION_IDS_V1.filter((id) => getActionSpec(id).surfaces.mcp === false);
    expect(closedRuntimeActions.length).toBeGreaterThan(0);
    for (const runtimeActionId of closedRuntimeActions) {
      const spec = getActionSpec(runtimeActionId);
      if (spec.bindings?.mcpToolName) {
        expect(directMcpToolNames.has(spec.bindings.mcpToolName), runtimeActionId).toBe(false);
      }
    }
    const navigate = getActionSpec('browser.navigate');
    expect(navigate.surfaces.mcp).toBe(false);
    expect(navigate.bindings?.mcpToolName).toBeUndefined();
    expect(directMcpToolNames.has('browser_navigate')).toBe(false);
    expect(mcpToolNames.has('browser_navigate')).toBe(false);
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
