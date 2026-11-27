import * as React from 'react';
// Real Action receipt captured from createProductionDaemonWorkspaceSyncRuntime.test.ts's
// stopped-Machine + surviving sibling topology; the dependency reader and owner are unmocked.
import offlineRetireReceipt from './MachineProjectWorkSection.offlineRetire.fixture.json';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decodePlainMachineStoredContent,
  encodePlainMachineStoredContent,
  MACHINE_PLAIN_DATA_KEY_MARKER,
} from '@happier-dev/protocol/machines/machineStoredContent';
import {
  computeWorkspaceSyncPolicyDigest,
  type WorkspaceSyncRelationshipV1,
} from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { readActionFailureEnvelope } from '@happier-dev/protocol/actions/executor/actionFailureEnvelope';
import { createExternalActionAccountHttpBoundary, type ExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { ActionAutomationIndexV1Schema, AUTOMATION_ACTION_INDEX_HTTP_PATH_V1 } from '@happier-dev/protocol/automations/automationActionTriggerV1';
import { automationSubjectKeyV1 } from '@happier-dev/protocol/automations/automationSubjectV1';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { approvalArtifactBodyMatchesHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';


import { createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createHydratedPlainMachineFixture, createMachineMetadataFixture, createMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture, createPlainSharedMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { storage } from '@/sync/domains/state/storage';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { Modal } from '@/modal';
import { buildMachineActivityPlaceholder } from '@/sync/domains/machines/machineActivity';

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
    translate: (key, params) => key === 'projectWorkers.removeUnchecked' ? `${key}(${params?.machines})`
      : key.startsWith('errors.machine') && key.endsWith('Named') ? `${key}(${params?.machine})` : key,
  }),
);
vi.mock(
  '@/modal',
  async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module,
);
// Portal placement and window measurement are the platform boundary; keep the capacity field real.
vi.mock('@/components/ui/popover', async importOriginal =>
  (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal, {
    maxHeight: 320, maxWidth: 280, placement: 'bottom', presentation: 'sheet',
  }));

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
const machineHttp = vi.hoisted(() => ({
  read: null as null | (() => Response),
  gate: null as null | Promise<void>,
}));
let projectRowsRead: (() => Promise<Response>) | null = null;
const viewport = vi.hoisted(() => ({ compact: false }));
// Window size is an environment adapter; every row below it is production code.
vi.mock('@/utils/platform/useViewportClass', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/utils/platform/useViewportClass')>();
  return {
    ...actual,
    useViewportClass: (...args: Parameters<typeof actual.useViewportClass>) =>
      viewport.compact ? 'compact' : actual.useViewportClass(...args),
  };
});
const rpc = vi.hoisted(() => ({ machine: vi.fn() }));
// The daemon network is the boundary for copy facts and retirement; Action policy and the hook are real.
vi.mock(
  '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
  async () => {
    const { createServerScopedMachineRpcBoundaryMock } =
      await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(rpc.machine);
  },
);
let copyApprovalAccount: Awaited<ReturnType<typeof import('@/sync/ops/actions/actionAccountContext').captureLazyActionAccountContext>> | undefined;
let fixture:
  | Awaited<ReturnType<typeof createPlainArtifactHomeFixture>>
  | undefined;
afterEach(async () => {
  projectRowsRead = null;
  machineHttp.read = null;
  machineHttp.gate = null;
  viewport.compact = false;
  rpc.machine.mockReset();
  copyApprovalAccount?.dispose();
  copyApprovalAccount = undefined;
  await fixture?.dispose();
  fixture = undefined;
  vi.restoreAllMocks();
});

/**
 * The Machine's real metadata read (Home HTTP) and its metadata CAS socket are the boundaries; the
 * finite-policy semantic mutation, Action policy and the settings rows above them are production code.
 */
