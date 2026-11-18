import { act } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, renderHook, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createWorkflowAutomationDetailFixture, selectWorkflowAutomationListFixture, selectWorkflowAutomationDetailsFixture } from '@/dev/testkit/harness/workflowAutomationHttpBoundary';
import { createWorkflowDefinitionFixture, createWorkflowRunSummaryFixture, createWorkflowAutomationLastRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { AutomationDefinitionDetailSchema, AutomationDefinitionListItemSchema, AutomationDefinitionPatchRequestSchema,
    AutomationDefinitionReconcileRequestSchema } from '@happier-dev/protocol/automations/automationApiV3';
import { AutomationStoredWorkflowDefinitionRecipeV2Schema, AutomationStoredWorkflowDefinitionV2Schema } from '@happier-dev/protocol/automations/automationWorkflowRecipeV2';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent} from '@happier-dev/protocol/storage/artifactStoredContent';
import {
    WorkflowDefinitionArtifactHeaderV1Schema, WorkflowDefinitionArtifactBodyV1Schema } from '@happier-dev/protocol/workflows/workflowDefinitionV1';

// The real Action owner asks for destructive confirmation before removing a set.
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ confirmResult: true }).module;
});

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home); installDisconnectedServerSocketBoundary();
beforeAll(loadSyncSingletonForTests);
const { storage } = await import('@/sync/domains/state/storageStore');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
const { retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { listWorkflowTriggerSets, removeWorkflowTrigger, updateWorkflowTrigger } = await import('./workflowTriggerActions');
const { useWorkflowTriggerSets } = await import('@/components/workflows/triggers/useWorkflowTriggerSets');
const { useWorkflowAutomationSummaries } = await import('@/components/workflows/library/useWorkflowLibrarySummaries');
const { useServerCredentialAccountScopeStates } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
const { workflowRunRowFromSummary } = await import('@/sync/store/domains/workflowRuns');
const { resetWorkflowLibraryReadsForTests } = await import('@/components/workflows/library/workflowLibraryReads');
let serverId: string;
let previous = storage.getState();
let applied = getAppliedActiveServerSnapshot();
let available = isAppliedActiveServerRuntimeAvailable();
beforeEach(async () => {
    previous = storage.getState(); applied = getAppliedActiveServerSnapshot(); available = isAppliedActiveServerRuntimeAvailable();
    await home.reset();
    serverId = await home.addHome({ name: 'Trigger Home', serverUrl: 'https://trigger-read.test', accountId: 'account-one' });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    storage.setState({ profileScope: { serverId, accountId: 'account-one' }, workflowTriggerSetsById: {}, workflowTriggerSetIdsByQuery: {}, workflowRunsById: {}, workflowRunListWindows: {} });
    home.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
});
afterEach(async () => {
    await standardCleanup(); resetWorkflowLibraryReadsForTests(); retireActiveServerAccountScopeLifetime();
    await home.reset(); storage.setState(previous); publishAppliedActiveServerSnapshot(applied, available);
});

function automation(id: string, revision = 1, enabled = true) {
    const inlineDefinition = createWorkflowDefinitionFixture({ blocks: [{ kind: 'wait', id: 'wait', document: { text: 'Continue', references: [], attachments: [] } }] });
    return AutomationDefinitionDetailSchema.parse({ id, name: 'Inline trigger', description: null, enabled,
        workflowDefinitionId: null, scopeSessionId: null, targetType: null, existingSessionId: null, templateVersion: revision,
        lastRunAt: null, createdAt: 1, updatedAt: revision, assignments: [{ machineId: 'machine-a', enabled: true, priority: 0, updatedAt: 1 }], triggers: [],
        executionRecipe: AutomationStoredWorkflowDefinitionRecipeV2Schema.parse({ v: 2, templateVersion: revision,
            workflow: { t: 'plain', v: { workspace: { directory: '/repo' }, executionTarget: { kind: 'session' }, inlineDefinition } }, triggerEvidence: null }),
    });
}

function listed(row: ReturnType<typeof automation>) {
    const { executionRecipe: _recipe, ...publicRow } = row;
    return AutomationDefinitionListItemSchema.parse(publicRow);
}

describe('Account trigger reads through real Action and Automation owners', () => {
    it('preserves an HTTP authorization failure cause through the trigger Action', async () => {
        // app.authenticate supplies this existing envelope before the Automation route runs.
        const failureCause = { phase: 'execution_authorization', errorClass: 'Error',
            errorCode: 'credential_scope_denied', httpStatus: 403 };
        home.answer(serverId, 'GET /v3/automations/denied-trigger', { status: 403,
            body: { error: 'credential_scope_denied', failureCause } });
        await expect(listWorkflowTriggerSets({ automationId: 'denied-trigger', review: true })).rejects.toMatchObject({
            name: 'WorkflowActionError', code: 'run_access_denied',
            failure: { ok: false, errorCode: 'run_access_denied', failureCause },
        });
    });

    it('opens a cold seventy-row trigger census in one demanded detail page and delivers a changed recipe', async () => {
        let rows = Array.from({ length: 70 }, (_, index) => {
            const row = automation(`cold-rule-${index}`);
            return { ...row, triggers: createWorkflowAutomationDetailFixture({ id: row.id, revision: 1,
                triggerId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}` }).triggers };
        });
        home.answer(serverId, '/v3/automations', { select: () => ({ body: {
            automations: rows.map(listed), nextCursor: null,
        } }) });
        home.answer(serverId, 'POST /v3/automations/query', { select: input => ({ body: {
            automations: input && typeof input === 'object' && 'details' in input && input.details === true
                ? rows : rows.map(listed), nextCursor: null,
        } }) });
        for (const row of rows) home.answer(serverId, `GET /v3/automations/${row.id}`, { select: () => ({
            body: rows.find(current => current.id === row.id),
        }) });
        const hook = await renderHook(() => useWorkflowTriggerSets({ scope: 'account_all' }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('ready'));
        expect(hook.getCurrent().sets).toHaveLength(70);
        const details = () => home.requests.filter(request => /^\/v3\/automations\/cold-rule-/.test(request.path));
        expect(details()).toHaveLength(0);
        expect(home.requests.filter(request => request.path === '/v3/automations/query')).toHaveLength(1);
        rows = rows.map((row, index) => index === 0 ? { ...automation(row.id, 2, false), triggers: row.triggers } : row);
        await act(async () => hook.getCurrent().retry());
        await waitForHomeGovernance(() => expect(hook.getCurrent().sets[0]).toMatchObject({ revision: 2, enabled: false }));
        expect(details()).toHaveLength(0);
        expect(home.requests.filter(request => request.path === '/v3/automations/query')).toHaveLength(2);
    });

    it('a remounted reader keeps the held sets ready while its re-read runs (sidebar Scheduled, WAVE-ACCEPT-1118D)', async () => {
        const rows = ['kept-a', 'kept-b'].map((id, index) => {
            const row = automation(id);
            return { ...row, triggers: createWorkflowAutomationDetailFixture({ id, revision: 1,
                triggerId: `00000000-0000-4000-8000-00000000010${index}` }).triggers };
        });
        let held: Promise<void> | undefined;
        home.answer(serverId, 'POST /v3/automations/query', { select: () => ({
            body: { automations: rows, nextCursor: null }, ...(held ? { respondAfter: held } : {}),
        }) });
        const reads = () => home.requests.filter(request => request.path === '/v3/automations/query').length;
        const first = await renderHook(() => useWorkflowTriggerSets({ scope: 'account_all' }));
        await waitForHomeGovernance(() => expect(first.getCurrent().status).toBe('ready'));
        expect(first.getCurrent().sets).toHaveLength(2);
        await first.unmount();

        const reread = createDeferred<void>(); held = reread.promise;
        const seen: Array<Readonly<{ status: string; count: number }>> = [];
        const second = await renderHook(() => {
            const read = useWorkflowTriggerSets({ scope: 'account_all' });
            seen.push({ status: read.status, count: read.sets.length });
            return read;
        });
        await waitForHomeGovernance(() => expect(reads()).toBe(2));
        expect(seen[0]).toEqual({ status: 'ready', count: 2 });
        expect(seen.every(entry => entry.status === 'ready' && entry.count === 2)).toBe(true);
        await act(async () => reread.resolve());
        await waitForHomeGovernance(() => expect(second.getCurrent()).toMatchObject({ status: 'ready' }));
        expect(second.getCurrent().sets).toHaveLength(2);
    });

    it.each([false, true])('selects one managed target without opening a thousand known unrelated definitions (legacy relationship: %s)', async legacyRelationship => {
        const managedTarget = { homeId: 'home-managed', managedId: 'managed-one' };
        const definition = createWorkflowDefinitionFixture({ blocks: [{ kind: 'action', id: 'stop-managed',
            actionId: 'machines.managed.power.set', input: { homeId: { kind: 'literal', value: managedTarget.homeId },
                managedId: { kind: 'literal', value: managedTarget.managedId }, when: { kind: 'literal', value: 'after-idle' },
                intent: { kind: 'literal', value: 'stop' } } }] });
        const row = AutomationDefinitionDetailSchema.parse({ ...automation('managed-rule'), ...(legacyRelationship ? {} : { managedTarget }),
            executionRecipe: { v: 2, templateVersion: 1, triggerEvidence: null, workflow: { t: 'plain', v: {
                workspace: { directory: '/repo' }, executionTarget: { kind: 'detached_run' }, inlineDefinition: definition } } },
            triggers: [{ id: '11111111-1111-4111-8111-111111111111', revision: 1, enabled: true, createdAt: 1, updatedAt: 1,
                kind: 'runLifecycle', source: { kind: 'workflow_run', runId: 'birth-run' }, condition: 'terminal',
                remainingOccurrences: 1, status: { state: 'waiting', runId: null }, triggerDefinitionEnvelope: null }] });
        const unrelated = Array.from({ length: 1000 }, (_, index) => AutomationDefinitionDetailSchema.parse({
            ...automation(`unrelated-${index}`), managedTarget: null,
        }));
        const legacyOther = automation('legacy-other');
        const inventory = [...unrelated, row, legacyOther];
        const select = (raw: unknown) => ({ body: raw && typeof raw === 'object' && 'details' in raw && raw.details === true
            ? selectWorkflowAutomationDetailsFixture(inventory, raw) : selectWorkflowAutomationListFixture(inventory, raw) });
        home.answer(serverId, 'GET /v3/automations', { select: (_raw, request) => select(Object.fromEntries(new URL(request.url).searchParams)) });
        home.answer(serverId, 'POST /v3/automations/query', { select });
        for (const value of inventory) home.answer(serverId, `GET /v3/automations/${value.id}`, { body: value });
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Expected the real Account lifetime');
        const hook = await renderHook(() => useWorkflowTriggerSets({ managedTarget }, lifetime));
        await waitForHomeGovernance(() => expect(hook.getCurrent().status).not.toBe('loading'));
        if (hook.getCurrent().status === 'failed') await listWorkflowTriggerSets({ managedTarget });
        expect(hook.getCurrent().status).toBe('ready');
        expect(hook.getCurrent().sets).toMatchObject([{ automationId: row.id }]);
        expect(home.requests.filter(request => request.path.startsWith('/v3/automations/unrelated-'))).toHaveLength(0);
        expect(home.requests.filter(request => request.path === '/v3/automations/query')).toHaveLength(1);
        expect(home.requests.filter(request => request.path === `/v3/automations/${row.id}`)).toHaveLength(0);
        expect(home.requests.filter(request => request.path === '/v3/automations/legacy-other')).toHaveLength(0);
        const known = hook.getCurrent().sets;
        home.answer(serverId, 'POST /v3/automations/query', { status: 503, body: { error: 'storage_unavailable' } });
        await act(async () => hook.getCurrent().retry());
        await waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('failed'));
        expect(hook.getCurrent().sets).toBe(known);
        home.answer(serverId, 'POST /v3/automations/query', { select });
        await act(async () => hook.getCurrent().retry());
        await waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('ready'));
        // A locked unknown candidate cannot prove that this Machine has no rule.
        inventory[inventory.length - 1] = AutomationDefinitionDetailSchema.parse({ ...legacyOther,
            executionRecipe: { v: 2, templateVersion: 1, triggerEvidence: null, workflow: { t: 'encrypted', c: 'sealed-fixture' } } });
        await act(async () => hook.getCurrent().retry());
        await waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('failed'));
        expect(hook.getCurrent().sets).toBe(known);
        inventory[inventory.length - 1] = legacyOther;
        await act(async () => hook.getCurrent().retry());
        await waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('ready'));
        expect(home.requests.filter(request => request.path.startsWith('/v3/automations')
            && request.path !== '/v3/automations/query' && request.input !== null)).toHaveLength(0);
        await act(async () => retireActiveServerAccountScopeLifetime());
        await waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('failed'));
        expect(hook.getCurrent().sets).toEqual([]);
    });
    it('moves a raw Automation API retarget between workflow readers while preserving the trigger Action refusal', async () => {
        const firstId = '00000000-0000-4000-8000-000000000005';
        const secondId = '00000000-0000-4000-8000-000000000006';
        const definition = createWorkflowDefinitionFixture({ defaults: {
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
        } });
        for (const definitionId of [firstId, secondId]) {
            await home.artifacts(serverId).handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({ id: definitionId,
                dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                header: encodePlainArtifactStoredContent(WorkflowDefinitionArtifactHeaderV1Schema.parse({ kind: 'workflow-definition.v1',
                    definitionId, revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Saved workflow' }, previewSteps: [] })),
                body: encodePlainArtifactStoredContent({ body: JSON.stringify(WorkflowDefinitionArtifactBodyV1Schema.parse({
                    kind: 'workflow-definition.v1', definition })) }),
            }) });
        }
        let row = AutomationDefinitionDetailSchema.parse({ ...automation('retargeted-set'), workflowDefinitionId: firstId,
            executionRecipe: { v: 2, templateVersion: 1, triggerEvidence: null,
                workflow: { t: 'plain', v: { workspace: { directory: '/repo' }, executionTarget: { kind: 'session' } } } } });
        home.answer(serverId, '/v3/automations', { select: (_input, request) => ({ body: {
            automations: new URL(request.url).searchParams.get('workflowDefinitionId') === row.workflowDefinitionId ? [listed(row)] : [],
            nextCursor: null,
        } }) });
        home.answer(serverId, 'GET /v3/automations/retargeted-set', { select: () => ({ body: row }) });
        home.answer(serverId, 'PATCH /v3/automations/retargeted-set', { select: input => {
            const request = AutomationDefinitionPatchRequestSchema.parse(input);
            // The real PATCH owner retains the template revision when only its row target changes.
            row = AutomationDefinitionDetailSchema.parse({ ...row, workflowDefinitionId: request.workflowDefinitionId });
            return { body: row };
        } });
        const hook = await renderHook(() => ({ first: useWorkflowTriggerSets({ workflow: firstId }),
            second: useWorkflowTriggerSets({ workflow: secondId }) }));
        await waitForHomeGovernance(() => {
            expect(hook.getCurrent().first.sets).toMatchObject([{ automationId: row.id }]);
            expect(hook.getCurrent().second.status).toBe('ready');
        });
        expect(hook.getCurrent().second.sets).toEqual([]);
        await expect(updateWorkflowTrigger({ automationId: row.id, expectedRevision: 1,
            patch: { target: { kind: 'workflow', ref: secondId } } })).rejects.toMatchObject({ rawCode: 'invalid_input' });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { updateAutomationDefinition } = await import('@/sync/api/automations/apiAutomations');
        const credentials = await TokenStorage.getCredentialsForServerUrl(getActiveServerSnapshot().serverUrl);
        if (!credentials) throw new Error('Expected the real Home credential fixture');
        await act(async () => { await updateAutomationDefinition(credentials, row.id,
            { expectedTemplateVersion: 1, workflowDefinitionId: secondId }); });
        await act(async () => hook.getCurrent().second.retry());
        await waitForHomeGovernance(() => expect(hook.getCurrent().second.sets).toMatchObject([{ automationId: row.id,
            revision: 1, health: 'available', target: { kind: 'workflow', ref: secondId } }]));
        expect(hook.getCurrent().first.sets).toEqual([]);
    });
    it('retains the authoritative delete revision when an already-committed update ACK arrives late', async () => {
        let row: ReturnType<typeof automation> | null = automation('delayed-ack', 10);
        home.answer(serverId, '/v3/automations', { body: { automations: [listed(row)], nextCursor: null } });
        home.answer(serverId, 'GET /v3/automations/delayed-ack', { select: () => row ? { body: row } : { status: 404, body: { error: 'automation_not_found' } } });
        const [set] = await listWorkflowTriggerSets({ scope: 'account_inline' });
        expect(set?.revision).toBe(10);
        const pending = createDeferred<void>();
        home.answer(serverId, 'PUT /v3/automations/delayed-ack', { select: input => {
            const request = AutomationDefinitionReconcileRequestSchema.parse(input);
            expect(request).toMatchObject({ expectedTemplateVersion: 10, enabled: false });
            row = AutomationDefinitionDetailSchema.parse({ ...automation('delayed-ack', 11, request.enabled),
                ...(request.executionRecipe === undefined ? {} : { executionRecipe: request.executionRecipe }) });
            return { body: row, respondAfter: pending.promise };
        } });
        const updated = updateWorkflowTrigger({ automationId: 'delayed-ack', expectedRevision: 10, patch: { enabled: false } });
        await waitForHomeGovernance(() => expect(row?.templateVersion).toBe(11));
        home.answer(serverId, 'DELETE /v3/automations/delayed-ack', { select: () => { row = null; return { body: { ok: true, removedRevision: 11 } }; } });
        await removeWorkflowTrigger({ automationId: 'delayed-ack' });
        storage.getState().applyWorkflowTriggerSetPage({ queryKey: 'account_inline', sets: [] });
        await act(async () => pending.resolve()); await updated;
        expect(storage.getState().workflowTriggerSetsById['delayed-ack']).toBeUndefined();
        expect(storage.getState().workflowTriggerSetIdsByQuery.account_inline).toEqual([]);
    });

    it('removes a Manual set from every cached membership without changing other sets or Run history', async () => {
        const manual = automation('retained-manual', 3, false); const other = automation('unrelated', 3, false);
        home.answer(serverId, '/v3/automations', { body: { automations: [listed(manual), listed(other)], nextCursor: null } });
        home.answer(serverId, '/v3/automations/retained-manual', { body: manual });
        home.answer(serverId, '/v3/automations/unrelated', { body: other });
        const sets = await listWorkflowTriggerSets({ scope: 'account_inline' });
        storage.getState().applyWorkflowTriggerSetPage({ queryKey: 'account_all', sets });
        const unrelated = storage.getState().workflowTriggerSetsById.unrelated;
        const history = { 'past-run': workflowRunRowFromSummary(createWorkflowRunSummaryFixture({ id: 'past-run', state: 'succeeded', origin: { kind: 'automation', automationId: manual.id } })) };
        storage.setState({ workflowRunsById: history });
        home.answer(serverId, 'DELETE /v3/automations/retained-manual', { body: { ok: true } });
        expect(await removeWorkflowTrigger({ automationId: manual.id })).toEqual({ automationId: manual.id, deleted: true });
        expect(storage.getState().workflowTriggerSetsById).toEqual({ unrelated });
        expect(storage.getState().workflowTriggerSetIdsByQuery).toEqual({ account_inline: ['unrelated'], account_all: ['unrelated'] });
        expect(storage.getState().workflowRunsById).toBe(history);
    });

    it('reads the addressed Home and retains its facts on failed refresh without publishing into the focused Home', async () => {
        const targetId = serverId; const serverIds = [targetId]; const row = automation('addressed-rule');
        home.answer(targetId, '/v3/automations', { body: { automations: [listed(row)], nextCursor: null } });
        home.answer(targetId, '/v3/automations/addressed-rule', { body: row });
        const focused = await home.addHome({ name: 'Focused Home', serverUrl: 'https://trigger-read-focused.test', accountId: 'focused-owner' });
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        storage.setState({ profileScope: { serverId: focused, accountId: 'focused-owner' }, workflowTriggerSetsById: {}, workflowTriggerSetIdsByQuery: {} });
        const hook = await renderHook(() => {
            const scopes = useServerCredentialAccountScopeStates(serverIds);
            const binding = scopes.get(resolveServerProfileScopeIdForIdentifier(targetId))?.binding ?? null;
            return useWorkflowTriggerSets({ scope: 'account_inline' }, binding);
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('ready'));
        const recipe = AutomationStoredWorkflowDefinitionRecipeV2Schema.parse(row.executionRecipe);
        if (recipe.workflow.t !== 'plain') throw new Error('Expected plain fixture content');
        const context = AutomationStoredWorkflowDefinitionV2Schema.parse(recipe.workflow.v);
        expect(hook.getCurrent().sets).toMatchObject([{ automationId: row.id, revision: row.templateVersion, enabled: row.enabled,
            scopeSessionId: null, health: 'available', target: { kind: 'inline', definition: context.inlineDefinition }, context,
            placements: [{ machineId: 'machine-a', directory: '/repo' }], project: { machineId: 'machine-a', directory: '/repo' }, triggers: [] }]);
        const known = hook.getCurrent().sets;
        const readsBeforeForeignReceipt = home.requests.filter(request => request.path.startsWith('/v3/automations')).length;
        await act(async () => hook.getCurrent().acknowledge({ ...known[0]!, automationId: 'other-definition-trigger',
            target: { kind: 'workflow', ref: '00000000-0000-4000-8000-000000000009' } }));
        expect(hook.getCurrent().sets).toBe(known);
        expect(home.requests.filter(request => request.path.startsWith('/v3/automations'))).toHaveLength(readsBeforeForeignReceipt);
        expect(home.requests.filter(request => request.path.startsWith('/v3/automations')).every(request => request.serverId === targetId)).toBe(true);
        expect(storage.getState().workflowTriggerSetsById).toEqual({});
        home.answer(targetId, '/v3/automations', { status: 503, body: { error: 'storage_unavailable' } });
        await act(async () => publishHomeAccountChange(targetId));
        await waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('failed')); expect(hook.getCurrent().sets).toBe(known);
        const retry = createDeferred<void>();
        home.answer(targetId, '/v3/automations', { body: { automations: [listed(row)], nextCursor: null }, respondAfter: retry.promise });
        await act(async () => hook.getCurrent().retry()); expect(hook.getCurrent().sets).toBe(known);
        await act(async () => retry.resolve()); await waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('ready'));
        expect(storage.getState().profileScope?.accountId).toBe('focused-owner');
        const retiredAcknowledge = hook.getCurrent().acknowledge;
        home.answer(targetId, '/v3/automations', { body: { automations: [], nextCursor: null } });
        await act(async () => home.switchAccount(targetId, 'replacement-owner'));
        await waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('ready'));
        await act(async () => retiredAcknowledge({ ...known[0]!, revision: known[0]!.revision + 1 }));
        expect(hook.getCurrent().sets).toEqual([]);
    });

    it('reads a habit latest result from public summaries without a Run history window', async () => {
        const route = '/v3/automations/runs/workflow-storage';
        const lastRun = createWorkflowAutomationLastRunSummaryFixture({ id: 'habit-run', state: 'failed',
            attentionRequired: true, failureUnseen: true, createdAt: '2026-10-21T03:00:00.000Z' });
        home.answer(serverId, route, { body: {
            automationSummaries: [{ automationId: 'habit', lastRun }], remainingAutomationIds: [],
        } });
        const ids = ['habit']; const hook = await renderHook(() => useWorkflowAutomationSummaries(ids));
        await waitForHomeGovernance(() => expect(hook.getCurrent().summaries?.get('habit')?.lastRun).toEqual(lastRun));
        expect(home.requestsFor(route).map(request => request.input)).toEqual([
            expect.objectContaining({ operation: 'summaries', request: { automationIds: ids } }),
        ]);
        expect(storage.getState().workflowRunListWindows).toEqual({});
    });

    it('shares lower HTTP reads after independent Action admission without a cancelled caller aborting another', async () => {
        const pending = createDeferred<void>();
        home.answer(serverId, '/v3/automations', { body: { automations: [], nextCursor: null }, respondAfter: pending.promise });
        const controller = new AbortController();
        const retired = listWorkflowTriggerSets({ scope: 'account_all' }, { signal: controller.signal }).catch(() => 'aborted');
        // Explicit caller context keeps this a distinct Action invocation. Only
        // its admitted Account transport may join the native caller's read.
        const live = listWorkflowTriggerSets({ scope: 'account_all' }, {
            context: { surface: 'ui', authority: 'present_user' },
        });
        // Attach a terminal observer before a failing request-count assertion,
        // so cleanup cannot leave a retired Action as an unhandled rejection.
        void live.catch(() => {});
        try {
            await waitForHomeGovernance(() => expect(home.requests.some(request => request.path.startsWith('/v3/automations'))).toBe(true));
            await act(async () => { for (let turn = 0; turn < 30; turn++) await Promise.resolve(); });
            expect(home.requests.filter(request => request.path.startsWith('/v3/automations'))).toHaveLength(1);
            controller.abort(); await act(async () => pending.resolve());
            expect(await retired).toBe('aborted'); expect(await live).toEqual([]);
        } finally { pending.resolve(); await Promise.allSettled([retired, live]); }
    });

    it.each([false, true])('does not rerender or refetch for unrelated Run and invocation facts (addressed: %s)', async (addressed) => {
        home.answer(serverId, '/v3/automations', { body: { automations: [], nextCursor: null } });
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const lifetime = captureActiveServerAccountScopeLifetime();
        let renders = 0;
        const hook = await renderHook(() => { renders++; return useWorkflowTriggerSets({ scope: 'account_all' }, addressed ? lifetime : undefined); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('ready'));
        const before = renders; const reads = home.requests.filter(request => request.path.startsWith('/v3/automations')).length;
        await act(async () => storage.setState({ workflowRunsById: {}, workflowRunInvocationsByRunId: {} }));
        expect(renders).toBe(before); expect(home.requests.filter(request => request.path.startsWith('/v3/automations'))).toHaveLength(reads);
    });

    it('keeps addressed trigger demand through unrelated Home wakes and refreshes relevant, unknown and reconnect wakes', async () => {
        const pending = createDeferred<void>();
        home.answer(serverId, '/v3/automations', { body: { automations: [], nextCursor: null }, respondAfter: pending.promise });
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const lifetime = captureActiveServerAccountScopeLifetime();
        const hook = await renderHook(() => useWorkflowTriggerSets({ scope: 'account_all' }, lifetime));
        const reads = () => home.requests.filter(request => request.path.startsWith('/v3/automations')).length;
        await waitForHomeGovernance(() => expect(reads()).toBe(1));
        const baseline = reads();
        try {
            for (let cursor = 0; cursor < 12; cursor++) {
                await act(async () => publishHomeAccountChange(serverId, [`session-${cursor}`], { source: 'socket', changeKinds: ['session'] }));
            }
            expect(reads()).toBe(baseline);
            await act(async () => pending.resolve());
            await waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('ready'));
            expect(reads()).toBe(baseline);
            // The publisher and subscription must agree on domain relevance. A
            // foreign Home Automation is the mis-bound routing negative case.
            await act(async () => publishHomeAccountChange('https://foreign-home.test', ['trigger-a'], { source: 'socket', changeKinds: ['automation'] }));
            expect(reads()).toBe(baseline);
            for (const details of [{ source: 'socket', changeKinds: ['automation'] }, {}, { source: 'connected' }] as const) {
                const previous = reads();
                await act(async () => publishHomeAccountChange(serverId, ['trigger-a'], details));
                await waitForHomeGovernance(() => expect(reads()).toBe(previous + 1));
                await waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('ready'));
            }
        } finally {
            pending.resolve();
            await hook.unmount();
        }
    });
    it('re-reads addressed triggers only for Artifact rows that can be saved workflows', async () => {
        const { planSyncActionsFromChanges, plannedChangesAffectWorkflowTriggers } = await import('@/sync/runtime/orchestration/changesPlanner');
        const { publishHomeAccountChangeWake } = await import('@/sync/runtime/orchestration/homeAccountChange');
        const { deriveArtifactStoredKindV1 } = await import('@happier-dev/protocol/artifacts/artifactKindV1');
        home.answer(serverId, '/v3/automations', { body: { automations: [], nextCursor: null } });
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const lifetime = captureActiveServerAccountScopeLifetime();
        const hook = await renderHook(() => useWorkflowTriggerSets({ scope: 'account_all' }, lifetime));
        const reads = () => home.requests.filter(request => request.path.startsWith('/v3/automations')).length;
        await waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('ready'));
        const baseline = reads();
        try {
            // A busy Account writes Runs, Discussions and documents all the time; a trigger names only saved workflows.
            const unrelated = ['workflow-run.v1', 'document', 'discussion.v1'].map(kind => deriveArtifactStoredKindV1({ kind }));
            for (let index = 0; index < 6; index += 1) {
                const entityId = `artifact-${index}`;
                const artifactKinds = [unrelated[index % unrelated.length]!];
                const planned = planSyncActionsFromChanges([{ kind: 'artifact', entityId, cursor: index + 1, changedAt: 1, hint: { artifactKinds } }]);
                await act(async () => {
                    publishHomeAccountChangeWake(serverId, { t: 'account-change', changeKinds: ['artifact'], entityIds: [entityId], artifactKinds }, 'socket');
                    publishHomeAccountChange(serverId, [entityId], { feedPageConsumed: true, changeKinds: ['artifact'],
                        workflowTriggersAffect: plannedChangesAffectWorkflowTriggers(planned) });
                });
                await waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('ready'));
            }
            expect(reads() - baseline).toBe(0);
            // A saved workflow changed: a trigger naming it shows it, so the triggers are read again.
            await act(async () => { publishHomeAccountChangeWake(serverId, { t: 'account-change', changeKinds: ['artifact'], entityIds: ['saved-workflow'],
                artifactKinds: [deriveArtifactStoredKindV1({ kind: 'workflow-definition.v1' })] }, 'socket'); });
            await waitForHomeGovernance(() => expect(reads()).toBe(baseline + 1));
        } finally {
            await hook.unmount();
        }
    });
});
