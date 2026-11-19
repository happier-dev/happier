import { afterEach, describe, expect, it } from 'vitest';
import type { PluginJsonSchemaV2 } from '@happier-dev/protocol/plugins/contributions/jsonSchema';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import { createWorkflowDefinitionFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { buildWorkflowEditorDraftFromDefinition } from '@/sync/domains/workflows/workflowAuthoring';
import { act, renderHook, standardCleanup } from '@/dev/testkit';
import { useWorkflowEditorHistory, workflowEditorSnapshotsEqual } from './useWorkflowEditorHistory';

afterEach(standardCleanup);

function draftWithSchema(schema: PluginJsonSchemaV2) {
    return buildWorkflowEditorDraftFromDefinition({ draftId: 'schema-order', name: 'Gather changes',
        definition: createWorkflowDefinitionFixture({ blocks: [{ kind: 'step', id: 'gather',
            document: { text: 'Gather changes', references: [], attachments: [] }, input: [],
            result: { kind: 'json', schema } }] }) });
}

describe('workflow editor snapshot equality', () => {
    const beforeFields = { issues: { type: 'string' }, commits: { type: 'string' } } satisfies NonNullable<PluginJsonSchemaV2['properties']>;
    const afterFields = { commits: { type: 'string' }, issues: { type: 'string' } } satisfies NonNullable<PluginJsonSchemaV2['properties']>;

    it.each(['nested array', 'local reference', 'composition'] as const)('retains presentation-bearing order inside a %s schema', (kind) => {
        const schema = (properties: NonNullable<PluginJsonSchemaV2['properties']>): PluginJsonSchemaV2 => {
            const object: PluginJsonSchemaV2 = { type: 'object', properties };
            if (kind === 'nested array') return { type: 'object', properties: { rows: { type: 'array', items: object } } };
            if (kind === 'local reference') return { $ref: '#/$defs/row', $defs: { row: object } };
            return { anyOf: [object, { type: 'null' }] };
        };
        const before = draftWithSchema(schema(beforeFields));
        const after = draftWithSchema(schema(afterFields));
        expect(pluginJsonValuesEqual(before, after)).toBe(true);
        expect(workflowEditorSnapshotsEqual(before, after)).toBe(false);
        expect(workflowEditorSnapshotsEqual({ draft: before }, { draft: after })).toBe(false);
    });

    it('keeps schema keyword order and literal JSON defaults semantic', () => {
        const before = draftWithSchema({ type: 'object', properties: beforeFields,
            default: { properties: { issues: 'one', commits: 'two' } } });
        const after = draftWithSchema({ default: { properties: { commits: 'two', issues: 'one' } },
            properties: beforeFields, type: 'object' });
        expect(workflowEditorSnapshotsEqual(before, after)).toBe(true);
        expect(workflowEditorSnapshotsEqual(before, null)).toBe(false);
        expect(workflowEditorSnapshotsEqual(null, null)).toBe(true);
    });
});

function promptDraft(text: string) {
    return buildWorkflowEditorDraftFromDefinition({ draftId: 'typing', name: 'Fix it',
        definition: createWorkflowDefinitionFixture({ blocks: [{ kind: 'step', id: 'fix',
            document: { text, references: [], attachments: [] }, input: [] }] }) });
}

describe('workflow editor history while a prompt is still being typed (WF-ACCEPT-1119 fix 6)', () => {
    it('offers Undo for the staged change as soon as the draft differs, and Undo restores it', async () => {
        const restored: ReturnType<typeof promptDraft>[] = [];
        const hook = await renderHook(() => useWorkflowEditorHistory<ReturnType<typeof promptDraft>>('scope', (snapshot) => { restored.push(snapshot); }));
        const history = hook.getCurrent();
        // The composer stages its document until blur: the header already says "Unsaved changes".
        await act(async () => { history.record(promptDraft('Fix it'), promptDraft('Fix itx'), 'Edit prompt', false); });
        expect(history.controls.undoLabel).toBe('Edit prompt');
        await act(async () => { history.controls.undo(); });
        expect(restored).toEqual([promptDraft('Fix it')]);
        expect(history.controls.undoLabel).toBeNull();
        expect(history.controls.redoLabel).toBe('Edit prompt');
    });

    it('offers nothing when the staged typing returned to where it started', async () => {
        const hook = await renderHook(() => useWorkflowEditorHistory<ReturnType<typeof promptDraft>>('scope', () => {}));
        const history = hook.getCurrent();
        await act(async () => { history.record(promptDraft('a'), promptDraft('ab'), 'Edit prompt', false); });
        await act(async () => { history.record(promptDraft('ab'), promptDraft('a'), 'Edit prompt', false); });
        expect(history.controls.undoLabel).toBeNull();
    });
});
