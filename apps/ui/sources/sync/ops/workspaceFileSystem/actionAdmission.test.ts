import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { act } from 'react-test-renderer';
import { createElement } from 'react';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import { installOwnMachineApprovalReplayBoundary } from '@/dev/testkit/harness/approvalInbox';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import type { ExternalActionRequesterInvocationV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
    spies: { prompt: async () => { filesystem.prompts += 1; await filesystem.promptGate; return filesystem.promptValue; },
        confirm: async () => { filesystem.prompts += 1; await filesystem.promptGate; return true; } },
}).module);
const filesystem = vi.hoisted(() => ({ paths: new Set<string>(), calls: [] as unknown[],
    response: { success: true } as unknown, error: null as unknown, nativeAsk: false,
    prompts: 0, promptValue: 'b', promptGate: null as Promise<void> | null,
    mutationGate: null as Promise<void> | null,
    fileBytes: null as Uint8Array | null, deliveredBytes: 0, carrierUnavailable: false,
    readGate: null as Promise<void> | null }));
// The finite carrier is the byte-network boundary. Real encryption, manifest
// verification, buffering, bounds and destination completion stay in the driver.
vi.mock('@/sync/domains/transfers/runtime/transferRuntime/plumbing/machineCarrierHttpLease', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/domains/transfers/runtime/transferRuntime/plumbing/machineCarrierHttpLease')>(),
    resolveMachineCarrierRoute: async (_machineId: string, serverId: string) => filesystem.carrierUnavailable
        ? { kind: 'unavailable', error: 'Finite carrier unavailable', errorCode: 'machine_carrier_unavailable' }
        : ({
        kind: 'iroh_peer', serverId, carrierKind: 'browser_stream',
        acquire: async () => {
            return { kind: 'browser_stream', release: async () => {}, request: async (input: RequestInfo | URL, init?: RequestInit) => {
                const path = new URL(String(input)).pathname;
                const bytes = filesystem.fileBytes;
                if (!bytes) throw new Error('No fixture bytes');
                const hash = Buffer.from(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer)).toString('hex');
                if (path.endsWith('/open')) {
                    return Response.json({ transferId: 'bounded-read', totalChunks: Math.ceil(bytes.length / (512 * 1024)), sizeBytes: bytes.length, manifestHash: `sha256:${hash}` });
                }
                const chunkMatch = /\/chunks\/(\d+)$/u.exec(path);
                if (chunkMatch) {
                    const sequence = Number(chunkMatch[1]);
                    const payload = bytes.slice(sequence * 512 * 1024, (sequence + 1) * 512 * 1024);
                    const { createEncryptedTransferChunkEnvelope } = await import('@/sync/domains/transfers/runtime/transferRuntime/plumbing/transferChunkEncryption');
                    const chunk = await createEncryptedTransferChunkEnvelope({ transferId: 'bounded-read', sequence, payload,
                        recipientPublicKeyBase64: new Headers(init?.headers).get('x-happier-transfer-recipient-public-key')! });
                    filesystem.deliveredBytes += payload.length;
                    return Response.json({ transferId: 'bounded-read', kind: 'chunk', sequence, ...chunk });
                }
                return Response.json({ success: true });
            } };
        },
    }),
    rebaseMachineCarrierHttpEndpoint: () => { throw new Error('Browser stream must retain its carrier'); },
}));
type FilesystemBoundaryRequest = { method: string; requestId?: string; serverId?: string; accountId?: string;
    machineId: string; signal?: AbortSignal | null;
    payload: { path?: string; from?: string; to?: string; offset?: number; length?: number; destination?: { destinationId: string };
        input?: { destination?: { destinationId: string } } } };

