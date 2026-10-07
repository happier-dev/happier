import * as React from 'react';
import { buildHomeHubArtifactIdV1, type HomeHubArtifactTransportV1 } from '@happier-dev/protocol/home';
import { useOptionalAuth } from '@/auth/context/AuthContext';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { storage, useActiveServerAccountScope, useIsDataReady } from '@/sync/domains/state/storage';
import { captureActiveServerAccountScopeLifetime, type ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getActiveServerHomeCarrier, getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { InvalidateSync } from '@/utils/sessions/sync';
import { parseToken } from '@/utils/auth/parseToken';
import { createHomeHubAccountStore } from './homeHubAccountStore';
import { executeHomeHubLayoutIntent } from './homeHubActionWriter';

type Store = ReturnType<typeof createHomeHubAccountStore> & { retain(): () => void; isCurrent(): boolean };
const stores = new WeakMap<ActiveServerAccountScopeLifetime, WeakMap<AuthCredentials, Store>>();
const refuse = async (): Promise<never> => { throw new Error('Home Account unavailable'); };
const unavailable = createHomeHubAccountStore({ accountId: 'unavailable', transport: { read: refuse, create: refuse, update: refuse }, isCurrent: () => false, execute: refuse });

/** Home and setup dismissals share the same captured Account projection and Action write path. */
export function useHomeHubArtifactLayout() {
    const credentials = useOptionalAuth()?.credentials ?? null;
    const scope = useActiveServerAccountScope();
    const ready = useIsDataReady();
    const server = useActiveServerSnapshot(credentials !== null);
    const lifetime = captureActiveServerAccountScopeLifetime();
    let store: Store | typeof unavailable = unavailable;
    let accountId: string | null = null;
    try { if (credentials) accountId = parseToken(credentials.token); } catch { /* Authentication has not established an Account. */ }
    if (ready && credentials && scope && lifetime && accountId === scope.accountId && scope.serverId === server.serverId && server.serverUrl) {
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
            const getContext = async () => {
                if (!isCurrent()) throw new Error('Home Account scope retired');
                context ??= captureLazyActionAccountContext(server.serverId);
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
            const domain = createHomeHubAccountStore({ accountId: scope.accountId, transport, isCurrent, execute: async intent => {
                if (!isCurrent()) throw new Error('Home Account scope retired');
                const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
                return executeHomeHubLayoutIntent({ intent, scope, transport, execute: createDefaultActionExecutor().execute });
            } });
            let references = 0;
            let detach: (() => void) | null = null;
            const artifactId = buildHomeHubArtifactIdV1(scope.accountId);
            mounted = { ...domain, isCurrent, retain() {
                if (++references === 1) {
                    const invalidation = new InvalidateSync(async () => { if (isCurrent()) await domain.refresh(); });
                    const invalidate = () => { if (isCurrent()) invalidation.invalidate(); };
                    const unsubscribe = storage.subscribe((state, previous) => { if (state.artifacts[artifactId] !== previous.artifacts[artifactId]) invalidate(); });
                    const reconnect = apiSocket.onReconnected(invalidate);
                    detach = () => { invalidation.stop(); unsubscribe(); reconnect(); };
                    invalidate();
                }
                return () => { if (references > 0 && --references === 0) { detach?.(); detach = null; } };
            } };
            lifetime.onRetire(() => { detach?.(); detach = null; if (context) void context.then(account => account.dispose(), () => {}); });
            byCredentials.set(credentials, mounted);
        }
        store = mounted;
    }
    React.useEffect(() => 'retain' in store ? store.retain() : undefined, [store]);
    const snapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    return React.useMemo(() => ({ ...snapshot, dispatch: store.dispatch, retry: store.retry, cancelFailedIntent: store.cancelFailedIntent }), [snapshot, store]);
}
