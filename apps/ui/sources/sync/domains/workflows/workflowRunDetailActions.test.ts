import { describe, expect, it, vi } from 'vitest';

import {
    createWorkflowDefinitionFixture,
    createWorkflowInvocationIndexFixture,
    createWorkflowRunSummaryFixture,
} from '@/dev/testkit/fixtures/workflowRunFixtures';

import { WorkflowActionError } from './workflowActionError';
import { createWorkflowRunDetailActions } from './workflowRunDetailActions';

function ok(result: unknown) {
    return vi.fn(async () => ({ ok: true as const, result }));
}

describe('workflow Run detail actions', () => {
    it('reads one exact Run through the canonical Action id', async () => {
        const execute = ok({
            run: createWorkflowRunSummaryFixture({ id: 'run-1' }),
            callerAccess: { canEdit: true },
            definition: createWorkflowDefinitionFixture(),
            authoredDefinition: createWorkflowDefinitionFixture(),
            acceptedContext: {
                source: { kind: 'inline' },
                inputs: {},
                machineId: 'machine-1',
                // One Run executes under exactly one runtime, and the canonical
                // accepted snapshot records that frozen choice. Omitting it
                // described a Run the Protocol cannot admit.
                executionTarget: { kind: 'session' },
                materializedLeaves: [],
                frozenChildren: {},
                workspaceTarget: {
                    project: {
                        machineId: 'machine-1',
                        directory: '/repo',
                        checkoutRootPath: '/repo',
                    },
                },
                origin: { kind: 'direct' },
                startedBy: 'user',
            },
            checkpoint: null,
        });
        const actions = createWorkflowRunDetailActions({ execute: execute as never });

        const result = await actions.getRun('run-1');

        expect(execute).toHaveBeenCalledWith(
            'workflow.run.get',
            { runId: 'run-1' },
            expect.objectContaining({ surface: 'ui' }),
        );
        expect(result.run.id).toBe('run-1');
    });

    it('asks the server index for the actionable invocations rather than paging history', async () => {
        const execute = ok({
            invocations: [createWorkflowInvocationIndexFixture({ id: 'inv-1', lifecycle: 'waiting_for_approval' })],
            nextCursor: 'page-2',
            parentRevision: 7,
        });
        const actions = createWorkflowRunDetailActions({ execute: execute as never });

        const result = await actions.listInvocations({
            runId: 'run-1',
            lifecycles: ['waiting_for_approval', 'needs_attention'],
            cursor: 'page-1',
        });

        expect(execute).toHaveBeenCalledWith(
            'workflow.run.invocations.list',
            {
                runId: 'run-1',
                cursor: 'page-1',
                lifecycles: ['waiting_for_approval', 'needs_attention'],
            },
            expect.objectContaining({ surface: 'ui' }),
        );
        expect(result.invocations[0]?.lifecycle).toBe('waiting_for_approval');
        expect(result.parentRevision).toBe(7);
    });

    it('rejects a response the canonical result schema does not accept', async () => {
        const actions = createWorkflowRunDetailActions({
            execute: ok({ invocations: [{ id: 'inv-1' }], parentRevision: 1 }) as never,
        });

        await expect(actions.listInvocations({ runId: 'run-1' })).rejects.toThrow();
    });

    it('surfaces a closed workflow error code a control caller can branch on', async () => {
        const actions = createWorkflowRunDetailActions({
            execute: vi.fn(async () => ({
                ok: false as const,
                errorCode: 'currentness_conflict',
                error: 'Run revision moved on',
            })) as never,
        });

        const error = await actions.pauseRun({ runId: 'run-1', expectedRevision: 3 }).catch((value) => value);

        expect(error).toBeInstanceOf(WorkflowActionError);
        expect((error as WorkflowActionError).code).toBe('currentness_conflict');
    });

    it('does not invent a workflow error code for an unrelated transport failure', async () => {
        const actions = createWorkflowRunDetailActions({
            execute: vi.fn(async () => ({
                ok: false as const,
                errorCode: 'rate_limited',
                error: 'Too many requests',
            })) as never,
        });

        const error = await actions.getRun('run-1').catch((value) => value) as WorkflowActionError;

        expect(error.code).toBeNull();
        expect(error.rawCode).toBe('rate_limited');
    });

    it('sends the expected revision with every control so a stale request is refused', async () => {
        const run = createWorkflowRunSummaryFixture({ id: 'run-1' });
        const execute = ok({ run, intent: 'cancel_requested' });
        const actions = createWorkflowRunDetailActions({ execute: execute as never });

        const result = await actions.cancelRun({ runId: 'run-1', expectedRevision: 4 });

        expect(execute).toHaveBeenCalledWith(
            'workflow.run.cancel',
            { runId: 'run-1', expectedRevision: 4 },
            expect.objectContaining({ surface: 'ui' }),
        );
        // A control returns a durable intent, never a physical stop receipt.
        expect(result.intent).toBe('cancel_requested');
    });

    it('targets workspace restoration at the exact Run Machine through the Action context', async () => {
        const run = createWorkflowRunSummaryFixture({ id: 'run-1', state: 'running', revision: 5 });
        const execute = ok({ run, intent: 'resumed' });
        const actions = createWorkflowRunDetailActions({ execute: execute as never });
        const input = {
            mode: 'recover' as const,
            runId: 'run-1',
            expectedRevision: 4,
            invocations: [{
                kind: 'restore_workspace' as const,
                invocation: { recordId: 'inv-1' },
                conversation: 'fresh_agent' as const,
                input: { kind: 'original' as const },
            }],
        };

        await actions.restoreWorkspace(input, 'machine-1');

        expect(execute).toHaveBeenCalledWith(
            'workflow.run.resume',
            input,
            expect.objectContaining({
                surface: 'ui',
                externalActionTarget: { kind: 'machine', machineId: 'machine-1' },
            }),
        );
    });

});
