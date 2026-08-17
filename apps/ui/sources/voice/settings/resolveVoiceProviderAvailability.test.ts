import { describe, expect, it, vi } from 'vitest';

const platformOsMock = vi.hoisted(() => ({ value: 'ios' }));

vi.mock('react-native', () => ({
    Platform: {
        get OS() {
            return platformOsMock.value;
        },
    },
}));

import {
    resolveVoiceDeviceSpeechRolePath,
    resolveVoiceProviderAvailability,
} from './resolveVoiceProviderAvailability';

describe('resolveVoiceProviderAvailability', () => {
    it('projects passive Device recognition only for STT roles', () => {
        const local = {
            browserSpeech: { support: 'unavailable' as const, onDevice: 'unsupported' as const },
            nativeDevice: { requested: true, speechRecognition: 'available' as const },
        };

        expect(resolveVoiceDeviceSpeechRolePath({
            role: 'dictation_stt',
            platformOs: 'web',
            local,
        })).toMatchObject({
            runnable: false,
            reason: 'browser_speech_unsupported',
        });
        expect(resolveVoiceDeviceSpeechRolePath({
            role: 'conversation_stt',
            platformOs: 'ios',
            local,
        })).toMatchObject({
            runnable: true,
            reason: null,
        });
        expect(resolveVoiceDeviceSpeechRolePath({
            role: 'dictation_stt',
            platformOs: 'web',
            local: {
                ...local,
                browserSpeech: { support: 'cloud_only', onDevice: 'unsupported' },
            },
        })).toMatchObject({
            runnable: true,
            readiness: 'cloud_only',
            reason: 'browser_speech_cloud_only',
            privacy: 'cloud_or_remote',
        });
        expect(resolveVoiceDeviceSpeechRolePath({
            role: 'dictation_stt',
            platformOs: 'web',
            local: {
                ...local,
                browserSpeech: { support: 'unknown', onDevice: 'unknown' },
            },
        })).toMatchObject({
            runnable: false,
            readiness: 'unknown',
            reason: 'browser_speech_on_device_unknown',
        });
        expect(resolveVoiceDeviceSpeechRolePath({
            role: 'conversation_tts',
            platformOs: 'ios',
            local,
        })).toBeNull();
    });

    it('keeps the mode list stable and disables only hosted Happier Voice when the server does not support it', () => {
        const availability = resolveVoiceProviderAvailability({
            happierVoiceSupported: false,
            platformOs: 'web',
            local: {
                browserSpeech: { support: 'available' },
                daemon: { featureEnabled: false, route: 'unavailable', modelState: 'unknown' },
                nativeDevice: { requested: false },
            },
        });

        expect(availability.off).toMatchObject({ modeId: 'off', enabled: true, reason: null });
        expect(availability.byo).toMatchObject({ modeId: 'byo', enabled: true, reason: null });
        expect(availability.local).toMatchObject({ modeId: 'local', enabled: true, reason: null });
        expect(availability.happier).toMatchObject({
            modeId: 'happier',
            enabled: false,
            runnable: false,
            reason: 'server_unsupported',
        });
    });

    it('marks every current mode selectable when hosted Happier Voice is supported', () => {
        const availability = resolveVoiceProviderAvailability({
            happierVoiceSupported: true,
            platformOs: 'ios',
            local: {
                browserSpeech: { support: 'unavailable' },
                daemon: { featureEnabled: false, route: 'unavailable', modelState: 'unknown' },
                nativeDevice: { requested: true, speechRecognition: 'available' },
            },
        });

        expect(Object.values(availability).every((mode) => mode.enabled)).toBe(true);
    });

    it('keeps Local selectable on web when browser speech is available without requiring daemon models', () => {
        const availability = resolveVoiceProviderAvailability({
            happierVoiceSupported: true,
            platformOs: 'web',
            local: {
                browserSpeech: { support: 'available' },
                daemon: { featureEnabled: false, route: 'unavailable', modelState: 'unknown' },
                nativeDevice: { requested: false },
            },
        });

        expect(availability.local).toMatchObject({
            enabled: true,
            runnable: true,
            reason: null,
        });
        expect(availability.local.paths.browserSpeech).toMatchObject({
            selectable: true,
            runnable: true,
            readiness: 'ready',
            reason: null,
        });
        expect(availability.local.paths.daemon).toMatchObject({
            selectable: false,
            runnable: false,
            reason: 'feature_disabled',
        });
        expect(availability.local.paths.nativeDevice).toMatchObject({
            selectable: false,
            runnable: false,
            reason: 'native_device_unavailable_on_web',
        });
    });

    it('owns runtime platform defaults inside the resolver when callers omit platform and local inputs', () => {
        platformOsMock.value = 'web';

        const availability = resolveVoiceProviderAvailability({
            happierVoiceSupported: true,
        });

        expect(availability.local).toMatchObject({
            enabled: false,
            runnable: false,
            reason: 'browser_speech_on_device_unknown',
        });
        expect(availability.local.paths.browserSpeech).toMatchObject({
            selectable: false,
            runnable: false,
            readiness: 'unknown',
            reason: 'browser_speech_on_device_unknown',
        });
        expect(availability.local.paths.nativeDevice).toMatchObject({
            selectable: false,
            runnable: false,
            reason: 'native_device_unavailable_on_web',
        });
    });

    it('distinguishes browser speech cloud fallback from unavailable browser speech', () => {
        const cloudOnly = resolveVoiceProviderAvailability({
            happierVoiceSupported: true,
            platformOs: 'web',
            local: {
                browserSpeech: { support: 'cloud_only' },
                daemon: { featureEnabled: false, route: 'unavailable', modelState: 'unknown' },
                nativeDevice: { requested: false },
            },
        });
        const unavailable = resolveVoiceProviderAvailability({
            happierVoiceSupported: true,
            platformOs: 'web',
            local: {
                browserSpeech: { support: 'unavailable' },
                daemon: { featureEnabled: false, route: 'unavailable', modelState: 'unknown' },
                nativeDevice: { requested: false },
            },
        });

        expect(cloudOnly.local.paths.browserSpeech).toMatchObject({
            selectable: true,
            runnable: true,
            readiness: 'cloud_only',
            reason: 'browser_speech_cloud_only',
        });
        expect(unavailable.local.paths.browserSpeech).toMatchObject({
            selectable: false,
            runnable: false,
            readiness: 'unavailable',
            reason: 'browser_speech_unavailable',
        });
    });

    it('keeps daemon Local selectable while models are installable or installing but not yet runnable', () => {
        const missing = resolveVoiceProviderAvailability({
            happierVoiceSupported: true,
            platformOs: 'web',
            local: {
                browserSpeech: { support: 'unavailable' },
                daemon: { featureEnabled: true, route: 'direct', modelState: 'missing' },
                nativeDevice: { requested: false },
            },
        });
        const installing = resolveVoiceProviderAvailability({
            happierVoiceSupported: true,
            platformOs: 'web',
            local: {
                browserSpeech: { support: 'unavailable' },
                daemon: { featureEnabled: true, route: 'direct', modelState: 'installing' },
                nativeDevice: { requested: false },
            },
        });

        expect(missing.local).toMatchObject({ enabled: true, runnable: false, reason: 'models_missing' });
        expect(missing.local.paths.daemon).toMatchObject({
            selectable: true,
            runnable: false,
            readiness: 'installable',
            reason: 'models_missing',
        });
        expect(installing.local).toMatchObject({ enabled: true, runnable: false, reason: 'models_installing' });
        expect(installing.local.paths.daemon).toMatchObject({
            selectable: true,
            runnable: false,
            readiness: 'installing',
            reason: 'models_installing',
        });
    });

    it('keeps a reachable daemon path selectable while selected model readiness is still unknown', () => {
        const availability = resolveVoiceProviderAvailability({
            happierVoiceSupported: true,
            platformOs: 'web',
            local: {
                browserSpeech: { support: 'unavailable' },
                daemon: { featureEnabled: true, route: 'direct', modelState: 'unknown' },
                nativeDevice: { requested: false },
            },
        });

        expect(availability.local).toMatchObject({
            enabled: true,
            runnable: false,
            reason: 'models_unknown',
        });
        expect(availability.local.paths.daemon).toMatchObject({
            selectable: true,
            runnable: false,
            readiness: 'unknown',
            reason: 'models_unknown',
        });
    });

    it('surfaces daemon runtime-unavailable separately from model install errors', () => {
        const availability = resolveVoiceProviderAvailability({
            happierVoiceSupported: true,
            platformOs: 'web',
            local: {
                browserSpeech: { support: 'unavailable' },
                daemon: {
                    featureEnabled: true,
                    route: 'relay',
                    modelState: 'ready',
                    runtimeState: 'unavailable',
                },
                nativeDevice: { requested: false },
            },
        });

        expect(availability.local).toMatchObject({
            enabled: true,
            runnable: false,
            reason: 'daemon_runtime_unavailable',
        });
        expect(availability.local.paths.daemon).toMatchObject({
            selectable: true,
            runnable: false,
            readiness: 'error',
            reason: 'daemon_runtime_unavailable',
        });
    });

    it('distinguishes daemon unreachable from relay-disabled remote web policy', () => {
        const unreachable = resolveVoiceProviderAvailability({
            happierVoiceSupported: true,
            platformOs: 'web',
            local: {
                browserSpeech: { support: 'unavailable' },
                daemon: { featureEnabled: true, route: 'unavailable', modelState: 'ready' },
                nativeDevice: { requested: false },
            },
        });
        const relayDisabled = resolveVoiceProviderAvailability({
            happierVoiceSupported: true,
            platformOs: 'web',
            local: {
                browserSpeech: { support: 'unavailable' },
                daemon: { featureEnabled: true, route: 'relay_disabled', modelState: 'ready' },
                nativeDevice: { requested: false },
            },
        });

        expect(unreachable.local.paths.daemon.reason).toBe('daemon_unreachable');
        expect(unreachable.local).toMatchObject({ enabled: false, runnable: false, reason: 'browser_speech_unavailable' });
        expect(relayDisabled.local.paths.daemon.reason).toBe('daemon_relay_disabled');
        expect(relayDisabled.local).toMatchObject({ enabled: false, runnable: false, reason: 'browser_speech_unavailable' });
    });

    it('maps capped daemon relay policy to a typed capped state instead of daemon unreachable', () => {
        const availability = resolveVoiceProviderAvailability({
            happierVoiceSupported: true,
            platformOs: 'web',
            local: {
                browserSpeech: { support: 'unavailable' },
                daemon: { featureEnabled: true, route: 'relay_capped', modelState: 'ready' },
                nativeDevice: { requested: false },
            },
        });

        expect(availability.local.paths.daemon).toMatchObject({
            selectable: false,
            runnable: false,
            readiness: 'unavailable',
            reason: 'daemon_relay_capped',
        });
        expect(availability.local).toMatchObject({ enabled: false, runnable: false, reason: 'browser_speech_unavailable' });
    });

    it('allows native-device Local on native platforms while still reporting daemon as a separate path', () => {
        const availability = resolveVoiceProviderAvailability({
            happierVoiceSupported: true,
            platformOs: 'ios',
            local: {
                browserSpeech: { support: 'unavailable' },
                daemon: { featureEnabled: true, route: 'direct', modelState: 'ready', pcmCapture: 'available' },
                nativeDevice: { requested: true, speechRecognition: 'available' },
            },
        });

        expect(availability.local).toMatchObject({ enabled: true, runnable: true, reason: null });
        expect(availability.local.paths.nativeDevice).toMatchObject({
            selectable: true,
            runnable: true,
            readiness: 'ready',
            reason: null,
        });
        expect(availability.local.paths.daemon).toMatchObject({
            selectable: true,
            runnable: true,
            readiness: 'ready',
            reason: null,
        });
    });

    it('reports native daemon STT as unavailable when the native PCM capture adapter is missing without hiding Local', () => {
        const availability = resolveVoiceProviderAvailability({
            happierVoiceSupported: true,
            platformOs: 'ios',
            local: {
                browserSpeech: { support: 'unavailable' },
                daemon: {
                    featureEnabled: true,
                    route: 'direct',
                    modelState: 'ready',
                    pcmCapture: 'unavailable',
                },
                nativeDevice: { requested: true, speechRecognition: 'available' },
            },
        });

        expect(availability.local).toMatchObject({ enabled: true, runnable: true, reason: null });
        expect(availability.local.paths.daemon).toMatchObject({
            selectable: true,
            runnable: false,
            readiness: 'partial',
            reason: 'daemon_streaming_stt_pcm_capture_unavailable',
        });
        expect(availability.local.paths.nativeDevice).toMatchObject({
            selectable: true,
            runnable: true,
            readiness: 'ready',
            reason: null,
        });
    });

    it('keeps unknown native-device recognition fail-closed while using supplied daemon capability', () => {
        const availability = resolveVoiceProviderAvailability({
            happierVoiceSupported: true,
            platformOs: 'ios',
            local: {
                daemon: { featureEnabled: true, route: 'relay', modelState: 'ready', pcmCapture: 'available' },
            },
        });

        expect(availability.local).toMatchObject({ enabled: true, runnable: true, reason: null });
        expect(availability.local.paths.browserSpeech).toMatchObject({
            selectable: false,
            runnable: false,
            reason: 'browser_speech_unavailable',
        });
        expect(availability.local.paths.daemon).toMatchObject({
            selectable: true,
            runnable: true,
            readiness: 'ready',
            reason: null,
        });
        expect(availability.local.paths.nativeDevice).toMatchObject({
            selectable: false,
            runnable: false,
            readiness: 'unknown',
            reason: 'native_device_speech_recognition_unknown',
        });
    });

    it('keeps cloud browser speech runnable while surfacing on-device download state', () => {
        const downloadable = resolveVoiceProviderAvailability({
            happierVoiceSupported: true,
            platformOs: 'web',
            local: {
                browserSpeech: { support: 'cloud_only', onDevice: 'downloadable' },
                daemon: { featureEnabled: false, route: 'unavailable', modelState: 'unknown' },
                nativeDevice: { requested: false },
            },
        });
        const downloading = resolveVoiceProviderAvailability({
            happierVoiceSupported: true,
            platformOs: 'web',
            local: {
                browserSpeech: { support: 'cloud_only', onDevice: 'downloading' },
                daemon: { featureEnabled: false, route: 'unavailable', modelState: 'unknown' },
                nativeDevice: { requested: false },
            },
        });

        expect(downloadable.local).toMatchObject({ enabled: true, runnable: true, reason: null });
        expect(downloadable.local.paths.browserSpeech).toMatchObject({
            selectable: true,
            runnable: true,
            readiness: 'installable',
            reason: 'browser_speech_on_device_downloadable',
            privacy: 'cloud_or_remote',
            onDevice: 'downloadable',
        });
        expect(downloading.local.paths.browserSpeech).toMatchObject({
            selectable: true,
            runnable: true,
            readiness: 'installing',
            reason: 'browser_speech_on_device_downloading',
            privacy: 'cloud_or_remote',
            onDevice: 'downloading',
        });
    });

    it('keeps cloud browser speech runnable while surfacing on-device Permissions-Policy blocking', () => {
        const availability = resolveVoiceProviderAvailability({
            happierVoiceSupported: true,
            platformOs: 'web',
            local: {
                browserSpeech: { support: 'cloud_only', onDevice: 'permission_policy_blocked' },
                daemon: { featureEnabled: false, route: 'unavailable', modelState: 'unknown' },
                nativeDevice: { requested: false },
            },
        });

        expect(availability.local).toMatchObject({ enabled: true, runnable: true, reason: null });
        expect(availability.local.paths.browserSpeech).toMatchObject({
            selectable: true,
            runnable: true,
            readiness: 'cloud_only',
            reason: 'browser_speech_on_device_permission_policy_blocked',
            privacy: 'cloud_or_remote',
            onDevice: 'permission_policy_blocked',
        });
    });
});
