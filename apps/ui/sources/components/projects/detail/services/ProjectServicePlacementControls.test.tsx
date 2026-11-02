import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectExecutionChoiceV1, WorkspaceExecutionSettingsV1 } from '@happier-dev/protocol/workspaces/projectWorkerPreferencesV1';
import { buildLocalServiceRows } from '@/sync/domains/local/services/serviceRow';

import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { renderScreen, findTestInstanceByTypeContainingText } from '@/dev/testkit/render/renderScreen';
import { storage } from '@/sync/domains/state/storage';
import { ActionOperationSnapshotV1Schema, type ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import { publishActionOperationObservation } from '@/sync/domains/actionOperations/actionOperationRuntime';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { buildServerFeaturesResponse } from '@/hooks/server/serverFeaturesTestUtils';
import type { ServerScopedMachinePoolSelection } from '@/components/sessions/new/components/machineSelection/useMachineSelectionListModel';
import { getActionSpec } from '@happier-dev/protocol/actions';
import { createActionExecutor } from '@happier-dev/protocol';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createFrontDoorRuntimeActionExecutor } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { createManagedMachineSelectionDraft } from '@/sync/domains/state/newSessionManagedMachineDraft';
import { getServerProfileById, resolveServerProfileScopeIdForIdentifier, setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { LocalServiceLaunchTarget } from '@/sync/domains/local/services/launch';
import { createDeferred, createMachineFixture, flushHookEffects } from '@/dev/testkit';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { computeWorkspaceSyncPolicyDigest } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { buildApprovalRequestArtifactHeaderV1, type ApprovalRequestV2 } from '@happier-dev/protocol';
import { getLocalServiceLauncherState, publishLocalServiceLauncherSnapshot, resetLocalServiceLauncherStoreForTests } from '@/sync/domains/local/services/launch/sharedStore';
import { publishLocalServiceInventorySnapshot, resetLocalServiceInventoryStoreForTests } from '@/sync/domains/local/services/inventory/sharedStore';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { ProjectServiceRelocateInputV1Schema } from '@happier-dev/protocol/workspaces/projectServiceRelocationV1';
import { executeServiceRelocationAction } from './serviceRelocationAction';

type PlacementObservation = ReturnType<typeof import('./projectServicePlacementObservation')['useProjectServicePlacementObservation']>;

const remote = vi.hoisted(() => vi.fn());
// Host renderer uses the real web adapter for the native haptic boundary.
vi.mock('@/components/ui/theme/haptics', () => import('@/components/ui/theme/haptics.web'));
// The addressed daemons are the network boundary; placement, relocation and Action policy stay real.
vi.mock(
  '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
  () => ({ machineRpcWithServerScope: remote }),
);
vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({
    View: 'View',
    ScrollView: 'ScrollView',
    TextInput: 'TextInput',
  });
});
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
);
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
    translate: (key, params) => key === 'projectServices.moveConfirm' || key === 'localServices.row.startingOn'
      || key === 'localServices.row.onMachine' || key === 'localServices.launcher.unavailableReason.bindingUnavailableOnMachine' ? `${key}:${JSON.stringify(params)}` : key,
  }),
);
vi.mock(
  '@/modal',
  async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module,
);
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
// The browser portal/window measurement boundary renders inline; destination/menu logic stays real.
vi.mock('@/components/ui/popover', async importOriginal =>
  (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));

let fixture:
  | Awaited<ReturnType<typeof createPlainArtifactHomeFixture>>
  | undefined;
afterEach(async () => {
  await fixture?.dispose();
  fixture = undefined;
  remote.mockReset();
  storage.getState().clearProjectAccountRowsScope();
  actionOperationStore.reset();
  resetLocalServiceLauncherStoreForTests();
  resetLocalServiceInventoryStoreForTests();
  vi.restoreAllMocks();
});

const base: WorkspaceExecutionSettingsV1 = {
  enabled: false,
  unavailable: 'ask',
  allowAdHoc: false,
  scriptOverrides: {},
  services: {},
};

async function setup(options: Readonly<{
  running: boolean;
  onCommit?: () => void;
  serviceState?: LocalServiceLaunchTarget['serviceState'];
  startedAtMs?: number;
  unavailableReason?: string;
  /** The Machine that owns the service binding observation fails to answer. */
  actualFails?: boolean;
  withRow?: boolean;
  collapsedRow?: boolean;
  liveFeeds?: boolean;
  disablePlacementRead?: boolean;
  showDivider?: boolean;
  /** A committed candidate cannot answer, while SOURCE still owns the native instance. */
  candidateFails?: boolean;
  beforeBindingRead?: (machineId: string) => Promise<void>;
  beforePlacementRead?: () => Promise<void>;
  /** Running/ready groups remount rows while the Services observation owner stays mounted. */
  groupedRows?: boolean;
  snapshotUpdatedAt?: () => number;
  saved?: WorkspaceExecutionSettingsV1['services'][string];
  portable?: boolean;
  modelOnly?: boolean;
  /** Wait for an enabled Runs on (custody known); off for states that keep it disabled. */
  waitEnabled?: boolean;
  sharedObservation?: boolean;
  waiveMoveApproval?: boolean;
  offerWorker?: boolean;
  serviceRuntime?: ReturnType<typeof createFrontDoorRuntimeActionExecutor>;
  waiveStartApproval?: boolean;
  onStart?: (request: Readonly<{ machineId: string; params: unknown }>) => unknown;
  startResponse?: () => unknown;
  beforeRender?: (serverId: string) => void;
  artifactBodyReads?: string[];
  onMove?: (input: unknown) => void;
}>) {
  const writes: WorkspaceExecutionSettingsV1[] = [];
  const poolReads: unknown[] = [];
  let placementReadsFail = false;
  let running = options.running;
  let rowMachineId = 'devbox';
  let actualFails = options.actualFails;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  const moveBoundary = options.onMove ? await createExternalActionAccountHttpBoundary({
    serverUrl: 'https://service-placement-ui.test', serverIdentityId: 'srv_service_creation',
    accountId: 'artifact-account', machineId: 'devbox', actionId: 'projects.service.relocate', tokenEpoch: 0,
    requesterInvocation: 'none', execute: input => {
      options.onMove!(input);
      return { status: 'refused', reasonCode: 'native_boundary_observed' };
    },
  }) : null;
  fixture = await createPlainArtifactHomeFixture(
    'https://service-placement-ui.test',
    {
      currentAccount: Boolean(moveBoundary),
      handleRequest: async (path, init) => {
        const moveResponse = await moveBoundary?.handle(new URL(path, 'https://service-placement-ui.test'), init);
        if (moveResponse) return moveResponse;
        if (path === '/v1/artifacts/read') {
          const request = JSON.parse(String(init?.body)) as { artifactIds: string[]; projection?: string };
          if (request.projection !== 'headers') options.artifactBodyReads?.push(...request.artifactIds);
        } else if (/^\/v1\/artifacts\/[^/]+$/.test(path) && (!init?.method || init.method === 'GET')) {
          options.artifactBodyReads?.push(decodeURIComponent(path.slice('/v1/artifacts/'.length)));
        }
        if ((options.serviceRuntime || moveBoundary) && path === '/v2/account/settings') return json({
          content: { t: 'plain', v: storage.getState().settings }, version: storage.getState().settingsVersion ?? 0,
        });
        // Binding observation now reads the real Machine inventory to qualify child
        // topology. These are ordinary Machines; a missing HTTP fixture is not
        // evidence that their native service custody is unavailable.
        if (path === '/v1/machines?includeRevoked=true') return json(['devbox', 'hz-build-1', 'pool-worker'].map(id => ({
          id, revokedAt: null, replacedByMachineId: null,
        })));
        if (path === '/v1/projects/execution/config/read' && placementReadsFail) return json({ error: 'unavailable' }, 503);
        if (path === '/v1/projects/execution/config/read') {
          await options.beforePlacementRead?.();
          return json(options.saved
            ? { status: 'present', revision: 1, content: { t: 'plain', v: { ...base, services: { server: options.saved } } } }
            : { status: 'absent' });
        }
        if (path === '/v1/projects/execution/config/mutate') {
          const request = JSON.parse(String(init?.body)) as {
            content: { v: WorkspaceExecutionSettingsV1 } | null;
          };
          if (request.content) writes.push(request.content.v);
          return json({
            status: 'updated',
            revision: writes.length,
            cursor: writes.length,
          });
        }
        if (path === '/v1/machines/pools/list') return json({ pools: [] });
        if (path === '/v1/machines/pools/get') {
          const { poolId } = JSON.parse(String(init?.body)) as { poolId: string };
          poolReads.push({ poolId });
          return json({
            pool: { id: poolId, name: 'Build pool', description: null, revision: 1,
              createdAt: 1, updatedAt: 1, members: [{ machineId: 'pool-worker', priorityTier: 0,
                enabled: true, state: 'connected' }] },
            availability: { state: 'known', connectedCount: 1, enabledCount: 1 },
          });
        }
        return null;
      },
      serverFeatures: (() => {
        const features = buildServerFeaturesResponse();
        return { ...features, features: { ...features.features,
          machines: { ...features.features.machines, pools: { enabled: true } } } };
      })(),
    },
  );
  if (options.serviceRuntime || moveBoundary) {
    await setServerProfileIdentityForUrl(fixture.home.serverUrl, 'srv_service_creation');
    await fixture.hydrateAccountSettings();
  }
  const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
  await getServerFeaturesSnapshot({ serverId: fixture.home.id, force: true });
  // Ask first is the Action default; these cases waive it in the Account's canonical settings.
  const { settingsParse } = await import('@/sync/domains/settings/settings');
  const settingsScope = storage.getState().settingsScope;
  if (!settingsScope) throw new Error('expected_settings_scope');
  storage.getState().applySettingsForScope(settingsScope, settingsParse({ ...storage.getState().settings,
    ...(options.serviceRuntime ? { managedMachineCreationEnabled: true } : {}),
    actionsSettingsV1: { v: 1, actions: options.disablePlacementRead ? { 'projects.service.placement.get': { enabled: false } } : {}, approvalWaivedSurfaces: { 'projects.service.placement.set': ['ui'], ...(options.waiveMoveApproval !== false ? { 'projects.service.relocate': ['ui'] } : {}), ...(options.waiveStartApproval ? { 'localServices.launcher.start': ['ui'] } : {}), 'machines.pools.resolve': ['ui'], 'action.operations.cancel': ['ui'] } },
  }), (storage.getState().settingsVersion ?? 0) + 1);
  const serverId = fixture.home.id;
  const scope = { serverId, accountId: 'artifact-account' };
  const source = {
    id: 'checkout',
    serverId,
    machineId: 'devbox',
    rootPath: '/src/happier',
    createdAtMs: 1,
  };
  const worker = { ...source, id: 'worker-checkout', machineId: 'hz-build-1', rootPath: '/copy' };
  const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
  storage.getState().activateProjectAccountRowsScope(scope);
  const baseMachine = createMachineFixture({ id: source.machineId });
  const machine = { ...baseMachine, metadata: { ...baseMachine.metadata!, displayName: 'Source workstation' } };
  const workerMachine = createMachineFixture({ id: worker.machineId });
  const machines = [machine, ...(options.liveFeeds || options.saved ? [{ ...workerMachine,
    metadata: { ...workerMachine.metadata!, displayName: 'Worker workstation' } }] : []),
    ...(options.offerWorker ? [createMachineFixture({ id: 'pool-worker', activeAt: Date.now() })] : [])];
  storage.setState({ machines: Object.fromEntries(machines.map(value => [value.id, value])), machineListByServerId: { [serverId]: machines } });
  storage
    .getState()
    .applyProjectAccountRowsForScope(scope, {
      scope,
      status: 'ready',
      coverage: 'complete',
      workspaceRefs: options.candidateFails || options.liveFeeds ? [source, worker] : [source],
      relationships: options.candidateFails || options.liveFeeds ? [{ v: 1, relationshipId: 'linked-copy', controllerMachineId: source.machineId,
        alphaWorkspaceRefId: source.id, betaWorkspaceRefId: worker.id, mode: 'keep_synced', enabled: false,
        contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) }, createdAtMs: 1, updatedAtMs: 1 }] : [],
      organizations: [],
      revisionsByPhysicalKey: {},
    });
  const target = {
    id: 'server-target',
    source: 'managed_service',
    sourceClass: { kind: 'managed_service', managedServiceId: 'instance' },
    machineId: source.machineId,
    workspaceId: source.id,
    workspace: {
      serverId,
      workspaceId: source.id,
      machineId: source.machineId,
      rootPath: source.rootPath,
    },
    cwd: source.rootPath,
    declaration: {
      workspaceRefId: source.id,
      selection: { kind: 'manifest', name: 'server' },
    },
    serviceState: options.serviceState ?? 'running',
    ...(options.startedAtMs === undefined ? {} : { startedAtMs: options.startedAtMs }),
    ...(options.unavailableReason ? { unavailableReason: options.unavailableReason } : {}),
    readiness: 'ready',
    ...(options.withRow ? { endpointUrl: 'http://127.0.0.1:39081', endpointKind: 'http' as const } : {}),
    title: 'server',
    state: 'available',
    confidence: 'high',
    actions: ['manage'],
  } satisfies LocalServiceLaunchTarget;
  const workerStatusMethod = getActionSpec('projects.worker.status').bindings?.rpcMethod;
  if (!workerStatusMethod) throw new Error('missing_worker_status_method');
  remote.mockImplementation(async ({ machineId, method, payload: params }) => {
    if (options.liveFeeds && method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH) return new Promise(() => {});
    if (options.liveFeeds && (method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_SNAPSHOT
      || method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH)) return {
      protocolVersion: 1, snapshot: { v: 1, machineId, generatedAt: 1, refreshState: 'idle', entries: [], diagnostics: [] },
    };
    if (method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START) {
      await options.onStart?.({ machineId, params });
      if (options.startResponse) return options.startResponse();
      return { protocolVersion: 1, machineId, targetId: params.targetId, status: 'denied', reasonCode: 'native_boundary_observed',
        snapshot: { v: 1, machineId, updatedAt: 1, targets: [] } };
    }
    if (method === 'actionOperation.cancel.v1') return { kind: 'requested' };
    if (method === workerStatusMethod) return {
      eligible: machineId === 'pool-worker',
      candidate: machineId === 'pool-worker' ? { serverId, machineId } : null,
      load: { kind: 'unknown' },
      explanation: machineId === 'pool-worker' ? 'load_unknown' : 'not_accepting',
    };
    await options.beforeBindingRead?.(machineId);
    if (actualFails && (!options.liveFeeds || params?.projection === 'managed_bindings')) throw new Error('owner_unavailable');
    if (options.candidateFails && machineId === worker.machineId) throw new Error('candidate_unavailable');
    return {
    protocolVersion: 1,
    snapshot: {
      v: 1,
      machineId,
      updatedAt: options.snapshotUpdatedAt?.() ?? 1,
      targets:
        running && machineId === (options.liveFeeds ? rowMachineId : source.machineId) ? [{ ...target,
          ...(options.liveFeeds && rowMachineId === worker.machineId ? { machineId: worker.machineId, workspaceId: worker.id,
            workspace: { ...target.workspace, machineId: worker.machineId, workspaceId: worker.id, rootPath: worker.rootPath },
            cwd: worker.rootPath, declaration: { ...target.declaration, workspaceRefId: worker.id } } : {}),
        }] : options.liveFeeds && !params?.projection && machineId === source.machineId ? [{
          ...target, sourceClass: undefined, serviceState: undefined, endpointUrl: undefined, readiness: undefined,
          state: 'unavailable', unavailableReason: 'launch_unavailable', actions: [],
        }] : [],
    },
  };
  });
  let setLifecycle: (key: string) => void = () => {};
  const placementOwner =
    await import('./ProjectServicePlacementControls');
  const { ProjectServicePlacementControls, useProjectServicePlacement, createProjectServicePlacementRenderer } = placementOwner;
  // This consumer contract deliberately stays below the disabled Move producer.
  // Its real caller attaches the accepted Action receipt, not a fabricated runtime outcome.
  const observationOwner = options.sharedObservation
    ? await import('./projectServicePlacementObservation') : null;
  let attach: ((operation: ActionOperationSnapshotV1) => void) | undefined;
  let runMove: ((name: 'server' | 'other', execute: Parameters<PlacementObservation['executeMove']>[1]) => ReturnType<PlacementObservation['executeMove']>) | undefined;
  let setDetail: ((open: boolean) => void) | undefined;
  let setSourceRef: ((refId: string) => void) | undefined;
  let setDeclarationBasis: ((basis: string) => void) | undefined;
  let setControlVisible: ((visible: boolean) => void) | undefined;
  let refreshRow: (() => void) | undefined;
  function ObservationProbe() {
    const observation = observationOwner!.useProjectServicePlacementObservation('server');
    const other = observationOwner!.useProjectServicePlacementObservation('other');
    runMove = (name, execute) => (name === 'server' ? observation : other).executeMove(
      { kind: 'workers', destination: { kind: 'machine', machineId: 'hz-build-1' } }, execute);
    attach = operation => observation.attach({ operationId: operation.operationId,
      destination: operation.domainRef?.kind === 'projectService' && operation.domainRef.destinationWorkspace?.machineId === source.machineId
        ? { kind: 'primary' } : { kind: 'workers', destination: { kind: 'machine', machineId: 'hz-build-1' } } });
    return null;
  }
  let model: ReturnType<typeof useProjectServicePlacement> | null = null;
  function ModelProbe() {
    model = useProjectServicePlacement({ serverId, refId: source.id, machineId: source.machineId }, 'server');
    return null;
  }
  const { WorkerDestinationPicker } =
    await import('@/components/projects/workers/WorkerDestinationPicker');
  const { useLocalServiceLauncherStartAction } = await import('@/components/sessions/localServices/launcherStartAction');
  const { ServiceRowView } = await import('@/components/sessions/localServices/ServiceRowView');
  const { useLocalServiceLiveFeeds } = await import('@/components/sessions/localServices/useLocalServiceLiveFeeds');
  const { createLocalServiceInventoryState } = await import('@/sync/domains/local/services/inventory/store');
  const suppliedInventory = createLocalServiceInventoryState();
  function LiveRow({ placement }: Readonly<{ placement: React.ReactNode }>) {
    const feeds = useLocalServiceLiveFeeds({ serverId, machineId: source.machineId, workspaceRefId: source.id,
      workspaceRoot: source.rootPath, scope: 'workspace', inventoryState: suppliedInventory });
    const row = buildLocalServiceRows({ inventoryRows: [], launchTargets: [...(feeds.launcherState?.targetsById.values() ?? [])],
      sessionId: null, scope: 'workspace' })[0];
    const renderedPlacement = row ? createProjectServicePlacementRenderer(
      { serverId, refId: source.id, machineId: source.machineId },
      { server: { portable: options.portable !== false } },
    )?.(row) : null;
    // Keep test selectors stable while exercising the production row → placement wiring.
    const rowPlacement = React.isValidElement<React.ComponentProps<typeof ProjectServicePlacementControls>>(renderedPlacement)
      ? React.cloneElement(renderedPlacement, { testID: 'placement' }) : placement;
    return <>{row ? <ServiceRowView key={options.groupedRows ? row.status : undefined} row={row} testID="service-row" presentation="detail" placement={rowPlacement}
      onStartLauncherTarget={async () => start!()} machineName="Source workstation" /> : null}</>;
  }
  let start: ((choice?: ProjectExecutionChoiceV1) => Promise<unknown>) | undefined;
  function StartProbe() {
    const launch = useLocalServiceLauncherStartAction({ runtimeActionExecute: options.serviceRuntime, serverId });
    const launchTarget: LocalServiceLaunchTarget = { id: 'declared-server', machineId: source.machineId,
      source: 'managed_service', title: 'server', actions: ['start'], state: 'available', confidence: 'high',
      workspace: { serverId, workspaceId: source.id, machineId: source.machineId, rootPath: source.rootPath },
      declaration: { workspaceRefId: source.id, selection: { kind: 'manifest', name: 'server' } } };
    start = async choice => launch?.(launchTarget, choice);
    return null;
  }
  function Host() {
    const [, setFeedRevision] = React.useState(0);
    refreshRow = () => setFeedRevision(current => current + 1);
    const [lifecycleKey, setKey] = React.useState('initial');
    const [detail, setDetailOpen] = React.useState(false);
    const [refId, setRefId] = React.useState(source.id);
    const [declarationBasis, setBasis] = React.useState('manifest-v1');
    const [controlVisible, setVisible] = React.useState(true);
    setDeclarationBasis = setBasis;
    setControlVisible = setVisible;
    setDetail = setDetailOpen;
    setSourceRef = setRefId;
    setLifecycle = setKey;
    if (options.modelOnly) return <ModelProbe />;
    const control = (
      <ProjectServicePlacementControls
        key={options.sharedObservation ? 'list' : detail ? 'detail' : 'list'}
        testID="placement"
        serviceName="server"
        source={{ serverId, refId, machineId: source.machineId }}
        declaration={{ portable: options.portable !== false, currentnessKey: declarationBasis }}
        lifecycleKey={lifecycleKey}
        showDivider={options.showDivider}
      />
    );
    if (!observationOwner) return control;
    const Provider = observationOwner.ProjectServicePlacementObservationProvider;
    const rowRefId = rowMachineId === source.machineId ? source.id : worker.id;
    const rowTarget = { ...target, machineId: rowMachineId,
      workspace: { ...target.workspace, machineId: rowMachineId, workspaceId: rowRefId },
      declaration: { ...target.declaration, workspaceRefId: rowRefId } };
    const row = buildLocalServiceRows({ inventoryRows: [], launchTargets: [running ? rowTarget : {
      ...rowTarget, serviceState: 'stopped', endpointUrl: undefined, actions: ['start'],
    }], sessionId: null, scope: 'workspace' })[0]!;
    return <Provider source={{ serverId, refId, machineId: source.machineId }} runtimeActionExecute={options.serviceRuntime}><ObservationProbe /><StartProbe />{controlVisible ? options.liveFeeds
      ? <LiveRow placement={control} /> : options.withRow
      ? <ServiceRowView row={row} testID="service-row" presentation={options.collapsedRow ? 'row' : 'detail'} placement={control}
          onStartLauncherTarget={async () => start!()} machineName="Source workstation" /> : control : null}
      {detail ? <ProjectServicePlacementControls testID="detail.placement" serviceName="server"
        source={{ serverId, refId, machineId: source.machineId }} declaration={{ portable: options.portable !== false, currentnessKey: declarationBasis }} lifecycleKey={lifecycleKey} /> : null}
    </Provider>;
  }
  options.beforeRender?.(serverId);
  const screen = await renderScreen(<React.Profiler id="services" onRender={() => options.onCommit?.()}><Host /></React.Profiler>);
  if (options.modelOnly) await vi.waitFor(() => expect(model?.state.kind).toBe('ready'));
  else if (options.waitEnabled !== false) await vi.waitFor(() =>
    expect(screen.findAllByTestId('placement.runsOn')[0]?.props.disabled, JSON.stringify([fixture?.requests, screen.getTextContent(), remote.mock.calls])).toBe(false),
  );
  const choose = async (machineId: string) => {
    await act(async () => {
      screen.tree
        .findByType(WorkerDestinationPicker)
        .props.onChoose({
          kind: 'workers',
          destination: { kind: 'machine', machineId },
        });
    });
  };
  const choosePool = async (poolId: string) => {
    const selection: ServerScopedMachinePoolSelection = {
      serverId,
      accountId: 'artifact-account',
      pool: { pool: { id: poolId, name: 'Build pool', description: null, revision: 1,
        createdAt: 1, updatedAt: 1, members: [] },
        availability: { state: 'known', connectedCount: 1, enabledCount: 1 } },
    };
    await act(async () => {
      await screen.tree.findByType(WorkerDestinationPicker).props.onChoose({
        kind: 'workers', destination: { kind: 'pool', poolId, selection: 'automatic' },
      }, selection);
    });
  };
  const runsOn = () => screen.findAllByTestId('placement.runsOn')[0]!;
  const catalogBinding = async () => {
    const { resolveServerCredentialAccountScope } = await import('@/sync/domains/scope/serverCredentialAccountScope');
    const resolved = await resolveServerCredentialAccountScope(serverId);
    if (resolved.kind !== 'bound' || !resolved.credentialKey) throw new Error('Expected the fixture Home credential binding');
    return { serverId: resolved.scope.serverId, accountId: resolved.scope.accountId, credentialKey: resolved.credentialKey };
  };
  return { screen, writes, poolReads, choose, choosePool, runsOn, model: () => model!, serverId,
    catalogBinding,
    bindingState: async (machineId: string) => getLocalServiceLauncherState({ ...await catalogBinding(), machineId,
      scope: 'workspace', workspaceRoot: machineId === source.machineId ? source.rootPath : worker.rootPath,
      projection: 'managed_bindings' }),
    setRunning: (value: boolean) => { running = value; refreshRow?.(); },
    setRowMachine: (machineId: string) => { rowMachineId = machineId; refreshRow?.(); },
    setActualFails: (failed: boolean) => { actualFails = failed; },
    start: (choice?: ProjectExecutionChoiceV1) => start!(choice),
    setDeclarationBasis: (basis: string) => setDeclarationBasis!(basis), setControlVisible: (visible: boolean) => setControlVisible!(visible),
    failPlacementReads: () => { placementReadsFail = true; },
    setLifecycle: (key: string) => setLifecycle(key), setDetail: (open: boolean) => setDetail!(open),
    setSourceRef: (refId: string) => setSourceRef!(refId), attach: (operation: ActionOperationSnapshotV1) => attach!(operation),
    runMove: (...args: Parameters<NonNullable<typeof runMove>>) => runMove!(...args) };
}

