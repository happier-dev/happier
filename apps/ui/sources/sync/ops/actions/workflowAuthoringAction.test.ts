import { afterEach, describe, expect, it } from 'vitest';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';

const disposers: Array<() => void> = [];
afterEach(async () => { await standardCleanup(); for (const dispose of disposers.splice(0).reverse()) dispose(); });

describe('mounted Workflow conversation Action', () => {
    it('shares UI/agent admission, checks the current draft, and retires without storing another draft', async () => {
        const boundary = await serveActionHomes({ homes: [{ key: 'home', serverUrl: 'https://workflow-action.test', accountId: 'account-a' }], route: () => undefined });
        disposers.push(() => boundary.dispose());
        const [{ registerWorkflowConversationBindingOwner }, { createWorkflowEditorDraft }, { createDefaultActionExecutor }] = await Promise.all([
            import('./workflowAuthoringAction'), import('@/sync/domains/workflows/workflowEditorDraft'), import('./defaultActionExecutor'),
        ]);
        const scope = { serverId: boundary.homes.home!.id, accountId: 'account-a' };
        const draft = createWorkflowEditorDraft({ draftId: 'draft', name: 'Review', blocks: [{ kind: 'step', id: 'review',
            document: { text: 'Keep this prompt', references: [], attachments: [] }, input: [], result: { kind: 'text' } }] });
        let current = { scope, draft, editable: true, whereMachineId: 'machine-a', candidates: [{ sessionId: 'session', machineId: 'machine-a', label: 'Review' }] };
        const changes: typeof draft[] = [];
        const retire = registerWorkflowConversationBindingOwner({ getContext: () => current, onChange: next => { changes.push(next); } });
        disposers.push(retire);
        const input = { scope, draftId: draft.draftId, stepId: 'review', address: { serverId: scope.serverId, sessionId: 'session' } };
        const executor = createDefaultActionExecutor();
        for (const surface of ['ui', 'agent'] as const) {
            expect(await executor.execute('workflow.authoring.conversation.bind', input, { surface, authority: 'account_automation', serverId: scope.serverId }))
                .toEqual({ ok: true, result: { status: 'applied' } });
        }
        expect(changes).toEqual([changes[0], changes[0]]);
        expect(changes[0]).toEqual({ ...draft, blocks: [{ ...draft.blocks[0], execution: {
            conversation: { kind: 'existing_session', sessionId: 'session', machineId: 'machine-a' },
        } }] });
        current = { ...current, whereMachineId: 'machine-b' };
        expect(await executor.execute('workflow.authoring.conversation.bind', input, { surface: 'agent', authority: 'account_automation', serverId: scope.serverId }))
            .toEqual({ ok: true, result: { status: 'refused', reason: 'workflow_where_machine_mismatch' } });
        current = { ...current, whereMachineId: 'machine-a', candidates: [] };
        expect(await executor.execute('workflow.authoring.conversation.bind', input, { surface: 'ui', serverId: scope.serverId }))
            .toEqual({ ok: true, result: { status: 'refused', reason: 'workflow_session_unavailable' } });
        expect(changes).toHaveLength(2);
        retire();
        expect(await executor.execute('workflow.authoring.conversation.bind', input, { surface: 'agent', authority: 'account_automation', serverId: scope.serverId }))
            .toEqual({ ok: true, result: { status: 'unavailable' } });
        expect(boundary.requests).toEqual([]);
    });

    it('does not let another invocation Home or Account address the mounted draft', async () => {
        const boundary = await serveActionHomes({ homes: [
            { key: 'owner', serverUrl: 'https://workflow-owner.test', accountId: 'account-a' },
            { key: 'other', serverUrl: 'https://workflow-other.test', accountId: 'account-b' },
        ], route: () => undefined });
        disposers.push(() => boundary.dispose());
        const [{ registerWorkflowConversationBindingOwner }, { createWorkflowEditorDraft }, { createDefaultActionExecutor }] = await Promise.all([
            import('./workflowAuthoringAction'), import('@/sync/domains/workflows/workflowEditorDraft'), import('./defaultActionExecutor'),
        ]);
        const scope = { serverId: boundary.homes.owner!.id, accountId: 'account-a' };
        const draft = createWorkflowEditorDraft({ draftId: 'draft', name: 'Review', blocks: [{ kind: 'step', id: 'review',
            document: { text: 'Keep this prompt', references: [], attachments: [] }, input: [], result: { kind: 'text' } }] });
        const changes: typeof draft[] = [];
        disposers.push(registerWorkflowConversationBindingOwner({ getContext: () => ({ scope, draft, editable: true,
            whereMachineId: 'machine', candidates: [{ sessionId: 'session', machineId: 'machine', label: 'Review' }] }), onChange: next => { changes.push(next); } }));
        const input = { scope, draftId: draft.draftId, stepId: 'review', address: { serverId: scope.serverId, sessionId: 'session' } };
        const executor = createDefaultActionExecutor();
        expect(await executor.execute('workflow.authoring.conversation.bind', input, { surface: 'agent', authority: 'account_automation', serverId: boundary.homes.other!.id }))
            .toEqual({ ok: true, result: { status: 'refused', reason: 'workflow_binding_scope_mismatch' } });
        boundary.switchAccount('owner', 'account-b');
        expect(await executor.execute('workflow.authoring.conversation.bind', input, { surface: 'agent', authority: 'account_automation', serverId: scope.serverId }))
            .toEqual({ ok: true, result: { status: 'refused', reason: 'workflow_binding_scope_mismatch' } });
        expect(changes).toEqual([]);
    });
});
