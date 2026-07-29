import {
    readExternalSessionFollowPolicyV1,
    readExternalSessionsSettingsV1,
    readLinkedExternalSessionV1FromMetadata,
} from '@happier-dev/protocol';

import { readCredentials as readStoredCredentials } from '@/persistence';
import {
    fetchSessionsPage,
    type RawSessionListRow,
} from '@/session/transport/http/sessionsHttp';
import {
    tryDecryptSessionOwnerMetadataView,
} from '@/session/transport/encryption/sessionEncryptionContext';
import {
    acquireCanonicalExternalSessionFollowLease,
    canAttemptCanonicalExternalSessionLiveFollow,
} from '@/api/session/external/leases/acquireCanonicalExternalSessionFollowLease';
import {
    loadLinkedExternalSession,
    loadLinkedExternalSessionFromRaw,
    loadPersistedLinkedExternalSession,
} from '@/api/session/external/takeover/loadLinkedExternalSession';
import {
    resolveDefaultMaxBytes,
    resolveDefaultMaxItems,
} from '@/session/actions/externalSessions/actionConfiguration';
import { resolveGenerationBoundExternalSessionFollowSurface } from '@/session/actions/externalSessions/providerOpsResolution';
import { logExternalSessionsInternalError } from '@/session/actions/externalSessions/responseErrors';
import {
    getActiveAccountSettingsSnapshot,
    subscribeActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';

import type {
    ExternalSessionObservationDemand,
} from './createExternalSessionObservationReconciler';
import type {
    createExternalSessionFollowLeaseManager,
} from './createExternalSessionFollowLeaseManager';
import {
    resolveExternalSessionObservationLinkInput,
    type ExternalSessionObservationLinkInput,
    type ExternalSessionObservationLinkedSession,
} from './resolveExternalSessionObservationLinkInput';

const PASSIVE_OBSERVATION_PAGE_SIZE = 200;
const PASSIVE_OBSERVATION_MAX_PAGES = 25;
const PASSIVE_OBSERVATION_RESOLVE_CONCURRENCY = 8;
const PASSIVE_OBSERVATION_MAX_POLICIES = 100;
const PASSIVE_OBSERVATION_MAX_JITTER_MS = 250;

type Credentials = NonNullable<Awaited<ReturnType<typeof readStoredCredentials>>>;
type FetchPage = (params: Readonly<{
    token: string;
    cursor?: string;
    limit: number;
}>) => Promise<{
    sessions: RawSessionListRow[];
    nextCursor: string | null;
    hasNext: boolean;
}>;

export type ExternalSessionPassivePolicy = Readonly<{
    sessionId: string;
    observation: ExternalSessionObservationLinkInput | null;
}>;

type CurrentExternalSessionPassivePolicy =
    | Readonly<{
        state: 'active';
        observation: ExternalSessionObservationLinkInput;
    }>
    | Readonly<{
        state: 'archived';
        backgroundFollow: boolean;
    }>
    | Readonly<{ state: 'disabled' }>
    | Readonly<{ state: 'missing' }>
    | Readonly<{ state: 'unavailable' }>;

export type ExternalSessionPassiveReconcileResult = Readonly<{
    status: 'settled' | 'unavailable' | 'stale';
}>;

export async function listCurrentExternalSessionPassivePolicies(params: Readonly<{
    machineId: string;
    signal: AbortSignal;
    readCredentials?: () => Promise<Credentials | null>;
    fetchPage?: FetchPage;
    decryptOwnerMetadataView?: typeof tryDecryptSessionOwnerMetadataView;
    resolveLinkInput?: typeof resolveExternalSessionObservationLinkInput;
}>): Promise<ExternalSessionPassivePolicy[]> {
    const readCredentials = params.readCredentials ?? readStoredCredentials;
    const credentials = await readCredentials();
    if (!credentials || params.signal.aborted) return [];

    const fetchPage = params.fetchPage ?? fetchSessionsPage;
    const decryptOwnerMetadataView = params.decryptOwnerMetadataView
        ?? tryDecryptSessionOwnerMetadataView;
    const resolveLinkInput = params.resolveLinkInput
        ?? resolveExternalSessionObservationLinkInput;
    const linked: Array<Readonly<{
        sessionId: string;
        linked: ExternalSessionObservationLinkedSession;
    }>> = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    for (let pageIndex = 0; pageIndex < PASSIVE_OBSERVATION_MAX_PAGES; pageIndex += 1) {
        if (params.signal.aborted) return [];
        const page = await fetchPage({
            token: credentials.token,
            ...(cursor ? { cursor } : {}),
            limit: PASSIVE_OBSERVATION_PAGE_SIZE,
        });
        for (const rawSession of page.sessions) {
            if (params.signal.aborted) return [];
            if (
                typeof rawSession.archivedAt === 'number'
                && Number.isFinite(rawSession.archivedAt)
            ) {
                continue;
            }
            const metadata = decryptOwnerMetadataView({ credentials, rawSession });
            const persisted = readLinkedExternalSessionV1FromMetadata(metadata);
            if (!persisted || persisted.machineId !== params.machineId) continue;
            if (
                readExternalSessionFollowPolicyV1(persisted.followPolicyV1)?.policy
                !== 'background_follow'
            ) {
                continue;
            }
            linked.push({
                sessionId: rawSession.id,
                linked: {
                    agentId: persisted.agentId,
                    linkGeneration: String(persisted.linkedAtMs),
                    metadata: metadata ?? {},
                    remoteSessionId: persisted.remoteSessionId,
                    source: persisted.source,
                },
            });
            if (linked.length > PASSIVE_OBSERVATION_MAX_POLICIES) {
                throw new Error(
                    `External Session passive observation inventory exceeded its ${PASSIVE_OBSERVATION_MAX_POLICIES}-policy bound`,
                );
            }
        }
        if (!page.hasNext) break;
        const nextCursor = page.nextCursor?.trim();
        if (!nextCursor || seenCursors.has(nextCursor)) {
            throw new Error('External Session passive observation inventory cursor did not advance');
        }
        seenCursors.add(nextCursor);
        cursor = nextCursor;
        if (pageIndex === PASSIVE_OBSERVATION_MAX_PAGES - 1) {
            throw new Error('External Session passive observation inventory exceeded its page bound');
        }
    }

    const resolved: ExternalSessionPassivePolicy[] = [];
    for (
        let offset = 0;
        offset < linked.length;
        offset += PASSIVE_OBSERVATION_RESOLVE_CONCURRENCY
    ) {
        if (params.signal.aborted) return [];
        const batch = linked.slice(
            offset,
            offset + PASSIVE_OBSERVATION_RESOLVE_CONCURRENCY,
        );
        const batchResults = await Promise.all(batch.map(async (candidate) => ({
            sessionId: candidate.sessionId,
            observation: await resolveLinkInput({
                ...candidate,
                signal: params.signal,
            }).catch(() => null),
        })));
        resolved.push(...batchResults);
    }
    return resolved;
}

const PASSIVE_EVENT_DEMAND: ExternalSessionObservationDemand = Object.freeze({
    passiveEvent: true,
    persistedPolicy: true,
    fallbackDemand: false,
});

async function waitForPassiveRestoreJitter(signal: AbortSignal): Promise<void> {
    const delayMs = Math.floor(Math.random() * (PASSIVE_OBSERVATION_MAX_JITTER_MS + 1));
    if (delayMs === 0 || signal.aborted) return;
    await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delayMs);
        signal.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
        }, { once: true });
    });
}

