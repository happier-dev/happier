import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

const { RoundButton, RoundButtonSizeScope } = await import('./RoundButton');

describe('RoundButton', () => {
    it('forwards the press event to modifier-aware actions', async () => {
        const onPress = vi.fn();
        const event = { nativeEvent: { metaKey: true } };
        const screen = await renderScreen(<RoundButton title="New session" testID="round-button" onPress={onPress} />);

        await act(async () => {
            screen.findByTestId('round-button')?.props.onPress(event);
        });

        expect(onPress).toHaveBeenCalledWith(event);
        expect(screen.findByTestId('round-button')?.props.accessibilityState).toMatchObject({ busy: false, disabled: false });
    });

    it('moves its visible pill with the shared tactile press, caller fill included, and settles on release', async () => {
        const flatten = (style: unknown): Record<string, unknown> => (Array.isArray(style)
            ? style.reduce((acc: Record<string, unknown>, next) => ({ ...acc, ...(flatten(next)) }), {})
            : ((style as Record<string, unknown> | null | undefined) ?? {}));
        // A fresh element per frame: the Reanimated test stub resolves animated
        // styles on render, and the memoized button skips identical props.
        const scene = () => <RoundButton title="Reject" testID="pressed-round-button" style={{ backgroundColor: 'caller-fill' }} onPress={() => {}} />;
        const screen = await renderScreen(scene());
        const pill = () => {
            const frames = screen.findByTestId('pressed-round-button')!.findAll((node) => String(node.type) === 'Animated.View');
            expect(frames).toHaveLength(1);
            return flatten(frames[0]!.props.style);
        };

        await act(async () => {
            screen.findByTestId('pressed-round-button')!.props.onPressIn();
        });
        await screen.update(scene());
        expect(pill()).toMatchObject({ backgroundColor: 'caller-fill', transform: [{ scale: 0.96 }] });

        await act(async () => {
            screen.findByTestId('pressed-round-button')!.props.onPressOut();
        });
        await screen.update(scene());
        expect(pill()).toMatchObject({ transform: [{ scale: 1 }] });
    });

    it('takes its touch target from the shared pressable: the platform floor on native, none on web', async () => {
        const { HappierUiPlatformProvider } = await import('@happier-dev/plugin-ui/environment');
        const { resolveMinimumInteractiveTargetSize } = await import('@/components/ui/interactiveTargetSize');
        const flatten = (style: unknown): Record<string, unknown> => (Array.isArray(style)
            ? style.reduce((acc: Record<string, unknown>, next) => ({ ...acc, ...(flatten(next)) }), {})
            : ((style as Record<string, unknown> | null | undefined) ?? {}));
        for (const platform of ['ios', 'android', 'web'] as const) {
            for (const size of ['large', 'normal', 'small'] as const) {
                for (const display of ['default', 'secondary'] as const) {
                    const testID = `target-${platform}-${size}-${display}`;
                    const screen = await renderScreen(
                        <HappierUiPlatformProvider platform={{ platform, colorScheme: 'light' }}>
                            <RoundButton title="Go" size={size} display={display} testID={testID} onPress={() => {}} />
                        </HappierUiPlatformProvider>,
                    );
                    const pressable = screen.findByTestId(testID)!;
                    const slop = typeof pressable.props.hitSlop === 'number' ? pressable.props.hitSlop : 0;
                    const style = flatten(pressable.props.style);
                    if (platform === 'web') {
                        // Pointer platforms keep their density: no minimum box is imposed.
                        expect(style.minHeight, `${testID} height`).toBeUndefined();
                        expect(style.minWidth, `${testID} width`).toBeUndefined();
                    } else {
                        const target = resolveMinimumInteractiveTargetSize(platform);
                        expect(Number(style.minHeight ?? 0) + slop * 2, `${testID} height`).toBeGreaterThanOrEqual(target);
                        expect(Number(style.minWidth ?? 0) + slop * 2, `${testID} width`).toBeGreaterThanOrEqual(target);
                        // One floor: the pressable's, not a second, smaller box of the button's own.
                        expect(style.minHeight, `${testID} single floor`).toBe(target);
                    }
                    await screen.unmount();
                }
            }
        }
    });

    it('announces a declared-disabled button as disabled and ignores its presses', async () => {
        const onPress = vi.fn();
        const screen = await renderScreen(<RoundButton title="Disabled" disabled={true} testID="disabled-round-button" onPress={onPress} />);

        await act(async () => {
            screen.findByTestId('disabled-round-button')?.props.onPress?.();
        });

        expect(onPress).not.toHaveBeenCalled();
        expect(screen.findByTestId('disabled-round-button')?.props.accessibilityState?.disabled).toBe(true);
    });

    it('announces a caller-declared loading button as busy', async () => {
        const screen = await renderScreen(<RoundButton title="Saving" loading={true} testID="loading-round-button" />);

        expect(screen.findByTestId('loading-round-button')?.props.accessibilityState?.busy).toBe(true);
    });

    it('stays busy while an async action runs, swallows repeat presses, then becomes pressable again', async () => {
        let resolveAction: () => void = () => {};
        const action = vi.fn(() => new Promise<void>((resolve) => { resolveAction = resolve; }));
        const screen = await renderScreen(<RoundButton title="Continue" testID="action-round-button" action={action} />);

        await act(async () => {
            screen.findByTestId('action-round-button')?.props.onPress?.();
            screen.findByTestId('action-round-button')?.props.onPress?.();
        });

        expect(action).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId('action-round-button')?.props.accessibilityState?.busy).toBe(true);

        await act(async () => {
            resolveAction();
        });

        expect(screen.findByTestId('action-round-button')?.props.accessibilityState?.busy).toBe(false);
    });

    it('exposes its accessible name, hint and disclosure state', async () => {
        const screen = await renderScreen(
            <RoundButton title="Details" accessibilityLabel="Show details" accessibilityHint="Reveals the diagnostic detail" expanded={false} testID="disclosure-round-button" />,
        );
        const pressable = screen.findByTestId('disclosure-round-button');

        expect(pressable?.props.accessibilityLabel).toBe('Show details');
        expect(pressable?.props.accessibilityHint).toBe('Reveals the diagnostic detail');
        expect(pressable?.props.accessibilityState?.expanded).toBe(false);
    });

    it('keeps labels single-line by default and allows a bounded multiline opt-in', async () => {
        const defaultScreen = await renderScreen(<RoundButton title="Default label" testID="default-round-button" />);
        const multilineScreen = await renderScreen(
            <RoundButton
                title="Mirror workspace and allow destination-only files to be removed"
                titleNumberOfLines={2}
                testID="multiline-round-button"
            />,
        );

        const defaultLabel = defaultScreen.tree.root.find((node) => node.props.children === 'Default label');
        const multilineLabel = multilineScreen.tree.root.find((node) => (
            node.props.children === 'Mirror workspace and allow destination-only files to be removed'
        ));

        expect(defaultLabel.props.numberOfLines).toBe(1);
        expect(multilineLabel.props.numberOfLines).toBe(2);
    });

    it('lets a consequence-bearing label wrap completely instead of truncating at a line cap', async () => {
        // Long enough that a two-line cap truncates it at the narrow widths and large
        // text sizes this action is confirmed at.
        const label = 'Mirror workspace and allow destination-only files to be permanently removed';
        const screen = await renderScreen(
            <RoundButton
                title={label}
                titleNumberOfLines="complete"
                accessibilityLabel={label}
                testID="complete-round-button"
            />,
        );

        const completeLabel = screen.tree.root.find((node) => node.props.children === label);
        expect(completeLabel.props.numberOfLines).toBeUndefined();
        // The full sentence stays the accessible name, not a shortened stand-in.
        expect(screen.findByTestId('complete-round-button')?.props.accessibilityLabel).toBe(label);
    });

    it('centres a wrapping label without disturbing the single-line default', async () => {
        const defaultScreen = await renderScreen(<RoundButton title="Short" testID="single" />);
        const wrappedScreen = await renderScreen(
            <RoundButton title="A much longer destructive confirmation" titleNumberOfLines="complete" testID="wrapped" />,
        );

        const flatten = (style: unknown): Record<string, unknown> => (Array.isArray(style)
            ? style.reduce((acc: Record<string, unknown>, next) => ({ ...acc, ...(flatten(next)) }), {})
            : ((style as Record<string, unknown> | null | undefined) ?? {}));

        const defaultLabel = defaultScreen.tree.root.find((node) => node.props.children === 'Short');
        const wrappedLabel = wrappedScreen.tree.root.find((node) => (
            node.props.children === 'A much longer destructive confirmation'
        ));

        expect(flatten(defaultLabel.props.style).textAlign).toBeUndefined();
        expect(flatten(wrappedLabel.props.style).textAlign).toBe('center');
    });

    it('uses a scoped default size while preserving the global large default', async () => {
        const screen = await renderScreen(<>
            <RoundButton title="Global" testID="global-button" />
            <RoundButtonSizeScope size="normal">
                <RoundButton title="Footer" testID="footer-button" />
                <RoundButton title="Explicit" size="small" testID="explicit-button" />
            </RoundButtonSizeScope>
        </>);
        const flatten = (style: unknown): Record<string, unknown> => Array.isArray(style)
            ? style.reduce((result, entry) => ({ ...result, ...flatten(entry) }), {})
            : ((style as Record<string, unknown> | null | undefined) ?? {});
        const fontSizeFor = (title: string) => flatten(
            screen.tree.root.find((node) => node.props?.children === title).props.style,
        ).fontSize;
        expect(fontSizeFor('Global')).toBe(21);
        expect(fontSizeFor('Footer')).toBe(16);
        expect(fontSizeFor('Explicit')).toBe(13);
    });
});
