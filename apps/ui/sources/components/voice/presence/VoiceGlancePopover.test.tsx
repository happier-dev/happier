import * as React from 'react';
import { View } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, type RenderScreenResult } from '@/dev/testkit';
import { installPopoverCommonModuleMocks } from '@/components/ui/popover/popoverTestHelpers';
import { resolveVoiceAttemptControl } from '@/components/voice/attempt/resolveVoiceAttemptControl';
import type { VoiceAttemptControlProjection } from '@/components/voice/attempt/useVoiceAttemptControl';
import type { VoiceSurfaceViewModel } from '@/components/voice/surface/useVoiceSurfaceModel';
import { t } from '@/text';

const viewport = vi.hoisted(() => ({ width: 390, height: 844 }));

installPopoverCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeNativeMock({ platformOS: 'ios' }, {
            useWindowDimensions: () => viewport,
            Dimensions: { get: () => ({ ...viewport, scale: 1, fontScale: 1 }) },
        });
    },
});

// Safe-area measurements come from the device SDK; overlay and glance policy remain real.
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 24, right: 0, bottom: 34, left: 0 }),
    initialWindowMetrics: null,
}));

/**
 * D2 (qa-4-design-5): on a phone the Voice glance is the lab's sheet (grabber, the glance's own
 * Voice header, the 64 pt hero and the control row) instead of an anchored popover the composer
 * shows through; desktop keeps the anchored popover. Same glance, same attempt handlers.
 */

function liveAttempt(): VoiceAttemptControlProjection {
    const control = resolveVoiceAttemptControl({
        surfaceState: 'listening', tone: 'active', status: 'connected', sessionId: 'voice-1',
        canStop: true, muted: false, capturing: true, startAdmitted: true, hasRecovery: false,
    });
    return {
        ...control,
        statusWord: 'Listening',
        statusLabel: 'Listening',
        elapsedStartedAt: null,
        canHoldToTalk: false,
        beginHoldToTalk: () => null,
        openConversationSessionAddress: null,
        canOpenConversation: false,
        primaryActionLabel: 'End Voice',
        primaryActionHint: null,
        recoveryLabel: null,
        recoveryIcon: null,
        micStateLabel: 'Microphone active',
        captionLabel: '',
        onPrimaryAction: vi.fn(),
        onToggle: vi.fn(),
        onToggleMute: vi.fn(),
        onRecover: vi.fn(),
        openConversationSessionId: null,
        onOpenConversation: vi.fn(),
    };
}

function surface(voice: VoiceAttemptControlProjection): VoiceSurfaceViewModel {
    return {
        attemptControl: voice,
        activityFeedEnabled: true,
        canBargeIn: true,
        canCancelTurn: false,
        canOpenConversation: false,
        canTeleportToSessionRoot: false,
        controlsDisabled: false,
        controlsLoading: false,
        delegatedWork: null,
        expanded: true,
        isMicCaptureActive: true,
        micStateLabel: 'Microphone active',
        mode: 'listening',
        muteLabel: 'Mute microphone',
        providerLabel: 'Local voice',
        startStopLabel: 'End Voice',
        status: 'connected',
        subtitle: null,
        targetLabel: null,
        toggleActivityLabel: 'Toggle voice activity',
        transcriptEntries: [],
        variant: 'sidebar',
        visibleTranscriptEntries: [],
        onBargeIn: vi.fn(),
        onCancelTurn: vi.fn(),
        onOpenConversation: vi.fn(),
        onTeleport: vi.fn(),
        onToggleExpanded: vi.fn(),
    };
}

let screen: RenderScreenResult | null = null;
afterEach(async () => {
    await screen?.unmount();
    screen = null;
    viewport.width = 390;
    viewport.height = 844;
});

async function renderOverlay(model: VoiceSurfaceViewModel, onRequestClose: () => void) {
    const { VoiceGlanceOverlay } = await import('./VoiceGlancePopover');
    const anchorRef = React.createRef<View>();
    return await renderScreen(<>
        <View ref={anchorRef} testID="anchor" />
        <VoiceGlanceOverlay model={model} anchorRef={anchorRef} placement="top" onRequestClose={onRequestClose} />
    </>);
}

describe('Voice glance presentation', () => {
    it('presents the glance as a phone sheet with one header, its collapse and the shared controls', async () => {
        const voice = liveAttempt();
        const model = surface(voice);
        const onClose = vi.fn();
        screen = await renderOverlay(model, onClose);

        const dialog = screen.findAll((node) => node.props?.role === 'dialog')[0];
        expect(dialog?.props.accessibilityLabel).toBe(t('voicePresence.title'));
        // The glance's own header is the sheet's header: no second title band or close button.
        expect(screen.findByTestId('popover-sheet.close')).toBeNull();
        expect(screen.findAll((node) => typeof node.type === 'string' && node.props?.children === t('voicePresence.title'))).toHaveLength(1);

        await screen.pressByTestIdAsync('voice-glance-popover-transport-mute');
        expect(voice.onToggleMute).toHaveBeenCalledTimes(1);
        await screen.pressByTestIdAsync('voice-glance-popover-transport-end');
        expect(voice.onToggle).toHaveBeenCalledTimes(1);

        await screen.pressByTestIdAsync('voice-glance-popover-collapse');
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('keeps the anchored popover on a wide layout', async () => {
        viewport.width = 1440;
        viewport.height = 900;
        screen = await renderOverlay(surface(liveAttempt()), vi.fn());

        expect(screen.findAll((node) => node.props?.role === 'dialog')).toHaveLength(0);
        expect(screen.findByTestId('voice-glance-popover-collapse')).toBeNull();
    });
});
