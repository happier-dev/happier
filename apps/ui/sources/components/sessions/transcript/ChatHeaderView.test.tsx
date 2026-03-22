import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    createExpoVectorIconsMock,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                        Platform: { OS: 'ios', select: (values: any) => values?.ios ?? values?.default ?? null },
                        View: 'View',
                        Text: 'Text',
                        Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
                    }
    );
});

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@react-navigation/native', () => ({
    useNavigation: () => ({ goBack: vi.fn() }),
}));

vi.mock('@/utils/platform/responsive', () => ({
    useHeaderHeight: () => 44,
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                header: { background: '#fff', tint: '#111' },
                surface: '#fff',
                surfaceHigh: '#f5f5f5',
                divider: '#ddd',
                textSecondary: '#666',
                shadow: { color: '#000', opacity: 0.2 },
            },
        },
    });
});

vi.mock('@expo/vector-icons', async () => createExpoVectorIconsMock());

vi.mock('@/components/ui/avatar/Avatar', () => ({
    Avatar: (props: any) => React.createElement('Avatar', props),
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
    },
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { headerMaxWidth: 1024 },
}));

describe('ChatHeaderView', () => {
    afterEach(standardCleanup);

    it('uses elevation to keep the header above scroll content on Android', async () => {
        const { ChatHeaderView } = await import('./ChatHeaderView');

        const screen = await renderScreen(<ChatHeaderView title="Title" />);

        const allViews = screen.findAllByType('View' as any);
        const containerView = allViews.find((node) => {
            const style = node.props?.style;
            const flat = Array.isArray(style) ? style.flat() : [style];
            return flat.some((s) => s && typeof s === 'object' && s.zIndex === 100);
        });

        expect(containerView).toBeTruthy();

        const style = (containerView as any).props.style;
        const flat = Array.isArray(style) ? style.flat() : [style];
        const base = flat.find((s: any) => s && typeof s === 'object' && s.zIndex === 100);
        expect(base?.elevation).toBe(10);
    });

    it('renders an optional rightElement', async () => {
        const { ChatHeaderView } = await import('./ChatHeaderView');

        const screen = await renderScreen(
            <ChatHeaderView
                title="Title"
                rightElement={React.createElement('Text', null, 'RIGHT')}
            />,
        );

        expect(screen.getTextContent()).toContain('RIGHT');
    });

    it('stretches header width when constrainWidth is false', async () => {
        const { ChatHeaderView } = await import('./ChatHeaderView');

        const screen = await renderScreen(
            <ChatHeaderView
                title="Title"
                constrainWidth={false}
            />,
        );

        const allViews = screen.findAllByType('View' as any);
        const contentView = allViews.find((node) => {
            const style = node.props?.style;
            if (!Array.isArray(style)) return false;
            return style.some((s) => s && typeof s === 'object' && 'maxWidth' in s);
        });

        expect(contentView).toBeTruthy();

        const flat = (contentView as any).props.style;
        const maxWidth = flat
            .filter((s: any) => s && typeof s === 'object' && 'maxWidth' in s)
            .at(-1)?.maxWidth;
        expect(maxWidth).toBe('100%');
    });

    it('renders header badges when provided', async () => {
        const { ChatHeaderView } = await import('./ChatHeaderView');

        const screen = await renderScreen(
            <ChatHeaderView
                title="Title"
                badges={['Direct', 'Codex · happy-host']}
            />,
        );

        expect(() => screen.findByProps({ testID: 'session-header-badge:0' })).not.toThrow();
        expect(() => screen.findByProps({ testID: 'session-header-badge:1' })).not.toThrow();
        expect(screen.getTextContent()).toContain('Direct');
        expect(screen.getTextContent()).toContain('Codex · happy-host');
    });

    it('suppresses session-scoped testIDs when the session screen is hidden', async () => {
        const { SessionScreenTestIdsProvider } = await import('../shell/sessionScreenTestIds');
        const { ChatHeaderView } = await import('./ChatHeaderView');

        const screen = await renderScreen(
            <SessionScreenTestIdsProvider enabled={false}>
                <ChatHeaderView
                    title="Title"
                    badges={['Direct']}
                    avatarId="avatar-1"
                    onAvatarPress={() => {}}
                />
            </SessionScreenTestIdsProvider>,
        );

        expect(screen.findAllByTestId('session-header-back')).toHaveLength(0);
        expect(screen.findAllByTestId('session-header-badge:0')).toHaveLength(0);
        expect(screen.findAllByTestId('session-header-avatar')).toHaveLength(0);
    });
});
