import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { RpcError } from '@happier-dev/protocol/rpcErrors';
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
                expect(chunkUrl).toBe('http://127.0.0.1:46001/machine-transfers/direct/transfer-1/chunks/0');
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
        });

        expect(result).toEqual({
            ok: true,
            payload,
        });
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
                throw new Error('init callback exploded');
            },
        });

        await expect(resultPromise).resolves.toEqual({
            ok: false,
            error: 'init callback exploded',
        });
        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(close).not.toHaveBeenCalled();
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

    it('abandons a 500 direct-export open response and retries the next destination endpoint', async () => {
        const payloadBytes = new TextEncoder().encode('hello');
        const manifestHash = await createManifestHash(payloadBytes);

        callGuardedMachineRpcWithPolicyMock.mockResolvedValueOnce({
            success: true,
            transferId: 'transfer-open-500',
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
});
