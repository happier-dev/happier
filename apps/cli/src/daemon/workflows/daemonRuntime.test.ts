import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios, { AxiosHeaders } from 'axios';
import { API_TOKEN_FULL_GRANT_V1, freezeActionCompletionContractV1, getActionSpec,
  sealWorkflowAcceptedSnapshotStoredEnvelopeV1, sealWorkflowCheckpointStoredEnvelopeV1,
  sealWorkflowProgressStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1,
  parseWorkflowStoredContentEnvelopeV1, openWorkflowProgressStoredEnvelopeV1,
  type AccountApiTokensListActionOutputV1, type WorkflowDefinitionV1 } from '@happier-dev/protocol';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES, RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { bindApiSessionSocketMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { publishServerHttpRuntimeOrigin } from '@/api/client/serverHttpBaseUrl';
import { configuration } from '@/configuration';
import { seedTestServerProfile } from '@/testkit/serverProfiles';
import { createSessionNotificationContextFixture, createSessionRecordFixture, createCompactSessionListRowFixture } from '@/testkit/backends/sessionFixtures';
import { buildSessionCreationCorrespondence } from '@/session/shared/sessionCreationCorrespondence';
import { deriveWorkflowSessionInputLocalIdV2 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { SessionMessageReplyCapabilityV1Schema, SessionMessageReplyReadResultV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import { createWorkflowRunStorageTestkit, type WorkflowRunStorageTestkitOperation } from './workflowRunStorage.testkit';
import { tmpdir } from 'node:os';
import nacl from 'tweetnacl';
import { AccountSettingsSchema, ResolvedRoleV1Schema, HomeConnectionDescriptorV1Schema, FeaturesResponseSchema, ManagedMachineV1Schema, ExternalActionExecutionAuthorizationRequestV1Schema,
  computeExternalActionRequestEnvelopeDigestV1, StrictJsonValueSchema, zodSchemaToJsonSchemaObject } from '@happier-dev/protocol';
import { updateSettings, writeStoredCredentialsForServerId } from '@/persistence';
import { createDaemonManagedMachineActionAdapter } from '@/daemon/startup/managedMachineActionAdapter';
import { createCurrentMachineExecutionOriginContextResolver } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import * as machineRpc from '@/session/transport/rpc/machineRpc';
import { fixture as nativeFixture } from '@/plugins/runtime/invocation/actions/managedCustody.testkit';
import { createManagedProviderOperationAuthority } from '@/daemon/connectedServices/purposeBindings/managedProviderOperationAuthority';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createConnectedAccountRequestAuthSubjectRegistry } from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { commitActivePromptLibraryCatalog, getActiveAccountSettingsSnapshotLifetimeToken,
  resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { bootstrapAccountSettingsContext, resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { loadPromptLibraryCatalogV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { PROMPT_LIBRARY_ROWS_ROUTE_V1, PromptLibraryRowsListResponseV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { publishSessionControlsMetadataBestEffort } from '@/agent/runtime/controls/publishSessionControlsMetadataBestEffort';
import type { Metadata } from '@/api/types';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1 } from '@happier-dev/protocol/auth/accountApiTokens';
import { createRequesterSessionControlRuntimeFixture } from '@/daemon/testkit/requesterSessionControlRuntimeFixture';
import { ConnectedServiceRuntimeRegistry } from '@/daemon/connectedServices/runtimeRegistry/registry';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { join } from 'node:path';
import { logger } from '@/ui/logger';
import { createProductionWorkflowConversationOwner } from './sessionStepExecutor';
import { materializeWorkflowAcceptedSnapshotV1 } from '@happier-dev/protocol/workflows/materializeWorkflowAcceptedSnapshotV1';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';

// Physical daemon HTTP binding is an OS boundary; the startup/ingress composition stays real.
vi.mock('@/daemon/controlServer', () => ({ startDaemonControlServer: async () => ({ port: 44322, stop: async () => {} }) }));

const mocks = vi.hoisted(() => ({
  fetchSessionById: vi.fn(),
  lookupSessionsByTags: vi.fn<typeof import('@/session/transport/http/sessionsHttp')['lookupSessionsByTags']>(),
  fetchAccountEncryptionCurrentness: vi.fn(),
  callSessionRpc: vi.fn(),
  io: vi.fn(),
}));

// HTTP responses are the system boundary; resolution, opening and owner
// metadata projection beneath these adapters remain real.
vi.mock('@/session/transport/http/sessionsHttp', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>(),
  fetchSessionById: mocks.fetchSessionById,
  lookupSessionsByTags: mocks.lookupSessionsByTags,
}));
vi.mock('@/api/client/connectedServiceCredentialApi', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/api/client/connectedServiceCredentialApi')>(),
  fetchAccountEncryptionCurrentness: mocks.fetchAccountEncryptionCurrentness,
}));
vi.mock('@/session/transport/rpc/sessionRpc', () => ({ callSessionRpc: mocks.callSessionRpc }));
vi.mock('socket.io-client', () => ({ io: mocks.io }));

import {
  createWorkflowAcceptedAuthorizationCurrentness,
  createCredentialedWorkflowAcceptedAuthorizationCurrentness,
  createWorkflowInvocationRecoveryObserver,
  resolveWorkflowSessionConversation,
  withdrawWorkflowOriginSessionInput,
  cancelDispatchedWorkflowOriginSessionInput,
  createProductionDaemonWorkflowRuntime,
} from './daemonRuntime';

// The daemon's singleton controller has one process lifetime, shared by the
// production-composition cases in this file; shutdown is terminal.
afterAll(async () => { await pluginReloadController.shutdown(); });

describe('production daemon retained operation target', () => {
  let releaseHome = () => {};
  afterEach(() => { releaseHome(); vi.restoreAllMocks(); vi.useRealTimers(); });

  it.each(['exact', 'local-only', 'pending', 'foreign-account', 'foreign-machine', 'absent', 'stored-absent', 'already-uncertain', 'cancel-requested-parent', 'cancelled-root-parent',
    'session-discovered', 'stored-session', 'stored-inputless-session', 'session-mismatch', 'lookup-unavailable',
    'pending-success', 'stored-pending-success', 'already-stopped-success', 'pending-failure', 'miswired-success', 'foreign-session-success', 'stop-unconfirmed'] as const)
  ('recovers cancelled startup from its %s original owner through fresh production recovery wiring', async match => {
    const accountId = 'account-1';
    const machineId = 'original-worker';
    const late = ['pending-success', 'stored-pending-success', 'already-stopped-success', 'pending-failure', 'miswired-success', 'foreign-session-success', 'stop-unconfirmed'].includes(match);
    const runId = '7be4d65c-d3b7-4868-a416-b18d9ee29c1c';
    const rootId = '2aaf1a39-4c48-4904-83a4-7eae318dfc2c';
    const childId = '33333333-3333-4333-8333-333333333333';
    const home = 'http://127.0.0.1:43187';
    releaseHome = publishServerHttpRuntimeOrigin(home, 'https');
    mocks.fetchAccountEncryptionCurrentness.mockResolvedValue({ mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
    const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {}, blocks: [
      { kind: 'step', id: 'launch', document: { text: 'launch', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
    ] };
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: {
        startedBy: 'user', definition, authoredDefinition: definition, workDepth: 0, metadata: null, frozenChildren: {}, materializedLeaves: [],
        source: { kind: 'inline' }, inputs: {}, machineId, executionTarget: { kind: 'session' },
        workspaceTarget: { project: { machineId, directory: '/repo', checkoutRootPath: '/repo' }, originalCommittedRevision: 'a'.repeat(40) },
        origin: { kind: 'direct' }, authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      } }));
    const checkpointEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'checkpoint', accountId, runId }, checkpoint: { kind: 'happier.workflow-checkpoint.v1',
        rootRecordId: rootId, nextSequence: '2', frontier: { nextBlockOrdinal: 0, paused: false } } }));
    const creationKey = `workflow:${runId}:${childId}`;
    const localId = deriveWorkflowSessionInputLocalIdV2({ purpose: 'invocation', runId, invocationRecordId: childId });
    const correspondence = buildSessionCreationCorrespondence({
      identity: { callerCreationNamespace: JSON.stringify(['workflow', 'home', runId]),
        creationKey: match === 'foreign-session-success' ? 'another-startup' : creationKey },
      recipe: { execution: { machineId, directory: { kind: 'path', path: '/repo' } },
        organization: { folderId: null, tagIds: [] }, agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
    });
    let session = createSessionRecordFixture({ id: 'c111111111111111111111111', encryptionMode: 'plain',
      active: late && match !== 'already-stopped-success',
      metadata: JSON.stringify({ machineId, path: '/repo', sessionCreationCorrespondenceV1: match === 'session-mismatch'
        ? { ...correspondence, sessionCreationTag: 'create:v1:' + 'x'.repeat(43) } : correspondence }) });
    // The canonical Stop owner now persists its existing explicit-stop intent
    // before physical termination. Only its HTTP persistence boundary is fake.
    vi.spyOn(axios, 'patch').mockImplementation(async (url, body: unknown) => {
      if (!String(url).endsWith(`/v2/sessions/${session.id}`) || !body || typeof body !== 'object'
        || !('metadata' in body) || !body.metadata || typeof body.metadata !== 'object'
        || !('ciphertext' in body.metadata) || typeof body.metadata.ciphertext !== 'string'
        || !('expectedVersion' in body.metadata) || body.metadata.expectedVersion !== session.metadataVersion) {
        throw new Error('Unexpected Session Stop metadata persistence');
      }
      session = { ...session, metadata: body.metadata.ciphertext, metadataVersion: session.metadataVersion + 1 };
      return { status: 200, data: { success: true, metadata: { version: session.metadataVersion } } };
    });
    mocks.lookupSessionsByTags.mockImplementation(async ({ tags }) => match === 'lookup-unavailable'
      ? { state: 'unavailable' } : { state: 'available', tags,
        sessions: match === 'session-discovered' || match === 'stored-session' || match === 'stored-inputless-session' || match === 'session-mismatch' ? [session] : [] });
    mocks.fetchSessionById.mockImplementation(async () => session);
    const stops: string[] = [];
    const discardedInputs: string[] = [];
    vi.spyOn(machineRpc, 'callMachineRpc').mockImplementation(async ({ machineId: targetMachine, method, request }) => {
      if (targetMachine !== machineId || method !== RPC_METHODS.STOP_SESSION
        || !request || typeof request !== 'object' || !('sessionId' in request) || request.sessionId !== session.id) {
        throw new Error('Wrong startup Session Stop wiring');
      }
      expect(discardedInputs).toContain(localId);
      stops.push(session.id);
      if (match === 'stop-unconfirmed') return { status: 'requested' };
      if (match === 'already-stopped-success' || match === 'stored-inputless-session') return { status: 'not_found' };
      session = { ...session, active: false };
      return { status: 'stopped' };
    });
    const seal = (id: string, root: boolean) => serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: id,
        sequence: root ? '0' : '1', parentRecordId: root ? null : rootId, memberOrdinal: '0', attempt: '0' },
      progress: { kind: 'happier.workflow-progress.v1', blockKind: root ? 'root' : 'step',
        invocationPath: { blockId: root ? '$root' : 'launch', scope: [] }, attempt: '0', logicalInvocationRecordId: id,
        ...(!root && (match === 'stored-absent' || match === 'stored-session' || match === 'stored-inputless-session' || match === 'stored-pending-success') ? { execution: { kind: 'action' as const, actionId: 'session.spawn_new',
          actionRequestId: creationKey, localInputId: creationKey, input: { creationKey }, output: {},
          awaitedOperations: [{ key: 'startup', serverId: 'home', machineId,
            operationId: match === 'stored-pending-success' ? 'original-startup' : 'lost-startup' }] } } : {}) },
    }));
    const storage = createWorkflowRunStorageTestkit({ accountId, runId, machineId, origin: { kind: 'direct' }, acceptedEnvelope });
    await storage.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope,
      rootInvocation: { id: rootId, contentEnvelope: seal(rootId, true) } });
    await storage.execute({ operation: 'invocations.admit', runId, expectedRevision: 1, checkpointEnvelope,
      invocations: [{ id: childId, sequence: '1', parentRecordId: rootId, memberOrdinal: '0',
        lifecycle: match === 'already-uncertain' ? 'outcome_uncertain' : 'pending', contentEnvelope: seal(childId, false) }] });
    const operations = createHostActionOperationRuntime({ machineId: match === 'foreign-machine' ? 'foreign-worker' : machineId,
      resolveAccountId: async () => match === 'foreign-account' ? 'foreign-account' : accountId,
      generateOperationId: () => 'original-startup' });
    let finishStartup = () => {};
    let startup: ReturnType<typeof operations.observeExecution> | undefined;
    let acknowledgeStartup = () => {};
    const startupAccepted = new Promise<void>(resolve => { acknowledgeStartup = resolve; });
    if (late || ['exact', 'local-only', 'pending', 'foreign-account', 'foreign-machine'].includes(match)) {
      startup = operations.observeExecution({ actionId: 'session.spawn_new',
        input: { creationKey }, execute: async context => {
          if (match === 'pending' || late) {
            context.operationAcceptance?.accept({});
            await new Promise<void>(resolve => { finishStartup = resolve; acknowledgeStartup(); });
          }
          return late && match !== 'pending-failure' ? { ok: true, result: { sessionId: session.id } }
            : { ok: false, errorCode: 'DAEMON_RPC_UNAVAILABLE', error: 'Requester Session custody unavailable' };
        } });
      // The keyed spawn caller waits for native startup's terminal result.
      // Recovery observes the admitted operation while that caller is pending.
      if (match === 'pending' || late) {
        await startupAccepted;
        expect(await operations.handlers.getV2({ operationId: 'original-startup' })).toMatchObject({
          kind: 'found', operation: { operationId: 'original-startup', state: 'running' },
        });
      } else await startup;
    }
    storage.requestControl('cancel_requested');
    if (match === 'cancelled-root-parent') {
      // Retained QA-FIN37: a cancelled root survived while the parent was reclaimed.
      const root = storage.rowById(rootId)!;
      await storage.execute({ operation: 'invocations.fact', runId, parentAttempt: 0,
        accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null },
        invocationId: rootId, invocationAttempt: '0', expectedLifecycle: 'cancel_requested',
        expectedContentRevision: root.index.contentRevision, lifecycle: 'cancelled', contentEnvelope: root.contentEnvelope });
    }
    if (match !== 'cancel-requested-parent' && !late) await storage.execute({ operation: 'transition', runId,
      expectedRevision: storage.run().revision, state: match === 'cancelled-root-parent' ? 'claimed' : 'cancelled', checkpointEnvelope });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body: unknown) => {
      if (new URL(String(url)).pathname === `/v2/sessions/${session.id}/pending/${encodeURIComponent(localId)}/discard`) {
        expect(body).toEqual({ reason: 'session_input_cancelled' });
        discardedInputs.push(localId);
        return { status: 200, data: { ok: true } };
      }
      if (!String(url).endsWith('/v3/automations/runs/workflow-storage') || !body || typeof body !== 'object' || !('operation' in body)) throw new Error('Unexpected Home write');
      return { status: 200, data: body.operation === 'recovery.list'
        ? { candidates: [{ run: storage.run(), parentAttempt: 0 }] }
        : await storage.execute(body as WorkflowRunStorageTestkitOperation) };
    });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (new URL(url).pathname === `/v2/sessions/${session.id}`) {
        return { status: 200, data: { session } };
      }
      if (new URL(url).pathname === `/v2/sessions/${session.id}/messages/by-local-id/${encodeURIComponent(localId)}/reply`) {
        return { status: 200, data: SessionMessageReplyReadResultV1Schema.parse(match === 'stored-inputless-session'
          ? { v: 1, status: 'none' }
          : { v: 1, status: 'available', progress: { v: 1, mode: 'wait', disposition: 'observing',
            acceptedTurnId: 'original-turn', outcome: { kind: 'answer', result: { sessionId: session.id, messageId: 'reply' } } } }) };
      }
      if (url.includes('/messages/by-local-id/') && match === 'stored-inputless-session') return { status: 200, data: { message: null } };
      if (url.includes('/messages/by-local-id/')) return { status: 200, data: { message: {
        id: 'input', seq: 1, localId, createdAt: 1, updatedAt: 1,
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'launch' } } },
      } } };
      if (url.endsWith('/turns')) return { status: 200, data: { v: 1, sessionId: session.id, updatedAt: 3,
        turns: [{ turnId: 'original-turn', status: 'completed', startedAt: 1, updatedAt: 3,
          transcriptAnchors: { startUserMessageSeq: 1, userMessageSeqs: [1], startSeqInclusive: 1,
            endSeqInclusive: 2, finalAssistantMessageSeq: 2 } }] } };
      if (url.includes('/messages?')) return { status: 200, data: { messages: [{ id: 'reply', seq: 2,
        localId: null, createdAt: 2, updatedAt: 2, content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'original result' } } } }] } };
      if (url.endsWith('/pending')) return { status: 200, data: { pending: [], version: 0 } };
      return { status: 200, data: { machine: { id: machineId,
        storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } } };
    });
    const methods: string[] = [];
    const invoke = async (method: string, request: unknown) => {
      methods.push(method);
      if (method.endsWith('actionOperation.list.v2')) return await operations.handlers.listV2(request);
      if (method.endsWith('actionOperation.get.v2')) return match === 'miswired-success'
        ? { kind: 'found', operation: { ...operations.store.list({ accountId, machineId }).items[0], operationId: 'wrong-startup' } }
        : await operations.handlers.getV2(request);
      if (method.endsWith('actionOperation.cancel.v1')) return await operations.handlers.cancel(request);
      throw new Error(`Recovery must not launch or replay work: ${method}`);
    };
    bindApiSessionSocketMock(mocks.io, createApiSessionSocketStub({ async emitWithAck(event, payload) {
      // A same-daemon terminal operation remains observable through its
      // installed transport when the Home socket cannot deliver another RPC.
      if (match === 'local-only') throw Object.assign(new Error('Home RPC unavailable'), { code: 'ECONNABORTED' });
      if (event !== SOCKET_RPC_EVENTS.CALL || !payload || typeof payload !== 'object' || !('method' in payload)
        || typeof payload.method !== 'string' || !('params' in payload)) throw new Error('Unexpected RPC');
      return { ok: true, result: await invoke(payload.method, payload.params) };
    } }));
    const runtime = createProductionDaemonWorkflowRuntime({ credentials: { token: 'token', encryption: null }, accountId, serverId: 'home' });
    const controller = new AbortController();
    try {
      const recover = runtime.createRecoveryForMachine({ machineId, machineAdmissionTransport: async () => { throw new Error('No new input'); },
        machineActionDirectTargetTransport: { machineId, invoke } });
      await recover('startup', controller.signal);
      if (late) {
        expect(storage.rowById(childId)?.index.lifecycle).toBe('cancel_requested');
        expect(storage.run().workflowCustodyState).toBe('pending');
        expect(stops).toEqual([]);
        finishStartup();
        await operations.handlers.getV2({ operationId: 'original-startup', waitForTerminal: true });
        if (match === 'pending-success' || match === 'stored-pending-success' || match === 'already-stopped-success' || match === 'pending-failure') {
          // The production completion wait must wake recovery without another control/hint.
          await expect.poll(() => storage.run().workflowCustodyState).toBe('settled');
          expect(storage.run().state).toBe('cancelled');
          expect(storage.rowById(childId)?.index.lifecycle).toBe(match === 'pending-failure' ? 'failed' : 'cancelled');
          expect([...new Set(stops)]).toEqual(match === 'pending-failure' ? [] : [session.id]);
          if (match !== 'pending-failure') {
            expect(session.active).toBe(false);
            const row = storage.rowById(childId)!;
            const opened = openWorkflowProgressStoredEnvelopeV1({ mode: 'plain', binding: {
              v: 1, purpose: 'invocation_progress', accountId, runId, recordId: childId,
              sequence: '1', parentRecordId: rootId, memberOrdinal: '0', attempt: '0',
            }, envelope: parseWorkflowStoredContentEnvelopeV1(row.contentEnvelope)! });
            expect(opened.kind === 'available' ? opened.content : null).toMatchObject({
              execution: { kind: 'session_ready', sessionId: session.id }, reason: { code: 'workflow_startup_session_stopped' } });
          }
        } else {
          if (match === 'stop-unconfirmed') await expect.poll(() => stops.length).toBeGreaterThan(0);
          else await recover('control', controller.signal);
          expect(storage.run().workflowCustodyState).toBe('pending');
          expect(storage.rowById(childId)?.index.lifecycle).toBe('cancel_requested');
          expect(session.active).toBe(true);
          expect([...new Set(stops)]).toEqual(match === 'stop-unconfirmed' ? [session.id] : []);
        }
        return;
      }
      const settled = ['exact', 'local-only', 'absent', 'stored-absent', 'already-uncertain', 'cancel-requested-parent', 'cancelled-root-parent', 'session-discovered', 'stored-session', 'stored-inputless-session'].includes(match);
      expect(storage.run().state).toBe('cancelled');
      expect(storage.run().workflowCustodyState).toBe(settled ? 'settled' : 'pending');
      expect(storage.rowById(childId)?.index.lifecycle).toBe(match === 'exact' || match === 'local-only' ? 'failed'
        : ['absent', 'stored-absent', 'already-uncertain', 'cancel-requested-parent', 'cancelled-root-parent'].includes(match) ? 'outcome_uncertain'
        : match === 'session-discovered' || match === 'stored-session' ? 'completed'
        : match === 'stored-inputless-session' ? 'cancelled' : 'cancel_requested');
      if (match !== 'stored-absent' && match !== 'stored-session' && match !== 'stored-inputless-session') expect(methods).toContain('actionOperation.list.v2');
      if (match === 'stored-inputless-session') {
        expect(stops).toEqual([session.id]);
        expect(session.active).toBe(false);
        const row = storage.rowById(childId)!;
        const opened = openWorkflowProgressStoredEnvelopeV1({ mode: 'plain', binding: {
          v: 1, purpose: 'invocation_progress', accountId, runId, recordId: childId,
          sequence: '1', parentRecordId: rootId, memberOrdinal: '0', attempt: '0',
        }, envelope: parseWorkflowStoredContentEnvelopeV1(row.contentEnvelope)! });
        expect(opened.kind === 'available' ? opened.content : null).toMatchObject({
          execution: { kind: 'session_ready', sessionId: session.id }, reason: { code: 'workflow_startup_session_stopped' } });
      }
      if (match === 'session-discovered' || match === 'stored-session') {
        const row = storage.rowById(childId)!;
        const opened = openWorkflowProgressStoredEnvelopeV1({ mode: 'plain', binding: {
          v: 1, purpose: 'invocation_progress', accountId, runId, recordId: childId,
          sequence: '1', parentRecordId: rootId, memberOrdinal: '0', attempt: '0',
        }, envelope: parseWorkflowStoredContentEnvelopeV1(row.contentEnvelope)! });
        expect(opened.kind === 'available' ? opened.content : null).toMatchObject({
          execution: { kind: 'session', sessionId: session.id, localInputId: localId }, result: 'original result' });
      }
    } finally { controller.abort(); finishStartup(); await startup; }
    if (match === 'exact' || match === 'local-only') {
      const row = storage.rowById(childId)!;
      const opened = openWorkflowProgressStoredEnvelopeV1({ mode: 'plain', binding: {
        v: 1, purpose: 'invocation_progress', accountId, runId, recordId: childId,
        sequence: '1', parentRecordId: rootId, memberOrdinal: '0', attempt: '0',
      }, envelope: parseWorkflowStoredContentEnvelopeV1(row.contentEnvelope)! });
      expect(opened.kind === 'available' ? opened.content : null).toMatchObject({ execution: { kind: 'action',
        awaitedOperations: [{ operationId: 'original-startup', machineId }] }, reason: { code: 'DAEMON_RPC_UNAVAILABLE' } });
    }
  });

  it.each(['observation', 'Stop', 'native Stop', 'same Home observation', 'foreign Home observation', 'same Home Stop', 'foreign Home Stop'] as const)('keeps daemon retained %s on its original Machine after replacement', async phase => {
    const nativeStop = phase === 'native Stop';
    const stopping = phase.endsWith('Stop');
    const aliasedHome = phase.startsWith('same Home') || phase.startsWith('foreign Home');
    const foreignHome = phase.startsWith('foreign Home');
    const operationHome = aliasedHome ? foreignHome ? 'srv_other_operation' : 'srv_daemon_operation' : 'home';
    if (aliasedHome) await seedTestServerProfile({ id: 'operation-profile', homeId: 'srv_daemon_operation',
      serverUrl: 'http://127.0.0.1:43187' });
    const actionId = nativeStop ? 'review.start' : 'projects.script.run';
    const accountId = 'account-1';
    const machineId = 'original-worker';
    const runId = '7be4d65c-d3b7-4868-a416-b18d9ee29c1c';
    const rootId = '2aaf1a39-4c48-4904-83a4-7eae318dfc2c';
    const childId = '33333333-3333-4333-8333-333333333333';
    const home = 'http://127.0.0.1:43187';
    releaseHome = publishServerHttpRuntimeOrigin(home, 'https');
    mocks.fetchAccountEncryptionCurrentness.mockResolvedValue({ mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
    const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {}, blocks: [
      { kind: 'action', id: 'script', actionId, input: {} },
    ] };
    const completion = freezeActionCompletionContractV1(getActionSpec(actionId).completion!);
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: {
        startedBy: 'user', definition, authoredDefinition: definition, workDepth: 0, metadata: null, frozenChildren: {},
        materializedLeaves: [{ sourceKey: '$root', blockId: 'script', kind: 'action', actionId,
          selection: {}, executionTarget: { kind: 'session' }, authoredWorkspace: { kind: 'inherit' }, actionInput: {},
          actionContract: { inputSchema: {}, outputSchema: completion.terminalOutputSchema, completion } }],
        source: { kind: 'inline' }, inputs: {}, machineId, executionTarget: { kind: 'session' },
        workspaceTarget: { project: { machineId, directory: '/repo', checkoutRootPath: '/repo', workspaceRefId: 'workspace' },
          originalCommittedRevision: 'a'.repeat(40) }, origin: { kind: 'direct', originSessionId: 'session-origin' },
        authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
        resultDelivery: { kind: 'originating_session', originSessionId: 'session-origin' },
      } }));
    const checkpointEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'checkpoint', accountId, runId }, checkpoint: { kind: 'happier.workflow-checkpoint.v1',
        rootRecordId: rootId, nextSequence: '2', frontier: { nextBlockOrdinal: 0, paused: false } } }));
    const operation = { version: 1, operationId: 'finite', revision: 1, actionId: 'projects.script.run', state: 'running',
      scope: { accountId, machineId }, title: 'Script', createdAt: 1, startedAt: 2, cancellation: 'supported',
      domainRef: { kind: 'projectCommand', purpose: 'script', serverId: operationHome, machineId,
        workspaceRefId: 'workspace', cwd: '/repo' } };
    const seal = (id: string, root: boolean) => serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: id,
        sequence: root ? '0' : '1', parentRecordId: root ? null : rootId, memberOrdinal: '0', attempt: '0' },
      progress: { kind: 'happier.workflow-progress.v1', blockKind: root ? 'root' : 'action',
        invocationPath: { blockId: root ? '$root' : 'script', scope: [] }, attempt: '0', logicalInvocationRecordId: id,
        ...(root ? {} : { execution: { kind: 'action' as const, actionId, actionRequestId: 'original',
          localInputId: 'original', input: {}, ...(nativeStop
            ? { output: { intent: 'review', sessionId: null, results: [{ key: 'codex', ok: true, result: { runId: 'native-run' } }] },
                awaitedRuns: [{ key: 'codex', runId: 'native-run' }] }
            : { output: { operation }, awaitedOperations: [{ key: 'command', serverId: operationHome,
                machineId, operationId: operation.operationId }] }) } }) },
    }));
    const storage = createWorkflowRunStorageTestkit({ accountId, runId, machineId, origin: { kind: 'direct' }, acceptedEnvelope });
    await storage.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope,
      rootInvocation: { id: rootId, contentEnvelope: seal(rootId, true) } });
    await storage.execute({ operation: 'invocations.admit', runId, expectedRevision: 1, checkpointEnvelope,
      invocations: [{ id: childId, sequence: '1', parentRecordId: rootId, memberOrdinal: '0',
        lifecycle: stopping ? 'cancel_requested' : 'running', contentEnvelope: seal(childId, false) }] });
    await storage.execute({ operation: 'transition', runId, expectedRevision: 2, state: 'interrupted', checkpointEnvelope });
    // The server's opaque storage/HTTP and Socket.IO are the external boundaries.
    vi.spyOn(axios, 'post').mockImplementation(async (url, body: unknown) => {
      if (!String(url).endsWith('/v3/automations/runs/workflow-storage')) throw new Error(`Unexpected Home write: ${url}`);
      if (!body || typeof body !== 'object' || !('operation' in body) || typeof body.operation !== 'string') throw new Error('Invalid storage request');
      // The real storage client produced this external HTTP body; the canonical server testkit checks its operation/CAS.
      return { status: 200, data: body.operation === 'recovery.list'
        ? { candidates: [{ run: storage.run(), parentAttempt: 0 }] }
        : await storage.execute(body as WorkflowRunStorageTestkitOperation) };
    });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const target = new URL(String(url));
      if (target.origin !== home) throw new Error('Configured workflow endpoint is unreachable');
      const pathname = target.pathname;
      const data = pathname === '/v1/machines' ? [{ id: machineId, replacedByMachineId: 'successor' }, { id: 'successor' }]
        : { machine: { id: decodeURIComponent(pathname.slice('/v1/machines/'.length)),
          storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } };
      return { status: 200, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() }, data };
    });
    const requests: string[] = [];
    const unavailable = { ok: false, error: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE, errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE };
    if (nativeStop) vi.useFakeTimers();
    const recoverySocket = createApiSessionSocketStub({ async emitWithAck(event, payload) {
      if (event !== SOCKET_RPC_EVENTS.CALL || !payload || typeof payload !== 'object' || !('method' in payload)
        || typeof payload.method !== 'string') throw new Error('Unexpected RPC boundary');
      requests.push(payload.method);
      if (nativeStop && payload.method === `${machineId}:execution.run.get`) return { ok: true, result: { run: {
        runId: 'native-run', callId: 'call', sidechainId: 'side', intent: 'review',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, permissionMode: 'default', retentionPolicy: 'resumable',
        runClass: 'long_lived', ioMode: 'streaming', status: 'running', startedAtMs: 1,
      } } };
      if (nativeStop && payload.method === `${machineId}:execution.run.stop`) {
        await new Promise(resolve => setTimeout(resolve, 28_120));
        return { ok: true, result: { ok: true } };
      }
      if (stopping && payload.method === `${machineId}:actionOperation.get.v2`) return { ok: true, result: { kind: 'found', operation } };
      if (payload.method.startsWith(`${machineId}:`)) return unavailable;
      return { ok: true, result: payload.method.endsWith('cancel.v1') ? { kind: 'requested' } : { kind: 'not_found' } };
    } });
    bindApiSessionSocketMock(mocks.io, recoverySocket);
    const runtime = createProductionDaemonWorkflowRuntime({ credentials: { token: 'token', encryption: null }, accountId, serverId: aliasedHome ? 'operation-profile' : 'home' });
    const recover = runtime.createRecoveryForMachine({ machineId,
      machineAdmissionTransport: async () => { throw new Error('Recovery must not enqueue new work'); },
      machineActionDirectTargetTransport: { machineId, invoke: async (method, request) => {
        const response: unknown = await recoverySocket.emitWithAck(SOCKET_RPC_EVENTS.CALL, { method: `${machineId}:${method}`, params: request });
        if (!response || typeof response !== 'object' || !('ok' in response) || response.ok !== true || !('result' in response)) {
          throw new Error('Machine operation unavailable');
        }
        return response.result;
      } },
    });
    if (nativeStop) {
      let settled = false;
      const pending = recover('startup').then(() => { settled = true; });
      // Recovery prepares its original Machine transport asynchronously. Start
      // measuring the retained Stop only after the boundary registered its timer.
      await vi.waitFor(() => expect(requests).toContain(`${machineId}:execution.run.stop`));
      try {
        await vi.advanceTimersByTimeAsync(20_000);
        expect(requests).toContain(`${machineId}:execution.run.stop`);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(8_120);
        await pending;
        expect(requests.filter(method => method.endsWith('execution.run.stop'))).toHaveLength(1);
      } finally {
        await vi.advanceTimersByTimeAsync(28_120);
        await pending;
      }
    } else {
      await recover('startup');
      expect(new Set(requests)).toEqual(new Set(foreignHome ? [] : stopping
        ? [`${machineId}:actionOperation.get.v2`, `${machineId}:actionOperation.cancel.v1`]
        : [`${machineId}:actionOperation.get.v2`]));
    }
    expect(storage.run().workflowCustodyState).toBe('pending');
    expect(storage.rowById(childId)?.index.lifecycle).toBe(stopping ? 'cancel_requested' : 'running');
  });
});

