import { describe, expect, it } from 'vitest';

import {
    createAdmittedWorkflowRunRoute,
    createMachineExecutionRunRoute,
    createWorkflowInvocationRoute,
    createWorkflowRunListRowRoute,
    createWorkflowRunRoute,
    readWorkflowInvocationId,
    readWorkflowRunId,
    readWorkflowRunRouteTarget,
    readWorkflowRunTarget,
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

    it('addresses an occurrence on its source Home before the reader performs any I/O', () => {
        expect(createWorkflowRunRoute({ kind: 'occurrence', automationId: 'automation/1', runId: 'same-run' }, 'home-b'))
            .toBe('/workflows/runs/same-run?target=occurrence&automationId=automation%2F1&serverId=home-b');
        expect(createWorkflowRunRoute({ kind: 'occurrence', automationId: 'automation/1', runId: 'same-run' }))
            .toBe('/workflows/runs/same-run?target=occurrence&automationId=automation%2F1');
    });

    it('opens a Run row through the reader identified by its held origin', () => {
        expect(createWorkflowRunListRowRoute({ id: 'run-one', summary: { origin: { kind: 'automation', automationId: 'automatic' } }, automation: null }, 'home-b'))
            .toBe('/workflows/runs/run-one?target=occurrence&automationId=automatic&serverId=home-b');
        expect(createWorkflowRunListRowRoute({ id: 'run-one', summary: null, automation: { automationId: 'legacy' } }, 'home-b'))
            .toBe('/workflows/runs/run-one?target=occurrence&automationId=legacy&serverId=home-b');
        expect(createWorkflowRunListRowRoute({ id: 'run-one', summary: { origin: { kind: 'direct' } }, automation: null }, 'home-b'))
            .toBe('/workflows/runs/run-one?serverId=home-b');
    });

    it('reads back the exact Run and invocation its own routes address, and nothing else', () => {
        expect(readWorkflowRunRouteTarget(createWorkflowRunRoute('run/42 a', 'home/1')))
            .toEqual({ runId: 'run/42 a', invocationId: null });
        expect(readWorkflowRunRouteTarget(createWorkflowInvocationRoute('run/42 a', 'invocation/7 b', 'home/1')))
            .toEqual({ runId: 'run/42 a', invocationId: 'invocation/7 b' });
        expect(readWorkflowRunRouteTarget('/workflows/runs')).toBeNull();
        expect(readWorkflowRunRouteTarget('/workflows/new')).toBeNull();
        expect(readWorkflowRunRouteTarget('/session/abc')).toBeNull();
        expect(readWorkflowRunRouteTarget({ pathname: '/workflows/runs/[runId]' })).toBeNull();
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
        expect(createAdmittedWorkflowRunRoute({ recipeKind: 'workflow-v2', workflowRunId: 'run/42 a' }, 'home/b'))
            .toBe('/workflows/runs/run%2F42%20a?serverId=home%2Fb');
    });

    it('gives a legacy or malformed receipt no managed destination', () => {
        // Absence is the legacy one-shot Automation contract, not a reason to
        // look for a newest-history row.
        expect(createAdmittedWorkflowRunRoute(undefined)).toBeNull();
        expect(createAdmittedWorkflowRunRoute({ recipeKind: 'workflow-v2', workflowRunId: '' })).toBeNull();
        expect(createAdmittedWorkflowRunRoute({ recipeKind: 'workflow-v2', workflowRunId: ' run-7' })).toBeNull();
    });

    it('round-trips an occurrence without allowing a read failure to select the reader', () => {
        const target = { kind: 'occurrence', automationId: 'automation/1', runId: 'same-run' } as const;
        const url = new URL(createWorkflowRunRoute(target, 'home-b'), 'https://app.test');
        expect(readWorkflowRunTarget({ runId: decodeURIComponent(url.pathname.split('/').at(-1)!),
            ...Object.fromEntries(url.searchParams) })).toEqual(target);
        expect(readWorkflowRunTarget({ runId: 'same-run' })).toEqual({ kind: 'managed', runId: 'same-run' });
        for (const params of [
            { runId: 'same-run', target: 'other' },
            { runId: 'same-run', target: '' },
            { runId: 'same-run', target: null },
            { runId: 'same-run', target: 7 },
            { runId: 'same-run', target: 'occurrence' },
            { runId: 'same-run', automationId: 'automation/1' },
            { runId: ' same-run', target: 'occurrence', automationId: 'automation/1' },
        ]) expect(readWorkflowRunTarget(params)).toBeNull();
        expect(readWorkflowRunRouteTarget(createWorkflowRunRoute(target))).toBeNull();
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
