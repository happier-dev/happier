import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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

describe('SessionViewLayout', () => {
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
});
