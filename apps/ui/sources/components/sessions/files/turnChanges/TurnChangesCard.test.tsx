import * as React from 'react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createTestSessionTranscriptSource, renderWithSessionTranscriptSource } from '@/dev/testkit/sessionTranscriptSource';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
    });
});

// The one list | tree preference (`scmChangedFilesLayout`): one shared value, like the account setting, so
// a write from the switch is read back by the list and the tree.
const layoutWrites: string[] = [];
let setLayoutState: ((value: string) => void) | null = null;
vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const ReactModule = await import('react');
    const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    let layout = 'list';
    const listeners = new Set<() => void>();
    const writeLayout = (next: string) => {
        layout = next;
        for (const listener of listeners) listener();
    };
    setLayoutState = writeLayout;
    return createPartialStorageModuleMock(importOriginal, {
        useSettingMutable: (key: string) => {
            const value = ReactModule.useSyncExternalStore(
                (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
                () => (key === 'scmChangedFilesLayout' ? layout : 'comfortable'),
            );
            if (key === 'scmChangedFilesLayout') {
                return [value, (next: string) => { layoutWrites.push(next); writeLayout(next); }];
            }
            return [value, () => {}];
        },
    });
});

// Presentation leaves stand in as host elements; the card's own disclosure, paging and preference logic run for real.
vi.mock('@/components/workspaces/scm/changes/ScmChangeRow', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    ScmChangeRow: (props: Record<string, unknown>) => React.createElement('ScmChangeRow', props),
}));
vi.mock('@/components/projects/files/WorkspaceRepositoryTreeList', () => ({
    WorkspaceRepositoryTreeList: (props: Record<string, unknown>) => React.createElement('WorkspaceRepositoryTreeList', props),
}));
vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: (props: Record<string, unknown>) => React.createElement('RoundButton', props),
}));
vi.mock('@/components/ui/navigation/SegmentedTabBar', () => ({
    SegmentedTabBar: (props: Record<string, unknown>) => React.createElement('SegmentedTabBar', props),
}));
vi.mock('@/components/ui/interactiveTargetSize', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    isTouchPrimaryPointer: () => false,
}));

const { TurnChangesCard } = await import('./TurnChangesCard');
const { TranscriptTurnChangesCard } = await import('./TranscriptTurnChangesCard');

function file(fullPath: string, linesAdded = 1, linesRemoved = 0): ScmFileStatus {
    const slash = fullPath.lastIndexOf('/');
    return {
        fileName: fullPath.slice(slash + 1),
        filePath: slash >= 0 ? fullPath.slice(0, slash) : '',
        fullPath,
        status: 'modified',
        isIncluded: false,
        linesAdded,
        linesRemoved,
    };
}

const FOUR = [
    file('apps/ui/sources/app/(app)/settings.tsx', 2, 2),
    file('apps/ui/sources/components/settings/SettingsModal.test.tsx', 38, 1),
    file('apps/ui/sources/components/settings/SettingsModal.tsx', 4, 2),
    file('apps/ui/sources/components/settings/useSettingsRouteKey.ts', 21, 0),
];
const BIG = Array.from({ length: 214 }, (_, i) => file(`apps/ui/sources/components/settings/pages/Page${String(i).padStart(3, '0')}.tsx`));

function rowPaths(screen: Awaited<ReturnType<typeof renderScreen>>): string[] {
    return screen.findAllByType('ScmChangeRow' as never).map((row) => (row.props.file as ScmFileStatus).fullPath);
}

function isInside(node: { parent: unknown } | null, ancestor: unknown): boolean {
    let current = node as { parent: unknown } | null;
    while (current) {
        if (current === ancestor) return true;
        current = current.parent as { parent: unknown } | null;
    }
    return false;
}

