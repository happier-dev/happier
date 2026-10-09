import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { SessionAuthoringOpenResultV1Schema } from '@happier-dev/protocol/plugins/ui';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { act } from 'react-test-renderer';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { ProjectDefinitionInspectOutputSchema } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import { ProjectWorkerStatusResultV1Schema } from '@happier-dev/protocol/actions/specs/projectWorkers';
import { WORKSPACE_EXECUTION_CONFIG_ROUTE_V1 } from '@happier-dev/protocol/workspaces/workspaceExecutionConfigRowV1';
import { MachinePoolViewV1Schema } from '@happier-dev/protocol/machines/pools/v1';
import { machinePoolActionEndpointPathV1 } from '@happier-dev/protocol/machines/pools/actionsV1';
import { WorkspaceRefV1WriteSchema } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { createPlainProjectAccountRowListFixture, createProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { loadVitestModuleForNodeRequire } from '@/dev/vitestRnShim';

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
const machineTransport = vi.hoisted(() => vi.fn());
// Router and network/credential testkit are the only replaced boundaries.
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: navigation }).module;
});
// Real Action admission/DTOs remain above this Machine network boundary.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: machineTransport }));
installDisconnectedServerSocketBoundary();
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
await loadSyncSingletonForTests();
// Metro's lazy require must reuse this successfully imported real executor, not Node's second graph.
const executorBridge = await loadVitestModuleForNodeRequire(
    new URL('../../../sync/ops/actions/defaultActionExecutor.ts', import.meta.url),
    () => import('@/sync/ops/actions/defaultActionExecutor'),
);
afterAll(() => executorBridge.dispose());
// The harness uses doMock: load the real domain graph only after its HTTP boundaries.
const [
    { storage },
    { listNewSessionDraftProjections },
    { readNewSessionDraftProjectionFromRepository, writeNewSessionDraftToRepository },
    { resolveCurrentProjectAuthoringReturn, readProjectSessionAuthoringOrigin },
    { openProjectSetupAuthoring },
    { t },
    { useProjectSetupAuthoring, useProjectAuthoringReturn },
    { createDefaultActionExecutor },
    { ProjectSetupSessionReturn },
] = await Promise.all([
    import('@/sync/domains/state/storage'),
    import('@/sync/ops/sessionDrafts/sessionDraftRepository'),
    import('@/components/sessions/composer/newSessionDraftRepositoryAdapter'),
    import('@/components/projects/detail/projectRouteState'),
    import('./projectSetupAuthoring'),
    import('@/text'),
    import('./useProjectSetupAuthoring'),
    Promise.resolve(executorBridge.module),
    import('./ProjectSetupReturn'),
]);
let serverId: string;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
beforeEach(async () => {
    await homes.reset();
    navigation.push.mockClear();
    machineTransport.mockReset();
    machineTransport.mockImplementation(async ({ method }) => {
        if (method !== 'daemon.projects.inspect.v1') throw new Error(`Unexpected Machine effect: ${method}`);
        return ProjectDefinitionInspectOutputSchema.parse({ definition: { basis: { kind: 'absent' }, document: null },
            detection: { entries: [], environments: [], devcontainers: [], coverage: 'complete', diagnostics: [] }, importCandidates: [] });
    });
    serverId = await homes.addHome({ name: 'Home', serverUrl: 'https://project-authoring.test', accountId: 'account-a', machinePoolsEnabled: true });
    homes.answer(serverId, 'GET /v1/machines', { body: ['machine-a', 'worker-b'].map(id =>
        createPlainMachineRowFixture({ id, accountId: 'account-a' })) });
    const ref = WorkspaceRefV1WriteSchema.parse({ id: 'checkout-a', serverId, machineId: 'machine-a', rootPath: '/repo', createdAtMs: 1 });
    homes.answer(serverId, `POST ${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`, {
        body: createPlainProjectAccountRowListFixture({ workspaceRefs: [ref] }),
    });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://project-authoring.test', accountId: 'account-a' });
    installHomeGovernanceBoundaries(homes);
    homes.answer(serverId, `${WORKSPACE_EXECUTION_CONFIG_ROUTE_V1}/read`, { body: { status: 'absent' } });
    const scope = { serverId, accountId: 'account-a' };
    // Characterize the actual Account-mode/config HTTP path before a case changes its row.
    const preferences = await createDefaultActionExecutor().execute('projects.worker.preferences.get', {
        workspace: { serverId, refId: 'checkout-a' },
    }, { surface: 'ui', authority: 'present_user', serverId, expectedAccountId: scope.accountId });
    const requests = homes.requests.map(({ serverId, serverUrl, path, input }) => ({ serverId, serverUrl, path, input }));
    expect(preferences, `Captured Home HTTP precondition: ${JSON.stringify(requests)}`).toMatchObject({
        ok: true, result: { status: 'ready', revision: 'absent', provenance: 'default' },
    });
    expect(homes.requestsFor(`${WORKSPACE_EXECUTION_CONFIG_ROUTE_V1}/read`)).toContainEqual(expect.objectContaining({
        serverId, serverUrl: 'https://project-authoring.test', input: { address: { serverId, refId: 'checkout-a' } },
    }));
    // Seed accepted Project facts after the real restoration/preflight awaits, not during hydration.
    storage.getState().activateProjectAccountRowsScope(scope);
    storage.getState().applyProjectAccountRowsForScope(scope, createProjectAccountRowsFixture(scope, { workspaceRefs: [ref] }));
    expect(resolveCurrentProjectAuthoringReturn({ kind: 'project', accountId: scope.accountId,
        workspace: { serverId, workspaceId: ref.id, machineId: ref.machineId, rootPath: ref.rootPath }, page: 'scripts',
    }), `Project origin precondition: ${JSON.stringify({ profileScope: storage.getState().profileScope,
        rows: storage.getState().projectAccountRows })}`).toMatchObject({ kind: 'ready' });
    const inspection = await createDefaultActionExecutor().execute('projects.inspect', {
        workspace: { serverId, workspaceId: ref.id, machineId: ref.machineId, rootPath: ref.rootPath },
    }, { surface: 'ui', authority: 'present_user', serverId, expectedAccountId: scope.accountId });
    expect(inspection, `Project inspection precondition: ${JSON.stringify({ inspection,
        requests: homes.requests.map(({ path, input }) => ({ path, input })),
        machineCalls: machineTransport.mock.calls })}`).toMatchObject({ ok: true,
        result: { definition: { basis: { kind: 'absent' }, document: null } } });
});
afterEach(async () => {
    if (connection) { await connection.dispose(); connection = null; installHomeGovernanceBoundaries(homes); }
});

