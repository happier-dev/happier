import * as React from 'react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { standardCleanup } from '@/dev/testkit';
import { createSessionFilesViewFixture, fileViewSnapshot, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';

installSessionFilesViewBoundaries();
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit')).createExpoVectorIconsMock());
vi.mock('@/text', async () => (await import('@/dev/testkit')).createTextModuleMock({ translate: key => key }));
const { ProjectBrowseFilesSurface } = await import('./ProjectBrowseFilesSurface');
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>> | undefined;
beforeAll(prepareSessionFilesViewTestkit);
afterEach(async () => { standardCleanup(); await fixture?.dispose(); });

it('keeps the Files companion browsing while promoting a literal file to existing Details', async () => {
    const rootPath = '/files-companion-promotion';
    fixture = await createSessionFilesViewFixture({ rootPath, rpc: request => {
        if (request.method === RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY) {
            const path = (request.payload as { path: string }).path;
            return { ok: true, path, truncated: false, entries: [{ name: 'name ', path: `${path}/name `, type: 'file' }] };
        }
        if (request.method === RPC_METHODS.SCM_STATUS_SNAPSHOT) return { success: true, snapshot: fileViewSnapshot({ rootPath }) };
        if (request.method === RPC_METHODS.SCM_HISTORY_ENTRIES) return { success: true, headOid: null,
            entries: (request.payload as { paths: string[] }).paths.map(path => ({ path, kind: 'none' })) };
        return { success: false, errorCode: 'FEATURE_UNSUPPORTED' };
    } });
    const { useRepositoryTreeBrowserState } = await import('@/hooks/workspaces/files/repositoryTreeBrowserState');
    const { tryBuildWorkspaceCacheKey } = await import('@/sync/domains/workspaces/workspaceScope');
    const scopeKey = tryBuildWorkspaceCacheKey(fixture.scope)!;
    function ExistingCodeLocation() {
        const { setLocation } = useRepositoryTreeBrowserState(scopeKey);
        React.useEffect(() => setLocation({ path: 'nested/existing', kind: 'file' }), [setLocation]);
        return null;
    }
    const onOpenFile = vi.fn<(path: string) => void>();
    const screen = await fixture.render(<><ExistingCodeLocation /><ProjectBrowseFilesSurface scopeId="companion-test" scope={fixture.scope}
        workspaceRef={{ id: 'companion-project', ...fixture.scope, createdAtMs: 1 }}
        onOpenFile={onOpenFile} onOpenFilePinned={() => {}} /></>);
    const rowId = `repository-tree-row-${toTestIdSafeValue('nested/name ')}`;
    await vi.waitFor(() => expect(screen.findByTestId(rowId)).toBeTruthy());
    await screen.pressByTestIdAsync(rowId);
    expect(onOpenFile).toHaveBeenCalledWith('nested/name ');
    expect(screen.findByTestId('workspace-code-table')).toBeTruthy();
    expect(screen.findByTestId('workspace-code-file')).toBeNull();
    const onNavigate = vi.fn();
    await screen.update(fixture.wrap(<ProjectBrowseFilesSurface scopeId="companion-test" scope={fixture.scope}
        workspaceRef={{ id: 'companion-project', ...fixture.scope, createdAtMs: 1 }}
        location={{ path: 'nested', kind: 'folder' }} onNavigate={onNavigate}
        onOpenFile={onOpenFile} onOpenFilePinned={() => {}} />));
    await screen.pressByTestIdAsync(rowId);
    expect(onNavigate).toHaveBeenCalledWith({ path: 'nested/name ', kind: 'file' });
    expect(onOpenFile).toHaveBeenCalledTimes(1);
});
