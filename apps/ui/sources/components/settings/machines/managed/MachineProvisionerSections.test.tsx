import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';
import type { ManagedProvisionerCard } from './managedMachineDisplay';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

installSettingsViewCommonModuleMocks({
  text: async () => vi.importActual<typeof import('@/text')>('@/text'),
});
afterEach(() => standardCleanup());

function card(
  id: string,
  action: ManagedProvisionerCard['action'],
  status: ManagedProvisionerCard['status'],
): ManagedProvisionerCard {
  return {
    id,
    title: id,
    kind: 'VM',
    description: `${id} machines`,
    mark: () => null,
    location: 'cloud',
    acquire: 'account',
    status,
    action,
  };
}

async function renderSections(
  compact: boolean,
  onHandoff: () => void,
  perCardHandoff = vi.fn(),
) {
  const { MachineProvisionerSections } =
    await import('./MachineProvisionerSections');
  const needsApp = { tone: 'none', label: 'Needs the app' } as const;
  const handoff = {
    kind: 'handoff',
    label: 'Get the app',
    onPress: perCardHandoff,
  } as const;
  return renderScreen(
    <MachineProvisionerSections
      testID="p"
      compact={compact}
      localTitle="On this machine"
      localDescription=""
      onHandoff={onHandoff}
      cards={[
        card('hetzner', handoff, needsApp),
        card('vercel', handoff, needsApp),
        card(
          'crabbox',
          { kind: 'choose', label: 'Connect', onPress: vi.fn() },
          { tone: 'none', label: 'No account yet' },
        ),
      ]}
    />,
  );
}

describe('MachineProvisionerSections when the browser cannot reach a provider (R8-8)', () => {
  for (const compact of [false, true]) {
    it(`says it once for the group, with one Get the app, and keeps those cards quiet (${compact ? 'phone' : 'wide'})`, async () => {
      const onHandoff = vi.fn();
      const screen = await renderSections(compact, onHandoff);
      expect(screen.findByTestId('p.cloud.handoff')).toBeTruthy();
      // Only the card with its own next step keeps a button or status of its own.
      expect(screen.findByTestId('p.cloud.hetzner.action')).toBeFalsy();
      expect(screen.findByTestId('p.cloud.vercel.action')).toBeFalsy();
      if (!compact)
        expect(screen.findByTestId('p.cloud.crabbox.action')).toBeTruthy();
      type Node = { children: ReadonlyArray<Node | string> };
      const textOf = (node: Node): string =>
        node.children
          .map((child) => (typeof child === 'string' ? child : textOf(child)))
          .join('');
      const page = textOf(screen.tree.root as unknown as Node);
      expect(page.split('Needs the app').length - 1).toBe(1);
      expect(page).toContain('No account yet');
      await act(async () => screen.pressByTestId('p.cloud.handoff.action'));
      expect(onHandoff).toHaveBeenCalledTimes(1);
      await screen.unmount();
    });
  }
});
