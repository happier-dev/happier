import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { createSocketTransportAdapter } from '@happier-dev/sync-client';
import * as sessionSockets from '@/api/session/sockets';
import * as sessionRpc from '@/session/transport/rpc/sessionRpc';
import * as machineRpc from '@/session/transport/rpc/machineRpc';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import {
  createAccountScopedCryptoMaterialSnapshotV1,
  createActionExecutor,
  createWorkflowAccountRunActionOwner,
  prepareWorkflowRunDataKeyV1,
  convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1,
  openWorkflowProgressStoredEnvelopeV1,
  parseWorkflowStoredContentEnvelopeV1,
  sealWorkflowAcceptedSnapshotStoredEnvelopeV1,
  sealWorkflowCheckpointStoredEnvelopeV1,
  sealWorkflowProgressStoredEnvelopeV1,
  serializeWorkflowStoredContentEnvelopeV1,
  type JsonValue,
  type WorkflowDefinitionV1,
  type WorkflowProgressEnvelopeV1,
  type WorkflowRunInvocationIndexV1,
  type WorkflowStep,
  type WorkflowMaterializedLeafV1,
  WorkflowRunSummaryV1Schema,
  freezeActionCompletionContractV1,
  getActionSpec,
} from '@happier-dev/protocol';

import { createWorkflowRunRecoveryReader, createWorkflowInvocationRecoveryFactWriter } from './recovery';
import { registerTranscriptSecret } from '@/api/session/client/transport/transcriptSecretRedaction';
import { createWorkflowInvocationRecoveryObserver } from './daemonRuntime';
import { actionSpecToActionDefinitionV1, freezeWorkflowActionContractV1 } from '@happier-dev/protocol/actions/actionCatalog';
import { createPlainWorkflowRunKeyCensusFixture, createWorkflowRunStorageTestkit, type WorkflowRunStorageTestkitOperation } from './workflowRunStorage.testkit';
import type { AvailableAutomationAccountEncryptionV1 } from '@/plugins/runtime/automations/automationAccountCurrentness';
import type { WaitForSessionInputReplyResult } from '@/session/services/sendSessionMessage';
import { deriveWorkflowSessionInputLocalIdV2 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { buildAcpAgentMessageEnvelope } from '@/api/session/acpMessageEnvelope';
import { WORKFLOW_STEP_INPUT_EVENT_MESSAGE } from '@/session/shared/sessionTurnLifecycle';
import { parseStoredSessionTurn } from '../../../../server/sources/app/session/turns/parseSessionTurnState';
import { SessionCreationCorrespondenceV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import { deriveWorkflowSessionCreationTag } from './workflowSessionStartup';
import { WorkflowActionOutputSchemasV1 } from '@happier-dev/protocol/workflows/actionsV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { ActionOperationSnapshotV1Schema } from '@happier-dev/protocol/actions/operations/v1';
import { SessionMessageReplyReadResultV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import { createWorkflowDiscussionResultPublisher } from './workflowDiscussionPublication';
import { logger } from '@/ui/logger';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';

const accountId = 'account-1';
const machineId = 'machine-1';
const runId = '7be4d65c-d3b7-4868-a416-b18d9ee29c1c';
const now = '2026-09-08T12:00:00.000Z';
const availability = { pause: false, resumeBoundary: false,
    restoreWorkspace: false, cancel: false, inspectExecution: true, disabledReasons: [] };

it.each(['deny', 'approve', 'cancel', 'expiry'] as const)(
  'retires cancelled Run approval custody once after a pushed %s receipt', async outcome => {
    const rootId = 'approval-root';
    const childId = 'approval-child';
    const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {},
      blocks: [{ kind: 'action', id: 'leaf', actionId: 'example.workflow/actions/update', input: {} }] };
    const kit = createWorkflowRunStorageTestkit({ accountId, runId, machineId, now, origin: { kind: 'direct' },
      acceptedEnvelope: directAcceptedEnvelope({ definition, materializedLeaves: [{ sourceKey: '$root', blockId: 'leaf',
        kind: 'action', actionId: 'example.workflow/actions/update', actionInput: {}, authoredWorkspace: { kind: 'inherit' },
        selection: {}, executionTarget: { kind: 'session' },
        actionContract: { inputSchema: {}, outputSchema: { type: 'object', properties: { updated: { type: 'boolean' } },
          required: ['updated'], additionalProperties: false } } }] }) });
    const execution = { kind: 'action' as const, actionId: 'example.workflow/actions/update',
      actionRequestId: 'invocation', localInputId: 'input', input: {},
      output: { kind: 'approval_request_created', artifactId: 'receipt', actionId: 'action.invoke' } };
    const seal = (root: boolean) => serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: root ? rootId : childId,
        sequence: root ? '0' : '1', parentRecordId: root ? null : rootId, memberOrdinal: '0', attempt: '0' },
      progress: { kind: 'happier.workflow-progress.v1', blockKind: root ? 'root' : 'action',
        invocationPath: { blockId: root ? '$root' : 'leaf', scope: [] }, attempt: '0',
        logicalInvocationRecordId: root ? rootId : childId, ...(!root ? { execution } : {}) } }));
    await kit.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope: checkpointEnvelope(rootId),
      rootInvocation: { id: rootId, contentEnvelope: seal(true) } });
    await kit.execute({ operation: 'invocations.admit', runId, expectedRevision: kit.run().revision,
      checkpointEnvelope: checkpointEnvelope(rootId), invocations: [{ id: childId, sequence: '1', parentRecordId: rootId,
        memberOrdinal: '0', lifecycle: 'waiting_for_approval', contentEnvelope: seal(false) }] });
    kit.requestControl('cancelled');
    let settled = false;
    let wake: (() => void) | undefined;
    const changed = new Promise<void>(resolve => { wake = resolve; });
    const request = () => ({ v: 1, kind: 'plugin_target_action', status: !settled ? 'open'
      : outcome === 'deny' ? 'rejected' : outcome === 'cancel' ? 'canceled' : outcome === 'approve' ? 'executed' : 'failed',
      createdAtMs: 1, updatedAtMs: settled ? 3 : 1, createdBy: { surface: 'agent' }, requestedSurface: 'agent',
      summary: 'Update', qualifiedActionId: execution.actionId, input: {}, secretInputPaths: [],
      sourceCustody: { kind: 'development', registeredRootId: 'root' }, policyFingerprint: 'a'.repeat(64), subjectFingerprint: 'b'.repeat(64),
      executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent', serverId: 'home',
        serverIdentityId: 'home-identity', accountId, machineId, actionId: 'action.invoke', requestId: 'invocation',
        caller: { kind: 'workflowRun', runId, authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' } } },
      ...(settled && outcome === 'deny' ? { decision: { kind: 'reject', decidedAtMs: 2 } } : {}),
      ...(settled && (outcome === 'approve' || outcome === 'expiry') ? { decision: { kind: 'approve', decidedAtMs: 2 },
        execution: outcome === 'approve' ? { executedAtMs: 3, ok: true, effectAttempted: true, result: { updated: true } }
          : { executedAtMs: 3, ok: false, effectAttempted: false, errorCode: 'approval_stale', error: 'approval_stale' } } : {}) });
    // Replace only persistent Artifact reads and their external change notification.
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), approvalsGet: async () => request() });
    let waits = 0;
    const observer = createWorkflowInvocationRecoveryObserver({ credentials: { token: 'token', encryption: null }, machineId,
      actionExecutor: executor, observeApproval: async () => { waits++; await changed; } });
    const recover = createWorkflowRunRecoveryReader({ accountId, machineId,
      storage: { execute: async (operation, options) => operation.operation === 'recovery.list'
        ? { candidates: kit.run().workflowCustodyState === 'pending' ? [{ run: kit.run(), parentAttempt: 0 }] : [] }
        : await kit.execute(operation, options) },
      resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      reconcileInvocation: observer });
    await recover('reconnect');
    expect(kit.run().workflowCustodyState).toBe('pending');
    expect(waits).toBe(1);
    settled = true;
    wake?.();
    await vi.waitFor(() => expect(kit.run()).toMatchObject({ state: 'cancelled', workflowCustodyState: 'settled' }));
    const revision = kit.run().revision;
    await recover('control', undefined, runId);
    expect(kit.run().revision).toBe(revision);
    expect(waits).toBe(1);
  });

it.each([
  { blockKind: 'action', terminal: true },
  { blockKind: 'step', terminal: true },
  { blockKind: 'action', terminal: false },
] as const)('recovers pre-dispatch custody without replaying an uncertain $blockKind (terminal=$terminal)', async ({ blockKind, terminal }) => {
  const rootId = '33333333-3333-4333-8333-333333333333';
  const childId = '44444444-4444-4444-8444-444444444444';
  const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {}, blocks: blockKind === 'action'
    ? [{ kind: 'action', id: 'leaf', actionId: 'review.start', input: {} }]
    : [{ kind: 'step', id: 'leaf', input: [], document: { text: 'Review', references: [], attachments: [] }, result: { kind: 'text' } }] };
  // Persistence is the boundary: this is the durable row left when the
  // coordinator's pre-effect correspondence CAS fails before storing anything.
  const kit = createWorkflowRunStorageTestkit({ accountId, runId, machineId, now, origin: { kind: 'direct' },
    acceptedEnvelope: directAcceptedEnvelope({ definition }) });
  const seal = (root: boolean) => serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
    binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: root ? rootId : childId,
      sequence: root ? '0' : '1', parentRecordId: root ? null : rootId, memberOrdinal: '0', attempt: '0' },
    progress: { kind: 'happier.workflow-progress.v1', blockKind: root ? 'root' : blockKind,
      invocationPath: { blockId: root ? '$root' : 'leaf', scope: [] }, attempt: '0',
      logicalInvocationRecordId: root ? rootId : childId, reason: { code: 'outcome_uncertain' } } }));
  await kit.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope: checkpointEnvelope(rootId),
    rootInvocation: { id: rootId, contentEnvelope: seal(true) } });
  await kit.execute({ operation: 'invocations.admit', runId, expectedRevision: kit.run().revision, checkpointEnvelope: checkpointEnvelope(rootId),
    invocations: [{ id: childId, sequence: '1', parentRecordId: rootId, memberOrdinal: '0',
      lifecycle: 'outcome_uncertain', contentEnvelope: seal(false) }] });
  const state = terminal ? 'outcome_uncertain' : 'interrupted';
  await kit.execute({ operation: 'transition', runId, expectedRevision: kit.run().revision, state,
    checkpointEnvelope: checkpointEnvelope(rootId), invocationTransitions: [{ id: rootId, expectedLifecycle: 'pending',
      expectedContentRevision: kit.rowById(rootId)!.index.contentRevision, lifecycle: 'outcome_uncertain' }] });
  const childBytes = kit.rowById(childId)!.contentEnvelope;
  const recover = createWorkflowRunRecoveryReader({ accountId, machineId,
    storage: { execute: async (operation, options) => operation.operation === 'recovery.list'
      ? { candidates: kit.run().workflowCustodyState === 'pending' ? [{ run: kit.run(), parentAttempt: 0 }] : [] }
      : await kit.execute(operation, options) },
    resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
    reconcileInvocation: createWorkflowInvocationRecoveryObserver({ credentials: { token: 'token', encryption: null }, machineId,
      actionExecutor: createActionExecutor(createUnavailableActionTransportDeps()) }) });
  await recover('control', undefined, runId);
  expect(kit.run()).toMatchObject({ state, workflowCustodyState: terminal && blockKind === 'action' ? 'settled' : 'pending' });
  expect(kit.rowById(childId)).toMatchObject({ index: { lifecycle: 'outcome_uncertain' }, contentEnvelope: childBytes });
});

it.each(['invitation_stale', 'approval_stale', 'approval_pending', 'unknown_native', 'cancelled_running_frame', 'succeeded_running_frame'] as const)('settles terminal structural custody while preserving leaf publication custody (%s)', async outcome => {
  const publication = outcome === 'approval_stale' || outcome === 'approval_pending';
  const runningFrame = outcome === 'cancelled_running_frame' || outcome === 'succeeded_running_frame';
  const terminalState = outcome === 'cancelled_running_frame' ? 'cancelled' : 'succeeded';
  const rootId = 'structural-root';
  const frameId = 'structural-frame';
  const childId = 'structural-child';
  const origin = { discussion: { serverId: 'home', discussionId: 'discussion' }, messageId: 'question', throughSeq: 1 };
  const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {}, blocks: [{ kind: 'loop', id: 'round',
    repetition: { kind: 'count', count: { kind: 'literal', value: 1 } }, body: [{ kind: 'step', id: 'step', input: [],
      document: { text: WORKFLOW_STEP_INPUT_EVENT_MESSAGE, references: [], attachments: [] }, result: { kind: 'text' } }] }] };
  const kit = createWorkflowRunStorageTestkit({ accountId, runId, machineId, now, origin: { kind: 'direct' },
    acceptedEnvelope: directAcceptedEnvelope({ definition, discussion: origin }) });
  const seal = (id: string, blockKind: 'root' | 'loop' | 'step', sequence: string, parentRecordId: string | null) =>
    serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain', binding: {
      v: 1, purpose: 'invocation_progress', accountId, runId, recordId: id, sequence, parentRecordId, memberOrdinal: '0', attempt: '0',
    }, progress: { kind: 'happier.workflow-progress.v1', blockKind, invocationPath: { blockId: blockKind === 'root' ? '$root' : blockKind === 'loop' ? 'round' : 'step', scope: [] },
      attempt: '0', logicalInvocationRecordId: id,
      ...(blockKind === 'loop' && !runningFrame ? { reason: { code: 'approval_context_unavailable' } } : {}),
      ...(blockKind === 'step' && runningFrame ? { execution: {
        kind: 'session' as const, sessionId: 'archived-session', localInputId: 'retained-input',
      } } : {}),
      ...(blockKind === 'step' && publication ? { result: { finished: true }, execution: {
        kind: 'action' as const, actionId: 'plugin:testdebt.external.finish', actionRequestId: childId, localInputId: childId, input: {},
      } } : {}),
      ...(blockKind === 'step' && !publication && !runningFrame ? { reason: { code: 'approval_required' }, execution: { kind: 'action' as const, actionId: 'discussion.invite',
        actionRequestId: 'invitation', localInputId: 'slot', input: {},
        output: { kind: 'approval_request_created', artifactId: 'invitation-approval', actionId: 'discussion.invite' } } } : {}),
    } }));
  await kit.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope: checkpointEnvelope(rootId),
    rootInvocation: { id: rootId, contentEnvelope: seal(rootId, 'root', '0', null) } });
  await kit.execute({ operation: 'invocations.admit', runId, expectedRevision: kit.run().revision, checkpointEnvelope: checkpointEnvelope(rootId),
    invocations: [{ id: frameId, sequence: '1', parentRecordId: rootId, memberOrdinal: '0', lifecycle: runningFrame ? 'running' : 'needs_attention', contentEnvelope: seal(frameId, 'loop', '1', rootId) },
      { id: childId, sequence: '2', parentRecordId: frameId, memberOrdinal: '0', lifecycle: outcome === 'unknown_native' ? 'running' : publication ? 'completed' : runningFrame ? 'cancelled' : 'failed',
        contentEnvelope: seal(childId, 'step', '2', frameId) }] });
  await kit.execute({ operation: 'transition', runId, expectedRevision: kit.run().revision, state: terminalState,
    checkpointEnvelope: checkpointEnvelope(rootId), invocationTransitions: [{ id: rootId, expectedLifecycle: 'pending',
      expectedContentRevision: kit.rowById(rootId)!.index.contentRevision, lifecycle: terminalState === 'cancelled' ? 'cancelled' : 'completed' }] });
  const leafBytes = kit.rowById(childId)!.contentEnvelope;
  let attempts = 0;
  const failureLog = vi.spyOn(logger, 'warn');
  onTestFinished(() => failureLog.mockRestore());
  const recover = createWorkflowRunRecoveryReader({ accountId, machineId,
    storage: { execute: async (operation, options) => operation.operation === 'recovery.list'
      ? { candidates: kit.run().workflowCustodyState === 'pending' ? [{ run: kit.run(), parentAttempt: 0 }] : [] }
      : await kit.execute(operation, options) },
    resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
    reconcileInvocation: createWorkflowInvocationRecoveryObserver({ credentials: { token: 'token', encryption: null }, machineId,
      actionExecutor: createActionExecutor({ ...createUnavailableActionTransportDeps(), approvalsGet: async () => null }) }),
    onInvocationSettled: async ({ invocation }) => await createWorkflowDiscussionResultPublisher({
      credentials: { token: 'token', encryption: null }, origin, isCurrent: async () => true, publish: async () => {
        attempts++;
        return outcome === 'approval_pending' ? { v: 1, ok: false, error: 'discussions_unavailable', pending: { kind: 'approval', artifactId: 'publication-approval' } }
          : { v: 1, ok: false, error: 'discussions_unavailable',
            failure: { code: 'approval_stale', phase: 'workflow_publication', retryable: false } };
      },
    })({ runId, invocation }) });
  await recover('startup');
  expect(kit.run()).toMatchObject({ state: terminalState, workflowCustodyState: runningFrame || outcome === 'approval_stale' || outcome === 'invitation_stale' ? 'settled' : 'pending' });
  expect(kit.rowById(frameId)?.index.lifecycle).toBe(terminalState === 'cancelled' ? 'cancelled' : 'failed');
  expect(kit.rowById(childId)?.contentEnvelope).toBe(leafBytes);
  if (outcome === 'approval_stale') {
    expect(failureLog).toHaveBeenCalledWith(expect.stringContaining('publication'), expect.objectContaining({ errorCode: 'approval_stale' }));
    for (let hint = 0; hint < 3; hint++) await recover('control', undefined, runId);
    expect(attempts).toBe(1);
  }
  if (!publication) {
    expect(attempts).toBe(0);
    expect(failureLog).not.toHaveBeenCalled();
  }
});

