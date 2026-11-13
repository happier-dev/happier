import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, createSessionFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { storage } from '@/sync/domains/state/storageStore';
import * as machineTargets from '@/sync/domains/session/resolveMachineTargetForSessionFromState';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';

import {
    MachineWorkingCountsProvider,
    useMachineWorkingCount,
    useMachineWorkingTotal,
} from './machineWorkingCounts';

// Only native platform boundaries are substituted; Activity, storage and presentation stay real.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

const NOW_MS = 1_700_000_000_000;
const initialState = storage.getState();
const renders: Record<string, number> = {};

const Row = React.memo(function Row(props: Readonly<{ machineId: string }>) {
    renders[props.machineId] = (renders[props.machineId] ?? 0) + 1;
    const working = useMachineWorkingCount({ serverId: 'server-a', machineId: props.machineId });
    return React.createElement('Row', { testID: `row:${props.machineId}`, working });
});

const Total = React.memo(function Total() {
    return React.createElement('Total', { testID: 'total', total: useMachineWorkingTotal() });
});

// An open surface retains its list elements while the provider's Activity leaf follows publications.
const rows = [<Row key="a" machineId="a" />, <Row key="b" machineId="b" />, <Total key="total" />];

function session(id: string, machineId: string, thinking = true) {
    return createSessionFixture({
        id, serverId: 'server-a', active: true, presence: 'online', thinking,
        thinkingAt: NOW_MS - 1_000, activeAt: NOW_MS - 1_000, updatedAt: NOW_MS - 1_000,
        metadata: { ...createSessionFixture().metadata!, machineId },
    });
}

function publishSessions(sessions: ReturnType<typeof createSessionFixture>[]) {
    storage.getState().applyServerScopedSessionListRows('server-a', sessions.map(value => buildSessionListRenderableFromSession(value)), {
        source: 'ordinary', mode: 'append',
    });
}

describe('machine working counts provider', () => {
    beforeEach(() => {
        vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
        for (const key of Object.keys(renders)) delete renders[key];
        storage.setState({ isDataReady: true, sessions: {}, sessionListRowsByServerId: {},
            ordinarySessionListMembershipByServerId: {}, sessionListIndexByServerId: {}, concurrentSessionListCacheByServerId: {} });
    });
    afterEach(async () => {
        await standardCleanup();
        storage.setState(initialState, true);
        vi.restoreAllMocks();
    });

    it('publishes working starts and stops to only the changed machine and total', async () => {
        const a1 = session('a1', 'a');
        const a2 = session('a2', 'a', false);
        const b1 = session('b1', 'b');
        const b2 = session('b2', 'b');
        publishSessions([a1, a2, b1, b2]);
        const screen = await renderScreen(<MachineWorkingCountsProvider>{rows}</MachineWorkingCountsProvider>);
        expect(screen.findByTestId('row:a')?.props.working).toBe(1);
        expect(screen.findByTestId('row:b')?.props.working).toBe(2);
        expect(screen.findByTestId('total')?.props.total).toBe(3);
        const before = { ...renders };

        await act(async () => publishSessions([{ ...a2, seq: 2, thinking: true }]));

        expect(screen.findByTestId('row:a')?.props.working).toBe(2);
        expect(screen.findByTestId('row:b')?.props.working).toBe(2);
        expect(screen.findByTestId('total')?.props.total).toBe(4);
        expect(renders.a).toBe(before.a! + 1);
        expect(renders.b).toBe(before.b);

        await act(async () => publishSessions([{ ...a1, seq: 2, thinking: false }, { ...a2, seq: 3 }]));
        expect(screen.findByTestId('row:a')?.props.working).toBe(0);
        expect(screen.findByTestId('total')?.props.total).toBe(2);
        expect(renders.b).toBe(before.b);

        // A delayed arrival must classify against the current clock, not the mount-time clock.
        vi.mocked(Date.now).mockReturnValue(NOW_MS + 120_000);
        await act(async () => publishSessions([{ ...b1, seq: b1.seq + 1 }]));
        expect(screen.findByTestId('row:b')?.props.working).toBe(0);
        expect(screen.findByTestId('total')?.props.total).toBe(0);
    });

    it('keeps zero and retained counts without live work while hidden, then reads current sessions on resume', async () => {
        const a = session('a', 'a');
        const b = session('b', 'b');
        const body = (presented: boolean) => <PluginSurfaceFocusEligibilityProvider active={presented}>
            <MachineWorkingCountsProvider>{rows}</MachineWorkingCountsProvider>
        </PluginSurfaceFocusEligibilityProvider>;
        const screen = await renderScreen(body(true));
        expect(screen.findByTestId('row:a')?.props.working).toBe(0);
        expect(screen.findByTestId('total')?.props.total).toBe(0);
        await act(async () => publishSessions([a]));
        expect(screen.findByTestId('row:a')?.props.working).toBe(1);

        await screen.update(body(false));
        const before = { ...renders };
        // Observe visits through the real attribution owner; do not replace its behavior.
        const attribution = vi.spyOn(machineTargets, 'resolveDisplayMachineIdForSessionFromState');
        for (let seq = 2; seq <= 5; seq += 1) {
            await act(async () => publishSessions([{ ...a, seq, thinking: false }, { ...b, seq }]));
        }
        expect(attribution).not.toHaveBeenCalled();
        expect(renders).toEqual(before);
        expect(screen.findByTestId('row:a')?.props.working).toBe(1);
        expect(screen.findByTestId('row:b')?.props.working).toBe(0);
        expect(screen.findByTestId('total')?.props.total).toBe(1);

        await screen.update(body(true));
        expect(screen.findByTestId('row:a')?.props.working).toBe(0);
        expect(screen.findByTestId('row:b')?.props.working).toBe(1);
        expect(screen.findByTestId('total')?.props.total).toBe(1);
        await act(async () => publishSessions([{ ...b, seq: 6, thinking: false }]));
        expect(screen.findByTestId('row:b')?.props.working).toBe(0);
        expect(screen.findByTestId('total')?.props.total).toBe(0);
    });
});
