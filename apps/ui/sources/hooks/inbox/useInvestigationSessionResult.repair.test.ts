import { afterEach, expect, it, vi } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { ApprovalRequestSchema, type ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { decideApprovalRequestTransition } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { ActionOperationSnapshotV1Schema } from '@happier-dev/protocol/actions/operations/v1';
import { ScmPullRequestOpenOrReuseResponseSchema } from '@happier-dev/protocol/scm/pullRequests';
import { createReducer } from '@happier-dev/session-core/reducer';
import type { Message } from '@happier-dev/session-core/messages';
import { createDeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { WorkflowRunStartRequestV1Schema, WorkflowRunStartResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { act, renderHook, flushHookEffects, standardCleanup, createSessionFixture } from '@/dev/testkit';
import { createActionExecutorBoundaryFixture, createUiActionExecutorBoundary } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { buildGuidedAutomationRequest } from '@/components/workflows/triggers/guidedAutomation';
import { createDefaultWhen } from '@/components/workflows/triggers/sessionTriggerForm';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { storage } from '@/sync/domains/state/storageStore';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { projectOperationsRunOutcome } from '@/sync/domains/workflows/operationsRunOutcome';
import { presentOperationsOutcomeRows } from '@/components/workflows/run/operationsOutcomeRows';
import { createAccountNoticeInvestigation } from './accountNoticeInvestigation';
import { useInvestigationSessionResult } from './useInvestigationSessionResult';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: (text: string) => [{ text, reveal: false }],
}));
await loadSyncSingletonForTests();
afterEach(standardCleanup);

function tool(id: string, actionId: string, result: unknown): Message {
    return { kind: 'tool-call', id, localId: null, createdAt: 10, children: [],
        tool: { name: 'mcp__happier__action_execute', state: 'completed',
            input: { actionId, input: {} }, result: { ok: true, result },
            createdAt: 10, startedAt: 10, completedAt: 11, description: null } };
}

