import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntityDropAdmissionV1, EntityDropOutcomeV1 } from '@happier-dev/protocol/plugins/ui';

import { renderScreen } from '@/dev/testkit';
import { setReducedMotionPreferenceOverride } from '@/hooks/ui/useReducedMotionPreference';
import { createEntityDragDropRuntime } from '../../entityDragDropRuntime';
import { EntityDragCarriedPreview } from '../../ui/EntityDragCarriedPreview';
import type { WindowBounds } from '../../treeDragDropTypes';
import { storage } from '@/sync/domains/state/storage';
import { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';

const motion = vi.hoisted(() => ({ springs: [] as number[], completions: [] as ((finished?: boolean) => void)[], shared: [] as { value: number }[] }));
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
    const base = createReanimatedModuleMock();
    return { ...base,
        useSharedValue: (initial: number) => {
            const value = base.useSharedValue(initial) as { value: number };
            if (!motion.shared.includes(value)) motion.shared.push(value);
            return value;
        },
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
    motion.shared.length = 0;
    setReducedMotionPreferenceOverride(null);
});

describe('EntityDragCarriedPreview refusal settlement', () => {
    it('shows the canonical Home disconnection without settling or replaying a pending drop', async () => {
        const previous = storage.getState();
        const applied = getAppliedActiveServerSnapshot();
        const available = isAppliedActiveServerRuntimeAvailable();
        const runtime = createEntityDragDropRuntime();
        const scope = { serverId: 'home-a', accountId: 'account-a' };
        let finish!: (outcome: EntityDropOutcomeV1) => void;
        runtime.registerSource({ id: 'source', scope, getItem: () => ({ kind: 'home-section', scope, sectionId: 'widgets' }),
            isCurrent: () => true, describe: () => ({ title: 'Widgets' }) });
        const execute = vi.fn(async () => new Promise<EntityDropOutcomeV1>(resolve => { finish = resolve; }));
        runtime.registerTarget({ id: 'target', scope, acceptedKinds: ['home-section'],
            getBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }), execute,
            resolve: () => ({ status: 'allowed', effect: { actionId: 'home.hub.layout.update', input: {}, preview: { verb: 'Move above', target: 'Sessions' } } }) });
        publishAppliedActiveServerSnapshot({ serverId: scope.serverId, serverUrl: 'https://home-a.test', generation: 1 });
        storage.setState({ endpointStatus: 'online', socketStatus: 'connected' });
        const screen = await renderScreen(<EntityDragCarriedPreview runtime={runtime} testID="pending-home-card" />);
        let result!: Promise<EntityDropOutcomeV1 | null>;
        try {
            await act(async () => { const carry = runtime.begin('source')!; carry.move({ x: 50, y: 50 }); result = carry.release(); });
            await act(async () => { storage.setState({ endpointStatus: 'offline' }); });
            expect(screen.getTextContent()).toContain("Can't reach this Home");
            expect(screen.findHostByTestId('pending-home-card')!.props.dataSet.outcome).toBe('quiet');
            expect(runtime.getSnapshot().phase).toBe('pending');
            await act(async () => { publishAppliedActiveServerSnapshot({ serverId: 'other-home', serverUrl: 'https://other-home.test', generation: 2 }); });
            // A write merely on its way is shown by its row, so the floating card is gone.
            expect(screen.findHostByTestId('pending-home-card')).toBeNull();
            await act(async () => { publishAppliedActiveServerSnapshot({ serverId: scope.serverId, serverUrl: 'https://home-a.test', generation: 3 }, false); });
            expect(screen.findHostByTestId('pending-home-card')).toBeNull();
            await act(async () => { publishAppliedActiveServerSnapshot({ serverId: scope.serverId, serverUrl: 'https://home-a.test', generation: 3 }); });
            expect(screen.findHostByTestId('pending-home-card')!.props.dataSet.outcome).toBe('quiet');
            await act(async () => { storage.setState({ endpointStatus: 'online' }); });
            expect(screen.findHostByTestId('pending-home-card')).toBeNull();
            await act(async () => { finish({ status: 'applied' }); await result; });
            expect(await result).toEqual({ status: 'applied' });
            expect(execute).toHaveBeenCalledTimes(1);
        } finally {
            await screen.unmount();
            storage.setState(previous, true);
            publishAppliedActiveServerSnapshot(applied, available);
        }
    });
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
        const admission: EntityDropAdmissionV1 = { status: 'allowed', effect: { actionId: 'session.manager.set', input: {}, preview: { verb: 'Put under', target: 'Lead' } } };
        const execute = vi.fn(async () => new Promise<EntityDropOutcomeV1>(resolve => { finish = resolve; }));
        runtime.registerTarget({ id: 'target', scope, acceptedKinds: ['session'],
            getBounds: () => ({ x: 200, y: 200, width: 100, height: 100 }), resolve: () => admission, execute });
        const screen = await renderScreen(<EntityDragCarriedPreview runtime={runtime} testID="carried-card" />);
        let carry!: NonNullable<ReturnType<typeof runtime.begin>>;
        let release!: Promise<EntityDropOutcomeV1 | null>;
        await act(async () => { carry = runtime.begin('source')!; carry.move({ x: 250, y: 250 }); release = carry.release(); });
        const position = screen.findAll(node => typeof node.type === 'string' && typeof node.props.onLayout === 'function')[0]!;
        await act(async () => { position.props.onLayout({ nativeEvent: { layout: { width: 260, height: 100 } } }); });
        // The card's place rides the first two shared values (x, y), written from the pointer channel.
        const positionStyle = { left: motion.shared[0]!.value, top: motion.shared[1]!.value };
        expect(screen.findHostByTestId('carried-card')).toBeNull();
        // Native source geometry can arrive after pickup; settlement must use its current origin.
        sourceBounds = { x: 10, y: 20, width: 300, height: 40 };
        await act(async () => { finish({ status: 'refused', reason: { code: 'manager_forbidden', message: 'Lead cannot take reports' } }); await release; });
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

