import { describe, expect, it } from 'vitest';
import { ActionsSettingsV1Schema, getActionSpec, listActionSpecs } from '@happier-dev/protocol';
import { RUNTIME_ACTION_IDS_V1 } from '@happier-dev/protocol/actions';
import { listActionCliCommandDeclarations } from '@happier-dev/protocol/actions/actionSpecs';

import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';

import { HAPPIER_BUILT_IN_TOOLS, HAPPIER_BUILT_IN_TOOL_NAMES } from './catalog';
import { listBuiltInHappierTools } from './listBuiltInHappierTools';

describe('Happier built-in tool catalog convergence', () => {
  it('exposes the catalog entrypoints and CLI help roots used by the first-party guide', () => {
    const tools = listBuiltInHappierTools({
      surface: 'agent',
      registry: createResolvedContributionRegistry({ agents: [] }),
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: {} }),
    });
    expect(tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
      'action_spec_search', 'action_spec_get', 'action_execute',
    ]));
    expect(tools.find(tool => tool.name === 'action_spec_search')?.actionId).toBe('action.spec.search');
    expect(tools.find(tool => tool.name === 'action_spec_get')?.actionId).toBe('action.spec.get');

    const roots = new Set(listActionCliCommandDeclarations().map(command => command.binding.path[0]));
    for (const root of ['skills', 'mcp', 'session']) expect(roots.has(root)).toBe(true);
  });

  it.each([
    { name: 'execution_run_start', actionId: 'execution.run.start', surface: 'cli' },
    { name: 'plugins_reload', actionId: 'plugins.reload', surface: 'agent' },
  ] as const)('keeps $name Action-backed and withdraws it when its canonical policy disables it', ({ name, actionId, surface }) => {
    const registry = createResolvedContributionRegistry({ agents: [] });
    const enabledTools = listBuiltInHappierTools({
      surface, registry, actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: {} }),
    });
    expect(enabledTools.filter((tool) => tool.name === name)).toEqual([
      expect.objectContaining({ name, actionId }),
    ]);

    const disabledTools = listBuiltInHappierTools({
      surface,
      registry,
      actionsSettings: ActionsSettingsV1Schema.parse({
        v: 1, actions: { [actionId]: { enabled: false } },
      }),
    });
    expect(disabledTools.map((tool) => tool.name)).toContain('action_execute');
    expect(disabledTools.map((tool) => tool.name)).not.toContain(name);
  });
});

describe('HAPPIER_BUILT_IN_TOOLS', () => {
  const defaultActionsSettings = () => ActionsSettingsV1Schema.parse({ v: 1, actions: {} });

  it('reuses the canonical ActionSpec inputSchema object for every Action-backed tool and keeps names unique', () => {
    const byName = new Map(HAPPIER_BUILT_IN_TOOLS.map((tool) => [tool.name, tool]));
    const backedSpecs = listActionSpecs().filter((spec) => String(spec.bindings?.mcpToolName ?? '').trim().length > 0);
    expect(backedSpecs.length).toBeGreaterThan(0);
    for (const spec of backedSpecs) {
      const tool = byName.get(String(spec.bindings?.mcpToolName).trim());
      expect(tool?.actionId, spec.id).toBe(spec.id);
      expect(tool?.inputSchema, spec.id).toBe(spec.inputSchema);
    }
    expect(new Set(HAPPIER_BUILT_IN_TOOL_NAMES).size).toBe(HAPPIER_BUILT_IN_TOOL_NAMES.length);
  });

  it('keeps the landed change-explanation operations on their public MCP tool names', () => {
    // Agents call these by name; the table above follows whatever name a spec declares.
    const byName = new Map(HAPPIER_BUILT_IN_TOOLS.map((tool) => [tool.name, tool]));
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
      expect(byName.get(name)?.actionId, id).toBe(id);
    }
  });

  it('keeps the raw ActionSpec tool catalog separate from session-agent direct exposure', () => {
    const expected = listActionSpecs()
      .map((spec) => String(spec.bindings?.mcpToolName ?? '').trim())
      .filter((name) => name.length > 0);

    for (const name of expected) {
      expect(HAPPIER_BUILT_IN_TOOL_NAMES).toContain(name);
    }

    const directSessionAgentNames = listBuiltInHappierTools({
      surface: 'agent',
      isActionEnabled: () => true,
      actionsSettings: defaultActionsSettings(),
    }).map((tool) => tool.name);

    expect(HAPPIER_BUILT_IN_TOOL_NAMES).toContain('execution_run_start');
    expect(directSessionAgentNames).toContain('action_spec_search');
    expect(directSessionAgentNames).toContain('action_execute');
    expect(directSessionAgentNames).not.toContain('execution_run_start');
    expect(directSessionAgentNames).not.toContain('subagents_delegate_start');
  });

  it('projects backed Local Services operations and does not synthesize undeclared runtime MCP tools', () => {
    const mcpToolNames = new Set(HAPPIER_BUILT_IN_TOOL_NAMES);
    const directMcpToolNames = new Set(listBuiltInHappierTools({
      surface: 'mcp',
      isActionEnabled: () => true,
      actionsSettings: defaultActionsSettings(),
    }).map((tool) => tool.name));

    for (const actionId of ['ui.prompts.picker.open', 'localServices.launcher.start', 'localServices.actions.stopManaged',
      'localServices.actions.restartManaged', 'localServices.actions.forget', 'localServices.actions.terminateDetected',
      'localServices.actions.openPreview'] as const) {
      const spec = getActionSpec(actionId);
      expect(spec.surfaces.mcp, actionId).toBe(true);
      expect(mcpToolNames.has(spec.bindings?.mcpToolName ?? ''), actionId).toBe(true);
      expect(directMcpToolNames.has(spec.bindings?.mcpToolName ?? ''), actionId).toBe(false);
    }
    for (const actionId of ['localServices.actions.copyUrl'] as const) {
      const spec = getActionSpec(actionId);
      expect(spec.surfaces.mcp).toBe(false);
      expect(spec.bindings?.mcpToolName).toBeUndefined();
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
});
