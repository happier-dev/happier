import {
    PluginDomainChangeEntrySchema,
    type ChangeEntry,
} from '@happier-dev/protocol/changes';

export type PluginAccountSettingsWatchInvalidation =
    | Readonly<{
        kind: 'record';
        pluginId: string;
        revision: number;
    }>
    | Readonly<{ kind: 'full' }>;

const listeners = new Set<(invalidation: PluginAccountSettingsWatchInvalidation) => void>();

/**
 * Collection watchers consume the same canonical AccountChange cursor as
 * Settings. They receive only a qualified wake-up and re-read through the
 * authenticated Data client; rows and private payloads never cross this
 * process-local fan-out.
 */
type PluginAccountCollectionWatchExactChangeHint = Readonly<{
    kind: 'collection';
    pluginId: string;
    collectionId: string;
    contractDigest: string;
    full?: never;
    changeCursor: number;
}>;

/**
 * A full Collection hint is durable at plugin/collection identity, not at a
 * particular retained contract. The broker reprojects it to each subscriber
 * so existing contract-specific consumers still re-read their own contract.
 */
type PluginAccountCollectionWatchFullChangeHint = Readonly<{
    kind: 'collection';
    pluginId: string;
    collectionId: string;
    contractDigest: string;
    full: true;
    changeCursor: number;
}>;

type PluginAccountCollectionWatchResetChangeHint = Readonly<{
    kind: 'reset';
    /** The canonical AccountChange cursor at which re-query became mandatory. */
    changeCursor: number;
}>;

type PluginAccountCollectionWatchChangeHint =
    | PluginAccountCollectionWatchExactChangeHint
    | PluginAccountCollectionWatchFullChangeHint
    | PluginAccountCollectionWatchResetChangeHint;

type PluginAccountCollectionWatchScope = Readonly<{
    /** Canonical active-Account lifetime identity; never a raw credential. */
    accountScopeKey: string;
}>;

type PluginAccountCollectionWatchExactInvalidation =
    PluginAccountCollectionWatchExactChangeHint & PluginAccountCollectionWatchScope;
type PluginAccountCollectionWatchFullInvalidation =
    PluginAccountCollectionWatchFullChangeHint & PluginAccountCollectionWatchScope;
type PluginAccountCollectionWatchResetInvalidation =
    PluginAccountCollectionWatchResetChangeHint & PluginAccountCollectionWatchScope;

export type PluginAccountCollectionWatchInvalidation =
    | PluginAccountCollectionWatchExactInvalidation
    | PluginAccountCollectionWatchFullInvalidation
    | PluginAccountCollectionWatchResetInvalidation;

export type PluginAccountCollectionWatchSubscription = Readonly<{
    /** Must match the publisher's canonical active-Account lifetime identity. */
    accountScopeKey: string;
    pluginId: string;
    collectionId: string;
    contractDigest: string;
    /**
     * The cursor returned by the initial authenticated query. The broker uses
     * it only to coalesce a change that arrived before local registration.
     */
    startingCursor?: number;
}>;

type PluginAccountCollectionWatchListener = (
    invalidation: PluginAccountCollectionWatchInvalidation,
) => void;

type PluginAccountCollectionWatchListenerRegistration = {
    subscription: PluginAccountCollectionWatchSubscription;
    listener: PluginAccountCollectionWatchListener;
    lastObservedCursor: number | null;
    pending: PluginAccountCollectionWatchInvalidation | null;
    scheduled: boolean;
};

const collectionListeners = new Set<PluginAccountCollectionWatchListenerRegistration>();
type PluginAccountCollectionWatchState = {
    latestInvalidations: Map<string, PluginAccountCollectionWatchExactInvalidation>;
    latestFullInvalidations: Map<string, PluginAccountCollectionWatchFullInvalidation>;
    latestResetCursor: number | null;
};

const collectionWatchStateByAccountScopeKey = new Map<string, PluginAccountCollectionWatchState>();

function collectionWatchState(accountScopeKey: string): PluginAccountCollectionWatchState {
    let state = collectionWatchStateByAccountScopeKey.get(accountScopeKey);
    if (!state) {
        state = {
            latestInvalidations: new Map(),
            latestFullInvalidations: new Map(),
            latestResetCursor: null,
        };
        collectionWatchStateByAccountScopeKey.set(accountScopeKey, state);
    }
    return state;
}

function collectionWatchKey(input: Readonly<{
    pluginId: string;
    collectionId: string;
    contractDigest: string;
}>): string {
    return `${input.pluginId}\u0000${input.collectionId}\u0000${input.contractDigest}`;
}

function collectionWatchIdentityKey(input: Readonly<{
    pluginId: string;
    collectionId: string;
}>): string {
    return `${input.pluginId}\u0000${input.collectionId}`;
}

