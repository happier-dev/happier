import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/components/ui/text/Text', () => ({
  TextSelectabilityScope: (props: any) => React.createElement('TextSelectabilityScope', props, props.children),
}));

vi.mock('@/components/tools/shell/presentation/ToolError', () => ({
  ToolError: (props: any) => React.createElement('ToolError', props),
}));

vi.mock('@/components/tools/renderers/core/_registry', () => ({
  getToolViewComponent: () => null,
}));

vi.mock('@/components/tools/catalog', () => ({
  knownTools: {},
}));

vi.mock('@/components/tools/renderers/system/StructuredResultView', () => ({
  StructuredResultView: () => React.createElement('StructuredResultView'),
}));

vi.mock('@/components/tools/shell/presentation/ToolSectionView', () => ({
  ToolSectionView: (props: any) => React.createElement('ToolSectionView', props, props.children),
}));

vi.mock('@/components/ui/media/CodeView', () => ({
  CodeView: () => React.createElement('CodeView'),
}));

vi.mock('@/utils/errors/toolErrorParser', () => ({
  parseToolUseError: () => ({ isToolUseError: false }),
}));

vi.mock('@/agents/catalog/catalog', () => ({
  resolveAgentIdFromFlavor: () => null,
  getAgentCore: () => ({ toolRendering: { hideUnknownToolsByDefault: false } }),
}));

vi.mock('@/text', () => ({
  t: (key: string) => key,
}));

describe('ToolInlineBody (text selection scope)', () => {
  it('wraps tool body output in a TextSelectabilityScope so content defaults to selectable', async () => {
    const { ToolInlineBody } = await import('./ToolInlineBody');

    const tool: any = {
      id: 't1',
      name: 'unknown',
      state: 'error',
      input: {},
      result: 'boom',
      createdAt: 1,
      startedAt: null,
      completedAt: null,
      permission: { kind: 'filesystem', status: 'denied' },
    };

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <ToolInlineBody
          mode="card"
          tool={tool}
          normalizedToolName="unknown"
          metadata={null}
          messages={[]}
          detailLevel="summary"
          setHeaderActions={() => {}}
        />
      );
    });

    const scopes = tree.root.findAllByType('TextSelectabilityScope' as any);
    expect(scopes.length).toBeGreaterThan(0);
    expect(tree.root.findAllByType('ToolError' as any).length).toBe(1);
  });

  it('uses structured fallback instead of raw ToolError for SubAgentRun error rows without specific renderer', async () => {
    const { ToolInlineBody } = await import('./ToolInlineBody');

    const tool: any = {
      id: 't-subagent',
      name: 'SubAgentRun',
      state: 'error',
      input: {},
      result: { status: 'timeout', error: { code: 'execution_run_timeout', message: 'Timed out' } },
      createdAt: 1,
      startedAt: null,
      completedAt: null,
      permission: undefined,
    };

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <ToolInlineBody
          mode="card"
          tool={tool}
          normalizedToolName="SubAgentRun"
          metadata={null}
          messages={[]}
          detailLevel="summary"
          setHeaderActions={() => {}}
        />
      );
    });

    expect(tree.root.findAllByType('StructuredResultView' as any).length).toBe(1);
    expect(tree.root.findAllByType('ToolError' as any).length).toBe(0);
  });

  it('uses SubAgentRun fallback even when normalized tool name is not SubAgentRun', async () => {
    const { ToolInlineBody } = await import('./ToolInlineBody');

    const tool: any = {
      id: 't-subagent-raw',
      name: 'SubAgentRun',
      state: 'error',
      input: {},
      result: { status: 'timeout', error: { code: 'execution_run_timeout', message: 'Timed out' } },
      createdAt: 1,
      startedAt: null,
      completedAt: null,
      permission: undefined,
    };

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <ToolInlineBody
          mode="card"
          tool={tool}
          normalizedToolName="UnknownTool"
          metadata={null}
          messages={[]}
          detailLevel="summary"
          setHeaderActions={() => {}}
        />
      );
    });

    expect(tree.root.findAllByType('StructuredResultView' as any).length).toBe(1);
    expect(tree.root.findAllByType('ToolError' as any).length).toBe(0);
  });

  it('uses structured fallback for error payloads that match SubAgentRun result shape', async () => {
    const { ToolInlineBody } = await import('./ToolInlineBody');

    const tool: any = {
      id: 't-subagent-shape',
      name: 'UnknownTool',
      state: 'error',
      input: {},
      result: {
        status: 'timeout',
        runId: 'run_test',
        callId: 'subagent_run_test',
        error: { code: 'execution_run_timeout', message: 'Timed out' },
      },
      createdAt: 1,
      startedAt: null,
      completedAt: null,
      permission: undefined,
    };

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <ToolInlineBody
          mode="card"
          tool={tool}
          normalizedToolName="UnknownTool"
          metadata={null}
          messages={[]}
          detailLevel="summary"
          setHeaderActions={() => {}}
        />
      );
    });

    expect(tree.root.findAllByType('StructuredResultView' as any).length).toBe(1);
    expect(tree.root.findAllByType('ToolError' as any).length).toBe(0);
  });
});
