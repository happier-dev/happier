import * as React from 'react';
import { Platform } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createDeferred, flushHookEffects, renderHook, renderScreen } from '@/dev/testkit';
import { serveActionHomes, type ServedHomeRequest } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { TokenStorage, type AuthCredentials } from '@/auth/storage/tokenStorage';
import { getStorage } from '@/sync/domains/state/storage';
import { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getActiveServerSnapshot, upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { setServerReachabilityNetworkAllowed } from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';
import { encodeBase64 } from '@/encryption/base64';
import { hashArtifactBinaryContent } from '@/sync/domains/artifacts/artifactBinaryContent';
import type { Encryption } from '@/sync/encryption/encryption';
import type { Artifact, DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { decryptArtifactWithBody } from '@/sync/engine/artifacts/syncArtifacts';
import { sync } from '@/sync/sync';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import type { CodeEditorProps } from '@/components/ui/code/editor/codeEditorTypes';
import { buildWidgetSurfaceArtifactHeaderV1, buildWidgetSurfaceArtifactIdV1, flattenWidgetLayoutWidgetsV1, projectOverviewPresetV1, WidgetLayoutItemsV1Schema } from '@happier-dev/protocol/widgets';
import { createProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol/v1';

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
// Monaco/WebView is a platform boundary. Keep the real route, editor draft and
// hydration path; this Node renderer observes the source field's admitted value.
vi.mock('@/components/ui/code/editor/CodeEditor', async () => {
    const React = await import('react');
    return { CodeEditor: React.forwardRef(function SourceField(props: CodeEditorProps, _ref) {
        return React.createElement('CodeEditor', { testID: props.testID, value: props.value, onChangeText: props.onChange });
    }) };
});
import { ArtifactView } from './ArtifactView';
import { ArtifactDetailContent } from '@/app/(app)/artifacts/[id]';
import { EditArtifactContent } from '@/app/(app)/artifacts/edit/[id]';

const initialState = getStorage().getState();
const platform = Platform.OS;
let disposeHome: (() => Promise<void>) | undefined;
afterEach(async () => {
    await act(async () => {
        await disposeHome?.();
        disposeHome = undefined;
        retireActiveServerAccountScopeLifetime();
        getStorage().setState(initialState, true);
    });
    Object.defineProperty(Platform, 'OS', { configurable: true, value: platform });
    vi.restoreAllMocks();
});

function OpenView({ id, edit = false }: Readonly<{ id: string; edit?: boolean }>) {
    const artifact = getStorage()(state => state.artifacts[id] ?? null);
    return edit ? <EditArtifactContent id={id} artifact={artifact} /> : <ArtifactDetailContent id={id} artifact={artifact} />;
}

// The shared image preview cache is process-wide and keyed by content, so every setup serves
// distinct bytes: each test then starts from a cold preview rather than a cache hit.
let setupSequence = 0;

async function setup(kind: 'image' | 'html' | 'file' | 'document', delayBlob?: Promise<Response>, warm = false,
    override?: (request: ServedHomeRequest) => Response | Promise<Response> | undefined, cold = false) {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
    const bytes = new TextEncoder().encode(kind === 'html' ? '<!doctype html><h1>Saved HTML</h1>' : `Private bytes ${++setupSequence}`);
    const reference = { blobId: 'e704b26f-9c31-4728-9590-858378e34ed9', mime: kind === 'html' ? 'text/html' : kind === 'image' ? 'image/png' : 'application/zip',
        sizeBytes: bytes.length, sha256: hashArtifactBinaryContent(bytes) };
    const row: DecryptedArtifact = { id: 'document', title: 'Saved', header: { kind: kind === 'html' ? 'html' : kind === 'document' ? 'markdown' : 'artifact.legacy', title: 'Saved' },
        isDecrypted: true, body: warm ? reference : undefined, storageMode: 'plain', ownerAccountId: 'owner', access: 'owner',
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
    const head: Artifact = { id: row.id, ownerAccountId: 'owner', access: 'owner', publicAudience: 'none', encryptionMode: 'plain',
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
        header: encodePlainArtifactStoredContent(row.header), body: encodePlainArtifactStoredContent({ body: kind === 'document' ? 'The garden keeps one cedar tree.' : reference }),
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER };
    const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'owner', encryptionMode: 'plain' });
    artifacts.replaceStoredRow(head);
    const served = await serveActionHomes({ homes: [{ key: 'owner', serverUrl: 'https://view.test', accountId: 'owner' }], route: request => {
        const overridden = override?.(request);
        if (overridden !== undefined) return overridden;
        if (request.path === '/v1/artifacts/document') return Response.json(head);
        if (request.path === '/v1/artifacts/document/access/grants') return artifacts.handle(request.path, { method: request.method }) ?? undefined;
        if (request.path.includes('/blobs/')) return delayBlob ?? Response.json({ blobId: reference.blobId, content: { t: 'plain', v: encodeBase64(bytes) } });
        if (request.path.endsWith('/html-preview')) return Response.json({ error: 'artifact_html_isolation_unavailable' }, { status: 503 });
    } });
    disposeHome = served.dispose;
    await loadSyncSingletonForTests();
    // This Node renderer has no browser sessionStorage for a tab-scoped selection.
    await upsertAndActivateServer({ serverUrl: served.homes.owner!.serverUrl, scope: 'device' });
    expect(getActiveServerSnapshot().serverUrl).toBe(served.homes.owner!.serverUrl);
    // Seed the real singleton's authenticated state; no sync or crypto behavior is substituted.
    const initialized = sync as unknown as { credentials: AuthCredentials | null; encryption: Encryption | null };
    initialized.credentials = await TokenStorage.getCredentialsForServerUrl(served.homes.owner!.serverUrl);
    initialized.encryption = null;
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    setServerReachabilityNetworkAllowed(true);
    const storedRow = warm ? await decryptArtifactWithBody({ artifact: head, encryption: null, artifactDataKeys: new Map() }) : row;
    if (!storedRow) throw new Error('Missing warm Artifact');
    if (!cold) getStorage().getState().addArtifact(storedRow);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:private-preview');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    return { served, head, row, bytes, reference };
}

describe('Artifact composed view reads', () => {
    it('keeps Share unavailable for an owner opening an unlisted Deployment Artifact URL', async () => {
        const { head, row } = await setup('file');
        const header = { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: 'Production' };
        head.header = encodePlainArtifactStoredContent(header);
        head.body = encodePlainArtifactStoredContent({ body: '{}' });
        const artifact = { ...row, title: header.title, header, body: '{}' };
        getStorage().getState().addArtifact(artifact);
        const screen = await renderScreen(<ArtifactDetailContent id={row.id} artifact={artifact} />);
        try {
            await vi.waitFor(() => expect(screen.findByTestId('artifact:history')).not.toBeNull());
            expect(screen.findByTestId('artifact:share') === null).toBe(true);
        } finally {
            await screen.unmount();
        }
    });
    it('keeps one cold edit body read when its inventory header arrives during the opening read', async () => {
        const pending = createDeferred<Response>();
        const { served, head, row } = await setup('document', undefined, false,
            request => request.path === '/v1/artifacts/document' ? pending.promise.then(response => response.clone()) : undefined, true);
        const screen = await renderScreen(<OpenView id="document" edit />);
        try {
            await vi.waitFor(() => expect(served.requests.filter(request => request.path === '/v1/artifacts/document')).toHaveLength(1));
            // The real inventory/socket publisher can deliver the head while the exact
            // body is still in flight. That publication is not another open intent.
            await act(async () => { getStorage().getState().addArtifact(row); });
            await flushHookEffects();
            await act(async () => { pending.resolve(Response.json(head)); });
            await vi.waitFor(() => expect(screen.findByTestId('artifact-editor:body:source')?.props.value).toBe('The garden keeps one cedar tree.'));
            await flushHookEffects();
            expect(served.requests.filter(request => request.path === '/v1/artifacts/document')).toHaveLength(1);
        } finally {
            pending.resolve(Response.json(head));
            await screen.unmount();
        }
    });

    it.each([false, true])('opens an unloaded own Doc with one exact read and no inventory read (edit=%s)', async edit => {
        const pending = createDeferred<Response>();
        const { served, head } = await setup('document', undefined, false,
            request => request.path === '/v1/artifacts/document' ? pending.promise.then(response => response.clone()) : undefined, true);
        const screen = await renderScreen(<OpenView id="document" edit={edit} />);
        try {
            expect(screen.findByTestId(edit ? 'artifact-editor:unavailable' : 'artifact:notFound') === null).toBe(true);
            expect(screen.findByTestId(edit ? 'artifact-editor:loading' : 'artifact:bodyLoading') !== null).toBe(true);
            await act(async () => { pending.resolve(Response.json(head)); });
            await vi.waitFor(() => expect(screen.findByTestId(edit ? 'artifact-editor:save' : 'artifact:body') !== null).toBe(true));
            if (edit) expect(screen.findByTestId('artifact-editor:body:source')?.props.value).toBe('The garden keeps one cedar tree.');
            else expect(screen.getTextContent()).toContain('The garden keeps one cedar tree.');
            // A successful audience roster read must not initiate another body read.
            if (!edit) {
                await vi.waitFor(() => expect(screen.findByType(PageHeader).props.meta)
                    .toEqual(expect.arrayContaining([expect.objectContaining({ key: 'audience' })])));
                expect(served.requests.filter(request => request.path.endsWith('/access/grants'))).toHaveLength(1);
            }
            await flushHookEffects();
            expect(served.requests.filter(request => request.path === '/v1/artifacts/document')).toHaveLength(1);
            expect(served.requests.filter(request => request.path === '/v1/artifacts')).toHaveLength(0);
        } finally {
            pending.resolve(Response.json(head));
            await screen.unmount();
        }
    });

    it.each([
        { edit: false, failure: '503' }, { edit: true, failure: '503' },
        { edit: false, failure: 'network' }, { edit: true, failure: 'network' },
    ])('keeps a cold Doc $failure failure retryable and recovers once (edit=$edit)', async ({ edit, failure }) => {
        let recovered = false;
        const { served } = await setup('document', undefined, false, request => {
            if (request.path !== '/v1/artifacts/document' || recovered) return;
            if (failure === 'network') throw new TypeError('Network request failed');
            return Response.json({ error: 'temporarily_unavailable' }, { status: 503 });
        }, true);
        const screen = await renderScreen(<OpenView id="document" edit={edit} />);
        const failedId = edit ? 'artifact-editor:failed' : 'artifact:bodyFailed';
        try {
            // The API owner exhausts its existing transient-read backoff before this finite opening fails.
            await vi.waitFor(() => expect(screen.findByTestId(failedId) !== null).toBe(true), { timeout: 10_000 });
            expect(screen.findByTestId(edit ? 'artifact-editor:unavailable' : 'artifact:notFound') === null).toBe(true);
            const failedReads = served.requests.filter(request => request.path === '/v1/artifacts/document').length;
            expect(failedReads).toBeGreaterThan(0);
            recovered = true;
            await screen.pressByTestIdAsync(`${failedId}-action`);
            await vi.waitFor(() => expect(screen.findByTestId(edit ? 'artifact-editor:save' : 'artifact:body') !== null).toBe(true));
            await flushHookEffects();
            expect(served.requests.filter(request => request.path === '/v1/artifacts/document')).toHaveLength(failedReads + 1);
            expect(served.requests.filter(request => request.path === '/v1/artifacts')).toHaveLength(0);
        } finally {
            await screen.unmount();
        }
    });

    it.each([404, 503])('settles a cold Doc-backed widget definition read without treating HTTP %s as a missing definition', async status => {
        await setup('document', undefined, false, request => request.path === '/v1/artifacts/document'
            ? Response.json({ error: status === 404 ? 'not_found' : 'temporarily_unavailable' }, { status }) : undefined, true);
        const scope = captureActiveServerAccountScopeLifetime()?.scope;
        if (!scope) throw new Error('The test Home must be applied');
        const { useWidgetDefinition } = await import('@/sync/domains/widgets/useWidgetDefinition');
        const hook = await renderHook(() => useWidgetDefinition({ ...scope, owner: { kind: 'home' } },
            { kind: 'artifact', artifactId: 'document' }));
        try {
            await vi.waitFor(() => expect(hook.getCurrent()).toEqual({ definition: null, state: 'unavailable',
                reasonCode: status === 404 ? 'widget_definition_not_found' : 'widget_definition_unavailable' }), { timeout: 10_000 });
        } finally {
            await hook.unmount();
        }
    });

    it.each([{ status: 404, edit: false }, { status: 403, edit: false }, { status: 404, edit: true }, { status: 403, edit: true }])('settles an inaccessible cold Doc as unavailable after one exact read (HTTP $status, edit=$edit)', async ({ status, edit }) => {
        const { served } = await setup('document', undefined, false,
            request => request.path === '/v1/artifacts/document'
                ? Response.json({ error: status === 404 ? 'not_found' : 'forbidden' }, { status }) : undefined, true);
        const screen = await renderScreen(<OpenView id="document" edit={edit} />);
        try {
            await vi.waitFor(() => expect(screen.findByTestId(status === 403
                ? edit ? 'artifact-editor:failed' : 'artifact:bodyFailed'
                : edit ? 'artifact-editor:unavailable' : 'artifact:notFound') !== null).toBe(true));
            await flushHookEffects();
            expect(screen.findByTestId('artifact:body') === null).toBe(true);
            expect(served.requests.filter(request => request.path === '/v1/artifacts/document')).toHaveLength(1);
            expect(served.requests.filter(request => request.path === '/v1/artifacts')).toHaveLength(0);
        } finally {
            await screen.unmount();
        }
    });

    it('displays a workspace copy without fabricating a Session destination', async () => {
        const row: DecryptedArtifact = { id: 'workspace-copy', title: 'Copied note', isDecrypted: true,
            header: { kind: 'published.v1', title: 'Copied note' }, body: 'Frozen workspace bytes',
            ownerAccountId: 'owner', access: 'owner', storageMode: 'plain',
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
            provenance: { savedBy: { kind: 'person', accountId: 'owner' }, source: {
                machineId: 'machine', rootPath: '/repo', path: 'docs/note.txt', sha: 'a'.repeat(64),
            } } };
        const screen = await renderScreen(<ArtifactView artifactId={row.id} artifact={row} presentation="page" />);
        expect(screen.findByTestId('artifact:provenance')).not.toBeNull();
        expect(screen.findByTestId('artifact:provenance:open')).toBeNull();
        await screen.unmount();
    });
    it.each(['pane', 'page'] as const)('never mounts cached approval custody as a Document in the %s', async presentation => {
        const row: DecryptedArtifact = { id: 'approval', title: 'Review request', isDecrypted: true,
            header: { kind: 'approval_request.v1', title: 'Review request', serverIdentityId: 'home' },
            body: 'retained request envelope', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        const screen = await renderScreen(<ArtifactView artifactId={row.id} artifact={row} presentation={presentation} />);
        // Keep even a failing privacy assertion from dumping the renderer's custody tree.
        expect(screen.findByTestId('artifact:body') !== null).toBe(false);
        expect(screen.findByTestId('artifact:actions') !== null).toBe(false);
        expect(screen.tree.root.findByType('Redirect').props.href).toBe('/inbox?item=approval%3Ahome%3Aapproval');
        await screen.unmount();
    });
    it('shows a saved widget as the widget itself, never its stored definition as a document', async () => {
        const definition = { v: 1, id: 'saved-widget', name: 'Tokens per day', sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' } };
        const row: DecryptedArtifact = { id: 'saved-widget', title: 'Tokens per day', isDecrypted: true,
            header: { kind: 'widget-definition.v1', v: 1, title: 'Tokens per day' },
            body: JSON.stringify(definition), ownerAccountId: 'owner', access: 'owner', storageMode: 'plain',
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        const screen = await renderScreen(<ArtifactView artifactId={row.id} artifact={row} presentation="page" />);
        expect(screen.findByTestId('artifact:widget')).not.toBeNull();
        expect(screen.findByTestId('artifact:body') === null).toBe(true);
        // It is a widget, not a text document: named so, and never offered to the text editor.
        expect(screen.tree.root.findByProps({ testID: 'artifact:header' }).props.meta[0]).toMatchObject({ key: 'kind', text: 'artifacts.browser.kindOne.widget' });
        expect(screen.findByTestId('artifact:edit') === null).toBe(true);
        expect(screen.findByTestId('artifact:history') !== null).toBe(true);
        await screen.unmount();
    });
    it.each([{ kind: 'image', warm: false }, { kind: 'html', warm: false }, { kind: 'image', warm: true }, { kind: 'html', warm: true }] as const)(
        'opens $kind (warm=$warm) through one authenticated head and renders its private preview', async ({ kind, warm }) => {
        const { served } = await setup(kind, undefined, warm);
        const screen = await renderScreen(<OpenView id="document" />);
        await vi.waitFor(() => expect(kind === 'image' ? screen.findByTestId('artifact:viewerBody') : screen.findHostByTestId('artifact:htmlPreview-navigation-shell')).not.toBeNull());
        const heads = served.requests.filter(request => request.path === '/v1/artifacts/document');
        console.info('Artifact view measurement', { kind, warm, heads: heads.length,
            blobs: served.requests.filter(request => request.path.includes('/blobs/')).length,
            shells: served.requests.filter(request => request.path.endsWith('/html-preview')).length });
        expect(heads).toHaveLength(1);
        expect(served.requests.filter(request => request.path.endsWith('/html-preview'))).toHaveLength(0);
        // Public feature discovery may be anonymous; every private Artifact operation must authenticate.
        const privateRequests = served.requests.filter(request => request.path === '/v1/artifacts' || request.path.startsWith('/v1/artifacts/'));
        expect(privateRequests.every(request => request.accountId === 'owner')).toBe(true);
        await screen.unmount();
    });

    it('leaves a generic file download deferred and suppresses the retired preview while renewed authority reads again', async () => {
        const { served } = await setup('file');
        const file = await renderScreen(<OpenView id="document" />);
        await flushHookEffects();
        await vi.waitFor(() => expect(file.findByTestId('artifact:download')).not.toBeNull());
        expect(served.requests.some(request => request.path.includes('/blobs/'))).toBe(false);
        await file.unmount();
        await disposeHome?.();
        const pending = createDeferred<Response>();
        const renewed = createDeferred<Response>();
        let blobReads = 0;
        const next = await setup('image', undefined, false, request => request.path.includes('/blobs/')
            ? ++blobReads === 1 ? pending.promise : renewed.promise : undefined);
        const image = await renderScreen(<OpenView id="document" />);
        const response = () => Response.json({ blobId: next.reference.blobId, content: { t: 'plain', v: encodeBase64(next.bytes) } });
        try {
            await vi.waitFor(() => expect(blobReads).toBe(1));
            await act(async () => { retireActiveServerAccountScopeLifetime(); });
            await vi.waitFor(() => expect(blobReads).toBe(2));
            await act(async () => { pending.resolve(response()); });
            await flushHookEffects();
            expect(image.findByTestId('artifact:viewerBody') === null).toBe(true);
            expect(URL.createObjectURL).not.toHaveBeenCalled();
            await act(async () => { renewed.resolve(response()); });
            await vi.waitFor(() => expect(image.findByTestId('artifact:viewerBody')).not.toBeNull());
        } finally {
            pending.resolve(response());
            renewed.resolve(response());
            await image.unmount();
        }
    });

    it('reopens an HTML frame retry through fresh Account authority without repeating a head within either operation', async () => {
        const { served } = await setup('html');
        const screen = await renderScreen(<OpenView id="document" />);
        await vi.waitFor(() => expect(screen.findHostByTestId('artifact:htmlPreview-navigation-shell')).not.toBeNull());
        await act(async () => { screen.findHostByTestId('artifact:htmlPreview-navigation-shell')!.props.onError(); });
        await screen.pressByTestIdAsync('artifact:htmlPreviewRetry');
        await vi.waitFor(() => expect(screen.findHostByTestId('artifact:htmlPreview-navigation-shell')).not.toBeNull());
        expect(served.requests.filter(request => request.path === '/v1/artifacts/document')).toHaveLength(2);
        expect(served.requests.filter(request => request.path.endsWith('/html-preview'))).toHaveLength(0);
        await screen.unmount();
    });

    it('cancels a superseded revision and does not install its late private preview', async () => {
        const pending = createDeferred<Response>();
        let blobReads = 0;
        const { served, head, row, bytes, reference } = await setup('image', undefined, false, request => {
            if (!request.path.includes('/blobs/')) return;
            if (++blobReads === 1) return pending.promise;
            return Response.json({ blobId: reference.blobId, content: { t: 'plain', v: encodeBase64(bytes) } });
        });
        const screen = await renderScreen(<OpenView id="document" />);
        await vi.waitFor(() => expect(blobReads).toBe(1));
        head.headerVersion = 2;
        head.bodyVersion = 2;
        await act(async () => { getStorage().getState().updateArtifact({ ...row, headerVersion: 2, bodyVersion: 2 }); });
        await vi.waitFor(() => expect(screen.findByTestId('artifact:viewerBody')).not.toBeNull());
        expect(getStorage().getState().artifacts.document?.bodyVersion).toBe(2);
        expect(served.requests.filter(request => request.path === '/v1/artifacts/document')).toHaveLength(2);
        expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
        pending.resolve(Response.json({ blobId: reference.blobId, content: { t: 'plain', v: encodeBase64(bytes) } }));
        await flushHookEffects();
        expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
        await screen.unmount();
    });
});

describe('dashboard Artifacts', () => {
    const scope = { serverId: 'home', accountId: 'owner' };
    function dashboardRow(owner: Readonly<{ kind: 'project'; projectId: string; layoutId?: string }>, name?: string): DecryptedArtifact {
        const surface = { ...scope, owner };
        const layout = { v: 1 as const, surface, ...(name ? { name } : {}), items: WidgetLayoutItemsV1Schema.parse(projectOverviewPresetV1().items) };
        const header = buildWidgetSurfaceArtifactHeaderV1(layout);
        return { id: buildWidgetSurfaceArtifactIdV1(surface), title: String(header.title), header: { ...header, title: String(header.title) }, rawHeader: header, isDecrypted: true,
            body: JSON.stringify(layout), ownerAccountId: 'owner', access: 'owner', storageMode: 'plain',
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
    }
    function seedProject(projectKey: string) {
        getStorage().setState({ profileScope: scope, settingsScope: scope, projectAccountRows: createProjectAccountRowsFixture(scope, {
            workspaceRefs: [{ id: 'checkout-1', serverId: 'home', machineId: 'machine', projectKey, rootPath: '/src/happier', createdAtMs: 1 }],
        }) });
    }
    const widgetIds = () => flattenWidgetLayoutWidgetsV1(WidgetLayoutItemsV1Schema.parse(projectOverviewPresetV1().items)).map(widget => widget.instance.id);

    it.each(['pane', 'page'] as const)('shows a named dashboard as its widgets with Open in Project, never as editable or commentable text (%s)', async presentation => {
        seedProject('happier-app');
        const row = dashboardRow({ kind: 'project', projectId: 'happier-app', layoutId: 'release' }, 'Release review');
        const screen = await renderScreen(<ArtifactView artifactId={row.id} artifact={row} presentation={presentation} />);
        try {
            await flushHookEffects();
            expect(screen.findByTestId('artifact:dashboard')).not.toBeNull();
            for (const id of widgetIds()) expect(screen.findByTestId(`artifact:dashboard.widget:${id}`)).not.toBeNull();
            // Its stored layout is never offered as a text document.
            expect(screen.findByTestId('artifact:body') === null).toBe(true);
            expect(screen.findByTestId('artifact:edit') === null).toBe(true);
            expect(screen.findByTestId('artifact:comments') === null).toBe(true);
            expect(screen.findByTestId('artifact:share')).not.toBeNull();
            const { router } = await import('expo-router');
            await act(async () => { screen.findByTestId('artifact:dashboard.open')?.props.onPress(); });
            await vi.waitFor(() => expect(vi.mocked(router.push)).toHaveBeenCalledWith(expect.stringMatching(/^\/projects\/checkout-1\/overview\?.*layoutId=release/)));
        } finally {
            await screen.unmount();
        }
    });

    it('shows an orphaned default dashboard by its widgets with no Open action', async () => {
        seedProject('another-project');
        const row = dashboardRow({ kind: 'project', projectId: 'forgotten-project' });
        const screen = await renderScreen(<ArtifactView artifactId={row.id} artifact={row} presentation="page" />);
        try {
            await flushHookEffects();
            const header = screen.tree.root.findByProps({ testID: 'artifact:header' }).props;
            expect(header.title).toBe('Overview');
            // Its header names what it is, a dashboard, never a Document.
            expect(header.meta[0]).toMatchObject({ key: 'kind', text: 'artifacts.browser.kindOne.dashboard' });
            for (const id of widgetIds()) expect(screen.findByTestId(`artifact:dashboard.widget:${id}`)).not.toBeNull();
            expect(screen.findByTestId('artifact:dashboard.open') === null).toBe(true);
            expect(screen.findByTestId('artifact:edit') === null).toBe(true);
        } finally {
            await screen.unmount();
        }
    });

    it('sends a typed edit link for a held dashboard to its view, never the text editor', async () => {
        const row = dashboardRow({ kind: 'project', projectId: 'happier-app' });
        const screen = await renderScreen(<EditArtifactContent id={row.id} artifact={row} />);
        try {
            expect(screen.findByTestId('artifact-editor:body:source')).toBeNull();
            expect(screen.tree.root.findByType('Redirect').props.href).toBe(`/artifacts/${row.id}`);
        } finally {
            await screen.unmount();
        }
    });

    it('sends a typed edit link for a dashboard it has not opened yet to its view once its header arrives', async () => {
        const header = { kind: 'widget-area-layout.v1', v: 1, title: 'Overview' };
        const { served } = await setup('document', undefined, false, request => request.path === '/v1/artifacts/document'
            ? Response.json({ id: 'document', ownerAccountId: 'owner', access: 'owner', publicAudience: 'none', encryptionMode: 'plain',
                headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
                header: encodePlainArtifactStoredContent(header), body: encodePlainArtifactStoredContent({ body: '{"v":1}' }),
                dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER })
            : undefined, true);
        const screen = await renderScreen(<OpenView id="document" edit />);
        try {
            await vi.waitFor(() => expect(served.requests.some(request => request.path === '/v1/artifacts/document')).toBe(true));
            await vi.waitFor(() => expect(screen.tree.root.findAllByType('Redirect').map(node => node.props.href)).toContain('/artifacts/document'));
            expect(screen.findByTestId('artifact-editor:body:source')).toBeNull();
        } finally {
            await screen.unmount();
        }
    });
});
