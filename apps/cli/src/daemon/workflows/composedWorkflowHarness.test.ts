import { createTestWorkflowCoordinator as createWorkflowCoordinator } from './workflowCoordinator.testkit';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import {
  admitAgentStartV1,
  createAccountScopedCryptoMaterialSnapshotV1,
  convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1,
  AutomationRunCauseSchema,
  AutomationTriggerIdSchema,
  AutomationStoredWorkflowDefinitionV2Schema,
  AutomationV3RunMutationResponseSchema,
  DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1,
  deriveAutomationOccurrenceKeyV1,
  WorkflowProgressEnvelopeV1Schema,
  openWorkflowAcceptedSnapshotStoredEnvelopeV1,
  openWorkflowProgressStoredEnvelopeV1,
  materializeWorkflowAcceptedSnapshotV1,
  parseWorkflowStoredContentEnvelopeV1,
  prepareWorkflowRunDataKeyV1,
  resolveWorkflowRunDataKeyV1,
  WorkflowRunRecipientCensusResponseV1Schema,
  sealWorkflowAcceptedSnapshotStoredEnvelopeV1,
  sealAccountScopedBlobCiphertext,
  serializeWorkflowStoredContentEnvelopeV1,
  serializeAutomationRunExecutionRecipeV1,
  type WorkflowDefinitionV1,
  type WorkflowRunDataKeyV1,
  type WorkflowRunInvocationIndexV1,
  type WorkflowStep,
} from '@happier-dev/protocol';
import type { SessionInputResultV1 } from '@/session/services/sendSessionMessage';
import type { AvailableAutomationAccountEncryptionV1 } from '@/plugins/runtime/automations/automationAccountCurrentness';
import type { StoredCredentials } from '@/persistence';
import type { AutomationDefinitionDetail, AutomationDefinitionReconcileRequest } from '@happier-dev/protocol';
import { createAccountWorkflowTriggerActions } from '@happier-dev/protocol/actions/executor/workflowTriggerAccountHost';
import { AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED, AUTOMATION_TEMPLATE_V02_EXISTING_PLAIN } from '../../../../../packages/protocol/src/automations/automationTemplateV02.testFixtures';
import { createAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

// Machine RPC is the process-launch boundary. Keep authorization, persisted
// Agent resume selection and readiness-before-input ownership real.
vi.mock('@/session/transport/rpc/machineRpc', () => {
  const resumed = new Map<string, string>();
  return { callMachineRpc: async ({ method, request }: {
    method: string; request: { sessionId?: string; spawnNonce?: string };
  }) => {
    if (method === RPC_METHODS.SPAWN_HAPPY_SESSION && request.sessionId && request.spawnNonce) {
      resumed.set(request.spawnNonce, request.sessionId);
      return { type: 'success', sessionId: request.sessionId };
    }
    return { status: 'success', sessionId: resumed.get(request.spawnNonce ?? '') };
  } };
});

import { executeClaimedRun } from '@/daemon/automation/automationRunExecutor';
import { createAutomationClaimClient } from '@/daemon/automation/automationClaimClient';
import { dispatchActionFromRpc } from '@/rpc/handlers/_actionDispatchAdapter';
import { createWorkflowActionExecutor } from '@/session/actions/workflowActionExecutor';
import { createWorkflowRunActionOwner } from '@/session/actions/workflowRunActions';
import {  workflowInvocationKey } from './coordinator';
import { createInMemoryWorkflowCoordinatorStore } from './workflowCoordinator.testkit';
import { createWorkflowInvocationRecoveryObserver } from './daemonRuntime';
import { createWorkflowRunRecoveryReader } from './recovery';
import { createGitWorkflowWorkspaceTestDependencies } from './workflowWorkspace.testkit';
import { createWorkflowProducerBinding } from './workflowScopeBinding';
import { bindAutomationWorkflowInputs, isWorkflowJsonObject } from './input';
import { createProductionWorkflowRunCoordinator } from './production';
import { createWorkflowSessionStepExecutor } from './sessionStepExecutor';
import {
  createWorkflowRunStorageTestkit,
  type WorkflowRunStorageTestkit,
  type WorkflowRunStorageTestkitOperation,
} from './workflowRunStorage.testkit';
import {
  createCoordinatorWorkspaceResolver,
  normalizeWorkflowProjectTarget,
  prepareWorkflowAcceptedWorkspaceTarget,
  resolveWorkflowWorkspace,
} from './resolveWorkflowWorkspace';

const accountId = 'account-1';
const machineId = 'machine-1';
const sessionId = 'session-1';
const currentness = { mode: 'plain' as const, version: 1, contentKeyFingerprint: null };
const authorization = { admittedPermissionCeiling: 'safe-yolo' as const, principal: { kind: 'host' as const } };
const agentTarget = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } };

const temporaryDirectories: string[] = [];
const authorizedConversations = new Map<string, string>();
let readinessCurrentness: AvailableAutomationAccountEncryptionV1['witness'] = currentness;

async function readSessionReadiness(url: string) {
  if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200,
    data: createAccountEncryptionCurrentnessFixture({ ...readinessCurrentness, updatedAt: 1 }) };
  const id = /\/v2\/sessions\/([^/?]+)/.exec(url)?.[1];
  const directory = id ? authorizedConversations.get(id) : undefined;
  if (!id || !directory) throw new Error(`Unexpected Session readiness read: ${url}`);
  return { status: 200, data: { session: createSessionRecordFixture({ id, active: true,
    encryptionMode: 'plain', machineId, metadata: JSON.stringify({ machineId, path: directory,
      claudeSessionId: 'native-session', runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} },
    }),
  }) } };
}

async function writeSessionReadiness(url: string, body: unknown) {
  if (!url.endsWith('/v2/sessions/lookup-by-tags') || !body || typeof body !== 'object'
    || !('tags' in body) || !Array.isArray(body.tags) || typeof body.tags[0] !== 'string') {
    throw new Error(`Unexpected Session readiness write: ${url}`);
  }
  const response = await readSessionReadiness(`/v2/sessions/${body.tags[0]}`);
  if (!('session' in response.data)) throw new Error('Session readiness response missing record');
  return { status: 200, data: { sessions: [response.data.session] } };
}

beforeEach(() => {
  authorizedConversations.clear();
  readinessCurrentness = currentness;
  vi.spyOn(axios, 'get').mockImplementation(readSessionReadiness);
  vi.spyOn(axios, 'post').mockImplementation(writeSessionReadiness);
});

afterEach(async () => {
  vi.restoreAllMocks();
  while (temporaryDirectories.length > 0) {
    await rm(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

/**
 * A real project directory. The production workspace resolver stats and
 * inspects the accepted checkout through the canonical SCM/path owners, so a
 * composed run cannot use an invented `/repo` string.
 */
async function projectDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'happier-composed-workflow-'));
  temporaryDirectories.push(directory);
  return directory;
}

function step(id: string, overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return {
    kind: 'step', id, document: { text: id, references: [], attachments: [] },
    input: [], result: { kind: 'text' }, ...overrides,
  } as WorkflowStep;
}

/** Every composed definition reuses one already-open conversation so the leaf never spawns a real Session. */
function retainedConversationDefaults() {
  return { agentTarget, conversation: { kind: 'existing_session' as const, sessionId, machineId } };
}

async function sealDirectAccepted(input: Readonly<{
  runId: string;
  definition: WorkflowDefinitionV1;
  directory: string;
  deliverResult?: boolean;
  runCrypto?: WorkflowRunDataKeyV1;
}>): Promise<string> {
  const runCrypto = input.runCrypto ?? { mode: 'plain' as const };
  const sealMode = runCrypto.mode === 'e2ee'
    ? { ...runCrypto, randomBytes: (length: number) => new Uint8Array(length).fill(3) } : runCrypto;
  const materialized = await materializeWorkflowAcceptedSnapshotV1({
    definition: input.definition,
    admission: { kind: 'user' },
    effects: { resolveTargetAvailability: async () => true },
    context: {
      source: { kind: 'inline' },
      inputs: {},
      machineId,
      executionTarget: { kind: 'session' },
      workspaceTarget: { project: { machineId, directory: input.directory, checkoutRootPath: input.directory } },
      origin: { kind: 'direct', ...(input.deliverResult ? { originSessionId: sessionId } : {}) },
      authorization,
      ...(input.deliverResult ? { resultDelivery: { kind: 'originating_session' as const, originSessionId: sessionId } } : {}),
    },
  });
  if (!materialized.ok) throw new Error(materialized.error.code);
  return serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
    ...sealMode,
    binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId: input.runId },
    acceptedSnapshot: { ...materialized.snapshot, authorization },
  }));
}

type LeafOutcome = 'completed' | 'failed' | 'needs_attention';

/** The first prompt line is the authored step document, so it labels the leaf. */
function leafLabel(text: string): string {
  return text.split('\n', 1)[0]!.trim();
}

function sessionInputBoundary(
  outcomes: Readonly<Record<string, LeafOutcome | SessionInputResultV1>> = {},
  hooks: Readonly<{ sessionId?: string; onObserve?: (label: string, signal?: AbortSignal) => Promise<void> }> = {},
) {
  const destinationSessionId = hooks.sessionId ?? sessionId;
  const enqueue = vi.fn(async (request: Readonly<{ text: string }>) => ({
    status: 'accepted' as const,
    localId: leafLabel(request.text),
  }));
  const observe = vi.fn(async (request: Parameters<typeof import('./stepExecution').observeWorkflowSessionInputResult>[0]) => {
    // The Session boundary reports the persisted input before its terminal turn.
    await request.onInputMaterialized?.(Date.now());
    await hooks.onObserve?.(request.localId, request.signal);
    const outcome = outcomes[request.localId] ?? 'completed';
    if (typeof outcome !== 'string') {
      return { ok: true as const, sessionId: destinationSessionId, localId: request.localId, result: outcome };
    }
    switch (outcome) {
      case 'needs_attention':
        return { ok: false as const, code: 'workflow_step_timeout' };
      case 'failed':
        return { ok: true as const, sessionId: destinationSessionId, localId: request.localId,
          result: { kind: 'failed' as const, message: 'Provider rejected the required step input' } };
      default:
        return {
          ok: true as const, sessionId: destinationSessionId, localId: request.localId,
          result: { kind: 'final_text' as const, text: request.localId },
        };
    }
  });
  const cancel = vi.fn(async () => ({ kind: 'turn_cancel_requested' as const }));
  return {  enqueue, observe, cancel };
}

/**
 * One production daemon "process". Each call builds a brand new coordinator,
 * conversation owner, workspace resolver and `DurableWorkflowCoordinatorStore`
 * over whatever bytes the storage boundary already holds, so calling it twice
 * is a genuine process replacement rather than a reused in-memory store.
 */