describe('production terminal Workflow recovery transport', () => {
  afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });
  it('settles stopped historical detached custody through the installed Machine owner when remote raw RPC is unavailable', async () => {
    const accountId = 'account-1';
    const machineId = 'machine-1';
    const runId = '7be4d65c-d3b7-4868-a416-b18d9ee29c1c';
    const rootId = '2aaf1a39-4c48-4904-83a4-7eae318dfc2c';
    const childId = '33333333-3333-4333-8333-333333333333';
    mocks.fetchAccountEncryptionCurrentness.mockResolvedValue({ mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
    const checkpointEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'checkpoint', accountId, runId }, checkpoint: { kind: 'happier.workflow-checkpoint.v1',
        rootRecordId: rootId, nextSequence: '2', frontier: { nextBlockOrdinal: 1, paused: false } } }));
    const seal = (root: boolean) => serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: root ? rootId : childId,
        sequence: root ? '0' : '1', parentRecordId: root ? null : rootId, memberOrdinal: '0', attempt: '0' },
      progress: { kind: 'happier.workflow-progress.v1', blockKind: root ? 'root' : 'step',
        invocationPath: { blockId: root ? '$root' : 'background', scope: [] }, attempt: '0', logicalInvocationRecordId: root ? rootId : childId,
        ...(root ? {} : { reason: { code: 'execution_run_input_not_observed' }, execution: { kind: 'detached_run' as const,
          runId: 'historical-native-run', localInputId: 'historical-input', runtimeSelection: {} } }) } }));
    const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {}, blocks: [
      { kind: 'step', id: 'background', document: { text: 'Work', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
    ] };
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: {
        startedBy: 'user', definition, authoredDefinition: definition, workDepth: 0, metadata: null, frozenChildren: {}, materializedLeaves: [],
        source: { kind: 'inline' }, inputs: {}, machineId, executionTarget: { kind: 'detached_run' },
        workspaceTarget: { project: { machineId, directory: '/repo', checkoutRootPath: '/repo' }, originalCommittedRevision: 'a'.repeat(40) },
        origin: { kind: 'direct' }, authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      } }));
    const storage = createWorkflowRunStorageTestkit({ accountId, runId, machineId, origin: { kind: 'direct' }, acceptedEnvelope });
    await storage.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope,
      rootInvocation: { id: rootId, contentEnvelope: seal(true) } });
    await storage.execute({ operation: 'invocations.admit', runId, expectedRevision: 1, checkpointEnvelope,
      invocations: [{ id: childId, sequence: '1', parentRecordId: rootId, memberOrdinal: '0', lifecycle: 'outcome_uncertain', contentEnvelope: seal(false) }] });
    storage.requestControl('cancelled');
    // Home HTTP/storage and the Machine process transport are the boundaries.
    vi.spyOn(axios, 'post').mockImplementation(async (url, body: unknown) => {
      if (!String(url).endsWith('/v3/automations/runs/workflow-storage') || !body || typeof body !== 'object'
        || !('operation' in body)) throw new Error('Unexpected recovery effect');
      return { status: 200, data: body.operation === 'recovery.list' ? { candidates: [{ run: storage.run(), parentAttempt: 0 }] }
        : await storage.execute(body as WorkflowRunStorageTestkitOperation) };
    });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/profile') return { status: 200, data: { id: accountId } };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === '/v2/account/settings') return { status: 200, data: {
        content: { t: 'plain', v: AccountSettingsSchema.parse({}) }, version: 1,
      } };
      if (path.startsWith('/v1/machines/')) return { status: 200, data: { machine: { id: machineId,
        storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } } };
      throw new Error(`Unexpected recovery HTTP read ${path}`);
    });
    await bootstrapAccountSettingsContext({ credentials: { token: 'token', encryption: null }, mode: 'blocking', refresh: 'force', honorAccountSettingsModeEnv: false });
    bindApiSessionSocketMock(mocks.io, createApiSessionSocketStub({ async emitWithAck() {
      return { ok: false, error: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE, errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE };
    } }));
    const runtime = createProductionDaemonWorkflowRuntime({ credentials: { token: 'token', encryption: null }, accountId });
    const recover = runtime.createRecoveryForMachine({ machineId,
      machineAdmissionTransport: async () => { throw new Error('Recovery must not admit work'); },
      machineActionDirectTargetTransport: { machineId, invoke: async (method, request) => {
        if (method === RPC_METHODS.CAPABILITIES_DETECT) return { protocolVersion: 2,
          results: { 'tool.executionRuns': { ok: true, data: { protocolVersion: 2, features: { detachedScope: true } } } } };
        if (method !== SESSION_RPC_METHODS.EXECUTION_RUN_GET || !request || typeof request !== 'object'
          || !('runId' in request) || request.runId !== 'historical-native-run') throw new Error('Unexpected native effect');
        return { run: { runId: request.runId, callId: 'call', sidechainId: 'side', intent: 'agent',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, permissionMode: 'default', retentionPolicy: 'resumable',
          runClass: 'long_lived', ioMode: 'request_response', status: 'failed', startedAtMs: 1, finishedAtMs: 2,
          inputTurns: { occurrenceId: 'historical-occurrence' } } };
      } },
    });
    await recover('startup');
    expect(storage.run()).toMatchObject({ state: 'cancelled', workflowCustodyState: 'settled' });
    const row = storage.rowById(childId)!;
    expect(row.index.lifecycle).toBe('cancelled');
    const opened = openWorkflowProgressStoredEnvelopeV1({ mode: 'plain', binding: { v: 1, purpose: 'invocation_progress',
      accountId, runId, recordId: childId, sequence: '1', parentRecordId: rootId, memberOrdinal: '0', attempt: '0' },
      envelope: parseWorkflowStoredContentEnvelopeV1(row.contentEnvelope) });
    expect(opened).toMatchObject({ kind: 'available', content: { uncertainPriorEffects: { activity: 'stopped' } } });
    if (opened.kind === 'available') expect(opened.content.result).toBeUndefined();
  });
});

