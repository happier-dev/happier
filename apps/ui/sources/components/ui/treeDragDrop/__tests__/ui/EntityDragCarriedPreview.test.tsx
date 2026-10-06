import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntityDropAdmissionV1, EntityDropOutcomeV1 } from '@happier-dev/protocol/plugins/ui';

import { renderScreen } from '@/dev/testkit';
import { setReducedMotionPreferenceOverride } from '@/hooks/ui/useReducedMotionPreference';
import { createEntityDragDropRuntime } from '../../entityDragDropRuntime';
import { EntityDragCarriedPreview } from '../../ui/EntityDragCarriedPreview';
import type { WindowBounds } from '../../treeDragDropTypes';

const motion = vi.hoisted(() => ({ springs: [] as number[], completions: [] as ((finished?: boolean) => void)[] }));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return { ...createReanimatedModuleMock(),
        withSpring: (value: number, _config: unknown, completion?: (finished?: boolean) => void) => {
            motion.springs.push(value);
            if (completion) motion.completions.push(completion);
            return value;
        },
        withTiming: (value: number, _config: unknown, completion?: (finished?: boolean) => void) => {
            if (completion) motion.completions.push(completion);
            return value;
        },
    };
});
vi.mock('react-native-worklets', () => ({
    scheduleOnRN: (callback: (...args: unknown[]) => void, ...args: unknown[]) => callback(...args),
}));

afterEach(() => {
    motion.springs.length = 0;
    motion.completions.length = 0;
    setReducedMotionPreferenceOverride(null);
});

describe('EntityDragCarriedPreview refusal settlement', () => {
    it.each(['spring', 'reduced', 'interrupted'] as const)('keeps the owner reason through %s return feedback', async (mode) => {
        const reducedMotion = mode === 'reduced';
        setReducedMotionPreferenceOverride(reducedMotion);
        const runtime = createEntityDragDropRuntime();
        const scope = { serverId: 'home-a', accountId: 'account-a' };
        let finish = (_outcome: EntityDropOutcomeV1) => {};
        let sourceBounds: WindowBounds | null = null;
        const source = { id: 'source', scope,
            getItem: () => ({ kind: 'session' as const, scope, address: { serverId: scope.serverId, sessionId: 'child' } }),
            isCurrent: () => true, describe: () => ({ title: 'Child' }),
            getBounds: () => sourceBounds,
        };
        const retireSource = runtime.registerSource(source);
        const unsubscribe = runtime.subscribe(() => { if (runtime.getSnapshot().phase === 'settled') retireSource(); });
        const admission: EntityDropAdmissionV1 = { status: 'allowed', effect: { actionId: 'session.reports_to.set', input: {}, preview: { verb: 'Put under', target: 'Lead' } } };
        const execute = vi.fn(async () => new Promise<EntityDropOutcomeV1>(resolve => { finish = resolve; }));
        runtime.registerTarget({ id: 'target', scope, acceptedKinds: ['session'],
            getBounds: () => ({ x: 200, y: 200, width: 100, height: 100 }), resolve: () => admission, execute });
        const screen = await renderScreen(<EntityDragCarriedPreview runtime={runtime} testID="carried-card" />);
        let carry!: NonNullable<ReturnType<typeof runtime.begin>>;
        let release!: Promise<EntityDropOutcomeV1 | null>;
        await act(async () => { carry = runtime.begin('source')!; carry.move({ x: 250, y: 250 }); release = carry.release(); });
        const position = screen.findAll(node => typeof node.type === 'string' && typeof node.props.onLayout === 'function')[0]!;
        await act(async () => { position.props.onLayout({ nativeEvent: { layout: { width: 260, height: 100 } } }); });
        const positionStyle = position.props.style[0] as { left: number; top: number };
        expect(screen.findHostByTestId('carried-card')?.props.dataSet.outcome).toBe('pending');
        // Native source geometry can arrive after pickup; settlement must use its current origin.
        sourceBounds = { x: 10, y: 20, width: 300, height: 40 };
        await act(async () => { finish({ status: 'refused', reason: { code: 'reports_to_forbidden', message: 'Lead cannot take reports' } }); await release; });
        const card = screen.findHostByTestId('carried-card');
        expect(card).not.toBeNull();
        expect(card?.props.dataSet.outcome).toBe('refused');
        expect(card?.findAll(node => node.props.children === 'Lead cannot take reports').length).toBeGreaterThan(0);
        expect(motion.springs.length > 0).toBe(!reducedMotion);
        if (!reducedMotion) expect(motion.springs.slice(-2)).toEqual([10 - positionStyle.left, 20 - positionStyle.top]);
        expect(await carry.release()).toBeNull();
        expect(execute).toHaveBeenCalledTimes(1);
        const completions = motion.completions.splice(0);
        if (mode === 'interrupted') {
            await act(async () => {
                runtime.registerSource(source);
                carry = runtime.begin('source')!;
                carry.move({ x: 250, y: 250 });
            });
        }
        await act(async () => { for (const complete of completions) complete(true); });
        expect(runtime.getSnapshot().phase).toBe(mode === 'interrupted' ? 'carrying' : 'idle');
        if (mode === 'interrupted') {
            expect(screen.findHostByTestId('carried-card')?.props.dataSet.outcome).toBe('allowed');
            await act(async () => { runtime.cancel(); });
        } else expect(screen.findHostByTestId('carried-card')).toBeNull();
        unsubscribe();
        await screen.unmount();
    });
});
