import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    createExpoVectorIconsMock,
    createExpoRouterMock,
    createReactNavigationNativeMock,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { installTranscriptCommonModuleMocks, resetTranscriptCommonModuleMockState } from './transcriptTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const platformState = vi.hoisted(() => ({
    os: 'ios' as 'ios' | 'web',
}));

installTranscriptCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                get OS() {
                    return platformState.os;
                },
                select: (values: any) =>
                    platformState.os === 'web'
                        ? values?.web ?? values?.default ?? null
                        : values?.ios ?? values?.default ?? null,
            },
            View: 'View',
            Text: 'Text',
            Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
        });
    },
    unistyles: async () => {
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
    },
});

const safeAreaState = vi.hoisted(() => ({
    insets: { top: 0, bottom: 0, left: 0, right: 0 },
    initial: { insets: { top: 0, bottom: 0, left: 0, right: 0 } },
}));

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => safeAreaState.insets,
    initialWindowMetrics: safeAreaState.initial,
}));

vi.mock('@react-navigation/native', () => createReactNavigationNativeMock({
    navigation: { goBack: vi.fn() },
}));

vi.mock('expo-router', () => createExpoRouterMock().module);

vi.mock('@/utils/platform/responsive', () => ({
    useHeaderHeight: () => 44,
}));

vi.mock('@expo/vector-icons', async () => createExpoVectorIconsMock());

vi.mock('@/components/ui/avatar/Avatar', () => ({
    Avatar: (props: any) => React.createElement('Avatar', props),
}));

// Every Typography role resolves to no font styling; modules pulled in through the storage and list
// chain use roles beyond `default` at import time.
vi.mock('@/constants/Typography', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/constants/Typography')>()),
    Typography: new Proxy({}, { get: () => () => ({}) }),
}));

vi.mock('@/components/ui/layout/layout', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/components/ui/layout/layout')>();
    return {
        ...actual,
        // `layout`'s width getters read the stored content-width preference; spreading them would
        // run those reads while the storage module is still initializing. Inherit them lazily.
        layout: Object.defineProperty(Object.create(actual.layout), 'headerMaxWidth', { value: 1024 }),
        useLayoutMaxWidth: () => 1024,
    };
});

function flattenStyle(style: unknown): Record<string, unknown> {
    if (!Array.isArray(style)) {
        return style && typeof style === 'object' ? style as Record<string, unknown> : {};
    }

    return Object.assign({}, ...style.flat().filter((entry) => entry && typeof entry === 'object'));
}

// Configure the native boundary before the store can load and cache its platform graph.
const { storage } = await import('@/sync/domains/state/storage');
const { Platform } = await import('react-native');
const { ChatHeaderView } = await import('./ChatHeaderView');

