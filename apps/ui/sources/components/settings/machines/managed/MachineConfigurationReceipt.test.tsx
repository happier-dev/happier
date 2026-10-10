import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MachineRetentionPolicyV1 } from '@happier-dev/protocol/account/settings/machineRetentionDefaultsV1';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

installSettingsViewCommonModuleMocks({
  text: async () => vi.importActual<typeof import('@/text')>('@/text'),
});
afterEach(() => standardCleanup());

const HOUR = 3_600_000;
const untilDelete: MachineRetentionPolicyV1 = {
  retention: { kind: 'until-delete' },
  wakeOnAcceptedMessage: false,
};
const stopAfterHour: MachineRetentionPolicyV1 = {
  retention: { kind: 'unused', afterMs: HOUR, effect: 'stop' },
  wakeOnAcceptedMessage: true,
};

async function renderReceipt(
  model: Partial<import('./MachineConfigurationReceipt').ManagedReceiptModel>,
) {
  const { MachineConfigurationReceipt } =
    await import('./MachineConfigurationReceipt');
  return renderScreen(
    <MachineConfigurationReceipt
      testID="receipt"
      model={{
        caption: 'Your new machine',
        mark: null,
        name: 'hz-build-2',
        spec: 'CX32 · 4 vCPU · 8 GB · 80 GB',
        facts: [],
        cost: { kind: 'unpriced', provider: 'Crabbox' },
        ...model,
      }}
    />,
  );
}

function textContent(
  screen: Awaited<ReturnType<typeof renderReceipt>>,
  testID: string,
): string {
  const node = screen.findByTestId(testID);
  const parts: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === 'string' || typeof value === 'number')
      parts.push(String(value));
    else if (Array.isArray(value)) value.forEach(walk);
    else if (
      value &&
      typeof value === 'object' &&
      'children' in (value as object)
    )
      walk((value as { children: unknown }).children);
  };
  walk(node?.children);
  return parts.join(' ');
}

