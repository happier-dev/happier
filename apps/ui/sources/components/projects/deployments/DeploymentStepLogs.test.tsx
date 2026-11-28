import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeploymentReceiptDetailV1 } from '@happier-dev/deployments/testing/v1';
import { projectDeploymentReceiptFactsV1 } from '@happier-dev/deployments';
import type { DeploymentReceiptDetailV1 } from '@happier-dev/deployments/contracts/v1';

import { act, createDeferred, createMachineFixture } from '@/dev/testkit';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { recordMachineRequestFailed } from '@/sync/domains/machines/reachability/machineReachability';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
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

afterEach(() => {
  standardCleanup();
});

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { DeploymentStepLogs } = await import('./DeploymentStepLogs');

it('keeps the receipt’s pending log read visible when pushed presence is online after a request failure', async () => {
  const serverId = await homes.addHome({ name: 'Live logs', serverUrl: 'https://deploy-live-logs.test',
    accountId: 'alice', serverIdentityId: `srv_${'e'.repeat(32)}`, currentAccount: true });
  const account = await captureLazyActionAccountContext(serverId);
  const scope = account.accountLifetime.scope;
  const machine = createMachineFixture({ id: 'runtime-machine', installationId: 'runtime-installation',
    active: true, activeAt: Date.now(), storageMode: 'plain' });
  const receipt = createDeploymentReceiptDetailV1();
  receipt.content.machines = [machine.id];
  receipt.content.steps = [];
  const reference = { kind: 'build' as const, environmentId: receipt.deployment.environmentId, deploymentId: receipt.deployment.id,
    targetLinkId: receipt.deployment.targetLinkId, machineId: machine.id, installationId: 'runtime-installation' };
  const facts = projectDeploymentReceiptFactsV1(receipt);
  const response = createDeferred<void>();
  const readLogs = vi.fn<NonNullable<React.ComponentProps<typeof DeploymentStepLogs>['readLogs']>>(async input => {
    await response.promise;
    return { ...input, ok: true, kind: 'build', logs: { kind: 'page', page: {
      sourceRevision: 'page-1', text: 'live output', truncated: false, nextCursor: null,
    } } };
  });
  let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
  try {
    await publishMachineInventoryForTest(scope, [machine]);
    recordMachineRequestFailed({ ...scope, machineId: machine.id });
    screen = await renderScreen(<DeploymentStepLogs testID="live-logs" title="Deploy"
      machineName="Runtime Machine" machineNames={{ [machine.id]: 'Runtime Machine' }} machineId={machine.id}
      facts={{ ...facts, placement: 'machine', logs: [{ scope: 'operation', reference, excerpt: null }] }} steps={[]}
      running={true} followLog={false} serverId={serverId} readLogs={readLogs} fileStem="deploy" />);
    expect(screen.findByTestId('live-logs.log.reading')).not.toBeNull();
    expect(screen.findByTestId('live-logs.log.offline')).toBeNull();
    expect(readLogs).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => response.resolve());
    await screen?.unmount();
    account.dispose();
    await homes.reset();
  }
});

it('holds only the newest lines of the deploy log on the Environment card band (lab siaR3 Q8)', async () => {
  const { DeploymentLogBand } = await import('./DeploymentStepLogs');
  const serverId = await homes.addHome({ name: 'Band logs', serverUrl: 'https://deploy-band-logs.test',
    accountId: 'alice', serverIdentityId: `srv_${'f'.repeat(32)}`, currentAccount: true });
  const account = await captureLazyActionAccountContext(serverId);
  const machine = createMachineFixture({ id: 'band-machine', installationId: 'band-installation',
    active: true, activeAt: Date.now(), storageMode: 'plain' });
  const receipt = createDeploymentReceiptDetailV1();
  receipt.content.machines = [machine.id];
  receipt.content.steps = [];
  const reference = { kind: 'build' as const, environmentId: receipt.deployment.environmentId, deploymentId: receipt.deployment.id,
    targetLinkId: receipt.deployment.targetLinkId, machineId: machine.id, installationId: 'band-installation' };
  const facts = projectDeploymentReceiptFactsV1(receipt);
  const text = ['line one', 'line two', 'line three', 'line four', 'line five'].join('\n');
  const readLogs = vi.fn<NonNullable<React.ComponentProps<typeof DeploymentLogBand>['readLogs']>>(async input => ({
    ...input, ok: true, kind: 'build', logs: { kind: 'page', page: {
      sourceRevision: 'page-1', text, truncated: false, nextCursor: null,
    } } }));
  let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
  try {
    await publishMachineInventoryForTest(account.accountLifetime.scope, [machine]);
    screen = await renderScreen(<DeploymentLogBand testID="band" serverId={serverId} steps={[]} running={false}
      facts={{ ...facts, placement: 'machine', logs: [{ scope: 'operation', reference, excerpt: null }] }}
      readLogs={readLogs} lines={3} active />);
    await vi.waitFor(() => expect(screen!.findByTestId('band.log.lines')).not.toBeNull());
    // The band's gutter numbers say which lines it holds: the newest three, nothing older.
    const numbers = new Set(screen.findByTestId('band.log.lines')!.findAll(node => typeof node.props?.children === 'string')
      .map(node => node.props.children as string));
    expect([...numbers].sort()).toEqual(['3', '4', '5']);
    expect(readLogs).toHaveBeenCalledTimes(1);
  } finally {
    await screen?.unmount();
    account.dispose();
    await homes.reset();
  }
});