it.each(['none', 'native', 'review'] as const)('settles a retained interrupted publication refusal only after native custody is resolved (active=%s)', async pending => {
  const active = pending !== 'none';
  const rootId = '33333333-3333-4333-8333-333333333333';
  const childId = '44444444-4444-4444-8444-444444444444';
  const activeId = '55555555-5555-4555-8555-555555555555';
  const origin = { discussion: { serverId: 'home', discussionId: 'discussion' }, messageId: 'question', throughSeq: 1 };
  const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {}, blocks: [
    { kind: 'action', id: 'check', actionId: 'review.start', input: {} },
    ...(active ? [{ kind: 'action' as const, id: 'ongoing', actionId: 'review.start', input: {} }] : []),
  ] };
  const kit = createWorkflowRunStorageTestkit({ runId, machineId, now, origin: { kind: 'direct' },
    acceptedEnvelope: directAcceptedEnvelope({ definition, discussion: origin }) });
  const seal = (id: string, root: boolean) => serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
    binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: id, sequence: root ? '0' : id === childId ? '1' : '2',
      parentRecordId: root ? null : rootId, memberOrdinal: id === activeId ? '1' : '0', attempt: '0' },
    progress: { kind: 'happier.workflow-progress.v1', blockKind: root ? 'root' : 'action',
      invocationPath: { blockId: root ? '$root' : id === childId ? 'check' : 'ongoing', scope: [] }, attempt: '0', logicalInvocationRecordId: id,
      ...(root ? { reason: { code: 'workflow_discussion_publication_unavailable' } } : {
        result: { checked: true }, execution: { kind: 'action' as const, actionId: 'review.start', actionRequestId: id, localInputId: id, input: {} },
      }) } }));
  await kit.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope: checkpointEnvelope(rootId),
    rootInvocation: { id: rootId, contentEnvelope: seal(rootId, true) } });
  await kit.execute({ operation: 'invocations.fact', runId, parentAttempt: 0, invocationId: rootId, invocationAttempt: '0',
    expectedContentRevision: '0', expectedLifecycle: 'pending', lifecycle: 'needs_attention', contentEnvelope: seal(rootId, true) });
  await kit.execute({ operation: 'invocations.admit', runId, expectedRevision: kit.run().revision, checkpointEnvelope: checkpointEnvelope(rootId),
    invocations: [{ id: childId, sequence: '1', parentRecordId: rootId, memberOrdinal: '0', lifecycle: 'completed', contentEnvelope: seal(childId, false) },
      ...(active ? [{ id: activeId, sequence: '2', parentRecordId: rootId, memberOrdinal: '1',
        lifecycle: pending === 'review' ? 'waiting_for_review' : 'running', contentEnvelope: seal(activeId, false) }] : [])] });
  await kit.execute({ operation: 'transition', runId, expectedRevision: kit.run().revision,
    state: 'interrupted', checkpointEnvelope: checkpointEnvelope(rootId) });
  const nativeResult = kit.rowById(childId)?.contentEnvelope;
  let publicationAttempts = 0;
  const recover = createWorkflowRunRecoveryReader({ accountId, machineId,
    storage: { execute: async (operation, options) => {
      if (operation.operation === 'recovery.list') return {
        candidates: kit.run().workflowCustodyState === 'pending' ? [{ run: kit.run(), parentAttempt: 3 }] : [],
      };
      // The real storage owner authorizes root settlement with this retained claim attempt.
      if (operation.operation === 'invocations.fact' && operation.invocationId === rootId
        && operation.lifecycle === 'failed' && operation.parentAttempt !== 3) throw new Error('currentness_conflict');
      return await kit.execute(operation, options);
    } },
    resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
    reconcileInvocation: async () => ({ kind: 'unresolved' }),
    onInvocationSettled: async ({ invocation }) => await createWorkflowDiscussionResultPublisher({
      credentials: { token: 'token', encryption: null }, origin, isCurrent: async () => true,
      publish: async () => { publicationAttempts += 1; return { v: 1, ok: false, error: 'action_failed',
        failure: { code: 'action_failed', phase: 'action_admission', retryable: false } }; },
    })({ runId, invocation }) });
  await recover('startup');
  expect(kit.run()).toMatchObject(active ? { state: 'interrupted', workflowCustodyState: 'pending' }
    : { state: 'failed', workflowCustodyState: 'settled' });
  expect(kit.rowById(childId)?.contentEnvelope).toBe(nativeResult);
  expect(kit.rowById(rootId)?.index.lifecycle).toBe(active ? 'needs_attention' : 'failed');
  if (!active) {
    const attempts = publicationAttempts;
    for (let change = 0; change < 5; change += 1) await recover('control');
    expect(publicationAttempts).toBe(attempts);
  }
});

it.each(['retained', 'observed'] as const)('retains Project consent custody (%s) without granting result review or changing operation correspondence', async scenario => {
  const rootId = '2aaf1a39-4c48-4904-83a4-7eae318dfc2c';
  const childId = '33333333-3333-4333-8333-333333333333';
  const pending = { kind: 'pendingApproval', code: 'project_setup_consent_required', reviewedEffectDigest: 'reviewed' };
  const input = { workspace: { serverId: 'home', workspaceId: 'workspace', machineId, rootPath: '/repo' }, phase: 'setup' };
  const operation = { version: 1 as const, operationId: 'original-operation', revision: 1, actionId: 'projects.prepare',
    state: 'accepted' as const, scope: { accountId, machineId }, title: 'Prepare', createdAt: 1, cancellation: 'supported' as const,
    domainRef: { kind: 'projectCommand' as const, purpose: 'setup' as const, serverId: 'home', machineId,
      workspaceRefId: 'workspace', cwd: '/repo' } };
  const target = { key: 'command', serverId: 'home', machineId, operationId: operation.operationId };
  const reviewOutput = { operation: { ...operation, revision: 2, setupReview: { ...pending,
    kind: 'pendingApproval' as const, code: 'project_setup_consent_required' as const, reviewedEffect: { commands: [] } } } };
  const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {}, blocks: [
    { kind: 'action', id: 'prepare', actionId: 'projects.prepare', input: {}, pauseForReview: true },
  ] };
  const spec = getActionSpec('projects.prepare');
  if (!spec.outputSchema || !spec.completion) throw new Error('Project preparation requires an output completion contract');
  const kit = createWorkflowRunStorageTestkit({ accountId, runId, machineId, now, origin: { kind: 'direct' },
    acceptedEnvelope: directAcceptedEnvelope({ definition, materializedLeaves: [{ sourceKey: '$root', blockId: 'prepare',
      kind: 'action', actionId: 'projects.prepare', selection: {}, executionTarget: { kind: 'session' }, authoredWorkspace: { kind: 'inherit' },
      actionInput: input, actionContract: freezeWorkflowActionContractV1(actionSpecToActionDefinitionV1(spec))! }] }) });
  const seal = (id: string, root: boolean) => serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
    binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: id,
      sequence: root ? '0' : '1', parentRecordId: root ? null : rootId, memberOrdinal: '0', attempt: '0' },
    progress: { kind: 'happier.workflow-progress.v1', blockKind: root ? 'root' : 'action',
      invocationPath: { blockId: root ? '$root' : 'prepare', scope: [] }, attempt: '0', logicalInvocationRecordId: id,
      ...(root ? {} : { reason: { code: pending.code }, execution: { kind: 'action' as const, actionId: 'projects.prepare',
        actionRequestId: 'original', localInputId: 'original', input,
        output: scenario === 'retained' ? pending : { operation }, ...(scenario === 'observed' ? { awaitedOperations: [target] } : {}) } }) },
  }));
  await kit.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope: checkpointEnvelope(),
    rootInvocation: { id: rootId, contentEnvelope: seal(rootId, true) } });
  await kit.execute({ operation: 'invocations.admit', runId, expectedRevision: 1, checkpointEnvelope: checkpointEnvelope(),
    invocations: [{ id: childId, sequence: '1', parentRecordId: rootId, memberOrdinal: '0', lifecycle: scenario === 'retained' ? 'needs_attention' : 'running', contentEnvelope: seal(childId, false) }] });
  const writer = createWorkflowInvocationRecoveryFactWriter({ accountId, run: kit.run(), parentAttempt: 0, storage: kit,
    encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } } });
  const held = await writer.readInvocation(childId);
  if (!held) throw new Error('fixture_invocation_unavailable');
  if (scenario === 'retained') expect(await writer.commitObservation(held, { kind: 'completed', result: pending })).toBeNull();
  else expect(await writer.commitObservation(held, { kind: 'unresolved', code: pending.code, setupConsentOutput: reviewOutput }))
    .toMatchObject({ lifecycle: 'needs_attention' });
  expect(kit.rowById(childId)?.index.lifecycle).toBe('needs_attention');
  expect((await writer.readInvocation(childId))?.progress).toMatchObject({ execution: { input, actionRequestId: 'original',
    output: scenario === 'retained' ? pending : reviewOutput, ...(scenario === 'observed' ? { awaitedOperations: [target] } : {}) } });
  expect((await writer.readInvocation(childId))?.progress.result).toBeUndefined();
  expect((await writer.readInvocation(childId))?.progress.review).toBeUndefined();
});

it.each([
  { kind: 'completed', startedAt: now },
  { kind: 'completed', startedAt: undefined },
  { kind: 'failed', startedAt: now },
  { kind: 'cancelled', startedAt: now },
] as const)('refreshes the encrypted root counts after interrupted native reattach without completing the parent ($kind, start=$startedAt)', async (scenario) => {
  const rootId = '2aaf1a39-4c48-4904-83a4-7eae318dfc2c';
  const childId = '33333333-3333-4333-8333-333333333333';
  const kit = createWorkflowRunStorageTestkit({ accountId, runId, machineId, now, origin: { kind: 'direct' },
    acceptedEnvelope: directAcceptedEnvelope() });
  const seal = (id: string, root: boolean) => serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
    mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: id,
      sequence: root ? '0' : '1', parentRecordId: root ? null : rootId, memberOrdinal: '0', attempt: '0' },
    progress: { kind: 'happier.workflow-progress.v1', blockKind: root ? 'root' : 'step',
      invocationPath: { blockId: root ? '$root' : 'step', scope: [] }, attempt: '0', logicalInvocationRecordId: id,
      ...(root ? { stepProgress: { completed: 0, skipped: 0, total: 1 } }
        : { ...(scenario.startedAt ? { timing: { startedAt: scenario.startedAt } } : {}),
          execution: { kind: 'session' as const, sessionId: 'session', localInputId: 'input' } }) },
  }));
  await kit.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope: checkpointEnvelope(),
    rootInvocation: { id: rootId, contentEnvelope: seal(rootId, true) } });
  await kit.execute({ operation: 'invocations.fact', runId, parentAttempt: 0, invocationId: rootId,
    invocationAttempt: '0', expectedContentRevision: '0', expectedLifecycle: 'pending', lifecycle: 'running', contentEnvelope: seal(rootId, true) });
  await kit.execute({ operation: 'invocations.admit', runId, expectedRevision: 1, checkpointEnvelope: checkpointEnvelope(),
    invocations: [{ id: childId, sequence: '1', parentRecordId: rootId, memberOrdinal: '0', lifecycle: 'running', contentEnvelope: seal(childId, false) }] });
  await kit.execute({ operation: 'transition', runId, expectedRevision: 2, state: 'interrupted', checkpointEnvelope: checkpointEnvelope() });
  const writer = createWorkflowInvocationRecoveryFactWriter({ accountId, run: kit.run(), expectedRevision: 3, storage: kit,
    encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } } });
  const child = await writer.readInvocation(childId);
  if (!child) throw new Error('fixture_invocation_unavailable');
  const finishedAt = '2026-09-08T12:03:00.000Z';
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(finishedAt));
  try {
    const replyOutcome = { kind: scenario.kind === 'completed' ? 'pass' as const : scenario.kind };
    const observation = scenario.kind === 'completed' ? { kind: 'completed' as const, result: '', replyOutcome }
      : { kind: scenario.kind, code: 'provider_stopped', replyOutcome };
    await writer.commitObservation(child, observation);
    const settled = await writer.readInvocation(childId);
    expect(settled?.index.lifecycle).toBe(scenario.kind);
    expect(settled?.progress.replyOutcome).toEqual(replyOutcome);
    expect(settled?.progress.timing).toEqual(scenario.startedAt ? { startedAt: scenario.startedAt, finishedAt } : undefined);
    expect(settled?.index).toMatchObject({ id: childId, attempt: child.index.attempt });
    clock.mockReturnValue(Date.parse('2026-09-08T12:04:00.000Z'));
    if (!settled) throw new Error('fixture_invocation_unavailable');
    expect(await writer.commitObservation(settled, observation)).toBeNull();
    expect((await writer.readInvocation(childId))?.progress.timing).toEqual(settled.progress.timing);
  } finally {
    clock.mockRestore();
  }
  expect((await writer.readInvocation(rootId))?.progress.stepProgress).toEqual({ completed: scenario.kind === 'completed' ? 1 : 0, skipped: 0, total: 1 });
  expect(kit.rowById(rootId)?.index.lifecycle).toBe('running');
  expect(kit.run()).toMatchObject({ state: 'interrupted', revision: 3, workflowCustodyState: 'pending' });
  const rootPublication = kit.calls.find((operation) => operation.resolution === 'root_list_progress');
  if (scenario.kind === 'completed') {
    expect(rootPublication).toMatchObject({ expectedRevision: 3, invocationId: rootId, expectedLifecycle: 'running', lifecycle: 'running' });
  } else {
    expect(rootPublication).toBeUndefined();
  }
});

it.each([
  { generation: true, kind: 'unresolved', code: 'session_input_pending', lifecycle: 'running' },
  // A pending stop cannot resolve outcome uncertainty; storage requires definitive terminal evidence.
  { generation: true, kind: 'unresolved', code: 'session_input_pending', lifecycle: 'outcome_uncertain', initialLifecycle: 'outcome_uncertain' },
  { generation: true, kind: 'cancelled', code: 'provider_stopped', lifecycle: 'waiting_for_review' },
  { generation: true, kind: 'failed', code: 'provider_failed', lifecycle: 'waiting_for_review' },
  { generation: true, kind: 'completed', lifecycle: 'completed' },
  { generation: false, kind: 'failed', code: 'provider_failed', lifecycle: 'failed' },
] as const)('preserves recovered review input custody ($kind/$code, generation=$generation, from=$initialLifecycle)', async (scenario) => {
  const rootId = '33333333-3333-4333-8333-333333333333';
  const priorId = '22222222-2222-4222-8222-222222222222';
  const recordId = '44444444-4444-4444-8444-444444444444';
  const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {}, blocks: [{ kind: 'step', id: 'step', pauseForReview: true,
    document: { text: 'Draft', references: [], attachments: [] }, input: [], result: { kind: 'text' } }] };
  const kit = createWorkflowRunStorageTestkit({ runId, machineId, now, state: 'running', origin: { kind: 'direct' },
    acceptedEnvelope: directAcceptedEnvelope({ definition }) });
  const seal = (id: string, sequence: string, parentRecordId: string | null, progress: WorkflowProgressEnvelopeV1) =>
    serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: id, sequence, parentRecordId,
        memberOrdinal: '0', attempt: progress.attempt }, progress }));
  const checkpoint = checkpointEnvelope(rootId);
  await kit.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope: checkpoint,
    rootInvocation: { id: rootId, contentEnvelope: seal(rootId, '0', null, { kind: 'happier.workflow-progress.v1', blockKind: 'root',
      invocationPath: { blockId: '$root', scope: [] }, attempt: '0', logicalInvocationRecordId: rootId }) } });
  await kit.execute({ operation: 'invocations.admit', runId, expectedRevision: 1, checkpointEnvelope: checkpoint,
    invocations: [
      { id: priorId, sequence: '1', parentRecordId: rootId, memberOrdinal: '0', lifecycle: 'superseded',
        contentEnvelope: seal(priorId, '1', rootId, { kind: 'happier.workflow-progress.v1', blockKind: 'step',
          invocationPath: { blockId: 'step', scope: [] }, attempt: '0', logicalInvocationRecordId: priorId, result: 'prior',
          ...(scenario.generation ? { review: { decision: { kind: 'generate', requestedFromContentRevision: '0' } } } : {}) }) },
      { id: recordId, sequence: '2', parentRecordId: rootId, memberOrdinal: '0', lifecycle: 'running',
        contentEnvelope: seal(recordId, '2', rootId, { kind: 'happier.workflow-progress.v1', blockKind: 'step',
          invocationPath: { blockId: 'step', scope: [] }, attempt: '1', logicalInvocationRecordId: priorId, previousAttemptRecordId: priorId,
          timing: { startedAt: now },
          execution: { kind: 'session', sessionId: 'session', localInputId: 'generation-input' } }) },
    ] });
  // Seed the retained replacement row through the canonical storage boundary fixture.
  const replacement = kit.rowById(recordId)!;
  replacement.index = { ...replacement.index, attempt: '1',
    lifecycle: scenario.lifecycle === 'outcome_uncertain' ? scenario.initialLifecycle : 'running' };
  let reviewEntries = 0;
  const writer = createWorkflowInvocationRecoveryFactWriter({ accountId, run: kit.run(), parentAttempt: 0, storage: kit,
    encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } },
    onReviewEntered: async () => { reviewEntries += 1; } });
  const invocation = await writer.readInvocation(recordId);
  if (!invocation) throw new Error('fixture_invocation_unavailable');
  await writer.commitObservation(invocation, scenario.kind === 'completed' ? { kind: 'completed', result: 'generated' }
    : { kind: scenario.kind, code: scenario.code });
  expect(kit.rowById(recordId)?.index.lifecycle).toBe(scenario.lifecycle);
  expect(reviewEntries).toBe(scenario.lifecycle === 'waiting_for_review' ? 1 : 0);
  expect((await writer.readInvocation(recordId))?.progress.timing).toMatchObject({ startedAt: now });
  if (scenario.lifecycle === 'completed' || scenario.lifecycle === 'failed') {
    expect((await writer.readInvocation(recordId))?.progress.timing?.finishedAt).toEqual(expect.any(String));
  } else {
    expect((await writer.readInvocation(recordId))?.progress.timing?.finishedAt).toBeUndefined();
  }
  if (scenario.kind === 'unresolved') {
    expect((await writer.readInvocation(recordId))?.progress.uncertainPriorEffects).toBeUndefined();
  }
  expect(kit.run().workflowCustodyState).toBe('pending');
});

