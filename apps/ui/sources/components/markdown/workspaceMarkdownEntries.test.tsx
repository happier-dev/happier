import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';

import { act, applyProjectAccountRowsFixture, createPlainProjectAccountRowListFixture, createThemeFixture, renderScreen } from '@/dev/testkit';
import { createSessionFileNativeTransferBoundary } from '@/components/sessions/files/sessionFileNativeTransferTestkit';
import { createSessionFilesViewFixture, prepareSessionFilesViewTestkit, type FileViewRpcRequest } from '@/components/sessions/files/views/sessionFilesViewTestkit';
import { transferMachine } from '@/components/sessions/files/sessionFileTransferTestkit';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createMachineReadBatchResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
});
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true, renderCustomModals: true }).module);
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
const fs = await vi.hoisted(async () => {
    const { createRequire } = await import('node:module');
    const { dirname, join } = await import('node:path');
    const require = createRequire(join(process.cwd(), 'package.json'));
    return {
        ...(await import('@/dev/testkit/mocks/expoFileSystem')).createExpoFileSystemFileMock('file:///markdown-preview'),
        nativeModulePath: join(dirname(require.resolve('expo-file-system/package.json')), 'src/ExpoFileSystem.ts'),
    };
});
vi.mock('expo-file-system', () => fs.module);
// Expo's native source wrapper can be imported by an already loaded module; its native classes
// still use the same filesystem boundary rather than reaching the unavailable device module.
vi.mock(fs.nativeModulePath, () => ({ default: {
    FileSystemDirectory: class extends fs.module.Directory { validatePath() {} },
    FileSystemFile: class extends fs.module.File { validatePath() {} },
    cacheDirectory: 'file:///markdown-preview',
} }));
// The native image decoder is the presentation boundary; Markdown, wells and byte transfer stay real.
vi.mock('expo-image', () => ({ Image: 'NativeImage' }));

const markdown = '![Screen](./shot.png)\n\n![Second](./second.png)\n\n![Remote](https://remote.test/shot.png)';
await prepareSessionFilesViewTestkit();

async function waitForImage(screen: Awaited<ReturnType<typeof renderScreen>>, count = 1) {
    try {
        await vi.waitFor(() => expect(screen.findAllHostsByTestId('markdown-image-open')).toHaveLength(count));
    } catch (cause) {
        const { ImageWell } = await import('@/components/ui/media/ImageWell');
        const { MarkdownView } = await import('./MarkdownView');
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const state = getStorage().getState();
        throw new Error(JSON.stringify({ markdown: screen.findAllByType(MarkdownView).map(node => ({
            images: Boolean(node.props.images), scope: node.props.imageScope,
        })), wells: screen.findAllByType(ImageWell).map(node => node.props.source),
        errors: screen.tree.root.findAll(node => Boolean(node.props.diagnosticCode)).map(node => node.props.diagnosticCode),
        profileScope: state.profileScope, projectRows: state.projectAccountRows }), { cause });
    }
}

