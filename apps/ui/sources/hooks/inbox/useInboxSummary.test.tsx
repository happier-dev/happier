import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installVitestRnShim } from '@/dev/vitestRnShim';
import { createAutomationRunFixture, createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { deleteServerFeaturesSnapshot, getServerFeaturesSnapshot, primeServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { removeServerProfile } from '@/sync/domains/server/serverProfiles';

import { InboxSummaryProvider, useSharedInboxSummary, type InboxSummary } from './useInboxSummary';
import { useWorkflowAttentionSource } from './useWorkflowAttentionSource';
import { createUsageNoticeArtifactFixture } from '@/dev/testkit/fixtures/usageNoticeFixtures';
import { InboxModelProvider, useInboxModel, type InboxModel } from './useInboxModel';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent, decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The rail badge counts 03's workflow attention window (ORC R-10, FIN 03 §6.4): the server's
 * `attention: 'required'` predicate, held in the canonical `attention` window the Workflows
 * column reads. Only HTTP, Socket.IO and the device credential store are replaced;
 * the Action parser, store, loader, applied Home lifetime and Account wake are real.
 */
const listRuns = vi.fn<(input: { operation: string; request: { attention?: string } }) => Promise<unknown>>();
const listAutomationRuns = vi.fn<() => Promise<unknown>>();
let workflowsEnabled = true;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
const initialState = storage.getInitialState();
let artifactRead = createUsageNoticeArtifactFixture();
let artifactWrites: Array<Record<string, unknown>> = [];
let disposeActionLoader: (() => void) | undefined;

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
let attention: ReturnType<typeof useWorkflowAttentionSource> | null = null;
function Probe(): null {
    latest = useSharedInboxSummary();
    attention = useWorkflowAttentionSource();
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
        disposeActionLoader = await installRealActionExecutorModuleLoader();
    });
    afterAll(() => disposeActionLoader?.());
    beforeEach(async () => {
        latest = null;
        attention = null;
        listRuns.mockReset();
        listAutomationRuns.mockReset().mockResolvedValue({ runs: [], nextCursor: null });
        workflowsEnabled = true;
        artifactRead = createUsageNoticeArtifactFixture();
        artifactWrites = [];
        storage.setState(initialState, true);
        connection = await restoreServerAccountForTest({ serverUrl: 'https://inbox-summary.example.test', accountId: 'account-a', request: async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(features());
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            // The real restoration owner may finish hydration after the probe mounts.
            // Its remote baseline must agree with the feature policy this Home offers.
            if (path === '/v2/account/settings') return Response.json({
                content: { t: 'plain', v: { experiments: true, featureToggles: { automations: true } } }, version: 1,
            });
            if (path === '/v2/cursor') return Response.json({ cursor: 0, changesFloor: 0 });
            if (path === '/health') return Response.json({ status: 'ok' });
            if (path === '/v3/automations/runs') return Response.json(await listAutomationRuns());
            if (path === '/v3/automations/runs/workflow-storage') return Response.json(await listRuns(JSON.parse(String(init?.body))));
            if (path === `/v1/artifacts/${artifactRead.id}`) {
                if (init?.method === 'POST') {
                    artifactWrites.push(JSON.parse(String(init.body)));
                    return Response.json({ success: true, headerVersion: 4, bodyVersion: 3 });
                }
                return Response.json({ id: artifactRead.id, ownerAccountId: artifactRead.ownerAccountId,
                    access: artifactRead.access, publicAudience: artifactRead.publicAudience, encryptionMode: 'plain',
                    dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                    header: encodePlainArtifactStoredContent(artifactRead.rawHeader),
                    body: encodePlainArtifactStoredContent({ body: artifactRead.body }),
                    headerVersion: artifactRead.headerVersion, bodyVersion: artifactRead.bodyVersion,
                    seq: 1, createdAt: 1000, updatedAt: 2000 });
            }
            return new Response('{}', { status: 404 });
        } });
        primeServerFeaturesSnapshot({ snapshot: { status: 'ready', features: features() } });
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        storage.setState({
            profileScope: { serverId: connection.home.id, accountId: 'account-a' },
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

        expect(listRuns, JSON.stringify(attention)).toHaveBeenCalledTimes(1);
        expect(listRuns.mock.calls[0]?.[0].request.attention).toBe('required');
        expect(latest).toEqual({ count: 2, hasContent: true });
        expect(storage.getState().workflowRunListWindows.attention?.runIds).toEqual(['run-held', 'run-interrupted']);
    });

    it('counts an ordinary Automation failure with Workflows disabled', async () => {
        await getServerFeaturesSnapshot({ serverId: connection!.home.id, force: true });
        workflowsEnabled = false;
        primeServerFeaturesSnapshot({ serverId: connection!.home.id, snapshot: { status: 'ready', features: features() } });
        listAutomationRuns.mockResolvedValue({ runs: [createAutomationRunFixture({ id: 'pre-session', state: 'failed' })], nextCursor: null });
        await renderSummary();
        expect(listRuns).not.toHaveBeenCalled();
        expect(latest).toEqual({ count: 1, hasContent: true });
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
        // Drain restoration's initial public observation before changing the served capability.
        await getServerFeaturesSnapshot({ serverId: connection!.home.id, force: true });
        workflowsEnabled = false;
        primeServerFeaturesSnapshot({ serverId: connection!.home.id, snapshot: { status: 'ready', features: features() } });

        await renderSummary();

        expect(listRuns).not.toHaveBeenCalled();
        expect(latest).toEqual({ count: 0, hasContent: false });
    });

    it('counts private open usage notices and retires them when the Account changes', async () => {
        listRuns.mockResolvedValue(page([]));
        const notice = createUsageNoticeArtifactFixture();
        storage.setState({ artifacts: { [notice.id]: notice,
            shared: { ...notice, id: 'shared', ownerAccountId: 'account-b', access: 'view' },
            closed: createUsageNoticeArtifactFixture({ id: 'closed', header: { ...notice.header!, status: 'dismissed' } }),
        } });
        await renderSummary();
        expect(latest).toEqual({ count: 1, hasContent: true });
        await act(async () => { storage.setState({ profileScope: {
            serverId: connection!.home.id, accountId: 'account-b',
        } }); });
        expect(latest).toEqual({ count: 0, hasContent: false });
    });

    it('dismisses a usage notice through the Account Artifact CAS preserving its exact body, and refuses changed revisions or privacy', async () => {
        listRuns.mockResolvedValue(page([]));
        storage.setState({ artifacts: { [artifactRead.id]: artifactRead } });
        let inbox: InboxModel | null = null;
        function ModelProbe() { inbox = useInboxModel(); return null; }
        await renderScreen(<InboxModelProvider><ModelProbe /></InboxModelProvider>);
        await act(async () => {});
        const readModel = () => inbox!;
        const entry = readModel().openUsageNotices[0]!;
        await act(async () => { await readModel().dismissUsageNotice(entry); });
        expect(artifactWrites).toHaveLength(1);
        expect(artifactWrites[0]).toMatchObject({ expectedHeaderVersion: 3, expectedBodyVersion: 2 });
        expect(decodePlainArtifactStoredContent(artifactWrites[0]!.header as string)).toMatchObject({ status: 'dismissed', notice: entry.header.notice });
        expect(decodePlainArtifactStoredContent(artifactWrites[0]!.body as string)).toEqual({ body: artifactRead.body });
        expect(readModel().openUsageNotices).toEqual([]);
        artifactRead = { ...artifactRead, headerVersion: 4 };
        await act(async () => { await expect(readModel().dismissUsageNotice(entry)).rejects.toThrow(); });
        expect(artifactWrites).toHaveLength(1);
        artifactRead = { ...artifactRead, publicAudience: 'retained' };
        await act(async () => { await expect(readModel().dismissUsageNotice(entry)).rejects.toThrow(); });
        expect(artifactWrites).toHaveLength(1);
    });
});
