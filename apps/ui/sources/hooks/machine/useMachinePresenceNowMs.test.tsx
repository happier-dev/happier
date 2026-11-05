import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { useSessionListRuntimeNowMs } from '@/hooks/session/sessionListRuntimeClock';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { useMachinePresenceNowMs } from './useMachinePresenceNowMs';
import { publishMachineActivity } from '@/sync/domains/machines/machineActivity';

afterEach(async () => {
    await standardCleanup();
    vi.useRealTimers();
    vi.unstubAllEnvs();
});

it('expires legacy presence at the incumbent grace boundary and renews from held heartbeat facts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const machine = { active: true, activeAt: 100_000 };
    const hook = await renderHook(() => useMachinePresenceNowMs([machine]));
    expect(isMachineOnline(machine, hook.getCurrent())).toBe(true);
    await flushHookEffects({ advanceTimersMs: 40_000, cycles: 1, turns: 2 });
    await act(async () => { publishMachineActivity(machine, { active: true, activeAt: 140_000 }, []); });
    await flushHookEffects({ advanceTimersMs: 60_000, cycles: 1, turns: 2 });
    expect(isMachineOnline(machine, hook.getCurrent())).toBe(true);
    await flushHookEffects({ advanceTimersMs: 1, cycles: 1, turns: 2 });
    expect(isMachineOnline(machine, hook.getCurrent())).toBe(false);
    await hook.unmount();
    expect(vi.getTimerCount()).toBe(0);
});

it('observes authoritative presence pushes without a timer or heartbeat rerenders', async () => {
    vi.useFakeTimers();
    vi.stubEnv('EXPO_PUBLIC_HAPPIER_MACHINE_ONLINE_GRACE_MS', '1000');
    vi.setSystemTime(20_000);
    const machine = { active: true, activeAt: Date.now(), presenceProtocolVersion: 1 as const };
    const machines = [machine];
    let renders = 0;
    const presence = await renderHook(() => { renders++; return useMachinePresenceNowMs(machines); });
    const baseline = renders;
    for (let beat = 0; beat < 4; beat++) {
        await flushHookEffects({ advanceTimersMs: 500, cycles: 1, turns: 2 });
        await act(async () => {
            publishMachineActivity(machine, { active: true, activeAt: Date.now() }, []);
        });
    }
    expect(renders).toBe(baseline);
    expect(vi.getTimerCount()).toBe(0);
    await flushHookEffects({ advanceTimersMs: 1_001, cycles: 1, turns: 2 });
    expect(isMachineOnline(machine, presence.getCurrent())).toBe(true);
    await act(async () => { publishMachineActivity(machine, { active: false, activeAt: Date.now() }, []); });
    expect(isMachineOnline(machine, presence.getCurrent())).toBe(false);
    expect(renders).toBe(baseline + 1);
    await presence.unmount();
    expect(vi.getTimerCount()).toBe(0);
});

it('keeps its sampled instant stable without borrowing a neighboring clock deadline', async () => {
    vi.useFakeTimers();
    vi.stubEnv('EXPO_PUBLIC_HAPPIER_MACHINE_ONLINE_GRACE_MS', '1000');
    vi.setSystemTime(10_000);
    // A mounted neighboring surface must not make a newly mounted presence read stale.
    const neighbor = await renderHook(() => useSessionListRuntimeNowMs());
    vi.setSystemTime(10_200);
    const negotiated = { presenceProtocolVersion: 1 as const };
    const first = [{ active: true, activeAt: 10_000, ...negotiated }];
    const presence = await renderHook((machines: typeof first) => useMachinePresenceNowMs(machines), {
        initialProps: first,
    });
    expect(presence.getCurrent()).toBe(10_200);
    vi.setSystemTime(10_400);
    await presence.rerender(first);
    expect(presence.getCurrent()).toBe(10_200);

    const renewed = [{ active: true, activeAt: 10_400, ...negotiated }];
    await presence.rerender(renewed);
    expect(presence.getCurrent()).toBe(10_400);
    expect(isMachineOnline(renewed[0], presence.getCurrent())).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await flushHookEffects({ advanceTimersMs: 1_001, cycles: 1, turns: 2 });
    expect(isMachineOnline(renewed[0], presence.getCurrent())).toBe(true);
    await presence.unmount();
    await neighbor.unmount();
    expect(vi.getTimerCount()).toBe(0);
});
