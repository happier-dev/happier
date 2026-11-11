// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit';
import { createTestSessionTranscriptSource, wrapWithSessionTranscriptSource } from '@/dev/testkit/sessionTranscriptSource';
import { createSessionFilesViewFixture, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from '../files/views/sessionFilesViewTestkit';
import type { WorkspaceNavigationContextValue } from '@/components/appShell/workspace/WorkspaceNavigationContext';

const openResourceUrl = vi.hoisted(() => vi.fn(async (_url: string) => true));
vi.mock('@/utils/url/openResource', () => ({
    useOpenResource: () => ({ openResourceUrl }),
}));

installSessionFilesViewBoundaries({ platformOS: 'web' });
await prepareSessionFilesViewTestkit();
const { WorkspaceProvider } = await import('@/components/appShell/workspace/WorkspaceProvider');
const { resolveCompactAppDestinations, hrefForDestinationRef, resolveDestinationRefFromHref } = await import('@/components/appShell/destinations/compactAppDestinationCatalog');
const { useTranscriptFileLinks } = await import('./useTranscriptFileLinks');
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>> | undefined;
afterEach(async () => { standardCleanup(); await fixture?.dispose(); });

async function mountLinks(workspacePath = '/work/repo', canOpenFiles = true, machineRootPath?: string) {
    fixture = await createSessionFilesViewFixture({ rootPath: workspacePath, serverIdentityId: 'srv_transcript_file_links' });
    if (machineRootPath) {
        const metadata = fixture.session.metadata;
        if (!metadata) throw new Error('Expected Session metadata');
        fixture.storage.getState().applySessions([{ ...fixture.session, metadata: { ...metadata,
            sessionWorkspaceLocationV1: { v: 1, machineId: fixture.scope.machineId, agentPath: workspacePath, machinePath: machineRootPath },
        } }]);
    }
    fixture.setSnapshot(null);
    fixture.storage.setState({ isDataReady: true });
    const source = createTestSessionTranscriptSource({ sessionId: fixture.session.id, serverId: fixture.scope.serverId,
        workspacePath, navigate: () => {} });
    const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: true, workflows: false, friends: false } });
    let navigation: WorkspaceNavigationContextValue | undefined;
    let links: ReturnType<typeof useTranscriptFileLinks> | undefined;
    function Probe() {
        links = useTranscriptFileLinks({ sessionId: fixture!.session.id, serverId: fixture!.scope.serverId, workspacePath, canOpenFiles });
        return null;
    }
    await fixture.render(<WorkspaceProvider enabled catalog={catalog}>{owner => {
        navigation = owner;
        return wrapWithSessionTranscriptSource(<Probe />, source);
    }}</WorkspaceProvider>);
    return {
        get links() { return links!; },
        destinations: () => Object.values(navigation!.state.tabs).flatMap(tab => {
            const href = hrefForDestinationRef(catalog, tab.target);
            const target = href ? resolveDestinationRefFromHref(catalog, href) : null;
            return target ? [new URLSearchParams(target.params)] : [];
        }),
    };
}

