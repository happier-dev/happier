import { describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '../../crypto/accountScopedCipher.js';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '../../account/encryptionKeyFingerprintV1.js';
import type { AvailableAutomationAccountEncryptionV1 } from '../../automations/automationAccountCurrentnessV1.js';
import { prepareWorkflowRunDataKeyV1, resolveWorkflowRunDataKeyV1 } from '../../workflows/workflowRunDataKeyV1.js';

import { validateWorkflowDefinition } from '../../workflows/workflowValidationV1.js';
import { materializeWorkflowAcceptedSnapshotV1 } from '../../workflows/materializeWorkflowAcceptedSnapshotV1.js';
import { WorkflowRunGetResultV1Schema, WorkflowRunStartRequestV1Schema, WorkflowRunWaitRequestV1Schema } from '../../workflows/actionsV1.js';
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, sealWorkflowProgressStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from '../../workflows/workflowStoredContentV1.js';
import { WorkflowRunSummaryV1Schema } from '../../workflows/workflowProgressV1.js';
import { openWorkflowAcceptedSnapshotStoredEnvelopeV1, parseWorkflowStoredContentEnvelopeV1 } from '../../workflows/workflowStoredContentV1.js';
import { SessionAgentSpawnPolicyV1StrictSchema } from '../../account/settings/sessionAgentSpawnPolicyV1.js';
import { createWorkflowAccountRunActionOwner, type WorkflowAccountRunActionDeps } from './workflowRunActions.js';
import { normalizeWorkflowActionThrownError } from './workflowAccountActions.js';
import { WorkflowRunRecipientCensusResponseV1Schema, WorkflowRunRecipientKeyEnvelopesV1Schema } from '../../workflows/workflowRunKeyV1.js';
import { WorkflowAcceptedSnapshotV1Schema, type WorkflowAcceptedSnapshotV1 } from '../../workflows/workflowDefinitionV1.js';
import { measureExternalActionResultResponseEnvelopeUtf8BytesV1 } from '../externalActionLimits.js';

const runId = '11111111-1111-4111-8111-111111111111';
const definition = validateWorkflowDefinition({
  version: 1,
  defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } } },
  blocks: ['work'],
}).normalizedDefinition!;

const acceptedSnapshotResult = await materializeWorkflowAcceptedSnapshotV1({
  definition,
  context: {
    source: { kind: 'saved', definitionId: 'def-1', revision: { headerVersion: 1, bodyVersion: 1 }, savedBy: null },
    inputs: {}, machineId: 'machine-a', executionTarget: { kind: 'session' },
    workspaceTarget: { project: { machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } },
    origin: { kind: 'direct', originSessionId: 'origin-1' },
    authorization: { principal: { kind: 'host' } },
  },
  admission: { kind: 'user' },
  effects: { resolveTargetAvailability: async () => true },
});

function runSnapshot() {
  if (!acceptedSnapshotResult.ok) throw new Error(`snapshot_fixture_failed: ${acceptedSnapshotResult.error.code}`);
  const run = WorkflowRunSummaryV1Schema.parse({ sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null,
    id: runId, origin: { kind: 'direct' }, state: 'queued', revision: 0,
    machineId: 'machine-a', workflowCustodyState: 'pending', originDeliveryAckRevision: null,
    availability: { pause: true, resumeBoundary: false,
       restoreWorkspace: false, cancel: true, inspectExecution: false, disabledReasons: [] },
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  });
  return {
    run,
    acceptedEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId },
      acceptedSnapshot: acceptedSnapshotResult.snapshot,
    })),
    checkpointEnvelope: null, resultEnvelope: null,
    keyCensus: WorkflowRunRecipientCensusResponseV1Schema.parse({
      runId, ownerAccountId: 'account-1', visibleTeamId: null, encryptionMode: 'plain', access: 'owner',
      ownerAccountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null },
      dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [],
    }),
  };
}

function ownerDeps(storage: WorkflowAccountRunActionDeps['storage']): WorkflowAccountRunActionDeps {
  return {
    resolveAccountId: async () => 'account-1', storage,
    definitions: { get: async () => ({ definitionId: 'def-1', revision: { headerVersion: 1, bodyVersion: 1 }, definition, metadata: { title: 'Work' } }) },
    resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
    normalizeAbsolutePath: (directory) => directory.startsWith('/') ? directory : null,
    randomBytes: () => { throw new Error('plain_account_does_not_need_keys'); },
  };
}

