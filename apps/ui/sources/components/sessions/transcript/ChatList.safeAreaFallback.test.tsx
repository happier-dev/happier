import * as React from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture, createTestSessionTranscriptSource, renderWithSessionTranscriptSource, standardCleanup } from '@/dev/testkit';
import { installTranscriptCommonModuleMocks, resetTranscriptCommonModuleMockState } from './transcriptTestHelpers';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

if (typeof (globalThis as any).requestAnimationFrame !== 'function') {
    (globalThis as any).requestAnimationFrame = (callback: (time: number) => void) => (
        setTimeout(() => callback(Date.now()), 0) as unknown as number
    );
    (globalThis as any).cancelAnimationFrame = (handle: number) => {
        clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
    };
}

let capturedHeaderSpacerHeight: number | null = null;

function unwrapStyle(style: unknown): Record<string, unknown> | null {
    if (!style) return null;
    if (Array.isArray(style)) {
        for (const entry of style) {
            const resolved = unwrapStyle(entry);
            if (resolved) return resolved;
        }
        return null;
    }
    return typeof style === 'object' ? (style as Record<string, unknown>) : null;
}

function renderReactElementCandidate(candidate: unknown): React.ReactNode {
    if (typeof candidate === 'function') return React.createElement(candidate as React.ComponentType);
    return React.isValidElement(candidate) ? candidate : null;
}

installTranscriptCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'ios',
                select: (values: any) => values?.ios ?? values?.default,
            },
            View: (props: any) => React.createElement('View', props, props.children),
            ActivityIndicator: () => React.createElement('ActivityIndicator'),
        });
    },
});

vi.mock('@legendapp/list/react-native', () => ({
    LegendList: React.forwardRef((props: any, ref: any) => {
        const instance = {
            getState: () => ({
                contentLength: 0,
                isAtEnd: true,
                isNearEnd: true,
                isWithinMaintainScrollAtEndThreshold: true,
                positionAtIndex: () => 0,
                scroll: 0,
                scrollLength: 0,
                sizeAtIndex: () => 120,
            }),
            scrollToEnd: () => Promise.resolve(),
            scrollToIndex: () => Promise.resolve(),
            scrollToOffset: () => Promise.resolve(),
        };
        if (typeof ref === 'function') ref(instance);
        else if (ref && typeof ref === 'object') ref.current = instance;
        // Render the native recycler's supplied slots normally: they may own hooks.
        return React.createElement('LegendList', props,
            renderReactElementCandidate(props.ListHeaderComponent),
            renderReactElementCandidate(props.ListFooterComponent));
    }),
}));

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: { insets: { top: 22, bottom: 0, left: 0, right: 0 } },
}));

installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();

describe('ChatList safe area', () => {
    beforeEach(() => {
        capturedHeaderSpacerHeight = null;
    });

    afterEach(() => {
        standardCleanup();
        resetTranscriptCommonModuleMockState();
    });

    it('uses a compact transcript gutter instead of chrome-safe area inside the list header', async () => {
        const { ChatList } = await import('./ChatList');

        const session = createSessionFixture({ id: 'session-1', metadata: null, active: true });
        const screen = await renderWithSessionTranscriptSource(
            <ChatList session={session} sessionSurfaceKey={JSON.stringify(['test-server', 'session-1'])} />,
            createTestSessionTranscriptSource({ sessionId: session.id, serverId: 'test-server' }),
        );
        const list = screen.findByType('LegendList');
        const spacer = list.findAll(node => typeof node.type === 'string'
            && typeof unwrapStyle(node.props.style)?.height === 'number')[0];
        capturedHeaderSpacerHeight = typeof unwrapStyle(spacer?.props.style)?.height === 'number'
            ? unwrapStyle(spacer?.props.style)!.height as number : null;
        expect(capturedHeaderSpacerHeight).toBe(12);
    });
});
