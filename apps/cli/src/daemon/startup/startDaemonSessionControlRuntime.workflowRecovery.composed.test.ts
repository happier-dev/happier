import axios from 'axios';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { materializeWorkflowAcceptedSnapshotV1, sealWorkflowAcceptedSnapshotStoredEnvelopeV1,
  sealWorkflowCheckpointStoredEnvelopeV1, sealWorkflowProgressStoredEnvelopeV1,
  serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol';
import type { startDaemonControlServer } from '@/daemon/controlServer';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import { startAutomationWorker } from '@/daemon/automation/automationWorker';
import { createDaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { createWorkflowRunRecoveryReader } from '@/daemon/workflows/recovery';
import { createWorkflowRunStorageTestkit } from '@/daemon/workflows/workflowRunStorage.testkit';
import { acquireWorkflowRequesterCredentials, listWorkflowRequesterCredentialScopes,
  retainWorkflowRequesterCredentials } from '@/daemon/workflows/requesterCustody';
import type { Update } from '@/api/types';

const boundary = vi.hoisted(() => ({ control: null as Parameters<typeof startDaemonControlServer>[0] | null }));
// The OS listener is the only daemon service substituted; installed requester custody stays real.
vi.mock('@/daemon/controlServer', async original => ({ ...await original<typeof import('@/daemon/controlServer')>(),
  startDaemonControlServer: async (input: Parameters<typeof startDaemonControlServer>[0]) => {
    boundary.control = input;
    return { port: 43128, stop: async () => {} };
  } }));
afterEach(() => { vi.restoreAllMocks(); boundary.control = null; });

it('recovers a terminal pending direct Run after restart with its installed guest custody and retires only after settlement', async () => {
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, undefined, true);
  const guest = h.requester.bootstrap;
  const host = { ...guest.attribution, accountId: 'custodian' };
  const runId = '6907b014-b334-443e-9e27-9bc80f23df14';
  const scope = { happyHomeDir: h.f.directory, serverId: host.serverId, machineId: host.machineId,
    installationId: host.installationId, scopeId: runId,
    homeServerIdentityId: guest.homeServerIdentityId, serverHttpBaseUrl: guest.serverHttpBaseUrl };
  await retainWorkflowRequesterCredentials({ scopeId: runId, happyHomeDir: h.f.directory,
    attribution: guest.attribution, credentials: guest.credentials, homeServerIdentityId: guest.homeServerIdentityId });
  const accepted = await materializeWorkflowAcceptedSnapshotV1({
    definition: { version: 1, inputs: [], defaults: { agentTarget: { kind: 'agent',
      identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } }, blocks: [
      { kind: 'step', id: 'work', document: { text: 'Work', references: [], attachments: [] } }] },
    context: { source: { kind: 'inline' }, inputs: {}, machineId: host.machineId,
      executionTarget: { kind: 'session' }, workspaceTarget: { project: { machineId: host.machineId,
        directory: h.cwd, checkoutRootPath: h.cwd } }, origin: { kind: 'direct' },
      authorization: { principal: { kind: 'host' } } }, admission: { kind: 'user' },
    effects: { resolveTargetAvailability: async () => true } });
  if (!accepted.ok) throw new Error(`Recovery fixture admission failed: ${accepted.error.code}`);
  const accountId = guest.attribution.accountId;
  const storage = createWorkflowRunStorageTestkit({ accountId, machineId: host.machineId, runId,
    origin: { kind: 'direct' }, acceptedEnvelope: serializeWorkflowStoredContentEnvelopeV1(
      sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain', binding: {
        v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: accepted.snapshot })) });
  const checkpointEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({
    mode: 'plain', binding: { v: 1, purpose: 'checkpoint', accountId, runId }, checkpoint: {
      kind: 'happier.workflow-checkpoint.v1', rootRecordId: 'root', nextSequence: '1',
      frontier: { nextBlockOrdinal: 0, paused: false } } }));
  const contentEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
    mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: 'root',
      sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' }, progress: {
      kind: 'happier.workflow-progress.v1', blockKind: 'root', invocationPath: { blockId: '$root', scope: [] },
      attempt: '0', logicalInvocationRecordId: 'root' } }));
  await storage.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope,
    rootInvocation: { id: 'root', contentEnvelope } });
  storage.requestControl('cancelled');
  expect(storage.run()).toMatchObject({ state: 'cancelled', workflowCustodyState: 'pending' });
  const previousGet = vi.mocked(axios.get).getMockImplementation();
  const previousPost = vi.mocked(axios.post).getMockImplementation();
  const readAccounts: string[] = [];
  vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
    if (String(url).endsWith('/worker/run-lifecycle')) return { status: 200, data: { sources: [] } };
    if (String(url).endsWith('/worker/assignments')) return { status: 200, data: { assignments: [],
      settings: { maxActiveRunsPerMachine: 1 } } };
    if (!previousGet) throw new Error('Missing fixture Home GET');
    return await previousGet(url, options);
  });
  vi.spyOn(axios, 'post').mockImplementation(async (url, body, options) => {
    if (String(url).endsWith('/workflow-storage')) {
      if (!body || typeof body !== 'object' || !('operation' in body) || body.operation !== 'list') {
        throw new Error('Unexpected retirement storage operation');
      }
      const selected = options?.headers?.Authorization === `Bearer ${guest.credentials.token}`;
      readAccounts.push(selected ? 'guest' : 'custodian');
      if (!selected) throw new Error('Guest Run read as custodian');
      return { status: 200, data: { runs: [storage.run()] } };
    }
    if (String(url).endsWith('/runs/claim')) return { status: 200, data: { run: null, automation: null, accountCurrentness: null } };
    if (!previousPost) throw new Error('Missing fixture Home POST');
    return await previousPost(url, body, options);
  });
  const drain = createDaemonAdmissionDrain();
  const releaseDrain = drain.beginTemporaryDrain();
  onTestFinished(releaseDrain);
  let resumed = false;
  const worker = startAutomationWorker({ token: 'custodian-token', credentials: { token: 'custodian-token', encryption: null },
    machineId: host.machineId, requesterWorkAttributionV1: host, requesterHomeServerIdentityId: guest.homeServerIdentityId,
    admissionDrain: drain,
    recoverWorkflowRuns: async (selectedRunId, requester) => {
      if (!requester || selectedRunId !== runId) throw new Error('Missing exact guest recovery');
      expect(requester.credentials.token === guest.credentials.token).toBe(true);
      expect(requester.attribution).toEqual(guest.attribution);
      const retained = await acquireWorkflowRequesterCredentials(scope);
      expect(retained).not.toBeNull();
      await retained?.release();
      const recover = createWorkflowRunRecoveryReader({ accountId: requester.attribution.accountId,
        machineId: host.machineId, storage: { execute: async (operation, options) => operation.operation === 'recovery.list'
          ? { candidates: storage.run().workflowCustodyState === 'pending' ? [{ run: storage.run(), parentAttempt: 0 }] : [] }
          : await storage.execute(operation, options) },
        resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
        reconcileInvocation: async () => { throw new Error('Structural recovery must not execute a child'); } });
      await recover('reconnect', undefined, runId);
      resumed = true;
    } });
  onTestFinished(() => worker.stop());
  await worker.catchUp();
  worker.handleServerUpdate({ id: 'reconnect-terminal-pending', seq: 1, createdAt: Date.now(), body: {
    t: 'automation-run-updated', runId, automationId: null, requesterScope: { kind: 'workflow_trigger', id: runId },
    targetMachineId: host.machineId, machineId: host.machineId, state: 'cancelled', scheduledAt: 1,
    startedAt: 1, finishedAt: 2, updatedAt: 2,
  } } satisfies Update);
  await expect.poll(() => resumed).toBe(true);
  expect(storage.run()).toMatchObject({ state: 'cancelled', workflowCustodyState: 'settled' });
  await expect.poll(async () => (await listWorkflowRequesterCredentialScopes(scope)).bindings
    .some(binding => binding.sessionId === runId)).toBe(false);
  expect(readAccounts.length).toBeGreaterThan(0);
  expect(readAccounts.every(account => account === 'guest')).toBe(true);
});
