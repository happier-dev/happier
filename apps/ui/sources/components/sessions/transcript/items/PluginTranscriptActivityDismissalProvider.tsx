import * as React from 'react';

import { storage } from '@/sync/domains/state/storage';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

const EMPTY_DISMISSED_ACTIVITY_IDS: ReadonlySet<string> = new Set();

type DismissalBinding = Readonly<{
    accountLifetime: ActiveServerAccountScopeLifetime;
    sessionId: string;
    machineId: string;
    serverId: string | null;
    generation: string;
}>;

type DismissalEntry = {
    readonly sessionId: string;
    readonly machineId: string;
    readonly serverId: string | null;
    readonly generation: string;
    dismissedActivityIds: ReadonlySet<string>;
    /** Each dismissal belongs to one authoritative Activity Resource source. */
    dismissedSourceKeyByActivityId: ReadonlyMap<string, string>;
    readonly listeners: Set<() => void>;
    disposed: boolean;
    consumers: number;
};

type AccountEntries = {
    entries: Map<string, DismissalEntry>;
    retirement: Readonly<{ dispose(): void }> | null;
};

type DismissalLease = Readonly<{
    bindingKey: string;
    getSnapshot(): ReadonlySet<string>;
    subscribe(listener: () => void): () => void;
    dismiss(identityKey: string, sourceKey: string): void;
    /** A valid snapshot omitting an Activity revokes only that source's dismissal. */
    reconcileSource(sourceKey: string, activeIdentityKeys: ReadonlySet<string>): void;
    /** Permanent Session/generation retirement, not ordinary consumer release. */
    retire(): void;
    dispose(): void;
}>;

type PluginTranscriptActivityDismissalOwner = Readonly<{
    acquire(binding: DismissalBinding): DismissalLease | null;
    dispose(): void;
}>;

function bindingKey(binding: Omit<DismissalBinding, 'accountLifetime'>): string {
    return JSON.stringify([
        binding.sessionId,
        binding.machineId,
        binding.serverId,
        binding.generation,
    ]);
}

