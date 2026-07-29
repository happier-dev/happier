import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { VoiceSurfaceControls } from './VoiceSurfaceControls';

const MIN_TARGET = 44;

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map(flattenStyle));
    }
    return style && typeof style === 'object' ? style as Record<string, unknown> : {};
}

function hasTestId(element: unknown, testID: string): boolean {
    if (!element || typeof element !== 'object' || !('props' in element)) return false;
    const props = element.props;
    return Boolean(props && typeof props === 'object' && 'testID' in props && props.testID === testID);
}

function findTargetFrame(instance: { props: Record<string, unknown>; parent: any }): Record<string, unknown> {
    let current: any = instance;
    while (current) {
        const frame = flattenStyle(current.props?.style);
        if ((frame.minWidth ?? frame.width) === MIN_TARGET && (frame.minHeight ?? frame.height) === MIN_TARGET) {
            return frame;
        }
        current = current.parent;
    }
    return {};
}

function renderControls(overrides: Partial<React.ComponentProps<typeof VoiceSurfaceControls>> = {}) {
    const props: React.ComponentProps<typeof VoiceSurfaceControls> = {
        cancelTurnLabel: 'cancel',
        canCancelTurn: false,
        canMute: false,
        canOpenConversation: false,
        canRecover: false,
        canStop: false,
        canTeleportToSessionRoot: false,
        controlsDisabled: false,
        controlsLoading: false,
        controlsActive: false,
        showStartStopAction: true,
        isMuted: false,
        muteLabel: 'mute',
        openLabel: 'open',
        recoveryLabel: 'recover',
        startStopLabel: 'start',
        styles: {},
        textColor: '#000000',
        teleportLabel: 'teleport',
        tintColor: '#ffffff',
        toggleTestID: 'voice-toggle',
        onCancelTurn: () => undefined,
        onToggleMute: () => undefined,
        onOpenConversation: () => undefined,
        onRecover: () => undefined,
        onTeleport: () => undefined,
        onToggle: () => undefined,
        ...overrides,
    };
    return renderScreen(<VoiceSurfaceControls {...props} />);
}

