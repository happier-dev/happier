/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyProjectAccountRowsFixture, createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installSessionDetailsPanelNonRnModuleMocks } from '@/components/sessions/panes/sessionDetailsPanelNonRnModuleMocks';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import type { SelectedPaneDestinationV1 } from '@/components/appShell/panes/model/selectedPaneDestination';
import { buildWidgetSurfaceArtifactIdV1, buildWidgetSurfaceArtifactHeaderV1, WidgetAreaLayoutV1Schema } from '@happier-dev/protocol/widgets';

installSessionDetailsPanelNonRnModuleMocks();
// Keep the pane reducer, Project adapters, overlay and close controls real in the DOM.
vi.mock('react-native', async () => vi.importActual<typeof import('react-native-web')>('react-native-web'));
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
const daemon = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: daemon }));

const { storage } = await import('@/sync/domains/state/storage');
const { buildProjectPaneScopeId } = await import('./detail/projectPaneScope');
const { ProjectDetailScreen } = await import('./ProjectDetailScreen');
const { resolveProjectRightTabId } = await import('./detail/resolveProjectRightTabId');
const disposeActionLoader = await installRealActionExecutorModuleLoader();
afterAll(disposeActionLoader);
const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });
// jsdom does not provide Web Locks; fixture Home storage still follows its real lock path.
beforeEach(() => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: {
        request: async (_name: string, run: () => unknown) => await run(),
    } });
});
const runtime = installSessionPaneRuntimeTestHarness({
    scopeId: ({ serverId }) => buildProjectPaneScopeId('wr_1', serverId),
    request: async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {
            actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'widgets.item.add': ['ui'] } },
        } }, version: 1 });
        // Adding a checkout-bound widget admits the checkout against the Account's Project rows.
        if (path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`) return Response.json(createPlainProjectAccountRowListFixture({ workspaceRefs: [{
            id: 'wr_1', serverId: runtime.serverId, machineId: 'machine-1', rootPath: '/repo',
            label: 'Project Alpha', projectKey: 'project-alpha', createdAtMs: 1,
        }] }));
        return artifacts.handle(path, init);
    },
});
let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
    artifacts.clear();
    daemon.mockImplementation(async () => ({ success: false, errorCode: 'FEATURE_UNSUPPORTED', error: 'Unavailable in fixture' }));
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
    Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 390 });
    Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 844 });
    window.dispatchEvent(new Event('resize'));
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(prefers-reduced-motion: reduce)', addEventListener() {}, removeEventListener() {} }));
    await vi.waitFor(() => expect(storage.getState().projectAccountRows?.status).toBe('ready'));
    applyProjectAccountRowsFixture(storage, { workspaceRefs: [{
        id: 'wr_1', serverId: runtime.serverId, machineId: 'machine-1', rootPath: '/repo',
        label: 'Project Alpha', projectKey: 'project-alpha', createdAtMs: 1,
    }] });
    storage.setState({ sessions: {}, localSettings: { ...storage.getState().localSettings,
        uiMultiPanePanelsEnabled: true, projectLastActiveRootPathByWorkspaceRefId: {},
        projectLastActiveWorktreeIdByWorkspaceRefId: {},
    } });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(async () => {
    if (root) await act(async () => root.unmount());
    container?.remove();
    vi.unstubAllGlobals();
});

async function renderProject(page: 'context' | 'overview' = 'context') {
    await act(async () => root.render(<runtime.Wrapper><ProjectDetailScreen
        workspaceRefId="wr_1" serverId={runtime.serverId} page={page}
    /></runtime.Wrapper>));
}
function element(testId: string) {
    const node = container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    if (!node) throw new Error(`Missing ${testId}`);
    return node;
}
async function resize(width: number) {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: width });
    await act(async () => window.dispatchEvent(new Event('resize')));
}

function restoreRightPane(right: Readonly<{
    isOpen: boolean;
    activeTabId: string | null;
    selectedDestination: SelectedPaneDestinationV1 | null;
}>) {
    const scopeId = buildProjectPaneScopeId('wr_1', runtime.serverId);
    storage.getState().applyLocalSettings({ appPaneScopesV1: {
        [scopeId]: {
            mainHidden: false,
            right: { ...right, tabState: {} },
            details: { isOpen: false, tabs: [], activeTabKey: null, tabState: {} },
            bottom: { isOpen: false, activeTabId: null, selectedDestination: null, tabState: {} },
        },
    } }, { persist: false });
}

describe('Project companion pane dismissal in the DOM', () => {
    it('opens the single phone Add gallery after dismissing Git and persists additions to both dashboard areas', async () => {
        const surface = { serverId: runtime.serverId, accountId: 'account-a',
            owner: { kind: 'project' as const, projectId: 'project-alpha' } };
        const artifactId = buildWidgetSurfaceArtifactIdV1(surface);
        const empty = WidgetAreaLayoutV1Schema.parse({ v: 1, surface, items: [] });
        const { createArtifactWithHeaderViaApi } = await import('@/sync/engine/artifacts/syncArtifacts');
        await createArtifactWithHeaderViaApi({ artifactId, serverId: runtime.serverId,
            credentials: { token: `header.${Buffer.from(JSON.stringify({ sub: 'account-a' })).toString('base64url')}.signature` },
            request: async (path, init) => path === '/v1/account/encryption' ? Response.json({ mode: 'plain', updatedAt: 1 })
                : await artifacts.handle(path, init) ?? Response.json({}, { status: 404 }),
            header: buildWidgetSurfaceArtifactHeaderV1(empty), body: JSON.stringify(empty), encryption: null,
            artifactDataKeys: new Map(), addArtifact: () => {},
        });
        await renderProject('overview');
        await act(async () => runtime.pane.openRight({ tabId: 'git' }));
        await act(async () => element('project-rightpanel-header.close').click());
        expect(container.querySelector('[data-testid="multi-pane-right-modal"]')).toBeNull();
        await vi.waitFor(() => expect(container.querySelectorAll('[data-testid="project-overview-main.add"]')).toHaveLength(1));
        expect(container.querySelector('[data-testid="project-overview-aside.add"]')).toBeNull();
        await act(async () => element('project-overview-main.add').click());
        // Real BaseModal portal, gallery and strict Action/Artifact wiring; no renderer substitute.
        const gallery = () => document.querySelector<HTMLElement>('[data-testid="project-overview-main.addPopover.sheet"]');
        await vi.waitFor(() => expect(gallery()).not.toBeNull());
        expect(artifacts.list().map(row => row.id)).toEqual([artifactId]);
        expect(WidgetAreaLayoutV1Schema.parse(JSON.parse(artifacts.readPlainBody(artifactId)!))).toEqual(empty);
        const clickGallery = async (id: string) => {
            const control = gallery()?.querySelector<HTMLElement>(`[data-testid="${id}"]`);
            expect(control).not.toBeNull();
            await act(async () => control!.click());
        };
        for (const [area, widget] of [['main', 'project_about'], ['aside', 'project_readme']] as const) {
            await clickGallery(`project-overview-main.addPopover.area:${area}`);
            await clickGallery(`project-overview-main.addPopover.entry.plugin-builtin:${widget}`);
            await vi.waitFor(() => expect(gallery()?.querySelector('[data-testid$=".submit"]')).not.toBeNull());
            await act(async () => gallery()!.querySelector<HTMLElement>('[data-testid$=".submit"]')!.click());
            await vi.waitFor(() => {
                const saved = WidgetAreaLayoutV1Schema.parse(JSON.parse(artifacts.readPlainBody(artifactId)!));
                expect(saved.items).toContainEqual(expect.objectContaining({ area, instance: expect.objectContaining({
                    definition: { kind: 'builtin', id: widget },
                }) }));
            });
            const back = gallery()?.querySelector<HTMLElement>('[data-testid$=".detail.back"]');
            if (back) await act(async () => back.click());
        }
        await clickGallery('project-overview-main.addPopover.done');
        await act(async () => root.render(<runtime.Wrapper />));
        await renderProject('overview');
        const saved = WidgetAreaLayoutV1Schema.parse(JSON.parse(artifacts.readPlainBody(artifactId)!));
        for (const item of saved.items) if (item.kind === 'widget') await vi.waitFor(() => expect(container.querySelector(
            `[data-testid="project-overview-merged.widget.${item.instance.id}"]`)).not.toBeNull());
        expect(saved.items.map(item => item.area)).toEqual(['main', 'aside']);
    });
    it.each([390, 830, 1100])('gives the page its room first: a fresh Project scope at %s starts closed, stays closed on widening, and the rail opens the preferred tab', async (width) => {
        await resize(width);
        await renderProject();
        expect(runtime.pane.scopeState?.right.isOpen).toBe(false);
        expect(container.querySelector('[data-testid="project-rightpanel-header"]')).toBeNull();
        expect(container.querySelector('[data-testid="multi-pane-right-modal"]')).toBeNull();
        await resize(1400);
        expect(runtime.pane.scopeState?.right.isOpen).toBe(false);
        if (width === 390) return;
        const tabId = resolveProjectRightTabId(null);
        await act(async () => runtime.pane.openRight({ tabId }));
        expect(runtime.pane.scopeState?.right).toMatchObject({
            isOpen: true, selectedDestination: { kind: 'builtin', id: tabId },
        });
        expect(element('project-rightpanel-header')).toBeTruthy();
    });
    it('draws the Files companion with the same tree as a Session, not the Code page', async () => {
        await resize(1100);
        await renderProject('overview');
        await act(async () => runtime.pane.openRight({ tabId: 'files' }));
        await vi.waitFor(() => expect(container.querySelector('[data-testid="project-rightpanel-surface-files"] [data-testid="repository-tree-drop-zone"]')).not.toBeNull());
        expect(container.querySelector('[data-testid="project-rightpanel-surface-files"] [data-testid="workspace-code"]')).toBeNull();
        expect(container.querySelector('[data-testid="project-rightpanel-surface-files"] [data-testid="workspace-code-bar-goto"]')).toBeNull();
    });
    it('does not auto-open when multi-pane is disabled, including when enabled later', async () => {
        await resize(1100);
        storage.getState().applyLocalSettings({ uiMultiPanePanelsEnabled: false }, { persist: false });
        await renderProject();
        expect(runtime.pane.scopeState?.right.isOpen).toBe(false);
        await act(async () => storage.getState().applyLocalSettings({ uiMultiPanePanelsEnabled: true }, { persist: false }));
        await renderProject();
        expect(runtime.pane.scopeState?.right.isOpen).toBe(false);
    });
    it.each([390, 1100].flatMap(width => ['git', 'files', 'terminal', 'services', 'browser'].map(tabId => ({ width, tabId }))))(
        'keeps $tabId dismissed at $width across pane API identity changes and unrelated updates', async ({ width, tabId }) => {
            await resize(width);
            await renderProject();
            await act(async () => runtime.pane.openRight({ tabId }));
            const openApi = runtime.pane;
            await act(async () => runtime.pane.closeRight());
            expect(runtime.pane).not.toBe(openApi);
            expect(runtime.pane.scopeState?.right.isOpen).toBe(false);
            await act(async () => runtime.pane.setRightTabState(tabId, { query: 'retained' }));
            await renderProject();
            expect(runtime.pane.scopeState?.right).toMatchObject({ isOpen: false, activeTabId: tabId });
            await act(async () => root.render(<runtime.Wrapper />));
            await renderProject();
            expect(runtime.pane.scopeState?.right).toMatchObject({ isOpen: false, activeTabId: tabId });
            expect(container.querySelector('[data-testid="multi-pane-right-modal"]')).toBeNull();
        },
    );
    it('closes the phone Git pane through its reachable canonical pane close control', async () => {
        await renderProject();
        await act(async () => runtime.pane.openRight({ tabId: 'git' }));
        expect(element('multi-pane-right-modal').getAttribute('aria-modal')).toBe('true');
        const close = element('project-rightpanel-header.close');
        expect(close.getAttribute('aria-label')).toBeTruthy();
        await act(async () => close.click());
        expect(runtime.pane.scopeState?.right.isOpen).toBe(false);
        expect(container.querySelector('[data-testid="multi-pane-right-modal"]')).toBeNull();
    });
    it.each(['scrim', 'escape'] as const)('keeps Git dismissed after a DOM %s interaction', async (dismissal) => {
        // Tablet width below the main + right dock minimum exercises the overlay.
        await resize(650);
        await renderProject();
        await act(async () => runtime.pane.openRight({ tabId: 'git' }));
        expect(element('multi-pane-right-modal').getAttribute('aria-modal')).toBe('true');
        await act(async () => {
            if (dismissal === 'scrim') element('multi-pane-right-scrim').click();
            else window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        });
        expect(runtime.pane.scopeState?.right.isOpen).toBe(false);
        await act(async () => runtime.pane.setRightTabState('git', { query: 'after dismissal' }));
        expect(container.querySelector('[data-testid="multi-pane-right-modal"]')).toBeNull();
    });
    it('toggles Git closed through the real rail and explicitly opens it again', async () => {
        await resize(1100);
        await renderProject();
        // Pick a different destination so the first Git press is an explicit open intent.
        await act(async () => runtime.pane.openRight({ tabId: 'files' }));
        await act(async () => element('project-rightpanel-action:git').click());
        expect(runtime.pane.scopeState?.right).toMatchObject({ isOpen: true, activeTabId: 'git' });
        await act(async () => element('project-rightpanel-action:git').click());
        expect(runtime.pane.scopeState?.right.isOpen).toBe(false);
        await act(async () => runtime.pane.setRightTabState('git', { query: 'after toggle' }));
        expect(runtime.pane.scopeState?.right.isOpen).toBe(false);
        await act(async () => element('project-rightpanel-action:git').click());
        expect(runtime.pane.scopeState?.right).toMatchObject({ isOpen: true, activeTabId: 'git' });
    });
    it('leaves a retained closed plugin destination closed on Project entry', async () => {
        await resize(1100);
        await act(async () => root.render(<runtime.Wrapper />));
        const destination = { kind: 'plugin' as const, destination: { pluginId: 'acme.review', localId: 'project-review' } };
        await act(async () => {
            runtime.pane.selectRightDestination(destination);
            runtime.pane.closeRight();
        });
        await renderProject();
        expect(runtime.pane.scopeState?.right).toMatchObject({ isOpen: false, selectedDestination: destination });
    });
    it.each([null, 'git'])('preserves a restored closed scope with tab %s', async (tabId) => {
        await resize(1100);
        restoreRightPane({ isOpen: false, activeTabId: tabId,
            selectedDestination: tabId ? { kind: 'builtin', id: tabId } : null });
        await renderProject();
        expect(runtime.pane.scopeState?.right).toMatchObject({ isOpen: false, activeTabId: tabId });
    });
    it.each([false, true])('preserves a restored plugin selection (open=%s)', async (isOpen) => {
        await resize(1100);
        const destination = { kind: 'plugin' as const, destination: { pluginId: 'acme.review', localId: 'project-review' } };
        restoreRightPane({ isOpen, activeTabId: 'files', selectedDestination: destination });
        await renderProject();
        expect(runtime.pane.scopeState?.right).toMatchObject({ isOpen, activeTabId: 'files', selectedDestination: destination });
    });
    it.each([false, true])('retains selection and open=%s across desktop → phone → desktop', async (isOpen) => {
        await resize(1100);
        await renderProject();
        await act(async () => {
            runtime.pane.openRight({ tabId: 'files' });
            runtime.pane.setRightTabState('files', { query: 'retained across resize' });
            if (!isOpen) runtime.pane.closeRight();
        });
        const selection = runtime.pane.scopeState?.right;
        for (const width of [390, 1100]) {
            await resize(width);
            await renderProject();
            expect(runtime.pane.scopeState?.right).toEqual(selection);
            expect(runtime.pane.scopeState?.right.isOpen).toBe(isOpen);
        }
    });
});
