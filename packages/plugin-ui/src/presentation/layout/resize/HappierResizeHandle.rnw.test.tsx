/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;



let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    root = null;
    container = null;
});

describe('HappierResizeHandle', () => {
    it('delivers browser double-click reset to the current owner and removes it on unmount', async () => {
        const { HappierResizeHandle } = await import('./HappierResizeHandle.js');
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        const first = vi.fn();
        const current = vi.fn();
        const render = (onDoubleClick: () => void) => act(async () => root!.render(
            <HappierResizeHandle labels={{ label: 'Resize' }} axis="x" testID="handle"
                interactionProps={{ onDoubleClick }} />,
        ));
        await render(first);
        const handle = container.querySelector<HTMLElement>('[data-testid="handle"]')!;
        await render(current);
        act(() => handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
        expect(first).not.toHaveBeenCalled();
        expect(current).toHaveBeenCalledOnce();
        await act(async () => root!.unmount());
        root = null;
        act(() => handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
        expect(current).toHaveBeenCalledOnce();
    });

    it('grows an edge handle\'s pointer target outward, never further into its own pane than the drawn divider', async () => {
        // An edge handle that reached inward covered the pane's trailing controls (the Machines rail "+", 2026-11-06:
        // inward-only 24 px covered its centre; a centred target still covered its last 2 px). Pane gutters are laid
        // out around the drawn divider, so the floor's extra size goes over the neighbour beyond the edge.
        const { HappierResizeHandle } = await import('./HappierResizeHandle.js');
        const { HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE: floor } = await import('../../../environment/interactiveTarget.js');
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        const px = (value: string) => Number.parseFloat(value) || 0;
        const reach = async (edge: 'start' | 'end', axis: 'x' | 'y') => {
            const drawn = axis === 'x' ? 10 : 18;
            const anchor = axis === 'x' ? (edge === 'end' ? 'right' : 'left') : (edge === 'end' ? 'bottom' : 'top');
            const inner = axis === 'x' ? (edge === 'end' ? 'left' : 'right') : (edge === 'end' ? 'top' : 'bottom');
            await act(async () => root!.render(
                <HappierResizeHandle labels={{ label: 'Resize' }} axis={axis} edge={edge} testID="handle"
                    style={{ position: 'absolute', [anchor]: 0, ...(axis === 'x' ? { width: drawn } : { height: drawn }) }} />,
            ));
            const style = container!.querySelector<HTMLElement>('[data-testid="handle"]')!.style;
            const size = axis === 'x' ? Math.max(px(style.width), px(style.minWidth)) : Math.max(px(style.height), px(style.minHeight));
            const margin = (side: string) => px(style.getPropertyValue(`margin-${side}`));
            // Past the edge it resizes (outward), and into its own pane beyond the drawn divider (inward).
            return { size, outward: 0 - margin(anchor), inwardBeyondDrawn: 0 - margin(inner), drawn };
        };
        for (const axis of ['x', 'y'] as const) for (const edge of ['start', 'end'] as const) {
            const measured = await reach(edge, axis);
            expect(measured).toEqual({ size: floor, outward: floor - measured.drawn, inwardBeyondDrawn: 0, drawn: measured.drawn });
        }
    });

    it('announces the current pane size and updates the range and spoken value after resizing', async () => {
        const { HappierResizeHandle } = await import('./HappierResizeHandle.js');
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        const render = async (value?: { min?: number; max?: number; now: number }) => {
            await act(async () => root!.render(
                <HappierResizeHandle labels={{ label: 'Resize', value: (px) => `${px} px` }} axis="x" testID="handle"
                    accessibilityHandleProps={value ? { accessibilityValue: value } : undefined} />,
            ));
            const handle = container!.querySelector<HTMLElement>('[data-testid="handle"]');
            expect(handle?.getAttribute('role')).toBe('slider');
            return handle!;
        };
        const handle = await render({ min: 240, max: 520, now: 383.6 });
        expect(handle.getAttribute('aria-valuenow')).toBe('384');
        expect(handle.getAttribute('aria-valuemin')).toBe('240');
        expect(handle.getAttribute('aria-valuemax')).toBe('520');
        expect(handle.getAttribute('aria-valuetext')).toContain('384');

        const resized = await render({ min: 200, max: 600, now: 499.2 });
        expect(resized).toBe(handle);
        expect(resized.getAttribute('aria-valuenow')).toBe('499');
        expect(resized.getAttribute('aria-valuemin')).toBe('200');
        expect(resized.getAttribute('aria-valuemax')).toBe('600');
        expect(resized.getAttribute('aria-valuetext')).toContain('499');
        expect(resized.getAttribute('aria-valuetext')).not.toContain('384');

        const unbounded = await render({ now: 499.2 });
        expect(unbounded.hasAttribute('aria-valuemin')).toBe(false);
        expect(unbounded.hasAttribute('aria-valuemax')).toBe(false);
        const unknown = await render();
        expect(unknown.hasAttribute('aria-valuenow')).toBe(false);
        expect(unknown.hasAttribute('aria-valuetext')).toBe(false);
    });
});
