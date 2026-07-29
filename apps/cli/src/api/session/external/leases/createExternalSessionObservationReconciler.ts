import type {
    ExternalAgentObservationLeafFactV1,
    ExternalAgentObservationLinkEvidenceBatchV1,
    ExternalAgentObservationLinkKeyV1,
    ExternalAgentObservationReconcileResultV1,
    ExternalAgentObservationResourceDescriptorV1,
    ExternalAgentObservationResourceKeyV1,
    ExternalAgentObservationWatchFileChangesV1,
} from '@happier-dev/protocol';
import type {
    AgentExternalSessionObservationObserveResourceRequest,
    AgentExternalSessionsResolvedIdentity,
} from '@happier-dev/plugin-sdk/experimental/sessions';
import type { Disposable } from '@happier-dev/plugin-sdk';
import {
    startDirectoryTopologyWatchers,
    type DirectoryTopologyWatchTarget,
} from '@/integrations/watcher/startDirectoryTopologyWatcher';
import { startFileWatcher } from '@/integrations/watcher/startFileWatcher';
import { computeExponentialBackoffMs } from '@/subprocess/supervision/backoff';

export type ExternalSessionObservationResourceIdentity = Readonly<{
    pluginId: string;
    agentLocalId: string;
    pluginGeneration: string;
    resourceKey: ExternalAgentObservationResourceKeyV1;
    retirementSignal?: AbortSignal;
}>;

export type ExternalSessionObservationDemand = Readonly<{
    passiveEvent: boolean;
    persistedPolicy: boolean;
    fallbackDemand: boolean;
    transcriptDemand?: boolean;
}>;

export type ExternalSessionObservationLinkIdentity = Readonly<{
    sessionId: string;
    linkGeneration: string;
    linkKey: ExternalAgentObservationLinkKeyV1;
    linkedSource: AgentExternalSessionsResolvedIdentity;
    changeObservation?:
        ExternalAgentObservationResourceDescriptorV1['changeObservation'];
    watchFileChanges?: ExternalAgentObservationWatchFileChangesV1;
}>;

type LinkRecord = {
    identity: ExternalSessionObservationLinkIdentity;
    resource: ResourceRecord;
    demand: ExternalSessionObservationDemand;
    onFacts: (facts: readonly ExternalAgentObservationLeafFactV1[]) => void;
};

type LinkRedescription = Readonly<{
    resource: ExternalSessionObservationResourceIdentity;
    link: ExternalSessionObservationLinkIdentity;
}>;

type LinkRedescriptionResult =
    | Readonly<{
        original: LinkRecord;
        failed: false;
        result: LinkRedescription | null;
    }>
    | Readonly<{
        original: LinkRecord;
        failed: true;
        result: null;
    }>;

type ObserverRecord = {
    active: boolean;
    abortController: AbortController;
    observer: Disposable | null;
    observerReleased: boolean;
    startPromise: Promise<void>;
    stopPromise: Promise<void> | null;
    resource: ResourceRecord;
};

type FileWatcherRecord = {
    active: boolean;
    file: string;
    disposed: boolean;
    dispose: () => void;
    ready: Promise<void>;
    resource: ResourceRecord;
};

type TopologyWatcherBatchRecord = {
    active: boolean;
    directories: readonly string[];
    disposed: boolean;
    dispose: () => void;
    resource: ResourceRecord;
    state: 'starting' | 'ready' | 'failed';
};

type TopologyWatcherLifecycle = Readonly<{
    onReady(): void;
    onUnavailable(error: unknown): void;
}>;

type ObservationEvidenceReconcileResult = Extract<
    ExternalAgentObservationReconcileResultV1,
    Readonly<{ purpose: 'observation_evidence' }>
>;

const RESOURCE_REDESCRIPTION_TOPOLOGY = 1;
const RESOURCE_REDESCRIPTION_REFRESH_ALL = 2;
const RESOURCE_REDESCRIPTION_INITIAL = 4;
const TOPOLOGY_WATCH_RETRY_BASE_DELAY_MS = 1_000;
const TOPOLOGY_WATCH_RETRY_MAX_DELAY_MS = 30_000;

type ResourceReconciliationResult =
    | Readonly<{ state: 'reconciled'; requestedLinkKeys: number }>
    | Readonly<{ state: 'not-demanded' }>
    | Readonly<{ state: 'unavailable' }>
    | Readonly<{ state: 'stale-resource' }>
    | Readonly<{ state: 'disposed' }>;

type ResourceRecord = {
    key: string;
    identity: ExternalSessionObservationResourceIdentity;
    changeObservation:
        ExternalAgentObservationResourceDescriptorV1['changeObservation'] | null;
    active: boolean;
    links: Set<LinkRecord>;
    linksByLinkKey: Map<ExternalAgentObservationLinkKeyV1, Set<LinkRecord>>;
    observer: ObserverRecord | null;
    fileWatchersByPath: Map<string, FileWatcherRecord>;
    topologyWatcherBatch: TopologyWatcherBatchRecord | null;
    topologyWatcherRetryAttempt: number;
    topologyWatcherRetryTimer: ReturnType<typeof setTimeout> | null;
    topologyWatcherRecoveryPending: boolean;
    reconciliationAbortController: AbortController | null;
    redescriptionAbortController: AbortController | null;
    reconcilingLinkKeys: Set<ExternalAgentObservationLinkKeyV1>;
    pendingReconciliationLinkKeys: Set<ExternalAgentObservationLinkKeyV1>;
    reconciliationPromise: Promise<ResourceReconciliationResult> | null;
    redescriptionPromise: Promise<void> | null;
    pendingResourceRedescriptionReasons: number;
    pendingChangedFiles: Set<string>;
    redescribingFiles: Set<string>;
    retirementListener: (() => void) | null;
};

