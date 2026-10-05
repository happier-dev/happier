import * as React from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { StyleSheet } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Text } from '@/components/ui/text/Text';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { stageVisualTokens } from '../stage/stageVisualTokens';
import type { OnboardingWizardController } from '../../surfaces/useOnboardingWizardController';
import type { JourneyConfigControllerSurface } from './JourneyConfigSlot';

import { JourneyConfigSlot } from './JourneyConfigSlot';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

afterEach(() => {
    standardCleanup();
});

function flattenStyle(style: unknown): Record<string, unknown> {
    return StyleSheet.flatten(style) as Record<string, unknown>;
}

/** The action chrome is the animated frame inside the pressable hit area. */
function actionChromeStyle(node: { findAll: (predicate: (candidate: { type: unknown }) => boolean) => Array<{ props: { style?: unknown } }> }) {
    const frames = node.findAll((candidate) => candidate.type === 'Animated.View');
    expect(frames).toHaveLength(1);
    return flattenStyle(frames[0]!.props.style);
}

function actionGroup(node: ReactTestInstance) {
    let parent = node.parent;
    while (parent && String(parent.type) !== 'View') parent = parent.parent;
    return parent;
}

describe('JourneyConfigSlot', () => {
    it('fills the phone action rail without putting the primary inside the scrolling body', async () => {
        const onPrimary = vi.fn();
        const screen = await renderScreen(<JourneyConfigSlot
            primarySizing="fill"
            controller={{ body: <Text>Long configuration body</Text>, primaryLabel: 'Next', onPrimary,
                onSkip: vi.fn(), showSkip: true }} testID="phone-config"
        />);
        const primary = screen.findHostByTestId('phone-config-primary')!;
        const body = screen.findHostByTestId('phone-config-body')!;
        expect(body.findAll(node => node === primary)).toHaveLength(0);
        expect((flattenStyle(primary.props.style) ?? {}).flex).toBe(1);
        expect(actionChromeStyle(primary).width).toBe('100%');
        await screen.pressByTestIdAsync('phone-config-primary');
        expect(onPrimary).toHaveBeenCalledTimes(1);
    });

    it('renders and drives a pre-auth onboarding controller surface', async () => {
        const onPrimary = vi.fn();
        const onBack = vi.fn();
        const onSkip = vi.fn();
        const controller = {
            body: <Text>Relay selection body</Text>,
            onPrimary,
            primaryLabel: 'Continue',
            primaryDisabled: false,
            onBack,
            showBack: true,
            onSkip,
            showSkip: true,
            skipLabel: 'Skip setup',
            skipDisabled: false,
            footerHint: <Text>Footer hint</Text>,
        } satisfies Pick<
            OnboardingWizardController,
            | 'body'
            | 'onPrimary'
            | 'primaryLabel'
            | 'primaryDisabled'
            | 'onBack'
            | 'showBack'
            | 'onSkip'
            | 'showSkip'
            | 'skipLabel'
            | 'skipDisabled'
            | 'footerHint'
        >;

        const screen = await renderScreen(
            <JourneyConfigSlot controller={controller} testID="journey-config" />,
        );

        expect(screen.getTextContent()).toContain('Relay selection body');
        expect(screen.getTextContent()).toContain('Footer hint');

        screen.pressByTestId('journey-config-back');
        screen.pressByTestId('journey-config-primary');
        screen.pressByTestId('journey-config-skip');

        expect(onBack).toHaveBeenCalledTimes(1);
        expect(onPrimary).toHaveBeenCalledTimes(1);
        expect(onSkip).toHaveBeenCalledTimes(1);
    });

    it('uses the fixed action baseline visual treatment', async () => {
        const scene = () => (
            <JourneyConfigSlot
                controller={{
                    body: <Text>Configuration body</Text>,
                    onPrimary: vi.fn(),
                    primaryLabel: 'Continue',
                    onBack: vi.fn(),
                    showBack: true,
                    onSkip: vi.fn(),
                    skipLabel: 'Skip setup',
                    showSkip: true,
                }}
                testID="journey-config"
            />
        );
        const screen = await renderScreen(scene());

        const primary = screen.findByTestId('journey-config-primary');
        const back = screen.findByTestId('journey-config-back');
        expect(primary).not.toBeNull();
        expect(back).not.toBeNull();
        expect(screen.findByTestId('journey-config-skip-row')).not.toBeNull();

        expect(actionChromeStyle(primary!)).toMatchObject({
            height: stageVisualTokens.narration.primaryHeight,
            borderRadius: stageVisualTokens.narration.primaryRadius,
            paddingHorizontal: stageVisualTokens.narration.primaryPaddingHorizontal,
        });
        expect(actionChromeStyle(back!)).toMatchObject({
            backgroundColor: 'transparent',
            borderColor: 'transparent',
        });
        await act(async () => {
            primary!.props.onPressIn();
        });
        await screen.update(scene());
        expect(actionChromeStyle(screen.findByTestId('journey-config-primary')!)).toMatchObject({
            transform: [{ scale: motionTokens.press.scale }],
        });
        expect(flattenStyle(screen.findByTestId('journey-config-skip-row')?.props.style)).toMatchObject({
            alignItems: 'center',
            alignSelf: 'flex-end',
            width: stageVisualTokens.narration.trailingRailWidth,
        });
    });

    it('flows the body, footer, and inline skip inside a single scroll (no inner scroller, no floating skip row)', async () => {
        const onSkip = vi.fn();
        const screen = await renderScreen(
            <JourneyConfigSlot
                layout="flow"
                controller={{
                    body: <Text>Command card body</Text>,
                    onPrimary: vi.fn(),
                    primaryLabel: 'Continue',
                    onBack: vi.fn(),
                    showBack: true,
                    onSkip,
                    skipLabel: "I'll do this later",
                    showSkip: true,
                    footerHint: <Text>Active Relay pill</Text>,
                }}
                testID="journey-config"
            />,
        );

        // Body is a plain in-flow View (natural height), not an inner ScrollView
        // that would clip the command card / relay rows (F-W12-3).
        const body = screen.findByTestId('journey-config-body');
        expect(body).not.toBeNull();
        expect(body?.type).toBe('View');
        expect(flattenStyle(body?.props.style).flex).toBeUndefined();

        // Footer chrome (Active-Relay pill) is in-flow, never overlaid (F-W12-1).
        expect(screen.findByTestId('journey-config-footer')).not.toBeNull();
        expect(screen.getTextContent()).toContain('Active Relay pill');

        // Skip is an inline quiet secondary inside the action bar — no floating
        // trailing skip row (the ghost affordance owner is killed, F-W12-2).
        expect(screen.findByTestId('journey-config-skip-row')).toBeNull();
        expect(screen.findByTestId('journey-config-skip')).not.toBeNull();
        // Back is the secondary companion to Continue; Skip stays on the opposite side.
        const back = screen.findByTestId('journey-config-back')!;
        expect(actionGroup(back) === actionGroup(screen.findByTestId('journey-config-primary')!)).toBe(true);
        expect(actionGroup(back) === actionGroup(screen.findByTestId('journey-config-skip')!)).toBe(false);
        expect(actionChromeStyle(back).borderColor).not.toBe('transparent');
        screen.pressByTestId('journey-config-skip');
        expect(onSkip).toHaveBeenCalledTimes(1);
    });

    it('renders a setup controller surface with disabled primary and hidden skip', async () => {
        const onPrimary = vi.fn();
        const controller = {
            body: <Text>Machine setup body</Text>,
            onPrimary,
            primaryLabel: 'Continue',
            primaryDisabled: true,
            onBack: undefined,
            backLabel: 'Back',
            showBack: false,
            onSkip: undefined,
            skipLabel: 'Later',
            skipDisabled: undefined,
            showSkip: false,
            footerHint: 'Setup footer',
        } satisfies Pick<
            JourneyConfigControllerSurface,
            | 'body'
            | 'onPrimary'
            | 'primaryLabel'
            | 'primaryDisabled'
            | 'onBack'
            | 'backLabel'
            | 'showBack'
            | 'onSkip'
            | 'skipLabel'
            | 'skipDisabled'
            | 'showSkip'
            | 'footerHint'
        >;

        const screen = await renderScreen(
            <JourneyConfigSlot controller={controller} testID="journey-config" />,
        );

        expect(screen.getTextContent()).toContain('Machine setup body');
        expect(screen.getTextContent()).toContain('Setup footer');
        expect(screen.findByTestId('journey-config-back')).toBeNull();
        expect(screen.findByTestId('journey-config-skip')).toBeNull();
        expect(screen.findByTestId('journey-config-primary')?.props.accessibilityState).toMatchObject({
            disabled: true,
        });
        // Parent opacity must survive the press hook's idle opacity under reduced motion.
        expect(flattenStyle(screen.findByTestId('journey-config-primary')?.props.style)?.opacity).toBe(0.35);
    });
});
