import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { invokeTestInstanceHandler, renderScreen } from '@/dev/testkit';
import type { TestGestureChain } from '@/dev/testkit/mocks/gestureHandler';
import { CompanionNoDragRegion, CompanionNoDragRegionProvider } from '@/components/companion/interaction/CompanionNoDragRegion';
import { resolveVoiceAttemptControl } from '@/components/voice/attempt/resolveVoiceAttemptControl';
import type { VoiceAttemptControlProjection } from '@/components/voice/attempt/useVoiceAttemptControl';

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
});
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return {
        ...createReanimatedModuleMock(),
        // The native layout boundary supplies a screen rectangle different from local onLayout.
        measure: () => ({ pageX: 500, pageY: 600, x: 10, y: 5, width: 100, height: 48 }),
    };
});

import { VoicePresenceFloat } from './VoicePresenceFloat';
import { VoiceTransport } from './VoiceTransport';
import { VoiceOrb } from './VoiceOrb';
import { resolveVoiceOrbContainerWidth, VOICE_ORB_BODY_SIZE } from './voicePresenceAnatomy';

function attempt(reconnecting = false): VoiceAttemptControlProjection {
    const state = reconnecting ? 'reconnecting' : 'listening';
    return {
        ...resolveVoiceAttemptControl({ surfaceState: state, tone: 'active', status: 'connected',
            sessionId: 'voice-1', canStop: true, muted: false, capturing: true, startAdmitted: true,
            hasRecovery: reconnecting }),
        statusWord: state, statusLabel: state, elapsedStartedAt: null, canHoldToTalk: false,
        beginHoldToTalk: () => null,
        primaryActionLabel: 'End Voice', primaryActionHint: null, recoveryLabel: reconnecting ? 'Retry' : null, recoveryShortLabel: reconnecting ? 'Retry' : null,
        micStateLabel: '', captionLabel: '', openConversationSessionId: null,
        openConversationSessionAddress: null, canOpenConversation: false,
        onPrimaryAction: vi.fn(), onToggle: vi.fn(), onToggleMute: vi.fn(), onRecover: vi.fn(), onOpenConversation: vi.fn(),
    };
}

