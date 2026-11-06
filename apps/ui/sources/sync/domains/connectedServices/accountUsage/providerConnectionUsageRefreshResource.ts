import type { DaemonProviderUsageRefreshResponseV1 } from '@happier-dev/protocol/rpc/providers';
import type { ProviderAccountUsageSnapshotV1, ProviderAccountUsageStateV1 } from '@happier-dev/protocol/connect/account-usage-primitives';
import { ProviderErrorV1Schema, type ProviderErrorCodeV1 } from '@happier-dev/protocol/providers/errors';
import type { ProviderActionApprovalOptions, refreshProviderConnectionUsage } from '@/providers/actions/client';
import { ProviderActionPendingApprovalError } from '@/providers/actions/ProviderActionPendingApprovalError';
import { resolveProviderAccountUsageSnapshotState } from './providerAccountUsageSelectors';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import { buildApprovalHref } from '@/components/approvals/approvalNavigation';
import type { ProviderPendingApproval } from '@/providers/actions/useProviderActionClient';
import { retainDeep } from '@/sync/domains/state/structuralSharing';

export type ProviderConnectionUsageRefreshView = Readonly<{
    result: DaemonProviderUsageRefreshResponseV1;
    snapshotsBySourceId: Readonly<Record<string, ProviderAccountUsageSnapshotV1>>;
    stateBySourceId: Readonly<Record<string, ProviderAccountUsageStateV1>>;
}>;

export type ProviderConnectionUsageRefreshResource = Readonly<{
    isCurrent(): boolean;
    getCurrent(): ProviderConnectionUsageRefreshView | null;
    dispose(): void;
    refresh(automatic?: boolean): Promise<ProviderConnectionUsageRefreshView | null>;
    invalidate(): void;
    cancel(): void;
    subscribe(listener: () => void): () => void;
    getSnapshot(): ProviderConnectionUsageRefreshSnapshot;
}>;

export type ProviderConnectionUsageRefreshSnapshot = Readonly<{
    view: ProviderConnectionUsageRefreshView | null;
    refreshing: boolean;
    failed: boolean;
    pendingApproval: ProviderPendingApproval | null;
}>;

type ResourceInput = Readonly<{
    serverId: string;
    accountId: string;
    connectionId: string;
    machineId: string;
    /** The canonical Action invocation; a mounted caller passes its Action client's bound method, which
     * owns approval continuation and Account retirement. */
    invoke: (input: Parameters<typeof refreshProviderConnectionUsage>[0],
        options: Pick<ProviderActionApprovalOptions, 'interactivePresentation'> & Readonly<{ signal: AbortSignal; retainInvocationSignal?: AbortSignal;
            onApprovalPending?: (registration: ActionApprovalRegistration) => void }>) => Promise<DaemonProviderUsageRefreshResponseV1>;
    /** Captures the Home, Account, connection declaration and selected-credential
     * identities. Their owner retires this lifetime when any of them changes. */
    lifetime: Readonly<{ signal?: AbortSignal; isCurrent(): boolean;
        onRetire?(cancel: () => void): Readonly<{ dispose(): void }> }>;
    isPresented(): boolean;
    onDispose?(): void;
}>;

