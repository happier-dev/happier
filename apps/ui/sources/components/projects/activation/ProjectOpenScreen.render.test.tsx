import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { installFileFindAccountBoundaryMocks } from '@/components/appShell/panes/fileFindSeedTestHelpers';
import { installUiListsCommonModuleMocks } from '@/components/ui/lists/uiListsTestHelpers';
import { t } from '@/text';
import { formatResetAtTime } from '@/utils/time/formatResetAtTime';
import type { SessionDraftRecordV2 } from '@happier-dev/protocol/drafts/sessionDraftsV2';
import type { SessionDraftRepositoryTransport } from '@/sync/ops/sessionDrafts/sessionDraftRepository';

installFileFindAccountBoundaryMocks('home', 'account');
installUiListsCommonModuleMocks();

const projectOpenAccountActionBoundary = vi.hoisted(() => ({
    capture: false,
    calls: [] as unknown[],
    opened: null as null | import('@happier-dev/protocol/projects/openProjectV1').OpenProjectResultV1,
}));
let projectOpenDraftServerRow: SessionDraftRecordV2 | null = null;

// Home Action HTTP is the finite-placement process boundary. Keep the real draft, controller and default Action executor.
vi.mock('@/sync/api/externalActionAccountTransport', async (importOriginal) => {
    const real = await importOriginal<typeof import('@/sync/api/externalActionAccountTransport')>();
    return { ...real, executeOriginalAccountMachineAction: async (params: unknown) => {
        if (!projectOpenAccountActionBoundary.capture) return real.executeOriginalAccountMachineAction(params as never);
        projectOpenAccountActionBoundary.calls.push(params);
        return { ok: true, result: projectOpenAccountActionBoundary.opened ?? { kind: 'refused', code: 'FEATURE_UNSUPPORTED' } };
    } };
});

// Device persistence is a system boundary; retain the real draft repository.
vi.mock('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage', () => {
    const values = new Map<string, string>();
    return { getSessionDraftPersistenceStorage: () => ({
        getString: (key: string) => values.get(key),
        getAllKeys: () => [...values.keys()],
        set: (key: string, value: string) => { values.set(key, value); },
        delete: (key: string) => { values.delete(key); },
    }) };
});

const routerSpies = vi.hoisted(() => ({ navigation: [] as unknown[], back: undefined as undefined | { mockClear(): void; mock: { calls: unknown[][] } } }));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const mock = createExpoRouterMock({ params: { draftId: '00000000-0000-4000-8000-000000000081', serverId: 'home' },
        router: { push: value => { routerSpies.navigation.push(value); } } });
    routerSpies.back = mock.spies.back;
    return mock.module;
});

// Collect the real screen outside the test timer; cold module loading is not an Open operation.
const { ProjectOpenScreen } = await import('./ProjectOpenScreen');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');

beforeEach(() => {
    installFileFindAccountBoundaryMocks('home', 'account');
    projectOpenDraftServerRow = null;
    projectOpenAccountActionBoundary.capture = false;
    projectOpenAccountActionBoundary.calls = [];
    projectOpenAccountActionBoundary.opened = null;
    routerSpies.navigation = [];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })));
});
afterEach(() => { standardCleanup(); vi.unstubAllGlobals(); });

