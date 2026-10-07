import type { core } from 'zod';
import { zodSchemaToJsonSchemaObject } from '../actions/actionInputJsonSchema.js';
import { SessionRunStreamReadEnvelopeSchema } from '../sessions/control/contract.js';
import { describe, expect, it } from 'vitest';
import { ScmDiffSummaryResultEditSchema } from './diffSummaryResult.js';

describe('saved commit-plan edit admission', () => {
  it('admits explicit group edits and closes every mutation envelope', () => {
    const move = { kind: 'moveCommitChanges', changeRefs: ['exact-change'], target: { kind: 'newGroup',
      group: { id: 'group', message: 'fix: change', rationale: '' } } };
    expect(ScmDiffSummaryResultEditSchema.safeParse(move).success).toBe(true);
    expect(ScmDiffSummaryResultEditSchema.safeParse({ ...move, accepted: true }).success).toBe(false);
    expect(ScmDiffSummaryResultEditSchema.safeParse({ ...move, target: { ...move.target, command: 'commit' } }).success).toBe(false);
    expect(ScmDiffSummaryResultEditSchema.safeParse({ ...move, target: { ...move.target,
      group: { ...move.target.group, changeRefs: ['hidden-change'] } } }).success).toBe(false);
    expect(ScmDiffSummaryResultEditSchema.safeParse({ kind: 'editCommitGroup', groupId: 'group', rationale: '' }).success).toBe(true);
    expect(ScmDiffSummaryResultEditSchema.safeParse({ kind: 'editCommitGroup', groupId: 'group' }).success).toBe(false);
    expect(ScmDiffSummaryResultEditSchema.safeParse({ kind: 'editCommitGroup', groupId: 'group', message: ' ' }).success).toBe(false);
  });

  it('rejects repeated move references and group identities before owner mutation', () => {
    expect(ScmDiffSummaryResultEditSchema.safeParse({ kind: 'moveCommitChanges', changeRefs: ['change', 'change'],
      target: { kind: 'leftOut' } }).success).toBe(false);
    expect(ScmDiffSummaryResultEditSchema.safeParse({ kind: 'reorderCommitGroups', groupIds: ['group', 'group'] }).success).toBe(false);
    expect(ScmDiffSummaryResultEditSchema.safeParse({ kind: 'mergeCommitGroups', groupIds: ['group', 'group'], targetGroupId: 'group' }).success).toBe(false);
  });
});

describe('SCM result edits in the composed session control projection', () => {
  it('keeps the edit union inline and stop-id arrays concrete in both dialects', () => {
    for (const target of ['draft-7', 'draft-2020-12'] as const) {
      const projections = [
        zodSchemaToJsonSchemaObject(SessionRunStreamReadEnvelopeSchema, { target }),
        SessionRunStreamReadEnvelopeSchema.toJSONSchema({ io: 'input', target, unrepresentable: 'any' }),
      ];
      for (const projection of projections) {
        const schema = projection as core.JSONSchema.JSONSchema;
        const definitions = (schema.$defs ?? schema.definitions) as Record<string, core.JSONSchema.JSONSchema>;
        const object = (node: unknown): core.JSONSchema.JSONSchema => {
          if (!node || typeof node !== 'object') throw new Error('Expected a projected schema object');
          return node as core.JSONSchema.JSONSchema;
        };
        const reorder = Object.values(definitions).find((node) => {
          const kind = node.properties?.kind;
          return typeof kind === 'object' && kind.const === 'reorderStops';
        });
        const stopIds = object(reorder?.properties?.stopIds);
        const reference = stopIds.$ref ?? stopIds.allOf?.[0]?.$ref;
        if (!reference) throw new Error('Expected the shared stop-id array reference');
        expect(definitions[reference.slice(reference.lastIndexOf('/') + 1)]).toEqual({
          type: 'array', minItems: 1, items: { $ref: expect.any(String) },
        });
        const visit = (node: unknown, actionKind: string): core.JSONSchema.JSONSchema | undefined => {
          if (!node || typeof node !== 'object') return undefined;
          const current = object(node);
          const kind = current.properties?.t;
          if (typeof kind === 'object' && kind.const === actionKind) return current;
          for (const child of Object.values(current)) {
            if (Array.isArray(child)) {
              for (const item of child) { const found = visit(item, actionKind); if (found) return found; }
            } else { const found = visit(child, actionKind); if (found) return found; }
          }
          return undefined;
        };
        const action = visit(schema, 'editScmDiffSummaryResult');
        const args = object(action?.properties?.args);
        expect(args.properties?.edit).toEqual({ oneOf: expect.arrayContaining([{ $ref: expect.any(String) }]) });
        const refine = visit(schema, 'refineScmDiffSummary');
        expect(refine?.properties?.args).toMatchObject({ type: 'object' });
      }
    }
  });
});
