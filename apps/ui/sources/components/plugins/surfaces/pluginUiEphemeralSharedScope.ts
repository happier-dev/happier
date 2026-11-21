import type { PluginUiEphemeralSharedScope } from '@happier-dev/plugin-ui/hostApi';
import type { PluginMachineExecutionOriginV1 } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import type { PluginUiArtifactDigestV1 } from '@happier-dev/protocol/plugins/ui';
import { useLayoutEffect, useState } from 'react';

import type { PluginAccountExecutionAdmission } from '@/sync/domains/plugins/availability/reader';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { PluginUiAccountExecutableOrigin } from '@/sync/domains/plugins/ui/projectionOrigins';
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
    /** Per-transport currentness fences; execution-bound acquisitions also qualify by this origin. */
    readonly origins: Map<string, { current: OccurrenceScope | null }>;
    /** Opaque values belong to the Account, plugin and admitted plugin generation or UI artifact. */
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

function readExecutionOriginSlot(input: Readonly<{
    accountExecutionOrigin?: PluginUiAccountExecutableOrigin | null;
    executionOrigin?: PluginMachineExecutionOriginV1 | null;
}>): string {
    // An Account renderer may carry a Machine placement hint. Its callbacks
    // still belong to the same admitted Account custody as its client Actions.
    if (input.accountExecutionOrigin) return 'account';
    if (!input.executionOrigin) return 'unqualified';
    return JSON.stringify(input.executionOrigin);
}

/**
 * One admitted Account plugin generation has one execution-bound slot, whichever projection placed the borrower:
 * a Session Details mount carries a Machine origin, yet its Action, resolved by name from the Account catalog,
 * must find the callback that mount registered. Without an admitted generation the exact origin still isolates.
 */
