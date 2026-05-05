import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { DesktopActivityOverlayUiModel } from './shared/desktopActivityOverlayUiModel';

const reduceMotionPreferenceMock = vi.hoisted(() => vi.fn(() => false));
const screenReaderEnabledMock = vi.hoisted(() => vi.fn(async () => false));
const reanimatedSpies = vi.hoisted(() => ({
    useSharedValue: vi.fn(<T,>(initial: T) => ({ value: initial })),
    withRepeat: vi.fn((value: unknown) => value),
    withSequence: vi.fn((...values: unknown[]) => values.at(-1)),
    withSpring: vi.fn((value: unknown) => value),
    withTiming: vi.fn((value: unknown) => value),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        AccessibilityInfo: {
            isReduceMotionEnabled: async () => false,
            isScreenReaderEnabled: () => screenReaderEnabledMock(),
            addEventListener: () => ({ remove: () => {} }),
        },
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('Text', props, props.children),
}));

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => reduceMotionPreferenceMock(),
}));

vi.mock('react-native-reanimated', () => ({
    __esModule: true,
    default: {
        View: (props: React.PropsWithChildren<Record<string, unknown>>) =>
            React.createElement('AnimatedView', props, props.children),
    },
    useAnimatedStyle: <T,>(factory: () => T) => factory(),
    useSharedValue: reanimatedSpies.useSharedValue,
    withRepeat: reanimatedSpies.withRepeat,
    withSequence: reanimatedSpies.withSequence,
    withSpring: reanimatedSpies.withSpring,
    withTiming: reanimatedSpies.withTiming,
}));

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.filter(Boolean).map(flattenStyle));
    }
    return style && typeof style === 'object' ? style as Record<string, unknown> : {};
}

function createCollapsedModel(overrides: Partial<DesktopActivityOverlayUiModel> = {}): DesktopActivityOverlayUiModel {
    const base: DesktopActivityOverlayUiModel = {
        visible: true,
        isExpanded: false,
        generatedAt: 1,
        collapsed: {
            title: 'Primary session',
            statusText: 'Needs attention',
            defaultTarget: 'open-primary-session',
            sessionCount: 3,
            slides: [
                {
                    id: 'status',
                    title: 'Needs attention',
                    subtitle: 'Primary session',
                    animatedEllipsis: false,
                    priority: 'attention',
                },
                {
                    id: 'task_title',
                    title: 'Primary session',
                    subtitle: null,
                    animatedEllipsis: false,
                    priority: 'attention',
                },
            ],
            carousel: {
                enabled: true,
                cadenceMs: 3000,
                freezeReason: null,
            },
            urgency: {
                level: 'needs_you',
                unattendedMs: 31000,
                pollMs: 5000,
            },
        },
        expanded: {
            title: 'Sessions',
            rows: [],
            cards: [],
        },
        window: {
            collapsed: { width: 340, height: 72 },
            expanded: { width: 420, height: 220 },
        },
    };

    return {
        ...base,
        ...overrides,
    };
}

