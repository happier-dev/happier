import { createHash, randomUUID } from 'node:crypto';
import { chmod, link, lstat, open, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { PluginError } from '@happier-dev/plugin-sdk';
import {
    createManagedServiceEndpointProjectionV1,
    managedServiceEndpointProjectionFileName,
    parseManagedServiceEndpointProjectionV1,
    readManagedServiceEndpointProjectionCandidates,
    type ManagedServiceEndpointProjectionInputV1,
    type ManagedServiceEndpointProjectionV1,
    type ManagedServiceEndpointProjectionResolveQuery,
} from './managedServiceEndpointProjection';
import {
    readPrivateOwnerFile,
    replacePrivateBearerFile,
} from '@/daemon/privateBearerFile';
import { killProcessTree } from '@/agent/runtime/process/killProcessTree';
import { readProcessIdentityByPid } from '@/daemon/processIdentity';
import {
    MANAGED_SERVICE_NUMERIC_CONTRACT,
} from './managedServiceSpecNormalization';

export type ManagedServiceDurableLogCapture = Readonly<{
    path: string;
    write(source: 'stdout' | 'stderr', chunk: Uint8Array | string): void;
    close(): Promise<void>;
}>;

/**
 * Durability effects consumed by one managed-service process lifecycle.
 *
 * Session-wide projection resolution and orphan retirement stay on the daemon's persisted
 * projection-store owner. A Session runner implements this smaller port by routing projection
 * publication to that daemon while retaining its process logs locally.
 */
export interface ManagedServiceProcessDurabilityOwner {
    publishEndpointProjection(
        record: ManagedServiceEndpointProjectionInputV1,
    ): Promise<string>;
    releaseEndpointProjection(input: Readonly<{
        instanceId: string;
        projectionToken: string;
        sessionId: string;
        pluginId: string;
    }>): Promise<boolean>;
    openLog(input: Readonly<{
        instanceId: string;
        serverId: string;
        keepCount: number;
        secretValues: readonly string[];
        nowMs?: number;
    }>): Promise<ManagedServiceDurableLogCapture>;
}

export interface ManagedServiceDurabilityOwner
    extends ManagedServiceProcessDurabilityOwner {
    resolveEndpointProjection(
        query: ManagedServiceEndpointProjectionResolveQuery,
    ): Promise<ManagedServiceEndpointProjectionV1 | null>;
    /**
     * Terminate and forget the managed children a Session runner owned when that runner is gone.
     *
     * A managed child is spawned detached, so it outlives its runner: a `SIGKILL`ed or crashed
     * runner runs none of its own cleanup and the child keeps its port, its listener and the host
     * credential in its process memory, while the next runner allocates another one. The projection
     * this owner already persists carries the exact pid and process birthday, so the child can be
     * identified without a second registry — and the birthday is what stops a recycled pid from
     * being killed in its place.
     */
    retireSessionRunnerOwnedProjections(input: Readonly<{
        sessionId: string;
    }>): Promise<readonly number[]>;
}

const DEFAULT_MAX_ENDPOINT_PROJECTIONS = 256;
const DEFAULT_MAX_LOG_BYTES = 8 * 1024 * 1024;

export async function observeManagedServiceProcessStartIdentity(
    pid: number,
    dependencies: Readonly<{
        readProcessIdentityByPidFn?: typeof readProcessIdentityByPid;
        signalProcessFn?: (pid: number, signal: 0) => void;
    }> = {},
): Promise<string | null> {
    const readIdentity = dependencies.readProcessIdentityByPidFn ?? readProcessIdentityByPid;
    const identity = await readIdentity(pid);
    if (identity?.processStartTimeMs !== undefined) {
        return `${pid}:${identity.processStartTimeMs}`;
    }
    try {
        (dependencies.signalProcessFn ?? process.kill)(pid, 0);
    } catch (error) {
        if (
            error
            && typeof error === 'object'
            && 'code' in error
            && error.code === 'ESRCH'
        ) return null;
    }
    throw new Error('Managed server process identity observation is unavailable');
}

function fail(code: string, message: string): never {
    throw new PluginError({ code, message });
}

function digest(value: string): string {
    return createHash('sha256').update(value).digest('hex');
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

function normalizeSecretValues(secretValues: readonly string[]): readonly string[] {
    return [...new Set(secretValues.filter((secret) => secret.length > 0))]
        .sort((left, right) => right.length - left.length);
}

type ManagedServiceLogSource = 'stdout' | 'stderr';
type ManagedServiceRedactedLogSegment = Readonly<{
    source: ManagedServiceLogSource;
    text: string;
}>;

function appendRedactedLogSegment(
    segments: ManagedServiceRedactedLogSegment[],
    source: ManagedServiceLogSource,
    text: string,
): void {
    if (!text) return;
    const previous = segments.at(-1);
    if (previous?.source === source) {
        segments[segments.length - 1] = { source, text: previous.text + text };
        return;
    }
    segments.push({ source, text });
}

function redactStreamingText(
    value: string,
    priorPendingOrigins: readonly ManagedServiceLogSource[],
    currentSource: ManagedServiceLogSource,
    secrets: readonly string[],
    final: boolean,
): Readonly<{
    emitted: readonly ManagedServiceRedactedLogSegment[];
    pending: string;
    pendingOrigins: readonly ManagedServiceLogSource[];
}> {
    const maxSecretLength = secrets[0]?.length ?? 0;
    const emitted: ManagedServiceRedactedLogSegment[] = [];
    const sourceAt = (index: number): ManagedServiceLogSource => (
        index < priorPendingOrigins.length
            ? priorPendingOrigins[index]!
            : currentSource
    );
    let cursor = 0;
    while (cursor < value.length) {
        const matchingSecret = secrets.find((secret) => value.startsWith(secret, cursor));
        if (matchingSecret) {
            appendRedactedLogSegment(emitted, sourceAt(cursor), '[REDACTED]');
            cursor += matchingSecret.length;
            continue;
        }
        const remainingLength = value.length - cursor;
        if (
            !final
            && remainingLength < maxSecretLength
            && secrets.some((secret) => (
                remainingLength < secret.length
                && secret.startsWith(value.slice(cursor))
            ))
        ) break;
        appendRedactedLogSegment(emitted, sourceAt(cursor), value[cursor]!);
        cursor += 1;
    }
    return {
        emitted,
        pending: value.slice(cursor),
        pendingOrigins: Array.from(
            { length: value.length - cursor },
            (_, index) => sourceAt(cursor + index),
        ),
    };
}

export function createManagedServiceDurabilityOwner(params: Readonly<{
    rootDir: string;
    maxEndpointProjections?: number;
    maxLogBytes?: number;
    observeProcessStartIdentity?: (pid: number) => Promise<string | null>;
    /** The canonical cross-platform process-tree terminator; injected only by tests. */
    terminateProcessTree?: (input: Readonly<{ pid: number }>) => Promise<void>;
}>): ManagedServiceDurabilityOwner {
    const endpointProjectionsDir = join(params.rootDir, 'endpoint-projections');
    const logsDir = join(params.rootDir, 'logs');
    const maxEndpointProjections = resolvePositiveBound(
        params.maxEndpointProjections,
        DEFAULT_MAX_ENDPOINT_PROJECTIONS,
    );
    const maxLogBytes = resolvePositiveBound(params.maxLogBytes, DEFAULT_MAX_LOG_BYTES);
    let stateQueue = Promise.resolve();

    function runExclusive<T>(operation: () => Promise<T>): Promise<T> {
        const result = stateQueue.then(operation, operation);
        stateQueue = result.then(() => undefined, () => undefined);
        return result;
    }

    async function ensureDirs(): Promise<void> {
        for (const directory of [endpointProjectionsDir, logsDir]) {
            await mkdir(directory, { recursive: true, mode: 0o700 });
            const facts = await lstat(directory);
            if (!facts.isDirectory() || facts.isSymbolicLink()) {
                return fail('plugin_managed_server_storage_unsafe', 'Managed server storage path is not a private directory');
            }
            await chmod(directory, 0o700);
        }
    }

    function endpointProjectionPath(instanceId: string): string {
        return join(
            endpointProjectionsDir,
            managedServiceEndpointProjectionFileName(instanceId),
        );
    }

    async function readEndpointProjection(
        instanceId: string,
    ): Promise<ManagedServiceEndpointProjectionV1 | null> {
        try {
            return parseManagedServiceEndpointProjectionV1(JSON.parse(
                await readPrivateOwnerFile(endpointProjectionPath(instanceId)),
            ));
        } catch {
            return null;
        }
    }

    async function removeEndpointProjectionIfCurrent(
        projection: ManagedServiceEndpointProjectionV1,
    ): Promise<boolean> {
        const target = endpointProjectionPath(projection.instanceId);
        const staged = `${target}.${process.pid}.${randomUUID()}.reap`;
        try {
            await rename(target, staged);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
            throw error;
        }
        let removeStaged = false;
        try {
            let current: ManagedServiceEndpointProjectionV1 | null = null;
            try {
                current = parseManagedServiceEndpointProjectionV1(
                    JSON.parse(await readPrivateOwnerFile(staged)),
                );
            } catch {
                current = null;
            }
            if (current?.projectionToken === projection.projectionToken) {
                removeStaged = true;
                return true;
            }
            try {
                await link(staged, target);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            }
            removeStaged = true;
            return false;
        } finally {
            if (removeStaged) await rm(staged, { force: true });
        }
    }

    async function observeManagedSpawnProjectionState(
        projection: ManagedServiceEndpointProjectionV1,
    ): Promise<'live' | 'stale' | 'unknown'> {
        if (
            projection.mode !== 'managedSpawn'
            || !params.observeProcessStartIdentity
        ) return 'unknown';
        try {
            const currentStartIdentity = await params
                .observeProcessStartIdentity(projection.process.pid);
            return currentStartIdentity === projection.process.startIdentity
                ? 'live'
                : 'stale';
        } catch {
            return 'unknown';
        }
    }

    async function pruneDanglingEndpointProjections(
        projections = readManagedServiceEndpointProjectionCandidates(params.rootDir),
    ): Promise<void> {
        for (const projection of projections) {
            if (projection.mode !== 'managedSpawn') continue;
            if (await observeManagedSpawnProjectionState(projection) === 'stale') {
                await removeEndpointProjectionIfCurrent(projection);
            }
        }
    }

    async function publishEndpointProjection(
        record: ManagedServiceEndpointProjectionInputV1,
    ): Promise<string> {
        return await runExclusive(async () => {
            const projection = createManagedServiceEndpointProjectionV1(record);
            await ensureDirs();
            const target = endpointProjectionPath(projection.instanceId);
            let records = (await readdir(endpointProjectionsDir))
                .filter((entry) => entry.endsWith('.json'));
            const targetName = target.slice(endpointProjectionsDir.length + 1);
            if (!records.includes(targetName) && records.length >= maxEndpointProjections) {
                await pruneDanglingEndpointProjections();
                records = (await readdir(endpointProjectionsDir))
                    .filter((entry) => entry.endsWith('.json'));
            }
            if (!records.includes(targetName) && records.length >= maxEndpointProjections) {
                return fail(
                    'plugin_managed_server_projection_capacity_exceeded',
                    'Managed server endpoint projection capacity is exhausted',
                );
            }
            await replacePrivateBearerFile({
                path: target,
                contents: `${JSON.stringify(projection)}\n`,
            });
            return projection.projectionToken;
        });
    }

    async function releaseEndpointProjection(input: Readonly<{
        instanceId: string;
        projectionToken: string;
        sessionId: string;
        pluginId: string;
    }>): Promise<boolean> {
        return await runExclusive(async () => {
            await ensureDirs();
            const path = endpointProjectionPath(input.instanceId);
            let current = null;
            try {
                current = parseManagedServiceEndpointProjectionV1(
                    JSON.parse(await readPrivateOwnerFile(path)),
                );
            } catch {
                current = null;
            }
            if (
                !current
                || current.instanceId !== input.instanceId
                || current.projectionToken !== input.projectionToken
                || current.sessionId !== input.sessionId
                || current.pluginId !== input.pluginId
            ) return false;
            return await removeEndpointProjectionIfCurrent(current);
        });
    }

    async function resolveEndpointProjection(
        query: ManagedServiceEndpointProjectionResolveQuery,
    ): Promise<ManagedServiceEndpointProjectionV1 | null> {
        if (
            query.selector.kind === 'currentContribution'
            && (
                query.sessionId !== undefined
                || query.contributionId === undefined
                || query.immutableGenerationId === undefined
            )
        ) return null;
        return await runExclusive(async () => {
            await ensureDirs();
            const readMatches = () => readManagedServiceEndpointProjectionCandidates(params.rootDir)
                .filter((projection) => projection.pluginId === query.pluginId)
                .filter((projection) => (
                    query.sessionId === undefined || projection.sessionId === query.sessionId
                ))
                .filter((projection) => (
                    query.contributionId === undefined
                    || projection.contributionId === query.contributionId
                ))
                .filter((projection) => (
                    query.immutableGenerationId === undefined
                    || projection.immutableGenerationId
                        === query.immutableGenerationId
                ))
                .filter((projection) => {
                    if (query.selector.kind === 'baseUrl') {
                        return projection.endpoint.baseUrl
                            === query.selector.baseUrl.replace(/\/+$/u, '');
                    }
                    if (query.selector.kind === 'projectionToken') {
                        return projection.projectionToken
                            === query.selector.projectionToken;
                    }
                    return projection.custodyOwner === 'sessionRunner'
                        && projection.mode === 'managedSpawn';
                });
            let matches = readMatches();
            if (matches.length > 1) {
                await pruneDanglingEndpointProjections(matches);
                matches = readMatches();
            }
            if (matches.length !== 1) return null;
            const projection = matches[0]!;
            if (projection.mode === 'externalAttach') return projection;
            const observedState = await observeManagedSpawnProjectionState(projection);
            if (observedState === 'stale') {
                await removeEndpointProjectionIfCurrent(projection);
                return null;
            }
            if (observedState !== 'live') return null;
            const current = await readEndpointProjection(projection.instanceId);
            return current?.projectionToken === projection.projectionToken
                ? projection
                : null;
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

    async function openLog(input: Parameters<ManagedServiceDurabilityOwner['openLog']>[0]): Promise<ManagedServiceDurableLogCapture> {
        await ensureDirs();
        const nowMs = Number.isSafeInteger(input.nowMs) && (input.nowMs ?? 0) >= 0 ? input.nowMs as number : Date.now();
        const name = `${String(nowMs).padStart(16, '0')}-${digest(input.instanceId)}.log`;
        const path = join(logsDir, name);
        const keepCount = input.keepCount;
        if (
            !Number.isSafeInteger(keepCount)
            || keepCount < 1
            || keepCount
                > MANAGED_SERVICE_NUMERIC_CONTRACT
                    .durableLogKeepCount.maximum
        ) {
            return fail(
                'plugin_managed_server_log_keep_count_invalid',
                'Managed server durable-log keep count must be between 1 and 50',
            );
        }
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
        const secrets = normalizeSecretValues(input.secretValues);
        const streams = {
            stdout: new StringDecoder('utf8'),
            stderr: new StringDecoder('utf8'),
        };
        let pendingText = '';
        let pendingOrigins: readonly ManagedServiceLogSource[] = [];
        const append = async (data: Uint8Array) => {
            const handle = await open(path, 'a', 0o600);
            try {
                await handle.writeFile(data);
            } finally {
                await handle.close();
            }
        };
        const appendRedacted = (source: ManagedServiceLogSource, text: string, final: boolean) => {
            const redacted = redactStreamingText(
                pendingText + text,
                pendingOrigins,
                source,
                secrets,
                final,
            );
            pendingText = redacted.pending;
            pendingOrigins = redacted.pendingOrigins;
            for (const segment of redacted.emitted) {
                const remaining = Math.max(0, maxLogBytes - writtenBytes);
                if (remaining === 0) return;
                const retained = Buffer.from(`[${segment.source}] ${segment.text}`, 'utf8').subarray(0, remaining);
                writtenBytes += retained.byteLength;
                queue = queue.then(async () => await append(retained));
            }
        };
        return Object.freeze({
            path,
            write(source, chunk) {
                if (closed) return;
                const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
                appendRedacted(source, streams[source].write(bytes), false);
            },
            async close() {
                if (closed) return;
                closed = true;
                for (const source of ['stdout', 'stderr'] as const) {
                    appendRedacted(source, streams[source].end(), false);
                }
                appendRedacted('stdout', '', true);
                await queue;
                await runExclusive(async () => await pruneLogs(keepCount, name));
            },
        });
    }

    async function retireSessionRunnerOwnedProjections(input: Readonly<{
        sessionId: string;
    }>): Promise<readonly number[]> {
        return await runExclusive(async () => {
            await ensureDirs();
            const retiredPids: number[] = [];
            const owned = readManagedServiceEndpointProjectionCandidates(params.rootDir)
                .filter((projection) => projection.sessionId === input.sessionId)
                .filter((projection) => projection.custodyOwner === 'sessionRunner');
            for (const projection of owned) {
                if (projection.mode === 'managedSpawn') {
                    // `live` proves this exact pid is still the process the runner started;
                    // `stale` means the pid was recycled and must not be signalled. `unknown`
                    // leaves the record alone rather than guessing at somebody else's process.
                    const state = await observeManagedSpawnProjectionState(projection);
                    if (state === 'unknown') continue;
                    if (state === 'live') {
                        await (params.terminateProcessTree
                            ?? ((target: Readonly<{ pid: number }>) =>
                                killProcessTree(target)))({
                            pid: projection.process.pid,
                        }).catch(() => undefined);
                        retiredPids.push(projection.process.pid);
                    }
                }
                await removeEndpointProjectionIfCurrent(projection);
            }
            return Object.freeze(retiredPids);
        });
    }

    return Object.freeze({
        publishEndpointProjection,
        releaseEndpointProjection,
        resolveEndpointProjection,
        retireSessionRunnerOwnedProjections,
        openLog,
    });
}
