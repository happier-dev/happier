import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';

import { useBrowserWebSpeechCapability } from './browserWebSpeechCapability';
import { resolveVoiceProviderAvailability } from './resolveVoiceProviderAvailability';
import { resolveVoiceProviderLocalAvailability } from './voiceProviderLocalAvailability';

const originalSpeechRecognitionDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'SpeechRecognition');

afterEach(() => {
    if (originalSpeechRecognitionDescriptor) {
        Object.defineProperty(globalThis, 'SpeechRecognition', originalSpeechRecognitionDescriptor);
    } else {
        Reflect.deleteProperty(globalThis, 'SpeechRecognition');
    }
});

describe('useBrowserWebSpeechCapability', () => {
    it('does not invoke the experimental availability API during passive settings render', async () => {
        const available = vi.fn().mockResolvedValue('available');
        const construct = vi.fn();
        function SpeechRecognition(this: { processLocally?: boolean }) {
            construct();
            this.processLocally = false;
        }
        SpeechRecognition.prototype.processLocally = false;
        Object.assign(SpeechRecognition, { available });
        Object.defineProperty(globalThis, 'SpeechRecognition', {
            configurable: true,
            value: SpeechRecognition,
        });

        const hook = await renderHook(() => useBrowserWebSpeechCapability('web'));

        expect(construct).not.toHaveBeenCalled();
        expect(available).not.toHaveBeenCalled();
        expect(hook.getCurrent()).toEqual({ support: 'cloud_only', onDevice: 'unknown' });
        const availability = resolveVoiceProviderAvailability({
            happierVoiceSupported: true,
            platformOs: 'web',
            local: resolveVoiceProviderLocalAvailability({
                platformOs: 'web',
                serverFeatures: null,
                daemonFeatureEnabled: false,
                browserSpeechCapability: hook.getCurrent(),
            }),
        });
        expect(availability.local.paths.browserSpeech).toMatchObject({
            selectable: true,
            runnable: true,
            readiness: 'cloud_only',
            privacy: 'cloud_or_remote',
            onDevice: 'unknown',
            reason: 'browser_speech_on_device_unknown',
        });
    });
});
