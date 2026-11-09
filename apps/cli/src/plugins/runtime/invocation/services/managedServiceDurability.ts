import type { createProcessOwnershipRuntime } from '@/daemon/processes/ownership/processOwnershipRuntime';
import type { ProcessStartIdentity } from '@/processes/census/processCensus';
import { equalProcessStart, type ResolvedProcessOwnership } from '@/daemon/processes/ownership/types';
import { createHash, randomUUID } from 'node:crypto';
import { invalidateProcessLaunchDiscovery } from '@/processes/launchNotification';
import { link, open, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { pruneLogs } from '@/utils/logs/pruneLogs';

import {
    probeProcessGroupLiveness,
    type ProcessLiveness,
} from '@happier-dev/cli-common/process';
import { PluginError, type PluginDiagnosticData } from '@happier-dev/plugin-sdk';
import { pluginSourceCustodyV1Equal } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import { createManagedServiceEndpointProjectionV1,
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
import { createProcessTreeTerminator, terminateProcessTree } from '@/processes/terminate/terminateProcessTree';
import { readProcessIdentityByPid, compareProcessGenerationIdentities } from '@/daemon/processIdentity';
import {
    formatDarwinNativeStartIdentity,
    observeNativeDarwinProcessStartIdentity,
    parseProcessCustodyStartIdentity,
    queryProcessCustodyJob,
    resolveProcessCustodyRuntimeExecutable,
} from '@/subprocess/supervision/processCustody';
import {
    MANAGED_SERVICE_NUMERIC_CONTRACT,
} from './managedServiceSpecNormalization';
import {
    ensureProtectedLocalStateDirectory,
} from '@/utils/fs/protectedLocalState';

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
        onDiagnostic?(diagnostic: PluginDiagnosticData): void;
    }>): Promise<ManagedServiceDurableLogCapture>;
}

export interface ManagedServiceDurabilityOwner
    extends ManagedServiceProcessDurabilityOwner {
    /** Exact open logs, including retained logs of current protected Session-runner instances. */
    getCurrentLogPaths(): Promise<readonly string[]>;
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
    /** Retry retained custody only when the canonical fresh native owner is positively ended. */
    retireEndedSessionRunnerOwnedProjections(input: Readonly<{
        processOwnership: Pick<ReturnType<typeof createProcessOwnershipRuntime>, 'readOwners'>;
    }>): Promise<readonly number[]>;
}

const DEFAULT_MAX_LOG_BYTES = 8 * 1024 * 1024;

