import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createConcurrentCacheNetworkHarness } from '@/dev/testkit/harness/concurrentCacheNetworkHarness';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import {
    createLegacyAccountEncryptionCurrentnessFixture,
    createPlainAccountEncryptionCurrentnessFixture,
} from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { Encryption, captureEncryptionGenerationCurrentness } from '@/sync/encryption/encryption';
import { resolveScopedAccountEncryption } from '@/sync/encryption/scopedAccountEncryption';
import { encodeBase64 } from '@/encryption/base64';
import { encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import { UpdateContainerSchema } from '@happier-dev/protocol/updates';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/sessionOpsNetworkBoundary')
).createSessionOpsSocketIoClientBoundary(importOriginal));

const h = await createConcurrentCacheNetworkHarness('cache-encryption-lifetime');
beforeEach(() => h.reset());
afterEach(() => h.cleanup());
afterAll(() => h.dispose());

it.each(['durable', 'stream'] as const)('reacquires secondary Home material for a %s push after mode withdrawal', async kind => {
    const { registerSessionRealtimeTranscriptConsumer } = await import('@/sync/runtime/sessionRealtimeTranscriptConsumers');
    const secret = new Uint8Array(32).fill(84);
    // Kept as history after a conversion, so a Home-reported plain is admitted (downgrade pin).
    const credentials = { token: h.homeB.token, secret: encodeBase64(secret, 'base64url'), custody: 'historical' as const };
    await h.network.addHome(h.homeB.serverUrl, h.homeB.accountId, { credentials, encryptionMode: 'e2ee' });
    let currentness = createLegacyAccountEncryptionCurrentnessFixture({ secret });
    h.setResponder(async input => {
        const url = new URL(String(input));
        if (url.origin !== h.homeB.serverUrl) return null;
        if (url.pathname === '/v1/account/encryption/currentness') return Response.json(currentness);
        if (url.pathname === '/v1/account/encryption') return Response.json({ mode: currentness.mode, updatedAt: currentness.updatedAt });
        if (url.pathname.endsWith('/messages')) return Response.json({ messages: [], hasMore: false });
        if (url.pathname.endsWith('/pending')) return Response.json({ pending: [], pendingVersion: 0 });
        return null;
    });
    const id = 'mode-transition-session';
    h.setSessions(h.homeB, [h.session({ id, metadata: { path: '/repo', host: 'host', machineId: 'machine-b' } })]);
    await h.start(); await h.refresh(); await h.ready();
    const release = registerSessionRealtimeTranscriptConsumer(id, h.homeB.id);
    const texts = () => Object.values(h.storage.getState().sessionMessages[id]?.messagesMap ?? {})
        .flatMap(message => message.kind === 'agent-text' ? [message.text] : []);
    try {
        await vi.waitFor(() => expect(h.storage.getState().sessions[id]?.serverId).toBe(h.homeB.id));
        const oldOwner = await resolveScopedAccountEncryption({ serverId: h.homeB.id, serverUrl: h.homeB.serverUrl, credentials });
        currentness = createPlainAccountEncryptionCurrentnessFixture({ version: 2, updatedAt: 2 });
        const socket = h.socket();
        socket.trigger('update', UpdateContainerSchema.parse({ id: 'session-mode-transition', seq: 2, createdAt: 2,
            body: { t: 'update-account', id: h.homeB.accountId, encryptionCurrentness: currentness } }));
        expect(captureEncryptionGenerationCurrentness(oldOwner).isCurrent()).toBe(false);
        const record = { role: 'agent', content: { type: 'acp', agentId: 'codex', data: { type: 'message', message: 'After mode change' } } };
        if (kind === 'durable') {
            socket.trigger('update', UpdateContainerSchema.parse({ id: 'after-mode-message', seq: 3, createdAt: 3,
                body: { t: 'new-message', sid: id, delivery: 'full', message: { id: 'after-mode', seq: 1, localId: null,
                    createdAt: 3, updatedAt: 3, content: { t: 'plain', v: record } } } }));
        } else {
            socket.trigger('ephemeral', { type: 'transcript-stream-segment', sessionId: id,
                message: { localId: 'after-mode-stream', messageRole: 'agent', tick: 1, createdAt: 3, updatedAt: 3,
                    content: { t: 'plain', v: { ...record, meta: { happierStreamSegmentV1: {
                        v: 1, segmentKind: 'assistant', segmentLocalId: 'after-mode-stream', segmentState: 'streaming', startedAtMs: 3, updatedAtMs: 3,
                    } } } } } });
        }
        await vi.waitFor(() => expect(texts()).toContain('After mode change'));
        expect(h.socket()).toBe(socket);
    } finally { release(); }
});

