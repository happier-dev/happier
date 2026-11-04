import {
    DAEMON_VOICE_INFERENCE_STT_STREAM_CHUNK_BASE64_MAX_LENGTH,
    DaemonVoiceInferenceModelsInstallResponseSchema,
    DaemonVoiceInferenceModelLicenseAcceptResponseSchema,
    DaemonVoiceInferenceModelsListResponseSchema,
    DaemonVoiceInferenceModelsRemoveResponseSchema,
    DaemonVoiceInferenceModelsStatusResponseSchema,
    DaemonVoiceInferenceStatusResponseSchema,
    DaemonVoiceInferenceTtsStreamAckResponseSchema,
    DaemonVoiceInferenceTtsStreamCancelResponseSchema,
    DaemonVoiceInferenceTtsStreamNextResponseSchema,
    DaemonVoiceInferenceTtsStreamStartResponseSchema,
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
    type DaemonVoiceInferenceTtsStreamEvent,
    type DaemonVoiceInferenceSttTranscribeResponse,
    type DaemonVoiceInferenceSttStreamChunkResponse,
    type DaemonVoiceInferenceNormalizationDecision,
} from '@happier-dev/protocol/daemon/voiceInference';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { runWithServerAccountScopeRequestGuard } from '@/sync/runtime/orchestration/serverScopedRpc/serverAccountScopeRequestGuard';

