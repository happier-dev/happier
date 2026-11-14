import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSocketTransportAdapter } from '@happier-dev/sync-client';
import { SessionMetadataTuplePatchV1Schema } from '@happier-dev/protocol';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createPlainSessionFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { buildSessionMetadataEnvelopeFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { acquireRequesterAccountEncryptionCurrentness } from '@/api/client/accountEncryptionCurrentnessObservation';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import * as sockets from '@/api/session/sockets';
import { ApiSessionClient } from './sessionClient';

// Only Home HTTP is substituted (the Account socket is a real loopback Socket.IO
// channel). The Session client, its default currentness readers, the shared
// Account observation and tuple serialization stay real.
describe('Session client Account encryption currentness usage', () => {
    afterEach(() => vi.restoreAllMocks());

    it('shares one fresh read per Account socket connection across read-only snapshots and keeps writes fresh', async () => {
        const token = `e30.${Buffer.from(JSON.stringify({ sub: 'bob' })).toString('base64url')}.signature`;
        const credentials = { token, encryption: null };
        const metadata = createTestMetadata({ path: '/currentness-socket', flavor: 'claude' });
        const fields = buildSessionMetadataEnvelopeFields({ credentials, accountEncryptionMode: 'plain',
            metadata, agentState: null, storedContentMode: 'plain' });
        let raw = createSessionRecordFixture({ id: 'currentness-socket', encryptionMode: 'plain', metadataLayoutVersion: 1,
            metadata: fields.sharedMetadata.ciphertext, ownerMetadata: fields.ownerMetadata, metadataVersion: 1,
            agentState: null, agentStateVersion: 0, share: null });
        let currentnessReads = 0;
        vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
            const path = new URL(url).pathname;
            if (path === '/v1/account/encryption/currentness') {
                currentnessReads++;
                return { status: 200, data: { mode: 'plain', version: currentnessReads, updatedAt: 1,
                    signingKeyFingerprint: null, contentKeyFingerprint: null } };
            }
            if (path === '/v2/sessions/currentness-socket') return { status: 200, data: { session: raw } };
            return { status: 404, data: {} };
        });
        vi.spyOn(axios, 'patch').mockImplementation(async (_url, body) => {
            const patch = SessionMetadataTuplePatchV1Schema.parse(body);
            if (patch.mode !== 'owner') throw new Error('Expected owner tuple mutation');
            raw = { ...raw, metadata: patch.sharedMetadata.ciphertext, ownerMetadata: patch.ownerMetadata,
                metadataVersion: raw.metadataVersion + 1, agentState: patch.agentState.ciphertext,
                agentStateVersion: raw.agentStateVersion + 1 };
            return { status: 200, data: { success: true, metadataLayoutVersion: 1,
                sharedMetadata: { version: raw.metadataVersion }, agentState: { version: raw.agentStateVersion } } };
        });
        // A session host holds no requester observation: its Account update socket is the transport.
        const channel = await createRequesterCurrentnessSocketHarness();
        const socket = createApiSessionSocketStub({ connected: true });
        const client = new ApiSessionClient(token, createPlainSessionFixture({ id: raw.id, metadataLayoutVersion: 1,
            metadata, metadataVersion: 1, ownerMetadata: fields.ownerMetadataValue, ownerMetadataEnvelope: fields.ownerMetadata }), {
            metadataAuthority: { kind: 'owner', credentials },
            durableMutationDeliveryInitiallyActive: false,
            transport: { serverId: 'currentness-home', serverUrl: resolveServerHttpBaseUrl(),
                createSessionSocketTransport: () => ({ socket: socket as never, transport: createSocketTransportAdapter(socket as never) }),
                // Through the module seam the harness redirects to its loopback Home.
                createAccountUpdatesSocket: () => sockets.createUserScopedSocketConnection({ token, serverUrl: channel.serverUrl }).socket },
        });
        try {
            const before = currentnessReads;
            // A host's provider input consumer keeps this Account socket connected; connect it directly.
            const accountSocket = (client as unknown as { userSocket: { connect(): void; connected: boolean } }).userSocket;
            accountSocket.connect();
            await vi.waitFor(() => expect(accountSocket.connected).toBe(true), { timeout: 15_000 });

            await client.refreshSessionSnapshotFromServerRequired({ reason: 'explicit-drain' });
            await client.refreshSessionSnapshotFromServerRequired({ reason: 'waitForMetadataUpdate' });
            await client.refreshSessionSnapshotFromServerRequired({ reason: 'primaryTurnRuntimeState' });
            expect(currentnessReads - before).toBe(1);

            await client.updateMetadata(current => ({ ...current, summary: { text: 'sealed', updatedAt: 2 } }));
            expect(currentnessReads - before).toBe(2);

            // A pushed identity change replaces the held fact; reads open with the pushed witness.
            await channel.push('bob', { mode: 'plain', version: 99, updatedAt: 2,
                signingKeyFingerprint: null, contentKeyFingerprint: null });
            await client.refreshSessionSnapshotFromServerRequired({ reason: 'explicit-drain' });
            expect(currentnessReads - before).toBe(2);
        } finally {
            await client.close();
            await channel.close();
        }
    });

    it('opens read-only snapshots with the held observation and keeps a fresh Account witness for metadata writes', async () => {
        const token = `e30.${Buffer.from(JSON.stringify({ sub: 'alice' })).toString('base64url')}.signature`;
        const credentials = { token, encryption: null };
        const metadata = createTestMetadata({ path: '/currentness-usage', flavor: 'claude' });
        const fields = buildSessionMetadataEnvelopeFields({ credentials, accountEncryptionMode: 'plain',
            metadata, agentState: null, storedContentMode: 'plain' });
        let raw = createSessionRecordFixture({ id: 'currentness-usage', encryptionMode: 'plain', metadataLayoutVersion: 1,
            metadata: fields.sharedMetadata.ciphertext, ownerMetadata: fields.ownerMetadata, metadataVersion: 1,
            agentState: null, agentStateVersion: 0, share: null });
        let currentnessReads = 0;
        vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
            const path = new URL(url).pathname;
            if (path === '/v1/account/encryption/currentness') {
                currentnessReads++;
                return { status: 200, data: { mode: 'plain', version: currentnessReads, updatedAt: 1,
                    signingKeyFingerprint: null, contentKeyFingerprint: null } };
            }
            if (path === '/v2/sessions/currentness-usage') return { status: 200, data: { session: raw } };
            return { status: 404, data: {} };
        });
        vi.spyOn(axios, 'patch').mockImplementation(async (_url, body) => {
            const patch = SessionMetadataTuplePatchV1Schema.parse(body);
            if (patch.mode !== 'owner') throw new Error('Expected owner tuple mutation');
            raw = { ...raw, metadata: patch.sharedMetadata.ciphertext, ownerMetadata: patch.ownerMetadata,
                metadataVersion: raw.metadataVersion + 1, agentState: patch.agentState.ciphertext,
                agentStateVersion: raw.agentStateVersion + 1 };
            return { status: 200, data: { success: true, metadataLayoutVersion: 1,
                sharedMetadata: { version: raw.metadataVersion }, agentState: { version: raw.agentStateVersion } } };
        });
        const channel = await createRequesterCurrentnessSocketHarness();
        // The host's live Account holder (requester custody, Follow, inventory) holds this exact credential.
        const observation = acquireRequesterAccountEncryptionCurrentness({ accountId: 'alice', token,
            serverBaseUrl: resolveServerHttpBaseUrl() });
        const socket = createApiSessionSocketStub();
        const client = new ApiSessionClient(token, createPlainSessionFixture({ id: raw.id, metadataLayoutVersion: 1,
            metadata, metadataVersion: 1, ownerMetadata: fields.ownerMetadataValue, ownerMetadataEnvelope: fields.ownerMetadata }), {
            metadataAuthority: { kind: 'owner', credentials },
            durableMutationDeliveryInitiallyActive: false,
            transport: { serverId: 'currentness-home', serverUrl: resolveServerHttpBaseUrl(),
                createSessionSocketTransport: () => ({ socket: socket as never, transport: createSocketTransportAdapter(socket as never) }) },
        });
        try {
            await observation.read();
            const held = currentnessReads;

            await client.refreshSessionSnapshotFromServerRequired({ reason: 'explicit-drain' });
            await client.refreshSessionSnapshotFromServerRequired({ reason: 'waitForMetadataUpdate' });
            expect(currentnessReads - held).toBe(0);

            await client.updateMetadata(current => ({ ...current, summary: { text: 'sealed', updatedAt: 2 } }));
            expect(currentnessReads - held).toBe(1);
            expect(client.getMetadataSnapshot()?.summary?.text).toBe('sealed');
        } finally {
            await client.close();
            await observation.dispose();
            await channel.close();
        }
    });

});
