import {
    DaemonVoiceInferenceModelsInstallResponseSchema,
    DaemonVoiceInferenceModelLicenseAcceptResponseSchema,
    DaemonVoiceInferenceModelsListResponseSchema,
    DaemonVoiceInferenceModelsRemoveResponseSchema,
    DaemonVoiceInferenceModelsStatusResponseSchema,
    DaemonVoiceInferenceStatusResponseSchema,
    DaemonVoiceInferenceTtsAbortResponseSchema,
    DaemonVoiceInferenceTtsChunkResponseSchema,
    DaemonVoiceInferenceTtsFinalizeResponseSchema,
    DaemonVoiceInferenceTtsStreamAckResponseSchema,
    DaemonVoiceInferenceTtsStreamCancelResponseSchema,
    DaemonVoiceInferenceTtsStreamNextResponseSchema,
    DaemonVoiceInferenceTtsStreamStartResponseSchema,
    DaemonVoiceInferenceTtsSynthesizeResponseSchema,
    DaemonVoiceInferenceSttUploadAbortResponseSchema,
    DaemonVoiceInferenceSttUploadChunkResponseSchema,
    DaemonVoiceInferenceSttUploadFinalizeResponseSchema,
    DaemonVoiceInferenceSttUploadInitResponseSchema,
    DaemonVoiceInferenceSttStreamCancelResponseSchema,
    DaemonVoiceInferenceSttStreamChunkResponseSchema,
    DaemonVoiceInferenceSttStreamFinishResponseSchema,
    DaemonVoiceInferenceSttStreamStartResponseSchema,
    DaemonVoiceInferenceSttTranscribeResponseSchema,
    type DaemonVoiceInferenceAudioOutput,
    type DaemonVoiceInferenceModelStatus,
    type DaemonVoiceInferenceModelLicenseAcceptRequest,
    type DaemonVoiceInferenceStatusResponse,
    type DaemonVoiceInferenceTtsSynthesizeResponse,
    type DaemonVoiceInferenceTtsStreamEvent,
    type DaemonVoiceInferenceSttTranscribeResponse,
    type DaemonVoiceInferenceSttStreamChunkResponse,
    type DaemonVoiceInferenceNormalizationDecision,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { isRuntimeFeatureEnabled } from '@/sync/domains/features/featureDecisionInputs';
import type { LocalUploadSource } from '@/sync/runtime/files/localUploadSourceReader';
import { openLocalUploadSourceReader } from '@/sync/runtime/files/localUploadSourceReader';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { downloadInChunks, uploadInChunks } from '@/sync/domains/transfers/runtime/transferRuntime/carriers/chunkTransferClient';
import { randomUUID } from '@/platform/randomUUID';
import {
    resolveVoiceHomeDaemonMachineId,
} from '@/voice/persistence/voiceConversationSession';
import {
    resolveVoiceDiagnosticsCaptureContext,
} from '@/voice/diagnostics/capturePolicy';

import {
    createDaemonSpeechStreamRpcCompatibilityCarrierAdapter,
    type DaemonSpeechStreamCarrierAdapter,
} from './DaemonSpeechStreamCarrier';
import {
    createDaemonSpeechStreamSender,
    type DaemonSpeechStreamSender,
    type DaemonSpeechStreamTransport,
    type DaemonSpeechStreamTransportChunkRequest,
} from './DaemonSpeechStreamSender';
import { createProductionDaemonSpeechStreamingSttTransport } from './DaemonSpeechStreamProductionTunnelTransport';
import { createDaemonVoiceInferenceClientError } from './daemonVoiceInferenceErrors';
import { resolveDaemonStreamingSttJsonRpcCompatibilityAllowed } from './daemonVoiceInferenceConfig';
import {
    daemonSpeechStreamDiagnostics,
    type DaemonSpeechStreamTransportSelection,
} from './daemonSpeechStreamDiagnostics';

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

function decodeBase64Bytes(value: string): Uint8Array {
    const bufferCtor = (globalThis as typeof globalThis & {
        Buffer?: { from: (value: string, encoding: 'base64') => Uint8Array };
    }).Buffer;
    if (bufferCtor) {
        return new Uint8Array(bufferCtor.from(value, 'base64'));
    }
    const binary = globalThis.atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
}

export type DaemonVoiceInferenceMachineTarget = Readonly<{
    machineId: string;
}>;

/**
 * Captured host-global execution target for machine-only model operations.
 * Supplying it makes a settings mutation fail closed if selection changed
 * before the feature/machine preflight completed, instead of roaming to the
 * newly-selected daemon.
 */
export type DaemonVoiceInferenceModelMachineScope = Readonly<{
    machineId: string;
}>;

export type DaemonVoiceInferenceClientDeps = Readonly<{
    resolveVoiceHomeDaemonMachineId: typeof resolveVoiceHomeDaemonMachineId;
    machineRpcWithServerScope: typeof machineRpcWithServerScope;
    isRuntimeFeatureEnabled: typeof isRuntimeFeatureEnabled;
    openLocalUploadSourceReader: typeof openLocalUploadSourceReader;
    createRequestId: () => string;
    createStreamingSttTransport: (
        input: DaemonVoiceInferenceStreamingSttTransportFactoryInput,
    ) => Promise<DaemonVoiceInferenceStreamingSttTransportSelection | null> | DaemonVoiceInferenceStreamingSttTransportSelection | null;
    allowStreamingSttJsonRpcCompatibility: () => boolean;
    recordStreamingSttTransportSelection: (selection: DaemonSpeechStreamTransportSelection) => void;
    resolveDiagnosticsCaptureContext: typeof resolveVoiceDiagnosticsCaptureContext;
}>;

export type DaemonVoiceInferenceStreamingSttTransportSelection = Readonly<{
    carrierAdapter: DaemonSpeechStreamCarrierAdapter;
    transport: DaemonSpeechStreamTransport;
}>;

export type DaemonVoiceInferenceStreamingSttTransportFactoryInput = Readonly<{
    machineTarget: DaemonVoiceInferenceMachineTarget;
    requestId: string;
    signal: AbortSignal | null;
    compatibilityTransport: DaemonSpeechStreamTransport;
}>;

export type DaemonSegmentedTtsSegment = Readonly<{
    type: 'segment';
    streamId: string;
    generation: number;
    segmentId: string;
    segmentIndex: number;
    segmentCount: number;
    text: string;
    bytes: Uint8Array;
    output: DaemonVoiceInferenceAudioOutput;
    isLastSegment: boolean;
}>;

export type DaemonSegmentedTtsEvent =
    | DaemonSegmentedTtsSegment
    | Extract<DaemonVoiceInferenceTtsStreamEvent, { type: 'done' | 'error' }>;

export type DaemonSegmentedTtsSession = Readonly<{
    streamId: string;
    generation: number;
    segmentCount: number;
    next: () => Promise<DaemonSegmentedTtsEvent>;
    ackSegment: (segment: DaemonSegmentedTtsSegment) => Promise<void>;
    cancel: () => Promise<void>;
}>;

export class DaemonVoiceInferenceClient {
    private readonly deps: DaemonVoiceInferenceClientDeps;

    constructor(deps?: Partial<DaemonVoiceInferenceClientDeps>) {
        this.deps = {
            resolveVoiceHomeDaemonMachineId,
            machineRpcWithServerScope,
            isRuntimeFeatureEnabled,
            openLocalUploadSourceReader,
            createRequestId: randomUUID,
            createStreamingSttTransport: createProductionDaemonSpeechStreamingSttTransport,
            allowStreamingSttJsonRpcCompatibility: resolveDaemonStreamingSttJsonRpcCompatibilityAllowed,
            recordStreamingSttTransportSelection: daemonSpeechStreamDiagnostics.record,
            resolveDiagnosticsCaptureContext: resolveVoiceDiagnosticsCaptureContext,
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

    private async resolveMachineId(scope?: DaemonVoiceInferenceModelMachineScope): Promise<string> {
        await this.assertFeatureEnabled();
        const machineId = this.deps.resolveVoiceHomeDaemonMachineId();
        if (!machineId || (scope && machineId !== scope.machineId)) {
            throw createDaemonVoiceInferenceClientError('machine_unreachable');
        }
        return scope?.machineId ?? machineId;
    }

    private async resolveMachineTarget(): Promise<DaemonVoiceInferenceMachineTarget> {
        await this.assertFeatureEnabled();
        const machineId = this.deps.resolveVoiceHomeDaemonMachineId();
        if (!machineId) {
            throw createDaemonVoiceInferenceClientError('machine_unreachable');
        }
        return { machineId };
    }

    async getStatus(): Promise<Extract<DaemonVoiceInferenceStatusResponse, { ok: true }>> {
        const machineId = await this.resolveMachineId();
        const response = parseSchema(
            DaemonVoiceInferenceStatusResponseSchema,
            await this.deps.machineRpcWithServerScope({
                machineId,
                method: RPC_METHODS.DAEMON_VOICE_INFERENCE_STATUS,
                payload: {},
            }),
        );
        throwIfErrorResponse(response);
        return response;
    }

    async listModels(scope?: DaemonVoiceInferenceModelMachineScope): Promise<readonly DaemonVoiceInferenceModelStatus[]> {
        const machineId = await this.resolveMachineId(scope);
        const response = parseSchema(
            DaemonVoiceInferenceModelsListResponseSchema,
            await this.deps.machineRpcWithServerScope({
                machineId,
                method: RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_LIST,
                payload: {},
            }),
        );
        throwIfErrorResponse(response);
        return response.models;
    }

    async getModelsStatus(
        packIds?: readonly string[] | null,
        scope?: DaemonVoiceInferenceModelMachineScope,
    ): Promise<readonly DaemonVoiceInferenceModelStatus[]> {
        const machineId = await this.resolveMachineId(scope);
        const response = parseSchema(
            DaemonVoiceInferenceModelsStatusResponseSchema,
            await this.deps.machineRpcWithServerScope({
                machineId,
                method: RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_STATUS,
                payload: packIds && packIds.length > 0 ? { packIds } : {},
            }),
        );
        throwIfErrorResponse(response);
        return response.models;
    }

    async installModel(params: Readonly<{
        packId: string;
    }>, scope?: DaemonVoiceInferenceModelMachineScope): Promise<DaemonVoiceInferenceModelStatus> {
        const machineId = await this.resolveMachineId(scope);
        const response = parseSchema(
            DaemonVoiceInferenceModelsInstallResponseSchema,
            await this.deps.machineRpcWithServerScope({
                machineId,
                method: RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_INSTALL,
                payload: { packId: params.packId },
            }),
        );
        throwIfErrorResponse(response);
        return response.model;
    }

    async acceptModelPackLicense(
        input: DaemonVoiceInferenceModelLicenseAcceptRequest,
        scope?: DaemonVoiceInferenceModelMachineScope,
    ): Promise<DaemonVoiceInferenceModelStatus> {
        const machineId = await this.resolveMachineId(scope);
        const response = parseSchema(
            DaemonVoiceInferenceModelLicenseAcceptResponseSchema,
            await this.deps.machineRpcWithServerScope({
                machineId,
                method: RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_LICENSE_ACCEPT,
                payload: input,
            }),
        );
        throwIfErrorResponse(response);
        return response.model;
    }

    async removeModel(packId: string, scope?: DaemonVoiceInferenceModelMachineScope): Promise<void> {
        const machineId = await this.resolveMachineId(scope);
        const response = parseSchema(
            DaemonVoiceInferenceModelsRemoveResponseSchema,
            await this.deps.machineRpcWithServerScope({
                machineId,
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
        const diagnostics = this.deps.resolveDiagnosticsCaptureContext({
            sessionId: params.sessionId,
            direction: 'tts_output',
            durationMs: null,
        });
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
                        ...(diagnostics ? { diagnostics } : {}),
                    },
                    // Thread the D12 abort signal so barge-in/cancel terminates the in-flight
                    // synthesis RPC immediately; the explicit tts.cancel above remains the
                    // daemon-side terminator.
                    ...(params.signal ? { signal: params.signal } : {}),
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

    async startSegmentedTts(params: Readonly<{
        sessionId?: string | null;
        text: string;
        packId: string | null;
        voiceId: string | null;
        speed: number | null;
        output: DaemonVoiceInferenceAudioOutput;
        signal?: AbortSignal | null;
    }>): Promise<DaemonSegmentedTtsSession> {
        const machineTarget = await this.resolveMachineTarget();
        const requestId = this.deps.createRequestId();
        const rpcSignal = params.signal ?? null;
        const diagnostics = this.deps.resolveDiagnosticsCaptureContext({
            sessionId: params.sessionId,
            direction: 'tts_output',
            durationMs: null,
        });
        const started = parseSchema(
            DaemonVoiceInferenceTtsStreamStartResponseSchema,
            await this.deps.machineRpcWithServerScope({
                machineId: machineTarget.machineId,
                method: RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_START,
                payload: {
                    requestId,
                    text: params.text,
                    packId: params.packId,
                    voiceId: params.voiceId,
                    speed: params.speed,
                    output: params.output,
                    prefetchDepth: 2,
                    ...(diagnostics ? { diagnostics } : {}),
                },
                ...(rpcSignal ? { signal: rpcSignal } : {}),
            }),
        );
        throwIfErrorResponse(started);

        let abortListener: (() => void) | null = null;
        let streamClosed = false;
        const detachAbortListener = () => {
            if (!abortListener) {
                return;
            }
            rpcSignal?.removeEventListener('abort', abortListener);
            abortListener = null;
        };

        const cancel = async () => {
            if (streamClosed) {
                return;
            }
            streamClosed = true;
            detachAbortListener();
            try {
                const response = parseSchema(
                    DaemonVoiceInferenceTtsStreamCancelResponseSchema,
                    await this.deps.machineRpcWithServerScope({
                        machineId: machineTarget.machineId,
                        method: RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_CANCEL,
                        payload: {
                            streamId: started.streamId,
                            generation: started.generation,
                            reason: 'client_abort',
                        },
                    }),
                );
                throwIfErrorResponse(response);
            } catch {
                // best effort
            }
        };

        abortListener = () => {
            void cancel();
        };
        rpcSignal?.addEventListener('abort', abortListener, { once: true });

        const session: DaemonSegmentedTtsSession = {
            streamId: started.streamId,
            generation: started.generation,
            segmentCount: started.segmentCount,
            next: async () => {
                const response = parseSchema(
                    DaemonVoiceInferenceTtsStreamNextResponseSchema,
                    await this.deps.machineRpcWithServerScope({
                        machineId: machineTarget.machineId,
                        method: RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_NEXT,
                        payload: {
                            streamId: started.streamId,
                            generation: started.generation,
                        },
                        ...(rpcSignal ? { signal: rpcSignal } : {}),
                    }),
                );
                throwIfErrorResponse(response);
                const event = response.event;
                if (event.type === 'done') {
                    streamClosed = true;
                    detachAbortListener();
                }
                if (event.type !== 'segment') {
                    return event;
                }
                return {
                    type: 'segment',
                    streamId: event.streamId,
                    generation: event.generation,
                    segmentId: event.segmentId,
                    segmentIndex: event.segmentIndex,
                    segmentCount: event.segmentCount,
                    text: event.text,
                    bytes: decodeBase64Bytes(event.audio.contentBase64),
                    output: event.output,
                    isLastSegment: event.isLastSegment,
                };
            },
            ackSegment: async (segment) => {
                const response = parseSchema(
                    DaemonVoiceInferenceTtsStreamAckResponseSchema,
                    await this.deps.machineRpcWithServerScope({
                        machineId: machineTarget.machineId,
                        method: RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_ACK,
                        payload: {
                            streamId: segment.streamId,
                            generation: segment.generation,
                            segmentId: segment.segmentId,
                            segmentIndex: segment.segmentIndex,
                        },
                    }),
                );
                throwIfErrorResponse(response);
                if (response.complete) {
                    streamClosed = true;
                    detachAbortListener();
                }
            },
            cancel,
        };
        return session;
    }

    async transcribeRecordedAudio(params: Readonly<{
        sessionId?: string | null;
        durationMs?: number | null;
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
        const durationMs = typeof params.durationMs === 'number' && Number.isFinite(params.durationMs)
            ? Math.max(0, params.durationMs)
            : null;
        const diagnostics = this.deps.resolveDiagnosticsCaptureContext({
            sessionId: params.sessionId,
            direction: 'stt_input',
            durationMs,
        });
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
                        ...(diagnostics ? { diagnostics } : {}),
                    },
                    // Thread the D12 abort signal so cancel terminates the in-flight transcription
                    // RPC immediately; the explicit stt.cancel above remains the daemon-side terminator.
                    ...(params.signal ? { signal: params.signal } : {}),
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

    async createStreamingSttSender(params: Readonly<{
        sessionId?: string | null;
        packId: string | null;
        language: string | null;
        signal?: AbortSignal | null;
    }>): Promise<DaemonSpeechStreamSender> {
        const machineTarget = await this.resolveMachineTarget();
        const requestId = this.deps.createRequestId();
        const rpcSignal = params.signal ?? null;
        const diagnostics = params.sessionId
            ? this.deps.resolveDiagnosticsCaptureContext({
                sessionId: params.sessionId,
                direction: 'stt_input',
                durationMs: null,
            })
            : undefined;
        const compatibilityTransport: DaemonSpeechStreamTransport = {
            start: async (payload) =>
                parseSchema(
                    DaemonVoiceInferenceSttStreamStartResponseSchema,
                    await this.deps.machineRpcWithServerScope({
                        machineId: machineTarget.machineId,
                        method: RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_START,
                        payload,
                        ...(rpcSignal ? { signal: rpcSignal } : {}),
                    }),
                ),
            chunk: async (payload) =>
                this.sendCompatibilityStreamingSttChunk(machineTarget.machineId, payload, rpcSignal),
            finish: async (payload) =>
                parseSchema(
                    DaemonVoiceInferenceSttStreamFinishResponseSchema,
                    await this.deps.machineRpcWithServerScope({
                        machineId: machineTarget.machineId,
                        method: RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_FINISH,
                        payload,
                        ...(rpcSignal ? { signal: rpcSignal } : {}),
                    }),
                ),
            cancel: async (payload) =>
                parseSchema(
                    DaemonVoiceInferenceSttStreamCancelResponseSchema,
                    await this.deps.machineRpcWithServerScope({
                        machineId: machineTarget.machineId,
                        method: RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_CANCEL,
                        payload,
                    }),
                ),
        };
        const selectedTransport = await this.deps.createStreamingSttTransport({
            machineTarget,
            requestId,
            signal: rpcSignal,
            compatibilityTransport,
        });
        if (!selectedTransport && !this.deps.allowStreamingSttJsonRpcCompatibility()) {
            this.deps.recordStreamingSttTransportSelection({
                sessionId: params.sessionId?.trim() || machineTarget.machineId,
                machineId: machineTarget.machineId,
                transport: 'json_rpc_compat_forbidden',
            });
            throw createDaemonVoiceInferenceClientError(
                'stream_transport_unavailable',
                'daemon_voice_inference_stream_transport_unavailable',
            );
        }
        const transport = selectedTransport ? 'binary_tunnel' : 'json_rpc_compat';
        this.deps.recordStreamingSttTransportSelection({
            sessionId: params.sessionId?.trim() || machineTarget.machineId,
            machineId: machineTarget.machineId,
            transport,
        });
        return createDaemonSpeechStreamSender({
            requestId,
            packId: params.packId,
            language: params.language,
            ...(diagnostics ? { diagnostics } : {}),
            carrierAdapter: selectedTransport?.carrierAdapter ?? createDaemonSpeechStreamRpcCompatibilityCarrierAdapter(),
            transport: selectedTransport?.transport ?? compatibilityTransport,
            transportKind: transport,
        });
    }

    private async sendCompatibilityStreamingSttChunk(
        machineId: string,
        payload: DaemonSpeechStreamTransportChunkRequest,
        signal: AbortSignal | null,
    ): Promise<DaemonVoiceInferenceSttStreamChunkResponse> {
        if (payload.carrierFrame.kind !== 'json_base64_v1_fallback') {
            throw createDaemonVoiceInferenceClientError(
                'internal_error',
                'daemon_voice_inference_binary_stream_consumer_unavailable',
            );
        }
        return parseSchema(
            DaemonVoiceInferenceSttStreamChunkResponseSchema,
            await this.deps.machineRpcWithServerScope({
                machineId,
                method: RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_CHUNK,
                payload: {
                    streamId: payload.streamId,
                    generation: payload.generation,
                    seq: payload.seq,
                    pcm16Base64: payload.carrierFrame.jsonBase64Envelope.pcm16Base64,
                },
                ...(signal ? { signal } : {}),
            }),
        );
    }
}
