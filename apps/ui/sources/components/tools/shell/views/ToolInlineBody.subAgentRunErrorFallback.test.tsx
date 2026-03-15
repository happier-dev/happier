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
    getToolViewComponent: () => () => React.createElement('SpecificToolView'),
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

describe('ToolInlineBody (SubAgentRun error fallback)', () => {
    it('suppresses default ToolError for SubAgentRun when specific renderer is available', async () => {
        const { ToolInlineBody } = await import('./ToolInlineBody');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <ToolInlineBody
                    mode="timeline"
                    tool={{
                        id: 't-subagent',
                        name: 'SubAgentRun',
                        state: 'error',
                        input: {},
                        result: { status: 'timeout', error: { code: 'execution_run_timeout', message: 'Timed out' } },
                        createdAt: 1,
                        startedAt: null,
                        completedAt: null,
                    } as any}
                    normalizedToolName="SubAgentRun"
                    metadata={null}
                    messages={[]}
                    detailLevel="summary"
                    setHeaderActions={() => {}}
                />,
            );
        });

        expect(tree.root.findAllByType('SpecificToolView' as any)).toHaveLength(1);
        expect(tree.root.findAllByType('ToolError' as any)).toHaveLength(0);
    });

    it('keeps default ToolError behavior for non-SubAgentRun errors', async () => {
        const { ToolInlineBody } = await import('./ToolInlineBody');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <ToolInlineBody
                    mode="timeline"
                    tool={{
                        id: 't-task',
                        name: 'Task',
                        state: 'error',
                        input: {},
                        result: { message: 'Task failed' },
                        createdAt: 1,
                        startedAt: null,
                        completedAt: null,
                    } as any}
                    normalizedToolName="Task"
                    metadata={null}
                    messages={[]}
                    detailLevel="summary"
                    setHeaderActions={() => {}}
                />,
            );
        });

        expect(tree.root.findAllByType('SpecificToolView' as any)).toHaveLength(1);
        expect(tree.root.findAllByType('ToolError' as any)).toHaveLength(1);
    });
});
