import { describe, expect, it, vi } from 'vitest';
import { createWorkflowDefinitionActions, type WorkflowDefinitionArtifactOperations } from './workflowDefinitions.js';
import { WorkflowDefinitionV1Schema } from '../../workflows/workflowV1.js';
import type { PluginJsonSchemaV2 } from '../../plugins/contributions/jsonSchema.js';

const definitionId = '11111111-1111-4111-8111-111111111111';
const revision = { headerVersion: 1, bodyVersion: 1 };
const metadata = { title: 'Ordered result' };
const first = { issues: { type: 'string' }, commits: { type: 'string' } } satisfies NonNullable<PluginJsonSchemaV2['properties']>;
const reordered = { commits: { type: 'string' }, issues: { type: 'string' } } satisfies NonNullable<PluginJsonSchemaV2['properties']>;

function definition(schema: PluginJsonSchemaV2) {
  return WorkflowDefinitionV1Schema.parse({ version: 1, defaults: {}, blocks: [{ kind: 'wait', id: 'review',
    document: { text: 'Review', references: [], attachments: [] }, result: { kind: 'json', schema } }] });
}

function harness(existing: ReturnType<typeof definition>, initiallyPresent = true) {
  let present = initiallyPresent;
  let stored = existing;
  // Artifact storage is the boundary; normalization and authoring comparison remain real.
  const update = vi.fn<WorkflowDefinitionArtifactOperations['update']>(async input => {
    stored = WorkflowDefinitionV1Schema.parse(JSON.parse(input.body).definition);
    return { ok: true, revision: { headerVersion: 2, bodyVersion: 2 } };
  });
  const create = vi.fn<WorkflowDefinitionArtifactOperations['create']>(async () => {
    present = true;
    throw new Error('lost_create_response');
  });
  const owner = createWorkflowDefinitionActions({ artifactStore: {
    read: async () => present ? { artifactId: definitionId, ownerAccountId: 'owner', access: 'owner', revision,
      header: { kind: 'workflow-definition.v1', definitionId, revision, metadata },
      body: JSON.stringify({ kind: 'workflow-definition.v1', definition: stored }) } : null,
    list: async () => ({ items: [] }), create, update, delete: async () => ({ ok: true }),
  }, encodeListCursor: () => '' });
  return { owner, update, create, stored: () => stored };
}

describe('Workflow authoring content persistence', () => {
  it.each(['nested array', 'local reference', 'composition'] as const)(
    'saves an order-only declared field edit inside a %s schema', async kind => {
      const schema = (properties: NonNullable<PluginJsonSchemaV2['properties']>): PluginJsonSchemaV2 => {
        const object: PluginJsonSchemaV2 = { type: 'object', properties };
        if (kind === 'nested array') return { type: 'object', properties: { rows: { type: 'array', items: object } } };
        if (kind === 'local reference') return { $ref: '#/$defs/row', $defs: { row: object } };
        return { anyOf: [object, { type: 'null' }] };
      };
      const kit = harness(definition(schema(first)));
      const next = definition(schema(reordered));
      const saved = await kit.owner.update({ definitionId, expectedRevision: revision, metadata, definition: next }, undefined, { surface: 'ui' });
      expect(saved.revision).toEqual({ headerVersion: 2, bodyVersion: 2 });
      expect(JSON.stringify(kit.stored())).toBe(JSON.stringify(next));
      expect(kit.update).toHaveBeenCalledOnce();
    },
  );

  it('keeps ordinary object, schema keyword and literal default key reordering as a no-op', async () => {
    const original = definition({ type: 'object', properties: first,
      default: { properties: { issues: 'one', commits: 'two' } } });
    const kit = harness(original);
    const next = { blocks: definition({
      default: { properties: { commits: 'two', issues: 'one' } }, properties: first, type: 'object',
    }).blocks, defaults: original.defaults, version: original.version };
    const saved = await kit.owner.update({ definitionId, expectedRevision: revision, metadata, definition: next }, undefined, { surface: 'ui' });
    expect(saved.revision).toEqual(revision);
    expect(kit.update).not.toHaveBeenCalled();
  });

  it.each([true, false])('refuses a same-id create with different declared order (already present: %s)', async present => {
    const kit = harness(definition({ type: 'object', properties: first }), present);
    await expect(kit.owner.create({ definitionId, metadata, definition: definition({ type: 'object', properties: reordered }) },
      undefined, { surface: 'ui' })).rejects.toMatchObject({ code: 'currentness_conflict' });
    expect(kit.update).not.toHaveBeenCalled();
    expect(kit.create).toHaveBeenCalledTimes(present ? 0 : 1);
  });

  it.each([true, false])('rejoins identical authored content after create (already present: %s)', async present => {
    const original = definition({ type: 'object', properties: first });
    const kit = harness(original, present);
    const saved = await kit.owner.create({ definitionId, metadata, definition: original }, undefined, { surface: 'ui' });
    expect(saved.revision).toEqual(revision);
    expect(kit.update).not.toHaveBeenCalled();
    expect(kit.create).toHaveBeenCalledTimes(present ? 0 : 1);
  });
});
