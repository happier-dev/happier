import * as React from 'react';
import { Text } from 'react-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { UnauthenticatedSplitShell } from './UnauthenticatedSplitShell';
import { useUnauthShellLayout, type UnauthShellLayout } from './useUnauthShellLayout';

const deviceState = vi.hoisted(() => ({
    safeAreaInsets: { top: 0, bottom: 0, left: 0, right: 0 },
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => deviceState.safeAreaInsets,
}));

// Stub the asset import — the JPG never resolves through Vitest's transformer.
vi.mock('@/assets/onboarding/planet-dark.jpg', () => ({ default: 'planet-dark.jpg' }));
vi.mock('@/assets/onboarding/planet-light.jpg', () => ({ default: 'planet-light.jpg' }));
vi.mock('@/assets/images/logotype-light.png', () => ({ default: 'logotype-light.png' }));

vi.mock('@/agents/registry/AgentIcon', () => ({
    AgentIcon: (props: Record<string, unknown>) => React.createElement('AgentIcon', props),
}));

vi.mock('./useUnauthShellLayout', () => ({
    useUnauthShellLayout: vi.fn(),
    MOBILE_MAX_WIDTH_PX: 720,
}));

function mockLayout(layout: UnauthShellLayout) {
    (useUnauthShellLayout as unknown as ReturnType<typeof vi.fn>).mockReturnValue(layout);
}

function FakeBody(props: { label: string }) {
    return <Text testID="fake-step-body">{props.label}</Text>;
}

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
    }
    if (style && typeof style === 'object') {
        return style as Record<string, unknown>;
    }
    return {};
}

