import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installVitestRnShim } from '@/dev/vitestRnShim';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { deleteServerFeaturesSnapshot, primeServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { removeServerProfile } from '@/sync/domains/server/serverProfiles';

import { InboxSummaryProvider, useSharedInboxSummary, type InboxSummary } from './useInboxSummary';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The rail badge counts 03's workflow attention window (ORC R-10, FIN 03 §6.4): the server's
 * `attention: 'required'` predicate, held in the canonical `attention` window the Workflows
 * column reads. Only HTTP, Socket.IO and the device credential store are replaced;
 * the Action parser, store, loader, applied Home lifetime and Account wake are real.
 */
const listRuns = vi.fn<(input: { operation: string; request: { filter?: Record<string, unknown> } }) => Promise<unknown>>();
let workflowsEnabled = true;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
const initialState = storage.getInitialState();

installDisconnectedServerSocketBoundary();
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('@more-tech/react-native-libsodium', () => import('libsodium-wrappers'));
vi.mock('@/platform/cryptoRandom', () => import('@/platform/cryptoRandom.node'));
vi.mock('@/platform/digest', () => import('@/platform/digest.node'));
vi.mock('@/platform/hmacSha512', () => import('@/platform/hmacSha512.node'));
vi.mock('@/platform/randomUUID', () => import('@/platform/randomUUID.node'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-updates', async () => (await import('@/dev/testkit/mocks/expoUpdates')).createExpoUpdatesMock());
vi.mock('react-native-typography', async () => (await import('@/dev/testkit/mocks/reactNativeTypography')).createReactNativeTypographyMock());
vi.mock('@shopify/react-native-skia', async () => (await import('@/dev/testkit/mocks/reactNativeSkia')).createReactNativeSkiaMock());
vi.mock('expo-image', () => ({ Image: 'Image' }));

function features() {
    return createRootLayoutFeaturesResponse({ features: {
        workflows: { enabled: workflowsEnabled }, automations: { enabled: true }, social: { friends: { enabled: false } },
    } });
}

function page(runIds: readonly string[]) {
    return {
        runs: runIds.map((id) => createWorkflowRunSummaryFixture({ id, state: 'interrupted' })),
        acceptedEnvelopesByRunId: {},
        keyCensusByRunId: {},
        nextCursor: undefined,
    };
}

let latest: InboxSummary | null = null;
function Probe(): null {
    latest = useSharedInboxSummary();
    return null;
}

async function renderSummary() {
    const screen = await renderScreen(<InboxSummaryProvider><Probe /></InboxSummaryProvider>);
    await act(async () => {});
    return screen;
}

describe('useInboxSummary workflow source', () => {
    beforeAll(async () => {
        vi.stubGlobal('__DEV__', true);
        vi.stubGlobal('self', globalThis);
        installVitestRnShim();
        await loadSyncSingletonForTests();
    });
    beforeEach(async () => {
        latest = null;
        listRuns.mockReset();
        workflowsEnabled = true;
        storage.setState(initialState, true);
        connection = await restoreServerAccountForTest({ serverUrl: 'https://inbox-summary.example.test', accountId: 'account-a', request: async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(features());
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
            if (path === '/v2/cursor') return Response.json({ cursor: 0, changesFloor: 0 });
            if (path === '/health') return Response.json({ status: 'ok' });
            if (path === '/v3/automations/runs') return Response.json({ runs: [], nextCursor: null });
            if (path === '/v3/automations/runs/workflow-storage') return Response.json(await listRuns(JSON.parse(String(init?.body))));
            return new Response('{}', { status: 404 });
        } });
        primeServerFeaturesSnapshot({ snapshot: { status: 'ready', features: features() } });
        storage.setState({
            settings: { ...storage.getState().settings, experiments: true,
                featureToggles: { ...storage.getState().settings.featureToggles, automations: true } },
            friends: {},
            sessions: {},
            sessionListRowsByServerId: {},
            ordinarySessionListMembershipByServerId: {},
            artifacts: {},
            isDataReady: true,
            workflowRunsById: {},
            workflowRunListWindows: {},
        });
    });
    afterEach(async () => {
        standardCleanup();
        (await import('@/components/workflows/library/workflowLibraryReads')).resetWorkflowLibraryReadsForTests();
        await connection?.dispose();
        deleteServerFeaturesSnapshot();
        if (connection) await removeServerProfile(connection.home.id);
        connection = null;
        storage.setState(initialState, true);
    });

    it("counts the server's attention window in the badge, in the window the Workflows column reads", async () => {
        listRuns.mockResolvedValueOnce(page(['run-held', 'run-interrupted']));

        await renderSummary();

        expect(listRuns).toHaveBeenCalledTimes(1);
        expect(listRuns.mock.calls[0]?.[0].request.filter).toEqual({ attention: 'required' });
        expect(latest).toEqual({ count: 2, hasContent: true });
        expect(storage.getState().workflowRunListWindows.attention?.runIds).toEqual(['run-held', 'run-interrupted']);
    });

    it('lets an answered off-page hold recede on the next Account-change wake', async () => {
        listRuns.mockResolvedValueOnce(page(['run-held'])).mockResolvedValueOnce(page([]));

        await renderSummary();
        expect(latest?.count).toBe(1);

        await act(async () => {
            publishHomeAccountChange(connection!.home.id, ['workflow-run:run-held']);
        });
        await act(async () => {});

        expect(listRuns).toHaveBeenCalledTimes(2);
        expect(latest).toEqual({ count: 0, hasContent: false });
    });

    it('reads nothing and counts nothing when the Home does not offer Workflows', async () => {
        workflowsEnabled = false;
        primeServerFeaturesSnapshot({ snapshot: { status: 'ready', features: features() } });

        await renderSummary();

        expect(listRuns).not.toHaveBeenCalled();
        expect(latest).toEqual({ count: 0, hasContent: false });
    });
});