export function createProviderConnectionUsageRefreshResource(input: ResourceInput): ProviderConnectionUsageRefreshResource {
    let view: ProviderConnectionUsageRefreshView | null = null;
    let reading: Promise<ProviderConnectionUsageRefreshView | null> | null = null;
    let disposed = false;
    let controller = new AbortController();
    let blockedAutomatic = false;
    let invalidated = true;
    let retirement: Readonly<{ dispose(): void }> | undefined;
    const listeners = new Set<() => void>();
    let snapshot: ProviderConnectionUsageRefreshSnapshot = { view: null, refreshing: false, failed: false, pendingApproval: null };
    const publish = (next: ProviderConnectionUsageRefreshSnapshot) => {
        snapshot = next;
        for (const listener of listeners) listener();
    };
    const cancel = () => {
        if (reading) invalidated = true;
        controller.abort();
        controller = new AbortController();
        reading = null;
        publish({ ...snapshot, refreshing: false, pendingApproval: null });
    };
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        view = null;
        controller.abort();
        publish({ view: null, refreshing: false, failed: false, pendingApproval: null });
        input.lifetime.signal?.removeEventListener('abort', dispose);
        retirement?.dispose();
        input.onDispose?.();
    };
    input.lifetime.signal?.addEventListener('abort', dispose, { once: true });
    retirement = input.lifetime.onRetire?.(dispose);
    const current = () => {
        if (disposed || input.lifetime.signal?.aborted) { dispose(); return false; }
        try {
            if (input.lifetime.isCurrent()) return true;
        } catch { /* An unavailable authority cannot retain protected facts. */ }
        dispose();
        return false;
    };
    const resource: ProviderConnectionUsageRefreshResource = {
        isCurrent: current,
        getCurrent: () => current() ? view : null,
        getSnapshot: () => snapshot,
        subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        dispose,
        cancel,
        invalidate() {
            if (!current()) return;
            invalidated = true;
            if (input.isPresented()) void resource.refresh(true).catch(() => {});
        },
        refresh(automatic = false): Promise<ProviderConnectionUsageRefreshView | null> {
            if (!current() || !input.isPresented()) return Promise.resolve(null);
            if (reading) return reading;
            if (automatic && !invalidated) return Promise.resolve(view);
            if (automatic && blockedAutomatic) return Promise.resolve(view);
            if (!automatic) blockedAutomatic = false;
            invalidated = false;
            const invocation = controller;
            publish({ view, refreshing: true, failed: false, pendingApproval: null });
            reading = (async () => {
                try {
                    const result = await input.invoke({ serverId: input.serverId, accountId: input.accountId,
                        connectionId: input.connectionId, machineId: input.machineId, signal: invocation.signal },
                    { signal: invocation.signal, retainInvocationSignal: invocation.signal,
                        ...(automatic ? { interactivePresentation: 'unavailable' as const } : {}),
                        onApprovalPending: registration => {
                            if (!current() || invocation.signal.aborted) return;
                            const artifactId = typeof registration === 'string' ? registration : registration.artifactId;
                            publish({ ...snapshot, pendingApproval: { artifactId, href: buildApprovalHref(artifactId, input.serverId) } });
                        } });
                    if (!current() || invocation.signal.aborted) return null;
                    view = projectUsageRefresh(result, view);
                    return view;
                } catch (error) {
                    if (!current() || invocation.signal.aborted) return null;
                    // Policy may require a person's explicit Refresh. Automatic
                    // acquisition never requests approval or reports that as a Provider failure.
                    if ((error as { code?: unknown } | null)?.code === 'action_interactive_review_required') return view;
                    if (isActionApprovalDeclinedErrorCode((error as { code?: unknown } | null)?.code)) blockedAutomatic = true;
                    if (error instanceof ProviderActionPendingApprovalError) throw error;
                    // A failed connection-level admission cannot prove which source
                    // or credential is current. Source HTTP failures arrive in results.
                    const typed = ProviderErrorV1Schema.safeParse(error);
                    if (!typed.success) {
                        publish({ ...snapshot, failed: true });
                        throw error;
                    }
                    view = projectUsageRefresh({ status: 'error', error: typed.data }, view);
                    return view;
                } finally {
                    if (controller === invocation) {
                        reading = null;
                        if (current()) {
                            publish({ ...snapshot, view, refreshing: false, pendingApproval: null });
                            if (invalidated && input.isPresented() && !blockedAutomatic) void resource.refresh(true).catch(() => {});
                        }
                    }
                }
            })();
            return reading;
        },
    };
    return resource;
}

type SharedEntry = Readonly<{
    input: Pick<ResourceInput, 'serverId' | 'accountId' | 'connectionId' | 'machineId'>;
    resource: ProviderConnectionUsageRefreshResource;
    demands: Set<Readonly<{ invoke: ResourceInput['invoke'] }>>;
}>;
// Retain dated observations for their exact Account/credential lifetime, so a
// remount is not another billing read. Only presented consumers create demand.
const shared = new Map<string, SharedEntry>();