describe('ChatHeaderView', () => {
    afterEach(async () => {
        await standardCleanup();
        resetTranscriptCommonModuleMockState();
        storage.setState(storage.getInitialState(), true);
        platformState.os = 'ios';
        safeAreaState.insets.top = 0;
        safeAreaState.insets.bottom = 0;
        safeAreaState.insets.left = 0;
        safeAreaState.insets.right = 0;
        safeAreaState.initial.insets.top = 0;
        safeAreaState.initial.insets.bottom = 0;
        safeAreaState.initial.insets.left = 0;
        safeAreaState.initial.insets.right = 0;
    });

    // The header's leading slot is a user preference. `agentLogo` with no resolvable agent renders
    // nothing rather than quietly falling back to the avatar, which would override a choice the user
    // already made.
    async function renderWithIdentity(
        mode: 'avatar' | 'agentLogo' | 'none',
        props: Pick<React.ComponentProps<typeof ChatHeaderView>, 'avatarId' | 'agentIdentity'> = {
            avatarId: 'avatar-1',
            agentIdentity: React.createElement('AgentIdentityFixture', { testID: 'fixture-agent-identity' }),
        },
    ) {
        await act(async () => {
            storage.setState({ settings: { ...storage.getState().settings, sessionHeaderIdentityDisplay: mode } });
        });
        return renderScreen(<ChatHeaderView title="Title" {...props} />);
    }

    it('leads with the generated avatar by default', async () => {
        const screen = await renderWithIdentity('avatar');
        expect(screen.root.findAllByType('Avatar' as never)).toHaveLength(1);
        expect(screen.findByTestId('fixture-agent-identity')).toBeNull();
    });

    it('leads with the agent logo when the user picks it', async () => {
        const screen = await renderWithIdentity('agentLogo');
        expect(screen.root.findAllByType('Avatar' as never)).toHaveLength(0);
        expect(screen.findAllByTestId('fixture-agent-identity')).toHaveLength(1);
    });

    it('leads with the title when the user picks none', async () => {
        const screen = await renderWithIdentity('none');
        expect(screen.root.findAllByType('Avatar' as never)).toHaveLength(0);
        expect(screen.findAllByTestId('session-header-avatar')).toHaveLength(0);
    });

    it('shows nothing rather than the avatar when the agent logo is picked but no agent resolves', async () => {
        const screen = await renderWithIdentity('agentLogo', { avatarId: 'avatar-1' });
        expect(screen.root.findAllByType('Avatar' as never)).toHaveLength(0);
        expect(screen.findByTestId('fixture-agent-identity')).toBeNull();
        expect(screen.findAllByTestId('session-header-avatar')).toHaveLength(0);
    });

    it('uses elevation to keep the header above scroll content on Android', async () => {
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

    it('shares one band with a side pane header: same height, so the two headers line up', async () => {
        platformState.os = 'web';
        const { ChatHeaderView } = await import('./ChatHeaderView');
        const { PaneHeader } = await import('@/components/appShell/panes/PaneHeader');

        const screen = await renderScreen(
            <>
                <ChatHeaderView title="Payments v2 rollout" subtitle="~/src/payments" />
                <PaneHeader title="Workstream" subtitle="4 sessions" />
            </>,
        );
        const heightOf = (testID: string) => {
            const node = screen.findHostByTestId(testID);
            const flat = ([] as unknown[]).concat(node?.props.style ?? []).flat(Infinity) as Array<Record<string, unknown> | null>;
            return flat.reduce<unknown>((height, style) => (style && 'height' in style ? style.height : height), undefined);
        };

        const bandHeight = heightOf('session-header-band');
        expect(typeof bandHeight).toBe('number');
        expect(heightOf('pane-header')).toBe(bandHeight);
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

    it('pads the header below the status bar using chrome-safe-area fallback insets', async () => {
        expect(Platform.OS).toBe('ios');
        safeAreaState.insets.top = 0;
        safeAreaState.insets.bottom = 0;
        safeAreaState.insets.left = 0;
        safeAreaState.insets.right = 0;
        safeAreaState.initial.insets.top = 22;
        safeAreaState.initial.insets.bottom = 0;
        safeAreaState.initial.insets.left = 0;
        safeAreaState.initial.insets.right = 0;

        const { ChatHeaderView } = await import('./ChatHeaderView');

        const screen = await renderScreen(<ChatHeaderView title="Title" />);

        const allViews = screen.findAllByType('View' as any);
        const containerView = allViews.find((node) => {
            const style = node.props?.style;
            const flat = Array.isArray(style) ? style.flat() : [style];
            return flat.some((s) => s && typeof s === 'object' && s.paddingTop === 22);
        });

        expect(containerView).toBeTruthy();
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
                />
            </SessionScreenTestIdsProvider>,
        );

        expect(screen.findAllByTestId('session-header-back')).toHaveLength(0);
        expect(screen.findAllByTestId('session-header-badge:0')).toHaveLength(0);
        expect(screen.findAllByTestId('session-header-avatar')).toHaveLength(0);
    });

    it('uses start-side overflow ellipsis for head-mode subtitles on web without reordering path text', async () => {
        platformState.os = 'web';
        const subtitle = '~/Documents/Development/happier/remote-dev';
        const { ChatHeaderView } = await import('./ChatHeaderView');

        const screen = await renderScreen(
            <ChatHeaderView
                title="Title"
                subtitle={subtitle}
                subtitleEllipsizeMode="head"
            />,
        );

        const outerSubtitleText = screen.findAllByType('Text' as any).find((node) => (
            node.children.some((child) => typeof child === 'object' && child?.props?.children === subtitle)
        ));
        expect(outerSubtitleText).toBeTruthy();
        expect(outerSubtitleText?.props.ellipsizeMode).toBeUndefined();
        expect(flattenStyle(outerSubtitleText?.props.style)).toMatchObject({
            writingDirection: 'rtl',
            textAlign: 'left',
        });

        const innerSubtitleText = screen.findAllByType('Text' as any).find((node) => node.props.children === subtitle);
        expect(innerSubtitleText).toBeTruthy();
        expect(flattenStyle(innerSubtitleText?.props.style)).toMatchObject({
            writingDirection: 'ltr',
            unicodeBidi: 'isolate',
        });
    });

    it('uses native head ellipsis for head-mode subtitles outside web', async () => {
        platformState.os = 'ios';
        expect(Platform.OS).toBe('ios');
        const subtitle = '~/Documents/Development/happier/remote-dev';
        const { ChatHeaderView } = await import('./ChatHeaderView');

        const screen = await renderScreen(
            <ChatHeaderView
                title="Title"
                subtitle={subtitle}
                subtitleEllipsizeMode="head"
            />,
        );

        const subtitleText = screen.findAllByType('Text' as any).find((node) => node.props.children === subtitle);
        expect(subtitleText).toBeTruthy();
        expect(subtitleText?.props.ellipsizeMode).toBe('head');
    });
});
