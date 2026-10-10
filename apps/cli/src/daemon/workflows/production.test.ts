import { createTestWorkflowCoordinator as createWorkflowCoordinator } from './workflowCoordinator.testkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

const readinessMachineRpc = vi.hoisted(() => ({ callMachineRpc: vi.fn() }));
vi.mock('@/session/transport/rpc/machineRpc', () => readinessMachineRpc);
import {
  ARTIFACT_PLAIN_DATA_KEY_MARKER,
  encodePlainArtifactStoredContent,
  AutomationStoredWorkflowDefinitionV2Schema,
  admitAgentStartV1,
  materializeWorkflowAcceptedSnapshotV1,
  DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1,
  openWorkflowProgressStoredEnvelopeV1,
  openWorkflowAcceptedSnapshotStoredEnvelopeV1,
  parseWorkflowStoredContentEnvelopeV1,
  sealWorkflowAcceptedSnapshotStoredEnvelopeV1,
  sealWorkflowCheckpointStoredEnvelopeV1,
  sealWorkflowProgressStoredEnvelopeV1,
  serializeWorkflowStoredContentEnvelopeV1,
  type WorkflowExecutionCorrespondenceV1,
  type WorkflowProgressEnvelopeV1,
  type WorkflowDefinitionV1,
  type WorkflowMaterializedLeafV1,
  type WorkflowWorkspaceProgressV1,
  type WorkflowWorkspaceCreationIntentV1,
  type WorkflowRunEncryptionV1,
  type WorkflowActionLeafV1,
  deriveWorkflowSessionInputLocalIdV2,
  accountSettingsParse,
  createActionExecutor,
  AutomationRunCauseSchema,
  AutomationTriggerIdSchema,
  deriveAutomationOccurrenceKeyV1,
  deriveWorkflowDestinationsV1,
  ActionDefinitionV1Schema,
  createWorkflowAccountRunActionOwner,
  createWorkflowActionExecutor,
  StrictJsonValueSchema,
  getActionSpec,
  zodSchemaToJsonSchemaObject,
} from '@happier-dev/protocol';
import { MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES } from '@happier-dev/protocol/automations/automationStoredContentEnvelopeV1';
import { WorkflowMachineCommandOutputV1Schema } from '@happier-dev/protocol/workflows/stepActionsV1';
import { WorkflowInputResolutionError } from './input';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createStablePluginNotificationsOwner } from '@/plugins/runtime/invocation/services/notifications';
import { resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { notificationCatalogFixture } from '@/notifications/activity/activityNotification.testkit';

import {
  createProductionWorkflowRunCoordinator,
  createWorkflowRunPushNotificationClient,
  DurableWorkflowCoordinatorStore,
  projectWorkflowTerminalCustodySettlement,
  projectWorkflowRootSettlementLifecycle,
  resolveWorkflowTriggerClaimSource,
  type WorkflowProductionExecutionDeps,
} from './production';
import { executeClaimedRun } from '@/daemon/automation/automationRunExecutor';
import {  workflowInvocationKey } from './coordinator';
import { AgentStateRequestStore } from '@/agent/permissions/agentStateRequestStore';
import { publishServerHttpRuntimeOrigin } from '@/api/client/serverHttpBaseUrl';
import { createPlainWorkflowRunKeyCensusFixture, createWorkflowRunStorageTestkit } from './workflowRunStorage.testkit';
import { createCoordinatorWorkspaceResolver, prepareWorkflowAcceptedWorkspaceTarget } from './resolveWorkflowWorkspace';
import { createProductionWorkflowConversationOwner, createProductionWorkflowSessionStepExecutor, createWorkflowSessionStepExecutor } from './sessionStepExecutor';
import type { WorkflowRunStorageOperation } from './workflowRunStorageClient';

import { resolveWorkflowSessionConversation } from './daemonRuntime';

const runId = '7be4d65c-d3b7-4868-a416-b18d9ee29c1c';
const accountId = 'account-1';
const machineId = 'machine-1';
// These custom HTTP boundaries never publish asynchronous changes. Control
// journeys use the shared storage testkit's notifying subscription instead.
const quietStorageChanges = () => ({ dispose: async () => {} });
const now = '2026-01-01T00:00:00.000Z';
beforeEach(() => {
  // Only network and process launch are faked; the new existing-Session
  // readiness owner executes beneath these boundaries before input admission.
  let readySessionId = '';
  vi.spyOn(axios, 'get').mockImplementation(async (url) => {
    if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
    } };
    const id = /\/v2\/sessions\/([^/?]+)/.exec(url)?.[1];
    if (!id) throw new Error(`Unexpected readiness read: ${url}`);
    return { status: 200, data: { session: createSessionRecordFixture({ id, active: true,
      encryptionMode: 'plain', machineId, metadata: JSON.stringify({ machineId, path: '/repo',
        claudeSessionId: 'native-session', runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} },
      }) }) } };
  });
  vi.spyOn(axios, 'post').mockImplementation(async (url, body: unknown) => {
    if (!url.endsWith('/v2/sessions/lookup-by-tags')) throw new Error(`Unexpected readiness write: ${url}`);
    const request = body as { tags: string[] };
    const response = await axios.get(`/v2/sessions/${request.tags[0]}`);
    return { status: 200, data: { sessions: [response.data.session] } };
  });
  readinessMachineRpc.callMachineRpc.mockImplementation(async ({ method, request }: { method: string; request: { sessionId?: string } }) => {
    if (method === RPC_METHODS.SPAWN_HAPPY_SESSION) {
      readySessionId = request.sessionId!;
      return { type: 'success', sessionId: readySessionId };
    }
    return { status: 'success', sessionId: readySessionId };
  });
});
afterEach(() => resetActiveAccountSettingsSnapshotForTests());
const availability = { pause: true, resumeBoundary: false,
    restoreWorkspace: false, cancel: true, inspectExecution: true, disabledReasons: [] };
/** The canonical definition requires at least one block, so fixtures cannot use an empty program. */
const onlyStep = {
  kind: 'step' as const, id: 'work', document: { text: 'work', references: [], attachments: [] },
  input: [], result: { kind: 'text' as const },
};

function productionExecution(
  sessionInput?: NonNullable<WorkflowProductionExecutionDeps['sessionInput']>,
): WorkflowProductionExecutionDeps {
  const actionExecutor = { execute: vi.fn(async () => ({ ok: false as const, errorCode: 'unused' })) };
  return {
    credentials: { token: 'token', encryption: null },
    serverId: 'server-1',

    machineAdmissionTransport: vi.fn(async () => ({ status: 'accepted' as const, localId: 'local-1' })),
    resolveExistingSessionConversation: async () => ({ sessionId: 'session-1', machineId, directory: '/repo' }),
    ...(sessionInput ? { sessionInput } : {}),
    detachedRun: {
      actionExecutor: actionExecutor as never,
      buildActionContext: () => ({ surface: 'agent' as const, authority: 'account_automation' as const }),
    },
  };
}

// Opened Account policy and exact-Machine availability are external boundaries;
// both admission owners and ORC policy remain real underneath this fixture.
const productionMaterializationHost: NonNullable<Parameters<typeof createProductionWorkflowRunCoordinator>[0]['resolveMaterializationHost']> = async ({ runId, workDepth, directory }) => ({
  effects: { resolveTargetAvailability: async () => true },
  admitLeaf: async (leaf, facts) => admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, { kind: 'workflow_run_leaf', leaf }, {
    caller: { kind: 'originless', runId, runDepth: workDepth }, baseline: { machineId, directory },
    ledSubtreeSessionIds: [], roles: facts.role ? { [facts.role.roleId]: facts.role } : {},
    workDepthLimit: 4, callerPermissionCeiling: facts.permissionCeiling,
  }),
});

async function commandOutputAdmissionFixture(mode: 'plain' | 'e2ee', fault?: 'result_ack_lost' | 'admission_ack_lost', memberOrdinal = '0') {
  const rootId = 'root-command-output';
  const runDataKey = new Uint8Array(32).fill(7);
  const encryption: WorkflowRunEncryptionV1 = { witness: { mode, version: 1,
    contentKeyFingerprint: mode === 'plain' ? null : 'a'.repeat(64) },
    runCrypto: mode === 'plain' ? { mode } : { mode, runDataKey } };
  const sealMode = mode === 'plain' ? { mode: 'plain' as const }
    : { mode: 'e2ee' as const, runDataKey, randomBytes: (length: number) => new Uint8Array(length).fill(3) };
  const rootEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ ...sealMode,
    binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: rootId,
      sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' },
    progress: { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: '$root', scope: [] },
      blockKind: 'root', attempt: '0', logicalInvocationRecordId: rootId } }));
  const boundary = createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'direct' }, acceptedEnvelope: 'accepted' });
  await boundary.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope: 'checkpoint',
    rootInvocation: { id: rootId, contentEnvelope: rootEnvelope } });
  let lostAck = false;
  const store = await DurableWorkflowCoordinatorStore.load({ accountId, runId, parentAttempt: 0,
    rootRecordId: rootId, revision: boundary.run().revision, encryption,
    checkpoint: { kind: 'happier.workflow-checkpoint.v1', rootRecordId: rootId, nextSequence: '1', frontier: { nextBlockOrdinal: 0, paused: false } },
    storage: { execute: async operation => {
      const result = await boundary.execute(operation);
      // A real storage write followed by a lost HTTP response is a system boundary fault.
      if (fault === 'result_ack_lost' && !lostAck && operation.operation === 'invocations.fact' && operation.lifecycle === 'completed') {
        lostAck = true;
        throw new Error('result_ack_lost');
      }
      if (fault === 'admission_ack_lost' && operation.operation === 'invocations.fact' && operation.lifecycle === 'admitting') {
        throw new WorkflowInputResolutionError('workflow_input_too_large');
      }
      return result;
    } } });
  const key = workflowInvocationKey({ runId, blockId: 'command', scope: [], attempt: 0 });
  const intent = await store.ensureIntent({ key, recordId: 'command-leaf', runId, blockId: 'command', path: { blockId: 'command', scope: [] },
    blockKind: 'action', memberOrdinal, attempt: 0, acceptedAtMs: 1, lifecycle: 'pending' });
  const row = boundary.rowById(intent.recordId)!;
  const binding = { v: 1 as const, purpose: 'invocation_progress' as const, accountId, runId,
    recordId: row.index.id, sequence: row.index.sequence, parentRecordId: row.index.parentRecordId,
    memberOrdinal: row.index.memberOrdinal, attempt: row.index.attempt };
  const execution = { kind: 'action' as const, actionId: 'machines.command.run', actionRequestId: 'command-request',
    localInputId: 'command-request', input: { command: 'fixed command' } };
  return { store, boundary, key, intent, binding, execution, sealMode, rootId,
    open: () => openWorkflowProgressStoredEnvelopeV1({ ...encryption.runCrypto, binding,
      envelope: parseWorkflowStoredContentEnvelopeV1(boundary.rowById(intent.recordId)!.contentEnvelope) }) };
}

