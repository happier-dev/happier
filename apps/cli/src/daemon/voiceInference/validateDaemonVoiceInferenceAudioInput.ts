import { open, stat } from 'node:fs/promises';

import type { DaemonVoiceInferenceNormalizationDecision } from '@happier-dev/protocol';

import {
    createVoiceInferenceError,
    isVoiceInferenceWavMimeType,
    normalizeVoiceInferenceInputMimeType,
} from './voiceInferenceWorker.shared';
import {
    resolveVoiceInferenceAcceptedInputMimeTypes,
    resolveVoiceInferenceSttMaxUploadBytes,
} from './voiceInferenceWorkerConfig';

type DaemonVoiceInferenceAudioValidationResult = Readonly<{
    filePath: string;
    inputMimeType: string;
    normalization: DaemonVoiceInferenceNormalizationDecision;
}>;

function isDaemonDecodableMimeType(inputMimeType: string): boolean {
    const normalized = normalizeVoiceInferenceInputMimeType(inputMimeType);
    return resolveVoiceInferenceAcceptedInputMimeTypes().includes(normalized) || isVoiceInferenceWavMimeType(normalized);
}

async function assertWavHeader(filePath: string): Promise<void> {
    const fileHandle = await open(filePath, 'r');
    try {
        const header = Buffer.alloc(12);
        const { bytesRead } = await fileHandle.read(header, 0, header.byteLength, 0);
        if (bytesRead < header.byteLength) {
            throw createVoiceInferenceError('invalid_audio_input', 'voice_inference_invalid_wav_header');
        }
        if (header.subarray(0, 4).toString('ascii') !== 'RIFF' || header.subarray(8, 12).toString('ascii') !== 'WAVE') {
            throw createVoiceInferenceError('invalid_audio_input', 'voice_inference_invalid_wav_header');
        }
    } finally {
        await fileHandle.close();
    }
}

async function assertVoiceInferenceInputWithinUploadLimit(filePath: string): Promise<void> {
    const fileStat = await stat(filePath).catch(() => {
        throw createVoiceInferenceError('invalid_audio_input', 'voice_inference_invalid_upload_path');
    });

    if (!fileStat.isFile()) {
        throw createVoiceInferenceError('invalid_audio_input', 'voice_inference_invalid_upload_path');
    }
    if (fileStat.size <= 0) {
        throw createVoiceInferenceError('invalid_audio_input', 'voice_inference_empty_daemon_audio_input');
    }
    if (fileStat.size > resolveVoiceInferenceSttMaxUploadBytes()) {
        throw createVoiceInferenceError('invalid_audio_input', 'voice_inference_audio_input_too_large');
    }
}

export async function validateDaemonVoiceInferenceAudioInput(params: Readonly<{
    filePath: string;
    inputMimeType: string;
    normalization: DaemonVoiceInferenceNormalizationDecision;
}>): Promise<DaemonVoiceInferenceAudioValidationResult> {
    const inputMimeType = normalizeVoiceInferenceInputMimeType(params.inputMimeType);

    if (params.normalization.strategy === 'ui_pretranscoded_pcm16_fallback') {
        if (!isVoiceInferenceWavMimeType(inputMimeType)) {
            throw createVoiceInferenceError(
                'invalid_audio_input',
                'voice_inference_expected_pretranscoded_wav_input',
            );
        }
        await assertWavHeader(params.filePath);
        await assertVoiceInferenceInputWithinUploadLimit(params.filePath);
        return {
            ...params,
            inputMimeType,
        };
    }

    if (!isDaemonDecodableMimeType(inputMimeType)) {
        throw createVoiceInferenceError(
            'invalid_audio_input',
            'voice_inference_unsupported_daemon_audio_input',
        );
    }

    await assertVoiceInferenceInputWithinUploadLimit(params.filePath);

    if (isVoiceInferenceWavMimeType(inputMimeType)) {
        await assertWavHeader(params.filePath);
    }

    return {
        ...params,
        inputMimeType,
    };
}
