import * as React from 'react';
import { Platform } from 'react-native';

import { storage } from '@/sync/domains/state/storage';
import { resolveLocalUploadSourceSizeBytes } from '@/sync/runtime/files/localUploadSourceReader';
import { runtimeFetch } from '@/utils/system/runtimeFetch';
import { createLocalVoiceCaptureOwner } from '@/voice/runtime/input/LocalVoiceCaptureOwner';
import { createVoiceCaptureAdmissionBinding } from '@/voice/runtime/input/VoiceCaptureAdmissionBinding';
import { voiceCaptureAdmissionController } from '@/voice/runtime/input/VoiceCaptureAdmissionController';
import {
    recordedAudioTranscriptionController,
} from '@/voice/runtime/input/recordedAudioTranscriptionController';

import {
    createVoiceDictationController,
    type VoiceDictationFailure,
    type VoiceDictationSnapshot,
    type VoiceDictationToggleResult,
} from './VoiceDictationController';

const rawDictationCaptureOwner = createLocalVoiceCaptureOwner({
    getSettings: () => storage.getState().settings,
    onCaptureError: (error) => {
        voiceDictationController.reportCaptureError(error);
    },
    onCaptureStarted: () => {},
});
const dictationCaptureOwner = createVoiceCaptureAdmissionBinding({
    admission: voiceCaptureAdmissionController,
    captureOwner: rawDictationCaptureOwner,
    productOwner: 'dictation',
});

async function measureRecordedAudioBytes(uri: string): Promise<number | null> {
    if (Platform.OS === 'web' && uri.startsWith('blob:')) {
        return (await (await runtimeFetch(uri)).blob()).size;
    }
    return await resolveLocalUploadSourceSizeBytes({
        kind: 'native',
        uri,
    });
}

async function deleteRecordedAudio(uri: string): Promise<void> {
    if (Platform.OS === 'web' && uri.startsWith('blob:')) {
        URL.revokeObjectURL(uri);
        return;
    }
    const FileSystem: any = await import('expo-file-system');
    const file = new FileSystem.File(uri);
    if (file.exists !== false) {
        file.delete();
    }
}

export const voiceDictationController = createVoiceDictationController({
    captureOwner: dictationCaptureOwner,
    getSettings: () => storage.getState().settings,
    measureRecordedAudioBytes,
    deleteRecordedAudio,
    transcribeRecordedAudio: (params) => (
        recordedAudioTranscriptionController.transcribe(params)
    ),
});

const IDLE_DICTATION_SNAPSHOT = Object.freeze({
    sessionId: null,
    status: 'idle',
} as const);
const subscribeToNothing = (): (() => void) => () => {};

export function useVoiceDictation(sessionId: string | undefined): Readonly<{
    dismissFailure: (failureId: number) => void;
    failure: VoiceDictationFailure | null;
    status: VoiceDictationSnapshot['status'];
    toggle: () => Promise<VoiceDictationToggleResult>;
}> {
    const normalizedSessionId = sessionId?.trim() ?? '';
    const snapshot = React.useSyncExternalStore(
        normalizedSessionId
            ? voiceDictationController.subscribe
            : subscribeToNothing,
        normalizedSessionId
            ? voiceDictationController.getSnapshot
            : () => IDLE_DICTATION_SNAPSHOT,
        normalizedSessionId
            ? voiceDictationController.getSnapshot
            : () => IDLE_DICTATION_SNAPSHOT,
    );

    React.useEffect(() => {
        if (!normalizedSessionId) return;
        return () => {
            void voiceDictationController.cancel(normalizedSessionId);
        };
    }, [normalizedSessionId]);

    const toggle = React.useCallback(async () => {
        if (!normalizedSessionId) {
            return { kind: 'cancelled' } as const;
        }
        return await voiceDictationController.toggle(normalizedSessionId);
    }, [normalizedSessionId]);

    const dismissFailure = React.useCallback((failureId: number) => {
        voiceDictationController.dismissFailure(failureId);
    }, []);

    return {
        status: snapshot.sessionId === normalizedSessionId
            ? snapshot.status
            : 'idle',
        dismissFailure,
        failure: snapshot.failure?.sessionId === normalizedSessionId
            ? snapshot.failure
            : null,
        toggle,
    };
}
