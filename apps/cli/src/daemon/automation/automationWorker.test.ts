import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_AUTOMATION_V3_MAX_ACTIVE_RUNS_PER_MACHINE,
  FeaturesResponseSchema,
  materializeWorkflowAcceptedSnapshotV1,
  serializeWorkflowStoredContentEnvelopeV1,
  sealWorkflowAcceptedSnapshotStoredEnvelopeV1,
  deriveWorkflowSessionInputLocalIdV2,
  type AutomationDefinitionDetail,
  type AutomationDefinitionReconcileRequest,
} from '@happier-dev/protocol';
import type { StoredCredentials } from '@/persistence';
import { AUTOMATION_TEMPLATE_V02_PLAIN, AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED } from '../../../../../packages/protocol/src/automations/automationTemplateV02.testFixtures';
import { createProductionWorkflowRunCoordinator } from '@/daemon/workflows/production';
import { createWorkflowRunStorageTestkit, createPlainWorkflowRunKeyCensusFixture } from '@/daemon/workflows/workflowRunStorage.testkit';
import type { Update } from '@/api/types';
import { reloadConfiguration as reloadCapacityConfiguration } from '@/configuration';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1, ConnectedAccountCatalogRowReadResponseV1Schema,
  emptyConnectedAccountCatalogRecordV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { startAutomationWorker } from './automationWorker';
import { createDaemonAdmissionDrain } from '../lifecycle/admissionDrain';
import { createManagedActivityInventory, type LiveWorkInventoryV1 } from '../lifecycle/managedActivity';
import { projectMachineWorkSummary } from '../machines/machineWorkSummary';

const { mockGet, mockPost, mockIsAxiosError, mockCreate } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  mockIsAxiosError: vi.fn(() => true),
  mockCreate: vi.fn(),
}));
const migrationBoundary = vi.hoisted(() => ({ credentials: null as StoredCredentials | null,
  list: vi.fn(), get: vi.fn(), reconcile: vi.fn() }));
const freshSpawnBoundary = vi.hoisted(() => vi.fn());

function startCapacityAutomationWorker(params: Parameters<typeof startAutomationWorker>[0]) {
  migrationBoundary.credentials = params.credentials;
  return startAutomationWorker(params);
}

// The credential store and Automation HTTP adapters are system boundaries;
// the worker, Account Actions and predecessor converter remain real.
vi.mock('@/persistence', async importOriginal => ({ ...await importOriginal<typeof import('@/persistence')>(),
  readStoredCredentials: async () => migrationBoundary.credentials }));
vi.mock('@/api/automations', async importOriginal => ({ ...await importOriginal<typeof import('@/api/automations')>(),
  listAutomationDefinitions: migrationBoundary.list, getAutomationDefinition: migrationBoundary.get,
  reconcileAutomationDefinition: migrationBoundary.reconcile }));

// Machine RPC is the process boundary for both resume and fresh Session spawn.
// Canonical readiness and Agent selection remain real.
vi.mock('@/session/transport/rpc/machineRpc', () => {
  const resumed = new Map<string, string>();
  return { callMachineRpc: async (input: Parameters<typeof import('@/session/transport/rpc/machineRpc').callMachineRpc>[0]) => {
    const { method, request } = input;
    const resumeRequest = request as { sessionId?: string; spawnNonce?: string };
    if ((method === RPC_METHODS.SPAWN_HAPPY_SESSION || method === RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE) && !resumeRequest.sessionId) {
      return freshSpawnBoundary(input);
    }
    if (method === RPC_METHODS.SPAWN_HAPPY_SESSION && resumeRequest.sessionId && resumeRequest.spawnNonce) {
      resumed.set(resumeRequest.spawnNonce, resumeRequest.sessionId);
      return { type: 'success', sessionId: resumeRequest.sessionId };
    }
    return { status: 'success', sessionId: resumed.get(resumeRequest.spawnNonce ?? '') };
  } };
});

vi.mock('axios', () => {
  const client = {
    get: (url: string, ...args: unknown[]) => url.endsWith('/worker/run-lifecycle')
      ? Promise.resolve({ data: { sources: [] } }) : mockGet(url, ...args),
    post: mockPost,
    isAxiosError: mockIsAxiosError,
  };

  mockCreate.mockImplementation(() => client);

  return {
    default: {
      ...client,
      create: mockCreate,
    },
    isAxiosError: mockIsAxiosError,
  };
});

vi.mock('./automationTelemetry', () => ({
  logAutomationInfo: () => {},
  logAutomationWarn: () => {},
}));

/**
 * The canonical claim client signs a machine-installation publisher proof before
 * every automation request, so an assignment read or claim only reaches Axios
 * after that asynchronous header work settles. Drain those continuations without
 * moving the clock so timer-boundary assertions stay exact.
 */
async function settleRequestDispatch(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
  }
}