/** A signed-in Home with one online Machine and a retained Open draft for one Source. */
async function seedOpenDraft(draftId: string, scope = { serverId: 'home', accountId: 'account' },
    transport: Partial<SessionDraftRepositoryTransport> = {}, machinePlatform?: string) {
    const { storage } = await import('@/sync/domains/state/storage');
    const { configureSessionDraftRepository, resetSessionDraftRepositoryForTests, writeProjectOpenDraft, getSessionDraftSnapshot } =
        await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
    resetSessionDraftRepositoryForTests();
    const { createSessionDraftCipher } = await import('@/sync/encryption/sessionDraftEncryption');
    configureSessionDraftRepository({ scope, syncEnabled: true,
        cipher: createSessionDraftCipher({ accountMode: 'plain', accountCryptoMaterial: null,
            getSessionContext: () => { throw new Error('Open has no Session'); }, randomBytes: size => new Uint8Array(size) }),
        transport: {
            read: async () => projectOpenDraftServerRow
                ? { status: projectOpenDraftServerRow.content ? 'present' : 'deleted', record: projectOpenDraftServerRow }
                : { status: 'absent' },
            list: async () => ({ items: projectOpenDraftServerRow ? [projectOpenDraftServerRow] : [] }),
            mutate: async request => {
                if (request.expectedRevision !== (projectOpenDraftServerRow?.revision ?? 'absent')) {
                    return { status: 'conflict', current: projectOpenDraftServerRow ?? { status: 'absent' } };
                }
                projectOpenDraftServerRow = { address: request.address, revision: (projectOpenDraftServerRow?.revision ?? -1) + 1,
                    content: request.content, createdAt: 1, updatedAt: 2 };
                return { status: 'updated', record: projectOpenDraftServerRow };
            },
            ...transport,
        } });
    const fixture = createMachineFixture({ id: 'machine', activeAt: Date.now() });
    const machine = machinePlatform ? { ...fixture, metadata: { ...fixture.metadata!, platform: machinePlatform } } : fixture;
    storage.setState({ profileScope: scope, machines: { [machine.id]: machine }, machineListByServerId: { [scope.serverId]: [machine] },
        machineListStatusByServerId: { [scope.serverId]: 'idle' } });
    storage.getState().activateProjectAccountRowsScope(scope);
    storage.getState().applyProjectAccountRowsForScope(scope, { scope, status: 'ready', coverage: 'complete',
        workspaceRefs: [], relationships: [], organizations: [], revisionsByPhysicalKey: {} });
    writeProjectOpenDraft({ scope, draftId, patch: { selection: { serverId: scope.serverId, source: { kind: 'source', id: 'source', revision: 1,
        defaultRef: 'main',
        selector: { provider: { id: 'forge', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
            repository: { nameWithOwner: 'octocat/Hello-World', cloneUrl: 'https://github.com/octocat/Hello-World' }, protocol: 'https' } } } } });
    return { machine, read: () => {
        const document = getSessionDraftSnapshot(scope, { kind: 'projectOpen', draftId })?.document;
        if (!document || !('selection' in document)) throw new Error('Expected the Project Open draft');
        return document;
    } };
}

describe('Project Open rendered choices', () => {
    it('keeps the selected and menu Machine glyph aligned with local identity and platform', async () => {
        const draftId = '00000000-0000-4000-8000-000000000081';
        const { machine } = await seedOpenDraft(draftId, undefined, undefined, 'linux');
        const { getSystemTasksRunner } = await import('@/components/systemTasks/systemTasksRuntime');
        const { publishLocalDaemonStatus } = await import('@/components/settings/machines/localControl/localDaemonSharedState');
        const { Icon } = await import('@/components/ui/icons/Icon');
        const runner = getSystemTasksRunner();
        publishLocalDaemonStatus(runner, { machineId: null });
        const screen = await renderScreen(<ProjectOpenScreen routeParams={{ draftId, serverId: 'home' }} />);
        await vi.waitFor(() => expect(screen.findByTestId('projects.open.where.row')).not.toBeNull());
        await act(async () => screen.findAll(node => node.type === DropdownMenu && node.props.testID === 'projects.open.where')[0]!.props.onSelect(machine.id));
        const glyphs = () => {
            const row = screen.findByTestId('projects.open.where.row')!;
            const menu = screen.findAll(node => node.type === DropdownMenu && node.props.testID === 'projects.open.where')[0]!;
            return [row.findAll(node => node.type === Icon)[0]?.props.name,
                menu.props.items.find((item: { id: string }) => item.id === machine.id).icon.props.name];
        };
        expect(glyphs()).toEqual(['hard-drives', 'hard-drives']);
        await act(async () => publishLocalDaemonStatus(runner, { machineId: machine.id }));
        expect(glyphs()).toEqual(['laptop', 'laptop']);
        await act(async () => publishLocalDaemonStatus(runner, { machineId: null }));
    });

    it('names a workspace folder by the workspace, not its controller, and offers no other Machine', async () => {
        const draftId = '00000000-0000-4000-8000-000000000081';
        const scope = { serverId: 'home', accountId: 'account' };
        await seedOpenDraft(draftId, scope, undefined, 'linux');
        const { writeProjectOpenDraft } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        writeProjectOpenDraft({ scope, draftId, patch: { selection: { serverId: 'home', machineId: 'machine',
            source: { kind: 'folder', path: '/home/coder/repo' },
            materialization: { kind: 'attach', targetManaged: { managedId: 'guest', controller: { machineId: 'machine', installationId: 'install' } } } } } });
        const screen = await renderScreen(<ProjectOpenScreen routeParams={{ draftId, serverId: 'home' }} />);
        await vi.waitFor(() => expect(screen.findByTestId('projects.open.where.row')).not.toBeNull());
        expect(screen.findByTestId('projects.open.where.change')).toBeNull();
        expect(screen.findAll(node => node.type === DropdownMenu && node.props.testID === 'projects.open.where')).toHaveLength(0);
    });

    it.each(['source', 'another-source'])('carries an attached dashboard only after accepting its Source (%s)', async acceptedSourceId => {
        const draftId = acceptedSourceId === 'source' ? '00000000-0000-4000-8000-000000000083' : '00000000-0000-4000-8000-000000000084';
        const { createHomeGovernanceHarness, installHomeGovernanceBoundaries } = await import('@/dev/testkit/harness/homeGovernanceHarness');
        const home = createHomeGovernanceHarness();
        installHomeGovernanceBoundaries(home);
        onTestFinished(() => home.reset());
        const serverId = await home.addHome({ name: 'Project Open', serverUrl: 'https://home.test',
            serverIdentityId: 'srv_project_open_dashboard', accountId: 'account', currentAccount: true });
        installFileFindAccountBoundaryMocks(serverId, 'account');
        const scope = { serverId, accountId: 'account' };
        const seeded = await seedOpenDraft(draftId, scope);
        const { storage } = await import('@/sync/domains/state/storage');
        const { writeProjectOpenDraft } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        const source = seeded.read().selection.value!.source!;
        if (source.kind !== 'source') throw new Error('Expected Source');
        const checkout = { id: 'existing', serverId, machineId: 'machine', rootPath: '/Users/tester/Hello-World',
            createdAtMs: 1, projectKey: 'private-project', repositoryIdentity: { kind: 'github' as const,
                deployment: source.selector.provider.baseUrl, repository: source.selector.repository.nameWithOwner } };
        storage.getState().applyProjectAccountRowsForScope(scope, { scope, status: 'ready', coverage: 'complete',
            workspaceRefs: [checkout], relationships: [], organizations: [], revisionsByPhysicalKey: {} });
        writeProjectOpenDraft({ scope, draftId, patch: { selection: { serverId, machineId: 'machine', source: { ...source, id: acceptedSourceId } } } });
        const { createPlainProjectAccountRowListFixture } = await import('@/dev/testkit/fixtures/projectAccountRows');
        const { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } = await import('@happier-dev/protocol/projects/projectAccountRowsV1');
        home.answer(serverId, `POST ${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`, { body: createPlainProjectAccountRowListFixture({
            workspaceRefs: [{ ...checkout, source: { sourceId: acceptedSourceId, revision: 1 } }],
        }) });
        projectOpenAccountActionBoundary.capture = true;
        projectOpenAccountActionBoundary.opened = { kind: 'opened', setup: 'notRequired', directory: checkout.rootPath,
            workspace: { serverId, machineId: 'machine', workspaceId: checkout.id, rootPath: checkout.rootPath },
            facts: { projectKey: checkout.projectKey, source: { sourceId: acceptedSourceId, revision: 1 } } };
        const screen = await renderScreen(<ProjectOpenScreen routeParams={{ draftId, serverId,
            dashboardSourceId: 'source', dashboardArtifactId: 'shared-dashboard', dashboardServerId: 'foreign-home' }} />);
        await vi.waitFor(() => expect(screen.findByTestId('projects.open.submit')?.props.disabled).toBe(false));
        expect(projectOpenAccountActionBoundary.calls).toEqual([]);
        expect(routerSpies.navigation).toEqual([]);
        expect(seeded.read().selection.value).toMatchObject({ source: { id: acceptedSourceId } });
        await screen.pressByTestIdAsync('projects.open.submit');
        await vi.waitFor(() => expect(routerSpies.navigation).toHaveLength(1));
        expect(projectOpenAccountActionBoundary.calls).toHaveLength(1);
        expect(projectOpenAccountActionBoundary.calls[0]).toMatchObject({ actionId: 'projects.open', input: {
            source: { kind: 'source', id: acceptedSourceId, checkout: { workspaceId: 'existing', rootPath: checkout.rootPath } },
            materialization: { kind: 'attach' },
        } });
        const url = new URL(String(routerSpies.navigation[0]), 'https://happier.test');
        expect(url.pathname).toBe('/projects/existing/overview');
        if (acceptedSourceId === 'source') expect(Object.fromEntries(url.searchParams)).toMatchObject({
            dashboardSourceId: 'source', dashboardArtifactId: 'shared-dashboard', dashboardServerId: 'foreign-home',
        });
        else expect(url.searchParams.has('dashboardArtifactId')).toBe(false);
    });

    it.each(['focus', 'select'] as const)('accepts a folder with %s completion, leaving the Projects-list write to the host Open', async completion => {
        const draftId = completion === 'focus' ? '00000000-0000-4000-8000-000000000085' : '00000000-0000-4000-8000-000000000086';
        const { createHomeGovernanceHarness, installHomeGovernanceBoundaries } = await import('@/dev/testkit/harness/homeGovernanceHarness');
        const home = createHomeGovernanceHarness();
        installHomeGovernanceBoundaries(home);
        onTestFinished(() => home.reset());
        const serverId = await home.addHome({ name: 'Project Open', serverUrl: 'https://home.test',
            serverIdentityId: 'srv_project_open_add', accountId: 'account', currentAccount: true });
        installFileFindAccountBoundaryMocks(serverId, 'account');
        const scope = { serverId, accountId: 'account' };
        await seedOpenDraft(draftId, scope);
        const { writeProjectOpenDraft } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        writeProjectOpenDraft({ scope, draftId, patch: { selection: { serverId, machineId: 'machine',
            source: { kind: 'folder', path: '/Users/tester/fixture' }, materialization: { kind: 'attach' } } } });
        const checkout = { id: 'fixture-ref', serverId, machineId: 'machine', rootPath: '/Users/tester/fixture', createdAtMs: 1, projectKey: 'fixture-ref' };
        const { createPlainProjectAccountRowListFixture } = await import('@/dev/testkit/fixtures/projectAccountRows');
        const { PROJECT_ACCOUNT_ROWS_ROUTE_V1, ProjectAccountRowMutationRequestV1Schema } = await import('@happier-dev/protocol/projects/projectAccountRowsV1');
        home.answer(serverId, `POST ${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`, { body: createPlainProjectAccountRowListFixture({ workspaceRefs: [checkout] }) });
        const written: unknown[] = [];
        home.answer(serverId, `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/mutate`, { select: async (_input, request) => {
            const mutation = ProjectAccountRowMutationRequestV1Schema.parse(JSON.parse(String(request.init?.body)));
            written.push(...mutation.mutations.map(change => ({ key: change.key, expectedRevision: change.expectedRevision,
                value: change.content && 'v' in change.content ? (change.content.v as { value: unknown }).value : change.content })));
            return { status: 200, body: { status: 'updated', cursor: 1,
                rows: mutation.mutations.map(change => ({ key: change.key, revision: 0, content: change.content })) } };
        } });
        projectOpenAccountActionBoundary.capture = true;
        projectOpenAccountActionBoundary.opened = { kind: 'opened', setup: 'notRequired', directory: checkout.rootPath,
            workspace: { serverId, machineId: 'machine', workspaceId: checkout.id, rootPath: checkout.rootPath },
            facts: { projectKey: checkout.projectKey } };
        const selected = vi.fn();
        const screen = await renderScreen(<ProjectOpenScreen routeParams={{ draftId, serverId }}
            onSelected={completion === 'select' ? selected : undefined} />);
        await vi.waitFor(() => expect(screen.findByTestId('projects.open.submit')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('projects.open.submit');
        await vi.waitFor(() => expect(projectOpenAccountActionBoundary.calls).toHaveLength(1));
        if (completion === 'select') {
            await vi.waitFor(() => expect(selected).toHaveBeenCalledWith(projectOpenAccountActionBoundary.opened));
            expect(routerSpies.navigation).toEqual([]);
            expect(written).toEqual([]);
            return;
        }
        await vi.waitFor(() => expect(routerSpies.navigation).not.toEqual([]));
        // The accepting host Open records the listing for every caller; this client adds no second writer.
        expect(written).toEqual([]);
    });

    it('settles the own-Source chooser from its exact draft while Account draft hydration is held', async () => {
        const draftId = '00000000-0000-4000-8000-000000000081';
        const scope = { serverId: 'home', accountId: 'account' };
        let release!: (value: { items: SessionDraftRecordV2[] }) => void;
        const heldList = new Promise<{ items: SessionDraftRecordV2[] }>(resolve => { release = resolve; });
        let listReads = 0;
        const exactReads: unknown[] = [];
        const seeded = await seedOpenDraft(draftId, scope, {
            list: () => { listReads += 1; return heldList; },
            read: async address => { exactReads.push(address); return { status: 'absent' }; },
        });
        const { ensureSessionDraftRepositoryHydrated } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        const backgroundHydration = ensureSessionDraftRepositoryHydrated(scope);
        onTestFinished(async () => { release({ items: [] }); await backgroundHydration; });
        const before = seeded.read().selection.value;
        const screen = await renderScreen(<ProjectOpenScreen />);
        await vi.waitFor(() => expect(screen.findByTestId('projects.open.choices')).toBeTruthy());
        expect(screen.findByTestId('projects.open.resolving')).toBeFalsy();
        expect(seeded.read().selection.value).toEqual(before);
        expect(exactReads).toEqual([{ kind: 'projectOpen', draftId }]);
        expect(listReads).toBe(1);
    });

    it('keeps the chooser resolving until a newly selected draft read settles', async () => {
        const draftId = '00000000-0000-4000-8000-000000000081';
        const nextDraftId = '00000000-0000-4000-8000-000000000082';
        const scope = { serverId: 'home', accountId: 'account' };
        let release!: () => void;
        const heldRead = new Promise<void>(resolve => { release = resolve; });
        const exactReads: unknown[] = [];
        await seedOpenDraft(draftId, scope, {
            read: async address => {
                exactReads.push(address);
                if (address.kind === 'projectOpen' && address.draftId === nextDraftId) {
                    await heldRead;
                    return { status: 'absent' };
                }
                return projectOpenDraftServerRow
                    ? { status: projectOpenDraftServerRow.content ? 'present' : 'deleted', record: projectOpenDraftServerRow }
                    : { status: 'absent' };
            },
        });
        onTestFinished(() => { release(); });
        const { flushProjectOpenDraftForAdmission, getSessionDraftSnapshot } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        await flushProjectOpenDraftForAdmission({ scope, draftId });
        const screen = await renderScreen(<ProjectOpenScreen />);
        await vi.waitFor(() => expect(screen.findByTestId('projects.open.choices')).toBeTruthy());
        await act(async () => { screen.update(<ProjectOpenScreen routeParams={{ draftId: nextDraftId, serverId: 'home' }} />); });
        await vi.waitFor(() => expect(exactReads).toEqual([{ kind: 'projectOpen', draftId }, { kind: 'projectOpen', draftId: nextDraftId }]));
        expect(screen.findByTestId('projects.open.resolving')).toBeTruthy();
        expect(screen.findByTestId('projects.open.choices')).toBeFalsy();
        await act(async () => { release(); });
        await vi.waitFor(() => expect(screen.findByTestId('projects.open.choices')).toBeTruthy());
        const { AttentionBanner } = await import('@/components/ui/lists/AttentionBanner');
        expect(screen.findAllByType(AttentionBanner).find(node => node.props.testID === 'projects.open.failed')?.props.details)
            .toContain('project_open_draft_unavailable');
        expect(getSessionDraftSnapshot(scope, { kind: 'projectOpen', draftId: nextDraftId })).toBeNull();
    });

    it.each(['provenance', 'retained', 'repository'] as const)('enables Open for the sole existing Source checkout without writing on mount (%s)', async kind => {
        const draftId = '00000000-0000-4000-8000-000000000081';
        const seeded = await seedOpenDraft(draftId);
        const { storage } = await import('@/sync/domains/state/storage');
        const { writeProjectOpenDraft } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        const scope = { serverId: 'home', accountId: 'account' };
        const source = seeded.read().selection.value!.source!;
        if (source.kind !== 'source') throw new Error('Expected Source');
        storage.getState().applyProjectAccountRowsForScope(scope, { scope, status: 'ready', coverage: 'complete',
            workspaceRefs: [{ id: 'existing', serverId: scope.serverId, machineId: seeded.machine.id,
                rootPath: '/Users/tester/Hello-World', createdAtMs: 1,
                ...(kind === 'repository' ? { repositoryIdentity: { kind: 'github' as const,
                    deployment: source.selector.provider.baseUrl, repository: source.selector.repository.nameWithOwner } }
                    : { source: { sourceId: source.id, revision: source.revision } }) }],
            relationships: [], organizations: [], revisionsByPhysicalKey: {} });
        writeProjectOpenDraft({ scope, draftId, patch: { selection: { serverId: scope.serverId, machineId: seeded.machine.id,
            source, ...(kind === 'retained' ? { materialization: { kind: 'attach' } } : {}) } } });
        const before = seeded.read().selection.value;
        const screen = await renderScreen(<ProjectOpenScreen />);
        await vi.waitFor(() => expect(screen.findByTestId('projects.open.submit')).toBeTruthy());
        expect(screen.findByTestId('projects.open.submit')!.props.disabled).toBe(false);
        expect(screen.findByTestId('projects.open.use.existing')).toBeTruthy();
        expect(seeded.read().selection.value).toEqual(before);
    });

    it('keeps same-name Machines distinguishable and retains the selected id when reopened after presence changes', async () => {
        const draftId = '00000000-0000-4000-8000-000000000081';
        const seeded = await seedOpenDraft(draftId);
        const { storage } = await import('@/sync/domains/state/storage');
        const { Item } = await import('@/components/ui/lists/Item');
        const first = { ...seeded.machine, id: 'd4ac-machine' };
        const second = { ...seeded.machine, id: 'f874-machine', activeAt: first.activeAt - 1 };
        storage.setState({ machines: { [first.id]: first, [second.id]: second }, machineListByServerId: { home: [first, second] } });
        const screen = await renderScreen(<ProjectOpenScreen />);
        const where = () => screen.findAllByType(DropdownMenu).find(node => node.props.testID === 'projects.open.where');
        await vi.waitFor(() => expect(where()).toBeDefined());
        expect(where()!.props.items.map((item: { id: string; title: string }) => ({ id: item.id, title: item.title })))
            .toEqual([{ id: first.id, title: 'tester.local · d4ac' }, { id: second.id, title: 'tester.local · f874' }]);
        await act(async () => { where()!.props.onSelect(first.id); });
        expect(seeded.read().selection.value?.machineId).toBe(first.id);
        await act(async () => { screen.unmount(); });
        const changedSecond = { ...second, activeAt: first.activeAt + 1, updatedAt: first.updatedAt + 1 };
        storage.setState({ machines: { [first.id]: first, [second.id]: changedSecond }, machineListByServerId: { home: [changedSecond, first] } });
        const reopened = await renderScreen(<ProjectOpenScreen />);
        const reopenedWhere = () => reopened.findAllByType(DropdownMenu).find(node => node.props.testID === 'projects.open.where');
        await vi.waitFor(() => expect(reopenedWhere()).toBeDefined());
        expect(reopenedWhere()!.props.selectedId).toBe(first.id);
        expect(reopenedWhere()!.props.items.filter((item: { checked: boolean }) => item.checked).map((item: { id: string }) => item.id))
            .toEqual([first.id]);
        expect(reopened.findAllByType(Item).find(node => node.props.testID === 'projects.open.where.row')!.props.title)
            .toBe('tester.local · d4ac');
        expect(seeded.read().selection.value?.machineId).toBe(first.id);
    });

    it('edits Source subdirectory and Sync policy without replacing a retained link or saved Source defaults', async () => {
        const draftId = '00000000-0000-4000-8000-000000000081';
        const seeded = await seedOpenDraft(draftId);
        const { storage } = await import('@/sync/domains/state/storage');
        const { writeProjectOpenDraft } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        const { buildWorkspaceContentPolicy } = await import('@/sync/domains/sessionHandoff/sessionHandoffDefaults');
        const scope = { serverId: 'home', accountId: 'account' };
        const source = seeded.read().selection.value!.source!;
        if (source.kind !== 'source') throw new Error('Expected Source');
        const checkout = { serverId: 'home', machineId: 'source-machine', workspaceId: 'source-checkout', rootPath: '/source' };
        storage.getState().activateProjectAccountRowsScope(scope);
        storage.getState().applyProjectAccountRowsForScope(scope, { scope, status: 'ready', coverage: 'complete',
            workspaceRefs: [{ id: checkout.workspaceId, serverId: checkout.serverId, machineId: checkout.machineId,
                rootPath: checkout.rootPath, createdAtMs: 1, source: { sourceId: source.id, revision: source.revision } }],
            relationships: [], organizations: [], revisionsByPhysicalKey: {} });
        const workspaceAction = { kind: 'create_relationship' as const, mode: 'keep_synced' as const, flushBeforeCommit: true as const,
            contentPolicy: buildWorkspaceContentPolicy({ contentSelection: 'all_files', includeIgnoredMode: 'include_selected', ignoredIncludeGlobs: ['.env.local'] }) };
        writeProjectOpenDraft({ scope, draftId, patch: { selection: { serverId: 'home', machineId: seeded.machine.id,
            source: { ...source, subdir: 'saved/default', checkout }, materialization: { kind: 'sync', targetPath: '/target', workspaceAction } } } });
        const screen = await renderScreen(<ProjectOpenScreen />);
        const branch = () => screen.findAllByType(DropdownMenu).find(node => node.props.testID === 'projects.open.subject.ref');
        await vi.waitFor(() => expect(branch()).toBeDefined());
        await act(async () => { branch()!.props.onSelect('ref:@default'); });
        expect(seeded.read().selection.value?.materialization).toMatchObject({ workspaceAction });
        const { FieldValueItem } = await import('@/components/ui/forms/FieldValueItem');
        const subdir = screen.findAllByType(FieldValueItem).find(node => node.props.testID === 'projects.open.subject.folder');
        expect(subdir).toBeDefined();
        await act(async () => { subdir!.props.onCommit('packages/app'); });
        expect(seeded.read().selection.value).toMatchObject({ subdir: 'packages/app', source: { subdir: 'saved/default' },
            materialization: { workspaceAction } });
        const mode = () => screen.findAllByType(DropdownMenu).find(node => node.props.itemTrigger?.itemProps?.testID === 'projects.open.sync-mode');
        expect(mode()).toBeDefined();
        await act(async () => { mode()!.props.onSelect('copy_once'); });
        expect(seeded.read().selection.value?.materialization).toMatchObject({ workspaceAction: { kind: 'copy_once', contentPolicy: workspaceAction.contentPolicy } });
        // The content choices stay folded under the copy's Files row until the person opens it.
        expect(screen.findAllByType(DropdownMenu).find(node => node.props.itemTrigger?.itemProps?.testID === 'projects.open-content-selection-trigger')).toBeUndefined();
        const { Item } = await import('@/components/ui/lists/Item');
        const files = screen.findAllByType(Item).find(node => node.props.testID === 'projects.open.files');
        expect(files).toBeDefined();
        await act(async () => { files!.props.onPress(); });
        const content = screen.findAllByType(DropdownMenu).find(node => node.props.itemTrigger?.itemProps?.testID === 'projects.open-content-selection-trigger');
        expect(content).toBeDefined();
        await act(async () => { content!.props.onSelect('git_worktree'); });
        expect(seeded.read().selection.value?.materialization).toMatchObject({ workspaceAction: { contentPolicy: { selection: 'git_worktree', extraIncludePatterns: ['.env.local'] } } });
    });
    it('says an unclassified Open failure honestly, with what failed behind Details instead of the Action id', async () => {
        const draftId = '00000000-0000-4000-8000-000000000081';
        await seedOpenDraft(draftId);
        const { writeProjectOpenDraft } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        const { AttentionBanner } = await import('@/components/ui/lists/AttentionBanner');
        const screen = await renderScreen(<ProjectOpenScreen />);
        await act(async () => { writeProjectOpenDraft({ scope: { serverId: 'home', accountId: 'account' }, draftId,
            patch: { result: { kind: 'refused', code: 'project_open_unavailable',
                failureCause: { phase: 'projects.open', errorClass: 'Error', errorCode: null, httpStatus: null } } } }); });
        const banner = screen.findAllByType(AttentionBanner).find(node => node.props.testID === 'projects.open.refused');
        expect(banner?.props.title).toBe(t('projects.open.failed'));
        expect(banner?.props.description).toBe(t('projects.open.failedHint'));
        expect(banner?.props.details).toEqual(['project_open_unavailable', 'Error']);
    });
    it('explains an unverified Home or Machine target and retains the Open draft', async () => {
        const draftId = '00000000-0000-4000-8000-000000000081';
        const seeded = await seedOpenDraft(draftId);
        const selection = seeded.read()?.selection.value;
        const { writeProjectOpenDraft } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        const { AttentionBanner } = await import('@/components/ui/lists/AttentionBanner');
        const screen = await renderScreen(<ProjectOpenScreen />);
        await act(async () => { writeProjectOpenDraft({ scope: { serverId: 'home', accountId: 'account' }, draftId,
            patch: { result: { kind: 'refused', code: 'target_mismatch' } } }); });
        const banner = screen.findAllByType(AttentionBanner).find(node => node.props.testID === 'projects.open.refused');
        expect(banner?.props.title).toBe(t('projects.open.targetMismatch'));
        expect(banner?.props.description).toBe(t('projects.open.targetMismatchHint'));
        expect(banner?.props.details).toContain('target_mismatch');
        expect(seeded.read()?.selection.value).toEqual(selection);
    });
    it('leaves the pushed phone page through the standard back header, not a Cancel of its own', async () => {
        // A pushed page's exit is navigation's Back ("‹ Projects", lab p-open OPENp); Cancel belongs to a modal sheet.
        // Leaving keeps the draft: the page never discards it on unmount.
        const draftId = '00000000-0000-4000-8000-000000000081';
        const seeded = await seedOpenDraft(draftId);
        const screen = await renderScreen(<ProjectOpenScreen />);
        await vi.waitFor(() => expect(screen.findByTestId('projects.open.choices')).toBeTruthy());
        await act(async () => { screen.findByTestId('projects.open')!.props.onLayout({ nativeEvent: { layout: { width: 390 } } }); });
        const before = seeded.read()?.selection.value;
        expect(screen.findByTestId('projects.open.cancel')).toBeFalsy();
        // The hosted web page has no native header, so its page header draws the Back that leaves the page.
        routerSpies.back!.mockClear();
        await screen.pressByTestIdAsync('projects.open.back');
        expect(routerSpies.back!.mock.calls).toHaveLength(1);
        screen.unmount();
        expect(seeded.read()?.selection.value).toEqual(before);
    });

    it('draws no page Back where both panes fit beside each other', async () => {
        const draftId = '00000000-0000-4000-8000-000000000081';
        await seedOpenDraft(draftId);
        const screen = await renderScreen(<ProjectOpenScreen />);
        await vi.waitFor(() => expect(screen.findByTestId('projects.open.choices')).toBeTruthy());
        await act(async () => { screen.findByTestId('projects.open')!.props.onLayout({ nativeEvent: { layout: { width: 1000 } } }); });
        expect(screen.findByTestId('projects.open.back')).toBeFalsy();
    });

    it.each([{ timed: true, connect: true }, { timed: false, connect: true }, { timed: true, connect: false }])
      ('renders a rate-limit recovery banner (%j)', async ({ timed, connect }) => {
        const draftId = '00000000-0000-4000-8000-000000000081';
        await seedOpenDraft(draftId);
        const { writeProjectOpenDraft } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        const { AttentionBanner } = await import('@/components/ui/lists/AttentionBanner');
        const screen = await renderScreen(<ProjectOpenScreen />);
        await vi.waitFor(() => expect(screen.findByTestId('projects.open.choices')).toBeTruthy());
        await act(async () => { writeProjectOpenDraft({ scope: { serverId: 'home', accountId: 'account' }, draftId,
            patch: { result: { kind: 'refused', code: 'REMOTE_RATE_LIMITED',
                ...(timed ? { retryNotBeforeMs: 1900000000000 } : {}),
                remediation: { kind: 'retry', ...(connect ? { action: 'connect_github' } : {}) } } } }); });
        const banner = screen.findAllByType(AttentionBanner).find(node => node.props.testID === 'projects.open.refused');
        expect(banner?.props.title).toBe(timed
            ? t('projects.open.githubRateLimitedUntil', { time: formatResetAtTime(1900000000000) })
            : t('projects.open.githubRateLimited'));
        expect(banner?.props.description).toBe(connect ? t('projects.open.githubConnectHint') : undefined);
        expect(banner?.props.details).toContain('REMOTE_RATE_LIMITED');
        expect(banner?.props.action).toBeUndefined();
    });
    it('selects a Machine and renders the named Use group without materializing a checkout', async () => {
        // The platform, router and applied Home are boundaries; the store, draft,
        // controller, chooser and shared radio-group presentation stay real.
        const { writeProjectOpenDraft,
            getSessionDraftSnapshot } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        const scope = { serverId: 'home', accountId: 'account' };
        const draftId = '00000000-0000-4000-8000-000000000081';
        const { machine } = await seedOpenDraft(draftId);
        const screen = await renderScreen(<ProjectOpenScreen />);
        const picker = () => screen.findAllByType(DropdownMenu).find(node =>
            node.props.items.some((item: { id: string }) => item.id === machine.id));
        await vi.waitFor(() => expect(picker()).toBeDefined());
        const machinePicker = picker();
        expect(machinePicker).toBeDefined();
        await act(async () => { machinePicker!.props.onSelect(machine.id); });
        // One reachable way to open is a statement, not a one-option radio group (T1-F15).
        expect(screen.findAllByType('View' as never).find(node => node.props.role === 'radiogroup')).toBeUndefined();
        expect(screen.findByTestId('projects.open.use.clone')).toBeTruthy();
        expect(getSessionDraftSnapshot(scope, { kind: 'projectOpen', draftId })?.document)
            .toMatchObject({ selection: { value: { machineId: 'machine' } } });
        await act(async () => { writeProjectOpenDraft({ scope, draftId, patch: { result: { kind: 'outcomeUnknown' } } }); });
        const { AttentionBanner } = await import('@/components/ui/lists/AttentionBanner');
        const unknown = screen.findAllByType(AttentionBanner).find(node => node.props.testID === 'projects.open.unknown');
        expect(unknown).toBeDefined();
        // Without an original handle, neither navigation nor a fresh clone is a Check.
        expect(unknown?.props.action).toBeUndefined();
        expect(unknown?.props.secondaryAction).toBeUndefined();
        await act(async () => { writeProjectOpenDraft({ scope, draftId, patch: {
            uncertainInputs: [{ serverId: 'home', machineId: machine.id, source: { kind: 'folder', path: '/repo' }, materialization: { kind: 'attach' } }],
            result: { kind: 'outcomeUnknown', operationId: 'original-attempt' },
        } }); });
        const checkable = screen.findAllByType(AttentionBanner).find(node => node.props.testID === 'projects.open.unknown');
        expect(checkable?.props.action).toMatchObject({ onPress: expect.any(Function) });
        expect(checkable?.props.secondaryAction).toBeUndefined();
    });
    it('names the Machine once with its status and a quiet Change, and starts the only clone at a home-relative suggestion', async () => {
        const draftId = '00000000-0000-4000-8000-000000000081';
        const seeded = await seedOpenDraft(draftId);
        const { ProjectOpenScreen } = await import('./ProjectOpenScreen');
        const { Item } = await import('@/components/ui/lists/Item');
        const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
        const screen = await renderScreen(<ProjectOpenScreen />);
        const where = () => screen.findAllByType(DropdownMenu).find(node => node.props.testID === 'projects.open.where');
        await vi.waitFor(() => expect(where()).toBeDefined());
        await act(async () => { where()!.props.onSelect(seeded.machine.id); });
        const name = screen.findAllByType(Item).find(node => node.props.testID === 'projects.open.where.row')!.props.title;
        // The name is the row's title and nowhere else beside it: no value field repeats it (T1-F9).
        expect(screen.findAllByType(Item).filter(node => node.props.title === name)).toHaveLength(1);
        expect(screen.findByTestId('projects.open.where.change')).toBeTruthy();
        // Selecting the Machine left one way to open: the clone, into the suggested folder (T1-F5/F15).
        expect(seeded.read()).toMatchObject({ selection: { value: { machineId: 'machine', materialization: {
            kind: 'clone', destinationParentPath: '/Users/tester/src', destinationDirectoryName: 'Hello-World' } } } });
        const clone = screen.findAllByType(Item).find(node => node.props.testID === 'projects.open.use.clone')!;
        expect(clone.props.subtitle).toBe(t('projects.open.cloneDetail', { path: '~/src/Hello-World' }));
        expect(clone.props.accessibilityRole).toBeUndefined();
        // The destination is said once, in the option; the standalone Folder field is gone until Change.
        expect(screen.findByTestId('projects.open.destination')).toBeFalsy();
        await act(async () => { screen.pressByTestId('projects.open.destination.change'); });
        expect(screen.findByTestId('projects.open.destination')).toBeTruthy();
    });

    it('names the clone destination and the repository subfolder by what they mean, destination first (TL-A 11-08)', async () => {
        const draftId = '00000000-0000-4000-8000-000000000086';
        const seeded = await seedOpenDraft(draftId);
        const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
        const screen = await renderScreen(<ProjectOpenScreen routeParams={{ draftId, serverId: 'home' }} />);
        const where = () => screen.findAllByType(DropdownMenu).find(node => node.props.testID === 'projects.open.where');
        await vi.waitFor(() => expect(where()).toBeDefined());
        await act(async () => { where()!.props.onSelect(seeded.machine.id); });
        await act(async () => { screen.pressByTestId('projects.open.destination.change'); });
        const { FieldValueItem } = await import('@/components/ui/forms/FieldValueItem');
        const fields = screen.findAllByType(FieldValueItem).filter(node => ['projects.open.destination', 'projects.open.subject.folder'].includes(node.props.testID));
        expect(fields.map(node => [node.props.testID, node.props.title])).toEqual([
            ['projects.open.destination', t('projects.open.cloneInto')],
            ['projects.open.subject.folder', t('projects.open.subfolderInRepository')],
        ]);
    });

    it('submits the shown clone destination and renders missing clone support through the real projects.open Action path', async () => {
        const draftId = '00000000-0000-4000-8000-000000000081';
        const { createHomeGovernanceHarness, installHomeGovernanceBoundaries } =
            await import('@/dev/testkit/harness/homeGovernanceHarness');
        const projectOpenHome = createHomeGovernanceHarness();
        installHomeGovernanceBoundaries(projectOpenHome);
        onTestFinished(() => projectOpenHome.reset());
        const serverId = await projectOpenHome.addHome({ name: 'Project Open', serverUrl: 'https://home.test',
            serverIdentityId: 'srv_project_open', accountId: 'account', currentAccount: true });
        installFileFindAccountBoundaryMocks(serverId, 'account');
        const scope = { serverId, accountId: 'account' };
        const seeded = await seedOpenDraft(draftId, scope);
        const { writeProjectOpenDraft } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        const source = seeded.read().selection.value!.source!;
        if (source.kind !== 'source') throw new Error('Expected Source');
        writeProjectOpenDraft({ scope, draftId, patch: { selection: {
            serverId, source: { kind: 'repository', selector: source.selector },
        } } });
        const { Item } = await import('@/components/ui/lists/Item');
        const screen = await renderScreen(<ProjectOpenScreen />);
        const where = () => screen.findAllByType(DropdownMenu).find(node => node.props.testID === 'projects.open.where');
        await vi.waitFor(() => expect(where()).toBeDefined());
        await act(async () => { where()!.props.onSelect(seeded.machine.id); });
        expect(screen.findAllByType(Item).find(node => node.props.testID === 'projects.open.use.clone')!.props.subtitle)
            .toBe(t('projects.open.cloneDetail', { path: '~/src/Hello-World' }));
        expect(screen.findByTestId('projects.open.submit')!.props.disabled).toBe(false);

        projectOpenAccountActionBoundary.capture = true;
        await screen.pressByTestIdAsync('projects.open.submit');
        await vi.waitFor(() => expect(projectOpenAccountActionBoundary.calls).toHaveLength(1));
        expect(projectOpenAccountActionBoundary.calls[0]).toMatchObject({
            actionId: 'projects.open',
            machineId: 'machine',
            input: {
                machineId: 'machine',
                materialization: { kind: 'clone', destinationParentPath: '/Users/tester/src', destinationDirectoryName: 'Hello-World' },
            },
        });
        const { AttentionBanner } = await import('@/components/ui/lists/AttentionBanner');
        await vi.waitFor(() => {
            const banner = screen.findAllByType(AttentionBanner).find(node => node.props.testID === 'projects.open.refused');
            expect(banner?.props.title).toBe(t('projects.open.cloneUnsupported'));
            expect(banner?.props.details).toEqual(['FEATURE_UNSUPPORTED']);
        });
    });

    it('starts a clone with no repository chosen at a repository address field that asks the Machine to read it', async () => {
        // "Clone a repository…" opens Open with only the clone intent: the address is the first thing to give.
        const draftId = '00000000-0000-4000-8000-000000000081';
        const { machine } = await seedOpenDraft(draftId);
        const { storage } = await import('@/sync/domains/state/storage');
        const { writeProjectOpenDraft } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        const scope = { serverId: 'home', accountId: 'account' };
        const setMachine = (online: boolean) => {
            const next = { ...machine, active: online, activeAt: online ? Date.now() : Date.now() - 3_600_000 };
            storage.setState({ machines: { [machine.id]: next }, machineListByServerId: { home: [next] } });
        };
        setMachine(false);
        writeProjectOpenDraft({ scope, draftId, patch: { selection: { serverId: 'home',
            materialization: { kind: 'clone', destinationParentPath: '', destinationDirectoryName: '' } } } });
        const { FieldValueItem } = await import('@/components/ui/forms/FieldValueItem');
        const screen = await renderScreen(<ProjectOpenScreen />);
        const address = () => screen.findAllByType(FieldValueItem).find(node => node.props.testID === 'projects.open.subject.address');
        await vi.waitFor(() => expect(address()).toBeDefined());
        storage.setState({ machineListStatusByServerId: { home: 'loading' } });
        // The typed address waits for Machine inventory rather than reporting false absence.
        await act(async () => { address()!.props.onCommit('github.com/octocat/Hello-World'); });
        await vi.waitFor(() => expect(address()!.props.value).toBe('github.com/octocat/Hello-World'));
        expect(address()!.props.error).toBeNull();
        await act(async () => { storage.setState({ machineListStatusByServerId: { home: 'idle' } }); });
        // Settled offline inventory now supplies the real answer without retyping the address.
        await vi.waitFor(() => expect(address()!.props.error).toBe(t('projects.sources.addressNoMachine')));
        // Choosing where to clone asks that Machine to read the address again; its failed check is now the answer, naming that Machine.
        await act(async () => { setMachine(true); });
        const where = screen.findAllByType(DropdownMenu).find(node => node.props.testID === 'projects.open.where');
        await act(async () => { where!.props.onSelect(machine.id); });
        await vi.waitFor(() => expect(address()!.props.error).toBe(t('projects.sources.addressCheckFailed', { machine: machine.id, code: 'invalid_response' })));
        // Correcting the address withdraws the refusal for the old one while the person is still typing (QA D3).
        await act(async () => { address()!.props.onDraftChange('github.com/github/gitignore'); });
        expect(address()!.props.error).toBeNull();
    });

    it('chooses the branch from a field select whose Other entry asks for any ref', async () => {
        const draftId = '00000000-0000-4000-8000-000000000081';
        const seeded = await seedOpenDraft(draftId);
        const { ProjectOpenScreen } = await import('./ProjectOpenScreen');
        const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
        const { Modal } = await import('@/modal');
        const screen = await renderScreen(<ProjectOpenScreen />);
        const branch = () => screen.findAllByType(DropdownMenu).find(node => node.props.testID === 'projects.open.subject.ref');
        await vi.waitFor(() => expect(branch()).toBeDefined());
        expect(branch()!.props.items.map((item: { id: string }) => item.id)).toEqual(['ref:@default', 'ref:@other']);
        expect(branch()!.props.selectedId).toBe('ref:@default');
        vi.mocked(Modal.prompt).mockResolvedValueOnce(' release/0.4 ');
        await act(async () => { branch()!.props.onSelect('ref:@other'); });
        await vi.waitFor(() => expect(seeded.read()).toMatchObject({ selection: { value: { ref: 'release/0.4' } } }));
        expect(branch()!.props.selectedId).toBe('ref:release/0.4');
    });

    it('hosted as the desktop dialog, puts its footer in the card slot and keeps the draft address its own', async () => {
        const draftId = '00000000-0000-4000-8000-000000000081';
        await seedOpenDraft(draftId);
        const { ProjectOpenScreen } = await import('./ProjectOpenScreen');
        const { PageHeader } = await import('@/components/ui/layout/PageHeader');
        const setChrome = vi.fn();
        const screen = await renderScreen(<ProjectOpenScreen routeParams={{ draftId, serverId: 'home' }} setChrome={setChrome} onClose={() => {}} />);
        await vi.waitFor(() => expect(screen.findByTestId('projects.open.choices')).toBeTruthy());
        // The card header carries the title; the body has no page header and no footer of its own.
        expect(screen.findAllByType(PageHeader)).toHaveLength(0);
        expect(screen.findByTestId('projects.open.submit')).toBeFalsy();
        expect(setChrome).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'card', footer: expect.anything() }));
    });
});
