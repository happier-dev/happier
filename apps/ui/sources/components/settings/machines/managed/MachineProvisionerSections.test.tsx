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
// Module preparation is outside each presentation interaction's time budget.
const { MachineProvisionerSections } = await import('./MachineProvisionerSections');
afterEach(() => standardCleanup());

function card(
  id: string,
  action: ManagedProvisionerCard['action'],
  status: ManagedProvisionerCard['status'],
): ManagedProvisionerCard {
  return {
    id,
    title: id,
    description: `${id} machines`,
    mark: () => null,
    location: 'cloud',
    acquire: 'account',
    canSetUpHere: true,
    status,
    action,
  };
}

async function renderSections(
  compact: boolean,
  onHandoff: () => void,
  perCardHandoff = vi.fn(),
) {
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
        // A hand-off provider in a second group: the page still says it once (DESIGN-1114 row 10).
        { ...card('vercel', handoff, needsApp), enrollmentRole: 'sandbox' },
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
    it(`says it once for the page, with one Get the app, and keeps those cards quiet (${compact ? 'phone' : 'wide'})`, async () => {
      const onHandoff = vi.fn();
      const screen = await renderSections(compact, onHandoff);
      expect(screen.findByTestId('p.handoff')).toBeTruthy();
      expect(screen.findByTestId('p.cloud.handoff')).toBeFalsy();
      expect(screen.findByTestId('p.cloud-sandboxes.handoff')).toBeFalsy();
      // Only the card with its own next step keeps a button or status of its own.
      expect(screen.findByTestId('p.cloud.hetzner.action')).toBeFalsy();
      expect(screen.findByTestId('p.cloud-sandboxes.vercel.action')).toBeFalsy();
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
      await act(async () => screen.pressByTestId('p.handoff.action'));
      expect(onHandoff).toHaveBeenCalledTimes(1);
      await screen.unmount();
    });
  }
});

describe('MachineProvisionerSections order (lab m-add)', () => {
  for (const compact of [false, true]) {
    it(`groups computers, cloud sandboxes and cloud servers in order (${compact ? 'phone' : 'wide'})`, async () => {
      const choose = { kind: 'choose', label: 'Choose', onPress: vi.fn() } as const;
      const ready = { tone: 'ready', label: 'Ready' } as const;
      const screen = await renderScreen(
        <MachineProvisionerSections testID="p" compact={compact} localTitle="On this machine" localDescription=""
          cards={[card('hetzner', choose, ready), { ...card('vercel', choose, ready), enrollmentRole: 'sandbox' },
            { ...card('lima', choose, ready), location: 'local', acquire: 'daemon', enrollmentRole: 'sandbox' }]} />,
      );
      const order = screen.tree.root.findAll((node) => typeof node.type === 'string'
        && typeof node.props.testID === 'string' && /^p\.(local|cloud-sandboxes|cloud)\./.test(node.props.testID))
        .map((node) => (node.props.testID as string).split('.')[1]);
      expect(order[0]).toBe('local');
      expect([...new Set(order)]).toEqual(['local', 'cloud-sandboxes', 'cloud']);
      expect(screen.findByTestId('p.local.lima')).toBeTruthy();
      expect(screen.findByTestId('p.cloud-sandboxes.vercel')).toBeTruthy();
      expect(screen.findByTestId('p.cloud.hetzner')).toBeTruthy();
      await screen.unmount();
    });
  }
});

describe('MachineProvisionerSections repair failures', () => {
  it.each([false, true])('keeps the Action failure on its provider (compact=%s)', async compact => {
    const repair = { kind: 'repair', label: 'Get app', onPress: vi.fn() } as const;
    const missing = { tone: 'none', label: 'Not installed' } as const;
    const failure = { ok: false, code: 'unavailable', reason: 'external_link_unavailable',
      message: 'Installation instructions could not be opened.' } as const;
    const screen = await renderScreen(<MachineProvisionerSections testID="p" compact={compact}
      localTitle="On this machine" localDescription="" cards={[
        { ...card('docker', repair, missing), repairFailure: failure }, card('lima', repair, missing),
      ]} />);
    expect(screen.findByTestId('p.cloud.docker.repairFailure')).not.toBeNull();
    expect(screen.findByTestId('p.cloud.lima.repairFailure')).toBeNull();
    expect(screen.getTextContent()).toContain(failure.message);
    await screen.unmount();
  });
});