describe('Deployment step logs on a platform receipt (TYPES-ODEPLOY TS18047)', () => {
  it.each([false, true])('keeps the mounted receipt readable when its Machine-less platform log arrives and disappears (single log: %s)', async single => {
    const receipt: DeploymentReceiptDetailV1 = createDeploymentReceiptDetailV1();
    receipt.content.ownServer = undefined;
    receipt.content.platform = {
      targetLinkRevision: 1,
      credentialPrincipal: {
        kind: 'account',
        accountId: 'actor',
        purpose: {
          consumer: { pluginId: 'acme.alpha', localId: 'inspect' },
          purpose: 'deploy',
        },
        target: {
          kind: 'account',
          account: {
            service: { pluginId: 'acme.alpha', localId: 'account' },
            accountId: 'provider',
          },
        },
      },
      providerIdentity: {
        providerAccountId: 'provider',
        providerResourceId: 'project',
        providerEnvironment: 'production',
      },
      providerEnvironment: { kind: 'native', selection: { kind: 'production' } },
      observation: {
        v: 1,
        state: 'succeeded',
        observedAtMs: 1,
        providerDeploymentId: 'dpl_exact',
      },
    };
    receipt.deployment.acceptedExecution = undefined;
    receipt.content.steps = single ? [] : [
      { id: 'build', label: 'Build', state: 'succeeded' },
    ] as typeof receipt.content.steps;
    const facts = projectDeploymentReceiptFactsV1(receipt);
    expect(facts.logs[0]?.reference.machineId).toBeUndefined();
    const noLogFacts = projectDeploymentReceiptFactsV1({ ...receipt, content: { ...receipt.content,
      platform: { ...receipt.content.platform, observation: { ...receipt.content.platform.observation,
        providerDeploymentId: undefined } },
    } });
    expect(noLogFacts.logs).toEqual([]);
    let finishRead!: () => void;
    const pendingRead = new Promise<void>(resolve => { finishRead = resolve; });
    const readLogs: NonNullable<React.ComponentProps<typeof DeploymentStepLogs>['readLogs']> = async input => {
      await pendingRead;
      return {
        ok: true, kind: 'build', environmentId: input.environmentId, deploymentId: input.deploymentId,
        targetLinkId: input.targetLinkId, machineId: input.machineId, installationId: input.installationId,
        logs: { kind: 'page', page: { sourceRevision: 'source-a', text: 'build output', truncated: false,
          nextCursor: { sourceRevision: 'source-a', token: '12' } } },
      };
    };
    const renderLogs = (currentFacts: typeof facts) => (
      <DeploymentStepLogs
        testID="logs"
        title="Deploy"
        machineName="—"
        machineNames={{}}
        machineId={undefined}
        steps={receipt.content.steps}
        facts={currentFacts}
        running={single}
        followLog={false}
        serverId="home-a"
        readLogs={readLogs}
        fileStem="deploy"
      />
    );
    const screen = await renderScreen(renderLogs(noLogFacts));
    if (!single) expect(screen.getTextContent()).toContain('Build');
    expect(screen.findByTestId('logs.toolbar')).toBeNull();
    await screen.update(renderLogs(facts));
    // The recorded step keeps its row; the platform's Machine-less operation log no longer crashes the dedupe.
    try {
      if (!single) expect(screen.getTextContent()).toContain('Build');
      expect(screen.findByTestId('logs.toolbar')).not.toBeNull();
      expect(screen.findByTestId('logs.log.offline')).toBeNull();
      expect(screen.findByTestId('logs.follow')).toBeNull();
      if (single) {
        expect(screen.findByTestId('logs.log.reading')).not.toBeNull();
        expect(screen.getTextContent()).not.toContain('projects.deployments.logWhole');
      }
    } finally {
      finishRead();
    }
    await screen.update(renderLogs(noLogFacts));
    if (!single) expect(screen.getTextContent()).toContain('Build');
    expect(screen.findByTestId('logs.toolbar')).toBeNull();
  });
});
