import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { teamProjectSourceFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { createMachineAdministrationTargetSelectionFixture } from '@/dev/testkit/fixtures/machineAdministrationTargetSelectionFixtures';
import { PROJECT_USE_SHARED_SETUP_PARAM } from '@/components/projects/projectSetup/sharedSetupRoute';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
const navigation = vi.hoisted(() => ({ lastHref: null as string | null }));
vi.mock('expo-router', async () => {
  const mock = (await import('@/dev/testkit/mocks/router')).createExpoRouterMock();
  mock.spies.push.mockImplementation((href) => { navigation.lastHref = String(href); });
  return mock.module;
});

const { TeamSetupPageView } = await import('./TeamSetupScreen');
// The page draws inside its ItemList, as TeamSection does, so section actions take the page anatomy.
const { ItemList } = await import('@/components/ui/lists/ItemList');
type ViewProps = React.ComponentProps<typeof TeamSetupPageView>;

afterEach(() => {
  navigation.lastHref = null;
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
  expect(screen.findByTestId('team-setup-partial')).not.toBeNull();
  expect(screen.getTextContent()).not.toContain(ready);
  await screen.update(view({ run: { kind: 'done', operationId: 'op-1', completed: true }, canRun: false }));
  expect(screen.getTextContent()).toContain(ready);
  expect(screen.findByTestId('team-setup-partial')).toBeNull();
  expect(screen.getTextContent()).not.toContain(t('teams.join.setupPage.repositoriesDescription', { machine: 'devbox' }));
});

it('uses the member’s existing checkout instead of offering a fresh clone', async () => {
  const screen = await renderScreen(view({ checkouts: new Map([['acme-web', checkout]]) }));
  expect(screen.getTextContent()).toContain('/home/mara/code/acme-web');
  expect(screen.getTextContent()).not.toContain('/home/mara/src/acme-web');
});

it('opens the Source setup review on the exact adopted checkout before binding its keys', async () => {
  const rootPath = '/home/mara/code/acme-web-adopted';
  const scope = { serverId: 'home', accountId: 'member' };
  const screen = await renderScreen(view({
    repositories: [web],
    requirements: {
      entries: new Map([[web.id, { revision: web.revision, read: { status: 'ready', names: ['DATABASE_URL'] } }]]),
      retry: vi.fn(),
    },
    clones: {
      onFind: vi.fn(), searching: false, folder: '/home/mara/code',
      adopted: new Map([[web.id, rootPath]]), failure: null, noneFound: false,
    },
    batch: {
      selection: {
        team: { serverId: scope.serverId, teamId: 'acme' },
        target: { serverId: scope.serverId, homeId: 'home', machineId: 'devbox' },
        lifetime: { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) },
        repositories: [{ repositoryId: web.id, source: web, requestId: 'open-adopted' }],
      },
      dispatched: new Set([web.id]),
      running: false,
      completed: true,
      settlement: {
        completed: true, machine: null, repositories: [{
          id: web.id, result: { ok: true, result: {
            kind: 'opened', setup: 'notRequired', directory: rootPath,
            workspace: { serverId: scope.serverId, machineId: 'devbox', workspaceId: 'adopted-web', rootPath },
          } },
        }],
      },
    },
  }));
  await screen.pressByTestIdAsync(`team-setup-repository-keys:${web.id}`);
  const href = new URL(navigation.lastHref ?? '/', 'https://app.example.test');
  expect(href.pathname).toBe('/projects/adopted-web/scripts');
  expect(href.searchParams.get('serverId')).toBe(scope.serverId);
  expect(href.searchParams.get(PROJECT_USE_SHARED_SETUP_PARAM)).toBe(web.id);
});

it('says so when a clone search finds nothing', async () => {
  const screen = await renderScreen(view({ clones: {
    onFind: vi.fn(), searching: false, folder: '/home/mara/code', adopted: new Map(), failure: null, noneFound: true,
  } }));
  expect(screen.findByTestId('team-setup-clones-none')).not.toBeNull();
});
