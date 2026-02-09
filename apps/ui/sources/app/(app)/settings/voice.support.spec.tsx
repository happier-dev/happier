import React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const setVoiceProviderId = vi.fn();

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: { colors: {} } }),
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
        alert: vi.fn(),
    },
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        decryptSecretValue: () => null,
        encryptSecretValue: () => ({ _isSecretValue: true, encryptedValue: { t: 'enc-v1', c: 'x' } }),
    },
}));

vi.mock('@/hooks/server/useHappierVoiceSupport', () => ({
    useHappierVoiceSupport: () => false,
}));

vi.mock('@/constants/Languages', () => ({
    LANGUAGES: [{ code: 'en', name: 'English' }],
    findLanguageByCode: () => ({ code: 'en', name: 'English' }),
    getLanguageDisplayName: () => 'English',
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

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: ({ trigger }: any) => (typeof trigger === 'function'
        ? trigger({ open: false, toggle: () => {}, openMenu: () => {}, closeMenu: () => {} })
        : trigger) ?? null,
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: (props: any) => React.createElement('Switch', props),
}));

vi.mock('@/agents/hooks/useEnabledAgentIds', () => ({
    useEnabledAgentIds: () => ['claude', 'codex', 'opencode'],
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSettingMutable: (key: string) => {
        switch (key) {
            case 'voiceAssistantLanguage':
                return ['en', vi.fn()];
            case 'voiceProviderId':
                return ['happier_elevenlabs_agents', setVoiceProviderId];
            case 'voiceByoElevenLabsAgentId':
                return [null, vi.fn()];
            case 'voiceByoElevenLabsApiKey':
                return [null, vi.fn()];
            default:
                return [null, vi.fn()];
        }
    },
}));

describe('VoiceSettingsScreen (server voice unsupported)', () => {
    it('hides Happier Voice option and coerces mode to off', async () => {
        const VoiceSettingsScreen = (await import('./voice')).default;

        let tree!: ReactTestRenderer;
        act(() => {
            tree = renderer.create(React.createElement(VoiceSettingsScreen));
        });

        await act(async () => {});

        const items = tree.root.findAllByType('Item' as any);
        const titles = items.map((i: any) => i.props.title);

        expect(titles).toContain('settingsVoice.mode.off');
        expect(titles).toContain('settingsVoice.mode.local');
        expect(titles).toContain('settingsVoice.mode.byo');
        expect(titles).not.toContain('settingsVoice.mode.happier');
        expect(setVoiceProviderId).toHaveBeenCalledWith('off');
    });
});
