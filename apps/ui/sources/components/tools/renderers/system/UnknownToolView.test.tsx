import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { makeToolCall, makeToolViewProps, renderScreen } from '@/dev/testkit';
import { installSystemToolRendererCommonModuleMocks } from './systemToolRendererTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../shell/presentation/ToolSectionView', () => ({
    ToolSectionView: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

const codeViewSpy = vi.fn();
vi.mock('@/components/ui/media/CodeView', () => ({
    CodeView: (props: any) => {
        codeViewSpy(props);
        return React.createElement('CodeView', props);
    },
}));

installSystemToolRendererCommonModuleMocks();

describe('UnknownToolView', () => {
    it('renders camelCase command execution aggregatedOutput as normalized output in full view', async () => {
        codeViewSpy.mockClear();
        const { UnknownToolView } = await import('./UnknownToolView');

        const tool = makeToolCall({
            name: 'FutureCommandTool',
            state: 'completed',
            input: { command: 'pwd' },
            result: {
                type: 'commandExecution',
                aggregatedOutput: '/Users/leeroy/Documents/Development/happier/dev\n',
                exitCode: 0,
            },
        });

        await renderScreen(React.createElement(UnknownToolView, makeToolViewProps(tool, { detailLevel: 'full' })));

        expect(codeViewSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                code: '/Users/leeroy/Documents/Development/happier/dev\n',
            }),
        );
        expect(codeViewSpy).not.toHaveBeenCalledWith(
            expect.objectContaining({
                code: expect.stringContaining('aggregatedOutput'),
            }),
        );
    });
});
