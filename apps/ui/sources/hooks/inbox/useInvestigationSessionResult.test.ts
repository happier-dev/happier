import { afterEach, expect, it, vi } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol/actions';
import { createReducer } from '@happier-dev/session-core/reducer';
import type { Message } from '@happier-dev/session-core/messages';
import { act, renderHook, standardCleanup, createSessionFixture } from '@/dev/testkit';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { storage } from '@/sync/domains/state/storageStore';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { presentOperationsOutcomeRows } from '@/components/workflows/run/operationsOutcomeRows';
import { projectOperationsRunOutcome } from '@/sync/domains/workflows/operationsRunOutcome';
import { createAccountNoticeInvestigation } from './accountNoticeInvestigation';
import { useInvestigationSessionResult } from './useInvestigationSessionResult';

vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: (text: string) => [{ text, reveal: false }],
}));
afterEach(standardCleanup);

it('composes one exact failed receipt through the public Action, chosen Agent and Machine, pushed finding and cold reopen', async () => {
    const { runTriageConfiguredHandoffV1 } = await import('../../../../../packages/plugins/triage/src/sessions/configuredActionRun');
    const { TriageRunConfiguredActionInputV1Schema } = await import('../../../../../packages/plugins/triage/src/actions/configuredActionRunProtocol');
    const { TriageLinkEntryToSessionInputV1Schema } = await import('../../../../../packages/plugins/triage/src/actions/sessionLinksProtocol');
    const { createTestkitCorpusCollections } = await import('../../../../../packages/plugins/triage/src/corpus/testkit/corpusCollections.test-support');
    const { createTestkitEmptyInternalTaskSource } = await import('../../../../../packages/plugins/triage/src/corpus/testkit/internalTaskSource.test-support');
    const { createTestkitSourceSessionRelations, readTestkitSourceSessionLinks, createTestkitActionInvoker,
        spawnSuccess, testkitTriageActionId } = await import('../../../../../packages/plugins/triage/src/sessions/testkit/entrySessionTestkit.test-support');
    const { buildAgentTargetKeyV2 } = await import('@happier-dev/plugin-sdk/agents');
    const { createDeploymentApprovalScopeResolverV1 } = await import('@happier-dev/protocol/deployments/deploymentApprovalScopeV1');
    const { DeploymentEnvironmentHeaderV1Schema } = await import('@happier-dev/protocol/deployments/deploymentActionsV1');
    const before = storage.getState();
    const scope = { serverId: 'home', accountId: 'account' };
    const subject = { kind: 'deploymentReceipt', serverId: scope.serverId, environmentId: 'env', deploymentId: 'failed-receipt' } as const;
    const machine = { serverId: scope.serverId, machineId: 'chosen-machine' };
    const workspace = { ...machine, workspaceId: 'checkout', rootPath: '/repos/app' };
    const agentTarget = { kind: 'agent', identity: { pluginId: 'happier.example.agent', localId: 'example' } } as const;
    const targetKey = buildAgentTargetKeyV2(agentTarget);
    const { collections } = createTestkitCorpusCollections({ accountEncryptionMode: 'e2ee' });
    const contributions = [createTestkitEmptyInternalTaskSource().contribution];
    const relations = createTestkitSourceSessionRelations({ collections, contributions });
    const invoker = createTestkitActionInvoker({ spawn: [spawnSuccess({ sessionId: 'investigation' })],
        send: [{ status: 'accepted', localId: 'diagnostic-input' }] });
    const reads: Array<{ id: string; input: unknown }> = [];
    const host = {
        version: () => ({ methods: [] }),
        context: async () => ({ accountScope: scope }),
        // Host Action RPC and Session process are the genuine plugin boundaries.
        // The configured handoff, placement and persisted relationship owners remain real.
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
            if (id === 'deployments.receipts.get') {
                reads.push({ id, input });
                return { ok: true, deployment: { id: subject.deploymentId, environmentId: subject.environmentId,
                    acceptedExecution: { v: 1, controller: { machineId: 'affected-controller', installationId: 'installation' } } } };
            }
            if (id === 'agents.backends.list') return { items: [{ targetKey, agentTarget, enabled: true }] };
            if (id === 'localServices.launcher.snapshot') return { v: 1, machineId: machine.machineId, updatedAt: 1, targets: [] };
            if (id === 'projects.list') return { items: [{ projectKey: { id: workspace.workspaceId }, ...machine,
                rootPath: workspace.rootPath, sourceId: 'project-source', reachable: true, worktrees: [] }], truncated: false };
            return invoker.execute(id as Parameters<typeof invoker.execute>[0], input as Parameters<typeof invoker.execute>[1]);
        },
    };
    const target = { environmentId: subject.environmentId, deploymentId: subject.deploymentId,
        targetLinkId: 'link', machineId: 'affected-controller', installationId: 'installation' };
    const service = { kind: 'deployment' as const, machineId: target.machineId, environmentId: target.environmentId,
        environmentInstanceId: 'instance', composeService: 'app', serviceId: 'instance/app' };
    const environment = DeploymentEnvironmentHeaderV1Schema.parse({ v: 1, id: subject.environmentId,
        serverId: scope.serverId, projectSourceId: 'project-source', revision: 1,
        owner: { kind: 'account', accountId: scope.accountId }, protection: 'nonProduction', purpose: 'standard',
        deployerMode: 'managers', controllerMachineId: target.machineId, runtimeTargetLinkId: target.targetLinkId,
        contentArtifactId: 'environment-content', contentHeaderVersion: 1, contentBodyVersion: 1,
        capabilities: { role: 'manager', read: true, deploy: true, manage: true, manageBindings: true, manageTargets: true, delete: true },
        createdByAccountId: scope.accountId, createdAtMs: 1, updatedAtMs: 1 });
    // Daemon and metadata transports are boundaries; scope resolution and Action policy stay real.
    const deploymentTransport: NonNullable<ActionExecutorDeps['deploymentAction']> = async (id, input) => {
            if (id === 'deployments.environments.get') return { ok: true, environment, targetLinks: [] };
            expect(input).toMatchObject({ serverId: scope.serverId, ...target });
            if (id === 'deployments.logs.read') return { ok: true, ...target, kind: 'build', logs: {
                kind: 'page', page: { sourceRevision: 'failed-build', text: 'PORT=3000 TOKEN=[REDACTED]', nextCursor: null, truncated: false } } };
            if (id === 'deployments.health.read') return { ok: true, ...target, service,
                observedAtMs: null, freshness: 'unavailable', native: null, health: 'unknown', evidence: [] };
            throw new Error(`Unexpected deployment diagnostic: ${id}`);
        };
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({
        deploymentAction: deploymentTransport,
        resolveEnvironmentApprovalScope: createDeploymentApprovalScopeResolverV1(deploymentTransport),
        filesystemActionExecute: async ({ input, context }) => {
            expect(context.externalActionTarget).toEqual({ kind: 'machine', machineId: machine.machineId });
            expect(input).toEqual({ rootPath: workspace.rootPath, path: 'compose.yaml' });
            return { success: true, content: 'services:\n  app:\n    ports: ["3000:3000"]' };
        },
        invokeContributedAction: async request => {
        if (request.action.localId === 'sessions/read-source-links-v1') return { ok: true,
            result: await readTestkitSourceSessionLinks(request.input, { collections, contributions }) };
        const input = TriageRunConfiguredActionInputV1Schema.parse(request.input);
        if (!('handoff' in input)) throw new Error('Expected public failure handoff');
        // Host API fixture supplies only the ports this finite handoff uses.
        return { ok: true, result: await runTriageConfiguredHandoffV1(host as unknown as Parameters<typeof runTriageConfiguredHandoffV1>[0],
            input.handoff, { entries: [], signal: new AbortController().signal }) };
    } }));
    const makeOwner = () => createAccountNoticeInvestigation({ scope, isCurrent: () => true, execute: createFrontDoorActionExecute(executor) });
    const owner = makeOwner();
    let hook: Awaited<ReturnType<typeof renderHook<ReturnType<typeof useInvestigationSessionResult>>>> | undefined;
    try {
        const started = await owner.run(subject, { configuredActionId: 'investigate', sessionChoice: { kind: 'new' },
            agentChoice: { kind: 'target', targetKey }, delivery: 'configured' }, { placement: { machine, workspace } });
        expect(started, JSON.stringify(started)).toMatchObject({ ok: true, result: { handoff: { kind: 'sendResult', result: { status: 'accepted' } } } });
        expect(reads).toEqual([{ id: 'deployments.receipts.get', input: { serverId: scope.serverId,
            environmentId: subject.environmentId, deploymentId: subject.deploymentId } }]);
        expect(invoker.callsFor('session.spawn_new')[0]?.input).toMatchObject({ executionTarget: machine, agentTarget,
            directory: { kind: 'path', path: workspace.rootPath } });
        const sent = JSON.stringify(invoker.callsFor('session.message.send')[0]?.input);
        expect(sent).toContain('deployments.receipts.get');
        expect(sent).toContain(subject.deploymentId);
        const running = createSessionFixture({ id: 'investigation', serverId: scope.serverId, encryptionMode: 'e2ee',
            encryptedContentAvailability: 'ready', latestTurnId: 'diagnostic', latestTurnStatus: 'in_progress',
            sessionTurns: { v: 1, sessionId: 'investigation', updatedAt: 1, turns: [{ turnId: 'diagnostic', startedAt: 1,
                updatedAt: 1, status: 'in_progress', transcriptAnchors: {} }] } });
        storage.setState({ profileScope: scope, sessions: { investigation: running },
            sessionListRowsByServerId: { home: { investigation: buildSessionListRenderableFromSession(running) } }, sessionMessages: {} });
        hook = await renderHook(() => useInvestigationSessionResult(owner, subject, started));
        expect(hook.getCurrent()?.result.output).toBeUndefined();
        // The external Agent uses the public readers; native masking/custody has a separate composed gate.
        const context = { surface: 'agent' as const, serverId: scope.serverId, defaultSessionId: running.id,
            externalActionTarget: { kind: 'machine' as const, machineId: machine.machineId } };
        const logs = await executor.execute('deployments.logs.read', { serverId: scope.serverId, ...target, kind: 'build' }, context);
        expect(logs, JSON.stringify(logs)).toMatchObject({ ok: true, result: { logs: { page: { text: 'PORT=3000 TOKEN=[REDACTED]' } } } });
        expect(await executor.execute('deployments.health.read', { serverId: scope.serverId, ...target, service }, context))
            .toMatchObject({ ok: true, result: { health: 'unknown' } });
        expect(await executor.execute('daemon.filesystem.readFile', { rootPath: workspace.rootPath, path: 'compose.yaml' }, context))
            .toMatchObject({ ok: true, result: { success: true } });
        const text = 'Investigation completed; root cause unconfirmed.\n\nEvidence: [failed receipt](https://home.test/receipt/failed-receipt), masked build log; health unknown; /repos/app/compose.yaml.\n\nNext: restore original runtime-log masking custody, then continue this Session. No deployment changed.';
        const message: Message = { kind: 'agent-text', id: 'finding', localId: null, seq: 40, createdAt: 40, text };
        await act(async () => {
            const completed = { ...running, latestTurnStatus: 'completed' as const, sessionTurns: { v: 1 as const,
                sessionId: running.id, updatedAt: 40, turns: [{ turnId: 'diagnostic', startedAt: 1, updatedAt: 40,
                    status: 'completed' as const, terminalAt: 40, transcriptAnchors: { finalAssistantMessageSeq: 40 } }] } };
            storage.setState({ sessions: { investigation: completed }, sessionMessages: { investigation: {
                messageIdsOldestFirst: [message.id], messagesById: { finding: message }, messagesMap: { finding: message },
                reducerState: createReducer(), latestThinkingMessageId: null, latestThinkingMessageActivityAtMs: null, messagesVersion: 1, isLoaded: true } } });
        });
        expect(hook.getCurrent()?.result.output?.text).toBe(text);
        await hook.unmount(); hook = undefined; owner.dispose();
        const coldOwner = makeOwner();
        hook = await renderHook(() => useInvestigationSessionResult(coldOwner, subject, null));
        const finding = hook.getCurrent();
        expect(finding?.result.output).toMatchObject({ text, messageRef: { messageId: 'finding' } });
        expect(finding?.evidence?.subject).toEqual(subject);
        expect(finding?.nextAction).toEqual({ kind: 'continueSession', session: { serverId: scope.serverId, sessionId: 'investigation' } });
        if (!finding) throw new Error('Expected durable finding');
        const outcome = projectOperationsRunOutcome({ subject, finding: { kind: 'investigate', ...finding } });
        expect(outcome.recovery).toEqual({ kind: 'unavailable', reason: 'health_unavailable' });
        expect(outcome.proposal).toEqual({ pullRequest: null, approval: null });
        expect(outcome.appliedEffect).toMatchObject({ operation: null, receipt: null });
        coldOwner.dispose();
    } finally { await hook?.unmount(); owner.dispose(); storage.setState(before); }
});

