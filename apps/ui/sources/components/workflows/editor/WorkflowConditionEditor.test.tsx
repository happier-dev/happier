import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorkflowCondition } from '@happier-dev/protocol/workflows/workflowReferenceV1';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createWorkflowDefinitionFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { buildWorkflowEditorDraftFromDefinition } from '@/sync/domains/workflows/workflowAuthoring';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: (key: string) => key }));
// Native/web portals are a platform boundary; the real menu and selection logic stay.
vi.mock('@/components/ui/popover', async (importOriginal) => {
    const { createInlinePopoverModuleMock } = await import('@/dev/testkit/mocks/popover');
    return createInlinePopoverModuleMock(importOriginal, { maxHeight: 640, maxWidth: 280, placement: 'bottom' });
});

const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const { WorkflowConditionEditor } = await import('./WorkflowConditionEditor');

const check = { kind: 'step' as const, id: 'check', name: 'Check the build',
    document: { text: 'Check it', references: [], attachments: [] },
    result: { kind: 'json' as const, schema: { type: 'object' as const, additionalProperties: false, required: ['passed', 'failures', 'tests', 'verdict'], properties: {
        passed: { type: 'boolean' as const },
        failures: { type: 'array' as const, items: { type: 'string' as const } },
        tests: { type: 'number' as const },
        verdict: { type: 'string' as const, enum: ['ship', 'hold'] },
    } } } };
const consumer = { kind: 'if' as const, id: 'gate', when: { kind: 'exists' as const, value: { kind: 'literal' as const, value: true } },
    then: [{ kind: 'step' as const, id: 'fix', document: { text: 'Fix it', references: [], attachments: [] } }], otherwise: [] };
const draft = buildWorkflowEditorDraftFromDefinition({ draftId: 'd', name: 'W', definition: createWorkflowDefinitionFixture({
    blocks: [check, consumer] as never,
    inputs: [{ name: 'branch', valueType: 'string', required: true }],
}) });
const passed = { kind: 'result' as const, producer: { blockId: 'check', scope: { kind: 'current' as const } }, path: ['passed'] };

afterEach(standardCleanup);

async function render(condition: WorkflowCondition | undefined, props: Readonly<{ required?: boolean }> = { required: true }) {
    const changed = vi.fn();
    const screen = await renderScreen(<WorkflowConditionEditor label="workflows.condition.ifWhen" condition={condition} draft={draft}
        consumerBlockId="gate" onChange={changed} testIDPrefix="cond" {...props} />);
    const menu = (testID: string) => screen.findAllByType(DropdownMenu).find((node) => node.props.testID === testID);
    return { screen, changed, menu };
}

describe('building a condition as one sentence', () => {
    it('offers one value picker naming each value and its type, never the reference\'s kind, step and field as separate selects', async () => {
        const { screen, menu } = await render({ kind: 'exists', value: { kind: 'literal', value: true } });
        expect(screen.findByTestId('cond-value')).not.toBeNull();
        expect(menu('cond-kind')).toBeUndefined();
        expect(menu('cond-value-input-0-kind')).toBeUndefined();
        const items = menu('cond-value')!.props.items as ReadonlyArray<Readonly<{ title: string; category?: string; subtitle?: string }>>;
        expect(items.filter((item) => item.category === 'Check the build').map((item) => item.title).slice(0, 4)).toEqual(['Passed', 'Failures', 'Tests', 'Verdict']);
        expect(items.some((item) => item.title === 'Branch')).toBe(true);
    });

    it('says nothing is chosen yet, and asks for no test until a value is', async () => {
        const { screen, menu } = await render({ kind: 'exists', value: { kind: 'literal', value: true } });
        expect(screen.findByTestId('cond-unset-hint')).not.toBeNull();
        expect(menu('cond-test')).toBeUndefined();
    });

    it('choosing a Yes/No value writes a comparison whose right side is Yes', async () => {
        const { changed, menu } = await render({ kind: 'exists', value: { kind: 'literal', value: true } });
        const items = menu('cond-value')!.props.items as ReadonlyArray<Readonly<{ id: string; title: string }>>;
        await act(async () => menu('cond-value')!.props.onSelect(items.find((item) => item.title === 'Passed')!.id));
        expect(changed.mock.lastCall?.[0]).toEqual({ kind: 'compare', operator: 'eq', left: passed, right: { kind: 'literal', value: true } });
    });

    it('a list offers only presence tests', async () => {
        const { menu } = await render({ kind: 'exists', value: { ...passed, path: ['failures'] } });
        expect((menu('cond-test')!.props.items as ReadonlyArray<Readonly<{ id: string }>>).map((item) => item.id)).toEqual(['exists', 'not_exists']);
    });

    it('a Choice compares against its own choices', async () => {
        const { menu } = await render({ kind: 'compare', operator: 'eq', left: { ...passed, path: ['verdict'] }, right: { kind: 'literal', value: 'ship' } });
        expect((menu('cond-right-choice')!.props.items as ReadonlyArray<Readonly<{ id: string }>>).map((item) => item.id)).toEqual(['ship', 'hold']);
    });

    it('a number takes a number, not its text', async () => {
        const { screen, changed } = await render({ kind: 'compare', operator: 'gt', left: { ...passed, path: ['tests'] }, right: { kind: 'literal', value: 0 } });
        await act(async () => screen.changeTextByTestId('cond-right-literal', '12'));
        expect(changed.mock.lastCall?.[0]).toMatchObject({ right: { kind: 'literal', value: 12 } });
    });

    it('text stays text, even when it looks like a number', async () => {
        const { screen, changed } = await render({ kind: 'compare', operator: 'eq', left: { kind: 'input', name: 'branch' }, right: { kind: 'literal', value: '' } });
        await act(async () => screen.changeTextByTestId('cond-right-literal', '12'));
        expect(changed.mock.lastCall?.[0]).toMatchObject({ right: { kind: 'literal', value: '12' } });
    });

    it('groups rules only once there are two, and a removed rule collapses the group back', async () => {
        const rule: WorkflowCondition = { kind: 'compare', operator: 'eq', left: passed, right: { kind: 'literal', value: false } };
        const single = await render(rule);
        expect(single.menu('cond-mode')).toBeUndefined();
        await act(async () => single.screen.pressByTestId('cond-add'));
        expect(single.changed.mock.lastCall?.[0]).toMatchObject({ kind: 'all', conditions: [rule, { kind: 'exists' }] });

        const other: WorkflowCondition = { kind: 'exists', value: { kind: 'input', name: 'branch' } };
        const group = await render({ kind: 'any', conditions: [rule, other] });
        expect(group.menu('cond-mode')!.props.selectedId).toBe('any');
        await act(async () => group.screen.pressByTestId('cond-1-remove'));
        expect(group.changed.mock.lastCall?.[0]).toEqual(rule);
    });

    it('keeps every authored shape readable: a negated rule and a nested group', async () => {
        const nested: WorkflowCondition = { kind: 'all', conditions: [
            { kind: 'not', condition: { kind: 'compare', operator: 'eq', left: passed, right: { kind: 'literal', value: true } } },
            { kind: 'any', conditions: [{ kind: 'exists', value: passed }, { kind: 'exists', value: { kind: 'input', name: 'branch' } }] },
        ] };
        const { screen, menu } = await render(nested);
        expect(screen.findByTestId('cond-0-not')).not.toBeNull();
        expect(menu('cond-1-mode')!.props.selectedId).toBe('any');
    });
});