function createDismissalOwner(): PluginTranscriptActivityDismissalOwner {
    // Dismissal is intentionally UI-only, but duplicate mounts of one live
    // Session card must observe one decision. Exact lifetime identity prevents
    // an Account replacement from borrowing that ephemeral state.
    const entriesByAccountLifetime = new Map<ActiveServerAccountScopeLifetime, AccountEntries>();
    let disposed = false;

    const notify = (entry: DismissalEntry): void => {
        for (const listener of [...entry.listeners]) listener();
    };
    const disposeEntry = (entry: DismissalEntry): void => {
        if (entry.disposed) return;
        entry.disposed = true;
        entry.listeners.clear();
        entry.dismissedActivityIds = EMPTY_DISMISSED_ACTIVITY_IDS;
        entry.dismissedSourceKeyByActivityId = new Map();
        entry.consumers = 0;
    };
    // A dismissed binding is intentionally dormant across route navigation so
    // A → B → A preserves the user's decision while Session A remains live.
    // Its lifetime is nevertheless bounded by the canonical Session deletion,
    // generation retirement, and Account retirement owners below; this is not
    // an arbitrary count or time-based cache.
    // Session deletion is owned by the sessions store, not by route mounts.
    // Observe that canonical fact so a dismissed entry cannot survive after
    // its last transcript consumer unmounts before the Session is deleted.
    const unsubscribeSessionRetirement = storage.subscribe((state) => {
        for (const accountEntries of entriesByAccountLifetime.values()) {
            for (const [key, entry] of accountEntries.entries) {
                if (!state.deletedSessionIds[entry.sessionId]) continue;
                disposeEntry(entry);
                accountEntries.entries.delete(key);
            }
        }
    });

    return Object.freeze({
        acquire(binding) {
            if (
                disposed
                || !binding.accountLifetime.isCurrent()
                || storage.getState().deletedSessionIds[binding.sessionId] === true
            ) return null;

            const key = bindingKey(binding);
            let accountEntries = entriesByAccountLifetime.get(binding.accountLifetime);
            if (!accountEntries) {
                accountEntries = { entries: new Map(), retirement: null };
                const capturedAccountEntries = accountEntries;
                accountEntries.retirement = binding.accountLifetime.onRetire(() => {
                    for (const entry of capturedAccountEntries.entries.values()) disposeEntry(entry);
                    capturedAccountEntries.entries.clear();
                    entriesByAccountLifetime.delete(binding.accountLifetime);
                });
                entriesByAccountLifetime.set(binding.accountLifetime, accountEntries);
            }
            const entries = accountEntries.entries;
            // A generation replacement can happen while this Session is not
            // mounted. Retire its dormant prior-generation presentation state
            // when the canonical replacement is next acquired.
            for (const [oldKey, oldEntry] of entries) {
                if (
                    oldEntry.consumers === 0
                    && oldEntry.sessionId === binding.sessionId
                    && oldEntry.machineId === binding.machineId
                    && oldEntry.serverId === binding.serverId
                    && oldEntry.generation !== binding.generation
                ) {
                    disposeEntry(oldEntry);
                    entries.delete(oldKey);
                }
            }
            let entry = entries.get(key);
            if (!entry || entry.disposed) {
                entry = {
                    sessionId: binding.sessionId,
                    machineId: binding.machineId,
                    serverId: binding.serverId,
                    generation: binding.generation,
                    dismissedActivityIds: EMPTY_DISMISSED_ACTIVITY_IDS,
                    dismissedSourceKeyByActivityId: new Map(),
                    listeners: new Set(),
                    disposed: false,
                    consumers: 0,
                };
                entries.set(key, entry);
            }
            entry.consumers += 1;

            let released = false;
            return Object.freeze({
                bindingKey: key,
                getSnapshot: () => entry!.dismissedActivityIds,
                subscribe(listener) {
                    entry!.listeners.add(listener);
                    return () => entry!.listeners.delete(listener);
                },
                dismiss(identityKey, sourceKey) {
                    if (entry!.disposed || entry!.dismissedActivityIds.has(identityKey)) return;
                    entry!.dismissedActivityIds = new Set([
                        ...entry!.dismissedActivityIds,
                        identityKey,
                    ]);
                    entry!.dismissedSourceKeyByActivityId = new Map([
                        ...entry!.dismissedSourceKeyByActivityId,
                        [identityKey, sourceKey],
                    ]);
                    notify(entry!);
                },
                reconcileSource(sourceKey, activeIdentityKeys) {
                    if (entry!.disposed || entry!.dismissedActivityIds.size === 0) return;
                    const removedIds = [...entry!.dismissedActivityIds].filter((identityKey) => (
                        entry!.dismissedSourceKeyByActivityId.get(identityKey) === sourceKey
                        && !activeIdentityKeys.has(identityKey)
                    ));
                    if (removedIds.length === 0) return;
                    const removed = new Set(removedIds);
                    entry!.dismissedActivityIds = new Set(
                        [...entry!.dismissedActivityIds].filter((identityKey) => !removed.has(identityKey)),
                    );
                    entry!.dismissedSourceKeyByActivityId = new Map(
                        [...entry!.dismissedSourceKeyByActivityId].filter(([identityKey]) => !removed.has(identityKey)),
                    );
                    notify(entry!);
                },
                retire() {
                    if (entry!.disposed) return;
                    disposeEntry(entry!);
                    if (entries!.get(key) === entry) entries!.delete(key);
                },
                dispose(): void {
                    if (released) return;
                    released = true;
                    entry!.consumers = Math.max(0, entry!.consumers - 1);
                    // Empty bindings have no presentation state worth
                    // retaining. Dismissed bindings remain available for the
                    // approved A → B → A continuity until account/generation
                    // retirement.
                    if (entry!.consumers === 0 && entry!.dismissedActivityIds.size === 0) {
                        disposeEntry(entry!);
                        if (entries.get(key) === entry) entries.delete(key);
                    }
                },
            });
        },
        dispose(): void {
            if (disposed) return;
            disposed = true;
            unsubscribeSessionRetirement();
            for (const accountEntries of entriesByAccountLifetime.values()) {
                accountEntries.retirement?.dispose();
                accountEntries.retirement = null;
                for (const entry of accountEntries.entries.values()) disposeEntry(entry);
                accountEntries.entries.clear();
            }
            entriesByAccountLifetime.clear();
        },
    });
}

const PluginTranscriptActivityDismissalContext = React.createContext<PluginTranscriptActivityDismissalOwner | null>(null);

