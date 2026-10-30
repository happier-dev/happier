import { chmod, mkdir, rm, symlink } from 'node:fs/promises';
import * as filesystem from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MachineVitalsSampleV1Schema } from '@happier-dev/protocol/machines/vitals/machineVitalsSampleV1';
import { deriveMachineVitalsAttentionV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsAttentionV1';

import { createLinuxMachineVitalsReader } from './linux';
import { createLinuxVitalsFixture } from './linux.testkit';

const fixtures: Awaited<ReturnType<typeof createLinuxVitalsFixture>>[] = [];
async function fixture() {
    const result = await createLinuxVitalsFixture();
    fixtures.push(result);
    return result;
}
afterEach(async () => { await Promise.all(fixtures.splice(0).map((f) => f.cleanup())); });

const input = (monotonicMs: number, overviewExtras = false, intervalMs = 2000) => ({ sampledAt: 1_000_000 + monotonicMs, monotonicMs, intervalMs, overviewExtras });

describe('Linux machine vitals reader', () => {
    it('reports a D3cold GPU as off, preserves unknown power and observes recovery on the existing extras cadence', async () => {
        const f = await fixture();
        await f.put('/sys/class/drm/card0/device/power_state', 'D3cold\n');
        await f.put('/sys/class/drm/card0/device/gpu_busy_percent', '72');
        await f.put('/sys/class/drm/card1/device/gpu_busy_percent', '0');
        const reader = createLinuxMachineVitalsReader({ root: f.root });
        const off = await reader.read(input(0, true));
        expect(off.state).toBe('reporting');
        if (off.state === 'reporting') {
            expect(off.sample.gpu).toEqual([{ name: 'card0', powerState: 'off' }, { name: 'card1', busyPct: 0 }]);
            expect(MachineVitalsSampleV1Schema.parse(off.sample).gpu).toEqual(off.sample.gpu);
        }
        await f.put('/sys/class/drm/card0/device/power_state', 'D0\n');
        const active = await reader.read(input(15_000, true));
        if (active.state === 'reporting') expect(active.sample.gpu).toEqual([{ name: 'card0', busyPct: 72 }, { name: 'card1', busyPct: 0 }]);
    });

    it('does not wake powered-off NVIDIA GPUs and queries remaining GPUs in the same single spawn', async () => {
        const f = await fixture();
        await f.put('/usr/bin/nvidia-smi', 'fixture');
        await chmod(join(f.root, '/usr/bin/nvidia-smi'), 0o700);
        await f.put('/proc/driver/nvidia/gpus/0000:01:00.0/information', 'Model: NVIDIA Test');
        await f.put('/sys/bus/pci/devices/0000:01:00.0/power_state', 'D3cold\n');
        const args: (readonly string[])[] = [];
        const reader = createLinuxMachineVitalsReader({ root: f.root, toolPath: '/usr/bin', execFile: async (_command, argv) => {
            args.push(argv); return { stdout: 'NVIDIA Active, 42, 100, 1000\n', stderr: '' };
        } });
        const off = await reader.read(input(0, true));
        expect(args).toEqual([]);
        if (off.state === 'reporting') expect(off.sample.gpu).toEqual([{ name: 'NVIDIA Test', powerState: 'off' }]);
        await f.put('/proc/driver/nvidia/gpus/0000:02:00.0/information', 'Model: NVIDIA Active');
        await f.put('/sys/bus/pci/devices/0000:02:00.0/power_state', 'D0\n');
        const mixed = await reader.read(input(15_000, true));
        expect(args).toHaveLength(1);
        expect(args[0]).toContain('--id=0000:02:00.0');
        if (mixed.state === 'reporting') expect(mixed.sample.gpu).toMatchObject([{ name: 'NVIDIA Test', powerState: 'off' }, { name: 'NVIDIA Active', busyPct: 42 }]);
        await f.put('/sys/bus/pci/devices/0000:01:00.0/power_state', 'unknown\n');
        await reader.read(input(30_000, true));
        expect(args[1]).not.toContain('--id=0000:02:00.0');
    });

    it('keeps an off NVIDIA DRM device even when the driver inventory lists only its awake sibling', async () => {
        const f = await fixture();
        await f.put('/usr/bin/nvidia-smi', 'fixture');
        await chmod(join(f.root, '/usr/bin/nvidia-smi'), 0o700);
        await f.put('/proc/driver/nvidia/gpus/0000:02:00.0/information', 'Model: NVIDIA Active');
        await f.put('/sys/bus/pci/devices/0000:01:00.0/vendor', '0x10de');
        await f.put('/sys/bus/pci/devices/0000:01:00.0/power_state', 'D3cold\n');
        await mkdir(join(f.root, '/sys/class/drm/card0'), { recursive: true });
        await symlink(join(f.root, '/sys/bus/pci/devices/0000:01:00.0'), join(f.root, '/sys/class/drm/card0/device'));
        const args: (readonly string[])[] = [];
        const reader = createLinuxMachineVitalsReader({ root: f.root, toolPath: '/usr/bin', execFile: async (_command, argv) => {
            args.push(argv); return { stdout: 'NVIDIA Active, 42, 100, 1000\n', stderr: '' };
        } });
        const result = await reader.read(input(0, true));
        expect(result.state).toBe('reporting');
        if (result.state === 'reporting') expect(result.sample.gpu).toMatchObject([{ name: 'NVIDIA GPU', powerState: 'off' }, { name: 'NVIDIA Active', busyPct: 42 }]);
        expect(args).toHaveLength(1);
        expect(args[0]).toContain('--id=0000:02:00.0');
        // A DRM slot can be reused without an intervening sampled empty list.
        await rm(join(f.root, '/sys/class/drm/card0/device'));
        await f.put('/sys/bus/pci/devices/0000:03:00.0/vendor', '0x10de');
        await f.put('/sys/bus/pci/devices/0000:03:00.0/power_state', 'D0\n');
        await symlink(join(f.root, '/sys/bus/pci/devices/0000:03:00.0'), join(f.root, '/sys/class/drm/card0/device'));
        const replaced = await reader.read(input(15_000, true));
        if (replaced.state === 'reporting') expect(replaced.sample.gpu).toEqual([
            { name: 'NVIDIA Active', busyPct: 42, memUsedBytes: 104857600, memTotalBytes: 1048576000 },
        ]);
    });
    it('reports power with no viewer while keeping battery details in Overview and excluding peripherals', async () => {
        const f = await fixture();
        for (const [path, value] of Object.entries({
            'mouse/type': 'Battery', 'mouse/scope': 'Device', 'mouse/capacity': '99', 'mouse/status': 'Discharging',
            'BAT0/type': 'Battery', 'BAT0/scope': 'System', 'BAT0/capacity': '42', 'BAT0/status': 'Charging',
            'AC/type': 'Mains', 'AC/online': '1',
        })) await f.put(`/sys/class/power_supply/${path}`, value);
        const reader = createLinuxMachineVitalsReader({ root: f.root });
        const base = await reader.read(input(0));
        expect(base.state).toBe('reporting');
        if (base.state === 'reporting') {
            expect(base.sample).not.toHaveProperty('battery');
            expect(base.sample).toHaveProperty('power', { onAC: true });
        }
        const overview = await reader.read(input(2000, true));
        expect(overview.state).toBe('reporting');
        if (overview.state === 'reporting') expect(overview.sample.battery).toEqual({ pct: 42, state: 'charging', onAC: true });
    });

    it('reports MemAvailable, nice-busy/iowait-idle CPU deltas and filtered per-interface traffic', async () => {
        const f = await fixture();
        const reader = createLinuxMachineVitalsReader({ root: f.root });
        const first = await reader.read(input(0));
        expect(first.state).toBe('reporting');
        if (first.state !== 'reporting') return;
        expect(first.sample.cpu).toMatchObject({ reported: true, busyPct: null });
        expect(first.sample.memory).toMatchObject({ totalBytes: 102400000, availableBytes: 40960000, usedBytes: 61440000 });
        await f.put('/proc/stat', 'cpu 110 30 40 450 70 0 0 10 0 0\ncpu0 110 30 40 450 70 0 0 10 0 0\nbtime 100\n');
        await f.put('/proc/net/dev', 'eth0: 3000 0 0 0 0 0 0 0 6000 0 0 0 0 0 0 0\nveth0: 99000 0 0 0 0 0 0 0 99000 0 0 0 0 0 0 0\n');
        const second = await reader.read(input(2000, true));
        expect(second.state).toBe('reporting');
        if (second.state !== 'reporting') return;
        expect(second.sample.cpu).toMatchObject({ busyPct: 30, perCore: [30], userPct: 20, systemPct: 10, iowaitPct: 20, stealPct: 0, load1: 1, load5: 2, load15: 3 });
        expect(second.sample.network).toMatchObject({ rxBps: 1000, txBps: 2000, interfaces: [{ id: 'eth0', included: true }, { id: 'veth0', included: false }] });
        expect(second.sample.memory).toMatchObject({ composition: expect.any(Array), pressure: { level: 'calm', source: 'psi' } });
        expect(MachineVitalsSampleV1Schema.safeParse(second.sample).success).toBe(true);
    });

    it('does not re-read non-directory bind mounts as volumes during a settled minute', async () => {
        const f = await fixture();
        await f.put('/etc/hosts', '127.0.0.1 localhost\n');
        await f.put('/proc/self/mountinfo', [
            '1 0 8:1 / / rw - ext4 /dev/sda rw',
            '2 1 8:2 / /data rw - ext4 /dev/sdb rw',
            '3 1 8:3 /container/hosts /etc/hosts rw - ext4 /dev/sdc rw',
            '',
        ].join('\n'));
        const capacityReads: string[] = [];
        const reader = createLinuxMachineVitalsReader({ root: f.root, homePath: '/home/cua', statfs: async path => {
            capacityReads.push(path);
            return { bsize: 4096, blocks: 1000, bfree: 500, bavail: 400, files: 100, ffree: 50 };
        } });

        for (let sample = 0; sample < 30; sample++) await reader.read(input(sample * 2000));

        expect(capacityReads.filter(path => path.endsWith('/etc/hosts')),
            'non-directory volume capacity reads per settled minute').toHaveLength(0);
    });

    it('does not charge reclaimable cache against resident apps and kernel in the used-memory composition', async () => {
        const f = await fixture();
        await f.put('/proc/meminfo', 'MemTotal: 100000 kB\nMemAvailable: 70000 kB\nMemFree: 20000 kB\nBuffers: 2000 kB\nCached: 45000 kB\nSReclaimable: 5000 kB\nAnonPages: 27000 kB\nShmem: 1000 kB\nSlab: 6000 kB\nKernelStack: 100 kB\nPageTables: 400 kB\n');
        const reader = createLinuxMachineVitalsReader({ root: f.root });
        const result = await reader.read(input(0));
        expect(result.state).toBe('reporting');
        if (result.state !== 'reporting') return;
        expect(result.sample.memory).toMatchObject({
            availableBytes: 70000 * 1024,
            usedBytes: 30000 * 1024,
            composition: [
                { kind: 'apps', bytes: 28000 * 1024 },
                { kind: 'kernel', bytes: 1500 * 1024 },
                { kind: 'cached_files', bytes: 500 * 1024 },
            ],
        });
        expect(MachineVitalsSampleV1Schema.safeParse(result.sample).success).toBe(true);
    });

    it.each([
        ['full stalls', 'some avg60=0\nfull avg60=0.01\n', 'pswpin 0\npswpout 0\noom_kill 0\n', 40000, 'critical'],
        ['some stalls and swapping', 'some avg60=0.01\nfull avg60=0\n', 'pswpin 1\npswpout 0\noom_kill 0\n', 40000, 'elevated'],
        ['OOM', 'some avg60=0\nfull avg60=0\n', 'pswpin 0\npswpout 0\noom_kill 1\n', 40000, 'critical'],
        ['min watermarks', 'some avg60=0\nfull avg60=0\n', 'pswpin 0\npswpout 0\noom_kill 0\n', 40, 'critical'],
        ['high watermarks', 'some avg60=0\nfull avg60=0\n', 'pswpin 0\npswpout 0\noom_kill 0\n', 120, 'elevated'],
    ] as const)('derives pressure from %s', async (_name, psi, vmstat, available, expected) => {
        const f = await fixture();
        const reader = createLinuxMachineVitalsReader({ root: f.root });
        await reader.read(input(0));
        await f.put('/proc/pressure/memory', psi);
        await f.put('/proc/vmstat', vmstat);
        await f.put('/proc/meminfo', `MemTotal: 100000 kB\nMemAvailable: ${available} kB\nSwapTotal: 10000 kB\nSwapFree: 8000 kB\n`);
        const result = await reader.read(input(2000));
        expect(result.state).toBe('reporting');
        if (result.state === 'reporting') expect(result.sample.memory).toMatchObject({ pressure: { level: expected, source: 'psi' } });
    });

    it('uses the tightest ancestor cgroup memory/high and fractional CPU quota with working-set memory', async () => {
        const f = await fixture();
        await f.put('/proc/self/cgroup', '0::/parent/child\n');
        await f.put('/proc/self/mountinfo', '1 0 0:1 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n2 0 8:1 / / rw - ext4 /dev/sda rw\n');
        await f.put('/sys/fs/cgroup/parent/memory.max', '50000000');
        await f.put('/sys/fs/cgroup/parent/memory.high', '40000000');
        await f.put('/sys/fs/cgroup/parent/cpu.max', '50000 100000');
        await f.put('/sys/fs/cgroup/parent/cpu.stat', 'nr_throttled 0\n');
        await f.put('/sys/fs/cgroup/parent/memory.events', 'oom_kill 0\nhigh 0\n');
        await f.put('/sys/fs/cgroup/parent/pids.max', '5');
        await f.put('/sys/fs/cgroup/parent/pids.current', '5');
        await f.put('/sys/fs/cgroup/parent/child/memory.max', '80000000');
        await f.put('/sys/fs/cgroup/parent/child/memory.current', '30000000');
        await f.put('/sys/fs/cgroup/parent/child/memory.stat', 'inactive_file 10000000\n');
        await f.put('/sys/fs/cgroup/parent/child/pids.current', '1');
        await f.put('/sys/fs/cgroup/parent/child/memory.pressure', 'some avg60=0\nfull avg60=0\n');
        await f.put('/sys/fs/cgroup/parent/child/memory.events', 'oom_kill 0\nhigh 0\n');
        await f.put('/sys/fs/cgroup/parent/child/cpu.stat', 'usage_usec 1000000\nuser_usec 600000\nsystem_usec 400000\nnr_throttled 0\n');
        const reader = createLinuxMachineVitalsReader({ root: f.root });
        await reader.read(input(0));
        await f.put('/sys/fs/cgroup/parent/child/cpu.stat', 'usage_usec 1500000\nuser_usec 900000\nsystem_usec 600000\nnr_throttled 0\n');
        await f.put('/sys/fs/cgroup/parent/cpu.stat', 'nr_throttled 1\n');
        await f.put('/sys/fs/cgroup/parent/memory.events', 'oom_kill 0\nhigh 1\n');
        const result = await reader.read(input(2000));
        expect(result.state).toBe('reporting');
        if (result.state !== 'reporting') return;
        expect(result.sample.memory).toMatchObject({ totalBytes: 40000000, usedBytes: 20000000, availableBytes: 20000000, limitSource: 'cgroup', pressure: { level: 'elevated' } });
        expect(result.sample.cpu).toMatchObject({ busyPct: 50, userPct: 30, systemPct: 20, throttled: true, perCoreNotReportedReason: 'container' });
        expect(result.host.effectiveCores).toBe(0.5);
        expect(result.sample.limits).toMatchObject({ processes: { used: 5, max: 5 } });
    });

    it('uses host PSI for v1 limits and falls back to events where PSI is unavailable', async () => {
        const f = await fixture();
        await f.put('/proc/self/cgroup', '5:memory:/child\n');
        await f.put('/proc/self/mountinfo', '1 0 0:1 / /sys/fs/cgroup/memory rw - cgroup cgroup rw,memory\n');
        await f.put('/sys/fs/cgroup/memory/child/memory.limit_in_bytes', '40000000');
        await f.put('/sys/fs/cgroup/memory/child/memory.usage_in_bytes', '30000000');
        await f.put('/sys/fs/cgroup/memory/child/memory.stat', 'total_inactive_file 10000000\n');
        await f.put('/proc/pressure/memory', 'some avg60=0\nfull avg60=0.01\n');
        const result = await createLinuxMachineVitalsReader({ root: f.root }).read(input(0));
        expect(result.state).toBe('reporting');
        if (result.state === 'reporting') expect(result.sample.memory).toMatchObject({ totalBytes: 40000000, usedBytes: 20000000, pressure: { level: 'critical', source: 'psi' } });
        await rm(join(f.root, '/proc/pressure/memory'));
        const reader = createLinuxMachineVitalsReader({ root: f.root });
        await reader.read(input(0));
        await f.put('/proc/vmstat', 'oom_kill 1\npswpin 0\npswpout 0\n');
        const fallback = await reader.read(input(2000));
        expect(fallback.state).toBe('reporting');
        if (fallback.state === 'reporting') expect(fallback.sample.memory).toMatchObject({ pressure: { level: 'critical', source: 'events' } });
    });

    it('keeps short-span baselines and clears stale, decreasing and changed-interface rates', async () => {
        const f = await fixture();
        const reader = createLinuxMachineVitalsReader({ root: f.root });
        await reader.read(input(0));
        await f.put('/proc/net/dev', 'eth0: 1500 0 0 0 0 0 0 0 2500 0 0 0 0 0 0 0\nveth0: 9000 0 0 0 0 0 0 0 9000 0 0 0 0 0 0 0\n');
        const short = await reader.read(input(500));
        expect(short.state).toBe('reporting');
        if (short.state === 'reporting') expect(short.sample.network).toMatchObject({ rxBps: null });
        await f.put('/proc/net/dev', 'eth0: 3000 0 0 0 0 0 0 0 4000 0 0 0 0 0 0 0\nveth0: 9000 0 0 0 0 0 0 0 9000 0 0 0 0 0 0 0\n');
        const rate = await reader.read(input(2000));
        expect(rate.state).toBe('reporting');
        if (rate.state === 'reporting') expect(rate.sample.network).toMatchObject({ rxBps: 1000 });
        const stale = await reader.read(input(122_001));
        expect(stale.state).toBe('reporting');
        if (stale.state === 'reporting') expect(stale.sample.network).toMatchObject({ rxBps: null });
        await f.put('/proc/net/dev', 'eth0: 1 0 0 0 0 0 0 0 1 0 0 0 0 0 0 0\n');
        const reset = await reader.read(input(124_001));
        expect(reset.state).toBe('reporting');
        if (reset.state === 'reporting') expect(reset.sample.network).toMatchObject({ rxBps: null });
        await f.put('/proc/net/dev', 'eth1: 3000 0 0 0 0 0 0 0 4000 0 0 0 0 0 0 0\n');
        const change = await reader.read(input(126_001));
        expect(change.state).toBe('reporting');
        if (change.state === 'reporting') expect(change.sample.network).toMatchObject({ rxBps: null });
    });

    it.each(['decrease', 'interface_change'] as const)('rejects %s before selecting an older baseline for a slower cadence', async (change) => {
        const f = await fixture();
        const reader = createLinuxMachineVitalsReader({ root: f.root });
        const network = (id: string, bytes: number) => f.put('/proc/net/dev', `${id}: ${bytes} 0 0 0 0 0 0 0 ${bytes} 0 0 0 0 0 0 0\n`);
        await network('eth0', 1_000);
        await reader.read({ ...input(0), intervalMs: 60_000 });
        for (let t = 2_000; t <= 12_000; t += 2_000) {
            await network('eth0', 1_000 + t);
            await reader.read(input(t));
        }
        // Even without a cadence change, select the newest eligible real observation.
        expect(await reader.read(input(12_500))).toMatchObject({
            state: 'reporting', sample: { network: { rxBps: 800, txBps: 800 } },
        });
        // This is above the older eligible counter, but below the latest one.
        await network(change === 'interface_change' ? 'eth1' : 'eth0', 12_000);
        expect(await reader.read({ ...input(14_000), intervalMs: 15_000 })).toMatchObject({
            state: 'reporting', sample: { network: { rxBps: null, txBps: null } },
        });
        // Catching up past the pre-reset value cannot revive that old history.
        await network(change === 'interface_change' ? 'eth1' : 'eth0', 15_000);
        expect(await reader.read({ ...input(16_000), intervalMs: 15_000 })).toMatchObject({
            state: 'reporting', sample: { network: { rxBps: null, txBps: null } },
        });
    });

    it('averages from the newest eligible observation and rejects clock regressions and short-span resets', async () => {
        const f = await fixture();
        const reader = createLinuxMachineVitalsReader({ root: f.root });
        const read = async (t: number, bytes: number, intervalMs = 2_000) => {
            await f.put('/proc/net/dev', `eth0: ${bytes} 0 0 0 0 0 0 0 ${bytes} 0 0 0 0 0 0 0\n`);
            return reader.read(input(t, false, intervalMs));
        };
        expect(await read(0, 0)).toMatchObject({ sample: { network: { rxBps: null } } });
        expect(await read(500, 100)).toMatchObject({ sample: { network: { rxBps: null } } });
        expect(await read(1_500, 1_100)).toMatchObject({ sample: { network: { rxBps: 1_000 } } });
        expect(await read(2_000, 1_500)).toMatchObject({ sample: { network: { rxBps: 1_400 / 1.5 } } });
        expect(await read(1_999, 1_600)).toMatchObject({ sample: { network: { rxBps: null } } });
        expect(await read(3_000, 2_601)).toMatchObject({ sample: { network: { rxBps: 1_000 } } });
        expect(await read(3_500, 100)).toMatchObject({ sample: { network: { rxBps: null } } });
        expect(await read(4_000, 3_000)).toMatchObject({ sample: { network: { rxBps: null } } });
        expect(await read(5_000, 4_000)).toMatchObject({ sample: { network: { rxBps: 1_000 } } });
        expect(await read(125_000, 124_000)).toMatchObject({ sample: { network: { rxBps: 1_000 } } });
        expect(await read(245_001, 244_001)).toMatchObject({ sample: { network: { rxBps: null } } });
    });

    it('keeps counted network rates through excluded churn and resets when membership becomes counted', async () => {
        const f = await fixture();
        const reader = createLinuxMachineVitalsReader({ root: f.root });
        const read = async (t: number, excluded: string) => {
            await f.put('/proc/net/dev', `eth0: ${1_000 + t} 0 0 0 0 0 0 0 ${2_000 + t} 0 0 0 0 0 0 0\n${excluded}`);
            return reader.read(input(t));
        };
        await read(0, 'veth0: 9000 0 0 0 0 0 0 0 9000 0 0 0 0 0 0 0\n');
        expect(await read(2_000, 'veth1: 1 0 0 0 0 0 0 0 1 0 0 0 0 0 0 0\n')).toMatchObject({ sample: { network: { rxBps: 1_000 } } });
        expect(await read(4_000, '')).toMatchObject({ sample: { network: { rxBps: 1_000 } } });
        await f.put('/sys/class/net/eth0/master/uevent', 'INTERFACE=bond0\n');
        expect(await read(6_000, '')).toMatchObject({ sample: { network: { rxBps: null } } });
        await rm(join(f.root, '/sys/class/net/eth0/master/uevent'));
        expect(await read(8_000, '')).toMatchObject({ sample: { network: { rxBps: null } } });
    });

    it('deduplicates mounts by device and uses unprivileged bytes, reserved bytes and inode exhaustion', async () => {
        const f = await fixture();
        await Promise.all(['/data', '/home/alice2'].map(path => mkdir(join(f.root, path), { recursive: true })));
        await f.put('/proc/self/mountinfo', '1 0 8:1 / / rw - ext4 /dev/sda rw\n2 1 8:1 / /bind rw - ext4 /dev/sda rw\n3 1 8:2 / /data rw - ext4 /dev/sdb rw\n4 1 8:2 /homes /home rw - ext4 /dev/sdb rw\n5 1 8:3 / /home/alice2 rw - ext4 /dev/sdc rw\n');
        const reader = createLinuxMachineVitalsReader({ root: f.root, homePath: '/home/alice', statfs: async () => ({ bsize: 4096, blocks: 100, bfree: 30, bavail: 20, files: 50, ffree: 0 }) });
        const result = await reader.read(input(0));
        expect(result.state).toBe('reporting');
        if (result.state === 'reporting') expect(result.sample.disk).toMatchObject({ reported: true, homeVolumeId: '8:2', volumes: [
            { id: '8:1', mount: '/', totalBytes: 409600, availableBytes: 81920, reservedBytes: 40960, inodesExhausted: true },
            { id: '8:2', mount: '/data', totalBytes: 409600, availableBytes: 81920 },
            { id: '8:3', mount: '/home/alice2', totalBytes: 409600, availableBytes: 81920 },
        ] });
    });

    it('excludes read-only and ISO mounts from capacity warnings without hiding a writable bind of the same device', async () => {
        const f = await fixture();
        await mkdir(join(f.root, '/writable-data'), { recursive: true });
        await f.put('/proc/self/mountinfo', [
            '1 0 8:1 / / rw - ext4 /dev/sda rw',
            '2 1 11:0 / /mnt/lima-cidata ro - iso9660 /dev/sr0 ro',
            '3 1 8:2 / /readonly ro - ext4 /dev/sdb rw',
            '4 1 8:2 / /writable-data rw - ext4 /dev/sdb rw',
            '5 1 8:3 / /superblock-readonly rw - ext4 /dev/sdc ro',
            '6 1 0:1 / /pseudo rw - tmpfs tmpfs rw',
            '7 1 11:1 / /iso rw - iso9660 /dev/sr1 rw',
            '8 1 11:2 / /dvd rw - udf /dev/sr2 rw',
        ].join('\n'));
        const reader = createLinuxMachineVitalsReader({ root: f.root, homePath: '/writable-data/alice',
            statfs: async (path) => ({ bsize: 4096, blocks: 1_000_000, bfree: path.endsWith('/writable-data') || path === f.root + '/' ? 800_000 : 0,
                bavail: path.endsWith('/writable-data') || path === f.root + '/' ? 720_000 : 0, files: 50, ffree: 10 }),
        });
        const result = await reader.read(input(0));
        expect(result.state).toBe('reporting');
        if (result.state !== 'reporting') return;
        const sample = MachineVitalsSampleV1Schema.parse(result.sample);
        expect(sample.disk).toMatchObject({ reported: true, homeVolumeId: '8:2', volumes: [
            { id: '8:1', mount: '/' }, { id: '8:2', mount: '/writable-data' },
        ] });
        expect(deriveMachineVitalsAttentionV1({ recent: [sample], previous: [], nearlyFull: { freeFraction: 0.1 } }))
            .not.toEqual(expect.arrayContaining([expect.objectContaining({ metric: 'disk' })]));
    });

    it('reads files and ptys each tick but reads thermal/GPU/inotify only for Overview', async () => {
        const f = await fixture();
        await f.put('/proc/sys/fs/file-nr', '20 2 100');
        await f.put('/proc/sys/kernel/pty/nr', '5');
        await f.put('/proc/sys/kernel/pty/max', '20');
        await f.put('/sys/class/thermal/thermal_zone0/temp', '45000');
        await f.put('/sys/class/thermal/thermal_zone0/type', 'x86_pkg_temp');
        await f.put('/sys/class/drm/card0/device/gpu_busy_percent', '25');
        const reader = createLinuxMachineVitalsReader({ root: f.root });
        const idle = await reader.read(input(0));
        expect(idle.state).toBe('reporting');
        if (idle.state !== 'reporting') return;
        expect(idle.sample.limits).toMatchObject({ files: { used: 18, max: 100 }, ptys: { used: 5, max: 20 } });
        expect(idle.sample.thermal).toBeUndefined();
        expect(idle.sample.gpu).toBeUndefined();
        const overview = await reader.read(input(2000, true));
        expect(overview.state).toBe('reporting');
        if (overview.state === 'reporting') {
            expect(overview.sample.thermal).toMatchObject({ tempC: 45 });
            expect(overview.sample.gpu).toEqual([{ name: 'card0', busyPct: 25 }]);
        }
    });

    it('runs NVIDIA only when an Overview asks, a device exists and nvidia-smi is executable on PATH', async () => {
        const f = await fixture();
        await f.put('/usr/bin/nvidia-smi', 'fixture');
        await chmod(join(f.root, '/usr/bin/nvidia-smi'), 0o700);
        const calls: string[] = [];
        const reader = createLinuxMachineVitalsReader({ root: f.root, toolPath: '/usr/bin',
            execFile: async (command) => { calls.push(command); return { stdout: 'NVIDIA Test, 42, 100, 1000\n', stderr: '' }; },
        });
        await reader.read(input(0, true));
        expect(calls).toEqual([]);
        await f.put('/proc/driver/nvidia/gpus/0000:00:01.0/information', 'Model: NVIDIA Test');
        await reader.read(input(2000, false));
        expect(calls).toEqual([]);
        const result = await reader.read(input(4000, true));
        expect(result.state).toBe('reporting');
        expect(calls).toHaveLength(1);
        if (result.state === 'reporting') expect(result.sample.gpu).toEqual([{ name: 'NVIDIA Test', busyPct: 42, memUsedBytes: 104857600, memTotalBytes: 1048576000 }]);
    });

    it.each(['pid', 'fd', 'fdinfo'] as const)('continues the inotify walk after a vanished %s and does no walk without Overview demand', async vanished => {
        const f = await fixture();
        await f.put('/proc/sys/fs/inotify/max_user_watches', '100');
        const status = `Uid:\t${process.getuid?.() ?? 0}\t0\t0\t0\n`;
        await f.put('/proc/123/status', status);
        await f.put('/proc/456/status', status);
        await mkdir(join(f.root, '/proc/456/fd'), { recursive: true });
        await symlink('anon_inode:inotify', join(f.root, '/proc/456/fd/3'));
        await f.put('/proc/456/fdinfo/3', 'inotify wd:1 ino:1\ninotify wd:2 ino:2\n');
        if (vanished !== 'pid') {
            await mkdir(join(f.root, '/proc/123/fd'), { recursive: true });
            await symlink('anon_inode:inotify', join(f.root, '/proc/123/fd/3'));
        }
        const reader = createLinuxMachineVitalsReader({ root: f.root });
        const walk = vi.spyOn(filesystem, 'readlink');
        try {
            const idle = await reader.read(input(0));
            expect(idle.state).toBe('reporting');
            expect(walk.mock.calls.filter(([path]) => String(path).includes('/proc/'))).toHaveLength(0);
            if (vanished === 'fd') {
                // OS boundary: the fd closes after its directory entry was returned.
                walk.mockImplementationOnce(async () => {
                    await rm(join(f.root, '/proc/123/fd/3'));
                    throw Object.assign(new Error('Descriptor vanished'), { code: 'ENOENT' });
                });
            }
            const result = await reader.read(input(2000, true));
            expect(result.state).toBe('reporting');
            if (result.state === 'reporting') expect(result.sample.limits?.inotify).toEqual({ used: 2, max: 100 });
        } finally { walk.mockRestore(); }
    });

    it.each(['status', 'fd', 'fdinfo'] as const)('omits inotify counts when same-UID %s is permission-limited, rather than publishing a subtotal', async deniedPart => {
        const f = await fixture();
        await f.put('/proc/sys/fs/inotify/max_user_watches', '100');
        for (const pid of ['123', '456']) {
            await f.put(`/proc/${pid}/status`, `Uid:\t${process.getuid?.() ?? 0}\t0\t0\t0\n`);
            await mkdir(join(f.root, `/proc/${pid}/fd`), { recursive: true });
            await symlink('anon_inode:inotify', join(f.root, `/proc/${pid}/fd/3`));
            await f.put(`/proc/${pid}/fdinfo/3`, 'inotify wd:1 ino:1\n');
        }
        const readDirectory = filesystem.readdir;
        const readContents = filesystem.readFile;
        // OS boundary: chmod is not a reliable EACCES fixture when the executor is privileged.
        const denied = vi.spyOn(filesystem, 'readdir').mockImplementation(async (...args) => {
            if (deniedPart === 'fd' && String(args[0]) === join(f.root, '/proc/456/fd')) throw Object.assign(new Error('Permission denied'), { code: 'EACCES' });
            return readDirectory(...args);
        });
        const deniedRead = vi.spyOn(filesystem, 'readFile').mockImplementation((...args) => {
            const deniedPath = deniedPart === 'status' ? '/proc/456/status' : '/proc/456/fdinfo/3';
            if (deniedPart !== 'fd' && String(args[0]) === join(f.root, deniedPath))
                return Promise.reject(Object.assign(new Error('Permission denied'), { code: 'EACCES' }));
            return readContents(...args);
        });
        try {
            const result = await createLinuxMachineVitalsReader({ root: f.root }).read(input(0, true));
            expect(result.state).toBe('reporting');
            if (result.state === 'reporting') expect(MachineVitalsSampleV1Schema.parse(result.sample).limits?.inotify).toBeUndefined();
        } finally { deniedRead.mockRestore(); denied.mockRestore(); }
    });

    it('settles unexpected inotify IO failure through reader_failed instead of a successful subtotal', async () => {
        const f = await fixture();
        await f.put('/proc/sys/fs/inotify/max_user_watches', '100');
        await f.put('/proc/123/status', `Uid:\t${process.getuid?.() ?? 0}\t0\t0\t0\n`);
        const readDirectory = filesystem.readdir;
        const failed = vi.spyOn(filesystem, 'readdir').mockImplementation((...args) => {
            if (String(args[0]) === join(f.root, '/proc/123/fd'))
                return Promise.reject(Object.assign(new Error('IO failure'), { code: 'EIO' }));
            return readDirectory(...args);
        });
        try { expect(await createLinuxMachineVitalsReader({ root: f.root }).read(input(0, true)))
            .toEqual({ state: 'unavailable', reason: 'reader_failed' }); }
        finally { failed.mockRestore(); }
    });

    it('reports inotify watches when same-user process descriptors are completely readable', async () => {
        const f = await fixture();
        await f.put('/proc/sys/fs/inotify/max_user_watches', '100');
        await f.put('/proc/123/status', `Uid:\t${process.getuid?.() ?? 0}\t0\t0\t0\n`);
        const reader = createLinuxMachineVitalsReader({ root: f.root });
        await mkdir(join(f.root, '/proc/123/fd'), { recursive: true });
        await symlink('anon_inode:inotify', join(f.root, '/proc/123/fd/3'));
        await symlink('/tmp/regular-file', join(f.root, '/proc/123/fd/4'));
        await f.put('/proc/123/fdinfo/3', 'pos:\t0\nflags:\t02000000\ninotify wd:1 ino:1\ninotify wd:2 ino:2\n');
        await f.put('/proc/456/status', `Uid:\t${(process.getuid?.() ?? 0) + 1}\t0\t0\t0\n`);
        await mkdir(join(f.root, '/proc/456/fd'), { recursive: true });
        await symlink('anon_inode:inotify', join(f.root, '/proc/456/fd/3'));
        await f.put('/proc/456/fdinfo/3', 'inotify wd:3 ino:3\n');
        const complete = await reader.read(input(2000, true));
        expect(complete.state).toBe('reporting');
        if (complete.state === 'reporting') expect(complete.sample.limits?.inotify).toEqual({ used: 2, max: 100 });
    });
});
