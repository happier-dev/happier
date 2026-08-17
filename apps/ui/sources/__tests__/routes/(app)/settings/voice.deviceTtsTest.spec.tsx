import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    renderSettingsView,
    standardCleanup,
} from '@/dev/testkit';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { settingsParse } from '@/sync/domains/settings/settings';
import {
    getVoiceSettingsRouteModalMockRef,
    installVoiceSettingsRouteModuleMocks,
} from './voiceSettingsRouteTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const speakDeviceTextSpy = vi.fn();
const setVoiceSpy = vi.fn();
const modalMockRef = getVoiceSettingsRouteModalMockRef();

installVoiceSettingsRouteModuleMocks({
    storageModule: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSetting: (key: string) => {
                if (key === 'voice') return voiceSetting;
                if (key === 'backendEnabledById') return {};
                if (key === 'backendEnabledByTargetKey') return {};
                if (key === 'recentMachinePaths') return [];
                throw new Error(`unexpected useSetting(${key})`);
            },
            useSettings: () => settingsParse({}),
        });
    },
});

vi.mock('@/voice/local/speakDeviceText', () => ({
    speakDeviceText: (...args: any[]) => speakDeviceTextSpy(...args),
}));

vi.mock('@/voice/local/formatVoiceTestFailureMessage', () => ({
    formatVoiceTestFailureMessage: (_msg: string) => 'formatted error',
}));

let voiceSetting: any = null;

vi.mock('@/voice/settings/useVoiceSettingsMutable', () => ({
    useVoiceSettingsMutable: () => [voiceSetting, (next: any) => setVoiceSpy(next)],
}));

vi.mock('@/agents/hooks/useEnabledAgentIds', () => ({
    useEnabledAgentIds: () => ['claude', 'codex', 'opencode'],
}));

vi.mock('@/components/sessions/new/hooks/screenModel/useNewSessionPreflightModelsState', () => ({
    useNewSessionPreflightModelsState: () => ({
        modelOptions: [],
        probe: {
            phase: 'idle',
            refresh: vi.fn(),
        },
    }),
}));

vi.mock('@/sync/store/hooks', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/store/hooks')>();
    return {
        ...actual,
        useAllMachines: () => [],
        useProfile: () => profileDefaults,
    };
});

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverId: 'test-server' }),
    subscribeActiveServer: () => () => {},
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ credentials: null }),
}));

vi.mock('@/agents/runtime/resumeCapabilities', () => ({
    canAgentResume: () => true,
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        applySettings: vi.fn(),
        decryptSecretValue: () => null,
    },
}));

vi.mock('@/hooks/server/useHappierVoiceSupport', () => ({
    useHappierVoiceSupport: () => true,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));

vi.mock('@/constants/Languages', () => ({
    LANGUAGES: [{ code: 'en', name: 'English' }],
    findLanguageByCode: () => ({ code: 'en', name: 'English' }),
}));

describe('VoiceSettingsScreen (device TTS)', () => {
    beforeEach(() => {
        speakDeviceTextSpy.mockClear();
        speakDeviceTextSpy.mockResolvedValue(undefined);
        setVoiceSpy.mockClear();
        modalMockRef.current?.spies.alert.mockClear();
        modalMockRef.current?.spies.confirm.mockClear();
        modalMockRef.current?.spies.prompt.mockClear();
    });

    afterEach(() => {
        standardCleanup();
    });

    it('uses device TTS for Test TTS when enabled (does not require TTS Base URL)', async () => {
        const {
            readLocalDirectVoiceSettings,
            voiceSettingsDefaults,
            voiceSettingsParse,
            writeLocalDirectVoiceSettings,
        } = await import('@/sync/domains/settings/voiceSettings');
        const localDirect = readLocalDirectVoiceSettings(voiceSettingsDefaults);
        voiceSetting = voiceSettingsParse({
            ...writeLocalDirectVoiceSettings(voiceSettingsDefaults, {
                ...localDirect,
                tts: { ...localDirect.tts, provider: 'device' },
            }),
            providerId: 'local_direct',
        });

        await import('@/modal');
        const VoiceSettingsScreen = (await import('@/voice/settings/screens/VoiceConversationsSettingsScreen')).VoiceConversationsSettingsScreen;
        const screen = await renderSettingsView(<VoiceSettingsScreen />);
        expect(screen.findRowByTitle('settingsVoice.local.testTts')).toBeTruthy();

        await act(async () => {
            await screen.pressRowByTitle('settingsVoice.local.testTts');
        });

        expect(modalMockRef.current.spies.alert).not.toHaveBeenCalledWith('common.error', 'settingsVoice.local.testTtsMissingBaseUrl');
        expect(speakDeviceTextSpy).toHaveBeenCalledWith('settingsVoice.local.testTtsSample');
    });

    it('uses device TTS for Test TTS when enabled for local conversation', async () => {
        const {
            readLocalConversationVoiceSettings,
            voiceSettingsDefaults,
            voiceSettingsParse,
            writeLocalConversationVoiceSettings,
        } = await import('@/sync/domains/settings/voiceSettings');
        const localConversation = readLocalConversationVoiceSettings(voiceSettingsDefaults);
        voiceSetting = voiceSettingsParse({
            ...writeLocalConversationVoiceSettings(voiceSettingsDefaults, {
                ...localConversation,
                conversationMode: 'agent',
                tts: { ...localConversation.tts, provider: 'device' },
            }),
            providerId: 'local_conversation',
        });

        await import('@/modal');
        const VoiceSettingsScreen = (await import('@/voice/settings/screens/VoiceConversationsSettingsScreen')).VoiceConversationsSettingsScreen;
        const screen = await renderSettingsView(<VoiceSettingsScreen />);
        expect(screen.findRowByTitle('settingsVoice.local.testTts')).toBeTruthy();

        await act(async () => {
            await screen.pressRowByTitle('settingsVoice.local.testTts');
        });

        expect(modalMockRef.current.spies.alert).not.toHaveBeenCalledWith('common.error', 'settingsVoice.local.testTtsMissingBaseUrl');
        expect(speakDeviceTextSpy).toHaveBeenCalledWith('settingsVoice.local.testTtsSample');
    });

    it('shows an error when device TTS test fails', async () => {
        speakDeviceTextSpy.mockRejectedValueOnce(new Error('device failed'));
        const {
            readLocalDirectVoiceSettings,
            voiceSettingsDefaults,
            voiceSettingsParse,
            writeLocalDirectVoiceSettings,
        } = await import('@/sync/domains/settings/voiceSettings');
        const localDirect = readLocalDirectVoiceSettings(voiceSettingsDefaults);
        voiceSetting = voiceSettingsParse({
            ...writeLocalDirectVoiceSettings(voiceSettingsDefaults, {
                ...localDirect,
                tts: { ...localDirect.tts, provider: 'device' },
            }),
            providerId: 'local_direct',
        });
        await import('@/modal');
        const VoiceSettingsScreen = (await import('@/voice/settings/screens/VoiceConversationsSettingsScreen')).VoiceConversationsSettingsScreen;
        const screen = await renderSettingsView(<VoiceSettingsScreen />);
        expect(screen.findRowByTitle('settingsVoice.local.testTts')).toBeTruthy();

        await act(async () => {
            await screen.pressRowByTitle('settingsVoice.local.testTts');
        });

        expect(modalMockRef.current.spies.alert).toHaveBeenCalledWith('common.error', 'formatted error');
    });
});
