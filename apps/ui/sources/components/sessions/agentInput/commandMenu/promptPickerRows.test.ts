import { describe, expect, it } from 'vitest';
import type { PromptInvocationEntryV1 } from '@happier-dev/protocol/prompts/library/promptInvocationsV1';
import { buildPromptPickerRows } from './promptPickerRows';

describe('qualified prompt picker document association', () => {
    it('does not associate a foreign invocation with an identical current-Home Artifact id', () => {
        const invocations: PromptInvocationEntryV1[] = ['alpha', 'bravo'].map(serverId => ({ id: serverId, token: `/${serverId}`, title: serverId,
            target: { kind: 'doc', artifactId: 'same-id', serverId }, behavior: 'insert', allowArgs: false, availableIn: 'global' }));
        const input = { serverId: 'alpha', documents: [{ artifactId: 'same-id', title: 'Alpha document', tags: [], favorite: false, folderId: null, updatedAtMs: 1 }],
            invocations, builtIns: [], history: [], sessionId: null, query: '' };
        const rows = buildPromptPickerRows(input);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.tokens).toEqual(['/alpha']);
        expect(buildPromptPickerRows({ ...input, query: '/bravo' })).toEqual([]);
    });
});
