import * as React from 'react';
import { drawPlanetMarkFrame } from '@happier-dev/brand/planet';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, type RenderScreenResult } from '@/dev/testkit';
import { setReducedMotionPreferenceOverride } from '@/hooks/ui/useReducedMotionPreference';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import type { VoiceSessionEndedAttempt } from '@/voice/session/voiceSessionStore';
import type { VoiceMarkCanvasProps } from './voiceMarkCanvasTypes';
import { VoiceMarkArt } from './VoiceMark';
import { resolveVoiceMarkEvent, type VoiceMarkEvent } from './resolveVoiceMarkPose';

/*
 * Reanimated is the native animation boundary. A one-shot event timing (the lab's 1.2 s) is held at
 * its first frame so the test reads what the event starts from; every other timing lands at once.
 */
const motion = vi.hoisted(() => ({ events: [] as number[] }));
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return {
        ...createReanimatedModuleMock(),
        // A worklet style is re-evaluated on the UI thread whenever its shared values change.
        useAnimatedStyle: <T extends object>(factory: () => T): T => {
            const style = {} as T;
            for (const key of Object.keys(factory())) Object.defineProperty(style, key, { enumerable: true, get: () => factory()[key as keyof T] });
            return style;
        },
        withTiming: (target: number, config?: { duration?: number }) => {
            if (config?.duration !== 1200) return target;
            motion.events.push(target);
            return target === 0 ? 1 : 0;
        },
    };
});

let screen: RenderScreenResult | null = null;
afterEach(async () => {
    await screen?.unmount();
    screen = null;
    setReducedMotionPreferenceOverride(null);
    motion.events = [];
});

type Dot = readonly number[];

function canvas(): VoiceMarkCanvasProps {
    return screen!.find((node) => node.props?.to?.planetA !== undefined && node.props?.from?.planetA !== undefined).props;
}

function frame(props = canvas()): Dot[] {
    const dots: Dot[] = [];
    drawPlanetMarkFrame(props.to, props.from, props.morph.value, props.pose.value, 0, 0, (...dot) => dots.push(dot),
        props.gather?.value ?? 0, props.leave?.value ?? 0);
    return dots;
}

function microphone(props = canvas()): Dot[] {
    const dots: Dot[] = [];
    drawPlanetMarkFrame(props.to, props.to, 0, 1, 0, 0, (...dot) => dots.push(dot));
    return dots;
}

const ink = (dots: readonly Dot[]) => dots.reduce((total, dot) => total + dot[6]!, 0);
const gather: VoiceMarkEvent = { kind: 'gather', id: 'first-success' };
const leave: VoiceMarkEvent = { kind: 'leave', id: 'voice-attempt:1:leave' };

describe('VoiceMark one-shot events', () => {
    it('gathers once when a real event arrives: dispersed dots come home to the settled planet', async () => {
        screen = await renderScreen(<VoiceMarkArt pose="ready" size={48} still />);
        const settled = frame();
        await screen.update(<VoiceMarkArt pose="ready" size={48} still event={gather} />);
        expect(motion.events).toEqual([0]);
        expect(ink(frame())).toBeLessThan(ink(settled) * 0.6);
        act(() => { canvas().gather.value = 0; });
        expect(frame()).toEqual(settled);
        // Re-rendering the same fact (or anything else) never replays it.
        await screen.update(<VoiceMarkArt pose="ready" size={48} still event={{ ...gather }} />);
        await screen.update(<VoiceMarkArt pose="shadow" size={48} still event={gather} />);
        expect(motion.events).toEqual([0]);
    });

    it('treats an event already present when the mark mounts as history', async () => {
        screen = await renderScreen(<VoiceMarkArt pose="ready" size={48} still />);
        const settled = frame();
        await screen.unmount();
        screen = await renderScreen(<VoiceMarkArt pose="ready" size={48} still event={gather} />);
        expect(motion.events).toEqual([]);
        expect(frame()).toEqual(settled);
    });

    it('lands instantly under reduced motion and while the mark is not presented, with no clock', async () => {
        setReducedMotionPreferenceOverride(true);
        screen = await renderScreen(<VoiceMarkArt pose="ready" size={48} still />);
        const settled = frame();
        await screen.update(<VoiceMarkArt pose="ready" size={48} still event={gather} />);
        expect(motion.events).toEqual([]);
        expect(frame()).toEqual(settled);
        await screen.unmount();
        setReducedMotionPreferenceOverride(false);
        const hidden = (event: VoiceMarkEvent | null) => (
            <PluginSurfaceFocusEligibilityProvider active={false} presentationActive={false}>
                <VoiceMarkArt pose="ready" size={48} still event={event} />
            </PluginSurfaceFocusEligibilityProvider>
        );
        screen = await renderScreen(hidden(null));
        await screen.update(hidden(gather));
        expect(motion.events).toEqual([]);
        expect(frame()).toEqual(settled);
    });

    it('a continuation hands the planet off instead of regathering, and lands on the rest microphone', async () => {
        screen = await renderScreen(<VoiceMarkArt pose="ready" size={24} testID="mark" />);
        const planet = frame();
        await screen.update(<VoiceMarkArt pose="mic" size={24} event={leave} testID="mark" />);
        // The leave starts from the planet that was on screen; the ordinary 0.55 s regather does not run.
        expect(motion.events).toEqual([1]);
        expect(frame()).toEqual(planet);
        expect(screen.findByTestId('mark-rest')?.props.style).toMatchObject({ opacity: 0 });
        act(() => { canvas().leave.value = 1; });
        // It lands on the rest glyph: no dots left, the waveform shown.
        expect(frame()).toEqual(microphone());
        expect(frame().filter((dot) => dot[6]! > 0)).toEqual([]);
        await screen.update(<VoiceMarkArt pose="mic" size={24} event={leave} testID="mark" />);
        expect(screen.findByTestId('mark-rest')?.props.style).toMatchObject({ opacity: 1 });
        expect(motion.events).toEqual([1]);
    });
});

describe('resolveVoiceMarkEvent', () => {
    const ended = (reason: VoiceSessionEndedAttempt['reason']): VoiceSessionEndedAttempt => ({
        attemptId: 'voice-attempt:4', sessionId: 'control', adapterId: 'service', startedAt: 1, endedAt: 2, reason,
        conversationSessionAddress: null, targetSessionAddress: null, transcriptMode: null, accountScope: null, conversationScope: null,
    });
    const conversation = { serverId: 'home', sessionId: 'conversation' };

    it('leaves only for an attempt this device let go to another device, and gathers for an arrival', () => {
        expect(resolveVoiceMarkEvent({ ended: ended({ kind: 'continued_elsewhere', continuation: { v: 1, deviceId: 'phone', conversation } }), arrivedAttemptId: null }))
            .toEqual({ kind: 'leave', id: 'voice-attempt:4:leave' });
        expect(resolveVoiceMarkEvent({ ended: ended({ kind: 'stopped' }), arrivedAttemptId: null })).toBeNull();
        expect(resolveVoiceMarkEvent({ ended: null, arrivedAttemptId: 'voice-attempt:5' })).toEqual({ kind: 'gather', id: 'voice-attempt:5:arrive' });
        expect(resolveVoiceMarkEvent({ ended: null, arrivedAttemptId: null })).toBeNull();
    });
});
