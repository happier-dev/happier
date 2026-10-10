import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installAgentInputCommonModuleMocks } from './agentInputTestHelpers';

installAgentInputCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key, params) => `${key}${params?.agent ? ` ${params.agent}` : ''}` });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        const { settingsDefaults } = await import('@/sync/domains/settings/settings');
        return createStorageModuleStub({
            useSessionProjectScmSnapshot: () => null,
            useSetting: (key: keyof typeof settingsDefaults) => ({
                ...settingsDefaults,
                agentInputActionBarLayout: 'wrap',
                agentInputChipDensity: 'labels',
            })[key],
        });
    },
});

vi.mock('@/agents/registry/AgentIcon', () => ({
    AgentIcon: (props: Record<string, unknown>) => React.createElement('AgentIcon', props),
}));
vi.mock('expo-image', () => ({ Image: 'Image' }));
vi.mock('react-native-svg', () => ({ SvgXml: 'SvgXml', Svg: 'Svg', Circle: 'Circle' }));

const { AgentInput } = await import('./AgentInput');
const { getPermissionModeBadgeLabelForAgentType } = await import('@/sync/domains/permissions/permissionModeOptions');

describe('AgentInput armed continuation controls', () => {
    it('shows safety intent once when its editable control is already in the action row', async () => {
        const props: React.ComponentProps<typeof AgentInput> = {
            value: '', placeholder: '', onChangeText: () => {}, onSend: () => {},
            agentType: 'codex', permissionMode: 'yolo',
            metadata: { path: '/repo', host: 'host', flavor: 'codex' },
            autocompleteKinds: [], autocompleteSuggestions: async () => [],
        };
        const screen = await renderScreen(<AgentInput {...props} />);
        const label = getPermissionModeBadgeLabelForAgentType('codex', 'yolo');
        const visibleLabels = () => screen.findAll((node) => typeof node.type === 'string' && node.props.children === label);
        expect(visibleLabels()).toHaveLength(1);
        await screen.update(<AgentInput {...props} onPermissionModeChange={() => {}} />);
        expect(screen.findByTestId('agent-input-permission-chip')).not.toBeNull();
        expect(visibleLabels()).toHaveLength(1);
        await screen.unmount();
    });

    it('opens the existing machine picker from an unavailable target recovery action', async () => {
        const onMachineClick = vi.fn();
        const screen = await renderScreen(<AgentInput
            value="" placeholder="" onChangeText={() => {}} onSend={() => {}}
            autocompleteKinds={[]} autocompleteSuggestions={async () => []}
            onMachineClick={onMachineClick}
            connectionStatus={{ text: 'Selected machine unavailable', color: 'rose', dotColor: 'rose', recovery: 'machine' }}
        />);
        const action = screen.findByTestId('agent-input-connection-recovery');
        expect(action).not.toBeNull();
        await screen.pressByTestIdAsync('agent-input-connection-recovery');
        expect(onMachineClick).toHaveBeenCalledTimes(1);
        await screen.unmount();
    });

    it('keeps Session safety intent but removes the source runtime mode editor while another Agent is armed', async () => {
        const onModeChange = vi.fn();
        const props: React.ComponentProps<typeof AgentInput> = {
            value: 'continue', placeholder: '', onChangeText: () => {}, onSend: () => {},
            agentType: 'codex',
            metadata: {
                path: '/repo', host: 'host', flavor: 'codex',
                sessionModesV1: { v: 1, updatedAt: 1, agentId: 'codex', currentModeId: 'build', availableModes: [
                    { id: 'build', name: 'Build' }, { id: 'plan', name: 'Plan' },
                ] },
            },
            permissionMode: 'yolo', onPermissionModeChange: () => {}, onAcpSessionModeChange: onModeChange,
            autocompleteKinds: [], autocompleteSuggestions: async () => [],
        };
        const screen = await renderScreen(<AgentInput {...props} />);
        expect(screen.findByTestId('agent-input-session-mode-chip-label:build')).not.toBeNull();
        await screen.update(<AgentInput {...props} armedContinuationTarget={{ agentId: 'claude', label: 'Claude' }} />);
        expect(screen.findByTestId('agent-input-session-mode-chip-label:build')).toBeNull();
        const permission = screen.findByTestId('agent-input-permission-chip');
        expect(permission).not.toBeNull();
        expect(permission?.findAll((node) => node.props.children === getPermissionModeBadgeLabelForAgentType('claude', 'yolo')).length).toBeGreaterThan(0);
        expect(onModeChange).not.toHaveBeenCalled();
        await screen.update(<AgentInput {...props} />);
        expect(screen.findByTestId('agent-input-session-mode-chip-label:build')).not.toBeNull();
        await screen.unmount();
    });
});
