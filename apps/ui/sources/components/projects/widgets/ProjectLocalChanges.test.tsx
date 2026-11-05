import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/mini';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { AUTHORING_MEMORY_ROUTE_V1, AuthoringMemoryListResponseV1Schema } from '@happier-dev/protocol/account/authoringMemory';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1, ProjectAccountRowListResponseV1Schema } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SCM_OPERATION_ERROR_CODES, ScmWorkingSnapshotSchema } from '@happier-dev/protocol/scm';
import { ScmComparisonSchema } from '@happier-dev/protocol/scm/comparison';

import { WidgetPresentationProvider } from '@happier-dev/plugin-ui';
import { getWidgetSizeFootprintV1 } from '@happier-dev/protocol/widgets';
import { createMachineFixture, flushHookEffects, renderHook, renderScreen } from '@/dev/testkit';
import { installSessionDetailsPanelNonRnModuleMocks } from '@/components/sessions/panes/sessionDetailsPanelNonRnModuleMocks';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { readProjectManifestDocument } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestDocument';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { applyProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';

let disposeActionLoader: (() => void) | undefined;
let projectInspection: Awaited<ReturnType<typeof createExternalActionAccountHttpBoundary>>;
beforeAll(async () => {
    disposeActionLoader = await installRealActionExecutorModuleLoader();
    projectInspection = await createExternalActionAccountHttpBoundary({
        serverUrl: 'https://session-pane.test', serverIdentityId: 'srv_session_pane', accountId: 'account-a', machineId: 'm1',
        actionId: 'projects.inspect', tokenEpoch: 0, requesterInvocation: 'none',
        execute: () => ({
            definition: boundary.manifestPresent ? { basis: { kind: 'present', hash: 'a'.repeat(64) }, document: readProjectManifestDocument(
                JSON.stringify({ version: 1, scripts: { build: { source: { kind: 'command', command: 'make build' } } } })) }
                : { basis: { kind: 'absent' }, document: null },
            detection: { entries: [{ usage: 'script', source: { kind: 'native', tool: 'package_script', file: 'package.json', target: 'test' } }],
                environments: [], devcontainers: [], coverage: 'complete', diagnostics: [] },
            importCandidates: [],
        }),
    });
});
afterAll(() => disposeActionLoader?.());

const boundary = vi.hoisted(() => ({ navigate: vi.fn(), denied: false, confirmDiscard: false, confirmPush: false, rootReadme: false,
    manifestPresent: true,
    pathname: '/', routeParams: {} as Record<string, string | string[] | undefined>, writes: [] as { method: string; params: unknown }[] }));
installSessionDetailsPanelNonRnModuleMocks({ router: () => createExpoRouterMock({ router: { push: boundary.navigate },
    pathname: () => boundary.pathname, params: () => boundary.routeParams }).module });
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
    // Native confirmation is the boundary; SCM policy, lock, transport and store remain real.
    spies: { confirm: async () => boundary.confirmDiscard || boundary.confirmPush },
}).module);

const { useWorkspaceScmCommitControls } = await import('@/components/projects/scm/useWorkspaceScmCommitControls');
const { storage } = await import('@/sync/domains/state/storageStore');
const { ScmChangeRow } = await import('@/components/workspaces/scm/changes/ScmChangeRow');
const { ScmChangeOverflowMenu } = await import('@/components/workspaces/scm/changes/ScmChangeOverflowMenu');
const { readProjectFileRouteTarget } = await import('@/components/projects/detail/projectRouteState');
const { readProjectOpenRouteDraft } = await import('@/components/projects/activation/projectOpenRoute');
const { activeReviewFileKeyForWorkspace, publishActiveReviewFile, readActiveReviewFile, resetActiveReviewFilesForTests } = await import('@/components/workspaces/scm/review/activeReviewFile');
const { parseSessionPaneUrlState } = await import('@/components/sessions/panes/url/sessionPaneUrlState');
const { ScmCommitComposerCard } = await import('@/components/workspaces/scm/commitComposer/ScmCommitComposerCard');
const { readNewSessionDraftFromRepository, writeNewSessionDraftToRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
const { listNewSessionDraftProjections } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
const { useRepositoryTreeBrowserState } = await import('@/hooks/workspaces/files/repositoryTreeBrowserState');
const { tryBuildWorkspaceCacheKey } = await import('@/sync/domains/workspaces/workspaceScope');
const { clearCachedWorkspaceRepositoryDirectoryEntries, getCachedWorkspaceRepositoryDirectoryEntries } = await import('@/sync/domains/workspaces/files/workspaceRepositoryDirectory');
const { WorkspaceFileDetailsView } = await import('@/components/workspaces/files/details/WorkspaceFileDetailsView');
const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
const { ActionsSettingsV1Schema } = await import('@happier-dev/protocol/actions/actionSettings');
const approvalArtifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });
let accountSettings: ReturnType<typeof storage.getState>['settings'] | null = null;
let accountSettingsVersion = 0;
afterEach(() => { vi.useRealTimers(); approvalArtifacts.clear(); accountSettings = null; accountSettingsVersion = 0; });

