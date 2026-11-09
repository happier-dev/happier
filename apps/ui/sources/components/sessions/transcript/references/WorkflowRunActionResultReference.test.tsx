import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    WorkflowRunListRequestV1Schema} from '@happier-dev/protocol/workflows/actionsV1';
import {
    WorkflowRunRecipientCensusResponseV1Schema} from '@happier-dev/protocol/workflows/workflowRunKeyV1';
import {
    materializeWorkflowAcceptedSnapshotV1} from '@happier-dev/protocol/workflows/materializeWorkflowAcceptedSnapshotV1';
import {
    sealWorkflowAcceptedSnapshotStoredEnvelopeV1,
    serializeWorkflowStoredContentEnvelopeV1,
} from '@happier-dev/protocol/workflows/workflowStoredContentV1';

import { collectHostText, createDeferred, createRootLayoutFeaturesResponse, flushHookEffects, makeToolCall, renderWithSessionTranscriptSource, createTestSessionTranscriptSource, standardCleanup } from '@/dev/testkit';
import { createWorkflowDefinitionFixture, createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

/**
 * The agent-origin managed workflow card at the real transcript row.
 *
 * `workflow.run.start` already reached agents through the Action front door and
 * its result reference parser already existed in Protocol, but no transcript
 * row consumed it: an Agent that started a workflow produced a JSON blob in the
 * transcript and the Account Run store learned about the Run only when the
 * change stream or a list page happened to mention it.
 *
 * These tests mount the REAL tool rows and the REAL Account-scoped Run store.
 * Action admission, feature availability, private-content opening and Account
 * retirement stay real; only HTTP, Socket.IO and device credentials are replaced.
 */

const RUN_ID = '0f2cf13d-4ad7-4f4b-b5e0-cc3b7dce7f11';
const ACCOUNT_ID = 'account-a';
const STORAGE_ROUTE = '/v3/automations/runs/workflow-storage';
const pushSpy = vi.hoisted(() => vi.fn());
function renderScreen(element: React.ReactElement) {
    return renderWithSessionTranscriptSource(
        <InjectedAuthProvider credentials={credentials}>{element}</InjectedAuthProvider>,
        createTestSessionTranscriptSource({ sessionId: 'session-1', serverId, navigate: pushSpy }),
    );
}

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: pushSpy } }).module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});
// The installed vendor omits this web leaf; preserve text at that external
// rendering boundary while the app's StreamingTextReveal stays real.
vi.doMock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: ({ text, startOffset }: { text: string; startOffset: number }) => [
        { text, startOffset, animated: false },
    ],
}));
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
installDisconnectedServerSocketBoundary();
await import('react-native-enriched-markdown/lib/module/web/streamingReveal.js');
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { workflowRunRowFromSummary, workflowRunStoreKey } = await import('@/sync/store/domains/workflowRuns');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { deleteServerFeaturesSnapshot, primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { ToolTimelineRow } = await import('@/components/tools/shell/views/ToolTimelineRow');
const { ToolView } = await import('@/components/tools/shell/views/ToolView');
let serverId: string;
let credentials: Awaited<ReturnType<typeof TokenStorage.getCredentialsForServerUrl>>;
let previousState = storage.getState();
let previousSnapshot = getActiveServerSnapshot();

function startResult(overrides: Record<string, unknown> = {}) {
    return JSON.stringify({
        run: createWorkflowRunSummaryFixture({
            id: RUN_ID,
            ownerAccountId: ACCOUNT_ID,
            origin: { kind: 'direct', originSessionId: 'session-1' },
        }),
        admission: 'created',
        ...overrides,
    });
}

function startToolCall(overrides: Record<string, unknown> = {}) {
    return makeToolCall({
        name: 'mcp__happier__workflow_run_start',
        state: 'completed',
        input: { runId: RUN_ID, source: { kind: 'inline', definition: { blocks: ['Analyze the repository'] } } },
        result: startResult(),
        ...overrides,
    });
}

async function getResult(
    state: 'running' | 'succeeded' | 'interrupted',
    revision = 2,
    metadata: Readonly<{ title: string }> | null | false = { title: 'Release audit' },
) {
    const run = createWorkflowRunSummaryFixture({ id: RUN_ID, ownerAccountId: ACCOUNT_ID,
        origin: { kind: 'direct', originSessionId: 'session-1' }, state, revision });
    if (run.origin.kind !== 'direct') throw new Error('direct_run_fixture_required');
    const accepted = await materializeWorkflowAcceptedSnapshotV1({
        definition: createWorkflowDefinitionFixture({ blocks: [{ kind: 'wait', id: 'wait',
            document: { text: 'Continue', references: [], attachments: [] } }] }),
        admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true },
        context: { source: { kind: 'inline' }, inputs: {}, machineId: run.machineId,
            executionTarget: { kind: 'session' },
            workspaceTarget: { project: { machineId: run.machineId, directory: '/repo', checkoutRootPath: '/repo' } },
            origin: run.origin, authorization: { principal: { kind: 'host' } },
            ...(metadata ? { metadata } : {}) },
    });
    if (!accepted.ok) throw new Error(`fixture_materialization_failed:${accepted.error.code}`);
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'accepted_snapshot', accountId: ACCOUNT_ID, runId: RUN_ID }, acceptedSnapshot: accepted.snapshot }));
    const keyCensus = WorkflowRunRecipientCensusResponseV1Schema.parse({ runId: RUN_ID, ownerAccountId: ACCOUNT_ID,
        access: 'owner', encryptionMode: 'plain', dataEncryptionKey: null, callerDataEncryptionKey: null,
        recipients: [], visibleTeamId: null, ownerAccountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null } });
    // Missing accepted bytes is an authoritative unavailable projection; an
    // opened snapshot without metadata is a readable untitled Run.
    return { runs: [run], acceptedEnvelopesByRunId: metadata === null ? {} : { [RUN_ID]: acceptedEnvelope },
        keyCensusByRunId: { [RUN_ID]: keyCensus } };
}