function workflowDaemonProcess(input: Readonly<{
  storage: Readonly<{ execute: WorkflowRunStorageTestkit['execute'] }>;
  sessionInput: ReturnType<typeof sessionInputBoundary>;
  directory: string;
  encryption?: AvailableAutomationAccountEncryptionV1;
  credentials?: StoredCredentials;
  conversationSessionId?: string;
}>) {
  authorizedConversations.set(input.conversationSessionId ?? sessionId, input.directory);
  readinessCurrentness = input.encryption?.witness ?? currentness;
  const unusedRunActions = { execute: vi.fn(async () => ({ ok: false as const, errorCode: 'unused' })) };
  const actionContext = () => ({ surface: 'agent' as const, authority: 'account_automation' as const });
  return createProductionWorkflowRunCoordinator({
    resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
    token: 'token',
    accountId,
    machineId,
    resolveAccountEncryption: async () => input.encryption ?? { kind: 'available', witness: currentness },
    isAcceptedAuthorizationCurrent: async () => true,
    // Opened Account policy and exact-Machine availability are host boundaries;
    // the canonical materializer and ORC admission decision remain real.
    resolveMaterializationHost: async ({ runId, workDepth, directory, originSessionId }) => ({
      effects: { resolveTargetAvailability: async () => true },
      admitLeaf: async (leaf, facts) => admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1,
        { kind: 'workflow_run_leaf', leaf }, {
          caller: { kind: 'originless', runId, runDepth: workDepth,
            ...(originSessionId ? { runOriginSessionId: originSessionId } : {}) },
          baseline: { machineId, directory }, ledSubtreeSessionIds: [],
          roles: facts.role ? { [facts.role.roleId]: facts.role } : {},
          workDepthLimit: 4, callerPermissionCeiling: facts.permissionCeiling,
        }),
    }),
    execution: {
      credentials: input.credentials ?? { token: 'token', encryption: null },
      serverId: 'server-1',

      machineAdmissionTransport: vi.fn(async () => ({ status: 'accepted' as const, localId: 'local-1' })) as never,
      resolveExistingSessionConversation: async () => ({ sessionId: input.conversationSessionId ?? sessionId, machineId, directory: input.directory, agentTarget }),
      sessionInput: input.sessionInput as never,
      detachedRun: { actionExecutor: unusedRunActions as never, buildActionContext: actionContext as never },
    },
    // The daemon-applied plugin process is a real boundary. Exercise its real
    // Git registration and SCM logic through the canonical workspace testkit.
    prepareAcceptedWorkspaceTarget: async () => ({
      ok: true,
      workspaceTarget: { project: { machineId, directory: input.directory, checkoutRootPath: input.directory } },
    }),
    workspaceScm: createGitWorkflowWorkspaceTestDependencies(),
    onCommittedTransition: vi.fn(),
    onReviewEntered: vi.fn(),
    storage: input.storage as never,
  });
}

/** Loses exactly one terminal parent settlement, leaving every durable row intact. */
function storageLosingFirstSettlement(kit: WorkflowRunStorageTestkit) {
  let pending = true;
  return {
    execute: async (operation: WorkflowRunStorageTestkitOperation, options?: Readonly<{ signal?: AbortSignal }>) => {
      if (pending && String(operation.operation) === 'transition' && String(operation.state) !== 'running') {
        pending = false;
        throw new Error('simulated_daemon_loss_before_settlement');
      }
      return await kit.execute(operation, options);
    },
    settlementWasLost: () => !pending,
  };
}

function openRowProgress(kit: WorkflowRunStorageTestkit, index: WorkflowRunInvocationIndexV1, runCrypto: WorkflowRunDataKeyV1 = { mode: 'plain' }) {
  const row = kit.rowById(index.id);
  if (!row) throw new Error('missing_row');
  const opened = openWorkflowProgressStoredEnvelopeV1({
    ...runCrypto,
    binding: {
      v: 1, purpose: 'invocation_progress', accountId, runId: index.runId,
      recordId: index.id, sequence: index.sequence, parentRecordId: index.parentRecordId,
      memberOrdinal: index.memberOrdinal, attempt: index.attempt,
    },
    envelope: parseWorkflowStoredContentEnvelopeV1(row.contentEnvelope),
  });
  if (opened.kind !== 'available') throw new Error(opened.kind);
  return WorkflowProgressEnvelopeV1Schema.parse(opened.content);
}

function rowFor(kit: WorkflowRunStorageTestkit, blockId: string, runCrypto: WorkflowRunDataKeyV1 = { mode: 'plain' }): WorkflowRunInvocationIndexV1 | undefined {
  return kit.rows()
    .map((row) => row.index)
    .find((index) => openRowProgress(kit, index, runCrypto).invocationPath.blockId === blockId);
}

function fanOutDefinition(failurePolicy: 'collect_outcomes' | 'fail_stop'): WorkflowDefinitionV1 {
  return {
    version: 1,
    inputs: [],
    defaults: retainedConversationDefaults(),
    blocks: [
      {
        kind: 'parallel',
        id: 'fan',
        failurePolicy,
        branches: [
          { id: 'healthy', blocks: [step('good')] },
          { id: 'broken', blocks: [step('bad'), step('must-not-run')] },
        ],
      },
      step('summary', {
        input: [{ kind: 'result', producer: { blockId: 'fan', scope: { kind: 'current' } }, path: [] }],
      }),
    ],
    finalOutput: { kind: 'result', producer: { blockId: 'summary', scope: { kind: 'current' } }, path: [] },
  };
}

describe('composed Workflow front door and claimed execution', () => {
  it('settles a successful Run with no selected final output while origin delivery remains unacknowledged', async () => {
    const runId = '10101010-1010-4010-8010-101010101010';
    const directory = await projectDirectory();
    const definition: WorkflowDefinitionV1 = {
      version: 1, inputs: [], defaults: retainedConversationDefaults(), blocks: [step('work')],
    };
    const acceptedEnvelope = await sealDirectAccepted({ runId, definition, directory, deliverResult: true });
    const kit = createWorkflowRunStorageTestkit({
      runId, machineId, origin: { kind: 'direct', originSessionId: sessionId },
      acceptedEnvelope, originDeliveryAckRevision: 0,
    });
    const sessionInput = sessionInputBoundary();
    const coordinate = workflowDaemonProcess({ storage: kit, sessionInput, directory });

    await expect(coordinate({
      protocol: 'v3', automationId: null, runId, attempt: 0, expectedRevision: 0,
      accountCurrentness: currentness, acceptedSnapshotEnvelope: acceptedEnvelope,
    } as never)).resolves.toMatchObject({ state: 'succeeded' });

    expect(openRowProgress(kit, rowFor(kit, 'work')!).result).toBe('work');
    expect(kit.run()).toMatchObject({
      state: 'succeeded', workflowCustodyState: 'settled',
      originDeliveryAckRevision: 0,
    });
  });

  it.each<{
    expectedState: 'paused' | 'interrupted';
    outcomes: Readonly<Record<string, LeafOutcome>>;
    pauseAfter: string | null;
  }>([
    { expectedState: 'paused', outcomes: {}, pauseAfter: 'first' },
    { expectedState: 'interrupted', outcomes: { first: 'failed' }, pauseAfter: null },
  ])('preserves recoverable custody after a $expectedState parent commit with origin delivery enabled', async ({ expectedState, outcomes, pauseAfter }) => {
    const runId = expectedState === 'paused'
      ? '13131313-1313-4313-8313-131313131313'
      : '14141414-1414-4414-8414-141414141414';
    const directory = await projectDirectory();
    const definition: WorkflowDefinitionV1 = {
      version: 1,
      inputs: [],
      defaults: retainedConversationDefaults(),
      blocks: [step('first'), step('must-not-run')],
      finalOutput: { kind: 'result', producer: { blockId: 'must-not-run', scope: { kind: 'current' } }, path: [] },
    };
    const acceptedEnvelope = await sealDirectAccepted({ runId, definition, directory, deliverResult: true });
    const kit = createWorkflowRunStorageTestkit({
      runId,
      machineId,
      origin: { kind: 'direct', originSessionId: sessionId },
      acceptedEnvelope,
      originDeliveryAckRevision: 0,
    });
    const sessionInput = sessionInputBoundary(outcomes, {
      onObserve: async (label) => {
        if (label === pauseAfter) kit.requestControl('pause_requested');
      },
    });
    const coordinate = workflowDaemonProcess({ storage: kit, sessionInput, directory });

    const coordinated = await coordinate({
      runId,
      attempt: 0,
      expectedRevision: 0,
      accountCurrentness: currentness,
      acceptedEnvelope,
    } as never);
    expect(coordinated, JSON.stringify({ observedInputs: sessionInput.observe.mock.calls.map(([request]) => request.localId) }))
      .toMatchObject({ state: expectedState });

    if (expectedState === 'interrupted') {
      expect(openRowProgress(kit, rowFor(kit, 'first')!).reason).toEqual({
        code: 'session_input_failed', message: 'Provider rejected the required step input',
      });
      expect(rowFor(kit, 'must-not-run')).toBeUndefined();
    }
    expect(kit.run()).toMatchObject({
      state: expectedState,
      workflowCustodyState: 'pending',
      originDeliveryAckRevision: 0,
    });
  });

  it('propagates persisted live cancellation on the existing heartbeat into the exact Session leaf once', async () => {
    const directory = await projectDirectory();
    vi.useFakeTimers();
    try {
      const runId = '12121212-1212-4212-8212-121212121212';
      const definition: WorkflowDefinitionV1 = {
        version: 1, inputs: [], defaults: retainedConversationDefaults(),
        blocks: [step('active'), step('must-not-admit')],
      };
      const kit = createWorkflowRunStorageTestkit({
        runId, machineId, origin: { kind: 'direct' },
        acceptedEnvelope: await sealDirectAccepted({ runId, definition, directory }),
      });
      let observationStarted!: () => void;
      const started = new Promise<void>((resolve) => { observationStarted = resolve; });
      const sessionInput = sessionInputBoundary();
      sessionInput.cancel.mockImplementationOnce(async () => {
        expect(kit.run()).toMatchObject({ workflowCustodyState: 'pending' });
        return { kind: 'turn_cancel_requested' as const };
      });
      sessionInput.observe.mockImplementationOnce(async (request) => {
        observationStarted();
        await new Promise<void>((resolve) => request.signal?.addEventListener('abort', () => resolve(), { once: true }));
        return { ok: false as const, code: 'cancelled' };
      });
      const claimClient = {
        startRun: vi.fn(),
        heartbeatRun: vi.fn(async () => { kit.requestControl('cancel_requested'); }),
        succeedRun: vi.fn(), failRun: vi.fn(),
      };
      const running = executeClaimedRun({
        machineId, claimClient,
        heartbeatMs: 1_000, leaseDurationMs: 120_000,
        coordinateWorkflowRun: workflowDaemonProcess({ storage: kit, sessionInput, directory }) as never,
        claimed: {
          protocol: 'v3', automation: null, accountCurrentness: currentness,
          run: { id: runId, automationId: null, attempt: 0, revision: kit.run().revision, origin: { kind: 'direct' }, workflowAcceptedSnapshotEnvelope: kit.acceptedEnvelope()!, triggerId: null },
        } as never,
      });
      await started;
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(running).resolves.toBeUndefined();

      expect(claimClient.heartbeatRun).toHaveBeenCalledOnce();
      expect(sessionInput.cancel).toHaveBeenCalledOnce();
      expect(sessionInput.cancel).toHaveBeenCalledWith(expect.objectContaining({ sessionId, localId: 'active' }));
      expect(sessionInput.enqueue.mock.calls.map(([request]) => leafLabel(request.text))).toEqual(['active']);
      expect(rowFor(kit, 'active')?.lifecycle).toBe('cancel_requested');
      expect(rowFor(kit, 'must-not-admit')).toBeUndefined();
      expect(kit.calls.filter((operation) => operation.operation === 'transition' && operation.state !== 'running')).toEqual([]);
      expect(kit.run()).toMatchObject({ state: 'running', workflowCustodyState: 'pending' });
    } finally {
      vi.useRealTimers();
    }
  });

  it(
    'carries a direct RPC-admitted program through one production Run owner and cannot replay a completed invocation',
    async () => {
      const runId = '11111111-1111-4111-8111-111111111111';
      const directory = await projectDirectory();
      const definition: WorkflowDefinitionV1 = {
        version: 1,
        inputs: [],
        defaults: retainedConversationDefaults(),
        blocks: [step('work')],
        finalOutput: { kind: 'result', producer: { blockId: 'work', scope: { kind: 'current' } }, path: [] },
      };
      const kit = createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'direct' } });
      const runOwner = createWorkflowRunActionOwner({
        resolveAccountId: async () => accountId,
        storage: kit,
        definitions: { get: vi.fn() },
        resolveEncryption: async () => ({ kind: 'available', witness: currentness }),
        // The exact Machine's inventory is an external boundary, not a
        // replacement for the admission owner's real materialization path.
        resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => true } }),
        prepareWorkspace: async () => ({
          ok: true,
          workspaceTarget: { project: { machineId, directory, checkoutRootPath: directory } },
        }),
      });
      const workflowActions = createWorkflowActionExecutor({
        isWorkflowFeatureEnabled: async () => true,
        definitions: { list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(), edit: vi.fn(), delete: vi.fn() },
        runs: runOwner,
      });
      const actionExecutor = {
        execute: async (
          actionId: Parameters<typeof workflowActions>[0]['actionId'],
          input: unknown,
          context?: Parameters<typeof workflowActions>[0]['context'],
        ) => ({
          ok: true as const,
          // `createCliActionDeps.ts` is the canonical owner that resolves the
          // current Session's machine/directory into the Action context for
          // `workflow.run.start`; this composed executor reproduces only that
          // injection rather than a second target resolver.
          result: await workflowActions({
            actionId,
            input,
            context: { ...context, externalActionTarget: { kind: 'machine', machineId, project: { machineId, directory } } },
          } as never),
        }),
      };

      await expect(dispatchActionFromRpc({
        actionId: 'workflow.run.start',
        input: { runId, source: { kind: 'inline', definition } },
        localActionContext: {
          surface: 'rpc', authority: 'account_automation', callerPermissionMode: 'safe-yolo',
          causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'safe-yolo' },
        },
        executor: actionExecutor as never,
      })).resolves.toMatchObject({ ok: true, result: { admission: 'created', run: { id: runId } } });
      const acceptedEnvelope = kit.acceptedEnvelope();
      expect(acceptedEnvelope).not.toBeNull();
      expect(openWorkflowAcceptedSnapshotStoredEnvelopeV1({
        mode: 'plain',
        binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId },
        envelope: parseWorkflowStoredContentEnvelopeV1(acceptedEnvelope!),
      })).toMatchObject({ kind: 'available', content: { origin: { kind: 'direct' }, source: { kind: 'inline' } } });

      const sessionInput = sessionInputBoundary();
      const coordinate = workflowDaemonProcess({ storage: kit, sessionInput, directory });
      const claimed = {
        protocol: 'v3',
        automation: null,
        accountCurrentness: currentness,
        run: {
          id: runId, automationId: null, attempt: 0, revision: kit.run().revision, origin: { kind: 'direct' },
          workflowAcceptedSnapshotEnvelope: acceptedEnvelope!, triggerId: null,
        },
      } as never;
      const claimClient = { startRun: vi.fn(), heartbeatRun: vi.fn(async () => {}), succeedRun: vi.fn(), failRun: vi.fn() };
      const executeClaim = async () => await executeClaimedRun({
        machineId, claimClient,
        heartbeatMs: 60_000, leaseDurationMs: 120_000, coordinateWorkflowRun: coordinate as never, claimed,
      });
      await executeClaim();
      // A lost claim response reclaims the same Run. The durable completed row
      // is observed, not replayed, so no second Session input is admitted.
      await executeClaim();

      const work = rowFor(kit, 'work');
      expect(work?.lifecycle).toBe('completed');
      expect(openRowProgress(kit, work!).result).toBe('work');
      expect(sessionInput.enqueue).toHaveBeenCalledOnce();
      expect(sessionInput.observe).toHaveBeenCalledOnce();
      expect(claimClient.startRun).not.toHaveBeenCalled();
      expect(kit.run()).toMatchObject({ state: 'succeeded', workflowCustodyState: 'settled' });
    },
  );
});

