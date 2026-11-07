import type { PluginUiEphemeralSharedScope } from '@happier-dev/plugin-ui/hostApi';
import type { PluginMachineExecutionOriginV1 } from '@happier-dev/protocol';
import type { PluginUiArtifactDigestV1 } from '@happier-dev/protocol/plugins/ui';
import { useLayoutEffect, useState } from 'react';

import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { readServerAccountScopeOwnerLifetime, serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';

type SharedValueEntry = {
    value: unknown;
    dispose(): void;
    retainWhenIdle: boolean;
    onIdle?: () => void;
    onExecutionOriginChange?: () => void;
    readonly leases: Set<SharedValueLease>;
};

type SharedValueLease = Readonly<{
    executionOriginKey: string;
}>;

type OccurrenceScope = {
    readonly occurrenceId: string;
    readonly values: Map<string, SharedValueEntry>;
    retired: boolean;
};

type PluginScopeRecord = {
    /** Per-transport currentness fences; these never participate in value identity. */
    readonly origins: Map<string, { current: OccurrenceScope | null }>;
    /** Opaque values belong to the Account, plugin and execution occurrence or admitted UI artifact. */
    readonly occurrences: Map<string, OccurrenceScope>;
};

type AccountScopeRecord = {
    retired: boolean;
    readonly lifetimes: Set<ActiveServerAccountScopeLifetime>;
    readonly plugins: Map<string, PluginScopeRecord>;
};

const accountScopes = new Map<string, AccountScopeRecord>();

function disposeSharedValue(entry: SharedValueEntry): void {
    entry.leases.clear();
    try {
        entry.dispose();
    } catch {
        // A plugin-owned value cannot prevent the host from retiring the rest
        // of this Account/occurrence scope.
    }
}

function retireOccurrence(scope: OccurrenceScope): void {
    if (scope.retired) return;
    scope.retired = true;
    const entries = [...scope.values.values()];
    scope.values.clear();
    for (const entry of entries) disposeSharedValue(entry);
}

function retireAccount(record: AccountScopeRecord): void {
    if (record.retired) return;
    record.retired = true;
    for (const plugin of record.plugins.values()) {
        for (const occurrence of plugin.occurrences.values()) retireOccurrence(occurrence);
        plugin.occurrences.clear();
        plugin.origins.clear();
    }
    record.plugins.clear();
    record.lifetimes.clear();
}

function readExecutionOriginSlot(executionOrigin: PluginMachineExecutionOriginV1 | null | undefined): string {
    if (!executionOrigin) return 'unqualified';
    return JSON.stringify(executionOrigin);
}

function readAccountRecord(
    readerLifetime: ActiveServerAccountScopeLifetime,
): AccountScopeRecord | null {
    const accountLifetime = readServerAccountScopeOwnerLifetime(readerLifetime);
    if (!accountLifetime.isCurrent()) return null;
    const key = serverAccountScopeKeySuffix(accountLifetime.scope);
    let record = accountScopes.get(key);
    if (!record) {
        record = { retired: false, lifetimes: new Set(), plugins: new Map() };
        accountScopes.set(key, record);
    }
    if (!record.lifetimes.has(accountLifetime)) {
        const shared = record;
        shared.lifetimes.add(accountLifetime);
        // Idle presentation follows credential-owned Account retirement.
        // Closing the last mounted reader must not discard its retained rows.
        accountLifetime.onRetire(() => {
            shared.lifetimes.delete(accountLifetime);
            if ([...shared.lifetimes].some(lifetime => lifetime.isCurrent())) return;
            if (accountScopes.get(key) === shared) accountScopes.delete(key);
            retireAccount(shared);
        });
    }
    return record.retired || !accountLifetime.isCurrent() ? null : record;
}

function createOccurrenceFacade(input: Readonly<{
    accountLifetime: ActiveServerAccountScopeLifetime;
    account: AccountScopeRecord;
    slot: { current: OccurrenceScope | null };
    occurrence: OccurrenceScope;
    executionOriginKey: string;
    isCurrent(): boolean;
}>): PluginUiEphemeralSharedScope {
    return Object.freeze({
        acquire<T>(
            localKey: string,
            create: () => Readonly<{
                value: T;
                dispose(): void;
                retainWhenIdle?: true;
                onIdle?(): void;
                onExecutionOriginChange?(): void;
            }>,
        ) {
            if (
                input.account.retired
                || input.occurrence.retired
                || input.slot.current !== input.occurrence
                || !input.accountLifetime.isCurrent()
                || !input.isCurrent()
            ) return null;

            let entry = input.occurrence.values.get(localKey);
            if (!entry) {
                const created = create();
                entry = {
                    value: created.value,
                    dispose: created.dispose,
                    retainWhenIdle: created.retainWhenIdle === true,
                    ...(created.onIdle === undefined ? {} : { onIdle: created.onIdle }),
                    ...(created.onExecutionOriginChange === undefined
                        ? {}
                        : { onExecutionOriginChange: created.onExecutionOriginChange }),
                    leases: new Set(),
                };
                // `create` is trusted plugin code and may synchronously retire
                // this mount. Refuse publication and dispose its value if the
                // owner changed while it ran.
                if (
                    input.account.retired
                    || input.occurrence.retired
                    || input.slot.current !== input.occurrence
                    || !input.accountLifetime.isCurrent()
                    || !input.isCurrent()
                ) {
                    disposeSharedValue(entry);
                    return null;
                }
                input.occurrence.values.set(localKey, entry);
            }

            const leaseRecord = Object.freeze({ executionOriginKey: input.executionOriginKey });
            entry.leases.add(leaseRecord);
            let released = false;
            const leasedEntry = entry;
            return Object.freeze({
                value: leasedEntry.value as T,
                release(): void {
                    if (released) return;
                    released = true;
                    const activeBeforeRelease = leasedEntry.leases.values().next().value as SharedValueLease | undefined;
                    if (!leasedEntry.leases.delete(leaseRecord)) return;
                    if (input.occurrence.values.get(localKey) !== leasedEntry) return;
                    if (leasedEntry.leases.size === 0) {
                        if (leasedEntry.retainWhenIdle) {
                            try {
                                leasedEntry.onIdle?.();
                                return;
                            } catch {
                                // A failed idle transition cannot leave plugin work retained.
                            }
                        }
                        input.occurrence.values.delete(localKey);
                        disposeSharedValue(leasedEntry);
                        return;
                    }
                    const activeAfterRelease = leasedEntry.leases.values().next().value as SharedValueLease | undefined;
                    if (
                        activeBeforeRelease === leaseRecord
                        && activeAfterRelease?.executionOriginKey !== input.executionOriginKey
                    ) {
                        try {
                            leasedEntry.onExecutionOriginChange?.();
                        } catch {
                            // A plugin-owned lifecycle observer cannot prevent
                            // the host from completing lease retirement.
                        }
                    }
                },
            });
        },
    });
}

/**
 * Resolve one host-owned, in-process sharing scope for a mounted plugin
 * occurrence. Account and occurrence replacement retire every opaque value;
 * the caller's incumbent mount currentness fences stale overlapping renders.
 */
export function getPluginUiEphemeralSharedScope(input: Readonly<{
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    pluginId: string;
    occurrenceId: string;
    /** Exact transport participant; it fences currentness but never keys the value. */
    executionOrigin?: PluginMachineExecutionOriginV1 | null;
    isCurrent(): boolean;
}>): PluginUiEphemeralSharedScope | null {
    if (!input.accountLifetime || !input.isCurrent()) return null;
    const account = readAccountRecord(input.accountLifetime);
    if (!account || !input.isCurrent()) return null;

    let plugin = account.plugins.get(input.pluginId);
    if (!plugin) {
        plugin = { origins: new Map(), occurrences: new Map() };
        account.plugins.set(input.pluginId, plugin);
    }

    const executionOriginKey = readExecutionOriginSlot(input.executionOrigin);
    let slot = plugin.origins.get(executionOriginKey);
    if (!slot) {
        slot = { current: null };
        plugin.origins.set(executionOriginKey, slot);
    }
    let occurrence = plugin.occurrences.get(input.occurrenceId);
    if (!occurrence || occurrence.retired) {
        occurrence = {
            occurrenceId: input.occurrenceId,
            values: new Map(),
            retired: false,
        };
        plugin.occurrences.set(input.occurrenceId, occurrence);
    }
    const precedingOccurrence = slot.current;
    if (precedingOccurrence !== occurrence) {
        slot.current = occurrence;
        const precedingStillCurrent = precedingOccurrence
            ? [...plugin.origins.values()].some((origin) => origin.current === precedingOccurrence)
            : false;
        if (precedingOccurrence && !precedingStillCurrent) {
            if (plugin.occurrences.get(precedingOccurrence.occurrenceId) === precedingOccurrence) {
                plugin.occurrences.delete(precedingOccurrence.occurrenceId);
            }
            retireOccurrence(precedingOccurrence);
        }
    }

    return createOccurrenceFacade({
        accountLifetime: input.accountLifetime,
        account,
        slot,
        occurrence,
        executionOriginKey,
        isCurrent: input.isCurrent,
    });
}

/**
 * Dispose the idle retained values of every plugin this Account no longer has enabled.
 *
 * A value kept by `retainWhenIdle` otherwise outlives a plugin disable until the Account or the
 * plugin occurrence changes. Only idle values go: a value some surface still holds a lease on is
 * that surface's to release, and a plugin absent from one projection may still be running for a
 * Session on another machine.
 */
export function retireIdlePluginUiEphemeralSharedValuesExcept(
    accountLifetime: ActiveServerAccountScopeLifetime | null,
    enabledPluginIds: ReadonlySet<string>,
): void {
    const account = accountLifetime?.isCurrent()
        ? accountScopes.get(serverAccountScopeKeySuffix(accountLifetime.scope)) : undefined;
    if (!account || account.retired) return;
    for (const [pluginId, plugin] of account.plugins) {
        if (enabledPluginIds.has(pluginId)) continue;
        for (const occurrence of plugin.occurrences.values()) {
            for (const [localKey, entry] of [...occurrence.values]) {
                if (!entry.retainWhenIdle || entry.leases.size > 0) continue;
                occurrence.values.delete(localKey);
                disposeSharedValue(entry);
            }
        }
    }
}

type MountedScopeInput = Readonly<{
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    pluginId: string;
    occurrenceId?: string;
    /** Verified presentation identity when this page has no executable occurrence. */
    artifactDigest?: PluginUiArtifactDigestV1;
    executionOrigin?: PluginMachineExecutionOriginV1 | null;
    mountLifetime: Readonly<{ isCurrent(): boolean }>;
}>;

type MountedScopeState = MountedScopeInput & Readonly<{
    scope: PluginUiEphemeralSharedScope | null;
}>;

function mountedScopeIdentity(input: MountedScopeInput): string | undefined {
    // This is only a private sharing key, never executable currentness or
    // mounted caller custody. The admitted artifact is the immutable plugin UI
    // generation shared by page, Composer and other mounts; an execution
    // occurrence is only the fallback for callers without an artifact identity.
    return input.artifactDigest ? `artifact:${input.artifactDigest}` : input.occurrenceId;
}

function isSameMountedScopeInput(state: MountedScopeState, input: MountedScopeInput): boolean {
    return state.accountLifetime === input.accountLifetime
        && state.pluginId === input.pluginId
        && mountedScopeIdentity(state) === mountedScopeIdentity(input)
        && readExecutionOriginSlot(state.executionOrigin) === readExecutionOriginSlot(input.executionOrigin)
        && state.mountLifetime === input.mountLifetime;
}

/**
 * Commit-safe React adapter for the host registry. A speculative render never
 * retires another occurrence, and a changed identity exposes `null` until its
 * committed layout effect installs the exact current scope.
 */
export function usePluginUiEphemeralSharedScopeBinding(
    input: MountedScopeInput,
): PluginUiEphemeralSharedScope | null {
    const executionOriginSlot = readExecutionOriginSlot(input.executionOrigin);
    const scopeIdentity = mountedScopeIdentity(input);
    const [state, setState] = useState<MountedScopeState>(() => ({ ...input, scope: null }));
    if (!isSameMountedScopeInput(state, input)) {
        setState({ ...input, scope: null });
    }
    const effectiveState = isSameMountedScopeInput(state, input)
        ? state
        : { ...input, scope: null };

    useLayoutEffect(() => {
        const scope = scopeIdentity ? getPluginUiEphemeralSharedScope({
            accountLifetime: input.accountLifetime,
            pluginId: input.pluginId,
            occurrenceId: scopeIdentity,
            executionOrigin: input.executionOrigin,
            isCurrent: input.mountLifetime.isCurrent,
        }) : null;
        setState((current) => isSameMountedScopeInput(current, input)
            ? { ...input, scope }
            : current);
    }, [executionOriginSlot, input.accountLifetime, scopeIdentity, input.mountLifetime, input.pluginId]);

    return effectiveState.scope;
}
