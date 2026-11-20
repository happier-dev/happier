import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { teamProjectSourceFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { createMachineAdministrationTargetSelectionFixture } from '@/dev/testkit/fixtures/machineAdministrationTargetSelectionFixtures';

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
// The page draws inside its ItemList, as TeamSection does, so section actions take the page anatomy.
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

function view(overrides: Partial<ViewProps>): React.ReactElement {
  const props: ViewProps = {
    header: null,
    teamName: 'Acme',
    selection: createMachineAdministrationTargetSelectionFixture(),
    machineId: 'devbox',
    machineLabel: 'devbox',
    homeDir: '/home/mara',
    run: { kind: 'idle' },
    canRun: true,
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
    },
    ...overrides,
  };
  return <ItemList pageColumn="wide"><TeamSetupPageView {...props} /></ItemList>;
}

it('offers the Team’s first task after Done and opens it only when the member asks', async () => {
  const onOpen = vi.fn();
  const screen = await renderScreen(
    view({
      run: { kind: 'done', operationId: null },
      firstTask: {
        title: 'Fix the cart badge',
        markdown: 'Read the checkout flow and fix the flaky test.',
        repositoryName: 'acme/web',
        onOpen,
      },
    }),
  );
  expect(screen.findByTestId('team-setup-first-task')).not.toBeNull();
  expect(screen.getTextContent()).toContain(
    'Read the checkout flow and fix the flaky test.',
  );
  expect(onOpen).not.toHaveBeenCalled();
  await screen.pressByTestIdAsync('team-setup-first-task-open');
  expect(onOpen).toHaveBeenCalledOnce();
});

it('shows no first task before setup is done', async () => {
  const screen = await renderScreen(
    view({
      firstTask: {
        title: 'Fix the cart badge',
        markdown: 'Task',
        repositoryName: 'acme/web',
        onOpen: vi.fn(),
      },
    }),
  );
  expect(screen.findByTestId('team-setup-first-task')).toBeNull();
});

it('says the Team changed its machine setup since this Machine applied it and leads to the review', async () => {
  const onReview = vi.fn();
  const screen = await renderScreen(
    view({ hasPreset: true, presetChange: { revision: 7, onReview } }),
  );
  expect(screen.findByTestId('team-setup-preset-changed')).not.toBeNull();
  await screen.pressByTestIdAsync('team-setup-preset-changed-review');
  expect(onReview).toHaveBeenCalledOnce();
});

it('finds existing clones on request and shows an adopted clone in place of a fresh clone', async () => {
  const onFind = vi.fn();
  const screen = await renderScreen(
    view({
      clones: {
        onFind,
        searching: false,
        folder: '/home/mara/code',
        failure: null,
        adopted: new Map([['acme-web', '/home/mara/code/acme-web']]),
      },
    }),
  );
  await screen.pressByTestIdAsync('team-setup-find-clones');
  expect(onFind).toHaveBeenCalledOnce();
  // The adopted clone replaces the fresh-clone destination; the other repository still clones fresh.
  expect(screen.getTextContent()).toContain('/home/mara/code/acme-web');
});

it('keeps a folder search failure visible with its reason', async () => {
  const screen = await renderScreen(
    view({
      clones: {
        onFind: vi.fn(),
        searching: false,
        folder: '/home/mara/gone',
        adopted: new Map(),
        failure: 'ENOENT: no such directory',
      },
    }),
  );
  expect(screen.findByTestId('team-setup-clones-failed')).not.toBeNull();
  expect(screen.getTextContent()).toContain('ENOENT: no such directory');
});

it('ends a finished setup on another-machine instead of a disabled Set up button', async () => {
  const onSetUpAnother = vi.fn();
  const screen = await renderScreen(view({ run: { kind: 'done', operationId: 'op-1' }, canRun: false, onSetUpAnother }));
  expect(screen.findByTestId('team-setup-run')).toBeNull();
  // Repositories are opened by then; finding clones belongs to the review before a run.
  expect(screen.findByTestId('team-setup-find-clones')).toBeNull();
  await screen.pressByTestIdAsync('team-setup-another-run');
  expect(onSetUpAnother).toHaveBeenCalledOnce();
});