function projectFullCollectionInvalidationForSubscription(
    invalidation: PluginAccountCollectionWatchFullInvalidation,
    subscription: PluginAccountCollectionWatchSubscription,
): PluginAccountCollectionWatchFullInvalidation {
    return Object.freeze({
        ...invalidation,
        contractDigest: subscription.contractDigest,
    });
}

function invokeCollectionListener(
    listener: PluginAccountCollectionWatchListener,
    invalidation: PluginAccountCollectionWatchInvalidation,
): void {
    try {
        listener(invalidation);
    } catch {
        // A watcher can re-read later; it cannot obstruct the one Account
        // cursor consumer that owns Data convergence.
    }
}

function coalesceCollectionInvalidation(
    pending: PluginAccountCollectionWatchInvalidation | null,
    next: PluginAccountCollectionWatchInvalidation,
): PluginAccountCollectionWatchInvalidation {
    if (!pending) return next;
    // A reset is an authoritative cursor-domain rebase, not an ordinary
    // high-water event. It therefore replaces older pending work and is not
    // advanced by a following exact hint from the newly rebased domain.
    if (next.kind === 'reset') return next;
    if (pending.kind === 'reset') return pending;
    return pending.changeCursor >= next.changeCursor ? pending : next;
}

function scheduleCollectionListener(
    registration: PluginAccountCollectionWatchListenerRegistration,
    invalidation: PluginAccountCollectionWatchInvalidation,
): void {
    if (!collectionListeners.has(registration)) return;
    if (invalidation.kind === 'reset') {
        // Cursor-gone is authoritative even when a restore or rollback moves
        // the current cursor below this process's previously observed value.
        // Replace any pending old-domain hint before the coalesced wake-up.
        registration.lastObservedCursor = invalidation.changeCursor;
        registration.pending = invalidation;
        if (registration.scheduled) return;
        registration.scheduled = true;
        queueMicrotask(() => {
            registration.scheduled = false;
            const pending = registration.pending;
            registration.pending = null;
            if (!pending || !collectionListeners.has(registration)) return;
            invokeCollectionListener(registration.listener, pending);
        });
        return;
    }
    if (
        registration.lastObservedCursor !== null
        && invalidation.changeCursor <= registration.lastObservedCursor
    ) {
        return;
    }
    registration.lastObservedCursor = invalidation.changeCursor;
    registration.pending = coalesceCollectionInvalidation(registration.pending, invalidation);
    if (registration.scheduled) return;
    registration.scheduled = true;
    queueMicrotask(() => {
        registration.scheduled = false;
        const pending = registration.pending;
        registration.pending = null;
        if (!pending || !collectionListeners.has(registration)) return;
        invokeCollectionListener(registration.listener, pending);
    });
}

/**
 * This is the existing process-local Settings watch wake-up, extended only
 * with the closed AccountChange.settings arm. It transports no values and is
 * not a second cursor or cross-domain plugin event bus.
 */
export function publishPluginAccountSettingsWatchInvalidation(
    invalidation: PluginAccountSettingsWatchInvalidation,
): void {
    for (const listener of listeners) {
        try {
            listener(invalidation);
        } catch {
            // A watcher can re-read later; one local listener cannot block the
            // canonical /v2/changes cursor consumer.
        }
    }
}

export function subscribePluginAccountSettingsWatchInvalidation(
    listener: (invalidation: PluginAccountSettingsWatchInvalidation) => void,
): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function publishPluginAccountCollectionWatchInvalidation(
    invalidation: PluginAccountCollectionWatchInvalidation,
): void {
    const state = collectionWatchState(invalidation.accountScopeKey);
    if (invalidation.kind === 'reset') {
        // `/v2/changes` cursor-gone supplies the current authoritative cursor.
        // It may be lower after a restore/rebase, so replace rather than take a
        // maximum and drop exact hints from the former cursor domain.
        state.latestResetCursor = invalidation.changeCursor;
        state.latestInvalidations.clear();
        state.latestFullInvalidations.clear();
        for (const registration of collectionListeners) {
            if (registration.subscription.accountScopeKey === invalidation.accountScopeKey) {
                scheduleCollectionListener(registration, invalidation);
            }
        }
        return;
    }

    if (
        state.latestResetCursor !== null
        && invalidation.changeCursor <= state.latestResetCursor
    ) {
        return;
    }
    if (invalidation.full === true) {
        const key = collectionWatchIdentityKey(invalidation);
        const previous = state.latestFullInvalidations.get(key);
        if (!previous || invalidation.changeCursor > previous.changeCursor) {
            state.latestFullInvalidations.set(key, invalidation);
        }
    } else {
        const key = collectionWatchKey(invalidation);
        const previous = state.latestInvalidations.get(key);
        if (!previous || invalidation.changeCursor > previous.changeCursor) {
            state.latestInvalidations.set(key, invalidation);
        }
    }
    for (const registration of collectionListeners) {
        const subscription = registration.subscription;
        if (
            subscription.accountScopeKey === invalidation.accountScopeKey
            &&
            subscription.pluginId === invalidation.pluginId
            && subscription.collectionId === invalidation.collectionId
        ) {
            if (invalidation.full === true) {
                scheduleCollectionListener(
                    registration,
                    projectFullCollectionInvalidationForSubscription(
                        invalidation,
                        subscription,
                    ),
                );
            } else if (subscription.contractDigest === invalidation.contractDigest) {
                scheduleCollectionListener(registration, invalidation);
            }
        }
    }
}

