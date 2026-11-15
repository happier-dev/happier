import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { projectDeploymentReceiptFactsV1 } from '@happier-dev/deployments';

import { renderScreen, standardCleanup } from '@/dev/testkit';

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
  it('shows the platform deploy log beside a step that recorded no stage log, without a Machine', async () => {
    const receipt = createDeploymentReceiptDetailV1();
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
      providerEnvironment: { kind: 'production' },
      observation: {
        v: 1,
        state: 'succeeded',
        observedAtMs: 1,
        providerDeploymentId: 'dpl_exact',
      },
    };
    receipt.deployment.acceptedExecution = undefined;
    receipt.content.steps = [
      { id: 'build', label: 'Build', state: 'succeeded' },
    ] as typeof receipt.content.steps;
    const facts = projectDeploymentReceiptFactsV1(receipt);
    expect(facts.logs[0]?.reference.machineId).toBeUndefined();
    const screen = await renderScreen(
      <DeploymentStepLogs
        testID="logs"
        title="Deploy"
        machineName="—"
        machineNames={{}}
        machineId={undefined}
        steps={receipt.content.steps}
        facts={facts}
        running={false}
        serverId="home-a"
        readLogs={null}
        fileStem="deploy"
      />,
    );
    // The recorded step keeps its row; the platform's Machine-less operation log no longer crashes the dedupe.
    expect(screen.getTextContent()).toContain('Build');
  });
});
