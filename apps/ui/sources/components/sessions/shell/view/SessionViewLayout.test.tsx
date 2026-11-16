import * as React from 'react';
import { View } from 'react-native';
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
const platformState = vi.hoisted(() => ({
    os: 'web' as 'web' | 'android',
}));
const safeAreaState = vi.hoisted(() => ({
    bottom: 11,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            get OS() {
                return platformState.os;
            },
            select: (spec: Record<string, unknown>) =>
                Object.prototype.hasOwnProperty.call(spec, platformState.os)
                    ? spec[platformState.os]
                    : spec.default,
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
    useChromeSafeAreaInsets: () => ({ top: 0, bottom: safeAreaState.bottom, left: 0, right: 0 }),
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

/** The Session's bottom gap: the content view keeps it as its own painted space under the composer. */
function findContentWrapperPaddingBottom(screen: Awaited<ReturnType<typeof renderScreen>>): unknown {
    return screen.tree.root.findAll((node) => node.type === ('AgentContentView' as never))[0]?.props.bottomInsetPx;
}

function findContentWrapper(screen: Awaited<ReturnType<typeof renderScreen>>) {
    return screen.tree.root.findAll((node) => typeof node.type === 'string' && typeof node.props.onLayout === 'function')[0]!;
}

describe('SessionViewLayout', () => {
    beforeEach(() => {
        viewportState.width = 900;
        platformState.os = 'web';
        safeAreaState.bottom = 11;
    });

    it('withdraws the landscape Back control with the covered pane body, so focus and assistive tech cannot reach it', async () => {
        const { SessionViewLayout } = await import('./SessionViewLayout');
        const { PaneMainBodyPresentationContext } = await import('@/components/ui/panels/paneMainComposerAnchor');
        const screen = await renderScreen(
            <PaneMainBodyPresentationContext.Provider value={false}>
                <SessionViewLayout
                    content={null} input={null} placeholder={null}
                    isLandscape deviceType="phone" onBackPress={() => {}}
                />
            </PaneMainBodyPresentationContext.Provider>,
        );
        const back = screen.findHostByTestId('session-view-landscape-back-button');
        if (!back) throw new Error('Expected the landscape Back control');
        // The pane owner's hidden boundary must sit on the control or a host above it; the browser then
        // keeps it out of the tab order (inert), the accessibility tree (aria-hidden) and pointer hits.
        const boundary: Record<string, unknown> = {};
        for (let node: typeof back | null = back; node; node = node.parent) {
            if (typeof node.type !== 'string') continue;
            for (const key of ['inert', 'aria-hidden', 'pointerEvents'] as const) {
                if (boundary[key] === undefined && node.props[key] !== undefined) boundary[key] = node.props[key];
            }
        }
        expect(boundary).toEqual({ inert: true, 'aria-hidden': true, pointerEvents: 'none' });
    });

    it('can remove the chat bottom spacing when embedded in cockpit chrome', async () => {
        const { SessionViewLayout } = await import('./SessionViewLayout');

        const screen = await renderScreen(React.createElement(SessionViewLayout as React.ComponentType<any>, {
            content: null,
            input: null,
            placeholder: null,
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
                isLandscape={false}
                deviceType="phone"
                onBackPress={() => {}}
            />,
        );

        expect(findContentWrapperPaddingBottom(screen)).toBe(43);
    });

    it('lets the keyboard scaffold own the Android safe-area inset in classic sessions', async () => {
        platformState.os = 'android';
        safeAreaState.bottom = 34;
        const { SessionViewLayout } = await import('./SessionViewLayout');

        const screen = await renderScreen(
            <SessionViewLayout
                content={null}
                input={null}
                placeholder={null}
                isLandscape={false}
                deviceType="phone"
                onBackPress={() => {}}
            />,
        );

        expect(findContentWrapperPaddingBottom(screen)).toBe(0);
    });

    it('reduces bottom spacing when the chat content fills the main surface width', async () => {
        viewportState.width = 752;
        const { SessionViewLayout } = await import('./SessionViewLayout');

        const screen = await renderScreen(
            <SessionViewLayout
                content={null}
                input={null}
                placeholder={null}
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

    it('seats the Companion on the side the viewer chose, on every platform', async () => {
        // The rail is a flex sibling of Chat, and Yoga has no `order`: a CSS-only
        // reorder silently does nothing on iOS and Android, which turns "Move to
        // the left side" into a control with no observable effect there.
        const { SessionViewLayout } = await import('./SessionViewLayout');
        const row = async (companionEdge?: 'leading' | 'trailing') => {
            const screen = await renderScreen(
                <SessionViewLayout
                    content={null}
                    input={null}
                    placeholder={null}
                    isLandscape={false}
                    deviceType="tablet"
                    onBackPress={() => {}}
                    companion={<View testID="companion-slot" />}
                    {...(companionEdge ? { companionEdge } : {})}
                />,
            );
            const node = screen.tree.root.findAll((candidate) =>
                readStyleValue(candidate.props.style, 'flexDirection') === 'row'
                || readStyleValue(candidate.props.style, 'flexDirection') === 'row-reverse',
            )[0];
            return readStyleValue(node?.props.style, 'flexDirection');
        };

        expect(await row()).toBe('row');
        expect(await row('trailing')).toBe('row');
        // Reversing the one row that owns Chat and the rail moves the rail to the
        // leading side without a web-only style and without a second slot.
        expect(await row('leading')).toBe('row-reverse');
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