// The physical Machine filesystem remains the boundary for authenticated HTTP
// delivery, ordinary metadata RPCs and approved daemon replay.
async function receiveFilesystemRequest(request: FilesystemBoundaryRequest, invocation?: ExternalActionRequesterInvocationV1) {
        filesystem.calls.push(request);
        if (filesystem.error) throw filesystem.error;
        if (request.method === 'daemon.filesystem.writeFile' || request.method === 'daemon.filesystem.createDirectory') await filesystem.mutationGate;
        if (filesystem.fileBytes) {
            const bytes = filesystem.fileBytes;
            if (request.method === 'statFile') return { success: true, exists: true, kind: 'file', sizeBytes: bytes.length };
            if (request.method === 'daemon.filesystem.readFile') {
                await filesystem.readGate;
                if (request.payload.length !== undefined) {
                    if (request.payload.length > 2_500_000) return { success: false, error: 'Requested range is too large to read' };
                    const offset = request.payload.offset ?? 0;
                    const range = bytes.slice(offset, offset + request.payload.length);
                    return { success: true, content: Buffer.from(range).toString('base64'), sizeBytes: bytes.length,
                        eof: offset + range.length >= bytes.length };
                }
                return bytes.length > 2_500_000
                    ? { success: false, error: 'File exceeds daemon inline read ceiling' }
                    : { success: true, content: Buffer.from(bytes).toString('base64') };
            }
            if (request.method === 'daemon.filesystem.download') {
                const hash = Buffer.from(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer)).toString('hex');
                const expiresAt = Date.now() + 60_000;
                return { success: true, status: 'accepted', operationId: 'bounded-read',
                    destinationId: (request.payload.destination ?? request.payload.input?.destination)?.destinationId,
                    prepared: { transferId: 'bounded-read', name: 'file', sizeBytes: bytes.length, manifestHash: `sha256:${hash}`, expiresAt,
                        endpointCandidates: [{ kind: 'http', url: 'http://127.0.0.1:46001/machine-transfers/direct/Ym91bmRlZC1yZWFk', expiresAt }] } };
            }
        }
        if (filesystem.nativeAsk) {
            // This is the receiving Machine boundary. Keep its strict origin
            // admission real: an uncorrelated RPC cannot create approval custody.
            const { buildApprovalExecutionOriginV1 } = await import('@happier-dev/protocol/actions/actionExecutor');
            const { ActionIdSchema } = await import('@happier-dev/protocol/actions/actionIds');
            const origin = buildApprovalExecutionOriginV1({ actionId: ActionIdSchema.parse(request.method), input: request.payload,
                targetSessionId: null, context: { surface: invocation?.surface ?? 'rpc', authority: invocation?.authority ?? 'present_user', serverId: request.serverId,
                    ...(invocation ? { actionCaller: invocation.caller } : {}),
                    runtimeAccountId: request.accountId, actionRequestId: request.requestId,
                    externalActionTarget: { kind: 'machine', machineId: request.machineId } } });
            return origin ? { kind: 'approval_request_created', artifactId: 'native-approval', actionId: request.method }
                : { ok: false, errorCode: 'approval_origin_unavailable', error: 'approval_origin_unavailable' };
        }
        if (request.method === 'daemon.filesystem.createDirectory' && request.payload.path) filesystem.paths.add(request.payload.path);
        if (request.method === 'daemon.filesystem.rename' && request.payload.from && request.payload.to) {
            filesystem.paths.delete(request.payload.from); filesystem.paths.add(request.payload.to);
        }
        if (request.method === 'daemon.filesystem.delete' && request.payload.path) filesystem.paths.delete(request.payload.path);
        return filesystem.response;
}
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (request: FilesystemBoundaryRequest) => receiveFilesystemRequest(request),
}));
const { storage } = await import('@/sync/domains/state/storage');
const { ActionsSettingsV1Schema } = await import('@happier-dev/protocol/actions/actionSettings');
const { workspaceCreateDirectory } = await import('./directoryBrowsing');
const { workspaceListDirectory, workspaceGetDirectoryTree } = await import('./directoryBrowsing');
const { workspaceReadFile, workspaceWriteFile } = await import('./fileReadWrite');
const { workspaceRenamePath, workspaceDeletePath } = await import('./pathMetadataMutations');
type Target = Parameters<typeof workspaceCreateDirectory>[0];
const operations = [
    { actionId: 'daemon.filesystem.createDirectory' as const, run: (target: Target) => workspaceCreateDirectory(target, 'folder'), after: ['/repo/a', '/repo/folder'] },
    { actionId: 'daemon.filesystem.rename' as const, run: (target: Target) => workspaceRenamePath(target, { from: 'a', to: 'b', overwrite: false }), after: ['/repo/b'] },
    { actionId: 'daemon.filesystem.delete' as const, run: (target: Target) => workspaceDeletePath(target, { path: 'a', recursive: false }), after: [] },
];
let serverId: string;
let target: Target;
let accountScope: ServerAccountScope;
beforeEach(async () => {
    await homes.reset(); await loadSyncSingletonForTests();
    serverId = await homes.addHome({ name: 'Filesystem Home', serverUrl: 'https://filesystem-action.test',
        serverIdentityId: 'srv_filesystem_action', accountId: 'account-a', currentAccount: true });
    await installOwnMachineApprovalReplayBoundary({ harness: homes, serverId, accountId: 'account-a', machineId: 'machine-a' });
    const { getActionSpec } = await import('@happier-dev/protocol/actions/actionSpecs');
    for (const actionId of ['daemon.filesystem.readFile', 'daemon.filesystem.writeFile', 'daemon.filesystem.createDirectory',
        'daemon.filesystem.rename', 'daemon.filesystem.delete', 'daemon.filesystem.listDirectory',
        'daemon.filesystem.getDirectoryTree', 'daemon.filesystem.upload', 'daemon.filesystem.download'] as const) {
        const boundary = await createExternalActionAccountHttpBoundary({ serverUrl: 'https://filesystem-action.test',
            serverIdentityId: 'srv_filesystem_action', accountId: 'account-a', machineId: 'machine-a', actionId, tokenEpoch: 0,
            execute: async (input, context) => {
                expect(context.invocation).toMatchObject({ surface: 'ui', authority: 'present_user', caller: { kind: 'host' } });
                return await receiveFilesystemRequest({ method: getActionSpec(actionId).bindings!.rpcMethod!,
                    requestId: context.requestId, serverId, accountId: 'account-a', machineId: 'machine-a',
                    signal: context.signal, payload: input as FilesystemBoundaryRequest['payload'] }, context.invocation);
            },
        });
        homes.answer(serverId, '/v1/machines', { body: [boundary.machine] });
        homes.answer(serverId, 'GET /v1/machines/machine-a', { body: { machine: boundary.machine } });
        for (const path of [`/v1/actions/${actionId}/execution-authorization`, `/v1/actions/${actionId}`]) {
            homes.answer(serverId, path, { select: async (_input, request) => {
                const response = await boundary.handle(new URL(request.url), request.init);
                if (!response) throw new Error(`Unhandled filesystem HTTP boundary: ${request.url}`);
                return { status: response.status, body: await response.json() };
            } });
        }
    }
    const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
    await restoreConnectionToActiveServer({ token: homes.findByServerUrl('https://filesystem-action.test')!.token! });
    const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
    const restoredScope = getActiveServerAccountScope();
    if (!restoredScope) throw new Error('Expected restored filesystem Account');
    accountScope = restoredScope;
    target = { serverId, machineId: 'machine-a', rootPath: '/repo' };
    filesystem.paths.clear(); filesystem.paths.add('/repo/a'); filesystem.calls.length = 0;
    filesystem.response = { success: true }; filesystem.error = null; filesystem.nativeAsk = false;
    filesystem.prompts = 0; filesystem.promptValue = 'b'; filesystem.promptGate = null;
    filesystem.fileBytes = null; filesystem.deliveredBytes = 0; filesystem.carrierUnavailable = false;
    filesystem.mutationGate = null; filesystem.readGate = null;
});
afterEach(async () => {
    vi.useRealTimers();
    await standardCleanup();
    const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
    await disconnectActiveServerConnection(); await homes.reset();
});

