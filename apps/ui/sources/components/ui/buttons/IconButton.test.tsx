import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

/**
 * L0-1 — behavioral contract for the shared `IconButton` (the promoted
 * `ServiceActionButton` pattern). Covers: a11y label, onPress dispatch,
 * async-pending busy state, disabled blocking, disabled reason surfacing,
 * and tooltip content on hover/focus.
 */
describe('IconButton', () => {
    it('renders the required accessibility label and fires onPress', async () => {
        const { IconButton } = await import('./IconButton');
        const onPress = vi.fn();
        const screen = await renderScreen(
            <IconButton testID="icon-btn" iconName="copy-outline" accessibilityLabel="Copy address" onPress={onPress} />,
        );
        const pressable = screen.findByTestId('icon-btn');
        expect(pressable).toBeTruthy();
        expect(pressable?.props.accessibilityLabel).toBe('Copy address');
        expect(pressable?.props.accessibilityRole).toBe('button');
        screen.pressByTestId('icon-btn');
        expect(onPress).toHaveBeenCalledTimes(1);
    });

    it('hides the decorative icon from the accessibility tree', async () => {
        const { IconButton } = await import('./IconButton');
        const screen = await renderScreen(
            <IconButton testID="icon-btn" iconName="copy-outline" accessibilityLabel="Copy address" onPress={() => {}} />,
        );
        const icon = screen.findByTestId('icon-btn-icon');
        expect(icon?.props.accessibilityElementsHidden).toBe(true);
        expect(icon?.props.importantForAccessibility).toBe('no-hide-descendants');
    });

    it('shows a pending spinner while an async onPress promise is unresolved, then restores the icon', async () => {
        const { IconButton } = await import('./IconButton');
        let resolvePress: () => void = () => {};
        const pending = new Promise<void>((resolve) => { resolvePress = resolve; });
        const onPress = vi.fn(() => pending);
        const screen = await renderScreen(
            <IconButton
                testID="icon-btn"
                iconName="stop-outline"
                accessibilityLabel="Stop service"
                animationEnabled={false}
                onPress={onPress}
            />,
        );

        expect(screen.findByTestId('icon-btn-spinner')).toBeNull();
        await act(async () => {
            screen.pressByTestId('icon-btn');
        });
        expect(screen.findByTestId('icon-btn-spinner')).toBeTruthy();
        expect(screen.findByTestId('icon-btn')?.props.accessibilityState?.busy).toBe(true);

        // While busy, further presses are swallowed.
        await act(async () => {
            screen.findByTestId('icon-btn')?.props.onPress?.();
        });
        expect(onPress).toHaveBeenCalledTimes(1);

        await act(async () => {
            resolvePress();
            await pending;
        });
        expect(screen.findByTestId('icon-btn-spinner')).toBeNull();
        expect(screen.findByTestId('icon-btn')?.props.accessibilityState?.busy).toBe(false);
    });

    it('blocks same-tick double presses before React commits the busy state', async () => {
        const { IconButton } = await import('./IconButton');
        let resolvePress: () => void = () => {};
        const pending = new Promise<void>((resolve) => { resolvePress = resolve; });
        const onPress = vi.fn(() => pending);
        const screen = await renderScreen(
            <IconButton
                testID="icon-btn"
                iconName="stop-outline"
                accessibilityLabel="Stop service"
                animationEnabled={false}
                onPress={onPress}
            />,
        );

        const handler = screen.findByTestId('icon-btn')?.props.onPress;
        await act(async () => {
            handler?.();
            handler?.();
        });
        expect(onPress).toHaveBeenCalledTimes(1);

        await act(async () => {
            resolvePress();
            await pending;
        });
    });

    it('disabled blocks onPress and exposes the disabled accessibility state', async () => {
        const { IconButton } = await import('./IconButton');
        const onPress = vi.fn();
        const screen = await renderScreen(
            <IconButton testID="icon-btn" iconName="play-outline" accessibilityLabel="Start" disabled onPress={onPress} />,
        );
        const pressable = screen.findByTestId('icon-btn');
        expect(pressable?.props.accessibilityState?.disabled).toBe(true);
        expect(pressable?.props.disabled).toBe(true);
        // Even if the handler is invoked directly (as RN does not gate onPress in
        // the test renderer), the component must swallow it while disabled.
        await act(async () => {
            pressable?.props.onPress?.();
        });
        expect(onPress).not.toHaveBeenCalled();
    });

    it('surfaces the disabled reason as the accessibility hint', async () => {
        const { IconButton } = await import('./IconButton');
        const screen = await renderScreen(
            <IconButton
                testID="icon-btn"
                iconName="globe-outline"
                accessibilityLabel="Open preview"
                disabled
                disabledReason="Preview registration is unavailable."
                onPress={() => {}}
            />,
        );
        expect(screen.findByTestId('icon-btn')?.props.accessibilityHint).toBe('Preview registration is unavailable.');
    });

    it('shows tooltip content on hover and hides it on hover out', async () => {
        const { IconButton } = await import('./IconButton');
        const screen = await renderScreen(
            <IconButton
                testID="icon-btn"
                iconName="camera-outline"
                accessibilityLabel="Snapshot"
                tooltip="Take a snapshot"
                onPress={() => {}}
            />,
        );
        expect(screen.findByTestId('icon-btn-tooltip')).toBeNull();
        await act(async () => {
            screen.findByTestId('icon-btn')?.props.onHoverIn?.();
        });
        const tooltip = screen.findByTestId('icon-btn-tooltip');
        expect(tooltip).toBeTruthy();
        expect(screen.getTextContent()).toContain('Take a snapshot');
        await act(async () => {
            screen.findByTestId('icon-btn')?.props.onHoverOut?.();
        });
        expect(screen.findByTestId('icon-btn-tooltip')).toBeNull();
    });

    it('prefers the disabled reason over the tooltip while disabled', async () => {
        const { IconButton } = await import('./IconButton');
        const screen = await renderScreen(
            <IconButton
                testID="icon-btn"
                iconName="globe-outline"
                accessibilityLabel="Open preview"
                tooltip="Open in preview pane"
                disabled
                disabledReason="Preview registration is unavailable."
                onPress={() => {}}
            />,
        );
        await act(async () => {
            screen.findByTestId('icon-btn')?.props.onHoverIn?.();
        });
        expect(screen.getTextContent()).toContain('Preview registration is unavailable.');
        expect(screen.getTextContent()).not.toContain('Open in preview pane');
    });

    it('shows tooltip content on focus for keyboard users and hides on blur', async () => {
        const { IconButton } = await import('./IconButton');
        const screen = await renderScreen(
            <IconButton
                testID="icon-btn"
                iconName="camera-outline"
                accessibilityLabel="Snapshot"
                tooltip="Take a snapshot"
                onPress={() => {}}
            />,
        );
        await act(async () => {
            screen.findByTestId('icon-btn')?.props.onFocus?.();
        });
        expect(screen.findByTestId('icon-btn-tooltip')).toBeTruthy();
        await act(async () => {
            screen.findByTestId('icon-btn')?.props.onBlur?.();
        });
        expect(screen.findByTestId('icon-btn-tooltip')).toBeNull();
    });
});
