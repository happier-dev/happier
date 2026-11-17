import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { PluginUiNewSessionSeedOriginV1Schema, SessionAuthoringOpenResultV1Schema } from '@happier-dev/protocol/plugins/ui';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { act } from 'react-test-renderer';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { ProjectDefinitionInspectInputSchema, ProjectDefinitionInspectOutputSchema, type ProjectDefinitionInspectRead } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import { ExternalActionRequestEnvelopeV1Schema, ExternalActionResponseEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { ProjectWorkerStatusResultV1Schema } from '@happier-dev/protocol/actions/specs/projectWorkers';
import { WORKSPACE_EXECUTION_CONFIG_ROUTE_V1 } from '@happier-dev/protocol/workspaces/workspaceExecutionConfigRowV1';
import { MachinePoolViewV1Schema } from '@happier-dev/protocol/machines/pools/v1';
import { machinePoolActionEndpointPathV1 } from '@happier-dev/protocol/machines/pools/actionsV1';
import { WorkspaceRefV1WriteSchema } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { createPlainProjectAccountRowListFixture, createProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { buildProjectAccountRowPhysicalKeyV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { loadVitestModuleForNodeRequire } from '@/dev/vitestRnShim';

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
const machineTransport = vi.hoisted(() => vi.fn());
// Router and network/credential testkit are the only replaced boundaries.
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: navigation }).module;
});
// Real Action admission/DTOs remain above this Machine network boundary.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (request: { method: string }) => {
        if (request.method === 'daemon.projects.inspect.v1') throw new Error('Inspection requires original Account HTTP');
        return machineTransport(request);
    },
}));
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
    { openProjectSetupAuthoring, readProjectSetupAgentGuidance },
    { t },
    { useProjectSetupAuthoring, useProjectAuthoringReturn },
    { createDefaultActionExecutor },
    { ProjectSetupSessionReturn, ProjectSetupDraftHeader, ProjectSetupDraftFootnote },
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
let homeId: string;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
beforeEach(async () => {
    await homes.reset();
    navigation.push.mockClear();
    machineTransport.mockReset();
    machineTransport.mockImplementation(async ({ method }) => {
        if (method !== 'daemon.projects.inspect.v1') throw new Error(`Unexpected Machine effect: ${method}`);
        return ProjectDefinitionInspectOutputSchema.parse({ definition: { basis: { kind: 'absent' }, document: null },
            detection: { entries: [], toolchains: [], devcontainers: [], coverage: 'complete', diagnostics: [] }, importCandidates: [] });
    });
    homeId = await homes.addHome({ name: 'Home', serverUrl: 'https://project-authoring.test', accountId: 'account-a',
        serverIdentityId: 'srv_project_authoring', currentAccount: true, machinePoolsEnabled: true });
    const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
    serverId = resolveServerProfileScopeIdForIdentifier(homeId);
    const machines = ['machine-a', 'worker-b'].map(id => createPlainMachineRowFixture({ id, accountId: 'account-a' }));
    homes.answer(homeId, 'GET /v1/machines', { body: machines });
    for (const machine of machines) homes.answer(homeId, `GET /v1/machines/${machine.id}`, { body: { machine } });
    // FX40's passive read uses the original Account Home even for SOURCE.
    // Parse both wire envelopes and the actual daemon inspection output.
    homes.answer(homeId, 'POST /v1/actions/projects.inspect', { select: async body => {
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
        expect(envelope.target).toMatchObject({ kind: 'machine', machineId: 'machine-a' });
        const result = await machineTransport({ method: 'daemon.projects.inspect.v1', payload: envelope.input,
            machineId: 'machine-a', accountId: 'account-a', serverId });
        return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'projects.inspect',
            requestId: envelope.requestId, execution: { ok: true, result: ProjectDefinitionInspectOutputSchema.parse(result) } }) };
    } });
    const ref = WorkspaceRefV1WriteSchema.parse({ id: 'checkout-a', serverId, machineId: 'machine-a', rootPath: '/repo', createdAtMs: 1 });
    homes.answer(homeId, `POST ${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`, {
        body: createPlainProjectAccountRowListFixture({ workspaceRefs: [ref] }),
    });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://project-authoring.test', accountId: 'account-a',
        serverIdentityId: 'srv_project_authoring', credentials: { token: createAccountTokenForTests('account-a', { currentAccount: true }) },
        request: homes.request });
    homes.answer(homeId, `${WORKSPACE_EXECUTION_CONFIG_ROUTE_V1}/read`, { body: { status: 'absent' } });
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
        serverId: homeId, serverUrl: 'https://project-authoring.test', input: { address: { serverId, refId: 'checkout-a' } },
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
    expect(homes.requestsFor('/v1/actions/projects.inspect')).toHaveLength(1);
});
afterEach(async () => {
    if (connection) { await connection.dispose(); connection = null; installHomeGovernanceBoundaries(homes); }
});

async function currentGuidance(workspace: Parameters<typeof readProjectSetupAgentGuidance>[0]['workspace']) {
    const observed = await readProjectSetupAgentGuidance({ workspace });
    if (observed.kind !== 'ready') throw new Error(`Guidance refused: ${observed.kind}`);
    return observed.guidance;
}

