import React from 'react';
import { act } from 'react-test-renderer';
import { measureNativeLayout } from '@/dev/testkit/render/measureNativeLayout';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    createExpoVectorIconsMock,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { installTranscriptCommonModuleMocks, resetTranscriptCommonModuleMockState } from './transcriptTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let platformOs: 'ios' | 'android' | 'web' = 'ios';
const headerMocks = vi.hoisted(() => ({
    identityMode: 'avatar' as 'avatar' | 'agentLogo' | 'none',
}));

installTranscriptCommonModuleMocks({
    // Only this one key is steered; every other setting still resolves through the real module, or
    // the rest of the tree renders against undefined and the suite falls over.
    storage: async (importOriginal: <T>() => Promise<T>) => {
        const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        const base = await createPartialStorageModuleMock(importOriginal, {});
        return {
            ...base,
            useSetting: ((key: string) => (key === 'sessionHeaderIdentityDisplay'
                ? headerMocks.identityMode
                : (base.useSetting as (k: string) => unknown)(key))) as typeof base.useSetting,
        };
    },
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                get OS() {
                    return platformOs;
                },
                select: (values: any) => values?.[platformOs] ?? values?.default ?? null,
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

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return createReactNavigationNativeMock();
});

vi.mock('@/utils/platform/responsive', () => ({
    useHeaderHeight: () => 44,
}));

vi.mock('@expo/vector-icons', async () => createExpoVectorIconsMock());

vi.mock('@/components/ui/avatar/Avatar', () => ({
    Avatar: (props: any) => React.createElement('Avatar', props),
}));

vi.mock('@/agents/registry/AgentIcon', () => ({
    AgentIcon: (props: any) => React.createElement('AgentIcon', props),
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { headerMaxWidth: 1024 },
    useLayoutMaxWidth: () => 1024,
}));

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>((acc, entry) => ({
            ...acc,
            ...flattenStyle(entry),
        }), {});
    }
    if (!style || typeof style !== 'object') {
        return {};
    }
    return style as Record<string, unknown>;
}


