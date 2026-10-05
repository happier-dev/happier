import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createChangedFilesReviewDiffStateSource } from './ChangedFilesReviewDiffStore';
import { ChangedFilesReviewKeyboardShortcuts } from './ChangedFilesReviewKeyboardShortcuts.web';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type KeyListener = (event: KeyboardEvent) => void;

function installWindow() {
    let listener: KeyListener | null = null;
    vi.stubGlobal('window', {
        addEventListener: (type: string, next: KeyListener) => { if (type === 'keydown') listener = next; },
        removeEventListener: (type: string, next: KeyListener) => { if (type === 'keydown' && listener === next) listener = null; },
    });
    return (key: string, target?: unknown) => {
        const event = { key, defaultPrevented: false, metaKey: false, ctrlKey: false, altKey: false, isComposing: false, target, preventDefault: vi.fn() };
        listener?.(event as unknown as KeyboardEvent);
        return event;
    };
}

const DIFF = [
    'diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts',
    '@@ -1,2 +1,2 @@', '-x', '+y', ' z',
    '@@ -10,2 +10,2 @@', '-p', '+q', ' r',
].join('\n');

describe('ChangedFilesReviewKeyboardShortcuts (web)', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('moves between files with J / K and through the open file’s changes with N, never while typing', async () => {
        const press = installWindow();
        const store = createChangedFilesReviewDiffStateSource();
        store.setDiffState('a.ts', { status: 'loaded', diff: DIFF, error: null });
        const onFocusPath = vi.fn();
        const onFocusLine = vi.fn();
        await act(async () => {
            renderer.create(
                <ChangedFilesReviewKeyboardShortcuts enabled paths={['a.ts', 'b.ts', 'c.ts']} activePath="a.ts" onFocusPath={onFocusPath} diffStateSource={store} onFocusLine={onFocusLine} />,
            );
        });
        await act(async () => { press('j'); });
        expect(onFocusPath).toHaveBeenLastCalledWith('b.ts');
        await act(async () => { press('n'); });
        await act(async () => { press('n'); });
        expect(onFocusLine).toHaveBeenCalledTimes(2);
        const [first, second] = onFocusLine.mock.calls.map(([target]) => target);
        expect(first.filePath).toBe('a.ts');
        expect(second.lineId).not.toBe(first.lineId);
        onFocusPath.mockClear();
        await act(async () => { press('k', { tagName: 'TEXTAREA' }); });
        expect(onFocusPath).not.toHaveBeenCalled();
        // K on the first file has nowhere to go.
        await act(async () => { press('k'); });
        expect(onFocusPath).not.toHaveBeenCalled();
    });

    it('does nothing while the review is not in front', async () => {
        const press = installWindow();
        const onFocusPath = vi.fn();
        await act(async () => {
            renderer.create(
                <ChangedFilesReviewKeyboardShortcuts enabled={false} paths={['a.ts', 'b.ts']} activePath="a.ts" onFocusPath={onFocusPath} diffStateSource={createChangedFilesReviewDiffStateSource()} onFocusLine={vi.fn()} />,
            );
        });
        await act(async () => { press('j'); });
        expect(onFocusPath).not.toHaveBeenCalled();
    });
});
