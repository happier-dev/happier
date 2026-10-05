import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import type { ReactTestInstance } from 'react-test-renderer';
import { Platform } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    readReanimatedFrameCallbacks,
    resetReanimatedFrameCallbacks,
} from '@/dev/testkit/mocks/reanimated';
import { VoiceEnergyProvider, type VoiceEnergyState } from '@/components/voice/light/useVoiceEnergy';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { voiceRuntimeLevelStore, type VoiceRuntimeLevelWriter } from '@/voice/runtime/levels/voiceRuntimeLevelStore';

import { VoiceComposerPlanet } from './VoiceComposerPlanet';
import { createVoiceConversationController } from '@/voice/runtime/controller/VoiceConversationController';
import { createSdkHandleConnection } from '@/voice/runtime/connection/VoiceRealtimeConnection';
import { createOpenAiRealtimeProtocolAdapter } from '../../../../../../packages/plugins/openai/src/ui/voice/protocol';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => false,
}));

const LISTENING: VoiceEnergyState = { luminosity: 0.62, energized: true, direction: 'inward' };
const TEST_ID = 'session-composer-voice';

/** Module-level so a parent re-render passes the *same* handler identity. */
const onPress = vi.fn();

/**
 * The composer's Voice control (VE-02): the dot microphone at rest, the planet while live, before
 * Send. It is drawn compact but pressed through a real platform-size frame, it asks the shared
 * energy clock to run only while a conversation is live, and it never re-renders with the composer.
 */