describe('transcript file links through workspace navigation', () => {
    it('routes external transcript links through the canonical chat-link opener', async () => {
        const mounted = await mountLinks();
        openResourceUrl.mockClear();
        await act(async () => {
            expect(mounted.links.onMarkdownLinkPress('https://example.net/')).toBe(true);
        });
        expect(openResourceUrl).toHaveBeenCalledWith('https://example.net/');
    });

    it.each([
        { link: '/work/repo-task/.scratch/report.md#L5-L8', root: '/work/repo-task/.scratch', path: 'report.md', workspace: '/work/repo' },
        { link: '../artifacts/report.md', root: '/work/artifacts', path: 'report.md', workspace: '/work/repo' },
        { link: '../report.md', root: null, path: 'report.md', workspace: 'C:/' },
        { link: '../report.md', root: null, path: 'report.md', workspace: '//Server/Share' },
        { link: 'file:///work/artifacts/report.md', root: '/work/artifacts', path: 'report.md', workspace: '/work/repo' },
        { link: 'http://localhost:18829/work/artifacts/report.md', root: '/work/artifacts', path: 'report.md', workspace: '/work/repo' },
        { link: 'C:\\Artifacts\\Report.md', root: 'c:/artifacts', path: 'Report.md', workspace: 'C:\\Repo' },
        { link: 'file://Server/Share/Artifacts/Report.md', root: '//server/share/artifacts', path: 'Report.md', workspace: '\\\\Server\\Share\\Repo' },
    ])('opens $link with a safe path and its exact file base', async ({ link, root, path, workspace }) => {
        const mounted = await mountLinks(workspace);
        let accepted: boolean | undefined;
        await act(async () => { accepted = mounted.links.onMarkdownLinkPress(link); });
        expect(accepted).toBe(true);
        await vi.waitFor(() => expect(mounted.destinations().some(query =>
            query.get('path') === path && query.get('rootPath') === root && query.get('fileView') === 'view')).toBe(true));
        if (link.includes('#L5-L8')) {
            const query = mounted.destinations().find(query => query.get('path') === path)!;
            const { parseSessionPaneUrlState } = await import('@/components/sessions/panes/url/sessionPaneUrlState');
            expect(parseSessionPaneUrlState(Object.fromEntries(query))?.details).toMatchObject({
                anchor: { kind: 'range', filePath: path, startLine: 5, endLine: 8 },
            });
        }
    });

    it.each([
        '/work/artifacts/ leading %25?#L4.txt ',
        '/work/repo/ leading %25?#L4.txt ',
    ])('keeps raw filename bytes in openPath: %s', async path => {
        const mounted = await mountLinks();
        await act(async () => { expect(mounted.links.openPath(path)).toBe(true); });
        await vi.waitFor(() => expect(mounted.destinations().some(query =>
            query.get('path') === ' leading %25?#L4.txt ')).toBe(true));
    });

    it('retains a producer root and Changes options for raw parent-relative evidence', async () => {
        const mounted = await mountLinks('/work/repo/nested');
        await act(async () => { expect(mounted.links.openPath('../artifacts/report.md', {
            rootPath: '/work/repo', view: 'changes', anchorSource: 'diff',
            anchor: { kind: 'line', filePath: '../artifacts/report.md', line: 7 },
        })).toBe(true); });
        await vi.waitFor(() => expect(mounted.destinations().some(query =>
            query.get('path') === 'report.md' && query.get('rootPath') === '/work/artifacts' && query.get('fileView') === 'changes')).toBe(true));
    });

    it.each([
        { workspace: '/agent/repo', machine: 'D:\\Host\\Repo', link: '../Artifacts/Report.md', root: 'd:/host/artifacts' },
        { workspace: 'C:\\Agent\\Repo', machine: '/host/Repo', link: '..\\Artifacts\\Report.md', root: '/host/Artifacts' },
    ])('maps $workspace parent references before resolving dot segments', async ({ workspace, machine, link, root }) => {
        const mounted = await mountLinks(workspace, true, machine);
        await act(async () => { expect(mounted.links.onMarkdownLinkPress(link)).toBe(true); });
        await vi.waitFor(() => expect(mounted.destinations().some(query =>
            query.get('path') === 'Report.md' && query.get('rootPath') === root)).toBe(true));
    });

    it('leaves file navigation disabled for a transcript without machine file access', async () => {
        const mounted = await mountLinks('/work/repo', false);
        expect(mounted.links.onMarkdownLinkPress('/work/artifacts/report.md')).toBe(false);
        expect(mounted.links.openPath('/work/artifacts/report.md')).toBe(false);
        expect(mounted.destinations().some(query => query.get('path') === 'report.md')).toBe(false);
    });
});