type ExternalSessionObservationReconcilerParams = Readonly<{
    acquireObserver: (input: Readonly<{
        resource: ExternalSessionObservationResourceIdentity;
        requestTranscriptRefresh(
            linkKey: ExternalAgentObservationLinkKeyV1,
        ): void;
    }> & Pick<
        AgentExternalSessionObservationObserveResourceRequest,
        'signal' | 'emit' | 'requestReconcile'
    >) => Disposable | Promise<Disposable>;
    requestTranscriptRefresh?: (input: Readonly<{
        sessionId: string;
        resource: Readonly<{
            linkGeneration: string;
            pluginGeneration: string;
        }>;
    }>) => unknown | Promise<unknown>;
    isTranscriptRefreshDemanded?: (input: Readonly<{
        sessionId: string;
        resource: Readonly<{
            linkGeneration: string;
            pluginGeneration: string;
        }>;
    }>) => boolean;
    reconcileResource?: (input: Readonly<{
        purpose: 'observation_evidence' | 'resource_descriptors';
        resource: ExternalSessionObservationResourceIdentity;
        links: readonly ExternalSessionObservationLinkIdentity[];
        signal: AbortSignal;
    }>) => ExternalAgentObservationReconcileResultV1
        | Promise<ExternalAgentObservationReconcileResultV1>;
    watchFile?: (
        file: string,
        onChange: (file: string) => void,
        options: Readonly<{
            emitInitial: false;
            onWatcherAttached?: () => void;
        }>,
    ) => () => void;
    watchTopologyDirectory?: (
        directory: string,
        onStructuralChange: (changedPath?: string) => void,
    ) => () => void;
    watchTopologyDirectories?: (
        targets: readonly DirectoryTopologyWatchTarget[],
        lifecycle: TopologyWatcherLifecycle,
    ) => () => void;
}>;

function resourceIdentityKey(identity: ExternalSessionObservationResourceIdentity): string {
    return JSON.stringify([
        identity.pluginId,
        identity.agentLocalId,
        identity.pluginGeneration,
        identity.resourceKey,
    ]);
}

function isObserverDemanded(demand: ExternalSessionObservationDemand): boolean {
    return (
        demand.passiveEvent
        || demand.persistedPolicy
        || demand.transcriptDemand === true
    );
}

function isReconciliationDemanded(demand: ExternalSessionObservationDemand): boolean {
    return demand.fallbackDemand;
}

function isStatusEvidenceDemanded(
    demand: ExternalSessionObservationDemand,
): boolean {
    return (
        demand.passiveEvent
        || demand.persistedPolicy
        || isReconciliationDemanded(demand)
    );
}

function isAnyObservationDemanded(demand: ExternalSessionObservationDemand): boolean {
    return isObserverDemanded(demand) || isReconciliationDemanded(demand);
}

/**
 * Reconciles External Sessions observation demand into leaf-owned physical observers.
 *
 * Agent leaves own opaque resource/link correlation and evidence meaning. This host
 * owner pools physical observers, admits only current link keys, and fences every
 * projection by plugin and Happier-link generation. Keys and resource state remain
 * process-local and are never persisted or logged here.
 */
