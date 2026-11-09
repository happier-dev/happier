import * as React from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { buildWidgetSurfaceArtifactHeaderV1, buildWidgetSurfaceArtifactIdV1, WidgetAreaLayoutV1Schema } from '@happier-dev/protocol/widgets';
import { UserProfileSchema } from '@happier-dev/protocol/social/friends';

import { createDeferred, flushHookEffects, renderHook, renderScreen } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installSessionDetailsPanelNonRnModuleMocks } from '@/components/sessions/panes/sessionDetailsPanelNonRnModuleMocks';

installSessionDetailsPanelNonRnModuleMocks();
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
installDisconnectedServerSocketBoundary();
const [
    { createArtifactStoreBoundary },
    { installSessionPaneRuntimeTestHarness },
] = await Promise.all([
    import('@/dev/testkit/harness/artifactStoreBoundary'),
    import('@/components/sessions/panes/sessionPaneRuntimeTestHarness'),
]);

const ownerAccountId = 'dashboard-owner';
const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => ownerAccountId, encryptionMode: 'plain' });
const owner = UserProfileSchema.parse({ id: ownerAccountId, name: 'Dashboard author', firstName: 'Dashboard', lastName: 'author',
    username: 'dashboard-author', avatar: null, bio: null, status: 'none', publicKey: null });
let ownerRead: Promise<void> | null = null;
/** The Home's admitted access for the viewer: read-only by default, edit for a dashboard shared to edit. */
let viewerAccess: 'view' | 'edit' | 'admin' | 'owner' = 'view';
const ownerRequests: string[] = [];
const runtime = installSessionPaneRuntimeTestHarness({ request: async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === `/v1/user/${ownerAccountId}`) {
        ownerRequests.push(path);
        await ownerRead;
        return Response.json({ user: owner });
    }
    const stored = /^\/v1\/artifacts\/([^/]+)$/.exec(path);
    if (stored && (init?.method ?? 'GET') === 'GET') {
        const row = artifacts.read(decodeURIComponent(stored[1]!));
        // Home HTTP admission: this Account views the other Account's acknowledged document.
        // The real audience reader resolves an owner's sharing from the Home's grants route below.
        return row ? Response.json({ ...row, access: viewerAccess })
            : Response.json({}, { status: 404 });
    }
    return artifacts.handle(path, init);
} });
const { ProjectOverviewWidgets } = await import('./ProjectOverviewWidgets');
const { ProjectDashboardIdentityLine } = await import('../overview/ProjectDashboardIdentityLine');
const { storage } = await import('@/sync/domains/state/storageStore');
const { useProjectDashboardOwner } = await import('../overview/useProjectDashboardOwner');
const { createArtifactWithHeaderViaApi } = await import('@/sync/engine/artifacts/syncArtifacts');
beforeEach(() => { artifacts.clear(); ownerRead = null; viewerAccess = 'view'; ownerRequests.length = 0; storage.setState({ users: {}, friends: {} }); });

it('keeps cached owner identity stable across unrelated people updates and never reads another Home’s cache', async () => {
    storage.getState().applyFriends([owner]);
    const hook = await renderHook(() => useProjectDashboardOwner(runtime.serverId, ownerAccountId));
    try {
        expect(hook.getCurrent()).toMatchObject({ accountId: ownerAccountId, displayName: 'Dashboard author' });
        const admitted = hook.getCurrent();
        storage.getState().applyUsers({ unrelated: { ...owner, id: 'unrelated', name: 'Another person' } });
        await flushHookEffects();
        expect(hook.getCurrent()).toBe(admitted);
        storage.setState(state => ({ profile: { ...state.profile, name: 'Viewer renamed' } }));
        await flushHookEffects();
        expect(hook.getCurrent()).toBe(admitted);
        expect(ownerRequests).toEqual([]);
    } finally { await hook.unmount(); }
    const otherHome = await renderHook(() => useProjectDashboardOwner('other-home', ownerAccountId));
    try {
        expect(otherHome.getCurrent()).toBeNull();
        expect(ownerRequests).toEqual([]);
    } finally { await otherHome.unmount(); }
});

it('does not publish a late owner lookup after the requesting Account retires', async () => {
    const pending = createDeferred<void>();
    ownerRead = pending.promise;
    const hook = await renderHook(() => useProjectDashboardOwner(runtime.serverId, ownerAccountId));
    try {
        await vi.waitFor(() => expect(ownerRequests).toHaveLength(1));
        storage.setState({ profileScope: { serverId: runtime.serverId, accountId: 'other-account' } });
        await hook.unmount();
        pending.resolve();
        await pending.promise;
        await flushHookEffects();
        expect(storage.getState().users[ownerAccountId]).toBeUndefined();
    } finally { pending.resolve(); }
});

