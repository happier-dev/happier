import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { MachineCliSignInRow } from '@/agents/machineAgents/signIn/useAgentSignIn';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key) => key });
});

const { MachineSignInsList } = await import('./MachineSignInsSection');

afterEach(() => standardCleanup());

function row(
  overrides: Partial<NonNullable<MachineCliSignInRow['authentication']>> = {},
): MachineCliSignInRow {
  return {
    id: 'happier.scm.forge.github/gh',
    title: 'GitHub CLI',
    kind: 'systemTool',
    connectedLaunch: {
      purpose: { consumer: { pluginId: 'happier.scm.forge.github', localId: 'gh' }, purpose: 'github.cli' },
      service: { pluginId: 'happier.scm.forge.github', localId: 'github-account' },
    },
    signIn: { phase: 'idle' } as MachineCliSignInRow['signIn'],
    authentication: {
      status: 'signedOut',
      installed: true,
      nativeLogin: 'login_terminal',
      connectedServices: [
        {
          serviceId: 'happier.scm.forge.github/github-account',
          title: 'GitHub',
        },
      ],
      ...overrides,
    },
  };
}

describe('Machine sign-ins (E U4)', () => {
  it('offers the connected account beside this machine’s own sign-in, each through its owner', async () => {
    const onSignIn = vi.fn();
    const onUseConnected = vi.fn();
    const screen = await renderScreen(
      <MachineSignInsList
        serverId="home"
        machineId="devbox"
        machineName="devbox"
        rows={[row()]}
        editable
        onSignIn={onSignIn}
        onUseConnected={onUseConnected}
      />,
    );
    await screen.pressByTestIdAsync(
      'machine-setup-sign-in-connected:happier.scm.forge.github/gh',
    );
    expect(onUseConnected).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'happier.scm.forge.github/gh' }),
      'happier.scm.forge.github/github-account',
    );
    await screen.pressByTestIdAsync(
      'machine-setup-sign-in-start:happier.scm.forge.github/gh',
    );
    expect(onSignIn).toHaveBeenCalledTimes(1);
    await screen.unmount();
  });

  it('offers no connected account for a CLI without one, or one already using it', async () => {
    const screen = await renderScreen(
      <MachineSignInsList
        serverId="home"
        machineId="devbox"
        machineName="devbox"
        rows={[row({ connectedServices: [] })]}
        editable
        onSignIn={vi.fn()}
        onUseConnected={vi.fn()}
      />,
    );
    expect(
      screen.findByTestId(
        'machine-setup-sign-in-connected:happier.scm.forge.github/gh',
      ),
    ).toBeNull();
    await screen.unmount();
    const using = await renderScreen(
      <MachineSignInsList
        serverId="home"
        machineId="devbox"
        machineName="devbox"
        rows={[
          row({ status: 'signedIn', credentialSource: 'connectedAccount' }),
        ]}
        editable
        onSignIn={vi.fn()}
        onUseConnected={vi.fn()}
      />,
    );
    expect(
      using.findByTestId(
        'machine-setup-sign-in-connected:happier.scm.forge.github/gh',
      ),
    ).toBeNull();
    await using.unmount();
  });
});

describe('Machine sign-ins: Agents keep their own connected-account chooser (live L10, 1120)', () => {
  it('offers the connected account only on a CLI that declares a connected launch, never on Agent rows', async () => {
    const agent: MachineCliSignInRow = { ...row(), id: 'codex', title: 'Codex', kind: 'agent', connectedLaunch: undefined };
    const screen = await renderScreen(<MachineSignInsList serverId="home" machineId="devbox" machineName="devbox"
      rows={[agent]} editable onSignIn={vi.fn()} onUseConnected={vi.fn()} />);
    expect(screen.findByTestId('machine-setup-sign-in-connected:codex')).toBeNull();
    expect(screen.findByTestId('machine-setup-sign-in-start:codex')).not.toBeNull();
    await screen.unmount();
  });
});

describe('Machine sign-ins: which connected account a CLI uses (E U4)', () => {
  const service = { pluginId: 'happier.scm.forge.github', localId: 'github-account' };
  const launch = { purpose: { consumer: { pluginId: 'happier.scm.forge.github', localId: 'gh' }, purpose: 'github.cli' }, service };
  const account = (accountId: string, status = 'connected') => ({ ref: { service, accountId }, status });

  it('sets the CLI purpose default to the one connected account, or the Account default among several', async () => {
    const { resolveMachineSignInConnectedChoice } = await import('./MachineSignInsSection');
    expect(resolveMachineSignInConnectedChoice(launch, [account('a1')], {})).toEqual({ kind: 'set',
      input: { purpose: launch.purpose, target: { kind: 'account', account: { service, accountId: 'a1' } } } });
    expect(resolveMachineSignInConnectedChoice(launch, [account('a1'), account('a2')],
      { 'happier.scm.forge.github/github-account': 'a2' })).toMatchObject({ kind: 'set',
      input: { target: { account: { accountId: 'a2' } } } });
  });

  it('connects an account when none is ready, and asks the owner page to choose among several without a default', async () => {
    const { resolveMachineSignInConnectedChoice } = await import('./MachineSignInsSection');
    expect(resolveMachineSignInConnectedChoice(launch, [account('a1', 'needs_reauth')], {})).toEqual({ kind: 'connect', service });
    expect(resolveMachineSignInConnectedChoice(launch, [account('a1'), account('a2')], {})).toEqual({ kind: 'choose', service });
  });
});
