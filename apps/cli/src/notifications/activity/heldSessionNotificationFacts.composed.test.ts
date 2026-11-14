import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSocketTransportAdapter } from '@happier-dev/sync-client';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createPlainSessionFixture, createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { PushNotificationClient } from '@/api/pushNotifications';
import * as sockets from '@/api/session/sockets';
import { ApiSessionClient } from '@/api/session/sessionClient';

// Only Home HTTP is substituted; the Account socket is a real loopback Socket.IO channel.
describe('held Session notification facts', () => {
    afterEach(() => vi.restoreAllMocks());

    it('reads notification context and mutes once per change the live owner client is pushed', async () => {
        const token = `e30.${Buffer.from(JSON.stringify({ sub: 'dana' })).toString('base64url')}.signature`;
        const sessionId = 'notify-held';
        let contextReads = 0;
        let muteReads = 0;
        vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
            const path = new URL(url).pathname;
            if (path === `/v2/sessions/${sessionId}`) {
                contextReads++;
                return { status: 200, data: { session: createSessionNotificationContextFixture(sessionId) } };
            }
            if (path.includes('mute')) { muteReads++; return { status: 200, data: { scopes: [] } }; }
            if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
                updatedAt: 1, signingKeyFingerprint: null, contentKeyFingerprint: null } };
            return { status: 404, data: {} };
        });
        const channel = await createRequesterCurrentnessSocketHarness();
        const socket = createApiSessionSocketStub({ connected: true });
        const client = new ApiSessionClient(token, createPlainSessionFixture({ id: sessionId,
            metadata: createTestMetadata({ path: '/notify', flavor: 'claude' }), metadataVersion: 1 }), {
            metadataAuthority: { kind: 'owner', credentials: { token, encryption: null } },
            durableMutationDeliveryInitiallyActive: false,
            transport: { serverId: 'notify-home', serverUrl: resolveServerHttpBaseUrl(),
                createSessionSocketTransport: () => ({ socket: socket as never, transport: createSocketTransportAdapter(socket as never) }),
                createAccountUpdatesSocket: () => sockets.createUserScopedSocketConnection({ token, serverUrl: channel.serverUrl }).socket },
        });
        // This fixture serves no Home feature contract, whose absence would retire the live Session
        // transport; keep it up so its pushes stay attached, as in a connected host.
        socket.disconnect = vi.fn(() => socket);
        socket.removeAllListeners = vi.fn(() => socket);
        const push = new PushNotificationClient(token, resolveServerHttpBaseUrl());
        const turn = async () => {
            await push.fetchSessionNotificationContext(sessionId);
            await push.readAccountSessionDeliveryMutedScopes();
        };
        const wake = async (entityIds: readonly string[]) => {
            for (const peer of channel.server.sockets.sockets.values()) peer.emit('update', { id: `wake-${entityIds.join()}`, seq: 9,
                createdAt: 1, body: { t: 'account-change', changeKinds: ['account'], entityIds } });
            await new Promise(resolve => setTimeout(resolve, 100));
        };
        try {
            // Wait until the live Session socket carries its handlers (after any startup transport retirement).
            const sessionHandlers = () => (socket.on as unknown as { mock: { calls: unknown[][] } }).mock.calls
                .filter(call => call[0] === 'session').length;
            await vi.waitFor(() => {
                expect((client as unknown as { socket: { connected: boolean } | null }).socket?.connected).toBe(true);
                expect(sessionHandlers()).toBeGreaterThan(0);
            }, { timeout: 15_000 });
            // A provider input consumer keeps the Account socket connected in a host.
            const accountSocket = (client as unknown as { userSocket: { connect(): void; connected: boolean } }).userSocket;
            accountSocket.connect();
            await vi.waitFor(() => expect(accountSocket.connected).toBe(true), { timeout: 15_000 });

            for (let index = 0; index < 3; index++) await turn();
            expect({ contextReads, muteReads }).toEqual({ contextReads: 1, muteReads: 1 });

            // An unrelated Account change keeps the facts; a Follow/mute change drops them.
            await wake(['prompt-library']);
            await turn();
            expect({ contextReads, muteReads }).toEqual({ contextReads: 1, muteReads: 1 });
            await wake(['session-follows']);
            await turn();
            expect({ contextReads, muteReads }).toEqual({ contextReads: 2, muteReads: 2 });

            // A Session relation push drops the Session facts only.
            (socket as unknown as { trigger(event: string, ...args: unknown[]): void }).trigger('session',
                { id: 'relation', createdAt: 1, body: { t: 'session-changed', sessionId } });
            await turn();
            expect({ contextReads, muteReads }).toEqual({ contextReads: 3, muteReads: 2 });
        } finally {
            await client.close();
            await channel.close();
        }
        // Without a live holder every read goes to Home.
        await turn();
        await turn();
        expect({ contextReads, muteReads }).toEqual({ contextReads: 5, muteReads: 4 });
    });
});
