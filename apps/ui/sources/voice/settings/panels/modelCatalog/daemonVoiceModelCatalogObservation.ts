import { readActionFailureCauseV1, type ActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { listModelPackCatalogEntries, resolveCanonicalModelPackId } from '@happier-dev/protocol/voice/modelPacks/catalog';
import type { DaemonVoiceInferenceModelStatus } from '@happier-dev/protocol/daemon/voiceInference';
import {
    captureActiveServerAccountScopeCurrentness,
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';
import { getMachineContributionRegistryProjectionRevision } from '@/sync/ops/machineContributionRegistryProjectionRevision';
import type { DaemonVoiceInferenceClient } from '@/voice/runtime/daemonInference/DaemonVoiceInferenceClient';
import { readDaemonVoiceInferenceClientErrorCode, type DaemonVoiceInferenceClientErrorCode } from '@/voice/runtime/daemonInference/daemonVoiceInferenceErrors';
import { createAbortRacer } from '@/voice/agent/voiceAgentAbort';
import { retainKeyedRows } from '@/sync/domains/state/structuralSharing';

export type DaemonVoiceModelCatalogErrorCode = Extract<DaemonVoiceInferenceClientErrorCode,
    'feature_disabled' | 'machine_unreachable' | 'runtime_unavailable' | 'unsupported_runtime_family'
    | 'request_timeout' | 'internal_error'> | null;

export type DaemonVoiceModelCatalogObservationState = Readonly<{
    statuses: readonly DaemonVoiceInferenceModelStatus[];
    errorCode: DaemonVoiceModelCatalogErrorCode;
    message?: string;
    failureCause?: ActionFailureCauseV1;
    loading: boolean;
    /** The full discovery catalog still needs a read; partial rows may be current. */
    stale: boolean;
}>;

const EMPTY_OBSERVATION: DaemonVoiceModelCatalogObservationState = {
    statuses: [], errorCode: null, loading: false, stale: true,
};
type CatalogClient = Pick<DaemonVoiceInferenceClient, 'listModels' | 'getModelsStatus'>;
type InstallProgressDemand = Readonly<{ client: CatalogClient; intervalMs: number }>;
const CANONICAL_MODEL_PACK_IDS = listModelPackCatalogEntries().map(entry => entry.packId);

export function readDaemonVoiceModelCatalogErrorCode(error: unknown): Exclude<DaemonVoiceModelCatalogErrorCode, null> {
    const code = readDaemonVoiceInferenceClientErrorCode(error);
    switch (code) {
        case 'feature_disabled': case 'machine_unreachable': case 'runtime_unavailable':
        case 'unsupported_runtime_family': case 'request_timeout': case 'internal_error': return code;
        default: return 'internal_error';
    }
}

/** Keep the daemon client's existing message and content-free diagnostic together. */
export function readDaemonVoiceModelCatalogFailure(error: unknown) {
    const failureCause = error && typeof error === 'object' && 'failureCause' in error ? readActionFailureCauseV1(error.failureCause) : undefined;
    return { errorCode: readDaemonVoiceModelCatalogErrorCode(error),
        message: error instanceof Error ? error.message : undefined, failureCause };
}

/** One actual model observation and in-flight read, independent of its UI or Action consumer. */
export function createDaemonVoiceModelCatalogObservation(target: Readonly<{
    account?: ActiveServerAccountScopeLifetime | null;
    machineId?: string | null;
    revision?: number;
}> = {}) {
    let snapshot = EMPTY_OBSERVATION;
    let requestSequence = 0;
    type Reading = Readonly<{ query: string; promise: Promise<readonly DaemonVoiceInferenceModelStatus[] | null>;
        controller: AbortController; readers: Set<symbol> }>;
    let pending: Reading | null = null;
    const listeners = new Set<() => void>();
    const progressDemands = new Set<InstallProgressDemand>();
    const activeInstalls = new Set<Readonly<{ packId: string }>>();
    let progressTimer: ReturnType<typeof setTimeout> | null = null;
    const visibility = typeof document !== 'undefined' ? document : undefined;

    const installingPackIds = () => [...new Set([
        ...[...activeInstalls].map(install => install.packId),
        ...snapshot.statuses.filter(status => status.installState === 'installing').map(status => status.packId),
    ])];
    function clearProgressTimer() {
        if (progressTimer !== null) clearTimeout(progressTimer);
        progressTimer = null;
    }
    function scheduleInstallProgress() {
        const demand = progressDemands.values().next().value;
        if (!demand || visibility?.visibilityState === 'hidden' || pending || installingPackIds().length === 0) {
            clearProgressTimer();
            return;
        }
        if (progressTimer !== null) return;
        progressTimer = setTimeout(() => {
            progressTimer = null;
            // An explicit discovery or Action read can have started since scheduling.
            // Its settlement will schedule the next progress read.
            if (pending || visibility?.visibilityState === 'hidden') return;
            const packIds = installingPackIds();
            if (packIds.length === 0) return;
            void read({ client: demand.client, packIds }).catch(() => {
                // The shared observation retains the typed read failure.
            });
        }, demand.intervalMs);
    }
    const publish = (next: DaemonVoiceModelCatalogObservationState) => {
        if (snapshot.statuses !== next.statuses) {
            next = { ...next, statuses: retainKeyedRows(snapshot.statuses, next.statuses, status => resolveCanonicalModelPackId(status.packId)) };
        }
        if (snapshot.statuses === next.statuses && snapshot.errorCode === next.errorCode
            && snapshot.message === next.message && JSON.stringify(snapshot.failureCause) === JSON.stringify(next.failureCause)
            && snapshot.loading === next.loading && snapshot.stale === next.stale) return;
        snapshot = next;
        scheduleInstallProgress();
        for (const listener of listeners) listener();
    };
    const targetIsCurrent = () => (target.account ?? captureActiveServerAccountScopeCurrentness()).isCurrent()
        && (!target.account || !target.machineId || target.revision === undefined
            || getMachineContributionRegistryProjectionRevision({
                machineId: target.machineId, serverId: target.account.scope.serverId,
            }) === target.revision);
    const join = async (reading: Reading, signal?: AbortSignal) => {
        const reader = Symbol();
        reading.readers.add(reader);
        try {
            return await createAbortRacer(signal).race(reading.promise);
        } finally {
            reading.readers.delete(reader);
            if (reading.readers.size === 0 && pending === reading) {
                pending = null;
                requestSequence += 1;
                reading.controller.abort();
                publish({ ...snapshot, loading: false, stale: snapshot.stale || reading.query === 'null' });
            }
        }
    };
    const read = async (input: Readonly<{
        client: CatalogClient;
        packIds?: readonly string[];
        requireNewObservation?: boolean;
        isCurrent?: () => boolean;
        signal?: AbortSignal;
    }>): Promise<readonly DaemonVoiceInferenceModelStatus[] | null> => {
        const query = JSON.stringify(input.packIds ?? null);
        input.signal?.throwIfAborted();
        if (!input.requireNewObservation && pending?.query === query) return join(pending, input.signal);
        const account = target.account ?? captureActiveServerAccountScopeCurrentness();
        const current = () => account.isCurrent() && targetIsCurrent();
        if (!current() || input.isCurrent?.() === false) return null;
        const sequence = ++requestSequence;
        pending?.controller.abort();
        const controller = new AbortController();
        const retirement = account.onRetire(() => controller.abort());
        publish({ ...snapshot, loading: snapshot.statuses.length === 0 });
        const scope = target.machineId ? { machineId: target.machineId } : undefined;
        const request = Promise.resolve().then(async () => {
            const statuses = input.packIds
                ? await input.client.getModelsStatus(input.packIds, scope, controller.signal)
                : await Promise.all([
                    input.client.listModels(scope, controller.signal), input.client.getModelsStatus(CANONICAL_MODEL_PACK_IDS, scope, controller.signal),
                ]).then(([discovered, canonical]) => [...new Map([...discovered, ...canonical].map(status => [status.packId, status])).values()]);
            if (sequence !== requestSequence || !current()) return null;
            // A partial check replaces only queried packs. It cannot certify
            // missing packs or resurrect rows withdrawn by an invalidation.
            const queried = new Set(input.packIds?.map(resolveCanonicalModelPackId));
            const retained = input.packIds
                ? snapshot.statuses.filter(status => !queried.has(resolveCanonicalModelPackId(status.packId))) : [];
            const observed = input.packIds ? [...new Map([...retained, ...statuses].map(status => [status.packId, status])).values()] : statuses;
            publish({ statuses: observed, errorCode: null, loading: false, stale: input.packIds ? snapshot.stale : false });
            return statuses;
        }).catch((error: unknown) => {
            if (sequence === requestSequence && current() && !controller.signal.aborted) {
                publish({ ...snapshot, ...readDaemonVoiceModelCatalogFailure(error), loading: false, stale: snapshot.stale || !input.packIds });
            }
            if (controller.signal.aborted) return null;
            throw error;
        }).finally(() => {
            retirement.dispose();
            if (pending?.promise === request) {
                pending = null;
                scheduleInstallProgress();
            }
        });
        pending = { query, promise: request, controller, readers: new Set() };
        return await join(pending, input.signal);
    };
    return {
        getSnapshot: () => snapshot,
        watchInstallProgress: (input: InstallProgressDemand) => {
            const demand = { ...input };
            if (progressDemands.size === 0) {
                visibility?.addEventListener('visibilitychange', scheduleInstallProgress);
            }
            progressDemands.add(demand);
            scheduleInstallProgress();
            return () => {
                progressDemands.delete(demand);
                if (progressDemands.size === 0) {
                    visibility?.removeEventListener('visibilitychange', scheduleInstallProgress);
                }
                clearProgressTimer();
                scheduleInstallProgress();
            };
        },
        trackInstall: async <T>(packId: string, run: () => Promise<T>): Promise<T> => {
            const install = { packId: resolveCanonicalModelPackId(packId) };
            activeInstalls.add(install);
            scheduleInstallProgress();
            try {
                return await run();
            } finally {
                activeInstalls.delete(install);
                scheduleInstallProgress();
            }
        },
        /** A successful warm response is a fresh observation, not a reason to probe again. */
        observeModels: (models: readonly DaemonVoiceInferenceModelStatus[]) => {
            if (!targetIsCurrent() || models.length === 0) return;
            // An older catalog read cannot replace a model warmed after it began.
            requestSequence += 1;
            pending?.controller.abort();
            pending = null;
            const statuses = [...new Map([...snapshot.statuses, ...models]
                .map(status => [resolveCanonicalModelPackId(status.packId), status])).values()];
            publish({ statuses, errorCode: null, loading: false, stale: snapshot.stale });
        },
        subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        publish,
        read,
        invalidate: () => {
            requestSequence += 1;
            pending?.controller.abort();
            pending = null;
            publish(EMPTY_OBSERVATION);
        },
    };
}

const observations = new WeakMap<ActiveServerAccountScopeLifetime, Map<string, Readonly<{
    revision: number;
    observation: ReturnType<typeof createDaemonVoiceModelCatalogObservation>;
}>>>();

export function getDaemonVoiceModelCatalogObservation(account: ActiveServerAccountScopeLifetime, machineId: string,
    revision = getMachineContributionRegistryProjectionRevision({ machineId, serverId: account.scope.serverId })) {
    let machines = observations.get(account);
    if (!machines) { machines = new Map(); observations.set(account, machines); }
    const previous = machines.get(machineId);
    if (previous?.revision === revision) return previous.observation;
    const observation = createDaemonVoiceModelCatalogObservation({ account, machineId, revision });
    machines.set(machineId, { revision, observation });
    return observation;
}

export function captureDaemonVoiceModelCatalogObservation(machineId: string | null) {
    const account = captureActiveServerAccountScopeLifetime();
    const observation = account && machineId ? getDaemonVoiceModelCatalogObservation(account, machineId)
        : createDaemonVoiceModelCatalogObservation({ account, machineId });
    return {
        ...observation,
        invalidate: () => {
            observation.invalidate();
            // Mutations change this Machine's files even if its daemon revision
            // changed during consent. Never recapture a different Account here.
            if (account?.isCurrent() && machineId) {
                const current = getDaemonVoiceModelCatalogObservation(account, machineId);
                if (current !== observation) current.invalidate();
            }
        },
    };
}