describe('Project setup through ordinary authoring', () => {
    it.each(['account-a', 'other-account'])('reads the mounted Session return summary only for its original Home Account (%s)', async (accountId) => {
        const workspace = { serverId, workspaceId: 'checkout-a', machineId: 'machine-a', rootPath: '/repo' };
        const source = { kind: 'native' as const, tool: 'package_script' as const, file: 'package.json', target: 'test' };
        const manifest = { version: 1 as const, scripts: { test: { source }, lint: { source: { ...source, target: 'lint' } } } };
        const inspection = ProjectDefinitionInspectOutputSchema.parse({
            definition: { basis: { kind: 'present', hash: 'b'.repeat(64) },
                document: { status: 'valid', bytes: JSON.stringify(manifest), original: manifest, manifest, diagnostics: [] } },
            detection: { entries: [], environments: [], devcontainers: [], coverage: 'complete', diagnostics: [] }, importCandidates: [],
        });
        machineTransport.mockClear();
        machineTransport.mockImplementation(async ({ method, payload, accountId: requester, serverId: home }) => {
            expect(method).toBe('daemon.projects.inspect.v1');
            expect(payload).toEqual({ workspace });
            expect(requester).toBe('account-a');
            expect(home).toBe(serverId);
            return inspection;
        });
        if (accountId === 'account-a') {
            const { createProjectManifestActionClient } = await import('./projectManifestActionClient');
            expect(await createProjectManifestActionClient({ workspace, expectedAccountId: accountId }).inspect())
                .toMatchObject({ definition: { document: { status: 'valid', manifest } } });
            machineTransport.mockClear();
        }
        const session = createSessionFixture({ id: 'setup-session', metadata: {
            path: '/edited', machineId: 'worker-b', host: 'worker.local',
            work: { authoringOriginV1: { kind: 'project', accountId, workspace, page: 'scripts' } },
        } });
        storage.getState().applySessions([session]);
        const screen = await renderScreen(React.createElement(ProjectSetupSessionReturn, { sessionId: session.id, serverId }));
        try {
            if (accountId === 'account-a') {
                await expect.poll(() => screen.getTextContent()).toContain(t('projects.authoring.scriptsCount', { count: 2 }));
                expect(machineTransport).toHaveBeenCalled();
                await screen.pressByTestIdAsync('project-setup-return.scripts');
                expect(new URL(String(navigation.push.mock.calls.at(-1)?.[0]), 'https://happier.test').pathname)
                    .toBe('/projects/checkout-a/scripts');
            } else {
                expect(screen.findHostByTestId('project-setup-return')).toBeNull();
                expect(machineTransport).not.toHaveBeenCalled();
            }
        } finally {
            await screen.unmount();
        }
    });
    it('keeps an ask-each-time pool candidate advisory and ad-hoc opt-in separate from approval', async () => {
        const workspace = { serverId, workspaceId: 'checkout-a', machineId: 'machine-a', rootPath: '/repo' };
        const scope = { serverId, accountId: 'account-a' };
        const poolId = '7a93eb84-8b44-4c4d-bd7f-1fb2c6716514';
        const destination = { kind: 'pool', poolId, selection: 'ask' } as const;
        homes.answer(serverId, `${WORKSPACE_EXECUTION_CONFIG_ROUTE_V1}/read`, { body: {
            status: 'present', revision: 9, content: { t: 'plain', v: {
                enabled: true, destination, unavailable: 'ask', allowAdHoc: true, scriptOverrides: {}, services: {},
            } },
        } });
        homes.answer(serverId, machinePoolActionEndpointPathV1('machines.pools.get'), { body: MachinePoolViewV1Schema.parse({
            pool: { id: poolId, name: 'Workers', description: null, revision: 2, createdAt: 1, updatedAt: 2,
                members: [{ machineId: 'worker-b', priorityTier: 0, enabled: true, state: 'connected' }] },
            availability: { state: 'known', connectedCount: 1, enabledCount: 1 },
        }) });
        machineTransport.mockImplementation(async ({ method, machineId, payload, accountId }) => {
            expect(accountId).toBe(scope.accountId);
            if (method === 'daemon.projects.inspect.v1') {
                expect(machineId).toBe(workspace.machineId);
                expect(payload).toEqual({ workspace });
                return ProjectDefinitionInspectOutputSchema.parse({ definition: { basis: { kind: 'absent' }, document: null },
                    detection: { entries: [], environments: [], devcontainers: [], coverage: 'complete', diagnostics: [] }, importCandidates: [] });
            }
            if (method === 'projects.worker.status') {
                expect(machineId).toBe('worker-b');
                expect(payload).toEqual({ workspace: { serverId, refId: workspace.workspaceId },
                    destination: { kind: 'machine', machineId: 'worker-b' }, purpose: 'finite' });
                return ProjectWorkerStatusResultV1Schema.parse({ eligible: true, candidate: { serverId, machineId },
                    load: { kind: 'unknown' }, explanation: 'load_unknown' });
            }
            throw new Error(`Guidance must not dispatch an effect: ${method}`);
        });
        const sessionsBefore = storage.getState().sessions;
        const result = await openProjectSetupAuthoring({ workspace });
        if (!result.ok) throw new Error(result.errorCode);
        const opened = SessionAuthoringOpenResultV1Schema.parse(result.result);
        if (opened.kind !== 'opened') throw new Error(`Draft refused: ${JSON.stringify(opened)}`);
        const draft = readNewSessionDraftProjectionFromRepository({ scope, draftId: opened.draftId })?.draft;
        if (!draft) throw new Error('Draft missing');
        const facts: unknown = JSON.parse(draft.input.slice(draft.input.indexOf('\n\n{') + 2));
        expect(facts).toMatchObject({ advisory: true, sourceWorkspace: workspace,
            workerPreferences: { status: 'ready', preference: { destination, allowAdHoc: true, unavailable: 'ask' } },
            destination: { configured: destination, observation: { kind: 'resolved', poolId, machineId: 'worker-b' } },
            adHoc: { actionId: 'projects.compute.exec', approval: 'configured_action_policy',
                resolution: { status: 'resolved', choice: { kind: 'workers', destination } } } });
        expect(facts).not.toHaveProperty('acceptedTarget');
        expect(draft).toMatchObject({ selectedMachineId: workspace.machineId, selectedPath: workspace.rootPath });
        expect(storage.getState().sessions).toBe(sessionsBefore);
        expect(homes.requestsFor(machinePoolActionEndpointPathV1('machines.pools.get'))).toContainEqual(expect.objectContaining({ serverId, input: { poolId } }));
        expect(homes.requests.filter(request => request.path.endsWith('/mutate') || request.path.endsWith('/create'))).toEqual([]);
    });
    it.each(['read_only', 'refused', 'invalid_output'] as const)('delivers current worker facts to the editable draft without admitting a target or approving an ad-hoc command (%s)', async (statusMode) => {
        const workspace = { serverId, workspaceId: 'checkout-a', machineId: 'machine-a', rootPath: '/repo' };
        const scope = { serverId, accountId: 'account-a' };
        const source = { kind: 'native' as const, tool: 'package_script' as const, file: 'package.json', target: 'test' };
        const manifest = { version: 1 as const, scripts: {
            local: { source }, portable: { source, execution: 'portable' as const },
        } };
        const inspection = ProjectDefinitionInspectOutputSchema.parse({
            definition: { basis: { kind: 'present', hash: 'a'.repeat(64) },
                document: { status: 'valid', bytes: JSON.stringify(manifest), original: manifest, manifest, diagnostics: [] } },
            detection: { entries: [], environments: [], devcontainers: [], coverage: 'complete', diagnostics: [] }, importCandidates: [],
            commands: [{ name: 'local', usage: 'script', source, availability: 'available',
                invocation: { tool: 'yarn', args: ['run', 'test'], cwd: workspace.rootPath, requestedVersion: '4.6.0' } }],
            tools: [{ tool: 'yarn', file: 'package.json', requestedVersion: '4.6.0', availability: 'available', version: '4.6.0' },
                { tool: 'protoc', file: 'mise.toml', requestedVersion: '29', availability: 'unavailable' }],
        });
        const preference = { enabled: true, destination: { kind: 'machine', machineId: 'worker-b' },
            unavailable: 'fail', allowAdHoc: false, scriptOverrides: { local: 'workers' } } as const;
        homes.answer(serverId, `${WORKSPACE_EXECUTION_CONFIG_ROUTE_V1}/read`, {
            body: { status: 'present', revision: 7, content: { t: 'plain', v: { ...preference, services: {} } } },
        });
        const status = ProjectWorkerStatusResultV1Schema.parse({ eligible: false, candidate: null,
            load: { kind: 'unknown' }, explanation: 'not_accepting' });
        const observation = statusMode === 'invalid_output'
            ? { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' } : status;
        machineTransport.mockImplementation(async ({ method, machineId, payload, accountId }) => {
            expect(accountId).toBe(scope.accountId);
            if (method === 'daemon.projects.inspect.v1') {
                expect(machineId).toBe(workspace.machineId);
                expect(payload).toEqual({ workspace });
                return inspection;
            }
            if (method === 'projects.worker.status') {
                expect(machineId).toBe(preference.destination.machineId);
                expect(payload).toEqual({ workspace: { serverId, refId: workspace.workspaceId },
                    destination: preference.destination, purpose: 'finite' });
                // Malformed wire output must remain a failed read, not become an absent/default destination.
                return statusMode === 'invalid_output' ? { eligible: 'invalid' } : status;
            }
            throw new Error(`Guidance must not dispatch an effect: ${method}`);
        });
        const sessionsBefore = storage.getState().sessions;
        let readonlyGuidance: unknown;
        if (statusMode === 'read_only') {
            // Missing export must fail as an observable API assertion, not a collection/import error.
            const owner: unknown = await import('./projectSetupAuthoring');
            expect(owner).toHaveProperty('readProjectSetupAgentGuidance', expect.any(Function));
            if (!owner || typeof owner !== 'object' || !('readProjectSetupAgentGuidance' in owner)
                || typeof owner.readProjectSetupAgentGuidance !== 'function') throw new Error('Read-only guidance owner missing');
            const draftsBefore = listNewSessionDraftProjections(scope).length;
            const observed: unknown = await owner.readProjectSetupAgentGuidance({ workspace });
            expect(observed).toMatchObject({ kind: 'ready', guidance: { advisory: true, sourceWorkspace: workspace,
                workerPreferences: { status: 'ready', preference },
                scripts: [{ name: 'local', execution: 'primary' }, { name: 'portable', execution: 'portable' }],
                destination: { configured: preference.destination, observation },
                adHoc: { resolution: { status: 'refused', reason: 'ad_hoc_disabled' }, approval: 'configured_action_policy' },
            } });
            if (!observed || typeof observed !== 'object' || !('guidance' in observed)) throw new Error('Guidance result missing');
            readonlyGuidance = observed.guidance;
            expect(await owner.readProjectSetupAgentGuidance({ workspace: { ...workspace, rootPath: '/replaced' } }))
                .toEqual({ kind: 'unavailable', reason: 'origin_unavailable' });
            const aborted = new AbortController();
            aborted.abort();
            expect(await owner.readProjectSetupAgentGuidance({ workspace, signal: aborted.signal }))
                .toEqual({ kind: 'unavailable', reason: 'aborted' });
            expect(listNewSessionDraftProjections(scope)).toHaveLength(draftsBefore);
            expect(navigation.push).not.toHaveBeenCalled();
            expect(storage.getState().sessions).toBe(sessionsBefore);
            expect(homes.requests.filter(request => request.path.endsWith('/mutate') || request.path.endsWith('/create'))).toEqual([]);
        }
        const result = await openProjectSetupAuthoring({ workspace });
        if (!result.ok) throw new Error(result.errorCode);
        const opened = SessionAuthoringOpenResultV1Schema.parse(result.result);
        if (opened.kind !== 'opened') throw new Error(`Draft refused: ${opened.kind}`);
        const draft = readNewSessionDraftProjectionFromRepository({ scope, draftId: opened.draftId })?.draft;
        if (!draft) throw new Error('Draft missing');
        // Observe the factual supplement at the real delivery owner, not a helper or a fake Session.
        const start = draft.input.indexOf('\n\n{');
        expect(start, 'Current worker facts must accompany the static setup request').toBeGreaterThanOrEqual(0);
        const facts: unknown = JSON.parse(draft.input.slice(start + 2));
        if (statusMode === 'read_only') expect(facts).toEqual(readonlyGuidance);
        expect(facts).toMatchObject({
            advisory: true,
            sourceWorkspace: workspace,
            commands: inspection.commands,
            tools: inspection.tools,
            workerPreferences: { status: 'ready', preference, revision: 7, provenance: 'saved' },
            destination: { configured: preference.destination, observation },
            scripts: [
                { name: 'local', execution: 'primary', resolution: { status: 'resolved', choice: { kind: 'primary' }, provenance: 'declaration' } },
                { name: 'portable', execution: 'portable', resolution: { status: 'resolved',
                    choice: { kind: 'workers', destination: preference.destination }, provenance: 'workspace' } },
            ],
            adHoc: { actionId: 'projects.compute.exec', resolution: { status: 'refused', reason: 'ad_hoc_disabled' },
                approval: 'configured_action_policy' },
        });
        expect(facts).not.toHaveProperty('acceptedTarget');
        expect(draft).toMatchObject({ selectedMachineId: workspace.machineId, selectedPath: workspace.rootPath,
            authoringOrigin: { workspace } });
        expect(storage.getState().sessions).toBe(sessionsBefore);
        expect(homes.requests.filter(request => request.path.endsWith('/mutate'))).toEqual([]);
        if (statusMode === 'read_only') {
            const owner: unknown = await import('./projectSetupAuthoring');
            if (!owner || typeof owner !== 'object' || !('readProjectSetupAgentGuidance' in owner)
                || typeof owner.readProjectSetupAgentGuidance !== 'function') throw new Error('Read-only guidance owner missing');
            const draftsBeforeRetirement = listNewSessionDraftProjections(scope).length;
            await connection?.dispose();
            connection = null;
            expect(await owner.readProjectSetupAgentGuidance({ workspace })).toEqual({ kind: 'stale', reason: 'host_retired' });
            expect(listNewSessionDraftProjections(scope)).toHaveLength(draftsBeforeRetirement);
            expect(navigation.push).toHaveBeenCalledTimes(1); // Only the explicit opening above navigated.
        }
    });
    it('keeps invalid worker preferences unavailable in agent guidance rather than presenting primary/ad-hoc defaults', async () => {
        const workspace = { serverId, workspaceId: 'checkout-a', machineId: 'machine-a', rootPath: '/repo' };
        const scope = { serverId, accountId: 'account-a' };
        homes.answer(serverId, `${WORKSPACE_EXECUTION_CONFIG_ROUTE_V1}/read`, {
            // The genuine HTTP boundary returns malformed content; the real row reader classifies it.
            body: { status: 'present', revision: 3, content: { t: 'plain', v: { enabled: true } } },
        });
        const result = await openProjectSetupAuthoring({ workspace });
        if (!result.ok) throw new Error(result.errorCode);
        const opened = SessionAuthoringOpenResultV1Schema.parse(result.result);
        if (opened.kind !== 'opened') throw new Error(`Draft refused: ${opened.kind}`);
        const draft = readNewSessionDraftProjectionFromRepository({ scope, draftId: opened.draftId })?.draft;
        if (!draft) throw new Error('Draft missing');
        const start = draft.input.indexOf('\n\n{');
        expect(start, 'Unavailable facts must not disappear from the setup request').toBeGreaterThanOrEqual(0);
        const facts: unknown = JSON.parse(draft.input.slice(start + 2));
        expect(facts).toMatchObject({ advisory: true, sourceWorkspace: workspace, workerPreferences: { status: 'invalid' }, destination: { status: 'invalid' },
            adHoc: { resolution: { status: 'refused', reason: 'preferences_unavailable' }, approval: 'configured_action_policy' } });
        expect(facts).not.toHaveProperty('workerPreferences.preference');
        expect(facts).not.toHaveProperty('acceptedTarget');
    });
    it('opens an editable exact-target draft through the real Action, preserves return after target edits, and starts no Session', async () => {
        const workspace = { serverId, workspaceId: 'checkout-a', machineId: 'machine-a', rootPath: '/repo' };
        const scope = { serverId, accountId: 'account-a' };
        const sessionsBefore = storage.getState().sessions;
        const entry = await renderHook(() => useProjectSetupAuthoring({ workspace, profileId: 'profile-a' }));
        const result = await entry.getCurrent().onSetUpWithAgent();
        await entry.unmount();
        if (!result.ok) throw new Error(result.errorCode);
        const acknowledgement = SessionAuthoringOpenResultV1Schema.parse(result.result);
        expect(acknowledgement.kind).toBe('opened');
        if (acknowledgement.kind !== 'opened') throw new Error('Draft refused');
        const draft = readNewSessionDraftProjectionFromRepository({ scope, draftId: acknowledgement.draftId })?.draft;
        expect(draft).toMatchObject({ input: expect.stringContaining(t('projects.authoring.prompt')), selectedProfileId: 'profile-a',
            selectedMachineId: 'machine-a', selectedPath: '/repo', authoringOrigin: {
                kind: 'project', accountId: 'account-a', workspace, page: 'scripts',
            } });
        if (!draft) throw new Error('Draft missing');
        const facts: unknown = JSON.parse(draft.input.slice(draft.input.indexOf('\n\n{') + 2));
        expect(facts).toMatchObject({ workerPreferences: { status: 'ready', revision: 'absent', provenance: 'default',
            preference: { enabled: false, unavailable: 'ask', allowAdHoc: false, scriptOverrides: {} } },
            scripts: [], destination: null, adHoc: { resolution: { status: 'refused', reason: 'ad_hoc_disabled' } } });
        writeNewSessionDraftToRepository({ scope, draftId: acknowledgement.draftId, draft: { ...draft,
            input: 'My edited setup prompt', selectedMachineId: 'edited-machine', selectedPath: '/other',
            executionTarget: { kind: 'machine', target: { serverId, machineId: 'edited-machine' } },
        } });
        const reopened = readNewSessionDraftProjectionFromRepository({ scope, draftId: acknowledgement.draftId })?.draft;
        expect(reopened).toMatchObject({ input: 'My edited setup prompt', selectedMachineId: 'edited-machine', selectedPath: '/other' });
        const destination = resolveCurrentProjectAuthoringReturn(reopened?.authoringOrigin);
        expect(destination.kind).toBe('ready');
        if (destination.kind !== 'ready') throw new Error('Return refused');
        expect(new URL(destination.href, 'https://happier.test').pathname).toBe('/projects/checkout-a/scripts');
        expect(storage.getState().sessions).toBe(sessionsBefore);
        expect(navigation.push).toHaveBeenCalledTimes(1);
        expect(navigation.push).toHaveBeenLastCalledWith({ pathname: '/new', params: { draftId: acknowledgement.draftId } });
    });
    it('refuses a replaced checkout without writing another draft or navigating', async () => {
        const scope = { serverId, accountId: 'account-a' };
        const before = listNewSessionDraftProjections(scope).length;
        expect(await openProjectSetupAuthoring({ workspace: {
            serverId, workspaceId: 'checkout-a', machineId: 'machine-a', rootPath: '/replaced',
        } })).toEqual({ ok: true, result: { kind: 'unavailable', reason: 'origin_unavailable' } });
        expect(listNewSessionDraftProjections(scope)).toHaveLength(before);
        expect(navigation.push).not.toHaveBeenCalled();
    });
    it('returns from private Session provenance and refuses the same link after the original checkout disappears', async () => {
        const origin = readProjectSessionAuthoringOrigin({ path: '/edited', machineId: 'edited-machine', work: {
            authoringOriginV1: { kind: 'project', accountId: 'account-a', workspace: {
                serverId, workspaceId: 'checkout-a', machineId: 'machine-a', rootPath: '/repo',
            }, page: 'changes', comparisonId: 'original-comparison' },
        } });
        const entry = await renderHook(() => useProjectAuthoringReturn(origin));
        expect(entry.getCurrent().destination.kind).toBe('ready');
        expect(entry.getCurrent().onReturnToProject()).toEqual({ kind: 'opened' });
        const href = String(navigation.push.mock.calls.at(-1)?.[0]);
        const url = new URL(href, 'https://happier.test');
        expect(url.pathname).toBe('/projects/checkout-a/changes');
        expect(url.searchParams.get('comparisonId')).toBe('original-comparison');
        navigation.push.mockClear();
        await act(async () => { storage.getState().clearProjectAccountRowsScope(); });
        expect(entry.getCurrent().onReturnToProject().kind).toBe('unavailable');
        expect(navigation.push).not.toHaveBeenCalled();
        await entry.unmount();
    });
    it('cancels a captured opening when the selected target changes during the real credential boundary await', async () => {
        const workspace = { serverId, workspaceId: 'checkout-a', machineId: 'machine-a', rootPath: '/repo' };
        const scope = { serverId, accountId: 'account-a' };
        const before = listNewSessionDraftProjections(scope).length;
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        // Device credential storage is an actual boundary; all Action admission and seed logic remain real.
        vi.mocked(TokenStorage.getCredentialsForServerUrl).mockImplementationOnce(async () => {
            entered.resolve();
            await release.promise;
            return connection?.credentials ?? null;
        });
        const entry = await renderHook((input: { workspace: typeof workspace }) => useProjectSetupAuthoring(input), {
            initialProps: { workspace },
        });
        const opening = entry.getCurrent().onSetUpWithAgent();
        await entered.promise;
        await entry.rerender({ workspace: { ...workspace, rootPath: '/different-checkout' } });
        release.resolve();
        expect(await opening).toEqual({ ok: true, result: { kind: 'unavailable', reason: 'aborted' } });
        expect(listNewSessionDraftProjections(scope)).toHaveLength(before);
        expect(navigation.push).not.toHaveBeenCalled();
        await entry.unmount();
    });
});
