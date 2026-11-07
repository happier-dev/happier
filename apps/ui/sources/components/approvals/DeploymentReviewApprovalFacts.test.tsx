import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { createMachineFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key) => key });
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const { DeploymentReviewApprovalFacts } = await import('./DeploymentReviewApprovalFacts');

const initialState = storage.getState();
afterEach(() => {
  standardCleanup();
  storage.setState(initialState, true);
});

const machineReview = {
  inspection: 'complete' as const,
  services: [
    { name: 'web', replicas: 1, resources: { cpus: null, memory: null }, restartPolicy: 'unless-stopped', healthcheck: 'configured' as const,
      ports: [], mounts: [] },
  ],
  risks: [{ kind: 'privileged' as const, service: 'web' }, { kind: 'docker_socket' as const, service: 'web' }],
  target: { engine: 'native' as const, requiresAwakeComputerAndDockerDesktop: false, domains: 'notDetermined' as const },
};

describe('DeploymentReviewApprovalFacts', () => {
  it.each([false, true])('shows changed reference names and phases from the host review (controller: %s)', async controller => {
    const review = { ...machineReview, risks: [], referenceChanges: [
      { name: 'DATABASE_URL', phase: 'runtime' as const },
      { name: 'BUILD_ENDPOINT', phase: 'build' as const },
    ] };
    const screen = await renderScreen(
      <DeploymentReviewApprovalFacts approval={{ review: controller
        ? { ...machineReview, risks: [], runtimeMachines: [{ machineId: 'machine-target', review }] } : review,
        promotion: null }} serverId={getActiveServerSnapshot().serverId} testID="facts" />,
    );
    expect(screen.findHostByTestId('facts.risks')).not.toBeNull();
    const text = screen.getTextContent();
    for (const fact of ['DATABASE_URL', 'BUILD_ENDPOINT', 'projects.deployments.phaseRuntime',
      'projects.deployments.phaseBuild', 'projects.deployments.editors.referenceAddressChanged']) expect(text).toContain(fact);
    const unchanged = await renderScreen(
      <DeploymentReviewApprovalFacts approval={{ review: { ...machineReview, risks: [] }, promotion: null }}
        serverId={getActiveServerSnapshot().serverId} testID="unchanged" />,
    );
    expect(unchanged.findHostByTestId('unchanged.risks')).toBeNull();
  });

  it('shows the selected deployment failure policy independently of migration recovery', async () => {
    const screen = await renderScreen(
      <DeploymentReviewApprovalFacts approval={{ review: { ...machineReview, onFailure: 'keepPartial',
        ownServer: { rollout: 'recreate', autoRestorePreviousRelease: true } }, promotion: null }}
        serverId={getActiveServerSnapshot().serverId} testID="facts" />,
    );
    expect(screen.getTextContent()).toContain('projects.deployments.receipt.keepPartial');
  });

  it('does not redraw the approval page when only the Machine presence changes', async () => {
    const serverId = getActiveServerSnapshot().serverId;
    const machine = createMachineFixture({ id: 'machine-target', metadata: { displayName: 'Rebound workstation', host: 'w.local',
      platform: 'darwin', happyCliVersion: '0.0.0-test', happyHomeDir: '/h', homeDir: '/h' } });
    const publish = (next: typeof machine) => storage.setState({ machines: { [next.id]: next },
      machineListByServerId: { [serverId]: [next] }, machineListStatusByServerId: { [serverId]: 'idle' } });
    publish(machine);
    const commits = vi.fn();
    const screen = await renderScreen(
      <React.Profiler id="facts" onRender={commits}>
        <DeploymentReviewApprovalFacts approval={{ review: { ...machineReview, machineId: 'machine-target' }, promotion: null }}
          serverId={serverId} testID="facts" />
      </React.Profiler>,
    );
    expect(screen.getTextContent()).toContain('Rebound workstation');
    commits.mockClear();
    for (const active of [false, true, false]) {
      await act(async () => publish({ ...machine, active, activeAt: active ? 5 : 1 }));
    }
    expect(commits).not.toHaveBeenCalled();
    // A rename is a real change of what the page says.
    await act(async () => publish({ ...machine, metadata: { ...machine.metadata!, displayName: 'Renamed workstation' } }));
    expect(screen.getTextContent()).toContain('Renamed workstation');
  });

  it('puts the root-granting settings in one callout above the rest, not in the neutral rows', async () => {
    const serverId = getActiveServerSnapshot().serverId;
    const screen = await renderScreen(
      <DeploymentReviewApprovalFacts approval={{ review: { ...machineReview }, promotion: null }} serverId={serverId} testID="facts" />,
    );
    expect(screen.findByTestId('facts.risks')).not.toBeNull();
    const text = screen.getTextContent();
    expect(text).toContain('projects.deployments.review.risk.privileged');
    expect(text).toContain('projects.deployments.review.risk.docker_socket');
  });
});
