import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMachineFixture,
  renderHook,
  renderScreen,
  standardCleanup,
} from '@/dev/testkit';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
  waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { installOwnMachineApprovalReplayBoundary } from '@/dev/testkit/harness/approvalInbox';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createServerScopedMachineRpcBoundaryMock } from '@/dev/testkit/mocks/serverScopedRpc';
import type { MachineAgentInventoryItem } from '@happier-dev/protocol/capabilities';

vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
const boundary = vi.hoisted(() => ({ rpc: vi.fn(), confirm: vi.fn() }));
// The Machine RPC transport and the dialog host are the boundaries; the form, sign-in owner, Action executor
// and the one start sequence stay real.
vi.mock(
  '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
  () => createServerScopedMachineRpcBoundaryMock(boundary.rpc),
);
vi.mock(
  '@/modal',
  async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
      spies: { confirm: boundary.confirm },
    }).module,
);
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { Modal } = await import('@/modal');
const { useServerCredentialAccountScopeBinding } =
  await import('@/sync/domains/scope/useServerCredentialAccountScopes');
const { serverAccountScopedResourceKey } =
  await import('@/sync/domains/scope/serverAccountScope');
const { machineAgentInventoryStore } =
  await import('@/agents/machineAgents/machineAgentInventoryStore');
const { AgentSetupForm } = await import('./AgentSetupForm');

const installed: MachineAgentInventoryItem = {
  agentId: 'codex',
  title: 'Codex',
  installed: true,
  version: '1',
  latestVersion: null,
  update: { supported: false, command: null },
  signIn: { status: 'signedOut', loginSupport: 'login_terminal' },
  platform: { supported: true },
  install: {
    available: true,
    mode: 'managed',
    sizeBytes: null,
    guideUrl: null,
  },
  dependencies: [],
};

afterEach(() => standardCleanup());

/** Agent Setup on one Machine whose daemon Prepare places the Codex login in `signInScope`. */
async function renderAgentSetup(signInScope: 'sharedAgent' | 'member') {
  await home.reset();
  boundary.rpc.mockReset();
  boundary.confirm.mockReset();
  const serverId = await home.addHome({
    name: 'Setup',
    serverUrl: 'https://agent-setup.invalid',
    accountId: 'fixture-account',
  });
  // One Machine per case: the sign-in owner keeps each (Account, Machine, Agent) state across mounts.
  const machineId = `${signInScope}-devbox`;
  const machine = createMachineFixture({ id: machineId, activeAt: Date.now() });
  const fixture = createPlainMachineRowFixture({
    id: machineId,
    accountId: 'fixture-account',
    machine,
  });
  home.answer(serverId, '/v1/machines', { body: [fixture] });
  home.answer(serverId, `GET /v1/machines/${machineId}`, {
    body: { machine: fixture },
  });
  await publishMachineInventoryForTest(
    { serverId, accountId: 'fixture-account' },
    [machine],
  );
  await installOwnMachineApprovalReplayBoundary({
    harness: home,
    serverId,
    accountId: 'fixture-account',
    machineId,
  });
  boundary.rpc.mockImplementation(async ({ method }: { method: string }) => {
    if (method === 'daemon.agents.signIn.prepare')
      return {
        method: 'native',
        launch: { kind: 'agent_login', agentId: 'codex' },
        signInScope,
      };
    if (method === 'daemon.terminal.ensure')
      return { ok: true, terminalId: 'codex-login', reused: false };
    if (method === 'daemon.agents.signIn.status')
      return {
        status: 'signedOut',
        checkedAt: Date.now(),
        nativeLogin: 'login_terminal',
        connectedServices: [],
        signInScope,
      };
    throw new Error(`Unexpected fixture RPC ${method}`);
  });
  const scope = { serverId, accountId: 'fixture-account' };
  const binding = await renderHook(() =>
    useServerCredentialAccountScopeBinding(serverId),
  );
  await vi.waitFor(() =>
    expect(binding.getCurrent().binding?.scope).toEqual(scope),
  );
  const screen = await renderScreen(
    <AgentSetupForm
      serverId={serverId}
      machineId={machineId}
      machineName="Devbox"
      agentId="codex"
      layout="full"
      testID="agent-setup"
    />,
  );
  await act(async () => {
    machineAgentInventoryStore.publish(
      serverAccountScopedResourceKey(scope, 'machine-agents', machineId),
      {
        status: 'ready',
        items: [installed],
        lastCheckedAt: 1,
        connectedServicesByAgentId: { codex: [] },
      },
    );
  });
  await vi.waitFor(() =>
    expect(
      screen.findByTestId('agent-setup.openTerminal'),
      screen.getTextContent(),
    ).not.toBeNull(),
  );
  vi.mocked(Modal.show).mockClear();
  const methods = () =>
    boundary.rpc.mock.calls.map(
      ([request]) => (request as { method: string }).method,
    );
  const terminalSheets = () =>
    vi
      .mocked(Modal.show)
      .mock.calls.filter(([modal]) => modal.props && 'target' in modal.props);
  return { screen, binding, methods, terminalSheets };
}

describe('Agent Setup native sign-in into a shared OS user', () => {
  it('asks before anything launches and opens the terminal only once the person confirms', async () => {
    const { screen, binding, methods, terminalSheets } =
      await renderAgentSetup('sharedAgent');
    try {
      boundary.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      await screen.pressByTestIdAsync('agent-setup.openTerminal');
      await waitForHomeGovernance(() =>
        expect(boundary.confirm).toHaveBeenCalledOnce(),
      );
      await waitForHomeGovernance(() =>
        expect(screen.findByTestId('agent-setup.openTerminal')).not.toBeNull(),
      );
      expect(methods()).toContain('daemon.agents.signIn.prepare');
      expect(methods()).not.toContain('daemon.terminal.ensure');
      expect(terminalSheets()).toHaveLength(0);
      await screen.pressByTestIdAsync('agent-setup.openTerminal');
      await waitForHomeGovernance(() =>
        expect(
          methods().filter((method) => method === 'daemon.terminal.ensure'),
        ).toHaveLength(1),
      );
      expect(boundary.confirm).toHaveBeenCalledTimes(2);
      expect(terminalSheets()).toHaveLength(1);
    } finally {
      await screen.unmount();
      await binding.unmount();
    }
  });

  it("launches at once, with the terminal, when the login lands in the requester's own user", async () => {
    const { screen, binding, methods, terminalSheets } =
      await renderAgentSetup('member');
    try {
      await screen.pressByTestIdAsync('agent-setup.openTerminal');
      await waitForHomeGovernance(() =>
        expect(methods()).toContain('daemon.terminal.ensure'),
      );
      expect(boundary.confirm).not.toHaveBeenCalled();
      expect(terminalSheets()).toHaveLength(1);
    } finally {
      await screen.unmount();
      await binding.unmount();
    }
  });
});