describe('shared Account workflow run owner', () => {
  it.each(['history_not_readable', 'encryption_setup_required', 'waiting_for_keys'] as const)(
    'preserves %s through accepted detail, exact invocation, content list and result reads', async reason => {
      const snapshot = runSnapshot();
      const material = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
        material: { type: 'legacy', secret: new Uint8Array(32).fill(7) } });
      const encryption: AvailableAutomationAccountEncryptionV1 = { kind: 'available', material,
        witness: { mode: 'e2ee', version: 1, contentKeyFingerprint: material.contentPublicKeyFingerprint } };
      const prepared = prepareWorkflowRunDataKeyV1({ accountId: 'account-1', encryption, randomBytes });
      snapshot.keyCensus = WorkflowRunRecipientCensusResponseV1Schema.parse({ ...snapshot.keyCensus,
        encryptionMode: 'e2ee', ownerAccountCurrentness: { mode: 'e2ee', version: 1,
          contentKeyFingerprint: material.contentPublicKeyFingerprint },
        dataEncryptionKey: reason === 'history_not_readable' ? null : prepared.recipientKeyEnvelopes[0]!.encryptedDataKey,
        callerDataEncryptionKey: null,
      });
      const owner = createWorkflowAccountRunActionOwner({ ...ownerDeps({ execute: async operation => {
        if (operation.operation === 'get') return snapshot;
        if (operation.operation === 'list') return { runs: [snapshot.run],
          acceptedEnvelopesByRunId: { [runId]: snapshot.acceptedEnvelope },
          keyCensusByRunId: { [runId]: snapshot.keyCensus } };
        if (operation.operation === 'invocations.list') return { invocations: [], parentRevision: 0,
          keyCensus: snapshot.keyCensus, progressEnvelopesByInvocationId: {} };
        if (operation.operation === 'wait') return { observation: 'terminal', run: { ...snapshot.run, state: 'succeeded' },
          resultEnvelope: 'unopened-result', keyCensus: snapshot.keyCensus };
        throw new Error(`unexpected_storage_operation:${String(operation.operation)}`);
      } }), resolveEncryption: async () => reason === 'encryption_setup_required'
        ? { kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }
        : encryption,
      });
      const reads = [
        owner.execute({ actionId: 'workflow.run.get', input: { runId }, context: {} }),
        owner.execute({ actionId: 'workflow.run.invocations.get', input: { runId, invocationId: 'held' }, context: {} }),
        owner.execute({ actionId: 'workflow.run.invocations.list', input: { runId, includeContent: true }, context: {} }),
        owner.execute({ actionId: 'workflow.run.wait', input: { runId }, context: {} }),
      ];
      const failures = await Promise.all(reads.map(read => read.catch(normalizeWorkflowActionThrownError)));
      for (const failure of failures) {
        expect(failure).toMatchObject({ ok: false, errorCode: reason });
      }
      await expect(owner.execute({ actionId: 'workflow.run.list', input: {}, context: {} }))
        .resolves.toMatchObject({ runs: [{ id: runId }], metadataByRunId: { [runId]: { kind: 'unavailable', reason } } });
    },
  );

  it.each([
    { error: Object.assign(new Error('HTTP 500'), { response: { status: 500, data: { error: 'internal_server_error' } } }), code: 'storage_unavailable' },
    { error: Object.assign(new Error('HTTP 500'), { response: { status: 500, data: '<html>failure</html>' } }), code: 'storage_unavailable' },
    { error: Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }), code: 'storage_unavailable' },
    { error: new Error('transport failed'), code: 'storage_unavailable' },
    { error: Object.assign(new Error('stale'), { code: 'currentness_conflict' }), code: 'currentness_conflict' },
    { error: Object.assign(new Error('forbidden'), { response: { status: 403, data: { error: 'run_access_denied' } } }), code: 'run_access_denied' },
  ])('distinguishes storage failure from typed currentness/access failure ($code)', async ({ error, code }) => {
    const owner = createWorkflowAccountRunActionOwner(ownerDeps({ execute: async () => { throw error; } }));
    const failures = await Promise.all([
      owner.execute({ actionId: 'workflow.run.get', input: { runId }, context: {} }),
      owner.execute({ actionId: 'workflow.run.cancel', input: { runId, expectedRevision: 0 }, context: {} }),
    ].map(result => result.catch(normalizeWorkflowActionThrownError)));
    for (const failure of failures) {
      expect(failure).toMatchObject({ ok: false, errorCode: code });
    }
  });

  it('keeps malformed storage projections distinct from transport failures', async () => {
    const snapshot = runSnapshot();
    const owner = createWorkflowAccountRunActionOwner(ownerDeps({ execute: async () => ({ ...snapshot, run: { id: runId } }) }));
    await expect(owner.execute({ actionId: 'workflow.run.get', input: { runId }, context: {} })
      .catch(normalizeWorkflowActionThrownError)).resolves.toMatchObject({ ok: false, errorCode: 'content_unavailable' });
  });

  it.each([
    Object.assign(new Error('cancelled'), { code: 'ERR_CANCELED' }),
    new DOMException('cancelled', 'AbortError'),
  ])('preserves native storage cancellation', async error => {
    const owner = createWorkflowAccountRunActionOwner(ownerDeps({ execute: async () => { throw error; } }));
    await expect(owner.execute({ actionId: 'workflow.run.get', input: { runId }, context: {} })).rejects.toBe(error);
  });

  it.each(['root', 'nested'] as const)('hydrates exact transcript references in the lean batch using authored %s step numbering', async placement => {
    const snapshot = runSnapshot();
    if (placement === 'nested') {
      if (!acceptedSnapshotResult.ok) throw new Error('snapshot_fixture_failed');
      const parentDefinition = { ...definition, blocks: [
        { ...definition.blocks[0]!, id: 'prelude' },
        { kind: 'workflow' as const, id: 'nested', workflowRef: 'builtin:child', input: {} },
      ] };
      const nested = await materializeWorkflowAcceptedSnapshotV1({ definition: parentDefinition,
        context: acceptedSnapshotResult.snapshot,
        admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true,
          readWorkflowDefinition: async () => ({ sourceKey: 'builtin:child', definition }) } });
      if (!nested.ok) throw new Error(`snapshot_fixture_failed: ${nested.error.code}`);
      snapshot.acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
        mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId },
        acceptedSnapshot: nested.snapshot,
      }));
    }
    const id = 'transcript-step';
    const index = { id, runId, sequence: '87', parentRecordId: null, memberOrdinal: '8', attempt: '0',
      contentRevision: '1', lifecycle: 'completed' as const,
      createdAt: snapshot.run.createdAt, updatedAt: snapshot.run.updatedAt };
    const contentEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId: 'account-1', runId,
        recordId: id, sequence: index.sequence, parentRecordId: null, memberOrdinal: index.memberOrdinal, attempt: '0' },
      progress: { kind: 'happier.workflow-progress.v1', blockKind: 'step',
        invocationPath: { blockId: definition.blocks[0]!.id,
          scope: placement === 'nested' ? [{ kind: 'workflow', blockId: 'nested' }] : [] }, attempt: '0', logicalInvocationRecordId: id },
    }));
    const rootIndex = { ...index, id: 'root', sequence: '0', memberOrdinal: '0', lifecycle: 'running' as const };
    const rootEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId: 'account-1', runId,
        recordId: rootIndex.id, sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' },
      progress: { kind: 'happier.workflow-progress.v1', blockKind: 'root', invocationPath: { blockId: '$root', scope: [] },
        attempt: '0', logicalInvocationRecordId: 'root', resultProvenance: { [id]: { notificationCondition: 'suppressed' } } },
    }));
    const requests: unknown[] = [];
    const owner = createWorkflowAccountRunActionOwner(ownerDeps({ execute: async operation => {
      if (operation.operation !== 'list') throw new Error('transcript_must_not_read_detail_or_history');
      requests.push(operation.request);
      return { runs: [snapshot.run], acceptedEnvelopesByRunId: { [runId]: snapshot.acceptedEnvelope },
        keyCensusByRunId: { [runId]: snapshot.keyCensus },
        rootProgressByRunId: { [runId]: { index: rootIndex, contentEnvelope: rootEnvelope } },
        invocationProgressByRunId: { [runId]: [{ index, contentEnvelope },
          { index: { ...index, id: 'unrequested' }, contentEnvelope },
          { index: { ...index, runId: 'foreign-run' }, contentEnvelope }] } };
    } }));
    const input = { runIds: [runId], invocationProvenance: [{ runId, invocationRecordIds: [id] }] };
    const result = await owner.execute({ actionId: 'workflow.run.list', input, context: {} });
    expect(result).toMatchObject({ invocationProvenance: [{ index, stepOrdinal: '1', notificationCondition: 'suppressed' }] });
    expect(result).toHaveProperty('invocationProvenance.length', 1);
    expect(requests).toEqual([input]);
  });

  it('opens requested invocation content from the same paged storage response', async () => {
    const ids = ['22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
    const rows = ids.map((id, ordinal) => {
      const index = { id, runId, sequence: String(ordinal), parentRecordId: null, memberOrdinal: String(ordinal),
        attempt: '0', contentRevision: '1', lifecycle: 'completed' as const,
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:01.000Z' };
      const progress = { kind: 'happier.workflow-progress.v1' as const, blockKind: 'step' as const,
        invocationPath: { blockId: 'work', scope: [] }, attempt: '0', logicalInvocationRecordId: id,
        result: { kind: 'value' as const, value: { output: `page-${ordinal}` } } };
      const contentEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
        mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId: 'account-1', runId,
          recordId: id, sequence: index.sequence, parentRecordId: null, memberOrdinal: index.memberOrdinal, attempt: '0' }, progress,
      }));
      return { index, progress, contentEnvelope };
    });
    const operations: string[] = [];
    const owner = createWorkflowAccountRunActionOwner(ownerDeps({ execute: async operation => {
      operations.push(String(operation.operation));
      if (operation.operation !== 'invocations.list') throw new Error('Content list must not read individual details or accepted snapshots');
      const row = operation.cursor ? rows[1]! : rows[0]!;
      return { invocations: [row.index], parentRevision: 4, keyCensus: runSnapshot().keyCensus,
        ...(operation.cursor ? {} : { nextCursor: 'page-2' }),
        ...(operation.progressEnvelopes ? { progressEnvelopesByInvocationId: { [row.index.id]: row.contentEnvelope } } : {}) };
    } }));
    for (const ordinal of [0, 1]) {
      const row = rows[ordinal]!;
      await expect(owner.execute({ actionId: 'workflow.run.invocations.list',
        input: { runId, includeContent: true, ...(ordinal === 1 ? { cursor: 'page-2' } : {}) }, context: {} }))
        .resolves.toEqual({ invocations: [row.index], parentRevision: 4,
          invocationDetails: [{ index: row.index, progress: row.progress, parentRevision: 4 }],
          ...(ordinal === 0 ? { nextCursor: 'page-2' } : {}) });
    }
    expect(operations).toEqual(['invocations.list', 'invocations.list']);
    await expect(owner.execute({ actionId: 'workflow.run.invocations.list', input: { runId }, context: {} }))
      .resolves.toEqual({ invocations: [rows[0]!.index], parentRevision: 4, nextCursor: 'page-2' });
  });

  it.each(['missing', 'malformed', 'rebound', 'mode_mismatch', 'foreign_run'] as const)('fails requested invocation content closed for %s envelopes', async failure => {
    const id = '22222222-2222-4222-8222-222222222222';
    const index = { id, runId, sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0',
      contentRevision: '1', lifecycle: 'completed' as const,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:01.000Z' };
    const envelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId: 'account-1', runId,
        recordId: failure === 'rebound' ? '33333333-3333-4333-8333-333333333333' : id,
        sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' },
      progress: { kind: 'happier.workflow-progress.v1', blockKind: 'step',
        invocationPath: { blockId: 'work', scope: [] }, attempt: '0',
        logicalInvocationRecordId: failure === 'rebound' ? '33333333-3333-4333-8333-333333333333' : id },
    }));
    const owner = createWorkflowAccountRunActionOwner(ownerDeps({ execute: async operation => {
      if (operation.operation !== 'invocations.list') throw new Error('No per-row fallback');
      return { invocations: [{ ...index, ...(failure === 'foreign_run' ? { runId: '33333333-3333-4333-8333-333333333333' } : {}) }], parentRevision: 4, keyCensus: runSnapshot().keyCensus,
        progressEnvelopesByInvocationId: failure === 'missing' ? {} : {
          [id]: failure === 'malformed' ? 'invalid' : failure === 'mode_mismatch' ? JSON.stringify({ t: 'encrypted', c: 'invalid' }) : envelope,
        } };
    } }));
    await expect(owner.execute({ actionId: 'workflow.run.invocations.list', input: { runId, includeContent: true }, context: {} }))
      .rejects.toMatchObject({ code: 'content_unavailable' });
  });

  it('keeps opened invocation details within the stored page byte boundary', async () => {
    const id = '22222222-2222-4222-8222-222222222222';
    // The index duplicates in the opened projection. Maximal database decimal
    // fields and revision, short private content and the smallest owner binding
    // exercise the margin supplied by the existing serialized-envelope budget.
    const decimal = '9223372036854775807';
    const index = { id, runId, sequence: decimal, parentRecordId: null, memberOrdinal: decimal,
      attempt: decimal, contentRevision: decimal, lifecycle: 'waiting_for_capacity' as const,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:01.000Z' };
    const contentEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId: 'a', runId,
        recordId: id, sequence: decimal, parentRecordId: null, memberOrdinal: decimal, attempt: decimal },
      progress: { kind: 'happier.workflow-progress.v1', blockKind: 'root',
        invocationPath: { blockId: '$root', scope: [] }, attempt: decimal,
        logicalInvocationRecordId: id, previousAttemptRecordId: '33333333-3333-4333-8333-333333333333' },
    }));
    const page = { invocations: [index], parentRevision: Number.MAX_SAFE_INTEGER,
      keyCensus: { ...runSnapshot().keyCensus, ownerAccountId: 'a' },
      progressEnvelopesByInvocationId: { [id]: contentEnvelope } };
    const owner = createWorkflowAccountRunActionOwner(ownerDeps({ execute: async operation => {
      if (operation.operation !== 'invocations.list') throw new Error('No per-row reads');
      return page;
    } }));
    const opened = await owner.execute({ actionId: 'workflow.run.invocations.list', input: { runId, includeContent: true }, context: {} });
    expect(opened).toMatchObject({ invocationDetails: [{ index }] });
    expect(measureExternalActionResultResponseEnvelopeUtf8BytesV1(opened))
      .toBeLessThanOrEqual(measureExternalActionResultResponseEnvelopeUtf8BytesV1(page));
  });

  it('admits the reviewed inline draft with authorized Artifact lineage and rejoins its frozen Team choice', async () => {
    const reviewed = validateWorkflowDefinition({ ...definition, blocks: ['Reviewed unsaved work'] }).normalizedDefinition!;
    const metadata = { title: 'Reviewed title' };
    let committed: ReturnType<typeof runSnapshot> | undefined;
    let admitted: Readonly<Record<string, unknown>> | undefined;
    let sourceAvailable = true;
    const owner = createWorkflowAccountRunActionOwner({ ...ownerDeps({ execute: async operation => {
      if (operation.operation === 'get') {
        if (committed) return committed;
        throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
      }
      if (operation.operation === 'admit') {
        admitted = operation;
        committed = { ...runSnapshot(), acceptedEnvelope: String(operation.acceptedEnvelope),
          run: { ...runSnapshot().run, sourceArtifactId: 'def-1', visibleTeamId: 'team-a' },
          keyCensus: { ...runSnapshot().keyCensus, visibleTeamId: 'team-a' } };
        return { kind: 'created', run: committed.run };
      }
      if (operation.operation === 'invocations.list') return { invocations: [] };
      throw new Error('unexpected_storage_operation');
    } }), definitions: { get: async ({ definitionId }) => {
      expect(definitionId).toBe('def-1');
      if (!sourceAvailable) throw new Error('must_not_read_mutable_source_on_rejoin');
      return { definitionId, revision: { headerVersion: 2, bodyVersion: 2 }, definition, metadata: { title: 'Old saved content' } };
    } }, prepareWorkspace: async () => ({ ok: true, workspaceTarget: {
      project: { machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } } }),
    resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => true } }),
    });
    const input = WorkflowRunStartRequestV1Schema.parse({ runId, metadata,
      source: { kind: 'inline', definition: reviewed, sourceArtifactId: 'def-1', visibleTeamId: 'team-a' } });
    const context = { surface: 'ui' as const, authority: 'present_user' as const, callerPermissionMode: 'default',
      externalActionTarget: { kind: 'machine' as const, machineId: 'machine-a', project: { machineId: 'machine-a', directory: '/repo' } } };
    await expect(owner.execute({ actionId: 'workflow.run.start', input, context })).resolves.toMatchObject({ admission: 'created' });
    expect(admitted).toMatchObject({ sourceArtifactId: 'def-1', visibleTeamId: 'team-a', recipientKeyEnvelopes: [] });
    const opened = await owner.execute({ actionId: 'workflow.run.get', input: { runId }, context });
    expect(opened).toMatchObject({ definition: reviewed, authoredDefinition: reviewed,
      acceptedContext: { metadata, source: { kind: 'inline', sourceArtifactId: 'def-1' } } });
    sourceAvailable = false;
    await expect(owner.execute({ actionId: 'workflow.run.start', input, context })).resolves.toMatchObject({ admission: 'existing' });
    await expect(owner.execute({ actionId: 'workflow.run.start', input: { ...input,
      source: { kind: 'inline', definition: reviewed, sourceArtifactId: 'different-source', visibleTeamId: 'team-a' } }, context }))
      .rejects.toMatchObject({ code: 'currentness_conflict' });
    await expect(owner.execute({ actionId: 'workflow.run.start', input: { ...input,
      source: { kind: 'inline', definition: reviewed, sourceArtifactId: 'def-1', visibleTeamId: 'team-b' } }, context }))
      .rejects.toMatchObject({ code: 'currentness_conflict' });
  });

  it('refuses an inaccessible inline Artifact binding before preparing a workspace or admitting a Run', async () => {
    const operations: unknown[] = [];
    const owner = createWorkflowAccountRunActionOwner({ ...ownerDeps({ execute: async operation => {
      operations.push(operation.operation);
      if (operation.operation === 'get') throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
      throw new Error('must_not_admit_inaccessible_binding');
    } }), definitions: { get: async () => { throw Object.assign(new Error('source_unavailable'), { code: 'source_unavailable' }); } },
      prepareWorkspace: async () => { throw new Error('must_not_prepare_inaccessible_binding'); },
      resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => true } }),
    });
    const input = WorkflowRunStartRequestV1Schema.parse({ runId,
      source: { kind: 'inline', definition, sourceArtifactId: 'def-1', visibleTeamId: 'team-a' } });
    await expect(owner.execute({ actionId: 'workflow.run.start', input, context: { callerPermissionMode: 'default',
      externalActionTarget: { kind: 'machine', machineId: 'machine-a', project: { machineId: 'machine-a', directory: '/repo' } } } }))
      .rejects.toMatchObject({ code: 'source_unavailable' });
    expect(operations).not.toContain('admit');
  });

  it('uses the same bound inline grant audience for E2EE census, keys and accepted content', async () => {
    const material = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
      material: { type: 'legacy', secret: randomBytes(32) } });
    const encryption: AvailableAutomationAccountEncryptionV1 = { kind: 'available', material,
      witness: { mode: 'e2ee', version: 1,
        contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(material.contentPublicKeyFingerprint) } };
    const census = { ...runSnapshot().keyCensus, encryptionMode: 'e2ee' as const,
      ownerAccountCurrentness: encryption.witness, visibleTeamId: 'team-a' };
    const reviewed = validateWorkflowDefinition({ ...definition, blocks: ['Encrypted reviewed draft'] }).normalizedDefinition!;
    let admitted: Readonly<Record<string, unknown>> | undefined;
    const owner = createWorkflowAccountRunActionOwner({ ...ownerDeps({ execute: async operation => {
      if (operation.operation === 'get') throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
      if (operation.operation === 'run-key.census') {
        expect(operation).toMatchObject({ sourceArtifactId: 'def-1', visibleTeamId: 'team-a' });
        return census;
      }
      if (operation.operation === 'admit') {
        admitted = operation;
        return { kind: 'created', run: { ...runSnapshot().run, sourceArtifactId: 'def-1', visibleTeamId: 'team-a' } };
      }
      throw new Error('unexpected_storage_operation');
    } }), resolveEncryption: async () => encryption, randomBytes,
      prepareWorkspace: async () => ({ ok: true, workspaceTarget: {
        project: { machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } } }),
      resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => true } }),
    });
    await owner.execute({ actionId: 'workflow.run.start', input: WorkflowRunStartRequestV1Schema.parse({ runId,
      source: { kind: 'inline', definition: reviewed, sourceArtifactId: 'def-1', visibleTeamId: 'team-a' } }),
      context: { callerPermissionMode: 'default', externalActionTarget: { kind: 'machine', machineId: 'machine-a',
        project: { machineId: 'machine-a', directory: '/repo' } } } });
    expect(admitted).toMatchObject({ sourceArtifactId: 'def-1', visibleTeamId: 'team-a' });
    const envelopes = WorkflowRunRecipientKeyEnvelopesV1Schema.parse(admitted?.recipientKeyEnvelopes);
    const ownerEnvelope = envelopes.find(row => row.recipientAccountId === 'account-1')!.encryptedDataKey;
    const key = resolveWorkflowRunDataKeyV1({ encryption,
      census: { ...census, dataEncryptionKey: ownerEnvelope, callerDataEncryptionKey: ownerEnvelope } });
    if (key.kind !== 'available' || key.encryption.runCrypto.mode !== 'e2ee') throw new Error('run_key_fixture_failed');
    expect(openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'e2ee', runDataKey: key.encryption.runCrypto.runDataKey,
      binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId },
      envelope: parseWorkflowStoredContentEnvelopeV1(String(admitted?.acceptedEnvelope)) })).toMatchObject({ kind: 'available', content: {
        source: { kind: 'inline', sourceArtifactId: 'def-1' }, authoredDefinition: reviewed,
      } });
  });
  it('refuses invalid typed Workflow input before workspace preparation or Run admission', async () => {
    const inputType = { pluginId: 'com.acme.inputs', localId: 'repository' };
    const prepareWorkspace = vi.fn(async () => ({ ok: true as const, workspaceTarget: {
      project: { machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } } }));
    const operations: string[] = [];
    const deps = { ...ownerDeps({ execute: async operation => {
      operations.push(String(operation.operation));
      if (operation.operation === 'get') throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
      if (operation.operation === 'admit') return { kind: 'created', run: runSnapshot().run };
      return { invocations: [] };
    } }), prepareWorkspace,
      resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => true } }),
      inputTypeDeps: { resolveInputType: async () => ({ identity: inputType, occurrenceId: 'current', definition: {
        id: inputType.localId, title: 'Repository', semantic: 'repository', valueSchema: { type: 'object' as const,
          properties: { repositoryId: { type: 'string' as const } }, required: ['repositoryId'], additionalProperties: false },
      } }) },
    };
    const owner = createWorkflowAccountRunActionOwner(deps);
    await expect(owner.execute({ actionId: 'workflow.run.start', input: WorkflowRunStartRequestV1Schema.parse({ runId,
      source: { kind: 'inline', definition: { ...definition, inputs: [{ name: 'repository', valueType: 'json', required: true, inputType }] } },
      inputs: { repository: { repositoryId: 42 } },
    }), context: { surface: 'ui', authority: 'present_user', callerPermissionMode: 'default', externalActionTarget: { kind: 'machine', machineId: 'machine-a',
      project: { machineId: 'machine-a', directory: '/repo' } } } })).rejects.toMatchObject({ code: 'input_type_value_invalid' });
    expect(prepareWorkspace).not.toHaveBeenCalled();
    expect(operations).not.toContain('admit');
  });
  it('returns the frozen child definitions with authorized Run detail rather than resolving current library content', async () => {
    if (!acceptedSnapshotResult.ok) throw new Error('snapshot_fixture_failed');
    const frozenChildren = { 'builtin:review': definition };
    const nestedDefinition = { ...definition, blocks: [{ kind: 'workflow' as const, id: 'nested', workflowRef: 'builtin:review', input: {} }] };
    const snapshot = { ...runSnapshot(), acceptedEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId },
      acceptedSnapshot: { ...acceptedSnapshotResult.snapshot, definition: nestedDefinition, authoredDefinition: nestedDefinition, frozenChildren },
    })) };
    const owner = createWorkflowAccountRunActionOwner(ownerDeps({ execute: async () => snapshot }));
    const opened = await owner.execute({ actionId: 'workflow.run.get', input: { runId }, context: {} });
    expect(opened).toMatchObject({ definition: nestedDefinition, acceptedContext: { frozenChildren } });
  });

  it.each([
    { conditions: ['terminal'] as const, observation: 'terminal', matchedCondition: 'terminal' },
    { conditions: ['attention'] as const, observation: 'needs_attention', matchedCondition: 'attention' },
  ])('waits through a pause for $matchedCondition on the existing feed', async ({ conditions, observation, matchedCondition }) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    try {
      let change: (() => void) | undefined;
      let paused = true;
      const reads: Readonly<Record<string, unknown>>[] = [];
      const owner = createWorkflowAccountRunActionOwner(ownerDeps({
        execute: async operation => {
          reads.push(operation);
          const selected = operation.conditions as readonly string[] | undefined;
          return { observation: paused ? (!selected || selected.includes('paused') ? 'paused' : 'waiting') : observation,
            ...(!paused ? { matchedCondition } : {}),
            run: { ...runSnapshot().run, state: paused ? 'paused' : matchedCondition === 'terminal' ? 'succeeded' : 'waiting_for_review',
              attentionRequired: !paused && matchedCondition === 'attention' } };
        },
        observeChanges: (_runId, onChange) => { change = onChange; return { dispose() {} }; },
      }));
      const input = WorkflowRunWaitRequestV1Schema.parse({ runId, conditions });
      let settled = false;
      const pending = owner.execute({ actionId: 'workflow.run.wait', input, context: { signal: controller.signal } });
      const result = expect(pending).resolves.toMatchObject({ observation, matchedCondition });
      void pending.then(() => { settled = true; }, () => { settled = true; });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(settled).toBe(false);
      expect(reads).toHaveLength(1);
      expect(reads[0]).toMatchObject({ conditions });
      paused = false;
      change?.();
      await result;
      expect(reads).toHaveLength(2);
    } finally { controller.abort(); vi.useRealTimers(); }
  });

  it('returns typed unmatched terminal evidence for an attention-only wait', async () => {
    const owner = createWorkflowAccountRunActionOwner(ownerDeps({ execute: async () => ({
      observation: 'not_matched_terminal', run: { ...runSnapshot().run, state: 'cancelled', attentionRequired: false },
    }) }));
    await expect(owner.execute({ actionId: 'workflow.run.wait',
      input: WorkflowRunWaitRequestV1Schema.parse({ runId, conditions: ['attention'] }), context: {} }))
      .resolves.toMatchObject({ observation: 'not_matched_terminal', run: { state: 'cancelled' } });
  });

  it('streams ordered summary snapshots, catches up reconnects, and cancels only the observer without idle reads', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    try {
      let change: (() => void) | undefined;
      let current = { ...runSnapshot().run, attentionRequired: false };
      let reads = 0;
      let disposed = false;
      const snapshots: unknown[] = [];
      let release: (() => void) | undefined;
      const firstDelivery = new Promise<void>(resolve => { release = resolve; });
      const owner = createWorkflowAccountRunActionOwner(ownerDeps({
        execute: async () => { reads += 1; return { observation: current.state === 'succeeded' ? 'terminal' : 'waiting', run: current }; },
        observeChanges: (_runId, onChange) => { change = onChange; return { dispose: () => { disposed = true; } }; },
      }));
      const pending = owner.execute({ actionId: 'workflow.run.wait', input: { runId }, context: {
        signal: controller.signal,
        onWaitSnapshot: async snapshot => { snapshots.push(snapshot); if (snapshots.length === 1) await firstDelivery; },
      } });
      const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(snapshots).toEqual([{ run: current }]);
      expect(reads).toBe(1);
      // A change during output backpressure must be delivered after the first snapshot.
      current = { ...current, state: 'running', revision: 1 };
      change?.();
      release?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(snapshots).toHaveLength(2);
      expect(snapshots[1]).toMatchObject({ run: { state: 'running', revision: 1 } });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(reads).toBe(2);
      // Invocation-only attention must publish even at the same parent revision.
      current = { ...current, attentionRequired: true };
      change?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(snapshots[2]).toMatchObject({ run: { state: 'running', revision: 1, attentionRequired: true } });
      // Reconnect invalidates once and catches up the current terminal projection.
      current = { ...current, state: 'succeeded', revision: 2, attentionRequired: false };
      change?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(snapshots[3]).toMatchObject({ run: { state: 'succeeded', revision: 2 } });
      expect(disposed).toBe(false);
      // An unchanged invalidation may read, but must not duplicate output.
      change?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(snapshots).toHaveLength(4);
      controller.abort();
      await cancelled;
      expect(disposed).toBe(true);
      const finalReads = reads;
      change?.();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(reads).toBe(finalReads);
      expect(current.state).toBe('succeeded');
    } finally { controller.abort(); vi.useRealTimers(); }
  });
  it.each(['cancel', 'timeout', 'feed_error'] as const)('releases a passive observer on %s even while its snapshot sink is backpressured', async (stop) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let release: (() => void) | undefined;
    try {
      let disposed = false;
      let delivered = false;
      let onError: ((error: unknown) => void) | undefined;
      const owner = createWorkflowAccountRunActionOwner(ownerDeps({
        execute: async () => ({ observation: 'waiting', run: runSnapshot().run }),
        observeChanges: (_runId, _onChange, fail) => { onError = fail; return { dispose: () => { disposed = true; } }; },
      }));
      const pending = owner.execute({ actionId: 'workflow.run.wait', input: { runId, ...(stop === 'timeout' ? { timeoutSeconds: 1 } : {}) }, context: {
        signal: controller.signal,
        onWaitSnapshot: () => { delivered = true; return new Promise<void>(resolve => { release = resolve; }); },
      } });
      void pending.catch(() => {});
      await vi.advanceTimersByTimeAsync(0);
      expect(delivered).toBe(true);
      if (stop === 'cancel') controller.abort();
      if (stop === 'feed_error') onError?.(Object.assign(new Error('observer_disconnected'), { code: 'observer_disconnected' }));
      await vi.advanceTimersByTimeAsync(stop === 'timeout' ? 1000 : 0);
      expect(disposed).toBe(true);
      if (stop === 'cancel') await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      else if (stop === 'timeout') await expect(pending).resolves.toMatchObject({ observation: 'timeout', run: { state: 'queued' } });
      else await expect(pending).rejects.toMatchObject({ code: 'observer_disconnected' });
    } finally { controller.abort(); release?.(); vi.useRealTimers(); }
  });
  it.each(['ui', 'agent'] as const)('freezes a version-pinned plugin workflow for %s and rejoins it after the plugin changes or disappears', async (surface) => {
    const workflow = 'plugin:com.acme.workflows/review';
    let plugin = { workflow, pluginId: 'com.acme.workflows', version: '1.2.3', title: 'Plugin review', definition };
    let available = true;
    let committed: ReturnType<typeof runSnapshot> | undefined;
    let writes = 0;
    const owner = createWorkflowAccountRunActionOwner({ ...ownerDeps({ execute: async operation => {
      if (operation.operation === 'get') {
        if (committed) return committed;
        throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
      }
      if (operation.operation === 'admit') {
        writes += 1;
        committed = { ...runSnapshot(), acceptedEnvelope: String(operation.acceptedEnvelope) };
        return { kind: 'created', run: committed.run };
      }
      if (operation.operation === 'invocations.list') return { invocations: [] };
      throw new Error('unexpected_storage_operation');
    } }), readPluginWorkflows: () => available ? [plugin] : [],
      prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: { machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } } }),
      resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => true } }),
      resolveAgentStartContext: async () => ({ caller: {
        kind: 'session', sessionId: 'caller-session', starterDepth: 0, turnDepth: 0 },
        baseline: { machineId: 'machine-a', directory: '/repo', configuration: {
          agentTarget: definition.defaults!.agentTarget!, permissionMode: 'default' } },
        roles: {}, callerPermissionCeiling: 'default', ledSubtreeSessionIds: [], workDepthLimit: 4 }),
    });
    const input = WorkflowRunStartRequestV1Schema.parse({ runId, source: { kind: 'catalog', workflow, pluginVersion: '1.2.3' } });
    const context = { surface, authority: surface === 'ui' ? 'present_user' as const : 'account_automation' as const, callerPermissionMode: 'default',
      sessionAgentSpawnPolicyV1: SessionAgentSpawnPolicyV1StrictSchema.parse({}),
      ...(surface === 'agent' ? { actionCaller: { kind: 'session' as const, sessionId: 'caller-session', starterDepth: 0, turnDepth: 0 }, defaultSessionId: 'caller-session' } : {}),
      externalActionTarget: { kind: 'machine' as const, machineId: 'machine-a', project: { machineId: 'machine-a', directory: '/repo' } } };
    await expect(owner.execute({ actionId: 'workflow.run.start',
      input: { ...input, source: { kind: 'catalog', workflow, pluginVersion: '0.9.0' } }, context }))
      .rejects.toMatchObject({ code: 'currentness_conflict' });
    expect(writes).toBe(0);
    await expect(owner.execute({ actionId: 'workflow.run.start', input, context })).resolves.toMatchObject({ admission: 'created' });
    plugin = { ...plugin, version: '2.0.0', definition: validateWorkflowDefinition({ blocks: ['Different instructions'] }).normalizedDefinition! };
    available = false;
    await expect(owner.execute({ actionId: 'workflow.run.start', input, context })).resolves.toMatchObject({ admission: 'existing' });
    const opened = await owner.execute({ actionId: 'workflow.run.get', input: { runId }, context });
    expect(opened).toMatchObject({ definition, acceptedContext: { source: { kind: 'catalog', ref: workflow, version: '1.2.3' } } });
    expect(openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
      envelope: parseWorkflowStoredContentEnvelopeV1(committed!.acceptedEnvelope),
      binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId },
    })).toMatchObject({ kind: 'available', content: { definition, source: { kind: 'catalog', ref: workflow, version: '1.2.3' } } });
    expect(writes).toBe(1);
  });
  it('waits on Account changes without periodic reads and catches up a missed change on reconnect', async () => {
    vi.useFakeTimers();
    try {
      let invalidate: (() => void) | undefined;
      let observation = 'waiting';
      let reads = 0;
      let disposed = false;
      const owner = createWorkflowAccountRunActionOwner(ownerDeps({
        execute: async () => { reads += 1; return { observation, ...(observation === 'paused' ? { matchedCondition: 'paused' } : {}), run: runSnapshot().run }; },
        observeChanges: (_runId: string, onChange: () => void) => {
          invalidate = onChange;
          return { dispose: () => { disposed = true; } };
        },
      }));
      const pending = owner.execute({ actionId: 'workflow.run.wait', input: { runId }, context: {} });
      // Attach immediately: the incumbent owner fails on the new nonterminal storage observation.
      const result = expect(pending).resolves.toMatchObject({ observation: 'paused' });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(reads).toBe(1);
      // A reconnect invalidation rereads current facts, including a change missed offline.
      observation = 'paused';
      invalidate?.();
      await result;
      expect(reads).toBe(2);
      expect(disposed).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it.each([2, 2_147_484])('expires observationally at the caller deadline (%s seconds) without changing or polling the Run', async (timeoutSeconds) => {
    vi.useFakeTimers();
    try {
      const operations: unknown[] = [];
      const owner = createWorkflowAccountRunActionOwner(ownerDeps({
        execute: async (operation) => { operations.push(operation.operation); return { observation: 'waiting', run: runSnapshot().run }; },
        observeChanges: () => ({ dispose() {} }),
      }));
      const pending = owner.execute({ actionId: 'workflow.run.wait', input: { runId, timeoutSeconds }, context: {} });
      const result = expect(pending).resolves.toMatchObject({ observation: 'timeout', run: { state: 'queued' } });
      await vi.advanceTimersByTimeAsync(timeoutSeconds * 1_000 - 1);
      expect(operations).toEqual(['wait']);
      await vi.advanceTimersByTimeAsync(1);
      await result;
      // One final current observation at the deadline; no cancel/pause/transition write.
      expect(operations).toEqual(['wait', 'wait']);
    } finally { vi.useRealTimers(); }
  });

  it.each(['inline', 'saved', 'catalog', 'plugin', 'automation'] as const)('repeats through inline start from the authenticated snapshot and retains %s lineage', async kind => {
    if (!acceptedSnapshotResult.ok) throw new Error('snapshot_fixture_failed');
    const savedBy = { kind: 'person' as const, accountId: 'editor' };
    const source = kind === 'inline' ? { kind, sourceArtifactId: 'def-1' } : kind === 'catalog' || kind === 'plugin'
      ? { kind: 'catalog', ref: kind === 'plugin' ? 'plugin:com.acme.workflows/review' : 'builtin:child', version: kind === 'plugin' ? '1.2.3' : 7 }
      : { kind, ...(kind === 'automation' ? { automationId: 'automation-1' } : {}),
        definitionId: 'def-1', revision: { headerVersion: 1, bodyVersion: 1 }, savedBy };
    const originalAccepted = WorkflowAcceptedSnapshotV1Schema.parse({ ...acceptedSnapshotResult.snapshot,
      source,
    });
    const original = { ...runSnapshot(), acceptedEnvelope: serializeWorkflowStoredContentEnvelopeV1(
      sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId }, acceptedSnapshot: originalAccepted }),
    ) };
    if (kind === 'inline') original.keyCensus.visibleTeamId = 'team-a';
    const newRunId = '22222222-2222-4222-8222-222222222222';
    let committed: ReturnType<typeof runSnapshot> | undefined;
    let admittedSourceArtifactId: unknown;
    let admittedVisibleTeamId: unknown;
    const owner = createWorkflowAccountRunActionOwner({ ...ownerDeps({ execute: async operation => {
      if (operation.operation === 'get') {
        if (operation.runId === runId) return original;
        if (committed) return committed;
        throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
      }
      if (operation.operation === 'admit') {
        admittedSourceArtifactId = operation.sourceArtifactId;
        admittedVisibleTeamId = operation.visibleTeamId;
        committed = { ...runSnapshot(), run: { ...runSnapshot().run, id: newRunId },
          keyCensus: { ...runSnapshot().keyCensus, runId: newRunId }, acceptedEnvelope: String(operation.acceptedEnvelope) };
        return { kind: 'created', run: committed.run };
      }
      if (operation.operation === 'invocations.list') return { invocations: [] };
      throw new Error('unexpected_storage_operation');
    } }), definitions: { get: async () => { throw new Error('saved_definition_was_deleted'); } },
      prepareWorkspace: async () => ({ ok: true, workspaceTarget: originalAccepted.workspaceTarget }),
      resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => true } }),
    });
    const input = WorkflowRunStartRequestV1Schema.parse({ runId: newRunId, source: { kind: 'inline',
      definition: { blocks: ['This carrier must not replace the accepted graph'] },
      replay: { runId } } });
    const actionContext = { surface: 'ui' as const, authority: 'present_user' as const, callerPermissionMode: 'default',
      defaultSessionId: 'origin-1', externalActionTarget: { kind: 'machine' as const, machineId: 'machine-a',
        project: { machineId: 'machine-a', directory: '/repo' } } };
    await expect(owner.execute({ actionId: 'workflow.run.start', input, context: actionContext }))
      .resolves.toMatchObject({ admission: 'created' });
    const opened = await owner.execute({ actionId: 'workflow.run.get', input: { runId: newRunId }, context: actionContext });
    expect(opened).toMatchObject({ definition: originalAccepted.definition,
      acceptedContext: { source: originalAccepted.source, materializedLeaves: originalAccepted.materializedLeaves } });
    expect(admittedSourceArtifactId).toBe(kind === 'catalog' || kind === 'plugin' ? null : 'def-1');
    if (kind === 'inline') expect(admittedVisibleTeamId).toBe('team-a');
    await expect(owner.execute({ actionId: 'workflow.run.start', input, context: actionContext }))
      .resolves.toMatchObject({ admission: 'existing' });
  });
  it('refuses a replay under current Agent-start policy before admitting another Run', async () => {
    let writes = 0;
    const owner = createWorkflowAccountRunActionOwner({ ...ownerDeps({ execute: async operation => {
      if (operation.operation === 'get' && operation.runId === runId) return runSnapshot();
      if (operation.operation === 'get') throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
      writes += 1;
      throw new Error('denied_replay_must_not_write');
    } }), resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => true } }),
      resolveAgentStartContext: async () => ({ caller: { kind: 'session', sessionId: 'origin-1', starterDepth: 0, turnDepth: 0 },
        baseline: { machineId: 'machine-a', directory: '/repo', configuration: {
          agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.other', localId: 'other' } }, permissionMode: 'default' } },
        roles: {}, callerPermissionCeiling: 'default', ledSubtreeSessionIds: [], workDepthLimit: 4 }),
    });
    await expect(owner.execute({ actionId: 'workflow.run.start', input: WorkflowRunStartRequestV1Schema.parse({
      runId: '22222222-2222-4222-8222-222222222222', source: { kind: 'inline', definition, replay: { runId } },
    }), context: { surface: 'agent', authority: 'account_automation', callerPermissionMode: 'default',
      defaultSessionId: 'origin-1', actionCaller: { kind: 'session', sessionId: 'origin-1', starterDepth: 0, turnDepth: 0 },
      sessionAgentSpawnPolicyV1: SessionAgentSpawnPolicyV1StrictSchema.parse({ allowBackendTargetOverride: false }),
      externalActionTarget: { kind: 'machine', machineId: 'machine-a', project: { machineId: 'machine-a', directory: '/repo' } },
    } })).rejects.toMatchObject({ code: 'policy_denied_field', details: { field: 'agentTarget' } });
    expect(writes).toBe(0);
  });
  it('admits a portable workflow role through the same inline start producer', async () => {
    let committed: ReturnType<typeof runSnapshot> | undefined;
    const portableDefinition = { version: 1 as const, inputs: [], defaults: { engine: { role: 'portable_builder' } },
      blocks: definition.blocks,
      roles: [{ roleId: 'portable_builder', name: 'Portable Builder', instructions: 'Build carefully',
        runsAs: { kind: 'session' as const }, engine: { agentTargetKey: 'happier.agent.test/test' } }],
    };
    const owner = createWorkflowAccountRunActionOwner({ ...ownerDeps({ execute: async operation => {
      if (operation.operation === 'get') {
        if (!committed) throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
        return committed;
      }
      if (operation.operation === 'admit') {
        committed = { ...runSnapshot(), acceptedEnvelope: String(operation.acceptedEnvelope) };
        return { kind: 'created', run: committed.run };
      }
      if (operation.operation === 'invocations.list') return { invocations: [] };
      throw new Error('unexpected_storage_operation');
    } }), prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: { machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } } }),
      resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => true } }),
    });
    await owner.execute({ actionId: 'workflow.run.start', input: WorkflowRunStartRequestV1Schema.parse({ runId, source: { kind: 'inline', definition: portableDefinition } }),
      context: { surface: 'ui', authority: 'present_user', callerPermissionMode: 'default', externalActionTarget: { kind: 'machine', machineId: 'machine-a',
        project: { machineId: 'machine-a', directory: '/repo' } } } });
    const opened = await owner.execute({ actionId: 'workflow.run.get', input: { runId }, context: { surface: 'ui', authority: 'present_user' } });
    expect(opened).toMatchObject({ acceptedContext: { materializedLeaves: [{ role: { name: 'Portable Builder' } }] } });
  });
  it('opens the accepted role overrides and per-step targets without re-resolving them', async () => {
    if (!acceptedSnapshotResult.ok) throw new Error('snapshot_fixture_failed');
    const roleOverrides = [{ roleId: 'builder', runsAs: { kind: 'background_run' as const, intent: 'delegate' as const } }];
    const accepted = { ...acceptedSnapshotResult.snapshot, roleOverrides };
    const snapshot = { ...runSnapshot(), acceptedEnvelope: serializeWorkflowStoredContentEnvelopeV1(
      sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId }, acceptedSnapshot: accepted }),
    ) };
    const owner = createWorkflowAccountRunActionOwner(ownerDeps({ execute: async operation => {
      if (operation.operation === 'get') return snapshot;
      if (operation.operation === 'invocations.list') return { invocations: [] };
      throw new Error('unexpected_storage_operation');
    } }));
    const opened = await owner.execute({ actionId: 'workflow.run.get', input: { runId },
      context: { surface: 'ui', authority: 'present_user' } });
    expect(opened).toMatchObject({ acceptedContext: {
      roleOverrides, materializedLeaves: accepted.materializedLeaves,
    } });
  });
  it('retains an accepted Session principal without tying the Run to origin liveness', async () => {
    let committed: ReturnType<typeof runSnapshot> | undefined;
    let originExists = true;
    const owner = createWorkflowAccountRunActionOwner({
      ...ownerDeps({ execute: async (operation) => {
        if (operation.operation === 'get') {
          if (!committed) throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
          return committed;
        }
        if (operation.operation === 'invocations.list') return { invocations: [] };
        if (operation.operation !== 'admit') throw new Error('unexpected_storage_operation');
        committed = { ...runSnapshot(), acceptedEnvelope: String(operation.acceptedEnvelope) };
        return { kind: 'created', run: committed.run };
      } }),
      prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: {
        machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } } }),
      resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => true } }),
      resolveAgentStartContext: async () => originExists ? { caller: {
        kind: 'session', sessionId: 'caller-session', starterDepth: 0, turnDepth: 0 },
        baseline: { machineId: 'machine-a', directory: '/repo', configuration: {
          agentTarget: definition.defaults!.agentTarget!, permissionMode: 'default' } },
        roles: {}, callerPermissionCeiling: 'default', ledSubtreeSessionIds: [], workDepthLimit: 4 } : null,
    });
    await expect(owner.execute({ actionId: 'workflow.run.start', input: { runId, source: { kind: 'inline',
      definition } },
      context: { surface: 'agent', authority: 'account_automation', callerPermissionMode: 'default',
        sessionAgentSpawnPolicyV1: SessionAgentSpawnPolicyV1StrictSchema.parse({}),
        actionCaller: { kind: 'session', sessionId: 'caller-session', starterDepth: 0, turnDepth: 0 }, defaultSessionId: 'caller-session',
        externalActionTarget: { kind: 'machine', machineId: 'machine-a', project: { machineId: 'machine-a', directory: '/repo' } } },
    })).resolves.toMatchObject({ admission: 'created' });
    const opened = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
      envelope: parseWorkflowStoredContentEnvelopeV1(committed!.acceptedEnvelope)!,
      binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId } });
    if (opened.kind !== 'available') throw new Error('accepted_snapshot_unavailable');
    expect(opened.content.authorization).toMatchObject({ principal: { kind: 'session', sessionId: 'caller-session' } });
    originExists = false;
    await expect(owner.execute({ actionId: 'workflow.run.get', input: { runId },
      context: { surface: 'ui', authority: 'present_user', callerPermissionMode: 'default' } }))
      .resolves.toMatchObject({ run: { id: runId } });
  });
  it.each(['agent', 'ui'] as const)('requires materialized agent-start leaves only for an %s run', async (surface) => {
    let writes = 0;
    const owner = createWorkflowAccountRunActionOwner({
      ...ownerDeps({ execute: async (operation) => {
        if (operation.operation === 'get') throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
        writes += 1;
        return { kind: 'created', run: runSnapshot().run };
      } }),
      prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: { machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } } }),
      resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => true } }),
      resolveAgentStartContext: async () => ({ caller: { kind: 'originless', runId: 'calling-run', runDepth: 1 },
        baseline: { machineId: 'machine-a', directory: '/repo' },
        roles: {}, callerPermissionCeiling: 'safe-yolo', ledSubtreeSessionIds: [], workDepthLimit: 4 }),
    });
    const result = owner.execute({ actionId: 'workflow.run.start', input: { runId, source: { kind: 'inline', definition: {
      version: 1, blocks: [{ kind: 'wait', id: 'wait', document: { text: 'Choose', references: [], attachments: [] } }],
    } } }, context: { surface, ...(surface === 'ui' ? { authority: 'present_user' as const } : {}), callerPermissionMode: 'safe-yolo',
      externalActionTarget: { kind: 'machine', machineId: 'machine-a', project: { machineId: 'machine-a', directory: '/repo' } } } });
    if (surface === 'agent') await expect(result).rejects.toMatchObject({ code: 'target_unavailable' });
    else await expect(result).resolves.toMatchObject({ admission: 'created' });
    expect(writes).toBe(surface === 'agent' ? 0 : 1);
  });

  it('records boundary Resume without opening encrypted content or checking private authority', async () => {
    const calls: string[] = [];
    const resumed = { ...runSnapshot().run, state: 'queued' as const, revision: 4 };
    const owner = createWorkflowAccountRunActionOwner({
      ...ownerDeps({ execute: async (operation) => {
        calls.push(String(operation.operation));
        if (operation.operation !== 'resume') throw new Error('key_free_resume_cannot_read_private_content');
        return { run: resumed, intent: 'resumed' };
      } }),
      resolveEncryption: async () => { throw new Error('encrypted_run_key_not_available'); },
      isAcceptedAuthorizationCurrent: async () => { throw new Error('worker_checks_private_authority'); },
    });
    await expect(owner.execute({ actionId: 'workflow.run.resume',
      input: { mode: 'boundary', runId, expectedRevision: 3 },
      context: { surface: 'ui', authority: 'present_user' } })).resolves.toEqual({ run: resumed, intent: 'resumed' });
    expect(calls).toEqual(['resume']);
  });

  it('preserves the typed Can-edit refusal from key-free boundary Resume', async () => {
    const owner = createWorkflowAccountRunActionOwner(ownerDeps({ execute: async (operation) => {
      if (operation.operation !== 'resume') throw new Error('key_free_resume_cannot_read_private_content');
      throw Object.assign(new Error('run_access_denied'), { response: { status: 403, data: { error: 'run_access_denied' } } });
    } }));
    await expect(owner.execute({ actionId: 'workflow.run.resume',
      input: { mode: 'boundary', runId, expectedRevision: 3 },
      context: { surface: 'ui', authority: 'present_user' } })).rejects.toMatchObject({ code: 'run_access_denied' });
  });

  it.each([
    { target: { kind: 'machine' as const, machineId: 'machine-a' }, allowed: true },
    { target: { kind: 'machine' as const, machineId: 'machine-b' }, allowed: false },
    { target: { kind: 'machine' as const, machineId: 'machine-a', project: { machineId: 'machine-a', directory: '/repo' } }, allowed: false },
    { target: { kind: 'machine' as const, machineId: 'machine-a', project: { machineId: 'machine-a', directory: '/other' } }, allowed: false },
  ])('enforces resource restrictions without opening private Resume content ($target)', async ({ target, allowed }) => {
    let resumed = false;
    const owner = createWorkflowAccountRunActionOwner({
      ...ownerDeps({ execute: async operation => {
        if (operation.operation === 'get') return { ...runSnapshot(), acceptedEnvelope: 'unreadable' };
        if (operation.operation === 'resume') { resumed = true; return { run: runSnapshot().run, intent: 'resumed' }; }
        throw new Error('unexpected_storage_operation');
      } }),
      resolveEncryption: async () => { throw new Error('key_free_resume_must_not_resolve_keys'); },
    });
    const result = owner.execute({ actionId: 'workflow.run.resume', input: { mode: 'boundary', runId, expectedRevision: 0 },
      context: { surface: 'ui', authority: 'present_user', externalActionTarget: target } });
    if (allowed) await expect(result).resolves.toMatchObject({ intent: 'resumed' });
    else await expect(result).rejects.toMatchObject({ code: 'target_unavailable' });
    expect(resumed).toBe(allowed);
  });

  it.each([
    { surface: 'agent', authority: 'account_automation', originSessionId: 'origin-1', explicit: false, delivery: true },
    { surface: 'agent', authority: 'present_user', originSessionId: 'origin-1', explicit: false, delivery: false },
    { surface: 'ui', authority: 'present_user', originSessionId: 'origin-1', explicit: false, delivery: false },
    { surface: 'ui', authority: 'present_user', originSessionId: 'origin-1', explicit: true, delivery: true },
    { surface: 'agent', authority: 'account_automation', originSessionId: undefined, explicit: false, delivery: false },
  ] as const)('normalizes direct origin delivery once for $surface/$authority/$explicit/$originSessionId and rejoin', async (scenario) => {
    let committed: ReturnType<typeof runSnapshot> | undefined;
    let writes = 0;
    let deliveryRequest: unknown;
    const owner = createWorkflowAccountRunActionOwner({
      ...ownerDeps({ execute: async (operation) => {
        if (operation.operation === 'get') {
          if (!committed) throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
          return committed;
        }
        if (operation.operation !== 'admit') throw new Error('unexpected_storage_operation');
        writes += 1;
        deliveryRequest = operation.resultDelivery;
        committed = { ...runSnapshot(), acceptedEnvelope: String(operation.acceptedEnvelope) };
        return { kind: 'created', run: committed.run };
      } }),
      prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: { machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } } }),
      resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => true } }),
      resolveAgentStartContext: async () => ({ caller: { kind: 'originless', runId, runDepth: 0,
        ...(scenario.originSessionId ? { runOriginSessionId: scenario.originSessionId } : {}) },
        baseline: { machineId: 'machine-a', directory: '/repo', configuration: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } }, permissionMode: 'default' } },
        roles: {}, callerPermissionCeiling: 'safe-yolo', ledSubtreeSessionIds: [], workDepthLimit: 4 }),
    });
    const args = { actionId: 'workflow.run.start' as const,
      input: { runId, source: { kind: 'inline' as const, definition },
        ...(scenario.explicit ? { onComplete: { kind: 'originating_session' as const } } : {}) },
      context: { surface: scenario.surface, authority: scenario.authority, callerPermissionMode: 'safe-yolo',
        ...(scenario.originSessionId ? { defaultSessionId: scenario.originSessionId } : {}),
        externalActionTarget: { kind: 'machine' as const, machineId: 'machine-a', project: { machineId: 'machine-a', directory: '/repo' } } } };
    await expect(owner.execute(args)).resolves.toMatchObject({ admission: 'created' });
    const opened = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
      envelope: parseWorkflowStoredContentEnvelopeV1(committed!.acceptedEnvelope)!,
      binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId } });
    if (opened.kind !== 'available') throw new Error('accepted_snapshot_unavailable');
    // These requests have the canonical host caller even on the agent transport.
    expect(opened.content).toMatchObject({ startedBy: 'user' });
    const acceptedDelivery = 'resultDelivery' in opened.content ? opened.content.resultDelivery : undefined;
    expect(acceptedDelivery).toEqual(scenario.delivery
      ? { kind: 'originating_session', originSessionId: scenario.originSessionId } : undefined);
    expect(deliveryRequest).toEqual(scenario.delivery ? { kind: 'originating_session' } : undefined);
    await expect(owner.execute(args)).resolves.toMatchObject({ admission: 'existing' });
    expect(writes).toBe(1);
  });

  it.each([
    { activity: 'active', lifecycle: 'failed', same: false, fresh: false, reattach: false, continuation: true },
    { activity: 'not_active', lifecycle: 'failed', same: true, fresh: true, reattach: false, continuation: true },
    { activity: 'not_active', lifecycle: 'failed', same: false, fresh: true, reattach: false, continuation: false },
    { activity: 'unknown', lifecycle: 'needs_attention', same: false, fresh: false, reattach: true, continuation: true },
    { activity: 'active', lifecycle: 'cancel_requested', same: false, fresh: false, reattach: true, continuation: true },
    { activity: 'unknown', lifecycle: 'failed', same: false, fresh: false, reattach: false, continuation: false },
    { activity: 'not_active', lifecycle: 'needs_attention', same: true, fresh: true, reattach: false, continuation: true },
    { activity: 'not_active', lifecycle: 'failed', same: false, fresh: false, reattach: false, continuation: true, stale: true },
    { activity: 'not_active', lifecycle: 'failed', same: false, fresh: false, reattach: false, continuation: false, workspace: true, restore: true },
    { activity: 'unknown', lifecycle: 'needs_attention', same: false, fresh: false, reattach: false, continuation: false, workspace: true, restore: false },
  ] as const)('uses exact observation for offered and enforced recovery: $activity/$lifecycle', async (scenario) => {
    const recordId = '33333333-3333-4333-8333-333333333333';
    const snapshot = runSnapshot();
    snapshot.run.state = 'interrupted';
    snapshot.run.revision = 2;
    // These are initially stored envelope snapshots, matching the persisted
    // WorkflowRunInvocation default and canonical storage testkit admission.
    const index = { id: recordId, runId, sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0', contentRevision: '0',
      lifecycle: scenario.lifecycle, createdAt: snapshot.run.createdAt, updatedAt: snapshot.run.updatedAt };
    const contentEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId: 'account-1', runId, recordId,
        sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' },
      progress: { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: 'work', scope: [] },
        blockKind: 'step', attempt: '0', logicalInvocationRecordId: recordId,
        execution: { kind: 'session', sessionId: 'session-1', localInputId: 'input-1' },
        ...('workspace' in scenario ? { reason: { code: 'workspace_unavailable' }, workspace: {
          creationIntent: { kind: 'git_worktree' as const, sourceDirectory: '/repo', baseRef: 'a'.repeat(40), displayName: 'work', branchMode: 'new' as const },
          descriptor: { machineId: 'machine-a', directory: '/repo/work', checkoutRootPath: '/repo/work', checkout: { kind: 'git_worktree' as const, branchName: 'work' } },
        } } : {}),
        ...(scenario.activity === 'not_active' && scenario.lifecycle === 'needs_attention'
          ? { uncertainPriorEffects: { activity: 'stopped' as const } } : {}),
        recovery: { conversation: 'same_conversation', input: { kind: 'replacement', value: { document: { text: 'prepared', references: [], attachments: [] }, input: [] } } } },
    }));
    const latestId = '44444444-4444-4444-8444-444444444444';
    const latestIndex = { ...index, id: latestId, attempt: '1', sequence: '1', lifecycle: 'pending' };
    const latestEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId: 'account-1', runId, recordId: latestId,
        sequence: '1', parentRecordId: null, memberOrdinal: '0', attempt: '1' },
      progress: { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: 'work', scope: [] },
        blockKind: 'step', attempt: '1', logicalInvocationRecordId: recordId, previousAttemptRecordId: recordId },
    }));
    let reattachments = 0;
    let replacements = 0;
    const owner = createWorkflowAccountRunActionOwner({
      ...ownerDeps({ execute: async (operation) => {
        if (operation.operation === 'get') return snapshot;
        if (operation.operation === 'invocations.get') return { invocation: operation.invocationId === latestId
          ? { index: latestIndex, contentEnvelope: latestEnvelope, parentRevision: 2 } : { index, contentEnvelope, parentRevision: 2 } };
        if (operation.operation === 'invocations.list') return { invocations: [index, ...('stale' in scenario ? [latestIndex] : [])], nextCursor: null };
        replacements += 1;
        throw new Error('unexpected_replacement');
      } }),
      observeRecovery: async () => ({ activity: scenario.activity, canReattach: scenario.reattach, canContinueConversation: scenario.continuation }),
      reattachInvocation: async () => { reattachments += 1; },
    });
    const detail = await owner.execute({ actionId: 'workflow.run.invocations.get', input: { runId, invocationId: recordId }, context: {} });
    expect(detail).toMatchObject({ invocation: { recoveryAvailability: {
      reattach: { kind: scenario.reattach ? 'available' : 'unavailable' },
      continueSameConversation: { kind: scenario.same ? 'available' : 'unavailable' },
      continueFreshAgent: { kind: scenario.fresh ? 'available' : 'unavailable' },
      retry: { kind: scenario.fresh ? 'available' : 'unavailable' },
      ...('restore' in scenario ? { restoreWorkspace: { kind: scenario.restore ? 'available' : 'unavailable' } } : {}),
    } } });
    if (!scenario.same) {
      await expect(owner.execute({ actionId: 'workflow.run.resume', input: { mode: 'recover', runId, expectedRevision: 2,
        invocations: [{ kind: 'continue', invocation: { recordId }, conversation: 'same_conversation', input: { document: { text: 'new', references: [], attachments: [] }, input: [] } }] },
        context: { authority: 'present_user', callerPermissionMode: 'safe-yolo' } })).rejects.toMatchObject({ code: 'ineligible_state' });
    }
    if (scenario.activity === 'not_active' && scenario.lifecycle === 'needs_attention') {
      await expect(owner.execute({ actionId: 'workflow.run.resume', input: { mode: 'recover', runId, expectedRevision: 2,
        invocations: [{ kind: 'continue', invocation: { recordId }, conversation: 'fresh_agent', input: { document: { text: 'new', references: [], attachments: [] }, input: [] } }] },
        context: { authority: 'present_user', callerPermissionMode: 'safe-yolo' } })).rejects.toMatchObject({ code: 'workflow_outcome_unresolved' });
    }
    if (scenario.reattach) {
      await owner.execute({ actionId: 'workflow.run.resume', input: { mode: 'recover', runId, expectedRevision: 2,
        invocations: [{ kind: 'reattach', invocation: { recordId } }] }, context: {} });
      expect(reattachments).toBe(1);
    }
    expect(replacements).toBe(0);
  });

  it.each(['inline', 'saved'] as const)('materializes run overrides before authority and freezes them across %s admission rejoin', async (sourceKind) => {
    const authored = {
      version: 1,
      defaults: { engine: { role: 'writer' } },
      roles: [{ roleId: 'writer', name: 'Writer', instructions: 'Write carefully',
        engine: { agentTargetKey: 'happier.agent.test/test', modelId: 'pinned' },
        runsAs: { kind: 'session' }, workspaceWrites: 'allow', secondOpinion: 'off' }],
      blocks: ['work'],
    };
    const roleOverrides = [{ roleId: 'writer', engine: { agentTargetKey: 'happier.agent.test/test', modelId: 'override' } }];
    let committed: ReturnType<typeof runSnapshot> | undefined;
    let writes = 0;
    let resolutions = 0;
    const owner = createWorkflowAccountRunActionOwner({
      ...ownerDeps({ execute: async (operation) => {
        if (operation.operation === 'get') {
          if (!committed) throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
          return committed;
        }
        if (operation.operation !== 'admit') throw new Error('unexpected_storage_operation');
        writes += 1;
        committed = { ...runSnapshot(), acceptedEnvelope: String(operation.acceptedEnvelope) };
        return { kind: 'created', run: committed.run };
      } }),
      definitions: { get: async () => ({ definitionId: 'def-1', revision: { headerVersion: 1, bodyVersion: 1 },
        definition: validateWorkflowDefinition(authored).normalizedDefinition!, metadata: { title: 'Saved roles' },
        savedBy: { kind: 'agent', accountId: 'editor-account', sessionId: 'editor-session' } }) },
      prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: { machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } } }),
      resolveMaterializationContext: async () => {
        resolutions += 1;
        return { effects: { resolveTargetAvailability: async () => true } };
      },
    });
    const source = sourceKind === 'inline' ? { kind: 'inline' as const, definition: authored }
      : { kind: 'saved' as const, definitionId: 'def-1', revision: { headerVersion: 1, bodyVersion: 1 } };
    const args = { actionId: 'workflow.run.start' as const, input: { runId, source, roleOverrides },
      context: { authority: 'present_user' as const, callerPermissionMode: 'safe-yolo', defaultSessionId: 'origin-1',
        externalActionTarget: { kind: 'machine' as const, machineId: 'machine-a', project: { machineId: 'machine-a', directory: '/repo' } } } };
    await expect(owner.execute(args)).resolves.toMatchObject({ admission: 'created' });
    const envelope = parseWorkflowStoredContentEnvelopeV1(committed!.acceptedEnvelope)!;
    const opened = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain', envelope,
      binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId } });
    expect(opened).toMatchObject({ kind: 'available', content: { roleOverrides, workDepth: 0,
      definition: { blocks: [{ execution: { modelSelection: { ref: { modelId: 'override' } } } }] } } });
    if (sourceKind === 'saved') expect(opened).toMatchObject({ content: { source: {
      savedBy: { kind: 'agent', accountId: 'editor-account', sessionId: 'editor-session' },
    } } });
    if (opened.kind === 'available') expect(opened.content.authoredDefinition)
      .toEqual(validateWorkflowDefinition(authored).normalizedDefinition);
    await expect(owner.execute(args)).resolves.toMatchObject({ admission: 'existing' });
    expect(writes).toBe(1);
    expect(resolutions).toBe(1);
    await expect(owner.execute({ ...args, input: { ...args.input, roleOverrides: [] } })).rejects.toMatchObject({ code: 'currentness_conflict' });
  });

  it.each(['availability', 'depth', 'model_policy'] as const)('refuses %s before writing a direct Run', async (scenario) => {
    let writes = 0;
    const owner = createWorkflowAccountRunActionOwner({
      ...ownerDeps({ execute: async (operation) => {
        if (operation.operation === 'get') throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
        writes += 1;
        throw new Error('must_not_write_refused_run');
      } }),
      prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: { machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } } }),
      resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => scenario !== 'availability' } }),
      resolveAgentStartContext: async () => ({ caller: { kind: 'session', sessionId: 'origin-1', starterDepth: scenario === 'depth' ? 4 : 1, turnDepth: 0 },
        baseline: { machineId: 'machine-a', directory: '/repo', configuration: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } }, permissionMode: 'default' } },
        roles: {}, callerPermissionCeiling: 'safe-yolo', ledSubtreeSessionIds: [], workDepthLimit: 4 }),
    });
    const result = owner.execute({ actionId: 'workflow.run.start', input: { runId, source: { kind: 'inline', definition: {
      version: 1, defaults: { engine: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } },
        modelSelection: { v: 1, updatedAt: 0, ref: { agentTargetKey: 'happier.agent.test/test', providerConnectionId: null, modelId: 'override' } } } }, blocks: ['work'],
    } } }, context: { surface: scenario === 'availability' ? 'cli' : 'agent', authority: scenario === 'availability' ? 'present_user' : undefined,
      callerPermissionMode: 'safe-yolo', defaultSessionId: 'origin-1',
      sessionAgentSpawnPolicyV1: SessionAgentSpawnPolicyV1StrictSchema.parse({ allowModelOverride: scenario !== 'model_policy' }),
      externalActionTarget: { kind: 'machine', machineId: 'machine-a', project: { machineId: 'machine-a', directory: '/repo' } } } });
    await expect(result).rejects.toMatchObject({ code: scenario === 'availability' ? 'target_unavailable' : scenario === 'depth' ? 'work_depth_exceeded' : 'policy_denied_field' });
    expect(writes).toBe(0);
  });
  it('reads one lean summary batch without resolving definitions or Account keys', async () => {
    const result = { summaries: [{ sourceArtifactId: 'def-1', lastRun: null, recent: [], needsYouCount: 0, needsYouRunId: null }], remainingSourceArtifactIds: ['def-2'] };
    const deps = ownerDeps({ execute: async (operation, options) => {
      if (operation.operation !== 'summaries' || options?.publisherMachineId) throw new Error('unexpected_storage_boundary');
      return result;
    } });
    const owner = createWorkflowAccountRunActionOwner({
      ...deps,
      definitions: { get: async () => { throw new Error('must_not_read_definition'); } },
      resolveEncryption: async () => { throw new Error('must_not_resolve_private_keys'); },
    });
    await expect(owner.execute({ actionId: 'workflow.run.summaries', input: { sourceArtifactIds: ['def-1', 'def-2'], recent: 3 }, context: {} })).resolves.toEqual(result);
  });
  it('refuses unaccepted plugin catalog sources before any run effect', async () => {
    const owner = createWorkflowAccountRunActionOwner(ownerDeps({ execute: async () => { throw new Error('must_not_access_run'); } }));
    await expect(owner.execute({ actionId: 'workflow.run.start', input: {
      runId, source: { kind: 'catalog', workflow: 'plugin:happier.test/workflow' },
    }, context: {} })).rejects.toMatchObject({ code: 'source_unavailable' });
  });

  it('fails role admission closed when the materialization host is unavailable', async () => {
    const owner = createWorkflowAccountRunActionOwner(ownerDeps({ execute: async (operation) => {
      if (operation.operation === 'get') throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
      throw new Error('must_not_write_unavailable_run');
    } }));
    await expect(owner.execute({ actionId: 'workflow.run.start', input: {
      runId, source: { kind: 'inline', definition }, roleOverrides: [{ roleId: 'reviewer', workspaceWrites: 'deny' }],
    }, context: { externalActionTarget: { kind: 'machine', machineId: 'machine-a', project: { machineId: 'machine-a', directory: '/repo' } } } })).rejects.toMatchObject({ code: 'target_unavailable' });
  });
  it.each(['revision_changed', 'source_deleted', 'run_absent', 'different_origin'] as const)(
    'rechecks the exact immutable admission after mutable source failure: %s', async (scenario) => {
      const snapshot = runSnapshot();
      let reads = 0;
      const deps = ownerDeps({ execute: async (operation) => {
        if (operation.operation !== 'get') throw new Error('must_not_repeat_effect');
        reads += 1;
        if (reads === 1 || scenario === 'run_absent') throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
        return snapshot;
      } });
      const prepareWorkspace = vi.fn();
      const owner = createWorkflowAccountRunActionOwner({
        ...deps, prepareWorkspace,
        definitions: { get: async () => {
          if (scenario === 'source_deleted') throw Object.assign(new Error('source_unavailable'), { code: 'source_unavailable' });
          return { definitionId: 'def-1', revision: { headerVersion: 2, bodyVersion: 2 }, definition, metadata: { title: 'Changed' } };
        } },
      });
      const result = owner.execute({ actionId: 'workflow.run.start', input: {
        runId, source: { kind: 'saved', definitionId: 'def-1', revision: { headerVersion: 1, bodyVersion: 1 } },
      }, context: {
        callerPermissionMode: 'safe-yolo',
        defaultSessionId: scenario === 'different_origin' ? 'origin-2' : 'origin-1',
        externalActionTarget: { kind: 'machine', machineId: 'machine-a', project: { machineId: 'machine-a', directory: '/repo' } },
      } });
      if (scenario === 'run_absent' || scenario === 'different_origin') {
        await expect(result).rejects.toMatchObject({ code: 'currentness_conflict' });
      } else {
        await expect(result).resolves.toMatchObject({ admission: 'existing', run: { id: runId } });
      }
      expect(reads).toBe(2);
      expect(prepareWorkspace).not.toHaveBeenCalled();
    },
  );

  it.each([null, { kind: 'person' as const, accountId: 'editor' }])('retains saved authorship in authenticated detail while wait and cancellation remain boundary-only (%j)', async (savedBy) => {
    const snapshot = runSnapshot();
    if (!acceptedSnapshotResult.ok || acceptedSnapshotResult.snapshot.source.kind !== 'saved') throw new Error('saved_snapshot_fixture_required');
    snapshot.acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId },
      acceptedSnapshot: { ...acceptedSnapshotResult.snapshot, source: { ...acceptedSnapshotResult.snapshot.source, savedBy } },
    }));
    const owner = createWorkflowAccountRunActionOwner(ownerDeps({ execute: async (operation, options) => {
      expect(options?.publisherMachineId).toBeUndefined();
      if (operation.operation === 'get') return snapshot;
      if (operation.operation === 'invocations.list') return { invocations: [] };
      if (operation.operation === 'wait') return { run: snapshot.run, observation: 'timeout' };
      if (operation.operation === 'cancel') return { run: { ...snapshot.run, state: 'cancelled' }, intent: 'cancel_requested' };
      throw new Error(`unexpected:${String(operation.operation)}`);
    } }));
    const detail = WorkflowRunGetResultV1Schema.parse(await owner.execute({ actionId: 'workflow.run.get', input: { runId }, context: {} }));
    expect(detail).toMatchObject({ definition });
    expect(detail.acceptedContext.source).toEqual({ kind: 'saved', definitionId: 'def-1',
      revision: { headerVersion: 1, bodyVersion: 1 }, savedBy });
    await expect(owner.execute({ actionId: 'workflow.run.wait', input: { runId, timeoutSeconds: 1 }, context: {} })).resolves.toMatchObject({ observation: 'timeout' });
    await expect(owner.execute({ actionId: 'workflow.run.cancel', input: { runId, expectedRevision: 0 }, context: {} })).resolves.toMatchObject({ run: { state: 'cancelled' }, intent: 'cancel_requested' });
  });

  it.each(['workflow.run.get', 'workflow.run.cancel', 'workflow.run.invocations.list'] as const)(
    'rejects an explicit resource restriction that disagrees with the retained Run for %s', async (actionId) => {
      const snapshot = runSnapshot();
      const operations: string[] = [];
      const owner = createWorkflowAccountRunActionOwner(ownerDeps({ execute: async (operation) => {
        operations.push(String(operation.operation));
        if (operation.operation === 'get') return snapshot;
        if (operation.operation === 'invocations.list') return { invocations: [] };
        if (operation.operation === 'cancel') return { run: snapshot.run, intent: 'cancel_requested' };
        throw new Error('unexpected_storage_operation');
      } }));
      const context = { authority: 'present_user' as const,
        externalActionTarget: { kind: 'machine' as const, machineId: 'another-machine' } };
      const pending = actionId === 'workflow.run.cancel'
        ? owner.execute({ actionId, input: { runId, expectedRevision: 0 }, context })
        : owner.execute({ actionId, input: { runId }, context });
      await expect(pending).rejects.toMatchObject({ code: 'target_unavailable' });
      expect(operations).not.toContain('cancel');
      expect(operations).not.toContain('invocations.list');
    },
  );

  it('uses the accepted project restriction for reads and never substitutes the relay project', async () => {
    const snapshot = runSnapshot();
    const owner = createWorkflowAccountRunActionOwner(ownerDeps({ execute: async (operation) => {
      if (operation.operation === 'get') return snapshot;
      if (operation.operation === 'invocations.list') return { invocations: [] };
      throw new Error('unexpected_storage_operation');
    } }));
    await expect(owner.execute({ actionId: 'workflow.run.get', input: { runId }, context: {
      externalActionTarget: { kind: 'machine', machineId: 'machine-a', project: { machineId: 'machine-a', directory: '/other-project' } },
    } })).rejects.toMatchObject({ code: 'target_unavailable' });
    await expect(owner.execute({ actionId: 'workflow.run.get', input: { runId }, context: {
      externalActionTarget: { kind: 'machine', machineId: 'machine-a', project: { machineId: 'machine-a', directory: '/repo' } },
    } })).resolves.toMatchObject({ definition });
  });

  it('projects the required frozen admitting starter in the lean list', async () => {
    const snapshot = runSnapshot();
    const owner = createWorkflowAccountRunActionOwner(ownerDeps({ execute: async (operation) => {
      if (operation.operation !== 'list') throw new Error('lean_list_must_not_read_detail');
      return { runs: [snapshot.run], acceptedEnvelopesByRunId: { [runId]: snapshot.acceptedEnvelope },
        keyCensusByRunId: { [runId]: snapshot.keyCensus } };
    } }));
    // The snapshot fixture is admitted by the real user materializer, not an origin/depth guess.
    await expect(owner.execute({ actionId: 'workflow.run.list', input: {}, context: {} }))
      .resolves.toMatchObject({ runs: [{ startedBy: 'user' }] });
  });

  it('finds destination writes after nonmatching pages for both Account and Session triggers', async () => {
    const snapshot = runSnapshot();
    const scoped = await materializeWorkflowAcceptedSnapshotV1({ definition: { ...definition,
      defaults: { ...definition.defaults, conversation: { kind: 'origin_session' } } },
      context: {
        source: { kind: 'automation', automationId: 'habit' }, inputs: {}, machineId: 'machine-a',
        executionTarget: { kind: 'session' }, workspaceTarget: { project: { machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } },
        origin: { kind: 'direct', originSessionId: 'destination' }, authorization: { principal: { kind: 'host' } } },
      admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true } });
    const account = await materializeWorkflowAcceptedSnapshotV1({ definition: { ...definition,
      defaults: { ...definition.defaults, conversation: { kind: 'existing_session', sessionId: 'destination', machineId: 'machine-a' } } },
      context: { source: { kind: 'automation', automationId: 'account-trigger' }, inputs: {}, machineId: 'machine-a',
        executionTarget: { kind: 'session' }, workspaceTarget: { project: { machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } },
        authorization: { principal: { kind: 'host' } } },
      admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true } });
    if (!scoped.ok || !account.ok) throw new Error('destination_fixture_failed');
    // Accepted 0.3 snapshots before HB did not carry the stored projection.
    const beforeHb = { ...account.snapshot };
    delete beforeHb.targetSessionIds;
    const envelope = (acceptedSnapshot: typeof scoped.snapshot, id: string) => serializeWorkflowStoredContentEnvelopeV1(
      sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId: id }, acceptedSnapshot }));
    const requested: unknown[] = [];
    const owner = createWorkflowAccountRunActionOwner(ownerDeps({ execute: async operation => {
      if (operation.operation !== 'list') throw new Error('destination_filter_must_stay_lean');
      requested.push(operation.request);
      if (requested.length === 1) return { runs: [snapshot.run],
        acceptedEnvelopesByRunId: { [runId]: snapshot.acceptedEnvelope },
        keyCensusByRunId: { [runId]: snapshot.keyCensus }, nextCursor: 'next-page' };
      return { runs: ['habit-run', 'account-run'].map(id => ({ ...snapshot.run, id })),
        acceptedEnvelopesByRunId: { 'habit-run': envelope(scoped.snapshot, 'habit-run'), 'account-run': envelope(beforeHb, 'account-run') },
        keyCensusByRunId: Object.fromEntries(['habit-run', 'account-run'].map(id => [id, { ...snapshot.keyCensus, runId: id }])) };
    } }));
    const result = await owner.execute({ actionId: 'workflow.run.list', input: { targetSessionId: 'destination' }, context: {} });
    expect(result).toMatchObject({ runs: [{ id: 'habit-run' }, { id: 'account-run' }] });
    expect(requested).toEqual([{ targetSessionId: 'destination' }, { targetSessionId: 'destination', cursor: 'next-page' }]);
  });

  it('opens completed authored progress in the lean list without reading Run detail', async () => {
    const snapshot = runSnapshot();
    const unreadableId = '22222222-2222-4222-8222-222222222222';
    const rootId = 'root-list-progress';
    const index = { id: rootId, runId, sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0',
      contentRevision: '4', lifecycle: 'running', createdAt: snapshot.run.createdAt, updatedAt: snapshot.run.updatedAt };
    // Storage returns opaque bytes; the real opener and exact binding run in the list owner.
    const contentEnvelope = JSON.stringify({ t: 'plain', v: {
      v: 2, binding: { v: 1, purpose: 'invocation_progress', accountId: 'account-1', runId,
        recordId: rootId, sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' },
      content: { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: '$root', scope: [] },
        blockKind: 'root', attempt: '0', logicalInvocationRecordId: rootId,
        stepProgress: { completed: 1, total: 3, currentLoop: { completed: 1, total: 4 } } },
    } });
    const owner = createWorkflowAccountRunActionOwner(ownerDeps({ execute: async (operation) => {
      if (operation.operation !== 'list') throw new Error('lean_list_must_not_read_detail_or_invocations');
      return {
        runs: [snapshot.run, { ...snapshot.run, id: unreadableId }],
        acceptedEnvelopesByRunId: { [runId]: snapshot.acceptedEnvelope, [unreadableId]: snapshot.acceptedEnvelope },
        keyCensusByRunId: { [runId]: snapshot.keyCensus, [unreadableId]: { ...snapshot.keyCensus, runId: unreadableId } },
        rootProgressByRunId: { [runId]: { index, contentEnvelope }, [unreadableId]: { index, contentEnvelope } },
      };
    } }));
    const result = await owner.execute({ actionId: 'workflow.run.list', input: {}, context: {} });
    expect(result).toMatchObject({ runs: [{ id: runId,
      where: { machineId: 'machine-a', directory: '/repo' }, startedBy: 'user',
      stepProgressCurrentness: { recordId: rootId, attempt: '0', contentRevision: '4' },
      stepProgress: { completed: 1, total: 3, currentLoop: { completed: 1, total: 4 } } },
      { id: unreadableId, where: null, startedBy: null, stepProgress: null, stepProgressCurrentness: null }],
      metadataByRunId: { [unreadableId]: { kind: 'unavailable', reason: 'content_unavailable' } } });
    // The name may be absent on a readable snapshot; its Where remains available.
    expect(result.metadataByRunId).not.toHaveProperty(runId);
  });

  it.each(['unreadable', 'child', 'foreign-envelope', 'missing'] as const)
  ('binds root count currentness independently of private readability (%s)', async (scenario) => {
    const snapshot = runSnapshot();
    const rootId = 'root-list-token';
    const index = { id: rootId, runId, sequence: scenario === 'child' ? '1' : '0',
      parentRecordId: scenario === 'child' ? 'another-root' : null, memberOrdinal: '0', attempt: '0',
      contentRevision: '9', lifecycle: 'running', createdAt: snapshot.run.createdAt, updatedAt: snapshot.run.updatedAt };
    const contentEnvelope = JSON.stringify({ t: 'plain', v: { v: 2,
      binding: { v: 1, purpose: 'invocation_progress', accountId: 'account-1',
        runId: scenario === 'foreign-envelope' ? 'other-run' : runId, recordId: rootId,
        sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' }, content: scenario === 'foreign-envelope'
          ? { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: '$root', scope: [] },
            blockKind: 'root', attempt: '0', logicalInvocationRecordId: rootId }
          : { malformed: true } } });
    const owner = createWorkflowAccountRunActionOwner(ownerDeps({ execute: async (operation) => {
      if (operation.operation !== 'list') throw new Error('lean_list_must_not_read_detail');
      return { runs: [snapshot.run], acceptedEnvelopesByRunId: { [runId]: snapshot.acceptedEnvelope },
        keyCensusByRunId: { [runId]: snapshot.keyCensus },
        rootProgressByRunId: scenario === 'missing' ? {} : { [runId]: { index, contentEnvelope } } };
    } }));
    await expect(owner.execute({ actionId: 'workflow.run.list', input: {}, context: {} }))
      .resolves.toMatchObject({ runs: [{ startedBy: 'user', where: { machineId: 'machine-a', directory: '/repo' },
        stepProgress: null, stepProgressCurrentness: scenario === 'unreadable'
          ? { recordId: rootId, attempt: '0', contentRevision: '9' } : null }] });
  });

  it('narrows a listed resource to the explicit Machine and refuses restrictions the batch cannot represent', async () => {
    const snapshot = runSnapshot();
    const owner = createWorkflowAccountRunActionOwner(ownerDeps({ execute: async (operation) => {
      if (operation.operation !== 'list') throw new Error('must_not_read_unrestricted_summary_batch');
      const request = operation.request as Readonly<{ machineId?: string }>;
      return {
        runs: request.machineId === 'machine-a' ? [snapshot.run] : [],
        acceptedEnvelopesByRunId: { [runId]: snapshot.acceptedEnvelope },
        keyCensusByRunId: { [runId]: snapshot.keyCensus },
      };
    } }));
    const target = { kind: 'machine' as const, machineId: 'machine-a' };
    await expect(owner.execute({ actionId: 'workflow.run.list', input: {}, context: { externalActionTarget: target } }))
      .resolves.toMatchObject({ runs: [{ id: runId }] });
    await expect(owner.execute({ actionId: 'workflow.run.list', input: { machineId: 'machine-b' }, context: { externalActionTarget: target } }))
      .rejects.toMatchObject({ code: 'target_unavailable' });
    await expect(owner.execute({ actionId: 'workflow.run.summaries', input: { sourceArtifactIds: ['def-1'] }, context: { externalActionTarget: target } }))
      .rejects.toMatchObject({ code: 'target_unavailable' });
  });

  it('rejoins the frozen Team choice but rejects a different explicit admission audience', async () => {
    const snapshot = runSnapshot();
    snapshot.keyCensus.visibleTeamId = 'team-a';
    const owner = createWorkflowAccountRunActionOwner({
      ...ownerDeps({ execute: async operation => {
        if (operation.operation !== 'get') throw new Error('must_not_repeat_admission');
        return snapshot;
      } }),
      definitions: { get: async () => { throw new Error('must_not_read_mutable_grants_on_rejoin'); } },
    });
    const source = { kind: 'saved' as const, definitionId: 'def-1', revision: { headerVersion: 1, bodyVersion: 1 } };
    const context = { callerPermissionMode: 'safe-yolo', defaultSessionId: 'origin-1',
      externalActionTarget: { kind: 'machine' as const, machineId: 'machine-a', project: { machineId: 'machine-a', directory: '/repo' } } };
    await expect(owner.execute({ actionId: 'workflow.run.start', input: { runId, source }, context }))
      .resolves.toMatchObject({ admission: 'existing' });
    await expect(owner.execute({ actionId: 'workflow.run.start', input: { runId, source: { ...source, visibleTeamId: 'team-a' } }, context }))
      .resolves.toMatchObject({ admission: 'existing' });
    await expect(owner.execute({ actionId: 'workflow.run.start', input: { runId, source: { ...source, visibleTeamId: 'team-b' } }, context }))
      .rejects.toMatchObject({ code: 'currentness_conflict' });
  });

  it('does not rejoin an exact accepted admission after its authorization is revoked', async () => {
    const owner = createWorkflowAccountRunActionOwner({
      ...ownerDeps({ execute: async () => runSnapshot() }),
      isAcceptedAuthorizationCurrent: async () => false,
    });
    await expect(owner.execute({ actionId: 'workflow.run.start', input: {
      runId, source: { kind: 'saved', definitionId: 'def-1', revision: { headerVersion: 1, bodyVersion: 1 } },
    }, context: {
      externalActionTarget: { kind: 'machine', machineId: 'machine-a', project: { machineId: 'machine-a', directory: '/repo' } },
    } })).rejects.toMatchObject({ code: 'run_access_denied' });
  });

  it('discloses nothing from an asynchronous read after Account retirement and performs no later mutation', async () => {
    const snapshot = runSnapshot();
    let retired = false;
    let writes = 0;
    const owner = createWorkflowAccountRunActionOwner({
      ...ownerDeps({ execute: async (operation) => {
        if (operation.operation === 'get') { retired = true; return snapshot; }
        if (operation.operation === 'invocations.list') return { invocations: [] };
        writes += 1;
        return { run: snapshot.run, intent: 'cancel_requested' };
      } }),
      assertCurrent: () => { if (retired) throw Object.assign(new Error('account_retired'), { code: 'account_retired' }); },
    });
    await expect(owner.execute({ actionId: 'workflow.run.get', input: { runId }, context: {} })).rejects.toMatchObject({ code: 'account_retired' });
    await expect(owner.execute({ actionId: 'workflow.run.cancel', input: { runId, expectedRevision: 0 }, context: {} })).rejects.toMatchObject({ code: 'account_retired' });
    expect(writes).toBe(0);
  });
});
