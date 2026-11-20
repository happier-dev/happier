// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { View } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installWebLayoutBridge, measureWebLayout } from '@/dev/testkit/render/measureWebLayout';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { UniversalSearchRuntimeProvider } from '@/components/appShell/search/UniversalSearchRuntimeContext';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installWorkflowActionHttpBoundary } from '@/dev/testkit/fixtures/workflowActionHttpBoundary';

/**
 * The Workflows home as a browser lays it out (lab `nav-N1`): the page title, every section title
 * and every sheet share one left edge, whichever owner draws the section (DESIGN-8/9 N38).
 */

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ pathname: '/workflows' }).module);

vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
vi.mock('@/sync/domains/state/browserRecordStorage', async () =>
    (await import('@/dev/testkit/mocks/browserRecordStorage')).createBrowserRecordStorageModuleMock());
// The recycler is a platform boundary; Collection and its row/header geometry remain real.
vi.mock('@legendapp/list/react-native', async original =>
    (await import('@/dev/testkit/mocks/legendList')).createCapturingLegendListMock({ original: await original<Record<string, unknown>>() }).module);
installDisconnectedServerSocketBoundary(configureConnectedServerSocketBoundary);
installWebLayoutBridge();

const fixtureResponse = async (actionId: string) => {
    if (actionId === 'workflow.definition.list') return { ok: true, result: { definitions: [{
        kind: 'workflow-definition.v1', definitionId: 'saved', revision: { headerVersion: 1, bodyVersion: 1 },
        metadata: { title: 'Saved workflow' }, ownerAccountId: 'account-a', access: 'owner',
        contentStatus: 'available', stepCount: 1, triggers: [], nextRunAt: null,
    }] } };
    if (actionId === 'workflow.run.summaries') return { ok: true, result: { summaries: [], remainingSourceArtifactIds: [] } };
    if (actionId === 'workflow.run.list') return { ok: true, result: { runs: [], metadataByRunId: {} } };
    throw new Error(`Unexpected workflow HTTP fixture request: ${actionId}`);
};
// Load the real screen graph outside the case timer, with its transport installed first.
const preloadBoundary = await installWorkflowActionHttpBoundary({ fixtureResponse });
let WorkflowsLibraryHome: typeof import('./WorkflowsLibraryHome')['WorkflowsLibraryHome'];
try {
    ({ WorkflowsLibraryHome } = await import('./WorkflowsLibraryHome'));
} finally {
    await preloadBoundary.dispose();
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let boundary: Awaited<ReturnType<typeof installWorkflowActionHttpBoundary>> | undefined;
let previousState: ReturnType<typeof import('@/sync/domains/state/storageStore')['storage']['getState']>;

const searchRuntime = { open: () => {}, buildCommands: () => [] };
let singleton: Awaited<ReturnType<typeof loadSyncSingletonForTests>>;
let fixtureHome = 0;
beforeEach(async () => {
    // jsdom has no Web Locks API (a browser platform boundary); one tab holds every lock at once.
    if (!('locks' in navigator)) {
        Object.defineProperty(navigator, 'locks', { configurable: true,
            value: { request: async (_name: string, run: () => Promise<unknown>) => await run() } });
    }
    const { storage } = await import('@/sync/domains/state/storageStore');
    previousState = storage.getState();
    singleton = await loadSyncSingletonForTests();
    const runtime = await import('@/sync/domains/server/serverRuntime');
    const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
    const home = await runtime.upsertAndActivateServer({ serverUrl: `http://library-layout-${++fixtureHome}.test`, name: 'Library' });
    boundary = await installWorkflowActionHttpBoundary({ fixtureResponse });
    await (await import('@/sync/runtime/orchestration/connectionManager')).restoreConnectionToActiveServer(boundary.credentials);
    const { sync } = await import('@/sync/sync');
    expect(await sync.awaitBootstrapForegroundAcquisition()).toBe(true);
    await sync.resumeSync('server-reachable');
    publishAppliedActiveServerSnapshot(runtime.getActiveServerSnapshot());
    const { settingsDefaults } = await import('@/sync/domains/settings/settings');
    storage.setState({ profileScope: { serverId: home.id, accountId: 'account-a' },
        settingsScope: { serverId: home.id, accountId: 'account-a' }, settingsVersion: 1,
        settings: { ...settingsDefaults, experiments: true, featureToggles: { automations: true } },
        workflowRunListWindows: {}, workflowRunsById: {} });
    boundary.prime();
});

afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    host?.remove();
    host = null;
    (await import('./workflowLibraryReads')).resetWorkflowLibraryReadsForTests();
    await boundary?.dispose();
    singleton?.dispose();
    boundary = undefined;
    (await import('@/sync/domains/state/storageStore')).storage.setState(previousState);
});

describe('Workflows home, as a browser lays it out', () => {
    it('puts the trigger before the optional step count in a three-line phone row', async () => {
        const { t } = await import('@/text');
        const { storage } = await import('@/sync/domains/state/storageStore');
        storage.setState(state => ({ settings: {
            ...state.settings,
            collectionDisplayPreferencesV1: { workflow: { lines: 3, details: { trigger: true, steps: true } } },
        } }));
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        await act(async () => {
            root!.render(<View style={{ width: 390 }}><InjectedAuthProvider credentials={boundary!.credentials}>
                <UniversalSearchRuntimeProvider value={searchRuntime}><WorkflowsLibraryHome /></UniversalSearchRuntimeProvider>
            </InjectedAuthProvider></View>);
        });
        await measureWebLayout(host, { viewport: { width: 390, height: 3200 }, settle: replay => act(replay) });
        const row = await vi.waitFor(() => {
            const found = host!.querySelector('[data-testid="workflows-home:row:saved"]');
            expect(found).not.toBeNull();
            return found!;
        });
        const text = row.textContent ?? '';
        const trigger = text.indexOf(t('automations.list.noAutomaticTriggers'));
        const steps = text.indexOf(t('workflows.examples.stepCount', { count: 1 }));
        expect(trigger).toBeGreaterThanOrEqual(0);
        expect(steps).toBeGreaterThan(trigger);
    });

    it.each([1440, 390])('starts every section title on the one page edge at %i px (DESIGN-9 N38)', async (width) => {
        const { t } = await import('@/text');
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        await act(async () => {
            root!.render(React.createElement(View, { style: { width } }, <InjectedAuthProvider credentials={boundary!.credentials}><UniversalSearchRuntimeProvider value={searchRuntime}><WorkflowsLibraryHome /></UniversalSearchRuntimeProvider></InjectedAuthProvider>));
        });
        // Windowed Collection rows mount after its browser onLayout boundary has measured the viewport.
        await measureWebLayout(host, { viewport: { width, height: 3200 }, settle: replay => act(replay) });
        await act(async () => {
            await vi.waitFor(() => expect(host!.querySelector('[data-testid="workflows-home:row:saved"]')).not.toBeNull());
        });
        const library = t('workflows.destination.sections.library');
        const builtIn = t('workflows.page.blocks.builtin');
        const examples = t('workflows.examples.title');
        const layout = await measureWebLayout(host, {
            viewport: { width, height: 3200 },
            texts: [library, builtIn, examples],
            settle: (replay) => act(replay),
        });
        const left = (text: string) => {
            const rects = layout.textRects(text);
            expect(rects.length, text).toBeGreaterThan(0);
            return rects[0]!.left;
        };
        expect(Math.abs(left(library) - left(builtIn))).toBeLessThanOrEqual(1);
        expect(Math.abs(left(examples) - left(builtIn))).toBeLessThanOrEqual(1);
    });
});
