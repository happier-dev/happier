import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { LazyMountOnScreen } from './LazyMountOnScreen.web';

type FakeElement = {
    parentElement: FakeElement | null;
    scrollHeight?: number;
    clientHeight?: number;
    overflowY?: string;
};

type ObserverRecord = Readonly<{
    options: Readonly<{ root: unknown; rootMargin: string }>;
    intersect: () => void;
}>;

/** Runs `run` with the browser boundary (window, document, IntersectionObserver) replaced by controlled fakes. */
async function withControlledBrowser(
    run: (observers: ObserverRecord[]) => Promise<void>,
): Promise<void> {
    const runtime = globalThis as typeof globalThis & {
        window?: unknown;
        document?: unknown;
        IntersectionObserver?: unknown;
    };
    const previousWindow = runtime.window;
    const previousDocument = runtime.document;
    const previousIntersectionObserver = runtime.IntersectionObserver;
    const observers: ObserverRecord[] = [];

    class ControlledIntersectionObserver {
        public constructor(
            callback: (entries: readonly Readonly<{ isIntersecting: boolean }>[]) => void,
            options: ObserverRecord['options'],
        ) {
            observers.push({ options, intersect: () => callback([{ isIntersecting: true }]) });
        }

        public disconnect() {}

        public observe() {}
    }

    try {
        Object.assign(globalThis, {
            window: { getComputedStyle: (element: FakeElement) => ({ overflowY: element.overflowY ?? 'visible' }) },
            document: {},
            IntersectionObserver: ControlledIntersectionObserver,
        });
        await run(observers);
    } finally {
        Object.assign(globalThis, {
            ...(previousWindow === undefined ? { window: undefined } : { window: previousWindow }),
            ...(previousDocument === undefined ? { document: undefined } : { document: previousDocument }),
            ...(previousIntersectionObserver === undefined
                ? { IntersectionObserver: undefined }
                : { IntersectionObserver: previousIntersectionObserver }),
        });
    }
}

describe('LazyMountOnScreen web', () => {
    it('mounts children only after its placeholder intersects', async () => {
        const mountedContent = vi.fn();

        await withControlledBrowser(async (observers) => {
            const Content = () => {
                mountedContent();
                return <div />;
            };

            const screen = await renderScreen(
                <LazyMountOnScreen>
                    <Content />
                </LazyMountOnScreen>,
                {
                    createNodeMock: (element) => (
                        (element as Readonly<{ type?: unknown }>).type === 'div' ? {} : null
                    ),
                },
            );

            expect(mountedContent).not.toHaveBeenCalled();
            expect(observers).toHaveLength(1);

            await act(async () => {
                observers[0]?.intersect();
                await Promise.resolve();
            });

            expect(mountedContent).toHaveBeenCalledTimes(1);
            await screen.unmount();
        });
    });

    it('measures its overscan against the nearest ancestor that really scrolls', async () => {
        await withControlledBrowser(async (observers) => {
            // A viewport-rooted observer ignores the overscan: an ancestor scroller clips the placeholder before
            // the margin applies. Clipping-only ancestors and scrollers whose content fits are not the scroller.
            const scroller: FakeElement = { parentElement: null, overflowY: 'auto', scrollHeight: 300_000, clientHeight: 800 };
            const fitting: FakeElement = { parentElement: scroller, overflowY: 'auto', scrollHeight: 400, clientHeight: 400 };
            const card: FakeElement = { parentElement: fitting, overflowY: 'hidden', scrollHeight: 1_300, clientHeight: 1_300 };

            const screen = await renderScreen(
                <LazyMountOnScreen>
                    <div />
                </LazyMountOnScreen>,
                {
                    createNodeMock: (element) => (
                        (element as Readonly<{ type?: unknown }>).type === 'div' ? { parentElement: card } : null
                    ),
                },
            );

            expect(observers).toHaveLength(1);
            expect(observers[0]?.options.root).toBe(scroller);
            expect(observers[0]?.options.rootMargin).toBe('800px 0px 800px 0px');
            await screen.unmount();
        });
    });
});
