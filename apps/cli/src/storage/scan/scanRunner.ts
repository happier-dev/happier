import { STORAGE_CHART_MAX_DRAWABLE_NODES, type DiskScanStateV1, type DiskScanViewV1, type MachineStorageScanGetResultV1 } from '@happier-dev/protocol/storage/storageV1';
import { startNativeDiskScan, type NativeDiskScan, type NativeDiskScanRequest } from '../measure/nativeDiskMeasure';
import { type StorageScanIndex, type StorageScanVolume } from './scanIndex';
import { canonicalAbsolutePathsEqual, isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';
import { physicalPathWithoutFollowingLeaf } from '@/utils/path/physicalAncestorPath';
import { logger } from '@/ui/logger';
import { storageSystemPartitionReason } from '../protection/protectedPaths';

export function createStorageScanRunner(deps: Readonly<{ index: StorageScanIndex; readVolumes: () => readonly StorageScanVolume[] | Promise<readonly StorageScanVolume[]>;
    readEnabled: () => boolean | undefined | Promise<boolean | undefined>; readLowPower?: () => boolean | Promise<boolean>;
    readScanHints?: (root: string) => Pick<NativeDiskScanRequest, 'priorityHints' | 'atomicRules'> | Promise<Pick<NativeDiskScanRequest, 'priorityHints' | 'atomicRules'>>;
    fullDiskAccess: () => DiskScanStateV1['fullDiskAccess']; onChange?: () => void; onCompleted?: (state: DiskScanStateV1) => void | Promise<void>;
    beforeScheduledEffect?: () => Promise<void>; readVolumesReported?: () => boolean | Promise<boolean>; onScheduledError?: (error: unknown) => void }>) {
    const runs = new Map<string, { native?: NativeDiskScan; done: Promise<void>; volumeId: string; cancelled: boolean; skipped: Set<string> }>();
    let admitting = false;
    let admissionQueue: Promise<unknown> = Promise.resolve();
    function admit<T>(operation: () => Promise<T>): Promise<T> {
        const next = admissionQueue.then(operation); admissionQueue = next.catch(() => {}); return next;
    }
    const pendingVolumes = new Set<string>(); let scheduled: Promise<void> | undefined; let resumeRequested = false; let disposed = false;
    const api = {
        initialize() { return admit(async () => {
            if (disposed) return;
            const [reportedVolumes, enabled, reported] = await Promise.all([deps.readVolumes(), deps.readEnabled(), deps.readVolumesReported?.() ?? true]);
            const volumes = reportedVolumes.filter(volume => !storageSystemPartitionReason(volume.mountPath));
            if (disposed) return;
            if (enabled && !reported) return;
            if (!enabled) pendingVolumes.clear();
            else for (const id of pendingVolumes) if (!volumes.some(volume => volume.id === id)) pendingVolumes.delete(id);
            const removed = [...runs.values()].filter(run => !enabled || !volumes.some(volume => volume.id === run.volumeId));
            for (const run of removed) { run.cancelled = true; run.native?.cancel(); }
            await Promise.allSettled(removed.map(run => run.done));
            // Unknown policy blocks work without authorizing index deletion.
            // Apply retention only once the whole-disk policy is known.
            if (enabled === undefined) return;
            await deps.index.initialize(volumes, enabled, new Set(runs.keys()), () => !disposed);
        }); },
        start(input: Readonly<{ target: DiskScanStateV1['target']; resume?: boolean }>, options: Readonly<{ beforeEffect?: () => Promise<void>; relistOnly?: boolean }> = {}) { return admit(async () => {
            if (!await deps.readEnabled()) throw Object.assign(new Error('Whole-disk scan disabled'), { code: 'disabled' });
            if (disposed) throw Object.assign(new Error('Scan runner closed'), { code: 'closed' });
            if (admitting || runs.size) throw Object.assign(new Error('Scan running'), { code: 'scan_running' });
            admitting = true;
            try {
            if (!await (deps.readVolumesReported?.() ?? true)) throw Object.assign(new Error('Volume reporting unavailable'), { code: 'volumes_unavailable' });
            const volumes = await deps.readVolumes();
            if ('folderPath' in input.target && storageSystemPartitionReason(input.target.folderPath)) {
                throw Object.assign(new Error('System partition cannot be scanned'), { code: 'storage_system_partition' });
            }
            const requested = 'folderPath' in input.target ? (input.target.folderPath.startsWith('bytes:') ? input.target.folderPath : await physicalPathWithoutFollowingLeaf(input.target.folderPath)) : undefined;
            const volume = [...volumes].sort((a, b) => b.mountPath.length - a.mountPath.length).find(value => 'volumeId' in input.target ? value.id === input.target.volumeId :
                requested?.startsWith('bytes:') ? deps.index.readNode(requested)?.volumeId === value.id : requested !== undefined && (canonicalAbsolutePathsEqual(value.mountPath, requested) || isCanonicalAbsolutePathInsideRoot(value.mountPath, requested, { platform: process.platform })));
            if (!volume) throw Object.assign(new Error('Volume unavailable'), { code: 'volume_unavailable' });
            if (storageSystemPartitionReason(volume.mountPath)) throw Object.assign(new Error('System partition cannot be scanned'), { code: 'storage_system_partition' });
            const root = requested ?? volume.mountPath;
            // Only a whole-volume target has a measured denominator. Absence
            // is unknown; a measured volume zero is preserved as zero.
            const usedBytes = 'volumeId' in input.target ? volume.usedBytes : undefined;
            if (disposed) throw Object.assign(new Error('Scan runner closed'), { code: 'closed' });
            if (input.resume && deps.index.root(volume.id) !== root) throw Object.assign(new Error('Resume target changed'), { code: 'invalid_resume_target' });
            if (!await deps.readEnabled()) throw Object.assign(new Error('Whole-disk scan disabled'), { code: 'disabled' });
            await options.beforeEffect?.();
            const state = await deps.index.begin({ ...input, relistOnly: options.relistOnly, volumeId: volume.id, root, usedBytes,
                reservedBytes: volume.reservedBytes, apfsContainerId: volume.apfsContainerId, fullDiskAccess: deps.fullDiskAccess() }, { throwIfCancelled: () => {
                    if (disposed) throw Object.assign(new Error('Scan cancelled'), { name: 'AbortError' });
                } });
            const run: { native?: NativeDiskScan; done: Promise<void>; volumeId: string; cancelled: boolean; skipped: Set<string> } =
                { done: Promise.resolve(), volumeId: volume.id, cancelled: false, skipped: new Set(input.resume ? deps.index.skippedPaths(volume.id) : []) };
            const lowPower = await deps.readLowPower?.();
            const scanHints = await deps.readScanHints?.(root);
            const throwIfCancelled = () => {
                if (run.cancelled || disposed) throw Object.assign(new Error('Scan cancelled'), { name: 'AbortError' });
            };
            run.done = (async () => {
                let resume = Boolean(input.resume);
                try {
                try {
                    do {
                        const prior = await deps.index.writePriorProjection(volume.id, { resume, relistOnly: options.relistOnly, throwIfCancelled });
                        try {
                        if (!await deps.readEnabled()) throw Object.assign(new Error('Whole-disk scan disabled'), { code: 'disabled' });
                        await options.beforeEffect?.();
                        throwIfCancelled();
                        run.native = startNativeDiskScan({ ...scanHints, root, relistOnly: options.relistOnly, drawableNodes: STORAGE_CHART_MAX_DRAWABLE_NODES, keepMinBytes: 0, lowPower, usedBytes,
                            ...(prior ? { previousIndexPath: prior.path } : {}), ...(resume ? { resumeFrom: [], skippedPaths: [...run.skipped] } : {}) },
                            { onRecord: record => { deps.index.ingest(volume.id, record); deps.onChange?.(); },
                                onRecordBatch: consume => deps.index.withIngestBatch(volume.id, consume) });
                        const summary = await run.native.done;
                        deps.index.finish(volume.id, summary);
                        if (summary.termination !== 'interrupted' || run.cancelled || !run.skipped.size || !deps.index.hasRunnableFrontier(volume.id)) break;
                        resume = true;
                        } finally { await prior?.dispose(); }
                    } while (!run.cancelled);
                } catch (error) {
                    if (error instanceof Error && error.name === 'AbortError') deps.index.finish(volume.id, 'cancelled');
                    else if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'scheduled_scan_blocked') {
                        deps.index.finish(volume.id, 'interrupted'); throw error;
                    }
                    else { deps.index.finish(volume.id, 'failed'); throw error; }
                }
                const final = deps.index.state(state.scanId); if (final?.status === 'complete') await deps.onCompleted?.(final);
                } finally { runs.delete(state.scanId); deps.onChange?.(); }
            })();
            void run.done.catch(() => {}); runs.set(state.scanId, run); deps.onChange?.(); return state;
            } finally { admitting = false; }
        }); },
        async get(input: Readonly<{ scanId?: string; view?: DiskScanViewV1 }> = {}, options: Readonly<{ beforeEffect?: () => Promise<void> }> = {}): Promise<MachineStorageScanGetResultV1> {
            const view = input.view; const nodeId = view?.nodeId;
            if (view?.tab === 'folders' && nodeId && !runs.size && !admitting) {
                const node = deps.index.readNode(nodeId, input.scanId);
                if (node && (node.node.kind === 'folder' || node.node.kind === 'package') && !node.materialized && deps.index.root(node.volumeId) !== nodeId) {
                    try { await api.start({ target: { folderPath: node.path } }, { ...options, relistOnly: !node.summarized }); }
                    catch (error) {
                        // Another reader may admit the same drill while this
                        // request waits for admission. Its indexed read stays passive.
                        if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'scan_running') throw error;
                    }
                    return deps.index.readView({ view });
                }
            }
            return deps.index.readView(input);
        },
        async scheduleVolumes(volumeIds: readonly string[]): Promise<void> {
            if (disposed || !await deps.readEnabled()) return;
            for (const id of volumeIds) pendingVolumes.add(id);
            api.resumeScheduled();
        },
        resumeScheduled(): void {
            if (disposed || !pendingVolumes.size) return;
            if (scheduled) { resumeRequested = true; return; }
            scheduled = (async () => {
                while (!disposed && pendingVolumes.size) {
                    await Promise.allSettled([...runs.values()].map(run => run.done));
                    const id = pendingVolumes.values().next().value; if (!id) break;
                    if (!await deps.readEnabled()) break;
                    try {
                        const previous = deps.index.states().find(state => deps.index.volumeId(state.scanId) === id);
                        const resume = previous?.status === 'interrupted' && 'volumeId' in previous.target;
                        const state = await api.start({ target: { volumeId: id }, resume }, { beforeEffect: async () => {
                            if (disposed || !pendingVolumes.has(id)) throw Object.assign(new Error('Scheduled work retired'), { code: 'scheduled_scan_blocked' });
                            await deps.beforeScheduledEffect?.();
                            if (disposed || !pendingVolumes.has(id)) throw Object.assign(new Error('Scheduled work retired'), { code: 'scheduled_scan_blocked' });
                        } });
                        await api.wait(state.scanId); pendingVolumes.delete(id);
                    } catch (error) {
                        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'scheduled_scan_blocked') break;
                        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'volume_unavailable') { pendingVolumes.delete(id); continue; }
                        pendingVolumes.delete(id); throw error;
                    }
                }
            })().finally(() => { scheduled = undefined; const resume = resumeRequested; resumeRequested = false; if (resume) api.resumeScheduled(); });
            void scheduled.catch(error => { deps.onScheduledError?.(error); });
        },
        clearScheduled(): void { pendingVolumes.clear(); resumeRequested = false; },
        async waitScheduled(): Promise<void> { while (scheduled) await scheduled; },
        async cancel(scanId: string) {
            const run = runs.get(scanId);
            logger.infoFile('[storage-scan] cancel-entry', { scanId, pid: run?.native?.pid, atMs: Date.now() });
            if (run) { run.cancelled = true; run.native?.cancel(); }
            await run?.done;
            return deps.index.state(scanId);
        },
        skip(scanId: string, path: string) { const run = runs.get(scanId); const state = deps.index.state(scanId);
            if (run) {
                if (state?.progress.currentPath !== path && !deps.index.hasFrontierPath(run.volumeId, path)) throw Object.assign(new Error('Skip path not active'), { code: 'invalid_skip_path' });
                deps.index.recordSkip(run.volumeId, path); run.skipped.add(path); run.native?.skip(path);
            } return state;
        },
        async wait(scanId: string) { await runs.get(scanId)?.done; return deps.index.state(scanId); },
        activeNativePid(scanId: string): number | undefined { return runs.get(scanId)?.native?.pid; },
        async dispose() {
            disposed = true; pendingVolumes.clear();
            await admit(async () => { for (const run of runs.values()) { run.cancelled = true; run.native?.cancel(); } await Promise.allSettled([...runs.values()].map(run => run.done)); });
            await scheduled?.catch(() => {}); deps.index.close();
        },
    };
    return api;
}
export type StorageScanRunner = ReturnType<typeof createStorageScanRunner>;
