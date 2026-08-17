import * as React from 'react';

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
    dismissedActivityIds: ReadonlySet<string>;
    /** Each dismissal belongs to one authoritative Activity Resource source. */
    dismissedSourceKeyByActivityId: ReadonlyMap<string, string>;
    readonly listeners: Set<() => void>;
    disposed: boolean;
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
    const entriesByAccountLifetime = new Map<
        ActiveServerAccountScopeLifetime,
        Map<string, DismissalEntry>
    >();
    let disposed = false;

    const notify = (entry: DismissalEntry): void => {
        for (const listener of [...entry.listeners]) listener();
    };
    const disposeEntry = (entry: DismissalEntry): void => {
        if (entry.disposed) return;
        entry.disposed = true;
        entry.retirement?.dispose();
        entry.retirement = null;
        entry.listeners.clear();
        entry.dismissedActivityIds = EMPTY_DISMISSED_ACTIVITY_IDS;
        entry.dismissedSourceKeyByActivityId = new Map();
    };

    return Object.freeze({
        acquire(binding) {
            if (disposed || !binding.accountLifetime.isCurrent()) return null;

            const key = bindingKey(binding);
            let entries = entriesByAccountLifetime.get(binding.accountLifetime);
            if (!entries) {
                entries = new Map();
                entriesByAccountLifetime.set(binding.accountLifetime, entries);
            }
            let entry = entries.get(key);
            if (!entry || entry.disposed) {
                entry = {
                    dismissedActivityIds: EMPTY_DISMISSED_ACTIVITY_IDS,
                    dismissedSourceKeyByActivityId: new Map(),
                    listeners: new Set(),
                    disposed: false,
                    retirement: null,
                };
                entries.set(key, entry);
                const retireEntry = (): void => {
                    if (entry!.disposed) return;
                    disposeEntry(entry!);
                    if (entries!.get(key) === entry) entries!.delete(key);
                };
                entry.retirement = binding.accountLifetime.onRetire(retireEntry);
            }

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
                    // Dismissal is presentation continuity, not a Resource
                    // lease. Navigating away from Session A leaves it with no
                    // transcript consumer, but returning to the same exact
                    // Account/Session/generation binding must preserve the
                    // user's terminal-card dismissal. Entry retirement remains
                    // owned by the Account lifetime or the true provider
                    // unmount; consumer release only scopes subscriptions.
                },
            });
        },
        dispose(): void {
            if (disposed) return;
            disposed = true;
            for (const entries of entriesByAccountLifetime.values()) {
                for (const entry of entries.values()) disposeEntry(entry);
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
