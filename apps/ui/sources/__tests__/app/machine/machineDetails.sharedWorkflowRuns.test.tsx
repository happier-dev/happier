import 'fake-indexeddb/auto';
import React from 'react';
import { act } from 'react-test-renderer';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { WORKFLOW_RUN_STORAGE_HTTP_PATH } from '@happier-dev/protocol/workflows/workflowRunStorageV1';
import {
  flushHookEffects,
  renderScreen as renderTestScreen,
  standardCleanup,
} from '@/dev/testkit';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
  waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import {
  createMachineFixture,
  createPlainMachineRowFixture,
} from '@/dev/testkit/fixtures/machineFixtures';
import { installBrowserStorageLockBoundary } from '@/dev/testkit/harness/browserStorageLockBoundary';

const { route, confirm, alert } = vi.hoisted(() => ({
  route: { params: {} as Record<string, string> },
  confirm: { result: true, calls: [] as unknown[][] },
  alert: { calls: [] as unknown[][] },
}));
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('react-native-keyboard-controller', () => ({
  useFocusedInputHandler: () => {},
}));
vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
      params: () => route.params,
    }).module,
);
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
);
vi.mock(
  '@/modal',
  async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
      spies: {
        confirm: async (...args) => {
          confirm.calls.push(args);
          return confirm.result;
        },
        alert: (...args) => {
          alert.calls.push(args);
        },
      },
    }).module,
);

const { JSDOM } = await import('jsdom');
const browser = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://machine-shared-runs.test',
});
function installBrowserBoundary() {
  for (const name of [
    'window',
    'document',
    'HTMLElement',
    'Node',
    'MutationObserver',
    'CustomEvent',
    'navigator',
  ] as const) {
    vi.stubGlobal(
      name,
      name === 'window' ? browser.window : browser.window[name],
    );
  }
}
installBrowserBoundary();
afterAll(() => browser.window.close());
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installSessionActionRpcBoundary((request) => {
  if (request.method.endsWith(RPC_METHODS.DAEMON_EXECUTION_RUNS_LIST))
    return { runs: [] };
  throw Object.assign(new Error('Fixture daemon method is unavailable'), {
    code: 'RPC_METHOD_NOT_AVAILABLE',
  });
});
const { loadSyncSingletonForTests } =
  await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { MachinePageScreen } =
  await import('@/components/machines/page/MachinePageScreen');
const { AppPaneProvider } =
  await import('@/components/appShell/panes/AppPaneProvider');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { Item } = await import('@/components/ui/lists/Item');
const { ItemGroup } = await import('@/components/ui/lists/ItemGroup');
const { getStorage } = await import('@/sync/domains/state/storage');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { sync } = await import('@/sync/sync');
const initialState = getStorage().getState();
let connection:
  | Awaited<ReturnType<typeof restoreServerAccountForTest>>
  | undefined;
let releaseLocks: (() => void) | undefined;
let serverId = '';

type MachineRun = Readonly<{
  id: string;
  ownerAccountId: string;
  createdAt: string;
  state: string;
}>;
let machineRuns: MachineRun[] = [];
let cancelAnswer: Readonly<{ status?: number; body: unknown }> = {
  body: { intent: 'cancelled' },
};
const storageInputs: Record<string, unknown>[] = [];