import { isRuntimeFeatureEnabled } from '@/sync/domains/features/featureDecisionInputs';
import type { LocalUploadSource } from '@/sync/runtime/files/localUploadSourceReader';
import { openLocalUploadSourceReader } from '@/sync/runtime/files/localUploadSourceReader';
import { createOrderedMachineRpcCaller, machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { uploadInChunks } from '@/sync/domains/transfers/runtime/transferRuntime/carriers/chunkTransferClient';
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
    sessionId?: string | null;
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

/**
 * Deadline a model install RPC declares to the daemon.
 *
 * This is a request deadline, not a stall budget: the daemon aborts the install
 * (and rolls its staging back) when it elapses, so it has to outlast a real
 * pack download rather than the ordinary interactive RPC default. Installs are
 * otherwise bounded by the caller's own signal, not by a clock.
 */
export const VOICE_MODEL_INSTALL_RPC_TIMEOUT_MS = 30 * 60_000;

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

    /** Cleanup outlives speech interruption, but never its admitting Account. */
    private captureCleanupRpc() {
        const account = captureActiveServerAccountScopeLifetime();
        return async (request: Parameters<typeof machineRpcWithServerScope>[0]): Promise<unknown> => {
            if (!account) throw createDaemonVoiceInferenceClientError('cancelled');
            return await runWithServerAccountScopeRequestGuard({
                scope: account.scope,
                isCurrent: account.isCurrent,
                staleError: () => createDaemonVoiceInferenceClientError('cancelled'),
            }, async guard => await this.deps.machineRpcWithServerScope({ ...request,
                serverId: account.scope.serverId, accountId: account.scope.accountId, signal: guard.signal,
            }));
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

    private async resolveMachineTarget(
        capturedTarget?: DaemonVoiceInferenceMachineTarget | null,
    ): Promise<DaemonVoiceInferenceMachineTarget> {
        await this.assertFeatureEnabled();
        const capturedMachineId = typeof capturedTarget?.machineId === 'string'
            ? capturedTarget.machineId.trim()
            : '';
        if (capturedMachineId) {
            return { machineId: capturedMachineId };
        }
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

    async listModels(scope?: DaemonVoiceInferenceModelMachineScope, signal?: AbortSignal): Promise<readonly DaemonVoiceInferenceModelStatus[]> {
        const machineId = await this.resolveMachineId(scope);
        const response = parseSchema(
            DaemonVoiceInferenceModelsListResponseSchema,
            await this.deps.machineRpcWithServerScope({
                machineId,
                method: RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_LIST,
                signal,
                payload: {},
            }),
        );
        throwIfErrorResponse(response);
        return response.models;
    }

    async getModelsStatus(
        packIds?: readonly string[] | null,
        scope?: DaemonVoiceInferenceModelMachineScope,
        signal?: AbortSignal,
    ): Promise<readonly DaemonVoiceInferenceModelStatus[]> {
        const machineId = await this.resolveMachineId(scope);
        const response = parseSchema(
            DaemonVoiceInferenceModelsStatusResponseSchema,
            await this.deps.machineRpcWithServerScope({
                machineId,
                method: RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_STATUS,
                signal,
                payload: packIds && packIds.length > 0 ? { packIds } : {},
            }),
        );
        throwIfErrorResponse(response);
        return response.models;
    }

    async installModel(params: Readonly<{
        packId: string;
        /** Caller lifetime; the daemon cancels the install when it ends. */
        signal?: AbortSignal | null;
    }>, scope?: DaemonVoiceInferenceModelMachineScope): Promise<DaemonVoiceInferenceModelStatus> {
        const machineId = await this.resolveMachineId(scope);
        const response = parseSchema(
            DaemonVoiceInferenceModelsInstallResponseSchema,
            await this.deps.machineRpcWithServerScope({
                machineId,
                method: RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_INSTALL,
                payload: { packId: params.packId },
                // The declared deadline is what the daemon aborts the install on,
                // so the ordinary short RPC default would kill a legitimate
                // multi-minute model download partway through.
                timeoutMs: VOICE_MODEL_INSTALL_RPC_TIMEOUT_MS,
                ...(params.signal ? { signal: params.signal } : {}),
            }),
        );
        throwIfErrorResponse(response);
        return response.model;
    }

    async acceptModelPackLicense(
        input: DaemonVoiceInferenceModelLicenseAcceptRequest,
        scope?: DaemonVoiceInferenceModelMachineScope,
        signal?: AbortSignal,
    ): Promise<DaemonVoiceInferenceModelStatus> {
        const machineId = await this.resolveMachineId(scope);
        const response = parseSchema(
            DaemonVoiceInferenceModelLicenseAcceptResponseSchema,
            await this.deps.machineRpcWithServerScope({
                machineId,
                method: RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_LICENSE_ACCEPT,
                signal,
                payload: input,
            }),
        );
        throwIfErrorResponse(response);
        return response.model;
    }

    async removeModel(packId: string, scope?: DaemonVoiceInferenceModelMachineScope, signal?: AbortSignal): Promise<void> {
        const machineId = await this.resolveMachineId(scope);
        const response = parseSchema(
            DaemonVoiceInferenceModelsRemoveResponseSchema,
            await this.deps.machineRpcWithServerScope({
                machineId,
                method: RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_REMOVE,
                signal,
                payload: { packId },
            }),
        );
        throwIfErrorResponse(response);
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
        const cleanupRpc = this.captureCleanupRpc();
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
                    await cleanupRpc({
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
                        ...(rpcSignal ? { signal: rpcSignal } : {}),
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
        machineTarget?: DaemonVoiceInferenceMachineTarget | null;
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
        const cleanupRpc = this.captureCleanupRpc();
        const machineTarget = await this.resolveMachineTarget(params.machineTarget);
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
                await cleanupRpc({
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
                            ...(params.signal ? { signal: params.signal } : {}),
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
                            ...(params.signal ? { signal: params.signal } : {}),
                            payload: request,
                        }),
                    ),
                finalize: async ({ uploadId }) =>
                    parseSchema(
                        DaemonVoiceInferenceSttUploadFinalizeResponseSchema,
                        await this.deps.machineRpcWithServerScope({
                            machineId: machineTarget.machineId,
                            method: RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_FINALIZE,
                            ...(params.signal ? { signal: params.signal } : {}),
                            payload: { uploadId },
                        }),
                    ),
                abort: async ({ uploadId }) =>
                    parseSchema(
                        DaemonVoiceInferenceSttUploadAbortResponseSchema,
                        await cleanupRpc({
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
        const cleanupRpc = this.captureCleanupRpc();
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
        const callChunk = createOrderedMachineRpcCaller(this.deps.machineRpcWithServerScope);
        const compatibilityTransport: DaemonSpeechStreamTransport = {
            // Reuse packet coalescing under the compatibility consumer's existing
            // Base64 schema bound; capture callbacks need not each occupy a packet.
            maxPcm16ChunkBytes: Math.floor(DAEMON_VOICE_INFERENCE_STT_STREAM_CHUNK_BASE64_MAX_LENGTH / 4) * 3,
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
                this.sendCompatibilityStreamingSttChunk(machineTarget.machineId, payload, rpcSignal, callChunk),
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
            cancel: async (payload) => {
                const response = parseSchema(
                    DaemonVoiceInferenceSttStreamCancelResponseSchema,
                    await cleanupRpc({
                        machineId: machineTarget.machineId,
                        method: RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_CANCEL,
                        payload,
                    }),
                );
                // Capture retirement can close the media tunnel first. The
                // daemon then removes this admitted stream through transport-loss
                // cleanup, so an absent stream already satisfies cancellation.
                return !response.ok && response.errorCode === 'stream_not_found'
                    ? { ok: true, streamId: payload.streamId, generation: payload.generation }
                    : response;
            },
        };
        const selectedTransport = await this.deps.createStreamingSttTransport({
            sessionId: params.sessionId ?? null,
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
        call: typeof machineRpcWithServerScope,
    ): Promise<DaemonVoiceInferenceSttStreamChunkResponse> {
        if (payload.carrierFrame.kind !== 'machine_rpc_json_base64') {
            throw createDaemonVoiceInferenceClientError(
                'internal_error',
                'daemon_voice_inference_binary_stream_consumer_unavailable',
            );
        }
        return parseSchema(
            DaemonVoiceInferenceSttStreamChunkResponseSchema,
            await call({
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
