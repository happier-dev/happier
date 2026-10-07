import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup, withPopoverWebGlobals } from '@/dev/testkit';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import { getStorage } from '@/sync/domains/state/storage';
import { ChangedFilesReviewIndex } from './ChangedFilesReviewIndex';
import { ChangedFilesReviewPhoneFileControl } from './ChangedFilesReviewPhoneFileControl';
import { FilesystemBrowserRow } from '@/components/ui/filesystemBrowser/FilesystemBrowserRow';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

const initialSettings = getStorage().getState().settings;
let restoreWebGlobals: () => void;
beforeEach(() => { restoreWebGlobals = withPopoverWebGlobals(); });
afterEach(() => {
    standardCleanup();
    restoreWebGlobals();
    getStorage().setState({ settings: initialSettings });
});

function files(count = 80): ScmFileStatus[] {
    return Array.from({ length: count }, (_, index) => ({ fileName: `file-${index}.ts`, filePath: 'src',
        fullPath: `src/file-${index}.ts`, status: 'modified', isIncluded: false, linesAdded: 1, linesRemoved: 1 }));
}

// Host geometry is the platform boundary. The real dropdown measures its
// trigger before drawing its real menu; no Popover/menu logic is replaced.
const measuredHost = () => ({
    offsetTop: 0,
    offsetHeight: 48,
    getBoundingClientRect: () => ({ x: 0, y: 0, left: 0, top: 0, right: 320, bottom: 48, width: 320, height: 48 }),
    measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(0, 0, 320, 48),
});

async function settleMenuPress(screen: Awaited<ReturnType<typeof renderScreen>>, testId: string) {
    await screen.pressByTestIdAsync(testId);
    // Dropdown opens/selects after its current press frame. Wait for that real
    // clock boundary inside act, rather than asserting against the closed menu.
    await act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 0)); });
    await flushHookEffects({ frames: 1 });
}

it('projects phone picker labels only while the list menu is open, without losing selection', async () => {
    getStorage().setState({ settings: { ...initialSettings, scmChangedFilesLayout: 'list' } });
    const entries = files();
    let inactiveLabelReads = 0;
    for (const entry of entries.slice(1)) {
        const name = entry.fileName;
        Object.defineProperty(entry, 'fileName', { get: () => { inactiveLabelReads += 1; return name; } });
    }
    const selected: string[] = [];
    const screen = await renderScreen(<ChangedFilesReviewPhoneFileControl files={entries} activePath={entries[0]!.fullPath}
        rootPath="/repo" commentCountByPath={new Map()} onFocusPath={(path) => selected.push(path)} />, { createNodeMock: measuredHost });
    expect(screen.getTextContent()).toContain('file-0.ts');
    expect(inactiveLabelReads).toBe(0);
    await settleMenuPress(screen, 'scm-comparison-file-trigger');
    expect(screen.getTextContent()).toContain('file-1.ts');
    expect(inactiveLabelReads).toBeGreaterThan(0);
    const choice = screen.findAll((node) => node.props.accessibilityLabel === entries[1]!.fullPath
        && typeof node.props.onPress === 'function')[0];
    expect(choice).toBeDefined();
    await act(async () => {
        choice!.props.onPress();
        await vi.waitFor(() => expect(selected).toEqual([entries[1]!.fullPath]));
    });
});

it('does not build discarded list metadata in tree mode and builds it when the person switches to list', async () => {
    getStorage().setState({ settings: { ...initialSettings, scmChangedFilesLayout: 'tree' } });
    const entries = files();
    let commentReads = 0;
    class Comments extends Map<string, number> {
        override get(path: string) { commentReads += 1; return super.get(path); }
    }
    const screen = await renderScreen(<ChangedFilesReviewIndex files={entries} activePath={entries[0]!.fullPath}
        rootPath="/repo" placement="comparisonStream" commentCountByPath={new Comments([[entries[0]!.fullPath, 2]])}
        onFocusPath={() => {}} />);
    expect(screen.findByTestId('scm-review-index')).not.toBeNull();
    expect(commentReads).toBe(0);
    await act(async () => getStorage().setState({ settings: { ...initialSettings, scmChangedFilesLayout: 'list' } }));
    expect(commentReads).toBe(entries.length);
    expect(screen.getTextContent()).toContain('file-0.ts');
    expect(screen.getTextContent()).toContain('2');
});

it('highlights the file being read in the phone tree picker without a separate review scope', async () => {
    getStorage().setState({ settings: { ...initialSettings, scmChangedFilesLayout: 'tree' } });
    const entries = files(2).map((file) => ({ ...file, filePath: '', fullPath: file.fileName }));
    const selected: string[] = [];
    const screen = await renderScreen(<ChangedFilesReviewPhoneFileControl files={entries} activePath={entries[1]!.fullPath}
        rootPath="/repo" commentCountByPath={new Map()} onFocusPath={(path) => selected.push(path)} />, { createNodeMock: measuredHost });
    await settleMenuPress(screen, 'scm-comparison-file-trigger');
    expect(screen.findAll((node) => node.type === FilesystemBrowserRow && node.props.selected)
        .map((node) => node.props.node.path)).toEqual([entries[1]!.fullPath]);
    await settleMenuPress(screen, `repository-tree-row-${entries[0]!.fullPath}`);
    expect(selected).toEqual([entries[0]!.fullPath]);
});
