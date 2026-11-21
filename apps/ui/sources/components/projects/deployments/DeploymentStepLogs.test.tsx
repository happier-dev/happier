import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeploymentReceiptDetailV1 } from '@happier-dev/deployments/testing/v1';
import { projectDeploymentReceiptFactsV1 } from '@happier-dev/deployments';
import type { DeploymentReceiptDetailV1 } from '@happier-dev/deployments/contracts/v1';

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

const { DeploymentStepLogs } = await import('./DeploymentStepLogs');

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
