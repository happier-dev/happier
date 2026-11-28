/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    const { View, Text, ScrollView } = await import('react-native');
    const mock = createReanimatedModuleMock();
    return { ...mock, default: { ...mock.default, View, Text, ScrollView }, View, Text, ScrollView };
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Stands in for a scrollable detail view (such as the subagent transcript) that consumes React wheel/touch input.
const descendantWheel = vi.fn();
const descendantTouchMove = vi.fn();
vi.mock('./SessionDetailsPanelDetailViews', async () => {
    const { View } = await import('react-native');
    const DetailView = () => React.createElement(View as unknown as React.ComponentType<Record<string, unknown>>, {
        testID: 'detail-view-scroll',
        onWheel: descendantWheel,
        onTouchMove: descendantTouchMove,
    });
    return {
        SessionCommitDetailsViewForPanel: DetailView,
        SessionFileDetailsViewForPanel: DetailView,
        SessionScmReviewDetailsViewForPanel: DetailView,
        SessionScmStashDetailsViewForPanel: DetailView,
        SessionSubagentDetailsViewForPanel: DetailView,
        SessionTranscriptDetailsViewForPanel: DetailView,
    };
});

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        closeDetails: vi.fn(),
        closeDetailsTab: vi.fn(),
        pinDetailsTab: vi.fn(),
        setActiveDetailsTab: vi.fn(),
        openDetailsTab: vi.fn(),
        scopeState: {
            details: {
                isOpen: true,
                activeTabKey: 'scmReview',
                tabs: [{ key: 'scmReview', kind: 'scmReview', title: 'Review', isPinned: true, isPreview: false, resource: { kind: 'scmReview' } }],
            },
        },
    }),
}));

const { SessionDetailsPanel } = await import('./SessionDetailsPanel');

describe('SessionDetailsPanel web wheel/touch propagation', () => {
    afterEach(() => {
        document.body.innerHTML = '';
        descendantWheel.mockClear();
        descendantTouchMove.mockClear();
    });

    it('delivers wheel/touchmove to React handlers inside the panel while keeping them away from document-level scroll locks', async () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        const documentWheel = vi.fn();
        const documentTouchMove = vi.fn();
        document.addEventListener('wheel', documentWheel);
        document.addEventListener('touchmove', documentTouchMove);

        try {
            await act(async () => root.render(<SessionDetailsPanel sessionId="s1" scopeId="session:s1" />));
            const target = await vi.waitFor(() => {
                const node = container.querySelector<HTMLElement>('[data-testid="detail-view-scroll"]');
                if (!node) throw new Error('detail view not rendered');
                return node;
            });

            await act(async () => {
                target.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100 }));
                target.dispatchEvent(new Event('touchmove', { bubbles: true }));
            });

            expect(descendantWheel).toHaveBeenCalledTimes(1);
            expect(descendantTouchMove).toHaveBeenCalledTimes(1);
            expect(documentWheel).not.toHaveBeenCalled();
            expect(documentTouchMove).not.toHaveBeenCalled();
        } finally {
            document.removeEventListener('wheel', documentWheel);
            document.removeEventListener('touchmove', documentTouchMove);
            await act(async () => root.unmount());
        }
    });
});
