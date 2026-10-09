import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { DaemonFilesystemListDirectoryRequestSchema, type DaemonFilesystemListDirectoryRequest, type DaemonFilesystemListDirectoryResponse } from '@happier-dev/protocol/machines/fileBrowser';
import { useWorkspaceRepositoryTreeBrowser } from './useWorkspaceRepositoryTreeBrowser';
import { useRepositoryTreeVisibility } from './useRepositoryTreeVisibility';

const directoryRpc = vi.hoisted(() => vi.fn<(machineId: string, request: DaemonFilesystemListDirectoryRequest,
    options: Readonly<{ serverId?: string | null }>) => Promise<DaemonFilesystemListDirectoryResponse>>());
// Only the network boundary is replaced; the typed directory facade, parser, cache and lazy tree stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(async request => directoryRpc(request.machineId,
        DaemonFilesystemListDirectoryRequestSchema.parse(request.payload), { serverId: request.serverId }));
});

const scope = { serverId: 'server-1', machineId: 'm1', rootPath: '/visibility-live' };

describe('Project workspace tree', () => {
    it('shares visibility and reveal state between hosts of one qualified workspace', async () => {
        let first: ReturnType<typeof useRepositoryTreeVisibility> | undefined;
        let second: ReturnType<typeof useRepositoryTreeVisibility> | undefined;
        function Test() {
            first = useRepositoryTreeVisibility('home-a:machine:/shared-browser');
            second = useRepositoryTreeVisibility('home-a:machine:/shared-browser');
            return null;
        }
        await renderScreen(<Test />);
        await act(async () => { first?.setVisibilityMode('all'); first?.revealPath('hidden/file', { focus: true }); });
        expect(second?.visibilityMode).toBe('all');
        expect(second?.revealedPaths).toEqual(['hidden/file']);
        expect(second?.latestRequest?.path).toBe('hidden/file');
    });
    it('browses the exact requested folder without guessing entry kinds from extensions', async () => {
        directoryRpc.mockImplementation(async (_machine, request, options) => {
            expect(options?.serverId).toBe(scope.serverId);
            return { ok: true, path: request.path, truncated: false, gitIgnoreAvailable: true,
                entries: request.path === `${scope.rootPath}/nested` ? [
                    { name: 'folder.ts', path: `${request.path}/folder.ts`, type: 'directory' },
                    { name: 'LICENSE', path: `${request.path}/LICENSE`, type: 'file' },
                    { name: 'ignored.log', path: `${request.path}/ignored.log`, type: 'file', gitIgnored: true },
                ] : [] };
        });
        let api: ReturnType<typeof useWorkspaceRepositoryTreeBrowser> | undefined;
        function Test() {
            const input = { scope, enabled: true, rootDirectoryPath: 'nested', visibilityMode: 'project' as const };
            api = useWorkspaceRepositoryTreeBrowser(input);
            return null;
        }
        await renderScreen(<Test />);
        await vi.waitFor(() => expect(api?.nodes.map(node => [node.path, node.type])).toEqual([
            ['nested/folder.ts', 'directory'], ['nested/LICENSE', 'file'],
        ]));
        expect(api?.nodes.find(node => node.type === 'file')?.parentDirectoryPath).toBe('nested');
    });
    it('switches Project/All files locally and preserves revealed ignored targets', async () => {
        directoryRpc.mockImplementation(async (_machine, request) => ({
            ok: true,
            path: request.path,
            truncated: false,
            gitIgnoreAvailable: true,
            entries: request.path !== '/visibility-live' ? [] : [
                { name: 'ignored.log', path: '/visibility-live/ignored.log', type: 'file', gitIgnored: true },
                { name: '.env.example', path: '/visibility-live/.env.example', type: 'file', gitIgnored: false },
            ],
        }));
        let api: ReturnType<typeof useWorkspaceRepositoryTreeBrowser> | undefined;
        function Test({ mode, preservedPaths = [] }: { mode: 'project' | 'all'; preservedPaths?: string[] }) {
            api = useWorkspaceRepositoryTreeBrowser({ scope, enabled: true, visibilityMode: mode, preservedPaths });
            return null;
        }
        const screen = await renderScreen(<Test mode="project" />);
        await act(async () => {});
        expect(api?.nodes.map(n => n.path)).toEqual(['.env.example']);
        expect(api?.gitIgnoreAvailable).toBe(true);
        directoryRpc.mockClear();
        await act(async () => { screen.update(<Test mode="all" />); });
        expect(api?.nodes.map(n => n.path)).toEqual(['.env.example', 'ignored.log']);
        await act(async () => { screen.update(<Test mode="project" preservedPaths={['ignored.log']} />); });
        expect(api?.nodes.map(n => n.path)).toEqual(['.env.example', 'ignored.log']);
        expect(directoryRpc).not.toHaveBeenCalled();
    });
    it('keeps authorized last-known rows when machine reads are disabled', async () => {
        const offlineScope = { ...scope, rootPath: '/last-known-browser' };
        directoryRpc.mockResolvedValue({ ok: true, path: offlineScope.rootPath,
            truncated: false, entries: [{ name: 'LICENSE', path: `${offlineScope.rootPath}/LICENSE`, type: 'file' }] });
        let api: ReturnType<typeof useWorkspaceRepositoryTreeBrowser> | undefined;
        function Test({ enabled }: { enabled: boolean }) { api = useWorkspaceRepositoryTreeBrowser({ scope: offlineScope, enabled }); return null; }
        const screen = await renderScreen(<Test enabled />);
        await vi.waitFor(() => expect(api?.nodes.map(node => node.path)).toEqual(['LICENSE']));
        directoryRpc.mockClear();
        await act(async () => screen.update(<Test enabled={false} />));
        expect(api?.nodes.map(node => node.path)).toEqual(['LICENSE']);
        expect(directoryRpc).not.toHaveBeenCalled();
    });
});
