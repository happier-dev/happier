import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, type RenderScreenResult } from '@/dev/testkit';
import { readReanimatedFrameCallbacks, resetReanimatedFrameCallbacks } from '@/dev/testkit/mocks/reanimated';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { createNearViewportTracker, useIsNearViewport, type NearViewportTracker } from '@/components/widgets/nearViewport';
import { VoiceEnergyProvider } from '@/components/voice/light/useVoiceEnergy';
import { voiceRuntimeLevelStore, type VoiceRuntimeLevelWriter } from '@/voice/runtime/levels/voiceRuntimeLevelStore';
import { VoiceMarkArt } from './VoiceMark';
import { VoiceStatusCell } from './VoiceStatusCell';

const host = vi.hoisted(() => ({ viewed: true, reduced: false, repeats: 0, cancels: 0, timings: 0 }));
// Reanimated is the native animation boundary; preserve the shared-value/frame testkit beneath it.
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    const mock = createReanimatedModuleMock({ reactiveDerivedValues: true });
    return {
        ...mock,
        withRepeat: <T,>(value: T) => { host.repeats += 1; return value; },
        cancelAnimation: () => { host.cancels += 1; },
        withTiming: (...args: Parameters<typeof mock.withTiming>) => { host.timings += 1; return mock.withTiming(...args); },
    };
});
vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({ useReducedMotionPreference: () => host.reduced }));
vi.mock('@/utils/runtime/useHostActivelyViewed', () => ({
    useHostActivelyViewed: () => host.viewed,
    useHostActivelyFocused: () => host.viewed,
}));

let screen: RenderScreenResult | null = null;
let input: VoiceRuntimeLevelWriter | null = null;
beforeEach(() => {
    host.viewed = true;
    host.reduced = false;
    host.repeats = 0;
    host.cancels = 0;
    host.timings = 0;
    resetReanimatedFrameCallbacks();
});
afterEach(async () => {
    act(() => { input?.close(); });
    input = null;
    await screen?.unmount();
    screen = null;
});

function scene(presented: boolean, otherVisible = false) {
    return <VoiceEnergyProvider
        state={{ luminosity: 0.62, energized: true, direction: 'inward' }}
        activation={{ providerReady: true, attemptActive: true, micCaptureActive: true }}
    >
        <PluginSurfaceFocusEligibilityProvider active={presented} presentationActive={presented}>
            <VoiceMarkArt pose="ready" size={24} testID="retained-mark" />
            <VoiceStatusCell kind="working" testID="retained-status" />
        </PluginSurfaceFocusEligibilityProvider>
        {otherVisible ? <VoiceMarkArt pose="ready" size={24} /> : null}
    </VoiceEnergyProvider>;
}

const SECTION_SPAN = Object.freeze({ top: 0, height: 200 });
function ViewportScene(props: Readonly<{ tracker: NearViewportTracker; onRender: () => void }>) {
    const near = useIsNearViewport(props.tracker, SECTION_SPAN);
    props.onRender();
    return scene(near);
}

