import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConcurrentCacheNetworkHarness } from './harness/concurrentCacheNetworkHarness';
import { createRootLayoutFeaturesResponse } from './fixtures/featureFixtures';
import { createEmptyAccountBootstrapHttpResponse } from './fixtures/accountBootstrapHttpBoundary';

vi.mock('react-native', async () => (await import('./mocks/reactNative')).createReactNativeWebMock());

const h = await createConcurrentCacheNetworkHarness('action-client-lifecycle');
const { connectUiActionClient } = await import('./actionClientIntegrationTestkit');
const { apiSocket } = await import('@/sync/api/session/apiSocket');
const connection = await import('@/sync/runtime/orchestration/connectionManager');
let client: Awaited<ReturnType<typeof connectUiActionClient>> | undefined;

beforeEach(() => h.reset());
afterEach(async () => { await client?.close(); client = undefined; await h.cleanup(); });
afterAll(() => h.dispose());

describe('composed UI Action client Account lifecycle', () => {
    it('reconnects after authenticated discovery learns a Home descriptor absent from public discovery', async () => {
        const homeServerIdentityId = 'srv_action_client_lifecycle';
        const descriptor = { v: 1 as const, homeServerIdentityId, canonicalServerUrl: h.homeA.serverUrl,
            revision: 1, endpoints: [{ kind: 'https' as const, url: h.homeA.serverUrl }] };
        h.setResponder(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/features' || path === '/v1/features/authenticated') {
                return Response.json(createRootLayoutFeaturesResponse({
                    capabilities: { serverIdentity: { serverIdentityId: homeServerIdentityId } },
                    ...(path === '/v1/features/authenticated' ? { homeConnectionDescriptor: descriptor } : {}),
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
        client = await connectUiActionClient({ serverUrl: h.homeA.serverUrl, credentials: { token: h.homeA.token } });
        await vi.waitFor(() => {
            const selected = h.profiles.getActiveServerSnapshot();
            expect(selected.connectionDescriptorRevision).toBe(1);
            expect(selected.carrier).toBe('https');
            expect(connection.getAppliedActiveServerSnapshot()).toMatchObject({
                serverId: selected.serverId, generation: selected.generation,
            });
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
