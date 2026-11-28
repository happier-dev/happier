import { act } from 'react-test-renderer';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { Item } from '@/components/ui/lists/Item';
import { createCommittedFiberRenderCounter, readTestRendererRoot } from '@/dev/testkit/performance/committedFiberCounts';
import { Modal } from '@/modal';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { renderMountedCurrentUiContext } from '@/dev/testkit/harness/mountedCurrentUiContext';
import { CurrentUiContextCommandsProvider, useCurrentUiContextComposedCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { usePublishCurrentUiContext } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { CurrentUiContextSnapshotV1Schema } from '@happier-dev/protocol/plugins/ui/currentUiContext';

import { OperationsOutcomeGroup } from './OperationsOutcomeGroup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { OperationsRunOutcomeInput } from '@/sync/domains/workflows/operationsRunOutcome';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);

function Publication() {
  const commands = useCurrentUiContextComposedCommands();
  const enrichment = React.useMemo(() => ({ commands }), [commands]);
  usePublishCurrentUiContext(enrichment);
  return null;
}

const routerMock = vi.hoisted(() => ({ push: null as null | ReturnType<typeof vi.fn>, navigate: null as null | ReturnType<typeof vi.fn> }));

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key: string) => key });
});
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  const mocked = createExpoRouterMock();
  routerMock.push = mocked.spies.push;
  routerMock.navigate = mocked.spies.navigate;
  return mocked.module;
});

const session = { serverId: 'srv', sessionId: 'ses-1' };
const full = '## What failed\n\n- `db push` never ran';
const input = {
  subject: { kind: 'deploymentReceipt', serverId: 'srv', environmentId: 'env', deploymentId: 'dep-1' },
  finding: {
    kind: 'investigate', session,
    result: {
      preview: { state: 'available', text: 'What failed db push never ran' },
      output: { text: full, messageRef: { kind: 'session', session, messageId: 'm-1' } },
      workflowInvocation: null, completedAt: 1,
    },
  },
  produced: {
    pullRequests: [{ title: 'Fix the migration', url: 'https://example.test/pr/12', number: 12, state: 'open' }],
    approvals: [{ serverId: 'srv', status: 'open', request: { artifactId: 'appr-1' } }],
    operations: [{ serverId: 'srv', snapshot: { operationId: 'cmd-1', title: 'pnpm test', state: 'succeeded',
      scope: { machineId: 'm-1' }, domainRef: { kind: 'projectCommand', exitCode: 0 } } }],
    pendingOperations: [],
    receipts: [{ serverId: 'srv', environmentId: 'env', deploymentId: 'new', state: 'succeeded' }],
  },
} as never;

afterEach(async () => {
  vi.restoreAllMocks();
  routerMock.push?.mockClear();
  routerMock.navigate?.mockClear();
  await standardCleanup();
  await homes.reset();
});

