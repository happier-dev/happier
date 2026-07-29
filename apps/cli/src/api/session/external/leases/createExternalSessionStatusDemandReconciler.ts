import {
    ExternalSessionStatusDemandDaemonMessageV1Schema,
    isExternalSessionStatusDemandRevisionNewerV1,
    type ExternalSessionStatusDemandDaemonMessageV1,
    type ExternalSessionStatusDemandLevelV1,
} from '@happier-dev/protocol';

import { computeExponentialBackoffMs } from '@/subprocess/supervision/backoff';

export type ExternalSessionStatusDemandChange = Readonly<{
    sessionId: string;
    linkGeneration: string;
    demand: ExternalSessionStatusDemandLevelV1 | null;
}>;

type DemandedLink = Readonly<{
    sessionId: string;
    linkGeneration: string;
    demand: ExternalSessionStatusDemandLevelV1;
}>;

type ClientDemand = {
    revision: number;
    linksByKey: Map<string, DemandedLink>;
};

type ExternalSessionStatusDemandReconcilerParams = Readonly<{
    isCurrentLink(input: Readonly<{
        sessionId: string;
        linkGeneration: string;
    }>): boolean | Promise<boolean>;
    onDemandChanges(
        changes: readonly ExternalSessionStatusDemandChange[],
    ): void | Promise<void>;
}>;

const DEMAND_PRIORITY = {
    loaded: 0,
    visible: 1,
    open: 2,
} as const satisfies Record<ExternalSessionStatusDemandLevelV1, number>;

const RETRY_BASE_DELAY_MS = 250;
const RETRY_MAX_DELAY_MS = 30_000;

function linkKey(input: Readonly<{ sessionId: string; linkGeneration: string }>): string {
    return JSON.stringify([input.sessionId, input.linkGeneration]);
}

function unionDemand(
    clients: Iterable<ClientDemand>,
): Map<string, DemandedLink> {
    const union = new Map<string, DemandedLink>();
    for (const client of clients) {
        for (const [key, link] of client.linksByKey) {
            const current = union.get(key);
            if (!current || DEMAND_PRIORITY[link.demand] > DEMAND_PRIORITY[current.demand]) {
                union.set(key, link);
            }
        }
    }
    return union;
}

/**
 * Owns connection-scoped fallback-reconciliation demand only.
 *
 * It intentionally has no transcript-follow dependency. The caller combines
 * each emitted fallback level with the canonical observation link's passive
 * and persisted-policy axes before reconciling that link.
 */
