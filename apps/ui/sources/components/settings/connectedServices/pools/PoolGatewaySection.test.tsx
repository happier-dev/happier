import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { renderScreen } from '@/dev/testkit';
import { t } from '@/text';

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
        purpose: 'anthropic-upstream', service: CLAUDE, enabled: false, gatewayOn: true, replacementTarget: null, purposeBindingDefaults: {},
        ...overrides,
    };
}

function render(choices: readonly PoolGatewayChoice[], overrides: Partial<PoolGatewaySectionProps['usage']> = {}) {
    const setEnabled = vi.fn(async () => true);
    const onOpenGateway = vi.fn();
    const usage: PoolGatewaySectionProps['usage'] = {
        choices, setEnabled, firstGateway: null, gatewayDraftRoute: () => null,
        gatewayContributionChoice: { status: 'unavailable', choices: [] }, retry: undefined,
        reviewCurrentState: async () => undefined,
        refresh: vi.fn(async () => undefined), loading: false, ready: true, error: null, pending: false, pendingApproval: null,
        ...overrides,
    };
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

    it('delegates replacement of another pool to the gateway Action without a second inline gate', async () => {
        const { screen, setEnabled } = await render([choice({ replacementTarget: LAB_POOL })]);

        await flip(screen, `${ROW}:toggle`, true);
        expect(screen.findByTestId(`${ROW}:replace`)).toBeNull();
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

    it('reads off while its gateway is off, says so, and leads to the gateway\'s one switch', async () => {
        const { screen, onOpenGateway } = await render([choice({ enabled: true, gatewayOn: false })]);
        const toggle = screen.findByTestId(`${ROW}:toggle`);
        expect(toggle?.props.value).toBe(false);
        expect(toggle?.props.disabled).toBe(true);
        expect(screen.getTextContent()).toContain(t('settingsProvidersCollection.gateway.poolSwitchGatewayOff', { gateway: 'Main gateway' }));
        expect(screen.findByTestId(`${ROW}:comparison`)).toBeNull();
        await screen.pressByTestIdAsync(`${ROW}:open`);
        expect(onOpenGateway).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'pc_gateway' }));
    });

    it('waits for the Account catalog without saying a machine is needed (D11)', async () => {
        const { screen } = await render([choice()], { ready: false });
        expect(screen.getTextContent()).not.toMatch(/poolSwitchNeedsComputer|needs to be online/);
        const toggle = screen.findByTestId(`${ROW}:toggle`);
        expect(toggle?.props.disabled).toBe(true);
    });
    it('draws nothing when no gateway can draw on this pool’s vendor', async () => {
        const { screen } = await render([]);
        expect(screen.findByTestId(ROW)).toBeNull();
        expect(screen.getTextContent()).toBe('');
    });
    it('keeps the failure and its Retry on screen when the choice list has gone empty', async () => {
        const retry = vi.fn(async () => undefined);
        const { screen } = await render([], { error: createProviderErrorV1('provider_catalog_unavailable'), retry } as never);
        await act(async () => { await screen.pressByTestIdAsync('provider-error-action:provider_catalog_unavailable'); });
        expect(retry).toHaveBeenCalledTimes(1);
    });
});