describe('Project setup return inspection data', () => {
    it('PF4 keeps the authoring return origin stable across unrelated checkout arrivals', async () => {
        const origin = PluginUiNewSessionSeedOriginV1Schema.parse({ kind: 'project', accountId: 'account-a', page: 'scripts',
            workspace: { serverId, workspaceId: 'checkout-a', machineId: 'machine-a', rootPath: '/repo' } });
        const scope = { serverId, accountId: 'account-a' };
        const baseline = storage.getState().projectAccountRows!;
        const selected = baseline.workspaceRefs.find(ref => ref.id === 'checkout-a')!;
        const keyOf = (id: string) => buildProjectAccountRowPhysicalKeyV1({ kind: 'workspace-ref', serverId, id });
        const refs = [selected, ...Array.from({ length: 149 }, (_, index) => ({
            ...selected, id: `pf4-other-${index}`, rootPath: `/other-${index}`,
        }))];
        const initial = createProjectAccountRowsFixture(scope, { workspaceRefs: refs, organizations: baseline.organizations,
            relationships: baseline.relationships, revisionsByPhysicalKey: { ...baseline.revisionsByPhysicalKey,
                ...Object.fromEntries(refs.map(ref => [keyOf(ref.id), 0])),
                [keyOf(selected.id)]: (baseline.revisionsByPhysicalKey[keyOf(selected.id)] ?? 0) + 1 } });
        // A background bootstrap must describe the same census as the admitted scale fixture.
        homes.answer(homeId, `POST ${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`, {
            body: createPlainProjectAccountRowListFixture({ workspaceRefs: refs }),
        });
        storage.getState().applyProjectAccountRowsForScope(scope, initial);
        expect(storage.getState().projectAccountRows!.workspaceRefs).toHaveLength(150);
        let current!: ReturnType<typeof useProjectAuthoringReturn>;
        let renders = 0;
        const Destination = React.memo(({ value }: { value: typeof current.destination }) => { renders++; return null; });
        function Probe() { current = useProjectAuthoringReturn(origin); return React.createElement(Destination, { value: current.destination }); }
        const screen = await renderScreen(React.createElement(Probe));
        try {
            expect(current.destination.kind).toBe('ready');
            const before = current.destination;
            renders = 0;
            await act(async () => { storage.getState().applyProjectAccountRowsForScope(scope, { ...initial,
                workspaceRefs: initial.workspaceRefs.map(ref => ({ ...ref })),
                organizations: initial.organizations.map(row => ({ ...row, value: { ...row.value } })),
            }); });
            expect({ sameDestination: current.destination === before, renders }).toEqual({ sameDestination: true, renders: 0 });
            const unrelated = { ...initial, workspaceRefs: initial.workspaceRefs.map(ref => ref.id === 'pf4-other-42' ? { ...ref, label: 'Other renamed' } : ref),
                revisionsByPhysicalKey: { ...initial.revisionsByPhysicalKey, [keyOf('pf4-other-42')]: 2 } };
            await act(async () => { storage.getState().applyProjectAccountRowsForScope(scope, unrelated); });
            expect(storage.getState().projectAccountRows!.workspaceRefs.find(ref => ref.id === 'pf4-other-42')?.label).toBe('Other renamed');
            expect({ sameDestination: current.destination === before, renders }).toEqual({ sameDestination: true, renders: 0 });
            await act(async () => { storage.getState().applyProjectAccountRowsForScope(scope, { ...unrelated,
                revisionsByPhysicalKey: { ...unrelated.revisionsByPhysicalKey, [keyOf(selected.id)]: initial.revisionsByPhysicalKey[keyOf(selected.id)] + 1 },
                workspaceRefs: unrelated.workspaceRefs.map(ref => ref.id === selected.id ? { ...ref, label: 'Selected renamed' } : ref) }); });
            expect(storage.getState().projectAccountRows!.workspaceRefs.find(ref => ref.id === selected.id)?.label).toBe('Selected renamed');
            expect(current.destination).not.toBe(before);
            expect(renders).toBe(1);
            expect(current.destination).toMatchObject({ kind: 'ready', workspaceRef: { label: 'Selected renamed' } });
        } finally { await screen.unmount(); }
    });
    it('PF4 retains inspection facts across equal refreshes and publishes real readiness changes', async () => {
        const { useProjectDefinitionInspection } = await import('./useProjectDefinitionInspection');
        const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const workspace = { serverId, workspaceId: 'checkout-a', machineId: 'machine-a', rootPath: '/repo' };
        const inspection = ProjectDefinitionInspectOutputSchema.parse({ definition: { basis: { kind: 'absent' }, document: null },
            detection: { entries: [], toolchains: [], devcontainers: [], coverage: 'complete', diagnostics: [] }, importCandidates: [],
            setupReadiness: { kind: 'unprepared', reviewedEffectDigest: 'effect-1' } });
        machineTransport.mockImplementation(async () => structuredClone(inspection));
        let current!: ReturnType<typeof useProjectDefinitionInspection>;
        let renders = 0;
        type Facts = Extract<NonNullable<typeof current.read>, { value: unknown }>['value'];
        const FactsSubscriber = React.memo(({ value }: { value: Facts | null }) => { renders++; return null; });
        function Probe() {
            const { binding } = useServerCredentialAccountScopeBinding(serverId);
            current = useProjectDefinitionInspection(workspace, binding);
            return React.createElement(FactsSubscriber, { value: current.read && 'value' in current.read ? current.read.value : null });
        }
        const screen = await renderScreen(React.createElement(Probe));
        try {
            await vi.waitFor(() => expect(current.read && 'value' in current.read ? current.read.value.setupReadiness?.kind : null).toBe('unprepared'));
            const before = current.read && 'value' in current.read ? current.read.value : null;
            renders = 0;
            const reads = machineTransport.mock.calls.length;
            await act(async () => { current.retry(); });
            await vi.waitFor(() => expect(machineTransport.mock.calls.length).toBeGreaterThan(reads));
            await vi.waitFor(() => expect(current.read && 'refreshing' in current.read ? current.read.refreshing : true).toBe(false));
            const after = current.read && 'value' in current.read ? current.read.value : null;
            expect({ sameFacts: after === before, renders }).toEqual({ sameFacts: true, renders: 0 });
            const prepared = { ...inspection, setupReadiness: { kind: 'current' as const, reviewedEffectDigest: 'effect-1', completedAtMs: 1000 } };
            machineTransport.mockImplementation(async () => structuredClone(prepared));
            await act(async () => { current.retry(); });
            await vi.waitFor(() => expect(current.read && 'value' in current.read ? current.read.value.setupReadiness?.kind : null).toBe('current'));
            expect(renders).toBe(1);
            const changed = current.read && 'value' in current.read ? current.read.value : null;
            expect(changed).not.toBe(before);
            expect(changed?.definition).toBe(before?.definition);
        } finally { await screen.unmount(); }
    });
    it('keeps an omitted-execution Script on SOURCE while its Run is pending despite a saved worker preference', async () => {
        const { ProjectScriptsBody } = await import('./ProjectScriptsBody');
        const workspace = { serverId, workspaceId: 'checkout-a', machineId: 'machine-a', rootPath: '/repo' };
        const manifest = { version: 1, scripts: { build: { source: { kind: 'command', command: 'build' } } } };
        const inspection = ProjectDefinitionInspectOutputSchema.parse({
            definition: { basis: { kind: 'present', hash: 'a'.repeat(64) }, document: {
                status: 'valid', bytes: JSON.stringify(manifest), original: manifest, manifest, diagnostics: [],
            } },
            detection: { entries: [], toolchains: [], devcontainers: [], coverage: 'complete', diagnostics: [] }, importCandidates: [],
        });
        homes.answer(homeId, `${WORKSPACE_EXECUTION_CONFIG_ROUTE_V1}/read`, { body: { status: 'present', revision: 1,
            content: { t: 'plain', v: { enabled: true, destination: { kind: 'machine', machineId: 'worker-b' },
                unavailable: 'ask', allowAdHoc: false, scriptOverrides: {}, services: {} } } } });
        homes.answer(homeId, '/v1/machines/managed/actions/list', { body: { machines: [] } });
        const pending = createDeferred<void>();
        let pendingReads = 0;
        machineTransport.mockResolvedValue(inspection);
        const actionSettings = { actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'projects.script.run': ['ui'] } } };
        homes.answer(homeId, '/v2/account/settings', { body: { version: 1, content: { t: 'plain', v: actionSettings } } });
        const { settingsParse } = await import('@/sync/domains/settings/settings');
        storage.getState().applySettingsForScope({ serverId, accountId: 'account-a' }, settingsParse(actionSettings), 1);
        homes.answer(homeId, '/v1/actions/projects.script.run/execution-authorization', { select: async () => {
            pendingReads++;
            await pending.promise;
            return { status: 403, body: { error: 'permission_denied' } };
        } });
        const screen = await renderScreen(React.createElement(ProjectScriptsBody, { workspace, testID: 'scripts' }));
        try {
            await vi.waitFor(() => expect(screen.findByTestId('scripts.script:build.run')).not.toBeNull());
            await vi.waitFor(() => expect(homes.requestsFor(`${WORKSPACE_EXECUTION_CONFIG_ROUTE_V1}/read`).length).toBeGreaterThan(1));
            await flushHookEffects();
            await act(async () => { await screen.pressByTestIdAsync('scripts.script:build.run'); });
            await vi.waitFor(() => expect(pendingReads).toBeGreaterThan(0));
            await flushHookEffects();
            expect(homes.requestsFor('/v1/machines/managed/actions/list')).toEqual([]);
        } finally {
            await screen.unmount();
            pending.resolve();
            await flushHookEffects();
        }
    });

    it.each([false, true])('uses effective setup and origins in inspection and return summaries (repository present: %s)', async repositoryPresent => {
        const { useProjectSetupReturnInspection } = await import('./useProjectSetupReturnInspection');
        const { useProjectDefinitionInspection } = await import('./useProjectDefinitionInspection');
        const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const { resolveProjectDefinitionV1 } = await import('@happier-dev/protocol/workspaces/projectSetup/projectDefinitionCompositionV1');
        const workspace = { serverId, workspaceId: 'effective-checkout', machineId: 'machine-a', rootPath: '/repo' };
        const repositoryManifest = { version: 1 as const, scripts: { build: { source: { kind: 'command' as const, command: 'old-build' } } } };
        const effectiveDefinition = resolveProjectDefinitionV1({
            repositoryManifest: repositoryPresent ? repositoryManifest : null,
            acceptedSharedSetup: { sourceId: 'shared-setup', digest: 'a'.repeat(64), contentRevision: { headerVersion: 1, bodyVersion: 1 },
                manifest: { version: 1, scripts: { build: { source: { kind: 'command', command: 'shared-build' } } },
                    services: { app: { source: { kind: 'command', command: 'serve' } } } } },
            setupOverrides: { version: 1, scripts: { lint: { source: { kind: 'command', command: 'personal-lint' } } } },
        });
        // beforeEach's real worker-preferences preflight inspected checkout-a; measure this mount's demand.
        machineTransport.mockClear();
        machineTransport.mockResolvedValue(ProjectDefinitionInspectOutputSchema.parse({
            definition: repositoryPresent ? { basis: { kind: 'present', hash: 'a'.repeat(64) }, document: {
                status: 'valid', manifest: repositoryManifest, diagnostics: [] } } : { basis: { kind: 'absent' }, document: null },
            detection: { entries: [], toolchains: [], devcontainers: [], coverage: 'complete', diagnostics: [] }, importCandidates: [],
            effectiveDefinition, setupReadiness: { kind: 'current', reviewedEffectDigest: 'accepted-effect', completedAtMs: 123 },
        }));
        const hook = await renderHook(() => {
            const { binding } = useServerCredentialAccountScopeBinding(serverId);
            return { ...useProjectDefinitionInspection(workspace, binding, { kind: 'setup' }),
                returned: useProjectSetupReturnInspection({ kind: 'project', accountId: 'account-a', workspace, page: 'scripts' }) };
        });
        try {
            await expect.poll(() => hook.getCurrent().read).toHaveProperty('value');
            await expect.poll(() => hook.getCurrent()).toMatchObject({
                effectiveDefinition: { kind: 'available', value: effectiveDefinition },
                returned: { summary: [t('projects.authoring.scriptsCount', { count: 2 }),
                    t('projects.authoring.servicesCount', { count: 1 })].join(' · '),
                    setupReadiness: { kind: 'current', reviewedEffectDigest: 'accepted-effect', completedAtMs: 123 } },
            });
            // Both mounted consumers share the one setup observation, including its origins.
            expect(machineTransport.mock.calls.filter(([request]) => request.method === 'daemon.projects.inspect.v1')
                .map(([request]) => request.payload)).toEqual([{ workspace, read: { kind: 'setup' } }]);
        } finally { await hook.unmount(); }
    });

    it.each([false, true])('does not reconstruct effective setup from a repository document (owner projection present: %s)', async projectionPresent => {
        const { useProjectSetupReturnInspection } = await import('./useProjectSetupReturnInspection');
        const { useProjectDefinitionInspection } = await import('./useProjectDefinitionInspection');
        const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const workspace = { serverId, workspaceId: 'missing-effective', machineId: 'machine-a', rootPath: '/repo' };
        machineTransport.mockResolvedValue(ProjectDefinitionInspectOutputSchema.parse({
            definition: { basis: { kind: 'present', hash: 'a'.repeat(64) }, document: { status: 'valid', diagnostics: [],
                manifest: { version: 1, scripts: { stale: { source: { kind: 'command', command: 'stale' } } } } } },
            ...(projectionPresent ? { effectiveDefinition: { effectiveManifest: null, origins: [] } } : {}),
            detection: { entries: [], toolchains: [], devcontainers: [], coverage: 'complete', diagnostics: [] }, importCandidates: [],
        }));
        const hook = await renderHook(() => {
            const { binding } = useServerCredentialAccountScopeBinding(serverId);
            return { ...useProjectDefinitionInspection(workspace, binding, { kind: 'setup' }),
                returned: useProjectSetupReturnInspection({ kind: 'project', accountId: 'account-a', workspace, page: 'scripts' }) };
        });
        try {
            await expect.poll(() => hook.getCurrent().read).toHaveProperty('value');
            expect(hook.getCurrent()).toMatchObject({
                effectiveDefinition: projectionPresent ? { kind: 'available', value: { effectiveManifest: null, origins: [] } }
                    : { kind: 'unavailable', code: 'project_setup_review_unavailable' },
                returned: { summary: null, setupReadiness: null },
            });
        } finally { await hook.unmount(); }
    });

    it.each([
        undefined,
        { kind: 'unprepared', reviewedEffectDigest: 'current-effect' },
        { kind: 'unknown', code: 'project_setup_failed' },
        { kind: 'current', reviewedEffectDigest: 'current-effect', completedAtMs: 123 },
    ] as const)('exposes only current inspection readiness, including absent/failed preparation (%j)', async (setupReadiness) => {
        const { useProjectSetupReturnInspection } = await import('./useProjectSetupReturnInspection');
        const workspace = { serverId, workspaceId: 'checkout-a', machineId: 'machine-a', rootPath: '/repo' };
        machineTransport.mockResolvedValue(ProjectDefinitionInspectOutputSchema.parse({
            definition: { basis: { kind: 'absent' }, document: null },
            detection: { entries: [], toolchains: [], devcontainers: [], coverage: 'complete', diagnostics: [] },
            effectiveDefinition: { effectiveManifest: null, origins: [] },
            importCandidates: [], ...(setupReadiness ? { setupReadiness } : {}),
        }));
        const hook = await renderHook(() => useProjectSetupReturnInspection({ kind: 'project', accountId: 'account-a', workspace, page: 'scripts' }));
        try {
            await expect.poll(() => machineTransport.mock.calls.length).toBeGreaterThan(0);
            await expect.poll(() => hook.getCurrent()).toMatchObject({
                summary: null, setupReadiness: setupReadiness ?? null,
            });
        } finally { await hook.unmount(); }
    });

    it.each([
        { page: 'changes' },
        { page: 'scripts', purpose: 'session' },
    ] as const)('does not inspect setup or expose readiness for non-setup authoring (%j)', async (destination) => {
        const { useProjectSetupReturnInspection } = await import('./useProjectSetupReturnInspection');
        machineTransport.mockClear();
        const hook = await renderHook(() => useProjectSetupReturnInspection({ kind: 'project', accountId: 'account-a',
            workspace: { serverId, workspaceId: 'checkout-a', machineId: 'machine-a', rootPath: '/repo' }, ...destination }));
        try {
            expect(hook.getCurrent()).toEqual({ summary: null, setupReadiness: null });
            expect(machineTransport).not.toHaveBeenCalled();
        } finally { await hook.unmount(); }
    });
});