describe('VoiceComposerPlanet', () => {
    let tree: renderer.ReactTestRenderer | null = null;
    let input: VoiceRuntimeLevelWriter | null = null;

    beforeEach(() => {
        resetReanimatedFrameCallbacks();
        onPress.mockClear();
        // Real microphone audio at the level store, so only consumer presence decides the clock.
        input = voiceRuntimeLevelStore.open({ channel: 'input', sourceId: 'composer-mark-test' });
        input.write(1);
    });

    afterEach(() => {
        act(() => {
            tree?.unmount();
            input?.close();
        });
        tree = null;
        input = null;
    });

    function scene(
        overrides: Partial<React.ComponentProps<typeof VoiceComposerPlanet>> = {},
        options: Readonly<{ mounted?: boolean }> = {},
    ): React.ReactElement {
        const { mounted = true } = options;
        return (
            <VoiceEnergyProvider
                state={LISTENING}
                activation={{ providerReady: true, attemptActive: true, micCaptureActive: true }}
            >
                {mounted ? (
                    <VoiceComposerPlanet
                        pose="ready"
                        muted={false}
                        accessibilityLabel="End Voice"
                        accessibilityHint="Ends the spoken conversation. Coding work already started keeps running."
                        onPress={onPress}
                        {...overrides}
                    />
                ) : null}
            </VoiceEnergyProvider>
        );
    }

    function render(node: React.ReactElement): void {
        act(() => {
            tree = renderer.create(node);
        });
    }

    function update(node: React.ReactElement): void {
        act(() => {
            tree!.update(node);
        });
    }

    /** The rendered press target, not the composite that produced it. */
    function control(): ReactTestInstance {
        const hosts = tree!.root.findAll(
            (node) => typeof node.type === 'string' && node.props?.testID === TEST_ID,
        );
        expect(hosts).toHaveLength(1);
        return hosts[0]!;
    }

    it('presses through a real platform-size frame rather than web-inert slop', () => {
        render(scene());

        const button = tree!.root.findByType(IconButton);
        const targetSize = resolveMinimumInteractiveTargetSize(Platform.OS);
        expect(button.props.minimumInteractiveTargetSize).toBeGreaterThanOrEqual(targetSize);
        expect(button.props.size).toBeLessThan(targetSize);
    });

    it('asks the shared energy clock to run only while the planet is live', () => {
        render(scene({ pose: 'mic' }));
        const activations = (): readonly boolean[] => readReanimatedFrameCallbacks()[0]?.setActiveCalls ?? [];
        // At rest the microphone is still art: it never registers as an energy consumer.
        expect(activations().includes(true)).toBe(false);

        update(scene({ pose: 'ready' }));
        expect(activations().at(-1)).toBe(true);

        update(scene({ pose: 'mic' }));
        expect(activations().at(-1)).toBe(false);
    });

    it('does not re-render when the composer around it does', () => {
        render(scene());
        const before = control().props;

        // The composer body re-renders on every keystroke; a leaf over primitives and one stable
        // handler must keep the same element (§16.2).
        update(scene());
        expect(control().props).toBe(before);
    });

    it('carries the caller’s label and hint, and routes the press out', async () => {
        render(scene());

        const target = control();
        expect(target.props.accessibilityLabel).toBe('End Voice');
        expect(target.props.accessibilityHint)
            .toBe('Ends the spoken conversation. Coding work already started keeps running.');

        await act(async () => {
            target.props.onClick?.({}) ?? target.props.onPress?.();
        });
        expect(onPress).toHaveBeenCalledTimes(1);
    });

    it.each(['release', 'jitter', 'drag', 'cancel', 'blur', 'background'] as const)('admits a held turn through the real input owner (%s)', async (outcome) => {
        const sent: unknown[] = [];
        let captureOpen = false;
        const adapter = createOpenAiRealtimeProtocolAdapter({
            prepare: async () => ({ kind: 'prepared', session: { config: {}, safeMetadata: null, inputCommitRequired: true } }),
        });
        const connection = createSdkHandleConnection({ driver: {
            open: async () => {}, close: async () => {}, sendControl: async (event) => { sent.push(event); },
        } });
        const controller = createVoiceConversationController({
            adapter: { ...adapter, id: 'composer-hold', turnControls: {
                cancelResponse: 'immediate', truncatePlayback: 'unsupported', clearInput: true,
                stopSession: true, resumption: 'none', replay: 'none', exactMessage: false,
            } }, createConnection: async () => connection,
            machine: { connecting() {}, connected() {}, ending() {}, disconnected() {}, failed() {} },
            isSelectionCurrent: () => true, onCanonicalEvent: async () => {},
            holdCapture: { async setOpen({ open }) { captureOpen = open === true; } },
        });
        expect(await controller.start({ controlSessionId: 'composer-hold' })).toEqual({ status: 'connected' });
        try {
            render(scene({ beginHoldToTalk: controller.beginHoldToTalk }));
            await act(async () => { control().props.onLongPress(); });
            expect(captureOpen).toBe(true);
            const gesture = tree!.root.findAll((node) => typeof node.type === 'string'
                && node.props.testID === 'session-composer-voice-gesture')[0]!;
            if (outcome === 'background') await act(async () => {
                update(scene({ beginHoldToTalk: controller.beginHoldToTalk, isActivelyFocused: false }));
            });
            await act(async () => {
                if (outcome === 'jitter') gesture.props.onTouchMove?.();
                if (outcome === 'drag') tree!.root.findByType(IconButton).props.onPressOut({ type: 'touchmove' });
                if (outcome === 'cancel') gesture.props.onTouchCancel();
                if (outcome === 'blur') tree!.root.findByType(IconButton).props.onFocusChange(false);
                gesture.props.onTouchEnd();
                gesture.props.onPointerUp();
            });
            expect(captureOpen).toBe(false);
            expect(sent).toEqual(outcome === 'release' || outcome === 'jitter' ? [
                { type: 'input_audio_buffer.clear' }, { type: 'input_audio_buffer.commit' }, { type: 'response.create' },
            ] : [{ type: 'input_audio_buffer.clear' }, { type: 'input_audio_buffer.clear' }]);
            expect(onPress).not.toHaveBeenCalled();
        } finally {
            await controller.stop();
        }
    });
});