describe('TurnChangesCard (WT9 variant R)', () => {
    it('opens a transcript walkthrough on its own turn and Home, including after later turn data arrives', async () => {
        const navigate = vi.fn();
        const source = createTestSessionTranscriptSource({ sessionId: 's1', serverId: 'home-a', workspacePath: '/repo', navigate });
        const screen = await renderWithSessionTranscriptSource(
            <TranscriptTurnChangesCard sessionId="s1" serverId="home-a" turnId="turn-4" files={FOUR} onOpenFile={vi.fn()} />, source,
        );
        await screen.pressByTestIdAsync('turn-changes-card:turn-4-walk');
        const href = new URL(navigate.mock.calls[0]![0], 'https://happier.test');
        expect(href.searchParams.get('turnId')).toBe('turn-4');
        expect(href.searchParams.get('serverId')).toBe('home-a');
        expect(href.searchParams.get('view')).toBe('walkthrough');
        expect(href.searchParams.get('comparison')).toBe('turnCheckpoint');
        await screen.update(<TranscriptTurnChangesCard sessionId="s1" serverId="home-a" turnId="turn-4" files={BIG} onOpenFile={vi.fn()} />);
        await screen.pressByTestIdAsync('turn-changes-card:turn-4-walk');
        expect(navigate.mock.calls[1]?.[0]).toBe(navigate.mock.calls[0]?.[0]);
    });

    beforeEach(() => {
        layoutWrites.length = 0;
        setLayoutState?.('list');
        layoutWrites.length = 0;
    });

    it('starts collapsed as one header line whose actions stay on that line when the list opens', async () => {
        const onWalkThrough = vi.fn();
        const onOpenInFiles = vi.fn();
        const screen = await renderScreen(
            <TurnChangesCard testID="tc" files={FOUR} onOpenFile={vi.fn()} onWalkThrough={onWalkThrough} onOpenInFiles={onOpenInFiles} />,
        );
        expect(rowPaths(screen)).toEqual([]);
        expect(screen.getTextContent()).toContain('turnChanges.card.edited:{"count":4}');
        const headerBefore = screen.findHostByTestId('tc-header');
        expect(isInside(screen.findByTestId('tc-walk') as never, headerBefore)).toBe(true);
        expect(isInside(screen.findByTestId('tc-open-files') as never, headerBefore)).toBe(true);

        await screen.pressByTestIdAsync('tc-toggle');
        expect(rowPaths(screen)).toEqual(FOUR.map((entry) => entry.fullPath));
        const headerAfter = screen.findHostByTestId('tc-header');
        expect(isInside(screen.findByTestId('tc-walk') as never, headerAfter)).toBe(true);
        expect(isInside(screen.findByTestId('tc-open-files') as never, headerAfter)).toBe(true);
        expect(screen.findAllByTestId('tc-footer')).toHaveLength(0);

        await screen.pressByTestIdAsync('tc-open-files');
        await screen.pressByTestIdAsync('tc-walk');
        expect(onOpenInFiles).toHaveBeenCalledTimes(1);
        expect(onWalkThrough).toHaveBeenCalledTimes(1);

        await screen.pressByTestIdAsync('tc-toggle');
        expect(screen.findByTestId('tc-toggle')?.props.accessibilityState).toEqual({ expanded: false });
    });

    it('offers only the actions that have a destination', async () => {
        const screen = await renderScreen(<TurnChangesCard testID="tc" files={FOUR} onOpenFile={vi.fn()} onOpenInFiles={vi.fn()} />);
        expect(screen.findAllByTestId('tc-walk')).toHaveLength(0);
        expect(screen.findAllByTestId('tc-open-files').length).toBeGreaterThan(0);
    });

    it('labels a lockfile with the shared evidence class, other files with none', async () => {
        const screen = await renderScreen(<TurnChangesCard testID="tc" files={[...FOUR, file('yarn.lock', 0, 0)]} onOpenFile={vi.fn()} initiallyOpen />);
        const rows = screen.findAllByType('ScmChangeRow' as never);
        const tags = rows.map((row) => [(row.props.file as ScmFileStatus).fullPath, row.props.tag ?? null]);
        expect(tags.at(-1)).toEqual(['yarn.lock', 'scmComparison.lockfileTag']);
        expect(tags.slice(0, -1).every(([, tag]) => tag === null)).toBe(true);
    });

    it('keeps every one of 214 files reachable through Show more, one page at a time, with a truthful remainder', async () => {
        const screen = await renderScreen(<TurnChangesCard testID="tc" files={BIG} onOpenFile={vi.fn()} />);
        await screen.pressByTestIdAsync('tc-toggle');
        expect(rowPaths(screen)).toHaveLength(12);
        expect(screen.getTextContent()).toContain('turnChanges.card.showMore:{"count":202}');
        let guard = 0;
        while (screen.findAllByTestId('tc-more').length > 0 && guard++ < 100) {
            await screen.pressByTestIdAsync('tc-more');
        }
        expect(rowPaths(screen)).toEqual(BIG.map((entry) => entry.fullPath));
    });

    it('reads and writes the shared list | tree preference, and the tree holds every file of the turn', async () => {
        const screen = await renderScreen(<TurnChangesCard testID="tc" files={BIG} onOpenFile={vi.fn()} />);
        await screen.pressByTestIdAsync('tc-toggle');
        const segmented = screen.findByType('SegmentedTabBar' as never);
        await act(async () => { (segmented.props.onSelectTab as (id: string) => void)('tree'); });
        expect(layoutWrites).toEqual(['tree']);
        expect(rowPaths(screen)).toEqual([]);
        const tree = screen.findByType('WorkspaceRepositoryTreeList' as never);
        expect(tree.props.changedOnly).toBe(true);
        const snapshotPaths = (tree.props.scmSnapshot as { entries: Array<{ path: string }> }).entries.map((entry) => entry.path).sort();
        expect(snapshotPaths).toEqual(BIG.map((entry) => entry.fullPath).sort());

        // Another surface flips the same preference: the open card follows it.
        await act(async () => { setLayoutState?.('list'); });
        expect(rowPaths(screen)).toHaveLength(12);
    });
});
