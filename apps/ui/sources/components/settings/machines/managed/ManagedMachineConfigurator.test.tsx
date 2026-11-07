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
  modal.hide.mockClear();
});

async function renderConfigurator(onCreate: () => void, primaryLabel = 'Create server', primaryTestID?: string, tabBarHeight = 0, scopeChip?: React.ReactNode,
  extra?: Readonly<{ compact?: boolean; blocker?: import('./ManagedMachineConfigurator').ManagedConfiguratorBlocker; children?: React.ReactNode }>) {
  const { ManagedMachineConfigurator } =
    await import('./ManagedMachineConfigurator');
  const { SessionCockpitBottomChromeHeightContext } = await import('@/components/workspaceCockpit/session/SessionCockpitChromeRegistry');
  return renderScreen(
    <SessionCockpitBottomChromeHeightContext.Provider value={tabBarHeight}>
    <ManagedMachineConfigurator
      testID="cfg"
      title="New Hetzner server"
      description="Pick its size, system and place."
      mark={null}
      actions={scopeChip}
      compact={extra?.compact ?? true}
      blocker={extra?.blocker}
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
      {extra?.children ?? null}
    </ManagedMachineConfigurator>
    </SessionCockpitBottomChromeHeightContext.Provider>,
  );
}

describe('ManagedMachineConfigurator on a phone', () => {
  it('retires its protected receipt sheet when the configuration view is withdrawn', async () => {
    const screen = await renderConfigurator(vi.fn());
    await act(async () => screen.pressByTestId('cfg.summary'));
    expect(modal.hide).not.toHaveBeenCalled();
    await screen.unmount();
    expect(modal.hide).toHaveBeenCalledWith('sheet-1');
  });
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
  it('stands above the phone\u2019s floating tab bar instead of partly under it', async () => {
    const { StyleSheet } = await import('react-native');
    const screen = await renderConfigurator(vi.fn(), 'Create', undefined, 84);
    expect(Number(StyleSheet.flatten(screen.findByTestId('cfg.summary.frame')!.props.style)?.marginBottom)).toBeGreaterThanOrEqual(84);
    await screen.unmount();
  });
  it('keeps the managing machine in view as its own row, since the header folds its actions away on a phone', async () => {
    const { Text } = await import('react-native');
    const screen = await renderConfigurator(vi.fn(), 'Create', undefined, 0, <Text testID="cfg.chip">NLDW3 · 230d</Text>);
    const row = screen.findByTestId('cfg.scope');
    expect(row).toBeTruthy();
    expect(row!.findAll(node => node.props.testID === 'cfg.chip').length).toBeGreaterThan(0);
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

describe('ManagedMachineConfigurator with a blocker (R8-9)', () => {
  for (const compact of [true, false]) {
    it(`draws the blocker and its one action in the form column instead of choices that cannot be used (${compact ? 'phone' : 'wide'})`, async () => {
      const { Text } = await import('react-native');
      const onGetApp = vi.fn();
      const screen = await renderConfigurator(vi.fn(), 'Create server', undefined, 0, undefined, {
        compact,
        blocker: { kind: 'needsApp', title: 'Needs the app', reason: 'Hetzner can\u2019t be reached from a browser.',
          action: { label: 'Get the app', onPress: onGetApp } },
        children: <Text testID="cfg.choice">Size</Text>,
      });
      const blocker = screen.findByTestId('cfg.blocker');
      expect(blocker).toBeTruthy();
      type Node = { children: ReadonlyArray<Node | string> };
      const textOf = (node: Node): string => node.children.map(child => typeof child === 'string' ? child : textOf(child)).join('');
      const text = textOf(blocker as unknown as Node);
      expect(text).toContain('Needs the app');
      expect(text).toContain('Hetzner can\u2019t be reached from a browser.');
      expect(screen.findByTestId('cfg.choice')).toBeFalsy();
      await act(async () => screen.pressByTestId('cfg.blocker.action'));
      expect(onGetApp).toHaveBeenCalledTimes(1);
      await screen.unmount();
    });
  }
  it('keeps its choices when nothing blocks them', async () => {
    const { Text } = await import('react-native');
    const screen = await renderConfigurator(vi.fn(), 'Create server', undefined, 0, undefined, { children: <Text testID="cfg.choice">Size</Text> });
    expect(screen.findByTestId('cfg.choice')).toBeTruthy();
    expect(screen.findByTestId('cfg.blocker')).toBeFalsy();
    await screen.unmount();
  });
});