describe('production FIN managed Action composition', () => {
  let releaseHome = () => {};
  afterEach(() => { releaseHome(); vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });
  it('executes an accepted controller-bound Stop through the installed managed Action and operation owners', async () => {
    const accountId = 'fin-owner';
    const machineId = 'controller';
    const runId = '7be4d65c-d3b7-4868-a416-b18d9ee29c1c';
    const homeId = 'srv_fin_managed';
    const home = 'http://127.0.0.1:43187';
    releaseHome = publishServerHttpRuntimeOrigin(home, 'https');
    const serverId = configuration.activeServerId;
    const credentials = { token: `fixture.${Buffer.from(JSON.stringify({ sub: accountId, tokenEpoch: 0,
      provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`, encryption: null };
    // The observed Account explicitly allows this agent-surface power Action.
    // Default Ask is tested at its own real Artifact/review boundary elsewhere.
    const accountSettings = AccountSettingsSchema.parse({ actionsSettingsV1: { v: 1, actions: {},
      approvalWaivedSurfaces: { 'machines.managed.power.set': ['agent'] } } });
    const signing = nacl.sign.keyPair();
    const controller = { machineId, installationId: 'installation' };
    // Workspace inspection uses the real daemon-applied runtime and built-in
    // SCM catalog. No plugin owns this ordinary temporary-directory workspace.
    const workspaceRuntime = await pluginReloadController.acquireRuntimeRegistry({ resolveRuntimeRegistry: () =>
      resolveExecutablePluginRuntimeRegistry({ contributes: createResolvedContributionRegistry({}) }) });
    await workspaceRuntime.release();
    let machine = ManagedMachineV1Schema.parse({ id: 'managed', homeId, custodianAccountId: accountId, controller,
      launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
      resource: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
      allocation: 'bound', creationState: 'active', desired: 'stop', desiredWhen: 'now', intentRevision: 1,
      retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
    const effects: string[] = [];
    const native = nativeFixture({ privateNative: true, supportedIntents: ['stop'], onNativeRole: role => { effects.push(role); } });
    const unavailable = async (): Promise<never> => { throw new Error('Unexpected credential materialization'); };
    const authority = createManagedProviderOperationAuthority({ materializationBaseDir: tmpdir(),
      purposeBindingOwner: createConnectedAccountPurposeBindingOwner({ store: { read: async () => ({ v: 1, bindings: [] }),
        update: unavailable, subscribe: () => ({ dispose() {} }) }, selectTarget: unavailable, resolveTarget: unavailable,
        materializeAccount: unavailable, projectTargetAccounts: unavailable, assertTargetAccountMaterializable: unavailable }),
      requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(), resolveRequestAuthHttpPort: () => 43123,
      createRedactionLease: () => ({ add() {}, close() {} }) });
    await updateSettings(settings => ({ ...settings, servers: { ...settings.servers, [serverId]: { id: serverId, name: 'FIN Home',
      serverUrl: home, webappUrl: home, createdAt: 1, updatedAt: 1, lastUsedAt: 1, homeConnectionDescriptorAuthority: 'exact',
      homeConnectionDescriptor: HomeConnectionDescriptorV1Schema.parse({ v: 1, homeServerIdentityId: homeId, canonicalServerUrl: home, revision: 1,
        endpoints: [{ kind: 'https', url: home }] }) } } }));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(FeaturesResponseSchema.parse({ features: {},
      capabilities: { serverIdentity: { serverIdentityId: homeId } } })), { status: 200 }));
    mocks.fetchAccountEncryptionCurrentness.mockResolvedValue({ mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
    const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {}, blocks: [
      { kind: 'action', id: 'machines', actionId: 'machines.list', input: {} },
      { kind: 'action', id: 'stop',
      actionId: 'machines.managed.power.set', input: { homeId: { kind: 'literal', value: homeId }, managedId: { kind: 'literal', value: machine.id },
        intent: { kind: 'literal', value: 'stop' }, when: { kind: 'literal', value: 'now' }, expectedRevision: { kind: 'literal', value: 1 } } }] };
    const spec = getActionSpec('machines.managed.power.set');
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: { startedBy: 'user', definition,
        authoredDefinition: definition, workDepth: 0, metadata: null, frozenChildren: {}, inputs: {}, machineId,
        materializedLeaves: [{ sourceKey: '$root', blockId: 'machines', kind: 'action', actionId: 'machines.list', selection: {},
          executionTarget: { kind: 'detached_run' }, authoredWorkspace: { kind: 'inherit' }, actionInput: {}, actionContract: {
            inputSchema: StrictJsonValueSchema.parse(zodSchemaToJsonSchemaObject(getActionSpec('machines.list').inputSchema, { target: 'draft-7' })),
            outputSchema: StrictJsonValueSchema.parse(zodSchemaToJsonSchemaObject(getActionSpec('machines.list').outputSchema!, { target: 'draft-7' })) } },
          { sourceKey: '$root', blockId: 'stop', kind: 'action', actionId: 'machines.managed.power.set', selection: {},
          executionTarget: { kind: 'detached_run' }, authoredWorkspace: { kind: 'inherit' }, actionInput: {}, actionContract: {
            inputSchema: StrictJsonValueSchema.parse(zodSchemaToJsonSchemaObject(spec.inputSchema, { target: 'draft-7' })),
            outputSchema: StrictJsonValueSchema.parse(zodSchemaToJsonSchemaObject(spec.outputSchema!, { target: 'draft-7' })) } }],
        source: { kind: 'inline' }, executionTarget: { kind: 'detached_run' }, workspaceTarget: { project: { machineId, directory: tmpdir(), checkoutRootPath: tmpdir() } },
        origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'yolo' } } }));
    const storage = createWorkflowRunStorageTestkit({ accountId, runId, machineId, origin: { kind: 'direct' }, acceptedEnvelope });
    const unreachableRequests: string[] = [];
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const target = new URL(String(url));
      if (target.origin !== home) {
        unreachableRequests.push(target.pathname);
        throw new Error('Configured workflow endpoint is unreachable');
      }
      const path = target.pathname;
      if (path === '/v1/machines') return { status: 200, data: [] };
      if (path === '/v1/account/profile') return { status: 200, data: { id: accountId } };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: accountSettings }, version: 1 } };
      if (path === '/v1/artifacts') return { status: 200, data: [] };
      if (path === PROMPT_LIBRARY_ROWS_ROUTE_V1) return { status: 200, data: { status: 'listed', rows: [{ key: 'role-overrides', revision: 1,
        content: { t: 'plain', v: { key: 'role-overrides', value: { v: 1, overrides: {} } } } }] } };
      throw new Error(`Unexpected FIN HTTP read ${path}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body: unknown) => {
      const target = new URL(String(url));
      if (target.origin !== home) throw new Error('Configured workflow endpoint is unreachable');
      const path = target.pathname;
      if (path === '/v3/automations/runs/workflow-storage') return { status: 200, data: await storage.execute(body as WorkflowRunStorageTestkitOperation) };
      if (path.endsWith('/execution-authorization')) {
        const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
        expect(request.workflowActionOrigin).toMatchObject({ runId, requestId: request.envelope.requestId });
        return { status: 200, data: { v: 1, token: 'home-issued-fin', binding: { accountId, custodianAccountId: accountId,
          authentication: { kind: 'terminal', tokenEpoch: 0 }, accountEncryptionMode: 'plain', serverIdentityId: homeId,
          machineId, installationId: controller.installationId, actionId: 'machines.managed.power.set', requestId: request.envelope.requestId,
          requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope), target: request.envelope.target,
          workflowActionOrigin: request.workflowActionOrigin } } };
      }
      if (path.endsWith('/verify')) return { status: 200, data: { ok: true } };
      if (path.endsWith('/admit-control')) return { status: 200, data: { machine, replayed: false } };
      if (path.endsWith('/submit-intent')) {
        if (!body || typeof body !== 'object' || !('requestId' in body) || typeof body.requestId !== 'string') throw new Error('Invalid native submission');
        machine = { ...machine, submittedNativeEffect: { intentRevision: 1, requestId: body.requestId, intent: 'stop', controller } };
        return { status: 200, data: { machine, submitted: true } };
      }
      if (path.endsWith('/report-intent')) {
        machine = { ...machine, submittedNativeEffect: undefined };
        return { status: 200, data: { machine } };
      }
      if (path.endsWith('/context')) return { status: 200, data: { machine, requestId: 'retained' } };
      if (path.endsWith('/current')) return { status: 200, data: { machine } };
      throw new Error(`Unexpected FIN HTTP mutation ${path}`);
    });
    const settings = await bootstrapAccountSettingsContext({ credentials, mode: 'blocking', refresh: 'force', honorAccountSettingsModeEnv: false });
    if (!settings.scopeKey) throw new Error('FIN fixture has no authenticated Account settings scope');
    const catalog = await loadPromptLibraryCatalogV1({ mode: 'plain', material: null, readRows: async () =>
      PromptLibraryRowsListResponseV1Schema.parse((await axios.get(`${home}${PROMPT_LIBRARY_ROWS_ROUTE_V1}`)).data) });
    expect(commitActivePromptLibraryCatalog({ scopeKey: settings.scopeKey,
      lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(), catalog })).toBe(true);
    bindApiSessionSocketMock(mocks.io, createApiSessionSocketStub());
    const operations = createHostActionOperationRuntime({ machineId, resolveAccountId: async () => accountId, generateOperationId: () => 'fin-native' });
    const adapter = createDaemonManagedMachineActionAdapter({ credentials, machineId, serverId, serverBaseUrl: home,
      installationIdentity: { installationId: controller.installationId, privateKey: signing.secretKey }, managedProviderOperationAuthority: authority,
      resolveCurrentMachineExecutionOriginContext: createCurrentMachineExecutionOriginContextResolver({ serverUrl: home, resolveCurrentMachineId: () => machineId }),
      acquireRuntimeRegistryLease: async () => ({ registry: native.runtimeRegistry, source: 'active', durableRevision: 1, release: async () => {} }),
      observeActionExecution: operations.observeExecution });
    const runtime = createProductionDaemonWorkflowRuntime({ credentials, accountId, serverId });
    const coordinate = runtime.createCoordinatorForMachine({ machineId,
      managedMachineAction: adapter, machineAdmissionTransport: unavailable,
      machineActionDirectTargetTransport: { machineId, invoke: unavailable } });
    const outcome = await coordinate({ runId, attempt: 0, expectedRevision: 0, acceptedEnvelope,
      accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null } });
    const progress = storage.rows().map(row => ({ index: row.index,
      opened: openWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: row.index.id,
          sequence: row.index.sequence, parentRecordId: row.index.parentRecordId,
          memberOrdinal: row.index.memberOrdinal, attempt: row.index.attempt },
        envelope: parseWorkflowStoredContentEnvelopeV1(row.contentEnvelope) }) }));
    const observedOperation = await operations.handlers.getV2({ operationId: 'fin-native' });
    expect(unreachableRequests).toEqual([]);
    expect(outcome, JSON.stringify({ outcome, run: storage.run(), progress, observedOperation })).toMatchObject({ state: 'succeeded' });
    const settled = await operations.handlers.getV2({ operationId: 'fin-native', waitForTerminal: true });
    expect(settled, JSON.stringify(settled)).toMatchObject({ kind: 'found', operation: { state: 'succeeded' } });
    expect(effects).toContain('power');
  });
});

describe('production daemon Workflow policy-only context preparation', () => {
  let releaseHome = () => {};
  beforeEach(() => { resetInMemoryAccountSettingsContextForTests(); });
  afterEach(() => { releaseHome(); vi.restoreAllMocks(); resetInMemoryAccountSettingsContextForTests(); });

  it('checks fresh controller policy on repeated accepted work without listing Artifact or Role inventories', async () => {
    const accountId = 'workflow-policy-owner';
    const machineId = 'workflow-policy-machine';
    const runId = '7be4d65c-d3b7-4868-a416-b18d9ee29c1c';
    const home = 'http://127.0.0.1:43187';
    releaseHome = publishServerHttpRuntimeOrigin(home, 'https');
    const credentials = { token: `fixture.${Buffer.from(JSON.stringify({ sub: accountId, tokenEpoch: 0,
      provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`, encryption: null };
    const agentTarget = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } };
    const role = ResolvedRoleV1Schema.parse({ roleId: 'accepted-reviewer', name: 'Accepted reviewer', instructions: 'Keep the accepted instructions.',
      engine: { agentTargetKey: buildBackendTargetKeyV2(agentTarget) },
      runsAs: { kind: 'session' }, workspaceWrites: 'deny', secondOpinion: 'off', enabled: true });
    const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: { engine: { role: role.roleId } }, blocks: [
      { kind: 'step', id: 'review', document: { text: 'Review accepted work.', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
    ] };
    // Freeze the Role through the real accepted-snapshot producer. Only the
    // external target-availability observation is supplied by this fixture.
    const accepted = await materializeWorkflowAcceptedSnapshotV1({ definition,
      context: { source: { kind: 'inline' }, inputs: {}, machineId, executionTarget: { kind: 'session' },
        workspaceTarget: { project: { machineId, directory: tmpdir(), checkoutRootPath: tmpdir() } },
        origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } } },
      roleSelection: { settingsRoles: { [role.roleId]: role } }, admission: { kind: 'user' },
      effects: { resolveTargetAvailability: async () => true } });
    if (!accepted.ok) throw new Error(`Workflow policy fixture admission failed: ${accepted.error.code}`);
    expect(accepted.snapshot.materializedLeaves[0]?.role).toMatchObject(role);
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: accepted.snapshot }));
    const storage = createWorkflowRunStorageTestkit({ accountId, runId, machineId, origin: { kind: 'direct' }, acceptedEnvelope });
    let settingsVersion = 1;
    let settings = AccountSettingsSchema.parse({ workDepthLimit: 8, sessionAgentStartAllowListsV1: { v: 1, allowedRoleIds: [] } });
    const reads: string[] = [];
    mocks.fetchAccountEncryptionCurrentness.mockResolvedValue({ mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
    // Only authenticated Home HTTP is substituted. The coordinator, accepted
    // snapshot codec, Settings bootstrap, policy and Role readers remain real.
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const target = new URL(String(url));
      expect(target.origin).toBe(home);
      reads.push(target.pathname);
      if (target.pathname === '/v1/account/profile') return { status: 200, data: { id: accountId } };
      if (target.pathname === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (target.pathname === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: settings }, version: settingsVersion } };
      if (target.pathname === '/v1/artifacts') return { status: 200, data: [] };
      if (target.pathname === PROMPT_LIBRARY_ROWS_ROUTE_V1) return { status: 200, data: { status: 'listed', rows: [{ key: 'role-overrides', revision: 1,
        content: { t: 'plain', v: { key: 'role-overrides', value: { v: 1, overrides: {} } } } }] } };
      throw new Error(`Unexpected Workflow policy HTTP read ${target.pathname}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body: unknown) => {
      if (new URL(String(url)).pathname === '/v3/automations/runs/workflow-storage') {
        return { status: 200, data: await storage.execute(body as WorkflowRunStorageTestkitOperation) };
      }
      throw new Error('Unexpected Workflow policy HTTP mutation');
    });
    const snapshot = await bootstrapAccountSettingsContext({ credentials, mode: 'blocking', refresh: 'force', honorAccountSettingsModeEnv: false });
    if (!snapshot.scopeKey) throw new Error('Missing Workflow policy Account scope');
    const catalog = await loadPromptLibraryCatalogV1({ mode: 'plain', material: null, readRows: async () =>
      PromptLibraryRowsListResponseV1Schema.parse((await axios.get(`${home}${PROMPT_LIBRARY_ROWS_ROUTE_V1}`)).data) });
    expect(commitActivePromptLibraryCatalog({ scopeKey: snapshot.scopeKey,
      lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(), catalog })).toBe(true);
    reads.length = 0;
    const unavailable = async (): Promise<never> => { throw new Error('Refused work must not reach a Machine'); };
    const runtime = createProductionDaemonWorkflowRuntime({ credentials, accountId });
    const coordinate = () => runtime.createCoordinatorForMachine({ machineId, machineAdmissionTransport: unavailable,
      machineActionDirectTargetTransport: { machineId, invoke: unavailable } });
    const claim = () => ({ runId, attempt: 0, expectedRevision: storage.run().revision, acceptedEnvelope,
      workflowResumeRequestedRevision: storage.run().revision,
      accountCurrentness: { mode: 'plain' as const, version: 1, contentKeyFingerprint: null } });
    expect(await coordinate()(claim())).toMatchObject({ state: 'paused', reason: 'policy_denied_field' });
    const firstSettingsReads = reads.filter(path => path === '/v2/account/settings').length;
    expect(firstSettingsReads).toBeGreaterThan(0);
    settingsVersion++;
    settings = AccountSettingsSchema.parse({ workDepthLimit: 0, sessionAgentStartAllowListsV1: { v: 1, allowedRoleIds: null } });
    expect(await coordinate()(claim())).toMatchObject({ state: 'paused', reason: 'work_depth_exceeded' });
    expect(reads.filter(path => path === '/v2/account/settings').length).toBeGreaterThan(firstSettingsReads);
    expect(storage.acceptedEnvelope()).toBe(acceptedEnvelope);
    expect(reads.filter(path => path === '/v1/artifacts' || path === PROMPT_LIBRARY_ROWS_ROUTE_V1),
      'already-accepted work needs fresh policy, not full source inventories').toEqual([]);
  });
});