it('reapplies a recovered terminal fact after concurrent publication and enters review with the published value', async () => {
  const recordId = '22222222-2222-4222-8222-222222222222';
  const rootId = '33333333-3333-4333-8333-333333333333';
  const run = WorkflowRunSummaryV1Schema.parse({ sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null, id: runId, origin: { kind: 'direct' }, state: 'running', revision: 2,
    attentionRequired: false, failureUnseen: false, invocationAttentionRequired: false, attentionSeenFailureAt: null, finishedAt: null,
    machineId, workflowCustodyState: 'pending', originDeliveryAckRevision: null, availability, createdAt: now, updatedAt: now });
  let index: WorkflowRunInvocationIndexV1 = { id: recordId, runId, sequence: '1', parentRecordId: rootId,
    memberOrdinal: '0', attempt: '0', contentRevision: '0', lifecycle: 'running', createdAt: now, updatedAt: now };
  const binding = { v: 1 as const, purpose: 'invocation_progress' as const, accountId, runId, recordId,
    sequence: '1', parentRecordId: rootId, memberOrdinal: '0', attempt: '0' };
  let progress: WorkflowProgressEnvelopeV1 = { kind: 'happier.workflow-progress.v1', blockKind: 'step',
    invocationPath: { blockId: 'step', scope: [] }, attempt: '0', logicalInvocationRecordId: recordId,
    execution: { kind: 'session', sessionId: 'session', localInputId: 'input' } };
  const seal = () => serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain', binding, progress }));
  let envelope = seal();
  let facts = 0;
  const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {}, blocks: [{ kind: 'step', id: 'step', pauseForReview: true,
    document: { text: 'Draft', references: [], attachments: [] }, input: [], result: { kind: 'json', schema: { type: 'object', required: ['answer'] } } }] };
  const rootIndex = { ...index, id: rootId, sequence: '0', parentRecordId: null };
  const rootEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
    binding: { ...binding, recordId: rootId, sequence: '0', parentRecordId: null }, progress: { kind: 'happier.workflow-progress.v1',
      blockKind: 'root', invocationPath: { blockId: '$root', scope: [] }, attempt: '0', logicalInvocationRecordId: rootId } }));
  const writer = createWorkflowInvocationRecoveryFactWriter({ accountId, run, parentAttempt: 0,
    encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } },
    storage: { execute: async (operation) => {
      if (operation.operation === 'get') return { run, acceptedEnvelope: directAcceptedEnvelope({ definition }) };
      if (operation.operation === 'invocations.get') return { invocation: operation.invocationId === rootId
        ? { index: rootIndex, contentEnvelope: rootEnvelope } : { index, contentEnvelope: envelope } };
      if (operation.operation !== 'invocations.fact') throw new Error('unexpected_operation');
      facts += 1;
      if (facts === 1) {
        progress = { ...progress, result: { answer: 42 }, review: { resultSource: { kind: 'published', by: 'agent' } } };
        index = { ...index, contentRevision: '1' }; envelope = seal();
        throw Object.assign(new Error('currentness_conflict'), { response: { status: 409 } });
      }
      expect(operation.expectedContentRevision).toBe(index.contentRevision);
      const opened = openWorkflowProgressStoredEnvelopeV1({ mode: 'plain', binding,
        envelope: parseWorkflowStoredContentEnvelopeV1(operation.contentEnvelope) });
      if (opened.kind !== 'available') throw new Error('fixture_content_unavailable');
      progress = opened.content;
      index = { ...index, lifecycle: operation.lifecycle as WorkflowRunInvocationIndexV1['lifecycle'],
        contentRevision: (BigInt(index.contentRevision) + 1n).toString() };
      envelope = String(operation.contentEnvelope);
      return index;
    } },
  });
  const invocation = await writer.readInvocation(recordId);
  if (!invocation) throw new Error('fixture_content_unavailable');
  await writer.commitObservation(invocation, { kind: 'completed', result: 'Here is the plan.' });
  expect(index.lifecycle).toBe('waiting_for_review');
  expect(progress.result).toEqual({ answer: 42 });
  expect(progress.review?.resultSource).toEqual({ kind: 'published', by: 'agent' });
  expect(progress.execution).toEqual({ kind: 'session', sessionId: 'session', localInputId: 'input' });
});

it.each(['step', 'action'] as const)('reattach decodes the frozen %s JSON contract and settles only the exact row without creating parent custody', async (kind) => {
  const recordId = '2aaf1a39-4c48-4904-83a4-7eae318dfc2c';
  const rootId = '33333333-3333-4333-8333-333333333333';
  const run = WorkflowRunSummaryV1Schema.parse({ sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null, id: runId, origin: { kind: 'direct' }, state: 'interrupted', revision: 2,
    attentionRequired: false, failureUnseen: false, invocationAttentionRequired: false, attentionSeenFailureAt: null, finishedAt: null,
    machineId, workflowCustodyState: 'pending', originDeliveryAckRevision: null, availability, createdAt: now, updatedAt: now });
  const index: WorkflowRunInvocationIndexV1 = { id: recordId, runId, sequence: '1', parentRecordId: rootId, memberOrdinal: '0',
    attempt: '0', contentRevision: '0', lifecycle: 'running', createdAt: now, updatedAt: now };
  const binding = { v: 1 as const, purpose: 'invocation_progress' as const, accountId, runId, recordId,
    sequence: '1', parentRecordId: rootId, memberOrdinal: '0', attempt: '0' };
  const contentEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain', binding,
    progress: { kind: 'happier.workflow-progress.v1', blockKind: kind, invocationPath: { blockId: 'step', scope: [] },
      attempt: '0', logicalInvocationRecordId: recordId, resultContract: { kind: 'text' },
      execution: kind === 'step' ? { kind: 'session', sessionId: 'session-1', localInputId: 'input-1' }
        : { kind: 'action', actionId: 'session.goal.set', actionRequestId: 'request', localInputId: 'request', input: {} } },
  }));
  const schema = { type: 'object' as const, required: ['answer'] };
  const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {}, blocks: [kind === 'step' ? { kind: 'step', id: 'step',
    document: { text: 'Work', references: [], attachments: [] }, input: [], result: { kind: 'json', schema } }
    : { kind: 'action', id: 'step', actionId: 'session.goal.set', input: {} }] };
  const materializedLeaves: WorkflowMaterializedLeafV1[] | undefined = kind === 'action' ? [{ authoredWorkspace: { kind: 'inherit' as const },
    sourceKey: '$root', blockId: 'step', kind: 'action', selection: {}, executionTarget: { kind: 'session' },
    actionId: 'session.goal.set', actionContract: { inputSchema: {}, outputSchema: schema },
  }] : undefined;
  const operations: Readonly<Record<string, unknown>>[] = [];
  const rootIndex = { ...index, id: rootId, sequence: '0', parentRecordId: null, lifecycle: 'completed' };
  const rootEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
    binding: { ...binding, recordId: rootId, sequence: '0', parentRecordId: null },
    progress: { kind: 'happier.workflow-progress.v1', blockKind: 'root', invocationPath: { blockId: '$root', scope: [] },
      attempt: '0', logicalInvocationRecordId: rootId },
  }));
  const writer = createWorkflowInvocationRecoveryFactWriter({ accountId, run,
    encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } },
    expectedRevision: 2,
    storage: { execute: async (operation) => {
      operations.push(operation);
      if (operation.operation === 'invocations.get') return { invocation: operation.invocationId === rootId
        ? { index: rootIndex, contentEnvelope: rootEnvelope } : { index, contentEnvelope } };
      if (operation.operation === 'get') return { run, acceptedEnvelope: directAcceptedEnvelope({ definition, materializedLeaves }) };
      if (operation.operation === 'invocations.fact') return {};
      throw new Error('unexpected_replacement_or_claim');
    } },
  });
  const invocation = await writer.readInvocation(recordId);
  if (!invocation) throw new Error('fixture_invocation_unavailable');
  expect(await writer.commitObservation(invocation, { kind: 'completed', result: kind === 'step' ? '{"answer":42}' : { answer: 42 } }))
    .toMatchObject({ id: recordId, lifecycle: 'completed' });
  const fact = operations.find((operation) => operation.operation === 'invocations.fact')!;
  expect(fact).toMatchObject({ expectedRevision: 2, resolution: 'observed_terminal_execution', invocationId: recordId,
    invocationAttempt: '0', expectedLifecycle: 'running', lifecycle: 'completed' });
  expect(fact).not.toHaveProperty('parentAttempt');
  const opened = openWorkflowProgressStoredEnvelopeV1({ mode: 'plain', binding,
    envelope: parseWorkflowStoredContentEnvelopeV1(fact.contentEnvelope) });
  expect(opened.kind === 'available' ? opened.content.result : undefined).toEqual({ answer: 42 });
  expect(operations.some((operation) => operation.operation === 'invocations.admit' || operation.operation === 'initialize')).toBe(false);
});

function isPlainAccountCurrentness(value: unknown): boolean {
  return value !== null && typeof value === 'object' && 'mode' in value && value.mode === 'plain';
}

function directAcceptedEnvelope(params: Readonly<{
  runId?: string;
  definition?: WorkflowDefinitionV1;
  materializedLeaves?: WorkflowMaterializedLeafV1[];
  discussion?: import('@happier-dev/protocol/workflows/workflowDestinationsV1').WorkflowDiscussionOriginV1;
  sealMode?: { mode: 'plain' } | Pick<Extract<Parameters<typeof sealWorkflowAcceptedSnapshotStoredEnvelopeV1>[0], { mode: 'e2ee' }>, 'mode' | 'runDataKey' | 'randomBytes'>;
}> = {}) {
  const definition: WorkflowDefinitionV1 = params.definition ?? { version: 1, inputs: [], defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'agent.test', localId: 'test' } } }, blocks: [{
    kind: 'step', id: 'step', document: { text: 'Work', references: [], attachments: [] }, input: [], result: { kind: 'text' },
  }] };
  return serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
    ...(params.sealMode ?? { mode: 'plain' as const }),
    binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId: params.runId ?? runId },
    acceptedSnapshot: {
      startedBy: 'user', definition, authoredDefinition: definition, workDepth: 0, metadata: null, frozenChildren: {},
      materializedLeaves: params.materializedLeaves ?? [{ sourceKey: '$root', blockId: 'step', kind: 'step',
        authoredWorkspace: { kind: 'inherit' }, selection: definition.defaults, executionTarget: { kind: 'session' } }],
      source: { kind: 'inline' }, inputs: {}, machineId,
      executionTarget: { kind: 'session' },
      workspaceTarget: { project: { machineId, directory: '/repo', checkoutRootPath: '/repo', workspaceRefId: 'workspace-1' }, originalCommittedRevision: 'a'.repeat(40) },
      origin: { kind: 'direct', originSessionId: 'session-origin', ...(params.discussion ? { discussion: params.discussion } : {}) },
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      resultDelivery: params.discussion ? { kind: 'originating_discussion', ...params.discussion }
        : { kind: 'originating_session', originSessionId: 'session-origin' },
    },
  }));
}

function checkpointEnvelope(rootRecordId = '2aaf1a39-4c48-4904-83a4-7eae318dfc2c', ownerRunId = runId) {
  return serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({
    mode: 'plain',
    binding: { v: 1, purpose: 'checkpoint', accountId, runId: ownerRunId },
    checkpoint: {
      kind: 'happier.workflow-checkpoint.v1',
      rootRecordId,
      nextSequence: '8',
      frontier: { nextBlockOrdinal: 1, paused: false },
    },
  }));
}

