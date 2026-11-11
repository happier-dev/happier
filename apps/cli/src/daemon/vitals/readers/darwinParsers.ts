import type { MachineVitalsSampleV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsSampleV1';

type Memory = Extract<MachineVitalsSampleV1['memory'], { reported: true }>;
export function parseDarwinVmStat(raw: string, usedBytes: number): Memory['composition'] {
    const pageSize = Number(raw.match(/page size of (\d+) bytes/u)?.[1]);
    const pages = new Map([...raw.matchAll(/^([^:\r\n]+):\s+(\d+)\./gmu)].map((match) => [match[1].trim(), Number(match[2])]));
    const compressedPages = pages.get('Pages occupied by compressor');
    const wiredPages = pages.get('Pages wired down');
    const cachedPages = pages.get('File-backed pages');
    if (!Number.isSafeInteger(pageSize) || pageSize <= 0 || compressedPages === undefined || wiredPages === undefined || cachedPages === undefined) return undefined;
    // Preserve resident wired/compressor bytes first; clip cache to the in-use total
    // because VM composition and free memory are sampled at separate instants.
    const compressed = Math.min(usedBytes, compressedPages * pageSize);
    const wired = Math.min(usedBytes - compressed, wiredPages * pageSize);
    const cached = Math.min(usedBytes - compressed - wired, cachedPages * pageSize);
    return [{ kind: 'apps', bytes: usedBytes - compressed - wired - cached }, { kind: 'wired', bytes: wired }, { kind: 'compressed', bytes: compressed }, { kind: 'cached_files', bytes: cached }];
}

export function parseDarwinThermal(raw: string): MachineVitalsSampleV1['thermal'] {
    const limits = [...raw.matchAll(/(?:CPU_Speed_Limit|Scheduler_Limit)\s*=\s*(\d+)/gu)].map((match) => Number(match[1])).filter((value) => value >= 0 && value <= 100);
    const noWarning = /No thermal warning level has been recorded/u.test(raw);
    if (!noWarning && limits.length === 0) return undefined;
    return { ...(noWarning ? { state: 'nominal' as const } : {}), throttled: limits.some((limit) => limit < 100) };
}

export function parseDarwinGpu(raw: string): MachineVitalsSampleV1['gpu'] {
    const result: NonNullable<MachineVitalsSampleV1['gpu']> = [];
    for (const device of raw.split(/\+-o /u).slice(1)) {
        const name = device.match(/"model"\s*=\s*"([^"]+)"/u)?.[1] ?? device.split(/\s/u)[0];
        // This optional flag is already in the accelerator tool output. Do not
        // infer power from missing statistics or carry old readings into Off.
        const power = device.match(/"AGCInfo"\s*=\s*\{([^}]*)\}/u)?.[1];
        if (power && /"poweredOffByAGC"\s*=\s*1(?:\s*[,}]|\s*$)/u.test(power)) {
            result.push({ name, powerState: 'off' });
            continue;
        }
        const busy = device.match(/"Device Utilization %"\s*=\s*(\d+(?:\.\d+)?)/u);
        if (!busy || Number(busy[1]) > 100) continue;
        const cores = device.match(/"gpu-core-count"\s*=\s*(\d+)/u)?.[1];
        result.push({ name, busyPct: Number(busy[1]), ...(cores ? { cores: Number(cores) } : {}) });
    }
    return result.length ? result : undefined;
}

export function parseDarwinHardwarePorts(raw: string): Map<string, string> {
    const result = new Map<string, string>();
    for (const match of raw.matchAll(/Hardware Port:\s*([^\r\n]+)\r?\nDevice:\s*([^\r\n]+)/gu)) result.set(match[2].trim(), match[1].trim());
    return result;
}
