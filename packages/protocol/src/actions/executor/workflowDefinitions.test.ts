import { describe, expect, it } from 'vitest';

import { WorkflowDefinitionV1Schema } from '../../workflows/workflowV1.js';
import { ArtifactBlobReferenceV1Schema, type ArtifactRevisionProvenanceV1 } from '../../artifacts/artifactBinaryV1.js';
import { retargetWorkflowDefinitionArtifactHeaderV1 } from '../../workflows/workflowDefinitionV1.js';
import { prepareArtifactHeaderForBodyV1 } from '../../artifacts/artifactHeaderRestorationV1.js';
import { createWorkflowDefinitionActions, type WorkflowDefinitionArtifactOperations } from './workflowDefinitions.js';
import { createWorkflowActionExecutor, normalizeWorkflowActionThrownError } from './workflowAccountActions.js';
import { createWorkflowAccountRunActionOwner } from './workflowRunActions.js';
import { WorkflowDefinitionGetResultV1Schema, WorkflowDefinitionListResultV1Schema } from '../../workflows/actionsV1.js';
import { EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES, measureExternalActionResultResponseEnvelopeUtf8BytesV1 } from '../externalActionLimits.js';
import { resolveInputOptions } from '../../inputs/inputOptions.js';
import { ActionExecuteFailureSchema } from '../actionExecutionResult.js';
import type { ActionExecutorDeps } from './types.js';
import { createWorkflowTriggerActions } from './workflowTriggerActions.js';

const definitionId = '11111111-1111-4111-8111-111111111111';
const definition = WorkflowDefinitionV1Schema.parse({ version: 1,
  defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
  blocks: [{ kind: 'step', id: 'review', document: { text: 'Review', references: [], attachments: [] }, input: [], result: { kind: 'text' } }],
});

function readEmptyTriggerSummaries() {
  const unused = (): never => { throw new Error('unexpected_trigger_operation'); };
  // Automation persistence is a boundary; the canonical census projection remains real.
  return createWorkflowTriggerActions({ automations: {
    list: async () => ({ automations: [], nextCursor: null }), get: unused, create: unused, reconcile: unused, delete: unused,
  }, openContext: unused, sealContext: unused, newId: unused, resolveWorkflow: unused }).readWorkflowSummaries();
}

