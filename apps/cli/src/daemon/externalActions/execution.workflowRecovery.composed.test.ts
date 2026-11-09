import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import type { startDaemonControlServer } from '@/daemon/controlServer';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import { createWorkflowRunStorageTestkit } from '@/daemon/workflows/workflowRunStorage.testkit';
import { retainExecutionRunState } from '@/daemon/executionRunRegistry';
import { executeExternalAction } from './executeExternalAction';
import { encodeStoredCredentials } from '@/persistence';
import { configuration } from '@/configuration';
import { seedTestServerProfile } from '@/testkit/serverProfiles';
import {
  ExecutionRunGetResponseSchema, FeaturesResponseSchema, WorkflowDefinitionV1Schema,
  materializeWorkflowAcceptedSnapshotV1, sealWorkflowAcceptedSnapshotStoredEnvelopeV1,
  sealWorkflowCheckpointStoredEnvelopeV1, sealWorkflowProgressStoredEnvelopeV1,
  serializeWorkflowStoredContentEnvelopeV1,
} from '@happier-dev/protocol';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeV1Schema,
  ExternalActionResponseEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { sealExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

const boundary = vi.hoisted(() => ({ control: null as Parameters<typeof startDaemonControlServer>[0] | null }));
// The private listener is an OS boundary. Requester custody, installed dispatch,
// native persistence/recovery and the Workflow recovery decision remain real.
vi.mock('@/daemon/controlServer', () => ({ startDaemonControlServer: async (input: Parameters<typeof startDaemonControlServer>[0]) => {
  boundary.control = input;
  return { port: 43129, stop: async () => {} };
} }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); boundary.control = null; });

