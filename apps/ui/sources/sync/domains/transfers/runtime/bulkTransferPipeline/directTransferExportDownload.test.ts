import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEncryptedTransferChunkEnvelope } from './transferChunkEncryption';

const callGuardedMachineRpcWithPolicyMock = vi.hoisted(() => vi.fn());
const runtimeFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc', () => ({
    callGuardedMachineRpcWithPolicy: (...args: unknown[]) => callGuardedMachineRpcWithPolicyMock(...args),
}));

vi.mock('@/utils/system/runtimeFetch', () => ({
    runtimeFetch: (...args: unknown[]) => runtimeFetchMock(...args),
}));

async function createManifestHash(payloadBytes: Uint8Array): Promise<string> {
    const digestSource = new Uint8Array(new ArrayBuffer(payloadBytes.byteLength));
    digestSource.set(payloadBytes);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', digestSource.buffer);
    return `sha256:${Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

describe('directTransferExportDownload', () => {
    afterEach(() => {
        callGuardedMachineRpcWithPolicyMock.mockReset();
        runtimeFetchMock.mockReset();
    });

    it('downloads and parses a direct-export JSON payload', async () => {
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
                    url: 'http://127.0.0.1:46001/machine-transfers/direct/transfer-1?bad=ignored',
                    authorizationToken: 'token-1',
                    expiresAt: 5_000,
                },
            ],
        });

        runtimeFetchMock.mockImplementationOnce(async (url: string, init?: RequestInit) => {
            expect(url).toBe('http://127.0.0.1:46001/machine-transfers/direct/transfer-1/open');
            expect(init?.headers).toMatchObject({
                authorization: 'Bearer token-1',
                'content-type': 'application/json',
            });

            const requestBody = JSON.parse(String(init?.body ?? '{}'));
            const envelope = await createEncryptedTransferChunkEnvelope({
                transferId: 'transfer-1',
                sequence: 0,
                payload: payloadBytes,
                recipientPublicKeyBase64: requestBody.recipientPublicKeyBase64,
            });

            runtimeFetchMock.mockImplementationOnce(async (chunkUrl: string, chunkInit?: RequestInit) => {
                expect(chunkUrl).toBe('http://127.0.0.1:46001/machine-transfers/direct/transfer-1/chunks/0');
                expect(chunkInit?.headers).toMatchObject({
                    authorization: 'Bearer token-1',
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
        });

        expect(result).toEqual({
            ok: true,
            payload,
        });
    });

    it('downloads a direct-export payload into a destination sink', async () => {
        const payloadBytes = new TextEncoder().encode('hello');
        const manifestHash = await createManifestHash(payloadBytes);

        callGuardedMachineRpcWithPolicyMock.mockResolvedValueOnce({
            success: true,
            transferId: 'transfer-2',
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
                'content-type': 'application/json',
            });

            const requestBody = JSON.parse(String(init?.body ?? '{}'));
            const envelope = await createEncryptedTransferChunkEnvelope({
                transferId: 'transfer-2',
                sequence: 0,
                payload: payloadBytes,
                recipientPublicKeyBase64: requestBody.recipientPublicKeyBase64,
            });

            runtimeFetchMock.mockImplementationOnce(async (chunkUrl: string, chunkInit?: RequestInit) => {
                expect(chunkUrl).toBe('http://127.0.0.1:46001/machine-transfers/direct/transfer-2/chunks/0');
                expect(chunkInit?.headers).toMatchObject({
                    authorization: 'Bearer token-2',
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
            const requestBody = JSON.parse(String(init?.body ?? '{}'));
            const envelope = await createEncryptedTransferChunkEnvelope({
                transferId: 'transfer-3',
                sequence: 0,
                payload: payloadBytes,
                recipientPublicKeyBase64: requestBody.recipientPublicKeyBase64,
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
    });
});
