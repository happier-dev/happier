import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { ACTION_ID_FAMILIES_V1 } from '@happier-dev/protocol/actions/actionIds';
import type { PluginUiJsonValueV1 } from '@happier-dev/protocol/plugins/ui';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { createDeferred, standardCleanup } from '@/dev/testkit';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { renderMountedCurrentUiContext } from '@/dev/testkit/harness/mountedCurrentUiContext';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { readCurrentUiContextActionReader } from '@/components/appShell/currentUiContext/currentUiContextActionRuntime';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { StoreProjectScopeChip } from './StoreProjectScopeChip';

const router = vi.hoisted(() => ({
  current: null as null | ReturnType<
    typeof import('@/dev/testkit/mocks/router').createExpoRouterMock
  >,
}));
vi.mock('expo-router', async () => {
  const mock = (
    await import('@/dev/testkit/mocks/router')
  ).createExpoRouterMock();
  router.current = mock;
  return mock.module;
});
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
// The anchored portal is the DOM boundary; the chip, its list and command publication stay real.
vi.mock('@/components/ui/popover', async (importOriginal) =>
  (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(
    importOriginal,
    { maxHeight: 600, maxWidth: 400, placement: 'bottom' },
  ),
);

let home: Awaited<ReturnType<typeof serveActionHomes>> | undefined;
afterEach(async () => {
  await standardCleanup();
  retireActiveServerAccountScopeLifetime();
  await home?.dispose();
  home = undefined;
  vi.unstubAllGlobals();
});

/**
 * The one Store Project chip heads Discover, Installed, every kind page, Search and Updates. Opened cold it joins the
 * Account's census once and lists every Project; an agent chooses the scope through the same mounted commands, and the
 * choice goes through the route-owned setter.
 */
it('lists both Account Projects from one census when the Store Project chip opens cold, and an agent selects one', async () => {
  const censusPath = `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`;
  const census = createDeferred<void>();
  let censusReads = 0;
  // Until the chip opens, the Account's census has not answered (the Store page opened before any Project read).
  let answering = false;
  let serverId = '';
  home = await serveActionHomes({
    homes: [
      {
        key: 'a',
        serverUrl: 'https://store-project-chip.test',
        accountId: 'account-a',
      },
    ],
    route: async (request) => {
      if (request.path === '/v1/kv/bulk') return Response.json({ values: [] });
      if (request.path !== censusPath) return undefined;
      censusReads += 1;
      if (!answering) return Response.json({ error: 'unavailable' }, { status: 503 });
      await census.promise;
      return Response.json(
        createPlainProjectAccountRowListFixture({
          workspaceRefs: ['alpha', 'beta'].map((projectKey) => ({
            id: `workspace-${projectKey}`,
            serverId,
            machineId: 'machine-alpha',
            rootPath: `/${projectKey}`,
            label: projectKey,
            projectKey,
            createdAtMs: 1,
          })),
        }),
      );
    },
  });
  const server = home.homes.a!;
  serverId = server.id;
  publishAppliedActiveServerSnapshot({
    serverId: server.id,
    serverUrl: server.serverUrl,
    generation: 0,
  });
  const executor = createDefaultActionExecutor();
  const commands = () =>
    readCurrentUiContextActionReader({
      surface: 'agent',
    })!.readCurrentUiContext()!.commands;
  let invocation = 0;
  const invoke = async (key: string, input?: PluginUiJsonValueV1) => {
    const command = await vi.waitFor(() => {
      const selected = commands().find((row) =>
        row.description?.startsWith(`store.projectScope.${key}`),
      );
      expect(
        selected,
        JSON.stringify(commands().map((row) => row.description)),
      ).toBeDefined();
      return selected!;
    });
    await act(async () => {
      const outcome = await executor.execute(
        ACTION_ID_FAMILIES_V1.current_ui_context[1],
        { commandId: command.id, ...(input === undefined ? {} : { input }) },
        {
          surface: 'agent',
          authority: 'account_automation',
          expectedAccountId: 'account-a',
          actionRequestId: `store-project-chip-${++invocation}`,
        },
      );
      expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true });
    });
  };
  const screen = await renderMountedCurrentUiContext(<StoreProjectScopeChip />);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  answering = true;
  const beforeOpen = censusReads;
  await invoke('open');
  // Opening the chip's menu demands the census once.
  await waitForHomeGovernance(() => expect(censusReads).toBe(beforeOpen + 1));
  // Unconfirmed, the menu says so instead of offering only "All projects".
  expect(screen.findByTestId('store.projectPicker.status')).not.toBeNull();
  await act(async () => {
    census.resolve();
  });
  await waitForHomeGovernance(() => {
    const text = screen.getTextContent();
    expect(text).toContain('alpha');
    expect(text).toContain('beta');
  });
  expect(censusReads).toBe(beforeOpen + 1);
  // The scope is the route's: the mounted list command chooses through the same setter as a tap.
  const activate = commands().find((row) =>
    row.description?.startsWith('store.projectScope.list.activate'),
  );
  const betaId = JSON.stringify({ serverId: server.id, projectKey: 'beta' });
  expect(activate?.description).toContain(JSON.stringify(betaId).slice(1, -1));
  router.current!.spies.setParams.mockClear();
  await invoke('list.activate', { id: betaId });
  await waitForHomeGovernance(() =>
    expect(router.current!.spies.setParams).toHaveBeenCalledWith({
      project: betaId,
    }),
  );
  await screen.unmount();
});