describe('shared workspace filesystem Action admission', () => {
    it('reads exact ranged slices of a larger file through admission, including tail and past EOF', async () => {
        const bytes = Uint8Array.from({ length: 3_000_019 }, (_, index) => index % 256);
        filesystem.fileBytes = bytes;
        filesystem.carrierUnavailable = true;
        for (const range of [
            { offset: 17, length: 300_000 },
            { offset: bytes.length - 3, length: 7 },
            { offset: bytes.length + 1, length: 7 },
        ]) {
            const expected = bytes.slice(range.offset, range.offset + range.length);
            const read = await workspaceReadFile(target, 'large.log', { range });
            expect(read.success, !read.success ? read.error : undefined).toBe(true);
            if (!read.success) throw new Error('Expected an admitted byte range');
            expect({ sizeBytes: read.sizeBytes, eof: read.eof }).toEqual({
                sizeBytes: bytes.length, eof: range.offset + expected.length >= bytes.length,
            });
            expect(Buffer.from(read.content, 'base64').equals(Buffer.from(expected))).toBe(true);
        }
        expect(filesystem.calls).not.toContainEqual(expect.objectContaining({ method: 'daemon.filesystem.download' }));
        expect(filesystem.deliveredBytes).toBe(0);
    });

    it.each([3, 300_000])('reads a requested range of %i bytes inline and retains total size and EOF through Action admission', async length => {
        const content = Buffer.alloc(length, 0xa5).toString('base64');
        filesystem.response = { success: true, content, sizeBytes: 38_000_000, eof: false };
        expect(await workspaceReadFile(target, 'large.log', { range: { offset: 17, length }, ...(length === 3 ? { maxBytes: 2_500_000 } : {}) }))
            .toEqual({ success: true, content, sizeBytes: 38_000_000, eof: false });
        expect(filesystem.calls).toContainEqual(expect.objectContaining({ method: 'daemon.filesystem.readFile',
            payload: { rootPath: '/repo', path: '/repo/large.log', offset: 17, length } }));
        expect(filesystem.calls).not.toContainEqual(expect.objectContaining({ method: 'statFile' }));
    });

    it('rejects a short ranged response unless the daemon reports EOF', async () => {
        filesystem.response = { success: true, content: 'YQ==', sizeBytes: 10, eof: false };
        expect(await workspaceReadFile(target, 'large.log', { range: { offset: 2, length: 3 } }))
            .toMatchObject({ success: false });
        filesystem.response = { success: true, content: 'YQ==', sizeBytes: 10, eof: true };
        expect(await workspaceReadFile(target, 'large.log', { range: { offset: 2, length: 3 } }))
            .toMatchObject({ success: false });
        expect(await workspaceReadFile(target, 'large.log', { range: { offset: 9, length: 3 } }))
            .toEqual({ success: true, content: 'YQ==', sizeBytes: 10, eof: true });
    });

    it.each(['unmount', 'replace'] as const)('retires a Project README read without an unhandled AbortError on %s', async retirement => {
        const { useCodeTextFile } = await import('@/components/projects/files/code/useCodeTextFile');
        filesystem.fileBytes = new TextEncoder().encode('A project README');
        let finishRead!: () => void;
        filesystem.readGate = new Promise<void>(resolve => { finishRead = resolve; });
        const hook = await renderHook(({ path }) => useCodeTextFile({ ...target, serverId }, path), {
            initialProps: { path: 'README.md' as string | null },
        });
        try {
            await vi.waitFor(() => expect(filesystem.calls).toContainEqual(expect.objectContaining({
                method: 'daemon.filesystem.readFile',
            })));
            if (retirement === 'unmount') {
                await hook.unmount();
            } else {
                filesystem.fileBytes = new TextEncoder().encode('The next README');
                filesystem.readGate = null;
                await hook.rerender({ path: 'nested/README.md' });
                await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ kind: 'ready', text: 'The next README', viewer: { kind: 'markdown' } }));
            }
            finishRead();
            await act(async () => { await new Promise<void>(resolve => setImmediate(resolve)); });
            if (retirement === 'replace') expect(hook.getCurrent()).toMatchObject({ kind: 'ready', text: 'The next README', viewer: { kind: 'markdown' } });
        } finally {
            finishRead();
            await hook.unmount();
        }
    });

    it.each(['session', 'project'] as const)('opens a tiny Search hit in the %s viewer at its seeded Find line without a finite carrier', async host => {
        const text = 'riverglassneedle first landing\nriverglassneedle second landing\nriverglassneedle third landing';
        filesystem.fileBytes = new TextEncoder().encode(text);
        filesystem.carrierUnavailable = true;
        const { activateUniversalSearchResult } = await import('@/components/appShell/search/activateUniversalSearchResult');
        const { parseSessionPaneUrlState } = await import('@/components/sessions/panes/url/sessionPaneUrlState');
        const { createWorkspaceActionAdapter } = await import('@/components/appShell/workspace/workspaceActions');
        const { createWorkspaceNavigationAdapter } = await import('@/components/appShell/workspace/workspaceNavigationAdapter');
        const { createWorkspaceState, reduceWorkspaceState } = await import('@/components/appShell/workspace/workspaceState');
        const { resolveCompactAppDestinations } = await import('@/components/appShell/destinations/compactAppDestinationCatalog');
        const { createFileFindSeedHandoff } = await import('@/components/appShell/panes/fileFindSeedHandoff');
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { refreshWorkspaceFileDetails } = await import('@/components/workspaces/files/details/workspaceFileDetails/refreshWorkspaceFileDetails');
        const { FileViewerFindSurface } = await import('@/components/workspaces/files/details/FileViewerFindSurface');
        const { CodeLinesViewCore } = await import('@/components/ui/code/view/CodeLinesViewCore');
        const { buildCodeLinesFromFile } = await import('@/components/ui/code/model/buildCodeLinesFromFile');
        const handoff = createFileFindSeedHandoff();
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Expected admitted Account');
        const scope = { ...target, serverId: lifetime.scope.serverId };
        const destination = { host, id: 'search-destination', accountId: 'account-a', scope, path: 'riverglass.txt' };
        const anchor = { kind: 'fileLine' as const, startLine: 2 };
        const find = { query: 'riverglassneedle', options: { matchCase: false, regex: false },
            target: { kind: 'file' as const, path: destination.path, anchor } };
        let workspace = createWorkspaceState({ id: 'search-view', target: { kind: 'session',
            params: { id: destination.id, serverId: scope.serverId } }, pinned: false, preview: false });
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
            externalSessions: false, inbox: true, workflows: false, friends: false } });
        const navigation = createWorkspaceNavigationAdapter({ getState: () => workspace, getCatalog: () => catalog,
            getScope: () => lifetime.scope, dispatch: action => { workspace = reduceWorkspaceState(workspace, action); },
            transport: { commit: () => {} }, createId: () => 'search-file-view', onChange: () => {} });
        const execute = createWorkspaceActionAdapter({ getState: () => workspace, navigation, readCanvas: () => null,
            createId: () => 'search-file-view', chatFind: { handoff, resolveAuthority: requestedServerId =>
                requestedServerId === lifetime.scope.serverId ? lifetime : null } });
        try {
            expect(await activateUniversalSearchResult({ kind: 'workspaceFile', scope, serverId, accountId: 'account-a',
                sessionId: host === 'session' ? destination.id : null, workspaceRefId: host === 'project' ? destination.id : null,
                path: destination.path, anchor, find }, {
                push: () => { throw new Error('A file result must use the file Action'); },
                navigateToSession: () => { throw new Error('A file result must use the file Action'); },
                openProject: async () => { throw new Error('A file result must use the file Action'); },
                openFile: async ({ path, ...address }, options) => (await execute('workspace.tabs.open', {
                    file: { target: address, path, anchor: options?.anchor, anchorSource: options?.anchorSource },
                    mode: 'preview', find: options?.find,
                })).ok,
            })).toEqual({ ok: true });
            const opened = workspace.tabs[workspace.groups[workspace.focusedGroupId].activeTabId].target;
            if (host === 'session') {
                expect(parseSessionPaneUrlState(opened.params)?.details).toMatchObject({ kind: 'file', path: destination.path, anchor });
            } else {
                expect(opened).toMatchObject({ kind: 'project', params: { workspaceRefId: destination.id,
                    initialFile: destination.path, anchor: 'fileLine', startLine: '2' } });
            }
            expect(JSON.stringify(workspace)).not.toContain(find.query);
            const loaded = await refreshWorkspaceFileDetails({ scope, filePath: destination.path, diffMode: 'both', includeDiff: false });
            expect(loaded.error).toBeNull();
            expect(loaded.fileContent?.content).toBe(text);
            const seed = handoff.take(destination);
            expect(seed).toEqual(find);
            const screen = await renderScreen(createElement(FileViewerFindSurface, {
                surfaceId: 'search-file', active: true, content: { path: destination.path, mode: 'file', text: loaded.fileContent?.content ?? null },
                findSeed: seed,
                children: snapshot => createElement(CodeLinesViewCore, { lines: buildCodeLinesFromFile({ text: loaded.fileContent?.content ?? '' }),
                    virtualized: false, findRangesByLineId: snapshot.lineRanges, scrollToLineId: snapshot.lineTarget ?? undefined }),
            }));
            expect(screen.findByTestId('file-viewer-find.input')?.props.value).toBe(find.query);
            expect(screen.findAllHostsByTestId('find-match-current').map(node => node.children.join(''))).toContain(find.query);
            expect(screen.findByType(CodeLinesViewCore).props.scrollToLineId).toBe('f:2');
            expect(filesystem.deliveredBytes).toBe(0);
            expect(filesystem.calls).toContainEqual(expect.objectContaining({ method: 'daemon.filesystem.readFile' }));
            expect(filesystem.calls.filter(call => (call as { method: string }).method === 'statFile')).toHaveLength(1);
            await screen.unmount();
        } finally { handoff.dispose(); }
    });
    it('keeps a cold viewer loading beyond 15 seconds and publishes the successful inline read', async () => {
        const text = 'riverglassneedle late success';
        filesystem.fileBytes = new TextEncoder().encode(text);
        filesystem.carrierUnavailable = true;
        let finishRead!: () => void;
        filesystem.readGate = new Promise(resolve => { finishRead = resolve; });
        const { useWorkspaceFileDetailsLoading } = await import('@/components/workspaces/files/details/workspaceFileDetails/useWorkspaceFileDetailsLoading');
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const viewer = await renderHook(() => useWorkspaceFileDetailsLoading({ scope: { ...target, serverId },
            filePath: 'riverglass.txt', diffMode: 'both', includeDiff: false, isActive: true, refreshFingerprint: 'cold' }));
        await vi.waitFor(() => expect(filesystem.calls).toContainEqual(expect.objectContaining({ method: 'daemon.filesystem.readFile' })));
        await act(async () => { await vi.advanceTimersByTimeAsync(16_000); });
        expect(viewer.getCurrent().error).toBeNull();
        expect(viewer.getCurrent().isLoading).toBe(true);
        expect(viewer.getCurrent().fileContent).toBeNull();
        await act(async () => { finishRead(); });
        await vi.waitFor(() => expect(viewer.getCurrent().fileContent?.content).toBe(text));
        expect(viewer.getCurrent().error).toBeNull();
        expect(viewer.getCurrent().isLoading).toBe(false);
        await viewer.unmount();
    });
    it.each(['file', 'folder'] as const)('New %s does not reveal or navigate a retired host after its mutation acknowledgement', async kind => {
        let release = () => {};
        filesystem.mutationGate = new Promise<void>(resolve => { release = resolve; });
        filesystem.promptValue = 'created';
        filesystem.response = kind === 'file' ? { success: true, hash: 'written' } : { success: true };
        storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({ id: target.machineId, activeAt: Date.now() })] } });
        const opened: string[] = [];
        const expanded = vi.fn();
        const { WorkspaceRepositoryTreeBrowserView } = await import('@/components/projects/files/WorkspaceRepositoryTreeBrowserView');
        const props = { onOpenFile: (path: string) => opened.push(path), onExpandedPathsChange: expanded,
            scmSnapshot: null, transferEffectsEnabled: false };
        const screen = await renderScreen(createElement(WorkspaceRepositoryTreeBrowserView, { ...props, scope: { ...target, serverId } }));
        await act(async () => {
            screen.findAllByTestId('repository-tree-create-menu').find(node => typeof node.props.onSelect === 'function')!
                .props.onSelect(`repository-tree-create-${kind}`);
            await vi.waitFor(() => expect(filesystem.calls.some(call => (call as { method: string }).method ===
                (kind === 'file' ? 'daemon.filesystem.writeFile' : 'daemon.filesystem.createDirectory'))).toBe(true));
        });
        await screen.update(createElement(WorkspaceRepositoryTreeBrowserView, { ...props, scope: { ...target, serverId, rootPath: '/other' } }));
        await act(async () => { release(); await new Promise(resolve => setTimeout(resolve, 100)); });
        expect(opened).toEqual([]);
        expect(expanded).not.toHaveBeenCalled();
        await screen.unmount();
    });
    it('a large editor write keeps its byte delivery mounted through writeFile Require and rejection', async () => {
        await homes.requireUiApproval(serverId, 'daemon.filesystem.writeFile');
        const pending = workspaceWriteFile(target, 'large.txt', 'x'.repeat(256 * 1024 + 1));
        await vi.waitFor(() => expect(homes.artifacts(serverId).list()).toHaveLength(1));
        expect(filesystem.calls).toEqual([]);
        const artifactId = homes.artifacts(serverId).list()[0]!.id;
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        expect(await createDefaultActionExecutor().execute('approval.request.decide', { artifactId, decision: 'reject' },
            { surface: 'ui', serverId })).toMatchObject({ ok: true });
        expect(await pending).toMatchObject({ success: false, errorCode: 'approval_rejected' });
        expect(filesystem.calls).toEqual([]);
    });
    it.each(['upload', 'download'] as const)('a mounted %s remains effect-free through UI Require with RPC allowed', async kind => {
        const actionId = `daemon.filesystem.${kind}` as const;
        await homes.requireUiApproval(serverId, actionId);
        const controller = new AbortController();
        const { callFilesystemTransferAction } = await import('@/sync/domains/transfers/runtime/transferRuntime/plumbing/filesystemTransferActionClient');
        const pending = callFilesystemTransferAction({ actionId, machineId: target.machineId, serverId, accountId: 'account-a', signal: controller.signal,
            input: kind === 'upload' ? { rootPath: '/repo', path: '/repo/file', source: { sourceId: 'reader', sizeBytes: 1 }, overwrite: false }
                : { rootPath: '/repo', path: '/repo/file', destination: { destinationId: 'destination' }, asZip: false },
        });
        try {
            await vi.waitFor(() => expect(homes.artifacts(serverId).list()).toHaveLength(1));
            expect(filesystem.calls).toEqual([]);
        } finally { controller.abort(); }
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        expect(filesystem.calls).toEqual([]);
    });
    it('keeps the admitted 4-MB read bound above the daemon inline ceiling and refuses its over-bound neighbor', async () => {
        // RPC download is allowed to isolate the UI read contract from native
        // policy. The UI front door and bounded byte driver remain real.
        const settings = { ...storage.getState().settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({
            v: 1, actions: { 'daemon.filesystem.download': { disabledSurfaces: ['ui'] } },
            approvalWaivedSurfaces: { 'daemon.filesystem.download': ['rpc'] },
        }) };
        storage.getState().applySettingsForScope(accountScope, settings, 1);
        homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version: 1 } });
        filesystem.fileBytes = new Uint8Array(3_000_000).fill(120);
        const read = await workspaceReadFile(target, 'file', { maxBytes: 4_000_000 });
        expect(read.success, !read.success ? read.error : undefined).toBe(true);
        if (read.success) expect(Buffer.from(read.content, 'base64').equals(Buffer.from(filesystem.fileBytes))).toBe(true);
        expect(filesystem.deliveredBytes).toBe(3_000_000);
        filesystem.deliveredBytes = 0;
        expect(await workspaceReadFile(target, 'file', { maxBytes: 2_500_000 })).toMatchObject({ success: false });
        expect(filesystem.deliveredBytes).toBe(0);
        // A changed file can outgrow the preceding stat: routing metadata must
        // never replace the final bound on the returned bytes.
        filesystem.fileBytes = new Uint8Array(300_001).fill(120);
        expect(await workspaceReadFile(target, 'file', { maxBytes: 300_000, knownSizeBytes: 94 })).toMatchObject({ success: false });
        filesystem.fileBytes = new Uint8Array([0, 255, 128]);
        expect(await workspaceReadFile(target, 'file')).toEqual({ success: true, content: 'AP+A' });
    });
    it.each(['upload', 'download'] as const)('the real %s preparation cannot reach RPC when disabled on UI', async kind => {
        const actionId = `daemon.filesystem.${kind}` as const;
        const settings = { ...storage.getState().settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({
            v: 1, actions: { [actionId]: { disabledSurfaces: ['ui'] } },
            approvalWaivedSurfaces: { [actionId]: ['rpc'] },
        }) };
        storage.getState().applySettingsForScope(accountScope, settings, 1);
        homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version: 1 } });
        const { uploadDaemonWorkspaceFileFromReader, downloadDaemonWorkspaceFileToDestination } = await import('@/sync/domains/transfers/runtime/transferRuntime/families/workspaceFileTransfers');
        const readBytes = vi.fn(async () => new Uint8Array([1]));
        const written: number[] = [];
        const result = kind === 'upload'
            ? await uploadDaemonWorkspaceFileFromReader({ ...target,
                fileReader: { sizeBytes: 1, readBytes, close: async () => {} }, request: { path: 'file', sizeBytes: 1 } })
            : await downloadDaemonWorkspaceFileToDestination({ ...target, request: { path: 'file', asZip: false },
                destination: { writeBytes: async bytes => { written.push(...bytes); }, close: async () => {}, cleanup: async () => { written.length = 0; } } });
        expect(result).toMatchObject({ errorCode: 'action_disabled' });
        expect(readBytes).not.toHaveBeenCalled();
        expect(written).toEqual([]);
        expect(filesystem.calls).toEqual([]);
    });

    it('a large editor write retains writeFile admission before starting upload', async () => {
        const settings = { ...storage.getState().settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({
            v: 1, actions: { 'daemon.filesystem.writeFile': { disabledSurfaces: ['ui'] } },
            approvalWaivedSurfaces: { 'daemon.filesystem.upload': ['ui', 'rpc'] },
        }) };
        storage.getState().applySettingsForScope(accountScope, settings, 1);
        homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version: 1 } });
        expect(await workspaceWriteFile(target, 'large.txt', 'x'.repeat(256 * 1024 + 1)))
            .toMatchObject({ success: false, errorCode: 'action_disabled' });
        expect(filesystem.calls).toEqual([]);
    });

    it.each((['file', 'folder'] as const).flatMap(kind => (['account', 'root', 'unmount'] as const).map(retirement => ({ kind, retirement }))))
        ('retires the real New $kind prompt on $retirement retirement', async ({ kind, retirement }) => {
        let release = () => {};
        filesystem.promptGate = new Promise<void>(resolve => { release = resolve; });
        filesystem.promptValue = 'created';
        filesystem.response = { success: true, entries: [] };
        storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({ id: target.machineId, activeAt: Date.now() })] } });
        const opened: string[] = [];
        const { WorkspaceRepositoryTreeBrowserView } = await import('@/components/projects/files/WorkspaceRepositoryTreeBrowserView');
        const screen = await renderScreen(createElement(WorkspaceRepositoryTreeBrowserView, {
            scope: { ...target, serverId }, onOpenFile: path => opened.push(path), scmSnapshot: null, transferEffectsEnabled: false,
        }));
        await act(async () => {
            screen.findAllByTestId('repository-tree-create-menu').find(node => typeof node.props.onSelect === 'function')!
                .props.onSelect(`repository-tree-create-${kind}`);
            await vi.waitFor(() => expect(filesystem.prompts).toBe(1));
        });
        if (retirement === 'account') {
            await act(async () => {
                await homes.switchAccount(serverId, 'account-b');
                storage.getState().activateProfileScope({ serverId, accountId: 'account-b' });
            });
        } else if (retirement === 'root') {
                await screen.update(createElement(WorkspaceRepositoryTreeBrowserView, {
                    scope: { ...target, serverId, rootPath: '/other' }, onOpenFile: path => opened.push(path), scmSnapshot: null, transferEffectsEnabled: false,
                }));
        } else await screen.unmount();
        await act(async () => {
            release();
            await new Promise(resolve => setTimeout(resolve, 100));
        });
        expect(filesystem.calls.filter(call => ['daemon.filesystem.writeFile', 'daemon.filesystem.createDirectory']
            .includes((call as { method: string }).method))).toEqual([]);
        expect(opened).toEqual([]);
        expect([...filesystem.paths]).toEqual(['/repo/a']);
        if (retirement !== 'unmount') await screen.unmount();
    });
    it('Project Open preserves native approval custody through its ordinary Machine RPC', async () => {
        filesystem.nativeAsk = true;
        homes.answer(serverId, '/v1/machines', { body: [createPlainMachineRowFixture({ id: target.machineId, accountId: 'account-a' })] });
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const result = await createDefaultActionExecutor().execute('projects.open', {
            serverId, machineId: target.machineId, source: { kind: 'folder', path: target.rootPath },
            materialization: { kind: 'attach' },
        }, { surface: 'ui', serverId });
        expect(result, JSON.stringify({ result, calls: filesystem.calls })).toMatchObject({ ok: true, result: { kind: 'approval_request_created',
            artifactId: 'native-approval', actionId: 'projects.open' } });
        expect([...filesystem.paths]).toEqual(['/repo/a']);
    });

    it.each(['file', 'folder'] as const)('the real New %s control presents approval and completes only after replay', async kind => {
        const actionId = kind === 'file' ? 'daemon.filesystem.writeFile' : 'daemon.filesystem.createDirectory';
        await homes.requireUiApproval(serverId, actionId);
        const machine = createMachineFixture({ id: target.machineId, activeAt: Date.now() });
        storage.setState({ machineListByServerId: { [serverId]: [machine] } });
        filesystem.promptValue = 'created.txt';
        filesystem.response = { success: true, entries: [] };
        const alerts = vi.spyOn((await import('@/modal')).Modal, 'alert');
        const opened: string[] = [];
        const expanded = vi.fn();
        const { WorkspaceRepositoryTreeBrowserView } = await import('@/components/projects/files/WorkspaceRepositoryTreeBrowserView');
        const screen = await renderScreen(createElement(WorkspaceRepositoryTreeBrowserView, {
            scope: { ...target, serverId }, onOpenFile: path => opened.push(path), onExpandedPathsChange: expanded,
            scmSnapshot: null, transferEffectsEnabled: false,
        }));
        await act(async () => {
            const menu = screen.findAllByTestId('repository-tree-create-menu').find(node => typeof node.props.onSelect === 'function');
            expect(menu).toBeDefined();
            menu!.props.onSelect(`repository-tree-create-${kind}`);
            await vi.waitFor(() => expect(homes.artifacts(serverId).list()).toHaveLength(1));
        });
        expect(alerts).not.toHaveBeenCalled();
        expect(screen.findHostByTestId('repository-tree-action-approval')).not.toBeNull();
        expect(filesystem.calls.filter(call => (call as { method: string }).method === actionId)).toEqual([]);
        expect(opened).toEqual([]);
        expect(expanded).not.toHaveBeenCalled();
        const artifactId = homes.artifacts(serverId).list()[0]!.id;
        filesystem.response = kind === 'file' ? { success: true, hash: 'sha256:created' } : { success: true };
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const { captureActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        await act(async () => {
            const decision = await createDefaultActionExecutor().execute('approval.request.decide', { artifactId, decision: 'approve' },
                { surface: 'ui', serverId });
            expect(decision, JSON.stringify({ decision, approvalBody: homes.artifacts(serverId).readPlainBody(artifactId), calls: filesystem.calls }))
                .toMatchObject({ ok: true, result: { status: 'executed' } });
            const account = await captureActionAccountContext(serverId);
            try {
                const artifact = await account.fetchArtifact(artifactId);
                if (!artifact) throw new Error('Approval Artifact disappeared');
                // The Home change stream publishes this durable revision at the
                // store boundary; the actual mounted continuation consumes it.
                storage.getState().updateArtifact(artifact);
            } finally { account.dispose(); }
        });
        await vi.waitFor(() => kind === 'file' ? expect(opened).toEqual(['created.txt']) : expect(expanded).toHaveBeenCalledWith(['created.txt']));
        expect(filesystem.calls.filter(call => (call as { method: string }).method === actionId))
            .toEqual([expect.objectContaining({ payload: kind === 'file'
                ? { rootPath: '/repo', path: '/repo/created.txt', content: '', expectedHash: null }
                : { rootPath: '/repo', path: '/repo/created.txt' } })]);
        await screen.unmount();
    });

    it.each(operations)('$actionId retains native Ask-first custody without a cancellation signal', async operation => {
        filesystem.nativeAsk = true;
        const result = await operation.run(target);
        expect(result, JSON.stringify(result)).toMatchObject({ success: false, errorCode: 'approval_required',
            approvalArtifactId: 'native-approval' });
        expect([...filesystem.paths]).toEqual(['/repo/a']);
    });

    it('inline write retains native Ask-first custody without a cancellation signal', async () => {
        filesystem.nativeAsk = true;
        expect(await workspaceWriteFile(target, 'created.txt', 'hello')).toMatchObject({ success: false,
            errorCode: 'approval_required', approvalArtifactId: 'native-approval' });
        expect([...filesystem.paths]).toEqual(['/repo/a']);
    });

    it('opens a bounded file through the Action RPC when the machine is relay-only', async () => {
        filesystem.response = { success: true, content: 'IyBSRUFETUU=' };
        const controller = new AbortController();

        expect(await workspaceReadFile(target, 'README.md', { maxBytes: 12, signal: controller.signal })).toEqual({
            success: true,
            content: 'IyBSRUFETUU=',
        });
        expect(filesystem.calls).toEqual([expect.objectContaining({
            method: 'daemon.filesystem.readFile',
            payload: { rootPath: '/repo', path: '/repo/README.md' },
            signal: expect.any(AbortSignal),
        })]);
        expect(filesystem.calls[0]).toMatchObject({ signal: { aborted: false } });
    });

    it('keeps the caller bound on a relay Action read', async () => {
        filesystem.response = { success: true, content: 'YWJj' };

        expect(await workspaceReadFile(target, 'README.md', { maxBytes: 2 })).toEqual({
            success: false,
            error: 'File exceeds the inline file read size limit',
        });
        expect(filesystem.calls).toEqual([expect.objectContaining({
            method: 'daemon.filesystem.readFile',
            payload: { rootPath: '/repo', path: '/repo/README.md' },
        })]);
    });

    it('routes bounded directory reads through the same Action policy choke point', async () => {
        filesystem.response = { success: true, entries: [] };
        expect(await workspaceListDirectory(target, 'src')).toEqual({ success: true, entries: [] });
        filesystem.response = { success: true, tree: { name: 'src', path: '/repo/src', type: 'directory' } };
        expect(await workspaceGetDirectoryTree(target, 'src', 2)).toMatchObject({ success: true, tree: { name: 'src' } });
        expect(filesystem.calls).toEqual([
            expect.objectContaining({ method: 'listDirectory', payload: { rootPath: '/repo', path: '/repo/src' } }),
            expect.objectContaining({ method: 'daemon.filesystem.getDirectoryTree', payload: { rootPath: '/repo', path: '/repo/src', maxDepth: 2 } }),
        ]);
    });

    it('keeps an inline file write behind Ask-first admission and executes the exact rooted bytes only after approval', async () => {
        await homes.requireUiApproval(serverId, 'daemon.filesystem.writeFile');
        const pending = await workspaceWriteFile(target, 'created.txt', 'hello');
        expect(pending).toMatchObject({ success: false, errorCode: 'approval_required', approvalArtifactId: expect.any(String) });
        expect(filesystem.calls).toEqual([]);
        if (!('approvalArtifactId' in pending) || typeof pending.approvalArtifactId !== 'string') throw new Error('Expected approval custody');
        filesystem.response = { success: true, hash: 'sha256:inline' };
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const decision = await createDefaultActionExecutor().execute('approval.request.decide', {
            artifactId: pending.approvalArtifactId, decision: 'approve',
        }, { surface: 'ui', serverId });
        expect(decision, JSON.stringify(decision)).toMatchObject({ ok: true, result: { status: 'executed' } });
        expect(filesystem.calls).toEqual([expect.objectContaining({ method: 'daemon.filesystem.writeFile', payload: {
            rootPath: '/repo', path: '/repo/created.txt', content: 'aGVsbG8=',
        } })]);
    });

    it.each(['rename', 'delete'] as const)('retires the real %s prompt before it can borrow a newly signed-in Account', async operation => {
        let release = () => {};
        filesystem.promptGate = new Promise<void>(resolve => { release = resolve; });
        const { useWorkspaceRepositoryTreeRowActions } = await import('@/hooks/workspaces/files/useWorkspaceRepositoryTreeRowActions');
        const hook = await renderHook(() => useWorkspaceRepositoryTreeRowActions({
            workspaceScope: { ...target, serverId }, writeActionsEnabled: true,
            expandedPaths: [], onExpandedPathsChange: () => {},
        }));
        await act(async () => {
            const pending = hook.getCurrent().onSelectRowMenuItem({ path: 'a', type: 'file' }, operation === 'rename'
                ? 'repository-tree-menuitem-rename' : 'repository-tree-menuitem-delete');
            await vi.waitFor(() => expect(filesystem.prompts).toBe(1));
            await homes.switchAccount(serverId, 'account-b');
            storage.getState().activateProfileScope({ serverId, accountId: 'account-b' });
            release();
            await pending;
        });
        expect([...filesystem.paths]).toEqual(['/repo/a']);
        expect(filesystem.calls).toEqual([]);
        await hook.unmount();
    });
    it('preserves literal selected tilde-directory names and explicit rooted choices through admission', async () => {
        await workspaceRenamePath(target, { from: '~/line\nbreak ', to: '~/renamed ' });
        await workspaceDeletePath(target, { path: '~/line\nbreak ', recursive: true });
        await workspaceCreateDirectory(target, '~');
        expect(filesystem.calls).toEqual([
            expect.objectContaining({ method: 'daemon.filesystem.rename', payload: {
                rootPath: '/repo', from: '/repo/~/line\nbreak ', to: '/repo/~/renamed ', overwrite: false,
            } }),
            expect.objectContaining({ method: 'daemon.filesystem.delete', payload: {
                rootPath: '/repo', path: '/repo/~/line\nbreak ', recursive: true,
            } }),
            expect.objectContaining({ method: 'daemon.filesystem.createDirectory', payload: { rootPath: '/repo', path: '/repo/~' } }),
        ]);
    });
    it('preserves a typed missing-method failure from the actual Machine boundary', async () => {
        filesystem.error = Object.assign(new Error('Method not found'), { rpcErrorCode: 'RPC_METHOD_NOT_FOUND' });
        const result = await workspaceCreateDirectory(target, 'folder');
        expect(result, JSON.stringify(result)).toMatchObject({ success: false, errorCode: 'RPC_METHOD_NOT_FOUND' });
        expect([...filesystem.paths]).toEqual(['/repo/a']);
    });
    it('refuses an invalid Machine response rather than reporting a completed folder', async () => {
        filesystem.response = null;
        const result = await workspaceCreateDirectory(target, 'folder');
        expect(result).toMatchObject({ success: false, error: expect.any(String) });
    });
    it('the real rename control retains pending approval and settles the directory expansion only after execution', async () => {
        await homes.requireUiApproval(serverId, 'daemon.filesystem.rename');
        const { useWorkspaceRepositoryTreeRowActions } = await import('@/hooks/workspaces/files/useWorkspaceRepositoryTreeRowActions');
        const alerts = vi.spyOn((await import('@/modal')).Modal, 'alert');
        const approvals: ActionApprovalRegistration[] = [];
        const refresh = vi.fn();
        const expanded = vi.fn();
        const hook = await renderHook(() => useWorkspaceRepositoryTreeRowActions({
            workspaceScope: { ...target, serverId }, writeActionsEnabled: true,
            expandedPaths: ['a', 'a/sub', 'other'], onExpandedPathsChange: expanded, onRequestRefresh: refresh,
            onActionApproval: registration => approvals.push(registration),
        }));
        await act(async () => { await hook.getCurrent().onSelectRowMenuItem({ path: 'a', type: 'directory' }, 'repository-tree-menuitem-rename'); });
        expect(approvals).toHaveLength(1);
        expect(alerts).not.toHaveBeenCalled();
        expect(refresh).not.toHaveBeenCalled();
        expect(expanded).not.toHaveBeenCalled();
        expect([...filesystem.paths]).toEqual(['/repo/a']);
        const { normalizeActionApprovalRegistration } = await import('@/components/approvals/actionApprovalContinuation');
        const registration = normalizeActionApprovalRegistration(approvals[0]);
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const decision = await createDefaultActionExecutor().execute('approval.request.decide', { artifactId: registration.artifactId, decision: 'approve' }, { surface: 'ui', serverId });
        expect(decision, JSON.stringify(decision)).toMatchObject({ ok: true, result: { status: 'executed' } });
        expect([...filesystem.paths]).toEqual(['/repo/b']);
        const { captureActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const account = await captureActionAccountContext(serverId);
        try {
            const artifact = await account.fetchArtifact(registration.artifactId);
            if (!artifact) throw new Error('Approval Artifact disappeared');
            await act(async () => { await registration.continuation?.onExecuted(artifact); });
        } finally { account.dispose(); }
        expect(expanded).toHaveBeenCalledWith(['b', 'b/sub', 'other']);
        expect(refresh).toHaveBeenCalledOnce();
        await hook.unmount();
    });
    it.each(operations)('$actionId cannot reach the machine when UI-disabled', async operation => {
        const scope = accountScope;
        const settings = { ...storage.getState().settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({
            v: 1, actions: { [operation.actionId]: { disabledSurfaces: ['ui'] } },
        }) };
        storage.getState().applySettingsForScope(scope, settings, 1);
        homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version: 1 } });
        const result = await operation.run(target);
        expect(result, JSON.stringify(result)).toMatchObject({ success: false, errorCode: 'action_disabled' });
        expect([...filesystem.paths]).toEqual(['/repo/a']);
        expect(filesystem.calls).toEqual([]);
    });

    it.each(operations)('$actionId defers its exact rooted effect until approval', async operation => {
        await homes.requireUiApproval(serverId, operation.actionId);
        // The real sync owner can reactivate this Account between publication
        // and admission. Its persisted revision must retain the Ask-first policy.
        await storage.getState().activateSettingsScope(accountScope);
        expect(storage.getState().settings.actionsSettingsV1.actions[operation.actionId]?.approvalRequiredSurfaces).toContain('ui');
        const pending = await operation.run(target);
        expect(pending, JSON.stringify(pending)).toMatchObject({ success: false, errorCode: 'approval_required', approvalArtifactId: expect.any(String) });
        expect([...filesystem.paths]).toEqual(['/repo/a']);
        expect(filesystem.calls).toEqual([]);
        if (!('approvalArtifactId' in pending) || typeof pending.approvalArtifactId !== 'string') throw new Error('Expected canonical approval custody');
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const decision = await createDefaultActionExecutor().execute('approval.request.decide', {
            artifactId: pending.approvalArtifactId, decision: 'approve',
        }, { surface: 'ui', serverId });
        expect(decision, JSON.stringify(decision)).toMatchObject({ ok: true, result: { status: 'executed' } });
        expect([...filesystem.paths].sort()).toEqual(operation.after);
        expect(filesystem.calls).toEqual([expect.objectContaining({ serverId, accountId: 'account-a', machineId: 'machine-a',
            method: operation.actionId, payload: expect.objectContaining({ rootPath: '/repo' }) })]);
    });

    it.each(operations)('$actionId keeps the ordinary allowed operation usable', async operation => {
        const result = await operation.run(target);
        expect(result, JSON.stringify(result)).toMatchObject({ success: true });
        expect([...filesystem.paths].sort()).toEqual(operation.after);
    });
});
