import * as React from 'react';
import { Platform, Text } from 'react-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';

import { stageVisualTokens } from '../tour/stage/stageVisualTokens';
import { StagePane } from './StagePane';
import { UnauthenticatedSplitShell } from './UnauthenticatedSplitShell';
import { useUnauthShellLayout, type UnauthShellLayout } from './useUnauthShellLayout';

const deviceState = vi.hoisted(() => ({
    safeAreaInsets: { top: 0, bottom: 0, left: 0, right: 0 },
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@/text/index', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@/text/i18n', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
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

    it('renders brand stage left and workflow right in split layout (R1 order)', async () => {
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

        // R1 reference order (and D5): planet/brand pane LEFT, workflow column
        // RIGHT. A mirrored shell (column-left) is a regression.
        const splitRoot = screen.findByTestId('unauth-shell-split');
        const paneOrder = splitRoot
            ?.findAll((node) => (
                node.props?.testID === 'unauth-shell-workflow-pane'
                || node.props?.testID === 'unauth-shell-stage-pane'
            ))
            .map((node) => node.props.testID);
        expect(paneOrder).toEqual([
            'unauth-shell-stage-pane',
            'unauth-shell-workflow-pane',
        ]);
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
                retentionSummary="This relay cleans up subagent transcripts after 7 days."
                onOpenRelayCustomFlow={() => {}}
                onBrandHeroGetStarted={() => {}}
            >
                <FakeBody label="welcome" />
            </UnauthenticatedSplitShell>,
        );
        expect(screenWelcome.findByTestId('welcome-footer-links')).toBeTruthy();
        expect(screenWelcome.findByTestId('welcome-footer-retention')).toBeTruthy();
        expect(screenWelcome.getTextContent()).toContain('This relay cleans up subagent transcripts after 7 days.');

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
        const backRow = screenWithBack.findByTestId('unauth-shell-back-row');
        expect(backRow).toBeTruthy();
        expect(flattenStyle(backRow?.props.style)).toMatchObject({
            position: 'absolute',
            zIndex: 1,
        });
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

describe('StagePane', () => {
    beforeEach(() => {
        deviceState.safeAreaInsets = { top: 0, bottom: 0, left: 0, right: 0 };
    });

    it('renders the existing brand panel in brand mode', async () => {
        const screen = await renderScreen(<StagePane mode="brand" />);

        expect(screen.findByTestId('unauth-shell-stage-pane')).toBeTruthy();
        expect(screen.findByTestId('unauth-shell-brand-pane')).toBeTruthy();
    });

    it('renders stage children over the receded planet wallpaper without mounting the brand panel in stage mode', async () => {
        const screen = await renderScreen(
            <StagePane
                mode="stage"
                accentHue="#FFB14A"
                planetOpacity={0.58}
                planetScale={0.9}
            >
                <Text testID="future-demo-stage">demo stage</Text>
            </StagePane>,
        );

        expect(screen.findByTestId('unauth-shell-stage-pane')).toBeTruthy();
        expect(screen.findByTestId('unauth-shell-stage-sky')).toBeTruthy();
        expect(screen.findByTestId('unauth-shell-stage-atmosphere')).toBeTruthy();
        expect(screen.findByTestId('unauth-shell-stage-bloom')).toBeTruthy();
        expect(screen.findByTestId('unauth-shell-stage-noise')).toBeTruthy();
        expect(screen.findByTestId('unauth-shell-stage-wallpaper-host')).toBeTruthy();
        expect(screen.findByTestId('planet-background-desktop')).toBeTruthy();
        expect(screen.findByTestId('future-demo-stage')).toBeTruthy();
        expect(screen.findAllByTestId('unauth-shell-brand-pane')).toEqual([]);
        expect(screen.findByTestId('unauth-shell-stage-wallpaper-wash')).toBeNull();

        const skyStyle = flattenStyle(screen.findByTestId('unauth-shell-stage-sky')?.props.style);
        expect(skyStyle.backgroundColor).toBe(stageVisualTokens.horizon.light.backgroundColor);
        expect(skyStyle.backgroundImage).toBe(stageVisualTokens.horizon.light.skyGradient);

        const atmosphereStyle = flattenStyle(screen.findByTestId('unauth-shell-stage-atmosphere')?.props.style);
        const bloomStyle = flattenStyle(screen.findByTestId('unauth-shell-stage-bloom')?.props.style);
        const noiseStyle = flattenStyle(screen.findByTestId('unauth-shell-stage-noise')?.props.style);
        expect(atmosphereStyle.backgroundColor).toBe(
            Platform.OS === 'web' ? 'transparent' : stageVisualTokens.horizon.light.atmosphereColor,
        );
        expect(bloomStyle.backgroundColor).toBe(
            Platform.OS === 'web' ? 'transparent' : stageVisualTokens.horizon.light.bloomColor,
        );
        if (Platform.OS === 'web') {
            expect(noiseStyle.backgroundImage).toContain(stageVisualTokens.horizon.noiseTileDataUri);
            expect(noiseStyle.backgroundRepeat).toBe('repeat');
        }

        // ONE planet framing recipe (spec §1). The stage used to select its own
        // `desktopComposition="horizon"` crop ('50%' / '86%'), which anchored the
        // disc centred and read as a floating ball cut off at the narration
        // divider; it now makes the same `PlanetBackground` call the welcome
        // brand pane makes. Asserting parity against a real brand-mode render —
        // rather than restating a literal — is what this file is uniquely placed
        // to check: it fails if either pane grows its own framing again.
        const brandPane = await renderScreen(<StagePane mode="brand" />);
        const brandPlanet = brandPane.findByTestId('planet-background-desktop');
        const planet = screen.findByTestId('planet-background-desktop');
        expect(brandPlanet?.props.contentPosition).toBeTruthy();
        expect(planet?.props.contentFit).toBe(brandPlanet?.props.contentFit);
        expect(planet?.props.contentPosition).toEqual(brandPlanet?.props.contentPosition);

        const wallpaperHost = screen.findByTestId('unauth-shell-stage-wallpaper-host');
        const style = flattenStyle(wallpaperHost?.props.style);
        expect(style.opacity).toBe(0.58);
        expect(style.transform).toEqual([{ scale: 0.9 }]);
    });

    it('applies the planet recede opacity and scale to brand mode', async () => {
        const screen = await renderScreen(
            <StagePane
                mode="brand"
                planetOpacity={0.42}
                planetScale={0.94}
            />,
        );

        const brandHost = screen.findByTestId('unauth-shell-stage-brand-host');
        const style = flattenStyle(brandHost?.props.style);
        expect(style.opacity).toBe(0.42);
        expect(style.transform).toEqual([{ scale: 0.94 }]);
    });
});