describe('composed Automation workflow claim and optional receipt', () => {
  it('refuses a V2 lifecycle Workflow whose materialized conversation is its own source', async () => {
    const directory = await projectDirectory();
    const lifecycleRunId = '27272727-2727-4727-8727-272727272727';
    const triggerId = AutomationTriggerIdSchema.parse('lifecycle-trigger');
    const occurrence = { v: 1 as const, kind: 'sessionLifecycle' as const, event: 'parentTurnCompleted' as const,
      sourceSessionId: sessionId, sourceTurnId: 'source-turn', occurredAt: 1 };
    const cause = AutomationRunCauseSchema.parse({ kind: 'trigger', triggerKind: 'sessionLifecycle', triggerId,
      triggerRevision: 0, occurredAt: 1, occurrenceKey: deriveAutomationOccurrenceKeyV1({ triggerId, evidence: occurrence }),
      evidence: { event: occurrence.event, sourceSessionId: sessionId, sourceTurnId: occurrence.sourceTurnId,
        policy: { kind: 'currentTurn' } } });
    const kit = createWorkflowRunStorageTestkit({ runId: lifecycleRunId, machineId, state: 'claimed',
      origin: { kind: 'automation', automationId: 'automation-lifecycle' } });
    const sessionInput = sessionInputBoundary();
    const coordinate = workflowDaemonProcess({ storage: kit, sessionInput, directory });
    await expect(coordinate({ runId: lifecycleRunId, automationId: 'automation-lifecycle', attempt: 1,
      expectedRevision: 0, accountCurrentness: currentness, automationCause: cause, causeWorkDepth: 0,
      definitionEnvelope: JSON.stringify({ t: 'plain', v: {
        workspace: { directory }, executionTarget: { kind: 'session' },
        inlineDefinition: { version: 1, defaults: retainedConversationDefaults(), blocks: [step('work')] },
      } }) })).resolves.toEqual({ state: 'failed', reason: 'self_target', blockId: 'work', admission: 'refused' });
    expect(kit.acceptedEnvelope()).toBeNull();
    expect(sessionInput.enqueue).not.toHaveBeenCalled();
  });
  it('runs exact frozen ordinary predecessor input through the Workflow coordinator without reading the changed Definition', async () => {
    const directory = await projectDirectory();
    const runId = '29292929-2929-4929-8929-292929292929';
    const retainedSessionId = 'session-old';
    const frozen = JSON.stringify({ kind: 'happier_automation_run_execution_input_v1', targetType: 'existing_session', templateVersion: 1,
      templateCiphertext: AUTOMATION_TEMPLATE_V02_EXISTING_PLAIN, origin: { kind: 'manual', invokedAt: 1 } });
    const kit = createWorkflowRunStorageTestkit({ runId, machineId, state: 'claimed', origin: { kind: 'automation', automationId: 'automation-old' } });
    const sessionInput = sessionInputBoundary({}, { sessionId: retainedSessionId });
    const claimClient = { startRun: vi.fn(), heartbeatRun: async () => {}, succeedRun: vi.fn(), failRun: vi.fn() };
    await executeClaimedRun({ machineId, claimClient, heartbeatMs: 60_000, leaseDurationMs: 120_000,
      coordinateWorkflowRun: workflowDaemonProcess({ storage: kit, sessionInput, directory, conversationSessionId: retainedSessionId }),
      claimed: { protocol: 'v3', accountCurrentness: currentness,
        automation: { id: 'automation-old', name: 'Changed', enabled: true, workflowDefinitionId: 'must-not-read', scopeSessionId: 'must-not-use' },
        run: { id: runId, automationId: 'automation-old', attempt: 2, revision: 0, recipeKind: 'legacy', triggerId: null, cause: { kind: 'manual', invokedAt: 1 },
          causeWorkDepth: 0, resultDelivery: { kind: 'none' }, executionInputEnvelope: frozen } },
    });
    expect(kit.run()).toMatchObject({ state: 'succeeded' });
    expect(sessionInput.enqueue).toHaveBeenCalledWith(expect.objectContaining({ sessionId: retainedSessionId, text: expect.stringContaining('Review the release') }));
    const opened = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, envelope: parseWorkflowStoredContentEnvelopeV1(kit.acceptedEnvelope()!) });
    expect(opened).toMatchObject({ kind: 'available', content: { source: { kind: 'automation', automationId: 'automation-old' } } });
    expect(kit.run().origin).toMatchObject({ kind: 'automation', automationId: 'automation-old' });
    expect(claimClient.startRun).not.toHaveBeenCalled();
    expect(claimClient.failRun).not.toHaveBeenCalled();
    expect(kit.calls).toContainEqual(expect.objectContaining({ operation: 'accepted-snapshot.resolve',
      runId, expectedAttempt: 2, definitionEnvelope: frozen }));
  });

  it.each(['retained encrypted', 'strict classic'] as const)('refuses frozen %s bytes at Workflow admission without any Session effect', async (kind) => {
    const directory = await projectDirectory();
    const runId = '30303030-3030-4030-8030-303030303030';
    const classic = serializeAutomationRunExecutionRecipeV1({ v: 1, templateVersion: 1,
      assignmentMachineIds: [machineId], template: { t: 'plain', v: { v: 1, prompt: 'Classic work' } },
      triggerEvidence: null, target: { kind: 'existingSession', sessionId: 'session-old' } });
    if (classic.kind !== 'available') throw new Error('Invalid canonical historical recipe fixture');
    const frozen = kind === 'strict classic' ? classic.serialized : JSON.stringify({
      kind: 'happier_automation_run_execution_input_v1', targetType: 'existing_session', templateVersion: 1,
      templateCiphertext: AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED, origin: { kind: 'manual', invokedAt: 1 },
    });
    const kit = createWorkflowRunStorageTestkit({ runId, machineId, state: 'claimed', origin: { kind: 'automation', automationId: 'automation-old' } });
    const sessionInput = sessionInputBoundary();
    const failRun = vi.fn();
    await executeClaimedRun({ machineId, claimClient: { heartbeatRun: async () => {}, failRun },
      resolveAutomationAccountEncryption: async () => ({ kind: 'available', witness: currentness }),
      heartbeatMs: 60_000, leaseDurationMs: 120_000,
      coordinateWorkflowRun: workflowDaemonProcess({ storage: kit, sessionInput, directory }),
      claimed: { protocol: 'v3', accountCurrentness: currentness,
        automation: { id: 'automation-old', name: 'Already saved as plain', enabled: true },
        run: { id: runId, automationId: 'automation-old', attempt: 1, revision: 0, recipeKind: 'legacy', triggerId: null,
          cause: { kind: 'manual', invokedAt: 1 }, causeWorkDepth: 0, resultDelivery: { kind: 'none' }, executionInputEnvelope: frozen } },
    });
    expect(kit.acceptedEnvelope()).toBeNull();
    expect(kit.rows()).toEqual([]);
    expect(sessionInput.enqueue).not.toHaveBeenCalled();
    expect(failRun).toHaveBeenCalledWith(expect.objectContaining({ errorCode: kind === 'retained encrypted'
      ? 'content_unavailable' : 'source_unavailable' }));
  });

  it('runs a retained encrypted source only after device review and explicit plain Workflow Save', async () => {
    const directory = await projectDirectory();
    const runId = '28282828-2828-4828-8828-282828282828';
    const retainedSessionId = 'session-old';
    let row: AutomationDefinitionDetail = { id: 'automation-retained', name: 'Retained', description: null,
      enabled: true, targetType: 'existingSession', existingSessionId: null, templateVersion: 1, lastRunAt: null,
      createdAt: 1, updatedAt: 1, workflowDefinitionId: null, scopeSessionId: null,
      templateCiphertext: AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED,
      assignments: [{ machineId, enabled: true, priority: 0, updatedAt: 1 }], triggers: [] };
    const writes: AutomationDefinitionReconcileRequest[] = [];
    let retainedReads = 0;
    // The Account Automation storage and authenticated Session/key read are
    // external boundaries. Conversion, consent, sealing and Run execution are real.
    const actions = createAccountWorkflowTriggerActions({
      automations: { list: async () => ({ automations: [row], nextCursor: null }), get: async () => row,
        create: async () => { throw new Error('must_preserve_automation_id'); }, delete: async () => {},
        reconcile: async (_id, input) => {
          if (input.expectedTemplateVersion !== row.templateVersion) throw Object.assign(new Error('currentness_conflict'), { code: 'currentness_conflict' });
          writes.push(input);
          row = { ...row, enabled: input.enabled, templateVersion: row.templateVersion + 1,
            ...(input.executionRecipe === undefined ? {} : { targetType: null, templateCiphertext: undefined, executionRecipe: input.executionRecipe }) };
          return row;
        } },
      resolveEncryption: async () => ({ kind: 'available', witness: currentness }),
      resolveRetainedSession: async () => { retainedReads += 1; return { sessionId: retainedSessionId, encryptionMode: 'e2ee',
        material: { type: 'legacy', secret: new Uint8Array(32).fill(7) } }; },
      resolveSession: async () => ({ project: { machineId, directory }, nativeGoalOwner: false, executionSelection: { agentTarget } }),
      resolveWorkflow: async () => { throw new Error('inline_source'); },
      randomBytes: length => new Uint8Array(length).fill(9), newId: () => 'unused',
    });
    expect((await actions.list({ scope: 'account_all' })).sets[0]).toMatchObject({ enabled: false,
      legacy: { lockedReason: 'review_required' } });
    expect(retainedReads).toBe(0);
    expect(writes.every(write => write.executionRecipe === undefined)).toBe(true);
    expect(row.templateCiphertext).toBe(AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED);
    const caller = { surface: 'cli' as const, authority: 'present_user' as const };
    const reviewed = (await actions.list({ review: true, automationId: row.id }, caller)).sets[0]!;
    if (!reviewed.target || !reviewed.project) throw new Error('review_source_unavailable');
    expect(row.executionRecipe).toBeUndefined();
    await actions.update({ automationId: row.id, expectedRevision: reviewed.revision, confirmLegacyConversion: true,
      patch: { target: reviewed.target, project: reviewed.project, enabled: true } }, caller);
    const saved = row.executionRecipe;
    if (saved?.v !== 2 || saved.workflow.t !== 'plain') throw new Error('explicit_save_did_not_write_plain_workflow');
    expect(row.id).toBe('automation-retained');
    const kit = createWorkflowRunStorageTestkit({ runId, machineId, state: 'claimed',
      origin: { kind: 'automation', automationId: row.id } });
    const sessionInput = sessionInputBoundary({}, { sessionId: retainedSessionId });
    const claimClient = { startRun: vi.fn(), heartbeatRun: async () => {}, succeedRun: vi.fn(), failRun: vi.fn() };
    await executeClaimedRun({ machineId, claimClient,
      heartbeatMs: 60_000, leaseDurationMs: 120_000,
      coordinateWorkflowRun: workflowDaemonProcess({ storage: kit, sessionInput, directory, conversationSessionId: retainedSessionId }),
      claimed: { protocol: 'v3', accountCurrentness: currentness,
        automation: { id: row.id, name: row.name, enabled: true, workflowDefinitionId: null, scopeSessionId: null },
        run: { id: runId, automationId: row.id, attempt: 1, revision: 0, recipeKind: 'workflow-v2', triggerId: null,
          cause: { kind: 'manual', invokedAt: 1 }, causeWorkDepth: 0, resultDelivery: { kind: 'none' },
          executionInputEnvelope: JSON.stringify(saved.workflow), automationEvidenceEnvelope: null } },
    });
    expect(sessionInput.enqueue).toHaveBeenCalledWith(expect.objectContaining({ sessionId: retainedSessionId }));
    expect(kit.run()).toMatchObject({ state: 'succeeded', origin: { kind: 'automation', automationId: 'automation-retained' } });
    expect(claimClient.startRun).not.toHaveBeenCalled();
    expect(claimClient.failRun).not.toHaveBeenCalled();
  });
  it('keeps the exact optional workflowRun receipt bound to the returned Run only when the canonical schema supports it', async () => {
    // The canonical current schema owns the optional receipt shape. This
    // composed lane verifies that shape through the real Protocol owner and
    // does not invent a test-only receipt contract.
    expect(AutomationV3RunMutationResponseSchema.shape).toHaveProperty('workflowRun');
    const timestamp = 1_786_257_600_000;
    const run = {
      id: 'run-automation-receipt',
      automationId: 'automation-1',
      revision: 1,
      triggerId: null,
      triggerRetired: false,
      state: 'queued' as const,
      cause: { kind: 'manual' as const, invokedAt: timestamp },
      dueAt: timestamp,
      claimedAt: null,
      startedAt: null,
      finishedAt: null,
      claimedByMachineId: null,
      leaseExpiresAt: null,
      attempt: 0,
      errorCode: null,
      producedSessionId: null,
      executionDispatchState: null,
      executionAttempt: 0,
      replyHandoffState: 'none' as const,
      replyHandoffAttempt: 0,
      replyHandoffDueAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    expect(AutomationV3RunMutationResponseSchema.parse({ run })).toEqual({ run });
    const workflowResponse = {
      run,
      workflowRun: { recipeKind: 'workflow-v2' as const, workflowRunId: run.id },
    };
    expect(AutomationV3RunMutationResponseSchema.parse(workflowResponse)).toEqual(workflowResponse);
    expect(AutomationV3RunMutationResponseSchema.safeParse({
      ...workflowResponse,
      workflowRun: { recipeKind: 'workflow-v2' as const, workflowRunId: 'different-run' },
    }).success).toBe(false);
    expect(AutomationV3RunMutationResponseSchema.safeParse({
      ...workflowResponse,
      workflowRun: { recipeKind: 'legacy' as const, workflowRunId: run.id },
    }).success).toBe(false);
  });

  it('reaches the same production Run owner from an Automation claim as from a direct start', async () => {
    const runId = '22222222-2222-4222-8222-222222222222';
    const directory = await projectDirectory();
    const definition: WorkflowDefinitionV1 = {
      version: 1,
      inputs: [{ name: 'request', valueType: 'string', required: true }],
      defaults: retainedConversationDefaults(),
      blocks: [step('work', { input: [{ kind: 'input', name: 'request' }],
        document: { text: 'work', displayText: 'Scheduled check', references: [], attachments: [] } })],
      finalOutput: { kind: 'result', producer: { blockId: 'work', scope: { kind: 'current' } }, path: [] },
    };
    // The Automation evidence opens through the real input binding owner
    // inside the coordinator path: this harness does not reimplement trigger
    // evidence parsing and fails closed on missing required input.
    expect(() => bindAutomationWorkflowInputs({ definition: { inputs: definition.inputs }, evidence: {} }))
      .toThrowError('missing_required_input');
    expect(bindAutomationWorkflowInputs({
      definition: { inputs: definition.inputs },
      evidence: { request: 'ship it' },
    })).toEqual({ request: 'ship it' });

    const kit = createWorkflowRunStorageTestkit({
      runId, machineId, origin: { kind: 'automation', automationId: 'automation-1' },
    });
    const sessionInput = sessionInputBoundary();
    const coordinate = workflowDaemonProcess({ storage: kit, sessionInput, directory });
    const claimClient = { startRun: vi.fn(), heartbeatRun: vi.fn(async () => {}), succeedRun: vi.fn(), failRun: vi.fn() };
    await executeClaimedRun({
      machineId, claimClient,
      heartbeatMs: 60_000, leaseDurationMs: 120_000, coordinateWorkflowRun: coordinate as never,
      claimed: {
        protocol: 'v3',
        accountCurrentness: currentness,
        automation: { id: 'automation-1', workflowDefinitionId: null, scopeSessionId: null },
        run: {
          id: runId,
          automationId: 'automation-1',
          attempt: 0,
          revision: 0,
          causeWorkDepth: 0,
          origin: { kind: 'automation', automationId: 'automation-1' },
          recipeKind: 'workflow-v2',
          executionInputEnvelope: JSON.stringify({
            t: 'plain',
            v: AutomationStoredWorkflowDefinitionV2Schema.parse({
              inlineDefinition: definition, workspace: { directory }, executionTarget: { kind: 'session' },
            }),
          }),
          automationEvidenceEnvelope: JSON.stringify({ t: 'plain', v: { request: 'ship it' } }),
          cause: { kind: 'conversation', occurrenceKey: 'A'.repeat(43), occurredAt: 1 },
          triggerId: null,
        },
      } as never,
    });

    // Only the pre-root accepted-snapshot resolution distinguishes the two
    // origins; everything after it is the one Run/invocation owner.
    expect(kit.operations()[0]).toBe('accepted-snapshot.resolve');
    expect(kit.operations()).toEqual(expect.arrayContaining(['initialize', 'invocations.admit', 'transition']));
    expect(sessionInput.enqueue).toHaveBeenCalledOnce();
    expect(sessionInput.enqueue).toHaveBeenCalledWith(expect.objectContaining({ displayText: 'Scheduled check' }));
    expect(claimClient.startRun).not.toHaveBeenCalled();
    const work = rowFor(kit, 'work');
    expect(work?.lifecycle).toBe('completed');
    expect(kit.run()).toMatchObject({
      origin: { kind: 'automation', automationId: 'automation-1' },
      state: 'succeeded',
      workflowCustodyState: 'settled',
    });
  });

  it.each([['plain', false], ['e2ee', false], ['plain', true], ['e2ee', true]] as const)(
    'settles a scheduled fieldless Wait after Continue and a fresh daemon claim (%s; saved=%s)', async (mode, savedSource) => {
    const runId = '98989898-9898-4989-8989-989898989898';
    const directory = await projectDirectory();
    const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {}, blocks: [
      { kind: 'wait', id: 'approval', execution: {}, document: { text: 'Continue', references: [], attachments: [] } },
    ] };
    const scheduledFor = 1_714_000_000_000;
    const cause = AutomationRunCauseSchema.parse({ kind: 'trigger', triggerId: 'trigger-1', triggerKind: 'schedule',
      triggerRevision: 4, occurrenceKey: deriveAutomationOccurrenceKeyV1({ triggerId: 'trigger-1',
        evidence: { v: 1, kind: 'schedule', scheduledFor } }), occurredAt: scheduledFor, evidence: { scheduledFor } });
    if (cause.kind !== 'trigger') throw new Error('schedule_cause_fixture_invalid');
    const material = mode === 'e2ee' ? createAccountScopedCryptoMaterialSnapshotV1({
      accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    }) : undefined;
    const encryption: AvailableAutomationAccountEncryptionV1 = mode === 'plain'
      ? { kind: 'available', witness: currentness }
      : { kind: 'available', witness: { mode, version: 1,
        contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(material!.contentPublicKeyFingerprint) }, material: material! };
    const credentials: StoredCredentials = { token: 'token', encryption: mode === 'plain' ? null
      : { type: 'legacy', secret: new Uint8Array(32).fill(7) } };
    const definitionId = '2e17b7b7-1977-4b5b-9957-781ec43c5b54';
    let storedArtifact: Record<string, unknown> = {};
    let readClaimResponse: (() => unknown) | undefined;
    // Only opaque HTTP storage is faked: the real Artifact writer seals the
    // header/body/key, and production's saved-source resolver opens them.
    const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body: unknown) => {
      if (url.endsWith('/v3/automations/runs/claim')) {
        if (!readClaimResponse) throw new Error('claim_boundary_not_ready');
        return { status: 200, data: readClaimResponse() };
      }
      if (url.endsWith('/v2/sessions/lookup-by-tags')) return writeSessionReadiness(url, body);
      expect(url).toMatch(/\/v1\/artifacts$/);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('artifact_boundary_invalid_write');
      storedArtifact = { ...body, id: definitionId, ownerAccountId: accountId, access: 'owner', encryptionMode: mode,
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
      return { status: 200, data: storedArtifact };
    });
    const get = savedSource ? vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      if (url.endsWith('/v1/account/encryption/currentness') || /\/v2\/sessions\//.test(url)) return readSessionReadiness(url);
      if (url.endsWith(`/v1/artifacts/${definitionId}/access/recipients`)) return { status: 200,
        data: { artifactId: definitionId, ownerAccountId: accountId, access: 'owner', encryptionMode: mode,
          dataEncryptionKey: storedArtifact.dataEncryptionKey, callerDataEncryptionKey: storedArtifact.dataEncryptionKey,
          provenanceDataEncryptionKey: storedArtifact.provenanceDataEncryptionKey ?? null,
          callerProvenanceDataEncryptionKey: storedArtifact.provenanceDataEncryptionKey ?? null,
          recipients: [] } };
      expect(url).toMatch(new RegExp(`/v1/artifacts/${definitionId}$`));
      return { status: 200, data: storedArtifact };
    }) : undefined;
    try {
      if (savedSource) await createAccountArtifactStore({ credentials, getAccountEncryptionMode: async () => mode }).create({
        artifactId: definitionId, header: { kind: 'workflow-definition.v1', definitionId,
          revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Saved scheduled Wait' } },
        savedBy: { kind: 'person', accountId },
        body: JSON.stringify({ kind: 'workflow-definition.v1', definition }),
      });
      const kit = createWorkflowRunStorageTestkit({ runId, machineId,
        origin: { kind: 'automation', automationId: 'automation-1', cause }, state: 'claimed',
        keyCensus: { runId, ownerAccountId: accountId, access: 'owner', visibleTeamId: null, encryptionMode: mode,
          ownerAccountCurrentness: encryption.witness, dataEncryptionKey: null,
          callerDataEncryptionKey: null, recipients: [] },
      });
      const sessionInput = sessionInputBoundary();
      const payload = AutomationStoredWorkflowDefinitionV2Schema.parse({ ...(savedSource ? {} : { inlineDefinition: definition }),
        workspace: { directory }, executionTarget: { kind: 'session' } });
      const definitionEnvelope = JSON.stringify(material
        ? { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: 'automation_template_payload',
          material: material.material, payload, randomBytes: (length: number) => new Uint8Array(length).fill(5) }) }
        : { t: 'plain', v: payload });
      let parentAttempt = 1;
      readClaimResponse = () => ({
        run: { id: runId, attempt: parentAttempt, revision: kit.run().revision, automationId: 'automation-1',
          recipeKind: 'workflow-v2', executionInputEnvelope: definitionEnvelope,
          ...(kit.acceptedEnvelope() === null ? {} : { workflowAcceptedSnapshotEnvelope: kit.acceptedEnvelope() }),
          causeWorkDepth: 0, cause, automationEvidenceEnvelope: null, triggerId: cause.triggerId, triggerRetired: false },
        automation: { id: 'automation-1', name: 'Scheduled Wait', enabled: true,
          ...(savedSource ? { workflowDefinitionId: definitionId } : {}) },
        accountCurrentness: encryption.witness,
      });
      const claimClient = createAutomationClaimClient({ token: 'token', createPublisherHeader: async () => null });
      const executeClaim = async () => {
        const claimed = await claimClient.claimRun({ machineId, leaseDurationMs: 120_000 });
        if (claimed.run === null || claimed.automation === null || claimed.accountCurrentness === undefined) {
          throw new Error('claim_boundary_invalid_response');
        }
        await executeClaimedRun({ machineId, claimClient,
          heartbeatMs: 60_000, leaseDurationMs: 120_000, claimed,
          coordinateWorkflowRun: workflowDaemonProcess({ storage: kit, sessionInput, directory, encryption, credentials }),
        });
      };
      await executeClaim();
      expect(kit.run()).toMatchObject({ state: 'waiting_for_review' });
      const admittedEnvelope = kit.acceptedEnvelope();
      const resolved = resolveWorkflowRunDataKeyV1({ encryption, census: WorkflowRunRecipientCensusResponseV1Schema.parse(
        await kit.execute({ operation: 'run-key.census', runId })) });
      if (resolved.kind !== 'available') throw new Error(resolved.reason);
      const runCrypto = resolved.encryption.runCrypto;
      const held = rowFor(kit, 'approval', runCrypto)!;
      const owner = createWorkflowRunActionOwner({ resolveAccountId: async () => accountId, storage: kit,
        definitions: { get: vi.fn() }, resolveEncryption: async () => encryption });
      await owner.execute({ actionId: 'workflow.run.invocations.complete_review', input: { runId,
        invocation: { recordId: held.id }, expectedContentRevision: held.contentRevision, mode: 'use_result' },
        context: { surface: 'ui', authority: 'present_user', callerPermissionMode: 'yolo' } });
      expect(kit.run().state).toBe('queued');
      expect(openRowProgress(kit, kit.rowById(held.id)!.index, runCrypto).result).toBeUndefined();
      // The server's next machine claim changes only public parent state/cursor;
      // the restarted daemon reconstructs the same accepted snapshot and rows.
      parentAttempt += 1;
      await kit.execute({ operation: 'transition', runId, parentAttempt, expectedRevision: kit.run().revision,
        state: 'claimed', checkpointEnvelope: kit.checkpointEnvelope()! });
      await executeClaim();
      expect(kit.run()).toMatchObject({ state: 'succeeded', workflowCustodyState: 'settled' });
      expect(kit.acceptedEnvelope()).toBe(admittedEnvelope);
      expect(kit.operations().filter(operation => operation === 'accepted-snapshot.resolve')).toHaveLength(1);
      expect(kit.rowById(held.id)?.index).toMatchObject({ lifecycle: 'completed', attempt: '0' });
      expect(kit.rows()).toHaveLength(2);
      expect(kit.resultEnvelope()).toBeNull();
      expect(sessionInput.enqueue).not.toHaveBeenCalled();
      if (savedSource) {
        const accepted = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ ...runCrypto,
          binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId },
          envelope: parseWorkflowStoredContentEnvelopeV1(kit.acceptedEnvelope()) });
        expect(accepted).toMatchObject({ kind: 'available', content: { source: { kind: 'automation', definitionId,
          revision: { headerVersion: 1, bodyVersion: 1 }, savedBy: { kind: 'person', accountId } } } });
      }
    } finally { get?.mockRestore(); post?.mockRestore(); }
  });

  it('admits a scheduled zero-input one-prompt workflow through the canonical binder into its literal child input', async () => {
    const runId = '99999999-9999-4999-8999-999999999999';
    const directory = await projectDirectory();
    const scheduledFor = 1_714_000_000_000;
    const definition: WorkflowDefinitionV1 = {
      version: 1,
      inputs: [],
      defaults: retainedConversationDefaults(),
      blocks: [step('work')],
      finalOutput: { kind: 'result', producer: { blockId: 'work', scope: { kind: 'current' } }, path: [] },
    };
    const cause = AutomationRunCauseSchema.parse({
      kind: 'trigger',
      triggerId: 'trigger-1',
      triggerKind: 'schedule',
      triggerRevision: 4,
      occurrenceKey: deriveAutomationOccurrenceKeyV1({
        triggerId: 'trigger-1',
        evidence: { v: 1, kind: 'schedule', scheduledFor },
      }),
      occurredAt: scheduledFor,
      evidence: { scheduledFor },
    });
    if (cause.kind !== 'trigger') throw new Error('Expected scheduled trigger cause');
    // The immutable occurrence cause retains the full schedule evidence while
    // the zero-input definition binds none of it.
    expect(cause.evidence).toEqual({ scheduledFor });

    const kit = createWorkflowRunStorageTestkit({
      runId, machineId, origin: { kind: 'automation', automationId: 'automation-1' },
    });
    const sessionInput = sessionInputBoundary();
    const coordinate = workflowDaemonProcess({ storage: kit, sessionInput, directory });
    const claimClient = { startRun: vi.fn(), heartbeatRun: vi.fn(async () => {}), succeedRun: vi.fn(), failRun: vi.fn() };
    await executeClaimedRun({
      machineId, claimClient,
      heartbeatMs: 60_000, leaseDurationMs: 120_000, coordinateWorkflowRun: coordinate as never,
      claimed: {
        protocol: 'v3',
        accountCurrentness: currentness,
        automation: { id: 'automation-1', workflowDefinitionId: null, scopeSessionId: null },
        run: {
          id: runId,
          automationId: 'automation-1',
          attempt: 0,
          revision: 0,
          causeWorkDepth: 0,
          origin: { kind: 'automation', automationId: 'automation-1' },
          recipeKind: 'workflow-v2',
          executionInputEnvelope: JSON.stringify({
            t: 'plain',
            v: AutomationStoredWorkflowDefinitionV2Schema.parse({
              inlineDefinition: definition, workspace: { directory }, executionTarget: { kind: 'session' },
            }),
          }),
          automationEvidenceEnvelope: null,
          cause,
          triggerId: cause.triggerId,
        },
      } as never,
    });

    expect(sessionInput.enqueue).toHaveBeenCalledOnce();
    const sentText = String(sessionInput.enqueue.mock.calls[0]?.[0]?.text ?? '');
    expect(leafLabel(sentText)).toBe('work');
    expect(sentText).not.toContain('**Workflow inputs**');
    expect(sentText).not.toContain('scheduledFor');
    const work = rowFor(kit, 'work');
    expect(work?.lifecycle).toBe('completed');
    expect(kit.run()).toMatchObject({
      origin: { kind: 'automation', automationId: 'automation-1' },
      state: 'succeeded',
      workflowCustodyState: 'settled',
    });
  });
});

