import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConcurrentCacheNetworkHarness } from './harness/concurrentCacheNetworkHarness';
import { createRootLayoutFeaturesResponse } from './fixtures/featureFixtures';
import { createEmptyAccountBootstrapHttpResponse } from './fixtures/accountBootstrapHttpBoundary';
import { createDeferred } from './hooks/createDeferred';
import { flushHookEffects } from './hooks/flushHookEffects';

vi.mock('react-native', async () => (await import('./mocks/reactNative')).createReactNativeWebMock());

const h = await createConcurrentCacheNetworkHarness('action-client-lifecycle');
const { connectUiActionClient } = await import('./actionClientIntegrationTestkit');
const { apiSocket } = await import('@/sync/api/session/apiSocket');
const connection = await import('@/sync/runtime/orchestration/connectionManager');
// Load the real lifecycle before holding HTTP so module loading cannot stand in
// for waiting on authenticated discovery in this readiness assertion.
await Promise.all([import('@/auth/context/AuthContext'), import('./hooks/renderHook')]);
let client: Awaited<ReturnType<typeof connectUiActionClient>> | undefined;

beforeEach(() => h.reset());
afterEach(async () => { await client?.close(); client = undefined; await h.cleanup(); });
afterAll(() => h.dispose());

describe('composed UI Action client Account lifecycle', () => {
    it.each(['cold', 'warm'] as const)('awaits authenticated Home discovery with a %s cache before returning a reconnectable client', async cache => {
        const homeServerIdentityId = 'srv_action_client_lifecycle';
        const descriptor = { v: 1 as const, homeServerIdentityId, canonicalServerUrl: h.homeA.serverUrl,
            revision: 1, endpoints: [{ kind: 'https' as const, url: h.homeA.serverUrl }] };
        let revision = 1;
        let holdAuthenticatedResponse = cache === 'cold';
        const authenticatedRequest = createDeferred<void>();
        const authenticatedResponse = createDeferred<void>();
        h.setResponder(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/features/authenticated' && holdAuthenticatedResponse) {
                authenticatedRequest.resolve();
                await authenticatedResponse.promise;
            }
            if (path === '/v1/features' || path === '/v1/features/authenticated') {
                return Response.json(createRootLayoutFeaturesResponse({
                    capabilities: { serverIdentity: { serverIdentityId: homeServerIdentityId } },
                    ...(path === '/v1/features/authenticated' ? { homeConnectionDescriptor: { ...descriptor, revision } } : {}),
                }));
            }
            if (path === '/v1/account/profile') {
                const { profileDefaults } = await import('@/sync/domains/profiles/profile');
                return Response.json({ ...profileDefaults, id: h.homeA.accountId });
            }
            if (path === '/v1/artifacts') return Response.json([]);
            if (path === '/v1/friends' || path === '/v1/friends/requests') return Response.json({ friends: [], requests: [] });
            return createEmptyAccountBootstrapHttpResponse(path, init);
        });
        if (cache === 'warm') {
            client = await connectUiActionClient({ serverUrl: h.homeA.serverUrl, credentials: { token: h.homeA.token } });
            expect(h.profiles.getActiveServerSnapshot().connectionDescriptorRevision).toBe(1);
            await client.close();
            client = undefined;
            // Keep the real feature client's fresh snapshot across the same-Home
            // reconnect; only the server's next authenticated response changes.
            revision = 2;
            holdAuthenticatedResponse = true;
        }
        let returned = false;
        const connecting = connectUiActionClient({ serverUrl: h.homeA.serverUrl, credentials: { token: h.homeA.token } })
            .then(value => { client = value; returned = true; return value; });
        try {
            await authenticatedRequest.promise;
            await vi.waitFor(() => expect(h.storage.getState().isDataReady).toBe(true));
            await flushHookEffects();
            await new Promise<void>(resolve => setImmediate(resolve));
            await flushHookEffects();
            expect(returned, 'authenticated Home discovery still owns client readiness').toBe(false);
        } finally {
            authenticatedResponse.resolve();
            await connecting;
        }
        const selected = h.profiles.getActiveServerSnapshot();
        expect(selected.connectionDescriptorRevision).toBe(revision);
        expect(selected.carrier).toBe('https');
        expect(connection.getAppliedActiveServerSnapshot()).toMatchObject({
            serverId: selected.serverId, generation: selected.generation,
        });
        const statuses: string[] = [];
        const release = apiSocket.onStatusChange(status => statuses.push(status));
        try {
            apiSocket.disconnect({ preserveHttpRequests: true });
            apiSocket.connect();
            await vi.waitFor(() => expect(statuses.at(-1)).toBe('connected'));
        } finally { release(); }
    });
});
