import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { StyleSheet } from 'react-native';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createWorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
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

afterEach(standardCleanup);

describe('workflow final output accessibility', () => {
    it('announces the chosen output as checked and leaves the other option unchecked', async () => {
        const draft = createWorkflowEditorDraft({ draftId: 'output', name: 'Review' });
        const screen = await renderScreen(<WorkflowFinalOutputEditor draft={draft} onChange={() => {}} testIDPrefix="output" />);
        const clear = screen.tree.findHostByTestId('output-final-output-clear')!;
        const option = screen.tree.findHostByTestId(`output-final-output-option-${draft.blocks[0]!.id}`)!;
        expect(clear.props['aria-checked']).toBe(true);
        expect(option.props['aria-checked']).toBe(false);
        await screen.update(<WorkflowFinalOutputEditor draft={{ ...draft, finalOutput: {
            kind: 'result', producer: { blockId: draft.blocks[0]!.id, scope: { kind: 'current' } }, path: [],
        } }} onChange={() => {}} testIDPrefix="output" />);
        expect(screen.tree.findHostByTestId('output-final-output-clear')!.props['aria-checked']).toBe(false);
        expect(screen.tree.findHostByTestId(`output-final-output-option-${draft.blocks[0]!.id}`)!.props['aria-checked']).toBe(true);
    });

    it('shows the shared ring for keyboard focus and removes it for pointer focus', async () => {
        const draft = createWorkflowEditorDraft({ draftId: 'output', name: 'Review' });
        const screen = await renderScreen(<WorkflowFinalOutputEditor draft={draft} onChange={() => {}} testIDPrefix="output" />);
        const target = () => screen.tree.findHostByTestId('output-final-output-clear')!;
        const restingStyle = () => StyleSheet.flatten(typeof target().props.style === 'function'
            ? target().props.style({ pressed: false }) : target().props.style);
        const restingBorder = restingStyle()?.borderColor;
        await act(async () => { target().props.onFocus?.({ target: { matches: () => true } }); });
        expect(restingStyle()?.borderColor).toBeTruthy();
        expect(restingStyle()?.borderColor).not.toBe(restingBorder);
        await act(async () => { target().props.onFocus?.({ target: { matches: () => false } }); });
        expect(restingStyle()?.borderColor).toBe(restingBorder);
    });
});
