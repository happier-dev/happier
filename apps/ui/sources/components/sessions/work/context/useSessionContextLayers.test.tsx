import * as React from 'react';
import { sessionInfoDisclosuresState } from '@/sync/domains/state/disclosureUiState';
import { replacePersistentUiStateForTest } from '@/dev/testkit/harness/persistentUiState';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProfileCatalogSnapshotV1 } from '@happier-dev/protocol/profiles/profileCatalogV1';
import { AIBackendProfileSchema } from '@happier-dev/protocol/profiles/backendProfileSchema';
import { getBuiltInBackendProfile } from '@happier-dev/protocol/profiles/builtInBackendProfiles';
import { createPlainArtifactHomeFixture, createPlainArtifactHttpFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createDeferred, createSessionFixture, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createRealAppRouteElement } from '@/dev/testkit/render/renderRealAppRoute';
import { applyProjectAccountRowsFixture, createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import type { ProjectAccountRowsSnapshot } from '@/sync/domains/workspaces/projectAccountRows';
import { ProjectSourceV1Schema, PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { saveAccountSettings } = await import('@/sync/domains/state/accountSettingsPersistence');
const { saveAuthoringMemoryProjection } = await import('@/sync/domains/state/authoringMemoryPersistence');
const { settingsDefaults } = await import('@/sync/domains/settings/settings');
const { applyProfileCatalogSnapshot, resetProfileCatalogSnapshotsForTests } = await import('@/sync/store/settings/profileCatalogSnapshot');
const { resetProfileCatalogEngineForTests } = await import('@/sync/engine/settings/profileCatalogEngine');
const { useHomeAiLaunchProfileCatalog } = await import('@/sync/store/useAiLaunchProfiles');
const { storage } = await import('@/sync/domains/state/storage');
const { useSessionContextLayers } = await import('./useSessionContextLayers');

const ready: ProfileCatalogSnapshotV1 = {
    status: 'ready', authority: 'inactive', source: 'destination', control: null,
    controlRevision: 'absent', records: [], diagnostics: [], referenceGuardRevision: 'absent',
};
let fixture: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> | undefined;
afterEach(async () => {
    standardCleanup();
    resetProfileCatalogEngineForTests();
    resetProfileCatalogSnapshotsForTests();
    await fixture?.dispose();
    fixture = undefined;
});

describe('Work admitted Profile context', () => {
    it('pins Skills from Info through the same placement owner as the Session rail', async () => {
        fixture = await createPlainArtifactHomeFixture('https://info-skills-pin.example');
        const scope = { serverId: fixture.home.id, accountId: 'artifact-account' };
        storage.getState().applySettingsForScope(scope, settingsDefaults, 1);
        const { SessionSetupSections } = await import('../SessionSetupSections');
        const { RightSidebarActionRail } = await import('@/components/appShell/rightSidebar/RightSidebarActionRail');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const session = createSessionFixture({ id: 'skills-info', serverId: scope.serverId });
        let opens = 0;
        function Setup() { return <>
            <SessionSetupSections session={session} serverId={scope.serverId} onOpenSkills={() => { opens++; }} />
            <RightSidebarActionRail surfaceId="sessionRail" testIDPrefix="skills-test-rail" actions={[{
                id: 'skills', label: 'Skills', icon: 'lightbulb', active: false, defaultPlacement: 'overflow', onPress: () => {},
            }]} />
        </>; }
        const screen = await renderScreen(await createRealAppRouteElement(Setup,
            await TokenStorage.getCredentialsForServerUrl(fixture.home.serverUrl, { serverId: scope.serverId })));
        expect(screen.findByTestId('skills-test-rail:skills')).toBeNull();
        await screen.pressByTestIdAsync('session-setup-skills.pin');
        await waitForHomeGovernance(() => expect(screen.findByTestId('skills-test-rail:skills')).not.toBeNull());
        expect(opens).toBe(0);
        await screen.pressByTestIdAsync('session-setup-skills');
        expect(opens).toBe(1);
        await screen.pressByTestIdAsync('session-setup-skills.pin');
        await waitForHomeGovernance(() => expect(screen.findByTestId('skills-test-rail:skills')).toBeNull());
    });
    it('projects admitted personal Project rows without a new census and retains them during refresh', async () => {
        let censusRequests = 0;
        let projectRows: Pick<ProjectAccountRowsSnapshot, 'workspaceRefs' | 'organizations'> = { workspaceRefs: [], organizations: [] };
        fixture = await createPlainArtifactHomeFixture('https://work-project-continuity.example', {
            handleRequest: async path => {
                if (path !== '/v1/account/project-rows/list') return null;
                censusRequests += 1;
                return Response.json(createPlainProjectAccountRowListFixture(projectRows));
            },
        });
        const scope = { serverId: fixture.home.id, accountId: 'artifact-account' };
        storage.getState().applySettingsForScope(scope, settingsDefaults, 1);
        projectRows = {
            workspaceRefs: [{ id: 'checkout', serverId: scope.serverId, machineId: 'machine', rootPath: '/repo',
                projectKey: 'project', createdAtMs: 1 }],
            organizations: [{ key: { kind: 'project-organization', serverId: scope.serverId, projectKey: 'project' }, revision: 0,
                value: { promptStack: [{ id: 'project.memory', ref: { kind: 'doc', artifactId: 'project-memory' },
                    enabled: true, placement: 'system_append' }] } }],
        };
        applyProjectAccountRowsFixture(storage, projectRows);
        const memory = { id: 'project-memory', title: 'Project memory',
            header: { v: 1, kind: 'memory_doc.v1', title: 'Project memory' },
            ownerAccountId: scope.accountId, access: 'owner' as const, isDecrypted: true as const,
            body: JSON.stringify({ v: 1, index: [{ id: 'fact', text: 'Keep the release notes current', createdAtMs: 1,
                sourceSessionRef: null }], topics: [] }),
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        fixture.boundary.replaceStoredRow(createPlainArtifactHttpFixture(memory, scope.accountId));
        storage.getState().applyArtifacts([memory]);
        const hook = await renderHook(() => useSessionContextLayers({ serverId: scope.serverId, sessionId: 'work',
            ownerMetadata: { machineId: 'machine', path: '/repo', work: { memoryEnabled: true } }, metadataVersion: 1 }));
        const { SessionContextSection } = await import('./SessionContextSection');
        const { SessionMemorySection } = await import('../memory/SessionMemorySection');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const session = createSessionFixture({ id: 'work', serverId: scope.serverId, metadataVersion: 1,
            metadata: { path: '/repo', host: 'localhost', machineId: 'machine', work: { memoryEnabled: true } } });
        function Work() {
            return <><SessionContextSection session={session} serverId={scope.serverId} />
                <SessionMemorySection session={session} serverId={scope.serverId} /></>;
        }
        const screen = await renderScreen(await createRealAppRouteElement(Work,
            await TokenStorage.getCredentialsForServerUrl(fixture.home.serverUrl, { serverId: scope.serverId })));
        const body = () => screen.root.find(node => node.props?.testID === 'session-work-memory.doc' && node.props.source).props;
        await waitForHomeGovernance(() => expect(hook.getCurrent().project.status).toBe('ready'));
        await waitForHomeGovernance(() => expect(body().source).toMatchObject({ status: 'ready', view: { artifactId: memory.id } }));
        expect(censusRequests).toBe(0);
        await React.act(async () => {
            for (let index = 0; index < 1000; index++) publishHomeAccountChange(scope.serverId, [`session-${index}`], {
                changeKinds: ['session'], feedPageConsumed: true,
            });
        });
        expect(censusRequests).toBe(0);
        expect(hook.getCurrent().project).toMatchObject({ status: 'ready', rows: [{ kind: 'memory', on: true }] });
        expect(body().source).toMatchObject({ status: 'ready', view: { artifactId: memory.id } });
        await React.act(async () => applyProjectAccountRowsFixture(storage, { ...projectRows, status: 'loading' }));
        expect(hook.getCurrent().project).toMatchObject({ status: 'ready', refreshing: true,
            rows: [{ entry: { id: 'project.memory' } }] });
        expect(body().source).toMatchObject({ view: { artifactId: memory.id }, target: null });
        expect(body().readOnly).toBe(true);
        expect(screen.findByTestId('session-work-memory.doc.loading')).toBeNull();
        expect(screen.findByTestId('session-work-context.entry.project.project.memory.enabled')?.props.disabled).toBe(true);
        await React.act(async () => applyProjectAccountRowsFixture(storage, { ...projectRows,
            organizations: projectRows.organizations.map(row => ({ ...row, revision: 1,
                value: { promptStack: row.value.promptStack?.map(entry => ({ ...entry, enabled: false })) } })) }));
        expect(hook.getCurrent().project).toMatchObject({ status: 'ready', refreshing: false,
            rows: [{ off: 'source', on: false }] });
        expect(body().source.target).not.toBeNull();
        await React.act(async () => applyProjectAccountRowsFixture(storage, { status: 'refused', coverage: 'unknown' }));
        expect(hook.getCurrent().project).toMatchObject({ status: 'unavailable', rows: [] });
        expect(body().source.view).toBeNull();
        expect(body().source.target).toBeNull();
        expect(screen.findByTestId('session-work-context.entry.project.project.memory')).toBeNull();
        expect(censusRequests).toBe(0);
    });

    it('refreshes only the relevant Source, retains readable context while pending, and withdraws revoked context', async () => {
        let censusRequests = 0;
        let sourceRequests = 0;
        let pendingRead: ReturnType<typeof createDeferred<Response>> | null = null;
        const source = ProjectSourceV1Schema.parse({ id: 'source', revision: 1, name: 'Project',
            repository: { provider: { id: 'happier.scm.forge.github/github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                repository: { nameWithOwner: 'acme/project' }, protocol: 'https' },
            audience: [], createdByAccountId: 'artifact-account', attachments: [{ purpose: 'context', entry: {
                id: 'source.notes', ref: { kind: 'doc', artifactId: 'source-notes' }, enabled: true, placement: 'system_append',
            } }] });
        fixture = await createPlainArtifactHomeFixture('https://work-source-continuity.example', {
            handleRequest: async path => {
                if (path === '/v1/account/project-rows/list') {
                    censusRequests += 1;
                    return Response.json(createPlainProjectAccountRowListFixture(storage.getState().projectAccountRows ?? {}));
                }
                if (path.startsWith('/v1/projects/sources/source?')) {
                    sourceRequests += 1;
                    return pendingRead ? pendingRead.promise : Response.json({ ok: true, source, canManage: false });
                }
                return null;
            },
        });
        const scope = { serverId: fixture.home.id, accountId: 'artifact-account' };
        storage.getState().applySettingsForScope(scope, settingsDefaults, 1);
        applyProjectAccountRowsFixture(storage, { workspaceRefs: [{ id: 'checkout', serverId: scope.serverId,
            machineId: 'machine', rootPath: '/repo', projectKey: 'project', createdAtMs: 1,
            source: { sourceId: source.id, revision: source.revision } }] });
        storage.getState().applyArtifacts([{ id: 'source-notes', title: 'Source notes',
            header: { v: 2, kind: 'prompt_doc.v2', title: 'Source notes' },
            ownerAccountId: scope.accountId, access: 'owner', isDecrypted: true, body: null,
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 }]);
        const hook = await renderHook(() => useSessionContextLayers({ serverId: scope.serverId, sessionId: 'work',
            ownerMetadata: { machineId: 'machine', path: '/repo' }, metadataVersion: 1 }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().project).toMatchObject({ status: 'ready',
            rows: [{ entry: { id: 'source.notes' }, kind: 'doc' }] }));
        const admittedRequests = sourceRequests;
        await React.act(async () => {
            publishHomeAccountChange(scope.serverId, ['other-session'], { changeKinds: ['session'] });
            publishHomeAccountChange(scope.serverId, undefined, { changeKinds: ['session'] });
            publishHomeAccountChange(scope.serverId, ['other-artifact'], { changeKinds: ['artifact'] });
        });
        expect(sourceRequests).toBe(admittedRequests);
        pendingRead = createDeferred<Response>();
        await React.act(async () => publishHomeAccountChange(scope.serverId, [PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1], { changeKinds: ['account'] }));
        await waitForHomeGovernance(() => expect(sourceRequests).toBe(admittedRequests + 1));
        expect(hook.getCurrent().project).toMatchObject({ status: 'ready', refreshing: true,
            rows: [{ entry: { id: 'source.notes' } }] });
        await React.act(async () => pendingRead?.resolve(Response.json({ ok: false, error: 'source_backend_unavailable' }, { status: 503 })));
        await waitForHomeGovernance(() => expect(hook.getCurrent().project).toMatchObject({ status: 'ready', refreshing: true,
            rows: [{ entry: { id: 'source.notes' }, title: 'Source notes', kind: 'doc' }] }));
        pendingRead = createDeferred<Response>();
        await React.act(async () => publishHomeAccountChange(scope.serverId, [PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1], { changeKinds: ['account'] }));
        await waitForHomeGovernance(() => expect(sourceRequests).toBe(admittedRequests + 2));
        await React.act(async () => pendingRead?.resolve(Response.json({ ok: true, canManage: false,
            source: { ...source, revision: 2, attachments: [] } })));
        await waitForHomeGovernance(() => expect(hook.getCurrent().project).toMatchObject({ status: 'ready', refreshing: false, rows: [] }));
        pendingRead = createDeferred<Response>();
        await React.act(async () => publishHomeAccountChange(scope.serverId, [PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1], { changeKinds: ['account'] }));
        await waitForHomeGovernance(() => expect(sourceRequests).toBe(admittedRequests + 3));
        await React.act(async () => pendingRead?.resolve(Response.json({ ok: false, error: 'source_access_denied' })));
        await waitForHomeGovernance(() => expect(hook.getCurrent().project).toMatchObject({ status: 'unavailable', rows: [] }));
        pendingRead = null;
        await React.act(async () => publishHomeAccountChange(scope.serverId, [PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1], { changeKinds: ['account'] }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().project.rows).toHaveLength(1));
        await React.act(async () => { retireActiveServerAccountScopeLifetime(); storage.setState({ profileScope: null }); });
        expect(hook.getCurrent().project.rows).toEqual([]);
        expect(censusRequests).toBe(0);
    });

    it('shares one Source observation across real Setup Context and Memory, retaining offline display without writes', async () => {
        let sourceRequests = 0;
        let pendingRead: ReturnType<typeof createDeferred<Response>> | null = null;
        const source = ProjectSourceV1Schema.parse({ id: 'source', revision: 1, name: 'Project',
            repository: { provider: { id: 'happier.scm.forge.github/github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                repository: { nameWithOwner: 'acme/project' }, protocol: 'https' },
            audience: [], createdByAccountId: 'artifact-account', attachments: [{ purpose: 'context', entry: {
                id: 'source.memory', ref: { kind: 'doc', artifactId: 'source-memory' }, enabled: true, placement: 'system_append',
            } }] });
        fixture = await createPlainArtifactHomeFixture('https://work-source-shared.example', {
            handleRequest: async path => {
                if (path.startsWith('/v1/projects/sources/source?')) {
                    sourceRequests++;
                    return pendingRead ? pendingRead.promise : Response.json({ ok: true, source, canManage: false });
                }
                return null;
            },
        });
        const scope = { serverId: fixture.home.id, accountId: 'artifact-account' };
        storage.getState().applySettingsForScope(scope, settingsDefaults, 1);
        replacePersistentUiStateForTest(sessionInfoDisclosuresState, { memory: true, context: true });
        applyProjectAccountRowsFixture(storage, { workspaceRefs: [{ id: 'checkout', serverId: scope.serverId,
            machineId: 'machine', rootPath: '/repo', projectKey: 'project', createdAtMs: 1,
            source: { sourceId: source.id, revision: source.revision } }] });
        const memory = { id: 'source-memory', title: 'Project memory',
            header: { v: 1, kind: 'memory_doc.v1', title: 'Project memory' },
            ownerAccountId: scope.accountId, access: 'owner' as const, isDecrypted: true as const,
            body: JSON.stringify({ v: 1, index: [{ id: 'fact', text: 'Keep the release notes current', createdAtMs: 1,
                sourceSessionRef: null }], topics: [] }),
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        fixture.boundary.replaceStoredRow(createPlainArtifactHttpFixture(memory, scope.accountId));
        storage.getState().applyArtifacts([memory]);
        const { SessionSetupSections } = await import('../SessionSetupSections');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const session = createSessionFixture({ id: 'shared-work', serverId: scope.serverId, metadataVersion: 1,
            metadata: { path: '/repo', host: 'localhost', machineId: 'machine', work: { memoryEnabled: true } } });
        function Setup() { return <SessionSetupSections session={session} serverId={scope.serverId} />; }
        const screen = await renderScreen(await createRealAppRouteElement(Setup,
            await TokenStorage.getCredentialsForServerUrl(fixture.home.serverUrl, { serverId: scope.serverId })));
        const body = () => screen.root.find(node => node.props?.testID === 'session-work-memory.doc' && node.props.source).props;
        const entry = () => screen.findByTestId('session-work-context.entry.project.source.memory');
        const readable = () => {
            expect(body().source).toMatchObject({ view: { artifactId: memory.id, title: memory.title,
                facts: [{ text: 'Keep the release notes current' }] } });
            expect(entry()).not.toBeNull();
        };
        try {
            await waitForHomeGovernance(readable);
            expect(sourceRequests).toBe(1);
            await React.act(async () => {
                for (let index = 0; index < 1000; index++) publishHomeAccountChange(scope.serverId, [`session-${index}`], { changeKinds: ['session'] });
                publishHomeAccountChange(scope.serverId, ['unrelated'], { changeKinds: ['artifact'] });
            });
            expect(sourceRequests).toBe(1);
            pendingRead = createDeferred<Response>();
            await React.act(async () => publishHomeAccountChange(scope.serverId, [PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1], { changeKinds: ['account'] }));
            await waitForHomeGovernance(() => expect(sourceRequests).toBe(2));
            readable();
            expect(body().source.target).toBeNull();
            expect(body().readOnly).toBe(true);
            expect(screen.findByTestId('session-work-context.entry.project.source.memory.enabled')?.props.disabled).toBe(true);
            await React.act(async () => pendingRead?.resolve(Response.json({ ok: false, error: 'source_backend_unavailable' }, { status: 503 })));
            await waitForHomeGovernance(readable);
            expect(body().source.target).toBeNull();
            pendingRead = null;
            await React.act(async () => publishHomeAccountChange(scope.serverId, [PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1], { changeKinds: ['account'] }));
            await waitForHomeGovernance(() => expect(body().source.target).not.toBeNull());
            expect(sourceRequests).toBe(3);
            pendingRead = createDeferred<Response>();
            await React.act(async () => publishHomeAccountChange(scope.serverId, [PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1], { changeKinds: ['account'] }));
            await waitForHomeGovernance(() => expect(sourceRequests).toBe(4));
            await React.act(async () => pendingRead?.resolve(Response.json({ ok: false, error: 'source_access_denied' })));
            await waitForHomeGovernance(() => expect(entry()).toBeNull());
            expect(body().source.view).toBeNull();
            pendingRead = null;
            await React.act(async () => publishHomeAccountChange(scope.serverId, [PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1], { changeKinds: ['account'] }));
            await waitForHomeGovernance(readable);
            expect(sourceRequests).toBe(5);
            await React.act(async () => { retireActiveServerAccountScopeLifetime(); storage.setState({ profileScope: null }); });
            expect(entry()).toBeNull();
            expect(body().source.view).toBeNull();
            expect(body().source.target).toBeNull();
        } finally { pendingRead?.resolve(Response.json({ ok: false, error: 'source_access_denied' })); }
    });

    it.each(['path', 'unregistered', 'unknown'] as const)('uses admitted Project association for Work Context and Memory (%s)', async association => {
        let projectRows: Pick<ProjectAccountRowsSnapshot, 'workspaceRefs' | 'organizations'> = { workspaceRefs: [], organizations: [] };
        fixture = await createPlainArtifactHomeFixture(`https://work-project-${association}.example`, {
            handleRequest: async path => path === '/v1/account/project-rows/list'
                ? new Response(JSON.stringify(createPlainProjectAccountRowListFixture(projectRows)), { status: 200 }) : null,
        });
        const scope = { serverId: fixture.home.id, accountId: 'artifact-account' };
        storage.getState().applySettingsForScope(scope, settingsDefaults, 1);
        projectRows = {
            workspaceRefs: [{ id: 'checkout', serverId: scope.serverId, machineId: 'machine', rootPath: '/repo',
                projectKey: 'project', createdAtMs: 1 }],
            organizations: [{ key: { kind: 'project-organization', serverId: scope.serverId, projectKey: 'project' }, revision: 0,
                value: { promptStack: [{ id: 'project.memory', ref: { kind: 'doc', artifactId: 'project-memory' },
                    enabled: true, placement: 'system_append' }] } }],
        };
        applyProjectAccountRowsFixture(storage, { ...projectRows, coverage: association === 'unknown' ? 'partial' : 'complete' });
        storage.getState().applyArtifacts([{ id: 'project-memory', title: 'Project memory',
            header: { v: 1, kind: 'memory_doc.v1', title: 'Project memory' },
            ownerAccountId: scope.accountId, access: 'owner', isDecrypted: true, body: null,
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 }]);
        const hook = await renderHook(() => useSessionContextLayers({ serverId: scope.serverId, sessionId: 'work',
            ownerMetadata: { machineId: 'machine', path: association === 'unregistered' ? '/unregistered' : '/repo',
                work: { memoryEnabled: true } }, metadataVersion: 1 }));
        if (association === 'unregistered') {
            expect(hook.getCurrent().project).toMatchObject({ status: 'none', rows: [] });
        } else if (association === 'unknown') {
            expect(hook.getCurrent().project.status).not.toBe('none');
            expect(hook.getCurrent().project.status).not.toBe('ready');
        } else {
            expect(hook.getCurrent().project.status).not.toBe('none');
            await waitForHomeGovernance(() => expect(hook.getCurrent().project).toMatchObject({ status: 'ready', rows: [{
                layer: 'project', kind: 'memory', on: true,
                entry: { id: 'project.memory', ref: { kind: 'doc', artifactId: 'project-memory', serverId: scope.serverId } },
            }] }));
        }
    });
    it('keeps an own disabled Plan re-enableable while inherited source-disabled context stays locked', async () => {
        fixture = await createPlainArtifactHomeFixture('https://work-context-plan.example');
        const scope = { serverId: fixture.home.id, accountId: 'artifact-account' };
        storage.getState().applySettingsForScope(scope, settingsDefaults, 1);
        applyProfileCatalogSnapshot(scope, { ...ready, records: [{ revision: 1, record: {
            v: 1, id: 'azure-openai', definition: { kind: 'legacy', profile: AIBackendProfileSchema.parse(getBuiltInBackendProfile('azure-openai')) },
            enabled: true, promptStack: [{ id: 'profile-plan', ref: { kind: 'doc', artifactId: 'plan-doc' },
                enabled: false, placement: 'system_append' }], skillSeeds: [], secretBindings: {},
        } }] }, true);
        storage.getState().applyArtifacts([{ id: 'plan-doc', title: 'Plan',
            header: { v: 1, kind: 'prompt_doc.v2', title: 'Plan' },
            ownerAccountId: scope.accountId, access: 'owner', isDecrypted: true, body: null,
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 }]);
        const hook = await renderHook((enabled: boolean) => useSessionContextLayers({ serverId: scope.serverId,
            sessionId: 'work', ownerMetadata: { profileId: 'azure-openai', work: { promptStack: [{ id: 'plan', plan: true,
                ref: { kind: 'doc', artifactId: 'plan-doc' }, enabled, placement: 'system_append' }] } }, metadataVersion: 1 }), { initialProps: false });
        expect(hook.getCurrent().sessionStackValid).toBe(true);
        expect(hook.getCurrent().session[0]?.entry.plan).toBe(true);
        expect(hook.getCurrent().session[0]).toMatchObject({ off: 'session', on: false });
        expect(hook.getCurrent().profile.rows[0]).toMatchObject({ off: 'source', on: false });
        await hook.rerender(true);
        expect(hook.getCurrent().session[0]).toMatchObject({ off: null, on: true });
        expect(hook.getCurrent().profile.rows[0]).toMatchObject({ off: 'source', on: false });
    });
    it('projects only prompt-preparation placements while preserving a historical generic bundle', async () => {
        fixture = await createPlainArtifactHomeFixture('https://work-context-placements.example');
        const scope = { serverId: fixture.home.id, accountId: 'artifact-account' };
        storage.getState().applySettingsForScope(scope, settingsDefaults, 1);
        const entries = ['system_append', 'skill_instructions', 'provider_asset', 'composer_insert'].map(placement => ({
            id: placement, ref: { kind: 'bundle', artifactId: 'generic' }, enabled: true, placement,
        }));
        storage.getState().applyArtifacts([{ id: 'generic', title: 'Retained bundle',
            header: { v: 1, kind: 'prompt_bundle.v2', title: 'Retained bundle', bundleSchemaId: 'bundle.generic_v1' },
            ownerAccountId: scope.accountId, access: 'owner', isDecrypted: true, body: null,
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 }]);
        const hook = await renderHook(() => useSessionContextLayers({ serverId: scope.serverId,
            sessionId: 'work', ownerMetadata: { work: { promptStack: entries } }, metadataVersion: 1 }));
        expect(hook.getCurrent().sessionStackValid).toBe(true);
        expect(hook.getCurrent().session.map(row => row.entry.id)).toEqual(['system_append', 'skill_instructions']);
    });
    it('admits legitimate rowless built-ins while refusing unknown, disabled and incomplete selections', async () => {
        fixture = await createPlainArtifactHomeFixture('https://work-profile-admission.example');
        const scope = { serverId: fixture.home.id, accountId: 'artifact-account' };
        storage.getState().applySettingsForScope(scope, { ...settingsDefaults, favoriteProfiles: ['azure-openai'] }, 1);
        applyProfileCatalogSnapshot(scope, ready, true);
        const hook = await renderHook((profileId: string) => useSessionContextLayers({
            serverId: scope.serverId, sessionId: 'work', ownerMetadata: { profileId }, metadataVersion: 1,
        }), { initialProps: 'azure-openai' });
        expect(hook.getCurrent().profile).toMatchObject({ status: 'ready', name: 'Azure OpenAI', rows: [] });
        await hook.rerender('unknown-profile');
        expect(hook.getCurrent().profile.status).toBe('unavailable');
        await hook.rerender('azure-openai');
        await React.act(async () => {
            storage.getState().applySettingsForScope(scope, { ...settingsDefaults, favoriteProfiles: ['azure-openai'],
                profileEnabledById: { 'azure-openai': false } }, 2);
        });
        expect(hook.getCurrent().profile.status).toBe('unavailable');
        await React.act(async () => {
            storage.getState().applySettingsForScope(scope, { ...settingsDefaults, profileEnabledById: { 'azure-openai': true } }, 3);
        });
        expect(hook.getCurrent().profile.status).toBe('ready');
        await React.act(async () => {
            if (ready.status !== 'ready') throw new Error('Expected ready fixture');
            applyProfileCatalogSnapshot(scope, { ...ready, status: 'partial', diagnostics: [{ id: 'opaque', revision: 1,
                reason: 'invalid-stored-content' }] }, true);
        });
        expect(hook.getCurrent().profile.status).toBe('unavailable');
    });

    it('uses the addressed Home evidence and lets a real disabled row shadow its retained builtin', async () => {
        fixture = await createPlainArtifactHomeFixture('https://work-profile-addressed.example');
        const scope = { serverId: fixture.home.id, accountId: 'artifact-account' };
        const addressed = { serverId: 'profile-other-home', accountId: 'profile-other-account' };
        storage.getState().applySettingsForScope(scope, { ...settingsDefaults, favoriteProfiles: ['azure-openai'],
            profileEnabledById: { 'gemini-api-key': false } }, 1);
        saveAccountSettings(addressed, { ...settingsDefaults, profileEnabledById: { 'gemini-api-key': true } }, 1);
        saveAuthoringMemoryProjection(addressed, { lastUsedProfile: 'azure-openai', recentMachinePaths: [], lastEngineSelectionsByScopeV1: {} });
        applyProfileCatalogSnapshot(addressed, ready, true);
        const hook = await renderHook(() => ({
            remembered: useHomeAiLaunchProfileCatalog(addressed, 'azure-openai'),
            enabled: useHomeAiLaunchProfileCatalog(addressed, 'gemini-api-key'),
        }));
        expect(hook.getCurrent().remembered.selectedProfile).toMatchObject({ id: 'azure-openai' });
        expect(hook.getCurrent().enabled.selectedProfile).toMatchObject({ id: 'gemini-api-key' });
        expect(hook.getCurrent().remembered.profiles).toEqual([]);
        await React.act(async () => {
            if (ready.status !== 'ready') throw new Error('Expected ready fixture');
            applyProfileCatalogSnapshot(addressed, { ...ready, records: [{ revision: 1, record: {
                v: 1, id: 'azure-openai', definition: { kind: 'legacy', profile: AIBackendProfileSchema.parse(getBuiltInBackendProfile('azure-openai')) },
                enabled: false, promptStack: [], skillSeeds: [], secretBindings: {},
            } }] }, true);
        });
        expect(hook.getCurrent().remembered.selectedProfile).toBeNull();
        expect(hook.getCurrent().remembered.profiles).toMatchObject([{ id: 'azure-openai', enabled: false }]);
    });
});