describe('production daemon Workflow plugin approval composition', () => {
  afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });

  it('defers an Agent-only plugin leaf, then settles its approved effect exactly once across coordinator reconstruction', async () => {
    const accountId = 'workflow-plugin-owner';
    const machineId = 'workflow-plugin-machine';
    const runId = '7be4d65c-d3b7-4868-a416-b18d9ee29c1c';
    const pluginId = 'acme.workflow-approval';
    const localId = 'update';
    const actionId = `${pluginId}/actions/${localId}`;
    const home = configuration.apiServerUrl;
    const serverId = configuration.activeServerId;
    const credentials = { token: `fixture.${Buffer.from(JSON.stringify({ sub: accountId, tokenEpoch: 0,
      provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`, encryption: null };
    const inputSchema = { type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'], additionalProperties: false };
    const outputSchema = { type: 'object', properties: { changed: { type: 'boolean' } }, required: ['changed'], additionalProperties: false };
    const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      runtimeOptions: { resolveCurrentMachineExecutionOriginContext: createCurrentMachineExecutionOriginContextResolver({
        serverUrl: home, resolveCurrentMachineId: () => machineId }) }, plugins: [{
      manifest: createPluginManifestV2Fixture({ id: pluginId, contributes: { actions: [{ id: localId, title: 'Update',
        dangerLevel: 'writesRemote', scopes: ['global'], surfaces: ['agent'], execution: { target: 'daemon' }, inputSchema, resultSchema: outputSchema,
        confirmation: { title: 'Apply update' } }] } }),
      files: { 'daemon.mjs': 'let calls = 0; export function readCalls() { return calls; } export function activate(api) { api.actions.register("update", async () => { calls++; return { changed: true }; }); }' },
    }] });
    try {
      const readCalls = fixture.modulesByPluginId.get(pluginId)?.readCalls;
      if (typeof readCalls !== 'function') throw new Error('Missing physical plugin effect observation');
      const settings = AccountSettingsSchema.parse({});
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(FeaturesResponseSchema.parse({ features: {},
        capabilities: { serverIdentity: { serverIdentityId: 'srv_workflow_plugin' } } })), { status: 200 }));
      const artifacts = new Map<string, Record<string, unknown>>();
      const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {}, blocks: [
        { kind: 'action', id: 'update', actionId, input: { enabled: { kind: 'literal', value: false } } },
      ] };
      const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: { startedBy: 'user', definition,
          authoredDefinition: definition, workDepth: 0, metadata: null, frozenChildren: {}, inputs: {}, machineId,
          materializedLeaves: [{ sourceKey: '$root', blockId: 'update', kind: 'action', actionId, selection: {},
            executionTarget: { kind: 'session' }, authoredWorkspace: { kind: 'inherit' }, actionInput: {}, actionContract: { inputSchema, outputSchema } }],
          source: { kind: 'inline' }, executionTarget: { kind: 'session' },
          workspaceTarget: { project: { machineId, directory: tmpdir(), checkoutRootPath: tmpdir() } },
          origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' } } }));
      const storage = createWorkflowRunStorageTestkit({ accountId, runId, machineId, origin: { kind: 'direct' }, acceptedEnvelope });
      // Only HTTP/Socket.IO persistence and transport are replaced. Production
      // Workflow composition, plugin loading, policy, approvals and codecs run.
      vi.spyOn(axios, 'get').mockImplementation(async url => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/account/profile') return { status: 200, data: { id: accountId } };
        if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
        if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
          mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
        } };
        if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: settings }, version: 1 } };
        if (path === '/v1/artifacts') return { status: 200, data: [...artifacts.values()] };
        if (path.startsWith('/v1/artifacts/')) return { status: 200, data: artifacts.get(path.split('/').at(-1)!) };
        if (path === PROMPT_LIBRARY_ROWS_ROUTE_V1) return { status: 200, data: { status: 'listed', rows: [{ key: 'role-overrides', revision: 1,
          content: { t: 'plain', v: { key: 'role-overrides', value: { v: 1, overrides: {} } } } }] } };
        throw new Error(`Unexpected Workflow HTTP read ${path}`);
      });
      vi.spyOn(axios, 'post').mockImplementation(async (url, body: unknown) => {
        const path = new URL(String(url)).pathname;
        if (path === '/v3/automations/runs/workflow-storage') return { status: 200, data: await storage.execute(body as WorkflowRunStorageTestkitOperation) };
        if (!body || typeof body !== 'object') throw new Error('Invalid Artifact request');
        if (path === '/v1/artifacts' && 'id' in body && typeof body.id === 'string') {
          artifacts.set(body.id, { ...body, ownerAccountId: accountId, access: 'owner', encryptionMode: 'plain',
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
          return { status: 200, data: { id: body.id, headerVersion: 1, bodyVersion: 1 } };
        }
        if (path.startsWith('/v1/artifacts/')) {
          const id = path.split('/').at(-1)!;
          const existing = artifacts.get(id);
          if (!existing) throw new Error('Missing Artifact');
          const request = body as Record<string, unknown>;
          if (request.expectedHeaderVersion !== undefined && request.expectedHeaderVersion !== existing.headerVersion
            || request.expectedBodyVersion !== undefined && request.expectedBodyVersion !== existing.bodyVersion) {
            return { status: 200, data: { success: false, error: 'version-mismatch' } };
          }
          const headerVersion = Number(existing.headerVersion) + (request.header === undefined ? 0 : 1);
          const bodyVersion = Number(existing.bodyVersion) + (request.body === undefined ? 0 : 1);
          artifacts.set(id, { ...existing, ...(request.header === undefined ? {} : { header: request.header }),
            ...(request.body === undefined ? {} : { body: request.body }), headerVersion, bodyVersion });
          return { status: 200, data: { success: true, headerVersion, bodyVersion } };
        }
        throw new Error(`Unexpected Workflow HTTP mutation ${path}`);
      });
      vi.spyOn(axios, 'request').mockImplementation(async request => {
        const path = new URL(String(request.url)).pathname;
        if (request.method === 'POST' && path === ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1) {
          return { status: 200, data: { tokens: [] } };
        }
        throw new Error(`Unexpected Workflow HTTP request ${path}`);
      });
      mocks.fetchAccountEncryptionCurrentness.mockResolvedValue({ mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
      bindApiSessionSocketMock(mocks.io, createApiSessionSocketStub());
      const snapshot = await bootstrapAccountSettingsContext({ credentials, mode: 'blocking', refresh: 'force', honorAccountSettingsModeEnv: false });
      if (!snapshot.scopeKey) throw new Error('Missing Workflow Account scope');
      const catalog = await loadPromptLibraryCatalogV1({ mode: 'plain', material: null, readRows: async () =>
        PromptLibraryRowsListResponseV1Schema.parse((await axios.get(`${home}${PROMPT_LIBRARY_ROWS_ROUTE_V1}`)).data) });
      expect(commitActivePromptLibraryCatalog({ scopeKey: snapshot.scopeKey,
        lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(), catalog })).toBe(true);
      const unavailable = async (): Promise<never> => { throw new Error('Unexpected machine transport'); };
      const runtime = createProductionDaemonWorkflowRuntime({ credentials, accountId, serverId });
      const coordinate = () => runtime.createCoordinatorForMachine({
        machineId, machineAdmissionTransport: unavailable, machineActionDirectTargetTransport: { machineId, invoke: unavailable } });
      const claim = () => ({ runId, attempt: 0, expectedRevision: storage.run().revision, acceptedEnvelope,
        accountCurrentness: { mode: 'plain' as const, version: 1, contentKeyFingerprint: null } });
      const held = await coordinate()(claim());
      expect(held, JSON.stringify({ held, run: storage.run(), invocations: storage.rows().map(row => row.index) }))
        .toMatchObject({ state: 'paused', reason: 'approval_required' });
      expect(readCalls()).toBe(0);
      expect(artifacts.size).toBe(1);
      const artifactId = [...artifacts.keys()][0]!;
      const store = createCliApprovalsArtifactStore({ credentials });
      expect(await store.targetActionApprovalsGet({ artifactId })).toMatchObject({ requestedSurface: 'agent', qualifiedActionId: actionId, status: 'open',
        replayPlacement: { serverId, machineId }, executionOriginV1: { serverId, serverIdentityId: 'srv_workflow_plugin', machineId,
          caller: { kind: 'workflowRun', runId } } });
      expect(await coordinate()(claim())).toMatchObject({ state: 'paused' });
      expect(artifacts.size).toBe(1);
      expect(readCalls()).toBe(0);
      const startupHome = await createTempDir('workflow-approval-startup-');
      const replayDiagnostics = vi.spyOn(logger, 'debug');
      const daemon = await createRequesterSessionControlRuntimeFixture({ happyHomeDir: startupHome,
        activeServerDir: join(startupHome, 'servers', serverId), serverId, serverHttpBaseUrl: home,
        machineId, custodianAccountId: accountId, credentials,
        connectedServicesMaterializationBaseDir: join(startupHome, 'connected-services'), registry: new ConnectedServiceRuntimeRegistry(),
        trackedSessions: new Map(), getRequester: () => null, resolveQualifiedConnectedAccountV4Support: () => 'advertised',
        beforeStartup: async () => { await writeStoredCredentialsForServerId(serverId, credentials); },
        startup: { resolveCurrentMachineExecutionOriginContext: async () => ({ machineId, serverIdentityId: 'srv_workflow_plugin' }),
          workflowAcceptedAuthorizationCurrentness: runtime.isAcceptedAuthorizationCurrent } });
      try {
        const ingress = daemon.runtime.externalActionIngressOwner;
        if (!ingress) throw new Error('Missing production daemon approval ingress');
        // The authenticated Machine RPC receiver stamps this authority; UI
        // surface text alone must not elevate the daemon's terminal credential.
        const replay = (input: { artifactId: string; decision: 'approve' }) => ingress.executor.execute('approval.request.decide',
          { ...input, serverIdentityId: 'srv_workflow_plugin', originServerId: serverId },
          { surface: 'rpc', authority: 'present_user', serverId, actionCaller: { kind: 'host' } });
        const decided = await replay({ artifactId, decision: 'approve' });
        expect(decided, JSON.stringify({ decided, effects: readCalls(),
          stale: replayDiagnostics.mock.calls.find(([message]) => message === '[RPC] Contributed approval origin is stale')?.[1] }))
          .toMatchObject({ ok: true, result: { status: 'executed' } });
        expect(readCalls()).toBe(1);
        expect(await replay({ artifactId, decision: 'approve' })).toMatchObject({ ok: true, result: { status: 'executed' } });
        await storage.execute({ operation: 'resume', runId, expectedRevision: storage.run().revision });
        expect(storage.run().state).toBe('running');
        expect(await coordinate()(claim())).toMatchObject({ state: 'succeeded' });
        expect(readCalls()).toBe(1);
        expect(artifacts.size).toBe(1);
        expect(storage.rows().filter(row => row.index.parentRecordId !== null)).toMatchObject([{ index: { lifecycle: 'completed', attempt: '0' } }]);
      } finally { await daemon.dispose(); await removeTempDir(startupHome); }
    } finally { await fixture.dispose(); }
  });
});