describe.each(['plain', 'e2ee'] as const)('composed exact result live/recovery parity (%s)', (mode) => {
  it.each<Readonly<{ name: string; contract: WorkflowStep['result']; observed: SessionInputResultV1; valid: boolean }>>([
    { name: 'successful no-text', contract: { kind: 'text' }, valid: true,
      observed: { kind: 'terminal_no_result', reason: 'missing_final_assistant_text', usage: { inputTokens: 8 } } },
    { name: 'exact whitespace', contract: { kind: 'text' }, valid: true,
      observed: { kind: 'final_text', text: '  answer\n', usage: { inputTokens: 8 } } },
    { name: 'strict JSON', contract: { kind: 'json', schema: { type: 'object', required: ['answer'] } }, valid: true,
      observed: { kind: 'final_text', text: '{"answer":42}', usage: { inputTokens: 8 } } },
    { name: 'invalid JSON', contract: { kind: 'json', schema: {} }, valid: false,
      observed: { kind: 'final_text', text: 'not JSON', usage: { inputTokens: 8 } } },
    { name: 'missing required decision', contract: { kind: 'decision', decisions: ['continue', 'stop'] }, valid: false,
      observed: { kind: 'terminal_no_result', reason: 'missing_final_assistant_text', usage: { inputTokens: 8 } } },
    { name: 'provider rejection', contract: { kind: 'text' }, valid: false,
      observed: { kind: 'failed', message: 'Provider rejected the required step input', usage: { inputTokens: 8 } } },
  ])('$name commits the same exact fact before the successor can run', async ({ contract, observed, valid }) => {
    const runId = '89898989-8989-4989-8989-898989898989';
    const directory = await projectDirectory();
    const material = mode === 'e2ee' ? createAccountScopedCryptoMaterialSnapshotV1({
      accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    }) : undefined;
    const encryption: AvailableAutomationAccountEncryptionV1 = mode === 'plain'
      ? { kind: 'available', witness: currentness }
      : { kind: 'available', witness: { mode, version: 1,
        contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(material!.contentPublicKeyFingerprint) }, material: material! };
    const prepared = prepareWorkflowRunDataKeyV1({ accountId, encryption,
      randomBytes: (length: number) => new Uint8Array(length).fill(3) });
    const runCrypto = prepared.runCrypto;
    const ownerEnvelope = prepared.recipientKeyEnvelopes[0]?.encryptedDataKey ?? null;
    const definition: WorkflowDefinitionV1 = {
      version: 1, inputs: [], defaults: retainedConversationDefaults(),
      blocks: [step('first', { result: contract }), step('successor', {
        input: [{ kind: 'result', producer: { blockId: 'first', scope: { kind: 'current' } }, path: [] }],
      })],
    };
    const acceptedEnvelope = await sealDirectAccepted({ runId, definition, directory, runCrypto });
    const makeKit = () => createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'direct' }, acceptedEnvelope,
      keyCensus: { runId, ownerAccountId: accountId, access: 'owner', visibleTeamId: null, encryptionMode: mode,
        ownerAccountCurrentness: encryption.witness, dataEncryptionKey: ownerEnvelope,
        callerDataEncryptionKey: ownerEnvelope, recipients: [] },
    });
    const claim = { runId, attempt: 0, expectedRevision: 0, accountCurrentness: encryption.witness, acceptedEnvelope };
    const ordinary = makeKit();
    const ordinaryBoundary = sessionInputBoundary({ first: observed });
    await expect(workflowDaemonProcess({ storage: ordinary, sessionInput: ordinaryBoundary, directory, encryption })(claim))
      .resolves.toMatchObject({ state: valid ? 'succeeded' : 'interrupted' });
    const ordinaryIndex = rowFor(ordinary, 'first', runCrypto)!;
    const ordinaryFact = openRowProgress(ordinary, ordinaryIndex, runCrypto);
    expect(Boolean(rowFor(ordinary, 'successor', runCrypto))).toBe(valid);

    const restarted = makeKit();
    const interruptedBoundary = sessionInputBoundary({}, {
      onObserve: async () => { throw new Error('simulated_daemon_loss_after_exact_enqueue'); },
    });
    await expect(workflowDaemonProcess({ storage: restarted, sessionInput: interruptedBoundary, directory, encryption })(claim))
      .rejects.toThrow('simulated_daemon_loss_after_exact_enqueue');
    const pendingIndex = rowFor(restarted, 'first', runCrypto)!;
    const pendingFact = openRowProgress(restarted, pendingIndex, runCrypto);
    expect(pendingIndex.lifecycle).toBe('running');
    expect(rowFor(restarted, 'successor', runCrypto)).toBeUndefined();

    const observer = createWorkflowInvocationRecoveryObserver({
      credentials: { token: 'token', encryption: null }, machineId,
      observeSession: async (request) => {
        if (pendingFact.execution?.kind !== 'session') throw new Error('missing_exact_session_correspondence');
        expect(request).toMatchObject({ sessionId: pendingFact.execution.sessionId, localId: pendingFact.execution.localInputId });
        return { ok: true, sessionId, localId: request.localId, result: observed };
      },
      cancelSession: async () => { throw new Error('nonterminal_parent_must_not_cancel'); },
      actionExecutor: { execute: async () => { throw new Error('session_correspondence_must_not_use_native'); } },
    });
    await createWorkflowRunRecoveryReader({
      accountId, machineId,
      storage: { execute: async (operation, options) => operation.operation === 'recovery.list'
        ? { candidates: [{ run: restarted.run(), parentAttempt: 0 }] } : restarted.execute(operation, options) },
      resolveAccountEncryption: async () => encryption, reconcileInvocation: observer,
    })('reconnect');
    const recoveredIndex = rowFor(restarted, 'first', runCrypto)!;
    const recoveredFact = openRowProgress(restarted, recoveredIndex, runCrypto);
    expect(recoveredIndex.id).toBe(pendingIndex.id);
    expect(recoveredIndex.lifecycle).toBe(ordinaryIndex.lifecycle);
    expect(recoveredFact.execution).toEqual(pendingFact.execution);
    expect({ result: recoveredFact.result, usage: recoveredFact.usage, reason: recoveredFact.reason })
      .toEqual({ result: ordinaryFact.result, usage: ordinaryFact.usage, reason: ordinaryFact.reason });
    expect(rowFor(restarted, 'successor', runCrypto)).toBeUndefined();

    const replacementBoundary = sessionInputBoundary();
    await expect(workflowDaemonProcess({ storage: restarted, sessionInput: replacementBoundary, directory, encryption })({
      ...claim, expectedRevision: restarted.run().revision,
    })).resolves.toMatchObject({ state: valid ? 'succeeded' : 'interrupted' });
    expect(replacementBoundary.enqueue.mock.calls.map(([request]) => leafLabel(request.text)))
      .toEqual(valid ? ['successor'] : []);
    expect(Boolean(rowFor(restarted, 'successor', runCrypto))).toBe(valid);
  });
});