it('reads exact failed native input recovery through the installed signed UI invocation reader', async () => {
  const homeId = 'srv_workflow_recovery';
  const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'requester', tokenEpoch: 0,
    provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`, encryption: null };
  const installedCredentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'requester', tokenEpoch: 0,
    provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`, encryption: null };
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, undefined, true, undefined, undefined, {
    credentials: installedCredentials, accountActionCredentials: installedCredentials, requesterCredentials: installedCredentials,
    externalActionAccountId: 'requester', ordinaryAccountSession: true, homeServerIdentityId: homeId,
    machineAccess: { custodianAccountId: 'requester', role: 'manage' },
    resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: homeId, machineId: 'machine' }),
  });
  const serverId = configuration.activeServerId;
  await seedTestServerProfile({ id: serverId, homeId, serverUrl: 'https://session-home.test' });
  vi.stubEnv('HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED', '1');
  const features = FeaturesResponseSchema.parse({ features: {
    automations: { enabled: true }, workflows: { enabled: true } }, capabilities: { serverIdentity: { serverIdentityId: homeId } } });
  const originalFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (url: Parameters<typeof fetch>[0], options?: RequestInit) =>
    ['/v1/features', '/v1/features/authenticated'].includes(new URL(String(url)).pathname)
      ? Response.json(features) : await originalFetch(url, options));
  const runId = 'f132a063-1031-4a7c-8c92-01d0fa231203';
  const invocationId = '34141d15-4f5e-4315-bf1b-ddfaa6ccd42c';
  const rootId = 'cd1f7a2d-ac89-4156-96b8-9fb18f57d705';
  const nativeRunId = 'run-workflow-recovery';
  const localInputId = 'workflow-input-exact';
  const accepted = await materializeWorkflowAcceptedSnapshotV1({
    definition: WorkflowDefinitionV1Schema.parse({ version: 1, defaults: {
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
    }, blocks: [{ kind: 'step', id: 'detached-positive', document: { text: 'Inspect.', references: [], attachments: [] } }] }),
    context: { source: { kind: 'inline' }, machineId: 'machine', executionTarget: { kind: 'detached_run' },
      workspaceTarget: { project: { machineId: 'machine', directory: h.cwd, checkoutRootPath: h.cwd } },
      origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } } },
    admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true },
  });
  if (!accepted.ok) throw new Error(accepted.error.code);
  const storage = createWorkflowRunStorageTestkit({ runId, machineId: 'machine', accountId: 'requester', origin: { kind: 'direct' },
    acceptedEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'requester', runId }, acceptedSnapshot: accepted.snapshot })) });
  const checkpointEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({ mode: 'plain',
    binding: { v: 1, purpose: 'checkpoint', accountId: 'requester', runId },
    checkpoint: { kind: 'happier.workflow-checkpoint.v1', rootRecordId: rootId, nextSequence: '2', frontier: { nextBlockOrdinal: 0, paused: false } } }));
  const sealProgress = (recordId: string, sequence: string, parentRecordId: string | null, progress: Parameters<typeof sealWorkflowProgressStoredEnvelopeV1>[0]['progress']) =>
    serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'invocation_progress', accountId: 'requester', runId, recordId, sequence, parentRecordId, memberOrdinal: '0', attempt: '0' }, progress }));
  await storage.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope,
    rootInvocation: { id: rootId, contentEnvelope: sealProgress(rootId, '0', null, {
      kind: 'happier.workflow-progress.v1', blockKind: 'root', attempt: '0',
      invocationPath: { blockId: '$root', scope: [] }, logicalInvocationRecordId: rootId }) } });
  await storage.execute({ operation: 'invocations.admit', runId, expectedRevision: storage.run().revision, checkpointEnvelope,
    invocations: [{ id: invocationId, sequence: '1', parentRecordId: rootId, memberOrdinal: '0', lifecycle: 'failed',
      contentEnvelope: sealProgress(invocationId, '1', rootId, { kind: 'happier.workflow-progress.v1', blockKind: 'step', attempt: '0',
        invocationPath: { blockId: 'detached-positive', scope: [] }, logicalInvocationRecordId: invocationId,
        workspace: { descriptor: { machineId: 'machine', directory: h.cwd, checkoutRootPath: h.cwd } }, reason: { code: 'no_eligible_member' },
        execution: { kind: 'detached_run', runId: nativeRunId, localInputId, runtimeSelection: {} } }) }] });
  await storage.execute({ operation: 'transition', runId, expectedRevision: storage.run().revision, state: 'interrupted', checkpointEnvelope });
  // Exercise the real encrypted device-local native producer and cold reader.
  // No provider process is needed to read an already retained settled input.
  await retainExecutionRunState({ runId: nativeRunId, callId: 'call', sidechainId: 'side', sessionId: null, depth: 0,
    intent: 'delegate', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, backendId: 'codex', instructions: '',
    permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'request_response',
    status: 'failed', startedAtMs: 1, finishedAtMs: 2, error: { code: 'no_eligible_member', message: 'Unavailable' },
    inputTurns: { occurrenceId: 'occurrence', last: { turnId: 'turn', inputIds: [localInputId], state: 'failed' } } });
  const native = ExecutionRunGetResponseSchema.parse(await h.machine.invokeLocalMachineAction(SESSION_RPC_METHODS.EXECUTION_RUN_GET,
    { runId: nativeRunId, includeStructured: false }));
  expect(native.run.inputTurns?.last).toMatchObject({ inputIds: [localInputId], state: 'failed' });
  const httpPhases: Array<{ path: string; operation?: string; failureClass?: string }> = [];
  const basePost = vi.mocked(axios.post).getMockImplementation()!;
  vi.spyOn(axios, 'post').mockImplementation(async (url, body, options) => {
    const path = new URL(String(url)).pathname;
    const phase = { path, ...(body && typeof body === 'object' && 'operation' in body ? { operation: String(body.operation) } : {}) };
    httpPhases.push(phase);
    if (path.endsWith('/verify')) return { status: 200, data: { ok: true } };
    if (body && typeof body === 'object' && 'operation' in body) {
      try { return { status: 200, data: await storage.execute(body as Parameters<typeof storage.execute>[0]) }; }
      catch (error) { httpPhases.push({ ...phase, failureClass: error instanceof Error ? error.name : typeof error }); throw error; }
    }
    return await basePost(url, body, options);
  });
  const owner = h.daemon.externalActionIngressOwner;
  if (!owner) throw new Error('Missing installed Action ingress');
  const target = { kind: 'machine' as const, machineId: 'machine' };
  const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: 'exact-invocation-read', target, input: { runId, invocationId } });
  const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fixture-root', binding: {
    serverIdentityId: homeId, accountId: 'requester', custodianAccountId: 'requester', authentication: { kind: 'account', tokenEpoch: 0 },
    accountEncryptionMode: 'plain', actionId: 'workflow.run.invocations.get', requestId: envelope.requestId,
    machineId: 'machine', installationId: h.f.installation.installationId, target,
    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) } });
  const authorization = sealExternalActionRequesterAccountContextV1({ authorization: root, credentials: encodeStoredCredentials(credentials),
    purpose: { kind: 'external_action' }, installationPublicKey: Buffer.from(h.f.installation.publicKey, 'base64url'),
    randomBytes: length => new Uint8Array(length).fill(23), invocation: { surface: 'ui', authority: 'present_user', caller: { kind: 'host' } } });
  const nativeReads: Array<{ code?: string; status?: string; matchedInput?: boolean }> = [];
  const invoke = h.machine.invokeLocalMachineAction.bind(h.machine);
  vi.spyOn(h.machine, 'invokeLocalMachineAction').mockImplementation(async (method, request, options) => {
    const response = await invoke(method, request, options);
    if (method === SESSION_RPC_METHODS.EXECUTION_RUN_GET) {
      const parsed = ExecutionRunGetResponseSchema.safeParse(response);
      nativeReads.push(parsed.success ? { status: parsed.data.run.status,
        matchedInput: parsed.data.run.inputTurns?.last?.inputIds.includes(localInputId) }
        : { code: response && typeof response === 'object' && 'errorCode' in response ? String(response.errorCode) : 'invalid_response' });
    }
    return response;
  });
  const result = await executeExternalAction({ ...owner, actionId: 'workflow.run.invocations.get', envelope, executionAuthorization: authorization,
    principal: { accountId: 'requester', authority: 'present_user', authentication: { kind: 'account', tokenEpoch: 0 } },
    currentMachineId: 'machine', currentAccountId: 'requester', currentInstallationId: h.f.installation.installationId,
    verifyExecutionAuthorization: async () => true, signal: h.signal });
  const response = result.kind === 'response' ? ExternalActionResponseEnvelopeV1Schema.safeParse(result.response) : undefined;
  const execution = response?.success ? response.data.execution : undefined;
  const failureCode = result.kind === 'invalid_request' ? result.errorCode : execution && !execution.ok ? execution.errorCode : undefined;
  expect({ kind: result.kind, failureCode }, JSON.stringify({ httpPhases, storage: storage.operations(), nativeReads }))
    .toEqual({ kind: 'response', failureCode: undefined });
  expect(nativeReads.length).toBeGreaterThan(0);
  expect(nativeReads.every(read => read.code === undefined && read.status === 'failed' && read.matchedInput === true)).toBe(true);
  const detail = execution?.ok ? execution.result : undefined;
  const availability = detail && typeof detail === 'object' && 'invocation' in detail
    && detail.invocation && typeof detail.invocation === 'object' && 'recoveryAvailability' in detail.invocation
    ? detail.invocation.recoveryAvailability : undefined;
  expect(availability).toMatchObject({ retry: { kind: 'available' }, continueFreshAgent: { kind: 'available' } });
});
