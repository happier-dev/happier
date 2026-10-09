import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { RpcError } from '@happier-dev/protocol/rpcErrors';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEncryptedTransferChunkEnvelope } from './transferChunkEncryption';
import { createBufferedTransferDestination } from '../carriers/createBufferedTransferDestination';
import { downloadBulkPayloadViaDirectExportToDestination } from './directTransferExportDownload';
import { copyPreparedFilesystemFile } from './preparedFilesystemCopy';
import { createTransferRecipientKeyPair } from './transferChunkEncryption';
import { decryptEncryptedTransferChunkEnvelope } from './transferChunkEncryption';

const callGuardedMachineRpcWithPolicyMock = vi.hoisted(() => vi.fn());
const runtimeFetchMock = vi.hoisted(() => vi.fn());
const convertedWorkspaceFixtures = vi.hoisted(() => new Set<string>());
const workspaceCompletionRequests = vi.hoisted(() => new Map<string, unknown>());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc', () => ({
    callGuardedMachineRpcWithPolicy: async (params: { method: string; payload: { input?: { destination?: { destinationId: string } } } }) => {
        const result = await callGuardedMachineRpcWithPolicyMock(params);
        if (params.method === 'daemon.filesystem.download' && result?.success === true && typeof result.transferId === 'string') {
            const { success: _success, ...prepared } = result;
            convertedWorkspaceFixtures.add(prepared.transferId);
            return { success: true, status: 'accepted', operationId: 'download-operation', destinationId: params.payload.input?.destination?.destinationId,
                prepared: { manifestHash: `sha256:${'0'.repeat(64)}`, ...prepared } };
        }
        if (params.method === 'daemon.filesystem.transfer.cancel') return { success: true, aborted: true };
        return result;
    },
}));

vi.mock('@/utils/system/runtimeFetch', () => ({
    runtimeFetch: (url: string, init?: RequestInit) => {
        if (url.includes('/complete') && Array.from(convertedWorkspaceFixtures).some(id => url.includes(id))) {
            const id = Array.from(convertedWorkspaceFixtures).find(id => url.includes(id))!;
            workspaceCompletionRequests.set(id, JSON.parse(String(init?.body)));
            return Promise.resolve(new Response(JSON.stringify({ success: true }), { headers: { 'content-type': 'application/json' } }));
        }
        return runtimeFetchMock(url, init);
    },
}));

