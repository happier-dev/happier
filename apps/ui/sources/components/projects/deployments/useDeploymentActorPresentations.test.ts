import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionActorV1 } from '@happier-dev/protocol/actions/actionRequestAttributionV1';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { AutomationDefinitionDetailSchema } from '@happier-dev/protocol/automations/automationApiV3';
import { act, renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createAutomationRunFixture, createWorkflowDefinitionFixture, createWorkflowRunListStorageFixture, createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { resolveUnknownAccountActorName } from '@/sync/domains/account/accountActorPresentation';
import { createAutomationDefinitionFromDetail } from '@/sync/domains/automations/automationDefinitionProjection';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storageStore');
const { useDeploymentActorPresentations } = await import('./useDeploymentActorPresentations');
const { workflowRunRowFromAutomationRun, workflowRunRowFromSummary, workflowRunStoreKey } = await import('@/sync/store/domains/workflowRuns');
let previous = storage.getState();

beforeEach(async () => {
    previous = storage.getState();
    await homes.reset();
});
afterEach(async () => {
    await standardCleanup();
    await homes.reset();
    storage.setState(previous);
});

function useActors(scope: ServerAccountScope, actors: readonly (ActionActorV1 | null | undefined)[], active = true) {
    const bindings = useServerCredentialAccountScopeBindings([scope.serverId]);
    return useDeploymentActorPresentations({ scope, actors, active,
        accountLifetime: bindings.get(scope.serverId) ?? null });
}

async function createHome() {
    const serverId = await homes.addHome({ name: 'Deployment actors', serverUrl: 'https://deployment-actors.test', accountId: 'viewer' });
    const scope = { serverId, accountId: 'viewer' };
    storage.setState({ profileScope: scope, users: {}, workflowRunsById: {}, sessionListRowsByServerId: {} });
    homes.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
    return scope;
}

describe('deployment actor display through the existing scoped owners', () => {
    it('names explicit people through one batched profile read and preserves unknown history', async () => {
        const scope = await createHome();
        homes.answer(scope.serverId, '/v1/user/profiles', { body: { users: [
            { id: 'ana', name: 'Ana', firstName: '', lastName: null, username: '', avatar: null, bio: null, status: 'none', publicKey: null },
        ] } });
        const actors: readonly (ActionActorV1 | null | undefined)[] = [
            { actorKind: 'person', accountId: 'ana' }, { actorKind: 'person', accountId: 'withheld' },
            null, undefined, { actorKind: 'person', accountId: 'ana' },
        ];
        const hook = await renderHook(() => useActors(scope, actors));
        await vi.waitFor(() => expect(hook.getCurrent()[0]).toEqual({ actorKind: 'person', displayName: 'Ana', onBehalfOf: null }));
        expect(hook.getCurrent()[1]?.displayName).toBe(t('message.accountActorFormerMember'));
        expect(hook.getCurrent().slice(2, 4)).toEqual([
            { actorKind: null, displayName: null, onBehalfOf: null }, { actorKind: null, displayName: null, onBehalfOf: null },
        ]);
        expect(homes.requestsFor('/v1/user/profiles').map(request => request.input)).toEqual([{ ids: ['ana', 'withheld'] }]);
    });

    it('names the exact Session Agent and keeps an external on-behalf reference qualified', async () => {
        const scope = await createHome();
        const target = buildBackendTargetKeyV2({ kind: 'backend', backendId: 'claude' });
        const row = createSessionListRenderableSessionFixture({ id: 'agent-session', agentTargetKey: target });
        storage.setState({ sessionListRowsByServerId: { [scope.serverId]: { [row.id]: row } } });
        homes.answer(scope.serverId, '/v1/user/profiles', { body: { users: [
            { id: 'ana', name: 'Ana', firstName: '', lastName: null, username: '', avatar: null, bio: null, status: 'none', publicKey: null },
        ] } });
        const actors: readonly ActionActorV1[] = [
            { actorKind: 'agent', sessionId: row.id, onBehalfOf: { serverId: scope.serverId, accountId: 'ana' } },
            { actorKind: 'agent', sessionId: row.id, onBehalfOf: { serverId: 'external-home', accountId: 'ana' } },
        ];
        const hook = await renderHook(() => useActors(scope, actors));
        await vi.waitFor(() => expect(hook.getCurrent()[0]).toEqual({ actorKind: 'agent', displayName: 'Claude',
            onBehalfOf: { serverId: scope.serverId, accountId: 'ana', displayName: 'Ana' } }));
        expect(hook.getCurrent()[1]).toEqual({ actorKind: 'agent', displayName: 'Claude',
            onBehalfOf: { serverId: 'external-home', accountId: 'ana', displayName: resolveUnknownAccountActorName('value') } });
        expect(homes.requestsFor('/v1/user/profiles').map(request => request.input)).toEqual([{ ids: ['ana'] }]);
        let renders = 0;
        const unsubscribe = hook.subscribe(() => { renders++; });
        await act(async () => { storage.setState(state => ({ sessionListRowsByServerId: {
            ...state.sessionListRowsByServerId,
            [scope.serverId]: { ...state.sessionListRowsByServerId[scope.serverId], unrelated: createSessionListRenderableSessionFixture({ id: 'unrelated' }) },
        } })); });
        expect(renders).toBe(0);
        unsubscribe();
    });

    it('opens the scheduled Runs accepted private titles with one exact batched read and consumes subsequent pushes', async () => {
        const scope = await createHome();
        const runs = ['scheduled-one', 'scheduled-two'].map(id => createWorkflowRunSummaryFixture({ id,
            ownerAccountId: scope.accountId, origin: { kind: 'automation', automationId: 'nightly-automation' } }));
        const stored = await createWorkflowRunListStorageFixture({ runs, definition: createWorkflowDefinitionFixture({
            blocks: [{ kind: 'wait', id: 'approve', document: { text: 'Approve deploy', references: [], attachments: [] } }],
        }), metadata: { title: 'Nightly preview deploy' } });
        const route = '/v3/automations/runs/workflow-storage';
        homes.answer(scope.serverId, route, { body: stored });
        const actors: readonly ActionActorV1[] = runs.map(run => ({ actorKind: 'workflow', runId: run.id, automationId: 'nightly-automation' }));
        const hook = await renderHook(() => useActors(scope, actors));
        await vi.waitFor(() => expect(hook.getCurrent().map(actor => actor.displayName)).toEqual(['Nightly preview deploy', 'Nightly preview deploy']));
        expect(homes.requestsFor(route).map(request => request.input)).toEqual([expect.objectContaining({ operation: 'list',
            request: expect.objectContaining({ runIds: runs.map(run => run.id) }) })]);
        await act(async () => storage.getState().upsertWorkflowRuns([
            workflowRunRowFromSummary({ ...runs[0]!, revision: 2 }, { kind: 'available', value: { title: 'Updated accepted title' } }),
        ], scope));
        expect(hook.getCurrent().map(actor => actor.displayName)).toEqual(['Updated accepted title', 'Nightly preview deploy']);
        expect(homes.requestsFor(route)).toHaveLength(1);
    });

    it('does no presentation reads while hidden and leaves unavailable agent or workflow names unknown', async () => {
        const scope = await createHome();
        const route = '/v3/automations/runs/workflow-storage';
        homes.answer(scope.serverId, route, { body: { runs: [], acceptedEnvelopesByRunId: {}, keyCensusByRunId: {} } });
        homes.answer(scope.serverId, '/v1/user/profiles', { status: 503, body: { error: 'unavailable' } });
        const actors: readonly ActionActorV1[] = [
            { actorKind: 'person', accountId: 'ana' }, { actorKind: 'workflow', runId: 'missing-run' },
            { actorKind: 'agent', sessionId: 'unnamed-agent' },
        ];
        storage.setState({ sessionListRowsByServerId: { [scope.serverId]: {
            'unnamed-agent': createSessionListRenderableSessionFixture({ id: 'unnamed-agent' }),
        } } });
        const hook = await renderHook(({ active }) => useActors(scope, actors, active), { initialProps: { active: false } });
        expect(homes.requestsFor(route)).toHaveLength(0);
        expect(homes.requestsFor('/v1/user/profiles')).toHaveLength(0);
        await hook.rerender({ active: true });
        await vi.waitFor(() => expect(hook.getCurrent()[0]?.displayName).toBe(resolveUnknownAccountActorName('value')));
        expect(hook.getCurrent()[1]).toEqual({ actorKind: 'workflow', displayName: null, onBehalfOf: null });
        expect(hook.getCurrent()[2]).toEqual({ actorKind: 'agent', displayName: null, onBehalfOf: null });
        await vi.waitFor(() => expect(homes.requestsFor(route)).toHaveLength(1));
    });

    it('opens the addressed scheduled Action title without a Workflow snapshot or a focused Home title', async () => {
        const scope = await createHome();
        const route = '/v3/automations/runs/workflow-storage';
        homes.answer(scope.serverId, route, { body: { runs: [], acceptedEnvelopesByRunId: {}, keyCensusByRunId: {} } });
        const automationId = 'nightly-contributed-action';
        const definition = AutomationDefinitionDetailSchema.parse({
            id: automationId, name: 'Automation', description: null, enabled: true,
            targetType: null, existingSessionId: null, templateVersion: 3, lastRunAt: null,
            createdAt: 1, updatedAt: 1, assignments: [], triggers: [],
            executionRecipe: { v: 1, templateVersion: 3, triggerEvidence: null,
                template: { t: 'plain', v: { v: 1, prompt: '', actionInput: { kind: 'literal', value: {} },
                    display: { name: 'Publish nightly preview', description: null } } },
                target: { kind: 'contributedAction', action: { pluginId: 'com.example.deploy', localId: 'publish' } },
            },
        });
        const definitionRoute = `/v3/automations/${automationId}`;
        homes.answer(scope.serverId, definitionRoute, { body: definition });
        storage.getState().upsertAutomation(createAutomationDefinitionFromDetail(definition));
        const actors: readonly ActionActorV1[] = ['action-one', 'action-two'].map(runId => ({ actorKind: 'workflow', runId, automationId }));
        const automationRuns = ['action-one', 'action-two'].map(id => createAutomationRunFixture({ id, automationId }));
        storage.getState().upsertWorkflowRuns(automationRuns.map(workflowRunRowFromAutomationRun), scope);
        const hook = await renderHook(({ active }) => useActors(scope, actors, active), { initialProps: { active: true } });
        await vi.waitFor(() => expect(hook.getCurrent().map(actor => actor.displayName)).toEqual(['Publish nightly preview', 'Publish nightly preview']));
        expect(automationRuns.map(run => storage.getState().workflowRunsById[workflowRunStoreKey(run.id, scope)]?.automation)).toEqual(automationRuns);
        expect(homes.requestsFor(definitionRoute).map(request => request.serverId)).toEqual([scope.serverId]);
        expect(homes.requestsFor('/v3/automations')).toHaveLength(0);
        await hook.rerender({ active: false });
        await act(async () => {
            const otherServerId = await homes.addHome({ name: 'Other Home', serverUrl: 'https://other-deployment-actors.test', accountId: 'other-viewer' });
            storage.setState({ profileScope: { serverId: otherServerId, accountId: 'other-viewer' },
                automations: { [automationId]: createAutomationDefinitionFromDetail({ ...definition, name: 'Other Home title' }) } });
        });
        await hook.rerender({ active: true });
        await vi.waitFor(() => expect(homes.requestsFor(definitionRoute).map(request => request.serverId)).toEqual([scope.serverId, scope.serverId]));
        expect(hook.getCurrent().map(actor => actor.displayName)).toEqual(['Publish nightly preview', 'Publish nightly preview']);
    });
});
