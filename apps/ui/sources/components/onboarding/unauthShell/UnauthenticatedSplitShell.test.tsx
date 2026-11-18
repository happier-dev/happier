import * as React from 'react';
import { Text, TextInput } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import { onboardingHistoryState } from '@/sync/domains/state/onboardingUiState';

import { StagePane } from './StagePane';
import { UnauthenticatedSplitShell } from './UnauthenticatedSplitShell';
import type { UnauthShellLayout } from './useUnauthShellLayout';

const deviceState = vi.hoisted(() => ({
    safeAreaInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    width: 1000,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        useWindowDimensions: () => ({ width: deviceState.width, height: 800, scale: 1, fontScale: 1 }),
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

vi.mock('@/text/index', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@/text/i18n', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('react-native-safe-area-context', async (importOriginal) => {
    const actual = await importOriginal<typeof import('react-native-safe-area-context')>();
    return { ...actual, useSafeAreaInsets: () => deviceState.safeAreaInsets };
});

// Stub the asset import — the JPG never resolves through Vitest's transformer.
vi.mock('@/assets/onboarding/planet-dark.jpg', () => ({ default: 'planet-dark.jpg' }));
vi.mock('@/assets/onboarding/planet-light.jpg', () => ({ default: 'planet-light.jpg' }));
vi.mock('@/assets/images/logotype-light.png', () => ({ default: 'logotype-light.png' }));

vi.mock('@/agents/registry/AgentIcon', () => ({
    AgentIcon: (props: Record<string, unknown>) => React.createElement('AgentIcon', props),
}));

const initialStorageState = storage.getState();

function setLayoutFixture(layout: UnauthShellLayout) {
    deviceState.width = layout === 'split' ? 1000 : 390;
    onboardingHistoryState.set('brandHeroSeenAt', layout === 'mobile-workflow' ? 1 : null);
}

function FakeBody(props: { label: string }) {
    return <Text testID="fake-step-body">{props.label}</Text>;
}

function RecoveryDraft() {
    const [value, setValue] = React.useState('');
    return <TextInput testID="recovery-draft" value={value} onChangeText={setValue} />;
}

function flattenStyle(style: unknown): Record<string, unknown> {
    if (typeof style === 'function') {
        return flattenStyle((style as (state: { pressed: boolean }) => unknown)({ pressed: false }));
    }
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
        storage.setState(initialStorageState, true);
        deviceState.safeAreaInsets = { top: 0, bottom: 0, left: 0, right: 0 };
    });
    afterEach(() => { standardCleanup(); storage.setState(initialStorageState, true); });

    it('keeps an in-progress recovery draft when resizing between phone and desktop', async () => {
        setLayoutFixture('mobile-workflow');
        const content = () => (
            <UnauthenticatedSplitShell
                stepId="restore"
                isWelcomeStep={false}
                onOpenRelayCustomFlow={() => {}}
                onBrandHeroGetStarted={() => {}}
            >
                <RecoveryDraft />
            </UnauthenticatedSplitShell>
        );
        const screen = await renderScreen(content());
        await act(async () => {
            screen.findByTestId('recovery-draft')!.props.onChangeText('in-progress pairing link');
        });
        await act(async () => { setLayoutFixture('split'); });
        await screen.update(content());
        expect(screen.findByTestId('recovery-draft')!.props.value).toBe('in-progress pairing link');
        await act(async () => { setLayoutFixture('mobile-workflow'); });
        await screen.update(content());
        expect(screen.findByTestId('recovery-draft')!.props.value).toBe('in-progress pairing link');
        await screen.unmount();
    });

    it('renders brand stage left and workflow right in split layout (R1 order)', async () => {
        setLayoutFixture('split');
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
        setLayoutFixture('split');
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
        setLayoutFixture('mobile-hero');
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
        setLayoutFixture('mobile-hero');
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
        setLayoutFixture('mobile-workflow');
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
        setLayoutFixture('mobile-workflow');
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
        setLayoutFixture('mobile-workflow');
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
        setLayoutFixture('split');
        const screenWelcome = await renderScreen(
            <UnauthenticatedSplitShell
                stepId="welcome"
                isWelcomeStep
                retentionDisclosure={{ kind: 'summary', summary: 'This relay cleans up subagent transcripts after 7 days.' }}
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

    it('puts the footer accessory at the end of the welcome help row and in the same bottom-right slot on later steps, never over the content', async () => {
        for (const layout of ['split', 'mobile-workflow'] as const) {
            setLayoutFixture(layout);
            const accessory = <Text testID="footer-accessory">updates</Text>;
            const welcome = await renderScreen(
                <UnauthenticatedSplitShell
                    stepId="welcome"
                    isWelcomeStep
                    footerAccessory={accessory}
                    onOpenRelayCustomFlow={() => {}}
                    onBrandHeroGetStarted={() => {}}
                >
                    <FakeBody label="welcome" />
                </UnauthenticatedSplitShell>,
            );
            const helpRow = welcome.findByTestId('welcome-footer-links');
            expect(helpRow?.findAll((node) => node.props?.testID === 'footer-accessory').length).toBeGreaterThan(0);
            expect(welcome.findAllByTestId('unauth-shell-footer-accessory')).toEqual([]);
            await welcome.unmount();

            const later = await renderScreen(
                <UnauthenticatedSplitShell
                    stepId="auth_restore"
                    isWelcomeStep={false}
                    footerAccessory={accessory}
                    onOpenRelayCustomFlow={() => {}}
                    onBrandHeroGetStarted={() => {}}
                    onBack={() => {}}
                >
                    <FakeBody label="restore" />
                </UnauthenticatedSplitShell>,
            );
            const slot = later.findByTestId('unauth-shell-footer-accessory');
            expect(slot?.findAll((node) => node.props?.testID === 'footer-accessory').length).toBeGreaterThan(0);
            // In the scroll column after the step, right-aligned: it takes its own row instead of floating over a title.
            const slotStyle = flattenStyle(slot?.props.style);
            expect(slotStyle.position).toBeUndefined();
            expect(slotStyle.justifyContent).toBe('flex-end');
            const column = later.findByTestId('unauth-shell-workflow-scroll');
            const order = column
                ?.findAll((node) => (
                    node.props?.testID === 'unauth-shell-step-transition'
                    || node.props?.testID === 'unauth-shell-footer-accessory'
                ))
                .map((node) => node.props.testID)
                .filter((testID, index, all) => all.indexOf(testID) === index);
            expect(order).toEqual(['unauth-shell-step-transition', 'unauth-shell-footer-accessory']);
            await later.unmount();
        }
    });

    it('renders no footer accessory slot when the host passes none', async () => {
        setLayoutFixture('split');
        const screen = await renderScreen(
            <UnauthenticatedSplitShell
                stepId="auth_restore"
                isWelcomeStep={false}
                onOpenRelayCustomFlow={() => {}}
                onBrandHeroGetStarted={() => {}}
            >
                <FakeBody label="restore" />
            </UnauthenticatedSplitShell>,
        );
        expect(screen.findAllByTestId('unauth-shell-footer-accessory')).toEqual([]);
    });

    it('renders BackChevron only when onBack is provided', async () => {
        setLayoutFixture('split');
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

    it('does not expose the focused Home as a welcome auth authority and keeps footer links at their design size', async () => {
        setLayoutFixture('split');
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

        expect(screen.findAllByTestId('welcome-footer-relay-action')).toEqual([]);
        expect(onOpenRelayCustomFlow).not.toHaveBeenCalled();
        for (const testID of [
            'welcome-footer-github-action',
            'welcome-footer-discord-action',
            'welcome-footer-docs-action',
        ]) {
            // A touch target is a hit area, not a drawn size: the links keep their design size.
            const style = flattenStyle(screen.findByTestId(testID)?.props.style);
            expect(style.minWidth).toBeUndefined();
            expect(style.minHeight).toBeUndefined();
        }
    });
});

describe('StagePane', () => {
    beforeEach(() => {
        deviceState.safeAreaInsets = { top: 0, bottom: 0, left: 0, right: 0 };
    });

    it('renders the brand panel', async () => {
        const screen = await renderScreen(<StagePane />);

        expect(screen.findByTestId('unauth-shell-stage-pane')).toBeTruthy();
        expect(screen.findByTestId('unauth-shell-brand-pane')).toBeTruthy();
    });
});