describe('shared workflow definition create', () => {
  it('projects current definition destinations without binding an unknown origin', async () => {
    const targeted = { ...definition, defaults: { ...definition.defaults,
      conversation: { kind: 'existing_session' as const, sessionId: 'destination', machineId: 'machine' } } };
    const revision = { headerVersion: 1, bodyVersion: 1 };
    const unused = (): never => { throw new Error('unexpected_operation'); };
    const actions = createWorkflowDefinitionActions({ artifactStore: {
      read: async () => ({ artifactId: definitionId, revision, ownerAccountId: 'owner', access: 'owner',
        header: { kind: 'workflow-definition.v1', definitionId, revision, metadata: { title: 'Writes' } },
        body: JSON.stringify({ kind: 'workflow-definition.v1', definition: targeted }) }),
      list: unused, create: unused, update: unused, delete: unused,
    }, encodeListCursor: unused, assertDefinitionWriteAllowed: unused });
    expect(await actions.get({ definitionId })).toMatchObject({ destinations: {
      targetSessionIds: ['destination'], usesOriginSession: false, unresolvedWorkflowRefs: [],
    } });
  });
  it('retains reference options and readable neighbors when an unavailable header has no metadata', async () => {
    const neighborId = '22222222-2222-4222-8222-222222222222';
    const rows = [definitionId, neighborId].map(artifactId => ({
      artifactId, headerVersion: 1, bodyVersion: 1, updatedAt: 1, ownerAccountId: 'owner', access: 'owner' as const,
      header: { kind: 'workflow-definition.v1', definitionId: artifactId, revision: { headerVersion: 1, bodyVersion: 1 },
        metadata: { title: artifactId === definitionId ? 7 : 'Readable neighbor' } },
      body: JSON.stringify({ kind: 'workflow-definition.v1', definition }),
    }));
    const unused = (): never => { throw new Error('unexpected_operation'); };
    // Persistence is the boundary. The definition, family and options owners all remain real.
    const definitions = createWorkflowDefinitionActions({ artifactStore: {
      read: unused, list: async () => ({ items: rows }), create: unused, update: unused, delete: unused,
    }, encodeListCursor: row => row.artifactId, assertDefinitionWriteAllowed: unused,
    readWorkflowTriggerSummaries: readEmptyTriggerSummaries });
    const workflowAction = createWorkflowActionExecutor({ isWorkflowFeatureEnabled: () => true, definitions,
      runs: createWorkflowAccountRunActionOwner({ definitions, storage: { execute: unused }, resolveAccountId: unused,
        resolveEncryption: unused, normalizeAbsolutePath: unused, randomBytes: unused }),
    });
    // Non-Workflow operations must not be reached while resolving this options source.
    const deps: ActionExecutorDeps = {
      workflowAction, executionRunStart: unused, executionRunList: unused, executionRunGet: unused,
      detachedExecutionRunSend: unused, executionRunStop: unused, executionRunAction: unused, executionRunWait: unused,
      sessionOpen: unused, sessionFork: unused, sessionRollback: unused, sessionSpawnNew: unused,
      resolveAgentStartContext: unused, pathsListRecent: unused, machinesList: unused, serversList: unused,
      reviewEnginesList: unused, agentsBackendsList: unused, agentsModelsList: unused,
      sessionSendMessage: unused, sessionPermissionRespond: unused, sessionUserActionAnswer: unused,
      sessionModeSet: unused, sessionModesList: unused, sessionTargetPrimarySet: unused, sessionTargetTrackedSet: unused,
      sessionList: unused, sessionActivityGet: unused, sessionRecentMessagesGet: unused, resetGlobalVoiceAgent: unused,
    };
    const result = await resolveInputOptions({ deps, ctx: { surface: 'ui' }, actionId: null,
      optionsSourceId: 'workflows.references.available', input: {},
      readFailure: value => { const parsed = ActionExecuteFailureSchema.safeParse(value); return parsed.success ? parsed.data : null; },
      resolveSessionId: unused, reviewScope: unused,
    });
    expect(result).toMatchObject({ ok: true, result: expect.arrayContaining([
      { value: definitionId, label: definitionId }, { value: neighborId, label: 'Readable neighbor' },
    ]) });
  });
  it.each(['owner', 'edit', 'admin', 'view'] as const)('returns the Artifact-effective %s access through the definition Action', async (access) => {
    const definitions = createWorkflowDefinitionActions({ artifactStore: {
      read: async () => ({ artifactId: definitionId, ownerAccountId: 'owner', access,
        revision: { headerVersion: 1, bodyVersion: 1 },
        header: { kind: 'workflow-definition.v1', definitionId, revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Shared' } },
        body: JSON.stringify({ kind: 'workflow-definition.v1', definition }) }),
      list: async () => ({ items: [] }), create: async () => {},
      update: async () => ({ ok: false, errorCode: 'unused', error: 'unused' }), delete: async () => ({ ok: true }),
    }, encodeListCursor: () => 'cursor', assertDefinitionWriteAllowed: () => {} });
    const execute = createWorkflowActionExecutor({ isWorkflowFeatureEnabled: () => true, definitions,
      runs: createWorkflowAccountRunActionOwner({ definitions, storage: { execute: async () => { throw new Error('no_run_read'); } },
        resolveAccountId: async () => 'recipient', resolveEncryption: async () => ({ kind: 'available',
          witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
        normalizeAbsolutePath: () => null, randomBytes: () => { throw new Error('no_keys'); } }),
    });
    const result = await execute({ actionId: 'workflow.definition.get', input: { definitionId },
      context: { surface: 'agent', runtimeAccountId: 'recipient' } });
    expect(result).toMatchObject({ definitionId, definition, access });
    expect(WorkflowDefinitionGetResultV1Schema.parse(result)).toEqual(result);
  });
  it('pages plugin definitions within the existing Action response boundary without hiding saved workflows', async () => {
    const plugins = [0, 1].map((index) => ({ workflow: `plugin:com.acme.workflows/review-${index}`,
      pluginId: 'com.acme.workflows', version: '1.2.3', title: `Review ${index}`,
      definition: { ...definition, blocks: [{ ...definition.blocks[0]!,
        document: { text: 'x'.repeat(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES / 2), references: [], attachments: [] } }] },
    }));
    const saved = { artifactId: definitionId, headerVersion: 1, updatedAt: 1, ownerAccountId: 'account', access: 'owner' as const,
      body: JSON.stringify({ kind: 'workflow-definition.v1', definition }), bodyVersion: 1,
      header: { kind: 'workflow-definition.v1', definitionId, revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Saved' } } };
    const owner = createWorkflowDefinitionActions({ artifactStore: {
      list: async ({ cursor }) => { expect(cursor).toBeUndefined(); return { items: [saved] }; },
      read: async () => { throw new Error('list_must_not_read_per_row'); }, create: async () => {},
      update: async () => ({ ok: false, errorCode: 'unused', error: 'unused' }), delete: async () => ({ ok: true }),
    }, encodeListCursor: () => 'artifact-cursor', assertDefinitionWriteAllowed: () => {}, readPluginWorkflows: () => plugins,
    readWorkflowTriggerSummaries: async () => new Map() });
    const first = WorkflowDefinitionListResultV1Schema.parse(await owner.list({}));
    expect(first.definitions.map((entry) => entry.definitionId)).toEqual([definitionId]);
    expect(first.pluginWorkflows?.map((entry) => entry.workflow)).toEqual([plugins[0]!.workflow]);
    expect(measureExternalActionResultResponseEnvelopeUtf8BytesV1(first)).toBeLessThanOrEqual(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES);
    expect(first.nextCursor).toBeDefined();
    const next = WorkflowDefinitionListResultV1Schema.parse(await owner.list({ cursor: first.nextCursor }));
    expect(next.definitions).toEqual([]);
    expect(next.pluginWorkflows?.map((entry) => entry.workflow)).toEqual([plugins[1]!.workflow]);
    expect(next.nextCursor).toBeUndefined();
    expect(measureExternalActionResultResponseEnvelopeUtf8BytesV1(next)).toBeLessThanOrEqual(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES);
  });
  it('lists read-only plugin workflows through the same Action without reading or writing Artifacts', async () => {
    const plugin = { workflow: 'plugin:com.acme.workflows/review', pluginId: 'com.acme.workflows',
      version: '1.2.3', title: 'Review from plugin', definition };
    const store: WorkflowDefinitionArtifactOperations = {
      read: async () => { throw new Error('no_plugin_artifact'); }, list: async () => ({ items: [] }),
      create: async () => { throw new Error('read_only'); }, update: async () => { throw new Error('read_only'); },
      delete: async () => { throw new Error('read_only'); },
    };
    const definitions = createWorkflowDefinitionActions({ artifactStore: store, encodeListCursor: () => 'cursor',
      assertDefinitionWriteAllowed: () => {}, readPluginWorkflows: () => [plugin] });
    const execute = createWorkflowActionExecutor({ isWorkflowFeatureEnabled: () => true, definitions,
      runs: createWorkflowAccountRunActionOwner({ definitions, storage: { execute: async () => { throw new Error('no_run_read'); } },
        resolveAccountId: async () => 'account', resolveEncryption: async () => ({ kind: 'available',
          witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
        normalizeAbsolutePath: () => null, randomBytes: () => { throw new Error('no_keys'); } }),
    });
    const result = await execute({ actionId: 'workflow.definition.list', input: {}, context: { surface: 'agent' } });
    expect(result).toEqual({ definitions: [], pluginWorkflows: [plugin] });
    expect(WorkflowDefinitionListResultV1Schema.parse(result)).toEqual(result);
  });
  it.each(['edit', 'admin'] as const)('refuses deletion by a %s grantee before removing personal triggers', async (access) => {
    const writes: string[] = [];
    const artifactStore: WorkflowDefinitionArtifactOperations = {
      read: async () => ({ artifactId: definitionId, access, ownerAccountId: 'owner',
        revision: { headerVersion: 1, bodyVersion: 1 },
        header: { kind: 'workflow-definition.v1', definitionId, revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Review' } },
        body: JSON.stringify({ kind: 'workflow-definition.v1', definition }) }),
      list: async () => ({ items: [] }), create: async () => undefined,
      update: async () => ({ ok: false, errorCode: 'not_found', error: 'not_found' }),
      delete: async () => { writes.push('artifact'); return { ok: false, errorCode: 'artifact_access_forbidden', error: 'forbidden' }; },
    };
    const actions = createWorkflowDefinitionActions({ artifactStore, encodeListCursor: () => 'cursor',
      assertDefinitionWriteAllowed: () => {}, removeWorkflowTriggers: async () => { writes.push('triggers'); } });
    await expect(actions.delete({ definitionId })).rejects.toMatchObject({ code: 'artifact_access_forbidden' });
    expect(writes).toEqual([]);
  });
  it('stamps create and update from the host caller, preserving the actor on a same-id rejoin', async () => {
    let artifact: Awaited<ReturnType<WorkflowDefinitionArtifactOperations['read']>> = null;
    const store: WorkflowDefinitionArtifactOperations = {
      read: async () => artifact,
      create: async ({ savedBy, ...input }) => { artifact = { ...input, ...(savedBy ? { provenance: { savedBy } } : {}), ownerAccountId: 'owner', access: 'owner', revision: { headerVersion: 1, bodyVersion: 1 } }; },
      update: async ({ savedBy, ...input }) => {
        const revision = { headerVersion: input.expectedRevision.headerVersion + 1, bodyVersion: input.expectedRevision.bodyVersion + 1 };
        artifact = { ...input, ...(savedBy ? { provenance: { savedBy } } : {}), ownerAccountId: 'owner', access: 'owner', revision };
        return { ok: true, revision };
      },
      list: async () => ({ items: [] }),
      delete: async () => ({ ok: true }),
    };
    const actions = createWorkflowDefinitionActions({ artifactStore: store, encodeListCursor: () => 'cursor', assertDefinitionWriteAllowed: () => {} });
    const input = { definitionId, definition, metadata: { title: 'Review' } };
    const created = await actions.create(input, undefined, { surface: 'ui_button', runtimeAccountId: 'account-person' });
    expect(created).toMatchObject({ savedBy: { kind: 'person', accountId: 'account-person' } });
    expect((await store.read(definitionId))?.provenance).toEqual({ savedBy: { kind: 'person', accountId: 'account-person' } });
    expect((await store.read(definitionId))?.header).toMatchObject({ previewSteps: ['Review'] });
    expect((await store.read(definitionId))?.header).not.toHaveProperty('savedBy');
    await expect(actions.create(input, undefined, { surface: 'agent', runtimeAccountId: 'account-agent' }))
      .resolves.toMatchObject({ savedBy: { kind: 'person', accountId: 'account-person' } });
    const revised = { ...definition, blocks: [{ kind: 'step' as const, id: 'review',
      document: { text: 'Revised review', references: [], attachments: [] }, input: [], result: { kind: 'text' as const } }] };
    await expect(actions.update({ ...input, definition: revised, expectedRevision: created.revision }, undefined,
      { surface: 'agent', runtimeAccountId: 'account-agent', defaultSessionId: 'session-agent' }))
      .resolves.toMatchObject({ savedBy: { kind: 'agent', accountId: 'account-agent', sessionId: 'session-agent' } });
    expect((await store.read(definitionId))?.provenance).toEqual({ savedBy: { kind: 'agent', accountId: 'account-agent', sessionId: 'session-agent' } });
    expect((await store.read(definitionId))?.header).toMatchObject({ previewSteps: ['Revised review'] });
    expect((await store.read(definitionId))?.header).not.toHaveProperty('savedBy');
    await expect(actions.update({ ...input, expectedRevision: { headerVersion: 2, bodyVersion: 2 } }, undefined,
      { surface: 'agent', runtimeAccountId: 'account-agent' }))
      .resolves.toMatchObject({ savedBy: { kind: 'agent', accountId: 'account-agent' } });
    await actions.edit({ definitionId, expectedRevision: { headerVersion: 3, bodyVersion: 3 },
      ops: [{ kind: 'rename', name: 'Reviewed' }] }, undefined,
    { surface: 'ui_button', runtimeAccountId: 'account-person' });
    await expect(actions.get({ definitionId }))
      .resolves.toMatchObject({ metadata: { title: 'Reviewed' }, savedBy: { kind: 'person', accountId: 'account-person' } });
    expect((await store.read(definitionId))?.header).toMatchObject({ previewSteps: ['Review'] });
    expect((await store.read(definitionId))?.header).not.toHaveProperty('savedBy');
  });

  it.each([
    { access: 'owner' as const, provenance: { savedBy: { kind: 'agent' as const, accountId: 'private-editor', sessionId: 'private-session' } } },
    { access: 'view' as const, provenance: { savedBy: { kind: 'agent' as const, accountId: 'private-editor', sessionId: 'private-session' } } },
    { access: 'owner' as const, provenance: undefined },
  ] satisfies ReadonlyArray<{ access: 'owner' | 'view'; provenance: ArtifactRevisionProvenanceV1 | undefined }>)
  ('uses only opened private provenance for $access get and list attribution', async ({ access, provenance }) => {
    const revision = { headerVersion: 1, bodyVersion: 1 };
    const header = { kind: 'workflow-definition.v1', definitionId, revision, metadata: { title: 'Shared' } };
    const row = { artifactId: definitionId, header, ownerAccountId: 'owner', access,
      body: JSON.stringify({ kind: 'workflow-definition.v1', definition }), bodyVersion: 1,
      headerVersion: 1, updatedAt: 1, ...(provenance ? { provenance } : {}) };
    const store: WorkflowDefinitionArtifactOperations = {
      read: async () => ({ ...row, revision }), list: async () => ({ items: [row] }),
      create: async () => {}, update: async () => ({ ok: false, errorCode: 'unused', error: 'unused' }), delete: async () => ({ ok: true }),
    };
    const actions = createWorkflowDefinitionActions({ artifactStore: store, encodeListCursor: () => 'cursor',
      assertDefinitionWriteAllowed: () => {}, readWorkflowTriggerSummaries: async () => new Map() });
    const opened = WorkflowDefinitionGetResultV1Schema.parse(await actions.get({ definitionId }));
    const listed = WorkflowDefinitionListResultV1Schema.parse(await actions.list({})).definitions[0]!;
    for (const result of [opened, listed]) {
      if (provenance) expect(result.savedBy).toEqual(provenance.savedBy);
      else expect(result).not.toHaveProperty('savedBy');
    }
  });

  it('discards unknown stored header fields when restoring a Workflow revision', () => {
    expect(retargetWorkflowDefinitionArtifactHeaderV1({ artifactId: definitionId,
      header: { kind: 'workflow-definition.v1', definitionId, revision: { headerVersion: 1, bodyVersion: 1 },
        metadata: { title: '  Preserve stored title  ' }, previewSteps: ['Review'],
        savedBy: { kind: 'agent', accountId: 'historical-public-editor', sessionId: 'historical-public-session' } },
      expectedRevision: { headerVersion: 1, bodyVersion: 1 }, nextRevision: { headerVersion: 2, bodyVersion: 2 } }))
      .toEqual({ kind: 'workflow-definition.v1', definitionId, revision: { headerVersion: 2, bodyVersion: 2 },
        metadata: { title: 'Preserve stored title' }, previewSteps: ['Review'] });
  });

  it.each(['savedBy', 'clientMetadata'])('rejects %s when a generic Artifact write rebuilds a Workflow header', (field) => {
    const header = { kind: 'workflow-definition.v1', definitionId, revision: { headerVersion: 2, bodyVersion: 3 },
      metadata: { title: '  Preserve stored title  ' }, [field]: { private: true } };
    expect(() => prepareArtifactHeaderForBodyV1(header, JSON.stringify({ kind: 'workflow-definition.v1', definition })))
      .toThrow(expect.objectContaining({ code: 'content_unavailable' }));
  });

  it.each([
    { name: 'missing required metadata', patch: { metadata: undefined }, metadata: null },
    { name: 'malformed display metadata', patch: { metadata: { title: 7 } }, metadata: null },
    { name: 'malformed revision', patch: { revision: { headerVersion: 'two', bodyVersion: 2 } }, metadata: { title: 'Shared' } },
    { name: 'unknown stored display fields beside an invalid revision', patch: { revision: { headerVersion: 'two', bodyVersion: 2 }, metadata: { title: 'Shared', extra: true } }, metadata: { title: 'Shared' } },
  ])('isolates an unsupported header ($name) as unavailable in get and list without losing a valid neighbor', async ({ patch, metadata }) => {
    const revision = { headerVersion: 2, bodyVersion: 2 };
    const header = { kind: 'workflow-definition.v1', definitionId, revision, metadata: { title: 'Shared' } };
    const row = { artifactId: definitionId, header: { ...header, ...patch },
      ownerAccountId: 'owner', access: 'view' as const, body: JSON.stringify({ kind: 'workflow-definition.v1', definition }),
      headerVersion: 2, bodyVersion: 2, updatedAt: 1 };
    const neighborId = '22222222-2222-4222-8222-222222222222';
    const store: WorkflowDefinitionArtifactOperations = {
      read: async () => ({ ...row, revision }),
      list: async () => ({ items: [row, { ...row, artifactId: neighborId, header: { ...header, definitionId: neighborId } }] }),
      create: async () => {}, update: async () => ({ ok: false, errorCode: 'unused', error: 'unused' }), delete: async () => ({ ok: true }),
    };
    const actions = createWorkflowDefinitionActions({ artifactStore: store, encodeListCursor: row => row.artifactId,
      assertDefinitionWriteAllowed: () => {}, readWorkflowTriggerSummaries: readEmptyTriggerSummaries });
    const failure = await actions.get({ definitionId }).catch(normalizeWorkflowActionThrownError);
    const result = WorkflowDefinitionListResultV1Schema.parse(await actions.list({}));
    expect(result.definitions).toMatchObject([
      { definitionId, metadata, revision, contentStatus: 'unavailable', contentUnavailableReason: 'invalid_header', stepCount: null },
      { definitionId: neighborId, contentStatus: 'available', stepCount: 1 },
    ]);
    expect(result.definitions[0]).not.toHaveProperty('savedBy');
    expect(failure).toMatchObject({ ok: false, errorCode: 'content_unavailable', details: { reason: 'invalid_header' } });
  });

  it('opens and lists unknown stored fields, then drops them on the next canonical write', async () => {
    const authored = WorkflowDefinitionV1Schema.parse({ ...definition,
      roles: [{ roleId: 'reviewer', name: 'Reviewer', instructions: 'Review carefully', runsAs: { kind: 'session' } }],
      inputs: [{ name: 'repository', valueType: 'string', required: false,
        inputType: { pluginId: 'com.acme.inputs', localId: 'repository' } }],
    });
    let revision = { headerVersion: 2, bodyVersion: 2 };
    let header: Readonly<Record<string, unknown>> = { kind: 'workflow-definition.v1', definitionId,
      revision: { ...revision, extra: true }, metadata: { title: 'Shared', extra: true },
      savedBy: { kind: 'person', accountId: 'untrusted-header-actor' }, clientMetadata: true };
    let body = JSON.stringify({ kind: 'workflow-definition.v1', extra: true, definition: {
      ...authored, extra: true, defaults: { ...authored.defaults, extra: true,
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude', extra: true } } },
      roles: authored.roles?.map(role => ({ ...role, extra: true })),
      inputs: authored.inputs?.map(input => ({ ...input, inputType: { ...input.inputType, extra: true } })),
      blocks: [{ ...definition.blocks[0], extra: true, document: { text: 'Review', references: [], attachments: [], extra: true } }],
    } });
    const row = () => ({ artifactId: definitionId, header, body, headerVersion: revision.headerVersion,
      bodyVersion: revision.bodyVersion, updatedAt: 1, ownerAccountId: 'owner', access: 'owner' as const });
    const store: WorkflowDefinitionArtifactOperations = {
      read: async () => ({ ...row(), revision }), list: async () => ({ items: [row()] }),
      create: async () => {}, delete: async () => ({ ok: true }),
      update: async input => {
        header = input.header; body = input.body;
        revision = { headerVersion: revision.headerVersion + 1, bodyVersion: revision.bodyVersion + 1 };
        return { ok: true, revision };
      },
    };
    const actions = createWorkflowDefinitionActions({ artifactStore: store, encodeListCursor: row => row.artifactId,
      assertDefinitionWriteAllowed: () => {}, readWorkflowTriggerSummaries: readEmptyTriggerSummaries });
    const opened = WorkflowDefinitionGetResultV1Schema.parse(await actions.get({ definitionId }));
    expect(opened.definition).toEqual(authored);
    expect(opened.metadata).toEqual({ title: 'Shared' });
    expect(opened).not.toHaveProperty('savedBy');
    const listed = WorkflowDefinitionListResultV1Schema.parse(await actions.list({})).definitions[0]!;
    expect(listed).toMatchObject({ definitionId, contentStatus: 'available', stepCount: 1 });
    expect(listed).not.toHaveProperty('savedBy');
    expect(listed).not.toHaveProperty('clientMetadata');
    await actions.update({ definitionId, expectedRevision: revision, metadata: opened.metadata, definition: opened.definition });
    expect(header).toEqual({ kind: 'workflow-definition.v1', definitionId, revision,
      metadata: { title: 'Shared' }, previewSteps: ['Review'] });
    expect(JSON.parse(body)).toEqual({ kind: 'workflow-definition.v1', definition: authored });
  });

  it('lists grant-reachable workflows with their owner/access and filters other opened kinds', async () => {
    const row = { artifactId: definitionId, headerVersion: 1, updatedAt: 1, ownerAccountId: 'other-owner', access: 'edit' as const,
      body: JSON.stringify({ kind: 'workflow-definition.v1', definition }), bodyVersion: 1,
      header: { kind: 'workflow-definition.v1', definitionId, revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Shared' } } };
    const store: WorkflowDefinitionArtifactOperations = {
      read: async () => { throw new Error('list_must_not_read_per_row'); }, list: async () => ({ items: [row, { ...row, artifactId: 'role', header: { kind: 'role.v1' } }] }),
      create: async () => undefined, update: async () => ({ ok: false, errorCode: 'not_found', error: 'not_found' }), delete: async () => ({ ok: true }),
    };
    const actions = createWorkflowDefinitionActions({ artifactStore: store, encodeListCursor: () => 'cursor', assertDefinitionWriteAllowed: () => {},
      readWorkflowTriggerSummaries: async () => new Map() });
    await expect(actions.list({})).resolves.toMatchObject({ definitions: [{ ...row.header, ownerAccountId: 'other-owner', access: 'edit', contentStatus: 'available', stepCount: 1, triggers: [], nextRunAt: null,
      destinations: { targetSessionIds: [], usesOriginSession: false } }] });
  });
  it.each(['existing', 'conflict', 'response_loss'] as const)('rejoins same semantic content after %s', async (scenario) => {
    let saved = scenario === 'existing';
    const store: WorkflowDefinitionArtifactOperations = {
      read: async () => saved ? { artifactId: definitionId, ownerAccountId: 'owner', access: 'owner', revision: { headerVersion: 1, bodyVersion: 1 },
        header: { kind: 'workflow-definition.v1', definitionId, revision: { headerVersion: 1, bodyVersion: 1 },
          metadata: { title: 'Review', description: 'Same document' } },
        body: JSON.stringify({ kind: 'workflow-definition.v1', definition }) } : null,
      create: async () => { saved = true; throw Object.assign(new Error(scenario), { code: scenario === 'conflict' ? 'conflict' : 'network_error' }); },
      list: async () => ({ items: [] }),
      update: async () => ({ ok: false, errorCode: 'not_found', error: 'not_found' }),
      delete: async () => ({ ok: true }),
    };
    const actions = createWorkflowDefinitionActions({ artifactStore: store, encodeListCursor: () => 'cursor', assertDefinitionWriteAllowed: () => {} });
    await expect(actions.create({ definitionId, definition, metadata: { description: 'Same document', title: 'Review' } }))
      .resolves.toMatchObject({ definitionId, metadata: { title: 'Review', description: 'Same document' } });
  });

  it.each(['conflict', 'response_loss'] as const)('refuses different same-id content after %s', async (scenario) => {
    let saved = false;
    const store: WorkflowDefinitionArtifactOperations = {
      read: async () => saved ? { artifactId: definitionId, ownerAccountId: 'owner', access: 'owner', revision: { headerVersion: 1, bodyVersion: 1 },
        header: { kind: 'workflow-definition.v1', definitionId, revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Other' } },
        body: JSON.stringify({ kind: 'workflow-definition.v1', definition }) } : null,
      create: async () => { saved = true; throw Object.assign(new Error(scenario), { code: scenario === 'conflict' ? 'conflict' : 'network_error' }); },
      list: async () => ({ items: [] }),
      update: async () => ({ ok: false, errorCode: 'not_found', error: 'not_found' }),
      delete: async () => ({ ok: true }),
    };
    const actions = createWorkflowDefinitionActions({ artifactStore: store, encodeListCursor: () => 'cursor', assertDefinitionWriteAllowed: () => {} });
    await expect(actions.create({ definitionId, definition, metadata: { title: 'Review' } }))
      .rejects.toMatchObject({ code: 'currentness_conflict' });
  });

  it('retains the create failure when no same-id Artifact was committed', async () => {
    const failure = Object.assign(new Error('network_error'), { code: 'network_error' });
    const store: WorkflowDefinitionArtifactOperations = {
      read: async () => null,
      create: async () => { throw failure; },
      list: async () => ({ items: [] }),
      update: async () => ({ ok: false, errorCode: 'not_found', error: 'not_found' }),
      delete: async () => ({ ok: true }),
    };
    const actions = createWorkflowDefinitionActions({ artifactStore: store, encodeListCursor: () => 'cursor', assertDefinitionWriteAllowed: () => {} });
    await expect(actions.create({ definitionId, definition, metadata: { title: 'Review' } })).rejects.toBe(failure);
  });

  it.each(['semantically invalid definition', 'blob reference'])('rejects a stored %s before returning private Workflow content', async (kind) => {
    const invalidDefinition = { ...definition, finalOutput: { kind: 'result', producer: { blockId: 'missing', scope: { kind: 'current' } }, path: [] } };
    const body = kind === 'blob reference' ? ArtifactBlobReferenceV1Schema.parse({
      blobId: '22222222-2222-4222-8222-222222222222', mime: 'application/json',
      sizeBytes: 0, sha256: '0'.repeat(64),
    }) : JSON.stringify({ kind: 'workflow-definition.v1', definition: invalidDefinition });
    const store: WorkflowDefinitionArtifactOperations = {
      read: async () => ({ artifactId: definitionId, ownerAccountId: 'owner', access: 'owner', revision: { headerVersion: 1, bodyVersion: 1 },
        header: { kind: 'workflow-definition.v1', definitionId, revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Review' } },
        body }),
      create: async () => undefined,
      list: async () => ({ items: [] }),
      update: async () => ({ ok: false, errorCode: 'not_found', error: 'not_found' }),
      delete: async () => ({ ok: true }),
    };
    const actions = createWorkflowDefinitionActions({ artifactStore: store, encodeListCursor: () => 'cursor', assertDefinitionWriteAllowed: () => {} });
    await expect(actions.get({ definitionId })).rejects.toMatchObject({ code: 'content_unavailable' });
  });
});