function readExecutionBoundSlot(input: Parameters<typeof readExecutionOriginSlot>[0] & Readonly<{ pluginGenerationId?: string }>): string {
    return input.pluginGenerationId ? 'account' : readExecutionOriginSlot(input);
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
    const shared: PluginUiEphemeralSharedScope = Object.freeze({
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
                retire(): void {
                    if (input.occurrence.values.get(localKey) !== leasedEntry) return;
                    input.occurrence.values.delete(localKey);
                    disposeSharedValue(leasedEntry);
                },
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
    return shared;
}

type SharedScopeIdentity = Readonly<{
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    pluginId: string;
    occurrenceId?: string;
    /** Canonical Account selection's plugin-wide custody, shared by sibling UI Artifacts. */
    pluginGenerationId?: string;
    /** Admitted presentation bytes, not executable currentness or custody. */
    artifactDigest?: PluginUiArtifactDigestV1;
    accountExecutionOrigin?: PluginUiAccountExecutableOrigin | null;
    /** Fences mount currentness and qualifies execution-bound values independently of presentation. */
    executionOrigin?: PluginMachineExecutionOriginV1 | null;
}>;

type SharedScopeInput = SharedScopeIdentity & Readonly<{ isCurrent(): boolean }>;

export function derivePluginUiEphemeralSharedScopeIdentity(
    identity: Omit<SharedScopeIdentity, 'pluginGenerationId'>,
    accountCustody?: Readonly<{ admission: PluginAccountExecutionAdmission | undefined; pluginVersion: string }>,
): SharedScopeIdentity {
    const admission = accountCustody?.admission;
    const pluginGenerationId = identity.accountExecutionOrigin?.custodyId
        ?? (admission?.kind === 'available' && admission.manifest.version === accountCustody?.pluginVersion
            ? admission.custodyId : undefined);
    return { ...identity, ...(pluginGenerationId === undefined ? {} : { pluginGenerationId }) };
}

function resolveSharedValueOwner(input: SharedScopeInput, namespace: 'presentation' | 'execution'): PluginUiEphemeralSharedScope | null {
    if (!input.accountLifetime || !input.isCurrent()) return null;
    // Renderer and client registration occurrences are different lifecycle
    // facts. Their admitted Account plugin generation is the common custody;
    // without one, the full execution origin below isolates executable values.
    const pluginGenerationId = input.accountExecutionOrigin?.custodyId ?? input.pluginGenerationId;
    const generation = namespace === 'execution'
        ? pluginGenerationId ? `plugin:${pluginGenerationId}` : input.occurrenceId
        : readSharedScopeIdentity(input);
    const scopeIdentity = generation ? JSON.stringify([namespace, generation]) : undefined;
    if (!scopeIdentity) return null;
    const account = readAccountRecord(input.accountLifetime);
    if (!account || !input.isCurrent()) return null;

    let plugin = account.plugins.get(input.pluginId);
    if (!plugin) {
        plugin = { origins: new Map(), occurrences: new Map() };
        account.plugins.set(input.pluginId, plugin);
    }

    const executionOriginKey = namespace === 'execution' ? readExecutionBoundSlot(input) : readExecutionOriginSlot(input);
    const slotKey = JSON.stringify([namespace, executionOriginKey]);
    let slot = plugin.origins.get(slotKey);
    if (!slot) {
        slot = { current: null };
        plugin.origins.set(slotKey, slot);
    }
    let occurrence = plugin.occurrences.get(scopeIdentity);
    if (!occurrence || occurrence.retired) {
        occurrence = {
            occurrenceId: scopeIdentity,
            values: new Map(),
            retired: false,
        };
        plugin.occurrences.set(scopeIdentity, occurrence);
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
 * Presentation values follow admitted bytes. Execution-bound callbacks follow
 * the admitted plugin generation across renderer/client occurrences and sibling
 * Artifacts, under admitted Account custody.
 * Without Account generation admission, execution sharing requires a Machine
 * origin and remains confined to the exact occurrence.
 * Bind only the namespace the borrower uses: creating a client Action facade
 * must not replace the mounted renderer's presentation generation.
 */
export function getPluginUiEphemeralSharedScope(input: SharedScopeInput): PluginUiEphemeralSharedScope | null {
    if (!input.accountLifetime || !input.isCurrent() || !readSharedScopeIdentity(input)) return null;
    if (!readAccountRecord(input.accountLifetime)) return null;
    // A single-identity borrower keeps the incumbent immediate retirement
    // semantics. With both identities, its first acquisition chooses whether
    // it is borrowing presentation state or executable state.
    let presentation = !input.artifactDigest || !input.occurrenceId
        ? resolveSharedValueOwner(input, 'presentation') : undefined;
    let execution: PluginUiEphemeralSharedScope | null | undefined;
    const acquire: PluginUiEphemeralSharedScope['acquire'] = (localKey, create) => {
        if (presentation === undefined) presentation = resolveSharedValueOwner(input, 'presentation');
        return presentation?.acquire(localKey, create) ?? null;
    };
    const acquireExecutionBound: PluginUiEphemeralSharedScope['acquire'] = (localKey, create) => {
        if (!input.occurrenceId || (!input.executionOrigin && !input.accountExecutionOrigin && !input.pluginGenerationId)) return null;
        if (execution === undefined) execution = resolveSharedValueOwner(input, 'execution');
        return execution?.acquire(JSON.stringify([readExecutionBoundSlot(input), localKey]), create) ?? null;
    };
    return Object.freeze({ acquire, acquireExecutionBound });
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

type MountedScopeInput = SharedScopeIdentity & Readonly<{
    mountLifetime: Readonly<{ isCurrent(): boolean }>;
}>;

type MountedScopeState = MountedScopeInput & Readonly<{
    scope: PluginUiEphemeralSharedScope | null;
}>;

function readSharedScopeIdentity(input: Readonly<{
    occurrenceId?: string;
    pluginGenerationId?: string;
    artifactDigest?: PluginUiArtifactDigestV1;
    accountExecutionOrigin?: PluginUiAccountExecutableOrigin | null;
}>): string | undefined {
    // A renderer's digest covers one entry point. Sibling renderers (page,
    // picker, Action) share the Account-selected plugin generation, not bytes.
    // Mounts without an Account selection retain their exact Artifact scope.
    const pluginGenerationId = input.accountExecutionOrigin?.custodyId ?? input.pluginGenerationId;
    return pluginGenerationId ? `plugin:${pluginGenerationId}`
        : input.artifactDigest ? `artifact:${input.artifactDigest}` : input.occurrenceId;
}

function isSameMountedScopeInput(state: MountedScopeState, input: MountedScopeInput): boolean {
    return state.accountLifetime === input.accountLifetime
        && state.pluginId === input.pluginId
        && state.occurrenceId === input.occurrenceId
        && readSharedScopeIdentity(state) === readSharedScopeIdentity(input)
        && readExecutionOriginSlot(state) === readExecutionOriginSlot(input)
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
    const executionOriginSlot = readExecutionOriginSlot(input);
    const scopeIdentity = readSharedScopeIdentity(input);
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
            ...(input.occurrenceId === undefined ? {} : { occurrenceId: input.occurrenceId }),
            ...(input.pluginGenerationId === undefined ? {} : { pluginGenerationId: input.pluginGenerationId }),
            ...(input.artifactDigest === undefined ? {} : { artifactDigest: input.artifactDigest }),
            accountExecutionOrigin: input.accountExecutionOrigin,
            executionOrigin: input.executionOrigin,
            isCurrent: input.mountLifetime.isCurrent,
        }) : null;
        setState((current) => isSameMountedScopeInput(current, input)
            ? { ...input, scope }
            : current);
    }, [executionOriginSlot, input.accountLifetime, scopeIdentity, input.mountLifetime, input.occurrenceId, input.pluginId]);

    return effectiveState.scope;
}
