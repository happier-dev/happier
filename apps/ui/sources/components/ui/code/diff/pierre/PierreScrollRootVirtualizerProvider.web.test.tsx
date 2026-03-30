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

describe('PierreScrollRootVirtualizerProvider (web)', () => {
    it('patches element scrollTo to support ScrollToOptions objects when missing', async () => {
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
        let scrollTop = 0;
        let scrollLeft = 0;

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

                                // Simulate a browser environment where element.scrollTo only supports numeric args
                                // and ignores ScrollToOptions objects (this breaks Pierre's scrollFix calls unless we patch).
                                Object.defineProperty(node, 'scrollTop', {
                                    configurable: true,
                                    get: () => scrollTop,
                                    set: (value: number) => {
                                        scrollTop = Number.isFinite(value) ? value : 0;
                                    },
                                });
                                Object.defineProperty(node, 'scrollLeft', {
                                    configurable: true,
                                    get: () => scrollLeft,
                                    set: (value: number) => {
                                        scrollLeft = Number.isFinite(value) ? value : 0;
                                    },
                                });
                                (node as any).scrollTo = (x: unknown, y?: unknown) => {
                                    if (typeof x === 'number') scrollLeft = x;
                                    if (typeof y === 'number') scrollTop = y;
                                };
                            },
                        }),
                    ),
                ),
            );
        });

        expect(scrollRoot).not.toBeNull();
        expect(setupSpy).toHaveBeenCalled();

        // Without the provider patch, this call would be a no-op (our stub ignores object args).
        scrollRoot!.scrollTo({ top: 150, left: 0, behavior: 'instant' } as any);
        expect(scrollRoot!.scrollTop).toBe(150);

        await act(async () => {
            root.unmount();
        });
    });

    it('translates ScrollToOptions into RN-web scrollTo({x,y}) calls when present', async () => {
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
        let scrollTop = 0;
        let scrollLeft = 0;
        const calls: unknown[][] = [];

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

                                Object.defineProperty(node, 'scrollTop', {
                                    configurable: true,
                                    get: () => scrollTop,
                                    set: (value: number) => {
                                        scrollTop = Number.isFinite(value) ? value : 0;
                                    },
                                });
                                Object.defineProperty(node, 'scrollLeft', {
                                    configurable: true,
                                    get: () => scrollLeft,
                                    set: (value: number) => {
                                        scrollLeft = Number.isFinite(value) ? value : 0;
                                    },
                                });

                                // Simulate RN-web ScrollView semantics:
                                // - supports object args with {x,y}
                                // - supports deprecated numeric args scrollTo(y, x, animated)
                                // - ignores DOM ScrollToOptions {top,left}
                                (node as any).scrollTo = (arg1: unknown, arg2?: unknown) => {
                                    calls.push([arg1, arg2]);
                                    if (arg1 && typeof arg1 === 'object') {
                                        const anyArg = arg1 as any;
                                        if (typeof anyArg.y === 'number') scrollTop = anyArg.y;
                                        if (typeof anyArg.x === 'number') scrollLeft = anyArg.x;
                                        return;
                                    }
                                    if (typeof arg1 === 'number') scrollTop = arg1;
                                    if (typeof arg2 === 'number') scrollLeft = arg2;
                                };
                            },
                        }),
                    ),
                ),
            );
        });

        expect(scrollRoot).not.toBeNull();
        expect(setupSpy).toHaveBeenCalled();

        calls.length = 0;
        scrollRoot!.scrollTo({ top: 150, left: 0, behavior: 'instant' } as any);
        expect(scrollRoot!.scrollTop).toBe(150);
        const lastCall = calls.at(-1)?.[0] as any;
        expect(lastCall && typeof lastCall === 'object').toBe(true);
        expect(lastCall).toEqual(expect.objectContaining({ x: 0, y: 150 }));

        await act(async () => {
            root.unmount();
        });
    });

    it('binds virtualization to a nested scroll container when present', async () => {
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
                            'data-testid': 'nested-scroll-root',
                            ref: (node: HTMLDivElement | null) => {
                                if (!node || node === scrollRoot) return;
                                scrollRoot = node;
                                node.style.overflowY = 'auto';
                                defineSizeProperty(node, 'clientHeight', 120);
                                defineSizeProperty(node, 'scrollHeight', 560);
                            },
                        }, React.createElement('div', { style: { height: '1000px' } })),
                    ),
                ),
            );
        });

        expect(scrollRoot).not.toBeNull();
        expect(setupSpy).toHaveBeenCalled();
        const [boundRoot, contentContainer] = setupSpy.mock.calls.at(-1)!;
        expect(boundRoot).toBe(scrollRoot);
        // When the scroll root is an element, we should not pass an external content container.
        // Pierre will infer the correct content container from the scroll root itself.
        expect(contentContainer).toBeUndefined();

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

    it('rebinds from an initial ancestor scroll root to a better nested root when it becomes available', async () => {
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
                    PierreScrollRootVirtualizerProvider,
                    null,
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
                        React.createElement('div', {
                            ref: (node: HTMLDivElement | null) => {
                                if (!node || node === nestedRoot) return;
                                nestedRoot = node;
                                node.style.overflowY = 'auto';
                                // Match (or exceed) the ancestor scroll root height so the provider
                                // can prefer the nested root once it becomes scrollable.
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
        expect(setupSpy.mock.calls.at(-1)?.[0]).toBe(ancestorRoot);
        expect(setupSpy.mock.calls.at(-1)?.[1]).toBeUndefined();

        defineSizeProperty(nestedRoot!, 'scrollHeight', 880);
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 50));
        });

        expect(setupSpy.mock.calls.at(-1)?.[0]).toBe(nestedRoot);
        expect(setupSpy.mock.calls.at(-1)?.[1]).toBeUndefined();

        await act(async () => {
            root.unmount();
        });
    });

    it('prefers a larger ancestor scroll root over a small nested scrollable descendant', async () => {
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
                            defineSizeProperty(node, 'clientHeight', 640);
                            defineSizeProperty(node, 'scrollHeight', 2400);
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

        expect(ancestorRoot).not.toBeNull();
        expect(nestedRoot).not.toBeNull();
        expect(setupSpy).toHaveBeenCalled();
        expect(setupSpy.mock.calls.at(-1)?.[0]).toBe(ancestorRoot);
        expect(setupSpy.mock.calls.at(-1)?.[1]).toBeUndefined();

        await act(async () => {
            root.unmount();
        });
    });
});