function isPassiveRestoreEnabledFromAccountSettings(): boolean {
    const settings = getActiveAccountSettingsSnapshot()?.settings;
    return readExternalSessionsSettingsV1(
        settings?.externalSessionsSettingsV1,
    )?.keepPassivelyFollowingAfterRestart === true;
}

function readPassiveRestoreAccountScopeKey(): string | null {
    return getActiveAccountSettingsSnapshot()?.scopeKey ?? null;
}

export function startExternalSessionPassiveObservation(params: Readonly<{
    machineId: string;
    projection: Readonly<{
        reconcileLink(input: ExternalSessionObservationLinkInput & Readonly<{
            demand: ExternalSessionObservationDemand;
        }>): Promise<unknown>;
        reconcileTranscriptDemand?(input: Readonly<{
            resolved: ExternalSessionObservationLinkInput;
            demanded: boolean;
        }>): Promise<Readonly<{ state: string }>>;
        removeLink(input: ExternalSessionObservationLinkInput['link']): Promise<unknown>;
    }>;
    listCurrentLinks?: (input: Readonly<{
        machineId: string;
        signal: AbortSignal;
    }>) => Promise<readonly ExternalSessionPassivePolicy[]>;
    loadCurrentSessionPolicy?: (input: Readonly<{
        machineId: string;
        sessionId: string;
        signal: AbortSignal;
    }>) => Promise<CurrentExternalSessionPassivePolicy>;
    restoreFollowPolicy?: (
        sessionId: string,
        signal: AbortSignal,
    ) => Promise<boolean | void>;
    pauseFollowPolicy?: (sessionId: string) => Promise<void>;
    disableFollowPolicy?: (sessionId: string) => Promise<void>;
    releaseFollowSession?: (sessionId: string) => Promise<void>;
    followLeaseManager?: ReturnType<typeof createExternalSessionFollowLeaseManager>;
    startPaused?: boolean;
    jitterDelay?: (signal: AbortSignal) => Promise<void>;
    isRestoreEnabled?: () => boolean;
    subscribeRestoreEnabled?: (listener: () => void) => () => void;
    subscribeRuntimeReload?: (listener: () => void) => () => void;
    subscribeConnectedAccountInvalidations?: (listener: () => void) => () => void;
    reconcileSharedCredentialDemand?: () => Promise<void>;
}>) {
    const listCurrentLinks = params.listCurrentLinks
        ?? listCurrentExternalSessionPassivePolicies;
    const loadCurrentSessionPolicy = params.loadCurrentSessionPolicy
        ?? (async (input): Promise<CurrentExternalSessionPassivePolicy> => {
            const credentials = await readStoredCredentials();
            if (!credentials || input.signal.aborted) {
                return { state: 'unavailable' };
            }
            let persistedLoad: Awaited<
                ReturnType<typeof loadPersistedLinkedExternalSession>
            >;
            try {
                persistedLoad = await loadPersistedLinkedExternalSession({
                    credentials,
                    sessionId: input.sessionId,
                    machineId: input.machineId,
                    signal: input.signal,
                });
            } catch {
                return { state: 'unavailable' };
            }
            if (input.signal.aborted) return { state: 'unavailable' };
            if (!persistedLoad.ok) {
                return (
                    persistedLoad.error === 'session_not_found'
                    || persistedLoad.error === 'session_is_not_external'
                    || persistedLoad.error === 'machine_mismatch'
                )
                    ? { state: 'missing' }
                    : { state: 'unavailable' };
            }
            const persistedLink = readLinkedExternalSessionV1FromMetadata(
                persistedLoad.session.metadata,
            );
            const backgroundFollow =
                readExternalSessionFollowPolicyV1(
                    persistedLink?.followPolicyV1,
                )?.policy === 'background_follow';
            const archived =
                typeof persistedLoad.session.rawSession.archivedAt === 'number'
                && Number.isFinite(
                    persistedLoad.session.rawSession.archivedAt,
                );
            if (archived) {
                return { state: 'archived', backgroundFollow };
            }
            if (!backgroundFollow) return { state: 'disabled' };
            let loaded: Awaited<
                ReturnType<typeof loadLinkedExternalSessionFromRaw>
            >;
            try {
                loaded = await loadLinkedExternalSessionFromRaw({
                    credentials,
                    rawSession: persistedLoad.session.rawSession,
                    machineId: input.machineId,
                });
                if (!loaded.ok || input.signal.aborted) {
                    return { state: 'unavailable' };
                }
                const observation =
                    await resolveExternalSessionObservationLinkInput({
                        linked: loaded.session,
                        sessionId: input.sessionId,
                        signal: input.signal,
                    });
                if (!observation || input.signal.aborted) {
                    return { state: 'unavailable' };
                }
                return { state: 'active', observation };
            } catch {
                return { state: 'unavailable' };
            }
        });
    const trackedPolicies = new Map<string, ExternalSessionObservationLinkInput | null>();
    let disposed = false;
    let online = false;
    let generation = 0;
    let disabledThroughGeneration = -1;
    let hardReleasedThroughGeneration = -1;
    let activeController: AbortController | null = null;
    let activeRestore: Promise<void> | null = null;
    let lifecycleTransition: Promise<void> = Promise.resolve();
    const releasedAtGenerationBySessionId = new Map<string, number>();
    const sessionReconcileRevisionBySessionId = new Map<string, number>();
    const isRestoreEnabled = params.isRestoreEnabled
        ?? isPassiveRestoreEnabledFromAccountSettings;
    let observedRestoreEnabled = isRestoreEnabled();
    let observedAccountScopeKey = readPassiveRestoreAccountScopeKey();

    const restoreFollowPolicy = params.restoreFollowPolicy
        ?? (params.followLeaseManager
            ? async (
                sessionId: string,
                signal: AbortSignal,
            ): Promise<boolean> => {
                const credentials = await readStoredCredentials();
                if (!credentials || signal.aborted) return false;
                const loaded = await loadLinkedExternalSession({
                    credentials,
                    sessionId,
                    machineId: params.machineId,
                });
                if (!loaded.ok || signal.aborted) return false;
                const { providerOps, resource } =
                    await resolveGenerationBoundExternalSessionFollowSurface(
                        loaded.session.agentId,
                        loaded.session.linkGeneration,
                    );
                const observation = await resolveExternalSessionObservationLinkInput({
                    linked: loaded.session,
                    sessionId,
                });
                const canObserveTranscript =
                    canAttemptCanonicalExternalSessionLiveFollow({
                        observation,
                        resource,
                        providerOps,
                    })
                    && typeof params.projection.reconcileTranscriptDemand === 'function';
                if (signal.aborted) return false;
                if (!canObserveTranscript || !observation) return false;
                await params.followLeaseManager!.setBackgroundFollowEnabled({
                    sessionId,
                    enabled: true,
                    resource,
                    acquireFollowLease: async (reacquisitionCursor) =>
                        await acquireCanonicalExternalSessionFollowLease({
                            sessionId,
                            machineId: params.machineId,
                            linked: loaded.session,
                            resource,
                            observation,
                            providerOps,
                            initialCursor: reacquisitionCursor,
                            maxBytes: resolveDefaultMaxBytes(),
                            maxItems: Math.min(200, resolveDefaultMaxItems()),
                            observationProjection: {
                                reconcileTranscriptDemand:
                                    params.projection.reconcileTranscriptDemand!,
                            },
                            credentials,
                        }),
                });
                await params.followLeaseManager!.resumeSession({
                    sessionId,
                    reason: 'daemon_disconnected',
                });
                return true;
            }
            : undefined);
    const pauseFollowPolicy = params.pauseFollowPolicy
        ?? (params.followLeaseManager
            ? async (sessionId: string): Promise<void> => {
                await params.followLeaseManager!.suspendSession({
                    sessionId,
                    reason: 'daemon_disconnected',
                });
            }
            : undefined);
    const disableFollowPolicy = params.disableFollowPolicy
        ?? (params.followLeaseManager
            ? async (sessionId: string): Promise<void> => {
                await params.followLeaseManager!.setBackgroundFollowEnabled({
                    sessionId,
                    enabled: false,
                });
            }
            : undefined);
    const releaseFollowSession = params.releaseFollowSession
        ?? (params.followLeaseManager
            ? async (sessionId: string): Promise<void> => {
                await params.followLeaseManager!.releaseSession({ sessionId });
            }
            : undefined);
    const pauseArchivedFollowSession = async (
        sessionId: string,
        preserveBackgroundFollow = false,
    ): Promise<boolean> => {
        if (!params.followLeaseManager) {
            await releaseFollowSession?.(sessionId);
            return true;
        }
        const hasManagerDemand =
            preserveBackgroundFollow
            || params.followLeaseManager.isBackgroundFollowEnabled(sessionId)
            || params.followLeaseManager.countActiveLeases(sessionId) > 0
            || params.followLeaseManager.hasBackgroundFollowLease(sessionId);
        if (!hasManagerDemand) return true;
        const archived = await params.followLeaseManager.archiveSession({
            sessionId,
            ...(preserveBackgroundFollow
                ? { preserveBackgroundFollow: true }
                : {}),
        });
        return archived.releaseSettled;
    };
    const readSessionReconcileRevision = (sessionId: string): number =>
        sessionReconcileRevisionBySessionId.get(sessionId) ?? 0;
    const invalidateSessionReconcile = (sessionId: string): number => {
        const revision = readSessionReconcileRevision(sessionId) + 1;
        sessionReconcileRevisionBySessionId.set(sessionId, revision);
        return revision;
    };

    const removeTrackedPolicy = async (
        sessionId: string,
        observation: ExternalSessionObservationLinkInput | null,
        disable: boolean,
    ): Promise<void> => {
        if (disable) {
            await disableFollowPolicy?.(sessionId).catch(() => undefined);
        } else {
            await pauseFollowPolicy?.(sessionId).catch(() => undefined);
        }
        if (observation) {
            await params.projection.removeLink(observation.link).catch(() => undefined);
        }
    };
    const removeTrackedPassivePolicyStrict = async (
        sessionId: string,
        disable: boolean,
    ): Promise<void> => {
        const observation = trackedPolicies.get(sessionId);
        trackedPolicies.delete(sessionId);
        if (disable) {
            await disableFollowPolicy?.(sessionId);
        }
        if (observation) {
            await params.projection.removeLink(observation.link);
        }
    };
    const releaseArchivedSessionNow = async (
        sessionId: string,
        preserveBackgroundFollow = false,
    ): Promise<boolean> => {
        const observation = trackedPolicies.get(sessionId);
        trackedPolicies.delete(sessionId);
        const releaseSettled = await pauseArchivedFollowSession(
            sessionId,
            preserveBackgroundFollow,
        );
        if (observation) {
            await params.projection.removeLink(observation.link);
        }
        return releaseSettled;
    };

    const wasReleasedForRestore = (
        sessionId: string,
        restoreGeneration: number,
    ): boolean =>
        (releasedAtGenerationBySessionId.get(sessionId) ?? -1)
        >= restoreGeneration;

    const cleanupStaleRestore = async (
        sessionId: string,
        restoreGeneration: number,
    ): Promise<void> => {
        if (wasReleasedForRestore(sessionId, restoreGeneration)) {
            await pauseArchivedFollowSession(sessionId).catch(() => undefined);
            return;
        }
        if (restoreGeneration <= hardReleasedThroughGeneration) {
            await releaseFollowSession?.(sessionId).catch(() => undefined);
            return;
        }
        if (restoreGeneration <= disabledThroughGeneration) {
            await disableFollowPolicy?.(sessionId).catch(() => undefined);
            return;
        }
        await pauseFollowPolicy?.(sessionId).catch(() => undefined);
    };

    const restore = async (restoreGeneration: number, signal: AbortSignal): Promise<void> => {
        const sessionReconcileRevisionBaseline =
            new Map(sessionReconcileRevisionBySessionId);
        try {
            await (params.jitterDelay ?? waitForPassiveRestoreJitter)(signal);
            if (
                disposed
                || !online
                || signal.aborted
                || generation !== restoreGeneration
            ) {
                return;
            }
            const policies = await listCurrentLinks({
                machineId: params.machineId,
                signal,
            });
            if (
                disposed
                || !online
                || signal.aborted
                || generation !== restoreGeneration
            ) {
                return;
            }

            const nextSessionIds = new Set(policies.map((policy) => policy.sessionId));
            for (const [sessionId, observation] of trackedPolicies) {
                if (nextSessionIds.has(sessionId)) continue;
                const policyReconcileRevision =
                    sessionReconcileRevisionBaseline.get(sessionId) ?? 0;
                if (
                    readSessionReconcileRevision(sessionId)
                    !== policyReconcileRevision
                ) {
                    continue;
                }
                await disableFollowPolicy?.(sessionId).catch(() => undefined);
                if (
                    readSessionReconcileRevision(sessionId)
                    !== policyReconcileRevision
                ) {
                    continue;
                }
                if (observation) {
                    await params.projection.removeLink(observation.link)
                        .catch(() => undefined);
                }
                if (
                    readSessionReconcileRevision(sessionId)
                    !== policyReconcileRevision
                ) {
                    continue;
                }
                trackedPolicies.delete(sessionId);
            }

            for (
                let offset = 0;
                offset < policies.length;
                offset += PASSIVE_OBSERVATION_RESOLVE_CONCURRENCY
            ) {
                const batch = policies.slice(
                    offset,
                    offset + PASSIVE_OBSERVATION_RESOLVE_CONCURRENCY,
                );
                await Promise.all(batch.map(async (policy) => {
                    const policyReconcileRevision =
                        sessionReconcileRevisionBaseline.get(policy.sessionId)
                        ?? 0;
                    if (
                        disposed
                        || !online
                        || signal.aborted
                        || generation !== restoreGeneration
                        || readSessionReconcileRevision(policy.sessionId)
                            !== policyReconcileRevision
                        || wasReleasedForRestore(
                            policy.sessionId,
                            restoreGeneration,
                        )
                    ) {
                        return;
                    }
                    const previousObservation =
                        trackedPolicies.get(policy.sessionId);
                    if (!policy.observation && previousObservation) {
                        if (
                            readSessionReconcileRevision(policy.sessionId)
                            !== policyReconcileRevision
                        ) {
                            return;
                        }
                        await releaseFollowSession?.(policy.sessionId)
                            .catch(() => undefined);
                        if (
                            readSessionReconcileRevision(policy.sessionId)
                            !== policyReconcileRevision
                        ) {
                            return;
                        }
                        await params.projection.removeLink(
                            previousObservation.link,
                        ).catch(() => undefined);
                        if (
                            readSessionReconcileRevision(policy.sessionId)
                            !== policyReconcileRevision
                        ) {
                            return;
                        }
                        trackedPolicies.set(policy.sessionId, null);
                        return;
                    }
                    const observeBeforeFollow =
                        policy.observation?.link.changeObservation
                        === 'watch_file_changes';
                    const restoreIsStale = () => (
                        disposed
                        || !online
                        || signal.aborted
                        || generation !== restoreGeneration
                        || readSessionReconcileRevision(policy.sessionId)
                            !== policyReconcileRevision
                        || wasReleasedForRestore(
                            policy.sessionId,
                            restoreGeneration,
                        )
                    );
                    const wasArchived = params.followLeaseManager
                        ?.isSessionSuspended({
                            sessionId: policy.sessionId,
                            reason: 'session_archived',
                        }) === true;
                    if (wasArchived && params.followLeaseManager) {
                        const archived =
                            await params.followLeaseManager.archiveSession({
                                sessionId: policy.sessionId,
                            });
                        if (restoreIsStale()) {
                            await cleanupStaleRestore(
                                policy.sessionId,
                                restoreGeneration,
                            );
                            return;
                        }
                        if (!archived.releaseSettled) return;
                    }
                    if (policy.observation && observeBeforeFollow) {
                        await params.projection.reconcileLink({
                            ...policy.observation,
                            demand: PASSIVE_EVENT_DEMAND,
                        }).catch(() => undefined);
                    }
                    if (restoreIsStale()) {
                        if (policy.observation && observeBeforeFollow) {
                            await params.projection.removeLink(policy.observation.link)
                                .catch(() => undefined);
                        }
                        await cleanupStaleRestore(
                            policy.sessionId,
                            restoreGeneration,
                        );
                        return;
                    }
                    const followEstablished =
                        await restoreFollowPolicy?.(
                            policy.sessionId,
                            signal,
                        ).catch(() => false);
                    if (restoreIsStale()) {
                        if (policy.observation && observeBeforeFollow) {
                            await params.projection.removeLink(policy.observation.link)
                                .catch(() => undefined);
                        }
                        await cleanupStaleRestore(
                            policy.sessionId,
                            restoreGeneration,
                        );
                        return;
                    }
                    if (followEstablished === false) {
                        if (policy.observation && observeBeforeFollow) {
                            await params.projection.removeLink(
                                policy.observation.link,
                            ).catch(() => undefined);
                        }
                        return;
                    }
                    if (policy.observation && !observeBeforeFollow) {
                        await params.projection.reconcileLink({
                            ...policy.observation,
                            demand: PASSIVE_EVENT_DEMAND,
                        }).catch(() => undefined);
                    }
                    if (restoreIsStale()) {
                        if (policy.observation) {
                            await params.projection.removeLink(policy.observation.link)
                                .catch(() => undefined);
                        }
                        await cleanupStaleRestore(
                            policy.sessionId,
                            restoreGeneration,
                        );
                        return;
                    }
                    if (wasArchived) {
                        await params.followLeaseManager?.resumeSession({
                            sessionId: policy.sessionId,
                            reason: 'session_archived',
                        });
                        if (restoreIsStale()) {
                            if (policy.observation) {
                                await params.projection.removeLink(
                                    policy.observation.link,
                                ).catch(() => undefined);
                            }
                            await cleanupStaleRestore(
                                policy.sessionId,
                                restoreGeneration,
                            );
                            return;
                        }
                    }
                    trackedPolicies.set(policy.sessionId, policy.observation);
                }));
            }
        } catch (error) {
            if (!signal.aborted && online && generation === restoreGeneration) {
                logExternalSessionsInternalError(
                    'external_session.passive_observation_startup',
                    error,
                );
            }
        }
    };

    const beginRestore = (): Promise<void> => {
        if (disposed) {
            return Promise.reject(
                new Error('External Session passive observation is disposed'),
            );
        }
        if (!online || !isRestoreEnabled()) {
            return Promise.resolve();
        }
        const restoreGeneration = ++generation;
        const controller = new AbortController();
        activeController = controller;
        const current = restore(restoreGeneration, controller.signal);
        const trackedRestore = current.finally(() => {
            if (activeRestore === trackedRestore) activeRestore = null;
            if (activeController === controller) activeController = null;
        });
        activeRestore = trackedRestore;
        return activeRestore;
    };

    const disableTrackedPolicies = async (): Promise<void> => {
        const tracked = [...trackedPolicies.entries()];
        trackedPolicies.clear();
        await Promise.all(tracked.map(async ([sessionId, observation]) => {
            await removeTrackedPolicy(sessionId, observation, true);
        }));
    };

    const hardReleaseTrackedPolicies = async (): Promise<void> => {
        const tracked = [...trackedPolicies.entries()];
        trackedPolicies.clear();
        await Promise.all(tracked.map(async ([sessionId, observation]) => {
            await releaseFollowSession?.(sessionId).catch(() => undefined);
            if (observation) {
                await params.projection.removeLink(observation.link)
                    .catch(() => undefined);
            }
        }));
    };

    const enqueueLifecycleTransition = <Result>(
        operation: () => Promise<Result>,
    ): Promise<Result> => {
        const transition = lifecycleTransition.then(operation, operation);
        lifecycleTransition = transition.then(
            () => undefined,
            () => undefined,
        );
        return transition;
    };

    const invalidateActiveRestore = (): Readonly<{
        transitionGeneration: number;
        previousRestore: Promise<void> | null;
    }> => {
        const transitionGeneration = ++generation;
        const previousRestore = activeRestore;
        activeController?.abort();
        activeController = null;
        return { transitionGeneration, previousRestore };
    };

    const reconcileSession = (
        sessionId: string,
    ): Promise<ExternalSessionPassiveReconcileResult> => {
        if (disposed) {
            return Promise.reject(
                new Error('External Session passive observation is disposed'),
            );
        }
        if (!online || !isRestoreEnabled()) {
            return Promise.resolve({ status: 'stale' });
        }
        const reconcileRevision = invalidateSessionReconcile(sessionId);
        const reconcileGeneration = generation;
        const reconcileAccountScopeKey = observedAccountScopeKey;
        const previousRestore = activeRestore;
        releasedAtGenerationBySessionId.delete(sessionId);
        return enqueueLifecycleTransition(async () => {
            await previousRestore?.catch(() => undefined);
            const isStale = (): boolean => (
                disposed
                || !online
                || !isRestoreEnabled()
                || generation !== reconcileGeneration
                || observedAccountScopeKey !== reconcileAccountScopeKey
                || readSessionReconcileRevision(sessionId) !== reconcileRevision
            );
            if (isStale()) return { status: 'stale' };

            const controller = new AbortController();
            activeController = controller;
            try {
                const current = await loadCurrentSessionPolicy({
                    machineId: params.machineId,
                    sessionId,
                    signal: controller.signal,
                });
                if (controller.signal.aborted || isStale()) {
                    return { status: 'stale' };
                }

                const wasArchived = params.followLeaseManager
                    ?.isSessionSuspended({
                        sessionId,
                        reason: 'session_archived',
                    }) === true;
                if (current.state === 'unavailable') {
                    return { status: 'unavailable' };
                }

                if (current.state === 'archived') {
                    releasedAtGenerationBySessionId.set(
                        sessionId,
                        reconcileGeneration,
                    );
                    const releaseSettled = await releaseArchivedSessionNow(
                        sessionId,
                        current.backgroundFollow,
                    );
                    if (!current.backgroundFollow) {
                        await disableFollowPolicy?.(sessionId);
                    }
                    if (controller.signal.aborted || isStale()) {
                        return { status: 'stale' };
                    }
                    return {
                        status: releaseSettled
                            ? 'settled'
                            : 'unavailable',
                    };
                }

                if (
                    current.state === 'disabled'
                    || current.state === 'missing'
                ) {
                    let archiveReleaseSettled = true;
                    if (wasArchived && params.followLeaseManager) {
                        const archived =
                            await params.followLeaseManager.archiveSession({
                                sessionId,
                        });
                        archiveReleaseSettled = archived.releaseSettled;
                    }
                    if (controller.signal.aborted || isStale()) {
                        return { status: 'stale' };
                    }
                    await removeTrackedPassivePolicyStrict(sessionId, true);
                    if (controller.signal.aborted || isStale()) {
                        return { status: 'stale' };
                    }
                    if (
                        !archiveReleaseSettled
                        && params.followLeaseManager
                        ?.hasBackgroundFollowLease(sessionId)
                    ) {
                        return { status: 'unavailable' };
                    }
                    await params.followLeaseManager?.resumeSession({
                        sessionId,
                        reason: 'session_archived',
                    });
                    return controller.signal.aborted || isStale()
                        ? { status: 'stale' }
                        : { status: 'settled' };
                }

                if (wasArchived && params.followLeaseManager) {
                    const archived =
                        await params.followLeaseManager.archiveSession({
                            sessionId,
                        });
                    if (
                        controller.signal.aborted
                        || isStale()
                        || !archived.releaseSettled
                    ) {
                        return controller.signal.aborted || isStale()
                            ? { status: 'stale' }
                            : { status: 'unavailable' };
                    }
                }
                const observation = current.observation;
                const observeBeforeFollow =
                    observation.link.changeObservation
                    === 'watch_file_changes';
                if (observeBeforeFollow) {
                    await params.projection.reconcileLink({
                        ...observation,
                        demand: PASSIVE_EVENT_DEMAND,
                    });
                }
                if (controller.signal.aborted || isStale()) {
                    if (observeBeforeFollow) {
                        await params.projection.removeLink(observation.link)
                            .catch(() => undefined);
                    }
                    await cleanupStaleRestore(
                        sessionId,
                        reconcileGeneration,
                    );
                    return { status: 'stale' };
                }

                const followEstablished =
                    await restoreFollowPolicy?.(sessionId, controller.signal);
                if (controller.signal.aborted || isStale()) {
                    if (observeBeforeFollow) {
                        await params.projection.removeLink(observation.link)
                            .catch(() => undefined);
                    }
                    await cleanupStaleRestore(
                        sessionId,
                        reconcileGeneration,
                    );
                    return { status: 'stale' };
                }
                if (followEstablished === false) {
                    if (observeBeforeFollow) {
                        await params.projection.removeLink(observation.link)
                            .catch(() => undefined);
                    }
                    return { status: 'unavailable' };
                }

                if (!observeBeforeFollow) {
                    await params.projection.reconcileLink({
                        ...observation,
                        demand: PASSIVE_EVENT_DEMAND,
                    });
                }
                if (controller.signal.aborted || isStale()) {
                    await params.projection.removeLink(observation.link)
                        .catch(() => undefined);
                    await cleanupStaleRestore(
                        sessionId,
                        reconcileGeneration,
                    );
                    return { status: 'stale' };
                }

                await params.followLeaseManager?.resumeSession({
                    sessionId,
                    reason: 'session_archived',
                });
                if (controller.signal.aborted || isStale()) {
                    await params.projection.removeLink(observation.link)
                        .catch(() => undefined);
                    await cleanupStaleRestore(
                        sessionId,
                        reconcileGeneration,
                    );
                    return { status: 'stale' };
                }
                trackedPolicies.set(sessionId, observation);
                return { status: 'settled' };
            } finally {
                if (activeController === controller) {
                    activeController = null;
                }
            }
        });
    };

    const resume = async (): Promise<void> => {
        if (disposed) {
            throw new Error('External Session passive observation is disposed');
        }
        if (online) {
            await activeRestore;
            return;
        }
        online = true;
        if (!isRestoreEnabled()) {
            disabledThroughGeneration = generation;
            await disableTrackedPolicies();
            return;
        }
        await beginRestore();
    };

    const pause = async (): Promise<void> => {
        if (disposed || !online) return;
        online = false;
        generation += 1;
        activeController?.abort();
        activeController = null;
        const tracked = [...trackedPolicies.entries()];
        await Promise.all(tracked.map(async ([sessionId, observation]) => {
            await removeTrackedPolicy(sessionId, observation, false);
        }));
    };

    const applyRestoreSettingChange = (): Promise<void> => {
        if (disposed) return Promise.resolve();
        const {
            transitionGeneration,
            previousRestore,
        } = invalidateActiveRestore();
        const restoreEnabled = isRestoreEnabled();
        if (!restoreEnabled) {
            disabledThroughGeneration = transitionGeneration;
        }
        return enqueueLifecycleTransition(async () => {
            await previousRestore?.catch(() => undefined);
            if (
                disposed
                || !online
                || generation !== transitionGeneration
            ) {
                return;
            }
            if (restoreEnabled) {
                await beginRestore();
                return;
            }
            await disableTrackedPolicies();
        });
    };

    const applyAccountScopeRotation = (): Promise<void> => {
        if (disposed) return Promise.resolve();
        const {
            transitionGeneration,
            previousRestore,
        } = invalidateActiveRestore();
        hardReleasedThroughGeneration = Math.max(
            hardReleasedThroughGeneration,
            transitionGeneration,
        );
        return enqueueLifecycleTransition(async () => {
            await previousRestore?.catch(() => undefined);
            await hardReleaseTrackedPolicies();
            if (
                disposed
                || !online
                || generation !== transitionGeneration
            ) {
                return;
            }
            if (!isRestoreEnabled()) {
                disabledThroughGeneration = transitionGeneration;
                return;
            }
            await beginRestore();
        });
    };
    const applyConnectedAccountInvalidation = (): Promise<void> => {
        if (disposed) return Promise.resolve();
        const {
            transitionGeneration,
            previousRestore,
        } = invalidateActiveRestore();
        hardReleasedThroughGeneration = Math.max(
            hardReleasedThroughGeneration,
            transitionGeneration,
        );
        return enqueueLifecycleTransition(async () => {
            await previousRestore?.catch(() => undefined);
            await hardReleaseTrackedPolicies();
            await params.followLeaseManager
                ?.releaseSessionsForCredentialInvalidation();
            if (
                disposed
                || !online
                || generation !== transitionGeneration
            ) {
                return;
            }
            await params.reconcileSharedCredentialDemand?.();
            if (
                disposed
                || !online
                || generation !== transitionGeneration
            ) {
                return;
            }
            if (!isRestoreEnabled()) {
                disabledThroughGeneration = transitionGeneration;
                return;
            }
            await beginRestore();
        });
    };
    const unsubscribeRestoreEnabled = (
        params.subscribeRestoreEnabled
        ?? ((listener: () => void) => subscribeActiveAccountSettingsSnapshot(
            () => listener(),
        ))
    )(() => {
        const nextRestoreEnabled = isRestoreEnabled();
        const nextAccountScopeKey = readPassiveRestoreAccountScopeKey();
        if (
            nextRestoreEnabled === observedRestoreEnabled
            && nextAccountScopeKey === observedAccountScopeKey
        ) {
            return;
        }
        const accountScopeChanged =
            nextAccountScopeKey !== observedAccountScopeKey;
        observedRestoreEnabled = nextRestoreEnabled;
        observedAccountScopeKey = nextAccountScopeKey;
        const reconcile = accountScopeChanged
            ? applyAccountScopeRotation
            : applyRestoreSettingChange;
        void reconcile().catch((error) => {
            logExternalSessionsInternalError(
                'external_session.passive_restore_settings_reconcile',
                error,
            );
        });
    });
    const unsubscribeRuntimeReload = (
        params.subscribeRuntimeReload
        ?? ((listener: () => void) => pluginReloadController.subscribe(
            () => listener(),
        ))
    )(() => {
        if (disposed || !online || !isRestoreEnabled()) return;
        const {
            transitionGeneration: reloadGeneration,
            previousRestore,
        } = invalidateActiveRestore();
        void enqueueLifecycleTransition(async () => {
            await previousRestore?.catch(() => undefined);
            if (
                disposed
                || !online
                || !isRestoreEnabled()
                || generation !== reloadGeneration
            ) {
                return;
            }
            await beginRestore();
        }).catch((error) => {
            logExternalSessionsInternalError(
                'external_session.passive_runtime_reload_reconcile',
                error,
            );
        });
    });
    const unsubscribeConnectedAccountInvalidations =
        params.subscribeConnectedAccountInvalidations?.(() => {
            void applyConnectedAccountInvalidation().catch((error) => {
                logExternalSessionsInternalError(
                    'external_session.connected_account_invalidation_reconcile',
                    error,
                );
            });
        }) ?? (() => {});

    const ready = params.startPaused === true ? Promise.resolve() : resume();

    return {
        ready,
        pause,
        resume,
        reconcileSession,
        async releaseSession(sessionId: string): Promise<void> {
            invalidateSessionReconcile(sessionId);
            releasedAtGenerationBySessionId.set(sessionId, generation);
            await releaseArchivedSessionNow(sessionId);
        },
        async dispose(): Promise<void> {
            if (disposed) return;
            await pause();
            disposed = true;
            unsubscribeRestoreEnabled();
            unsubscribeRuntimeReload();
            unsubscribeConnectedAccountInvalidations();
            generation += 1;
            activeController?.abort();
            activeController = null;
            await activeRestore?.catch(() => undefined);
            await lifecycleTransition.catch(() => undefined);
        },
    };
}