describe('VoiceSurfaceControls', () => {
    it('uses an actual 44pt primary frame instead of overlapping hit slop', async () => {
        const { tree } = await renderControls();
        const toggle = tree.root.findByProps({ testID: 'voice-toggle' });
        expect(toggle.props.hitSlop).toBeUndefined();
        const frame = findTargetFrame(toggle as any);
        expect(frame.minWidth ?? frame.width).toBeGreaterThanOrEqual(MIN_TARGET);
        expect(frame.minHeight ?? frame.height).toBeGreaterThanOrEqual(MIN_TARGET);
    });

    it('uses non-overlapping 44pt frames for every visible secondary action', async () => {
        const { tree } = await renderControls({
            canCancelTurn: true,
            canMute: true,
            canOpenConversation: true,
            canTeleportToSessionRoot: true,
            styles: {
                iconAction: { minWidth: 1, minHeight: 1 },
            },
        });
        for (const label of ['cancel', 'mute', 'open', 'teleport']) {
            const control = tree.root.findByProps({ accessibilityLabel: label });
            expect(control.props.hitSlop).toBeUndefined();
            const style = typeof control.props.style === 'function'
                ? control.props.style({ pressed: false })
                : control.props.style;
            const frame = flattenStyle(style);
            expect(frame.minWidth ?? frame.width).toBeGreaterThanOrEqual(MIN_TARGET);
            expect(frame.minHeight ?? frame.height).toBeGreaterThanOrEqual(MIN_TARGET);
        }
    });

    it('keeps the primary target minimum effective after surface styles are applied', async () => {
        const { tree } = await renderControls({
            styles: {
                primaryAction: { minWidth: 1, minHeight: 1 },
            },
        });
        const toggle = tree.root.findByProps({ testID: 'voice-toggle' });
        const frame = findTargetFrame(toggle as any);
        expect(frame.minWidth ?? frame.width).toBeGreaterThanOrEqual(MIN_TARGET);
        expect(frame.minHeight ?? frame.height).toBeGreaterThanOrEqual(MIN_TARGET);
    });

    it.each([
        { isMuted: false, muteLabel: 'mute' },
        { isMuted: true, muteLabel: 'unmute' },
    ])('exposes the $muteLabel action as a canonical toggle button', async ({ isMuted, muteLabel }) => {
        const { tree } = await renderControls({ canMute: true, isMuted, muteLabel });
        const mute = tree.root.findByProps({ accessibilityLabel: muteLabel });

        expect(mute.props.accessibilityRole).toBe('button');
        expect(mute.props.accessibilityState).toEqual({ selected: isMuted });
        expect(mute.props['aria-pressed']).toBe(isMuted);
        expect(mute.props.accessibilityState.checked).toBeUndefined();
    });

    it.each([
        { surfaceState: 'disabled', controlsDisabled: true, controlsLoading: false },
        { surfaceState: 'busy', controlsDisabled: false, controlsLoading: true },
    ])('does not expose a mute toggle while the surface is $surfaceState', async ({ controlsDisabled, controlsLoading }) => {
        const { tree } = await renderControls({
            canMute: false,
            controlsDisabled,
            controlsLoading,
        });

        expect(tree.root.findAllByProps({ accessibilityLabel: 'mute' })).toHaveLength(0);
    });

    it('does not expose Start or Retry when a hard error has no recovery action', async () => {
        const { tree } = await renderControls({
            canRecover: false,
            canStop: false,
            showStartStopAction: false,
        });

        expect(tree.root.findAllByProps({ testID: 'voice-toggle' })).toHaveLength(0);
        expect(tree.root.findAllByProps({ accessibilityLabel: 'start' })).toHaveLength(0);
        expect(tree.root.findAllByProps({ accessibilityLabel: 'recover' })).toHaveLength(0);
    });

    it('renders recovery as the only action even if stale session capabilities remain', async () => {
        const { tree } = await renderControls({
            canCancelTurn: true,
            canMute: true,
            canOpenConversation: true,
            canRecover: true,
            canStop: true,
            canTeleportToSessionRoot: true,
            recoveryLabel: '重试',
            recoveryTestID: 'voice-surface-recovery:test',
            styles: { recoveryAction: { minWidth: 1, minHeight: 1 } },
        });

        const recovery = tree.root.findByProps({ accessibilityLabel: '重试' });
        expect(recovery.props.testID).toBe('voice-surface-recovery:test');
        expect(recovery.props.hitSlop).toBeUndefined();
        const style = typeof recovery.props.style === 'function'
            ? recovery.props.style({ pressed: false })
            : recovery.props.style;
        const frame = flattenStyle(style);
        expect(frame.minWidth ?? frame.width).toBeGreaterThanOrEqual(MIN_TARGET);
        expect(frame.minHeight ?? frame.height).toBeGreaterThanOrEqual(MIN_TARGET);
        for (const label of ['cancel', 'mute', 'open', 'teleport', 'start']) {
            expect(tree.root.findAllByProps({ accessibilityLabel: label })).toHaveLength(0);
        }
    });

    it('moves focus to recovery only after a user-triggered Start action is replaced', async () => {
        const focus = vi.fn();
        const baseProps: React.ComponentProps<typeof VoiceSurfaceControls> = {
            cancelTurnLabel: 'cancel',
            canCancelTurn: false,
            canMute: false,
            canOpenConversation: false,
            canRecover: false,
            canStop: false,
            canTeleportToSessionRoot: false,
            controlsDisabled: false,
            controlsLoading: false,
            controlsActive: false,
            showStartStopAction: true,
            isMuted: false,
            muteLabel: 'mute',
            openLabel: 'open',
            recoveryLabel: 'retry',
            recoveryTestID: 'voice-recovery',
            startStopLabel: 'start',
            styles: {},
            textColor: '#000000',
            teleportLabel: 'teleport',
            tintColor: '#ffffff',
            toggleTestID: 'voice-toggle',
            onCancelTurn: () => undefined,
            onToggleMute: () => undefined,
            onOpenConversation: () => undefined,
            onRecover: () => undefined,
            onTeleport: () => undefined,
            onToggle: () => undefined,
        };
        const screen = await renderScreen(
            <VoiceSurfaceControls {...baseProps} />,
            {
                createNodeMock: (element) => (
                    hasTestId(element, 'voice-recovery')
                        ? { focus, isConnected: true }
                        : {}
                ),
            },
        );

        await screen.pressByTestIdAsync('voice-toggle');
        await screen.update(<VoiceSurfaceControls {...baseProps} canRecover />);

        expect(focus).toHaveBeenCalledTimes(1);
    });

    it('does not steal focus for a recovery state that was not caused by this surface Start action', async () => {
        const focus = vi.fn();
        const screen = await renderScreen(
            <VoiceSurfaceControls
                cancelTurnLabel="cancel"
                canCancelTurn={false}
                canMute={false}
                canOpenConversation={false}
                canRecover
                canStop={false}
                canTeleportToSessionRoot={false}
                controlsDisabled={false}
                controlsLoading={false}
                controlsActive={false}
                showStartStopAction
                isMuted={false}
                muteLabel="mute"
                openLabel="open"
                recoveryLabel="retry"
                recoveryTestID="voice-recovery"
                startStopLabel="start"
                styles={{}}
                textColor="#000000"
                teleportLabel="teleport"
                tintColor="#ffffff"
                toggleTestID="voice-toggle"
                onCancelTurn={() => undefined}
                onToggleMute={() => undefined}
                onOpenConversation={() => undefined}
                onRecover={() => undefined}
                onTeleport={() => undefined}
                onToggle={() => undefined}
            />,
            {
                createNodeMock: (element) => (
                    hasTestId(element, 'voice-recovery')
                        ? { focus, isConnected: true }
                        : {}
                ),
            },
        );

        expect(screen.findByTestId('voice-recovery')).toBeTruthy();
        expect(focus).not.toHaveBeenCalled();
    });

    it('does not retain pending recovery focus across a hard no-recovery error and cleared state', async () => {
        const focus = vi.fn();
        const baseProps: React.ComponentProps<typeof VoiceSurfaceControls> = {
            cancelTurnLabel: 'cancel',
            canCancelTurn: false,
            canMute: false,
            canOpenConversation: false,
            canRecover: false,
            canStop: false,
            canTeleportToSessionRoot: false,
            controlsDisabled: false,
            controlsLoading: false,
            controlsActive: false,
            showStartStopAction: true,
            isMuted: false,
            muteLabel: 'mute',
            openLabel: 'open',
            recoveryLabel: 'retry',
            recoveryTestID: 'voice-recovery',
            startStopLabel: 'start',
            styles: {},
            textColor: '#000000',
            teleportLabel: 'teleport',
            tintColor: '#ffffff',
            toggleTestID: 'voice-toggle',
            onCancelTurn: () => undefined,
            onToggleMute: () => undefined,
            onOpenConversation: () => undefined,
            onRecover: () => undefined,
            onTeleport: () => undefined,
            onToggle: () => undefined,
        };
        const screen = await renderScreen(
            <VoiceSurfaceControls {...baseProps} />,
            {
                createNodeMock: (element) => (
                    hasTestId(element, 'voice-recovery')
                        ? { focus, isConnected: true }
                        : {}
                ),
            },
        );

        await screen.pressByTestIdAsync('voice-toggle');
        await screen.update(<VoiceSurfaceControls {...baseProps} showStartStopAction={false} />);
        await screen.update(<VoiceSurfaceControls {...baseProps} />);
        await screen.update(<VoiceSurfaceControls {...baseProps} canRecover />);

        expect(focus).not.toHaveBeenCalled();
    });
});