describe('composed fresh-process reconstruction over durable rows', () => {
  it.each([
    {
      failurePolicy: 'collect_outcomes' as const,
      expected: { state: 'succeeded', completedWithFailures: true },
      terminalState: 'succeeded',
    },
    {
      failurePolicy: 'fail_stop' as const,
      expected: { state: 'interrupted', reason: 'session_input_failed' },
      terminalState: 'interrupted',
    },
  ])(
    'recomputes the same $failurePolicy outcome from persisted rows after the daemon is replaced',
    async ({ failurePolicy, expected, terminalState }) => {
      const runId = '33333333-3333-4333-8333-333333333333';
      const directory = await projectDirectory();
      const definition = fanOutDefinition(failurePolicy);
      const kit = createWorkflowRunStorageTestkit({
        runId, machineId, origin: { kind: 'direct' },
        acceptedEnvelope: await sealDirectAccepted({ runId, definition, directory }),
      });

      const first = sessionInputBoundary({ bad: 'failed' });
      const lossy = storageLosingFirstSettlement(kit);
      const claim = {
        runId, attempt: 0, expectedRevision: kit.run().revision,
        accountCurrentness: currentness, acceptedEnvelope: kit.acceptedEnvelope()!,
      };
      await expect(workflowDaemonProcess({ storage: lossy, sessionInput: first, directory })(claim as never))
        .rejects.toThrowError('simulated_daemon_loss_before_settlement');
      expect(lossy.settlementWasLost()).toBe(true);
      expect(first.enqueue.mock.calls.map(([request]) => leafLabel(request.text)))
        .not.toContain('must-not-run');
      // Nothing about the outcome survives in this process: the parent never
      // settled and the next process starts with no materialized container.
      // Under `collect_outcomes` the container itself is durably settled, so
      // reconstruction must recompute its ordered outcomes without moving a
      // terminal row back to `running` — a transition the server's invocation
      // CAS refuses and the testkit reproduces.
      expect(kit.run().state).toBe('running');
      expect(rowFor(kit, 'fan')?.lifecycle)
        .toBe(failurePolicy === 'collect_outcomes' ? 'completed' : 'needs_attention');

      const second = sessionInputBoundary();
      const replacement = workflowDaemonProcess({ storage: kit, sessionInput: second, directory });
      await expect(replacement({ ...claim, expectedRevision: kit.run().revision } as never))
        .resolves.toMatchObject(expected);
      expect(second.enqueue).not.toHaveBeenCalled();
      expect(second.observe).not.toHaveBeenCalled();
      expect(kit.run().state).toBe(terminalState);
      expect(rowFor(kit, 'bad')?.lifecycle).toBe('failed');
      expect(rowFor(kit, 'must-not-run')).toBeUndefined();
    },
  );

  it('rebinds a loop source and its durable frontier to persisted producer rows in a replacement process', async () => {
    const runId = '44444444-4444-4444-8444-444444444444';
    const directory = await projectDirectory();
    const definition: WorkflowDefinitionV1 = {
      version: 1,
      inputs: [],
      defaults: retainedConversationDefaults(),
      blocks: [
        step('seed', { result: { kind: 'json', schema: { type: 'number' } } }),
        {
          kind: 'loop',
          id: 'counted',
          repetition: {
            kind: 'count',
            count: { kind: 'result', producer: { blockId: 'seed', scope: { kind: 'current' } }, path: [] },
          },
          body: [step('work')],
        },
      ],
      finalOutput: { kind: 'result', producer: { blockId: 'counted', scope: { kind: 'current' } }, path: [] },
    };
    const kit = createWorkflowRunStorageTestkit({
      runId, machineId, origin: { kind: 'direct' },
      acceptedEnvelope: await sealDirectAccepted({ runId, definition, directory }),
    });
    const seeded = sessionInputBoundary();
    // `seed` declares a numeric result contract, so the Session leaf must
    // return the exact decodable text the loop count resolves from.
    seeded.observe.mockImplementation(async (request: Readonly<{ localId: string }>) => ({
      ok: true as const, sessionId, localId: request.localId,
      result: { kind: 'final_text' as const, text: request.localId === 'seed' ? '3' : request.localId },
    }));
    // Lose the daemon between the loop's three iterations: `seed` and the first
    // `work` are durable, the loop frontier has advanced, and nothing about
    // the resolved count or the previous iteration survives in memory.
    let settled = 0;
    let crashed = false;
    const lossy = {
      execute: async (operation: WorkflowRunStorageTestkitOperation, options?: Readonly<{ signal?: AbortSignal }>) => {
        if (String(operation.operation) === 'invocations.admit' && settled >= 2 && !crashed) {
          crashed = true;
          throw new Error('simulated_daemon_loss_mid_loop');
        }
        const result = await kit.execute(operation, options);
        if (String(operation.operation) === 'invocations.fact' && String(operation.lifecycle) === 'completed') settled += 1;
        return result;
      },
    };
    const claim = {
      runId, attempt: 0, expectedRevision: kit.run().revision,
      accountCurrentness: currentness, acceptedEnvelope: kit.acceptedEnvelope()!,
    };
    await expect(workflowDaemonProcess({ storage: lossy, sessionInput: seeded, directory })(claim as never))
      .rejects.toThrowError('simulated_daemon_loss_mid_loop');
    expect(seeded.enqueue.mock.calls.map(([request]) => leafLabel(request.text))).toEqual(['seed', 'work']);
    const loopRow = rowFor(kit, 'counted');
    expect(openRowProgress(kit, loopRow!).container).toMatchObject({
      kind: 'loop', mode: 'count', count: '3', nextMemberIndex: '1',
    });

    const replacement = sessionInputBoundary();
    await expect(workflowDaemonProcess({ storage: kit, sessionInput: replacement, directory })({
      ...claim, expectedRevision: kit.run().revision,
    } as never)).resolves.toMatchObject({
      state: 'succeeded',
      finalOutput: [{ work: 'work' }, { work: 'work' }, { work: 'work' }],
    });
    // The replacement resolves the count from the persisted `seed` row rather
    // than a rescanned name, replays nothing, and runs only iteration one.
    expect(replacement.enqueue.mock.calls.map(([request]) => leafLabel(request.text))).toEqual(['work', 'work']);
    expect(kit.run().state).toBe('succeeded');

    const completedRestart = sessionInputBoundary();
    await expect(workflowDaemonProcess({ storage: kit, sessionInput: completedRestart, directory })({
      ...claim, expectedRevision: kit.run().revision,
    } as never)).resolves.toMatchObject({
      state: 'succeeded',
      finalOutput: [{ work: 'work' }, { work: 'work' }, { work: 'work' }],
    });
    expect(completedRestart.enqueue).not.toHaveBeenCalled();
  });

  it('reconstructs all prior evaluator outcomes through the production store without replaying evaluator turns', async () => {
    const runId = '55555555-5555-4555-8555-555555555555';
    const directory = await projectDirectory();
    const definition: WorkflowDefinitionV1 = {
      version: 1,
      inputs: [],
      defaults: retainedConversationDefaults(),
      blocks: [{
        kind: 'loop', id: 'judged',
        repetition: {
          kind: 'evaluate', maxIterations: 3, history: 'all',
          evaluator: step('evaluate', {
            result: { kind: 'decision', decisions: ['continue', 'stop'] },
          }),
        },
        body: [step('body')],
      }],
    };
    const kit = createWorkflowRunStorageTestkit({
      runId, machineId, origin: { kind: 'direct' },
      acceptedEnvelope: await sealDirectAccepted({ runId, definition, directory }),
    });
    const first = sessionInputBoundary();
    let bodyObservations = 0;
    first.observe.mockImplementation(async (request: Readonly<{ localId: string }>) => {
      if (request.localId === 'body') {
        bodyObservations += 1;
        if (bodyObservations === 3) throw new Error('simulated_daemon_loss_before_third_evaluator');
        return {
          ok: true as const, sessionId, localId: request.localId,
          result: { kind: 'final_text' as const, text: 'body-result' },
        };
      }
      return {
        ok: true as const, sessionId, localId: request.localId,
        result: { kind: 'final_text' as const, text: JSON.stringify('continue') },
      };
    });
    const claim = {
      runId, attempt: 0, expectedRevision: kit.run().revision,
      accountCurrentness: currentness, acceptedEnvelope: kit.acceptedEnvelope()!,
    };
    await expect(workflowDaemonProcess({ storage: kit, sessionInput: first, directory })(claim as never))
      .rejects.toThrowError('simulated_daemon_loss_before_third_evaluator');

    const replacement = sessionInputBoundary();
    replacement.observe.mockImplementation(async (request: Readonly<{ localId: string }>) => ({
      ok: true as const, sessionId, localId: request.localId,
      result: {
        kind: 'final_text' as const,
        text: request.localId === 'evaluate' ? JSON.stringify('stop') : 'body-result',
      },
    }));
    await expect(workflowDaemonProcess({ storage: kit, sessionInput: replacement, directory })({
      ...claim, expectedRevision: kit.run().revision,
    } as never)).resolves.toMatchObject({ state: 'succeeded' });

    const evaluatorInputs = kit.rows()
      .map(({ index }) => openRowProgress(kit, index))
      .filter((progress) => progress.invocationPath.blockId === 'evaluate')
      .sort((left, right) => {
        const leftIndex = left.invocationPath.scope.find((part) => part.kind === 'iteration')?.index ?? 0;
        const rightIndex = right.invocationPath.scope.find((part) => part.kind === 'iteration')?.index ?? 0;
        return leftIndex - rightIndex;
      })
      .map((progress) => isWorkflowJsonObject(progress.input) && Array.isArray(progress.input.input)
        ? progress.input.input
        : []);
    expect(evaluatorInputs).toEqual([
      [],
      [{ kind: 'evaluation_history', evaluations: ['continue'] }],
      [{ kind: 'evaluation_history', evaluations: ['continue', 'continue'] }],
    ]);

    const completedRestart = sessionInputBoundary();
    await expect(workflowDaemonProcess({ storage: kit, sessionInput: completedRestart, directory })({
      ...claim, expectedRevision: kit.run().revision,
    } as never)).resolves.toMatchObject({ state: 'succeeded' });
    expect(completedRestart.enqueue).not.toHaveBeenCalled();
  });
});

