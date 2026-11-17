import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUILTIN_WORKFLOW_CATALOG_V1} from '@happier-dev/protocol/workflows/builtins/catalog';
import {
  WORKFLOW_STARTER_EXAMPLES_V1} from '@happier-dev/protocol/workflows/builtins/examples';
import {
  PluginProjectionV2Schema} from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import {
  WorkflowDefinitionV1Schema} from '@happier-dev/protocol/workflows/workflowV1';
import {
  encodePlainArtifactStoredContent, decodePlainArtifactStoredContent} from '@happier-dev/protocol/storage/artifactStoredContent';
import {
  ActionIdSchema} from '@happier-dev/protocol/actions/actionIds';
import {
  StrictJsonValueSchema} from '@happier-dev/protocol/json/strictJsonValue';
import {
  createWorkflowAccountRunActionOwner} from '@happier-dev/protocol/actions/executor/workflowRunActions';
import {
  openWorkflowAcceptedSnapshotStoredEnvelopeV1,
  parseWorkflowStoredContentEnvelopeV1} from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import {
  AutomationDefinitionListRequestSchema,
} from '@happier-dev/protocol/automations/automationApiV3';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { zodSchemaToJsonSchemaObject } from '@happier-dev/protocol/actions/actionInputJsonSchema';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { readWorkflowDefinitionDraftSeed } from '@/sync/domains/workflows/workflowDefinitionDraftSeed';
import { createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { t } from '@/text';
import {
  createDeferred,
  findAllHostTestInstances,
  pressTestInstanceAsync,
  renderHook,
  renderScreen,
  standardCleanup,
} from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { reportCollectionLayout } from '@/dev/testkit/harness/collectionLayoutHarness';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { installShippedNativeFrameScheduler } from '@/dev/testkit/legend/shippedNativeLegendRuntime';
import {
  installDisconnectedServerSocketBoundary,
  restoreServerAccountForTest,
} from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { WorkflowRunStartRequestV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';

let modals: ReturnType<typeof useModal>['state']['modals'] = [];
function ObserveModals() {
  modals = useModal().state.modals;
  return null;
}
const withPanes = ({ children }: React.PropsWithChildren) => (
  <ModalProvider>
    <ObserveModals />
    <AppPaneProvider>{children}</AppPaneProvider>
  </ModalProvider>
);

const machineRpc = vi.hoisted(() => vi.fn());
const routing = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
const routeParams = vi.hoisted(() => ({
  id: 'plugin:example.recipe/check',
  intent: undefined as string | undefined,
}));
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock({ params: routeParams, router: routing }).module;
});
vi.mock(
  '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
  () => ({ machineRpcWithServerScope: machineRpc }),
);
installDisconnectedServerSocketBoundary();
// Install transports before any screen, modal chrome or store-facing runtime consumer.
const { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } =
  await import('@/sync/api/capabilities/serverFeaturesClient');
const { storage } = await import('@/sync/domains/state/storageStore');
const { ModalProvider, useModal } = await import('@/modal/ModalProvider');
const { Modal } = await import('@/modal');
const { WorkflowsLibraryHome } =
  await import('../library/WorkflowsLibraryHome');
const { SavedWorkflowRoute } = await import('@/app/(app)/workflows/[id]/index');
const { useSessionBuiltinWorkflowStart } =
  await import('@/components/sessions/agents/launch/useSessionBuiltinWorkflowStart');
const { SessionAgentsLaunchMenu } =
  await import('@/components/sessions/agents/launch/SessionAgentsLaunchMenu');
const { DropdownMenu } =
  await import('@/components/ui/forms/dropdown/DropdownMenu');
const { WorkflowStartPicker } = await import('./WorkflowStartPicker');
const { WorkflowRunComposer } = await import('./WorkflowRunComposer');
const { resetWorkflowLibraryReadsForTests } =
  await import('../library/workflowLibraryReads');
const { WorkflowsColumnActions } =
  await import('../column/WorkflowsColumnActions');
const { AppPaneProvider } =
  await import('@/components/appShell/panes/AppPaneProvider');
const { clearDaemonMergedProjectionCacheForTests } =
  await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { createWorkflowDefinition } =
  await import('@/sync/domains/workflows/workflowDefinitionActions');
const { SelectionList } = await import('@/components/ui/selectionList');
const { WorkflowExamplesSection } =
  await import('../library/WorkflowExamplesSection');
vi.mock('react-native', async () => {
  const { createReactNativeNativeMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeNativeMock({ platformOS: 'ios' });
});
// Test Renderer cannot measure a native page span. Keep the real windowing owner and supply its host geometry.
vi.mock('@/components/widgets/nearViewport', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/components/widgets/nearViewport')>();
  return { ...original, createScrollViewNearViewportTracker: (...args: Parameters<typeof original.createScrollViewNearViewportTracker>) => ({
    ...original.createScrollViewNearViewportTracker(...args), measureSpan: async () => ({ top: 0 }),
  }) };
});
// The native recycler is a platform boundary; Collection and its rows remain real.
vi.mock('@legendapp/list/react-native', async (original) => (await import('@/dev/testkit/mocks/legendList'))
  .createCapturingLegendListMock({ original: await original<Record<string, unknown>>() }).module);
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock();
});

let previousState = storage.getState();
let home: Awaited<ReturnType<typeof serveActionHomes>>;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
let artifactAccountId: string | null = null;
const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => artifactAccountId, encryptionMode: 'plain' });
type StartRequest = Parameters<
  Extract<Parameters<typeof createExternalActionAccountHttpBoundary>[0],
    { requesterInvocation?: 'required' }>['execute']