describe('EntityDragCarriedPreview pointer frames', () => {
    it('moves the card without committing React while the place under the pointer is unchanged', async () => {
        const runtime = createEntityDragDropRuntime();
        const scope = { serverId: 'home-a', accountId: 'account-a' };
        runtime.registerSource({ id: 'source', scope,
            getItem: () => ({ kind: 'session' as const, scope, address: { serverId: scope.serverId, sessionId: 'child' } }),
            isCurrent: () => true, describe: () => ({ title: 'Child' }) });
        runtime.registerTarget({ id: 'target', scope, acceptedKinds: ['session'],
            getBounds: () => ({ x: 0, y: 0, width: 1000, height: 1000 }), execute: async () => ({ status: 'applied' }),
            resolve: () => ({ status: 'allowed', effect: { actionId: 'session.manager.set', input: {}, preview: { verb: 'Put under', target: 'Lead' } } }) });
        let commits = 0;
        const screen = await renderScreen(
            <React.Profiler id="preview" onRender={() => { commits += 1; }}>
                <EntityDragCarriedPreview runtime={runtime} testID="carried-card" />
            </React.Profiler>,
        );
        let carry!: NonNullable<ReturnType<typeof runtime.begin>>;
        await act(async () => { carry = runtime.begin('source')!; carry.move({ x: 100, y: 100 }); });
        const position = screen.findAll(node => typeof node.type === 'string' && typeof node.props.onLayout === 'function')[0]!;
        await act(async () => { position.props.onLayout({ nativeEvent: { layout: { width: 200, height: 60 } } }); });
        const before = commits;
        const x = motion.shared[0]!.value;
        for (let i = 1; i <= 20; i += 1) await act(async () => { carry.move({ x: 100 + i * 5, y: 100 + i }); });
        expect(commits - before).toBe(0);
        expect(motion.shared[0]!.value).toBe(x + 100);
        expect(motion.shared[1]!.value).toBe(100 + 20 + 18);
        await screen.unmount();
    });
});
