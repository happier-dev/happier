/**
 * @vitest-environment jsdom
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => await vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return await createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});
vi.mock('@/components/ui/icons/SafeIonicons', () => ({
    SafeIonicons: (props: Readonly<{ name?: string }>) =>
        React.createElement('span', { 'data-icon': props.name }),
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
    act(() => { root?.unmount(); });
    container?.remove();
    root = null;
    container = null;
});

async function renderDictationButton(onPress: () => void): Promise<HTMLElement> {
    const { AgentInputDictationButton } = await import('./AgentInputDictationButton');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
        root!.render(React.createElement(AgentInputDictationButton, { status: 'idle', onPress }));
    });
    const element = container.querySelector<HTMLElement>('[data-testid="agent-input-dictation"]');
    if (!element) throw new Error('dictation button did not render');
    return element;
}

/**
 * The desktop app IS the web bundle, and react-native-web 0.21 implements
 * `hitSlop` only in its legacy `Touchable` export — a `hitSlop` on a `Pressable`
 * is dropped, so the pointer target is exactly the element's own box. This reads
 * the rendered box out of the DOM rather than recomputing it from the props,
 * which is the only way the discarded `hitSlop` shows up at all.
 */
describe('AgentInputDictationButton web pointer geometry', () => {
    it('presses through a full-size box, not the 24pt visual', async () => {
        const onPress = vi.fn();
        const element = await renderDictationButton(onPress);

        const box = getComputedStyle(element);
        expect(box.width).toBe('44px');
        expect(box.height).toBe('44px');

        // The measured box is the press target itself, not a parent wrapper that
        // merely reserves the space around a smaller pressable.
        expect(element.getAttribute('role')).toBe('button');
        act(() => {
            element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        expect(onPress).toHaveBeenCalledTimes(1);

        // The 24pt circle stays a non-interactive child of that box.
        const visual = element.firstElementChild as HTMLElement | null;
        expect(visual).not.toBeNull();
        expect(getComputedStyle(visual!).width).toBe('24px');
        expect(visual!.getAttribute('role')).toBeNull();
    });
});