/** Provider-local UI state; it never writes, acknowledges or owns a Resource. */
export function PluginTranscriptActivityDismissalProvider(props: Readonly<{
    children: React.ReactNode;
}>): React.ReactElement {
    const ownerRef = React.useRef<PluginTranscriptActivityDismissalOwner | null>(null);
    const trueUnmountIntentRef = React.useRef(false);
    if (ownerRef.current === null) ownerRef.current = createDismissalOwner();

    // The provider must survive StrictMode's effect replay with the same owner
    // refs intact, but still dispose every remaining UI-only lease on a true
    // app-root unmount.
    React.useInsertionEffect(() => {
        trueUnmountIntentRef.current = false;
        return () => {
            trueUnmountIntentRef.current = true;
        };
    }, []);
    React.useLayoutEffect(() => () => {
        if (!trueUnmountIntentRef.current) return;
        ownerRef.current?.dispose();
    }, []);

    return (
        <PluginTranscriptActivityDismissalContext.Provider value={ownerRef.current}>
            {props.children}
        </PluginTranscriptActivityDismissalContext.Provider>
    );
}

export function usePluginTranscriptActivityDismissal(input: Readonly<{
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    sessionId: string;
    machineId: string | null;
    serverId: string | null;
    generation: string | null;
    /** The canonical permanent Session-removal fact, never route navigation. */
    sessionRemoved?: boolean;
}>): Readonly<{
    dismissedActivityIds: ReadonlySet<string>;
    dismissActivity(identityKey: string, sourceKey: string): void;
    reconcileActivitySource(sourceKey: string, activeIdentityKeys: ReadonlySet<string>): void;
}> {
    const owner = React.useContext(PluginTranscriptActivityDismissalContext);
    const targetBindingKey = !input.sessionRemoved && input.accountLifetime?.isCurrent() && input.machineId && input.generation
        ? bindingKey({
            sessionId: input.sessionId,
            machineId: input.machineId,
            serverId: input.serverId,
            generation: input.generation,
        })
        : null;
    const [lease, setLease] = React.useState<DismissalLease | null>(null);
    const currentInputRef = React.useRef(input);
    currentInputRef.current = input;

    React.useEffect(() => {
        const nextLease = (
            owner
            && input.accountLifetime
            && input.machineId
            && input.generation
            && !input.sessionRemoved
        )
            ? owner.acquire({
                accountLifetime: input.accountLifetime,
                sessionId: input.sessionId,
                machineId: input.machineId,
                serverId: input.serverId,
                generation: input.generation,
            })
            : null;
        setLease(nextLease);
        return () => {
            if (!nextLease) return;
            const current = currentInputRef.current;
            const generationRetired = current.accountLifetime === input.accountLifetime
                && current.sessionId === input.sessionId
                && current.machineId === input.machineId
                && current.serverId === input.serverId
                && current.generation !== input.generation;
            if (
                (current.sessionId === input.sessionId && current.sessionRemoved === true)
                || generationRetired
            ) {
                nextLease.retire();
            } else {
                nextLease.dispose();
            }
        };
    }, [
        input.accountLifetime,
        input.generation,
        input.machineId,
        input.serverId,
        input.sessionRemoved,
        input.sessionId,
        owner,
    ]);

    // A previous lease must not leak a dismissal into a replacement binding
    // during the effect handoff; missing ownership deliberately paints nothing.
    const activeLease = lease?.bindingKey === targetBindingKey ? lease : null;
    // Resource subscriptions establish before the lease state effect commits.
    // Keep the reconciliation capability stable so that handoff does not
    // recreate those canonical Resource subscriptions, while still routing a
    // later valid snapshot to the current exact dismissal lease.
    const activeLeaseRef = React.useRef<DismissalLease | null>(activeLease);
    activeLeaseRef.current = activeLease;
    const subscribe = React.useCallback((listener: () => void) => (
        activeLease ? activeLease.subscribe(listener) : () => undefined
    ), [activeLease]);
    const getSnapshot = React.useCallback(() => (
        activeLease ? activeLease.getSnapshot() : EMPTY_DISMISSED_ACTIVITY_IDS
    ), [activeLease]);
    const dismissedActivityIds = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const dismissActivity = React.useCallback((identityKey: string, sourceKey: string): void => {
        activeLeaseRef.current?.dismiss(identityKey, sourceKey);
    }, []);
    const reconcileActivitySource = React.useCallback((
        sourceKey: string,
        activeIdentityKeys: ReadonlySet<string>,
    ): void => {
        activeLeaseRef.current?.reconcileSource(sourceKey, activeIdentityKeys);
    }, []);

    return React.useMemo(() => ({
        dismissedActivityIds,
        dismissActivity,
        reconcileActivitySource,
    }), [dismissActivity, dismissedActivityIds, reconcileActivitySource]);
}