describe('OperationsOutcomeGroup', () => {
  it('shows the retained Action consequences beside the finding and keeps the full Session one press away', async () => {
    await loadSyncSingletonForTests();
    const serverId = await homes.addHome({ name: 'Investigation', serverUrl: 'https://investigation-outcome.test', accountId: 'owner', currentAccount: true });
    const address = { serverId, sessionId: 'repair-session' };
    const finding = 'The migration was skipped. The build log confirms it. A database lock is still possible.';
    const input: OperationsRunOutcomeInput = {
      subject: { kind: 'deploymentEnvironment', serverId, environmentId: 'env' },
      finding: { kind: 'investigate', session: address, result: {
        preview: { state: 'available', text: finding }, workflowInvocation: null, completedAt: 1,
      } },
      produced: {
        approvals: [{ serverId, request: { kind: 'approval_request_created', artifactId: 'repair-approval', actionId: 'projects.compute.exec' },
          status: 'open',
          review: { actionId: 'projects.compute.exec', actionArgs: {
            workspace: { serverId, machineId: 'runner', workspaceId: 'workspace', rootPath: '/repo' },
            executable: 'pnpm', argv: ['test:repair'], cwd: '/repo', choice: { kind: 'primary' },
          } } }],
        pullRequests: [], operations: [], pendingOperations: [], receipts: [],
      },
    };
    const screen = await renderScreen(<InjectedAuthProvider credentials={null}>
      <OperationsOutcomeGroup input={input} testID="investigation" />
    </InjectedAuthProvider>);
    expect(screen.findByType(MarkdownView).props.markdown).toBe(finding);
    expect(screen.getTextContent()).toContain('pnpm test:repair');
    await screen.pressByTestIdAsync('investigation.finding');
    await vi.waitFor(() => expect(routerMock.navigate).toHaveBeenCalledWith(
      `/session/repair-session?serverId=${encodeURIComponent(serverId)}`, expect.any(Object),
    ));
  });

  it('publishes exactly its approval navigation and withdraws hidden outcome addresses', async () => {
    const home = await createPlainArtifactHomeFixture('https://workflow-approval-navigation.test');
    try {
      const counter = createCommittedFiberRenderCounter();
      let root: ReturnType<typeof readTestRendererRoot> | undefined;
      function Surface({ visible = true, revision = 0 }) {
        return <CurrentUiContextCommandsProvider authority={captureActiveServerAccountScopeLifetime()}>
          <Publication /><React.Fragment key={revision}>{null}</React.Fragment>
          {visible ? <OperationsOutcomeGroup input={input} testID="o" /> : null}
        </CurrentUiContextCommandsProvider>;
      }
      const measure = (surface: React.ReactNode) => <React.Profiler id="outcome" onRender={() => {
        if (root) counter.onCommitRoot(root());
      }}>{surface}</React.Profiler>;
      const screen = await renderMountedCurrentUiContext(measure(<Surface />));
      root = readTestRendererRoot(screen.tree.root);
      counter.start();
      await screen.update(measure(<Surface revision={1} />));
      expect(counter.read().rendersFor(Item)).toBe(0);
      counter.stop();
      const executor = createDefaultActionExecutor();
      const readCommands = async () => {
        const read = await executor.execute('ui.current_context.read', {}, { surface: 'agent' });
        if (!read.ok) throw new Error('Expected workflow outcome context');
        return CurrentUiContextSnapshotV1Schema.parse(read.result).commands;
      };
      const inventory = await readCommands();
      expect(inventory.map(command => command.title)).toEqual(['workflows.triggers.guided.outcome.proposal']);
      await act(async () => { expect(await executor.execute('ui.current_context.command.invoke',
        { commandId: inventory[0]!.id }, { surface: 'agent' })).toMatchObject({ ok: true }); });
      expect(routerMock.push?.mock.calls.at(-1)?.[0]).toBe('/inbox/approvals/appr-1?serverId=srv');
      await screen.pressByTestIdAsync('o.proposal.link.approval.appr-1');
      expect(routerMock.push?.mock.calls.at(-1)?.[0]).toBe('/inbox/approvals/appr-1?serverId=srv');
      await screen.update(measure(<Surface visible={false} />));
      expect(await readCommands()).toEqual([]);
      expect(await executor.execute('ui.current_context.command.invoke', { commandId: inventory[0]!.id }, { surface: 'agent' }))
        .toMatchObject({ ok: false });
      await screen.unmount();
    } finally { await home.dispose(); }
  });
  async function mount(open = vi.fn()) {
    const screen = await renderScreen(
      <InjectedAuthProvider credentials={null}>
        <OperationsOutcomeGroup input={input} testID="o" openReceipt={{ serverId: 'srv', open }} />
      </InjectedAuthProvider>,
    );
    return { screen, onOpenReceipt: open };
  }

  it('draws the full finding and opens commands, the approval and the receipt where they already live', async () => {
    const show = vi.spyOn(Modal, 'show').mockImplementation(() => 'modal');
    const { screen, onOpenReceipt } = await mount();
    expect(screen.findByType(MarkdownView).props.markdown).toBe(full);

    await screen.pressByTestIdAsync('o.finding.link.operation.cmd-1');
    expect(show.mock.calls[0]?.[0]).toMatchObject({ props: { serverId: 'srv', operationId: 'cmd-1' } });

    await screen.pressByTestIdAsync('o.proposal.link.approval.appr-1');
    expect(routerMock.push?.mock.calls[0]?.[0]).toBe('/inbox/approvals/appr-1?serverId=srv');

    await screen.pressByTestIdAsync('o.applied');
    expect(onOpenReceipt).toHaveBeenCalledWith('env', 'new');
  });

  it('opens the pull request the proposal row names only when its Action is allowed', async () => {
    const serverId = await homes.addHome({ name: 'Workflow outcome', serverUrl: 'https://workflow-outcome.test', accountId: 'owner', currentAccount: true });
    const { storage } = await import('@/sync/domains/state/storageStore');
    await storage.getState().activateSettingsScope({ serverId, accountId: 'owner' });
    const open = vi.fn(() => null);
    vi.stubGlobal('open', open);
    const { screen } = await mount();
    await homes.setActionPolicy(serverId, 'links.openExternal', 'ui', 'off');
    await screen.pressByTestIdAsync('o.proposal');
    expect(open).not.toHaveBeenCalled();
    await homes.setActionPolicy(serverId, 'links.openExternal', 'ui', 'allowed');
    await screen.pressByTestIdAsync('o.proposal');
    expect(open).toHaveBeenCalledWith('https://example.test/pr/12', '_blank', 'noopener,noreferrer');
    vi.unstubAllGlobals();
  });
});
