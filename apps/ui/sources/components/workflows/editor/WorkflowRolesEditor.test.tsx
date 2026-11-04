import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { applyWorkflowDefinitionEditsV1, type WorkflowDefinitionEditOpV1 } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createWorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { WorkflowRolesEditor } from './WorkflowRolesEditor';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

afterEach(standardCleanup);

it('dispatches canonical role edits for the controlled editor and preserves the rest of the draft', async () => {
    const batches: Array<readonly WorkflowDefinitionEditOpV1[]> = [];
    const original = createWorkflowEditorDraft({ draftId: 'roles-draft', name: 'Review' });
    let current = original;
    function Editor() {
        const [draft, setDraft] = React.useState(original);
        return <WorkflowRolesEditor draft={draft} prefix="roles" onEdit={(ops) => {
            batches.push(ops);
            const result = applyWorkflowDefinitionEditsV1(draft, ops);
            if (!result.ok) throw new Error('Expected role edit');
            current = result.draft;
            setDraft(result.draft);
        }} />;
    }
    const screen = await renderScreen(<Editor />);
    await act(async () => { screen.tree.root.findByType(DropdownMenu).props.onSelect('new-inline-role'); });
    expect(batches[0]).toMatchObject([{ kind: 'upsert_role', role: { roleId: 'workflow_role_1', instructions: '', runsAs: { kind: 'session' } } }]);
    await act(async () => { screen.changeTextByTestId('roles-role-workflow_role_1-name', 'Security reviewer'); });
    expect(batches[1]).toMatchObject([{ kind: 'upsert_role', role: { roleId: 'workflow_role_1', name: 'Security reviewer' } }]);
    expect(current.roles).toMatchObject([{ roleId: 'workflow_role_1', name: 'Security reviewer' }]);
    expect(current.blocks).toBe(original.blocks);
    expect(current.defaults).toBe(original.defaults);
    await act(async () => { await screen.pressByTestIdAsync('roles-role-workflow_role_1-reset'); });
    expect(batches.at(-1)).toEqual([{ kind: 'remove_role', roleId: 'workflow_role_1' }]);
    expect(current.roles).toEqual([]);
});

it('names a second_opinion role through the shared role display name', async () => {
    const draft = { ...createWorkflowEditorDraft({ draftId: 'roles-review', name: 'Review' }), roles: [{
        roleId: 'second_opinion', name: 'Second opinion', instructions: 'Check the work', runsAs: { kind: 'session' as const },
    }] };
    const screen = await renderScreen(<WorkflowRolesEditor draft={draft} prefix="roles" onEdit={() => {}} />);
    expect(screen.getTextContent()).toContain('Independent check');
    expect(screen.getTextContent()).not.toContain('Second opinion');
});
