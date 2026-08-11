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

installSystemToolRendererCommonModuleMocks();

describe('TaskStopView', () => {
    it('names the command it stopped, from the SDK-attested TaskStopOutput result', async () => {
        const { TaskStopView } = await import('./TaskStopView');

        const tool = makeToolCall({
            name: 'TaskStop',
            state: 'completed',
            input: { task_id: 'task_1' },
            result: { message: 'Stopped task_1', task_id: 'task_1', task_type: 'local_bash', command: 'sleep 600' },
        });

        const screen = await renderScreen(React.createElement(TaskStopView, makeToolViewProps(tool)));
        const text = collectHostText(screen.tree);

        expect(text).toContain('sleep 600');
        expect(text).toContain('Stopped task_1');
    });

    it('renders nothing while the stop is still in flight, rather than an empty labelled box', async () => {
        const { TaskStopView } = await import('./TaskStopView');

        const tool = makeToolCall({
            name: 'TaskStop',
            state: 'running',
            input: { task_id: 'task_1' },
            result: null,
        });

        const screen = await renderScreen(React.createElement(TaskStopView, makeToolViewProps(tool)));
        expect(collectHostText(screen.tree)).toHaveLength(0);
    });
});