describe('workflow actual Session reuse metadata', () => {
  const sessionId = 'c123456789012345678901234';
  const credentials = { token: 'token', encryption: null } as const;
  const session = {
    id: sessionId, active: true, activeAt: 1, createdAt: 1, updatedAt: 1,
    encryptionMode: 'plain', metadataLayoutVersion: 1, metadata: JSON.stringify({ v: 1 }),
    ownerMetadata: { t: 'plain', v: { v: 1, workspace: { path: '/owner/checkout', machineId: 'machine-1' } } },
  };

  beforeEach(() => {
    mocks.fetchAccountEncryptionCurrentness.mockResolvedValue({
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
    });
    mocks.fetchSessionById.mockResolvedValue(session);
    mocks.lookupSessionsByTags.mockImplementation(async ({ tags }) => ({ state: 'available', tags, sessions: [] }));
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v2/sessions' || path === '/v2/sessions/archived') return { status: 200,
        data: { sessions: [], nextCursor: null, hasNext: false } };
      throw new Error(`Unexpected Session lookup read: ${path}`);
    });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('uses the authorized owner cwd and rejects another Machine before preparation', async () => {
    await expect(resolveWorkflowSessionConversation({ credentials, sessionId, machineId: 'machine-1' }))
      .resolves.toMatchObject({ sessionId, machineId: 'machine-1', directory: '/owner/checkout' });
    const refused: unknown[] = [];
    await expect(resolveWorkflowSessionConversation({ credentials, sessionId, machineId: 'machine-2',
      onUnavailable: (details) => { refused.push(details); } })).resolves.toBeNull();
    expect(refused).toMatchObject([{ reason: 'machine_mismatch', expected: { ids: ['machine-2'] }, observed: { ids: ['machine-1'] } }]);
  });

  it.each(['remote', 'wrong-machine', 'missing-machine'] as const)
  ('executes a selected Session through production daemon composition using its own verified Machine (%s)', async scenario => {
    const accountId = 'account-1';
    const machineId = 'coordinator-machine';
    const participantMachineId = 'participant-machine';
    const directory = '/participant-only/checkout';
    const runId = '7be4d65c-d3b7-4868-a416-b18d9ee29c1c';
    const releaseHome = publishServerHttpRuntimeOrigin('http://127.0.0.1:43187', 'https');
    const localId = deriveWorkflowSessionInputLocalIdV2({ purpose: 'invocation', runId, invocationRecordId: 'unused' });
    let admittedLocalId = localId;
    const remoteSession = createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', active: true,
      metadata: JSON.stringify({ path: directory, ...(scenario === 'missing-machine' ? {} : {
        machineId: scenario === 'wrong-machine' ? machineId : participantMachineId,
      }), runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: {} },
      ...(scenario === 'remote' ? { sessionCreationCorrespondenceV1: buildSessionCreationCorrespondence({
        identity: { callerCreationNamespace: 'workflow-participant-test', creationKey: sessionId },
        recipe: { execution: { machineId: participantMachineId, directory: { kind: 'path', path: directory } },
          organization: { folderId: null, tagIds: [] },
          agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } },
      }) } : {}),
    }) });
    mocks.fetchSessionById.mockResolvedValue(remoteSession);
    // Session readiness reaches the actual target's process adapter, even
    // when the existing Session is already active. No new Session is created.
    const replacementAwareRpc = vi.spyOn(machineRpc, 'callMachineRpc').mockRejectedValue(
      new Error('An admitted Workflow participant cannot follow a Machine replacement'));
    const exactMachineRpc = vi.spyOn(machineRpc, 'callExactMachineRpc').mockImplementation(async request => {
      expect(request.machineId).toBe(participantMachineId);
      expect(request.requireCurrentMachine).toBe(true);
      if (request.method === RPC_METHODS.SPAWN_HAPPY_SESSION) return { type: 'success', sessionId };
      if (request.method === RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE) return { status: 'success', sessionId };
      throw new Error(`Unexpected remote Session process request: ${request.method}`);
    });
    const conversation = { kind: 'existing_session' as const, sessionId, machineId: participantMachineId };
    const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {}, blocks: [{ kind: 'step', id: 'opinion',
      execution: { conversation }, document: { text: 'Give your opinion', references: [], attachments: [] }, input: [], result: { kind: 'text' } }] };
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: {
        startedBy: 'user', definition, authoredDefinition: definition, workDepth: 0, metadata: null, frozenChildren: {}, inputs: {}, machineId,
        source: { kind: 'inline' }, executionTarget: { kind: 'session' }, origin: { kind: 'direct' },
        workspaceTarget: { project: { machineId, directory: tmpdir(), checkoutRootPath: tmpdir() } },
        authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' },
        materializedLeaves: [{ sourceKey: '$root', blockId: 'opinion', kind: 'step', selection: { conversation },
          executionTarget: { kind: 'session' }, authoredWorkspace: { kind: 'inherit' } }],
      } }));
    const storage = createWorkflowRunStorageTestkit({ accountId, runId, machineId, origin: { kind: 'direct' }, acceptedEnvelope });
    type AdmissionRequest = Parameters<NonNullable<Parameters<typeof import('@/session/services/sendSessionMessage').sendSessionMessage>[0]['machineAdmissionTransport']>>[0];
    const admissions: AdmissionRequest[] = [];
    vi.spyOn(axios, 'post').mockImplementation(async (url, body: unknown) => {
      if (!String(url).endsWith('/v3/automations/runs/workflow-storage')) throw new Error(`Unexpected HTTP write: ${new URL(String(url)).pathname}`);
      return { status: 200, data: await storage.execute(body as WorkflowRunStorageTestkitOperation) };
    });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: { session: remoteSession } };
      if (path === `/v2/sessions/${sessionId}/messages/reply-capability`) return {
        status: 200, data: SessionMessageReplyCapabilityV1Schema.parse({ v: 1, protocolVersions: [1] }),
      };
      if (path === `/v2/sessions/${sessionId}/messages/by-local-id/${encodeURIComponent(admittedLocalId)}/reply`) return {
        status: 200, data: SessionMessageReplyReadResultV1Schema.parse({ v: 1, status: 'available',
          progress: { v: 1, mode: 'wait', disposition: 'observing', acceptedTurnId: 'participant-turn',
            outcome: { kind: 'answer', result: { sessionId, messageId: 'answer' } } } }),
      };
      if (path.includes('/messages/by-local-id/')) return { status: 200, data: { message: {
        id: 'question', seq: 1, localId: admittedLocalId, createdAt: 1, updatedAt: 1,
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Give your opinion' } } },
      } } };
      if (path.endsWith('/turns')) return { status: 200, data: { v: 1, sessionId, updatedAt: 3,
        turns: [{ turnId: 'participant-turn', status: 'completed', startedAt: 1, updatedAt: 3,
          transcriptAnchors: { startUserMessageSeq: 1, userMessageSeqs: [1], startSeqInclusive: 1,
            endSeqInclusive: 2, finalAssistantMessageSeq: 2 } }] } };
      if (path.endsWith('/messages')) return { status: 200, data: { messages: [{ id: 'answer', seq: 2,
        localId: null, createdAt: 2, updatedAt: 2, content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'Remote opinion' } } } }] } };
      if (path.endsWith('/pending')) return { status: 200, data: { pending: [], version: 0 } };
      throw new Error(`Unexpected HTTP read: ${path}`);
    });
    const runtime = createProductionDaemonWorkflowRuntime({ credentials, accountId });
    const unavailable = async (): Promise<never> => { throw new Error('No fresh Session or coordinator native effect is authorized'); };
    const coordinate = runtime.createCoordinatorForMachine({ machineId,
      machineActionDirectTargetTransport: { machineId, invoke: unavailable },
      machineAdmissionTransport: async request => {
        admissions.push(request);
        admittedLocalId = request.localId;
        return { status: 'accepted', localId: request.localId };
      } });
    try {
      const outcome = await coordinate({ runId, attempt: 0, expectedRevision: 0, acceptedEnvelope,
        accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null } });
      const progress = storage.rows().map(row => openWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: row.index.id,
          sequence: row.index.sequence, parentRecordId: row.index.parentRecordId, memberOrdinal: row.index.memberOrdinal, attempt: row.index.attempt },
        envelope: parseWorkflowStoredContentEnvelopeV1(row.contentEnvelope) }));
      if (scenario === 'remote') {
        expect(outcome, JSON.stringify(progress)).toMatchObject({ state: 'succeeded' });
        expect(exactMachineRpc).toHaveBeenCalled();
        expect(replacementAwareRpc).not.toHaveBeenCalled();
        expect(admissions).toMatchObject([{ sessionId, targetMachineId: participantMachineId, reply: { mode: 'wait' } }]);
        expect(progress).toContainEqual(expect.objectContaining({ kind: 'available', content: expect.objectContaining({
          blockKind: 'step', result: 'Remote opinion', execution: expect.objectContaining({ kind: 'session', sessionId }),
          workspace: { descriptor: { machineId: participantMachineId, directory, checkoutRootPath: directory } },
        }) }));
      } else {
        expect(admissions).toEqual([]);
        expect(exactMachineRpc).not.toHaveBeenCalled();
        expect(replacementAwareRpc).not.toHaveBeenCalled();
        expect(outcome).toMatchObject({ state: 'interrupted', reason: 'workflow_conversation_unavailable' });
        expect(progress).toContainEqual(expect.objectContaining({ kind: 'available', content: expect.objectContaining({
          reason: { code: 'workflow_conversation_unavailable', details: expect.objectContaining({
            reason: 'machine_mismatch', expected: { kind: 'string', ids: [participantMachineId] },
          }) },
        }) }));
      }
    } finally { releaseHome(); }
  });

  it.each([true, false])('retains a remote Session for same-conversation recovery only with its recorded Machine (witness=%s)', async witness => {
    const machineId = 'participant-machine';
    const workspace = { machineId, directory: '/participant-only/checkout', checkoutRootPath: '/participant-only/checkout' };
    mocks.fetchSessionById.mockResolvedValue(createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', active: true,
      metadata: JSON.stringify({ machineId, path: workspace.directory }) }));
    const unused = async (): Promise<never> => { throw new Error('Recovery may only read the exact retained Session'); };
    const owner = createProductionWorkflowConversationOwner({ credentials, machineId: 'coordinator-machine',
      createFreshConversation: unused, resolveSharedRunConversation: unused, resolveProducerConversation: unused,
      resolveExistingSessionConversation: input => resolveWorkflowSessionConversation({ ...input, credentials }) });
    const request: Parameters<typeof owner.prepare>[0] = { runId: 'run-1',
      step: { kind: 'step', id: 'opinion', document: { text: 'Continue', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
      invocation: { kind: 'happier.workflow-progress.v1', blockKind: 'step', invocationPath: { blockId: 'opinion', scope: [] },
        logicalInvocationRecordId: 'current', attempt: '1', recovery: { conversation: 'same_conversation', input: { kind: 'original' } } },
      recoveryPreviousExecution: { kind: 'session', sessionId, localInputId: 'original-input' },
      ...(witness ? { recoveryPreviousWorkspace: workspace } : {}),
      execution: { conversation: { kind: 'fresh' } }, executionTarget: { kind: 'session' },
      authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' } };
    if (witness) await expect(owner.prepare(request)).resolves.toMatchObject({ existing: { sessionId, machineId, directory: workspace.directory } });
    else await expect(owner.prepare(request)).rejects.toMatchObject({ code: 'workflow_conversation_unavailable', details: { reason: 'machine_mismatch' } });
  });

  it('projects timestamped controls from authenticated Session owner metadata', async () => {
    const ref = { agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId: 'saved-model' };
    mocks.fetchSessionById.mockResolvedValue({ ...session, ownerMetadata: { t: 'plain', v: { v: 1,
      workspace: { path: '/owner/checkout', machineId: 'machine-1' },
      nativeSession: { runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} } },
      runtime: { permissionMode: 'read-only', permissionModeUpdatedAt: 200,
        allowedTools: ['mcp__wilson-brief__*'], unlistedTools: 'deny',
        modelSelectionIntentV1: { v: 1, selection: ref, updatedAt: 200 } },
    } } });
    expect(await resolveWorkflowSessionConversation({ credentials, sessionId, machineId: 'machine-1' }))
      .toMatchObject({ runtimeSelection: { allowedTools: ['mcp__wilson-brief__*'], unlistedTools: 'deny' }, runtimeSnapshot: {
        permissionMode: { value: 'read-only', updatedAt: 200 }, modelSelection: { value: ref, updatedAt: 200 },
      } });
  });

  it('retains known Connected selection from predecessor metadata with additive fields', async () => {
    const serviceKey = 'happier.test/service';
    mocks.fetchSessionById.mockResolvedValue({ ...session, metadataLayoutVersion: 0,
      metadata: JSON.stringify({ path: '/owner/checkout', machineId: 'machine-1',
        connectedServices: { v: 2, retiredCarrier: true, bindingsByServiceId: {
          [serviceKey]: { source: 'connected', selection: 'profile', profileId: 'saved-profile', retiredSelection: true },
        } },
      }), ownerMetadata: undefined });
    const resolved = await resolveWorkflowSessionConversation({ credentials, sessionId, machineId: 'machine-1' });
    expect(resolved?.runtimeSelection).toMatchObject({ connectedServices: { v: 2, bindingsByServiceId: {
      [serviceKey]: { source: 'connected', selection: 'profile', profileId: 'saved-profile' },
    } } });
    expect(resolved?.runtimeSelection?.connectedServices).not.toHaveProperty('retiredCarrier');
    expect(resolved?.runtimeSelection?.connectedServices?.bindingsByServiceId[serviceKey]).not.toHaveProperty('retiredSelection');
  });

  it.each(['claude', 'another-agent'])('reads retained config catalog fields only for the current Agent (%s)', async agentId => {
    let written: Metadata = createTestMetadata({ path: '/owner/checkout', host: 'test', machineId: 'machine-1',
      runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} } });
    await publishSessionControlsMetadataBestEffort({
      session: { updateMetadata: updater => { written = updater(written); } },
      sessionConfigOptionsState: { v: 1, agentId, updatedAt: 200,
        configOptions: [{ id: 'quality', name: 'Quality', type: 'string', currentValue: 'high' }] },
    });
    const catalog = written.sessionConfigOptionsV1!;
    mocks.fetchSessionById.mockResolvedValue({ ...session, metadataLayoutVersion: 0,
      metadata: JSON.stringify({ ...written,
        sessionConfigOptionsV1: { ...catalog, retiredCatalogField: true,
          configOptions: catalog.configOptions.map(option => ({ ...option, retiredOptionField: true })) },
      }), ownerMetadata: undefined });
    const resolved = await resolveWorkflowSessionConversation({ credentials, sessionId, machineId: 'machine-1' });
    expect(resolved).not.toBeNull();
    if (agentId === 'claude') {
      expect(resolved?.runtimeSelection).toMatchObject({ sessionConfigOptionOverrides: {
        v: 1, updatedAt: 200, overrides: { quality: { updatedAt: 200, value: 'high' } },
      } });
    } else {
      expect(resolved?.runtimeSelection).not.toHaveProperty('sessionConfigOptionOverrides');
    }
  });

  it('projects authoritative workflow Session origin and depth from the Session record', async () => {
    mocks.fetchSessionById.mockResolvedValue({ ...session, origin: { kind: 'run_step', runId: 'run-1' }, workDepth: 3 });
    await expect(resolveWorkflowSessionConversation({ credentials, sessionId, machineId: 'machine-1' }))
      .resolves.toMatchObject({ origin: { kind: 'run_step', runId: 'run-1' }, workDepth: 3 });
  });

  it('refuses missing owner metadata rather than using presentation or plaintext as owner authority', async () => {
    const refused: unknown[] = [];
    mocks.fetchSessionById.mockResolvedValue({ ...session, ownerMetadata: undefined,
      metadata: JSON.stringify({ v: 1, summary: { text: '/invented/path', updatedAt: 1 } }) });
    await expect(resolveWorkflowSessionConversation({ credentials, sessionId, machineId: 'machine-1',
      onUnavailable: (details) => { refused.push(details); } })).resolves.toBeNull();
    expect(refused).toMatchObject([{ reason: 'owner_metadata_unavailable' }]);
    mocks.fetchSessionById.mockResolvedValue({ ...session, ownerMetadata: { t: 'encrypted', c: 'invalid' } });
    await expect(resolveWorkflowSessionConversation({ credentials, sessionId, machineId: 'machine-1',
      onUnavailable: (details) => { refused.push(details); } })).resolves.toBeNull();
    expect(refused).toMatchObject([{ reason: 'owner_metadata_unavailable' }, { reason: 'owner_metadata_unavailable' }]);
  });

  it.each([
    ['session_unavailable', null],
    ['workspace_unavailable', { ...session, ownerMetadata: { t: 'plain', v: { v: 1, workspace: { machineId: 'machine-1' } } } }],
    ['account_scope_unavailable', { ...session, encryptionMode: 'e2ee', dataEncryptionKey: null }],
  ])('reports authenticated reuse reader check %s without changing its null refusal', async (reason, record) => {
    mocks.fetchSessionById.mockResolvedValue(record);
    const refused: unknown[] = [];
    await expect(resolveWorkflowSessionConversation({ credentials, sessionId, machineId: 'machine-1',
      onUnavailable: (details) => { refused.push(details); } })).resolves.toBeNull();
    expect(refused).toMatchObject([{ reason }]);
  });
  it('reports authenticated reuse reader check session_identity_mismatch for a prefix that resolves to another exact id', async () => {
    vi.mocked(axios.get).mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v2/sessions' || path === '/v2/sessions/archived') return { status: 200,
        data: { sessions: path.endsWith('/archived') ? [] : [createCompactSessionListRowFixture(createSessionNotificationContextFixture(sessionId))],
          nextCursor: null, hasNext: false } };
      throw new Error(`Unexpected Session lookup read: ${path}`);
    });
    const refused: unknown[] = [];
    await expect(resolveWorkflowSessionConversation({ credentials, sessionId: 'c123', machineId: 'machine-1',
      onUnavailable: (details) => { refused.push(details); } })).resolves.toBeNull();
    expect(refused).toMatchObject([{ reason: 'session_identity_mismatch', expected: { ids: ['c123'] }, observed: { ids: [sessionId] } }]);
  });

  it('accepts only the origin input owner withdrawal answer and never infers it from absence', async () => {
    mocks.callSessionRpc.mockResolvedValue('withdrawn');
    await expect(withdrawWorkflowOriginSessionInput({ credentials, sessionId, machineId: 'machine-1', localInputId: 'step-1' }))
      .resolves.toBe('withdrawn');
    mocks.callSessionRpc.mockResolvedValue('dispatched');
    await expect(withdrawWorkflowOriginSessionInput({ credentials, sessionId, machineId: 'machine-1', localInputId: 'step-1' }))
      .resolves.toBe('dispatched');
    mocks.callSessionRpc.mockResolvedValue({ ok: false, error: 'unsupported' });
    await expect(withdrawWorkflowOriginSessionInput({ credentials, sessionId, machineId: 'machine-1', localInputId: 'step-1' }))
      .rejects.toMatchObject({ code: 'workflow_origin_input_withdrawal_unavailable' });
    mocks.fetchSessionById.mockResolvedValue(null);
    await expect(withdrawWorkflowOriginSessionInput({ credentials, sessionId, machineId: 'machine-1', localInputId: 'step-1' }))
      .rejects.toMatchObject({ code: 'workflow_conversation_unavailable' });
  });

  it('requests only the dispatched origin exact turn and keeps non-current replies unresolved', async () => {
    mocks.callSessionRpc.mockResolvedValue({ ok: true, status: 'cancelled', sessionId, localId: 'step-1' });
    await expect(cancelDispatchedWorkflowOriginSessionInput({ credentials, sessionId, machineId: 'machine-1', localInputId: 'step-1' }))
      .resolves.toBeUndefined();
    expect(mocks.callSessionRpc).toHaveBeenLastCalledWith(expect.objectContaining({
      request: { sessionId, localId: 'step-1' },
    }));
    mocks.callSessionRpc.mockResolvedValue({ ok: false, status: 'notCurrent', sessionId, localId: 'step-1' });
    await expect(cancelDispatchedWorkflowOriginSessionInput({ credentials, sessionId, machineId: 'machine-1', localInputId: 'step-1' }))
      .rejects.toMatchObject({ code: 'workflow_origin_input_stop_unavailable' });
  });
});

