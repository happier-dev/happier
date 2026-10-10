/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installSessionDetailsPanelNonRnModuleMocks } from '@/components/sessions/panes/sessionDetailsPanelNonRnModuleMocks';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import type { SelectedPaneDestinationV1 } from '@/components/appShell/panes/model/selectedPaneDestination';

installSessionDetailsPanelNonRnModuleMocks();
// Keep the pane reducer, Project adapters, overlay and close controls real in the DOM.
vi.mock('react-native', async () => vi.importActual<typeof import('react-native-web')>('react-native-web'));
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
    request: async (url, init) => artifacts.handle(new URL(String(url)).pathname, init),
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

async function renderProject() {
    await act(async () => root.render(<runtime.Wrapper><ProjectDetailScreen
        workspaceRefId="wr_1" serverId={runtime.serverId} page="context"
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
            right: { ...right, tabState: {} },
            details: { isOpen: false, tabs: [], activeTabKey: null, tabState: {} },
            bottom: { isOpen: false, activeTabId: null, tabState: {} },
        },
    } }, { persist: false });
}

describe('Project companion pane dismissal in the DOM', () => {
    it.each([1100, 830])('opens a fresh wide Project scope at %s with the preferred tab', async (width) => {
        await resize(width);
        await renderProject();
        const tabId = resolveProjectRightTabId(null);
        expect(runtime.pane.scopeState?.right).toMatchObject({
            isOpen: true, activeTabId: tabId, selectedDestination: { kind: 'builtin', id: tabId },
        });
        expect(element('project-rightpanel-header')).toBeTruthy();
    });
    it('starts a fresh phone-width web scope closed and keeps it closed on widening', async () => {
        await renderProject();
        expect(runtime.pane.scopeState?.right.isOpen).toBe(false);
        expect(container.querySelector('[data-testid="multi-pane-right-modal"]')).toBeNull();
        await resize(1100);
        expect(runtime.pane.scopeState?.right.isOpen).toBe(false);
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
