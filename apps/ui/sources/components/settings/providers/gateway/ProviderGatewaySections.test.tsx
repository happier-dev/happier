import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

import { ProviderGatewaySections, resolveProviderGatewayChosenMachine, type ProviderGatewaySectionsProps } from './ProviderGatewaySections';

const CODEX = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
const MACHINES = [
    { machineId: 'laptop', displayName: 'MacBook Pro', online: true },
    { machineId: 'studio', displayName: 'Studio', online: false },
];

function render(overrides: Partial<ProviderGatewaySectionsProps> = {}) {
    const props: ProviderGatewaySectionsProps = {
        localizedTextPluginId: 'happier.provider.cliproxyapi',
        declarations: [{ purpose: 'openai-upstream', service: CODEX, required: false }],
        slots: {},
        onChangeSlot: vi.fn(),
        onConnectService: vi.fn(),
        placement: undefined,
        machines: MACHINES,
        reachability: 'not_checked',
        onChangePlacement: vi.fn(),
        helperModels: undefined,
        modelRoles: [],
        models: [{ id: 'gpt-6.1-luna', name: 'GPT-6.1 Luna' }],
        onChangeHelperModels: vi.fn(),
        disabled: false,
        pickerRows: null,
        nameRow: null,
        ...overrides,
    };
    return renderScreen(<ProviderGatewaySections {...props} />);
}

describe('ProviderGatewaySections (lab rgateway GW1/GW2)', () => {
    it('renders contributed model roles without substituting a host role list', async () => {
        const screen = await render({ modelRoles: [{ id: 'reviewer', title: 'Code reviewer' }] });
        expect(screen.findByTestId('provider-gateway-helper:reviewer')).toBeTruthy();
        expect(screen.findByTestId('provider-gateway-helper:fast')).toBeNull();
        expect(screen.getTextContent()).toContain('Code reviewer');
    });

    it('leads to connecting an account for a vendor that has none, instead of an empty chooser', async () => {
        const onConnectService = vi.fn();
        const onChangeSlot = vi.fn();
        const screen = await render({ onConnectService, onChangeSlot });

        const trigger = { getBoundingClientRect: () => ({ left: 30, top: 40, width: 24, height: 24 }) };
        await act(async () => { screen.findByTestId('provider-gateway-slot:openai-upstream:connect')!.props.onPress({ currentTarget: trigger }); });
        expect(onConnectService).toHaveBeenCalledWith('happier.agent.codex/openai-codex', { kind: 'view', ref: { current: trigger } });
        expect(onChangeSlot).not.toHaveBeenCalled();
    });

    it('saves "A chosen computer" only once a computer is chosen, and returns to each session’s computer in one step', async () => {
        const onChangePlacement = vi.fn();
        const unsaved = await render({ onChangePlacement });
        expect(unsaved.findByTestId('provider-gateway-computer')).toBeNull();

        await unsaved.pressByTestIdAsync('provider-gateway-placement:machine');
        expect(unsaved.findByTestId('provider-gateway-computer')).toBeTruthy();
        expect(onChangePlacement).not.toHaveBeenCalled();

        // Backing out of an unsaved choice writes nothing either.
        await unsaved.pressByTestIdAsync('provider-gateway-placement:sessionMachine');
        expect(unsaved.findByTestId('provider-gateway-computer')).toBeNull();
        expect(onChangePlacement).not.toHaveBeenCalled();

        const saved = await render({ onChangePlacement, placement: { kind: 'machine', machineId: 'studio' } });
        expect(saved.findByTestId('provider-gateway-computer')).toBeTruthy();
        await saved.pressByTestIdAsync('provider-gateway-placement:sessionMachine');
        expect(onChangePlacement).toHaveBeenCalledTimes(1);
        expect(onChangePlacement).toHaveBeenCalledWith(null);
    });

    it('shows the Model picker section only when the page supplies its rows (a draft has none)', async () => {
        const draft = await render({ pickerRows: null });
        expect(draft.getTextContent()).not.toContain('Model picker');

        const saved = await render({ pickerRows: React.createElement('Text', { testID: 'picker-row' }, 'Models') });
        expect(saved.getTextContent()).toContain('Model picker');
        expect(saved.findByTestId('picker-row')).toBeTruthy();
    });

    it('resolves the chosen computer from the saved placement, including one that is no longer listed', () => {
        expect(resolveProviderGatewayChosenMachine(undefined, MACHINES)).toBeNull();
        expect(resolveProviderGatewayChosenMachine({ kind: 'sessionMachine' }, MACHINES)).toBeNull();
        expect(resolveProviderGatewayChosenMachine({ kind: 'machine', machineId: 'studio' }, MACHINES))
            .toEqual({ machineId: 'studio', machine: MACHINES[1] });
        expect(resolveProviderGatewayChosenMachine({ kind: 'machine', machineId: 'gone' }, MACHINES))
            .toEqual({ machineId: 'gone', machine: null });
    });
});
