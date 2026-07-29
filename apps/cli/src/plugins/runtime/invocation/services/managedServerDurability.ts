import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, open, mkdir, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { PluginError } from '@happier-dev/plugin-sdk';

export type ManagedServerCustodyRecord = Readonly<{
    v: 1;
    instanceId: string;
    generationFingerprint: string;
    serverFingerprint: string;
    pid: number;
    processStartIdentity: string;
    endpoint: Readonly<{ host: '127.0.0.1' | '::1'; port: number }>;
    createdAtMs: number;
}>;

type RecoveryOutcome = 'reaped' | 'absent' | 'identityMismatch' | 'failed';

export type ManagedServerDurableLogCapture = Readonly<{
    path: string;
    write(source: 'stdout' | 'stderr', chunk: Uint8Array | string): void;
    close(): Promise<void>;
}>;

export interface ManagedServerDurabilityOwner {
    claim(record: ManagedServerCustodyRecord): Promise<void>;
    release(instanceId: string): Promise<void>;
    reconcile(): Promise<Readonly<{
        reaped: number;
        absent: number;
        identityMismatch: number;
        failed: number;
        corrupt: number;
    }>>;
    openLog(input: Readonly<{
        instanceId: string;
        serverId: string;
        keepCount?: number;
        secretValues: readonly string[];
        nowMs?: number;
    }>): Promise<ManagedServerDurableLogCapture>;
}

const DEFAULT_MAX_CUSTODY_RECORDS = 256;
const DEFAULT_MAX_LOG_KEEP_COUNT = 50;
const DEFAULT_MAX_LOG_BYTES = 8 * 1024 * 1024;
const MAX_CORRUPT_RECORDS = 16;

function fail(code: string, message: string): never {
    throw new PluginError({ code, message });
}

function digest(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

function isFingerprint(value: unknown): value is string {
    return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function parseRecord(raw: unknown): ManagedServerCustodyRecord | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const value = raw as Record<string, unknown>;
    const endpoint = value.endpoint;
    if (!endpoint || typeof endpoint !== 'object' || Array.isArray(endpoint)) return null;
    const endpointRecord = endpoint as Record<string, unknown>;
    if (
        value.v !== 1
        || typeof value.instanceId !== 'string'
        || value.instanceId.trim().length === 0
        || !isFingerprint(value.generationFingerprint)
        || !isFingerprint(value.serverFingerprint)
        || !Number.isSafeInteger(value.pid)
        || (value.pid as number) <= 1
        || typeof value.processStartIdentity !== 'string'
        || value.processStartIdentity.trim().length === 0
        || (endpointRecord.host !== '127.0.0.1' && endpointRecord.host !== '::1')
        || !Number.isSafeInteger(endpointRecord.port)
        || (endpointRecord.port as number) < 1
        || (endpointRecord.port as number) > 65_535
        || !Number.isSafeInteger(value.createdAtMs)
        || (value.createdAtMs as number) < 0
    ) return null;
    return Object.freeze({
        v: 1,
        instanceId: value.instanceId.trim(),
        generationFingerprint: value.generationFingerprint,
        serverFingerprint: value.serverFingerprint,
        pid: value.pid as number,
        processStartIdentity: value.processStartIdentity.trim(),
        endpoint: Object.freeze({
            host: endpointRecord.host,
            port: endpointRecord.port as number,
        }),
        createdAtMs: value.createdAtMs as number,
    });
}

async function atomicWrite(path: string, value: string): Promise<void> {
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
        await handle.writeFile(value, 'utf8');
        await handle.sync();
    } finally {
        await handle.close();
    }
    try {
        await rename(temporaryPath, path);
    } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
    }
}

function resolvePositiveBound(value: number | undefined, fallback: number): number {
    return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value as number : fallback;
}

function redactText(value: string, secretValues: readonly string[]): string {
    let output = value;
    const secrets = [...new Set(secretValues.filter((secret) => secret.length > 0))]
        .sort((left, right) => right.length - left.length);
    for (const secret of secrets) output = output.split(secret).join('[REDACTED]');
    return output;
}