async function setup(
  options: Readonly<{
    mounted?: boolean;
    machineId?: string;
    machineName?: string;
    holdPolicyRead?: boolean;
    /** The Machine page above already says the Machine is offline. */
    announced?: boolean;
    deferMachineDiscovery?: boolean;
    presenceBeforeDiscovery?: boolean;
    waive?: readonly string[];
    role?: 'use';
    copyCheck?: boolean;
  }> = {},
) {
  rpc.machine.mockImplementation(async ({ method }: { method: string }) => {
    throw new Error(`unexpected_rpc:${method}`);
  });
  let releasePolicyRead = () => {};
  if (options.holdPolicyRead)
    machineHttp.gate = new Promise<void>((resolve) => {
      releasePolicyRead = resolve;
    });
  const accountId = 'artifact-account';
  const machineId = options.machineId ?? 'm1';
  const { upsertServerProfileOnly } = await import('@/sync/domains/server/serverRuntime');
  // This fixture is already bootstrapped: its local Home id and portable identity agree.
  await upsertServerProfileOnly({ serverUrl: 'https://srv_machine_work' });
  await setServerProfileIdentityForUrl('https://srv_machine_work', 'srv_machine_work');
  // Retirement (b64689faec4) and inspection (4ed0b0c6a2c) use the signed HTTP
  // Account Action boundary. Keep policy, Account capture and output codecs real.
  // The receiving daemon owns native Ask since b64689faec4. Its Protocol
  // executor builds the carried review; only its final network port is replaced.
  const copyRetireDependencies = {
    readActionsSettings: () => storage.getState().settings.actionsSettingsV1,
    projectWorkerAction: (({ actionId, input }) => rpc.machine({
      method: getActionSpec(actionId).bindings!.rpcMethod!, payload: input,
    })) satisfies NonNullable<import('@happier-dev/protocol/actions/executor/types').ActionExecutorDeps['projectWorkerAction']>,
  };
  let receiver = createActionExecutor(createActionExecutorBoundaryFixture(copyRetireDependencies));
  const copyActions = await Promise.all((['projects.worker.copy.inspect', 'projects.worker.copy.retire'] as const).map(async actionId => {
    let boundary: ExternalActionAccountHttpBoundary;
    boundary = await createExternalActionAccountHttpBoundary({ serverUrl: 'https://srv_machine_work',
      serverIdentityId: 'srv_machine_work', accountId, machineId: 'source-machine', actionId, tokenEpoch: 0, requesterInvocation: 'optional',
      execute: async (input, context) => {
        const authorization = context.authorization;
        const outcome = await receiver.execute(actionId, input, { surface: 'ui', authority: 'present_user',
          actionCaller: { kind: 'host' }, serverId: 'srv_machine_work', serverIdentityId: 'srv_machine_work',
          runtimeAccountId: 'artifact-account', actionRequestId: context.requestId, externalActionTarget: context.target,
          ...(context.invocation?.presentUserConfirmation ? { presentUserConfirmation: context.invocation.presentUserConfirmation } : {}),
          ...(options.copyCheck && authorization ? { externalActionExecutionAuthorization: authorization, originalActionEnvelope: context.envelope,
            signExternalActionApprovalInput: ({ actionId: requestedId, input: reviewedInput, target, requesterConfirmation, sessionTargetsV1 }) =>
              boundary.signApprovalInput({ authorizationToken: authorization.token, actionId: requestedId, input: reviewedInput, target,
                ...(requesterConfirmation ? { requesterConfirmation } : {}), ...(sessionTargetsV1 ? { sessionTargetsV1 } : {}) }),
          } : {}),
        });
        return outcome.ok ? outcome.result : outcome;
      },
      failure: result => actionId === 'projects.worker.copy.retire' ? readActionFailureEnvelope(result) : null,
    });
    return boundary;
  }));

  const ownerMachine = createHydratedPlainMachineFixture({
    id: machineId,
    accountId,
    // A Machine that is answering; an offline one is covered by its own case.
    machine: { active: true, activeAt: Date.now(), metadataVersion: 4,
      ...(options.machineName ? { metadata: createMachineMetadataFixture({ displayName: options.machineName }) } : {}) },
  });
  const sharedRow = options.role ? createPlainSharedMachineRowFixture({
    id: ownerMachine.id, custodianAccountId: 'owner', role: options.role, machine: ownerMachine,
  }) : null;
  const machine = sharedRow ? {
    ...ownerMachine,
    isShared: true,
    access: sharedRow.access,
    keyBasis: sharedRow.keyBasis,
    dataEncryptionKey: sharedRow.dataEncryptionKey,
    installationId: sharedRow.installationId,
  } : ownerMachine;
  let metadata: Record<string, unknown> = { ...machine.metadata };
  let version = 4;
  let policyReads = 0;
  // The Machine policy port reads the sync owner's encryption context (absent for Plain).
  const { loadSyncSingletonForTests } =
    await import('@/dev/testkit/harness/syncSingletonLoader');
  await loadSyncSingletonForTests();
  fixture = await createPlainArtifactHomeFixture('https://srv_machine_work', { accountId, currentAccount: true,
    ...(options.copyCheck ? { serverFeatures: createRootLayoutFeaturesResponse({ features: { workflows: { enabled: true } } }) } : {}),

    handleRequest: async (path, init) => {
      if (path === '/v1/account/project-rows/list' && projectRowsRead) return projectRowsRead();
      if (options.copyCheck && path === AUTOMATION_ACTION_INDEX_HTTP_PATH_V1) {
        return Response.json(ActionAutomationIndexV1Schema.parse({ v: 1, rows: [{
          automationId: 'copy-check', triggerId: 'before-removal', triggerRevision: 1,
          workflowId: 'copy-workflow', workflowRevision: 1, ownerAccountId: 'another-account',
          actionIds: ['projects.worker.copy.retire'], phase: 'before', mode: 'wait', onFailure: 'refuse',
          reachesOthers: true, subjectKind: 'machine', subjectKey: automationSubjectKeyV1({
            kind: 'machine', serverId: 'srv_machine_work', machineId: 'source-machine',
          }, 'copy-workflow'),
        }] }));
      }
      if (path.startsWith('/v1/actions/') || path === '/v1/machines/source-machine') {
        for (const boundary of copyActions) {
          const response = await boundary.handle(new URL(path, 'https://srv_machine_work'), init);
          if (response) return response;
        }
      }
      const batch = path === '/v1/machines/read-batch' && init?.method === 'POST';
      if (!machineHttp.read || (path !== `/v1/machines/${machineId}` && !batch)) return null;
      policyReads += 1;
      await machineHttp.gate;
      const response = machineHttp.read();
      if (!batch || !response.ok) return response;
      const body: unknown = await response.json();
      const row = body && typeof body === 'object' && 'machine' in body ? body.machine : null;
      return createMachineReadBatchResponseFixture(init?.body, id => id === machineId ? row : id === 'source-machine' ? copyActions[0]!.machine : null);
    },
  });
  if (options.copyCheck) {
    const [{ captureLazyActionAccountContext }, { createUiActionAutomationPortV1 }, approvalArtifacts,
      { isApprovalExecutionOriginCurrentForAccountContext }] = await Promise.all([
      import('@/sync/ops/actions/actionAccountContext'), import('@/sync/ops/actions/actionAutomations'),
      import('@/sync/ops/actions/approvalArtifactWriter'), import('@/sync/ops/actions/defaultActionExecutor'),
    ]);
    const account = await captureLazyActionAccountContext(fixture.home.id);
    const read = (id: string) => account.fetchArtifact(id, { fresh: true });
    copyApprovalAccount = account;
    receiver = createActionExecutor(createActionExecutorBoundaryFixture({
      ...copyRetireDependencies,
      actionAutomations: createUiActionAutomationPortV1(account),
      approvalsCreate: ({ request }) => approvalArtifacts.createApprovalArtifact({ request, accountId: account.accountId,
        read: id => account.readArtifact(id, { fresh: true, ownerOnly: true }),
        create: async (id, header, body, scope) => (await account.createArtifactDocument({ artifactId: id, header, body, idScope: scope })).artifact,
      }),
      approvalsGet: async ({ artifactId }) => {
        const artifact = await read(artifactId);
        const match = artifact?.header && typeof artifact.body === 'string'
          ? approvalArtifactBodyMatchesHeaderV1(artifact.header, artifact.body) : null;
        return match?.family === 'built_in' ? match.request : null;
      },
      approvalsUpdate: ({ artifactId, request }) => approvalArtifacts.writeApprovalRequestArtifact({
        artifactId, request, read,
        write: (basis, header, body) => account.updateArtifact(artifactId, header, body, basis),
      }),
      isApprovalExecutionOriginCurrent: async ({ origin }) => isApprovalExecutionOriginCurrentForAccountContext({
        origin, accountServerId: account.serverId, accountId: account.accountId,
      }),
    }));
  }
  machineHttp.read = () =>
    new Response(
      JSON.stringify({
        machine: {
          ...(sharedRow ?? createPlainMachineRowFixture({ id: machineId, accountId, machine })),
          metadata: encodePlainMachineStoredContent(metadata),
          metadataVersion: version,
        },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  const sent: Record<string, unknown>[] = [];
  vi.spyOn(apiSocket, 'emitWithAck').mockImplementation((async (
    event: string,
    request: { metadata: string; expectedVersion: number },
  ) => {
    if (event !== 'machine-update-metadata')
      throw new Error(`Unexpected socket event ${event}`);
    metadata = decodePlainMachineStoredContent(request.metadata) as Record<
      string,
      unknown
    >;
    sent.push(metadata);
    version = request.expectedVersion + 1;
    return { result: 'success', version, metadata: request.metadata };
  }) as typeof apiSocket.emitWithAck);
  if (options.presenceBeforeDiscovery) storage.getState().applyMachines([buildMachineActivityPlaceholder(machine)]);
  else if (options.deferMachineDiscovery) storage.setState({ machines: {} });
  else storage.getState().applyMachines([machine]);
  // Ask first is the Action default; these cases waive it in the Account's canonical settings.
  const { settingsParse } = await import('@/sync/domains/settings/settings');
  const settingsScope = storage.getState().settingsScope;
  if (!settingsScope) throw new Error('expected_settings_scope');
  storage.getState().applySettingsForScope(
    settingsScope,
    settingsParse({
      ...storage.getState().settings,
      actionsSettingsV1: {
        v: 1,
        actions: options.waive?.includes('projects.worker.copy.retire') ? {} : {
          'projects.worker.copy.retire': { approvalRequiredSurfaces: ['ui'] },
        },
        approvalWaivedSurfaces: Object.fromEntries(
          ['machines.worker.policy.set', ...(options.waive ?? [])].map(
            (surface) => [surface, ['ui']],
          ),
        ),
      },
    }),
    (storage.getState().settingsVersion ?? 0) + 1,
  );
  const { MachineProjectWorkSection } =
    await import('./MachineProjectWorkSection');
  const { CheckoutReachabilityScope } = await import('@/components/workspaces/reachability/checkoutReachability');
  const section = (
    <MachineProjectWorkSection
      testID="work"
      serverId={fixture.home.id}
      machineId={machineId}
      machineName="hz-build-1"
    />
  );
  const { createMountedCurrentUiContextWrapper } = await import('@/dev/testkit/harness/mountedCurrentUiContext');
  const { useOptionalCurrentUiContextReader } = await import('@/components/appShell/currentUiContext/CurrentUiContextProvider');
  let reader: ReturnType<typeof useOptionalCurrentUiContextReader> = null;
  function Observe() { reader = useOptionalCurrentUiContextReader(); return null; }
  const body = options.announced
      ? <CheckoutReachabilityScope scope={{ serverId: fixture.home.id, machineId }}>{section}</CheckoutReachabilityScope>
      : section;
  const screen = await renderScreen(options.mounted ? <><Observe />{body}</> : body, options.mounted ? { wrapper: await createMountedCurrentUiContextWrapper() } : undefined);
  if (!options.role && !options.holdPolicyRead && !options.deferMachineDiscovery && !options.presenceBeforeDiscovery)
    await vi.waitFor(() =>
      expect(screen.findAllByTestId('work.accepting')[0]?.props.disabled).toBe(
        false,
      ),
    );
  return { screen, getReader: () => reader!, sent, releasePolicyRead, policyReadCount: () => policyReads,
    discoverMachine: () => storage.getState().applyMachines([machine]),
    decideCopyApproval: (artifactId: string) => receiver.execute('approval.request.decide', {
      artifactId, decision: 'approve',
      triggerConsent: { automationId: 'copy-check', triggerId: 'before-removal', decision: 'skip' },
    }, { authority: 'present_user', surface: 'ui', serverId: fixture!.home.id, serverIdentityId: 'srv_machine_work',
      runtimeAccountId: accountId, actionCaller: { kind: 'host' } }),
  };
}

async function seedWorkerCopy(targetMachineId = 'm1') {
  const scope = storage.getState().profileScope;
  if (!scope || scope.serverId !== fixture?.home.id)
    throw new Error('expected_current_project_account_scope');
  const source = {
    id: 'fresh-source',
    serverId: scope.serverId,
    machineId: 'source-machine',
    rootPath: '/source/project',
    label: 'Original source checkout',
    createdAtMs: 1,
    projectKey: 'fresh-project',
  };
  const target = {
    id: 'fresh-target',
    serverId: scope.serverId,
    machineId: targetMachineId,
    rootPath: '/worker/project',
    label: 'Worker target checkout',
    createdAtMs: 1,
    projectKey: 'fresh-project',
  };
  const policy = {
    v: 1 as const,
    selection: 'git_worktree' as const,
    extraIgnorePatterns: [],
    extraIncludePatterns: [],
  };
  const relationship: WorkspaceSyncRelationshipV1 = {
    v: 1,
    relationshipId: 'proven-worker-target',
    controllerMachineId: 'source-machine',
    alphaWorkspaceRefId: target.id,
    betaWorkspaceRefId: source.id,
    mode: 'keep_synced',
    enabled: true,
    contentPolicy: {
      ...policy,
      policyDigest: computeWorkspaceSyncPolicyDigest(policy),
    },
    createdAtMs: 1,
    updatedAtMs: 1,
    provenance: {
      kind: 'worker_clean_copy',
      sourceWorkspaceRefId: source.id,
      targetWorkspaceRefId: target.id,
    },
  };
  await act(async () => {
    storage.getState().activateProjectAccountRowsScope(scope);
    storage
      .getState()
      .applyProjectAccountRowsForScope(scope, {
        scope,
        status: 'ready',
        coverage: 'complete',
        workspaceRefs: [source, target],
        relationships: [relationship],
        organizations: [],
        revisionsByPhysicalKey: {},
      });
  });
  return { scope, source, target };
}

describe('Machine › Work from your projects through the Machine policy Actions', () => {
  it('publishes the complete compact navigation inventory and retires it on unmount', async () => {
    viewport.compact = true;
    const { screen, getReader } = await setup({ mounted: true });
    try {
    const reader = getReader();
    expect(reader.readCurrentUiContext()!.commands.map(command => command.title)).toEqual(['projectWorkers.capacity', 'projectWorkers.manageInSync']);
    const address = reader.readCurrentUiContext()!.commands[0]!.id;
    const resolved = reader.resolveCurrentUiCommand(address)!;
    if (resolved.command.kind !== 'hostLocal') throw new Error('expected_local');
    const command = resolved.command;
    await act(async () => { await command.invoke({ signal: resolved.retirementSignal, context: { surface: 'agent' } }); });
    expect(screen.findAll(node => node.props?.open === true).length).toBeGreaterThan(0);
    const popover = screen.find(node => node.props?.open === true && typeof node.props.onRequestClose === 'function');
    await act(async () => { popover.props.onRequestClose(); });
    await screen.pressByTestIdAsync('work.capacity.row');
    expect(screen.findAll(node => node.props?.open === true).length).toBeGreaterThan(0);
    await screen.unmount();
    expect(reader.resolveCurrentUiCommand(address)).toBeNull();
    expect(resolved.retirementSignal.aborted).toBe(true);
    } finally { await screen.unmount(); }
  });

  it('keeps a real failed policy read unavailable even while the Machine answers, and retries that read', async () => {
    const { screen, releasePolicyRead } = await setup({ holdPolicyRead: true });
    const successfulRead = machineHttp.read;
    machineHttp.read = () => new Response(null, { status: 503 });
    await act(async () => { releasePolicyRead(); });
    const notice = () => screen.findAllByTestId('work.unavailable')[0]?.props;
    await vi.waitFor(() => expect(notice()?.action).toBeTruthy());
    expect(screen.findAllByTestId('work.accepting')).toHaveLength(0);
    machineHttp.read = successfulRead;
    await act(async () => { notice()?.action?.onPress(); });
    await vi.waitFor(() => expect(screen.findAllByTestId('work.accepting')[0]?.props.disabled).toBe(false));
    expect(screen.findAllByTestId('work.unavailable')).toHaveLength(0);
  });
  it.each([false, true])('waits for Machine content before policy admission (presence arrived first: %s)', async (presenceBeforeDiscovery) => {
    const { screen, discoverMachine, policyReadCount } = await setup({ deferMachineDiscovery: true, presenceBeforeDiscovery });
    await act(async () => { await Promise.resolve(); });
    expect(screen.findAllByTestId('work.unavailable')).toHaveLength(0);
    expect(screen.findAllByTestId('work.accepting')[0]?.props.subtitle).toBe('common.loading');
    expect(policyReadCount()).toBe(0);
    await act(async () => { discoverMachine(); });
    await vi.waitFor(() => expect(screen.findAllByTestId('work.accepting')[0]?.props.disabled).toBe(false));
    expect(policyReadCount()).toBe(1);
  });
  it.each(['locked', 'key_pending', 'refused'] as const)('keeps an online Machine with %s content unavailable without reading or writing policy', async (state) => {
    const { screen, sent, policyReadCount } = await setup({ deferMachineDiscovery: true });
    await act(async () => {
      storage.getState().applyMachines([createMachineFixture({ id: 'm1', activeAt: Date.now(),
        storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        ...(state === 'locked' ? { availability: { kind: 'locked', reason: 'decryption_failed' } } : {
          access: { custodian: { accountId: 'artifact-account', displayName: 'Test Account' },
            role: 'manage', resourceMode: 'plain', accessState: state },
        }),
      })]);
    });
    await vi.waitFor(() => expect(screen.findAllByTestId('work.unavailable').length).toBeGreaterThan(0));
    expect(screen.findAllByTestId('work.accepting')).toHaveLength(0);
    expect(policyReadCount()).toBe(0);
    expect(sent).toHaveLength(0);
  });
  it('shows a Can use person the policy read-only and says who changes it', async () => {
    const { screen, sent } = await setup({ role: 'use' });
    await vi.waitFor(() => expect(screen.getTextContent()).toContain('machines.widgets.body.common.recipient'));
    expect(screen.findAllByTestId('work.accepting')[0]?.props.disabled).toBe(true);
    expect(screen.findAllByTestId('work.capacity')[0]?.props.disabled).toBe(true);
    expect(sent).toHaveLength(0);
  });
  it('shows an own queued run from its canonical phase facts, never as running on an acceptance clock', async () => {
    const { screen, getReader } = await setup({ mounted: true });
    try {
    const scope = storage.getState().profileScope;
    if (!scope || !fixture) throw new Error('expected_scope');
    const { actionOperationStore } =
      await import('@/sync/domains/actionOperations/actionOperationStore');
    await act(async () =>
      actionOperationStore.mergeSnapshots({
        serverId: fixture!.home.id,
        snapshots: [
          {
            version: 1,
            operationId: 'own-1',
            revision: 1,
            actionId: 'projects.script.run',
            state: 'accepted',
            scope: { accountId: scope.accountId, machineId: 'm1' },
            title: 'test',
            createdAt: Date.now() - 95_000,
            progress: { kind: 'phase', phase: 'queued', queueAhead: 2 },
            domainRef: {
              kind: 'projectCommand',
              purpose: 'script',
              serverId: fixture!.home.id,
              machineId: 'm1',
              workspaceRefId: 'w1',
              cwd: '/repo',
              script: { name: 'test' },
              sourceWorkspace: {
                serverId: fixture!.home.id,
                workspaceId: 'w1',
                machineId: 'source-machine',
                rootPath: '/repo',
              },
            },
            cancellation: 'supported',
          } as never,
        ],
      }),
    );
    const row = () =>
      screen
        .findAllByTestId('work.running:own-1')
        .find((node) => typeof node.props.title === 'string');
    await vi.waitFor(() => expect(row()?.props.title).toBe('test'));
    const subtitle = String(row()?.props.subtitle);
    expect(subtitle).toContain('projectWorkers.queuedOn');
    expect(subtitle).toContain('projectWorkers.ahead');
    // Accepted is not launched: no elapsed clock before a terminal exists.
    expect(subtitle).not.toMatch(/\d:\d\d/);
    const reader = getReader();
    expect(reader.readCurrentUiContext()!.commands.map(row => row.title)).toEqual(['projectWorkers.manageInSync', 'projectWorkers.open: test']);
    const rowCommand = reader.readCurrentUiContext()!.commands[1]!;
    const resolved = reader.resolveCurrentUiCommand(rowCommand.id)!;
    if (resolved.command.kind !== 'hostLocal') throw new Error('expected_local');
    const command = resolved.command;
    vi.mocked(Modal.show).mockClear();
    await act(async () => { await command.invoke({ signal: resolved.retirementSignal, context: { surface: 'agent' } }); });
    await vi.waitFor(() => expect(Modal.show).toHaveBeenCalled());
    expect(vi.mocked(Modal.show).mock.lastCall?.[0].props).toMatchObject({ operationId: 'own-1' });
    vi.mocked(Modal.show).mockClear();
    await screen.pressByTestIdAsync('work.running:own-1.open');
    await vi.waitFor(() => expect(Modal.show).toHaveBeenCalled());
    expect(vi.mocked(Modal.show).mock.lastCall?.[0].props).toMatchObject({ operationId: 'own-1' });
    await screen.unmount();
    expect(reader.resolveCurrentUiCommand(rowCommand.id)).toBeNull();
    } finally {
      await screen.unmount();
      const { actionOperationStore } = await import('@/sync/domains/actionOperations/actionOperationStore');
      actionOperationStore.reset();
    }

  });

  it('says once that an unreachable Machine is not answering and takes no policy edits it cannot receive', async () => {
    const { screen, sent } = await setup();
    const { recordMachineRequestFailed, clearMachineRequestReachabilityForTest } =
      await import('@/sync/domains/machines/reachability/machineReachability');
    try {
      expect(screen.getTextContent()).not.toContain('settingsOverview.machineUnreachableFromHome');
      const scope = storage.getState().profileScope;
      if (!scope || scope.serverId !== fixture!.home.id) throw new Error('expected_current_machine_account_scope');
      await act(async () => recordMachineRequestFailed({ ...scope, machineId: 'm1' }));
      expect(screen.getTextContent()).toContain('settingsOverview.machineUnreachableFromHome');
      // Whether it takes new work cannot be true or false while it is offline: no Accept new work switch.
      expect(screen.findAllByTestId('work.accepting')).toHaveLength(0);
      expect(screen.findAllByTestId('work.accepting.switch')).toHaveLength(0);
      expect(screen.findAllByTestId('work.capacity.field')[0]?.props.editable).toBe(false);
      expect(sent).toHaveLength(0);
    } finally {
      clearMachineRequestReachabilityForTest();
    }
  });

  it('leaves an offline Machine to the page that already says so, and still takes no edits', async () => {
    const { screen, sent } = await setup({ announced: true });
    const { recordMachineRequestFailed, clearMachineRequestReachabilityForTest } =
      await import('@/sync/domains/machines/reachability/machineReachability');
    try {
      const scope = storage.getState().profileScope;
      if (!scope || scope.serverId !== fixture!.home.id) throw new Error('expected_current_machine_account_scope');
      await act(async () => recordMachineRequestFailed({ ...scope, machineId: 'm1' }));
      expect(screen.findAllByTestId('work.accepting')).toHaveLength(0);
      expect(screen.getTextContent()).not.toContain('settingsOverview.machineUnreachableFromHome');
      expect(sent).toHaveLength(0);
    } finally {
      clearMachineRequestReachabilityForTest();
    }
  });

  it('leaves a failed policy read on an offline Machine to the page, with no Retry that cannot answer', async () => {
    const { screen, releasePolicyRead } = await setup({ announced: true, holdPolicyRead: true });
    const { recordMachineRequestFailed, clearMachineRequestReachabilityForTest } =
      await import('@/sync/domains/machines/reachability/machineReachability');
    try {
      const scope = storage.getState().profileScope;
      if (!scope || scope.serverId !== fixture!.home.id) throw new Error('expected_current_machine_account_scope');
      machineHttp.read = () => new Response(null, { status: 503 });
      await act(async () => recordMachineRequestFailed({ ...scope, machineId: 'm1' }));
      await act(async () => { releasePolicyRead(); });
      await act(async () => { await Promise.resolve(); });
      // The page says the Machine is offline once; this section adds no cause and no dead Retry of its own.
      expect(screen.findAllByTestId('work.unavailable')).toHaveLength(0);
      expect(screen.findAllByTestId('work.accepting')).toHaveLength(0);
    } finally {
      clearMachineRequestReachabilityForTest();
    }
  });

  it('on a phone, says Run at most is loading until the policy is read, and No limit only for a read null', async () => {
    viewport.compact = true;
    const { screen, releasePolicyRead } = await setup({ holdPolicyRead: true });
    const row = () => screen.findAllByTestId('work.capacity.row')[0];
    await vi.waitFor(() => expect(row()).toBeTruthy());
    expect(row()?.props.detail).toBe('common.loading');
    await act(async () => {
      releasePolicyRead();
    });
    await vi.waitFor(() =>
      expect(row()?.props.detail).toBe('projectWorkers.noLimit'),
    );
  });

  it('names the work keeping a copy in use and an unknown file removal, and never retries by itself', async () => {
    const { screen } = await setup({ waive: ['projects.worker.copy.retire'] });
    await seedWorkerCopy();
    const retire = vi.fn(async () => ({
      ok: false,
      error: 'in_use',
      errorCode: 'workspace_sync_relationship_in_use',
      details: {
        dependencies: [
          {
            operationId: 'busy-1',
            workspaceRefId: 'fresh-target',
            state: 'running',
          },
        ],
      },
    }));
    rpc.machine.mockImplementation(async ({ method }: { method: string }) => {
      if (method === 'projects.worker.copy.retire') return await retire();
      throw new Error(`unexpected_rpc:${method}`);
    });
    const menu = () =>
      screen.findAll(
        (node) =>
          typeof node.props.onSelect === 'function' &&
          Array.isArray(node.props.items) &&
          node.props.items.some((item: { id: string }) => item.id === 'files'),
      )[0]!;
    const notice = () =>
      screen.findAllByTestId('work.copy:proven-worker-target.notice')[0]?.props;
    await vi.waitFor(() => expect(menu()).toBeTruthy());
    await act(async () => {
      menu().props.onSelect('keep');
    });
    await vi.waitFor(() =>
      expect(notice()?.title).toBe('projectWorkers.removeInUse'),
    );
    expect(notice()?.details).toEqual([
      expect.stringContaining('projectWorkers.dependencyRunning'),
    ]);
    retire.mockResolvedValueOnce({
      ok: false,
      error: 'unknown',
      errorCode: 'workspace_copy_removal_unknown',
      details: { kind: 'outcomeUnknown' },
    } as never);
    await act(async () => {
      menu().props.onSelect('keep');
    });
    await vi.waitFor(() =>
      expect(notice()?.title).toBe('projectWorkers.removeFilesUnknown'),
    );
    // Checking again only rereads; the removal is not repeated.
    await act(async () => {
      notice()?.action?.onPress();
    });
    expect(retire).toHaveBeenCalledTimes(2);
    expect(
      screen.findAllByTestId('work.copy:proven-worker-target').length,
    ).toBeGreaterThan(0);
  });

  it('offers Fresh-copy removal only for a proven worker target, never ordinary Sync or the worker SOURCE', async () => {
    const { screen } = await setup();
    const scope = storage.getState().profileScope;
    if (!scope || scope.serverId !== fixture?.home.id)
      throw new Error('expected_current_project_account_scope');
    const source = {
      id: 'fresh-source',
      serverId: scope.serverId,
      machineId: 'source-machine',
      rootPath: '/source/project',
      label: 'Original source checkout',
      createdAtMs: 1,
      projectKey: 'fresh-project',
    };
    const target = {
      id: 'fresh-target',
      serverId: scope.serverId,
      machineId: 'm1',
      rootPath: '/worker/project',
      label: 'Worker target checkout',
      createdAtMs: 1,
      projectKey: 'fresh-project',
    };
    const policy = {
      v: 1 as const,
      selection: 'git_worktree' as const,
      extraIgnorePatterns: [],
      extraIncludePatterns: [],
    };
    const ordinary: WorkspaceSyncRelationshipV1 = {
      v: 1,
      relationshipId: 'ordinary-sync',
      controllerMachineId: 'source-machine',
      alphaWorkspaceRefId: source.id,
      betaWorkspaceRefId: target.id,
      mode: 'keep_synced',
      enabled: true,
      contentPolicy: {
        ...policy,
        policyDigest: computeWorkspaceSyncPolicyDigest(policy),
      },
      createdAtMs: 1,
      updatedAtMs: 1,
    };
    const workerTarget: WorkspaceSyncRelationshipV1 = {
      ...ordinary,
      relationshipId: 'proven-worker-target',
      alphaWorkspaceRefId: target.id,
      betaWorkspaceRefId: source.id,
      provenance: {
        kind: 'worker_clean_copy',
        sourceWorkspaceRefId: source.id,
        targetWorkspaceRefId: target.id,
      },
    };
    const workerSource: WorkspaceSyncRelationshipV1 = {
      ...ordinary,
      relationshipId: 'machine-is-worker-source',
      provenance: {
        kind: 'worker_clean_copy',
        sourceWorkspaceRefId: target.id,
        targetWorkspaceRefId: source.id,
      },
    };
    await act(async () => {
      storage.getState().activateProjectAccountRowsScope(scope);
      storage.getState().setProjectAccountRowsStatusForScope(scope, 'idle');
    });
    expect(
      screen.findAllByTestId('work.copies.loading').length,
    ).toBeGreaterThan(0);
    expect(screen.findAllByTestId('work.copies.unavailable').length).toBe(0);
    expect(screen.findAllByTestId('work.copies.empty').length).toBe(0);
    await act(async () => {
      storage
        .getState()
        .applyProjectAccountRowsForScope(scope, {
          scope,
          status: 'ready',
          coverage: 'complete',
          workspaceRefs: [source, target],
          relationships: [ordinary, workerTarget, workerSource],
          organizations: [],
          revisionsByPhysicalKey: {},
        });
    });
    // Prove the real row subscription consumed the scoped fixture before testing exclusions.
    // The row component forwards its testID; the rendered list row is the one carrying a title.
    const row = () =>
      screen
        .findAllByTestId('work.copy:proven-worker-target')
        .find((node) => typeof node.props.title === 'string');
    await vi.waitFor(() => expect(row()?.props.title).toBe(source.label));
    expect(
      screen.findAllByTestId('work.copy:proven-worker-target.remove').length,
    ).toBeGreaterThan(0);
    expect(screen.findAllByTestId('work.copy:ordinary-sync').length).toBe(0);
    expect(
      screen.findAllByTestId('work.copy:machine-is-worker-source').length,
    ).toBe(0);
    // Unknown clean-sync time and size are omitted, never shown as a guessed value.
    const subtitle = String(row()?.props.subtitle);
    expect(subtitle).not.toContain('projectWorkers.copyLastSynced');
    expect(subtitle).not.toMatch(/\d/);
    // a4a360ea3cc routes explicit UI Ask through native confirmation; no Inbox replay is needed.
    let answer: ((confirmed: boolean) => void) | undefined;
    const confirm = vi.spyOn(Modal, 'confirm').mockImplementation(() => new Promise(resolve => { answer = resolve; }));
    const menu = () =>
      screen.findAll(
        (node) =>
          typeof node.props.onSelect === 'function' &&
          Array.isArray(node.props.items) &&
          node.props.items.some((item: { id: string }) => item.id === 'files'),
      )[0]!;
    expect(menu().props.items.map((item: { id: string }) => item.id)).toEqual([
      'keep',
      'files',
    ]);
    try {
      await act(async () => { menu().props.onSelect('keep'); });
      await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
      expect(screen.findAllByTestId('work.copy:proven-worker-target.notice')[0]?.props)
        .toMatchObject({ title: 'projectWorkers.saving' });
      expect(screen.findAllByTestId('work.copy:proven-worker-target.approval')).toHaveLength(0);
      // No duplicate Remove or retirement before the person answers the review.
      expect(screen.findAllByTestId('work.copy:proven-worker-target.remove')[0]?.props.disabled).toBe(true);
      expect(rpc.machine.mock.calls.filter(([input]) => input.method === 'projects.worker.copy.retire')).toHaveLength(0);
      expect(screen.findAllByTestId('work.copy:proven-worker-target').length).toBeGreaterThan(0);
    } finally {
      await act(async () => { answer?.(false); });
    }
  });

  it('keeps the files-unknown warning at section level after the retired copy disappears, until dismissed', async () => {
    const { screen } = await setup({ waive: ['projects.worker.copy.retire'] });
    const { scope, source, target } = await seedWorkerCopy();
    let retired = false;
    const retire = vi.fn(async () => {
      retired = true;
      return {
        ok: false,
        error: 'unknown',
        errorCode: 'workspace_copy_removal_unknown',
        details: { kind: 'outcomeUnknown' },
      };
    });
    rpc.machine.mockImplementation(async ({ method }: { method: string }) => {
      if (method === 'projects.worker.copy.retire') return await retire();
      if (method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_INSPECT) {
        if (retired) throw new Error('bootstrap_definition_conflict');
        return {
          ok: true,
          preview: {
            targetMachineId: 'm1',
            workspaceRefId: 'fresh-target',
            rootFingerprint: 'a'.repeat(64),
            sizeBytes: 4,
          },
        };
      }
      throw new Error(`unexpected_rpc:${method}`);
    });
    const menu = () =>
      screen.findAll(
        (node) =>
          typeof node.props.onSelect === 'function' &&
          Array.isArray(node.props.items) &&
          node.props.items.some((item: { id: string }) => item.id === 'files'),
      )[0]!;
    await vi.waitFor(() => expect(menu()).toBeTruthy());
    await act(async () => {
      menu().props.onSelect('files');
    });
    await vi.waitFor(() => expect(retire).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(
        screen.findAllByTestId('work.copy:proven-worker-target.notice')[0]
          ?.props.title,
      ).toBe('projectWorkers.removeFilesUnknown'),
    );
    await act(async () => {
      storage
        .getState()
        .applyProjectAccountRowsForScope(scope, {
          scope,
          status: 'ready',
          coverage: 'complete',
          workspaceRefs: [source, target],
          relationships: [],
          organizations: [],
          revisionsByPhysicalKey: {},
        });
    });
    const notice = () =>
      screen.findAllByTestId('work.copies.notice:proven-worker-target')[0]
        ?.props;
    await vi.waitFor(() =>
      expect(notice()?.title).toBe('projectWorkers.copyDefinitionRetired'),
    );
    expect(notice()?.description).toBe('projectWorkers.removeFilesUnknown');
    expect(notice()?.points).toEqual([[{ code: '/worker/project' }]]);
    expect(screen.findAllByTestId('work.copy:proven-worker-target')).toEqual(
      [],
    );
    await act(async () => {
      notice()?.action?.onPress();
    });
    expect(retire).toHaveBeenCalledTimes(1);
    // Unavailable census is not fresh proof of definition retirement; retain the captured warning.
    await act(async () => {
      storage.getState().setProjectAccountRowsStatusForScope(scope, 'locked');
    });
    expect(notice()?.title).toBe('projectWorkers.removeFilesUnknown');
    expect(notice()?.points).toEqual([[{ code: '/worker/project' }]]);
    await act(async () => {
      storage.getState().setProjectAccountRowsStatusForScope(scope, 'ready');
    });
    await act(async () => {
      notice()?.onDismiss();
    });
    expect(
      screen.findAllByTestId('work.copies.notice:proven-worker-target'),
    ).toEqual([]);
    expect(screen.findAllByTestId('work.copies.empty').length).toBeGreaterThan(
      0,
    );
  });

  it('retains the real daemon stopped-Machine receipt after native confirmation and the pushed row removal', async () => {
    const { screen } = await setup({ machineId: 'target-parent', machineName: 'Stopped copy Machine' });
    const { scope, source, target } = await seedWorkerCopy('target-parent');
    await act(async () => {
      const machine = createHydratedPlainMachineFixture({ id: 'target-parent', accountId: scope.accountId,
        machine: { active: false } });
      storage.getState().applyMachines([{ ...machine, metadata: { ...machine.metadata!, displayName: 'Stopped copy Machine' } }]);
    });
    let answer: ((confirmed: boolean) => void) | undefined;
    const confirm = vi.spyOn(Modal, 'confirm').mockImplementation(() => new Promise(resolve => { answer = resolve; }));
    const retire = vi.fn(async () => {
      // Home's graph push can beat the Action settlement to this client.
      storage.getState().applyProjectAccountRowsForScope(scope, { scope, status: 'ready', coverage: 'complete',
        workspaceRefs: [source, target], relationships: [], organizations: [], revisionsByPhysicalKey: {} });
      return offlineRetireReceipt.ok && 'result' in offlineRetireReceipt ? offlineRetireReceipt.result : offlineRetireReceipt;
    });
    rpc.machine.mockImplementation(async ({ method }: { method: string }) => {
      if (method === 'projects.worker.copy.retire') return await retire();
      throw new Error(`unexpected_rpc:${method}`);
    });
    const menu = () => screen.findAll(node => typeof node.props.onSelect === 'function'
      && Array.isArray(node.props.items) && node.props.items.some((item: { id: string }) => item.id === 'files'))[0]!;
    await vi.waitFor(() => expect(menu()).toBeTruthy());
    await act(async () => { menu().props.onSelect('keep'); });
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(retire).not.toHaveBeenCalled();
    await act(async () => { answer?.(true); });
    const notice = () => screen.findAllByTestId('work.copies.notice:proven-worker-target')
      .find(node => typeof node.props.title === 'string')?.props;
    await vi.waitFor(() => expect(retire).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(notice()?.description).toBe('projectWorkers.removeUnchecked(Stopped copy Machine)'));
    expect(screen.findAllByTestId('work.copy:proven-worker-target').length).toBe(0);
    await act(async () => { notice()?.onDismiss(); });
    expect(screen.findAllByTestId('work.copies.notice:proven-worker-target').length).toBe(0);
  });

  it('a removal that asked every Machine leaves no notice behind', async () => {
    const { screen } = await setup({ waive: ['projects.worker.copy.retire'] });
    await seedWorkerCopy();
    rpc.machine.mockImplementation(async ({ method }: { method: string }) => {
      if (method === 'projects.worker.copy.retire') return { status: 'retired' };
      throw new Error(`unexpected_rpc:${method}`);
    });
    const menu = () =>
      screen.findAll(
        (node) =>
          typeof node.props.onSelect === 'function' &&
          Array.isArray(node.props.items) &&
          node.props.items.some((item: { id: string }) => item.id === 'files'),
      )[0]!;
    await vi.waitFor(() => expect(menu()).toBeTruthy());
    await act(async () => {
      menu().props.onSelect('keep');
    });
    await vi.waitFor(() => expect(String(screen.findAllByTestId('work.copy:proven-worker-target.notice')[0]?.props.title
      ?? screen.findAllByTestId('work.copy:proven-worker-target').length)).toBe('0'));
    expect(screen.findAllByTestId('work.copies.notice:proven-worker-target').length).toBe(0);
  });

  it('says why a refused removal kept the copy, with the code and phase under Technical details', async () => {
    const { screen, getReader } = await setup({ waive: ['projects.worker.copy.retire'], mounted: true });
    try {
    await seedWorkerCopy();
    rpc.machine.mockImplementation(async ({ method }: { method: string }) => {
      if (method === 'projects.worker.copy.retire') return {
        ok: false, error: 'Worker dependency observation is unavailable', errorCode: 'workspace_sync_dependencies_unavailable',
        requestId: 'copy-removal-refusal', effectAttempted: false,
        failureCause: { phase: 'workspace_sync.retirement.dependencies', errorClass: 'Error',
          errorCode: 'workspace_sync_dependencies_unavailable', httpStatus: null, nativeErrorCode: 'RPC_FORBIDDEN', nativeErrorReason: 'custodian_only' },
      };
      throw new Error(`unexpected_rpc:${method}`);
    });
    const menu = () =>
      screen.findAll(
        (node) =>
          typeof node.props?.onSelect === 'function' &&
          Array.isArray(node.props.items) &&
          node.props.items.some((item: { id: string }) => item.id === 'files'),
      )[0]!;
    await vi.waitFor(() => expect(menu()).toBeTruthy());
    await act(async () => {
      menu().props.onSelect('keep');
    });
    const notice = () =>
      screen.findAllByTestId('work.copy:proven-worker-target.notice')[0]?.props;
    await vi.waitFor(() => expect(notice()?.title).toBe('projectWorkers.removeFailed'));
    expect(notice()?.description).toBe('workspaceSync.error.dependenciesUnavailable');
    const alert = vi.spyOn(Modal, 'alert');
    await act(async () => {
      notice()?.secondaryAction?.onPress();
    });
    expect(alert).toHaveBeenCalledWith('approvals.technicalDetails', expect.stringContaining('workspace_sync_dependencies_unavailable'));
    expect(alert).toHaveBeenCalledWith('approvals.technicalDetails', expect.stringContaining('workspace_sync.retirement.dependencies'));
    expect(alert).toHaveBeenCalledWith('approvals.technicalDetails', expect.stringContaining('approvals.failureTechnicalLabels.requestId:'));
    expect(alert).toHaveBeenCalledWith('approvals.technicalDetails', expect.stringContaining('RPC_FORBIDDEN'));
    expect(alert).toHaveBeenCalledWith('approvals.technicalDetails', expect.stringContaining('custodian_only'));
    expect(alert).toHaveBeenCalledWith('approvals.technicalDetails', expect.stringContaining('approvals.failureTechnicalLabels.effectAttempted: false'));
    expect(screen.findAllByTestId('work.copy:proven-worker-target').length).toBeGreaterThan(0);
    const reader = getReader();
    expect(reader.readCurrentUiContext()!.commands.map(row => row.title)).toEqual([
      'projectWorkers.manageInSync', 'approvals.technicalDetails: proven-worker-target',
    ]);
    const details = reader.readCurrentUiContext()!.commands.find(row => row.title.startsWith('approvals.technicalDetails:'))!;
    const resolved = reader.resolveCurrentUiCommand(details.id)!;
    if (resolved.command.kind !== 'hostLocal') throw new Error('expected_local');
    const command = resolved.command;
    alert.mockClear();
    await act(async () => { await command.invoke({ signal: resolved.retirementSignal, context: { surface: 'agent' } }); });
    expect(alert).toHaveBeenCalledWith('approvals.technicalDetails', expect.stringContaining('workspace_sync_dependencies_unavailable'));
    await screen.unmount();
    expect(reader.resolveCurrentUiCommand(details.id)).toBeNull();
    } finally { await screen.unmount(); }

  });

  it.each([
    ['machine_stopped', true, 'errors.machineStoppedNamed(Studio Mac)'],
    ['machine_suspended', true, 'errors.machineSuspendedNamed(Studio Mac)'],
    ['machine_offline', true, 'errors.machineNotAnsweringNamed(Studio Mac)'],
    ['machine_stopped', false, 'errors.machineStopped'],
  ] as const)('says the controlling Machine is %s when Remove is refused (controller known: %s)', async (reason, known, sentence) => {
    const { screen } = await setup({ waive: ['projects.worker.copy.retire'] });
    const { scope } = await seedWorkerCopy();
    if (known) await act(async () => {
      const controller = createHydratedPlainMachineFixture({ id: 'source-machine', accountId: scope.accountId, machine: { active: false } });
      storage.getState().applyMachines([{ ...controller, metadata: { ...controller.metadata!, displayName: 'Studio Mac' } }]);
    });
    rpc.machine.mockImplementation(async ({ method }: { method: string }) => {
      if (method === 'projects.worker.copy.retire') return { ok: false, error: 'target_unavailable', errorCode: 'target_unavailable',
        details: { reason, requiredFact: 'machine_online', remedy: 'reconnect_machine' } };
      throw new Error(`unexpected_rpc:${method}`);
    });
    const menu = () => screen.findAll(node => typeof node.props.onSelect === 'function'
      && Array.isArray(node.props.items) && node.props.items.some((item: { id: string }) => item.id === 'files'))[0]!;
    await vi.waitFor(() => expect(menu()).toBeTruthy());
    await act(async () => { menu().props.onSelect('keep'); });
    const notice = () => screen.findAllByTestId('work.copy:proven-worker-target.notice')[0]?.props;
    await vi.waitFor(() => expect(notice()?.title).toBe('projectWorkers.removeFailed'));
    expect(notice()?.description).toBe(sentence);
    expect(screen.findAllByTestId('work.copy:proven-worker-target').length).toBeGreaterThan(0);
  });

  it('keeps the recorded refusal under Technical details when an approved removal leaves the copy in place', async () => {
    const { screen, decideCopyApproval } = await setup({ waive: ['projects.worker.copy.retire'], copyCheck: true });
    const { scope } = await seedWorkerCopy();
    const retire = vi.fn(async () => ({
      ok: false, error: 'Worker dependency observation is unavailable', errorCode: 'workspace_sync_dependencies_unavailable',
      effectAttempted: false,
      failureCause: { phase: 'workspace_sync.retirement.dependencies', errorClass: 'Error',
        errorCode: 'workspace_sync_dependencies_unavailable', httpStatus: null, nativeErrorCode: 'RPC_FORBIDDEN', nativeErrorReason: 'custodian_only' },
    }));
    rpc.machine.mockImplementation(async ({ method }: { method: string }) => {
      if (method === 'projects.worker.copy.retire') return await retire();
      throw new Error(`unexpected_rpc:${method}`);
    });
    const menu = () => screen.findAll(node => typeof node.props.onSelect === 'function'
      && Array.isArray(node.props.items) && node.props.items.some((item: { id: string }) => item.id === 'files'))[0];
    await vi.waitFor(() => expect(menu()).toBeTruthy());
    await act(async () => { menu()!.props.onSelect('keep'); });
    const home = fixture!;
    await vi.waitFor(() => expect(home.boundary.list()).toHaveLength(1));
    const artifactId = home.boundary.list()[0]!.id;
    const stored = () => ApprovalRequestV2Schema.parse(JSON.parse(home.boundary.readPlainBody(artifactId) ?? 'null'));
    const original = stored();
    expect(original).toMatchObject({ status: 'open', automaticChecks: { phase: 'consent', humanApprovalRequired: false,
      consents: [{ automationId: 'copy-check', triggerId: 'before-removal', decision: 'pending' }] } });
    expect(retire).not.toHaveBeenCalled();

    // Spend the decision on the same receiver that issued the approval.
    // Artifact reads and writes still cross the real Home HTTP client.
    const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
    const result = await decideCopyApproval(artifactId);
    expect(result).toMatchObject({ ok: true, result: { status: 'failed' } });
    const receipt = stored();
    expect(receipt).toMatchObject({ status: 'failed', execution: { ok: false,
      errorCode: 'workspace_sync_dependencies_unavailable', effectAttempted: false,
      requestId: original.executionOriginV1.requestId, failureCause: { phase: 'workspace_sync.retirement.dependencies' } } });
    expect(retire).toHaveBeenCalledTimes(1);
    await act(async () => { publishHomeAccountChange(scope.serverId, [artifactId]); });
    const notice = () => screen.findAllByTestId('work.copy:proven-worker-target.notice')[0]?.props;
    await vi.waitFor(() => expect(notice()?.title).toBe('projectWorkers.removeFailed'));
    expect(notice()?.description).toBe('workspaceSync.error.dependenciesUnavailable');
    const alert = vi.spyOn(Modal, 'alert');
    await act(async () => { notice()?.secondaryAction?.onPress(); });
    expect(alert).toHaveBeenCalledWith('approvals.technicalDetails', expect.stringContaining('workspace_sync.retirement.dependencies'));
    expect(alert).toHaveBeenCalledWith('approvals.technicalDetails', expect.stringContaining(original.executionOriginV1.requestId));
    expect(alert).toHaveBeenCalledWith('approvals.technicalDetails', expect.stringContaining('approvals.failureTechnicalLabels.effectAttempted: false'));
    expect(screen.findAllByTestId('work.copy:proven-worker-target').length).toBeGreaterThan(0);
  });

  it('keeps an asleep Machine out of the Project-read failure and retry state', async () => {
    const { screen } = await setup({ deferMachineDiscovery: true });
    const scope = storage.getState().profileScope!;
    const machine = createMachineFixture({ id: 'm1' });
    await act(async () => {
      storage.getState().activateProjectAccountRowsScope(scope);
      storage.getState().setProjectAccountRowsStatusForScope(scope, 'error');
      storage.getState().applyMachines([{ ...machine, active: false, activeAt: Date.UTC(2026, 10, 18, 12, 18),
        managedInputRuntime: { nativeReady: false, wakeState: null, state: 'asleep', asleepWake: 'off' } }]);
    });
    const asleep = screen.findAllByTestId('work.copies.asleep')[0];
    expect(asleep).toBeDefined();
    expect(asleep?.props.action).toBeUndefined();
    expect(screen.findAllByTestId('work.copies.unavailable')).toHaveLength(0);
  });

  it('keeps usable Fresh copies beside an incomplete relationship and skips foreign-Home history', async () => {
    const { screen } = await setup();
    const { scope, source, target } = await seedWorkerCopy();
    const rows = storage.getState().projectAccountRows!;
    const worker = rows.relationships[0]!;
    const unresolved: WorkspaceSyncRelationshipV1 = { ...worker, relationshipId: 'old-copy',
      alphaWorkspaceRefId: 'old-target', betaWorkspaceRefId: source.id,
      provenance: { kind: 'worker_clean_copy', sourceWorkspaceRefId: source.id, targetWorkspaceRefId: 'old-target' } };
    await act(async () => {
      storage.getState().applyProjectAccountRowsForScope(scope, { ...rows, relationships: [unresolved, worker] });
    });
    expect(screen.findAllByTestId('work.copy:proven-worker-target').length).toBeGreaterThan(0);
    expect(screen.findAllByTestId('work.copies.unavailable').length).toBeGreaterThan(0);
    expect(screen.findAllByTestId('work.copies.empty')).toHaveLength(0);
    await act(async () => {
      storage.getState().applyProjectAccountRowsForScope(scope, { ...rows, relationships: [unresolved, worker],
        workspaceRefs: [...rows.workspaceRefs, { ...target, id: 'old-target', serverId: 'previous-home' }] });
    });
    expect(screen.findAllByTestId('work.copy:proven-worker-target').length).toBeGreaterThan(0);
    expect(screen.findAllByTestId('work.copies.unavailable')).toHaveLength(0);
  });

  it('Check again rereads partial Project rows once and shows the recovered copies', async () => {
    const { screen } = await setup({ deferMachineDiscovery: true });
    const { scope } = await seedWorkerCopy();
    const rows = storage.getState().projectAccountRows!;
    const body = createPlainProjectAccountRowListFixture({ workspaceRefs: rows.workspaceRefs, relationships: rows.relationships });
    await act(async () => {
      storage.getState().applyProjectAccountRowsForScope(scope, { ...rows, coverage: 'partial' });
    });
    const unavailable = () => screen.findAllByTestId('work.copies.unavailable')[0]?.props;
    expect(unavailable()?.action).toBeDefined();
    let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    projectRowsRead = async () => { await held; return Response.json(body); };
    const reads = () => fixture!.requests.filter(request => request.path === '/v1/account/project-rows/list').length;
    const before = reads();
    try {
      await act(async () => { screen.pressByTestId('work.copies.unavailable-action'); });
      await vi.waitFor(() => expect(reads()).toBe(before + 1));
      expect(screen.findHostByTestId('work.copies.unavailable-action')?.props.accessibilityState).toMatchObject({ busy: true, disabled: true });
      // A second press while the network read is held cannot start another census.
      await act(async () => { screen.pressByTestId('work.copies.unavailable-action'); });
      expect(reads()).toBe(before + 1);
    } finally { release(); }
    await act(async () => { await vi.waitFor(() => expect(screen.findAllByTestId('work.copy:proven-worker-target').length).toBeGreaterThan(0)); });
    expect(screen.findAllByTestId('work.copies.unavailable')).toHaveLength(0);
    expect(reads()).toBe(before + 1);
  });

  it('does not claim Fresh-copy emptiness when the current Account/Home row observation is unavailable', async () => {
    const { screen } = await setup();
    const scope = storage.getState().profileScope;
    if (!scope || scope.serverId !== fixture?.home.id)
      throw new Error('expected_current_project_account_scope');
    await act(async () => {
      storage.getState().activateProjectAccountRowsScope(scope);
      storage
        .getState()
        .applyProjectAccountRowsForScope(scope, {
          scope,
          status: 'ready',
          coverage: 'complete',
          workspaceRefs: [],
          relationships: [],
          organizations: [],
          revisionsByPhysicalKey: {},
        });
    });
    expect(screen.findAllByTestId('work.copies.empty').length).toBeGreaterThan(
      0,
    );
    expect(screen.findAllByTestId('work.copies.loading').length).toBe(0);
    await act(async () => {
      storage.getState().setProjectAccountRowsStatusForScope(scope, 'locked');
    });
    expect(screen.findAllByTestId('work.copies.empty').length).toBe(0);
    expect(
      screen.findAllByTestId('work.copies.unavailable').length,
    ).toBeGreaterThan(0);
    // An unknown census offers its recovery in place; it never reads as "no copies".
    expect(
      screen.findAllByTestId('work.copies.unavailable')[0]?.props.action?.label,
    ).toBe('projectWorkers.checkAgain');
    expect(screen.findAllByTestId('work.accepting').length).toBeGreaterThan(0);
  });

  it('refuses a non-positive Run at most without writing, and No limit clears the ceiling', async () => {
    const { screen, sent } = await setup();
    const capacity = () => screen.findAllByTestId('work.capacity')[0]!;
    await act(async () => {
      capacity().props.onCommit('0');
    });
    expect(capacity().props.error).toBe('projectWorkers.capacityInvalid');
    expect(sent).toEqual([]);
    await act(async () => {
      capacity().props.onDraftChange('3');
      capacity().props.onCommit('3');
    });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({
      finitePolicyV1: { accepting: true, runAtMost: 3 },
    });
    expect(capacity().props.error).toBeNull();
    await vi.waitFor(() => expect(capacity().props.value).toBe('3'));
    await act(async () => {
      capacity().props.onCommit('');
    });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toMatchObject({
      finitePolicyV1: { accepting: true, runAtMost: null },
    });
  });

  it('turns off new work only, keeping the ceiling, and says what that means now', async () => {
    const { screen, sent } = await setup();
    await act(async () => {
      screen
        .findAllByTestId('work.accepting.switch')[0]
        ?.props.onValueChange(false);
    });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({
      finitePolicyV1: { accepting: false, runAtMost: null },
    });
    await vi.waitFor(() =>
      expect(
        String(screen.findAllByTestId('work.accepting')[0]?.props.subtitle),
      ).toContain('projectWorkers.notAccepting'),
    );
  });
});
