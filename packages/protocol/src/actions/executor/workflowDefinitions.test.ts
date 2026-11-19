import { workflowDefinitionPreviewStepsV1 } from '../../workflows/workflowStepLabel.js';
import { describe, expect, it, vi } from 'vitest';

import { WorkflowDefinitionV1Schema } from '../../workflows/workflowV1.js';
import { ArtifactBlobReferenceV1Schema, type ArtifactRevisionProvenanceV1 } from '../../artifacts/artifactBinaryV1.js';
import { retargetWorkflowDefinitionArtifactHeaderV1 } from '../../workflows/workflowDefinitionV1.js';
import { prepareArtifactHeaderForBodyV1 } from '../../artifacts/artifactHeaderRestorationV1.js';
import { createWorkflowDefinitionActions, type WorkflowDefinitionArtifactOperations } from './workflowDefinitions.js';
import { createWorkflowActionExecutor, normalizeWorkflowActionThrownError } from './workflowAccountActions.js';
import { createWorkflowAccountRunActionOwner } from './workflowRunActions.js';
import { WorkflowDefinitionGetResultV1Schema, WorkflowDefinitionListResultV1Schema, WORKFLOW_DEFINITION_PLUGIN_CURSOR_PREFIX_V1 } from '../../workflows/actionsV1.js';
import { EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES, measureExternalActionResultResponseEnvelopeUtf8BytesV1 } from '../externalActionLimits.js';
import { resolveInputOptions } from '../../inputs/inputOptions.js';
import { ActionExecuteFailureSchema } from '../actionExecutionResult.js';
import type { ActionExecutorDeps } from './types.js';
import { createWorkflowTriggerActions } from './workflowTriggerActions.js';
import { workflowDefinitionAgentCaller } from '../../workflows/workflowDefinition.testkit.js';

const definitionId = '11111111-1111-4111-8111-111111111111';
it('classifies schema-invalid definition bodies as unreadable history in get and library reads', async () => {
  const revision = { headerVersion: 1, bodyVersion: 1 };
  const row = { artifactId: definitionId, header: { kind: 'workflow-definition.v1', definitionId, revision, metadata: { title: 'Earlier build' } },
    body: JSON.stringify({ kind: 'workflow-definition.v1', definition: { version: 1, blocks: [{ kind: 'obsolete' }] } }),
    headerVersion: 1, bodyVersion: 1, ownerAccountId: 'account-1', access: 'owner' as const, updatedAt: 1 };
  const unused = async (): Promise<never> => { throw new Error('unexpected_write'); };
  const actions = createWorkflowDefinitionActions({ artifactStore: { read: async () => ({ ...row, revision }),
    list: async () => ({ items: [row] }), create: unused, update: unused, delete: unused },
    encodeListCursor: row => row.artifactId, assertDefinitionWriteAllowed: unused, readWorkflowTriggerSummaries: readEmptyTriggerSummaries });
  await expect(actions.get({ definitionId })).rejects.toMatchObject({ code: 'history_not_readable' });
  await expect(actions.list({})).resolves.toMatchObject({ definitions: [{ contentStatus: 'unavailable', contentUnavailableReason: 'history_not_readable' }] });
});
const definition = WorkflowDefinitionV1Schema.parse({ version: 1,
  defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
  blocks: [{ kind: 'step', id: 'review', document: { text: 'Review', references: [], attachments: [] }, input: [], result: { kind: 'text' } }],
});

function readEmptyTriggerSummaries() {
  const unused = (): never => { throw new Error('unexpected_trigger_operation'); };
  // Automation persistence is a boundary; the canonical census projection remains real.
  return createWorkflowTriggerActions({ automations: {
    list: async () => ({ automations: [], nextCursor: null }), listDetails: unused, get: unused, create: unused, reconcile: unused, delete: unused,
  }, openContext: unused, sealContext: unused, newId: unused, resolveWorkflow: unused }).readWorkflowSummaries([]);
}

