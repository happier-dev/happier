import { createExternalSessionActionOperationOwner, projectExternalSessionActionOperation } from '@/session/actions/externalSessions/actionOperationOwner';
import { createExternalSessionMaterializeActionExecutor } from '@/session/actions/externalSessions/materializeAction';
import { createExternalSessionOperationExclusion } from '@/session/external/operationExclusion';
import { createExternalSessionOperationPrivateStagingStore } from '@/session/external/staging/operationPrivateStaging';
import { readExternalSessionOperationRecord } from '@/session/actions/externalSessions/operationRecordStore';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExternalSessionOperationRecordV1Schema, resolveExternalSessionOperationTimelineV1, type ExternalSessionOperationRecordV1 } from '@happier-dev/protocol';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { acknowledgeExternalSessionOperationProgressProjection, compactExternalSessionOperationRecordToTerminalReceipt, mutateExternalSessionOperationRecordAtRevision, writeExternalSessionOperationRecord } from '@/session/actions/externalSessions/operationRecordStore';
import { registerMachineExternalSessionsRpcHandlers } from './rpcHandlers.externalSessions';
import type { ActionOperationDomainOwner } from '@/daemon/actionOperations/actionOperationTypes';
import { buildSessionMetadataEnvelopeFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { createHostExternalSessionActionAdapter } from '@/session/actions/externalSessions/hostExternalSessionActionTransport';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

const environment = vi.hoisted(() => ({ activeServerDir: '', accountId: 'account-1' as string | null,
  afterCredentialRead: null as (() => void) | null,
  session: null as null | { id: string; metadata: string; metadataVersion: number; metadataLayoutVersion: 1;
    ownerMetadata: import('@happier-dev/protocol').SessionOwnerMetadataEnvelopeV1;
    agentState: string | null; agentStateVersion: number; encryptionMode: 'plain' },
}));
// Configuration and credential storage are genuine environment boundaries.
vi.mock('@/configuration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configuration')>();
  return { ...actual, configuration: { ...actual.configuration, get activeServerDir() { return environment.activeServerDir; } } };
});
vi.mock('@/persistence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/persistence')>();
  return { ...actual, readStoredCredentials: async () => {
    const credentials = environment.accountId ? ({
      token: `e30.${Buffer.from(JSON.stringify({ sub: environment.accountId })).toString('base64url')}.signature`,
      encryption: null,
    }) : null;
    environment.afterCredentialRead?.();
    return credentials;
  } };
});

// The boot/reconnect repair path runs real owner logic; HTTP session lookup is offline in this fixture.
vi.mock('@/session/transport/http/sessionsHttp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>();
  return { ...actual, fetchSessionById: async (request: Parameters<typeof actual.fetchSessionById>[0]) => {
      if (environment.session && request.token !== 'e30.eyJzdWIiOiJhY2NvdW50LTEifQ.signature') throw new Error('Wrong Account Session read');
      return environment.session;
    },
    patchSessionMetadataEnvelopeTuple: async (request: Parameters<typeof actual.patchSessionMetadataEnvelopeTuple>[0]) => {
      const session = environment.session;
      if (!session || request.patch.mode !== 'owner') throw new Error('Unexpected Session tuple write');
      if (request.token !== 'e30.eyJzdWIiOiJhY2NvdW50LTEifQ.signature') throw new Error('Wrong Account Session write');
      session.metadata = request.patch.sharedMetadata.ciphertext;
      session.ownerMetadata = request.patch.ownerMetadata;
      session.agentState = request.patch.agentState.ciphertext;
      session.metadataVersion += 1;
      session.agentStateVersion += 1;
      return { success: true as const, metadataLayoutVersion: 1 as const,
        sharedMetadata: { version: session.metadataVersion }, ownerMetadata: { version: session.metadataVersion },
        agentState: { version: session.agentStateVersion } };
    },
  };
});

vi.mock('@/api/client/connectedServiceCredentialApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client/connectedServiceCredentialApi')>();
  return { ...actual, fetchAccountEncryptionCurrentness: async () => ({
    mode: 'plain' as const, version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
  }) };
});

