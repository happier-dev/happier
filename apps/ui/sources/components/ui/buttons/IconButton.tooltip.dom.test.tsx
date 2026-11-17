/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

import { installPopoverCommonModuleMocks } from '@/components/ui/popover/popoverTestHelpers';

installPopoverCommonModuleMocks({ reactNative: async () => await vi.importActual('react-native-web') });

const { IconButton } = await import('./IconButton');
const { Tooltip } = await import('../overlays/Tooltip');
await import('../overlays/AnchoredTooltip');

it('addresses the painted icon button and glyph with the effective disabled state', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
        await act(async () => {
            root.render(<IconButton testID="surface-action" icon={<span>+</span>} accessibilityLabel="Add"
                selected disabled onPress={() => {}} />);
        });
        const frame = container.querySelector('[data-testid="surface-action"]');
        const surface = container.querySelector('[data-testid="surface-action-surface"]');
        const icon = container.querySelector('[data-testid="surface-action-icon"]');
        expect(frame?.getAttribute('data-surface')).toBeNull();
        expect(surface?.getAttribute('data-surface')).toBe('button');
        expect(surface?.getAttribute('data-part')).toBe('root');
        expect(surface?.getAttribute('data-state')).toBe('disabled');
        expect(icon?.getAttribute('data-surface')).toBe('button');
        expect(icon?.getAttribute('data-part')).toBe('icon');
        expect(icon?.getAttribute('data-state')).toBe('disabled');
    } finally {
        await act(async () => { root.unmount(); });
        container.remove();
    }
});

it.each(['action', 'help'] as const)('keeps a focused %s tooltip outside a clipping toolbar without moving focus', async (kind) => {
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1024);
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(768);
    // Cold module imports may have cached jsdom's initial zero-sized viewport.
    // Notify the real RN-web Dimensions owner after establishing browser geometry.
    window.dispatchEvent(new Event('resize'));
    const { Dimensions } = await import('react-native');
    expect(Dimensions.get('window')).toMatchObject({ width: 1024, height: 768 });
    const originalRaf = globalThis.requestAnimationFrame;
    const originalCancelRaf = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = (callback) => window.setTimeout(() => callback(performance.now()), 0);
    globalThis.cancelAnimationFrame = (handle) => window.clearTimeout(handle);
    const container = document.createElement('div');
    container.style.overflow = 'hidden';
    document.body.appendChild(container);
    const root = createRoot(container);
    const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        x: 100, y: 100, width: 28, height: 28,
        top: 100, left: 100, right: 128, bottom: 128, toJSON: () => ({}),
    });
    let contentMounts = 0;
    function RichTooltip() {
        React.useEffect(() => { contentMounts += 1; return () => { contentMounts -= 1; }; }, []);
        return <span data-testid="rich-tooltip">1234 files +7836 −1398 feature/rail</span>;
    }
    try {
        await act(async () => {
            root.render(kind === 'action'
                ? <IconButton testID="review-action" icon={<span>↓</span>} accessibilityLabel="Next file" tooltip="Next file" tooltipContent={<RichTooltip />} tooltipPlacement="left" onPress={() => {}} />
                : <Tooltip testID="review-action" label="Large diff help"><span>i</span></Tooltip>);
        });
        const button = container.querySelector<HTMLElement>('[data-testid="review-action"]');
        if (!button) throw new Error('Missing review action');
        if (kind === 'help') expect(button.getAttribute('role')).not.toBe('button');
        expect(contentMounts).toBe(0);
        // The shared pressable exposes keyboard focus after a real navigation event.
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
        await act(async () => { button.focus(); });
        await vi.waitFor(() => {
            const tooltip = document.body.querySelector('[data-testid="review-action-tooltip"]');
            expect(tooltip).not.toBeNull();
            expect(container.contains(tooltip)).toBe(false);
            for (let node = tooltip; node instanceof HTMLElement; node = node.parentElement) {
                const style = window.getComputedStyle(node);
                expect(style.opacity).not.toBe('0');
                expect(style.display).not.toBe('none');
                expect(style.visibility).not.toBe('hidden');
            }
        }, { timeout: 10000 });
        if (kind === 'action') {
            expect(document.body.querySelector('[data-testid="rich-tooltip"]')?.textContent).toContain('1234 files');
            expect(contentMounts).toBe(1);
        }
        expect(document.activeElement).toBe(button);
        await act(async () => { button.blur(); });
        // Losing focus settles after the focus move, so a trapped focus scope never sees the
        // tooltip leave while nothing holds focus.
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
        expect(document.body.querySelector('[data-testid="review-action-tooltip"]')).toBeNull();
        expect(contentMounts).toBe(0);
        await act(async () => { button.dispatchEvent(new MouseEvent(window.PointerEvent != null ? 'pointerenter' : 'mouseenter', { bubbles: true })); });
        await vi.waitFor(() => expect(document.body.querySelector('[data-testid="review-action-tooltip"]')).not.toBeNull());
        expect(document.activeElement).not.toBe(button);
    } finally {
        await act(async () => { root.unmount(); });
        container.remove();
        bounds.mockRestore();
        vi.restoreAllMocks();
        globalThis.requestAnimationFrame = originalRaf;
        globalThis.cancelAnimationFrame = originalCancelRaf;
    }
});

it('keeps the tooltip away once the button is pressed or its menu is open, until the pointer leaves', async () => {
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1024);
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(768);
    window.dispatchEvent(new Event('resize'));
    const originalRaf = globalThis.requestAnimationFrame;
    const originalCancelRaf = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = (callback) => window.setTimeout(() => callback(performance.now()), 0);
    globalThis.cancelAnimationFrame = (handle) => window.clearTimeout(handle);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        x: 100, y: 100, width: 28, height: 28,
        top: 100, left: 100, right: 128, bottom: 128, toJSON: () => ({}),
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const tooltip = () => document.body.querySelector('[data-testid="more-tooltip"]');
    const hover = (node: HTMLElement, type: 'enter' | 'leave') => node.dispatchEvent(new MouseEvent(
        window.PointerEvent != null ? `pointer${type}` : `mouse${type}`, { bubbles: true }));
    async function render(expanded: boolean) {
        await act(async () => {
            root.render(<IconButton testID="more" icon={<span>⋯</span>} accessibilityLabel="Overview actions"
                tooltip="Overview actions" expanded={expanded} hasPopup="menu" onPress={() => {}} />);
        });
        return container.querySelector<HTMLElement>('[data-testid="more"]')!;
    }
    try {
        let button = await render(false);
        await act(async () => { hover(button, 'enter'); });
        await vi.waitFor(() => expect(tooltip()).not.toBeNull());
        // A press opens the menu: the tooltip leaves with the press and stays away while the menu is open.
        await act(async () => {
            button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            button.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            button.click();
        });
        button = await render(true);
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
        expect(tooltip()).toBeNull();
        // Menu closed, pointer still on the button: still no tooltip until the pointer leaves and returns.
        button = await render(false);
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
        expect(tooltip()).toBeNull();
        await act(async () => { hover(button, 'leave'); });
        await act(async () => { hover(button, 'enter'); });
        await vi.waitFor(() => expect(tooltip()).not.toBeNull());
    } finally {
        await act(async () => { root.unmount(); });
        container.remove();
        vi.restoreAllMocks();
        globalThis.requestAnimationFrame = originalRaf;
        globalThis.cancelAnimationFrame = originalCancelRaf;
    }
});