describe('production workflow coordinator', () => {
  it.each(['plain', 'e2ee'] as const)('retains evaluated quiet provenance on the real durable root (%s)', async (mode) => {
    const rootId = 'condition-root';
    const runDataKey = new Uint8Array(32).fill(7);
    const encryption: WorkflowRunEncryptionV1 = { witness: { mode, version: 1,
      contentKeyFingerprint: mode === 'plain' ? null : 'a'.repeat(64) },
      runCrypto: mode === 'plain' ? { mode } : { mode, runDataKey } };
    const sealMode = mode === 'plain' ? { mode: 'plain' as const } : { mode: 'e2ee' as const, runDataKey, randomBytes: (length: number) => new Uint8Array(length).fill(3) };
    const binding = { v: 1 as const, purpose: 'invocation_progress' as const, accountId, runId, recordId: rootId,
      sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' };
    const boundary = createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'direct' }, acceptedEnvelope: 'accepted' });
    await boundary.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope: 'checkpoint',
      rootInvocation: { id: rootId, contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
        ...sealMode, binding, progress: { kind: 'happier.workflow-progress.v1', blockKind: 'root',
          invocationPath: { blockId: '$root', scope: [] }, attempt: '0', logicalInvocationRecordId: rootId },
      })) } });
    const checkpoint = { kind: 'happier.workflow-checkpoint.v1' as const, rootRecordId: rootId,
      nextSequence: '1', frontier: { nextBlockOrdinal: 0, paused: false } };
    const store = await DurableWorkflowCoordinatorStore.load({ accountId, runId, parentAttempt: 0, encryption,
      rootRecordId: rootId, revision: boundary.run().revision, checkpoint, storage: boundary });
    const rootKey = workflowInvocationKey({ runId, blockId: '$root', scope: [], attempt: 0 });
    await store.commitFact({ key: rootKey, lifecycle: 'running' });
    const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: { agentTarget: {
      kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } } }, blocks: [
      { kind: 'step', id: 'report', document: { text: 'Report', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
      { kind: 'action', id: 'notice', actionId: 'notifications.notify_me',
        input: { message: { kind: 'result', producer: { blockId: 'report', scope: { kind: 'current' } }, path: [] } },
        onlyWhen: { kind: 'compare', operator: 'neq',
          left: { kind: 'result', producer: { blockId: 'report', scope: { kind: 'current' } }, path: [] },
          right: { kind: 'literal', value: '' } } },
    ] };
    const coordinator = createWorkflowCoordinator({ store, rootInvocationRecordId: rootId,
      isAcceptedAuthorizationCurrent: async () => true,
      resolveWorkspace: async () => ({ ok: true, workspace: { machineId, directory: '/repo', checkoutRootPath: '/repo' } }),
      executeStep: async () => ({ kind: 'completed', result: '' }) });
    expect(await coordinator.run({ runId, definition, inputs: {}, executionTarget: { kind: 'session' },
      authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' } })).toMatchObject({ state: 'succeeded' });
    const source = boundary.rows().find(row => row.index.id !== rootId && row.index.lifecycle === 'completed')!;
    const opened = openWorkflowProgressStoredEnvelopeV1({ ...encryption.runCrypto, binding,
      envelope: parseWorkflowStoredContentEnvelopeV1(boundary.rowById(rootId)!.contentEnvelope) });
    expect(opened).toMatchObject({ kind: 'available', content: { resultProvenance: {
      [source.index.id]: { notificationCondition: 'suppressed' },
    } } });
    const rejoined = await DurableWorkflowCoordinatorStore.load({ accountId, runId, parentAttempt: 0, encryption,
      rootRecordId: rootId, revision: boundary.run().revision, checkpoint: store.checkpoint, storage: boundary });
    expect(rejoined.read(rootKey)?.resultProvenance).toEqual({ [source.index.id]: { notificationCondition: 'suppressed' } });
  });
  it('recovers inputless Session creation from sealed rows after losing the leaf completion write', async () => {
    const rootId = 'inputless-root';
    const encryption = { witness: { mode: 'plain' as const, version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' as const } };
    const checkpoint = { kind: 'happier.workflow-checkpoint.v1' as const, rootRecordId: rootId,
      nextSequence: '1', frontier: { nextBlockOrdinal: 0, paused: false } };
    const boundary = createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'direct' }, acceptedEnvelope: 'accepted' });
    const rootEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: rootId,
        sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' },
      progress: { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: '$root', scope: [] },
        blockKind: 'root', attempt: '0', logicalInvocationRecordId: rootId } }));
    await boundary.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope: 'checkpoint',
      rootInvocation: { id: rootId, contentEnvelope: rootEnvelope } });
    let lossPending = true;
    let creations = 0;
    const runProcess = async () => {
      const store = await DurableWorkflowCoordinatorStore.load({ accountId, runId, parentAttempt: 0,
        rootRecordId: rootId, revision: boundary.run().revision, encryption, checkpoint,
        storage: { execute: async operation => {
          if (lossPending && operation.operation === 'invocations.fact' && operation.invocationId !== rootId && operation.lifecycle === 'completed') {
            lossPending = false;
            throw new Error('inputless_completion_write_lost');
          }
          return boundary.execute(operation);
        } } });
      const executeStep = createProductionWorkflowSessionStepExecutor({
        credentials: { token: 'token', encryption: null }, machineId, machineAdmissionTransport: vi.fn(),
        createFreshConversation: async ({ workspace }) => { creations++; return { sessionId: 'created-session', machineId, directory: workspace.directory }; },
        resolveSharedRunConversation: async () => null, resolveProducerConversation: async () => null,
        resolveExistingSessionConversation: async () => { throw new Error('Durable creation needs no runtime input'); },
        sessionInput: { enqueue: async () => { throw new Error('Inputless creation has no input'); }, observe: async () => { throw new Error('Inputless creation has no turn'); } },
      });
      const coordinator = createWorkflowCoordinator({ store, rootInvocationRecordId: rootId,
        isAcceptedAuthorizationCurrent: async () => true, executeStep,
        resolveWorkspace: async () => ({ ok: true, workspace: { machineId, directory: '/repo', checkoutRootPath: '/repo' } }),
      });
      return coordinator.run({ runId, inputs: {}, executionTarget: { kind: 'session' },
        authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
        definition: { version: 1, inputs: [], defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } }, conversation: { kind: 'fresh' } },
          blocks: [{ ...onlyStep, inputMode: 'none', document: { text: '', references: [], attachments: [] } }] },
      });
    };
    await expect(runProcess()).rejects.toThrow('inputless_completion_write_lost');
    const leaf = boundary.rows().find(row => row.index.id !== rootId)!;
    expect(openWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: leaf.index.id,
        sequence: leaf.index.sequence, parentRecordId: leaf.index.parentRecordId, memberOrdinal: leaf.index.memberOrdinal, attempt: leaf.index.attempt },
      envelope: parseWorkflowStoredContentEnvelopeV1(leaf.contentEnvelope),
    })).toMatchObject({ kind: 'available', content: { execution: { kind: 'session_ready', sessionId: 'created-session' } } });
    await expect(runProcess()).resolves.toMatchObject({ state: 'succeeded' });
    expect(creations).toBe(1);
  });

  it.each(['plain', 'e2ee'] as const)('fits exact command suffixes to the real sealed progress envelope (%s)', async mode => {
    const fixture = await commandOutputAdmissionFixture(mode, 'result_ack_lost');
    await fixture.store.commitFact({ key: fixture.key, lifecycle: 'admitting', execution: fixture.execution });
    const raw = { exitCode: 7, stdout: `old-out:${'😀\n"'.repeat(MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES / 4)}:stdout-end😀`,
      stderr: `old-error:${'é\\'.repeat(MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES / 2)}:stderr-end😀` };
    const fact = { key: fixture.key, lifecycle: 'completed' as const, result: raw };
    const committed = await fixture.store.commitFact(fact);
    const output = WorkflowMachineCommandOutputV1Schema.parse(committed.result);
    expect(output.exitCode).toBe(7);
    expect(raw.stdout.endsWith(output.stdout)).toBe(true);
    expect(raw.stderr.endsWith(output.stderr)).toBe(true);
    expect(output.stdout.endsWith(':stdout-end😀')).toBe(true);
    expect(output.stderr.endsWith(':stderr-end😀')).toBe(true);
    expect(output.stdout.charCodeAt(0) >= 0xdc00 && output.stdout.charCodeAt(0) <= 0xdfff).toBe(false);
    expect(committed.result).toMatchObject({ stdoutTruncated: true, stderrTruncated: true });
    expect(new TextEncoder().encode(fixture.boundary.rowById(fixture.intent.recordId)!.contentEnvelope).byteLength)
      .toBeLessThanOrEqual(MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES);
    expect(fixture.open()).toMatchObject({ kind: 'available', content: { result: committed.result, execution: fixture.execution } });
    // A duplicate caller with the original unprojected response rejoins the exact committed fact.
    await expect(fixture.store.commitFact(fact)).resolves.toMatchObject({ lifecycle: 'completed', result: committed.result });
  });

  it.each(['plain', 'e2ee'] as const)('keeps cancelled command result and execution output coherent after the Stop CAS (%s)', async mode => {
    const fixture = await commandOutputAdmissionFixture(mode);
    await fixture.store.commitFact({ key: fixture.key, lifecycle: 'admitting', execution: fixture.execution });
    fixture.boundary.requestControl('cancel_requested');
    const swept = fixture.boundary.rowById(fixture.intent.recordId)!;
    const current = fixture.open();
    if (current.kind !== 'available') throw new Error('expected stopped command row');
    const concurrentInteraction = { message: 'concurrent row data😀'.repeat(128) };
    await fixture.boundary.execute({ operation: 'invocations.fact', runId, parentAttempt: 0,
      accountCurrentness: { mode, version: 1, contentKeyFingerprint: mode === 'plain' ? null : 'a'.repeat(64) },
      invocationId: swept.index.id, invocationAttempt: swept.index.attempt, expectedContentRevision: swept.index.contentRevision,
      expectedLifecycle: 'cancel_requested', lifecycle: 'cancel_requested',
      contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
        ...fixture.sealMode, binding: fixture.binding, progress: { ...current.content, interaction: concurrentInteraction } })) });
    const raw = { exitCode: -1, stdout: `${'😀'.repeat(MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES)}:stdout-end😀`, stderr: 'short stderr' };
    const committed = await fixture.store.commitFact({ key: fixture.key, lifecycle: 'cancelled', result: raw,
      execution: { ...fixture.execution, output: raw }, reason: 'command_cancelled' });
    const output = WorkflowMachineCommandOutputV1Schema.parse(committed.result);
    expect(committed).toMatchObject({ lifecycle: 'cancelled', execution: { ...fixture.execution, output: committed.result } });
    expect(output.stdout.endsWith(':stdout-end😀')).toBe(true);
    expect(output.stderr).toBe('short stderr');
    expect(committed.result).toMatchObject({ stdoutTruncated: true });
    expect(fixture.open()).toMatchObject({ kind: 'available', content: { result: committed.result, interaction: concurrentInteraction,
      execution: { ...fixture.execution, output: committed.result } } });
  });

  it('leaves a small command result unchanged', async () => {
    const fixture = await commandOutputAdmissionFixture('plain');
    await fixture.store.commitFact({ key: fixture.key, lifecycle: 'admitting', execution: fixture.execution });
    const output = { exitCode: 0, stdout: 'whole stdout😀', stderr: 'whole stderr' };
    await expect(fixture.store.commitFact({ key: fixture.key, lifecycle: 'completed', result: output }))
      .resolves.toMatchObject({ result: output });
    expect(fixture.open()).toMatchObject({ kind: 'available', content: { result: output } });
  });

  it.each(['plain', 'e2ee'] as const)('refuses command admission before transport when even its minimal reply cannot fit (%s)', async mode => {
    const fixture = await commandOutputAdmissionFixture(mode);
    const opened = fixture.open();
    if (opened.kind !== 'available') throw new Error('expected current command row');
    const executionWithEnv = (length: number) => ({ ...fixture.execution,
      input: { ...fixture.execution.input, env: { VALUE: 'x'.repeat(length) } } });
    // Derive this boundary case from the actual sealed envelope, including encryption framing.
    let fits = 0;
    let exceeds = MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES;
    while (fits + 1 < exceeds) {
      const candidate = Math.floor((fits + exceeds) / 2);
      try {
        sealWorkflowProgressStoredEnvelopeV1({ ...fixture.sealMode, binding: fixture.binding,
          progress: { ...opened.content, execution: executionWithEnv(candidate) } });
        fits = candidate;
      } catch { exceeds = candidate; }
    }
    const before = fixture.boundary.calls.filter(operation => operation.operation === 'invocations.fact').length;
    await expect(fixture.store.commitFact({ key: fixture.key, lifecycle: 'admitting', execution: executionWithEnv(fits) }))
      .rejects.toMatchObject({ name: WorkflowInputResolutionError.name, code: 'workflow_input_too_large' });
    expect(fixture.boundary.calls.filter(operation => operation.operation === 'invocations.fact')).toHaveLength(before);
    expect(fixture.store.read(fixture.key)?.lifecycle).toBe('pending');
  });

  it.each(['pre_write', 'lost_ack'] as const)('distinguishes command capacity refusal from an attempted admission acknowledgement (%s)', async failure => {
    const fixture = await commandOutputAdmissionFixture('plain', failure === 'lost_ack' ? 'admission_ack_lost' : undefined, '1');
    const producerKey = workflowInvocationKey({ runId, blockId: 'producer', scope: [], attempt: 0 });
    const producer = await fixture.store.ensureIntent({ key: producerKey, recordId: 'producer-leaf', runId,
      blockId: 'producer', path: { blockId: 'producer', scope: [] }, blockKind: 'step', memberOrdinal: '0', attempt: 0,
      acceptedAtMs: 1, lifecycle: 'pending' });
    const producerRow = fixture.boundary.rowById(producer.recordId)!;
    const producerBinding = { ...fixture.binding, recordId: producerRow.index.id, sequence: producerRow.index.sequence,
      parentRecordId: producerRow.index.parentRecordId, memberOrdinal: producerRow.index.memberOrdinal, attempt: producerRow.index.attempt };
    const opened = openWorkflowProgressStoredEnvelopeV1({ mode: 'plain', binding: producerBinding,
      envelope: parseWorkflowStoredContentEnvelopeV1(producerRow.contentEnvelope) });
    if (opened.kind !== 'available') throw new Error('expected producer row');
    let fits = 0;
    let exceeds = MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES;
    if (failure === 'pre_write') while (fits + 1 < exceeds) {
      const candidate = Math.floor((fits + exceeds) / 2);
      try {
        sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain', binding: producerBinding,
          progress: { ...opened.content, result: { VALUE: 'x'.repeat(candidate) } } });
        fits = candidate;
      } catch { exceeds = candidate; }
    }
    await fixture.store.commitFact({ key: producerKey, lifecycle: 'completed', result: { VALUE: 'x'.repeat(fits) } });
    let effects = 0;
    const executor = createActionExecutor(createCliActionDeps({ token: 'token', sessionId: '', mode: 'plain', ctx: null,
      serverId: 'home', serverHttpBaseUrl: 'https://home.example.test', machineActionDirectTargetTransport: { machineId,
        invoke: async () => { effects++; return { success: true, exitCode: 0, stdout: '', stderr: '' }; } } }));
    const command: WorkflowActionLeafV1 = { kind: 'action', id: 'command', actionId: 'machines.command.run', input: {
      command: { kind: 'literal', value: 'fixed command' }, env: { kind: 'result', producer: { blockId: 'producer', scope: { kind: 'current' } }, path: [] },
    } };
    const spec = getActionSpec('machines.command.run');
    const frozen: WorkflowMaterializedLeafV1 = { kind: 'action', authoredWorkspace: { kind: 'inherit' }, sourceKey: '$root',
      blockId: 'command', selection: {}, executionTarget: { kind: 'session' }, actionId: command.actionId,
      actionContract: { inputSchema: StrictJsonValueSchema.parse(zodSchemaToJsonSchemaObject(spec.inputSchema, { target: 'draft-7' })),
        outputSchema: StrictJsonValueSchema.parse(zodSchemaToJsonSchemaObject(spec.outputSchema!, { target: 'draft-7' })) } };
    const workspace = { machineId, directory: '/repo', checkoutRootPath: '/repo' };
    const coordinator = createWorkflowCoordinator({ store: fixture.store, rootInvocationRecordId: fixture.rootId,
      executeStep: async () => { throw new Error('producer is already completed'); }, resolveWorkspace: async () => ({ ok: true, workspace }),
      isAcceptedAuthorizationCurrent: async () => true, action: { executor, buildContext: async () => ({ surface: 'cli',
        authority: 'account_automation', bypassApprovals: true, serverId: 'home',
        externalActionTarget: { kind: 'machine', machineId, project: { machineId, directory: '/repo' } } }),
        observeRun: async () => { throw new Error('immediate Action has no child Runs'); } } });
    const outcome = await coordinator.run({ runId, definition: { version: 1, inputs: [], defaults: {},
      blocks: [{ ...onlyStep, id: 'producer', result: { kind: 'json', schema: { type: 'object',
        properties: { VALUE: { type: 'string' } }, required: ['VALUE'], additionalProperties: false } } }, command] },
      inputs: {}, executionTarget: { kind: 'session' },
      authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' }, materializedLeaves: [
        { kind: 'step', authoredWorkspace: { kind: 'inherit' }, sourceKey: '$root', blockId: 'producer',
          selection: {}, executionTarget: { kind: 'session' } }, frozen] });
    expect(effects).toBe(0);
    expect(JSON.stringify(outcome)).toBe(JSON.stringify({ state: failure === 'pre_write' ? 'failed' : 'outcome_uncertain',
      reason: failure === 'pre_write' ? 'workflow_input_too_large' : 'outcome_uncertain' }));
  });
  it('executes an admitted Run lifecycle Notify me through the real worker and notification Action once', async () => {
    // The registered plugin sender is an external delivery boundary. Workflow,
    // Action, Activity policy and plugin-notification ownership stay real.
    const deliveries: unknown[] = [];
    const pluginEvents: string[] = [];
    const workflowReads: unknown[] = [];
    const actionObservations: unknown[] = [];
    const pluginNotifications = createStablePluginNotificationsOwner({ categories: [],
      channels: [{ provenance: 'external', source: { kind: 'path' }, pluginId: 'acme.delivery',
        definition: { id: 'digest', kind: 'plugin', title: 'Digest', configurable: true, defaultEnabled: true } }],
      activateChannel: async () => { pluginEvents.push('activate'); }, readChannel: () => {
        pluginEvents.push('read');
        return { occurrenceId: 'current', isCurrent: () => true,
        send: async request => { pluginEvents.push('send'); deliveries.push(request); return { deliveryId: request.deliveryId,
          channelId: request.channelId, status: 'accepted', evidence: 'provider' }; } };
      },
    });
    const settings = accountSettingsParse({ attentionDeliveryPolicyV1: { v: 1 } });
    const credentials = { token: 'e30.eyJzdWIiOiJhY2NvdW50LTEifQ.signature', encryption: null } as const;
    // Plugin contributions are executable channels, but notification dispatch
    // still requires a complete Account channel catalog. Install the exact
    // authenticated Account lifetime this production fixture represents.
    setActiveAccountSettingsSnapshot({ settings, source: 'network', rawSettings: {}, settingsVersion: 1,
      loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials),
      notificationChannelCatalog: notificationCatalogFixture(settings).notificationChannelCatalog });
    const boundary = createWorkflowRunStorageTestkit({ runId, machineId,
      origin: { kind: 'automation', automationId: 'automation-1' } });
    const runOwner = createWorkflowAccountRunActionOwner({
      resolveAccountId: async () => accountId,
      storage: boundary,
      definitions: { get: async () => { throw new Error('must_not_read_mutable_definition'); } },
      resolveEncryption: async () => ({ kind: 'available', witness: {
        mode: 'plain', version: 1, contentKeyFingerprint: null,
      } }),
      normalizeAbsolutePath: directory => directory.startsWith('/') ? directory : null,
      randomBytes: () => { throw new Error('plain_account_does_not_need_keys'); },
    });
    const unexpectedDefinitionRead = async () => { throw new Error('Notification observes the accepted Run, not mutable definitions'); };
    const executeWorkflowAction = createWorkflowActionExecutor({ isWorkflowFeatureEnabled: () => true, runs: runOwner,
      definitions: { list: unexpectedDefinitionRead, get: unexpectedDefinitionRead, create: unexpectedDefinitionRead,
        update: unexpectedDefinitionRead, edit: unexpectedDefinitionRead, delete: unexpectedDefinitionRead } });
    const actionDeps = createCliActionDeps({ token: credentials.token, sessionId: '',
      mode: 'plain', ctx: null,
      credentials, serverId: 'server-1', serverHttpBaseUrl: 'https://home.example.test',
      actionsSettingsProvider: createActionSettingsProvider({ accountSettings: settings }),
      resolvePluginNotifications: () => pluginNotifications,
      workflowAction: async args => {
        try {
          const result = await executeWorkflowAction(args);
          workflowReads.push({ actionId: args.actionId, result });
          return result;
        } catch (error) {
          workflowReads.push({ actionId: args.actionId, thrown: error instanceof Error ? {
            name: error.name, message: error.message,
            ...('code' in error && typeof error.code === 'string' ? { code: error.code } : {}),
          } : String(error) });
          throw error;
        }
      },
    });
    const executor = createActionExecutor({ ...actionDeps,
      observeActionExecution: async observation => { actionObservations.push({
        actionId: observation.actionId, result: observation.result,
      }); },
    });
    const definitionEnvelope = JSON.stringify({ t: 'plain', v: {
      inlineDefinition: { version: 1, blocks: [{ kind: 'action', id: 'notice', actionId: 'notifications.notify_me',
        input: { message: { kind: 'literal', value: 'Source Run finished' },
          channels: { kind: 'literal', value: ['acme.delivery/digest'] } } }] },
      workspace: { directory: process.cwd() }, executionTarget: { kind: 'session' },
    } });
    const coordinate = createProductionWorkflowRunCoordinator({ token: credentials.token, accountId, machineId, storage: boundary,
      resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
      resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      isAcceptedAuthorizationCurrent: async () => true,
      resolveMaterializationHost: async target => {
        const host = await productionMaterializationHost(target);
        return { ...host, effects: { ...host.effects, readActionContract: async actionId => {
          const spec = await executor.execute('action.spec.get', { id: actionId }, { surface: 'cli', authority: 'account_automation' });
          if (!spec.ok || typeof spec.result !== 'object' || spec.result === null) return null;
          const action = ActionDefinitionV1Schema.parse(Reflect.get(spec.result, 'actionSpec'));
          if (action.id !== 'notifications.notify_me') return null;
          const hostSpec = getActionSpec('notifications.notify_me');
          return { inputSchema: StrictJsonValueSchema.parse(zodSchemaToJsonSchemaObject(hostSpec.inputSchema, { target: 'draft-7' })),
            outputSchema: StrictJsonValueSchema.parse(zodSchemaToJsonSchemaObject(hostSpec.outputSchema!, { target: 'draft-7' })) };
        } } };
      },
      prepareAcceptedWorkspaceTarget: input => prepareWorkflowAcceptedWorkspaceTarget({ ...input,
        inspectLocation: async () => null }),
      onCommittedTransition: async () => {},
      workspaceScm: { realizeWorktree: async () => { throw new Error('unexpected worktree'); },
        inspectLocation: async () => null, verifyRecordedWorkspace: async () => 'available' },
      execution: { ...productionExecution(), detachedRun: { actionExecutor: executor,
        buildActionContext: () => ({ surface: 'cli', authority: 'account_automation' }) }, action: { executor,
        buildContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
        observeRun: async () => { throw new Error('Notify me has no launched Run'); } } },
    });
    const settlements: string[] = [];
    const coordinationErrors: unknown[] = [];
    const occurrence = { v: 1 as const, kind: 'runLifecycle' as const,
      source: { kind: 'workflow_run' as const, runId: 'source-run' }, condition: 'terminal' as const,
      sourceRevision: 4, occurredAt: 200 };
    const cause = AutomationRunCauseSchema.parse({ kind: 'trigger', triggerKind: 'runLifecycle',
      triggerId: 'source-trigger', triggerRevision: 0, occurredAt: occurrence.occurredAt,
      occurrenceKey: deriveAutomationOccurrenceKeyV1({ triggerId: 'source-trigger', evidence: occurrence }),
      evidence: { source: occurrence.source, condition: occurrence.condition, sourceRevision: occurrence.sourceRevision } });
    const claimed = { protocol: 'v3' as const,
      accountCurrentness: { mode: 'plain' as const, version: 1, contentKeyFingerprint: null },
      automation: { id: 'automation-1', name: 'Notify me', enabled: true },
      run: { id: runId, automationId: 'automation-1', attempt: 0, revision: 0, recipeKind: 'workflow-v2' as const,
        triggerId: AutomationTriggerIdSchema.parse('source-trigger'), cause,
        causeWorkDepth: 0, resultDelivery: { kind: 'none' as const }, executionInputEnvelope: definitionEnvelope },
    };
    await executeClaimedRun({ machineId, claimed,
      coordinateWorkflowRun: async claim => {
        try { return await coordinate(claim); }
        catch (error) { coordinationErrors.push(error); throw error; }
      },
      heartbeatMs: 60_000, leaseDurationMs: 120_000,
      resolveAutomationAccountEncryption: async () => ({ kind: 'available', witness: claimed.accountCurrentness }),
      claimClient: { heartbeatRun: async () => {}, failRun: async failure => { settlements.push(failure.errorCode); } },
    });
    expect(coordinationErrors).toEqual([]);
    // The Workflow coordinator owns durable terminal settlement; the ordinary
    // Automation claim settlement API is used only for pre-start refusal here.
    expect(settlements).toEqual([]);
    expect(boundary.run().state, JSON.stringify({ run: boundary.run(), progress: boundary.rows(),
      workflowReads, actionObservations, pluginEvents })).toBe('succeeded');
    expect(deliveries).toEqual([expect.objectContaining({ body: 'Source Run finished' })]);
    // Resume reads the retained completed Action row; it cannot repeat delivery.
    await coordinate({ runId, attempt: 0, expectedRevision: boundary.run().revision,
      accountCurrentness: claimed.accountCurrentness, acceptedEnvelope: boundary.acceptedEnvelope()! });
    expect(deliveries).toHaveLength(1);
  });

  it('publishes distinct accepted destination writers during parallel nested execution', async () => {
    const writer = (id: string, name: string, sessionId: string) => ({ ...onlyStep, id, name,
      execution: { conversation: { kind: 'existing_session' as const, sessionId, machineId } } });
    const authored: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } },
      conversation: { kind: 'existing_session', sessionId: 'session-1', machineId },
    }, blocks: [{ kind: 'parallel', id: 'together', failurePolicy: 'collect_outcomes', branches: [
      { id: 'first', blocks: [writer('check', 'Check', 'session-1')] },
      { id: 'second', blocks: [{ kind: 'if', id: 'nested',
        when: { kind: 'exists', value: { kind: 'literal', value: true } }, otherwise: [],
        then: [writer('report', 'Report', 'session-2'), { kind: 'workflow', id: 'child', name: 'Child', workflowRef: 'builtin:child',
          input: {}, execution: { conversation: { kind: 'existing_session', sessionId: 'session-2', machineId } } }] }] },
    ] }] };
    const accepted = await materializeWorkflowAcceptedSnapshotV1({ definition: authored,
      context: { source: { kind: 'inline' }, inputs: {}, machineId, executionTarget: { kind: 'session' },
        workspaceTarget: { project: { machineId, directory: '/repo', checkoutRootPath: '/repo' } },
        origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } } },
      admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true,
        readWorkflowDefinition: async () => ({ sourceKey: 'builtin:child', definition: { version: 1, inputs: [],
          defaults: { ...authored.defaults, conversation: { kind: 'existing_session', sessionId: 'session-2', machineId } },
          blocks: [{ kind: 'loop', id: 'repeated', repetition: { kind: 'count', count: { kind: 'literal', value: 2 } },
            body: [writer('follow-up', 'Follow up', 'session-2')] }] } }) } });
    if (!accepted.ok) throw new Error(accepted.error.code);
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: accepted.snapshot,
    }));
    const boundary = createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'direct' }, acceptedEnvelope });
    const rootProgress = () => {
      const row = boundary.rows().find(row => row.index.parentRecordId === null)!;
      const opened = openWorkflowProgressStoredEnvelopeV1({ mode: 'plain', envelope: parseWorkflowStoredContentEnvelopeV1(row.contentEnvelope),
        binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: row.index.id,
          sequence: row.index.sequence, parentRecordId: null, memberOrdinal: row.index.memberOrdinal, attempt: row.index.attempt } });
      if (opened.kind !== 'available') throw new Error('root_unavailable');
      return opened.content.stepProgress;
    };
    const runningProgress: unknown[] = [];
    const coordinate = createProductionWorkflowRunCoordinator({ token: 'token', accountId, machineId, storage: boundary,
      execution: productionExecution({
        enqueue: async request => ({ status: 'accepted', localId: deriveWorkflowSessionInputLocalIdV2(request.workflow) }),
        observe: async ({ sessionId, localId }) => {
          runningProgress.push(rootProgress());
          return { ok: true, sessionId, localId, result: { kind: 'final_text', text: 'done' } };
        },
      }),
      resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
      resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      isAcceptedAuthorizationCurrent: async () => true,
      workspaceScm: { realizeWorktree: async () => { throw new Error('unexpected worktree'); },
        inspectLocation: async () => null, verifyRecordedWorkspace: async () => 'available' },
    });
    await expect(coordinate({ runId, attempt: 0, expectedRevision: 0, acceptedEnvelope,
      accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null } })).resolves.toMatchObject({ state: 'succeeded' });
    expect(runningProgress).toContainEqual(expect.objectContaining({ destinations: expect.arrayContaining([
      expect.objectContaining({ blockId: 'check', name: 'Check', ordinal: 1, sessionIds: ['session-1'] }),
      expect.objectContaining({ blockId: 'report', name: 'Report', ordinal: 2, sessionIds: ['session-2'],
        observation: expect.objectContaining({ lifecycle: 'running' }) }),
    ]) }));
    expect(rootProgress()).toMatchObject({ destinations: expect.arrayContaining([
      expect.objectContaining({ blockId: 'check', observation: expect.objectContaining({ lifecycle: 'completed' }) }),
      expect.objectContaining({ blockId: 'report', observation: expect.objectContaining({ lifecycle: 'completed' }) }),
      expect.objectContaining({ sourceKey: 'builtin:child', blockId: 'follow-up', ordinal: 1, name: 'Follow up', sessionIds: ['session-2'],
        observation: expect.objectContaining({ lifecycle: 'completed' }) }),
    ]) });
    const owner = createWorkflowAccountRunActionOwner({ resolveAccountId: async () => accountId,
      storage: boundary, definitions: { get: async () => { throw new Error('must_not_read_mutable_definition'); } },
      resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      normalizeAbsolutePath: directory => directory.startsWith('/') ? directory : null,
      randomBytes: () => { throw new Error('plain_account_does_not_need_keys'); },
    });
    const beforeList = boundary.calls.length;
    const listed = await owner.execute({ actionId: 'workflow.run.list', input: { targetSessionId: 'session-2' }, context: {} });
    expect(listed.runs[0]?.stepProgress).toEqual(rootProgress());
    expect(boundary.calls.slice(beforeList).map(call => call.operation)).toEqual(['list']);
    const root = boundary.rows().find(row => row.index.parentRecordId === null)!;
    const beforeReload = rootProgress();
    const restored = await DurableWorkflowCoordinatorStore.load({ accountId, runId, parentAttempt: 0,
      rootRecordId: root.index.id, revision: boundary.run().revision, storage: boundary,
      encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } },
      checkpoint: { kind: 'happier.workflow-checkpoint.v1', rootRecordId: root.index.id, nextSequence: '20',
        frontier: { nextBlockOrdinal: 1, paused: false } },
      authoredDefinition: accepted.snapshot.authoredDefinition, definition: accepted.snapshot.definition,
      frozenChildren: accepted.snapshot.frozenChildren,
      destinations: deriveWorkflowDestinationsV1({ definition: accepted.snapshot.authoredDefinition,
        children: accepted.snapshot.frozenChildren, materializedLeaves: accepted.snapshot.materializedLeaves }).leaves,
    });
    await restored.refreshStepProgress();
    expect(rootProgress()?.destinations).toEqual(beforeReload?.destinations);
    const newestFollowUp = beforeReload?.destinations?.find(leaf => leaf.blockId === 'follow-up')?.observation;
    if (!newestFollowUp) throw new Error('expected observed follow-up');
    const earlierFollowUps = boundary.rows().filter(row => {
      const opened = openWorkflowProgressStoredEnvelopeV1({ mode: 'plain', envelope: parseWorkflowStoredContentEnvelopeV1(row.contentEnvelope),
        binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: row.index.id,
          sequence: row.index.sequence, parentRecordId: row.index.parentRecordId,
          memberOrdinal: row.index.memberOrdinal, attempt: row.index.attempt } });
      return opened.kind === 'available' && opened.content.invocationPath.blockId === 'follow-up'
        && BigInt(row.index.sequence) < BigInt(newestFollowUp.sequence);
    });
    expect(earlierFollowUps).toHaveLength(1);
    await restored.readByLogicalInvocation(earlierFollowUps[0]!.index.id);
    await restored.refreshStepProgress();
    expect(rootProgress()?.destinations).toEqual(beforeReload?.destinations);
  });

  it('publishes authored step counts and completed parallel items rather than admission cursors', async () => {
    const authored: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } },
      conversation: { kind: 'existing_session', sessionId: 'session-1', machineId },
    }, blocks: [onlyStep, { kind: 'if', id: 'conditional',
      when: { kind: 'exists', value: { kind: 'literal', value: true } }, otherwise: [],
      then: [{ kind: 'loop', id: 'empty', repetition: { kind: 'count', count: { kind: 'literal', value: 0 } }, body: [{ ...onlyStep, id: 'unused' }] }] },
      { kind: 'loop', id: 'batch', repetition: { kind: 'items', items: { kind: 'literal', value: ['slow', 'fast', 'third'] },
        execution: 'parallel', maxConcurrent: 2, failurePolicy: 'collect_outcomes' }, body: [{ ...onlyStep, id: 'item' }] }] };
    const accepted = await materializeWorkflowAcceptedSnapshotV1({ definition: authored,
      context: { source: { kind: 'inline' }, inputs: {}, machineId, executionTarget: { kind: 'session' },
        workspaceTarget: { project: { machineId, directory: '/repo', checkoutRootPath: '/repo' } },
        origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } } },
      admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true } });
    if (!accepted.ok) throw new Error(accepted.error.code);
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: accepted.snapshot,
    }));
    const boundary = createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'direct' }, acceptedEnvelope });
    const openedRoot = () => {
      const row = boundary.rows().find((row) => row.index.parentRecordId === null);
      if (!row) throw new Error('root_missing');
      return openWorkflowProgressStoredEnvelopeV1({ mode: 'plain', envelope: parseWorkflowStoredContentEnvelopeV1(row.contentEnvelope),
        binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: row.index.id,
          sequence: row.index.sequence, parentRecordId: row.index.parentRecordId, memberOrdinal: row.index.memberOrdinal, attempt: row.index.attempt } });
    };
    let releaseSlow: (() => void) | undefined;
    const slow = new Promise<void>((resolve) => { releaseSlow = resolve; });
    const observed: unknown[] = [];
    let item = 0;
    const execution = productionExecution({
      enqueue: async request => ({ status: 'accepted', localId: deriveWorkflowSessionInputLocalIdV2(request.workflow) }),
      observe: async ({ sessionId, localId }) => {
        const opened = openedRoot();
        observed.push(opened.kind === 'available' ? Reflect.get(opened.content, 'stepProgress') : opened.kind);
        const ordinal = item++;
        if (ordinal === 1) await slow;
        if (ordinal === 3) releaseSlow?.();
        return { ok: true, sessionId, localId, result: { kind: 'final_text', text: 'done' } };
      },
    });
    const coordinate = createProductionWorkflowRunCoordinator({ token: 'token', accountId, machineId, storage: boundary, execution,
      resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
      resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      isAcceptedAuthorizationCurrent: async () => true,
      workspaceScm: { realizeWorktree: async () => { throw new Error('unexpected worktree'); },
        inspectLocation: async () => null, verifyRecordedWorkspace: async () => 'available' },
    });
    await expect(coordinate({ runId, attempt: 0, expectedRevision: 0, acceptedEnvelope,
      accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null } })).resolves.toMatchObject({ state: 'succeeded' });
    expect(observed[0]).toMatchObject({ completed: 0, total: 3 });
    expect(observed[3]).toMatchObject({ completed: 2, total: 3, currentLoop: { completed: 1, total: 3 } });
    expect(openedRoot()).toMatchObject({ kind: 'available', content: { stepProgress: { completed: 3, total: 3 } } });
  });

  it('counts only current loop-item attempts after reload and replacement', async () => {
    const rootId = 'projection-root';
    const loopId = 'projection-loop';
    const authored: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {}, blocks: [{ kind: 'loop', id: 'batch',
      repetition: { kind: 'items', items: { kind: 'literal', value: [1, 2] }, execution: 'parallel', failurePolicy: 'collect_outcomes' }, body: [onlyStep] }] };
    const boundary = createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'direct' }, acceptedEnvelope: 'opaque-accepted' });
    const checkpoint = { kind: 'happier.workflow-checkpoint.v1' as const, rootRecordId: rootId,
      nextSequence: '5', frontier: { nextBlockOrdinal: 0, paused: false } };
    const checkpointEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'checkpoint', accountId, runId }, checkpoint }));
    const seal = (id: string, sequence: string, parentRecordId: string | null, memberOrdinal: string,
      progress: WorkflowProgressEnvelopeV1) => serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: id, sequence, parentRecordId, memberOrdinal, attempt: progress.attempt }, progress }));
    const rootEnvelope = seal(rootId, '0', null, '0', { kind: 'happier.workflow-progress.v1', blockKind: 'root',
      invocationPath: { blockId: '$root', scope: [] }, attempt: '0', logicalInvocationRecordId: rootId });
    await boundary.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope,
      rootInvocation: { id: rootId, contentEnvelope: rootEnvelope } });
    const frame = (id: string, index: number, attempt = '0'): WorkflowProgressEnvelopeV1 => ({
      kind: 'happier.workflow-progress.v1', blockKind: 'loop', invocationPath: { blockId: 'batch', scope: [{ kind: 'iteration', blockId: 'batch', index }] },
      attempt, logicalInvocationRecordId: attempt === '0' ? id : 'item-old',
      ...(attempt === '0' ? {} : { previousAttemptRecordId: 'item-old' }),
      frame: { ownerBlockId: 'batch', source: { kind: 'item', index: String(index) } },
      container: { kind: 'body', nextBlockOrdinal: '1' },
    });
    await boundary.execute({ operation: 'invocations.admit', runId, expectedRevision: 1, checkpointEnvelope, invocations: [
      { id: loopId, sequence: '1', parentRecordId: rootId, memberOrdinal: '0', lifecycle: 'running',
        contentEnvelope: seal(loopId, '1', rootId, '0', { kind: 'happier.workflow-progress.v1', blockKind: 'loop',
          invocationPath: { blockId: 'batch', scope: [] }, attempt: '0', logicalInvocationRecordId: loopId,
          container: { kind: 'loop', mode: 'items', source: { kind: 'definition', reference: { kind: 'literal', value: [1, 2] } }, itemCount: '2', nextMemberIndex: '2', nextBodyBlockOrdinal: '0' } }) },
      { id: 'item-old', sequence: '2', parentRecordId: loopId, memberOrdinal: '0', lifecycle: 'completed', contentEnvelope: seal('item-old', '2', loopId, '0', frame('item-old', 0)) },
      { id: 'item-other', sequence: '3', parentRecordId: loopId, memberOrdinal: '1', lifecycle: 'running', contentEnvelope: seal('item-other', '3', loopId, '1', frame('item-other', 1)) },
    ] });
    const store = await DurableWorkflowCoordinatorStore.load({ accountId, runId, parentAttempt: 0, storage: boundary, checkpoint,
      revision: boundary.run().revision, rootRecordId: rootId, authoredDefinition: authored,
      encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } } });
    const progress = () => openWorkflowProgressStoredEnvelopeV1({ mode: 'plain', envelope: parseWorkflowStoredContentEnvelopeV1(boundary.rowById(rootId)?.contentEnvelope),
      binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: rootId, sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' } });
    await store.refreshStepProgress();
    expect(progress()).toMatchObject({ kind: 'available', content: { stepProgress: { completed: 0, total: 1, currentLoop: { completed: 1, total: 2 } } } });
    await boundary.execute({ operation: 'invocations.admit', runId, expectedRevision: boundary.run().revision, checkpointEnvelope,
      invocations: [{ id: 'item-new', sequence: '4', parentRecordId: loopId, memberOrdinal: '0', lifecycle: 'running',
        contentEnvelope: seal('item-new', '4', loopId, '0', frame('item-new', 0, '1')) }] });
    // Seed a persisted newer attempt at the HTTP/database boundary, not inside the projector.
    boundary.rowById('item-new')!.index.attempt = '1';
    const replacement = await store.readByLogicalInvocation('item-new');
    if (!replacement) throw new Error('replacement_missing');
    await store.refreshStepProgress();
    expect(progress()).toMatchObject({ kind: 'available', content: { stepProgress: { completed: 0, total: 1, currentLoop: { completed: 0, total: 2 } } } });
    await store.commitFact({ key: replacement.key, lifecycle: 'completed' });
    expect(progress()).toMatchObject({ kind: 'available', content: { stepProgress: { completed: 0, total: 1, currentLoop: { completed: 1, total: 2 } } } });
    await boundary.execute({ operation: 'invocations.admit', runId, expectedRevision: boundary.run().revision, checkpointEnvelope,
      invocations: [{ id: 'loop-recovered', sequence: '5', parentRecordId: rootId, memberOrdinal: '0', lifecycle: 'running',
        contentEnvelope: seal('loop-recovered', '5', rootId, '0', { kind: 'happier.workflow-progress.v1', blockKind: 'loop',
          invocationPath: { blockId: 'batch', scope: [] }, attempt: '1', logicalInvocationRecordId: loopId, previousAttemptRecordId: loopId,
          container: { kind: 'loop', mode: 'items', source: { kind: 'definition', reference: { kind: 'literal', value: [1, 2] } }, itemCount: '2', nextMemberIndex: '2', nextBodyBlockOrdinal: '0' } }) }] });
    boundary.rowById('loop-recovered')!.index.attempt = '1';
    await store.readByLogicalInvocation('loop-recovered');
    await store.refreshStepProgress();
    const inherited = await store.readByLogicalInvocation('item-other');
    if (!inherited) throw new Error('inherited_item_missing');
    await store.commitFact({ key: inherited.key, lifecycle: 'completed' });
    expect(progress()).toMatchObject({ kind: 'available', content: { stepProgress: { completed: 0, total: 1, currentLoop: { completed: 2, total: 2 } } } });
  });
  it('renders each nested Session leaf with its frozen source-qualified role, not a same-id root role', async () => {
    const target = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.test', localId: 'test' } };
    const retained = { kind: 'existing_session' as const, sessionId: 'session-1', machineId };
    const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: { agentTarget: target, conversation: retained },
      blocks: [onlyStep, { kind: 'workflow', id: 'nested', workflowRef: 'builtin:child', input: {} }] };
    const child: WorkflowDefinitionV1 = { ...definition, blocks: [onlyStep] };
    const role = (instructions: string): NonNullable<WorkflowMaterializedLeafV1['role']> => ({
      roleId: instructions, name: instructions, instructions, runsAs: { kind: 'session' },
      workspaceWrites: 'allow', secondOpinion: 'off', enabled: true,
    });
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: {
        startedBy: 'user', definition, authoredDefinition: definition, inputs: {}, workDepth: 0, metadata: null, machineId,
        executionTarget: { kind: 'session' }, source: { kind: 'inline' }, origin: { kind: 'direct' },
        workspaceTarget: { project: { machineId, directory: '/repo', checkoutRootPath: '/repo' } },
        authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' },
        frozenChildren: { 'builtin:child': child }, materializedLeaves: [
          { authoredWorkspace: { kind: 'inherit' as const }, sourceKey: '$root', blockId: 'work', kind: 'step', selection: definition.defaults,
            executionTarget: { kind: 'session' }, role: role('Root role only') },
          { authoredWorkspace: { kind: 'inherit' as const }, sourceKey: '$root', blockId: 'nested', kind: 'workflow', selection: definition.defaults,
            executionTarget: { kind: 'session' }, childRef: 'builtin:child' },
          { authoredWorkspace: { kind: 'inherit' as const }, sourceKey: 'builtin:child', blockId: 'work', kind: 'step', selection: child.defaults,
            executionTarget: { kind: 'session' }, role: role('Child role only') },
        ],
      },
    }));
    const boundary = createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'direct' }, acceptedEnvelope });
    const sent: string[] = [];
    const execution = productionExecution({
      enqueue: async request => { sent.push(request.text); return { status: 'accepted', localId: deriveWorkflowSessionInputLocalIdV2(request.workflow) }; },
      observe: async ({ sessionId, localId }) => ({ ok: true, sessionId, localId, result: { kind: 'final_text', text: 'done' } }),
    });
    const coordinate = createProductionWorkflowRunCoordinator({ token: 'token', accountId, machineId,
      resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
      resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      isAcceptedAuthorizationCurrent: async () => true, storage: boundary, onCommittedTransition: vi.fn(), execution,
      workspaceScm: { realizeWorktree: async () => { throw new Error('unexpected worktree'); },
        inspectLocation: async () => null, verifyRecordedWorkspace: async () => 'available' },
    });
    await expect(coordinate({ runId, attempt: 0, expectedRevision: 0, acceptedEnvelope,
      accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null } })).resolves.toMatchObject({ state: 'succeeded' });
    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain('Root role only');
    expect(sent[1]).toContain('Child role only');
    expect(sent[1]).not.toContain('Root role only');
  });
  it('accepts the same origin input after sealed durable reload regardless of correspondence field order', async () => {
    const rootId = 'root-origin-reload';
    const storage = createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'direct', originSessionId: 'origin' }, acceptedEnvelope: 'accepted' });
    const rootEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: rootId,
        sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' },
      progress: { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: '$root', scope: [] },
        blockKind: 'root', attempt: '0', logicalInvocationRecordId: rootId } }));
    await storage.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope: 'checkpoint',
      rootInvocation: { id: rootId, contentEnvelope: rootEnvelope } });
    const load = () => DurableWorkflowCoordinatorStore.load({ accountId, runId, parentAttempt: 0, rootRecordId: rootId,
      revision: storage.run().revision, storage,
      encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } },
      checkpoint: { kind: 'happier.workflow-checkpoint.v1', rootRecordId: rootId, nextSequence: '2', frontier: { nextBlockOrdinal: 0, paused: false } },
    });
    const first = await load();
    const key = workflowInvocationKey({ runId, blockId: 'work', scope: [], attempt: 0 });
    await first.ensureIntent({ blockKind: 'step', key, recordId: 'origin-reload-leaf', runId, blockId: 'work', path: { blockId: 'work', scope: [] },
      memberOrdinal: '0', attempt: 0, acceptedAtMs: Date.now(), lifecycle: 'pending' });
    const correspondence = { kind: 'session' as const, sessionId: 'origin', localInputId: 'same-origin-input' };
    await first.commitFact({ key, lifecycle: 'admitting', execution: correspondence, input: { document: onlyStep.document, input: [] }, resultContract: onlyStep.result });
    const restored = await load();
    const executeStep = createWorkflowSessionStepExecutor({ credentials: { token: 'token', encryption: null },
      prepareConversation: async () => { throw new Error('must retain conversation'); },
      materializeConversation: async () => { throw new Error('must not create conversation'); },

      sessionInput: { enqueue: async () => { throw new Error('must not enqueue'); },
        observe: async ({ sessionId, localId, onInputMaterialized }) => {
          await onInputMaterialized?.(2_000);
          return { ok: true, sessionId, localId, result: { kind: 'final_text', text: 'rejoined origin result' } };
        } },
    });
    const coordinator = createWorkflowCoordinator({ store: restored, rootInvocationRecordId: rootId, executeStep,
      resolveWorkspace: async () => ({ ok: true, workspace: { machineId, directory: '/repo', checkoutRootPath: '/repo' } }),
      isAcceptedAuthorizationCurrent: async () => true });
    await expect(coordinator.run({ runId, inputs: {}, originSessionId: 'origin', executionTarget: { kind: 'session' },
      authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' },
      definition: { version: 1, inputs: [], defaults: {}, blocks: [{ ...onlyStep, execution: { conversation: { kind: 'origin_session' } } }] } }))
      .resolves.toMatchObject({ state: 'succeeded' });
    expect(restored.read(key)).toMatchObject({ lifecycle: 'completed', result: 'rejoined origin result', execution: correspondence });
  });

  it.each(['acknowledged', 'delayed_response', 'lost_response'] as const)('adopts attention revisions so approval, sibling allocation and frontier completion keep the same claim (%s)', async (responseKind) => {
    const rootId = 'root-attention-claim';
    const rootEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: rootId,
        sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' },
      progress: { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: '$root', scope: [] },
        blockKind: 'root', attempt: '0', logicalInvocationRecordId: rootId },
    }));
    const storage = createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'direct' }, acceptedEnvelope: 'accepted' });
    await storage.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope: 'checkpoint',
      rootInvocation: { id: rootId, contentEnvelope: rootEnvelope } });
    let releaseResponse = () => {};
    let reportApplied = () => {};
    const applied = new Promise<void>(resolve => { reportApplied = resolve; });
    const responseReleased = new Promise<void>(resolve => { releaseResponse = resolve; });
    // The HTTP boundary can apply an attention fact before its response reaches the worker.
    const delayedStorage = { execute: async (operation: WorkflowRunStorageOperation) => {
      const result = await storage.execute(operation);
      if (operation.operation === 'invocations.fact' && operation.lifecycle === 'waiting_for_approval') {
        reportApplied();
        if (responseKind === 'delayed_response') await responseReleased;
        if (responseKind === 'lost_response') throw new Error('lost_attention_response');
      }
      return result;
    } };
    const store = await DurableWorkflowCoordinatorStore.load({ accountId, runId, parentAttempt: 0,
      rootRecordId: rootId, revision: storage.run().revision, storage: delayedStorage,
      encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } },
      checkpoint: { kind: 'happier.workflow-checkpoint.v1', rootRecordId: rootId, nextSequence: '1',
        frontier: { nextBlockOrdinal: 0, paused: false } },
    });
    const key = workflowInvocationKey({ runId, blockId: 'work', scope: [], attempt: 0 });
    await store.ensureIntent({ blockKind: 'step', key, recordId: 'approval-leaf', runId, blockId: 'work', path: { blockId: 'work', scope: [] },
      memberOrdinal: '0', attempt: 0, acceptedAtMs: Date.now(), lifecycle: 'pending' });
    await store.readCurrent({ runId, blockId: 'sibling', scope: [], memberOrdinal: '1' });
    const attention = store.commitFact({ key, lifecycle: 'waiting_for_approval' });
    await applied;
    if (responseKind !== 'delayed_response') await attention;
    try {
      await store.ensureIntent({ blockKind: 'step', key: workflowInvocationKey({ runId, blockId: 'sibling', scope: [], attempt: 0 }),
        recordId: 'sibling-leaf', runId, blockId: 'sibling', path: { blockId: 'sibling', scope: [] },
        memberOrdinal: '1', attempt: 0, acceptedAtMs: Date.now(), lifecycle: 'pending' });
    } finally {
      releaseResponse();
      await attention;
    }
    expect(store.revision).toBe(storage.run().revision);
    await store.commitFact({ key, lifecycle: 'running' });
    await store.commitFact({ key, lifecycle: 'completed', result: 'approved result' });
    await expect(store.commitFrontier({ nextBlockOrdinal: 1 })).resolves.toBeUndefined();
    expect(store.readFrontier().nextBlockOrdinal).toBe(1);
    expect(store.revision).toBe(storage.run().revision);
  });

  it('refreshes input and numeric conditions from the frozen origin through nested loop frames', async () => {
    const frozenOriginId = 'c123456789012345678901234';
    const continuedSessionId = 'c987654321098765432109876';
    const callerOriginId = 'c111111111111111111111111';
    const authored: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } },
      conversation: { kind: 'existing_session', sessionId: continuedSessionId, machineId },
    }, blocks: [{ kind: 'loop', id: 'rounds', repetition: { kind: 'count', count: { kind: 'literal', value: 2 } },
      body: [{ kind: 'if', id: 'budget',
        when: { kind: 'compare', operator: 'lt',
          left: { kind: 'session_context_field', field: 'usage.tokensUsed' },
          right: { kind: 'session_context_field', field: 'goal.tokenBudget' },
        },
        then: [{ ...onlyStep, input: [{ kind: 'session_context', recentTurns: 0 }] }], otherwise: [],
      }],
    }] };
    const materialized = await materializeWorkflowAcceptedSnapshotV1({ definition: authored,
      admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true },
      context: { source: { kind: 'inline' }, origin: { kind: 'direct', originSessionId: frozenOriginId },
        inputs: {}, machineId, executionTarget: { kind: 'session' },
        workspaceTarget: { project: { machineId, directory: '/repo', checkoutRootPath: '/repo' } },
        authorization: { principal: { kind: 'host' } },
      },
    });
    if (!materialized.ok) throw new Error(materialized.error.code);
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: materialized.snapshot,
    }));
    const boundary = createWorkflowRunStorageTestkit({ runId, machineId,
      origin: { kind: 'direct', originSessionId: frozenOriginId }, acceptedEnvelope });
    const credentials = { token: 'token', encryption: null } as const;
    let accountedTokens = 3;
    const sentInputs: string[] = [];
    const metadataReads: string[] = [];
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      const path = String(url);
      if (path.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      const sessionId = path.includes(`/v2/sessions/${frozenOriginId}`) ? frozenOriginId
        : path.includes(`/v2/sessions/${continuedSessionId}`) ? continuedSessionId : undefined;
      if (!sessionId) throw new Error(`unexpected Session metadata lookup: ${path}`);
      metadataReads.push(sessionId);
      return { status: 200, data: { session: { id: sessionId, seq: 0, createdAt: 0, updatedAt: 0,
        active: true, activeAt: 0, metadataVersion: 0, agentStateVersion: 0, agentState: null,
        dataEncryptionKey: null, encryptionMode: 'plain', metadata: JSON.stringify({ machineId, path: '/repo',
          claudeSessionId: 'native-session', runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} },
          sessionWorkStateV1: { v: 1, backendId: 'test', updatedAt: 10, primaryItemId: 'goal', items: [{
            id: 'goal', kind: 'goal', origin: 'happier', status: 'active', title: 'Frozen origin goal',
            updatedAt: 10, tokenBudget: 50, tokensUsed: 9999, startedAt: 5, createdAt: 1,
          }] },
        }),
      } } };
    });
    const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      expect(String(url)).toMatch(/\/v2\/usage\/query$/u);
      expect(body).toMatchObject({ filters: { sessionIds: [frozenOriginId] }, dateRange: { startMs: 5 } });
      return { status: 200, data: { v: 1, totals: { eventCount: 1,
        tokens: { input: accountedTokens, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: accountedTokens },
        cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' },
      } } };
    });
    try {
      const execution = productionExecution({
        enqueue: async (request) => {
          expect(request.sessionId).toBe(continuedSessionId);
          sentInputs.push(request.text);
          accountedTokens = 10;
          return { status: 'accepted', localId: deriveWorkflowSessionInputLocalIdV2(request.workflow) };
        },
        observe: async ({ sessionId, localId }) => ({ ok: true, sessionId, localId, result: { kind: 'final_text', text: 'done' } }),
      });
      const coordinate = createProductionWorkflowRunCoordinator({ token: 'token', accountId, machineId,
        resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
        resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
        isAcceptedAuthorizationCurrent: async () => true, storage: boundary, onCommittedTransition: vi.fn(),
        execution: { ...execution, resolveExistingSessionConversation: async (identity) =>
          await resolveWorkflowSessionConversation({ credentials, ...identity }) },
        workspaceScm: { realizeWorktree: async () => { throw new Error('context does not create a worktree'); },
          inspectLocation: async () => null, verifyRecordedWorkspace: async () => 'available' },
      });
      await expect(coordinate({ runId, attempt: 0, expectedRevision: 0, acceptedEnvelope,
        scopeSessionId: callerOriginId, accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null },
      })).resolves.toEqual({ state: 'succeeded' });
      expect(sentInputs).toHaveLength(2);
      expect(sentInputs[0]).toContain('"usage":{"kind":"accounted","tokensUsed":3}');
      expect(sentInputs[1]).toContain('"usage":{"kind":"accounted","tokensUsed":10}');
      for (const text of sentInputs) {
        expect(text).toContain('Frozen origin goal');
        expect(text).not.toContain('9999');
      }
      expect(metadataReads).toContain(frozenOriginId);
      expect(metadataReads).not.toContain(callerOriginId);
    } finally {
      get.mockRestore();
      post.mockRestore();
    }
  });

  it.each(['native_shared', 'retained_session'] as const)('preserves frozen authored omission for the root default worktree and nearest shared conversation owner with %s', async (scenario) => {
    const retainedSession = scenario === 'retained_session';
    const rootId = 'root-materialized-default';
    const rootKey = workflowInvocationKey({ runId, blockId: '$root', scope: [], attempt: 0 });
    const authored = { version: 1 as const, inputs: [], defaults: {
      agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.test', localId: 'test' } },
      conversation: retainedSession
        ? { kind: 'existing_session' as const, sessionId: 'retained-session', machineId }
        : { kind: 'shared_run' as const },
      workspace: { kind: 'new_worktree' as const, source: { kind: 'original' as const } },
    }, blocks: [{ kind: 'parallel' as const, id: 'parallel', maxConcurrent: 1, failurePolicy: 'fail_stop' as const, branches: [
      { id: 'inherited-branch', blocks: [{ ...onlyStep, id: 'inherited' }] },
      { id: 'explicit-branch', blocks: [{ ...onlyStep, id: 'explicit',
        ...(retainedSession ? {} : { execution: { conversation: { kind: 'shared_run' as const } } }) }] },
    ] }] };
    const materialized = await materializeWorkflowAcceptedSnapshotV1({ definition: authored,
      context: { source: { kind: 'automation', automationId: 'automation-1' }, inputs: {}, machineId,
        executionTarget: { kind: retainedSession ? 'session' : 'detached_run' },
        workspaceTarget: { project: { machineId, directory: '/repo', checkoutRootPath: '/repo' }, originalCommittedRevision: 'a'.repeat(40) },
        authorization: { principal: { kind: 'host' } } },
      admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true },
    });
    expect(materialized).toMatchObject({ ok: true });
    if (!materialized.ok) throw new Error(materialized.error.code);
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: materialized.snapshot,
    }));
    const boundary = createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'automation', automationId: 'automation-1' }, acceptedEnvelope });
    await boundary.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope: 'checkpoint',
      rootInvocation: { id: rootId, contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
        mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: rootId,
          sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' },
        progress: { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: '$root', scope: [] },
          blockKind: 'root', attempt: '0', logicalInvocationRecordId: rootId },
      })) } });
    const opened = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId },
      envelope: parseWorkflowStoredContentEnvelopeV1(boundary.acceptedEnvelope()),
    });
    if (opened.kind !== 'available') throw new Error('accepted_snapshot_unavailable');
    const accepted = opened.content;
    const store = await DurableWorkflowCoordinatorStore.load({ accountId, runId, parentAttempt: 0,
      rootRecordId: rootId, revision: boundary.run().revision,
      encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } },
      checkpoint: { kind: 'happier.workflow-checkpoint.v1', rootRecordId: rootId, nextSequence: '1', frontier: { nextBlockOrdinal: 0, paused: false } },
       storage: boundary,
    });
    await store.commitFact({ key: rootKey, lifecycle: 'running' });
    // Only SCM materialization/verification and agent execution cross external boundaries.
    const realizeWorktree = vi.fn(async (intent: WorkflowWorkspaceCreationIntentV1) => ({
      directory: `/worktrees/${intent.displayName}`, checkoutRootPath: `/worktrees/${intent.displayName}`, branchName: intent.displayName,
    }));
    const resolveWorkspace = createCoordinatorWorkspaceResolver({ store, projectWorkspace: accepted.workspaceTarget.project,
      originalCommittedRevision: accepted.workspaceTarget.originalCommittedRevision,
      scm: { realizeWorktree, inspectLocation: async () => null, verifyRecordedWorkspace: async () => 'available' },
    });
    const conversations = createProductionWorkflowConversationOwner({ machineId,
      createFreshConversation: async () => { throw new Error('unexpected_fresh_session'); },
      resolveSharedRunConversation: async () => null,
      resolveProducerConversation: async () => null,
      // Session metadata is reached over the authenticated server boundary.
      resolveExistingSessionConversation: async () => ({ sessionId: 'retained-session', machineId,
        directory: '/retained', agentTarget: authored.defaults.agentTarget }),
    });
    const coordinator = createWorkflowCoordinator({ store, rootInvocationRecordId: rootId,
      isAcceptedAuthorizationCurrent: async () => true,
      resolveWorkspace: async (params) => await resolveWorkspace(params),
      ...(retainedSession ? { prepareStep: async (params: Parameters<typeof conversations.prepare>[0]) => {
        const prepared = await conversations.prepare(params);
        return { ...(prepared.existing ? { conversationWorkspace: prepared.existing } : {}) };
      } } : {}),
      executeStep: async (params) => {
        const binding = params.conversationBinding;
        await params.beforeInputAdmission();
        if (retainedSession) await params.onInputAccepted({ kind: 'session', sessionId: 'retained-session', localInputId: params.step.id });
        else {
          if (binding?.kind !== 'shared') throw new Error('shared_binding_expected');
          await params.onInputAccepted({ kind: 'detached_run', runId: `native-${binding.scopeOwnerKey}`,
            localInputId: params.step.id, runtimeSelection: {} });
        }
        return { kind: 'completed', result: params.step.id };
      },
    });
    await expect(coordinator.run({ runId, definition: accepted.definition, inputs: accepted.inputs,
      executionTarget: accepted.executionTarget, authorization: accepted.authorization,
      materializedLeaves: accepted.materializedLeaves,
      authoredDefinition: accepted.authoredDefinition,
    })).resolves.toEqual({ state: 'succeeded' });
    const records = await Promise.all(boundary.rows().map(async (row) => await store.readByLogicalInvocation(row.index.id)));
    const inherited = records.find((record) => record?.blockId === 'inherited');
    const explicit = records.find((record) => record?.blockId === 'explicit');
    const inheritedBody = records.find((record) => record?.frame?.source.kind === 'branch' && record.frame.source.branchId === 'inherited-branch');
    const root = await store.readByLogicalInvocation(rootId);
    if (retainedSession) {
      expect(realizeWorktree).not.toHaveBeenCalled();
      expect(root?.workspace).toBeUndefined();
      for (const record of [inherited, explicit]) expect(record?.workspace).toEqual({ descriptor: {
        machineId, directory: '/retained', checkoutRootPath: '/retained',
      } });
      return;
    }
    expect(inheritedBody?.sharedConversationInvocationRecordId?.detached_run).toBe(inherited?.recordId);
    expect(root?.sharedConversationInvocationRecordId?.detached_run).toBe(explicit?.recordId);
    expect(realizeWorktree).toHaveBeenCalledOnce();
    expect(root?.workspace?.descriptor).toBeDefined();
    expect(inherited?.workspace).toEqual(root?.workspace);
    expect(explicit?.workspace).toEqual(root?.workspace);
  });

  it.each(['lost_response', 'pause_before_repeat'] as const)('never treats an admitting reload as release authority after %s', async (failure) => {
    const rootId = 'root-admission';
    const rootEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: rootId,
        sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' },
      progress: { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: '$root', scope: [] },
        blockKind: 'root', attempt: '0', logicalInvocationRecordId: rootId },
    }));
    const boundary = createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'direct' }, acceptedEnvelope: 'accepted' });
    await boundary.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope: 'checkpoint',
      rootInvocation: { id: rootId, contentEnvelope: rootEnvelope } });
    const lostResponse = new Error('admission_acknowledgement_lost');
    const store = await DurableWorkflowCoordinatorStore.load({
      accountId, runId, parentAttempt: 0, rootRecordId: rootId, revision: 1,
      encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } },
      checkpoint: { kind: 'happier.workflow-checkpoint.v1', rootRecordId: rootId, nextSequence: '1', frontier: { nextBlockOrdinal: 0, paused: false } },
       storage: { execute: async (operation: WorkflowRunStorageOperation) => {
        const result = await boundary.execute(operation);
        if (failure === 'lost_response' && operation.operation === 'invocations.fact' && operation.lifecycle === 'admitting') throw lostResponse;
        return result;
      } },
    });
    const key = workflowInvocationKey({ runId, blockId: 'work', scope: [], attempt: 0 });
    await store.ensureIntent({ blockKind: 'step', key, recordId: 'pending-leaf', runId, blockId: 'work', path: { blockId: 'work', scope: [] },
      memberOrdinal: '0', attempt: 0, acceptedAtMs: Date.now(), lifecycle: 'pending' });
    if (failure === 'pause_before_repeat') {
      await store.commitFact({ key, lifecycle: 'admitting' });
      boundary.requestControl('pause_requested');
    }
    await expect(store.commitFact({ key, lifecycle: 'admitting' })).rejects.toThrow();
    expect(store.read(key)?.lifecycle).toBe('admitting');
  });

  it.each(['session', 'action', 'immediate_action', 'unrelated_immediate_action'] as const)('merges only exact late %s acceptance into refreshed cancellation custody without losing row content', async (kind) => {
    const rootId = 'root-origin-cancel-race';
    const rootEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: rootId,
        sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' },
      progress: { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: '$root', scope: [] },
        blockKind: 'root', attempt: '0', logicalInvocationRecordId: rootId },
    }));
    const boundary = createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'direct', originSessionId: 'origin' }, acceptedEnvelope: 'accepted' });
    await boundary.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope: 'checkpoint',
      rootInvocation: { id: rootId, contentEnvelope: rootEnvelope } });
    const store = await DurableWorkflowCoordinatorStore.load({
      accountId, runId, parentAttempt: 0, rootRecordId: rootId, revision: boundary.run().revision,
      encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } },
      checkpoint: { kind: 'happier.workflow-checkpoint.v1', rootRecordId: rootId, nextSequence: '1', frontier: { nextBlockOrdinal: 0, paused: false } },
       storage: boundary,
    });
    const key = workflowInvocationKey({ runId, blockId: 'work', scope: [], attempt: 0 });
    const immediate = kind === 'immediate_action' || kind === 'unrelated_immediate_action';
    const commandOutput = { exitCode: -1, stdout: 'partial stdout', stderr: 'partial stderr' };
    const correspondence: WorkflowExecutionCorrespondenceV1 = kind === 'session'
      ? { kind: 'session', sessionId: 'origin', localInputId: 'origin-input' }
      : { kind: 'action', actionId: immediate ? 'machines.command.run' : 'review.start', actionRequestId: 'action-request', localInputId: 'action-request', input: {} };
    const acknowledgement: WorkflowExecutionCorrespondenceV1 = correspondence.kind === 'action'
      ? immediate
        ? { ...correspondence, ...(kind === 'unrelated_immediate_action' ? { actionRequestId: 'unrelated-request' } : {}), output: commandOutput }
        : { ...correspondence, output: { results: [{ key: 'codex', ok: true, result: { runId: 'native-review' } }] },
          awaitedRuns: [{ key: 'codex', runId: 'native-review' }] } : correspondence;
    const intent = await store.ensureIntent({ key, recordId: 'origin-leaf', runId, blockId: 'work', path: { blockId: 'work', scope: [] },
      blockKind: kind === 'session' ? 'step' : 'action', memberOrdinal: '0', attempt: 0, acceptedAtMs: Date.now(), lifecycle: 'pending' });
    await store.commitFact({ key, lifecycle: 'admitting', execution: correspondence,
      input: { document: onlyStep.document, input: [] }, resultContract: onlyStep.result });
    boundary.requestControl('cancel_requested');
    const swept = boundary.rowById(intent.recordId)!;
    const binding = { v: 1 as const, purpose: 'invocation_progress' as const, accountId, runId, recordId: swept.index.id,
      sequence: swept.index.sequence, parentRecordId: swept.index.parentRecordId, memberOrdinal: swept.index.memberOrdinal, attempt: swept.index.attempt };
    const current = openWorkflowProgressStoredEnvelopeV1({ mode: 'plain', binding,
      envelope: parseWorkflowStoredContentEnvelopeV1(swept.contentEnvelope) });
    if (current.kind !== 'available') throw new Error('expected readable current row');
    // A concurrent owner may publish into the same opaque row before this
    // host acceptance reaches the daemon; the merge must use current bytes.
    await boundary.execute({ operation: 'invocations.fact', runId, parentAttempt: 0,
      accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null },
      invocationId: swept.index.id, invocationAttempt: swept.index.attempt,
      expectedContentRevision: swept.index.contentRevision, expectedLifecycle: 'cancel_requested', lifecycle: 'cancel_requested',
      contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
        mode: 'plain', binding, progress: { ...current.content,
          ...(!immediate ? { result: 'published before acknowledgement' } : {}), interaction: { message: 'concurrent row content' } },
      })),
    });
    const observationDeadline = { kind: 'at' as const, expiresAt: '2026-01-01T00:00:10.000Z' };
    const commit = store.commitFact({ key, lifecycle: immediate ? 'cancelled' : 'running', execution: acknowledgement,
      ...(immediate ? { result: commandOutput, reason: 'command_cancelled' } : { observationDeadline }) });
    if (kind === 'unrelated_immediate_action') {
      await expect(commit).rejects.toThrow('cancelled');
      expect(openWorkflowProgressStoredEnvelopeV1({ mode: 'plain', binding,
        envelope: parseWorkflowStoredContentEnvelopeV1(boundary.rowById(intent.recordId)!.contentEnvelope) }))
        .toMatchObject({ kind: 'available', content: { execution: correspondence, interaction: { message: 'concurrent row content' } } });
      return;
    }
    const expectedResult = immediate ? commandOutput : 'published before acknowledgement';
    await expect(commit)
      .resolves.toMatchObject({ lifecycle: immediate ? 'cancelled' : 'cancel_requested', execution: acknowledgement,
        ...(immediate ? { reason: 'command_cancelled' } : { observationDeadline }), result: expectedResult });
    const committed = boundary.rowById(intent.recordId)!;
    expect(committed.index.lifecycle).toBe(immediate ? 'cancelled' : 'cancel_requested');
    expect(openWorkflowProgressStoredEnvelopeV1({ mode: 'plain', binding,
      envelope: parseWorkflowStoredContentEnvelopeV1(committed.contentEnvelope) }))
      .toMatchObject({ kind: 'available', content: { execution: acknowledgement, ...(immediate ? {} : { observationDeadline }),
        input: { document: onlyStep.document, input: [] }, resultContract: onlyStep.result,
        interaction: { message: 'concurrent row content' }, result: expectedResult } });
  });

  it('binds the default Workflow push client to the active Home', async () => {
    const release = publishServerHttpRuntimeOrigin('https://active-home.example.test/', 'https');
    const get = vi.spyOn(axios, 'get').mockResolvedValue({ data: { tokens: [] } });
    try {
      const client = createWorkflowRunPushNotificationClient('token-1');
      await expect(client.fetchPushTokens()).resolves.toEqual([]);
      expect(get).toHaveBeenCalledWith(
        'https://active-home.example.test/v1/push-tokens',
        expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer token-1' }) }),
      );
    } finally {
      get.mockRestore();
      release();
    }
  });

  it('persists independent class pointers beside the default workspace and replays a fresh rebind without writes', async () => {
    const rootId = 'root-class-pointers';
    const rootKey = workflowInvocationKey({ runId, blockId: '$root', scope: [], attempt: 0 });
    const workspace = {
      creationIntent: { kind: 'git_worktree', sourceDirectory: '/repo', baseRef: 'a'.repeat(40),
        displayName: 'workflow-default', branchMode: 'new' },
      descriptor: { machineId, directory: '/worktrees/default/packages/app', checkoutRootPath: '/worktrees/default',
        checkout: { kind: 'git_worktree', branchName: 'workflow-default' } },
    } satisfies WorkflowWorkspaceProgressV1;
    const rootBinding = { v: 1 as const, purpose: 'invocation_progress' as const, accountId, runId,
      recordId: rootId, sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' };
    const boundary = createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'direct' }, acceptedEnvelope: 'accepted' });
    await boundary.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope: 'checkpoint',
      rootInvocation: { id: rootId, contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
        mode: 'plain', binding: rootBinding,
        progress: { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: '$root', scope: [] },
          blockKind: 'root', attempt: '0', logicalInvocationRecordId: rootId, workspace },
      })) } });
    const load = (checkpoint: ConstructorParameters<typeof DurableWorkflowCoordinatorStore>[0]['checkpoint']) =>
      DurableWorkflowCoordinatorStore.load({
        accountId, runId, parentAttempt: 0, rootRecordId: rootId, revision: boundary.run().revision,
        encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } },
        checkpoint,
        storage: boundary,
      });
    const store = await load({ kind: 'happier.workflow-checkpoint.v1', rootRecordId: rootId,
      nextSequence: '1', frontier: { nextBlockOrdinal: 0, paused: false } });
    await store.commitFact({ key: rootKey, lifecycle: 'running' });
    const admit = async (blockId: string, ordinal: string, execution: WorkflowExecutionCorrespondenceV1) =>
      store.ensureIntent({ blockKind: 'step', key: workflowInvocationKey({ runId, blockId, scope: [], attempt: 0 }),
        recordId: `inv-${blockId}`, runId, blockId, path: { blockId, scope: [] }, attempt: 0,
        memberOrdinal: ordinal, parentKey: rootKey, acceptedAtMs: 1, lifecycle: 'running', execution });
    const originalExecution = { kind: 'session', sessionId: 'session-original', localInputId: 'input-original' } satisfies WorkflowExecutionCorrespondenceV1;
    const detachedExecution = { kind: 'detached_run', runId: 'native-detached', localInputId: 'input-detached', runtimeSelection: {} } satisfies WorkflowExecutionCorrespondenceV1;
    const replacementExecution = { kind: 'session', sessionId: 'session-replacement', localInputId: 'input-replacement' } satisfies WorkflowExecutionCorrespondenceV1;
    const original = await admit('session-first', '0', originalExecution);
    const detached = await admit('detached', '1', detachedExecution);
    const replacement = await admit('session-replacement', '2', replacementExecution);
    await store.commitSharedConversation({ scopeOwnerKey: rootId, targetClass: 'session', invocationRecordId: original.recordId });
    await store.commitSharedConversation({ scopeOwnerKey: rootId, targetClass: 'detached_run', invocationRecordId: detached.recordId });

    const reopened = await load({ ...store.checkpoint });
    const shared = (targetClass: 'session' | 'detached_run') => ({ kind: 'shared' as const, scopeOwnerKey: rootId, targetClass });
    await expect(reopened.resolveSharedInvocation(shared('session'))).resolves.toMatchObject({ recordId: original.recordId, execution: originalExecution });
    await expect(reopened.resolveSharedInvocation(shared('detached_run'))).resolves.toMatchObject({ recordId: detached.recordId, execution: detachedExecution });
    expect(reopened.read(rootKey)).toMatchObject({ workspace, sharedConversationInvocationRecordId: {
      session: original.recordId, detached_run: detached.recordId,
    } });
    expect(reopened.read(rootKey)?.execution).toBeUndefined();

    // The recovery admitter supplies the new exact leaf and the previous
    // target; the pointer owner changes only this class's future binding.
    const rebind = { scopeOwnerKey: rootId, targetClass: 'session' as const,
      invocationRecordId: replacement.recordId, replacesExecution: originalExecution };
    const beforeRebind = boundary.calls.length;
    await Promise.all([reopened.commitSharedConversation(rebind), reopened.commitSharedConversation(rebind)]);
    expect(boundary.calls.slice(beforeRebind).filter((operation) => operation.operation === 'invocations.fact')).toHaveLength(1);
    await expect(reopened.resolveSharedInvocation(shared('session'))).resolves.toMatchObject({ recordId: replacement.recordId, execution: replacementExecution });
    await expect(reopened.resolveSharedInvocation(shared('detached_run'))).resolves.toMatchObject({ recordId: detached.recordId, execution: detachedExecution });
    await expect(reopened.readByLogicalInvocation(original.recordId)).resolves.toMatchObject({ execution: originalExecution });

    const sealedRoot = boundary.rowById(rootId)?.contentEnvelope;
    if (!sealedRoot) throw new Error('Missing sealed scope owner');
    const opened = openWorkflowProgressStoredEnvelopeV1({ mode: 'plain', binding: rootBinding,
      envelope: parseWorkflowStoredContentEnvelopeV1(sealedRoot) });
    expect(opened).toMatchObject({ kind: 'available', content: { workspace,
      sharedConversationInvocationRecordId: { session: replacement.recordId, detached_run: detached.recordId } } });
    const replayed = await load({ ...reopened.checkpoint });
    const beforeReplay = boundary.calls.length;
    await replayed.commitSharedConversation(rebind);
    await replayed.commitSharedConversation(rebind);
    await expect(replayed.resolveSharedInvocation(shared('session'))).resolves.toMatchObject({ recordId: replacement.recordId, execution: replacementExecution });
    await expect(replayed.resolveSharedInvocation(shared('detached_run'))).resolves.toMatchObject({ recordId: detached.recordId, execution: detachedExecution });
    expect(boundary.calls.slice(beforeReplay).filter((operation) => (
      operation.operation === 'invocations.fact' || operation.operation === 'invocations.admit' || operation.operation === 'transition'
    ))).toEqual([]);
    expect(boundary.rowById(rootId)?.contentEnvelope).toBe(sealedRoot);
    expect(boundary.rows()).toHaveLength(4);
  });

  it.each(['before_mutation', 'after_mutation'] as const)('acknowledges a pointer-only fact only when its sealed mutation applied after %s', async (failure) => {
    const rootId = 'root-pointer-ack';
    const rootKey = workflowInvocationKey({ runId, blockId: '$root', scope: [], attempt: 0 });
    const rootEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: rootId,
        sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' },
      progress: { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: '$root', scope: [] },
        blockKind: 'root', attempt: '0', logicalInvocationRecordId: rootId },
    }));
    const boundary = createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'direct' }, acceptedEnvelope: 'accepted' });
    await boundary.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope: 'checkpoint',
      rootInvocation: { id: rootId, contentEnvelope: rootEnvelope } });
    const storageFailure = new Error('pointer_storage_response_lost');
    let failNextPointerWrite = true;
    const store = await DurableWorkflowCoordinatorStore.load({
      accountId, runId, parentAttempt: 0, rootRecordId: rootId, revision: boundary.run().revision,
      encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } },
      checkpoint: { kind: 'happier.workflow-checkpoint.v1', rootRecordId: rootId, nextSequence: '1', frontier: { nextBlockOrdinal: 0, paused: false } },
       storage: { execute: async (operation: WorkflowRunStorageOperation) => {
        // Fault only the transport boundary; real sealing, store publication,
        // and the server-shaped durable row owner remain in the path.
        if (failNextPointerWrite && operation.operation === 'invocations.fact' && operation.invocationId === rootId) {
          failNextPointerWrite = false;
          if (failure === 'after_mutation') await boundary.execute(operation);
          throw storageFailure;
        }
        return await boundary.execute(operation);
      } },
    });
    const execution = { kind: 'session', sessionId: 'pointer-session', localInputId: 'pointer-input' } satisfies WorkflowExecutionCorrespondenceV1;
    const leaf = await store.ensureIntent({ blockKind: 'step', key: workflowInvocationKey({ runId, blockId: 'work', scope: [], attempt: 0 }),
      recordId: 'pointer-leaf', runId, blockId: 'work', path: { blockId: 'work', scope: [] },
      memberOrdinal: '0', parentKey: rootKey, attempt: 0, acceptedAtMs: 1, lifecycle: 'running', execution });
    const publication = { scopeOwnerKey: rootId, targetClass: 'session' as const, invocationRecordId: leaf.recordId };
    const binding = { kind: 'shared' as const, scopeOwnerKey: rootId, targetClass: 'session' as const };
    if (failure === 'before_mutation') {
      await expect(store.commitSharedConversation(publication)).rejects.toBe(storageFailure);
      expect(boundary.rowById(rootId)?.contentEnvelope).toBe(rootEnvelope);
      await expect(store.resolveSharedInvocation(binding)).resolves.toBeNull();
    } else {
      await expect(store.commitSharedConversation(publication)).resolves.toBeUndefined();
      await expect(store.resolveSharedInvocation(binding)).resolves.toMatchObject({ recordId: leaf.recordId, execution });
    }
    await store.commitSharedConversation(publication);
    await expect(store.resolveSharedInvocation(binding)).resolves.toMatchObject({ recordId: leaf.recordId, execution });
    const sealedRoot = boundary.rowById(rootId)?.contentEnvelope;
    const beforeReplay = boundary.calls.length;
    await store.commitSharedConversation(publication);
    expect(boundary.calls.slice(beforeReplay).filter((operation) => operation.operation === 'invocations.fact')).toEqual([]);
    expect(boundary.rowById(rootId)?.contentEnvelope).toBe(sealedRoot);
    expect(store.read(rootKey)?.lifecycle).toBe('pending');
  });

  it.each([
    { pointer: 'present', defaultTarget: 'detached_run' },
    { pointer: 'absent', defaultTarget: 'detached_run' },
    { pointer: 'present', defaultTarget: 'session' },
  ] as const)('reserves recovered native input before a fresh earlier branch with a $pointer pointer under a $defaultTarget default', async ({ pointer, defaultTarget }) => {
    const rootId = 'root-native-restart';
    const parallelId = 'parallel-native-restart';
    const bodyId = 'body-native-restart';
    const recoveredId = 'leaf-native-restart';
    const producerId = 'producer-native-restart';
    const rootKey = workflowInvocationKey({ runId, blockId: '$root', scope: [], attempt: 0 });
    const parallelKey = workflowInvocationKey({ runId, blockId: 'parallel', scope: [], attempt: 0 });
    const scope = [{ kind: 'branch' as const, blockId: 'parallel', branchId: 'recovered' }];
    const bodyKey = workflowInvocationKey({ runId, blockId: 'parallel', scope, attempt: 0 });
    const workspace = { machineId, directory: '/repo', checkoutRootPath: '/repo' };
    const retainedAgentTarget = { kind: 'agent' as const,
      identity: { pluginId: 'happier.agent.claude', localId: 'claude' } };
    const execution = { kind: 'detached_run', runId: 'native-owned', localInputId: 'input-owned',
      runtimeSelection: { agentTarget: retainedAgentTarget } } satisfies WorkflowExecutionCorrespondenceV1;
    const boundary = createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'direct' }, acceptedEnvelope: 'accepted' });
    await boundary.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope: 'checkpoint',
      rootInvocation: { id: rootId, contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
        mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: rootId,
          sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' },
        progress: { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: '$root', scope: [] },
          blockKind: 'root', attempt: '0', logicalInvocationRecordId: rootId, workspace: { descriptor: workspace } },
      })) } });
    const load = (checkpoint: ConstructorParameters<typeof DurableWorkflowCoordinatorStore>[0]['checkpoint'],
      storage: ConstructorParameters<typeof DurableWorkflowCoordinatorStore>[0]['storage']) => DurableWorkflowCoordinatorStore.load({
      accountId, runId, parentAttempt: 0, rootRecordId: rootId, revision: boundary.run().revision,
      encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } }, checkpoint, storage,
    });
    const seed = await load({ kind: 'happier.workflow-checkpoint.v1', rootRecordId: rootId,
      nextSequence: '1', frontier: { nextBlockOrdinal: 0, paused: false } }, boundary);
    await seed.commitFact({ key: rootKey, lifecycle: 'running' });
    if (defaultTarget === 'session') {
      const producerKey = workflowInvocationKey({ runId, blockId: 'producer', scope: [], attempt: 0 });
      await seed.ensureIntent({ blockKind: 'step', key: producerKey, recordId: producerId, runId, blockId: 'producer',
        path: { blockId: 'producer', scope: [] }, parentKey: rootKey, memberOrdinal: '0', attempt: 0, acceptedAtMs: 1,
        lifecycle: 'running', execution, input: { document: onlyStep.document, input: [] }, workspace: { descriptor: workspace } });
      await seed.commitFact({ key: producerKey, lifecycle: 'completed', result: 'producer' });
    }
    await seed.ensureIntent({ blockKind: 'parallel', key: parallelKey, recordId: parallelId, runId, blockId: 'parallel',
      path: { blockId: 'parallel', scope: [] }, parentKey: rootKey, memberOrdinal: defaultTarget === 'session' ? '1' : '0', attempt: 0, acceptedAtMs: 1,
      lifecycle: 'running', container: { kind: 'parallel', nextBranchOrdinal: '2' } });
    await seed.ensureIntent({ blockKind: 'parallel', key: bodyKey, recordId: bodyId, runId, blockId: 'parallel',
      path: { blockId: 'parallel', scope }, parentKey: parallelKey, memberOrdinal: '1', attempt: 0, acceptedAtMs: 1,
      lifecycle: 'running', frame: { ownerBlockId: 'parallel', source: { kind: 'branch', branchId: 'recovered' } },
      container: { kind: 'body', nextBlockOrdinal: '0' } });
    await seed.ensureIntent({ blockKind: 'step', key: workflowInvocationKey({ runId, blockId: 'owned', scope, attempt: 0 }),
      recordId: recoveredId, runId, blockId: 'owned', path: { blockId: 'owned', scope }, parentKey: bodyKey,
      memberOrdinal: '0', attempt: 0, acceptedAtMs: 1, lifecycle: 'running', execution,
      input: { document: onlyStep.document, input: [] }, workspace: { descriptor: workspace } });
    if (pointer === 'present') await seed.commitSharedConversation({ scopeOwnerKey: rootId,
      targetClass: 'detached_run', invocationRecordId: defaultTarget === 'session' ? producerId : recoveredId });

    let releaseLookup!: () => void;
    const lookupHeld = new Promise<void>((resolve) => { releaseLookup = resolve; });
    let notifyLookup!: () => void;
    const lookupEntered = new Promise<void>((resolve) => { notifyLookup = resolve; });
    let releaseNative!: () => void;
    const nativeHeld = new Promise<void>((resolve) => { releaseNative = resolve; });
    let notifyObserved!: () => void;
    const recoveredObserved = new Promise<void>((resolve) => { notifyObserved = resolve; });
    const store = await load({ ...seed.checkpoint }, { execute: async (operation: WorkflowRunStorageOperation) => {
      // Slow the genuine exact DB lookup, not the internal binder or store.
      if (operation.operation === 'invocations.current' && operation.parentRecordId === bodyId && operation.memberOrdinal === '0') {
        notifyLookup();
        await lookupHeld;
      }
      return await boundary.execute(operation);
    } });
    const events: string[] = [];
    const coordinator = createWorkflowCoordinator({ store, rootInvocationRecordId: rootId,
      isAcceptedAuthorizationCurrent: async () => true,
      allocateInvocationRecordId: (() => { let ordinal = 0; return () => `new-restart-${ordinal++}`; })(),
      resolveWorkspace: async () => ({ ok: true, workspace }),
      prepareStep: async ({ step }) => { events.push(`prepare:${step.id}`); return {}; },
      executeStep: async (params) => {
        if (params.step.id === 'owned') {
          expect(params.invocation.execution).toEqual(execution);
          events.push('observe:owned');
          notifyObserved();
          await nativeHeld;
          events.push('settle:owned');
        } else {
          await params.beforeInputAdmission();
          events.push('admit:new');
          const binding = params.conversationBinding;
          const retained = binding?.kind === 'shared' ? await store.resolveSharedInvocation(binding)
            : binding?.kind === 'from_step' ? await params.producerBinding?.resolve(binding.producer) : undefined;
          if (!retained && binding?.kind !== 'shared') throw new Error('Missing retained binding');
          await params.onInputAccepted({ ...execution, runId: retained?.execution?.kind === 'detached_run'
            ? retained.execution.runId : 'incorrect-fresh-native', localInputId: 'input-new' });
        }
        return { kind: 'completed', result: params.step.id };
      },
    });
    const conversation = defaultTarget === 'session'
      ? { kind: 'from_step' as const, producer: { blockId: 'producer', scope: { kind: 'outer' as const, levels: 1 } } }
      : { kind: 'shared_run' as const };
    const freshStep = { ...onlyStep, id: 'new', execution: { conversation } };
    const recoveredStep = { ...onlyStep, id: 'owned', execution: { conversation } };
    const definition = { version: 1, inputs: [], defaults: { agentTarget: retainedAgentTarget }, blocks: [
      ...(defaultTarget === 'session' ? [{ ...onlyStep, id: 'producer' }] : []),
      { kind: 'parallel', id: 'parallel', failurePolicy: 'fail_stop',
        branches: [{ id: 'fresh', blocks: [freshStep] }, { id: 'recovered', blocks: [recoveredStep] }] },
    ] } satisfies WorkflowDefinitionV1;
    const materializedLeaves = ['producer', 'owned', 'new'].map((blockId) => ({ authoredWorkspace: { kind: 'inherit' as const }, sourceKey: '$root', blockId,
      kind: 'step' as const, selection: { agentTarget: retainedAgentTarget,
        ...(blockId === 'producer' ? {} : { conversation }) },
      executionTarget: { kind: 'detached_run' as const } })) satisfies WorkflowMaterializedLeafV1[];
    const run = { runId, definition, inputs: {}, executionTarget: { kind: defaultTarget },
      authorization: { admittedPermissionCeiling: 'default' as const, principal: { kind: 'host' as const } },
      ...(defaultTarget === 'session' ? { materializedLeaves } : {}) };
    const running = coordinator.run(run);
    const until = (event: Promise<void>) => Promise.race([event, running.then(() => {
      throw new Error('Workflow settled before the restart handshake');
    })]);
    try {
      await until(lookupEntered);
      // Every unblocked boundary above resolves synchronously. One event-loop
      // turn drains that work without a timing budget or a negative waitFor.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const duringLookup = [...events];
      releaseLookup();
      await until(recoveredObserved);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const duringNative = [...events];
      releaseNative();
      await expect(running).resolves.toMatchObject({ state: 'succeeded' });
      expect(duringLookup).toEqual([]);
      expect(duringNative).toEqual(['observe:owned']);
      expect(events).toEqual(['observe:owned', 'settle:owned', 'prepare:new', 'admit:new']);
      await expect(store.resolveSharedInvocation({ kind: 'shared', scopeOwnerKey: rootId, targetClass: 'detached_run' }))
        .resolves.toMatchObject({ recordId: defaultTarget === 'session' ? producerId : recoveredId, execution });
    } finally {
      releaseLookup();
      releaseNative();
      await running;
    }
  });

  it('loads one exact greatest-attempt parent slot without paging preceding siblings again', async () => {
    const rootId = 'root-current-slot';
    const currentId = 'attempt-current-slot';
    const rootIndex = {
      id: rootId, runId, sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0',
      contentRevision: '0', lifecycle: 'running' as const, createdAt: now, updatedAt: now,
    };
    const currentIndex = {
      id: currentId, runId, sequence: '501', parentRecordId: rootId, memberOrdinal: '499', attempt: '3',
      contentRevision: '0', lifecycle: 'running' as const, createdAt: now, updatedAt: now,
    };
    const decoyIndex = { ...currentIndex, id: 'other-slot-attempt', memberOrdinal: '500', attempt: '4' };
    const sealProgress = (
      index: typeof rootIndex | typeof currentIndex,
      blockId: '$root' | 'work',
    ) => serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain',
      binding: {
        v: 1, purpose: 'invocation_progress', accountId, runId,
        recordId: index.id, sequence: index.sequence, parentRecordId: index.parentRecordId,
        memberOrdinal: index.memberOrdinal, attempt: index.attempt,
      },
      progress: {
        kind: 'happier.workflow-progress.v1', invocationPath: { blockId, scope: index.id === currentId
          ? [{ kind: 'branch', blockId: 'parallel-owner', branchId: 'selected-branch' }] : [] },
        blockKind: blockId === '$root' ? 'root' : 'step', attempt: index.attempt,
        logicalInvocationRecordId: blockId === '$root' ? rootId : 'attempt-original-slot',
        ...(blockId === '$root' ? {} : { previousAttemptRecordId: 'attempt-previous-slot' }),
      },
    }));
    const execute = vi.fn(async (operation: Readonly<Record<string, unknown>>) => {
      if (operation.operation === 'invocations.get') {
        if (operation.invocationId === decoyIndex.id) {
          return { invocation: { index: decoyIndex, contentEnvelope: sealProgress(decoyIndex, 'work') } };
        }
        return { invocation: { index: rootIndex, contentEnvelope: sealProgress(rootIndex, '$root') } };
      }
      if (operation.operation === 'invocations.current') {
        return { invocation: { index: currentIndex, contentEnvelope: sealProgress(currentIndex, 'work') } };
      }
      throw new Error(`unexpected:${String(operation.operation)}`);
    });
    const store = await DurableWorkflowCoordinatorStore.load({
      accountId, runId, parentAttempt: 0, storage: { execute },
      encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } },
      rootRecordId: rootId,
      checkpoint: { kind: 'happier.workflow-checkpoint.v1', rootRecordId: rootId, nextSequence: '502', frontier: { nextBlockOrdinal: 0, paused: false } },
      revision: 3,
    });

    const lookup = { runId, blockId: 'work', scope: [], parentKey: workflowInvocationKey({ runId, blockId: '$root', scope: [], attempt: 0 }), memberOrdinal: '499' };
    await store.readByLogicalInvocation(decoyIndex.id);
    await expect(store.readCurrent(lookup)).resolves.toMatchObject({ recordId: currentId, attempt: 3 });
    await expect(store.readCurrent(lookup)).resolves.toMatchObject({ recordId: currentId, attempt: 3 });
    expect(execute.mock.calls.filter(([operation]) => operation.operation === 'invocations.current')).toHaveLength(1);
    expect(execute.mock.calls.some(([operation]) => operation.operation === 'invocations.list')).toBe(false);
  });

  it('reloads an unaffected completed child through successive recovered structural parents after restart', async () => {
    const rootId = 'root-structural-recovery';
    const oldParentId = 'parallel-old';
    const middleParentId = 'parallel-middle';
    const newParentId = 'parallel-new';
    const childId = 'successful-child';
    const makeIndex = (id: string, sequence: string, parentRecordId: string | null, memberOrdinal: string, attempt: string, lifecycle: 'running' | 'pending' | 'completed' | 'superseded') => ({
      id, runId, sequence, parentRecordId, memberOrdinal, attempt, contentRevision: '0', lifecycle, createdAt: now, updatedAt: now,
    });
    const rootIndex = makeIndex(rootId, '0', null, '0', '0', 'running');
    const oldParentIndex = makeIndex(oldParentId, '1', rootId, '0', '0', 'superseded');
    const middleParentIndex = makeIndex(middleParentId, '2', rootId, '0', '1', 'superseded');
    const newParentIndex = makeIndex(newParentId, '3', rootId, '0', '2', 'pending');
    const childIndex = makeIndex(childId, '4', oldParentId, '0', '0', 'completed');
    const progress = (index: ReturnType<typeof makeIndex>, blockId: string, blockKind: 'root' | 'parallel' | 'step', previousAttemptRecordId?: string) =>
      serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
        mode: 'plain', binding: {
          v: 1, purpose: 'invocation_progress', accountId, runId, recordId: index.id,
          sequence: index.sequence, parentRecordId: index.parentRecordId,
          memberOrdinal: index.memberOrdinal, attempt: index.attempt,
        },
        progress: {
          kind: 'happier.workflow-progress.v1', invocationPath: { blockId, scope: [] }, blockKind,
          attempt: index.attempt, logicalInvocationRecordId: blockId === 'parallel-1' ? oldParentId : index.id,
          ...(previousAttemptRecordId ? { previousAttemptRecordId } : {}),
          ...(blockKind === 'parallel' ? { container: { kind: 'parallel' as const, nextBranchOrdinal: '0' } } : {}),
          ...(blockKind === 'step' ? { result: 'kept' } : {}),
        },
      }));
    const details = new Map([
      [rootId, { index: rootIndex, contentEnvelope: progress(rootIndex, '$root', 'root') }],
      [oldParentId, { index: oldParentIndex, contentEnvelope: progress(oldParentIndex, 'parallel-1', 'parallel') }],
      [middleParentId, { index: middleParentIndex, contentEnvelope: progress(middleParentIndex, 'parallel-1', 'parallel', oldParentId) }],
      [newParentId, { index: newParentIndex, contentEnvelope: progress(newParentIndex, 'parallel-1', 'parallel', middleParentId) }],
    ]);
    const execute = vi.fn(async (operation: Readonly<Record<string, unknown>>) => {
      if (operation.operation === 'invocations.get') return { invocation: details.get(String(operation.invocationId)) };
      if (operation.operation === 'invocations.current') {
        if (operation.parentRecordId === newParentId || operation.parentRecordId === middleParentId) return { invocation: null };
        if (operation.parentRecordId === oldParentId) return { invocation: { index: childIndex, contentEnvelope: progress(childIndex, 'successful-step', 'step') } };
      }
      throw new Error(`unexpected:${String(operation.operation)}`);
    });
    const store = await DurableWorkflowCoordinatorStore.load({
      accountId, runId, parentAttempt: 0, storage: { execute },
      encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } },
      rootRecordId: rootId,
      checkpoint: { kind: 'happier.workflow-checkpoint.v1', rootRecordId: rootId, nextSequence: '5', frontier: { nextBlockOrdinal: 0, paused: false } },
      revision: 2,
    });
    await store.readByLogicalInvocation(newParentId);
    await expect(store.readCurrent({
      runId, blockId: 'successful-step', scope: [],
      parentKey: workflowInvocationKey({ runId, blockId: 'parallel-1', scope: [], attempt: 2 }),
      memberOrdinal: '0',
    })).resolves.toMatchObject({ recordId: childId, lifecycle: 'completed', result: 'kept' });
    expect(execute.mock.calls.filter(([operation]) => operation.operation === 'invocations.current')
      .map(([operation]) => operation.parentRecordId)).toEqual([newParentId, middleParentId, oldParentId]);
  });

  it('reads user cancellation only from the root control fact, not a descendant fail-stop request', async () => {
    const rootId = 'root-control';
    const rootIndex = {
      id: rootId, runId, sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0',
      contentRevision: '0', lifecycle: 'running' as const, createdAt: now, updatedAt: now,
    };
    const rootEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain',
      binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: rootId,
        sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' },
      progress: { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: '$root', scope: [] },
        blockKind: 'root', attempt: '0', logicalInvocationRecordId: rootId },
    }));
    const execute = vi.fn(async (operation: Readonly<Record<string, unknown>>) => {
      if (operation.operation === 'invocations.get') {
        return { invocation: { index: rootIndex, contentEnvelope: rootEnvelope } };
      }
      if (operation.operation === 'get') return {
        run: { sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null, id: runId, origin: { kind: 'direct' }, state: 'running', revision: 3, machineId: 'machine-1',
          workflowCustodyState: 'pending', originDeliveryAckRevision: null, availability,
          createdAt: now, updatedAt: now },
        acceptedEnvelope: '{}', checkpointEnvelope: null, resultEnvelope: null,
        keyCensus: createPlainWorkflowRunKeyCensusFixture({ runId, accountId }),
      };
      if (operation.operation === 'invocations.list') return {
        invocations: [{ ...rootIndex, id: 'descendant-stop', parentRecordId: rootId, lifecycle: 'cancel_requested' }],
      };
      throw new Error(`unexpected:${String(operation.operation)}`);
    });
    const store = await DurableWorkflowCoordinatorStore.load({
      accountId, runId, parentAttempt: 0, storage: { execute },
      encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } },
      rootRecordId: rootId,
      checkpoint: { kind: 'happier.workflow-checkpoint.v1', rootRecordId: rootId, nextSequence: '2', frontier: { nextBlockOrdinal: 0, paused: false } },
      revision: 3,
    });

    await expect(store.readControl()).resolves.toBe('running');
    expect(execute.mock.calls.some(([operation]) => operation.operation === 'invocations.list')).toBe(false);
  });

  it('reloads the exact previous attempt for same-conversation retry preparation after restart', async () => {
    const rootId = 'root-retry';
    const previousId = 'attempt-0';
    const retryId = 'attempt-1';
    const workspace = { machineId, directory: '/repo/retry', checkoutRootPath: '/repo/retry' };
    const execution = { kind: 'session' as const, sessionId: 'session-previous', localInputId: 'input-previous' };
    const rootIndex = {
      id: rootId, runId, sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0',
      contentRevision: '0', lifecycle: 'running' as const, createdAt: now, updatedAt: now,
    };
    const previousIndex = {
      id: previousId, runId, sequence: '1', parentRecordId: rootId, memberOrdinal: '0', attempt: '0',
      // Retry storage atomically supersedes the failed row when creating its replacement.
      contentRevision: '1', lifecycle: 'superseded' as const, createdAt: now, updatedAt: now,
    };
    let retryIndex = {
      id: retryId, runId, sequence: '2', parentRecordId: rootId, memberOrdinal: '0', attempt: '1',
      contentRevision: '0', lifecycle: 'admitting' as const, createdAt: now, updatedAt: now,
    };
    const sealProgress = (
      index: typeof rootIndex | typeof previousIndex | typeof retryIndex,
      progress: import('@happier-dev/protocol').WorkflowProgressEnvelopeV1,
    ) => serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain',
      binding: {
        v: 1, purpose: 'invocation_progress', accountId, runId,
        recordId: index.id, sequence: index.sequence, parentRecordId: index.parentRecordId,
        memberOrdinal: index.memberOrdinal, attempt: index.attempt,
      },
      progress,
    }));
    const rows = new Map([
      [rootId, { index: rootIndex, contentEnvelope: sealProgress(rootIndex, {
        kind: 'happier.workflow-progress.v1', invocationPath: { blockId: '$root', scope: [] },
        blockKind: 'root', attempt: '0', logicalInvocationRecordId: rootId,
      }) }],
      [previousId, { index: previousIndex, contentEnvelope: sealProgress(previousIndex, {
        kind: 'happier.workflow-progress.v1', invocationPath: { blockId: 'work', scope: [] },
        blockKind: 'step', attempt: '0', logicalInvocationRecordId: previousId,
        execution, workspace: { descriptor: workspace },
        usage: { inputTokens: 120, outputTokens: 30, costUsd: 0.04 },
      }) }],
      [retryId, { index: retryIndex, contentEnvelope: sealProgress(retryIndex, {
        kind: 'happier.workflow-progress.v1', invocationPath: { blockId: 'work', scope: [] },
        blockKind: 'step', attempt: '1', logicalInvocationRecordId: previousId,
        previousAttemptRecordId: previousId,
        recovery: { conversation: 'same_conversation', input: { kind: 'original' } },
      }) }],
    ]);
    const execute = vi.fn(async (operation: Readonly<Record<string, unknown>>) => {
      if (operation.operation === 'invocations.list') {
        // The parent-slot projection intentionally contains only the newest attempt.
        return { invocations: [retryIndex], parentRevision: 3 };
      }
      if (operation.operation === 'invocations.current') {
        return { invocation: rows.get(retryId), parentRevision: 3 };
      }
      if (operation.operation === 'invocations.get') {
        const row = rows.get(operation.invocationId as string);
        if (!row) throw new Error('unexpected_invocation');
        return { invocation: row, parentRevision: 3 };
      }
      if (operation.operation === 'invocations.fact') {
        const row = rows.get(retryId)!;
        retryIndex = { ...retryIndex, lifecycle: operation.lifecycle as typeof retryIndex.lifecycle };
        row.index = retryIndex;
        row.contentEnvelope = operation.contentEnvelope as string;
        return { ...retryIndex, parentRevision: 3 };
      }
      throw new Error(`unexpected:${String(operation.operation)}`);
    });
    const store = await DurableWorkflowCoordinatorStore.load({
      accountId, runId, parentAttempt: 0, storage: { execute },
      encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } },
      rootRecordId: rootId,
      checkpoint: { kind: 'happier.workflow-checkpoint.v1', rootRecordId: rootId, nextSequence: '3', frontier: { nextBlockOrdinal: 0, paused: false } },
      revision: 3,
    });
    const prepareStep = vi.fn(async () => ({ failure: { kind: 'needs_attention' as const, code: 'stop_after_prepare' } }));
    const executeStep = vi.fn(async () => ({ kind: 'completed' as const, result: 'must-not-replay' }));
    const coordinator = createWorkflowCoordinator({
      store,
      prepareStep,
      executeStep,
      resolveWorkspace: async () => ({ ok: true, workspace }),
      isAcceptedAuthorizationCurrent: async () => true,
    });

    await expect(coordinator.run({
      runId,
      definition: {
        version: 1, inputs: [],
        defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } } },
        blocks: [onlyStep],
      },
      inputs: {}, executionTarget: { kind: 'session' },
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
    })).resolves.toEqual({ state: 'interrupted', reason: 'stop_after_prepare' });
    expect(prepareStep).toHaveBeenCalledWith(expect.objectContaining({
      invocationRecordId: retryId,
      recoveryPreviousExecution: execution,
      recoveryPreviousWorkspace: workspace,
    }));
    expect(executeStep).not.toHaveBeenCalled();
    expect(execute.mock.calls
      .map(([operation]) => operation)
      .filter((operation) => operation.operation === 'invocations.get')
      .map((operation) => operation.invocationId)).toEqual([rootId, previousId]);
    expect(execute.mock.calls.filter(([operation]) => operation.operation === 'invocations.current')).toHaveLength(1);
    await expect(store.readByLogicalInvocation(previousId)).resolves.toMatchObject({
      usage: { inputTokens: 120, outputTokens: 30, costUsd: 0.04 },
    });
  });

  it('keeps exact prior-attempt Account and row binding validation on cache-miss reload', async () => {
    const rootId = 'root-binding';
    const previousId = 'attempt-binding';
    const rootIndex = {
      id: rootId, runId, sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0',
      contentRevision: '0', lifecycle: 'running' as const, createdAt: now, updatedAt: now,
    };
    const previousIndex = {
      id: previousId, runId, sequence: '1', parentRecordId: rootId, memberOrdinal: '0', attempt: '0',
      contentRevision: '0', lifecycle: 'failed' as const, createdAt: now, updatedAt: now,
    };
    const rootEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain',
      binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: rootId,
        sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' },
      progress: { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: '$root', scope: [] },
        blockKind: 'root', attempt: '0', logicalInvocationRecordId: rootId },
    }));
    const wronglyBoundPreviousEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain',
      binding: { v: 1, purpose: 'invocation_progress', accountId: 'account-other', runId,
        recordId: previousId, sequence: '1', parentRecordId: rootId, memberOrdinal: '0', attempt: '0' },
      progress: { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: 'work', scope: [] },
        blockKind: 'step', attempt: '0', logicalInvocationRecordId: previousId },
    }));
    const execute = vi.fn(async (operation: Readonly<Record<string, unknown>>) => {
      if (operation.operation !== 'invocations.get') throw new Error(`unexpected:${String(operation.operation)}`);
      return operation.invocationId === rootId
        ? { invocation: { index: rootIndex, contentEnvelope: rootEnvelope }, parentRevision: 0 }
        : { invocation: { index: previousIndex, contentEnvelope: wronglyBoundPreviousEnvelope }, parentRevision: 0 };
    });
    const store = await DurableWorkflowCoordinatorStore.load({
      accountId, runId, parentAttempt: 0, storage: { execute },
      encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } },
      rootRecordId: rootId,
      checkpoint: { kind: 'happier.workflow-checkpoint.v1', rootRecordId: rootId, nextSequence: '2', frontier: { nextBlockOrdinal: 0, paused: false } },
      revision: 0,
    });

    await expect(store.readByLogicalInvocation(previousId)).rejects.toThrow('workflow_invocation_content_unavailable');
  });

  it('persists an exact invocation permission request without replacing its result', async () => {
    const rootId = 'root-interaction';
    const rootIndex = {
      id: rootId, runId, sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0',
      contentRevision: '0', lifecycle: 'running' as const, createdAt: now, updatedAt: now,
    };
    const binding = {
      v: 1 as const, purpose: 'invocation_progress' as const, accountId, runId,
      recordId: rootId, sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0',
    };
    let persistedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain', binding, progress: {
        kind: 'happier.workflow-progress.v1', invocationPath: { blockId: '$root', scope: [] },
        blockKind: 'root', attempt: '0', logicalInvocationRecordId: rootId, result: { changed: true },
      },
    }));
    const execute = vi.fn(async (operation: Readonly<Record<string, unknown>>) => {
      if (operation.operation === 'invocations.get') {
        return { invocation: { index: rootIndex, contentEnvelope: persistedEnvelope }, parentRevision: 0 };
      }
      if (operation.operation === 'invocations.fact') {
        persistedEnvelope = operation.contentEnvelope as string;
        return { ...rootIndex, lifecycle: operation.lifecycle, parentRevision: 1 };
      }
      throw new Error(`unexpected:${String(operation.operation)}`);
    });
    const store = await DurableWorkflowCoordinatorStore.load({
      accountId, runId, parentAttempt: 0, storage: { execute },
      encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } },
      rootRecordId: rootId,
      checkpoint: { kind: 'happier.workflow-checkpoint.v1', rootRecordId: rootId, nextSequence: '1', frontier: { nextBlockOrdinal: 0, paused: false } },
      revision: 0,
    });
    const rootKey = workflowInvocationKey({ runId, blockId: '$root', scope: [], attempt: 0 });
    const requestStore = new AgentStateRequestStore({
      target: store.createInteractionPersistenceTarget(rootKey),
      logPrefix: '[WORKFLOW TEST]',
    });

    await requestStore.publishRequestAndWait({
      requestId: 'permission-1', toolName: 'Write', toolInput: { path: '/repo/file.txt' }, createdAt: 1,
    });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'invocations.fact',
      lifecycle: 'waiting_for_approval',
    }));

    const opened = openWorkflowProgressStoredEnvelopeV1({
      mode: 'plain', binding, envelope: parseWorkflowStoredContentEnvelopeV1(persistedEnvelope),
    });
    expect(opened).toMatchObject({
      kind: 'available',
      content: {
        result: { changed: true },
        interaction: { requests: { 'permission-1': { tool: 'Write', arguments: { path: '/repo/file.txt' } } } },
      },
    });

    await expect(requestStore.publishRequestAndWait({
      requestId: 'permission-too-large',
      toolName: 'Write',
      toolInput: { content: 'x'.repeat(512 * 1024) },
      createdAt: 2,
    })).rejects.toMatchObject({
      code: 'workflow_interaction_capacity_exceeded',
      recoverable: true,
    });
    const afterOverflow = openWorkflowProgressStoredEnvelopeV1({
      mode: 'plain', binding, envelope: parseWorkflowStoredContentEnvelopeV1(persistedEnvelope),
    });
    expect(afterOverflow).toMatchObject({
      kind: 'available',
      content: {
        result: { changed: true },
        interaction: { requests: { 'permission-1': expect.any(Object) } },
      },
    });
    if (afterOverflow.kind === 'available') {
      expect(afterOverflow.content.interaction).not.toHaveProperty('requests.permission-too-large');
    }

    await expect(requestStore.completeRequest({
      requestId: 'permission-1',
      status: 'approved',
      decision: 'approved',
    })).resolves.toBe(true);
    expect(execute).toHaveBeenLastCalledWith(expect.objectContaining({
      operation: 'invocations.fact',
      lifecycle: 'running',
    }));

    await store.commitFact({ key: rootKey, lifecycle: 'completed' });
    await requestStore.publishRequestAndWait({
      requestId: 'permission-late', toolName: 'Write', toolInput: { path: '/repo/late.txt' }, createdAt: 3,
    });
    expect(execute).toHaveBeenLastCalledWith(expect.objectContaining({
      operation: 'invocations.fact',
      lifecycle: 'completed',
    }));
  });

  it('serializes facts for one invocation row so concurrent workspace commits cannot erase each other', async () => {
    const rootId = 'root-1';
    const rootIndex = {
      id: rootId,
      runId,
      sequence: '0',
      parentRecordId: null,
      memberOrdinal: '0',
      attempt: '0',
      contentRevision: '0', lifecycle: 'running' as const,
      createdAt: now,
      updatedAt: now,
    };
    const rootProgress = {
      kind: 'happier.workflow-progress.v1' as const,
      invocationPath: { blockId: '$root', scope: [] },
      blockKind: 'root' as const,
      attempt: '0',
      logicalInvocationRecordId: rootId,
    };
    const rootEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain',
      binding: {
        v: 1,
        purpose: 'invocation_progress',
        accountId,
        runId,
        recordId: rootId,
        sequence: '0',
        parentRecordId: null,
        memberOrdinal: '0',
        attempt: '0',
      },
      progress: rootProgress,
    }));
    let persistedEnvelope = rootEnvelope;
    let releaseFirst!: () => void;
    const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let factCalls = 0;
    const execute = vi.fn(async (operation: Readonly<Record<string, unknown>>) => {
      if (operation.operation === 'invocations.get') {
        return { invocation: { index: rootIndex, contentEnvelope: persistedEnvelope }, parentRevision: 0 };
      }
      if (operation.operation === 'invocations.fact') {
        factCalls += 1;
        if (factCalls === 1) await firstRelease;
        persistedEnvelope = operation.contentEnvelope as string;
        return { ...rootIndex, parentRevision: 0 };
      }
      throw new Error(`unexpected:${String(operation.operation)}`);
    });
    const store = await DurableWorkflowCoordinatorStore.load({
      accountId,
      runId,
      parentAttempt: 0,
      storage: { execute },
      encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } },
      rootRecordId: rootId,
      checkpoint: {
        kind: 'happier.workflow-checkpoint.v1',
        rootRecordId: rootId,
        nextSequence: '1',
        frontier: { nextBlockOrdinal: 0, paused: false },
      },
      revision: 0,
    });
    const rootKey = workflowInvocationKey({ runId, blockId: '$root', scope: [], attempt: 0 });
    const creationIntent = {
      kind: 'git_worktree' as const,
      sourceDirectory: '/repo',
      baseRef: 'a'.repeat(40),
      displayName: 'workflow-root',
      branchMode: 'new' as const,
    };
    const descriptor = { machineId, directory: '/worktree', checkoutRootPath: '/worktree' };

    const first = store.commitFact({ key: rootKey, lifecycle: 'running', workspace: { creationIntent },
      resultProvenance: { report: { notificationCondition: 'suppressed' } } });
    await Promise.resolve();
    const second = store.commitFact({ key: rootKey, lifecycle: 'running', workspace: { descriptor },
      resultProvenance: { report: { notificationCondition: 'matched' }, other: { notificationCondition: 'suppressed' } } });
    await Promise.resolve();
    releaseFirst();
    await Promise.all([first, second]);
    expect(await store.read(rootKey)).toMatchObject({ resultProvenance: {
      report: { notificationCondition: 'matched' }, other: { notificationCondition: 'suppressed' },
    } });

    const opened = openWorkflowProgressStoredEnvelopeV1({
      mode: 'plain',
      binding: {
        v: 1,
        purpose: 'invocation_progress',
        accountId,
        runId,
        recordId: rootId,
        sequence: '0',
        parentRecordId: null,
        memberOrdinal: '0',
        attempt: '0',
      },
      envelope: parseWorkflowStoredContentEnvelopeV1(persistedEnvelope),
    });
    expect(opened).toMatchObject({
      kind: 'available',
      content: { workspace: { creationIntent, descriptor } },
    });
  });

  it('derives Automation host authority only from the normalized frozen program', () => {
    // The definition itself is valid, so the rejection isolates the caller
    // supplied `authorization` rather than an empty block list.
    const stored = {
      inlineDefinition: { version: 1, inputs: [], defaults: {}, blocks: [onlyStep] },
      workspace: { directory: '/repo' },
      executionTarget: { kind: 'session' },
    };
    expect(AutomationStoredWorkflowDefinitionV2Schema.safeParse(stored).success).toBe(true);
    expect(AutomationStoredWorkflowDefinitionV2Schema.safeParse({
      ...stored,
      authorization: { admittedPermissionCeiling: 'yolo', principal: { kind: 'host' } },
    }).success).toBe(false);
  });

  it('keeps the structural root running when the parent is recoverably interrupted', () => {
    expect(projectWorkflowRootSettlementLifecycle('interrupted', 'running')).toBe('running');
    expect(projectWorkflowRootSettlementLifecycle('failed', 'running')).toBe('failed');
  });


  it('requests same-transition custody settlement for every terminal result', () => {
    expect(projectWorkflowTerminalCustodySettlement('succeeded')).toBe('settled');
    expect(projectWorkflowTerminalCustodySettlement('failed')).toBe('settled');
    expect(projectWorkflowTerminalCustodySettlement('cancelled')).toBe('settled');
    expect(projectWorkflowTerminalCustodySettlement('outcome_uncertain')).toBe('settled');
    expect(projectWorkflowTerminalCustodySettlement('interrupted')).toBeUndefined();
    expect(projectWorkflowTerminalCustodySettlement('paused')).toBeUndefined();
  });

  it('rejects a Run admitted for another Machine before initializing workflow progress', async () => {
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain',
      binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId },
      acceptedSnapshot: {
        startedBy: 'trigger',
        definition: { version: 1, inputs: [], defaults: {}, blocks: [onlyStep] },
        authoredDefinition: { version: 1, inputs: [], defaults: {}, blocks: [onlyStep] },
        workDepth: 0, metadata: null, materializedLeaves: [], frozenChildren: {},
        inputs: {},
        machineId: 'machine-other',
        executionTarget: { kind: 'session' },
        workspaceTarget: { project: { machineId: 'machine-other', directory: '/repo', checkoutRootPath: '/repo' } },
        authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
        source: { kind: 'automation', automationId: 'automation-1' },
      },
    }));
    const execute = vi.fn(async (operation: Readonly<Record<string, unknown>>) => {
      if (operation.operation !== 'get') throw new Error(`unexpected:${String(operation.operation)}`);
      return {
        run: { sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null,
          id: runId, origin: { kind: 'automation', automationId: 'automation-1' }, state: 'queued', revision: 0,
          machineId: 'machine-other', workflowCustodyState: 'pending', originDeliveryAckRevision: null,
          availability, createdAt: now, updatedAt: now,
        },
        acceptedEnvelope,
        checkpointEnvelope: null,
        resultEnvelope: null,
        keyCensus: createPlainWorkflowRunKeyCensusFixture({ runId, accountId }),
      };
    });
    const coordinate = createProductionWorkflowRunCoordinator({
      resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
      token: 'token', accountId, machineId,
      resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      isAcceptedAuthorizationCurrent: async () => true,
      execution: productionExecution(),
      onCommittedTransition: vi.fn(),
      storage: { observeChanges: quietStorageChanges, execute },
    });
    await expect(coordinate({ runId, attempt: 0, expectedRevision: 0,
      accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, acceptedEnvelope,
      automationEvidenceEnvelope: null })).resolves.toEqual({ state: 'failed', reason: 'workspace_conflict' });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('resolves an Automation workspace reference from current settings at claim admission', async () => {
    const oldRef: import('@happier-dev/protocol').WorkspaceRefV1 = {
      id: 'workspace-1', serverId: 'server-1', machineId,
      rootPath: '/old-root', createdAtMs: 1,
    };
    const currentRef: import('@happier-dev/protocol').WorkspaceRefV1 = {
      id: 'workspace-1', serverId: 'server-1', machineId,
      rootPath: '/current-root', createdAtMs: 2,
    };
    let currentWorkspaceRefs: readonly import('@happier-dev/protocol').WorkspaceRefV1[] = [oldRef];
    let resolvedRef: import('@happier-dev/protocol').WorkspaceRefV1 | null = null;
    const coordinate = createProductionWorkflowRunCoordinator({
      resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
      token: 'token', accountId, machineId,
      resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      isAcceptedAuthorizationCurrent: async () => true,
      execution: productionExecution(),
      resolveCurrentWorkspaceRefs: async () => currentWorkspaceRefs,
      prepareAcceptedWorkspaceTarget: async ({ projectTarget, resolveWorkspaceRef }) => {
        expect(projectTarget).toEqual({ machineId, directory: '/old-root', workspaceRefId: 'workspace-1' });
        resolvedRef = resolveWorkspaceRef?.('workspace-1') ?? null;
        return { ok: false as const, code: 'workspace_unavailable' as const };
      },
      onCommittedTransition: vi.fn(),
      storage: { observeChanges: quietStorageChanges, execute: vi.fn() },
    });
    currentWorkspaceRefs = [currentRef];

    await expect(coordinate({
      runId,
      attempt: 0,
      expectedRevision: 0,
      accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null },
      automationId: 'automation-1',
      automationCause: { kind: 'manual', invokedAt: 1 },
      causeWorkDepth: 0,
      definitionEnvelope: JSON.stringify({
        t: 'plain',
        v: {
          inlineDefinition: { version: 1, inputs: [], defaults: {}, blocks: [onlyStep] },
          workspace: { directory: '/old-root', workspaceRefId: 'workspace-1' },
          executionTarget: { kind: 'session' },
        },
      }),
      automationEvidenceEnvelope: null,
    })).resolves.toEqual({ state: 'failed', reason: 'workspace_unavailable', admission: 'refused' });
    expect(resolvedRef).toEqual(currentRef);

    currentWorkspaceRefs = [];
    resolvedRef = oldRef;
    await expect(coordinate({
      runId: '1d4dd16c-d69b-4115-a3b0-e3c92f47f3bd',
      attempt: 0,
      expectedRevision: 0,
      accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null },
      automationId: 'automation-1',
      automationCause: { kind: 'manual', invokedAt: 2 },
      causeWorkDepth: 0,
      definitionEnvelope: JSON.stringify({
        t: 'plain',
        v: {
          inlineDefinition: { version: 1, inputs: [], defaults: {}, blocks: [onlyStep] },
          workspace: { directory: '/old-root', workspaceRefId: 'workspace-1' },
          executionTarget: { kind: 'session' },
        },
      }),
      automationEvidenceEnvelope: null,
    })).resolves.toEqual({ state: 'failed', reason: 'workspace_unavailable', admission: 'refused' });
    expect(resolvedRef).toBeNull();
  });

  it('resolves a missing live Artifact through the Account owner and refuses it before effects', async () => {
    const release = publishServerHttpRuntimeOrigin('https://claim-home.example.test/', 'https');
    const get = vi.spyOn(axios, 'get').mockResolvedValue({ status: 404, data: {} });
    const execute = vi.fn();
    const coordinate = createProductionWorkflowRunCoordinator({
      resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
      token: 'token', accountId, machineId,
      resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      isAcceptedAuthorizationCurrent: async () => true,
      execution: productionExecution(), onCommittedTransition: vi.fn(), storage: { observeChanges: quietStorageChanges, execute },
    });
    try {
      await expect(coordinate({
        runId, attempt: 0, expectedRevision: 0, automationId: 'automation-1',
        accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null },
        workflowDefinitionId: runId, causeWorkDepth: 0,
        automationCause: { kind: 'manual', invokedAt: 1 },
        definitionEnvelope: JSON.stringify({ t: 'plain', v: {
          workspace: { directory: '/repo' }, executionTarget: { kind: 'session' },
        } }),
      })).resolves.toEqual({ state: 'failed', reason: 'source_unavailable', admission: 'refused' });
      expect(get).toHaveBeenCalledWith(`https://claim-home.example.test/v1/artifacts/${runId}`, expect.any(Object));
      expect(execute).not.toHaveBeenCalled();
      get.mockClear();
      const failRun = vi.fn(async () => {});
      await executeClaimedRun({
        machineId, coordinateWorkflowRun: coordinate,
        heartbeatMs: 60_000, leaseDurationMs: 120_000,
        claimClient: { heartbeatRun: vi.fn(async () => {}), failRun },
        resolveAutomationAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
        claimed: { protocol: 'v3', accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null },
          automation: { id: 'automation-1', name: 'missing source', enabled: true, workflowDefinitionId: runId },
          run: { id: runId, automationId: 'automation-1', attempt: 0, revision: 0, recipeKind: 'workflow-v2',
            triggerId: null, cause: { kind: 'manual', invokedAt: 1 }, causeWorkDepth: 0,
            resultDelivery: { kind: 'none' }, executionInputEnvelope: JSON.stringify({ t: 'plain', v: {
              workspace: { directory: '/repo' }, executionTarget: { kind: 'session' },
            } }),
          },
        },
      });
      expect(failRun).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'source_unavailable' }));
      expect(get).toHaveBeenCalledWith(`https://claim-home.example.test/v1/artifacts/${runId}`, expect.any(Object));
    } finally {
      get.mockRestore(); release();
    }
  });

  it('reads a saved trigger source again after an edit through the real definition and Artifact owners', async () => {
    const release = publishServerHttpRuntimeOrigin('https://claim-home.example.test/', 'https');
    let version = 2;
    let prompt = 'Before edit';
    const get = vi.spyOn(axios, 'get').mockImplementation(async () => ({ status: 200, data: {
      id: runId, dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
      ownerAccountId: accountId, access: 'owner', encryptionMode: 'plain',
      headerVersion: version, bodyVersion: version, seq: version, createdAt: 1, updatedAt: version,
      provenance: encodePlainArtifactStoredContent({ v: 1, artifactId: runId, bodyVersion: version,
        provenance: { savedBy: { kind: 'person', accountId } },
      }),
      header: encodePlainArtifactStoredContent({ kind: 'workflow-definition.v1', definitionId: runId,
        revision: { headerVersion: version, bodyVersion: version }, metadata: { title: 'Live source' },
      }),
      body: encodePlainArtifactStoredContent({ body: JSON.stringify({ kind: 'workflow-definition.v1',
        definition: { version: 1, inputs: [], defaults: {
          agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } },
        }, blocks: [{ ...onlyStep, document: { text: prompt, references: [], attachments: [] } }] },
      }) }),
    } }));
    const params = {
      target: { kind: 'workflow' as const, ref: runId }, credentials: { token: 'token', encryption: null },
      encryption: { kind: 'available' as const, witness: { mode: 'plain' as const, version: 1, contentKeyFingerprint: null } },
    };
    try {
      const first = await resolveWorkflowTriggerClaimSource(params);
      expect(first).toMatchObject({ kind: 'saved', revision: { headerVersion: 2, bodyVersion: 2 } });
      version = 3; prompt = 'After edit';
      const next = await resolveWorkflowTriggerClaimSource(params);
      expect(next).toMatchObject({ kind: 'saved', revision: { headerVersion: 3, bodyVersion: 3 }, savedBy: { kind: 'person', accountId },
        definition: { blocks: [{ document: { text: 'After edit' } }] },
      });
      expect(first).toMatchObject({ definition: { blocks: [{ document: { text: 'Before edit' } }] } });
      const captured = new Error('saved_snapshot_captured');
      const accepted: unknown[] = [];
      const coordinate = createProductionWorkflowRunCoordinator({
        resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
        token: 'token', accountId, machineId,
        resolveAccountEncryption: async () => params.encryption,
        isAcceptedAuthorizationCurrent: async () => true,
        execution: productionExecution(), onCommittedTransition: vi.fn(),
        resolveMaterializationHost: productionMaterializationHost,
        prepareAcceptedWorkspaceTarget: async () => ({ ok: true,
          workspaceTarget: { project: { machineId, directory: '/repo', checkoutRootPath: '/repo' } },
        }),
        storage: { observeChanges: quietStorageChanges, execute: async (operation) => {
          if (operation.operation !== 'accepted-snapshot.resolve') throw new Error('unexpected_storage_effect');
          expect(operation.visibleTeamId).toBe('team-chosen');
          const opened = openWorkflowAcceptedSnapshotStoredEnvelopeV1({
            mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId },
            envelope: parseWorkflowStoredContentEnvelopeV1(operation.acceptedEnvelope),
          });
          if (opened.kind !== 'available') throw new Error('snapshot_unavailable');
          accepted.push(opened.content);
          throw captured;
        } },
      });
      const claim = { runId, attempt: 0, expectedRevision: 0, automationId: 'automation-1',
        accountCurrentness: params.encryption.witness, workflowDefinitionId: runId, causeWorkDepth: 3,
        automationCause: { kind: 'manual' as const, invokedAt: 1 },
        definitionEnvelope: JSON.stringify({ t: 'plain', v: {
          visibleTeamId: 'team-chosen',
          workspace: { directory: '/repo' }, executionTarget: { kind: 'session' },
        } }),
      };
      await expect(coordinate(claim)).rejects.toBe(captured);
      expect(accepted[0]).toMatchObject({ source: { kind: 'automation', automationId: 'automation-1',
        definitionId: runId, revision: { headerVersion: 3, bodyVersion: 3 }, savedBy: { kind: 'person', accountId } },
        workDepth: 3, metadata: { title: 'Live source' },
        definition: { blocks: [{ document: { text: 'After edit' } }] },
      });
      version = 4; prompt = 'Next firing';
      await expect(coordinate(claim)).rejects.toBe(captured);
      expect(accepted[1]).toMatchObject({ source: { revision: { headerVersion: 4, bodyVersion: 4 } },
        definition: { blocks: [{ document: { text: 'Next firing' } }] },
      });
      expect(accepted[0]).toMatchObject({ source: { revision: { headerVersion: 3, bodyVersion: 3 } },
        definition: { blocks: [{ document: { text: 'After edit' } }] },
      });
    } finally {
      get.mockRestore(); release();
    }
  });

  it('preserves cancellation from the Artifact boundary instead of classifying it as a missing source', async () => {
    const controller = new AbortController();
    const reason = new Error('claim_cancelled');
    controller.abort(reason);
    const get = vi.spyOn(axios, 'get');
    try {
      await expect(resolveWorkflowTriggerClaimSource({
        target: { kind: 'workflow', ref: runId }, credentials: { token: 'token', encryption: null },
        encryption: { kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } },
        signal: controller.signal,
      })).rejects.toBe(reason);
      expect(get).not.toHaveBeenCalled();
    } finally { get.mockRestore(); }
  });

  it('preserves transient Artifact errors instead of classifying them as missing trigger sources', async () => {
    const failure = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
    const get = vi.spyOn(axios, 'get').mockRejectedValue(failure);
    try {
      await expect(resolveWorkflowTriggerClaimSource({
        target: { kind: 'workflow', ref: runId }, credentials: { token: 'token', encryption: null },
        encryption: { kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } },
      })).rejects.toBe(failure);
    } finally { get.mockRestore(); }
  });

  it('refuses an unavailable claim leaf with its block identity before snapshot effects', async () => {
    const execute = vi.fn();
    const coordinate = createProductionWorkflowRunCoordinator({
      resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
      token: 'token', accountId, machineId,
      resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      isAcceptedAuthorizationCurrent: async () => true,
      execution: productionExecution(), onCommittedTransition: vi.fn(), storage: { observeChanges: quietStorageChanges, execute },
      resolveMaterializationHost: async (input) => ({ ...await productionMaterializationHost(input),
        effects: { resolveTargetAvailability: async () => false },
      }),
      prepareAcceptedWorkspaceTarget: async () => ({ ok: true,
        workspaceTarget: { project: { machineId, directory: '/repo', checkoutRootPath: '/repo' } },
      }),
    });
    await expect(coordinate({ runId, attempt: 0, expectedRevision: 0, automationId: 'automation-1',
      accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null },
      automationCause: { kind: 'manual', invokedAt: 1 }, causeWorkDepth: 0,
      definitionEnvelope: JSON.stringify({ t: 'plain', v: {
        inlineDefinition: { version: 1, inputs: [], defaults: {
          agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } },
        }, blocks: [onlyStep] },
        workspace: { directory: '/repo' }, executionTarget: { kind: 'session' },
      } }),
    })).resolves.toEqual({ state: 'failed', reason: 'target_unavailable', blockId: 'work', admission: 'refused' });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([true, false])('freezes the inline trigger execution target and scoped delivery choice without copied Artifact provenance (delivery: %s)', async (deliver) => {
    const captured = new Error('snapshot_captured');
    const execute = vi.fn(async (operation: Readonly<Record<string, unknown>>) => {
      expect(operation.operation).toBe('accepted-snapshot.resolve');
      const opened = openWorkflowAcceptedSnapshotStoredEnvelopeV1({
        mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId },
        envelope: parseWorkflowStoredContentEnvelopeV1(operation.acceptedEnvelope),
      });
      expect(opened).toMatchObject({ kind: 'available', content: { executionTarget: { kind: 'detached_run' }, machineId } });
      if (opened.kind !== 'available') throw new Error('snapshot_unavailable');
      expect(opened.content.source).toEqual({ kind: 'automation', automationId: 'automation-1' });
      expect(opened.content.origin).toEqual({ kind: 'direct', originSessionId: 'origin-session' });
      expect(opened.content.resultDelivery).toEqual(deliver
        ? { kind: 'originating_session', originSessionId: 'origin-session' } : undefined);
      // Opaque accepted bytes cannot establish the server's origin lookup or ack request.
      expect(operation.originSessionId).toBe('origin-session');
      expect(operation.resultDelivery).toEqual(deliver ? { kind: 'originating_session' } : undefined);
      throw captured;
    });
    const coordinate = createProductionWorkflowRunCoordinator({
      resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
      token: 'token', accountId, machineId,
      resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      isAcceptedAuthorizationCurrent: async () => true,
      execution: productionExecution(), onCommittedTransition: vi.fn(), storage: { observeChanges: quietStorageChanges, execute },
      resolveMaterializationHost: productionMaterializationHost,
      prepareAcceptedWorkspaceTarget: async () => ({ ok: true,
        workspaceTarget: { project: { machineId, directory: '/repo', checkoutRootPath: '/repo' } },
      }),
    });
    await expect(coordinate({ runId, attempt: 0, expectedRevision: 0, automationId: 'automation-1',
      accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, scopeSessionId: 'origin-session',
      automationCause: { kind: 'manual', invokedAt: 1 }, causeWorkDepth: 0,
      definitionEnvelope: JSON.stringify({ t: 'plain', v: {
        inlineDefinition: { version: 1, inputs: [], defaults: {
          agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } },
        }, blocks: [onlyStep] },
        workspace: { directory: '/repo' }, executionTarget: { kind: 'detached_run' },
        ...(deliver ? { onComplete: { kind: 'originating_session' } } : {}),
      } }),
    })).rejects.toBe(captured);
  });

  it('settles invalid trigger constants as a typed pre-start refusal without row or Session effects', async () => {
    const execute = vi.fn();
    const failRun = vi.fn(async () => {});
    const coordinate = createProductionWorkflowRunCoordinator({
      resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
      token: 'token', accountId, machineId,
      resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      isAcceptedAuthorizationCurrent: async () => true,
      execution: productionExecution(), onCommittedTransition: vi.fn(), storage: { observeChanges: quietStorageChanges, execute },
    });
    const definitionEnvelope = JSON.stringify({ t: 'plain', v: {
      inlineDefinition: { version: 1, inputs: [{ name: 'repository', valueType: 'string', required: true }], defaults: {
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } },
      }, blocks: [onlyStep] },
      workspace: { directory: '/repo' }, executionTarget: { kind: 'session' }, inputs: { repository: 123 },
    } });
    await expect(coordinate({ runId, attempt: 0, expectedRevision: 0, automationId: 'automation-1',
      accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null },
      automationCause: { kind: 'manual', invokedAt: 1 }, causeWorkDepth: 0, definitionEnvelope,
    })).resolves.toEqual({ state: 'failed', reason: 'invalid_input', admission: 'refused' });
    await executeClaimedRun({
      machineId, coordinateWorkflowRun: coordinate,
      heartbeatMs: 60_000, leaseDurationMs: 120_000,
      claimClient: { heartbeatRun: vi.fn(async () => {}), failRun },
      resolveAutomationAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      claimed: { protocol: 'v3', accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null },
        automation: { id: 'automation-1', name: 'invalid input', enabled: true },
        run: { id: runId, automationId: 'automation-1', attempt: 0, revision: 0, recipeKind: 'workflow-v2',
          triggerId: null, cause: { kind: 'manual', invokedAt: 1 }, causeWorkDepth: 0,
          resultDelivery: { kind: 'none' }, executionInputEnvelope: definitionEnvelope,
        },
      },
    });
    expect(failRun).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'invalid_input' }));
    expect(execute).not.toHaveBeenCalled();
  });

  it('preserves cancellation while reading current workspace settings before trigger admission', async () => {
    const execute = vi.fn();
    const abort = new AbortController();
    const cancelled = new Error('claim cancelled');
    const coordinate = createProductionWorkflowRunCoordinator({
      resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
      token: 'token', accountId, machineId,
      resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      isAcceptedAuthorizationCurrent: async () => true,
      execution: productionExecution(), onCommittedTransition: vi.fn(), storage: { observeChanges: quietStorageChanges, execute },
      // Account settings are a network boundary, not a second workspace resolver.
      resolveCurrentWorkspaceRefs: async () => { abort.abort(cancelled); throw cancelled; },
    });
    await expect(coordinate({ runId, attempt: 0, expectedRevision: 0, automationId: 'automation-1',
      accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null },
      automationCause: { kind: 'manual', invokedAt: 1 }, causeWorkDepth: 0, signal: abort.signal,
      definitionEnvelope: JSON.stringify({ t: 'plain', v: {
        inlineDefinition: { version: 1, inputs: [], defaults: {
          agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } },
        }, blocks: [onlyStep] },
        workspace: { directory: '/repo', workspaceRefId: 'workspace-ref-1' }, executionTarget: { kind: 'session' },
      } }),
    })).rejects.toBe(cancelled);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    { definition: { version: 1, inputs: [], defaults: {}, blocks: [onlyStep] }, project: { machineId, directory: '/repo' } },
    { workspace: { directory: '/repo' }, executionTarget: { kind: 'session' } },
  ])('refuses an invalid trigger target before workspace or row effects', async (payload) => {
    const execute = vi.fn();
    const coordinate = createProductionWorkflowRunCoordinator({
      resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
      token: 'token', accountId, machineId,
      resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      isAcceptedAuthorizationCurrent: async () => true,
      execution: productionExecution(), onCommittedTransition: vi.fn(), storage: { observeChanges: quietStorageChanges, execute },
    });
    await expect(coordinate({ runId, attempt: 0, expectedRevision: 0, automationId: 'automation-1',
      accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null },
      automationCause: { kind: 'manual', invokedAt: 1 }, causeWorkDepth: 0,
      definitionEnvelope: JSON.stringify({ t: 'plain', v: payload }),
    })).resolves.toEqual({ state: 'failed', reason: 'source_unavailable', admission: 'refused' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses missing occurrence depth before effects', async () => {
    const execute = vi.fn();
    const coordinate = createProductionWorkflowRunCoordinator({
      resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
      token: 'token', accountId, machineId,
      resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      isAcceptedAuthorizationCurrent: async () => true,
      execution: productionExecution(), onCommittedTransition: vi.fn(), storage: { observeChanges: quietStorageChanges, execute },
    });
    await expect(coordinate({ runId, attempt: 0, expectedRevision: 0, automationId: 'automation-1',
      accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null },
      automationCause: { kind: 'manual', invokedAt: 1 }, causeWorkDepth: undefined,
      definitionEnvelope: JSON.stringify({ t: 'plain', v: {
        inlineDefinition: { version: 1, inputs: [], defaults: {}, blocks: [onlyStep] },
        workspace: { directory: '/repo' }, executionTarget: { kind: 'session' },
      } }),
    })).resolves.toEqual({ state: 'failed', reason: 'source_unavailable', admission: 'refused' });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([3, 4])('materializes an inline claim at its frozen firing depth %s before any row effect', async (causeWorkDepth) => {
    const captured = new Error('accepted_snapshot_captured');
    const execute = vi.fn(async (operation: Readonly<Record<string, unknown>>) => {
      expect(operation.operation).toBe('accepted-snapshot.resolve');
      const opened = openWorkflowAcceptedSnapshotStoredEnvelopeV1({
        mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId },
        envelope: parseWorkflowStoredContentEnvelopeV1(operation.acceptedEnvelope),
      });
      expect(opened).toMatchObject({ kind: 'available', content: { workDepth: causeWorkDepth, startedBy: 'user' } });
      throw captured;
    });
    const coordinate = createProductionWorkflowRunCoordinator({
      resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
      token: 'token', accountId, machineId,
      resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      isAcceptedAuthorizationCurrent: async () => true,
      execution: productionExecution(), onCommittedTransition: vi.fn(), storage: { observeChanges: quietStorageChanges, execute },
      prepareAcceptedWorkspaceTarget: async () => ({ ok: true, workspaceTarget: {
        project: { machineId, directory: '/repo', checkoutRootPath: '/repo' },
      } }),
      // Account policy and run-machine catalogs are genuine external boundaries.
      // The actual Protocol policy and materializer remain in the tested path.
      resolveMaterializationHost: async ({ runId: admittedRunId, workDepth, directory }) => ({
        effects: {
          readWorkflowDefinition: async () => null,
          readLaunchProfile: async () => null,
          readActionContract: async () => null,
          resolveTargetAvailability: async () => true,
        },
        admitLeaf: async (leaf) => admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1,
          { kind: 'workflow_run_leaf', leaf }, {
            caller: { kind: 'originless', runId: admittedRunId, runDepth: workDepth },
            baseline: { machineId, directory }, ledSubtreeSessionIds: [], roles: {},
            workDepthLimit: 4, callerPermissionCeiling: 'default',
          }),
      }),
    });
    const claim = { runId, attempt: 0, expectedRevision: 0, automationId: 'automation-1',
      accountCurrentness: { mode: 'plain' as const, version: 1, contentKeyFingerprint: null },
      automationCause: { kind: 'manual' as const, invokedAt: 1 }, causeWorkDepth,
      definitionEnvelope: JSON.stringify({ t: 'plain', v: {
        inlineDefinition: { version: 1, inputs: [], defaults: {
          agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } },
        }, blocks: [onlyStep] },
        workspace: { directory: '/repo' }, executionTarget: { kind: 'session' },
      } }),
    };
    if (causeWorkDepth === 3) await expect(coordinate(claim)).rejects.toBe(captured);
    else {
      await expect(coordinate(claim)).resolves.toEqual({ state: 'failed', reason: 'work_depth_exceeded', admission: 'refused', blockId: 'work' });
      expect(execute).not.toHaveBeenCalled();
    }
  });

  it('freezes an Automation definition and evidence before durable row admission, Session execution, and parent settlement', async () => {
    const definition = {
      version: 1 as const,
      inputs: [
        { name: 'request', valueType: 'string' as const, required: true },
        { name: 'repository', valueType: 'string' as const, required: true },
        { name: 'permissionMode', valueType: 'string' as const, required: false },
        { name: 'authorization', valueType: 'json' as const, required: false },
      ],
      defaults: {
        agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.test', localId: 'test' } },
        conversation: { kind: 'existing_session' as const, sessionId: 'session-1', machineId },
      },
      blocks: [{ kind: 'step' as const, id: 'work', document: { text: 'work', references: [], attachments: [] }, input: [], result: { kind: 'text' as const } }],
      finalOutput: { kind: 'result' as const, producer: { blockId: 'work', scope: { kind: 'current' as const } }, path: [] },
    };
    const definitionEnvelope = JSON.stringify({ t: 'plain', v: {
      inlineDefinition: definition,
      workspace: { directory: '/repo' },
      executionTarget: { kind: 'session' },
      inputs: { repository: '/repo', request: 'constant loses to occurrence' },
    } });
    const automationEvidenceEnvelope = JSON.stringify({
      t: 'plain',
      v: { request: 'ship it', permissionMode: 'yolo', authorization: { admittedPermissionCeiling: 'yolo' } },
    });
    let acceptedEnvelope: string | null = null;
    let revision = 0;
    let checkpointEnvelope: string | null = null;
    let persistedResultEnvelope: string | null = null;
    let durableState = 'queued';
    let durableCustody: 'pending' | 'settled' = 'pending';
    let lostFinalTransitionResponse = false;
    const rows = new Map<string, { index: Record<string, unknown>; contentEnvelope: string }>();
    const summary = (state: string) => ({ sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null, id: runId, origin: { kind: 'automation', automationId: 'automation-1' }, state,
      revision, machineId, workflowCustodyState: durableCustody, originDeliveryAckRevision: null,
      availability, createdAt: now, updatedAt: now });
    const execute = vi.fn(async (operation: Readonly<Record<string, unknown>>) => {
      switch (operation.operation) {
        case 'accepted-snapshot.resolve': {
          expect(operation).toMatchObject({
            automationId: 'automation-1', expectedAttempt: 0, expectedRevision: 0, definitionEnvelope,
          });
          const candidate = operation.acceptedEnvelope;
          expect(typeof candidate).toBe('string');
          const opened = openWorkflowAcceptedSnapshotStoredEnvelopeV1({
            mode: 'plain',
            binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId },
            envelope: parseWorkflowStoredContentEnvelopeV1(candidate),
          });
          expect(opened).toMatchObject({ kind: 'available', content: {
            definition,
            inputs: {
              request: 'ship it',
              repository: '/repo',
              permissionMode: 'yolo',
              authorization: { admittedPermissionCeiling: 'yolo' },
            },
            machineId,
            executionTarget: { kind: 'session' },
            workspaceTarget: { project: { machineId, directory: '/repo', checkoutRootPath: '/repo' } },
            authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
            source: { kind: 'automation', automationId: 'automation-1' },
          } });
          acceptedEnvelope = candidate as string;
          revision = 1;
          return { disposition: 'created', acceptedEnvelope, run: summary('queued') };
        }
        case 'get': return { run: summary(durableState), acceptedEnvelope, checkpointEnvelope, resultEnvelope: persistedResultEnvelope,
          keyCensus: createPlainWorkflowRunKeyCensusFixture({ runId, accountId }) };
        case 'initialize': {
          revision = 1;
          durableState = 'running';
          checkpointEnvelope = operation.checkpointEnvelope as string;
          const root = operation.rootInvocation as { id: string; contentEnvelope: string };
          rows.set(root.id, { index: { id: root.id, runId, sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0', contentRevision: '0', lifecycle: 'pending', createdAt: now, updatedAt: now }, contentEnvelope: root.contentEnvelope });
          return { initialization: 'created', run: summary('running') };
        }
        case 'invocations.list': return { invocations: [...rows.values()].map((row) => row.index).filter((index) => {
          if (operation.parentRecordId !== undefined && index.parentRecordId !== operation.parentRecordId) return false;
          const lifecycles = operation.lifecycles;
          return !Array.isArray(lifecycles) || lifecycles.includes(index.lifecycle);
        }), parentRevision: revision };
        case 'invocations.current': {
          const current = [...rows.values()]
            .filter((row) => row.index.parentRecordId === operation.parentRecordId
              && row.index.memberOrdinal === operation.memberOrdinal)
            .sort((left, right) => Number(right.index.attempt) - Number(left.index.attempt))[0];
          return { invocation: current ?? null, parentRevision: revision };
        }
        case 'invocations.get': return { invocation: { index: rows.get(operation.invocationId as string)!.index,
          contentEnvelope: rows.get(operation.invocationId as string)!.contentEnvelope, parentRevision: revision } };
        case 'invocations.admit': {
          const item = (operation.invocations as Array<Record<string, unknown>>)[0]!;
          expect(item.sequence).toBe('1');
          revision += 1;
          checkpointEnvelope = operation.checkpointEnvelope as string;
          const index = { id: item.id, runId, sequence: item.sequence, parentRecordId: item.parentRecordId,
            memberOrdinal: item.memberOrdinal, attempt: '0', contentRevision: '0', lifecycle: 'pending', createdAt: now, updatedAt: now };
          rows.set(item.id as string, { index, contentEnvelope: item.contentEnvelope as string });
          return { disposition: 'created', parentRevision: revision, invocations: [index] };
        }
        case 'invocations.fact': {
          const row = rows.get(operation.invocationId as string)!;
          expect(operation.expectedContentRevision).toBe(row.index.contentRevision);
          row.index = { ...row.index, lifecycle: operation.lifecycle,
            contentRevision: (BigInt(String(row.index.contentRevision)) + 1n).toString() };
          row.contentEnvelope = operation.contentEnvelope as string;
          return { ...row.index, parentRevision: revision };
        }
        case 'transition': {
          expect(operation.expectedRevision).toBe(revision);
          revision += 1;
          durableState = operation.state as string;
          checkpointEnvelope = operation.checkpointEnvelope as string;
          if (typeof operation.resultEnvelope === 'string') persistedResultEnvelope = operation.resultEnvelope;
          if (operation.custodyState === 'settled') durableCustody = 'settled';
          for (const item of (operation.invocationTransitions ?? []) as Array<Record<string, unknown>>) {
            const row = rows.get(item.id as string)!;
            expect(item.expectedContentRevision).toBe(row.index.contentRevision);
            row.index = { ...row.index, lifecycle: item.lifecycle,
              contentRevision: (BigInt(String(row.index.contentRevision)) + 1n).toString() };
          }
          if (typeof operation.resultEnvelope === 'string' && !lostFinalTransitionResponse) {
            lostFinalTransitionResponse = true;
            throw new Error('simulated_lost_transition_response');
          }
          return summary(durableState);
        }
        default: throw new Error(`unexpected:${String(operation.operation)}`);
      }
    });
    const enqueue = vi.fn(async (input: Readonly<Record<string, unknown>>) => {
      expect(input).toMatchObject({
        sessionId: 'session-1',
        workflow: { purpose: 'invocation', runId, invocationRecordId: expect.any(String) },
      });
      return { status: 'accepted' as const, localId: 'local-1' };
    });
    const observe = vi.fn(async () => ({
      ok: true as const,
      sessionId: 'session-1',
      localId: 'local-1',
      result: { kind: 'final_text' as const, text: 'done' },
    }));
    const onCommittedTransition = vi.fn();
    const coordinate = createProductionWorkflowRunCoordinator({
      resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
      token: 'token', accountId, machineId,
      resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      isAcceptedAuthorizationCurrent: async () => true,
      execution: productionExecution({  enqueue, observe }),
      resolveMaterializationHost: productionMaterializationHost,
      prepareAcceptedWorkspaceTarget: async () => ({
        ok: true,
        workspaceTarget: { project: { machineId, directory: '/repo', checkoutRootPath: '/repo' } },
      }),
      // Recorded-workspace verification reaches the SCM owner through the
      // daemon-applied plugin runtime, which no unit process provides.
      workspaceScm: {
        inspectLocation: async () => null,
        verifyRecordedWorkspace: async () => 'available' as const,
      },
      onCommittedTransition,
      storage: { observeChanges: quietStorageChanges, execute },
    });
    const claimClient = {
      startRun: vi.fn(), heartbeatRun: vi.fn(async () => {}), succeedRun: vi.fn(), failRun: vi.fn(),
    };
    let coordinationFailure: unknown;
    await executeClaimedRun({
      machineId, claimClient,
      heartbeatMs: 60_000, leaseDurationMs: 120_000, coordinateWorkflowRun: async (claim) => {
        try { return await coordinate(claim); } catch (error) { coordinationFailure = error; throw error; }
      },
      claimed: {
        protocol: 'v3', accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null },
        automation: { id: 'automation-1' },
        run: {
          id: runId, automationId: 'automation-1', attempt: 0, revision: 0,
          origin: { kind: 'automation', automationId: 'automation-1' }, recipeKind: 'workflow-v2',
          executionInputEnvelope: definitionEnvelope, automationEvidenceEnvelope,
          causeWorkDepth: 0,
          cause: { kind: 'conversation', occurrenceKey: 'A'.repeat(43), occurredAt: 1 }, triggerId: null,
        },
      } as never,
    });
    if (coordinationFailure) throw coordinationFailure;
    expect(execute.mock.calls[0]?.[0]).toMatchObject({ operation: 'accepted-snapshot.resolve' });
    expect(claimClient.startRun).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledOnce();
    expect(execute.mock.calls.some(([operation]) => operation.operation === 'invocations.admit')).toBe(true);
    expect(execute.mock.calls.some(([operation]) => operation.operation === 'transition')).toBe(true);
    for (const [operation] of execute.mock.calls) {
      if (['accepted-snapshot.resolve', 'initialize', 'invocations.admit', 'invocations.fact', 'transition']
        .includes(String(operation.operation))) {
        expect(operation.accountCurrentness).toEqual({ mode: 'plain', version: 1, contentKeyFingerprint: null });
      }
    }
    const transitions = execute.mock.calls.map(([operation]) => operation).filter((operation) => operation.operation === 'transition');
    expect(transitions.at(-1)).toMatchObject({
      resultEnvelope: expect.any(String),
      invocationTransitions: [expect.objectContaining({ expectedLifecycle: 'running', lifecycle: 'completed' })],
    });
    expect(onCommittedTransition).toHaveBeenCalledOnce();
    expect(lostFinalTransitionResponse).toBe(true);
  });
});
