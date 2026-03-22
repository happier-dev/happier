import { uploadInChunks } from '@/sync/domains/files/transfers/chunkTransferClient';
import { assertRpcResponseWithSuccess } from '@/sync/runtime/assertRpcResponseWithSuccess';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

type MachineUploadInitResponse =
    | Readonly<{ success: true; uploadId: string; chunkSizeBytes: number; recipientPublicKeyBase64: string }>
    | Readonly<{ success: false; error: string; errorCode?: string }>;

type MachineUploadChunkResponse =
    | Readonly<{ success: true }>
    | Readonly<{ success: false; error: string; errorCode?: string }>;

type MachineUploadFinalizeResponse =
    | Readonly<{ success: true; response?: unknown }>
    | Readonly<{ success: false; error: string; errorCode?: string }>;

type MachineUploadTransferResult<TResponse> =
    | Readonly<{ ok: true; response: TResponse }>
    | Readonly<{ ok: false; error: string }>;

export async function uploadMachineTransferJsonPayload<TResponse>(params: Readonly<{
    machineId: string;
    payload: unknown;
    methods: Readonly<{
        init: string;
        chunk: string;
        finalize: string;
        abort: string;
    }>;
    parseResponse: (value: unknown) => TResponse | null;
    serverId?: string;
    timeoutMs?: number;
}>): Promise<MachineUploadTransferResult<TResponse>> {
    const encodedPayload = new TextEncoder().encode(JSON.stringify(params.payload));

    const finalized = await uploadInChunks<MachineUploadInitResponse, MachineUploadChunkResponse, MachineUploadFinalizeResponse>({
        totalBytes: encodedPayload.byteLength,
        readBytes: async (offset, length) => encodedPayload.subarray(offset, offset + length),
        init: async () => assertRpcResponseWithSuccess<MachineUploadInitResponse>(await machineRpcWithServerScope({
            machineId: params.machineId,
            serverId: params.serverId,
            timeoutMs: params.timeoutMs,
            method: params.methods.init,
            payload: { sizeBytes: encodedPayload.byteLength },
        })),
        sendChunk: async (request) => assertRpcResponseWithSuccess<MachineUploadChunkResponse>(await machineRpcWithServerScope({
            machineId: params.machineId,
            serverId: params.serverId,
            timeoutMs: params.timeoutMs,
            method: params.methods.chunk,
            payload: request,
        })),
        finalize: async (request) => assertRpcResponseWithSuccess<MachineUploadFinalizeResponse>(await machineRpcWithServerScope({
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
    });

    if (!finalized.success) {
        return {
            ok: false,
            error: finalized.error,
        };
    }

    const parsedResponse = params.parseResponse(finalized);
    if (parsedResponse === null) {
        return {
            ok: false,
            error: 'Uploaded transfer payload returned an unsupported response',
        };
    }

    return {
        ok: true,
        response: parsedResponse,
    };
}
