import * as React from 'react';
import * as ReactNative from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, onTestFailed, vi } from 'vitest';
import { createDeferred, flushHookEffects, invokeTestInstanceHandler, pressTestInstanceAsync, renderHook, renderScreen } from '@/dev/testkit';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { chooseDropdownMenuItem } from '@/dev/testkit/harness/dropdownMenuHarness';
import { createArtifactListHttpResponse, createArtifactStoreBoundary, createPlainArtifactHttpFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { ArtifactQuotaExceededError } from '@/sync/api/artifacts/apiArtifacts';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getStorage } from '@/sync/domains/state/storage';
import { useArtifactStorageUsage } from './artifactActionsClient';
import { useArtifactOperations } from './useArtifactOperations';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { Modal } from '@/modal';
import { router } from 'expo-router';
import { ActionsSettingsV1Schema} from '@happier-dev/protocol/actions/actionSettings';
import { ApprovalRequestSchema} from '@happier-dev/protocol/approvals/approvalRequestV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import type { ReactTestInstance } from 'react-test-renderer';
import { buildWidgetSurfaceArtifactIdV1, buildWidgetSurfaceArtifactHeaderV1 } from '@happier-dev/protocol/widgets';
import { createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1,
    DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, DEPLOYMENT_DOMAIN_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/artifacts/deploymentArtifactKindsV1';
import { WIDGET_SURFACE_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/widgets';
import { BotTemplateArtifactV1Schema, projectBotTemplateArtifactHeaderV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit');
    return createExpoRouterMock().module;
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit');
    return createModalModuleMock().module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit');
    return createTextModuleMock();
});

import { ArtifactsBrowser, ArtifactsBrowserScreen } from './ArtifactsBrowserScreen';
import { sealArtifactPrivateRevisionMetadata } from '@/sync/domains/artifacts/accountArtifactEnvelope';
import { ArtifactView } from './ArtifactView';
import { NavigationTitleChromeProvider } from '@/components/ui/layout/navigationTitleChrome';
import { DestinationInstanceContext } from '@/components/appShell/workspace/destinationInstanceContext';

// Keep the lazy executable graph's first load outside the operation's behavior deadline.
await import('@/sync/ops/actions/defaultActionExecutor');

const initialState = getStorage().getState();
let disposeHome: (() => Promise<void>) | undefined;
afterEach(async () => {
    await act(async () => {
        await disposeHome?.();
        disposeHome = undefined;
        retireActiveServerAccountScopeLifetime();
        invalidateAccountEncryptionModeCache();
        getStorage().setState(initialState, true);
    });
    vi.restoreAllMocks();
});

function MeterBrowser() {
    const usage = useArtifactStorageUsage();
    const artifacts = getStorage()((state) => state.artifacts);
    return <ArtifactsBrowser artifacts={Object.values(artifacts)} loaded loadFailed={false} onRetry={() => {}} usage={usage} />;
}

function RecoveryBrowser({ loadFailed, onRetry, artifacts = [] }: Readonly<{
    loadFailed: boolean; onRetry: () => void; artifacts?: readonly DecryptedArtifact[];
}>) {
    return <AppPaneProvider><ArtifactsBrowser artifacts={artifacts} loaded loadFailed={loadFailed} onRetry={onRetry} usage={null} /></AppPaneProvider>;
}

function artifactFixture(id: string, extra: Partial<Extract<DecryptedArtifact, { isDecrypted: true }>> = {}): DecryptedArtifact {
    return { id, title: 'Notes', isDecrypted: true, header: { title: 'Notes' }, headerVersion: 1,
        bodyVersion: 2, seq: 1, body: 'Notes', createdAt: 1, updatedAt: 1,
        access: 'owner', storageMode: 'plain', ...extra };
}

async function renderRows(artifacts: readonly DecryptedArtifact[]) {
    const screen = await renderScreen(<RecoveryBrowser artifacts={artifacts} loadFailed={false} onRetry={() => {}} />);
    await act(async () => { invokeTestInstanceHandler(screen.findHostByTestId('artifacts:collection:stage'), 'onLayout', {
        nativeEvent: { layout: { x: 0, y: 0, width: 1200, height: 800 } },
    }); });
    return screen;
}

function rowMenu(screen: Awaited<ReturnType<typeof renderRows>>, id: string): ReactTestInstance {
    // Drive the real Collection row-action contract; its menu presentation is shared across surfaces.
    const row = screen.findAll(node => node.props.testID === `artifacts:row:${id}`
        && Array.isArray(node.props.secondaryActions)).at(-1);
    expect(row).toBeDefined();
    return row!;
}

describe('Artifacts browser folders view', () => {
    it('deletes a dashboard opened directly, announces success and replaces its destination with Artifacts', async () => {
        let artifact: DecryptedArtifact | undefined;
        let deleted = false;
        const deleting = createDeferred<void>();
        const acknowledge = createDeferred<void>();
        const served = await serveActionHomes({ homes: [{ key: 'owner', serverUrl: 'https://dashboard-delete-navigation.test', accountId: 'owner' }],
            route: async request => {
                if (request.path === '/v1/public-shares') return Response.json({ publicShares: [] });
                if (artifact && request.path === `/v1/artifacts/${artifact.id}/access/grants`)
                    return Response.json({ artifactId: artifact.id, ownerAccountId: 'owner', access: 'owner', grants: [] });
                if (artifact?.isDecrypted === true && request.path === `/v1/artifacts/${artifact.id}` && request.method === 'GET')
                    return deleted ? Response.json({ error: 'not_found' }, { status: 404 }) : Response.json(createPlainArtifactHttpFixture(artifact, 'owner'));
                if (artifact && request.path === `/v1/artifacts/${artifact.id}/revision/1/2` && request.method === 'DELETE') {
                    deleted = true;
                    deleting.resolve();
                    await acknowledge.promise;
                    return Response.json({ success: true });
                }
                return undefined;
            } });
        disposeHome = served.dispose;
        const surface = { serverId: served.homes.owner!.id, accountId: 'owner',
            owner: { kind: 'project' as const, projectId: 'project', layoutId: 'notes' } };
        const layout = { v: 1 as const, surface, name: 'Notes', items: [] };
        artifact = artifactFixture(buildWidgetSurfaceArtifactIdV1(surface), {
            header: buildWidgetSurfaceArtifactHeaderV1(layout), body: JSON.stringify(layout), ownerAccountId: 'owner',
        });
        getStorage().getState().addArtifact(artifact);
        const { createWorkspaceState, createWorkspaceEmptyTab, reduceWorkspaceState } = await import('@/components/appShell/workspace/workspaceState');
        const { createWorkspaceNavigationAdapter } = await import('@/components/appShell/workspace/workspaceNavigationAdapter');
        const { resolveCompactAppDestinations, resolveDestinationRefFromHref } = await import('@/components/appShell/destinations/compactAppDestinationCatalog');
        const { readPresentationNotice, retirePresentationNotice } = await import('@/components/sessions/presentation/presentationNotices');
        const catalog = resolveCompactAppDestinations({ builtins: { externalSessions: false, inbox: true, workflows: true, friends: false }, pages: [] });
        const path = `/artifacts/${artifact.id}`;
        const target = resolveDestinationRefFromHref(catalog, path)!;
        let workspace = createWorkspaceState({ ...createWorkspaceEmptyTab('artifact'), target });
        const navigation = createWorkspaceNavigationAdapter({ getState: () => workspace, getCatalog: () => catalog,
            dispatch: action => { workspace = reduceWorkspaceState(workspace, action); },
            transport: { commit: () => {} }, createId: () => 'unexpected-tab', onChange: () => {} });
        const artifactId = artifact.id;
        function OpenedArtifact() {
            const opened = getStorage()(state => state.artifacts[artifactId] ?? null);
            return <ArtifactView artifactId={artifactId} artifact={opened} presentation="page" />;
        }
        const screen = await renderScreen(
            <DestinationInstanceContext.Provider value={{ tabId: 'artifact', ref: target, pathname: path, visible: true,
                focused: true, isFocused: () => true, navigation: {
                    push: href => { navigation.openHref(String(href)); }, back: () => { navigation.step(-1); },
                    replace: href => { navigation.openHref(String(href), { replace: true, tabId: 'artifact' }); },
                } }}><OpenedArtifact /></DestinationInstanceContext.Provider>);
        try {
            retirePresentationNotice();
            vi.mocked(Modal.confirm).mockResolvedValueOnce(true);
            const { PageHeaderMenu } = await import('@/components/ui/layout/PageHeaderEntityParts');
            const menu = screen.findAllByType(PageHeaderMenu).find(node => node.props.actions.some((action: { id: string }) => action.id === 'delete'))!;
            let operation: Promise<void> | undefined;
            await act(async () => {
                operation = menu.props.actions.find((action: { id: string }) => action.id === 'delete').onSelect({});
                await deleting.promise;
            });
            // The network's removal publication can arrive before its Action reply. Flush that real store transition.
            await act(async () => { getStorage().getState().deleteArtifact(artifactId); });
            expect(screen.findByTestId('artifact:actions')).toBeNull();
            await act(async () => { acknowledge.resolve(); await operation; });
            expect(served.requests.filter(request => request.method === 'DELETE')).toHaveLength(1);
            expect(workspace.tabs.artifact?.target).toEqual(resolveDestinationRefFromHref(catalog, '/artifacts'));
            expect(readPresentationNotice()).toMatchObject({ key: `dashboard-deleted:${artifact.id}`, severity: 'info',
                message: 'projects.dashboard.deleted(name=Notes)' });
        } finally { acknowledge.resolve(); await screen.unmount(); }
    });

    it.each([{ referenced: true, headerOnly: false }, { referenced: false, headerOnly: false }, { referenced: false, headerOnly: true }])
        ('routes Overview deletion through its owner with the existing acknowledgement (%j)', async ({ referenced, headerOnly }) => {
        let artifact: DecryptedArtifact | undefined;
        let surface = { serverId: 'home', accountId: 'owner', owner: { kind: 'project' as const, projectId: 'project' } };
        const served = await serveActionHomes({ homes: [{ key: 'owner', serverUrl: 'https://artifact-overview-delete.test', accountId: 'owner' }],
            route: request => {
                if (request.path === '/v1/public-shares') return Response.json({ publicShares: [] });
                if (request.path === '/v1/account/project-rows/list') return Response.json(createPlainProjectAccountRowListFixture({
                    workspaceRefs: referenced ? [{ id: 'checkout', projectKey: 'project', serverId: surface.serverId,
                        machineId: 'machine', rootPath: '/repo', createdAtMs: 1 }] : [],
                }));
                if (artifact && request.path === `/v1/artifacts/${artifact.id}/access/grants`)
                    return Response.json({ artifactId: artifact.id, ownerAccountId: 'owner', access: 'owner', grants: [] });
                if (artifact?.isDecrypted === true && request.path === `/v1/artifacts/${artifact.id}` && request.method === 'GET')
                    return Response.json(createPlainArtifactHttpFixture(artifact, 'owner'));
                if (artifact && request.path === `/v1/artifacts/${artifact.id}/revision/1/2` && request.method === 'DELETE')
                    return Response.json({ success: true });
                return undefined;
            } });
        disposeHome = served.dispose;
        surface = { ...surface, serverId: served.homes.owner!.id };
        const layout = { v: 1 as const, surface, items: [] };
        artifact = artifactFixture(buildWidgetSurfaceArtifactIdV1(surface), {
            header: buildWidgetSurfaceArtifactHeaderV1(layout), body: JSON.stringify(layout),
        });
        getStorage().getState().addArtifact(artifact);
        let deleted = false;
        const opened = artifact;
        const hook = await renderHook(() => useArtifactOperations(headerOnly ? { ...opened, body: undefined } : opened, () => { deleted = true; }));
        await act(async () => { await hook.getCurrent().remove(); });
        expect(served.requests.filter(request => request.method === 'DELETE')).toEqual([]);
        vi.mocked(Modal.confirm).mockClear().mockResolvedValue(true);
        vi.mocked(Modal.alert).mockClear();
        await act(async () => { await hook.getCurrent().remove(); });
        expect(deleted, JSON.stringify({ alerts: vi.mocked(Modal.alert).mock.calls,
            paths: served.requests.map(request => `${request.method} ${request.path}`) })).toBe(!referenced);
        expect(served.requests.filter(request => request.method === 'DELETE')).toHaveLength(referenced ? 0 : 1);
        if (referenced) {
            // A protected default is never offered a confirmation it would refuse: its reason, under its name.
            expect(Modal.confirm).not.toHaveBeenCalled();
            expect(Modal.alert).toHaveBeenCalledTimes(1);
            expect(Modal.alert).toHaveBeenLastCalledWith('Notes', 'projects.dashboard.defaultProtected');
        } else {
            expect(Modal.confirm).toHaveBeenCalledTimes(1);
            // A dashboard is confirmed as a dashboard, by name, not as an "artifact".
            expect(vi.mocked(Modal.confirm).mock.calls[0]?.slice(0, 2)).toEqual(['projects.dashboard.deleteConfirmTitle(name=Notes)', 'projects.dashboard.deleteConfirmBody']);
            expect(Modal.alert).not.toHaveBeenCalled();
        }
        await hook.unmount();
    });

    it('shares the declared device view preference with agent Actions and retains it after reopening', async () => {
        const served = await serveActionHomes({
            homes: [{ key: 'owner', serverUrl: 'https://artifact-view-preference.test', accountId: 'owner' }],
            route: () => undefined,
        });
        disposeHome = served.dispose;
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const action = createDefaultActionExecutor();
        const context = { surface: 'agent' as const, serverId: served.homes.owner!.id };
        const anchor = 'appearance.artifactsView';
        await act(async () => {
            const result = await action.execute('settings.set', { anchor, value: { presentation: 'folders' } }, context);
            expect(result.ok ? 'ok' : result.errorCode).toBe('ok');
        });
        const screen = await renderScreen(<RecoveryBrowser artifacts={[artifactFixture('document')]} loadFailed={false} onRetry={() => {}} />);
        expect(screen.findByTestId('artifacts:folders:row:artifact:document')).not.toBeNull();
        await screen.pressByTestIdAsync('artifacts:view:list');
        await vi.waitFor(async () => {
            expect(await action.execute('settings.get', { anchor }, context))
                .toMatchObject({ ok: true, result: { value: { presentation: 'list' } } });
        });
        await screen.unmount();
        const reopened = await renderRows([artifactFixture('document')]);
        expect(reopened.findByTestId('artifacts:folders:row:artifact:document')).toBeNull();
        expect(rowMenu(reopened, 'document').props.secondaryActions).toBeDefined();
        await reopened.unmount();
    });

    it('shows the same library as one tree and keeps the row operations of the list', async () => {
        const served = await serveActionHomes({
            homes: [{ key: 'owner', serverUrl: 'https://artifact-folder-view.test', accountId: 'owner' }],
            route: () => undefined,
        });
        disposeHome = served.dispose;
        const document = artifactFixture('document');
        const board = artifactFixture('board', { title: 'Launch', header: { v: 1, kind: 'work-board.v1', title: 'Launch',
            pinnedInSessions: false, readsNeedsYou: false }, body: undefined, bodyVersion: undefined });
        const screen = await renderRows([document, board]);
        expect(screen.findByTestId('artifacts:folders:row:artifact:document')).toBeNull();
        await screen.pressByTestIdAsync('artifacts:view:folders');
        await vi.waitFor(() => expect(screen.findByTestId('artifacts:folders:row:artifact:document')).not.toBeNull());
        expect(screen.findByTestId('artifacts:folders:row:artifact:board')).not.toBeNull();
        // The Collection's cards and rows are replaced, never drawn beside the tree.
        expect(screen.findAll(node => node.props.testID === 'artifacts:row:document' && Array.isArray(node.props.secondaryActions))).toHaveLength(0);
        const menu = screen.findAll(node => node.props.testID === 'artifacts:folders:menu:artifact:board' && typeof node.props.onSelect === 'function').at(0);
        expect(menu?.props.items.map((item: { id: string }) => item.id)).toEqual(expect.arrayContaining(['open', 'history']));
        // Opening a kind with its own destination leaves the browser for it.
        vi.mocked(router.push).mockClear();
        await act(async () => { menu?.props.onSelect('open'); });
        expect(router.push).toHaveBeenCalledTimes(1);
        // Without an admitted folder catalog nothing can be filed: no New folder, no Move.
        expect(screen.findByTestId('artifacts:folders:new')?.props.disabled).toBe(true);
        expect(menu?.props.items.some((item: { id: string }) => item.id === 'move')).toBe(false);
    });
});

describe('Artifacts browser row operations', () => {
    it.each(['work-board.v1', 'prompt_doc.v2'])('opens Share from a cold owner %s row without opening its body', async kind => {
        const served = await serveActionHomes({
            homes: [{ key: 'owner', serverUrl: 'https://artifact-cold-share.test', accountId: 'owner' }],
            route: () => undefined,
        });
        disposeHome = served.dispose;
        const artifact = artifactFixture('cold-document', { header: { v: 1, kind, title: 'Cold document',
            ...(kind === 'work-board.v1' ? { pinnedInSessions: false, readsNeedsYou: false } : {}) },
            body: undefined, bodyVersion: undefined });
        const screen = await renderRows([artifact]);
        const menu = rowMenu(screen, artifact.id);
        expect(menu.props.secondaryActions.map((item: { id: string }) => item.id)).toContain('share');
        expect(screen.findHostByTestId(`artifacts:row:${artifact.id}:previewBody`)).not.toBeNull();
        const target = { measureInWindow: () => {} };
        await act(async () => { menu.props.onSecondaryAction('share', { anchorRef: { current: target } }); });
        expect(Modal.show).toHaveBeenLastCalledWith(expect.objectContaining({
            props: expect.objectContaining({ artifactId: artifact.id, kind }),
            chrome: expect.objectContaining({ testID: 'document-share-modal', anchor: { kind: 'view', ref: { current: target } } }),
        }));
        expect(served.requests.filter(request => request.path.startsWith('/v1/artifacts/'))).toEqual([]);
        expect(screen.root.findAllByType(ArtifactView)).toHaveLength(0);
    });

    it.each([
        { access: undefined, kind: 'markdown' },
        { access: 'view' as const, kind: 'prompt_doc.v2' },
        { access: 'edit' as const, kind: 'work-board.v1' },
        { access: 'owner' as const, kind: 'home-hub-layout.v1' },
        { access: 'owner' as const, kind: 'approval_request.v1' },
        { access: 'owner' as const, kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1 },
        { access: 'owner' as const, kind: DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1 },
        { access: 'owner' as const, kind: DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1 },
        { access: 'owner' as const, kind: DEPLOYMENT_DOMAIN_ARTIFACT_KIND_V1 },
        { access: 'owner' as const, kind: 'bot_template.v1' },
    ])('does not offer Share without positive managing access or when the kind denies it (%j)', async ({ access, kind }) => {
        const artifact = artifactFixture('denied', { access, header: { kind, title: 'Denied' }, body: undefined });
        const hook = await renderHook(() => useArtifactOperations(artifact, () => {}));
        expect(hook.getCurrent().canShare).toBe(false);
        vi.mocked(Modal.show).mockClear();
        await act(async () => { hook.getCurrent().share(); });
        expect(Modal.show).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('keeps Share available to the owner of a valid released template', async () => {
        const released = BotTemplateArtifactV1Schema.parse({ v: 1, state: 'released', release: {
            v: 1, version: '1.0.0', releasedAtMs: 1, changelog: '', content: { v: 1,
                identity: { name: 'Garden', description: '', madeFromName: 'Garden Bot' },
                instructions: { markdown: 'Explain the tradeoffs.' }, memoryRules: [], skills: [],
                needs: { software: [], connectedAccounts: [], mcpServers: [] } },
        } });
        const artifact = artifactFixture('template', { access: 'owner',
            header: projectBotTemplateArtifactHeaderV1(released), body: JSON.stringify(released) });
        const hook = await renderHook(() => useArtifactOperations(artifact, () => {}));
        expect(hook.getCurrent().canShare).toBe(true);
        vi.mocked(Modal.show).mockClear();
        await act(async () => { hook.getCurrent().share(); });
        expect(Modal.show).toHaveBeenCalledWith(expect.objectContaining({
            props: expect.objectContaining({ artifactId: artifact.id, kind: artifact.header?.kind }),
        }));
        await hook.unmount();
    });

    it('keeps Share available to an owner of an unlisted dashboard', async () => {
        const artifact = artifactFixture('dashboard', { access: 'owner',
            header: { kind: WIDGET_SURFACE_ARTIFACT_KIND_V1, title: 'Release' }, body: undefined });
        const hook = await renderHook(() => useArtifactOperations(artifact, () => {}));
        expect(hook.getCurrent().canShare).toBe(true);
        vi.mocked(Modal.show).mockClear();
        await act(async () => { hook.getCurrent().share(); });
        expect(Modal.show).toHaveBeenCalledWith(expect.objectContaining({
            props: expect.objectContaining({ artifactId: artifact.id, kind: WIDGET_SURFACE_ARTIFACT_KIND_V1 }),
        }));
        await hook.unmount();
    });

    it('opens the shared Share and History owners and confirms revision-qualified deletion', async () => {
        const artifact = artifactFixture('document');
        const served = await serveActionHomes({ homes: [{ key: 'owner', serverUrl: 'https://artifact-row.test', accountId: 'owner' }],
            route: request => {
                // Generic mutations admit the actual current document through artifact.get first.
                if (request.path === '/v1/artifacts/document' && request.method === 'GET')
                    return Response.json({ ...artifact, ownerAccountId: 'owner', encryptionMode: 'plain',
                        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                        header: encodePlainArtifactStoredContent(artifact.header),
                        body: encodePlainArtifactStoredContent({ body: artifact.body }) });
                if (request.path === '/v1/artifacts/document/revision/1/2' && request.method === 'DELETE')
                    return Response.json({ success: true });
                return undefined;
            } });
        disposeHome = served.dispose;
        getStorage().getState().addArtifact(artifact);
        getStorage().setState(state => ({ localSettings: { ...state.localSettings, uiMultiPanePanelsEnabled: false } }));
        const screen = await renderRows([artifact]);
        const menu = rowMenu(screen, artifact.id);
        expect(menu.props.secondaryActions.map((item: { id: string }) => item.id)).toEqual(['open', 'share', 'history', 'delete']);
        await act(async () => { invokeTestInstanceHandler(menu, 'onSecondaryAction', 'open'); });
        expect(router.push).toHaveBeenLastCalledWith('/artifacts/document');
        await act(async () => { invokeTestInstanceHandler(menu, 'onSecondaryAction', 'share'); });
        expect(Modal.show).toHaveBeenLastCalledWith(expect.objectContaining({ props: expect.objectContaining({ artifactId: artifact.id }),
            chrome: expect.objectContaining({ testID: 'document-share-modal' }) }));
        await act(async () => { invokeTestInstanceHandler(menu, 'onSecondaryAction', 'history'); });
        expect(Modal.show).toHaveBeenLastCalledWith(expect.objectContaining({ props: {
            artifactId: artifact.id, canRestore: true, currentArtifact: artifact,
            client: expect.objectContaining({ scope: { serverId: served.homes.owner!.id, accountId: 'owner' } }),
        },
            chrome: expect.objectContaining({ testID: 'artifact-history-modal' }) }));
        await act(async () => { await menu.props.onSecondaryAction('delete'); });
        expect(served.requests.filter(request => request.method === 'DELETE')).toEqual([]);
        expect(getStorage().getState().artifacts[artifact.id]).toBeDefined();
        vi.mocked(Modal.confirm).mockClear().mockResolvedValue(true);
        await act(async () => { await menu.props.onSecondaryAction('delete'); });
        await flushHookEffects();
        expect(Modal.confirm).toHaveBeenCalledTimes(1);
        expect(served.requests.find(request => request.method === 'DELETE')?.path)
            .toBe('/v1/artifacts/document/revision/1/2');
        expect(getStorage().getState().artifacts[artifact.id]).toBeUndefined();
    });

    it('opens a shared Workflow in its destination and keeps mutation operations unavailable', async () => {
        const artifact = artifactFixture('workflow-1', { access: 'view', header: { kind: 'workflow-definition.v1', title: 'Review' } });
        const served = await serveActionHomes({ homes: [{ key: 'viewer', serverUrl: 'https://artifact-history-viewer.test', accountId: 'viewer' }],
            route: () => undefined });
        disposeHome = served.dispose;
        getStorage().getState().addArtifact(artifact);
        const screen = await renderRows([artifact]);
        const menu = rowMenu(screen, artifact.id);
        expect(menu.props.secondaryActions.map((item: { id: string }) => item.id)).toEqual(['open', 'history']);
        await act(async () => { invokeTestInstanceHandler(menu, 'onSecondaryAction', 'open'); });
        expect(router.push).toHaveBeenLastCalledWith('/workflows/workflow-1');
        await act(async () => { invokeTestInstanceHandler(menu, 'onSecondaryAction', 'history'); });
        expect(Modal.show).toHaveBeenLastCalledWith(expect.objectContaining({ props: {
            artifactId: artifact.id, canRestore: false, currentArtifact: artifact,
            client: expect.objectContaining({ scope: { serverId: served.homes.viewer!.id, accountId: 'viewer' } }),
        } }));
    });

    it('allows a shared editor to restore history without managing shares or deleting', async () => {
        const artifact = artifactFixture('editable', { access: 'edit' });
        const served = await serveActionHomes({ homes: [{ key: 'editor', serverUrl: 'https://artifact-history-editor.test', accountId: 'editor' }],
            route: () => undefined });
        disposeHome = served.dispose;
        getStorage().getState().addArtifact(artifact);
        const screen = await renderRows([artifact]);
        const menu = rowMenu(screen, artifact.id);
        expect(menu.props.secondaryActions.map((item: { id: string }) => item.id)).toEqual(['open', 'history']);
        await act(async () => { invokeTestInstanceHandler(menu, 'onSecondaryAction', 'history'); });
        expect(Modal.show).toHaveBeenLastCalledWith(expect.objectContaining({ props: {
            artifactId: artifact.id, canRestore: true, currentArtifact: artifact,
            client: expect.objectContaining({ scope: { serverId: served.homes.editor!.id, accountId: 'editor' } }),
        } }));
    });

    it('retains the same explicit-Ask delete approval inline without navigating or claiming deletion', async () => {
        const artifact = artifactFixture('approval-document');
        const persisted = createArtifactStoreBoundary({ ownerAccountId: () => 'owner', encryptionMode: 'plain' });
        // The full inventory and exact read must describe the same persisted document.
        persisted.replaceStoredRow({ id: artifact.id, ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain',
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, header: encodePlainArtifactStoredContent(artifact.header),
            body: encodePlainArtifactStoredContent({ body: artifact.body }), headerVersion: artifact.headerVersion,
            bodyVersion: artifact.bodyVersion, seq: artifact.seq, createdAt: artifact.createdAt, updatedAt: artifact.updatedAt });
        const actionsSettingsV1 = ActionsSettingsV1Schema.parse({ v: 1, actions: {
            'artifact.delete': { approvalRequiredSurfaces: ['ui'] },
        } });
        const served = await serveActionHomes({ homes: [{ key: 'owner', serverUrl: 'https://artifact-row-approval.test',
            accountId: 'owner', currentAccount: true, settings: { actionsSettingsV1 } }],
            route: request => persisted.handle(request.path, { method: request.method, body: JSON.stringify(request.body) }) ?? undefined });
        disposeHome = served.dispose;
        getStorage().getState().addArtifact(artifact);
        // The mounted Account Settings record, not its eventual background HTTP read, owns this preference.
        served.replaceAccountSettings('owner', { settings: { actionsSettingsV1 }, version: 1 });
        getStorage().getState().applySettings({ ...getStorage().getState().settings, actionsSettingsV1 }, 1);
        const onDeleted = vi.fn();
        onTestFailed(() => console.error('Artifact delete boundaries', {
            requests: served.requests.map(request => [request.method, request.path]),
            alerts: vi.mocked(Modal.alert).mock.calls,
        }));
        const hook = await renderHook(() => useArtifactOperations(artifact, onDeleted));
        vi.mocked(Modal.confirm).mockClear().mockResolvedValueOnce(true);
        vi.mocked(router.push).mockClear();
        let removal: Promise<void> | undefined;
        await act(async () => { removal = hook.getCurrent().remove(); });
        try {
        await waitForHomeGovernance(() => expect(persisted.list().find(row => row.id !== artifact.id)).toBeDefined());
        expect(Modal.confirm).toHaveBeenCalledTimes(1);
        const approval = persisted.list().find(row => row.id !== artifact.id);
        expect(approval).toBeDefined();
        expect(ApprovalRequestSchema.parse(JSON.parse(persisted.readPlainBody(approval!.id)!)))
            .toMatchObject({ actionId: 'artifact.delete', status: 'open' });
        expect(served.requests.filter(request => request.method === 'DELETE')).toEqual([]);
        expect(getStorage().getState().artifacts[artifact.id]).toBeDefined();
        expect(router.push).not.toHaveBeenCalled();
        await waitForHomeGovernance(() => expect(hook.getCurrent().approval.approvalId).toBe(approval!.id));
        expect(hook.getCurrent()).toMatchObject({ approval: {
            approvalId: approval!.id, approvalPending: true, openApproval: expect.any(Function),
        } });
        expect(onDeleted).not.toHaveBeenCalled();
        } finally {
            await hook.unmount();
            await removal;
        }
        expect(Modal.alert).not.toHaveBeenCalled();
    });

});

describe('Artifacts browser recovery', () => {
    it('demands attribution while mounted, refreshes newer background revisions and releases the read on unmount', async () => {
        const id = '11111111-1111-4111-8111-111111111111';
        const persisted = createArtifactStoreBoundary({ ownerAccountId: () => 'owner', encryptionMode: 'plain' });
        const version = async (revision: number) => ({ id, ownerAccountId: 'owner', access: 'owner' as const,
            encryptionMode: 'plain' as const, dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            header: encodePlainArtifactStoredContent({ title: 'Attributed document', kind: 'markdown' }),
            body: encodePlainArtifactStoredContent({ body: 'Unopened content' }), headerVersion: revision, bodyVersion: revision,
            provenance: await sealArtifactPrivateRevisionMetadata({ mode: 'plain', artifactId: id, bodyVersion: revision,
                provenance: { savedBy: { kind: 'agent', accountId: 'owner', sessionId: `author-${revision}` } } }),
            seq: revision, createdAt: 1, updatedAt: revision });
        persisted.replaceStoredRow(await version(1));
        const served = await serveActionHomes({ homes: [{ key: 'owner', serverUrl: 'https://artifact-demand.test', accountId: 'owner' }],
            route: request => persisted.handle(request.path + request.url.search, { method: request.method,
                headers: request.headers, body: request.method === 'GET' ? undefined : JSON.stringify(request.body) }) ?? undefined });
        disposeHome = served.dispose;
        const disconnect = await served.restoreActiveConnection();
        const { sync } = await import('@/sync/sync');
        try {
            await sync.fetchArtifactsList();
            expect(getStorage().getState().artifacts[id]?.provenance).toBeUndefined();
            const screen = await renderScreen(<AppPaneProvider><ArtifactsBrowserScreen /></AppPaneProvider>);
            try {
                await vi.waitFor(() => expect(getStorage().getState().artifacts[id]?.provenance?.savedBy)
                    .toMatchObject({ sessionId: 'author-1' }));
                persisted.replaceStoredRow(await version(2));
                await act(async () => { await sync.fetchArtifactsList(); });
                expect(getStorage().getState().artifacts[id]?.provenance?.savedBy).toMatchObject({ sessionId: 'author-2' });
            } finally { await screen.unmount(); }
            persisted.replaceStoredRow(await version(3));
            await sync.fetchArtifactsList();
            expect(getStorage().getState().artifacts[id]).toMatchObject({ bodyVersion: 3 });
            expect(getStorage().getState().artifacts[id]?.provenance).toBeUndefined();
            expect(served.requests.some(request => request.path === '/v1/artifacts/read')).toBe(false);
        } finally { await disconnect(); }
    });
    it('keeps browser totals unknown until its listed inventory arrives without claiming a full census', async () => {
        const accountId = 'owner';
        const plain = (id: string, kind: string, title: string, at: number) => ({ id, ownerAccountId: accountId, access: 'owner' as const,
            kind: 'other' as const, kindHint: kind, encryptionMode: 'plain' as const, publicAudience: 'none' as const,
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, header: encodePlainArtifactStoredContent({ kind, title }),
            headerVersion: 1, bodyVersion: 1, seq: at, createdAt: at, updatedAt: at });
        const rows = [
            plain('11111111-1111-4111-8111-000000000001', 'prompt_doc.v2', 'Review checklist', 1),
            plain('11111111-1111-4111-8111-000000000002', 'prompt_doc.v2', 'Release notes voice', 2),
            plain('11111111-1111-4111-8111-000000000003', 'markdown', 'Quarterly plan', 3),
        ];
        const browserInventory = createDeferred<Response>();
        const served = await serveActionHomes({ homes: [{ key: 'owner', serverUrl: 'https://artifact-browser-pending.test', accountId }],
            route: request => {
                if (request.path !== '/v1/artifacts' || request.method !== 'GET') return undefined;
                if (request.url.searchParams.has('kinds')) return createArtifactListHttpResponse(request.url, rows);
                return browserInventory.promise;
            } });
        disposeHome = served.dispose;
        const disconnect = await served.restoreActiveConnection();
        const { sync } = await import('@/sync/sync');
        try {
            // Context's exact-kind read admitted only the Prompt headers; the Account's full inventory is still unread.
            await sync.fetchArtifactsList({ kinds: ['prompt_doc.v2'] });
            expect(Object.keys(getStorage().getState().artifacts)).toHaveLength(2);
            expect(getStorage().getState().artifactsLoaded).toBe(false);
            const screen = await renderScreen(<AppPaneProvider><ArtifactsBrowserScreen /></AppPaneProvider>);
            try {
                await act(async () => { invokeTestInstanceHandler(screen.findHostByTestId('artifacts:collection:stage'), 'onLayout', {
                    nativeEvent: { layout: { x: 0, y: 0, width: 1200, height: 800 } } }); });
                // The rows stay usable under one plain "still loading" line; the count is not a final total.
                expect(screen.findHostByTestId('artifacts:row:11111111-1111-4111-8111-000000000001')).not.toBeNull();
                expect(screen.findByTestId('artifacts:pending')).not.toBeNull();
                expect(screen.getTextContent()).not.toContain('artifacts.countPlural');
                // A search the unread remainder could still answer is not a definitive "no match".
                await screen.pressByTestIdAsync('artifacts:search:toggle');
                await act(async () => { invokeTestInstanceHandler(screen.findHostByTestId('artifacts:search'), 'onChangeText', 'Quarterly'); });
                expect(screen.findByTestId('artifacts:noMatch')).toBeNull();
                expect(screen.findByTestId('artifacts:noMatchSoFar')).not.toBeNull();
                expect(screen.findByTestId('artifacts:pending')).not.toBeNull();

                await act(async () => { browserInventory.resolve(createArtifactListHttpResponse(
                    new URL('https://artifact-browser-pending.test/v1/artifacts?browserListed=true'), rows)); });
                await vi.waitFor(() => expect(screen.findByTestId('artifacts:pending')).toBeNull());
                expect(screen.findByTestId('artifacts:noMatchSoFar')).toBeNull();
                expect(screen.findHostByTestId('artifacts:row:11111111-1111-4111-8111-000000000003')).not.toBeNull();
                await act(async () => { invokeTestInstanceHandler(screen.findHostByTestId('artifacts:search'), 'onChangeText', 'zzz'); });
                expect(screen.findByTestId('artifacts:noMatch')).not.toBeNull();
                await act(async () => { invokeTestInstanceHandler(screen.findHostByTestId('artifacts:search'), 'onChangeText', ''); });
                expect(screen.getTextContent()).toContain('artifacts.countPlural(count=3)');
                expect(getStorage().getState().artifactsLoaded).toBe(false);
                expect(getStorage().getState().artifactBrowserLoaded).toBe(true);
                const browserReads = served.requests.filter(request => request.path === '/v1/artifacts'
                    && !request.url.searchParams.has('kinds'));
                expect(browserReads.length).toBeGreaterThan(0);
                expect(browserReads.every(request => request.url.searchParams.get('browserListed') === 'true')).toBe(true);
            } finally { await screen.unmount(); }
        } finally { await disconnect(); }
    });

    it.each(['phone', 'panes-disabled'] as const)('retains selected details on %s and routes fresh opens', async transition => {
        let viewport = { width: 1440, height: 1000, scale: 1, fontScale: 1 };
        vi.spyOn(ReactNative, 'useWindowDimensions').mockImplementation(() => viewport);
        vi.spyOn(ReactNative.Dimensions, 'get').mockImplementation(() => viewport);
        getStorage().setState(state => ({ localSettings: { ...state.localSettings, uiMultiPanePanelsEnabled: true } }));
        const artifacts = [artifactFixture('retained-view'), artifactFixture('fresh-view')];
        const element = () => <AppPaneProvider><ArtifactsBrowser artifacts={artifacts} initialOpenId="retained-view"
            loaded loadFailed={false} onRetry={() => {}} usage={null} /></AppPaneProvider>;
        const screen = await renderScreen(element());
        const viewer = screen.root.findByType(ArtifactView);
        if (transition === 'phone') viewport = { width: 390, height: 844, scale: 1, fontScale: 1 };
        else await act(async () => getStorage().setState(state => ({ localSettings: { ...state.localSettings, uiMultiPanePanelsEnabled: false } })));
        await screen.update(element());
        expect(screen.root.findAllByType(ArtifactView)).toEqual([viewer]);
        expect(viewer.props.artifactId).toBe('retained-view');
        await screen.pressByTestIdAsync('artifacts:detailPane:openAsPage');
        expect(router.push).toHaveBeenLastCalledWith('/artifacts/retained-view');
        // A new selection still follows the phone/disabled-pane route contract.
        await act(async () => { invokeTestInstanceHandler(screen.findHostByTestId('artifacts:collection:stage'), 'onLayout', {
            nativeEvent: { layout: { x: 0, y: 0, width: 1200, height: 800 } },
        }); });
        // A phone's row carries no overflow, so opening is the row's own press.
        await screen.pressByTestIdAsync('artifacts:row:fresh-view');
        expect(router.push).toHaveBeenLastCalledWith('/artifacts/fresh-view');
        expect(screen.root.findAllByType(ArtifactView)).toEqual([viewer]);
        viewport = { width: 1440, height: 1000, scale: 1, fontScale: 1 };
        await act(async () => getStorage().setState(state => ({ localSettings: { ...state.localSettings, uiMultiPanePanelsEnabled: true } })));
        await screen.update(element());
        expect(screen.root.findAllByType(ArtifactView)).toEqual([viewer]);
    });

    it('names a code document by its language, as its own page does, rather than as a plain document', async () => {
        const screen = await renderRows([artifactFixture('code-1', { title: 'relayHandshake.ts', header: { title: 'relayHandshake.ts' }, body: 'export const retries = 5;' })]);
        expect(screen.findAll(node => node.props.accessibilityLabel === 'relayHandshake.ts, TypeScript').length).toBeGreaterThan(0);
    });

    it('says where a row came from only when it was not simply written by the viewer', async () => {
        const screen = await renderRows([
            artifactFixture('own'),
            artifactFixture('received', { access: 'view' }),
            artifactFixture('from-session', { provenance: { savedBy: { kind: 'person', accountId: 'owner' }, source: {
                machineId: 'machine', rootPath: '/repo', path: 'docs/note.txt', sha: 'a'.repeat(64) } } }),
        ]);
        expect(screen.findByTestId('artifacts:row:own:provenance')).toBeNull();
        expect(screen.getTextContent()).not.toContain('artifacts.browser.provenance.savedByYou');
        expect(screen.getTextContent()).toContain('artifacts.browser.provenance.sharedWithYou');
        expect(screen.findByTestId('artifacts:row:from-session:provenance')).not.toBeNull();
    });

    it('shows wide list headings for the actual anatomy and retains row operations when narrowed', async () => {
        const screen = await renderRows([artifactFixture('document')]);
        await screen.pressByTestIdAsync('artifacts:view:list');
        expect(screen.getTextContent()).toContain('artifacts.browser.kindLabel');
        expect(screen.getTextContent()).toContain('artifacts.browser.sourceLabel');
        await act(async () => { invokeTestInstanceHandler(screen.findHostByTestId('artifacts:collection:stage'), 'onLayout', {
            nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 800 } },
        }); });
        expect(rowMenu(screen, 'document').props.secondaryActions.map((item: { id: string }) => item.id))
            .toEqual(['open', 'share', 'history', 'delete']);
    });

    it('keeps phone search behind its magnifier, the choices and the count while omitting the redundant introduction', async () => {
        const viewport = { width: 390, height: 844, scale: 1, fontScale: 1 };
        vi.spyOn(ReactNative, 'useWindowDimensions').mockReturnValue(viewport);
        vi.spyOn(ReactNative.Dimensions, 'get').mockReturnValue(viewport);
        const screen = await renderRows([artifactFixture('document')]);
        expect(screen.getTextContent()).not.toContain('artifacts.browser.description');
        expect(screen.findByTestId('artifacts:search')).toBeNull();
        await screen.pressByTestIdAsync('artifacts:search:toggle');
        expect(screen.findByTestId('artifacts:search')).not.toBeNull();
        expect(screen.findByTestId('artifacts:kind')).not.toBeNull();
        expect(screen.findByTestId('artifacts:present')).not.toBeNull();
    });

    it('opens the phone title\'s filters: a kind chosen there narrows the library as the kind chip does', async () => {
        const viewport = { width: 390, height: 844, scale: 1, fontScale: 1 };
        vi.spyOn(ReactNative, 'useWindowDimensions').mockReturnValue(viewport);
        vi.spyOn(ReactNative.Dimensions, 'get').mockReturnValue(viewport);
        const board = artifactFixture('board', { title: 'Launch', header: { v: 1, kind: 'work-board.v1', title: 'Launch',
            pinnedInSessions: false, readsNeedsYou: false }, body: undefined, bodyVersion: undefined });
        const screen = await renderRows([artifactFixture('document'), board]);
        expect(screen.findHostByTestId('artifacts:row:document')).not.toBeNull();
        await chooseDropdownMenuItem(screen, 'artifacts:title', 'kind:board');
        expect(screen.findHostByTestId('artifacts:row:document')).toBeNull();
        expect(screen.findHostByTestId('artifacts:row:board')).not.toBeNull();
    });

    it('starts a phone document from the title row\'s "+" and lends it to the bar\'s "+", and keeps rows free of a permanent overflow', async () => {
        const viewport = { width: 390, height: 844, scale: 1, fontScale: 1 };
        vi.spyOn(ReactNative, 'useWindowDimensions').mockReturnValue(viewport);
        vi.spyOn(ReactNative.Dimensions, 'get').mockReturnValue(viewport);
        const { usePageCreateAction } = await import('@/components/navigation/mobile/chrome/pageCreateAction');
        function BarCreateProbe() {
            const action = usePageCreateAction();
            return action ? <ReactNative.View testID={`bar:${action.testID}`} /> : null;
        }
        const screen = await renderScreen(<ReactNative.View><RecoveryBrowser artifacts={[artifactFixture('document')]} loadFailed={false} onRetry={() => {}} /><BarCreateProbe /></ReactNative.View>);
        await act(async () => { invokeTestInstanceHandler(screen.findHostByTestId('artifacts:collection:stage'), 'onLayout', {
            nativeEvent: { layout: { x: 0, y: 0, width: 1200, height: 800 } },
        }); });
        // One "+" in the title row; the bar's "+" runs the same action. No labelled button besides.
        expect(screen.findByTestId('artifacts:new:header')).not.toBeNull();
        expect(screen.findByTestId('bar:artifacts:new')).not.toBeNull();
        expect(screen.findAll(node => typeof node.type === 'string' && node.props.accessibilityLabel === 'artifacts.browser.newDocument')).toHaveLength(1);
        await screen.pressByTestIdAsync('artifacts:new:header');
        expect(router.push).toHaveBeenLastCalledWith('/artifacts/new');
        expect(screen.findAll(node => node.props.testID === 'artifacts:row:document' && Array.isArray(node.props.secondaryActions))).toHaveLength(0);
        // The view switch sits with the choices, so the search keeps the whole row above them.
        expect(screen.findByTestId('artifacts:view:list')).not.toBeNull();
    });

    it('draws the phone Folders toolbar as one compact row: kind · icon-only New folder · view (lab c-art Tp)', async () => {
        const viewport = { width: 390, height: 844, scale: 1, fontScale: 1 };
        vi.spyOn(ReactNative, 'useWindowDimensions').mockReturnValue(viewport);
        vi.spyOn(ReactNative.Dimensions, 'get').mockReturnValue(viewport);
        const screen = await renderRows([artifactFixture('document')]);
        await screen.pressByTestIdAsync('artifacts:view:folders');
        expect(screen.findByTestId('artifacts:kind')).not.toBeNull();
        expect(screen.findByTestId('artifacts:sort')).toBeNull();
        const newFolder = screen.findByTestId('artifacts:folders:new');
        expect(newFolder).not.toBeNull();
        // The glyph alone, named for assistive technology; no visible label beside it.
        expect(newFolder?.props.accessibilityLabel).toBe('artifacts.browser.folders.newFolder');
        expect(newFolder?.props.title).toBeUndefined();
    });

    it('keeps the page identity visible beneath phone navigation chrome', async () => {
        const screen = await renderScreen(<NavigationTitleChromeProvider showsTitle>
            <RecoveryBrowser loadFailed={false} onRetry={() => {}} />
        </NavigationTitleChromeProvider>);
        const heading = screen.findAll(node => typeof node.type === 'string'
            && node.props.accessibilityRole === 'header'
            && node.children.includes('artifacts.title'));
        expect(heading).toHaveLength(1);
    });
    it('replaces an already-loaded empty welcome with failure and a working Retry', async () => {
        const retry = vi.fn();
        const screen = await renderScreen(<RecoveryBrowser loadFailed={false} onRetry={retry} />);
        expect(screen.findHostByTestId('artifacts:empty')).not.toBeNull();
        expect(screen.findByTestId('artifacts:empty-scene')).not.toBeNull();

        await screen.update(<RecoveryBrowser loadFailed onRetry={retry} />);
        expect(screen.findHostByTestId('artifacts:empty')).toBeNull();
        expect(screen.findByTestId('artifacts:empty-scene')).toBeNull();
        expect(screen.findHostByTestId('artifacts:failed')).not.toBeNull();
        const retryButton = screen.findAll((node) => typeof node.type === 'string'
            && node.props.accessibilityRole === 'button' && node.props.accessibilityLabel === 'common.retry').at(-1);
        expect(retryButton).toBeDefined();
        await pressTestInstanceAsync(retryButton, 'Retry');
        expect(retry).toHaveBeenCalledOnce();

        await screen.update(<RecoveryBrowser loadFailed={false} onRetry={retry} />);
        expect(screen.findHostByTestId('artifacts:failed')).toBeNull();
        expect(screen.findHostByTestId('artifacts:empty')).not.toBeNull();
    });

    it('keeps hydrated documents visible when a later refresh fails', async () => {
        const artifact: DecryptedArtifact = { id: 'retained', title: 'Notes', isDecrypted: true,
            header: { title: 'Notes' }, headerVersion: 1, bodyVersion: 1, seq: 1,
            body: 'Notes', createdAt: 1, updatedAt: 1, access: 'owner', storageMode: 'plain' };
        const retry = vi.fn();
        const screen = await renderScreen(<RecoveryBrowser artifacts={[artifact]} loadFailed={false} onRetry={retry} />);
        await act(async () => {
            invokeTestInstanceHandler(screen.findHostByTestId('artifacts:collection:stage'), 'onLayout', {
                nativeEvent: { layout: { x: 0, y: 0, width: 1200, height: 800 } },
            });
        });
        expect(screen.findHostByTestId('artifacts:row:retained')).not.toBeNull();
        await screen.update(<RecoveryBrowser artifacts={[artifact]} loadFailed onRetry={retry} />);
        expect(screen.findHostByTestId('artifacts:row:retained')).not.toBeNull();
        expect(screen.findHostByTestId('artifacts:empty')).toBeNull();
        expect(screen.findHostByTestId('artifacts:failed')).toBeNull();
        expect(screen.findHostByTestId('artifacts:stale')).not.toBeNull();
        await screen.pressByTestIdAsync('artifacts:stale-action');
        expect(retry).toHaveBeenCalledOnce();
        await screen.update(<RecoveryBrowser artifacts={[artifact]} loadFailed={false} onRetry={retry} />);
        expect(screen.findHostByTestId('artifacts:stale')).toBeNull();
        expect(screen.findHostByTestId('artifacts:row:retained')).not.toBeNull();
    });

    it('clears the full-budget banner after quota refusal then deletion without remounting', async () => {
        let usedBytes = 1000;
        const served = await serveActionHomes({
            homes: [{ key: 'owner', serverUrl: 'https://artifact-browser-quota.test', accountId: 'owner' }],
            route: (request) => {
                if (request.path === '/v1/artifacts/storage/usage')
                    return Response.json({ usedBytes, limitBytes: 1000, documentLimitBytes: null, revisionRetentionCount: 10 });
                if (request.path === '/v1/artifacts' && request.method === 'POST')
                    return Response.json({ error: 'quota_exceeded', budget: 'account', limitBytes: 1000, usedBytes }, { status: 413 });
                if (request.path === '/v1/artifacts/document' && request.method === 'DELETE') {
                    usedBytes = 100;
                    return Response.json({ success: true });
                }
                return undefined;
            },
        });
        disposeHome = served.dispose;
        const artifact: DecryptedArtifact = { id: 'document', title: 'Notes', isDecrypted: true,
            header: { title: 'Notes' }, headerVersion: 1, bodyVersion: 1, seq: 1,
            body: 'Notes', createdAt: 1, updatedAt: 1, access: 'owner', storageMode: 'plain' };
        getStorage().getState().addArtifact(artifact);
        getStorage().getState().addArtifact({ ...artifact, id: 'retained' });
        const screen = await renderScreen(<AppPaneProvider><MeterBrowser /></AppPaneProvider>);
        await flushHookEffects();
        expect(screen.findHostByTestId('artifacts:quota')).not.toBeNull();
        expect(screen.findHostByTestId('artifacts:storageMeter')?.props.accessibilityValue.now).toBe(100);

        const account = await captureLazyActionAccountContext(served.homes.owner!.id);
        try {
            await expect(account.workflowArtifacts.create({ artifactId: 'another', header: { title: 'Another document' }, body: 'Content' }))
                .rejects.toBeInstanceOf(ArtifactQuotaExceededError);
            await act(async () => { expect(await account.workflowArtifacts.delete(artifact.id)).toEqual({ ok: true }); });
            await flushHookEffects();
            expect(getStorage().getState().artifacts[artifact.id]).toBeUndefined();
            expect(screen.findHostByTestId('artifacts:quota')).toBeNull();
            expect(screen.findHostByTestId('artifacts:storageMeter')?.props.accessibilityValue.now).toBe(10);
        } finally { account.dispose(); }
    });
});

describe('Artifacts browser phone Back', () => {
    // Artifacts is a main screen: the tab bar is its way around, so its own route draws no Back (owner 11-10).
    // A route it is not the root of keeps one, and a retained destination not in front never draws (or publishes) it.
    it.each([
        { pathname: '/artifacts', focused: true, drawn: 0 },
        { pathname: '/artifacts/new', focused: true, drawn: 1 },
        { pathname: '/artifacts/new', focused: false, drawn: 0 },
    ])('draws the phone Back only off a main screen while in front ($pathname, focused: $focused)', async ({ pathname, focused, drawn }) => {
        vi.spyOn(ReactNative.Dimensions, 'get').mockReturnValue({ width: 390, height: 844, scale: 1, fontScale: 1 });
        const screen = await renderScreen(
            <DestinationInstanceContext.Provider value={{ tabId: 'artifacts', ref: { kind: 'home', params: {} }, pathname, visible: true, focused, isFocused: () => focused,
                navigation: { push: vi.fn(), replace: vi.fn(), back: vi.fn() } }}>
                <RecoveryBrowser loadFailed={false} onRetry={() => {}} />
            </DestinationInstanceContext.Provider>,
        );
        expect(screen.root.findAll(node => typeof node.type === 'string' && node.props.testID === 'artifacts:back')).toHaveLength(drawn);
        await screen.unmount();
    });
});
