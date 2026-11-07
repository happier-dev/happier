/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => vi.importActual<typeof import('react-native-web')>('react-native-web'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

import { RetainedPresentationSlotBinder, RetainedPresentationSlotsProvider } from './retainedPresentationSlots';
import { useRetainedPresentationSlotGeometry } from './retainedPresentationSlotGeometry';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

function Body() {
    const rect = useRetainedPresentationSlotGeometry('pane');
    return <button data-testid="retained-control" data-x={rect?.x}>Browser address</button>;
}

async function mount(visible = true, windowGeometry?: { x: number; y: number; width: number; height: number }) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanups.push(async () => { await act(async () => root.unmount()); container.remove(); });
    const render = async (shown: boolean) => act(async () => root.render(
        <RetainedPresentationSlotsProvider>
            <div data-testid="entering-pane">
                <RetainedPresentationSlotBinder slotId="pane" enabled visible={shown} windowGeometry={windowGeometry}><Body /></RetainedPresentationSlotBinder>
            </div>
        </RetainedPresentationSlotsProvider>,
    ));
    await render(visible);
    return { container, render };
}

it('remeasures a mounted pane when its ancestor enter animation settles without a resize', async () => {
    let moving = true;
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const resizeCallbacks: ResizeObserverCallback[] = [];
    vi.stubGlobal('ResizeObserver', class {
        constructor(callback: ResizeObserverCallback) { resizeCallbacks.push(callback); }
        observe() {}
        unobserve() {}
        disconnect() {}
    });
    // The browser reports the translated visual box until its compositor animation finishes.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        return DOMRect.fromRect({ x: this.dataset.testid?.startsWith('browser-keepalive-placeholder') ? 1000 + (moving ? 12 : 0) : 0,
            y: 0, width: 380, height: 600 });
    });
    Object.defineProperty(HTMLElement.prototype, 'getAnimations', { configurable: true, value: function (this: HTMLElement) {
        return moving && this.dataset.testid === 'entering-pane' ? [{ finished }] : [];
    } });
    cleanups.push(async () => { Reflect.deleteProperty(HTMLElement.prototype, 'getAnimations'); });
    const { container } = await mount();
    await act(async () => { for (const callback of resizeCallbacks) callback([], {} as ResizeObserver); });
    const control = container.querySelector<HTMLButtonElement>('[data-testid="retained-control"]')!;
    expect(control.dataset.x).toBe('1012');
    await act(async () => { moving = false; finish(); });
    expect(control.dataset.x).toBe('1000');
});

it('keeps a parked body mounted but inaccessible, then restores its existing control when shown', async () => {
    const { container, render } = await mount(false, { x: 100, y: 50, width: 380, height: 600 });
    const control = container.querySelector<HTMLButtonElement>('[data-testid="retained-control"]')!;
    expect(control.closest('[inert]')).not.toBeNull();
    expect(control.closest('[aria-hidden="true"]')).not.toBeNull();
    await render(true);
    expect(container.querySelector('[data-testid="retained-control"]')).toBe(control);
    expect(control.closest('[inert]')).toBeNull();
    expect(control.closest('[aria-hidden="true"]')).toBeNull();
    await render(false);
    expect(control.closest('[inert]')).not.toBeNull();
});
