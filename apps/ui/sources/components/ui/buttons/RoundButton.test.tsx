import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { flattenTestStyle } from '@/dev/testkit';
import { HAPPIER_PAGE_METRICS, HappierMaterialRoleProvider, resolveHappierTypeScale } from '@happier-dev/plugin-ui/presentation';
import { Platform } from 'react-native';
import { lightTheme } from '@/theme';
import Color from 'color';
import { useGlassMaterialColorResolver } from '@/components/ui/glass/useGlassSurfaceColor';
import { resolveHappierMinimumInteractiveTargetSize } from '@happier-dev/plugin-ui/environment';

function FloatingButtonScene() {
    const resolveMaterialColor = useGlassMaterialColorResolver('floating');
    return <HappierMaterialRoleProvider role="floating" translucentColor="rgba(235, 230, 225, 0.1)" resolveMaterialColor={resolveMaterialColor}>
        <RoundButton title="Add widget" testID="glass-primary" />
        <RoundButton title="Unavailable" disabled testID="glass-disabled" />
    </HappierMaterialRoleProvider>;
}

const { RoundButton, RoundButtonSizeScope } = await import('./RoundButton');

describe('RoundButton', () => {
    it('keeps the primary and disabled primary solid inside floating material', async () => {
        const screen = await renderScreen(<FloatingButtonScene />);
        const fillOf = (id: string) => {
            const fill = flattenTestStyle(screen.findByTestId(id)!.findAll(node => String(node.type) === 'Animated.View')[0]!.props.style).backgroundColor;
            if (typeof fill !== 'string') throw new Error(`Expected a string background color for ${id}`);
            return fill;
        };
        expect(fillOf('glass-primary')).toBe(lightTheme.colors.button.primary.background);
        // The disabled primary keeps the primary's look, receded into the page, and stays one solid colour.
        const disabledFill = Color(fillOf('glass-disabled'));
        expect(disabledFill.alpha()).toBe(1);
        expect(disabledFill.luminosity()).toBeGreaterThan(Color(lightTheme.colors.button.primary.background).luminosity());
        expect(disabledFill.luminosity()).toBeLessThan(Color(lightTheme.colors.surface.base).luminosity());
    });
    it('stands a bare text button on the content edge: no pill padding before its words, like the quiet danger text (L2)', async () => {
        // "Show archived", "All members ›", "Change service" and "+ Add account" stood 10 pt past the text edge
        // (27–30 on a phone) because a pill with no fill still padded its words (PHONE-GEOMETRY-1110 L2).
        const screen = await renderScreen(<>
            <RoundButton title="Show archived" size="small" display="inverted" testID="link" onPress={() => {}} />
            <RoundButton title="Leave" size="small" display="quietDestructive" testID="quiet" onPress={() => {}} />
            <RoundButton title="Save" size="small" display="secondary" testID="pill" onPress={() => {}} />
        </>);
        const contentPadding = (id: string) => {
            const label = screen.findByTestId(id)!.findAll(node => String(node.type) === 'Text' && node.props.children === (id === 'link' ? 'Show archived' : id === 'quiet' ? 'Leave' : 'Save'))[0]!;
            // The content container: the label's nearest ancestor drawn with the pill's content radius.
            let node = label.parent;
            while (node && flattenTestStyle(node.props.style).borderRadius !== 9999) node = node.parent;
            return flattenTestStyle(node!.props.style).paddingHorizontal ?? 0;
        };
        expect(contentPadding('quiet')).toBe(0);
        expect(contentPadding('link')).toBe(0);
        // A pill keeps its padding.
        expect(contentPadding('pill')).toBeGreaterThan(0);
    });

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
        expect(pill()).toMatchObject({ backgroundColor: 'caller-fill', transform: [{ scale: motionTokens.press.scale }] });

        await act(async () => {
            screen.findByTestId('pressed-round-button')!.props.onPressOut();
        });
        await screen.update(scene());
        expect(pill()).toMatchObject({ transform: [{ scale: 1 }] });
    });

    it('sits flat while pressed, like every other raised control, and stands again on release', async () => {
        const flatten = (style: unknown): Record<string, unknown> => (Array.isArray(style)
            ? style.reduce((acc: Record<string, unknown>, next) => ({ ...acc, ...(flatten(next)) }), {})
            : ((style as Record<string, unknown> | null | undefined) ?? {}));
        const scene = () => <RoundButton title="Retry" display="secondary" testID="edge-round-button" onPress={() => {}} />;
        const screen = await renderScreen(scene());
        const pill = () => flatten(screen.findByTestId('edge-round-button')!.findAll((node) => String(node.type) === 'Animated.View')[0]!.props.style);
        const raisedSide = (style: Record<string, unknown>) => style.borderTopColor ?? style.borderBottomColor;

        expect(raisedSide(pill())).toBeDefined();

        await act(async () => {
            screen.findByTestId('edge-round-button')!.props.onPressIn();
        });
        await screen.update(scene());
        expect(raisedSide(pill())).toBeUndefined();

        await act(async () => {
            screen.findByTestId('edge-round-button')!.props.onPressOut();
        });
        await screen.update(scene());
        expect(raisedSide(pill())).toBeDefined();
    });

    it('draws normal and small at the page control heights the plugin-ui button draws, on every platform', async () => {
        const { HappierUiPlatformProvider } = await import('@happier-dev/plugin-ui/environment');
        const expected = { normal: HAPPIER_PAGE_METRICS.controlHeightPx, small: HAPPIER_PAGE_METRICS.smallControlHeightPx, large: undefined } as const;
        for (const platform of ['ios', 'android', 'web'] as const) {
            for (const size of ['large', 'normal', 'small'] as const) {
                const testID = `drawn-${platform}-${size}`;
                const screen = await renderScreen(
                    <HappierUiPlatformProvider platform={{ platform, colorScheme: 'light' }}>
                        <RoundButton title="Go" size={size} testID={testID} onPress={() => {}} />
                    </HappierUiPlatformProvider>,
                );
                const pill = screen.findByTestId(testID)!.findAll(node => String(node.type) === 'Animated.View')[0]!;
                expect(flattenTestStyle(pill.props.style).minHeight, `${testID} drawn height`).toBe(expected[size]);
                await screen.unmount();
            }
        }
    });

    it('takes its touch target from the shared pressable as hit area: drawn at its own size on every platform', async () => {
        const { HappierUiPlatformProvider } = await import('@happier-dev/plugin-ui/environment');
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
                    const style = flatten(screen.findByTestId(testID)!.props.style);
                    // No touch floor is drawn: the button keeps its design geometry.
                    expect(style.minHeight, `${testID} height`).toBeUndefined();
                    expect(style.minWidth, `${testID} width`).toBeUndefined();
                    if (platform !== 'web') {
                        const drawnHeight = size === 'small' ? HAPPIER_PAGE_METRICS.smallControlHeightPx : HAPPIER_PAGE_METRICS.controlHeightPx;
                        // Under a finger the hit area reaches the platform target past the drawn pill.
                        const host = screen.findHostByTestId(testID)!;
                        await act(async () => {
                            host.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 120, height: drawnHeight } } });
                        });
                        const slop = screen.findHostByTestId(testID)!.props.hitSlop as Record<string, number>;
                        expect(drawnHeight + slop.top + slop.bottom, `${testID} hit height`).toBe(resolveHappierMinimumInteractiveTargetSize(platform));
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

    it('keeps its label readable while busy, trading only the leading mark for the spinner', async () => {
        const mark = React.createElement('Mark', { testID: 'refresh-mark' });
        const idle = await renderScreen(<RoundButton title="Refresh now" leading={mark} testID="idle-button" />);
        const busy = await renderScreen(<RoundButton title="Refresh now" leading={mark} loading={true} testID="busy-button" />);
        const labelOpacity = (screen: Awaited<ReturnType<typeof renderScreen>>) => {
            const label = screen.tree.root.find((node) => node.props.children === 'Refresh now');
            return flattenTestStyle(label.props.style).opacity;
        };

        expect(labelOpacity(idle)).toBe(1);
        expect(labelOpacity(busy)).toBe(1);
        expect(idle.findByTestId('refresh-mark')).toBeTruthy();
        expect(busy.findByTestId('refresh-mark')).toBeNull();
        expect(busy.findByTestId('busy-button')?.props.accessibilityState?.busy).toBe(true);
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
        const metricsFor = (title: string) => {
            const style = flatten(screen.tree.root.find((node) => node.props?.children === title).props.style);
            return { fontSize: style.fontSize, lineHeight: style.lineHeight };
        };
        // Each tier is a role of the one type scale: large reads heading, normal label, small body.
        const role = (name: 'heading' | 'label' | 'body') => {
            const { fontSize, lineHeight } = resolveHappierTypeScale(name, Platform.OS);
            return { fontSize, lineHeight };
        };
        expect(metricsFor('Global')).toEqual(role('heading'));
        expect(metricsFor('Footer')).toEqual(role('label'));
        expect(metricsFor('Explicit')).toEqual(role('body'));
    });
});
