import { createHash } from 'node:crypto';
import { writeSync } from 'node:fs';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { DeploymentReceiptDetailV1, DeploymentOwnServerContentV1, OwnServerDeploymentDetailsV1 } from '@happier-dev/deployment-protocol';
import type { ManagedServiceNativeLogCursorV1, ManagedServiceNativeLogResultV1 } from '@happier-dev/protocol';
import { createProtectedLocalStateFileExclusive, ensureProtectedLocalStateDirectory,
    openProtectedLocalStateFile } from '@/utils/fs/protectedLocalState';
import { MANAGED_SERVICE_NATIVE_LOG_PAGE_BYTES } from '@/plugins/runtime/invocation/services/managedServiceNativeLogBudget';
import { createManagedServiceNativeLogs } from '@/plugins/runtime/invocation/services/managedServiceNativeLogs';
import { resolveDeploymentSourcePathForHost, resolveOwnServerDeploymentEnvironmentInstanceIdForHost } from './paths';

export const OWN_SERVER_STAGE_LOG_RELATIVE_PATH = '.happier/deploy.log' as const;
export type OwnServerStageLogProvenance = NonNullable<OwnServerDeploymentDetailsV1['stageLogs']>[number];
export type OwnServerDeploymentStageLogWriter = Readonly<{
    provenance: OwnServerStageLogProvenance;
    beginStep(input: Readonly<{ stepId: string }>): Promise<void>;
    appendRedacted(stream: 'stdout' | 'stderr', chunk: Uint8Array): void;
    assertWritten(): void;
    close(): Promise<void>;
}>;
type Placement = Readonly<{ deploymentRoot: string; environmentInstanceId: string; deploymentId: string }>;
type StageLogChange = Readonly<{ provenance: OwnServerStageLogProvenance; appended: false }>
    | Readonly<{ stepId?: string; appended: true }>;
// Subscription cleanup only: no retained bytes or second receipt/log authority.
const observers = new Map<string, Set<(change: StageLogChange) => void>>();
function publish(path: string, change: StageLogChange): void {
    for (const listener of observers.get(path) ?? []) listener(change);
}
/** Snapshot this invocation's already-masked sink into the same protected receipt content. */
export function captureOwnServerDeploymentStageLog(content: DeploymentOwnServerContentV1,
    output: Pick<OwnServerDeploymentStageLogWriter, 'provenance'> | undefined): DeploymentOwnServerContentV1 {
    if (!output || !content.ownServer) return content;
    const snapshot = output.provenance;
    return { ...content, ownServer: { ...content.ownServer, stageLogs: [
        ...(content.ownServer.stageLogs ?? []).filter(log => log.machineId !== snapshot.machineId
            || log.installationId !== snapshot.installationId), snapshot,
    ] } };
}
const unavailable = (): never => { throw Object.assign(new Error('Deployment stage log custody is unavailable'), { code: 'deployment_log_unavailable' }); };

export function resolveOwnServerStageLogPathForHost(input: Placement): string {
    return join(resolveDeploymentSourcePathForHost(input), '.happier', 'deploy.log');
}

/** The configured root and each owned descendant are real private directories. */
async function stageParent(input: Placement, create: boolean): Promise<string> {
    resolveDeploymentSourcePathForHost(input);
    await ensureProtectedLocalStateDirectory(input.deploymentRoot, { authority: create ? 'owned' : 'admitted', createIfMissing: create });
    let path = await realpath(input.deploymentRoot);
    for (const segment of [input.environmentInstanceId, 'releases']) {
        path = join(path, segment);
        await ensureProtectedLocalStateDirectory(path, { authority: create ? 'owned' : 'admitted', createIfMissing: create });
    }
    return path;
}
async function stageDirectory(input: Placement, create: boolean): Promise<string> {
    let path = await stageParent(input, create);
    for (const segment of [input.deploymentId, '.happier']) {
        path = join(path, segment);
        await ensureProtectedLocalStateDirectory(path, { authority: create ? 'owned' : 'admitted', createIfMissing: create });
    }
    return path;
}