describe('ChatHeaderView', () => {
    afterEach(() => {
        platformOs = 'ios';
        headerMocks.identityMode = 'avatar';
        standardCleanup();
        resetTranscriptCommonModuleMockState();
    });

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

    it.each([
        { platform: 'android' as const, width: 320, textScale: 1 },
        { platform: 'ios' as const, width: 390, textScale: 1.6 },
        { platform: 'web' as const, width: 768, textScale: 1 },
    ])('keeps the title above bounded metadata and distinct action targets on $platform', async ({ platform, width, textScale }) => {
        platformOs = platform;
        const { ChatHeaderView } = await import('./ChatHeaderView');
        const { resolveSessionHeaderActionTargetPx } = await import('../actions/sessionHeaderIconMetrics');
        const target = resolveSessionHeaderActionTargetPx();
        const title = 'Investigate the session header';
        const badge = 'Claude · workstation-with-a-very-long-hostname';
        const screen = await renderScreen(
            <ChatHeaderView title={title} subtitle="~/projects/happier" avatarId="avatar-1" badges={['Direct', badge]}
                rightElement={React.createElement('View', { testID: 'actions', style: { width: target * 3, height: target } })} />,
        );
        const content = screen.findAllByType('View' as never).find((node) => {
            const style = flattenStyle(node.props.style);
            return style.width === '100%' && style.flexDirection === 'row';
        });
        if (!content) throw new Error('Missing header content');
        const text = (value: string) => screen.root.findAll((node) => String(node.type) === 'Text' && node.props.children === value)[0];
        const layout = measureNativeLayout(content, width, textScale);
        try {
            const titleRect = layout.rect(text(title));
            const badgeRect = layout.rect(text(badge));
            const pathRect = layout.rect(text('~/projects/happier'));
            const storageRect = layout.rect(text('Direct'));
            const actions = layout.rect(screen.root.findByProps({ testID: 'actions' }));
            const back = layout.rect(screen.root.findAll((node) => String(node.type) === 'Pressable' && node.props.testID === 'session-header-back')[0]);
            expect(titleRect.width).toBeGreaterThan(0);
            expect(badgeRect.top).toBeGreaterThanOrEqual(titleRect.top + titleRect.height);
            expect(pathRect.left + pathRect.width).toBeLessThanOrEqual(storageRect.left);
            for (const label of [title, 'Direct', badge, '~/projects/happier']) {
                const rect = layout.rect(text(label));
                expect(rect.left + rect.width).toBeLessThanOrEqual(actions.left + 0.5);
                expect(rect.top + rect.height, JSON.stringify({ label, rect, content: layout.rect(content) })).toBeLessThanOrEqual(layout.rect(content).height + 0.5);
            }
            expect(back.width).toBeGreaterThanOrEqual(target);
            expect(back.height).toBeGreaterThanOrEqual(target);
            expect(actions.width).toBe(target * 3);
            expect(actions.left + actions.width).toBeLessThanOrEqual(width);
        } finally {
            layout.free();
        }
    });

    // The header's leading slot is a user preference. `agentLogo` with no resolvable agent renders
    // nothing rather than quietly falling back to the avatar, which would override a choice the user
    // already made.
    async function renderWithIdentity(
        mode: 'avatar' | 'agentLogo' | 'none',
        props: { avatarId?: string; agentId?: string; flavor?: string } = { avatarId: 'avatar-1', agentId: 'claude' },
    ) {
        headerMocks.identityMode = mode;
        const { ChatHeaderView } = await import('./ChatHeaderView');
        return renderScreen(<ChatHeaderView title="Title" {...(props as object)} />);
    }

    it('leads with the generated avatar by default', async () => {
        const screen = await renderWithIdentity('avatar', { avatarId: 'avatar-1', agentId: 'codex', flavor: 'claude' });
        expect(screen.root.findAllByType('Avatar' as never)).toHaveLength(1);
        expect(screen.root.findByType('Avatar' as never).props.flavor).toBe('codex');
        expect(screen.root.findAllByType('AgentIcon' as never)).toHaveLength(0);
    });

    it('leads with the agent logo when the user picks it', async () => {
        const screen = await renderWithIdentity('agentLogo');
        expect(screen.root.findAllByType('Avatar' as never)).toHaveLength(0);
        const icons = screen.root.findAllByType('AgentIcon' as never);
        expect(icons).toHaveLength(1);
        expect((icons[0] as unknown as { props: { agentId: string } }).props.agentId).toBe('claude');
    });

    it('leads with the title when the user picks none', async () => {
        const screen = await renderWithIdentity('none');
        expect(screen.root.findAllByType('Avatar' as never)).toHaveLength(0);
        expect(screen.findAllByTestId('session-header-avatar')).toHaveLength(0);
    });

    it('shows nothing rather than the avatar when the agent logo is picked but no agent resolves', async () => {
        const screen = await renderWithIdentity('agentLogo', { avatarId: 'avatar-1' });
        expect(screen.root.findAllByType('Avatar' as never)).toHaveLength(0);
        expect(screen.root.findAllByType('AgentIcon' as never)).toHaveLength(0);
        expect(screen.findAllByTestId('session-header-avatar')).toHaveLength(0);
    });

    // The content column is capped at 1024 (mocked above) and centred, so a 1400pt window leaves a
    // 188pt margin on each side and a 1100pt one leaves 38pt. The gutter control moves between the
    // margin and the icon row on that measurement — the rule this pair of tests pins down.
    async function renderWithWrapperWidth(width: number) {
        const { ChatHeaderView } = await import('./ChatHeaderView');
        const screen = await renderScreen(
            <ChatHeaderView
                title="Title"
                gutterElement={React.createElement('GutterControl')}
            />,
        );
        const wrapper = screen.root.findAll((node) => typeof node.props?.onLayout === 'function')[0];
        await act(async () => {
            wrapper.props.onLayout({ nativeEvent: { layout: { width, height: 44, x: 0, y: 0 } } });
        });
        return screen;
    }

    it('places the gutter control in the margin beside the content when the margin can hold it', async () => {
        const screen = await renderWithWrapperWidth(1400);

        const gutter = screen.root.findAll((node) => {
            const style = flattenStyle(node.props?.style);
            return style.position === 'absolute' && style.right === 0 && typeof style.width === 'number';
        });
        expect(gutter).toHaveLength(1);
        expect(flattenStyle(gutter[0].props.style).width).toBe(188);
        expect(gutter[0].findAllByType('GutterControl' as never)).toHaveLength(1);
    });

    it('falls back to the icon row when the margin is too narrow for the gutter control', async () => {
        const screen = await renderWithWrapperWidth(1100);

        const gutter = screen.root.findAll((node) => {
            const style = flattenStyle(node.props?.style);
            return style.position === 'absolute' && style.right === 0 && typeof style.width === 'number';
        });
        expect(gutter).toHaveLength(0);
        // Still rendered — it moved, it did not disappear.
        expect(screen.root.findAllByType('GutterControl' as never)).toHaveLength(1);
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
        platformOs = 'web';
        const { ChatHeaderView } = await import('./ChatHeaderView');
        const subtitle = '~/Documents/Development/happier-demo-projects/lantern';

        const screen = await renderScreen(
            <ChatHeaderView
                title="Title"
                subtitle={subtitle}
                subtitleEllipsizeMode="head"
            />,
        );

        const outerSubtitle = screen.root.findAll((node) => {
            const style = flattenStyle(node.props?.style);
            return String(node.type) === 'Text'
                && node.props.numberOfLines === 1
                && style.writingDirection === 'rtl';
        })[0];
        const innerSubtitle = screen.root.findAll((node) =>
            String(node.type) === 'Text'
            && node.props.children === subtitle,
        )[0];

        expect(screen.getTextContent()).toContain(subtitle);
        expect(outerSubtitle).toBeTruthy();
        expect(innerSubtitle).toBeTruthy();
        expect(flattenStyle(outerSubtitle?.props.style)).toMatchObject({
            writingDirection: 'rtl',
            textAlign: 'left',
        });
        expect(flattenStyle(innerSubtitle?.props.style)).toMatchObject({
            writingDirection: 'ltr',
            unicodeBidi: 'isolate',
        });
    });

    it('uses native head ellipsis for head-mode subtitles outside web', async () => {
        platformOs = 'ios';
        const { ChatHeaderView } = await import('./ChatHeaderView');
        const subtitle = '~/Documents/Development/happier-demo-projects/lantern';

        const screen = await renderScreen(
            <ChatHeaderView
                title="Title"
                subtitle={subtitle}
                subtitleEllipsizeMode="head"
            />,
        );

        const subtitleNode = screen.root.findAll((node) =>
            String(node.type) === 'Text'
            && node.props.children === subtitle
            && node.props.numberOfLines === 1,
        )[0];

        expect(subtitleNode?.props.ellipsizeMode).toBe('head');
    });
});