describe('shared workflow definition create', () => {
  it.each(['saved', 'plugin'] as const)('sizes each %s Workflow row once instead of reserializing growing page prefixes', async (kind) => {
    for (const count of [16, 64]) {
      const titles = Array.from({ length: count }, (_, index) => `FIN row measurement ${index} 🌱`);
      const markers = new Set(titles);
      const rows = titles.map((title, index) => {
        const id = `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`;
        return { artifactId: id, headerVersion: 1, bodyVersion: 1, updatedAt: 1,
          ownerAccountId: 'account', access: 'owner' as const,
          header: { kind: 'workflow-definition.v1', definitionId: id,
            revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title }, previewSteps: workflowDefinitionPreviewStepsV1(definition.blocks) },
          body: JSON.stringify({ kind: 'workflow-definition.v1', definition }),
        };
      });
      const plugins = titles.map((title, index) => ({ workflow: `plugin:com.acme.workflows/review-${index}`,
        pluginId: 'com.acme.workflows', version: '1.2.3', title, definition }));
      const unused = (): never => { throw new Error('unexpected_artifact_operation'); };
      const owner = createWorkflowDefinitionActions({ artifactStore: {
        list: async () => ({ items: rows }), read: unused, create: unused, update: unused, delete: unused,
      }, encodeListCursor: row => row.artifactId, assertDefinitionWriteAllowed: unused,
      readPluginWorkflows: () => plugins, readWorkflowTriggerSummaries: readEmptyTriggerSummaries });
      // Observe native string serialization beneath the real page sizer,
      // which measures UTF-8 without allocating TextEncoder buffers.
      const counter = vi.spyOn(JSON, 'stringify');
      try {
        const page = await owner.list(kind === 'saved' ? {} : { cursor: `${WORKFLOW_DEFINITION_PLUGIN_CURSOR_PREFIX_V1}0` });
        const actual = kind === 'saved' ? page.definitions.map(row => row.metadata?.title) : page.pluginWorkflows?.map(row => row.title);
        expect(actual).toEqual(titles);
        expect(counter.mock.calls.filter(([value]) => typeof value === 'string' && markers.has(value))).toHaveLength(count);
      } finally { counter.mockRestore(); }
    }
  });
  it('selects one plugin through the strict Action without opening thousands of saved definitions', async () => {
    const plugin = { workflow: 'plugin:external.recipe/review', pluginId: 'external.recipe', version: '1.2.3',
      title: 'External review', definition };
    let listedBodies = 0;
    const unused = (): never => { throw new Error('unexpected_artifact_operation'); };
    const definitions = createWorkflowDefinitionActions({ artifactStore: {
      list: async ({ limit }) => {
        const count = Math.min(limit ?? 2000, 2000);
        listedBodies += count;
        return { items: Array.from({ length: count }, (_, index) => ({
          artifactId: `saved-${index}`, headerVersion: 1, bodyVersion: 1, updatedAt: 1,
          ownerAccountId: 'account', access: 'owner' as const,
          header: { kind: 'workflow-definition.v1', definitionId: `saved-${index}`,
            revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Saved' } },
          body: JSON.stringify({ kind: 'workflow-definition.v1', definition }),
        })) };
      }, read: unused, create: unused, update: unused, delete: unused,
    }, encodeListCursor: row => row.artifactId, assertDefinitionWriteAllowed: unused,
    readPluginWorkflows: () => [plugin], readWorkflowTriggerSummaries: readEmptyTriggerSummaries });
    const execute = createWorkflowActionExecutor({ isWorkflowFeatureEnabled: () => true, definitions,
      runs: { execute: unused } });
    const selected = await execute({ actionId: 'workflow.definition.list', input: { workflow: plugin.workflow }, context: { surface: 'ui' } });
    expect(selected).toEqual({ definitions: [], pluginWorkflows: [plugin] });
    expect(WorkflowDefinitionListResultV1Schema.parse(selected)).toEqual(selected);
    expect(listedBodies).toBe(0);
    expect(await execute({ actionId: 'workflow.definition.list', input: { workflow: 'plugin:external.recipe/missing' },
      context: { surface: 'ui' } })).toEqual({ definitions: [], pluginWorkflows: [] });
    expect(listedBodies).toBe(0);
    // Deliberately omit the selection at the same seam: this must take the
    // collection path, proving the zero-body assertion detects missing wiring.
    await execute({ actionId: 'workflow.definition.list', input: { limit: 1 }, context: { surface: 'ui' } });
    expect(listedBodies).toBeGreaterThan(0);
  });

  it('refuses a non-UUID create identity before Artifact access rather than reporting a storage outage', async () => {
    const unused = (): never => { throw new Error('unexpected_artifact_access'); };
    const definitions = createWorkflowDefinitionActions({ artifactStore: {
      read: unused, list: unused, create: unused, update: unused, delete: unused,
    }, encodeListCursor: unused, assertDefinitionWriteAllowed: unused });
    const execute = createWorkflowActionExecutor({ isWorkflowFeatureEnabled: () => true, definitions,
      runs: { execute: unused } });
    expect(await execute({ actionId: 'workflow.definition.create', input: {
      definitionId: 'live9a-wait-20261010', definition, metadata: { title: 'Wait' },
    }, context: { surface: 'cli' } })).toMatchObject({ ok: false, errorCode: 'invalid_input' });
  });
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
        metadata: { title: artifactId === definitionId ? 7 : 'Readable neighbor' }, previewSteps: workflowDefinitionPreviewStepsV1(definition.blocks) },
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
    // A saved-definition field (workflow.definition.get's definitionId) offers only saved workflows, by name
    // (FIN-DESIGN-REVIEW L4): built-in and plugin references are not definition ids.
    const saved = await resolveInputOptions({ deps, ctx: { surface: 'ui' }, actionId: 'workflow.definition.get',
      optionsSourceId: 'workflows.references.available', input: {},
      readFailure: value => { const parsed = ActionExecuteFailureSchema.safeParse(value); return parsed.success ? parsed.data : null; },
      resolveSessionId: unused, reviewScope: unused,
    });
    expect(saved).toEqual({ ok: true, result: [
      { value: definitionId, label: definitionId }, { value: neighborId, label: 'Readable neighbor' },
    ] });
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
  it('resumes saved rows omitted by the response boundary and rejects a single oversized header', async () => {
    const rows = [0, 1].map(index => {
      const id = `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`;
      return { artifactId: id, headerVersion: 1, bodyVersion: 1, updatedAt: 1,
        ownerAccountId: 'account', access: 'owner' as const,
        header: { kind: 'workflow-definition.v1', definitionId: id,
          revision: { headerVersion: 1, bodyVersion: 1 },
          metadata: { title: '🌱'.repeat(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES / 8) }, previewSteps: workflowDefinitionPreviewStepsV1(definition.blocks) },
        body: JSON.stringify({ kind: 'workflow-definition.v1', definition }),
      };
    });
    const unused = (): never => { throw new Error('unexpected_artifact_operation'); };
    const owner = createWorkflowDefinitionActions({ artifactStore: {
      list: async ({ cursor }) => ({ items: cursor ? rows.slice(rows.findIndex(row => row.artifactId === cursor) + 1) : rows }),
      read: unused, create: unused, update: unused, delete: unused,
    }, encodeListCursor: row => row.artifactId, assertDefinitionWriteAllowed: unused,
    readWorkflowTriggerSummaries: readEmptyTriggerSummaries });
    const first = await owner.list({});
    expect(first.definitions.map(row => row.definitionId)).toEqual([rows[0]!.artifactId]);
    expect(first.nextCursor).toBe(rows[0]!.artifactId);
    expect(measureExternalActionResultResponseEnvelopeUtf8BytesV1(first)).toBeLessThanOrEqual(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES);
    const last = await owner.list({ cursor: first.nextCursor });
    expect(last.definitions.map(row => row.definitionId)).toEqual([rows[1]!.artifactId]);
    expect(last.nextCursor).toBeUndefined();
    expect(measureExternalActionResultResponseEnvelopeUtf8BytesV1(last)).toBeLessThanOrEqual(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES);
    rows[0]!.header.metadata.title += rows[0]!.header.metadata.title;
    await expect(owner.list({})).rejects.toMatchObject({ code: 'content_unavailable' });
  });
  it('pages plugin definitions within the existing Action response boundary without hiding saved workflows', async () => {
    const plugins = [0, 1].map((index) => ({ workflow: `plugin:com.acme.workflows/review-${index}`,
      pluginId: 'com.acme.workflows', version: '1.2.3', title: `Review ${index}`,
      definition: { ...definition, blocks: [{ ...definition.blocks[0]!,
        document: { text: 'x'.repeat(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES / 2), references: [], attachments: [] } }] },
    }));
    const saved = { artifactId: definitionId, headerVersion: 1, updatedAt: 1, ownerAccountId: 'account', access: 'owner' as const,
      body: JSON.stringify({ kind: 'workflow-definition.v1', definition }), bodyVersion: 1,
      header: { kind: 'workflow-definition.v1', definitionId, revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Saved' }, previewSteps: workflowDefinitionPreviewStepsV1(definition.blocks) } };
    const owner = createWorkflowDefinitionActions({ artifactStore: {
      list: async ({ cursor }) => { expect(cursor).toBeUndefined(); return { items: [saved] }; },
      read: async () => { throw new Error('list_must_not_read_per_row'); }, create: async () => {},
      update: async () => ({ ok: false, errorCode: 'unused', error: 'unused' }), delete: async () => ({ ok: true }),
    }, encodeListCursor: () => 'artifact-cursor', assertDefinitionWriteAllowed: () => {}, readPluginWorkflows: () => plugins,
    readWorkflowTriggerSummaries: async () => new Map() });
    const first = WorkflowDefinitionListResultV1Schema.parse(await owner.list({}));
    expect(first.definitions.map((entry) => entry.definitionId)).toEqual([definitionId]);
    expect(first.pluginWorkflows).toBeUndefined();
    expect(measureExternalActionResultResponseEnvelopeUtf8BytesV1(first)).toBeLessThanOrEqual(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES);
    expect(first.nextCursor).toBeDefined();
    const next = WorkflowDefinitionListResultV1Schema.parse(await owner.list({ cursor: first.nextCursor }));
    expect(next.definitions).toEqual([]);
    expect(next.pluginWorkflows?.map((entry) => entry.workflow)).toEqual([plugins[0]!.workflow]);
    expect(next.nextCursor).toBeDefined();
    expect(measureExternalActionResultResponseEnvelopeUtf8BytesV1(next)).toBeLessThanOrEqual(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES);
    const last = WorkflowDefinitionListResultV1Schema.parse(await owner.list({ cursor: next.nextCursor }));
    expect(last.pluginWorkflows?.map((entry) => entry.workflow)).toEqual([plugins[1]!.workflow]);
    expect(last.nextCursor).toBeUndefined();
    expect(measureExternalActionResultResponseEnvelopeUtf8BytesV1(last)).toBeLessThanOrEqual(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES);
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
    const first = WorkflowDefinitionListResultV1Schema.parse(await execute({ actionId: 'workflow.definition.list', input: {}, context: { surface: 'agent' } }));
    expect(first.definitions).toEqual([]);
    expect(first.nextCursor).toBeDefined();
    const result = await execute({ actionId: 'workflow.definition.list', input: { cursor: first.nextCursor }, context: { surface: 'agent' } });
    expect(result).toEqual({ definitions: [], pluginWorkflows: [plugin] });
    expect(WorkflowDefinitionListResultV1Schema.parse(result)).toEqual(result);
  });
  it.each(['direct plugin', 'saved child'] as const)('returns Account rows without resolving a nested %s destination', async (source) => {
    const childId = '22222222-2222-4222-8222-222222222222';
    const neighborId = '33333333-3333-4333-8333-333333333333';
    const pluginRef = 'plugin:com.acme.workflows/review';
    const withChild = (workflowRef: string, sessionId: string) => WorkflowDefinitionV1Schema.parse({
      ...definition, defaults: { ...definition.defaults,
        conversation: { kind: 'existing_session', sessionId, machineId: 'machine' } },
      blocks: [{ kind: 'workflow', id: 'nested', workflowRef, input: {} }],
    });
    const parent = withChild(source === 'saved child' ? childId : pluginRef, 'parent-session');
    const child = withChild(pluginRef, 'child-session');
    const plugin = { workflow: pluginRef, pluginId: 'com.acme.workflows', version: '1.2.3', title: 'Plugin review',
      definition: WorkflowDefinitionV1Schema.parse({ ...definition, defaults: { ...definition.defaults,
        conversation: { kind: 'existing_session', sessionId: 'plugin-session', machineId: 'machine' } } }) };
    const revision = { headerVersion: 1, bodyVersion: 1 };
    const row = (artifactId: string, value: typeof definition) => ({
      artifactId, headerVersion: 1, bodyVersion: 1, updatedAt: 1, ownerAccountId: 'owner', access: 'owner' as const,
      header: { kind: 'workflow-definition.v1', definitionId: artifactId, revision, metadata: { title: artifactId },
        previewSteps: workflowDefinitionPreviewStepsV1(value.blocks) },
      body: JSON.stringify({ kind: 'workflow-definition.v1', definition: value }),
    });
    const rows = [row(definitionId, parent), row(childId, child), row(neighborId, definition)];
    const unused = (): never => { throw new Error('unexpected_write'); };
    let pluginOffline = true;
    // Artifact persistence and remote plugin discovery are boundaries; their real
    // definition readers, recursive destination projection and list owner run here.
    const owner = createWorkflowDefinitionActions({ artifactStore: {
      list: async () => ({ items: [rows[0]!, rows[2]!] }),
      read: async artifactId => {
        const saved = rows.find(candidate => candidate.artifactId === artifactId);
        return saved ? { ...saved, revision } : null;
      }, create: unused, update: unused, delete: unused,
    }, encodeListCursor: saved => saved.artifactId, assertDefinitionWriteAllowed: unused,
    readWorkflowTriggerSummaries: readEmptyTriggerSummaries,
    readPluginWorkflows: async () => {
      if (pluginOffline) throw new Error('remote_plugin_catalog_offline');
      return [plugin];
    } });
    const accountPage = WorkflowDefinitionListResultV1Schema.parse(await owner.list({}));
    expect(accountPage.definitions.map(saved => saved.definitionId)).toEqual([definitionId, neighborId]);
    // The library page is summaries: it never resolves nested destinations, so an offline plugin cannot hold it.
    expect(accountPage.definitions[0]).toMatchObject({ contentStatus: 'available', stepCount: 1 });
    expect(accountPage.definitions[0]).not.toHaveProperty('destinations');
    expect(accountPage.definitions[1]).toMatchObject({ contentStatus: 'available' });
    expect(accountPage.pluginWorkflows).toBeUndefined();
    expect(accountPage.nextCursor).toBeDefined();
    await expect(owner.list({ cursor: accountPage.nextCursor })).rejects.toThrow('remote_plugin_catalog_offline');
    expect(WorkflowDefinitionGetResultV1Schema.parse(await owner.get({ definitionId })).destinations.unresolvedWorkflowRefs)
      .toEqual([pluginRef]);
    pluginOffline = false;
    expect(WorkflowDefinitionListResultV1Schema.parse(await owner.list({ cursor: accountPage.nextCursor })))
      .toEqual({ definitions: [], pluginWorkflows: [plugin] });
    const opened = WorkflowDefinitionGetResultV1Schema.parse(await owner.get({ definitionId }));
    expect(opened.destinations.targetSessionIds).toEqual(source === 'saved child'
      ? ['parent-session', 'child-session', 'plugin-session'] : ['parent-session', 'plugin-session']);
    expect(opened.destinations.unresolvedWorkflowRefs).toEqual([]);
  });
  it('creates, rejoins, updates and edits while plugin destinations are offline', async () => {
    const pluginRef = 'plugin:com.acme.workflows/review';
    const nested = WorkflowDefinitionV1Schema.parse({ ...definition,
      blocks: [{ kind: 'workflow', id: 'nested', workflowRef: pluginRef, input: {} }] });
    let stored: Awaited<ReturnType<WorkflowDefinitionArtifactOperations['read']>> = null;
    let writes = 0;
    let catalogReads = 0;
    let abortDiscovery = false;
    const controller = new AbortController();
    const store: WorkflowDefinitionArtifactOperations = {
      read: async () => stored, list: async () => ({ items: [] }), delete: async () => ({ ok: true }),
      create: async input => { stored = { ...input, revision: { headerVersion: 1, bodyVersion: 1 }, ownerAccountId: 'owner', access: 'owner' }; },
      update: async input => {
        writes += 1;
        const revision = { headerVersion: input.expectedRevision.headerVersion + 1, bodyVersion: input.expectedRevision.bodyVersion + 1 };
        stored = { ...input, revision, ownerAccountId: 'owner', access: 'owner' };
        return { ok: true, revision };
      },
    };
    const owner = createWorkflowDefinitionActions({ artifactStore: store, encodeListCursor: () => '',
      readPluginWorkflows: async () => {
        catalogReads += 1;
        if (abortDiscovery) { controller.abort(); controller.signal.throwIfAborted(); }
        throw new Error('remote_plugin_catalog_offline');
      } });
    const input = { definitionId, metadata: { title: 'Nested' }, definition: nested };
    const created = WorkflowDefinitionGetResultV1Schema.parse(await owner.create(input, undefined, { surface: 'ui' }));
    expect(created.destinations.unresolvedWorkflowRefs).toEqual([pluginRef]);
    expect(await owner.create(input, undefined, { surface: 'ui' })).toEqual(created);
    const updated = WorkflowDefinitionGetResultV1Schema.parse(await owner.update({ ...input,
      metadata: { title: 'Renamed' }, expectedRevision: created.revision }, undefined, { surface: 'ui' }));
    expect(updated.destinations.unresolvedWorkflowRefs).toEqual([pluginRef]);
    expect(writes).toBe(1);
    const edited = await owner.edit({ definitionId, expectedRevision: updated.revision,
      ops: [{ kind: 'rename', name: 'Edited' }] }, undefined, { surface: 'ui' });
    expect(edited.metadata.title).toBe('Edited');
    expect(writes).toBe(2);
    await owner.edit({ definitionId, expectedRevision: edited.revision,
      ops: [{ kind: 'rename', name: 'Edited' }] }, undefined, { surface: 'ui' });
    expect(writes).toBe(2);
    expect(catalogReads).toBe(0);
    expect(WorkflowDefinitionGetResultV1Schema.parse(await owner.get({ definitionId })).metadata.title).toBe('Edited');
    expect(catalogReads).toBe(1);
    abortDiscovery = true;
    await expect(owner.get({ definitionId, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
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
  it.each(['stale_revision', 'wrong_identity', 'other_kind'] as const)('allows only Workflow owner deletion of a damaged header (%s)', async damage => {
    const writes: string[] = [];
    const revision = { headerVersion: 2, bodyVersion: 2 };
    const store: WorkflowDefinitionArtifactOperations = {
      read: async () => ({ artifactId: definitionId, access: 'owner', ownerAccountId: 'owner', revision,
        header: { kind: damage === 'other_kind' ? 'doc.v1' : 'workflow-definition.v1',
          definitionId: damage === 'wrong_identity' ? '22222222-2222-4222-8222-222222222222' : definitionId,
          revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Damaged' } }, body: null }),
      list: async () => ({ items: [] }), create: async () => {},
      update: async () => ({ ok: false, errorCode: 'unused', error: 'unused' }),
      delete: async () => { writes.push('artifact'); return { ok: true }; },
    };
    const owner = createWorkflowDefinitionActions({ artifactStore: store, encodeListCursor: () => '',
      removeWorkflowTriggers: async () => { writes.push('triggers'); } });
    if (damage === 'other_kind') {
      await expect(owner.delete({ definitionId })).rejects.toMatchObject({ code: 'content_unavailable' });
      expect(writes).toEqual([]);
    } else {
      expect(await owner.delete({ definitionId })).toEqual({ deleted: true, definitionId });
      expect(writes).toEqual(['triggers', 'artifact']);
    }
  });
  it('lists distinct authored Agents from the saved preview without opening a Workflow body', async () => {
    const unused = (): never => { throw new Error('unexpected_artifact_operation'); };
    let stored: Parameters<WorkflowDefinitionArtifactOperations['create']>[0] | undefined;
    let listing = false;
    const claude = definition.defaults.agentTarget;
    if (claude?.kind !== 'agent') throw new Error('fixture_agent_missing');
    const codex = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } };
    const step = definition.blocks[0]!;
    const authored = WorkflowDefinitionV1Schema.parse({ ...definition, blocks: [
      step,
      { ...step, id: 'revise', execution: { agentTarget: codex } },
      { ...step, id: 'verify', execution: { agentTarget: codex } },
    ] });
    const owner = createWorkflowDefinitionActions({ artifactStore: {
      create: async input => { stored = input; }, update: unused, delete: unused,
      read: async () => {
        if (listing) return unused();
        return stored ? { ...stored, revision: { headerVersion: 1, bodyVersion: 1 }, updatedAt: 1,
          ownerAccountId: 'account', access: 'owner' } : null;
      },
      list: async ({ includeBody }) => {
        expect(includeBody).toBe(false);
        if (!stored) throw new Error('test_artifact_not_written');
        return { items: [{ artifactId: stored.artifactId, headerVersion: 1, bodyVersion: 1, header: stored.header,
          updatedAt: 1, ownerAccountId: 'account', access: 'owner' }] };
      },
    }, encodeListCursor: row => row.artifactId, readWorkflowTriggerSummaries: readEmptyTriggerSummaries });
    await owner.create({ definitionId, metadata: { title: 'Release' }, definition: authored }, undefined, { surface: 'ui' });
    listing = true;
    expect(WorkflowDefinitionListResultV1Schema.parse(await owner.list({})).definitions[0]).toMatchObject({
      previewAgents: [claude.identity, codex.identity],
    });
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
    const actions = createWorkflowDefinitionActions({ artifactStore: store, encodeListCursor: () => 'cursor',
      resolveMaterializer: async () => ({ effects: { resolveTargetAvailability: async () => true } }) });
    const captureProvenance = { discussion: { serverId: 'home', discussionId: 'source-discussion' }, messages: [{
      source: { kind: 'discussion' as const, discussion: { serverId: 'home', discussionId: 'source-discussion' }, messageId: 'question' },
      authorAccountId: 'source-author',
    }] };
    const input = { definitionId, definition, metadata: { title: 'Review', captureProvenance } };
    const person = { surface: 'ui' as const, authority: 'present_user' as const,
      actionCaller: { kind: 'host' as const }, runtimeAccountId: 'account-person' };
    const created = await actions.create(input, undefined, person);
    expect(created).toMatchObject({ savedBy: { kind: 'person', accountId: 'account-person' } });
    expect((await store.read(definitionId))?.provenance).toEqual({ savedBy: { kind: 'person', accountId: 'account-person' } });
    expect((await store.read(definitionId))?.header).toMatchObject({ previewSteps: ['Review'] });
    expect((await store.read(definitionId))?.header).not.toHaveProperty('savedBy');
    await expect(actions.create(input, undefined, { ...workflowDefinitionAgentCaller(definition), runtimeAccountId: 'account-agent' }))
      .resolves.toMatchObject({ savedBy: { kind: 'person', accountId: 'account-person' } });
    const revised = { ...definition, blocks: [{ kind: 'step' as const, id: 'review',
      document: { text: 'Revised review', references: [], attachments: [] }, input: [], result: { kind: 'text' as const } }] };
    await expect(actions.update({ ...input, definition: revised, expectedRevision: created.revision }, undefined,
      { ...workflowDefinitionAgentCaller(definition), runtimeAccountId: 'account-agent' }))
      .resolves.toMatchObject({ savedBy: { kind: 'agent', accountId: 'account-agent', sessionId: 'session-agent' } });
    expect((await store.read(definitionId))?.provenance).toEqual({ savedBy: { kind: 'agent', accountId: 'account-agent', sessionId: 'session-agent' } });
    expect((await store.read(definitionId))?.header).toMatchObject({ previewSteps: ['Revised review'] });
    expect((await store.read(definitionId))?.header).not.toHaveProperty('savedBy');
    await expect(actions.update({ ...input, expectedRevision: { headerVersion: 2, bodyVersion: 2 } }, undefined,
      { ...workflowDefinitionAgentCaller(definition), defaultSessionId: undefined, runtimeAccountId: 'account-agent' }))
      .resolves.toMatchObject({ savedBy: { kind: 'agent', accountId: 'account-agent' } });
    await actions.edit({ definitionId, expectedRevision: { headerVersion: 3, bodyVersion: 3 },
      ops: [{ kind: 'rename', name: 'Reviewed' }] }, undefined,
    person);
    await expect(actions.get({ definitionId }))
      .resolves.toMatchObject({ metadata: { title: 'Reviewed', captureProvenance }, savedBy: { kind: 'person', accountId: 'account-person' } });
    expect((await actions.get({ definitionId })).definition).not.toHaveProperty('captureProvenance');
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
    const header = { kind: 'workflow-definition.v1', definitionId, revision, metadata: { title: 'Shared' }, previewSteps: workflowDefinitionPreviewStepsV1(definition.blocks) };
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
    const header = { kind: 'workflow-definition.v1', definitionId, revision, metadata: { title: 'Shared' },
      previewSteps: workflowDefinitionPreviewStepsV1(definition.blocks) };
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

  it('opens unknown stored fields without rewriting an equal Save, then canonicalizes a real edit', async () => {
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
    let writes = 0;
    const store: WorkflowDefinitionArtifactOperations = {
      read: async () => ({ ...row(), revision }), list: async () => ({ items: [row()] }),
      create: async () => {}, delete: async () => ({ ok: true }),
      update: async input => {
        writes += 1;
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
    await actions.update({ definitionId, expectedRevision: revision, metadata: opened.metadata, definition: opened.definition }, undefined, { surface: 'ui' });
    expect(writes).toBe(0);
    expect(revision).toEqual({ headerVersion: 2, bodyVersion: 2 });
    await actions.update({ definitionId, expectedRevision: revision, metadata: { title: 'Changed' }, definition: opened.definition }, undefined, { surface: 'ui' });
    expect(writes).toBe(1);
    expect(header).toEqual({ kind: 'workflow-definition.v1', definitionId, revision,
      metadata: { title: 'Changed' }, previewSteps: ['Review'] });
    expect(JSON.parse(body)).toEqual({ kind: 'workflow-definition.v1', definition: authored });
  });

  it('lists grant-reachable workflows with their owner/access and filters other opened kinds', async () => {
    const row = { artifactId: definitionId, headerVersion: 1, updatedAt: 1, ownerAccountId: 'other-owner', access: 'edit' as const,
      body: JSON.stringify({ kind: 'workflow-definition.v1', definition }), bodyVersion: 1,
      header: { kind: 'workflow-definition.v1', definitionId, revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Shared' }, previewSteps: workflowDefinitionPreviewStepsV1(definition.blocks) } };
    const store: WorkflowDefinitionArtifactOperations = {
      read: async () => { throw new Error('list_must_not_read_per_row'); }, list: async () => ({ items: [row, { ...row, artifactId: 'role', header: { kind: 'role.v1' } }] }),
      create: async () => undefined, update: async () => ({ ok: false, errorCode: 'not_found', error: 'not_found' }), delete: async () => ({ ok: true }),
    };
    const actions = createWorkflowDefinitionActions({ artifactStore: store, encodeListCursor: () => 'cursor', assertDefinitionWriteAllowed: () => {},
      readWorkflowTriggerSummaries: async () => new Map() });
    const listed = await actions.list({});
    expect(listed).toMatchObject({ definitions: [{ ...row.header, ownerAccountId: 'other-owner', access: 'edit', contentStatus: 'available', stepCount: 1, triggers: [], nextRunAt: null }] });
    // A library row is a summary; its destinations are read when the definition is opened.
    expect(listed.definitions[0]).not.toHaveProperty('destinations');
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
    await expect(actions.create({ definitionId, definition, metadata: { description: 'Same document', title: 'Review' } }, undefined, { surface: 'ui' }))
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
    await expect(actions.create({ definitionId, definition, metadata: { title: 'Review' } }, undefined, { surface: 'ui' }))
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
    await expect(actions.create({ definitionId, definition, metadata: { title: 'Review' } }, undefined, { surface: 'ui' })).rejects.toBe(failure);
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
    await expect(actions.get({ definitionId })).rejects.toMatchObject({ code: kind === 'blob reference' ? 'content_unavailable' : 'history_not_readable' });
  });
});
