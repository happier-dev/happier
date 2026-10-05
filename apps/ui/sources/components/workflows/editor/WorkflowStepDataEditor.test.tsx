import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactTestInstance } from 'react-test-renderer';

import { renderScreen, standardCleanup } from '@/dev/testkit';

import type { WorkflowStep } from '@happier-dev/protocol/workflows/workflowV1';
import type { WorkflowValueReference } from '@happier-dev/protocol/workflows/workflowReferenceV1';
import { setWorkflowInputs } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import { createWorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
// Load the real owner during collection, not against the first interaction's timeout.
import { formatWorkflowValueReference, WorkflowStepDataEditor } from './WorkflowStepDataEditor';
import { formatWorkflowConditionSentence } from './WorkflowConditionEditor';
import { formatWorkflowLoopSentence } from './WorkflowLoopEditor';
import { getBuiltinWorkflowCatalogV1 } from '@happier-dev/protocol';
import { buildWorkflowEditorDraftFromDefinition } from '@/sync/domains/workflows/workflowAuthoring';

/**
 * Where a binding's value comes from, which workflow input it reads and which step produces it
 * are each one labelled field select (07 §3 control table): a reader hears the set by its name
 * and its current value, and every valid choice is offered with the current one selected.
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

function stepBlock(id: string, input: WorkflowStep['input']): WorkflowStep {
    return {
        kind: 'step',
        id,
        document: { text: '', references: [], attachments: [] },
        input,
        result: { kind: 'text' },
    };
}

async function renderEditor(draft: unknown, step: WorkflowStep) {
    return renderScreen(
        <WorkflowStepDataEditor
            draft={draft as Parameters<typeof WorkflowStepDataEditor>['0']['draft']}
            step={step}
            onChangeInput={() => {}}
            testIDPrefix="editor"
        />,
    );
}

type FieldSelect = Readonly<{
    props: Readonly<{ items: ReadonlyArray<Readonly<{ id: string; title: string }>>; selectedId: string | null; onSelect: (id: string) => void }>;
}>;

function fieldSelect(root: ReactTestInstance, testID: string): FieldSelect {
    const match = root.findAll((node) => node.props?.testID === testID && typeof node.props?.onSelect === 'function')[0];
    if (match === undefined) throw new Error(`No field select ${testID}`);
    return match as unknown as FieldSelect;
}

function selectTrigger(root: ReactTestInstance, testID: string): ReactTestInstance {
    const match = root.findAll((node) => typeof node.type === 'string' && node.props?.testID === `${testID}-trigger`)[0];
    if (match === undefined) throw new Error(`No trigger for ${testID}`);
    return match;
}

describe('WorkflowStepDataEditor field selects', () => {
    it('reads every reference kind without a wire-object fallback and labels unavailable values', () => {
        const draft = createWorkflowEditorDraft({ draftId: 'references', name: 'Review' });
        const producer = { blockId: draft.blocks[0]!.id, scope: { kind: 'outer', levels: 1 } } as const;
        const references: WorkflowValueReference[] = [
            { kind: 'literal', value: { kind: 'exhausted', rounds: 3 } },
            { kind: 'input', name: 'files' }, { kind: 'result', producer, path: ['verdict'] },
            { kind: 'loop_trailing_count', producer, path: ['verdict'], equals: true },
            { kind: 'workspace', producer, field: 'checkoutRootPath' },
            { kind: 'item', field: 'value', path: ['name'] }, { kind: 'iteration', field: 'stopReason' },
            { kind: 'session_context', recentTurns: 2 }, { kind: 'session_context_field', field: 'goal.tokenBudget' },
        ];
        for (const reference of references) expect(formatWorkflowValueReference(draft, reference)).not.toContain('"kind"');
        expect(formatWorkflowValueReference(draft, references[4]!)).toContain('workflows.input.checkoutRoot');
        // External/future values may be unavailable to this reader; never expose their native bag.
        expect(formatWorkflowValueReference(draft, { kind: 'future', data: { secret: 'hidden' } } as unknown as WorkflowValueReference)).toBe('workflows.input.unavailableValue');
    });
    it('reads builtin loop conditions as human reference labels, including typed stop reasons', () => {
        const definition = getBuiltinWorkflowCatalogV1().find(entry => entry.id === 'builtin:keep-going')!.definition;
        const draft = buildWorkflowEditorDraftFromDefinition({ draftId: 'keep-going', name: 'Keep going', definition });
        const loop = draft.blocks[0]!;
        const condition = draft.blocks[1]!;
        if (loop.kind !== 'loop' || condition.kind !== 'if') throw new Error('Invalid builtin fixture');
        const label = formatWorkflowConditionSentence(draft, condition.when);
        expect(label).not.toContain('"kind"');
        expect(label).toContain('workflows.input.stopCondition');
        expect(formatWorkflowLoopSentence(draft, loop)).toContain('workflows.input.tokensUsed');
        expect(formatWorkflowValueReference(draft, { kind: 'iteration', field: 'position' })).toBe('workflows.input.iterationField.position');
        expect(formatWorkflowValueReference(draft, { kind: 'session_context', recentTurns: 1 })).toContain('workflows.input.sessionContext');
    });
    it('offers where a value comes from as one labelled select with the current kind selected', async () => {
        const step = stepBlock('step-a', [{ kind: 'literal', value: '' }]);
        const draft = createWorkflowEditorDraft({ draftId: 'draft-1', name: 'Review', blocks: [step] });
        const changes: unknown[] = [];
        const screen = await renderScreen(
            <WorkflowStepDataEditor
                draft={draft as Parameters<typeof WorkflowStepDataEditor>['0']['draft']}
                step={step}
                onChangeInput={(next) => changes.push(next)}
                testIDPrefix="editor"
            />,
        );

        const select = fieldSelect(screen.root, 'editor-step-step-a-input-0-kind');
        expect(select.props.selectedId).toBe('literal');
        expect(select.props.items.map((item) => item.id)).toEqual(['literal', 'input', 'result', 'workspace']);
        expect(selectTrigger(screen.root, 'editor-step-step-a-input-0-kind').props.accessibilityLabel)
            .toBe('workflows.input.valueKindGroup: workflows.condition.valuePlaceholder');
        await act(async () => { select.props.onSelect('input'); });
        expect(changes.at(-1)).toEqual([{ kind: 'input', name: 'input' }]);
    });

    it('offers which workflow input it reads as one select with the current input selected', async () => {
        const step = stepBlock('step-a', [{ kind: 'input', name: 'tone' }]);
        const draft = setWorkflowInputs(
            createWorkflowEditorDraft({ draftId: 'draft-1', name: 'Review', blocks: [step] }),
            [
                { name: 'topic', valueType: 'string', required: false },
                { name: 'tone', valueType: 'string', required: false },
            ],
        );

        const screen = await renderEditor(draft, step);

        const select = fieldSelect(screen.root, 'editor-step-step-a-input-0-input-name');
        expect(select.props.items.map((item) => item.id)).toEqual(['topic', 'tone']);
        expect(select.props.selectedId).toBe('tone');
    });

    it('offers which step produces it as one select naming each step and its scope', async () => {
        const producer = stepBlock('producer-a', []);
        const step = stepBlock('step-a', [
            { kind: 'result', producer: { blockId: 'producer-a', scope: { kind: 'current' } }, path: [] },
        ]);
        const draft = createWorkflowEditorDraft({
            draftId: 'draft-1',
            name: 'Review',
            blocks: [producer, step],
        });

        const screen = await renderEditor(draft, step);

        const select = fieldSelect(screen.root, 'editor-step-step-a-input-0-producer');
        expect(select.props.items).toEqual([
            expect.objectContaining({ id: 'producer-a:current', title: 'producer-a', subtitle: 'workflows.input.scopeCurrent' }),
        ]);
        expect(select.props.selectedId).toBe('producer-a:current');
    });
});
