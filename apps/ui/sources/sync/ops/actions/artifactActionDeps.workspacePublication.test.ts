import { afterEach, expect, it, vi } from 'vitest';
import { decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { ArtifactActionOutputSchemasV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { ArtifactHtmlBundleV1Schema } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { getStorage } from '@/sync/domains/state/storage';
import { captureLazyActionAccountContext, type LazyActionAccountContext } from './actionAccountContext';
import { createUiArtifactAction } from './artifactActionDeps';

// The web upload body (a Blob) is what reaches the Home here; native stages the same frame to a cache file.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());

let fixture: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> | undefined;
let account: LazyActionAccountContext | undefined;
const initialState = getStorage().getState();
afterEach(async () => {
    account?.dispose(); account = undefined;
    await fixture?.dispose(); fixture = undefined;
    getStorage().setState(initialState, true);
    vi.restoreAllMocks();
});

it.each(['session', 'workspace'] as const)('publishes a present user copy from the captured %s and retains private file provenance', async sourceKind => {
    fixture = await createPlainArtifactHomeFixture('https://file-publication-ui.test');
    account = await captureLazyActionAccountContext(fixture.home.id);
    const session = createSessionFixture({ id: 'source-session', serverId: fixture.home.id,
        metadata: { ...createSessionFixture().metadata!, path: '/repo', machineId: 'source-machine', host: 'source-host' } });
    getStorage().setState({ sessions: { [session.id]: session },
        machineListByServerId: { [fixture.home.id]: [createMachineFixture({ id: 'source-machine' })] } });
    const execute = createUiArtifactAction(account, {
        // Machine transfer is the system boundary; all source admission and Artifact codecs stay real.
        workspaceDownload: async request => {
            expect(request.machineId).toBe('source-machine');
            expect(request.rootPath).toBe('/repo');
            expect(request.request.path).toBe('docs/note.txt');
            await request.destination.writeBytes(new TextEncoder().encode('A frozen copy\n'));
            return { ok: true, name: 'note.txt', sizeBytes: 14 };
        },
    });
    const result = await execute({ actionId: 'artifact.publish_from_file',
        input: { path: 'docs/note.txt', title: 'Review notes',
            ...(sourceKind === 'workspace' ? { workspace: { machineId: 'source-machine', rootPath: '/repo' } } : {}) },
        context: { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
            serverId: fixture.home.id, runtimeAccountId: account.accountId,
            defaultSessionId: sourceKind === 'session' ? session.id : 'ambient-session-not-the-source' } });
    const receipt = ArtifactActionOutputSchemasV1['artifact.publish_from_file'].parse(result);
    const stored = fixture.boundary.read(receipt.artifactId)!;
    expect(decodePlainArtifactStoredContent(stored.header)).toMatchObject({ title: 'Review notes' });
    expect(fixture.boundary.readPlainBody(receipt.artifactId)).toBe('A frozen copy\n');
    const opened = await account.readArtifact(receipt.artifactId);
    expect(opened?.provenance).toMatchObject({
        savedBy: { kind: 'person', accountId: account.accountId },
        source: { ...(sourceKind === 'session' ? { sessionId: session.id } : { rootPath: '/repo' }),
            machineId: 'source-machine', path: 'docs/note.txt' },
    });
    if (sourceKind === 'workspace') expect(opened?.provenance?.source).not.toHaveProperty('sessionId');
});

it.each([
    { rootPath: '/repo', path: '~notes.txt', relativePath: '~notes.txt' },
    { rootPath: 'C:\\repo', path: 'docs\\note.txt', relativePath: 'docs/note.txt' },
])('publishes a literal selected entry $path from $rootPath without home expansion', async ({ rootPath, path, relativePath }) => {
    fixture = await createPlainArtifactHomeFixture('https://workspace-publication-selected-entry.test');
    account = await captureLazyActionAccountContext(fixture.home.id);
    getStorage().setState({ sessions: {}, machineListByServerId: {
        [fixture.home.id]: [createMachineFixture({ id: 'source-machine' })],
    } });
    const execute = createUiArtifactAction(account, { workspaceDownload: async request => {
        expect(request.rootPath).toBe(rootPath);
        expect(request.request.path).toBe(relativePath);
        expect(request.confinedToWorkingDirectory).toBe(true);
        await request.destination.writeBytes(new TextEncoder().encode('Selected bytes'));
        return { ok: true, name: relativePath.split('/').at(-1)!, sizeBytes: 14 };
    } });
    const result = await execute({
        actionId: 'artifact.publish_from_file', input: { path, workspace: { machineId: 'source-machine', rootPath } },
        context: { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
            serverId: fixture.home.id, runtimeAccountId: account.accountId },
    });
    expect(result).toMatchObject({ artifactId: expect.any(String), revision: expect.any(Object) });
    const receipt = ArtifactActionOutputSchemasV1['artifact.publish_from_file'].parse(result);
    expect(fixture.boundary.readPlainBody(receipt.artifactId)).toBe('Selected bytes');
    expect((await account.readArtifact(receipt.artifactId))?.provenance?.source).toMatchObject({
        machineId: 'source-machine', rootPath, path: relativePath,
    });
});

it.each(['missing-machine', 'locked-machine', 'escaped-path', 'foreign-account'] as const)(
    'refuses %s before reading or publishing a workspace copy', async refusal => {
    fixture = await createPlainArtifactHomeFixture(`https://workspace-publication-${refusal}.test`);
    account = await captureLazyActionAccountContext(fixture.home.id);
    getStorage().setState({ machineListByServerId: { [fixture.home.id]: refusal === 'missing-machine' ? [] : [
        createMachineFixture({ id: 'source-machine', ...(refusal === 'locked-machine'
            ? { availability: { kind: 'locked', reason: 'encryption_material_unavailable' } } : {}) }),
    ] } });
    const download = vi.fn();
    const execute = createUiArtifactAction(account, { workspaceDownload: download });
    const result = await execute({ actionId: 'artifact.publish_from_file', input: {
        path: refusal === 'escaped-path' ? '../outside.txt' : 'docs/note.txt',
        workspace: { machineId: 'source-machine', rootPath: '/repo' },
    }, context: { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
        serverId: fixture.home.id, runtimeAccountId: refusal === 'foreign-account' ? 'not-the-captured-account' : account.accountId } });
    expect(result).toMatchObject({ ok: false, errorCode: refusal === 'escaped-path'
        ? 'artifact_source_forbidden' : 'artifact_source_unavailable' });
    expect(download).not.toHaveBeenCalled();
    expect(fixture.boundary.list()).toHaveLength(0);
});

/** A confined HTML folder (V-OP-01): every file under it, read through the same confined transfer, becomes one bundle. */
function siteTree(entries: Readonly<Record<string, ReadonlyArray<Readonly<{ name: string; type: 'file' | 'directory' | 'other' }>>>>, truncated = false) {
    return vi.fn(async (request: Readonly<{ machineId: string; rootPath: string; path: string }>) => {
        expect(request).toMatchObject({ machineId: 'source-machine', rootPath: '/repo' });
        const listed = entries[request.path];
        return listed ? { success: true as const, entries: [...listed], ...(truncated ? { truncated } : {}) }
            : { success: false as const, error: 'missing', errorCode: 'not_found' };
    });
}
const SITE = { site: [{ name: 'assets', type: 'directory' as const }, { name: 'index.html', type: 'file' as const }],
    'site/assets': [{ name: 'app.css', type: 'file' as const }] };
const SITE_BYTES: Readonly<Record<string, string>> = {
    'site/index.html': '<link rel="stylesheet" href="assets/app.css"><main>Tides</main>',
    'site/assets/app.css': 'main { color: teal }',
};

it('publishes a confined HTML folder with its assets as one HTML Artifact bundle', async () => {
    // The bundle is binary Artifact content, so it leaves through the Home's content upload. This
    // persistence fixture has no blob store: the upload frame is the boundary observed here.
    const uploads: Uint8Array[] = [];
    fixture = await createPlainArtifactHomeFixture('https://workspace-publication-folder.test', { handleRequest: async (path, init) => {
        if (path !== '/v1/artifacts/content/upload') return null;
        uploads.push(new Uint8Array(await new Response(init?.body as BodyInit).arrayBuffer()));
        return Response.json({ error: 'blob_store_not_modelled' }, { status: 503 });
    } });
    account = await captureLazyActionAccountContext(fixture.home.id);
    getStorage().setState({ sessions: {}, machineListByServerId: { [fixture.home.id]: [createMachineFixture({ id: 'source-machine' })] } });
    const workspaceList = siteTree(SITE);
    const downloaded: string[] = [];
    const execute = createUiArtifactAction(account, { workspaceList, workspaceDownload: async request => {
        expect(request.confinedToWorkingDirectory).toBe(true);
        expect(request.request.asZip).toBe(false);
        downloaded.push(request.request.path);
        const bytes = new TextEncoder().encode(SITE_BYTES[request.request.path]!);
        await request.destination.writeBytes(bytes);
        return { ok: true, name: request.request.path.split('/').at(-1)!, sizeBytes: bytes.length };
    } });
    await execute({ actionId: 'artifact.publish_from_file',
        input: { path: 'site', entrypoint: 'index.html', title: 'Tide chart', workspace: { machineId: 'source-machine', rootPath: '/repo' } },
        context: { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
            serverId: fixture.home.id, runtimeAccountId: account.accountId } });
    expect(downloaded.sort()).toEqual(['site/assets/app.css', 'site/index.html']);
    expect(uploads.length).toBeGreaterThan(0);
    const frame = new TextDecoder().decode(uploads[0]);
    const bundle = ArtifactHtmlBundleV1Schema.parse(JSON.parse(frame.slice(frame.indexOf('\n') + 1)));
    expect(bundle.entrypoint).toBe('index.html');
    expect(Object.keys(bundle.files).sort()).toEqual(['assets/app.css', 'index.html']);
    expect(new TextDecoder().decode(decodeBase64(bundle.files['assets/app.css']!.contentBase64))).toBe('main { color: teal }');
    expect(bundle.files['assets/app.css']!.mime).toBe('text/css');
});

it.each(['link', 'truncated', 'missing-entrypoint'] as const)('refuses a folder with a %s before publishing anything', async refusal => {
    fixture = await createPlainArtifactHomeFixture(`https://workspace-publication-folder-${refusal}.test`);
    account = await captureLazyActionAccountContext(fixture.home.id);
    getStorage().setState({ sessions: {}, machineListByServerId: { [fixture.home.id]: [createMachineFixture({ id: 'source-machine' })] } });
    const tree = refusal === 'link' ? { ...SITE, 'site/assets': [{ name: 'app.css', type: 'other' as const }] } : SITE;
    const download = vi.fn(async (request: Parameters<NonNullable<Parameters<typeof createUiArtifactAction>[1]>['workspaceDownload'] & {}>[0]) => {
        const bytes = new TextEncoder().encode(SITE_BYTES[request.request.path] ?? 'x');
        await request.destination.writeBytes(bytes);
        return { ok: true as const, name: 'f', sizeBytes: bytes.length };
    });
    const execute = createUiArtifactAction(account, { workspaceList: siteTree(tree, refusal === 'truncated'), workspaceDownload: download });
    const result = await execute({ actionId: 'artifact.publish_from_file',
        input: { path: 'site', entrypoint: refusal === 'missing-entrypoint' ? 'home.html' : 'index.html',
            workspace: { machineId: 'source-machine', rootPath: '/repo' } },
        context: { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
            serverId: fixture.home.id, runtimeAccountId: account.accountId } });
    expect(result).toMatchObject({ ok: false, errorCode: 'artifact_source_forbidden' });
    expect(fixture.boundary.list()).toHaveLength(0);
});