describe('MachineConfigurationReceipt', () => {
  it('never presents an unknown price as free and states a returned price with when it was checked', async () => {
    const unpriced = await renderReceipt({
      cost: { kind: 'unpriced', provider: 'Crabbox' },
    });
    expect(textContent(unpriced, 'receipt:cost')).toContain(
      'Price unavailable · billed directly by Crabbox',
    );
    expect(textContent(unpriced, 'receipt:cost')).not.toContain('No bill');
    unpriced.unmount();

    const priced = await renderReceipt({
      cost: {
        kind: 'price',
        prices: [{
          amount: '0.0119',
          currency: 'EUR',
          unit: 'hour',
          source: 'Hetzner',
          observedAt: Date.UTC(2026, 9, 8, 10, 40),
        }, {
          amount: '7.49',
          currency: 'EUR',
          unit: 'month',
          source: 'native-monthly-source',
          observedAt: Date.UTC(2026, 9, 8, 10, 41),
        }],
      },
    });
    const cost = textContent(priced, 'receipt:cost');
    expect(cost).toContain('0.0119');
    expect(cost).toContain('an hour');
    expect(cost).toContain('a month');
    expect(cost).toContain('Price from Hetzner');
    expect(cost).toContain('native-monthly-source');
  });

  it('leads with one hero price, says the same machine\'s monthly price as a sentence, and names one source once', async () => {
    const { t } = await import('@/text');
    const { formatProviderAmount } = await import('./managedMachineDisplay');
    const observedAt = Date.UTC(2026, 9, 8, 10, 40);
    const screen = await renderReceipt({ cost: { kind: 'price', prices: [
      { amount: '0.0119', currency: 'EUR', unit: 'hour', source: 'Hetzner', observedAt },
      { amount: '7.49', currency: 'EUR', unit: 'month', source: 'Hetzner', observedAt },
    ] } });
    const cost = textContent(screen, 'receipt:cost');
    expect(cost).toContain(t('managedMachines.price.aboutMonthly', { amount: formatProviderAmount({ amount: '7.49', currency: 'EUR' }) }));
    expect(cost.split('Hetzner').length - 1).toBe(1);
    await screen.unmount();
  });

  it('shows all native line-item labels, exact prices, units and provenance without calculating a total', async () => {
    const prices = [
      { label: 'Compute', amount: '0.0119', currency: 'EUR', unit: 'hour', source: 'native-compute', observedAt: Date.UTC(2026, 9, 8, 10, 40) },
      { label: 'Primary IPv4', amount: '0.0008', currency: 'EUR', unit: 'hour', source: 'native-network', observedAt: Date.UTC(2026, 9, 8, 10, 41) },
      { label: 'Primary IPv4', amount: '0.50', currency: 'EUR', unit: 'month', source: 'native-network-monthly', observedAt: Date.UTC(2026, 9, 8, 10, 42) },
      { label: 'Volume', amount: '0.04', currency: 'USD', unit: 'GiB-month', source: 'native-storage', observedAt: Date.UTC(2026, 9, 8, 10, 43) },
    ];
    const screen = await renderReceipt({ cost: { kind: 'price', prices: [prices[0]!, ...prices.slice(1)] } });
    const cost = textContent(screen, 'receipt:cost');
    for (const price of prices) {
      expect(cost).toContain(price.label);
      expect(cost).toContain(price.amount);
      expect(cost).toContain(price.source);
    }
    expect(cost).toContain('GiB-month');
    expect(cost).toContain('$');
    expect(cost).toContain('€');
    expect(cost).not.toContain('0.0127');
    await screen.unmount();
  });

  it('offers explicit wake for Until-delete while its inherited default stays off and Delete disables wake', async () => {
    const changes: MachineRetentionPolicyV1[] = [];
    const resets: number[] = [];
    const screen = await renderReceipt({
      keep: {
        policy: untilDelete,
        defaultPolicy: untilDelete,
        inherited: true,
        categoryLabel: 'Cloud billed while stopped',
        consequence: (retention) =>
          retention.kind === 'until-delete'
            ? 'It keeps running, and billing, until you delete it.'
            : 'Hetzner still bills stopped servers.',
        onChange: (policy) => { changes.push(policy); },
        onReset: () => resets.push(1),
      },
    });
    for (const id of ['until-delete', 'unused:stop:3600000', 'unused:delete:3600000']) {
      expect(screen.findByTestId(`receipt:keep:choice:${id}`)).not.toBeNull();
    }
    // Until-delete can be stopped manually; its category default leaves wake off until chosen.
    expect(screen.findByTestId('receipt:keep:reset')).toBeNull();
    const wake = screen.tree.findAll(node => node.props.testID === 'receipt:keep:wake:switch'
      && typeof node.props.onValueChange === 'function')[0];
    expect(wake?.props.value).toBe(false);
    await act(async () => wake?.props.onValueChange(true));
    expect(changes.at(-1)).toEqual({ ...untilDelete, wakeOnAcceptedMessage: true });

    await act(async () => {
      screen.pressByTestId('receipt:keep:choice:unused:stop:3600000');
    });
    expect(changes.at(-1)).toEqual(stopAfterHour);
    await act(async () => {
      screen.pressByTestId('receipt:keep:choice:unused:delete:3600000');
    });
    expect(changes.at(-1)).toEqual({
      retention: { kind: 'unused', afterMs: HOUR, effect: 'delete' },
      wakeOnAcceptedMessage: false,
    });
  });

  it('shows wake and Reset to default for an explicit Stop override', async () => {
    const resets: number[] = [];
    const screen = await renderReceipt({
      keep: {
        policy: stopAfterHour,
        defaultPolicy: untilDelete,
        inherited: false,
        consequence: () => 'Hetzner still bills stopped servers.',
        onChange: vi.fn(),
        onReset: () => resets.push(1),
      },
    });
    expect(screen.findByTestId('receipt:keep:wake:switch')).not.toBeNull();
    await act(async () => {
      screen.pressByTestId('receipt:keep:reset');
    });
    expect(resets).toEqual([1]);
  });
});
