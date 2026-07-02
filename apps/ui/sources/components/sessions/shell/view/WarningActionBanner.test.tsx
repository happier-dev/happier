import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';

const windowDimensionsState = vi.hoisted(() => ({
    width: 1200,
    height: 800,
}));

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
    useWindowDimensions: () => ({
        width: windowDimensionsState.width,
        height: windowDimensionsState.height,
        scale: 1,
        fontScale: 1,
    }),
    Platform: {
        OS: 'web',
        select: (spec: Record<string, unknown>) => spec.web ?? spec.default,
    },
    StyleSheet: {
        hairlineWidth: 1,
        create: (value: unknown) => value,
    },
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                state: {
                    warning: {
                        background: '#fff4cc',
                        border: '#f0d98a',
                        foreground: '#111',
                    },
                },
                button: {
                    primary: {
                        background: '#111',
                        tint: '#fff',
                    },
                },
            },
        },
    }),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
}));

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
    }
    return typeof style === 'object' && style !== null ? style as Record<string, unknown> : {};
}

describe('WarningActionBanner', () => {
    beforeEach(() => {
        windowDimensionsState.width = 1200;
        windowDimensionsState.height = 800;
    });

    it('renders and invokes secondary actions from the shared warning surface', async () => {
        const onPrimary = vi.fn();
        const onSecondary = vi.fn();
        const { WarningActionBanner } = await import('./WarningActionBanner');

        const screen = await renderScreen(
            <WarningActionBanner
                testID="warning"
                actionTestID="warning-primary"
                title="Limit reached"
                body="Try again later."
                actionLabel="Continue later"
                actionAccessibilityLabel="Continue later"
                onActionPress={onPrimary}
                secondaryActions={[{
                    key: 'check',
                    testID: 'warning-check',
                    label: 'Check now',
                    accessibilityLabel: 'Check now',
                    onPress: onSecondary,
                }]}
            />,
        );

        await pressTestInstanceAsync(screen.findByTestId('warning-check'));

        expect(onPrimary).not.toHaveBeenCalled();
        expect(onSecondary).toHaveBeenCalledTimes(1);
    });

    it('keeps action buttons to the right of the warning copy on desktop', async () => {
        const { WarningActionBanner } = await import('./WarningActionBanner');

        const screen = await renderScreen(
            <WarningActionBanner
                testID="warning"
                actionTestID="warning-primary"
                title="Usage limit reached"
                body="This provider is asking the session to wait until 18.5.2026, 11:40:00 before continuing."
                actionLabel="Resume when limit resets"
                actionAccessibilityLabel="Resume when limit resets"
                onActionPress={vi.fn()}
                secondaryActions={[{
                    key: 'check',
                    testID: 'warning-check',
                    label: 'Check limit now',
                    accessibilityLabel: 'Check limit now',
                    onPress: vi.fn(),
                }, {
                    key: 'remember',
                    testID: 'warning-remember',
                    label: 'Always wait and resume',
                    accessibilityLabel: 'Always wait and resume',
                    onPress: vi.fn(),
                }]}
            />,
        );

        expect(flattenStyle(screen.findByTestId('warning')?.props.style)).toMatchObject({
            flexDirection: 'row',
            alignItems: 'center',
        });
        expect(flattenStyle(screen.findByTestId('warning-copy-row')?.props.style)).toMatchObject({
            flexDirection: 'row',
            flex: 1,
        });
        expect(flattenStyle(screen.findByTestId('warning-actions-row')?.props.style)).toMatchObject({
            flexDirection: 'row',
            flexWrap: 'wrap',
            flexShrink: 0,
            justifyContent: 'flex-end',
        });
        expect(flattenStyle(screen.findByTestId('warning-primary')?.props.style({ pressed: false })).maxWidth).toBe('100%');
        expect(flattenStyle(screen.findByTestId('warning-remember')?.props.style({ pressed: false })).maxWidth).toBe('100%');
    });

    it('wraps action buttons to a separate row on mobile', async () => {
        windowDimensionsState.width = 390;
        const { WarningActionBanner } = await import('./WarningActionBanner');

        const screen = await renderScreen(
            <WarningActionBanner
                testID="warning"
                actionTestID="warning-primary"
                title="Usage limit reached"
                body="This provider is asking the session to wait until 18.5.2026, 11:40:00 before continuing."
                actionLabel="Resume when limit resets"
                actionAccessibilityLabel="Resume when limit resets"
                onActionPress={vi.fn()}
                secondaryActions={[{
                    key: 'check',
                    testID: 'warning-check',
                    label: 'Check limit now',
                    accessibilityLabel: 'Check limit now',
                    onPress: vi.fn(),
                }, {
                    key: 'remember',
                    testID: 'warning-remember',
                    label: 'Always wait and resume',
                    accessibilityLabel: 'Always wait and resume',
                    onPress: vi.fn(),
                }]}
            />,
        );

        expect(flattenStyle(screen.findByTestId('warning')?.props.style)).toMatchObject({
            flexDirection: 'column',
            alignItems: 'stretch',
        });
        expect(flattenStyle(screen.findByTestId('warning-copy-row')?.props.style)).toMatchObject({
            flexDirection: 'row',
            width: '100%',
        });
        expect(flattenStyle(screen.findByTestId('warning-actions-row')?.props.style)).toMatchObject({
            flexDirection: 'row',
            flexWrap: 'wrap',
            width: '100%',
        });
        expect(flattenStyle(screen.findByTestId('warning-primary')?.props.style({ pressed: false })).maxWidth).toBe('100%');
        expect(flattenStyle(screen.findByTestId('warning-remember')?.props.style({ pressed: false })).maxWidth).toBe('100%');
    });

    it('uses the measured banner width when a constrained pane is narrower than the window', async () => {
        windowDimensionsState.width = 1200;
        const { WarningActionBanner } = await import('./WarningActionBanner');

        const screen = await renderScreen(
            <WarningActionBanner
                testID="warning"
                actionTestID="warning-primary"
                title="Usage limit reached"
                body="This provider is asking the session to wait until 18.5.2026, 11:40:00 before continuing."
                actionLabel="Resume when limit resets"
                actionAccessibilityLabel="Resume when limit resets"
                onActionPress={vi.fn()}
                secondaryActions={[{
                    key: 'check',
                    testID: 'warning-check',
                    label: 'Check limit now',
                    accessibilityLabel: 'Check limit now',
                    onPress: vi.fn(),
                }]}
            />,
        );
        const warning = screen.findByTestId('warning')!;

        await act(async () => {
            warning.props.onLayout?.({
                nativeEvent: {
                    layout: {
                        width: 360,
                        height: 72,
                        x: 0,
                        y: 0,
                    },
                },
            });
        });

        expect(flattenStyle(screen.findByTestId('warning')?.props.style)).toMatchObject({
            flexDirection: 'column',
            alignItems: 'stretch',
        });
        expect(flattenStyle(screen.findByTestId('warning-actions-row')?.props.style)).toMatchObject({
            width: '100%',
        });
    });
});
