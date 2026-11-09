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
import { installTranscriptCommonModuleMocks, resetTranscriptCommonModuleMockState } from '@/components/sessions/transcript/transcriptTestHelpers';

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

vi.mock('@/utils/platform/responsive', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/utils/platform/responsive')>()),
    useHeaderHeight: () => 44,
}));

vi.mock('@expo/vector-icons', async () => createExpoVectorIconsMock());

vi.mock('@/components/ui/avatar/Avatar', () => ({
    Avatar: (props: any) => React.createElement('Avatar', props),
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


// Configure the native boundary before the store can load and cache its platform graph.
const { storage } = await import('@/sync/domains/state/storage');
const { SessionPaneHeader } = await import('./SessionPaneHeader');

describe('SessionPaneHeader', () => {
    afterEach(async () => {
        await standardCleanup();
        resetTranscriptCommonModuleMockState();
        storage.setState(storage.getInitialState(), true);
        platformState.os = 'ios';
        safeAreaState.insets.top = 0;
        safeAreaState.initial.insets.top = 0;
    });

    // The header's leading slot is a person's preference. `agentLogo` with no resolvable agent renders
    // nothing rather than quietly falling back to the avatar, which would override a choice already made.
    async function renderWithIdentity(
        mode: 'avatar' | 'agentLogo' | 'none',
        props: Pick<React.ComponentProps<typeof SessionPaneHeader>, 'avatarId' | 'agentIdentity'> = {
            avatarId: 'avatar-1',
            agentIdentity: React.createElement('AgentIdentityFixture', { testID: 'fixture-agent-identity' }),
        },
    ) {
        await act(async () => {
            storage.setState({ settings: { ...storage.getState().settings, sessionHeaderIdentityDisplay: mode } });
        });
        return renderScreen(<SessionPaneHeader title="Title" {...props} />);
    }

    it('leads with the identity the person chose, and nothing when the chosen mark cannot resolve', async () => {
        let screen = await renderWithIdentity('avatar');
        expect(screen.root.findAllByType('Avatar' as never)).toHaveLength(1);
        expect(screen.findByTestId('fixture-agent-identity')).toBeNull();
        await screen.unmount();
        screen = await renderWithIdentity('agentLogo');
        expect(screen.root.findAllByType('Avatar' as never)).toHaveLength(0);
        expect(screen.findAllByTestId('fixture-agent-identity')).toHaveLength(1);
        await screen.unmount();
        screen = await renderWithIdentity('none');
        expect(screen.root.findAllByType('Avatar' as never)).toHaveLength(0);
        expect(screen.findAllByTestId('session-header-avatar')).toHaveLength(0);
        await screen.unmount();
        screen = await renderWithIdentity('agentLogo', { avatarId: 'avatar-1' });
        expect(screen.root.findAllByType('Avatar' as never)).toHaveLength(0);
        expect(screen.findAllByTestId('session-header-avatar')).toHaveLength(0);
    });

    it('gives the role chip its compact form when the whole chip and the title no longer fit', async () => {
        // A role chip cut to "O…" beside a cut title reads broken: the chip is whole or it is its mark.
        const { SessionHeaderTitleAccessoryCompactContext } = await import('./sessionHeaderTitleCompact');
        function Accessory() {
            const compact = React.useContext(SessionHeaderTitleAccessoryCompactContext);
            return React.createElement('Text', null, compact ? 'MARK' : 'Orchestrator');
        }
        const screen = await renderScreen(<SessionPaneHeader title="Payments v2 rollout" titleAccessory={<Accessory />} />);
        const layout = async (testID: string, width: number) => {
            await act(async () => {
                screen.findHostByTestId(testID)!.props.onLayout({ nativeEvent: { layout: { width, height: 20, x: 0, y: 0 } } });
            });
        };
        await layout('session-header-title-accessory', 110);
        await layout('session-header-title-measure', 150);
        await layout('session-header-title-row', 400);
        expect(screen.getTextContent()).toContain('Orchestrator');
        await layout('session-header-title-row', 220);
        expect(screen.getTextContent()).toContain('MARK');
        expect(screen.getTextContent()).not.toContain('Orchestrator');
        await layout('session-header-title-row', 400);
        expect(screen.getTextContent()).toContain('Orchestrator');
    });

    it('compacts its controls rather than cutting the title when the band runs short', async () => {
        const { useDetailsTabHeaderActionsCompact } = await import('@/components/appShell/panes/details/header/DetailsTabHeader');
        function Controls() {
            return React.createElement('Text', null, useDetailsTabHeaderActionsCompact() ? '2' : '2 need you');
        }
        const screen = await renderScreen(<SessionPaneHeader title="Fix settings modal remount" rightElement={<Controls />} />);
        const layout = async (testID: string, width: number) => {
            await act(async () => {
                screen.findHostByTestId(testID)!.props.onLayout({ nativeEvent: { layout: { width, height: 20, x: 0, y: 0 } } });
            });
        };
        await layout('session-header.actions', 180);
        await layout('session-header.root', 900);
        expect(screen.getTextContent()).toContain('2 need you');
        await layout('session-header.root', 320);
        expect(screen.getTextContent()).not.toContain('2 need you');
        await layout('session-header.root', 900);
        expect(screen.getTextContent()).toContain('2 need you');
    });

    it('keeps a phone navigation band: Back below the status bar, with session metadata', async () => {
        safeAreaState.initial.insets.top = 22;
        const onBack = vi.fn();
        const screen = await renderScreen(<SessionPaneHeader title="Title" badges={['Direct']} onBackPress={onBack} />);
        expect(screen.getTextContent()).toContain('Direct');
        await screen.pressByTestIdAsync('session-header-back');
        expect(onBack).toHaveBeenCalledOnce();
        const band = screen.findHostByTestId('session-header')!;
        const flat = ([] as unknown[]).concat(band.props.style ?? []).flat(Infinity) as Array<Record<string, unknown> | null>;
        expect(flat.some((style) => style?.paddingTop === 22)).toBe(true);
    });

    it('keeps storage and host metadata below the session title alongside its subtitle', async () => {
        const badges = ['Direct', 'Claude · workstation-with-a-very-long-hostname'];
        const screen = await renderScreen(<SessionPaneHeader title="Investigate the session header"
            badges={badges} subtitle="~/projects/happier" onBackPress={() => {}} />);
        const titleRow = screen.findHostByTestId('session-header-title-row')!;
        for (const badge of badges) {
            expect(titleRow.findAll((node) => String(node.type) === 'Text' && node.props.children === badge)).toHaveLength(0);
        }
        const metadata = screen.findHostByTestId('session-header-metadata')!;
        expect(metadata).toBeTruthy();
        const text = screen.getTextContent();
        expect(text.indexOf('~/projects/happier')).toBeLessThan(text.indexOf('Direct'));
        for (const [index, badge] of badges.entries()) {
            const label = screen.findHostByTestId(`session-header-badge:${index}:label`)!;
            expect(label.props.numberOfLines).toBe(1);
            expect(screen.findHostByTestId(`session-header-badge:${index}`)?.props.accessibilityLabel).toBe(badge);
        }
        expect(metadata.findAll((node) => node.props.testID === 'session-header-subtitle').length).toBeGreaterThan(0);
    });

    it('suppresses session-scoped testIDs when the session screen is hidden', async () => {
        const { SessionScreenTestIdsProvider } = await import('../sessionScreenTestIds');
        const screen = await renderScreen(
            <SessionScreenTestIdsProvider enabled={false}>
                <SessionPaneHeader title="Title" badges={['Direct']} avatarId="avatar-1" onBackPress={() => {}} />
            </SessionScreenTestIdsProvider>,
        );
        expect(screen.findAllByTestId('session-header-back')).toHaveLength(0);
        expect(screen.findAllByTestId('session-header-badge:0')).toHaveLength(0);
        expect(screen.findAllByTestId('session-header-avatar')).toHaveLength(0);
    });

    it('keeps a path subtitle\'s end on the web without reordering its text', async () => {
        platformState.os = 'web';
        const subtitle = '~/Documents/Development/happier/remote-dev';
        const screen = await renderScreen(<SessionPaneHeader title="Title" subtitle={subtitle} subtitleEllipsizeMode="head" />);
        const outer = screen.findHostByTestId('session-header-subtitle')!;
        expect(outer.props.ellipsizeMode).toBeUndefined();
        const flatten = (style: unknown) => Object.assign({}, ...([] as unknown[]).concat(style ?? []).flat(Infinity).filter(Boolean) as object[]);
        expect(flatten(outer.props.style)).toMatchObject({ writingDirection: 'rtl', textAlign: 'left' });
        expect(screen.getTextContent()).toContain(subtitle);
    });

    it('renames in place on desktop: the title becomes the field, Escape restores it, a failed save keeps the draft', async () => {
        platformState.os = 'web';
        const screen = await renderScreen(<SessionPaneHeader title="Fix settings modal remount"
            rename={{ sessionId: 'session-without-home', serverId: null }} rightElement={React.createElement('Text', null, 'Follow')} />);
        await screen.pressByTestIdAsync('session-header-title');
        const input = () => screen.findHostByTestId('session-header-title-input');
        expect(input()?.props.value).toBe('Fix settings modal remount');
        // While editing, the band's controls step aside for Cancel and Save.
        expect(screen.getTextContent()).not.toContain('Follow');
        // An IME composition's Enter or Escape never commits or cancels.
        await act(async () => { input()!.props.onKeyPress({ nativeEvent: { key: 'Escape', isComposing: true } }); });
        expect(input()).not.toBeNull();
        await act(async () => { input()!.props.onKeyPress({ nativeEvent: { key: 'Escape' } }); });
        expect(input()).toBeNull();
        expect(screen.getTextContent()).toContain('Fix settings modal remount');
        expect(screen.getTextContent()).toContain('Follow');

        await screen.pressByTestIdAsync('session-header-title');
        await act(async () => { input()!.props.onChangeText('Fix the modal remount'); });
        // No Home is mounted for this session: the Action cannot be admitted, so the draft and the reason stay.
        await act(async () => { input()!.props.onSubmitEditing({ nativeEvent: { text: 'Fix the modal remount' } }); });
        await vi.waitFor(() => expect(screen.findHostByTestId('session-header-title-reason')).not.toBeNull());
        expect(input()?.props.value).toBe('Fix the modal remount');
    });

    it('keeps the title\'s hit area from covering the lineage breadcrumb stacked flush above it', async () => {
        const { HappierUiPlatformProvider } = await import('@happier-dev/plugin-ui/environment');
        const screen = await renderScreen(<HappierUiPlatformProvider platform={{ platform: 'ios', colorScheme: 'light' }}>
            <SessionPaneHeader title="Worker" lineage={React.createElement('Text', null, 'Lead')}
                rename={{ sessionId: 'session-without-home', serverId: null }} />
        </HappierUiPlatformProvider>);
        await act(async () => {
            screen.findHostByTestId('session-header-title')!.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 120, height: 20 } } });
        });
        const slop = screen.findHostByTestId('session-header-title')!.props.hitSlop as Record<'top' | 'bottom', number>;
        // The breadcrumb sits flush against the title, so the title takes none of that side; below it nothing competes.
        expect(slop.top).toBe(0);
        expect(slop.bottom).toBeGreaterThan(0);
    });

    it('shows the title as plain text where it cannot be renamed', async () => {
        platformState.os = 'web';
        const screen = await renderScreen(<SessionPaneHeader title="Read-only session" />);
        await screen.pressByTestIdAsync('session-header-title').catch(() => {});
        expect(screen.findHostByTestId('session-header-title-input')).toBeNull();
    });
});