describe('composed boundary pause across admitted siblings', () => {
  it('drains an already admitted fail-stop sibling instead of aborting it when pause closes the next admission', async () => {
    const runId = '55555555-5555-4555-8555-555555555555';
    const directory = await projectDirectory();
    const definition: WorkflowDefinitionV1 = {
      version: 1,
      inputs: [],
      defaults: retainedConversationDefaults(),
      blocks: [{
        kind: 'parallel',
        id: 'fan',
        failurePolicy: 'fail_stop',
        branches: [
          { id: 'slow', blocks: [step('slow-1')] },
          { id: 'quick', blocks: [step('quick-1'), step('quick-2')] },
        ],
      }],
    };
    const kit = createWorkflowRunStorageTestkit({
      runId, machineId, origin: { kind: 'direct' },
      acceptedEnvelope: await sealDirectAccepted({ runId, definition, directory }),
    });

    let releaseSlow!: () => void;
    const slowSettles = new Promise<void>((resolve) => { releaseSlow = resolve; });
    let markSlowAdmitted!: () => void;
    const slowAdmitted = new Promise<void>((resolve) => { markSlowAdmitted = resolve; });
    let slowAborted = false;
    const sessionInput = sessionInputBoundary({}, {
      onObserve: async (label, signal) => {
        // Pause tests an already admitted sibling, not competing preparation.
        if (label === 'quick-1') await slowAdmitted;
        if (label !== 'slow-1') return;
        markSlowAdmitted();
        signal?.addEventListener('abort', () => { slowAborted = true; });
        await slowSettles;
      },
    });

    let pauseRequested = false;
    const storage = {
      execute: async (operation: WorkflowRunStorageTestkitOperation, options?: Readonly<{ signal?: AbortSignal }>) => {
        if (!pauseRequested && String(operation.operation) === 'invocations.fact' && String(operation.lifecycle) === 'completed') {
          // `quick-1` is the only leaf that can settle while `slow-1` is gated.
          pauseRequested = true;
          const committed = await kit.execute(operation, options);
          kit.requestControl('pause_requested');
          return committed;
        }
        const result = await kit.execute(operation, options);
        // Release the admitted sibling only once the coordinator has actually
        // observed the pause at the next admission boundary.
        if (pauseRequested && String(operation.operation) === 'get') setTimeout(releaseSlow, 0);
        return result;
      },
    };

    await expect(workflowDaemonProcess({ storage, sessionInput, directory })({
      runId, attempt: 0, expectedRevision: kit.run().revision,
      accountCurrentness: currentness, acceptedEnvelope: kit.acceptedEnvelope()!,
    } as never)).resolves.toMatchObject({ state: 'paused' });

    expect(slowAborted).toBe(false);
    expect(rowFor(kit, 'slow-1')?.lifecycle).toBe('completed');
    expect(rowFor(kit, 'quick-1')?.lifecycle).toBe('completed');
    expect(rowFor(kit, 'quick-2')).toBeUndefined();
    expect(kit.run().state).toBe('paused');
  });
});