describe('workspace Markdown entry points', () => {
    let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
    let transfer: ReturnType<typeof createSessionFileNativeTransferBoundary>;
    let fixtureId = 0;
    beforeEach(async () => {
        transfer = createSessionFileNativeTransferBoundary();
        const rpc = (request: FileViewRpcRequest) => request.method === 'daemon.filesystem.readFile'
                ? { success: true, content: Buffer.from(markdown).toString('base64') }
                : transfer.rpc(request);
        const serverUrl = `https://markdown-entry-${++fixtureId}.test`;
        const serverIdentityId = `srv_markdown_images_${fixtureId}`;
        const boundaries = await Promise.all((['daemon.filesystem.download', 'daemon.filesystem.readFile'] as const).map(actionId =>
            createExternalActionAccountHttpBoundary({ serverUrl, serverIdentityId, accountId: 'alice', machineId: 'm1', actionId, tokenEpoch: 0,
                execute: (input, { target }) => {
                    if (target.kind !== 'machine') throw new Error('The Markdown fixture requires its admitted Machine target');
                    return rpc({ targetId: target.machineId, method: getActionSpec(actionId).bindings!.rpcMethod!, payload: input });
                },
            })));
        const machine = transferMachine({ id: 'm1', storageMode: 'plain', installationId: boundaries[0]!.machine.installationId,
            installationPublicKey: boundaries[0]!.machine.installationPublicKey, replacedByMachineId: null, access: boundaries[0]!.machine.access });
        const row = { ...boundaries[0]!.machine, operationProtocolCapabilities: machine.operationProtocolCapabilities,
            operationProtocolCapabilitiesRevision: machine.operationProtocolCapabilitiesRevision,
            daemonState: encodePlainMachineStoredContent(machine.daemonState) };
        fixture = await createSessionFilesViewFixture({ serverUrl, rootPath: '/repo', machine, serverIdentityId, machineCarrierOrigin: transfer.origin,
            credentials: { token: `e30.${Buffer.from(JSON.stringify({ sub: 'alice', provenance: { v: 1, kind: 'account', authority: 'present_user' }, tokenEpoch: 0 })).toString('base64url')}.signature` },
            rpc, request: async (url, init) => {
                const parsed = new URL(String(url));
                if (parsed.pathname === '/v1/account/project-rows/list') return Response.json(createPlainProjectAccountRowListFixture({ workspaceRefs: [{
                    id: 'markdown-checkout', serverId: serverIdentityId, machineId: 'm1', rootPath: '/repo', createdAtMs: 1,
                }] }));
                if (parsed.pathname === '/v1/machines') return Response.json([row]);
                if (parsed.pathname === '/v1/machines/read-batch' && init?.method === 'POST') return createMachineReadBatchResponseFixture(init.body,
                    id => id === row.id ? row : null);
                if (parsed.pathname === '/v1/machines/m1') return Response.json({ machine: row });
                if (parsed.pathname.startsWith('/v1/actions/')) {
                    for (const boundary of boundaries) {
                        const response = await boundary.handle(parsed, init);
                        if (response) return response;
                    }
                }
                return transfer.request(url, init);
            } });
        fixture.storage.getState().applyLocalSettings({ remoteImageConsentV1: [] }, { source: 'ui' });
        await vi.waitFor(() => expect(fixture.storage.getState().projectAccountRows).toEqual(expect.objectContaining({
            scope: { serverId: serverIdentityId, accountId: 'alice' }, status: 'ready',
        })));
        applyProjectAccountRowsFixture(fixture.storage, { workspaceRefs: [{ id: 'markdown-checkout', ...fixture.scope, createdAtMs: 1 }] });
    });
    afterEach(async () => { await fixture.dispose(); });

    it.each(['file', 'readme'] as const)('%s renders relative images, opens its gallery, and grants remote consent only on Load', async entry => {
        const { FileContentPanel } = await import('@/components/workspaces/files/file/FileContentPanel');
        const { CodeReadmeCard } = await import('@/components/projects/files/code/CodeReadmeCard');
        const { Modal, ModalProvider } = await import('@/modal');
        const content = entry === 'file'
            ? <FileContentPanel workspaceScope={fixture.scope} theme={createThemeFixture()} displayMode="markdown" sessionId={fixture.session.id}
                filePath="docs/README.md" fileContent={markdown} diffContent={null} language="markdown"
                selectedLineKeys={new Set()} lineSelectionEnabled={false} onToggleLine={() => {}} />
            : <CodeReadmeCard scope={fixture.scope} path="docs/README.md" />;
        const screen = await renderScreen(<ModalProvider>{content}</ModalProvider>);
        await waitForImage(screen, 2);
        expect(transfer.prepares.map(request => request.payload)).toEqual(expect.arrayContaining([
            expect.objectContaining({ rootPath: '/repo', path: '/repo/docs/shot.png' }),
            expect.objectContaining({ rootPath: '/repo', path: '/repo/docs/second.png' }),
        ]));
        expect(screen.findAllByTestId('markdown-remote-images').length).toBeGreaterThan(0);
        expect(fixture.storage.getState().localSettings.remoteImageConsentV1).toEqual([]);
        expect(screen.findAllByType('NativeImage').some(image => image.props.source.uri === 'https://remote.test/shot.png')).toBe(false);
        await act(async () => { screen.findAllByTestId('markdown-image-open')[0]!.props.onPress(); });
        expect(Modal.show).toHaveBeenLastCalledWith(expect.objectContaining({
            chrome: expect.objectContaining({ kind: 'stage' }),
            props: expect.objectContaining({ items: [
                expect.objectContaining({ source: expect.objectContaining({ source: { kind: 'workspace', scope: fixture.scope, filePath: 'docs/shot.png' } }) }),
                expect.objectContaining({ source: expect.objectContaining({ source: { kind: 'workspace', scope: fixture.scope, filePath: 'docs/second.png' } }) }),
            ] }),
        }));
        // The canonical modal boundary mounts the real stage and its neighbours. Both reuse the
        // already rendered inline pictures, rather than acquiring each workspace image again.
        await vi.waitFor(() => expect(screen.findByTestId('media-stage-image')).toBeTruthy());
        expect(transfer.prepares).toHaveLength(2);
        await act(async () => Modal.hideAll());
        await act(async () => { screen.findAllByTestId('markdown-load-remote-images')[0]!.props.onPress(); });
        await vi.waitFor(() => expect(screen.findAllByTestId('markdown-remote-images')).toHaveLength(0));
        expect(screen.findAllByType('NativeImage').some(image => image.props.source.uri === 'https://remote.test/shot.png')).toBe(true);
        expect(fixture.storage.getState().localSettings.remoteImageConsentV1).toEqual([]);
        expect(transfer.prepares).toHaveLength(2);
        await screen.unmount();
    });

    it.each(['session', 'project'] as const)('public plugin Markdown resolves workspace images through its admitted %s target', async kind => {
        const { Markdown } = await import('@happier-dev/plugin-ui/components');
        const { PluginUiPresentationHostProviderInternal } = await import('../../../../../packages/plugin-ui/src/presentationHost/context');
        const { createPluginUiPrivatePresentationHost } = await import('@/components/plugins/surfaces/pluginUiPrivatePresentationHost');
        const host = createPluginUiPrivatePresentationHost(undefined, { markdownWorkspace: {
            target: kind === 'session' ? { kind, sessionId: fixture.session.id } : { kind, projectKey: 'markdown-checkout', checkout: {
                id: 'markdown-checkout', serverId: fixture.scope.serverId, machineId: fixture.scope.machineId, rootPath: fixture.scope.rootPath, createdAtMs: 1,
            } },
            serverId: fixture.scope.serverId,
        } });
        const screen = await renderScreen(<PluginUiPresentationHostProviderInternal host={host}>
            <Markdown value="![Plugin](./shot.png)" images={{ resolve: () => ({ kind: 'workspace', path: 'docs/shot.png' }), remoteLoaded: false, onLoadRemote() {} }} />
        </PluginUiPresentationHostProviderInternal>);
        await waitForImage(screen);
        expect(transfer.prepares.map(request => request.payload)).toEqual(expect.arrayContaining([
            expect.objectContaining({ rootPath: '/repo', path: '/repo/docs/shot.png' }),
        ]));
        expect(screen.findAllByType('NativeImage').some(image => image.props.source.uri.startsWith('file:///markdown-preview/'))).toBe(true);
        const image = screen.findAllByType('NativeImage').find(node => node.props.source.uri.startsWith('file:///markdown-preview/'))!;
        expect(fs.files.get(image.props.source.uri)).toEqual([97, 98, 99]);
        await act(async () => { screen.findAllByTestId('markdown-image-open')[0]!.props.onPress(); });
        const { Modal } = await import('@/modal');
        expect(Modal.show).toHaveBeenLastCalledWith(expect.objectContaining({ chrome: expect.objectContaining({ kind: 'stage' }),
            props: expect.objectContaining({ items: [expect.objectContaining({ source: expect.objectContaining({
                source: expect.objectContaining({ kind: 'workspace', scope: expect.objectContaining(fixture.scope), filePath: 'docs/shot.png' }),
            }) })] }) }));
        await screen.unmount();
    });

    it('does not infer workspace authority for a plugin without an admitted workspace target', async () => {
        const { Markdown } = await import('@happier-dev/plugin-ui/components');
        const { PluginUiPresentationHostProviderInternal } = await import('../../../../../packages/plugin-ui/src/presentationHost/context');
        const { createPluginUiPrivatePresentationHost } = await import('@/components/plugins/surfaces/pluginUiPrivatePresentationHost');
        const screen = await renderScreen(<PluginUiPresentationHostProviderInternal host={createPluginUiPrivatePresentationHost(undefined)}>
            <Markdown value="![Plugin](./shot.png)" images={{ resolve: () => ({ kind: 'workspace', path: 'docs/shot.png' }), remoteLoaded: false, onLoadRemote() {} }} />
        </PluginUiPresentationHostProviderInternal>);
        expect(screen.findAllByTestId('markdown-image-open')).toHaveLength(0);
        expect(transfer.prepares).toHaveLength(0);
        await screen.unmount();
    });
});
