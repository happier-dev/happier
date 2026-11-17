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
import type { ServicesView } from './ServicesViews';

const routerMock = await vi.hoisted(async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock();
});
vi.mock('expo-router', () => routerMock.module);

// Only the Home's HTTP boundary is answered: the Actions front door, the readiness hook, the coverage projection and
// the page run for real.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const { CurrentUiContextSnapshotV1Schema } = await import('@happier-dev/protocol/plugins/ui/currentUiContext');
const { createMountedCurrentUiContextWrapper } = await import('@/dev/testkit/harness/mountedCurrentUiContext');
const { CurrentUiContextActionHost } = await import('@/components/appShell/currentUiContext/currentUiContextVoiceToolPort');
const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { storage } = await import('@/sync/domains/state/storageStore');
const { retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { captureLazyActionAccountContext } =
  await import('@/sync/ops/actions/actionAccountContext');
const { AllDeploymentsView } = await import('./AllDeploymentsScreen');
const { useDeploymentCollection } = await import('./useDeploymentReads');
const { ServicesViewTabs } = await import('./ServicesViews');
const { t } = await import('@/text');

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
    commands?: boolean;
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
    const [view, selectView] = React.useState<ServicesView>('apps');
    return (
      <AllDeploymentsView
        read={read}
        serverId="home"
        lifetime={account.accountLifetime}
        presented={options.presented}
        {...(options.commands ? { controller, demand: shown, view, onSelectView: selectView } : {})}
      />
    );
  }
  // The active Account scope is keyed by the Home's identity, as AppShell activates it.
  const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
  storage.getState().activateProfileScope({ serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'alice' });
  publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true);
  const Wrapper = await createMountedCurrentUiContextWrapper();
  const tree = (show: boolean) => <Wrapper><CurrentUiContextActionHost />{show ? <Page /> : null}</Wrapper>;
  const screen = await renderScreen(tree(true));
  await act(async () => {
    await vi.waitFor(() =>
      expect(screen.findByTestId('all-deployments')).not.toBeNull(),
    );
  });
  return {
    screen,
    reads,
    serverId,
    removePage: () => screen.update(tree(false)),
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
          /^all-deployments\.row\.[^.:]+$/.test(node.props.testID),
      )
      .map((node) => node.props.testID as string),
  ),
];

beforeEach(() => homes.reset());
afterEach(() => {
  routerMock.spies.push.mockClear();
  standardCleanup();
  retireActiveServerAccountScopeLifetime();
});

