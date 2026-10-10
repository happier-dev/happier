import { describe, expect, it } from 'vitest';

import {
    createAdmittedWorkflowRunRoute,
    createAutomationRunDetailRoute,
    createMachineExecutionRunRoute,
    createWorkflowInvocationRoute,
    createWorkflowRunRoute,
    readWorkflowInvocationId,
    readWorkflowRunId,
} from './workflowRunRoute';

describe('workflow Run routes', () => {
    it('builds exact encoded Run and invocation destinations', () => {
        expect(createWorkflowRunRoute('run/42 a')).toBe('/workflows/runs/run%2F42%20a');
        expect(createWorkflowInvocationRoute('run/42 a', 'invocation/7 b'))
            .toBe('/workflows/runs/run%2F42%20a?invocationId=invocation%2F7%20b');
    });

    it('retains an explicit Home without changing unqualified destinations', () => {
        expect(createWorkflowRunRoute('run/42 a', 'home/1 a'))
            .toBe('/workflows/runs/run%2F42%20a?serverId=home%2F1%20a');
        expect(createWorkflowRunRoute('run/42 a', null)).toBe('/workflows/runs/run%2F42%20a');
        expect(createWorkflowInvocationRoute('run/42 a', 'invocation/7 b', 'home/1 a'))
            .toBe('/workflows/runs/run%2F42%20a?invocationId=invocation%2F7%20b&serverId=home%2F1%20a');
    });

    it('routes attached and detached leaves through the existing machine Run inspector', () => {
        expect(createMachineExecutionRunRoute('server/1', 'machine/1', 'execution/run 1'))
            .toBe('/runs?serverId=server%2F1&machineId=machine%2F1&runId=execution%2Frun%201');
    });

    it('does not create an under-qualified machine Run destination', () => {
        expect(createMachineExecutionRunRoute('', 'machine-1', 'run-1')).toBeNull();
        expect(createMachineExecutionRunRoute('server-1', ' ', 'run-1')).toBeNull();
        expect(createMachineExecutionRunRoute('server-1', 'machine-1', '')).toBeNull();
    });

    it('opens the exact managed Run an admission receipt declared', () => {
        expect(createAdmittedWorkflowRunRoute({ recipeKind: 'workflow-v2', workflowRunId: 'run/42 a' }))
            .toBe('/workflows/runs/run%2F42%20a');
    });

    it('gives a legacy or malformed receipt no managed destination', () => {
        // Absence is the legacy one-shot Automation contract, not a reason to
        // look for a newest-history row.
        expect(createAdmittedWorkflowRunRoute(undefined)).toBeNull();
        expect(createAdmittedWorkflowRunRoute({ recipeKind: 'workflow-v2', workflowRunId: '' })).toBeNull();
        expect(createAdmittedWorkflowRunRoute({ recipeKind: 'workflow-v2', workflowRunId: ' run-7' })).toBeNull();
    });

    it('opens a managed Automation history row in the one shared Run body', () => {
        // `targetType: null` is the definition owner's own contract for a strict
        // managed-workflow recipe, and the admission receipt binds the workflow
        // Run id to the Automation Run id — so this is a declared fact, not an
        // inference from recipe shape.
        expect(createAutomationRunDetailRoute({
            automationId: 'automation-1', runId: 'run-7', targetType: null,
        })).toEqual({ pathname: '/workflows/runs/[runId]', params: { runId: 'run-7' } });
    });

    it('keeps every other Automation target on the incumbent Run detail', () => {
        expect(createAutomationRunDetailRoute({
            automationId: 'automation-1', runId: 'run-7', targetType: 'spawn',
        })).toEqual({
            pathname: '/automations/[id]/runs/[runId]',
            params: { id: 'automation-1', runId: 'run-7' },
        });
        // A malformed id falls back rather than becoming Workflow navigation.
        expect(createAutomationRunDetailRoute({
            automationId: 'automation-1', runId: ' run-7', targetType: null,
        })).toEqual({
            pathname: '/automations/[id]/runs/[runId]',
            params: { id: 'automation-1', runId: ' run-7' },
        });
    });

    it('validates invocation ids supplied by route input', () => {
        expect(readWorkflowInvocationId('invocation-7')).toBe('invocation-7');
        expect(readWorkflowInvocationId('')).toBeNull();
        expect(readWorkflowInvocationId(7)).toBeNull();
    });

    it('preserves opaque route identities and rejects whitespace instead of trimming to valid', () => {
        expect(readWorkflowRunId('run-7')).toBe('run-7');
        expect(readWorkflowRunId(' run-7')).toBeNull();
        expect(readWorkflowRunId('run-7 ')).toBeNull();
        expect(readWorkflowInvocationId(' invocation-7')).toBeNull();
        expect(readWorkflowInvocationId('invocation-7 ')).toBeNull();
    });
});
