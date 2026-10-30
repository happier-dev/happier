import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNativeVoicePcmCaptureHarness } from '@/dev/testkit/harness/nativeVoicePcmCapture';
const nativeAudio = createNativeVoicePcmCaptureHarness();
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'android' } });
});
vi.mock('expo-modules-core', async original => {
    const actual = await original<typeof import('expo-modules-core')>();
    return { ...actual, requireOptionalNativeModule: (name: string) => name === 'HappierAudioStreamNative'
        ? nativeAudio.nativeModule : actual.requireOptionalNativeModule(name) };
});
vi.mock('expo-file-system', () => ({ File: class {
    exists = true;
    async delete() { this.exists = false; }
} }));
const activeOwners: Array<ReturnType<typeof createLocalVoiceCaptureOwner>> = [];
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { getSharedVoiceAudioSessionCoordinator } = await import('@happier-dev/audio-stream-native');
const coordinator = getSharedVoiceAudioSessionCoordinator();
if (!coordinator) throw new Error('Installed native audio coordination unavailable');
const audioSession = { coordinator };
const { createExpoAudioRecordingMicSession } = await import('../mic/NativeMicSession');
const { createLocalVoiceCaptureOwner } = await import('./LocalVoiceCaptureOwner');
afterAll(async () => {
    await coordinator.dispose();
    await nativeAudio.coordinator.dispose();
});
beforeEach(() => { vi.clearAllMocks(); });
afterEach(async () => {
    for (const owner of activeOwners.splice(0)) await owner.stopSession();
    expect(audioSession.coordinator.getSnapshot().leaseCount).toBe(0);
});

import { createVoiceCaptureAdmissionController } from './VoiceCaptureAdmissionController';
import {
    createVoiceCaptureAdmissionBinding,
} from './VoiceCaptureAdmissionBinding';

function createCaptureOwner() {
    const requestPermission = vi.fn(async () => ({ granted: true, canAskAgain: true }));
    const prepareRecorder = vi.fn(async () => {});
    const owner = createLocalVoiceCaptureOwner({ getSettings: () => ({}),
        onCaptureStarted() {}, onCaptureError() {},
    }, { createRecordingMicSession: () => createExpoAudioRecordingMicSession({
        requestPermission, showPermissionDenied() {},
        createRecorder: () => ({ uri: 'file:///dictation.m4a', prepareToRecordAsync: prepareRecorder,
            record() {}, pause() {}, async stop() {} }),
    }) });
    activeOwners.push(owner);
    return Object.assign(owner, { requestPermission, prepareRecorder });
}

describe('createVoiceCaptureAdmissionBinding', () => {
    it('rejects Dictation before capture when conversational Voice owns admission', async () => {
        const admission = createVoiceCaptureAdmissionController();
        const conversation = admission.acquire('conversation');
        if (conversation.status !== 'acquired') throw new Error('expected conversation admission');
        const captureOwner = createCaptureOwner();
        const binding = createVoiceCaptureAdmissionBinding({
            admission,
            captureOwner,
            productOwner: 'dictation',
        });

        await expect(binding.startCapture({
            sessionId: 'session-1',
            provider: 'recorded_audio',
            handsFree: false,
        })).rejects.toEqual(expect.objectContaining({
            name: 'VoiceCaptureBusyError',
            code: 'voice_capture_busy_conversation',
            activeOwner: 'conversation',
        }));
        expect(captureOwner.prepareRecorder).not.toHaveBeenCalled();
        expect(audioSession.coordinator.getSnapshot().leaseCount).toBe(0);
    });

    it('retains admission through transcription and releases it on cleanup', async () => {
        const admission = createVoiceCaptureAdmissionController();
        const captureOwner = createCaptureOwner();
        const binding = createVoiceCaptureAdmissionBinding({
            admission,
            captureOwner,
            productOwner: 'dictation',
        });

        await binding.startCapture({
            sessionId: 'session-1',
            provider: 'recorded_audio',
            handsFree: false,
        });
        await binding.stopCapture({
            sessionId: 'session-1',
            provider: 'recorded_audio',
        });

        expect(admission.acquire('conversation')).toEqual({
            status: 'busy',
            activeOwner: 'dictation',
        });

        await binding.stopSession('session-1');
        expect(admission.acquire('conversation').status).toBe('acquired');
    });

    it.each([
        ['navigation cancellation', 'stop_session'],
        ['capture error callback', 'release_admission'],
    ] as const)('releases after %s', async (_label, terminal) => {
        const admission = createVoiceCaptureAdmissionController();
        const captureOwner = createCaptureOwner();
        const binding = createVoiceCaptureAdmissionBinding({
            admission,
            captureOwner,
            productOwner: 'dictation',
        });
        await binding.startCapture({
            sessionId: 'session-1',
            provider: 'recorded_audio',
            handsFree: false,
        });

        if (terminal === 'stop_session') {
            await binding.stopSession('session-1');
        } else {
            binding.releaseAdmission('session-1');
        }

        expect(admission.acquire('conversation').status).toBe('acquired');
    });

    it('releases after permission or acquisition failure and preserves the typed cause', async () => {
        const admission = createVoiceCaptureAdmissionController();
        const captureOwner = createCaptureOwner();
        captureOwner.requestPermission.mockResolvedValueOnce({ granted: false, canAskAgain: false });
        const binding = createVoiceCaptureAdmissionBinding({
            admission,
            captureOwner,
            productOwner: 'dictation',
        });

        await expect(binding.startCapture({
            sessionId: 'session-1',
            provider: 'recorded_audio',
            handsFree: false,
        })).rejects.toThrow('mic_permission_denied');
        expect(admission.acquire('conversation').status).toBe('acquired');
    });

});
