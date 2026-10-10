import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol/actions';
import { projectWork } from '@/components/sessions/work/workProjection';
import { createActionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { createActionOperationSelectors } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { registerMountedWorkReadOwner, invokeMountedWorkRead } from './mountedWorkReadAction';

describe('mounted canonical Work reads', () => {
    it('reads the canonical projection through the Action boundary and fences retirement, exact scope and unmount', async () => {
        let current = true;
        const operations = createActionOperationStore();
        operations.mergeSnapshots({ serverId: 'home-a', snapshots: [{
            version: 1, operationId: 'command', revision: 1, actionId: 'projects.script.run',
            state: 'accepted', scope: { accountId: 'account-a', machineId: 'machine', sessionId: 'lead' },
            title: 'Build', createdAt: 1, cancellation: 'supported',
            domainRef: { kind: 'projectCommand', purpose: 'script', serverId: 'target-home',
                machineId: 'private-target-machine', workspaceRefId: 'workspace', cwd: '/repo' },
        }] });
        const projection = projectWork({
            sessionId: 'lead', reportSessions: [], agentEntries: [], workflowHeadlineRuns: [],
            serverId: 'home-a', accountId: 'account-a',
            actionOperations: createActionOperationSelectors().selectForSession(operations.getSnapshot(),
                { serverId: 'home-a', accountId: 'account-a', sessionId: 'lead' }),
            describeOperationStatus: () => 'Running',
            managedRuns: [{ run: { id: 'run-a', state: 'running' }, title: 'Review', word: 'Running', needsAttention: true }],
            ownTriggerRunIds: new Set(), describeAgentStatus: () => '', describeProgress: () => '',
        });
        const remove = registerMountedWorkReadOwner({
            scope: { serverId: 'home-a', accountId: 'account-a' }, sessionId: 'lead',
            isCurrent: () => current,
            read: () => ({ projection, transcriptLoaded: true, managedRuns: { phase: 'loaded', refreshFailed: false } }),
        });
        const executor = createActionExecutor({
            appShellAction: invokeMountedWorkRead,
        } as unknown as ActionExecutorDeps);
        const context = { surface: 'agent' as const, authority: 'account_automation' as const,
            serverId: 'home-a', runtimeAccountId: 'account-a' };
        try {
            const result = await executor.execute('session.work.get', { sessionId: 'lead' }, context);
            expect(result).toMatchObject({ ok: true, result: { status: 'ready', summary: projection.summary,
                items: expect.arrayContaining([expect.objectContaining({ key: 'run:run-a', title: 'Review', status: projection.workflows[0]!.status }),
                    expect.objectContaining({ key: projection.projectCommands[0]!.key,
                        open: projection.projectCommands[0]!.open })]) } });
            const serialized = JSON.stringify(result);
            expect(serialized).not.toContain('domainRef');
            expect(serialized).not.toContain('private-target-machine');
            expect(serialized).not.toContain('retry');
            for (const mismatch of [{ serverId: 'home-b' }, { runtimeAccountId: 'account-b' }]) {
                await expect(executor.execute('session.work.get', { sessionId: 'lead' }, { ...context, ...mismatch }))
                    .resolves.toMatchObject({ ok: true, result: { status: 'unavailable' } });
            }
            await expect(executor.execute('session.work.get', { sessionId: 'other' }, context))
                .resolves.toMatchObject({ ok: true, result: { status: 'unavailable' } });
            current = false;
            await expect(executor.execute('session.work.get', { sessionId: 'lead' }, context))
                .resolves.toMatchObject({ ok: true, result: { status: 'unavailable' } });
        } finally { remove(); }
        await expect(executor.execute('session.work.get', { sessionId: 'lead' }, context))
            .resolves.toMatchObject({ ok: true, result: { status: 'unavailable' } });
    });

    it('never describes absent sources or a first read as an empty ready projection', async () => {
        const projection = projectWork({ sessionId: 'lead', reportSessions: [], agentEntries: [],
            workflowHeadlineRuns: [], managedRuns: [], ownTriggerRunIds: new Set(),
            describeAgentStatus: () => '', describeProgress: () => '' });
        const remove = registerMountedWorkReadOwner({ scope: { serverId: 'home', accountId: 'account' },
            sessionId: 'lead', isCurrent: () => true,
            read: () => ({ projection, transcriptLoaded: false, managedRuns: { phase: 'loading', refreshFailed: false } }) });
        try {
            expect(await invokeMountedWorkRead({ actionId: 'session.work.get', input: { sessionId: 'lead' },
                context: { surface: 'ui', serverId: 'home', runtimeAccountId: 'account' } }))
                .toMatchObject({ status: 'loading' });
        } finally { remove(); }
    });

    it('does not disclose a snapshot when its captured owner retires while reading', async () => {
        let current = true;
        const projection = projectWork({ sessionId: 'lead', reportSessions: [], agentEntries: [],
            workflowHeadlineRuns: [], managedRuns: [], ownTriggerRunIds: new Set(),
            describeAgentStatus: () => '', describeProgress: () => '' });
        const remove = registerMountedWorkReadOwner({ scope: { serverId: 'home', accountId: 'account' },
            sessionId: 'lead', isCurrent: () => current,
            read: () => { current = false; return { projection, transcriptLoaded: true, managedRuns: { phase: 'loaded', refreshFailed: false } }; } });
        try {
            expect(await invokeMountedWorkRead({ actionId: 'session.work.get', input: { sessionId: 'lead' },
                context: { surface: 'ui', serverId: 'home', runtimeAccountId: 'account' } }))
                .toEqual({ status: 'unavailable' });
        } finally { remove(); }
    });

    it('shares an exact producer address across equivalent mounts and accepts proven empty work', async () => {
        const projection = projectWork({ sessionId: 'lead', reportSessions: [], agentEntries: [],
            workflowHeadlineRuns: [], managedRuns: [], ownTriggerRunIds: new Set(),
            describeAgentStatus: () => '', describeProgress: () => '' });
        const owner = { scope: { serverId: 'home', accountId: 'account' }, sessionId: 'lead', isCurrent: () => true,
            read: () => ({ projection, transcriptLoaded: true, managedRuns: { phase: 'loaded' as const, refreshFailed: false } }) };
        const first = registerMountedWorkReadOwner(owner);
        const second = registerMountedWorkReadOwner({ ...owner });
        const read = () => invokeMountedWorkRead({ actionId: 'session.work.get', input: { sessionId: 'lead' },
            context: { surface: 'ui', serverId: 'home', runtimeAccountId: 'account' } });
        try {
            expect(await read()).toMatchObject({ status: 'ready', items: [], summary: projection.summary });
            first();
            expect(await read()).toMatchObject({ status: 'ready', items: [], summary: projection.summary });
            second();
            expect(await read()).toEqual({ status: 'unavailable' });
        } finally { first(); second(); }
    });
});
