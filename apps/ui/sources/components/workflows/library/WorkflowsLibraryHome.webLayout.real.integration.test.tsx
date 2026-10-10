// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { View } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installWebLayoutBridge, measureWebLayout } from '@/dev/testkit/render/measureWebLayout';

/**
 * The Workflows home as a browser lays it out (lab `nav-N1`): the page title, every section title
 * and every sheet share one left edge, whichever owner draws the section (DESIGN-8/9 N38).
 */

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ pathname: '/workflows' }).module);
const execute = vi.hoisted(() => vi.fn());
// The Action transport is a system boundary; the library reader, Collection and sections stay real.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    return { ...actual, createFrontDoorActionExecute: () => execute,
        createFrontDoorUiActionExecutor: () => actual.createFrontDoorUiActionExecutor({ execute }) };
});
vi.mock('@/sync/api/capabilities/serverFeaturesClient', async (original) => {
    const snapshot = { status: 'ready' as const, features: (await import('@/dev/testkit/fixtures/featureFixtures')).createRootLayoutFeaturesResponse() };
    return { ...await original<typeof import('@/sync/api/capabilities/serverFeaturesClient')>(),
        getCachedServerFeaturesSnapshot: () => snapshot, getServerFeaturesSnapshot: async () => snapshot };
});
vi.mock('@/auth/storage/tokenStorage', async (original) => {
    const module = await original<typeof import('@/auth/storage/tokenStorage')>();
    return { ...module, TokenStorage: { ...module.TokenStorage,
        getCredentialsForServerUrl: async () => ({ token: 'header.eyJzdWIiOiJhY2NvdW50LWEifQ==.signature' }) } };
});

installWebLayoutBridge();

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(async () => {
    // jsdom has no Web Locks API (a browser platform boundary); one tab holds every lock at once.
    if (!('locks' in navigator)) {
        Object.defineProperty(navigator, 'locks', { configurable: true,
            value: { request: async (_name: string, run: () => Promise<unknown>) => await run() } });
    }
    const { storage } = await import('@/sync/domains/state/storageStore');
    const runtime = await import('@/sync/domains/server/serverRuntime');
    const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
    const home = await runtime.upsertAndActivateServer({ serverUrl: 'http://library-layout.test', name: 'Library' });
    publishAppliedActiveServerSnapshot(runtime.getActiveServerSnapshot());
    const { settingsDefaults } = await import('@/sync/domains/settings/settings');
    storage.setState({ profileScope: { serverId: home.id, accountId: 'account-a' },
        settings: { ...settingsDefaults, experiments: true, featureToggles: { automations: true } },
        workflowRunListWindows: {}, workflowRunsById: {} });
    execute.mockImplementation(async (actionId: string) => {
        if (actionId === 'workflow.definition.list') return { ok: true, result: { definitions: [{
            kind: 'workflow-definition.v1', definitionId: 'saved', revision: { headerVersion: 1, bodyVersion: 1 },
            metadata: { title: 'Saved workflow' }, ownerAccountId: 'account-a', access: 'owner',
            contentStatus: 'available', stepCount: 1, triggers: [], nextRunAt: null,
        }] } };
        if (actionId === 'workflow.run.summaries') return { ok: true, result: { summaries: [], remainingSourceArtifactIds: [] } };
        if (actionId === 'workflow.run.list') return { ok: true, result: { runs: [], metadataByRunId: {} } };
        return { ok: false, errorCode: 'unexpected', error: 'unexpected' };
    });
});

afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    host?.remove();
    host = null;
    (await import('./workflowLibraryReads')).resetWorkflowLibraryReadsForTests();
    execute.mockReset();
});

describe('Workflows home, as a browser lays it out', () => {
    it.each([1440, 390])('starts every section title on the one page edge at %i px (DESIGN-9 N38)', async (width) => {
        const { WorkflowsLibraryHome } = await import('./WorkflowsLibraryHome');
        const { t } = await import('@/text');
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        await act(async () => {
            root!.render(React.createElement(View, { style: { width } }, React.createElement(WorkflowsLibraryHome)));
        });
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });
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