describe('DesktopActivityOverlayCollapsed', () => {
    afterEach(() => {
        reduceMotionPreferenceMock.mockReset();
        reduceMotionPreferenceMock.mockReturnValue(false);
        screenReaderEnabledMock.mockReset();
        screenReaderEnabledMock.mockResolvedValue(false);
        reanimatedSpies.useSharedValue.mockClear();
        reanimatedSpies.withRepeat.mockClear();
        reanimatedSpies.withSequence.mockClear();
        reanimatedSpies.withSpring.mockClear();
        reanimatedSpies.withTiming.mockClear();
        vi.useRealTimers();
    });

    it('keeps the floating collapsed surface informative and pressable', async () => {
        const { DesktopActivityOverlayCollapsed } = await import('./DesktopActivityOverlayCollapsed');
        const onPress = vi.fn();

        const screen = await renderScreen(
            <DesktopActivityOverlayCollapsed
                model={createCollapsedModel()}
                visualMode="floating_overlay"
                dragHandlers={{}}
                onPress={onPress}
            />,
        );

        expect(screen.getTextContent()).toContain('Primary session');
        expect(screen.getTextContent()).toContain('Needs attention');
        expect(screen.getTextContent()).toContain('3');
        expect(screen.findByTestId('desktop-activity-overlay-collapsed-brand-mark')).toBeTruthy();

        screen.pressByTestId('desktop-activity-overlay-collapsed');

        expect(onPress).toHaveBeenCalledTimes(1);
    });

    it('keeps the notch-integrated collapsed surface camera-safe with only wing affordances', async () => {
        const { DesktopActivityOverlayCollapsed } = await import('./DesktopActivityOverlayCollapsed');

        const screen = await renderScreen(
            <DesktopActivityOverlayCollapsed
                model={createCollapsedModel({
                    window: {
                        collapsed: { width: 224, height: 38 },
                        expanded: { width: 420, height: 220 },
                    },
                })}
                visualMode="notch_integrated"
                dragHandlers={{}}
                onPress={() => {}}
            />,
        );

        expect(screen.findByTestId('desktop-activity-overlay-collapsed-brand-mark')).toBeTruthy();
        expect(screen.getTextContent()).toContain('3');
        expect(screen.getTextContent()).not.toContain('Primary session');
        expect(screen.getTextContent()).not.toContain('Needs attention');
    });

    it('sizes the notch camera spacer from the native physical notch width', async () => {
        const { DesktopActivityOverlayCollapsed } = await import('./DesktopActivityOverlayCollapsed');

        const screen = await renderScreen(
            <DesktopActivityOverlayCollapsed
                model={createCollapsedModel({
                    window: {
                        collapsed: { width: 224, height: 38 },
                        expanded: { width: 420, height: 220 },
                    },
                })}
                physicalNotchWidth={228}
                visualMode="notch_integrated"
                dragHandlers={{}}
                onPress={() => {}}
            />,
        );

        expect(flattenStyle(screen.findByTestId('desktop-activity-overlay-camera-spacer')?.props.style)).toEqual(
            expect.objectContaining({ minWidth: 79.8 }),
        );
    });

    it('renders the notch-integrated chrome surface when visual mode is notch integrated', async () => {
        const { DesktopActivityOverlayCollapsed } = await import('./DesktopActivityOverlayCollapsed');

        const screen = await renderScreen(
            <DesktopActivityOverlayCollapsed
                model={createCollapsedModel({
                    window: {
                        collapsed: { width: 224, height: 38 },
                        expanded: { width: 420, height: 220 },
                    },
                })}
                visualMode="notch_integrated"
                dragHandlers={{}}
                onPress={() => {}}
            />,
        );

        expect(screen.findByTestId('desktop-activity-overlay-collapsed-notch')).toBeTruthy();
    });

    it('renders the floating chrome surface when visual mode is floating overlay', async () => {
        const { DesktopActivityOverlayCollapsed } = await import('./DesktopActivityOverlayCollapsed');

        const screen = await renderScreen(
            <DesktopActivityOverlayCollapsed
                model={createCollapsedModel({
                    window: {
                        collapsed: { width: 388, height: 76 },
                        expanded: { width: 420, height: 220 },
                    },
                })}
                visualMode="floating_overlay"
                dragHandlers={{}}
                onPress={() => {}}
            />,
        );

        expect(screen.findByTestId('desktop-activity-overlay-collapsed-floating')).toBeTruthy();
    });

    it('renders the active collapsed carousel slide on floating surfaces', async () => {
        const { DesktopActivityOverlayCollapsed } = await import('./DesktopActivityOverlayCollapsed');

        const screen = await renderScreen(
            <DesktopActivityOverlayCollapsed
                model={createCollapsedModel({
                    collapsed: {
                        title: 'Legacy collapsed title',
                        statusText: 'Legacy status',
                        defaultTarget: 'open-primary-session',
                        sessionCount: 1,
                        slides: [
                            {
                                id: 'status',
                                title: 'Carousel status',
                                subtitle: 'Carousel subtitle',
                                animatedEllipsis: false,
                                priority: 'running',
                            },
                        ],
                        carousel: {
                            enabled: true,
                            cadenceMs: 3000,
                            freezeReason: null,
                        },
                        urgency: {
                            level: 'running',
                            unattendedMs: 0,
                            pollMs: 5000,
                        },
                    },
                })}
                visualMode="floating_overlay"
                dragHandlers={{}}
                onPress={() => {}}
            />,
        );

        expect(screen.getTextContent()).toContain('Carousel status');
        expect(screen.getTextContent()).toContain('Carousel subtitle');
        expect(screen.getTextContent()).not.toContain('Legacy collapsed title');
        expect(screen.getTextContent()).not.toContain('Legacy status');
    });

    it('renders animated ellipsis, urgency pulse, and push-swap primitives for working slides', async () => {
        vi.useFakeTimers();
        const { act } = await import('react-test-renderer');
        const { DesktopActivityOverlayCollapsed } = await import('./DesktopActivityOverlayCollapsed');

        const screen = await renderScreen(
            <DesktopActivityOverlayCollapsed
                model={createCollapsedModel({
                    collapsed: {
                        title: 'Legacy collapsed title',
                        statusText: 'Legacy status',
                        defaultTarget: 'open-primary-session',
                        sessionCount: 1,
                        slides: [
                            {
                                id: 'status',
                                title: 'Working',
                                subtitle: 'Improve checkout flow',
                                animatedEllipsis: true,
                                priority: 'running',
                            },
                            {
                                id: 'task_title',
                                title: 'Improve checkout flow',
                                subtitle: null,
                                animatedEllipsis: false,
                                priority: 'running',
                            },
                        ],
                        carousel: {
                            enabled: true,
                            cadenceMs: 1000,
                            freezeReason: null,
                        },
                        urgency: {
                            level: 'running',
                            unattendedMs: 0,
                            pollMs: 5000,
                        },
                    },
                })}
                visualMode="floating_overlay"
                dragHandlers={{}}
                onPress={() => {}}
            />,
        );

        expect(screen.findByTestId('desktop-activity-overlay-collapsed-ellipsis')?.props.children).toBe('.');
        const pulse = screen.findByTestId('desktop-activity-overlay-urgency-pulse');
        expect(pulse?.type).toBe('AnimatedView');
        expect(pulse?.props['data-urgency-level']).toBe('running');
        expect(reanimatedSpies.withRepeat).toHaveBeenCalledWith(
            expect.anything(),
            -1,
            true,
        );
        expect(reanimatedSpies.withTiming).toHaveBeenCalledWith(0.5, expect.objectContaining({
            duration: 1200,
        }));

        const slide = screen.findByTestId('desktop-activity-overlay-collapsed-slide');
        expect(slide?.type).toBe('AnimatedView');
        expect(slide?.props['data-swap-direction']).toBe('push-from-bottom');
        expect(flattenStyle(slide?.props.style)).toEqual(expect.objectContaining({
            opacity: expect.any(Number),
            transform: expect.any(Array),
        }));

        await act(async () => {
            await vi.advanceTimersByTimeAsync(450);
        });

        expect(screen.findByTestId('desktop-activity-overlay-collapsed-ellipsis')?.props.children).toBe('..');
    });

    it('renders bounce-on-ready and standby fade primitives from collapsed state', async () => {
        const { DesktopActivityOverlayCollapsed } = await import('./DesktopActivityOverlayCollapsed');

        const readyScreen = await renderScreen(
            <DesktopActivityOverlayCollapsed
                model={createCollapsedModel({
                    collapsed: {
                        ...createCollapsedModel().collapsed,
                        transitionCue: {
                            kind: 'bounce_on_ready',
                            phase: 'ready',
                            key: 'ready:session-1',
                            durationMs: 150,
                        },
                    },
                })}
                visualMode="floating_overlay"
                dragHandlers={{}}
                onPress={() => {}}
            />,
        );

        const bounce = readyScreen.findByTestId('desktop-activity-overlay-ready-bounce');
        expect(bounce?.type).toBe('AnimatedView');
        expect(reanimatedSpies.withSequence).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
        );
        expect(reanimatedSpies.withSpring).toHaveBeenCalledWith(16, expect.objectContaining({
            duration: 300,
            dampingRatio: 0.5,
        }));

        const idleScreen = await renderScreen(
            <DesktopActivityOverlayCollapsed
                model={createCollapsedModel({
                    collapsed: {
                        title: 'No active sessions',
                        statusText: null,
                        defaultTarget: 'open-inbox',
                        sessionCount: null,
                        slides: [
                            {
                                id: 'status',
                                title: 'No active sessions',
                                subtitle: null,
                                animatedEllipsis: false,
                                priority: 'idle',
                            },
                        ],
                        carousel: {
                            enabled: false,
                            cadenceMs: 3000,
                            freezeReason: 'disabled',
                        },
                        urgency: {
                            level: 'idle',
                            unattendedMs: 0,
                            pollMs: 5000,
                        },
                    },
                })}
                visualMode="notch_integrated"
                dragHandlers={{}}
                onPress={() => {}}
            />,
        );

        const standbyFade = idleScreen.findByTestId('desktop-activity-overlay-standby-fade');
        expect(standbyFade?.type).toBe('AnimatedView');
        expect(standbyFade?.props['data-standby']).toBe('idle');
        expect(reanimatedSpies.withTiming).toHaveBeenCalledWith(0.72, expect.objectContaining({
            duration: 500,
        }));
        expect(idleScreen.findByTestId('desktop-activity-overlay-idle-dot')).toBeTruthy();
    });

    it('uses instant static values for motion primitives when reduced motion is preferred', async () => {
        reduceMotionPreferenceMock.mockReturnValue(true);
        const { DesktopActivityOverlayCollapsed } = await import('./DesktopActivityOverlayCollapsed');

        const screen = await renderScreen(
            <DesktopActivityOverlayCollapsed
                model={createCollapsedModel({
                    collapsed: {
                        ...createCollapsedModel().collapsed,
                        transitionCue: {
                            kind: 'bounce_on_ready',
                            phase: 'ready',
                            key: 'ready:session-1',
                            durationMs: 150,
                        },
                    },
                })}
                visualMode="floating_overlay"
                dragHandlers={{}}
                onPress={() => {}}
            />,
        );

        expect(screen.findByTestId('desktop-activity-overlay-ready-bounce')?.type).toBe('AnimatedView');
        expect(reanimatedSpies.withRepeat).not.toHaveBeenCalled();
        expect(reanimatedSpies.withSequence).not.toHaveBeenCalled();
    });

    it('polls urgency while mounted so unattended attention can escalate', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(100_000);
        const { act } = await import('react-test-renderer');
        const { DesktopActivityOverlayCollapsed } = await import('./DesktopActivityOverlayCollapsed');

        const screen = await renderScreen(
            <DesktopActivityOverlayCollapsed
                model={createCollapsedModel({
                    generatedAt: 100_000,
                    collapsed: {
                        ...createCollapsedModel().collapsed,
                        urgency: {
                            level: 'needs_you',
                            unattendedMs: 59_000,
                            pollMs: 5_000,
                        },
                    },
                })}
                visualMode="floating_overlay"
                dragHandlers={{}}
                onPress={() => {}}
            />,
        );

        expect(screen.findByTestId('desktop-activity-overlay-urgency-pulse')?.props['data-urgency-level']).toBe('needs_you');

        await act(async () => {
            vi.setSystemTime(105_000);
            await vi.advanceTimersByTimeAsync(5_000);
        });

        expect(screen.findByTestId('desktop-activity-overlay-urgency-pulse')?.props['data-urgency-level']).toBe('critical');
    });

    it('rotates collapsed carousel slides on the configured cadence', async () => {
        vi.useFakeTimers();
        const { act } = await import('react-test-renderer');
        const { DesktopActivityOverlayCollapsed } = await import('./DesktopActivityOverlayCollapsed');

        const screen = await renderScreen(
            <DesktopActivityOverlayCollapsed
                model={createCollapsedModel({
                    collapsed: {
                        title: 'Legacy collapsed title',
                        statusText: 'Legacy status',
                        defaultTarget: 'open-primary-session',
                        sessionCount: 1,
                        slides: [
                            {
                                id: 'status',
                                title: 'First slide',
                                subtitle: null,
                                animatedEllipsis: false,
                                priority: 'running',
                            },
                            {
                                id: 'task_title',
                                title: 'Second slide',
                                subtitle: null,
                                animatedEllipsis: false,
                                priority: 'running',
                            },
                        ],
                        carousel: {
                            enabled: true,
                            cadenceMs: 1000,
                            freezeReason: null,
                        },
                        urgency: {
                            level: 'running',
                            unattendedMs: 0,
                            pollMs: 5000,
                        },
                    },
                })}
                visualMode="floating_overlay"
                dragHandlers={{}}
                onPress={() => {}}
            />,
        );

        expect(screen.getTextContent()).toContain('First slide');

        await act(async () => {
            await vi.advanceTimersByTimeAsync(1000);
        });

        expect(screen.getTextContent()).toContain('Second slide');
    });

    it('freezes collapsed carousel rotation when reduced motion is preferred', async () => {
        vi.useFakeTimers();
        reduceMotionPreferenceMock.mockReturnValue(true);
        const { act } = await import('react-test-renderer');
        const { DesktopActivityOverlayCollapsed } = await import('./DesktopActivityOverlayCollapsed');

        const screen = await renderScreen(
            <DesktopActivityOverlayCollapsed
                model={createCollapsedModel({
                    collapsed: {
                        title: 'Legacy collapsed title',
                        statusText: 'Legacy status',
                        defaultTarget: 'open-primary-session',
                        sessionCount: 1,
                        slides: [
                            {
                                id: 'status',
                                title: 'Static slide',
                                subtitle: null,
                                animatedEllipsis: false,
                                priority: 'running',
                            },
                            {
                                id: 'task_title',
                                title: 'Rotating slide',
                                subtitle: null,
                                animatedEllipsis: false,
                                priority: 'running',
                            },
                        ],
                        carousel: {
                            enabled: true,
                            cadenceMs: 1000,
                            freezeReason: null,
                        },
                        urgency: {
                            level: 'running',
                            unattendedMs: 0,
                            pollMs: 5000,
                        },
                    },
                })}
                visualMode="floating_overlay"
                dragHandlers={{}}
                onPress={() => {}}
            />,
        );

        await act(async () => {
            await vi.advanceTimersByTimeAsync(3000);
        });

        expect(screen.getTextContent()).toContain('Static slide');
        expect(screen.getTextContent()).not.toContain('Rotating slide');
    });

    it('freezes on the most urgent slide when the screen reader is enabled', async () => {
        screenReaderEnabledMock.mockResolvedValue(true);
        const { act } = await import('react-test-renderer');
        const { DesktopActivityOverlayCollapsed } = await import('./DesktopActivityOverlayCollapsed');

        const screen = await renderScreen(
            <DesktopActivityOverlayCollapsed
                model={createCollapsedModel({
                    collapsed: {
                        title: 'Legacy collapsed title',
                        statusText: 'Legacy status',
                        defaultTarget: 'open-primary-session',
                        sessionCount: 1,
                        slides: [
                            {
                                id: 'status',
                                title: 'Running slide',
                                subtitle: null,
                                animatedEllipsis: false,
                                priority: 'running',
                            },
                            {
                                id: 'task_title',
                                title: 'Attention slide',
                                subtitle: null,
                                animatedEllipsis: false,
                                priority: 'attention',
                            },
                        ],
                        carousel: {
                            enabled: true,
                            cadenceMs: 1000,
                            freezeReason: null,
                        },
                        urgency: {
                            level: 'needs_you',
                            unattendedMs: 31000,
                            pollMs: 5000,
                        },
                    },
                })}
                visualMode="floating_overlay"
                dragHandlers={{}}
                onPress={() => {}}
            />,
        );

        await act(async () => {});

        expect(screen.getTextContent()).toContain('Attention slide');
        expect(screen.getTextContent()).not.toContain('Running slide');
    });
});
