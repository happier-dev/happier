import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
    createEncryptedTransferChunkEnvelope,
    createTransferRecipientKeyPair,
} from '@/sync/domains/files/transfers/transferChunkEncryption';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));

describe('machine prompt assets ops (server-scoped routing)', () => {
    beforeEach(() => {
        machineRpcWithServerScopeMock.mockReset();
    });

    it('routes prompt asset type listing through server-scoped machine rpc', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ ok: true, types: [] });
        const { machinePromptAssetsListTypes } = await import('./machinePromptAssets');

        const res = await machinePromptAssetsListTypes('machine-1', { serverId: 'server-a' });

        expect(res).toEqual({ ok: true, types: [] });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_PROMPT_ASSETS_LIST_TYPES,
            payload: undefined,
        }));
    });

    it('routes prompt asset discovery through server-scoped machine rpc', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ ok: true, items: [] });
        const { machinePromptAssetsDiscover } = await import('./machinePromptAssets');

        const res = await machinePromptAssetsDiscover(
            'machine-1',
            { assetTypeId: 'agents.skill', scope: 'project', directory: '/tmp/project' },
            { serverId: 'server-a' },
        );

        expect(res).toEqual({ ok: true, items: [] });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_PROMPT_ASSETS_DISCOVER,
            payload: expect.objectContaining({ assetTypeId: 'agents.skill', scope: 'project', directory: '/tmp/project' }),
        }));
    });

    it('downloads prompt asset payloads through the machine-scoped transfer lifecycle', async () => {
        const payload = {
            assetTypeId: 'agents.skill',
            scope: 'user',
            externalRef: { name: 'skill-a' },
            title: 'Skill A',
            libraryKind: 'bundle',
            bundleSchemaId: 'skills.skill_md_v1',
            digest: 'digest-a',
            displayPath: '~/.agents/skills/skill-a',
            bundleBody: {
                v: 1,
                entries: [],
                createdAtMs: 1,
                updatedAtMs: 1,
            },
        };
        machineRpcWithServerScopeMock
            .mockImplementationOnce(async ({ payload: initPayload }: { payload: { recipientPublicKeyBase64: string } }) => ({
                success: true,
                downloadId: 'download-1',
                chunkSizeBytes: 4096,
                sizeBytes: Buffer.byteLength(JSON.stringify(payload)),
                name: 'skill-a.prompt-asset.json',
                recipientPublicKeyBase64: initPayload.recipientPublicKeyBase64,
            }))
            .mockImplementationOnce(async () => {
                const encryptedChunk = await createEncryptedTransferChunkEnvelope({
                    transferId: 'download-1',
                    sequence: 0,
                    payload: new TextEncoder().encode(JSON.stringify(payload)),
                    recipientPublicKeyBase64: machineRpcWithServerScopeMock.mock.calls[0]?.[0]?.payload?.recipientPublicKeyBase64,
                });
                return {
                    success: true,
                    payloadBase64: encryptedChunk.payloadBase64,
                    encryptedDataKeyEnvelopeBase64: encryptedChunk.encryptedDataKeyEnvelopeBase64,
                    isLast: true,
                };
            })
            .mockResolvedValueOnce({
                success: true,
            });
        const { machinePromptAssetsDownload } = await import('./machinePromptAssets');

        const res = await machinePromptAssetsDownload(
            'machine-1',
            { assetTypeId: 'agents.skill', scope: 'user', externalRef: { name: 'skill-a' } },
            { serverId: 'server-a' },
        );

        expect(res).toEqual({ ok: true, item: payload });
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_INIT,
            payload: expect.objectContaining({
                assetTypeId: 'agents.skill',
                scope: 'user',
                externalRef: { name: 'skill-a' },
                recipientPublicKeyBase64: expect.any(String),
            }),
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_CHUNK,
            payload: { downloadId: 'download-1', index: 0 },
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(3, expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_FINALIZE,
            payload: { downloadId: 'download-1' },
        }));
    });

    it('uploads prompt asset writes through the machine-scoped transfer lifecycle', async () => {
        const bundleBody = {
            v: 1 as const,
            entries: [],
            createdAtMs: 1,
            updatedAtMs: 1,
        };
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({
                success: true,
                uploadId: 'upload-1',
                chunkSizeBytes: 4096,
                recipientPublicKeyBase64: createTransferRecipientKeyPair().recipientPublicKeyBase64,
            })
            .mockResolvedValueOnce({
                success: true,
            })
            .mockResolvedValueOnce({
                success: true,
                response: {
                    ok: true,
                    externalRef: { skillName: 'writer' },
                    digest: 'digest-a',
                },
            });
        const { machinePromptAssetsWrite } = await import('./machinePromptAssets');

        const res = await machinePromptAssetsWrite(
            'machine-1',
            {
                assetTypeId: 'agents.skill',
                scope: 'user',
                externalRef: null,
                targetName: 'writer',
                title: 'Writer',
                bundleSchemaId: 'skills.skill_md_v1',
                bundleBody,
                previewOnly: false,
                expectedDigest: null,
            },
            { serverId: 'server-a' },
        );

        expect(res).toEqual({
            ok: true,
            externalRef: { skillName: 'writer' },
            digest: 'digest-a',
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_PROMPT_ASSETS_UPLOAD_INIT,
            payload: { sizeBytes: expect.any(Number) },
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_PROMPT_ASSETS_UPLOAD_CHUNK,
            payload: expect.objectContaining({
                uploadId: 'upload-1',
                index: 0,
                payloadBase64: expect.any(String),
                encryptedDataKeyEnvelopeBase64: expect.any(String),
            }),
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(3, expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_PROMPT_ASSETS_UPLOAD_FINALIZE,
            payload: { uploadId: 'upload-1' },
        }));
    });
});
