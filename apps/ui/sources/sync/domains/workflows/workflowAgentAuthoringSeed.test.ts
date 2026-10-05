import { describe, expect, it } from 'vitest';

import { buildWorkflowAgentAuthoringSeed } from './workflowAgentAuthoringSeed';

/**
 * The visible composer text each agent-authoring entry prefills (04 §4.7, 07 S22). The person
 * reads and edits it as their own turn, so it says the task in plain words, ends where they
 * type, and names only the facts and Actions 04's seed builder lists.
 */
describe('buildWorkflowAgentAuthoringSeed', () => {
    it('Create ends with "Help me create a workflow that " and names only workflow.validate', () => {
        const { prompt } = buildWorkflowAgentAuthoringSeed({ kind: 'create' });
        expect(prompt.endsWith('Help me create a workflow that ')).toBe(true);
        expect(prompt).toContain('workflow.validate');
        expect(prompt).not.toContain('workflow.definition');
    });

    it('Edit names the workflow, its id and revision in plain words and ends with "Help me change {workflow}: "', () => {
        const { prompt } = buildWorkflowAgentAuthoringSeed({
            kind: 'edit',
            name: 'Morning digest',
            definitionId: '2e17b7b7-1977-4b5b-9957-781ec43c5b54',
            revision: { headerVersion: 4, bodyVersion: 7 },
        });
        expect(prompt.endsWith('Help me change Morning digest: ')).toBe(true);
        expect(prompt).toContain('2e17b7b7-1977-4b5b-9957-781ec43c5b54');
        expect(prompt).toContain('workflow.definition.edit');
        expect(prompt).toContain('workflow.definition.update');
        expect(prompt).toMatch(/4\D+7/u);
        // No serialized revision object.
        expect(prompt).not.toContain('{');
        expect(prompt).not.toContain('headerVersion');
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
