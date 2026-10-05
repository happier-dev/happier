import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { collectHostText, makeToolViewProps, renderScreen } from '@/dev/testkit';
import { makeCompletedTool } from '../core/truncationView.testHelpers';
import { TranscriptFindProvider } from '@/components/sessions/transcript/find/TranscriptFindContext';
import { createTranscriptFindRowStore } from '@/components/sessions/transcript/find/transcriptFindRowStore';
import { buildCodeLinesFromTextDiff } from '@/components/ui/code/model/buildCodeLinesFromTextDiff';

describe('file-operation display text', () => {
    it('projects only selected read content and renders a match past the full-view cap', async () => {
        const { ReadView, projectReadDisplayText } = await import('./ReadView');
        const content = Array.from({ length: 450 }, (_, index) => `line ${index}`).join('\n');
        const tool = makeCompletedTool('Read', { file_path: '/tmp/a' }, {
            file: { content }, content: 'unused content', _raw: { secret: 'hidden metadata' },
        });
        const start = content.indexOf('line 449');
        const store = createTranscriptFindRowStore();
        store.publish(new Map([['message', { blocks: [{ id: 'tool-read', sourceRanges: [{ start, end: start + 8, current: true }] }], reveal: { blockId: 'tool-read', requestId: 1 } }]]));
        const screen = await renderScreen(<TranscriptFindProvider store={store}><ReadView {...makeToolViewProps(tool, { messageId: 'message', detailLevel: 'full' })} /></TranscriptFindProvider>);
        expect(collectHostText(screen.tree).join(' ').replace(/\s+/g, ' ')).toContain('line 449');
        const current = screen.tree.root.findAll((node) => node.props.testID === 'find-match-current');
        expect(current.length).toBeGreaterThan(0);
        expect(current[current.length - 1].children.join('')).toBe('line 449');
        expect(projectReadDisplayText(tool)).toEqual([{ id: 'tool-read', text: content, format: 'plain', kind: 'toolBody' }]);
    });

    it('projects the rendered path/line label and every excerpt while excluding arbitrary result fields', async () => {
        const { projectGrepDisplayText } = await import('./GrepView');
        const tool = makeCompletedTool('Grep', {}, { matches: [{ filePath: 'a.ts', line: 42, excerpt: 'visible', secret: 'hidden' }], secret: 'hidden' });
        expect(projectGrepDisplayText(tool)).toEqual([
            { id: 'tool-grep-0-label', text: 'a.ts:42', format: 'plain', kind: 'toolBody' },
            { id: 'tool-grep-0-excerpt', text: 'visible', format: 'plain', kind: 'toolBody' },
        ]);
    });

    it('renders the current edited-text match after the compact line clamp', async () => {
        const { EditView } = await import('./EditView');
        const oldText = Array.from({ length: 30 }, (_, index) => `old ${index}`).join('\n');
        const newText = Array.from({ length: 30 }, (_, index) => `new ${index}`).join('\n');
        const tool = makeCompletedTool('Edit', { file_path: '/tmp/a.ts', old_string: oldText, new_string: newText }, {});
        const line = buildCodeLinesFromTextDiff({ oldText, newText, contextLines: 30 }).find((line) => line.renderCodeText === 'new 29')!;
        const blockId = `tool-edit-line-${line.id}`;
        const store = createTranscriptFindRowStore();
        store.publish(new Map([['message', { blocks: [{ id: blockId, sourceRanges: [{ start: 0, end: 6, current: true }] }], reveal: { blockId, requestId: 1 } }]]));
        const screen = await renderScreen(<TranscriptFindProvider store={store}><EditView {...makeToolViewProps(tool, { messageId: 'message' })} /></TranscriptFindProvider>);
        expect(screen.tree.root.findAll((node) => node.props.testID === 'find-match-current').length).toBeGreaterThan(0);
    });

    it('reveals the current grep result past the full-view result cap', async () => {
        const { GrepView } = await import('./GrepView');
        const tool = makeCompletedTool('Grep', {}, { matches: Array.from({ length: 32 }, (_, index) => ({ excerpt: `result ${index}` })) });
        const blockId = 'tool-grep-31-excerpt';
        const store = createTranscriptFindRowStore();
        store.publish(new Map([['message', { blocks: [{ id: blockId, sourceRanges: [{ start: 0, end: 9, current: true }] }], reveal: { blockId, requestId: 1 } }]]));
        const screen = await renderScreen(<TranscriptFindProvider store={store}><GrepView {...makeToolViewProps(tool, { messageId: 'message', detailLevel: 'full' })} /></TranscriptFindProvider>);
        expect(collectHostText(screen.tree).join(' ')).toContain('result 31');
        expect(screen.tree.root.findAll((node) => node.props.testID === 'find-match-current').length).toBeGreaterThan(0);
    });

    it('projects unchanged diff context once and reveals a current match inside a collapsed file', async () => {
        const { DiffView, projectDiffDisplayText } = await import('./DiffView');
        const tool = makeCompletedTool('Diff', { files: [{ file_path: 'src/example.ts', oldText: 'shared\nold', newText: 'shared\nnew', secret: 'hidden' }], secret: 'hidden' }, {});
        const blocks = projectDiffDisplayText(tool);
        expect(blocks.filter((block) => block.text === 'shared')).toHaveLength(1);
        expect(blocks.map((block) => block.text).join(' ')).not.toContain('hidden');
        const target = blocks.find((block) => block.text === 'new')!;
        const store = createTranscriptFindRowStore();
        store.publish(new Map([['message', { blocks: [{ id: target.id, sourceRanges: [{ start: 0, end: 3, current: true }] }], reveal: { blockId: target.id, requestId: 1 } }]]));
        const screen = await renderScreen(<TranscriptFindProvider store={store}><DiffView {...makeToolViewProps(tool, { messageId: 'message' })} /></TranscriptFindProvider>);
        expect(screen.tree.root.findAll((node) => node.props.testID === 'find-match-current').length).toBeGreaterThan(0);
    });
});
