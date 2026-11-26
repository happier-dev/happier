import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import { resolveMcpToolDecisionV1 } from '@happier-dev/protocol/mcp/servers/tools/resolveMcpToolDecisionV1';

import { describeMcpToolAgents, McpServerToolsSection } from './McpServerToolsSection';
import {
  pressTestInstanceAsync,
  renderScreen,
  standardCleanup,
} from '@/dev/testkit';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

afterEach(() => {
  standardCleanup();
  vi.resetModules();
});

const readTools = [
  'search_code',
  'get_issue',
  'list_pull_requests',
  'get_file',
  'list_commits',
].map((name) => ({
  name,
  description: `${name} description`,
  annotations: { readOnlyHint: true },
  tokens: 120,
  setting: 'inherit' as const,
  source: 'server_default' as const,
}));
const writeTools = [
  'add_issue_comment',
  'create_pull_request',
  'merge_pull_request',
  'push_files',
  'create_branch',
].map((name) => ({
  name,
  description: `${name} description`,
  tokens: 200,
  setting: 'inherit' as const,
  source: 'server_default' as const,
}));

/** A real `mcp.servers.tools.list` result, through its strict output schema. */
const list = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1[
  'mcp.servers.tools.list'
].parse({
  serverId: 'github',
  revision: 4,
  settings: {
    default: 'allow_read_only',
    tools: { create_issue: 'allow', delete_file: 'off' },
  },
  tools: [
    ...readTools,
    {
      name: 'create_issue',
      title: 'Create an issue',
      description: 'Open an issue.',
      tokens: 180,
      setting: 'allow',
      source: 'tool',
    },
    ...writeTools,
    {
      name: 'delete_file',
      description: 'Delete a file.',
      annotations: { destructiveHint: true },
      tokens: 90,
      setting: 'off',
      source: 'tool',
    },
  ],
  tokens: 2270,
  loading: 'every_turn',
  effectivePromptTokens: 2270,
  savedPromptTokens: 0,
  perAgent: {
    status: 'ready',
    agents: [
      {
        agentId: 'claude',
        approval: 'native',
        off: 'hidden',
        loading: 'on_demand',
        tokens: 2180,
      },
      {
        agentId: 'codex',
        approval: null,
        off: null,
        loading: 'every_turn',
        tokens: 2270,
      },
      {
        agentId: 'kilo',
        approval: 'host',
        off: 'blocked',
        loading: 'every_turn',
        tokens: 2270,
      },
    ],
  },
});
const NAMES: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  kilo: 'Kilo',
};

async function mount(
  installedAgentIds: readonly string[] = ['claude', 'codex', 'kilo'],
) {
  const onChange = vi.fn(async () => null);
  const screen = await renderScreen(
    <McpServerToolsSection
      testID="tools"
      status="ready"
      list={list}
      agentNames={(ids) => ids.map((id) => NAMES[id] ?? id)}
      installedAgentIds={installedAgentIds}
      onChange={onChange}
      loading={list.loading}
      settledTokensPerTurn={list.tokens}
      onLoadingChange={async () => null}
    />,
  );
  return { screen, onChange };
}

const label = (
  screen: Awaited<ReturnType<typeof renderScreen>>,
  testID: string,
) =>
  screen
    .findAllByTestId(testID)
    .map((node) => node.props.accessibilityLabel)
    .find((value) => typeof value === 'string');

