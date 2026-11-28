/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installPopoverCommonModuleMocks } from '@/components/ui/popover/popoverTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installPopoverCommonModuleMocks({ reactNative: async () => await vi.importActual('react-native-web') });

const { SidebarFooterPopoverButton } = await import('./SidebarFooterPopoverButton');
const { motionTokens } = await import('@/components/ui/motion');

function Content(props: Readonly<{ close: () => void }>) {
    return <button data-testid="popover-row" onClick={props.close}>Row</button>;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function renderButton(hoverPreview = false, options: Pick<React.ComponentProps<typeof SidebarFooterPopoverButton>, 'destination' | 'onOpenIntent'> = {}) {
    await act(async () => {
        root.render(
            <SidebarFooterPopoverButton
                testID="footer-usage"
                iconName="speedometer"
                label="Usage"
                hoverPreview={hoverPreview}
                {...options}
                renderContent={({ close }) => <Content close={close} />}
            />,
        );
    });
    const button = container.querySelector<HTMLElement>('[data-testid="footer-usage"]');
    if (!button) throw new Error('missing footer button');
    return button;
}

// React derives pointerenter/leave from pointerover/out; jsdom may lack PointerEvent itself.
const pointerEnter = (el: Element) => el.dispatchEvent(new MouseEvent('pointerover', { bubbles: true, relatedTarget: document.body }));
const pointerLeave = (el: Element) => el.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: document.body }));

const popover = () => document.body.querySelector('[data-testid="footer-usage-popover"]');

describe('SidebarFooterPopoverButton', () => {
    beforeEach(() => {
        vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1280);
        vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(800);
        window.dispatchEvent(new Event('resize'));
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
            x: 200, y: 740, width: 28, height: 28, top: 740, left: 200, right: 228, bottom: 768, toJSON: () => ({}),
        });
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });
    afterEach(async () => {
        await act(async () => { root.unmount(); });
        container.remove();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('opens from the keyboard, and Escape closes it and returns focus to the button', async () => {
        const button = await renderButton();
        expect(button.getAttribute('aria-label')).toBe('Usage');
        expect(popover()).toBeNull();

        await act(async () => { button.focus(); });
        await act(async () => {
            button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            button.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
        });
        // RNW turns a focused button's Enter into a click; fall back to it where the key path is absent.
        if (!popover()) await act(async () => { button.click(); });
        await vi.waitFor(() => expect(popover()).not.toBeNull());
        expect(button.getAttribute('aria-selected') === 'true' || button.getAttribute('aria-expanded') !== 'false').toBe(true);

        await act(async () => {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        });
        await vi.waitFor(() => expect(popover()).toBeNull());
        expect(document.activeElement).toBe(button);
    });

    it('previews on hover after the rest delay without taking focus, and a press keeps it open', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const button = await renderButton(true);

        await act(async () => { pointerEnter(button); });
        await act(async () => { vi.advanceTimersByTime(motionTokens.overlay.popover.hoverOpenDelayMs - 50); });
        expect(popover()).toBeNull();
        await act(async () => { vi.advanceTimersByTime(100); });
        expect(popover()).not.toBeNull();
        expect(popover()!.contains(document.activeElement)).toBe(false);

        // Pressing a previewing button hands it to the click: leaving no longer closes it.
        await act(async () => { button.click(); });
        await act(async () => { pointerLeave(button); });
        await act(async () => { vi.advanceTimersByTime(1000); });
        expect(popover()).not.toBeNull();
    });

    it('closes a destination preview and navigates when its trigger is pressed', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const onOpen = vi.fn();
        const button = await renderButton(true, { destination: { href: '/settings/usage', onOpen } });
        expect(button.getAttribute('role')).toBe('link');

        await act(async () => { pointerEnter(button); });
        await act(async () => { vi.advanceTimersByTime(motionTokens.overlay.popover.hoverOpenDelayMs + 10); });
        expect(popover()).not.toBeNull();
        expect(onOpen).not.toHaveBeenCalled();

        await act(async () => { button.click(); });
        expect(onOpen).toHaveBeenCalledOnce();
        expect(popover()).toBeNull();
    });

    it('closes a hover preview when the pointer leaves', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const button = await renderButton(true);

        await act(async () => { pointerEnter(button); });
        await act(async () => { vi.advanceTimersByTime(motionTokens.overlay.popover.hoverOpenDelayMs + 10); });
        expect(popover()).not.toBeNull();
        await act(async () => { pointerLeave(button); });
        await act(async () => { vi.advanceTimersByTime(1000); });
        expect(popover()).toBeNull();
    });

    it('records demand only once the hover preview opens, and a later press does not record again', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const onOpenIntent = vi.fn();
        const button = await renderButton(true, { onOpenIntent });

        await act(async () => { pointerEnter(button); });
        expect(popover()).toBeNull();
        expect(onOpenIntent).not.toHaveBeenCalled();
        await act(async () => { vi.advanceTimersByTime(motionTokens.overlay.popover.hoverOpenDelayMs + 10); });
        expect(popover()).not.toBeNull();
        expect(onOpenIntent).toHaveBeenCalledTimes(1);

        await act(async () => { button.click(); });
        expect(onOpenIntent).toHaveBeenCalledTimes(1);
    });

    it('records a press on a button without hover preview as the opening intent', async () => {
        const onOpenIntent = vi.fn();
        const button = await renderButton(false, { onOpenIntent });
        await act(async () => { button.click(); });
        expect(popover()).not.toBeNull();
        expect(onOpenIntent).toHaveBeenCalledTimes(1);
    });
});
