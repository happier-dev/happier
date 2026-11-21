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
  return createTextModuleMock({ translate: (key, params) => key === 'projects.deployments.review.replacesNote'
    ? `${key} ${String(params?.revision)}` : key });
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const { DeploymentReviewApprovalFacts, readDeploymentReviewApproval } = await import('./DeploymentReviewApprovalFacts');

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
  it.each(['own-server', 'platform'] as const)('renders the version, replaced version, target and data effect for %s rollback', async target => {
    const facts = {
      environment: { id: 'env', name: 'Production' },
      revision: { kind: 'repository', sha: 'a'.repeat(40) },
      replaces: { deploymentId: 'serving', revision: { kind: 'repository', sha: 'b'.repeat(40) } },
    };
    const deploymentReview = target === 'own-server'
      ? { ...machineReview, ...facts, rollbackData: 'restoreBackup' }
      : { platformRollback: { ...facts, platformName: 'Vercel', providerResourceId: 'production-project', providerEnvironment: 'production',
          data: 'keep' }, providerReview: { sourceMethod: 'gitIntegration' } };
    const approval = readDeploymentReviewApproval({ preview: { deploymentReview } });
    if (!approval) throw new Error('Expected a typed Rollback review');
    const screen = await renderScreen(
      <DeploymentReviewApprovalFacts approval={approval} serverId={null} testID="rollback-facts" />,
    );
    const displayed = screen.getTextContent();
    expect(displayed).toContain('aaaaaaa');
    expect(displayed).toContain('projects.deployments.review.replacesNote bbbbbbb');
    expect(displayed).toContain(target === 'own-server' ? 'projects.deployments.review.engineNative' : 'production-project');
    expect(displayed).toContain(target === 'own-server'
      ? 'projects.deployments.review.rollbackDataRestored' : 'projects.deployments.review.rollbackDataKept');
  });
  it.each([false, true])('shows required build platforms and the emulation cost without claiming an observed execution mode (controller: %s)', async controller => {
    const review = { ...machineReview,
      buildSupport: { status: 'notObserved' as const, requestedPlatforms: ['linux/amd64', 'linux/arm64'] } };
    const screen = await renderScreen(
      <DeploymentReviewApprovalFacts approval={{ review: controller ? { ...machineReview,
        runtimeMachines: ['linux/amd64', 'linux/arm64'].map((platform, index) => ({ machineId: `runtime-${index}`,
          review: { ...review, buildSupport: { status: 'notObserved' as const, requestedPlatforms: [platform] } } })) } : review,
        promotion: null }}
        serverId={getActiveServerSnapshot().serverId} testID="build-facts" />,
    );
    const text = screen.getTextContent();
    expect(text).toContain('linux/amd64, linux/arm64');
    expect(text).toContain('projects.deployments.review.buildPlatforms');
    expect(text).toContain('projects.deployments.review.emulationCost');
  });
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

  it('says which Happier network path a changed reference took, and nothing for a native-network one', async () => {
    const review = { ...machineReview, risks: [], referenceChanges: [
      { name: 'DATABASE_URL', phase: 'runtime' as const, route: { kind: 'iroh' as const, observedPath: 'relay' as const } },
      { name: 'CACHE_URL', phase: 'runtime' as const, route: { kind: 'iroh' as const, observedPath: 'direct' as const } },
      { name: 'QUEUE_URL', phase: 'runtime' as const, route: { kind: 'iroh' as const, observedPath: 'unknown' as const } },
      { name: 'SEARCH_URL', phase: 'runtime' as const },
    ] };
    const screen = await renderScreen(
      <DeploymentReviewApprovalFacts approval={{ review, promotion: null }}
        serverId={getActiveServerSnapshot().serverId} testID="routes" />,
    );
    const text = screen.getTextContent();
    for (const route of ['referenceRouteRelay', 'referenceRouteDirect', 'referenceRouteUnknown']) {
      expect(text.split(`projects.deployments.editors.${route}`)).toHaveLength(2);
    }
    // The changed-address treatment still applies to every changed reference, routed or not.
    expect(text.split('projects.deployments.editors.referenceAddressChanged')).toHaveLength(5);
  });

  it('says a redeploy of the running version as that, not "replaces" itself (PAGE-ACCEPT-100 D10)', async () => {
    const revision = { kind: 'stored' as const, contentRevision: 2, composeDigest: `sha256:${'a'.repeat(64)}` };
    const other = { kind: 'stored' as const, contentRevision: 1, composeDigest: `sha256:${'b'.repeat(64)}` };
    const screen = await renderScreen(
      <DeploymentReviewApprovalFacts approval={{ review: { ...machineReview, risks: [], revision, replaces: { revision } } as never, promotion: null }}
        serverId={getActiveServerSnapshot().serverId} testID="same" />,
    );
    const text = screen.getTextContent();
    expect(text).toContain('projects.deployments.review.replacesSame');
    expect(text).not.toContain('projects.deployments.review.replacesNote');
    const older = await renderScreen(
      <DeploymentReviewApprovalFacts approval={{ review: { ...machineReview, risks: [], revision, replaces: { revision: other } } as never, promotion: null }}
        serverId={getActiveServerSnapshot().serverId} testID="older" />,
    );
    expect(older.getTextContent()).toContain('projects.deployments.review.replacesNote');
  });

  it('stops asking to check once the request is decided, and keeps what it flagged (PAGE-ACCEPT-100 D10)', async () => {
    const screen = await renderScreen(
      <DeploymentReviewApprovalFacts approval={{ review: machineReview, promotion: null }} decided
        serverId={getActiveServerSnapshot().serverId} testID="decided" />,
    );
    const text = screen.getTextContent();
    expect(text).toContain('projects.deployments.review.risksNotedTitle');
    expect(text).not.toContain('projects.deployments.review.risksTitle');
    expect(text).toContain('projects.deployments.review.risk.privileged');
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


it.each([false, true])('presents name-only Compose use warnings from the host review (controller: %s)', async controller => {
  const review = { ...machineReview, risks: [], variableUseWarnings: [
    { kind: 'unusedBinding' as const, name: 'LOG_LEVEL' }, { kind: 'unboundVariable' as const, name: 'REDIS_URL' },
  ] };
  const screen = await renderScreen(<DeploymentReviewApprovalFacts approval={{ review: controller
    ? { ...machineReview, risks: [], runtimeMachines: [{ machineId: 'target', review }] } : review,
    promotion: null }} serverId={getActiveServerSnapshot().serverId} testID="facts" />);
  expect(screen.findHostByTestId('facts.risks')).not.toBeNull();
  expect(screen.getTextContent()).toContain('LOG_LEVEL');
  expect(screen.getTextContent()).toContain('REDIS_URL');
});
