import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';
import type { ManagedProvisionerCard } from './managedMachineDisplay';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installSettingsViewCommonModuleMocks({ text: async () => vi.importActual<typeof import('@/text')>('@/text') });
// Load the real component graph at collection, outside the test's own timeout.
const { MachineProvisionerSections } = await import('./MachineProvisionerSections');
const { SelectionTiles } = await import('@/components/ui/forms/SelectionTiles');
afterEach(() => standardCleanup());

function card(id: string, action: ManagedProvisionerCard['action'], status: ManagedProvisionerCard['status']): ManagedProvisionerCard {
  const value = { id, title: id, kind: 'VM', description: `${id} machines`, mark: () => null, location: 'cloud' as const, acquire: 'account' as const, status, action };
  return value;
}

describe('MachineProvisionerSections when a card has no step to take', () => {
  it('draws no dead button and ignores presses; its status says what it needs', async () => {
    const onPress = vi.fn();
    const screen = await renderScreen(
      <MachineProvisionerSections
        compact={false}
        localTitle="On this machine"
        localDescription="Nothing to pay."
        testID="p"
        cards={[
          card('cua', { kind: 'choose', label: 'Choose', disabled: true, onPress }, { tone: 'none', label: 'Not installed' }),
          card('lima', { kind: 'choose', label: 'Choose', onPress: vi.fn() }, { tone: 'ready', label: 'Ready' }),
        ]}
      />,
    );
    expect(screen.findByTestId('p.cloud.cua.action')).toBeFalsy();
    expect(screen.findByTestId('p.cloud.lima.action')).toBeTruthy();
    expect(screen.getTextContent()).toContain('Not installed');
    await act(async () => { screen.tree.findByType(SelectionTiles).props.onPress('cua'); });
    expect(onPress).not.toHaveBeenCalled();
    await screen.unmount();
  });
});
