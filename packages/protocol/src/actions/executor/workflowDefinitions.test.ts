import { describe, expect, it } from 'vitest';

import { WorkflowDefinitionV1Schema } from '../../workflows/workflowV1.js';
import { ArtifactBlobReferenceV1Schema } from '../../artifacts/artifactBinaryV1.js';
import { createWorkflowDefinitionActions, type WorkflowDefinitionArtifactOperations } from './workflowDefinitions.js';
import { createWorkflowActionExecutor } from './workflowAccountActions.js';
import { createWorkflowAccountRunActionOwner } from './workflowRunActions.js';
import { WorkflowDefinitionGetResultV1Schema, WorkflowDefinitionListResultV1Schema } from '../../workflows/actionsV1.js';
import { EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES, measureExternalActionResultResponseEnvelopeUtf8BytesV1 } from '../externalActionLimits.js';

const definitionId = '11111111-1111-4111-8111-111111111111';
const definition = WorkflowDefinitionV1Schema.parse({ version: 1,
  defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
  blocks: [{ kind: 'step', id: 'review', document: { text: 'Review', references: [], attachments: [] }, input: [], result: { kind: 'text' } }],
});

describe('shared workflow definition create', () => {
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
      create: async (input) => { artifact = { ...input, ownerAccountId: 'owner', access: 'owner', revision: { headerVersion: 1, bodyVersion: 1 } }; },
      update: async (input) => {
        const revision = { headerVersion: input.expectedRevision.headerVersion + 1, bodyVersion: input.expectedRevision.bodyVersion + 1 };
        artifact = { ...input, ownerAccountId: 'owner', access: 'owner', revision };
        return { ok: true, revision };
      },
      list: async () => ({ items: [] }),
      delete: async () => ({ ok: true }),
    };
    const actions = createWorkflowDefinitionActions({ artifactStore: store, encodeListCursor: () => 'cursor', assertDefinitionWriteAllowed: () => {} });
    const input = { definitionId, definition, metadata: { title: 'Review' } };
    const created = await actions.create(input, undefined, { surface: 'ui_button', runtimeAccountId: 'account-person' });
    expect(created).toMatchObject({ savedBy: { kind: 'person', accountId: 'account-person' } });
    expect(await store.read(definitionId)).toMatchObject({ savedBy: { kind: 'person', accountId: 'account-person' } });
    expect((await store.read(definitionId))?.header).toMatchObject({ previewSteps: ['Review'] });
    await expect(actions.create(input, undefined, { surface: 'agent', runtimeAccountId: 'account-agent' }))
      .resolves.toMatchObject({ savedBy: { kind: 'person', accountId: 'account-person' } });
    const revised = { ...definition, blocks: [{ kind: 'step' as const, id: 'review',
      document: { text: 'Revised review', references: [], attachments: [] }, input: [], result: { kind: 'text' as const } }] };
    await expect(actions.update({ ...input, definition: revised, expectedRevision: created.revision }, undefined,
      { surface: 'agent', runtimeAccountId: 'account-agent', defaultSessionId: 'session-agent' }))
      .resolves.toMatchObject({ savedBy: { kind: 'agent', accountId: 'account-agent', sessionId: 'session-agent' } });
    expect(await store.read(definitionId)).toMatchObject({ savedBy: { kind: 'agent', accountId: 'account-agent', sessionId: 'session-agent' } });
    expect((await store.read(definitionId))?.header).toMatchObject({ previewSteps: ['Revised review'] });
    await expect(actions.update({ ...input, expectedRevision: { headerVersion: 2, bodyVersion: 2 } }, undefined,
      { surface: 'agent', runtimeAccountId: 'account-agent' }))
      .resolves.toMatchObject({ savedBy: { kind: 'agent', accountId: 'account-agent' } });
    await actions.edit({ definitionId, expectedRevision: { headerVersion: 3, bodyVersion: 3 },
      ops: [{ kind: 'rename', name: 'Reviewed' }] }, undefined,
    { surface: 'ui_button', runtimeAccountId: 'account-person' });
    await expect(actions.get({ definitionId }))
      .resolves.toMatchObject({ metadata: { title: 'Reviewed' }, savedBy: { kind: 'person', accountId: 'account-person' } });
    expect((await store.read(definitionId))?.header).toMatchObject({ previewSteps: ['Review'] });
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
    await expect(actions.list({})).resolves.toEqual({ definitions: [{ ...row.header, ownerAccountId: 'other-owner', access: 'edit', contentStatus: 'available', stepCount: 1, triggers: [], nextRunAt: null }] });
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