export function createExternalSessionStatusDemandReconciler(
    params: ExternalSessionStatusDemandReconcilerParams,
) {
    const clients = new Map<string, ClientDemand>();
    let appliedUnion = new Map<string, DemandedLink>();
    const uncertainLinksByKey = new Map<string, DemandedLink>();
    let disposed = false;
    let pending: Promise<void> = Promise.resolve();
    let retryAttempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let credentialInvalidationPending = false;

    const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
        const result = pending.then(operation);
        pending = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    };

    const unionDiff = (
        previous: Map<string, DemandedLink>,
        next: Map<string, DemandedLink>,
    ): ExternalSessionStatusDemandChange[] => {
        const changes: ExternalSessionStatusDemandChange[] = [];
        const keys = [...new Set([...previous.keys(), ...next.keys()])].sort();
        for (const key of keys) {
            const before = previous.get(key) ?? null;
            const after = next.get(key) ?? null;
            if (before?.demand === after?.demand) continue;
            const identity = after ?? before;
            if (!identity) continue;
            changes.push({
                sessionId: identity.sessionId,
                linkGeneration: identity.linkGeneration,
                demand: after?.demand ?? null,
            });
        }
        return changes;
    };

    const cloneClients = (): Map<string, ClientDemand> => new Map(
        [...clients].map(([clientConnectionId, demand]) => [
            clientConnectionId,
            {
                revision: demand.revision,
                linksByKey: new Map(demand.linksByKey),
            },
        ]),
    );

    const commitClients = (next: Map<string, ClientDemand>): void => {
        clients.clear();
        for (const [clientConnectionId, demand] of next) {
            clients.set(clientConnectionId, demand);
        }
    };

    const cancelScheduledRetry = (): void => {
        if (retryTimer === null) return;
        clearTimeout(retryTimer);
        retryTimer = null;
    };

    const fullReconciliation = (
        desiredUnion: Map<string, DemandedLink>,
    ): ExternalSessionStatusDemandChange[] => {
        const changes: ExternalSessionStatusDemandChange[] = [];
        const keys = [...new Set([
            ...appliedUnion.keys(),
            ...uncertainLinksByKey.keys(),
            ...desiredUnion.keys(),
        ])].sort();
        for (const key of keys) {
            const desired = desiredUnion.get(key) ?? null;
            const identity = desired
                ?? uncertainLinksByKey.get(key)
                ?? appliedUnion.get(key)
                ?? null;
            if (!identity) continue;
            changes.push({
                sessionId: identity.sessionId,
                linkGeneration: identity.linkGeneration,
                demand: desired?.demand ?? null,
            });
        }
        return changes;
    };

    const changesForDesiredUnion = (
        desiredUnion: Map<string, DemandedLink>,
        forceDesired: boolean,
    ): ExternalSessionStatusDemandChange[] => {
        if (uncertainLinksByKey.size > 0) {
            return fullReconciliation(desiredUnion);
        }
        const changes = unionDiff(appliedUnion, desiredUnion);
        if (!forceDesired) return changes;

        const changedKeys = new Set(changes.map(linkKey));
        for (const [key, link] of [...desiredUnion].sort(([a], [b]) => a.localeCompare(b))) {
            if (changedKeys.has(key)) continue;
            changes.push({
                sessionId: link.sessionId,
                linkGeneration: link.linkGeneration,
                demand: link.demand,
            });
        }
        return changes;
    };

    const rememberPossiblyApplied = (
        changes: readonly ExternalSessionStatusDemandChange[],
        desiredUnion: Map<string, DemandedLink>,
    ): void => {
        for (const [key, link] of appliedUnion) {
            uncertainLinksByKey.set(key, link);
        }
        for (const [key, link] of desiredUnion) {
            uncertainLinksByKey.set(key, link);
        }
        for (const change of changes) {
            uncertainLinksByKey.set(linkKey(change), {
                sessionId: change.sessionId,
                linkGeneration: change.linkGeneration,
                demand: change.demand ?? 'loaded',
            });
        }
    };

    let reconcileDesired: (forceDesired?: boolean) => Promise<void>;
    let reconcileCredentialInvalidation: () => Promise<void>;
    let reconcilePendingInvalidationOrDesired:
        (forceDesired?: boolean) => Promise<void>;

    const scheduleRetry = (): void => {
        if (disposed || retryTimer !== null) return;
        retryAttempt += 1;
        const delayMs = computeExponentialBackoffMs({
            attempt: retryAttempt,
            baseDelayMs: RETRY_BASE_DELAY_MS,
            maxDelayMs: RETRY_MAX_DELAY_MS,
        });
        retryTimer = setTimeout(() => {
            retryTimer = null;
            void enqueue(async () => {
                if (disposed) return;
                try {
                    if (credentialInvalidationPending) {
                        await reconcileCredentialInvalidation();
                    } else {
                        await reconcileDesired();
                    }
                } catch {
                    // The selected reconciliation retains desired state and schedules the next retry.
                }
            });
        }, delayMs);
    };

    reconcileDesired = async (forceDesired = false): Promise<void> => {
        const desiredUnion = unionDemand(clients.values());
        const changes = changesForDesiredUnion(desiredUnion, forceDesired);
        if (changes.length === 0) {
            appliedUnion = new Map(desiredUnion);
            uncertainLinksByKey.clear();
            retryAttempt = 0;
            cancelScheduledRetry();
            return;
        }
        try {
            await params.onDemandChanges(changes);
        } catch (error) {
            rememberPossiblyApplied(changes, desiredUnion);
            scheduleRetry();
            throw error;
        }
        appliedUnion = new Map(desiredUnion);
        uncertainLinksByKey.clear();
        retryAttempt = 0;
        cancelScheduledRetry();
    };

    reconcileCredentialInvalidation = async (): Promise<void> => {
        credentialInvalidationPending = true;
        const desiredUnion = unionDemand(clients.values());
        const releases = [...new Map([
            ...appliedUnion,
            ...uncertainLinksByKey,
            ...desiredUnion,
        ]).values()]
            .sort((a, b) => linkKey(a).localeCompare(linkKey(b)))
            .map((link) => ({
                sessionId: link.sessionId,
                linkGeneration: link.linkGeneration,
                demand: null,
            }));
        try {
            if (releases.length > 0) {
                await params.onDemandChanges(releases);
            }
            appliedUnion = new Map();
            uncertainLinksByKey.clear();

            const nextClients = cloneClients();
            for (const client of nextClients.values()) {
                const retained = new Map<string, DemandedLink>();
                for (const [key, link] of client.linksByKey) {
                    if (await params.isCurrentLink(link)) {
                        retained.set(key, link);
                    }
                }
                client.linksByKey = retained;
            }
            commitClients(nextClients);
            await reconcileDesired(true);
            credentialInvalidationPending = false;
        } catch (error) {
            rememberPossiblyApplied(releases, desiredUnion);
            scheduleRetry();
            throw error;
        }
    };
    reconcilePendingInvalidationOrDesired = async (
        forceDesired = false,
    ): Promise<void> => {
        if (credentialInvalidationPending) {
            await reconcileCredentialInvalidation();
            return;
        }
        await reconcileDesired(forceDesired);
    };

    const apply = async (
        message: ExternalSessionStatusDemandDaemonMessageV1,
    ): Promise<
        | Readonly<{ state: 'applied'; admittedEntries: number }>
        | Readonly<{ state: 'stale-revision' }>
        | Readonly<{ state: 'disposed' }>
    > => {
        if (disposed) return { state: 'disposed' };

        if (message.type === 'disconnect') {
            const nextClients = cloneClients();
            nextClients.delete(message.clientConnectionId);
            commitClients(nextClients);
            await reconcilePendingInvalidationOrDesired();
            return { state: 'applied', admittedEntries: 0 };
        }

        const current = clients.get(message.clientConnectionId) ?? null;
        if (!isExternalSessionStatusDemandRevisionNewerV1(
            current?.revision ?? null,
            message.revision,
        )) {
            return { state: 'stale-revision' };
        }

        const linksByKey = new Map<string, DemandedLink>();
        for (const entry of message.entries) {
            const key = linkKey(entry);
            if (!await params.isCurrentLink(entry)) {
                continue;
            }
            linksByKey.set(key, entry);
        }
        const nextClients = cloneClients();
        nextClients.set(message.clientConnectionId, {
            revision: message.revision,
            linksByKey,
        });
        commitClients(nextClients);
        await reconcilePendingInvalidationOrDesired();
        return { state: 'applied', admittedEntries: linksByKey.size };
    };

    return {
        accept(message: unknown): Promise<
            | Readonly<{ state: 'applied'; admittedEntries: number }>
            | Readonly<{ state: 'stale-revision' }>
            | Readonly<{ state: 'invalid-message' }>
            | Readonly<{ state: 'disposed' }>
        > {
            const parsed = ExternalSessionStatusDemandDaemonMessageV1Schema.safeParse(message);
            if (!parsed.success) {
                return Promise.resolve({ state: 'invalid-message' });
            }
            return enqueue(async () => await apply(parsed.data));
        },

        readDemand(input: Readonly<{
            sessionId: string;
            linkGeneration: string;
        }>): ExternalSessionStatusDemandLevelV1 | null {
            return unionDemand(clients.values()).get(linkKey(input))?.demand ?? null;
        },

        async refreshCurrentDemand(): Promise<void> {
            await enqueue(async () => {
                if (disposed) return;
                const nextClients = cloneClients();
                for (const client of nextClients.values()) {
                    const retained = new Map<string, DemandedLink>();
                    for (const [key, link] of client.linksByKey) {
                        if (await params.isCurrentLink(link)) {
                            retained.set(key, link);
                        }
                    }
                    client.linksByKey = retained;
                }
                commitClients(nextClients);
                await reconcilePendingInvalidationOrDesired(true);
            });
        },

        async reconcileCredentialInvalidation(): Promise<void> {
            await enqueue(async () => {
                if (disposed) return;
                await reconcileCredentialInvalidation();
            });
        },

        async clear(): Promise<void> {
            await enqueue(async () => {
                if (disposed) return;
                clients.clear();
                await reconcilePendingInvalidationOrDesired();
            });
        },

        async dispose(): Promise<void> {
            await pending;
            if (disposed) return;
            cancelScheduledRetry();
            clients.clear();
            await reconcilePendingInvalidationOrDesired();
            disposed = true;
        },
    };
}
