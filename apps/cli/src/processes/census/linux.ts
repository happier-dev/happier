import { endianness } from 'node:os';
import { parseLinuxProcStartTime, parseLinuxProcStartTimeMs } from '@happier-dev/cli-common/processInstance';
import type { ProcessCensusField, ProcessCensusRow, ProcessCensusSnapshot } from './processCensus';
import { ancestorsOf, indexCensus } from '../tree/processTree';

export const DAEMON_OWNERSHIP_ENVIRONMENT_VARIABLE_KEYS = [
    'HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID',
    'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_PUBLIC_SERVER_URL',
] as const;

export type LinuxCensusBoundary = Readonly<{
    procRoot?: string; daemonUserId?: string;
    readFile(path: string, encoding?: 'utf8'): Promise<string | Buffer>;
    readdir(path: string): Promise<readonly string[]>;
    readlink(path: string): Promise<string>;
}>;

function isProcessGone(error: unknown): boolean {
    return !!error && typeof error === 'object' && 'code' in error
        && (error.code === 'ENOENT' || error.code === 'ESRCH');
}

function decodePageSize(auxv: Buffer): number | null {
    const width = process.arch === 'ia32' || process.arch === 'arm' ? 4 : 8;
    const read = (offset: number) => width === 4
        ? (endianness() === 'LE' ? auxv.readUInt32LE(offset) : auxv.readUInt32BE(offset))
        : Number(endianness() === 'LE' ? auxv.readBigUInt64LE(offset) : auxv.readBigUInt64BE(offset));
    for (let offset = 0; offset + 2 * width <= auxv.length; offset += 2 * width) {
        if (read(offset) === 6) {
            const bytes = read(offset + width);
            return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null;
        }
    }
    return null;
}

type LinuxCensusInput = Readonly<{
    selfPid: number; pids?: readonly number[]; capturedAtMs: number; logicalCpus: number;
    fields?: readonly ProcessCensusField[]; commandRoots?: readonly number[]; includeAncestors?: boolean; includeDescendants?: boolean;
}>;

function readOwnershipFields(environ: string | undefined) {
    let ownerTag: string | undefined;
    let environment: Record<string, string> | undefined;
    // Read the fresh environment without splitting or retaining unrelated values.
    for (let cursor = 0; environ !== undefined && cursor < environ.length;) {
        const terminator = environ.indexOf('\0', cursor);
        const end = terminator < 0 ? environ.length : terminator;
        const separator = environ.indexOf('=', cursor);
        if (separator > cursor && separator < end) {
            const key = environ.slice(cursor, separator);
            if (key === 'HAPPIER_PROCESS_OWNER') ownerTag = environ.slice(separator + 1, end);
            else for (let index = 0; index < DAEMON_OWNERSHIP_ENVIRONMENT_VARIABLE_KEYS.length; index++) {
                const allowed = DAEMON_OWNERSHIP_ENVIRONMENT_VARIABLE_KEYS[index]!;
                if (key !== allowed) continue;
                const value = environ.slice(separator + 1, end).trim();
                if (!value) continue;
                environment ??= {};
                environment[allowed] = value;
            }
        }
        cursor = end + 1;
    }
    return { ownerTag, ownershipEnvironment: environment };
}

