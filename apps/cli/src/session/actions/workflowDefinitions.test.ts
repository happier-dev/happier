import {
  EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
  isExternalActionResultWithinResponseEnvelopeLimitV1,
  accountSettingsParse,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { encodeAccountArtifactListCursor, type createAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';

import { createWorkflowDefinitionActions } from './workflowDefinitions';
import { resolveCliAgentStartContextV1 } from './resolveCliAgentStartContextV1';

const agentStartContext = resolveCliAgentStartContextV1({
  sessionId: 'origin', machineId: 'machine', directory: '/repo',
  backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
  metadata: {}, starterDepth: 0, turnDepth: 0, callerPermissionMode: 'default', settings: accountSettingsParse({}),
});
if (!agentStartContext) throw new Error('expected current host authority fixture');
// The machine catalog is a system boundary. Materialization and policy remain real.
const resolveMaterializer = async () => ({ effects: { resolveTargetAvailability: async () => true } });

const definitionBody = JSON.stringify({
  kind: 'workflow-definition.v1',
  definition: {
    version: 1,
    defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
    blocks: [{ kind: 'step', id: 'step-1', document: { text: 'Review', references: [], attachments: [] }, input: [], result: { kind: 'text' } }],
  },
});

type ArtifactCreateInput = Parameters<ReturnType<typeof createAccountArtifactStore>['create']>[0];

describe('workflow definition Actions', () => {
  it('allows an agent to save input-bound loop limits while enforcing the leaf authority', async () => {
    const step = { kind: 'step', id: 'work', document: { text: 'Work', references: [], attachments: [] }, input: [], result: { kind: 'text' } };
    const definition = { version: 1 as const, defaults: JSON.parse(definitionBody).definition.defaults,
      inputs: [{ name: 'rounds', valueType: 'number', required: true }],
      blocks: [{ kind: 'loop', id: 'loop', repetition: { kind: 'until', maxIterations: { kind: 'input', name: 'rounds' },
        stopWhen: { kind: 'exists', value: { kind: 'literal', value: true } } }, body: [step] }] };
    let stored: ArtifactCreateInput | undefined;
    const actions = createWorkflowDefinitionActions({ artifactStore: {
      read: async () => stored ? { artifactId: 'definition-1', header: stored.header, body: stored.body,
        revision: { headerVersion: 1, bodyVersion: 1 }, seq: 1, createdAt: 1, updatedAt: 1 } : null,
      create: async (input: ArtifactCreateInput) => { stored = input; return { artifactId: 'definition-1', revision: { headerVersion: 1, bodyVersion: 1 } }; },
    } as never, resolveMaterializer });
    const caller = { surface: 'agent' as const, agentStartContext, sessionAgentSpawnPolicyV1: { v: 1 as const, allowModelOverride: false } };
    await expect(actions.create({ definitionId: 'definition-1', metadata: { title: 'Loop' }, definition }, undefined, caller))
      .resolves.toMatchObject({ definitionId: 'definition-1' });
    if (typeof stored?.body !== 'string') throw new Error('expected a text Workflow definition');
    expect(JSON.parse(stored.body).definition.blocks[0].repetition.maxIterations).toEqual({ kind: 'input', name: 'rounds' });
    const forbidden = { ...definition, blocks: [{ ...definition.blocks[0], body: [{ ...step, execution: { modelSelection: {
      v: 1, ref: { agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId: 'other' }, updatedAt: 1,
    } } }] }] };
    await expect(actions.create({ definitionId: 'definition-2', metadata: { title: 'Forbidden' }, definition: forbidden }, undefined, caller))
      .rejects.toMatchObject({ code: 'definition_exceeds_authority' });
  });
  it.each(['existing', 'conflict', 'response_loss'] as const)('rejoins semantically identical same-id content after %s', async (scenario) => {
    const definitionId = '11111111-1111-4111-8111-111111111111';
    const definition = JSON.parse(definitionBody).definition;
    const artifact = {
      artifactId: definitionId,
      header: { kind: 'workflow-definition.v1', definitionId, revision: { headerVersion: 1, bodyVersion: 1 },
        metadata: { title: 'Review', description: 'Same document' } },
      body: definitionBody, revision: { headerVersion: 1, bodyVersion: 1 }, seq: 1, createdAt: 1, updatedAt: 1,
    };
    let saved = scenario === 'existing';
    const actions = createWorkflowDefinitionActions({ artifactStore: {
      read: async () => saved ? artifact : null,
      create: async () => {
        saved = true;
        throw Object.assign(new Error(scenario), { code: scenario === 'conflict' ? 'conflict' : 'network_error' });
      },
    } as never });
    await expect(actions.create({ definitionId, definition, metadata: { description: 'Same document', title: 'Review' } }))
      .resolves.toMatchObject({ definitionId, metadata: { title: 'Review', description: 'Same document' } });
  });

  it.each(['conflict', 'response_loss'] as const)('refuses different same-id content after %s', async (scenario) => {
    const definitionId = '11111111-1111-4111-8111-111111111111';
    let saved = false;
    const actions = createWorkflowDefinitionActions({ artifactStore: {
      read: async () => saved ? { artifactId: definitionId,
        header: { kind: 'workflow-definition.v1', definitionId, revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Other' } },
        body: definitionBody, revision: { headerVersion: 1, bodyVersion: 1 }, seq: 1, createdAt: 1, updatedAt: 1 } : null,
      create: async () => { saved = true; throw Object.assign(new Error(scenario), { code: scenario === 'conflict' ? 'conflict' : 'network_error' }); },
    } as never });
    await expect(actions.create({ definitionId, definition: JSON.parse(definitionBody).definition, metadata: { title: 'Review' } }))
      .rejects.toMatchObject({ code: 'currentness_conflict' });
  });

  it('refuses an agent-created definition with a forbidden step model override', async () => {
    const definition = JSON.parse(definitionBody).definition;
    definition.blocks[0].execution = { modelSelection: {
      v: 1, ref: { agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId: 'model-1' }, updatedAt: 1,
    } };
    const create = vi.fn(async (_input: ArtifactCreateInput) => ({ artifactId: 'definition-1', revision: { headerVersion: 1, bodyVersion: 1 } }));
    const read = vi.fn().mockResolvedValueOnce(null).mockImplementation(async () => {
      const request = create.mock.calls[0]![0];
      return { artifactId: 'definition-1', header: request.header, body: request.body,
        revision: { headerVersion: 1, bodyVersion: 1 }, seq: 1, createdAt: 1, updatedAt: 1 };
    });
    const actions = createWorkflowDefinitionActions({ artifactStore: { create, read } as never, resolveMaterializer });
    await expect(actions.create({ definitionId: 'definition-1', metadata: { title: 'Review' }, definition },
      { agentTarget: definition.defaults.agentTarget },
      { surface: 'agent', agentStartContext, sessionAgentSpawnPolicyV1: { v: 1, allowModelOverride: false } },
    )).rejects.toMatchObject({ code: 'definition_exceeds_authority', details: {
      cause: { code: 'policy_denied_field', field: 'modelSelection' },
    } });
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses an agent update that introduces a forbidden step model override', async () => {
    const definition = JSON.parse(definitionBody).definition;
    definition.blocks[0].execution = { modelSelection: {
      v: 1, ref: { agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId: 'model-1' }, updatedAt: 1,
    } };
    const update = vi.fn();
    const actions = createWorkflowDefinitionActions({ artifactStore: { update, read: vi.fn() } as never, resolveMaterializer });
    await expect(actions.update({ definitionId: 'definition-1', expectedRevision: { headerVersion: 1, bodyVersion: 1 },
      metadata: { title: 'Review' }, definition }, { agentTarget: definition.defaults.agentTarget },
    { surface: 'agent', agentStartContext, sessionAgentSpawnPolicyV1: { v: 1, allowModelOverride: false } }))
      .rejects.toMatchObject({ code: 'definition_exceeds_authority', details: {
        cause: { code: 'policy_denied_field', field: 'modelSelection' },
      } });
    expect(update).not.toHaveBeenCalled();
  });

  it('admits an authored workflow role through its frozen selection without a Settings role entry', async () => {
    const definition = { ...JSON.parse(definitionBody).definition, defaults: { engine: { role: 'workflow_reviewer' } },
      roles: [{ roleId: 'workflow_reviewer', name: 'Reviewer', instructions: 'Review only',
        runsAs: { kind: 'session' }, engine: { agentTargetKey: 'agent:happier.agent.claude/claude' } }],
    };
    const create = vi.fn(async (_input: ArtifactCreateInput) => ({ artifactId: 'definition-1', revision: { headerVersion: 1, bodyVersion: 1 } }));
    const read = vi.fn().mockResolvedValueOnce(null).mockImplementation(async () => {
      const request = create.mock.calls[0]![0];
      return { artifactId: 'definition-1', header: request.header, body: request.body,
        revision: { headerVersion: 1, bodyVersion: 1 }, seq: 1, createdAt: 1, updatedAt: 1 };
    });
    const actions = createWorkflowDefinitionActions({ artifactStore: { create, read } as never, resolveMaterializer });
    await expect(actions.create({ definitionId: 'definition-1', metadata: { title: 'Review' }, definition },
      { agentTarget: JSON.parse(definitionBody).definition.defaults.agentTarget },
      { surface: 'agent', agentStartContext, sessionAgentSpawnPolicyV1: { v: 1 } },
    )).resolves.toMatchObject({ definitionId: 'definition-1' });
    expect(create).toHaveBeenCalledOnce();
  });

  it('checks a nested definition’s same-id role against its own frozen engine before any write', async () => {
    const role = { roleId: 'scoped', name: 'Scoped', instructions: 'Review', runsAs: { kind: 'session' },
      engine: { agentTargetKey: 'agent:happier.agent.claude/claude' } };
    const step = { kind: 'step', id: 'same', document: { text: 'Review', references: [], attachments: [] }, input: [], result: { kind: 'text' } };
    const definition = { version: 1 as const, defaults: { engine: { role: 'scoped' } }, roles: [role],
      blocks: [step, { kind: 'workflow', id: 'nested', workflowRef: 'builtin:child', input: {} }],
    };
    const child = { version: 1, defaults: { engine: { role: 'scoped' } },
      roles: [{ ...role, engine: { agentTargetKey: 'agent:happier.agent.codex/codex' } }], blocks: [step] };
    const create = vi.fn();
    const actions = createWorkflowDefinitionActions({ artifactStore: { create, read: async () => null } as never,
      resolveMaterializer: async () => ({ effects: { resolveTargetAvailability: async () => true,
        readWorkflowDefinition: async () => ({ sourceKey: 'builtin:child', definition: child }),
      } }),
    });
    await expect(actions.create({ definitionId: 'definition-1', metadata: { title: 'Review' }, definition }, undefined,
      { surface: 'agent', agentStartContext, sessionAgentSpawnPolicyV1: { v: 1, allowBackendTargetOverride: false } },
    )).rejects.toMatchObject({ code: 'definition_exceeds_authority', details: {
      blockId: 'same', cause: { code: 'policy_denied_field', field: 'agentTarget' },
    } });
    expect(create).not.toHaveBeenCalled();
  });

  it('normalizes through the canonical workflow validator before Artifact create', async () => {
    const create = vi.fn(async (_input: ArtifactCreateInput) => ({ artifactId: 'definition-1', revision: { headerVersion: 1, bodyVersion: 1 } }));
    const read = vi.fn()
      .mockResolvedValueOnce(null)
      .mockImplementation(async () => {
        const request = create.mock.calls[0]![0];
        return { artifactId: 'definition-1', header: request.header, body: request.body,
          revision: { headerVersion: 1, bodyVersion: 1 }, seq: 1, createdAt: 1, updatedAt: 1 };
      });
    const actions = createWorkflowDefinitionActions({ artifactStore: { create, read } as never });
    await actions.create({ definitionId: 'definition-1', metadata: { title: 'Review' },
      definition: { version: 1, defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } }, blocks: ['Review this'] } });
    expect(create).toHaveBeenCalledOnce();
    const storedBody = create.mock.calls[0]![0].body;
    if (typeof storedBody !== 'string') throw new Error('expected a text Workflow definition');
    const body = JSON.parse(storedBody);
    expect(body.kind).toBe('workflow-definition.v1');
    expect(body.definition.blocks[0]).toMatchObject({ kind: 'step', id: 'wf--step-0' });
  });

  it('rejects invalid definitions without writing', async () => {
    const create = vi.fn();
    const actions = createWorkflowDefinitionActions({ artifactStore: { create, read: vi.fn() } as never });
    await expect(actions.create({ definitionId: 'definition-1', metadata: { title: 'Review' }, definition: { blocks: [] } }))
      .rejects.toMatchObject({ code: 'invalid_input' });
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects a definition header whose identity or current revision disagrees with the Artifact row', async () => {
    const read = vi.fn(async () => ({
      artifactId: 'definition-1',
      header: {
        kind: 'workflow-definition.v1',
        definitionId: 'definition-2',
        revision: { headerVersion: 1, bodyVersion: 1 },
        metadata: { title: 'Wrong identity' },
      },
      body: JSON.stringify({
        kind: 'workflow-definition.v1',
        definition: {
          version: 1,
          defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
          blocks: [{ kind: 'step', id: 'step-1', document: { text: 'Work', references: [], attachments: [] }, input: [], result: { kind: 'text' } }],
        },
      }),
      revision: { headerVersion: 2, bodyVersion: 2 },
      seq: 1,
      createdAt: 1,
      updatedAt: 1,
    }));
    const actions = createWorkflowDefinitionActions({ artifactStore: { read } as never });

    await expect(actions.get({ definitionId: 'definition-1' }))
      .rejects.toMatchObject({ code: 'content_unavailable' });
  });

  it('continues across sparse encrypted-header pages without dropping the next matching row', async () => {
    const workflowHeader = (id: string, updatedAt: number) => ({ artifactId: id, updatedAt, headerVersion: 1,
      body: definitionBody, bodyVersion: 1,
      seq: updatedAt, createdAt: updatedAt, header: { kind: 'workflow-definition.v1', definitionId: id,
        revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: id } } });
    const definitionOne = '11111111-1111-4111-8111-111111111111';
    const definitionTwo = '22222222-2222-4222-8222-222222222222';
    const list = vi.fn()
      .mockResolvedValueOnce({ items: [{ ...workflowHeader('other', 3), header: { kind: 'prompt_doc.v2' } }], nextCursor: 'page-2' })
      .mockResolvedValueOnce({ items: [workflowHeader(definitionOne, 2), workflowHeader(definitionTwo, 1)] });
    const actions = createWorkflowDefinitionActions({ artifactStore: { list,
      read: async () => { throw new Error('list_must_not_read_per_row'); },
    } as never, readWorkflowTriggerSummaries: async () => new Map() });
    await expect(actions.list({ limit: 1 })).resolves.toMatchObject({
      definitions: [{ definitionId: definitionOne }], nextCursor: expect.any(String),
    });
    expect(list).toHaveBeenNthCalledWith(2, { limit: 500, cursor: 'page-2', includeBody: true });
  });

  it('fails closed when private header identity/currentness disagrees with the Artifact row', async () => {
    const definitionId = '11111111-1111-4111-8111-111111111111';
    const read = vi.fn(async () => ({
      artifactId: definitionId,
      header: {
        kind: 'workflow-definition.v1',
        definitionId,
        revision: { headerVersion: 1, bodyVersion: 1 },
        metadata: { title: 'Review' },
      },
      body: JSON.stringify({
        kind: 'workflow-definition.v1',
        definition: {
          version: 1,
          defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
          blocks: [{ kind: 'step', id: 'step-1', document: { text: 'Review', references: [], attachments: [] }, input: [], result: { kind: 'text' } }],
        },
      }),
      revision: { headerVersion: 2, bodyVersion: 1 },
      seq: 1,
      createdAt: 1,
      updatedAt: 1,
    }));
    const actions = createWorkflowDefinitionActions({ artifactStore: { read } as never });

    await expect(actions.get({ definitionId })).rejects.toMatchObject({ code: 'content_unavailable' });
  });

  it('shortens a page by the complete public Action response envelope and replays the omitted row', async () => {
    const definitionOne = '11111111-1111-4111-8111-111111111111';
    const definitionTwo = '22222222-2222-4222-8222-222222222222';
    const row = (id: string, updatedAt: number, description: string) => ({ artifactId: id, updatedAt, headerVersion: 1,
      body: definitionBody, bodyVersion: 1,
      seq: updatedAt, createdAt: updatedAt, header: { kind: 'workflow-definition.v1', definitionId: id,
        revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: id, description } } });
    const partialBytes = (rows: ReadonlyArray<ReturnType<typeof row>>) => Buffer.byteLength(
      JSON.stringify({ ok: true, result: { definitions: rows.map((candidate) => candidate.header) } }), 'utf8');
    const rowOne = row(definitionOne, 2, 'x'.repeat(12_000_000));
    const rowTwo = row(definitionTwo, 1, 'x'.repeat(
      EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES - partialBytes([rowOne, row(definitionTwo, 1, '')])));
    // Both rows fit the former partial `{ ok, result }` measure exactly; only the
    // public `v`/`actionId`/`requestId` framing pushes the candidate page over.
    expect(partialBytes([rowOne, rowTwo])).toBe(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES);
    const list = vi.fn(async ({ cursor }: { cursor?: string }) => cursor === encodeAccountArtifactListCursor(rowOne)
      ? { items: [rowTwo] }
      : { items: [rowOne, rowTwo] });
    const actions = createWorkflowDefinitionActions({ artifactStore: { list,
      read: async () => { throw new Error('list_must_not_read_per_row'); },
    } as never, readWorkflowTriggerSummaries: async () => new Map() });

    const firstPage = await actions.list({});
    expect(firstPage.definitions.map((definition) => definition.definitionId)).toEqual([definitionOne]);
    expect(firstPage.nextCursor).toBe(encodeAccountArtifactListCursor(rowOne));
    expect(isExternalActionResultWithinResponseEnvelopeLimitV1(firstPage)).toBe(true);

    const secondPage = await actions.list({ cursor: firstPage.nextCursor });
    expect(secondPage).toMatchObject({ definitions: [{ ...rowTwo.header, stepCount: 1, triggers: [] }] });
    expect(list).toHaveBeenLastCalledWith({ limit: 500, cursor: firstPage.nextCursor, includeBody: true });
  });

  describe('delete', () => {
    const definitionId = '11111111-1111-4111-8111-111111111111';
    const headerFor = (id: string, revision: { headerVersion: number; bodyVersion: number }) => ({
      kind: 'workflow-definition.v1', definitionId: id, revision, metadata: { title: 'Review' },
    });
    const artifactWith = (header: ReturnType<typeof headerFor>) => ({
      artifactId: definitionId, header, body: definitionBody, ownerAccountId: 'account-1', access: 'owner' as const,
      revision: { headerVersion: 2, bodyVersion: 2 }, seq: 1, createdAt: 1, updatedAt: 1,
    });

    it('refuses to delete when the valid header identity or revision disagrees with the Artifact row', async () => {
      for (const header of [
        headerFor('22222222-2222-4222-8222-222222222222', { headerVersion: 2, bodyVersion: 2 }),
        headerFor(definitionId, { headerVersion: 2, bodyVersion: 1 }),
      ]) {
        const remove = vi.fn(async () => ({ ok: true as const }));
        const actions = createWorkflowDefinitionActions({
          artifactStore: { read: vi.fn(async () => artifactWith(header)), delete: remove } as never,
        });
        await expect(actions.delete({ definitionId })).rejects.toMatchObject({ code: 'content_unavailable' });
        expect(remove).not.toHaveBeenCalled();
      }
    });

    it('deletes through the incumbent Artifact owner when the exact header matches the row', async () => {
      const remove = vi.fn(async () => ({ ok: true as const }));
      const actions = createWorkflowDefinitionActions({
        artifactStore: { read: vi.fn(async () => artifactWith(headerFor(definitionId, { headerVersion: 2, bodyVersion: 2 }))), delete: remove } as never,
      });
      await expect(actions.delete({ definitionId })).resolves.toEqual({ deleted: true, definitionId });
      expect(remove).toHaveBeenCalledWith(definitionId);
    });
  });
});
