import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/voice/voiceProviders', () => ({
    VOICE_PROVIDER_IDS: {
        LOCAL_OPENAI_STT_TTS: 'local_openai_stt_tts',
    },
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: (props: any) => React.createElement('Switch', props),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

describe('LocalOssVoiceSection (device speech)', () => {
    const buildProps = (overrides: Record<string, unknown> = {}) => {
        const onSetVoiceLocalUseDeviceStt = vi.fn();
        const onSetVoiceLocalUseDeviceTts = vi.fn();

        const props = {
            voiceProviderId: 'local_openai_stt_tts',
            themeTextSecondary: '#999',
            openMenu: null,
            onOpenMenuChange: vi.fn(),
            agentPickerOptions: [],
            daemonMediatorModelOptions: [],
            daemonMediatorSupportsFreeform: false,
            voiceLocalConversationMode: 'direct_session',
            voiceLocalMediatorBackend: 'daemon',
            voiceMediatorAgentSource: 'session',
            voiceMediatorAgentId: null,
            voiceMediatorPermissionPolicy: 'read_only',
            voiceMediatorVerbosity: 'short',
            voiceMediatorIdleTtlSeconds: 300,
            voiceMediatorChatModelSource: 'custom',
            voiceMediatorChatModelId: 'default',
            voiceMediatorCommitModelSource: 'chat',
            voiceMediatorCommitModelId: 'default',
            voiceLocalChatBaseUrl: null,
            hasVoiceLocalChatApiKey: false,
            voiceLocalChatChatModel: 'default',
            voiceLocalChatCommitModel: 'default',
            voiceLocalChatTemperature: 0.4,
            voiceLocalChatMaxTokens: null,
            voiceLocalSttBaseUrl: null,
            voiceLocalUseDeviceStt: false,
            hasVoiceLocalSttApiKey: false,
            voiceLocalSttModel: 'whisper-1',
            voiceLocalTtsBaseUrl: null,
            voiceLocalUseDeviceTts: false,
            hasVoiceLocalTtsApiKey: false,
            voiceLocalTtsModel: 'tts-1',
            voiceLocalTtsVoice: 'alloy',
            voiceLocalTtsFormat: 'mp3',
            voiceLocalAutoSpeakReplies: false,
            isTestingLocalTts: false,
            onSetVoiceLocalConversationMode: vi.fn(),
            onToggleVoiceLocalMediatorBackend: vi.fn(),
            onToggleVoiceMediatorAgentSource: vi.fn(),
            onSetVoiceMediatorAgentId: vi.fn(),
            onToggleVoiceMediatorPermissionPolicy: vi.fn(),
            onToggleVoiceMediatorVerbosity: vi.fn(),
            onSetMediatorIdleTtl: vi.fn(),
            onToggleVoiceMediatorChatModelSource: vi.fn(),
            onSetVoiceMediatorChatModelId: vi.fn(),
            onSetDaemonMediatorModelText: vi.fn(),
            onCycleVoiceMediatorCommitModelSource: vi.fn(),
            onSetVoiceMediatorCommitModelId: vi.fn(),
            onSetLocalChatUrl: vi.fn(),
            onSetLocalChatApiKey: vi.fn(),
            onSetLocalChatText: vi.fn(),
            onSetChatTemperature: vi.fn(),
            onSetChatMaxTokens: vi.fn(),
            onSetLocalUrl: vi.fn(),
            onSetVoiceLocalUseDeviceStt,
            onSetVoiceLocalUseDeviceTts,
            onSetLocalApiKey: vi.fn(),
            onSetLocalText: vi.fn(),
            onToggleVoiceLocalTtsFormat: vi.fn(),
            onSetVoiceLocalAutoSpeakReplies: vi.fn(),
            onTestLocalTts: vi.fn(),
            ...overrides,
        };

        return {
            props,
            onSetVoiceLocalUseDeviceStt,
            onSetVoiceLocalUseDeviceTts,
        };
    };

    const renderWithProps = async (overrides: Record<string, unknown> = {}) => {
        const { LocalOssVoiceSection } = await import('./LocalOssVoiceSection');
        const built = buildProps(overrides);

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(<LocalOssVoiceSection {...(built.props as any)} />);
        });

        return { tree: tree!, ...built };
    };

    it('renders device STT/TTS toggles when local voice provider is selected', async () => {
        const { tree, onSetVoiceLocalUseDeviceStt, onSetVoiceLocalUseDeviceTts } = await renderWithProps();
        const items = tree.root.findAllByType('Item' as any);
        const byTitle = new Map(items.map((n: any) => [n.props.title, n.props]));

        expect(byTitle.get('settingsVoice.local.deviceStt')).toBeTruthy();
        expect(byTitle.get('settingsVoice.local.deviceTts')).toBeTruthy();

        // Ensure switches are wired to callbacks.
        const deviceSttItem = items.find((n: any) => n.props.title === 'settingsVoice.local.deviceStt')!;
        const deviceTtsItem = items.find((n: any) => n.props.title === 'settingsVoice.local.deviceTts')!;

        const sttSwitch = deviceSttItem.props.rightElement;
        const ttsSwitch = deviceTtsItem.props.rightElement;
        expect(typeof sttSwitch?.props?.onValueChange).toBe('function');
        expect(typeof ttsSwitch?.props?.onValueChange).toBe('function');

        act(() => {
            sttSwitch.props.onValueChange(true);
            ttsSwitch.props.onValueChange(true);
        });

        expect(onSetVoiceLocalUseDeviceStt).toHaveBeenCalledWith(true);
        expect(onSetVoiceLocalUseDeviceTts).toHaveBeenCalledWith(true);
    });

    it('hides STT endpoint fields when device STT is enabled', async () => {
        const { tree } = await renderWithProps({ voiceLocalUseDeviceStt: true });
        const items = tree.root.findAllByType('Item' as any);
        const titles = new Set(items.map((n: any) => n.props.title));

        expect(titles.has('settingsVoice.local.sttBaseUrl')).toBe(false);
        expect(titles.has('settingsVoice.local.sttApiKey')).toBe(false);
        expect(titles.has('settingsVoice.local.sttModel')).toBe(false);
    });

    it('hides TTS endpoint fields when device TTS is enabled', async () => {
        const { tree } = await renderWithProps({ voiceLocalUseDeviceTts: true });
        const items = tree.root.findAllByType('Item' as any);
        const titles = new Set(items.map((n: any) => n.props.title));

        expect(titles.has('settingsVoice.local.ttsBaseUrl')).toBe(false);
        expect(titles.has('settingsVoice.local.ttsApiKey')).toBe(false);
        expect(titles.has('settingsVoice.local.ttsModel')).toBe(false);
        expect(titles.has('settingsVoice.local.ttsVoice')).toBe(false);
        expect(titles.has('settingsVoice.local.ttsFormat')).toBe(false);
        expect(titles.has('settingsVoice.local.testTts')).toBe(true);
    });

    it('renders separate runtime, STT, and TTS groups for local voice settings', async () => {
        const { tree } = await renderWithProps();
        const groups = tree.root.findAllByType('ItemGroup' as any);
        const groupItemTitleSets = groups.map((group: any) => {
            const items = group.findAllByType('Item' as any);
            return new Set(items.map((item: any) => item.props.title));
        });

        const hasRuntimeGroup = groupItemTitleSets.some((titles) =>
            titles.has('settingsVoice.local.conversationMode')
        );
        const hasSttGroup = groupItemTitleSets.some((titles) =>
            titles.has('settingsVoice.local.deviceStt') && titles.has('settingsVoice.local.sttModel')
        );
        const hasTtsGroup = groupItemTitleSets.some((titles) =>
            titles.has('settingsVoice.local.deviceTts') && titles.has('settingsVoice.local.testTts')
        );

        expect(hasRuntimeGroup).toBe(true);
        expect(hasSttGroup).toBe(true);
        expect(hasTtsGroup).toBe(true);
    });
});
