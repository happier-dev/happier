import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const modal = vi.hoisted(() => ({
  show: vi.fn(() => 'sheet-1'),
  hide: vi.fn(),
}));

installSettingsViewCommonModuleMocks({
  text: async () => vi.importActual<typeof import('@/text')>('@/text'),
  // The modal host is the overlay boundary; the sheet's content is the real receipt.
  modal: async () => ({ Modal: modal }),
});
afterEach(() => {
  standardCleanup();
  modal.show.mockClear();
});

async function renderConfigurator(onCreate: () => void, primaryLabel = 'Create server', primaryTestID?: string) {
  const { ManagedMachineConfigurator } =
    await import('./ManagedMachineConfigurator');
  return renderScreen(
    <ManagedMachineConfigurator
      testID="cfg"
      title="New Hetzner server"
      description="Pick its size, system and place."
      mark={null}
      compact
      summary={{
        value: '€0.0119',
        unit: 'an hour',
        spec: 'CX32 · Falkenstein · until you delete it',
      }}
      receipt={{
        caption: 'Your new machine',
        mark: null,
        name: 'hz-build-2',
        spec: 'CX32 · 4 vCPU · 8 GB · 80 GB',
        facts: [],
        cost: { kind: 'unpriced', provider: 'Hetzner' },
        primary: { label: primaryLabel, onPress: onCreate, testID: primaryTestID },
      }}
    >
      {null}
    </ManagedMachineConfigurator>,
  );
}

describe('ManagedMachineConfigurator on a phone', () => {
  it('keeps the caller primary operation reachable with its public selector on compact and receipt paths', async () => {
    const onUse = vi.fn();
    const screen = await renderConfigurator(onUse, 'Use', 'managed-config.use');
    await act(async () => screen.pressByTestId('managed-config.use'));
    expect(onUse).toHaveBeenCalledTimes(1);
    await screen.unmount();
  });
  it('shows the reviewed primary operation on the phone summary action', async () => {
    const screen = await renderConfigurator(vi.fn(), 'Use');
    const actions = screen.tree.findAll(node => node.props.testID === 'cfg.summary.create' && typeof node.props.title === 'string');
    expect(actions.map(node => node.props.title)).toContain('Use');
    await screen.unmount();
  });
  it('opens the receipt as a sheet from the summary bar without creating anything', async () => {
    const onCreate = vi.fn();
    const screen = await renderConfigurator(onCreate);
    await act(async () => {
      screen.pressByTestId('cfg.summary');
    });
    expect(modal.show).toHaveBeenCalledTimes(1);
    expect(onCreate).not.toHaveBeenCalled();
    await act(async () => {
      screen.pressByTestId('cfg.summary.create');
    });
    expect(onCreate).toHaveBeenCalledTimes(1);
  });
});