it('reopens the receipt Finding from its durable linked Session, follows completion, and keeps unverified recovery unknown', async () => {
    const before = storage.getState();
    const scope = { serverId: 'home', accountId: 'account' };
    const subject = { kind: 'deploymentReceipt', serverId: scope.serverId, environmentId: 'env', deploymentId: 'receipt' } as const;
    const calls: Array<{ action: unknown; input: unknown }> = [];
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({ invokeContributedAction: async request => {
        calls.push({ action: request.action, input: request.input });
        // Contributed Action transport is the genuine persistence boundary.
        const input = request.input as Readonly<{ entryRef: unknown }>;
        return { ok: true, result: { kind: 'complete', lanes: [], links: [{ entryRef: input.entryRef,
            sessionId: 'investigation', linkedAtMs: 1, displayPath: 'Deployment' }] } };
    } }));
    const makeOwner = () => createAccountNoticeInvestigation({ scope, isCurrent: () => true,
        execute: createFrontDoorActionExecute(executor) });
    const session = createSessionFixture({ id: 'investigation', serverId: scope.serverId,
        encryptionMode: 'e2ee', encryptedContentAvailability: 'ready', latestTurnId: 'diagnostic', latestTurnStatus: 'completed',
        sessionTurns: { v: 1, sessionId: 'investigation', updatedAt: 40, turns: [{ turnId: 'diagnostic', startedAt: 1,
            updatedAt: 40, status: 'completed', transcriptAnchors: { finalAssistantMessageSeq: 40 } }] } });
    const message: Message = { kind: 'agent-text', id: 'finding', seq: 40, createdAt: 40,
        localId: null, text: 'The deployment failed because the build is missing an input. Recovery NOT verified.' };
    storage.setState({ profileScope: scope, sessions: { investigation: session },
        sessionListRowsByServerId: { home: { investigation: buildSessionListRenderableFromSession(session) } },
        sessionMessages: { investigation: { messageIdsOldestFirst: ['finding'], messagesById: { finding: message },
            messagesMap: { finding: message }, reducerState: createReducer(), latestThinkingMessageId: null,
            latestThinkingMessageActivityAtMs: null, messagesVersion: 1, isLoaded: true } } });
    const fetch = vi.spyOn(globalThis, 'fetch');
    try {
        const firstOwner = makeOwner();
        const first = await renderHook(() => useInvestigationSessionResult(firstOwner, subject, null));
        expect(first.getCurrent()?.result.preview).toEqual({ state: 'available', text: message.text });
        await first.unmount(); firstOwner.dispose(); calls.length = 0;
        const owner = makeOwner();
        const reopened = await renderHook(() => useInvestigationSessionResult(owner, subject, null));
        const finding = reopened.getCurrent();
        expect(finding?.result.preview).toEqual({ state: 'available', text: message.text });
        expect(finding?.messageRef).toEqual({ kind: 'session', session: { serverId: scope.serverId,
            sessionId: 'investigation' }, messageId: 'finding' });
        expect(finding?.evidence).toEqual({ subject, message: finding?.messageRef });
        expect(finding?.nextAction).toEqual({ kind: 'continueSession',
            session: { serverId: scope.serverId, sessionId: 'investigation' } });
        if (!finding) throw new Error('Expected persisted investigation');
        const rows = presentOperationsOutcomeRows(projectOperationsRunOutcome({ subject,
            finding: { kind: 'investigate', ...finding } }));
        expect(rows.map(row => row.key)).toEqual(['finding', 'recovery']);
        expect(rows[0]).toMatchObject({ value: message.text, session: { serverId: scope.serverId, sessionId: 'investigation' } });
        expect(rows[1]).toMatchObject({ key: 'recovery', known: false });
        expect(calls).toHaveLength(1);
        expect(calls[0]?.action).toEqual({ pluginId: 'happier.triage', localId: 'sessions/read-source-links-v1' });
        expect(fetch).not.toHaveBeenCalled();
        await act(async () => {
            const transcript = storage.getState().sessionMessages.investigation!;
            storage.setState({ sessionMessages: { investigation: { ...transcript, messagesVersion: 2,
                messagesById: { finding: { ...message, text: 'The agent has completed its diagnostic finding.' } } } } });
        });
        expect(reopened.getCurrent()?.result.preview).toEqual({ state: 'available', text: 'The agent has completed its diagnostic finding.' });
        expect(calls).toHaveLength(1);
        await reopened.unmount(); owner.dispose();
    } finally { fetch.mockRestore(); storage.setState(before); }
});
