import * as fs from 'node:fs';
import * as path from 'node:path';

import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ActionOperationSnapshotV1,
} from '@happier-dev/protocol/actions/operations/v1';
import type { FrontDoorRuntimeActionExecute as RuntimeActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { createFrontDoorRuntimeActionExecutor } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import type { ProjectSetupConsentFailureDetailsV1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { ACTION_OPERATION_RPC_METHODS_V2 } from '@happier-dev/protocol/actions/operations/v1';
import { buildLocalServiceInventoryRow, buildLocalServiceInventoryState } from '@/dev/testkit/fixtures/localServices';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import {
  pressTestInstanceAsync,
  renderScreen,
} from '@/dev/testkit/render/renderScreen';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
  waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import {
  createUiApprovalRequest,
  decideApprovalAsInbox,
} from '@/dev/testkit/harness/approvalInbox';
import type { LocalServiceLaunchTarget } from '@/sync/domains/local/services/launch';
import { LocalServiceInventorySnapshotV1Schema } from '@happier-dev/protocol/local/services/inventory/v1';
import { LocalServiceLaunchTargetV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

// Genuine credential/HTTP boundaries are installed before importing the mounted
// host. Its credential lifetime, row projection and Action admission stay real.
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const operationMachineRpc = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc');
const { storage } = await import('@/sync/domains/state/storage');
const { resetLocalServiceInventoryStoreForTests } =
  await import('@/sync/domains/local/services/inventory/sharedStore');
const { resetLocalServiceLauncherStoreForTests } =
  await import('@/sync/domains/local/services/launch/sharedStore');
const { applyLocalServiceLauncherSnapshot, createLocalServiceLauncherState } =
  await import('@/sync/domains/local/services/launch');
const { ItemRowActions } = await import('@/components/ui/lists/ItemRowActions');
const { LocalServicesSurfaceHost } = await import('./LocalServicesSurfaceHost');

/** The Home Project and daemon runtime transports share this fixture; admission stays real. */
function createRuntimeBoundary(transport: RuntimeActionExecute) {
  return createFrontDoorRuntimeActionExecutor(createActionExecutor(createActionExecutorBoundaryFixture({
    isActionApprovalRequired: () => false,
    projectAction: ({ actionId, input, context }) => transport({ actionId, input, context }),
    runtimeActionExecute: transport,
  })));
}

const pluginProjectionState = vi.hoisted(() => ({
  appShell: {
    pluginUiProjection: null as unknown,
    machineId: 'machine-global' as string | null,
    serverId: 'server-global' as string | null,
    platform: 'web' as const,
  },
  scoped: {
    pluginUiProjection: null as unknown,
    machineId: 'machine-a' as string | null,
    serverId: 'server-a' as string | null,
    platform: 'web' as const,
  },
  scopedInputs: [] as unknown[],
  stackProps: [] as Record<string, unknown>[],
}));

vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  return createModalModuleMock({ confirmResult: true }).module;
});

vi.mock('@/components/appShell/plugins/AppShellPluginUiProjection', () => ({
  useAppShellPluginUiProjection: () => pluginProjectionState.appShell,
}));

vi.mock('@/components/plugins/projection/useScopedPluginUiProjection', () => ({
  useScopedPluginUiProjection: (params: unknown) => {
    pluginProjectionState.scopedInputs.push(params);
    return pluginProjectionState.scoped;
  },
}));

vi.mock('@/components/plugins/surfaces', () => ({
  PluginSurfacePlacementStack: (props: Record<string, unknown>) => {
    pluginProjectionState.stackProps.push(props);
    return React.createElement('PluginSurfacePlacementStackStub', {
      ...props,
      testID: props.testID,
    });
  },
}));

const openableTarget: LocalServiceLaunchTarget = {
  id: 'inventory:host-feed',
  source: 'inventory_entry',
  sourceClass: { kind: 'inventory_entry', inventoryEntryId: 'host-feed' },
  machineId: 'machine-a',
  sessionId: 'session-a',
  title: 'Host feed preview',
  subtitle: 'localhost:5173',
  confidence: 'high',
  state: 'available',
  actions: ['open_preview', 'register_preview'],
  browserTarget: {
    kind: 'localServicePreview',
    targetId: 'preview-host',
    sessionId: 'session-a',
    machineId: 'machine-a',
  },
};

function buildLauncherState() {
  return applyLocalServiceLauncherSnapshot(createLocalServiceLauncherState(), {
    v: 1,
    machineId: 'machine-a',
    sessionId: 'session-a',
    updatedAt: 3_000,
    targets: [openableTarget],
  });
}

describe('LocalServicesSurfaceHost', () => {
  it('requests This workspace from the canonical Session root', async () => {
    const serverId = await home.addHome({ name: 'Workspace services', serverUrl: 'https://workspace-services.test', accountId: 'account', currentAccount: true });
    const { createSessionFixture, createMachineFixture } = await import('@/dev/testkit');
    const previous = storage.getState();
    const machine = createMachineFixture({ id: 'machine-a' });
    storage.setState({ sessions: { 'session-a': createSessionFixture({ id: 'session-a', serverId,
      metadata: { machineId: 'machine-a', path: '/repo/session-checkout', host: 'devbox', homeDir: '/home/person' } }) },
      machines: { 'machine-a': machine }, machineListByServerId: { [serverId]: [machine] } });
    const roots: unknown[] = [];
    const launcherSnapshotClient: import('@/sync/domains/local/services/launch').LocalServiceLauncherSnapshotClient = async input => {
      roots.push(input.workspaceRoot);
      return { ok: true, snapshot: { v: 1, machineId: 'machine-a', updatedAt: 3000, targets: input.workspaceRoot === '/repo/session-checkout'
        ? [{ ...openableTarget, title: 'Session workspace service' }] : [{ ...openableTarget, title: 'Foreign workspace service' }] } };
    };
    const inventorySnapshotClient: import('@/sync/domains/local/services/inventory/useLocalServiceInventoryState').LocalServiceInventorySnapshotClient = async () => ({ ok: true,
      snapshot: { v: 1, machineId: 'machine-a', generatedAt: 1000, refreshState: 'idle', entries: [], diagnostics: [] } });
    const screen = await renderScreen(<LocalServicesSurfaceHost machineId="machine-a" serverId={serverId} sessionId="session-a"
      scope="workspace" launcherSnapshotClient={launcherSnapshotClient} inventorySnapshotClient={inventorySnapshotClient} testID="workspace-scope" />);
    try {
      await waitForHomeGovernance(() => expect(roots.length).toBeGreaterThan(0));
      expect(roots[0]).toBe('/repo/session-checkout');
      expect(screen.getTextContent()).toContain('Session workspace service');
      expect(screen.getTextContent()).not.toContain('Foreign workspace service');
    } finally { await screen.unmount(); storage.setState(previous, true); }
  });
  beforeEach(async () => {
    await home.reset();
    pluginProjectionState.appShell = {
      pluginUiProjection: null,
      machineId: 'machine-global',
      serverId: 'server-global',
      platform: 'web',
    };
    pluginProjectionState.scoped = {
      pluginUiProjection: null,
      machineId: 'machine-a',
      serverId: 'server-a',
      platform: 'web',
    };
    pluginProjectionState.scopedInputs = [];
    pluginProjectionState.stackProps = [];
    resetLocalServiceInventoryStoreForTests();
    resetLocalServiceLauncherStoreForTests();
  });

  afterEach(async () => {
    actionOperationStore.reset();
    resetLocalServiceInventoryStoreForTests();
    resetLocalServiceLauncherStoreForTests();
    await home.reset();
  });

  it('finishes Start after closing its issuing pane before Action admission completes and pushes Running to the reopened pane', async () => {
    const serverId = await home.addHome({ name: 'Start custody', serverUrl: 'https://start-custody.test',
      accountId: 'initiating-account', currentAccount: true });
    const { createDeferred } = await import('@/dev/testkit');
    const admission = createDeferred<void>();
    const native = createDeferred<void>();
    let running = false;
    let starts = 0;
    let push: (() => void) | undefined;
    const target: LocalServiceLaunchTarget = { id: 'managed:web', source: 'managed_service',
      sourceClass: { kind: 'managed_service', managedServiceId: 'web' }, machineId: 'machine-a',
      sessionId: 'session-a', title: 'Web', confidence: 'high', state: 'available',
      serviceState: 'stopped', actions: ['start'] };
    const snapshot = () => ({ v: 1, machineId: 'machine-a', sessionId: 'session-a', updatedAt: running ? 2_000 : 1_000,
      targets: [{ ...target, serviceState: running ? 'running' : 'stopped' }] });
    const inventory = () => ({ v: 1, machineId: 'machine-a', generatedAt: running ? 2_000 : 1_000,
      refreshState: 'idle', entries: [], diagnostics: [] });
    const rpc = vi.spyOn(operationMachineRpc, 'machineRpcWithServerScope').mockImplementation(async <Response,>(request: Parameters<typeof operationMachineRpc.machineRpcWithServerScope>[0]) => {
      let response: unknown;
      if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START) {
        starts++;
        await native.promise;
        running = true;
        push?.();
        response = { protocolVersion: 1, machineId: 'machine-a', targetId: target.id, status: 'succeeded', snapshot: snapshot() };
      } else if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH) {
        return await new Promise<Response>((resolve, reject) => {
          push = () => resolve({ protocolVersion: 1, changed: true, snapshot: inventory() } as Response);
          request.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        });
      } else if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH) {
        response = { protocolVersion: 1, snapshot: inventory() };
      } else if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT) {
        response = { protocolVersion: 1, snapshot: snapshot() };
      } else throw new Error(`Unexpected RPC ${request.method}`);
      return response as Response;
    });
    const render = () => renderScreen(<LocalServicesSurfaceHost machineId="machine-a" serverId={serverId}
      sessionId="session-a" testID="start-custody" />);
    try {
      const first = await render();
      await waitForHomeGovernance(() => expect(first.findByTestId('start-custody-row:managed:web-start')).toBeTruthy());
      home.answer(serverId, '/v2/account/settings', { respondAfter: admission.promise, body: { version: 1, content: { t: 'plain', v: {
        actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'localServices.launcher.start': ['ui'] } },
      } } } });
      const before = home.requests.filter(request => request.path === '/v2/account/settings').length;
      act(() => first.pressByTestId('start-custody-row:managed:web-start'));
      await waitForHomeGovernance(() => expect(home.requests.filter(request => request.path === '/v2/account/settings').length).toBeGreaterThan(before));
      expect(first.getTextContent()).toContain('Starting');
      expect(starts).toBe(0);
      act(() => first.tree.unmount());
      const reopened = await render();
      admission.resolve();
      await waitForHomeGovernance(() => expect(starts).toBe(1));
      native.resolve();
      await waitForHomeGovernance(() => expect(reopened.getTextContent()).toContain('Running'));
      expect(starts).toBe(1);
    } finally { admission.resolve(); native.resolve(); rpc.mockRestore(); }
  });

  it('recovers a failed inventory read and retired watch through the mounted Services Retry action', async () => {
    const serverId = await home.addHome({ name: 'Services Recovery Home', serverUrl: 'https://services-recovery.test',
      accountId: 'initiating-account', currentAccount: true });
    const snapshot = LocalServiceInventorySnapshotV1Schema.parse({ v: 1, machineId: 'machine-a', generatedAt: 123,
      refreshState: 'idle', entries: [], diagnostics: [] });
    const startedTarget = LocalServiceLaunchTargetV1Schema.parse({ ...openableTarget,
      id: 'inventory:inventory-1', source: 'inventory_entry', subtitle: 'localhost:5173',
      sourceClass: { kind: 'inventory_entry', inventoryEntryId: 'inventory-1' } });
    let scans = 0;
    let newServiceObserved = false;
    let deliverNext: ((next: typeof snapshot) => void) | undefined;
    let boundaryAvailable = false;
    const rpc = vi.spyOn(operationMachineRpc, 'machineRpcWithServerScope').mockImplementation(async <Response,>(request: Parameters<typeof operationMachineRpc.machineRpcWithServerScope>[0]) => {
      let response: unknown;
      if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH) {
        if (!boundaryAvailable) throw new Error('inventory transport unavailable');
        return await new Promise<Response>((resolve, reject) => {
          deliverNext = next => {
            // A genuine daemon watch response enters the real strict consumer.
            newServiceObserved = true;
            resolve({ protocolVersion: 1, changed: true, snapshot: next } as Response);
          };
          request.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        });
      }
      if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH
        || request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_SNAPSHOT) {
        scans++;
        if (!boundaryAvailable) throw new Error('inventory transport unavailable');
        response = { protocolVersion: 1, snapshot };
      } else if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT) {
        // Launcher projection is the real row producer; inventory only enriches it.
        response = { protocolVersion: 1, snapshot: { v: 1, machineId: 'machine-a', updatedAt: newServiceObserved ? 124 : 123,
          targets: newServiceObserved ? [startedTarget] : [] } };
      } else throw new Error(`Unexpected RPC ${request.method}`);
      // The genuine daemon transport emits unknown replies; real owners validate them.
      return response as Response;
    });
    const screen = await renderScreen(<LocalServicesSurfaceHost machineId="machine-a" serverId={serverId} scope="machine" testID="services-recovery" />);
    try {
      await waitForHomeGovernance(() => screen.findByTestId('services-recovery-error'));
      expect(scans).toBeGreaterThan(0);
      expect(deliverNext).toBeUndefined();
      boundaryAvailable = true;
      await pressTestInstanceAsync(screen.findByTestId('services-recovery-error-action'), 'services-recovery-error-action');
      await waitForHomeGovernance(() => expect(screen.findByTestId('services-recovery-empty')).toBeTruthy());
      await waitForHomeGovernance(() => expect(deliverNext).toBeTypeOf('function'));
      await act(async () => { deliverNext!(LocalServiceInventorySnapshotV1Schema.parse({ ...snapshot, generatedAt: 124,
        entries: [buildLocalServiceInventoryRow()] })); });
      await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('5173'));
    } finally { await screen.unmount(); rpc.mockRestore(); }
  });

  it.each(['accept', 'acceptOnce', 'decline', 'retire', 'askFirstReject'] as const)('continues an untrusted Service Start through the shared Setup decision owner only after observed completion (%s)', async decision => {
    const serverId = await home.addHome({ name: 'Service Setup Home', serverUrl: `https://services-setup-${decision}.test`,
      accountId: 'initiating-account', currentAccount: true });
    const scope = { serverId, accountId: 'initiating-account' };
    const workspace = { serverId, machineId: 'machine-a', workspaceId: 'accepted', rootPath: '/repo' };
    const previous = storage.getState();
    storage.setState({ profileScope: scope, projectAccountRows: createProjectAccountRowsFixture(scope, { workspaceRefs: [
      { id: workspace.workspaceId, serverId, machineId: workspace.machineId, rootPath: workspace.rootPath, createdAtMs: 1, projectKey: 'accepted-project' },
    ] }) });
    home.answer(serverId, '/v2/account/settings', { body: { version: 1, content: { t: 'plain', v: {
      actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'action.operations.cancel': ['ui'] } },
    } } } });
    home.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
    home.answer(serverId, '/v1/account/project-trust/read', { body: { status: 'absent' } });
    home.answer(serverId, '/v1/account/project-trust/mutate', { body: { status: 'updated', revision: 1, cursor: 1 } });
    if (decision === 'askFirstReject') {
      await home.requireUiApproval(serverId, 'projects.prepare');
      // Real approval admission reads the addressed Machine from its Home census.
      home.answer(serverId, '/v1/machines', { body: [createPlainMachineRowFixture({
        id: workspace.machineId, accountId: scope.accountId,
      })] });
    }
    const consent: ProjectSetupConsentFailureDetailsV1 = { kind: 'pendingApproval', code: 'project_setup_consent_required', reviewedEffectDigest: 'setup-digest',
      reviewedEffect: { v: 1, purpose: 'setup', commands: [{ source: { kind: 'command', command: 'prepare-project' }, executable: 'prepare-project', args: [] }] } };
    const held: ActionOperationSnapshotV1 = { version: 1, operationId: 'held-service-setup', revision: 1,
      actionId: 'projects.prepare', state: 'accepted', scope: { accountId: scope.accountId, machineId: workspace.machineId },
      title: 'Setup', createdAt: 1, cancellation: 'supported', setupReview: consent,
      domainRef: { kind: 'projectCommand', purpose: 'setup', serverId, machineId: workspace.machineId,
        workspaceRefId: workspace.workspaceId, cwd: workspace.rootPath, sourceWorkspace: workspace } };
    const running: ActionOperationSnapshotV1 = { ...held, revision: 2, state: 'running', startedAt: 2, setupReview: undefined };
    // Only authenticated daemon RPC and Home HTTP leave the process; client, controller, retained
    // operation store, shared review card and canonical Remember decision stay real.
    const rpc = vi.spyOn(operationMachineRpc, 'machineRpcWithServerScope').mockImplementation(async <Response,>(request: Parameters<typeof operationMachineRpc.machineRpcWithServerScope>[0]) => {
      const snapshot = home.requests.some(value => value.path === '/v1/account/project-trust/mutate') ? running : held;
      const response: unknown = request.method === ACTION_OPERATION_RPC_METHODS_V2.get ? { kind: 'found', operation: snapshot }
        : request.method === ACTION_OPERATION_RPC_METHODS_V2.list ? { items: [snapshot], nextCursor: null } : { kind: 'requested' };
      // Authenticated RPC is the genuinely generic transport boundary; real readers parse its DTO.
      return response as Response;
    });
    const requests: Parameters<RuntimeActionExecute>[0][] = [];
    let prepareApprovalId: string | undefined;
    let prepareApprovalOutcome: { artifactId: string } | { error: unknown } | undefined;
    const target: LocalServiceLaunchTarget = { id: 'project-service:web', source: 'managed_service',
      sourceClass: { kind: 'managed_service', managedServiceId: 'declared-web' }, machineId: 'machine-a', workspaceId: 'accepted',
      workspace, cwd: '/repo', declaration: { workspaceRefId: 'accepted', selection: { kind: 'manifest', name: 'web' } },
      title: 'Web', confidence: 'high', state: 'available', actions: ['start'] };
    const runtimeActionExecute: RuntimeActionExecute = async request => {
      requests.push(request);
      if (request.actionId === 'projects.prepare') {
        if (decision === 'askFirstReject') {
          prepareApprovalId = await createUiApprovalRequest({ serverId, actionId: request.actionId,
            actionInput: request.input, actionRequestId: 'service-setup-prepare' }).catch((error: unknown) => {
              prepareApprovalOutcome = { error };
              throw error;
            });
          prepareApprovalOutcome = { artifactId: prepareApprovalId };
          return { kind: 'approval_request_created', actionId: request.actionId, artifactId: prepareApprovalId };
        }
        // The decided retry returns the same held setup after consent clears.
        return { operation: requests.filter(value => value.actionId === 'projects.prepare').length > 1 ? running : held };
      }
      const serviceStarts = requests.filter(value => value.actionId === 'localServices.launcher.start');
      if (serviceStarts.length === 1) return { ok: false, errorCode: consent.code, error: consent.code, details: consent };
      return { protocolVersion: 1, machineId: 'machine-a', targetId: target.id, status: 'succeeded',
        snapshot: { v: 1, machineId: 'machine-a', updatedAt: 2, targets: [] } };
    };
    try {
      const screen = await renderScreen(<LocalServicesSurfaceHost machineId="machine-a" serverId={serverId} workspaceRoot="/repo"
        inventoryState={buildLocalServiceInventoryState({ rows: [] })} launcherState={applyLocalServiceLauncherSnapshot(createLocalServiceLauncherState(),
          { v: 1, machineId: 'machine-a', updatedAt: 1, targets: [target] })}
        runtimeActionExecute={createRuntimeBoundary(runtimeActionExecute)} testID="service-setup" />);
      await flushHookEffects();
      act(() => { screen.pressByTestId('service-setup-row:project-service:web-start'); });
      await waitForHomeGovernance(() => expect(requests[0]?.actionId).toBe('localServices.launcher.start'));
      await flushHookEffects();
      expect(requests.map(value => value.actionId)).toEqual(['localServices.launcher.start', 'projects.prepare']);
      expect(requests[1]?.input).toEqual({ workspace, phase: 'setup' });
      if (decision === 'askFirstReject') {
        // Observe completion first so a refused fixture reports its real error instead of
        // waiting for an approval id that the production executor could never create.
        await waitForHomeGovernance(() => expect(prepareApprovalOutcome).toBeDefined());
        expect(prepareApprovalOutcome).toEqual({ artifactId: expect.any(String) });
        await flushHookEffects();
        expect(screen.findByTestId('service-setup-setup-approval')).toBeTruthy();
        // The shared approval-pending notice, with its one way in (PATTERN-AUDIT-UI-1111 E), not a local banner.
        expect(screen.findByTestId('service-setup-setup-approval.open')).toBeTruthy();
        await expect(decideApprovalAsInbox(serverId, prepareApprovalId!, 'reject')).resolves.toMatchObject({ ok: true });
        await waitForHomeGovernance(async () => {
          await flushHookEffects();
          expect(screen.findAllByTestId('service-setup-setup-approval')).toHaveLength(0);
        });
      } else {
        await waitForHomeGovernance(() => expect(screen.findByTestId('service-setup-setup-review-approve')).toBeTruthy());
      }
      if (decision === 'retire') {
        await act(async () => { await home.switchAccount(serverId, 'replacement-account'); });
        await waitForHomeGovernance(() => expect(screen.findAllByTestId('service-setup-setup-review-approve')).toHaveLength(0));
      } else if (decision === 'decline') {
        act(() => screen.pressByTestId('service-setup-setup-review-reject'));
        await flushHookEffects();
      } else if (decision === 'accept' || decision === 'acceptOnce') {
        // This time is the default; remembering is the person's explicit choice.
        if (decision === 'accept') act(() => { screen.pressByTestId('service-setup-setup-review.scope:untilChanged'); });
        act(() => { screen.pressByTestId('service-setup-setup-review-approve'); });
        // Await the real decision's visible pending state, not the desired Trust write. A refusal
        // finishes that state too, so the following assertion reports it instead of timing out.
        await waitForHomeGovernance(async () => {
          await flushHookEffects();
          expect(screen.findByTestId('service-setup-setup-review-approve')?.props.disabled === true).toBe(false);
        });
        expect(home.requests.filter(value => value.path === '/v1/account/project-trust/mutate'),
          JSON.stringify({ rpc: rpc.mock.calls.map(([request]) => ({ method: request.method, payload: request.payload })),
            paths: home.requests.map(value => value.path) })).toHaveLength(decision === 'accept' ? 1 : 0);
        await flushHookEffects();
        // This time explicitly resumes the held setup; remembering wakes its existing wait.
        expect(requests.map(value => value.actionId)).toEqual(decision === 'accept'
          ? ['localServices.launcher.start', 'projects.prepare']
          : ['localServices.launcher.start', 'projects.prepare', 'projects.prepare']);
        if (decision === 'acceptOnce') expect(requests[2]?.input).toEqual({ workspace, phase: 'setup',
          expectedEffectDigest: consent.reviewedEffectDigest, consentScope: 'thisTime', heldOperationId: held.operationId });
        const afterDecision = requests.length;
        act(() => actionOperationStore.mergeSnapshots({ serverId, snapshots: [{ ...running, revision: 3,
          observation: { kind: 'outcome_uncertain', code: 'setup_ack_unknown' } }] }));
        await flushHookEffects();
        expect(requests).toHaveLength(afterDecision);
        expect(screen.findByTestId('service-setup-setup-operation')).toBeTruthy();
        act(() => actionOperationStore.mergeSnapshots({ serverId, snapshots: [{ ...running, revision: 4,
          state: 'succeeded', settledAt: 4, result: { kind: 'success', reviewedEffectDigest: consent.reviewedEffectDigest } }] }));
        await flushHookEffects();
        expect(requests.filter(value => value.actionId === 'localServices.launcher.start'),
          JSON.stringify({ operation: [...actionOperationStore.getSnapshot().operationsByKey.values()],
            requests: requests.map(value => value.actionId) })).toHaveLength(2);
        expect(requests[afterDecision]?.input).toEqual(requests[0]?.input);
        if (decision === 'accept') expect(home.requests.find(value => value.path === '/v1/account/project-trust/mutate')?.input).toMatchObject({
          project: { serverId, projectId: 'accepted-project' }, content: { t: 'plain', v: { reviewedEffectDigest: consent.reviewedEffectDigest } },
        });
      }
      if (decision !== 'accept' && decision !== 'acceptOnce') {
        expect(requests.filter(value => value.actionId === 'localServices.launcher.start')).toHaveLength(1);
        expect(home.requests.filter(value => value.path === '/v1/account/project-trust/mutate')).toHaveLength(0);
      }
      expect(requests.every(value => Reflect.get(value.context, 'expectedAccountId') === scope.accountId)).toBe(true);
    } finally {
      rpc.mockRestore();
      storage.setState({ profileScope: previous.profileScope, projectAccountRows: previous.projectAccountRows });
    }
  });

  it('renders the detected services pane and the Services-bound plugin stack under the testID prefix', async () => {
    const screen = await renderScreen(
      <LocalServicesSurfaceHost
        machineId="machine-a"
        serverId="server-a"
        sessionId="session-a"
        inventoryState={buildLocalServiceInventoryState({ rows: [] })}
        launcherState={buildLauncherState()}
        testID="surface-host-services"
      />,
    );

    expect(
      screen.findByTestId('surface-host-services-row:inventory:host-feed'),
    ).toBeTruthy();
    expect(
      screen.findByTestId('surface-host-services-plugin-stack'),
    ).toBeTruthy();
    expect(pluginProjectionState.stackProps.at(-1)).toMatchObject({
      container: 'servicesPanel',
      targetKind: 'services',
    });
  });

  it('threads the explicit sessionId into the pane so this-session grouping uses it (§5.6)', async () => {
    const screen = await renderScreen(
      <LocalServicesSurfaceHost
        machineId="machine-a"
        serverId="server-a"
        sessionId="session-a"
        inventoryState={buildLocalServiceInventoryState({ rows: [] })}
        launcherState={buildLauncherState()}
        testID="surface-host-services"
      />,
    );
    // The session-a preview is attributed to this session (explicit sessionId threaded host→pane),
    // so it reads "This session" in the Running section.
    expect(
      screen.findByTestId('surface-host-services-section-running'),
    ).toBeTruthy();
    expect(screen.getTextContent()).toContain('This session');
  });

  it('invokes the injected onOpenServiceInBrowser callback with the launch target when the open affordance fires', async () => {
    const onOpenServiceInBrowser = vi.fn();
    const screen = await renderScreen(
      <LocalServicesSurfaceHost
        machineId="machine-a"
        serverId="server-a"
        sessionId="session-a"
        inventoryState={buildLocalServiceInventoryState({ rows: [] })}
        launcherState={buildLauncherState()}
        onOpenServiceInBrowser={onOpenServiceInBrowser}
        testID="surface-host-services"
      />,
    );

    await pressTestInstanceAsync(
      screen.findByTestId('surface-host-services-row:inventory:host-feed-item'),
      'surface-host-services-row:inventory:host-feed-item',
    );
    await pressTestInstanceAsync(
      screen.findByTestId('surface-host-services-row:inventory:host-feed-open'),
      'surface-host-services-row:inventory:host-feed-open',
    );

    expect(onOpenServiceInBrowser).toHaveBeenCalledExactlyOnceWith(
      openableTarget,
    );
  });

  it('reviews Restart explicitly and binds exact Project controls to the initiating Home Account', async () => {
    const serverId = await home.addHome({
      name: 'Service Home',
      serverUrl: 'https://services-host.test',
      accountId: 'initiating-account',
      currentAccount: true,
    });
    const requests: Parameters<RuntimeActionExecute>[0][] = [];
    // The front-door Action executor is the transport boundary; the host, row model and row are real.
    const runtimeActionExecute: RuntimeActionExecute = async (request) => {
      requests.push(request);
      const input = request.input as {
        requestId: string;
        action: string;
        expectedEffectDigest?: string;
      };
      return {
        v: 1,
        requestId: input.requestId,
        action: input.action,
        status:
          request.actionId === 'localServices.actions.restartManaged' &&
          !input.expectedEffectDigest
            ? 'denied'
            : 'succeeded',
        ...(!input.expectedEffectDigest &&
        request.actionId === 'localServices.actions.restartManaged'
          ? {
              reasonCode: 'project_service_effect_review_required',
              reviewedEffect: { command: 'current service' },
              reviewedEffectDigest: 'reviewed-service-effect',
            }
          : {}),
        auditEvents: [],
      };
    };
    const managed: LocalServiceLaunchTarget = {
      id: 'project-service:jobs',
      source: 'managed_service',
      sourceClass: { kind: 'managed_service', managedServiceId: 'owned-jobs' },
      machineId: 'machine-a',
      workspaceId: 'accepted',
      cwd: '/repo',
      workspace: {
        serverId,
        machineId: 'machine-a',
        workspaceId: 'accepted',
        rootPath: '/repo',
      },
      declaration: {
        workspaceRefId: 'accepted',
        selection: { kind: 'manifest', name: 'jobs' },
      },
      title: 'jobs',
      confidence: 'high',
      state: 'available',
      serviceState: 'running',
      actions: ['manage'],
    };
    const screen = await renderScreen(
      <LocalServicesSurfaceHost
        machineId="machine-a"
        serverId={serverId}
        workspaceRoot="/repo"
        inventoryState={buildLocalServiceInventoryState({ rows: [] })}
        launcherState={applyLocalServiceLauncherSnapshot(
          createLocalServiceLauncherState(),
          {
            v: 1,
            machineId: 'machine-a',
            updatedAt: 1,
            targets: [managed],
          },
        )}
        runtimeActionExecute={createRuntimeBoundary(runtimeActionExecute)}
        testID="surface-host-services"
      />,
    );
    await flushHookEffects();
    const menus = screen.findAllByType(ItemRowActions);
    const actions = menus.flatMap(
      (menu) =>
        (menu.props as { actions: Array<{ id: string; onPress: () => void }> })
          .actions,
    );
    await act(async () => {
      actions.find((action) => action.id === 'restart')!.onPress();
    });
    await flushHookEffects();
    // The host draws the disclosed effect itself; only the person's Restart rejoins the Action.
    expect(requests).toHaveLength(1);
    await act(async () => {
      screen.pressByTestId('surface-host-services-effect-review-approve');
    });
    await flushHookEffects();
    await act(async () => {
      actions.find((action) => action.id === 'stop')!.onPress();
    });
    await flushHookEffects();
    expect(requests.map((request) => request.actionId)).toEqual([
      'localServices.actions.restartManaged',
      'localServices.actions.restartManaged',
      'localServices.actions.stopManaged',
    ]);
    expect(
      requests.every(
        (request) =>
          Reflect.get(request.context ?? {}, 'expectedAccountId') ===
          'initiating-account',
      ),
    ).toBe(true);
    expect(requests[1]).toMatchObject({
      input: { expectedEffectDigest: 'reviewed-service-effect' },
    });
    expect(requests[2]).toMatchObject({
      input: {
        action: 'stop_managed',
        target: {
          kind: 'managed_service',
          managedServiceId: 'owned-jobs',
          machineId: 'machine-a',
          cwd: '/repo',
          declaration: managed.declaration,
        },
      },
    });
  });

  it('retires a held Project effect review when its exact Home Account changes', async () => {
    const serverId = await home.addHome({
      name: 'Service Home',
      serverUrl: 'https://services-review-retirement.test',
      accountId: 'initiating-account',
      currentAccount: true,
    });
    const runtimeActionExecute = vi.fn<RuntimeActionExecute>(
      async (request) => ({
        protocolVersion: 1,
        machineId: 'machine-a',
        targetId: 'project-service:jobs',
        status: 'denied',
        reasonCode: 'project_service_effect_review_required',
        reviewedEffect: { command: 'current service' },
        reviewedEffectDigest: 'a'.repeat(64),
        snapshot: { v: 1, machineId: 'machine-a', updatedAt: 1, targets: [] },
      }),
    );
    const target: LocalServiceLaunchTarget = {
      id: 'project-service:jobs',
      source: 'managed_service',
      sourceClass: {
        kind: 'managed_service',
        managedServiceId: 'declared-jobs',
      },
      machineId: 'machine-a',
      title: 'jobs',
      confidence: 'high',
      state: 'available',
      actions: ['start'],
      cwd: '/repo',
      workspace: {
        serverId,
        machineId: 'machine-a',
        workspaceId: 'accepted',
        rootPath: '/repo',
      },
      declaration: {
        workspaceRefId: 'accepted',
        selection: { kind: 'manifest', name: 'jobs' },
      },
    };
    const screen = await renderScreen(
      <LocalServicesSurfaceHost
        serverId={serverId}
        machineId="machine-a"
        workspaceRoot="/repo"
        inventoryState={buildLocalServiceInventoryState({ rows: [] })}
        launcherState={applyLocalServiceLauncherSnapshot(
          createLocalServiceLauncherState(),
          {
            v: 1,
            machineId: 'machine-a',
            updatedAt: 1,
            targets: [target],
          },
        )}
        runtimeActionExecute={createRuntimeBoundary(runtimeActionExecute)}
        testID="service-retirement"
      />,
    );
    await flushHookEffects();
    act(() => {
      screen.pressByTestId('service-retirement-row:project-service:jobs-start');
    });
    await flushHookEffects();
    expect(runtimeActionExecute).toHaveBeenCalledOnce();
    expect(screen.findByTestId('service-retirement-effect-review')).toBeTruthy();
    await act(async () => {
      await home.switchAccount(serverId, 'replacement-account');
    });
    // The review retires with its exact Account: nothing is left to approve and nothing re-enters.
    await waitForHomeGovernance(() =>
      expect(screen.findAllByTestId('service-retirement-effect-review')).toHaveLength(0),
    );
    await flushHookEffects();
    expect(runtimeActionExecute).toHaveBeenCalledOnce();
  });

  /**
   * R2a-F1 / R2b-02: the real Project mounts pass no review callback. The host itself renders the
   * current effect the daemon disclosed and rejoins the same Start Action with that digest; Not now
   * re-enters nothing.
   */
  it('reviews a declared service Start in the host itself and rejoins the same Action with the disclosed digest', async () => {
    const serverId = await home.addHome({
      name: 'Service Home',
      serverUrl: 'https://services-effect-review.test',
      accountId: 'initiating-account',
      currentAccount: true,
    });
    const digest = 'b'.repeat(64);
    const runtimeActionExecute = vi.fn<RuntimeActionExecute>(
      async (request) => {
        const input = request.input as { expectedEffectDigest?: string };
        return input.expectedEffectDigest === digest
          ? {
              protocolVersion: 1,
              machineId: 'machine-a',
              targetId: 'project-service:web',
              status: 'succeeded',
              snapshot: {
                v: 1,
                machineId: 'machine-a',
                updatedAt: 2,
                targets: [],
              },
            }
          : {
              protocolVersion: 1,
              machineId: 'machine-a',
              targetId: 'project-service:web',
              status: 'denied',
              reasonCode: 'project_service_effect_review_required',
              reviewedEffectDigest: digest,
              reviewedEffect: {
                v: 1,
                purpose: 'service',
                command: {
                  source: { kind: 'native' },
                  executable: 'yarn',
                  args: ['dev:ui'],
                  cwd: '.',
                },
              },
              snapshot: {
                v: 1,
                machineId: 'machine-a',
                updatedAt: 1,
                targets: [],
              },
            };
      },
    );
    const target: LocalServiceLaunchTarget = {
      id: 'project-service:web',
      source: 'managed_service',
      sourceClass: {
        kind: 'managed_service',
        managedServiceId: 'declared-web',
      },
      machineId: 'machine-a',
      title: 'web',
      confidence: 'high',
      state: 'available',
      actions: ['start'],
      cwd: '/repo',
      workspace: {
        serverId,
        machineId: 'machine-a',
        workspaceId: 'accepted',
        rootPath: '/repo',
      },
      declaration: {
        workspaceRefId: 'accepted',
        selection: { kind: 'manifest', name: 'web' },
      },
    };
    const render = () =>
      renderScreen(
        <LocalServicesSurfaceHost
          serverId={serverId}
          machineId="machine-a"
          workspaceRoot="/repo"
          inventoryState={buildLocalServiceInventoryState({ rows: [] })}
          launcherState={applyLocalServiceLauncherSnapshot(
            createLocalServiceLauncherState(),
            {
              v: 1,
              machineId: 'machine-a',
              updatedAt: 1,
              targets: [target],
            },
          )}
          runtimeActionExecute={createRuntimeBoundary(runtimeActionExecute)}
          testID="service-review"
        />,
      );

    const declined = await render();
    await flushHookEffects();
    act(() => {
      declined.pressByTestId('service-review-row:project-service:web-start');
    });
    await flushHookEffects();
    expect(declined.findByTestId('service-review-effect-review')).toBeTruthy();
    expect(declined.getTextContent()).toContain('yarn dev:ui');
    await act(async () => {
      declined.pressByTestId('service-review-effect-review-reject');
    });
    await flushHookEffects();
    expect(runtimeActionExecute).toHaveBeenCalledOnce();
    expect(
      declined.findAllByTestId('service-review-effect-review'),
    ).toHaveLength(0);
    act(() => { declined.tree.unmount(); });

    runtimeActionExecute.mockClear();
    const accepted = await render();
    await flushHookEffects();
    act(() => {
      accepted.pressByTestId('service-review-row:project-service:web-start');
    });
    await flushHookEffects();
    await act(async () => {
      accepted.pressByTestId('service-review-effect-review-approve');
    });
    await flushHookEffects();
    expect(
      runtimeActionExecute.mock.calls.map(([request]) => [
        request.actionId,
        (request.input as { expectedEffectDigest?: string })
          .expectedEffectDigest,
      ]),
    ).toEqual([
      ['localServices.launcher.start', undefined],
      ['localServices.launcher.start', digest],
    ]);
    expect(
      accepted.findAllByTestId('service-review-effect-review'),
    ).toHaveLength(0);
  });

  it('holds managed Stop until the mounted exact-Account Artifact reader observes the durable decision', async () => {
    const serverId = await home.addHome({
      name: 'Service Home',
      serverUrl: 'https://services-stop-approval.test',
      accountId: 'initiating-account',
      currentAccount: true,
    });
    await home.requireUiApproval(serverId, 'localServices.actions.stopManaged');
    let artifactId: string | undefined;
    const runtimeActionExecute: RuntimeActionExecute = async (request) => {
      artifactId = await createUiApprovalRequest({
        serverId,
        actionId: request.actionId,
        actionInput: request.input,
        actionRequestId: 'mounted-service-stop',
      });
      return {
        kind: 'approval_request_created',
        actionId: request.actionId,
        artifactId,
      };
    };
    const target: LocalServiceLaunchTarget = {
      id: 'project-service:jobs',
      source: 'managed_service',
      sourceClass: { kind: 'managed_service', managedServiceId: 'owned-jobs' },
      machineId: 'machine-a',
      title: 'jobs',
      confidence: 'high',
      state: 'available',
      serviceState: 'running',
      actions: ['manage'],
      cwd: '/repo',
      workspace: {
        serverId,
        machineId: 'machine-a',
        workspaceId: 'accepted',
        rootPath: '/repo',
      },
      declaration: {
        workspaceRefId: 'accepted',
        selection: { kind: 'manifest', name: 'jobs' },
      },
    };
    const screen = await renderScreen(
      <LocalServicesSurfaceHost
        serverId={serverId}
        machineId="machine-a"
        workspaceRoot="/repo"
        inventoryState={buildLocalServiceInventoryState({ rows: [] })}
        launcherState={applyLocalServiceLauncherSnapshot(
          createLocalServiceLauncherState(),
          {
            v: 1,
            machineId: 'machine-a',
            updatedAt: 1,
            targets: [target],
          },
        )}
        runtimeActionExecute={createRuntimeBoundary(runtimeActionExecute)}
        testID="service-stop-approval"
      />,
    );
    await flushHookEffects();
    const stop = screen
      .findAllByType(ItemRowActions)
      .flatMap(
        (menu) =>
          (
            menu.props as {
              actions: Array<{ id: string; onPress: () => void }>;
            }
          ).actions,
      )
      .find((action) => action.id === 'stop');
    await act(async () => {
      stop!.onPress();
    });
    await waitForHomeGovernance(() => expect(artifactId).toBeDefined());
    await waitForHomeGovernance(() =>
      expect(
        home.requests.some((request) =>
          request.path.startsWith(`/v1/artifacts/${artifactId}`),
        ),
      ).toBe(true),
    );
    const isPending = () =>
      screen
        .findAllByTestId('service-stop-approval-row:project-service:jobs-item')
        .some((node) => node.props.loading === true);
    expect(isPending()).toBe(true);
    const body = home.artifacts(serverId).readPlainBody(artifactId!);
    expect(body && JSON.parse(body)).toMatchObject({
      status: 'open',
      actionId: 'localServices.actions.stopManaged',
      executionOriginV1: { accountId: 'initiating-account' },
      actionArgs: {
        target: {
          managedServiceId: 'owned-jobs',
          declaration: target.declaration,
        },
      },
    });
    await expect(
      decideApprovalAsInbox(serverId, artifactId!, 'reject'),
    ).resolves.toMatchObject({ ok: true });
    await flushHookEffects();
    await waitForHomeGovernance(() => expect(isPending()).toBe(false));
    expect(
      home.artifacts(serverId).readPlainBody(artifactId!) &&
        JSON.parse(home.artifacts(serverId).readPlainBody(artifactId!)!),
    ).toMatchObject({ status: 'rejected' });
    // Rejecting approval must never pretend that the actual service stopped.
    expect(screen.getTextContent()).toContain('Running');
  });

  it('does not render the open affordance when no onOpenServiceInBrowser callback is supplied', async () => {
    const screen = await renderScreen(
      <LocalServicesSurfaceHost
        machineId="machine-a"
        serverId="server-a"
        sessionId="session-a"
        inventoryState={buildLocalServiceInventoryState({ rows: [] })}
        launcherState={buildLauncherState()}
        testID="surface-host-services"
      />,
    );

    expect(
      screen.findAllByTestId(
        'surface-host-services-row:inventory:host-feed-open',
      ),
    ).toHaveLength(0);
  });

  it('passes the host-selected Services origin and session to plugin services surfaces', async () => {
    pluginProjectionState.appShell = {
      pluginUiProjection: { generation: 1, surfacePlacementsById: {} },
      machineId: 'machine-global',
      serverId: 'server-global',
      platform: 'web',
    };
    pluginProjectionState.scoped = {
      pluginUiProjection: { generation: 2, surfacePlacementsById: {} },
      machineId: 'machine-a',
      serverId: 'server-a',
      platform: 'web',
    };

    await renderScreen(
      <LocalServicesSurfaceHost
        machineId="machine-a"
        serverId="server-a"
        sessionId="session-a"
        inventoryState={buildLocalServiceInventoryState({ rows: [] })}
        launcherState={buildLauncherState()}
        testID="surface-host-services"
      />,
    );

    const stackProps = pluginProjectionState.stackProps.at(-1);
    expect(stackProps?.pluginUiProjection).toEqual({
      generation: 2,
      surfacePlacementsById: {},
    });
    expect(stackProps?.machineId).toBe('machine-a');
    expect(stackProps?.serverId).toBe('server-a');
    expect(stackProps?.sessionId).toBe('session-a');
  });

  it('does not substitute a scoped projection machine for a missing Services host origin', async () => {
    pluginProjectionState.scoped = {
      pluginUiProjection: { generation: 2, surfacePlacementsById: {} },
      machineId: 'machine-arbitrary-current',
      serverId: 'server-arbitrary-current',
      platform: 'web',
    };

    await renderScreen(
      <LocalServicesSurfaceHost
        inventoryState={buildLocalServiceInventoryState({ rows: [] })}
        launcherState={buildLauncherState()}
        testID="surface-host-services"
      />,
    );

    const stackProps = pluginProjectionState.stackProps.at(-1);
    expect(stackProps?.machineId).toBeNull();
    expect(stackProps?.serverId).toBeNull();
    expect(stackProps?.sessionId).toBeUndefined();
    expect(stackProps).not.toHaveProperty('runtimeActionExecute');
  });

  it('keeps an admitted unavailable Services projection unavailable instead of self-resolving ambient state', async () => {
    pluginProjectionState.scoped = {
      pluginUiProjection: { generation: 2, surfacePlacementsById: {} },
      machineId: 'machine-ambient',
      serverId: 'server-ambient',
      platform: 'web',
    };

    await renderScreen(
      <LocalServicesSurfaceHost
        machineId="machine-pane-driver"
        serverId="server-pane-driver"
        sessionId="session-a"
        inventoryState={buildLocalServiceInventoryState({ rows: [] })}
        launcherState={buildLauncherState()}
        pluginUiProjection={null}
        projectionInteractionEnabled={false}
        platform="web"
        testID="surface-host-services"
      />,
    );

    const stackProps = pluginProjectionState.stackProps.at(-1);
    expect(stackProps?.pluginUiProjection).toBeNull();
    expect(stackProps?.projectionInteractionEnabled).toBe(false);
    expect(stackProps?.machineId).toBe('machine-pane-driver');
    expect(stackProps?.serverId).toBe('server-pane-driver');
    expect(pluginProjectionState.scopedInputs).toContainEqual({
      machineId: null,
      serverId: null,
      enabled: false,
    });
  });

  it('is the single fix-point: the three Services views delegate to it instead of re-declaring the wiring', () => {
    const repoRoot = path.resolve(__dirname, '../../../..');
    const viewPaths = [
      'sources/components/sessions/panes/services/SessionRightPanelServicesView.tsx',
      'sources/components/projects/detail/services/ProjectRightPanelServicesView.tsx',
      'sources/components/workspaceCockpit/session/SessionServicesSurfaceScreen.tsx',
    ];

    for (const relPath of viewPaths) {
      const source = fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
      expect(source).toContain('LocalServicesSurfaceHost');
      expect(source).not.toContain('createDefaultRuntimeActionExecutor');
      expect(source).not.toContain('createLocalServiceInventoryState');
    }
  });
  it('shows a service that starts after mount, by re-reading the launcher feed the inventory watch reported changed', async () => {
    // The regression this pins: the pane's rows are built from LAUNCH TARGETS, and inventory
    // entries only enrich them. Making the inventory fresh while leaving the launcher feed on
    // its mount-time read renders nothing new, which a store-level assertion cannot see.
    const serverId = await home.addHome({ name: 'Services Watch Home', serverUrl: 'https://services-watch.test',
      accountId: 'watch-account', currentAccount: true });
    const startedTarget: LocalServiceLaunchTarget = {
      ...openableTarget,
      id: 'inventory:vite-5199',
      source: 'inventory_entry',
      title: 'Vite dev server',
      subtitle: '127.0.0.1:5199',
      browserTarget: {
        kind: 'localServicePreview',
        targetId: 'preview-vite-5199',
        sessionId: 'session-a',
        machineId: 'machine-a',
      },
    };
    const inventorySnapshotAt = (
      generatedAt: number,
      entries: readonly unknown[],
    ) => ({
      v: 1 as const,
      machineId: 'machine-a',
      generatedAt,
      refreshState: 'idle' as const,
      entries: entries as never,
      diagnostics: [],
    });

    const inventorySnapshotClient = vi.fn(async () => ({
      ok: true as const,
      snapshot: inventorySnapshotAt(1_000, []),
    }));
    let launcherReads = 0;
    let serviceStarted = false;
    const launcherSnapshotClient = vi.fn(async () => {
      launcherReads += 1;
      return {
        ok: true as const,
        snapshot: {
          v: 1 as const,
          machineId: 'machine-a',
          sessionId: 'session-a',
          updatedAt: 3_000 + launcherReads,
          // The daemon only knows about the new service from the scan that just ran.
          targets: serviceStarted ? [startedTarget] : [],
        },
      };
    });

    let answerWatch: ((snapshot: ReturnType<typeof inventorySnapshotAt>) => void) | undefined;
    const watchSpy = vi.spyOn(operationMachineRpc, 'machineRpcWithServerScope').mockImplementation(async <Response,>(request: Parameters<typeof operationMachineRpc.machineRpcWithServerScope>[0]) => {
      if (request.method !== RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH) throw new Error(`Unexpected RPC ${request.method}`);
      return await new Promise<Response>((resolve, reject) => {
        // Only the daemon transport is replaced; the watch adapter validates its real wire DTO.
        answerWatch = snapshot => resolve({ protocolVersion: 1, changed: true, snapshot } as Response);
        request.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      });
    });

    const screen = await renderScreen(
      <LocalServicesSurfaceHost
        machineId="machine-a"
        serverId={serverId}
        sessionId="session-a"
        inventorySnapshotClient={inventorySnapshotClient as never}
        launcherSnapshotClient={launcherSnapshotClient as never}
        testID="surface-host-services"
      />,
    );
    await flushHookEffects({ cycles: 3, turns: 3 });
    expect(
      screen.findAllByTestId('surface-host-services-row:inventory:vite-5199'),
    ).toHaveLength(0);
    expect(answerWatch).toBeTypeOf('function');

    // The dev server starts; the daemon answers the parked watch with the newer snapshot.
    await act(async () => {
      serviceStarted = true;
      answerWatch?.(inventorySnapshotAt(2_000, []));
      await Promise.resolve();
    });
    await flushHookEffects({ cycles: 4, turns: 4 });

    expect(launcherSnapshotClient.mock.calls.length).toBeGreaterThan(1);
    expect(
      screen.findByTestId('surface-host-services-row:inventory:vite-5199'),
    ).toBeTruthy();
    watchSpy.mockRestore();
  });
});
