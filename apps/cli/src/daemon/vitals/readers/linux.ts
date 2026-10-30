import { constants } from 'node:fs';
import { access, lstat, readFile, readdir, readlink, statfs as readStatfs } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { endianness, homedir } from 'node:os';

import type { MachineVitalsHostFactsV1, MachineVitalsSampleV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsSampleV1';
import type { execFileWithDeadline } from '@happier-dev/cli-common/process';
import { readLinuxBatteryFacts } from '@happier-dev/cli-common/process';

import { createCounterRateReader } from './counterRates';
import { readLinuxInotifyWatches } from './linuxInotify';
import { NVIDIA_VITALS_ARGS, parseNvidiaVitalsGpu } from './extras/gpu';
import type { MachineVitalsReader, MachineVitalsReaderInput } from './types';

type VolumeStats = { bsize: number; blocks: number; bfree: number; bavail: number; files: number; ffree: number };
export interface LinuxMachineVitalsReaderOptions {
    root?: string;
    homePath?: string;
    /** OS filesystem-capacity boundary; proc/sys parsing always stays real. */
    statfs?: (path: string) => Promise<VolumeStats>;
    readBattery?: () => Promise<MachineVitalsSampleV1['battery']>;
    toolPath?: string;
    execFile?: typeof execFileWithDeadline;
    signal?: AbortSignal;
}
type Mount = { device: string; root: string; mount: string; kind: string; source: string; options: string };
type CpuCounters = { busy: number; total: number; user: number; system: number; iowait: number; steal: number };
type Cgroup = { memoryPath?: string; cpuPath?: string; root?: string; version: 1 | 2; memoryLimit?: number; quotaCores?: number; current?: number; inactiveFile: number; events: Record<string, number>; usageUsec?: number; userUsec?: number; systemUsec?: number; throttles?: Record<string, number>; pids?: { used: number; max: number }; pressure?: string; swap?: { totalBytes: number; usedBytes: number } };
const missing = { reported: false, reason: 'unavailable' } as const;
const clampPct = (value: number) => Math.round(Math.max(0, Math.min(100, value)) * 10) / 10;
const decodeMount = (value: string) => value.replace(/\\([0-7]{3})/gu, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));

function keyedNumbers(raw: string | null, multiplier = 1): Record<string, number> {
    const result: Record<string, number> = {};
    for (const line of raw?.split('\n') ?? []) {
        const match = /^\s*([^\s:]+):?\s+(\d+)/u.exec(line);
        if (match) result[match[1]] = Number(match[2]) * multiplier;
    }
    return result;
}

function parseMounts(raw: string | null): Mount[] {
    const mounts: Mount[] = [];
    for (const line of raw?.split('\n') ?? []) {
        const [before, after] = line.split(' - ');
        if (!after) continue;
        const fields = before.split(' '), tail = after.split(' ');
        if (fields.length < 6 || tail.length < 3) continue;
        mounts.push({ device: fields[2], root: decodeMount(fields[3]), mount: decodeMount(fields[4]), kind: tail[0], source: decodeMount(tail[1]), options: `${fields[5]},${tail[2]}` });
    }
    return mounts;
}

