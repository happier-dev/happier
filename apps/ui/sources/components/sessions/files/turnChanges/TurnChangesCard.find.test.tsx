import * as React from 'react';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { TranscriptFindProvider } from '@/components/sessions/transcript/find/TranscriptFindContext';
import { createTranscriptFindRowStore } from '@/components/sessions/transcript/find/transcriptFindRowStore';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';

const settingsWrites = vi.hoisted(() => vi.fn());
vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub, createUseSettingMutableMockFromReader } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useSettingMutable: createUseSettingMutableMockFromReader((key) => [key === 'scmChangedFilesLayout' ? 'tree' : 'comfortable', settingsWrites]),
    });
});

function file(fullPath: string): ScmFileStatus {
    const slash = fullPath.lastIndexOf('/');
    return { fullPath, fileName: fullPath.slice(slash + 1), filePath: slash >= 0 ? fullPath.slice(0, slash) : '', status: 'modified', isIncluded: false, linesAdded: 1, linesRemoved: 2 };
}

describe('turn-changes recap Find', () => {
    it('reveals and decorates a late file in a collapsed tree-preferred recap without writing its preference', async () => {
        const { TurnChangesCard } = await import('./TurnChangesCard');
        const files = [...Array.from({ length: 13 }, (_, index) => file(`src/deep/file${index}.ts`)), file('src/deep/needle.ts')];
        const store = createTranscriptFindRowStore();
        const blockId = 'tool-turn-changes-file-13-path';
        store.publish(new Map([['message', { blocks: [{ id: blockId, sourceRanges: [{ start: 9, end: 15, current: true }] }], reveal: { blockId, requestId: 1 } }]]));
        const screen = await renderScreen(<TranscriptFindProvider store={store}><TurnChangesCard {...{ files, onOpenFile: () => {}, messageId: 'message', testID: 'recap' }} /></TranscriptFindProvider>);
        const current = screen.tree.root.findAll((node) => node.props.testID === 'find-match-current');
        expect(current.length).toBeGreaterThan(0);
        expect(current[current.length - 1].children.join('')).toBe('needle');
        expect(settingsWrites).not.toHaveBeenCalled();
        await act(async () => { store.publish(new Map()); });
        expect(screen.findByTestId('recap-toggle')?.props.accessibilityState).toEqual({ expanded: false });
    });

    it('decorates a header-only match without opening or building file rows', async () => {
        const { TurnChangesCard } = await import('./TurnChangesCard');
        const store = createTranscriptFindRowStore();
        store.publish(new Map([['message', { blocks: [{ id: 'tool-turn-changes-title', sourceRanges: [{ start: 0, end: 1, current: true }] }], reveal: { blockId: 'tool-turn-changes-title', requestId: 1 } }]]));
        const screen = await renderScreen(<TranscriptFindProvider store={store}><TurnChangesCard {...{ files: [file('src/needle.ts')], onOpenFile: () => {}, messageId: 'message', testID: 'header' }} /></TranscriptFindProvider>);
        expect(screen.tree.root.findAll((node) => node.props.testID === 'find-match-current').length).toBeGreaterThan(0);
        expect(screen.findByTestId('header-toggle')?.props.accessibilityState).toEqual({ expanded: false });
        expect(screen.tree.root.findAll((node) => typeof node.props.testID === 'string' && node.props.testID.startsWith('scm-change-row-container:'))).toHaveLength(0);
    });

    it('uses the normalized displayed path and reveals its separator alongside renamed-from text, never raw diff fields', async () => {
        const { TurnChangesCard, projectTurnChangesCardDisplayText } = await import('./TurnChangesCard');
        const files = [{ ...file('src/new.ts'), status: 'renamed' as const, oldPath: 'legacy/old.ts', unifiedDiff: 'hidden raw diff needle' }];
        const blocks = projectTurnChangesCardDisplayText(files);
        expect(blocks.map((block) => block.text).join(' ')).not.toContain('hidden raw diff needle');
        const path = blocks.find((block) => block.id === 'tool-turn-changes-file-0-path')!;
        const rename = blocks.find((block) => block.id === 'tool-turn-changes-file-0-rename')!;
        expect(path.text).toBe('src/new.ts');
        const store = createTranscriptFindRowStore();
        store.publish(new Map([['message', { blocks: [
            { id: path.id, sourceRanges: [{ start: 0, end: 4, current: true }] },
            { id: rename.id, sourceRanges: [{ start: 0, end: rename.text.length, current: false }] },
        ], reveal: { blockId: path.id, requestId: 1 } }]]));
        const screen = await renderScreen(<TranscriptFindProvider store={store}><TurnChangesCard files={files} onOpenFile={() => {}} messageId="message" /></TranscriptFindProvider>);
        const current = screen.tree.root.findAll((node) => node.props.testID === 'find-match-current');
        expect(current[current.length - 1]?.children.join('')).toBe('src/');
        expect(screen.tree.root.findAll((node) => node.props.testID === 'find-match-all').some((node) => node.children.join('') === rename.text)).toBe(true);
    });
});