const roots: string[] = [];
const registrations: ReturnType<typeof registerMachineExternalSessionsRpcHandlers>[] = [];
afterEach(async () => {
  environment.afterCredentialRead = null;
  environment.accountId = 'account-1';
  environment.session = null;
  for (const registration of registrations.splice(0)) await registration.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function record(): ExternalSessionOperationRecordV1 {
  const request: ExternalSessionOperationRecordV1['request'] = {
    v: 1, idempotencyKey: 'activity-import-1', sessionId: 'session-1',
    source: { machineId: 'machine-1', remoteSessionId: 'remote-1',
      qualifiedIdentity: { v: 1, agent: { pluginId: 'example.plugin', localId: 'example' }, source: { kind: 'jsonl', contractVersion: 1 } },
      linkGeneration: 'link-1', sourceGeneration: 'source-1', sourceCustody: { kind: 'development', registeredRootId: 'contribution-1' } },
    plan: 'materialize', targetStorageMode: 'external-linked', targetRuntimeMode: null,
  };
  return {
    v: 1, operationId: 'external-materialize:activity-1', revision: 0, request,
    status: 'awaiting_user_resume', phase: 'validating', timeline: resolveExternalSessionOperationTimelineV1(request),
    createdAtMs: Date.now(), updatedAtMs: Date.now(), priorStableStorage: { state: 'machine_only' }, currentStorageState: 'machine_only',
    checkpoint: { sourcePagesRead: 0, stagedItemCount: 0, importedItemCount: 0,
      requiredItemFailures: { total: 0, record: 0, media: 0, conversion: 0, diagnosticsTruncated: false, diagnostics: [] } },
    bindings: { operationClaimId: 'claim-1' }, progressProjection: { acknowledgedRevision: null },
    canonicalOwnerEvidence: { linkedSessionRevision: 1 }, fence: { kind: 'none' }, retryTargetPhase: 'validating',
  };
}

async function register(retainedDirectory?: string) {
  environment.activeServerDir = retainedDirectory ?? await mkdtemp(join(tmpdir(), 'happier-external-activity-'));
  if (!retainedDirectory) roots.push(environment.activeServerDir);
  const snapshots: unknown[] = [];
  const runtime = createHostActionOperationRuntime({ machineId: 'machine-1', resolveAccountId: async () => 'account-1', publishSnapshot: (snapshot) => { snapshots.push(snapshot); } });
  let installedOwner: ActionOperationDomainOwner | undefined;
  let onDeleted: Parameters<NonNullable<Parameters<typeof registerMachineExternalSessionsRpcHandlers>[0]['subscribeSessionDeletedChanges']>>[0] | null = null;
  const rpcHandlerManager = new RpcHandlerManager({ scopePrefix: 'machine-1', encryptionMode: 'plain' });
  const registration = registerMachineExternalSessionsRpcHandlers({
    rpcHandlerManager,
    machineId: 'machine-1', actionOperations: {
      attachOwner(owner) { installedOwner = owner; return runtime.attachOwner(owner); },
    },
    executeExternalSessionHistoricalImportCommand: async () => { throw new Error('Unexpected historical import network command in observation fixture'); },
    subscribeSessionDeletedChanges: (listener) => { onDeleted = listener; return () => { onDeleted = null; }; },
  });
  registrations.push(registration);
  if (!installedOwner) throw new Error('External Action operation owner was not installed');
  return { runtime, snapshots, owner: installedOwner, rpcHandlerManager, hostActionExecutor: registration.hostExternalSessionActionExecutor, deleteSession: async () => {
    if (!onDeleted) throw new Error('Session deletion feed is not attached');
    await onDeleted({ sessionId: 'session-1', cursor: 1, accountScope: { activeServerDir: environment.activeServerDir, accountSubject: 'account-1' } });
  } };
}

describe('durable external operations in shared Action Operations', () => {
  it('returns the interrupted import public reference through the local Action adapter', async () => {
    const { hostActionExecutor } = await register();
    const initial = ExternalSessionOperationRecordV1Schema.parse({ ...record(), revision: 2,
      phase: 'staging', retryTargetPhase: 'staging',
      error: { code: 'source_unavailable', message: 'Source is unavailable', retryable: true, occurredAtMs: Date.now() } });
    await writeExternalSessionOperationRecord(environment.activeServerDir, initial);
    const reference = { sessionId: initial.request.sessionId, operationId: initial.operationId, revision: initial.revision };
    const actionId = 'sessions.external.operation.status.get';
    const spec = getActionSpec(actionId);
    const context = { surface: 'cli' as const };
    // Control: the same registered owner serves the captured running-daemon
    // RPC shape before the semantic Action consumer applies its stricter output.
    const raw = await hostActionExecutor.execute(actionId, reference, context);
    expect(raw.ok && spec.surfaceBindings?.rpc?.outputSchema.safeParse(raw.result).success).toBe(true);
    expect(raw).toMatchObject({ ok: true, result: { ok: true, progress: {
      operationId: initial.operationId, revision: 2, status: 'awaiting_user_resume', phase: 'staging',
    } } });
    const execute = createHostExternalSessionActionAdapter({
      credentials: { token: 'e30.eyJzdWIiOiJhY2NvdW50LTEifQ.signature', encryption: null },
      execute: ({ actionId, input, context }) => hostActionExecutor.execute(actionId, input, context),
    });
    const result = await execute({ actionId, input: reference, context });
    expect(result).toEqual({ ok: true, result: { ok: true, operation: reference, presentation: {
      v: 1, operationId: initial.operationId, revision: 2, kind: 'materialize',
      status: 'awaiting_user_resume', phase: 'staging',
    } } });
    expect(result.ok && spec.outputSchema.safeParse(result.result).success).toBe(true);
  });

  it.each([
    { status: 'completed', revision: 5, stale: false },
    { status: 'cancelled', revision: 5, stale: false },
    { status: 'completed', revision: 4, stale: true },
  ] as const)('reads compacted $status status at revision $revision through the local Action adapter', async ({ status, revision, stale }) => {
    const { hostActionExecutor, rpcHandlerManager } = await register();
    const initial = record();
    const completed = status === 'completed';
    // A cancelled initial import still has an actionable Discard. Use a
    // cancelled external-linked takeover, which the owner can compact.
    const request = completed ? initial.request : {
      ...initial.request, plan: 'takeover' as const, targetDirectory: '/workspace', targetRuntimeMode: 'terminal' as const,
    };
    const phase = completed ? 'publishing' : 'finalizing';
    const settled = ExternalSessionOperationRecordV1Schema.parse({
      ...initial,
      revision: 5,
      request,
      timeline: resolveExternalSessionOperationTimelineV1(request),
      status,
      phase,
      currentStorageState: completed ? 'snapshot_complete' : 'machine_only',
      retryTargetPhase: undefined,
      ...(completed ? {
        checkpoint: { ...initial.checkpoint, acceptedThroughServerSeq: 0, acknowledgedBatchId: 'final-batch' },
        publication: {
          materializationPublicationId: 'publication-1', materializedThroughSourceAt: 2, publishedThroughServerSeq: 0,
        },
      } : { cancellation: { requestedAtMs: initial.updatedAtMs, requestedAtRevision: 4 } }),
      terminalResult: { kind: status },
    });
    await writeExternalSessionOperationRecord(environment.activeServerDir, settled);
    await acknowledgeExternalSessionOperationProgressProjection({
      activeServerDir: environment.activeServerDir, operationId: settled.operationId, projectedRevision: settled.revision,
    });
    await expect(compactExternalSessionOperationRecordToTerminalReceipt({
      activeServerDir: environment.activeServerDir, operationId: settled.operationId,
      expectedRevision: settled.revision, stagingDisposition: completed ? 'missing' : 'not_applicable',
    })).resolves.toEqual(expect.objectContaining({ status: 'compacted' }));

    const actionId = 'sessions.external.operation.status.get';
    const reference = { sessionId: settled.request.sessionId, operationId: settled.operationId, revision };
    const context = { surface: 'cli' as const };
    const execute = createHostExternalSessionActionAdapter({
      credentials: { token: 'e30.eyJzdWIiOiJhY2NvdW50LTEifQ.signature', encryption: null },
      execute: ({ actionId, input, context }) => hostActionExecutor.execute(actionId, input, context),
    });
    const result = await execute({ actionId, input: reference, context });
    if (stale) {
      expect(result).toMatchObject({ ok: true, result: { ok: false, error: { code: 'stale_revision' } } });
    } else {
      expect(result).toEqual({ ok: true, result: { ok: true, operation: reference, presentation: {
        v: 1, operationId: settled.operationId, revision, kind: completed ? 'materialize' : 'takeover_external_linked', status, phase,
      } } });
    }
    if (!result.ok) throw new Error('Expected operation status result.');
    await expect(rpcHandlerManager.invokeLocal(RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_STATUS_GET, reference))
      .resolves.toEqual(result.result);
  });

  it('reads semantic linked status through the same local transport owner', async () => {
    const { hostActionExecutor } = await register();
    const fields = buildSessionMetadataEnvelopeFields({
      credentials: { token: 'e30.eyJzdWIiOiJhY2NvdW50LTEifQ.signature', encryption: null },
      accountEncryptionMode: 'plain', storedContentMode: 'plain', agentState: null,
      metadata: { machineId: 'machine-1', externalSessionV1: { v: 1, machineId: 'machine-1',
        agentId: 'example', remoteSessionId: 'remote-1', source: { kind: 'jsonl' }, linkedAtMs: 1,
        qualifiedIdentity: record().request.source.qualifiedIdentity } },
    });
    environment.session = { id: 'session-1', metadata: fields.sharedMetadata.ciphertext,
      metadataVersion: 1, metadataLayoutVersion: 1, ownerMetadata: fields.ownerMetadata,
      agentState: fields.agentState, agentStateVersion: 0, encryptionMode: 'plain' };
    const actionId = 'sessions.external.status.get';
    const context = { surface: 'cli' as const };
    const transportInput = { sessionId: 'session-1', machineId: 'machine-1', agentId: 'example',
      remoteSessionId: 'remote-1', source: { kind: 'jsonl' } };
    const raw = await hostActionExecutor.execute(actionId, transportInput, context);
    expect(raw).toMatchObject({ ok: true, result: { ok: true, machineOnline: true } });
    const execute = createHostExternalSessionActionAdapter({
      credentials: { token: 'e30.eyJzdWIiOiJhY2NvdW50LTEifQ.signature', encryption: null },
      execute: ({ actionId, input, context }) => hostActionExecutor.execute(actionId, input, context),
    });
    const result = await execute({ actionId, input: { sessionId: 'session-1' }, context });
    expect(result).toMatchObject({ ok: true, result: { ok: true, machineOnline: true,
      canTakeOverDirect: false, canTakeOverPersist: false } });
    expect(result.ok && getActionSpec(actionId).outputSchema.safeParse(result.result).success).toBe(true);
  });

  it('keeps shared Stop in its admitted Account when the selected Account changes before local dispatch', async () => {
    const { owner } = await register();
    const initial = record();
    const scopeA = { activeServerDir: environment.activeServerDir, accountSubject: 'account-1' };
    await writeExternalSessionOperationRecord(environment.activeServerDir, initial, { accountScope: scopeA });
    const fields = buildSessionMetadataEnvelopeFields({
      credentials: { token: 'e30.eyJzdWIiOiJhY2NvdW50LTEifQ.signature', encryption: null },
      accountEncryptionMode: 'plain', storedContentMode: 'plain', metadata: {}, agentState: null,
    });
    environment.session = { id: initial.request.sessionId, metadata: fields.sharedMetadata.ciphertext,
      metadataVersion: 1, metadataLayoutVersion: 1, ownerMetadata: fields.ownerMetadata,
      agentState: fields.agentState, agentStateVersion: 0, encryptionMode: 'plain' };
    environment.afterCredentialRead = () => {
      environment.afterCredentialRead = null;
      environment.accountId = 'account-2';
    };
    await expect(owner.cancel({ accountId: 'account-1', machineId: 'machine-1' }, initial.operationId))
      .resolves.toEqual({ kind: 'requested' });
    await expect(readExternalSessionOperationRecord(environment.activeServerDir, initial.operationId, scopeA))
      .resolves.toMatchObject({ status: 'cancelled' });
    await expect(owner.get({ accountId: 'account-2', machineId: 'machine-1' }, initial.operationId)).resolves.toBeNull();
  });

  it('keeps a foreign requester Browser operation readable without probing the custodian external-session partition', async () => {
    const { runtime } = await register();
    const initial = record();
    await writeExternalSessionOperationRecord(environment.activeServerDir, initial);
    runtime.store.create({ operationId: 'requester-browser', actionId: 'browser.view.open', title: 'Open Browser',
      scope: { accountId: 'requester', machineId: 'machine-1' }, cancellation: 'unsupported', inputIdentity: '{}' });
    const context = { machineAdmission: { actorAccountId: 'requester', custodianAccountId: 'account-1', machineId: 'machine-1',
      installationId: 'installation', role: 'use' as const, encryptionMode: 'e2ee' as const }, verifyMachineAdmissionCurrent: async () => true };
    await expect(runtime.handlers.list({}, context)).resolves.toMatchObject({ items: [{ operationId: 'requester-browser' }] });
    await expect(runtime.handlers.get({ operationId: 'requester-browser' }, context)).resolves.toMatchObject({ kind: 'found' });
    await expect(runtime.handlers.get({ operationId: initial.operationId }, context)).resolves.toEqual({ kind: 'not_found' });
    await expect(runtime.handlers.cancel({ operationId: initial.operationId }, context)).resolves.toEqual({ kind: 'not_found' });
    await expect(runtime.handlers.list({})).resolves.toMatchObject({ items: [{ operationId: initial.operationId }] });
    await expect(readExternalSessionOperationRecord(environment.activeServerDir, initial.operationId))
      .resolves.toMatchObject({ status: initial.status, revision: initial.revision });
    environment.accountId = null;
    try {
      await expect(runtime.handlers.list({})).rejects.toMatchObject({ reason: 'account_scope_unavailable' });
    } finally { environment.accountId = 'account-1'; }
  });
  it('rebuilds activity from the durable owner and publishes every committed revision without completing at admission', async () => {
    const { runtime, snapshots } = await register();
    const initial = record();
    await writeExternalSessionOperationRecord(environment.activeServerDir, initial);
    await expect(runtime.handlers.get({ operationId: initial.operationId })).resolves.toMatchObject({
      kind: 'found', operation: { operationId: initial.operationId, actionId: 'sessions.external.materialize.start', state: 'running', revision: 1, scope: { sessionId: 'session-1' } },
    });
    const advanced = await mutateExternalSessionOperationRecordAtRevision(environment.activeServerDir, initial.operationId, 0, (current) => ({
      ...current, revision: 1, status: 'running', phase: 'staging', retryTargetPhase: undefined, updatedAtMs: Date.now(),
      checkpoint: { ...current.checkpoint, sourcePagesRead: 1, stagedItemCount: 2, totalItemEstimate: 2 },
    }));
    expect(advanced.ok).toBe(true);
    await vi.waitFor(() => expect(snapshots).toContainEqual(expect.objectContaining({ operationId: initial.operationId, revision: 2, state: 'running' })));
    await expect(runtime.handlers.list({ sessionId: 'session-1' })).resolves.toMatchObject({ items: [{ operationId: initial.operationId, revision: 2 }] });
  });
  it('retains recoverable failures, cancellation and compact terminal receipts across a fresh runtime', async () => {
    const { runtime } = await register();
    const initial = record();
    await writeExternalSessionOperationRecord(environment.activeServerDir, initial);
    const failed = await mutateExternalSessionOperationRecordAtRevision(environment.activeServerDir, initial.operationId, 0, (current) => ({
      ...current, revision: 1, status: 'failed', updatedAtMs: Date.now(),
      error: { code: 'internal_error', message: 'PRIVATE source path and diagnostics', retryable: true, occurredAtMs: Date.now() },
    }));
    expect(failed.ok).toBe(true);
    const failedProjection = await runtime.handlers.get({ operationId: initial.operationId });
    expect(failedProjection).toMatchObject({ kind: 'found', operation: { state: 'running', progress: { phase: 'failed' }, cancellation: 'supported' } });
    expect(JSON.stringify(failedProjection)).not.toContain('PRIVATE');
    if (failedProjection.kind !== 'found') throw new Error('Canonical failed projection is missing');
    runtime.store.project({ ...failedProjection.operation, revision: failedProjection.operation.revision + 1,
      scope: { ...failedProjection.operation.scope, accountId: 'another-account' } });
    expect(runtime.store.get({ accountId: 'account-1', machineId: 'machine-1' }, initial.operationId))
      .toEqual(failedProjection.operation);
    expect(runtime.store.get({ accountId: 'another-account', machineId: 'machine-1' }, initial.operationId)).toBeNull();
    const resumed = await mutateExternalSessionOperationRecordAtRevision(environment.activeServerDir, initial.operationId, 1, (current) => ({
      ...current, revision: 2, status: 'running', phase: 'staging', updatedAtMs: Date.now(), error: undefined, retryTargetPhase: undefined,
    }));
    expect(resumed.ok).toBe(true);
    await expect(runtime.handlers.get({ operationId: initial.operationId })).resolves.toMatchObject({ kind: 'found', operation: { revision: 3, state: 'running', progress: { phase: 'staging' } } });
    const requested = await mutateExternalSessionOperationRecordAtRevision(environment.activeServerDir, initial.operationId, 2, (current) => ({
      ...current, revision: 3, status: 'cancel_requested', updatedAtMs: Date.now(), cancellation: { requestedAtMs: Date.now(), requestedAtRevision: 2 },
    }));
    expect(requested.ok).toBe(true);
    await expect(runtime.handlers.get({ operationId: initial.operationId })).resolves.toMatchObject({ kind: 'found', operation: { state: 'running', progress: { phase: 'cancelling' }, cancellation: 'unsupported' } });
    const cancelled = await mutateExternalSessionOperationRecordAtRevision(environment.activeServerDir, initial.operationId, 3, (current) => ({
      ...current, revision: 4, status: 'cancelled', updatedAtMs: Date.now(), terminalResult: { kind: 'cancelled' },
    }));
    expect(cancelled.ok).toBe(true);
    const discarded = await mutateExternalSessionOperationRecordAtRevision(environment.activeServerDir, initial.operationId, 4, (current) => ({
      ...current, revision: 5, status: 'discarded', updatedAtMs: Date.now(), cancellation: undefined, terminalResult: { kind: 'discarded' },
    }));
    expect(discarded.ok).toBe(true);
    await expect(runtime.handlers.get({ operationId: initial.operationId })).resolves.toMatchObject({ kind: 'found', operation: { revision: 6, state: 'cancelled', progress: { phase: 'discarded', label: 'Discarded' } } });
    await acknowledgeExternalSessionOperationProgressProjection({ activeServerDir: environment.activeServerDir, operationId: initial.operationId, projectedRevision: 5 });
    await expect(compactExternalSessionOperationRecordToTerminalReceipt({ activeServerDir: environment.activeServerDir, operationId: initial.operationId, expectedRevision: 5, stagingDisposition: 'missing' })).resolves.toMatchObject({ status: 'compacted' });
    const fresh = await register(environment.activeServerDir);
    await expect(fresh.runtime.handlers.get({ operationId: initial.operationId })).resolves.toMatchObject({ kind: 'found', operation: { revision: 6, state: 'cancelled', cancellation: 'unsupported' } });
    await expect(fresh.runtime.handlers.cancel({ operationId: initial.operationId })).resolves.toEqual({ kind: 'already_settled' });
  });

  it('evicts only its projected rows when the durable owner detaches', async () => {
    const { runtime } = await register();
    const initial = record();
    await writeExternalSessionOperationRecord(environment.activeServerDir, initial);
    await runtime.handlers.get({ operationId: initial.operationId });
    runtime.store.create({ operationId: 'core-operation', actionId: 'session.fork', title: 'Fork',
      scope: { accountId: 'account-1', machineId: 'machine-1' }, cancellation: 'unsupported', inputIdentity: '{}' });
    await registrations.pop()!.dispose();
    await expect(runtime.handlers.get({ operationId: initial.operationId })).resolves.toEqual({ kind: 'not_found' });
    await expect(runtime.handlers.get({ operationId: 'core-operation' })).resolves.toMatchObject({ kind: 'found' });
  });

  it('returns authoritative not_found after Session deletion without waiting for a list refresh', async () => {
    const { runtime, deleteSession } = await register();
    const initial = record();
    await writeExternalSessionOperationRecord(environment.activeServerDir, initial);
    await expect(runtime.handlers.get({ operationId: initial.operationId })).resolves.toMatchObject({ kind: 'found' });
    await deleteSession();
    await expect(runtime.handlers.get({ operationId: initial.operationId })).resolves.toEqual({ kind: 'not_found' });
    await expect(runtime.handlers.cancel({ operationId: initial.operationId })).resolves.toEqual({ kind: 'not_found' });
  });

  it('projects a valid empty import as a phase instead of an invalid zero-total percentage', () => {
    const initial = record();
    const empty = ExternalSessionOperationRecordV1Schema.parse({ ...initial, status: 'running', phase: 'importing', retryTargetPhase: undefined,
      checkpoint: { ...initial.checkpoint, totalItemEstimate: 0 } });
    expect(projectExternalSessionActionOperation({ kind: 'full_record', record: empty }, { accountId: 'account-1', machineId: 'machine-1' }))
      .toMatchObject({ state: 'running', progress: { kind: 'phase', phase: 'importing' } });
  });

  it('delegates shared Stop to the real import executor and observes its durable cancellation', async () => {
    environment.activeServerDir = await mkdtemp(join(tmpdir(), 'happier-external-activity-stop-'));
    roots.push(environment.activeServerDir);
    const initial = record();
    await writeExternalSessionOperationRecord(environment.activeServerDir, initial);
    const executor = createExternalSessionMaterializeActionExecutor({
      activeServerDir: environment.activeServerDir,
      operationExclusion: createExternalSessionOperationExclusion({ activeServerDir: environment.activeServerDir, ownerId: 'shared-stop-fixture' }),
      staging: createExternalSessionOperationPrivateStagingStore({ activeServerDir: environment.activeServerDir,
        limits: { perOperation: { maxItems: 20, maxBytes: 50_000 }, aggregate: { maxItems: 40, maxBytes: 100_000 } } }),
      revalidateSource: async () => { throw new Error('Provider validation must not start during Stop'); },
      describeSource: async () => { throw new Error('Provider capture must not start during Stop'); },
      readNewestFirstPages: async function* () { throw new Error('Provider pages must not be read during Stop'); },
      readFinalCatchUpPages: async function* () { throw new Error('Provider pages must not be read during Stop'); },
      sendHistoricalCommand: async () => { throw new Error('No import job exists to send a network command'); },
    });
    const runtime = createHostActionOperationRuntime({ machineId: 'machine-1', resolveAccountId: async () => 'account-1' });
    await expect(executor.cancel({ sessionId: 'foreign-session', operationId: initial.operationId, revision: 0 }))
      .resolves.toMatchObject({ ok: false, error: { code: 'operation_not_found' } });
    await expect(executor.cancel({ sessionId: 'session-1', operationId: 'another-operation', revision: 0 }))
      .resolves.toMatchObject({ ok: false, error: { code: 'operation_not_found' } });
    await expect(readExternalSessionOperationRecord(environment.activeServerDir, initial.operationId))
      .resolves.toMatchObject({ status: 'awaiting_user_resume', revision: 0 });
    let racedProgressCommit = false;
    let cancelRequests = 0;
    const detach = runtime.attachOwner(createExternalSessionActionOperationOwner({
      activeServerDir: environment.activeServerDir,
      // A transport adapter to the real domain executor, with no fabricated lifecycle outcomes.
      execute: async (actionId, input) => {
        if (actionId !== 'sessions.external.operation.cancel') throw new Error('Unexpected Action');
        cancelRequests += 1;
        // A progress commit while the transport delivers Stop must use the owner's stale-revision response.
        if (!racedProgressCommit) {
          racedProgressCommit = true;
          const advanced = await mutateExternalSessionOperationRecordAtRevision(environment.activeServerDir, initial.operationId, 0,
            (current) => ({ ...current, revision: 1, updatedAtMs: Date.now() }));
          if (!advanced.ok) throw new Error('Progress commit fixture did not advance');
        }
        return { ok: true, result: await executor.cancel(input) };
      },
    }));
    try {
      await expect(runtime.handlers.cancel({ operationId: initial.operationId })).resolves.toEqual({ kind: 'requested' });
      // Stop is one semantic request; progress does not make a consumer re-admit it.
      expect(cancelRequests).toBe(1);
      await expect(readExternalSessionOperationRecord(environment.activeServerDir, initial.operationId)).resolves.toMatchObject({ status: 'cancelled', currentStorageState: 'machine_only', cancellation: { requestedAtRevision: 1 } });
      await expect(runtime.handlers.get({ operationId: initial.operationId })).resolves.toMatchObject({ kind: 'found', operation: { state: 'cancelled', cancellation: 'unsupported' } });
    } finally { detach(); }
  });

});