async function answerRun(state: 'running' | 'succeeded' | 'interrupted', revision = 2,
    metadata: Readonly<{ title: string }> | null | false = { title: 'Release audit' }) {
    home.answer(serverId, STORAGE_ROUTE, { body: await getResult(state, revision, metadata) });
}

/** The row's own exact Run reads; the mounted live mini-map reads the Run's map separately (07 S15). */
function rowReads() {
    return home.requestsFor(STORAGE_ROUTE).filter((request) => (request.input as { operation?: unknown }).operation === 'list');
}

async function renderCardRow(
    tool = startToolCall(),
    targetServerId: string | null = serverId,
) {
    return renderScreen(
        <ToolView
            tool={tool}
            metadata={null}
            messages={[]}
            sessionId="session-1"
            {...(targetServerId === null ? {} : { serverId: targetServerId })}
            messageId="message-1"
        />,
    );
}

async function renderTimelineRow(tool = startToolCall()) {
    return renderScreen(
        <ToolTimelineRow
            tool={tool}
            metadata={null}
            messages={[]}
            sessionId="session-1"
            serverId={serverId}
            messageId="message-1"
        />,
    );
}

async function settle(): Promise<void> {
    await act(async () => {
        await flushHookEffects({ cycles: 40 });
    });
}

beforeEach(async () => {
    previousState = storage.getState();
    previousSnapshot = getActiveServerSnapshot();
    await home.reset();
    serverId = await home.addHome({ name: 'Transcript Home', serverUrl: 'https://transcript-workflow.test', accountId: ACCOUNT_ID });
    credentials = await TokenStorage.getCredentialsForServerUrl(getActiveServerSnapshot().serverUrl);
    home.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
    pushSpy.mockReset();
    storage.setState({ workflowRunsById: {}, workflowRunInvocationsByRunId: {}, workflowRunListWindows: {},
        settings: { ...storage.getState().settings, experiments: true, featureToggles: { automations: true } } });
    storage.getState().activateProfileScope({ serverId, accountId: ACCOUNT_ID });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features: createRootLayoutFeaturesResponse() } });
});

