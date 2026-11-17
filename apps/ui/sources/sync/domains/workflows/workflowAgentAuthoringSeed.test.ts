import { afterEach, describe, expect, it } from 'vitest';

import { seedAndOpenNewSession } from '@/components/sessions/new/newSessionSeedComposer';
import { readNewSessionDraftFromRepository } from '@/components/sessions/composer/newSessionDraftRepositoryAdapter';
import { resetSessionDraftRepositoryForTests } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { buildNewSessionAuthoringDraftFromPersistedDraft } from '@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters';

import { buildWorkflowAgentAuthoringSeed } from './workflowAgentAuthoringSeed';

afterEach(() => resetSessionDraftRepositoryForTests());

/**
 * The visible composer text each agent-authoring entry prefills (04 §4.7, 07 S22). The person
 * reads and edits it as their own turn, so it is the plain lead they continue; the workflow's id,
 * revision and the Actions to use travel beside it as the current-screen context the agent reads.
 */
describe('buildWorkflowAgentAuthoringSeed', () => {
    it('Create shows only the lead the person continues, and carries the authoring guidance as context', () => {
        const seed = buildWorkflowAgentAuthoringSeed({ kind: 'create' });
        expect(seed.prompt).toBe('Help me create a workflow that ');
        expect(seed.currentUiContext?.entity?.summary).toContain('workflow.validate');
    });

    it('opens Edit in the composer with a continuable lead and exact Workflow context kept out of the text', () => {
        const scope = Object.freeze({ serverId: 'server-a', accountId: 'account-a' });
        const draftId = '00000000-0000-4000-8000-000000000042';
        const seed = buildWorkflowAgentAuthoringSeed({ kind: 'edit', name: 'Morning digest',
            definitionId: '2e17b7b7-1977-4b5b-9957-781ec43c5b54', revision: { headerVersion: 4, bodyVersion: 7 } });
        expect(seed.prompt).toBe('Help me change Morning digest: ');
        expect(seed.prompt).not.toMatch(/2e17b7b7|workflow\.|revision/u);
        expect(seed.currentUiContext?.entity).toMatchObject({
            kind: 'workflow', label: 'Morning digest',
            reference: { definitionId: '2e17b7b7-1977-4b5b-9957-781ec43c5b54', revision: { headerVersion: 4, bodyVersion: 7 } },
        });
        expect(seed.currentUiContext?.entity?.summary).toContain('workflow.definition.edit');
        const outcome = seedAndOpenNewSession({
            seed,
            scope, isCurrent: () => true, navigateToNewSession: () => undefined, createDraftId: () => draftId,
        });
        expect(outcome.kind).toBe('opened');
        const draft = readNewSessionDraftFromRepository({ scope, draftId });
        expect(draft).toMatchObject({
            input: 'Help me change Morning digest: ',
            composerAttachmentSeeds: [{ pluginId: 'happier.app-context', attachmentLocalId: 'current-screen' }],
        });
        // The New Session composer opens from this hydrated authoring draft's text.
        expect(draft && buildNewSessionAuthoringDraftFromPersistedDraft(draft).displayText).toBe('Help me change Morning digest: ');
    });

    it('Make this repeatable refers to this conversation without raw session or Home ids', () => {
        const { prompt } = buildWorkflowAgentAuthoringSeed({
            kind: 'repeatable',
            sessionId: 'session-raw-id',
            serverId: 'srv_raw_home',
            message: { id: 'message-raw-id', text: 'The successful audit' },
        });
        expect(prompt).toContain('The successful audit');
        expect(prompt).not.toContain('session-raw-id');
        expect(prompt).not.toContain('srv_raw_home');
        expect(prompt).not.toContain('message-raw-id');
    });
});