function parseCpu(raw: string | null): Record<string, CpuCounters> {
    const result: Record<string, CpuCounters> = {};
    for (const line of raw?.split('\n') ?? []) {
        const match = /^(cpu\d*)\s+(.+)$/u.exec(line);
        if (!match) continue;
        const values = match[2].trim().split(/\s+/u).map(Number);
        if (values.length < 4 || values.some((value) => !Number.isFinite(value) || value < 0)) continue;
        const [user, nice, system, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = values;
        // guest and guest_nice already belong to user/nice and must not be counted twice.
        result[match[1]] = { busy: user + nice + system + irq + softirq + steal, total: user + nice + system + idle + iowait + irq + softirq + steal, user: user + nice, system: system + irq + softirq, iowait, steal };
    }
    return result;
}

function psiAvg60(raw: string | null | undefined, kind: 'full' | 'some'): number {
    const line = raw?.split('\n').find((value) => value.startsWith(`${kind} `));
    return Number(/\bavg60=([\d.]+)/u.exec(line ?? '')?.[1] ?? 0);
}

export function createLinuxMachineVitalsReader(options: LinuxMachineVitalsReaderOptions = {}): MachineVitalsReader {
    const at = (path: string) => options.root ? join(options.root, path) : path;
    const text = async (path: string): Promise<string | null> => { try { return await readFile(at(path), 'utf8'); } catch { return null; } };
    const list = async (path: string): Promise<string[]> => { try { return await readdir(at(path)); } catch { return []; } };
    const statfs = options.statfs ?? readStatfs;
    const cpuRates = createCounterRateReader(), networkRates = createCounterRateReader(), eventRates = createCounterRateReader(), containerRates = createCounterRateReader();
    const excludedNetworkRates = createCounterRateReader();
    let topology: { clusters?: ('p' | 'e')[]; performanceCores?: number; efficiencyCores?: number; sockets?: number } | undefined;
    let topologyCoreCount: number | undefined;
    let pageSize: number | undefined;
    const nvidiaNames = new Map<string, string>();

    async function kernelPageSize(): Promise<number> {
        try {
            const auxv = await readFile(at('/proc/self/auxv'));
            const wordBytes = process.arch === 'ia32' || process.arch === 'arm' ? 4 : 8;
            const word = (offset: number) => wordBytes === 8
                ? Number(endianness() === 'LE' ? auxv.readBigUInt64LE(offset) : auxv.readBigUInt64BE(offset))
                : endianness() === 'LE' ? auxv.readUInt32LE(offset) : auxv.readUInt32BE(offset);
            for (let offset = 0; offset + wordBytes * 2 <= auxv.length; offset += wordBytes * 2) {
                if (word(offset) === 6) return word(offset + wordBytes); // Linux AT_PAGESZ, independent of mapping huge-page sizes.
            }
        } catch { /* Without the kernel page size, zone watermarks remain unavailable. */ }
        return 0;
    }

    async function cgroup(mounts: Mount[], hostMemory: number): Promise<Cgroup | undefined> {
        const raw = await text('/proc/self/cgroup');
        const entries = (raw?.split('\n') ?? []).map((line) => line.split(':')).filter((entry) => entry.length === 3);
        const unified = entries.find((entry) => entry[0] === '0' && entry[1] === '');
        const unifiedMount = mounts.find((mount) => mount.kind === 'cgroup2');
        const resolvePath = (entryPath: string, mount: Mount) => {
            const relative = posix.relative(mount.root, entryPath);
            if (relative === '..' || relative.startsWith('../')) return undefined;
            return posix.join(mount.mount, relative);
        };
        if (unified && unifiedMount) {
            const leaf = resolvePath(unified[2], unifiedMount);
            if (!leaf) return undefined;
            let memoryLimit = hostMemory, quotaCores: number | undefined;
            let pids: Cgroup['pids'];
            const events: Record<string, number> = {}, throttles: Record<string, number> = {};
            for (let path = leaf; ; path = dirname(path)) {
                const [max, high, cpuMax, pidMax, pidUsed] = await Promise.all([text(`${path}/memory.max`), text(`${path}/memory.high`), text(`${path}/cpu.max`), text(`${path}/pids.max`), text(`${path}/pids.current`)]);
                for (const value of [max, high]) {
                    if (value !== null && /^\d+\s*$/u.test(value)) memoryLimit = Math.min(memoryLimit, Number(value));
                }
                const quota = cpuMax?.trim().split(/\s+/u);
                const hasQuota = quota?.length === 2 && quota[0] !== 'max' && Number(quota[0]) > 0 && Number(quota[1]) > 0;
                if (hasQuota) {
                    quotaCores = Math.min(quotaCores ?? Infinity, Number(quota[0]) / Number(quota[1]));
                    // CFS throttle counters are local: an ancestor quota can stop this leaf without changing its nr_throttled.
                    const stats = keyedNumbers(await text(`${path}/cpu.stat`));
                    if (stats.nr_throttled !== undefined) throttles[`throttle:${path}`] = stats.nr_throttled;
                }
                if (path === leaf || [max, high].some((value) => value !== null && /^\d+\s*$/u.test(value) && Number(value) < hostMemory)) {
                    const scoped = keyedNumbers(await text(`${path}/memory.events`));
                    for (const key of ['oom_kill', 'high']) if (scoped[key] !== undefined) events[`${key}:${path}`] = scoped[key];
                }
                if (pidMax !== null && /^\d+\s*$/u.test(pidMax) && pidUsed !== null) {
                    const candidate = { used: Number(pidUsed), max: Number(pidMax) };
                    // A process is admitted against every ancestor's count, not the leaf's count against an ancestor's max.
                    if (!pids || candidate.max - candidate.used < pids.max - pids.used) pids = candidate;
                }
                if (path === unifiedMount.mount || path === '/') break;
            }
            const [current, stats, cpu, pressure, swapMax, swapCurrent] = await Promise.all([
                text(`${leaf}/memory.current`), text(`${leaf}/memory.stat`), text(`${leaf}/cpu.stat`),
                text(`${leaf}/memory.pressure`), text(`${leaf}/memory.swap.max`), text(`${leaf}/memory.swap.current`),
            ]);
            const cpuStats = keyedNumbers(cpu);
            return { version: 2, memoryPath: leaf, cpuPath: leaf, root: unifiedMount.mount, memoryLimit: memoryLimit < hostMemory ? memoryLimit : undefined,
                quotaCores, current: current !== null ? Number(current) : undefined, inactiveFile: keyedNumbers(stats).inactive_file ?? 0,
                events, usageUsec: cpuStats.usage_usec, userUsec: cpuStats.user_usec, systemUsec: cpuStats.system_usec, throttles, pressure: pressure ?? undefined,
                pids,
                swap: swapMax !== null && /^\d+\s*$/u.test(swapMax) && swapCurrent !== null ? { totalBytes: Number(swapMax), usedBytes: Number(swapCurrent) } : undefined,
            };
        }
        const memoryEntry = entries.find((entry) => entry[1].split(',').includes('memory'));
        const memoryMount = mounts.find((mount) => mount.kind === 'cgroup' && mount.options.split(',').includes('memory'));
        if (!memoryEntry || !memoryMount) return undefined;
        const leaf = resolvePath(memoryEntry[2], memoryMount);
        if (!leaf) return undefined;
        let memoryLimit = hostMemory;
        for (let path = leaf; ; path = dirname(path)) {
            const limit = await text(`${path}/memory.limit_in_bytes`);
            if (limit !== null && Number(limit) > 0) memoryLimit = Math.min(memoryLimit, Number(limit));
            if (path === memoryMount.mount || path === '/') break;
        }
        const [current, stats] = await Promise.all([text(`${leaf}/memory.usage_in_bytes`), text(`${leaf}/memory.stat`)]);
        const memoryStats = keyedNumbers(stats);
        return { version: 1, memoryPath: leaf, memoryLimit: memoryLimit < hostMemory ? memoryLimit : undefined, current: current === null ? undefined : Number(current), inactiveFile: memoryStats.total_inactive_file ?? memoryStats.inactive_file ?? 0, events: {} };
    }

    async function volumes(mounts: Mount[]): Promise<MachineVitalsSampleV1['disk']> {
        const seen = new Set<string>();
        const result: Extract<MachineVitalsSampleV1['disk'], { reported: true }>['volumes'] = [];
        for (const mount of [...mounts].sort((a, b) => a.mount.length - b.mount.length)) {
            if (seen.has(mount.device) || mount.options.split(',').includes('ro')
                || /^(?:proc|sysfs|devtmpfs|devpts|tmpfs|cgroup2?|securityfs|debugfs|tracefs|pstore|mqueue|hugetlbfs|configfs|fusectl|autofs|squashfs|iso9660|udf|nsfs|ramfs|rpc_pipefs|nfs4?|cifs|smb3)$/u.test(mount.kind)) continue;
            if (mount.mount !== '/' && (!mount.source.startsWith('/dev/') || mount.mount.startsWith('/sys/') || mount.mount.startsWith('/proc/') || mount.mount.startsWith('/dev/'))) continue;
            try {
                // Docker exposes files such as /etc/hosts as writable device-backed
                // mounts. They have capacity facts, but they are not volumes and
                // cannot own Storage roots such as .happier-trash-<uid>.
                if (!(await lstat(at(mount.mount))).isDirectory()) continue;
                const stats = await statfs(at(mount.mount));
                seen.add(mount.device);
                result.push({ id: mount.device, label: mount.mount, mount: mount.mount, totalBytes: stats.blocks * stats.bsize,
                    availableBytes: stats.bavail * stats.bsize, reservedBytes: Math.max(0, stats.bfree - stats.bavail) * stats.bsize,
                    inodesExhausted: stats.files > 0 && stats.ffree === 0 });
            } catch { /* A departed or inaccessible volume is not a zero-capacity disk. */ }
        }
        const home = posix.normalize(options.homePath ?? homedir());
        const homeMount = mounts.filter((mount) => home === mount.mount || home.startsWith(mount.mount === '/' ? '/' : `${mount.mount}/`))
            .sort((a, b) => b.mount.length - a.mount.length)[0];
        const homeVolumeId = homeMount && result.some((volume) => volume.id === homeMount.device) ? homeMount.device : undefined;
        return result.length ? { reported: true, volumes: result, ...(homeVolumeId ? { homeVolumeId } : {}) } : missing;
    }

    async function network(raw: string | null, input: MachineVitalsReaderInput) {
        if (raw === null) return { sample: missing, counters: null };
        const entries: { id: string; rx: number; tx: number; included: boolean }[] = [];
        for (const line of raw.split('\n')) {
            const match = /^\s*([^:]+):\s*(.*)$/u.exec(line);
            if (!match) continue;
            const values = match[2].trim().split(/\s+/u).map(Number);
            if (values.length < 16 || !Number.isFinite(values[0]) || !Number.isFinite(values[8])) continue;
            const id = match[1].trim();
            const names = await list(`/sys/class/net/${id}`);
            const master = await text(`/sys/class/net/${id}/master/uevent`);
            const included = !/^(?:lo$|docker|veth|br-|virbr|tun|tap|utun|wg|tailscale|ipsec)/u.test(id)
                && master === null && !names.some((name) => name.startsWith('upper_'));
            entries.push({ id, rx: values[0], tx: values[8], included });
        }
        entries.sort((a, b) => a.id.localeCompare(b.id));
        const counted = entries.filter(entry => entry.included);
        const counters = (interfaces: typeof entries) => Object.fromEntries(interfaces.flatMap(entry => [[`${entry.id}:rx`, entry.rx], [`${entry.id}:tx`, entry.tx]]));
        const delta = networkRates({ monotonicMs: input.monotonicMs, counters: counters(counted) }, input.intervalMs);
        // Excluded traffic stays inspectable without participating in machine-counter continuity.
        const excludedDelta = excludedNetworkRates({ monotonicMs: input.monotonicMs, counters: counters(entries.filter(entry => !entry.included)) }, input.intervalMs);
        let rxBps = 0, txBps = 0, label: string | undefined, busiest = -1;
        const interfaces = entries.map((entry) => {
            const interfaceDelta = entry.included ? delta : excludedDelta;
            const rx = interfaceDelta ? interfaceDelta.deltas[`${entry.id}:rx`] * 1000 / interfaceDelta.elapsedMs : null;
            const tx = interfaceDelta ? interfaceDelta.deltas[`${entry.id}:tx`] * 1000 / interfaceDelta.elapsedMs : null;
            if (entry.included && rx !== null && tx !== null) {
                rxBps += rx; txBps += tx;
                if (rx + tx > busiest) { label = entry.id; busiest = rx + tx; }
            }
            return { id: entry.id, label: entry.id, included: entry.included, rxBps: rx, txBps: tx };
        });
        return { sample: { reported: true as const, rxBps: delta ? rxBps : null, txBps: delta ? txBps : null, label, interfaces },
            counters: { interfaceIds: counted.map((entry) => entry.id), rxBytes: counted.reduce((sum, entry) => sum + entry.rx, 0), txBytes: counted.reduce((sum, entry) => sum + entry.tx, 0) } };
    }

    async function limits(group: Cgroup | undefined, overview: boolean): Promise<MachineVitalsSampleV1['limits']> {
        const result: NonNullable<MachineVitalsSampleV1['limits']> = {};
        const [files, ptyUsed, ptyMax, ownLimits, ownFds] = await Promise.all([text('/proc/sys/fs/file-nr'), text('/proc/sys/kernel/pty/nr'), text('/proc/sys/kernel/pty/max'), text('/proc/self/limits'), list('/proc/self/fd')]);
        const fileValues = files?.trim().split(/\s+/u).map(Number);
        if (fileValues?.length === 3) result.files = { used: Math.max(0, fileValues[0] - fileValues[1]), max: fileValues[2] };
        if (ptyUsed !== null && ptyMax !== null) result.ptys = { used: Number(ptyUsed), max: Number(ptyMax) };
        const soft = /^Max open files\s+(\d+)/mu.exec(ownLimits ?? '');
        if (soft) result.daemonFiles = { used: ownFds.length, max: Number(soft[1]) };
        if (group?.pids) result.processes = group.pids;
        if (overview) {
            const max = await text('/proc/sys/fs/inotify/max_user_watches');
            if (max !== null) {
                const inotify = await readLinuxInotifyWatches(options.root, Number(max));
                if (inotify) result.inotify = inotify;
            }
        }
        return Object.keys(result).length ? result : undefined;
    }

    async function extras(container: boolean) {
        const gpu: NonNullable<MachineVitalsSampleV1['gpu']> = [];
        const cards = (await list('/sys/class/drm')).filter((name) => /^card\d+$/u.test(name));
        const nvidiaIds = new Set(await list('/proc/driver/nvidia/gpus'));
        let nvidiaPresent = nvidiaIds.size > 0;
        let unaddressedNvidiaOff = false;
        for (const card of cards) {
            const nvidia = (await text(`/sys/class/drm/${card}/device/vendor`))?.trim().toLowerCase() === '0x10de';
            if (nvidia) {
                nvidiaPresent = true;
                try {
                    // The DRM slot may point at a different PCI device after hotplug.
                    const id = posix.basename(await readlink(at(`/sys/class/drm/${card}/device`)));
                    if (/^[\da-f]+:[\da-f]{2}:[\da-f]{2}\.[\da-f]$/iu.test(id)) { nvidiaIds.add(id); continue; }
                } catch { /* A missing PCI identity does not prove the GPU is awake. */ }
            }
            if ((await text(`/sys/class/drm/${card}/device/power_state`))?.trim() === 'D3cold') {
                gpu.push({ name: card, powerState: 'off' });
                if (nvidia) unaddressedNvidiaOff = true;
                continue;
            }
            const [busy, used, total] = await Promise.all([text(`/sys/class/drm/${card}/device/gpu_busy_percent`), text(`/sys/class/drm/${card}/device/mem_info_vram_used`), text(`/sys/class/drm/${card}/device/mem_info_vram_total`)]);
            if (busy !== null && Number(busy) >= 0 && Number(busy) <= 100) gpu.push({ name: card, busyPct: Number(busy), ...(used !== null ? { memUsedBytes: Number(used) } : {}), ...(total !== null ? { memTotalBytes: Number(total) } : {}) });
        }
        for (const id of nvidiaNames.keys()) if (!nvidiaIds.has(id)) nvidiaNames.delete(id);
        const nvidiaToQuery: string[] = [];
        for (const id of nvidiaIds) {
            // The PCI kernel state is readable without asking the GPU to wake.
            if ((await text(`/sys/bus/pci/devices/${id}/power_state`))?.trim() === 'D3cold') {
                let name = nvidiaNames.get(id);
                if (!name) {
                    name = (await text(`/proc/driver/nvidia/gpus/${id}/information`))?.match(/^Model:\s*(.+)$/mu)?.[1].trim() || 'NVIDIA GPU';
                    nvidiaNames.set(id, name);
                }
                gpu.push({ name, powerState: 'off' });
            } else nvidiaToQuery.push(id);
        }
        // A global query can wake an off device. Select the remaining PCI ids in
        // the existing single spawn; without addressability keep telemetry absent.
        if (nvidiaPresent && !unaddressedNvidiaOff && (nvidiaIds.size === 0 || nvidiaToQuery.length > 0)) {
            for (const directory of (options.toolPath ?? process.env.PATH ?? '').split(':')) {
                if (!directory) continue;
                const executable = at(posix.join(directory, 'nvidia-smi'));
                try { await access(executable, constants.X_OK); } catch { continue; }
                try {
                    const run = options.execFile ?? (await import('@happier-dev/cli-common/process')).execFileWithDeadline;
                    const args = nvidiaToQuery.length < nvidiaIds.size ? [...NVIDIA_VITALS_ARGS, `--id=${nvidiaToQuery.join(',')}`] : NVIDIA_VITALS_ARGS;
                    const result = await run(executable, args, { encoding: 'utf8', signal: options.signal });
                    gpu.push(...parseNvidiaVitalsGpu(String(result.stdout)));
                } catch { /* Optional telemetry failure must not hide the base sample. */ }
                break;
            }
        }
        let thermal: MachineVitalsSampleV1['thermal'];
        for (const zone of (await list('/sys/class/thermal')).filter((name) => name.startsWith('thermal_zone'))) {
            const [raw, sensor] = await Promise.all([text(`/sys/class/thermal/${zone}/temp`), text(`/sys/class/thermal/${zone}/type`)]);
            if (raw === null) continue;
            const tempC = Number(raw) / 1000;
            if (tempC < 1 || tempC >= 110 || !Number.isFinite(tempC)) continue;
            if (!thermal || /(?:pkg|cpu|package)/iu.test(sensor ?? '')) thermal = { tempC, sensor: sensor?.trim() ?? zone };
            if (/(?:pkg|cpu|package)/iu.test(sensor ?? '')) break;
        }
        for (const device of await list('/sys/class/hwmon')) {
            const names = await list(`/sys/class/hwmon/${device}`);
            for (const input of names.filter((name) => /^temp\d+_input$/u.test(name))) {
                const [raw, label] = await Promise.all([text(`/sys/class/hwmon/${device}/${input}`), text(`/sys/class/hwmon/${device}/${input.replace('_input', '_label')}`)]);
                if (raw === null || !/(?:package|cpu|tctl|tdie)/iu.test(label ?? '')) continue;
                const tempC = Number(raw) / 1000;
                if (tempC >= 1 && tempC < 110) thermal = { ...thermal, tempC, sensor: label!.trim() };
            }
            for (const input of names.filter((name) => /^fan\d+_input$/u.test(name))) {
                const [raw, maximum] = await Promise.all([text(`/sys/class/hwmon/${device}/${input}`), text(`/sys/class/hwmon/${device}/${input.replace('_input', '_max')}`)]);
                if (raw !== null && maximum !== null && Number(raw) >= 0 && Number(maximum) > 0) {
                    thermal = { ...thermal, fanPct: clampPct(Number(raw) * 100 / Number(maximum)) };
                    break;
                }
            }
        }
        let sharedMemory: MachineVitalsSampleV1['sharedMemory'];
        if (container) {
            try { const stats = await statfs(at('/dev/shm')); sharedMemory = { totalBytes: stats.blocks * stats.bsize, availableBytes: stats.bavail * stats.bsize }; } catch { /* Not mounted. */ }
        }
        const battery = options.readBattery ? await options.readBattery().catch(() => undefined)
            : (await readLinuxBatteryFacts({ readText: (path) => readFile(at(path), 'utf8'),
                listPowerSupplies: () => readdir(at('/sys/class/power_supply')) })).battery;
        return { ...(gpu.length ? { gpu } : {}), ...(thermal ? { thermal } : {}), ...(sharedMemory ? { sharedMemory } : {}), ...(battery ? { battery } : {}) };
    }

    async function read(input: MachineVitalsReaderInput) {
        try {
            const [cpuRaw, memRaw, vmRaw, psi, zones, mountsRaw, netRaw, loadsRaw] = await Promise.all([
                text('/proc/stat'), text('/proc/meminfo'), text('/proc/vmstat'), text('/proc/pressure/memory'), text('/proc/zoneinfo'),
                text('/proc/self/mountinfo'), text('/proc/net/dev'), text('/proc/loadavg'),
            ]);
            const cpus = parseCpu(cpuRaw), mem = keyedNumbers(memRaw, 1024), vm = keyedNumbers(vmRaw), mounts = parseMounts(mountsRaw);
            if (!cpus.cpu || mem.MemTotal === undefined || mem.MemAvailable === undefined) return { state: 'unavailable' as const, reason: 'reader_failed' as const };
            const logicalCores = Object.keys(cpus).filter((id) => id !== 'cpu').length;
            const group = await cgroup(mounts, mem.MemTotal);
            const isContainer = group?.memoryLimit !== undefined;
            const containerEnvironment = isContainer || group?.quotaCores !== undefined || await text('/.dockerenv') !== null || await text('/run/.containerenv') !== null;
            const quota = group?.quotaCores;
            const effectiveCores = Math.min(logicalCores, quota ?? logicalCores);
            const cpuCounters = Object.fromEntries(Object.entries(cpus).flatMap(([id, values]) => Object.entries(values).map(([key, value]) => [`${id}:${key}`, value])));
            const cpuDelta = cpuRates({ monotonicMs: input.monotonicMs, counters: cpuCounters }, input.intervalMs);
            const pct = (id: string, key: string) => cpuDelta && cpuDelta.deltas[`${id}:total`] > 0 ? clampPct(100 * cpuDelta.deltas[`${id}:${key}`] / cpuDelta.deltas[`${id}:total`]) : null;
            const containerDelta = group?.usageUsec !== undefined ? containerRates({ monotonicMs: input.monotonicMs, counters: { usage: group.usageUsec, ...group.throttles, [`capacity:${effectiveCores}`]: 0,
                ...(group.userUsec !== undefined ? { user: group.userUsec } : {}), ...(group.systemUsec !== undefined ? { system: group.systemUsec } : {}) } }, input.intervalMs) : null;
            const loads = loadsRaw?.trim().split(/\s+/u).slice(0, 3).map(Number);
            const cpu: MachineVitalsSampleV1['cpu'] = { reported: true, busyPct: quota !== undefined ? (containerDelta ? clampPct(containerDelta.deltas.usage / (effectiveCores * containerDelta.elapsedMs * 10)) : null) : pct('cpu', 'busy'),
                ...(quota !== undefined ? { perCoreNotReportedReason: 'container' as const, ...(Object.keys(group?.throttles ?? {}).length ? { throttled: containerDelta !== null && Object.entries(containerDelta.deltas).some(([key, value]) => key.startsWith('throttle:') && value > 0) } : {}),
                    userPct: containerDelta && group?.userUsec !== undefined ? clampPct(containerDelta.deltas.user / (effectiveCores * containerDelta.elapsedMs * 10)) : null,
                    systemPct: containerDelta && group?.systemUsec !== undefined ? clampPct(containerDelta.deltas.system / (effectiveCores * containerDelta.elapsedMs * 10)) : null } : {
                    perCore: Object.keys(cpus).filter((id) => id !== 'cpu').sort((a, b) => Number(a.slice(3)) - Number(b.slice(3))).map((id) => pct(id, 'busy')),
                    userPct: pct('cpu', 'user'), systemPct: pct('cpu', 'system'), iowaitPct: pct('cpu', 'iowait'), stealPct: pct('cpu', 'steal'),
                }), ...(loads?.length === 3 && loads.every(Number.isFinite) ? { load1: loads[0] / logicalCores, load5: loads[1] / logicalCores, load15: loads[2] / logicalCores } : {}) };
            const events = { swapIn: vm.pswpin ?? 0, swapOut: vm.pswpout ?? 0, ...(isContainer && group?.version === 2 ? group.events : { oom: vm.oom_kill ?? 0 }) };
            const eventDelta = eventRates({ monotonicMs: input.monotonicMs, counters: events }, input.intervalMs);
            const swapping = eventDelta !== null && (eventDelta.deltas.swapIn > 0 || eventDelta.deltas.swapOut > 0);
            const totalBytes = group?.memoryLimit ?? mem.MemTotal;
            const usedBytes = isContainer && group?.current !== undefined ? Math.max(0, Math.min(totalBytes, group.current - group.inactiveFile)) : mem.MemTotal - mem.MemAvailable;
            const availableBytes = isContainer ? Math.max(0, totalBytes - usedBytes) : mem.MemAvailable;
            if (pageSize === undefined) pageSize = await kernelPageSize();
            const watermarks = { min: 0, high: 0 };
            for (const match of (zones ?? '').matchAll(/^\s+(min|high)\s+(\d+)\s*$/gmu)) watermarks[match[1] as 'min' | 'high'] += Number(match[2]) * pageSize;
            const scopedPsi = isContainer && group?.version === 2 ? group.pressure : psi;
            let level: 'calm' | 'elevated' | 'critical' = 'calm';
            const eventIncreased = (kind: 'oom' | 'high') => Object.entries(eventDelta?.deltas ?? {}).some(([key, value]) => value > 0 && (key === kind || key.startsWith(`${kind === 'oom' ? 'oom_kill' : kind}:`)));
            if (psiAvg60(scopedPsi, 'full') > 0 || eventIncreased('oom') || (!isContainer && pageSize > 0 && availableBytes <= watermarks.min)) level = 'critical';
            else if ((psiAvg60(scopedPsi, 'some') > 0 && swapping) || eventIncreased('high') || (!isContainer && pageSize > 0 && availableBytes <= watermarks.high)) level = 'elevated';
            const memory: MachineVitalsSampleV1['memory'] = { reported: true, totalBytes, availableBytes, usedBytes,
                pressure: { level, source: scopedPsi ? 'psi' : 'events' }, ...(isContainer ? { limitSource: 'cgroup' as const } : {}),
                ...(mem.SwapTotal !== undefined ? { swap: { kind: 'swap' as const, totalBytes: group?.swap?.totalBytes ?? mem.SwapTotal, usedBytes: group?.swap?.usedBytes ?? mem.SwapTotal - (mem.SwapFree ?? mem.SwapTotal), swapping } } : {}) };
            if (!isContainer) {
                // Composition belongs to this meminfo observation, not the slower extras cache.
                // MemAvailable already credits reclaimable cache. Preserve the
                // resident app/kernel footprint before attributing its remainder.
                const kernel = Math.min(usedBytes, Math.max(0, (mem.Slab ?? 0) - (mem.SReclaimable ?? 0) + (mem.KernelStack ?? 0) + (mem.PageTables ?? 0)));
                const apps = Math.min(usedBytes - kernel, Math.max(0, (mem.AnonPages ?? 0) + (mem.Shmem ?? 0)));
                memory.composition = [{ kind: 'apps', bytes: apps }, { kind: 'kernel', bytes: kernel }, { kind: 'cached_files', bytes: usedBytes - apps - kernel }];
            }
            if (!topology || topologyCoreCount !== logicalCores) {
                const [pRaw, eRaw, info] = await Promise.all([text('/sys/devices/cpu_core/cpus'), text('/sys/devices/cpu_atom/cpus'), text('/proc/cpuinfo')]);
                const indices = (raw: string | null) => (raw?.trim().split(',') ?? []).flatMap((part) => { const [start, end] = part.split('-').map(Number); return Number.isInteger(start) ? Array.from({ length: (end ?? start) - start + 1 }, (_, index) => start + index) : []; });
                const p = indices(pRaw), e = indices(eRaw);
                const clusters = Array.from({ length: logicalCores }, (_, index) => p.includes(index) ? 'p' as const : e.includes(index) ? 'e' as const : null);
                const sockets = new Set([...(info ?? '').matchAll(/^physical id\s*:\s*(\d+)/gmu)].map((match) => match[1])).size;
                topology = { ...(p.length ? { performanceCores: p.length } : {}), ...(e.length ? { efficiencyCores: e.length } : {}), ...(clusters.length && clusters.every((cluster) => cluster !== null) ? { clusters } : {}), ...(sockets ? { sockets } : {}) };
                topologyCoreCount = logicalCores;
            }
            if (quota === undefined && topology.clusters) cpu.clusters = topology.clusters;
            const [disk, net, limitFacts, extraFacts, powerFacts] = await Promise.all([volumes(mounts), network(netRaw, input), limits(group, input.overviewExtras), input.overviewExtras ? extras(containerEnvironment) : Promise.resolve({}),
                readLinuxBatteryFacts({ readText: path => readFile(at(path), 'utf8'), listPowerSupplies: () => readdir(at('/sys/class/power_supply')) }, { powerOnly: true })]);
            const bootedAt = Number(/^btime\s+(\d+)/mu.exec(cpuRaw ?? '')?.[1] ?? 0) * 1000;
            const host: MachineVitalsHostFactsV1 = { logicalCores, effectiveCores, memoryTotalBytes: totalBytes, bootedAt, ...Object.fromEntries(Object.entries(topology).filter(([key]) => key !== 'clusters')) };
            return { state: 'reporting' as const, sample: { v: 1 as const, sampledAt: input.sampledAt, intervalMs: input.intervalMs, cpu, memory, disk, network: net.sample, ...(limitFacts ? { limits: limitFacts } : {}),
                ...(powerFacts.onAC !== undefined ? { power: { onAC: powerFacts.onAC } } : {}), ...extraFacts }, host,
                minuteCounters: { monotonicMs: input.monotonicMs, cpu: { busy: cpus.cpu.busy, total: cpus.cpu.total }, ...(quota !== undefined && group?.usageUsec !== undefined ? { containerCpu: { usageUsec: group.usageUsec, effectiveCores } } : {}), network: net.counters, swap: { in: events.swapIn, out: events.swapOut } } };
        } catch { return { state: 'unavailable' as const, reason: 'reader_failed' as const }; }
    }
    return { read };
}