/**
 * End one canonical authenticated Account lifetime. A later Account lifetime
 * may create fresh state for the same scope identity, but it must not inherit
 * a retained cursor or a queued callback from this retired runtime.
 */
export function retirePluginAccountCollectionWatchScope(accountScopeKey: string): void {
    collectionWatchStateByAccountScopeKey.delete(accountScopeKey);
    for (const registration of collectionListeners) {
        if (registration.subscription.accountScopeKey !== accountScopeKey) continue;
        collectionListeners.delete(registration);
        registration.pending = null;
    }
}

export function subscribePluginAccountCollectionWatchInvalidation(
    subscription: PluginAccountCollectionWatchSubscription,
    listener: PluginAccountCollectionWatchListener,
): () => void {
    const registration: PluginAccountCollectionWatchListenerRegistration = {
        subscription,
        listener,
        lastObservedCursor: subscription.startingCursor ?? null,
        pending: null,
        scheduled: false,
    };
    collectionListeners.add(registration);

    if (subscription.startingCursor !== undefined) {
        const state = collectionWatchStateByAccountScopeKey.get(subscription.accountScopeKey);
        if (
            state
            && state.latestResetCursor !== null
            && state.latestResetCursor > subscription.startingCursor
        ) {
            scheduleCollectionListener(registration, Object.freeze({
                kind: 'reset' as const,
                accountScopeKey: subscription.accountScopeKey,
                changeCursor: state.latestResetCursor,
            }));
        } else {
            const latestExact = state?.latestInvalidations.get(
                collectionWatchKey(subscription),
            );
            const latestFull = state?.latestFullInvalidations.get(
                collectionWatchIdentityKey(subscription),
            );
            const latest = (
                latestFull
                && (!latestExact || latestFull.changeCursor >= latestExact.changeCursor)
            )
                ? projectFullCollectionInvalidationForSubscription(
                    latestFull,
                    subscription,
                )
                : latestExact;
            if (latest && latest.changeCursor > subscription.startingCursor) {
                scheduleCollectionListener(registration, latest);
            }
        }
    }
    return () => {
        collectionListeners.delete(registration);
        registration.pending = null;
    };
}

/** Parse only the strict AccountChange arm that this Settings owner consumes. */
export function readPluginAccountSettingsWatchInvalidations(
    changes: readonly ChangeEntry[],
): readonly PluginAccountSettingsWatchInvalidation[] {
    const invalidations: PluginAccountSettingsWatchInvalidation[] = [];
    for (const change of changes) {
        const parsed = PluginDomainChangeEntrySchema.safeParse(change);
        if (!parsed.success || parsed.data.hint.pluginDomain !== 'settings') continue;
        invalidations.push(Object.freeze({
            kind: 'record',
            pluginId: parsed.data.hint.pluginId,
            revision: parsed.data.hint.revision,
        }));
    }
    return Object.freeze(invalidations);
}

/** Parse only the strict Data Collection AccountChange arm for local wake-ups. */
export function readPluginAccountCollectionWatchInvalidations(
    changes: readonly ChangeEntry[],
): readonly PluginAccountCollectionWatchChangeHint[] {
    const invalidations: PluginAccountCollectionWatchChangeHint[] = [];
    for (const change of changes) {
        const parsed = PluginDomainChangeEntrySchema.safeParse(change);
        if (!parsed.success || parsed.data.hint.pluginDomain !== 'dataCollection') continue;
        if ('full' in parsed.data.hint && parsed.data.hint.full === true) {
            invalidations.push(Object.freeze({
                kind: 'collection',
                pluginId: parsed.data.hint.pluginId,
                collectionId: parsed.data.hint.collectionId,
                contractDigest: parsed.data.hint.contractDigest,
                full: true as const,
                changeCursor: parsed.data.cursor,
            }));
        } else {
            invalidations.push(Object.freeze({
                kind: 'collection',
                pluginId: parsed.data.hint.pluginId,
                collectionId: parsed.data.hint.collectionId,
                contractDigest: parsed.data.hint.contractDigest,
                changeCursor: parsed.data.cursor,
            }));
        }
    }
    return Object.freeze(invalidations);
}
