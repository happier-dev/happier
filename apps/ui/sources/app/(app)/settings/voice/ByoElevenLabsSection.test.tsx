import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    Linking: { openURL: vi.fn() },
    Platform: { OS: 'web' },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

const { modalAlert } = vi.hoisted(() => ({
    modalAlert: vi.fn(),
}));

vi.mock('@/modal', () => ({
    Modal: { alert: modalAlert },
}));

vi.mock('@/voice/voiceProviders', () => ({
    VOICE_PROVIDER_IDS: {
        BYO_ELEVENLABS_AGENTS: 'byo_elevenlabs_agents',
    },
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: any) => React.createElement('ItemGroup', null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

describe('ByoElevenLabsSection', () => {
    it('renders nothing when voiceProviderId is not BYO ElevenLabs', async () => {
        const { ByoElevenLabsSection } = await import('./ByoElevenLabsSection');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <ByoElevenLabsSection
                    voiceProviderId="something_else"
                    byoConfigured={false}
                    isAutoprovCreating={false}
                    isAutoprovUpdating={false}
                    voiceByoElevenLabsAgentId={null}
                    hasByoApiKey={false}
                    onAutoprovCreate={vi.fn()}
                    onAutoprovUpdate={vi.fn()}
                    onSetAgentId={vi.fn()}
                    onSetApiKey={vi.fn()}
                    onDisconnect={vi.fn()}
                />
            );
        });

        expect(tree!.toJSON()).toBeNull();
    });

    it('disables autoprov actions when API key is not set', async () => {
        const { ByoElevenLabsSection } = await import('./ByoElevenLabsSection');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <ByoElevenLabsSection
                    voiceProviderId="byo_elevenlabs_agents"
                    byoConfigured={false}
                    isAutoprovCreating={false}
                    isAutoprovUpdating={false}
                    voiceByoElevenLabsAgentId={null}
                    hasByoApiKey={false}
                    onAutoprovCreate={vi.fn()}
                    onAutoprovUpdate={vi.fn()}
                    onSetAgentId={vi.fn()}
                    onSetApiKey={vi.fn()}
                    onDisconnect={vi.fn()}
                />
            );
        });

        const items = tree!.root.findAllByType('Item' as any);
        const byTitle = new Map(items.map((n: any) => [n.props.title, n.props]));

        expect(byTitle.get('settingsVoice.byo.autoprovCreate')?.disabled).toBe(true);
        expect(byTitle.get('settingsVoice.byo.autoprovUpdate')?.disabled).toBe(true);
    });

    it('enables create when API key is set and keeps update disabled until agent id exists', async () => {
        const { ByoElevenLabsSection } = await import('./ByoElevenLabsSection');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <ByoElevenLabsSection
                    voiceProviderId="byo_elevenlabs_agents"
                    byoConfigured={false}
                    isAutoprovCreating={false}
                    isAutoprovUpdating={false}
                    voiceByoElevenLabsAgentId={null}
                    hasByoApiKey
                    onAutoprovCreate={vi.fn()}
                    onAutoprovUpdate={vi.fn()}
                    onSetAgentId={vi.fn()}
                    onSetApiKey={vi.fn()}
                    onDisconnect={vi.fn()}
                />
            );
        });

        const items = tree!.root.findAllByType('Item' as any);
        const byTitle = new Map(items.map((n: any) => [n.props.title, n.props]));

        expect(byTitle.get('settingsVoice.byo.autoprovCreate')?.disabled).toBe(false);
        expect(byTitle.get('settingsVoice.byo.autoprovUpdate')?.disabled).toBe(true);
    });

    it('enables update when API key is set and agent id exists', async () => {
        const { ByoElevenLabsSection } = await import('./ByoElevenLabsSection');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <ByoElevenLabsSection
                    voiceProviderId="byo_elevenlabs_agents"
                    byoConfigured
                    isAutoprovCreating={false}
                    isAutoprovUpdating={false}
                    voiceByoElevenLabsAgentId="agent_123"
                    hasByoApiKey
                    onAutoprovCreate={vi.fn()}
                    onAutoprovUpdate={vi.fn()}
                    onSetAgentId={vi.fn()}
                    onSetApiKey={vi.fn()}
                    onDisconnect={vi.fn()}
                />
            );
        });

        const items = tree!.root.findAllByType('Item' as any);
        const byTitle = new Map(items.map((n: any) => [n.props.title, n.props]));

        expect(byTitle.get('settingsVoice.byo.autoprovUpdate')?.disabled).toBe(false);
    });

    it('shows guided API key setup instructions', async () => {
        const { ByoElevenLabsSection } = await import('./ByoElevenLabsSection');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <ByoElevenLabsSection
                    voiceProviderId="byo_elevenlabs_agents"
                    byoConfigured={false}
                    isAutoprovCreating={false}
                    isAutoprovUpdating={false}
                    voiceByoElevenLabsAgentId={null}
                    hasByoApiKey={false}
                    onAutoprovCreate={vi.fn()}
                    onAutoprovUpdate={vi.fn()}
                    onSetAgentId={vi.fn()}
                    onSetApiKey={vi.fn()}
                    onDisconnect={vi.fn()}
                />
            );
        });

        const items = tree!.root.findAllByType('Item' as any);
        const helpItem = items.find((n: any) => n.props.title === 'settingsVoice.byo.apiKeyHelp');
        expect(helpItem).toBeTruthy();

        act(() => {
            helpItem!.props.onPress();
        });

        expect(modalAlert).toHaveBeenCalledTimes(1);
    });
});
