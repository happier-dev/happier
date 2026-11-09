import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { SESSION_LIST_SUPPORTING_SECTIONS_NODE } from './sessionListVirtualizedNodes';

// Genuine third-party render boundary; none of these list tests renders Markdown.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: (text: string) => [{ text, reveal: false }],
}));

const probe = vi.hoisted(() => ({ cellCommits: 0 }));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

// Genuine virtualizer boundary. Like Legend, it keeps a cell it already drew while the element it is
// handed stays the same; the Profiler inside the cell sees only work React does for that cell.
vi.mock('@legendapp/list/react-native', async (importOriginal) => {
    const ReactModule = await import('react');
    const Cell = ReactModule.memo(function Cell(props: { element: React.ReactNode }) {
        return ReactModule.createElement(
            ReactModule.Profiler,
            { id: 'cell', onRender: () => { probe.cellCommits += 1; } },
            props.element,
        );
    });
    return {
        ...(await importOriginal<Record<string, unknown>>()),
        LegendList: ReactModule.forwardRef<unknown, any>((props) => ReactModule.createElement(
            ReactModule.Fragment, null,
            props.data.map((item: unknown, index: number) => ReactModule.createElement(
                Cell, { key: index, element: props.renderItem({ item, index }) },
            )),
        )),
    };
});

// Keep the large shell import outside the test's time budget.
const { SessionListVirtualizedContent } = await import('./sessionListVirtualizedContent');

describe('SessionListVirtualizedContent supporting-sections cell', () => {
    afterEach(() => {
        standardCleanup();
        probe.cellCommits = 0;
    });

    it('does not redraw the retained supporting cell when only unrelated list callbacks change identity', async () => {
        const build = () => React.createElement(SessionListVirtualizedContent as any, {
            nodes: [SESSION_LIST_SUPPORTING_SECTIONS_NODE],
            rowHeight: 48,
            safeAreaBottom: 0,
            showReminders: false,
            showDrafts: false,
            renderItem: () => null,
            rowExtraData: null,
            // The owner hands a fresh scroll-propagation handler per render, so the list re-renders.
            onStopScrollEventPropagationOnWeb: () => {},
        });
        const screen = await renderScreen(build());
        const afterMount = probe.cellCommits;
        await screen.update(build());
        await screen.update(build());
        expect(probe.cellCommits).toBe(afterMount);
        await screen.unmount();
    });
});
