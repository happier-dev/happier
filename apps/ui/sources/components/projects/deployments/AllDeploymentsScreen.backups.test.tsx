import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDeploymentReadControllerV1,
  type DeploymentReadControllerV1,
  type DeploymentReadTransportV1,
} from '@happier-dev/deployments';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import {
  ProjectReadinessReadInputV1Schema,
  type ProjectReadinessReadInputV1,
  type ProjectReadinessReadResultV1,
} from '@happier-dev/protocol/projects/readinessV1';

import { act, renderScreen } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';

const routerMock = await vi.hoisted(async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock();
});
vi.mock('expo-router', () => routerMock.module);

// Only the Home's HTTP boundary is answered: the Actions front door, the readiness hook, the coverage projection and
// the page run for real.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
await import('@/sync/ops/actions/defaultActionExecutor');
const { captureLazyActionAccountContext } =
  await import('@/sync/ops/actions/actionAccountContext');
const { AllDeploymentsView } = await import('./AllDeploymentsScreen');
const { useDeploymentCollection } = await import('./useDeploymentReads');

const shown = { mounted: true, visible: true, focused: true };
const environment = (id: string, projectSourceId: string, title: string) => ({
  environment: createDeploymentEnvironmentHeaderV1({
    id,
    projectSourceId,
    controllerMachineId: 'controller',
  }),
  title,
  projectSourceName:
    projectSourceId === 'source-shop' ? 'storefront' : 'payments-api',
  currentDeployment: null,
});
const items = [
  environment('env-shop-production', 'source-shop', 'Production'),
  environment('env-shop-staging', 'source-shop', 'Staging'),
  environment('env-api-production', 'source-api', 'Production API'),
];

function controllerFor(): DeploymentReadControllerV1 {
  const unavailable = async () => ({
    ok: false as const,
    failure: { code: 'deployment_unavailable', retryable: true },
  });
  const transport: DeploymentReadTransportV1 = {
    listEnvironments: async () => ({
      ok: true,
      value: { items, nextCursor: null },
    }),
    readEnvironment: unavailable,
    listHistory: unavailable,
    readReceipt: unavailable,
  };
  return createDeploymentReadControllerV1({
    scope: { serverId: 'home', accountId: 'alice' },
    transport,
  });
}

/** Production and Production API have no verified backup; Staging is backed up. */
const backupFacts = (
  input: ProjectReadinessReadInputV1,
): ProjectReadinessReadResultV1['facts'] =>
  input.environments.map(({ environmentId }) =>
    environmentId === 'env-shop-staging'
      ? {
          kind: 'backups',
          owner: 'deploymentBackups',
          environmentId,
          status: 'ready',
          reason: 'configured_sources_verified',
        }
      : {
          kind: 'backups',
          owner: 'deploymentBackups',
          environmentId,
          status: 'actionNeeded',
          reason: 'no_verified_backup_yet',
        },
  );

async function mount(
  options: Readonly<{
    presented: boolean;
    fail?: (input: ProjectReadinessReadInputV1) => boolean;
  }>,
) {
  const identity = `srv_${'7'.repeat(32)}`;
  const serverId = await homes.addHome({
    name: 'Backups',
    serverUrl: `https://all-deployments-${Math.random().toString(36).slice(2)}.test`,
    serverIdentityId: identity,
    accountId: 'alice',
    currentAccount: true,
  });
  const account = await captureLazyActionAccountContext(serverId);
  const reads: ProjectReadinessReadInputV1[] = [];
  await answerExternalActionAccountForHome(homes, serverId, {
    machineId: 'controller',
    actionId: 'projects.readiness.read',
    requesterInvocation: 'none',
    tokenEpoch: 0,
    // The controller refusing a group's read, as the HTTP execution envelope carries it.
    failure: (result) => ((result as { offline?: boolean }).offline ? { errorCode: 'machine_offline', error: 'offline' } : null),
    execute: (raw) => {
      const input = ProjectReadinessReadInputV1Schema.parse(raw);
      reads.push(input);
      if (options.fail?.(input)) return { offline: true };
      return {
        serverId: identity,
        projectId: input.projectId,
        status: 'actionNeeded',
        facts: backupFacts(input),
      };
    },
  });
  const controller = controllerFor();
  function Page() {
    const read = useDeploymentCollection(controller, shown);
    return (
      <AllDeploymentsView
        read={read}
        serverId="home"
        lifetime={account.accountLifetime}
        presented={options.presented}
      />
    );
  }
  const screen = await renderScreen(<Page />);
  await act(async () => {
    await vi.waitFor(() =>
      expect(screen.findByTestId('all-deployments')).not.toBeNull(),
    );
  });
  return {
    screen,
    reads,
    dispose: () => {
      controller.retire();
      account.dispose();
    },
  };
}

