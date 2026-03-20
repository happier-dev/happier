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

describe('machine prompt registries ops (server-scoped routing)', () => {
    beforeEach(() => {
        machineRpcWithServerScopeMock.mockReset();
    });

    it('downloads fetched registry item payloads through the machine-scoped transfer lifecycle', async () => {
        const payload = {
            sourceId: 'skills_sh:featured',
            itemId: 'skills_sh:featured:item-1',
            title: 'frontend-design',
            description: 'anthropics/skills',
            bundleSchemaId: 'skills.skill_md_v1',
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
                name: 'frontend-design.prompt-registry-item.json',
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

        const { machinePromptRegistriesDownloadItem } = await import('./machinePromptRegistries');

        const result = await machinePromptRegistriesDownloadItem(
            'machine-1',
            {
                sourceId: 'skills_sh:featured',
                itemId: 'skills_sh:featured:item-1',
                configuredSources: [],
            },
            { serverId: 'server-a' },
        );

        expect(result).toEqual({
            ok: true,
            item: payload,
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_PROMPT_REGISTRY_DOWNLOAD_INIT,
            payload: expect.objectContaining({
                sourceId: 'skills_sh:featured',
                itemId: 'skills_sh:featured:item-1',
                configuredSources: [],
                recipientPublicKeyBase64: expect.any(String),
            }),
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_PROMPT_REGISTRY_DOWNLOAD_CHUNK,
            payload: { downloadId: 'download-1', index: 0 },
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(3, expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_PROMPT_REGISTRY_DOWNLOAD_FINALIZE,
            payload: { downloadId: 'download-1' },
        }));
    });
});