>[1] & {
  input: ReturnType<typeof WorkflowRunStartRequestV1Schema.parse>;
};
const startRequests: StartRequest[] = [];
let executeStart: ((request: StartRequest) => Promise<unknown>) | null = null;
let delayedRead: Promise<Response> | null = null;
let artifactReadStatus: number | null = null;
let startRefusal: Readonly<{ errorCode: string; error: string }> | null = null;
const plugin = {
  workflow: 'plugin:example.recipe/check',
  pluginId: 'example.recipe',
  version: '1.2.3',
  title: 'Check changes',
  // Daemon discovery decodes authored contributions through this same schema.
  definition: WorkflowDefinitionV1Schema.parse(BUILTIN_WORKFLOW_CATALOG_V1[0]!.definition),
};
function installPluginProjection() {
  machineRpc.mockImplementation(
    async (request: { method: string; payload: Record<string, unknown> }) => {
      if (
        request.method ===
        RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
      ) {
        return {
          protocolVersion: 1,
          projection: PluginProjectionV2Schema.parse({
            v: 2,
            generation: 1,
            installedPackagesById: {
              [plugin.pluginId]: {
                id: plugin.pluginId,
                displayName: plugin.title,
                version: plugin.version,
                enabled: true,
                source: { kind: 'path', locator: '/plugins/example.recipe' },
              },
            },
            familiesById: {
              workflows: {
                family: 'workflows',
                entriesById: {
                  'example.recipe/check': {
                    id: 'example.recipe/check',
                    pluginId: plugin.pluginId,
                    pluginVersion: plugin.version,
                    definition: {
                      id: 'check',
                      title: plugin.title,
                      definition: plugin.definition,
                    },
                  },
                },
              },
            },
          }),
        };
      }
      throw new Error(`Unexpected workflow machine RPC: ${request.method}`);
    },
  );
}
function writes() {
  return home.requests.filter((request) => {
    if (request.method === 'GET') return false;
    // POST also carries selected Artifact reads; these paths never mutate storage.
    if (
      request.method === 'POST' &&
      [
        '/v1/artifacts/read',
        '/v3/automations/query',
        '/v1/plugins/availability/materializations/read',
        '/v1/plugins/availability/intents/list',
      ].includes(request.path)
    )
      return false;
    // The Project row census is a POST read; /project-rows/mutate must still count as a write.
    if (
      request.method === 'POST' &&
      request.path === '/v1/account/project-rows/list'
    )
      return false;
    const body = request.body as { operation?: string } | undefined;
    return (
      request.path !== '/v3/automations/runs/workflow-storage' ||
      !['list', 'summaries'].includes(body?.operation ?? '')
    );
  });
}
function starts() {
  return startRequests;
}
function habitSessionFixture() {
  const base = createSessionFixture({
    serverId: storage.getState().profileScope!.serverId,
  });
  if (!base.metadata)
    throw new Error('Session fixture metadata is unavailable');
  return createSessionFixture({
    ...base,
    metadata: {
      ...base.metadata,
      flavor: 'claude',
      claudeSessionId: 'native-session-1',
    },
  });
}
async function seedUnavailableWorkflowDefinitions() {
  const ids = {
    missingTitle: '00000000-0000-4000-8000-000000000011',
    badBody: '00000000-0000-4000-8000-000000000012',
    readable: '00000000-0000-4000-8000-000000000013',
  };
  for (const [definitionId, title] of [
    [ids.missingTitle, 'Title to corrupt'],
    [ids.badBody, 'Unavailable recipe'],
    [ids.readable, 'Readable recipe'],
  ] as const) {
    await createWorkflowDefinition({
      definitionId,
      definition: plugin.definition,
      metadata: { title },
    });
  }
  const missingTitle = artifacts.read(ids.missingTitle);
  const badBody = artifacts.read(ids.badBody);
  if (!missingTitle || !badBody)
    throw new Error('Actual workflow Artifact writes are unavailable');
  // Corrupt Home storage bytes, not the Action result: the real Artifact
  // codec and workflow document reader decide the per-row refusal.
  artifacts.replaceStoredRow({
    ...missingTitle,
    header: encodePlainArtifactStoredContent({
      kind: 'workflow-definition.v1',
    }),
  });
  // A library row is a header summary; only a legacy header (written before its step labels) has
  // its body opened by the list, so that is where an unreadable body still shows as unavailable.
  const { previewSteps: _labels, ...legacyHeader } = decodePlainArtifactStoredContent(badBody.header) as Record<string, unknown>;
  artifacts.replaceStoredRow({
    ...badBody,
    header: encodePlainArtifactStoredContent(legacyHeader),
    body: encodePlainArtifactStoredContent({ body: 'invalid-workflow-json' }),
  });
  home.requests.length = 0;
  return ids;
}
beforeEach(async () => {
  installShippedNativeFrameScheduler();
  modals = [];
  routeParams.id = 'plugin:example.recipe/check';
  routeParams.intent = undefined;
  previousState = storage.getState();
  artifacts.clear();
  startRequests.length = 0;
  executeStart = null;
  delayedRead = null;
  artifactReadStatus = null;
  startRefusal = null;
  machineRpc.mockReset();
  machineRpc.mockResolvedValue({
    protocolVersion: 1,
    projection: PluginProjectionV2Schema.parse({ v: 2, generation: 1 }),
  });
  connection = await restoreServerAccountForTest({
    serverUrl: 'http://workflow-picker.test',
    accountId: 'workflow-picker-account',
  });
  const serverIdentityId = 'srv_workflow-picker-home';
  const runAction = await createExternalActionAccountHttpBoundary({
    serverUrl: 'http://workflow-picker.test',
    serverIdentityId,
    accountId: 'workflow-picker-account',
    machineId: 'machine-1',
    actionId: 'workflow.run.start',
    tokenEpoch: 0,
    failure: () => startRefusal,
    execute: (raw, context) => {
      const input = WorkflowRunStartRequestV1Schema.parse(raw);
      startRequests.push({ input, ...context });
      if (executeStart) return executeStart({ input, ...context });
      return {
        admission: 'created',
        run: createWorkflowRunSummaryFixture({
          id: input.runId,
          ownerAccountId: 'workflow-picker-account',
          origin: { kind: 'direct' },
        }),
      };
    },
  });
  home = await serveActionHomes({
    homes: [
      {
        key: 'picker',
        serverUrl: 'http://workflow-picker.test',
        accountId: 'workflow-picker-account',
        serverIdentityId,
        currentAccount: true,
      },
    ],
    route: async (request) => {
      const actionResponse = await runAction.handle(request.url, {
        method: request.method,
        headers: request.headers,
        ...(request.body === undefined
          ? {}
          : { body: JSON.stringify(request.body) }),
        signal: request.signal,
      });
      if (actionResponse) return actionResponse;
      if (
        request.path === '/v1/features' ||
        request.path === '/v1/features/authenticated'
      )
        return Response.json(createRootLayoutFeaturesResponse());
      if (request.path === '/v1/artifacts') {
        if (request.method !== 'POST' && artifactReadStatus !== null)
          return new Response('{}', { status: artifactReadStatus });
        if (request.method !== 'POST' && delayedRead) {
          const response = await delayedRead;
          if (!response.ok) return response;
        }
      }
      if (request.path === '/v1/artifacts' || request.path.startsWith('/v1/artifacts/')) {
        artifactAccountId = request.accountId;
        return await artifacts.handle(`${request.path}${request.url.search}`, {
          method: request.method,
          ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
          signal: request.signal,
        }) ?? undefined;
      }
      if (request.path === '/v3/automations')
        return Response.json({ automations: [], nextCursor: null });
      if (request.path === '/v3/automations/query' && request.method === 'POST') {
        AutomationDefinitionListRequestSchema.parse(request.body);
        return Response.json({ automations: [], nextCursor: null });
      }
      if (request.path === '/v3/automations/runs/workflow-storage') {
        const input = request.body as { operation: string };
        return Response.json(
          input.operation === 'summaries'
            ? { summaries: [], remainingSourceArtifactIds: [] }
            : { runs: [] },
        );
      }
      return undefined;
    },
  });
  const server = home.homes.picker!;
  const machine = createMachineFixture({
    id: 'machine-1',
    activeAt: Date.now(),
    // Automatic Account discovery requires an own Machine, as the real Home row declares.
    access: createPlainMachineRowFixture({ id: 'machine-1', accountId: 'workflow-picker-account' }).access,
  });
  storage.setState({
    machines: { [machine.id]: machine },
    machineListByServerId: { [server.id]: [machine] },
  });
  storage.setState({
    settings: {
      ...storage.getState().settings,
      experiments: true,
      featureToggles: {
        ...storage.getState().settings.featureToggles,
        automations: true,
      },
    },
  });
  primeServerFeaturesSnapshot({
    serverId: server.id,
    snapshot: { status: 'ready', features: createRootLayoutFeaturesResponse() },
  });
});
afterEach(async () => {
  await standardCleanup();
  resetWorkflowLibraryReadsForTests();
  (
    await import('@/sync/domains/scope/activeServerAccountScope')
  ).retireActiveServerAccountScopeLifetime();
  await home.dispose();
  await connection.dispose();
  machineRpc.mockReset();
  clearDaemonMergedProjectionCacheForTests();
  resetServerFeaturesClientForTests();
  routing.push.mockClear();
  routing.replace.mockClear();
  storage.setState(previousState);
  vi.restoreAllMocks();
});

