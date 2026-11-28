import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { KeyboardShortcutLabelsContext } from '@/keyboard/shortcutLabels';
import { Tooltip } from '../overlays/Tooltip';

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

    function hitSlopAfterLayout(screen: Awaited<ReturnType<typeof renderScreen>>, testID: string, size: number) {
        const host = screen.findHostByTestId(testID);
        expect(host?.props.onLayout, 'a control with a hit area measures its drawn square').toBeTypeOf('function');
        act(() => {
            host!.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: size, height: size } } });
        });
        return screen.findHostByTestId(testID)?.props.hitSlop as Record<string, number> | undefined;
    }

    it('keeps the layout box at the drawn square while the hit area reaches the declared target', async () => {
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

        const frame = flattenStyle(screen.findByTestId('icon-btn')?.props.style);
        // The touch target is a hit area: the box in layout is the drawn square, never the target.
        expect(frame.width).toBe(28);
        expect(frame.height).toBe(28);
        expect(frame.marginHorizontal ?? 0).toBe(0);
        expect(frame.marginVertical ?? 0).toBe(0);
        expect(hitSlopAfterLayout(screen, 'icon-btn', 28)).toEqual({ top: 8, bottom: 8, left: 8, right: 8 });

        const surface = flattenStyle(screen.findByTestId('icon-btn-surface')?.props.style);
        expect(surface.width).toBe(28);
        expect(surface.height).toBe(28);
    });

    it('keeps the WCAG pointer floor by hit area for a drawn square below it', async () => {
        const small = await renderScreen(
            <IconButton testID="icon-btn" iconName="copy" accessibilityLabel="Copy address" size={20} interactiveTargetGapPx={4} onPress={() => {}} />,
        );
        expect(flattenStyle(small.findByTestId('icon-btn')?.props.style).width).toBe(20);
        expect(hitSlopAfterLayout(small, 'icon-btn', 20)).toEqual({ top: 2, bottom: 2, left: 2, right: 2 });

    });

    it('splits a tight row gap with its neighbour instead of overlapping it', async () => {
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

        expect(flattenStyle(screen.findByTestId('icon-btn')?.props.style).width).toBe(28);
        // Sideways only half the gap; above and below the whole target.
        expect(hitSlopAfterLayout(screen, 'icon-btn', 28)).toEqual({ top: 8, bottom: 8, left: 2, right: 2 });
    });

    it('takes the free space it is given on each side, so a row of controls tiles its container with targets', async () => {
        const screen = await renderScreen(
            <IconButton
                testID="icon-btn"
                iconName="x"
                accessibilityLabel="Close view"
                size={26}
                minimumInteractiveTargetSize={44}
                interactiveTargetEdgesPx={{ leading: 1, trailing: 3 }}
                onPress={() => {}}
            />,
        );
        expect(flattenStyle(screen.findByTestId('icon-btn')?.props.style).width).toBe(26);
        expect(hitSlopAfterLayout(screen, 'icon-btn', 26)).toEqual({ top: 9, bottom: 9, left: 1, right: 3 });
    });

    it('bounds only the sides it is given: a header control keeps its top or bottom to the room it has and takes the rest', async () => {
        const screen = await renderScreen(
            <IconButton
                testID="icon-btn"
                iconName="plus"
                accessibilityLabel="Add"
                size={28}
                minimumInteractiveTargetSize={44}
                interactiveTargetEdgesPx={{ top: 0, bottom: 2 }}
                onPress={() => {}}
            />,
        );
        // The bounded sides keep only the room they declared; the sides left open reach their half.
        expect(hitSlopAfterLayout(screen, 'icon-btn', 28)).toEqual({ top: 0, bottom: 2, left: 8, right: 8 });
    });

    it('paints hover, press and selection on the drawn square, never on the hit area', async () => {
        const screen = await renderScreen(
            <IconButton
                testID="icon-btn"
                iconName="copy"
                accessibilityLabel="Copy address"
                variant="plain"
                size={24}
                minimumInteractiveTargetSize={44}
                interactiveTargetGapPx={44}
                onPress={() => {}}
            />,
        );

        for (const state of [{ hovered: true }, { pressed: true }, { selected: true }]) {
            const frame = flattenStyle(screen.findByTestId('icon-btn')?.props.style, state);
            // The pressable box is the drawn square; its tint belongs to the surface inside it.
            expect(frame.width).toBe(24);
            expect(frame.backgroundColor).toBeUndefined();
        }
        await act(async () => {
            screen.findByTestId('icon-btn')?.props.onHoverIn?.({ nativeEvent: { pointerType: 'mouse' } });
        });
        const hoveredSurface = flattenStyle(screen.findByTestId('icon-btn-surface')?.props.style);
        expect(hoveredSurface.width).toBe(24);
        expect(hoveredSurface.backgroundColor).toBeTruthy();
    });

    it('shows a toggle that is on through its selection, keeping its chrome glyph in the resting ink until engaged', async () => {
        const { ChromeGlyph } = await import('@/components/ui/icons/chromeGlyphInk');
        const screen = await renderScreen(
            <IconButton testID="toggle" accessibilityLabel="Split" variant="plain" size={28} selected
                icon={<ChromeGlyph name="square-split-horizontal" size={20} />} onPress={() => {}} />,
        );
        const glyphInk = () => screen.findAll(node => node.props.name === 'square-split-horizontal' && typeof node.props.color === 'string')[0]!.props;
        const resting = glyphInk();
        // On: the selected square says so; the glyph stays as quiet as every other chrome glyph at rest.
        expect(resting.style).toEqual(expect.objectContaining({ opacity: expect.any(Number) }));
        expect(flattenStyle(screen.findByTestId('toggle-surface')?.props.style).backgroundColor).toBeTruthy();
        await act(async () => {
            screen.findByTestId('toggle')?.props.onHoverIn?.({ nativeEvent: { pointerType: 'mouse' } });
        });
        // Hovered, it comes up to the full ink.
        expect(glyphInk().color).not.toBe(resting.color);
    });

    it('keeps the outlined border and its resting fill on the visible surface', async () => {
        const screen = await renderScreen(
            <IconButton testID="icon-btn" iconName="copy" accessibilityLabel="Copy address" onPress={() => {}} />,
        );

        const surface = flattenStyle(screen.findByTestId('icon-btn-surface')?.props.style);
        expect(surface.borderWidth).toBe(1);
        expect(surface.backgroundColor).toBeTruthy();
        expect(flattenStyle(screen.findByTestId('icon-btn')?.props.style).backgroundColor).toBeUndefined();
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

    it('keeps a disabled control that explains itself reachable: focusable, and a press shows the reason instead of acting', async () => {
        const onPress = vi.fn();
        const screen = await renderScreen(
            <IconButton
                testID="icon-btn"
                iconName="caret-left"
                accessibilityLabel="Back"
                disabled
                disabledReason="This site doesn't let Happier control its history."
                onPress={onPress}
            />,
        );
        const pressable = screen.findByTestId('icon-btn');
        expect(pressable?.props.accessibilityState?.disabled).toBe(true);
        expect(pressable?.props['aria-disabled']).toBe(true);
        expect(pressable?.props.tabIndex).not.toBe(-1);
        expect(screen.findByTestId('icon-btn-tooltip')).toBeNull();

        await act(async () => {
            screen.findByTestId('icon-btn')?.props.onPress?.();
        });

        expect(onPress).not.toHaveBeenCalled();
        expect(screen.findByTestId('icon-btn-tooltip')).toBeTruthy();
        expect(screen.getTextContent()).toContain("This site doesn't let Happier control its history.");
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

    it('resolves both tooltip controls from the current binding and preserves unbound and disabled copy', async () => {
        const content = (
            <>
                <IconButton testID="bound-action" iconName="copy" accessibilityLabel="Search" tooltip="Search"
                    shortcutCommandId="commandPalette.open" onPress={() => {}} />
                <IconButton testID="disabled-action" iconName="copy" accessibilityLabel="Search" tooltip="Search"
                    shortcutCommandId="commandPalette.open" disabled disabledReason="Unavailable" onPress={() => {}} />
                <Tooltip testID="bound-help" label="Search" shortcutCommandId="commandPalette.open"><React.Fragment /></Tooltip>
                <Tooltip testID="unbound-help" label="Help" shortcutCommandId="mode.cycle"><React.Fragment /></Tooltip>
            </>
        );
        const screen = await renderScreen(
            <KeyboardShortcutLabelsContext.Provider value={{ 'commandPalette.open': 'Ctrl+J' }}>
                {content}
            </KeyboardShortcutLabelsContext.Provider>,
        );
        expect(screen.findByTestId('bound-help')?.props.accessibilityLabel).toBe('Search (Ctrl+J)');
        expect(screen.findByTestId('unbound-help')?.props.accessibilityLabel).toBe('Help');
        await act(async () => { screen.findByTestId('bound-action')?.props.onHoverIn?.(); });
        expect(screen.getTextContent()).toContain('Search (Ctrl+J)');
        await act(async () => { screen.findByTestId('disabled-action')?.props.onHoverIn?.(); });
        expect(screen.getTextContent()).toContain('Unavailable');
        expect(screen.getTextContent()).not.toContain('Unavailable (Ctrl+J)');
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
