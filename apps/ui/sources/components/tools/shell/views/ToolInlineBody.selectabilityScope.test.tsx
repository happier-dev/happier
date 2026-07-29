import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  findTestInstanceByTypeWithProps,
  pressTestInstanceAsync,
  renderScreen,
  standardCleanup,
} from '@/dev/testkit';
import { installToolShellCommonModuleMocks } from './ToolView.testHelpers';
import { createUseSettingMock } from '@/dev/testkit/mocks/storage';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installToolShellCommonModuleMocks({
  storage: async (importOriginal) => {
    const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleMock({
      importOriginal,
      overrides: {
        useSetting: createUseSettingMock({ fallback: (key) => {
          if (key === 'filesDiffTokenizationMaxBytes') return 128;
          return undefined;
        } }),
      },
    });
  },
  text: async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
    translate: (key: string) => key,
  }),
});

const specificToolViewState = vi.hoisted(() => ({
  enabled: false,
  contextValues: [] as unknown[],
}));

vi.mock('@/components/ui/text/Text', () => ({
  Text: (props: any) => React.createElement('Text', props, props.children),
  TextSelectabilityScope: (props: any) => React.createElement('TextSelectabilityScope', props, props.children),
}));

vi.mock('@/components/tools/shell/presentation/ToolError', () => ({
  ToolError: (props: any) => React.createElement('ToolError', props),
}));

vi.mock('@/components/tools/renderers/core/_registry', async () => {
  const ReactModule = await import('react');
  const { ToolHeaderActionsContext } = await import('@/components/tools/shell/presentation/ToolHeaderActionsContext');
  return {
    getToolViewComponent: () => {
      if (!specificToolViewState.enabled) return null;
      return function SpecificToolView() {
        specificToolViewState.contextValues.push(ReactModule.useContext(ToolHeaderActionsContext));
        return ReactModule.createElement('SpecificToolView');
      };
    },
  };
});

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
  CodeView: (props: any) => React.createElement('CodeView', props),
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
    specificToolViewState.enabled = false;
    specificToolViewState.contextValues = [];
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

  it('clamps oversized default input and output before rendering CodeView', async () => {
    const { ToolInlineBody } = await import('./ToolInlineBody');
    const { TranscriptRowLayoutMutationProvider } = await import(
      '@/components/sessions/transcript/measurement/TranscriptRowLayoutMutationContext'
    );
    const rowMutation = vi.fn();
    const large = 'x'.repeat(2_000);
    const tool: any = {
      id: 't-large',
      name: 'UnknownTool',
      state: 'completed',
      input: { large },
      result: large,
      createdAt: 1,
      startedAt: null,
      completedAt: 2,
      permission: undefined,
    };

    const screen = await renderScreen(
      <TranscriptRowLayoutMutationProvider value={rowMutation}>
        <ToolInlineBody
          mode="card"
          tool={tool}
          normalizedToolName="UnknownTool"
          metadata={null}
          messages={[]}
          messageId="message-large"
          detailLevel="summary"
          setHeaderActions={() => {}}
        />
      </TranscriptRowLayoutMutationProvider>
    );

    const renderedCode = screen.findAllByType('CodeView' as any).map((node) => String(node.props.code));
    expect(renderedCode).toHaveLength(2);
    expect(renderedCode.every((code) => code.length < 500)).toBe(true);
    expect(screen.getTextContent()).toContain('toolView.showFullContent');

    const showFull = screen.findAllByType('Pressable' as any)
      .find((node) => typeof node.props.onPress === 'function');
    await pressTestInstanceAsync(showFull, 'show full tool content');
    expect(rowMutation).toHaveBeenCalledWith({
      reason: 'expand',
      sourceId: 'tool-code:message-large:input',
    });
  });

  it('keeps the tool header actions context value stable across equivalent rerenders', async () => {
    specificToolViewState.enabled = true;
    const { ToolInlineBody } = await import('./ToolInlineBody');
    const tool: any = {
      id: 't-specific',
      name: 'Specific',
      state: 'completed',
      input: {},
      result: 'ok',
      createdAt: 1,
      startedAt: null,
      completedAt: 2,
      permission: undefined,
    };
    const setHeaderActions = vi.fn();

    const screen = await renderScreen(
      <ToolInlineBody
        mode="card"
        tool={tool}
        normalizedToolName="Specific"
        metadata={null}
        messages={[]}
        detailLevel="summary"
        setHeaderActions={setHeaderActions}
      />
    );

    await screen.update(
      <ToolInlineBody
        mode="card"
        tool={tool}
        normalizedToolName="Specific"
        metadata={null}
        messages={[]}
        detailLevel="summary"
        setHeaderActions={setHeaderActions}
      />
    );

    expect(specificToolViewState.contextValues).toHaveLength(2);
    expect(specificToolViewState.contextValues[1]).toBe(specificToolViewState.contextValues[0]);
  });
});
