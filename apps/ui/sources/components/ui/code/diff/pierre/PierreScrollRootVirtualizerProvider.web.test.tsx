/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

const setupSpy = vi.fn();
const cleanUpSpy = vi.fn();

vi.mock('@pierre/diffs', () => {
    class Virtualizer {
        setup = setupSpy;
        cleanUp = cleanUpSpy;
    }
    return { Virtualizer };
});

vi.mock('@pierre/diffs/react', async () => {
    const ReactMod = await import('react');
    return {
        VirtualizerContext: ReactMod.createContext(undefined),
    };
});

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function defineSizeProperty(node: Element, property: 'clientHeight' | 'scrollHeight', value: number): void {
    Object.defineProperty(node, property, {
        configurable: true,
        get: () => value,
    });
}

type ScrollRecorder = Readonly<{
    writes: string[];
    scrollToCalls: unknown[][];
    originalScrollTo: () => void;
}>;

/**
 * Instrument an element so every scroll mutation attempted against it is observable:
 * - direct `scrollTop` / `scrollLeft` assignments are recorded,
 * - `scrollTo(...)` invocations are recorded,
 * - the installed `scrollTo` identity is captured so a replacement is detectable.
 */
function instrumentScrollElement(
    node: HTMLElement,
    input?: Readonly<{ honorsDomScrollToOptions?: boolean }>,
): ScrollRecorder {
    const writes: string[] = [];
    const scrollToCalls: unknown[][] = [];
    let scrollTop = 0;
    let scrollLeft = 0;

    Object.defineProperty(node, 'scrollTop', {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
            writes.push(`scrollTop=${value}`);
            scrollTop = Number.isFinite(value) ? value : 0;
        },
    });
    Object.defineProperty(node, 'scrollLeft', {
        configurable: true,
        get: () => scrollLeft,
        set: (value: number) => {
            writes.push(`scrollLeft=${value}`);
            scrollLeft = Number.isFinite(value) ? value : 0;
        },
    });

    const honorsDomScrollToOptions = input?.honorsDomScrollToOptions ?? true;
    const originalScrollTo = (...args: unknown[]) => {
        scrollToCalls.push(args);
        const first = args[0];
        if (first && typeof first === 'object') {
            if (!honorsDomScrollToOptions) return;
            const anyFirst = first as any;
            if (typeof anyFirst.top === 'number') scrollTop = anyFirst.top;
            if (typeof anyFirst.left === 'number') scrollLeft = anyFirst.left;
            return;
        }
        if (typeof args[0] === 'number') scrollLeft = args[0] as number;
        if (typeof args[1] === 'number') scrollTop = args[1] as number;
    };
    (node as any).scrollTo = originalScrollTo;

    return { writes, scrollToCalls, originalScrollTo };
}

