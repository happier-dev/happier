import * as React from 'react';
import { drawPlanetMarkFrame } from '@happier-dev/brand/planet';
import { act } from 'react-test-renderer';
import { useUnistyles } from 'react-native-unistyles';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, type RenderScreenResult } from '@/dev/testkit';
import { setReducedMotionPreferenceOverride } from '@/hooks/ui/useReducedMotionPreference';
import type { VoiceMarkCanvasProps } from './voiceMarkCanvasTypes';
import { VoiceMarkArt } from './VoiceMark';

const motion = vi.hoisted(() => ({
    onPoseStart: null as (() => void) | null,
    morphs: [] as number[],
}));
// The native animation boundary remains pending so the test can admit an interrupted frame.
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
            if (config?.duration === 550) motion.morphs.push(target);
            if (config?.duration !== 900) return target;
            motion.onPoseStart?.();
            return 0;
        },
    };
});

let screen: RenderScreenResult | null = null;
afterEach(async () => {
    await screen?.unmount();
    screen = null;
    setReducedMotionPreferenceOverride(null);
    motion.onPoseStart = null;
    motion.morphs = [];
});

function setReduced(reduced: boolean): void {
    act(() => {
        setReducedMotionPreferenceOverride(reduced);
    });
}

function canvas(): VoiceMarkCanvasProps {
    const props = screen!.find((node) => node.props?.to?.planetA !== undefined && node.props?.from?.planetA !== undefined).props;
    return {
        to: props.to,
        from: props.from,
        morph: props.morph,
        pose: props.pose,
        energy: props.energy,
        flow: props.flow,
    };
}

function frame(props = canvas()): number[][] {
    const dots: number[][] = [];
    drawPlanetMarkFrame(props.to, props.from, props.morph.value, props.pose.value, 0, 0, (...dot) => dots.push(dot));
    return dots;
}

function expectSameFrame(actual: number[][], expected: number[][]): void {
    expect(actual).toHaveLength(expected.length);
    actual.forEach((dot, i) => dot.forEach((value, channel) => expect(value).toBeCloseTo(expected[i]![channel]!, 12)));
}

describe('VoiceMark interrupted pose', () => {
    it('rests as the line waveform glyph in the composer icon tint, drawing no dots', async () => {
        let tint: string | null = null;
        function ComposerTint() {
            tint = useUnistyles().theme.colors.button.secondary.tint;
            return null;
        }
        screen = await renderScreen(<><ComposerTint /><VoiceMarkArt pose="mic" size={26} testID="mark" /></>);
        const glyph = screen.find((node) => node.props?.name === 'waveform');
        expect(glyph.props.color).toBe(tint);
        expect(glyph.props.size).toBe(16);
        expect(screen.findByTestId('mark-rest')?.props.style).toMatchObject({ opacity: 1 });
        expect(frame().filter((dot) => dot[6]! > 0)).toEqual([]);
    });

    it('morphs the glyph into the planet on start and back on End, and switches instantly under reduced motion', async () => {
        screen = await renderScreen(<VoiceMarkArt pose="mic" size={26} testID="mark" />);
        await screen.update(<VoiceMarkArt pose="ready" size={26} testID="mark" />);
        expect(motion.morphs).toEqual([1]);
        expect(screen.findByTestId('mark-rest')?.props.style).toMatchObject({ opacity: 0 });
        expect(frame().length).toBeGreaterThan(0);
        // Mid-way the glyph has handed over: the dots stream out of where it stood.
        act(() => { canvas().morph.value = 0.5; });
        expect(frame().length).toBeGreaterThan(0);
        await screen.update(<VoiceMarkArt pose="mic" size={26} testID="mark" />);
        expect(motion.morphs).toEqual([1, 0]);
        expect(screen.findByTestId('mark-rest')?.props.style).toMatchObject({ opacity: 1 });
        expect(frame().filter((dot) => dot[6]! > 0)).toEqual([]);

        setReduced(true);
        await screen.update(<VoiceMarkArt pose="ready" size={26} testID="mark" />);
        expect(motion.morphs).toEqual([1, 0]);
        expect(canvas().morph.value).toBe(1);
        expect(screen.findByTestId('mark-rest')?.props.style).toMatchObject({ opacity: 0 });
    });

    it('retargets consecutive planet poses from the displayed Brand frame', async () => {
        screen = await renderScreen(<VoiceMarkArt pose="shadow" size={24} still />);
        const shadow = frame();
        await screen.update(<VoiceMarkArt pose="ready" size={24} still />);
        act(() => { canvas().pose.value = 0.37; });
        const interrupted = frame();
        expect(interrupted).not.toEqual(shadow);

        const starts: number[][][] = [];
        motion.onPoseStart = () => starts.push(frame());
        await screen.update(<VoiceMarkArt pose="shade" size={24} still />);
        expectSameFrame(starts[0]!, interrupted);
        expectSameFrame(frame(), interrupted);
        act(() => { canvas().pose.value = 0.42; });
        const interruptedAgain = frame();
        expect(interruptedAgain).not.toEqual(interrupted);
        await screen.update(<VoiceMarkArt pose="shadow" size={24} still />);
        expectSameFrame(frame(), interruptedAgain);
    });

    it('snaps an interrupted transition to the semantic pose under reduced motion', async () => {
        screen = await renderScreen(<VoiceMarkArt pose="shadow" size={24} still />);
        await screen.update(<VoiceMarkArt pose="ready" size={24} still />);
        act(() => { canvas().pose.value = 0.37; });
        const interrupted = frame();
        setReduced(true);
        await screen.update(<VoiceMarkArt pose="ready" size={24} still />);
        expect(canvas().pose.value).toBe(1);
        setReduced(false);
        await screen.update(<VoiceMarkArt pose="ready" size={24} still />);
        expect(canvas().pose.value).toBe(1);
        setReduced(true);
        await screen.update(<VoiceMarkArt pose="shade" size={24} still />);
        expect(canvas().pose.value).toBe(1);
        const snapped = frame();
        expect(snapped).not.toEqual(interrupted);
        await screen.unmount();
        screen = await renderScreen(<VoiceMarkArt pose="shade" size={24} still />);
        expectSameFrame(frame(), snapped);
    });
});