describe('composed durable rows carry no fabricated defaults', () => {
  it('admits omitted-concurrency siblings together and persists no capacity wait or observation deadline', async () => {
    const runId = '66666666-6666-4666-8666-666666666666';
    const directory = await projectDirectory();
    const definition: WorkflowDefinitionV1 = {
      version: 1,
      inputs: [],
      defaults: retainedConversationDefaults(),
      blocks: [{
        kind: 'parallel',
        id: 'fan',
        failurePolicy: 'collect_outcomes',
        branches: [
          { id: 'left', blocks: [step('left-1')] },
          { id: 'right', blocks: [step('right-1')] },
        ],
      }],
    };
    const kit = createWorkflowRunStorageTestkit({
      runId, machineId, origin: { kind: 'direct' },
      acceptedEnvelope: await sealDirectAccepted({ runId, definition, directory }),
    });
    // Neither sibling may settle before both are admitted. A fabricated
    // concurrency fallback of one would deadlock this gate rather than merely
    // reordering work.
    let admitted = 0;
    let releaseBoth!: () => void;
    const bothAdmitted = new Promise<void>((resolve) => { releaseBoth = resolve; });
    const sessionInput = sessionInputBoundary({}, {
      onObserve: async () => {
        admitted += 1;
        if (admitted >= 2) releaseBoth();
        await bothAdmitted;
      },
    });
    const lifecycles: string[] = [];
    const storage = {
      execute: async (operation: WorkflowRunStorageTestkitOperation, options?: Readonly<{ signal?: AbortSignal }>) => {
        if (typeof operation.lifecycle === 'string') lifecycles.push(operation.lifecycle);
        return await kit.execute(operation, options);
      },
    };
    await expect(workflowDaemonProcess({ storage, sessionInput, directory })({
      runId, attempt: 0, expectedRevision: kit.run().revision,
      accountCurrentness: currentness, acceptedEnvelope: kit.acceptedEnvelope()!,
    } as never)).resolves.toMatchObject({ state: 'succeeded' });
    expect(admitted).toBe(2);
    expect(lifecycles).not.toContain('waiting_for_capacity');
    for (const row of kit.rows()) {
      expect(openRowProgress(kit, row.index).observationDeadline).toBeUndefined();
    }
  }, 20_000);

  it('queues only an authored container limit and persists one absolute deadline only for an authored timeout', async () => {
    const runId = '77777777-7777-4777-8777-777777777777';
    const directory = await projectDirectory();
    const definition: WorkflowDefinitionV1 = {
      version: 1,
      inputs: [],
      defaults: retainedConversationDefaults(),
      blocks: [{
        kind: 'parallel',
        id: 'fan',
        failurePolicy: 'collect_outcomes',
        maxConcurrent: 1,
        branches: [
          { id: 'first', blocks: [step('untimed')] },
          { id: 'second', blocks: [step('timed', { timeoutMs: 60_000 })] },
        ],
      }],
    };
    const kit = createWorkflowRunStorageTestkit({
      runId, machineId, origin: { kind: 'direct' },
      acceptedEnvelope: await sealDirectAccepted({ runId, definition, directory }),
    });
    const lifecycles: string[] = [];
    const storage = {
      execute: async (operation: WorkflowRunStorageTestkitOperation, options?: Readonly<{ signal?: AbortSignal }>) => {
        if (typeof operation.lifecycle === 'string') lifecycles.push(operation.lifecycle);
        return await kit.execute(operation, options);
      },
    };
    await expect(workflowDaemonProcess({ storage, sessionInput: sessionInputBoundary(), directory })({
      runId, attempt: 0, expectedRevision: kit.run().revision,
      accountCurrentness: currentness, acceptedEnvelope: kit.acceptedEnvelope()!,
    } as never)).resolves.toMatchObject({ state: 'succeeded' });
    expect(lifecycles).toContain('waiting_for_capacity');
    expect(openRowProgress(kit, rowFor(kit, 'untimed')!).observationDeadline).toBeUndefined();
    expect(openRowProgress(kit, rowFor(kit, 'timed')!).observationDeadline).toMatchObject({ kind: 'at' });
  });
});

describe('composed off-page child attention discovery', () => {
  it('finds a nested attention row beyond the first page and opens its private progress at the Action host', async () => {
    const runId = '88888888-8888-4888-8888-888888888888';
    const directory = await projectDirectory();
    const definition: WorkflowDefinitionV1 = {
      version: 1,
      inputs: [],
      defaults: retainedConversationDefaults(),
      blocks: [
        step('opening'),
        {
          kind: 'parallel',
          id: 'fan',
          failurePolicy: 'collect_outcomes',
          branches: [{ id: 'stuck', blocks: [step('awaiting-human')] }],
        },
      ],
    };
    const kit = createWorkflowRunStorageTestkit({
      runId, machineId, origin: { kind: 'direct' },
      acceptedEnvelope: await sealDirectAccepted({ runId, definition, directory }),
      // One row per page, so the nested attention row cannot be on page one.
      invocationPageSize: 1,
    });
    const lossy = storageLosingFirstSettlement(kit);
    await expect(workflowDaemonProcess({
      storage: lossy,
      sessionInput: sessionInputBoundary({ 'awaiting-human': 'needs_attention' }),
      directory,
    })({
      runId, attempt: 0, expectedRevision: kit.run().revision,
      accountCurrentness: currentness, acceptedEnvelope: kit.acceptedEnvelope()!,
    } as never)).rejects.toThrowError('simulated_daemon_loss_before_settlement');
    // The parent never settled, so the actionable child row — not a parent
    // state — is the only attention signal available to an observer.
    expect(kit.run().state).toBe('running');

    const runOwner = createWorkflowRunActionOwner({
      resolveAccountId: async () => accountId,
      storage: kit,
      definitions: { get: vi.fn() },
      resolveEncryption: async () => ({ kind: 'available', witness: currentness }),
      prepareWorkspace: async () => ({
        ok: true,
        workspaceTarget: { project: { machineId, directory, checkoutRootPath: directory } },
      }),
    });
    const workflowActions = createWorkflowActionExecutor({
      isWorkflowFeatureEnabled: async () => true,
      definitions: { list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(), edit: vi.fn(), delete: vi.fn() },
      runs: runOwner,
    });
    const context = { surface: 'rpc' as const, authority: 'account_automation' as const };
    const invoke = async (actionId: string, input: unknown) => await workflowActions({ actionId, input, context } as never);

    type InvocationDetail = Readonly<{
      invocation: Readonly<{ progress: Readonly<{ invocationPath: Readonly<{ blockId: string; scope: readonly unknown[] }> }> }>;
    }>;
    let cursor: string | undefined;
    let pages = 0;
    let attentionPage = 0;
    let attention: InvocationDetail | undefined;
    do {
      const page = await invoke('workflow.run.invocations.list', {
        runId, lifecycles: ['waiting_for_approval', 'needs_attention', 'cancel_requested', 'outcome_uncertain'],
        ...(cursor ? { cursor } : {}),
      }) as Readonly<{ invocations: readonly WorkflowRunInvocationIndexV1[]; nextCursor?: string }>;
      pages += 1;
      for (const index of page.invocations) {
        // Exact private detail is opened only at the authorized Action host;
        // the server page carries structural index columns alone.
        const detail = await invoke('workflow.run.invocations.get', { runId, invocationId: index.id }) as InvocationDetail;
        if (detail.invocation.progress.invocationPath.blockId !== 'awaiting-human') continue;
        attention = detail;
        attentionPage = pages;
      }
      cursor = page.nextCursor;
    } while (cursor && !attention);
    expect(attention).toBeDefined();
    expect(attentionPage).toBeGreaterThan(1);
    expect(attention!.invocation.progress.invocationPath).toMatchObject({
      blockId: 'awaiting-human',
      scope: [{ kind: 'branch', blockId: 'fan', branchId: 'stuck' }],
    });

    // The server's indexed actionable predicate is owned and proven by
    // `workflowRunService.integration.spec.ts`; this asserts the composed CLI
    // path surfaces it instead of waiting out the caller's deadline.
    await expect(invoke('workflow.run.wait', { runId, timeoutSeconds: 1 }))
      .resolves.toMatchObject({ observation: 'needs_attention' });
  });
});