/** Only already-sanitized supervisor chunks enter this operation-owned file. */
export async function openOwnServerDeploymentStageLog(input: Placement & Readonly<{
    machineId: string; installationId: string; expected?: OwnServerStageLogProvenance;
    onProvenance?(value: OwnServerStageLogProvenance): Promise<void>;
}>): Promise<OwnServerDeploymentStageLogWriter> {
    let directory: string;
    if (input.expected) directory = await stageDirectory(input, false);
    else {
        const parent = await stageParent(input, true);
        const release = join(parent, input.deploymentId);
        // A new receipt owns only an absent destination.
        // Exclusive mkdir must refuse before chmod or insertion into a foreign root.
        try { await mkdir(release, { mode: 0o700 }); }
        catch (error) {
            if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') return unavailable();
            throw error;
        }
        await ensureProtectedLocalStateDirectory(release, { authority: 'owned', createIfMissing: false });
        directory = join(release, '.happier');
        await ensureProtectedLocalStateDirectory(directory, { authority: 'owned' });
    }
    const path = join(directory, 'deploy.log');
    // Reopening a retained placement never recreates missing output.
    if (!input.expected) await createProtectedLocalStateFileExclusive(path, new Uint8Array());
    const handle = await openProtectedLocalStateFile(path, 'a');
    try {
        if (input.expected && (input.expected.machineId !== input.machineId || input.expected.installationId !== input.installationId
            || input.expected.relativePath !== OWN_SERVER_STAGE_LOG_RELATIVE_PATH)) return unavailable();
        const provenance: OwnServerStageLogProvenance = { machineId: input.machineId, installationId: input.installationId,
            relativePath: OWN_SERVER_STAGE_LOG_RELATIVE_PATH };
        const steps = input.expected?.steps?.map(step => ({ ...step, range: { ...step.range } })) ?? [];
        let position = (await handle.stat()).size;
        let activeStep = steps.at(-1)?.range.end === null ? steps.at(-1) : undefined;
        let closed = false;
        let failure: unknown;
        // Same diagnostic-window budget as the existing native stage-log reader.
        let tail = Buffer.from(input.expected?.excerpt?.text ?? '');
        let truncated = input.expected?.excerpt?.truncated ?? false;
        const snapshot = (): OwnServerStageLogProvenance => {
            let start = 0;
            while (start < tail.length && (tail[start]! & 0xc0) === 0x80) start++;
            const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(tail.subarray(start), { stream: true });
            return { ...provenance, ...(steps.length ? { steps: steps.map(step => ({ ...step, range: { ...step.range } })) } : {}),
                ...(tail.length ? { excerpt: { text, truncated } } : {}) };
        };
        return { get provenance() { return snapshot(); },
            async beginStep({ stepId }) {
                if (closed || failure !== undefined) return unavailable();
                if (activeStep?.ref === stepId) return;
                if (activeStep) activeStep.range.end = position;
                activeStep = { ref: stepId, range: { start: position, end: null } };
                steps.push(activeStep);
                // Publish the closed predecessor and admitted open range BEFORE next-phase bytes.
                await input.onProvenance?.(snapshot());
                publish(path, { provenance: snapshot(), appended: false });
            },
            appendRedacted(_stream: 'stdout' | 'stderr', chunk: Uint8Array) {
                if (closed || failure !== undefined || chunk.byteLength === 0) return;
                try {
                    let offset = 0;
                    while (offset < chunk.byteLength) offset += writeSync(handle.fd, chunk, offset);
                    position += chunk.byteLength;
                    const combined = Buffer.concat([tail, chunk]);
                    truncated ||= combined.length > MANAGED_SERVICE_NATIVE_LOG_PAGE_BYTES;
                    tail = Buffer.from(combined.subarray(Math.max(0, combined.length - MANAGED_SERVICE_NATIVE_LOG_PAGE_BYTES)));
                    if (observers.has(path)) publish(path, { stepId: activeStep?.ref, appended: true });
                } catch (error) { failure = error; }
            },
            assertWritten() { if (closed || failure !== undefined) return unavailable(); },
            async close() { if (closed) return; closed = true; await handle.close(); if (failure !== undefined) return unavailable(); },
        };
    } catch (error) { await handle.close(); throw error; }
}

export type OwnServerStageLogReceipt = Readonly<{ deployment: Pick<DeploymentReceiptDetailV1['deployment'], 'id' | 'environmentId'>; content: Readonly<{
    buildMachineId: string; machines?: readonly string[]; ownServer?: Readonly<{ stageLogs?: readonly OwnServerStageLogProvenance[] }>;
}> }>;
export type OwnServerStageLogReadOptions = Readonly<{
    ref?: string; tail?: true; cursor?: ManagedServiceNativeLogCursorV1; signal?: AbortSignal;
    expectedSourceRevision?: string;
    observation?: Readonly<{ signal: AbortSignal; emit(value: ManagedServiceNativeLogResultV1): void;
        accept(value: Readonly<{ dispose(): Promise<void> }>): void }>;
}>;
type LogHost = Readonly<{ deploymentRoot: string; serverId: string; machineId: string; installationId: string }>;

