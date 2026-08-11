import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { collectHostText, makeToolCall, makeToolViewProps, renderScreen } from '@/dev/testkit';

import { installSystemToolRendererCommonModuleMocks } from './systemToolRendererTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../shell/presentation/ToolSectionView', () => ({
    ToolSectionView: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
    TextSelectabilityScope: (props: any) => React.createElement('TextSelectabilityScope', props, props.children),
}));

const codeViewSpy = vi.fn();
vi.mock('@/components/ui/media/CodeView', () => ({
    CodeView: (props: any) => {
        codeViewSpy(props);
        return React.createElement('CodeView', props);
    },
}));

installSystemToolRendererCommonModuleMocks();

describe('TaskOutputView', () => {
    it('says the model is waiting while a blocking read is in flight', async () => {
        const { TaskOutputView } = await import('./TaskOutputView');

        const tool = makeToolCall({
            name: 'TaskOutput',
            state: 'running',
            input: { task_id: 'task_1', block: true, timeout: 30_000 },
            result: null,
        });

        const screen = await renderScreen(React.createElement(TaskOutputView, makeToolViewProps(tool)));
        expect(collectHostText(screen.tree)).toContain('tools.taskOutputView.waitingForTask');
    });

    it('does not claim the model is waiting for a non-blocking read', async () => {
        const { TaskOutputView } = await import('./TaskOutputView');

        const tool = makeToolCall({
            name: 'TaskOutput',
            state: 'running',
            input: { task_id: 'task_1', block: false, timeout: 0 },
            result: null,
        });

        const screen = await renderScreen(React.createElement(TaskOutputView, makeToolViewProps(tool)));
        expect(collectHostText(screen.tree)).toHaveLength(0);
    });

    it('renders nothing when the launcher blanked the payload, instead of an empty output block', async () => {
        codeViewSpy.mockClear();
        const { TaskOutputView } = await import('./TaskOutputView');

        // `claudeRemoteLauncher.ts` blanks TaskOutput tool-result content to keep the transcript
        // compact, so the common transcript case really is an empty string.
        const tool = makeToolCall({
            name: 'TaskOutput',
            state: 'completed',
            input: { task_id: 'task_1', block: true, timeout: 30_000 },
            result: '',
        });

        const screen = await renderScreen(React.createElement(TaskOutputView, makeToolViewProps(tool)));
        expect(collectHostText(screen.tree)).toHaveLength(0);
        expect(codeViewSpy).not.toHaveBeenCalled();
    });

    it('tails a retained payload rather than dumping a whole JSONL transcript', async () => {
        codeViewSpy.mockClear();
        const { TaskOutputView } = await import('./TaskOutputView');

        const longOutput = 'y'.repeat(6000);
        const tool = makeToolCall({
            name: 'TaskOutput',
            state: 'completed',
            input: { task_id: 'task_1', block: true, timeout: 30_000 },
            result: { output: longOutput },
        });

        await renderScreen(React.createElement(TaskOutputView, makeToolViewProps(tool)));

        const code = codeViewSpy.mock.calls.at(-1)?.[0] as { code?: string };
        expect(code.code).toHaveLength(4001);
        expect(code.code).toMatch(/^…/);
    });
});
