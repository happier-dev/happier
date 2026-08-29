import type { PluginUiEphemeralSharedScope } from '@happier-dev/plugin-ui/hostApi';
import type { PluginMachineExecutionOriginV1 } from '@happier-dev/protocol';
import { useLayoutEffect, useState } from 'react';

import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

type SharedValueEntry = {
    value: unknown;
    dispose(): void;
    leaseCount: number;
};

type GenerationScope = {
    readonly immutableGenerationId: string;
    readonly values: Map<string, SharedValueEntry>;
    retired: boolean;
};

type PluginScopeRecord = {
    readonly slots: Map<string, { current: GenerationScope | null }>;
};

type AccountScopeRecord = {
    retired: boolean;
    readonly plugins: Map<string, PluginScopeRecord>;
};

const accountScopes = new WeakMap<ActiveServerAccountScopeLifetime, AccountScopeRecord>();

function disposeSharedValue(entry: SharedValueEntry): void {
    try {
        entry.dispose();
    } catch {
        // A plugin-owned value cannot prevent the host from retiring the rest
        // of this Account/generation scope.
    }
}

function retireGeneration(scope: GenerationScope): void {
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
        for (const slot of plugin.slots.values()) {
            if (slot.current) retireGeneration(slot.current);
        }
    }
    record.plugins.clear();
}

function readExecutionOriginSlot(executionOrigin: PluginMachineExecutionOriginV1 | null | undefined): string {
    if (!executionOrigin) return 'unqualified';
    return JSON.stringify([
        executionOrigin.serverIdentityId,
        executionOrigin.materializationRef.pluginId,
        executionOrigin.materializationRef.machineId,
        executionOrigin.materializationRef.materializationId,
    ]);
}

function readAccountRecord(
    accountLifetime: ActiveServerAccountScopeLifetime,
): AccountScopeRecord | null {
    if (!accountLifetime.isCurrent()) return null;
    const existing = accountScopes.get(accountLifetime);
    if (existing) return existing.retired ? null : existing;

    const record: AccountScopeRecord = {
        retired: false,
        plugins: new Map(),
    };
    accountScopes.set(accountLifetime, record);
    accountLifetime.onRetire(() => retireAccount(record));
    return record.retired || !accountLifetime.isCurrent() ? null : record;
}

function createGenerationFacade(input: Readonly<{
    accountLifetime: ActiveServerAccountScopeLifetime;
    account: AccountScopeRecord;
    slot: { current: GenerationScope | null };
    generation: GenerationScope;
    isCurrent(): boolean;
}>): PluginUiEphemeralSharedScope {
    return Object.freeze({
        acquire<T>(
            localKey: string,
            create: () => Readonly<{ value: T; dispose(): void }>,
        ) {
            if (
                input.account.retired
                || input.generation.retired
                || input.slot.current !== input.generation
                || !input.accountLifetime.isCurrent()
                || !input.isCurrent()
            ) return null;

            let entry = input.generation.values.get(localKey);
            if (!entry) {
                const created = create();
                entry = {
                    value: created.value,
                    dispose: created.dispose,
                    leaseCount: 0,
                };
                // `create` is trusted plugin code and may synchronously retire
                // this mount. Refuse publication and dispose its value if the
                // owner changed while it ran.
                if (
                    input.account.retired
                    || input.generation.retired
                    || input.slot.current !== input.generation
                    || !input.accountLifetime.isCurrent()
                    || !input.isCurrent()
                ) {
                    disposeSharedValue(entry);
                    return null;
                }
                input.generation.values.set(localKey, entry);
            }

            entry.leaseCount += 1;
            let released = false;
            const leasedEntry = entry;
            return Object.freeze({
                value: leasedEntry.value as T,
                release(): void {
                    if (released) return;
                    released = true;
                    if (input.generation.values.get(localKey) !== leasedEntry) return;
                    leasedEntry.leaseCount -= 1;
                    if (leasedEntry.leaseCount !== 0) return;
                    input.generation.values.delete(localKey);
                    disposeSharedValue(leasedEntry);
                },
            });
        },
    });
}

