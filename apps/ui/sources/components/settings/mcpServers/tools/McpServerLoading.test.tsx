import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';

import { renderScreen, standardCleanup } from '@/dev/testkit';

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
// The Home's feature bits are the server boundary; the canonical decision owner is what the row consumes.
const codeMode = vi.hoisted(() => ({ enabled: true }));
vi.mock('@/hooks/server/useFeatureEnabled', () => ({
  useFeatureEnabled: (featureId: string) =>
    featureId === 'sessions.codeMode' && codeMode.enabled,
}));

afterEach(() => {
  standardCleanup();
  codeMode.enabled = true;
});

const { McpServerToolsSection } = await import('./McpServerToolsSection');

const TOOL_COUNT = 25;
function heavyList(loading: 'every_turn' | 'on_demand', tokensPerTool = 320) {
  const tools = Array.from({ length: TOOL_COUNT }, (_, index) => ({
    name: `tool_${index}`,
    description: `Tool ${index}`,
    tokens: tokensPerTool,
    setting: 'inherit' as const,
    source: 'server_default' as const,
  }));
  const tokens = tools.reduce((sum, tool) => sum + tool.tokens, 0);
  return MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.tools.list'].parse({
    serverId: 'plugin:heavy:docs',
    revision: 2,
    settings: { default: 'ask', tools: {} },
    tools,
    tokens,
    loading,
    effectivePromptTokens: loading === 'on_demand' ? 0 : tokens,
    savedPromptTokens: loading === 'on_demand' ? tokens : 0,
    perAgent: { status: 'ready', agents: [] },
  });
}

async function mount(
  list: ReturnType<typeof heavyList> | null,
  status: 'loading' | 'ready' = 'ready',
) {
  const onChange = vi.fn(async () => null);
  const onLoadingChange = vi.fn(async () => null);
  // What useMcpServerTools hands the section: the list's loading and its settled per-turn figure.
  const element = (next: typeof list, nextStatus: typeof status) => (
    <McpServerToolsSection
      testID="tools"
      status={nextStatus}
      list={next}
      agentNames={(ids) => ids}
      installedAgentIds={[]}
      onChange={onChange}
      loading={next?.loading ?? 'every_turn'}
      settledTokensPerTurn={next?.tokens ?? null}
      onLoadingChange={onLoadingChange}
    />
  );
  const screen = await renderScreen(element(list, status));
  return {
    screen,
    onChange,
    onLoadingChange,
    rerender: (next: typeof list, nextStatus: typeof status = 'ready') =>
      screen.update(element(next, nextStatus)),
  };
}

const loadingRow = (screen: Awaited<ReturnType<typeof renderScreen>>) =>
  screen.findByTestId('tools:toolLoading');

describe('MCP server Tool loading row (Code Mode)', () => {
  it('is absent when Code Mode is off on this Home, keeps the cost line, and preserves agent warnings even if saved on_demand', async () => {
    codeMode.enabled = false;
    const savedOnDemand = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.tools.list'].parse({
      ...heavyList('on_demand'),
      perAgent: {
        status: 'ready',
        agents: [{ agentId: 'codex', approval: null, off: null, loading: 'every_turn', tokens: 8000 }],
      },
    });
    const screen = await renderScreen(
      <McpServerToolsSection
        testID="tools"
        status="ready"
        list={savedOnDemand}
        agentNames={(ids) => ids.map((id) => (id === 'codex' ? 'Codex' : id))}
        installedAgentIds={['codex']}
        onChange={async () => null}
        loading={savedOnDemand.loading}
        settledTokensPerTurn={savedOnDemand.tokens}
        onLoadingChange={async () => null}
      />,
    );
    expect(loadingRow(screen)).toBeNull();
    expect(screen.findByTestId('tools:cost')).not.toBeNull();
    expect(screen.getTextContent()).toContain('Codex');
  });

  it('is one adaptive preference row whose description states the settled figure once', async () => {
    const { screen } = await mount(heavyList('every_turn'));
    const row = loadingRow(screen);
    expect(row).not.toBeNull();
    expect(
      screen.findAll(
        (node) =>
          node.props?.accessoryLayout === 'adaptive' &&
          node.props?.testID === 'tools:toolLoading',
      ).length,
    ).toBeGreaterThan(0);
    // 25 tools × 320 tokens = 8,000 tokens a turn, named once with what On demand saves.
    const text = screen.getTextContent();
    expect(text).toContain('25 tools');
    expect(text).toContain('8k');
    expect(text).toContain('On demand saves them');
    // The separate cost line steps aside so the figure is said once.
    expect(screen.findByTestId('tools:cost')).toBeNull();
  });

  it('writes the loading choice through the tools setting for a plugin server', async () => {
    const { screen, onChange, onLoadingChange } = await mount(heavyList('every_turn'));
    await screen.pressByTestIdAsync('tools:toolLoading:on_demand');
    expect(onLoadingChange).toHaveBeenCalledWith('on_demand');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('reads On demand with the tokens it saves', async () => {
    const { screen } = await mount(heavyList('on_demand'));
    expect(screen.getTextContent()).toContain('saved each turn');
  });

  it('does not flicker: a refresh keeps the settled sentence, and an unread list draws no row', async () => {
    const { screen, rerender } = await mount(null, 'loading');
    expect(loadingRow(screen)).toBeNull();
    const settled = heavyList('every_turn');
    await rerender(settled);
    const before = screen.getTextContent();
    // The hook keeps the last-known list while it re-reads; the row must read the same.
    await rerender(settled, 'loading');
    expect(screen.getTextContent()).toBe(before);
  });
});
