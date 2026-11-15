// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit';
import { createTestSessionTranscriptSource, wrapWithSessionTranscriptSource } from '@/dev/testkit/sessionTranscriptSource';
import { createSessionFilesViewFixture, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from '../files/views/sessionFilesViewTestkit';
import type { WorkspaceNavigationContextValue } from '@/components/appShell/workspace/WorkspaceNavigationContext';
import type { DetailsTab } from '@/components/appShell/panes/details/workspace/detailsWorkspaceTypes';
import type { BrowserDaemonViewV1 } from '@happier-dev/protocol/browser/control/v1';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { BROWSER_RUNTIME_ACTION_INPUT_SCHEMAS } from '@happier-dev/protocol/actions/specs/browser';

// Only the OS browser handoff is replaced; resource routing and Action admission stay real.
const openExternalUrl = vi.hoisted(() => vi.fn(async (_url: string) => true));
vi.mock('@/utils/url/openExternalUrl', () => ({ openExternalUrl }));

installSessionFilesViewBoundaries({ platformOS: 'web' });
await prepareSessionFilesViewTestkit();
const { WorkspaceProvider } = await import('@/components/appShell/workspace/WorkspaceProvider');
const { resolveCompactAppDestinations, hrefForDestinationRef, resolveDestinationRefFromHref } = await import('@/components/appShell/destinations/compactAppDestinationCatalog');
const { useTranscriptFileLinks } = await import('./useTranscriptFileLinks');
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>> | undefined;
afterEach(async () => { standardCleanup(); await fixture?.dispose(); });

async function mountLinks(workspacePath = '/work/repo', canOpenFiles = true, machineRootPath?: string,
    fixtureOptions: Parameters<typeof createSessionFilesViewFixture>[0] = {}) {
    fixture = await createSessionFilesViewFixture({ ...fixtureOptions, rootPath: workspacePath, serverIdentityId: 'srv_transcript_file_links' });
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
        openExternalUrl.mockClear();
        await act(async () => {
            expect(mounted.links.onMarkdownLinkPress('https://example.net/')).toBe(true);
        });
        await vi.waitFor(() => expect(openExternalUrl).toHaveBeenCalledWith('https://example.net/'));
    });

    it('opens the authored loopback URL in the managed Browser without creating a File Details destination', async () => {
        const url = 'http://127.0.0.1:42031/b';
        const openedUrls: string[] = [];
        let views: BrowserDaemonViewV1[] = [];
        const mounted = await mountLinks('/work/repo', true, undefined, {
            featureOverrides: { features: { browser: { enabled: true, internal: { enabled: true }, viewTargets: { enabled: true } } } },
            request: async (input, init) => {
                if (new URL(String(input)).pathname !== '/v1/actions/browser.view.open') return undefined;
                const envelope = ExternalActionRequestEnvelopeV1Schema.parse(JSON.parse(String(init?.body)));
                const command = BROWSER_RUNTIME_ACTION_INPUT_SCHEMAS['browser.view.open'].parse(envelope.input);
                if (command.target.kind !== 'externalUrl') throw new Error('Expected external URL');
                openedUrls.push(command.target.url);
                const sourceId = `source:${command.viewId}`;
                views = [{ browserSessionId: command.browserSessionId, viewId: command.viewId, sourceId,
                    target: command.target, platform: 'web', adapterKind: 'chromiumSidecar', events: [],
                    captureSource: { v: 1, sourceId, sourceKind: 'browser', supportedCodecs: ['image.mjpeg'],
                        inputMode: 'shared', sidebands: [], health: { status: 'available' } } }];
                return Response.json({ v: 1, actionId: 'browser.view.open', requestId: envelope.requestId,
                    execution: { ok: true, result: { v: 1, commandId: command.commandId,
                        status: 'dispatched', adapterKind: 'chromiumSidecar', events: [] } } });
            },
            rpc: request => request.method === 'daemon.browser.view.list' ? { protocolVersion: 1, views } : undefined,
        });
        const { createBrowserWorkspaceOpeningFixture } = await import('@/dev/testkit/fixtures/browserWorkspaceOpening');
        const { createSessionPaneScopeId } = await import('@/components/sessions/panes/sessionPaneScopeId');
        const tabs: DetailsTab[] = [];
        const browser = createBrowserWorkspaceOpeningFixture({ scope: 'sessionDetails', platform: 'web',
            scopeId: createSessionPaneScopeId(fixture!.session.id, fixture!.scope.serverId),
            accountLifetime: { scope: { serverId: fixture!.scope.serverId, accountId: 'alice' },
                isCurrent: () => true, onRetire: () => ({ dispose() {} }) },
            localServiceTargets: [], localServiceAddressScope: { machineId: fixture!.scope.machineId, sessionId: fixture!.session.id },
            browserFeatureDecision: { featureId: 'browser', state: 'enabled', blockedBy: null, blockerCode: 'none',
                diagnostics: [], evaluatedAt: 1000, scope: { scopeKind: 'runtime' } },
            openDetailsTab: tab => { tabs.push(tab); },
        });
        fixture!.storage.setState({ localSettings: { ...fixture!.storage.getState().localSettings, chatLinkOpenLocation: 'browser' } });
        openExternalUrl.mockClear();
        try {
            await act(async () => { expect(mounted.links.onMarkdownLinkPress(url)).toBe(true); });
            await vi.waitFor(() => expect(tabs).toHaveLength(1));
            expect(tabs[0]?.kind).toBe('browser-view');
            expect(openedUrls).toEqual([url]);
            expect(mounted.destinations().some(query => query.has('fileView'))).toBe(false);
            expect(openExternalUrl).not.toHaveBeenCalled();
        } finally { browser.dispose(); }
    });

    it.each([
        { link: '/work/repo-task/.scratch/report.md#L5-L8', root: '/work/repo-task/.scratch', path: 'report.md', workspace: '/work/repo' },
        { link: '../artifacts/report.md', root: '/work/artifacts', path: 'report.md', workspace: '/work/repo' },
        { link: '../report.md', root: null, path: 'report.md', workspace: 'C:/' },
        { link: '../report.md', root: null, path: 'report.md', workspace: '//Server/Share' },
        { link: 'file:///work/artifacts/report.md', root: '/work/artifacts', path: 'report.md', workspace: '/work/repo' },
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