/** The recipient's view of the owner's shared dashboard: exact stored bytes, read-only access, no widgets placed. */
async function renderViewedEmptyDashboard() {
    const surface = { serverId: runtime.serverId, accountId: ownerAccountId,
        owner: { kind: 'project' as const, projectId: 'project-key', layoutId: 'release' } };
    const artifactId = buildWidgetSurfaceArtifactIdV1(surface);
    const layout = WidgetAreaLayoutV1Schema.parse({ v: 1, surface, name: 'Release', items: [] });
    // The owner's ordinary writer produces the stored envelopes; the viewer opens its exact bytes.
    await createArtifactWithHeaderViaApi({ artifactId, serverId: runtime.serverId,
        credentials: { token: `header.${Buffer.from(JSON.stringify({ sub: ownerAccountId })).toString('base64url')}.signature` },
        request: async (path, init) => path === '/v1/account/encryption' ? Response.json({ mode: 'plain', updatedAt: 1 })
            : await artifacts.handle(path, init) ?? Response.json({}, { status: 404 }),
        header: buildWidgetSurfaceArtifactHeaderV1(layout), body: JSON.stringify(layout), encryption: null,
        artifactDataKeys: new Map(), addArtifact: () => {},
    });
    expect(artifacts.readPlainBody(artifactId)).toBe(JSON.stringify(layout));
    if (viewerAccess === 'owner') artifacts.seedAccountGrant(artifactId, 'dashboard-recipient', 'view');
    return await renderScreen(<runtime.Wrapper><ProjectOverviewWidgets
        workspaceRef={{ id: 'w1', serverId: runtime.serverId, machineId: 'm1', rootPath: '/repo', createdAtMs: 1, projectKey: 'project-key' }}
        activeRootPath="/repo" projectName="happier" layoutId="release" artifactId={artifactId} ownerAccountId={ownerAccountId}
        onSelectDashboard={() => {}} bar={<React.Fragment />}
    /></runtime.Wrapper>);
}

it('supplies the admitted shared dashboard owner’s meaningful profile to the identity line', async () => {
    const screen = await renderViewedEmptyDashboard();
    try {
        await vi.waitFor(() => expect(screen.findAllByType(ProjectDashboardIdentityLine), screen.getTextContent()).toHaveLength(1));
        // The admitted document title/access remain distinct from safe owner display facts.
        expect(screen.findAllByType(ProjectDashboardIdentityLine)[0]!.props).toMatchObject({ title: 'Release' });
        await vi.waitFor(() => expect(screen.findAllByType(ProjectDashboardIdentityLine)[0]!.props.owner).toMatchObject({
            accountId: ownerAccountId, displayName: 'Dashboard author',
        }));
        expect(storage.getState().users[ownerAccountId]).toMatchObject({ id: ownerAccountId, name: 'Dashboard author' });
        // The line names whose dashboard it is in words, not only by an avatar keyed on an opaque id.
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('Dashboard author'));
        expect(artifacts.list()).toHaveLength(1);
    } finally { await screen.unmount(); }
});

it('says the owner’s own shared dashboard is theirs and shared, never another person’s editable copy', async () => {
    await runtime.restoreRealm({ accountId: ownerAccountId });
    viewerAccess = 'owner';
    const screen = await renderViewedEmptyDashboard();
    try {
        await vi.waitFor(() => expect(screen.findAllByType(ProjectDashboardIdentityLine)).toHaveLength(1));
        const line = screen.findAllByType(ProjectDashboardIdentityLine)[0]!.props;
        expect(line).toMatchObject({ title: 'Release', detail: 'projects.dashboard.sharedLine' });
        expect(line.owner).toMatchObject({ accountId: ownerAccountId, displayName: 'projects.dashboard.you' });
        expect(screen.getTextContent()).not.toContain('shareSheet.documents.levels.canEdit');
    } finally { await screen.unmount(); }
});

it('names an administrator’s access as Admin, not Can edit', async () => {
    viewerAccess = 'admin';
    const screen = await renderViewedEmptyDashboard();
    try {
        await vi.waitFor(() => expect(screen.findAllByType(ProjectDashboardIdentityLine)).toHaveLength(1));
        expect(screen.findAllByType(ProjectDashboardIdentityLine)[0]!.props.detail).toBe('shareSheet.documents.levels.admin');
    } finally { await screen.unmount(); }
});

it('draws no empty side area for a read-only viewer of a shared dashboard, and still says the dashboard is empty once', async () => {
    const screen = await renderViewedEmptyDashboard();
    try {
        await vi.waitFor(() => expect(screen.findAllByType(ProjectDashboardIdentityLine)).toHaveLength(1));
        await vi.waitFor(() => expect(screen.findByTestId('project-overview-main.empty')).not.toBeNull());
        expect(screen.findByTestId('project-overview.aside')).toBeNull();
        expect(screen.findByTestId('project-overview-aside.empty')).toBeNull();
    } finally { await screen.unmount(); }
});

it('says an empty dashboard is empty once, in the main area, while an editor keeps both areas to add to', async () => {
    viewerAccess = 'edit';
    const screen = await renderViewedEmptyDashboard();
    try {
        await vi.waitFor(() => expect(screen.findByTestId('project-overview-main.empty')).not.toBeNull());
        await vi.waitFor(() => expect(screen.findAllByTestId('project-overview-main.add').length).toBeGreaterThan(0));

        expect(screen.findByTestId('project-overview-aside.empty')).toBeNull();
        expect(screen.getTextContent().split('projects.widgets.emptyArea')).toHaveLength(2);
    } finally { await screen.unmount(); }
});
