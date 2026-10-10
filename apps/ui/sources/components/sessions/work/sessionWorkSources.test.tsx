import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { AutomationRunCauseSchema } from '@happier-dev/protocol';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol';

import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { installSessionSubagentCommonModuleMocks } from '@/components/sessions/agents/sessionSubagentTestHelpers';
import { createDeferred, createSessionFixture, createMachineFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

installSessionSubagentCommonModuleMocks({
    // The Work owner and all subordinate stores/selectors stay real beneath transport/platform mocks.
    storage: () => vi.importActual<typeof import('@/sync/domains/state/storage')>('@/sync/domains/state/storage'),
});
installDisconnectedServerSocketBoundary();
const { storage } = await import('@/sync/domains/state/storage');
// Load the real Work graph at collection so the test budget measures the journey.
const { useSessionWorkSourcesOwner, toWorkReportSessionSource } = await import('./sessionWorkSources');
const { resolveSessionInstructionsPolicy, useSessionInstructionsDetail } = await import('./useSessionInstructionsSource');
const { useSessionAgentActivity } = await import('@/hooks/session/useSessionAgentActivity');
const { invokeMountedWorkRead } = await import('@/sync/ops/actions/mountedWorkReadAction');
afterEach(() => { standardCleanup(); actionOperationStore.reset(); });

describe('the Session Work operation source', () => {
    it('uses the shared Agent and machine identity for Work map reports', () => {
        const session = createSessionFixture({ metadata: { ...createSessionFixture().metadata!,
            flavor: 'claude', host: 'MacBook Pro' } });
        expect(toWorkReportSessionSource(session, Date.now()).facts.join(' · ')).toContain('MacBook Pro');
    });
    it('refreshes a report identity on machine rename without reprojecting unrelated settings', async () => {
        const connection = await restoreServerAccountForTest({
            serverUrl: 'https://work-identity.test', serverIdentityId: 'srv_work_identity', accountId: 'account',
            request: async url => {
                const path = new URL(String(url)).pathname;
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
                return Response.json({}, { status: 404 });
            },
        });
        const initial = storage.getState();
        const serverId = connection.home.id;
        const session = createSessionFixture({ id: 'report', serverId, reportsTo: { sessionId: 'lead' },
            metadata: { ...createSessionFixture().metadata!, machineId: 'work-mac', host: 'mac.local' } });
        const machine = createMachineFixture({ id: 'work-mac',
            metadata: { ...createMachineFixture().metadata!, displayName: 'Studio Mac' } });
        storage.setState({ sessions: { [session.id]: session }, sessionListRowsByServerId: {},
            machineListByServerId: { [serverId]: [machine] } });
        try {
            const hook = await renderHook(() => useSessionWorkSourcesOwner({ sessionId: 'lead', serverId,
                ownerMetadata: null, agentActivity: useSessionAgentActivity({ sessionId: 'lead', serverId }) }));
            const before = hook.getCurrent().projection;
            expect(before.sessions[0]?.facts.join(' · ')).toContain('Studio Mac');
            const read = () => invokeMountedWorkRead({ actionId: 'session.work.get', input: { sessionId: 'lead' },
                context: { surface: 'ui', serverId, runtimeAccountId: 'account' } });
            expect(await read()).toMatchObject({ status: 'ready', summary: before.summary,
                items: [{ key: before.sessions[0]!.key, facts: before.sessions[0]!.facts }] });
            // A retained route and an opened pane can mount the same scoped Session producer.
            const equivalent = await renderHook(() => useSessionWorkSourcesOwner({ sessionId: 'lead', serverId,
                ownerMetadata: null, agentActivity: useSessionAgentActivity({ sessionId: 'lead', serverId }) }));
            expect(await read()).toMatchObject({ status: 'ready', summary: before.summary });
            await act(async () => { storage.setState({ settings: { ...storage.getState().settings, debugInformationEnabled: true } }); });
            expect(hook.getCurrent().projection).toBe(before);
            await act(async () => { storage.setState({ machineListByServerId: { [serverId]: [{ ...machine,
                metadata: { ...machine.metadata!, displayName: 'Travel Mac' } }] } }); });
            expect(hook.getCurrent().projection.sessions[0]?.facts.join(' · ')).toContain('Travel Mac');
            expect(await read()).toMatchObject({ status: 'ready',
                items: [{ facts: hook.getCurrent().projection.sessions[0]!.facts }] });
            await hook.unmount();
            expect(await read()).toMatchObject({ status: 'ready', summary: equivalent.getCurrent().projection.summary });
            await equivalent.unmount();
            expect(await read()).toEqual({ status: 'unavailable' });
        } finally { storage.setState(initial, true); await connection.dispose(); }
    });
    it('projects Agent edits from its Account Action surface, not a neighboring surface waiver', () => {
        const settings = normalizeActionsSettingsV1({ v: 1, actions: {}, approvalWaivedSurfaces: { 'prompt_doc.update': ['cli'] } });
        let saved = settings;
        const policy = resolveSessionInstructionsPolicy({ settings, targetId: 'agent', onChange: next => { saved = next; } });
        expect(policy).toMatchObject({
            actionId: 'prompt_doc.update', targetId: 'agent', scope: 'account_action_surface',
            controlState: { kind: 'approval', approvalSurface: 'agent', approvalRequiredByPolicy: true },
        });
        expect(resolveSessionInstructionsPolicy({ targetId: 'agent', onChange: () => {}, settings: normalizeActionsSettingsV1({
            ...settings, approvalWaivedSurfaces: { 'prompt_doc.update': ['agent', 'cli'] },
        }) }).controlState).toMatchObject({ value: 'allowed', approvalRequiredByPolicy: false });
        // Retain the incumbent adapter's coverage until the shared Action writer replaces its live caller.
        policy.setValue('allowed');
        expect(new Set(saved.approvalWaivedSurfaces?.['prompt_doc.update'])).toEqual(new Set(['agent', 'cli']));
        expect(saved.actions['session.instructions.set']).toBeUndefined();
    });

    it('demands current Instructions only in Work, distinguishes empty and stale content, and clears private disclosure', async () => {
        const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account', encryptionMode: 'plain' });
        await artifacts.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({
            id: 'instructions', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_doc.v2', title: 'Instructions' }),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1, markdown: '', createdAtMs: 1, updatedAtMs: 1 }) }),
        }) });
        let unavailable = false;
        let denied = false;
        let instructionReads = 0;
        let heldRead: ReturnType<typeof createDeferred<void>> | null = null;
        const connection = await restoreServerAccountForTest({
            serverUrl: 'https://work-instructions.test', serverIdentityId: 'srv_work_instructions', accountId: 'account',
            request: async (url, init) => {
                const path = new URL(String(url)).pathname;
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
                if (path === '/v1/artifacts/instructions') {
                    instructionReads++;
                    await heldRead?.promise;
                    if (denied) return Response.json({}, { status: 403 });
                    if (unavailable) return Response.json({}, { status: 503 });
                }
                return (await artifacts.handle(path, init)) ?? Response.json({}, { status: 404 });
            },
        });
        try {
            const address = { sessionId: 'lead', serverId: connection.home.id };
            const metadata = { work: { promptStack: [{ id: 'session.instructions', ref: { kind: 'doc', artifactId: 'instructions' }, enabled: true, required: true, placement: 'system_append' }] } };
            // The Work host owner never reads document content; only the open Instructions detail does.
            const owner = await renderHook(() => useSessionWorkSourcesOwner({ ...address, ownerMetadata: metadata,
                agentActivity: useSessionAgentActivity(address) }));
            expect(instructionReads).toBe(0);
            await owner.unmount();
            const hook = await renderHook((props: { access: 'readable' | 'owner_private' | 'locked' }) =>
                useSessionInstructionsDetail({ ...address, ownerMetadata: metadata, access: props.access }),
                { initialProps: { access: 'readable' } });
            await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ status: 'ready', document: { markdown: '', revision: { headerVersion: 1, bodyVersion: 1 } } }));
            await hook.rerender({ access: 'locked' });
            heldRead = createDeferred<void>();
            await hook.rerender({ access: 'readable' });
            expect(hook.getCurrent()).toMatchObject({ status: 'loading', document: null, stale: false });
            heldRead.resolve();
            heldRead = null;
            await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ status: 'ready', document: { markdown: '' } }));
            unavailable = true;
            await act(async () => { await hook.getCurrent().retry(); });
            expect(hook.getCurrent()).toMatchObject({ status: 'unavailable', stale: true, document: { markdown: '' } });
            denied = true;
            await act(async () => { await hook.getCurrent().retry(); });
            expect(hook.getCurrent()).toMatchObject({ status: 'locked', stale: false, document: null });
            denied = false;
            await hook.rerender({ access: 'owner_private' });
            expect(hook.getCurrent()).toMatchObject({ status: 'owner_private', document: null });
            const readsBeforeLock = instructionReads;
            await hook.rerender({ access: 'locked' });
            expect(hook.getCurrent()).toMatchObject({ status: 'locked', document: null });
            expect(instructionReads).toBe(readsBeforeLock);
            unavailable = false;
            await artifacts.handle('/v1/artifacts/instructions', { method: 'POST', body: JSON.stringify({
                header: encodePlainArtifactStoredContent({ v: 1, kind: 'role.v1', title: 'Different kind' }), expectedHeaderVersion: 1,
            }) });
            await hook.rerender({ access: 'readable' });
            await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ status: 'wrong_kind', document: null, stale: false }));
            await artifacts.handle('/v1/artifacts/instructions', { method: 'DELETE' });
            await act(async () => { await hook.getCurrent().retry(); });
            expect(hook.getCurrent()).toMatchObject({ status: 'not_found', document: null, stale: false });
            await hook.unmount();
        } finally { heldRead?.resolve(); await connection.dispose(); }
    });

    it('subscribes to qualified admitted commands, preserves unrelated-update identity, and retires on Home or Account changes', async () => {
        const connection = await restoreServerAccountForTest({
            serverUrl: 'https://work-source.test', serverIdentityId: 'srv_work_source', accountId: 'account',
            request: async (url) => {
                const path = new URL(String(url)).pathname;
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
                return Response.json({}, { status: 404 });
            },
        });
        try {
            const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
            const serverId = getActiveServerAccountScope()?.serverId;
            expect(serverId).toBe('srv_work_source');
            if (!serverId) throw new Error('The test Account has no admitted Home');
            const snapshot: ActionOperationSnapshotV1 = {
                version: 1, operationId: 'command', revision: 1, actionId: 'projects.script.run', state: 'accepted',
                scope: { accountId: 'account', machineId: 'machine', sessionId: 'lead' }, title: 'Build',
                createdAt: 1, cancellation: 'supported', domainRef: { kind: 'projectCommand', purpose: 'script',
                    serverId, machineId: 'machine', workspaceRefId: 'workspace', cwd: '/repo' },
            };
            actionOperationStore.mergeSnapshots({ serverId, snapshots: [snapshot] });
            const address = { serverId: connection.home.id, sessionId: 'lead' };
            const hook = await renderHook((scope: typeof address) => {
                const agentActivity = useSessionAgentActivity(scope);
                return useSessionWorkSourcesOwner({ ...scope, ownerMetadata: null, agentActivity });
            }, { initialProps: address });
            await vi.waitFor(() => expect(hook.getCurrent().projection.projectCommands).toHaveLength(1));
            const current = hook.getCurrent();
            expect(current.projection.projectCommands.map((item) => item.title)).toEqual(['Build']);
            expect(current.projection.summary.outstanding).toBe(1);
            await act(async () => actionOperationStore.mergeSnapshots({ serverId: 'other-home', snapshots: [snapshot] }));
            expect(hook.getCurrent()).toBe(current);
            const { TokenStorage } = await import('@/auth/storage/tokenStorage');
            const nextCredentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'next-account' })).toString('base64url')}.signature` };
            // Secure credential storage is the harness's external boundary. Its real
            // mutation path still retires and resolves the Work source's Account.
            vi.mocked(TokenStorage.getCredentialsForServerUrl).mockResolvedValue(nextCredentials);
            await act(async () => {
                expect(await TokenStorage.setCredentialsForServerUrl(connection.home.serverUrl, { serverId: connection.home.id }, nextCredentials)).toBe(true);
            });
            await vi.waitFor(() => expect(hook.getCurrent().projection.projectCommands).toEqual([]));
            await act(async () => actionOperationStore.mergeSnapshots({ serverId, snapshots: [{
                ...snapshot, operationId: 'next-command', title: 'Test', scope: { ...snapshot.scope, accountId: 'next-account' },
            }] }));
            await vi.waitFor(() => expect(hook.getCurrent().projection.projectCommands.map((item) => item.title)).toEqual(['Test']));
            expect(hook.getCurrent().projection.summary.outstanding).toBe(1);
            await hook.rerender({ ...address, serverId: 'other-home' });
            expect(hook.getCurrent().projection.projectCommands).toEqual([]);
            await hook.unmount();
        } finally {
            await connection.dispose();
        }
    });
});

describe('the Session Work source owner: own trigger runs (ORC R-09, INT §6 I4)', () => {
    it("leaves the Session's own trigger runs to Triggers, by their Automation's scope, in Work and in the header count", async () => {
        const { readOwnTriggerRunIds } = await import('./sessionWorkSources');
        const { projectWork } = await import('./workProjection');
        const triggerCause = AutomationRunCauseSchema.parse({
            kind: 'trigger', triggerId: 'retired-trigger', triggerRevision: 1,
            triggerKind: 'sessionLifecycle', occurrenceKey: 'A'.repeat(43), occurredAt: 10,
            evidence: { event: 'parentTurnCompleted', sourceSessionId: 'lead', sourceTurnId: 'turn-1', policy: { kind: 'everyMatch' } },
        });
        const runs = [
            // Started directly from this Session (an agent's on-the-fly workflow): Work.
            createWorkflowRunSummaryFixture({ id: 'ordinary', origin: { kind: 'direct', originSessionId: 'lead' } }),
            // Started by an Automation scoped to this Session — one of its triggers: Triggers.
            createWorkflowRunSummaryFixture({ id: 'own-trigger', origin: { kind: 'automation', automationId: 'lead-trigger', originSessionId: 'lead', cause: triggerCause } }),
            createWorkflowRunSummaryFixture({ id: 'own-conversation-trigger', origin: { kind: 'automation', automationId: 'lead-trigger', cause: AutomationRunCauseSchema.parse({ kind: 'conversation', triggerId: 'conversation-trigger', occurrenceKey: 'A'.repeat(43), occurredAt: 10 }) } }),
            // Same scoped Automation, but no trigger caused these Runs. Do not guess from scope.
            createWorkflowRunSummaryFixture({ id: 'manual', origin: { kind: 'automation', automationId: 'lead-trigger', originSessionId: 'lead', cause: { kind: 'manual', invokedAt: 10 } } }),
            createWorkflowRunSummaryFixture({ id: 'unknown-cause', origin: { kind: 'automation', automationId: 'lead-trigger', originSessionId: 'lead' } }),
            createWorkflowRunSummaryFixture({ id: 'conversation', origin: { kind: 'automation', automationId: 'lead-trigger', originSessionId: 'lead', cause: AutomationRunCauseSchema.parse({ kind: 'conversation', occurrenceKey: 'B'.repeat(42) + 'A', occurredAt: 10 }) } }),
            // An Automation scoped to another Session, or to the Account, that names this Session: Work.
            createWorkflowRunSummaryFixture({ id: 'other-trigger', origin: { kind: 'automation', automationId: 'other-trigger', originSessionId: 'lead', cause: triggerCause } }),
            createWorkflowRunSummaryFixture({ id: 'account-automation', origin: { kind: 'automation', automationId: 'account-automation', originSessionId: 'lead', cause: triggerCause } }),
        ];
        const ownTriggerRunIds = readOwnTriggerRunIds({
            sessionId: 'lead',
            runs,
            automations: {
                'lead-trigger': { scopeSessionId: 'lead' },
                'other-trigger': { scopeSessionId: 'elsewhere' },
                'account-automation': { scopeSessionId: null },
            },
        });
        expect([...ownTriggerRunIds]).toEqual(['own-trigger', 'own-conversation-trigger']);

        const projection = projectWork({
            sessionId: 'lead',
            reportSessions: [],
            agentEntries: [],
            workflowHeadlineRuns: [],
            managedRuns: runs.map((run) => ({ run, title: run.id, word: 'Running', needsAttention: false })),
            ownTriggerRunIds,
            describeAgentStatus: () => 'Working',
            describeProgress: ({ completed, total }) => `${completed} of ${total}`,
        });
        expect(projection.workflows.map((item) => item.key).sort()).toEqual(['run:account-automation', 'run:conversation', 'run:manual', 'run:ordinary', 'run:other-trigger', 'run:unknown-cause']);
        expect(projection.summary.runs).toBe(6);
    });
});