export function createManagedServerDurabilityOwner(params: Readonly<{
    rootDir: string;
    maxCustodyRecords?: number;
    maxLogKeepCount?: number;
    maxLogBytes?: number;
    recover?: (record: ManagedServerCustodyRecord) => Promise<RecoveryOutcome>;
}>): ManagedServerDurabilityOwner {
    const custodyDir = join(params.rootDir, 'custody');
    const corruptDir = join(params.rootDir, 'corrupt');
    const logsDir = join(params.rootDir, 'logs');
    const maxCustodyRecords = resolvePositiveBound(params.maxCustodyRecords, DEFAULT_MAX_CUSTODY_RECORDS);
    const maxLogKeepCount = resolvePositiveBound(params.maxLogKeepCount, DEFAULT_MAX_LOG_KEEP_COUNT);
    const maxLogBytes = resolvePositiveBound(params.maxLogBytes, DEFAULT_MAX_LOG_BYTES);
    let stateQueue = Promise.resolve();

    function runExclusive<T>(operation: () => Promise<T>): Promise<T> {
        const result = stateQueue.then(operation, operation);
        stateQueue = result.then(() => undefined, () => undefined);
        return result;
    }

    async function ensureDirs(): Promise<void> {
        for (const directory of [custodyDir, corruptDir, logsDir]) {
            await mkdir(directory, { recursive: true, mode: 0o700 });
            const facts = await lstat(directory);
            if (!facts.isDirectory() || facts.isSymbolicLink()) {
                return fail('plugin_managed_server_storage_unsafe', 'Managed server storage path is not a private directory');
            }
            await chmod(directory, 0o700);
        }
    }

    function custodyPath(instanceId: string): string {
        return join(custodyDir, `${digest(instanceId)}.json`);
    }

    async function quarantine(path: string): Promise<void> {
        const target = join(corruptDir, `${Date.now().toString().padStart(16, '0')}-${digest(path)}.corrupt`);
        await rename(path, target).catch(async () => await rm(path, { force: true }));
        const corrupt = (await readdir(corruptDir)).filter((entry) => entry.endsWith('.corrupt')).sort();
        const excess = corrupt.slice(0, Math.max(0, corrupt.length - MAX_CORRUPT_RECORDS));
        await Promise.all(excess.map(async (entry) => await rm(join(corruptDir, entry), { force: true })));
    }

    async function claimUnlocked(record: ManagedServerCustodyRecord): Promise<void> {
        const normalized = parseRecord(record);
        if (!normalized) {
            return fail('plugin_managed_server_custody_invalid', 'Managed server custody record is invalid');
        }
        await ensureDirs();
        const target = custodyPath(normalized.instanceId);
        const records = (await readdir(custodyDir)).filter((entry) => entry.endsWith('.json'));
        const targetName = target.slice(custodyDir.length + 1);
        if (!records.includes(targetName) && records.length >= maxCustodyRecords) {
            return fail(
                'plugin_managed_server_custody_capacity_exceeded',
                'Managed server custody capacity is exhausted',
            );
        }
        await atomicWrite(target, `${JSON.stringify(normalized)}\n`);
    }

    async function claim(record: ManagedServerCustodyRecord): Promise<void> {
        await runExclusive(async () => await claimUnlocked(record));
    }

    async function release(instanceId: string): Promise<void> {
        await runExclusive(async () => {
            await ensureDirs();
            await rm(custodyPath(instanceId), { force: true });
        });
    }

    async function reconcile() {
        return await runExclusive(async () => {
            await ensureDirs();
            const counts = { reaped: 0, absent: 0, identityMismatch: 0, failed: 0, corrupt: 0 };
            const entries = (await readdir(custodyDir)).filter((entry) => entry.endsWith('.json')).sort();
            for (const entry of entries) {
                const path = join(custodyDir, entry);
                let record: ManagedServerCustodyRecord | null = null;
                try {
                    record = parseRecord(JSON.parse(await readFile(path, 'utf8')));
                } catch {
                    record = null;
                }
                if (!record || entry !== `${digest(record.instanceId)}.json`) {
                    counts.corrupt += 1;
                    await quarantine(path);
                    continue;
                }
                if (!params.recover) {
                    counts.failed += 1;
                    continue;
                }
                let outcome: RecoveryOutcome = 'failed';
                try {
                    outcome = await params.recover(record);
                } catch {
                    outcome = 'failed';
                }
                counts[outcome] += 1;
                if (outcome !== 'failed') await rm(path, { force: true });
            }
            return Object.freeze(counts);
        });
    }

    async function pruneLogs(keepCount: number, keepName: string): Promise<void> {
        const entries = (await readdir(logsDir)).filter((entry) => entry.endsWith('.log')).sort().reverse();
        const keep = new Set(entries.slice(0, keepCount));
        keep.add(keepName);
        await Promise.all(entries
            .filter((entry) => !keep.has(entry))
            .map(async (entry) => await rm(join(logsDir, entry), { force: true })));
    }

    async function openLog(input: Parameters<ManagedServerDurabilityOwner['openLog']>[0]): Promise<ManagedServerDurableLogCapture> {
        await ensureDirs();
        const nowMs = Number.isSafeInteger(input.nowMs) && (input.nowMs ?? 0) >= 0 ? input.nowMs as number : Date.now();
        const name = `${String(nowMs).padStart(16, '0')}-${digest(input.instanceId)}.log`;
        const path = join(logsDir, name);
        const keepCount = Math.min(
            resolvePositiveBound(input.keepCount, maxLogKeepCount),
            maxLogKeepCount,
        );
        const header = Buffer.from([
            '# managed server log v1',
            `# instance: ${digest(input.instanceId)}`,
            `# server: ${digest(input.serverId)}`,
            `# openedAtMs: ${nowMs}`,
            '',
        ].join('\n'), 'utf8').subarray(0, maxLogBytes);
        let writtenBytes = header.byteLength;
        let queue = atomicWrite(path, header.toString('utf8'));
        let closed = false;
        const append = async (data: Uint8Array) => {
            const handle = await open(path, 'a', 0o600);
            try {
                await handle.writeFile(data);
            } finally {
                await handle.close();
            }
        };
        return Object.freeze({
            path,
            write(source, chunk) {
                if (closed) return;
                const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
                const redacted = redactText(text, input.secretValues);
                const remaining = Math.max(0, maxLogBytes - writtenBytes);
                if (remaining === 0) return;
                const retained = Buffer.from(`[${source}] ${redacted}`, 'utf8').subarray(0, remaining);
                writtenBytes += retained.byteLength;
                queue = queue.then(async () => await append(retained));
            },
            async close() {
                if (closed) return;
                closed = true;
                await queue;
                await runExclusive(async () => await pruneLogs(keepCount, name));
            },
        });
    }

    return Object.freeze({ claim, release, reconcile, openLog });
}