it.each(['secondary', 'focused'] as const)('refreshes a retained %s Home across same-credential Account mode changes in both directions', async placement => {
    const home = placement === 'focused' ? h.homeA : h.homeB;
    const { getSyncSingleton } = await import('@/sync/runtime/getSyncSingleton');
    const refresh = async () => placement === 'focused' ? getSyncSingleton().refreshMachines() : h.refreshConcurrentMachineList(home.id);
    const machines = () => placement === 'focused' ? Object.values(h.storage.getState().machines)
        : h.storage.getState().machineListByServerId[home.id];
    const secret = new Uint8Array(32).fill(83);
    // Kept as history after a conversion, so a Home-reported plain is admitted (downgrade pin).
    const credentials = { token: home.token, secret: encodeBase64(secret, 'base64url'), custody: 'historical' as const };
    await h.network.addHome(home.serverUrl, home.accountId, { credentials, encryptionMode: 'e2ee' });
    const encryptedCurrentness = createLegacyAccountEncryptionCurrentnessFixture({ secret });
    const plainCurrentness = createPlainAccountEncryptionCurrentnessFixture({ version: 2, updatedAt: 2 });
    let currentness = encryptedCurrentness;
    h.setResponder(async input => {
        const url = new URL(String(input));
        if (url.origin !== home.serverUrl) return null;
        if (url.pathname === '/v1/account/encryption/currentness') return Response.json(currentness);
        if (url.pathname === '/v1/account/encryption') return Response.json({ mode: currentness.mode, updatedAt: currentness.updatedAt });
        return null;
    });
    const id = 'mode-transition-machine';
    const writer = await Encryption.create(secret);
    writer.configureNativeCryptoWorker({ routing: { mode: 'off' } });
    const key = new Uint8Array(32).fill(27);
    await writer.initializeMachines(new Map([[id, key]]));
    const cipher = writer.getMachineEncryption(id)!;
    const encryptedRow = async (version: number) => {
        const row = h.machine(home, id);
        return { ...row, metadataVersion: version, daemonStateVersion: version,
            metadata: await cipher.encryptMetadata({ ...createMachineFixture().metadata!, displayName: `Encrypted ${version}` }),
            daemonState: await cipher.encryptDaemonState({ status: 'running', pid: version }),
            dataEncryptionKey: encodeBase64(await writer.encryptEncryptionKey(key)),
            access: { ...row.access!, resourceMode: 'e2ee' as const },
        };
    };
    h.setMachines(home, [await encryptedRow(1)]);
    if (placement === 'focused') await h.startFocused(credentials);
    else { await h.start(); await h.refresh(); await h.ready(); }
    await refresh();
    expect(machines()?.find(row => row.id === id)?.metadata?.displayName).toBe('Encrypted 1');
    const oldOwner = await resolveScopedAccountEncryption({ serverId: home.id, serverUrl: home.serverUrl, credentials });
    expect(captureEncryptionGenerationCurrentness(oldOwner).isCurrent()).toBe(true);
    let socket = h.socket(home);
    currentness = plainCurrentness;
    h.setMachines(home, [{ ...h.machine(home, id), metadataVersion: 2, daemonStateVersion: 2,
        metadata: encodePlainMachineStoredContent({ ...createMachineFixture().metadata!, displayName: 'Plain 2' }),
        daemonState: encodePlainMachineStoredContent({ status: 'running', pid: 2 }),
    }]);
    const pushMode = () => socket.trigger('update', UpdateContainerSchema.parse({ id: `mode-${currentness.version}`,
        seq: currentness.version, createdAt: currentness.updatedAt,
        body: { t: 'update-account', id: home.accountId, encryptionCurrentness: currentness },
    }));
    pushMode();
    expect(captureEncryptionGenerationCurrentness(oldOwner).isCurrent()).toBe(false);
    if (placement === 'focused') await vi.waitFor(() => expect(machines()?.find(row => row.id === id)?.metadata?.displayName).toBe('Plain 2'));
    await refresh();
    if (placement === 'secondary') expect(h.socket(home)).toBe(socket);
    socket = h.socket(home);
    expect(machines()?.find(row => row.id === id)?.metadata?.displayName).toBe('Plain 2');
    expect(await resolveScopedAccountEncryption({ serverId: home.id, serverUrl: home.serverUrl, credentials })).toBeNull();
    const settled = machines();
    const modeReads = h.requests('/v1/account/encryption/currentness').length;
    for (let index = 0; index < 3; index++) {
        pushMode();
        await refresh();
    }
    if (placement === 'secondary') expect(machines()).toBe(settled);
    expect(h.requests('/v1/account/encryption/currentness')).toHaveLength(modeReads);

    currentness = { ...createLegacyAccountEncryptionCurrentnessFixture({ secret }), version: 3, updatedAt: 3 };
    h.setMachines(home, [await encryptedRow(3)]);
    pushMode();
    if (placement === 'focused') await vi.waitFor(() => expect(machines()?.find(row => row.id === id)?.metadata?.displayName).toBe('Encrypted 3'));
    await refresh();
    if (placement === 'secondary') expect(h.socket(home)).toBe(socket);
    expect(machines()?.find(row => row.id === id)?.metadata?.displayName).toBe('Encrypted 3');
    const newOwner = await resolveScopedAccountEncryption({ serverId: home.id, serverUrl: home.serverUrl, credentials });
    expect(newOwner).not.toBeNull();
    expect(newOwner === oldOwner).toBe(false);
    expect(captureEncryptionGenerationCurrentness(newOwner).isCurrent()).toBe(true);
    expect(captureEncryptionGenerationCurrentness(oldOwner).isCurrent()).toBe(false);
});