const rowIds = (screen: Awaited<ReturnType<typeof renderScreen>>) => [
  ...new Set(
    screen
      .findAll(
        (node) =>
          typeof node.props.testID === 'string' &&
          /^all-deployments\.row\.[^.]+$/.test(node.props.testID),
      )
      .map((node) => node.props.testID as string),
  ),
];

beforeEach(() => homes.reset());
afterEach(() => {
  routerMock.spies.push.mockClear();
  standardCleanup();
});

describe('All deployments → Not backed up', () => {
  it('reads backup readiness once per Project for the shown Environments and filters to the ones not backed up', async () => {
    const { screen, reads, dispose } = await mount({ presented: true });
    try {
      await act(async () => {
        await vi.waitFor(() =>
          expect(
            screen.findByTestId('all-deployments.notBackedUp'),
          ).not.toBeNull(),
        );
      });
      // One existing readiness read per (Project, Machine) group, never one per app.
      expect(
        reads.map((read) =>
          read.environments.map((entry) => entry.environmentId),
        ),
      ).toEqual([
        ['env-shop-production', 'env-shop-staging'],
        ['env-api-production'],
      ]);
      expect(screen.getTextContent()).toContain('Not backed up · 2');
      expect(rowIds(screen)).toHaveLength(3);
      // The filter sits inline in the list, one press away, never folded into the header's phone overflow (DEPLOY-REACCEPT-1113 D3).
      const { PageHeader } = await import('@/components/ui/layout/PageHeader');
      expect(screen.findAllByType(PageHeader).map((node) => node.props.actions ?? null)).toEqual([null]);

      await act(async () => {
        await screen.pressByTestIdAsync('all-deployments.notBackedUp');
      });
      expect(rowIds(screen)).toEqual([
        'all-deployments.row.env-shop-production',
        'all-deployments.row.env-api-production',
      ]);

      // A row shown for "Not backed up" opens where that Environment's backups are set up.
      await screen.pressByTestIdAsync('all-deployments.row.env-api-production');
      expect(routerMock.spies.push).toHaveBeenCalledWith({
        pathname: '/deployments/[projectSourceId]',
        params: {
          projectSourceId: 'source-api',
          serverId: 'home',
          deploymentEnvironment: 'env-api-production',
          deploymentTab: 'settings',
          deploymentSection: 'backups',
          deploymentSetup: 'backups',
        },
      });
      expect(reads).toHaveLength(2);
    } finally {
      dispose();
    }
  });

  it('reads nothing while the page is not on screen', async () => {
    const { screen, reads, dispose } = await mount({ presented: false });
    try {
      expect(reads).toEqual([]);
      expect(screen.findByTestId('all-deployments.notBackedUp')).toBeNull();
    } finally {
      dispose();
    }
  });

  it('never counts an Environment it could not check as backed up', async () => {
    const { screen, reads, dispose } = await mount({
      presented: true,
      fail: (input) => input.projectId === 'source-shop',
    });
    try {
      await act(async () => {
        await vi.waitFor(() =>
          expect(screen.getTextContent()).toContain('Not backed up · 1'),
        );
      });
      await act(async () => {
        await screen.pressByTestIdAsync('all-deployments.notBackedUp');
      });
      expect(rowIds(screen)).toEqual([
        'all-deployments.row.env-api-production',
      ]);
      expect(
        screen.findByTestId('all-deployments.backupsUnresolved'),
      ).not.toBeNull();
      expect(screen.findByTestId('all-deployments.allBackedUp')).toBeNull();
      const before = reads.length;
      await act(async () => {
        await screen.pressByTestIdAsync(
          'all-deployments.backupsUnresolved.retry',
        );
      });
      await vi.waitFor(() => expect(reads.length).toBe(before + 1));
      expect(reads.at(-1)?.projectId).toBe('source-shop');
    } finally {
      dispose();
    }
  });
});