/**
 * Resolve one host-owned, in-process sharing scope for a mounted plugin
 * generation. Account and generation replacement retire every opaque value;
 * the caller's incumbent mount currentness fences stale overlapping renders.
 */
export function getPluginUiEphemeralSharedScope(input: Readonly<{
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    pluginId: string;
    immutableGenerationId: string;
    /** Exact producer execution/materialization origin; local mounts use one slot. */
    executionOrigin?: PluginMachineExecutionOriginV1 | null;
    isCurrent(): boolean;
}>): PluginUiEphemeralSharedScope | null {
    if (!input.accountLifetime || !input.isCurrent()) return null;
    const account = readAccountRecord(input.accountLifetime);
    if (!account || !input.isCurrent()) return null;

    let plugin = account.plugins.get(input.pluginId);
    if (!plugin) {
        plugin = { slots: new Map() };
        account.plugins.set(input.pluginId, plugin);
    }

    const originSlot = readExecutionOriginSlot(input.executionOrigin);
    let slot = plugin.slots.get(originSlot);
    if (!slot) {
        slot = { current: null };
        plugin.slots.set(originSlot, slot);
    }
    let generation = slot.current;
    if (!generation || generation.immutableGenerationId !== input.immutableGenerationId) {
        if (generation) {
            retireGeneration(generation);
        }
        generation = {
            immutableGenerationId: input.immutableGenerationId,
            values: new Map(),
            retired: false,
        };
        slot.current = generation;
    }

    return createGenerationFacade({
        accountLifetime: input.accountLifetime,
        account,
        slot,
        generation,
        isCurrent: input.isCurrent,
    });
}

type MountedScopeInput = Readonly<{
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    pluginId: string;
    immutableGenerationId: string;
    executionOrigin?: PluginMachineExecutionOriginV1 | null;
    mountLifetime: Readonly<{ isCurrent(): boolean }>;
}>;

type MountedScopeState = MountedScopeInput & Readonly<{
    scope: PluginUiEphemeralSharedScope | null;
}>;

function isSameMountedScopeInput(state: MountedScopeState, input: MountedScopeInput): boolean {
    return state.accountLifetime === input.accountLifetime
        && state.pluginId === input.pluginId
        && state.immutableGenerationId === input.immutableGenerationId
        && readExecutionOriginSlot(state.executionOrigin) === readExecutionOriginSlot(input.executionOrigin)
        && state.mountLifetime === input.mountLifetime;
}

/**
 * Commit-safe React adapter for the host registry. A speculative render never
 * retires another generation, and a changed identity exposes `null` until its
 * committed layout effect installs the exact current scope.
 */
export function usePluginUiEphemeralSharedScopeBinding(
    input: MountedScopeInput,
): PluginUiEphemeralSharedScope | null {
    const executionOriginSlot = readExecutionOriginSlot(input.executionOrigin);
    const [state, setState] = useState<MountedScopeState>(() => ({ ...input, scope: null }));
    if (!isSameMountedScopeInput(state, input)) {
        setState({ ...input, scope: null });
    }
    const effectiveState = isSameMountedScopeInput(state, input)
        ? state
        : { ...input, scope: null };

    useLayoutEffect(() => {
        const scope = getPluginUiEphemeralSharedScope({
            accountLifetime: input.accountLifetime,
            pluginId: input.pluginId,
            immutableGenerationId: input.immutableGenerationId,
            executionOrigin: input.executionOrigin,
            isCurrent: input.mountLifetime.isCurrent,
        });
        setState((current) => isSameMountedScopeInput(current, input)
            ? { ...input, scope }
            : current);
    }, [executionOriginSlot, input.accountLifetime, input.immutableGenerationId, input.mountLifetime, input.pluginId]);

    return effectiveState.scope;
}