describe('UnauthenticatedSplitShell', () => {
    beforeEach(() => {
        deviceState.safeAreaInsets = { top: 0, bottom: 0, left: 0, right: 0 };
    });

    it('renders both brand and workflow panes in split layout', async () => {
        mockLayout('split');
        const screen = await renderScreen(
            <UnauthenticatedSplitShell
                stepId="welcome"
                isWelcomeStep
                onOpenRelayCustomFlow={() => {}}
                onBrandHeroGetStarted={() => {}}
            >
                <FakeBody label="welcome" />
            </UnauthenticatedSplitShell>,
        );

        expect(screen.findByTestId('unauth-shell-split')).toBeTruthy();
        expect(screen.findByTestId('unauth-shell-brand-pane')).toBeTruthy();
        expect(screen.findByTestId('unauth-shell-workflow-pane')).toBeTruthy();
        expect(screen.findByTestId('fake-step-body')).toBeTruthy();
    });

    it('keeps the workflow pane shrinkable so nested setup and restore scroll views can scroll', async () => {
        mockLayout('split');
        const screen = await renderScreen(
            <UnauthenticatedSplitShell
                stepId="relay_select"
                isWelcomeStep={false}
                onOpenRelayCustomFlow={() => {}}
                onBrandHeroGetStarted={() => {}}
            >
                <FakeBody label="relay" />
            </UnauthenticatedSplitShell>,
        );

        const workflowPane = screen.findByTestId('unauth-shell-workflow-pane');
        expect(flattenStyle(workflowPane?.props.style).minHeight).toBe(0);
    });

    it('renders only the brand panel (with Get started) in mobile-hero layout', async () => {
        mockLayout('mobile-hero');
        const onBrandHeroGetStarted = vi.fn();
        const screen = await renderScreen(
            <UnauthenticatedSplitShell
                stepId="welcome"
                isWelcomeStep
                onOpenRelayCustomFlow={() => {}}
                onBrandHeroGetStarted={onBrandHeroGetStarted}
            >
                <FakeBody label="welcome" />
            </UnauthenticatedSplitShell>,
        );

        expect(screen.findByTestId('unauth-shell-brand-pane')).toBeTruthy();
        expect(screen.findByTestId('brand-hero-get-started')).toBeTruthy();
        // The workflow pane is not mounted in mobile-hero.
        expect(screen.findAllByTestId('fake-step-body')).toEqual([]);

        screen.pressByTestId('brand-hero-get-started');
        expect(onBrandHeroGetStarted).toHaveBeenCalledTimes(1);
    });

    it('keeps mobile brand hero content inside native safe areas', async () => {
        mockLayout('mobile-hero');
        deviceState.safeAreaInsets = { top: 44, bottom: 34, left: 0, right: 0 };

        const screen = await renderScreen(
            <UnauthenticatedSplitShell
                stepId="welcome"
                isWelcomeStep
                onOpenRelayCustomFlow={() => {}}
                onBrandHeroGetStarted={() => {}}
            >
                <FakeBody label="welcome" />
            </UnauthenticatedSplitShell>,
        );

        const content = screen.findByTestId('unauth-shell-brand-content-mobile');
        const style = flattenStyle(content?.props.style);
        expect(style.top).toBe(68);
        expect(style.bottom).toBe(62);
    });

    it('renders only the workflow pane in mobile-workflow layout', async () => {
        mockLayout('mobile-workflow');
        const screen = await renderScreen(
            <UnauthenticatedSplitShell
                stepId="welcome"
                isWelcomeStep
                onOpenRelayCustomFlow={() => {}}
                onBrandHeroGetStarted={() => {}}
            >
                <FakeBody label="welcome" />
            </UnauthenticatedSplitShell>,
        );

        expect(screen.findByTestId('unauth-shell-mobile-workflow')).toBeTruthy();
        expect(screen.findByTestId('unauth-shell-workflow-pane')).toBeTruthy();
        expect(screen.findByTestId('fake-step-body')).toBeTruthy();
        expect(screen.findAllByTestId('unauth-shell-brand-pane')).toEqual([]);
    });

    it('keeps mobile workflow content inside native safe areas and stretches transitioned content', async () => {
        mockLayout('mobile-workflow');
        deviceState.safeAreaInsets = { top: 44, bottom: 34, left: 0, right: 0 };

        const screen = await renderScreen(
            <UnauthenticatedSplitShell
                stepId="auth_restore"
                isWelcomeStep={false}
                onOpenRelayCustomFlow={() => {}}
                onBrandHeroGetStarted={() => {}}
                onBack={() => {}}
            >
                <FakeBody label="restore" />
            </UnauthenticatedSplitShell>,
        );

        const workflowScroll = screen.findByTestId('unauth-shell-workflow-scroll');
        const workflowStyle = flattenStyle(workflowScroll?.props.contentContainerStyle);
        expect(workflowStyle.paddingTop).toBe(72);
        expect(workflowStyle.paddingBottom).toBe(62);

        const transitionHost = screen.findByTestId('unauth-shell-step-transition');
        expect(flattenStyle(transitionHost?.props.style).flex).toBe(1);
        const transitionLayer = transitionHost?.children[0] as { props?: { style?: unknown } } | undefined;
        expect(flattenStyle(transitionLayer?.props?.style).flex).toBe(1);
        expect(flattenStyle(transitionLayer?.props?.style).minHeight).toBe(0);
    });

    it('lets scanner-style mobile workflow steps render full-bleed without shell padding', async () => {
        mockLayout('mobile-workflow');
        deviceState.safeAreaInsets = { top: 44, bottom: 34, left: 0, right: 0 };

        const screen = await renderScreen(
            <UnauthenticatedSplitShell
                stepId="auth_restore"
                isWelcomeStep={false}
                workflowPresentation="fullBleed"
                onOpenRelayCustomFlow={() => {}}
                onBrandHeroGetStarted={() => {}}
            >
                <FakeBody label="restore" />
            </UnauthenticatedSplitShell>,
        );

        const workflowScroll = screen.findByTestId('unauth-shell-workflow-scroll');
        const workflowStyle = flattenStyle(workflowScroll?.props.contentContainerStyle);
        expect(workflowStyle.paddingTop).toBe(0);
        expect(workflowStyle.paddingRight).toBe(0);
        expect(workflowStyle.paddingBottom).toBe(0);
        expect(workflowStyle.paddingLeft).toBe(0);
    });

    it('renders WelcomeFooterLinks only when isWelcomeStep is true', async () => {
        mockLayout('split');
        const screenWelcome = await renderScreen(
            <UnauthenticatedSplitShell
                stepId="welcome"
                isWelcomeStep
                onOpenRelayCustomFlow={() => {}}
                onBrandHeroGetStarted={() => {}}
            >
                <FakeBody label="welcome" />
            </UnauthenticatedSplitShell>,
        );
        expect(screenWelcome.findByTestId('welcome-footer-links')).toBeTruthy();

        const screenOther = await renderScreen(
            <UnauthenticatedSplitShell
                stepId="auth_restore"
                isWelcomeStep={false}
                onOpenRelayCustomFlow={() => {}}
                onBrandHeroGetStarted={() => {}}
            >
                <FakeBody label="restore" />
            </UnauthenticatedSplitShell>,
        );
        expect(screenOther.findAllByTestId('welcome-footer-links')).toEqual([]);
    });

    it('renders BackChevron only when onBack is provided', async () => {
        mockLayout('split');
        const onBack = vi.fn();
        const screenWithBack = await renderScreen(
            <UnauthenticatedSplitShell
                stepId="auth_restore"
                isWelcomeStep={false}
                onOpenRelayCustomFlow={() => {}}
                onBrandHeroGetStarted={() => {}}
                onBack={onBack}
            >
                <FakeBody label="restore" />
            </UnauthenticatedSplitShell>,
        );
        expect(screenWithBack.findByTestId('unauth-shell-back-chevron')).toBeTruthy();
        screenWithBack.pressByTestId('unauth-shell-back-chevron');
        expect(onBack).toHaveBeenCalledTimes(1);

        const screenNoBack = await renderScreen(
            <UnauthenticatedSplitShell
                stepId="welcome"
                isWelcomeStep
                onOpenRelayCustomFlow={() => {}}
                onBrandHeroGetStarted={() => {}}
            >
                <FakeBody label="welcome" />
            </UnauthenticatedSplitShell>,
        );
        expect(screenNoBack.findAllByTestId('unauth-shell-back-chevron')).toEqual([]);
    });

    it('invokes onOpenRelayCustomFlow when the welcome footer Relay link is pressed', async () => {
        mockLayout('split');
        const onOpenRelayCustomFlow = vi.fn();
        const screen = await renderScreen(
            <UnauthenticatedSplitShell
                stepId="welcome"
                isWelcomeStep
                onOpenRelayCustomFlow={onOpenRelayCustomFlow}
                onBrandHeroGetStarted={() => {}}
            >
                <FakeBody label="welcome" />
            </UnauthenticatedSplitShell>,
        );

        screen.pressByTestId('welcome-footer-relay-action');
        expect(onOpenRelayCustomFlow).toHaveBeenCalledTimes(1);
    });
});
