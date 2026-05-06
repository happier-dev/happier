import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import {
    resolveSessionViewContentBottomSpacing,
    SESSION_VIEW_AGENT_INPUT_OUTER_BOTTOM_PADDING_PX,
    SESSION_VIEW_DEFAULT_CONTENT_BOTTOM_GAP_PX,
    SESSION_VIEW_EDGE_ALIGNED_CONTENT_BOTTOM_GAP_PX,
} from './resolveSessionViewContentBottomSpacing';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const viewportState = vi.hoisted(() => ({
    width: 900,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'web',
            select: (spec: Record<string, unknown>) =>
                Object.prototype.hasOwnProperty.call(spec, 'web') ? spec.web : spec.default,
        },
        View: 'View',
        Pressable: 'Pressable',
        useWindowDimensions: () => ({ width: viewportState.width, height: 720, scale: 1, fontScale: 1 }),
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@/components/ui/layout/useChromeSafeAreaInsets', () => ({
    useChromeSafeAreaInsets: () => ({ top: 0, bottom: 11, left: 0, right: 0 }),
}));

vi.mock('@/components/sessions/transcript/AgentContentView', () => ({
    AgentContentView: (props: Record<string, unknown>) => React.createElement('AgentContentView', props),
}));

vi.mock('@/utils/platform/platform', () => ({
    isRunningOnMac: () => false,
}));

function readStyleValue(style: unknown, key: string): unknown {
    if (Array.isArray(style)) {
        for (const entry of style) {
            const value = readStyleValue(entry, key);
            if (value !== undefined) return value;
        }
        return undefined;
    }
    if (style && typeof style === 'object' && key in style) {
        return (style as Record<string, unknown>)[key];
    }
    return undefined;
}

function findContentWrapperPaddingBottom(screen: Awaited<ReturnType<typeof renderScreen>>): unknown {
    const wrapper = screen.tree.root.findAll((node) =>
        readStyleValue(node.props.style, 'paddingBottom') !== undefined,
    )[0];
    return readStyleValue(wrapper?.props.style, 'paddingBottom');
}

function findContentWrapper(screen: Awaited<ReturnType<typeof renderScreen>>) {
    return screen.tree.root.findAll((node) =>
        readStyleValue(node.props.style, 'paddingBottom') !== undefined,
    )[0];
}

describe('SessionViewLayout', () => {
    beforeEach(() => {
        viewportState.width = 900;
    });

    it('can remove the chat bottom spacing when embedded in cockpit chrome', async () => {
        const { SessionViewLayout } = await import('./SessionViewLayout');

        const screen = await renderScreen(React.createElement(SessionViewLayout as React.ComponentType<any>, {
            content: null,
            input: null,
            placeholder: null,
            shouldShowCliWarning: false,
            onDismissCliWarning: () => {},
            isLandscape: false,
            deviceType: 'phone',
            onBackPress: () => {},
            chatBottomSpacing: 'none',
        }));

        expect(findContentWrapperPaddingBottom(screen)).toBe(0);
    });

    it('keeps the default safe-area bottom spacing for normal chat surfaces', async () => {
        const { SessionViewLayout } = await import('./SessionViewLayout');

        const screen = await renderScreen(
            <SessionViewLayout
                content={null}
                input={null}
                placeholder={null}
                shouldShowCliWarning={false}
                onDismissCliWarning={() => {}}
                isLandscape={false}
                deviceType="phone"
                onBackPress={() => {}}
            />,
        );

        expect(findContentWrapperPaddingBottom(screen)).toBe(43);
    });

    it('reduces bottom spacing when the chat content fills the main surface width', async () => {
        viewportState.width = 752;
        const { SessionViewLayout } = await import('./SessionViewLayout');

        const screen = await renderScreen(
            <SessionViewLayout
                content={null}
                input={null}
                placeholder={null}
                shouldShowCliWarning={false}
                onDismissCliWarning={() => {}}
                isLandscape={false}
                deviceType="phone"
                onBackPress={() => {}}
            />,
        );

        expect(findContentWrapperPaddingBottom(screen)).toBe(19);
    });

    it('uses the measured main content width instead of the full window width', async () => {
        viewportState.width = 1100;
        const { SessionViewLayout } = await import('./SessionViewLayout');

        const screen = await renderScreen(
            <SessionViewLayout
                content={null}
                input={null}
                placeholder={null}
                shouldShowCliWarning={false}
                onDismissCliWarning={() => {}}
                isLandscape={false}
                deviceType="phone"
                onBackPress={() => {}}
            />,
        );

        expect(findContentWrapperPaddingBottom(screen)).toBe(43);
        act(() => {
            findContentWrapper(screen).props.onLayout({
                nativeEvent: { layout: { width: 752 } },
            });
        });

        expect(findContentWrapperPaddingBottom(screen)).toBe(19);
    });
});

describe('resolveSessionViewContentBottomSpacing', () => {
    it('removes session bottom spacing when requested by embedded chrome', () => {
        expect(resolveSessionViewContentBottomSpacing({
            chatBottomSpacing: 'none',
            safeAreaBottomPx: 11,
            availableWidthPx: 900,
            contentMaxWidthPx: 720,
        })).toBe(0);
    });

    it('keeps default bottom spacing when content is visibly inset inside the main pane', () => {
        expect(resolveSessionViewContentBottomSpacing({
            chatBottomSpacing: 'default',
            safeAreaBottomPx: 11,
            availableWidthPx: 900,
            contentMaxWidthPx: 720,
        })).toBe(11 + SESSION_VIEW_DEFAULT_CONTENT_BOTTOM_GAP_PX);
    });

    it('uses reduced bottom spacing when content fills the main pane width', () => {
        expect(resolveSessionViewContentBottomSpacing({
            chatBottomSpacing: 'default',
            safeAreaBottomPx: 11,
            availableWidthPx: 752,
            contentMaxWidthPx: 720,
        })).toBe(11 + SESSION_VIEW_EDGE_ALIGNED_CONTENT_BOTTOM_GAP_PX);
    });

    it('does not introduce extra bottom spacing when the current platform has no content gap', () => {
        expect(resolveSessionViewContentBottomSpacing({
            chatBottomSpacing: 'default',
            safeAreaBottomPx: 11,
            availableWidthPx: 752,
            contentMaxWidthPx: 720,
            defaultContentBottomGapPx: 0,
        })).toBe(11);
    });

    it('accounts for AgentInput outer padding so compact visual bottom spacing is exact', () => {
        expect(resolveSessionViewContentBottomSpacing({
            chatBottomSpacing: 'default',
            safeAreaBottomPx: 11,
            availableWidthPx: 752,
            contentMaxWidthPx: 720,
            inputOuterBottomPaddingPx: SESSION_VIEW_AGENT_INPUT_OUTER_BOTTOM_PADDING_PX,
        })).toBe(11 + SESSION_VIEW_EDGE_ALIGNED_CONTENT_BOTTOM_GAP_PX - SESSION_VIEW_AGENT_INPUT_OUTER_BOTTOM_PADDING_PX);
    });
});
