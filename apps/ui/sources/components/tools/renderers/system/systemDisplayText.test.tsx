import React from 'react';
import { describe, expect, it } from 'vitest';
import { makeToolCall, makeToolViewProps, renderScreen } from '@/dev/testkit';
import { TranscriptFindProvider } from '@/components/sessions/transcript/find/TranscriptFindContext';
import { createTranscriptFindRowStore } from '@/components/sessions/transcript/find/transcriptFindRowStore';

describe('system tool display text', () => {
    it('paints a full running Bash output match using its actual command renderer', async () => {
        const { BashView } = await import('./BashView');
        const stdout = 'needle\n' + 'x'.repeat(9000);
        const tool = makeToolCall({ name: 'Bash', state: 'running', input: { command: 'echo hi' }, result: { stdout } });
        const store = createTranscriptFindRowStore();
        store.publish(new Map([['bash', { blocks: [{ id: 'tool-stdout', sourceRanges: [{ start: 0, end: 6, current: true }] }], reveal: { blockId: 'tool-stdout', requestId: 1 } }]]));
        const screen = await renderScreen(<TranscriptFindProvider store={store}><BashView {...makeToolViewProps(tool, { messageId: 'bash' })} /></TranscriptFindProvider>);
        expect(screen.getTextContent()).toContain('x'.repeat(9000));
        expect(screen.getTextContent()).toContain('needle');
        expect(screen.findAllHostsByTestId('find-match-current')).toHaveLength(1);
        expect(screen.findAllHostsByTestId('find-match-current')[0].props.children).toBe('needle');
    });

    it('paints a decoded fallback output match beyond its summary clamp', async () => {
        const { UnknownToolView } = await import('./UnknownToolView');
        const output = 'x'.repeat(900) + '\nneedle';
        const tool = makeToolCall({ name: 'NewTool', state: 'completed', result: { output, secret: 'not-rendered' } });
        const store = createTranscriptFindRowStore();
        store.publish(new Map([['unknown', { blocks: [{ id: 'tool-output', sourceRanges: [{ start: 901, end: 907, current: true }] }], reveal: { blockId: 'tool-output', requestId: 1 } }]]));
        const screen = await renderScreen(<TranscriptFindProvider store={store}><UnknownToolView {...makeToolViewProps(tool, { messageId: 'unknown', detailLevel: 'summary' })} /></TranscriptFindProvider>);
        expect(screen.getTextContent()).toContain('x'.repeat(900));
        expect(screen.getTextContent()).toContain('needle');
        expect(screen.getTextContent()).not.toContain('not-rendered');
        expect(screen.findAllHostsByTestId('find-match-current')).toHaveLength(1);
        expect(screen.findAllHostsByTestId('find-match-current')[0].props.children).toBe('needle');
    });
    it('projects the actual task output and stop strings without task metadata', async () => {
        const { TaskOutputView, projectTaskOutputDisplayText } = await import('./TaskOutputView');
        const { projectTaskStopDisplayText } = await import('./TaskStopView');
        const output = 'needle\n' + 'x'.repeat(5000);
        const tool = makeToolCall({ name: 'TaskOutput', state: 'completed', result: { output, task_id: 'hidden-task-id' } });
        expect(projectTaskOutputDisplayText(tool).map((block) => block.text)).toEqual([output]);
        expect(projectTaskStopDisplayText(makeToolCall({ name: 'TaskStop', result: { command: '  echo hello  ', message: ' stopped ', task_id: 'hidden-task-id' } })).map((block) => block.text).join('\n')).toContain('echo hello');
        expect(projectTaskStopDisplayText(makeToolCall({ name: 'TaskStop', result: { command: 'echo hello', task_id: 'hidden-task-id' } })).map((block) => block.text).join('\n')).not.toContain('hidden');
        const ranges = [{ start: 0, end: 6, current: true }];
        const store = createTranscriptFindRowStore();
        store.publish(new Map([['task', { blocks: [{ id: 'tool-task-output-body', sourceRanges: ranges }] }]]));
        const screen = await renderScreen(<TranscriptFindProvider store={store}><TaskOutputView {...makeToolViewProps(tool, { messageId: 'task' })} /></TranscriptFindProvider>);
        expect(screen.getTextContent()).toContain('x'.repeat(5000));
        const highlighted = screen.findAllHostsByTestId('find-match-current');
        expect(highlighted).toHaveLength(1);
        expect(highlighted[0].props.children).toBe('needle');
    });

    it('reveals later indexing options and indexes only their displayed labels', async () => {
        const { WorkspaceIndexingPermissionView, projectWorkspaceIndexingPermissionDisplayText } = await import('./WorkspaceIndexingPermissionView');
        const tool = makeToolCall({ name: 'WorkspaceIndexingPermission', input: { toolCall: { title: 'Index workspace', options: { options: [{ id: 'hidden-id', name: 'First' }, { name: 'Second' }, { name: 'needle', kind: 'hidden-kind' }] } } } });
        const blocks = projectWorkspaceIndexingPermissionDisplayText(tool);
        expect(blocks.find((block) => block.id === 'tool-indexing-option-2')?.text).toBe('• needle');
        expect(blocks.map((block) => block.text).join('\n')).not.toContain('hidden');
        const store = createTranscriptFindRowStore();
        store.publish(new Map([['index', { blocks: [{ id: 'tool-indexing-option-2', sourceRanges: [{ start: 2, end: 8, current: true }] }] }]]));
        const screen = await renderScreen(<TranscriptFindProvider store={store}><WorkspaceIndexingPermissionView {...makeToolViewProps(tool, { messageId: 'index' })} /></TranscriptFindProvider>);
        expect(screen.getTextContent()).toContain('needle');
        expect(screen.findAllHostsByTestId('find-match-current')).toHaveLength(1);
    });

    it('projects the displayed history preview role and text, excluding hidden payload fields', async () => {
        const { projectAcpHistoryImportDisplayText } = await import('./AcpHistoryImportView');
        const tool = makeToolCall({ name: 'AcpHistoryImport', permission: { id: 'history', status: 'pending' }, input: { provider: 'acp', remoteSessionId: 'remote-1', note: 'Review history', remoteTail: [{ role: 'assistant', text: 'needle', secret: 'hidden-preview' }], metadata: 'hidden-metadata' } });
        const blocks = projectAcpHistoryImportDisplayText(tool);
        expect(blocks.find((block) => block.id === 'tool-history-remote-0')?.text).toBe('assistant: needle');
        expect(blocks.map((block) => block.text).join('\n')).not.toContain('hidden');
        expect(projectAcpHistoryImportDisplayText(makeToolCall({ name: 'AcpHistoryImport', input: tool.input, permission: undefined, id: undefined }))).toEqual([]);
    });
});
