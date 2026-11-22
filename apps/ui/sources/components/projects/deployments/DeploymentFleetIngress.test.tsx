import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/testing/v1';
import {
  createMachineFixture,
  renderScreen,
  standardCleanup,
} from '@/dev/testkit';

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

afterEach(() => standardCleanup());
const { DeploymentFleetIngress } = await import('./DeploymentFleetIngress');
const { SegmentedChoiceItem } =
  await import('@/components/ui/lists/SegmentedChoiceItem');
const { storage } = await import('@/sync/domains/state/storage');

const id = 'project-deployments.environment.settings.servers-build.ingress';

// Owner decision 2026-11-20 (connectors per Machine, 2772f2befeb): a Tunnel ingress offers a short count of connectors
// per Machine, saved through the same Environment update, defaulting to one.
it('saves the Tunnel connectors per Machine from a short choice, defaulting to one', async () => {
  const scope = { serverId: 'home', accountId: 'account' };
  storage.setState({ profileScope: scope });
  storage
    .getState()
    .applyMachines(
      [
        createMachineFixture({
          id: 'machine-a',
          installationId: 'installation-a',
        }),
        createMachineFixture({
          id: 'machine-b',
          installationId: 'installation-b',
        }),
      ],
      true,
      { sourceServerId: scope.serverId, sourceAccountId: scope.accountId },
    );
  const base = createDeploymentEnvironmentDetailV1();
  const detail = {
    ...base,
    content: {
      ...base.content,
      ingress: { kind: 'cloudflareTunnel' as const },
    },
    runtimeTargetLink: {
      ...base.targetLinks[0]!.targetLink,
      targetKind: 'ownServer',
      machines: ['machine-a', 'machine-b'],
    },
  };
  const updateEnvironment = vi.fn(async () => ({ ok: true as const }));
  const editing = {
    actions: { updateEnvironment },
    serverId: scope.serverId,
    review: { pendingId: null, request() {}, open() {} },
    onChanged: vi.fn(),
  };
  const screen = await renderScreen(
    <DeploymentFleetIngress
      detail={detail as never}
      editing={editing as never}
      machineName={(machineId) => machineId}
    />,
  );
  const choice = screen
    .findAllByType(SegmentedChoiceItem)
    .find((node) => node.props.testIDPrefix === `${id}.connectors`);
  expect(choice?.props.value).toBe('1');
  await screen.pressByTestIdAsync(`${id}.connectors:2`);
  expect(updateEnvironment).toHaveBeenCalledWith(detail.environment, {
    ingress: { kind: 'cloudflareTunnel', connectorsPerMachine: 2 },
  });
});

// Coordinator ruling 2026-11-22: the common case is one Machine behind a Tunnel; the same choice shows there.
it('offers the Tunnel connectors per Machine on a single-Machine Environment', async () => {
  const scope = { serverId: 'home', accountId: 'account' };
  storage.setState({ profileScope: scope });
  storage.getState().applyMachines([createMachineFixture({ id: 'machine-a', installationId: 'installation-a' })], true,
    { sourceServerId: scope.serverId, sourceAccountId: scope.accountId });
  const base = createDeploymentEnvironmentDetailV1();
  const detail = { ...base, content: { ...base.content, ingress: { kind: 'cloudflareTunnel' as const, connectorsPerMachine: 2 } },
    runtimeTargetLink: { ...base.targetLinks[0]!.targetLink, targetKind: 'ownServer', machines: ['machine-a'] } };
  const updateEnvironment = vi.fn(async () => ({ ok: true as const }));
  const editing = { actions: { updateEnvironment }, serverId: scope.serverId,
    review: { pendingId: null, request() {}, open() {} }, onChanged: vi.fn() };
  const screen = await renderScreen(<DeploymentFleetIngress detail={detail as never} editing={editing as never}
    machineName={machineId => machineId} />);
  const choice = screen.findAllByType(SegmentedChoiceItem).find(node => node.props.testIDPrefix === `${id}.connectors`);
  expect(choice?.props.value).toBe('2');
  await screen.pressByTestIdAsync(`${id}.connectors:3`);
  expect(updateEnvironment).toHaveBeenCalledWith(detail.environment,
    { ingress: { kind: 'cloudflareTunnel', connectorsPerMachine: 3 } });
});
