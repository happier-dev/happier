import { describe, expect, it } from 'vitest';

import {
    DaemonVoiceInferenceErrorSchema,
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
    DaemonVoiceInferenceSttTranscribeRequestSchema,
    DaemonVoiceInferenceSttTranscribeResponseSchema,
} from './daemonVoiceInference.js';

describe('daemonVoiceInference schemas', () => {
    it('parses and preserves daemon TTS synthesize request and response payloads', () => {
        const request = DaemonVoiceInferenceTtsSynthesizeRequestSchema.parse({
            requestId: 'tts-1',
            text: 'hello daemon',
            packId: 'kokoro-tts-en-v1',
            voiceId: 'af_heart',
            speed: 1,
            output: { codec: 'mp3', mimeType: 'audio/mpeg' },
        });
        const response = DaemonVoiceInferenceTtsSynthesizeResponseSchema.parse({
            ok: true,
            requestId: 'tts-1',
            output: { codec: 'mp3', mimeType: 'audio/mpeg' },
            downloadId: 'download-1',
            chunkSizeBytes: 1024,
            sizeBytes: 2048,
            name: 'tts.mp3',
        });

        expect(request).toEqual({
            requestId: 'tts-1',
            text: 'hello daemon',
            packId: 'kokoro-tts-en-v1',
            voiceId: 'af_heart',
            speed: 1,
            output: { codec: 'mp3', mimeType: 'audio/mpeg' },
        });
        expect(response).toEqual({
            ok: true,
            requestId: 'tts-1',
            output: { codec: 'mp3', mimeType: 'audio/mpeg' },
            downloadId: 'download-1',
            chunkSizeBytes: 1024,
            sizeBytes: 2048,
            name: 'tts.mp3',
        });
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
