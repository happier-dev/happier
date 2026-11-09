import { describe, expect, it } from 'vitest';
import { migrateLegacySessionDraftScope, SESSION_DRAFT_RECORD_UNREAD, sessionDraftRowKey, sessionDraftStoredRecordsEqual } from './sessionDraftSerializedScope';

const scopeKey = 'session-drafts-repository-v1:scope';

describe('draft record layout', () => {
    it('moves every replica of a whole-scope record into its own record and keeps only envelope fields', () => {
        const legacy = JSON.stringify({ v: 2, ordinaryEntryDraftId: 'entry', replicas: { a: { text: 'a' }, b: { text: 'b' } } });
        expect(Object.fromEntries(migrateLegacySessionDraftScope(scopeKey, legacy, () => undefined)!)).toEqual({
            [sessionDraftRowKey(scopeKey, 'a')]: JSON.stringify({ text: 'a' }),
            [sessionDraftRowKey(scopeKey, 'b')]: JSON.stringify({ text: 'b' }),
            [scopeKey]: JSON.stringify({ ordinaryEntryDraftId: 'entry', v: 3 }),
        });
        expect(migrateLegacySessionDraftScope(scopeKey, JSON.stringify({ v: 2, replicas: {} }), () => undefined)!.get(scopeKey)).toBeUndefined();
    });

    it('keeps an existing equal record and refuses to overwrite a different one', () => {
        const legacy = JSON.stringify({ v: 2, replicas: { a: { text: 'a' } } });
        const row = sessionDraftRowKey(scopeKey, 'a');
        expect(migrateLegacySessionDraftScope(scopeKey, legacy, (key) => key === row ? '{ "text": "a" }' : undefined)!.has(row)).toBe(false);
        expect(migrateLegacySessionDraftScope(scopeKey, legacy, (key) => key === row ? '{"text":"newer"}' : undefined)).toBeNull();
        expect(migrateLegacySessionDraftScope(scopeKey, legacy, (key) => key === row ? SESSION_DRAFT_RECORD_UNREAD : undefined)).toBeNull();
    });

    it('makes a v1 replica without a base explicit, because records omit only a base equal to the local document', () => {
        const legacy = JSON.stringify({ v: 1, replicas: { a: { localRawDocument: { text: 'a' }, pendingFieldMutations: [] } } });
        expect(JSON.parse(migrateLegacySessionDraftScope(scopeKey, legacy, () => undefined)!.get(sessionDraftRowKey(scopeKey, 'a'))!))
            .toEqual({ localRawDocument: { text: 'a' }, pendingFieldMutations: [], baseRawDocument: null });
    });

    it('treats v2 duplicate omission as the same stored draft', () => {
        const document = { composer: { text: { mutationId: 'm1', value: 'draft' } } };
        const full = JSON.stringify({ localRawDocument: document, baseRawDocument: document,
            pendingFieldMutations: [{ path: { kind: 'composer', field: 'text' }, field: document.composer.text, mutationId: 'm1' }] });
        const compact = JSON.stringify({ localRawDocument: document,
            pendingFieldMutations: [{ path: { kind: 'composer', field: 'text' }, mutationId: 'm1' }] });
        expect(sessionDraftStoredRecordsEqual(full, compact)).toBe(true);
        expect(sessionDraftStoredRecordsEqual(full, undefined)).toBe(false);
        expect(sessionDraftStoredRecordsEqual('broken', compact)).toBe(false);
    });
});