describe.each(['plain', 'e2ee'] as const)('frozen result recovery (%s)', (mode) => {
  const cases: readonly Readonly<{
    name: string;
    contract: WorkflowStep['result'];
    observed: Extract<WaitForSessionInputReplyResult, { ok: true }>['result'] | { kind: 'typed'; value: JsonValue };
    expected: Pick<WorkflowProgressEnvelopeV1, 'result' | 'reason'>;
    lifecycle: 'completed' | 'failed' | 'cancelled';
  }>[] = [
    { name: 'explicit pass without text', contract: { kind: 'text' },
      observed: { kind: 'fulfilled', outcome: { kind: 'pass' } },
      expected: { result: '' }, lifecycle: 'completed' },
    { name: 'raw JSON at the selected nested leaf', contract: { kind: 'json', schema: { type: 'object', required: ['answer'] } },
      observed: { kind: 'final_text', text: '{"answer":42}', usage: { inputTokens: 8 } },
      expected: { result: { answer: 42 } }, lifecycle: 'completed' },
    { name: 'typed JSON string without reparsing', contract: { kind: 'json', schema: { type: 'string' } },
      observed: { kind: 'typed', value: '{"answer":42}' },
      expected: { result: '{"answer":42}' }, lifecycle: 'completed' },
    { name: 'missing required JSON output', contract: { kind: 'json', schema: {} },
      observed: { kind: 'fulfilled', outcome: { kind: 'pass' } },
      expected: { reason: { code: 'invalid_result_contract', message: 'not_json' } }, lifecycle: 'failed' },
    { name: 'missing permitted decision', contract: { kind: 'decision', decisions: ['continue', 'stop'] },
      observed: { kind: 'fulfilled', outcome: { kind: 'pass' } },
      expected: { reason: { code: 'invalid_result_contract', message: 'not_json' } }, lifecycle: 'failed' },
    { name: 'failed input is not successful no-text', contract: { kind: 'text' },
      observed: { kind: 'failed', message: 'provider failed', usage: { inputTokens: 8 } },
      expected: { reason: { code: 'session_input_failed', message: 'provider failed' } }, lifecycle: 'failed' },
    { name: 'cancelled exact input retains usage', contract: { kind: 'text' },
      observed: { kind: 'cancelled', message: 'input cancelled', usage: { inputTokens: 8 } },
      expected: { reason: { code: 'session_input_cancelled' } }, lifecycle: 'cancelled' },
  ];

  async function recoverResult(test: (typeof cases)[number], options: Readonly<{
    acceptedAvailable?: boolean;
    observationAvailable?: boolean;
    initialReason?: WorkflowProgressEnvelopeV1['reason'];
  }> = {}) {
    const material = mode === 'e2ee' ? createAccountScopedCryptoMaterialSnapshotV1({
      accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    }) : undefined;
    const encryption: AvailableAutomationAccountEncryptionV1 = mode === 'plain'
      ? { kind: 'available', witness: { mode, version: 1, contentKeyFingerprint: null } }
      : { kind: 'available', witness: { mode, version: 1, contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(material!.contentPublicKeyFingerprint) }, material: material! };
    const prepared = prepareWorkflowRunDataKeyV1({ accountId, encryption, randomBytes: (length: number) => new Uint8Array(length).fill(3) });
    const sealMode = prepared.runCrypto.mode === 'plain' ? prepared.runCrypto
      : { ...prepared.runCrypto, randomBytes: (length: number) => new Uint8Array(length).fill(3) };
    const ownerEnvelope = prepared.recipientKeyEnvelopes[0]?.encryptedDataKey ?? null;
    const rootId = '1aaf1a39-4c48-4904-83a4-7eae318dfc2c';
    const parentId = '2aaf1a39-4c48-4904-83a4-7eae318dfc2c';
    const leafId = '3aaf1a39-4c48-4904-83a4-7eae318dfc2c';
    const leaf: WorkflowStep = { kind: 'step', id: 'shared', document: { text: 'Work', references: [], attachments: [] }, input: [], result: test.contract };
    // Both branches deliberately reuse an id. Recovery must follow the stored
    // structural slot, not the first global match or the row's display contract.
    const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {}, blocks: [{
      kind: 'if', id: 'choice', when: { kind: 'exists', value: { kind: 'literal', value: true } },
      then: [{ ...leaf, result: { kind: 'text' } }], otherwise: [leaf],
    }] };
    const kit = createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'direct' },
      keyCensus: { runId, ownerAccountId: accountId, access: 'owner', visibleTeamId: null, encryptionMode: mode,
        ownerAccountCurrentness: encryption.witness, dataEncryptionKey: ownerEnvelope,
        callerDataEncryptionKey: ownerEnvelope, recipients: [] },
      acceptedEnvelope: options.acceptedAvailable !== false ? directAcceptedEnvelope({ definition, sealMode }) : 'unavailable' });
    const checkpoint = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({
      ...sealMode, binding: { v: 1, purpose: 'checkpoint', accountId, runId },
      checkpoint: { kind: 'happier.workflow-checkpoint.v1', rootRecordId: rootId, nextSequence: '3', frontier: { nextBlockOrdinal: 1, paused: false } },
    }));
    const sealRow = (index: Pick<WorkflowRunInvocationIndexV1, 'id' | 'sequence' | 'parentRecordId' | 'memberOrdinal'>, progress: WorkflowProgressEnvelopeV1) =>
      serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ ...sealMode,
        binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: index.id,
          sequence: index.sequence, parentRecordId: index.parentRecordId, memberOrdinal: index.memberOrdinal, attempt: '0' }, progress }));
    const root = { id: rootId, sequence: '0', parentRecordId: null, memberOrdinal: '0' };
    const parent = { id: parentId, sequence: '1', parentRecordId: rootId, memberOrdinal: '0' };
    const child = { id: leafId, sequence: '2', parentRecordId: parentId, memberOrdinal: '0' };
    const rootEnvelope = sealRow(root, { kind: 'happier.workflow-progress.v1', blockKind: 'root', invocationPath: { blockId: '$root', scope: [] }, attempt: '0', logicalInvocationRecordId: rootId });
    await kit.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope: checkpoint, rootInvocation: { id: rootId, contentEnvelope: rootEnvelope } });
    await kit.execute({ operation: 'invocations.fact', runId, invocationId: rootId, invocationAttempt: '0',
      expectedContentRevision: kit.rowById(rootId)!.index.contentRevision,
      expectedLifecycle: 'pending', lifecycle: 'completed', contentEnvelope: rootEnvelope });
    await kit.execute({ operation: 'invocations.admit', runId, expectedRevision: 1, checkpointEnvelope: checkpoint, invocations: [
      { ...parent, lifecycle: 'completed', contentEnvelope: sealRow(parent, { kind: 'happier.workflow-progress.v1', blockKind: 'if', invocationPath: { blockId: 'choice', scope: [] },
        container: { kind: 'if', selected: 'otherwise', nextBlockOrdinal: '0' }, attempt: '0', logicalInvocationRecordId: parentId }) },
      { ...child, lifecycle: options.initialReason ? 'needs_attention' : 'running', contentEnvelope: sealRow(child, { kind: 'happier.workflow-progress.v1', blockKind: 'step', invocationPath: { blockId: 'shared', scope: [] },
        attempt: '0', logicalInvocationRecordId: leafId, resultContract: { kind: 'text' },
        ...(options.initialReason ? { reason: options.initialReason } : {}),
        execution: test.observed.kind === 'typed' ? { kind: 'detached_run', runId: 'execution-1', localInputId: 'input-1', runtimeSelection: {} }
          : { kind: 'session', sessionId: 'session-1', localInputId: 'input-1' } }) },
    ] });
    await kit.execute({ operation: 'transition', runId, expectedRevision: 2, state: 'failed', checkpointEnvelope: checkpoint });
    const seeded = kit.calls.length;
    const observeSession = vi.fn(async () => {
      if (test.observed.kind === 'typed') throw new Error('wrong_execution_correspondence');
      if (options.observationAvailable === false) return { ok: false as const, code: 'session_not_found' as const };
      return { ok: true as const, sessionId: 'session-1', localId: 'input-1', result: test.observed };
    });
    const observer = createWorkflowInvocationRecoveryObserver({ credentials: { token: 'token', encryption: null }, machineId,
      observeSession, cancelSession: async () => { throw new Error('terminal_input_must_not_be_cancelled'); },
      actionExecutor: { execute: async () => ({ ok: true as const, result: { run: {
        runId: 'execution-1', callId: 'call-1', sidechainId: 'sidechain-1', intent: 'agent',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, permissionMode: 'read_only',
        retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'request_response', status: 'running', startedAtMs: 1,
        inputTurns: { occurrenceId: 'occurrence-1', last: { turnId: 'turn-1', inputIds: ['input-1'], state: 'completed',
          result: { kind: 'json', value: test.observed.kind === 'typed' ? test.observed.value : null } } },
      } } }) },
    });
    await createWorkflowRunRecoveryReader({ accountId, machineId,
      storage: { execute: async (operation, options) => operation.operation === 'recovery.list'
        ? { candidates: [{ run: kit.run(), parentAttempt: 1 }] } : await kit.execute(operation, options) },
      resolveAccountEncryption: async () => encryption, reconcileInvocation: observer,
    })('reconnect');
    const row = kit.rowById(leafId)!;
    const opened = openWorkflowProgressStoredEnvelopeV1({ ...prepared.runCrypto,
      binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: leafId,
        sequence: '2', parentRecordId: parentId, memberOrdinal: '0', attempt: '0' },
      envelope: parseWorkflowStoredContentEnvelopeV1(row.contentEnvelope) });
    if (opened.kind !== 'available') throw new Error('recovered_row_unavailable');
    expect(kit.run().state).toBe('failed');
    expect(kit.calls.slice(seeded).some((operation) => operation.operation === 'initialize' || operation.operation === 'invocations.admit')).toBe(false);
    return { lifecycle: row.index.lifecycle, progress: opened.content, custody: kit.run().workflowCustodyState, observeSession };
  }

  it.each(cases)('$name retains exact custody and validates the frozen contract', async (test) => {
    const recovered = await recoverResult(test);
    expect(recovered.lifecycle).toBe(test.lifecycle);
    expect(recovered.progress.result).toEqual(test.expected.result);
    expect(recovered.progress.reason).toEqual(test.expected.reason);
    expect(recovered.progress.usage).toEqual('usage' in test.observed ? test.observed.usage : undefined);
    expect(recovered.progress.replyOutcome).toEqual(test.observed.kind === 'fulfilled' ? test.observed.outcome : undefined);
    expect(recovered.custody).toBe('settled');
    if (test.observed.kind !== 'typed') expect(recovered.observeSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-1', localId: 'input-1' }));
  });

  it('keeps completion unresolved when the accepted contract cannot be opened', async () => {
    const recovered = await recoverResult(cases[1]!, { acceptedAvailable: false });
    expect(recovered.lifecycle).toBe('running');
    expect(recovered.progress.result).toBeUndefined();
    expect(recovered.custody).toBe('pending');
  });

  it('settles a terminal provider failure while preserving the previously published timeout reason', async () => {
    const failedInput = cases.find((test) => test.observed.kind === 'failed');
    if (!failedInput) throw new Error('missing_failed_input_fixture');
    const initialReason = { code: 'workflow_step_timeout' };
    const recovered = await recoverResult(failedInput, { initialReason });
    expect(recovered.lifecycle).toBe('failed');
    expect(recovered.progress.reason).toEqual(initialReason);
    expect(recovered.progress.result).toBeUndefined();
    expect(recovered.progress.usage).toEqual({ inputTokens: 8 });
    expect(recovered.custody).toBe('settled');
  });

  it('does not turn an unavailable exact Session into successful empty text', async () => {
    const recovered = await recoverResult(cases[0]!, { observationAvailable: false });
    expect(recovered.lifecycle).toBe('running');
    expect(recovered.progress.result).toBeUndefined();
    expect(recovered.custody).toBe('pending');
  });

  it('redacts registered host secrets from a detached result during recovery before storage', async () => {
    const unregister = registerTranscriptSecret('native-host-secret');
    try {
      const recovered = await recoverResult({
        name: 'detached secret',
        contract: { kind: 'json', schema: { type: 'object', required: ['answer'] } },
        observed: { kind: 'typed', value: { answer: 'native-host-secret' } },
        expected: { result: { answer: '[redacted]' } },
        lifecycle: 'completed',
      });
      expect(recovered.progress.result).toEqual({ answer: '[redacted]' });
      expect(recovered.custody).toBe('settled');
    } finally {
      unregister();
    }
  });
});

