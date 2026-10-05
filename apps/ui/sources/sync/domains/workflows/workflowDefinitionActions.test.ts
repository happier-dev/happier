import { beforeEach, describe, expect, it, vi } from 'vitest';

const executeMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', () => ({
    createFrontDoorActionExecute: () => executeMock,
}));

/** One normalized definition the canonical result schema accepts. */
const definition = {
    version: 1,
    inputs: [],
    defaults: {},
    blocks: [{
        kind: 'step',
        id: 'wf-step-1',
        document: { text: 'Do the thing', references: [], attachments: [] },
        input: [],
        result: { kind: 'text' },
    }],
} as const;

const metadata = { title: 'Nightly triage' } as const;
const revision = { headerVersion: 3, bodyVersion: 7 } as const;

function succeedWith(result: unknown): void {
    executeMock.mockResolvedValueOnce({ ok: true, result });
}

describe('workflow definition Action client', () => {
    beforeEach(() => {
        executeMock.mockReset();
    });

    it('reads the library through the canonical list Action and parses its result', async () => {
        const { listWorkflowDefinitions } = await import('./workflowDefinitionActions');
        succeedWith({
            definitions: [{
                kind: 'workflow-definition.v1',
                definitionId: 'definition-1',
                stepCount: 1,
                contentStatus: 'available',
                nextRunAt: null,
                triggers: [],
                revision,
                metadata,
            }],
            nextCursor: 'cursor-2',
        });

        const page = await listWorkflowDefinitions({ cursor: 'cursor-1', limit: 20 });

        expect(executeMock).toHaveBeenCalledTimes(1);
        const [actionId, input] = executeMock.mock.calls[0]!;
        expect(actionId).toBe('workflow.definition.list');
        expect(input).toEqual({ cursor: 'cursor-1', limit: 20 });
        expect(page.definitions[0]?.definitionId).toBe('definition-1');
        expect(page.nextCursor).toBe('cursor-2');
    });

    it('reads one saved definition at its exact Artifact revision', async () => {
        const { getWorkflowDefinition } = await import('./workflowDefinitionActions');
        succeedWith({ definitionId: 'definition-1', revision, definition, metadata, access: 'view' });

        const read = await getWorkflowDefinition({ definitionId: 'definition-1' });

        expect(executeMock.mock.calls[0]?.[0]).toBe('workflow.definition.get');
        expect(executeMock.mock.calls[0]?.[1]).toEqual({ definitionId: 'definition-1' });
        expect(read.revision).toEqual(revision);
        expect(read.access).toBe('view');
    });

    it('creates a definition through the canonical create Action', async () => {
        const { createWorkflowDefinition } = await import('./workflowDefinitionActions');
        succeedWith({ definitionId: 'definition-1', revision, definition, metadata, access: 'owner' });

        const created = await createWorkflowDefinition({
            definitionId: 'definition-1',
            definition: { blocks: ['Do the thing'] },
            metadata,
        });

        expect(executeMock.mock.calls[0]?.[0]).toBe('workflow.definition.create');
        expect(created.definitionId).toBe('definition-1');
    });

    it('carries the expected Artifact revision on every update so a concurrent save cannot be overwritten', async () => {
        const { updateWorkflowDefinition } = await import('./workflowDefinitionActions');
        succeedWith({
            definitionId: 'definition-1',
            revision: { headerVersion: 4, bodyVersion: 8 },
            access: 'edit',
            definition,
            metadata,
        });

        await updateWorkflowDefinition({
            definitionId: 'definition-1',
            expectedRevision: revision,
            definition: { blocks: ['Do the thing'] },
            metadata,
        });

        const [actionId, input] = executeMock.mock.calls[0]!;
        expect(actionId).toBe('workflow.definition.update');
        expect((input as { expectedRevision: unknown }).expectedRevision).toEqual(revision);
    });

    it('surfaces a stale update as the canonical currentness conflict, not a generic failure', async () => {
        const { isWorkflowDefinitionConflictError, updateWorkflowDefinition } =
            await import('./workflowDefinitionActions');
        executeMock.mockResolvedValueOnce({
            ok: false,
            errorCode: 'currentness_conflict',
            error: 'A newer revision was saved',
        });

        const failure = await updateWorkflowDefinition({
            definitionId: 'definition-1',
            expectedRevision: revision,
            definition: { blocks: ['Do the thing'] },
            metadata,
        }).catch((error: unknown) => error);

        expect(isWorkflowDefinitionConflictError(failure)).toBe(true);
    });

    it('does not report an unrelated failure as a currentness conflict', async () => {
        const { isWorkflowDefinitionConflictError, deleteWorkflowDefinition } =
            await import('./workflowDefinitionActions');
        executeMock.mockResolvedValueOnce({
            ok: false,
            errorCode: 'run_access_denied',
            error: 'Not allowed',
        });

        const failure = await deleteWorkflowDefinition({ definitionId: 'definition-1' })
            .catch((error: unknown) => error);

        expect(isWorkflowDefinitionConflictError(failure)).toBe(false);
        expect(isWorkflowDefinitionConflictError(new Error('currentness_conflict'))).toBe(false);
    });

    it('rejects a malformed Action response instead of handing it to a screen', async () => {
        const { getWorkflowDefinition } = await import('./workflowDefinitionActions');
        // A partially migrated owner that answers with a header but no body.
        succeedWith({ definitionId: 'definition-1', revision, metadata });

        await expect(getWorkflowDefinition({ definitionId: 'definition-1' })).rejects.toThrow();
    });

    it('rejects a malformed request before any dispatch reaches the front door', async () => {
        const { createWorkflowDefinition } = await import('./workflowDefinitionActions');

        await expect(createWorkflowDefinition({
            definitionId: 'definition-1',
            // An empty block list is not a workflow; the request schema owns that rule.
            definition: { blocks: [] },
            metadata,
        })).rejects.toThrow();
        expect(executeMock).not.toHaveBeenCalled();
    });

    it('confirms a delete through the canonical delete Action', async () => {
        const { deleteWorkflowDefinition } = await import('./workflowDefinitionActions');
        succeedWith({ deleted: true, definitionId: 'definition-1' });

        const deleted = await deleteWorkflowDefinition({ definitionId: 'definition-1' });

        expect(executeMock.mock.calls[0]?.[0]).toBe('workflow.definition.delete');
        expect(deleted).toEqual({ deleted: true, definitionId: 'definition-1' });
    });
});
