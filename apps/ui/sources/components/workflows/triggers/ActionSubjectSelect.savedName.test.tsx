import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/testing/v1';
import {
  createDeploymentEnvironmentHeaderV1,
} from '@happier-dev/deployment-protocol/testing/v1';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol/v1';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderScreen } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
);

// The Homes' HTTP and Account credentials are the boundary; the deployment read owner, the
// private header read and the select stay real.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { ActionSubjectSelect } = await import('./ActionSubjectSelect');

describe('A reopened Action trigger names its saved resource', () => {
  beforeEach(async () => {
    await homes.reset();
  });
  afterEach(() => standardCleanup());

  it('reads the saved Environment name without opening the list', async () => {
    const serverId = await homes.addHome({
      name: 'Subject names',
      serverUrl: 'https://saved-subject-name.test',
      serverIdentityId: 'srv_saved_subject_name',
      accountId: 'account-owner',
      accountEncryptionMode: 'plain',
      active: true,
    });
    const detail = createDeploymentEnvironmentDetailV1({
      environment: createDeploymentEnvironmentHeaderV1({
        id: 'production',
        serverId: 'srv_saved_subject_name',
        contentArtifactId: 'subject-production',
      }),
    });
    const { captureLazyActionAccountContext } =
      await import('@/sync/ops/actions/actionAccountContext');
    const account = await captureLazyActionAccountContext(serverId);
    try {
      await account.createArtifactDocument({
        artifactId: detail.environment.contentArtifactId,
        header: {
          kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1,
          title: 'Production',
        },
        body: JSON.stringify(detail.content),
      });
    } finally {
      account.dispose();
    }
    const root = '/v1/deployments/environments';
    homes.answer(serverId, `${root}/production`, {
      body: { ok: true, environment: detail.environment, targetLinks: [] },
    });

    const screen = await renderScreen(
      <ActionSubjectSelect
        testID="subject"
        operand={{ kind: { kind: 'environment' } }}
        subject={{
          kind: 'environment',
          serverId: 'srv_saved_subject_name',
          environmentId: 'production',
        }}
        machineId={null}
        serverId={serverId}
        onChange={() => {}}
      />,
    );
    await vi.waitFor(() =>
      expect(screen.getTextContent()).toContain('Production'),
    );
    // One exact selection read: never the Environment list.
    expect(
      homes.requests.filter((request) => request.path.split('?')[0] === root),
    ).toHaveLength(0);
    await screen.unmount();
  });
});