/** The native watch substrate retains cleanup; this sink remains the only byte/range reader. */
export async function readOwnServerDeploymentStageLogs(host: LogHost, receipt: OwnServerStageLogReceipt,
    options: OwnServerStageLogReadOptions = {}): Promise<ManagedServiceNativeLogResultV1> {
    const observation = options.observation;
    if (!observation) return readStageLogPage(host, receipt, options);
    let currentReceipt = receipt;
    let baseline: string | undefined;
    let dirty = false;
    let draining = false;
    let active = false;
    let catchUp = () => {};
    const signal = AbortSignal.any([observation.signal, ...(options.signal ? [options.signal] : [])]);
    const path = resolveOwnServerStageLogPathForHost({ deploymentRoot: host.deploymentRoot,
        environmentInstanceId: resolveOwnServerDeploymentEnvironmentInstanceIdForHost(host.serverId, receipt.deployment.environmentId),
        deploymentId: receipt.deployment.id });
    const logs = createManagedServiceNativeLogs({ signal, maxBytes: MANAGED_SERVICE_NATIVE_LOG_PAGE_BYTES,
        isCurrent: () => !signal.aborted, redactedValues: () => [], async invoke(request) {
            if (request.kind === 'read') return readStageLogPage(host, currentReceipt, options);
            const drain = async () => {
                if (!active || draining || signal.aborted) return;
                draining = true;
                try {
                    while (dirty && !signal.aborted) {
                        dirty = false;
                        const value = await readStageLogPage(host, currentReceipt, { ...options, observation: undefined, signal });
                        if (signal.aborted) return;
                        const key = value.kind === 'page' ? JSON.stringify(value.page.nextCursor) : JSON.stringify(value);
                        if (key === baseline) continue;
                        baseline = key;
                        request.emit(value);
                    }
                } finally { draining = false; }
            };
            const listener = (change: StageLogChange) => {
                if (!change.appended) {
                    const provenance = options.ref === undefined ? change.provenance : { ...change.provenance,
                        steps: change.provenance.steps?.filter(step => step.ref === options.ref) };
                    currentReceipt = { ...receipt, content: { ...receipt.content, ownServer: { stageLogs: [provenance] } } };
                    return;
                }
                if (options.ref !== undefined && options.ref !== change.stepId) return;
                dirty = true;
                catchUp();
            };
            catchUp = () => { void drain().catch(() => {
                if (!signal.aborted) request.emit({ kind: 'unavailable', reason: 'unavailable' });
            }); };
            const listeners = observers.get(path) ?? new Set<(change: StageLogChange) => void>();
            listeners.add(listener); observers.set(path, listeners);
            return { async dispose() {
                listeners.delete(listener);
                if (listeners.size === 0) observers.delete(path);
            } };
        } });
    const watch = await logs.watch({ signal, emit: observation.emit });
    try {
        // Subscribe BEFORE the first page. An append during admission is reconciled from this same sink.
        const value = await readStageLogPage(host, currentReceipt, options);
        if (value.kind !== 'page') { await watch.dispose(); return value; }
        baseline = JSON.stringify(value.page.nextCursor);
        active = true;
        observation.accept(watch);
        if (dirty) {
            // The already-registered producer edge drives catch-up, never a timer.
            catchUp();
        }
        return value;
    } catch (error) { await watch.dispose(); throw error; }
}

