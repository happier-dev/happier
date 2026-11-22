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
      noneFound: false,
    },
    ...overrides,
  };
  return <ItemList pageColumn="wide"><TeamSetupPageView {...props} /></ItemList>;
}


const checkout = { id: 'ws-web', serverId: 'home', machineId: 'devbox', rootPath: '/home/mara/code/acme-web', createdAtMs: 1,
  source: { sourceId: 'acme-web', revision: 1 } } as never;

it('says the repositories are ready only when the batch completed its work', async () => {
  const { t } = await import('@/text');
  const ready = t('teams.join.setupPage.repositoriesReady', { machine: 'devbox' });
  const screen = await renderScreen(view({ run: { kind: 'done', operationId: 'op-1', completed: false }, canRun: false }));
  expect(screen.getTextContent()).not.toContain(ready);
  await screen.update(view({ run: { kind: 'done', operationId: 'op-1', completed: true }, canRun: false }));
  expect(screen.getTextContent()).toContain(ready);
  expect(screen.getTextContent()).not.toContain(t('teams.join.setupPage.repositoriesDescription', { machine: 'devbox' }));
});

it('uses the member’s existing checkout instead of offering a fresh clone', async () => {
  const screen = await renderScreen(view({ checkouts: new Map([['acme-web', checkout]]) }));
  expect(screen.getTextContent()).toContain('/home/mara/code/acme-web');
  expect(screen.getTextContent()).not.toContain('/home/mara/src/acme-web');
});

it('says so when a clone search finds nothing', async () => {
  const screen = await renderScreen(view({ clones: {
    onFind: vi.fn(), searching: false, folder: '/home/mara/code', adopted: new Map(), failure: null, noneFound: true,
  } }));
  expect(screen.findByTestId('team-setup-clones-none')).not.toBeNull();
});
