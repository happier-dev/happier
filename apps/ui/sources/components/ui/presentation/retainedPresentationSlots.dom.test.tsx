/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => vi.importActual<typeof import('react-native-web')>('react-native-web'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

import { RetainedPresentationSlotBinder, RetainedPresentationSlotsProvider, createRetainedPresentationSlotsStore } from './retainedPresentationSlots';
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
                <RetainedPresentationSlotBinder slotId="pane" enabled visible={shown} windowGeometry={windowGeometry} accessibilityLabel="Browser"><Body /></RetainedPresentationSlotBinder>
            </div>
        </RetainedPresentationSlotsProvider>,
    ));
    await render(visible);
    return { container, render };
}

/** Where the portal paints the retained body: `null` while it paints nothing on screen. */
function paintedAt(container: HTMLElement): Readonly<{ x: number; width: number }> | null {
    const control = container.querySelector<HTMLElement>('[data-testid="retained-control"]')!;
    // The portal slot is the body's named region (see the region test below).
    const style = window.getComputedStyle(control.closest<HTMLElement>('[role="region"]')!);
    if (style.opacity === '0') return null;
    return { x: Number(control.dataset.x), width: Number.parseFloat(style.width) };
}

/** The pane's layout observer is the browser's; a test plays its deliveries outside React, as the browser does. */
function stubLayoutObserver(): () => void {
    const callbacks: ResizeObserverCallback[] = [];
    vi.stubGlobal('ResizeObserver', class {
        constructor(callback: ResizeObserverCallback) { callbacks.push(callback); }
        observe() {}
        unobserve() {}
        disconnect() {}
    });
    return () => {
        const scope = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
        const previous = scope.IS_REACT_ACT_ENVIRONMENT;
        scope.IS_REACT_ACT_ENVIRONMENT = false;
        try { for (const callback of callbacks) callback([], {} as ResizeObserver); } finally { scope.IS_REACT_ACT_ENVIRONMENT = previous; }
    };
}

function placeholderAt(read: () => number) {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        return DOMRect.fromRect({ x: this.dataset.testid?.startsWith('browser-keepalive-placeholder') ? read() : 0, y: 82, width: 300, height: 600 });
    });
}

it('paints nothing while its ancestor enter animation runs, then places the body where the frame settled', async () => {
    let moving = true;
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const deliverLayout = stubLayoutObserver();
    // The browser reports the translated visual box until its compositor animation finishes.
    placeholderAt(() => 600 + (moving ? 12 : 0));
    Object.defineProperty(HTMLElement.prototype, 'getAnimations', { configurable: true, value: function (this: HTMLElement) {
        return moving && this.dataset.testid === 'entering-pane' ? [{ finished, playState: 'running' }] : [];
    } });
    cleanups.push(async () => { Reflect.deleteProperty(HTMLElement.prototype, 'getAnimations'); });
    const { container } = await mount();
    deliverLayout();
    await act(async () => {});
    expect(paintedAt(container)).toBeNull();
    await act(async () => { moving = false; finish(); });
    expect(paintedAt(container)).toEqual({ x: 600, width: 300 });
});

it('a reopened pane never paints its retained body at a previous rectangle, and the body survives', async () => {
    let paneX = 100;
    const deliverLayout = stubLayoutObserver();
    placeholderAt(() => paneX);
    const { container, render } = await mount();
    const control = container.querySelector<HTMLButtonElement>('[data-testid="retained-control"]')!;
    deliverLayout();
    // A layout delivery places the body before the browser paints that layout (no frame late).
    expect(paintedAt(container)).toEqual({ x: 100, width: 300 });
    await render(false);
    // Reopened, the pane's frame now enters elsewhere (the transient place it is first laid out).
    paneX = 700;
    await render(true);
    expect(paintedAt(container)).toBeNull();
    deliverLayout();
    expect(paintedAt(container)).toEqual({ x: 700, width: 300 });
    paneX = 100;
    deliverLayout();
    expect(paintedAt(container)).toEqual({ x: 100, width: 300 });
    expect(container.querySelector('[data-testid="retained-control"]')).toBe(control);
});

it('paints nothing over an invisible frame until the pane presence settles', async () => {
    const deliverLayout = stubLayoutObserver();
    placeholderAt(() => 100);
    const store = createRetainedPresentationSlotsStore();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanups.push(async () => { await act(async () => root.unmount()); container.remove(); });
    await act(async () => root.render(
        <RetainedPresentationSlotsProvider store={store}>
            <div data-testid="entering-pane" style={{ opacity: 0 }}>
                <RetainedPresentationSlotBinder slotId="pane" enabled accessibilityLabel="Browser"><Body /></RetainedPresentationSlotBinder>
            </div>
        </RetainedPresentationSlotsProvider>,
    ));
    const control = container.querySelector<HTMLButtonElement>('[data-testid="retained-control"]')!;
    deliverLayout();
    await act(async () => {});
    // The pane's JS-driven presence fades its frame in; the body must not stand there unframed.
    expect(paintedAt(container)).toBeNull();
    container.querySelector<HTMLElement>('[data-testid="entering-pane"]')!.style.opacity = '1';
    await act(async () => { store.refreshPortalGeometry(); });
    expect(paintedAt(container)).toEqual({ x: 100, width: 300 });
    expect(container.querySelector('[data-testid="retained-control"]')).toBe(control);
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

it('names the presented body as a page region from the portal, without remounting it', async () => {
    // The portal stands above the router, outside the shell's main landmark: the slot itself must be one.
    const { container, render } = await mount(true, { x: 100, y: 50, width: 380, height: 600 });
    const control = container.querySelector<HTMLButtonElement>('[data-testid="retained-control"]')!;
    const region = control.closest('[role="region"]');
    expect(region?.getAttribute('aria-label')).toBe('Browser');
    await render(false);
    await render(true);
    expect(container.querySelector('[data-testid="retained-control"]')).toBe(control);
    expect(control.closest('[role="region"]')?.getAttribute('aria-label')).toBe('Browser');
});
