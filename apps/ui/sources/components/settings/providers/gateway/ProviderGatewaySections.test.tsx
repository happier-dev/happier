import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

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
        reachability: 'unknown',
        onChangePlacement: vi.fn(),
        helperModels: undefined,
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
    it('leads to connecting an account for a vendor that has none, instead of an empty chooser', async () => {
        const onConnectService = vi.fn();
        const onChangeSlot = vi.fn();
        const screen = await render({ onConnectService, onChangeSlot });

        await screen.pressByTestIdAsync('provider-gateway-slot:openai-upstream:connect');
        expect(onConnectService).toHaveBeenCalledWith('happier.agent.codex/openai-codex');
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

    it('resolves the chosen computer from the saved placement, including one that is no longer listed', () => {
        expect(resolveProviderGatewayChosenMachine(undefined, MACHINES)).toBeNull();
        expect(resolveProviderGatewayChosenMachine({ kind: 'sessionMachine' }, MACHINES)).toBeNull();
        expect(resolveProviderGatewayChosenMachine({ kind: 'machine', machineId: 'studio' }, MACHINES))
            .toEqual({ machineId: 'studio', machine: MACHINES[1] });
        expect(resolveProviderGatewayChosenMachine({ kind: 'machine', machineId: 'gone' }, MACHINES))
            .toEqual({ machineId: 'gone', machine: null });
    });
});