function AccountBoundary({ children }: React.PropsWithChildren) {
  if (!connection) throw new Error('Machine Account is not restored');
  return (
    <InjectedAuthProvider credentials={connection.credentials}>
      <AppPaneProvider>{children}</AppPaneProvider>
    </InjectedAuthProvider>
  );
}
function renderScreen(element: React.ReactElement) {
  return renderTestScreen(element, {
    wrapper: AccountBoundary,
    createNodeMock: () =>
      Object.assign(document.createElement('div'), {
        setNativeProps() {},
        measureInWindow: (
          callback: (
            x: number,
            y: number,
            width: number,
            height: number,
          ) => void,
        ) => callback(0, 0, 300, 100),
      }),
  });
}
type Screen = Awaited<ReturnType<typeof renderScreen>>;
const SECTION_TITLE = 'machineDetailPage.sharedRunsTitle';
function sharedGroups(screen: Screen) {
  return screen
    .findAllByType(ItemGroup)
    .filter((group) => group.props.title === SECTION_TITLE);
}
function sharedRows(screen: Screen) {
  return screen
    .findAllByType(Item)
    .filter(
      (item) =>
        typeof item.props.testID === 'string' &&
        item.props.testID.startsWith('machine-shared-run:'),
    );
}
function stopControl(screen: Screen, runId: string) {
  const control = screen.findAll(
    (node) =>
      node.props.testID === `machine-shared-run-stop:${runId}` &&
      typeof node.props.onPress === 'function',
  )[0];
  if (!control) throw new Error(`No Stop control for ${runId}`);
  return control;
}
function listReads() {
  return storageInputs.filter((input) => input.operation === 'list');
}
function cancels() {
  return storageInputs.filter((input) => input.operation === 'cancel');
}

beforeEach(async () => {
  installBrowserBoundary();
  releaseLocks = installBrowserStorageLockBoundary();
  await homes.reset();
  getStorage().setState(initialState, true);
  confirm.result = true;
  confirm.calls.length = 0;
  alert.calls.length = 0;
  storageInputs.length = 0;
  machineRuns = [];
  cancelAnswer = { body: { intent: 'cancelled' } };
  serverId = await homes.addHome({
    name: 'Studio',
    serverUrl: 'https://machine-shared-runs.test',
    accountId: 'machine-owner',
    currentAccount: true,
  });
  homes.answer(serverId, '/v1/machines', {
    body: [
      createPlainMachineRowFixture({
        id: 'machine-1',
        accountId: 'machine-owner',
      }),
    ],
  });
  homes.answer(serverId, 'POST /v1/user/profiles', {
    body: {
      users: [
        ['guest-mara', 'Mara Chen'],
        ['guest-dev', 'Dev Patel'],
      ].map(([id, name]) => ({
        id,
        name,
        firstName: name,
        lastName: null,
        username: id,
        avatar: null,
        bio: null,
        status: 'none',
        publicKey: null,
      })),
    },
  });
  homes.answer(serverId, WORKFLOW_RUN_STORAGE_HTTP_PATH, {
    select: (input) => {
      const body = input as Record<string, unknown>;
      storageInputs.push(body);
      if (body.operation === 'list') {
        const request = body.request as Record<string, unknown>;
        if (request.projection !== 'machine_control')
          return {
            body: {
              runs: [],
              acceptedEnvelopesByRunId: {},
              keyCensusByRunId: {},
            },
          };
        return {
          body: {
            projection: 'machine_control',
            runs: [],
            metadataByRunId: {},
            machineRuns: [...machineRuns],
          },
        };
      }
      if (body.operation === 'cancel') {
        // Stopped now, or already ended before the Stop arrived: the Run leaves the active list either way.
        machineRuns = machineRuns.filter((run) => run.id !== body.runId);
        return cancelAnswer;
      }
      throw new Error(`Unexpected storage operation ${String(body.operation)}`);
    },
  });
  const credentials = await TokenStorage.getCredentialsForServerUrl(
    'https://machine-shared-runs.test',
  );
  if (!credentials) throw new Error('Machine Home credentials are missing');
  connection = await restoreServerAccountForTest({
    serverUrl: 'https://machine-shared-runs.test',
    accountId: 'machine-owner',
    credentials,
    request: homes.request,
  });
  await sync.awaitBootstrapForegroundAcquisition();
  const machine = createMachineFixture({ activeAt: Date.now() });
  getStorage().setState({
    machines: { [machine.id]: machine },
    machineListByServerId: { [serverId]: [machine] },
  });
  route.params = { id: 'machine-1' };
});
afterEach(async () => {
  standardCleanup();
  await connection?.dispose();
  connection = undefined;
  await homes.reset();
  releaseLocks?.();
  releaseLocks = undefined;
  getStorage().setState(initialState, true);
});

async function renderPage() {
  const screen = await renderScreen(<MachinePageScreen />);
  await waitForHomeGovernance(() =>
    expect(listReads().length).toBeGreaterThan(0),
  );
  await flushHookEffects({ cycles: 6 });
  return screen;
}

