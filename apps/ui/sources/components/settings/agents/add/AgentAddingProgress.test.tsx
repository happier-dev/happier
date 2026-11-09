import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ spies: { confirm: vi.fn(async () => true) } }).module);
const transport = vi.hoisted(() => vi.fn<(input: { machineId: string; method: string; payload: unknown }) => Promise<unknown>>());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () =>
  (await import('@/dev/testkit/mocks/serverScopedRpc')).createServerScopedMachineRpcBoundaryMock(transport));
installDisconnectedServerSocketBoundary();
const { AgentAddingProgress } = await import('./AgentAddingProgress');
const { storage } = await import('@/sync/domains/state/storage');

afterEach(() => standardCleanup());

it('keeps accepted progress and sends only the failed machine to the Add retry owner, showing its latest result', async () => {
  const home = await createPlainArtifactHomeFixture('https://agent-partial-progress.test', {
    serverFeatures: createRootLayoutFeaturesResponse(),
  });
  storage.setState({ isDataReady: true });
  const definitionId = 'registry-junie';
  const starts: string[] = [];
  const completed = (machineId: string) => ({ jobId: `job-${machineId}`, agentId: 'custom-acp', definitionId,
    intent: 'install', startedAt: 1, steps: [], progress: [], done: true, outcome: { kind: 'succeeded', version: '1.0.0' } });
  transport.mockImplementation(async ({ machineId, method }) => {
    if (method === RPC_METHODS.DAEMON_AGENTS_INSTALL_LIST)
      return { ok: true, jobs: machineId === 'accepted' || starts.includes(machineId) ? [completed(machineId)] : [] };
    if (method === RPC_METHODS.DAEMON_AGENTS_INSTALL_READ)
      return { ok: true, events: [], steps: [], progress: [], nextCursor: 0, done: true, outcome: { kind: 'succeeded', version: '1.0.0' } };
    throw new Error(`Unexpected daemon request ${method}`);
  });
  const installed: string[] = [];
  function Progress() {
    const [failures, setFailures] = React.useState([{ machineId: 'refused', errorCode: 'install_unavailable' }]);
    return <AgentAddingProgress name="Junie" definitionId={definitionId} serverId={home.home.id} testID="progress"
      machines={['accepted', 'refused'].map(machineId => ({ machineId, name: machineId, platform: 'linux', arch: 'x64', offline: false }))}
      installOn={['accepted', 'refused']} failures={failures}
      onRetryInstall={async (machineId: string) => {
        starts.push(machineId);
        if (starts.length === 1) throw new Error('Registry is unavailable');
        installed.push(`job-${machineId}`);
        setFailures(previous => previous.filter(failure => failure.machineId !== machineId));
      }} />;
  }
  const screen = await renderScreen(<Progress />);
  try {
    await vi.waitFor(() => expect(screen.findByTestId('progress.machine.accepted.status')?.children.length).toBeGreaterThan(0));
    expect(screen.findByTestId('progress.machine.refused.retry')).not.toBeNull();
    expect(screen.findByTestId('progress.machine.accepted.retry')).toBeNull();
    await screen.pressByTestIdAsync('progress.machine.refused.retry');
    await vi.waitFor(() => expect(starts).toEqual(['refused']));
    expect(installed).toEqual([]);
    expect(screen.findByTestId('progress.machine.refused.retry')).not.toBeNull();
    expect(screen.getTextContent()).toContain('Registry is unavailable');
    await screen.pressByTestIdAsync('progress.machine.refused.retry');
    await vi.waitFor(() => expect(installed).toEqual(['job-refused']));
    expect(starts).toEqual(['refused', 'refused']);
    await act(async () => {});
    expect(screen.findByTestId('progress.machine.refused.retry')).toBeNull();
    expect(screen.findByTestId('progress.machine.accepted.retry')).toBeNull();
  } finally { await screen.unmount(); await home.dispose(); }
});