describe('WorkflowStartPicker plugin workflows', () => {
  it('keeps trigger-source templates out of recipe-only insertion under an existing trigger', async () => {
    const screen = await renderScreen(
      <WorkflowExamplesSection opensDraft={false} onUse={() => {}} />,
    );
    await reportCollectionLayout(screen, 'workflow-examples:cards');
    expect(
      screen.findAllByTestId('workflow-examples:notify-when-agent-waits:use'),
    ).toHaveLength(0);
    expect(
      screen.findAllByTestId('workflow-examples:daily-summary-in-session:use'),
    ).toHaveLength(0);
    expect(
      screen.findAllByTestId('workflow-examples:test-after-every-turn:use'),
    ).toHaveLength(0);
    expect(
      screen.findByTestId('workflow-examples:install-deps-in-worktree:use'),
    ).toBeTruthy();
  });
  it('keeps readable start choices when neighboring definitions are unavailable', async () => {
    const ids = await seedUnavailableWorkflowDefinitions();
    const onSelect = vi.fn();
    const screen = await renderScreen(
      <WorkflowStartPicker
        onSelect={onSelect}
        onRequestClose={() => {}}
        maxHeight={600}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    const root: React.ComponentProps<typeof SelectionList>['rootStep'] =
      screen.findByType(SelectionList).props.rootStep;
    const section = root.sections.find(
      (entry) => entry.kind === 'dynamic' && entry.id === 'library',
    );
    if (section?.kind !== 'dynamic') throw new Error('missing_library_options');
    const choices = await section.resolve(
      'recipe',
      new AbortController().signal,
    );
    expect(choices.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: ids.badBody,
          disabled: true,
          subtitle: t('workflows.contentReasons.invalidBody'),
        }),
        expect.objectContaining({ id: ids.readable, label: 'Readable recipe' }),
      ]),
    );
    await act(async () => {
      screen.findByType(SelectionList).props.onSelect(ids.badBody);
    });
    expect(onSelect).not.toHaveBeenCalled();
    const allChoices = await section.resolve('', new AbortController().signal);
    expect(allChoices.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: ids.missingTitle,
          disabled: true,
          subtitle: t('workflows.contentReasons.invalidHeader'),
        }),
      ]),
    );
  });
  it('says why a built-in cannot start here instead of only greying it', async () => {
    const screen = await renderScreen(
      <WorkflowStartPicker onSelect={() => {}} onRequestClose={() => {}} maxHeight={600} />,
    );
    const root: React.ComponentProps<typeof SelectionList>['rootStep'] =
      screen.findByType(SelectionList).props.rootStep;
    const builtins = root.sections.find((entry) => entry.kind === 'static' && entry.id === 'builtins');
    if (builtins?.kind !== 'static') throw new Error('missing_builtins');
    expect(builtins.options.find((option) => option.id === 'builtin:keep-going')).toMatchObject({
      disabled: true, subtitle: t('workflows.start.needsSession'),
    });
    // Startable built-ins keep saying what they do.
    expect(builtins.options.find((option) => option.id === 'builtin:plan-with-a-panel')?.subtitle)
      .not.toBe(t('workflows.start.needsSession'));
  });
  it('gives Your library a loading, failed-with-Retry and empty state instead of vanishing', { timeout: 60_000 }, async () => {
    const first = createDeferred<Response>();
    delayedRead = first.promise;
    const screen = await renderScreen(
      <WorkflowStartPicker onSelect={() => {}} onRequestClose={() => {}} maxHeight={600} />,
    );
    const library = () => {
      const root: React.ComponentProps<typeof SelectionList>['rootStep'] =
        screen.findByType(SelectionList).props.rootStep;
      const section = root.sections.find((entry) => entry.kind === 'dynamic' && entry.id === 'library');
      if (section?.kind !== 'dynamic') throw new Error('missing_library_section');
      return section;
    };
    expect(library().retryLabel).toBe(t('common.retry'));
    const settle = (signal = new AbortController().signal) => Promise.race([
      library().resolve('', signal).then((value) => ({ value }), (error: unknown) => ({ error })),
      new Promise((resolve) => setTimeout(() => resolve('waiting'), 20)),
    ]);
    // While the first page reads, the section waits (its skeletons) rather than settling empty.
    expect(await settle()).toBe('waiting');
    artifactReadStatus = 500;
    delayedRead = null;
    await act(async () => {
      first.resolve(new Response('{}', { status: 500 }));
      await first.promise;
    });
    await vi.waitFor(async () => {
      await act(async () => { await Promise.resolve(); });
      expect(await settle()).toMatchObject({ error: { name: 'SelectionListSectionFailure' } });
    }, { timeout: 20_000 });
    // Retry on that line reads the library again; an empty library then says so.
    artifactReadStatus = null;
    const reads = () => home.requests.filter((request) => request.path === '/v1/artifacts' && request.method !== 'POST').length;
    const before = reads();
    const retried = new AbortController();
    void settle(retried.signal);
    await vi.waitFor(async () => {
      await act(async () => { await Promise.resolve(); });
      expect(reads()).toBeGreaterThan(before);
    }, { timeout: 20_000 });
    retried.abort();
    await vi.waitFor(async () => {
      await act(async () => { await Promise.resolve(); });
      expect(await settle()).toMatchObject({ value: { options: [], emptyHint: t('workflows.destination.libraryEmpty') } });
    }, { timeout: 20_000 });
  });
  it.each(['builtin:keep-going'])(
    'offers Choose a session, never Run now, for %s',
    async (id) => {
      routeParams.id = id;
      routeParams.intent = 'run';
      const screen = await renderScreen(<SavedWorkflowRoute />, {
        wrapper: withPanes,
      });
      expect(screen.findByTestId('workflow-builtin-run-now')).not.toBeNull();
      expect(screen.getTextContent()).toContain(
        t('workflows.examples.chooseSession'),
      );
      expect(screen.findAllByType(WorkflowRunComposer)).toHaveLength(0);
      expect(modals).toEqual([]);
      expect(starts()).toEqual([]);
      await screen.pressByTestIdAsync('workflow-builtin-duplicate');
      const route = routing.push.mock.calls.at(-1)?.[0] as {
        pathname: string;
        params: { definitionDraftSeedId: string };
      };
      expect(route.pathname).toBe('/workflows/new');
      expect(
        readWorkflowDefinitionDraftSeed(route.params.definitionDraftSeedId),
      ).toMatchObject({
        definition: BUILTIN_WORKFLOW_CATALOG_V1.find(
          (entry) => entry.id === id,
        )!.definition,
      });
      expect(
        writes(),
        JSON.stringify(
          writes().map(({ method, path, body }) => ({ method, path, body })),
        ),
      ).toEqual([]);
    },
  );
  it('opens Review & converge without an origin and requires its explicit Session input', async () => {
    routeParams.id = 'builtin:review-and-converge';
    routeParams.intent = 'run';
    // The app shell's modal host is already mounted before a route is entered.
    const screen = await renderScreen(<></>, {
      wrapper: withPanes,
    });
    await screen.update(<SavedWorkflowRoute />);
    expect(screen.findAllByType(WorkflowRunComposer)).toHaveLength(1);
    expect(screen.findHostByTestId('workflow-run-inputs-run')?.props.accessibilityState.disabled).toBe(
      true,
    );
    expect(screen.findByType(WorkflowRunComposer).props.inputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'reviewSession',
          required: true,
          inputType: { hostType: 'session' },
        }),
      ]),
    );
    expect(starts()).toEqual([]);
  });
  it('opens the shared example picker from the column + menu without saving', async () => {
    const screen = await renderScreen(<WorkflowsColumnActions canCreate />);
    const addMenu = screen
      .findAllByType(DropdownMenu)
      .find((menu) => menu.props.testID === 'workflows-column:add:menu')!;
    expect(addMenu.props.items.map((item: { id: string }) => item.id)).toEqual([
      'blank',
      'trigger',
      'agent',
      'example',
      'import',
    ]);
    await act(async () => {
      addMenu.props.onSelect('example');
    });
    await reportCollectionLayout(screen, 'workflow-examples:cards');
    for (const example of WORKFLOW_STARTER_EXAMPLES_V1)
      expect(
        screen.findByTestId(`workflow-examples:${example.key}:use`),
      ).not.toBeNull();
    await screen.pressByTestIdAsync(
      'workflow-examples:review-pull-request:use',
    );
    expect(routing.push).toHaveBeenCalledWith({
      pathname: '/workflows/new',
      params: { example: 'review-pull-request' },
    });
    expect(writes()).toEqual([]);
    expect(starts()).toEqual([]);
  });
  it('chooses the habit source before opening a draft and carries its concrete trigger through the existing seed', async () => {
    const session = habitSessionFixture();
    storage.setState({
      isDataReady: true,
      sessions: { [session.id]: session },
    });
    const screen = await renderScreen(<WorkflowExamplesSection />);
    await reportCollectionLayout(screen, 'workflow-examples:cards');
    await screen.pressByTestIdAsync(
      'workflow-examples:notify-when-agent-waits:use',
    );
    expect(routing.push).not.toHaveBeenCalled();
    const picker = screen.findByType(DropdownMenu);
    const items: React.ComponentProps<typeof DropdownMenu>['items'] =
      picker.props.items;
    expect(items.map((item) => item.id)).toContain(session.id);
    await act(async () => {
      picker.props.onSelect(session.id);
    });
    const route = routing.push.mock.calls.at(-1)?.[0] as {
      pathname: string;
      params: { definitionDraftSeedId: string };
    };
    expect(route.pathname).toBe('/workflows/new');
    expect(
      readWorkflowDefinitionDraftSeed(route.params.definitionDraftSeedId),
    ).toMatchObject({
      trigger: {
        kind: 'sessionLifecycle',
        subject: { kind: 'session', serverId: 'srv_workflow-picker-home', sessionId: session.id },
        events: ['userActionRequired'],
      },
      definition: {
        blocks: [{ kind: 'action', actionId: 'notifications.notify_me' }],
      },
    });
    expect(
      writes(),
      JSON.stringify(
        writes().map(({ method, path, body }) => ({ method, path, body })),
      ),
    ).toEqual([]);
    expect(starts()).toEqual([]);
  });
  it("binds a Session's Triggers + examples to that Session with no chooser and opens the draft with its concrete trigger", async () => {
    const session = habitSessionFixture();
    storage.setState({
      isDataReady: true,
      sessions: { [session.id]: session },
    });
    const screen = await renderScreen(
      <WorkflowExamplesSection
        presentation="list"
        session={{ sessionId: session.id, machineId: 'machine-1' }}
      />,
    );
    // A Session offers the complete starter catalog, with its target already selected.
    for (const example of WORKFLOW_STARTER_EXAMPLES_V1) {
      expect(
        screen.findByTestId(`workflow-examples:${example.key}`),
      ).not.toBeNull();
    }
    // Already bound to this Session: no description asks to choose one.
    expect(screen.getTextContent()).toContain(
      t('workflows.examples.sessionNotifyDescription'),
    );
    expect(screen.getTextContent()).not.toContain(
      t('workflows.examples.notifyWhenAgentWaits.description'),
    );
    // Only the example the catalog added recently carries the quiet "New" mark (lab `b-habit T`).
    expect(
      screen.findAllByTestId('workflow-examples:memory-upkeep-in-session:new'),
    ).not.toHaveLength(0);
    expect(
      screen.findAllByTestId('workflow-examples:daily-summary-in-session:new'),
    ).toHaveLength(0);
    await screen.pressByTestIdAsync(
      'workflow-examples:daily-summary-in-session:use',
    );
    expect(screen.findAllByType(DropdownMenu)).toHaveLength(0);
    const route = routing.push.mock.calls.at(-1)?.[0] as {
      pathname: string;
      params: { definitionDraftSeedId: string };
    };
    expect(route.pathname).toBe('/workflows/new');
    expect(
      readWorkflowDefinitionDraftSeed(route.params.definitionDraftSeedId),
    ).toMatchObject({
      trigger: { kind: 'schedule' },
      sessionTarget: { sessionId: session.id, machineId: 'machine-1' },
      definition: {
        defaults: {
          conversation: {
            kind: 'existing_session',
            sessionId: session.id,
            machineId: 'machine-1',
          },
        },
      },
    });
    expect(writes()).toEqual([]);
    expect(starts()).toEqual([]);
  });
  it('passes the chosen daily destination and trigger to inline insertion without navigation', async () => {
    const session = habitSessionFixture();
    storage.setState({
      isDataReady: true,
      sessions: { [session.id]: session },
    });
    const onUse = vi.fn();
    const screen = await renderScreen(
      <WorkflowExamplesSection onUse={onUse} />,
    );
    await reportCollectionLayout(screen, 'workflow-examples:cards');
    await screen.pressByTestIdAsync(
      'workflow-examples:daily-summary-in-session:use',
    );
    expect(onUse).not.toHaveBeenCalled();
    await act(async () => {
      screen.findByType(DropdownMenu).props.onSelect(session.id);
    });
    expect(onUse).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: expect.objectContaining({ kind: 'schedule' }),
        definition: expect.objectContaining({
          defaults: expect.objectContaining({
            conversation: {
              kind: 'existing_session',
              sessionId: session.id,
              machineId: 'machine-1',
            },
          }),
        }),
      }),
    );
    expect(routing.push).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });
  it('refuses a session choice made after its Account lifetime retired', async () => {
    const scope = storage.getState().profileScope!;
    const session = habitSessionFixture();
    storage.setState({
      isDataReady: true,
      sessions: { [session.id]: session },
    });
    const onUse = vi.fn();
    const screen = await renderScreen(
      <WorkflowExamplesSection onUse={onUse} />,
    );
    await reportCollectionLayout(screen, 'workflow-examples:cards');
    await screen.pressByTestIdAsync(
      'workflow-examples:test-after-every-turn:use',
    );
    const picker = screen.findByType(DropdownMenu);
    await act(async () => {
      storage.setState({
        profileScope: { ...scope, accountId: 'another-account' },
      });
    });
    await act(async () => {
      picker.props.onSelect(session.id);
    });
    expect(onUse).not.toHaveBeenCalled();
    expect(routing.push).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });
  it('reviews a built-in in the canonical composer before admitting its catalog source', async () => {
    const confirmation = vi.spyOn(Modal, 'confirm').mockResolvedValue(true);
    routeParams.id = 'builtin:open-a-pull-request';
    storage.setState({
      machines: { 'machine-1': createMachineFixture({ id: 'machine-1' }) },
      authoringMemory: {
        ...storage.getState().authoringMemory,
        recentMachinePaths: [{ machineId: 'machine-1', path: '/project' }],
      },
    });
    installPluginProjection();
    const screen = await renderScreen(<SavedWorkflowRoute />, {
      wrapper: withPanes,
      // Real native anchor geometry keeps this review on the anchored composer branch.
      createNodeMock: () => ({
        focus: () => {},
        measureInWindow: (
          receive: (
            x: number,
            y: number,
            width: number,
            height: number,
          ) => void,
        ) => receive(600, 100, 160, 40),
      }),
    });
    await screen.pressByTestIdAsync('workflow-builtin-run-now');
    expect(starts()).toEqual([]);
    expect(modals).toHaveLength(1);
    expect(modals[0]).toMatchObject({
      type: 'custom',
      visible: true,
      chrome: { phonePresentation: 'sheet', scrollHost: 'bounded', bodyScroll: 'none' },
    });
    expect(screen.findAllByType(WorkflowRunComposer)).toHaveLength(1);
    await act(async () => {
      screen.findByType(WorkflowRunComposer).props.onRun(undefined);
      await vi.waitFor(() => {
        expect(starts()).toHaveLength(1);
        expect(routing.push).toHaveBeenCalledWith(
          createWorkflowRunRoute(starts()[0]!.input.runId, storage.getState().profileScope!.serverId),
        );
      });
    });
    // The shared Action catalog declares direct, safe UI admission after composer review.
    expect(confirmation).not.toHaveBeenCalled();
    expect(starts()).toHaveLength(1);
    expect(starts()[0]).toMatchObject({
      input: {
        source: { kind: 'catalog', workflow: 'builtin:open-a-pull-request' },
      },
      target: {
        kind: 'machine',
        machineId: 'machine-1',
        project: { machineId: 'machine-1', directory: '/project' },
      },
    });
  });
  it.each([false, true])(
    'renders the canonical examples and built-ins on the home (saved=%s) without seeding persistence',
    async (saved) => {
      if (saved) {
        await createWorkflowDefinition({
          definitionId: '00000000-0000-4000-8000-000000000003',
          definition: plugin.definition,
          metadata: { title: 'Saved' },
        });
        home.requests.length = 0;
      }
      const screen = await renderScreen(<WorkflowsLibraryHome />);
      await act(async () => {
        await Promise.resolve();
      });
      // A first visit shows the whole catalog; a returning library one compact row and the rest one press away.
      const firstVisit =
        screen.findByTestId('workflows-home:firstVisit') !== null;
      const shown = firstVisit
        ? WORKFLOW_STARTER_EXAMPLES_V1
        : WORKFLOW_STARTER_EXAMPLES_V1.slice(0, 2);
      await reportCollectionLayout(screen, 'workflow-examples:cards');
      for (const example of shown) {
        expect(
          screen.findHostByTestId(`workflow-examples:${example.key}`),
        ).not.toBeNull();
        expect(
          screen.findByTestId(`workflow-examples:${example.key}:use`),
        ).not.toBeNull();
      }
      expect(screen.findByTestId('workflow-examples:more') !== null).toBe(
        !firstVisit,
      );
      for (const builtin of BUILTIN_WORKFLOW_CATALOG_V1)
        expect(
          screen.findByTestId(`workflow-builtins:${builtin.id}`),
        ).not.toBeNull();
      const first = WORKFLOW_STARTER_EXAMPLES_V1[0]!.key;
      await screen.pressByTestIdAsync(`workflow-examples:${first}:use`);
      expect(routing.push).toHaveBeenCalledWith({
        pathname: '/workflows/new',
        params: { example: first },
      });
      expect(writes()).toEqual([]);
      expect(starts()).toEqual([]);
    },
  );
  it('shows the plugin library even when no saved definitions or runs exist', async () => {
    installPluginProjection();
    const screen = await renderScreen(<WorkflowsLibraryHome />);
    await vi.waitFor(async () => {
      await act(async () => { await Promise.resolve(); });
      expect(screen.findByTestId(`workflows-home:row:${plugin.workflow}`)).not.toBeNull();
    });
    await screen.pressByTestIdAsync(`workflows-home:row:${plugin.workflow}`);
    expect(routing.push).toHaveBeenCalledWith(
      `/workflows/${encodeURIComponent(plugin.workflow)}`,
    );
    expect(
      home.requests.filter(
        (request) => request.path === '/v3/automations/runs/workflow-storage',
      ),
    ).toEqual([]);
  });

  it('opens the contribution read-only and duplicates as an unsaved portable draft without a write', async () => {
    installPluginProjection();
    const screen = await renderScreen(<SavedWorkflowRoute />, {
      wrapper: withPanes,
    });
    await act(async () => {
      await Promise.resolve();
    });
    const { WorkflowEditorBody } =
      await import('../screens/WorkflowEditorBody');
    expect(
      screen.findByType(WorkflowEditorBody).props.documentPresentation.editable,
    ).toBe(false);
    expect(screen.findAllByTestId('workflow-editor-name').length).toBe(0);
    await screen.pressByTestIdAsync('workflow-plugin-duplicate');
    expect(writes()).toEqual([]);
    const route = routing.push.mock.calls.at(-1)?.[0] as {
      pathname: string;
      params: { definitionDraftSeedId: string };
    };
    expect(route.pathname).toBe('/workflows/new');
    expect(
      readWorkflowDefinitionDraftSeed(route.params.definitionDraftSeedId),
    ).toEqual({
      definition: plugin.definition,
      name: t('workflows.copyName', { name: plugin.title }),
    });
  });

  it('starts plugin workflows through the session composer with origin and observed version', async () => {
    const confirmation = vi.spyOn(Modal, 'confirm').mockResolvedValue(true);
    const session = createSessionFixture({
      serverId: storage.getState().profileScope!.serverId,
    });
    const machine = createMachineFixture();
    storage.setState({
      sessions: { [session.id]: session },
      machines: { [machine.id]: machine },
    });
    installPluginProjection();
    let openStart!: ReturnType<typeof useSessionBuiltinWorkflowStart>;
    function SessionStart() {
      openStart = useSessionBuiltinWorkflowStart({ sessionId: session.id });
      return null;
    }
    const screen = await renderScreen(React.createElement(withPanes, null, <SessionStart />));
    await act(async () => {
      openStart(plugin);
    });
    expect(modals).toHaveLength(1);
    expect(modals[0]).toMatchObject({ type: 'custom', visible: true });
    expect(starts()).toEqual([]);
    expect(findAllHostTestInstances(screen.root, node => node.props.testID === 'workflow-start-details')).toHaveLength(1);
    const composer = screen.findByType(WorkflowRunComposer);
    const startSettled = () =>
      expect(findAllHostTestInstances(screen.root, node => node.props.testID === 'workflow-start-details')).toHaveLength(0);
    await act(async () => {
      composer.props.onRun({});
      await vi.waitFor(startSettled);
    });
    expect(confirmation).not.toHaveBeenCalled();
    expect(routing.push).not.toHaveBeenCalled();
    const { WorkflowRunPane } = await import('./WorkflowRunPane');
    await vi.waitFor(() => expect(screen.findAllByType(WorkflowRunPane)).toHaveLength(1));
    expect(starts()).toEqual([
      expect.objectContaining({
        input: expect.objectContaining({
          source: {
            kind: 'catalog',
            workflow: plugin.workflow,
            pluginVersion: plugin.version,
          },
        }),
        invocation: expect.objectContaining({ defaultSessionId: session.id }),
        target: expect.objectContaining({
          kind: 'machine',
          machineId: 'machine-1',
        }),
      }),
    ]);
    expect(
      modals.filter((entry) => 'visible' in entry && entry.visible === true),
    ).toHaveLength(1);
    startSettled();
  });
  it('starts a chosen workflow from the Session Run… chip with the retained draft as its question', async () => {
    const session = createSessionFixture({
      serverId: storage.getState().profileScope!.serverId,
    });
    const machine = createMachineFixture();
    let acceptedEnvelope: string | undefined;
    const agentTarget = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } };
    const owner = createWorkflowAccountRunActionOwner({
      resolveAccountId: async () => 'workflow-picker-account',
      resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      normalizeAbsolutePath: path => path.startsWith('/') ? path : null,
      randomBytes: () => { throw new Error('plain_account_needs_no_keys'); },
      definitions: { get: async () => { throw new Error('catalog_start_needs_no_saved_definition'); } },
      prepareWorkspace: async ({ projectTarget }) => ({ ok: true, workspaceTarget: { project: { ...projectTarget,
        checkoutRootPath: projectTarget.directory } } }),
      resolveMaterializationContext: async () => ({ roleSelection: { defaultEngine: { agentTargetKey: 'agent:happier.agent.codex/codex' } },
        effects: { resolveTargetAvailability: async () => true,
          readActionContract: async id => {
            const parsed = ActionIdSchema.safeParse(id);
            if (!parsed.success) return null;
            const spec = getActionSpec(parsed.data);
            const output = spec.completion?.terminalOutputSchema ?? spec.outputSchema;
            return output ? { inputSchema: StrictJsonValueSchema.parse(zodSchemaToJsonSchemaObject(spec.inputSchema, { target: 'draft-7' })),
              outputSchema: StrictJsonValueSchema.parse(zodSchemaToJsonSchemaObject(output, { target: 'draft-7' })) } : null;
          } } }),
      storage: { execute: async operation => {
        if (operation.operation === 'get') throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
        if (operation.operation !== 'admit') throw new Error('unexpected_storage_operation');
        acceptedEnvelope = String(operation.acceptedEnvelope);
        return { kind: 'created', run: createWorkflowRunSummaryFixture({ id: String(operation.runId),
          ownerAccountId: 'workflow-picker-account', machineId: machine.id, origin: { kind: 'direct', originSessionId: session.id } }) };
      } },
    });
    executeStart = request => owner.execute({ actionId: 'workflow.run.start', input: request.input,
      context: { surface: 'ui', authority: 'present_user', callerPermissionMode: 'default', externalActionTarget: request.target,
        defaultSessionId: request.invocation.defaultSessionId } }, { agentTarget, machineId: machine.id });
    storage.setState({
      sessions: { [session.id]: session },
      machines: { [machine.id]: machine },
    });
    const { useSessionWorkflowRunChip } =
      await import('@/components/sessions/agents/launch/useSessionWorkflowRunChip');
    const draft = 'Is 5 attempts enough if the relay restarts mid-deploy?';
    const { writeExistingSessionDraft } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
    writeExistingSessionDraft({ scope: storage.getState().profileScope!, sessionId: session.id,
      patch: { text: draft }, materializationIntent: 'userEdit' });
    const hook = await renderHook(
      () =>
        useSessionWorkflowRunChip({
          sessionId: session.id,
        }),
      { wrapper: withPanes },
    );
    const chip = hook.getCurrent();
    expect(chip?.controlId).toBe('workflow');
    const renderContent = chip.collapsedContentPopover?.renderContent;
    if (typeof renderContent !== 'function') throw new Error('missing_workflow_picker_renderer');
    const requestClose = vi.fn();
    const content = await renderScreen(
      <>
        {renderContent({
          requestClose,
          maxHeight: 480,
        })}
      </>,
      // The popover content shares the composer's modal host: a second ModalProvider would take the start form.
      { wrapper: ({ children }) => <AppPaneProvider>{children}</AppPaneProvider> },
    );
    // Inside a Session, Session-origin built-ins (Keep going) are startable choices.
    const options = content
      .findByType(SelectionList)
      .props.rootStep.sections.flatMap(
        (section: {
          kind: string;
          options?: { id: string; disabled?: boolean }[];
        }) => section.options ?? [],
      );
    expect(
      options.find(
        (option: { id: string }) => option.id === 'builtin:keep-going',
      )?.disabled,
    ).toBeFalsy();
    const panel = BUILTIN_WORKFLOW_CATALOG_V1.find(
      (entry) => entry.id === 'builtin:plan-with-a-panel',
    )!;
    await content.pressByTestIdAsync(`workflow-choice:${panel.id}`);
    expect(requestClose).toHaveBeenCalled();
    expect(starts()).toEqual([]);
    const composer = hook.tree.root.findByType(WorkflowRunComposer);
    const main = panel.definition.inputs.find(
      (input) => input.valueType === 'string',
    )!;
    expect(composer.props.values[main.name]).toBe(draft);
    const [button] = findAllHostTestInstances(hook.tree.root,
      node => node.props.testID === 'workflow-run-inputs-run');
    await vi.waitFor(() => expect(button?.props.accessibilityState.disabled).toBe(false));
    await pressTestInstanceAsync(button);
    await vi.waitFor(() => expect(starts()).toHaveLength(1));
    expect(routing.push).not.toHaveBeenCalled();
    expect(starts()[0]).toMatchObject({
      input: {
        source: { kind: 'catalog', workflow: panel.id },
        inputs: { [main.name]: draft },
      },
      invocation: { defaultSessionId: session.id },
    });
    expect(openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'workflow-picker-account', runId: starts()[0]!.input.runId },
      envelope: parseWorkflowStoredContentEnvelopeV1(acceptedEnvelope!),
    })).toMatchObject({ kind: 'available', content: { inputs: { request: draft, previousRoundContext: null },
      origin: { kind: 'direct', originSessionId: session.id } } });
  });
  it('keeps the selected saved Workflow inputs while consuming its relevant revision only', async () => {
    const { WorkflowStartDetailsBody } = await import('./WorkflowStartDetails');
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
    const { updateWorkflowDefinition } = await import('@/sync/domains/workflows/workflowDefinitionActions');
    const definitionId = '00000000-0000-4000-8000-000000000091';
    const panel = BUILTIN_WORKFLOW_CATALOG_V1.find(entry => entry.id === 'builtin:plan-with-a-panel')!;
    const saved = await createWorkflowDefinition({ definitionId, definition: panel.definition, metadata: { title: 'Selected plan' } });
    const lifetime = captureActiveServerAccountScopeLifetime()!;
    const onStarted = vi.fn();
    const screen = await renderScreen(<WorkflowStartDetailsBody accountLifetime={lifetime}
      source={{ kind: 'saved', definitionId, revision: saved.revision }} project={{ machineId: 'machine-1', directory: '/project' }}
      onStarted={onStarted} />, { wrapper: withPanes });
    await vi.waitFor(() => expect(screen.findAllByType(WorkflowRunComposer)).toHaveLength(1));
    const main = panel.definition.inputs.find(input => input.valueType === 'string')!;
    await act(async () => { screen.findByType(WorkflowRunComposer).props.onChangeValues({ [main.name]: 'Keep my edits' }); });
    const before = screen.findByType(WorkflowRunComposer).props;
    const definitionReads = () => home.requests.filter(request => request.path.startsWith('/v1/artifacts'));
    home.requests.length = 0;
    await act(async () => publishHomeAccountChange(lifetime.scope.serverId, ['00000000-0000-4000-8000-000000000092'],
      { source: 'socket', changeKinds: ['artifact'], workflowDefinitionsAffect: true }));
    expect(definitionReads()).toEqual([]);
    expect(screen.findByType(WorkflowRunComposer).props.inputs).toBe(before.inputs);
    expect(screen.findByType(WorkflowRunComposer).props.definition).toBe(before.definition);
    expect(starts()).toEqual([]);
    expect(routing.push).not.toHaveBeenCalled();
    await updateWorkflowDefinition({ definitionId, expectedRevision: saved.revision, definition: panel.definition,
      metadata: { title: 'Revised plan' } });
    home.requests.length = 0;
    await act(async () => publishHomeAccountChange(lifetime.scope.serverId, [definitionId],
      { source: 'socket', changeKinds: ['artifact'], workflowDefinitionsAffect: true }));
    await vi.waitFor(() => expect(screen.findByType(WorkflowRunComposer).props.workflowName).toBe('Revised plan'));
    expect(definitionReads()).toHaveLength(1);
    expect(screen.findByType(WorkflowRunComposer).props.values[main.name]).toBe('Keep my edits');
    await act(async () => { screen.findByType(WorkflowRunComposer).props.onRun({ [main.name]: 'Keep my edits' }); });
    await vi.waitFor(() => expect(starts()).toHaveLength(1));
    expect(onStarted).toHaveBeenCalledOnce();
    expect(starts()[0]!.input).toMatchObject({ source: { kind: 'saved', definitionId }, inputs: { [main.name]: 'Keep my edits' } });
    expect(starts()[0]!.input.source).not.toEqual({ kind: 'saved', definitionId, revision: saved.revision });
    await screen.unmount();
    home.requests.length = 0;
    await act(async () => publishHomeAccountChange(lifetime.scope.serverId, [definitionId],
      { source: 'socket', changeKinds: ['artifact'], workflowDefinitionsAffect: true }));
    expect(definitionReads()).toEqual([]);
  });
  it('retains reviewed Workflow inputs after the Start body is dismissed and mounted again', async () => {
    const { WorkflowStartDetailsBody } = await import('./WorkflowStartDetails');
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const lifetime = captureActiveServerAccountScopeLifetime()!;
    const panel = BUILTIN_WORKFLOW_CATALOG_V1.find(entry => entry.id === 'builtin:plan-with-a-panel')!;
    const body = <WorkflowStartDetailsBody accountLifetime={lifetime} source={{ kind: 'catalog', workflow: panel.id }}
      originSession={{ sessionId: 'session-review-a' }}
      project={{ machineId: 'machine-1', directory: '/project' }} retainedDraft="Original question" onStarted={vi.fn()} />;
    const first = await renderScreen(body, { wrapper: withPanes });
    await vi.waitFor(() => expect(first.findAllByType(WorkflowRunComposer)).toHaveLength(1));
    const reviewed = { request: 'Reviewed question', previousRoundContext: { notes: 'Reviewed context' } };
    const raw = { request: 'Reviewed question', previousRoundContext: '{ "notes": "Reviewed context" }' };
    await act(async () => {
      const composer = first.findByType(WorkflowRunComposer);
      composer.props.onChangeValues(reviewed);
      composer.props.onChangeRawTextValues(raw);
    });
    await first.unmount();
    const other = await renderScreen(<WorkflowStartDetailsBody accountLifetime={lifetime}
      source={{ kind: 'catalog', workflow: panel.id }} originSession={{ sessionId: 'session-review-b' }}
      project={{ machineId: 'machine-1', directory: '/project' }} retainedDraft="Original question" onStarted={vi.fn()} />,
      { wrapper: withPanes });
    await vi.waitFor(() => expect(other.findAllByType(WorkflowRunComposer)).toHaveLength(1));
    expect(other.findByType(WorkflowRunComposer).props.values.request).toBe('Original question');
    await other.unmount();
    const reopened = await renderScreen(body, { wrapper: withPanes });
    await vi.waitFor(() => expect(reopened.findAllByType(WorkflowRunComposer)).toHaveLength(1));
    expect(reopened.findByType(WorkflowRunComposer).props.values).toEqual(reviewed);
    expect(reopened.findByType(WorkflowRunComposer).props.rawTextValues).toEqual(raw);
  });
  it('opens a reference-only Discussion Start tab without posting or admitting work', async () => {
    const { useDiscussionWorkflowRun } = await import('@/components/discussions/useDiscussionWorkflowRun');
    const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('missing_account_scope');
    const discussion = { serverId: lifetime.scope.serverId, discussionId: 'discussion-1' };
    const scopeId = 'discussion-test';
    const hook = await renderHook(() => ({
      run: useDiscussionWorkflowRun({ discussion, accountLifetime: lifetime, paneScopeId: scopeId }),
      pane: useAppPaneScope(scopeId),
    }), { wrapper: withPanes });
    expect(hook.getCurrent().run.chip.controlId).toBe('workflow');
    expect(machineRpc).not.toHaveBeenCalled();
    const panel = BUILTIN_WORKFLOW_CATALOG_V1.find(entry => entry.id === 'builtin:plan-with-a-panel')!;
    await act(async () => hook.getCurrent().run.select({ name: 'Relay check', source: { kind: 'catalog', workflow: panel.id } }));
    expect(hook.getCurrent().pane.scopeState?.details.tabs[0]?.resource).toEqual({
      kind: 'workflowStart', source: { kind: 'catalog', workflow: panel.id },
      origin: { kind: 'discussion', discussion },
    });
    // A phone presents the tab in its Start sheet; nothing else asks for attention.
    const { PhoneDetailsStartSheet } = await import('@/components/appShell/panes/details/PhoneDetailsStartSheet');
    expect(modals.map(modal => modal.type === 'custom' ? modal.component : modal.type)).toEqual([PhoneDetailsStartSheet]);
    expect(starts()).toEqual([]);
    expect(writes()).toEqual([]);
    expect(hook.getCurrent().run.saveAsPattern.state.status).toBe('closed');
  });
  it('keeps a chosen pattern inside its popover on a phone: its Start is the next step, and Back returns to the list', async () => {
    const { useDiscussionWorkflowRun } = await import('@/components/discussions/useDiscussionWorkflowRun');
    const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
    const { useAppPaneContext } = await import('@/components/appShell/panes/AppPaneProvider');
    const { Dimensions, Text } = await import('react-native');
    // A phone: its popovers push in place, and a Start never sits beside the thread.
    vi.spyOn(Dimensions, 'get').mockReturnValue({ width: 390, height: 844, scale: 3, fontScale: 1 });
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('missing_account_scope');
    const discussion = { serverId: lifetime.scope.serverId, discussionId: 'discussion-phone' };
    const scopeId = 'discussion-phone-test';
    const requestClose = vi.fn();
    // The Discussion's registered Details renderer stands for its Start body: the step shows the chosen tab.
    function StartBody() {
      const tab = useAppPaneScope(scopeId).scopeState?.details.tabs.at(-1);
      return <Text testID="start-body">{tab?.title}</Text>;
    }
    const pane: { current?: ReturnType<typeof useAppPaneScope> } = {};
    function PhoneComposerPopover() {
      const run = useDiscussionWorkflowRun({ discussion, accountLifetime: lifetime!, paneScopeId: scopeId });
      pane.current = useAppPaneScope(scopeId);
      const register = useAppPaneContext(value => value.registerDriver);
      React.useEffect(() => register({ scopeId, detailsPaneBuiltinAdapter: {
        destinationIds: ['details'], render: () => <StartBody />,
      } }), [register]);
      const render = run.chip.collapsedContentPopover?.renderContent;
      if (typeof render !== 'function') throw new Error('missing_workflow_picker_renderer');
      return <>{render({ requestClose, maxHeight: 640, presentation: 'sheet' })}</>;
    }
    const screen = await renderScreen(<PhoneComposerPopover />, { wrapper: withPanes });
    const panel = BUILTIN_WORKFLOW_CATALOG_V1.find(entry => entry.id === 'builtin:plan-with-a-panel')!;
    const label = screen.findByType(SelectionList).props.rootStep.sections
      .flatMap((section: { options?: { id: string; label: string }[] }) => section.options ?? [])
      .find((option: { id: string }) => option.id === panel.id)!.label;
    await screen.pressByTestIdAsync(`workflow-choice:${panel.id}`);
    // The press chooses the pattern even though this popover renders outside any command composition
    // (the native overlay host sits above the app's current-context provider).
    expect(pane.current?.scopeState?.details.tabs[0]?.resource).toEqual({
      kind: 'workflowStart', source: { kind: 'catalog', workflow: panel.id },
      origin: { kind: 'discussion', discussion },
    });
    // The popover stays open and shows the chosen pattern's Start in place of the list; no second sheet opens.
    expect(modals).toEqual([]);
    expect(requestClose).not.toHaveBeenCalled();
    expect(screen.findHostByTestId('start-body')?.props.children).toBe(label);
    expect(screen.findHostByTestId('workflow-start-picker.list')?.props.style).toEqual({ display: 'none' });
    expect(pane.current?.scopeState?.details.isOpen).toBe(true);
    // Back returns to the pattern list in the same popover and closes the unstarted Start as the sheet did
    // (the reviewed tab is retained for the next choice of the same pattern).
    await screen.pressByTestIdAsync('details-start-step.back');
    expect(screen.findAllByTestId('start-body')).toHaveLength(0);
    expect(screen.findHostByTestId('workflow-start-picker.list')?.props.style).toBeUndefined();
    expect(pane.current?.scopeState?.details.isOpen).toBe(false);
    expect(requestClose).not.toHaveBeenCalled();
    expect(starts()).toEqual([]);
  });
  it('retains edited setup values and raw input when the same workflow is dismissed and selected again', async () => {
    const { useWorkflowComposerStart } = await import('./useWorkflowComposerStart');
    const hook = await renderHook(() => useWorkflowComposerStart({
      project: { machineId: 'machine-1', directory: '/repo' }, onStarted: vi.fn(),
    }), { wrapper: withPanes });
    const workflow = 'builtin:plan-with-a-panel';
    // The modal host keeps its exiting content mounted for motion; use the newest review.
    const currentComposer = () => ({ props: hook.getCurrent().composerProps! });
    await act(async () => { hook.getCurrent().start(workflow, { retainedDraft: 'Original question' }); });
    const reviewed = { request: 'Edited question', previousRoundContext: { notes: 'Keep this context' } };
    const raw = { request: 'Edited question', previousRoundContext: '{ "notes": "Keep this context" }' };
    await act(async () => {
      const composer = currentComposer();
      composer.props.onChangeValues(reviewed);
      composer.props.onChangeRawTextValues(raw);
    });
    await act(async () => currentComposer().props.onCancel());
    await act(async () => { hook.getCurrent().start(workflow, { retainedDraft: 'Original question' }); });
    const reopened = currentComposer();
    expect(reopened.props.values).toEqual(reviewed);
    expect(reopened.props.rawTextValues).toEqual(raw);
    expect(starts()).toEqual([]);
    await act(async () => reopened.props.onCancel());
    await act(async () => { hook.getCurrent().start(workflow, { retainedDraft: 'A new composer question' }); });
    expect(currentComposer().props.values.request).toBe('A new composer question');
  });
  it('keeps a reviewed start on its captured Account when a later render has no caller scope', async () => {
    const { useWorkflowComposerStart } = await import('./useWorkflowComposerStart');
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('missing_account_scope');
    const onStarted = vi.fn();
    const hook = await renderHook(({ current }: { current: boolean }) => useWorkflowComposerStart({
      accountLifetime: current ? lifetime : null, project: { machineId: 'machine-1', directory: '/repo' }, onStarted,
    }), { wrapper: withPanes, initialProps: { current: true } });
    const panel = BUILTIN_WORKFLOW_CATALOG_V1.find(entry => entry.id === 'builtin:plan-with-a-panel')!;
    await act(async () => { hook.getCurrent().start({ id: panel.id, name: 'Retained review', description: '',
      definition: panel.definition, source: { kind: 'catalog', workflow: panel.id } }); });
    await hook.rerender({ current: false });
    const main = panel.definition.inputs.find(input => input.valueType === 'string')!;
    await act(async () => {
      hook.getCurrent().composerProps!.onRun({ [main.name]: 'Review the selected question' });
      await vi.waitFor(() => expect(onStarted).toHaveBeenCalled());
    });
    expect(starts()).toHaveLength(1);
    expect(onStarted.mock.calls[0]?.[1]).toBe(lifetime.scope.serverId);
  });
  it('keeps a Session start refusal inline in the open form with its typed reason and the draft', async () => {
    const alert = vi.spyOn(Modal, 'alert');
    const session = createSessionFixture({
      serverId: storage.getState().profileScope!.serverId,
    });
    const machine = createMachineFixture();
    storage.setState({
      sessions: { [session.id]: session },
      machines: { [machine.id]: machine },
    });
    startRefusal = { errorCode: 'target_unavailable', error: 'Machine offline' };
    const hook = await renderHook(
      () => useSessionBuiltinWorkflowStart({ sessionId: session.id }),
      { wrapper: withPanes },
    );
    const panel = BUILTIN_WORKFLOW_CATALOG_V1.find(
      (entry) => entry.id === 'builtin:plan-with-a-panel',
    )!;
    const main = panel.definition.inputs.find(
      (input) => input.valueType === 'string',
    )!;
    const draft = 'Should the relay retry five times?';
    const { writeExistingSessionDraft } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
    writeExistingSessionDraft({ scope: storage.getState().profileScope!, sessionId: session.id,
      patch: { text: draft }, materializationIntent: 'userEdit' });
    await act(async () => {
      hook.getCurrent()(
        { name: 'Panel',
          source: { kind: 'catalog', workflow: panel.id } },
      );
    });
    await act(async () => {
      hook.tree.root.findByType(WorkflowRunComposer).props.onRun({ [main.name]: draft });
      await vi.waitFor(() => expect(starts()).toHaveLength(1));
    });
    await vi.waitFor(() =>
      expect(hook.tree.root.findByType(WorkflowRunComposer).props.startProblem?.message).toBe(
        t('workflows.problem.targetUnavailable'),
      ),
    );
    // Said inside the form, never as an alert over it; the form, its inputs and the draft stay.
    expect(alert).not.toHaveBeenCalled();
    expect(routing.push).not.toHaveBeenCalled();
    const composer = hook.tree.root.findByType(WorkflowRunComposer);
    expect(composer.props.values[main.name]).toBe(draft);
    expect(composer.props.pending).toBe(false);
    // Closing the form drops the reason; the next opening starts clean.
    await act(async () => {
      const activeModal = modals.find(modal => modal.type === 'custom' && 'visible' in modal && modal.visible === true);
      if (activeModal?.type !== 'custom') throw new Error('missing_details_sheet');
      activeModal.onRequestClose?.();
    });
    // The real host keeps the old content mounted until its exit motion completes.
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(hook.tree.root.findAllByType(WorkflowRunComposer)).toHaveLength(0);
    });
    await act(async () => {
      hook.getCurrent()(
        { name: 'Panel',
          source: { kind: 'catalog', workflow: panel.id } },
      );
    });
    await vi.waitFor(() => expect(hook.tree.root.findAllByType(WorkflowRunComposer)).toHaveLength(1));
    expect(hook.tree.root.findByType(WorkflowRunComposer).props.startProblem ?? null).toBeNull();
  });
  it.each([
    undefined,
    { serverId: 'other-home', sessionId: 'explicit-review-session' },
  ])(
    'starts a Session review through the real form with its exact or explicitly chosen target (%j)',
    async (explicit) => {
      const session = createSessionFixture({
        serverId: storage.getState().profileScope!.serverId,
      });
      const machine = createMachineFixture();
      storage.setState({
        sessions: { [session.id]: session },
        machines: { [machine.id]: machine },
      });
      const hook = await renderHook(
        () => useSessionBuiltinWorkflowStart({ sessionId: session.id }),
        { wrapper: withPanes },
      );
      await act(async () => {
        hook.getCurrent()('builtin:review-and-converge');
      });
      await act(async () => {
        hook.tree.root
          .findByType(WorkflowRunComposer)
          .props.onChangeValues({
            engines: ['codex'],
            ...(explicit ? { reviewSession: explicit } : {}),
          });
      });
      const [button] = findAllHostTestInstances(hook.tree.root,
        (node) => node.props.testID === 'workflow-run-inputs-run');
      expect(button?.props.accessibilityState.disabled).toBe(false);
      await pressTestInstanceAsync(button);
      await vi.waitFor(() => expect(starts()).toHaveLength(1));
      expect(
        WorkflowRunStartRequestV1Schema.parse(starts()[0]!.input).inputs
          ?.reviewSession,
      ).toEqual(
        explicit ?? { serverId: session.serverId, sessionId: session.id },
      );
      expect(starts()[0]?.invocation).toMatchObject({
        defaultSessionId: session.id,
      });
    },
  );
  async function openWorkChooser(screen: Awaited<ReturnType<typeof renderScreen>>) {
    await act(async () => { screen.findByType(DropdownMenu).props.onOpenChange(true); });
    await act(async () => { screen.findByType(DropdownMenu).props.onSelect('run-workflow'); });
    const menu = screen.findByType<typeof DropdownMenu>(DropdownMenu).props;
    if (!menu.renderContent) throw new Error('missing_shared_workflow_chooser');
    // The native portal is painted by live QA. Render the real menu content contract here;
    // chooser rows, library, Account lifetime and selection remain the production path.
    return renderScreen(<>{menu.renderContent({ maxHeight: 600, maxWidth: 400, placement: 'bottom',
      presentation: 'anchored', requestClose: () => menu.onOpenChange(false) })}</>);
  }
  function workLauncher() {
    return {
      unavailableReason: null, intents: [], agentIds: [], providerLaunch: null,
      openConversation: vi.fn(), openRun: vi.fn(), openDetails: vi.fn(), openStartDraft: vi.fn(),
      startBuiltinWorkflow: vi.fn(), startPluginWorkflow: vi.fn(), startWorkflow: vi.fn(),
    };
  }
  it('offers the contribution through the shared Work chooser and selects its reference', async () => {
    installPluginProjection();
    const launcher = workLauncher();
    const screen = await renderScreen(<SessionAgentsLaunchMenu launcher={launcher} testID="plugin-launch" />);
    const chooser = await openWorkChooser(screen);
    await chooser.pressByTestIdAsync(`workflow-choice:${plugin.workflow}`);
    expect(launcher.startWorkflow).toHaveBeenCalledWith({ name: plugin.title,
      source: { kind: 'catalog', workflow: plugin.workflow, pluginVersion: plugin.version } },
      { presentStart: expect.any(Function) });
    expect(routing.push).not.toHaveBeenCalled();
  });
  it('keeps unavailable rows visible and starts a readable saved reference through the Work chooser', async () => {
    const ids = await seedUnavailableWorkflowDefinitions();
    installPluginProjection();
    const launcher = workLauncher();
    const screen = await renderScreen(<SessionAgentsLaunchMenu launcher={launcher} />);
    const chooser = await openWorkChooser(screen);
    const root: React.ComponentProps<typeof SelectionList>['rootStep'] = chooser.findByType(SelectionList).props.rootStep;
    const section = root.sections.find(entry => entry.kind === 'dynamic' && entry.id === 'library');
    if (section?.kind !== 'dynamic') throw new Error('missing_library_options');
    const rows = await section.resolve('', new AbortController().signal);
    for (const id of [ids.missingTitle, ids.badBody]) {
      expect(rows.options.find(row => row.id === id)).toMatchObject({ disabled: true, subtitle: expect.any(String) });
      await act(async () => { await chooser.findByType(SelectionList).props.onSelect(id); });
    }
    expect(launcher.startWorkflow).not.toHaveBeenCalled();
    await act(async () => { await chooser.findByType(SelectionList).props.onSelect(ids.readable); });
    expect(launcher.startWorkflow).toHaveBeenCalledWith({ name: 'Readable recipe',
      source: { kind: 'saved', definitionId: ids.readable, revision: { headerVersion: 1, bodyVersion: 1 } } }, { presentStart: expect.any(Function) });
    expect(routing.push).not.toHaveBeenCalled();
  });
  it('does not retain or select a previous Account catalog while the closed menu changes Account', async () => {
    installPluginProjection();
    await createWorkflowDefinition({ definitionId: '00000000-0000-4000-8000-000000000003',
      definition: plugin.definition, metadata: { title: 'Private saved recipe' } });
    home.requests.length = 0;
    machineRpc.mockClear();
    const launcher = workLauncher();
    const screen = await renderScreen(<SessionAgentsLaunchMenu launcher={launcher} />);
    const workflowReads = () => home.requests.filter(request => request.path === '/v1/artifacts/read' ||
      (request.path === '/v1/artifacts' && request.method !== 'POST') ||
      request.path === '/v3/automations/runs/workflow-storage');
    expect(workflowReads()).toEqual([]);
    expect(machineRpc).not.toHaveBeenCalled();
    const chooser = await openWorkChooser(screen);
    await vi.waitFor(() => expect(workflowReads()).not.toHaveLength(0));
    await act(async () => { chooser.tree.unmount(); screen.findByType(DropdownMenu).props.onOpenChange(false); });
    const next = createDeferred<Response>();
    delayedRead = next.promise;
    await act(async () => {
      await home.switchAccount('picker', 'next-account');
      (await import('@/sync/domains/scope/activeServerAccountScope')).retireActiveServerAccountScopeLifetime();
      storage.setState({ profileScope: { serverId: storage.getState().profileScope!.serverId, accountId: 'next-account' } });
    });
    expect(screen.findByType(DropdownMenu).props.renderContent).toBeUndefined();
    const pendingChooser = await openWorkChooser(screen);
    const root: React.ComponentProps<typeof SelectionList>['rootStep'] = pendingChooser.findByType(SelectionList).props.rootStep;
    expect(root.sections.flatMap(section => section.kind === 'static' ? section.options : [])
      .some(item => item.label === plugin.title || item.label === 'Private saved recipe')).toBe(false);
    await act(async () => { await pendingChooser.findByType(SelectionList).props.onSelect(plugin.workflow); });
    expect(launcher.startWorkflow).not.toHaveBeenCalled();
    await act(async () => { next.resolve(Response.json([])); await next.promise; });
  });
  it('selects the catalog definition with its qualified identity and observed plugin version', async () => {
    installPluginProjection();
    const selected = vi.fn();
    const closed = vi.fn();
    const screen = await renderScreen(
      <WorkflowStartPicker
        onSelect={selected}
        onRequestClose={closed}
        maxHeight={600}
      />,
    );
    await vi.waitFor(async () => {
      await act(async () => { await Promise.resolve(); });
      expect(screen.findByTestId(`workflow-choice:${plugin.workflow}`)).not.toBeNull();
    });
    await screen.pressByTestIdAsync(`workflow-choice:${plugin.workflow}`);
    expect(selected).toHaveBeenCalledWith(
      expect.objectContaining({
        id: plugin.workflow,
        name: plugin.title,
        definition: plugin.definition,
        source: {
          kind: 'catalog',
          workflow: plugin.workflow,
          pluginVersion: plugin.version,
        },
      }),
    );
    expect(closed).toHaveBeenCalled();
  });
});
