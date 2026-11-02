import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { TokenStorage } from '@/auth/storage/tokenStorage';

import { requestLiveStreamRelayAuthorization } from './productionRouteHttp';

const homes = createHomeGovernanceHarness();
const serverUrl = 'https://stream-grant.test';
let serverId: string;

beforeEach(async () => {
    installHomeGovernanceBoundaries(homes);
    serverId = await homes.addHome({ name: 'Stream grant Home', serverUrl, accountId: 'owner', active: false });
});

afterEach(async () => { await homes.reset(); });

describe('live stream grant refusal diagnostics', () => {
    it.each([
        { status: 403, body: { ok: false, reasonCode: 'viewer_socket_not_owned' }, reasonCode: 'viewer_socket_not_owned' },
        { status: 503, body: { ok: false, reasonCode: 'signing_unavailable' }, reasonCode: 'signing_unavailable' },
        { status: 503, body: null, reasonCode: 'http_5xx' },
    ])('preserves the refusal for HTTP $status ($reasonCode)', async ({ status, body, reasonCode }) => {
        homes.answer(serverId, 'POST /v1/machines/peer/mediation/route-grants', { status, body });
        const credentials = await TokenStorage.getCredentialsForServerUrl(serverUrl);
        if (!credentials) throw new Error('Expected the saved owner credential');
        const result = await requestLiveStreamRelayAuthorization({
            server: { serverId, serverUrl },
            credentials,
            startRequest: {
                v: 1, streamId: 'session-browser', streamFamily: 'browser', sourceId: 'session-view',
                routeKind: 'server_relay', sourceMachineId: 'machine', targetMachineId: 'machine', viewerSocketId: 'owner-tab',
            },
        });
        expect(homes.requestsFor('/v1/machines/peer/mediation/route-grants')).toHaveLength(1);
        expect(result).toEqual({ ok: false, reasonCode });
    });

    it('preserves a request exception class without its message', async () => {
        homes.answer(serverId, 'POST /v1/machines/peer/mediation/route-grants', {
            select: () => { throw new TypeError('Sensitive transport address must stay private'); },
        });
        const credentials = await TokenStorage.getCredentialsForServerUrl(serverUrl);
        if (!credentials) throw new Error('Expected the saved owner credential');
        const result = await requestLiveStreamRelayAuthorization({
            server: { serverId, serverUrl }, credentials,
            startRequest: {
                v: 1, streamId: 'session-browser', streamFamily: 'browser', routeKind: 'server_relay',
                sourceMachineId: 'machine', targetMachineId: 'machine', viewerSocketId: 'owner-tab',
            },
        });
        expect(result).toEqual({ ok: false, reasonCode: 'TypeError' });
    });
});
