import { describe, expect, it, vi } from 'vitest';
import type { WorkflowStep } from '@happier-dev/protocol/workflows/workflowV1';
import { WorkflowValueReferenceSchema } from '@happier-dev/protocol/workflows/workflowReferenceV1';
import { createWorkflowActionTriggerEventDeclarationV1 } from '@happier-dev/protocol/workflows/workflowTriggerEventReferenceV1';
import { createWorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import { formatWorkflowValueOptionLabel, listWorkflowConditionValueOptions, resolveWorkflowConditionValueFacts } from './workflowConditionValueOptions';

vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

const step = (id: string): WorkflowStep => ({ kind: 'step', id, name: id,
    document: { text: id, references: [], attachments: [] }, input: [], result: { kind: 'text' } });

describe('workflow prompt reference scope', () => {
    it('offers only declared Event scalar leaves and keeps qualified Event identities distinct', () => {
        const draft = createWorkflowEditorDraft({ draftId: 'event-values', name: 'Notify', blocks: [step('notify')] });
        const event = { pluginId: 'example.events', localId: 'run' };
        const otherEvent = { pluginId: 'other.events', localId: 'run' };
        const options = listWorkflowConditionValueOptions(draft, 'notify', undefined, {
            triggerEvents: [
                { event, payloadSchema: { type: 'object', properties: {
                    state: { type: 'string', enum: ['succeeded', 'failed'] },
                    attempt: { type: 'integer' },
                    source: { type: 'object', properties: { name: { type: 'string' } } },
                    labels: { type: 'array', items: { type: 'string' } },
                } } },
                { event, payloadSchema: { type: 'object', properties: { state: { type: 'string', enum: ['succeeded', 'failed'] } } } },
                { event: otherEvent, payloadSchema: { type: 'object', properties: { state: { type: 'boolean' } } } },
                { event: { pluginId: 'unavailable.events', localId: 'run' }, payloadSchema: null },
            ],
        });
        const eventOptions = options.filter(option => option.reference.kind === 'trigger_event');
        expect(eventOptions.map(option => option.reference)).toEqual([
            { kind: 'trigger_event', event, path: ['state'] },
            { kind: 'trigger_event', event, path: ['attempt'] },
            { kind: 'trigger_event', event, path: ['source', 'name'] },
            { kind: 'trigger_event', event: otherEvent, path: ['state'] },
        ]);
        expect(eventOptions.map(option => option.facts)).toEqual([
            { type: 'choice', choices: ['succeeded', 'failed'] },
            { type: 'number' }, { type: 'text' }, { type: 'boolean' },
        ]);
        expect(new Set(eventOptions.map(option => option.id)).size).toBe(4);
        expect(resolveWorkflowConditionValueFacts(draft, { kind: 'trigger_event', event, path: ['state'] }, { triggerEvents: [
            { event, payloadSchema: null },
            { event, payloadSchema: { type: 'object', properties: { state: { type: 'boolean' } } } },
        ] })).toEqual({ type: 'boolean' });
        expect(listWorkflowConditionValueOptions(draft, 'notify').some(option => option.reference.kind === 'trigger_event')).toBe(false);
    });

    it('offers safe declared Action evidence for both phases without exposing raw operands or results', () => {
        const draft = createWorkflowEditorDraft({ draftId: 'action-values', name: 'Notify', blocks: [step('notify')] });
        const triggerEvents = (['before', 'after'] as const).map(createWorkflowActionTriggerEventDeclarationV1);
        const options = listWorkflowConditionValueOptions(draft, 'notify', undefined, { triggerEvents });
        const eventOptions = options.filter(option => option.reference.kind === 'trigger_event');
        const requestOptions = eventOptions.filter(option => option.reference.kind === 'trigger_event'
            && option.reference.path.length === 1 && option.reference.path[0] === 'requestId');
        expect(requestOptions.map(option => WorkflowValueReferenceSchema.parse(JSON.parse(JSON.stringify(option.reference)))))
            .toEqual([
                { kind: 'trigger_event', event: { kind: 'action', phase: 'before' }, path: ['requestId'] },
                { kind: 'trigger_event', event: { kind: 'action', phase: 'after' }, path: ['requestId'] },
            ]);
        expect(new Set(requestOptions.map(option => option.id)).size).toBe(2);
        expect(requestOptions.map(option => option.facts)).toEqual([{ type: 'text' }, { type: 'text' }]);
        expect(resolveWorkflowConditionValueFacts(draft, { kind: 'trigger_event',
            event: { kind: 'action', phase: 'after' }, path: ['status'] }, { triggerEvents }))
            .toEqual({ type: 'choice', choices: ['succeeded', 'failed'] });
        for (const path of ['input', 'output', 'errorMessage']) {
            expect(eventOptions.some(option => option.reference.kind === 'trigger_event'
                && option.reference.path[0] === path)).toBe(false);
        }
    });

    it('offers prior results and inputs while explaining later and sibling-lane results', () => {
        const draft = { ...createWorkflowEditorDraft({ draftId: 'scope', name: 'Release', blocks: [
            step('gather'), { kind: 'parallel' as const, id: 'lanes', failurePolicy: 'fail_stop' as const, branches: [
                { id: 'docs', blocks: [step('write'), step('publish')] },
                { id: 'tests', blocks: [step('test')] },
            ] }, step('ship'),
        ] }), inputs: [{ name: 'version', valueType: 'string' as const, required: true }] };
        const options = listWorkflowConditionValueOptions(draft, 'publish', undefined, { includeUnavailable: true });
        expect(options).toEqual(expect.arrayContaining([
            expect.objectContaining({ reference: { kind: 'result', producer: { blockId: 'gather', scope: { kind: 'outer', levels: 1 } }, path: [] } }),
            expect.objectContaining({ reference: { kind: 'result', producer: { blockId: 'write', scope: { kind: 'current' } }, path: [] } }),
            expect.objectContaining({ reference: { kind: 'input', name: 'version' } }),
            expect.objectContaining({ reference: expect.objectContaining({ producer: expect.objectContaining({ blockId: 'test' }) }), unavailableReason: 'another_lane' }),
            expect.objectContaining({ reference: expect.objectContaining({ producer: expect.objectContaining({ blockId: 'ship' }) }), unavailableReason: 'runs_later' }),
        ]));
        const ordinary = listWorkflowConditionValueOptions(draft, 'publish');
        expect(ordinary.some(option => option.unavailableReason !== undefined)).toBe(false);
        expect(options.some(option => option.reference.kind === 'result' && option.reference.producer.blockId === 'publish')).toBe(false);
    });

    // Insert (WF-REDESIGN-1116 g): one list everywhere, grouped Inputs, Step results, Workspace, then what is not available here.
    it('groups Insert’s one list as inputs, earlier results, workspace, then what is not available here', () => {
        const draft = { ...createWorkflowEditorDraft({ draftId: 'groups', name: 'Fix', blocks: [step('find'), step('check'), step('tell')] }),
            inputs: [{ name: 'branch', valueType: 'string' as const, required: true }] };
        const options = listWorkflowConditionValueOptions(draft, 'check', undefined, { includeUnavailable: true });
        const groups = options.map(option => option.group).filter((group, index, all) => all.indexOf(group) === index);
        expect(groups).toEqual(['workflows.inputs.title', 'workflows.input.stepResults', 'workflows.workspace.title', 'workflows.input.notAvailableHere']);
        expect(options.find(option => option.reference.kind === 'result' && option.reference.producer.blockId === 'find'
            && option.reference.path.length === 0)).toMatchObject({ group: 'workflows.input.stepResults' });
        expect(formatWorkflowValueOptionLabel(options.find(option => option.reference.kind === 'input')!)).toBe('Branch');
        expect(formatWorkflowValueOptionLabel(options.find(option => option.unavailableReason === 'runs_later')!)).toBe('tell');
    });
});