describe('Project setup through ordinary authoring', () => {
    it('retains the reopened draft identity while its original Project rows are unavailable, without admitting a return', async () => {
        const scope = { serverId, accountId: 'account-a' };
        const workspace = { serverId, workspaceId: 'checkout-a', machineId: 'machine-a', rootPath: '/repo' };
        const result = await openProjectSetupAuthoring({ workspace });
        if (!result.ok) throw new Error(result.errorCode);
        const opened = SessionAuthoringOpenResultV1Schema.parse(result.result);
        if (opened.kind !== 'opened') throw new Error('Expected the seeded draft');
        const { resetSessionDraftRepositoryForTests } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        resetSessionDraftRepositoryForTests();
        const reopened = readNewSessionDraftProjectionFromRepository({ scope, draftId: opened.draftId })?.draft;
        if (!reopened?.authoringOrigin) throw new Error('Expected the persisted authoring origin');
        storage.getState().clearProjectAccountRowsScope();
        expect(resolveCurrentProjectAuthoringReturn(reopened.authoringOrigin)).toMatchObject({ kind: 'unavailable' });
        const screen = await renderScreen(React.createElement(React.Fragment, null,
            React.createElement(ProjectSetupDraftHeader, { origin: reopened.authoringOrigin }),
            React.createElement(ProjectSetupDraftFootnote, { origin: reopened.authoringOrigin }),
        ));
        try {
            await expect.poll(() => screen.getTextContent()).toContain(t('projects.authoring.draftTitle', { project: 'repo' }));
            expect(screen.findHostByTestId('project-setup-draft-footnote')).not.toBeNull();
            expect(reopened.sessionName).toBe(t('projects.authoring.draftTitle', { project: 'repo' }));
            expect(resolveCurrentProjectAuthoringReturn(reopened.authoringOrigin)).toMatchObject({ kind: 'unavailable' });
        } finally { await screen.unmount(); }
    });
    it('does not display another Account’s retained draft identity while Project rows are unavailable', async () => {
        storage.getState().clearProjectAccountRowsScope();
        const origin = { kind: 'project', accountId: 'other-account', page: 'scripts',
            workspace: { serverId, workspaceId: 'checkout-a', machineId: 'machine-a', rootPath: '/private-project' } } as const;
        const screen = await renderScreen(React.createElement(React.Fragment, null,
            React.createElement(ProjectSetupDraftHeader, { origin }),
            React.createElement(ProjectSetupDraftFootnote, { origin }),
        ));
        try {
            expect(screen.findHostByTestId('project-setup-draft-origin')).toBeNull();
            expect(screen.findHostByTestId('project-setup-draft-footnote')).toBeNull();
        } finally { await screen.unmount(); }
    });
    it('keeps detection facts readable and qualified ids and hashes out of the editable prompt, with a seeded Session name', async () => {
        const workspace = { serverId, workspaceId: 'checkout-a', machineId: 'machine-a', rootPath: '/repo' };
        const scope = { serverId, accountId: 'account-a' };
        machineTransport.mockResolvedValue(ProjectDefinitionInspectOutputSchema.parse({
            definition: { basis: { kind: 'absent' }, document: null },
            detection: { entries: [], toolchains: [], devcontainers: [], coverage: 'complete', diagnostics: [] }, importCandidates: [],
            detectionSummary: { total: 2, scripts: 1, services: 1, files: [
                { file: 'package.json', total: 1, scripts: 1, services: 0 },
                { file: 'compose.yaml', total: 1, scripts: 0, services: 1 },
            ] },
        }));
        const result = await openProjectSetupAuthoring({ workspace });
        expect(machineTransport.mock.calls.at(-1)?.[0]?.payload.read).toEqual({ kind: 'guidance' });
        if (!result.ok) throw new Error(result.errorCode);
        const opened = SessionAuthoringOpenResultV1Schema.parse(result.result);
        if (opened.kind !== 'opened') throw new Error('Draft refused');
        const draft = readNewSessionDraftProjectionFromRepository({ scope, draftId: opened.draftId })?.draft;
        expect(draft?.input).toContain('package.json');
        expect(draft?.input).toContain('compose.yaml');
        expect.soft(draft?.input).toContain(t('projects.authoring.scriptsCount', { count: 1 }));
        expect.soft(draft?.input).toContain(t('projects.authoring.servicesCount', { count: 1 }));
        for (const value of ['serverId', 'workspaceId', '{', workspace.serverId, workspace.workspaceId, workspace.machineId]) {
            expect.soft(draft?.input).not.toContain(value);
        }
        expect.soft(draft?.sessionName).toBe(t('projects.authoring.draftTitle', { project: 'repo' }));
    });
    it('reads native detail through the real Action only while demanded by its captured Account', async () => {
        const { useProjectDefinitionDemand, ProjectNativeInvocationDetail } = await import('./ProjectNativeInvocationDetail');
        const workspace = { serverId, workspaceId: 'checkout-a', machineId: 'machine-a', rootPath: '/repo' };
        const source = { kind: 'native', tool: 'package_script', file: 'package.json', target: 'test' } as const;
        const selection: ProjectDefinitionInspectRead = { kind: 'detail', sources: [{ source, usage: 'script' }] };
        const answer = (args: string[]) => ProjectDefinitionInspectOutputSchema.parse({
            definitionScope: 'statusOnly',
            definition: { basis: { kind: 'absent' }, document: null },
            detection: { entries: [], toolchains: [], devcontainers: [], coverage: 'complete', diagnostics: [] },
            importCandidates: [{ source, usage: 'script', availability: 'available', preselected: true,
                invocation: { tool: 'yarn', args, cwd: '/repo' } }],
        });
        const pending = createDeferred<unknown>();
        const reopened = createDeferred<unknown>();
        const requests: unknown[] = [];
        machineTransport.mockImplementation(async request => {
            const input = ProjectDefinitionInspectInputSchema.parse(request.payload);
            requests.push(input.read);
            return await pending.promise;
        });
        for (const capturedAccount of [null, 'other-account']) {
            const refused = await renderScreen(React.createElement(ProjectNativeInvocationDetail, {
                workspace, accountId: capturedAccount, source, usage: 'script', testID: 'captured-native',
            }));
            try {
                await vi.waitFor(() => expect(refused.findAllByTestId('captured-native').some(node =>
                    node.props.kind === 'unavailable' && node.props.diagnosticCode === 'not_authenticated')).toBe(true));
                expect(requests).toEqual([]);
            } finally { await refused.unmount(); }
        }
        let open = false;
        let accountId = 'other-account';
        const hook = await renderHook(() => useProjectDefinitionDemand(workspace, accountId, selection, open));
        try {
            expect(requests).toEqual([]);
            open = true;
            await hook.rerender();
            expect(requests).toEqual([]);
            await vi.waitFor(() => expect(hook.getCurrent().scopeError).toBe('not_authenticated'));
            accountId = 'account-a';
            await hook.rerender();
            await vi.waitFor(() => expect(requests).toEqual([selection]));
            expect(hook.getCurrent().read).toBeNull();
            expect(hook.getCurrent().scopeError).toBeNull();
            await act(async () => pending.resolve(answer(['test'])));
            await vi.waitFor(() => expect(hook.getCurrent().read).toHaveProperty('value.importCandidates.0.invocation.args', ['test']));
            open = false;
            await hook.rerender();
            expect(hook.getCurrent().read).toBeNull();
            expect(requests).toEqual([selection]);
            machineTransport.mockImplementation(async request => {
                requests.push(ProjectDefinitionInspectInputSchema.parse(request.payload).read);
                return await reopened.promise;
            });
            open = true;
            await hook.rerender();
            await vi.waitFor(() => expect(requests).toEqual([selection, selection]));
            expect(hook.getCurrent().read).toBeNull();
            await act(async () => reopened.resolve(answer(['test', '--watch'])));
            await vi.waitFor(() => expect(hook.getCurrent().read).toHaveProperty('value.importCandidates.0.invocation.args', ['test', '--watch']));
            expect(requests).toEqual([selection, selection]);
            accountId = 'other-account';
            await hook.rerender();
            expect(hook.getCurrent().read).toBeNull();
            expect(hook.getCurrent().scopeError).toBe('not_authenticated');
            expect(requests).toEqual([selection, selection]);
        } finally { reopened.resolve(answer(['test', '--watch'])); await hook.unmount(); }
    });
    it('settles opened native detail when Home identity is retained without a current credential binding', async () => {
        const { ProjectNativeInvocationDetail, useProjectDefinitionDemand } = await import('./ProjectNativeInvocationDetail');
        const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const { adoptHomeProfile } = await import('@/sync/domains/server/serverProfiles');
        const workspace = { serverId, workspaceId: 'checkout-a', machineId: 'machine-a', rootPath: '/repo' };
        const source = { kind: 'native', tool: 'package_script', file: 'package.json', target: 'test' } as const;
        const selection: ProjectDefinitionInspectRead = { kind: 'detail', sources: [{ source, usage: 'script' }] };
        const renewedUrl = 'https://project-authoring-renewed.test';
        const credentials = createDeferred<Awaited<ReturnType<typeof TokenStorage.getCredentialsForServerUrl>>>();
        const readCredentials = TokenStorage.getCredentialsForServerUrl.bind(TokenStorage);
        // Device credential storage is the boundary; the scope owner and retirement stay real.
        const storageRead = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation((url, options) =>
            url === renewedUrl ? credentials.promise : readCredentials(url, options));
        const hook = await renderHook(() => ({
            scope: useServerCredentialAccountScopeBinding(serverId),
            demand: useProjectDefinitionDemand(workspace, 'account-a', selection, true),
        }));
        const screen = await renderScreen(React.createElement(ProjectNativeInvocationDetail, {
            workspace, accountId: 'account-a', source, usage: 'script', testID: 'renewed-native',
        }));
        try {
            await vi.waitFor(() => expect(hook.getCurrent().demand.read).toHaveProperty('value'));
            const beforeRenewal = machineTransport.mock.calls.length;
            await act(async () => { await adoptHomeProfile({
                descriptor: { serverUrl: renewedUrl, homeServerIdentityId: serverId },
                source: 'manual', descriptorAuthority: 'current_connection_observation',
            }); });
            await vi.waitFor(() => expect(hook.getCurrent().scope).toMatchObject({
                resolution: { kind: 'bound', scope: { accountId: 'account-a' } }, binding: null,
            }));
            expect(hook.getCurrent().demand.read).toBeNull();
            expect(hook.getCurrent().demand.scopeError).toBe('unavailable');
            expect(screen.findAllByTestId('renewed-native').some(node =>
                node.props.kind === 'unavailable' && node.props.diagnosticCode === 'unavailable')).toBe(true);
            expect(machineTransport.mock.calls).toHaveLength(beforeRenewal);
        } finally {
            await screen.unmount();
            await hook.unmount();
            storageRead.mockRestore();
            credentials.resolve(null);
        }
    });
    it('opens an authoring draft for literal manifest scripts with empty native detection', async () => {
        const workspace = { serverId, workspaceId: 'checkout-a', machineId: 'machine-a', rootPath: '/repo' };
        const manifest = { version: 1, scripts: { test: { source: { kind: 'command', command: 'echo ready' } } } };
        machineTransport.mockResolvedValue(ProjectDefinitionInspectOutputSchema.parse({
            definition: { basis: { kind: 'present', hash: 'b'.repeat(64) },
                document: { status: 'valid', bytes: JSON.stringify(manifest), original: manifest, manifest, diagnostics: [] } },
            detection: { entries: [], toolchains: [], devcontainers: [], coverage: 'complete', diagnostics: [] }, importCandidates: [],
        }));
        const result = await openProjectSetupAuthoring({ workspace });
        if (!result.ok) throw new Error(result.errorCode);
        const opened = SessionAuthoringOpenResultV1Schema.parse(result.result);
        if (opened.kind !== 'opened') throw new Error('Draft refused');
        const draft = readNewSessionDraftProjectionFromRepository({ scope: { serverId, accountId: 'account-a' }, draftId: opened.draftId })?.draft;
        expect(draft?.input).toContain(t('projects.authoring.scriptsCount', { count: 1 }));
        expect(draft?.input).not.toContain('test:');
        expect(draft?.input).not.toContain(t('projects.scripts.foundIn', { files: '' }));
        expect(draft?.input).not.toContain('undefined');
    });
    it('seeds an empty checkout with the request alone, never a zero count', async () => {
        const workspace = { serverId, workspaceId: 'checkout-a', machineId: 'machine-a', rootPath: '/repo' };
        machineTransport.mockResolvedValue(ProjectDefinitionInspectOutputSchema.parse({
            definition: { basis: { kind: 'absent' }, document: null },
            detection: { entries: [], toolchains: [], devcontainers: [], coverage: 'complete', diagnostics: [] }, importCandidates: [],
        }));
        const result = await openProjectSetupAuthoring({ workspace });
        if (!result.ok) throw new Error(result.errorCode);
        const opened = SessionAuthoringOpenResultV1Schema.parse(result.result);
        if (opened.kind !== 'opened') throw new Error('Draft refused');
        const draft = readNewSessionDraftProjectionFromRepository({ scope: { serverId, accountId: 'account-a' }, draftId: opened.draftId })?.draft;
        expect(draft?.input).toContain(t('projects.authoring.prompt'));
        expect(draft?.input).not.toContain(t('projects.authoring.scriptsCount', { count: 0 }));
        expect(draft?.input.trimEnd()).toBe(draft?.input);
    });
    it('returns the typed inspection failure without writing a draft or navigating', async () => {
        const scope = { serverId, accountId: 'account-a' };
        const before = listNewSessionDraftProjections(scope).length;
        machineTransport.mockRejectedValue(new Error('inspection transport failed'));
        expect(await openProjectSetupAuthoring({ workspace: {
            serverId, workspaceId: 'checkout-a', machineId: 'machine-a', rootPath: '/repo',
        } })).toMatchObject({ ok: false, errorCode: 'action_failed' });
        expect(listNewSessionDraftProjections(scope)).toHaveLength(before);
        expect(navigation.push).not.toHaveBeenCalled();
    });
    it.each(['account-a', 'other-account'])('reads the mounted Session return summary only for its original Home Account (%s)', async (accountId) => {
        const { resolveProjectDefinitionV1 } = await import('@happier-dev/protocol/workspaces/projectSetup/projectDefinitionCompositionV1');
        const workspace = { serverId, workspaceId: 'checkout-a', machineId: 'machine-a', rootPath: '/repo' };
        const source = { kind: 'native' as const, tool: 'package_script' as const, file: 'package.json', target: 'test' };
        const manifest = { version: 1 as const, scripts: { test: { source }, lint: { source: { ...source, target: 'lint' } } } };
        const inspection = ProjectDefinitionInspectOutputSchema.parse({
            definition: { basis: { kind: 'present', hash: 'b'.repeat(64) },
                document: { status: 'valid', bytes: JSON.stringify(manifest), original: manifest, manifest, diagnostics: [] } },
            detection: { entries: [], toolchains: [], devcontainers: [], coverage: 'complete', diagnostics: [] }, importCandidates: [],
            effectiveDefinition: resolveProjectDefinitionV1({ repositoryManifest: manifest }),
        });
        machineTransport.mockClear();
        machineTransport.mockImplementation(async ({ method, payload, accountId: requester, serverId: home }) => {
            expect(method).toBe('daemon.projects.inspect.v1');
            expect(payload).toEqual({ workspace, read: { kind: 'setup' } });
            expect(requester).toBe('account-a');
            expect(home).toBe(serverId);
            return inspection;
        });
        if (accountId === 'account-a') {
            const { createProjectManifestActionClient } = await import('./projectManifestActionClient');
            expect(await createProjectManifestActionClient({ workspace, expectedAccountId: accountId }).inspect({ kind: 'setup' }))
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
    it.each(['overview', 'scripts'] as const)('ordinary %s origin returns to its original dashboard/file without setup inspection', async page => {
        const origin = { kind: 'project', purpose: 'session', accountId: 'account-a', page, layoutId: 'release-dashboard',
            workspace: { serverId, workspaceId: 'checkout-a', machineId: 'machine-a', rootPath: '/repo' },
            surface: 'tabs', companion: 'files', resource: { kind: 'file', path: 'src/a.ts' },
        } as const;
        const session = createSessionFixture({ id: 'ordinary-session', metadata: {
            path: '/edited', machineId: 'worker-b', host: 'worker.local', work: { authoringOriginV1: origin },
        } });
        storage.getState().applySessions([session]);
        machineTransport.mockClear();
        const screen = await renderScreen(React.createElement(ProjectSetupSessionReturn, { sessionId: session.id, serverId }));
        try {
            expect(screen.findHostByTestId('project-setup-return')).not.toBeNull();
            expect(screen.findHostByTestId('project-setup-return.changes')).toBeNull();
            expect(screen.findHostByTestId('project-setup-return.scripts')).toBeNull();
            await screen.pressByTestIdAsync('project-setup-return.origin');
            const url = new URL(String(navigation.push.mock.calls.at(-1)?.[0]), 'https://happier.test');
            expect(url.pathname).toBe(`/projects/checkout-a/${page}`);
            expect(Object.fromEntries(url.searchParams)).toMatchObject({ serverId, layoutId: 'release-dashboard',
                mobileSurface: 'tabs', right: 'files', initialFile: 'src/a.ts' });
            expect(machineTransport).not.toHaveBeenCalled();
        } finally { await screen.unmount(); }
    });
    it('keeps an ask-each-time pool candidate advisory and ad-hoc opt-in separate from approval', async () => {
        const workspace = { serverId, workspaceId: 'checkout-a', machineId: 'machine-a', rootPath: '/repo' };
        const scope = { serverId, accountId: 'account-a' };
        const poolId = '7a93eb84-8b44-4c4d-bd7f-1fb2c6716514';
        const destination = { kind: 'pool', poolId, selection: 'ask' } as const;
        homes.answer(homeId, `${WORKSPACE_EXECUTION_CONFIG_ROUTE_V1}/read`, { body: {
            status: 'present', revision: 9, content: { t: 'plain', v: {
                enabled: true, destination, unavailable: 'ask', allowAdHoc: true, scriptOverrides: {}, services: {},
            } },
        } });
        homes.answer(homeId, machinePoolActionEndpointPathV1('machines.pools.get'), { body: MachinePoolViewV1Schema.parse({
            pool: { id: poolId, name: 'Workers', description: null, revision: 2, createdAt: 1, updatedAt: 2,
                members: [{ machineId: 'worker-b', priorityTier: 0, enabled: true, state: 'connected' }] },
            availability: { state: 'known', connectedCount: 1, enabledCount: 1 },
        }) });
        machineTransport.mockImplementation(async ({ method, machineId, payload, accountId }) => {
            expect(accountId).toBe(scope.accountId);
            if (method === 'daemon.projects.inspect.v1') {
                expect(machineId).toBe(workspace.machineId);
                expect(payload).toEqual({ workspace, read: { kind: 'guidance' } });
                return ProjectDefinitionInspectOutputSchema.parse({ definition: { basis: { kind: 'absent' }, document: null },
                    detection: { entries: [], toolchains: [], devcontainers: [], coverage: 'complete', diagnostics: [] }, importCandidates: [] });
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
        expect(machineTransport.mock.calls.filter(([request]) => request.method === 'projects.worker.status')).toHaveLength(0);
        expect(homes.requestsFor(machinePoolActionEndpointPathV1('machines.pools.get'))).toHaveLength(0);
        const facts = await currentGuidance(workspace);
        expect(draft.input).not.toContain('{');
        expect(facts).toMatchObject({ advisory: true, sourceWorkspace: workspace,
            workerPreferences: { status: 'ready', preference: { destination, allowAdHoc: true, unavailable: 'ask' } },
            destination: { configured: destination, observation: { kind: 'resolved', poolId, machineId: 'worker-b' } },
            adHoc: { actionId: 'projects.compute.exec', approval: 'configured_action_policy',
                resolution: { status: 'resolved', choice: { kind: 'workers', destination } } } });
        expect(facts).not.toHaveProperty('acceptedTarget');
        expect(draft).toMatchObject({ selectedMachineId: workspace.machineId, selectedPath: workspace.rootPath });
        expect(storage.getState().sessions).toBe(sessionsBefore);
        expect(homes.requestsFor(machinePoolActionEndpointPathV1('machines.pools.get'))).toContainEqual(expect.objectContaining({ serverId: homeId, input: { poolId } }));
        expect(homes.requests.filter(request => request.path.endsWith('/mutate') || request.path.endsWith('/create'))).toEqual([]);
    });
    it.each(['read_only', 'refused', 'invalid_output'] as const)('delivers current worker facts to the editable draft without admitting a target or approving an ad-hoc command (%s)', async (statusMode) => {
        const workspace = { serverId, workspaceId: 'checkout-a', machineId: 'machine-a', rootPath: '/repo' };
        const scope = { serverId, accountId: 'account-a' };
        const source = { kind: 'native' as const, tool: 'package_script' as const, file: 'package.json', target: 'test' };
        const manifest = { version: 1 as const, scripts: {
            local: { source }, portable: { source, execution: 'portable' as const },
        }, services: { web: { source, port: 5173 }, server: { source } } };
        const inspection = ProjectDefinitionInspectOutputSchema.parse({
            definition: { basis: { kind: 'present', hash: 'a'.repeat(64) },
                document: { status: 'valid', bytes: JSON.stringify(manifest), original: manifest, manifest, diagnostics: [] } },
            detection: { entries: [], toolchains: [], devcontainers: [], coverage: 'complete', diagnostics: [] }, importCandidates: [],
            commands: [{ name: 'local', usage: 'script', source, availability: 'available',
                invocation: { tool: 'yarn', args: ['run', 'test'], cwd: workspace.rootPath, requestedVersion: '4.6.0' } }],
            tools: [{ tool: 'yarn', file: 'package.json', requestedVersion: '4.6.0', availability: 'available', version: '4.6.0' },
                { tool: 'protoc', file: 'mise.toml', requestedVersion: '29', availability: 'unavailable' }],
        });
        const preference = { enabled: true, destination: { kind: 'machine', machineId: 'worker-b' },
            unavailable: 'fail', allowAdHoc: false, scriptOverrides: { local: 'workers' } } as const;
        homes.answer(homeId, `${WORKSPACE_EXECUTION_CONFIG_ROUTE_V1}/read`, {
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
                expect(payload).toEqual({ workspace, read: { kind: 'guidance' } });
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
                services: [{ name: 'web', source, port: 5173 }, { name: 'server', source }],
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
        machineTransport.mockClear();
        const result = await openProjectSetupAuthoring({ workspace });
        if (!result.ok) throw new Error(result.errorCode);
        const opened = SessionAuthoringOpenResultV1Schema.parse(result.result);
        if (opened.kind !== 'opened') throw new Error(`Draft refused: ${opened.kind}`);
        const draft = readNewSessionDraftProjectionFromRepository({ scope, draftId: opened.draftId })?.draft;
        if (!draft) throw new Error('Draft missing');
        expect(machineTransport.mock.calls.filter(([request]) => request.method === 'projects.worker.status')).toHaveLength(0);
        // Detailed advisory facts remain at the real read owner; the composer receives prose only.
        const facts = await currentGuidance(workspace);
        expect(facts).toMatchObject({ services: [{ name: 'web', source, port: 5173 }, { name: 'server', source }] });
        const { describeProjectAgentGuidance } = await import('../workers/ProjectAgentGuidanceDisclosure');
        const guide = describeProjectAgentGuidance(facts, 'repo');
        expect(guide).toContain('web, server');
        expect(draft.input).not.toContain('{');
        expect(draft.input).toContain('package.json');
        expect(draft.input).not.toContain('protoc');
        expect(draft.input).not.toContain(preference.destination.machineId);
        if (statusMode === 'read_only') expect(facts).toEqual(readonlyGuidance);
        expect(facts).toMatchObject({
            advisory: true,
            sourceWorkspace: workspace,
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
        expect(facts).not.toHaveProperty('commands');
        expect(facts).not.toHaveProperty('tools');
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
        homes.answer(homeId, `${WORKSPACE_EXECUTION_CONFIG_ROUTE_V1}/read`, {
            // The genuine HTTP boundary returns malformed content; the real row reader classifies it.
            body: { status: 'present', revision: 3, content: { t: 'plain', v: { enabled: true } } },
        });
        const result = await openProjectSetupAuthoring({ workspace });
        if (!result.ok) throw new Error(result.errorCode);
        const opened = SessionAuthoringOpenResultV1Schema.parse(result.result);
        if (opened.kind !== 'opened') throw new Error(`Draft refused: ${opened.kind}`);
        const draft = readNewSessionDraftProjectionFromRepository({ scope, draftId: opened.draftId })?.draft;
        if (!draft) throw new Error('Draft missing');
        const facts = await currentGuidance(workspace);
        expect(draft.input).not.toContain('{');
        expect(draft.input).toContain(t('projectWorkers.policyUnavailable'));
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
        const facts = await currentGuidance(workspace);
        expect(draft.input).not.toContain('{');
        expect(facts).toMatchObject({ workerPreferences: { status: 'ready', revision: 'absent', provenance: 'default',
            preference: { enabled: false, unavailable: 'ask', allowAdHoc: false, scriptOverrides: {} } },
            scripts: [], destination: null, adHoc: { resolution: { status: 'refused', reason: 'ad_hoc_disabled' } } });
        writeNewSessionDraftToRepository({ scope, draftId: acknowledgement.draftId, draft: { ...draft,
            input: 'My edited setup prompt', selectedMachineId: 'edited-machine', selectedPath: '/other',
            executionTarget: { kind: 'machine', target: { serverId, machineId: 'edited-machine' } },
        } });
        const reopened = readNewSessionDraftProjectionFromRepository({ scope, draftId: acknowledgement.draftId })?.draft;
        expect(reopened).toMatchObject({ input: 'My edited setup prompt', selectedMachineId: 'edited-machine', selectedPath: '/other' });
        const { resetSessionDraftRepositoryForTests } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        resetSessionDraftRepositoryForTests();
        const persisted = readNewSessionDraftProjectionFromRepository({ scope, draftId: acknowledgement.draftId })?.draft;
        expect(persisted).toMatchObject({ input: 'My edited setup prompt', selectedMachineId: 'edited-machine', selectedPath: '/other' });
        // Reconstruct from serialized local storage, then exercise the strict origin
        // consumer. Reading the just-written in-memory draft cannot prove reopen.
        expect(PluginUiNewSessionSeedOriginV1Schema.parse(persisted?.authoringOrigin)).toEqual(draft.authoringOrigin);
        const destination = resolveCurrentProjectAuthoringReturn(persisted?.authoringOrigin);
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
        const credentialRead = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementationOnce(async () => {
            entered.resolve();
            await release.promise;
            return connection?.credentials ?? null;
        });
        const entry = await renderHook((input: { workspace: typeof workspace }) => useProjectSetupAuthoring(input), {
            initialProps: { workspace },
        });
        try {
            const opening = entry.getCurrent().onSetUpWithAgent();
            await entered.promise;
            await entry.rerender({ workspace: { ...workspace, rootPath: '/different-checkout' } });
            release.resolve();
            expect(await opening).toEqual({ ok: true, result: { kind: 'unavailable', reason: 'aborted' } });
            expect(listNewSessionDraftProjections(scope)).toHaveLength(before);
            expect(navigation.push).not.toHaveBeenCalled();
        } finally { release.resolve(); credentialRead.mockRestore(); await entry.unmount(); }
    });
});
