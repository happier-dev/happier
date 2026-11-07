import { describe, expect, it, vi } from 'vitest';

vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
import { createActionExecutor, ActionsSettingsV1Schema, isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions';
import { AppShellActionOutputSchemas } from '@happier-dev/protocol/actions/appShellActionFamily';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { projectWork } from '@/components/sessions/work/workProjection';
import { createActionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { createActionOperationSelectors } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { registerMountedWorkReadOwner, invokeMountedWorkRead } from './mountedWorkReadAction';
import { registerMountedInboxReadOwner } from './mountedWorkReadAction';
import { ApprovalRequestV2Schema} from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1} from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { buildInboxWorkGroups } from '@/activity/presentation/buildInboxWorkGroups';
import { createAutomationRunFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { createInboxAttentionFixture } from '@/dev/testkit/fixtures/inboxFixtures';
import { workflowRunRowFromAutomationRun } from '@/sync/store/domains/workflowRuns';
import type { InboxModel } from '@/hooks/inbox/useInboxModel';
import { createAccountNoticeInvestigation } from '@/hooks/inbox/accountNoticeInvestigation';
import { createFrontDoorActionExecute as createFixtureActionExecute } from './frontDoorRuntimeActionExecutor';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { readOpenApprovalInboxEntry } from '@/sync/domains/artifacts/approvalArtifactAdmission';
import { serveSessionActionHome } from '@/dev/testkit/harness/sessionActionHome';
import { SessionReadStateSetResultV1Schema } from '@happier-dev/protocol/sessions/readState/actions';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

it('acknowledges an exact Inbox address from voice through the production bulk-read owner', async () => {
    installDisconnectedServerSocketBoundary();
    const features = FeaturesResponseSchema.parse({ features: {}, capabilities: {} });
    const writes: unknown[] = [];
    const home = await serveSessionActionHome({
        homes: [{ key: 'session', serverUrl: 'https://session-actions.test', accountId: 'session-account', currentAccount: true }],
        route: request => {
            if (request.path === '/v1/features') return Response.json(features);
            if (request.method !== 'POST' || request.path !== '/v2/sessions/worker/read-state') return undefined;
            writes.push({ accountId: request.accountId, body: request.body });
            return Response.json({ success: true, ...SessionReadStateSetResultV1Schema.parse({
                state: 'read', lastViewedSessionSeq: 12, didChange: true,
            }) });
        },
    });
    const disconnect = await home.restoreActiveConnection();
    const { createFrontDoorActionExecute } = await import('./frontDoorRuntimeActionExecutor');
    try {
        const response = await createFrontDoorActionExecute()('inbox.mark_all_read', {
            targets: [{ serverId: home.serverId, sessionId: 'worker' }],
        }, { surface: 'voice', serverId: home.serverId, runtimeAccountId: 'session-account' });
        expect(response).toEqual({ ok: true, result: {
            results: [{ serverId: home.serverId, sessionId: 'worker', status: 'succeeded' }],
        } });
        if (!response.ok) throw new Error('Expected voice Inbox acknowledgement');
        expect(AppShellActionOutputSchemas['inbox.mark_all_read'].parse(response.result)).toEqual(response.result);
        expect(writes).toEqual([{ accountId: 'session-account', body: { state: 'read' } }]);
    } finally { await disconnect(); await home.dispose(); }
});

it('reads approval and Automation rows from the canonical Inbox grouping without disclosing their private content', async () => {
    const home = await serveSessionActionHome();
    const serverId = home.serverId;
    const run = createAutomationRunFixture({ id: 'weekly-run' });
    const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
        createdBy: { surface: 'agent', sessionId: 'step' }, requestedSurface: 'agent',
        actionId: 'session.title.set', actionArgs: { sessionId: 'step', title: 'Private approval content' }, summary: 'Set title',
        executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent', serverId,
            caller: { kind: 'automationRun', automationId: run.automationId, runId: run.id,
                cause: { kind: 'manual', invokedAt: 1 } }, runId: run.id, sessionId: 'step',
            actionId: 'session.title.set', requestId: 'request-1' } });
    const approval: DecryptedArtifact = { id: 'approval-1', title: 'Set title',
        header: buildApprovalRequestArtifactHeaderV1(request), body: JSON.stringify(request), sessions: ['step'],
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1, isDecrypted: true };
    const groups = buildInboxWorkGroups({ sessionEntries: [], workflowRuns: [],
        automationRuns: [workflowRunRowFromAutomationRun(run)], automationServerId: serverId, openApprovals: [readOpenApprovalInboxEntry(approval)!],
        stalledSessions: [], landings: [], snoozed: [], resolveSession: () => null, resolveOriginRunId: () => null });
    const model: InboxModel = {
        invokePluginSessionControl: async () => ({ kind: 'unavailable' }),
        source: { isDataReady: true, sessionsById: {}, sessionListRowsByServerId: {},
            ordinarySessionListMembershipByServerId: {}, sessionListIndexByServerId: {}, concurrentSessionListCacheByServerId: {} },
        ...createInboxAttentionFixture(serverId),
        noticeInvestigation: createAccountNoticeInvestigation({ scope: { serverId, accountId: 'session-account' },
            isCurrent: () => false, execute: createFixtureActionExecute() }),
        automationAttentionItems: [{ key: `automation-run:${run.id}`, run,
            route: `/workflows/runs/${run.id}?target=occurrence&automationId=${run.automationId}` }],
        openApprovals: [approval], openUsageNotices: [], friendRequests: [],
        sessionPresentation: { sessionsNeedingAttention: [], readySessions: [], markAllReadTargets: [], pendingRequestHydrationTargets: [] },
        workGroups: groups, targetBySessionAddress: new Map(), actionOperationEntries: [], pendingReadKeys: new Set(),
        readUnavailableReasonBySessionAddress: new Map(), markAllReadUnavailableReason: null,
        markAllPending: false, isLoading: false, hasPrimaryAttention: true, hasContent: true, showCaughtUp: false, spansHomes: false,
        dismissUsageNotice: async () => {}, markRead: async () => {}, resolveActionOperation: () => {},
        settle: async () => {}, setReminder: async () => {},
    };
    let current = true;
    let snapshot = model;
    const remove = registerMountedInboxReadOwner({ scope: { serverId, accountId: 'session-account' },
        isCurrent: () => current, read: () => snapshot });
    const context = { surface: 'voice' as const, serverId, runtimeAccountId: 'session-account' };
    const { createFrontDoorActionExecute } = await import('./frontDoorRuntimeActionExecutor');
    const execute = createFrontDoorActionExecute();
    try {
        const response = await execute('inbox.get', {}, context);
        expect(await execute('inbox.get', {}, { ...context, surface: 'cli' })).toEqual(response);
        expect(response.ok).toBe(true);
        if (!response.ok) throw new Error('Expected a readable mounted Inbox');
        const result = AppShellActionOutputSchemas['inbox.get'].parse(response.result);
        expect(result).toMatchObject({ status: 'ready', approvalIds: [approval.id], automationRunIds: [run.id],
            groups: [{ key: groups[0]!.key,
                root: { kind: 'automation', serverId, automationId: run.automationId, runId: run.id },
                items: [{ kind: 'automation_run', key: `automation-run:${run.id}`, runId: run.id },
                    { kind: 'approval', key: `approval:${approval.id}`, artifactId: approval.id }] }] });
        expect(JSON.stringify(result)).not.toContain('Private approval content');
        expect(JSON.stringify(result)).not.toContain('actionArgs');
        expect(await invokeMountedWorkRead({ actionId: 'inbox.get', input: {},
            context: { ...context, runtimeAccountId: 'different-account' } })).toEqual({ status: 'unavailable' });
        snapshot = { ...model, workGroups: [{ ...groups[0]!, root: { kind: 'automation', serverId: 'home-b',
            automationId: run.automationId, runId: run.id } }] };
        expect(await execute('inbox.get', {}, context)).toMatchObject({ ok: true, result: { status: 'ready', groups: [
            { root: { kind: 'automation', serverId: 'home-b', automationId: run.automationId, runId: run.id } },
        ] } });
        snapshot = model;
        current = false;
        expect(await invokeMountedWorkRead({ actionId: 'inbox.get', input: {}, context })).toEqual({ status: 'unavailable' });
        current = true;
        remove();
        expect(await execute('inbox.get', {}, context)).toMatchObject({ ok: true, result: { status: 'unavailable' } });
    } finally { remove(); await home.dispose(); }
});

