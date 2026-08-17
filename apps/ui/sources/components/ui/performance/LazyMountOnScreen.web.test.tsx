import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { LazyMountOnScreen } from './LazyMountOnScreen.web';

describe('LazyMountOnScreen web', () => {
    it('mounts children only after its placeholder intersects', async () => {
        const runtime = globalThis as typeof globalThis & {
            window?: unknown;
            document?: unknown;
            IntersectionObserver?: unknown;
        };
        const previousWindow = runtime.window;
        const previousDocument = runtime.document;
        const previousIntersectionObserver = runtime.IntersectionObserver;
        const observers: Array<Readonly<{ intersect: () => void }>> = [];
        const mountedContent = vi.fn();

        class ControlledIntersectionObserver {
            public constructor(callback: (entries: readonly Readonly<{ isIntersecting: boolean }>[]) => void) {
                observers.push({
                    intersect: () => callback([{ isIntersecting: true }]),
                });
            }

            public disconnect() {}

            public observe() {}
        }

        try {
            Object.assign(globalThis, {
                window: {},
                document: {},
                IntersectionObserver: ControlledIntersectionObserver,
            });
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
        } finally {
            Object.assign(globalThis, {
                ...(previousWindow === undefined ? { window: undefined } : { window: previousWindow }),
                ...(previousDocument === undefined ? { document: undefined } : { document: previousDocument }),
                ...(previousIntersectionObserver === undefined
                    ? { IntersectionObserver: undefined }
                    : { IntersectionObserver: previousIntersectionObserver }),
            });
        }
    });
});
