import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/testing/v1';
import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
const routing = await vi.hoisted(async () =>
  (await import('@/dev/testkit/mocks/router')).createExpoRouterMock(),
);
vi.mock('expo-router', () => routing.module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ renderCustomModals: true }).module);

afterEach(() => standardCleanup());
const { DeploymentPrivateServiceExports } =
  await import('./DeploymentPrivateServiceExports');
const { ModalProvider } = await import('@/modal');
const { buildPrivateServiceExportPatch } =
  await import('./privateServiceExport');

const id = 'project-deployments.environment.privateSharing';

// PAGE-ACCEPT-176 R10-D5: a saved share opens its own sheet (what is shared, who reaches it) whose one primary stops
// sharing through the same Environment update that authored it.
it('opens a saved private share and stops sharing it through the Environment update', async () => {
  const base = createDeploymentEnvironmentDetailV1();
  const stored = {
    kind: 'stored' as const,
    contentRevision: 1,
    composeDigest: `sha256:${'a'.repeat(64)}`,
    document: 'services:\n  postgres:\n    image: postgres:17\n',
    profiles: [],
    services: [],
  };
  const shared = buildPrivateServiceExportPatch(
    { ...base.content, definition: stored },
    {
      key: 'database',
      service: 'postgres',
      containerPort: 5432,
      scheme: 'postgres',
      reach: { kind: 'happierNetwork' },
    },
  );
  const detail = {
    ...base,
    content: {
      ...base.content,
      definition: { ...stored, document: shared.definition.document },
      ownServer: {
        rollout: 'recreate' as const,
        autoRestorePreviousRelease: true,
        serviceExports: shared.ownServer.serviceExports,
      },
    },
    runtimeTargetLink: {
      ...base.targetLinks[0]!.targetLink,
      source: { kind: 'host' as const, id: 'own-server' },
      machines: ['machine-a'],
    },
    builtInUrls: null,
    memberVersions: {},
    secretRevisions: [],
  };
  const updateEnvironment = vi.fn(async () => ({ ok: true as const }));
  const editing = {
    actions: { setController: vi.fn(), updateEnvironment },
    serverId: 'home',
    review: { pendingId: null, request() {}, open() {} },
    onChanged: vi.fn(),
  };
  const screen = await renderScreen(
    <ModalProvider>
      <DeploymentPrivateServiceExports
        detail={detail as never}
        editing={editing as never}
      />
    </ModalProvider>,
  );
  await screen.pressByTestIdAsync(`${id}.export:database`);
  expect(screen.findByTestId(`${id}.detail`)).not.toBeNull();
  await screen.pressByTestIdAsync(`${id}.stop`);
  expect(updateEnvironment).toHaveBeenCalledTimes(1);
  const patch = (
    updateEnvironment.mock.calls[0] as unknown as [
      unknown,
      { ownServer: { serviceExports: readonly unknown[] } },
    ]
  )[1];
  expect(patch.ownServer.serviceExports).toEqual([]);
});
