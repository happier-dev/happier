import { describe, expect, it } from 'vitest';

import {
    DaemonVoiceInferenceErrorSchema,
    DaemonVoiceInferenceModelRuntimeStateSchema,
    DaemonVoiceInferenceModelStatusSchema,
    DaemonVoiceInferenceModelsInstallRequestSchema,
    DaemonVoiceInferenceModelsInstallResponseSchema,
    DaemonVoiceInferenceModelsRemoveRequestSchema,
    DaemonVoiceInferenceModelsRemoveResponseSchema,
    DaemonVoiceInferenceModelsStatusRequestSchema,
    DaemonVoiceInferenceModelsWarmRequestSchema,
    DaemonVoiceInferenceSttUploadAbortResponseSchema,
    DaemonVoiceInferenceSttUploadChunkRequestSchema,
    DaemonVoiceInferenceSttUploadFinalizeResponseSchema,
    DaemonVoiceInferenceSttUploadInitRequestSchema,
    DaemonVoiceInferenceSttUploadInitResponseSchema,
    DaemonVoiceInferenceStatusResponseSchema,
    DaemonVoiceInferenceTtsAbortResponseSchema,
    DaemonVoiceInferenceTtsChunkResponseSchema,
    DaemonVoiceInferenceTtsFinalizeResponseSchema,
    DaemonVoiceInferenceTtsSynthesizeRequestSchema,
    DaemonVoiceInferenceTtsSynthesizeResponseSchema,
    DaemonVoiceInferenceTtsStreamAckRequestSchema,
    DaemonVoiceInferenceTtsStreamAckResponseSchema,
    DaemonVoiceInferenceTtsStreamCancelRequestSchema,
    DaemonVoiceInferenceTtsStreamEventSchema,
    DaemonVoiceInferenceTtsStreamNextRequestSchema,
    DaemonVoiceInferenceTtsStreamNextResponseSchema,
    DaemonVoiceInferenceTtsStreamStartRequestSchema,
    DaemonVoiceInferenceTtsStreamStartResponseSchema,
    DaemonVoiceInferenceTtsStreamStatusResponseSchema,
    DaemonVoiceInferenceSttTranscribeRequestSchema,
    DaemonVoiceInferenceSttTranscribeResponseSchema,
    DaemonVoiceInferenceSttStreamCancelRequestSchema,
    DaemonVoiceInferenceSttStreamChunkRequestSchema,
    DaemonVoiceInferenceSttStreamChunkResponseSchema,
    DaemonVoiceInferenceSttStreamFinishRequestSchema,
    DaemonVoiceInferenceSttStreamFinishResponseSchema,
    DaemonVoiceInferenceSttStreamPcmFormatSchema,
    DaemonVoiceInferenceSttStreamStartRequestSchema,
    DaemonVoiceInferenceSttStreamStartResponseSchema,
    DaemonVoiceInferenceSttStreamStatusResponseSchema,
} from './voiceInference.js';

