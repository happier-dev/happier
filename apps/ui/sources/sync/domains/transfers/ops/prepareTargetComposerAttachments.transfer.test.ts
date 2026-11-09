import 'fake-indexeddb/auto';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DIRECT_TRANSFER_SESSION_EXPIRES_AT_HEADER } from '@happier-dev/protocol/machines/transfer/directPeerUrls';
import { ComposerAttachmentDraftV1Schema } from '@happier-dev/protocol/runtime/input/composerAttachmentV1';
import { ComposerContentHandleV1Schema, MAX_COMPOSER_CONTENT_INSPECT_BYTES_V1 } from '@happier-dev/protocol/runtime/input/composerContentV1';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createTransferRecipientKeyPair, createEncryptedTransferChunkEnvelope, decryptEncryptedTransferChunkEnvelope } from '../runtime/transferRuntime/plumbing/transferChunkEncryption';

const rpc = vi.hoisted(() => vi.fn());
// Only physical network and native tunnel adapters are replaced. Routing,
// inspection, encrypted chunks, reader, upload and final-handle checks stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc', () => ({
    callGuardedMachineRpcWithPolicy: (...args: unknown[]) => rpc(...args),
}));
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock({ platformOS: 'ios' }));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@/sync/runtime/nativeIrohTunnels/machineTransferLifecycle', () => ({
    getIrohApplicationEndpoint: async () => ({ endpointId: 'b'.repeat(64) }),
    probeIrohMachineTransferLifecycleAvailability: async () => true,
    isIrohMachineTransferLifecycleAvailable: () => true,
    startIrohMachineTransferTunnel: async () => ({ localOrigin: 'http://127.0.0.1:48124', release: async () => {} }),
}));
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { prepareTargetComposerAttachments } = await import('./prepareTargetComposerAttachments');
const { storage } = await import('@/sync/domains/state/storage');
const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
const modalShow = vi.mocked((await import('@/modal')).Modal.show);

let serverId: string;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const endpoint = (id: string) => `http://127.0.0.1:46001/machine-transfers/direct/${Buffer.from(id).toString('base64url')}`;

beforeEach(async () => {
    rpc.mockReset();
    modalShow.mockReset().mockImplementation(config => {
        // The native modal's generic props are narrowed for this recovery UI.
        const props = config.props as { onResolve(action: 'retry_finalize'): void };
        queueMicrotask(() => props.onResolve('retry_finalize'));
        return 'recovery-modal';
    });
    installHomeGovernanceBoundaries(homes);
    serverId = await homes.addHome({ name: 'Media transfer', serverUrl: 'https://media-transfer.test', accountId: 'account-a' });
    // This fixture owns an empty Session census; let real Sync finish its
    // bootstrap instead of leaving an unrelated legacy-list retry behind.
    for (const path of ['/v2/sessions', '/v2/sessions/active', '/v2/session-organization', '/v2/sessions/query']) {
        homes.answer(serverId, `${path.endsWith('/query') ? 'POST' : 'GET'} ${path}`, { select: async (_input, request) => {
            const response = createEmptyAccountBootstrapHttpResponse(path, request.init);
            if (!response) throw new Error('Missing empty Account bootstrap fixture');
            return { body: await response.json() };
        } });
    }
    homes.answer(serverId, '/v1/features', { body: FeaturesResponseSchema.parse({ features: { machines: {
        enabled: true, transfer: { enabled: true, directPeer: { enabled: true } }, peerMediation: { enabled: true },
    } }, capabilities: {} }) });
    homes.answer(serverId, 'POST /v1/machines/peer/mediation/route-grants', { select: input => {
        const request = input as { machineId: string; scope: unknown; ephemeralPublicKeyBase64Url: string; iroh: unknown; endpointFingerprint: string };
        return { body: { ok: true, grant: { payload: { v: 2, grantId: 'grant-a', accountId: 'account-a',
            machineId: request.machineId, flowKind: 'bounded_transfer', routeKind: 'iroh_peer', scope: request.scope,
            iat: Date.now(), exp: Date.now() + 60_000, aud: 'happier-daemon-route-grant', endpointFingerprint: request.endpointFingerprint,
            proofKind: 'ephemeral_ed25519', ephemeralPublicKeyBase64Url: request.ephemeralPublicKeyBase64Url, iroh: request.iroh },
            signature: { keyId: 'key-a', alg: 'Ed25519', valueBase64Url: Buffer.alloc(64, 4).toString('base64url') } } } };
    } });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://media-transfer.test', accountId: 'account-a', request: homes.request });
    storage.getState().applyMachines(['source-machine', 'target-machine'].map(id => createMachineFixture({ id,
        daemonState: { status: 'running', transfer: { supported: { import: true, export: true },
            listenerClasses: { loopback_http: { enabled: true, configured: true, active: false },
                tailscale_serve_https: { enabled: false, configured: false, active: false } }, lifecycle: { mode: 'lazy_idle_shutdown', version: 1 } } },
        operationProtocolCapabilities: { irohMachineEndpoint: { protocolVersions: [1], endpointId: 'a'.repeat(64), relayUrls: ['https://relay.test'] } },
        operationProtocolCapabilitiesRevision: 1,
    })));
});
afterEach(async () => { await connection?.dispose(); await homes.reset(); vi.restoreAllMocks(); });

