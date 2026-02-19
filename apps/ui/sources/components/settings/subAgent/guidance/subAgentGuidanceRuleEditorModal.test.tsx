import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: 'View',
    ScrollView: 'ScrollView',
    Pressable: 'Pressable',
    TextInput: 'TextInput',
    Text: 'Text',
    Platform: { OS: 'web', select: (opt: any) => opt?.default },
    useWindowDimensions: () => ({ width: 1200, height: 800, scale: 1, fontScale: 1 }),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                textSecondary: '#999',
                text: '#111',
                textLink: '#00f',
                textDestructive: '#f00',
                surface: '#fff',
                surfaceHigh: '#fafafa',
                divider: '#eee',
                input: { background: '#f7f7f7', placeholder: '#aaa' },
                shadow: { color: '#000' },
            },
        },
    }),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: (props: any) => React.createElement('Switch', props),
}));

vi.mock('@/components/ui/text/StyledText', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: (props: any) => React.createElement('RoundButton', props),
}));

vi.mock('@/agents/hooks/useEnabledAgentIds', () => ({
    useEnabledAgentIds: () => ['claude'],
}));

vi.mock('@/agents/catalog/catalog', () => ({
    getAgentCore: () => ({ displayNameKey: 'agent.claude' }),
    isAgentId: () => true,
    DEFAULT_AGENT_ID: 'claude',
}));

vi.mock('@/components/sessions/new/hooks/screenModel/useNewSessionPreflightModelsState', () => ({
    useNewSessionPreflightModelsState: () => ({
        preflightModels: null,
        modelOptions: [{ value: 'model1', label: 'Model 1', description: 'Default' }],
        probe: { phase: 'idle', refreshedAt: null, refresh: () => {} },
    }),
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverId: 'server-1' }),
}));

vi.mock('@/sync/store/hooks', () => ({
    useAllMachines: () => [],
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSetting: () => [],
}));

vi.mock('@/components/settings/pickers/resolvePreferredMachineId', () => ({
    resolvePreferredMachineId: () => null,
}));

vi.mock('@/text', () => ({
    t: () => 'Claude',
}));

describe('SubAgentGuidanceRuleEditorModal', () => {
    it('disables Save when description is empty', async () => {
        const onResolve = vi.fn();
        const onClose = vi.fn();

        const { SubAgentGuidanceRuleEditorModal } = await import('./subAgentGuidanceRuleEditorModal');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                React.createElement(SubAgentGuidanceRuleEditorModal, {
                    mode: 'create',
                    entry: { id: 'guidance_1', description: '', enabled: true },
                    onResolve,
                    onClose,
                }),
            );
        });

        const buttons = tree!.root.findAllByType('RoundButton' as any);
        const saveButton = buttons.find((b: any) => b.props?.title === 'Save');

        expect(saveButton).toBeTruthy();
        expect(saveButton!.props.disabled).toBe(true);

        await act(async () => {
            saveButton!.props.onPress?.();
        });

        expect(onResolve).not.toHaveBeenCalled();
    });

    it('calls onResolve(save) when description is present', async () => {
        const onResolve = vi.fn();
        const onClose = vi.fn();

        const { SubAgentGuidanceRuleEditorModal } = await import('./subAgentGuidanceRuleEditorModal');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                React.createElement(SubAgentGuidanceRuleEditorModal, {
                    mode: 'create',
                    entry: { id: 'guidance_2', description: 'Delegate UI tasks', enabled: true },
                    onResolve,
                    onClose,
                }),
            );
        });

        const buttons = tree!.root.findAllByType('RoundButton' as any);
        const saveButton = buttons.find((b: any) => b.props?.title === 'Save');

        expect(saveButton).toBeTruthy();
        expect(saveButton!.props.disabled).toBe(false);

        await act(async () => {
            saveButton!.props.onPress?.();
        });

        expect(onResolve).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: 'save',
                entry: expect.objectContaining({
                    id: 'guidance_2',
                    description: 'Delegate UI tasks',
                }),
            }),
        );
    });
});