describe('Service Runs on through the placement and relocation Actions', () => {
  it('does not add a shared confirmation after the authored Move review under default host policy', async () => {
    const moves: unknown[] = [];
    const { Modal } = await import('@/modal');
    vi.mocked(Modal.confirm).mockClear();
    const { screen, choose, writes } = await setup({ running: true, waiveMoveApproval: false,
      onMove: input => moves.push(input) });
    try {
      await choose('hz-build-1');
      await vi.waitFor(() => expect(screen.findAllHostsByTestId('placement.move.confirm')).toHaveLength(1));
      expect(Modal.confirm).not.toHaveBeenCalled();
      expect(moves).toEqual([]);
      expect(fixture!.boundary.list()).toEqual([]);
      await screen.pressByTestIdAsync('placement.move.confirm');
      await vi.waitFor(() => expect(screen.findByTestId('placement.move.refused')).toBeTruthy());
      expect(Modal.confirm).not.toHaveBeenCalled();
      expect(moves).toHaveLength(1);
      expect(moves[0]).toMatchObject({
        currentTarget: { managedServiceId: 'instance', machineId: 'devbox' },
        selectedTarget: { machineId: 'hz-build-1' },
        destination: { kind: 'workers', destination: { kind: 'machine', machineId: 'hz-build-1' } },
      });
      expect(fixture!.boundary.list()).toEqual([]);
      expect(writes).toEqual([]);
    } finally { await screen.unmount(); }
  });
  it('opens only this Project pending approval bodies across unrelated Starts, Back and reconnect', async () => {
    const bodyReads: string[] = [];
    const h = await setup({ running: false, actualFails: true, liveFeeds: true, sharedObservation: true, waitEnabled: false,
      artifactBodyReads: bodyReads,
      beforeRender(serverId) {
        const workspace = { serverId, machineId: 'devbox', workspaceId: 'checkout', rootPath: '/src/happier' };
        const request = { machineId: 'hz-build-1', targetId: 'server-target', workspace,
          declaration: { workspaceRefId: 'checkout', selection: { kind: 'manifest' as const, name: 'server' } } };
        const serviceStartReview = { request, target: { ...workspace, machineId: 'hz-build-1', workspaceId: 'worker-checkout', rootPath: '/copy' },
          reviewedEffectDigest: 'a'.repeat(64), reviewedEffect: {}, setup: { required: false,
            project: { serverId, projectId: 'project' }, reviewedEffectDigest: 'b'.repeat(64), reviewedEffect: {} } };
        const base: ApprovalRequestV2 = { v: 2, status: 'approved', createdAtMs: 1, updatedAtMs: 2,
          createdBy: { surface: 'cli' }, requestedSurface: 'cli', actionId: 'localServices.launcher.start', actionArgs: request,
          executionOriginV1: { v: 1, authority: 'present_user', surface: 'cli', caller: { kind: 'host' }, serverId,
            accountId: 'artifact-account', actionId: 'localServices.launcher.start', requestId: 'pending-start', machineId: 'hz-build-1' },
          summary: 'Start server', decision: { kind: 'approve', decidedAtMs: 2 },
          preview: { serviceStartReview } };
        const values: Array<{ id: string; approval: ApprovalRequestV2 }> = Array.from({ length: 1000 }, (_, index) => {
          const otherRequest = { ...request, workspace: { ...workspace, workspaceId: `other-checkout-${index}`, rootPath: `/other-${index}`,
              machineId: index % 2 ? 'other-machine' : 'devbox' },
            declaration: { ...request.declaration, workspaceRefId: `other-checkout-${index}` } };
          return { id: `unrelated-start-${index}`, approval: { ...base, status: index % 2 ? 'approved' as const : 'executing' as const,
            executionOriginV1: { ...base.executionOriginV1, requestId: `unrelated-request-${index}` },
            actionArgs: otherRequest, preview: { serviceStartReview: { ...serviceStartReview, request: otherRequest,
              target: { ...serviceStartReview.target, workspaceId: `worker-other-${index}`, rootPath: `/copy-other-${index}` },
              setup: { ...serviceStartReview.setup, project: { serverId, projectId: `project-other-${index}` } } } } } };
        });
        values.push({ id: 'pending-start', approval: base });
        for (const { id, approval } of values) {
          const header = buildApprovalRequestArtifactHeaderV1(approval);
          fixture!.boundary.replaceStoredRow({ id, ownerAccountId: 'artifact-account', access: 'owner', encryptionMode: 'plain',
            publicAudience: 'none', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            header: encodePlainArtifactStoredContent(header), body: encodePlainArtifactStoredContent({ body: JSON.stringify(approval) }),
            headerVersion: 2, bodyVersion: 2, seq: 2, createdAt: 1, updatedAt: 2 });
          storage.getState().updateArtifact({ id, title: approval.summary, header, isDecrypted: true,
            headerVersion: 2, bodyVersion: 2, seq: 2, createdAt: 1, updatedAt: 2 });
        }
      } });
    try {
      await vi.waitFor(() => expect(h.screen.getTextContent()).toContain('localServices.row.startingOn'));
      await flushHookEffects();
      expect(bodyReads.length).toBe(1);
      expect(bodyReads).toEqual(['pending-start']);
      await act(async () => { h.setDetail(true); });
      await act(async () => { h.setDetail(false); });
      expect(bodyReads).toEqual(['pending-start']);
      await act(async () => publishHomeAccountChange(h.serverId, undefined, { source: 'connected' }));
      await vi.waitFor(() => expect(bodyReads).toEqual(['pending-start', 'pending-start']));
      expect(h.screen.getTextContent()).toContain('localServices.row.startingOn');
    } finally { await h.screen.unmount(); }
  });
  it.each([['app', 'hz-build-1', 'running'], ['app', 'devbox', 'running'], ['cli', 'hz-build-1', 'running'], ['cli', 'devbox', 'running'],
    ['cli', 'hz-build-1', 'failed']] as const)(
    'retains successful %s Start handoff over cached absence on %s until native %s, then accepts a real kill', async (entry, machineId, nativeState) => {
      const dispatch = createDeferred<void>();
      const freshRead = createDeferred<void>();
      const readEntered = createDeferred<void>();
      let placementRead = createDeferred<void>();
      const frames: boolean[] = [];
      const expectedMachine = machineId === 'devbox' ? 'Source workstation' : 'Worker workstation';
      const startingText = `localServices.row.startingOn:{"machine":"${expectedMachine}"}`;
      let captureFrame = () => {};
      let holdReads = false;
      let holdPlacement = false;
      let operation: ActionOperationSnapshotV1;
      const { createDefaultRuntimeActionExecutor } = await import('@/sync/ops/actions/defaultRuntimeActionExecutor');
      const execute = createFrontDoorRuntimeActionExecutor(createActionExecutor(createActionExecutorBoundaryFixture({
        isActionApprovalRequired: () => false, runtimeActionExecute: createDefaultRuntimeActionExecutor(),
      })));
      const h = await setup({ running: false, serviceState: nativeState, liveFeeds: true, sharedObservation: true, serviceRuntime: execute,
        onCommit: () => captureFrame(),
        waiveStartApproval: true,
        groupedRows: true,
        beforePlacementRead: async () => { if (holdPlacement) await placementRead.promise; },
        saved: { runsOn: entry === 'cli' || machineId === 'devbox' ? { kind: 'primary' }
          : { kind: 'workers', destination: { kind: 'machine', machineId } }, unavailable: 'fail' },
        beforeBindingRead: async () => { if (holdReads) { readEntered.resolve(); await freshRead.promise; } },
        onStart: async () => { publishActionOperationObservation({ serverId: h.serverId, machineId,
          observation: 'available', snapshots: [operation] }); await dispatch.promise; },
        startResponse: () => ({ protocolVersion: 1, machineId, targetId: 'declared-server', status: 'succeeded',
          snapshot: { v: 1, machineId, updatedAt: 1, targets: machineId === 'devbox' ? [{
            id: 'server-target', source: 'managed_service', machineId, workspaceId: 'checkout',
            workspace: { serverId: h.serverId, machineId, workspaceId: 'checkout', rootPath: '/src/happier' },
            declaration: { workspaceRefId: 'checkout', selection: { kind: 'manifest', name: 'server' } },
            cwd: '/src/happier', title: 'server', confidence: 'high', state: 'unavailable', unavailableReason: 'launch_unavailable', actions: [],
          }] : [] } }),
      });
      const workspace = { serverId: h.serverId, machineId: 'devbox', workspaceId: 'checkout', rootPath: '/src/happier' };
      const declaration = { workspaceRefId: 'checkout', selection: { kind: 'manifest' as const, name: 'server' } };
      operation = ActionOperationSnapshotV1Schema.parse({ version: 1, operationId: 'settling-start', requestId: 'settling-request',
        revision: 1, actionId: 'localServices.launcher.start', state: 'running', scope: { accountId: 'artifact-account', machineId },
        title: 'Start server', createdAt: 10, startedAt: 11, cancellation: 'unsupported',
        domainRef: { kind: 'projectService', purpose: 'start', sourceWorkspace: { serverId: h.serverId, refId: 'checkout' }, workspace, declaration },
        progress: { kind: 'phase', phase: 'starting', label: 'Starting' } });
      let start: Promise<unknown> | undefined;
      try {
        await vi.waitFor(() => expect(h.screen.findByTestId('service-row-start-row')).toBeTruthy());
        if (entry === 'app') {
          const firstFrames: string[] = [];
          captureFrame = () => firstFrames.push(h.screen.getTextContent());
          await act(async () => { start = h.screen.pressByTestIdAsync('service-row-start-row'); });
          expect(firstFrames.length).toBeGreaterThan(0);
          expect(firstFrames.every(frame => frame.includes(startingText))).toBe(true);
          captureFrame = () => {};
        }
        else {
          const request = { machineId, targetId: 'declared-server', workspace, declaration };
          const approval: ApprovalRequestV2 = { v: 2, status: 'approved', createdAtMs: 1, updatedAtMs: 2,
            createdBy: { surface: 'cli' }, requestedSurface: 'cli', actionId: 'localServices.launcher.start', actionArgs: request,
            executionOriginV1: { v: 1, authority: 'present_user', surface: 'cli', caller: { kind: 'host' }, serverId: h.serverId,
              accountId: 'artifact-account', actionId: 'localServices.launcher.start', requestId: 'settling-request', machineId },
            summary: 'Start server', decision: { kind: 'approve', decidedAtMs: 2 }, preview: { serviceStartReview: { request,
              target: { ...workspace, machineId, workspaceId: machineId === 'devbox' ? 'checkout' : 'worker-checkout', rootPath: machineId === 'devbox' ? '/src/happier' : '/copy' },
              reviewedEffectDigest: 'a'.repeat(64), reviewedEffect: { command: { source: { kind: 'command', command: 'serve' } } },
              setup: { required: false, project: { serverId: h.serverId, projectId: 'project' }, reviewedEffectDigest: 'b'.repeat(64), reviewedEffect: {} } } } };
          fixture!.boundary.replaceStoredRow({ id: 'settling-approval', ownerAccountId: 'artifact-account', access: 'owner', encryptionMode: 'plain',
            publicAudience: 'none', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(approval)),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(approval) }), headerVersion: 2, bodyVersion: 2, seq: 2, createdAt: 1, updatedAt: 2 });
          await act(async () => storage.getState().updateArtifact({ id: 'settling-approval', title: approval.summary,
            header: buildApprovalRequestArtifactHeaderV1(approval), body: JSON.stringify(approval), isDecrypted: true,
            headerVersion: 2, bodyVersion: 2, seq: 2, createdAt: 1, updatedAt: 2 }));
          await vi.waitFor(() => expect(h.screen.getTextContent()).toContain('localServices.row.startingOn'));
          expect(h.screen.getTextContent()).toContain(startingText);
          await act(async () => publishActionOperationObservation({ serverId: h.serverId, machineId, observation: 'available', snapshots: [operation] }));
        }
        await vi.waitFor(() => expect(h.screen.getTextContent()).toContain('localServices.row.startingOn'));
        holdReads = true;
        const currentTarget = { kind: 'managed_service', managedServiceId: 'instance', machineId,
          workspaceId: machineId === 'devbox' ? 'checkout' : 'worker-checkout', cwd: machineId === 'devbox' ? '/src/happier' : '/copy',
          declaration: { ...declaration, workspaceRefId: machineId === 'devbox' ? 'checkout' : 'worker-checkout' } };
        operation = ActionOperationSnapshotV1Schema.parse({ ...operation, revision: 2, state: 'succeeded', settledAt: 20,
          domainRef: { ...operation.domainRef, workspace: { ...workspace, machineId, workspaceId: currentTarget.workspaceId, rootPath: currentTarget.cwd },
            declaration: currentTarget.declaration, currentTarget } });
        captureFrame = () => frames.push(Boolean(h.screen.findByTestId('service-row-start-row') || h.screen.findByTestId('service-row-status-unavailable')));
        await act(async () => { publishActionOperationObservation({ serverId: h.serverId, machineId, observation: 'available', snapshots: [operation] });
          dispatch.resolve(); await start; });
        await readEntered.promise;
        expect(h.screen.findByTestId('service-row-start-row')).toBeNull();
        expect(h.screen.findByTestId('service-row-status-unavailable')).toBeNull();
        expect(h.screen.findByTestId('service-row-status-operation')).toBeTruthy();
        expect(h.screen.getTextContent()).not.toContain('common.loading');
        // Pending admission is Starting. The exact Machine and Runs on value
        // are checked below when the completed native binding reaches the row.
        expect(frames.length).toBeGreaterThan(0);
        expect(frames.every(exposedIdleOrUnavailable => !exposedIdleOrUnavailable)).toBe(true);
        const runningFrames: string[] = [];
        const { Text } = await import('@/components/ui/text/Text');
        const runsOnFrames: boolean[] = [];
        holdPlacement = true;
        captureFrame = () => {
          if (h.screen.findByTestId(`service-row-status-${nativeState}`)) {
            runningFrames.push(h.screen.getTextContent());
            runsOnFrames.push(Boolean(findTestInstanceByTypeContainingText(h.runsOn(), Text,
              machineId === 'devbox' ? 'projectServices.thisMachine' : expectedMachine)));
          }
        };
        await act(async () => { h.setRowMachine(machineId); h.setRunning(true); holdReads = false; freshRead.resolve(); });
        await vi.waitFor(() => expect(h.screen.findByTestId(`service-row-status-${nativeState}`)).toBeTruthy());
        expect(runningFrames.length).toBeGreaterThan(0);
        expect(runningFrames[0]).toContain(expectedMachine);
        expect(runsOnFrames.every(Boolean)).toBe(true);
        expect(runningFrames.every(frame => !frame.includes('common.loading'))).toBe(true);
        // The retained destination is presentation, not fresh custody or a CAS
        // basis. A remounted reader cannot safely save/move until its read settles.
        expect(h.runsOn().props.disabled).toBe(true);
        captureFrame = () => {};
        await act(async () => { holdPlacement = false; placementRead.resolve(); });
        if (nativeState === 'running') await vi.waitFor(() => expect(h.runsOn().props.disabled).toBe(false));
        expect(h.screen.getTextContent()).not.toContain('common.loading');
        if (nativeState === 'failed') return;
        // The acknowledged receipt cannot revive Loading on a later complete read
        // without this instance (including a genuine native exit).
        placementRead = createDeferred<void>();
        holdPlacement = true;
        await act(async () => { h.setRunning(false); publishLocalServiceInventorySnapshot({ ...await h.catalogBinding(), machineId }, {
          v: 1, machineId, generatedAt: 2, refreshState: 'idle', entries: [], diagnostics: [] }); });
        await vi.waitFor(() => expect(h.screen.findByTestId('service-row-start-row')).toBeTruthy());
        expect(h.screen.findByTestId('service-row-status-operation')).toBeNull();
        if (entry === 'app') {
          const pendingFrames: string[] = [];
          captureFrame = () => pendingFrames.push(h.screen.getTextContent());
          await act(async () => { start = h.screen.pressByTestIdAsync('service-row-start-row'); });
          expect(h.screen.getTextContent()).toContain(startingText);
          expect(pendingFrames.length).toBeGreaterThan(0);
          expect(pendingFrames.every(frame => frame.includes(startingText))).toBe(true);
          captureFrame = () => {};
          await act(async () => { holdPlacement = false; placementRead.resolve(); await start; });
        }
      } finally { dispatch.resolve(); freshRead.resolve(); placementRead.resolve(); await start; await h.screen.unmount(); }
    });

  it('retains actual placement across a control remount, replaces it with a fresh read and resets it on Source change', async () => {
    const read = createDeferred<void>();
    let hold = false;
    const h = await setup({ running: true, sharedObservation: true,
      saved: { runsOn: { kind: 'workers', destination: { kind: 'machine', machineId: 'hz-build-1' } }, unavailable: 'primary' },
      beforePlacementRead: async () => { if (hold) await read.promise; } });
    try {
      await act(async () => h.setControlVisible(false));
      hold = true;
      await act(async () => h.setControlVisible(true));
      expect(h.screen.getTextContent()).not.toContain('common.loading');
      // The retained actual location wins over a differing next-start preference.
      expect(h.screen.getTextContent()).not.toContain('Worker workstation');
      expect(h.runsOn().props.disabled).toBe(true);
      expect(h.screen.findByTestId('placement.fallback:primary')?.props.accessibilityState).toMatchObject({ checked: true, disabled: true });
      await act(async () => { h.setRunning(false); hold = false; read.resolve(); });
      await vi.waitFor(() => expect(h.runsOn().props.disabled).toBe(false));
      expect(h.screen.getTextContent()).toContain('Worker workstation');
      await act(async () => h.setSourceRef('different-checkout'));
      expect(h.screen.getTextContent()).not.toContain('Worker workstation');
    } finally { read.resolve(); await h.screen.unmount(); }
  });

  it('keeps safe controls enabled during a background refresh and replaces retained placement with a read failure', async () => {
    const read = createDeferred<void>();
    let hold = false;
    const h = await setup({ running: false, sharedObservation: true,
      beforePlacementRead: async () => { if (hold) await read.promise; } });
    try {
      hold = true;
      await act(async () => h.setLifecycle('refresh'));
      expect(h.runsOn().props.disabled).toBe(false);
      expect(h.screen.findByTestId('placement.fallback:fail')?.props.accessibilityState).toMatchObject({ disabled: false });
      await act(async () => { hold = false; read.resolve(); });
      h.failPlacementReads();
      await act(async () => h.setLifecycle('failed-refresh'));
      await vi.waitFor(() => expect(h.screen.findByTestId('placement.unavailable')).toBeTruthy());
      expect(h.screen.findByTestId('placement.runsOn')).toBeNull();
      expect(h.writes).toEqual([]);
    } finally { read.resolve(); await h.screen.unmount(); }
  });

  it('keeps acknowledged Running while a changed SOURCE feed awaits its complete binding read, then shows native exit', async () => {
    const bindingRead = createDeferred<void>();
    const entered = createDeferred<void>();
    let hold = false;
    let updatedAt = 1;
    const frames: string[] = [];
    let capture = () => {};
    const h = await setup({ running: true, liveFeeds: true, sharedObservation: true,
      snapshotUpdatedAt: () => updatedAt,
      onCommit: () => capture(), beforeBindingRead: async () => { if (hold) { entered.resolve(); await bindingRead.promise; } } });
    try {
      await vi.waitFor(() => expect(h.screen.findByTestId('service-row-status-running')).toBeTruthy());
      const workspace = { serverId: h.serverId, machineId: 'devbox', workspaceId: 'checkout', rootPath: '/src/happier' };
      const declaration = { workspaceRefId: 'checkout', selection: { kind: 'manifest' as const, name: 'server' } };
      const currentTarget = { kind: 'managed_service' as const, managedServiceId: 'instance', machineId: 'devbox',
        workspaceId: 'checkout', cwd: workspace.rootPath, declaration };
      let operation = ActionOperationSnapshotV1Schema.parse({ version: 1, operationId: 'acknowledged-start', revision: 1,
        actionId: 'localServices.launcher.start', state: 'running', scope: { accountId: 'artifact-account', machineId: 'devbox' },
        title: 'Start server', createdAt: 10, startedAt: 11, cancellation: 'unsupported',
        domainRef: { kind: 'projectService', purpose: 'start', sourceWorkspace: { serverId: h.serverId, refId: 'checkout' }, workspace, declaration } });
      await act(async () => publishActionOperationObservation({ serverId: h.serverId, machineId: 'devbox', observation: 'available', snapshots: [operation] }));
      operation = ActionOperationSnapshotV1Schema.parse({ ...operation, revision: 2, state: 'succeeded', settledAt: 20,
        domainRef: { ...operation.domainRef, currentTarget } });
      await act(async () => publishActionOperationObservation({ serverId: h.serverId, machineId: 'devbox', observation: 'available', snapshots: [operation] }));
      await vi.waitFor(() => expect(h.screen.findByTestId('service-row-status-running')).toBeTruthy());
      hold = true;
      capture = () => frames.push(h.screen.getTextContent());
      await act(async () => publishLocalServiceLauncherSnapshot({ ...await h.catalogBinding(), machineId: 'devbox',
        scope: 'workspace', workspaceRoot: workspace.rootPath }, { v: 1, machineId: 'devbox', updatedAt: 2, targets: [{
          id: 'server-target', source: 'managed_service', sourceClass: { kind: 'managed_service', managedServiceId: 'instance' },
          machineId: 'devbox', workspaceId: 'checkout', workspace, declaration, cwd: workspace.rootPath,
          title: 'server', state: 'available', confidence: 'high', actions: ['manage'], serviceState: 'running', readiness: 'ready',
          endpointUrl: 'http://127.0.0.1:39081', endpointKind: 'http', startedAtMs: 10,
        }] }));
      await entered.promise;
      expect(h.screen.findByTestId('service-row-status-running'), h.screen.getTextContent()).toBeTruthy();
      expect(frames.length).toBeGreaterThan(0);
      expect(frames.every(frame => !frame.includes('localServices.rowStatus.loading') && !frame.includes('common.loading'))).toBe(true);
      capture = () => {};
      await act(async () => { updatedAt = 3; h.setRunning(false); hold = false; bindingRead.resolve();
        publishLocalServiceInventorySnapshot({ ...await h.catalogBinding(), machineId: 'devbox' }, {
          v: 1, machineId: 'devbox', generatedAt: 3, refreshState: 'idle', entries: [], diagnostics: [] }); });
      await vi.waitFor(() => expect(h.screen.findByTestId('service-row-start-row')).toBeTruthy());
      expect(h.screen.getTextContent()).not.toContain('common.loading');
    } finally { bindingRead.resolve(); await h.screen.unmount(); }
  });

  it('keeps the receiving Machine unspecified while the first Start placement read is pending', async () => {
    const placement = createDeferred<void>();
    const entered = createDeferred<void>();
    const dispatched = createDeferred<void>();
    const reply = createDeferred<void>();
    const { createDefaultRuntimeActionExecutor } = await import('@/sync/ops/actions/defaultRuntimeActionExecutor');
    const execute = createFrontDoorRuntimeActionExecutor(createActionExecutor(createActionExecutorBoundaryFixture({
      isActionApprovalRequired: () => false, runtimeActionExecute: createDefaultRuntimeActionExecutor(),
    })));
    const h = await setup({ running: false, sharedObservation: true, withRow: true, collapsedRow: true, waitEnabled: false,
      serviceRuntime: execute, waiveStartApproval: true,
      onStart: async () => { dispatched.resolve(); await reply.promise; },
      beforePlacementRead: async () => { entered.resolve(); await placement.promise; } });
    let start: Promise<unknown> | undefined;
    try {
      await vi.waitFor(() => expect(h.screen.findByTestId('service-row-start')).toBeTruthy());
      await act(async () => { start = h.screen.pressByTestIdAsync('service-row-start'); });
      await entered.promise;
      expect(h.screen.getTextContent()).toContain('localServices.rowStatus.starting');
      expect(h.screen.getTextContent()).not.toContain('projectServices.otherMachine');
      expect(h.screen.getTextContent()).not.toContain('localServices.row.startingOn');
      await act(async () => { placement.resolve(); });
      await dispatched.promise;
      expect(h.screen.getTextContent()).toContain('localServices.row.startingOn:{"machine":"Source workstation"}');
      expect(h.screen.getTextContent()).not.toContain('projectServices.otherMachine');
    } finally { placement.resolve(); reply.resolve(); await start; await h.screen.unmount(); }
  });

  it('names the saved receiving Machine throughout app Start before native admission and clears a refused dispatch', async () => {
    const reply = createDeferred<void>();
    const entered = createDeferred<void>();
    const { createDefaultRuntimeActionExecutor } = await import('@/sync/ops/actions/defaultRuntimeActionExecutor');
    const { isActionApprovalRequiredInState } = await import('@/sync/domains/settings/actionsSettings');
    const execute = createFrontDoorRuntimeActionExecutor(createActionExecutor(createActionExecutorBoundaryFixture({
      isActionApprovalRequired: (actionId, context) => isActionApprovalRequiredInState(storage.getState(), actionId, context),
      runtimeActionExecute: createDefaultRuntimeActionExecutor(),
    })));
    const h = await setup({ running: false, sharedObservation: true, withRow: true,
      serviceRuntime: execute, waiveStartApproval: true,
      saved: { runsOn: { kind: 'workers', destination: { kind: 'machine', machineId: 'hz-build-1' } }, unavailable: 'fail' },
      onStart: async () => { entered.resolve(); await reply.promise; } });
    let start: Promise<unknown> | undefined;
    try {
      await act(async () => { start = h.screen.pressByTestIdAsync('service-row-start-row'); });
      await entered.promise;
      expect(h.screen.getTextContent()).toContain('localServices.row.startingOn:{"machine":"Worker workstation"}');
      expect(h.screen.getTextContent()).not.toContain('localServices.row.startingOn:{"machine":"Source workstation"}');
      expect(h.screen.findByTestId('service-row-status-unavailable')).toBeNull();
      await act(async () => { reply.resolve(); await start; });
      await vi.waitFor(() => expect(h.screen.getTextContent()).not.toContain('localServices.row.startingOn'));
    } finally { reply.resolve(); await start; await h.screen.unmount(); }
  });

  it('projects an approved CLI Start from its existing Artifact until native admission, without borrowing another scope', async () => {
    const h = await setup({ running: false, actualFails: true, liveFeeds: true, sharedObservation: true, waitEnabled: false });
    const workspace = { serverId: h.serverId, machineId: 'devbox', workspaceId: 'checkout', rootPath: '/src/happier' };
    const request = { machineId: 'hz-build-1', targetId: 'server-target', workspace,
      declaration: { workspaceRefId: 'checkout', selection: { kind: 'manifest' as const, name: 'server' } } };
    const approval: ApprovalRequestV2 = { v: 2, status: 'approved', createdAtMs: 1, updatedAtMs: 2,
      createdBy: { surface: 'cli' }, requestedSurface: 'cli', actionId: 'localServices.launcher.start', actionArgs: request,
      executionOriginV1: { v: 1, authority: 'present_user', surface: 'cli', caller: { kind: 'host' }, serverId: h.serverId,
        accountId: 'artifact-account', actionId: 'localServices.launcher.start', requestId: 'cli-start', machineId: 'hz-build-1' },
      summary: 'Start server', decision: { kind: 'approve', decidedAtMs: 2 },
      preview: { serviceStartReview: { request, target: { ...workspace, machineId: 'hz-build-1', workspaceId: 'worker-checkout', rootPath: '/copy' },
        reviewedEffectDigest: 'a'.repeat(64), reviewedEffect: { command: { source: { kind: 'command', command: 'serve' } } },
        setup: { required: false, project: { serverId: h.serverId, projectId: 'project' },
          reviewedEffectDigest: 'b'.repeat(64), reviewedEffect: {} } } } };
    const publish = async (value: ApprovalRequestV2, headerOnly = false) => act(async () => {
      fixture!.boundary.replaceStoredRow({ id: 'cli-start-approval', ownerAccountId: 'artifact-account', access: 'owner', encryptionMode: 'plain',
        publicAudience: 'none', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(value)),
        body: encodePlainArtifactStoredContent({ body: JSON.stringify(value) }), headerVersion: value.updatedAtMs,
        bodyVersion: value.updatedAtMs, seq: value.updatedAtMs, createdAt: 1, updatedAt: value.updatedAtMs });
      storage.getState().updateArtifact({
        id: 'cli-start-approval', title: value.summary, header: buildApprovalRequestArtifactHeaderV1(value),
        body: headerOnly ? undefined : JSON.stringify(value),
        headerVersion: value.updatedAtMs, bodyVersion: value.updatedAtMs, seq: value.updatedAtMs, createdAt: 1, updatedAt: value.updatedAtMs,
        isDecrypted: true,
      });
    });
    try {
      await vi.waitFor(() => expect(h.screen.findByTestId('service-row-status-unavailable')).toBeTruthy());
      await publish({ ...approval, executionOriginV1: { ...approval.executionOriginV1, accountId: 'other-account' } });
      expect(h.screen.findByTestId('service-row-status-unavailable')).toBeTruthy();
      await publish({ ...approval, updatedAtMs: 3 }, true);
      await vi.waitFor(() => expect(h.screen.getTextContent()).toContain('localServices.row.startingOn:{"machine":"Worker workstation"}'));
      expect(h.screen.findByTestId('service-row-status-unavailable')).toBeNull();
      expect(h.screen.findByTestId('service-row-start-row')).toBeNull();
      expect(h.screen.findByTestId('placement.move.operation')).toBeNull();
      const failed = ActionOperationSnapshotV1Schema.parse({ version: 1, operationId: 'cli-native-start', revision: 2,
        actionId: 'localServices.launcher.start', requestId: 'cli-start', state: 'failed',
        scope: { accountId: 'artifact-account', machineId: 'hz-build-1' }, title: 'Start server',
        createdAt: 3, startedAt: 3, settledAt: 4, cancellation: 'unsupported',
        domainRef: { kind: 'projectService', purpose: 'start', sourceWorkspace: { serverId: h.serverId, refId: 'checkout' },
          workspace, declaration: request.declaration }, error: { errorCode: 'native_refused', error: 'native_refused' } });
      await act(async () => publishActionOperationObservation({ serverId: h.serverId, machineId: 'hz-build-1',
        observation: 'available', snapshots: [failed] }));
      expect(h.screen.findByTestId('service-row-status-unavailable')).toBeTruthy();
      await publish({ ...approval, status: 'failed', updatedAtMs: 4,
        execution: { ok: false, executedAtMs: 4, errorCode: 'native_refused', error: 'native_refused' } });
      await vi.waitFor(() => expect(h.screen.findByTestId('service-row-status-unavailable')).toBeTruthy());
    } finally { await h.screen.unmount(); }
  });

  it.each(['devbox', 'hz-build-1'])('keeps canonical Start progress while active, then exposes failed binding observation on %s', async machineId => {
    const h = await setup({ running: false, actualFails: true, liveFeeds: true, sharedObservation: true, waitEnabled: false });
    const workspace = { serverId: h.serverId, machineId: 'devbox', workspaceId: 'checkout', rootPath: '/src/happier' };
    let operation = ActionOperationSnapshotV1Schema.parse({ version: 1, operationId: 'external-start', revision: 1,
      actionId: 'localServices.launcher.start', state: 'running', scope: { accountId: 'artifact-account', machineId },
      title: 'Start server', createdAt: 10, startedAt: 11, cancellation: 'unsupported',
      domainRef: { kind: 'projectService', purpose: 'start', sourceWorkspace: { serverId: h.serverId, refId: 'checkout' },
        workspace, declaration: { workspaceRefId: 'checkout', selection: { kind: 'manifest', name: 'server' } } },
      progress: { kind: 'phase', phase: 'copying', label: 'Copying current files' } });
    try {
      await vi.waitFor(() => expect(h.screen.findByTestId('service-row-status-unavailable'), h.screen.getTextContent()).toBeTruthy());
      await act(async () => publishActionOperationObservation({ serverId: h.serverId, machineId, observation: 'available', snapshots: [operation] }));
      await vi.waitFor(() => expect(h.screen.getTextContent()).toContain('projectWorkers.copying'));
      expect(h.screen.findByTestId('service-row-start-row')).toBeNull();
      expect(h.screen.findByTestId('service-row-status-unavailable')).toBeNull();
      expect(h.screen.findByTestId('placement.move.operation')).toBeNull();
      for (const phase of ['preparing', 'starting'] as const) {
        operation = ActionOperationSnapshotV1Schema.parse({ ...operation, revision: operation.revision + 1,
          progress: { kind: 'phase', phase, label: phase } });
        await act(async () => publishActionOperationObservation({ serverId: h.serverId, machineId, observation: 'available', snapshots: [operation] }));
        await vi.waitFor(() => expect(h.screen.getTextContent()).toContain(phase === 'preparing' ? 'projectWorkers.preparing' : 'localServices.row.startingOn'));
      }
      expect(h.screen.getTextContent()).toContain(`localServices.row.startingOn:{"machine":"${machineId === 'devbox' ? 'Source workstation' : 'Worker workstation'}"}`);
      if (machineId !== 'devbox') expect(h.screen.getTextContent()).not.toContain('localServices.row.startingOn:{"machine":"Source workstation"}');
      const workspaceId = machineId === 'devbox' ? 'checkout' : 'worker-checkout';
      const rootPath = machineId === 'devbox' ? '/src/happier' : '/copy';
      const declaration = { workspaceRefId: workspaceId, selection: { kind: 'manifest', name: 'server' } };
      const currentTarget = { kind: 'managed_service', managedServiceId: 'instance', machineId, workspaceId, cwd: rootPath, declaration };
      operation = ActionOperationSnapshotV1Schema.parse({ ...operation, revision: operation.revision + 1, state: 'succeeded', settledAt: 20,
        domainRef: { ...operation.domainRef, workspace: { serverId: h.serverId, machineId, workspaceId, rootPath }, declaration, currentTarget },
        result: { status: 'succeeded', currentTarget } });
      await act(async () => publishActionOperationObservation({ serverId: h.serverId, machineId, observation: 'available', snapshots: [operation] }));
      await flushHookEffects();
      await vi.waitFor(() => expect(h.screen.findByTestId('service-row-status-unavailable'), h.screen.getTextContent()).toBeTruthy());
      expect(h.screen.findByTestId('service-row-start-row')).toBeNull();
      expect(h.screen.getTextContent()).not.toContain('localServices.row.startingOn');
      expect(h.screen.getTextContent()).not.toContain('common.loading');
      h.setActualFails(false);
      await act(async () => { h.setRowMachine(machineId); h.setRunning(true);
        publishLocalServiceInventorySnapshot({ ...await h.catalogBinding(), machineId }, {
          v: 1, machineId, generatedAt: 2, refreshState: 'idle', entries: [], diagnostics: [] }); });
      await vi.waitFor(() => expect(h.screen.findByTestId('service-row-status-running'), JSON.stringify({ text: h.screen.getTextContent(),
        calls: remote.mock.calls.slice(-10).map(([call]) => ({ machineId: call.machineId, method: call.method, payload: call.payload })) })).toBeTruthy());
    } finally { await h.screen.unmount(); }
  });

  it.each(['devbox', 'hz-build-1'])('keeps received Move feedback through attachment and settlement on %s', async machineId => {
    const frames: string[] = [];
    let read = () => '';
    const h = await setup({ running: false, actualFails: true, liveFeeds: true, sharedObservation: true, waitEnabled: false,
      onCommit: () => frames.push(read()) });
    read = () => h.screen.getTextContent();
    let operation = ActionOperationSnapshotV1Schema.parse({ version: 1, operationId: 'received-move', revision: 1,
      actionId: 'projects.service.relocate', state: 'running', scope: { accountId: 'artifact-account', machineId: 'devbox' },
      title: 'Move server', createdAt: 10, startedAt: 11, cancellation: 'supported',
      domainRef: { kind: 'projectService', purpose: 'relocation', sourceWorkspace: { serverId: h.serverId, refId: 'checkout' },
        workspace: { serverId: h.serverId, machineId: 'devbox', workspaceId: 'checkout', rootPath: '/src/happier' },
        destinationWorkspace: { serverId: h.serverId, machineId, workspaceId: machineId === 'devbox' ? 'checkout' : 'worker-checkout', rootPath: machineId === 'devbox' ? '/src/happier' : '/copy' },
        declaration: { workspaceRefId: 'checkout', selection: { kind: 'manifest', name: 'server' } } },
      progress: { kind: 'phase', phase: 'stopping', label: 'Stopping service' } });
    try {
      await vi.waitFor(() => expect(h.screen.findByTestId('service-row-status-unavailable'), h.screen.getTextContent()).toBeTruthy());
      frames.length = 0;
      await act(async () => publishActionOperationObservation({ serverId: h.serverId, machineId: 'devbox', observation: 'available', snapshots: [operation] }));
      expect(frames.length).toBeGreaterThan(0);
      expect(frames.every(frame => !frame.includes('localServices.rowStatus.unavailable'))).toBe(true);
      expect(h.screen.findByTestId('service-row-status-unavailable')).toBeNull();
      expect(h.screen.getTextContent()).toContain('localServices.rowStatus.stopping');
      const workspaceId = machineId === 'devbox' ? 'checkout' : 'worker-checkout';
      const rootPath = machineId === 'devbox' ? '/src/happier' : '/copy';
      const declaration = { workspaceRefId: workspaceId, selection: { kind: 'manifest', name: 'server' } };
      const currentTarget = { kind: 'managed_service', managedServiceId: 'instance', machineId, workspaceId, cwd: rootPath, declaration };
      operation = ActionOperationSnapshotV1Schema.parse({ ...operation, revision: 2, state: 'succeeded', settledAt: 20,
        domainRef: { ...operation.domainRef, workspace: { serverId: h.serverId, machineId, workspaceId, rootPath }, declaration, currentTarget },
        result: { status: 'moved', currentTarget } });
      await act(async () => publishActionOperationObservation({ serverId: h.serverId, machineId: 'devbox', observation: 'available', snapshots: [operation] }));
      await flushHookEffects();
      await vi.waitFor(() => expect(h.screen.findByTestId('service-row-status-unavailable'), h.screen.getTextContent()).toBeTruthy());
      expect(h.screen.findByTestId('service-row-start-row')).toBeNull();
      expect(h.screen.getTextContent()).not.toContain('common.loading');
      h.setActualFails(false);
      await act(async () => { h.setRowMachine(machineId); h.setRunning(true);
        publishLocalServiceInventorySnapshot({ ...await h.catalogBinding(), machineId }, {
          v: 1, machineId, generatedAt: 2, refreshState: 'idle', entries: [], diagnostics: [] }); });
      await vi.waitFor(() => expect(h.screen.findByTestId('service-row-status-running'), h.screen.getTextContent()).toBeTruthy());
      // The receipt has handed off. A later failed refresh carries no new native
      // fact: retain the admitted Running binding without reviving receipt Loading.
      h.setActualFails(true);
      await act(async () => publishLocalServiceInventorySnapshot({ ...await h.catalogBinding(), machineId }, {
        v: 1, machineId, generatedAt: 3, refreshState: 'idle', entries: [], diagnostics: [] }));
      await vi.waitFor(async () => expect((await h.bindingState(machineId)).refreshStatus).toBe('error'));
      expect(h.screen.findByTestId('service-row-status-running')).toBeTruthy();
      expect(h.screen.findByTestId('service-row-start-row')).toBeNull();
      expect(h.screen.getTextContent()).not.toContain('common.loading');
    } finally { await h.screen.unmount(); }
  });

  it.each(['worker', 'pool', 'primary', 'override', 'unavailable'] as const)('addresses normal Start from current saved placement (%s)', async destination => {
    const starts: Readonly<{ machineId: string; params: unknown }>[] = [];
    const { createDefaultRuntimeActionExecutor } = await import('@/sync/ops/actions/defaultRuntimeActionExecutor');
    const execute = createFrontDoorRuntimeActionExecutor(createActionExecutor(createActionExecutorBoundaryFixture({
      isActionApprovalRequired: () => false,
      runtimeActionExecute: createDefaultRuntimeActionExecutor(),
    })));
    const choice = destination === 'primary' ? { kind: 'primary' as const }
      : destination === 'pool' ? { kind: 'workers' as const, destination: { kind: 'pool' as const,
        poolId: '00000000-0000-4000-8000-000000000032', selection: 'automatic' as const } }
      : { kind: 'workers' as const, destination: { kind: 'machine' as const, machineId: 'hz-build-1' } };
    const { screen, start, failPlacementReads, writes } = await setup({ running: false,
      sharedObservation: true, serviceRuntime: execute, saved: { runsOn: choice, unavailable: 'fail' },
      onStart: request => starts.push(request) });
    if (destination === 'unavailable') failPlacementReads();
    await act(async () => {
      if (destination === 'unavailable') await expect(start()).rejects.toThrow();
      else await start(destination === 'override' ? { kind: 'primary' } : undefined);
    });
    if (destination === 'unavailable') expect(starts).toEqual([]);
    else expect(starts).toEqual([expect.objectContaining({
      machineId: destination === 'primary' || destination === 'override' ? 'devbox'
        : destination === 'pool' ? 'pool-worker' : 'hz-build-1',
      params: expect.objectContaining({ choice: destination === 'pool'
        ? { kind: 'workers', destination: { kind: 'machine', machineId: 'pool-worker' } }
        : destination === 'override' ? { kind: 'primary' } : choice,
        workspace: expect.objectContaining({ machineId: 'devbox', workspaceId: 'checkout' }) }),
    })]);
    expect(writes).toEqual([]);
    await screen.unmount();
  });
  it.each(['outbound', 'return'] as const)('settles a collapsed %s Move row from native facts and stays stopped after Stop', async direction => {
    const h = await setup({ running: true, sharedObservation: true, withRow: true, collapsedRow: true, waitEnabled: false });
    const machineId = direction === 'outbound' ? 'hz-build-1' : 'devbox';
    const workspaceId = direction === 'outbound' ? 'worker-checkout' : 'checkout';
    const destinationWorkspace = { serverId: h.serverId, machineId, workspaceId, rootPath: direction === 'outbound' ? '/copy' : '/src/happier' };
    let operation = ActionOperationSnapshotV1Schema.parse({ version: 1, operationId: `${direction}-move`, revision: 1,
      actionId: 'projects.service.relocate', state: 'running', scope: { accountId: 'artifact-account', machineId: 'devbox' },
      title: 'Move server', createdAt: 1, startedAt: 2, cancellation: 'supported',
      domainRef: { kind: 'projectService', purpose: 'relocation', sourceWorkspace: { serverId: h.serverId, refId: 'checkout' },
        destinationWorkspace, workspace: direction === 'return'
          ? { serverId: h.serverId, machineId: 'hz-build-1', workspaceId: 'worker-checkout', rootPath: '/copy' } : destinationWorkspace,
        declaration: { workspaceRefId: direction === 'return' ? 'worker-checkout' : workspaceId, selection: { kind: 'manifest', name: 'server' } } },
      progress: { kind: 'phase', phase: 'starting', label: 'Starting service' } });
    await act(async () => {
      if (direction === 'return') h.setRowMachine('hz-build-1');
      publishActionOperationObservation({ serverId: h.serverId, machineId: 'devbox', observation: 'available', snapshots: [operation] });
      h.attach(operation);
    });
    await vi.waitFor(() => expect(h.screen.getTextContent()).toContain('localServices.row.startingOn'));
    expect(h.screen.findByTestId('service-row-status-running')).toBeNull();
    // The collapsed row never mounts placement controls: settlement must not depend on their effects.
    expect(h.screen.findByTestId('placement')).toBeNull();
    await act(async () => {
      h.setRowMachine(machineId);
      operation = ActionOperationSnapshotV1Schema.parse({ ...operation, revision: 2, state: 'succeeded', settledAt: 3,
        domainRef: { ...operation.domainRef, workspace: destinationWorkspace,
          declaration: { workspaceRefId: workspaceId, selection: { kind: 'manifest', name: 'server' } } },
        result: { status: 'moved', currentTarget: { kind: 'managed_service', managedServiceId: 'moved-instance', machineId, workspaceId } } });
      publishActionOperationObservation({ serverId: h.serverId, machineId: 'devbox', observation: 'available', snapshots: [operation] });
    });
    await vi.waitFor(() => expect(h.screen.findByTestId('service-row-status-running'), h.screen.getTextContent()).toBeTruthy());
    expect(h.screen.getTextContent()).not.toContain('localServices.row.startingOn');
    await act(async () => h.setRunning(false));
    expect(h.screen.findByTestId('service-row-status-running')).toBeNull();
    expect(h.screen.findByTestId('service-row-start')).toBeTruthy();
    expect(h.screen.getTextContent()).not.toContain('localServices.row.startingOn');
    await h.screen.unmount();
  });
  it.each(['before-stop', 'new-native-lifetime'] as const)('preserves the running row after a received Move failure (%s)', async state => {
    const h = await setup({ running: true, sharedObservation: true, withRow: true,
      ...(state === 'new-native-lifetime' ? { startedAtMs: 100 } : {}) });
    const operation = ActionOperationSnapshotV1Schema.parse({ version: 1, operationId: 'failed-move', revision: 1,
      actionId: 'projects.service.relocate', state: 'failed', scope: { accountId: 'artifact-account', machineId: 'devbox' },
      title: 'Move server', createdAt: 1, startedAt: 1, settledAt: 3, cancellation: 'unsupported',
      domainRef: { kind: 'projectService', purpose: 'relocation', sourceWorkspace: { serverId: h.serverId, refId: 'checkout' },
        workspace: { serverId: h.serverId, machineId: 'devbox', workspaceId: 'checkout', rootPath: '/src/happier' },
        declaration: { workspaceRefId: 'checkout', selection: { kind: 'manifest', name: 'server' } } },
      ...(state === 'new-native-lifetime' ? { progress: { kind: 'phase', phase: 'stopped', label: 'Service stopped' } } : {}),
      error: { errorCode: 'project_setup_consent_required', error: 'Review destination setup with projects.prepare' } });
    await act(async () => publishActionOperationObservation({ serverId: h.serverId, machineId: 'devbox', observation: 'available', snapshots: [operation] }));
    if (state === 'before-stop') await vi.waitFor(() => expect(h.screen.getTextContent()).toContain('projectServices.moveRefused'));
    else await vi.waitFor(() => expect(h.screen.findByTestId('placement.move.inspect')).toBeNull());
    expect(h.screen.findByTestId('service-row-status-running')).toBeTruthy();
    expect(h.runsOn().props.disabled).toBe(false);
    expect(h.writes).toEqual([]);
    await h.screen.unmount();
  });
  it('discovers a received CLI Move without an origin attachment and retains failed-stopped recovery across provider remount', async () => {
    const h = await setup({ running: true, sharedObservation: true, withRow: true, serviceRuntime: createFrontDoorRuntimeActionExecutor() });
    let operation: ActionOperationSnapshotV1 = { version: 1, operationId: 'cli-move', revision: 1,
      actionId: 'projects.service.relocate', state: 'running', scope: { accountId: 'artifact-account', machineId: 'devbox' },
      title: 'Move server', createdAt: 1, startedAt: 1, cancellation: 'supported',
      domainRef: { kind: 'projectService', purpose: 'relocation',
        sourceWorkspace: { serverId: 'srv_service_creation', refId: 'checkout' },
        destinationWorkspace: { serverId: 'srv_service_creation', machineId: 'hz-build-1', workspaceId: 'worker-checkout', rootPath: '/copy' },
        workspace: { serverId: 'srv_service_creation', machineId: 'devbox', workspaceId: 'checkout', rootPath: '/src/happier' },
        declaration: { workspaceRefId: 'checkout', selection: { kind: 'manifest', name: 'server' } } },
      progress: { kind: 'phase', phase: 'copying', label: 'Copying current files' } };
    await act(async () => publishActionOperationObservation({ serverId: h.serverId, machineId: 'devbox', observation: 'available', snapshots: [ActionOperationSnapshotV1Schema.parse(operation)] }));
    await vi.waitFor(() => expect(h.screen.getTextContent()).toContain('projectWorkers.copying'));
    expect(h.screen.findByTestId('service-row-status-running')).toBeNull();
    await act(async () => {
      h.setRunning(false);
      operation = { ...operation, revision: 2, state: 'failed', settledAt: 3,
        domainRef: { ...operation.domainRef!, kind: 'projectService', purpose: 'relocation',
          sourceWorkspace: { serverId: 'srv_service_creation', refId: 'checkout' },
          workspace: { serverId: 'srv_service_creation', machineId: 'hz-build-1', workspaceId: 'worker-checkout', rootPath: '/copy' },
          declaration: { workspaceRefId: 'worker-checkout', selection: { kind: 'manifest', name: 'server' } } },
        progress: { kind: 'phase', phase: 'starting', label: 'Starting service' },
        error: { errorCode: 'project_setup_consent_required', error: 'project_setup_consent_required' } };
      publishActionOperationObservation({ serverId: h.serverId, machineId: 'devbox', observation: 'available', snapshots: [ActionOperationSnapshotV1Schema.parse(operation)] });
    });
    await vi.waitFor(() => expect(h.screen.findByTestId('placement.move.retry'), h.screen.getTextContent()).toBeTruthy());
    expect(h.screen.getTextContent()).toContain('projectServices.moveFailedStopped');
    expect(h.screen.findByTestId('service-row-start-row')).toBeTruthy();
    await act(async () => h.setSourceRef('other-checkout'));
    expect(h.screen.findByTestId('placement.move.inspect')).toBeNull();
    await act(async () => h.setSourceRef('checkout'));
    await vi.waitFor(() => expect(h.screen.findByTestId('placement.move.retry')).toBeTruthy());
    await h.screen.unmount();
  });
  it('opens Move confirmation after choosing an eligible worker through the open Runs on picker', async () => {
    const { screen, writes } = await setup({ running: true, serviceState: 'healthy', sharedObservation: true,
      offerWorker: true, waiveMoveApproval: false });
    await screen.pressByTestIdAsync('placement.runsOn');
    await vi.waitFor(() => expect(screen.tree.findAll(node => typeof node.props.testID === 'string'
      && node.props.testID.includes('pool-worker')).map(node => node.props.testID)).toContain('placement.picker-option:pool-worker'));
    await screen.pressByTestIdAsync('placement.picker-option:pool-worker');
    await vi.waitFor(() => expect(screen.findByTestId('placement.move.confirm')).toBeTruthy());
    expect(writes).toEqual([]);
    await screen.unmount();
  });
  it('observes another Service approval independently while the first is pending, and retires pending custody on Source change', async () => {
    const { screen, serverId, runMove, setSourceRef } = await setup({ running: true, sharedObservation: true,
      serviceRuntime: createFrontDoorRuntimeActionExecutor() });
    const homeId = resolveServerProfileScopeIdForIdentifier(serverId);
    const requests = (['server', 'other'] as const).map(serviceName => ProjectServiceRelocateInputV1Schema.parse({
      workspace: { serverId, refId: 'checkout' }, serviceName, requestId: `move-${serviceName}`,
      currentTarget: { kind: 'managed_service', machineId: 'devbox', managedServiceId: `instance-${serviceName}` },
      destination: { kind: 'workers', destination: { kind: 'machine', machineId: 'hz-build-1' } }, selectedTarget: { machineId: 'hz-build-1' },
      desiredPlacement: { workspace: { serverId, refId: 'checkout' }, serviceName, expectedRevision: 'absent', expected: { kind: 'absent' },
        value: { runsOn: { kind: 'workers', destination: { kind: 'machine', machineId: 'hz-build-1' } }, unavailable: 'fail' } },
    }));
    const pending: Promise<unknown>[] = [];
    await act(async () => {
      for (const request of requests) pending.push(runMove(request.serviceName === 'server' ? 'server' : 'other',
        (signal, onApprovalPending) => executeServiceRelocationAction({ request,
          context: { serverId: homeId, surface: 'ui', actionRequestId: request.requestId },
          admission: { expectedAccountId: 'artifact-account', signal, onApprovalPending },
          // Only the admitted Action transport is replaced; result custody and both readers are real.
          execute: async () => ({ kind: 'approval_request_created', actionId: 'projects.service.relocate', artifactId: request.requestId }),
        })));
    });
    await vi.waitFor(() => expect(new Set(fixture!.requests.filter(request => request.path.startsWith('/v1/artifacts/move-'))
      .map(request => request.path))).toEqual(new Set(['/v1/artifacts/move-server', '/v1/artifacts/move-other'])));
    let firstSettled = false;
    void pending[0]!.then(() => { firstSettled = true; });
    const operation: ActionOperationSnapshotV1 = { version: 1, operationId: 'other-operation', revision: 1,
      actionId: 'projects.service.relocate', requestId: 'move-other', state: 'running', scope: { accountId: 'artifact-account', machineId: 'devbox' },
      title: 'Move other', createdAt: 1, startedAt: 1, cancellation: 'supported' };
    const approval: ApprovalRequestV2 = { v: 2, status: 'executed', createdAtMs: 1, updatedAtMs: 2,
      createdBy: { surface: 'system' }, requestedSurface: 'ui', actionId: 'projects.service.relocate', actionArgs: requests[1],
      executionOriginV1: { v: 1, authority: 'present_user', surface: 'ui', caller: { kind: 'host' }, serverId,
        serverIdentityId: 'srv_service_creation', accountId: 'artifact-account', actionId: 'projects.service.relocate', requestId: 'move-other' },
      summary: 'Move other', decision: { kind: 'approve', decidedAtMs: 2 },
      execution: { ok: true, executedAtMs: 2, result: { status: 'accepted', operation } } };
    await act(async () => {
      fixture!.boundary.replaceStoredRow({ id: 'move-other', ownerAccountId: 'artifact-account', access: 'owner', encryptionMode: 'plain',
        publicAudience: 'none', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(approval)),
        body: encodePlainArtifactStoredContent({ body: JSON.stringify(approval) }), headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 2 });
      publishHomeAccountChange(serverId, ['move-other'], { changeKinds: ['artifact'] });
    });
    const accepted = await pending[1];
    expect(accepted).toEqual({ status: 'accepted', operation });
    expect(firstSettled).toBe(false);
    await act(async () => { setSourceRef('another-checkout'); });
    await expect(pending[0]).resolves.toBeNull();
    await screen.unmount();
  });
  it.each(['lifecycle', 'remount'] as const)('retains an approved Move across %s before acceptance and refreshes native absence on failed settlement', async change => {
    let request: Parameters<ReturnType<typeof createFrontDoorRuntimeActionExecutor>>[0] | undefined;
    let admitted: typeof request;
    const { createDefaultRuntimeActionExecutor } = await import('@/sync/ops/actions/defaultRuntimeActionExecutor');
    const execute = createFrontDoorRuntimeActionExecutor(createActionExecutor(createActionExecutorBoundaryFixture({
      isActionApprovalRequired: () => false,
      runtimeActionExecute: createDefaultRuntimeActionExecutor({}, undefined, async value => {
        request = value;
        return { kind: 'approval_request_created', actionId: value.actionId, artifactId: 'move-approval' };
      }),
    })));
    const { screen, choose, serverId, setLifecycle, setControlVisible, setRunning } = await setup({ running: true,
      sharedObservation: true, serviceRuntime: async (...args) => { admitted = args[0]; return execute(...args); }, liveFeeds: true });
    await choose('hz-build-1');
    await vi.waitFor(() => expect(screen.findByTestId('placement.move.approval')).toBeTruthy());
    expect(request!.input).toMatchObject({ requestId: request!.context?.actionRequestId });
    // Native Stop can replace the row before the executed Artifact reaches the origin.
    await act(async () => { setLifecycle('native-stopped'); if (change === 'remount') setControlVisible(false); });
    let operation: ActionOperationSnapshotV1 = { version: 1, operationId: 'approved-move', revision: 1,
      actionId: 'projects.service.relocate', requestId: request!.context!.actionRequestId!, state: 'running',
      scope: { accountId: 'artifact-account', machineId: 'devbox' }, title: 'Move server', createdAt: 1, startedAt: 1,
      cancellation: 'supported', progress: { kind: 'phase', phase: 'stopping', label: 'Stopping service' } };
    expect(admitted!.input).toMatchObject({ requestId: operation.requestId });
    const approval: ApprovalRequestV2 = { v: 2, status: 'executed', createdAtMs: 1, updatedAtMs: 2,
      createdBy: { surface: 'system' }, requestedSurface: 'ui', actionId: 'projects.service.relocate', actionArgs: admitted!.input,
      executionOriginV1: { v: 1, authority: 'present_user', surface: 'ui', caller: { kind: 'host' }, serverId,
        serverIdentityId: 'srv_service_creation', accountId: 'artifact-account', actionId: 'projects.service.relocate', requestId: operation.requestId! },
      summary: 'Move server', decision: { kind: 'approve', decidedAtMs: 2 },
      execution: { ok: true, executedAtMs: 2, result: { status: 'accepted', operation } } };
    await act(async () => {
      fixture!.boundary.replaceStoredRow({ id: 'move-approval', ownerAccountId: 'artifact-account', access: 'owner',
        encryptionMode: 'plain', publicAudience: 'none', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(approval)),
        body: encodePlainArtifactStoredContent({ body: JSON.stringify(approval) }),
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 2 });
      publishHomeAccountChange(serverId, ['move-approval'], { changeKinds: ['artifact'] });
    });
    if (change === 'remount') await act(async () => { setControlVisible(true); });
    await vi.waitFor(() => expect(screen.findByTestId('placement.move.inspect')).toBeTruthy());
    expect(screen.getTextContent()).toContain('localServices.rowStatus.stopping');
    expect(screen.findByTestId('service-row-status-running')).toBeNull();
    for (const phase of ['stopped', 'copying'] as const) {
      await act(async () => {
        operation = { ...operation, revision: operation.revision + 1, progress: { kind: 'phase', phase, label: phase } };
        publishActionOperationObservation({ serverId, machineId: 'devbox', observation: 'available', snapshots: [operation] });
      });
      expect(screen.getTextContent()).toContain(phase === 'copying' ? 'projectWorkers.copying' : 'localServices.rowStatus.stopped');
    }
    // No inventory generation/watch update: settlement itself must invalidate the subscribed native reads.
    await act(async () => {
      setRunning(false);
      operation = { ...operation, revision: operation.revision + 1, state: 'failed', settledAt: 3,
        error: { errorCode: 'indeterminate', error: 'indeterminate' } };
      publishActionOperationObservation({ serverId, machineId: 'devbox', observation: 'available', snapshots: [operation] });
    });
    await vi.waitFor(() => expect(screen.findByTestId('service-row-start-row'), screen.getTextContent()).toBeTruthy());
    expect(screen.findByTestId('service-row-status-running')).toBeNull();
    await vi.waitFor(() => expect(screen.findByTestId('placement.move.retry')).toBeTruthy());
    expect(screen.getTextContent()).toContain('projectServices.moveFailedStopped');
    await screen.unmount();
  });
  it('uses accepted operation progress in the row while the native feed still says Running', async () => {
    const { screen, serverId, attach } = await setup({ running: true, sharedObservation: true, withRow: true });
    const operation: ActionOperationSnapshotV1 = { version: 1, operationId: 'moving-stale-feed', revision: 1,
      actionId: 'projects.service.relocate', state: 'running', scope: { accountId: 'artifact-account', machineId: 'devbox' },
      title: 'Move server', createdAt: 1, startedAt: 1, cancellation: 'supported',
      domainRef: { kind: 'projectService', purpose: 'relocation', sourceWorkspace: { serverId, refId: 'checkout' },
        workspace: { serverId, machineId: 'devbox', workspaceId: 'checkout', rootPath: '/src/happier' },
        declaration: { workspaceRefId: 'checkout', selection: { kind: 'manifest', name: 'server' } } },
      progress: { kind: 'phase', phase: 'copying', label: 'Copying current files' } };
    await act(async () => {
      publishActionOperationObservation({ serverId, machineId: 'devbox', observation: 'available', snapshots: [operation] });
      attach(operation);
    });
    await vi.waitFor(() => expect(screen.findByTestId('placement.move.inspect')).toBeTruthy());
    expect(screen.getTextContent()).toContain('projectWorkers.copying');
    expect(screen.findByTestId('service-row-status-running')).toBeNull();
    expect(screen.findByTestId('service-row-copy-address')).toBeNull();
    expect(screen.findByTestId('service-row-open')).toBeNull();
    // A Move back to SOURCE executes a native Start there. Its newer child
    // operation must not replace the enclosing Move's progress/recovery owner.
    await act(async () => publishActionOperationObservation({ serverId, machineId: 'devbox', observation: 'available', snapshots: [
      ActionOperationSnapshotV1Schema.parse({ ...operation, operationId: 'move-native-start', actionId: 'localServices.launcher.start',
        createdAt: 2, startedAt: 2, cancellation: 'unsupported',
        domainRef: { ...operation.domainRef, purpose: 'start' }, progress: { kind: 'phase', phase: 'starting', label: 'Starting service' } }),
    ] }));
    expect(screen.getTextContent()).toContain('projectWorkers.copying');
    expect(screen.findByTestId('placement.move.inspect')).toBeTruthy();
    await act(async () => publishActionOperationObservation({ serverId, machineId: 'devbox', observation: 'available', snapshots: [
      { ...operation, revision: 2, state: 'succeeded', settledAt: 3 },
    ] }));
    await vi.waitFor(() => expect(screen.getTextContent()).toContain('localServices.row.startingOn'));
    expect(screen.findByTestId('placement.move.inspect')).toBeNull();
    await screen.unmount();
  });
  it('renders the owning reason when the front door refuses the settings read', async () => {
    const { Dimensions } = await import('react-native');
    vi.spyOn(Dimensions, 'get').mockReturnValue({ width: 390, height: 844, scale: 1, fontScale: 1 });
    const { screen } = await setup({ running: true, disablePlacementRead: true, waitEnabled: false, showDivider: true });
    await vi.waitFor(() => expect(screen.getTextContent()).toContain('localServices.actions.failure.refused'));
    await screen.unmount();
  });
  it('attaches a front-door accepted Move with its single request identity and consumes native progress and stopped failure', async () => {
    let operation: ActionOperationSnapshotV1 | undefined;
    let identities: Readonly<{ input: unknown; context: unknown }> | undefined;
    const { createDefaultRuntimeActionExecutor } = await import('@/sync/ops/actions/defaultRuntimeActionExecutor');
    const execute = createFrontDoorRuntimeActionExecutor(createActionExecutor(createActionExecutorBoundaryFixture({
      isActionApprovalRequired: () => false,
      // The daemon transport echoes the request identity selected by the host operation owner.
      runtimeActionExecute: createDefaultRuntimeActionExecutor({}, undefined, async request => {
        identities = { input: request.input, context: request.context?.actionRequestId };
        operation = { version: 1, operationId: 'accepted-move', revision: 1, actionId: request.actionId,
          requestId: request.context?.actionRequestId ?? undefined, state: 'running',
          scope: { accountId: 'artifact-account', machineId: 'devbox' }, title: 'Move server',
          createdAt: 1, startedAt: 1, cancellation: 'supported', progress: { kind: 'phase', phase: 'stopping', label: 'Stopping service' } };
        return { status: 'accepted', operation };
      }),
    })));
    const { screen, choose, serverId, setRunning, runsOn } = await setup({ running: true,
      sharedObservation: true, serviceRuntime: execute, withRow: true });
    await choose('hz-build-1');
    await vi.waitFor(() => expect(identities).toBeDefined());
    expect(identities!.input).toMatchObject({ requestId: identities!.context });
    await vi.waitFor(() => expect(screen.findByTestId('placement.move.inspect')).toBeTruthy());
    expect(screen.findByTestId('placement.move.refused')).toBeNull();
    expect(screen.getTextContent()).toContain('localServices.rowStatus.stopping');
    expect(screen.findAllByTestId('service-row-status-running')).toHaveLength(0);
    expect(screen.findByTestId('service-row-copy-address')).toBeNull();
    for (const phase of ['copying', 'starting'] as const) {
      await act(async () => {
        operation = { ...operation!, revision: operation!.revision + 1, progress: { kind: 'phase', phase, label: phase } };
        publishActionOperationObservation({ serverId, machineId: 'devbox', observation: 'available', snapshots: [operation] });
      });
      expect(screen.getTextContent()).toContain(phase === 'copying' ? 'projectWorkers.copying' : 'localServices.row.startingOn');
    }
    await act(async () => {
      setRunning(false);
      operation = { ...operation!, revision: operation!.revision + 1, state: 'failed', settledAt: 2,
        progress: { kind: 'phase', phase: 'copying', label: 'Copying current files' }, error: { errorCode: 'RPC_FORBIDDEN', error: 'Refused' } };
      publishActionOperationObservation({ serverId, machineId: 'devbox', observation: 'available', snapshots: [operation] });
    });
    await vi.waitFor(() => expect(screen.getTextContent()).toContain('projectServices.moveFailedStopped'));
    expect(runsOn().props.disabled).toBe(false);
    expect(screen.findByTestId('placement.move.retry')).toBeTruthy();
    expect(screen.findByTestId('service-row-start-row')).toBeTruthy();
    await screen.pressByTestIdAsync('placement.move.operation.details');
    expect(screen.getTextContent()).toContain('RPC_FORBIDDEN');
    await screen.pressByTestIdAsync('placement.move.retry');
    expect(screen.findByTestId('placement.move.inspect')).toBeTruthy();
    expect(screen.getTextContent()).toContain('projectServices.moveFailedStopped');
    await screen.unmount();
  });
  it.each(['running', 'detecting', 'healthy', 'unhealthy'] as const)('submits Move for a %s binding through the real placement observation and Action front door', async serviceState => {
    const requests: unknown[] = [];
    const { createDefaultRuntimeActionExecutor } = await import('@/sync/ops/actions/defaultRuntimeActionExecutor');
    const execute = createFrontDoorRuntimeActionExecutor(createActionExecutor(createActionExecutorBoundaryFixture({
      isActionApprovalRequired: () => false,
      runtimeActionExecute: createDefaultRuntimeActionExecutor({}, undefined, async request => {
        requests.push(request);
        return { status: 'refused', reasonCode: 'native_boundary_observed' };
      }),
    })));
    const { screen, choose, writes } = await setup({ running: true, serviceState, candidateFails: serviceState === 'healthy', sharedObservation: true,
      waiveMoveApproval: false, serviceRuntime: execute });
    await choose('hz-build-1');
    await vi.waitFor(() => expect(screen.findByTestId('placement.move.confirm')).toBeTruthy());
    expect(requests).toEqual([]);
    await screen.pressByTestIdAsync('placement.move.confirm');
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({ actionId: 'projects.service.relocate',
      input: { currentTarget: { managedServiceId: 'instance', machineId: 'devbox' },
        destination: { kind: 'workers', destination: { kind: 'machine', machineId: 'hz-build-1' } },
        selectedTarget: { machineId: 'hz-build-1' } } });
    expect(writes).toEqual([]);
  });

  it.each(['starting', 'stopping', 'failed'] as const)('explains why a %s binding cannot Move, including a stale picker choice', async serviceState => {
    const { screen, choose, runsOn, writes } = await setup({ running: true, serviceState, waitEnabled: false });
    await vi.waitFor(() => expect(runsOn().props.subtitle).toBe(serviceState === 'starting'
      ? 'localServices.launcher.unavailableReason.starting' : `localServices.rowStatus.${serviceState}`));
    expect(runsOn().props.disabled).toBe(true);
    await choose('hz-build-1');
    expect(screen.findByTestId('placement.move.refused')).toBeTruthy();
    expect(screen.findByTestId('placement.move.confirm')).toBeNull();
    expect(writes).toEqual([]);
  });

  it.each(['managed_service_native_state_unknown', 'managed_service_native_cleanup_unconfirmed'] as const)('keeps %s out of Move despite an unhealthy lifetime', async unavailableReason => {
    const { screen, choose, runsOn } = await setup({ running: true, serviceState: 'unhealthy', unavailableReason, waitEnabled: false });
    await vi.waitFor(() => expect(runsOn().props.subtitle).toBe(unavailableReason === 'managed_service_native_state_unknown'
      ? 'localServices.launcher.unavailableReason.nativeStateUnknown' : 'localServices.launcher.unavailableReason.nativeCleanupUnconfirmed'));
    expect(runsOn().props.disabled).toBe(true);
    await choose('hz-build-1');
    expect(screen.findByTestId('placement.move.refused')).toBeTruthy();
    expect(screen.findByTestId('placement.move.confirm')).toBeNull();
  });

  it.each(['ready', 'preset', 'dual', 'cancel', 'back', 'source-changed', 'declaration-changed', 'unknown', 'inventory', 'move', 'move-cancel'] as const)('keeps New Machine selection effect-free and continues the exact Service once (%s)', async mode => {
    const acquisitions: unknown[] = [];
    const acquisitionRequests: (string | undefined)[] = [];
    const starts: unknown[] = [];
    const moves: unknown[] = [];
    const enrollment = createDeferred<void>();
    const controller = { machineId: 'controller', installationId: 'installation' };
    const launch = { provider: { pluginId: 'custom.compute', localId: 'native' }, schemaVersion: 1, name: 'Service worker', choices: {} };
    const retention = { kind: 'until-delete' } as const;
    const moving = mode === 'move' || mode === 'move-cancel';
    const heldEnrollment = ['dual', 'cancel', 'back', 'source-changed', 'declaration-changed', 'move', 'move-cancel'].includes(mode);
    let machine: ManagedMachineV1;
    let inventoryReads = 0;
    const { createDefaultRuntimeActionExecutor } = await import('@/sync/ops/actions/defaultRuntimeActionExecutor');
    const frontDoor = createFrontDoorRuntimeActionExecutor(createActionExecutor(createActionExecutorBoundaryFixture({
      isActionApprovalRequired: () => false,
      managedMachineAction: async request => {
        if (request.actionId === 'machines.managed.acquire') {
          acquisitions.push(request.input);
          if (mode === 'unknown' && acquisitions.length === 1) throw new Error('allocation_ack_lost');
          return { managedId: 'paid-service', operation: { operationId: 'install-service' } };
        }
        if (request.actionId === 'machines.managed.get') {
          if (heldEnrollment) await enrollment.promise;
          return machine;
        }
        if (request.actionId === 'machines.managed.list') { inventoryReads += 1; return { machines: [machine] }; }
        throw new Error('unexpected_managed_transport');
      },
      actionOperationAction: async () => ({ kind: 'found', operation: { version: 1, operationId: 'install-service', revision: 2,
        actionId: 'machines.managed.acquire', state: 'succeeded', scope: { accountId: 'artifact-account', machineId: 'controller' },
        title: 'Install', createdAt: 1, startedAt: 1, settledAt: 2, cancellation: 'supported' } }),
      // Native Machine execution is the transport boundary. Source lookup and relocation dispatch stay real.
      runtimeActionExecute: createDefaultRuntimeActionExecutor({}, undefined, async request => {
        moves.push(request);
        return { status: 'refused', reasonCode: 'native_boundary_observed' };
      }),
    })));
    const execute: typeof frontDoor = async request => {
      if (request.actionId === 'machines.managed.acquire') acquisitionRequests.push(request.context?.actionRequestId ?? undefined);
      return frontDoor(request);
    };
    const { screen, writes, serverId, start, setSourceRef, setDetail, setDeclarationBasis, setControlVisible } = await setup({ running: moving, sharedObservation: true, serviceRuntime: execute,
      onStart: request => starts.push(request) });
    const homeId = getServerProfileById(serverId)!.serverIdentityId!;
    machine = { id: 'paid-service', homeId, custodianAccountId: 'artifact-account', launch, controller,
      allocation: 'bound', resource: { contributionRef: launch.provider, schemaVersion: 1, value: { id: 'native' } },
      creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1, retention,
      wakeOnAcceptedMessage: false, ...(mode === 'inventory' ? {} : { enrolledMachineId: 'new-service-worker' }) };
    const draft = createManagedMachineSelectionDraft({ enrollmentIdentity: { kind: 'existingUser', role: 'personal' },
      selection: mode === 'preset' ? { kind: 'preset', homeId, id: 'service-preset', revision: 1 }
      : { kind: 'one-off', homeId, launch, controller, retention, wakeOnAcceptedMessage: false },
      receipt: { launch, controller, optionStatus: 'current', prerequisites: [], billing: { location: 'local', stoppedBilling: 'not-billed' },
        retentionCapabilities: { supportedIntents: ['start', 'stop', 'delete'] }, retention, wakeOnAcceptedMessage: false } });
    const { WorkerDestinationPicker } = await import('@/components/projects/workers/WorkerDestinationPicker');
    if (mode === 'ready') {
      await screen.pressByTestIdAsync('placement.runsOn');
      const { ManagedMachineSelectionOffers } = await import('@/components/sessions/new/components/machineSelection/ManagedMachineSelectionOffers');
      expect(screen.tree.findAllByType(ManagedMachineSelectionOffers)).toHaveLength(1);
      await vi.waitFor(() => {
        expect(screen.findAllByTestId('placement.picker:section:managed-machines').length).toBeGreaterThan(0);
        expect(screen.findAllByTestId(`placement.picker-managed-machine:${homeId}:one-off`).length).toBeGreaterThan(0);
      });
      const { Modal } = await import('@/modal');
      vi.mocked(Modal.show).mockClear();
      await screen.pressByTestIdAsync(`placement.picker-managed-machine:${homeId}:one-off`);
      expect(Modal.show).toHaveBeenCalledWith(expect.objectContaining({
        props: expect.objectContaining({ serverId, accountId: 'artifact-account', preset: null }),
      }));
      await act(async () => screen.tree.findByType(WorkerDestinationPicker).props.onRequestClose());
      expect(acquisitions).toEqual([]);
    }
    if (mode === 'dual') await act(async () => setDetail(true));
    await act(async () => { screen.tree.findAllByType(WorkerDestinationPicker).at(-1)!.props.onChooseManagedMachine(draft); });
    if (mode === 'dual') expect(screen.tree.findAllByType(WorkerDestinationPicker).map(node => node.props.selectedManagedMachine)).toEqual([draft, draft]);
    expect(acquisitions).toEqual([]);
    expect(starts).toEqual([]);
    expect(writes).toEqual([]);
    let completion: Promise<unknown> | undefined;
    if (moving) {
      await screen.pressByTestIdAsync('placement.move.confirm');
    } else act(() => { completion = start(); });
    await vi.waitFor(() => expect(acquisitions).toHaveLength(1));
    if (heldEnrollment || mode === 'inventory') {
      expect(starts).toEqual([]);
      expect(moves).toEqual([]);
      if (mode === 'cancel' || mode === 'move-cancel') {
        await vi.waitFor(() => expect(screen.findByTestId('placement.creation.cancel')).toBeTruthy());
        await screen.pressByTestIdAsync('placement.creation.cancel');
      }
      if (mode === 'source-changed') await act(async () => { setSourceRef('another-checkout'); });
      if (mode === 'declaration-changed') await act(async () => { setDeclarationBasis('manifest-v2'); });
      if (mode === 'back') await act(async () => { setControlVisible(false); });
      if (mode === 'dual') await act(async () => { await start(); });
      if (mode === 'inventory') {
        await vi.waitFor(async () => { await flushHookEffects(); expect(inventoryReads).toBeGreaterThan(0); });
        machine = { ...machine, enrolledMachineId: 'new-service-worker' };
        act(() => publishHomeAccountChange(serverId));
      }
      enrollment.resolve();
      if (mode === 'inventory') await vi.waitFor(async () => { await flushHookEffects(); expect(starts).toHaveLength(1); });
    }
    if (mode === 'unknown') {
      await act(async () => { await completion; });
      await act(async () => { completion = start(); });
      expect(acquisitionRequests).toHaveLength(2);
      expect(acquisitionRequests[1]).toBe(acquisitionRequests[0]);
    }
    await act(async () => { await completion; });
    if (['cancel', 'back', 'source-changed', 'declaration-changed', 'move-cancel'].includes(mode)) {
      expect(starts).toEqual([]);
      expect(moves).toEqual([]);
    } else if (mode === 'move') {
      await vi.waitFor(() => expect(moves).toHaveLength(1));
      expect(moves[0]).toMatchObject({ context: { externalActionTarget: { kind: 'machine', machineId: 'devbox' } },
        input: { destination: { kind: 'workers', destination: { kind: 'machine', machineId: 'new-service-worker' } } } });
      expect(starts).toEqual([]);
    } else {
      expect(starts, JSON.stringify(screen.findAllByTestId('placement.creation').flatMap(node =>
        Array.isArray(node.props.details) ? node.props.details.filter((value: unknown) => typeof value === 'string') : []))).toHaveLength(1);
      expect(starts[0]).toMatchObject({ machineId: 'new-service-worker', params: { machineId: 'new-service-worker',
        workspace: { machineId: 'devbox', workspaceId: 'checkout' },
        choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'new-service-worker' } } } });
    }
    expect(acquisitions).toHaveLength(mode === 'unknown' ? 2 : 1);
    await screen.unmount();
  });
  it.each(['exact', 'automatic'] as const)('honours a UI Move waiver for an %s destination without a second confirmation', async destination => {
    const { screen, writes, choose, choosePool } = await setup({ running: true, waiveMoveApproval: true });
    if (destination === 'exact') await choose('hz-build-1');
    else await choosePool('00000000-0000-4000-8000-000000000032');
    // The real Action path currently reports the unavailable relocation producer.
    // Reaching that result proves the waiver admitted the request, rather than
    // leaving it stranded in a consumer-owned confirmation state.
    await vi.waitFor(() => expect(screen.findByTestId('placement.move.refused')).toBeTruthy());
    expect(screen.findByTestId('placement.move.confirm')).toBeNull();
    expect(writes).toEqual([]);
  });
  // FX12: a literally confirmed Stop publishes `stopped` before cancellable revalidation; `copying` follows only when copying begins.
  it.each([['failed', 'copying'], ['cancelled', 'copying'], ['cancelled', 'stopped']] as const)('retains the accepted Move through list/detail remounts, confirmed-Stop settlement (%s after %s) and Source retirement', async (terminalState, settledPhase) => {
    // Count live subscriptions, not calls: remounting two presentation bodies must
    // retain one accepted-operation observer and one Cancel continuation owner.
    const subscribe = actionOperationStore.subscribe;
    let observers = 0;
    vi.spyOn(actionOperationStore, 'subscribe').mockImplementation(listener => {
      observers += 1;
      const unsubscribe = subscribe(listener);
      return () => { observers -= 1; unsubscribe(); };
    });
    const { screen, serverId, attach, setDetail, setSourceRef, writes } = await setup({ running: true, sharedObservation: true });
    const discoveryObservers = observers;
    const operation: ActionOperationSnapshotV1 = { version: 1, operationId: 'retained-service-move', revision: 1,
      actionId: 'projects.service.relocate', state: 'running', scope: { accountId: 'artifact-account', machineId: 'devbox' },
      title: 'Move server', createdAt: 1, startedAt: 2, cancellation: 'supported',
      domainRef: { kind: 'projectService', purpose: 'relocation', workspace: {
        serverId, machineId: 'devbox', workspaceId: 'checkout', rootPath: '/src/happier' },
      declaration: { workspaceRefId: 'checkout', selection: { kind: 'manifest', name: 'server' } } },
      progress: { kind: 'phase', phase: 'copying', label: 'Copying current files' } };
    await act(async () => {
      publishActionOperationObservation({ serverId, machineId: 'devbox', observation: 'available', snapshots: [operation] });
      attach(operation);
      setDetail(true);
    });
    await vi.waitFor(() => expect(screen.findByTestId('placement.move.inspect')).toBeTruthy());
    expect(screen.findByTestId('detail.placement.move.inspect')).toBeTruthy();
    expect(observers - discoveryObservers).toBe(1);
    // The Move names itself and its current phase in the app's words; the producer's English phase
    // label is not shown beside them.
    expect(screen.getTextContent()).toContain('projectServices.moving');
    expect(screen.getTextContent()).toContain('projectWorkers.copying');
    expect(screen.getTextContent()).not.toContain('Copying current files');
    await screen.pressByTestIdAsync('placement.move.stop');
    await vi.waitFor(() => expect(screen.getTextContent()).toContain('projectServices.cancelPending'));
    expect(actionOperationStore.getSnapshot().operationsByKey.values().next().value?.snapshot.state).toBe('running');
    await act(async () => { setDetail(false); });
    expect(screen.findByTestId('detail.placement.move.inspect')).toBeNull();
    expect(screen.findByTestId('placement.move.inspect')).toBeTruthy();
    expect(screen.getTextContent()).toContain('projectServices.cancelPending');
    expect(observers - discoveryObservers).toBe(1);
    // The native feed corroborates the operation's already-confirmed stop.
    remote.mockImplementation(async ({ machineId }) => ({ protocolVersion: 1,
      snapshot: { v: 1, machineId, updatedAt: 3, targets: [] } }));
    await act(async () => {
      publishActionOperationObservation({ serverId, machineId: 'devbox', observation: 'available', snapshots: [{
        ...operation, revision: 2, state: terminalState, settledAt: 3,
        progress: { kind: 'phase', phase: settledPhase, label: settledPhase === 'stopped' ? 'Stopped on devbox' : 'Copying current files' },
        ...(terminalState === 'failed' ? { error: { errorCode: 'service_preparation_failed', error: 'Preparation failed' } } : {}),
      }] });
      setDetail(true);
    });
    await vi.waitFor(() => expect(screen.findByTestId('placement.move.inspect')).toBeTruthy());
    expect(screen.findByTestId('detail.placement.move.inspect')).toBeTruthy();
    expect(screen.findByTestId('placement.move.refused')).toBeNull();
    expect(screen.findByTestId('placement.move.stop')).toBeNull();
    await vi.waitFor(() => expect(screen.getTextContent()).toContain(
      terminalState === 'failed' ? 'projectServices.moveFailedStopped' : 'projectServices.moveCancelledStopped'));
    expect(screen.findAllByTestId('placement.runsOn')[0]?.props.disabled).toBe(false);
    expect(screen.findAllByTestId('placement.picker')[0]?.props.selected).toEqual({ kind: 'primary' });
    expect(writes).toEqual([]);
    await act(async () => { setSourceRef('another-checkout'); });
    await vi.waitFor(() => expect(screen.findByTestId('placement.move.inspect')).toBeNull());
    expect(observers).toBe(discoveryObservers);
  });

  it.each(['projects.service.relocate', 'localServices.launcher.start'] as const)(
    'reconciles a retained %s receipt to canonical placement when worker history drops the operation', async actionId => {
      const h = await setup({ running: false, sharedObservation: true, withRow: true });
      const operation = ActionOperationSnapshotV1Schema.parse({ version: 1, operationId: 'expired-service-operation', revision: 1,
        actionId, state: 'running', scope: { accountId: 'artifact-account', machineId: 'devbox' },
        title: 'Service request', createdAt: 1, startedAt: 2, cancellation: 'supported',
        domainRef: { kind: 'projectService', purpose: actionId === 'projects.service.relocate' ? 'relocation' : 'start',
          workspace: { serverId: h.serverId, machineId: 'devbox', workspaceId: 'checkout', rootPath: '/src/happier' },
          declaration: { workspaceRefId: 'checkout', selection: { kind: 'manifest', name: 'server' } } },
        progress: { kind: 'phase', phase: 'copying', label: 'Copying' } });
      try {
        await act(async () => {
          publishActionOperationObservation({ serverId: h.serverId, machineId: 'devbox', observation: 'available', snapshots: [operation] });
          if (actionId === 'projects.service.relocate') h.attach(operation);
        });
        await vi.waitFor(() => expect(h.screen.findByTestId('service-row-start-row')).toBeNull());
        // A transport interruption alone must retain the receipt and block another Start.
        await act(async () => actionOperationStore.setMachineObservation({ serverId: h.serverId, machineId: 'devbox' }, 'reconnecting'));
        expect(h.screen.findByTestId('service-row-start-row')).toBeNull();
        await act(async () => publishActionOperationObservation({ serverId: h.serverId, machineId: 'devbox', observation: 'available',
          snapshots: [ActionOperationSnapshotV1Schema.parse({ ...operation, revision: 2, state: 'failed', settledAt: 3,
            error: { errorCode: 'service_preparation_failed', error: 'Preparation failed' } })] }));
        const knownOperationKeys = new Set(actionOperationStore.getSnapshot().operationsByKey.keys());
        await act(async () => actionOperationStore.reconcileMachineProjection({ serverId: h.serverId, accountId: 'artifact-account',
          machineId: 'devbox', snapshots: [], knownOperationKeys }));
        expect(actionOperationStore.getSnapshot().operationsByKey.size).toBe(0);
        await vi.waitFor(() => expect(h.screen.findByTestId('placement.move.inspect')).toBeNull());
        expect(h.screen.getTextContent()).not.toContain('projectServices.moveUnknown');
        expect(h.screen.findByTestId('service-row-start-row')).toBeTruthy();
        expect(h.runsOn().props.disabled).toBe(false);
        expect(h.screen.findAllByTestId('placement.picker')[0]?.props.selected).toEqual({ kind: 'primary' });
        expect(h.writes).toEqual([]);
      } finally { await h.screen.unmount(); }
    });

  it('shows canonical uncertain-start observation and retains Inspect without inferring stopped recovery', async () => {
    const { screen, serverId, attach, runsOn, choose, writes, failPlacementReads, setLifecycle } = await setup({ running: false, sharedObservation: true });
    const operation: ActionOperationSnapshotV1 = { version: 1, operationId: 'uncertain-service-move', revision: 1,
      actionId: 'projects.service.relocate', state: 'running', scope: { accountId: 'artifact-account', machineId: 'devbox' },
      title: 'Move server', createdAt: 1, startedAt: 2, cancellation: 'supported',
      domainRef: { kind: 'projectService', purpose: 'relocation', workspace: {
        serverId, machineId: 'hz-build-1', workspaceId: 'worker-checkout', rootPath: '/worker/happier' },
      declaration: { workspaceRefId: 'worker-checkout', selection: { kind: 'manifest', name: 'server' } } },
      progress: { kind: 'phase', phase: 'starting', label: 'Starting service' },
      observation: { kind: 'outcome_uncertain', code: 'outcome_uncertain' } };
    await act(async () => {
      publishActionOperationObservation({ serverId, machineId: 'devbox', observation: 'available', snapshots: [operation] });
      attach(operation);
    });
    await vi.waitFor(() => expect(screen.findByTestId('placement.move.inspect')).toBeTruthy());
    expect(screen.getTextContent()).toContain('projectServices.moveUnknown');
    expect(screen.getTextContent()).not.toContain('Starting service');
    expect(runsOn().props.disabled).toBe(true);
    expect(runsOn().props.subtitle).not.toBe('projectServices.moveFailedStopped');
    await choose('hz-build-1');
    expect(writes).toEqual([]);
    failPlacementReads();
    await act(async () => { setLifecycle('settings-unavailable'); });
    await vi.waitFor(() => expect(screen.findByTestId('placement.unavailable')).toBeTruthy());
    expect(screen.findByTestId('placement.move.inspect')).toBeTruthy();
  });
  it.each(['stopping', 'starting'])('retains a failed %s operation without treating terminal state and absence as safe recovery', async phase => {
    const { screen, serverId, attach, runsOn, choose, writes } = await setup({ running: false, sharedObservation: true });
    const operation: ActionOperationSnapshotV1 = { version: 1, operationId: 'unproven-service-move', revision: 1,
      actionId: 'projects.service.relocate', state: 'failed', scope: { accountId: 'artifact-account', machineId: 'devbox' },
      title: 'Move server', createdAt: 1, startedAt: 2, settledAt: 3, cancellation: 'supported',
      domainRef: { kind: 'projectService', purpose: 'relocation', workspace: {
        serverId, machineId: 'devbox', workspaceId: 'checkout', rootPath: '/src/happier' },
      declaration: { workspaceRefId: 'checkout', selection: { kind: 'manifest', name: 'server' } } },
      progress: { kind: 'phase', phase, label: 'Move phase' }, error: { errorCode: 'move_failed', error: 'Move failed' } };
    await act(async () => {
      publishActionOperationObservation({ serverId, machineId: 'devbox', observation: 'available', snapshots: [operation] });
      attach(operation);
    });
    await vi.waitFor(() => expect(screen.findByTestId('placement.move.inspect')).toBeTruthy());
    expect(screen.getTextContent()).toContain('projectServices.moveUnknown');
    expect(screen.findByTestId('placement.move.refused')).toBeNull();
    expect(runsOn().props.disabled).toBe(true);
    await choose('hz-build-1');
    expect(writes).toEqual([]);
  });
  it('passes the current declaration portability and memory to the row placement owner', async () => {
    const { createProjectServicePlacementRenderer } = await import('./ProjectServicePlacementControls');
    const facts = { portable: false, memoryDemand: { bytes: 2147483648, basis: { kind: 'declared' as const } } };
    const source = { serverId: 'home', machineId: 'devbox', refId: 'checkout' };
    const [row] = buildLocalServiceRows({ inventoryRows: [], launchTargets: [{
      id: 'declared', source: 'managed_service', machineId: 'devbox', title: 'server',
      declaration: { workspaceRefId: 'checkout', selection: { kind: 'manifest', name: 'server' } },
      confidence: 'high', state: 'unavailable', unavailableReason: 'launch_unavailable', actions: [],
    }], sessionId: null, scope: 'workspace' });
    const render = createProjectServicePlacementRenderer(source, { server: facts });
    expect((render?.(row!) as React.ReactElement<{ declaration: typeof facts }>).props.declaration).toEqual(facts);
  });
  it('refreshes placement when a new native occurrence replaces one with the same row id and running state', async () => {
    const { createProjectServicePlacementRenderer } = await import('./ProjectServicePlacementControls');
    const target = { id: 'service', source: 'managed_service' as const, machineId: 'source',
      sourceClass: { kind: 'managed_service' as const, managedServiceId: 'first' }, serviceState: 'running' as const,
      declaration: { workspaceRefId: 'checkout', selection: { kind: 'manifest' as const, name: 'web' } },
      confidence: 'high' as const, state: 'available' as const, title: 'web', actions: [] };
    const [row] = buildLocalServiceRows({ inventoryRows: [], launchTargets: [target], sessionId: null, scope: 'workspace' });
    const render = createProjectServicePlacementRenderer({ serverId: 'home', refId: 'checkout', machineId: 'source' }, { web: { portable: true } });
    const first = render?.(row!) as React.ReactElement<{ lifecycleKey: string }>;
    const next = render?.({ ...row!, target: { ...target, sourceClass: { kind: 'managed_service', managedServiceId: 'replacement' } } }) as React.ReactElement<{ lifecycleKey: string }>;
    expect(next.props.lifecycleKey).not.toBe(first.props.lifecycleKey);
  });
  it.each([false, true])('the placement model itself refuses a stopped save for uncertain or live custody (live=%s)', async running => {
    const { model, writes } = await setup({ running, actualFails: !running, modelOnly: true });
    expect(model()).toMatchObject({
      actual: { status: running ? 'present' : 'unavailable' },
      desiredPlacement: { runsOn: { kind: 'primary' } },
      canSaveNextStart: false,
      canMove: running,
    });
    await act(async () => { await model().save({ runsOn: { kind: 'workers', destination: { kind: 'machine', machineId: 'hz-build-1' } }, unavailable: 'fail' }); });
    expect(writes).toEqual([]);
  });
  it('displays the actual Machine rather than the differing desired placement for a live service', async () => {
    const { model } = await setup({ running: true, modelOnly: true,
      saved: { runsOn: { kind: 'workers', destination: { kind: 'machine', machineId: 'hz-build-1' } }, unavailable: 'fail' } });
    expect(model()).toMatchObject({ displayChoice: { kind: 'primary' },
      desiredPlacement: { runsOn: { kind: 'workers', destination: { kind: 'machine', machineId: 'hz-build-1' } } } });
  });

  it('does not treat an unobservable binding as stopped: no save, and a way to check again', async () => {
    const { screen, writes, choose, runsOn, setActualFails } = await setup({ running: true, actualFails: true, waitEnabled: false });
    await vi.waitFor(() => expect(screen.findByTestId('placement.custody')).toBeTruthy());
    expect(screen.getTextContent()).toContain('localServices.launcher.unavailableReason.bindingUnavailableOnMachine');
    expect(screen.getTextContent()).toContain('Source workstation');
    expect(runsOn().props.disabled).toBe(true);
    await choose('hz-build-1');
    expect(writes).toEqual([]);
    setActualFails(false);
    await screen.pressByTestIdAsync('placement.custody.retry');
    await vi.waitFor(() => expect(runsOn().props.disabled).toBe(false));
    expect(screen.findByTestId('placement.custody')).toBeNull();
  });

  it('does not let a retired refresh failure replace a newer healthy placement observation', async () => {
    const older = createDeferred<void>();
    let reads = 0;
    const { screen, runsOn, setLifecycle } = await setup({ running: true, serviceState: 'healthy',
      beforeBindingRead: async () => {
        reads += 1;
        if (reads === 2) await older.promise;
      } });
    await act(async () => { setLifecycle('older-refresh'); });
    await vi.waitFor(() => expect(reads).toBe(2));
    await act(async () => { setLifecycle('newer-refresh'); });
    await vi.waitFor(() => expect(reads).toBe(3));
    await vi.waitFor(() => expect(runsOn().props.disabled).toBe(false));
    await act(async () => { older.reject(new Error('late_transport_failure')); });
    expect(runsOn().props.disabled).toBe(false);
    expect(screen.findByTestId('placement.custody')).toBeNull();
  });

  it('keeps a healthy refreshed observation when only Project organization changes during the native read', async () => {
    let reads = 0;
    const { screen, runsOn, setLifecycle } = await setup({ running: true, serviceState: 'healthy', beforeBindingRead: async () => {
      if (++reads !== 2) return;
      const current = storage.getState().projectAccountRows!;
      storage.getState().applyProjectAccountRowsForScope(current.scope, { ...current, organizations: [{
        key: { kind: 'project-organization', serverId: current.scope.serverId, projectKey: 'checkout' }, revision: 1,
        value: { hidden: false, pinned: true },
      }] });
    } });
    await act(async () => { setLifecycle('organization-refresh'); });
    await vi.waitFor(() => expect(reads).toBe(2));
    await flushHookEffects();
    expect(runsOn().props.disabled).toBe(false);
    expect(screen.findByTestId('placement.custody')).toBeNull();
  });

  it('explains a topology change during a native read without calling the service stopped', async () => {
    let reads = 0;
    const { screen, writes, runsOn, setLifecycle } = await setup({ running: true, beforeBindingRead: async () => {
      if (++reads !== 2) return;
      const current = storage.getState().projectAccountRows!;
      storage.getState().applyProjectAccountRowsForScope(current.scope, { ...current,
        workspaceRefs: current.workspaceRefs.map(ref => ({ ...ref, rootPath: '/changed-root' })) });
    } });
    await act(async () => { setLifecycle('changed-topology'); });
    await vi.waitFor(() => expect(screen.getTextContent()).toContain('projectServices.changed'));
    expect(runsOn().props.disabled).toBe(true);
    expect(writes).toEqual([]);
  });

  it('offers no workers for a primary-only service', async () => {
    const { screen, runsOn } = await setup({ running: false, portable: false, waitEnabled: false });
    await vi.waitFor(() => expect(String(runsOn().props.subtitle)).toBe('projectServices.primaryOnly'));
    const { WorkerDestinationPicker } = await import('@/components/projects/workers/WorkerDestinationPicker');
    expect(screen.tree.findAllByType(WorkerDestinationPicker)).toHaveLength(0);
    // A primary-only service has nothing to choose: no control that can never succeed, no dimmed row.
    expect(screen.tree.findAll(node => String(node.props.testID ?? '').startsWith('placement.fallback'))).toHaveLength(0);
    expect(runsOn().props.disabled).toBeFalsy();
    expect(runsOn().props.onPress).toBeUndefined();
  });

  it('says a live service on this checkout\'s machine runs next to it', async () => {
    const { screen, runsOn } = await setup({ running: true, waitEnabled: false });
    await vi.waitFor(() => expect(screen.getTextContent()).toContain('projectServices.runsHere'));
    expect(runsOn().props.disabled).toBeFalsy();
  });

  it('does not claim primary-only custody when the actual binding is unavailable', async () => {
    const { screen, runsOn } = await setup({ running: false, actualFails: true, portable: false, waitEnabled: false });
    await vi.waitFor(() => expect(screen.findByTestId('placement.custody')).toBeTruthy());
    expect(runsOn().props.detail).toBe('projectServices.actualUnavailable');
    expect(screen.getTextContent()).toContain('localServices.launcher.unavailableReason.bindingUnavailableOnMachine');
    expect(screen.getTextContent()).not.toContain('projectServices.primaryOnly');
  });

  it('re-reads the binding when the Services feed observes a lifecycle change', async () => {
    const { setLifecycle } = await setup({ running: false });
    const reads = () => remote.mock.calls.length;
    const before = reads();
    await act(async () => { setLifecycle('running:devbox'); });
    await vi.waitFor(() => expect(reads()).toBeGreaterThan(before));
  });

  it('saves a stopped service’s next start without opening a Move', async () => {
    const { screen, writes, choose } = await setup({ running: false });
    await choose('hz-build-1');
    await vi.waitFor(() => expect(writes, JSON.stringify([fixture?.requests, screen.findAllByTestId('placement.notice')[0]?.props.title])).toHaveLength(1));
    expect(writes[0]?.services.server).toEqual({
      runsOn: {
        kind: 'workers',
        destination: { kind: 'machine', machineId: 'hz-build-1' },
      },
      unavailable: 'fail',
    });
    expect(screen.findByTestId('placement.move')).toBeNull();
  });

  it('saves a stopped service’s same-pool change from Ask to Automatic', async () => {
    const poolId = '00000000-0000-4000-8000-000000000032';
    const { screen, writes } = await setup({ running: false, saved: {
      runsOn: { kind: 'workers', destination: { kind: 'pool', poolId, selection: 'ask' } },
      unavailable: 'fail',
    } });
    const { WorkerDestinationPicker } = await import('@/components/projects/workers/WorkerDestinationPicker');
    await act(async () => {
      screen.tree.findByType(WorkerDestinationPicker).props.onChoose({
        kind: 'workers', destination: { kind: 'pool', poolId, selection: 'automatic' },
      });
    });
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]?.services.server).toEqual({
      runsOn: { kind: 'workers', destination: { kind: 'pool', poolId, selection: 'automatic' } },
      unavailable: 'fail',
    });
    expect(screen.findByTestId('placement.move')).toBeNull();
  });

  it('honours the target Home Move waiver when another Account settings projection is focused', async () => {
    const { screen, choose } = await setup({ running: true });
    const { settingsParse } = await import('@/sync/domains/settings/settings');
    storage.setState({ settingsScope: { serverId: 'foreign-home', accountId: 'foreign-account' },
      settings: settingsParse({ actionsSettingsV1: { v: 1, actions: {} } }) });
    await choose('hz-build-1');
    await vi.waitFor(() => expect(screen.findByTestId('placement.move.refused')).toBeTruthy());
    expect(screen.findByTestId('placement.move.confirm')).toBeNull();
  });

  it('asks by default before moving a running service and cancellation leaves placement unsaved', async () => {
    const { screen, writes, choose } = await setup({ running: true, waiveMoveApproval: false });
    await choose('hz-build-1');
    await vi.waitFor(() =>
      expect(screen.findByTestId('placement.move')).toBeTruthy(),
    );
    await screen.pressByTestIdAsync('placement.move.cancel');
    expect(screen.findByTestId('placement.move')).toBeNull();
    expect(writes).toEqual([]);
  });

  it('resolves an Automatic pool to one exact Machine before the default Move review', async () => {
    const poolId = '00000000-0000-4000-8000-000000000032';
    const { screen, writes, poolReads, choosePool } = await setup({ running: true, waiveMoveApproval: false });
    await choosePool(poolId);
    await vi.waitFor(() => expect(screen.findByTestId('placement.move')).toBeTruthy());
    expect(poolReads).toEqual([{ poolId }]);
    expect(screen.getTextContent()).toContain('pool-worker');
    await screen.pressByTestIdAsync('placement.move.cancel');
    expect(JSON.stringify(remote.mock.calls)).toContain('pool-worker');
    expect(remote.mock.calls).toContainEqual([expect.objectContaining({
      machineId: 'pool-worker', payload: expect.objectContaining({
        purpose: 'service-start', workspace: expect.objectContaining({ refId: 'checkout' }),
      }),
    })]);
    expect(writes).toEqual([]);
  });
});
