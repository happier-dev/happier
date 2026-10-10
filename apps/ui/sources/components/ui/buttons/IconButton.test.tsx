import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

const { IconButton } = await import('./IconButton');

/**
 * L0-1 — behavioral contract for the shared `IconButton` (the promoted
 * `ServiceActionButton` pattern). Covers: a11y label, onPress dispatch,
 * async-pending busy state, disabled blocking, disabled reason surfacing,
 * and tooltip content on hover/focus.
 */
describe('IconButton', () => {
    function flattenStyle(styleProp: unknown, state?: Partial<Record<string, boolean>>): Record<string, unknown> {
        const resolved = typeof styleProp === 'function'
            ? (styleProp as (s: Record<string, boolean>) => unknown)({
                pressed: false,
                hovered: false,
                focused: false,
                selected: false,
                highlighted: false,
                busy: false,
                disabled: false,
                ...state,
            })
            : styleProp;
        const entries = Array.isArray(resolved)
            ? (resolved as unknown[]).flat(Infinity)
            : [resolved];
        return Object.assign({}, ...entries.filter(Boolean) as object[]);
    }

    it('keeps the visible control at the requested size while the press frame carries the required target', async () => {
        const screen = await renderScreen(
            <IconButton
                testID="icon-btn"
                iconName="copy"
                accessibilityLabel="Copy address"
                size={28}
                minimumInteractiveTargetSize={44}
                interactiveTargetGapPx={16}
                onPress={() => {}}
            />,
        );

        const pressable = screen.findByTestId('icon-btn');
        const frame = flattenStyle(pressable?.props.style);
        // The press box is real box model because `hitSlop` is inert on react-native-web.
        // Only the declared horizontal row gap can be spent; another row can sit flush vertically.
        expect(frame.width).toBe(44);
        expect(frame.height).toBe(44);
        expect(frame.marginHorizontal).toBe(-8);
        expect(frame.marginVertical).toBe(0);
        // A declared target is never delegated to hit slop.
        expect(pressable?.props.hitSlop).toBe(0);

        const surface = flattenStyle(screen.findByTestId('icon-btn-surface')?.props.style);
        expect(surface.width).toBe(28);
        expect(surface.height).toBe(28);
    });

    it('honours the declared floor and allocates remaining width when the neighbour gap cannot cover it', async () => {
        const screen = await renderScreen(
            <IconButton
                testID="icon-btn"
                iconName="copy"
                accessibilityLabel="Copy address"
                size={28}
                minimumInteractiveTargetSize={44}
                interactiveTargetGapPx={4}
                onPress={() => {}}
            />,
        );

        const frame = flattenStyle(screen.findByTestId('icon-btn')?.props.style);
        expect(frame.width).toBe(44);
        expect(frame.marginHorizontal).toBe(-2);
        expect(frame.marginVertical).toBe(0);
        // Only the margin expansion is capped: layout allocates the rest, so targets never overlap.
        expect(frame.height).toBe(44);
        expect((frame.width as number) + 2 * (frame.marginHorizontal as number)).toBe(40);
        // The row gap says nothing about a stacked neighbor: the full vertical target stays in flow.
        expect((frame.height as number) + 2 * (frame.marginVertical as number)).toBe(44);
    });

    it('overhangs instead of taking layout when the caller declares its container cannot grow', async () => {
        const screen = await renderScreen(
            <IconButton
                testID="icon-btn"
                iconName="copy"
                accessibilityLabel="Close view"
                size={26}
                minimumInteractiveTargetSize={44}
                interactiveTargetGapPx={2}
                interactiveTargetLayout="overhang"
                onPress={() => {}}
            />,
        );

        const frame = flattenStyle(screen.findByTestId('icon-btn')?.props.style);
        // The full target height, none of it in flow; sideways only the row gap is spent.
        expect(frame.height).toBe(44);
        expect((frame.height as number) + 2 * (frame.marginVertical as number)).toBe(26);
        expect((frame.width as number) + 2 * (frame.marginHorizontal as number)).toBe(26);
        expect(frame.width).toBe(28);
        const surface = flattenStyle(screen.findByTestId('icon-btn-surface')?.props.style);
        expect(surface.width).toBe(26);
        expect(surface.height).toBe(26);
    });

    it('takes the free space it is given on each side, so a row of controls tiles its container with targets', async () => {
        const screen = await renderScreen(
            <IconButton
                testID="icon-btn"
                iconName="x"
                accessibilityLabel="Close view"
                size={26}
                minimumInteractiveTargetSize={44}
                interactiveTargetLayout="overhang"
                interactiveTargetEdgesPx={{ leading: 1, trailing: 3 }}
                onPress={() => {}}
            />,
        );
        const frame = flattenStyle(screen.findByTestId('icon-btn')?.props.style);
        // Half the neighbour gap before it, the container's padding after it; no layout taken.
        expect(frame.width).toBe(30);
        expect((frame.width as number) + (frame.marginLeft as number) + (frame.marginRight as number)).toBe(26);
        // Padded so the drawn square stays where layout put it.
        expect(frame.paddingLeft).toBe(1);
        expect(frame.paddingRight).toBe(3);
    });

    it('does not grow the press frame when no minimum target is declared', async () => {
        const screen = await renderScreen(
            <IconButton testID="icon-btn" iconName="copy" accessibilityLabel="Copy address" size={28} onPress={() => {}} />,
        );

        const frame = flattenStyle(screen.findByTestId('icon-btn')?.props.style);
        expect(frame.width).toBe(28);
        expect(frame.height).toBe(28);
        expect(frame.marginHorizontal).toBe(0);
        expect(frame.marginVertical).toBe(0);
    });

    it('keeps the outlined border on the visible surface and the interaction tint on the press frame', async () => {
        const screen = await renderScreen(
            <IconButton testID="icon-btn" iconName="copy" accessibilityLabel="Copy address" onPress={() => {}} />,
        );

        const surface = flattenStyle(screen.findByTestId('icon-btn-surface')?.props.style);
        expect(surface.borderWidth).toBe(1);

        const pressed = flattenStyle(screen.findByTestId('icon-btn')?.props.style, { pressed: true });
        const idle = flattenStyle(screen.findByTestId('icon-btn')?.props.style);
        expect(pressed.backgroundColor).toBeTruthy();
        expect(pressed.backgroundColor).not.toBe(idle.backgroundColor);
    });

    it('renders a plain control with no border and no background fill', async () => {
        const screen = await renderScreen(
            <IconButton testID="icon-btn" iconName="copy" accessibilityLabel="Copy address" variant="plain" onPress={() => {}} />,
        );

        const surface = flattenStyle(screen.findByTestId('icon-btn-surface')?.props.style);
        expect(surface.borderWidth).toBeUndefined();
        expect(surface.backgroundColor).toBeUndefined();
        expect(flattenStyle(screen.findByTestId('icon-btn')?.props.style).backgroundColor).toBeUndefined();
    });

    it('renders the required accessibility label and fires onPress', async () => {
        const onPress = vi.fn();
        const screen = await renderScreen(
            <IconButton testID="icon-btn" iconName="copy" accessibilityLabel="Copy address" onPress={onPress} />,
        );
        const pressable = screen.findByTestId('icon-btn');
        expect(pressable).toBeTruthy();
        expect(pressable?.props.accessibilityLabel).toBe('Copy address');
        expect(pressable?.props.accessibilityRole).toBe('button');
        screen.pressByTestId('icon-btn');
        expect(onPress).toHaveBeenCalledTimes(1);
    });

    it('hides the decorative icon from the accessibility tree', async () => {
        const screen = await renderScreen(
            <IconButton testID="icon-btn" iconName="copy" accessibilityLabel="Copy address" onPress={() => {}} />,
        );
        const icon = screen.findByTestId('icon-btn-icon');
        expect(icon?.props.accessibilityElementsHidden).toBe(true);
        expect(icon?.props.importantForAccessibility).toBe('no-hide-descendants');
    });

    it('exposes explicit toggle semantics for icon-only actions', async () => {
        const screen = await renderScreen(
            <IconButton
                testID="icon-btn"
                iconName="arrows-out"
                accessibilityLabel="Exit focus mode"
                selected
                accessibilityRole="checkbox"
                checked
                onPress={() => {}}
            />,
        );

        expect(screen.findByTestId('icon-btn')?.props.accessibilityState?.checked).toBe(true);
    });

    it('shows a pending spinner while an async onPress promise is unresolved, then restores the icon', async () => {
        let resolvePress: () => void = () => {};
        const pending = new Promise<void>((resolve) => { resolvePress = resolve; });
        const onPress = vi.fn(() => pending);
        const screen = await renderScreen(
            <IconButton
                testID="icon-btn"
                iconName="stop"
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
        let resolvePress: () => void = () => {};
        const pending = new Promise<void>((resolve) => { resolvePress = resolve; });
        const onPress = vi.fn(() => pending);
        const screen = await renderScreen(
            <IconButton
                testID="icon-btn"
                iconName="stop"
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
        const onPress = vi.fn();
        const screen = await renderScreen(
            <IconButton testID="icon-btn" iconName="play" accessibilityLabel="Start" disabled onPress={onPress} />,
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
        const screen = await renderScreen(
            <IconButton
                testID="icon-btn"
                iconName="globe"
                accessibilityLabel="Open preview"
                disabled
                disabledReason="Preview registration is unavailable."
                onPress={() => {}}
            />,
        );
        expect(screen.findByTestId('icon-btn')?.props.accessibilityHint).toBe('Preview registration is unavailable.');
    });

    it('shows tooltip content on hover and hides it on hover out', async () => {
        const screen = await renderScreen(
            <IconButton
                testID="icon-btn"
                iconName="camera"
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
        const screen = await renderScreen(
            <IconButton
                testID="icon-btn"
                iconName="globe"
                accessibilityLabel="Open preview"
                tooltip="Open in preview pane"
                disabled
                disabledReason="Preview registration is unavailable."
                onPress={() => {}}
            />,
        );
        const descriptionId = screen.findByTestId('icon-btn')?.props['aria-describedby'];
        expect(typeof descriptionId).toBe('string');
        expect(screen.findAll(node => typeof node.type === 'string' && node.props.nativeID === descriptionId
            && node.props.children === 'Preview registration is unavailable.')).not.toHaveLength(0);
        await act(async () => {
            screen.findByTestId('icon-btn')?.props.onHoverIn?.();
        });
        expect(screen.getTextContent()).toContain('Preview registration is unavailable.');
        expect(screen.getTextContent()).not.toContain('Open in preview pane');
    });

    it('shows tooltip content on focus for keyboard users and hides on blur', async () => {
        const screen = await renderScreen(
            <IconButton
                testID="icon-btn"
                iconName="camera"
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
