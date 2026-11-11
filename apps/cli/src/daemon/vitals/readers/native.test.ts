import { freemem } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createWindowsMachineVitalsReader } from './windows';
import { createDarwinMachineVitalsReader } from './darwin';
import { createNativeMachineVitalsReader } from './native';
import { type ProcessCustodyExecFile } from '@/subprocess/supervision/processCustody';
import { nativeVitalsOutputFixture as output } from './native.testkit';

// OS memory counters are the system boundary; keep native decoding/accounting real.
vi.mock('node:os', async importOriginal => ({ ...await importOriginal<typeof import('node:os')>(), freemem: vi.fn(() => 10_000) }));
beforeEach(() => { vi.mocked(freemem).mockReturnValue(10_000); });

describe('native vitals reader contract', () => {
    it.each(['darwin', 'win32'] as const)('uses allocation headroom rather than pressure percentage on %s', async platform => {
        const totalBytes = 137_438_953_472;
        const pressureBytes = 129_192_616_263; // R113: 94% pressure accounting, not free RAM.
        const raw = JSON.parse(output(0));
        raw.sample.memory.totalBytes = totalBytes;
        raw.sample.memory.availableBytes = pressureBytes;
        const execFile = vi.fn<ProcessCustodyExecFile>().mockResolvedValue({ stdout: JSON.stringify(raw), stderr: '' });
        const reader = createNativeMachineVitalsReader(platform, { executablePath: '/helper', execFile });
        const availableBytes = platform === 'darwin' ? 10_000 : pressureBytes;
        expect(await reader.read({ sampledAt: 0, monotonicMs: 0, intervalMs: 2_000, overviewExtras: false }))
            .toMatchObject({ state: 'reporting', sample: { memory: { availableBytes, usedBytes: totalBytes - availableBytes } } });
    });
    it.each(['darwin', 'win32'] as const)('requires native available bytes only on Windows (%s)', async platform => {
        const raw = JSON.parse(output(0));
        delete raw.sample.memory.availableBytes;
        const execFile = vi.fn<ProcessCustodyExecFile>().mockResolvedValue({ stdout: JSON.stringify(raw), stderr: '' });
        const reader = createNativeMachineVitalsReader(platform, { executablePath: '/helper', execFile });
        expect((await reader.read({ sampledAt: 0, monotonicMs: 0, intervalMs: 2_000, overviewExtras: false })).state)
            .toBe(platform === 'darwin' ? 'reporting' : 'unavailable');
    });
    it.each(['darwin', 'win32'] as const)('keeps %s multicore busy time independent of normalized load and omits Windows load', async (platform) => {
        let step = 0;
        const readCpuTimes = () => Array.from({ length: 4 }, () => ({
            user: 100 + step * 60, system: 100 + step * 28, idle: 100 + step * 12,
        }));
        const execFile = vi.fn<ProcessCustodyExecFile>().mockImplementation(async (command) => {
            if (command !== '/helper') return { stdout: '', stderr: '' };
            // The native executable is the OS boundary; retain the real reader accounting beneath it.
            const raw = JSON.parse(output(0));
            raw.sample.cpu = readCpuTimes();
            return { stdout: JSON.stringify(raw), stderr: '' };
        });
        const options = { executablePath: '/helper', execFile, readCpuTimes, readLoadAverage: () => [8, 4, 2] };
        const reader = platform === 'darwin' ? createDarwinMachineVitalsReader(options) : createWindowsMachineVitalsReader(options);
        const read = (t: number) => reader.read({ sampledAt: t, monotonicMs: t, intervalMs: 2_000, overviewExtras: false });
        await read(0);
        step = 1;

        const result = await read(2_000);
        expect(result.state).toBe('reporting');
        if (result.state !== 'reporting') throw new Error('Machine vitals unavailable');
        expect(result.host.logicalCores).toBe(4);
        expect(result.sample.cpu).toMatchObject({ busyPct: 88, userPct: 60, systemPct: 28, perCore: [88, 88, 88, 88] });
        if (platform === 'darwin') expect(result.sample.cpu).toMatchObject({ load1: 2, load5: 1, load15: 0.5 });
        else {
            expect(result.sample.cpu).not.toHaveProperty('load1');
            expect(result.sample.cpu).not.toHaveProperty('load5');
            expect(result.sample.cpu).not.toHaveProperty('load15');
        }
    });

    it('measures Darwin composition with each Overview memory read and never reuses failed VM output', async () => {
        let usedBytes = 22_000;
        let wiredPages = 2;
        let vmStat = true;
        const execFile = vi.fn<ProcessCustodyExecFile>().mockImplementation(async (command) => {
            if (command === '/helper') {
                const raw = JSON.parse(output(0));
                raw.sample.memory.availableBytes = raw.sample.memory.totalBytes - usedBytes;
                vi.mocked(freemem).mockReturnValue(raw.sample.memory.totalBytes - usedBytes);
                return { stdout: JSON.stringify(raw), stderr: '' };
            }
            if (command === '/usr/bin/vm_stat') {
                if (!vmStat) throw new Error('VM statistics unavailable');
                return { stdout: `Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages wired down: ${wiredPages}.\nPages occupied by compressor: 1.\nFile-backed pages: 1.\n`, stderr: '' };
            }
            return { stdout: '', stderr: '' };
        });
        const reader = createDarwinMachineVitalsReader({ executablePath: '/helper', execFile });
        const read = (t: number, overview = true) => reader.read({ sampledAt: t, monotonicMs: t, intervalMs: 2_000, overview, overviewExtras: t === 0 });
        expect(await read(0)).toMatchObject({ sample: { memory: { usedBytes: 22_000, composition: [
            { kind: 'apps', bytes: 5_616 }, { kind: 'wired', bytes: 8_192 }, { kind: 'compressed', bytes: 4_096 }, { kind: 'cached_files', bytes: 4_096 },
        ] } } });
        usedBytes = 24_000;
        wiredPages = 3;
        const next = await read(2_000);
        expect(next).toMatchObject({ sample: { memory: { usedBytes: 24_000, composition: [
            { kind: 'apps', bytes: 3_520 }, { kind: 'wired', bytes: 12_288 }, { kind: 'compressed', bytes: 4_096 }, { kind: 'cached_files', bytes: 4_096 },
        ] } } });
        vmStat = false;
        const failed = await read(4_000);
        expect(failed.state).toBe('reporting');
        if (failed.state === 'reporting') expect(failed.sample.memory).not.toHaveProperty('composition');
        vmStat = true;
        const recovered = await read(6_000);
        if (recovered.state !== 'reporting' || !recovered.sample.memory.reported) throw new Error('Memory unavailable');
        expect(recovered.sample.memory.composition?.reduce((sum, part) => sum + part.bytes, 0)).toBe(usedBytes);
        const hidden = await read(8_000, false);
        if (hidden.state === 'reporting') expect(hidden.sample.memory).not.toHaveProperty('composition');
        expect(execFile.mock.calls.filter(([command]) => command === '/usr/bin/vm_stat')).toHaveLength(4);
    });
    it.each([2_000, 15_000, 60_000])('spawns no macOS battery tool without a power consumer at %s ms cadence', async (intervalMs) => {
        const execFile = vi.fn<ProcessCustodyExecFile>().mockImplementation(async (command) => ({
            stdout: command === '/helper' ? output(0) : "Now drawing from 'AC Power'\n", stderr: '',
        }));
        const reader = createDarwinMachineVitalsReader({ executablePath: '/helper', execFile });
        for (const t of [0, intervalMs, 60_000, 120_000]) {
            const result = await reader.read({ sampledAt: t, monotonicMs: t, intervalMs, overviewExtras: false });
            expect(result.state).toBe('reporting');
            if (result.state === 'reporting') expect(result.sample.power).toBeUndefined();
        }
        expect(execFile.mock.calls.filter(([command, args]) => command === '/usr/bin/pmset' && args[1] === 'batt')).toHaveLength(0);
    });
    it('reads demanded macOS AC power on the canonical tick without exposing battery extras', async () => {
        let power = "Now drawing from 'AC Power'\n";
        const execFile = vi.fn<ProcessCustodyExecFile>().mockImplementation(async (command) => ({
            stdout: command === '/helper' ? output(0) : command === '/usr/bin/pmset' ? power : '', stderr: '',
        }));
        const reader = createDarwinMachineVitalsReader({ executablePath: '/helper', execFile });
        const read = (t: number) => reader.read({ sampledAt: t, monotonicMs: t, intervalMs: 60_000, power: true, overviewExtras: false });
        expect(await read(0)).toMatchObject({ state: 'reporting', sample: { power: { onAC: true } } });
        power = "Now drawing from 'Battery Power'\n -InternalBattery-0 80%; discharging; 2:00 remaining\n";
        const result = await read(60_000);
        expect(result).toMatchObject({ state: 'reporting', sample: { power: { onAC: false } } });
        if (result.state === 'reporting') expect(result.sample.battery).toBeUndefined();
        power = '';
        const unknown = await read(120_000);
        if (unknown.state === 'reporting') expect(unknown.sample.power).toBeUndefined();
    });
    it.each([2_000, 15_000, 60_000])('shares the minute power observation at a %s ms base cadence', async (intervalMs) => {
        let power = "Now drawing from 'AC Power'\n";
        const execFile = vi.fn<ProcessCustodyExecFile>().mockImplementation(async (command) => ({
            stdout: command === '/helper' ? output(0) : command === '/usr/bin/pmset' ? power : '', stderr: '',
        }));
        const reader = createDarwinMachineVitalsReader({ executablePath: '/helper', execFile });
        const read = (t: number, power = true) => reader.read({ sampledAt: t, monotonicMs: t, intervalMs, power, overviewExtras: false });
        for (let t = 0; t < 60_000; t += intervalMs) {
            expect(await read(t)).toMatchObject({ state: 'reporting', sample: { power: { onAC: true } } });
        }
        expect(execFile.mock.calls.filter(([command, args]) => command === '/usr/bin/pmset' && args[1] === 'batt')).toHaveLength(1);
        power = "Now drawing from 'Battery Power'\n -InternalBattery-0 80%; discharging; 2:00 remaining\n";
        expect(await read(60_000)).toMatchObject({ state: 'reporting', sample: { power: { onAC: false } } });
        expect(execFile.mock.calls.filter(([command, args]) => command === '/usr/bin/pmset' && args[1] === 'batt')).toHaveLength(2);
        const undemanded = await read(120_000, false);
        if (undemanded.state === 'reporting') expect(undemanded.sample.power).toBeUndefined();
        expect(execFile.mock.calls.filter(([command, args]) => command === '/usr/bin/pmset' && args[1] === 'batt')).toHaveLength(2);
        expect(await read(120_000)).toMatchObject({ state: 'reporting', sample: { power: { onAC: false } } });
        expect(execFile.mock.calls.filter(([command, args]) => command === '/usr/bin/pmset' && args[1] === 'batt')).toHaveLength(3);
    });
    it('reads Overview battery, thermal and GPU facts on every selected tick', async () => {
        let power = "Now drawing from 'AC Power'\n -InternalBattery-0 80%; charging; 1:00 remaining\n";
        let throttled = false;
        let busyPct = 20;
        const execFile = vi.fn<ProcessCustodyExecFile>().mockImplementation(async (command, args) => ({
            stdout: command === '/helper' ? output(0)
                : command === '/usr/bin/pmset' && args[1] === 'batt' ? power
                : command === '/usr/bin/pmset' && args[1] === 'therm' ? `CPU_Speed_Limit = ${throttled ? 50 : 100}`
                : command === '/usr/sbin/ioreg' ? `+-o GPU "model" = "Test GPU" "Device Utilization %" = ${busyPct}` : '', stderr: '',
        }));
        const reader = createDarwinMachineVitalsReader({ executablePath: '/helper', execFile });
        const read = (t: number) => reader.read({ sampledAt: t, monotonicMs: t, intervalMs: 2_000, overviewExtras: true });
        expect(await read(0)).toMatchObject({ sample: { power: { onAC: true }, battery: { state: 'charging' },
            thermal: { throttled: false }, gpu: [{ busyPct: 20 }] } });
        power = "Now drawing from 'Battery Power'\n -InternalBattery-0 80%; discharging; 2:00 remaining\n";
        throttled = true;
        busyPct = 75;
        expect(await read(2_000)).toMatchObject({ state: 'reporting', sample: { power: { onAC: false }, battery: { state: 'discharging' },
            thermal: { throttled: true }, gpu: [{ busyPct: 75 }] } });
        expect(execFile.mock.calls.filter(([command, args]) => command === '/usr/bin/pmset' && args[1] === 'batt')).toHaveLength(2);
    });
    it.each(['darwin', 'win32'] as const)('reads native %s battery extras at the selected cadence without retaining disappeared facts', async platform => {
        let pct: number | undefined = 80;
        const execFile = vi.fn<ProcessCustodyExecFile>().mockImplementation(async (_command, args) => {
            const raw = JSON.parse(output(0));
            if (args.includes('--extras') && pct !== undefined) raw.sample.battery = { pct, state: 'discharging', onAC: false };
            return { stdout: JSON.stringify(raw), stderr: '' };
        });
        const reader = createNativeMachineVitalsReader(platform, { executablePath: '/helper', execFile });
        const read = (t: number) => reader.read({ sampledAt: t, monotonicMs: t, intervalMs: 2_000, overviewExtras: true });
        expect(await read(0)).toMatchObject({ sample: { battery: { pct: 80 } } });
        pct = 79;
        expect(await read(2_000)).toMatchObject({ sample: { battery: { pct: 79 } } });
        pct = undefined;
        const result = await read(4_000);
        expect(result.state).toBe('reporting');
        if (result.state === 'reporting') expect(result.sample.battery).toBeUndefined();
    });
    it('projects fresh power edges without an Overview viewer', async () => {
        let onAC = true;
        const execFile = vi.fn<ProcessCustodyExecFile>().mockImplementation(async () => {
            const raw = JSON.parse(output(0)); raw.sample.power = { onAC };
            return { stdout: JSON.stringify(raw), stderr: '' };
        });
        const reader = createWindowsMachineVitalsReader({ executablePath: '/helper', execFile });
        const read = (t: number) => reader.read({ sampledAt: t, monotonicMs: t, intervalMs: 60_000, overviewExtras: false });
        expect(await read(0)).toMatchObject({ state: 'reporting', sample: { power: { onAC: true } } });
        onAC = false;
        expect(await read(60_000)).toMatchObject({ state: 'reporting', sample: { power: { onAC: false } } });
    });
    it('keeps Windows pressure unreported, projects commit charge, and derives rates only after a valid interval', async () => {
        let n = 0;
        const execFile = vi.fn<ProcessCustodyExecFile>().mockImplementation(async () => ({ stdout: output(n++ * 100), stderr: '' }));
        const reader = createWindowsMachineVitalsReader({ executablePath: '/helper', execFile });
        const read = (t: number) => reader.read({ sampledAt: t, monotonicMs: t, intervalMs: 2000, overviewExtras: false });
        const first = await read(0);
        expect(first).toMatchObject({ state: 'reporting', sample: { cpu: { busyPct: null }, network: { rxBps: null }, memory: {
            pressure: { level: 'not_reported', source: 'none' }, lowMemorySignal: true, commitUsedBytes: 30_000, commitLimitBytes: 64_000,
        } } });
        expect(await read(2000)).toMatchObject({ state: 'reporting', sample: { cpu: { busyPct: 50, userPct: 30, systemPct: 20 }, network: { rxBps: 100, txBps: 50 } } });
        expect(await read(20_000)).toMatchObject({ state: 'reporting', sample: { cpu: { busyPct: 50 }, network: { rxBps: 200 / 18 } } });
        expect(await read(140_001)).toMatchObject({ state: 'reporting', sample: { cpu: { busyPct: null }, network: { rxBps: null } } });
    });
    it.each(['darwin', 'win32'] as const)('keeps %s counted rates independent of excluded interface churn', async (platform) => {
        let t = 0;
        let excluded = true;
        const execFile = vi.fn<ProcessCustodyExecFile>().mockImplementation(async (command) => {
            if (command !== '/helper') return { stdout: '', stderr: '' };
            const raw = JSON.parse(output(t));
            if (!excluded) raw.sample.interfaces.pop();
            return { stdout: JSON.stringify(raw), stderr: '' };
        });
        const options = { executablePath: '/helper', execFile,
            readCpuTimes: () => [{ user: 3_000 + t * 3, system: 2_000 + t * 2, idle: 9_000 + t * 5 }] };
        const reader = platform === 'darwin' ? createDarwinMachineVitalsReader(options) : createWindowsMachineVitalsReader(options);
        const read = () => reader.read({ sampledAt: t, monotonicMs: t, intervalMs: 2_000, overviewExtras: false });
        await read();
        for (const next of [4_600, 15_600]) {
            t = next;
            excluded = !excluded;
            expect(await read()).toMatchObject({ sample: { cpu: { busyPct: 50 }, network: { rxBps: 2_000, txBps: 1_000 } } });
        }
    });
    it('reports a missing helper without a spawn', async () => {
        const execFile = vi.fn<ProcessCustodyExecFile>();
        expect(await createWindowsMachineVitalsReader({ executablePath: null, execFile }).read({ sampledAt: 0, monotonicMs: 0, intervalMs: 60_000, overviewExtras: false })).toEqual({ state: 'unavailable', reason: 'helper_missing' });
        expect(execFile).not.toHaveBeenCalled();
    });
    it('uses only the current native memory composition, including base reads, without inventing app bytes', async () => {
        let calls = 0;
        const execFile = vi.fn<ProcessCustodyExecFile>().mockImplementation(async () => {
            const raw = JSON.parse(output(0));
            raw.sample.memory.availableBytes = calls++ === 0 ? 10_000 : 8_000;
            raw.sample.memory.composition = calls === 1
                ? [{ kind: 'apps', bytes: 12_000 }, { kind: 'system', bytes: 4_000 }, { kind: 'cached_files', bytes: 6_000 }]
                : [{ kind: 'apps', bytes: 10_000 }, { kind: 'system', bytes: 5_000 }, { kind: 'cached_files', bytes: 9_000 }];
            return { stdout: JSON.stringify(raw), stderr: '' };
        });
        const reader = createWindowsMachineVitalsReader({ executablePath: '/helper', execFile });
        await reader.read({ sampledAt: 0, monotonicMs: 0, intervalMs: 2000, overviewExtras: true });
        const result = await reader.read({ sampledAt: 2000, monotonicMs: 2000, intervalMs: 2000, overviewExtras: false });
        expect(result).toMatchObject({ state: 'reporting', sample: { memory: { usedBytes: 24_000, composition: [{ kind: 'apps', bytes: 10_000 }, { kind: 'system', bytes: 5_000 }, { kind: 'cached_files', bytes: 9_000 }] } } });
        expect(execFile.mock.calls.filter(([command]) => command === '/helper').map(([, args]) => args)).toEqual([['vitals-sample', '--extras'], ['vitals-sample']]);
    });
    it('does not reuse a previous composition when a native memory reading lacks it', async () => {
        let calls = 0;
        const execFile = vi.fn<ProcessCustodyExecFile>().mockImplementation(async () => {
            const raw = JSON.parse(output(0));
            if (calls++ === 0) raw.sample.memory.composition = [{ kind: 'apps', bytes: 22_000 }];
            return { stdout: JSON.stringify(raw), stderr: '' };
        });
        const reader = createWindowsMachineVitalsReader({ executablePath: '/helper', execFile });
        await reader.read({ sampledAt: 0, monotonicMs: 0, intervalMs: 2000, overviewExtras: true });
        const next = await reader.read({ sampledAt: 2000, monotonicMs: 2000, intervalMs: 2000, overviewExtras: true });
        expect(next.state).toBe('reporting');
        if (next.state === 'reporting') expect(next.sample.memory).not.toHaveProperty('composition');
    });
});
