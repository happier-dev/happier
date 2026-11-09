import { Platform } from 'react-native';
import { getSharedVoiceAudioSessionCoordinator } from '@happier-dev/audio-stream-native';

import { storage } from '@/sync/domains/state/storage';
import { resolveLocalUploadSourceSizeBytes } from '@/sync/runtime/files/localUploadSourceReader';
import { runtimeFetch } from '@/utils/system/runtimeFetch';
import { createLocalVoiceCaptureOwner } from '@/voice/runtime/input/LocalVoiceCaptureOwner';
import { createVoiceCaptureAdmissionBinding } from '@/voice/runtime/input/VoiceCaptureAdmissionBinding';
import { voiceCaptureAdmissionController } from '@/voice/runtime/input/VoiceCaptureAdmissionController';
import { resolveVoiceExecutionMachineId } from '@/voice/settings/executionMachine';
import { recordedAudioTranscriptionController } from '@/voice/runtime/input/recordedAudioTranscriptionController';
import { deleteRecordedAudioArtifact } from '@/voice/runtime/input/recordedAudioArtifactCleanup';

import { createVoiceDictationController } from './VoiceDictationController';

const rawDictationCaptureOwner = createLocalVoiceCaptureOwner({
    getSettings: () => storage.getState().settings,
    onCaptureError: (error) => {
        voiceDictationController.reportCaptureError(error);
    },
    onCaptureStarted: () => {},
    onPartialTranscript: partial => voiceDictationController.reportPartialTranscript(partial),
});
const dictationCaptureOwner = createVoiceCaptureAdmissionBinding({
    admission: voiceCaptureAdmissionController,
    captureOwner: rawDictationCaptureOwner,
    productOwner: 'dictation',
});

const admittedWebRecordingBlobs = new Map<string, Blob>();

async function measureRecordedAudioBytes(uri: string): Promise<number | null> {
    if (Platform.OS === 'web' && uri.startsWith('blob:')) {
        const blob = await (await runtimeFetch(uri)).blob();
        admittedWebRecordingBlobs.set(uri, blob);
        return blob.size;
    }
    return await resolveLocalUploadSourceSizeBytes({ kind: 'native', uri });
}

async function deleteRecordedAudio(uri: string): Promise<void> {
    await deleteRecordedAudioArtifact(uri);
    if (Platform.OS === 'web' && uri.startsWith('blob:')) admittedWebRecordingBlobs.delete(uri);
}

export const voiceDictationController = createVoiceDictationController({
    captureOwner: dictationCaptureOwner,
    getSettings: () => storage.getState().settings,
    nativeAudioSessionCoordinator: getSharedVoiceAudioSessionCoordinator(),
    resolveExecutionMachineId: () => resolveVoiceExecutionMachineId(),
    measureRecordedAudioBytes,
    deleteRecordedAudio,
    transcribeRecordedAudio: (params) => recordedAudioTranscriptionController.transcribe({
        ...params,
        webBlob: admittedWebRecordingBlobs.get(params.uri) ?? null,
    }),
});