describe('VoicePresenceFloat native drag boundary', () => {
    it('keeps the Orb mark at its logical dock while enclosing the native options hit area', async () => {
        const width = resolveVoiceOrbContainerWidth('ios', true);
        const padding = (width - VOICE_ORB_BODY_SIZE) / 2;
        let logicalX = () => 0;
        const screen = await renderScreen(<VoicePresenceFloat width={VOICE_ORB_BODY_SIZE} height={VOICE_ORB_BODY_SIZE}
            interactionPaddingHorizontal={padding} restingBottomInset={60} edgeInset={14} minimumTop={60} testID="native-orb-float">
            {(render) => {
                logicalX = () => render.translateX.get();
                return <VoiceOrb voice={attempt()} anchorRef={React.createRef()} sectionOpen={false} onOpenSection={() => {}}
                    shouldSuppressPress={render.shouldSuppressPress} translateX={render.translateX} hostWidth={render.hostWidth} />;
            }}
        </VoicePresenceFloat>);
        const flatten = (style: unknown) => Object.assign({}, ...(Array.isArray(style) ? style.flat(Infinity) : [style]).filter(Boolean));
        const visualMarkX = () => {
            const float = flatten(screen.findByTestId('voice-presence-float-body')!.props.style[0]);
            const orb = flatten(screen.findByTestId('voice-orb')!.props.style);
            const offset = orb.alignItems === 'flex-end' ? orb.width - VOICE_ORB_BODY_SIZE : (orb.width - VOICE_ORB_BODY_SIZE) / 2;
            return logicalX() + float.left + offset;
        };
        try {
            await act(async () => { screen.findByTestId('native-orb-float')!.props.onLayout({ nativeEvent: { layout: { width: 390, height: 844 } } }); });
            const frame = screen.findByTestId('voice-presence-float-body')!.props.style[0];
            await act(async () => { screen.findByTestId('voice-presence-float-body')!.props.onLayout({ nativeEvent: { layout: { width: frame.width, height: frame.height } } }); });
            expect(visualMarkX()).toBe(390 - 14 - VOICE_ORB_BODY_SIZE);
            const gesture = screen.tree.root.findByType('GestureDetector').props.gesture as TestGestureChain;
            await act(async () => { gesture.__handlers.onBegin({ absoluteX: 350, absoluteY: 730 }); });
            await act(async () => { gesture.__handlers.onUpdate({ translationX: -1000, translationY: 0 }); });
            expect(visualMarkX()).toBe(14);
            expect(frame.width).toBeGreaterThan(VOICE_ORB_BODY_SIZE);
        } finally { await screen.unmount(); }
    });

    it('keeps the float content and transport off React during body motion, and excludes each transport action', async () => {
        let contentRenders = 0;
        let transportCommits = 0;
        let suppressPress = () => false;
        const voice = attempt();
        const element = (control: VoiceAttemptControlProjection) => (
            <CompanionNoDragRegionProvider>
                <VoicePresenceFloat width={330} height={56} restingBottomInset={60} edgeInset={14} minimumTop={60} testID="float">
                    {(render) => {
                        contentRenders++;
                        suppressPress = render.shouldSuppressPress;
                        return <CompanionNoDragRegion testID="transport-exclusion">
                            <React.Profiler id="transport" onRender={() => { transportCommits++; }}>
                                <VoiceTransport voice={control} size="island" />
                            </React.Profiler>
                        </CompanionNoDragRegion>;
                    }}
                </VoicePresenceFloat>
            </CompanionNoDragRegionProvider>
        );
        const screen = await renderScreen(element(voice));
        await act(async () => {
            invokeTestInstanceHandler(screen.findByTestId('float'), 'onLayout', {
                nativeEvent: { layout: { x: 0, y: 0, width: 900, height: 900 } },
            });
        });
        await act(async () => {
            invokeTestInstanceHandler(screen.findByTestId('transport-exclusion'), 'onLayout', {
                nativeEvent: { layout: { x: 10, y: 5, width: 100, height: 48 } },
            });
        });
        const gesture = () => screen.tree.root.findByType('GestureDetector').props.gesture as TestGestureChain;
        const contentBefore = contentRenders;
        const transportBefore = transportCommits;
        await act(async () => { gesture().__handlers.onBegin({ absoluteX: 300, absoluteY: 300 }); });
        for (let step = 1; step <= 20; step++) {
            await act(async () => { gesture().__handlers.onUpdate({ translationX: -step, translationY: -step }); });
        }
        expect(contentRenders).toBe(contentBefore);
        expect(transportCommits).toBe(transportBefore);
        await act(async () => {
            gesture().__handlers.onEnd({ translationX: -20, translationY: -20, velocityX: 0, velocityY: 0 });
            gesture().__handlers.onFinalize();
        });
        expect(suppressPress()).toBe(true);
        expect(suppressPress()).toBe(false);

        for (const target of ['mute', 'end', 'recover'] as const) {
            const control = target === 'recover' ? attempt(true) : voice;
            if (target === 'recover') await screen.update(element(control));
            const fail = vi.fn();
            await act(async () => {
                gesture().__handlers.onTouchesDown({ allTouches: [{ x: 12, y: 8, absoluteX: 520, absoluteY: 620 }] }, { fail });
                gesture().__handlers.onBegin({ x: 12, y: 8, absoluteX: 520, absoluteY: 620 });
                gesture().__handlers.onUpdate({ translationX: 80, translationY: 60 });
                gesture().__handlers.onEnd({ translationX: 80, translationY: 60 });
            });
            expect(fail).toHaveBeenCalledOnce();
            expect(suppressPress()).toBe(false);
            screen.pressByTestId(`voice-transport-${target}`);
            expect(target === 'mute' ? control.onToggleMute : target === 'end' ? control.onToggle : control.onRecover).toHaveBeenCalledOnce();
        }
        await screen.unmount();
    });
});
