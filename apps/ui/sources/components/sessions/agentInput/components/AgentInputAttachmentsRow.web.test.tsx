import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installAgentInputCommonModuleMocks } from '../agentInputTestHelpers';

import type { AgentInputAttachmentsRowItem } from '../agentInputContracts';

// The web bundle selects this implementation by platform extension. Keep the
// composed row test on that boundary while exercising the real observer logic.
vi.mock('@/components/ui/performance/LazyMountOnScreen', async () => {
    const implementation = await import('@/components/ui/performance/LazyMountOnScreen.web');
    return { LazyMountOnScreen: implementation.LazyMountOnScreen };
});

installAgentInputCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
                select: (value: Record<string, unknown>) => value.web ?? value.default ?? null,
            },
        });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: { show: vi.fn(), alert: vi.fn(), confirm: vi.fn(), prompt: vi.fn() },
        }).module;
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key === 'common.remove' ? 'Remove' : key });
    },
});

vi.mock('expo-image', () => ({
    Image: (props: Record<string, unknown>) => React.createElement('Image', props, null),
}));

vi.mock('@/components/ui/theme/haptics', () => ({ hapticsLight: vi.fn() }));

vi.mock('@/components/sessions/attachments/preview/AttachmentImagePreviewModal', () => ({
    AttachmentImagePreviewModal: () => null,
}));

describe('AgentInputAttachmentsRow web', () => {
    it('keeps offscreen content-surface bodies unrendered until their own screen sentinel intersects', async () => {
        const runtime = globalThis as typeof globalThis & {
            window?: unknown;
            document?: unknown;
            IntersectionObserver?: unknown;
        };
        const previousWindow = runtime.window;
        const previousDocument = runtime.document;
        const previousIntersectionObserver = runtime.IntersectionObserver;
        const observers: Array<Readonly<{ intersect: () => void }>> = [];
        const renderCounters = Array.from({ length: 64 }, () => vi.fn());

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
            const { AgentInputAttachmentsRow } = await import('./AgentInputAttachmentsRow');
            const Body = ({ index }: Readonly<{ index: number }>) => {
                renderCounters[index]?.();
                return <div data-testid={`web-content-body:${index}`} />;
            };
            const items = Array.from({ length: 64 }, (_value, index) => ({
                kind: 'surface' as const,
                key: `web-content-${index}`,
                label: `Web content attachment ${index}`,
                sizing: 'content' as const,
                renderedContent: <Body index={index} />,
                testID: `web-content-surface:${index}`,
            })) satisfies readonly AgentInputAttachmentsRowItem[];

            const screen = await renderScreen(
                <AgentInputAttachmentsRow items={items} />,
                {
                    createNodeMock: (element) => (
                        (element as Readonly<{ type?: unknown }>).type === 'div' ? {} : null
                    ),
                },
            );

            expect(renderCounters.every((counter) => counter.mock.calls.length === 0)).toBe(true);
            expect(observers).toHaveLength(64);

            await act(async () => {
                observers[0]?.intersect();
                await Promise.resolve();
            });

            expect(renderCounters[0]).toHaveBeenCalledTimes(1);
            expect(renderCounters.slice(1).every((counter) => counter.mock.calls.length === 0)).toBe(true);
            expect(screen.tree.root.findAll((node) => (
                node.props['data-testid'] === 'web-content-body:0'
            ))).toHaveLength(1);
            expect(screen.tree.root.findAll((node) => (
                node.props['data-testid'] === 'web-content-body:63'
            ))).toHaveLength(0);
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