describe('composed Git workspace through the canonical SCM owner', () => {
  it('uses canonical path normalization and exercises shared plus revision-pinned worktree modes without force-removal', async () => {
    // Cross-platform path normalization stays with the canonical owner. No
    // test-only path helper is introduced here.
    await expect(prepareWorkflowAcceptedWorkspaceTarget({
      projectTarget: { machineId, directory: '~/repo/packages/app' },
      definition: { version: 1, inputs: [], defaults: {}, blocks: [step('only')] },
      env: { NODE_ENV: 'test', HOME: '/Users/alice' },
      platform: 'darwin',
      pathIsDirectory: async (path) => path === '/Users/alice/repo/packages/app',
      inspectLocation: async () => ({ inspection: { rootPath: '/Users/alice/repo' } }),
    })).resolves.toMatchObject({
      ok: true,
      workspaceTarget: { project: { directory: '/Users/alice/repo/packages/app', checkoutRootPath: '/Users/alice/repo' } },
    });
    expect(normalizeWorkflowProjectTarget({
      projectTarget: { machineId, directory: 'C:\\Users\\alice2\\repo' },
      env: { NODE_ENV: 'test', USERPROFILE: 'C:\\Users\\alice' },
      platform: 'win32',
    })).toMatchObject({ directory: 'C:\\Users\\alice2\\repo' });

    const execFileAsync = promisify(execFile);
    const root = await mkdtemp(join(tmpdir(), 'happier-composed-workspace-'));
    const git = createGitWorkflowWorkspaceTestDependencies();
    try {
      const directory = join(root, 'packages', 'app');
      await mkdir(directory, { recursive: true });
      await writeFile(join(root, 'README.md'), 'original\n', 'utf8');
      await writeFile(join(directory, 'index.ts'), 'export const fixture = true;\n', 'utf8');
      await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: root });
      await execFileAsync('git', ['add', 'README.md', 'packages/app/index.ts'], { cwd: root });
      await execFileAsync('git', [
        '-c', 'user.name=Workflow Test',
        '-c', 'user.email=workflow-test@example.invalid',
        'commit', '-m', 'test: seed composed workspace',
      ], { cwd: root });
      const revision = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
      await writeFile(join(root, 'README.md'), 'unstaged-after-staged\n', 'utf8');
      await writeFile(join(root, 'untracked.txt'), 'untracked\n', 'utf8');
      const dirtyStatus = (await execFileAsync('git', ['status', '--short'], { cwd: root })).stdout;
      expect(dirtyStatus).not.toBe('');

      const projectWorkspace = { machineId, directory, checkoutRootPath: root };
      // Shared checkout reuses the exact dirty source through the real SCM
      // owner. There is no reset, merge, commit, or force-removal here.
      const shared = await resolveWorkflowWorkspace({
        selection: { kind: 'project_checkout' },
        defaultSelection: { kind: 'project_checkout' },
        projectWorkspace,
        runId: 'run-composed-git',
        logicalInvocationRecordId: 'shared',
        deps: {},
      });
      expect(shared).toEqual({ ok: true, workspace: projectWorkspace });

      const created = await resolveWorkflowWorkspace({
        selection: { kind: 'new_worktree', source: { kind: 'workflow' } },
        defaultSelection: { kind: 'project_checkout' },
        projectWorkspace,
        runId: 'run-composed-git',
        logicalInvocationRecordId: 'isolated',
        deps: git,
      });
      expect(created).toMatchObject({
        ok: true,
        workspace: { machineId, checkout: { kind: 'git_worktree' } },
      });
      if (!created.ok) throw new Error(created.code);
      expect(created.workspace.checkoutRootPath).not.toBe(root);
      expect(created.workspace.directory).toBe(join(created.workspace.checkoutRootPath, 'packages', 'app'));
      // A workflow fork is committed-only: dirty and untracked source state
      // stays at the source and never enters the new worktree.
      expect(await readFile(join(created.workspace.checkoutRootPath, 'README.md'), 'utf8')).toBe('original\n');
      await expect(readFile(join(created.workspace.checkoutRootPath, 'untracked.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: created.workspace.checkoutRootPath })).stdout.trim()).toBe(revision);
      expect(await readFile(join(root, 'README.md'), 'utf8')).toBe('unstaged-after-staged\n');

      // The coordinator row-local resolver binds from-step scope through the
      // same durable store owner used by execution.
      const store = createInMemoryWorkflowCoordinatorStore();
      const sourceKey = workflowInvocationKey({ runId: 'run-composed-git', blockId: 'a', scope: [], attempt: 0 });
      await store.ensureIntent({ key: sourceKey, recordId: 'inv-a', runId: 'run-composed-git', blockKind: 'step', blockId: 'a', memberOrdinal: '0', path: { blockId: 'a', scope: [] }, attempt: 0, acceptedAtMs: 1, lifecycle: 'completed', workspace: { descriptor: projectWorkspace } });
      const targetKey = workflowInvocationKey({ runId: 'run-composed-git', blockId: 'b', scope: [], attempt: 0 });
      const target = await store.ensureIntent({ key: targetKey, recordId: 'inv-b', runId: 'run-composed-git', blockKind: 'step', blockId: 'b', memberOrdinal: '1', path: { blockId: 'b', scope: [] }, attempt: 0, acceptedAtMs: 2, lifecycle: 'admitting' });
      const resolver = createCoordinatorWorkspaceResolver({
        store,
        projectWorkspace,
        scm: { verifyRecordedWorkspace: async () => 'available' as const },
      });
      await expect(resolver({
        runId: 'run-composed-git',
        definition: { version: 1, inputs: [], defaults: {}, blocks: [step('b')] },
        step: { id: 'b', execution: { workspace: { kind: 'from_step', producer: { blockId: 'a', scope: { kind: 'current' } } } } },
        invocation: target,
        scope: [],
        producerBinding: createWorkflowProducerBinding({ runId: 'run-composed-git', store,
          frame: { scope: [], blocks: [step('a'), step('b')] } }),
      })).resolves.toMatchObject({ ok: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('composed Session approvals and observation deadlines', () => {
  it('passes permission ceilings and authored timeouts through canonical Session owners', async () => {
    const workspace = { machineId, directory: '/repo', checkoutRootPath: '/repo' } as const;
    const executionTarget = { kind: 'session' } as const;
    // A broader step permission than the immutable admitted ceiling is
    // rejected by the canonical Session leaf before any Session mutation.
    const deniedPrepare = vi.fn();
    const deniedEnqueue = vi.fn();
    const denied = createWorkflowSessionStepExecutor({
      credentials: { token: 'token' } as never,

      prepareConversation: deniedPrepare,
      materializeConversation: vi.fn(),
      sessionInput: { enqueue: deniedEnqueue, observe: vi.fn(), cancel: vi.fn() },
    });
    await expect(denied({
      runId: 'run-approvals',
      step: {},
      invocation: { logicalInvocationRecordId: 'inv-1' },
      input: { text: 'work', references: [], attachments: [], values: [] },
      execution: { permissionMode: 'safe-yolo' },
      authorization: { admittedPermissionCeiling: 'read-only', principal: { kind: 'host' } },
      workspace,
      onInputAccepted: vi.fn(),
    } as never)).resolves.toEqual({ kind: 'failed', code: 'workflow_permission_escalation_denied' });
    expect(deniedPrepare).not.toHaveBeenCalled();
    expect(deniedEnqueue).not.toHaveBeenCalled();

    // Omitted timeoutMs means no authored observation deadline through the
    // real coordinator plus the real Session leaf. A present timeout persists
    // one absolute deadline. Neither path invents a numeric fallback.
    const store = createInMemoryWorkflowCoordinatorStore();
    const observedDeadlines: Array<unknown> = [];
    const enqueue = vi.fn(async () => ({ status: 'accepted' as const, localId: 'local-1' }));
    const observe = vi.fn(async (input: Parameters<typeof import('./stepExecution').observeWorkflowSessionInputResult>[0]) => {
      const acceptedAtMs = Date.now();
      await input.onInputMaterialized?.(acceptedAtMs);
      // An initial observation derives its deadline from the persisted input;
      // a reobservation receives the already frozen absolute deadline instead.
      observedDeadlines.push(input.deadlineMs ?? (input.timeoutAfterInputMs === undefined
        ? undefined : acceptedAtMs + input.timeoutAfterInputMs));
      return { ok: true as const, sessionId: 'session-1', localId: 'local-1', result: { kind: 'final_text' as const, text: 'done' } };
    });
    const sessionOwner = createWorkflowSessionStepExecutor({
      credentials: { token: 'token' } as never,

      prepareConversation: async () => ({ kind: 'workflow_session_conversation', existing: null }),
      materializeConversation: async () => ({ sessionId: 'session-1', machineAdmissionTransport: vi.fn() }),
      sessionInput: { enqueue: enqueue as never,
        observe: observe as never,
        cancel: vi.fn() as never,
      },
    });
    const coordinator = createWorkflowCoordinator({
      isAcceptedAuthorizationCurrent: async () => true,
      store,
      executeStep: sessionOwner,
      resolveWorkspace: async () => ({ ok: true as const, workspace }),
    });
    const definition = {
      version: 1 as const,
      inputs: [],
      defaults: { agentTarget },
      blocks: [
        step('no-timeout'),
        step('with-timeout', { timeoutMs: 60_000 }),
      ],
    };
    await expect(coordinator.run({ runId: 'run-deadlines', definition, inputs: {}, executionTarget, authorization }))
      .resolves.toMatchObject({ state: 'succeeded' });
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(observe).toHaveBeenCalledTimes(2);
    expect(observedDeadlines[0]).toBeUndefined();
    expect(typeof observedDeadlines[1]).toBe('number');
  });
});

describe('composed practical large Run without invented limits', () => {
  it('advances 500 ordered duplicate-preserving items through the real coordinator with bounded resources', async () => {
    const runId = '99999999-9999-4999-8999-999999999999';
    const store = createInMemoryWorkflowCoordinatorStore();
    const workspace = { machineId, directory: '/repo', checkoutRootPath: '/repo' } as const;
    const executionTarget = { kind: 'session' } as const;
    // 50 practical file names repeated 10 times preserve order and
    // duplicates. This fixture proves no item/invocation quota rejects a
    // valid large Run; it does not add a product limit or timeout.
    const files = Array.from({ length: 500 }, (_, index) => `src/file-${index % 50}.ts`);
    const seen: string[] = [];
    const coordinator = createWorkflowCoordinator({
      isAcceptedAuthorizationCurrent: async () => true,
      store,
      executeStep: async ({ step: current, item }) => {
        seen.push(String(item?.value));
        return { kind: 'completed' as const, result: String(item?.value ?? current.id) };
      },
      resolveWorkspace: async () => ({ ok: true as const, workspace }),
    });
    const definition = {
      version: 1 as const,
      inputs: [],
      defaults: { agentTarget },
      blocks: [{
        kind: 'loop' as const,
        id: 'files',
        repetition: {
          kind: 'items' as const,
          items: { kind: 'literal' as const, value: files },
          execution: 'sequential' as const,
          failurePolicy: 'collect_outcomes' as const,
        },
        body: [step('process', { input: [{ kind: 'item', field: 'value' }] })],
      }],
    };
    await expect(coordinator.run({ runId, definition, inputs: {}, executionTarget, authorization }))
      .resolves.toMatchObject({ state: 'succeeded' });
    expect(seen).toEqual(files);
    const processed = [...store.records.values()].filter((record) => record.blockId === 'process');
    expect(processed).toHaveLength(500);
    expect(processed.map((record) => record.result)).toEqual(files);
  }, 20_000);
});
