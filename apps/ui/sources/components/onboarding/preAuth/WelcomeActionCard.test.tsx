import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { motionTokens } from '@/components/ui/motion/motionTokens';

// Load the real UI owner graph before the interaction deadline begins.
await import('./WelcomeActionCard');

describe('WelcomeActionCard', () => {
    it('exposes its decision and description accessibly and invokes it once', async () => {
        const onPress = vi.fn();
        const { WelcomeActionCard } = await import('./WelcomeActionCard');
        const screen = await renderScreen(
            <WelcomeActionCard
                testID="welcome-action"
                title="Continue"
                subtitle="Use this Home"
                onPress={onPress}
            />,
        );

        expect(screen.findByTestId('welcome-action')?.props).toMatchObject({
            accessibilityRole: 'button',
            accessibilityLabel: 'Continue',
            accessibilityHint: 'Use this Home',
        });
        await screen.pressByTestIdAsync('welcome-action');
        expect(onPress).toHaveBeenCalledOnce();
    });

    it('moves the whole card with the shared tactile press and settles on release', async () => {
        const { WelcomeActionCard } = await import('./WelcomeActionCard');
        const flatten = (style: unknown): Record<string, unknown> => (Array.isArray(style)
            ? style.reduce((acc: Record<string, unknown>, next) => ({ ...acc, ...(flatten(next)) }), {})
            : ((style as Record<string, unknown> | null | undefined) ?? {}));
        // A fresh element per frame: the Reanimated test stub resolves animated
        // styles on render, and the memoized card skips identical props.
        const scene = () => <WelcomeActionCard testID="welcome-action" title="Continue" onPress={() => {}} />;
        const screen = await renderScreen(scene());
        const card = () => {
            const frames = screen.findByTestId('welcome-action')!.findAll((node) => String(node.type) === 'Animated.View');
            expect(frames).toHaveLength(1);
            return flatten(frames[0]!.props.style);
        };

        await act(async () => {
            screen.findByTestId('welcome-action')!.props.onPressIn();
        });
        await screen.update(scene());
        expect(card()).toMatchObject({ borderRadius: 14, transform: [{ scale: motionTokens.press.scale }] });

        await act(async () => {
            screen.findByTestId('welcome-action')!.props.onPressOut();
        });
        await screen.update(scene());
        expect(card()).toMatchObject({ transform: [{ scale: 1 }] });
    });

    it('keeps an unavailable card explaining itself with its accessory as the only control', async () => {
        const onPress = vi.fn();
        const onRetry = vi.fn();
        const { WelcomeActionCard } = await import('./WelcomeActionCard');
        const screen = await renderScreen(
            <WelcomeActionCard
                testID="service"
                title="Continue with Acme"
                subtitle="Acme is unavailable right now."
                iconName="sign-in"
                unavailable={{ accessory: <WelcomeActionCard testID="service-retry" title="Retry" onPress={onRetry} escape /> }}
                onPress={onPress}
            />,
        );

        // Not a button: a disabled card nested around a live Retry would be one control announcing two.
        const cardNodes = screen.findAll((node) => node.props.testID === 'service');
        expect(cardNodes.length).toBeGreaterThan(0);
        expect(cardNodes.some((node) => node.props.accessibilityRole === 'button')).toBe(false);
        expect(screen.findByTestId('service-subtitle')?.props.children).toBe('Acme is unavailable right now.');
        await screen.pressByTestIdAsync('service-retry');
        expect(onRetry).toHaveBeenCalledOnce();
        expect(onPress).not.toHaveBeenCalled();
    });

    it("renders a provider's Home-projected connect colour behind its mark and ignores a value that is not a colour", async () => {
        // teams-lane-03/01 §10.2: a client renders the Home's projected
        // connect-button colour and never discards it for a dynamic provider.
        const { WelcomeActionCard } = await import('./WelcomeActionCard');
        const flatten = (style: unknown): Record<string, unknown> => (Array.isArray(style)
            ? style.reduce((acc: Record<string, unknown>, next) => ({ ...acc, ...(flatten(next)) }), {})
            : ((style as Record<string, unknown> | null | undefined) ?? {}));
        const screen = await renderScreen(
            <>
                <WelcomeActionCard testID="provider" title="Continue with Company login" iconName="sign-in"
                    accentColor="#0B5FFF" onPress={() => {}} />
                <WelcomeActionCard testID="malformed" title="Continue with Other" iconName="sign-in"
                    accentColor="url(javascript:alert(1))" onPress={() => {}} />
            </>,
        );

        expect(flatten(screen.findByTestId('provider-accent')?.props.style)).toMatchObject({ backgroundColor: '#0B5FFF' });
        expect(screen.findByTestId('malformed-accent')).toBeFalsy();
        expect(screen.findByTestId('malformed-icon')).toBeTruthy();
    });
});