it('carries a linked repair journey through proposal, command evidence, redeploy and independent health', async () => {
    const { runTriageConfiguredHandoffV1 } = await import('../../../../../packages/plugins/triage/src/sessions/configuredActionRun');
    const { TriageRunConfiguredActionInputV1Schema } = await import('../../../../../packages/plugins/triage/src/actions/configuredActionRunProtocol');
    const { TriageLinkEntryToSessionInputV1Schema } = await import('../../../../../packages/plugins/triage/src/actions/sessionLinksProtocol');
    const { createTestkitCorpusCollections } = await import('../../../../../packages/plugins/triage/src/corpus/testkit/corpusCollections.test-support');
    const { createTestkitEmptyInternalTaskSource } = await import('../../../../../packages/plugins/triage/src/corpus/testkit/internalTaskSource.test-support');
    const { createTestkitSourceSessionRelations, readTestkitSourceSessionLinks, createTestkitActionInvoker,
        spawnSuccess, testkitTriageActionId } = await import('../../../../../packages/plugins/triage/src/sessions/testkit/entrySessionTestkit.test-support');
    const { buildAgentTargetKeyV2 } = await import('@happier-dev/plugin-sdk/agents');
    const before = storage.getState();
    const scope = { serverId: 'home', accountId: 'account' };
    const receipt = { ...createDeploymentReceiptDetailV1().deployment, state: 'failed' as const };
    const subject = { kind: 'deploymentReceipt', serverId: scope.serverId,
        environmentId: receipt.environmentId, deploymentId: receipt.id } as const;
    const machine = { serverId: scope.serverId, machineId: 'machine' };
    const workspace = { ...machine, workspaceId: 'workspace', rootPath: '/repo' };
    const agentTarget = { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } as const;
    const targetKey = buildAgentTargetKeyV2(agentTarget);
    const { collections } = createTestkitCorpusCollections({ accountEncryptionMode: 'e2ee' });
    const contributions = [createTestkitEmptyInternalTaskSource().contribution];
    const relations = createTestkitSourceSessionRelations({ collections, contributions });
    const invoker = createTestkitActionInvoker({ spawn: [spawnSuccess({ sessionId: 'repair' })],
        send: [{ status: 'accepted', localId: 'diagnostic-input' }] });
    const host = {
        version: () => ({ methods: [] }),
        context: async () => ({ accountScope: scope }),
        // Host RPC and Session process are boundaries; configured handoff and Corpus links remain real.
        executeAction: async (id: string, input: import('@happier-dev/plugin-sdk').JsonValue) => {
            const localId = testkitTriageActionId(id);
            if (localId === 'actions/read-v1') return { v: 1, availability: 'parsed', revision: '1', actions: [{
                actionId: 'investigate', label: 'Investigate', enabled: true, appliesTo: ['issue'], profileId: null,
                workspaceMode: 'reference_only', target: { kind: 'agent', promptInvocationId: null,
                    seededFallbackInstruction: 'Investigate the exact failure. Read its masked logs, health and code; report uncertainty and the next useful action.', delivery: 'send' },
            }] };
            if (localId === 'sessions/link-entry-v1') {
                const link = TriageLinkEntryToSessionInputV1Schema.parse(input);
                return { v: 1, status: (await relations.write({ ...link, linked: true })).status };
            }
            if (id === 'deployments.receipts.get') return { ok: true, deployment: { ...receipt,
                id: subject.deploymentId, environmentId: subject.environmentId,
                acceptedExecution: { v: 1, controller: { machineId: machine.machineId, installationId: 'installation' } } } };
            if (id === 'artifact.get') return { artifact: null };
            if (id === 'agents.backends.list') return { items: [{ targetKey, agentTarget, enabled: true }] };
            if (id === 'localServices.launcher.snapshot') return { v: 1, machineId: machine.machineId, updatedAt: 1, targets: [] };
            if (id === 'projects.list') return { items: [{ projectKey: { id: workspace.workspaceId }, ...machine,
                rootPath: workspace.rootPath, sourceId: 'project-source', reachable: true, worktrees: [] }], truncated: false };
            return invoker.execute(id as Parameters<typeof invoker.execute>[0], input as Parameters<typeof invoker.execute>[1]);
        },
    };
    let stored: ApprovalRequest | null = null;
    const requests = new Map<string, ApprovalRequest>();
    const performed: unknown[] = [];
    const started: unknown[] = [];
    const delivered: unknown[] = [];
    let approvalVersion = 0;
    const acceptedOperation = ActionOperationSnapshotV1Schema.parse({ version: 1, operationId: 'validation', revision: 1,
        actionId: 'projects.compute.exec', state: 'accepted', scope: { accountId: 'account', machineId: 'machine', sessionId: 'repair' },
        title: 'pnpm test:repair', createdAt: 1, cancellation: 'supported',
        domainRef: { kind: 'projectCommand', purpose: 'exec', serverId: 'home', machineId: 'machine',
            workspaceRefId: 'workspace', cwd: '/repo', terminalId: 'terminal' } });
    const publishApproval = (artifactId: string, request: ApprovalRequest) => {
        const header = buildApprovalRequestArtifactHeaderV1(request);
        approvalVersion += 1;
        storage.getState().applyArtifacts([{ id: artifactId, sourceServerId: 'home', header,
            title: typeof header.title === 'string' ? header.title : null,
            body: JSON.stringify(request), headerVersion: approvalVersion, bodyVersion: approvalVersion, seq: approvalVersion,
            createdAt: request.createdAtMs, updatedAt: request.updatedAtMs, isDecrypted: true }]);
    };
    // Artifact persistence, remote Workflow runtime and native command IO are external ports.
    const executor = createUiActionExecutorBoundary(createActionExecutorBoundaryFixture({
        readActionApprovalProfileId: async context => context.actionCaller?.kind === 'session' ? 'builtin:read-propose' : null,
        isApprovalExecutionOriginCurrent: async () => true,
        approvalsCreate: async ({ request }) => {
            stored = ApprovalRequestSchema.parse(request);
            const artifactId = 'approval';
            requests.set(artifactId, stored);
            publishApproval(artifactId, stored);
            return { artifactId };
        },
        approvalsGet: async ({ artifactId }) => requests.get(artifactId) ?? null,
        approvalsUpdate: async ({ artifactId, request }) => {
            const current = requests.get(artifactId);
            if (!current) throw new Error('Missing repair approval');
            const transition = decideApprovalRequestTransition(current, request);
            if (!transition.ok) return transition;
            stored = ApprovalRequestSchema.parse(request);
            requests.set(artifactId, stored);
            publishApproval(artifactId, stored);
            return { ok: true };
        },
        projectAction: async request => {
            performed.push(request);
            return { operation: acceptedOperation };
        },
        sessionSendMessage: async request => {
            delivered.push(request);
            return { status: 'accepted', localId: request.localId };
        },
        workflowAction: async request => {
            if (request.actionId !== 'workflow.run.start') throw new Error('Unexpected Workflow Action');
            const input = WorkflowRunStartRequestV1Schema.parse(request.input);
            started.push({ input, approvalProfileId: request.context.approvalProfileId });
            return WorkflowRunStartResultV1Schema.parse({ admission: 'created', run: createWorkflowRunSummaryFixture({
                id: input.runId, machineId: 'machine', ownerAccountId: 'account',
                origin: { kind: 'direct' },
            }) });
        },
        invokeContributedAction: async request => {
            if (request.action.localId === 'sessions/read-source-links-v1') return { ok: true,
                result: await readTestkitSourceSessionLinks(request.input, { collections, contributions }) };
            const input = TriageRunConfiguredActionInputV1Schema.parse(request.input);
            if (!('handoff' in input)) throw new Error('Expected public failure handoff');
            // Host fixture supplies only the RPC ports this finite configured handoff uses.
            return { ok: true, result: await runTriageConfiguredHandoffV1(
                host as unknown as Parameters<typeof runTriageConfiguredHandoffV1>[0], input.handoff,
                { entries: [], signal: new AbortController().signal }) };
        },
    }), scope.accountId);
    const execute = createFrontDoorActionExecute(executor);
    const owner = createAccountNoticeInvestigation({ scope, isCurrent: () => true,
        execute });
    const session = createSessionFixture({ id: 'repair', serverId: scope.serverId,
        encryptionMode: 'e2ee', encryptedContentAvailability: 'ready', latestTurnId: 'review', latestTurnStatus: 'completed',
        sessionTurns: { v: 1, sessionId: 'repair', updatedAt: 40, turns: [{ turnId: 'review', startedAt: 1,
            updatedAt: 40, status: 'completed', transcriptAnchors: { finalAssistantMessageSeq: 40 } }] } });
    const report: Message = { kind: 'agent-text', id: 'review', seq: 40, createdAt: 40, localId: null,
        text: 'Investigator: missing input. Fixer: repaired. Reviewer ran pnpm test:repair: exit 0. Skipped browser check: no browser. Recovery unverified.' };
    const compose = tool('compose', 'scm.pullRequest.openOrReuse', { success: true,
        result: 'opened_compose', composeUrl: 'https://github.com/org/repo/compare/repair', nextAction: { kind: 'none' } });
    const messages: Message[] = [compose, report];
    const publish = (revision: number) => {
        const byId = Object.fromEntries(messages.map(message => [message.id, message]));
        storage.setState({ sessionMessages: { repair: { messageIdsOldestFirst: messages.map(message => message.id),
            messagesById: byId, messagesMap: byId, reducerState: createReducer(), latestThinkingMessageId: null,
            latestThinkingMessageActivityAtMs: null, messagesVersion: revision, transcriptStructureVersion: revision, isLoaded: true } } });
    };
    storage.setState({ profileScope: scope, isDataReady: true, sessions: { repair: session },
        sessionListRowsByServerId: { home: { repair: buildSessionListRenderableFromSession(session) } } });
    publish(1);
    try {
        const investigation = await owner.run(subject, { configuredActionId: 'investigate', sessionChoice: { kind: 'new' },
            agentChoice: { kind: 'target', targetKey }, delivery: 'configured' }, { placement: { machine, workspace } });
        expect(investigation, JSON.stringify({ investigation, sessionBoundaryCalls: invoker.calls })).toMatchObject({ ok: true,
            result: { handoff: { kind: 'sendResult', result: { status: 'accepted' } } } });
        const guided = buildGuidedAutomationRequest({ when: createDefaultWhen('schedule'),
            lookAt: ['logs', 'receipts', 'health'], mode: 'chain', channels: [],
            selection: { agentTarget },
            approvalProfileId: 'builtin:read-propose',
        }, { subjectName: 'Production', project: { machineId: 'machine', directory: '/repo' } });
        if (guided?.target.kind !== 'inline') throw new Error('Expected guided repair chain');
        // This deliberate repair reuses the already linked Session; automatic triggers retain their own defaults.
        const start = WorkflowRunStartRequestV1Schema.parse({ runId: '11111111-1111-4111-8111-111111111111',
            source: { kind: 'inline', definition: { ...guided.target.definition,
                defaults: { ...guided.target.definition.defaults,
                    conversation: { kind: 'existing_session', sessionId: 'repair', machineId: 'machine' } } } },
            inputs: guided.inputs, executionTarget: guided.executionTarget });
        expect(await execute.confirmed('workflow.run.start', start, {
            surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
            serverId: 'home', runtimeAccountId: 'account', actionRequestId: 'repair-chain',
            approvalProfileId: guided.approvalProfileId,
        })).toMatchObject({ ok: true, result: { admission: 'created', run: { id: start.runId } } });
        // The designed Confirm admits this start; the inherited profile governs subsequent agent Actions.
        expect(started).toEqual([{ input: start, approvalProfileId: 'builtin:read-propose' }]);
        expect(start.source.kind === 'inline' && start.source.definition).toMatchObject({
            defaults: { conversation: { kind: 'existing_session', sessionId: 'repair', machineId: 'machine' } },
            blocks: expect.arrayContaining([expect.objectContaining({ kind: 'step' })]),
        });
        expect(guided.target.definition.blocks).toHaveLength(3);
        const hook = await renderHook(() => useInvestigationSessionResult(owner, subject, null));
        await flushHookEffects();
        const outcome = () => {
            const finding = hook.getCurrent();
            if (!finding) throw new Error('Missing linked repair Session');
            return projectOperationsRunOutcome({ subject, finding: { kind: 'investigate', ...finding },
                produced: finding.produced, subjectReceipt: receipt });
        };
        expect(outcome().produced.pullRequests).toEqual([]); // Prose never establishes a PR or passing check.
        let commandProposal: Awaited<ReturnType<typeof execute>> | undefined;
        await act(async () => {
            commandProposal = await execute('projects.compute.exec', {
                workspace: { serverId: 'home', workspaceId: 'workspace', machineId: 'machine', rootPath: '/repo' },
                executable: 'pnpm', argv: ['test:repair'], cwd: '/repo', choice: { kind: 'primary' },
            }, { surface: 'agent', authority: 'account_automation',
                actionCaller: { kind: 'session', sessionId: 'repair', starterDepth: 0, turnDepth: 0 },
                serverId: 'home', runtimeAccountId: 'account', actionRequestId: 'repair-command',
                defaultSessionId: 'repair', defaultSessionMachineId: 'machine',
                actionsSettings: ActionsSettingsV1Schema.parse({ v: 1 }) });
            expect(commandProposal).toMatchObject({ ok: true,
                    result: { kind: 'approval_request_created', artifactId: 'approval',
                        approvalProfile: { effectiveId: 'builtin:read-propose' } } });
        });
        expect(ApprovalRequestSchema.parse(stored)).toMatchObject({ status: 'open', actionId: 'projects.compute.exec',
            executionOriginV1: { approvalProfileId: 'builtin:read-propose' } });
        expect(performed).toEqual([]);
        expect(storage.getState().artifactApprovalArtifactsBySessionId.repair?.approval).toBeDefined();
        expect(outcome().proposal.approval?.artifactId).toBe('approval');
        expect(outcome().produced.operations).toEqual([]); // A requested approval has not executed.
        if (!commandProposal?.ok) throw new Error('Expected admitted command proposal');
        messages.push(tool('approval', 'projects.compute.exec', commandProposal.result));
        await act(async () => publish(2));
        expect(outcome().produced.approvals).toHaveLength(1); // Artifact and later tool acknowledgement are one request.
        await act(async () => {
            const decided = await execute('approval.request.decide', { artifactId: 'approval', decision: 'approve' }, {
                surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
                serverId: 'home', runtimeAccountId: 'account',
            });
            expect(decided, JSON.stringify(decided)).toMatchObject({ ok: true });
            const execution = ApprovalRequestSchema.parse(requests.get('approval')).execution;
            expect(execution).toMatchObject({ ok: true, result: { operation: { state: 'accepted' } } });
            messages.push(tool('command', 'projects.compute.exec', execution?.result));
            publish(3);
        });
        expect(performed).toMatchObject([{ actionId: 'projects.compute.exec',
            input: { executable: 'pnpm', argv: ['test:repair'], cwd: '/repo' } }]);
        expect(delivered).toMatchObject([{ sessionId: 'repair', localId: 'approval-result:approval' }]);
        expect(ApprovalRequestSchema.parse(stored).status).toBe('executed');
        expect(outcome().proposal.approval?.artifactId).toBe('approval');
        messages.unshift(tool('pr', 'scm.pullRequest.openOrReuse', ScmPullRequestOpenOrReuseResponseSchema.parse({ success: true,
            result: 'created', nextAction: { kind: 'none' }, pullRequest: {
                provider: { id: 'happier.scm.forge.github/github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                number: 3, title: 'Fix missing input', url: 'https://github.com/org/repo/pull/3',
                baseBranch: 'main', headBranch: 'repair', state: 'open' } })));
        const operation = ActionOperationSnapshotV1Schema.parse({ version: 1, operationId: 'validation', revision: 2,
            actionId: 'projects.compute.exec', state: 'succeeded', scope: { accountId: 'account', machineId: 'machine', sessionId: 'repair' },
            title: 'pnpm test:repair', createdAt: 1, startedAt: 2, settledAt: 3, cancellation: 'supported',
            domainRef: { kind: 'projectCommand', purpose: 'exec', serverId: 'home', machineId: 'machine',
                workspaceRefId: 'workspace', cwd: '/repo', terminalId: 'terminal', exitCode: 0 } });
        messages.push(tool('validation', 'wait', { target: { kind: 'action_operation', serverId: 'home', machineId: 'machine', operationId: 'validation' },
            condition: { kind: 'terminal' }, disposition: 'matched', snapshot: operation }));
        await act(async () => publish(4));
        expect(outcome().proposal.pullRequest?.number).toBe(3);
        expect(outcome().produced.operations[0]?.snapshot).toMatchObject({ title: 'pnpm test:repair', domainRef: { exitCode: 0 } });
        expect(outcome().recovery.kind).toBe('unavailable');
        messages.push(tool('redeploy', 'deployments.deploy', { ok: true, environmentId: receipt.environmentId,
            revision: 2, deploymentId: 'new-receipt', deploymentRevision: 1, state: 'succeeded' }));
        await act(async () => publish(5));
        const result = outcome();
        expect(result.appliedEffect.receiptReference).toMatchObject({ serverId: 'home', deploymentId: 'new-receipt', state: 'succeeded' });
        expect(result.recovery.kind).toBe('unavailable');
        const rows = presentOperationsOutcomeRows(result);
        expect(rows.find(row => row.key === 'proposal')?.links.map(link => link.kind)).toEqual(['pullRequest', 'approval']);
        expect(rows.find(row => row.key === 'applied')?.links).toContainEqual(expect.objectContaining({ kind: 'receipt', serverId: 'home',
            environmentId: receipt.environmentId, deploymentId: 'new-receipt' }));
        expect(rows[0]?.links[0]).toMatchObject({ kind: 'operation' });
        expect(projectOperationsRunOutcome({ subject, finding: result.finding, produced: result.produced, subjectReceipt: receipt,
            healthServerId: 'home', health: { environmentId: receipt.environmentId, status: 'ready', members: [],
                aggregate: { environmentId: receipt.environmentId, targetLinkId: receipt.targetLinkId, status: 'up', n: 1, down: 0, degraded: 0 } } }).recovery)
            .toMatchObject({ kind: 'observed', health: { status: 'up' } });
        expect(hook.getCurrent()?.result.preview).toMatchObject({ text: report.text });
        const produced = hook.getCurrent()?.produced;
        await act(async () => {
            const transcript = storage.getState().sessionMessages.repair!;
            storage.setState({ sessionMessages: { repair: { ...transcript, messagesVersion: 6,
                messagesById: { ...transcript.messagesById, review: { ...report, text: 'Reviewer: browser check still skipped.' } } } } });
        });
        expect(hook.getCurrent()?.produced).toBe(produced); // Text streaming does not rebuild structural result evidence.
        await hook.unmount();
    } finally {
        owner.dispose(); storage.setState(before);
    }
});
