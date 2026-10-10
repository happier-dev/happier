import { describe, expect, it } from 'vitest';
import { PromptStackEntryV1Schema } from '../prompts/library/promptStacksV1.js';
import { applyProjectContextIntentV1, ProjectContextIntentV1Schema } from './projectContextV1.js';

const entry = (id: string, placement = 'system_append') => PromptStackEntryV1Schema.parse({
  id, ref: { kind: 'doc', artifactId: id }, placement,
});

describe('personal Project context semantic intents', () => {
  it('attaches one entry preserving retained placements, Hide, pin and unrelated fields; occupied ids conflict', () => {
    expect(ProjectContextIntentV1Schema.safeParse({ kind: 'attach', entry: entry('new', 'skill_instructions') }).success).toBe(false);
    const row = { hidden: true, pinned: true, label: 'Keep', promptStack: [entry('retained', 'provider_asset')] };
    const intent = ProjectContextIntentV1Schema.parse({ kind: 'attach', entry: { id: 'new', ref: { kind: 'doc', artifactId: 'new' } } });
    const result = applyProjectContextIntentV1(row, intent);
    expect(result).toEqual({ ok: true, changed: true, row: { ...row, promptStack: [...row.promptStack, entry('new')] } });
    if (!result.ok) return;
    expect(applyProjectContextIntentV1(result.row, intent)).toEqual({ ok: true, changed: false, row: result.row });
    expect(applyProjectContextIntentV1(result.row, { kind: 'attach', entry: { ...entry('new'), enabled: false } })).toEqual({ ok: false, errorCode: 'entry_conflict' });
    expect(applyProjectContextIntentV1(result.row, { kind: 'attach', entry: { ...entry('new'), required: true } })).toEqual({ ok: false, errorCode: 'entry_conflict' });
  });
  it('switches one retained entry through shared stack semantics without changing neighbors or Project preferences', () => {
    const row = { hidden: true, pinned: true, promptStack: [entry('a'), entry('retained', 'provider_asset')] };
    const intent = ProjectContextIntentV1Schema.parse({ kind: 'set_enabled', entryId: 'retained', enabled: false });
    const result = applyProjectContextIntentV1(row, intent);
    expect(result).toEqual({ ok: true, changed: true, row: { ...row, promptStack: [row.promptStack[0], { ...row.promptStack[1], enabled: false }] } });
    if (!result.ok) return;
    expect(result.row.promptStack[0]).toBe(row.promptStack[0]);
    expect(applyProjectContextIntentV1(result.row, intent)).toEqual({ ok: true, changed: false, row: result.row });
    expect(applyProjectContextIntentV1(row, { ...intent, entryId: 'missing' })).toEqual({ ok: false, errorCode: 'entry_not_found' });
  });
  it('detaches, reorders and clears one budget without replacing neighboring entries', () => {
    const row = { hidden: true, promptStack: [entry('a'), { ...entry('b'), maxChars: 80 }, entry('c')] };
    expect(applyProjectContextIntentV1(row, { kind: 'reorder', entryId: 'c', siblingId: 'a', position: 'before' })).toMatchObject({
      ok: true, row: { promptStack: [entry('c'), entry('a'), { ...entry('b'), maxChars: 80 }] },
    });
    expect(applyProjectContextIntentV1(row, { kind: 'set_budget', entryId: 'b', maxChars: null })).toEqual({
      ok: true, changed: true, row: { ...row, promptStack: [entry('a'), entry('b'), entry('c')] },
    });
    expect(applyProjectContextIntentV1(row, { kind: 'detach', entryId: 'b' })).toEqual({
      ok: true, changed: true, row: { ...row, promptStack: [entry('a'), entry('c')] },
    });
    expect(applyProjectContextIntentV1(row, { kind: 'reorder', entryId: 'c', siblingId: 'missing', position: 'after' })).toEqual({ ok: false, errorCode: 'entry_not_found' });
  });
});
