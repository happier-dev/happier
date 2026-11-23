import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACTION_ID_FAMILIES_V1 } from '@happier-dev/protocol/actions/actionIds';
import type { PluginUiJsonValueV1 } from '@happier-dev/protocol/plugins/ui';
import { standardCleanup } from '@/dev/testkit';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { renderMountedCurrentUiContext } from '@/dev/testkit/harness/mountedCurrentUiContext';
import { readCurrentUiContextActionReader } from '@/components/appShell/currentUiContext/currentUiContextActionRuntime';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { AgentInputPermissionRequests } from './AgentInputPermissionRequests';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
// The request cards own their decisions and are covered by their own suites; here they only mark which request is shown,
// as in AgentInputPermissionRequests.test.tsx. The dock, its commands and the current-context Action stay real.
vi.mock('@/components/tools/shell/approvals/ApprovalPromptCard', () => ({
  ApprovalPromptCard: (props: { artifact: { id: string } }) =>
    React.createElement('ApprovalPromptCard', {
      artifactId: props.artifact.id,
    }),
}));
vi.mock('@/components/tools/shell/permissions/PermissionPromptCard', () => ({
  PermissionPromptCard: (props: { request: { id: string } }) =>
    React.createElement('PermissionPromptCard', {
      requestId: props.request.id,
    }),
}));

const FOLD_TEST_ID = 'agentInput.permissionRequests.earlierFailures';
const COMMAND_SCOPE = 'composer.attentionRequests.earlierFailures';

type ApprovalRequests = NonNullable<
  React.ComponentProps<typeof AgentInputPermissionRequests>['approvalRequests']
>;
const approval = (id: string, status: 'open' | 'executed') =>
  ({
    artifact: {
      id,
      header: {
        v: 1,
        kind: 'approval_request.v1',
        title: id,
        approvalStatus: status,
        sessionId: 's1',
      },
    },
    approval: {
      v: 1,
      status,
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'agent', sessionId: 's1' },
      requestedSurface: 'agent',
      actionId: 'deployments.environments.create',
      actionArgs: {},
      summary: id,
    },
  }) as unknown as ApprovalRequests[number];

const dock = (approvals: ApprovalRequests) => (
  <AgentInputPermissionRequests
    sessionId="s1"
    permissionRequests={[]}
    approvalRequests={approvals}
    permissionLocationsById={new Map()}
    metadata={null}
    canApprovePermissions={true}
    maxHeightPx={160}
    maxHeightCeilingPx={160}
    onContentSizeChange={() => {}}
    onLayout={() => {}}
    onScroll={() => {}}
  />
);

let home: Awaited<ReturnType<typeof serveActionHomes>> | undefined;
afterEach(async () => {
  await standardCleanup();
  retireActiveServerAccountScopeLifetime();
  await home?.dispose();
  home = undefined;
});

async function mountHome(serverUrl: string) {
  home = await serveActionHomes({
    homes: [{ key: 'a', serverUrl, accountId: 'account-a' }],
    route: (request) =>
      request.path === '/v1/kv/bulk'
        ? Response.json({ values: [] })
        : undefined,
  });
  const server = home.homes.a!;
  publishAppliedActiveServerSnapshot({
    serverId: server.id,
    serverUrl: server.serverUrl,
    generation: 0,
  });
}

const agentCommands = () =>
  readCurrentUiContextActionReader({
    surface: 'agent',
  })!.readCurrentUiContext()!.commands;

describe('approval dock earlier failures through the current-context command', () => {
  it('lets an agent show and hide the folded failures exactly as the row does', async () => {
    await mountHome('https://dock-failures.test');
    const screen = await renderMountedCurrentUiContext(
      dock([
        approval('failed-1', 'executed'),
        approval('failed-2', 'executed'),
        approval('pending', 'open'),
      ]),
    );
    const executor = createDefaultActionExecutor();
    const shownIds = () =>
      screen
        .findAll((node) => String(node.type) === 'ApprovalPromptCard')
        .map((node) => node.props.artifactId);
    const invoke = async (input?: PluginUiJsonValueV1) => {
      const command = agentCommands().find((row) =>
        row.description?.startsWith(COMMAND_SCOPE),
      );
      expect(command).toBeDefined();
      let result: Awaited<ReturnType<typeof executor.execute>> | undefined;
      await act(async () => {
        result = await executor.execute(
          ACTION_ID_FAMILIES_V1.current_ui_context[1],
          {
            commandId: command!.id,
            ...(input === undefined ? {} : { input }),
          },
          { surface: 'agent' },
        );
      });
      return result;
    };

    expect(shownIds()).toEqual(['pending']);
    expect(await invoke({ shown: true })).toMatchObject({ ok: true });
    expect(shownIds()).toEqual(['pending', 'failed-1', 'failed-2']);

    // The row's press goes through the same command: it hides what the agent showed.
    await screen.pressByTestIdAsync(FOLD_TEST_ID);
    await vi.waitFor(() => expect(shownIds()).toEqual(['pending']));

    // Asking for the state it already has changes nothing; an unreadable request is refused.
    expect(await invoke({ shown: false })).toMatchObject({ ok: true });
    expect(shownIds()).toEqual(['pending']);
    expect(await invoke({ shown: 'yes' })).toMatchObject({ ok: false });
    expect(shownIds()).toEqual(['pending']);
  });

  it('offers no command when nothing is folded', async () => {
    await mountHome('https://dock-no-failures.test');
    await renderMountedCurrentUiContext(
      dock([
        approval('failed-1', 'executed'),
        approval('failed-2', 'executed'),
      ]),
    );
    expect(
      agentCommands().find((row) => row.description?.startsWith(COMMAND_SCOPE)),
    ).toBeUndefined();
  });
});
