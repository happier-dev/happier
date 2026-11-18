import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { buildHomeHubArtifactIdV1, type HomeHubArtifactTransportV1 } from '@happier-dev/protocol/home';
import { flattenWidgetLayoutWidgetsV1 } from '@happier-dev/protocol/widgets';
import { useOptionalAuth } from '@/auth/context/AuthContext';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { storage, useActiveServerAccountScopeLifetime } from '@/sync/domains/state/storage';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getActiveServerHomeCarrier, getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { InvalidateSync } from '@/utils/sessions/sync';
import { parseToken } from '@/utils/auth/parseToken';
import { createHomeHubAccountStore } from './homeHubAccountStore';
import { executeHomeHubLayoutIntent } from './homeHubActionWriter';
import { createActionApprovalContinuationObserver } from '@/components/approvals/actionApprovalContinuation';
import { observeActionApprovalContinuation } from '@/components/approvals/observeActionApprovalContinuation';
import { router } from 'expo-router';
import { buildApprovalHref } from '@/components/approvals/approvalNavigation';
import { publishPresentationNotice, retirePresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { t } from '@/text';

type Store = ReturnType<typeof createHomeHubAccountStore> & { retain(): () => void; isCurrent(): boolean };
const stores = new WeakMap<ActiveServerAccountScopeLifetime, WeakMap<AuthCredentials, Store>>();
const refuse = async (): Promise<never> => { throw new Error('Home Account unavailable'); };
const unavailable = createHomeHubAccountStore({ accountId: 'unavailable', transport: { read: refuse, create: refuse, update: refuse }, isCurrent: () => false, execute: refuse });

function useHomeHubAccountStore() {
    const credentials = useOptionalAuth()?.credentials ?? null;
    const lifetime = useActiveServerAccountScopeLifetime();
    const scope = lifetime?.scope ?? null;
    const server = useActiveServerSnapshot(credentials !== null);
    let store: Store | typeof unavailable = unavailable;
    let accountId: string | null = null;
    try { if (credentials) accountId = parseToken(credentials.token); } catch { /* Authentication has not established an Account. */ }
    if (credentials && scope && lifetime && accountId === scope.accountId && scope.serverId === server.serverId && server.serverUrl) {
        let byCredentials = stores.get(lifetime);
        if (!byCredentials) { byCredentials = new WeakMap(); stores.set(lifetime, byCredentials); }
        let mounted = byCredentials.get(credentials);
        if (!mounted || !mounted.isCurrent()) {
            const capturedCredentials = credentials;
            const carrier = getActiveServerHomeCarrier();
            const isCurrent = () => {
                const current = getActiveServerSnapshot();
                return lifetime.isCurrent() && current.serverId === server.serverId && current.generation === server.generation
                    && current.serverUrl === server.serverUrl && current.runtimeOrigin === server.runtimeOrigin
                    && current.carrier === server.carrier && getActiveServerHomeCarrier() === carrier;
            };
            let context: ReturnType<typeof captureLazyActionAccountContext> | null = null;
            const controller = new AbortController();
            const getContext = async () => {
                if (!isCurrent()) throw new Error('Home Account scope retired');
                context ??= captureLazyActionAccountContext(server.serverId, controller.signal);
                const account = await context;
                account.assertCurrent();
                if (account.credentials.token !== capturedCredentials.token || !isCurrent()) throw new Error('Home Account scope retired');
                return account;
            };
            const transport: HomeHubArtifactTransportV1 = {
                read: async (id, options) => (await getContext()).workflowArtifacts.read(id, options),
                create: async input => (await getContext()).homeHubArtifactTransport.create(input),
                update: async input => (await getContext()).workflowArtifacts.update(input),
            };
            const approval = createActionApprovalContinuationObserver({ onExecuted: () => {} });
            const stopApprovalObservation = observeActionApprovalContinuation({ observer: approval, scope, isCurrent,
                fetchArtifact: async artifactId => (await getContext()).fetchArtifact(artifactId) });
            const observeApproval = approval.subscribe(() => {
                const snapshot = approval.getSnapshot();
                if (snapshot.settlement) {
                    retirePresentationNotice(`home-layout-approval:${snapshot.settlement.registration.artifactId}`);
                    approval.deliverSettlement();
                } else if (snapshot.approval) {
                    const id = snapshot.approval.artifactId;
                    publishPresentationNotice({ key: `home-layout-approval:${id}`, severity: 'info',
                        message: t('approvals.waitingForYou'), undo: { label: t('approvals.review'),
                            run: () => { if (isCurrent()) router.push(buildApprovalHref(id, scope.serverId)); } } });
                }
            });
            const domain = createHomeHubAccountStore({ accountId: scope.accountId, transport, isCurrent, execute: async intent => {
                if (!isCurrent()) throw new Error('Home Account scope retired');
                const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
                return executeHomeHubLayoutIntent({ intent, scope, transport, execute: createDefaultActionExecutor().execute,
                    signal: controller.signal, onApprovalPending: approval.requestApproval });
            } });
            let references = 0;
            let detach: (() => void) | null = null;
            const artifactId = buildHomeHubArtifactIdV1(scope.accountId);
            mounted = { ...domain, isCurrent, retain() {
                if (++references === 1) {
                    const invalidation = new InvalidateSync(async () => { if (isCurrent()) await domain.refresh(); });
                    const invalidate = () => { if (isCurrent()) invalidation.invalidate(); };
                    const unsubscribe = storage.subscribe(invalidate, { artifacts: [artifactId] });
                    // The layout Artifact's changes while away arrive through the changes catch-up into
                    // `storage` above; a reconnect re-reads only a layout whose last read did not succeed.
                    const reconnect = apiSocket.onReconnected(() => { if (domain.getSnapshot().status !== 'ready') invalidate(); });
                    detach = () => { invalidation.stop(); unsubscribe(); reconnect(); };
                    invalidate();
                }
                return () => { if (references > 0 && --references === 0) { detach?.(); detach = null; } };
            } };
            lifetime.onRetire(() => {
                const pendingApproval = approval.getSnapshot().approval;
                if (pendingApproval) retirePresentationNotice(`home-layout-approval:${pendingApproval.artifactId}`);
                domain.retire();
                controller.abort(); stopApprovalObservation(); observeApproval(); approval.dispose();
                detach?.(); detach = null; if (context) void context.then(account => account.dispose(), () => {});
            });
            byCredentials.set(credentials, mounted);
        }
        store = mounted;
    }
    React.useEffect(() => 'retain' in store ? store.retain() : undefined, [store]);
    return store;
}

/** Home content and setup dismissals ignore write-only presentation changes. */
export function useHomeHubArtifactLayout() {
    const store = useHomeHubAccountStore();
    const select = useShallow((state: ReturnType<typeof store.getSnapshot>) => ({
        layout: state.layout, status: state.status, hasSnapshot: state.hasSnapshot,
        errorCode: state.errorCode, failedIntent: state.failedIntent,
    }));
    const getSnapshot = React.useCallback(() => select(store.getSnapshot()), [select, store]);
    const snapshot = React.useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
    return React.useMemo(() => ({ ...snapshot, dispatch: store.dispatch, retry: store.retry, cancelFailedIntent: store.cancelFailedIntent }), [snapshot, store]);
}

/**
 * Whether Home shows a built-in widget (placed and not hidden), as Home's own Account layout says. A
 * section whose step a widget's empty state already carries reads this one fact (58d AF1: Get set up keeps
 * only what no widget covers); it re-renders only when the answer changes.
 */
export function useHomeHubBuiltinWidgetShown(id: string): boolean {
    const store = useHomeHubAccountStore();
    const getSnapshot = React.useCallback(() => {
        // Until the Account's own layout has been read, whether a widget shows is not known: say no, so a
        // section never drops a step on the strength of the default layout alone.
        const { layout, hasSnapshot } = store.getSnapshot();
        if (!hasSnapshot) return false;
        const hidden = new Set(layout.hidden);
        return flattenWidgetLayoutWidgetsV1(layout.items).some(({ instance }) =>
            instance.definition.kind === 'builtin' && instance.definition.id === id && !hidden.has(instance.id));
    }, [id, store]);
    return React.useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

/** Only write feedback surfaces subscribe to the same Account queue's pending fact. */
export function useHomeHubLayoutWritePending() {
    const store = useHomeHubAccountStore();
    const getSnapshot = React.useCallback(() => store.getSnapshot().isWriting, [store]);
    return React.useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

/** Each editor row observes only its own visibility intent in the surviving Account queue. */
export function useHomeHubSectionVisibilityPending(sectionId: string): boolean | undefined {
    const store = useHomeHubAccountStore();
    const getSnapshot = React.useCallback(() => {
        const intent = store.getSnapshot().pendingIntents.find(entry => entry.kind === 'visibility' && entry.sectionId === sectionId);
        return intent?.kind === 'visibility' ? intent.hidden : undefined;
    }, [sectionId, store]);
    return React.useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}
