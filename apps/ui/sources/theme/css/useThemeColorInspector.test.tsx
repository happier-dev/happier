/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { ThemeSurfacePaintDescriptor } from '@happier-dev/plugin-sdk/ui';
import { useThemeColorInspector, type ThemeInspectorPresentation } from './useThemeColorInspector';

vi.mock('react-native', async () => import('@/platform/shims/reactNativeWebShim'));
const map: readonly ThemeSurfacePaintDescriptor[] = [{
    address: { surface: 'composer', part: 'root' }, selector: '[data-surface="composer"][data-part="root"]',
    label: 'Composer', paintRoles: [{ facet: 'background', source: { kind: 'token', ref: 'surface.page' } }],
}];
let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(async () => {
    await act(async () => { root?.unmount(); });
    root = null;
    container?.remove();
    container = null;
});

it('captures the nearest emitted part, suppresses normal activation, and releases capture on cancel/unmount', async () => {
    let inspector!: ThemeInspectorPresentation;
    const picked = vi.fn();
    const normal = vi.fn();
    const paintMap = vi.fn(() => map);
    function Harness() {
        inspector = useThemeColorInspector({ paintMap, onPick: picked });
        return <button data-surface="composer" data-part="root" data-state="default" onClick={normal}><span>Compose</span></button>;
    }
    container = document.createElement('div'); document.body.append(container);
    root = createRoot(container);
    await act(async () => { root!.render(<Harness />); });
    const button = container.querySelector('button')!;
    const measure = vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({ x: 4, y: 8, width: 200, height: 100 } as DOMRect);
    expect(measure).not.toHaveBeenCalled();
    expect(paintMap).not.toHaveBeenCalled();
    await act(async () => { inspector.activate(); });
    await act(async () => { button.querySelector('span')!.dispatchEvent(new MouseEvent('pointermove', { bubbles: true })); });
    expect(inspector.target?.address).toEqual(map[0]!.address);
    expect(inspector.target?.paintRoles).toBe(map[0]!.paintRoles);
    expect(inspector.target?.rect).toEqual({ x: 4, y: 8, width: 200, height: 100 });
    await act(async () => { button.click(); });
    expect(picked).toHaveBeenCalledTimes(1);
    expect(paintMap).toHaveBeenCalledTimes(1);
    expect(normal).not.toHaveBeenCalled();
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(inspector.active).toBe(false);
    expect(inspector.target).toBeNull();
    button.click();
    expect(normal).toHaveBeenCalledTimes(1);
    await act(async () => { inspector.activate(); });
    await act(async () => { root!.unmount(); }); root = null;
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    document.body.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
});

it('does not guess an unknown child part from a known ancestor, and permits excluded controls', async () => {
    let inspector!: ThemeInspectorPresentation;
    const picked = vi.fn(); const controls = vi.fn();
    function Harness() {
        inspector = useThemeColorInspector({ paintMap: map, onPick: picked,
            excludeElement: element => element.closest('[data-picker-control]') !== null });
        return <div data-surface="composer" data-part="root" data-state="default">
            <button data-surface="composer" data-part="input" data-state="default">Unknown paint</button>
            <button data-picker-control onClick={controls}>Done</button>
        </div>;
    }
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await act(async () => { root!.render(<Harness />); });
    await act(async () => { inspector.activate(); });
    const buttons = container.querySelectorAll('button');
    await act(async () => { buttons[0]!.click(); });
    expect(picked).not.toHaveBeenCalled(); expect(inspector.target).toBeNull();
    buttons[1]!.click(); expect(controls).toHaveBeenCalledTimes(1);
});