async function waitForCondition(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out while waiting for automation worker condition');
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function createAxios404(url: string) {
  return {
    message: 'Request failed with status code 404',
    response: { status: 404 },
    config: { url },
  };
}

const V3_CLAIM_CURRENTNESS = {
  mode: 'plain' as const,
  version: 7,
  contentKeyFingerprint: null,
};

const V3_START_CURRENTNESS = {
  mode: 'plain' as const,
  version: 8,
  contentKeyFingerprint: null,
};

const DEFAULT_WORKER_SETTINGS = {
  maxActiveRunsPerMachine: DEFAULT_AUTOMATION_V3_MAX_ACTIVE_RUNS_PER_MACHINE,
} as const;

function createAccountCurrentnessResponse(
  witness: typeof V3_CLAIM_CURRENTNESS | typeof V3_START_CURRENTNESS,
  updatedAt: number,
) {
  return {
    ...witness,
    signingKeyFingerprint: null,
    updatedAt,
  };
}

function createV3StartResponse(params: { runId: string; now: number; attempt: number }) {
  return {
    run: {
      id: params.runId,
      automationId: 'automation-1',
      revision: 1,
      triggerId: null,
      triggerRetired: false,
      state: 'running' as const,
      cause: { kind: 'manual' as const, invokedAt: params.now },
      dueAt: params.now,
      claimedAt: params.now,
      startedAt: params.now,
      finishedAt: null,
      claimedByMachineId: 'machine-1',
      leaseExpiresAt: params.now + 30_000,
      attempt: params.attempt,
      errorCode: null,
      producedSessionId: null,
      executionDispatchState: null,
      executionAttempt: 0,
      replyHandoffState: 'none' as const,
      replyHandoffAttempt: 0,
      replyHandoffDueAt: null,
      createdAt: params.now,
      updatedAt: params.now,
    },
    accountCurrentness: V3_START_CURRENTNESS,
  };
}

describe('automationWorker', () => {
  const previousServer = process.env.HAPPIER_SERVER_URL;
  const previousWebapp = process.env.HAPPIER_WEBAPP_URL;
  const previousHomeDir = process.env.HAPPIER_HOME_DIR;

  beforeEach(() => {
    migrationBoundary.credentials = { token: 'token-1', encryption: null };
    freshSpawnBoundary.mockReset();
    migrationBoundary.list.mockReset().mockResolvedValue({ automations: [], nextCursor: null });
    migrationBoundary.get.mockReset();
    migrationBoundary.reconcile.mockReset();
    // The canonical Action reads the Home's authenticated feature descriptor
    // through Fetch, independently of its Axios Automation transport.
    vi.stubGlobal('fetch', async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/profile') return new Response(JSON.stringify({ username: 'capacity-account' }), { status: 200 });
      return new Response(JSON.stringify(path.startsWith('/v1/features')
        ? FeaturesResponseSchema.parse({ features: { automations: { enabled: true }, workflows: { enabled: true } }, capabilities: {} })
        : { error: 'unexpected_network_request' }), { status: path.startsWith('/v1/features') ? 200 : 404 });
    });
    vi.useRealTimers();
  });

  it('holds fresh claims during a temporary drain and consumes the same queued wake after reopening', async () => {
    mockPost.mockClear();
    const now = Date.now();
    process.env.HAPPIER_SERVER_URL = 'https://api.example.test';
    process.env.HAPPIER_WEBAPP_URL = 'https://app.example.test';
    process.env.HAPPIER_HOME_DIR = join(os.tmpdir(), `happier-drain-claim-${now}-${Math.random()}`);
    reloadCapacityConfiguration();
    mockGet.mockResolvedValue({ data: { assignments: [], settings: DEFAULT_WORKER_SETTINGS } });
    mockPost.mockResolvedValue({ data: { run: null, automation: null } });
    const admissionDrain = createDaemonAdmissionDrain();
    admissionDrain.beginTemporaryDrain();
    const worker = startCapacityAutomationWorker({ token: 'token',
      credentials: { token: 'token', encryption: null }, machineId: 'machine-1', admissionDrain });
    try {
      await worker.refreshAssignments();
      worker.handleServerUpdate({ id: 'drain-wake', seq: 1, createdAt: now, body: {
        t: 'automation-run-updated', runId: 'drain-run', automationId: null, state: 'queued', scheduledAt: now,
        startedAt: null, finishedAt: null, updatedAt: now, machineId: null, targetMachineId: 'machine-1',
      } } satisfies Update);
      await new Promise((resolve) => setTimeout(resolve, 30));
      await settleRequestDispatch();
      expect(mockPost.mock.calls.filter(([url]) => String(url).endsWith('/runs/claim'))).toHaveLength(0);
      admissionDrain.resume();
      await waitForCondition(() => mockPost.mock.calls.some(([url]) => String(url).endsWith('/runs/claim')));
    } finally { worker.stop(); }
  });

  it('projects admitted claim custody through the sole inventory until its response settles without blanking custodian summary', async () => {
    mockPost.mockClear();
    const now = Date.now();
    process.env.HAPPIER_SERVER_URL = 'https://api.example.test';
    process.env.HAPPIER_WEBAPP_URL = 'https://app.example.test';
    process.env.HAPPIER_HOME_DIR = join(os.tmpdir(), `happier-activity-claim-${now}-${Math.random()}`);
    reloadCapacityConfiguration();
    mockGet.mockResolvedValue({ data: { assignments: [], settings: DEFAULT_WORKER_SETTINGS } });
    let releaseClaim!: () => void;
    mockPost.mockImplementation(async () => {
      await new Promise<void>(resolve => { releaseClaim = resolve; });
      return { data: { run: null, automation: null } };
    });
    const target = { serverId: 'home', machineId: 'machine-1', installationId: 'installation' };
    const attribution = { ...target, accountId: 'alice' };
    const workerParams = { token: 'token', credentials: { token: 'token', encryption: null }, machineId: 'machine-1',
      requesterWorkAttributionV1: attribution };
    const worker = startCapacityAutomationWorker(workerParams);
    const inventory = createManagedActivityInventory({ producers: [worker.liveWorkProducer] });
    const project = async () => projectMachineWorkSummary({ inventory: await inventory.read(), target,
      custodianAccountId: 'alice', requesterIdentities: new Map() });
    const states: string[] = [];
    const unsubscribe = worker.liveWorkProducer.subscribe(() => {
      void Promise.resolve(worker.liveWorkProducer.read()).then(snapshot => {
        states.push(snapshot.items.length ? 'busy' : 'idle');
      });
    });
    try {
      await worker.refreshAssignments();
      expect(await worker.liveWorkProducer.read()).toEqual({ coverage: 'complete', items: [] });
      worker.handleServerUpdate({ id: 'activity-wake', seq: 1, createdAt: now, body: {
        t: 'automation-run-updated', runId: 'activity-run', automationId: null, state: 'queued', scheduledAt: now,
        startedAt: null, finishedAt: null, updatedAt: now, machineId: null, targetMachineId: 'machine-1',
      } } satisfies Update);
      await waitForCondition(() => mockPost.mock.calls.some(([url]) => String(url).endsWith('/runs/claim')));
      expect(await worker.liveWorkProducer.read()).toMatchObject({ coverage: 'complete', items: [
        { category: 'workflow_run', state: 'active', attribution },
      ] });
      expect(await inventory.readDecision()).toEqual({ kind: 'busy', reasons: ['workflow_run'] });
      expect(await project()).toEqual({ kind: 'current', requesters: [] });
      worker.stop();
      expect((await worker.liveWorkProducer.read()).items).toHaveLength(1);
      releaseClaim();
      await waitForCondition(() => states.at(-1) === 'idle');
      expect(await worker.liveWorkProducer.read()).toEqual({ coverage: 'complete', items: [] });
      expect(states).toContain('busy');
      expect(await project()).toEqual({ kind: 'current', requesters: [] });
    } finally { unsubscribe(); inventory.dispose(); worker.stop(); releaseClaim?.(); }
  });

  it('counts admitted Workflow coordinator work and releases parked custody before a pending assignment refresh finishes', async () => {
    const now = Date.now();
    const runId = '00000000-0000-4000-8000-000000000052';
    const machineId = 'machine-1';
    const accountId = 'account-1';
    process.env.HAPPIER_SERVER_URL = 'https://api.example.test';
    process.env.HAPPIER_WEBAPP_URL = 'https://app.example.test';
    process.env.HAPPIER_HOME_DIR = join(os.tmpdir(), `happier-activity-park-${now}-${Math.random()}`);
    reloadCapacityConfiguration();
    const materialized = await materializeWorkflowAcceptedSnapshotV1({
      definition: { version: 1, defaults: {
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      }, blocks: [{ kind: 'wait', id: 'review', document: { text: 'Review', references: [], attachments: [] } }] },
      context: { source: { kind: 'automation', automationId: 'automation-park' }, inputs: {}, machineId,
        executionTarget: { kind: 'session' },
        workspaceTarget: { project: { machineId, directory: '/repo', checkoutRootPath: '/repo' } },
        authorization: { principal: { kind: 'host' } } },
      admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true },
    });
    if (!materialized.ok) throw new Error(materialized.error.code);
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: materialized.snapshot,
    }));
    const storage = createWorkflowRunStorageTestkit({ runId, machineId,
      origin: { kind: 'automation', automationId: 'automation-park' }, acceptedEnvelope, state: 'claimed',
      keyCensus: { ...createPlainWorkflowRunKeyCensusFixture({ runId, accountId }), ownerAccountCurrentness: V3_CLAIM_CURRENTNESS } });
    const admissionDrain = createDaemonAdmissionDrain();
    const target = { serverId: 'server-1', machineId, installationId: 'installation' };
    const attribution = { ...target, accountId };
    let reviewInventory: LiveWorkInventoryV1 | undefined;
    let inventory: ReturnType<typeof createManagedActivityInventory> | undefined;
    let refreshHeld = false;
    const releaseRefreshes: Array<() => void> = [];
    mockGet.mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/encryption/currentness')) return {
        status: 200, data: createAccountCurrentnessResponse(V3_CLAIM_CURRENTNESS, now) };
      if (storage.run().state === 'waiting_for_review') {
        refreshHeld = true;
        await new Promise<void>(resolve => releaseRefreshes.push(resolve));
      }
      return { data: { assignments: [], settings: DEFAULT_WORKER_SETTINGS } };
    });
    let claimed = false;
    mockPost.mockImplementation(async (url: string) => {
      if (!url.endsWith('/v3/automations/runs/claim')) return { data: { ok: true } };
      if (claimed) return { data: { run: null, automation: null, accountCurrentness: null } };
      claimed = true;
      return { data: { run: { id: runId, automationId: 'automation-park', attempt: 1, revision: 0,
        recipeKind: 'workflow-v2', triggerId: null, triggerRetired: false, cause: { kind: 'manual', invokedAt: now },
        executionInputEnvelope: '{}', automationEvidenceEnvelope: null, workflowAcceptedSnapshotEnvelope: acceptedEnvelope },
        automation: { id: 'automation-park', name: 'Park', enabled: true }, accountCurrentness: V3_CLAIM_CURRENTNESS } };
    });
    const coordinatorParams = { token: 'token', accountId, machineId, storage, requesterWorkAttributionV1: attribution,
      resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
      resolveAccountEncryption: async () => ({ kind: 'available', witness: V3_CLAIM_CURRENTNESS }),
      isAcceptedAuthorizationCurrent: async () => true,
      onReviewEntered: async () => { reviewInventory = await inventory!.read(); admissionDrain.beginTemporaryDrain(); },
      workspaceScm: { realizeWorktree: async () => { throw new Error('unexpected_worktree'); },
        inspectLocation: async () => null, verifyRecordedWorkspace: async () => 'available' },
      execution: { credentials: { token: 'token', encryption: null }, serverId: 'server-1',
        machineAdmissionTransport: async () => { throw new Error('unexpected_message'); },
        resolveExistingSessionConversation: async () => null,
        detachedRun: { actionExecutor: { execute: async () => { throw new Error('unexpected_execution'); } },
          buildActionContext: () => ({ surface: 'cli', authority: 'account_automation' }) } },
    } satisfies Parameters<typeof createProductionWorkflowRunCoordinator>[0] & { requesterWorkAttributionV1: typeof attribution };
    const coordinateWorkflowRun = createProductionWorkflowRunCoordinator(coordinatorParams);
    const workerParams = { token: 'token', credentials: { token: 'token', encryption: null },
      machineId, admissionDrain, coordinateWorkflowRun, requesterWorkAttributionV1: attribution };
    const worker = startCapacityAutomationWorker(workerParams);
    inventory = createManagedActivityInventory({ producers: [worker.liveWorkProducer] });
    const observations: Array<readonly { state: string }[]> = [];
    const unsubscribe = worker.liveWorkProducer.subscribe(() => {
      void Promise.resolve(worker.liveWorkProducer.read()).then(snapshot => observations.push(snapshot.items));
    });
    try {
      await worker.refreshAssignments();
      worker.handleServerUpdate({ id: 'park-wake', seq: 1, createdAt: now, body: {
        t: 'automation-run-updated', runId, automationId: 'automation-park', state: 'queued', scheduledAt: now,
        startedAt: null, finishedAt: null, updatedAt: now, machineId: null, targetMachineId: machineId,
      } } satisfies Update);
      await waitForCondition(() => refreshHeld);
      expect(storage.run().state).toBe('waiting_for_review');
      expect(observations.some(items => items.some(item => item.state === 'active'))).toBe(true);
      expect(reviewInventory).toMatchObject({ coverage: 'complete', items: [
        { category: 'workflow_run', ownerRef: runId, state: 'active', attribution },
      ] });
      expect(projectMachineWorkSummary({ inventory: reviewInventory!, target, custodianAccountId: 'alice',
        requesterIdentities: new Map([[accountId, { accountId, displayName: 'Bob' }]]) })).toEqual({ kind: 'current', requesters: [
          { accountId, displayName: 'Bob', sessions: 0, tasks: 1, terminals: 0 },
        ] });
      expect(await worker.liveWorkProducer.read()).toEqual({ coverage: 'complete', items: [] });
      expect(projectMachineWorkSummary({ inventory: await inventory.read(), target, custodianAccountId: 'alice',
        requesterIdentities: new Map([[accountId, { accountId, displayName: 'Bob' }]]) })).toEqual({ kind: 'current', requesters: [] });
    } finally { unsubscribe(); inventory.dispose(); worker.stop(); for (const release of releaseRefreshes) release(); }
  });

  it.each(['ordinary', 'retained encrypted'] as const)('reads unread scheduled %s predecessor rows through the Account Workflow owner before claiming work', async (kind) => {
    mockPost.mockClear();
    const now = Date.now();
    process.env.HAPPIER_SERVER_URL = 'https://api.example.test';
    process.env.HAPPIER_WEBAPP_URL = 'https://app.example.test';
    process.env.HAPPIER_HOME_DIR = join(os.tmpdir(), `happier-preclaim-conversion-${now}-${Math.random()}`);
    reloadCapacityConfiguration();
    const credentials: StoredCredentials = { token: 'token', encryption: null };
    migrationBoundary.credentials = credentials;
    let row: AutomationDefinitionDetail = { id: 'automation-unread', name: 'Unread scheduled predecessor', description: null,
      enabled: true, targetType: kind === 'ordinary' ? 'newSession' : 'existingSession',
      existingSessionId: kind === 'ordinary' ? null : 'session-old', templateVersion: 1, lastRunAt: null,
      createdAt: now, updatedAt: now, workflowDefinitionId: null, scopeSessionId: null,
      templateCiphertext: kind === 'ordinary' ? AUTOMATION_TEMPLATE_V02_PLAIN : AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED,
      assignments: [{ machineId: 'machine-1', enabled: true, priority: 0, updatedAt: now }], triggers: [] };
    migrationBoundary.list.mockImplementation(async () => ({ automations: [row], nextCursor: null }));
    migrationBoundary.get.mockImplementation(async () => row);
    migrationBoundary.reconcile.mockImplementation(async ({ input }: { input: AutomationDefinitionReconcileRequest }) => {
      if (input.expectedTemplateVersion !== row.templateVersion) throw Object.assign(new Error('currentness_conflict'), { code: 'currentness_conflict' });
      row = { ...row, templateVersion: row.templateVersion + 1, enabled: input.enabled,
        ...(input.executionRecipe ? { targetType: null, templateCiphertext: undefined, executionRecipe: input.executionRecipe } : {}) };
      return row;
    });
    mockGet.mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/encryption/currentness')) return {
        status: 200, data: createAccountCurrentnessResponse(V3_CLAIM_CURRENTNESS, now) };
      if (url.endsWith('/v2/account/settings')) return {
        status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
      return { data: { assignments: [{ machineId: 'machine-1', automationId: row.id, nextClaimAt: now + 60_000 }], settings: DEFAULT_WORKER_SETTINGS } };
    });
    let recipeAtClaim: AutomationDefinitionDetail['executionRecipe'];
    let enabledAtClaim: boolean | undefined;
    let scopeAtClaim: unknown;
    mockPost.mockImplementation(async (_url: string, body: { scope?: string }) => {
      recipeAtClaim = row.executionRecipe;
      enabledAtClaim = row.enabled;
      scopeAtClaim = body.scope;
      return { data: { run: null, automation: null, accountCurrentness: null } };
    });
    const worker = startCapacityAutomationWorker({ token: 'token', credentials, machineId: 'machine-1' });
    try {
      await worker.refreshAssignments();
      worker.handleServerUpdate({ id: 'unread-wake', seq: 1, createdAt: now, body: {
        t: 'automation-run-updated', runId: 'unread-run', automationId: row.id, state: 'queued', scheduledAt: now,
        startedAt: null, finishedAt: null, updatedAt: now, machineId: null, targetMachineId: 'machine-1',
      } } satisfies Update);
      await waitForCondition(() => mockPost.mock.calls.length > 0);
      expect(scopeAtClaim).toBe('workflow');
      if (kind === 'ordinary') {
        expect(recipeAtClaim).toMatchObject({ v: 2 });
        expect(row.executionRecipe).toMatchObject({ v: 2 });
      } else {
        expect(enabledAtClaim).toBe(false);
        expect(recipeAtClaim).toBeUndefined();
        expect(row.executionRecipe).toBeUndefined();
        expect(row.templateCiphertext).toBe(AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED);
      }
      expect(row.id).toBe('automation-unread');
      expect(row.assignments[0]?.machineId).toBe('machine-1');
      expect(row.templateVersion).toBe(2);
    } finally {
      worker.stop();
    }
  });

  it('does not decode or migrate Account definitions while the current assignment inventory contains only Workflow recipes', async () => {
    const now = Date.now();
    process.env.HAPPIER_SERVER_URL = 'https://api.example.test';
    process.env.HAPPIER_WEBAPP_URL = 'https://app.example.test';
    process.env.HAPPIER_HOME_DIR = join(os.tmpdir(), `happier-current-workflow-inventory-${now}-${Math.random()}`);
    reloadCapacityConfiguration();
    mockGet.mockImplementation(async (url: string) => url.endsWith('/v1/account/encryption/currentness')
      ? { status: 200, data: createAccountCurrentnessResponse(V3_CLAIM_CURRENTNESS, now) }
      : { data: { assignments: [{ machineId: 'machine-1', automationId: 'automation-current', nextClaimAt: now,
        executionRecipeVersion: 2 }], settings: DEFAULT_WORKER_SETTINGS } });
    mockPost.mockClear().mockResolvedValue({ data: { run: null, automation: null, accountCurrentness: null } });
    const worker = startCapacityAutomationWorker({ token: 'token-1', credentials: { token: 'token-1', encryption: null }, machineId: 'machine-1' });
    try {
      await worker.refreshAssignments();
      await waitForCondition(() => mockPost.mock.calls.length > 0);
      expect(migrationBoundary.list).not.toHaveBeenCalled();
      expect(migrationBoundary.get).not.toHaveBeenCalled();
      expect(migrationBoundary.reconcile).not.toHaveBeenCalled();
    } finally { worker.stop(); }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();

    if (previousServer === undefined) delete process.env.HAPPIER_SERVER_URL;
    else process.env.HAPPIER_SERVER_URL = previousServer;

    if (previousWebapp === undefined) delete process.env.HAPPIER_WEBAPP_URL;
    else process.env.HAPPIER_WEBAPP_URL = previousWebapp;

    if (previousHomeDir === undefined) delete process.env.HAPPIER_HOME_DIR;
    else process.env.HAPPIER_HOME_DIR = previousHomeDir;
  });

  it('keeps current assignment reads available after a missing endpoint response', async () => {
    process.env.HAPPIER_SERVER_URL = 'https://api.example.test';
    process.env.HAPPIER_WEBAPP_URL = 'https://app.example.test';
    process.env.HAPPIER_HOME_DIR = join(
      os.tmpdir(),
      `happier-automation-worker-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`,
    );

    mockGet.mockImplementation(async (url: string) => { throw createAxios404(url); });
    mockPost.mockResolvedValue({ data: { run: null, automation: null } });

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();

    const { startAutomationWorker } = await import('./automationWorker');
    const worker = startAutomationWorker({
      token: 'token-1',
      credentials: { token: 'token-1', encryption: null },
      machineId: 'machine-1',
      env: { NODE_ENV: 'test',
        HAPPIER_AUTOMATION_CLAIM_POLL_MS: '1000',
        HAPPIER_AUTOMATION_ASSIGNMENT_REFRESH_MS: '5000',
      },
    });

    await waitForCondition(() => mockGet.mock.calls.length >= 1);
    const previousReads = mockGet.mock.calls.length;
    await worker.refreshAssignments();
    expect(mockGet.mock.calls.length).toBeGreaterThan(previousReads);
    expect(mockGet.mock.calls.map((call) => call[0])).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/\/v2\/automations\//),
    ]));
    worker.stop();
  }, 60_000);

  it('drives exact-row Workflow cancellation recovery from the existing machine update when no live claim owns it', async () => {
    mockGet.mockReset();
    mockPost.mockReset();
    process.env.HAPPIER_SERVER_URL = 'https://api.example.test';
    process.env.HAPPIER_WEBAPP_URL = 'https://app.example.test';
    process.env.HAPPIER_HOME_DIR = join(
      os.tmpdir(),
      `happier-automation-worker-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`,
    );
    mockGet
      .mockImplementationOnce((url: unknown) => Promise.reject(createAxios404(String(url))))
      .mockImplementationOnce((url: unknown) => Promise.reject(createAxios404(String(url))));
    const recoverWorkflowRuns = vi.fn(async () => {});

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
    const { startAutomationWorker } = await import('./automationWorker');
    const worker = startAutomationWorker({
      token: 'token-1',
      credentials: { token: 'token-1', encryption: null },
      machineId: 'machine-1',
      recoverWorkflowRuns,
      env: { NODE_ENV: 'test',
        HAPPIER_AUTOMATION_CLAIM_POLL_MS: '1000',
        HAPPIER_AUTOMATION_ASSIGNMENT_REFRESH_MS: '5000',
      },
    });

    try {
      worker.handleServerUpdate({
        id: 'u-workflow-cancel',
        seq: 1,
        createdAt: Date.now(),
        body: {
          t: 'automation-run-updated',
          runId: 'workflow-run-1',
          automationId: null,
          state: 'running',
          scheduledAt: Date.now(),
          startedAt: Date.now(),
          finishedAt: null,
          updatedAt: Date.now(),
          machineId: 'machine-1',
          targetMachineId: 'machine-1',
          workflowControl: 'cancel_requested',
        },
      } satisfies Update);
      await vi.waitFor(() => expect(recoverWorkflowRuns).toHaveBeenCalledOnce());
    } finally {
      worker.stop();
    }
  });

  it('reconciles claimable direct runs even when there are no Automation assignments', async () => {
    vi.useFakeTimers();
    try {
      process.env.HAPPIER_SERVER_URL = 'https://api.example.test';
      process.env.HAPPIER_WEBAPP_URL = 'https://app.example.test';
      process.env.HAPPIER_HOME_DIR = join(
        os.tmpdir(),
        `happier-automation-worker-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`,
      );

      mockGet.mockResolvedValue({ data: { assignments: [], settings: DEFAULT_WORKER_SETTINGS } });
      mockPost.mockResolvedValue({ data: { run: null, automation: null } });

      const { reloadConfiguration } = await import('@/configuration');
      reloadConfiguration();

      const { startAutomationWorker } = await import('./automationWorker');
      const worker = startAutomationWorker({
        token: 'token-1',
      credentials: { token: 'token-1', encryption: null },
        machineId: 'machine-1',
        env: { NODE_ENV: 'test',
          HAPPIER_AUTOMATION_ASSIGNMENT_REFRESH_MS: '600000',
          HAPPIER_AUTOMATION_CLAIM_POLL_MS: '1000',
        },
      });

      await worker.refreshAssignments();

      await vi.advanceTimersByTimeAsync(44_999);
      expect(mockPost).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60_001);
      expect(mockPost).toHaveBeenCalledWith(
        expect.stringContaining('/automations/runs/claim'),
        expect.objectContaining({ machineId: 'machine-1' }),
        expect.anything(),
      );

      worker.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('suppresses assignment refresh while paused and authoritatively refreshes when it resumes', async () => {
    process.env.HAPPIER_SERVER_URL = 'https://api.example.test';
    process.env.HAPPIER_WEBAPP_URL = 'https://app.example.test';
    process.env.HAPPIER_HOME_DIR = join(
      os.tmpdir(),
      `happier-automation-worker-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`,
    );

    mockGet.mockResolvedValue({ data: { assignments: [], settings: DEFAULT_WORKER_SETTINGS } });
    mockPost.mockResolvedValue({ data: { run: null, automation: null } });

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();

    const { startAutomationWorker } = await import('./automationWorker');
    const worker = startAutomationWorker({
      token: 'token-1',
      credentials: { token: 'token-1', encryption: null },
      machineId: 'machine-1',
      env: { NODE_ENV: 'test',
        HAPPIER_AUTOMATION_ASSIGNMENT_REFRESH_MS: '600000',
        HAPPIER_AUTOMATION_CLAIM_POLL_MS: '1000',
      },
    });

    await worker.refreshAssignments();
    // The worker also fires one unawaited startup refresh. Drain it before the
    // baseline, or a slow cold start lets its request land after the clear and
    // masks a missing resume refresh.
    await settleRequestDispatch();
    mockGet.mockClear();

    worker.pause();
    await worker.refreshAssignments();
    expect(mockGet).not.toHaveBeenCalled();

    worker.resume();
    await settleRequestDispatch();
    expect(mockGet).toHaveBeenCalledTimes(1);

    worker.stop();
  });

  it('reconciles assignments within the 60-second jittered ceiling after an empty successful read', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(Math, 'random').mockReturnValue(1 - Number.EPSILON);
      process.env.HAPPIER_SERVER_URL = 'https://api.example.test';
      process.env.HAPPIER_WEBAPP_URL = 'https://app.example.test';
      process.env.HAPPIER_HOME_DIR = join(
        os.tmpdir(),
        `happier-automation-worker-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`,
      );

      mockGet.mockResolvedValue({ data: { assignments: [], settings: DEFAULT_WORKER_SETTINGS } });
      mockPost.mockResolvedValue({ data: { run: null, automation: null } });

      const { reloadConfiguration } = await import('@/configuration');
      reloadConfiguration();

      const { startAutomationWorker } = await import('./automationWorker');
      const worker = startAutomationWorker({
        token: 'token-1',
      credentials: { token: 'token-1', encryption: null },
        machineId: 'machine-1',
        env: { NODE_ENV: 'test',
          HAPPIER_AUTOMATION_ASSIGNMENT_REFRESH_MS: '5000',
          HAPPIER_AUTOMATION_CLAIM_POLL_MS: '1000',
        },
      });

      await settleRequestDispatch();
      expect(mockGet).toHaveBeenCalledTimes(1);

      // Advance the clock synchronously so each assertion measures only the timer
      // boundary, then drain the request dispatch that the tick started.
      vi.advanceTimersByTime(59_999);
      await settleRequestDispatch();
      expect(mockGet).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1);
      await settleRequestDispatch();
      expect(mockGet).toHaveBeenCalledTimes(2);

      worker.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a failed initial assignment read within the reconciliation window', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(Math, 'random').mockReturnValue(0);
      process.env.HAPPIER_SERVER_URL = 'https://api.example.test';
      process.env.HAPPIER_WEBAPP_URL = 'https://app.example.test';
      process.env.HAPPIER_HOME_DIR = join(
        os.tmpdir(),
        `happier-automation-worker-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`,
      );

      mockGet
        .mockRejectedValueOnce(new Error('initial assignments read failed'))
        .mockResolvedValue({ data: { assignments: [], settings: DEFAULT_WORKER_SETTINGS } });
      mockPost.mockResolvedValue({ data: { run: null, automation: null } });

      const { reloadConfiguration } = await import('@/configuration');
      reloadConfiguration();

      const { startAutomationWorker } = await import('./automationWorker');
      const worker = startAutomationWorker({
        token: 'token-1',
      credentials: { token: 'token-1', encryption: null },
        machineId: 'machine-1',
        env: { NODE_ENV: 'test',
          HAPPIER_AUTOMATION_ASSIGNMENT_REFRESH_MS: '600000',
          HAPPIER_AUTOMATION_CLAIM_POLL_MS: '1000',
        },
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(mockGet).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(45_000);
      expect(mockGet).toHaveBeenCalledTimes(2);

      worker.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('claims after a queued direct-run wake with an empty Automation assignment cache', async () => {
    vi.useFakeTimers();
    try {
      process.env.HAPPIER_SERVER_URL = 'https://api.example.test';
      process.env.HAPPIER_WEBAPP_URL = 'https://app.example.test';
      process.env.HAPPIER_HOME_DIR = join(
        os.tmpdir(),
        `happier-automation-worker-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`,
      );

      mockGet.mockResolvedValue({ data: { assignments: [], settings: DEFAULT_WORKER_SETTINGS } });
      mockPost.mockResolvedValue({ data: { run: null, automation: null } });

      const { reloadConfiguration } = await import('@/configuration');
      reloadConfiguration();

      const { startAutomationWorker } = await import('./automationWorker');
      const worker = startAutomationWorker({
        token: 'token-1',
      credentials: { token: 'token-1', encryption: null },
        machineId: 'machine-1',
        env: { NODE_ENV: 'test',
          HAPPIER_AUTOMATION_ASSIGNMENT_REFRESH_MS: '600000',
          HAPPIER_AUTOMATION_CLAIM_POLL_MS: '1000',
        },
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(mockGet).toHaveBeenCalledTimes(1);

      worker.handleServerUpdate({
        id: 'u-run',
        seq: 1,
        createdAt: Date.now(),
        body: {
          t: 'automation-run-updated',
          runId: 'run-1',
          automationId: null,
          state: 'queued',
          scheduledAt: Date.now(),
          startedAt: null,
          finishedAt: null,
          updatedAt: Date.now(),
          machineId: null,
          targetMachineId: 'machine-1',
        },
      } as any);

      await vi.advanceTimersByTimeAsync(0);
      expect(mockGet).toHaveBeenCalledTimes(2);
      expect(mockPost).toHaveBeenCalledWith(
        expect.stringContaining('/automations/runs/claim'),
        expect.objectContaining({ machineId: 'machine-1' }),
        expect.anything(),
      );

      worker.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let an older empty assignment response erase a newer queued-wake assignment', async () => {
    vi.useFakeTimers();
    let worker: ReturnType<typeof startAutomationWorker> | undefined;
    try {
      vi.setSystemTime(new Date('2026-02-01T00:00:00.000Z'));
      const now = Date.now();
      process.env.HAPPIER_SERVER_URL = 'https://api.example.test';
      process.env.HAPPIER_WEBAPP_URL = 'https://app.example.test';
      process.env.HAPPIER_HOME_DIR = join(
        os.tmpdir(),
        `happier-automation-worker-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`,
      );

      let resolveOlderAssignments!: (value: {
        data: { assignments: never[]; settings: typeof DEFAULT_WORKER_SETTINGS };
      }) => void;
      let resolveNewerAssignments!: (value: {
        data: {
          assignments: Array<{
            machineId: string;
            automationId: string;
            nextClaimAt: number;
            executionRecipeVersion: 2;
          }>;
          settings: typeof DEFAULT_WORKER_SETTINGS;
        };
      }) => void;
      mockGet
        .mockImplementationOnce(() => new Promise((resolve) => {
          resolveOlderAssignments = resolve;
        }))
        .mockImplementationOnce(() => new Promise((resolve) => {
          resolveNewerAssignments = resolve;
        }));
      mockPost.mockResolvedValue({ data: { run: null, automation: null, accountCurrentness: null } });

      const { reloadConfiguration } = await import('@/configuration');
      reloadConfiguration();

      const { startAutomationWorker } = await import('./automationWorker');
      worker = startAutomationWorker({
        token: 'token-1',
      credentials: { token: 'token-1', encryption: null },
        machineId: 'machine-1',
        env: { NODE_ENV: 'test',
          HAPPIER_AUTOMATION_ASSIGNMENT_REFRESH_MS: '600000',
          HAPPIER_AUTOMATION_CLAIM_POLL_MS: '1000',
          HAPPIER_AUTOMATION_LEASE_MS: '30000',
        },
      });

      await settleRequestDispatch();
      expect(mockGet).toHaveBeenCalledTimes(1);
      worker.handleServerUpdate({
        id: 'u-run',
        seq: 1,
        createdAt: now,
        body: {
          t: 'automation-run-updated',
          runId: 'run-1',
          automationId: 'automation-1',
          state: 'queued',
          scheduledAt: now,
          startedAt: null,
          finishedAt: null,
          updatedAt: now,
          machineId: null,
          targetMachineId: 'machine-1',
        },
      } as any);
      await vi.advanceTimersByTimeAsync(0);
      await settleRequestDispatch();
      expect(mockGet).toHaveBeenCalledTimes(2);

      resolveNewerAssignments({
        data: {
          assignments: [{
            machineId: 'machine-1',
            automationId: 'automation-1',
            nextClaimAt: now + 60_000,
            // This cadence fixture represents a current Workflow definition;
            // unread predecessor reconciliation has separate real-owner tests.
            executionRecipeVersion: 2,
          }],
          settings: DEFAULT_WORKER_SETTINGS,
        },
      });
      await settleRequestDispatch();

      // Let the stale response settle BEFORE the queued-wake claim timer fires, so
      // the assertion fails if a late older snapshot is allowed to erase the cache.
      resolveOlderAssignments({ data: { assignments: [], settings: DEFAULT_WORKER_SETTINGS } });
      await settleRequestDispatch();

      vi.advanceTimersByTime(0);
      await settleRequestDispatch();

      expect(mockPost).toHaveBeenCalledTimes(1);

      worker.stop();
    } finally {
      worker?.stop();
      vi.useRealTimers();
    }
  });

  it('checks for direct runs at reconciliation and scheduled runs at V3 nextClaimAt without continuous polling', async () => {
    vi.useFakeTimers();
    let worker: ReturnType<typeof startAutomationWorker> | undefined;
    try {
      vi.spyOn(Math, 'random').mockReturnValue(0);
      vi.setSystemTime(new Date('2026-02-01T00:00:00.000Z'));
      const now = Date.now();

      process.env.HAPPIER_SERVER_URL = 'https://api.example.test';
      process.env.HAPPIER_WEBAPP_URL = 'https://app.example.test';
      process.env.HAPPIER_HOME_DIR = join(
        os.tmpdir(),
        `happier-automation-worker-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`,
      );

      mockGet
        .mockResolvedValueOnce({ data: { assignments: [], settings: DEFAULT_WORKER_SETTINGS } })
        .mockResolvedValueOnce({
          data: {
            assignments: [{
              machineId: 'machine-1',
              automationId: 'automation-1',
              nextClaimAt: now + 60_000,
              executionRecipeVersion: 2,
            }],
            settings: DEFAULT_WORKER_SETTINGS,
          },
        })
        .mockResolvedValue({
          data: {
            assignments: [{
              machineId: 'machine-1',
              automationId: 'automation-1',
              nextClaimAt: now + 60_000,
              executionRecipeVersion: 2,
            }],
            settings: DEFAULT_WORKER_SETTINGS,
          },
        });

      mockPost.mockResolvedValue({ data: { run: null, automation: null, accountCurrentness: null } });

      const { reloadConfiguration } = await import('@/configuration');
      reloadConfiguration();

      const { startAutomationWorker } = await import('./automationWorker');
      worker = startAutomationWorker({
        token: 'token-1',
      credentials: { token: 'token-1', encryption: null },
        machineId: 'machine-1',
        env: { NODE_ENV: 'test',
          HAPPIER_AUTOMATION_ASSIGNMENT_REFRESH_MS: '600000',
          HAPPIER_AUTOMATION_CLAIM_POLL_MS: '1000',
          HAPPIER_AUTOMATION_LEASE_MS: '30000',
        },
      });

      await worker.refreshAssignments();

      await vi.advanceTimersByTimeAsync(44_999);
      expect(mockPost).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(mockPost).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(16_000);
      expect(mockPost).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mockPost).toHaveBeenCalledTimes(2);

      worker.stop();
    } finally {
      worker?.stop();
      vi.useRealTimers();
    }
  });

  it('reacts to automation-assignment updates from the server by refreshing assignments', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-02-01T00:00:00.000Z'));

      process.env.HAPPIER_SERVER_URL = 'https://api.example.test';
      process.env.HAPPIER_WEBAPP_URL = 'https://app.example.test';
      process.env.HAPPIER_HOME_DIR = join(
        os.tmpdir(),
        `happier-automation-worker-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`,
      );

      mockGet.mockResolvedValue({ data: { assignments: [], settings: DEFAULT_WORKER_SETTINGS } });
      mockPost.mockResolvedValue({ data: { run: null, automation: null } });

      const { reloadConfiguration } = await import('@/configuration');
      reloadConfiguration();

      const { startAutomationWorker } = await import('./automationWorker');
      const worker = startAutomationWorker({
        token: 'token-1',
      credentials: { token: 'token-1', encryption: null },
        machineId: 'machine-1',
        env: { NODE_ENV: 'test',
          HAPPIER_AUTOMATION_ASSIGNMENT_REFRESH_MS: '600000',
          HAPPIER_AUTOMATION_CLAIM_POLL_MS: '1000',
        },
      });

      // Allow any initial background refresh to complete.
      await vi.advanceTimersByTimeAsync(0);
      const callsBefore = mockGet.mock.calls.length;

      worker.handleServerUpdate({
        id: 'u-1',
        seq: 1,
        createdAt: Date.now(),
        body: {
          t: 'automation-assignment-updated',
          machineId: 'machine-1',
          automationId: 'automation-1',
          enabled: true,
          updatedAt: Date.now(),
        },
      } as any);

      await vi.advanceTimersByTimeAsync(300);
      expect(mockGet.mock.calls.length).toBeGreaterThan(callsBefore);

      worker.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('claims after a queued run wake arrives before assignments refresh catches up', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-02-01T00:00:00.000Z'));
      const now = Date.now();

      process.env.HAPPIER_SERVER_URL = 'https://api.example.test';
      process.env.HAPPIER_WEBAPP_URL = 'https://app.example.test';
      process.env.HAPPIER_HOME_DIR = join(
        os.tmpdir(),
        `happier-automation-worker-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`,
      );

      mockGet
        .mockResolvedValueOnce({ data: { assignments: [], settings: DEFAULT_WORKER_SETTINGS } })
        .mockResolvedValueOnce({
          data: {
            assignments: [{
              machineId: 'machine-1',
              automationId: 'automation-1',
              nextClaimAt: now + 60_000,
            }],
            settings: DEFAULT_WORKER_SETTINGS,
          },
        });
      mockPost.mockResolvedValue({ data: { run: null, automation: null } });

      const { reloadConfiguration } = await import('@/configuration');
      reloadConfiguration();

      const { startAutomationWorker } = await import('./automationWorker');
      const worker = startAutomationWorker({
        token: 'token-1',
      credentials: { token: 'token-1', encryption: null },
        machineId: 'machine-1',
        env: { NODE_ENV: 'test',
          HAPPIER_AUTOMATION_ASSIGNMENT_REFRESH_MS: '600000',
          HAPPIER_AUTOMATION_CLAIM_POLL_MS: '1000',
          HAPPIER_AUTOMATION_LEASE_MS: '30000',
        },
      });

      await vi.advanceTimersByTimeAsync(0);
      mockPost.mockClear();

      worker.handleServerUpdate({
        id: 'u-run',
        seq: 1,
        createdAt: now,
        body: {
          t: 'automation-run-updated',
          runId: 'run-1',
          automationId: 'automation-1',
          state: 'queued',
          scheduledAt: now,
          startedAt: null,
          finishedAt: null,
          updatedAt: now,
          machineId: null,
          targetMachineId: 'machine-1',
        },
      } as any);

      worker.handleServerUpdate({
        id: 'u-assignment',
        seq: 2,
        createdAt: now,
        body: {
          t: 'automation-assignment-updated',
          machineId: 'machine-1',
          automationId: 'automation-1',
          enabled: true,
          updatedAt: now,
        },
      } as any);

      await vi.advanceTimersByTimeAsync(300);

      expect(mockGet.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(mockPost).toHaveBeenCalledTimes(1);

      worker.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps one claim when queued wakes overlap asynchronous assignment preparation', async () => {
    const now = Date.now();
    process.env.HAPPIER_SERVER_URL = 'https://api.example.test';
    process.env.HAPPIER_WEBAPP_URL = 'https://app.example.test';
    process.env.HAPPIER_HOME_DIR = join(os.tmpdir(), `happier-claim-preparation-${now}-${Math.random()}`);
    const assignmentSnapshot = { data: { assignments: [], settings: { maxActiveRunsPerMachine: 1 } } };
    let holdReads = false;
    const releaseAssignmentReads: Array<() => void> = [];
    mockGet.mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/encryption/currentness')) {
        return { status: 200, data: createAccountCurrentnessResponse(V3_CLAIM_CURRENTNESS, now) };
      }
      if (holdReads) await new Promise<void>((resolve) => releaseAssignmentReads.push(resolve));
      return assignmentSnapshot;
    });
    const scopes: Array<string | undefined> = [];
    const releaseWorkflowClaims: Array<() => void> = [];
    mockPost.mockImplementation(async (url: string, body: { scope?: string }) => {
      if (url.endsWith('/v3/automations/runs/claim')) {
        scopes.push(body.scope);
        if (releaseWorkflowClaims.length === 2) return { data: { run: null, automation: null, accountCurrentness: null } };
        await new Promise<void>((resolve) => releaseWorkflowClaims.push(resolve));
        return { data: { run: null, automation: null, accountCurrentness: null } };
      }
      if (url.endsWith('/start')) return { data: {
        ...createV3StartResponse({ runId: url.split('/').at(-2)!, now, attempt: 1 }), accountCurrentness: V3_CLAIM_CURRENTNESS,
      } };
      return { data: { ok: true } };
    });
    reloadCapacityConfiguration();
    const worker = startCapacityAutomationWorker({ token: 'preparation-token', credentials: { token: 'preparation-token', encryption: null }, machineId: 'machine-1' });
    const wake = () => worker.handleServerUpdate({ id: 'preparation-wake', seq: 1, createdAt: now,
      body: { t: 'automation-run-updated', runId: 'preparation-1', automationId: 'automation-1', state: 'queued',
        scheduledAt: now, startedAt: null, finishedAt: null, updatedAt: now, machineId: null, targetMachineId: 'machine-1' },
    } satisfies Update);
    try {
      await worker.refreshAssignments();
      holdReads = true;
      wake();
      await waitForCondition(() => releaseAssignmentReads.length === 1);
      wake();
      await waitForCondition(() => releaseAssignmentReads.length === 2);
      holdReads = false;
      releaseAssignmentReads[0]!();
      await waitForCondition(() => releaseWorkflowClaims.length === 1);
      releaseAssignmentReads[1]!();
      await settleRequestDispatch();
      expect(releaseWorkflowClaims).toHaveLength(1);
      expect(scopes).toEqual(['workflow']);
    } finally {
      worker.stop();
      holdReads = false;
      for (const release of releaseAssignmentReads) release();
      for (const release of releaseWorkflowClaims) release();
    }
  });

  it.each([
    { ending: 'settle', budget: 1 }, { ending: 'cancel_waiter', budget: 1 },
    { ending: 'settle', budget: DEFAULT_AUTOMATION_V3_MAX_ACTIVE_RUNS_PER_MACHINE },
  ] as const)('admits Account and Session destination writes at full start capacity ($ending, budget $budget)', async ({ ending, budget }) => {
    const now = Date.now();
    const directory = realpathSync(process.cwd());
    process.env.HAPPIER_SERVER_URL = 'https://api.example.test';
    process.env.HAPPIER_WEBAPP_URL = 'https://app.example.test';
    process.env.HAPPIER_HOME_DIR = join(os.tmpdir(), `happier-destination-capacity-${now}-${Math.random()}`);
    reloadCapacityConfiguration();
    const machineId = 'machine-1';
    const accountId = 'account-1';
    const kinds: Array<'fresh' | 'origin_session' | 'existing_session'> = [
      ...Array.from({ length: budget }, () => 'fresh' as const), 'origin_session', 'existing_session', 'fresh',
    ];
    const ids = kinds.map((_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`);
    const destinationIndex = budget;
    const waiterIndex = budget + 2;
    let projectedBudget: number = budget;
    const accepted = await Promise.all(kinds.map(async (kind, index) => {
      const result = await materializeWorkflowAcceptedSnapshotV1({
        definition: { version: 1, defaults: {
          agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
          conversation: kind === 'existing_session' ? { kind, sessionId: 'destination', machineId } : { kind },
        }, blocks: [{ kind: 'step', id: 'write', document: { text: 'Write', references: [], attachments: [] } }] },
        context: { source: { kind: 'automation', automationId: `automation-${index}` }, inputs: {}, machineId,
          executionTarget: { kind: 'session' },
          workspaceTarget: { project: { machineId, directory, checkoutRootPath: directory } },
          ...(kind === 'origin_session' ? { origin: { kind: 'direct', originSessionId: 'destination' } } : {}),
          authorization: { principal: { kind: 'host' } } },
        admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true },
      });
      if (!result.ok) throw new Error(result.error.code);
      return serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
        mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId: ids[index]! }, acceptedSnapshot: result.snapshot,
      }));
    }));
    const stores = ids.map((id, index) => createWorkflowRunStorageTestkit({ runId: id, machineId,
      origin: { kind: 'automation', automationId: `automation-${index}` }, acceptedEnvelope: accepted[index], state: 'claimed',
      keyCensus: { ...createPlainWorkflowRunKeyCensusFixture({ runId: id, accountId }), ownerAccountCurrentness: V3_CLAIM_CURRENTNESS } }));
    const claims: Array<string | undefined> = [];
    const httpObservations: Array<Readonly<{ method: 'GET' | 'POST'; path: string; elapsedMs: number }>> = [];
    let ordinal = 0;
    const destination = createSessionRecordFixture({ id: 'destination', active: true, encryptionMode: 'plain', machineId,
      metadata: JSON.stringify({ machineId, path: directory, claudeSessionId: 'native-session',
        runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} } }) });
    mockGet.mockImplementation(async (url: string) => {
      httpObservations.push({ method: 'GET', path: new URL(url).pathname, elapsedMs: Date.now() - now });
      if (url.endsWith('/v1/account/encryption/currentness')) return {
        status: 200, data: createAccountCurrentnessResponse(V3_CLAIM_CURRENTNESS, now) };
      if (url.endsWith('/v2/account/settings')) return {
        status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
      // Fresh Session preparation reads Account defaults through the real
      // invocation-scoped purpose owner. The assignments response below is
      // not valid catalog content and must not stand in for native defaults.
      if (url.endsWith(`${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/purposes`)) return {
        status: 200, data: ConnectedAccountCatalogRowReadResponseV1Schema.parse({
          status: 'present', revision: 1,
          content: { t: 'plain', v: emptyConnectedAccountCatalogRecordV1('purposes') },
        }) };
      if (url.endsWith('/v2/sessions/destination')) return { status: 200, data: { session: destination } };
      return { data: { assignments: [{ machineId, automationId: 'automation-0', nextClaimAt: now + 60_000,
        executionRecipeVersion: 2 }], settings: { maxActiveRunsPerMachine: projectedBudget } } };
    });
    mockPost.mockImplementation(async (url: string, body: { scope?: string; tags?: string[] }) => {
      httpObservations.push({ method: 'POST', path: new URL(url).pathname, elapsedMs: Date.now() - now });
      if (url.endsWith('/v2/sessions/lookup-by-tags')) {
        return { status: 200, data: { sessions: body.tags?.includes('destination') ? [destination] : [] } };
      }
      if (url.endsWith('/start')) return { data: { ...createV3StartResponse({ runId: ids[0]!, now, attempt: 1 }), accountCurrentness: V3_CLAIM_CURRENTNESS } };
      if (!url.endsWith('/v3/automations/runs/claim')) return { data: { ok: true } };
      claims.push(body.scope);
      const index = ordinal++;
      return { data: index >= ids.length ? { run: null, automation: null, accountCurrentness: null } : {
        run: { id: ids[index], automationId: `automation-${index}`, attempt: 1, revision: 0, recipeKind: 'workflow-v2',
          triggerId: null, triggerRetired: false, cause: { kind: 'manual', invokedAt: now },
          executionInputEnvelope: '{}', automationEvidenceEnvelope: null, workflowAcceptedSnapshotEnvelope: accepted[index] },
        automation: { id: `automation-${index}`, name: 'Capacity', enabled: true,
          ...(index === 0 || index === destinationIndex ? { scopeSessionId: 'destination' } : {}) }, accountCurrentness: V3_CLAIM_CURRENTNESS,
      } };
    });
    const starts: Array<() => void> = [];
    const writes: string[] = [];
    const startSignals: AbortSignal[] = [];
    const coordinationErrors: unknown[] = [];
    const coordinationResults: unknown[] = [];
    let resolveFreshStartup!: () => void;
    let rejectFreshStartup!: (error: unknown) => void;
    const freshStartup = new Promise<void>((resolve, reject) => {
      resolveFreshStartup = resolve;
      rejectFreshStartup = reject;
    });
    void freshStartup.catch(() => undefined);
    freshSpawnBoundary.mockImplementation(async (request: Parameters<typeof import('@/session/transport/rpc/machineRpc').callMachineRpc>[0]) => {
      if (request.signal) startSignals.push(request.signal);
      await new Promise<void>(resolve => {
        starts.push(resolve);
        if (starts.length === budget) resolveFreshStartup();
      });
      throw new Error('start_boundary_stopped');
    });
    const coordinators = stores.map((storage, index) => createProductionWorkflowRunCoordinator({
      token: 'token', accountId, machineId, storage,
      resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
      resolveAccountEncryption: async () => ({ kind: 'available', witness: V3_CLAIM_CURRENTNESS }),
      isAcceptedAuthorizationCurrent: async () => true,
      workspaceScm: { realizeWorktree: async () => { throw new Error('unexpected_worktree'); },
        inspectLocation: async () => null, verifyRecordedWorkspace: async () => 'available' },
      execution: { credentials: { token: 'token', encryption: null }, serverId: 'server-1',
        machineAdmissionTransport: async () => { throw new Error('unexpected_message_admission'); },
        resolveExistingSessionConversation: async () => ({ sessionId: 'destination', machineId, directory }),
        sessionInput: { enqueue: async request => ({ status: 'accepted', localId: deriveWorkflowSessionInputLocalIdV2(request.workflow) }),
          observe: async ({ sessionId, localId }) => { writes.push(ids[index]!);
            return { ok: true, sessionId, localId, result: { kind: 'final_text', text: 'Written' } }; } },
        detachedRun: { actionExecutor: { execute: async () => { throw new Error('unexpected_detached'); } },
          buildActionContext: () => ({ surface: 'cli', authority: 'account_automation' }) },
      },
    }));
    const worker = startCapacityAutomationWorker({ token: 'token', credentials: { token: 'token', encryption: null }, machineId,
      coordinateWorkflowRun: async claim => {
        try { const result = await coordinators[ids.indexOf(claim.runId)]!(claim); coordinationResults.push(result); return result; }
        catch (error) { coordinationErrors.push(error); rejectFreshStartup(error); throw error; }
      },
    });
    try {
      await worker.refreshAssignments();
      worker.handleServerUpdate({ id: 'wake', seq: 1, createdAt: now, body: { t: 'automation-run-updated',
        runId: ids[0]!, automationId: 'automation-0', state: 'queued', scheduledAt: now, startedAt: null,
        finishedAt: null, updatedAt: now, machineId: null, targetMachineId: machineId } } satisfies Update);
      // Await genuine process admission, including first-use source preparation,
      // before timing the capacity behavior. A shorter fixture polling deadline
      // must not race the actual settings/native startup boundary.
      await freshStartup;
      await waitForCondition(() => (starts.length === budget && writes.length === 2 && ordinal > ids.length && stores[waiterIndex]!.rows().length > 0) || coordinationErrors.length > 0 || coordinationResults.length >= ids.length).catch(async error => {
        const activity = await worker.liveWorkProducer.read();
        throw new Error(JSON.stringify({ claims, ordinal, starts: starts.length, writes, coordinationResults,
          httpObservations, activity: { coverage: activity.coverage,
            items: activity.items.map(item => ({ category: item.category, attribution: item.attribution, state: item.state })) },
          states: stores.map(store => store.run().state), progress: stores.map(store => store.rows()), operations: stores.map(store => store.operations()) }), { cause: error });
      });
      expect(coordinationErrors).toEqual([]);
      expect({ starts: starts.length, writes: writes.length }, JSON.stringify({ coordinationResults, progress: stores.map(store => store.rows()) })).toEqual({ starts: budget, writes: 2 });
      expect(new Set(writes)).toEqual(new Set([ids[destinationIndex], ids[destinationIndex + 1]]));
      expect(claims).toContain('workflow');
      expect(stores[destinationIndex]!.run().state).toBe('succeeded');
      expect(stores[destinationIndex + 1]!.run().state).toBe('succeeded');
      expect(stores[waiterIndex]!.rows()).toHaveLength(1); // Accepted root, no Agent leaf admitted while full.
      if (ending === 'settle') {
        starts[0]!();
        await waitForCondition(() => stores[waiterIndex]!.rows().length > 1);
        if (budget === DEFAULT_AUTOMATION_V3_MAX_ACTIVE_RUNS_PER_MACHINE) {
          projectedBudget = 2;
          await worker.refreshAssignments();
          expect(startSignals.length).toBeGreaterThanOrEqual(budget);
          expect(startSignals.every(signal => !signal.aborted)).toBe(true);
        }
      } else {
        worker.stop();
        await waitForCondition(() => coordinationErrors.length === 1);
        starts[0]!();
        expect(stores[waiterIndex]!.rows()).toHaveLength(1);
      }
    } finally {
      worker.stop();
      for (const release of starts) release();
    }
  });

});
