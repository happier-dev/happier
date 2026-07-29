import React from 'react';
import { View } from 'react-native';
import { act } from 'react-test-renderer';
import type { ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { lightTheme } from '@/theme';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

const reducedMotionRef = vi.hoisted(() => ({ value: false }));
vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => reducedMotionRef.value,
}));

const animationControls = vi.hoisted(() => ({
    timingCalls: [] as Array<{ to: unknown }>,
    // When true (the default for the existing suite) `withTiming` settles
    // synchronously by firing its completion callback immediately. Native runs
    // the animation over ~220ms, so the reconciliation tests set this false to
    // hold the animation MID-FLIGHT (the window where a stale target must be
    // corrected to the freshest measured height).
    autoFinish: true,
    pending: [] as Array<(finished?: boolean) => void>,
    finishPending() {
        const callbacks = this.pending.splice(0, this.pending.length);
        for (const callback of callbacks) callback(true);
    },
}));

vi.mock('react-native-reanimated', async () => {
    const ReactModule = await import('react');
    type SharedValue<T> = { value: T };
    const useSharedValue = <T,>(initial: T): SharedValue<T> => {
        const ref = ReactModule.useRef<SharedValue<T> | null>(null);
        if (!ref.current) ref.current = { value: initial };
        return ref.current;
    };
    const useAnimatedStyle = <T,>(factory: () => T): T => factory();
    const runOnJS = <TArgs extends unknown[], TResult>(fn: (...args: TArgs) => TResult) => fn;
    const cancelAnimation = () => {};
    const withTiming = <T,>(value: T, _config?: unknown, callback?: (finished?: boolean) => void) => {
        animationControls.timingCalls.push({ to: value });
        if (callback) {
            if (animationControls.autoFinish) callback(true);
            else animationControls.pending.push(callback);
        }
        return value;
    };
    const Animated = {
        View: 'Animated.View',
        ScrollView: 'Animated.ScrollView',
        Text: 'Animated.Text',
        createAnimatedComponent: (component: unknown) => component,
    };
    return {
        __esModule: true,
        default: Animated,
        ...Animated,
        cancelAnimation,
        runOnJS,
        useAnimatedStyle,
        useSharedValue,
        withTiming,
    };
});

beforeEach(() => {
    animationControls.timingCalls = [];
    animationControls.autoFinish = true;
    animationControls.pending = [];
    reducedMotionRef.value = false;
});

/**
 * Fires the body's `onLayout` with a natural content height, modelling the
 * async body content (a quota skeleton settling into real meters/reset rows)
 * reporting a new height AFTER the reveal animation already armed.
 */
function fireBodyLayout(
    body: ReactTestInstance | null,
    height: number,
): void {
    const layoutNode = body?.findAll(
        (node) => typeof node.props?.onLayout === 'function',
    )[0];
    if (!layoutNode) throw new Error('body onLayout node not found');
    act(() => {
        layoutNode.props.onLayout({ nativeEvent: { layout: { height } } });
    });
}

/** Height targets from the height (not opacity) `withTiming` commands. */
function heightTargets(): number[] {
    return animationControls.timingCalls
        .map((call) => call.to)
        .filter((to): to is number => typeof to === 'number' && to !== 1);
}

/**
 * Lightweight header that records the `showDivider` ExpandableItem clones onto
 * it (the caller's header Item normally consumes this to draw its row divider).
 */
function HeaderProbe(props: { testID?: string; showDivider?: boolean; expanded?: boolean }) {
    return <View testID={props.testID} />;
}

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>(
            (accumulator, entry) => Object.assign(accumulator, flattenStyle(entry)),
            {},
        );
    }
    if (style && typeof style === 'object') {
        return style as Record<string, unknown>;
    }
    return {};
}