export function createExternalSessionObservationReconciler(
    params: ExternalSessionObservationReconcilerParams,
) {
    const resourcesByKey = new Map<string, ResourceRecord>();
    const linksBySessionId = new Map<string, LinkRecord>();
    const watchFile = params.watchFile
        ? (
            file: string,
            onChange: (file: string) => void,
        ) => ({
            dispose: params.watchFile!(file, onChange, { emitInitial: false }),
            ready: Promise.resolve(),
        })
        : (
            file: string,
            onChange: (file: string) => void,
        ) => {
            let readySettled = false;
            let settleReady = () => {};
            let rejectReady = (_error: unknown) => {};
            const ready = new Promise<void>((resolve, reject) => {
                settleReady = () => {
                    if (readySettled) return;
                    readySettled = true;
                    resolve();
                };
                rejectReady = (error) => {
                    if (readySettled) return;
                    readySettled = true;
                    reject(error);
                };
            });
            const dispose = startFileWatcher(file, onChange, {
                emitInitial: false,
                onWatcherAttached: settleReady,
                onWatcherUnavailable: rejectReady,
            });
            return {
                ready,
                dispose: () => {
                    settleReady();
                    dispose();
                },
            };
        };
    const watchTopologyDirectories = params.watchTopologyDirectories
        ?? (
            params.watchTopologyDirectory
                ? (
                    targets: readonly DirectoryTopologyWatchTarget[],
                    lifecycle: TopologyWatcherLifecycle,
                ) => {
                    const disposers: Array<() => void> = [];
                    try {
                        for (const target of targets) {
                            disposers.push(params.watchTopologyDirectory!(
                                target.directory,
                                target.onStructuralChange,
                            ));
                        }
                    } catch (error) {
                        for (const dispose of disposers) {
                            dispose();
                        }
                        throw error;
                    }
                    lifecycle.onReady();
                    let released = false;
                    return () => {
                        if (released) return;
                        released = true;
                        for (const dispose of disposers) {
                            dispose();
                        }
                    };
                }
                : (
                    targets: readonly DirectoryTopologyWatchTarget[],
                    lifecycle: TopologyWatcherLifecycle,
                ) => startDirectoryTopologyWatchers(targets, lifecycle)
        );
    let disposed = false;

    const isCurrentLink = (link: LinkRecord): boolean => (
        link.resource.active
        && resourcesByKey.get(link.resource.key) === link.resource
        && linksBySessionId.get(link.identity.sessionId) === link
        && link.resource.links.has(link)
    );

    const routeBatch = (
        resource: ResourceRecord,
        batch: ExternalAgentObservationLinkEvidenceBatchV1['items']
            | ObservationEvidenceReconcileResult['outcomes'],
        admittedLinkKeys?: ReadonlySet<ExternalAgentObservationLinkKeyV1>,
        requiresAuthoritativeDescriptor = false,
    ): void => {
        if (
            disposed
            || !resource.active
            || resourcesByKey.get(resource.key) !== resource
        ) {
            return;
        }

        for (const entry of batch) {
            if (admittedLinkKeys && !admittedLinkKeys.has(entry.linkKey)) {
                continue;
            }
            const matchingLinks = resource.linksByLinkKey.get(entry.linkKey);
            if (!matchingLinks) {
                continue;
            }
            for (const link of [...matchingLinks]) {
                if (
                    !isCurrentLink(link)
                    || (
                        requiresAuthoritativeDescriptor
                        && link.identity.changeObservation === undefined
                    )
                ) {
                    continue;
                }
                try {
                    link.onFacts(entry.facts);
                } catch {
                    // One projection consumer must not block sibling Happier links.
                }
            }
        }
    };

    const releaseObserver = async (observer: ObserverRecord): Promise<void> => {
        if (!observer.observer || observer.observerReleased) {
            return;
        }
        observer.observerReleased = true;
        await Promise.resolve(observer.observer.dispose()).catch(() => undefined);
    };

    const releaseFileWatcher = (watcher: FileWatcherRecord): void => {
        if (watcher.disposed) return;
        watcher.disposed = true;
        watcher.active = false;
        watcher.dispose();
    };

    const stopFileWatchers = (resource: ResourceRecord): void => {
        for (const watcher of resource.fileWatchersByPath.values()) {
            releaseFileWatcher(watcher);
        }
        resource.fileWatchersByPath.clear();
    };

    const releaseTopologyWatcherBatch = (
        watcher: TopologyWatcherBatchRecord,
    ): void => {
        if (watcher.disposed) return;
        watcher.disposed = true;
        watcher.active = false;
        watcher.dispose();
    };

    const cancelTopologyWatcherRetry = (
        resource: ResourceRecord,
        resetAttempt: boolean,
    ): void => {
        const timer = resource.topologyWatcherRetryTimer;
        resource.topologyWatcherRetryTimer = null;
        if (timer) {
            clearTimeout(timer);
        }
        if (resetAttempt) {
            resource.topologyWatcherRetryAttempt = 0;
        }
    };

    const stopTopologyWatcherBatch = (resource: ResourceRecord): void => {
        const watcher = resource.topologyWatcherBatch;
        resource.topologyWatcherBatch = null;
        if (watcher) {
            releaseTopologyWatcherBatch(watcher);
        }
    };

    const stopTopologyWatchers = (resource: ResourceRecord): void => {
        stopTopologyWatcherBatch(resource);
        cancelTopologyWatcherRetry(resource, true);
        resource.topologyWatcherRecoveryPending = false;
    };

    const desiredFileWatchPaths = (resource: ResourceRecord): Set<string> => {
        const desired = new Set<string>();
        if (resource.identity.retirementSignal?.aborted) {
            return desired;
        }
        for (const link of resource.links) {
            if (
                !isCurrentLink(link)
                || !isObserverDemanded(link.demand)
                || resource.changeObservation !== 'watch_file_changes'
            ) {
                continue;
            }
            for (const file of link.identity.watchFileChanges?.files ?? []) {
                desired.add(file);
            }
        }
        return desired;
    };

    const reconcileFileWatchDemand = async (
        resource: ResourceRecord,
    ): Promise<void> => {
        if (
            disposed
            || !resource.active
            || resourcesByKey.get(resource.key) !== resource
        ) {
            stopFileWatchers(resource);
            return;
        }
        const desired = desiredFileWatchPaths(resource);
        for (const [file, watcher] of resource.fileWatchersByPath) {
            if (desired.has(file)) continue;
            resource.fileWatchersByPath.delete(file);
            releaseFileWatcher(watcher);
        }
        const readiness: Promise<void>[] = [];
        for (const file of desired) {
            const existing = resource.fileWatchersByPath.get(file);
            if (existing) {
                readiness.push(existing.ready);
                continue;
            }
            const watcher: FileWatcherRecord = {
                active: true,
                file,
                disposed: false,
                dispose: () => {},
                ready: Promise.resolve(),
                resource,
            };
            resource.fileWatchersByPath.set(file, watcher);
            const watched = watchFile(file, () => {
                if (
                    disposed
                    || !watcher.active
                    || watcher.disposed
                    || resource.fileWatchersByPath.get(file) !== watcher
                    || !resource.active
                ) {
                    return;
                }
                requestFileChangeRedescription(resource, file);
            });
            watcher.dispose = watched.dispose;
            watcher.ready = watched.ready;
            readiness.push(watcher.ready);
            if (
                disposed
                || !watcher.active
                || !resource.active
                || resource.fileWatchersByPath.get(file) !== watcher
            ) {
                releaseFileWatcher(watcher);
            }
        }
        await Promise.all(readiness);
    };

    const desiredTopologyWatchPaths = (resource: ResourceRecord): Set<string> => {
        const desired = new Set<string>();
        if (resource.identity.retirementSignal?.aborted) {
            return desired;
        }
        for (const link of resource.links) {
            if (
                !isCurrentLink(link)
                || !isObserverDemanded(link.demand)
                || resource.changeObservation !== 'watch_file_changes'
            ) {
                continue;
            }
            for (
                const directory
                of link.identity.watchFileChanges?.topologyDirectories ?? []
            ) {
                desired.add(directory);
            }
        }
        return desired;
    };

    const scheduleTopologyWatcherRetry = (resource: ResourceRecord): void => {
        if (
            disposed
            || !resource.active
            || resourcesByKey.get(resource.key) !== resource
            || resource.identity.retirementSignal?.aborted
            || resource.topologyWatcherRetryTimer
        ) {
            return;
        }
        resource.topologyWatcherRetryAttempt += 1;
        const delayMs = computeExponentialBackoffMs({
            attempt: resource.topologyWatcherRetryAttempt,
            baseDelayMs: TOPOLOGY_WATCH_RETRY_BASE_DELAY_MS,
            maxDelayMs: TOPOLOGY_WATCH_RETRY_MAX_DELAY_MS,
        });
        const timer = setTimeout(() => {
            if (resource.topologyWatcherRetryTimer !== timer) {
                return;
            }
            resource.topologyWatcherRetryTimer = null;
            if (
                disposed
                || !resource.active
                || resourcesByKey.get(resource.key) !== resource
                || resource.identity.retirementSignal?.aborted
            ) {
                return;
            }
            reconcileTopologyWatchDemand(resource, true);
        }, delayMs);
        resource.topologyWatcherRetryTimer = timer;
        timer.unref?.();
    };

    const reconcileTopologyWatchDemand = (
        resource: ResourceRecord,
        retryFailedBatch = false,
    ): void => {
        if (
            disposed
            || !resource.active
            || resourcesByKey.get(resource.key) !== resource
        ) {
            stopTopologyWatchers(resource);
            return;
        }
        const desired = [...desiredTopologyWatchPaths(resource)].sort();
        if (desired.length === 0) {
            stopTopologyWatchers(resource);
            return;
        }
        const current = resource.topologyWatcherBatch;
        if (
            current
            && current.directories.length === desired.length
            && current.directories.every(
                (directory, index) => directory === desired[index],
            )
            && (!retryFailedBatch || current.state !== 'failed')
        ) {
            return;
        }
        const replacingFailedBatch = (
            retryFailedBatch
            && current?.state === 'failed'
        );
        stopTopologyWatcherBatch(resource);
        cancelTopologyWatcherRetry(resource, !replacingFailedBatch);
        if (!replacingFailedBatch && current?.state !== 'failed') {
            resource.topologyWatcherRecoveryPending = false;
        }
        const watcher: TopologyWatcherBatchRecord = {
            active: true,
            directories: desired,
            disposed: false,
            dispose: () => {},
            resource,
            state: 'starting',
        };
        resource.topologyWatcherBatch = watcher;
        const lifecycle: TopologyWatcherLifecycle = {
            onReady: () => {
                if (
                    disposed
                    || !watcher.active
                    || watcher.disposed
                    || resource.topologyWatcherBatch !== watcher
                    || !resource.active
                ) {
                    return;
                }
                watcher.state = 'ready';
                cancelTopologyWatcherRetry(resource, true);
                if (!resource.topologyWatcherRecoveryPending) {
                    return;
                }
                resource.topologyWatcherRecoveryPending = false;
                requestTopologyResourceRedescription(resource);
            },
            onUnavailable: () => {
                if (
                    disposed
                    || !watcher.active
                    || watcher.disposed
                    || watcher.state === 'failed'
                    || resource.topologyWatcherBatch !== watcher
                    || !resource.active
                ) {
                    return;
                }
                watcher.state = 'failed';
                resource.topologyWatcherRecoveryPending = true;
                releaseTopologyWatcherBatch(watcher);
                scheduleTopologyWatcherRetry(resource);
            },
        };
        let disposeTopologyWatch: () => void;
        try {
            disposeTopologyWatch = watchTopologyDirectories(
                desired.map((directory) => ({
                    directory,
                    onStructuralChange: (changedPath) => {
                        if (
                            disposed
                            || !watcher.active
                            || watcher.disposed
                            || resource.topologyWatcherBatch !== watcher
                            || !resource.active
                        ) {
                            return;
                        }
                        if (
                            changedPath
                            && resource.fileWatchersByPath.has(changedPath)
                        ) {
                            return;
                        }
                        requestTopologyResourceRedescription(resource);
                    },
                })),
                lifecycle,
            );
        } catch (error) {
            lifecycle.onUnavailable(error);
            return;
        }
        watcher.dispose = disposeTopologyWatch;
        if (watcher.disposed) {
            disposeTopologyWatch();
        }
        if (
            disposed
            || !watcher.active
            || !resource.active
            || resource.topologyWatcherBatch !== watcher
        ) {
            releaseTopologyWatcherBatch(watcher);
        }
    };

    const stopObserver = (resource: ResourceRecord): Promise<void> => {
        const observer = resource.observer;
        if (!observer) {
            return Promise.resolve();
        }
        if (observer.stopPromise) {
            return observer.stopPromise;
        }

        observer.active = false;
        observer.abortController.abort();
        observer.stopPromise = (async () => {
            await observer.startPromise.catch(() => undefined);
            await releaseObserver(observer);
            if (resource.observer === observer) {
                resource.observer = null;
            }
        })();
        return observer.stopPromise;
    };

    const hasObserverDemand = (resource: ResourceRecord): boolean => {
        for (const link of resource.links) {
            if (
                isCurrentLink(link)
                && isObserverDemanded(link.demand)
                && link.identity.changeObservation === 'observe_resource'
                && resource.changeObservation === 'observe_resource'
            ) {
                return true;
            }
        }
        return false;
    };

    const ensureObserver = async (resource: ResourceRecord): Promise<void> => {
        const currentObserver = resource.observer;
        if (currentObserver?.active) {
            await currentObserver.startPromise;
            return;
        }
        if (!resource.active || resourcesByKey.get(resource.key) !== resource) {
            return;
        }

        const observer: ObserverRecord = {
            active: true,
            abortController: new AbortController(),
            observer: null,
            observerReleased: false,
            startPromise: Promise.resolve(),
            stopPromise: null,
            resource,
        };
        resource.observer = observer;
        observer.startPromise = Promise.resolve()
            .then(() => params.acquireObserver({
                resource: resource.identity,
                signal: observer.abortController.signal,
                emit: (batch) => {
                    if (
                        !observer.active
                        || resource.observer !== observer
                        || !resource.active
                    ) {
                        return;
                    }
                    routeBatch(resource, batch.items, undefined, true);
                },
                requestReconcile: () => {
                    if (
                        !observer.active
                        || resource.observer !== observer
                        || !resource.active
                    ) {
                        return;
                    }
                    requestObservedResourceReconciliation(resource);
                    requestObservedResourceTranscriptRefresh(resource);
                },
                requestTranscriptRefresh: (linkKey) => {
                    if (
                        !observer.active
                        || resource.observer !== observer
                        || !resource.active
                    ) {
                        return;
                    }
                    requestTranscriptRefreshForLinkKey(resource, linkKey);
                },
            }))
            .then(async (acquiredObserver) => {
                observer.observer = acquiredObserver;
                if (
                    disposed
                    || !observer.active
                    || resource.observer !== observer
                    || !resource.active
                    || resourcesByKey.get(resource.key) !== resource
                ) {
                    await releaseObserver(observer);
                }
            })
            .catch((error: unknown) => {
                if (resource.observer === observer) {
                    resource.observer = null;
                }
                throw error;
            });
        await observer.startPromise;
    };

    const getOrCreateResource = (
        identity: ExternalSessionObservationResourceIdentity,
        changeObservation?:
            ExternalAgentObservationResourceDescriptorV1['changeObservation'],
    ): ResourceRecord | null => {
        const key = resourceIdentityKey(identity);
        const existing = resourcesByKey.get(key);
        if (existing) {
            if (
                changeObservation !== undefined
                && existing.changeObservation !== null
                && existing.changeObservation !== changeObservation
            ) {
                return null;
            }
            if (changeObservation !== undefined) {
                existing.changeObservation = changeObservation;
            }
            return existing;
        }
        if (identity.retirementSignal?.aborted) {
            return null;
        }

        const resource: ResourceRecord = {
            key,
            identity,
            changeObservation: changeObservation ?? null,
            active: true,
            links: new Set(),
            linksByLinkKey: new Map(),
            observer: null,
            fileWatchersByPath: new Map(),
            topologyWatcherBatch: null,
            topologyWatcherRetryAttempt: 0,
            topologyWatcherRetryTimer: null,
            topologyWatcherRecoveryPending: false,
            reconciliationAbortController: null,
            redescriptionAbortController: null,
            reconcilingLinkKeys: new Set(),
            pendingReconciliationLinkKeys: new Set(),
            reconciliationPromise: null,
            redescriptionPromise: null,
            pendingResourceRedescriptionReasons: 0,
            pendingChangedFiles: new Set(),
            redescribingFiles: new Set(),
            retirementListener: null,
        };
        const retirementSignal = identity.retirementSignal;
        if (retirementSignal) {
            const retire = () => {
                void deactivateResource(resource);
            };
            resource.retirementListener = retire;
            retirementSignal.addEventListener('abort', retire, { once: true });
        }
        resourcesByKey.set(key, resource);
        return resource;
    };

    const addLinkToResource = (link: LinkRecord): void => {
        link.resource.links.add(link);
        const matchingLinks = link.resource.linksByLinkKey.get(link.identity.linkKey);
        if (matchingLinks) {
            matchingLinks.add(link);
        } else {
            link.resource.linksByLinkKey.set(link.identity.linkKey, new Set([link]));
        }
    };

    const removeLinkFromResource = (link: LinkRecord): void => {
        link.resource.links.delete(link);
        const matchingLinks = link.resource.linksByLinkKey.get(link.identity.linkKey);
        matchingLinks?.delete(link);
        if (matchingLinks?.size === 0) {
            link.resource.linksByLinkKey.delete(link.identity.linkKey);
        }
    };

    const deactivateResource = async (resource: ResourceRecord): Promise<void> => {
        if (!resource.active) {
            await stopObserver(resource);
            return;
        }

        resource.active = false;
        if (resourcesByKey.get(resource.key) === resource) {
            resourcesByKey.delete(resource.key);
        }
        resource.reconciliationAbortController?.abort();
        resource.redescriptionAbortController?.abort();
        for (const link of resource.links) {
            if (linksBySessionId.get(link.identity.sessionId) === link) {
                linksBySessionId.delete(link.identity.sessionId);
            }
        }
        resource.links.clear();
        resource.linksByLinkKey.clear();
        if (!resource.redescriptionPromise) {
            resource.pendingResourceRedescriptionReasons = 0;
        }
        resource.pendingChangedFiles.clear();
        resource.redescribingFiles.clear();
        stopFileWatchers(resource);
        stopTopologyWatchers(resource);
        if (resource.identity.retirementSignal && resource.retirementListener) {
            resource.identity.retirementSignal.removeEventListener(
                'abort',
                resource.retirementListener,
            );
            resource.retirementListener = null;
        }
        await stopObserver(resource);
        await resource.reconciliationPromise?.catch(() => undefined);
    };

    const reconcileObserverDemand = async (resource: ResourceRecord): Promise<void> => {
        if (resource.changeObservation === null) {
            stopFileWatchers(resource);
            stopTopologyWatchers(resource);
            await stopObserver(resource);
            return;
        }
        await reconcileFileWatchDemand(resource);
        reconcileTopologyWatchDemand(resource);
        if (hasObserverDemand(resource)) {
            await ensureObserver(resource);
            return;
        }
        await stopObserver(resource);
    };

    const detachLink = async (link: LinkRecord): Promise<void> => {
        if (linksBySessionId.get(link.identity.sessionId) === link) {
            linksBySessionId.delete(link.identity.sessionId);
        }
        removeLinkFromResource(link);
        if (link.resource.links.size === 0) {
            await deactivateResource(link.resource);
            return;
        }
        await reconcileObserverDemand(link.resource);
    };

    const resolveStartedLinkState = (link: LinkRecord) => {
        if (disposed) {
            return { state: 'disposed' } as const;
        }
        if (!isCurrentLink(link)) {
            return { state: 'superseded' } as const;
        }
        if (
            isObserverDemanded(link.demand)
            && link.identity.changeObservation !== undefined
            && link.identity.changeObservation !== 'reconcile_only'
        ) {
            return { state: 'observing' } as const;
        }
        return { state: 'reconcile-only' } as const;
    };

    function requestResourceReconciliation(
        resource: ResourceRecord,
        requestedLinkKeys: ReadonlySet<ExternalAgentObservationLinkKeyV1>,
    ): Promise<ResourceReconciliationResult> {
        if (disposed) {
            return Promise.resolve({ state: 'disposed' });
        }
        if (!resource.active || resourcesByKey.get(resource.key) !== resource) {
            return Promise.resolve({ state: 'not-demanded' });
        }

        for (const linkKey of requestedLinkKeys) {
            if (!resource.reconcilingLinkKeys.has(linkKey)) {
                resource.pendingReconciliationLinkKeys.add(linkKey);
            }
        }
        if (resource.reconciliationPromise) {
            return resource.reconciliationPromise;
        }
        if (resource.pendingReconciliationLinkKeys.size === 0) {
            return Promise.resolve({ state: 'not-demanded' });
        }
        const reconcileResource = params.reconcileResource;
        if (!reconcileResource) {
            resource.pendingReconciliationLinkKeys.clear();
            return Promise.resolve({ state: 'unavailable' });
        }

        const abortController = new AbortController();
        resource.reconciliationAbortController = abortController;
        const reconciliationPromise: Promise<ResourceReconciliationResult> = (async (
        ): Promise<ResourceReconciliationResult> => {
            let reconciledLinkKeys = 0;
            while (resource.pendingReconciliationLinkKeys.size > 0) {
                const currentLinkKeys = new Set(resource.pendingReconciliationLinkKeys);
                resource.pendingReconciliationLinkKeys.clear();
                resource.reconcilingLinkKeys = currentLinkKeys;

                const links = [...currentLinkKeys].map((linkKey) => {
                    const currentLink = [...(resource.linksByLinkKey.get(linkKey) ?? [])]
                        .find(isCurrentLink);
                    return currentLink
                        ? currentLink.identity
                        : null;
                }).filter((link): link is ExternalSessionObservationLinkIdentity => link !== null);
                const admittedLinkKeys = new Set(links.map((link) => link.linkKey));
                if (links.length === 0) {
                    resource.reconcilingLinkKeys.clear();
                    continue;
                }
                const batch = await reconcileResource({
                    purpose: 'observation_evidence',
                    resource: resource.identity,
                    links,
                    signal: abortController.signal,
                });

                if (
                    disposed
                    || abortController.signal.aborted
                    || !resource.active
                    || resourcesByKey.get(resource.key) !== resource
                ) {
                    return { state: 'stale-resource' };
                }
                if (batch.purpose !== 'observation_evidence') {
                    throw new TypeError(
                        'External Agent observation evidence reconciliation returned a mismatched purpose',
                    );
                }
                routeBatch(resource, batch.outcomes, admittedLinkKeys);
                reconciledLinkKeys += admittedLinkKeys.size;
                resource.reconcilingLinkKeys.clear();
            }
            return {
                state: 'reconciled',
                requestedLinkKeys: reconciledLinkKeys,
            };
        })().finally(() => {
            resource.reconcilingLinkKeys.clear();
            if (resource.reconciliationAbortController === abortController) {
                resource.reconciliationAbortController = null;
            }
            if (resource.reconciliationPromise === reconciliationPromise) {
                resource.reconciliationPromise = null;
            }
        });
        resource.reconciliationPromise = reconciliationPromise;
        return reconciliationPromise;
    }

    function requestObservedResourceReconciliation(resource: ResourceRecord): void {
        const requestedLinkKeys = new Set<ExternalAgentObservationLinkKeyV1>();
        for (const link of resource.links) {
            if (
                isCurrentLink(link)
                && isStatusEvidenceDemanded(link.demand)
            ) {
                requestedLinkKeys.add(link.identity.linkKey);
            }
        }
        void requestResourceReconciliation(resource, requestedLinkKeys).catch(() => undefined);
    }

    function requestTranscriptRefreshForLink(link: LinkRecord): void {
        if (
            !isCurrentLink(link)
            || link.identity.changeObservation === undefined
            || !params.requestTranscriptRefresh
        ) {
            return;
        }
        const input = {
            sessionId: link.identity.sessionId,
            resource: {
                linkGeneration: link.identity.linkGeneration,
                pluginGeneration: link.resource.identity.pluginGeneration,
            },
        };
        if (params.isTranscriptRefreshDemanded?.(input) !== true) return;
        void Promise.resolve(params.requestTranscriptRefresh(input))
            .catch(() => undefined);
    }

    function requestTranscriptRefreshForLinkKey(
        resource: ResourceRecord,
        linkKey: ExternalAgentObservationLinkKeyV1,
    ): void {
        if (
            disposed
            || !resource.active
            || resourcesByKey.get(resource.key) !== resource
        ) {
            return;
        }
        for (const link of resource.linksByLinkKey.get(linkKey) ?? []) {
            requestTranscriptRefreshForLink(link);
        }
    }

    function requestObservedResourceTranscriptRefresh(resource: ResourceRecord): void {
        if (
            disposed
            || !resource.active
            || resourcesByKey.get(resource.key) !== resource
        ) {
            return;
        }
        for (const link of resource.links) {
            requestTranscriptRefreshForLink(link);
        }
    }

    async function reconcileLink(input: Readonly<{
        resource: ExternalSessionObservationResourceIdentity;
        link: ExternalSessionObservationLinkIdentity;
        demand: ExternalSessionObservationDemand;
        onFacts: (facts: readonly ExternalAgentObservationLeafFactV1[]) => void;
        awaitObserverAdmission?: boolean;
    }>) {
        if (disposed) {
            return { state: 'disposed' } as const;
        }

        const existingLink = linksBySessionId.get(input.link.sessionId) ?? null;
        if (!isAnyObservationDemanded(input.demand)) {
            if (
                existingLink
                && existingLink.identity.linkGeneration === input.link.linkGeneration
                && existingLink.identity.linkKey === input.link.linkKey
            ) {
                await detachLink(existingLink);
            }
            return { state: 'not-demanded' } as const;
        }
        if (input.resource.retirementSignal?.aborted) {
            if (existingLink) {
                await detachLink(existingLink);
            }
            return { state: 'superseded' } as const;
        }

        const nextResourceKey = resourceIdentityKey(input.resource);
        if (
            existingLink
            && existingLink.identity.linkGeneration === input.link.linkGeneration
            && existingLink.identity.linkKey === input.link.linkKey
            && existingLink.resource.key === nextResourceKey
        ) {
            if (
                input.link.changeObservation !== undefined
                && existingLink.resource.changeObservation !== null
                && existingLink.resource.changeObservation
                    !== input.link.changeObservation
            ) {
                await detachLink(existingLink);
                return { state: 'disposition-mismatch' } as const;
            }
            if (
                existingLink.resource.changeObservation === null
                && input.link.changeObservation !== undefined
            ) {
                existingLink.resource.changeObservation =
                    input.link.changeObservation;
            }
            existingLink.identity = input.link;
            existingLink.demand = input.demand;
            existingLink.onFacts = input.onFacts;
            let initialRedescription: Promise<void> | null = null;
            if (
                input.link.changeObservation === undefined
                && (
                    input.awaitObserverAdmission
                    || isObserverDemanded(input.demand)
                )
            ) {
                existingLink.resource.pendingResourceRedescriptionReasons
                    |= RESOURCE_REDESCRIPTION_INITIAL;
                initialRedescription =
                    requestResourceRedescription(existingLink.resource);
            }
            await reconcileObserverDemand(existingLink.resource);
            if (input.awaitObserverAdmission && initialRedescription) {
                await initialRedescription;
                const admittedLink =
                    linksBySessionId.get(input.link.sessionId) ?? null;
                if (
                    !admittedLink
                    || admittedLink.identity.linkGeneration
                        !== input.link.linkGeneration
                    || admittedLink.identity.linkKey !== input.link.linkKey
                ) {
                    return { state: 'superseded' } as const;
                }
                return resolveStartedLinkState(admittedLink);
            }
            return resolveStartedLinkState(existingLink);
        }

        const nextResource = getOrCreateResource(
            input.resource,
            input.link.changeObservation,
        );
        if (!nextResource) {
            if (existingLink) {
                await detachLink(existingLink);
            }
            return { state: 'disposition-mismatch' } as const;
        }
        const nextLink: LinkRecord = {
            identity: input.link,
            resource: nextResource,
            demand: input.demand,
            onFacts: input.onFacts,
        };
        linksBySessionId.set(input.link.sessionId, nextLink);
        addLinkToResource(nextLink);
        let initialRedescription: Promise<void> | null = null;
        if (
            input.link.changeObservation === undefined
            && (
                input.awaitObserverAdmission
                || isObserverDemanded(input.demand)
            )
        ) {
            nextResource.pendingResourceRedescriptionReasons
                |= RESOURCE_REDESCRIPTION_INITIAL;
            initialRedescription = requestResourceRedescription(nextResource);
        }

        if (existingLink) {
            await detachLink(existingLink);
        }
        await reconcileObserverDemand(nextResource);
        if (input.awaitObserverAdmission && initialRedescription) {
            await initialRedescription;
            const admittedLink =
                linksBySessionId.get(input.link.sessionId) ?? null;
            if (
                !admittedLink
                || admittedLink.identity.linkGeneration
                    !== input.link.linkGeneration
                || admittedLink.identity.linkKey !== input.link.linkKey
            ) {
                return { state: 'superseded' } as const;
            }
            return resolveStartedLinkState(admittedLink);
        }
        return resolveStartedLinkState(nextLink);
    }

    function requestFileChangeRedescription(
        resource: ResourceRecord,
        changedFile: string,
    ): void {
        if (
            disposed
            || !resource.active
            || resourcesByKey.get(resource.key) !== resource
            || resource.identity.retirementSignal?.aborted
        ) {
            return;
        }
        if (
            resource.pendingChangedFiles.has(changedFile)
        ) {
            return;
        }
        resource.pendingChangedFiles.add(changedFile);
        requestResourceRedescription(resource);
    }

    function requestTopologyResourceRedescription(
        resource: ResourceRecord,
    ): void {
        if (
            disposed
            || !resource.active
            || resourcesByKey.get(resource.key) !== resource
            || resource.identity.retirementSignal?.aborted
        ) {
            return;
        }
        resource.pendingResourceRedescriptionReasons
            |= RESOURCE_REDESCRIPTION_TOPOLOGY;
        requestResourceRedescription(resource);
    }

    function requestResourceRedescription(
        resource: ResourceRecord,
    ): Promise<void> {
        if (resource.redescriptionPromise) {
            return resource.redescriptionPromise;
        }
        const redescriptionPromise = (async () => {
            // Grouping is authority-free. Defer to the next event-loop turn so
            // sequential and bounded-concurrent admission microtasks join one
            // resource pass. This is scheduling only: no deadline, retry timer,
            // polling cadence, or independent lifecycle is introduced.
            await new Promise<void>((resolve) => {
                setImmediate(resolve);
            });
            while (
                resource.pendingResourceRedescriptionReasons !== 0
                || resource.pendingChangedFiles.size > 0
            ) {
                const redescriptionReasons =
                    resource.pendingResourceRedescriptionReasons;
                const redescribeWholeResource = redescriptionReasons !== 0;
                const refreshWholeResource = (
                    redescriptionReasons & RESOURCE_REDESCRIPTION_REFRESH_ALL
                ) !== 0;
                const topologyRedescription = (
                    redescriptionReasons & RESOURCE_REDESCRIPTION_TOPOLOGY
                ) !== 0;
                const initialRedescription = (
                    redescriptionReasons & RESOURCE_REDESCRIPTION_INITIAL
                ) !== 0;
                resource.pendingResourceRedescriptionReasons
                    &= ~redescriptionReasons;
                const changedFiles = new Set(resource.pendingChangedFiles);
                resource.pendingChangedFiles.clear();
                resource.redescribingFiles = changedFiles;
                const currentLinks = [...resource.links].filter((link) => {
                    if (
                        !isCurrentLink(link)
                        || (
                            !isObserverDemanded(link.demand)
                            && !(
                                initialRedescription
                                && isReconciliationDemanded(link.demand)
                            )
                        )
                    ) {
                        return false;
                    }
                    return redescribeWholeResource
                        || link.identity.watchFileChanges?.files.some(
                            (file) => changedFiles.has(file),
                        ) === true;
                });
                const reconcileResource = params.reconcileResource;
                if (currentLinks.length === 0) {
                    continue;
                }
                if (!reconcileResource) {
                    requestObservedResourceReconciliation(resource);
                    if (refreshWholeResource) {
                        requestObservedResourceTranscriptRefresh(resource);
                    }
                    continue;
                }
                const redescribed = await (async () => {
                        const abortController = new AbortController();
                        resource.redescriptionAbortController = abortController;
                        try {
                            const linksByLinkKey = new Map<
                                ExternalAgentObservationLinkKeyV1,
                                LinkRecord[]
                            >();
                            for (const link of currentLinks) {
                                const matching = linksByLinkKey.get(
                                    link.identity.linkKey,
                                );
                                if (matching) {
                                    matching.push(link);
                                } else {
                                    linksByLinkKey.set(
                                        link.identity.linkKey,
                                        [link],
                                    );
                                }
                            }
                            const requestedLinks = [...linksByLinkKey.values()]
                                .map((matching) => matching[0]!);
                            const result = await reconcileResource!({
                                purpose: 'resource_descriptors',
                                resource: resource.identity,
                                links: requestedLinks.map((link) => link.identity),
                                signal: abortController.signal,
                            });
                            if (
                                result.purpose !== 'resource_descriptors'
                                || result.outcomes.length !== requestedLinks.length
                            ) {
                                throw new TypeError(
                                    'External Agent resource descriptor reconciliation returned a mismatched result',
                                );
                            }
                            const redescribed: LinkRedescriptionResult[] = [];
                            for (
                                const [index, outcome]
                                of result.outcomes.entries()
                            ) {
                                const requested = requestedLinks[index]!;
                                const outcomeLinkKey = outcome.kind === 'described'
                                    ? outcome.descriptor.linkKey
                                    : outcome.linkKey;
                                if (outcomeLinkKey !== requested.identity.linkKey) {
                                    throw new TypeError(
                                        'External Agent resource descriptor reconciliation returned a foreign link',
                                    );
                                }
                                const originals = linksByLinkKey.get(
                                    outcomeLinkKey,
                                ) ?? [];
                                if (outcome.kind === 'unavailable') {
                                    for (const original of originals) {
                                        redescribed.push({
                                            original,
                                            failed: false,
                                            result: null,
                                        });
                                    }
                                    continue;
                                }
                                const descriptor = outcome.descriptor;
                                for (const original of originals) {
                                    redescribed.push({
                                        original,
                                        failed: false,
                                        result: {
                                            resource: {
                                                ...resource.identity,
                                                resourceKey:
                                                    descriptor.resourceKey,
                                            },
                                            link: {
                                                ...original.identity,
                                                linkKey: descriptor.linkKey,
                                                changeObservation:
                                                    descriptor.changeObservation,
                                                ...(descriptor.changeObservation
                                                    === 'watch_file_changes'
                                                    ? {
                                                        watchFileChanges:
                                                            descriptor
                                                                .watchFileChanges,
                                                    }
                                                    : {
                                                        watchFileChanges:
                                                            undefined,
                                                    }),
                                            },
                                        },
                                    });
                                }
                            }
                            return redescribed;
                        } finally {
                            if (
                                resource.redescriptionAbortController
                                === abortController
                            ) {
                                resource.redescriptionAbortController = null;
                            }
                        }
                    })();
                const affectedResources = new Set<ResourceRecord>();
                for (const entry of redescribed) {
                    if (
                        disposed
                        || !isCurrentLink(entry.original)
                    ) {
                        continue;
                    }
                    if (entry.failed) {
                        const changedCurrentPath =
                            entry.original.identity.watchFileChanges?.files.some(
                                (file) => changedFiles.has(file),
                            ) === true;
                        if (refreshWholeResource || changedCurrentPath) {
                            requestTranscriptRefreshForLink(entry.original);
                        }
                        continue;
                    }
                    if (!entry.result) {
                        const changedCurrentPath =
                            entry.original.identity.watchFileChanges?.files.some(
                                (file) => changedFiles.has(file),
                            ) === true;
                        if (refreshWholeResource || changedCurrentPath) {
                            affectedResources.add(entry.original.resource);
                            requestTranscriptRefreshForLink(entry.original);
                        }
                        continue;
                    }
                    const changedRedescribedPath =
                        entry.result.link.watchFileChanges?.files.some(
                            (file) => changedFiles.has(file),
                        ) === true;
                    const originalFiles =
                        entry.original.identity.watchFileChanges?.files ?? [];
                    const redescribedFiles =
                        entry.result.link.watchFileChanges?.files ?? [];
                    const exactFileSetChanged = (
                        originalFiles.length !== redescribedFiles.length
                        || originalFiles.some(
                            (file) => !redescribedFiles.includes(file),
                        )
                    );
                    if (
                        changedRedescribedPath
                        || (topologyRedescription && exactFileSetChanged)
                    ) {
                        // Admit the demanded refresh after successful re-description
                        // while the original link is still current. Reconciliation
                        // below may rotate the physical resource and retire that
                        // record before the new link can be used for admission.
                        requestTranscriptRefreshForLink(entry.original);
                    }
                    await reconcileLink({
                        resource: entry.result.resource,
                        link: entry.result.link,
                        demand: entry.original.demand,
                        onFacts: entry.original.onFacts,
                    });
                    const current = linksBySessionId.get(entry.result.link.sessionId);
                    if (!current || !isCurrentLink(current)) continue;
                    affectedResources.add(current.resource);
                }
                for (const affected of affectedResources) {
                    if (!topologyRedescription) {
                        requestObservedResourceReconciliation(affected);
                    }
                    if (refreshWholeResource) {
                        requestObservedResourceTranscriptRefresh(affected);
                    }
                }
                if (
                    topologyRedescription
                    && (
                        resource.pendingResourceRedescriptionReasons
                        & RESOURCE_REDESCRIPTION_TOPOLOGY
                    ) !== 0
                ) {
                    for (const affected of affectedResources) {
                        if (affected !== resource) {
                            requestTopologyResourceRedescription(affected);
                        }
                    }
                    if (!resource.active) {
                        resource.pendingResourceRedescriptionReasons
                            &= ~RESOURCE_REDESCRIPTION_TOPOLOGY;
                    }
                }
                resource.redescribingFiles.clear();
            }
        })().finally(() => {
            resource.redescribingFiles.clear();
            if (resource.redescriptionPromise === redescriptionPromise) {
                resource.redescriptionPromise = null;
            }
            if (
                disposed
                || !resource.active
                || resourcesByKey.get(resource.key) !== resource
            ) {
                resource.pendingResourceRedescriptionReasons = 0;
                resource.pendingChangedFiles.clear();
                return;
            }
            if (
                resource.pendingResourceRedescriptionReasons !== 0
                || resource.pendingChangedFiles.size > 0
            ) {
                requestResourceRedescription(resource);
            }
        });
        resource.redescriptionPromise = redescriptionPromise;
        void redescriptionPromise.catch(() => undefined);
        return redescriptionPromise;
    }

    return {
        reconcileLink,

        async reconcileResource(
            identity: ExternalSessionObservationResourceIdentity,
        ): Promise<ResourceReconciliationResult> {
            if (disposed) {
                return { state: 'disposed' };
            }

            const resource = resourcesByKey.get(resourceIdentityKey(identity));
            if (!resource?.active) {
                return { state: 'not-demanded' };
            }

            const requestedLinkKeys = new Set<ExternalAgentObservationLinkKeyV1>();
            for (const link of resource.links) {
                if (isCurrentLink(link) && isReconciliationDemanded(link.demand)) {
                    requestedLinkKeys.add(link.identity.linkKey);
                }
            }
            if (requestedLinkKeys.size === 0) {
                return { state: 'not-demanded' };
            }
            return requestResourceReconciliation(resource, requestedLinkKeys);
        },

        async removeLink(input: ExternalSessionObservationLinkIdentity) {
            const existingLink = linksBySessionId.get(input.sessionId) ?? null;
            if (
                !existingLink
                || existingLink.identity.linkGeneration !== input.linkGeneration
                || existingLink.identity.linkKey !== input.linkKey
            ) {
                return { removed: false } as const;
            }
            await detachLink(existingLink);
            return { removed: true } as const;
        },

        async dispose() {
            if (disposed) return;
            disposed = true;
            await Promise.all(
                [...resourcesByKey.values()].map((resource) => deactivateResource(resource)),
            );
        },
    };
}
