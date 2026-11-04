import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string, params?: Record<string, unknown>) =>
        (params ? `${key}:${JSON.stringify(params)}` : key) });
});

import { readFrozenSavedBy, resolveEditedByLabel } from './workflowEditedBy';

const NAMED = { name: 'Ada Chen', firstName: null, lastName: null, username: null, avatarUrl: null } as const;
const UNNAMED = { name: null, firstName: null, lastName: null, username: null, avatarUrl: null } as const;
const person = { kind: 'person', accountId: 'acct-ada' } as const;

describe('resolveEditedByLabel', () => {
    it('names another person by their Account name, never by id, wherever it shows', () => {
        for (const viewerOwnSave of ['you', 'omit'] as const) {
            expect(resolveEditedByLabel({ savedBy: person, viewerAccountId: 'acct-bo', profile: NAMED, viewerOwnSave }))
                .toBe('workflows.run.editedBy:{"name":"Ada Chen"}');
            expect(resolveEditedByLabel({ savedBy: person, viewerAccountId: 'acct-bo', profile: null, viewerOwnSave })).toBe('workflows.run.editedByPerson');
            expect(resolveEditedByLabel({ savedBy: person, viewerAccountId: 'acct-bo', profile: UNNAMED, viewerOwnSave })).toBe('workflows.run.editedByPerson');
        }
    });

    it('says "you" only where the caller keeps the viewer\'s own save (Workflow History), and omits it elsewhere', () => {
        expect(resolveEditedByLabel({ savedBy: person, viewerAccountId: 'acct-ada', profile: NAMED, viewerOwnSave: 'you' })).toBe('workflows.run.editedByYou');
        expect(resolveEditedByLabel({ savedBy: person, viewerAccountId: 'acct-ada', profile: NAMED, viewerOwnSave: 'omit' })).toBeNull();
    });

    it('says an agent saved it without claiming a person did, even for the viewer\'s Account', () => {
        for (const viewerOwnSave of ['you', 'omit'] as const) {
            expect(resolveEditedByLabel({ savedBy: { kind: 'agent', accountId: 'acct-ada' }, viewerAccountId: 'acct-ada', profile: NAMED, viewerOwnSave }))
                .toBe('workflows.run.editedByAgent');
        }
    });

    it('omits the line when the saved-by fact is absent', () => {
        expect(resolveEditedByLabel({ savedBy: null, viewerAccountId: 'acct-ada', profile: NAMED, viewerOwnSave: 'you' })).toBeNull();
        expect(resolveEditedByLabel({ savedBy: undefined, viewerAccountId: 'acct-ada', profile: NAMED, viewerOwnSave: 'you' })).toBeNull();
    });
});

describe('readFrozenSavedBy', () => {
    const base = { startedBy: 'trigger', inputs: {}, machineId: 'm' } as const;
    it('reads the authorship the accepted Run froze, for an Automation or a saved source', () => {
        expect(readFrozenSavedBy({ ...base, source: { kind: 'automation', automationId: 'a', definitionId: 'd', revision: 2, savedBy: person } } as never)).toEqual(person);
        expect(readFrozenSavedBy({ ...base, source: { kind: 'saved', definitionId: 'd', revision: 2, savedBy: person } } as never)).toEqual(person);
    });
    it('has nothing to read for inline sources, unfrozen authorship or no accepted context', () => {
        expect(readFrozenSavedBy({ ...base, source: { kind: 'inline' } } as never)).toBeNull();
        expect(readFrozenSavedBy({ ...base, source: { kind: 'automation', automationId: 'a' } } as never)).toBeNull();
        expect(readFrozenSavedBy({ ...base, source: { kind: 'saved', definitionId: 'd', revision: 2, savedBy: null } } as never)).toBeNull();
        expect(readFrozenSavedBy(null)).toBeNull();
        expect(readFrozenSavedBy(undefined)).toBeNull();
    });
});
