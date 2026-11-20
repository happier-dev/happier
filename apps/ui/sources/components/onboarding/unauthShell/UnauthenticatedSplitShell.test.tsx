import * as React from 'react';
import { Text, TextInput } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { AuthRouteStepFrame } from '@/components/onboarding/ui/AuthRouteStepFrame';

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
    deviceState.width = layout === 'desktop' ? 1000 : 390;
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

    it('keeps the signed-out recovery body mounted when credentials publish before the landing', async () => {
        setLayoutFixture('desktop');
        const content = (token?: string) => (
            <InjectedAuthProvider credentials={token ? { token } : null}>
                <AuthRouteStepFrame testID="restore-manual" title="Restore your Home">
                    <RecoveryDraft />
                </AuthRouteStepFrame>
            </InjectedAuthProvider>
        );
        const screen = await renderScreen(content());
        await act(async () => { screen.findByTestId('recovery-draft')!.props.onChangeText('in-progress recovery draft'); });
        await screen.update(content('authenticated'));

        expect(screen.findByTestId('unauth-shell-workflow-pane')).toBeTruthy();
        expect(screen.findByTestId('recovery-draft')!.props.value).toBe('in-progress recovery draft');
        await screen.unmount();
    });

    it('keeps an in-progress recovery draft when resizing between phone and desktop', async () => {
        setLayoutFixture('compact');
        const content = () => (
            <UnauthenticatedSplitShell
                stepId="restore"
                isWelcomeStep={false}
                onBrandHeroGetStarted={() => {}}
            >
                <RecoveryDraft />
            </UnauthenticatedSplitShell>
        );
        const screen = await renderScreen(content());
        await act(async () => {
            screen.findByTestId('recovery-draft')!.props.onChangeText('in-progress pairing link');
        });
        await act(async () => { setLayoutFixture('desktop'); });
        await screen.update(content());
        expect(screen.findByTestId('recovery-draft')!.props.value).toBe('in-progress pairing link');
        await act(async () => { setLayoutFixture('compact'); });
        await screen.update(content());
        expect(screen.findByTestId('recovery-draft')!.props.value).toBe('in-progress pairing link');
        await screen.unmount();
    });

    it('keeps the workflow pane shrinkable so nested setup and restore scroll views can scroll', async () => {
        setLayoutFixture('desktop');
        const screen = await renderScreen(
            <UnauthenticatedSplitShell
                stepId="relay_select"
                isWelcomeStep={false}
                onBrandHeroGetStarted={() => {}}
            >
                <FakeBody label="relay" />
            </UnauthenticatedSplitShell>,
        );

        const workflowPane = screen.findByTestId('unauth-shell-workflow-pane');
        expect(flattenStyle(workflowPane?.props.style).minHeight).toBe(0);
    });

    // Direction A: one column over the welcome atmosphere at every width, no split brand pane and no phone prelude.
    it.each(['desktop', 'compact'] as const)('draws the welcome atmosphere behind the one workflow column (%s)', async (layout) => {
        setLayoutFixture(layout);
        const screen = await renderScreen(
            <UnauthenticatedSplitShell stepId="welcome" isWelcomeStep>
                <FakeBody label="Welcome body" />
            </UnauthenticatedSplitShell>,
        );
        expect(screen.findAllHostsByTestId('welcome-atmosphere')).toHaveLength(1);
        expect(screen.findAllHostsByTestId('unauth-shell-workflow-pane')).toHaveLength(1);
        expect(screen.findAllHostsByTestId('welcome-mobile-wordmark')).toHaveLength(1);
    });
    it('keeps mobile workflow content inside native safe areas and stretches transitioned content', async () => {
        setLayoutFixture('compact');
        deviceState.safeAreaInsets = { top: 44, bottom: 34, left: 0, right: 0 };

        const screen = await renderScreen(
            <UnauthenticatedSplitShell
                stepId="auth_restore"
                isWelcomeStep={false}
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
        expect(flattenStyle(transitionHost?.props.style)).toMatchObject({ flex: 1, minHeight: 0 });
        expect(screen.findAllByTestId('fake-step-body')).toHaveLength(1);
    });

    it('lets scanner-style mobile workflow steps render full-bleed without shell padding', async () => {
        setLayoutFixture('compact');
        deviceState.safeAreaInsets = { top: 44, bottom: 34, left: 0, right: 0 };

        const screen = await renderScreen(
            <UnauthenticatedSplitShell
                stepId="auth_restore"
                isWelcomeStep={false}
                workflowPresentation="fullBleed"
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
        setLayoutFixture('desktop');
        const screenWelcome = await renderScreen(
            <UnauthenticatedSplitShell
                stepId="welcome"
                isWelcomeStep
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
                onBrandHeroGetStarted={() => {}}
            >
                <FakeBody label="restore" />
            </UnauthenticatedSplitShell>,
        );
        expect(screenOther.findAllByTestId('welcome-footer-links')).toEqual([]);
    });

    it('puts the footer accessory at the end of the welcome help row and in the same bottom-right slot on later steps, never over the content', async () => {
        for (const layout of ['desktop', 'compact'] as const) {
            setLayoutFixture(layout);
            const accessory = <Text testID="footer-accessory">updates</Text>;
            const welcome = await renderScreen(
                <UnauthenticatedSplitShell
                    stepId="welcome"
                    isWelcomeStep
                    footerAccessory={accessory}
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
        setLayoutFixture('desktop');
        const screen = await renderScreen(
            <UnauthenticatedSplitShell
                stepId="auth_restore"
                isWelcomeStep={false}
                onBrandHeroGetStarted={() => {}}
            >
                <FakeBody label="restore" />
            </UnauthenticatedSplitShell>,
        );
        expect(screen.findAllByTestId('unauth-shell-footer-accessory')).toEqual([]);
    });

    it('renders BackChevron only when onBack is provided', async () => {
        setLayoutFixture('desktop');
        const onBack = vi.fn();
        const screenWithBack = await renderScreen(
            <UnauthenticatedSplitShell
                stepId="auth_restore"
                isWelcomeStep={false}
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
                onBrandHeroGetStarted={() => {}}
            >
                <FakeBody label="welcome" />
            </UnauthenticatedSplitShell>,
        );
        expect(screenNoBack.findAllByTestId('unauth-shell-back-chevron')).toEqual([]);
    });

    it('does not expose the focused Home as a welcome auth authority and keeps footer links at their design size', async () => {
        setLayoutFixture('desktop');
        const screen = await renderScreen(
            <UnauthenticatedSplitShell
                stepId="welcome"
                isWelcomeStep
                onBrandHeroGetStarted={() => {}}
            >
                <FakeBody label="welcome" />
            </UnauthenticatedSplitShell>,
        );

        expect(screen.findAllByTestId('welcome-footer-relay-action')).toEqual([]);
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