describe("Machine page: other people's Workflow Runs on an owned Machine", () => {
  it('names each starter, exposes no link, and stops one Run after confirmation', async () => {
    const createdAt = new Date(Date.now() - 12 * 60_000).toISOString();
    machineRuns = [
      {
        id: 'run-mara',
        ownerAccountId: 'guest-mara',
        createdAt,
        state: 'running',
      },
      {
        id: 'run-dev',
        ownerAccountId: 'guest-dev',
        createdAt,
        state: 'queued',
      },
    ];
    const screen = await renderPage();
    try {
      await waitForHomeGovernance(() =>
        expect(sharedRows(screen).map((row) => row.props.title)).toEqual([
          'Mara Chen',
          'Dev Patel',
        ]),
      );
      expect(sharedGroups(screen)).toHaveLength(1);
      expect(listReads()).toHaveLength(1);
      expect(listReads()[0]!.request).toEqual({
        projection: 'machine_control',
        machineId: 'machine-1',
      });
      // Nothing about the Run itself is readable by the Machine owner: the row opens nothing.
      for (const row of sharedRows(screen))
        expect(row.props.onPress).toBeUndefined();
      expect(screen.getTextContent()).not.toContain('run-mara');

      await act(async () => {
        await stopControl(screen, 'run-mara').props.onPress();
      });
      await waitForHomeGovernance(() =>
        expect(sharedRows(screen).map((row) => row.props.title)).toEqual([
          'Dev Patel',
        ]),
      );
      expect(confirm.calls).toHaveLength(1);
      expect(cancels()).toEqual([
        expect.objectContaining({
          runId: 'run-mara',
          expectedRevision: 0,
          machineId: 'machine-1',
        }),
      ]);
      expect(listReads()).toHaveLength(2);
      expect(alert.calls).toHaveLength(0);
    } finally {
      await screen.unmount();
    }
  });

  it('sends nothing when the owner declines the confirmation', async () => {
    machineRuns = [
      {
        id: 'run-mara',
        ownerAccountId: 'guest-mara',
        createdAt: new Date().toISOString(),
        state: 'running',
      },
    ];
    confirm.result = false;
    const screen = await renderPage();
    try {
      await waitForHomeGovernance(() =>
        expect(sharedRows(screen)).toHaveLength(1),
      );
      await act(async () => {
        await stopControl(screen, 'run-mara').props.onPress();
      });
      await flushHookEffects();
      expect(cancels()).toHaveLength(0);
      expect(sharedRows(screen)).toHaveLength(1);
    } finally {
      await screen.unmount();
    }
  });

  it('renders nothing when no one else runs work on this Machine', async () => {
    const screen = await renderPage();
    try {
      expect(sharedGroups(screen)).toHaveLength(0);
      expect(sharedRows(screen)).toHaveLength(0);
      expect(listReads()).toHaveLength(1);
    } finally {
      await screen.unmount();
    }
  });

  it('removes a Run that already ended and says so', async () => {
    machineRuns = [
      {
        id: 'run-mara',
        ownerAccountId: 'guest-mara',
        createdAt: new Date().toISOString(),
        state: 'running',
      },
      {
        id: 'run-dev',
        ownerAccountId: 'guest-dev',
        createdAt: new Date().toISOString(),
        state: 'running',
      },
    ];
    cancelAnswer = { status: 404, body: { error: 'run_not_found' } };
    const screen = await renderPage();
    try {
      await waitForHomeGovernance(() =>
        expect(sharedRows(screen)).toHaveLength(2),
      );
      await act(async () => {
        await stopControl(screen, 'run-mara').props.onPress();
      });
      await waitForHomeGovernance(() =>
        expect(sharedRows(screen).map((row) => row.props.title)).toEqual([
          'Dev Patel',
        ]),
      );
      expect(cancels()).toHaveLength(1);
      expect(alert.calls).toHaveLength(1);
      expect(listReads()).toHaveLength(2);
    } finally {
      await screen.unmount();
    }
  });
});