describe('workflow Run startup/reconnect recovery', () => {
  it.each(['already_completed', 'late_completion', 'aggregate_publication_lost', 'wrong_birth',
    'startup_failed', 'startup_failed_expired', 'startup_failed_missing_correspondence', 'startup_failure_wrong_request'] as const)(
    'reconciles an uncertain startup with its exact Session input (%s)', async scenario => {
      const rootId = '33333333-3333-4333-8333-333333333333';
      const childId = '44444444-4444-4444-8444-444444444444';
      const sessionId = 'startup-session';
      const creationKey = `workflow:${runId}:${childId}`;
      const localId = deriveWorkflowSessionInputLocalIdV2({ purpose: 'invocation', runId, invocationRecordId: childId });
      const startupFailed = scenario.startsWith('startup_fail');
      const correspondence = SessionCreationCorrespondenceV1Schema.parse({ v: 1,
        sessionCreationTag: deriveWorkflowSessionCreationTag('home', runId,
          scenario === 'wrong_birth' ? 'unrelated-startup' : creationKey),
        recipe: { execution: { machineId, directory: { kind: 'path', path: '/repo' } }, organization: { folderId: null, tagIds: [] },
          agentTarget: { kind: 'agent', identity: { pluginId: 'external.agent', localId: 'agent' } },
          modelSelection: null, profileId: null, requestedPermissionMode: null, agentModeId: null, configuration: null,
          connectedServices: null, capabilitySelection: null, transcriptStorage: null, terminal: null,
          agentSessionStartupInstructionsMarkerV1: null, checkout: null },
      });
      const operation = { version: 1, operationId: 'startup', revision: 3, actionId: 'session.spawn_new',
        requestId: scenario === 'startup_failure_wrong_request' ? 'foreign-startup' : creationKey,
        scope: { accountId, machineId }, title: 'Create', state: startupFailed ? 'failed' : 'succeeded', cancellation: 'supported',
        createdAt: 1, startedAt: 1, settledAt: 2, ...(startupFailed
          ? { error: { errorCode: 'ECONNABORTED', error: 'timeout of 30000ms exceeded' } } : { result: { sessionId } }) };
      const kit = createWorkflowRunStorageTestkit({ runId, machineId, now, origin: { kind: 'direct' },
        acceptedEnvelope: directAcceptedEnvelope() });
      const seal = (id: string, root: boolean) => serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: id,
          sequence: root ? '0' : '1', parentRecordId: root ? null : rootId, memberOrdinal: '0', attempt: '0' },
        progress: { kind: 'happier.workflow-progress.v1', blockKind: root ? 'root' : 'step',
          invocationPath: { blockId: root ? '$root' : 'step', scope: [] }, attempt: '0', logicalInvocationRecordId: id,
          ...(root ? { stepProgress: { completed: 0, total: 1, destinations: [
            { sourceKey: '$root', blockId: 'step', ordinal: 1, name: 'Original step', sessionIds: [] },
          ] } } : { workspace: { descriptor: { machineId, directory: '/repo', checkoutRootPath: '/repo' } },
            ...(scenario === 'startup_failed_missing_correspondence' ? {} : { execution: { kind: 'action' as const,
              actionId: operation.actionId, actionRequestId: creationKey, localInputId: creationKey,
              input: { creationKey }, output: { operation }, awaitedOperations: [{ key: 'startup', serverId: 'home', machineId, operationId: operation.operationId }] } }) }) },
      }));
      await kit.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope: checkpointEnvelope(rootId),
        rootInvocation: { id: rootId, contentEnvelope: seal(rootId, true) } });
      await kit.execute({ operation: 'invocations.admit', runId, expectedRevision: 1, checkpointEnvelope: checkpointEnvelope(rootId),
        invocations: [{ id: childId, sequence: '1', parentRecordId: rootId, memberOrdinal: '0',
          lifecycle: scenario === 'startup_failed_missing_correspondence' ? 'pending' : startupFailed ? 'running' : 'outcome_uncertain', contentEnvelope: seal(childId, false) }] });
      await kit.execute({ operation: 'transition', runId, parentAttempt: 0, expectedRevision: 2, state: 'interrupted',
        checkpointEnvelope: checkpointEnvelope(rootId) });
      let terminal = scenario !== 'late_completion';
      let inputReads = 0;
      const inputMessage = { id: 'input', localId, seq: 1, createdAt: 1, updatedAt: 1,
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Work' } } } };
      const messages = [inputMessage, { id: 'answer', localId: null, seq: 2, createdAt: 2, updatedAt: 2,
        content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'exact result' } } } },
        { id: 'terminal', localId: null, seq: 3, createdAt: 3, updatedAt: 3,
          content: { t: 'plain', v: { role: 'agent', content: { type: 'acp', data: { type: 'task_complete', id: 'turn' } } } } }];
      const server = createServer((request, response) => {
        const url = new URL(request.url ?? '/', 'http://localhost');
        response.setHeader('Content-Type', 'application/json');
        const reply = (data: unknown, status = 200) => { response.statusCode = status; response.end(JSON.stringify(data)); };
        if (url.pathname === '/v1/account/encryption/currentness') return reply({ mode: 'plain', version: 1,
          signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
          recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } });
        if (url.pathname === `/v2/sessions/${sessionId}`) return reply({ session: createSessionRecordFixture({ id: sessionId,
          active: true, machineId, encryptionMode: 'plain', metadata: JSON.stringify({ machineId, path: '/repo', sessionCreationCorrespondenceV1: correspondence }) }) });
        if (url.pathname.endsWith('/reply')) return reply({ v: 1, status: 'none' });
        if (url.pathname.startsWith(`/v2/sessions/${sessionId}/messages/by-local-id/`)) { inputReads++; return reply({ message: inputMessage }); }
        if (url.pathname === `/v1/sessions/${sessionId}/messages`) return reply({ messages: terminal ? messages : [inputMessage], hasMore: false });
        return reply({ error: 'not-found' }, 404);
      });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('test_http_address_unavailable');
      let signalCompletion: (() => void) | undefined;
      const socketBoundary = vi.spyOn(sessionSockets, 'createSessionScopedSocketConnection').mockImplementation(() => {
        const boundary = Object.assign(new EventEmitter(), { connected: true, connect() {}, disconnect() {}, close() {} }) as unknown as ReturnType<typeof sessionSockets.createSessionScopedSocketConnection>['socket'];
        signalCompletion = () => { EventEmitter.prototype.emit.call(boundary, 'connect'); };
        return { socket: boundary, transport: createSocketTransportAdapter(boundary) };
      });
      const controller = new AbortController();
      try {
        const observe = createWorkflowInvocationRecoveryObserver({ machineId,
          credentials: { token: `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`, encryption: null },
          actionExecutor: { execute: async () => { throw new Error('Recovery cannot admit work'); } },
          nativeActionOperations: { get: async () => scenario === 'startup_failed_expired' ? { kind: 'not_found' } : ({ kind: 'found', operation }),
            findStartup: async () => ({ kind: 'found', operation: ActionOperationSnapshotV1Schema.parse(operation),
              target: { key: 'startup', serverId: 'home', machineId, operationId: operation.operationId } }),
            cancel: async () => { throw new Error('Startup is terminal'); }, wait: async () => { throw new Error('Startup is terminal'); } },
        });
        let rejectRootPublication = scenario === 'aggregate_publication_lost';
        const recover = createWorkflowRunRecoveryReader({ accountId, machineId,
          storage: { execute: async (request, options) => {
            if (rejectRootPublication && request.operation === 'invocations.fact' && request.invocationId === rootId) {
              rejectRootPublication = false;
              throw new Error('root_publication_transport_unavailable');
            }
            return request.operation === 'recovery.list'
              ? { candidates: [{ run: kit.run(), parentAttempt: 0 }] } : kit.execute(request, options);
          } },
          resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
          reconcileInvocation: observe,
        });
        await runWithServerHttpBaseUrl(`http://127.0.0.1:${address.port}`, async () => {
          if (scenario === 'aggregate_publication_lost') {
            await expect(recover('startup', controller.signal)).rejects.toThrow('root_publication_transport_unavailable');
            expect(kit.rowById(childId)?.index.lifecycle).toBe('completed');
            await recover('reconnect', controller.signal);
          } else await recover('startup', controller.signal);
          if (startupFailed) {
            const writer = createWorkflowInvocationRecoveryFactWriter({ accountId, run: kit.run(), expectedRevision: kit.run().revision, storage: kit,
              encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } } });
            const leaf = await writer.readInvocation(childId);
            if (scenario === 'startup_failure_wrong_request') expect(leaf?.index.lifecycle).toBe('running');
            else {
              expect(leaf?.index.lifecycle).toBe('failed');
              expect(leaf?.progress.reason).toEqual({ code: 'ECONNABORTED', message: 'timeout of 30000ms exceeded' });
            }
            expect(kit.run().state).toBe('interrupted');
            expect(inputReads).toBe(0);
            return;
          }
          if (scenario === 'wrong_birth') {
            expect(inputReads).toBe(0);
            expect(kit.rowById(childId)?.index.lifecycle).toBe('outcome_uncertain');
            return;
          }
          if (scenario === 'late_completion') {
            await vi.waitFor(() => expect(signalCompletion).toBeDefined());
            terminal = true;
            signalCompletion!();
          }
          await vi.waitFor(() => expect(kit.rowById(childId)?.index.lifecycle).toBe('completed'));
          const writer = createWorkflowInvocationRecoveryFactWriter({ accountId, run: kit.run(), parentAttempt: 0, storage: kit,
            encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } } });
          expect((await writer.readInvocation(childId))?.progress).toMatchObject({ result: 'exact result',
            execution: { kind: 'session', sessionId, localInputId: localId } });
          const reader = createWorkflowAccountRunActionOwner({ resolveAccountId: async () => accountId, storage: kit,
            definitions: { get: async () => { throw new Error('unexpected_definition_read'); } },
            resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
            normalizeAbsolutePath: directory => directory.startsWith('/') ? directory : null,
            randomBytes: () => { throw new Error('plain_account_does_not_need_keys'); },
          });
          await vi.waitFor(async () => {
            const output = WorkflowActionOutputSchemasV1['workflow.run.get'].parse(await reader.execute({
              actionId: 'workflow.run.get', input: { runId }, context: {},
            }));
            expect(output.run.stepProgress).toMatchObject({ completed: 1, total: 1, destinations: [
              { blockId: 'step', name: 'Original step', sessionIds: [],
                observation: { recordId: childId, lifecycle: 'completed', contentRevision: kit.rowById(childId)?.index.contentRevision } },
            ] });
          });
          expect(kit.calls.filter(call => call.operation === 'invocations.fact' && call.invocationId === rootId).at(-1))
            .toMatchObject({ resolution: 'root_list_progress', expectedRevision: kit.run().revision });
          expect(kit.run().state).toBe('interrupted');
          expect(kit.rows()).toHaveLength(2);
        });
      } finally {
        controller.abort();
        socketBoundary.mockRestore();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
    });

  it.each(['cancelled_input', 'discarded_failed_quiet', 'other_input', 'handled_input', 'unknown_launch', 'deleted_session', 'failed_detached', 'failed_quiet', 'cancelled_quiet', 'startup_queued', 'startup_discard_lost', 'startup_wrong_birth',
    'missing_text', 'typed_no_result', 'late_typed_no_result', 'terminal_missing_text', 'cancelled_missing_text', 'cancelled_typed_no_result',
    'cancelled_discussion_refused_missing_text', 'cancelled_discussion_unavailable_missing_text',
    'cancelled_discussion_misbound_missing_text', 'cancelled_discussion_pending_missing_text',
    'cancelled_discussion_unavailable_wrong_turn_missing_text', 'cancelled_discussion_unavailable_late_missing_text',
    'cancelled_discussion_retry_missing_text', 'completed_discussion_retry_missing_text',
    'completed_discussion_unavailable_missing_text', 'completed_discussion_misbound_missing_text',
    'completed_discussion_pending_missing_text'] as const)('recovers exact discarded Session input custody without treating inactive or unknown work as stopped (%s)', async scenario => {
    const rootId = '33333333-3333-4333-8333-333333333333';
    const childId = '44444444-4444-4444-8444-444444444444';
    const sessionId = 'stopped-workflow-session';
    const discussion = scenario.includes('_discussion_')
      ? { discussion: { serverId: 'home', discussionId: 'discussion' }, messageId: 'question', throughSeq: 1 } : undefined;
    const unavailableDiscussion = scenario.includes('_discussion_unavailable_');
    const wrongTurn = scenario === 'cancelled_discussion_unavailable_wrong_turn_missing_text';
    const lateUnavailableDiscussion = scenario === 'cancelled_discussion_unavailable_late_missing_text';
    const retryPublication = scenario.endsWith('discussion_retry_missing_text');
    const completedPublication = scenario.startsWith('completed_discussion_');
    const missingResult = scenario.endsWith('missing_text') || scenario.endsWith('typed_no_result');
    const quiet = scenario === 'failed_quiet' || scenario === 'discarded_failed_quiet' || scenario === 'cancelled_quiet' || missingResult;
    const startup = scenario.startsWith('startup_');
    const workflowInvocation = { runId, invocationRecordId: childId };
    const localId = quiet || startup ? deriveWorkflowSessionInputLocalIdV2({ purpose: 'invocation', ...workflowInvocation }) : 'exact-workflow-input';
    const creationKey = `workflow:${runId}:${childId}`;
    const startupOperation = { version: 1 as const, operationId: 'startup', revision: 3, actionId: 'session.spawn_new',
      requestId: creationKey, scope: { accountId, machineId }, title: 'Create', state: 'succeeded' as const,
      cancellation: 'supported' as const, createdAt: 1, startedAt: 1, settledAt: 2, result: { sessionId } };
    const correspondence = SessionCreationCorrespondenceV1Schema.parse({ v: 1,
      sessionCreationTag: deriveWorkflowSessionCreationTag('home', runId,
        scenario === 'startup_wrong_birth' ? 'unrelated-startup' : creationKey),
      recipe: { execution: { machineId, directory: { kind: 'path', path: '/repo' } }, organization: { folderId: null, tagIds: [] },
        agentTarget: { kind: 'agent', identity: { pluginId: 'external.agent', localId: 'agent' } },
        modelSelection: null, profileId: null, requestedPermissionMode: null, agentModeId: null, configuration: null,
        connectedServices: null, capabilitySelection: null, transcriptStorage: null, terminal: null,
        agentSessionStartupInstructionsMarkerV1: null, checkout: null } });
    const hostInput = { id: 'host-event', localId, seq: 1, createdAt: 100, updatedAt: 100,
      content: { t: 'plain', v: buildAcpAgentMessageEnvelope({ provider: 'claude', body: { id: localId,
        type: 'event', data: { type: 'message', message: WORKFLOW_STEP_INPUT_EVENT_MESSAGE } } }) } };
    const kit = createWorkflowRunStorageTestkit({ runId, machineId, now, origin: { kind: 'direct' },
      acceptedEnvelope: directAcceptedEnvelope({ ...(discussion ? { discussion } : {}) }) });
    const seal = (id: string, root: boolean) => serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: id,
        sequence: root ? '0' : '1', parentRecordId: root ? null : rootId, memberOrdinal: '0', attempt: '0' },
      progress: { kind: 'happier.workflow-progress.v1', blockKind: root ? 'root' : 'step',
        invocationPath: { blockId: root ? '$root' : 'step', scope: [] }, attempt: '0', logicalInvocationRecordId: id,
        ...(!root && scenario !== 'unknown_launch' ? { workspace: { descriptor: { machineId, directory: '/repo', checkoutRootPath: '/repo' } },
          execution: startup ? { kind: 'action' as const, actionId: 'session.spawn_new', actionRequestId: creationKey,
            localInputId: creationKey, input: { creationKey }, output: { operation: startupOperation },
            awaitedOperations: [{ key: 'startup', serverId: 'home', machineId, operationId: startupOperation.operationId }] } : scenario === 'failed_detached'
          ? { kind: 'detached_run' as const, runId: 'failed-native-run', localInputId: localId, runtimeSelection: {} }
          : { kind: 'session' as const, sessionId, localInputId: localId } } : {}) },
    }));
    await kit.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope: checkpointEnvelope(rootId),
      rootInvocation: { id: rootId, contentEnvelope: seal(rootId, true) } });
    await kit.execute({ operation: 'invocations.admit', runId, expectedRevision: 1, checkpointEnvelope: checkpointEnvelope(rootId),
      invocations: [{ id: childId, sequence: '1', parentRecordId: rootId, memberOrdinal: '0',
        lifecycle: completedPublication ? 'completed' : scenario === 'failed_detached' ? 'outcome_uncertain' : 'running', contentEnvelope: seal(childId, false) }] });
    if (missingResult && !scenario.startsWith('cancelled_') && !completedPublication) await kit.execute({ operation: 'transition', runId,
      expectedRevision: 2, state: scenario === 'terminal_missing_text' ? 'failed' : 'interrupted', checkpointEnvelope: checkpointEnvelope(rootId) });
    else kit.requestControl('cancelled');
    expect(kit.run()).toMatchObject({ workflowCustodyState: 'pending', attentionRequired: false });
    const requests: { method: string; path: string }[] = [];
    let replyAvailable = scenario !== 'late_typed_no_result' && !lateUnavailableDiscussion;
    let discarded = false;
    let rejectDiscard = scenario === 'startup_discard_lost';
    const stopBoundary = vi.spyOn(machineRpc, 'callMachineRpc').mockImplementation(async request => {
      if (request.method !== RPC_METHODS.STOP_SESSION || request.machineId !== machineId) throw new Error('Wrong startup stop target');
      return { status: 'not_found' };
    });
    // Real HTTP readers consume the same tombstone shape as the retained Home.
    // Only the Home/storage and socket transports are substituted.
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      requests.push({ method: request.method ?? '', path: url.pathname });
      response.setHeader('Content-Type', 'application/json');
      const reply = (data: unknown, status = 200) => { response.statusCode = status; response.end(JSON.stringify(data)); };
      if (url.pathname === '/v1/account/encryption/currentness') return reply({
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
        recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
      });
      if (scenario === 'deleted_session') {
        if (url.pathname === `/v2/sessions/${sessionId}`) return reply({ error: 'Session not found' }, 404);
        if (url.pathname === '/v2/sessions' || url.pathname === '/v2/sessions/archived') return reply({ sessions: [], hasNext: false, nextCursor: null });
        if (url.pathname === '/v2/sessions/lookup-by-tags') return reply({ sessions: [] });
      }
      if (url.pathname === `/v2/sessions/${sessionId}`) return reply({ session: createSessionRecordFixture({
        id: sessionId, active: false, encryptionMode: 'plain', machineId,
        metadata: JSON.stringify({ machineId, path: '/repo', ...(startup ? { sessionCreationCorrespondenceV1: correspondence } : {}) }),
      }) });
      if (retryPublication && discussion && url.pathname.endsWith('/reply') && request.method === 'POST') return reply({ v: 1, ok: true,
        progress: { v: 1, mode: 'wait', disposition: 'observing',
          workflow: { purpose: 'invocation', runId, invocationRecordId: childId },
          discussion: { discussionId: discussion.discussion.discussionId, messageId: discussion.messageId,
            throughSeq: discussion.throughSeq, participantSessionId: sessionId }, acceptedTurnId: 'quiet-turn', outcome: { kind: 'terminal_no_result' },
          returnPublication: { kind: 'failed', failure: { code: 'discussion_archived', phase: 'workflow_publication', retryable: false } } } });
      if (discussion && url.pathname.endsWith('/reply')) return reply(SessionMessageReplyReadResultV1Schema.parse(
        unavailableDiscussion ? { v: 1, status: 'unavailable' }
          : { v: 1, status: 'available', progress: { v: 1, mode: 'wait', disposition: 'observing',
            workflow: { purpose: 'invocation', runId, invocationRecordId:
              scenario.endsWith('discussion_misbound_missing_text') ? rootId : childId },
            discussion: { discussionId: discussion.discussion.discussionId, messageId: discussion.messageId,
              throughSeq: discussion.throughSeq, participantSessionId: sessionId },
            acceptedTurnId: 'quiet-turn', outcome: { kind: 'terminal_no_result' },
            returnPublication: scenario.endsWith('discussion_pending_missing_text')
              ? { kind: 'approval_pending', artifactId: 'approval' }
              : { kind: 'failed', failure: { code: retryPublication ? 'discussions_unavailable' : 'action_failed',
                phase: 'action_admission', retryable: retryPublication } } } }));
      if (url.pathname.endsWith('/reply')) return reply(SessionMessageReplyReadResultV1Schema.parse(scenario.endsWith('typed_no_result')
        ? { v: 1, status: 'available', progress: { v: 1, mode: 'wait', disposition: 'observing',
          acceptedTurnId: 'quiet-turn', ...(replyAvailable ? { outcome: { kind: 'terminal_no_result' } } : {}) } }
        : { v: 1, status: 'none' }));
      if (url.pathname.startsWith(`/v2/sessions/${sessionId}/messages/by-local-id/`)) return quiet
        ? reply({ message: hostInput }) : reply({ error: 'Message not found' }, 404);
      if (quiet && url.pathname === `/v1/sessions/${sessionId}/turns`) return reply({ v: 1, sessionId, updatedAt: 200,
        turns: [parseStoredSessionTurn({ turnId: 'quiet-turn', status: !replyAvailable ? 'in_progress' : missingResult ? 'completed' : scenario.endsWith('failed_quiet') ? 'failed' : 'cancelled',
          startedAt: 100, updatedAt: 200, terminalAt: 200, initiator: 'workflow', workDepth: 1,
          ...(missingResult ? { transcriptAnchorsJson: JSON.stringify({
            startUserMessageSeq: wrongTurn ? 2 : 1, userMessageSeqs: [wrongTurn ? 2 : 1],
            startSeqInclusive: wrongTurn ? 2 : 1, endSeqInclusive: wrongTurn ? 2 : 1, finalAssistantMessageSeq: null }) } : {}),
          workflowInvocationJson: JSON.stringify(wrongTurn ? { ...workflowInvocation, invocationRecordId: rootId } : workflowInvocation) })] });
      if (quiet && url.pathname === `/v1/sessions/${sessionId}/messages`) return reply({ messages: [hostInput], hasMore: false });
      if (url.pathname === `/v2/sessions/${sessionId}/pending` && request.method === 'GET') {
        if (startup) return reply({ pending: [{ localId, status: discarded ? 'discarded' : 'queued',
          deliveryStatus: discarded ? { status: 'discarded', reason: 'session_input_cancelled' }
            : { status: 'delivering', phase: 'awaiting_acceptance' }, discardedAt: discarded ? 1 : null }] });
        // e36e7551d897: exact Pending withdrawal precedes transcript custody.
        // Native-turn cases have no withdrawal; cancelled_input covers that authority.
        return reply({ pending: (!quiet || scenario === 'discarded_failed_quiet') && url.searchParams.get('includeDiscarded') === 'true' ? [{
          localId: scenario === 'other_input' ? 'different-input' : localId,
          status: 'discarded', deliveryStatus: { status: 'discarded', reason: scenario === 'handled_input' ? 'manual_handled' : 'session_input_cancelled' }, discardedAt: 1,
        }] : [] });
      }
      if (startup && request.method === 'POST' && url.pathname === `/v2/sessions/${sessionId}/pending/${encodeURIComponent(localId)}/discard`) {
        if (rejectDiscard) { rejectDiscard = false; return reply({ error: 'storage_unavailable' }, 503); }
        discarded = true;
        return reply({ ok: true });
      }
      return reply({ error: 'session-not-found' }, 404);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test_http_address_unavailable');
    const observingSockets: EventEmitter[] = [];
    const socketBoundary = vi.spyOn(sessionSockets, 'createSessionScopedSocketConnection').mockImplementation(() => {
      // This fixture represents the untyped socket.io network adapter, not its host observer.
      const events = new EventEmitter();
      observingSockets.push(events);
      const socket = Object.assign(events, { connected: false, connect() {}, disconnect() {}, close() {} }) as unknown as ReturnType<typeof sessionSockets.createSessionScopedSocketConnection>['socket'];
      return { socket, transport: createSocketTransportAdapter(socket) };
    });
    const controller = new AbortController();
    try {
      const observe = createWorkflowInvocationRecoveryObserver({
        credentials: { token: `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`, encryption: null }, machineId,
        actionExecutor: { execute: async (actionId) => {
          if (scenario === 'failed_detached' && actionId === 'execution.run.get') return { ok: true, result: {
            run: { runId: 'failed-native-run', callId: 'call', sidechainId: 'side', intent: 'agent',
              backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, permissionMode: 'default',
              retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'request_response',
              status: 'failed', startedAtMs: 1, finishedAtMs: 2, error: { code: 'execution_run_failed' },
              inputTurns: { occurrenceId: 'initial-provisioning',
                last: { turnId: localId, inputIds: [localId], state: 'failed' } } },
          } };
          throw new Error('Recovery cannot start an Action');
        } },
        ...(startup ? { nativeActionOperations: { get: async () => ({ kind: 'found' as const, operation: startupOperation }),
          cancel: async () => { throw new Error('Startup is terminal'); }, wait: async () => { throw new Error('Startup is terminal'); } } } : {}),
      });
      let publicationAttempts = 0;
      const recover = createWorkflowRunRecoveryReader({ accountId, machineId,
        storage: { execute: async (operation, options) => operation.operation === 'recovery.list'
          ? { candidates: [{ run: kit.run(), parentAttempt: 0 }] } : await kit.execute(operation, options) },
        resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
        reconcileInvocation: observe,
        ...(discussion ? { onInvocationSettled: async ({ invocation, retryFailedPublications }: Readonly<{
          invocation: import('./coordinator').WorkflowCoordinatorInvocation; retryFailedPublications?: boolean;
        }>) =>
          await createWorkflowDiscussionResultPublisher({ credentials: { token: 'token', encryption: null },
            origin: discussion, isCurrent: async () => true, retryFailedPublications, publish: async () => {
              publicationAttempts += 1;
              if (retryPublication) return { v: 1, ok: false, error: 'discussion_archived' };
              throw new Error('Existing refusal, pending approval or unavailable binding must not publish');
            } })({ runId, invocation }) } : {}),
      });
      await runWithServerHttpBaseUrl(`http://127.0.0.1:${address.port}`, () => recover('startup', controller.signal));
      if (scenario === 'late_typed_no_result') {
        expect(kit.rowById(childId)?.index.lifecycle).toBe('running');
        replyAvailable = true;
        for (const socket of observingSockets) socket.emit('connect');
        await vi.waitFor(() => expect(kit.rowById(childId)?.index.lifecycle).toBe('needs_attention'));
      }
      if (lateUnavailableDiscussion) {
        expect(kit.rowById(childId)?.index.lifecycle).toBe('cancel_requested');
        replyAvailable = true;
        for (const socket of observingSockets) socket.emit('connect');
        await vi.waitFor(() => expect(kit.rowById(childId)?.index.lifecycle).toBe('cancelled'));
      }
      if (scenario === 'startup_discard_lost') {
        expect(kit.run().workflowCustodyState).toBe('pending');
        expect(discarded).toBe(false);
        await runWithServerHttpBaseUrl(`http://127.0.0.1:${address.port}`, () => recover('reconnect', controller.signal));
      }
      if (startup) {
        expect(discarded).toBe(scenario !== 'startup_wrong_birth');
        expect(kit.run()).toMatchObject({ state: 'cancelled', workflowCustodyState: scenario === 'startup_wrong_birth' ? 'pending' : 'settled' });
        expect(kit.rowById(childId)?.index.lifecycle).toBe(scenario === 'startup_wrong_birth' ? 'cancel_requested' : 'cancelled');
        return;
      }
      if (scenario === 'discarded_failed_quiet') {
        expect(kit.rowById(childId)?.index.lifecycle).toBe('cancelled');
        expect(kit.run()).toMatchObject({ state: 'cancelled', workflowCustodyState: 'settled' });
        const writer = createWorkflowInvocationRecoveryFactWriter({ accountId, run: kit.run(), parentAttempt: 0, storage: kit,
          encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } } });
        expect((await writer.readInvocation(childId))?.progress.reason).toEqual({ code: 'session_input_cancelled' });
        return;
      }
      if (completedPublication) {
        expect(kit.run()).toMatchObject({ state: 'cancelled', workflowCustodyState: retryPublication ? 'settled' : 'pending' });
        expect(kit.rowById(childId)?.index.lifecycle).toBe('completed');
        expect(publicationAttempts).toBe(retryPublication ? 1 : 0);
        for (let hint = 0; hint < 3; hint++) {
          await runWithServerHttpBaseUrl(`http://127.0.0.1:${address.port}`, () => recover('control', controller.signal));
        }
        expect(publicationAttempts).toBe(retryPublication ? 1 : 0);
        return;
      }
      if (missingResult) {
        const cancelling = scenario.startsWith('cancelled_');
        if (wrongTurn) {
          expect(kit.rowById(childId)?.index.lifecycle).toBe('cancel_requested');
          expect(kit.run()).toMatchObject({ state: 'cancelled', workflowCustodyState: 'pending', attentionRequired: false });
          expect(publicationAttempts).toBe(0);
          return;
        }
        expect(kit.rowById(childId)?.index.lifecycle).toBe(cancelling ? 'cancelled' : 'needs_attention');
        expect(kit.run()).toMatchObject({ state: cancelling ? 'cancelled' : scenario === 'terminal_missing_text' ? 'failed' : 'interrupted',
          workflowCustodyState: cancelling ? 'settled' : 'pending', attentionRequired: !cancelling });
        const writer = createWorkflowInvocationRecoveryFactWriter({ accountId, run: kit.run(), parentAttempt: 0, storage: kit,
          encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } } });
        const recovered = await writer.readInvocation(childId);
        expect(recovered?.progress.reason).toEqual({ code: 'session_input_result_unavailable' });
        expect(recovered?.progress.result).toBeUndefined();
        expect(recovered?.progress.replyOutcome).toEqual(scenario.endsWith('typed_no_result') || discussion
          && !unavailableDiscussion ? { kind: 'terminal_no_result' } : undefined);
        if (discussion) expect(publicationAttempts).toBe(0);
        if (unavailableDiscussion) {
          const nativeReads = () => requests.filter(request => request.path === `/v1/sessions/${sessionId}/turns`).length;
          // One reply-aware baseline plus one exact physical-custody read.
          if (!lateUnavailableDiscussion) expect(nativeReads()).toBe(2);
          const retiredNativeReads = nativeReads();
          await runWithServerHttpBaseUrl(`http://127.0.0.1:${address.port}`, () => recover('reconnect', controller.signal));
          expect(kit.rowById(childId)?.index.lifecycle).toBe('cancelled');
          expect(kit.run()).toMatchObject({ state: 'cancelled', workflowCustodyState: 'settled' });
          // Publication recovery must not reopen already-retired native custody.
          expect(nativeReads()).toBe(retiredNativeReads);
          expect(publicationAttempts).toBe(0);
        }
        expect(requests.every(request => request.method === 'GET' || retryPublication && request.path.endsWith('/reply') || lateUnavailableDiscussion
          && request.method === 'POST' && request.path === `/v2/sessions/${sessionId}/pending/${encodeURIComponent(localId)}/discard`)).toBe(true);
        return;
      }
      const cancelled = scenario === 'cancelled_input' || scenario === 'cancelled_quiet';
      const failed = scenario === 'failed_detached' || scenario === 'failed_quiet';
      const settled = cancelled || failed;
      if (!quiet && !['unknown_launch', 'deleted_session', 'failed_detached'].includes(scenario)) expect(requests).toContainEqual({ method: 'GET', path: `/v2/sessions/${sessionId}/pending` });
      expect(kit.rowById(childId)?.index.lifecycle).toBe(failed ? 'failed' : cancelled ? 'cancelled' : 'cancel_requested');
      expect(kit.run()).toMatchObject({ state: 'cancelled', workflowCustodyState: settled ? 'settled' : 'pending', attentionRequired: false });
      if (scenario === 'cancelled_input' || quiet) expect(requests.every(request => request.method === 'GET')).toBe(true);
      if (scenario === 'unknown_launch') expect(requests).toEqual([]);
    } finally {
      controller.abort();
      socketBoundary.mockRestore();
      stopBoundary.mockRestore();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it('settles Session custody when its exact terminal arrives after the cancellation read without another recovery trigger', async () => {
    const rootId = '33333333-3333-4333-8333-333333333333';
    const childId = '44444444-4444-4444-8444-444444444444';
    const sessionId = 'stopped-workflow-session';
    const localId = 'exact-workflow-input';
    const kit = createWorkflowRunStorageTestkit({ runId, machineId, now, origin: { kind: 'direct' },
      acceptedEnvelope: directAcceptedEnvelope() });
    const seal = (id: string, root: boolean) => serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: id,
        sequence: root ? '0' : '1', parentRecordId: root ? null : rootId, memberOrdinal: '0', attempt: '0' },
      progress: { kind: 'happier.workflow-progress.v1', blockKind: root ? 'root' : 'step',
        invocationPath: { blockId: root ? '$root' : 'step', scope: [] }, attempt: '0', logicalInvocationRecordId: id,
        ...(!root ? { execution: { kind: 'session' as const, sessionId, localInputId: localId },
          workspace: { descriptor: { machineId, directory: '/repo', checkoutRootPath: '/repo' } } } : {}) },
    }));
    await kit.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope: checkpointEnvelope(rootId),
      rootInvocation: { id: rootId, contentEnvelope: seal(rootId, true) } });
    await kit.execute({ operation: 'invocations.admit', runId, expectedRevision: 1, checkpointEnvelope: checkpointEnvelope(rootId),
      invocations: [{ id: childId, sequence: '1', parentRecordId: rootId, memberOrdinal: '0', lifecycle: 'running', contentEnvelope: seal(childId, false) }] });
    kit.requestControl('cancelled');
    let terminal = false;
    const inputMessage = { id: 'input-row', localId, seq: 1, createdAt: 1, updatedAt: 1,
      content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Work' } } } };
    const terminalMessage = { id: 'terminal-row', localId: null, seq: 2, createdAt: 2, updatedAt: 2,
      content: { t: 'plain', v: { role: 'agent', content: { type: 'acp', data: { type: 'turn_cancelled', id: 'turn-1' } } } } };
    // HTTP and Session RPC are system boundaries; recovery, input observation,
    // cancellation, stored-envelope readers and the fact writer stay real.
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      response.setHeader('Content-Type', 'application/json');
      const reply = (data: unknown, status = 200) => { response.statusCode = status; response.end(JSON.stringify(data)); };
      if (url.pathname === '/v1/account/encryption/currentness') return reply({
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
        recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
      });
      if (url.pathname === `/v2/sessions/${sessionId}`) return reply({ session: createSessionRecordFixture({
        id: sessionId, active: false, encryptionMode: 'plain', machineId,
        metadata: JSON.stringify({ machineId, path: '/repo' }),
      }) });
      if (url.pathname.endsWith('/reply')) return reply({ v: 1, status: 'none' });
      if (url.pathname.startsWith(`/v2/sessions/${sessionId}/messages/by-local-id/`)) return reply({ message: inputMessage });
      if (url.pathname === `/v1/sessions/${sessionId}/messages`) return reply({ messages: terminal ? [inputMessage, terminalMessage] : [inputMessage], hasMore: false });
      if (url.pathname === `/v2/sessions/${sessionId}/pending/${localId}/discard`) return reply({ error: 'not-found' }, 404);
      return reply({ error: 'session-not-found' }, 404);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test_http_address_unavailable');
    const socketBoundary = vi.spyOn(sessionSockets, 'createSessionScopedSocketConnection').mockImplementation(() => {
      // socket.io supplies an untyped event adapter at this boundary.
      const socket = Object.assign(new EventEmitter(), { connected: false, connect() {}, disconnect() {}, close() {} }) as unknown as ReturnType<typeof sessionSockets.createSessionScopedSocketConnection>['socket'];
      return { socket, transport: createSocketTransportAdapter(socket) };
    });
    const rpcBoundary = vi.spyOn(sessionRpc, 'callSessionRpc').mockImplementation(async () => {
      terminal = true;
      return { ok: false, sessionId, localId, status: 'notRunning' };
    });
    const controller = new AbortController();
    try {
      const observe = createWorkflowInvocationRecoveryObserver({
        credentials: { token: `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`, encryption: null }, machineId,
        actionExecutor: { execute: async () => { throw new Error('Recovery cannot start an Action'); } },
      });
      const recover = createWorkflowRunRecoveryReader({ accountId, machineId,
        storage: { execute: async (operation, options) => operation.operation === 'recovery.list'
          ? { candidates: [{ run: kit.run(), parentAttempt: 0 }] } : await kit.execute(operation, options) },
        resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
        reconcileInvocation: observe,
      });
      await runWithServerHttpBaseUrl(`http://127.0.0.1:${address.port}`, async () => {
        await recover('startup', controller.signal);
        expect(terminal).toBe(true);
        await vi.waitFor(() => expect(kit.run()).toMatchObject({ state: 'cancelled', workflowCustodyState: 'settled' }));
        expect(kit.rowById(childId)?.index.lifecycle).toBe('cancelled');
      });
    } finally {
      controller.abort();
      rpcBoundary.mockRestore();
      socketBoundary.mockRestore();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it.each(['later', 'before_observation', 'running_parent', 'lost_stop_response', 'publication_ack_lost', 'publication_denied', 'publication_action_failed', 'publication_unavailable', 'missing_publisher'] as const)('settles stopped Action child custody only after publishing the accepted terminal result (%s)', async (timing) => {
    const rootId = '33333333-3333-4333-8333-333333333333';
    const childId = '44444444-4444-4444-8444-444444444444';
    const completion = freezeActionCompletionContractV1(getActionSpec('review.start').completion!);
    const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {},
      blocks: [{ kind: 'action', id: 'review', actionId: 'review.start', input: {} }] };
    const kit = createWorkflowRunStorageTestkit({ runId, machineId, now, origin: { kind: 'direct' },
      acceptedEnvelope: directAcceptedEnvelope({ definition,
        discussion: { discussion: { serverId: 'home', discussionId: 'discussion' }, messageId: 'question', throughSeq: 1 },
        materializedLeaves: [{ sourceKey: '$root', blockId: 'review',
        kind: 'action', actionId: 'review.start', selection: {}, executionTarget: { kind: 'detached_run' },
        authoredWorkspace: { kind: 'inherit' }, actionContract: { inputSchema: {}, outputSchema: {}, completion } }] }) });
    const seal = (id: string, root: boolean) => serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: id,
        sequence: root ? '0' : '1', parentRecordId: root ? null : rootId, memberOrdinal: '0', attempt: '0' },
      progress: { kind: 'happier.workflow-progress.v1', blockKind: root ? 'root' : 'action',
        invocationPath: { blockId: root ? '$root' : 'review', scope: [] }, attempt: '0', logicalInvocationRecordId: id,
        ...(root ? {} : { execution: { kind: 'action' as const, actionId: 'review.start', actionRequestId: 'request', localInputId: 'request', input: {},
          output: { intent: 'review', sessionId: null, results: [{ key: 'codex', ok: true, result: { runId: 'native-review' } }] },
          awaitedRuns: [{ key: 'codex', runId: 'native-review' }] } }) },
    }));
    await kit.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope: checkpointEnvelope(rootId),
      rootInvocation: { id: rootId, contentEnvelope: seal(rootId, true) } });
    await kit.execute({ operation: 'invocations.admit', runId, expectedRevision: 1, checkpointEnvelope: checkpointEnvelope(rootId),
      invocations: [{ id: childId, sequence: '1', parentRecordId: rootId, memberOrdinal: '0', lifecycle: 'running', contentEnvelope: seal(childId, false) }] });
    kit.requestControl(timing === 'running_parent' ? 'cancel_requested' : 'cancelled');
    let terminal = false;
    let finish = () => {};
    const terminalEvent = new Promise<void>((resolve) => { finish = () => { terminal = true; resolve(); }; });
    const snapshot = () => ({ run: { runId: 'native-review', callId: 'call', sidechainId: 'side', intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, permissionMode: 'default', retentionPolicy: 'resumable',
      runClass: 'bounded', ioMode: 'request_response', status: terminal ? 'succeeded' : 'running', startedAtMs: 1 },
      ...(terminal ? { latestToolResult: { findings: [], reviewedFingerprint: 'fingerprint', commentIds: ['comment'], materialization: { kind: 'complete' } } } : {}) });
    const observe = createWorkflowInvocationRecoveryObserver({ credentials: { token: 'token', encryption: null }, machineId,
      actionExecutor: { execute: async () => { throw new Error('unexpected_action_effect'); } },
      nativeActionRuns: { get: async () => snapshot(), stop: async () => {
        if (timing === 'before_observation') finish();
        if (timing === 'lost_stop_response') throw new Error('stop_response_lost');
        return { ok: true };
      },
        wait: async () => { await terminalEvent; return snapshot(); } } });
    let indexed = false;
    const published = new Map<string, JsonValue | undefined>();
    let allowPublicationAck = timing !== 'publication_ack_lost' && timing !== 'publication_unavailable';
    let publicationOffered = false;
    let publicationAttempts = 0;
    const failureLog = vi.spyOn(logger, 'warn');
    onTestFinished(() => failureLog.mockRestore());
    const onInvocationSettled: NonNullable<Parameters<typeof createWorkflowRunRecoveryReader>[0]['onInvocationSettled']> = async ({ invocation, accepted }) => {
      expect(kit.run().workflowCustodyState).toBe('pending');
      const origin = accepted.resultDelivery;
      if (origin?.kind !== 'originating_discussion') throw new Error('Expected Discussion delivery');
      expect(kit.rowById(invocation.recordId)?.index.lifecycle).toBe('completed');
      await createWorkflowDiscussionResultPublisher({ credentials: { token: 'token', encryption: null }, origin,
        isCurrent: async () => true, publish: async publication => {
          publicationOffered = true;
          publicationAttempts += 1;
          if (timing === 'publication_denied') return { v: 1, ok: false, error: 'discussion_post_denied' };
          if (timing === 'publication_action_failed') return { v: 1, ok: false, error: 'action_failed',
            failure: { code: 'action_failed', phase: 'action_admission', retryable: false } };
          if (timing === 'publication_unavailable' && !allowPublicationAck) return { v: 1, ok: false, error: 'discussions_unavailable' };
          published.set(invocation.recordId, invocation.result);
          if (!allowPublicationAck) throw new Error('committed_reply_ack_lost');
          if (!('kind' in publication)) throw new Error('Expected Workflow result');
          return { v: 1, ok: true, value: { messageSeq: 2, message: { id: 'reply', localId: 'reply', seq: 2,
            discussionId: origin.discussion.discussionId, authorAccountId: accountId,
            accountActor: { v: 1, accountId, profile: null }, producerV1: publication.producer,
            content: { t: 'plain', v: publication.content }, mentionedAccountIds: [], createdAt: 2 } } };
        } })({ runId, invocation });
    };
    const recover = createWorkflowRunRecoveryReader({ accountId, machineId,
      storage: { execute: async (operation, options) => {
        if (operation.operation !== 'recovery.list') return await kit.execute(operation, options);
        // The completion wake must not launch another global sweep.
        if (indexed) throw new Error('unexpected_global_recovery_sweep');
        indexed = true;
        return { candidates: kit.run().workflowCustodyState === 'settled' ? [] : [{ run: kit.run(), parentAttempt: 0 }] };
      } },
      resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      ...(timing === 'missing_publisher' ? {} : { onInvocationSettled }),
      reconcileInvocation: observe });
    await recover('startup');
    if (timing !== 'before_observation') {
      expect(kit.run().workflowCustodyState).toBe('pending');
      expect(kit.rowById(childId)?.index.lifecycle).toBe('cancel_requested');
      finish();
    }
    if (timing === 'missing_publisher') {
      await vi.waitFor(() => expect(kit.rowById(childId)?.index.lifecycle).toBe('completed'));
      indexed = false;
      await recover('reconnect');
      expect(kit.run().workflowCustodyState).toBe('pending');
      expect(published.size).toBe(0);
      return;
    }
    if (timing === 'publication_ack_lost' || timing === 'publication_unavailable') {
      await vi.waitFor(() => expect(publicationOffered).toBe(true));
      expect(kit.run().workflowCustodyState).toBe('pending');
      allowPublicationAck = true;
      indexed = false;
      await recover('reconnect');
    }
    await vi.waitFor(() => expect(kit.run()).toMatchObject({ state: 'cancelled', workflowCustodyState: 'settled' }));
    const writer = createWorkflowInvocationRecoveryFactWriter({ accountId, run: kit.run(), parentAttempt: 0, storage: kit,
      encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } } });
    expect((await writer.readInvocation(childId))?.progress.result).toMatchObject({ commentIds: ['comment'],
      perEngineOutcome: [{ key: 'codex', runId: 'native-review', outcome: 'completed' }] });
    expect(kit.rowById(childId)?.index.lifecycle).toBe('completed');
    if (timing === 'publication_denied' || timing === 'publication_action_failed') {
      expect(published.size).toBe(0);
      expect(failureLog).toHaveBeenCalledWith(expect.stringContaining('publication'), expect.objectContaining({
        runId, invocationId: childId, errorCode: timing === 'publication_denied' ? 'discussion_post_denied' : 'action_failed',
      }));
      const settledAttempts = publicationAttempts;
      for (let change = 0; change < 5; change += 1) { indexed = false; await recover('control'); }
      expect(publicationAttempts).toBe(settledAttempts);
    } else {
      expect(published.get(childId)).toMatchObject({ commentIds: ['comment'] });
      expect(published.size).toBe(1);
    }
  });

  it.each(['same_page', 'next_page'] as const)('continues independent Run recovery after an unavailable publication (%s)', async placement => {
    const secondRunId = '5bdb1c35-94f7-4b17-884c-101b6956edd6';
    const rootId = '33333333-3333-4333-8333-333333333333';
    const childId = '44444444-4444-4444-8444-444444444444';
    const origin = { discussion: { serverId: 'home', discussionId: 'discussion' }, messageId: 'question', throughSeq: 1 };
    const createStopped = async (id: string, discussion: boolean) => {
      const kit = createWorkflowRunStorageTestkit({ accountId, runId: id, machineId, now, origin: { kind: 'direct' },
        acceptedEnvelope: directAcceptedEnvelope({ runId: id, ...(discussion ? { discussion: origin } : {}) }) });
      const seal = (root: boolean) => serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'invocation_progress', accountId, runId: id, recordId: root ? rootId : childId,
          sequence: root ? '0' : '1', parentRecordId: root ? null : rootId, memberOrdinal: '0', attempt: '0' },
        progress: { kind: 'happier.workflow-progress.v1', blockKind: root ? 'root' : 'step',
          invocationPath: { blockId: root ? '$root' : 'step', scope: [] }, attempt: '0', logicalInvocationRecordId: root ? rootId : childId,
          ...(!root && discussion ? { result: { finished: true }, execution: { kind: 'action' as const,
            actionId: 'plugin:testdebt.external.finish', actionRequestId: childId, localInputId: childId, input: {} } } : {}) } }));
      await kit.execute({ operation: 'initialize', runId: id, expectedRevision: 0, checkpointEnvelope: checkpointEnvelope(rootId, id),
        rootInvocation: { id: rootId, contentEnvelope: seal(true) } });
      await kit.execute({ operation: 'invocations.admit', runId: id, expectedRevision: 1, checkpointEnvelope: checkpointEnvelope(rootId, id),
        invocations: [{ id: childId, sequence: '1', parentRecordId: rootId, memberOrdinal: '0', lifecycle: discussion ? 'completed' : 'cancelled', contentEnvelope: seal(false) }] });
      kit.requestControl('cancelled');
      return kit;
    };
    const first = await createStopped(runId, true);
    const second = await createStopped(secondRunId, false);
    const recover = createWorkflowRunRecoveryReader({ accountId, machineId,
      storage: { execute: async (operation, options) => {
        if (operation.operation !== 'recovery.list') return await (operation.runId === secondRunId ? second : first).execute(operation, options);
        const candidate = (kit: typeof first) => ({ run: kit.run(), parentAttempt: 0 });
        return operation.cursor ? { candidates: [candidate(second)] }
          : { candidates: [candidate(first), ...(placement === 'same_page' ? [candidate(second)] : [])],
            ...(placement === 'next_page' ? { nextCursor: 'next' } : {}) };
      } },
      resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      reconcileInvocation: async () => { throw new Error('Completed native work must not execute again'); },
      onInvocationSettled: async ({ invocation }) => {
        await createWorkflowDiscussionResultPublisher({ credentials: { token: 'token', encryption: null }, origin,
          isCurrent: async () => true, publish: async () => ({ v: 1, ok: false, error: 'discussions_unavailable' }) })({ runId, invocation });
      } });
    await recover('startup');
    expect(first.run().workflowCustodyState).toBe('pending');
    expect(first.rowById(childId)?.index.lifecycle).toBe('completed');
    expect(second.run().workflowCustodyState).toBe('settled');
  });

  it.each(['transient', 'approval'] as const)('keeps return hints exact while another non-Session publication is %s and retains concurrent Run demand', async hold => {
    const ids = [runId, '5bdb1c35-94f7-4b17-884c-101b6956edd6', '6bdb1c35-94f7-4b17-884c-101b6956edd6'];
    const origin = { discussion: { serverId: 'home', discussionId: 'discussion' }, messageId: 'question', throughSeq: 1 };
    const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {}, blocks: [
      { kind: 'action', id: 'check', actionId: 'review.start', input: {} },
    ] };
    const kits = new Map<string, ReturnType<typeof createWorkflowRunStorageTestkit>>();
    for (const id of ids) {
      const kit = createWorkflowRunStorageTestkit({ accountId, runId: id, machineId, now, origin: { kind: 'direct' },
        acceptedEnvelope: directAcceptedEnvelope({ runId: id, definition, discussion: origin }) });
      const seal = (root: boolean) => serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'invocation_progress', accountId, runId: id, recordId: root ? 'root' : 'leaf',
          sequence: root ? '0' : '1', parentRecordId: root ? null : 'root', memberOrdinal: '0', attempt: '0' },
        progress: { kind: 'happier.workflow-progress.v1', blockKind: root ? 'root' : 'action',
          invocationPath: { blockId: root ? '$root' : 'check', scope: [] }, attempt: '0', logicalInvocationRecordId: root ? 'root' : 'leaf',
          ...(root ? {} : { result: { checked: true }, execution: { kind: 'action' as const,
            actionId: 'review.start', actionRequestId: 'request', localInputId: 'request', input: {} } }) } }));
      await kit.execute({ operation: 'initialize', runId: id, expectedRevision: 0, checkpointEnvelope: checkpointEnvelope('root', id),
        rootInvocation: { id: 'root', contentEnvelope: seal(true) } });
      await kit.execute({ operation: 'invocations.admit', runId: id, expectedRevision: 1, checkpointEnvelope: checkpointEnvelope('root', id),
        invocations: [{ id: 'leaf', sequence: '1', parentRecordId: 'root', memberOrdinal: '0', lifecycle: 'completed', contentEnvelope: seal(false) }] });
      kit.requestControl('cancelled');
      kits.set(id, kit);
    }
    const attempts: string[] = [], selections: (string | undefined)[] = [];
    let release = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    let paused = false;
    let allowA = false;
    const recover = createWorkflowRunRecoveryReader({ accountId, machineId,
      storage: { execute: async (operation, options) => {
        if (operation.operation !== 'recovery.list') return await kits.get(String(operation.runId))!.execute(operation, options);
        const selected = typeof operation.runId === 'string' ? operation.runId : undefined;
        selections.push(selected);
        if (selected === ids[1] && !paused) { paused = true; await gate; }
        return { candidates: [...kits].filter(([id, kit]) => (!selected || selected === id) && kit.run().workflowCustodyState === 'pending')
          .map(([, kit]) => ({ run: kit.run(), parentAttempt: 0 })) };
      } },
      resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      reconcileInvocation: async () => { throw new Error('Terminal native work must not execute again'); },
      onInvocationSettled: async ({ run, invocation }) => await createWorkflowDiscussionResultPublisher({
        credentials: { token: 'token', encryption: null }, origin, isCurrent: async () => true, publish: async () => {
          attempts.push(run.id);
          if (run.id === ids[0] && !allowA) return hold === 'approval'
            ? { v: 1, ok: false, error: 'discussions_unavailable', pending: { kind: 'approval', artifactId: 'approval' } }
            : { v: 1, ok: false, error: 'discussions_unavailable' };
          // A terminal refusal settles only this Run's publication custody.
          return { v: 1, ok: false, error: 'discussion_post_denied' };
        },
      })({ runId: run.id, invocation }) });
    await recover('control', undefined, ids[0]);
    expect(kits.get(ids[0]!)!.run().workflowCustodyState).toBe('pending');
    expect(attempts).toEqual([ids[0]]);
    attempts.length = 0;
    selections.length = 0;
    const firstHint = recover('control', undefined, ids[1]);
    await vi.waitFor(() => expect(paused).toBe(true));
    const secondHint = recover('control', undefined, ids[2]);
    release();
    await Promise.all([firstHint, secondHint]);
    expect(selections).toEqual([ids[1], ids[2]]);
    expect(attempts).toEqual([ids[1], ids[2]]);
    expect(kits.get(ids[0]!)!.run().workflowCustodyState).toBe('pending');
    for (const id of ids.slice(1)) expect(kits.get(id)!.run().workflowCustodyState).toBe('settled');
    // Its own approval/return evidence can advance A, without a broad scan.
    allowA = true;
    await recover('control', undefined, ids[0]);
    expect(selections).toEqual([ids[1], ids[2], ids[0]]);
    expect(kits.get(ids[0]!)!.run().workflowCustodyState).toBe('settled');
    await recover('reconnect');
    await recover('resume');
    expect(selections.slice(-2)).toEqual([undefined, undefined]);
  });

  it('pages terminal candidates and settles custody while origin updates remain unacknowledged', async () => {
    const run = { sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null, id: runId, origin: { kind: 'direct' as const, originSessionId: 'session-origin' }, state: 'succeeded' as const,
      attentionRequired: false, failureUnseen: false, invocationAttentionRequired: false, attentionSeenFailureAt: null, finishedAt: null,
      revision: 9, machineId, workflowCustodyState: 'pending' as const, originDeliveryAckRevision: 0,
      availability, createdAt: now, updatedAt: now };
    const execute = vi.fn(async (operation: Readonly<Record<string, unknown>>) => {
      if (operation.operation === 'recovery.list') return operation.cursor
        ? { candidates: [] } : { candidates: [{ run, parentAttempt: 3 }], nextCursor: 'page-2' };
      if (operation.operation === 'run-key.census') return createPlainWorkflowRunKeyCensusFixture({ runId, accountId });
      if (operation.operation === 'invocations.list') return { invocations: [], parentRevision: 9 };
      if (operation.operation === 'get') return { run, checkpointEnvelope: checkpointEnvelope() };
      if (operation.operation === 'transition') return { ...run, revision: 10, workflowCustodyState: 'settled' };
      throw new Error(`unexpected:${String(operation.operation)}`);
    });
    const recover = createWorkflowRunRecoveryReader({
      accountId, machineId, storage: { execute },
      resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      reconcileInvocation: vi.fn(async () => ({ kind: 'unresolved' as const })),
    });
    await recover('startup');
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'transition', runId, parentAttempt: 3, expectedRevision: 9, state: 'succeeded', custodyState: 'settled',
    }), {});
    expect(execute.mock.calls.some(([operation]) => operation.operation === 'recovery.list' && operation.cursor === 'page-2')).toBe(true);
  });

  it('opens only lifecycle-selected invocation rows and never coordinates or starts terminal parents', async () => {
    const invocationId = '2aaf1a39-4c48-4904-83a4-7eae318dfc2c';
    const rootId = '33333333-3333-4333-8333-333333333333';
    const completedId = '44444444-4444-4444-8444-444444444444';
    const root = { id: rootId, sequence: '0', parentRecordId: null, memberOrdinal: '0' };
    const child = { id: invocationId, sequence: '1', parentRecordId: rootId, memberOrdinal: '0' };
    const completed = { id: completedId, sequence: '2', parentRecordId: rootId, memberOrdinal: '1' };
    const progress = { kind: 'happier.workflow-progress.v1' as const, invocationPath: { blockId: 'work', scope: [] }, blockKind: 'step' as const,
      attempt: '0', logicalInvocationRecordId: invocationId, execution: { kind: 'session' as const, sessionId: 'session-1', localInputId: 'input-1' } };
    const sealRow = (row: Pick<WorkflowRunInvocationIndexV1, 'id' | 'sequence' | 'parentRecordId' | 'memberOrdinal'>, content: WorkflowProgressEnvelopeV1) =>
      serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
        mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: row.id,
          sequence: row.sequence, parentRecordId: row.parentRecordId, memberOrdinal: row.memberOrdinal, attempt: '0' }, progress: content,
      }));
    const checkpoint = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'checkpoint', accountId, runId },
      checkpoint: { kind: 'happier.workflow-checkpoint.v1', rootRecordId: rootId, nextSequence: '3',
        frontier: { nextBlockOrdinal: 2, paused: false } },
    }));
    // The real storage-boundary testkit advances lifecycle/contentRevision and
    // sealed bytes together, so settlement rereads observe the committed fact.
    const kit = createWorkflowRunStorageTestkit({ runId, machineId, now,
      origin: { kind: 'automation', automationId: 'automation-1' }, invocationPageSize: 1,
      acceptedEnvelope: directAcceptedEnvelope({ definition: { version: 1, inputs: [], defaults: {}, blocks: [
        { kind: 'step', id: 'work', document: { text: 'Work', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
        { kind: 'step', id: 'finished', document: { text: 'Finished', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
      ] } }),
    });
    await kit.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope: checkpoint,
      rootInvocation: { id: rootId, contentEnvelope: sealRow(root, { kind: 'happier.workflow-progress.v1',
        invocationPath: { blockId: '$root', scope: [] }, blockKind: 'root', attempt: '0', logicalInvocationRecordId: rootId }) },
    });
    await kit.execute({ operation: 'invocations.admit', runId, expectedRevision: 1, checkpointEnvelope: checkpoint,
      invocations: [{ ...child, lifecycle: 'running', contentEnvelope: sealRow(child, progress) },
        { ...completed, lifecycle: 'completed', contentEnvelope: sealRow(completed, { kind: 'happier.workflow-progress.v1',
          invocationPath: { blockId: 'finished', scope: [] }, blockKind: 'step', attempt: '0', logicalInvocationRecordId: completedId,
          result: 'already done' }) }],
    });
    kit.requestControl('cancelled');
    const run = kit.run();
    const index = kit.rowById(invocationId)!.index;
    const execute = vi.fn(async (operation: WorkflowRunStorageTestkitOperation, options?: Readonly<{ signal?: AbortSignal }>) => {
      if (operation.operation === 'recovery.list') return { candidates: [{ run, parentAttempt: 2 }] };
      if (operation.operation === 'invocations.list') {
        expect(operation.lifecycles).toEqual(['pending', 'waiting_for_capacity', 'admitting', 'running', 'waiting_for_approval', 'needs_attention', 'cancel_requested', 'outcome_uncertain']);
      }
      return await kit.execute(operation, options);
    });
    const reconcileInvocation = vi.fn(async () => ({ kind: 'cancelled' as const, code: 'provider_stopped' }));
    const recover = createWorkflowRunRecoveryReader({
      accountId, machineId, storage: { execute },
      resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      reconcileInvocation,
    });

    await recover('reconnect');

    expect(reconcileInvocation).toHaveBeenCalledWith(expect.objectContaining({
      run: expect.objectContaining({ id: run.id, state: run.state, revision: run.revision }),
      index,
      progress,
      terminalParent: true,
      cancellationRequested: true,
      parentAttempt: 2,
      trigger: 'reconnect',
    }));
    const exactReads = execute.mock.calls.filter(([operation]) => operation.operation === 'invocations.get');
    expect(exactReads.length).toBeGreaterThan(0);
    expect(exactReads.every(([operation]) => operation.runId === runId
      && (operation.invocationId === rootId || operation.invocationId === invocationId))).toBe(true);
    expect(execute.mock.calls.some(([operation]) => operation.operation === 'invocations.list' && operation.cursor !== undefined)).toBe(true);
    const settledIndex = kit.rowById(invocationId)!.index;
    expect(settledIndex).toMatchObject({ lifecycle: 'cancelled', contentRevision: (BigInt(index.contentRevision) + 1n).toString() });
    expect(kit.rowById(completedId)?.index).toMatchObject({ lifecycle: 'completed', contentRevision: '0' });
    expect(kit.run()).toMatchObject({ state: 'cancelled', revision: run.revision + 1, workflowCustodyState: 'settled' });
    expect(execute.mock.calls.some(([operation]) => operation.operation === 'invocations.fact'
      && operation.runId === runId && operation.parentAttempt === 2
      && isPlainAccountCurrentness(operation.accountCurrentness)
      && operation.invocationId === invocationId && operation.invocationAttempt === '0'
      && operation.expectedContentRevision === index.contentRevision
      && operation.expectedLifecycle === 'cancel_requested' && operation.lifecycle === 'cancelled')).toBe(true);
    expect(execute.mock.calls.some(([operation]) => operation.operation === 'transition'
      && operation.runId === runId && operation.parentAttempt === 2
      && isPlainAccountCurrentness(operation.accountCurrentness)
      && operation.expectedRevision === run.revision && operation.state === 'cancelled'
      && operation.custodyState === 'settled'
      && Array.isArray(operation.invocationTransitions)
      && operation.invocationTransitions.some((transition: Readonly<Record<string, unknown>>) => transition.id === invocationId
        && transition.expectedLifecycle === 'cancelled' && transition.lifecycle === 'cancelled'
        && transition.expectedContentRevision === settledIndex.contentRevision))).toBe(true);
    expect(execute.mock.calls.some(([operation]) => operation.operation === 'initialize' || operation.operation === 'invocations.admit')).toBe(false);
  });

  it('rejoins a concurrently settled terminal Run after a custody response loss', async () => {
    const run = { sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null, id: runId, origin: { kind: 'direct' as const, originSessionId: 'session-origin' }, state: 'succeeded' as const,
      attentionRequired: false, failureUnseen: false, invocationAttentionRequired: false, attentionSeenFailureAt: null, finishedAt: null,
      revision: 9, machineId, workflowCustodyState: 'pending' as const, originDeliveryAckRevision: 0,
      availability, createdAt: now, updatedAt: now };
    let settled = false;
    const execute = vi.fn(async (operation: Readonly<Record<string, unknown>>) => {
      if (operation.operation === 'recovery.list') return { candidates: [{ run, parentAttempt: 3 }] };
      if (operation.operation === 'run-key.census') return createPlainWorkflowRunKeyCensusFixture({ runId, accountId });
      if (operation.operation === 'invocations.list') return { invocations: [], parentRevision: 9 };
      if (operation.operation === 'get') return { run: settled
        ? { ...run, revision: 10, workflowCustodyState: 'settled' } : run, checkpointEnvelope: checkpointEnvelope() };
      if (operation.operation === 'transition') { settled = true; throw new Error('response_lost'); }
      throw new Error(`unexpected:${String(operation.operation)}`);
    });
    const recover = createWorkflowRunRecoveryReader({
      accountId, machineId, storage: { execute },
      resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      reconcileInvocation: vi.fn(async () => ({ kind: 'unresolved' as const })),
    });
    await expect(recover('reconnect')).resolves.toBeUndefined();
    expect(execute.mock.calls.filter(([operation]) => operation.operation === 'transition')).toHaveLength(1);
    expect(execute.mock.calls.some(([operation]) => operation.operation === 'initialize')).toBe(false);
  });

  it('reconciles a terminal structural row without native observation or rewriting its truth', async () => {
    const invocationId = '2aaf1a39-4c48-4904-83a4-7eae318dfc2c';
    const run = { sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null, id: runId, origin: { kind: 'automation' as const, automationId: 'automation-1' }, state: 'outcome_uncertain' as const,
      attentionRequired: false, failureUnseen: false, invocationAttentionRequired: false, attentionSeenFailureAt: null, finishedAt: null,
      revision: 6, machineId, workflowCustodyState: 'pending' as const, originDeliveryAckRevision: null,
      availability, createdAt: now, updatedAt: now };
    const index = { id: invocationId, runId, sequence: '7', parentRecordId: null, memberOrdinal: '0', attempt: '0',
      contentRevision: '0', lifecycle: 'outcome_uncertain' as const, createdAt: now, updatedAt: now };
    const progress = { kind: 'happier.workflow-progress.v1' as const, invocationPath: { blockId: '$root', scope: [] }, blockKind: 'root' as const,
      attempt: '0', logicalInvocationRecordId: invocationId,
      result: { retained: true }, reason: { code: 'delivery_ambiguous' } };
    const contentEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: invocationId,
        sequence: '7', parentRecordId: null, memberOrdinal: '0', attempt: '0' }, progress,
    }));
    const execute = vi.fn(async (operation: Readonly<Record<string, unknown>>) => {
      if (operation.operation === 'recovery.list') return { candidates: [{ run, parentAttempt: 4 }] };
      if (operation.operation === 'run-key.census') return createPlainWorkflowRunKeyCensusFixture({ runId, accountId });
      if (operation.operation === 'invocations.list') return { invocations: [index], parentRevision: 6 };
      if (operation.operation === 'invocations.get') return { invocation: { index, contentEnvelope, parentRevision: 6 } };
      if (operation.operation === 'invocations.fact') return { ...index, lifecycle: operation.lifecycle };
      if (operation.operation === 'get') return { run, acceptedEnvelope: directAcceptedEnvelope(), checkpointEnvelope: checkpointEnvelope(), resultEnvelope: null };
      if (operation.operation === 'transition') return { ...run, revision: 7, workflowCustodyState: 'settled' };
      throw new Error(`unexpected:${String(operation.operation)}`);
    });
    const reconcileInvocation = vi.fn(async () => ({ kind: 'unresolved' as const }));
    const recover = createWorkflowRunRecoveryReader({
      accountId, machineId, storage: { execute },
      resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      reconcileInvocation,
    });

    await recover('startup');

    const fact = execute.mock.calls.find(([operation]) => operation.operation === 'invocations.fact')?.[0];
    expect(fact).toEqual(expect.objectContaining({
      expectedLifecycle: 'outcome_uncertain', lifecycle: 'outcome_uncertain', invocationAttempt: '0',
    }));
    const reopened = parseWorkflowStoredContentEnvelopeV1(fact?.contentEnvelope);
    const learned = reopened && openWorkflowProgressStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: invocationId,
        sequence: '7', parentRecordId: null, memberOrdinal: '0', attempt: '0' }, envelope: reopened,
    });
    expect(learned?.kind === 'available' ? learned.content : null).toEqual(progress);
    expect(reconcileInvocation).not.toHaveBeenCalled();
    expect(execute.mock.calls.some(([operation]) => operation.operation === 'transition'
      && Array.isArray(operation.invocationTransitions)
      && operation.invocationTransitions.some((transition: Readonly<Record<string, unknown>>) => transition.id === invocationId
        && transition.expectedLifecycle === 'outcome_uncertain' && transition.lifecycle === 'outcome_uncertain'))).toBe(true);
  });

  it('marks an uncertain step retryable only after its exact execution owner proves it stopped', async () => {
    const invocationId = '5aaf1a39-4c48-4904-83a4-7eae318dfc2c';
    const run = { sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null, id: runId, origin: { kind: 'direct' as const }, state: 'interrupted' as const,
      attentionRequired: false, failureUnseen: false, invocationAttentionRequired: false, attentionSeenFailureAt: null, finishedAt: null,
      revision: 6, machineId, workflowCustodyState: 'pending' as const, originDeliveryAckRevision: null,
      availability, createdAt: now, updatedAt: now };
    const index = { id: invocationId, runId, sequence: '7', parentRecordId: null, memberOrdinal: '0', attempt: '0',
      contentRevision: '0', lifecycle: 'outcome_uncertain' as const, createdAt: now, updatedAt: now };
    const progress = { kind: 'happier.workflow-progress.v1' as const, invocationPath: { blockId: 'work', scope: [] }, blockKind: 'step' as const,
      attempt: '0', logicalInvocationRecordId: invocationId,
      execution: { kind: 'session' as const, sessionId: 'session-1', localInputId: 'input-1' } };
    const contentEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: invocationId,
        sequence: '7', parentRecordId: null, memberOrdinal: '0', attempt: '0' }, progress,
    }));
    const execute = vi.fn(async (operation: Readonly<Record<string, unknown>>) => {
      if (operation.operation === 'recovery.list') return { candidates: [{ run, parentAttempt: 4 }] };
      if (operation.operation === 'run-key.census') return createPlainWorkflowRunKeyCensusFixture({ runId, accountId });
      if (operation.operation === 'invocations.list') return { invocations: [index], parentRevision: 6 };
      if (operation.operation === 'invocations.get') return { invocation: { index, contentEnvelope, parentRevision: 6 } };
      if (operation.operation === 'invocations.fact') return { ...index, lifecycle: operation.lifecycle };
      if (operation.operation === 'get') return { run, acceptedEnvelope: directAcceptedEnvelope(), checkpointEnvelope: checkpointEnvelope(), resultEnvelope: null };
      throw new Error(`unexpected:${String(operation.operation)}`);
    });
    const recover = createWorkflowRunRecoveryReader({
      accountId, machineId, storage: { execute },
      resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      reconcileInvocation: vi.fn(async () => ({ kind: 'cancelled' as const, code: 'observed_stopped' })),
    });

    await recover('reconnect');

    const fact = execute.mock.calls.find(([operation]) => operation.operation === 'invocations.fact')?.[0];
    expect(fact).toMatchObject({
      expectedLifecycle: 'outcome_uncertain', lifecycle: 'needs_attention', resolution: 'observed_terminal_execution',
    });
    const reopened = parseWorkflowStoredContentEnvelopeV1(fact?.contentEnvelope);
    const resolved = reopened && openWorkflowProgressStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: invocationId,
        sequence: '7', parentRecordId: null, memberOrdinal: '0', attempt: '0' }, envelope: reopened,
    });
    expect(resolved?.kind === 'available' ? resolved.content : null).toMatchObject({
      uncertainPriorEffects: { activity: 'stopped' }, reason: { code: 'observed_stopped' },
    });
  });

  it('settles a running cancellation through structural and executable row facts before parent custody', async () => {
    const rootId = '2aaf1a39-4c48-4904-83a4-7eae318dfc2c';
    const childId = '5ebde945-7386-438c-9bc0-12f1f7c76e76';
    const run = { sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null, id: runId, origin: { kind: 'automation' as const, automationId: 'automation-1' }, state: 'running' as const,
      attentionRequired: false, failureUnseen: false, invocationAttentionRequired: false, attentionSeenFailureAt: null, finishedAt: null,
      revision: 8, machineId, workflowCustodyState: 'pending' as const, originDeliveryAckRevision: null,
      availability, createdAt: now, updatedAt: now };
    const indexes = [
      { id: rootId, runId, sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0', contentRevision: '0', lifecycle: 'cancel_requested' as const, createdAt: now, updatedAt: now },
      { id: childId, runId, sequence: '1', parentRecordId: rootId, memberOrdinal: '0', attempt: '0', contentRevision: '0', lifecycle: 'cancel_requested' as const, createdAt: now, updatedAt: now },
    ];
    const progresses = [
      { kind: 'happier.workflow-progress.v1' as const, invocationPath: { blockId: '$root', scope: [] }, blockKind: 'root' as const,
        attempt: '0', logicalInvocationRecordId: rootId, timing: { startedAt: now } },
      { kind: 'happier.workflow-progress.v1' as const, invocationPath: { blockId: 'step', scope: [] }, blockKind: 'step' as const,
        attempt: '0', logicalInvocationRecordId: childId,
        execution: { kind: 'session' as const, sessionId: 'session-1', localInputId: 'input-1' } },
    ];
    const envelopes = indexes.map((index, ordinal) => serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: index.id,
        sequence: index.sequence, parentRecordId: index.parentRecordId, memberOrdinal: '0', attempt: '0' }, progress: progresses[ordinal]!,
    })));
    const lifecycleById = new Map<string, string>(indexes.map((index) => [index.id, index.lifecycle]));
    const execute = vi.fn(async (operation: Readonly<Record<string, unknown>>) => {
      if (operation.operation === 'recovery.list') return { candidates: [{ run, parentAttempt: 5 }] };
      if (operation.operation === 'run-key.census') return createPlainWorkflowRunKeyCensusFixture({ runId, accountId });
      if (operation.operation === 'invocations.list') return { invocations: indexes };
      if (operation.operation === 'invocations.get') {
        const ordinal = indexes.findIndex((index) => index.id === operation.invocationId);
        const index = indexes[ordinal]!;
        return { invocation: { index: { ...index, lifecycle: lifecycleById.get(index.id) }, contentEnvelope: envelopes[ordinal] } };
      }
      if (operation.operation === 'invocations.fact') {
        lifecycleById.set(String(operation.invocationId), String(operation.lifecycle));
        return { lifecycle: operation.lifecycle };
      }
      if (operation.operation === 'get') return { run, acceptedEnvelope: directAcceptedEnvelope(), checkpointEnvelope: checkpointEnvelope() };
      if (operation.operation === 'transition') return { ...run, state: 'cancelled', workflowCustodyState: 'settled' };
      throw new Error(`unexpected:${String(operation.operation)}`);
    });
    const reconcileInvocation = vi.fn(async () => ({ kind: 'completed' as const, result: 'completed-before-stop' }));
    const recover = createWorkflowRunRecoveryReader({
      accountId, machineId, storage: { execute },
      resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      reconcileInvocation,
    });

    await recover('control');

    const rootFact = execute.mock.calls.find(([operation]) => operation.operation === 'invocations.fact'
      && operation.invocationId === rootId)?.[0];
    const openedRoot = openWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: rootId,
        sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' },
      envelope: parseWorkflowStoredContentEnvelopeV1(rootFact?.contentEnvelope) });
    expect(openedRoot.kind).toBe('available');
    if (openedRoot.kind !== 'available') throw new Error('fixture_invocation_unavailable');
    expect(openedRoot.content.timing).toEqual({ startedAt: now, finishedAt: expect.any(String) });
    expect(reconcileInvocation).toHaveBeenCalledTimes(1);
    expect(reconcileInvocation).toHaveBeenCalledWith(expect.objectContaining({
      trigger: 'control',
      cancellationRequested: true,
    }));
    expect(execute.mock.calls.some(([operation]) => operation.operation === 'invocations.fact'
      && operation.invocationId === rootId && operation.expectedLifecycle === 'cancel_requested' && operation.lifecycle === 'cancelled')).toBe(true);
    expect(execute.mock.calls.some(([operation]) => operation.operation === 'invocations.fact'
      && operation.invocationId === childId && operation.expectedLifecycle === 'cancel_requested' && operation.lifecycle === 'completed')).toBe(true);
    expect(execute.mock.calls.some(([operation]) => operation.operation === 'transition'
      && operation.state === 'cancelled' && operation.custodyState === 'settled'
      && Array.isArray(operation.invocationTransitions) && operation.invocationTransitions.length === 2)).toBe(true);
  });
});
