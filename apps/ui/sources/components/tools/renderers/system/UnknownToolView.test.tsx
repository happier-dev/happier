import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { makeToolCall, makeToolViewProps, renderScreen } from '@/dev/testkit';
import { installSystemToolRendererCommonModuleMocks } from './systemToolRendererTestHelpers';
import { TranscriptFindProvider } from '@/components/sessions/transcript/find/TranscriptFindContext';
import { createTranscriptFindRowStore } from '@/components/sessions/transcript/find/transcriptFindRowStore';

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
    it('projects the same normalized output as the full renderer and excludes unrendered result metadata', async () => {
        const { projectUnknownDisplayText } = await import('./UnknownToolView');
        const tool = makeToolCall({ name: 'FutureTool', state: 'completed', input: {}, result: { text: 'visible output', _raw: { hidden: 'metadata-only' } } });
        const blocks = projectUnknownDisplayText(tool);
        expect(blocks.find((block) => block.id === 'tool-output')?.text).toBe('visible output');
        expect(blocks.some((block) => block.text.includes('metadata-only'))).toBe(false);
        const jsonTool = makeToolCall({ ...tool, result: { payload: 'actual displayed JSON' } });
        expect(projectUnknownDisplayText(jsonTool).find((block) => block.id === 'tool-output')?.text).toBe(JSON.stringify(jsonTool.result, null, 2));
    });

    it('reveals full output with the same source offsets when a match is beyond the summary clamp', async () => {
        codeViewSpy.mockClear();
        const { UnknownToolView } = await import('./UnknownToolView');
        const text = 'x'.repeat(850) + 'needle';
        const tool = makeToolCall({ name: 'FutureTool', state: 'completed', input: {}, result: { text } });
        const store = createTranscriptFindRowStore();
        const ranges = [{ start: 850, end: 856, current: true }];
        store.publish(new Map([['find-tool', { blocks: [{ id: 'tool-output', sourceRanges: ranges }], reveal: { blockId: 'tool-output', requestId: 1 } }]]));
        await renderScreen(<TranscriptFindProvider store={store}><UnknownToolView {...makeToolViewProps(tool, { messageId: 'find-tool', detailLevel: 'summary' })} /></TranscriptFindProvider>);
        expect(codeViewSpy).toHaveBeenCalledWith(expect.objectContaining({ code: text, findRanges: ranges }));
    });
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