/** The admitted receipt selects the producer; no caller path or byte budget reaches this reader. */
async function readStageLogPage(host: Readonly<{
    deploymentRoot: string; serverId: string; machineId: string; installationId: string;
}>, receipt: OwnServerStageLogReceipt, options?: OwnServerStageLogReadOptions): Promise<ManagedServiceNativeLogResultV1> {
    options?.signal?.throwIfAborted();
    const provenance = receipt.content.ownServer?.stageLogs?.find(log => log.machineId === host.machineId
        && log.installationId === host.installationId && log.relativePath === OWN_SERVER_STAGE_LOG_RELATIVE_PATH);
    if (!provenance || receipt.content.buildMachineId !== host.machineId && !receipt.content.machines?.includes(host.machineId)) {
        return { kind: 'unavailable', reason: 'admission_unavailable' };
    }
    let selected = options?.ref === undefined ? undefined : provenance.steps?.filter(step => step.ref === options.ref);
    if (selected?.length === 0 || options?.ref !== undefined && selected === undefined)
        return { kind: 'unavailable', reason: 'admission_unavailable' };
    const environmentInstanceId = resolveOwnServerDeploymentEnvironmentInstanceIdForHost(host.serverId, receipt.deployment.environmentId);
    const placement = { deploymentRoot: host.deploymentRoot, environmentInstanceId,
        deploymentId: receipt.deployment.id };
    const path = resolveOwnServerStageLogPathForHost(placement);
    // A phase can close while this page awaits filesystem IO. Its writer publishes
    // that exact boundary before any next-phase bytes, so an admitted open range
    // never absorbs a later step. This temporary listener retains no log bytes.
    const changed = (change: StageLogChange) => {
        if (!change.appended && options?.ref !== undefined)
            selected = change.provenance.steps?.filter(step => step.ref === options.ref);
    };
    const listeners = observers.get(path) ?? new Set<(change: StageLogChange) => void>();
    if (options?.ref !== undefined) { listeners.add(changed); observers.set(path, listeners); }
    try {
        const directory = await stageDirectory(placement, false);
        const handle = await openProtectedLocalStateFile(join(directory, 'deploy.log'), 'r');
        try {
            const stat = await handle.stat({ bigint: true });
            const sourceRevision = createHash('sha256').update(JSON.stringify([environmentInstanceId,
                receipt.deployment.id, host.machineId, host.installationId,
                String(stat.dev), String(stat.ino), String(stat.birthtimeNs), ...(options?.ref === undefined ? [] : [options.ref])])).digest('hex');
            if (options?.expectedSourceRevision !== undefined && options.expectedSourceRevision !== sourceRevision)
                return { kind: 'source-changed', sourceRevision };
            if (options?.cursor && options.cursor.sourceRevision !== sourceRevision) return { kind: 'source-changed', sourceRevision };
            const ranges = selected?.map(step => ({ start: step.range.start, end: step.range.end ?? Number(stat.size) }))
                ?? [{ start: 0, end: Number(stat.size) }];
            if (ranges.some(range => range.end < range.start || BigInt(range.end) > stat.size))
                return { kind: 'unavailable', reason: 'unavailable' };
            const size = ranges.reduce((total, range) => total + range.end - range.start, 0);
            const token = options?.cursor?.token ?? String(options?.tail ? Math.max(0, size - MANAGED_SERVICE_NATIVE_LOG_PAGE_BYTES) : 0);
            if (!/^(?:0|[1-9]\d*)$/u.test(token)) return { kind: 'source-changed', sourceRevision };
            const offset = Number(token);
            if (!Number.isSafeInteger(offset) || offset > size) return { kind: 'source-changed', sourceRevision };
            const bytes = Buffer.allocUnsafe(MANAGED_SERVICE_NATIVE_LOG_PAGE_BYTES);
            options?.signal?.throwIfAborted();
            let bytesRead = 0;
            let skipped = 0;
            for (const range of ranges) {
                const length = range.end - range.start;
                const within = Math.max(0, offset - skipped);
                skipped += length;
                if (within >= length) continue;
                const read = await handle.read(bytes, bytesRead, Math.min(bytes.length - bytesRead, length - within), range.start + within);
                bytesRead += read.bytesRead;
                if (bytesRead === bytes.length) break;
            }
            options?.signal?.throwIfAborted();
            let start = 0;
            if (options?.tail && !options.cursor) while (start < bytesRead && (bytes[start]! & 0xc0) === 0x80) start++;
            const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(start, bytesRead), { stream: true });
            const nextOffset = offset + start + Buffer.byteLength(text, 'utf8');
            return { kind: 'page', page: { sourceRevision, text,
                nextCursor: { sourceRevision, token: String(nextOffset) }, truncated: nextOffset < size || !!options?.tail && offset > 0 } };
        } finally { await handle.close(); }
    } catch (error) {
        options?.signal?.throwIfAborted();
        return { kind: 'unavailable', reason: 'unavailable' };
    } finally {
        listeners.delete(changed);
        if (listeners.size === 0) observers.delete(path);
    }
}
