import { describe, expect, it } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol';
import { createToolCallMessageFixture } from '@/dev/testkit/fixtures/transcriptFixtures';
import { createWorkflowDefinitionFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { resolveTranscriptWorkflowDefinitionReference } from './transcriptWorkflowDefinitionReference';

const definitionId = '00000000-0000-4000-8000-000000000005';
const revision = { headerVersion: 2, bodyVersion: 3 };
const result = { definition: createWorkflowDefinitionFixture(), revision,
    metadata: { title: 'Renamed workflow', description: 'Exact saved description' }, changedBlockIds: ['step-1'] };
const input = { definitionId, expectedRevision: { headerVersion: 1, bodyVersion: 2 }, ops: [{ kind: 'set_step_prompt', blockId: 'step-1', text: 'Revised' }] };
const name = `mcp__happier__${getActionSpec('workflow.definition.edit').bindings?.mcpToolName}`;
const tool = createToolCallMessageFixture().tool;

describe('saved workflow Action acknowledgements', () => {
    it('carries the exact edit snapshot and host-returned IDs for direct and generic Action calls', () => {
        for (const call of [
            { name, input, result: { ok: true, result } },
            { name: 'mcp__happier__action_execute', input: { actionId: 'workflow.definition.edit', input }, result },
        ]) {
            expect(resolveTranscriptWorkflowDefinitionReference({ ...tool, ...call, state: 'completed' }))
                .toEqual({ actionId: 'workflow.definition.edit', definitionId, ...result });
        }
    });

    it('never turns an authority refusal or foreign tool into a saved workflow', () => {
        expect(resolveTranscriptWorkflowDefinitionReference({ ...tool, name, input, state: 'completed',
            result: { ok: false, errorCode: 'definition_exceeds_authority', error: 'Refused', result } })).toBeNull();
        expect(resolveTranscriptWorkflowDefinitionReference({ ...tool, name: name.replace('__happier__', '__foreign__'), input, state: 'completed', result })).toBeNull();
        expect(resolveTranscriptWorkflowDefinitionReference({ ...tool, name, input, state: 'error', result })).toBeNull();
    });

    it('does not open a block-edit acknowledgement without exact saved metadata', () => {
        const { metadata: _metadata, ...withoutMetadata } = result;
        expect(resolveTranscriptWorkflowDefinitionReference({ ...tool, name, input, state: 'completed', result: withoutMetadata })).toBeNull();
    });

    it('a whole replacement acknowledges its exact snapshot without inventing changed IDs', () => {
        const snapshot = { definitionId, definition: result.definition, access: 'owner', revision, metadata: { title: 'Saved workflow' } };
        const updateName = `mcp__happier__${getActionSpec('workflow.definition.update').bindings?.mcpToolName}`;
        expect(resolveTranscriptWorkflowDefinitionReference({ ...tool, name: updateName, input: {}, state: 'completed', result: snapshot }))
            .toEqual({ actionId: 'workflow.definition.update', ...snapshot, changedBlockIds: [] });
    });
});
