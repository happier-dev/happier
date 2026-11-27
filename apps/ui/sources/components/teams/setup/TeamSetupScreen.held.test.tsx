import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { ActionOperationSnapshotV1Schema } from '@happier-dev/protocol/actions/operations/v1';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { teamProjectSourceFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { createProjectSetupReviewFixture } from '@/dev/testkit/fixtures/projectSetupReview';
import { createMachineAdministrationTargetSelectionFixture } from '@/dev/testkit/fixtures/machineAdministrationTargetSelectionFixtures';
import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
);

const { TeamSetupPageView } = await import('./TeamSetupScreen');
const { ItemList } = await import('@/components/ui/lists/ItemList');
type ViewProps = React.ComponentProps<typeof TeamSetupPageView>;

afterEach(() => {
  standardCleanup();
});

const web = teamProjectSourceFixture({
  id: 'acme-web',
  name: 'Web',
  nameWithOwner: 'acme/web',
  teamId: 'acme',
});
const api = teamProjectSourceFixture({
  id: 'acme-api',
  name: 'API',
  nameWithOwner: 'acme/api',
  teamId: 'acme',
});

// A Project preparation held for the person's setup consent on the checkout of acme/api, as the operation owner keeps it.
const held: ActionOperationProjection = {
  serverId: 'home',
  observation: 'available',
  isUnavailableProjection: false,
  snapshot: ActionOperationSnapshotV1Schema.parse({
    version: 1,
    operationId: 'held-setup',
    revision: 1,
    actionId: 'projects.prepare',
    state: 'accepted',
    scope: { accountId: 'account-1', machineId: 'devbox' },
    title: 'Set up a project',
    createdAt: 100,
    cancellation: 'supported',
    domainRef: {
      kind: 'projectCommand',
      purpose: 'setup',
      serverId: 'home',
      machineId: 'devbox',
      workspaceRefId: 'checkout-api',
      cwd: '/home/mara/acme/api',
      sourceWorkspace: {
        serverId: 'home',
        machineId: 'devbox',
        workspaceId: 'checkout-api',
        rootPath: '/home/mara/acme/api',
      },
    },
    setupReview: {
      kind: 'pendingApproval',
      code: 'project_setup_consent_required',
      ...createProjectSetupReviewFixture(['npm ci']),
    },
  }),
};

function view(overrides: Partial<ViewProps>): React.ReactElement {
  const props: ViewProps = {
    header: null,
    teamName: 'Acme',
    selection: createMachineAdministrationTargetSelectionFixture(),
    machineId: 'devbox',
    machineLabel: 'devbox',
    homeDir: '/home/mara',
    run: { kind: 'idle' },
    canRun: false,
    onRun: vi.fn(),
    onOpenOperation: vi.fn(),
    sources: { loading: false, failure: null, onRetry: vi.fn() },
    hasPreset: false,
    machinePlan: null,
    repositories: [web, api],
    repositoryFreeSources: [],
    excluded: new Set(),
    onToggleRepository: vi.fn(),
    batch: null,
    sharedKeys: [],
    keyDisplayNames: {},
    firstTask: null,
    presetChange: null,
    clones: {
      onFind: vi.fn(),
      searching: false,
      folder: null,
      adopted: new Map(),
      failure: null,
      noneFound: false,
    },
    ...overrides,
  };
  return (
    <ItemList pageColumn="wide">
      <TeamSetupPageView {...props} />
    </ItemList>
  );
}

it('keeps Before you start on a held review, points to that review from the rail and locks the includes', async () => {
  const onOpenOperation = vi.fn();
  const screen = await renderScreen(
    view({ heldReviews: new Map([[api.id, held]]), onOpenOperation }),
  );
  try {
    // The rail stays (no column collapse) and names the one place the person acts, instead of a Run with nothing to commit.
    expect(screen.findByTestId('team-setup-before')).not.toBeNull();
    expect(screen.findByTestId('team-setup-run')).toBeNull();
    expect(screen.findByTestId('team-setup-held')).not.toBeNull();
    await screen.pressByTestIdAsync('team-setup-held-review');
    expect(onOpenOperation).toHaveBeenCalledExactlyOnceWith('held-setup');
    // The other repository's include waits with the held one: nothing on the page can commit it now.
    expect(
      screen.findByTestId(`team-setup-repository-include:${web.id}`)?.props
        .disabled,
    ).toBe(true);
    expect(
      screen.findByTestId(`team-setup-repository-include:${api.id}`),
    ).toBeNull();
  } finally {
    await screen.unmount();
  }
});

it('offers Run with live includes when nothing is held', async () => {
  const screen = await renderScreen(view({ canRun: true }));
  try {
    expect(screen.findByTestId('team-setup-run')).not.toBeNull();
    expect(screen.findByTestId('team-setup-held')).toBeNull();
    expect(
      screen.findByTestId(`team-setup-repository-include:${web.id}`)?.props
        .disabled,
    ).toBe(false);
  } finally {
    await screen.unmount();
  }
});

it('holds the plan behind one loading line until its first reads settle, so its sections land together', async () => {
  // The cold page drew its rows, then each section's own read pushed the rows below it down (69 px for an
  // Environment row). While arriving, one line stands for the plan and the rail offers no Run yet.
  const held = await renderScreen(view({ arriving: true, canRun: true }));
  try {
    expect(held.findByTestId('team-setup-sources-loading')).not.toBeNull();
    // The rows mount hidden so their own checkout reads answer before the plan shows.
    expect(held.findByTestId('team-setup-repositories-frame')?.props.style).toMatchObject({ visibility: 'hidden' });
    expect(held.findByTestId('team-setup-run')).toBeNull();
    expect(held.findByTestId('team-setup-before')).not.toBeNull();
  } finally {
    await held.unmount();
  }
  const arrived = await renderScreen(view({ arriving: false, canRun: true }));
  try {
    expect(arrived.findByTestId('team-setup-sources-loading')).toBeNull();
    expect(arrived.findByTestId('team-setup-repositories-frame')?.props.style).toBeUndefined();
    expect(arrived.findByTestId('team-setup-run')).not.toBeNull();
  } finally {
    await arrived.unmount();
  }
});
