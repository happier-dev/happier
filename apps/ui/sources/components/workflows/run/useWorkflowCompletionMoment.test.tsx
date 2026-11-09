import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook, standardCleanup } from '@/dev/testkit';

import type { WorkflowRunStateV1 } from '@happier-dev/protocol/workflows';
import { setReducedMotionPreferenceOverride } from '@/hooks/ui/useReducedMotionPreference';

const haptics = vi.hoisted(() => ({ light: vi.fn(async () => {}) }));

// Completion's device feedback goes through the real platform/preference adapter.
vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
});
vi.mock('expo-haptics', async (importOriginal) => ({
    ...await importOriginal<typeof import('expo-haptics')>(),
    impactAsync: haptics.light,
}));
afterEach(async () => {
    haptics.light.mockClear();
    await standardCleanup();
    setReducedMotionPreferenceOverride(null);
});

type Props = Readonly<{ state: WorkflowRunStateV1 | null; observing?: boolean; identity?: string }>;

async function renderMoment(initialProps: Props) {
    const { useWorkflowCompletionMoment } = await import('./useWorkflowCompletionMoment');
    return renderHook(
        (props: Props) => useWorkflowCompletionMoment({
            state: props.state,
            observing: props.observing ?? true,
            identity: props.identity ?? 'run-a',
        }),
        { initialProps },
    );
}

describe('useWorkflowCompletionMoment', () => {
    it('celebrates the observed nonterminal to success transition once', async () => {
        const moment = await renderMoment({ state: 'running' });
        expect(moment.getCurrent()).toBe(false);
        expect(haptics.light).not.toHaveBeenCalled();

        expect(await moment.rerender({ state: 'succeeded' })).toBe(true);
        expect(haptics.light).toHaveBeenCalledTimes(1);

        // A refresh that reports the same authoritative terminal state is not a
        // second completion.
        await moment.rerender({ state: 'succeeded' });
        expect(haptics.light).toHaveBeenCalledTimes(1);
    });

    it('stays quiet when a finished Run is opened or remounted', async () => {
        const moment = await renderMoment({ state: 'succeeded' });

        expect(moment.getCurrent()).toBe(false);
        expect(haptics.light).not.toHaveBeenCalled();

        // Re-entry from another surface still reports the same terminal state.
        await moment.rerender({ state: 'succeeded' });
        expect(moment.getCurrent()).toBe(false);
        expect(haptics.light).not.toHaveBeenCalled();
    });

    it('does not celebrate a Run this instance is not watching', async () => {
        const moment = await renderMoment({ state: 'running', observing: false });

        expect(await moment.rerender({ state: 'succeeded', observing: false })).toBe(false);
        expect(haptics.light).not.toHaveBeenCalled();
    });

    it('does not celebrate a terminal state that is not success', async () => {
        const moment = await renderMoment({ state: 'running' });

        expect(await moment.rerender({ state: 'failed' })).toBe(false);
        expect(haptics.light).not.toHaveBeenCalled();
    });

    it('does not celebrate the next Run finishing before this instance watched it', async () => {
        // The detail screen stays mounted across a Run change: leaving Run A
        // while it runs and landing on an already-succeeded Run B is not a
        // completion this instance observed.
        const moment = await renderMoment({ state: 'running', identity: 'run-a' });

        expect(await moment.rerender({ state: 'succeeded', identity: 'run-b' })).toBe(false);
        expect(haptics.light).not.toHaveBeenCalled();

        // And Run B's own later completion still counts.
        await moment.rerender({ state: 'running', identity: 'run-b' });
        expect(await moment.rerender({ state: 'succeeded', identity: 'run-b' })).toBe(true);
        expect(haptics.light).toHaveBeenCalledTimes(1);
    });

    it('retires an active emphasis when the mounted screen changes Run identity', async () => {
        const moment = await renderMoment({ state: 'running', identity: 'run-a' });

        expect(await moment.rerender({ state: 'succeeded', identity: 'run-a' })).toBe(true);
        expect(await moment.rerender({ state: 'succeeded', identity: 'run-b' })).toBe(false);
    });

    it('retires an active emphasis when the Run is no longer being watched', async () => {
        const moment = await renderMoment({ state: 'running', identity: 'run-a' });

        expect(await moment.rerender({ state: 'succeeded', identity: 'run-a' })).toBe(true);
        expect(await moment.rerender({ state: 'succeeded', identity: 'run-a', observing: false })).toBe(false);
    });

    it('retires an active emphasis when reduced motion becomes effective', async () => {
        const moment = await renderMoment({ state: 'running', identity: 'run-a' });

        expect(await moment.rerender({ state: 'succeeded', identity: 'run-a' })).toBe(true);
        await act(async () => { setReducedMotionPreferenceOverride(true); });
        expect(await moment.rerender({ state: 'succeeded', identity: 'run-a' })).toBe(false);
    });

    it('applies the final state with no emphasis travel under reduced motion', async () => {
        setReducedMotionPreferenceOverride(true);
        const moment = await renderMoment({ state: 'running' });

        expect(await moment.rerender({ state: 'succeeded' })).toBe(false);
        // The authoritative status change is the same-frame visual twin, so the
        // haptic is still paired with something the user can see.
        expect(haptics.light).toHaveBeenCalledTimes(1);
    });
});
