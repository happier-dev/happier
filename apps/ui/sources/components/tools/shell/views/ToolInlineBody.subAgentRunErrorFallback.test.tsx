import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    renderWithSessionTranscriptSource as renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { installToolShellCommonModuleMocks } from './ToolView.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installToolShellCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

const { ToolInlineBody } = await import('./ToolInlineBody');
const { SubAgentRunView } = await import('@/components/tools/renderers/workflow/SubAgentRunView');
const { SubAgentView } = await import('@/components/tools/renderers/workflow/SubAgentView');
const { ToolError } = await import('@/components/tools/shell/presentation/ToolError');

describe('ToolInlineBody (SubAgentRun error fallback)', () => {
    it('does not turn a cancelled result into an error body or Find error text', async () => {
        const tool = { name: 'unrecognized-tool', description: null, state: 'error' as const, input: {},
            result: { status: 'cancelled', error: 'The turn ended before this tool returned a result.' },
            createdAt: 1, startedAt: 1, completedAt: 2 };
        const screen = await renderScreen(<ToolInlineBody mode="timeline" tool={tool}
            normalizedToolName={tool.name} metadata={null} messages={[]} detailLevel="summary"
            setHeaderActions={() => {}} />);
        expect(screen.findAllByType(ToolError)).toHaveLength(0);
        const { resolveToolInlineErrorDisplay } = await import('../presentation/resolveToolInlineErrorDisplay');
        expect(resolveToolInlineErrorDisplay({ tool, normalizedToolName: tool.name, metadata: null }))
            .toEqual({ override: null, append: null, generic: null });
    });

    afterEach(() => {
        standardCleanup();
    });

    it('suppresses default ToolError for SubAgentRun when specific renderer is available', async () => {

        const screen = await renderScreen(
            <ToolInlineBody
                mode="timeline"
                tool={{
                    id: 't-subagent',
                    name: 'SubAgentRun',
                    description: null,
                    state: 'error',
                    input: {},
                    result: { status: 'timeout', error: { code: 'execution_run_timeout', message: 'Timed out' } },
                    createdAt: 1,
                    startedAt: null,
                    completedAt: null,
                }}
                normalizedToolName="SubAgentRun"
                metadata={null}
                messages={[]}
                detailLevel="summary"
                setHeaderActions={() => {}}
            />,
        );

        expect(screen.findAllByType(SubAgentRunView)).toHaveLength(1);
        expect(screen.findAllByType(ToolError)).toHaveLength(0);
        expect(screen.getTextContent()).toContain('Timed out');
    });

    it('keeps default ToolError behavior for non-SubAgentRun errors', async () => {

        const screen = await renderScreen(
            <ToolInlineBody
                mode="timeline"
                tool={{
                    id: 't-task',
                    name: 'Task',
                    description: null,
                    state: 'error',
                    input: {},
                    result: { message: 'Task failed' },
                    createdAt: 1,
                    startedAt: null,
                    completedAt: null,
                }}
                normalizedToolName="Task"
                metadata={null}
                messages={[]}
                detailLevel="summary"
                setHeaderActions={() => {}}
            />,
        );

        expect(screen.findAllByType(SubAgentView)).toHaveLength(1);
        expect(screen.findAllByType(ToolError)).toHaveLength(1);
        expect(screen.getTextContent()).toContain('Task failed');
    });
});
