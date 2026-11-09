import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createScmCapabilities,
  type ScmWorkingSnapshot,
} from '@happier-dev/protocol/scm';
import { ScmPullRequestSummarySchema } from '@happier-dev/protocol/scm/pullRequests';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import {
  createMachineFixture,
  createSessionFixture,
  flushHookEffects,
  renderScreen,
} from '@/dev/testkit';
import { installSessionDetailsPanelCommonModuleMocks } from '@/components/sessions/panes/sessionDetailsPanelTestHelpers';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { storage } from '@/sync/domains/state/storageStore';

installSessionDetailsPanelCommonModuleMocks({
  text: async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
  },
});

vi.mock('@/components/ui/popover', async (importOriginal) =>
  (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(
    importOriginal,
  ),
);
vi.mock('socket.io-client', async (importOriginal) =>
  (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
  ).createSocketIoClientBoundary(importOriginal),
);

const pullRequest = ScmPullRequestSummarySchema.parse({
  provider: {
    id: 'github',
    kind: 'github',
    displayName: 'GitHub',
    baseUrl: 'https://github.com',
    repositoryWebUrl: 'https://github.com/acme/repo',
    nameWithOwner: 'acme/repo',
  },
  number: 2493,
  url: 'https://github.com/acme/repo/pull/2493',
  title: 'Retry the relay',
  headBranch: 'relay-retry',
  baseBranch: 'main',
  state: 'open',
});

const rpc = vi.fn(async (method: string): Promise<unknown> => {
  if (method === RPC_METHODS.SCM_BRANCH_LIST)
    return {
      success: true,
      branches: [
        { name: 'relay-retry', type: 'local', isCurrent: true, upstream: null },
      ],
    };
  if (method === RPC_METHODS.SCM_STASH_LIST)
    return { success: true, stashes: [] };
  return { success: false, errorCode: 'FEATURE_UNSUPPORTED' };
});
const runtime = installSessionPaneRuntimeTestHarness({ rpc });
const externalOpen = vi.fn();

function snapshotFixture(
  overrides: Partial<ScmWorkingSnapshot> = {},
): ScmWorkingSnapshot {
  return {
    fetchedAt: 1,
    projectKey: 'm1:/repo',
    repo: {
      isRepo: true,
      rootPath: '/repo',
      backendId: 'git',
      mode: '.git',
      remotes: [{ name: 'origin', fetchUrl: 'git@github.com:acme/repo.git' }],
      worktrees: [],
    },
    capabilities: createScmCapabilities({
      readStatus: true,
      readBranches: true,
      writeBranchCheckout: true,
    }),
    branch: {
      head: 'relay-retry',
      upstream: null,
      ahead: 0,
      behind: 0,
      detached: false,
    },
    stashCount: 0,
    hasConflicts: false,
    entries: [],
    totals: {
      includedFiles: 0,
      pendingFiles: 0,
      untrackedFiles: 0,
      includedAdded: 0,
      includedRemoved: 0,
      pendingAdded: 0,
      pendingRemoved: 0,
    },
    ...overrides,
  };
}

function publishSnapshot(snapshot: ScmWorkingSnapshot) {
  storage
    .getState()
    .updateSessionProjectScmSnapshot('s1', snapshot, runtime.serverId);
}

const session = () => storage.getState().sessions.s1!;

beforeEach(() => {
  vi.stubGlobal('open', externalOpen);
  externalOpen.mockClear();
  rpc.mockClear();
  storage
    .getState()
    .applySessions([
      createSessionFixture({
        id: 's1',
        serverId: runtime.serverId,
        active: true,
        metadata: { machineId: 'm1', path: '/repo', host: 'test-machine' },
      }),
    ]);
  storage
    .getState()
    .applyMachines(
      [
        createMachineFixture({
          id: 'm1',
          storageMode: 'plain',
          activeAt: Date.now(),
        }),
      ],
      true,
      { sourceServerId: runtime.serverId },
    );
  storage
    .getState()
    .applySettingsLocal({ scmResourceOpenLocation: 'github' });
});

describe('Companion Running section header', () => {
  it('counts every running item by kind, says nothing for a kind with none, and draws nothing when idle', async () => {
    const { formatRunningSectionCount } = await import('./glanceModels');
    expect(formatRunningSectionCount({ agents: 2, services: 2 })).toBe(
      'sessionCompanion.sections.agentsCount(count=2) · sessionCompanion.sections.servicesCount(count=2)',
    );
    expect(formatRunningSectionCount({ agents: 5, services: 0 })).toBe('sessionCompanion.sections.agentsCount(count=5)');
    expect(formatRunningSectionCount({ agents: 0, services: 1 })).toBe('sessionCompanion.sections.servicesCount(count=1)');
    expect(formatRunningSectionCount({ agents: 0, services: 0 })).toBeNull();
  });
});

describe('Companion Links section', () => {
  async function renderLinks() {
    const { LinksGlance } = await import('./LinksGlance');
    const screen = await renderScreen(
      <runtime.Wrapper>
        <LinksGlance
          sessionId="s1"
          serverId={runtime.serverId}
          frameStyle="plain"
          measurementOnly={false}
          testID="links"
        />
      </runtime.Wrapper>,
    );
    await flushHookEffects({ cycles: 3, turns: 3 });
    return screen;
  }

  it('adds the open pull request the working snapshot carries, and opens it through the resource owner', async () => {
    publishSnapshot(
      snapshotFixture({
        pullRequestStatus: {
          provider: pullRequest.provider,
          headBranch: 'relay-retry',
          baseBranch: 'main',
          authState: 'authenticated',
          checkedAt: 1,
          openPullRequest: pullRequest,
        } as ScmWorkingSnapshot['pullRequestStatus'],
      }),
    );
    const screen = await renderLinks();
    expect(screen.findByTestId('links.repository')).not.toBeNull();
    expect(screen.findByTestId('links.pullRequest')).not.toBeNull();
    expect(screen.getTextContent()).toContain(
      'sessionCompanion.sections.pullRequest',
    );
    await screen.pressByTestIdAsync('links.pullRequest');
    await vi.waitFor(() =>
      expect(externalOpen).toHaveBeenCalledWith(
        pullRequest.url,
        expect.anything(),
        expect.anything(),
      ),
    );
  });

  it('draws no pull request row when none is open', async () => {
    publishSnapshot(snapshotFixture());
    const screen = await renderLinks();
    expect(screen.findByTestId('links.repository')).not.toBeNull();
    expect(screen.findByTestId('links.pullRequest')).toBeNull();
  });
});

describe('Companion Environment section', () => {
  async function renderEnvironment(measurementOnly = false) {
    const { EnvironmentGlance } = await import('./EnvironmentGlance');
    const onOpenPane = vi.fn();
    const screen = await renderScreen(
      <runtime.Wrapper>
        <EnvironmentGlance
          session={session()}
          sessionId="s1"
          serverId={runtime.serverId}
          frameStyle="plain"
          measurementOnly={measurementOnly}
          onOpenPane={onOpenPane}
          testID="environment"
        />
      </runtime.Wrapper>,
    );
    await flushHookEffects({ cycles: 3, turns: 3 });
    return { screen, onOpenPane };
  }

  it('switches branch in place: the row opens the branch list and leaves the Git pane closed', async () => {
    publishSnapshot(snapshotFixture());
    const { WorkspaceScmBranchPopover } =
      await import('@/components/workspaces/scm/branches/WorkspaceScmBranchPopover');
    const { screen, onOpenPane } = await renderEnvironment();
    await screen.pressByTestIdAsync('environment.branch');
    await flushHookEffects({ cycles: 3, turns: 3 });
    expect(screen.findByType(WorkspaceScmBranchPopover)?.props.open).toBe(true);
    expect(onOpenPane).not.toHaveBeenCalled();
    expect(
      rpc.mock.calls.some(([method]) => method === RPC_METHODS.SCM_BRANCH_LIST),
    ).toBe(true);
  });

  it('starts no branch read until the row is opened, and a measuring pass draws no control', async () => {
    publishSnapshot(snapshotFixture());
    const { WorkspaceScmBranchPopover } =
      await import('@/components/workspaces/scm/branches/WorkspaceScmBranchPopover');
    const { screen } = await renderEnvironment();
    expect(rpc).not.toHaveBeenCalled();
    await screen.unmount();
    const measuring = await renderEnvironment(true);
    expect(measuring.screen.findByTestId('environment.branch')).not.toBeNull();
    expect(
      measuring.screen.findAllByType(WorkspaceScmBranchPopover),
    ).toHaveLength(0);
  });
});