afterEach(async () => {
    await standardCleanup();
    await home.reset();
    storage.setState(previousState, true);
    publishAppliedActiveServerSnapshot(previousSnapshot);
    resetServerFeaturesClientForTests();
});

describe('inline transcript workflow Run result', () => {
    it('promotes a membership-only row through the existing exact reader before showing its private title', async () => {
        const run = createWorkflowRunSummaryFixture({ id: RUN_ID, ownerAccountId: ACCOUNT_ID, revision: 2,
            origin: { kind: 'direct', originSessionId: 'session-1' } });
        storage.getState().applyWorkflowRunListPage({ windowId: 'attention', runs: [run], projection: 'membership',
            metadataByRunId: {}, mode: 'replace', nextCursor: null });
        await answerRun('running', 2);
        const screen = await renderCardRow(); await settle();
        expect(rowReads().map(request => request.input)).toEqual([
            expect.objectContaining({ operation: 'list', request: WorkflowRunListRequestV1Schema.parse({ runIds: [RUN_ID], invocationProvenance: [] }) }),
        ]);
        expect(collectHostText(screen.tree)).toContain('Release audit');
        expect(collectHostText(screen.tree)).not.toContain('workflows.run.untitled');
    });

    it('mounts the exact Run card and refreshes that Run into the Account store once', async () => {
        await answerRun('running');
        const screen = await renderCardRow();
        await settle();

        expect(screen.findByTestId(`transcript-workflow-run-${RUN_ID}`)).toBeTruthy();
        // The observed HTTP request comes through real Account Action admission.
        // It remains the exact lean list, without detail or invocation history.
        expect(rowReads().map(request => request.input)).toEqual([
            expect.objectContaining({ operation: 'list', request: WorkflowRunListRequestV1Schema.parse({ runIds: [RUN_ID], invocationProvenance: [] }) }),
        ]);
        expect(storage.getState().workflowRunsById[workflowRunStoreKey(RUN_ID)]?.summary?.state).toBe('running');
        expect(screen.findByTestId(`transcript-workflow-run-${RUN_ID}-state`)).toBeTruthy();
        const text = collectHostText(screen.tree);
        expect(text).toContain('workflows.runState.running');
        // The accepted private title, read from the same exact Run summary.
        expect(text).toContain('Release audit');
        expect(text).not.toContain('workflows.run.untitled');
    });

    /**
     * A historical start result stays in the transcript after Workflows are
     * turned off. The card answers the same canonical decision as the
     * destination route, so it neither advertises a Run nobody can open here
     * nor reads it: unresolved and unknown fail closed exactly like disabled.
     */
    it.each([
        ['disabled', { status: 'ready', features: createRootLayoutFeaturesResponse({ features: { workflows: { enabled: false } } }) }],
        ['unknown', { status: 'error', reason: 'network' }],
        ['unresolved', null],
    ] as const)('renders no card and reads nothing on a %s Workflows decision', async (_label, decision) => {
        const pendingFeatures = decision === null ? createDeferred<void>() : null;
        if (decision === null) {
            deleteServerFeaturesSnapshot({ serverId });
            for (const path of ['/v1/features', '/v1/features/authenticated']) {
                home.answer(serverId, path, { body: createRootLayoutFeaturesResponse(), respondAfter: pendingFeatures?.promise });
            }
        } else {
            primeServerFeaturesSnapshot({ serverId, snapshot: decision });
        }
        try {
            await answerRun('running');
            const screen = await renderCardRow();
            await settle();

            expect(screen.findAllByProps({ testID: `transcript-workflow-run-${RUN_ID}` })).toHaveLength(0);
            expect(home.requestsFor(STORAGE_ROUTE)).toHaveLength(0);
        } finally {
            if (pendingFeatures) {
                await standardCleanup();
                pendingFeatures.resolve();
                await settle();
            }
        }
    });

    it('says private content is unavailable only when the owner says so', async () => {
        await answerRun('running', 2, null);
        const screen = await renderCardRow();
        await settle();

        const text = collectHostText(screen.tree);
        expect(text).toContain('workflows.contentUnavailable');
        expect(text).not.toContain('workflows.run.untitled');
    });

    it('names a readable Run without an authored title untitled instead of unavailable', async () => {
        await answerRun('running', 2, false);
        const screen = await renderCardRow();
        await settle();

        expect(storage.getState().workflowRunsById[workflowRunStoreKey(RUN_ID)]?.summary?.state).toBe('running');
        expect(storage.getState().workflowRunsById[workflowRunStoreKey(RUN_ID)]?.metadata).toBeNull();
        const text = collectHostText(screen.tree);
        expect(text).toContain('workflows.run.untitled');
        expect(text).not.toContain('workflows.contentUnavailable');
    });

    it('reads a Run the store already holds without another request and follows its live updates', async () => {
        storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(createWorkflowRunSummaryFixture({
            id: RUN_ID,
            ownerAccountId: ACCOUNT_ID,
            origin: { kind: 'direct', originSessionId: 'session-1' },
            state: 'running',
            revision: 3,
        }))]);
        const screen = await renderCardRow();
        await settle();

        expect(rowReads()).toHaveLength(0);
        expect(collectHostText(screen.tree)).toContain('workflows.runState.running');

        // The canonical invalidation owner upserts the newer revision; the
        // card follows the one shared row rather than polling.
        await act(async () => {
            storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(createWorkflowRunSummaryFixture({
                id: RUN_ID,
                ownerAccountId: ACCOUNT_ID,
                origin: { kind: 'direct', originSessionId: 'session-1' },
                state: 'succeeded',
                revision: 4,
                updatedAt: '2026-09-08T10:05:00.000Z',
            }))]);
        });
        const text = collectHostText(screen.tree);
        expect(text).toContain('workflows.runState.succeeded');
        expect(text).not.toContain('workflows.runState.running');
    });

    it('offers Save as workflow only for a workflow written for this task, and saving writes nothing', async () => {
        const seed = (sourceArtifactId: string | null) => storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(createWorkflowRunSummaryFixture({
            id: RUN_ID, ownerAccountId: ACCOUNT_ID, origin: { kind: 'direct', originSessionId: 'session-1' },
            state: 'running', revision: 3, sourceArtifactId,
        }))]);
        seed(null);
        const sourceless = await renderCardRow();
        await settle();
        expect(collectHostText(sourceless.tree)).toContain('workflows.transcriptCard.writtenForTask');
        await sourceless.pressByTestIdAsync(`transcript-workflow-run-${RUN_ID}-save`);
        await settle();
        const operations = home.requestsFor(STORAGE_ROUTE).map((request) => (request.input as { operation?: unknown }).operation);
        // Save reads the exact Run for its draft; nothing is created, saved or changed.
        expect(operations).toContain('get');
        expect(operations.every((operation) => operation === 'get' || operation === 'invocations.list')).toBe(true);
        await sourceless.unmount();

        storage.setState({ workflowRunsById: {} });
        seed('11111111-1111-4111-8111-111111111111');
        const saved = await renderCardRow();
        await settle();
        expect(saved.findAllHostsByTestId(`transcript-workflow-run-${RUN_ID}-save`)).toHaveLength(0);
        expect(collectHostText(saved.tree)).not.toContain('workflows.transcriptCard.writtenForTask');
    });

    it('opens the exact Run route, never a latest-run lookup', async () => {
        await answerRun('running');
        const screen = await renderCardRow();
        await settle();

        await screen.pressByTestIdAsync(`transcript-workflow-run-${RUN_ID}-open`);
        expect(pushSpy).toHaveBeenCalledWith(`/workflows/runs/${RUN_ID}?serverId=${encodeURIComponent(serverId)}`);
    });

    it('mirrors the same row-level outcome in the timeline chrome', async () => {
        await answerRun('running');
        const screen = await renderTimelineRow();
        await settle();

        expect(screen.findByTestId(`transcript-workflow-run-${RUN_ID}`)).toBeTruthy();
        expect(rowReads()).toHaveLength(1);
    });

    it('stays truthful when the exact read fails: the link remains, no status is invented', async () => {
        home.answer(serverId, STORAGE_ROUTE, { dispatchThenFail: true });
        const screen = await renderCardRow();
        await settle();

        expect(home.requestsFor(STORAGE_ROUTE)).toHaveLength(1);
        expect(screen.findByTestId(`transcript-workflow-run-${RUN_ID}`)).toBeTruthy();
        expect(screen.findByTestId(`transcript-workflow-run-${RUN_ID}-open`)).toBeTruthy();
        expect(screen.findAllHostsByTestId(`transcript-workflow-run-${RUN_ID}-state`)).toHaveLength(0);
        expect(storage.getState().workflowRunsById[workflowRunStoreKey(RUN_ID)]).toBeUndefined();
        // Unknown is not "unavailable": nothing authoritative said the content
        // cannot be read on this device.
        const text = collectHostText(screen.tree);
        expect(text).toContain('workflows.run.untitled');
        expect(text).not.toContain('workflows.contentUnavailable');
    });

    it('never reads or refreshes the active Account store for a row from another Home', async () => {
        const screen = await renderCardRow(startToolCall(), 'home-b');
        await settle();

        expect(home.requestsFor(STORAGE_ROUTE)).toHaveLength(0);
        expect(screen.findAllHostsByTestId(`transcript-workflow-run-${RUN_ID}`)).toHaveLength(0);
    });

    it('mounts nothing when the row cannot name its exact Home', async () => {
        const screen = await renderCardRow(startToolCall(), null);
        await settle();

        expect(home.requestsFor(STORAGE_ROUTE)).toHaveLength(0);
        expect(screen.findAllHostsByTestId(`transcript-workflow-run-${RUN_ID}`)).toHaveLength(0);
    });

    it('discards an exact read that completes after the Account lifetime retired', async () => {
        const deferred = createDeferred<void>();
        home.answer(serverId, STORAGE_ROUTE, { body: await getResult('running'), respondAfter: deferred.promise });
        await renderCardRow();
        await settle();
        await waitForHomeGovernance(() => expect(home.requestsFor(STORAGE_ROUTE)).toHaveLength(1));

        await act(async () => {
            storage.getState().activateProfileScope({ serverId, accountId: 'account-b' });
            deferred.resolve();
            await deferred.promise;
            await flushHookEffects({ cycles: 40 });
        });
        expect(storage.getState().workflowRunsById[workflowRunStoreKey(RUN_ID, { serverId, accountId: ACCOUNT_ID })]).toBeUndefined();
        expect(storage.getState().workflowRunsById[workflowRunStoreKey(RUN_ID)]).toBeUndefined();
    });

    it('mounts nothing for a failed start, a read Action or an unrelated tool', async () => {
        const failed = await renderCardRow(startToolCall({
            result: JSON.stringify({ ok: false, errorCode: 'feature_disabled', error: 'off' }),
        }));
        await settle();
        expect(failed.findAllHostsByTestId(`transcript-workflow-run-${RUN_ID}`)).toHaveLength(0);

        standardCleanup();
        const read = await renderCardRow(makeToolCall({
            name: 'mcp__happier__workflow_run_get',
            state: 'completed',
            input: { runId: RUN_ID },
            result: JSON.stringify(await getResult('running')),
        }));
        await settle();
        expect(read.findAllHostsByTestId(`transcript-workflow-run-${RUN_ID}`)).toHaveLength(0);

        standardCleanup();
        const unrelated = await renderCardRow(makeToolCall({ name: 'Read', input: { file_path: '/a' }, result: 'ok' }));
        await settle();
        expect(unrelated.findAllHostsByTestId(`transcript-workflow-run-${RUN_ID}`)).toHaveLength(0);
        expect(home.requestsFor(STORAGE_ROUTE)).toHaveLength(0);
    });
});
