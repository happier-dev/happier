import * as React from 'react';
import { Text } from 'react-native';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installConnectedServicesCommonModuleMocks } from '../connectedServicesTestHelpers';
import { ConnectedServicesGatewaysGroup } from './ConnectedServicesGatewaysGroup';

installConnectedServicesCommonModuleMocks();
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);

describe('ConnectedServicesGatewaysGroup', () => {
  it('offers one row that adds the first gateway', async () => {
    const add = vi.fn();
    const screen = await renderScreen(
      <ConnectedServicesGatewaysGroup
        gateways={[]}
        onOpen={vi.fn()}
        onAdd={add}
      />,
    );
    await screen.pressByTestIdAsync('connected-services-index:add-gateway');
    expect(add).toHaveBeenCalledOnce();
  });

  it('shows a pending approval where the gateway was added, in place of the add row', async () => {
    const screen = await renderScreen(
      <ConnectedServicesGatewaysGroup
        gateways={[]}
        onOpen={vi.fn()}
        onAdd={vi.fn()}
        adding
        approval={<Text testID="gateway-approval">Waiting</Text>}
      />,
    );
    expect(screen.findHostByTestId('gateway-approval') !== null).toBe(true);
    expect(
      screen.findHostByTestId('connected-services-index:add-gateway') !== null,
    ).toBe(false);
  });

  it('keeps its place when the gateways cannot be read, and retries from there', async () => {
    const retry = vi.fn();
    const screen = await renderScreen(
      <ConnectedServicesGatewaysGroup gateways={[]} onOpen={vi.fn()}
        unavailable={{ diagnosticCode: 'encryption-material-unavailable', onRetry: retry }} />,
    );
    expect(screen.findHostByTestId('connected-services-index:gateways-unavailable') !== null).toBe(true);
    await screen.pressByTestIdAsync('connected-services-index:gateways-unavailable.retry');
    expect(retry).toHaveBeenCalledOnce();
  });

  it('says what each gateway draws on, and holds its place while the gateways load', async () => {
    const listed = await renderScreen(
      <ConnectedServicesGatewaysGroup
        gateways={[{ connectionId: 'pc_gateway', title: 'Main gateway', detailRoute: '/x', revision: 1, slotServices: [], summary: 'Claude · ChatGPT', agents: [], enabled: true }]}
        onOpen={vi.fn()}
      />,
    );
    expect(listed.getTextContent()).toContain('Claude · ChatGPT');

    const loading = await renderScreen(
      <ConnectedServicesGatewaysGroup gateways={[]} loading onOpen={vi.fn()} />,
    );
    expect(loading.findHostByTestId('connected-services-index:gateways-loading') !== null).toBe(true);
    expect(loading.findHostByTestId('connected-services-index:add-gateway') !== null).toBe(false);
  });
});
