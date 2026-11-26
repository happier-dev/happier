import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMachineFixture, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import type { MachineCliSignInRow } from '@/agents/machineAgents/signIn/useAgentSignIn';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installOwnMachineApprovalReplayBoundary } from '@/dev/testkit/harness/approvalInbox';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createServerScopedMachineRpcBoundaryMock } from '@/dev/testkit/mocks/serverScopedRpc';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key) => key });
});

const boundary = vi.hoisted(() => ({ rpc: vi.fn(), confirm: vi.fn() }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => createServerScopedMachineRpcBoundaryMock(boundary.rpc));
vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  return createModalModuleMock({ spies: { confirm: boundary.confirm } }).module;
});
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { MachineSignInsList, MachineSignInsSection } = await import('./MachineSignInsSection');
const { AgentSignInTerminalHostProvider } = await import('@/components/machines/agents/signInTerminalHost');

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

type StatusAnswer = (agentId: string) => Promise<Record<string, unknown>>;

/** One Home, one online Machine and its daemon: GitHub CLI plus the given Agents, statuses answered by `status`. */
async function installSignInsMachine(status: StatusAnswer, agentsById: Record<string, { id: string; title: string }>) {
  await home.reset();
  boundary.rpc.mockReset();
  const serverId = await home.addHome({ name: 'Sign-in', serverUrl: 'https://fixture.invalid', accountId: 'fixture-account' });
  const { PLUGIN_MANIFEST: github } = await import('../../../../../../packages/plugins/scm-github/src/manifest');
  const definition = github.contributes!.systemTools!.find(tool => tool.id === 'gh')!;
  const toolId = `${github.id}/${definition.id}`;
  const machineId = 'github-sign-in';
  const machine = createMachineFixture({ id: machineId, activeAt: Date.now() });
  const fixture = createPlainMachineRowFixture({ id: machineId, accountId: 'fixture-account', machine });
  home.answer(serverId, '/v1/machines', { body: [fixture] });
  home.answer(serverId, `GET /v1/machines/${machineId}`, { body: { machine: fixture } });
  await publishMachineInventoryForTest({ serverId, accountId: 'fixture-account' }, [machine]);
  await installOwnMachineApprovalReplayBoundary({ harness: home, serverId, accountId: 'fixture-account', machineId });
  boundary.rpc.mockImplementation(async ({ method, payload }: { method: string; payload: { agentId: string } }) => {
    if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return {
      protocolVersion: 1, projection: { v: 2, generation: 1,
        installedPackagesById: { [github.id]: {
          id: github.id, displayName: github.displayName, version: github.version, enabled: true,
          source: { kind: 'path', locator: '/fixture/github' }, occurrenceId: github.id,
        } },
        agentsById,
        familiesById: { systemTools: { family: 'systemTools', entriesById: {
          [toolId]: { id: toolId, pluginId: github.id, pluginVersion: github.version, definition },
        } } },
      },
    };
    if (method === 'daemon.agents.signIn.status') return await status(payload.agentId);
    if (method === 'daemon.agents.signIn.prepare') return {
      method: 'native', launch: { kind: 'agent_login', agentId: toolId },
    };
    if (method === 'daemon.terminal.ensure') return { ok: true, terminalId: 'github-login', reused: false };
    throw new Error(`Unexpected fixture RPC ${method}`);
  });
  return { serverId, machineId, toolId };
}

describe('Machine sign-ins (E U4)', () => {
  it('starts one native GitHub terminal only after the shared-user warning is accepted', async () => {
    boundary.confirm.mockReset();
    boundary.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { serverId, machineId, toolId } = await installSignInsMachine(async () => ({
      installed: true, status: 'signedOut', checkedAt: Date.now(), nativeLogin: 'login_terminal',
      signInScope: 'machineOwner', connectedServices: [],
    }), {});
    const starts = () => boundary.rpc.mock.calls.map(([request]) => request)
      .filter(request => request.method === 'daemon.agents.signIn.prepare');
    const terminalHost = { open: vi.fn() };
    const screen = await renderScreen(
      <AgentSignInTerminalHostProvider host={terminalHost}>
        <MachineSignInsSection serverId={serverId} machineId={machineId} machineName="Devbox" presented editable />
      </AgentSignInTerminalHostProvider>,
    );
    try {
      const startButton = `machine-setup-sign-in-start:${toolId}`;
      await waitForHomeGovernance(() => expect(screen.findByTestId(startButton)).not.toBeNull());
      expect(starts()).toHaveLength(0);
      await screen.pressByTestIdAsync(startButton);
      expect(boundary.confirm).toHaveBeenCalledOnce();
      expect(starts()).toHaveLength(0);
      expect(terminalHost.open).not.toHaveBeenCalled();
      await screen.pressByTestIdAsync(startButton);
      expect(terminalHost.open).toHaveBeenCalledOnce();
      expect(terminalHost.open).toHaveBeenCalledWith(expect.objectContaining({ serverId, machineId, agentId: toolId }));
      await waitForHomeGovernance(() => expect(starts()).toEqual([
        expect.objectContaining({ payload: { agentId: toolId, method: 'native' } }),
      ]));
      await waitForHomeGovernance(() => expect(boundary.rpc.mock.calls.map(([request]) => request.method))
        .toContain('daemon.terminal.ensure'));
    } finally {
      await screen.unmount();
    }
  });

  it('lands every row together once the Machine has reported each CLI, holding its place until then', async () => {
    const helperStatus = createDeferred<Record<string, unknown>>();
    const statusOf = (installed: boolean) => ({ installed, status: 'signedOut', checkedAt: Date.now(),
      nativeLogin: 'login_terminal', signInScope: 'machineOwner', connectedServices: [] });
    const answered: string[] = [];
    const { serverId, machineId, toolId } = await installSignInsMachine(async (agentId) => {
      const answer = agentId === 'acme/helper' ? await helperStatus.promise : statusOf(true);
      answered.push(agentId);
      return answer;
    }, { 'acme/helper': { id: 'helper', title: 'Helper' } });
    const shown = (screen: Awaited<ReturnType<typeof renderScreen>>) => [toolId, 'acme/helper']
      .filter(id => screen.findByTestId(`machine-setup-sign-in:${id}`) !== null);
    const screen = await renderScreen(
      <MachineSignInsSection serverId={serverId} machineId={machineId} machineName="Devbox" presented editable />,
    );
    try {
      // GitHub CLI has answered; the Agent has not, so the count is not known and no row lands yet.
      await waitForHomeGovernance(() => expect(answered).toContain(toolId));
      await flushHookEffects();
      expect(shown(screen)).toEqual([]);
      expect(screen.findByTestId('machine-setup-sign-ins-loading')).not.toBeNull();
      helperStatus.resolve(statusOf(true));
      await waitForHomeGovernance(() => expect(shown(screen)).toEqual([toolId, 'acme/helper']));
      expect(screen.findByTestId('machine-setup-sign-ins-loading')).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

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
    expect(using.findByTestId('machine-setup-sign-in-start:happier.scm.forge.github/gh')).not.toBeNull();
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
