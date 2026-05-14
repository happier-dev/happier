import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

type FakeKeyboardEvent = KeyboardEvent & Readonly<{
    key: string;
    defaultPrevented: boolean;
    metaKey?: boolean;
    ctrlKey?: boolean;
    altKey?: boolean;
    isComposing?: boolean;
    target?: unknown;
}>;

function createFakeKeyboardEvent(input: Readonly<{
    key: string;
    isComposing?: boolean;
    target?: unknown;
}>): FakeKeyboardEvent {
    return {
        key: input.key,
        defaultPrevented: false,
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        isComposing: input.isComposing === true,
        target: input.target,
        preventDefault: vi.fn(),
    } as unknown as FakeKeyboardEvent;
}

function installFakeWindow(): {
    dispatch: (event: FakeKeyboardEvent) => void;
} {
    let keydownListener: ((event: FakeKeyboardEvent) => void) | null = null;
    vi.stubGlobal('window', {
        addEventListener: (type: string, listener: (event: FakeKeyboardEvent) => void) => {
            if (type === 'keydown') keydownListener = listener;
        },
        removeEventListener: (type: string, listener: (event: FakeKeyboardEvent) => void) => {
            if (type === 'keydown' && keydownListener === listener) keydownListener = null;
        },
    });
    return {
        dispatch: (event) => keydownListener?.(event),
    };
}

describe('StoryDeckKeyboardShortcuts (web)', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('advances with navigation keys when focus is outside editable surfaces', async () => {
        const { StoryDeckKeyboardShortcuts } = await import('./StoryDeckKeyboardShortcuts.web');
        const onAdvance = vi.fn();
        const fakeWindow = installFakeWindow();

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(<StoryDeckKeyboardShortcuts onAdvance={onAdvance} />);
        });

        fakeWindow.dispatch(createFakeKeyboardEvent({ key: 'ArrowRight' }));

        expect(onAdvance).toHaveBeenCalledTimes(1);

        act(() => {
            tree?.unmount();
        });
    });

    it('does not advance from text inputs', async () => {
        const { StoryDeckKeyboardShortcuts } = await import('./StoryDeckKeyboardShortcuts.web');
        const onAdvance = vi.fn();
        const fakeWindow = installFakeWindow();
        const input = { tagName: 'INPUT' };

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(<StoryDeckKeyboardShortcuts onAdvance={onAdvance} />);
        });

        fakeWindow.dispatch(createFakeKeyboardEvent({ key: 'Enter', target: input }));

        expect(onAdvance).not.toHaveBeenCalled();

        act(() => {
            tree?.unmount();
        });
    });

    it('does not advance while text composition owns the key event', async () => {
        const { StoryDeckKeyboardShortcuts } = await import('./StoryDeckKeyboardShortcuts.web');
        const onAdvance = vi.fn();
        const fakeWindow = installFakeWindow();

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(<StoryDeckKeyboardShortcuts onAdvance={onAdvance} />);
        });

        fakeWindow.dispatch(createFakeKeyboardEvent({ key: 'ArrowRight', isComposing: true }));

        expect(onAdvance).not.toHaveBeenCalled();

        act(() => {
            tree?.unmount();
        });
    });
});