function snapshot(paths: readonly string[]) {
    return ScmWorkingSnapshotSchema.parse({
        projectKey: 'm1:/repo', fetchedAt: 1,
        repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git' },
        capabilities: { readStatus: true, readDiffFile: true, readDiffCommit: true, readLog: true,
            writeInclude: true, writeExclude: true, writeCommit: true, writeDiscard: true, writeCommitPathSelection: true,
            writeCommitLineSelection: false, writeBackout: false, writeRemoteFetch: false, writeRemotePull: false,
            writeRemotePush: false, worktreeCreate: false, changeSetModel: 'index', supportedDiffAreas: ['pending'] },
        branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false }, hasConflicts: false,
        entries: paths.map(path => ({ path, previousPath: null, kind: 'modified', includeStatus: '', pendingStatus: 'M',
            hasIncludedDelta: false, hasPendingDelta: true })),
        totals: { includedFiles: 0, pendingFiles: paths.length, untrackedFiles: 0,
            includedAdded: 0, includedRemoved: 0, pendingAdded: paths.length, pendingRemoved: 0 },
    });
}
let currentSnapshot = snapshot(['src/a.ts', 'src/b.ts']);
const runtime = installSessionPaneRuntimeTestHarness({
    credentials: { token: createAccountTokenForTests('account-a', { currentAccount: true }) },
    request: async (url, init) => {
        const path = new URL(String(url)).pathname;
        const inspection = await projectInspection.handle(new URL(String(url)), init);
        if (inspection) return inspection;
        // The real Account bootstrap and Action front door read these Home-owned baselines.
        if (path === AUTHORING_MEMORY_ROUTE_V1 && (init?.method ?? 'GET') === 'GET')
            return Response.json(AuthoringMemoryListResponseV1Schema.parse({ rows: [] }));
        if (path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list` && init?.method === 'POST')
            return Response.json(ProjectAccountRowListResponseV1Schema.parse({ status: 'listed', rows: [], coverage: 'complete' }));
        if (path === '/v2/account/settings' && (init?.method ?? 'GET') === 'GET')
            return Response.json(accountSettings ? { content: { t: 'plain', v: accountSettings }, version: accountSettingsVersion } : { content: null, version: 0 });
        const artifactResponse = approvalArtifacts.handle(path, init);
        if (artifactResponse) return artifactResponse;
        if (path === '/v1/machines/m1')
            return Response.json({ machine: { id: 'm1', kind: 'persistent', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } });
        return null;
    },
    configureSocket: socket => {
        // The cold transport has no Engine.IO packet writer; presence writes stay at this boundary.
        vi.spyOn(socket, 'emit').mockReturnValue(socket);
        vi.mocked(socket.connect).mockImplementation(() => {
            socket.connected = true;
            for (const listener of socket.listeners('connect')) listener();
            return socket;
        });
        vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event, payload) => {
            if (event !== 'rpc-call') throw new Error(`Unexpected event: ${event}`);
            const request = z.looseObject({ method: z.string(), params: z.unknown() }).parse(payload);
            if (request.method.endsWith(`:${RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY}`)) return { ok: true, result: {
                ok: true, path: z.looseObject({ path: z.string() }).parse(request.params).path, truncated: false,
                entries: boundary.rootReadme ? [{ name: 'readme.MD', path: '/repo/readme.MD', type: 'file' }] : [],
            } };
            if (request.method.endsWith(`:${RPC_METHODS.SCM_STATUS_SNAPSHOT}`)) return { ok: true, result: boundary.denied
                ? { success: false, errorCode: SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE, error: 'Denied' }
                : { success: true, snapshot: currentSnapshot } };
            if (request.method.endsWith(`:${RPC_METHODS.SCM_COMMIT_CREATE}`)) {
                boundary.writes.push(request);
                return { ok: true, result: { success: true, commitSha: 'created-commit' } };
            }
            if (request.method.endsWith(`:${RPC_METHODS.SCM_REMOTE_PUSH}`)) {
                boundary.writes.push(request);
                currentSnapshot = ScmWorkingSnapshotSchema.parse({ ...currentSnapshot,
                    branch: { ...currentSnapshot.branch, ahead: 0 }, fetchedAt: currentSnapshot.fetchedAt + 1 });
                return { ok: true, result: { success: true, stdout: '' } };
            }
            if (request.method.endsWith(`:${RPC_METHODS.SCM_CHANGE_DISCARD}`)) {
                boundary.writes.push(request);
                const { entries } = z.looseObject({ entries: z.array(z.looseObject({ path: z.string() })) }).parse(request.params);
                currentSnapshot = snapshot(currentSnapshot.entries.filter(entry => !entries.some(item => item.path === entry.path)).map(entry => entry.path));
                return { ok: true, result: { success: true } };
            }
            if (request.method.endsWith(`:${RPC_METHODS.SCM_CHANGE_INCLUDE}`) || request.method.endsWith(`:${RPC_METHODS.SCM_CHANGE_EXCLUDE}`)) {
                boundary.writes.push(request);
                const include = request.method.endsWith(`:${RPC_METHODS.SCM_CHANGE_INCLUDE}`);
                const { paths } = z.looseObject({ paths: z.array(z.string()) }).parse(request.params);
                currentSnapshot = ScmWorkingSnapshotSchema.parse({ ...currentSnapshot, fetchedAt: currentSnapshot.fetchedAt + 1,
                    entries: currentSnapshot.entries.map(entry => paths.includes(entry.path) ? { ...entry,
                        hasIncludedDelta: include, hasPendingDelta: !include, includeStatus: include ? 'M' : '', pendingStatus: include ? '' : 'M' } : entry) });
                return { ok: true, result: { success: true } };
            }
            return { ok: false, error: 'Method not found' };
        });
    },
});
beforeEach(async () => {
    boundary.navigate.mockClear(); boundary.denied = false;
    // The Action front door lazily loads the ordinary draft host. Bind its
    // module-level router as well as useRouter to this same OS boundary spy.
    vi.spyOn((await import('expo-router')).router, 'push').mockImplementation(boundary.navigate);
    boundary.confirmDiscard = false;
    boundary.confirmPush = false;
    boundary.rootReadme = false;
    boundary.manifestPresent = true;
    boundary.pathname = '/';
    boundary.routeParams = {};
    resetActiveReviewFilesForTests();
    boundary.writes.length = 0;
    currentSnapshot = snapshot(['src/a.ts', 'src/b.ts']);
    storage.setState({ sessions: {} });
    await prepareSessionDraftPersistenceStorage();
    // Seed accepted rows only after the connected Home's real initial census has settled.
    await vi.waitFor(() => expect(storage.getState().projectAccountRows?.status).toBe('ready'));
    storage.getState().applyMachines([createMachineFixture({ id: 'm1', storageMode: 'plain', activeAt: Date.now() })], true, { sourceServerId: runtime.serverId });
    applyProjectAccountRowsFixture(storage, { workspaceRefs: [{ id: 'wr_1', serverId: runtime.serverId,
        machineId: 'm1', rootPath: '/repo', projectKey: 'project', createdAtMs: 1 }] });
});
/** A Home board widget its owner sized tall; the Overview column draws widgets without a size. */
const TALL_PRESENTATION = { size: 'tall' as const, footprint: getWidgetSizeFootprintV1('home', 'tall')!, geometry: { width: 480, height: 640 } };

async function mount(rootPath = '/repo', id: 'project_changes' | 'project_checkouts' | 'project_scripts' | 'project_code' | 'project_readme' = 'project_changes',
    options: Readonly<{ tall?: boolean }> = {}) {
    const { ProjectBuiltinWidgetBody } = await import('./ProjectBuiltinWidgetBody');
    const routeParams = { workspaceRefId: 'wr_1', serverId: runtime.serverId, ...boundary.routeParams };
    const screen = await renderScreen(<runtime.Wrapper><DestinationInstanceHost tabId="project-local-changes"
        ref={{ kind: 'project', params: routeParams }} pathname={boundary.pathname} focused visible
        navigation={{ push: boundary.navigate, replace: boundary.navigate, back: () => {}, setParams: () => {} }}>
        <WidgetPresentationProvider value={options.tall ? TALL_PRESENTATION : undefined}>
            <ProjectBuiltinWidgetBody id={id}
                checkout={{ serverId: runtime.serverId, id: 'wr_1', machineId: 'm1', rootPath, projectKey: 'project', createdAtMs: 1 }}
                workspace={{ serverId: runtime.serverId, workspaceId: 'wr_1', machineId: 'm1', rootPath }} testID="local-changes" />
        </WidgetPresentationProvider>
    </DestinationInstanceHost></runtime.Wrapper>);
    await vi.waitFor(async () => {
        await flushHookEffects();
        if (id === 'project_changes' || id === 'project_checkouts') {
            const scope = { serverId: runtime.serverId, machineId: 'm1', rootPath };
            const error = storage.getState().getWorkspaceScmSnapshotError(scope);
            if (error && !boundary.denied) throw new Error(`Fixture SCM read failed: ${error.message}`);
            expect(storage.getState().getWorkspaceScmSnapshot(scope) ?? error).not.toBeNull();
        } else if (id === 'project_scripts') {
            const failure = screen.findAllByType(SurfaceStateCard).find(node => node.props.kind === 'unavailable');
            if (failure) throw new Error(`Fixture Scripts inspection failed: ${failure.props.diagnosticCode}`);
            expect(screen.findHostByTestId(boundary.manifestPresent ? 'local-changes.script:build' : 'local-changes.setup')).not.toBeNull();
        } else if (id === 'project_readme') {
            const workspaceCacheKey = tryBuildWorkspaceCacheKey({ serverId: runtime.serverId, machineId: 'm1', rootPath });
            if (!workspaceCacheKey) throw new Error('Exact fixture scope missing');
            expect(getCachedWorkspaceRepositoryDirectoryEntries({ workspaceCacheKey, directoryPath: '' })).not.toBeNull();
        } else expect(screen.findHostByTestId('local-changes-footer-open')).not.toBeNull();
    });
    return screen;
}

describe('Project Local Changes', () => {
    it('dispatches the Sessions slot to the Project roster body, never a missing plugin view', async () => {
        const { ProjectBuiltinWidgetBody } = await import('./ProjectBuiltinWidgetBody');
        const { ProjectSessionsWidgetBody } = await import('./ProjectSessionsWidgetBody');
        const screen = await renderScreen(<runtime.Wrapper><ProjectBuiltinWidgetBody id="project_sessions"
            checkout={{ serverId: runtime.serverId, id: 'wr_1', machineId: 'm1', rootPath: '/repo', projectKey: 'project', createdAtMs: 1 }}
            workspace={{ serverId: runtime.serverId, workspaceId: 'wr_1', machineId: 'm1', rootPath: '/repo' }} testID="sessions" /></runtime.Wrapper>);
        expect(screen.findAllByType(ProjectSessionsWidgetBody)).toHaveLength(1);
        expect(screen.findAllByType(SurfaceStateCard).filter(node => node.props.kind === 'unavailable')).toEqual([]);
    });
    it('names a folder without a repository where it lives on its machine, home-relative, not as a raw absolute path', async () => {
        const { ProjectBuiltinWidgetBody } = await import('./ProjectBuiltinWidgetBody');
        const screen = await renderScreen(<runtime.Wrapper><ProjectBuiltinWidgetBody id="project_about"
            checkout={{ serverId: runtime.serverId, id: 'wr_1', machineId: 'm1', rootPath: '/Users/tester/scratch', projectKey: 'project', createdAtMs: 1 }}
            workspace={{ serverId: runtime.serverId, workspaceId: 'wr_1', machineId: 'm1', rootPath: '/Users/tester/scratch' }} testID="about" /></runtime.Wrapper>);
        await flushHookEffects();
        const folder = screen.findHostByTestId('about.folder') ?? screen.findHostByTestId('about.inline');
        expect(folder).not.toBeNull();
        const text = screen.root.findAll(node => typeof node.props.children === 'string' && node.props.children.includes('scratch'))
            .map(node => node.props.children as string);
        expect(text).toContain('~/scratch');
        expect(text.some(value => value.includes('/Users/tester'))).toBe(false);
    });

    it('ordinary Project terminal control opens the real bottom pane without creating a Details terminal tab', async () => {
        const { WorkspaceDetailsPanel } = await import('@/components/projects/panes/WorkspaceDetailsPanel');
        const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
        const observed: { pane: AppPaneScopeApi | null } = { pane: null };
        function Probe() { observed.pane = useAppPaneScope('project:wr_1'); return null; }
        const screen = await renderScreen(<runtime.Wrapper><Probe /><WorkspaceDetailsPanel
            workspaceRef={{ id: 'wr_1', serverId: runtime.serverId, machineId: 'm1', rootPath: '/repo', createdAtMs: 1 }}
            activeRootPath="/repo/worktree-a" scopeId="project:wr_1" /></runtime.Wrapper>);
        await screen.pressByTestIdAsync('workspace-details-open-terminal');
        expect(observed.pane?.scopeState?.bottom).toMatchObject({ isOpen: true, activeTabId: 'terminal' });
        expect(observed.pane?.scopeState?.details.tabs).toEqual([]);
        expect(storage.getState().sessions).toEqual({});
        await screen.unmount();
    });
    it.each(['header', 'comments'] as const)('ordinary Project authoring from %s defers the exact worktree draft until approval', async source => {
        const scope = { serverId: runtime.serverId, accountId: 'account-a' };
        accountSettings = { ...storage.getState().settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({
            v: 1, actions: { 'session.authoring.open': { approvalRequiredSurfaces: ['ui'] } },
        }) };
        storage.getState().applySettingsForScope(scope, accountSettings, ++accountSettingsVersion);
        const checkout = { id: 'wr_1', serverId: runtime.serverId, machineId: 'm1', rootPath: '/repo', projectKey: 'project', createdAtMs: 1 };
        const workspaceScope = { serverId: runtime.serverId, machineId: 'm1', rootPath: '/repo/worktree-a' };
        const selectedCheckout = { ...checkout, id: 'worktree-a', rootPath: workspaceScope.rootPath };
        applyProjectAccountRowsFixture(storage, { workspaceRefs: [checkout, selectedCheckout] });
        boundary.pathname = '/projects/wr_1/overview';
        boundary.routeParams = { layoutId: 'release-dashboard', mobileSurface: 'tabs', initialFile: 'src/a.ts' };
        const cacheKey = tryBuildWorkspaceCacheKey(workspaceScope);
        if (!cacheKey) throw new Error('Exact workspace scope missing');
        storage.getState().upsertWorkspaceReviewCommentDraft(cacheKey, {
            id: 'comment-a', filePath: 'src/a.ts', source: 'diff', body: 'Please verify this change.', createdAt: 1,
            anchor: { kind: 'diffLine', startLine: 1, side: 'after', oldLine: 1, newLine: 1 },
            snapshot: { selectedLines: ['+a'], beforeContext: ['-a'], afterContext: [] },
        });
        const commentsBefore = storage.getState().reviewCommentsDraftsByWorkspaceCacheKey[cacheKey];
        const draftsBefore = listNewSessionDraftProjections(scope);
        const { ProjectShellHeaderHost } = await import('@/components/projects/shell/ProjectShellHeaderHost');
        const { WorkspaceDetailsPanel } = await import('@/components/projects/panes/WorkspaceDetailsPanel');
        const screen = await renderScreen(<runtime.Wrapper><DestinationInstanceHost tabId="project-authoring"
            ref={{ kind: 'project', params: { workspaceRefId: checkout.id, serverId: runtime.serverId, ...boundary.routeParams } }}
            pathname={boundary.pathname} focused visible
            navigation={{ push: boundary.navigate, replace: boundary.navigate, back: () => {}, setParams: () => {} }}>
            {source === 'header'
            ? <ProjectShellHeaderHost workspaceRef={checkout} activeRootPath={workspaceScope.rootPath} onSelectRootPath={() => {}} page="overview" />
            : <WorkspaceDetailsPanel workspaceRef={checkout} activeRootPath={workspaceScope.rootPath} scopeId="project:wr_1" />
        }</DestinationInstanceHost></runtime.Wrapper>);
        const trigger = source === 'header' ? 'project-shell-header.newSession' : 'workspace-details-open-review-comments-session';
        await screen.pressByTestIdAsync(trigger);
        await vi.waitFor(() => expect(screen.findHostByTestId('project-new-session-approval')).not.toBeNull());
        expect(listNewSessionDraftProjections(scope)).toEqual(draftsBefore);
        expect(boundary.navigate).not.toHaveBeenCalled();
        expect(storage.getState().reviewCommentsDraftsByWorkspaceCacheKey[cacheKey]).toEqual(commentsBefore);
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const executor = createDefaultActionExecutor();
        const firstId = approvalArtifacts.list()[0]?.id;
        if (!firstId) throw new Error('Missing authoring approval Artifact');
        await act(async () => { expect(await executor.execute('approval.request.decide', { artifactId: firstId, decision: 'reject' }, { surface: 'ui', serverId: runtime.serverId }))
            .toMatchObject({ ok: true, result: { status: 'rejected' } }); });
        expect(listNewSessionDraftProjections(scope)).toEqual(draftsBefore);
        await screen.pressByTestIdAsync(trigger);
        await vi.waitFor(() => expect(approvalArtifacts.list()).toHaveLength(2));
        await act(async () => { expect(await executor.execute('approval.request.decide', { artifactId: approvalArtifacts.list()[1]!.id, decision: 'approve' }, { surface: 'ui', serverId: runtime.serverId }))
            .toMatchObject({ ok: true, result: { status: 'executed' } }); });
        const newDraft = listNewSessionDraftProjections(scope).find(row => !draftsBefore.some(old => old.draftId === row.draftId));
        if (!newDraft) throw new Error('Approved authoring did not retain a draft');
        expect(readNewSessionDraftFromRepository({ scope, draftId: newDraft.draftId })).toMatchObject({ selectedMachineId: 'm1', selectedPath: workspaceScope.rootPath,
            authoringOrigin: { kind: 'project', purpose: 'session', accountId: scope.accountId, page: 'overview', layoutId: 'release-dashboard',
                surface: 'tabs', resource: { kind: 'file', path: 'src/a.ts' }, workspace: {
                    serverId: runtime.serverId, workspaceId: selectedCheckout.id, machineId: 'm1', rootPath: workspaceScope.rootPath,
                } },
        });
        expect(boundary.navigate).toHaveBeenCalledOnce();
        expect(storage.getState().sessions).toEqual({});
        expect(storage.getState().reviewCommentsDraftsByWorkspaceCacheKey[cacheKey]).toEqual(commentsBefore);
        accountSettings = { ...accountSettings, actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
            actions: { 'session.authoring.open': { disabledSurfaces: ['ui'] } } }) };
        storage.getState().applySettingsForScope(scope, accountSettings, ++accountSettingsVersion);
        await screen.pressByTestIdAsync(trigger);
        expect(listNewSessionDraftProjections(scope)).toHaveLength(draftsBefore.length + 1);
        expect(boundary.navigate).toHaveBeenCalledOnce();
        expect(approvalArtifacts.list()).toHaveLength(2);
        accountSettings = { ...accountSettings, actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1, actions: {} }) };
        storage.getState().applySettingsForScope(scope, accountSettings, ++accountSettingsVersion);
        await screen.pressByTestIdAsync(trigger);
        expect(listNewSessionDraftProjections(scope)).toHaveLength(draftsBefore.length + 2);
        expect(boundary.navigate).toHaveBeenCalledTimes(2);
        expect(storage.getState().sessions).toEqual({});
        expect(storage.getState().reviewCommentsDraftsByWorkspaceCacheKey[cacheKey]).toEqual(commentsBefore);
        await screen.unmount();
    });
    it('keeps a pending Project authoring approval visible when one tab’s header takes the Details controls', async () => {
        const scope = { serverId: runtime.serverId, accountId: 'account-a' };
        accountSettings = { ...storage.getState().settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({
            v: 1, actions: { 'session.authoring.open': { approvalRequiredSurfaces: ['ui'] } },
        }) };
        storage.getState().applySettingsForScope(scope, accountSettings, ++accountSettingsVersion);
        const checkout = { id: 'wr_1', serverId: runtime.serverId, machineId: 'm1', rootPath: '/repo', projectKey: 'project', createdAtMs: 1 };
        const workspaceScope = { serverId: runtime.serverId, machineId: 'm1', rootPath: '/repo/worktree-a' };
        applyProjectAccountRowsFixture(storage, { workspaceRefs: [checkout, { ...checkout, id: 'worktree-a', rootPath: workspaceScope.rootPath }] });
        boundary.pathname = '/projects/wr_1/overview';
        boundary.routeParams = {};
        const cacheKey = tryBuildWorkspaceCacheKey(workspaceScope);
        if (!cacheKey) throw new Error('Exact workspace scope missing');
        storage.getState().upsertWorkspaceReviewCommentDraft(cacheKey, {
            id: 'comment-a', filePath: 'src/a.ts', source: 'diff', body: 'Please verify this change.', createdAt: 1,
            anchor: { kind: 'diffLine', startLine: 1, side: 'after', oldLine: 1, newLine: 1 },
            snapshot: { selectedLines: ['+a'], beforeContext: ['-a'], afterContext: [] },
        });
        const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
        const { createWorkspaceFileDetailsTab } = await import('@/components/appShell/panes/details/fileDetailsTab');
        const { WorkspaceDetailsPanel } = await import('@/components/projects/panes/WorkspaceDetailsPanel');
        const observed: { pane: AppPaneScopeApi | null } = { pane: null };
        function Probe() { observed.pane = useAppPaneScope('project:wr_1'); return null; }
        const screen = await renderScreen(<runtime.Wrapper><DestinationInstanceHost tabId="project-authoring"
            ref={{ kind: 'project', params: { workspaceRefId: checkout.id, serverId: runtime.serverId } }}
            pathname={boundary.pathname} focused visible
            navigation={{ push: boundary.navigate, replace: boundary.navigate, back: () => {}, setParams: () => {} }}>
            <Probe /><WorkspaceDetailsPanel workspaceRef={checkout} activeRootPath={workspaceScope.rootPath} scopeId="project:wr_1" />
        </DestinationInstanceHost></runtime.Wrapper>);
        // Two files keep the strip (and its launcher); the selected one stays selected throughout.
        await act(async () => { observed.pane?.openDetailsTab(createWorkspaceFileDetailsTab('src/b.ts'), { intent: 'pinned' }); });
        await act(async () => { observed.pane?.openDetailsTab(createWorkspaceFileDetailsTab('src/a.ts'), { intent: 'pinned' }); });
        await flushHookEffects();
        await screen.pressByTestIdAsync('workspace-details-open-review-comments-session');
        await vi.waitFor(() => expect(screen.findHostByTestId('project-new-session-approval')).not.toBeNull());
        // Closing the other file leaves one with its own header: the strip and its launchers yield; the pending approval must not.
        await act(async () => { observed.pane?.closeDetailsTab('file:src/b.ts'); });
        await flushHookEffects();
        await vi.waitFor(() => {
            expect(screen.findAllHostsByTestId('file-details-header.root')).toHaveLength(1);
            expect(screen.findAllHostsByTestId('workspace-details-open-review-comments-session')).toHaveLength(0);
        }, { timeout: 10000 });
        expect(screen.findHostByTestId('project-new-session-approval')).not.toBeNull();
        await screen.unmount();
    });
    it.each([false, true])('ordinary Project header retains its qualified selected plugin companion and instance across draft opening (closed %s)', async closed => {
        const scope = { serverId: runtime.serverId, accountId: 'account-a' };
        const before = listNewSessionDraftProjections(scope);
        const checkout = { id: 'wr_1', serverId: runtime.serverId, machineId: 'm1', rootPath: '/repo', projectKey: 'project', createdAtMs: 1 };
        const companion = { kind: 'plugin', destination: { pluginId: 'acme.preview', localId: 'project-review' }, instanceKey: 'review-a' } as const;
        boundary.pathname = '/projects/wr_1/overview';
        boundary.routeParams = { rightDestination: JSON.stringify(companion) };
        const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
        const { useDestinationPaneScopeId } = await import('@/components/appShell/workspace/DestinationInstanceHost');
        const { buildProjectPaneScopeId } = await import('@/components/projects/detail/projectPaneScope');
        const { ProjectShellHeaderHost } = await import('@/components/projects/shell/ProjectShellHeaderHost');
        function SelectCompanion() {
            const pane = useAppPaneScope(useDestinationPaneScopeId(buildProjectPaneScopeId(checkout.id, checkout.serverId)));
            React.useEffect(() => { pane.openRight(); pane.selectRightDestination(companion); }, [pane.openRight, pane.selectRightDestination]);
            return React.createElement('ProjectCompanionProbe', { isOpen: pane.scopeState?.right.isOpen, close: pane.closeRight });
        }
        const screen = await renderScreen(<runtime.Wrapper><SelectCompanion />
            <ProjectShellHeaderHost workspaceRef={checkout} activeRootPath={checkout.rootPath} onSelectRootPath={() => {}} page="overview" />
        </runtime.Wrapper>);
        try {
            expect(screen.root.findByType('ProjectCompanionProbe').props.isOpen).toBe(true);
            if (closed) {
                await act(async () => { screen.root.findByType('ProjectCompanionProbe').props.close(); });
                expect(screen.root.findByType('ProjectCompanionProbe').props.isOpen).toBe(false);
                expect(boundary.routeParams.rightDestination).toBe(JSON.stringify(companion));
            }
            await screen.pressByTestIdAsync('project-shell-header.newSession');
            const opened = listNewSessionDraftProjections(scope).find(row => !before.some(old => old.draftId === row.draftId));
            expect(opened).toBeDefined();
            const origin = readNewSessionDraftFromRepository({ scope, draftId: opened!.draftId })?.authoringOrigin;
            expect(origin).toMatchObject({ page: 'overview', purpose: 'session' });
            expect(origin?.companion).toEqual(closed ? undefined : companion);
            expect(storage.getState().sessions).toEqual({});
        } finally { await screen.unmount(); }
    });
    it.each(['same-project', 'foreign-project', 'foreign-home'])('retains named dashboard context only for the qualified current Project (%s)', async relation => {
        const accountScope = storage.getState().profileScope;
        if (!accountScope) throw new Error('Connected fixture has no Account scope');
        const checkout = { id: 'wr_1', serverId: runtime.serverId, machineId: 'm1', rootPath: '/repo', projectKey: 'project', createdAtMs: 1 };
        const current = relation === 'same-project' ? checkout : { ...checkout, id: 'foreign',
            ...(relation === 'foreign-project' ? { projectKey: 'other' } : { serverId: 'another-home' }) };
        storage.getState().activateProjectAccountRowsScope(accountScope);
        storage.getState().applyProjectAccountRowsForScope(accountScope, { scope: accountScope, status: 'ready', coverage: 'complete',
            workspaceRefs: relation === 'same-project' ? [checkout] : [checkout, current],
            relationships: [], organizations: [], revisionsByPhysicalKey: {} });
        boundary.pathname = `/projects/${current.id}/overview`;
        boundary.routeParams = { workspaceRefId: current.id, serverId: current.serverId, layoutId: 'named-dashboard',
            initialFile: 'src/current.ts', comparisonId: 'saved-comparison' };
        currentSnapshot = ScmWorkingSnapshotSchema.parse({ ...snapshot([]), repo: { ...snapshot([]).repo,
            worktrees: [{ id: 'feature-checkout', path: '/repo/feature', branch: 'feature', isCurrent: false }] } });
        const screen = await mount('/repo', 'project_checkouts');
        await screen.pressByTestIdAsync('local-changes.worktree:feature-checkout');
        const url = new URL(boundary.navigate.mock.calls.at(-1)?.[0], 'https://app.test');
        expect(url.pathname).toBe('/projects/wr_1/overview');
        expect(url.searchParams.get('serverId')).toBe(runtime.serverId);
        expect(url.searchParams.get('worktreeId')).toBe('feature-checkout');
        expect(url.searchParams.get('layoutId')).toBe(relation === 'same-project' ? 'named-dashboard' : null);
        expect(url.searchParams.get('initialFile')).toBe(relation === 'same-project' ? 'src/current.ts' : null);
        expect(url.searchParams.get('comparisonId')).toBe(relation === 'same-project' ? 'saved-comparison' : null);
    });
    it('names a checkout on a machine the Home does not list as unlisted, never by its raw machine id', async () => {
        const accountScope = storage.getState().profileScope;
        if (!accountScope) throw new Error('Connected fixture has no Account scope');
        const checkout = { id: 'wr_1', serverId: runtime.serverId, machineId: 'm1', rootPath: '/repo', projectKey: 'project', createdAtMs: 1 };
        const elsewhere = { ...checkout, id: 'wr_2', machineId: 'machine-not-in-inventory-4d2e', rootPath: '/srv/repo' };
        storage.getState().activateProjectAccountRowsScope(accountScope);
        storage.getState().applyProjectAccountRowsForScope(accountScope, { scope: accountScope, status: 'ready', coverage: 'complete',
            workspaceRefs: [checkout, elsewhere], relationships: [], organizations: [], revisionsByPhysicalKey: {} });
        const screen = await mount('/repo', 'project_checkouts');
        const text = screen.getTextContent();
        expect(text).not.toContain('machine-not-in-inventory-4d2e');
        expect(text).toMatch(/machine\.unlistedMachine|Unlisted machine/);
    });
    it('publishes Clear only for atomic selection and clears the real shared checkout selection', async () => {
        const scope = { serverId: runtime.serverId, machineId: 'm1', rootPath: '/repo' };
        storage.getState().applySettingsLocal({ experiments: true, featureToggles: { 'scm.writeOperations': true }, scmCommitStrategy: 'git_staging' });
        const hook = await renderHook(() => useWorkspaceScmCommitControls(scope), { wrapper: runtime.Wrapper, flushOptions: { cycles: 12 } });
        expect(hook.getCurrent().handleClearSelection).toBeUndefined();
        await act(async () => {
            storage.getState().applySettingsLocal({ scmCommitStrategy: 'atomic' });
            storage.getState().markWorkspaceScmCommitSelectionPaths(scope, ['src/a.ts']);
        });
        await flushHookEffects({ cycles: 12 });
        expect(storage.getState().getWorkspaceScmCommitSelectionPaths(scope)).toEqual(['src/a.ts']);
        await act(async () => hook.getCurrent().handleClearSelection?.());
        expect(storage.getState().getWorkspaceScmCommitSelectionPaths(scope)).toEqual([]);
        expect(boundary.writes).toEqual([]);
        expect(storage.getState().sessions).toEqual({});
    });
    it('discovers an added root README and removes its projection on canonical directory invalidation without remounting', async () => {
        const workspaceCacheKey = tryBuildWorkspaceCacheKey({ serverId: runtime.serverId, machineId: 'm1', rootPath: '/repo' });
        if (!workspaceCacheKey) throw new Error('Exact fixture scope missing');
        clearCachedWorkspaceRepositoryDirectoryEntries({ workspaceCacheKey, directoryPath: '' });
        const screen = await mount('/repo', 'project_readme');
        expect(screen.findAllByType(WorkspaceFileDetailsView)).toEqual([]);
        expect(screen.findHostByTestId('local-changes')).not.toBeNull();
        // Code's completed filesystem writes invalidate this same owner; only the RPC answer changes here.
        boundary.rootReadme = true;
        await act(async () => clearCachedWorkspaceRepositoryDirectoryEntries({ workspaceCacheKey, directoryPath: '' }));
        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(screen.findByType(WorkspaceFileDetailsView).props.filePath).toBe('readme.MD');
        });
        boundary.rootReadme = false;
        await act(async () => clearCachedWorkspaceRepositoryDirectoryEntries({ workspaceCacheKey, directoryPath: '' }));
        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(screen.findAllByType(WorkspaceFileDetailsView)).toEqual([]);
        });
        expect(screen.findHostByTestId('local-changes')).not.toBeNull();
        expect(storage.getState().sessions).toEqual({});
    });
    it('opens captured Explain into the real editable ordinary draft without sending or creating a Session', async () => {
        const { openWorkspaceScmAuthoringDraft } = await import('@/components/projects/scm/workspaceScmAuthoring');
        const accountScope = storage.getState().profileScope;
        if (!accountScope) throw new Error('Connected fixture has no Account scope');
        storage.getState().activateProjectAccountRowsScope(accountScope);
        storage.getState().applyProjectAccountRowsForScope(accountScope, { scope: accountScope, status: 'ready', coverage: 'complete',
            workspaceRefs: [{ id: 'wr_1', serverId: runtime.serverId, machineId: 'm1', rootPath: '/repo', createdAtMs: 1 }],
            relationships: [], organizations: [], revisionsByPhysicalKey: {} });
        const comparison = ScmComparisonSchema.parse({ id: 'captured-explain', source: { kind: 'workingTree' },
            repository: { rootPath: '/repo' }, endpoints: { before: 'captured-head' }, inventory: { state: 'complete', reasons: [], files: [
                { path: 'src/a.ts', changeKind: 'modified', binary: false, generated: false, lockfile: false,
                    evidence: { state: 'available', unifiedDiff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-before\n+after\n' }, occurrences: [] },
            ] } });
        const opened = await openWorkspaceScmAuthoringDraft({ scope: { serverId: runtime.serverId, machineId: 'm1', rootPath: '/repo' },
            comparison, result: null, isCurrent: () => true });
        expect(opened).toMatchObject({ kind: 'opened' });
        if (opened.kind !== 'opened') throw new Error('Expected ordinary authoring draft');
        const draft = readNewSessionDraftFromRepository({ scope: accountScope, draftId: opened.draftId });
        expect(draft).toMatchObject({ selectedMachineId: 'm1', selectedPath: '/repo', authoringOrigin: {
            workspace: { serverId: runtime.serverId, workspaceId: 'wr_1', machineId: 'm1', rootPath: '/repo' }, comparisonId: comparison.id, page: 'changes',
        } });
        if (!draft) throw new Error('Missing ordinary authoring draft');
        expect(draft.input).toContain('captured-head');
        expect(draft.input).toContain('+after');
        writeNewSessionDraftToRepository({ scope: accountScope, draftId: opened.draftId, draft: { ...draft, input: 'My editable follow-up' } });
        expect(readNewSessionDraftFromRepository({ scope: accountScope, draftId: opened.draftId })).toMatchObject({ input: 'My editable follow-up', authoringOrigin: draft.authoringOrigin });
        expect(boundary.navigate.mock.calls.at(-1)?.[0]).toMatchObject({ pathname: '/new', params: { draftId: opened.draftId } });
        expect(boundary.writes).toEqual([]);
        expect(storage.getState().sessions).toEqual({});
    });
    it('shows unpushed commits as non-clean and pushes only after the push Action’s confirmation', async () => {
        storage.getState().applySettingsLocal({ experiments: true, featureToggles: { 'scm.writeOperations': true }, scmRemoteConfirmPolicy: 'always' });
        currentSnapshot = ScmWorkingSnapshotSchema.parse({ ...snapshot([]),
            capabilities: { ...currentSnapshot.capabilities, writeRemotePush: true },
            repo: { ...currentSnapshot.repo, remotes: [{ name: 'origin', fetchUrl: 'git@example.com:repo.git', pushUrl: 'git@example.com:repo.git' }] },
            branch: { ...currentSnapshot.branch, upstream: 'origin/main', ahead: 2 } });
        const screen = await mount();
        expect(screen.findHostByTestId('local-changes-clean')).toBeNull();
        expect(screen.findHostByTestId('local-changes-ahead')).not.toBeNull();
        expect(screen.findAllByType(ScmCommitComposerCard)).toEqual([]);
        await screen.pressByTestIdAsync('local-changes-push');
        await flushHookEffects({ cycles: 12 });
        expect(boundary.writes).toEqual([]);
        boundary.confirmPush = true;
        await screen.pressByTestIdAsync('local-changes-push');
        await flushHookEffects({ cycles: 12 });
        expect(boundary.writes).toEqual([expect.objectContaining({ method: `m1:${RPC_METHODS.SCM_REMOTE_PUSH}`,
            params: expect.objectContaining({ cwd: '/repo', remote: 'origin', branch: 'main' }) })]);
        expect(screen.findHostByTestId('local-changes-ahead')).toBeNull();
        expect(screen.findHostByTestId('local-changes-clean')).not.toBeNull();
        expect(storage.getState().sessions).toEqual({});
    });
    it('does not navigate from a retired widget callback', async () => {
        const screen = await mount('/repo', 'project_changes', { tall: true });
        const openRetiredRow = screen.findAllByType(ScmChangeRow)[0].props.onPress;
        await act(async () => screen.unmount());
        await act(async () => openRetiredRow());
        expect(boundary.navigate).not.toHaveBeenCalled();
        expect(readActiveReviewFile(activeReviewFileKeyForWorkspace({ serverId: runtime.serverId, machineId: 'm1', rootPath: '/repo' })).focusRequest).toBeNull();
    });
    it('retains actual files with freshness and no write affordances when the known machine is offline', async () => {
        storage.getState().applySettingsLocal({ experiments: true, featureToggles: { 'scm.writeOperations': true } });
        const screen = await mount('/repo', 'project_changes', { tall: true });
        const lastHeartbeat = Date.now();
        // An inactive heartbeat stays reachable during the presence owner's grace. Move only the
        // wall clock beyond any supported grace; keep real timers and the real presence selector.
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000);
            await act(async () => storage.getState().applyMachines([createMachineFixture({ id: 'm1', storageMode: 'plain', active: false,
                activeAt: lastHeartbeat, seq: 2, updatedAt: Date.now() })], true, { sourceServerId: runtime.serverId }));
            await flushHookEffects({ cycles: 12 });
            expect(screen.findHostByTestId('local-changes-offline')).not.toBeNull();
            expect(screen.findAllByType(ScmChangeRow).map(row => row.props.file.fullPath)).toEqual(['src/a.ts', 'src/b.ts']);
            expect(screen.findAllByType(ScmChangeRow).every(row => row.props.onToggleSelection === undefined)).toBe(true);
            expect(screen.findAllByType(ScmCommitComposerCard)).toEqual([]);
            expect(boundary.writes).toEqual([]);
        } finally { vi.useRealTimers(); }
    });
    it('says an unreachable checkout once at the page and every widget waits quietly instead of failing', async () => {
        const scope = { serverId: runtime.serverId, machineId: 'm1', rootPath: '/repo' };
        storage.getState().updateWorkspaceScmSnapshot(scope, null);
        // Presence keeps the newest heartbeat; move only the wall clock past any supported grace.
        const lastHeartbeat = Date.now();
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(lastHeartbeat + 24 * 60 * 60 * 1000);
        await act(async () => storage.getState().applyMachines([createMachineFixture({ id: 'm1', active: false,
            activeAt: lastHeartbeat, seq: 2, updatedAt: Date.now() })], true, { sourceServerId: runtime.serverId }));
        const { ProjectBuiltinWidgetBody } = await import('./ProjectBuiltinWidgetBody');
        const { CheckoutReachabilityLine, CheckoutReachabilityScope } = await import('@/components/workspaces/reachability/checkoutReachability');
        const machine = { serverId: runtime.serverId, machineId: 'm1' };
        const ids = ['project_code', 'project_changes', 'project_scripts', 'project_readme', 'project_checkouts'] as const;
        const screen = await renderScreen(<runtime.Wrapper><CheckoutReachabilityScope scope={machine}>
            <CheckoutReachabilityLine scope={machine} />
            {ids.map(id => <ProjectBuiltinWidgetBody key={id} id={id}
                checkout={{ serverId: runtime.serverId, id: 'wr_1', machineId: 'm1', rootPath: '/repo', projectKey: 'project', createdAtMs: 1 }}
                workspace={{ serverId: runtime.serverId, workspaceId: 'wr_1', machineId: 'm1', rootPath: '/repo' }} testID={id} />)}
        </CheckoutReachabilityScope></runtime.Wrapper>);
        await flushHookEffects({ cycles: 12 });
        // The page says it once, with when the machine was last seen and the one Retry: no widget
        // repeats the cause in a freshness line of its own.
        const { SurfaceFreshnessLine } = await import('@/components/ui/surfaces/SurfaceFreshnessLine');
        const lines = screen.findAllByType(SurfaceFreshnessLine);
        expect(lines.map(line => line.props.testID)).toEqual(['checkout-reachability']);
        expect(lines[0].props.asOf).toBeTypeOf('number');
        expect(lines[0].props.action).toBeDefined();
        // No widget fails on its own.
        const states = screen.findAllByType(SurfaceStateCard);
        expect(states.filter(state => state.props.kind === 'error').map(state => state.props.testID)).toEqual([]);
        expect(screen.findHostByTestId('repository-tree-root-error')).toBeNull();
        expect(screen.findHostByTestId('project_code-footer')).toBeNull();
        // A widget with nothing last-known inherits one quiet wait (the never-listed folder here); one with
        // last-known content keeps it. Either way nothing offers a second Retry or fails on its own.
        // The wait names no cause: the page's line already did. It keeps the body's shape with still
        // placeholders and tells assistive technology what it waits for.
        expect(states.map(state => String(state.props.testID ?? '')).filter(id => id.endsWith('-unreachable'))).toEqual([]);
        const quietWait = screen.findHostByTestId('repository-tree-unreachable');
        expect(String(quietWait?.props.accessibilityLabel ?? '')).toMatch(/projects\.checkouts\.waiting|Waiting for/);
        const texts = screen.root.findAll(node => typeof node.type === 'string' && typeof node.props.children === 'string')
            .map(node => String(node.props.children));
        expect(texts.filter(text => /^(projects\.checkouts\.waiting|Waiting for)/.test(text))).toEqual([]);
        expect(states.filter(state => state.props.kind === 'unavailable' && state.props.action !== undefined)
            .map(state => state.props.testID)).toEqual([]);
        expect(screen.findHostByTestId('project_changes-error')).toBeNull();
        // Checkouts keeps the row and says this one is offline.
        const here = screen.root.findAll(node => node.props.testID === 'project_checkouts.here' && node.props.fact !== undefined)[0];
        expect(String(here?.props.fact)).toContain('offline');
        // "Here" and "offline" would contradict each other on one row.
        expect(here?.props.tag).toBeUndefined();
        expect(boundary.writes).toEqual([]);
    });
    it('keeps the Code widget the folder itself in any framed placement, sized or not', async () => {
        const scope = { serverId: runtime.serverId, machineId: 'm1', rootPath: '/repo' };
        storage.getState().updateWorkspaceScmSnapshot(scope, null);
        const lastHeartbeat = Date.now();
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(lastHeartbeat + 24 * 60 * 60 * 1000);
        await act(async () => storage.getState().applyMachines([createMachineFixture({ id: 'm1', active: false,
            activeAt: lastHeartbeat, seq: 2, updatedAt: Date.now() })], true, { sourceServerId: runtime.serverId }));
        const { ProjectBuiltinWidgetBody } = await import('./ProjectBuiltinWidgetBody');
        const { CheckoutReachabilityScope } = await import('@/components/workspaces/reachability/checkoutReachability');
        const { WidgetFrameBodyRowsContext } = await import('@/components/widgets/frame/widgetFrameBody');
        const machine = { serverId: runtime.serverId, machineId: 'm1' };
        // A side-area or stacked widget has a frame but no size presentation (lab p-overview HOME).
        const screen = await renderScreen(<runtime.Wrapper><CheckoutReachabilityScope scope={machine}>
            <WidgetFrameBodyRowsContext.Provider value={0}>
                <ProjectBuiltinWidgetBody id="project_code"
                    checkout={{ serverId: runtime.serverId, id: 'wr_1', machineId: 'm1', rootPath: '/repo', projectKey: 'project', createdAtMs: 1 }}
                    workspace={{ serverId: runtime.serverId, workspaceId: 'wr_1', machineId: 'm1', rootPath: '/repo' }} testID="project_code" />
            </WidgetFrameBodyRowsContext.Provider>
        </CheckoutReachabilityScope></runtime.Wrapper>);
        await flushHookEffects({ cycles: 12 });
        // Its page tools (filter, create, Project | All files) live on the Code page, not in the card.
        const ids = screen.root.findAll(node => typeof node.props.testID === 'string').map(node => String(node.props.testID));
        expect(ids.filter(id => /^(workspace-)?repository-tree-(visibility|all-files|toggle-details)/.test(id))).toEqual([]);
        // The folder still waits quietly in the card's own shape.
        expect(screen.findHostByTestId('repository-tree-unreachable')).not.toBeNull();
    });
    it('requires explicit native confirmation before discarding the actual checkout path', async () => {
        storage.getState().applySettingsLocal({ experiments: true, featureToggles: { 'scm.writeOperations': true }, scmCommitStrategy: 'git_staging' });
        const screen = await mount('/repo', 'project_changes', { tall: true });
        await act(async () => screen.findByTestId('scm-change-row-container:src_a.ts')?.props.onFocus?.());
        await act(async () => screen.findAllByType(ScmChangeOverflowMenu)[0].props.onDiscard());
        await flushHookEffects({ cycles: 12 });
        expect(boundary.writes).toEqual([]);
        boundary.confirmDiscard = true;
        await act(async () => screen.findAllByType(ScmChangeOverflowMenu)[0].props.onDiscard());
        await flushHookEffects({ cycles: 12 });
        expect(boundary.writes).toEqual([expect.objectContaining({ method: `m1:${RPC_METHODS.SCM_CHANGE_DISCARD}`,
            params: expect.objectContaining({ cwd: '/repo', entries: [{ path: 'src/a.ts', kind: 'modified' }] }) })]);
        expect(screen.findAllByType(ScmChangeRow).map(row => row.props.file.fullPath)).toEqual(['src/b.ts']);
        expect(storage.getState().sessions).toEqual({});
    });
    it('uses canonical include and exclude on the exact checkout for indexed staging', async () => {
        storage.getState().applySettingsLocal({ experiments: true, featureToggles: { 'scm.writeOperations': true }, scmCommitStrategy: 'git_staging' });
        const screen = await mount('/repo', 'project_changes', { tall: true });
        await act(async () => screen.findAllByType(ScmChangeRow)[0].props.onToggleSelection());
        await flushHookEffects({ cycles: 12 });
        expect(boundary.writes[0]).toMatchObject({ method: `m1:${RPC_METHODS.SCM_CHANGE_INCLUDE}`, params: { cwd: '/repo', paths: ['src/a.ts'] } });
        expect(screen.findAllByType(ScmChangeRow)[0].props.file.isIncluded).toBe(true);
        await act(async () => screen.findAllByType(ScmChangeRow)[0].props.onToggleSelection());
        await flushHookEffects({ cycles: 12 });
        expect(boundary.writes[1]).toMatchObject({ method: `m1:${RPC_METHODS.SCM_CHANGE_EXCLUDE}`, params: { cwd: '/repo', paths: ['src/a.ts'] } });
        expect(screen.findAllByType(ScmChangeRow)[0].props.file.isIncluded).toBe(false);
        expect(storage.getState().sessions).toEqual({});
    });
    it('shows declared scripts and no-manifest detections through inspection without creating an execution Session', async () => {
        const screen = await mount('/repo', 'project_scripts');
        expect(screen.findHostByTestId('local-changes.script:build')).not.toBeNull();
        await screen.unmount();
        boundary.manifestPresent = false;
        const detected = await mount('/repo', 'project_scripts');
        expect(detected.findHostByTestId('local-changes.detected:0')).not.toBeNull();
        expect(storage.getState().sessions).toEqual({});
    });
    it('opens ordinary editable setup authoring from Scripts without executing the scripts', async () => {
        boundary.manifestPresent = false;
        const accountScope = storage.getState().profileScope;
        if (!accountScope) throw new Error('Connected fixture has no Account scope');
        storage.getState().activateProjectAccountRowsScope(accountScope);
        storage.getState().applyProjectAccountRowsForScope(accountScope, { scope: accountScope, status: 'ready', coverage: 'complete',
            workspaceRefs: [{ id: 'wr_1', serverId: runtime.serverId, machineId: 'm1', rootPath: '/repo', createdAtMs: 1 }],
            relationships: [], organizations: [], revisionsByPhysicalKey: {} });
        const before = new Set(listNewSessionDraftProjections(accountScope).map(draft => draft.draftId));
        const screen = await mount('/repo', 'project_scripts');
        await screen.pressByTestIdAsync('local-changes.setup');
        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(listNewSessionDraftProjections(accountScope).some(draft => !before.has(draft.draftId))).toBe(true);
        });
        const draft = listNewSessionDraftProjections(accountScope).find(draft => !before.has(draft.draftId));
        expect(draft).toBeDefined();
        expect(boundary.navigate.mock.calls.at(-1)?.[0]).toMatchObject({ pathname: '/new', params: { draftId: draft?.draftId } });
        expect(boundary.writes).toEqual([]);
        expect(storage.getState().sessions).toEqual({});
    });
    it('browses a folder in the Code widget and opens the full qualified Code page without a Session', async () => {
        const scopeKey = tryBuildWorkspaceCacheKey({ serverId: runtime.serverId, machineId: 'm1', rootPath: '/repo' }) ?? '';
        const browser = await renderHook(() => useRepositoryTreeBrowserState(scopeKey));
        await act(async () => browser.getCurrent().setLocation({ path: 'src', kind: 'folder' }));
        const screen = await mount('/repo', 'project_code');
        await screen.pressByTestIdAsync('local-changes-footer-open');
        const url = new URL(boundary.navigate.mock.calls.at(-1)?.[0], 'https://app.test');
        expect(url.pathname).toBe('/projects/wr_1/code');
        expect(url.searchParams.get('serverId')).toBe(runtime.serverId);
        expect(browser.getCurrent().location).toEqual({ path: 'src', kind: 'folder' });
        expect(storage.getState().sessions).toEqual({});
        await act(async () => browser.getCurrent().setLocation({ path: '', kind: 'folder' }));
        await browser.unmount();
    });
    it('shares real checkout selection with Changes and commits only through an explicit SCM action', async () => {
        storage.getState().applySettingsLocal({ experiments: true, featureToggles: { 'scm.writeOperations': true }, scmCommitStrategy: 'atomic' });
        const scope = { serverId: runtime.serverId, machineId: 'm1', rootPath: '/repo' };
        const screen = await mount('/repo', 'project_changes', { tall: true });
        await screen.pressByTestIdAsync('local-changes-files');
        expect(boundary.navigate.mock.calls.at(-1)?.[0]).toContain('/projects/wr_1/changes');
        expect(boundary.writes).toEqual([]);
        await act(async () => screen.findAllByType(ScmChangeRow)[0].props.onToggleSelection());
        expect(storage.getState().getWorkspaceScmCommitSelectionPaths(scope)).toEqual(['src/a.ts']);
        expect(boundary.writes).toEqual([]);
        await act(async () => screen.findAllByType(ScmChangeRow)[0].props.onToggleSelection());
        expect(storage.getState().getWorkspaceScmCommitSelectionPaths(scope)).toEqual([]);
        await act(async () => screen.findAllByType(ScmChangeRow)[1].props.onToggleSelection());
        const card = screen.findByType(ScmCommitComposerCard);
        await act(async () => card.props.onDraftMessageChange('My explicit message'));
        expect(boundary.writes).toEqual([]);
        await act(async () => screen.findByType(ScmCommitComposerCard).props.onCommitFromMessage('My explicit message'));
        await flushHookEffects({ cycles: 12 });
        expect(boundary.writes).toContainEqual(expect.objectContaining({ params: expect.objectContaining({
            cwd: '/repo', message: 'My explicit message', scope: { kind: 'paths', include: ['src/b.ts'] },
        }) }));
        expect(storage.getState().sessions).toEqual({});
    });
    it('offers an accepted remote checkout of this Project without mixing another Home or Project', async () => {
        const accountScope = storage.getState().profileScope;
        if (!accountScope) throw new Error('Connected fixture has no Account scope');
        const checkout = { id: 'wr_1', serverId: runtime.serverId, machineId: 'm1', rootPath: '/repo', projectKey: 'project', createdAtMs: 1 };
        storage.getState().activateProjectAccountRowsScope(accountScope);
        storage.getState().applyProjectAccountRowsForScope(accountScope, { scope: accountScope, status: 'ready', coverage: 'complete',
            workspaceRefs: [checkout, { ...checkout, id: 'remote', machineId: 'm2', rootPath: '/remote' },
                { ...checkout, id: 'unrelated', machineId: 'm2', projectKey: 'other' },
                { ...checkout, id: 'foreign', machineId: 'm2', serverId: 'foreign-home' }],
            relationships: [], organizations: [], revisionsByPhysicalKey: {} });
        const screen = await mount('/repo', 'project_checkouts');
        expect(screen.findHostByTestId('local-changes.checkout:remote')).not.toBeNull();
        expect(screen.findHostByTestId('local-changes.checkout:foreign')).toBeNull();
        expect(screen.findHostByTestId('local-changes.checkout:unrelated')).toBeNull();
        await screen.pressByTestIdAsync('local-changes.checkout:remote');
        const href = boundary.navigate.mock.calls.at(-1)?.[0];
        expect(new URL(href, 'https://app.test').pathname).toContain('/projects/remote/');
        expect(new URL(href, 'https://app.test').searchParams.get('serverId')).toBe(runtime.serverId);
        expect(storage.getState().sessions).toEqual({});
    });
    it('replaces stale route resources and Details with its pending comparison while retaining the named Project dashboard', async () => {
        const accountScope = storage.getState().profileScope;
        if (!accountScope) throw new Error('Connected fixture has no Account scope');
        storage.getState().activateProjectAccountRowsScope(accountScope);
        storage.getState().applyProjectAccountRowsForScope(accountScope, { scope: accountScope, status: 'ready', coverage: 'complete',
            workspaceRefs: [{ id: 'wr_1', serverId: runtime.serverId, machineId: 'm1', rootPath: '/repo', projectKey: 'project', createdAtMs: 1 }],
            relationships: [], organizations: [], revisionsByPhysicalKey: {} });
        boundary.pathname = '/projects/wr_1/overview';
        boundary.routeParams = { workspaceRefId: 'wr_1', serverId: runtime.serverId, layoutId: 'named-dashboard',
            initialFile: 'old.ts', initialCommit: 'old-commit', details: 'file', path: 'old.ts',
            comparison: 'branch', head: 'old-head', base: 'old-base', comparisonId: 'old-comparison', anchor: 'range', startLine: '7' };
        const screen = await mount('/repo', 'project_changes', { tall: true });
        publishActiveReviewFile(activeReviewFileKeyForWorkspace({ serverId: runtime.serverId, machineId: 'm1', rootPath: '/repo' }),
            { presented: true, activePath: 'src/a.ts' });
        await act(async () => screen.findAllByType(ScmChangeRow)[1].props.onPress());
        const url = new URL(boundary.navigate.mock.calls.at(-1)?.[0], 'https://app.test');
        const query = Object.fromEntries(url.searchParams);
        expect(query).not.toHaveProperty('initialFile');
        expect(query).not.toHaveProperty('initialCommit');
        expect(query).not.toHaveProperty('path');
        expect(query).not.toHaveProperty('head');
        expect(query).not.toHaveProperty('base');
        expect(query).not.toHaveProperty('comparisonId');
        expect(query).not.toHaveProperty('anchor');
        expect(query).not.toHaveProperty('startLine');
        expect(query).toMatchObject({ serverId: runtime.serverId, layoutId: 'named-dashboard' });
        expect(url.searchParams.getAll('details')).toEqual(['scmReview']);
        expect(readActiveReviewFile(activeReviewFileKeyForWorkspace({ serverId: runtime.serverId, machineId: 'm1', rootPath: '/repo' })).focusRequest)
            .toMatchObject({ path: 'src/b.ts', comparison: { kind: 'workingTree' } });
        expect(parseSessionPaneUrlState(query)?.details).toMatchObject({ kind: 'scmReview', comparison: { kind: 'workingTree' }, view: 'files' });
    });
    it('retires a captured review during ordinary seed preparation without writing or navigating', async () => {
        const { openWorkspaceScmAuthoringDraft } = await import('@/components/projects/scm/workspaceScmAuthoring');
        const accountScope = storage.getState().profileScope;
        if (!accountScope) throw new Error('Connected fixture has no Account scope');
        applyProjectAccountRowsFixture(storage, { workspaceRefs: [{ id: 'wr_1', serverId: runtime.serverId,
            machineId: 'm1', rootPath: '/repo', projectKey: 'project', createdAtMs: 1 }] });
        const comparison = ScmComparisonSchema.parse({ id: 'captured', source: { kind: 'workingTree' }, repository: { rootPath: '/repo' },
            endpoints: {}, inventory: { state: 'complete', files: [], reasons: [] } });
        let current = true;
        const pending = openWorkspaceScmAuthoringDraft({ scope: { serverId: runtime.serverId, machineId: 'm1', rootPath: '/repo' },
            comparison, result: null, isCurrent: () => current });
        current = false;
        expect(await pending).toEqual({ kind: 'stale', reason: 'host_retired' });
        expect(boundary.navigate).not.toHaveBeenCalled();
        expect(storage.getState().sessions).toEqual({});
    });
    it('seeds Open elsewhere from the native Checkouts body without executing or selecting a Machine', async () => {
        const screen = await mount('/repo', 'project_checkouts');
        await screen.pressByTestIdAsync('local-changes.open-elsewhere');
        // On a computer Open is the dialog over the page; its seed is the dialog's address.
        const { Modal } = await import('@/modal');
        const dialog = vi.mocked(Modal.show).mock.calls.map(([config]) => config as { chrome?: { testID?: string }; props?: { routeParams?: Record<string, string> } })
            .filter(config => config.chrome?.testID === 'projects.open.dialog').at(-1);
        const route = { params: dialog!.props!.routeParams! };
        expect(readProjectOpenRouteDraft(route.params)).toMatchObject({ serverId: runtime.serverId,
            machineId: '', source: { kind: 'workspace', workspaceId: 'wr_1' }, ref: 'main' });
        expect(storage.getState().sessions).toEqual({});
    });
    it('keeps Open elsewhere usable when the local Machine cannot read SCM, without inventing its branch', async () => {
        boundary.denied = true;
        storage.getState().updateWorkspaceScmSnapshot({ serverId: runtime.serverId, machineId: 'm1', rootPath: '/repo' }, null);
        const screen = await mount('/repo', 'project_checkouts');
        await screen.pressByTestIdAsync('local-changes.open-elsewhere');
        const { Modal } = await import('@/modal');
        const dialog = vi.mocked(Modal.show).mock.calls.map(([config]) => config as { chrome?: { testID?: string }; props?: { routeParams?: Record<string, string> } })
            .filter(config => config.chrome?.testID === 'projects.open.dialog').at(-1);
        const route = { params: dialog!.props!.routeParams! };
        expect(readProjectOpenRouteDraft(route.params)).toMatchObject({ source: { kind: 'workspace', workspaceId: 'wr_1' } });
        expect(readProjectOpenRouteDraft(route.params)).not.toHaveProperty('ref');
    });
    it.each(['/repo', '/repo/feature'])('retains the selected checkout and file when promoting %s to Changes', async rootPath => {
        const accountScope = storage.getState().profileScope;
        if (!accountScope) throw new Error('Connected fixture has no Account scope');
        storage.getState().activateProjectAccountRowsScope(accountScope);
        storage.getState().applyProjectAccountRowsForScope(accountScope, { scope: accountScope, status: 'ready', coverage: 'complete',
            workspaceRefs: [{ id: 'wr_1', serverId: runtime.serverId, machineId: 'm1', rootPath: '/repo', createdAtMs: 1 }],
            relationships: [], organizations: [], revisionsByPhysicalKey: {} });
        currentSnapshot = ScmWorkingSnapshotSchema.parse({ ...snapshot(['src/feature.ts']), repo: {
            ...snapshot([]).repo, rootPath, worktrees: [{ id: 'feature-checkout', path: '/repo/feature', branch: 'feature', isCurrent: rootPath !== '/repo' }],
        } });
        const screen = await mount(rootPath, 'project_changes', { tall: true });
        const row = screen.findByType(ScmChangeRow);
        await act(async () => row.props.onPress());
        const query = Object.fromEntries(new URL(boundary.navigate.mock.calls.at(-1)?.[0], 'https://app.test').searchParams);
        expect(query).toMatchObject({ serverId: runtime.serverId, worktreeId: rootPath === '/repo' ? '@root' : 'feature-checkout' });
        expect(query).not.toHaveProperty('initialFile');
        expect(readActiveReviewFile(activeReviewFileKeyForWorkspace({ serverId: runtime.serverId, machineId: 'm1', rootPath })).focusRequest)
            .toMatchObject({ path: 'src/feature.ts', comparison: { kind: 'workingTree' } });
        expect(query).not.toHaveProperty('activeRootPath');
        expect(storage.getState().sessions).toEqual({});
    });
    it('promotes an actual changed path to Changes without creating or requiring a Session', async () => {
        const screen = await mount('/repo', 'project_changes', { tall: true });
        const rows = screen.findAllByType(ScmChangeRow);
        expect(rows.map(row => row.props.file.fullPath)).toEqual(['src/a.ts', 'src/b.ts']);
        await act(async () => rows[1].props.onPress());
        const href = boundary.navigate.mock.calls.at(-1)?.[0];
        expect(href).toContain('/projects/wr_1/changes');
        const query = Object.fromEntries(new URL(href, 'https://app.test').searchParams);
        expect(readProjectFileRouteTarget(query)).toBeNull();
        expect(readActiveReviewFile(activeReviewFileKeyForWorkspace({ serverId: runtime.serverId, machineId: 'm1', rootPath: '/repo' })).focusRequest)
            .toMatchObject({ path: 'src/b.ts', comparison: { kind: 'workingTree' } });
        expect(storage.getState().sessions).toEqual({});
    });
    it('keeps clean and denied reads distinct and never invents rows or a Session', async () => {
        currentSnapshot = snapshot([]);
        const clean = await mount();
        expect(clean.findAllByType(ScmChangeRow)).toEqual([]);
        expect(clean.findHostByTestId('local-changes-clean')).not.toBeNull();
        expect(clean.findHostByTestId('local-changes-files')).toBeNull();
        await act(async () => clean.unmount());
        const scope = { serverId: runtime.serverId, machineId: 'm1', rootPath: '/repo' };
        storage.getState().updateWorkspaceScmSnapshot(scope, null);
        boundary.denied = true;
        const denied = await mount();
        expect(denied.findAllByType(ScmChangeRow)).toEqual([]);
        expect(denied.findHostByTestId('local-changes-clean')).toBeNull();
        expect(denied.findHostByTestId('local-changes-files')).toBeNull();
        expect(denied.findHostByTestId('local-changes-error')).not.toBeNull();
        expect(storage.getState().getWorkspaceScmSnapshotError(scope)).toMatchObject({
            errorCode: SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE, message: 'Denied',
        });
        expect(storage.getState().sessions).toEqual({});
    });
});
