// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { flushHookEffects, standardCleanup } from '@/dev/testkit';
import { createCapturingFlatListMock } from '@/dev/testkit/mocks/virtualizedList';
import { createSessionFilesViewFixture, fileViewSnapshot, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';

let recycler: import('@/dev/testkit/mocks/legendList').CapturingLegendListMockState | undefined;
installSessionFilesViewBoundaries({ platformOS: 'web', reactNativeOverrides: createCapturingFlatListMock().module,
    onRecycler: state => { recycler = state; } });
await prepareSessionFilesViewTestkit();
const { WorkspaceFileDetailsView } = await import('./WorkspaceFileDetailsView');
const { CodeLinesViewCore } = await import('@/components/ui/code/view/CodeLinesViewCore');
const { VirtualizedList } = await import('@/components/ui/lists/virtualized');
const { KeyboardShortcutProvider } = await import('@/keyboard/KeyboardShortcutProvider');
const { resolveCompactAppDestinations, resolveDestinationRefFromHref } = await import('@/components/appShell/destinations/compactAppDestinationCatalog');
const { createSessionPaneDetailsTab } = await import('@/components/sessions/panes/url/sessionPaneUrlState');
const { readProjectFileRouteTarget } = await import('@/components/projects/detail/projectRouteState');
const { readFileTargetAnchorResource, readWorkspaceFileLinkView } = await import('@/utils/url/sessionFileDeepLink');
const catalog = resolveCompactAppDestinations({ builtins: { externalSessions: false, inbox: true, workflows: true, friends: false }, pages: [] });
afterEach(() => { standardCleanup(); vi.restoreAllMocks(); });

it('lands the captured Project Search activation after the web list gains its measured extent', async () => {
    const text = Array.from({ length: 161 }, (_, index) => `export const coast${index} = "Coastal notebook line ${index}";`).join('\n');
    const read = await createExternalActionAccountHttpBoundary({ serverUrl: 'https://session-file-views.test',
        serverIdentityId: 'srv_activation', accountId: 'alice', machineId: 'm1', tokenEpoch: 0,
        actionId: 'daemon.filesystem.readFile', execute: async () => ({ success: true, content: Buffer.from(text).toString('base64') }) });
    standardCleanup();
    const fixture = await createSessionFilesViewFixture({ serverIdentityId: 'srv_activation', sessionId: 'activation-project',
        credentials: { token: createAccountTokenForTests('alice', { currentAccount: true }) },
        request: async (url, init) => {
            const parsed = new URL(String(url));
            if (parsed.pathname === '/v1/machines/m1') return Response.json({ machine: read.machine });
            return await read.handle(parsed, init) ?? new Response('{}', { status: 404 });
        }, rpc: () => ({ success: true, exists: true, kind: 'file', sizeBytes: Buffer.byteLength(text) }) });
    fixture.storage.getState().updateWorkspaceScmSnapshot(fixture.scope, fileViewSnapshot());
    // Exact qa-r330 Project Search route; Session and public entries share its renderer owner.
    const href = '/projects/c0802341-2759-4aff-833e-5aa44d298042/code?initialFile=review.ts&source=file&anchor=fileLine&startLine=150&activeRootPath=%2Ftmp%2Ffsp-r330-coastal-20261027&fileOpenAs=preview';
    const destination = resolveDestinationRefFromHref(catalog, href)!;
    const target = readProjectFileRouteTarget(destination.params);
    if (target?.kind !== 'file') throw new Error('Expected the captured file route');
    const resource = createSessionPaneDetailsTab(target)!;
    const scroller = document.createElement('div');
    scroller.style.overflowY = 'auto';
    document.body.append(scroller);
    let measured = false;
    let targetRow: HTMLDivElement | null = null;
    let prefix = '';
    // Browser layout/virtualization is the substituted boundary. The real route readers,
    // HTTP file load, details page, Find arbitration and renderer execute below it.
    Object.defineProperties(scroller, {
        clientHeight: { value: 473 },
        scrollHeight: { get: () => measured ? 3590 : 473 },
        scrollTo: { value: (options: ScrollToOptions) => {
            scroller.scrollTop = Math.min(measured ? 3117 : 0, Math.max(0, options.top ?? 0));
            if (scroller.scrollTop > 0 && !targetRow) {
                targetRow = document.createElement('div');
                targetRow.id = `${prefix}-f:150`;
                targetRow.textContent = 'export const coast149 = "Coastal notebook line 149";';
                targetRow.scrollIntoView = () => { scroller.scrollTop = 150 * 22 - 473 / 2; };
                targetRow.getBoundingClientRect = () => new DOMRect(0, 150 * 22 - scroller.scrollTop, 400, 22);
                scroller.append(targetRow);
            }
        } },
    });
    recycler?.refHandle.getScrollableNode.mockReturnValue(scroller);
    recycler?.refHandle.scrollToIndex.mockImplementation(({ index }: { index: number }) => scroller.scrollTo({ top: index * 22 }));
    const render = () => <KeyboardShortcutProvider handlers={{}}>
        <WorkspaceFileDetailsView scopeId="project:activation"
            scope={fixture.scope} filePath={target.path} sessionIdForAugmentation={null}
            initialView={readWorkspaceFileLinkView(destination.params)} deepLinkAnchor={readFileTargetAnchorResource(resource.resource)} />
    </KeyboardShortcutProvider>;
    const screen = await fixture.render(render(), { createNodeMock: element => {
        const id: unknown = element.props.nativeID;
        if (typeof id === 'string' && id.endsWith('-f:1')) {
            prefix = id.slice(0, -4);
            const first = document.createElement('div'); first.id = id; scroller.append(first);
            return first;
        }
        return null;
    } });
    try {
        await vi.waitFor(() => expect(screen.findAllByType(CodeLinesViewCore)).toHaveLength(1));
        await vi.dynamicImportSettled();
        await flushHookEffects({ cycles: 20, turns: 50 });
        expect(screen.findByType(CodeLinesViewCore).props.scrollToLineId).toBe('f:150');
        expect(prefix).not.toBe('');
        expect(scroller.scrollTop).toBe(0);
        const list = () => screen.findByType(VirtualizedList);
        // The file is ready, but browser layout can arrive late. The landed line keeps its band until the
        // reader takes over (a press or scrolling it away), not on a clock, and navigation stays alive.
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        await screen.update(fixture.wrap(<KeyboardShortcutProvider handlers={{}}>
            <WorkspaceFileDetailsView scopeId="project:activation" scope={fixture.scope} filePath={target.path}
                sessionIdForAugmentation={null} deepLinkAnchor={{ source: 'file', anchor: { kind: 'fileLine', startLine: 149 } }} />
        </KeyboardShortcutProvider>));
        await screen.update(fixture.wrap(render()));
        await act(async () => { vi.advanceTimersByTime(9000); });
        vi.useRealTimers();
        expect(screen.findByType(CodeLinesViewCore).props.highlightLineIds?.has('f:150') ?? false).toBe(true);
        expect(screen.findByType(CodeLinesViewCore).props.scrollToLineId).toBe('f:150');
        measured = true;
        await act(async () => { list().props.onContentSizeChange?.(400, 3590); });
        expect(scroller.scrollTop).toBeGreaterThan(0);
        const row = screen.tree.root.findAll(node => node.props.nativeID === `${prefix}-f:150`)[0]!;
        await act(async () => { row.props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 3300, width: 400, height: 22 } } }); });
        const landedRow = scroller.querySelector<HTMLElement>(`[id$="-f:150"]`)!;
        expect(landedRow.textContent).toContain('coast149');
        expect(landedRow.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
        expect(landedRow.getBoundingClientRect().bottom).toBeLessThanOrEqual(473);
        // A completed request must relinquish subsequent resize/equivalent renders to the reader.
        scroller.scrollTop = 100;
        await screen.update(fixture.wrap(render()));
        await act(async () => { list().props.onContentSizeChange?.(400, 3590); list().props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 473 } } }); });
        expect(scroller.scrollTop).toBe(100);
    } finally { vi.useRealTimers(); await screen.unmount(); scroller.remove(); await fixture.dispose(); }
});
