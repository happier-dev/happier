import { describe, expect, it } from 'vitest';
import { buildPromptPickerRows } from '../promptPickerRows';

describe('prompt picker inventory', () => {
    it('groups one row per document, admits token badges by composer and filters sent text locally', () => {
        const documents = [
            { artifactId: 'fav', title: 'Favourite', folderId: null, tags: [], favorite: true, updatedAtMs: 1 },
            { artifactId: 'doc', title: 'Library test', folderId: null, tags: ['debug'], favorite: false, updatedAtMs: 2 },
        ];
        const invocations = [
            { id: 'global', token: '/test', title: 'Alias', target: { kind: 'doc' as const, artifactId: 'doc' }, behavior: 'insert' as const, allowArgs: true, availableIn: 'global' as const },
            { id: 'session', token: '/session', title: 'Alias two', target: { kind: 'doc' as const, artifactId: 'doc' }, behavior: 'insert' as const, allowArgs: true, availableIn: 'session_only' as const },
        ];
        const input = { documents, invocations, builtIns: [{ token: '/builtin', title: 'Built in', body: 'test body', allowArgs: true }],
            history: [{ serverId: 'home', sessionId: 's', messageId: 'm', seq: 2, createdAtMs: 1, text: 'A previous test message' }], sessionId: null, query: '' };
        const rows = buildPromptPickerRows(input);
        expect(rows.map((row) => [row.kind, row.group])).toEqual([['doc', 'favorites'], ['doc', 'library'], ['builtIn', 'library'], ['history', 'history']]);
        expect(rows.find((row) => row.id === 'doc:doc')?.tokens).toEqual(['/test']);
        expect(buildPromptPickerRows({ ...input, sessionId: 'live' }).find((row) => row.id === 'doc:doc')?.tokens).toEqual(['/test', '/session']);
        expect(buildPromptPickerRows({ ...input, query: 'previous' }).map((row) => row.kind)).toEqual(['history']);
        expect(buildPromptPickerRows({ ...input, query: '/test' }).map((row) => row.id)).toEqual(['doc:doc']);
    });
});