describe('production daemon Workflow bootstrap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(['published', 'explicit'] as const)('reads credentialed currentness through the %s endpoint', async target => {
    const published = 'http://127.0.0.1:43187';
    const admitted = 'http://127.0.0.1:43188';
    const endpoint = target === 'explicit' ? admitted : published;
    const release = publishServerHttpRuntimeOrigin(published, 'iroh');
    const tokenId = '8f250f0e-4f31-4f7d-8f68-61638b73b526';
    const request = vi.spyOn(axios, 'request').mockImplementation(async request => {
      const url = new URL(String(request.url));
      if (url.origin !== endpoint) throw new Error('Workflow currentness endpoint is unreachable');
      expect(url.pathname).toBe(ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1);
      return { status: 200, data: { tokens: [{ tokenId, label: 'automation', displayPrefix: 'hap_v1_8f250f0e',
        createdAt: '2026-01-01T00:00:00.000Z', lastUsedAt: null, expiresAt: null,
        hasEncryptionAccess: false, hasUnattendedTeamAccess: false, grant: API_TOKEN_FULL_GRANT_V1,
        parentTokenId: null, activeChildCount: 0, embedConfig: null }] } };
    });
    try {
      const current = createCredentialedWorkflowAcceptedAuthorizationCurrentness({
        credentials: { token: 'token', encryption: null }, accountId: 'account-1',
        ...(target === 'explicit' ? { serverHttpBaseUrl: admitted } : {}),
      });
      await expect(current({ authorization: { admittedPermissionCeiling: 'default',
        principal: { kind: 'api', accountId: 'account-1', principalId: 'account-1', credentialId: tokenId } } }))
        .resolves.toBe(true);
      expect(request).toHaveBeenCalled();
    } finally {
      request.mockRestore();
      release();
    }
  });

  it('keeps a transport failure unknown and still refuses an authoritative missing token', async () => {
    const failure = new Error('authorization transport disconnected');
    let unavailable = true;
    const isCurrent = createWorkflowAcceptedAuthorizationCurrentness({
      accountId: 'account-1',
      listAccountApiTokens: async () => {
        if (unavailable) throw failure;
        return { tokens: [] };
      },
      resolveCurrentPluginOccurrenceId: async () => null,
      resolveCurrentPluginSourceCustody: async () => null,
      isMediatedSourceCurrent: async () => false,
    });
    const authorization = { admittedPermissionCeiling: 'default' as const,
      principal: { kind: 'api' as const, accountId: 'account-1', principalId: 'account-1', credentialId: 'missing-token' } };
    await expect(isCurrent({ authorization })).rejects.toBe(failure);
    unavailable = false;
    await expect(isCurrent({ authorization })).resolves.toBe(false);
  });

  it('retains accepted Session attribution after its origin disappears, without bypassing source revocation', async () => {
    mocks.fetchSessionById.mockResolvedValue(null);
    const isCurrent = createWorkflowAcceptedAuthorizationCurrentness({
      accountId: 'account-1',
      listAccountApiTokens: async () => ({ tokens: [] }),
      resolveCurrentPluginOccurrenceId: async () => 'current-mediator',
      resolveCurrentPluginSourceCustody: async () => null,
      isMediatedSourceCurrent: async () => false,
    });
    const principal = { kind: 'session' as const, sessionId: 'deleted-origin-session' };
    await expect(isCurrent({ authorization: { admittedPermissionCeiling: 'default', principal } }))
      .resolves.toBe(true);
    await expect(isCurrent({ authorization: { admittedPermissionCeiling: 'default', principal,
      sourceAuthority: { mediatorPluginId: 'happier.channels', sourceRef: 'channels:binding:binding-1',
        sourceRevisionOrEpoch: '4:7', remoteApprovalMaxScope: 'session' } } }))
      .resolves.toBe(false);
  });

  it('revalidates only revocable API and plugin principals at the canonical owners', async () => {
    const tokenId = '8f250f0e-4f31-4f7d-8f68-61638b73b526';
    const listAccountApiTokens = vi.fn(async (): Promise<AccountApiTokensListActionOutputV1> => ({
      tokens: [{
        tokenId,
        label: 'automation',
        displayPrefix: 'hap_v1_8f250f0e',
        createdAt: '2026-01-01T00:00:00.000Z',
        lastUsedAt: null,
        expiresAt: '2026-01-03T00:00:00.000Z',
        hasEncryptionAccess: false,
        hasUnattendedTeamAccess: false,
        grant: API_TOKEN_FULL_GRANT_V1,
        parentTokenId: null,
        activeChildCount: 0,
        embedConfig: null,
      }],
    }));
    const resolveCurrentPluginOccurrenceId = vi.fn(
      async (): Promise<string | null> => 'generation-1',
    );
    const pluginSourceCustody = {
      kind: 'development' as const,
      registeredRootId: 'happier-example-root',
    };
    const resolveCurrentPluginSourceCustody = vi.fn(async () => pluginSourceCustody);
    const isMediatedSourceCurrent = vi.fn(async (): Promise<boolean> => true);
    const isCurrent = createWorkflowAcceptedAuthorizationCurrentness({
      accountId: 'account-1',
      listAccountApiTokens,
      resolveCurrentPluginOccurrenceId,
      resolveCurrentPluginSourceCustody,
      isMediatedSourceCurrent,
      now: () => Date.parse('2026-01-02T00:00:00.000Z'),
    });

    await expect(isCurrent({
      authorization: {
        admittedPermissionCeiling: 'default',
        principal: { kind: 'api', accountId: 'account-1', principalId: 'account-1', credentialId: tokenId },
      },
    })).resolves.toBe(true);
    await expect(isCurrent({
      authorization: {
        admittedPermissionCeiling: 'default',
        principal: { kind: 'api', accountId: 'account-2', principalId: 'account-2', credentialId: tokenId },
      },
    })).resolves.toBe(false);
    await expect(isCurrent({
      authorization: {
        admittedPermissionCeiling: 'default',
        principal: { kind: 'api', accountId: 'account-1', principalId: 'other-principal', credentialId: tokenId },
      },
    })).resolves.toBe(false);
    const afterExpiry = createWorkflowAcceptedAuthorizationCurrentness({
      accountId: 'account-1',
      listAccountApiTokens,
      resolveCurrentPluginOccurrenceId,
      resolveCurrentPluginSourceCustody,
      isMediatedSourceCurrent,
      now: () => Date.parse('2026-01-04T00:00:00.000Z'),
    });
    await expect(afterExpiry({
      authorization: {
        admittedPermissionCeiling: 'default',
        principal: { kind: 'api', accountId: 'account-1', principalId: 'account-1', credentialId: tokenId },
      },
    })).resolves.toBe(false);
    await expect(isCurrent({
      authorization: {
        admittedPermissionCeiling: 'default',
        principal: { kind: 'plugin', pluginId: 'happier.example', sourceCustody: pluginSourceCustody },
      },
    })).resolves.toBe(true);
    await expect(isCurrent({
      authorization: {
        admittedPermissionCeiling: 'default',
        principal: { kind: 'plugin', pluginId: 'happier.example',
          sourceCustody: { ...pluginSourceCustody, registeredRootId: 'retired-example-root' } },
      },
    })).resolves.toBe(false);
    await expect(isCurrent({
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
    })).resolves.toBe(true);
    await expect(isCurrent({
      authorization: {
        admittedPermissionCeiling: 'read-only',
        principal: { kind: 'host' },
        sourceAuthority: {
          mediatorPluginId: 'happier.channels',
          sourceRef: 'channels:binding:binding-1',
          sourceRevisionOrEpoch: '4:7',
          remoteApprovalMaxScope: 'session',
        },
      },
    })).resolves.toBe(true);
    isMediatedSourceCurrent.mockResolvedValueOnce(false);
    await expect(isCurrent({
      authorization: {
        admittedPermissionCeiling: 'read-only',
        principal: { kind: 'host' },
        sourceAuthority: {
          mediatorPluginId: 'happier.channels',
          sourceRef: 'channels:binding:binding-1',
          sourceRevisionOrEpoch: '4:7',
          remoteApprovalMaxScope: 'session',
        },
      },
    })).resolves.toBe(false);
    resolveCurrentPluginOccurrenceId.mockResolvedValueOnce(null);
    await expect(isCurrent({
      authorization: {
        admittedPermissionCeiling: 'read-only',
        principal: { kind: 'host' },
        sourceAuthority: {
          mediatorPluginId: 'happier.channels',
          sourceRef: 'channels:binding:binding-1',
          sourceRevisionOrEpoch: '4:7',
          remoteApprovalMaxScope: 'session',
        },
      },
    })).resolves.toBe(false);
    expect(listAccountApiTokens).toHaveBeenCalledTimes(2);
    expect(resolveCurrentPluginOccurrenceId).toHaveBeenCalledTimes(3);
    expect(resolveCurrentPluginSourceCustody).toHaveBeenCalledTimes(2);
    expect(isMediatedSourceCurrent).toHaveBeenCalledTimes(2);
  });

  it('observes an exact Session input without requiring an execution provider handle', async () => {
    const execute = vi.fn();
    const observeSession = vi.fn(async () => ({
      ok: true as const,
      sessionId: 'session-1',
      localId: 'input-1',
      result: { kind: 'final_text' as const, text: 'done' },
    }));
    const observe = createWorkflowInvocationRecoveryObserver({
      credentials: { token: 'token' } as never,
      machineId: 'machine-1',
      actionExecutor: { execute } as never,
      observeSession,
      cancelSession: vi.fn(),
      now: () => 123,
    });

    await expect(observe({
      terminalParent: true,
      cancellationRequested: false,
      progress: {
        kind: 'happier.workflow-progress.v1',
        invocationPath: { blockId: 'step', scope: [] },
        blockKind: 'step',
        attempt: '0',
        logicalInvocationRecordId: '2aaf1a39-4c48-4904-83a4-7eae318dfc2c',
        execution: { kind: 'session', sessionId: 'session-1', localInputId: 'input-1' },
      },
    })).resolves.toEqual({ kind: 'completed', result: 'done' });
    expect(observeSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1', localId: 'input-1', deadlineMs: 123,
    }));
    expect(execute).not.toHaveBeenCalled();
  });

  it('keeps Session turn cancellation-request custody unresolved until the exact turn is terminal', async () => {
    const sessionId = 'c111111111111111111111111';
    mocks.fetchAccountEncryptionCurrentness.mockResolvedValue({ mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
    mocks.fetchSessionById.mockResolvedValue(createSessionRecordFixture({ id: sessionId, active: true, encryptionMode: 'plain',
      metadata: JSON.stringify({ machineId: 'machine-1', path: '/repo' }) }));
    const observeSession = vi.fn(async () => ({
      ok: true as const,
      sessionId,
      localId: 'input-1',
      result: { kind: 'pending' as const },
    }));
    const cancelSession = vi.fn(async () => ({ kind: 'turn_cancel_requested' as const }));
    const observe = createWorkflowInvocationRecoveryObserver({
      credentials: { token: 'token', encryption: null },
      machineId: 'machine-1',
      actionExecutor: { execute: vi.fn() } as never,
      observeSession,
      cancelSession,
      now: () => 123,
    });

    await expect(observe({
      terminalParent: false,
      cancellationRequested: true,
      progress: {
        kind: 'happier.workflow-progress.v1',
        invocationPath: { blockId: 'step', scope: [] },
        blockKind: 'step',
        attempt: '0',
        logicalInvocationRecordId: '2aaf1a39-4c48-4904-83a4-7eae318dfc2c',
        workspace: { descriptor: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } },
        execution: { kind: 'session', sessionId, localInputId: 'input-1' },
      },
    })).resolves.toMatchObject({
      kind: 'unresolved',
      code: 'session_input_turn_cancel_requested',
      waitForCompletion: expect.any(Function),
    });
    expect(cancelSession).toHaveBeenCalledOnce();
  });

  it('uses only exact Execution Run get and stop owners for pending terminal custody', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ ok: true, result: { run: true } })
      .mockResolvedValueOnce({ ok: true, result: { status: 'stopped' } });
    const observeRun = vi.fn(async ({ get }: Readonly<{ get: (request: Readonly<{ runId: string; includeStructured: false }>) => Promise<unknown> }>) => {
      await get({ runId: 'execution-run-1', includeStructured: false });
      return { kind: 'pending' as const };
    });
    const observe = createWorkflowInvocationRecoveryObserver({
      credentials: { token: 'token' } as never,
      machineId: 'machine-1',
      actionExecutor: { execute } as never,
      observeRun: observeRun as never,
    });

    await expect(observe({
      terminalParent: true,
      cancellationRequested: false,
      progress: {
        kind: 'happier.workflow-progress.v1',
        invocationPath: { blockId: 'step', scope: [] },
        blockKind: 'step',
        attempt: '0',
        logicalInvocationRecordId: '2aaf1a39-4c48-4904-83a4-7eae318dfc2c',
        execution: { kind: 'detached_run', runId: 'execution-run-1', localInputId: 'input-1', runtimeSelection: {} },
      },
    })).resolves.toEqual({ kind: 'unresolved', code: 'workflow_outcome_unresolved' });
    expect(execute.mock.calls.map(([actionId]) => actionId)).toEqual([
      'execution.run.get',
      'execution.run.stop',
      'execution.run.get',
    ]);
    expect(execute).toHaveBeenNthCalledWith(1, 'execution.run.get', {
      sessionId: null, runId: 'execution-run-1', includeStructured: false,
    }, expect.objectContaining({ executionRunTargetMachineId: 'machine-1' }));
    expect(execute).toHaveBeenNthCalledWith(2, 'execution.run.stop', {
      sessionId: null, runId: 'execution-run-1',
    }, expect.objectContaining({ executionRunTargetMachineId: 'machine-1' }));
    expect(execute.mock.calls[1]?.[2]).not.toHaveProperty('signal');
    expect(execute.mock.calls[2]?.[2]).not.toHaveProperty('signal');
  });

  it('resolves stop custody from the definitive exact-input observation after the host accepts the stop', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ ok: true, result: { run: 'active' } })
      .mockResolvedValueOnce({ ok: true, result: { status: 'stopped' } })
      .mockResolvedValueOnce({ ok: true, result: { run: 'cancelled' } });
    const observeRun = vi.fn(async ({ get }: Readonly<{ get: (request: Readonly<{ runId: string; includeStructured: false }>) => Promise<unknown> }>) => {
      const response = await get({ runId: 'execution-run-1', includeStructured: false });
      return response && typeof response === 'object' && (response as { run?: unknown }).run === 'cancelled'
        ? { kind: 'cancelled' as const, code: 'execution_run_input_cancelled' }
        : { kind: 'pending' as const };
    });
    const observe = createWorkflowInvocationRecoveryObserver({
      credentials: { token: 'token' } as never,
      machineId: 'machine-1',
      actionExecutor: { execute } as never,
      observeRun: observeRun as never,
    });

    await expect(observe({
      terminalParent: false,
      cancellationRequested: true,
      progress: {
        kind: 'happier.workflow-progress.v1',
        invocationPath: { blockId: 'step', scope: [] },
        blockKind: 'step',
        attempt: '0',
        logicalInvocationRecordId: '2aaf1a39-4c48-4904-83a4-7eae318dfc2c',
        execution: { kind: 'detached_run', runId: 'execution-run-1', localInputId: 'input-1', runtimeSelection: {} },
      },
    })).resolves.toEqual({ kind: 'cancelled', code: 'execution_run_input_cancelled' });
    expect(execute.mock.calls.map(([actionId]) => actionId)).toEqual([
      'execution.run.get',
      'execution.run.stop',
      'execution.run.get',
    ]);
  });
});