async function createManifestHash(payloadBytes: Uint8Array): Promise<string> {
    const digestSource = new Uint8Array(new ArrayBuffer(payloadBytes.byteLength));
    digestSource.set(payloadBytes);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', digestSource.buffer);
    return `sha256:${Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

describe('directTransferExportDownload', () => {
    it('reopens only the original file capabilities for cleanup after cancellation retires the byte leases', async () => {
        const cancellation = new AbortController();
        const bytes = new Uint8Array([0, 255, 128, 10]);
        const manifestHash = await createManifestHash(bytes);
        const recipient = createTransferRecipientKeyPair();
        const expiresAt = Date.now() + 60_000;
        let transferred: Uint8Array | undefined;
        let sourceClosed = false; let destinationAborted = false;
        callGuardedMachineRpcWithPolicyMock.mockImplementation(async (params: { method: string; payload: { input: { destination?: { destinationId: string } } } }) => {
            if (params.method === 'daemon.filesystem.download') return { success: true, status: 'accepted', operationId: 'source-operation',
                destinationId: params.payload.input.destination!.destinationId,
                prepared: { transferId: 'file-export', name: 'binary', sizeBytes: bytes.length, manifestHash, expiresAt,
                    endpointCandidates: [{ kind: 'http', url: 'http://127.0.0.1:46001/machine-transfers/direct/ZmlsZS1leHBvcnQ',
                        authorizationToken: 'file-export-token', expiresAt }] } };
            if (params.method !== 'daemon.filesystem.copy') throw new Error('Cleanup must not request another Action');
            return { success: true, status: 'accepted', operationId: 'destination-operation', sourceId: 'captured-source',
                prepared: { uploadId: 'file-import', destDisplayPath: '/destination/copy', expectedSizeBytes: bytes.length,
                    chunkSizeBytes: bytes.length, recipientPublicKeyBase64: recipient.recipientPublicKeyBase64, expiresAt,
                    endpointCandidates: [{ kind: 'http', url: 'http://127.0.0.1:46001/machine-transfers/direct/imports/file-import', expiresAt }] } };
        });
        const acquire = async (prepared: Readonly<{ signal?: AbortSignal }>) => {
            prepared.signal?.throwIfAborted();
            let encrypted: Awaited<ReturnType<typeof createEncryptedTransferChunkEnvelope>>;
            return { kind: 'browser_stream' as const, release: async () => {}, request: async (input: RequestInfo | URL, init?: RequestInit) => {
                prepared.signal?.throwIfAborted();
                const url = new URL(String(input));
                let response: unknown;
                if (url.pathname.endsWith('/open')) {
                    encrypted = await createEncryptedTransferChunkEnvelope({ transferId: 'file-export', sequence: 0, payload: bytes,
                        recipientPublicKeyBase64: new Headers(init?.headers).get('x-happier-transfer-recipient-public-key')! });
                    response = { transferId: 'file-export', totalChunks: 1, sizeBytes: bytes.length, manifestHash };
                } else if (url.pathname.includes('/imports/') && url.pathname.endsWith('/chunks/0')) {
                    const body: unknown = JSON.parse(String(init?.body));
                    if (!body || typeof body !== 'object' || !('payloadBase64' in body) || typeof body.payloadBase64 !== 'string'
                        || !('encryptedDataKeyEnvelopeBase64' in body) || typeof body.encryptedDataKeyEnvelopeBase64 !== 'string') throw new Error('Invalid byte envelope');
                    transferred = await decryptEncryptedTransferChunkEnvelope({ ...body, payloadBase64: body.payloadBase64,
                        encryptedDataKeyEnvelopeBase64: body.encryptedDataKeyEnvelopeBase64, transferId: 'file-import', sequence: 0,
                        recipientSecretKeySeed: recipient.recipientSecretKeySeed });
                    cancellation.abort(); response = { success: true };
                } else if (url.pathname.endsWith('/chunks/0')) response = { transferId: 'file-export', kind: 'chunk', sequence: 0, ...encrypted! };
                else if (url.pathname.endsWith('/abort')) { destinationAborted = true; response = { success: true, aborted: true }; }
                else if (url.pathname.endsWith('/complete')) {
                    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer file-export-token');
                    expect(JSON.parse(String(init?.body))).toMatchObject({ success: false }); sourceClosed = true; response = { success: true };
                } else throw new Error('Cancelled file copy must not finalize');
                return Response.json(response);
            } };
        };
        expect(await copyPreparedFilesystemFile({ input: { kind: 'prepared_transfer',
            source: { kind: 'file', serverId: 'source-home', machineId: 'source', rootPath: '/source', path: 'binary',
                sourceId: 'captured-source', sizeBytes: bytes.length, sha256: manifestHash.slice('sha256:'.length) },
            destination: { serverId: 'destination-home', machineId: 'destination', rootPath: '/destination', path: 'copy' },
            recursive: false, overwrite: false }, signal: cancellation.signal, acquireSourceCarrier: acquire, acquireDestinationCarrier: acquire }))
            .toMatchObject({ success: false, status: 'cancelled' });
        expect(transferred).toEqual(bytes); expect(destinationAborted).toBe(true); expect(sourceClosed).toBe(true);
        expect(callGuardedMachineRpcWithPolicyMock.mock.calls.map(([call]) => call.method)).toEqual(['daemon.filesystem.download', 'daemon.filesystem.copy']);
    });
    it('closes the original tree export and every prepared import capability after user cancellation without a second Action', async () => {
        const cancellation = new AbortController();
        const recipient = createTransferRecipientKeyPair();
        const expiresAt = Date.now() + 60_000;
        const imports = ['manifest-import', 'blob-import'];
        const aborted: string[] = [];
        let sourceClosed = false;
        const preparedImport = (uploadId: string) => ({ uploadId, destDisplayPath: '/destination/copy', expectedSizeBytes: 4,
            chunkSizeBytes: 4, recipientPublicKeyBase64: recipient.recipientPublicKeyBase64, expiresAt,
            endpointCandidates: [{ kind: 'http', url: `http://127.0.0.1:46001/machine-transfers/direct/imports/${uploadId}`, expiresAt }] });
        callGuardedMachineRpcWithPolicyMock.mockImplementation(async (params: { method: string; payload: { input: { destination?: { destinationId: string } } } }) => {
            if (params.method === 'daemon.filesystem.download') return { success: true, status: 'accepted', operationId: 'source-operation',
                destinationId: params.payload.input.destination!.destinationId,
                prepared: { transferId: 'source-export', name: 'tree', sizeBytes: 4, manifestHash: `sha256:${'0'.repeat(64)}`, expiresAt,
                    endpointCandidates: [{ kind: 'http', url: 'http://127.0.0.1:46001/machine-transfers/direct/c291cmNlLWV4cG9ydA',
                        authorizationToken: 'original-export-token', expiresAt }] },
                entryTree: { operationId: 'manifest', expectation: { kind: 'directory', fingerprint: '1'.repeat(64) },
                    blobs: [{ transferId: 'blob', sizeBytes: 4, manifestHash: `sha256:${'2'.repeat(64)}` }] } };
            if (params.method !== 'daemon.filesystem.copy') throw new Error('Cleanup must not request another semantic Action');
            cancellation.abort();
            return { success: true, status: 'accepted', operationId: 'destination-operation', sourceId: 'source-export',
                prepared: { manifest: preparedImport(imports[0]!), blobs: [{ transferId: 'blob', prepared: preparedImport(imports[1]!) }] } };
        });
        const acquire = async (prepared: Readonly<{ signal?: AbortSignal }>) => {
            prepared.signal?.throwIfAborted();
            return { kind: 'browser_stream' as const, release: async () => {}, request: async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = new URL(String(input));
                if (url.pathname.endsWith('/complete')) {
                    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer original-export-token');
                    expect(JSON.parse(String(init?.body))).toMatchObject({ success: false });
                    sourceClosed = true;
                } else if (url.pathname.endsWith('/abort')) aborted.push(url.pathname.split('/').at(-2)!);
                else throw new Error('Cancelled copy must not write bytes');
                return new Response(JSON.stringify({ success: true, aborted: true }), { headers: { 'content-type': 'application/json' } });
            } };
        };
        expect(await copyPreparedFilesystemFile({ input: { kind: 'target_copy',
            source: { serverId: 'source-home', machineId: 'source', rootPath: '/source', path: 'tree' },
            destination: { serverId: 'destination-home', machineId: 'destination', rootPath: '/destination', path: 'copy' },
            recursive: true, overwrite: false }, signal: cancellation.signal,
            acquireSourceCarrier: acquire, acquireDestinationCarrier: acquire }))
            .toMatchObject({ success: false, status: 'cancelled' });
        expect(sourceClosed).toBe(true);
        expect(aborted.sort()).toEqual(imports.sort());
        expect(callGuardedMachineRpcWithPolicyMock.mock.calls.map(([call]) => call.method)).toEqual(['daemon.filesystem.download', 'daemon.filesystem.copy']);
    });
    it.each(['completed', 'lost_ack', 'wrong_source', 'lost_failure_ack'] as const)('acknowledges only the admitted Action-owned binary source after the real destination closes (%s)', async (outcome) => {
        const bytes = new Uint8Array([0, 255, 128, 10]);
        const manifestHash = await createManifestHash(bytes);
        let destinationClosed = false;
        const sourceRejected = outcome === 'wrong_source' || outcome === 'lost_failure_ack';
        const received: number[] = [];
        callGuardedMachineRpcWithPolicyMock.mockImplementation(async (params: { payload: { input: { destination?: { destinationId: string } } } }) => ({
            success: true, status: 'accepted', operationId: 'download-operation',
            destinationId: params.payload.input.destination!.destinationId,
            prepared: { transferId: 'binary-transfer', name: 'binary.dat', sizeBytes: bytes.length, manifestHash, expiresAt: 5000,
                endpointCandidates: [{ kind: 'http', url: 'http://127.0.0.1:46001/machine-transfers/direct/YmluYXJ5LXRyYW5zZmVy',
                    authorizationToken: 'export-token', expiresAt: 5000 }] },
        }));
        let encrypted: Awaited<ReturnType<typeof createEncryptedTransferChunkEnvelope>>;
        runtimeFetchMock.mockImplementation(async (url: string, init: RequestInit) => {
            if (url.includes('/open')) {
                const publicKey = new Headers(init.headers).get('x-happier-transfer-recipient-public-key')!;
                encrypted = await createEncryptedTransferChunkEnvelope({ transferId: 'binary-transfer', sequence: 0, payload: bytes, recipientPublicKeyBase64: publicKey });
                return new Response(JSON.stringify({ transferId: 'binary-transfer', sizeBytes: bytes.length, totalChunks: 1,
                    manifestHash: sourceRejected ? `sha256:${'0'.repeat(64)}` : manifestHash }),
                    { headers: { 'content-type': 'application/json' } });
            }
            if (url.includes('/complete')) {
                expect(destinationClosed).toBe(!sourceRejected);
                expect(JSON.parse(String(init.body))).toMatchObject(sourceRejected ? { success: false } : { success: true, sizeBytes: bytes.length, manifestHash });
                expect(new Headers(init.headers).get('authorization')).toBe('Bearer export-token');
                if (outcome === 'lost_ack' || outcome === 'lost_failure_ack') throw new TypeError('Completion acknowledgement lost');
                return new Response(JSON.stringify({ success: true }), { headers: { 'content-type': 'application/json' } });
            }
            return new Response(JSON.stringify({ transferId: 'binary-transfer', kind: 'chunk', sequence: 0,
                payloadBase64: encrypted.payloadBase64, encryptedDataKeyEnvelopeBase64: encrypted.encryptedDataKeyEnvelopeBase64 }),
                { headers: { 'content-type': 'application/json' } });
        });
        await expect(downloadBulkPayloadViaDirectExportToDestination({ machineId: 'machine-one', serverId: 'home-one',
            request: { t: 'workspace_file_download_v1', workingDirectory: '/repo', path: 'binary.dat', asZip: false },
            destination: { writeBytes: async chunk => { received.push(...chunk); }, close: async () => { destinationClosed = true; }, cleanup: async () => { received.length = 0; } },
        })).resolves.toEqual(sourceRejected ? { ok: false, error: 'Direct export download unavailable' } : outcome === 'lost_ack'
            ? { ok: false, error: 'Download completed but its operation outcome could not be confirmed', errorCode: 'indeterminate' }
            : { ok: true, name: 'binary.dat', sizeBytes: bytes.length });
        expect(received).toEqual(sourceRejected ? [] : Array.from(bytes));
        expect(callGuardedMachineRpcWithPolicyMock.mock.calls.some(([call]) => call.method === 'daemon.filesystem.transfer.cancel')).toBe(false);
    });
    afterEach(() => {
        callGuardedMachineRpcWithPolicyMock.mockReset();
        runtimeFetchMock.mockReset();
        convertedWorkspaceFixtures.clear();
        workspaceCompletionRequests.clear();
    });

    it('downloads and verifies a direct-export JSON payload through a machine-carrier origin override', async () => {
        const payload = {
            assetTypeId: 'agents.skill',
            scope: 'user',
            externalRef: { skillName: 'reviewer' },
            title: 'Reviewer',
            libraryKind: 'bundle',
            bundleSchemaId: 'skills.skill_md_v1',
            digest: 'digest-a',
            displayPath: '~/.agents/skills/reviewer',
            bundleBody: {
                v: 1,
                entries: [],
                createdAtMs: 1,
                updatedAtMs: 1,
            },
        };
        const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
        const manifestHash = await createManifestHash(payloadBytes);

        callGuardedMachineRpcWithPolicyMock.mockResolvedValueOnce({
            success: true,
            transferId: 'transfer-1',
            expiresAt: 5_000,
            endpointCandidates: [
                {
                    kind: 'http',
                    url: 'http://10.44.0.8:46001/machine-transfers/direct/transfer-1?grant=kept',
                    authorizationToken: 'token-1',
                    expiresAt: 5_000,
                },
            ],
        });

        runtimeFetchMock.mockImplementationOnce(async (url: string, init?: RequestInit) => {
            expect(url).toBe('http://127.0.0.1:48126/machine-transfers/direct/transfer-1/open?grant=kept');
            expect(init?.headers).toMatchObject({
                authorization: 'Bearer token-1',
                'x-happier-transfer-recipient-public-key': expect.any(String),
            });
            expect(init?.body).toBeUndefined();
            const openHeaders = new Headers(init?.headers);
            const envelope = await createEncryptedTransferChunkEnvelope({
                transferId: 'transfer-1',
                sequence: 0,
                payload: payloadBytes,
                recipientPublicKeyBase64: openHeaders.get('x-happier-transfer-recipient-public-key') ?? '',
            });

            runtimeFetchMock.mockImplementationOnce(async (chunkUrl: string, chunkInit?: RequestInit) => {
                expect(chunkUrl).toBe('http://127.0.0.1:48126/machine-transfers/direct/transfer-1/chunks/0?grant=kept');
                expect(chunkInit?.headers).toMatchObject({
                    authorization: 'Bearer token-1',
                    'x-happier-transfer-recipient-public-key': expect.any(String),
                });
                return new Response(JSON.stringify({
                    transferId: 'transfer-1',
                    kind: 'chunk',
                    sequence: 0,
                    payloadBase64: envelope.payloadBase64,
                    encryptedDataKeyEnvelopeBase64: envelope.encryptedDataKeyEnvelopeBase64,
                }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            });

            return new Response(JSON.stringify({
                transferId: 'transfer-1',
                manifestHash,
                totalChunks: 1,
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        });

        const { downloadBulkJsonPayloadViaDirectExport } = await import('./directTransferExportDownload');
        const result = await downloadBulkJsonPayloadViaDirectExport({
            machineId: 'machine-1',
            serverId: 'server-a',
            request: {
                t: 'prompt_asset_download_v1',
                assetTypeId: 'agents.skill',
                scope: 'user',
                externalRef: { skillName: 'reviewer' },
            },
            parsePayload: (value) => value as typeof payload,
            httpOriginOverride: 'http://127.0.0.1:48126',
        });

        expect(result).toEqual({
            ok: true,
            payload,
        });
        expect(callGuardedMachineRpcWithPolicyMock).toHaveBeenLastCalledWith(expect.objectContaining({
            method: 'daemon.directTransfer.export.release',
            payload: { transferId: 'transfer-1' },
        }));
    });

    it('carries download requests through a browser machine stream and preserves integrity', async () => {
        const payload = { browser: true };
        const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
        const manifestHash = await createManifestHash(payloadBytes);
        callGuardedMachineRpcWithPolicyMock.mockResolvedValueOnce({
            success: true,
            transferId: 'browser-transfer-1',
            sizeBytes: payloadBytes.byteLength,
            expiresAt: 5_000,
            endpointCandidates: [{
                kind: 'http',
                url: 'http://127.0.0.1:46001/machine-transfers/direct/browser-transfer-1?grant=kept',
                authorizationToken: 'token-browser',
                expiresAt: 5_000,
            }],
        });
        runtimeFetchMock.mockRejectedValue(new Error('native fetch must not carry browser machine bytes'));
        const requests: string[] = [];
        const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            requests.push(url);
            if (url.includes('/open')) {
                return new Response(JSON.stringify({
                    transferId: 'browser-transfer-1',
                    manifestHash,
                    totalChunks: 1,
                    sizeBytes: payloadBytes.byteLength,
                }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            const headers = new Headers(init?.headers);
            const envelope = await createEncryptedTransferChunkEnvelope({
                transferId: 'browser-transfer-1',
                sequence: 0,
                payload: payloadBytes,
                recipientPublicKeyBase64: headers.get('x-happier-transfer-recipient-public-key') ?? '',
            });
            return new Response(JSON.stringify({
                transferId: 'browser-transfer-1',
                kind: 'chunk',
                sequence: 0,
                payloadBase64: envelope.payloadBase64,
                encryptedDataKeyEnvelopeBase64: envelope.encryptedDataKeyEnvelopeBase64,
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        });
        const release = vi.fn(async () => undefined);

        const { downloadBulkJsonPayloadViaDirectExport } = await import('./directTransferExportDownload');
        const result = await downloadBulkJsonPayloadViaDirectExport({
            machineId: 'machine-1',
            serverId: 'server-a',
            request: {
                t: 'prompt_asset_download_v1',
                assetTypeId: 'agents.skill',
                scope: 'user',
                externalRef: { browser: true },
            },
            parsePayload: (value) => value as typeof payload,
            acquirePreparedCarrier: async () => ({ kind: 'browser_stream', request, release }),
        });

        expect(result).toEqual({ ok: true, payload });
        expect(requests).toEqual([
            'http://127.0.0.1:46001/machine-transfers/direct/browser-transfer-1/open?grant=kept',
            'http://127.0.0.1:46001/machine-transfers/direct/browser-transfer-1/chunks/0?grant=kept',
        ]);
        expect(release).toHaveBeenCalledTimes(1);
        expect(callGuardedMachineRpcWithPolicyMock).toHaveBeenLastCalledWith(expect.objectContaining({
            method: 'daemon.directTransfer.export.release',
            payload: { transferId: 'browser-transfer-1' },
        }));
    });

    it('owns the terminal selected-Iroh result after a browser export request fails', async () => {
        callGuardedMachineRpcWithPolicyMock.mockResolvedValueOnce({
            success: true,
            transferId: 'browser-transfer-failed',
            sizeBytes: 1,
            name: 'failed.bin',
            expiresAt: 5_000,
            endpointCandidates: [{
                kind: 'http',
                url: 'http://127.0.0.1:46001/machine-transfers/direct/browser-transfer-failed',
                expiresAt: 5_000,
            }],
        });
        const release = vi.fn(async () => undefined);
        const destination = createBufferedTransferDestination(1);

        const result = await downloadBulkPayloadViaDirectExportToDestination({
            machineId: 'machine-1',
            serverId: 'server-a',
            request: {
                t: 'workspace_file_download_v1',
                workingDirectory: '/repo',
                path: 'failed.bin',
                asZip: false,
            },
            destination: destination.destination,
            acquirePreparedCarrier: async () => ({
                kind: 'browser_stream',
                request: async () => { throw new Error('selected Iroh stream failed'); },
                release,
            }),
        });

        expect(result).toEqual({
            ok: false,
            error: 'The direct machine connection was interrupted. Retry the transfer.',
            errorCode: 'machine_carrier_transport_failed',
        });
        expect(release).toHaveBeenCalledTimes(1);
    });

    it('keeps standard-route null and untyped acquisition failures eligible for fallback', async () => {
        const prepare = {
            success: true,
            transferId: 'standard-transfer-failed',
            sizeBytes: 1,
            name: 'failed.bin',
            expiresAt: 5_000,
            endpointCandidates: [{
                kind: 'http',
                url: 'http://127.0.0.1:46001/machine-transfers/direct/standard-transfer-failed',
                expiresAt: 5_000,
            }],
        } as const;
        callGuardedMachineRpcWithPolicyMock.mockResolvedValue(prepare);
        runtimeFetchMock.mockRejectedValue(new Error('direct endpoint unavailable'));
        const destination = createBufferedTransferDestination(1);

        const nullCarrier = await downloadBulkPayloadViaDirectExportToDestination({
            machineId: 'machine-1',
            request: {
                t: 'workspace_file_download_v1',
                workingDirectory: '/repo',
                path: 'failed.bin',
                asZip: false,
            },
            destination: destination.destination,
            acquirePreparedCarrier: async () => null,
        });
        const untypedAcquisitionFailure = await downloadBulkPayloadViaDirectExportToDestination({
            machineId: 'machine-1',
            request: {
                t: 'workspace_file_download_v1',
                workingDirectory: '/repo',
                path: 'failed.bin',
                asZip: false,
            },
            destination: destination.destination,
            acquirePreparedCarrier: async () => { throw new Error('route resolution unavailable'); },
        });

        expect(nullCarrier).toEqual({ ok: false, error: 'Direct export download unavailable' });
        expect(untypedAcquisitionFailure).toEqual({ ok: false, error: 'route resolution unavailable' });
    });

    it('owns the terminal selected-Iroh result for JSON exports too', async () => {
        callGuardedMachineRpcWithPolicyMock.mockResolvedValueOnce({
            success: true,
            transferId: 'browser-json-failed',
            sizeBytes: 1,
            expiresAt: 5_000,
            endpointCandidates: [{
                kind: 'http',
                url: 'http://127.0.0.1:46001/machine-transfers/direct/browser-json-failed',
                expiresAt: 5_000,
            }],
        });
        const release = vi.fn(async () => undefined);

        const { downloadBulkJsonPayloadViaDirectExport } = await import('./directTransferExportDownload');
        const result = await downloadBulkJsonPayloadViaDirectExport({
            machineId: 'machine-1',
            serverId: 'server-a',
            request: {
                t: 'prompt_asset_download_v1',
                assetTypeId: 'agents.skill',
                scope: 'user',
                externalRef: { name: 'failed' },
            },
            parsePayload: (value) => value,
            acquirePreparedCarrier: async () => ({
                kind: 'browser_stream',
                request: async () => { throw new Error('selected Iroh stream failed'); },
                release,
            }),
        });

        expect(result).toEqual({
            ok: false,
            error: 'The direct machine connection was interrupted. Retry the transfer.',
            errorCode: 'machine_carrier_transport_failed',
        });
        expect(release).toHaveBeenCalledTimes(1);
    });

    it('reports a completed JSON download successful when the carrier release fails and hands custody back once', async () => {
        const payload = { ok: true };
        const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
        const manifestHash = await createManifestHash(payloadBytes);
        const release = vi.fn(async () => {
            throw new Error('native machine tunnel stop failed');
        });

        callGuardedMachineRpcWithPolicyMock.mockResolvedValueOnce({
            success: true,
            transferId: 'transfer-cleanup-failure',
            sizeBytes: payloadBytes.byteLength,
            expiresAt: 5_000,
            endpointCandidates: [
                {
                    kind: 'http',
                    url: 'http://127.0.0.1:46001/machine-transfers/direct/transfer-cleanup-failure',
                    authorizationToken: 'token-1',
                    expiresAt: 5_000,
                },
            ],
        });

        runtimeFetchMock.mockImplementationOnce(async (_url: string, init?: RequestInit) => {
            const openHeaders = new Headers(init?.headers);
            const envelope = await createEncryptedTransferChunkEnvelope({
                transferId: 'transfer-cleanup-failure',
                sequence: 0,
                payload: payloadBytes,
                recipientPublicKeyBase64: openHeaders.get('x-happier-transfer-recipient-public-key') ?? '',
            });
            runtimeFetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({
                transferId: 'transfer-cleanup-failure',
                kind: 'chunk',
                sequence: 0,
                payloadBase64: envelope.payloadBase64,
                encryptedDataKeyEnvelopeBase64: envelope.encryptedDataKeyEnvelopeBase64,
            }), { status: 200, headers: { 'content-type': 'application/json' } }));
            return new Response(JSON.stringify({
                transferId: 'transfer-cleanup-failure',
                manifestHash,
                totalChunks: 1,
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        });

        const { downloadBulkJsonPayloadViaDirectExport } = await import('./directTransferExportDownload');
        const result = await downloadBulkJsonPayloadViaDirectExport({
            machineId: 'machine-1',
            serverId: 'server-a',
            request: {
                t: 'prompt_asset_download_v1',
                assetTypeId: 'agents.skill',
                scope: 'user',
                externalRef: { skillName: 'reviewer' },
            },
            parsePayload: (value) => value as typeof payload,
            acquirePreparedCarrier: async () => ({
                kind: 'native_http' as const,
                localOrigin: 'http://127.0.0.1:48126',
                release,
            }),
        });

        // Cleanup custody returns to the lease owner; the completed download is
        // not downgraded and this helper does not retry the release.
        expect(result).toEqual({ ok: true, payload });
        expect(release).toHaveBeenCalledTimes(1);
    });

    it('accepts https direct-export endpoint candidates with a Serve path prefix', async () => {
        const payload = { ok: true };
        const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
        const manifestHash = await createManifestHash(payloadBytes);

        callGuardedMachineRpcWithPolicyMock.mockResolvedValueOnce({
            success: true,
            transferId: 'transfer-https',
            expiresAt: 5_000,
            endpointCandidates: [
                {
                    kind: 'https',
                    url: 'https://example.ts.net/__happier/transfer/machine-transfers/direct/transfer-https',
                    authorizationToken: 'token-https',
                    expiresAt: 5_000,
                },
            ],
        });

        runtimeFetchMock.mockImplementationOnce(async (url: string, init?: RequestInit) => {
            expect(url).toBe('https://example.ts.net/__happier/transfer/machine-transfers/direct/transfer-https/open');
            expect(init?.headers).toMatchObject({
                authorization: 'Bearer token-https',
                'x-happier-transfer-recipient-public-key': expect.any(String),
            });
            expect(init?.body).toBeUndefined();
            const openHeaders = new Headers(init?.headers);
            const envelope = await createEncryptedTransferChunkEnvelope({
                transferId: 'transfer-https',
                sequence: 0,
                payload: payloadBytes,
                recipientPublicKeyBase64: openHeaders.get('x-happier-transfer-recipient-public-key') ?? '',
            });

            runtimeFetchMock.mockImplementationOnce(async (chunkUrl: string, chunkInit?: RequestInit) => {
                expect(chunkUrl).toBe('https://example.ts.net/__happier/transfer/machine-transfers/direct/transfer-https/chunks/0');
                expect(chunkInit?.headers).toMatchObject({
                    authorization: 'Bearer token-https',
                    'x-happier-transfer-recipient-public-key': expect.any(String),
                });
                return new Response(JSON.stringify({
                    transferId: 'transfer-https',
                    kind: 'chunk',
                    sequence: 0,
                    payloadBase64: envelope.payloadBase64,
                    encryptedDataKeyEnvelopeBase64: envelope.encryptedDataKeyEnvelopeBase64,
                }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            });

            return new Response(JSON.stringify({
                transferId: 'transfer-https',
                manifestHash,
                totalChunks: 1,
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        });

        const { downloadBulkJsonPayloadViaDirectExport } = await import('./directTransferExportDownload');
        const result = await downloadBulkJsonPayloadViaDirectExport({
            machineId: 'machine-1',
            serverId: 'server-a',
            request: {
                t: 'prompt_registry_download_v1',
                sourceId: 'skills_sh:featured',
                itemId: 'skills_sh:featured:item-1',
                configuredSources: [],
            },
            parsePayload: (value) => value as typeof payload,
        });

        expect(result).toEqual({
            ok: true,
            payload,
        });
    });

    it('never fetches a predecessor LAN HTTP candidate and continues with HTTPS', async () => {
        const payload = { source: 'https' };
        const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
        const manifestHash = await createManifestHash(payloadBytes);

        callGuardedMachineRpcWithPolicyMock.mockResolvedValueOnce({
            success: true,
            transferId: 'transfer-safe-candidate',
            expiresAt: 5_000,
            endpointCandidates: [
                {
                    kind: 'http',
                    url: 'http://192.168.1.20:46001/machine-transfers/direct/transfer-safe-candidate',
                    authorizationToken: 'remote-dev-shaped-token',
                    expiresAt: 5_000,
                },
                {
                    kind: 'https',
                    url: 'https://machine.example.test/machine-transfers/direct/transfer-safe-candidate',
                    authorizationToken: 'safe-token',
                    expiresAt: 5_000,
                },
            ],
        });

        runtimeFetchMock.mockImplementationOnce(async (url: string, init?: RequestInit) => {
            expect(url).toBe('https://machine.example.test/machine-transfers/direct/transfer-safe-candidate/open');
            const openHeaders = new Headers(init?.headers);
            const envelope = await createEncryptedTransferChunkEnvelope({
                transferId: 'transfer-safe-candidate',
                sequence: 0,
                payload: payloadBytes,
                recipientPublicKeyBase64: openHeaders.get('x-happier-transfer-recipient-public-key') ?? '',
            });
            runtimeFetchMock.mockImplementationOnce(async (chunkUrl: string) => {
                expect(chunkUrl).toBe('https://machine.example.test/machine-transfers/direct/transfer-safe-candidate/chunks/0');
                return new Response(JSON.stringify({
                    transferId: 'transfer-safe-candidate',
                    kind: 'chunk',
                    sequence: 0,
                    payloadBase64: envelope.payloadBase64,
                    encryptedDataKeyEnvelopeBase64: envelope.encryptedDataKeyEnvelopeBase64,
                }), { status: 200, headers: { 'content-type': 'application/json' } });
            });
            return new Response(JSON.stringify({
                transferId: 'transfer-safe-candidate',
                manifestHash,
                totalChunks: 1,
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        });

        const { downloadBulkJsonPayloadViaDirectExport } = await import('./directTransferExportDownload');
        const result = await downloadBulkJsonPayloadViaDirectExport({
            machineId: 'machine-1',
            request: {
                t: 'prompt_asset_download_v1',
                assetTypeId: 'agents.skill',
                scope: 'user',
                externalRef: { skillName: 'safe' },
            },
            parsePayload: (value) => value as typeof payload,
        });

        expect(result).toEqual({ ok: true, payload });
        expect(runtimeFetchMock).toHaveBeenCalledTimes(2);
        expect(runtimeFetchMock.mock.calls.every(([url]) => !String(url).includes('192.168.1.20'))).toBe(true);
    });

    it('downloads a direct-export payload into a destination sink', async () => {
        const payloadBytes = new TextEncoder().encode('hello');
        const manifestHash = await createManifestHash(payloadBytes);

        callGuardedMachineRpcWithPolicyMock.mockResolvedValueOnce({
            success: true,
            transferId: 'transfer-2',
            manifestHash,
            expiresAt: 5_000,
            name: 'hello.txt',
            sizeBytes: payloadBytes.byteLength,
            endpointCandidates: [
                {
                    kind: 'http',
                    url: 'http://127.0.0.1:46001/machine-transfers/direct/transfer-2',
                    authorizationToken: 'token-2',
                    expiresAt: 5_000,
                },
            ],
        });

        runtimeFetchMock.mockImplementationOnce(async (url: string, init?: RequestInit) => {
            expect(url).toBe('http://127.0.0.1:46001/machine-transfers/direct/transfer-2/open');
            expect(init?.headers).toMatchObject({
                authorization: 'Bearer token-2',
                'x-happier-transfer-recipient-public-key': expect.any(String),
            });
            expect(init?.body).toBeUndefined();
            const openHeaders = new Headers(init?.headers);
            const envelope = await createEncryptedTransferChunkEnvelope({
                transferId: 'transfer-2',
                sequence: 0,
                payload: payloadBytes,
                recipientPublicKeyBase64: openHeaders.get('x-happier-transfer-recipient-public-key') ?? '',
            });

            runtimeFetchMock.mockImplementationOnce(async (chunkUrl: string, chunkInit?: RequestInit) => {
                expect(chunkUrl).toBe('http://127.0.0.1:46001/machine-transfers/direct/transfer-2/chunks/0');
                expect(chunkInit?.headers).toMatchObject({
                    authorization: 'Bearer token-2',
                    'x-happier-transfer-recipient-public-key': expect.any(String),
                });
                return new Response(JSON.stringify({
                    transferId: 'transfer-2',
                    kind: 'chunk',
                    sequence: 0,
                    payloadBase64: envelope.payloadBase64,
                    encryptedDataKeyEnvelopeBase64: envelope.encryptedDataKeyEnvelopeBase64,
                }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            });

            return new Response(JSON.stringify({
                transferId: 'transfer-2',
                manifestHash,
                totalChunks: 1,
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        });

        const writes: Uint8Array[] = [];
        const { downloadBulkPayloadViaDirectExportToDestination } = await import('./directTransferExportDownload');
        const result = await downloadBulkPayloadViaDirectExportToDestination({
            machineId: 'machine-1',
            serverId: 'server-a',
            request: {
                t: 'workspace_file_download_v1',
                workingDirectory: '/repo',
                path: '/repo/hello.txt',
                asZip: false,
            },
            destination: {
                writeBytes: async (bytes) => {
                    writes.push(bytes);
                },
                close: async () => {},
                cleanup: async () => {
                    writes.length = 0;
                },
            },
        });

        expect(result).toEqual({
            ok: true,
            name: 'hello.txt',
            sizeBytes: payloadBytes.byteLength,
        });
        expect(new TextDecoder().decode(Buffer.concat(writes.map((chunk) => Buffer.from(chunk))))).toBe('hello');
    });

    it('treats a manifest mismatch as terminal instead of trying the next candidate', async () => {
        const badPayload = new TextEncoder().encode('bad');
        const goodPayload = new TextEncoder().encode('good');
        const goodManifestHash = await createManifestHash(goodPayload);
        const envelopes = new Map<string, Awaited<ReturnType<typeof createEncryptedTransferChunkEnvelope>>>();

        callGuardedMachineRpcWithPolicyMock.mockResolvedValueOnce({
            success: true,
            transferId: 'transfer-candidate-reset',
            manifestHash: goodManifestHash,
            expiresAt: 5_000,
            name: 'payload.txt',
            sizeBytes: goodPayload.byteLength,
            endpointCandidates: [
                {
                    kind: 'https',
                    url: 'https://first.example/machine-transfers/direct/transfer-candidate-reset',
                    authorizationToken: 'first-token',
                    expiresAt: 5_000,
                },
                {
                    kind: 'https',
                    url: 'https://second.example/machine-transfers/direct/transfer-candidate-reset',
                    authorizationToken: 'second-token',
                    expiresAt: 5_000,
                },
            ],
        });

        runtimeFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
            const host = new URL(url).host;
            if (url.endsWith('/open')) {
                const headers = new Headers(init?.headers);
                const payload = host === 'first.example' ? badPayload : goodPayload;
                envelopes.set(host, await createEncryptedTransferChunkEnvelope({
                    transferId: 'transfer-candidate-reset',
                    sequence: 0,
                    payload,
                    recipientPublicKeyBase64: headers.get('x-happier-transfer-recipient-public-key') ?? '',
                }));
                return new Response(JSON.stringify({
                    transferId: 'transfer-candidate-reset',
                    manifestHash: host === 'first.example' ? 'sha256:wrong' : goodManifestHash,
                    totalChunks: 1,
                }), { status: 200, headers: { 'content-type': 'application/json' } });
            }

            const envelope = envelopes.get(host);
            expect(envelope).toBeDefined();
            return new Response(JSON.stringify({
                transferId: 'transfer-candidate-reset',
                kind: 'chunk',
                sequence: 0,
                payloadBase64: envelope?.payloadBase64,
                encryptedDataKeyEnvelopeBase64: envelope?.encryptedDataKeyEnvelopeBase64,
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        });

        let active = false;
        const writes: Uint8Array[] = [];
        const onInit = vi.fn(async () => {
            active = true;
            writes.length = 0;
        });
        const cleanup = vi.fn(async () => {
            active = false;
            writes.length = 0;
        });

        const { downloadBulkPayloadViaDirectExportToDestination } = await import('./directTransferExportDownload');
        await expect(downloadBulkPayloadViaDirectExportToDestination({
            machineId: 'machine-1',
            request: {
                t: 'workspace_file_download_v1',
                workingDirectory: '/repo',
                path: '/repo/payload.txt',
                asZip: false,
            },
            destination: {
                writeBytes: async (bytes) => {
                    if (!active) throw new Error('destination is not initialized');
                    writes.push(bytes);
                },
                close: async () => {},
                cleanup,
            },
            onInit,
        })).resolves.toEqual({ ok: false, error: 'Direct export download unavailable' });

        // The admitted source hash rejects the first open before any chunk or
        // alternative endpoint is consumed; cleanup acknowledges that failure.
        expect(runtimeFetchMock).toHaveBeenCalledTimes(1);
        expect(onInit).toHaveBeenCalledTimes(1);
        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(writes).toEqual([]);
        expect(workspaceCompletionRequests.get('transfer-candidate-reset')).toMatchObject({ success: false });
    });

    it('cleans up the destination and returns an error when the init callback throws', async () => {
        callGuardedMachineRpcWithPolicyMock.mockResolvedValueOnce({
            success: true,
            transferId: 'transfer-init-throws',
            expiresAt: 5_000,
            name: 'hello.txt',
            sizeBytes: 5,
            endpointCandidates: [
                {
                    kind: 'http',
                    url: 'http://127.0.0.1:46001/machine-transfers/direct/transfer-init-throws',
                    authorizationToken: 'token-throws',
                    expiresAt: 5_000,
                },
            ],
        });

        const cleanup = vi.fn(async () => {});
        const close = vi.fn(async () => {});
        let initializationFailed = false;
        const cleanupRequests: Readonly<{ destinationId: string; success: boolean; error: string }>[] = [];

        const { downloadBulkPayloadViaDirectExportToDestination } = await import('./directTransferExportDownload');
        const resultPromise = downloadBulkPayloadViaDirectExportToDestination({
            machineId: 'machine-1',
            serverId: 'server-a',
            request: {
                t: 'workspace_file_download_v1',
                workingDirectory: '/repo',
                path: '/repo/hello.txt',
                asZip: false,
            },
            destination: {
                writeBytes: async () => {},
                close,
                cleanup,
            },
            onInit: async () => {
                initializationFailed = true;
                throw new Error('init callback exploded');
            },
            acquirePreparedCarrier: async () => { throw new Error('Failed initialization must not open a byte carrier'); },
            acquireCleanupCarrier: async ({ operationId }) => {
                expect(initializationFailed).toBe(true);
                expect(operationId).toBe('transfer-init-throws');
                return { kind: 'browser_stream', release: async () => {}, request: async (input, init) => {
                    expect(new URL(String(input)).pathname).toBe('/machine-transfers/direct/transfer-init-throws/complete');
                    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer token-throws');
                    cleanupRequests.push(JSON.parse(String(init?.body)));
                    return Response.json({ success: true });
                } };
            },
        });

        await expect(resultPromise).resolves.toEqual({
            ok: false,
            error: 'init callback exploded',
        });
        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(close).not.toHaveBeenCalled();
        expect(cleanupRequests).toEqual([{ destinationId: expect.any(String), success: false, error: 'init callback exploded' }]);
        expect(runtimeFetchMock).not.toHaveBeenCalled();
        expect(callGuardedMachineRpcWithPolicyMock.mock.calls.map(([call]) => call.method)).toEqual(['daemon.filesystem.download']);
    });

    it('does not acquire the finite-transfer carrier until destination initialization completes', async () => {
        callGuardedMachineRpcWithPolicyMock.mockResolvedValueOnce({
            success: true,
            transferId: 'transfer-deferred-init',
            expiresAt: 5_000,
            name: 'hello.txt',
            sizeBytes: 5,
            endpointCandidates: [{
                kind: 'http',
                url: 'http://127.0.0.1:46001/machine-transfers/direct/transfer-deferred-init',
                expiresAt: 5_000,
            }],
        });
        let finishInit!: () => void;
        const initPending = new Promise<void>((resolve) => {
            finishInit = resolve;
        });
        const acquirePreparedCarrier = vi.fn(async () => {
            throw new Error('stop after acquisition');
        });

        const resultPending = downloadBulkPayloadViaDirectExportToDestination({
            machineId: 'machine-1',
            request: {
                t: 'workspace_file_download_v1',
                workingDirectory: '/repo',
                path: '/repo/hello.txt',
                asZip: false,
            },
            destination: {
                writeBytes: async () => {},
                close: async () => {},
                cleanup: async () => {},
            },
            onInit: async () => await initPending,
            acquirePreparedCarrier,
        });

        await vi.waitFor(() => expect(callGuardedMachineRpcWithPolicyMock).toHaveBeenCalled());
        expect(acquirePreparedCarrier).not.toHaveBeenCalled();
        finishInit();
        await expect(resultPending).resolves.toMatchObject({ ok: false });
        expect(acquirePreparedCarrier).toHaveBeenCalledWith({ operationId: 'transfer-deferred-init' });
    });

    it('fails closed when a streamed direct-export payload manifest does not match the downloaded bytes', async () => {
        const payloadBytes = new TextEncoder().encode('hello');

        callGuardedMachineRpcWithPolicyMock.mockResolvedValueOnce({
            success: true,
            transferId: 'transfer-3',
            expiresAt: 5_000,
            name: 'hello.txt',
            sizeBytes: payloadBytes.byteLength,
            endpointCandidates: [
                {
                    kind: 'http',
                    url: 'http://127.0.0.1:46001/machine-transfers/direct/transfer-3',
                    authorizationToken: 'token-3',
                    expiresAt: 5_000,
                },
            ],
        });

        runtimeFetchMock.mockImplementationOnce(async (_url: string, init?: RequestInit) => {
            expect(init?.body).toBeUndefined();
            const openHeaders = new Headers(init?.headers);
            const envelope = await createEncryptedTransferChunkEnvelope({
                transferId: 'transfer-3',
                sequence: 0,
                payload: payloadBytes,
                recipientPublicKeyBase64: openHeaders.get('x-happier-transfer-recipient-public-key') ?? '',
            });

            runtimeFetchMock.mockImplementationOnce(async () => {
                return new Response(JSON.stringify({
                    transferId: 'transfer-3',
                    kind: 'chunk',
                    sequence: 0,
                    payloadBase64: envelope.payloadBase64,
                    encryptedDataKeyEnvelopeBase64: envelope.encryptedDataKeyEnvelopeBase64,
                }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            });

            return new Response(JSON.stringify({
                transferId: 'transfer-3',
                manifestHash: 'sha256:manifest-mismatch',
                totalChunks: 1,
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        });

        const cleanup = vi.fn(async () => {});
        const close = vi.fn(async () => {});
        const { downloadBulkPayloadViaDirectExportToDestination } = await import('./directTransferExportDownload');
        const result = await downloadBulkPayloadViaDirectExportToDestination({
            machineId: 'machine-1',
            serverId: 'server-a',
            request: {
                t: 'workspace_file_download_v1',
                workingDirectory: '/repo',
                path: '/repo/hello.txt',
                asZip: false,
            },
            destination: {
                writeBytes: async () => {},
                close,
                cleanup,
            },
        });

        expect(result).toEqual({
            ok: false,
            error: 'Direct export download unavailable',
        });
        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(close).not.toHaveBeenCalled();
        expect(workspaceCompletionRequests.get('transfer-3')).toMatchObject({ success: false });
        expect(callGuardedMachineRpcWithPolicyMock.mock.calls.map(([call]) => call.method)).toEqual(['daemon.filesystem.download']);
    });

    it('returns a failure instead of throwing when direct-export prepare is unavailable for destination downloads', async () => {
        callGuardedMachineRpcWithPolicyMock.mockRejectedValueOnce(new RpcError(
            'RPC method not available',
            RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        ));

        const cleanup = vi.fn(async () => {});
        const close = vi.fn(async () => {});
        const { downloadBulkPayloadViaDirectExportToDestination } = await import('./directTransferExportDownload');
        const result = await downloadBulkPayloadViaDirectExportToDestination({
            machineId: 'machine-1',
            serverId: 'server-a',
            request: {
                t: 'workspace_file_download_v1',
                workingDirectory: '/repo',
                path: '/repo/hello.txt',
                asZip: false,
            },
            destination: {
                writeBytes: async () => {},
                close,
                cleanup,
            },
        });

        expect(result).toEqual({
            ok: false,
            error: 'RPC method not available',
        });
        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(close).not.toHaveBeenCalled();
        expect(runtimeFetchMock).not.toHaveBeenCalled();
    });

    it('returns a failure instead of throwing when direct-export prepare is unavailable for JSON downloads', async () => {
        callGuardedMachineRpcWithPolicyMock.mockRejectedValueOnce(new RpcError(
            'RPC method not available',
            RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        ));

        const { downloadBulkJsonPayloadViaDirectExport } = await import('./directTransferExportDownload');
        const result = await downloadBulkJsonPayloadViaDirectExport({
            machineId: 'machine-1',
            serverId: 'server-a',
            request: {
                t: 'prompt_asset_download_v1',
                assetTypeId: 'agents.skill',
                scope: 'user',
                externalRef: { skillName: 'reviewer' },
            },
            parsePayload: (value) => value as { ok: true } | null,
        });

        expect(result).toEqual({
            ok: false,
            error: 'RPC method not available',
        });
        expect(runtimeFetchMock).not.toHaveBeenCalled();
    });

    it('passes the configured timeout through to direct-export prepare', async () => {
        callGuardedMachineRpcWithPolicyMock.mockImplementationOnce(async (input: { timeoutMs?: number }) => {
            expect(input.timeoutMs).toBe(10);
            throw new Error('prepare timed out');
        });

        const cleanup = vi.fn(async () => {});
        const close = vi.fn(async () => {});
        const { downloadBulkPayloadViaDirectExportToDestination } = await import('./directTransferExportDownload');
        const result = await downloadBulkPayloadViaDirectExportToDestination({
            machineId: 'machine-1',
            serverId: 'server-a',
            timeoutMs: 10,
            request: {
                t: 'workspace_file_download_v1',
                workingDirectory: '/repo',
                path: '/repo/hello.txt',
                asZip: false,
            },
            destination: {
                writeBytes: async () => {},
                close,
                cleanup,
            },
        });

        expect(result).toEqual({
            ok: false,
            error: 'prepare timed out',
        });
        expect(runtimeFetchMock).not.toHaveBeenCalled();
        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(close).not.toHaveBeenCalled();
    });

    it('forwards caller cancellation to a stalled direct-export prepare', async () => {
        const controller = new AbortController();
        let guardedSignal: AbortSignal | undefined;
        callGuardedMachineRpcWithPolicyMock.mockImplementationOnce((input: { signal?: AbortSignal }) => {
            guardedSignal = input.signal;
            return new Promise((_resolve, reject) => {
                input.signal?.addEventListener('abort', () => {
                    reject(input.signal?.reason);
                }, { once: true });
            });
        });

        const cleanup = vi.fn(async () => {});
        const close = vi.fn(async () => {});
        const { downloadBulkPayloadViaDirectExportToDestination } = await import('./directTransferExportDownload');
        const resultPromise = downloadBulkPayloadViaDirectExportToDestination({
            machineId: 'machine-1',
            serverId: 'server-a',
            request: {
                t: 'workspace_file_download_v1',
                workingDirectory: '/repo',
                path: '/repo/hello.txt',
                asZip: false,
            },
            destination: {
                writeBytes: async () => {},
                close,
                cleanup,
            },
            signal: controller.signal,
        });

        expect(guardedSignal).toBe(controller.signal);
        controller.abort(new Error('prepare canceled'));

        await expect(resultPromise).resolves.toEqual({
            ok: false,
            error: 'prepare canceled',
        });
        expect(runtimeFetchMock).not.toHaveBeenCalled();
        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(close).not.toHaveBeenCalled();
    });

    it('uses the default direct-export timeout for prepare when callers omit timeoutMs', async () => {
        const previousTimeout = process.env.EXPO_PUBLIC_HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_REQUEST_TIMEOUT_MS;
        process.env.EXPO_PUBLIC_HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_REQUEST_TIMEOUT_MS = '10';

        try {
            callGuardedMachineRpcWithPolicyMock.mockImplementationOnce(async (input: { timeoutMs?: number }) => {
                expect(input.timeoutMs).toBe(10);
                throw new Error('prepare timed out');
            });

            const cleanup = vi.fn(async () => {});
            const close = vi.fn(async () => {});
            const { downloadBulkPayloadViaDirectExportToDestination } = await import('./directTransferExportDownload');
            const result = await downloadBulkPayloadViaDirectExportToDestination({
                machineId: 'machine-1',
                serverId: 'server-a',
                request: {
                    t: 'workspace_file_download_v1',
                    workingDirectory: '/repo',
                    path: '/repo/hello.txt',
                    asZip: false,
                },
                destination: {
                    writeBytes: async () => {},
                    close,
                    cleanup,
                },
            });

            expect(result).toEqual({
                ok: false,
                error: 'prepare timed out',
            });
            expect(runtimeFetchMock).not.toHaveBeenCalled();
            expect(cleanup).toHaveBeenCalledTimes(1);
            expect(close).not.toHaveBeenCalled();
        } finally {
            if (previousTimeout === undefined) {
                delete process.env.EXPO_PUBLIC_HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_REQUEST_TIMEOUT_MS;
            } else {
                process.env.EXPO_PUBLIC_HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_REQUEST_TIMEOUT_MS = previousTimeout;
            }
        }
    });

    it('abandons a timed-out direct-export candidate and retries the next destination endpoint', async () => {
        vi.useFakeTimers();
        const previousTimeout = process.env.EXPO_PUBLIC_HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_REQUEST_TIMEOUT_MS;
        process.env.EXPO_PUBLIC_HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_REQUEST_TIMEOUT_MS = '10';

        try {
            const payloadBytes = new TextEncoder().encode('hello');
            const manifestHash = await createManifestHash(payloadBytes);

            callGuardedMachineRpcWithPolicyMock.mockResolvedValueOnce({
                success: true,
                transferId: 'transfer-timeout',
                manifestHash,
                expiresAt: 5_000,
                name: 'hello.txt',
                sizeBytes: payloadBytes.byteLength,
                endpointCandidates: [
                    {
                        kind: 'http',
                        url: 'http://127.0.0.1:46001/machine-transfers/direct/transfer-timeout',
                        authorizationToken: 'token-timeout',
                        expiresAt: 5_000,
                    },
                    {
                        kind: 'http',
                        url: 'http://127.0.0.1:46002/machine-transfers/direct/transfer-timeout',
                        authorizationToken: 'token-fallback',
                        expiresAt: 5_000,
                    },
                ],
            });

            let timedOut = false;
            runtimeFetchMock.mockImplementationOnce((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
                const signal = init?.signal;
                if (!signal) {
                    return;
                }
                signal.addEventListener('abort', () => {
                    timedOut = true;
                    reject(new Error('timed out'));
                }, { once: true });
            }));

            runtimeFetchMock.mockImplementationOnce(async (url: string, init?: RequestInit) => {
                expect(url).toBe('http://127.0.0.1:46002/machine-transfers/direct/transfer-timeout/open');
                expect(init?.headers).toMatchObject({
                    authorization: 'Bearer token-fallback',
                    'x-happier-transfer-recipient-public-key': expect.any(String),
                });
                expect(init?.body).toBeUndefined();
                const openHeaders = new Headers(init?.headers);
                const envelope = await createEncryptedTransferChunkEnvelope({
                    transferId: 'transfer-timeout',
                    sequence: 0,
                    payload: payloadBytes,
                    recipientPublicKeyBase64: openHeaders.get('x-happier-transfer-recipient-public-key') ?? '',
                });

                runtimeFetchMock.mockImplementationOnce(async (chunkUrl: string, chunkInit?: RequestInit) => {
                    expect(chunkUrl).toBe('http://127.0.0.1:46002/machine-transfers/direct/transfer-timeout/chunks/0');
                    expect(chunkInit?.headers).toMatchObject({
                        authorization: 'Bearer token-fallback',
                        'x-happier-transfer-recipient-public-key': expect.any(String),
                    });
                    return new Response(JSON.stringify({
                        transferId: 'transfer-timeout',
                        kind: 'chunk',
                        sequence: 0,
                        payloadBase64: envelope.payloadBase64,
                        encryptedDataKeyEnvelopeBase64: envelope.encryptedDataKeyEnvelopeBase64,
                    }), {
                        status: 200,
                        headers: { 'content-type': 'application/json' },
                    });
                });

                return new Response(JSON.stringify({
                    transferId: 'transfer-timeout',
                    manifestHash,
                    totalChunks: 1,
                }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            });

            const writes: Uint8Array[] = [];
            const cleanup = vi.fn(async () => {
                writes.length = 0;
            });
            const close = vi.fn(async () => {});
            const { downloadBulkPayloadViaDirectExportToDestination } = await import('./directTransferExportDownload');
            const resultPromise = downloadBulkPayloadViaDirectExportToDestination({
                machineId: 'machine-1',
                serverId: 'server-a',
                request: {
                    t: 'workspace_file_download_v1',
                    workingDirectory: '/repo',
                    path: '/repo/hello.txt',
                    asZip: false,
                },
                destination: {
                    writeBytes: async (bytes) => {
                        writes.push(bytes);
                    },
                    close,
                    cleanup,
                },
            });

            await vi.advanceTimersByTimeAsync(10);
            expect(timedOut).toBe(true);
            const result = await resultPromise;

            expect(result).toEqual({
                ok: true,
                name: 'hello.txt',
                sizeBytes: payloadBytes.byteLength,
            });
            expect(close).toHaveBeenCalledTimes(1);
            expect(cleanup).toHaveBeenCalledTimes(1);
            expect(new TextDecoder().decode(Buffer.concat(writes.map((chunk) => Buffer.from(chunk))))).toBe('hello');
            expect(runtimeFetchMock).toHaveBeenCalledTimes(3);
        } finally {
            if (previousTimeout === undefined) {
                delete process.env.EXPO_PUBLIC_HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_REQUEST_TIMEOUT_MS;
            } else {
                process.env.EXPO_PUBLIC_HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_REQUEST_TIMEOUT_MS = previousTimeout;
            }
            vi.useRealTimers();
        }
    });

    it('does not retry another direct-export candidate after the caller cancels', async () => {
        const controller = new AbortController();
        callGuardedMachineRpcWithPolicyMock.mockResolvedValueOnce({
            success: true,
            transferId: 'transfer-canceled',
            expiresAt: 5_000,
            name: 'hello.txt',
            sizeBytes: 5,
            endpointCandidates: [
                {
                    kind: 'http',
                    url: 'http://127.0.0.1:46001/machine-transfers/direct/transfer-canceled',
                    authorizationToken: 'token-first',
                    expiresAt: 5_000,
                },
                {
                    kind: 'http',
                    url: 'http://127.0.0.1:46002/machine-transfers/direct/transfer-canceled',
                    authorizationToken: 'token-second',
                    expiresAt: 5_000,
                },
            ],
        });
        runtimeFetchMock.mockImplementationOnce(async () => {
            controller.abort();
            throw new DOMException('The operation was aborted', 'AbortError');
        });

        const cleanup = vi.fn(async () => {});
        const onInit = vi.fn(async () => {});
        const { downloadBulkPayloadViaDirectExportToDestination } = await import('./directTransferExportDownload');
        const result = await downloadBulkPayloadViaDirectExportToDestination({
            machineId: 'machine-1',
            serverId: 'server-a',
            request: {
                t: 'workspace_file_download_v1',
                workingDirectory: '/repo',
                path: '/repo/hello.txt',
                asZip: false,
            },
            destination: {
                writeBytes: async () => {},
                close: async () => {},
                cleanup,
            },
            cleanupOnFailure: false,
            onInit,
            signal: controller.signal,
        });

        expect(result).toEqual({ ok: false, error: 'Download canceled' });
        expect(runtimeFetchMock).toHaveBeenCalledTimes(1);
        expect(onInit).toHaveBeenCalledTimes(1);
        expect(cleanup).not.toHaveBeenCalled();
        expect(workspaceCompletionRequests.get('transfer-canceled')).toMatchObject({ success: false });
        expect(callGuardedMachineRpcWithPolicyMock.mock.calls.map(([call]) => call.method)).toEqual(['daemon.filesystem.download']);
    });

    it('abandons a 500 direct-export open response and retries the next destination endpoint', async () => {
        const payloadBytes = new TextEncoder().encode('hello');
        const manifestHash = await createManifestHash(payloadBytes);

        callGuardedMachineRpcWithPolicyMock.mockResolvedValueOnce({
            success: true,
            transferId: 'transfer-open-500',
            manifestHash,
            expiresAt: 5_000,
            name: 'hello.txt',
            sizeBytes: payloadBytes.byteLength,
            endpointCandidates: [
                {
                    kind: 'http',
                    url: 'http://127.0.0.1:46001/machine-transfers/direct/transfer-open-500',
                    authorizationToken: 'token-bad',
                    expiresAt: 5_000,
                },
                {
                    kind: 'http',
                    url: 'http://127.0.0.1:46002/machine-transfers/direct/transfer-open-500',
                    authorizationToken: 'token-good',
                    expiresAt: 5_000,
                },
            ],
        });

        runtimeFetchMock.mockImplementationOnce(async (url: string) => {
            expect(url).toBe('http://127.0.0.1:46001/machine-transfers/direct/transfer-open-500/open');
            return new Response(JSON.stringify({
                ok: false,
                error: 'Internal Server Error',
            }), {
                status: 500,
                headers: { 'content-type': 'application/json' },
            });
        });

        runtimeFetchMock.mockImplementationOnce(async (url: string, init?: RequestInit) => {
            expect(url).toBe('http://127.0.0.1:46002/machine-transfers/direct/transfer-open-500/open');
            expect(init?.headers).toMatchObject({
                authorization: 'Bearer token-good',
                'x-happier-transfer-recipient-public-key': expect.any(String),
            });
            expect(init?.body).toBeUndefined();
            const openHeaders = new Headers(init?.headers);
            const envelope = await createEncryptedTransferChunkEnvelope({
                transferId: 'transfer-open-500',
                sequence: 0,
                payload: payloadBytes,
                recipientPublicKeyBase64: openHeaders.get('x-happier-transfer-recipient-public-key') ?? '',
            });

            runtimeFetchMock.mockImplementationOnce(async (chunkUrl: string, chunkInit?: RequestInit) => {
                expect(chunkUrl).toBe('http://127.0.0.1:46002/machine-transfers/direct/transfer-open-500/chunks/0');
                expect(chunkInit?.headers).toMatchObject({
                    authorization: 'Bearer token-good',
                    'x-happier-transfer-recipient-public-key': expect.any(String),
                });
                return new Response(JSON.stringify({
                    transferId: 'transfer-open-500',
                    kind: 'chunk',
                    sequence: 0,
                    payloadBase64: envelope.payloadBase64,
                    encryptedDataKeyEnvelopeBase64: envelope.encryptedDataKeyEnvelopeBase64,
                }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            });

            return new Response(JSON.stringify({
                transferId: 'transfer-open-500',
                manifestHash,
                totalChunks: 1,
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        });

        const writes: Uint8Array[] = [];
        let closed = false;
        const close = vi.fn(async () => {
            closed = true;
        });
        const { downloadBulkPayloadViaDirectExportToDestination } = await import('./directTransferExportDownload');
        const result = await downloadBulkPayloadViaDirectExportToDestination({
            machineId: 'machine-1',
            serverId: 'server-a',
            request: {
                t: 'workspace_file_download_v1',
                workingDirectory: '/repo',
                path: '/repo/hello.txt',
                asZip: false,
            },
            destination: {
                writeBytes: async (bytes) => {
                    if (closed) {
                        throw new Error('destination closed');
                    }
                    writes.push(bytes);
                },
                close,
            },
        });

        expect(result).toEqual({
            ok: true,
            name: 'hello.txt',
            sizeBytes: payloadBytes.byteLength,
        });
        expect(close).toHaveBeenCalledTimes(1);
        expect(new TextDecoder().decode(Buffer.concat(writes.map((chunk) => Buffer.from(chunk))))).toBe('hello');
        expect(runtimeFetchMock).toHaveBeenCalledTimes(3);
    });

    it('treats an authentication response as terminal instead of trying the next destination endpoint', async () => {
        callGuardedMachineRpcWithPolicyMock.mockResolvedValueOnce({
            success: true,
            transferId: 'transfer-open-auth',
            expiresAt: 5_000,
            endpointCandidates: [
                {
                    kind: 'https',
                    url: 'https://first.example/machine-transfers/direct/transfer-open-auth',
                    authorizationToken: 'token-bad',
                    expiresAt: 5_000,
                },
                {
                    kind: 'https',
                    url: 'https://second.example/machine-transfers/direct/transfer-open-auth',
                    authorizationToken: 'token-unused',
                    expiresAt: 5_000,
                },
            ],
        });
        runtimeFetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'unauthorized' }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
        }));

        const { downloadBulkJsonPayloadViaDirectExport } = await import('./directTransferExportDownload');
        await expect(downloadBulkJsonPayloadViaDirectExport({
            machineId: 'machine-1',
            request: {
                t: 'prompt_asset_download_v1',
                assetTypeId: 'agents.skill',
                scope: 'user',
                externalRef: { skillName: 'auth-terminal' },
            },
            parsePayload: (value) => value,
        })).resolves.toEqual({ ok: false, error: 'Direct export download unavailable' });
        expect(runtimeFetchMock).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['non-positive', '{"transferId":"transfer-invalid-count","manifestHash":"sha256:none","totalChunks":0}'],
        ['fractional', '{"transferId":"transfer-invalid-count","manifestHash":"sha256:none","totalChunks":1.5}'],
        ['non-finite', '{"transferId":"transfer-invalid-count","manifestHash":"sha256:none","totalChunks":1e400}'],
        ['unsafe', `{"transferId":"transfer-invalid-count","manifestHash":"sha256:none","totalChunks":${Number.MAX_SAFE_INTEGER + 1}}`],
        ['size-inconsistent', '{"transferId":"transfer-invalid-count","manifestHash":"sha256:none","totalChunks":3}'],
    ])('rejects a %s direct-export chunk count before requesting a chunk', async (_caseName, openBody) => {
        callGuardedMachineRpcWithPolicyMock.mockResolvedValueOnce({
            success: true,
            transferId: 'transfer-invalid-count',
            expiresAt: 5_000,
            name: 'two-bytes.bin',
            sizeBytes: 2,
            endpointCandidates: [{
                kind: 'http',
                url: 'http://127.0.0.1:46001/machine-transfers/direct/transfer-invalid-count',
                authorizationToken: 'token-invalid-count',
                expiresAt: 5_000,
            }],
        });
        runtimeFetchMock.mockResolvedValueOnce(new Response(openBody, {
            status: 200,
            headers: { 'content-type': 'application/json' },
        }));

        const writeBytes = vi.fn(async () => {});
        const cleanup = vi.fn(async () => {});
        const { downloadBulkPayloadViaDirectExportToDestination } = await import('./directTransferExportDownload');
        const result = await downloadBulkPayloadViaDirectExportToDestination({
            machineId: 'machine-1',
            request: {
                t: 'workspace_file_download_v1',
                workingDirectory: '/repo',
                path: '/repo/two-bytes.bin',
                asZip: false,
            },
            destination: {
                writeBytes,
                close: async () => {},
                cleanup,
            },
        });

        expect(result).toEqual({ ok: false, error: 'Direct export download unavailable' });
        expect(runtimeFetchMock).toHaveBeenCalledTimes(1);
        expect(writeBytes).not.toHaveBeenCalled();
        expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it('cancels an oversized streamed direct-export open body before consuming the whole response', async () => {
        callGuardedMachineRpcWithPolicyMock.mockResolvedValueOnce({
            success: true,
            transferId: 'transfer-oversized-open',
            expiresAt: 5_000,
            endpointCandidates: [{
                kind: 'http',
                url: 'http://127.0.0.1:46001/machine-transfers/direct/transfer-oversized-open',
                authorizationToken: 'token-oversized-open',
                expiresAt: 5_000,
            }],
        });

        let pulls = 0;
        let canceled = false;
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                pulls += 1;
                if (pulls <= 10) {
                    controller.enqueue(new Uint8Array(4 * 1024).fill(32));
                    return;
                }
                controller.close();
            },
            cancel() {
                canceled = true;
            },
        });
        runtimeFetchMock.mockResolvedValueOnce(new Response(body, {
            status: 200,
            headers: { 'content-type': 'application/json' },
        }));

        const { downloadBulkJsonPayloadViaDirectExport } = await import('./directTransferExportDownload');
        const result = await downloadBulkJsonPayloadViaDirectExport({
            machineId: 'machine-1',
            request: {
                t: 'prompt_asset_download_v1',
                assetTypeId: 'agents.skill',
                scope: 'user',
                externalRef: { skillName: 'oversized-open' },
            },
            parsePayload: (value) => value,
        });

        expect(result).toEqual({ ok: false, error: 'Direct export download unavailable' });
        expect(canceled).toBe(true);
        expect(pulls).toBeLessThan(10);
        expect(runtimeFetchMock).toHaveBeenCalledTimes(1);
    });

    it('cancels an oversized streamed direct-export chunk body before consuming the whole response', async () => {
        callGuardedMachineRpcWithPolicyMock.mockResolvedValueOnce({
            success: true,
            transferId: 'transfer-oversized-chunk',
            expiresAt: 5_000,
            name: 'chunk.bin',
            sizeBytes: 1,
            endpointCandidates: [{
                kind: 'http',
                url: 'http://127.0.0.1:46001/machine-transfers/direct/transfer-oversized-chunk',
                authorizationToken: 'token-oversized-chunk',
                expiresAt: 5_000,
            }],
        });
        runtimeFetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
            transferId: 'transfer-oversized-chunk',
            manifestHash: `sha256:${'0'.repeat(64)}`,
            totalChunks: 1,
        }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        }));

        let pulls = 0;
        let canceled = false;
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                pulls += 1;
                if (pulls <= 24) {
                    controller.enqueue(new Uint8Array(64 * 1024).fill(32));
                    return;
                }
                controller.close();
            },
            cancel() {
                canceled = true;
            },
        });
        runtimeFetchMock.mockResolvedValueOnce(new Response(body, {
            status: 200,
            headers: { 'content-type': 'application/json' },
        }));

        const cleanup = vi.fn(async () => {});
        const { downloadBulkPayloadViaDirectExportToDestination } = await import('./directTransferExportDownload');
        const result = await downloadBulkPayloadViaDirectExportToDestination({
            machineId: 'machine-1',
            request: {
                t: 'workspace_file_download_v1',
                workingDirectory: '/repo',
                path: '/repo/chunk.bin',
                asZip: false,
            },
            destination: {
                writeBytes: async () => {},
                close: async () => {},
                cleanup,
            },
        });

        expect(result).toEqual({ ok: false, error: 'Direct export download unavailable' });
        expect(canceled).toBe(true);
        expect(pulls).toBeLessThan(24);
        expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it('keeps the direct-export request deadline active until the response body settles', async () => {
        vi.useFakeTimers();
        try {
            callGuardedMachineRpcWithPolicyMock.mockResolvedValueOnce({
                success: true,
                transferId: 'transfer-slow-body',
                expiresAt: 5_000,
                endpointCandidates: [{
                    kind: 'http',
                    url: 'http://127.0.0.1:46001/machine-transfers/direct/transfer-slow-body',
                    authorizationToken: 'token-slow-body',
                    expiresAt: 5_000,
                }],
            });

            let bodyAborted = false;
            runtimeFetchMock.mockImplementationOnce(async (_url: string, init?: RequestInit) => {
                const signal = init?.signal;
                return new Response(new ReadableStream<Uint8Array>({
                    start(controller) {
                        signal?.addEventListener('abort', () => {
                            bodyAborted = true;
                            controller.error(new DOMException('The operation was aborted', 'AbortError'));
                        }, { once: true });
                        setTimeout(() => {
                            if (!bodyAborted) {
                                controller.enqueue(new TextEncoder().encode('{'));
                                controller.close();
                            }
                        }, 100);
                    },
                }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            });

            const { downloadBulkJsonPayloadViaDirectExport } = await import('./directTransferExportDownload');
            const resultPromise = downloadBulkJsonPayloadViaDirectExport({
                machineId: 'machine-1',
                request: {
                    t: 'prompt_asset_download_v1',
                    assetTypeId: 'agents.skill',
                    scope: 'user',
                    externalRef: { skillName: 'slow-body' },
                },
                timeoutMs: 10,
                parsePayload: (value) => value,
            });

            await vi.advanceTimersByTimeAsync(10);
            const abortedAtDeadline = bodyAborted;
            await vi.advanceTimersByTimeAsync(100);
            await expect(resultPromise).resolves.toEqual({
                ok: false,
                error: 'Direct export download unavailable',
            });
            expect(abortedAtDeadline).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('rejects cumulative plaintext beyond the prepared file size before writing it', async () => {
        const payloadBytes = new TextEncoder().encode('too-large');
        callGuardedMachineRpcWithPolicyMock.mockResolvedValueOnce({
            success: true,
            transferId: 'transfer-prewrite-bound',
            expiresAt: 5_000,
            name: 'small.bin',
            sizeBytes: 2,
            endpointCandidates: [{
                kind: 'http',
                url: 'http://127.0.0.1:46001/machine-transfers/direct/transfer-prewrite-bound',
                authorizationToken: 'token-prewrite-bound',
                expiresAt: 5_000,
            }],
        });
        runtimeFetchMock.mockImplementationOnce(async (_url: string, init?: RequestInit) => {
            const openHeaders = new Headers(init?.headers);
            const envelope = await createEncryptedTransferChunkEnvelope({
                transferId: 'transfer-prewrite-bound',
                sequence: 0,
                payload: payloadBytes,
                recipientPublicKeyBase64: openHeaders.get('x-happier-transfer-recipient-public-key') ?? '',
            });
            runtimeFetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
                transferId: 'transfer-prewrite-bound',
                kind: 'chunk',
                sequence: 0,
                payloadBase64: envelope.payloadBase64,
                encryptedDataKeyEnvelopeBase64: envelope.encryptedDataKeyEnvelopeBase64,
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            }));
            return new Response(JSON.stringify({
                transferId: 'transfer-prewrite-bound',
                manifestHash: 'sha256:none',
                totalChunks: 1,
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        });

        const writeBytes = vi.fn(async () => {});
        const cleanup = vi.fn(async () => {});
        const { downloadBulkPayloadViaDirectExportToDestination } = await import('./directTransferExportDownload');
        const result = await downloadBulkPayloadViaDirectExportToDestination({
            machineId: 'machine-1',
            request: {
                t: 'workspace_file_download_v1',
                workingDirectory: '/repo',
                path: '/repo/small.bin',
                asZip: false,
            },
            destination: {
                writeBytes,
                close: async () => {},
                cleanup,
            },
        });

        expect(result).toEqual({ ok: false, error: 'Direct export download unavailable' });
        expect(writeBytes).not.toHaveBeenCalled();
        expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it('rejects a declared JSON aggregate beyond its byte budget before requesting chunks', async () => {
        const previousMaxBytes = process.env.EXPO_PUBLIC_HAPPIER_BULK_TRANSFER_JSON_MAX_BYTES;
        process.env.EXPO_PUBLIC_HAPPIER_BULK_TRANSFER_JSON_MAX_BYTES = '5';
        try {
            callGuardedMachineRpcWithPolicyMock.mockResolvedValueOnce({
                success: true,
                transferId: 'transfer-json-aggregate',
                expiresAt: 5_000,
                endpointCandidates: [{
                    kind: 'http',
                    url: 'http://127.0.0.1:46001/machine-transfers/direct/transfer-json-aggregate',
                    authorizationToken: 'token-json-aggregate',
                    expiresAt: 5_000,
                }],
            });
            runtimeFetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
                transferId: 'transfer-json-aggregate',
                manifestHash: 'sha256:none',
                totalChunks: 1,
                sizeBytes: 6,
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            }));

            const { downloadBulkJsonPayloadViaDirectExport } = await import('./directTransferExportDownload');
            const result = await downloadBulkJsonPayloadViaDirectExport({
                machineId: 'machine-1',
                request: {
                    t: 'prompt_asset_download_v1',
                    assetTypeId: 'agents.skill',
                    scope: 'user',
                    externalRef: { skillName: 'aggregate' },
                },
                parsePayload: (value) => value,
            });

            expect(result).toEqual({
                ok: false,
                error: 'Downloaded JSON payload exceeds max allowed bytes (5)',
            });
            expect(runtimeFetchMock).toHaveBeenCalledTimes(1);
        } finally {
            if (previousMaxBytes === undefined) {
                delete process.env.EXPO_PUBLIC_HAPPIER_BULK_TRANSFER_JSON_MAX_BYTES;
            } else {
                process.env.EXPO_PUBLIC_HAPPIER_BULK_TRANSFER_JSON_MAX_BYTES = previousMaxBytes;
            }
        }
    });

    it('derives the admitted chunk count from the JSON byte budget instead of a fixed one-million limit', async () => {
        callGuardedMachineRpcWithPolicyMock.mockResolvedValueOnce({
            success: true,
            transferId: 'transfer-max-count',
            expiresAt: 5_000,
            endpointCandidates: [{
                kind: 'http',
                url: 'http://127.0.0.1:46001/machine-transfers/direct/transfer-max-count',
                authorizationToken: 'token-max-count',
                expiresAt: 5_000,
            }],
        });
        runtimeFetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
            transferId: 'transfer-max-count',
            manifestHash: 'sha256:none',
            totalChunks: 1_000_001,
        }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        }));
        runtimeFetchMock.mockResolvedValueOnce(new Response('{}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
        }));

        const { downloadBulkJsonPayloadViaDirectExport } = await import('./directTransferExportDownload');
        const result = await downloadBulkJsonPayloadViaDirectExport({
            machineId: 'machine-1',
            request: {
                t: 'prompt_asset_download_v1',
                assetTypeId: 'agents.skill',
                scope: 'user',
                externalRef: { skillName: 'max-count' },
            },
            parsePayload: (value) => value,
        });

        expect(result).toEqual({ ok: false, error: 'Direct export download unavailable' });
        expect(runtimeFetchMock).toHaveBeenCalledTimes(2);
    });
});