describe('All deployments → Not backed up', () => {
  it.each(['agent', 'mcp'] as const)('lets %s discover and change the mounted Services view and backup filter, then retires them', async surface => {
    const { screen, reads, serverId, removePage, dispose } = await mount({ presented: true, commands: true });
    try {
      await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('all-deployments.notBackedUp')).not.toBeNull()); });
      const executor = createDefaultActionExecutor();
      const context = { surface, authority: 'account_automation' as const, serverId, expectedAccountId: 'alice' };
      const readCommands = async () => {
        const result = await executor.execute('ui.current_context.read', {}, context);
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.errorCode);
        return CurrentUiContextSnapshotV1Schema.parse(result.result).commands;
      };
      const commands = await readCommands();
      const filter = commands.find(command => command.title === t('projects.deployments.notBackedUp'));
      expect(filter, 'the rendered Apps filter is discoverable').toBeDefined();
      if (!filter) throw new Error('Not backed up command is missing');
      expect(filter.description).toBe(t('common.off'));
      const invoke = async (id: string) => {
        await act(async () => { expect(await executor.execute('ui.current_context.command.invoke', { commandId: id }, context)).toMatchObject({ ok: true }); });
      };
      await invoke(filter.id);
      expect(rowIds(screen)).toHaveLength(2);
      expect(reads).toHaveLength(2);
      const enabledFilter = (await readCommands()).find(command => command.title === t('projects.deployments.notBackedUp'))!;
      expect(enabledFilter.description).toBe(t('common.on'));
      for (const view of ['databases', 'domains', 'checks', 'watched', 'apps'] as const) {
        const command = (await readCommands()).find(candidate => candidate.title === t(`projects.deployments.services.${view}`));
        expect(command, `the ${view} view is discoverable`).toBeDefined();
        if (!command) throw new Error(`${view} command is missing`);
        await invoke(command.id);
        expect(screen.findByType(ServicesViewTabs).props.active).toBe(view);
        expect((await readCommands()).find(candidate => candidate.title === command.title)?.description).toBe(t('common.active'));
        if (view !== 'apps') expect((await readCommands()).some(candidate => candidate.title === t('projects.deployments.notBackedUp'))).toBe(false);
        if (view === 'databases') expect(await executor.execute('ui.current_context.command.invoke', { commandId: enabledFilter.id }, context)).toMatchObject({ ok: false });
      }
      expect(rowIds(screen)).toHaveLength(2);
      const currentFilter = (await readCommands()).find(command => command.title === t('projects.deployments.notBackedUp'))!;
      await invoke(currentFilter.id);
      expect(rowIds(screen)).toHaveLength(3);
      await removePage();
      expect(await executor.execute('ui.current_context.command.invoke', { commandId: currentFilter.id }, context)).toMatchObject({ ok: false });
    } finally { dispose(); }
  });

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
      expect(screen.getTextContent()).toContain('3 environments in 2 projects');
      // The filter sits inline in the list, one press away, never folded into the header's phone overflow (DEPLOY-REACCEPT-1113 D3).
      const { PageHeader } = await import('@/components/ui/layout/PageHeader');
      expect(screen.findAllByType(PageHeader).flatMap((node) => node.findAll((child) =>
        child.props.testID === 'all-deployments.notBackedUp'))).toEqual([]);
      expect(screen.findByTestId('all-deployments.notBackedUp')).not.toBeNull();

      // The chip runs the same mounted command an agent invokes; its effect lands once that command settles.
      await act(async () => {
        await screen.pressByTestIdAsync('all-deployments.notBackedUp');
      });
      await vi.waitFor(async () => {
        await act(async () => {});
        expect(rowIds(screen)).toEqual([
          'all-deployments.row.env-shop-production',
          'all-deployments.row.env-api-production',
        ]);
      });
      // The count line counts what the filter keeps (SERVICES-ACCEPT-1116 F3), not every Environment read.
      expect(screen.findByTestId('all-deployments.header:count')).not.toBeNull();
      expect(screen.getTextContent()).toContain('2 environments in 2 projects');
      expect(screen.getTextContent()).not.toContain('3 environments');

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

  it('does not call hidden uncovered Environments all backed up when search keeps no matches', async () => {
    const { screen, dispose } = await mount({ presented: true });
    try {
      await act(async () => {
        await vi.waitFor(() => expect(screen.findByTestId('all-deployments.notBackedUp')).not.toBeNull());
        await screen.pressByTestIdAsync('all-deployments.notBackedUp');
      });
      expect(rowIds(screen)).toHaveLength(2);
      const header = () => screen.root.findAll((node) => node.props.testID === 'all-deployments.header' && 'search' in node.props)[0]!;
      await act(async () => { header().props.search.onChangeText('no-such-environment'); });
      expect(rowIds(screen)).toHaveLength(0);
      expect(screen.findByTestId('all-deployments.noMatches')).not.toBeNull();
      expect(screen.findByTestId('all-deployments.allBackedUp')).toBeNull();
      await act(async () => { header().props.search.onChangeText(''); });
      expect(rowIds(screen)).toHaveLength(2);
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
      await vi.waitFor(async () => {
        await act(async () => {});
        expect(rowIds(screen)).toEqual([
          'all-deployments.row.env-api-production',
        ]);
      });
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