export function createLinuxCensusReader(boundary: LinuxCensusBoundary) {
    const root = (boundary.procRoot ?? '/proc').replace(/\/+$/u, '');
    const text = async (path: string) => String(await boundary.readFile(path, 'utf8'));
    // AT_PAGESZ belongs to this reader's process, not any observed PID. Failed
    // observations are retried; command, credentials and containment stay fresh.
    let pageSizeObservation: Promise<number | null> | undefined;
    const readPageSize = () => pageSizeObservation ??= boundary.readFile(`${root}/self/auxv`)
        .then(value => decodePageSize(Buffer.isBuffer(value) ? value : Buffer.from(value)))
        .catch(() => null).then(value => { if (value === null) pageSizeObservation = undefined; return value; });
    return async (input: LinuxCensusInput): Promise<ProcessCensusSnapshot> => {
        const { selfPid } = input;
        const wants = (field: ProcessCensusField) => input.fields === undefined || input.fields.includes(field);
        const selfStatus = await text(`${root}/${selfPid}/status`).catch(() => '');
        const selfUid = boundary.daemonUserId ?? /^Uid:\s+(\d+)/mu.exec(selfStatus)?.[1];
        const pageSize = wants('memory') ? await readPageSize() : null;
        const pids = input.pids ? [...new Set([...input.pids, selfPid])]
            : (await boundary.readdir(root)).filter(name => /^\d+$/u.test(name)).map(Number);
        const partial: Array<{ pid: number; missing: string[] }> = [];
        const readRow = async (pid: number): Promise<ProcessCensusRow | null> => {
            const base = `${root}/${pid}`;
            const missing: string[] = [];
            let stat: string;
            try { stat = await text(`${base}/stat`); }
            catch (error) {
                if (!isProcessGone(error)) partial.push({ pid, missing: ['start'] });
                return null;
            }
            const end = stat.lastIndexOf(')');
            const startTimeMs = parseLinuxProcStartTimeMs(stat);
            const ticks = parseLinuxProcStartTime(stat);
            const fields = stat.slice(end + 1).trim().split(/\s+/u);
            if (end < 0 || startTimeMs === null || ticks === null || fields.length < 22) {
                partial.push({ pid, missing: ['start'] });
                return null;
            }
            let status: string | undefined = selfStatus;
            if (pid !== selfPid) {
                try { status = await text(`${base}/status`); }
                catch (error) {
                    // The generation can exit after stat was read. A vanished status
                    // is absence, not a live row with an unverifiable principal.
                    if (isProcessGone(error)) return null;
                    missing.push('status');
                    status = undefined;
                }
            }
            const uid = status === undefined ? undefined : /^Uid:\s+(\d+)/mu.exec(status)?.[1];
            if (uid === undefined && !missing.includes('status')) missing.push('principal');
            const principal = uid === undefined ? null : { kind: 'uid' as const, value: uid };
            const number = (index: number) => /^-?\d+$/u.test(fields[index] ?? '') ? Number(fields[index]) : NaN;
            const ppid = number(1), pgid = number(2), sessionId = number(3), tpgid = number(5);
            const cpuTicks = number(11) + number(12);
            // Linux's userspace stat ABI exposes USER_HZ=100, the same tenfold tick basis as persisted identities.
            const cpuTimeUs = wants('cpuTimeUs') && Number.isSafeInteger(cpuTicks) && cpuTicks >= 0 && Number.isSafeInteger(cpuTicks * 10000) ? cpuTicks * 10000 : null;
            const rss = number(21);
            const memoryBytes = pageSize !== null && Number.isSafeInteger(rss) && rss >= 0 ? rss * pageSize : null;
            const memory = memoryBytes !== null && Number.isSafeInteger(memoryBytes) ? { bytes: memoryBytes, kind: 'rss' as const } : null;
            if (wants('memory') && memory === null) missing.push('memory');
            if (wants('cpuTimeUs') && cpuTimeUs === null) missing.push('cpuTimeUs');
            const state = fields[0] === 'R' ? 'running' : fields[0] === 'S' || fields[0] === 'D' || fields[0] === 'I' ? 'sleeping'
                : fields[0] === 'T' || fields[0] === 't' ? 'stopped' : fields[0] === 'Z' ? 'zombie' : 'other';
            if (missing.length) partial.push({ pid, missing });
            const parent = Number.isSafeInteger(ppid) && ppid >= 0 ? ppid : null;
            const group = Number.isSafeInteger(pgid) && pgid > 0 ? pgid : undefined;
            const session = Number.isSafeInteger(sessionId) && sessionId > 0 ? sessionId : undefined;
            const foregroundGroup = Number.isSafeInteger(tpgid) && tpgid > 0 ? tpgid : undefined;
            const native = `linux-proc:${ticks}`;
            const name = stat.slice(stat.indexOf('(') + 1, end);
            const row: ProcessCensusRow = {
                pid, ppid: parent, ...(group !== undefined ? { pgid: group } : {}),
                ...(session !== undefined ? { sessionId: session } : {}),
                ...(foregroundGroup !== undefined ? { tpgid: foregroundGroup } : {}),
                start: { startTimeMs, native }, principal, name, memory, cpuTimeUs, state,
            };
            return row;
        };
        const rows = (await Promise.all(pids.map(readRow))).filter((row): row is ProcessCensusRow => row !== null);
        if (input.pids && input.includeDescendants) {
            const seen = new Set(pids);
            const observed = new Set(rows.map(row => row.pid));
            const queue = [...input.pids];
            for (let cursor = 0; cursor < queue.length; cursor++) {
                const pid = queue[cursor]!;
                if (!observed.has(pid)) continue;
                try {
                    // Children belong to the thread which spawned them, not
                    // necessarily the leader. Never enumerate unrelated PIDs.
                    const threads = await boundary.readdir(`${root}/${pid}/task`);
                    for (const tid of threads.filter(name => /^\d+$/u.test(name))) {
                        let children: string;
                        try { children = await text(`${root}/${pid}/task/${tid}/children`); }
                        catch (error) {
                            if (!isProcessGone(error)) throw error;
                            // A vanished thread is expected; an absent children
                            // interface on a still-live thread is not an empty tree.
                            try { await text(`${root}/${pid}/task/${tid}/stat`); }
                            catch (probeError) { if (isProcessGone(probeError)) continue; throw probeError; }
                            throw error;
                        }
                        for (const child of children.trim().split(/\s+/u)) {
                            if (!/^\d+$/u.test(child)) continue;
                            const childPid = Number(child);
                            if (!Number.isSafeInteger(childPid) || childPid <= 0 || seen.has(childPid)) continue;
                            seen.add(childPid);
                            const row = await readRow(childPid);
                            if (row) { rows.push(row); observed.add(childPid); queue.push(childPid); }
                            else if (partial.some(item => item.pid === childPid)) {
                                // Discovery proved a child exists, but could not
                                // observe its generation. It is not a verified
                                // absence and must not disappear from tree proof.
                                return { status: 'unavailable', reason: 'read_failed' };
                            }
                        }
                    }
                } catch (error) {
                    if (!isProcessGone(error)) throw error;
                    try { await text(`${root}/${pid}/stat`); }
                    catch (probeError) { if (isProcessGone(probeError)) continue; throw probeError; }
                    throw error;
                }
            }
        }
        if (input.pids && input.includeAncestors) {
            const seen = new Set(rows.map(row => row.pid));
            for (let cursor = 0; cursor < rows.length; cursor++) {
                const parent = rows[cursor]?.ppid;
                if (parent === null || parent === undefined || parent <= 1 || seen.has(parent)) continue;
                seen.add(parent);
                const row = await readRow(parent);
                if (row) rows.push(row);
            }
        }
        if (!rows.some(row => row.pid === selfPid)) return { status: 'unavailable', reason: 'self_absent' };
        const index = indexCensus(rows);
        const missingByPid = new Map(partial.map(item => [item.pid, item.missing]));
        const commandPids = input.commandRoots ? new Set(input.commandRoots.flatMap(pid => [pid, ...ancestorsOf(index, pid).map(row => row.pid)])) : null;
        const enriched = await Promise.all(rows.map(async row => {
            const missing = missingByPid.get(row.pid) ?? [];
            const own = row.principal?.value !== undefined && row.principal.value === selfUid;
            const command = own && (!commandPids || commandPids.has(row.pid));
            async function optional(field: ProcessCensusField, name: string, requested: boolean, link = false) {
                if (!requested || !wants(field)) return undefined;
                try { return link ? await boundary.readlink(`${root}/${row.pid}/${name}`) : await text(`${root}/${row.pid}/${name}`); }
                catch { missing.push(name); return undefined; }
            }
            const [cgroup, cmdline, cwd, executablePath, environ] = await Promise.all([
                optional('cgroup', 'cgroup', true), optional('argv', 'cmdline', command),
                optional('cwd', 'cwd', command, true), optional('executablePath', 'exe', command, true),
                optional('ownershipEnvironment', 'environ', own),
            ]);
            const { ownerTag, ownershipEnvironment } = readOwnershipFields(environ);
            const cgroupPath = /^0::(.*)$/mu.exec(cgroup ?? '')?.[1] || undefined;
            if (wants('cgroup') && cgroup !== undefined && cgroupPath === undefined) missing.push('cgroup');
            const argv = cmdline?.split('\0').filter((value, index, values) => index < values.length - 1 || value !== '');
            if (missing.length && !missingByPid.has(row.pid)) partial.push({ pid: row.pid, missing });
            return { ...row,
                ...(cgroupPath !== undefined ? { cgroup: cgroupPath } : {}),
                ...(argv !== undefined ? { argv } : {}),
                ...(cwd !== undefined ? { cwd } : {}), ...(executablePath !== undefined ? { executablePath } : {}),
                ...(ownerTag !== undefined ? { ownerTag } : {}),
                ...(ownershipEnvironment !== undefined ? { ownershipEnvironment } : {}),
            };
        }));
        return { status: 'ok', capturedAtMs: input.capturedAtMs, logicalCpus: input.logicalCpus, rows: enriched,
            ...(partial.length ? { partial: partial.sort((a, b) => a.pid - b.pid) } : {}) };
    };
}

/** Explicit OS-boundary callers use the same reader implementation. */
export function readLinuxCensus(input: LinuxCensusInput & Readonly<{ boundary: LinuxCensusBoundary }>): Promise<ProcessCensusSnapshot> {
    return createLinuxCensusReader(input.boundary)(input);
}
