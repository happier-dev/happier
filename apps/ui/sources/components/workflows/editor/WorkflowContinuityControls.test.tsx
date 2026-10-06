import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

import type { WorkflowConversationSelection } from '@happier-dev/protocol/workflows/workflowReferenceV1';

/**
 * A from-step conversation continues the producer's conversation, so this
 * branch waits for that block to finish before it takes its turn. The
 * disclosure must name the block the selection actually records — never the
 * first offered producer — and must stay silent for non-continuing choices.
 */

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string, params?: Record<string, unknown>) => (
            params ? `${key}:${JSON.stringify(params)}` : key
        ),
    });
});

afterEach(async () => {
    await standardCleanup();
});

function stepBlock(id: string, prompt: string) {
    return {
        kind: 'step' as const,
        id,
        document: { text: prompt, references: [], attachments: [] },
        input: [],
        result: { kind: 'text' as const },
    };
}

async function renderControls(conversation: WorkflowConversationSelection) {
    const draftModule = await import('@/sync/domains/workflows/workflowEditorDraft');
    const draft = draftModule.createWorkflowEditorDraft({
        draftId: 'draft-1',
        name: 'Review',
        blocks: [stepBlock('producer-a', 'Check the build'), stepBlock('consumer-b', 'Report the result')],
    });
    const { WorkflowContinuityControls } = await import('./WorkflowContinuityControls');
    return renderScreen(
        <WorkflowContinuityControls
            draft={draft}
            consumerBlockId="consumer-b"
            conversation={conversation}
            workspace={{ kind: 'inherit' }}
            onChangeConversation={() => {}}
            onChangeWorkspace={() => {}}
            testIDPrefix="editor"
        />,
    );
}

describe('WorkflowContinuityControls continuation disclosure', () => {
    it('does not offer Session binding without the mounted qualified binding owner', async () => {
        const { createWorkflowEditorDraft } = await import('@/sync/domains/workflows/workflowEditorDraft');
        const { WorkflowContinuityControls } = await import('./WorkflowContinuityControls');
        const changed = vi.fn();
        const screen = await renderScreen(<WorkflowContinuityControls
            draft={createWorkflowEditorDraft({ draftId: 'draft', name: 'Review', blocks: [stepBlock('step', 'Review')] })}
            conversation={{ kind: 'shared_run' }} workspace={{ kind: 'inherit' }}
            existingSessions={[{ sessionId: 'session', machineId: 'machine', label: 'Review' }]}
            onChangeConversation={changed} onChangeWorkspace={() => {}} testIDPrefix="binding"
        />);
        const field = screen.findAll(node => node.props.testID === 'binding-conversation-field'
            && Array.isArray(node.props.items))[0]!;
        expect(field.props.items.find((item: { id: string }) => item.id === 'existing_session').disabled).toBe(true);
        await screen.unmount();
        expect(changed).not.toHaveBeenCalled();
    });
    it('names the actually selected producer when the conversation continues a step', async () => {
        const screen = await renderControls({
            kind: 'from_step',
            producer: { blockId: 'producer-a', scope: { kind: 'current' } },
        });

        expect(screen.findByTestId('editor-conversation-waiting-note')).not.toBeNull();
        expect(screen.getTextContent()).toContain(
            'workflows.conversation.waitingForConversation:{"block":"workflows.editor.addStep"}',
        );
    });

    it('says nothing about waiting when the conversation is not a continuation', async () => {
        const screen = await renderControls({ kind: 'shared_run' });

        expect(screen.findByTestId('editor-conversation-waiting-note')).toBeNull();
    });
});
