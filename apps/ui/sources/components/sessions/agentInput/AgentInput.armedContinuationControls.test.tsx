import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { getPermissionModeBadgeLabelForAgentType } from '@/sync/domains/permissions/permissionModeOptions';
import { installAgentInputAssetLoader, installAgentInputCommonModuleMocks } from './agentInputTestHelpers';

installAgentInputCommonModuleMocks({
    // Armed submit presentation consumes translated strings, not mock parameter bags.
    text: () => vi.importActual('@/text'),
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
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

vi.mock('expo-image', () => ({ Image: 'Image' }));
vi.mock('react-native-svg', () => ({ SvgXml: 'SvgXml' }));

const { AgentInput } = await import('./AgentInput');

beforeEach(installAgentInputAssetLoader);

describe('AgentInput armed continuation controls', () => {
    it('keeps Session safety intent but removes the source runtime mode editor while another Agent is armed', async () => {
        const onModeChange = vi.fn();
        const onPermissionChange = vi.fn();
        const props: React.ComponentProps<typeof AgentInput> = {
            value: 'continue',
            placeholder: '',
            onChangeText: () => {},
            onSend: () => {},
            agentType: 'codex',
            metadata: {
                path: '/repo',
                host: 'host',
                flavor: 'codex',
                sessionModeOverrideV1: { v: 1, updatedAt: 2, modeId: 'build' },
                sessionModesV1: { v: 1, updatedAt: 1, provider: 'codex', currentModeId: 'build', availableModes: [
                    { id: 'build', name: 'Build' }, { id: 'plan', name: 'Plan' },
                ] },
            },
            permissionMode: 'yolo',
            onPermissionModeChange: onPermissionChange,
            onAcpSessionModeChange: onModeChange,
            autocompleteKinds: [],
            autocompleteSuggestions: async () => [],
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