describe('daemonVoiceInference schemas', () => {
    it('parses and preserves the daemon WAV TTS synthesize contract', () => {
        const request = DaemonVoiceInferenceTtsSynthesizeRequestSchema.parse({
            requestId: 'tts-1',
            text: 'hello daemon',
            packId: 'kokoro-tts-en-v1',
            voiceId: 'af_heart',
            speed: 1,
            output: { codec: 'wav', mimeType: 'audio/wav' },
        });
        const response = DaemonVoiceInferenceTtsSynthesizeResponseSchema.parse({
            ok: true,
            requestId: 'tts-1',
            output: { codec: 'wav', mimeType: 'audio/wav' },
            downloadId: 'download-1',
            chunkSizeBytes: 1024,
            sizeBytes: 2048,
            name: 'tts.wav',
        });

        expect(request).toEqual({
            requestId: 'tts-1',
            text: 'hello daemon',
            packId: 'kokoro-tts-en-v1',
            voiceId: 'af_heart',
            speed: 1,
            output: { codec: 'wav', mimeType: 'audio/wav' },
        });
        expect(response).toEqual({
            ok: true,
            requestId: 'tts-1',
            output: { codec: 'wav', mimeType: 'audio/wav' },
            downloadId: 'download-1',
            chunkSizeBytes: 1024,
            sizeBytes: 2048,
            name: 'tts.wav',
        });
    });

    it('threads diagnostics capture context only when a caller explicitly opts in', () => {
        const request = DaemonVoiceInferenceTtsSynthesizeRequestSchema.parse({
            requestId: 'tts-diag-1',
            text: 'diagnose this',
            diagnostics: {
                sessionId: 'session-private',
                captureAllowed: true,
                durationMs: null,
                authorizationId: '6a42516d-20ea-4c70-91d5-b0dbaf693637',
            },
        });
        const transcribe = DaemonVoiceInferenceSttTranscribeRequestSchema.parse({
            requestId: 'stt-diag-1',
            uploadId: 'upload-diag-1',
            normalization: {
                inputTransport: 'upload_transfer',
                strategy: 'daemon_decode',
                systemFfmpegAllowed: false,
            },
            diagnostics: {
                sessionId: 'session-private',
                captureAllowed: false,
                durationMs: 1_250,
                authorizationId: '6a42516d-20ea-4c70-91d5-b0dbaf693637',
            },
        });
        const streaming = DaemonVoiceInferenceSttStreamStartRequestSchema.parse({
            requestId: 'stt-stream-diag-1',
            streamingMode: 'runtime',
            diagnostics: {
                sessionId: 'session-private',
                captureAllowed: true,
                durationMs: null,
                authorizationId: '6a42516d-20ea-4c70-91d5-b0dbaf693637',
            },
        });

        expect(request.diagnostics).toMatchObject({ captureAllowed: true });
        expect(transcribe.diagnostics).toMatchObject({ captureAllowed: false, durationMs: 1_250 });
        expect(streaming.diagnostics).toMatchObject({ sessionId: 'session-private', captureAllowed: true });
        expect(DaemonVoiceInferenceTtsSynthesizeRequestSchema.parse({ requestId: 'tts-no-diag', text: 'hello' })).not.toHaveProperty('diagnostics');
        expect(DaemonVoiceInferenceSttStreamStartRequestSchema.parse({
            requestId: 'stt-stream-no-diag',
            streamingMode: 'runtime',
        })).not.toHaveProperty('diagnostics');
    });

    it('rejects daemon TTS codecs that no packaged runtime can produce', () => {
        for (const output of [
            { codec: 'mp3', mimeType: 'audio/mpeg' },
            { codec: 'opus', mimeType: 'audio/opus' },
        ]) {
            expect(DaemonVoiceInferenceTtsSynthesizeRequestSchema.safeParse({
                requestId: 'tts-unsupported',
                text: 'hello daemon',
                output,
            }).success).toBe(false);
            expect(DaemonVoiceInferenceTtsStreamStartRequestSchema.safeParse({
                requestId: 'tts-stream-unsupported',
                text: 'hello daemon',
                output,
            }).success).toBe(false);
        }
    });

    it('parses segmented daemon TTS control payloads with stable segment metadata and playback ack', () => {
        const start = DaemonVoiceInferenceTtsStreamStartRequestSchema.parse({
            requestId: 'tts-stream-1',
            text: 'First sentence. Second sentence.',
            packId: 'kokoro-tts-en-v1',
            voiceId: 'af_heart',
            speed: 1,
            output: { codec: 'wav', mimeType: 'audio/wav' },
            prefetchDepth: 2,
            diagnostics: { sessionId: 'session-1', captureAllowed: true, durationMs: null, authorizationId: '6a42516d-20ea-4c70-91d5-b0dbaf693637' },
        });
        const started = DaemonVoiceInferenceTtsStreamStartResponseSchema.parse({
            ok: true,
            requestId: 'tts-stream-1',
            streamId: 'tts-stream-id-1',
            generation: 0,
            segmentCount: 2,
            output: { codec: 'wav', mimeType: 'audio/wav' },
        });
        const segmentEvent = DaemonVoiceInferenceTtsStreamEventSchema.parse({
            type: 'segment',
            streamId: 'tts-stream-id-1',
            generation: 0,
            segmentId: 'seg-0',
            segmentIndex: 0,
            segmentCount: 2,
            text: 'First sentence.',
            textRange: { start: 0, end: 15 },
            textHash: 'abc123',
            output: { codec: 'wav', mimeType: 'audio/wav' },
            audio: {
                contentBase64: Buffer.from('audio-0').toString('base64'),
                sizeBytes: 7,
            },
            isLastSegment: false,
        });
        const next = DaemonVoiceInferenceTtsStreamNextResponseSchema.parse({
            ok: true,
            streamId: 'tts-stream-id-1',
            generation: 0,
            event: segmentEvent,
        });
        const ack = DaemonVoiceInferenceTtsStreamAckResponseSchema.parse({
            ok: true,
            streamId: 'tts-stream-id-1',
            generation: 0,
            ackedSegmentIndex: 0,
            complete: false,
        });
        const status = DaemonVoiceInferenceTtsStreamStatusResponseSchema.parse({
            ok: true,
            streamId: 'tts-stream-id-1',
            generation: 0,
            state: 'open',
            segmentCount: 2,
            deliveredSegmentCount: 1,
            ackedSegmentCount: 1,
            outstandingSegmentCount: 1,
        });

        expect(start.prefetchDepth).toBe(2);
        expect(started.segmentCount).toBe(2);
        expect(next.event).toEqual(segmentEvent);
        expect(DaemonVoiceInferenceTtsStreamNextRequestSchema.parse({
            streamId: 'tts-stream-id-1',
            generation: 0,
        })).toEqual({ streamId: 'tts-stream-id-1', generation: 0 });
        expect(DaemonVoiceInferenceTtsStreamAckRequestSchema.parse({
            streamId: 'tts-stream-id-1',
            generation: 0,
            segmentId: 'seg-0',
            segmentIndex: 0,
        })).toEqual({
            streamId: 'tts-stream-id-1',
            generation: 0,
            segmentId: 'seg-0',
            segmentIndex: 0,
        });
        expect(DaemonVoiceInferenceTtsStreamCancelRequestSchema.parse({
            streamId: 'tts-stream-id-1',
            generation: 0,
            reason: 'barge_in',
        })).toEqual({
            streamId: 'tts-stream-id-1',
            generation: 0,
            reason: 'barge_in',
        });
        expect(ack.complete).toBe(false);
        expect(status.outstandingSegmentCount).toBe(1);
    });

    it('additively carries the readiness runtimeState and resident memory snapshot when present', () => {
        const parsed = DaemonVoiceInferenceModelStatusSchema.parse({
            packId: 'kokoro-tts-en-v1',
            kind: 'tts_sherpa',
            model: 'kokoro',
            version: '2026-02-15',
            executionSupport: ['daemon'],
            installState: 'installed',
            progress: null,
            lastError: null,
            updatedAtMs: 1,
            runtimeState: 'ready',
            residentMemoryBytes: 64 * 1024 * 1024,
        });

        expect(parsed.runtimeState).toBe('ready');
        expect(parsed.residentMemoryBytes).toBe(64 * 1024 * 1024);
    });

    it('omits the additive readiness fields entirely when not provided so existing callers stay unaffected', () => {
        const parsed = DaemonVoiceInferenceModelStatusSchema.parse({
            packId: 'kokoro-tts-en-v1',
            kind: 'tts_sherpa',
            model: 'kokoro',
            version: '2026-02-15',
            executionSupport: ['daemon'],
            installState: 'installed',
            progress: null,
            lastError: null,
            updatedAtMs: 1,
        });

        expect('runtimeState' in parsed).toBe(false);
        expect('residentMemoryBytes' in parsed).toBe(false);
    });

    it('exposes the canonical model runtime-state enum', () => {
        expect(DaemonVoiceInferenceModelRuntimeStateSchema.options).toEqual([
            'cold',
            'warming',
            'ready',
            'evicted',
        ]);
    });

    it('rejects daemon TTS output payloads with mismatched codec/mime pairs', () => {
        const parsed = DaemonVoiceInferenceTtsSynthesizeRequestSchema.safeParse({
            requestId: 'tts-1',
            text: 'hello daemon',
            packId: 'kokoro-tts-en-v1',
            voiceId: 'af_heart',
            speed: 1,
            output: { codec: 'mp3', mimeType: 'audio/wav' },
        });

        expect(parsed.success).toBe(false);
    });

    it('rejects undeclared daemon TTS synthesize request fields once the contract is finalized', () => {
        const parsed = DaemonVoiceInferenceTtsSynthesizeRequestSchema.safeParse({
            requestId: 'tts-1',
            text: 'hello daemon',
            packId: 'kokoro-tts-en-v1',
            voiceId: 'af_heart',
            speed: 1,
            output: { codec: 'wav', mimeType: 'audio/wav' },
            requestedExecution: 'daemon',
        });

        expect(parsed.success).toBe(false);
    });

    it('rejects undeclared daemon model-management request fields so stale callers cannot drift the contract', () => {
        const install = DaemonVoiceInferenceModelsInstallRequestSchema.safeParse({
            packId: 'kokoro-tts-en-v1',
            requestedExecution: 'daemon',
        });
        const remove = DaemonVoiceInferenceModelsRemoveRequestSchema.safeParse({
            packId: 'kokoro-tts-en-v1',
            requestedExecution: 'daemon',
        });
        const status = DaemonVoiceInferenceModelsStatusRequestSchema.safeParse({
            packIds: ['kokoro-tts-en-v1'],
            requestedExecution: 'daemon',
        });
        const warm = DaemonVoiceInferenceModelsWarmRequestSchema.safeParse({
            packIds: ['kokoro-tts-en-v1'],
            requestedExecution: 'daemon',
        });

        expect(install.success).toBe(false);
        expect(remove.success).toBe(false);
        expect(status.success).toBe(false);
        expect(warm.success).toBe(false);
    });

    it('carries structured plugin identity in model status while legacy built-in status defaults to null', () => {
        const legacy = DaemonVoiceInferenceModelStatusSchema.parse({
            packId: 'kokoro-tts-en-v1',
            kind: 'tts_sherpa',
            model: 'kokoro',
            executionSupport: ['daemon'],
            installState: 'installed',
            progress: null,
            lastError: null,
            updatedAtMs: 1,
        });
        expect(legacy.pluginIdentity).toBeNull();

        const plugin = DaemonVoiceInferenceModelStatusSchema.parse({
            ...legacy,
            packId: 'acme.speech/english-small',
            pluginIdentity: { pluginId: 'acme.speech', packId: 'english-small' },
        });
        expect(plugin.pluginIdentity).toEqual({ pluginId: 'acme.speech', packId: 'english-small' });

        expect(DaemonVoiceInferenceModelStatusSchema.safeParse({
            ...legacy,
            packId: 'acme.speech/english-small',
            pluginIdentity: { pluginId: 'acme.speech', packId: 'another-pack' },
        }).success).toBe(false);

        expect(DaemonVoiceInferenceModelsInstallRequestSchema.safeParse({
            pluginIdentity: { pluginId: 'acme.speech', packId: 'english-small' },
        }).success).toBe(false);
    });

    it('rejects overlong daemon voice inference request ids across request-bearing contracts', () => {
        const overlongRequestId = 'r'.repeat(257);

        expect(DaemonVoiceInferenceTtsSynthesizeRequestSchema.safeParse({
            requestId: overlongRequestId,
            text: 'hello daemon',
            packId: 'kokoro-tts-en-v1',
            voiceId: 'af_heart',
            speed: 1,
            output: { codec: 'wav', mimeType: 'audio/wav' },
        }).success).toBe(false);

        expect(DaemonVoiceInferenceSttUploadInitRequestSchema.safeParse({
            requestId: overlongRequestId,
            sizeBytes: 12,
            inputMimeType: 'audio/webm',
        }).success).toBe(false);

        expect(DaemonVoiceInferenceSttTranscribeRequestSchema.safeParse({
            requestId: overlongRequestId,
            uploadId: 'upload-1',
            packId: 'sherpa-stt-en-v1',
            language: 'en',
            normalization: {
                inputTransport: 'upload_transfer',
                strategy: 'daemon_decode',
                systemFfmpegAllowed: false,
            },
        }).success).toBe(false);
    });

    it('parses and preserves daemon STT transcribe request, response, and service status payloads', () => {
        const request = DaemonVoiceInferenceSttTranscribeRequestSchema.parse({
            requestId: 'stt-1',
            uploadId: 'upload-1',
            packId: 'sherpa-stt-en-v1',
            language: 'en',
            normalization: {
                inputTransport: 'upload_transfer',
                strategy: 'daemon_decode',
                systemFfmpegAllowed: false,
            },
        });
        const response = DaemonVoiceInferenceSttTranscribeResponseSchema.parse({
            ok: true,
            requestId: 'stt-1',
            text: 'hello daemon',
            language: 'en',
            modelPackId: 'sherpa-stt-en-v1',
        });
        const status = DaemonVoiceInferenceStatusResponseSchema.parse({
            ok: true,
            serviceState: 'ready',
            normalization: {
                inputTransport: 'upload_transfer',
                strategy: 'daemon_decode',
                systemFfmpegAllowed: false,
            },
            models: [{
                packId: 'kokoro-tts-en-v1',
                pluginIdentity: null,
                kind: 'tts_sherpa',
                model: 'kokoro',
                version: '2026-02-15',
                executionSupport: ['daemon'],
                installState: 'installed',
                progress: null,
                lastError: null,
                updatedAtMs: 1,
            }],
        });

        expect(request).toEqual({
            requestId: 'stt-1',
            uploadId: 'upload-1',
            packId: 'sherpa-stt-en-v1',
            language: 'en',
            normalization: {
                inputTransport: 'upload_transfer',
                strategy: 'daemon_decode',
                systemFfmpegAllowed: false,
            },
        });
        expect(response).toEqual({
            ok: true,
            requestId: 'stt-1',
            text: 'hello daemon',
            language: 'en',
            modelPackId: 'sherpa-stt-en-v1',
        });
        expect(status).toEqual({
            ok: true,
            serviceState: 'ready',
            normalization: {
                inputTransport: 'upload_transfer',
                strategy: 'daemon_decode',
                systemFfmpegAllowed: false,
            },
            models: [{
                packId: 'kokoro-tts-en-v1',
                pluginIdentity: null,
                kind: 'tts_sherpa',
                model: 'kokoro',
                version: '2026-02-15',
                executionSupport: ['daemon'],
                installState: 'installed',
                progress: null,
                lastError: null,
                updatedAtMs: 1,
            }],
        });
    });

    it('defines a strict daemon streaming STT contract around the canonical mono PCM format', () => {
        const start = DaemonVoiceInferenceSttStreamStartRequestSchema.parse({
            requestId: 'stt-stream-start-1',
            packId: 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17',
            language: 'en',
            streamingMode: 'runtime',
        });
        const startResponse = DaemonVoiceInferenceSttStreamStartResponseSchema.parse({
            ok: true,
            requestId: 'stt-stream-start-1',
            streamId: 'stream-1',
            generation: 0,
            ackSeq: -1,
            format: {
                sampleRateHz: 16_000,
                channelCount: 1,
                bitsPerSample: 16,
                ffmpegCodec: 'pcm_s16le',
            },
        });
        const chunk = DaemonVoiceInferenceSttStreamChunkRequestSchema.parse({
            streamId: 'stream-1',
            generation: 0,
            seq: 0,
            pcm16Base64: 'AAAA',
        });
        const chunkResponse = DaemonVoiceInferenceSttStreamChunkResponseSchema.parse({
            ok: true,
            streamId: 'stream-1',
            generation: 0,
            ackSeq: 0,
            events: [
                { type: 'partial', seq: 0, text: 'hel', isEndpoint: false },
                { type: 'endpoint', seq: 0, transcript: 'hello', reason: 'vad' },
            ],
        });
        const finish = DaemonVoiceInferenceSttStreamFinishRequestSchema.parse({
            streamId: 'stream-1',
            generation: 0,
            finalSeq: 0,
        });
        const finishResponse = DaemonVoiceInferenceSttStreamFinishResponseSchema.parse({
            ok: true,
            streamId: 'stream-1',
            generation: 0,
            ackSeq: 0,
            finalText: 'hello',
            language: 'en',
            modelPackId: 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17',
            events: [{ type: 'final', seq: 0, text: 'hello', language: 'en', modelPackId: 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17' }],
        });
        const cancel = DaemonVoiceInferenceSttStreamCancelRequestSchema.parse({
            streamId: 'stream-1',
            generation: 0,
        });
        const status = DaemonVoiceInferenceSttStreamStatusResponseSchema.parse({
            ok: true,
            streamId: 'stream-1',
            generation: 0,
            ackSeq: 0,
            state: 'open',
        });

        expect(start).toEqual({
            requestId: 'stt-stream-start-1',
            packId: 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17',
            language: 'en',
            streamingMode: 'runtime',
            format: {
                sampleRateHz: 16_000,
                channelCount: 1,
                bitsPerSample: 16,
                ffmpegCodec: 'pcm_s16le',
            },
        });
        expect(startResponse).toEqual({
            ok: true,
            requestId: 'stt-stream-start-1',
            streamId: 'stream-1',
            generation: 0,
            ackSeq: -1,
            format: {
                sampleRateHz: 16_000,
                channelCount: 1,
                bitsPerSample: 16,
                ffmpegCodec: 'pcm_s16le',
            },
        });
        expect(chunk).toEqual({
            streamId: 'stream-1',
            generation: 0,
            seq: 0,
            pcm16Base64: 'AAAA',
        });
        expect(chunkResponse).toEqual({
            ok: true,
            streamId: 'stream-1',
            generation: 0,
            ackSeq: 0,
            events: [
                { type: 'partial', seq: 0, text: 'hel', isEndpoint: false, confidence: null },
                { type: 'endpoint', seq: 0, transcript: 'hello', reason: 'vad' },
            ],
        });
        expect(finish).toEqual({
            streamId: 'stream-1',
            generation: 0,
            finalSeq: 0,
        });
        expect(finishResponse).toEqual({
            ok: true,
            streamId: 'stream-1',
            generation: 0,
            ackSeq: 0,
            finalText: 'hello',
            language: 'en',
            modelPackId: 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17',
            events: [{ type: 'final', seq: 0, text: 'hello', language: 'en', modelPackId: 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17' }],
        });
        expect(cancel).toEqual({
            streamId: 'stream-1',
            generation: 0,
        });
        expect(status).toEqual({
            ok: true,
            streamId: 'stream-1',
            generation: 0,
            ackSeq: 0,
            state: 'open',
        });
    });

    it('rejects invalid daemon streaming STT format, ids, and sequence numbers', () => {
        expect(DaemonVoiceInferenceSttStreamPcmFormatSchema.safeParse({
            sampleRateHz: 48_000,
            channelCount: 1,
            bitsPerSample: 16,
            ffmpegCodec: 'pcm_s16le',
        }).success).toBe(false);
        expect(DaemonVoiceInferenceSttStreamStartRequestSchema.safeParse({
            requestId: 'r'.repeat(257),
        }).success).toBe(false);
        expect(DaemonVoiceInferenceSttStreamStartRequestSchema.safeParse({
            requestId: 'stt-stream-start-1',
            streamingMode: 'fake_streaming',
        }).success).toBe(false);
        expect(DaemonVoiceInferenceSttStreamStartRequestSchema.safeParse({
            requestId: 'stt-stream-start-1',
            format: {
                sampleRateHz: 16_000,
                channelCount: 2,
                bitsPerSample: 16,
                ffmpegCodec: 'pcm_s16le',
            },
        }).success).toBe(false);
        expect(DaemonVoiceInferenceSttStreamChunkRequestSchema.safeParse({
            streamId: 'stream-1',
            generation: 0,
            seq: -1,
            pcm16Base64: 'AAAA',
        }).success).toBe(false);
        expect(DaemonVoiceInferenceSttStreamFinishRequestSchema.safeParse({
            streamId: 'stream-1',
            generation: 0,
            finalSeq: -1,
        }).success).toBe(false);
        expect(DaemonVoiceInferenceSttStreamChunkRequestSchema.safeParse({
            streamId: 'stream-1',
            generation: 0,
            seq: 0,
            pcm16Base64: '',
        }).success).toBe(false);
    });

    it('binds relay-required peer application encryption into the strict START contract', () => {
        const binding = {
            v: 1 as const,
            suite: 'aes-256-gcm' as const,
            flowKind: 'voice_media' as const,
            routeKind: 'server_relay' as const,
            authorityDigest: 'sha256:acdb52b3d7de70428b1c54fbb340ab675b98d6900d2b86ababad20baa7aed6ca',
            accountId: 'account-1',
            machineId: 'machine-1',
            tunnelId: 'tunnel-1',
            applicationKind: 'speech_transcription' as const,
            applicationAttemptId: 'stt-stream-encrypted-1',
            applicationAuthorityDigest: `sha256:${'ab'.repeat(32)}`,
        };
        expect(DaemonVoiceInferenceSttStreamStartRequestSchema.parse({
            requestId: 'stt-stream-encrypted-1',
            peerApplicationEncryption: binding,
        }).peerApplicationEncryption).toEqual(binding);
        expect(DaemonVoiceInferenceSttStreamStartResponseSchema.parse({
            ok: true,
            requestId: 'stt-stream-encrypted-1',
            streamId: 'stream-1',
            generation: 0,
            ackSeq: -1,
            format: { sampleRateHz: 16_000, channelCount: 1, bitsPerSample: 16, ffmpegCodec: 'pcm_s16le' },
            peerApplicationEncryption: {
                v: 1,
                suite: 'aes-256-gcm',
                recipientPublicKeyBase64Url: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            },
        }).peerApplicationEncryption?.suite).toBe('aes-256-gcm');
    });

    it('keeps daemon streaming STT errors retryable when callers need reconnect decisions', () => {
        const parsed = DaemonVoiceInferenceSttStreamChunkResponseSchema.parse({
            ok: false,
            errorCode: 'stream_not_found',
            error: 'daemon_voice_inference_stt_stream_not_found',
            retryable: true,
        });

        expect(parsed).toEqual({
            ok: false,
            errorCode: 'stream_not_found',
            error: 'daemon_voice_inference_stt_stream_not_found',
            retryable: true,
        });
    });

    it('rejects undeclared daemon STT transcribe request fields so stale callers cannot drift the contract', () => {
        const parsed = DaemonVoiceInferenceSttTranscribeRequestSchema.safeParse({
            requestId: 'stt-1',
            uploadId: 'upload-1',
            packId: 'sherpa-stt-en-v1',
            language: 'en',
            normalization: {
                inputTransport: 'upload_transfer',
                strategy: 'daemon_decode',
                systemFfmpegAllowed: false,
            },
            inputMimeType: 'audio/wav',
        });

        expect(parsed.success).toBe(false);
    });

    it('rejects undeclared daemon STT upload init request fields so stale callers cannot drift the contract', () => {
        const parsed = DaemonVoiceInferenceSttUploadInitRequestSchema.safeParse({
            requestId: 'stt-upload-1',
            sizeBytes: 12,
            inputMimeType: 'audio/webm',
            requestedExecution: 'daemon',
        });

        expect(parsed.success).toBe(false);
    });

    it('roundtrips model-management, transfer-lifecycle, and error payloads with defaults intact', () => {
        const installRequest = DaemonVoiceInferenceModelsInstallRequestSchema.parse({
            packId: 'kokoro-tts-en-v1',
        });
        const installResponse = DaemonVoiceInferenceModelsInstallResponseSchema.parse({
            ok: true,
            model: {
                packId: 'kokoro-tts-en-v1',
                pluginIdentity: null,
                kind: 'tts_sherpa',
                model: 'kokoro',
                executionSupport: ['daemon'],
                installState: 'installing',
                updatedAtMs: 42,
            },
        });
        const statusRequest = DaemonVoiceInferenceModelsStatusRequestSchema.parse({});
        const ttsChunkError = DaemonVoiceInferenceTtsChunkResponseSchema.parse({
            success: false,
            error: 'chunk_failed',
            errorCode: 'download_failed',
        });
        const ttsFinalize = DaemonVoiceInferenceTtsFinalizeResponseSchema.parse({
            success: true,
        });
        const ttsAbort = DaemonVoiceInferenceTtsAbortResponseSchema.parse({
            success: true,
        });
        const sttUploadInit = DaemonVoiceInferenceSttUploadInitRequestSchema.parse({
            requestId: 'stt-upload-1',
            sizeBytes: 12,
            inputMimeType: 'audio/webm',
        });
        const sttUploadInitResponse = DaemonVoiceInferenceSttUploadInitResponseSchema.parse({
            success: true,
            uploadId: 'upload-1',
            chunkSizeBytes: 1024,
            recipientPublicKeyBase64: 'abc123',
        });
        const sttUploadChunk = DaemonVoiceInferenceSttUploadChunkRequestSchema.parse({
            uploadId: 'upload-1',
            index: 0,
            payloadBase64: 'Zm9v',
            encryptedDataKeyEnvelopeBase64: 'YmFy',
        });
        const sttUploadFinalize = DaemonVoiceInferenceSttUploadFinalizeResponseSchema.parse({
            success: true,
            uploadId: 'upload-1',
            path: '/tmp/upload-1.webm',
            sizeBytes: 12,
            sha256: 'abc123',
        });
        const sttUploadAbort = DaemonVoiceInferenceSttUploadAbortResponseSchema.parse({
            success: true,
        });
        const removeResponse = DaemonVoiceInferenceModelsRemoveResponseSchema.parse({
            ok: true,
        });
        const errorResponse = DaemonVoiceInferenceErrorSchema.parse({
            ok: false,
            errorCode: 'machine_unreachable',
            error: 'daemon_voice_inference_machine_unreachable',
        });

        expect(installRequest).toEqual({
            packId: 'kokoro-tts-en-v1',
        });
        expect(installResponse).toEqual({
            ok: true,
            model: {
                packId: 'kokoro-tts-en-v1',
                pluginIdentity: null,
                kind: 'tts_sherpa',
                model: 'kokoro',
                version: null,
                executionSupport: ['daemon'],
                installState: 'installing',
                progress: null,
                lastError: null,
                updatedAtMs: 42,
            },
        });
        expect(statusRequest).toEqual({});
        expect(ttsChunkError).toEqual({
            success: false,
            error: 'chunk_failed',
            errorCode: 'download_failed',
        });
        expect(ttsFinalize).toEqual({ success: true });
        expect(ttsAbort).toEqual({ success: true });
        expect(sttUploadInit).toEqual({
            requestId: 'stt-upload-1',
            sizeBytes: 12,
            inputMimeType: 'audio/webm',
        });
        expect(sttUploadInitResponse).toEqual({
            success: true,
            uploadId: 'upload-1',
            chunkSizeBytes: 1024,
            recipientPublicKeyBase64: 'abc123',
        });
        expect(sttUploadChunk).toEqual({
            uploadId: 'upload-1',
            index: 0,
            payloadBase64: 'Zm9v',
            encryptedDataKeyEnvelopeBase64: 'YmFy',
        });
        expect(sttUploadFinalize).toEqual({
            success: true,
            uploadId: 'upload-1',
            path: '/tmp/upload-1.webm',
            sizeBytes: 12,
            sha256: 'abc123',
        });
        expect(sttUploadAbort).toEqual({ success: true });
        expect(removeResponse).toEqual({ ok: true });
        expect(errorResponse).toEqual({
            ok: false,
            errorCode: 'machine_unreachable',
            error: 'daemon_voice_inference_machine_unreachable',
        });
    });
});
