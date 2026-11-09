import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createKeepAwake } from '@/integrations/keepAwake';
import { createMachineVitalsSampler } from '@/daemon/vitals/createMachineVitalsSampler';
import { createMinuteHistoryStore } from '@/daemon/vitals/history/minuteHistoryStore';
import { createLinuxMachineVitalsReader } from '@/daemon/vitals/readers/linux';
import { createLinuxVitalsFixture } from '@/daemon/vitals/readers/linux.testkit';
import { createDaemonKeepAwake } from './daemonKeepAwake';
import { createMachineResourcesPolicyRuntime } from './machineResourcesPolicy';

it('retries denied keep-awake only on policy or AC changes, not identical vitals samples, and releases at shutdown', async () => {
    vi.useFakeTimers();
    const directory = await mkdtemp(join(tmpdir(), 'happier-keep-awake-'));
    const fixture = await createLinuxVitalsFixture();
    await fixture.put('/sys/class/power_supply/AC/type', 'Mains');
    await fixture.put('/sys/class/power_supply/AC/online', '1');
    await fixture.put('/sys/class/power_supply/BAT0/type', 'Battery');
    await fixture.put('/sys/class/power_supply/BAT0/capacity', '80');
    await fixture.put('/sys/class/power_supply/BAT0/status', 'Full');
    // Native child readiness and pipe EOF are the only holder boundary.
    const children: EventEmitter[] = [];
    let acquisitionFailures = 1;
    const holder = createKeepAwake({ platform: 'win32', resolveExecutable: () => '/helper', spawn: () => {
        const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
            kill: () => { child.emit('close', 0, null); return true; } });
        children.push(child);
        child.stdin.on('finish', () => { child.emit('exit', 0, null); child.emit('close', 0, null); });
        queueMicrotask(() => {
            if (acquisitionFailures > 0) {
                acquisitionFailures -= 1;
                child.emit('exit', 1, null); child.emit('close', 1, null);
            } else child.stdout.write('{"holding":true,"v":1}\n');
        });
        return child as unknown as ChildProcess;
    } });
    let metadata: Record<string, unknown> = {};
    let version = 1;
    const policy = createMachineResourcesPolicyRuntime({ port: {
        read: async () => ({ status: 'ready', metadata, metadataVersion: version }),
        compareAndSwap: async input => { metadata = input.metadata; return { status: 'applied', metadata, metadataVersion: ++version }; },
    } });
    const vitals = createMachineVitalsSampler({ readers: createLinuxMachineVitalsReader({ root: fixture.root }),
        historyStore: await createMinuteHistoryStore({ directory }), monotonicMs: () => Date.now(),
        readPolicy: () => { const snapshot = policy.read(); return snapshot.status === 'ready' ? snapshot.policy : null; },
        subscribeMonitoring: listener => policy.subscribeKey('monitoring', listener),
    });
    await policy.reload();
    const binding = createDaemonKeepAwake({ policy, vitals, holder });
    const settled = () => vi.waitFor(() => expect(binding.read().holding).toBe(true));
    try {
        await vitals.start(); await binding.start();
        await vi.waitFor(() => expect(binding.read()).toEqual({ holding: false, unavailableReason: 'no_inhibitor' }));
        expect(children).toHaveLength(1);
        const powers: Array<boolean | null> = [];
        const releaseSamples = vitals.subscribe(({ sample }) => powers.push(sample.power?.onAC ?? null));
        try {
            for (let n = 0; n < 3; n++) {
                const previous = powers.length;
                await vi.advanceTimersByTimeAsync(60_000);
                await vi.waitFor(() => expect(powers.length).toBeGreaterThan(previous));
            }
            expect(new Set(powers).size).toBe(1);
            expect(children).toHaveLength(1);
            expect(binding.read()).toEqual({ holding: false, unavailableReason: 'no_inhibitor' });
        } finally { releaseSamples(); }
        const mode = async (keepAwake: 'off' | 'on_power') => {
            const snapshot = policy.read();
            if (snapshot.status !== 'ready') throw new Error('Expected policy ready');
            expect(await policy.set({ expectedRevision: snapshot.revision, patch: { guard: { keepAwake } } })).toMatchObject({ status: 'applied' });
        };
        await mode('off');
        await vi.waitFor(() => expect(binding.read().holding).toBe(false));
        await vi.advanceTimersByTimeAsync(60_000);
        expect(children).toHaveLength(1);
        await mode('on_power'); await vi.advanceTimersByTimeAsync(60_000); await settled();
        expect(children).toHaveLength(2);
        children[1].emit('exit', 5, null); children[1].emit('close', 5, null);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(binding.read().holding).toBe(false);
        expect(children).toHaveLength(2);
        await fixture.put('/sys/class/power_supply/AC/online', '0');
        await vi.advanceTimersByTimeAsync(60_000);
        await vi.waitFor(() => expect(vitals.latest()?.power?.onAC).toBe(false));
        await vi.waitFor(() => expect(binding.read().holding).toBe(false));
        await fixture.put('/sys/class/power_supply/AC/online', '1');
        await vi.advanceTimersByTimeAsync(60_000); await settled();
        expect(children).toHaveLength(3);
        const releaseOverview = vitals.demandOverview();
        await vi.advanceTimersByTimeAsync(2_000);
        await vi.waitFor(() => expect(vitals.latest()?.battery?.onAC).toBe(true));
        await fixture.put('/sys/class/power_supply/AC/online', 'unknown');
        await vi.advanceTimersByTimeAsync(2_000);
        // Rich Overview extras can be cached; they must not overrule the
        // current always-on power fact when the OS answer becomes unknown.
        await vi.waitFor(() => expect(vitals.latest()?.power).toBeUndefined());
        expect(vitals.latest()?.battery?.onAC).toBe(true);
        await vi.waitFor(() => expect(binding.read().holding).toBe(false));
        releaseOverview();
        await binding.stop(); expect(binding.read().holding).toBe(false);
    } finally { await binding.stop(); await vitals.stop(); policy.stop(); vi.useRealTimers(); await fixture.cleanup(); await rm(directory, { recursive: true, force: true }); }
});
