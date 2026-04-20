import {
    DaemonVoiceInferenceModelsInstallResponseSchema,
    DaemonVoiceInferenceModelsListResponseSchema,
    DaemonVoiceInferenceModelsRemoveResponseSchema,
    DaemonVoiceInferenceModelsStatusResponseSchema,
    DaemonVoiceInferenceStatusResponseSchema,
    DaemonVoiceInferenceTtsAbortResponseSchema,
    DaemonVoiceInferenceTtsChunkResponseSchema,
    DaemonVoiceInferenceTtsFinalizeResponseSchema,
    DaemonVoiceInferenceTtsSynthesizeResponseSchema,
    DaemonVoiceInferenceSttUploadAbortResponseSchema,
    DaemonVoiceInferenceSttUploadChunkResponseSchema,
    DaemonVoiceInferenceSttUploadFinalizeResponseSchema,
    DaemonVoiceInferenceSttUploadInitResponseSchema,
    DaemonVoiceInferenceSttTranscribeResponseSchema,
    type DaemonVoiceInferenceAudioOutput,
    type DaemonVoiceInferenceModelStatus,
    type DaemonVoiceInferenceStatusResponse,
    type DaemonVoiceInferenceTtsSynthesizeResponse,
    type DaemonVoiceInferenceSttTranscribeResponse,
    type DaemonVoiceInferenceNormalizationDecision,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { isRuntimeFeatureEnabled } from '@/sync/domains/features/featureDecisionInputs';
import type { LocalUploadSource } from '@/sync/runtime/files/localUploadSourceReader';
import { openLocalUploadSourceReader } from '@/sync/runtime/files/localUploadSourceReader';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { downloadInChunks, uploadInChunks } from '@/sync/domains/transfers/runtime/transferRuntime/carriers/chunkTransferClient';
import { randomUUID } from '@/platform/randomUUID';
import { readMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { ensureVoiceConversationSessionForVoiceHome } from '@/voice/persistence/voiceConversationSession';

import { createDaemonVoiceInferenceClientError } from './daemonVoiceInferenceErrors';

function parseSchema<T>(schema: Readonly<{ parse: (input: unknown) => T }>, value: unknown): T {
    try {
        return schema.parse(value);
    } catch {
        throw createDaemonVoiceInferenceClientError('internal_error', 'daemon_voice_inference_invalid_response');
    }
}

function throwIfErrorResponse<T extends Readonly<{
    ok: boolean;
    error?: string;
    errorCode?: string;
}>>(
    response: T,
): asserts response is Exclude<T, Readonly<{ ok: false }>> {
    if (response && typeof response === 'object' && 'ok' in response && response.ok === false) {
        throw createDaemonVoiceInferenceClientError(
            (response.errorCode ?? 'internal_error') as Parameters<typeof createDaemonVoiceInferenceClientError>[0],
            response.error ?? 'daemon_voice_inference_error',
        );
    }
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
    const totalSize = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const merged = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return merged;
}

export type DaemonVoiceInferenceMachineTarget = Readonly<{
    sessionId: string;
    machineId: string;
    basePath: string;
}>;

export type DaemonVoiceInferenceClientDeps = Readonly<{
    ensureVoiceConversationSessionForVoiceHome: typeof ensureVoiceConversationSessionForVoiceHome;
    readMachineTargetForSession: typeof readMachineTargetForSession;
    machineRpcWithServerScope: typeof machineRpcWithServerScope;
    isRuntimeFeatureEnabled: typeof isRuntimeFeatureEnabled;
    openLocalUploadSourceReader: typeof openLocalUploadSourceReader;
    createRequestId: () => string;
}>;

export class DaemonVoiceInferenceClient {
    private readonly deps: DaemonVoiceInferenceClientDeps;

    constructor(deps?: Partial<DaemonVoiceInferenceClientDeps>) {
        this.deps = {
            ensureVoiceConversationSessionForVoiceHome,
            readMachineTargetForSession,
            machineRpcWithServerScope,
            isRuntimeFeatureEnabled,
            openLocalUploadSourceReader,
            createRequestId: randomUUID,
            ...deps,
        };
    }

    private async assertFeatureEnabled(): Promise<void> {
        const enabled = await this.deps.isRuntimeFeatureEnabled({
            featureId: 'voice.daemonInference',
        }).catch(() => false);
        if (!enabled) {
            throw createDaemonVoiceInferenceClientError('feature_disabled');
        }
    }

    private async resolveMachineTarget(): Promise<DaemonVoiceInferenceMachineTarget> {
        await this.assertFeatureEnabled();
        const sessionId = await this.deps.ensureVoiceConversationSessionForVoiceHome();
        const machineTarget = this.deps.readMachineTargetForSession(sessionId);
        if (!machineTarget?.machineId || !machineTarget?.basePath) {
            throw createDaemonVoiceInferenceClientError('machine_unreachable');
        }
        return {
            sessionId,
            machineId: machineTarget.machineId,
            basePath: machineTarget.basePath,
        };
    }

    async getStatus(): Promise<Extract<DaemonVoiceInferenceStatusResponse, { ok: true }>> {
        const machineTarget = await this.resolveMachineTarget();
        const response = parseSchema(
            DaemonVoiceInferenceStatusResponseSchema,
            await this.deps.machineRpcWithServerScope({
                machineId: machineTarget.machineId,
                method: RPC_METHODS.DAEMON_VOICE_INFERENCE_STATUS,
                payload: {},
            }),
        );
        throwIfErrorResponse(response);
        return response;
    }

    async listModels(): Promise<readonly DaemonVoiceInferenceModelStatus[]> {
        const machineTarget = await this.resolveMachineTarget();
        const response = parseSchema(
            DaemonVoiceInferenceModelsListResponseSchema,
            await this.deps.machineRpcWithServerScope({
                machineId: machineTarget.machineId,
                method: RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_LIST,
                payload: {},
            }),
        );
        throwIfErrorResponse(response);
        return response.models;
    }

    async getModelsStatus(packIds?: readonly string[] | null): Promise<readonly DaemonVoiceInferenceModelStatus[]> {
        const machineTarget = await this.resolveMachineTarget();
        const response = parseSchema(
            DaemonVoiceInferenceModelsStatusResponseSchema,
            await this.deps.machineRpcWithServerScope({
                machineId: machineTarget.machineId,
                method: RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_STATUS,
                payload: packIds && packIds.length > 0 ? { packIds } : {},
            }),
        );
        throwIfErrorResponse(response);
        return response.models;
    }

    async installModel(params: Readonly<{
        packId: string;
    }>): Promise<DaemonVoiceInferenceModelStatus> {
        const machineTarget = await this.resolveMachineTarget();
        const response = parseSchema(
            DaemonVoiceInferenceModelsInstallResponseSchema,
            await this.deps.machineRpcWithServerScope({
                machineId: machineTarget.machineId,
                method: RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_INSTALL,
                payload: { packId: params.packId },
            }),
        );
        throwIfErrorResponse(response);
        return response.model;
    }

    async removeModel(packId: string): Promise<void> {
        const machineTarget = await this.resolveMachineTarget();
        const response = parseSchema(
            DaemonVoiceInferenceModelsRemoveResponseSchema,
            await this.deps.machineRpcWithServerScope({
                machineId: machineTarget.machineId,
                method: RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_REMOVE,
                payload: { packId },
            }),
        );
        throwIfErrorResponse(response);
    }

    async synthesizeText(params: Readonly<{
        sessionId?: string | null;
        text: string;
        packId: string | null;
        voiceId: string | null;
        speed: number | null;
        output: DaemonVoiceInferenceAudioOutput;
        signal?: AbortSignal | null;
    }>): Promise<Readonly<{ bytes: Uint8Array; output: DaemonVoiceInferenceAudioOutput }>> {
        const machineTarget = await this.resolveMachineTarget();
        const requestId = this.deps.createRequestId();
        const cancelRequest = async () => {
            try {
                await this.deps.machineRpcWithServerScope({
                    machineId: machineTarget.machineId,
                    method: RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_CANCEL,
                    payload: { requestId },
                });
            } catch {
                // best effort
            }
        };
        const abortListener = () => {
            void cancelRequest();
        };
        params.signal?.addEventListener('abort', abortListener, { once: true });

        try {
            const synthesizeResponse = parseSchema<DaemonVoiceInferenceTtsSynthesizeResponse>(
                DaemonVoiceInferenceTtsSynthesizeResponseSchema,
                await this.deps.machineRpcWithServerScope({
                    machineId: machineTarget.machineId,
                    method: RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_SYNTHESIZE,
                    payload: {
                        requestId,
                        text: params.text,
                        packId: params.packId,
                        voiceId: params.voiceId,
                        speed: params.speed,
                        output: params.output,
                    },
                }),
            );
            throwIfErrorResponse(synthesizeResponse);

            const chunks: Uint8Array[] = [];
            const downloadResult = await downloadInChunks({
                init: async () => ({
                    success: true,
                    downloadId: synthesizeResponse.downloadId,
                    chunkSizeBytes: synthesizeResponse.chunkSizeBytes,
                    sizeBytes: synthesizeResponse.sizeBytes,
                }),
                readChunk: async ({ downloadId, index }) =>
                    parseSchema(
                        DaemonVoiceInferenceTtsChunkResponseSchema,
                        await this.deps.machineRpcWithServerScope({
                            machineId: machineTarget.machineId,
                            method: RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_CHUNK,
                            payload: { downloadId, index },
                        }),
                    ),
                finalize: async ({ downloadId }) =>
                    parseSchema(
                        DaemonVoiceInferenceTtsFinalizeResponseSchema,
                        await this.deps.machineRpcWithServerScope({
                            machineId: machineTarget.machineId,
                            method: RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_FINALIZE,
                            payload: { downloadId },
                        }),
                    ),
                abort: async ({ downloadId }) =>
                    parseSchema(
                        DaemonVoiceInferenceTtsAbortResponseSchema,
                        await this.deps.machineRpcWithServerScope({
                            machineId: machineTarget.machineId,
                            method: RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_ABORT,
                            payload: { downloadId },
                        }),
                    ),
                writeBytes: async (bytes) => {
                    chunks.push(bytes);
                },
                signal: params.signal ?? null,
            });

            if (!downloadResult.ok) {
                throw createDaemonVoiceInferenceClientError('download_failed', downloadResult.error);
            }

            return {
                bytes: concatBytes(chunks),
                output: synthesizeResponse.output,
            };
        } finally {
            params.signal?.removeEventListener('abort', abortListener);
        }
    }

    async transcribeRecordedAudio(params: Readonly<{
        sessionId?: string | null;
        source: LocalUploadSource;
        inputMimeType: string;
        packId: string | null;
        language: string | null;
        normalization?: DaemonVoiceInferenceNormalizationDecision | null;
        signal?: AbortSignal | null;
    }>): Promise<Readonly<{
        text: string;
        language: string | null;
        modelPackId: string | null;
    }>> {
        const machineTarget = await this.resolveMachineTarget();
        const requestId = this.deps.createRequestId();
        const cancelRequest = async () => {
            try {
                await this.deps.machineRpcWithServerScope({
                    machineId: machineTarget.machineId,
                    method: RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_CANCEL,
                    payload: { requestId },
                });
            } catch {
                // best effort
            }
        };
        const abortListener = () => {
            void cancelRequest();
        };
        params.signal?.addEventListener('abort', abortListener, { once: true });

        const reader = await this.deps.openLocalUploadSourceReader(params.source);
        try {
            const sizeBytes = typeof reader.sizeBytes === 'number' && Number.isFinite(reader.sizeBytes) && reader.sizeBytes > 0
                ? reader.sizeBytes
                : null;
            if (!sizeBytes) {
                throw createDaemonVoiceInferenceClientError('upload_size_unavailable');
            }

            const uploadResult = await uploadInChunks({
                totalBytes: sizeBytes,
                readBytes: reader.readBytes,
                init: async () =>
                    parseSchema(
                        DaemonVoiceInferenceSttUploadInitResponseSchema,
                        await this.deps.machineRpcWithServerScope({
                            machineId: machineTarget.machineId,
                            method: RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_INIT,
                            payload: {
                                requestId,
                                sizeBytes,
                                inputMimeType: params.inputMimeType,
                            },
                        }),
                    ),
                sendChunk: async (request) =>
                    parseSchema(
                        DaemonVoiceInferenceSttUploadChunkResponseSchema,
                        await this.deps.machineRpcWithServerScope({
                            machineId: machineTarget.machineId,
                            method: RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_CHUNK,
                            payload: request,
                        }),
                    ),
                finalize: async ({ uploadId }) =>
                    parseSchema(
                        DaemonVoiceInferenceSttUploadFinalizeResponseSchema,
                        await this.deps.machineRpcWithServerScope({
                            machineId: machineTarget.machineId,
                            method: RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_FINALIZE,
                            payload: { uploadId },
                        }),
                    ),
                abort: async ({ uploadId }) =>
                    parseSchema(
                        DaemonVoiceInferenceSttUploadAbortResponseSchema,
                        await this.deps.machineRpcWithServerScope({
                            machineId: machineTarget.machineId,
                            method: RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_ABORT,
                            payload: { uploadId },
                        }),
                    ),
                signal: params.signal ?? null,
            });

            if (!uploadResult.success) {
                throw createDaemonVoiceInferenceClientError('upload_failed', uploadResult.error);
            }

            const transcribeResponse = parseSchema<DaemonVoiceInferenceSttTranscribeResponse>(
                DaemonVoiceInferenceSttTranscribeResponseSchema,
                await this.deps.machineRpcWithServerScope({
                    machineId: machineTarget.machineId,
                    method: RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_TRANSCRIBE,
                    payload: {
                        requestId,
                        uploadId: uploadResult.uploadId,
                        packId: params.packId,
                        language: params.language,
                        normalization: params.normalization ?? {
                            inputTransport: 'upload_transfer',
                            strategy: 'daemon_decode',
                            systemFfmpegAllowed: false,
                        },
                    },
                }),
            );
            throwIfErrorResponse(transcribeResponse);
            return {
                text: transcribeResponse.text,
                language: transcribeResponse.language,
                modelPackId: transcribeResponse.modelPackId,
            };
        } finally {
            params.signal?.removeEventListener('abort', abortListener);
            await reader.close();
        }
    }
}