describe('ExpandableItem', () => {
    it('renders only the header when collapsed and reveals the body when expanded', async () => {
        const { ExpandableItem } = await import('./ExpandableItem');

        const collapsed = await renderScreen(
            <ExpandableItem
                testID="acct"
                expanded={false}
                onExpandedChange={() => {}}
                header={(s) => <HeaderProbe testID="hdr" expanded={s.expanded} {...s.headerProps} />}
            >
                <View testID="body-content" />
            </ExpandableItem>,
        );
        expect(collapsed.findByTestId('hdr')).toBeTruthy();
        expect(collapsed.findAllByTestId('body-content').length).toBe(0);

        const expanded = await renderScreen(
            <ExpandableItem
                testID="acct"
                expanded
                onExpandedChange={() => {}}
                header={(s) => <HeaderProbe testID="hdr" expanded={s.expanded} {...s.headerProps} />}
            >
                <View testID="body-content" />
            </ExpandableItem>,
        );
        expect(expanded.findAllByTestId('body-content').length).toBe(1);
    });

    it('collapsed middle item draws ONLY an inter-item hairline below the header', async () => {
        const { ExpandableItem } = await import('./ExpandableItem');
        const screen = await renderScreen(
            <ExpandableItem
                testID="acct"
                expanded={false}
                showDivider
                onExpandedChange={() => {}}
                header={(s) => <HeaderProbe testID="hdr" expanded={s.expanded} {...s.headerProps} />}
            >
                <View testID="body-content" />
            </ExpandableItem>,
        );

        // ExpandableItem owns the inter-item hairline so it paints on every
        // platform; the header Item never draws its own zero-height-on-web
        // divider, and there is no internal line in a collapsed row.
        expect(screen.findByType(HeaderProbe).props.showDivider).toBe(false);
        expect(screen.findAllByTestId('acct:body-divider').length).toBe(0);
        expect(screen.findAllByTestId('acct:row-divider').length).toBe(1);
    });

    it('paints the inter-item hairline as a faint line using the canonical border token', async () => {
        const { ExpandableItem } = await import('./ExpandableItem');
        const screen = await renderScreen(
            <ExpandableItem
                testID="acct"
                expanded
                showDivider
                onExpandedChange={() => {}}
                header={(s) => <HeaderProbe testID="hdr" expanded={s.expanded} {...s.headerProps} />}
            >
                <View testID="body-content" />
            </ExpandableItem>,
        );

        const rowDivider = flattenStyle(screen.findByTestId('acct:row-divider')?.props.style);

        // The hairline must actually paint (non-zero height) and use the
        // canonical themed divider token, not a hardcoded color, but stay subtle
        // via a reduced opacity rather than a hard, fully-opaque rule.
        expect(Number(rowDivider.height)).toBeGreaterThan(0);
        expect(rowDivider.backgroundColor).toBe(lightTheme.colors.border.default);
        expect(Number(rowDivider.opacity)).toBeGreaterThan(0);
        expect(Number(rowDivider.opacity)).toBeLessThan(1);

        // No line is ever drawn inside the item (header ↔ body).
        expect(screen.findAllByTestId('acct:body-divider').length).toBe(0);
    });

    it('expanded middle item draws ONLY an inter-item hairline below the body, never inside', async () => {
        const { ExpandableItem } = await import('./ExpandableItem');
        const screen = await renderScreen(
            <ExpandableItem
                testID="acct"
                expanded
                showDivider
                onExpandedChange={() => {}}
                header={(s) => <HeaderProbe testID="hdr" expanded={s.expanded} {...s.headerProps} />}
            >
                <View testID="body-content" />
            </ExpandableItem>,
        );

        expect(screen.findByType(HeaderProbe).props.showDivider).toBe(false);
        // No header ↔ body line inside the expanded item.
        expect(screen.findAllByTestId('acct:body-divider').length).toBe(0);
        // Only the inter-item separator below the body remains.
        expect(screen.findAllByTestId('acct:row-divider').length).toBe(1);
    });

    it('last expanded item draws no internal line and no below-body inter-item separator', async () => {
        const { ExpandableItem } = await import('./ExpandableItem');
        const screen = await renderScreen(
            <ExpandableItem
                testID="acct"
                expanded
                showDivider={false}
                onExpandedChange={() => {}}
                header={(s) => <HeaderProbe testID="hdr" expanded={s.expanded} {...s.headerProps} />}
            >
                <View testID="body-content" />
            </ExpandableItem>,
        );

        expect(screen.findByType(HeaderProbe).props.showDivider).toBe(false);
        // Last row: no internal line and no trailing inter-item separator.
        expect(screen.findAllByTestId('acct:body-divider').length).toBe(0);
        expect(screen.findAllByTestId('acct:row-divider').length).toBe(0);
    });

    it('occupies exactly one row slot so ItemGroup dividers/corners apply per item', async () => {
        const { ExpandableItem } = await import('./ExpandableItem');
        const { withItemGroupDividers } = await import('./ItemGroup.dividers');
        const { ItemGroupRowPositionProvider } = await import('./ItemGroupRowPosition');

        const makeItem = (key: string) => (
            <ExpandableItem
                key={key}
                expanded={false}
                onExpandedChange={() => {}}
                header={<HeaderProbe testID={`hdr-${key}`} />}
            >
                <View />
            </ExpandableItem>
        );

        const processed = withItemGroupDividers([makeItem('a'), makeItem('b'), makeItem('c')]);

        const positions: Array<{ isFirst: boolean; isLast: boolean; showDivider: unknown }> = [];
        React.Children.forEach(processed, (child) => {
            if (!React.isValidElement(child)) return;
            if (child.type !== ItemGroupRowPositionProvider) return;
            const provider = child as React.ReactElement<{
                value: { isFirst: boolean; isLast: boolean };
                children?: React.ReactNode;
            }>;
            const inner = React.Children.toArray(provider.props.children)[0];
            if (!React.isValidElement(inner) || inner.type !== ExpandableItem) return;
            const element = inner as React.ReactElement<{ showDivider?: boolean }>;
            positions.push({
                isFirst: provider.props.value.isFirst,
                isLast: provider.props.value.isLast,
                showDivider: element.props.showDivider,
            });
        });

        // Three ExpandableItems -> three single row slots with correct corners + dividers.
        expect(positions).toEqual([
            { isFirst: true, isLast: false, showDivider: true },
            { isFirst: false, isLast: false, showDivider: true },
            { isFirst: false, isLast: true, showDivider: false },
        ]);
    });

    it('toggles via the header onPress (controlled)', async () => {
        const { ExpandableItem } = await import('./ExpandableItem');
        const onExpandedChange = vi.fn();
        const screen = await renderScreen(
            <ExpandableItem
                testID="acct"
                expanded={false}
                onExpandedChange={onExpandedChange}
                header={(s) => <HeaderProbe testID="hdr" expanded={s.expanded} {...s.headerProps} />}
            >
                <View testID="body-content" />
            </ExpandableItem>,
        );

        screen.findByTestId('hdr')?.props.onPress?.();
        expect(onExpandedChange).toHaveBeenCalledWith(true);
    });

    it('snaps without withTiming when reduced motion is preferred', async () => {
        reducedMotionRef.value = true;
        const { ExpandableItem } = await import('./ExpandableItem');
        const screen = await renderScreen(
            <ExpandableItem
                testID="acct"
                expanded={false}
                onExpandedChange={() => {}}
                header={(s) => <HeaderProbe testID="hdr" expanded={s.expanded} {...s.headerProps} />}
            >
                <View testID="body-content" />
            </ExpandableItem>,
        );

        animationControls.timingCalls = [];
        await screen.update(
            <ExpandableItem
                testID="acct"
                expanded
                onExpandedChange={() => {}}
                header={(s) => <HeaderProbe testID="hdr" expanded={s.expanded} {...s.headerProps} />}
            >
                <View testID="body-content" />
            </ExpandableItem>,
        );

        expect(animationControls.timingCalls.length).toBe(0);
        expect(screen.findAllByTestId('body-content').length).toBe(1);
    });

    it('animates with withTiming when expanding and motion is allowed', async () => {
        reducedMotionRef.value = false;
        const { ExpandableItem } = await import('./ExpandableItem');
        const screen = await renderScreen(
            <ExpandableItem
                testID="acct"
                expanded={false}
                onExpandedChange={() => {}}
                header={(s) => <HeaderProbe testID="hdr" expanded={s.expanded} {...s.headerProps} />}
            >
                <View testID="body-content" />
            </ExpandableItem>,
        );

        animationControls.timingCalls = [];
        await screen.update(
            <ExpandableItem
                testID="acct"
                expanded
                onExpandedChange={() => {}}
                header={(s) => <HeaderProbe testID="hdr" expanded={s.expanded} {...s.headerProps} />}
            >
                <View testID="body-content" />
            </ExpandableItem>,
        );

        expect(animationControls.timingCalls.length).toBeGreaterThan(0);
    });

    it('reconciles a mid-flight expand to a body that GROWS after the first layout', async () => {
        // Hold the reveal animation mid-flight (native runs it over ~220ms).
        animationControls.autoFinish = false;
        const { ExpandableItem } = await import('./ExpandableItem');
        const screen = await renderScreen(
            <ExpandableItem
                testID="acct"
                expanded={false}
                onExpandedChange={() => {}}
                header={(s) => <HeaderProbe testID="hdr" expanded={s.expanded} {...s.headerProps} />}
            >
                <View testID="body-content" />
            </ExpandableItem>,
        );
        await screen.update(
            <ExpandableItem
                testID="acct"
                expanded
                onExpandedChange={() => {}}
                header={(s) => <HeaderProbe testID="hdr" expanded={s.expanded} {...s.headerProps} />}
            >
                <View testID="body-content" />
            </ExpandableItem>,
        );

        const body = screen.findByTestId('acct:body');
        // First measured height arms the reveal; then async content lands at a
        // taller natural height while the animation is still pinned mid-flight.
        fireBodyLayout(body, 120);
        fireBodyLayout(body, 200);

        // The pinned reveal must chase the LATEST height, not undershoot to 120
        // ("half-expand"). The final height command reconciles to 200.
        expect(heightTargets().at(-1)).toBe(200);
    });

    it('reconciles a mid-flight expand to a body that SHRINKS after the first layout', async () => {
        animationControls.autoFinish = false;
        const { ExpandableItem } = await import('./ExpandableItem');
        const screen = await renderScreen(
            <ExpandableItem
                testID="acct"
                expanded={false}
                onExpandedChange={() => {}}
                header={(s) => <HeaderProbe testID="hdr" expanded={s.expanded} {...s.headerProps} />}
            >
                <View testID="body-content" />
            </ExpandableItem>,
        );
        await screen.update(
            <ExpandableItem
                testID="acct"
                expanded
                onExpandedChange={() => {}}
                header={(s) => <HeaderProbe testID="hdr" expanded={s.expanded} {...s.headerProps} />}
            >
                <View testID="body-content" />
            </ExpandableItem>,
        );

        const body = screen.findByTestId('acct:body');
        fireBodyLayout(body, 200);
        fireBodyLayout(body, 120);

        expect(heightTargets().at(-1)).toBe(120);
    });

    it('reconciles the STALE fast-path height on re-expand (the reported half-expand)', async () => {
        const { ExpandableItem } = await import('./ExpandableItem');
        const header = (s: import('./ExpandableItem').ExpandableItemHeaderState) => (
            <HeaderProbe testID="hdr" expanded={s.expanded} {...s.headerProps} />
        );
        const screen = await renderScreen(
            <ExpandableItem testID="acct" expanded={false} onExpandedChange={() => {}} header={header}>
                <View testID="body-content" />
            </ExpandableItem>,
        );

        // 1) First open settles at 120, seeding measuredHeightRef with a height
        //    that becomes STALE once the account's quota changes.
        await screen.update(
            <ExpandableItem testID="acct" expanded onExpandedChange={() => {}} header={header}>
                <View testID="body-content" />
            </ExpandableItem>,
        );
        fireBodyLayout(screen.findByTestId('acct:body'), 120);

        // 2) Collapse (animation settles synchronously via autoFinish).
        await screen.update(
            <ExpandableItem testID="acct" expanded={false} onExpandedChange={() => {}} header={header}>
                <View testID="body-content" />
            </ExpandableItem>,
        );

        // 3) Re-open, now holding the animation mid-flight. The expand effect
        //    takes the fast path using the STALE 120 height. Async quota then
        //    reports the real, larger 260.
        animationControls.autoFinish = false;
        animationControls.timingCalls = [];
        await screen.update(
            <ExpandableItem testID="acct" expanded onExpandedChange={() => {}} header={header}>
                <View testID="body-content" />
            </ExpandableItem>,
        );
        fireBodyLayout(screen.findByTestId('acct:body'), 260);

        // The reveal must reconcile off the stale 120 to the fresh 260 instead
        // of undershooting until the timing finishes.
        expect(heightTargets().at(-1)).toBe(260);
    });

    it('does not re-arm the reveal when the height is unchanged (no animation thrash)', async () => {
        animationControls.autoFinish = false;
        const { ExpandableItem } = await import('./ExpandableItem');
        const screen = await renderScreen(
            <ExpandableItem
                testID="acct"
                expanded={false}
                onExpandedChange={() => {}}
                header={(s) => <HeaderProbe testID="hdr" expanded={s.expanded} {...s.headerProps} />}
            >
                <View testID="body-content" />
            </ExpandableItem>,
        );
        await screen.update(
            <ExpandableItem
                testID="acct"
                expanded
                onExpandedChange={() => {}}
                header={(s) => <HeaderProbe testID="hdr" expanded={s.expanded} {...s.headerProps} />}
            >
                <View testID="body-content" />
            </ExpandableItem>,
        );

        const body = screen.findByTestId('acct:body');
        fireBodyLayout(body, 150);
        const afterArm = heightTargets().length;
        // A repeat layout within the epsilon must NOT re-issue a timing command.
        fireBodyLayout(body, 150.5);
        expect(heightTargets().length).toBe(afterArm);
    });

    it('reduced motion never animates height even as the body re-layouts', async () => {
        reducedMotionRef.value = true;
        animationControls.autoFinish = false;
        const { ExpandableItem } = await import('./ExpandableItem');
        const screen = await renderScreen(
            <ExpandableItem
                testID="acct"
                expanded
                onExpandedChange={() => {}}
                header={(s) => <HeaderProbe testID="hdr" expanded={s.expanded} {...s.headerProps} />}
            >
                <View testID="body-content" />
            </ExpandableItem>,
        );

        const body = screen.findByTestId('acct:body');
        fireBodyLayout(body, 120);
        fireBodyLayout(body, 240);
        // No height timing is ever issued under reduced motion.
        expect(heightTargets().length).toBe(0);
    });

    it('collapse still unmounts the body and drives height to zero', async () => {
        const { ExpandableItem } = await import('./ExpandableItem');
        const header = (s: import('./ExpandableItem').ExpandableItemHeaderState) => (
            <HeaderProbe testID="hdr" expanded={s.expanded} {...s.headerProps} />
        );
        const screen = await renderScreen(
            <ExpandableItem testID="acct" expanded onExpandedChange={() => {}} header={header}>
                <View testID="body-content" />
            </ExpandableItem>,
        );
        fireBodyLayout(screen.findByTestId('acct:body'), 120);

        animationControls.timingCalls = [];
        await screen.update(
            <ExpandableItem testID="acct" expanded={false} onExpandedChange={() => {}} header={header}>
                <View testID="body-content" />
            </ExpandableItem>,
        );

        // Collapse drives to 0 and settles the body unmounted.
        expect(heightTargets()).toContain(0);
        expect(screen.findAllByTestId('body-content').length).toBe(0);
    });
});
