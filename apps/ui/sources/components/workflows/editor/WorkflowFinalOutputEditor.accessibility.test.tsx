import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createWorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import { WorkflowFinalOutputEditor } from './WorkflowFinalOutputEditor';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
// The portal is a platform boundary; the option list, field and binding writer stay real.
vi.mock('@/components/ui/popover', async (importOriginal) => {
    return (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal,
        { maxHeight: 640, maxWidth: 400, placement: 'bottom' });
});

afterEach(standardCleanup);

describe('workflow final output accessibility', () => {
    it('chooses and clears the final result through one labelled field, preserving the same producer path', async () => {
        const draft = createWorkflowEditorDraft({ draftId: 'output', name: 'Review' });
        const onChange = vi.fn();
        const screen = await renderScreen(<WorkflowFinalOutputEditor draft={draft} onChange={onChange} testIDPrefix="output" />);
        const select = () => screen.root.findByType(DropdownMenu);
        expect(select().props.itemTrigger?.title).toBeTruthy();
        expect(select().props.selectedId).toBe('none');
        const blockId = draft.blocks[0]!.id;
        await act(async () => select().props.onSelect(`result:${blockId}`));
        expect(onChange).toHaveBeenLastCalledWith({ kind: 'result', producer: { blockId, scope: { kind: 'current' } }, path: [] });
        const finalOutput = { kind: 'result' as const, producer: { blockId, scope: { kind: 'current' as const } }, path: ['summary'] };
        await screen.update(<WorkflowFinalOutputEditor draft={{ ...draft, finalOutput }} onChange={onChange} testIDPrefix="output" />);
        expect(select().props.selectedId).toBe(`result:${blockId}`);
        await act(async () => select().props.onOpenChange(true));
        const path = screen.findByTestId('output-final-output-path')!;
        await act(async () => path.props.onChangeText('summary.items.0'));
        expect(onChange).toHaveBeenLastCalledWith({ ...finalOutput, path: ['summary', 'items', 0] });
        await act(async () => select().props.onSelect(`result:${blockId}`));
        expect(onChange).toHaveBeenLastCalledWith(finalOutput);
        await act(async () => select().props.onSelect('none'));
        expect(onChange).toHaveBeenLastCalledWith(null);
    });

    it('keeps an unavailable authored producer visible without rewriting it', async () => {
        const draft = createWorkflowEditorDraft({ draftId: 'missing', name: 'Review' });
        const finalOutput = { kind: 'result' as const, producer: { blockId: 'removed', scope: { kind: 'current' as const } }, path: ['summary'] };
        const onChange = vi.fn();
        const screen = await renderScreen(<WorkflowFinalOutputEditor draft={{ ...draft, finalOutput }} onChange={onChange} testIDPrefix="output" />);
        const select = screen.root.findByType(DropdownMenu);
        expect(select.props.items.find((item: { id: string }) => item.id === 'result:removed')).toMatchObject({ disabled: true });
        expect(select.props.selectedId).toBe('result:removed');
        expect(onChange).not.toHaveBeenCalled();
    });

    it('retains an in-progress dotted path while the controlled result binding updates', async () => {
        const initial = createWorkflowEditorDraft({ draftId: 'path', name: 'Review' });
        let current: WorkflowEditorDraft = { ...initial, finalOutput: { kind: 'result',
            producer: { blockId: initial.blocks[0]!.id, scope: { kind: 'current' } }, path: [] } };
        let replacePath = (_path: (string | number)[]) => {};
        function Host() {
            const [draft, setDraft] = React.useState(current);
            replacePath = (path) => setDraft({ ...draft, finalOutput: { ...current.finalOutput!, path } });
            return <WorkflowFinalOutputEditor draft={draft} testIDPrefix="path" onChange={(finalOutput) => {
                if (!finalOutput) return;
                current = { ...draft, finalOutput };
                setDraft(current);
            }} />;
        }
        const screen = await renderScreen(<Host />);
        await act(async () => screen.root.findByType(DropdownMenu).props.onOpenChange(true));
        const input = () => screen.findByTestId('path-final-output-path')!;
        await act(async () => input().props.onChangeText('summary'));
        await act(async () => input().props.onChangeText('summary.'));
        expect(input().props.value).toBe('summary.');
        await act(async () => input().props.onChangeText('summary.items.0'));
        expect(current.finalOutput?.path).toEqual(['summary', 'items', 0]);
        await act(async () => replacePath(['replacement']));
        expect(input().props.value).toBe('replacement');
    });
});
