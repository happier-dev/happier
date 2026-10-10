import { describe, expect, it } from 'vitest';
import {
  SessionBoardMutationV1Schema,
  isSessionBoardMutationResultCorresponding,
} from './mutations.js';
import { SessionSurfaceItemIdSchema, SessionBoardTabIdSchema } from './ids.js';

describe('Board sealed mutation contract', () => {
  const content = { t: 'encrypted', c: 'ciphertext' };
  it('reserves only the shared layout record address from item identities', () => {
    expect(SessionSurfaceItemIdSchema.safeParse('layout').success).toBe(false);
    for (const id of ['Layout', 'layout-note', 'note']) expect(SessionSurfaceItemIdSchema.parse(id)).toBe(id);
    expect(SessionBoardTabIdSchema.parse('layout')).toBe('layout');
    expect(SessionBoardMutationV1Schema.safeParse({ operation: 'upsert_item', itemId: 'layout', itemContent: content,
      expectedItemRevision: null, placement: { layoutContent: content, expectedLayoutRevision: null } }).success).toBe(false);
  });
  it('does not accept another operation or item acknowledgement as mutation success', () => {
    const request = SessionBoardMutationV1Schema.parse({ operation: 'upsert_item', itemId: 'Note', itemContent: content, expectedItemRevision: null, placement: { layoutContent: content, expectedLayoutRevision: null } });
    const result = { operation: 'upsert_item' as const, itemId: 'Note', outcome: 'created' as const, itemRevision: 'revision', layoutRevision: 'layout' };
    expect(isSessionBoardMutationResultCorresponding(request, result)).toBe(true);
    const { layoutRevision: _layoutRevision, ...itemOnlyResult } = result;
    expect(isSessionBoardMutationResultCorresponding(request, itemOnlyResult)).toBe(false);
    expect(isSessionBoardMutationResultCorresponding({ operation: 'upsert_item', itemId: 'Note', itemContent: content,
      expectedItemRevision: 'revision' }, itemOnlyResult)).toBe(true);
    expect(isSessionBoardMutationResultCorresponding(request, { ...result, itemId: 'Other' })).toBe(false);
    expect(isSessionBoardMutationResultCorresponding(request, { operation: 'update_layout', outcome: 'updated', layoutRevision: 'layout' })).toBe(false);
  });
  it('admits transcript creation without layout while preserving atomic Board creation', () => {
    const request = { operation: 'upsert_item', itemId: 'Note', itemContent: content, expectedItemRevision: null, placement: { layoutContent: content, expectedLayoutRevision: null } };
    expect(SessionBoardMutationV1Schema.parse(request)).toEqual(request);
    const { placement: _placement, ...withoutPlacement } = request;
    expect(SessionBoardMutationV1Schema.safeParse(withoutPlacement).success).toBe(true);
    expect(SessionBoardMutationV1Schema.safeParse({ ...withoutPlacement, destination: 'both' }).success).toBe(false);
    expect(SessionBoardMutationV1Schema.safeParse({ operation: 'remove_item', itemId: 'Note', expectedItemRevision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ' }).success).toBe(true);
  });
  it('rejects unconditional writes, caller-owned addresses and opaque revision substitutes', () => {
    for (const request of [
      { operation: 'update_layout', layoutContent: content },
      { operation: 'update_layout', layoutContent: content, expectedLayoutRevision: null, namespace: 'other' },
      { operation: 'update_layout', layoutContent: { ...content, ciphertext: 'other' }, expectedLayoutRevision: null },
      { operation: 'update_layout', layoutContent: 'ciphertext', expectedLayoutRevision: null },
      { operation: 'remove_item', itemId: 'Note', expectedItemRevision: '1', layoutContent: content, expectedLayoutRevision: '1' },
    ]) expect(SessionBoardMutationV1Schema.safeParse(request).success).toBe(false);
  });
  it('rejects a plaintext update whose semantic destination contradicts stored intent', () => {
    const item = { v: 1, destination: 'board', title: 'Note', frame: 'card', height: { mode: 'auto', fallback: 'regular' },
      source: { kind: 'declarative', document: { version: 1, root: { kind: 'markdown', text: 'Hello' } } } };
    expect(SessionBoardMutationV1Schema.safeParse({ operation: 'upsert_item', itemId: 'note',
      expectedItemRevision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ', destination: 'transcript', itemContent: { t: 'plain', v: item } }).success).toBe(false);
  });
  it('carries an exact existing-item participant for an atomic layout placement', () => {
    const revision = 'ssr1.AAAACHN5c3JlY18xAAAAAQ';
    const request = {
      operation: 'update_layout',
      layoutContent: content,
      expectedLayoutRevision: revision,
      itemPlacementParticipant: {
        itemId: 'Note',
        expectedItemRevision: revision,
      },
    };
    expect(SessionBoardMutationV1Schema.parse(request)).toEqual(request);
    for (const invalidParticipant of [
      null,
      { itemId: 'Note' },
      { itemId: 'layout', expectedItemRevision: revision },
      { itemId: 'Note', expectedItemRevision: null },
      { itemId: 'Note', expectedItemRevision: revision, authority: 'client' },
    ]) {
      expect(SessionBoardMutationV1Schema.safeParse({
        ...request,
        itemPlacementParticipant: invalidParticipant,
      }).success).toBe(false);
    }
  });
});
