import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { installVoiceSurfaceCommonModuleMocks } from './voiceSurfaceTestHelpers';

installVoiceSurfaceCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'android',
            },
        });
    },
});

vi.mock('expo-image', () => ({ Image: 'Image' }));

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map(flattenStyle));
    }
    return style && typeof style === 'object' ? style as Record<string, unknown> : {};
}

function findTargetFrame(instance: { props: Record<string, unknown>; parent: any }): Record<string, unknown> {
    let current: any = instance;
    while (current) {
        const style = typeof current.props?.style === 'function'
            ? current.props.style({ pressed: false })
            : current.props?.style;
        const frame = flattenStyle(style);
        if (frame.minWidth === 48 && frame.minHeight === 48) return frame;
        current = current.parent;
    }
    return {};
}

describe('VoiceSurfaceControls Android targets', () => {
    it('keeps primary and secondary controls at 48dp after 44pt surface styles', async () => {
        const { VoiceSurfaceControls } = await import('./VoiceSurfaceControls');
        const screen = await renderScreen(
            <VoiceSurfaceControls
                cancelTurnLabel="cancel"
                canCancelTurn
                canMute
                canOpenConversation
                canRecover={false}
                canStop
                canTeleportToSessionRoot
                controlsDisabled={false}
                controlsLoading={false}
                controlsActive
                showStartStopAction
                isMuted={false}
                muteLabel="mute"
                openLabel="open"
                recoveryLabel="recover"
                startStopLabel="end"
                styles={{
                    iconAction: { minWidth: 44, minHeight: 44 },
                    primaryAction: { minWidth: 44, minHeight: 44 },
                }}
                textColor="#000"
                teleportLabel="teleport"
                tintColor="#fff"
                toggleTestID="voice-toggle"
                onCancelTurn={() => undefined}
                onToggleMute={() => undefined}
                onOpenConversation={() => undefined}
                onRecover={() => undefined}
                onTeleport={() => undefined}
                onToggle={() => undefined}
            />,
        );

        for (const label of ['cancel', 'mute', 'open', 'teleport']) {
            const control = screen.findByProps({ accessibilityLabel: label });
            const style = control.props.style({ pressed: false });
            expect(flattenStyle(style)).toMatchObject({ minWidth: 48, minHeight: 48 });
        }

        const toggle = screen.findByProps({ testID: 'voice-toggle' });
        expect(findTargetFrame(toggle as any)).toMatchObject({ minWidth: 48, minHeight: 48 });
    }, 180_000);
});
