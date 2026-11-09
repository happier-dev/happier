import * as React from 'react';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { storage } from '@/sync/domains/state/storage';
import { paneUiState } from '@/sync/domains/state/filePaneUiState';
import { replacePersistentUiStateForTest } from '@/dev/testkit/harness/persistentUiState';

import { renderHook, renderScreen } from '@/dev/testkit';
import { AppPaneProvider, useAppPaneContext } from '../AppPaneProvider';
import { useAppPaneScope, useOptionalDetailsRegionTabOpener, type AppPaneScopeApi } from './useAppPaneScope';
import { useLocalSettingPreview } from '@/sync/store/settingsPreview';
import { createSessionBoardDetailsTab } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const SCOPE_ID = 'session:identity-probe';
const initialStorageState = storage.getState();
beforeEach(() => {
    storage.setState(initialStorageState, true);
    replacePersistentUiStateForTest(paneUiState, {});
});
afterEach(() => {
    storage.setState(initialStorageState, true);
    replacePersistentUiStateForTest(paneUiState, {});
});

function PaneWrapper(props: React.PropsWithChildren) {
    return <AppPaneProvider>{props.children}</AppPaneProvider>;
}

describe('useAppPaneScope identity', () => {
    it('keeps the Details command stable while reading the current stored and preview tab preference on invocation', async () => {
        const harness = await renderHook(() => ({
            open: useOptionalDetailsRegionTabOpener(),
            pane: useAppPaneScope(SCOPE_ID),
            preview: useLocalSettingPreview('detailsPaneTabsBehavior'),
        }), { wrapper: PaneWrapper });
        const { act } = await import('react-test-renderer');
        try {
            const open = harness.getCurrent().open;
            await act(async () => { storage.getState().applyLocalSettings({ detailsPaneTabsBehavior: 'persistent' }, { persist: false }); });
            expect(harness.getCurrent().open).toBe(open);
            await act(async () => { open?.(SCOPE_ID, createSessionBoardDetailsTab({ kind: 'item', itemId: 'persistent' })); });
            expect(harness.getCurrent().pane.scopeState?.details.tabs.find(tab => tab.key === 'board:persistent')).toMatchObject({ isPinned: true });
            await act(async () => { harness.getCurrent().preview('preview'); });
            expect(harness.getCurrent().open).toBe(open);
            await act(async () => { open?.(SCOPE_ID, createSessionBoardDetailsTab({ kind: 'item', itemId: 'preview' })); });
            expect(harness.getCurrent().pane.scopeState?.details.tabs.find(tab => tab.key === 'board:preview')).toMatchObject({ isPreview: true });
        } finally { await harness.unmount(); }
    });

    it('does not render a selected Right pane for File draft and pin publications in the same scope', async () => {
        let commands!: AppPaneScopeApi;
        let commits = 0;
        function Commands() { commands = useAppPaneScope(SCOPE_ID); return null; }
        function Right() { useAppPaneScope(SCOPE_ID, scope => scope?.right ?? null); return null; }
        const screen = await renderScreen(<AppPaneProvider><Commands /><React.Profiler id="right" onRender={() => { commits += 1; }}><Right /></React.Profiler></AppPaneProvider>);
        const { act } = await import('react-test-renderer');
        try {
            await act(async () => commands.openRight({ tabId: 'git' }));
            await act(async () => commands.openDetailsTab({ key: 'file:a.ts', kind: 'file', title: 'a.ts', resource: { kind: 'file', path: 'a.ts' } }, { intent: 'preview' }));
            const before = commits;
            for (let index = 0; index < 20; index += 1) {
                await act(async () => commands.patchDetailsTabState('file:a.ts', { accountId: 'alice', isEditingFile: true, editorText: `draft ${index}` }));
            }
            await act(async () => commands.pinDetailsTab('file:a.ts'));
            expect(commits - before).toBe(0);
            await act(async () => commands.setRightTab('find'));
            expect(commits - before).toBe(1);
        } finally { await screen.unmount(); }
    });

    it('observes registration and withdrawal of its own driver while retaining a null selection for unrelated drivers', async () => {
        const harness = await renderHook(() => useAppPaneContext(value => ({
            driver: value.getDriver(SCOPE_ID), registerDriver: value.registerDriver,
        })), { wrapper: PaneWrapper });
        const { act } = await import('react-test-renderer');
        let retireOther: (() => void) | undefined;
        let retireOwn: (() => void) | undefined;
        try {
            const initial = harness.getCurrent();
            expect(initial.driver).toBeNull();
            await act(async () => { retireOther = initial.registerDriver({ scopeId: 'session:other' }); });
            expect(harness.getCurrent()).toBe(initial);
            const own = { scopeId: SCOPE_ID };
            await act(async () => { retireOwn = initial.registerDriver(own); });
            expect(harness.getCurrent().driver).toBe(own);
            await act(async () => { retireOwn?.(); });
            expect(harness.getCurrent().driver).toBeNull();
        } finally {
            await act(async () => { retireOther?.(); retireOwn?.(); });
            await harness.unmount();
        }
    });

    it('keeps retained scopes idle when a file opens or updates in another scope', async () => {
        const panes = new Map<string, AppPaneScopeApi>();
        const renders = new Map<string, number>();
        function Probe({ id }: { id: string }) {
            panes.set(id, useAppPaneScope(id));
            renders.set(id, (renders.get(id) ?? 0) + 1);
            return null;
        }
        const screen = await renderScreen(<AppPaneProvider>
            <Probe id="session:reading" /><Probe id="session:retained" />
        </AppPaneProvider>);
        const { act } = await import('react-test-renderer');
        try {
            await act(async () => panes.get('session:retained')!.openRight({ tabId: 'git' }));
            const retained = panes.get('session:retained');
            const before = renders.get('session:retained');
            await act(async () => panes.get('session:reading')!.openDetailsTab({
                key: 'file:README.md', kind: 'file', title: 'README.md',
                resource: { kind: 'file', path: 'README.md' },
            }));
            await act(async () => panes.get('session:reading')!.patchDetailsTabState('file:README.md', { scrollTop: 120 }));
            expect(panes.get('session:reading')!.scopeState?.details.activeTabKey).toBe('file:README.md');
            expect(panes.get('session:reading')!.scopeState?.details.tabState['file:README.md']).toMatchObject({ scrollTop: 120 });
            expect(renders.get('session:retained')! - before!).toBe(0);
            expect(panes.get('session:retained')).toBe(retained);
        } finally { await screen.unmount(); }
    });

    it('retains a populated scope api across a host render with unchanged pane inputs', async () => {
        const harness = await renderHook(() => useAppPaneScope(SCOPE_ID), { wrapper: PaneWrapper });
        const { act } = await import('react-test-renderer');
        try {
            await act(async () => harness.getCurrent().openRight({ tabId: 'git' }));
            const populated = harness.getCurrent();
            await harness.rerender();
            expect(harness.getCurrent()).toBe(populated);
        } finally { await harness.unmount(); }
    });

    it('transfers the Board sidebar through the real pane provider and retains a different sidebar destination', async () => {
        const harness = await renderHook(() => useAppPaneScope(SCOPE_ID), { wrapper: PaneWrapper });
        const { act } = await import('react-test-renderer');
        try {
            await act(async () => harness.getCurrent().openRight({ tabId: 'board' }));
            await act(async () => harness.getCurrent().openDetailsTab(createSessionBoardDetailsTab(), { intent: 'pinned' }));
            expect(harness.getCurrent().scopeState?.details.tabs.some(tab => tab.kind === 'board')).toBe(true);
            expect(harness.getCurrent().scopeState?.right.isOpen).toBe(false);
            await act(async () => harness.getCurrent().openRight({ tabId: 'git' }));
            await act(async () => harness.getCurrent().openDetailsTab(createSessionBoardDetailsTab({ kind: 'item', itemId: 'item-1' }), { intent: 'pinned' }));
            expect(harness.getCurrent().scopeState?.right.isOpen).toBe(true);
        } finally { await harness.unmount(); }
    });

    it('returns the same api object when the host re-renders with no pane change', async () => {
        const harness = await renderHook(() => useAppPaneScope(SCOPE_ID), {
            wrapper: PaneWrapper,
        });

        const first = harness.getCurrent();
        const second = await harness.rerender();
        const third = await harness.rerender();

        // The api is handed to `useCallback` dependency lists across ~29 callsites
        // (openAttachedSessionTerminal, SessionHeaderTranscriptNavigationButton, ...).
        // A fresh literal per render invalidates every one of them and defeats
        // SessionHeaderActionMenu's `onSelectExtraItem` comparator.
        expect(second).toBe(first);
        expect(third).toBe(first);

        await harness.unmount();
    });

    it('mints a new api object when the scope state actually changes', async () => {
        const harness = await renderHook(() => useAppPaneScope(SCOPE_ID), {
            wrapper: PaneWrapper,
        });

        const before = harness.getCurrent();
        expect(before.scopeState?.right?.isOpen ?? false).toBe(false);

        await harness.rerender();
        expect(harness.getCurrent()).toBe(before);

        const { act } = await import('react-test-renderer');
        await act(async () => {
            before.openRight();
        });

        const after = harness.getCurrent();
        expect(after).not.toBe(before);
        expect(after.scopeState?.right?.isOpen).toBe(true);

        await harness.unmount();
    });
});
