import { EventEmitter } from 'node:events';
import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSocketTransportAdapter } from '@happier-dev/sync-client';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createPlainSessionFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { buildSessionMetadataEnvelopeFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { openAccountUpdatesSocket, shareAccountUpdatesInThisProcess } from './sharedAccountUpdatesSocket';
import { ApiSessionClient } from './sessionClient';

/** The Account update connection as the server side of socket.io presents it (the network boundary). */
class FakeAccountServerSocket extends EventEmitter {
    connected = false;
    active = false;
    connect() {
        this.active = true;
        queueMicrotask(() => { this.connected = true; this.emit('connect'); });
        return this;
    }
    disconnect() { this.active = false; this.connected = false; return this; }
    close() { return this.disconnect(); }
    onAny(listener: (event: string, ...args: unknown[]) => void) {
        const emit = this.emit.bind(this);
        this.emit = (event: string | symbol, ...args: unknown[]) => {
            if (typeof event === 'string' && event !== 'connect' && event !== 'disconnect') listener(event, ...args);
            return emit(event, ...args);
        };
        return this;
    }
}

const tokenFor = (accountId: string) => `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;

// Only Home HTTP, the Session sockets and the Account server socket are substituted. Session clients,
// the host's shared Account update connection, wake routing and the changes owner stay real.
describe('session host Account wakes', () => {
    afterEach(() => vi.restoreAllMocks());

    it('reads each Account\'s changes once per wake for all of its Sessions and never for another Account', async () => {
        shareAccountUpdatesInThisProcess();
        const feeds = new Map<string, Array<{ cursor: number; kind: string; entityId: string; changedAt: number }>>([
            ['dana', []], ['erin', []],
        ]);
        const changesReads = new Map<string, number>([['dana', 0], ['erin', 0]]);
        const accountOf = (config: unknown): string => {
            const header = (config as { headers?: Record<string, string> })?.headers?.Authorization ?? '';
            return JSON.parse(Buffer.from(header.replace(/^Bearer /u, '').split('.')[1]!, 'base64url').toString('utf8')).sub;
        };
        const records = new Map<string, ReturnType<typeof createSessionRecordFixture>>();
        vi.spyOn(axios, 'get').mockImplementation(async (url: string, config?: unknown) => {
            const parsed = new URL(url);
            const accountId = accountOf(config);
            if (parsed.pathname === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
                updatedAt: 1, signingKeyFingerprint: null, contentKeyFingerprint: null } };
            if (parsed.pathname === '/v1/account/profile') return { status: 200, data: { id: accountId } };
            if (parsed.pathname === '/v2/changes') {
                changesReads.set(accountId, changesReads.get(accountId)! + 1);
                const after = Number(parsed.searchParams.get('after') ?? '0');
                const changes = feeds.get(accountId)!.filter(change => change.cursor > after);
                return { status: 200, data: { changes, nextCursor: changes.at(-1)?.cursor ?? after } };
            }
            const sessionId = /^\/v2\/sessions\/([^/]+)$/u.exec(parsed.pathname)?.[1];
            if (sessionId && records.has(sessionId)) return { status: 200, data: { session: records.get(sessionId) } };
            return { status: 404, data: {} };
        });

        const servers = new Map<string, FakeAccountServerSocket>();
        const clients: ApiSessionClient[] = [];
        const open = (sessionId: string, accountId: string) => {
            const token = tokenFor(accountId);
            const credentials = { token, encryption: null };
            const metadata = createTestMetadata({ path: `/${sessionId}`, flavor: 'claude' });
            const fields = buildSessionMetadataEnvelopeFields({ credentials, accountEncryptionMode: 'plain',
                metadata, agentState: null, storedContentMode: 'plain' });
            const raw = createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', metadataLayoutVersion: 1,
                metadata: fields.sharedMetadata.ciphertext, ownerMetadata: fields.ownerMetadata, metadataVersion: 1,
                agentState: null, agentStateVersion: 0, share: null });
            records.set(sessionId, raw);
            const socket = createApiSessionSocketStub({ connected: true });
            socket.disconnect = vi.fn(() => socket);
            const serverUrl = resolveServerHttpBaseUrl();
            const client = new ApiSessionClient(token, createPlainSessionFixture({ id: sessionId, metadataLayoutVersion: 1,
                metadata, metadataVersion: 1, ownerMetadata: fields.ownerMetadataValue, ownerMetadataEnvelope: fields.ownerMetadata }), {
                metadataAuthority: { kind: 'owner', credentials },
                durableMutationDeliveryInitiallyActive: false,
                transport: { serverId: 'host-home', serverUrl,
                    createSessionSocketTransport: () => ({ socket: socket as never, transport: createSocketTransportAdapter(socket as never) }),
                    createAccountUpdatesSocket: () => openAccountUpdatesSocket(`${serverUrl}\n${token}`, () => {
                        const server = new FakeAccountServerSocket();
                        servers.set(accountId, server);
                        return server as never;
                    }) },
            });
            // A hosted Session's runtime consumes its provider input: the demand that holds the Account stream.
            client.onUserMessage(() => {});
            clients.push(client);
            return client;
        };
        const wake = (accountId: string, body: Record<string, unknown>) => servers.get(accountId)!.emit('update',
            { id: `w-${Math.random()}`, seq: 1, createdAt: 1, body: { t: 'account-change', ...body } });
        const settled = async () => {
            const snapshot = () => JSON.stringify([...changesReads]);
            for (let last = snapshot(); ; last = snapshot()) {
                await new Promise(resolve => setTimeout(resolve, 500));
                if (snapshot() === last) return;
            }
        };

        try {
            open('host-s1', 'dana');
            open('host-s2', 'dana');
            open('host-s3', 'erin');
            // One Account update connection per Account in the host.
            expect(servers.size).toBe(2);
            await vi.waitFor(() => expect(servers.get('dana')!.connected && servers.get('erin')!.connected).toBe(true), { timeout: 15_000 });
            await settled();
            const before = new Map(changesReads);

            // A wake naming one of dana's Sessions, then an Account-row wake: one feed read per wake for
            // dana's two Sessions together, none for erin.
            feeds.get('dana')!.push({ cursor: 1, kind: 'session', entityId: 'host-s1', changedAt: 1 });
            wake('dana', { changeKinds: ['session'], entityIds: ['host-s1'] });
            await vi.waitFor(() => expect(changesReads.get('dana')! - before.get('dana')!).toBeGreaterThanOrEqual(1), { timeout: 15_000 });
            await settled();
            const afterFirstWake = changesReads.get('dana')! - before.get('dana')!;
            feeds.get('dana')!.push({ cursor: 2, kind: 'account', entityId: 'self', changedAt: 2 });
            wake('dana', { changeKinds: ['account'], entityIds: ['self'] });
            await vi.waitFor(() => expect(changesReads.get('dana')! - before.get('dana')!).toBeGreaterThanOrEqual(2), { timeout: 15_000 });
            await settled();
            expect([afterFirstWake, changesReads.get('dana')! - before.get('dana')!]).toEqual([1, 2]);
            expect(changesReads.get('erin')! - before.get('erin')!).toBe(0);
        } finally {
            await Promise.all(clients.map(client => client.close()));
        }
    }, 60_000);
});
