import type { AgentExternalSessionAccountingObservation, AgentExternalSessionsReadAccountingResult, AgentExternalSessionsResult } from '@happier-dev/plugin-sdk/sessions/external';
import type { UsageSourceDateRangeV1, UsageSourceV1 } from '@happier-dev/protocol/usage/usageSources';
import type { DeviceLocalSecretStorage } from '@/daemon/deviceLocalSecretStorage';
import type { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';
import type { createUsageObservationPublisher } from '../createUsageObservationPublisher';
import type { NativeUsageCaptureAuthority, NativeUsageCaptureSource, NativeUsageCaptureStore } from './nativeUsageCaptureState';
import { AsyncLock } from '@/utils/lock';
import { deriveNativeUsageAccountingIdentity } from './nativeUsageAccountingIdentity';

export type NativeUsageSourceDescriptor = Pick<NativeUsageCaptureSource, 'agent' | 'source' | 'sourceKey' | 'root' | 'supported' | 'rootKind' | 'error'>;

/** Discovery metadata is not part of the strict persisted accounting shape. */
function projectCaptureSourceDescriptor(descriptor: NativeUsageSourceDescriptor): NativeUsageSourceDescriptor {
    const { agent, source, sourceKey, root, supported, rootKind, error } = descriptor;
    return { agent, source, sourceKey, root, supported,
        ...(rootKind === undefined ? {} : { rootKind }), ...(error === undefined ? {} : { error }) };
}
export type NativeUsageCollectorDependencies = Readonly<{
    store: NativeUsageCaptureStore;
    authority: NativeUsageCaptureAuthority;
    storage: DeviceLocalSecretStorage;
    discoverSources(): Promise<readonly NativeUsageSourceDescriptor[]>;
    resolveRoot(source: NativeUsageCaptureSource, root: string | null): Promise<NativeUsageSourceDescriptor>;
    resolveProject?(project: NonNullable<AgentExternalSessionAccountingObservation['project']>, signal: AbortSignal): Promise<{
        projectKey: string; workspaceId?: string;
    }>;
    readAccounting(source: NativeUsageCaptureSource, signal: AbortSignal, changedNativeSessionIds?: readonly string[]): Promise<AgentExternalSessionsResult<AgentExternalSessionsReadAccountingResult>>;
    subscribeSource(source: NativeUsageCaptureSource, onChange: (changedNativeSessionIds?: readonly string[]) => void, signal: AbortSignal): Promise<{ dispose(): void | Promise<void> }>;
    publisher: Pick<ReturnType<typeof createUsageObservationPublisher>, 'publish'>;
    deleteHistory(source: NativeUsageCaptureSource, dateRange?: UsageSourceDateRangeV1): Promise<{ success: true; deletedEventCount: number }>;
    budgetRegistry: ExecutionBudgetRegistry;
    /** Content-free reader wake after this source's finite capture/publication settles. */
    onSourceSettled?(): void;
}>;

export function createNativeUsageCollector(input: NativeUsageCollectorDependencies) {
    let sources: NativeUsageCaptureSource[] = [];
    const stateLock = new AsyncLock();
    const effects = new AsyncLock();
    type Lifetime = {
        sourceId: string; controller: AbortController; dirty: boolean; publish: boolean;
        changedNativeSessionIds?: Set<string>;
        subscription?: { dispose(): void | Promise<void> }; setup?: Promise<void>; task?: Promise<void>;
    };
    const active = new Map<string, Lifetime>();
    let disposed = false;
    let initialization: Promise<void> | undefined;
    const requireSource = (id: string) => {
        const source = sources.find(candidate => candidate.sourceId === id);
        if (!source) throw new Error('usage_source_not_found');
        return source;
    };
    const isActive = (life: Lifetime) => !disposed && !life.controller.signal.aborted && active.get(life.sourceId) === life
        && requireSource(life.sourceId).consented;
    const identity = (source: NativeUsageSourceDescriptor, observation?: AgentExternalSessionAccountingObservation) => deriveNativeUsageAccountingIdentity({
        authority: input.authority, storage: input.storage, agent: source.agent, sourceKey: source.sourceKey,
        ...(observation ? { nativeSessionId: observation.nativeSessionId, inferenceId: observation.inferenceId ?? observation.observation.key ?? undefined } : {}),
    });
    const checkSignal = (signal?: AbortSignal) => {
        if (disposed || signal?.aborted) throw new Error('usage_source_cancelled');
    };
    async function commit(mutate: (next: NativeUsageCaptureSource[]) => void) {
        await stateLock.inLock(async () => {
            const next = structuredClone(sources);
            mutate(next);
            // Never move the in-memory frontier ahead of durable pending custody.
            await input.store.save({ v: 1, authority: input.authority, sources: next });
            sources = next;
        });
    }
    async function error(life: Lifetime, code: string) {
        if (!isActive(life)) return;
        await commit(next => {
            if (isActive(life)) next.find(source => source.sourceId === life.sourceId)!.error = code;
        });
    }
    async function publish(life: Lifetime) {
        let source = requireSource(life.sourceId);
        const acknowledged = new Set<string>();
        let failure: string | undefined;
        // One Account admission per distinct local witness in this finite job,
        // never one request per inference or an independent Project cache.
        const projects = new Map<string, Promise<{ projectKey: string; workspaceId?: string } | null>>();
        for (const row of source.pending) {
            const witness = row.project;
            if (!witness) continue;
            const key = JSON.stringify(witness);
            if (!projects.has(key)) projects.set(key, (async () => {
                try { return await input.resolveProject?.(witness, life.controller.signal) ?? null; }
                catch { return null; }
            })());
        }
        if (projects.size) {
            const accepted = new Map(await Promise.all([...projects].map(async ([key, result]) => [key, await result] as const)));
            if (!isActive(life)) return;
            if ([...accepted.values()].some(value => value !== null)) await commit(next => {
                if (!isActive(life)) return;
                const current = next.find(candidate => candidate.sourceId === life.sourceId)!;
                for (const row of current.pending) {
                    if (!row.project) continue;
                    const project = accepted.get(JSON.stringify(row.project));
                    if (!project) continue;
                    Object.assign(row, project);
                    delete row.project;
                }
            });
            source = requireSource(life.sourceId);
        }
        for (const observation of source.pending) {
            if (!isActive(life)) break;
            if (observation.project) {
                failure = 'native_project_identity_unavailable';
                continue;
            }
            const keys = identity(source, observation);
            if (!keys.nativeSessionKey || !keys.externalKey) { failure = 'native_inference_identity_unavailable'; break; }
            const result = await input.publisher.publish({
                subject: { kind: 'native', machineId: input.authority.machineId, agent: source.agent,
                    sourceRootKey: source.sourceId, nativeSessionKey: keys.nativeSessionKey },
                observation: observation.observation, observedAt: observation.observedAt, externalKey: keys.externalKey,
                projectKey: observation.projectKey, workspaceId: observation.workspaceId,
                accounting: { ...observation.accounting, status: source.coverage?.complete ? 'available' : 'partial',
                    ...(source.coverage ? { historyComplete: source.coverage.complete } : {}),
                    ...(source.asOf !== undefined ? { asOfMs: source.asOf } : {}),
                    ...(observation.inferenceId ? { inferenceKey: keys.externalKey } : {}) },
                signal: life.controller.signal,
            });
            if (result.status === 'sent' && result.transport === 'v2') acknowledged.add(keys.externalKey);
            else { failure = result.status === 'unsupported' ? 'native_ingest_unsupported' : 'native_ingest_unavailable'; break; }
        }
        // A retired scope keeps pending even if its old in-flight request was acknowledged.
        // Replay is safe at the existing ingest idempotency owner.
        if (!isActive(life) || (!acknowledged.size && !failure)) return;
        await commit(next => {
            if (!isActive(life)) return;
            const current = next.find(candidate => candidate.sourceId === life.sourceId)!;
            current.pending = current.pending.filter(row => !acknowledged.has(identity(current, row).externalKey ?? ''));
            // Publication cannot hide a failed source read: that uncertainty
            // must survive until the next coarse accounting reconciliation.
            if (failure && (!current.error || current.error.startsWith('native_ingest_') || current.error === 'native_project_identity_unavailable')) current.error = failure;
            else if (current.error?.startsWith('native_ingest_') || current.error === 'native_project_identity_unavailable') delete current.error;
        });
    }
    async function capture(life: Lifetime, changedNativeSessionIds?: readonly string[]) {
        let replayReplacement = true;
        while (isActive(life)) {
            const source = requireSource(life.sourceId);
            // Failed source reads leave the retained cursor uncertain; the next
            // admitted invalidation reconciles it rather than skipping evidence.
            const changes = source.error && !source.error.startsWith('native_ingest_') && source.error !== 'native_project_identity_unavailable'
                ? undefined : changedNativeSessionIds;
            const result = await input.readAccounting(source, life.controller.signal, changes);
            if (!isActive(life)) return;
            if (!result.ok) { await error(life, result.code === 'unavailable' ? 'source_unavailable' : result.code); return; }
            const value = result.value;
            if (value.outcome === 'unchanged') {
                if (source.error && !source.error.startsWith('native_ingest_')) await commit(next => {
                    if (isActive(life)) delete next.find(candidate => candidate.sourceId === life.sourceId)!.error;
                });
                return;
            }
            if (value.outcome === 'source_replaced' || value.outcome === 'gap_or_cursor_expired') {
                await commit(next => {
                    if (!isActive(life)) return;
                    const current = next.find(candidate => candidate.sourceId === life.sourceId)!;
                    delete current.cursor;
                    current.coverage = { complete: false, reason: value.outcome };
                });
                if (replayReplacement) { replayReplacement = false; continue; }
                await error(life, value.outcome); return;
            }
            if (value.outcome !== 'advanced') { await error(life, value.outcome); return; }
            if (value.coverage.reason === 'reading' && value.nextCursor === source.cursor) { await error(life, 'accounting_cursor_not_advanced'); return; }
            await commit(next => {
                if (!isActive(life)) return;
                const current = next.find(candidate => candidate.sourceId === life.sourceId)!;
                const retained = new Map(current.pending.map((row, index) => [identity(current, row).externalKey, index]));
                for (const row of value.observations) {
                    current.asOf = Math.max(current.asOf ?? row.observedAt, row.observedAt);
                    const key = identity(current, row).externalKey;
                    const index = key ? retained.get(key) : undefined;
                    if (index !== undefined) current.pending[index] = row;
                    else { current.pending.push(row); if (key) retained.set(key, current.pending.length - 1); }
                }
                current.cursor = value.nextCursor;
                if (current.coverage?.reason !== 'source_replaced' && current.coverage?.reason !== 'gap_or_cursor_expired') current.coverage = value.coverage;
                delete current.error;
            });
            if (value.coverage.reason !== 'reading') return;
        }
    }
    function queue(life: Lifetime, read: boolean, changedNativeSessionIds?: readonly string[]) {
        if (!isActive(life)) return Promise.resolve();
        if (read) {
            // Coalesce invalidations in the existing finite job. Any uncertain
            // change dominates correlated evidence and requests a coarse read.
            if (!life.dirty) life.changedNativeSessionIds = changedNativeSessionIds === undefined ? undefined : new Set(changedNativeSessionIds);
            else if (changedNativeSessionIds === undefined) life.changedNativeSessionIds = undefined;
            else if (life.changedNativeSessionIds) for (const id of changedNativeSessionIds) life.changedNativeSessionIds.add(id);
        }
        life.dirty ||= read;
        life.publish = true;
        if (life.task) return life.task;
        const task = Promise.resolve().then(async () => {
            while (isActive(life) && (life.dirty || life.publish)) {
                const readNow = life.dirty;
                const changes = life.changedNativeSessionIds ? [...life.changedNativeSessionIds] : undefined;
                life.dirty = false; life.publish = false;
                life.changedNativeSessionIds = undefined;
                if (readNow) await capture(life, changes);
                if (isActive(life)) await publish(life);
            }
        }).catch(async () => { if (isActive(life)) await error(life, 'accounting_read_failed'); });
        life.task = task;
        const release = input.budgetRegistry.retainFiniteTask(task);
        void task.finally(() => {
            if (life.task === task) life.task = undefined;
            release();
            // Ingest can wake readers before pending custody commits or reading ends,
            // and a harvest without observations has no ingest wake at all.
            if (isActive(life)) input.onSourceSettled?.();
        }).catch(() => {});
        return task;
    }
    async function activate(sourceId: string) {
        const source = requireSource(sourceId);
        if (disposed || !source.consented || (!source.supported && !source.pending.length) || active.has(sourceId)) return;
        const life: Lifetime = { sourceId, controller: new AbortController(), dirty: false, publish: false };
        active.set(sourceId, life);
        if (!source.supported) {
            // Captured numeric facts do not depend on a still-installed reader.
            void queue(life, false);
            return;
        }
        life.setup = (async () => {
            try {
                const subscription = await input.subscribeSource(source, changes => { void queue(life, true, changes).catch(() => {}); }, life.controller.signal);
                if (!isActive(life)) await subscription.dispose();
                else life.subscription = subscription;
            } catch {
                // Pending custody must still replay when its original vendor input is gone.
                if (isActive(life)) await error(life, 'source_unavailable');
            }
        })();
        await life.setup;
        // Consent admits demand; it must not hold the effect lock for a harvest.
        // The incumbent finite task remains reachable by Stop and flushPending.
        void queue(life, true);
    }
    async function retire(sourceId: string) {
        const life = active.get(sourceId);
        if (!life) return;
        active.delete(sourceId); life.controller.abort();
        await life.setup?.catch(() => {});
        await life.subscription?.dispose();
        await life.task?.catch(() => {});
    }
    function view(source: NativeUsageCaptureSource): UsageSourceV1 {
        const reading = !!active.get(source.sourceId)?.task;
        const unavailable = source.error === 'source_unavailable' || source.error === 'agent_unavailable';
        return {
            serverId: input.authority.serverId, machineId: input.authority.machineId, sourceId: source.sourceId,
            agent: source.agent, externalSessionSource: source.source,
            root: { kind: source.rootKind ?? 'default', path: source.root },
            consent: source.consented ? 'enabled' : 'disabled',
            status: unavailable ? 'unavailable' : !source.supported || source.error === 'native_ingest_unsupported' ? 'unsupported'
                : source.error ? 'error' : reading ? 'reading' : source.consented ? 'ready' : source.cursor ? 'stopped' : 'found',
            coverage: !source.supported ? 'unsupported' : !source.coverage ? 'unknown' : source.coverage.complete ? 'complete' : 'partial',
            pendingCount: source.pending.length, asOfMs: source.asOf ?? null,
            ...(source.error ? { errorCode: source.error } : {}),
        };
    }
    async function initialize() {
        initialization ??= (async () => {
            sources = (await input.store.load()).sources;
            await Promise.all(sources.filter(source => source.consented).map(source => activate(source.sourceId)));
        })();
        await initialization;
    }
    async function setConsent(sourceId: string, enabled: boolean, signal?: AbortSignal) {
        await initialize();
        return effects.inLock(async () => {
            checkSignal(signal); requireSource(sourceId);
            await retire(sourceId);
            checkSignal(signal);
            await commit(next => { next.find(source => source.sourceId === sourceId)!.consented = enabled; });
            if (enabled) await activate(sourceId);
            return view(requireSource(sourceId));
        });
    }
    return {
        initialize,
        async discover(signal?: AbortSignal) {
            await initialize();
            return effects.inLock(async () => {
                checkSignal(signal);
                const descriptors = await input.discoverSources();
                checkSignal(signal);
                const consented = sources.filter(source => source.consented).map(source => source.sourceId);
                await Promise.all(consented.map(retire));
                await commit(next => {
                    for (const discovered of descriptors) {
                        const descriptor = projectCaptureSourceDescriptor(discovered);
                        const sourceId = identity(descriptor).sourceRootKey;
                        const current = next.find(source => source.sourceId === sourceId);
                        if (current) {
                            const rootKind = current.rootKind;
                            Object.assign(current, descriptor);
                            if (!descriptor.error && (current.error === 'source_unavailable' || current.error === 'agent_unavailable')) delete current.error;
                            if (rootKind === 'override') current.rootKind = rootKind;
                        } else next.push({ ...descriptor, sourceId, consented: false, pending: [] });
                    }
                });
                // Inventory disappearance is not permission to drop custody or an override.
                await Promise.all(consented.map(activate));
                return sources.map(view);
            });
        },
        async get(sourceId?: string, signal?: AbortSignal) {
            await initialize(); checkSignal(signal);
            if (sourceId) return [view(requireSource(sourceId))];
            return sources.map(view);
        },
        setConsent,
        stop: (sourceId: string, signal?: AbortSignal) => setConsent(sourceId, false, signal),
        async setRoot(sourceId: string, root: string | null, signal?: AbortSignal) {
            await initialize();
            return effects.inLock(async () => {
                checkSignal(signal);
                const old = requireSource(sourceId);
                const descriptor = projectCaptureSourceDescriptor(await input.resolveRoot(old, root));
                checkSignal(signal);
                await retire(sourceId);
                await commit(next => { next.find(source => source.sourceId === sourceId)!.consented = false; });
                const replacementId = identity(descriptor).sourceRootKey;
                await commit(next => {
                    const current = next.find(source => source.sourceId === replacementId);
                    if (current) Object.assign(current, descriptor, { consented: false });
                    else next.push({ ...descriptor, sourceId: replacementId, consented: false, pending: [] });
                });
                return view(requireSource(replacementId));
            });
        },
        async deleteHistory(sourceId: string, range?: UsageSourceDateRangeV1, signal?: AbortSignal) {
            await initialize();
            return effects.inLock(async () => {
                checkSignal(signal);
                requireSource(sourceId);
                await retire(sourceId);
                checkSignal(signal);
                // Explicit deletion retires selected local pending BEFORE the outward delete.
                // A crash after server success must not resurrect it through pending replay.
                await commit(next => {
                    const current = next.find(candidate => candidate.sourceId === sourceId)!;
                    current.consented = false;
                    current.pending = current.pending.filter(row => (range?.startMs !== undefined && row.observedAt < range.startMs)
                        || (range?.endMs !== undefined && row.observedAt > range.endMs));
                });
                return await input.deleteHistory(requireSource(sourceId), range);
            });
        },
        async flushPending() {
            await initialize();
            await Promise.all([...active.values()].map(life => queue(life, false)));
        },
        async dispose() {
            disposed = true;
            await initialization?.catch(() => {});
            await Promise.all([...active.keys()].map(retire));
        },
    };
}
