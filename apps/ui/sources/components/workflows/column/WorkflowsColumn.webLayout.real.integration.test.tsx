// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { UniversalSearchRuntimeProvider } from '@/components/appShell/search/UniversalSearchRuntimeContext';
import { installWorkflowActionHttpBoundary } from '@/dev/testkit/fixtures/workflowActionHttpBoundary';
import { createThemeFixture } from '@/dev/testkit/fixtures/themeFixtures';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installWebLayoutBridge, measureWebLayout } from '@/dev/testkit/render/measureWebLayout';
import { storage } from '@/sync/domains/state/storageStore';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';

import { WorkflowsColumn } from './WorkflowsColumn';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
vi.mock('@/sync/domains/state/browserRecordStorage', async () =>
    (await import('@/dev/testkit/mocks/browserRecordStorage')).createBrowserRecordStorageModuleMock());
vi.mock('expo-router', async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ pathname: '/workflows' }).module);
vi.mock('react-native-unistyles', async () =>
    (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@legendapp/list/react-native', async original =>
    (await import('@/dev/testkit/mocks/legendList')).createCapturingLegendListMock({ original: await original<Record<string, unknown>>() }).module);

installDisconnectedServerSocketBoundary(configureConnectedServerSocketBoundary);
installWebLayoutBridge();

const searchRuntime = { open: () => {}, buildCommands: () => [] };
let boundary: Awaited<ReturnType<typeof installWorkflowActionHttpBoundary>>;
let singleton: Awaited<ReturnType<typeof loadSyncSingletonForTests>>;
let locks: ReturnType<typeof installWebLockManagerMock>;
let previousState = storage.getState();

beforeEach(async () => {
    previousState = storage.getState();
    locks = installWebLockManagerMock();
    singleton = await loadSyncSingletonForTests();
    await (await import('@/sync/domains/server/serverRuntime')).upsertAndActivateServer({ serverUrl: 'http://workflow-column-browser.test', scope: 'tab' });
    boundary = await installWorkflowActionHttpBoundary({ accountId: () => 'account-a', fixtureResponse: async actionId => {
        if (actionId === 'workflow.definition.list') return { ok: true, result: { definitions: [] } };
        throw new Error(`Unexpected Workflow browser fixture Action ${actionId}`);
    } });
    await (await import('@/sync/runtime/orchestration/connectionManager')).restoreConnectionToActiveServer(boundary.credentials);
    await waitForHomeGovernance(() => {
        const scope = { serverId: boundary.serverId, accountId: 'account-a' };
        expect(storage.getState().profileScope).toEqual(scope);
        expect(storage.getState().settingsScope).toEqual(scope);
        expect(storage.getState().settingsVersion).toBe(1);
    });
    const { sync } = await import('@/sync/sync');
    expect(await sync.awaitBootstrapForegroundAcquisition()).toBe(true);
    await sync.resumeSync('server-reachable');
    storage.getState().applySettingsLocal({ experiments: true,
        featureToggles: { ...storage.getState().settings.featureToggles, automations: true } });
    boundary.prime();
});

afterEach(async () => {
    (await import('@/components/workflows/library/workflowLibraryReads')).resetWorkflowLibraryReadsForTests();
    await boundary?.dispose();
    singleton?.dispose();
    storage.setState(previousState);
    locks?.restore();
});

it('makes a failed-library retry visibly keyboard focusable with its button role', async () => {
    const artifactRequests: string[] = [];
    setRuntimeFetch(async (url, init) => {
        const target = new URL(String(url));
        if (target.pathname === '/v1/artifacts' && JSON.parse(target.searchParams.get('kinds') ?? '[]').includes('workflow-definition.v1')) {
            artifactRequests.push(target.href);
            return Response.json({ artifacts: 'invalid-page' });
        }
        return boundary.request(url, init);
    });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const theme = document.createElement('style');
    theme.textContent = readFileSync(resolve(process.cwd(), 'sources/theme.css'), 'utf8');
    document.head.append(theme);
    const html = document.documentElement;
    const previousStyle = html.getAttribute('style');
    const previousModality = html.getAttribute('data-happier-input-modality');
    html.style.setProperty('--colors-border-focus', createThemeFixture().colors.border.focus);
    const testID = 'workflows-column:library:failed:retry';
    try {
        await act(async () => root.render(<InjectedAuthProvider credentials={boundary.credentials}>
            <UniversalSearchRuntimeProvider value={searchRuntime}><WorkflowsColumn /></UniversalSearchRuntimeProvider>
        </InjectedAuthProvider>));
        await vi.waitFor(async () => {
            await act(async () => {});
            expect(host.querySelector(`[data-testid="${testID}"]`)).not.toBeNull();
        });
        const target = host.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
        if (!target) throw new Error('The failed Workflow library must expose Retry');
        expect(target.getAttribute('role')).toBe('button');
        document.dispatchEvent(new Event('pointerdown', { bubbles: true }));
        const pointer = await measureWebLayout(host, { viewport: { width: 390, height: 700 }, focusedTestId: testID });
        expect(pointer.rect(testID).outlineStyle).toBe('none');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
        await act(async () => target.focus());
        const keyboard = await measureWebLayout(host, { viewport: { width: 390, height: 700 }, focusedTestId: testID });
        expect(keyboard.rect(testID).outlineStyle).toBe('solid');
        expect(keyboard.rect(testID).outlineWidth).toBe(2);
        const beforeRetry = artifactRequests.length;
        await act(async () => target.click());
        await vi.waitFor(() => expect(artifactRequests.length).toBeGreaterThan(beforeRetry));
    } finally {
        await act(async () => root.unmount());
        host.remove();
        theme.remove();
        if (previousStyle === null) html.removeAttribute('style');
        else html.setAttribute('style', previousStyle);
        if (previousModality === null) html.removeAttribute('data-happier-input-modality');
        else html.setAttribute('data-happier-input-modality', previousModality);
    }
});