describe('target Composer media byte transfer', () => {
    it.each(['accepted', 'mixed', 'large_chunk', 'reused_target_snapshot', 'retired_after_upload', 'claim_rejected', 'cancel_during_upload',
        'recover_finalize', 'retired_after_recovery', 'recovery_unavailable'] as const)('reads only frozen source bytes and settles only real target handles (%s)', async outcome => {
        const bytes = outcome === 'large_chunk'
            ? Uint8Array.from({ length: MAX_COMPOSER_CONTENT_INSPECT_BYTES_V1 + 7 }, (_, index) => index % 251)
            : new Uint8Array([0, 255, 128, 42, 13, 10, 99]);
        const cancellation = new AbortController();
        const recipient = createTransferRecipientKeyPair();
        const executionTarget = { serverId, machineId: 'target-machine' };
        const sourceComposerRef = { kind: 'session', sessionId: 'source-session' } as const;
        const targetComposerRef = { kind: 'session', sessionId: 'target-session' } as const;
        const source = ComposerContentHandleV1Schema.parse({ v: 1, id: 'frozen-source',
            executionTarget: { serverId, machineId: 'source-machine' }, owner: { pluginId: 'com.example.media', localId: 'image' },
            mediaKind: 'image', mimeType: 'image/png', name: 'picture.png', sizeBytes: bytes.length, sha256: sha256(bytes) });
        const uploaded = { ...source, id: 'uploaded-target', executionTarget };
        const snapshot = { ...uploaded, id: 'immutable-target-snapshot' };
        const attachment = ComposerAttachmentDraftV1Schema.parse({ v: 1, instanceId: 'attachment-a', attachment: source.owner,
            key: 'photo', value: { caption: 'unchanged' }, presentation: { label: 'Picture', typeLabel: 'Image' },
            content: { kind: 'stagedMedia', handle: source } });
        const localSource = { ...source, id: 'same-machine-source', executionTarget };
        const localSnapshot = { ...localSource, id: 'same-machine-target-snapshot' };
        const localAttachment = { ...attachment, instanceId: 'attachment-local', key: 'local-photo', content: { kind: 'stagedMedia' as const, handle: localSource } };
        const { content: _content, ...contentlessAttachment } = { ...attachment, instanceId: 'context-only', key: 'context' };
        const inspections: Array<{ offset: number; maxBytes: number }> = [];
        const ranges = new Map<string, Uint8Array>();
        const encrypted = new Map<string, Awaited<ReturnType<typeof createEncryptedTransferChunkEnvelope>>>();
        const received: number[] = [];
        let current = true;
        let finalizeCalls = 0;
        if (outcome === 'recovery_unavailable') modalShow.mockReturnValue('');
        rpc.mockImplementation(async (call: { method: string; machineId: string; payload: Record<string, unknown> }) => {
            if (call.method === RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE) {
                expect(call.machineId).toBe('source-machine');
                expect(call.payload.handle).toEqual(source);
                expect(call.payload.sessionId).toBe(sourceComposerRef.sessionId);
                const offset = Number(call.payload.offset); const maxBytes = Number(call.payload.maxBytes);
                expect(maxBytes).toBeLessThanOrEqual(MAX_COMPOSER_CONTENT_INSPECT_BYTES_V1);
                inspections.push({ offset, maxBytes });
                const id = `range-${ranges.size}`; const range = bytes.slice(offset, offset + maxBytes); ranges.set(id, range);
                return { success: true, transferId: id, name: source.name, sizeBytes: range.length,
                    manifestHash: `sha256:${sha256(range)}`, expiresAt: Date.now() + 60_000,
                    endpointCandidates: [{ kind: 'http', url: endpoint(id), expiresAt: Date.now() + 60_000 }] };
            }
            if (call.method === RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_PREPARE) {
                expect(call.machineId).toBe('target-machine');
                expect(call.payload).toMatchObject({ executionTarget, sha256: source.sha256, sizeBytes: bytes.length });
                return { success: true, uploadId: 'target-upload', destDisplayPath: '/opaque-stage', expectedSizeBytes: bytes.length,
                    chunkSizeBytes: outcome === 'large_chunk' ? bytes.length : 3, recipientPublicKeyBase64: recipient.recipientPublicKeyBase64, expiresAt: Date.now() + 60_000,
                    endpointCandidates: [{ kind: 'http', url: 'http://127.0.0.1:46001/machine-transfers/direct/imports/target-upload', expiresAt: Date.now() + 60_000 }] };
            }
            if (call.method === RPC_METHODS.DAEMON_TRANSFER_COMPOSER_MEDIA_CLAIM) {
                expect(call.machineId).toBe('target-machine');
                if (outcome === 'claim_rejected') return { success: false, error: 'Target unavailable' };
                if (call.payload.handle && typeof call.payload.handle === 'object' && 'id' in call.payload.handle
                    && call.payload.handle.id === localSource.id) {
                    expect(call.payload).toMatchObject({ claimant: { composer: sourceComposerRef, attachmentInstanceId: localAttachment.instanceId },
                        submission: { destinationComposerRef: targetComposerRef, messageLocalId: 'message-a' } });
                    return { success: true, newlyAcquired: true, handle: localSnapshot };
                }
                return { success: true, newlyAcquired: call.payload.submission ? outcome !== 'reused_target_snapshot' : true,
                    ...(call.payload.submission ? { handle: snapshot } : {}) };
            }
            if (call.method === RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_RELEASE
                || call.method === RPC_METHODS.DAEMON_TRANSFER_COMPOSER_MEDIA_RELEASE) return { success: true };
            throw new Error(`Unexpected RPC ${call.method}`);
        });
        setRuntimeFetch(async (input, init) => {
            const url = new URL(String(input));
            if (url.hostname !== '127.0.0.1') return homes.request(input, init);
            if (url.pathname.includes('/imports/')) {
                if (url.pathname.includes('/chunks/')) {
                    const body = JSON.parse(String(init?.body));
                    const chunk = await decryptEncryptedTransferChunkEnvelope({ ...body, transferId: 'target-upload',
                        sequence: Number(url.pathname.split('/').at(-1)), recipientSecretKeySeed: recipient.recipientSecretKeySeed });
                    for (const byte of chunk) received.push(byte);
                    if (outcome === 'cancel_during_upload') cancellation.abort();
                    return Response.json({ success: true });
                }
                if (url.pathname.endsWith('/finalize')) {
                    finalizeCalls += 1;
                    expect(new Uint8Array(received)).toEqual(bytes);
                    expect(sha256(new Uint8Array(received))).toBe(source.sha256);
                    if (finalizeCalls === 1 && ['recover_finalize', 'retired_after_recovery', 'recovery_unavailable'].includes(outcome)) {
                        return Response.json({ success: false, error: 'Retry finalization', errorCode: 'TRANSFER_FINALIZE_RECOVERY_REQUIRED', keepSession: true },
                            { status: 500, headers: { [DIRECT_TRANSFER_SESSION_EXPIRES_AT_HEADER]: String(Date.now() + 60_000) } });
                    }
                    if (outcome === 'retired_after_upload' || outcome === 'retired_after_recovery') current = false;
                    return Response.json({ success: true, finalized: { success: true, path: '/opaque-stage', sizeBytes: bytes.length, result: uploaded }, sha256: source.sha256 });
                }
                if (url.pathname.endsWith('/abort')) return Response.json({ success: true });
            }
            const id = Buffer.from(url.pathname.split('/')[3]!, 'base64url').toString();
            const range = ranges.get(id)!;
            if (url.pathname.endsWith('/open')) {
                encrypted.set(id, await createEncryptedTransferChunkEnvelope({ transferId: id, sequence: 0, payload: range,
                    recipientPublicKeyBase64: new Headers(init?.headers).get('x-happier-transfer-recipient-public-key')! }));
                return Response.json({ transferId: id, manifestHash: `sha256:${sha256(range)}`, totalChunks: 1, sizeBytes: range.length });
            }
            if (url.pathname.endsWith('/chunks/0')) return Response.json({ transferId: id, kind: 'chunk', sequence: 0, ...encrypted.get(id) });
            if (url.pathname.endsWith('/complete')) return Response.json({ success: true });
            throw new Error(`Unexpected transfer ${url.pathname}`);
        });
        const result = await prepareTargetComposerAttachments({ attachments: outcome === 'mixed'
            ? [attachment, contentlessAttachment, localAttachment] : [attachment], sourceComposerRef, targetComposerRef,
            executionTarget, messageLocalId: 'message-a', isCurrent: () => current, signal: cancellation.signal });
        if (outcome === 'recover_finalize' || outcome === 'retired_after_recovery' || outcome === 'recovery_unavailable') {
            expect(modalShow, 'real upload recovery reaches its existing presentation owner').toHaveBeenCalled();
        }
        expect(new Uint8Array(received)).toEqual(outcome === 'cancel_during_upload' ? bytes.slice(0, 3) : bytes);
        expect(inspections).toEqual(outcome === 'large_chunk'
            ? [{ offset: 0, maxBytes: MAX_COMPOSER_CONTENT_INSPECT_BYTES_V1 }, { offset: MAX_COMPOSER_CONTENT_INSPECT_BYTES_V1, maxBytes: 7 }]
            : outcome === 'cancel_during_upload' ? [{ offset: 0, maxBytes: 3 }]
                : [{ offset: 0, maxBytes: 3 }, { offset: 3, maxBytes: 3 }, { offset: 6, maxBytes: 1 }]);
        if (outcome === 'accepted' || outcome === 'mixed' || outcome === 'large_chunk' || outcome === 'reused_target_snapshot' || outcome === 'recover_finalize') {
            expect(result?.attachments).toEqual([
                { ...attachment, content: { kind: 'stagedMedia', handle: snapshot } },
                ...(outcome === 'mixed' ? [contentlessAttachment, { ...localAttachment, content: { kind: 'stagedMedia', handle: localSnapshot } }] : []),
            ]);
            await result?.releaseOnRejection();
        } else expect(result).toBeNull();
        const releases = rpc.mock.calls.map(([call]) => call).filter(call => call.method === RPC_METHODS.DAEMON_TRANSFER_COMPOSER_MEDIA_RELEASE);
        expect(releases.map(call => call.payload.handle.id)).toEqual(outcome === 'mixed' ? [uploaded.id, snapshot.id, localSnapshot.id]
            : outcome === 'accepted' || outcome === 'large_chunk' || outcome === 'recover_finalize'
            ? [uploaded.id, snapshot.id] : outcome === 'cancel_during_upload' || outcome === 'recovery_unavailable' ? [] : [uploaded.id]);
        if (outcome === 'recover_finalize' || outcome === 'retired_after_recovery') expect(finalizeCalls).toBe(2);
        expect(releases.every(call => call.machineId === 'target-machine')).toBe(true);
        expect(attachment.content?.handle).toEqual(source);
    });
});
