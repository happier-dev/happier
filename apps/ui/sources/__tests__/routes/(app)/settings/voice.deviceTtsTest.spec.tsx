import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    renderSettingsView,
    standardCleanup,
} from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const speakDeviceTextSpy = vi.fn();
const setVoiceSpy = vi.fn();
const { modalMockRef } = vi.hoisted(() => ({
    modalMockRef: { current: null as any },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    const modalMock = createModalModuleMock();
    modalMockRef.current = modalMock;
    return modalMock.module;
});

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: React.forwardRef((props: any, ref: any) => React.createElement('ItemList', { ...props, ref }, props.children)),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: any) => React.createElement('ItemGroup', null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement(
        'DropdownMenu',
        props,
        (typeof props.trigger === 'function'
            ? props.trigger({ open: false, toggle: () => {}, openMenu: () => {}, closeMenu: () => {} })
            : props.trigger) ?? null,
    ),
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: (props: any) => React.createElement('Switch', props),
}));

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

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    useSetting: (key: string) => {
        if (key === 'voice') return voiceSetting;
        if (key === 'backendEnabledById') return {};
        if (key === 'backendEnabledByTargetKey') return {};
        if (key === 'recentMachinePaths') return [];
        throw new Error(`unexpected useSetting(${key})`);
    },
    useSettings: () => ({}),
});
});

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

vi.mock('@/sync/store/hooks', () => ({
    useAllMachines: () => [],
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverId: 'test-server' }),
}));

vi.mock('@/components/settings/pickers/resolvePreferredMachineId', () => ({
    resolvePreferredMachineId: () => null,
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
        const { voiceSettingsDefaults } = await import('@/sync/domains/settings/voiceSettings');
        voiceSetting = {
            ...voiceSettingsDefaults,
            providerId: 'local_direct',
            adapters: {
                ...voiceSettingsDefaults.adapters,
                local_direct: {
                    ...voiceSettingsDefaults.adapters.local_direct,
                    tts: {
                        ...voiceSettingsDefaults.adapters.local_direct.tts,
                        provider: 'device',
                    },
                },
            },
        };

        await import('@/modal');
        const VoiceSettingsScreen = (await import('@/app/(app)/settings/voice')).default;
        const screen = await renderSettingsView(<VoiceSettingsScreen />);
        expect(screen.findRowByTitle('settingsVoice.local.testTts')).toBeTruthy();

        await act(async () => {
            await screen.pressRowByTitle('settingsVoice.local.testTts');
        });

        expect(modalMockRef.current.spies.alert).not.toHaveBeenCalledWith('common.error', 'settingsVoice.local.testTtsMissingBaseUrl');
        expect(speakDeviceTextSpy).toHaveBeenCalledWith('settingsVoice.local.testTtsSample');
    });

    it('uses device TTS for Test TTS when enabled for local conversation', async () => {
        const { voiceSettingsDefaults } = await import('@/sync/domains/settings/voiceSettings');
        voiceSetting = {
            ...voiceSettingsDefaults,
            providerId: 'local_conversation',
            adapters: {
                ...voiceSettingsDefaults.adapters,
                local_conversation: {
                    ...voiceSettingsDefaults.adapters.local_conversation,
                    conversationMode: 'agent',
                    tts: {
                        ...voiceSettingsDefaults.adapters.local_conversation.tts,
                        provider: 'device',
                    },
                },
            },
        };

        await import('@/modal');
        const VoiceSettingsScreen = (await import('@/app/(app)/settings/voice')).default;
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
        const { voiceSettingsDefaults } = await import('@/sync/domains/settings/voiceSettings');
        voiceSetting = {
            ...voiceSettingsDefaults,
            providerId: 'local_direct',
            adapters: {
                ...voiceSettingsDefaults.adapters,
                local_direct: {
                    ...voiceSettingsDefaults.adapters.local_direct,
                    tts: {
                        ...voiceSettingsDefaults.adapters.local_direct.tts,
                        provider: 'device',
                    },
                },
            },
        };
        await import('@/modal');
        const VoiceSettingsScreen = (await import('@/app/(app)/settings/voice')).default;
        const screen = await renderSettingsView(<VoiceSettingsScreen />);
        expect(screen.findRowByTitle('settingsVoice.local.testTts')).toBeTruthy();

        await act(async () => {
            await screen.pressRowByTitle('settingsVoice.local.testTts');
        });

        expect(modalMockRef.current.spies.alert).toHaveBeenCalledWith('common.error', 'formatted error');
    });
});
