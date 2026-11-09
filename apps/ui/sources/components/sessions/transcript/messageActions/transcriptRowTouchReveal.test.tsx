// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

import {
    closeTranscriptRowTouchActions,
    isTranscriptRowBodyTap,
    openTranscriptRowTouchActions,
    toggleTranscriptRowTouchActions,
    useTranscriptRowTouchOpened,
} from './transcriptRowTouchReveal';

function messageHost(): HTMLElement {
    const host = document.createElement('div');
    host.innerHTML = '<p>prompt text</p><div role="button">copy</div><a href="#x">link</a>';
    document.body.appendChild(host);
    return host;
}

describe('transcript row touch reveal', () => {
    afterEach(() => {
        act(() => closeTranscriptRowTouchActions());
        document.body.innerHTML = '';
    });

    it('opens one message at a time and toggles closed on a second tap', async () => {
        const a = await renderHook(() => useTranscriptRowTouchOpened('a'));
        const b = await renderHook(() => useTranscriptRowTouchOpened('b'));
        act(() => toggleTranscriptRowTouchActions('a', messageHost()));
        expect([a.getCurrent(), b.getCurrent()]).toEqual([true, false]);
        act(() => toggleTranscriptRowTouchActions('b', messageHost()));
        expect([a.getCurrent(), b.getCurrent()]).toEqual([false, true]);
        act(() => toggleTranscriptRowTouchActions('b'));
        expect([a.getCurrent(), b.getCurrent()]).toEqual([false, false]);
    });

    it('closes on a tap outside the open message or on a touch drag, not on a tap inside it', async () => {
        const opened = await renderHook(() => useTranscriptRowTouchOpened('a'));
        const host = messageHost();
        act(() => openTranscriptRowTouchActions('a', host));
        act(() => { host.querySelector('[role="button"]')!.dispatchEvent(new Event('pointerdown', { bubbles: true })); });
        expect(opened.getCurrent()).toBe(true);
        act(() => { document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })); });
        expect(opened.getCurrent()).toBe(false);

        act(() => openTranscriptRowTouchActions('a', host));
        act(() => { host.dispatchEvent(new Event('touchmove', { bubbles: true })); });
        expect(opened.getCurrent()).toBe(false);
    });

    it('treats a tap on the message text as a body tap, and a tap on a control inside it as not', () => {
        const host = messageHost();
        expect(isTranscriptRowBodyTap(host.querySelector('p'), host)).toBe(true);
        expect(isTranscriptRowBodyTap(host.querySelector('[role="button"]'), host)).toBe(false);
        expect(isTranscriptRowBodyTap(host.querySelector('a'), host)).toBe(false);
    });
});
