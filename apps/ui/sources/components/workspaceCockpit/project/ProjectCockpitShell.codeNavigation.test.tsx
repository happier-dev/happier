import * as React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { standardCleanup } from '@/dev/testkit';
import { createSessionFilesViewFixture, fileViewSnapshot, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';

installSessionFilesViewBoundaries();
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }));

const { ProjectCockpitShell } = await import('./ProjectCockpitShell');

describe('the mounted Project Code destination', () => {
    let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>> | undefined;
    beforeAll(prepareSessionFilesViewTestkit);
    afterEach(async () => { standardCleanup(); await fixture?.dispose(); });

    it('pushes literal folder/file locations, restores route Back/up, and opens qualified History', async () => {
        const rootPath = '/project-code-route';
        fixture = await createSessionFilesViewFixture({ rootPath, rpc: request => {
            if (request.method === RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY) {
                const path = (request.payload as { path: string }).path;
                return { ok: true, path, truncated: false, entries: path === rootPath
                    ? [{ name: 'dir.with.dot', path: `${path}/dir.with.dot`, type: 'directory' }]
                    : [{ name: 'LICENSE', path: `${path}/LICENSE`, type: 'file' }] };
            }
            if (request.method === RPC_METHODS.SCM_STATUS_SNAPSHOT) return { success: true, snapshot: fileViewSnapshot({ rootPath }) };
            if (request.method === RPC_METHODS.SCM_HISTORY_ENTRIES) return { success: true, headOid: 'a'.repeat(40),
                entries: (request.payload as { paths: string[] }).paths.map(path => ({ path, kind: 'commit', commit: {
                    oid: 'b'.repeat(40), subject: `touch ${path}`, authorName: 'Author', committedAt: 1000,
                } })) };
            return { success: false, errorCode: 'FEATURE_UNSUPPORTED', error: 'Unavailable boundary operation' };
        } });
        const navigations: string[] = [];
        const ref = { id: 'code-project', ...fixture.scope, label: 'Code', createdAtMs: 1 };
        function PaneProbe() {
            const pane = useAppPaneScope('project-code-route');
            return React.createElement('CodePaneProbe', { details: pane.scopeState?.details });
        }
        const renderLocation = (params: Record<string, string> = {}) => <DestinationInstanceHost tabId="code-route"
            ref={{ kind: 'project', params: { workspaceRefId: ref.id, serverId: ref.serverId, ...params } }}
            pathname={`/projects/${ref.id}/code`} focused visible navigation={{ push: href => navigations.push(String(href)),
                replace: () => {}, back: () => {}, setParams: () => {} }}>
            <ProjectCockpitShell workspaceRef={ref} scopeId="project-code-route" activeRootPath={rootPath}
                surface="code" isFocused onSelectRootPath={() => {}} />
            <PaneProbe />
        </DestinationInstanceHost>;
        const screen = await fixture.render(renderLocation());
        const folderRow = `repository-tree-row-${toTestIdSafeValue('dir.with.dot')}`;
        await vi.waitFor(() => expect(screen.findByTestId(folderRow)).toBeTruthy());
        await screen.pressByTestIdAsync(folderRow);
        expect(navigations).toHaveLength(1);
        const folderUrl = new URL(navigations[0]!, 'https://happier.test');
        expect(folderUrl.pathname).toBe('/projects/code-project/code');
        expect(Object.fromEntries(folderUrl.searchParams)).toMatchObject({ serverId: ref.serverId, codePath: 'dir.with.dot', codeKind: 'folder' });
        await screen.update(fixture.wrap(renderLocation(Object.fromEntries(folderUrl.searchParams))));
        const fileRow = `repository-tree-row-${toTestIdSafeValue('dir.with.dot/LICENSE')}`;
        await vi.waitFor(() => expect(screen.findByTestId(fileRow)).toBeTruthy());
        await screen.pressByTestIdAsync(fileRow);
        const fileUrl = new URL(navigations.at(-1)!, 'https://happier.test');
        expect(Object.fromEntries(fileUrl.searchParams)).toMatchObject({ codePath: 'dir.with.dot/LICENSE', codeKind: 'file' });
        expect(fileUrl.searchParams.has('initialFile')).toBe(false);
        await screen.update(fixture.wrap(renderLocation(Object.fromEntries(fileUrl.searchParams))));
        expect(screen.findByTestId('workspace-code-file')).toBeTruthy();
        expect(screen.root.findByType('CodePaneProbe').props.details?.isOpen).not.toBe(true);
        await vi.waitFor(() => expect(screen.findByTestId('workspace-code-strip-history')).toBeTruthy());
        await screen.pressByTestIdAsync('workspace-code-strip-history');
        expect(new URL(navigations.at(-1)!, 'https://happier.test').pathname).toBe('/projects/code-project/changes');
        // The browser Back owner returns the preceding retained route; Code must consume it.
        await screen.update(fixture.wrap(renderLocation(Object.fromEntries(folderUrl.searchParams))));
        expect(screen.findByTestId('workspace-code-file')).toBeNull();
        await vi.waitFor(() => expect(screen.findByTestId(fileRow)).toBeTruthy());
        await screen.pressByTestIdAsync('workspace-code-bar-crumb-0');
        expect(new URL(navigations.at(-1)!, 'https://happier.test').searchParams.get('codePath')).toBe('');
    });
});