describe('Voice retained presentation demand', () => {
    it('settles hidden morph and pose changes without clocks or replay on return', async () => {
        const mark = (presented: boolean, pose: React.ComponentProps<typeof VoiceMarkArt>['pose']) => (
            <PluginSurfaceFocusEligibilityProvider active={presented} presentationActive={presented}>
                <VoiceMarkArt pose={pose} size={24} />
            </PluginSurfaceFocusEligibilityProvider>
        );
        screen = await renderScreen(mark(false, 'mic'));
        await screen.update(mark(false, 'shadow'));
        await screen.update(mark(false, 'ready'));
        expect(host.timings).toBe(0);
        await screen.update(mark(true, 'ready'));
        expect(host.timings).toBe(0);
        await screen.update(mark(true, 'mic'));
        expect(host.timings).toBe(1);
        host.viewed = false;
        await screen.update(mark(true, 'shadow'));
        expect(host.timings).toBe(1);
        host.viewed = true;
        await screen.update(mark(true, 'shadow'));
        expect(host.timings).toBe(1);
    });
    it('pauses demand at the measured scroll window without recomputing for scrolls that stay visible', async () => {
        const tracker = createNearViewportTracker({ quantum: 1, initialViewportHeight: 800, overscan: false });
        const onRender = vi.fn();
        input = voiceRuntimeLevelStore.open({ channel: 'input', sourceId: 'scroll-presentation' });
        screen = await renderScreen(<ViewportScene tracker={tracker} onRender={onRender} />);
        act(() => { for (let i = 0; i < 24; i += 1) input!.write(1); });
        const frame = readReanimatedFrameCallbacks()[0]!;
        const mark = screen.findByTestId('retained-mark');
        const visibleRenders = onRender.mock.calls.length;
        act(() => { tracker.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 100 } } } as never); });
        expect(onRender.mock.calls.length).toBe(visibleRenders);
        expect(frame.handle.isActive).toBe(true);
        act(() => { tracker.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 201 } } } as never); });
        expect(frame.handle.isActive).toBe(false);
        expect(onRender.mock.calls.length).toBe(visibleRenders + 1);
        expect(voiceRuntimeLevelStore.getSnapshot().inputSourceActive).toBe(true);
        expect(screen.findByTestId('retained-mark')).toBe(mark);
        act(() => { tracker.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 0 } } } as never); });
        expect(frame.handle.isActive).toBe(true);
        expect(onRender.mock.calls.length).toBe(visibleRenders + 2);
        expect(screen.findByTestId('retained-mark')).toBe(mark);
    });
    it('cancels a mounted status repeat when its layout owner hides it', async () => {
        screen = await renderScreen(scene(true));
        expect(host.repeats).toBe(1);
        const cancellations = host.cancels;
        await screen.update(scene(false));
        expect(host.cancels).toBeGreaterThan(cancellations);
        await screen.update(scene(true));
        expect(host.repeats).toBe(2);
    });
    it('releases real-energy demand and status repeats while hidden, then resumes the same mounted pose', async () => {
        input = voiceRuntimeLevelStore.open({ channel: 'input', sourceId: 'retained-presentation' });
        screen = await renderScreen(scene(true));
        act(() => { for (let i = 0; i < 24; i += 1) input!.write(1); });
        const frame = readReanimatedFrameCallbacks()[0]!;
        expect(frame.handle.isActive).toBe(true);
        expect(host.repeats).toBe(1);
        const mark = screen.findByTestId('retained-mark');
        const cancels = host.cancels;

        await screen.update(scene(false));
        expect(frame.handle.isActive).toBe(false);
        expect(host.cancels).toBeGreaterThan(cancels);
        expect(host.repeats).toBe(1);
        expect(voiceRuntimeLevelStore.getSnapshot().inputSourceActive).toBe(true);
        expect(voiceRuntimeLevelStore.getSnapshot().inputLevel).toBeGreaterThan(0.99);
        expect(screen.findByTestId('retained-mark')).toBe(mark);

        await screen.update(scene(true));
        expect(frame.handle.isActive).toBe(true);
        expect(host.repeats).toBe(2);
        expect(screen.findByTestId('retained-mark')).toBe(mark);

        act(() => { input!.reset(); });
        for (let i = 1; i <= 180; i += 1) {
            act(() => frame.run({ timestamp: i * 1000 / 60, timeSincePreviousFrame: 1000 / 60, timeSinceFirstFrame: i * 1000 / 60 }));
        }
        expect(frame.handle.isActive).toBe(false);
    });

    it('also suppresses presentation in the background and with reduced motion', async () => {
        host.viewed = false;
        screen = await renderScreen(scene(true));
        expect(readReanimatedFrameCallbacks()[0]!.handle.isActive).toBe(false);
        expect(host.repeats).toBe(0);
        host.viewed = true;
        host.reduced = true;
        await screen.update(scene(true));
        expect(readReanimatedFrameCallbacks()[0]!.handle.isActive).toBe(false);
        expect(host.repeats).toBe(0);
    });

    it('keeps the shared energy owner running for another visible mark', async () => {
        input = voiceRuntimeLevelStore.open({ channel: 'input', sourceId: 'other-visible-presentation' });
        screen = await renderScreen(scene(true, true));
        act(() => { for (let i = 0; i < 24; i += 1) input!.write(1); });
        const frame = readReanimatedFrameCallbacks()[0]!;
        await screen.update(scene(false, true));
        expect(frame.handle.isActive).toBe(true);
        await screen.update(scene(false, false));
        expect(frame.handle.isActive).toBe(false);
    });
});
