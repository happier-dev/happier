import { describe, expect, it } from 'vitest';
import * as authoring from './workflowAuthoring';
import { createWorkflowEditorDraft } from './workflowEditorDraft';

const scope = { serverId: 'home-a', accountId: 'account-a' };
const draft = createWorkflowEditorDraft({ draftId: 'draft-a', name: 'Review', blocks: [{
    kind: 'step', id: 'review', document: { text: 'Keep this prompt', references: [], attachments: [] },
    input: [], result: { kind: 'text' },
}] });
const context = { scope, draft, editable: true, whereMachineId: 'machine-a',
    candidates: [{ sessionId: 'session-a', machineId: 'machine-a', label: 'Existing conversation' }] };
const request = { scope, draftId: draft.draftId, stepId: 'review', address: { serverId: scope.serverId, sessionId: 'session-a' } };

describe('Workflow conversation binding owner', () => {
    it('changes only the addressed conversation, with the current candidate machine', () => {
        const bound = authoring.bindWorkflowSessionConversation(context, request);
        expect(bound.status).toBe('applied');
        if (bound.status !== 'applied') throw new Error('Expected binding');
        expect(bound.draft).toEqual({ ...draft, blocks: [{ ...draft.blocks[0], execution: {
            conversation: { kind: 'existing_session', sessionId: 'session-a', machineId: 'machine-a' },
        } }] });
        expect(authoring.bindWorkflowSessionConversation({ ...context, draft: bound.draft }, request).status).toBe('unchanged');
    });

    it('refuses another Home or Account, a missing candidate, changed Where, deleted step and read-only draft', () => {
        for (const denied of [
            { ...request, scope: { ...scope, serverId: 'home-b' }, address: { ...request.address, serverId: 'home-b' } },
            { ...request, scope: { ...scope, accountId: 'account-b' } },
            { ...request, address: { ...request.address, serverId: 'home-b' } },
            { ...request, address: { ...request.address, sessionId: 'missing' } },
            { ...request, draftId: 'another-draft' },
            { ...request, stepId: 'deleted' },
        ]) expect(authoring.bindWorkflowSessionConversation(context, denied).status).toBe('refused');
        expect(authoring.bindWorkflowSessionConversation({ ...context, whereMachineId: 'machine-b' }, request))
            .toMatchObject({ status: 'refused', reason: 'workflow_where_machine_mismatch' });
        expect(authoring.bindWorkflowSessionConversation({ ...context, candidates: [] }, request).status).toBe('refused');
        expect(authoring.bindWorkflowSessionConversation({ ...context, editable: false }, request).status).toBe('refused');
    });

    it('uses the same admission for the workflow default and permits authoring before Where is chosen', () => {
        const result = authoring.bindWorkflowSessionConversation({ ...context, whereMachineId: null }, { ...request, stepId: null });
        expect(result.status).toBe('applied');
        if (result.status !== 'applied') throw new Error('Expected default binding');
        expect(result.draft.blocks).toBe(draft.blocks);
        expect(result.draft.defaults.conversation).toEqual({ kind: 'existing_session', sessionId: 'session-a', machineId: 'machine-a' });
    });
});
