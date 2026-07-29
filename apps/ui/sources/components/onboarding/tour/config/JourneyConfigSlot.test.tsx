import * as React from 'react';
import { StyleSheet } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Text } from '@/components/ui/text/Text';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { stageVisualTokens } from '../stage/stageVisualTokens';
import type { OnboardingWizardController } from '../../surfaces/useOnboardingWizardController';
import type { SetupWizardController } from '../../surfaces/useSetupWizardController';

import { JourneyConfigSlot } from './JourneyConfigSlot';

afterEach(() => {
    standardCleanup();
});

function flattenStyle(style: unknown): Record<string, unknown> {
    return StyleSheet.flatten(style) as Record<string, unknown>;
}

function resolvePressableStyle(node: { props: { style?: unknown } }, state: Record<string, boolean>) {
    return typeof node.props.style === 'function' ? node.props.style(state) : node.props.style;
}

describe('JourneyConfigSlot', () => {
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
        const screen = await renderScreen(
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
            />,
        );

        const primary = screen.findByTestId('journey-config-primary');
        const back = screen.findByTestId('journey-config-back');
        expect(primary).not.toBeNull();
        expect(back).not.toBeNull();
        expect(screen.findByTestId('journey-config-skip-row')).not.toBeNull();

        expect(flattenStyle(resolvePressableStyle(primary!, { pressed: false, hovered: false, focused: false }))).toMatchObject({
            height: stageVisualTokens.narration.primaryHeight,
            borderRadius: stageVisualTokens.narration.primaryRadius,
            paddingHorizontal: stageVisualTokens.narration.primaryPaddingHorizontal,
        });
        expect(flattenStyle(resolvePressableStyle(primary!, { pressed: true, hovered: false, focused: false }))).toMatchObject({
            transform: [{ scale: stageVisualTokens.motion.pressScale }],
        });
        expect(flattenStyle(resolvePressableStyle(back!, { pressed: false, hovered: false, focused: false }))).toMatchObject({
            backgroundColor: 'transparent',
            borderColor: 'transparent',
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
            SetupWizardController,
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
    });
});
