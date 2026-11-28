/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { storage } from '@/sync/domains/state/storage';
import { KeyboardShortcutProvider } from '@/keyboard/KeyboardShortcutProvider';
import { buildDiffHunkTable } from '@/components/ui/code/diff/hunks/buildDiffHunkTable';
import { ReviewKeyboardBindings } from './ReviewKeyboardBindings';
import { useHunkReviewController } from './useHunkReviewController';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());

const initialSettings = storage.getState().settings;
afterEach(() => { standardCleanup(); storage.setState({ settings: initialSettings }); document.body.replaceChildren(); });
const diff = '@@ -1,2 +1,2 @@\n-old\n+new\n context\n@@ -8 +8 @@\n-before\n+after\n';

describe('Review keyboard bindings', () => {
    it('uses the real command dispatcher for changes, Shift files and rebinding, without taking editor typing', async () => {
        storage.setState({ settings: { ...initialSettings,
            keyboardSingleKeyShortcutsEnabled: true, keyboardShortcutOverridesV1: {}, keyboardShortcutDisabledCommandIdsV1: [] } });
        const focusPath = vi.fn();
        const focusLine = vi.fn();
        const table = buildDiffHunkTable({ mode: 'unified', filePath: 'a.ts', unifiedDiff: diff });
        function Review() {
            const controller = useHunkReviewController({ source: { kind: 'live', root: '/repo' },
                path: 'a.ts', unifiedDiff: diff, host: null, serverId: null,
                liveFiles: [{ path: 'a.ts', unifiedDiff: diff }, { path: 'b.ts', unifiedDiff: '', pending: true }],
                onNavigate: cursor => {
                    if (cursor.path !== 'a.ts') { focusPath(cursor.path); return; }
                    const hunk = table.hunks.find(hunk => hunk.key === cursor.key);
                    if (hunk) focusLine({ filePath: cursor.path, lineId: hunk.firstChangeLineId });
                } });
            return <ReviewKeyboardBindings enabled controller={controller} />;
        }
        await renderScreen(<KeyboardShortcutProvider handlers={{}}><Review /></KeyboardShortcutProvider>);
        const key = async (value: string, extra: KeyboardEventInit = {}, target: EventTarget = window) => {
            const event = new KeyboardEvent('keydown', { key: value, code: `Key${value.toUpperCase()}`, bubbles: true, cancelable: true, ...extra });
            await act(async () => { target.dispatchEvent(event); });
            return event;
        };
        expect((await key('j')).defaultPrevented).toBe(true);
        expect(focusLine).toHaveBeenLastCalledWith({ filePath: 'a.ts', lineId: table.hunks[1]!.firstChangeLineId });
        expect(focusPath).not.toHaveBeenCalled();
        await key('k');
        expect(focusLine).toHaveBeenLastCalledWith({ filePath: 'a.ts', lineId: table.hunks[0]!.firstChangeLineId });
        await key('J', { shiftKey: true });
        expect(focusPath).toHaveBeenLastCalledWith('b.ts');
        expect((await key('n')).defaultPrevented).toBe(false);
        const editor = document.createElement('textarea');
        document.body.append(editor);
        focusLine.mockClear();
        expect((await key('j', {}, editor)).defaultPrevented).toBe(false);
        expect(focusLine).not.toHaveBeenCalled();
        await act(async () => { storage.setState({ settings: { ...storage.getState().settings,
            keyboardShortcutOverridesV1: { 'review.change.next': [{ binding: 'x' }] } } }); });
        expect((await key('j')).defaultPrevented).toBe(false);
        expect((await key('x')).defaultPrevented).toBe(true);
    });
});
