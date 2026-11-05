import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from '../actionExecutor.js';
import { createWorkflowActionExecutor, normalizeWorkflowActionThrownError, type WorkflowActionFailureDiagnosticV1 } from './workflowAccountActions.js';
import { createWorkflowDefinitionActions, type WorkflowDefinitionArtifactOperations } from './workflowDefinitions.js';
import { createWorkflowAccountRunActionOwner } from './workflowRunActions.js';
import { parseWorkflowDocumentJsonIngressV1 } from '../../workflows/workflowDocumentV1.js';
import { WorkflowActionFailureV1Schema } from '../../workflows/workflowProgressV1.js';

const definitionId = '11111111-1111-4111-8111-111111111111';
const definition = { version: 1 as const, inputs: [], defaults: {}, blocks: [{ kind: 'wait' as const, id: 'wait',
  document: { text: 'Continue', references: [], attachments: [] } }] };

function executor(invalidStoredHeader = false, readFailure?: unknown,
  isWorkflowFeatureEnabled: () => boolean | Promise<boolean> = () => true,
  artifactStore: Partial<WorkflowDefinitionArtifactOperations> = {}) {
  const unexpected = (): never => { throw new Error('unexpected_effect'); };
  // Artifact and Run persistence are the only boundaries; all family, reader,
  // validation and admission logic stays real.
  const definitions = createWorkflowDefinitionActions({ encodeListCursor: unexpected,
    assertDefinitionWriteAllowed: unexpected, artifactStore: {
    read: async () => {
      if (readFailure !== undefined) throw readFailure;
      return { artifactId: definitionId, ownerAccountId: 'account', access: 'owner',
      revision: { headerVersion: 1, bodyVersion: 1 },
      header: { kind: 'workflow-definition.v1', definitionId, revision: { headerVersion: 1, bodyVersion: 1 },
        metadata: { title: invalidStoredHeader ? 7 : 'Saved Wait' } },
      body: JSON.stringify({ kind: 'workflow-definition.v1', definition }) };
    },
    list: unexpected, create: unexpected, update: unexpected, delete: unexpected,
    ...artifactStore,
  } });
  const runs = createWorkflowAccountRunActionOwner({ definitions, storage: { execute: unexpected },
    resolveAccountId: async () => 'account', resolveEncryption: async () => ({ kind: 'available',
      witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
    normalizeAbsolutePath: unexpected, randomBytes: unexpected });
  return createWorkflowActionExecutor({ isWorkflowFeatureEnabled, definitions, runs });
}

describe('workflow Action refusal classification', () => {
  it('preserves the missing daemon runtime cause through the strict Workflow failure consumer', async () => {
    const actions = executor(false, Object.assign(new Error('Daemon runtime unavailable'), {
      code: 'PLUGIN_DAEMON_RUNTIME_UNAVAILABLE',
    }));
    const result = await actions({ actionId: 'workflow.definition.get', input: { definitionId }, context: {} });
    expect(WorkflowActionFailureV1Schema.parse(result)).toMatchObject({ ok: false,
      errorCode: 'target_unavailable', details: { code: 'target_unavailable',
        reason: 'requester_runtime_unavailable', errorCode: 'PLUGIN_DAEMON_RUNTIME_UNAVAILABLE' } });
  });
  it.each([
    new DOMException('Read cancelled', 'AbortError'),
    Object.assign(new Error('Read cancelled'), { code: 'ERR_CANCELED' }),
    Object.assign(new Error('Read cancelled'), { code: 'cancelled' }),
  ])('preserves pre-effect Artifact read cancellation through the strict Action consumer (%s)', async error => {
    const controller = new AbortController();
    const workflowAction = executor(false, undefined, () => true, { read: async () => {
      expect(controller.signal.aborted).toBe(false);
      controller.abort(error);
      throw error;
    } });
    const actions = createActionExecutor({ workflowAction } as unknown as ActionExecutorDeps);
    const result = await actions.execute('workflow.definition.get', { definitionId }, { surface: 'ui', signal: controller.signal });
    expect(WorkflowActionFailureV1Schema.parse(result)).toMatchObject({ ok: false, errorCode: 'cancelled' });
  });

  it('preserves cancellation during feature preparation before a write owner is entered', async () => {
    const controller = new AbortController();
    const workflowAction = executor(false, undefined, async () => {
      expect(controller.signal.aborted).toBe(false);
      controller.abort();
      controller.signal.throwIfAborted();
      return true;
    });
    const actions = createActionExecutor({ workflowAction } as unknown as ActionExecutorDeps);
    const result = await actions.execute('workflow.definition.create', { definitionId, metadata: { title: 'Saved Wait' }, definition },
      { surface: 'ui', signal: controller.signal });
    expect(WorkflowActionFailureV1Schema.parse(result)).toMatchObject({ ok: false, errorCode: 'cancelled' });
  });

  it('preserves a typed currentness conflict and its revision through both failure boundaries', async () => {
    const error = Object.assign(new Error('Stale revision'), { code: 'currentness_conflict', details: { revision: 7 } });
    const actions = createActionExecutor({ workflowAction: executor(false, error) } as unknown as ActionExecutorDeps);
    const result = await actions.execute('workflow.definition.get', { definitionId }, { surface: 'ui' });
    expect(WorkflowActionFailureV1Schema.parse(result)).toEqual({ ok: false, errorCode: 'currentness_conflict',
      error: error.message, details: { revision: 7 } });
  });

  it('does not prove cancellation when an Artifact delete commits but its receipt is aborted', async () => {
    const controller = new AbortController();
    let deletedArtifactId: string | undefined;
    const workflowAction = executor(false, undefined, () => true, { delete: async (artifactId, options) => {
      expect(options?.signal).toBe(controller.signal);
      deletedArtifactId = artifactId;
      controller.abort();
      throw controller.signal.reason;
    } });
    const actions = createActionExecutor({ workflowAction } as unknown as ActionExecutorDeps);
    const result = await actions.execute('workflow.definition.delete', { definitionId }, { surface: 'ui', signal: controller.signal,
      // The human has confirmed this exact dangerous Action at the host boundary.
      authority: 'present_user', actionCaller: { kind: 'host' },
      presentUserConfirmation: { actionId: 'workflow.definition.delete' } });
    expect(deletedArtifactId, JSON.stringify(result)).toBe(definitionId);
    expect(WorkflowActionFailureV1Schema.parse(result)).toMatchObject({ ok: false, errorCode: 'storage_unavailable' });
  });

  it('keeps a failed feature observation retryable through the real Action failure consumer', async () => {
    const workflowAction = executor(false, undefined, async () => {
      throw Object.assign(new Error('Feature request timed out'), { code: 'ECONNABORTED' });
    });
    const actions = createActionExecutor({ workflowAction } as unknown as ActionExecutorDeps);
    const result = await actions.execute('workflow.run.start', {
      runId: definitionId, source: { kind: 'inline', definition },
    }, { surface: 'ui' });
    expect(WorkflowActionFailureV1Schema.parse(result)).toMatchObject({ ok: false, errorCode: 'storage_unavailable' });
    // The same consumer must still reject an actual unreadable Artifact as content.
    await expect(createActionExecutor({ workflowAction: executor(true) } as unknown as ActionExecutorDeps)
      .execute('workflow.definition.get', { definitionId }, { surface: 'ui' }))
      .resolves.toMatchObject({ ok: false, errorCode: 'content_unavailable' });
  });
  it('retains a closed HTTP refusal through the family and outer Action boundary', async () => {
    const details = { status: 400, code: 'FST_ERR_VALIDATION' };
    const error = Object.assign(new Error('Workflow request failed (HTTP 400; FST_ERR_VALIDATION)'), {
      code: 'workflow_http_error', details, response: { status: 400 },
    });
    const actions = createActionExecutor({ workflowAction: executor(false, error) } as unknown as ActionExecutorDeps);
    await expect(actions.execute('workflow.definition.get', { definitionId }, { surface: 'api' }))
      .resolves.toEqual({ ok: false, effectAttempted: false, errorCode: 'workflow_http_error', error: error.message, details });
  });
  it('does not infer no effect from a server failure or a lost response', () => {
    for (const response of [{ status: 503 }, undefined]) {
      const error = Object.assign(new Error('Workflow write receipt unavailable'), { code: 'workflow_http_error',
        details: { status: 503 }, ...(response ? { response } : {}) });
      expect(normalizeWorkflowActionThrownError(error)).not.toHaveProperty('effectAttempted');
    }
  });
  it('keeps typed target diagnostics through the family and outer Action failure boundary', async () => {
    const details = { code: 'target_unavailable' as const, reason: 'agent_probe_failed' as const,
      agentId: 'claude', errorCode: 'cli-detection-failed', blockId: 'writer' };
    const actions = createActionExecutor({ workflowAction: executor(false,
      Object.assign(new Error('target_unavailable'), { code: 'target_unavailable', details })) } as unknown as ActionExecutorDeps);
    await expect(actions.execute('workflow.definition.get', { definitionId }, { surface: 'ui' }))
      .resolves.toEqual({ ok: false, errorCode: 'target_unavailable', error: 'target_unavailable', details });
    expect(normalizeWorkflowActionThrownError(Object.assign(new Error('target_unavailable'), { code: 'target_unavailable' })))
      .toMatchObject({ errorCode: 'target_unavailable', details: { code: 'target_unavailable', reason: 'selection_unavailable' } });
  });
  it('imports a document through the Action seam as unsaved content without persistence or execution', async () => {
    const actions = createActionExecutor({ workflowAction: executor() } as unknown as ActionExecutorDeps);
    const json = JSON.stringify({ kind: 'happier.workflow', version: 1, definition });
    await expect(actions.execute('workflow.definition.import', { json }, { surface: 'mcp' }))
      .resolves.toEqual({ ok: true, result: { ...parseWorkflowDocumentJsonIngressV1(json), classification: 'unsaved_definition' } });
    await expect(actions.execute('workflow.definition.import', { json: '{' }, { surface: 'mcp' }))
      .resolves.toEqual({ ok: true, result: { ok: false, code: 'workflow_document_invalid_json', issues: [] } });
    await expect(actions.execute('workflow.definition.import', { json: JSON.stringify({ kind: 'happier.workflow', version: 2, definition }) }, { surface: 'mcp' }))
      .resolves.toMatchObject({ ok: true, result: { ok: false, code: 'workflow_document_unsupported_version' } });
  });

  it('exports the saved definition through its authorized Artifact reader as canonical portable JSON', async () => {
    const actions = createActionExecutor({ workflowAction: executor() } as unknown as ActionExecutorDeps);
    const result = await actions.execute('workflow.definition.export', { definitionId }, { surface: 'mcp' });
    expect(result).toMatchObject({ ok: true, result: { definitionId, revision: { headerVersion: 1, bodyVersion: 1 },
      document: { kind: 'happier.workflow', version: 1, definition }, json: expect.any(String) } });
    if (!result.ok || !result.result || typeof result.result !== 'object' || !('json' in result.result)) throw new Error('missing_export');
    expect(JSON.parse(String(result.result.json))).toEqual({ kind: 'happier.workflow', version: 1, definition });
    await expect(createActionExecutor({ workflowAction: executor(true) } as unknown as ActionExecutorDeps)
      .execute('workflow.definition.export', { definitionId }, { surface: 'mcp' }))
      .resolves.toMatchObject({ ok: false, errorCode: 'content_unavailable' });
  });
  it.each([
    ['missing Session snapshot', Object.assign(new Error('Session snapshot unavailable'), { name: 'SessionSnapshotReadError', errorCode: 'not_found', httpStatus: 404 }), 'target_unavailable'],
    ['forbidden Session snapshot', Object.assign(new Error('Session snapshot unavailable'), { name: 'SessionSnapshotReadError', errorCode: 'forbidden', httpStatus: 403 }), 'target_unavailable'],
    ['network Session snapshot failure', Object.assign(new Error('Session snapshot unavailable'), { name: 'SessionSnapshotReadError', errorCode: 'network_error' }), 'storage_unavailable'],
    ['failed Session snapshot request', Object.assign(new Error('Session snapshot unavailable'), { name: 'SessionSnapshotReadError', errorCode: 'request_failed' }), 'storage_unavailable'],
    ['server Session snapshot failure', Object.assign(new Error('Session snapshot unavailable'), { name: 'SessionSnapshotReadError', errorCode: 'http_error', httpStatus: 503 }), 'storage_unavailable'],
    ['unproven Session absence', Object.assign(new Error('Session snapshot unavailable'), { name: 'SessionSnapshotReadError', errorCode: 'invalid_response', httpStatus: 404 }), 'storage_unavailable'],
    ['Session authentication refusal', Object.assign(new Error('Session snapshot unavailable'), { name: 'SessionSnapshotReadError', errorCode: 'unauthorized' }), 'not_authenticated'],
    ['Session currentness conflict', Object.assign(new Error('Session snapshot unavailable'), { name: 'SessionSnapshotReadError', errorCode: 'currentness_conflict' }), 'currentness_conflict'],
    ['Session cancellation', Object.assign(new Error('Session snapshot unavailable'), { name: 'SessionSnapshotReadError', errorCode: 'cancelled' }), 'cancelled'],
    ['typed errorCode refusal', Object.assign(new Error('Source unavailable'), { errorCode: 'source_unavailable' }), 'source_unavailable'],
    ['Artifact owner-only delete refusal', Object.assign(new Error('workflow_definition_delete_forbidden'), { code: 'artifact_access_forbidden' }), 'run_access_denied'],
    ['Artifact read missing', Object.assign(new Error('artifact_not_found'), { code: 'artifact_not_found' }), 'content_unavailable'],
    ['Automation stored content refusal', Object.assign(new Error('automation_stored_content_unavailable'), { code: 'automation_stored_content_unavailable' }), 'content_unavailable'],
    ['Automation template revision conflict', Object.assign(new Error('automation_template_version_conflict'), { code: 'automation_template_version_conflict' }), 'currentness_conflict'],
    ['Automation trigger revision conflict', Object.assign(new Error('automation_trigger_revision_conflict'), { code: 'automation_trigger_revision_conflict' }), 'currentness_conflict'],
    ['Automation version mismatch', Object.assign(new Error('version_mismatch'), { code: 'version_mismatch' }), 'currentness_conflict'],
    ['requester custody refusal', Object.assign(new Error('credential_scope_denied'), { code: 'credential_scope_denied' }), 'run_access_denied'],
    ['storage transport errorCode', Object.assign(new Error('Storage unreachable'), { errorCode: 'network_error' }), 'storage_unavailable'],
    ['uncoded server failure', new Error('Failed to fetch artifact'), 'storage_unavailable'],
    ['unknown transport code', Object.assign(new Error('Connection reset'), { code: 'ECONNRESET' }), 'storage_unavailable'],
    ['unknown server code', Object.assign(new Error('Transaction acquisition unavailable'), { code: 'P2028' }), 'storage_unavailable'],
    ['typed storage refusal', Object.assign(new Error('Storage unavailable'), { code: 'storage_unavailable' }), 'storage_unavailable'],
    ['unreadable Account role overrides', Object.assign(new Error('account_role_overrides_unavailable'), { code: 'account_role_overrides_unavailable' }), 'content_unavailable'],
    ['typed unopened content refusal', Object.assign(new Error('Artifact content is unavailable'), { code: 'content_unavailable' }), 'content_unavailable'],
    ['retained Session custody missing', Object.assign(new Error('session_key_required'), { code: 'session_key_required' }), 'content_unavailable'],
    ['template encryption material missing', Object.assign(new Error('encryption_material_unavailable'), { code: 'encryption_material_unavailable' }), 'content_unavailable'],
    ['template envelope mode mismatch', Object.assign(new Error('encryption_mode_mismatch'), { code: 'encryption_mode_mismatch' }), 'content_unavailable'],
    ['template decryption failed', Object.assign(new Error('invalid_template'), { code: 'invalid_template' }), 'content_unavailable'],
  ])('classifies %s through the Workflow Action boundary', async (_case, error, errorCode) => {
    const actions = createActionExecutor({ workflowAction: executor(false, error) } as unknown as ActionExecutorDeps);
    await expect(actions.execute('workflow.definition.get', { definitionId }, { surface: 'ui' }))
      .resolves.toMatchObject({ ok: false, errorCode });
  });

  it('projects Session snapshot failures with the existing Session target reason, not storage diagnostics', () => {
    const events: WorkflowActionFailureDiagnosticV1[] = [];
    const result = normalizeWorkflowActionThrownError(Object.assign(new Error('Session snapshot unavailable'), {
      name: 'SessionSnapshotReadError', errorCode: 'not_found', httpStatus: 404,
    }), { operation: 'session.trigger.add', durationMs: 1, emit: event => events.push(event) });
    expect(WorkflowActionFailureV1Schema.parse(result)).toMatchObject({ ok: false, errorCode: 'target_unavailable',
      details: { code: 'target_unavailable', reason: 'session_unavailable' } });
    expect(events).toEqual([]);
    // An unrelated storage transport may use the same errorCode field.
    expect(normalizeWorkflowActionThrownError(Object.assign(new Error('Storage unreachable'), { errorCode: 'network_error' })))
      .toMatchObject({ errorCode: 'storage_unavailable' });
  });

  it.each(['network_error', 'http_error'] as const)('emits the existing storage diagnostic for a %s Session read', errorCode => {
    const events: WorkflowActionFailureDiagnosticV1[] = [];
    const result = normalizeWorkflowActionThrownError(Object.assign(new Error('Session snapshot unavailable'), {
      name: 'SessionSnapshotReadError', errorCode, ...(errorCode === 'http_error' ? { httpStatus: 503 } : {}),
    }), { operation: 'session.trigger.add', durationMs: 1, emit: event => events.push(event) });
    expect(WorkflowActionFailureV1Schema.parse(result)).toMatchObject({ ok: false, errorCode: 'storage_unavailable' });
    expect(events).toEqual([{ event: 'workflow_action_failure', errorCode: 'storage_unavailable',
      originalCode: null, httpStatus: null, operation: 'session.trigger.add', durationMs: 1 }]);
  });

  it('preserves the Account role preparation cause in the content-free diagnostic', () => {
    const events: WorkflowActionFailureDiagnosticV1[] = [];
    const result = normalizeWorkflowActionThrownError(Object.assign(new Error('private catalog contents'), {
      code: 'account_role_overrides_unavailable',
    }), { operation: 'workflow.run.start', durationMs: 12, emit: event => events.push(event) });
    expect(WorkflowActionFailureV1Schema.parse(result)).toMatchObject({ ok: false, errorCode: 'content_unavailable',
      details: { reason: 'account_role_overrides_unavailable' } });
    expect(events).toEqual([{ event: 'workflow_action_failure', errorCode: 'content_unavailable',
      originalCode: 'account_role_overrides_unavailable', httpStatus: null, operation: 'workflow.run.start', durationMs: 12 }]);
  });

  it.each([401, 403])('retains the refused Wait storage phase in the content-free HTTP %s diagnostic', async httpStatus => {
    const events: WorkflowActionFailureDiagnosticV1[] = [];
    const unexpected = (): never => { throw new Error('unexpected_effect'); };
    const owner = createWorkflowAccountRunActionOwner({
      definitions: { get: unexpected }, resolveAccountId: async () => 'account',
      resolveEncryption: unexpected, normalizeAbsolutePath: unexpected, randomBytes: unexpected,
      // HTTP is the genuine boundary. Keep the owner's transport refusal
      // translation and the shared Action failure projector real.
      storage: { execute: async () => { throw Object.assign(new Error('private request, token and content'), {
        code: 'ERR_BAD_REQUEST', response: { status: httpStatus, data: { private: 'response-body' } },
        config: { headers: { Authorization: 'private-token' } },
        workflowStorageOperation: { operation: 'wait', durationMs: 149_000 },
      }); } },
    });
    let refusal: unknown;
    try {
      await owner.execute({ actionId: 'workflow.run.wait', input: { runId: definitionId, timeoutSeconds: 300 }, context: {} });
    } catch (error) { refusal = error; }
    expect(refusal).toMatchObject({ code: 'run_access_denied' });
    const result = normalizeWorkflowActionThrownError(refusal, {
      operation: 'workflow.run.wait', durationMs: 150_000, emit: event => events.push(event),
    });
    expect(WorkflowActionFailureV1Schema.parse(result)).toMatchObject({ ok: false, errorCode: 'run_access_denied' });
    expect(events).toEqual([{ event: 'workflow_action_failure', errorCode: 'run_access_denied',
      originalCode: 'ERR_BAD_REQUEST', httpStatus, operation: 'wait', durationMs: 149_000 }]);
    expect(JSON.stringify(events)).not.toContain('private');
  });

  it('reports invalid requests separately from unavailable private content', async () => {
    const execute = executor();
    await expect(execute({ actionId: 'workflow.definition.get', input: { definitionId: '' }, context: { surface: 'ui' } }))
      .resolves.toMatchObject({ ok: false, errorCode: 'invalid_input' });
    const input = { runId: definitionId, source: { kind: 'inline' as const, definition }, extra: true };
    await expect(execute({ actionId: 'workflow.run.start', input, context: { surface: 'ui' } }))
      .resolves.toMatchObject({ ok: false, errorCode: 'invalid_input' });
  });

  it('keeps invalid persisted content unavailable and readable content available', async () => {
    await expect(executor(true)({ actionId: 'workflow.definition.get', input: { definitionId }, context: { surface: 'ui' } }))
      .resolves.toMatchObject({ ok: false, errorCode: 'content_unavailable', details: { reason: 'invalid_header' } });
    await expect(executor()({ actionId: 'workflow.definition.get', input: { definitionId }, context: { surface: 'ui' } }))
      .resolves.toMatchObject({ definitionId, definition });
  });
});
