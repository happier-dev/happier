import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { AutomationRunCauseSchema } from '@happier-dev/protocol/automations/run-cause';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';

import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { installSessionSubagentCommonModuleMocks } from '@/components/sessions/agents/sessionSubagentTestHelpers';
import { createDeferred, createSessionFixture, createMachineFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { resolveSessionListHomeKey } from '@/sync/domains/session/listing/sessionListRowStateLookup';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

installSessionSubagentCommonModuleMocks({
    // The Work owner and all subordinate stores/selectors stay real beneath transport/platform mocks.
    storage: () => vi.importActual<typeof import('@/sync/domains/state/storage')>('@/sync/domains/state/storage'),
});
installDisconnectedServerSocketBoundary();
const { storage } = await import('@/sync/domains/state/storage');
const { readLockedSessionName } = await import('@/utils/sessions/sessionUtils');
// Load the real Work graph at collection so the test budget measures the journey.
const { useSessionWorkSourcesOwner, toWorkReportSessionSource } = await import('./sessionWorkSources');
const { useSessionLineage } = await import('./sessionLineage');
const { resolveSessionInstructionsPolicy, useSessionInstructionsDetail } = await import('./useSessionInstructionsSource');
const { useSessionAgentActivity } = await import('@/hooks/session/useSessionAgentActivity');
const { createAppShellAction } = await import('@/sync/ops/actions/appShellAction');
afterEach(() => { standardCleanup(); actionOperationStore.reset(); });

describe('the Session Work operation source', () => {
    it('refreshes same-ref Instructions from an Allow-mode Agent write without an approval and ignores unrelated Artifact wakes', async () => {
        const { createPlainArtifactHomeFixture } = await import('@/dev/testkit/harness/artifactStoreBoundary');
        const { withUiPromptLibraryArtifactStore } = await import('@/sync/ops/promptLibrary/promptLibraryArtifactStore');
        const { createPromptDocInLibrary } = await import('@happier-dev/protocol/prompts/library/promptLibraryActionOperations');
        const { executeDefaultActionInCapturedAccount } = await import('@/sync/ops/actions/defaultActionExecutor');
        const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
        const { createSessionMetadataHttpBoundary } = await import('@/dev/testkit/harness/sessionMetadataHttpBoundary');
        const sessionHttp = createSessionMetadataHttpBoundary(() => storage.getState().sessions);
        let bodyReads = 0;
        const f = await createPlainArtifactHomeFixture('https://instructions-allowed.test', {
            handleRequest: async (path, init) => {
                if (path.startsWith('/v1/artifacts/') && (!init?.method || init.method === 'GET')) bodyReads++;
                if (path === '/v2/account/settings') return Response.json({ version: 1, content: { t: 'plain', v: {
                    actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: { 'prompt_doc.update': ['agent'] } },
                } } });
                return sessionHttp.handle(`https://instructions-allowed.test${path}`, init);
            },
        });
        try {
            await f.hydrateAccountSettings();
            await withUiPromptLibraryArtifactStore(async (store, account) => {
                const created = await createPromptDocInLibrary({ store, request: { title: 'Instructions', markdown: 'Previous' } });
                const metadata = { work: { promptStack: [{ id: 'session.instructions', ref: { kind: 'doc', artifactId: created.artifactId },
                    enabled: true, placement: 'system_append' }] } };
                storage.setState({ isDataReady: true, sessions: { ...storage.getState().sessions,
                    'allowed-author': createSessionFixture({ id: 'allowed-author', serverId: f.home.id,
                        metadata: { ...createSessionFixture().metadata!, ...metadata } }) } });
                sessionHttp.replaceSession('allowed-author');
                const hook = await renderHook(() => useSessionInstructionsDetail({ sessionId: 'allowed-author', serverId: f.home.id,
                    ownerMetadata: metadata, access: 'readable' }));
                try {
                    await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ status: 'ready', document: { markdown: 'Previous' } }));
                    const before = bodyReads;
                    await act(async () => {
                        publishHomeAccountChange(f.home.id, ['another-document'], { changeKinds: ['artifact'] });
                        publishHomeAccountChange(f.home.id, [created.artifactId], { changeKinds: ['session'] });
                    });
                    expect(bodyReads).toBe(before);
                    await act(async () => {
                        expect(await executeDefaultActionInCapturedAccount(account, 'prompt_doc.update', {
                            artifactId: created.artifactId, title: 'Instructions', markdown: 'Allowed edit',
                        }, { surface: 'agent', serverId: f.home.id, runtimeAccountId: account.accountId,
                            defaultSessionId: 'allowed-author', actionRequestId: 'allowed-instructions' })).toMatchObject({ ok: true, result: { ok: true } });
                        // This fixture has a disconnected socket. Deliver the server's content-free
                        // committed Artifact wake at that transport boundary, as useMemoryDocument does.
                        publishHomeAccountChange(f.home.id, [created.artifactId], { changeKinds: ['artifact'] });
                    });
                    await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ status: 'ready', document: { markdown: 'Allowed edit' } }));
                    expect(f.boundary.list().filter(row => row.id !== created.artifactId)).toHaveLength(0);
                } finally { await hook.unmount(); }
            }, { serverId: f.home.id });
        } finally { await f.dispose(); }
    });
    it('observes actual Agent approval settlements in the Instructions read model and refreshes successive accepted revisions', async () => {
        const { createPlainArtifactHomeFixture } = await import('@/dev/testkit/harness/artifactStoreBoundary');
        const { withUiPromptLibraryArtifactStore } = await import('@/sync/ops/promptLibrary/promptLibraryArtifactStore');
        const { createPromptDocInLibrary } = await import('@happier-dev/protocol/prompts/library/promptLibraryActionOperations');
        const { executeDefaultActionInCapturedAccount } = await import('@/sync/ops/actions/defaultActionExecutor');
        const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
        const { createSessionMetadataHttpBoundary } = await import('@/dev/testkit/harness/sessionMetadataHttpBoundary');
        const sessionHttp = createSessionMetadataHttpBoundary(() => storage.getState().sessions);
        const f = await createPlainArtifactHomeFixture('https://instructions-settlement.test', {
            handleRequest: async (path, init) => sessionHttp.handle(`https://instructions-settlement.test${path}`, init),
        });
        const initial = storage.getState();
        const sessionId = 'instructions-author';
        try {
            await withUiPromptLibraryArtifactStore(async (store, account) => {
                const created = await createPromptDocInLibrary({ store, request: { title: 'Instructions', markdown: 'Previous' } });
                const metadata = { ...createSessionFixture().metadata!, work: { promptStack: [{ id: 'session.instructions',
                    ref: { kind: 'doc', artifactId: created.artifactId }, enabled: true, placement: 'system_append' }] } };
                storage.setState({ isDataReady: true, sessions: { ...storage.getState().sessions,
                    [sessionId]: createSessionFixture({ id: sessionId, serverId: f.home.id, metadata }) } });
                sessionHttp.replaceSession(sessionId);
                const hook = await renderHook(() => useSessionInstructionsDetail({ sessionId, serverId: f.home.id,
                    ownerMetadata: metadata, access: 'readable' }));
                const propose = async (requestId: string, markdown: string) => {
                    let result: Awaited<ReturnType<typeof executeDefaultActionInCapturedAccount>> | undefined;
                    await act(async () => { result = await executeDefaultActionInCapturedAccount(account, 'prompt_doc.update',
                        { artifactId: created.artifactId, title: 'Instructions', markdown }, { surface: 'agent',
                            serverId: f.home.id, runtimeAccountId: account.accountId, defaultSessionId: sessionId, actionRequestId: requestId }); });
                    expect(result).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
                    if (!result?.ok || !result.result || typeof result.result !== 'object' || !('artifactId' in result.result)
                        || typeof result.result.artifactId !== 'string') throw new Error('Expected actual approval receipt');
                    return result.result.artifactId;
                };
                const decide = async (artifactId: string, decision: 'approve' | 'reject') => {
                    await act(async () => {
                        expect(await executeDefaultActionInCapturedAccount(account, 'approval.request.decide', { artifactId, decision },
                            { surface: 'ui', authority: 'present_user', serverId: f.home.id, runtimeAccountId: account.accountId }))
                            .toMatchObject({ ok: true });
                    });
                };
                try {
                    await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ status: 'ready', document: { markdown: 'Previous' } }));
                    const denied = await propose('denied-instructions', 'Denied change');
                    await decide(denied, 'reject');
                    await vi.waitFor(() => expect(hook.getCurrent().writeFacts).toMatchObject({ agentWriteResult: { status: 'denied' } }));
                    expect(hook.getCurrent().document?.markdown).toBe('Previous');
                    for (const markdown of ['First accepted', 'Second accepted']) {
                        const id = await propose(markdown, markdown);
                        await decide(id, 'approve');
                        // Approval settlement is attribution; the disconnected transport fixture
                        // must separately deliver the real document's committed Artifact wake.
                        await act(async () => { publishHomeAccountChange(f.home.id, [created.artifactId], { changeKinds: ['artifact'] }); });
                        await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ status: 'ready', document: { markdown },
                            writeFacts: { provenance: { changedBy: { kind: 'agent', sessionId },
                                approvedBy: { kind: 'person', accountId: account.accountId } }, agentWriteResult: { status: 'updated' } } }));
                    }
                } finally { await hook.unmount(); }
            }, { serverId: f.home.id });
        } finally { storage.setState(initial, true); await f.dispose(); }
    });
    it('says what a report waiting for permission wants, from the request when it is held and from its kind otherwise', async () => {
        const { createSessionViewerFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        const { resolveSessionListHomeKey } = await import('@/sync/domains/session/listing/sessionListRowStateLookup');
        const { buildSessionListRenderableFromSession } = await import('@/sync/domains/session/listing/sessionListRenderable');
        const now = Date.now();
        const waiting = createSessionFixture({ id: 'perm', active: true, activeAt: now,
            viewer: createSessionViewerFixture({ attention: { needsAttention: true, reasons: ['permission_required'], primary: 'permission_required', presentation: 'full' } }),
            agentState: { requests: { r1: { kind: 'permission', tool: 'Bash', arguments: { command: 'yarn test' }, createdAt: now, turnId: 't1' } } } });
        expect(toWorkReportSessionSource(waiting, now).activity).toBe('sessionWork.row.needsApproval');
        const row = buildSessionListRenderableFromSession(waiting, undefined, []);
        expect(toWorkReportSessionSource({ record: row, serverId: waiting.serverId }, now).activity).toBe('sessionWork.row.asksPermission');
        expect(toWorkReportSessionSource({ record: row, baseSession: waiting, serverId: waiting.serverId }, now).activity)
            .toBe('sessionWork.row.needsApproval');
    });
    it('uses the shared Agent and machine identity for Work map reports', () => {
        const session = createSessionFixture({ metadata: { ...createSessionFixture().metadata!,
            flavor: 'claude', host: 'MacBook Pro' } });
        expect(toWorkReportSessionSource(session, Date.now()).facts.join(' · ')).toContain('MacBook Pro');
    });
    it('names a report whose encrypted content is still undecided like the sidebar does, then preserves its held list name and Agent', async () => {
        // A cold archived row: listed, but nothing has decided its content or title yet.
        const undecided = { ...createSessionFixture({ id: 'child', metadata: null }), encryptionMode: 'e2ee' as const, encryptedContentAvailability: null };
        expect(toWorkReportSessionSource(undecided, Date.now()).title).toBe(readLockedSessionName());
        const settled = { ...createSessionFixture({ id: 'child', metadata: { ...createSessionFixture().metadata!, summaryText: 'Fix flaky retries' } }),
            encryptionMode: 'e2ee' as const, encryptedContentAvailability: 'ready' as const };
        expect(toWorkReportSessionSource(settled, Date.now()).title).toBe('Fix flaky retries');
        const { buildSessionListRenderableFromSession } = await import('@/sync/domains/session/listing/sessionListRenderable');
        const { selectSessionReportSubtree } = await import('./reportSubtree');
        const declared = createSessionFixture({ id: 'child', manager: { sessionId: 'lead' }, metadataLayoutVersion: 1,
            metadata: { path: '', host: '', v: 1, agentPresentation: { agentId: 'acme.reviewer' } },
            ownerMetadataView: { name: 'Review release', host: 'work', path: '/repo' } });
        const row = buildSessionListRenderableFromSession(declared);
        const reports = selectSessionReportSubtree({}, 'lead', 'home', { home: { child: row } });
        expect(toWorkReportSessionSource(reports[0]!, Date.now())).toMatchObject({ title: 'Review release', agentId: 'acme.reviewer' });
    });
    it('avoids report inventory traversal on unrelated publications while updating admitted rows, relations and hydrated bases', async () => {
        const { buildSessionListRenderableFromSession } = await import('@/sync/domains/session/listing/sessionListRenderable');
        const { createSessionViewerFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
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
        const lead = createSessionFixture({ id: 'lead', serverId, seq: 0,
            metadata: { ...createSessionFixture().metadata!, name: 'Current lead' } });
        const session = createSessionFixture({ id: 'report', serverId, manager: { sessionId: 'lead' },
            metadata: { ...createSessionFixture().metadata!, machineId: 'work-mac', host: 'mac.local' } });
        const machine = createMachineFixture({ id: 'work-mac',
            metadata: { ...createMachineFixture().metadata!, displayName: 'Studio Mac' } });
        // Count real inventory enumeration, not selector calls or only suppressed React renders.
        // The 1k unrelated admitted Sessions must never be walked for a message/settings publication.
        let relationEnumerations = 0;
        const admittedRows = {
            ...Object.fromEntries(Array.from({ length: 1_000 }, (_, index) => {
                const unrelated = createSessionFixture({ id: `unrelated-${index}`, serverId });
                return [unrelated.id, buildSessionListRenderableFromSession(unrelated)];
            })),
            lead: buildSessionListRenderableFromSession(lead),
            [session.id]: buildSessionListRenderableFromSession(session),
        };
        const rows = new Proxy(admittedRows, { ownKeys(target) {
            relationEnumerations += 1;
            return Reflect.ownKeys(target);
        } });
        storage.setState({ sessions: { lead, [session.id]: session }, sessionListRowsByServerId: { [serverId]: rows },
            machineListByServerId: { [serverId]: [machine] } });
        try {
            const hook = await renderHook(() => useSessionWorkSourcesOwner({ sessionId: 'lead', serverId,
                ownerMetadata: null, agentActivity: useSessionAgentActivity({ sessionId: 'lead', serverId }) }));
            const before = hook.getCurrent().projection;
            expect(before.sessions[0]?.facts.join(' · ')).toContain('Studio Mac');
            // Real Action admission resolves the saved Home profile alias before the exact-scope mounted read.
            const action = createAppShellAction();
            const read = (runtimeAccountId = 'account') => action({ actionId: 'session.work.get', input: { sessionId: 'lead' },
                context: { surface: 'ui', serverId, runtimeAccountId } });
            expect(await read()).toMatchObject({ status: 'ready', summary: before.summary,
                items: [{ key: before.sessions[0]!.key, facts: before.sessions[0]!.facts }] });
            expect(await read('other-account')).toEqual({ status: 'unavailable' });
            // A retained route and an opened pane can mount the same scoped Session producer.
            const equivalent = await renderHook(() => useSessionWorkSourcesOwner({ sessionId: 'lead', serverId,
                ownerMetadata: null, agentActivity: useSessionAgentActivity({ sessionId: 'lead', serverId }) }));
            const lineage = await renderHook(() => useSessionLineage(session.id, serverId));
            expect(lineage.getCurrent()).toEqual([{ sessionId: 'lead', title: 'Current lead' }]);
            expect(await read()).toMatchObject({ status: 'ready', summary: before.summary });
            relationEnumerations = 0;
            const relationHome = resolveSessionListHomeKey(storage.getState().sessionRelationsByServerId, serverId)!;
            const relationshipInputs = storage.getState().sessionRelationsByServerId[relationHome];
            for (let index = 0; index < 3; index++) {
                await act(async () => { storage.setState({ settings: { ...storage.getState().settings, analyticsOptOut: index % 2 === 0 } }); });
                await act(async () => { storage.getState().applyMessages('lead', [{
                    id: `ordinary-${index}`, seq: index + 1, localId: null, createdAt: index + 1,
                    role: 'user', isSidechain: false, content: { type: 'text', text: 'Continue' },
                }]); });
                await act(async () => { storage.setState({ sessionListRowsByServerId: {
                    ...storage.getState().sessionListRowsByServerId,
                    'another-home': { [session.id]: { ...admittedRows[session.id]!, manager: null } },
                } }); });
            }
            expect(relationEnumerations).toBe(0);
            expect(storage.getState().sessions.lead?.seq).toBe(3);
            expect(storage.getState().sessionRelationsByServerId[relationHome]).toBe(relationshipInputs);
            expect(storage.getState().sessionMessages.lead?.messageIdsOldestFirst).toHaveLength(3);
            expect(storage.getState().sessionListRowsByServerId[serverId]).toBe(rows);
            expect(hook.getCurrent().projection).toBe(before);
            await act(async () => { storage.setState({ machineListByServerId: { [serverId]: [{ ...machine,
                metadata: { ...machine.metadata!, displayName: 'Travel Mac' } }] } }); });
            expect(hook.getCurrent().projection.sessions[0]?.facts.join(' · ')).toContain('Travel Mac');
            expect(await read()).toMatchObject({ status: 'ready',
                items: [{ facts: hook.getCurrent().projection.sessions[0]!.facts }] });
            const currentRows = storage.getState().sessionListRowsByServerId;
            const renamed = createSessionFixture({ ...session,
                metadata: { ...session.metadata!, name: 'Review release' } });
            let relationshipPublications = 0;
            const stop = storage.subscribe((next, previous) => {
                if (next.sessionRelationsByServerId[relationHome] !== previous.sessionRelationsByServerId[relationHome]) relationshipPublications += 1;
            });
            try {
                await act(async () => { storage.setState({ sessionListRowsByServerId: {
                    ...currentRows, [serverId]: { ...admittedRows,
                        [session.id]: buildSessionListRenderableFromSession({ ...renamed, manager: null }) },
                } }); });
                expect(relationshipPublications).toBe(1);
            } finally { stop(); }
            expect(hook.getCurrent().projection.sessions).toEqual([]);
            expect(hook.getCurrent().projection.summary.sessions).toBe(0);
            expect(lineage.getCurrent()).toEqual([]);
            const now = Date.now();
            const waiting = createSessionFixture({ ...renamed, active: true, activeAt: now,
                viewer: createSessionViewerFixture({ attention: { needsAttention: true, reasons: ['permission_required'],
                    primary: 'permission_required', presentation: 'full' } }),
                agentState: { requests: { r1: { kind: 'permission', tool: 'Bash', arguments: { command: 'git status' }, createdAt: now } } },
            });
            await act(async () => { storage.setState({ sessionListRowsByServerId: {
                ...currentRows, [serverId]: { ...admittedRows,
                    [session.id]: buildSessionListRenderableFromSession(waiting) },
            } }); });
            expect(hook.getCurrent().projection.sessions[0]?.title).toBe('Review release');
            expect(hook.getCurrent().projection.summary.sessions).toBe(1);
            expect(hook.getCurrent().projection.sessions[0]?.facts).toContain('sessionWork.row.asksPermission');
            expect(lineage.getCurrent()).toEqual([{ sessionId: 'lead', title: 'Current lead' }]);
            await act(async () => { storage.setState({ sessionListRowsByServerId: {
                ...storage.getState().sessionListRowsByServerId, [serverId]: {
                    ...storage.getState().sessionListRowsByServerId[serverId],
                    lead: buildSessionListRenderableFromSession(createSessionFixture({ id: 'lead', serverId,
                        metadata: { ...createSessionFixture().metadata!, name: 'Release lead' } })),
                },
            } }); });
            expect(lineage.getCurrent()).toEqual([{ sessionId: 'lead', title: 'Release lead' }]);
            await act(async () => { storage.setState({ sessions: { ...storage.getState().sessions, [session.id]: waiting } }); });
            expect(hook.getCurrent().projection.sessions[0]?.facts).toContain('sessionWork.row.needsApproval');
            // Use real Session/list ingress for fallback membership, list override and removal.
            const fallback = createSessionFixture({ id: 'fallback', serverId, seq: 1,
                manager: { sessionId: 'lead' }, metadata: { ...session.metadata!, name: 'Hydrated fallback' } });
            await act(async () => { storage.getState().applySessions([fallback]); });
            expect(hook.getCurrent().projection.sessions.map(item => item.title)).toContain('Hydrated fallback');
            const row = buildSessionListRenderableFromSession(fallback);
            await act(async () => { storage.getState().applyServerScopedSessionListRows(serverId,
                [{ ...row, manager: null }], { source: 'rowOnly', mode: 'append' }); });
            expect(hook.getCurrent().projection.sessions.map(item => item.title)).not.toContain('Hydrated fallback');
            await act(async () => { storage.getState().applyServerScopedSessionListRows(serverId,
                [row], { source: 'rowOnly', mode: 'append' }); });
            expect(hook.getCurrent().projection.sessions.map(item => item.title)).toContain('Hydrated fallback');
            // Missing and null normalize equally at row ingress. Start this omission from an
            // attached row so the admitted replacement actually exercises hydrated fallback.
            await act(async () => { storage.getState().applyServerScopedSessionListRows(serverId,
                [{ ...row, manager: undefined }], { source: 'rowOnly', mode: 'append' }); });
            expect(hook.getCurrent().projection.sessions.map(item => item.title)).toContain('Hydrated fallback');
            await act(async () => { storage.getState().deleteSession(fallback.id, serverId); });
            expect(hook.getCurrent().projection.sessions.map(item => item.title)).not.toContain('Hydrated fallback');
            expect(storage.getState().sessionRelationsByServerId[relationHome]?.[fallback.id]).toBeUndefined();
            await act(async () => { storage.setState({ sessions: {}, sessionListRowsByServerId: {} }); });
            expect(hook.getCurrent().projection.sessions).toEqual([]);
            expect(lineage.getCurrent()).toEqual([]);
            await hook.unmount();
            // The equivalent owner remains mounted, but reset retired its source records.
            expect(await read()).toMatchObject({ status: 'loading' });
            await equivalent.unmount();
            await lineage.unmount();
            expect(await read()).toEqual({ status: 'unavailable' });
        } finally { storage.setState(initial, true); await connection.dispose(); }
    });
    it('projects Agent edits from its Account Action surface, not a neighboring surface waiver', () => {
        const settings = normalizeActionsSettingsV1({ v: 1, actions: {}, approvalWaivedSurfaces: { 'prompt_doc.update': ['cli'] } });
        const policy = resolveSessionInstructionsPolicy({ settings, targetId: 'agent' });
        expect(policy).toMatchObject({
            actionId: 'prompt_doc.update', targetId: 'agent', scope: 'account_action_surface',
            controlState: { kind: 'approval', approvalSurface: 'agent', approvalRequiredByPolicy: true },
        });
        expect(resolveSessionInstructionsPolicy({ targetId: 'agent', settings: normalizeActionsSettingsV1({
            ...settings, approvalWaivedSurfaces: { 'prompt_doc.update': ['agent', 'cli'] },
        }) }).controlState).toMatchObject({ value: 'allowed', approvalRequiredByPolicy: false });
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
            // Publish the replacement through credential custody, so subscribers
            // retire and resolve the Account from the real stored credentials.
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
        const { readOwnTriggerRunIds } = await import('./workflowRunTriggerScope');
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
            createWorkflowRunSummaryFixture({ id: 'own-trigger', automationScopeSessionId: 'lead', origin: { kind: 'automation', automationId: 'deleted-trigger', originSessionId: 'lead', cause: triggerCause } }),
            createWorkflowRunSummaryFixture({ id: 'own-conversation-trigger', automationScopeSessionId: 'lead', origin: { kind: 'automation', automationId: 'unloaded-trigger', cause: AutomationRunCauseSchema.parse({ kind: 'conversation', triggerId: 'conversation-trigger', occurrenceKey: 'A'.repeat(43), occurredAt: 10 }) } }),
            // Same scoped Automation, but no trigger caused these Runs. Do not guess from scope.
            createWorkflowRunSummaryFixture({ id: 'manual', automationScopeSessionId: 'lead', origin: { kind: 'automation', automationId: 'lead-trigger', originSessionId: 'lead', cause: { kind: 'manual', invokedAt: 10 } } }),
            createWorkflowRunSummaryFixture({ id: 'unknown-cause', automationScopeSessionId: 'lead', origin: { kind: 'automation', automationId: 'lead-trigger', originSessionId: 'lead' } }),
            createWorkflowRunSummaryFixture({ id: 'conversation', automationScopeSessionId: 'lead', origin: { kind: 'automation', automationId: 'lead-trigger', originSessionId: 'lead', cause: AutomationRunCauseSchema.parse({ kind: 'conversation', occurrenceKey: 'B'.repeat(42) + 'A', occurredAt: 10 }) } }),
            // An Automation scoped to another Session, or to the Account, that names this Session: Work.
            createWorkflowRunSummaryFixture({ id: 'other-trigger', automationScopeSessionId: 'elsewhere', origin: { kind: 'automation', automationId: 'other-trigger', originSessionId: 'lead', cause: triggerCause } }),
            createWorkflowRunSummaryFixture({ id: 'account-automation', origin: { kind: 'automation', automationId: 'account-automation', originSessionId: 'lead', cause: triggerCause } }),
        ];
        const ownTriggerRunIds = readOwnTriggerRunIds({
            sessionId: 'lead',
            runs,
        });
        expect([...ownTriggerRunIds]).toEqual(['own-trigger', 'own-conversation-trigger']);

        const projection = projectWork({
            sessionId: 'lead',
            reportSessions: [],
            agentEntries: [],
            workflowHeadlineRuns: [],
            managedRuns: runs.map((run) => ({ run, title: run.id, word: 'Running' })),
            ownTriggerRunIds,
            describeAgentStatus: () => 'Working',
            describeProgress: ({ completed, total }) => `${completed} of ${total}`,
        });
        expect(projection.workflows.map((item) => item.key).sort()).toEqual(['run:account-automation', 'run:conversation', 'run:manual', 'run:ordinary', 'run:other-trigger', 'run:unknown-cause']);
        expect(projection.summary.runs).toBe(6);
    });
});