export function acquireProviderConnectionUsageRefreshResource(input: Omit<ResourceInput, 'isPresented'> & Readonly<{ identity: string; active?: boolean }>) {
    const base = JSON.stringify([input.serverId, input.accountId, input.connectionId, input.machineId]);
    const key = JSON.stringify([base, input.identity]);
    for (const [otherKey, entry] of shared) {
        if (otherKey !== key && JSON.stringify([entry.input.serverId, entry.input.accountId, entry.input.connectionId, entry.input.machineId]) === base) {
            entry.resource.dispose();
            shared.delete(otherKey);
        }
    }
    let entry = shared.get(key);
    if (entry && !entry.resource.isCurrent()) {
        shared.delete(key);
        entry = undefined;
    }
    if (!entry) {
        const demands = new Set<Readonly<{ invoke: ResourceInput['invoke'] }>>();
        entry = { input: { serverId: input.serverId, accountId: input.accountId, connectionId: input.connectionId, machineId: input.machineId },
            demands, resource: createProviderConnectionUsageRefreshResource({ ...input,
            onDispose: () => { shared.delete(key); },
            invoke: (request, options) => demands.values().next().value!.invoke(request, options),
            isPresented: () => demands.size > 0 }) };
        shared.set(key, entry);
    }
    const held = entry;
    const demand = { invoke: input.invoke };
    let active = false;
    let released = false;
    const setActive = (next: boolean) => {
        if (released || active === next) return;
        active = next;
        if (next) {
            const first = held.demands.size === 0;
            held.demands.add(demand);
            if (first) void held.resource.refresh(true).catch(() => {});
        } else {
            held.demands.delete(demand);
            if (held.demands.size === 0) held.resource.cancel();
        }
    };
    setActive(input.active !== false);
    return { resource: held.resource, setActive, release() {
        if (released) return;
        setActive(false);
        released = true;
        // Cancelled reads cannot publish, while the last settled observation
        // stays available until an actual authority change or explicit refresh.
    } };
}

/** A committed request wakes only its exact connection's currently demanded observation. */
export function invalidateProviderConnectionUsage(input: Readonly<{ serverId: string; accountId: string; connectionId: string; machineId?: string }>): void {
    for (const entry of shared.values()) {
        if (entry.input.serverId === input.serverId && entry.input.accountId === input.accountId && entry.input.connectionId === input.connectionId
            && (!input.machineId || entry.input.machineId === input.machineId)) entry.resource.invalidate();
    }
}

function canRetainSourceSnapshot(code: ProviderErrorCodeV1): boolean {
    switch (code) {
        case 'provider_endpoint_unreachable':
        case 'provider_endpoint_unavailable':
        case 'provider_endpoint_rate_limited':
        case 'provider_endpoint_auth_required':
        case 'provider_endpoint_unauthorized':
        case 'provider_probe_response_invalid': return true;
        default: return false;
    }
}

function projectUsageRefresh(result: DaemonProviderUsageRefreshResponseV1,
    previous: ProviderConnectionUsageRefreshView | null): ProviderConnectionUsageRefreshView {
    const snapshotsBySourceId: Record<string, ProviderAccountUsageSnapshotV1> = {};
    const stateBySourceId: Record<string, ProviderAccountUsageStateV1> = {};
    if (result.status === 'error' && canRetainSourceSnapshot(result.error.code) && previous) {
        for (const [sourceId, snapshot] of Object.entries(previous.snapshotsBySourceId)) {
            snapshotsBySourceId[sourceId] = snapshot;
            stateBySourceId[sourceId] = 'error_last_known_good';
        }
    }
    if (result.status === 'success') for (const source of result.sources) {
        const snapshot = source.status === 'ok' ? source.snapshot
            : source.status === 'error' && canRetainSourceSnapshot(source.error.code)
                ? previous?.snapshotsBySourceId[source.sourceId] : undefined;
        if (snapshot) snapshotsBySourceId[source.sourceId] = snapshot;
        stateBySourceId[source.sourceId] = resolveProviderAccountUsageSnapshotState({ snapshot: snapshot ?? null,
            loading: false, hadError: source.status === 'error', nowMs: Date.now() });
    }
    return retainDeep(previous ?? undefined, { result, snapshotsBySourceId, stateBySourceId });
}
