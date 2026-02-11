import React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let localOssVoiceSectionProps: any = null;

const speakDeviceTextSpy = vi.fn();
const fetchSpeechAudioSpy = vi.fn();
const playAudioBytesSpy = vi.fn();
const modalAlertSpy = vi.fn();

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: { colors: { textSecondary: '#999' } } }),
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/modal', () => ({
    Modal: {
        prompt: vi.fn(),
        confirm: vi.fn(),
        alert: (...args: any[]) => modalAlertSpy(...args),
    },
}));

vi.mock('@/realtime/elevenlabs/autoprovision', () => ({
    createHappierElevenLabsAgent: vi.fn(),
    updateHappierElevenLabsAgent: vi.fn(),
}));

vi.mock('@/utils/secrets/normalizeSecretInput', () => ({
    normalizeSecretPromptInput: (value: string | null | undefined) => value ?? '',
}));

vi.mock('@/voice/voiceProviders', () => ({
    VOICE_PROVIDER_IDS: {
        OFF: 'off',
        LOCAL_OPENAI_STT_TTS: 'local_oss',
        HAPPIER_ELEVENLABS_AGENTS: 'happier',
        BYO_ELEVENLABS: 'byo_elevenlabs',
    },
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        decryptSecretValue: () => null,
        encryptSecretValue: () => ({ _isSecretValue: true, encryptedValue: { t: 'enc-v1', c: 'x' } }),
    },
}));

vi.mock('@/hooks/server/useHappierVoiceSupport', () => ({
    useHappierVoiceSupport: () => true,
}));

vi.mock('@/constants/Languages', () => ({
    LANGUAGES: [{ code: 'en', name: 'English' }],
    findLanguageByCode: () => ({ code: 'en', name: 'English' }),
    getLanguageDisplayName: () => 'English',
}));

vi.mock('@/agents/hooks/useEnabledAgentIds', () => ({
    useEnabledAgentIds: () => ['claude'],
}));

vi.mock('@/agents/catalog/agentPickerOptions', () => ({
    getAgentPickerOptions: () => [],
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: any) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: any) => React.createElement('ItemGroup', null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('./voice/useModelPreflight', () => ({
    useModelPreflight: () => ({ daemonMediatorModelOptions: [], daemonMediatorSupportsFreeform: false }),
}));

vi.mock('./voice/VoiceModeSection', () => ({
    VoiceModeSection: () => null,
}));

vi.mock('./voice/ByoElevenLabsSection', () => ({
    ByoElevenLabsSection: () => null,
}));

vi.mock('./voice/VoicePrivacySection', () => ({
    VoicePrivacySection: () => null,
}));

vi.mock('./voice/LocalOssVoiceSection', () => ({
    LocalOssVoiceSection: (props: any) => {
        localOssVoiceSectionProps = props;
        return React.createElement('LocalOssVoiceSection', props);
    },
}));

vi.mock('@/voice/local/speakDeviceText', () => ({
    speakDeviceText: (...args: any[]) => speakDeviceTextSpy(...args),
}));

vi.mock('@/voice/local/fetchOpenAiCompatSpeechAudio', () => ({
    fetchOpenAiCompatSpeechAudio: (...args: any[]) => fetchSpeechAudioSpy(...args),
}));

vi.mock('@/voice/local/playAudioBytes', () => ({
    playAudioBytes: (...args: any[]) => playAudioBytesSpy(...args),
}));

vi.mock('@/voice/local/formatVoiceTestFailureMessage', () => ({
    formatVoiceTestFailureMessage: (_msg: string) => 'formatted error',
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSettingMutable: (key: string) => {
        switch (key) {
            case 'voiceAssistantLanguage':
                return ['en', vi.fn()];
            case 'voiceProviderId':
                return ['local_oss', vi.fn()];
            case 'voiceLocalUseDeviceTts':
                return [true, vi.fn()];
            case 'voiceLocalTtsBaseUrl':
                return [null, vi.fn()];
            default:
                return [null, vi.fn()];
        }
    },
}));

describe('VoiceSettingsScreen (device TTS)', () => {
    beforeEach(() => {
        localOssVoiceSectionProps = null;
        speakDeviceTextSpy.mockClear();
        fetchSpeechAudioSpy.mockClear();
        playAudioBytesSpy.mockClear();
        modalAlertSpy.mockClear();
    });

    it('uses device TTS for Test TTS when enabled (does not require TTS Base URL)', async () => {
        const VoiceSettingsScreen = (await import('./voice')).default;

        let tree!: ReactTestRenderer;
        act(() => {
            tree = renderer.create(React.createElement(VoiceSettingsScreen));
        });
        await act(async () => {});

        expect(tree).toBeTruthy();
        expect(localOssVoiceSectionProps).toBeTruthy();

        await act(async () => {
            localOssVoiceSectionProps.onTestLocalTts();
        });
        await act(async () => {});

        expect(modalAlertSpy).not.toHaveBeenCalledWith('common.error', 'settingsVoice.local.testTtsMissingBaseUrl');
        expect(speakDeviceTextSpy).toHaveBeenCalledWith('settingsVoice.local.testTtsSample');
        expect(fetchSpeechAudioSpy).not.toHaveBeenCalled();
        expect(playAudioBytesSpy).not.toHaveBeenCalled();
    });
});