describe('mounted canonical Work reads', () => {
    it('serves UI, CLI and voice reads through the production App shell binding and withdraws them on unmount', async () => {
        const home = await serveSessionActionHome();
        const { createFrontDoorActionExecute } = await import('./frontDoorRuntimeActionExecutor');
        const execute = createFrontDoorActionExecute();
        const scope = { serverId: home.serverId, accountId: 'session-account' };
        const projection = projectWork({ sessionId: 'lead', reportSessions: [], agentEntries: [],
            workflowHeadlineRuns: [], managedRuns: [], ownTriggerRunIds: new Set(),
            describeAgentStatus: () => '', describeProgress: () => '' });
        let reads = 0;
        const remove = registerMountedWorkReadOwner({ scope, sessionId: 'lead', isCurrent: () => true,
            read: () => { reads += 1; return { projection, transcriptLoaded: true,
                managedRuns: { phase: 'loaded', refreshFailed: false } }; } });
        try {
            for (const surface of ['ui', 'cli', 'voice'] as const) {
                const response = await execute('session.work.get', { sessionId: 'lead' },
                    { surface, serverId: scope.serverId, runtimeAccountId: scope.accountId });
                expect(response).toMatchObject({ ok: true, result: { status: 'ready', items: [], summary: projection.summary } });
                if (!response.ok) throw new Error('Expected production App shell Work binding');
                expect(AppShellActionOutputSchemas['session.work.get'].parse(response.result)).toEqual(response.result);
            }
            const settings = ActionsSettingsV1Schema.parse({ v: 1,
                actions: { 'session.work.get': { approvalRequiredSurfaces: ['voice'] } } });
            const approved = createActionExecutor(createActionExecutorBoundaryFixture({
                appShellAction: invokeMountedWorkRead, isActionApprovalRequired: (id, context) =>
                    isApprovalRequiredByActionsSettings(id, settings, context),
            }));
            const beforeApproval = reads;
            const voiceContext = { surface: 'voice' as const, authority: 'account_automation' as const,
                serverId: scope.serverId, runtimeAccountId: scope.accountId };
            expect(await approved.execute('session.work.get', { sessionId: 'lead' }, voiceContext))
                .toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
            expect(reads).toBe(beforeApproval);
            expect(await approved.execute('session.work.get', { sessionId: 'lead' }, { ...voiceContext, bypassApprovals: true }))
                .toMatchObject({ ok: true, result: { status: 'ready', summary: projection.summary } });
            remove();
            expect(await execute('session.work.get', { sessionId: 'lead' },
                { surface: 'voice', serverId: scope.serverId, runtimeAccountId: scope.accountId }))
                .toMatchObject({ ok: true, result: { status: 'unavailable' } });
        } finally { remove(); await home.dispose(); }
    });

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
            managedRuns: [{ run: { id: 'run-a', state: 'running', workflowCustodyState: null,
                attentionRequired: true, invocationAttentionRequired: true, failureUnseen: false },
                title: 'Review', word: 'Running' }],
            ownTriggerRunIds: new Set(), describeAgentStatus: () => '', describeProgress: () => '',
        });
        const remove = registerMountedWorkReadOwner({
            scope: { serverId: 'home-a', accountId: 'account-a' }, sessionId: 'lead',
            isCurrent: () => current,
            read: () => ({ projection, transcriptLoaded: true, managedRuns: { phase: 'loaded', refreshFailed: false } }),
        });
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            appShellAction: invokeMountedWorkRead,
        }));
        const context = { surface: 'agent' as const, authority: 'account_automation' as const,
            serverId: 'home-a', runtimeAccountId: 'account-a' };
        try {
            const result = await executor.execute('session.work.get', { sessionId: 'lead' }, context);
            expect(result.ok).toBe(true);
            if (!result.ok) throw new Error('Expected a readable mounted Work projection');
            expect(AppShellActionOutputSchemas['session.work.get'].parse(result.result)).toEqual(result.result);
            expect(result).toMatchObject({ ok: true, result: { status: 'ready', summary: projection.summary,
                items: expect.arrayContaining([expect.objectContaining({ key: 'run:run-a', title: 'Review', status: {
                    bucket: projection.workflows[0]!.status.bucket, tone: projection.workflows[0]!.status.tone,
                    word: projection.workflows[0]!.status.word,
                } }),
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
