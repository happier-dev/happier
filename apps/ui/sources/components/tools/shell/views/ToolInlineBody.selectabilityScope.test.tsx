import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  findTestInstanceByTypeWithProps,
  renderScreen,
  standardCleanup,
} from '@/dev/testkit';
import { installToolShellCommonModuleMocks } from './ToolView.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installToolShellCommonModuleMocks({
  text: async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
    translate: (key: string) => key,
  }),
});

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

vi.mock('@/components/tools/shell/presentation/ToolSectionView', async (importOriginal) => {
    const { installToolSectionViewModuleMock } = await import('@/dev/testkit/mocks/toolSectionView');
    return installToolSectionViewModuleMock('host')(importOriginal);
});

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

describe('ToolInlineBody (text selection scope)', () => {
  afterEach(() => {
    standardCleanup();
  });

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

    const screen = await renderScreen(
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

    expect(
      findTestInstanceByTypeWithProps(screen, 'TextSelectabilityScope', {
        selectable: true,
      }),
    ).toBeTruthy();
    expect(screen.findByType('ToolError' as any)).toBeTruthy();
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

    const screen = await renderScreen(
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

    expect(screen.findAllByType('StructuredResultView' as any)).toHaveLength(1);
    expect(screen.findAllByType('ToolError' as any)).toHaveLength(0);
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

    const screen = await renderScreen(
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

    expect(screen.findAllByType('StructuredResultView' as any)).toHaveLength(1);
    expect(screen.findAllByType('ToolError' as any)).toHaveLength(0);
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

    const screen = await renderScreen(
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

    expect(screen.findAllByType('StructuredResultView' as any)).toHaveLength(1);
    expect(screen.findAllByType('ToolError' as any)).toHaveLength(0);
  });
});