export async function observeManagedServiceProcessStartIdentity(
    pid: number,
    dependencies: Readonly<{
        platform?: NodeJS.Platform;
        readProcessIdentityByPidFn?: typeof readProcessIdentityByPid;
        signalProcessFn?: (pid: number, signal: 0) => void;
        resolveProcessCustodyRuntimeExecutableFn?: typeof resolveProcessCustodyRuntimeExecutable;
        observeNativeDarwinProcessStartIdentityFn?: typeof observeNativeDarwinProcessStartIdentity;
    }> = {},
): Promise<string | null> {
    const platform = dependencies.platform ?? process.platform;
    if (platform === 'darwin') {
        // The native subsecond witness decides what `ps lstart` never can:
        // two generations of one pid inside one wall-clock second. Absence of
        // the helper silently falls back to the legacy whole-second witness,
        // whose equal comparisons stay fenced downstream.
        const executablePath = (
            dependencies.resolveProcessCustodyRuntimeExecutableFn
            ?? resolveProcessCustodyRuntimeExecutable
        )('darwin');
        if (executablePath) {
            const witness = await (
                dependencies.observeNativeDarwinProcessStartIdentityFn
                ?? observeNativeDarwinProcessStartIdentity
            )({ executablePath, pid });
            if (witness) {
                return formatDarwinNativeStartIdentity(pid, witness);
            }
        }
    }
    const readIdentity = dependencies.readProcessIdentityByPidFn ?? readProcessIdentityByPid;
    const identity = await readIdentity(pid, {
        ...(dependencies.platform ? { platform: dependencies.platform } : {}),
    });
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
    maxLogBytes?: number;
    observeProcessStartIdentity?: (pid: number) => Promise<string | null>;
    /** POSIX process-group witness for detached managed spawns; injected only by tests. */
    observeProcessGroupPresence?: (processGroupId: number) => Promise<ProcessLiveness>;
    /** Windows job-custody witness; injected only by tests. */
    observeProcessCustodyJob?: (jobName: string) => Promise<'absent' | 'live' | 'unknown'>;
    /** Genuine OS census/signal boundaries for the single process-tree owner. */
    processTreeSystemBoundary?: Parameters<typeof createProcessTreeTerminator>[0];
    /** Native-custody runtime resolution; injected only by tests. */
    resolveProcessCustodyRuntimeExecutable?: () => string | null;
    /** The canonical cross-platform process-tree terminator; injected only by tests. */
    terminateProcessTree?: (input: Readonly<{
        pid: number;
        exitCode?: number | null;
    }>) => Promise<void>;
    /** Host platform for the platform-scoped custody branches; injected only by tests. */
    platform?: NodeJS.Platform;
}>): ManagedServiceDurabilityOwner {
    const platform = params.platform ?? process.platform;
    const terminateTargets = createProcessTreeTerminator({ platform, ...params.processTreeSystemBoundary });
    const endpointProjectionsDir = join(params.rootDir, 'endpoint-projections');
    const logsDir = join(params.rootDir, 'logs');
    const maxLogBytes = resolvePositiveBound(params.maxLogBytes, DEFAULT_MAX_LOG_BYTES);
    const openLogPaths = new Set<string>();
    let stateQueue = Promise.resolve();

    function runExclusive<T>(operation: () => Promise<T>): Promise<T> {
        const result = stateQueue.then(operation, operation);
        stateQueue = result.then(() => undefined, () => undefined);
        return result;
    }

    async function ensureDirs(): Promise<void> {
        for (const directory of [endpointProjectionsDir, logsDir]) {
            try {
                await ensureProtectedLocalStateDirectory(directory, {
                    authority: 'owned',
                });
            } catch {
                fail(
                    'plugin_managed_server_storage_unsafe',
                    'Managed server storage path is not a private directory',
                );
            }
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

    async function observeWindowsJobCustody(jobName: string): Promise<'absent' | 'live' | 'unknown'> {
        const executablePath = (
            params.resolveProcessCustodyRuntimeExecutable
            ?? resolveProcessCustodyRuntimeExecutable
        )('win32');
        if (!executablePath) return 'unknown';
        const outcome = await queryProcessCustodyJob({ executablePath, jobName });
        return outcome === 'unavailable' ? 'unknown' : outcome;
    }

    async function terminateWindowsJobCustody(jobName: string, authorizeSignal?: () => Promise<boolean>): Promise<boolean> {
        const result = await terminateTargets({ targets: [], containment: { kind: 'windows_job', name: jobName }, policy: 'kill',
            ...(authorizeSignal ? { authorizeSignal } : {}) });
        return result.status === 'complete';
    }

    async function observeManagedSpawnProjectionState(
        projection: ManagedServiceEndpointProjectionV1,
    ): Promise<'live_root' | 'live_group' | 'stale' | 'unknown'> {
        if (projection.mode !== 'managedSpawn') return 'unknown';
        if (platform === 'win32') {
            // Windows recovery acts on the named job containment, never on a
            // pid birth comparison. Tagged records query the job; predecessor
            // records stay fenced exactly as before: root PID evidence alone
            // must never authorize signalling or forgetting an unprovable
            // surviving tree.
            const tagged = parseProcessCustodyStartIdentity(projection.process.startIdentity);
            if (tagged?.kind !== 'win32-job') return 'unknown';
            const jobState = await (
                params.observeProcessCustodyJob
                ?? observeWindowsJobCustody
            )(tagged.jobName);
            return jobState === 'live'
                ? 'live_root'
                : jobState === 'absent'
                    ? 'stale'
                    : 'unknown';
        }
        if (!params.observeProcessStartIdentity) return 'unknown';
        try {
            const currentStartIdentity = await params
                .observeProcessStartIdentity(projection.process.pid);
            if (currentStartIdentity !== null) {
                const comparison = compareProcessGenerationIdentities(
                    projection.process.startIdentity,
                    currentStartIdentity,
                    platform,
                );
                if (comparison === 'same') return 'live_root';
                if (comparison === 'ambiguous') {
                    // A whole-second legacy record cannot exclude a same-second pid
                    // replacement, and a degraded observer cannot upgrade the pair
                    // either. Fence the record: retain it for a later, better-evidenced
                    // pass; this evidence never authorizes signaling and never reaps.
                    return 'unknown';
                }
                // A different non-null incarnation proves PID reuse. Never
                // reinterpret the replacement's same-number process group as
                // custody inherited from the retired process.
                return 'stale';
            }
            if (platform === 'darwin') {
                // Darwin predecessor records carry only a whole-second `ps lstart`
                // birthday. Once their root is absent, a same-number process group
                // cannot prove it is the original owned containment rather than a
                // later recycled group. Retain custody without signalling.
                return 'unknown';
            }
            // POSIX managed spawns are launched in a dedicated process
            // group whose id is the root pid. Root turnover is not stale while
            // that owned containment still has descendants. Group absence is
            // the forgetting fact for this containment contract: it proves the
            // owned group is gone, while a descendant that escaped into its own
            // session is outside the group and outside what root/group evidence
            // can observe, so this retirement never claims whole-tree absence.
            const observeGroup = params.observeProcessGroupPresence
                ?? (async (processGroupId: number): Promise<ProcessLiveness> => (
                    probeProcessGroupLiveness(processGroupId)
                ));
            const groupLiveness = await observeGroup(projection.process.pid);
            return groupLiveness === 'alive'
                ? 'live_group'
                : groupLiveness === 'absent'
                    ? 'stale'
                    : 'unknown';
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
            await replacePrivateBearerFile({
                path: target,
                contents: `${JSON.stringify(projection)}\n`,
            });
            invalidateProcessLaunchDiscovery();
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
            )
        ) return null;
        if (
            query.selector.kind === 'currentSessionManagedSpawn'
            && (
                query.sessionId === undefined
                || query.contributionId === undefined
                || query.sourceCustody !== undefined
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
                    query.sourceCustody === undefined
                    || pluginSourceCustodyV1Equal(
                        projection.sourceCustody,
                        query.sourceCustody,
                    )
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
            if (
                observedState !== 'live_root'
                && observedState !== 'live_group'
            ) return null;
            const current = await readEndpointProjection(projection.instanceId);
            return current?.projectionToken === projection.projectionToken
                ? projection
                : null;
        });
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
        let truncationReported = false;
        const reportTruncation = () => {
            if (truncationReported) return;
            truncationReported = true;
            input.onDiagnostic?.({
                code: 'plugin_managed_service_log_truncated',
                severity: 'warning',
                message: 'Managed server durable log reached its byte limit',
                details: { maxBytes: maxLogBytes },
            });
        };
        const fullHeader = Buffer.from([
            '# managed server log v1',
            `# instance: ${digest(input.instanceId)}`,
            `# server: ${digest(input.serverId)}`,
            `# openedAtMs: ${nowMs}`,
            '',
        ].join('\n'), 'utf8');
        const header = fullHeader.subarray(0, maxLogBytes);
        if (header.byteLength < fullHeader.byteLength) reportTruncation();
        let writtenBytes = header.byteLength;
        let queue = atomicWrite(path, header.toString('utf8'));
        openLogPaths.add(path);
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
                const bytes = Buffer.from(`[${segment.source}] ${segment.text}`, 'utf8');
                if (bytes.byteLength > remaining) reportTruncation();
                if (remaining === 0) return;
                const retained = bytes.subarray(0, remaining);
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
                try {
                    await queue;
                    await runExclusive(async () => {
                        const result = await pruneLogs({ dir: logsDir, suffix: '.log', keepCount, keepPaths: [path, ...await getCurrentLogPaths()] });
                        if (result.failures[0]) throw result.failures[0].error;
                    });
                } finally { openLogPaths.delete(path); }
            },
        });
    }

    async function retireProjections(
        owned: readonly ManagedServiceEndpointProjectionV1[],
        authorizeProjection?: (projection: ManagedServiceEndpointProjectionV1, fresh?: boolean) => Promise<readonly Readonly<{ pid: number; start: ProcessStartIdentity }>[] | null>,
    ): Promise<readonly number[]> {
        const retiredPids: number[] = [];
        for (const projection of owned) {
            const authorizedTargets = authorizeProjection ? await authorizeProjection(projection) : undefined;
            if (authorizeProjection && !authorizedTargets?.length) continue;
            if (projection.mode === 'managedSpawn') {
                // `live_root` proves this exact pid is still the process the runner started;
                // `live_group` proves only that its POSIX containment survives root turnover;
                // `stale` means the pid was recycled and must not be signalled. `unknown`
                // leaves the record alone rather than guessing at somebody else's process.
                const state = await observeManagedSpawnProjectionState(projection);
                if (state === 'unknown') continue;
                if (state === 'live_root' || state === 'live_group') {
                    // Windows tagged records terminate through the named
                    // job itself: taskkill against the root pid would
                    // neither reach descendants that outlived the root
                    // nor respect a recycled pid fence.
                    const taggedCustody = platform === 'win32'
                        ? parseProcessCustodyStartIdentity(projection.process.startIdentity)
                        : null;
                    let terminated: boolean;
                    if (taggedCustody?.kind === 'win32-job') {
                        terminated = await terminateWindowsJobCustody(
                            taggedCustody.jobName,
                            authorizeProjection ? async () => Boolean((await authorizeProjection(projection, true))?.length) : undefined,
                        ).catch(() => false);
                    } else if (authorizeProjection && authorizedTargets) {
                        terminated = true;
                        for (const target of authorizedTargets) {
                            const result = await terminateTargets({
                                targets: [target], tree: false, policy: 'kill',
                                authorizeSignal: async () => Boolean((await authorizeProjection(projection, true))?.some(
                                    current => current.pid === target.pid && equalProcessStart(current.start, target.start),
                                )),
                            });
                            if (result.status !== 'complete') terminated = false;
                        }
                    } else {
                        terminated = await (params.terminateProcessTree
                            ?? ((target: Readonly<{
                                pid: number;
                                exitCode?: number | null;
                            }>) =>
                                terminateProcessTree(target, {
                                    ownedProcessGroup: platform !== 'win32',
                                })))({
                            pid: projection.process.pid,
                            ...(state === 'live_group'
                                ? { exitCode: 0 }
                                : {}),
                        }).then(
                            () => true,
                            () => false,
                        );
                    }
                    if (!terminated) continue;
                    // A successful terminator return is not a process-terminal
                    // fact on POSIX unless the dedicated process group is
                    // also absent. Forget this projection only after that
                    // containment proof settles stale.
                    const postTerminationState =
                        await observeManagedSpawnProjectionState(projection);
                    if (postTerminationState !== 'stale') continue;
                    retiredPids.push(projection.process.pid);
                }
            }
            await removeEndpointProjectionIfCurrent(projection);
        }
        return Object.freeze(retiredPids);
    }

    async function retireSessionRunnerOwnedProjections(input: Readonly<{
        sessionId: string;
    }>): Promise<readonly number[]> {
        return await runExclusive(async () => {
            await ensureDirs();
            return await retireProjections(readManagedServiceEndpointProjectionCandidates(params.rootDir)
                .filter(projection => projection.sessionId === input.sessionId && projection.custodyOwner === 'sessionRunner'));
        });
    }

    async function retireEndedSessionRunnerOwnedProjections(input: Readonly<{
        processOwnership: Pick<ReturnType<typeof createProcessOwnershipRuntime>, 'readOwners'>;
    }>): Promise<readonly number[]> {
        return await runExclusive(async () => {
            await ensureDirs();
            const projections = readManagedServiceEndpointProjectionCandidates(params.rootDir)
                .filter(projection => projection.custodyOwner === 'sessionRunner' && projection.mode === 'managedSpawn');
            if (!projections.length) return [];
            const initialView = await input.processOwnership.readOwners({ freshness: 'fresh', requesterAttribution: 'retained' });
            if (initialView.status !== 'ok') return [];
            return await retireProjections(projections,
                async (projection, fresh = false) => {
                    if (projection.mode !== 'managedSpawn') return null;
                    // Share only the selection view of this pass; physical signals always re-read current owners.
                    const view = fresh
                        ? await input.processOwnership.readOwners({ freshness: 'fresh', requesterAttribution: 'retained' })
                        : initialView;
                    if (view.status !== 'ok') return null;
                    if (view.roots.some(root => root.live && (root.owner.kind === 'session'
                        && root.owner.sessionId === projection.sessionId
                        || root.owner.kind === 'service' && root.owner.serviceId === projection.instanceId))) return null;
                    const matchesProjectionOwner = (row: ResolvedProcessOwnership | undefined): boolean => Boolean(
                        row?.level === 'left_behind' && row.ownerEnded && row.owner
                        && (row.owner.kind === 'session' && row.owner.sessionId === projection.sessionId
                            || row.owner.kind === 'service' && row.owner.serviceId === projection.instanceId
                                && row.owner.sessionId === projection.sessionId),
                    );
                    const nativeRoot = view.snapshot.rows.find(row => row.pid === projection.process.pid);
                    const tagged = parseProcessCustodyStartIdentity(projection.process.startIdentity);
                    let members: typeof view.snapshot.rows;
                    if (tagged?.kind === 'win32-job') {
                        members = view.snapshot.rows.filter(row => row.jobs?.includes(tagged.jobName));
                    } else if (nativeRoot) {
                        if (compareProcessGenerationIdentities(projection.process.startIdentity,
                            platform === 'darwin' && nativeRoot.start.native ? nativeRoot.start.native
                                : `${nativeRoot.pid}:${nativeRoot.start.startTimeMs}`, platform) !== 'same') return null;
                        members = view.snapshot.rows.filter(row => row.pid === nativeRoot.pid
                            || view.rows.find(candidate => candidate.pid === row.pid)?.chain.some(ancestor => ancestor.pid === nativeRoot.pid));
                    } else if (platform === 'linux') {
                        // The persisted dedicated group survives its root. Absence alone grants no authority:
                        // every current member still needs exact native evidence of this same ended owner.
                        members = view.snapshot.rows.filter(row => row.pgid === projection.process.pid);
                    } else return null;
                    if (!members.length || members.some(row => row.state === 'zombie'
                        || !matchesProjectionOwner(view.rows.find(candidate => candidate.pid === row.pid)))) return null;
                    // Keep ancestors alive until every child's fresh ownership check has settled.
                    return [...members].sort((left, right) =>
                        (view.rows.find(row => row.pid === right.pid)?.chain.length ?? 0)
                        - (view.rows.find(row => row.pid === left.pid)?.chain.length ?? 0))
                        .map(row => ({ pid: row.pid, start: row.start }));
                });
        });
    }

    async function getCurrentLogPaths(): Promise<readonly string[]> {
        const paths = new Set(openLogPaths);
        const currentInstances = new Set<string>();
        for (const projection of readManagedServiceEndpointProjectionCandidates(params.rootDir)) {
            if (projection.mode === 'managedSpawn' && await observeManagedSpawnProjectionState(projection) !== 'stale') {
                currentInstances.add(digest(projection.instanceId));
            }
        }
        if (currentInstances.size) {
            try {
                for (const name of await readdir(logsDir)) {
                    // The durable writer above owns this exact filename; no external paths are inferred.
                    const match = /^\d{16}-([a-f0-9]{64})\.log$/u.exec(name);
                    if (match && currentInstances.has(match[1]!)) paths.add(join(logsDir, name));
                }
            } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
        return [...paths];
    }

    return Object.freeze({
        publishEndpointProjection,
        releaseEndpointProjection,
        resolveEndpointProjection,
        retireSessionRunnerOwnedProjections,
        retireEndedSessionRunnerOwnedProjections,
        openLog,
        getCurrentLogPaths,
    });
}
