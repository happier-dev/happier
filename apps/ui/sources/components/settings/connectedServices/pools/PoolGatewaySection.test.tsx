import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { PoolGatewaySection, type PoolGatewaySectionProps } from './PoolGatewaySection';
import type { PoolGatewayChoice } from './poolGatewayChoices';

const CLAUDE = { pluginId: 'happier.agent.claude', localId: 'claude-subscription' };
const LAB_POOL = { kind: 'group' as const, service: CLAUDE, groupId: 'lab-pool' };
const TEST_ID = 'pool:gateway';
const ROW = `${TEST_ID}:pc_gateway`;

type Screen = Awaited<ReturnType<typeof renderScreen>>;
async function flip(screen: Screen, testID: string, value: boolean) {
    await act(async () => { screen.findByTestId(testID)?.props.onValueChange(value); });
}

function choice(overrides: Partial<PoolGatewayChoice> = {}): PoolGatewayChoice {
    return {
        connectionId: 'pc_gateway' as PoolGatewayChoice['connectionId'], title: 'Main gateway', detailRoute: '/(app)/settings/providers/pc_gateway', revision: 3,
        purpose: 'anthropic-upstream', service: CLAUDE, enabled: false, replacementTarget: null, purposeBindingDefaults: {},
        ...overrides,
    };
}

function render(choices: readonly PoolGatewayChoice[], overrides: Partial<PoolGatewaySectionProps['usage']> = {}) {
    const setEnabled = vi.fn(async () => true);
    const onOpenGateway = vi.fn();
    const usage = {
        choices, setEnabled, refresh: vi.fn(async () => undefined), loading: false, ready: true, error: null, pending: false,
        ...overrides,
    } as PoolGatewaySectionProps['usage'];
    return renderScreen(
        <PoolGatewaySection
            testID={TEST_ID}
            usage={usage}
            poolTitle="Work pool"
            serviceLabel="Claude"
            nativeAgentTitles={['Claude Code']}
            presentTarget={() => 'Lab pool'}
            onOpenGateway={onOpenGateway}
        />,
    ).then((screen) => ({ screen, setEnabled, onOpenGateway }));
}

describe('PoolGatewaySection (lab rgateway PL1/PL2)', () => {
    it('writes the gateway slot when the slot is free', async () => {
        const { screen, setEnabled } = await render([choice()]);

        await flip(screen, `${ROW}:toggle`, true);
        expect(setEnabled).toHaveBeenCalledWith('pc_gateway', true);
        expect(screen.findByTestId(`${ROW}:replace`)).toBeNull();
    });

    it('asks before replacing another pool: the switch does not write until Switch is pressed, and Cancel writes nothing', async () => {
        const { screen, setEnabled } = await render([choice({ replacementTarget: LAB_POOL })]);

        await flip(screen, `${ROW}:toggle`, true);
        expect(setEnabled).not.toHaveBeenCalled();
        expect(screen.findByTestId(`${ROW}:replace`)).toBeTruthy();

        await screen.pressByTestIdAsync(`${ROW}:replace:cancel`);
        expect(screen.findByTestId(`${ROW}:replace`)).toBeNull();
        expect(setEnabled).not.toHaveBeenCalled();

        await flip(screen, `${ROW}:toggle`, true);
        await screen.pressByTestIdAsync(`${ROW}:replace:confirm`);
        expect(setEnabled).toHaveBeenCalledTimes(1);
        expect(setEnabled).toHaveBeenCalledWith('pc_gateway', true);
    });

    it('shows what changes and leads to the gateway only while this pool holds the slot, and clears it when switched off', async () => {
        const off = await render([choice()]);
        expect(off.screen.findByTestId(`${ROW}:comparison`)).toBeNull();
        expect(off.screen.findByTestId(`${ROW}:open`)).toBeNull();

        const on = await render([choice({ enabled: true })]);
        expect(on.screen.findByTestId(`${ROW}:comparison`)).toBeTruthy();
        await on.screen.pressByTestIdAsync(`${ROW}:open`);
        expect(on.onOpenGateway).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'pc_gateway' }));

        await flip(on.screen, `${ROW}:toggle`, false);
        expect(on.setEnabled).toHaveBeenCalledWith('pc_gateway', false);
    });

    it('draws nothing when no gateway can draw on this pool’s vendor', async () => {
        const { screen } = await render([]);
        expect(screen.findByTestId(ROW)).toBeNull();
        expect(screen.getTextContent()).toBe('');
    });
});