describe('McpServerToolsSection', () => {
  it('applies host tool rules across installed agents when the server moves on demand', () => {
    const agents = ['claude', 'codex', 'kilo'];
    expect(describeMcpToolAgents(list.perAgent, ids => ids, agents, 'every_turn').notApply).toEqual(['codex']);
    expect(describeMcpToolAgents(list.perAgent, ids => ids, agents, 'on_demand')).toEqual({
      onDemand: agents, notApply: [], blocked: [], hidden: [],
    });
  });

  it.each(['ask', 'allow_read_only', 'allow_all'] as const)('projects %s through the canonical default-mode decision, including unknown annotations', async serverDefault => {
    const tools = [
      { name: 'read', annotations: { readOnlyHint: true } },
      { name: 'unknown' },
      { name: 'write', annotations: { readOnlyHint: false } },
    ];
    const projected = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.tools.list'].parse({
      ...list, settings: { default: serverDefault, tools: {} },
      tools: tools.map(tool => ({ ...tool, tokens: 1, setting: 'inherit', source: 'server_default' })),
    });
    const screen = await renderScreen(<McpServerToolsSection testID="projection" status="ready" list={projected}
      agentNames={ids => ids} installedAgentIds={[]} onChange={async () => null}
      loading={projected.loading} settledTokensPerTurn={projected.tokens} onLoadingChange={async () => null} />);
    for (const tool of tools) {
      const decision = resolveMcpToolDecisionV1({ policy: { default: serverDefault, overrides: {} },
        toolName: tool.name, annotations: tool.annotations, permissionMode: 'default' });
      const selected = screen.findAllByTestId(`projection:tool:${tool.name}:${decision.approval}`)
        .some(node => node.props.accessibilityState?.checked === true || node.props.accessibilityState?.selected === true);
      expect(selected, tool.name).toBe(true);
    }
  });
  it('draws a tool on the default as inherited and a tool the person set as theirs', async () => {
    const { screen, onChange } = await mount();
    // On "Allow read-only", a read-only tool inherits Allow; it says so to assistive tech.
    expect(label(screen, 'tools:tool:search_code:allow')).toBe(
      'Allow, default',
    );
    // A tool the person set is plain "Allow", marked Set by you.
    expect(label(screen, 'tools:tool:create_issue:allow')).toBe('Allow');
    expect(
      screen.findAllByTestId('tools:tool:create_issue:setByYou').length,
    ).toBeGreaterThan(0);
    expect(
      screen.findAllByTestId('tools:tool:search_code:setByYou'),
    ).toHaveLength(0);
    // A writing tool on the default asks.
    expect(label(screen, 'tools:tool:add_issue_comment:ask')).toBe(
      'Ask, default',
    );

    await pressTestInstanceAsync(
      screen.findByTestId('tools:tool:add_issue_comment:allow'),
      'allow',
    );
    expect(onChange).toHaveBeenCalledWith({
      tools: { add_issue_comment: 'allow' },
    });

    // "Set by you" is also the way back: the tool returns to the server default, not to a fixed value.
    await pressTestInstanceAsync(
      screen.findByTestId('tools:tool:create_issue:setByYou'),
      'back to default',
    );
    expect(onChange).toHaveBeenLastCalledWith({
      tools: { create_issue: 'inherit' },
    });
  });

  it('shows the first rows and the rest on Show all', async () => {
    const { screen } = await mount();
    expect(screen.findAllByTestId('tools:tool:delete_file')).toHaveLength(0);
    await pressTestInstanceAsync(
      screen.findByTestId('tools:showAll'),
      'show all',
    );
    expect(
      screen.findAllByTestId('tools:tool:delete_file').length,
    ).toBeGreaterThan(0);
    expect(screen.findAllByTestId('tools:showAll')).toHaveLength(0);
  });

  it('names, from the projected facts, the Agents the settings do not reach and how Off works for the others', async () => {
    const { screen } = await mount();
    const text = screen.getTextContent();
    expect(text).toContain('Tool settings don’t apply to Codex');
    expect(text).not.toContain('apply to Claude');
    expect(text).toContain('In Kilo, Off blocks a tool');
    expect(text).toContain('new Claude sessions');
    expect(text).toContain('Claude loads a tool only when it needs it');
  });

  it('describes only Agents installed on Account machines, including no Agents while that inventory is unknown', async () => {
    const { screen } = await mount(['claude']);
    const text = screen.getTextContent();
    expect(text).not.toContain('Tool settings don’t apply');
    expect(text).not.toContain('In Kilo');
    expect(text).toContain('new Claude sessions');
    const empty = await mount([]);
    expect(empty.screen.getTextContent()).not.toContain(
      'Tool settings don’t apply',
    );
    expect(empty.screen.getTextContent()).not.toContain('new Claude sessions');
    expect(empty.screen.getTextContent()).not.toContain('Claude loads');
  });
});