describe('PierreScrollRootVirtualizerProvider (web)', () => {
    it('never binds to, writes to, or patches a taller scrollable ancestor outside the diff subtree', async () => {
        vi.resetModules();
        setupSpy.mockClear();
        cleanUpSpy.mockClear();

        (globalThis as any).IntersectionObserver = class {};
        (globalThis as any).ResizeObserver = class {};

        const { PierreScrollRootVirtualizerProvider } = await import('./PierreScrollRootVirtualizerProvider.web');

        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);

        let ancestorRoot: HTMLDivElement | null = null;
        let nestedRoot: HTMLDivElement | null = null;
        let ancestorRecorder: ScrollRecorder | null = null;

        await act(async () => {
            root.render(
                React.createElement(
                    'div',
                    {
                        // The route-level scroller (in the app: the transcript scroller). It is taller
                        // than anything inside the diff subtree, so the "largest clientHeight wins"
                        // heuristic selects it.
                        ref: (node: HTMLDivElement | null) => {
                            if (!node || node === ancestorRoot) return;
                            ancestorRoot = node;
                            node.style.overflowY = 'auto';
                            defineSizeProperty(node, 'clientHeight', 640);
                            defineSizeProperty(node, 'scrollHeight', 2400);
                            // RN-web-like host: exposes scrollTo but ignores DOM ScrollToOptions.
                            ancestorRecorder = instrumentScrollElement(node, { honorsDomScrollToOptions: false });
                        },
                    },
                    React.createElement(
                        PierreScrollRootVirtualizerProvider,
                        null,
                        React.createElement(
                            'div',
                            null,
                            React.createElement('div', {
                                ref: (node: HTMLDivElement | null) => {
                                    if (!node || node === nestedRoot) return;
                                    nestedRoot = node;
                                    node.style.overflowY = 'auto';
                                    defineSizeProperty(node, 'clientHeight', 120);
                                    defineSizeProperty(node, 'scrollHeight', 560);
                                },
                            }),
                        ),
                    ),
                ),
            );
        });

        // Let the post-mount rebind probing run.
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 50));
        });

        expect(ancestorRoot).not.toBeNull();
        expect(nestedRoot).not.toBeNull();
        expect(ancestorRecorder).not.toBeNull();
        expect(setupSpy).toHaveBeenCalled();

        // (1) The resolved scroll root must live inside the diff subtree.
        const boundRoots = setupSpy.mock.calls.map((call) => call[0]);
        expect(boundRoots).not.toContain(ancestorRoot);
        expect(setupSpy.mock.calls.at(-1)?.[0]).toBe(nestedRoot);

        // (2) The foreign ancestor's scroll position is byte-identical across provider mount, and no
        // write was even attempted against it.
        expect(ancestorRecorder!.writes).toEqual([]);
        expect(ancestorRecorder!.scrollToCalls).toEqual([]);
        expect(ancestorRoot!.scrollTop).toBe(0);
        expect(ancestorRoot!.scrollLeft).toBe(0);

        // (3) The provider must not replace scroll methods on an element it does not own.
        expect((ancestorRoot as any).scrollTo).toBe(ancestorRecorder!.originalScrollTo);

        await act(async () => {
            root.unmount();
        });
    });

    it('binds virtualization to a nested scroll container without probing or patching it', async () => {
        vi.resetModules();
        setupSpy.mockClear();
        cleanUpSpy.mockClear();

        (globalThis as any).IntersectionObserver = class {};
        (globalThis as any).ResizeObserver = class {};

        const { PierreScrollRootVirtualizerProvider } = await import('./PierreScrollRootVirtualizerProvider.web');

        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);

        let scrollRoot: HTMLDivElement | null = null;
        let recorder: ScrollRecorder | null = null;

        await act(async () => {
            root.render(
                React.createElement(
                    PierreScrollRootVirtualizerProvider,
                    null,
                    React.createElement(
                        'div',
                        null,
                        React.createElement('div', {
                            'data-testid': 'nested-scroll-root',
                            ref: (node: HTMLDivElement | null) => {
                                if (!node || node === scrollRoot) return;
                                scrollRoot = node;
                                node.style.overflowY = 'auto';
                                defineSizeProperty(node, 'clientHeight', 120);
                                defineSizeProperty(node, 'scrollHeight', 560);
                                recorder = instrumentScrollElement(node, { honorsDomScrollToOptions: false });
                            },
                        }, React.createElement('div', { style: { height: '1000px' } })),
                    ),
                ),
            );
        });

        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 50));
        });

        expect(scrollRoot).not.toBeNull();
        expect(setupSpy).toHaveBeenCalled();
        const [boundRoot, contentContainer] = setupSpy.mock.calls.at(-1)!;
        expect(boundRoot).toBe(scrollRoot);
        // When the scroll root is an element, we should not pass an external content container.
        // Pierre will infer the correct content container from the scroll root itself.
        expect(contentContainer).toBeUndefined();

        // Binding is observation only: no probe writes, no method replacement, even on our own root.
        expect(recorder!.writes).toEqual([]);
        expect(recorder!.scrollToCalls).toEqual([]);
        expect((scrollRoot as any).scrollTo).toBe(recorder!.originalScrollTo);

        await act(async () => {
            root.unmount();
        });
    });

    it('falls back to document when no nested scroll root exists', async () => {
        vi.resetModules();
        setupSpy.mockClear();
        cleanUpSpy.mockClear();

        (globalThis as any).IntersectionObserver = class {};
        (globalThis as any).ResizeObserver = class {};

        const { PierreScrollRootVirtualizerProvider } = await import('./PierreScrollRootVirtualizerProvider.web');

        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);

        await act(async () => {
            root.render(
                React.createElement(
                    PierreScrollRootVirtualizerProvider,
                    null,
                    React.createElement('div', null, React.createElement('div', null, 'content')),
                ),
            );
        });

        expect(setupSpy).toHaveBeenCalled();
        const [boundRoot] = setupSpy.mock.calls.at(-1)!;
        expect(boundRoot).toBe(document);

        await act(async () => {
            root.unmount();
        });
    });

    it('rebinds from document to nested scroll root when it becomes scrollable later', async () => {
        vi.resetModules();
        setupSpy.mockClear();
        cleanUpSpy.mockClear();

        (globalThis as any).IntersectionObserver = class {};
        (globalThis as any).ResizeObserver = class {};

        const { PierreScrollRootVirtualizerProvider } = await import('./PierreScrollRootVirtualizerProvider.web');

        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);

        let scrollRoot: HTMLDivElement | null = null;

        await act(async () => {
            root.render(
                React.createElement(
                    PierreScrollRootVirtualizerProvider,
                    null,
                    React.createElement(
                        'div',
                        null,
                        React.createElement('div', {
                            ref: (node: HTMLDivElement | null) => {
                                if (!node || node === scrollRoot) return;
                                scrollRoot = node;
                                node.style.overflowY = 'auto';
                                defineSizeProperty(node, 'clientHeight', 120);
                                defineSizeProperty(node, 'scrollHeight', 120);
                            },
                        }),
                    ),
                ),
            );
        });

        expect(scrollRoot).not.toBeNull();
        expect(setupSpy).toHaveBeenCalled();
        const firstRoot = setupSpy.mock.calls[0]?.[0];
        expect(firstRoot).toBe(document);

        defineSizeProperty(scrollRoot!, 'scrollHeight', 580);
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 50));
        });

        const lastRoot = setupSpy.mock.calls.at(-1)?.[0];
        expect(lastRoot).toBe(scrollRoot);
        const lastContentContainer = setupSpy.mock.calls.at(-1)?.[1];
        expect(lastContentContainer).toBeUndefined();

        await act(async () => {
            root.unmount();
        });
    });

    it('stays on the document fallback rather than adopting an ancestor while the nested root is not yet scrollable', async () => {
        vi.resetModules();
        setupSpy.mockClear();
        cleanUpSpy.mockClear();

        (globalThis as any).IntersectionObserver = class {};
        (globalThis as any).ResizeObserver = class {};

        const { PierreScrollRootVirtualizerProvider } = await import('./PierreScrollRootVirtualizerProvider.web');

        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);

        let ancestorRoot: HTMLDivElement | null = null;
        let nestedRoot: HTMLDivElement | null = null;

        await act(async () => {
            root.render(
                React.createElement(
                    'div',
                    {
                        ref: (node: HTMLDivElement | null) => {
                            if (!node || node === ancestorRoot) return;
                            ancestorRoot = node;
                            node.style.overflowY = 'auto';
                            defineSizeProperty(node, 'clientHeight', 160);
                            defineSizeProperty(node, 'scrollHeight', 560);
                        },
                    },
                    React.createElement(
                        PierreScrollRootVirtualizerProvider,
                        null,
                        React.createElement('div', {
                            ref: (node: HTMLDivElement | null) => {
                                if (!node || node === nestedRoot) return;
                                nestedRoot = node;
                                node.style.overflowY = 'auto';
                                defineSizeProperty(node, 'clientHeight', 160);
                                // Not scrollable at first.
                                defineSizeProperty(node, 'scrollHeight', 120);
                            },
                        }),
                    ),
                ),
            );
        });

        expect(ancestorRoot).not.toBeNull();
        expect(nestedRoot).not.toBeNull();
        expect(setupSpy).toHaveBeenCalled();
        expect(setupSpy.mock.calls.at(-1)?.[0]).toBe(document);

        defineSizeProperty(nestedRoot!, 'scrollHeight', 880);
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 50));
        });

        expect(setupSpy.mock.calls.at(-1)?.[0]).toBe(nestedRoot);
        expect(setupSpy.mock.calls.at(-1)?.[1]).toBeUndefined();
        expect(setupSpy.mock.calls.map((call) => call[0])).not.toContain(ancestorRoot);

        await act(async () => {
            root.unmount();
        });
    });
});
