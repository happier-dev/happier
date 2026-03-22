import { assertRpcResponseWithSuccess } from '@/sync/runtime/assertRpcResponseWithSuccess';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { downloadInChunks } from '@/sync/domains/files/transfers/chunkTransferClient';
import { createTransferRecipientKeyPair } from '@/sync/domains/files/transfers/transferChunkEncryption';
import { mergeTransferChunks } from '@/sync/domains/transfers/runtime/mergeTransferChunks';

type MachineDownloadInitResponse =
    | Readonly<{ success: true; downloadId: string; chunkSizeBytes: number; sizeBytes: number; name: string }>
    | Readonly<{ success: false; error: string; errorCode?: string }>;

type MachineDownloadChunkResponse =
    | Readonly<{ success: true; payloadBase64: string; encryptedDataKeyEnvelopeBase64: string; isLast: boolean }>
    | Readonly<{ success: false; error: string; errorCode?: string }>;

type MachineDownloadFinalizeResponse =
    | Readonly<{ success: true }>
    | Readonly<{ success: false; error: string; errorCode?: string }>;

type MachineDownloadTransferResult<TPayload> =
    | Readonly<{ ok: true; payload: TPayload }>
    | Readonly<{ ok: false; error: string }>;

export async function downloadMachineTransferJsonPayload<TPayload>(params: Readonly<{
    machineId: string;
    request: unknown;
    methods: Readonly<{
        init: string;
        chunk: string;
        finalize: string;
        abort: string;
    }>;
    parsePayload: (value: unknown) => TPayload | null;
    serverId?: string;
    timeoutMs?: number;
}>): Promise<MachineDownloadTransferResult<TPayload>> {
    const chunks: Uint8Array[] = [];
    const recipientKeyPair = createTransferRecipientKeyPair();

    const download = await downloadInChunks<MachineDownloadInitResponse, MachineDownloadChunkResponse, MachineDownloadFinalizeResponse>({
        init: async () => assertRpcResponseWithSuccess<MachineDownloadInitResponse>(await machineRpcWithServerScope({
            machineId: params.machineId,
            serverId: params.serverId,
            timeoutMs: params.timeoutMs,
            method: params.methods.init,
            payload: {
                ...(params.request as Record<string, unknown>),
                recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
            },
        })),
        readChunk: async (request) => assertRpcResponseWithSuccess<MachineDownloadChunkResponse>(await machineRpcWithServerScope({
            machineId: params.machineId,
            serverId: params.serverId,
            timeoutMs: params.timeoutMs,
            method: params.methods.chunk,
            payload: request,
        })),
        finalize: async (request) => assertRpcResponseWithSuccess<MachineDownloadFinalizeResponse>(await machineRpcWithServerScope({
            machineId: params.machineId,
            serverId: params.serverId,
            timeoutMs: params.timeoutMs,
            method: params.methods.finalize,
            payload: request,
        })),
        abort: async (request) => await machineRpcWithServerScope({
            machineId: params.machineId,
            serverId: params.serverId,
            timeoutMs: params.timeoutMs,
            method: params.methods.abort,
            payload: request,
        }),
        recipientSecretKeySeed: recipientKeyPair.recipientSecretKeySeed,
        writeBytes: async (bytes) => {
            chunks.push(bytes);
        },
    });

    if (!download.ok) {
        return download;
    }

    let parsedJson: unknown;
    try {
        parsedJson = JSON.parse(new TextDecoder('utf-8', { fatal: false }).decode(mergeTransferChunks(chunks)));
    } catch {
        return {
            ok: false,
            error: 'Downloaded transfer payload is not valid JSON',
        };
    }

    const parsedPayload = params.parsePayload(parsedJson);
    if (parsedPayload === null) {
        return {
            ok: false,
            error: 'Downloaded transfer payload returned an unsupported response',
        };
    }

    return {
        ok: true,
        payload: parsedPayload,
    };
}
