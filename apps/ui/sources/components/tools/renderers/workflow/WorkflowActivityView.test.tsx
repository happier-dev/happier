import React from 'react';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

import {
    collectHostText,
    createPlainAccountEncryptionCurrentnessFixture,
    createDeferred,
    createSessionFixture,
    flushHookEffects,
    makeSessionWorkflowActivityMetadata,
    makeSessionWorkflowRunHeadline,
    makeSessionWorkflowRunSnapshot,
    makeToolCall,
    makeToolViewProps,
    pressTestInstanceAsync,
    renderScreen,
} from '@/dev/testkit';
import {
    buildWorkflowRunSystemRecordLocalId} from '@happier-dev/protocol/sessions/system/records/activity/activitySystemRecordKinds';
import {
    FeaturesResponseSchema} from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import {
    projectSessionAccessCapabilitiesV1} from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import {
    SessionSystemRecordStoredSchema,
    type SessionSystemRecordStored} from '@happier-dev/protocol/sessions/system/records/sessionSystemRecordRoutes';
import {
    type SessionWorkflowRunSnapshotV1,
} from '@happier-dev/protocol/sessions/work/workflow/sessionWorkflowRunSnapshotV1';

import {
    createSessionSystemRecordHttpFixture,
    installDisconnectedServerSocketBoundary,
    restoreServerAccountForTest,
} from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { TranscriptFindProvider } from '@/components/sessions/transcript/find/TranscriptFindContext';
import { createTranscriptFindRowStore } from '@/components/sessions/transcript/find/transcriptFindRowStore';

// Native hosts, translation, navigation and network are the substituted boundaries.
// The app Text, workflow hook, Sync, record repository and codec remain real.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string, params?: Record<string, unknown>) => {
            const last = key.split('.').pop() ?? key;
            if (params && Object.keys(params).length > 0) {
                return `${last}:${Object.values(params).join(',')}`;
            }
            return last;
        },
    });
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

const records: SessionSystemRecordStored[] = [];
const http = createSessionSystemRecordHttpFixture({ sessionId: 'sess_1', records,
    effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) },
});
let recordGate: ReturnType<typeof createDeferred<void>> | undefined;
let workflowMetadata = makeSessionWorkflowActivityMetadata([]);
let currentSnapshot: SessionWorkflowRunSnapshotV1 | undefined;
let account: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
const recordRequests: URL[] = [];
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();

beforeEach(async () => {
    records.length = 0;
    http.recordReads.length = 0;
    recordRequests.length = 0;
    recordGate = undefined;
    workflowMetadata = makeSessionWorkflowActivityMetadata([]);
    currentSnapshot = undefined;
    account = await restoreServerAccountForTest({
        serverUrl: 'https://workflow.example',
        request: async (url, init) => {
            const parsed = new URL(String(url));
            if (parsed.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (parsed.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (parsed.pathname === '/v2/account/settings') return Response.json({ content: null, version: 0 });
            if (parsed.pathname === '/v1/features' || parsed.pathname === '/v1/features/authenticated') return Response.json(FeaturesResponseSchema.parse({
                features: { sessions: { enabled: true } },
                capabilities: { session: { systemRecords: { protocolVersions: [1] } } },
            }));
            if (parsed.pathname.endsWith('/system-records/record')) {
                recordRequests.push(parsed);
                await recordGate?.promise;
            }
            return http.request(url, init);
        },
    });
});
afterEach(async () => {
    recordGate?.resolve();
    await account?.dispose();
    account = undefined;
});

function setWorkflowRecord(run: SessionWorkflowRunSnapshotV1 | { state: 'loading' | 'missing'; runId: string }) {
    currentSnapshot = 'v' in run ? run : undefined;
    records.length = 0;
    workflowMetadata = makeSessionWorkflowActivityMetadata([
        makeSessionWorkflowRunHeadline({ runId: run.runId, workflowToolUseId: 'workflow-tool' }),
    ]);
    recordGate ??= createDeferred<void>();
    if (currentSnapshot) records.push(SessionSystemRecordStoredSchema.parse({
        id: 'sysrec_1',
        address: { owner: 'host', namespace: 'activity', kind: 'workflow_run.v1', localId: buildWorkflowRunSystemRecordLocalId({ runId: run.runId }) },
        revision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ',
        content: { t: 'plain', v: currentSnapshot },
        createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z',
    }));
}

function workflowProps(tool: Parameters<typeof makeToolViewProps>[0], overrides: Parameters<typeof makeToolViewProps>[1] = {}) {
    const metadata = createSessionFixture().metadata;
    if (!metadata) throw new Error('The canonical Session fixture must provide readable metadata');
    return makeToolViewProps({ ...tool, id: 'workflow-tool' }, {
        ...overrides, sessionId: 'sess_1', serverId: account!.home.id, metadata: { ...metadata, ...workflowMetadata },
    });
}

async function waitForRecord(tree: renderer.ReactTestRenderer) {
    if (!currentSnapshot) return;
    const title = currentSnapshot!.title;
    await releaseRecordResponse();
    expect(collectHostText(tree)).toContain(title);
    expect(collectHostText(tree)).not.toContain('loading');
    expect(collectHostText(tree)).not.toContain('unavailable');
}

async function releaseRecordResponse() {
    await vi.waitFor(() => expect(recordRequests).toHaveLength(1));
    await act(async () => {
        recordGate?.resolve();
        recordGate = undefined;
        await flushHookEffects({ cycles: 40 });
    });
}

function snapshot(over: Partial<SessionWorkflowRunSnapshotV1>): SessionWorkflowRunSnapshotV1 {
    return makeSessionWorkflowRunSnapshot({ runId: 'wf_1', title: 'Implement', ...over });
}

function largeSnapshot(count: number): SessionWorkflowRunSnapshotV1 {
    return snapshot({
        runId: 'wf_large',
        title: 'Large workflow',
        status: 'active',
        totalAgents: count,
        completedAgents: 8,
        phases: [{ id: 'phase-1', title: 'Implementation', order: 1, agentIds: Array.from({ length: count }, (_, index) => `agent-${index}`) }],
        agents: Array.from({ length: count }, (_, index) => ({
            id: `agent-${index}`,
            title: `Agent ${index}`,
            status: index < 8 ? 'complete' : index === 8 ? 'active' : 'pending',
            updatedAt: index,
            resultPreview: `Result ${index}`,
        })),
    });
}

// Load the real owner after boundary setup so cold module evaluation is outside a test and its act lifetime.
const { WorkflowActivityView, projectWorkflowActivityDisplayText } = await import('./WorkflowActivityView');

describe('WorkflowActivityView', () => {
    async function renderCard(): Promise<renderer.ReactTestRenderer> {
        const tool = makeToolCall({ name: 'Workflow', state: 'running', input: { name: 'Build feature' } });
        const props = workflowProps(tool);
        const tree = (await renderScreen(React.createElement(WorkflowActivityView, props))).tree;
        await waitForRecord(tree);
        return tree;
    }

    it('projects the decoded workflow body and reveals a late agent with unclamped normalized detail', async () => {
        const run = largeSnapshot(20);
        const summary = 'line\n'.repeat(10) + 'x'.repeat(2200) + 'needle';
        run.agents[19] = { ...run.agents[19], summary };
        const tool = makeToolCall({ name: 'Workflow', input: { name: 'Shell', hidden: 'private needle' } });
        const blocks = projectWorkflowActivityDisplayText(tool, null, { workflowRun: run });
        const detail = blocks.find((block) => block.id === 'tool-workflow-agent-agent-19-detail');
        expect(detail?.text).toBe(summary.trim());
        expect(blocks.some((block) => block.text.includes('private'))).toBe(false);
        setWorkflowRecord(run);
        const store = createTranscriptFindRowStore();
        const start = summary.trim().indexOf('needle');
        store.publish(new Map([['m1', { blocks: [{ id: detail!.id, sourceRanges: [{ start, end: start + 6, current: true }] }] }]]));
        const { tree } = await renderScreen(<TranscriptFindProvider store={store}>
            <WorkflowActivityView {...workflowProps(tool, { messageId: 'm1' })} />
        </TranscriptFindProvider>);
        await waitForRecord(tree);
        expect(collectHostText(tree)).toContain('Agent 19');
        expect(tree.findByTestId('find-match-current')?.props.children).toBe('needle');
    });

    it('passes the transcript owner\'s exact Home to the workflow record observation', async () => {
        setWorkflowRecord({ state: 'loading', runId: 'wf_1' });
        await renderCard();
        await vi.waitFor(() => expect(recordRequests).toHaveLength(1));
        expect(recordRequests[0].origin).toBe('https://workflow.example');
        expect(recordRequests[0].pathname).toBe('/v2/sessions/sess_1/system-records/record');
        expect(recordRequests[0].searchParams.get('owner')).toBe('host');
        expect(recordRequests[0].searchParams.get('localId')).toBe('activity:workflow_run:v1:wf_1');
    });

    it('renders a minimal shell while detail is loading', async () => {
        setWorkflowRecord({ state: 'loading', runId: 'wf_1' });
        const tree = await renderCard();
        expect(collectHostText(tree)).toContain('loading');
    });

    it('renders an unavailable shell when the record is missing', async () => {
        setWorkflowRecord({ state: 'missing', runId: 'wf_1' });
        const tree = await renderCard();
        await releaseRecordResponse();
        expect(collectHostText(tree)).toContain('unavailable');
    });

    it('renders a loaded workflow with phases in order', async () => {
        setWorkflowRecord(snapshot({
            title: 'Build feature',
            status: 'active',
            totalAgents: 3,
            completedAgents: 1,
            tokensUsed: 38000,
            timeUsedSeconds: 134,
            phases: [
                { id: 'p3', title: 'Review', order: 3, agentIds: ['a3'] },
                { id: 'p1', title: 'Research', order: 1, agentIds: ['a1'] },
                { id: 'p2', title: 'Implementation', order: 2, agentIds: ['a2'] },
            ],
            agents: [
                { id: 'a1', title: 'web_search', status: 'complete', updatedAt: 1 },
                { id: 'a2', title: 'editor', status: 'active', updatedAt: 1 },
                { id: 'a3', title: 'reviewer', status: 'pending', updatedAt: 1 },
            ],
        }));
        const tree = await renderCard();
        const text = collectHostText(tree);
        expect(text).toContain('Build feature');
        expect(text).toContain('Research');
        expect(text).toContain('Implementation');
        expect(text).toContain('Review');
        expect(text.indexOf('Research')).toBeLessThan(text.indexOf('Implementation'));
        expect(text.indexOf('Implementation')).toBeLessThan(text.indexOf('Review'));
        // Footer metrics: agents count present.
        expect(text.join(' ')).toContain('agentsCount');
    });

    it('renders name + status + token rollup (no empty agent shell) when detail is absent', async () => {
        setWorkflowRecord(snapshot({ title: 'Empty', status: 'complete', totalAgents: 0, tokensUsed: 12000 }));
        const tree = await renderCard();
        const text = collectHostText(tree);
        // Name + status are still surfaced.
        expect(text).toContain('Empty');
        expect(text).toContain('statusComplete');
        // Completion summary (token rollup) is shown.
        expect(text.join(' ')).toContain('tokens');
        // Degrade path must NOT claim "0 agents" — that reads as an empty agent shell.
        expect(text.join(' ')).not.toContain('agentsCount');
    });

    it('labels a crash-reconciled stopped run as interrupted', async () => {
        setWorkflowRecord(snapshot({
            title: 'Interrupted workflow',
            status: 'stopped',
            statusReason: 'interrupted',
            totalAgents: 3,
            completedAgents: 1,
        }));

        const tree = await renderCard();
        const text = collectHostText(tree);
        expect(text).toContain('statusInterrupted');
        expect(text).not.toContain('statusStopped');
    });

    it('keeps a 300-agent transcript card bounded when progressively expanded', async () => {
        setWorkflowRecord(largeSnapshot(300));

        const tree = await renderCard();
        expect(collectHostText(tree)).toContain('Agent 8');
        expect(collectHostText(tree)).not.toContain('Agent 299');

        const showMore = tree.root.findByProps({ testID: 'workflow-card-wf_large-show-more' });
        await pressTestInstanceAsync(showMore, 'workflow card show more');

        const afterPress = collectHostText(tree);
        expect(afterPress).toContain('Agent 20');
        expect(afterPress).not.toContain('Agent 299');

        for (let i = 0; i < 30; i += 1) {
            const currentShowMore = tree.root.findAllByProps({ testID: 'workflow-card-wf_large-show-more' })[0];
            if (!currentShowMore) break;
            await pressTestInstanceAsync(currentShowMore, `workflow card show more ${i}`);
        }

        expect(collectHostText(tree)).toContain('Agent 299');
        expect(tree.root.findAllByProps({ testID: 'workflow-card-wf_large-show-more' })).toHaveLength(0);
    });

    it('announces records hydration before committing the loaded workflow body', async () => {
        let tree: renderer.ReactTestRenderer | undefined;
        const bodyAtMutation: string[][] = [];
        const rowMutation = vi.fn(() => {
            if (tree) bodyAtMutation.push(collectHostText(tree));
        });
        const { TranscriptRowLayoutMutationProvider } = await import(
            '@/components/sessions/transcript/measurement/TranscriptRowLayoutMutationContext'
        );
        const tool = makeToolCall({ id: 'workflow-tool', name: 'Workflow', state: 'running', input: { name: 'Build feature' } });
        setWorkflowRecord({ state: 'loading', runId: 'wf_1' });
        const props = workflowProps(tool);
        const renderWithOwner = () => (
            <TranscriptRowLayoutMutationProvider value={rowMutation}>
                <WorkflowActivityView
                    {...props}
                />
            </TranscriptRowLayoutMutationProvider>
        );
        tree = (await renderScreen(renderWithOwner())).tree;
        rowMutation.mockClear();
        bodyAtMutation.length = 0;

        setWorkflowRecord(snapshot({
            title: 'Hydrated workflow',
            totalAgents: 1,
            agents: [{ id: 'agent-1', title: 'worker', status: 'active', updatedAt: 2 }],
        }));
        await waitForRecord(tree);

        expect(rowMutation).toHaveBeenCalledWith({
            reason: 'content-change',
            sourceId: 'workflow-activity:workflow-tool',
        });
        expect(bodyAtMutation.some((text) => text.includes('loading'))).toBe(true);
        expect(bodyAtMutation.every((text) => !text.includes('Hydrated workflow'))).toBe(true);
        expect(collectHostText(tree)).toContain('Hydrated workflow');
    });

    it('announces show-more growth before appending workflow agent rows', async () => {
        const rowMutation = vi.fn();
        const { TranscriptRowLayoutMutationProvider } = await import(
            '@/components/sessions/transcript/measurement/TranscriptRowLayoutMutationContext'
        );
        setWorkflowRecord(largeSnapshot(30));
        const tool = makeToolCall({ id: 'workflow-tool', name: 'Workflow', state: 'running' });
        const props = workflowProps(tool);
        const tree = (await renderScreen(
            <TranscriptRowLayoutMutationProvider value={rowMutation}>
                <WorkflowActivityView {...props} />
            </TranscriptRowLayoutMutationProvider>,
        )).tree;
        await waitForRecord(tree);
        rowMutation.mockClear();

        const showMore = tree.root.findByProps({ testID: 'workflow-card-wf_large-show-more' });
        await pressTestInstanceAsync(showMore, 'workflow card show more');

        expect(rowMutation).toHaveBeenCalledWith({
            reason: 'content-change',
            sourceId: 'workflow-activity:workflow-tool',
        });
        expect(collectHostText(tree)).toContain('Agent 20');
    });

    it('expands an agent row to show normalized summary detail when available', async () => {
        setWorkflowRecord(snapshot({
            runId: 'wf_1',
            title: 'Investigate',
            totalAgents: 1,
            phases: [],
            agents: [{
                id: 'agent-1',
                title: 'researcher',
                status: 'complete',
                updatedAt: 1,
                resultPreview: 'Short result',
                summary: 'Full normalized result summary with the important findings.',
            }],
        }));

        const tree = await renderCard();
        expect(collectHostText(tree)).toContain('Short result');
        expect(collectHostText(tree).join(' ')).not.toContain('Full normalized result summary');
        expect(tree.findAllHostsByTestId('workflow-card-agent-wf_1-agent-1-detail')).toHaveLength(0);

        const agentRow = tree.root
            .findAllByProps({ testID: 'workflow-card-agent-wf_1-agent-1' })
            .find((node) => typeof node.props.onPress === 'function');
        await pressTestInstanceAsync(agentRow, 'workflow agent row');

        expect(collectHostText(tree).join(' ')).toContain('Full normalized result summary');
        expect(tree.findAllHostsByTestId('workflow-card-agent-wf_1-agent-1-detail')).toHaveLength(1);
    });

    it('announces both the workflow row and nested detail expansions through the transcript owner', async () => {
        const rowMutation = vi.fn();
        const { TranscriptRowLayoutMutationProvider } = await import(
            '@/components/sessions/transcript/measurement/TranscriptRowLayoutMutationContext'
        );
        setWorkflowRecord(snapshot({
            runId: 'wf_1',
            title: 'Investigate',
            totalAgents: 1,
            agents: [{
                id: 'agent-1',
                title: 'researcher',
                status: 'complete',
                updatedAt: 1,
                resultPreview: 'Short result',
                summary: Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n'),
            }],
        }));
        const tool = makeToolCall({ id: 'workflow-tool', name: 'Workflow', state: 'running' });
        const props = workflowProps(tool);
        const tree = (await renderScreen(
            <TranscriptRowLayoutMutationProvider value={rowMutation}>
                <WorkflowActivityView {...props} />
            </TranscriptRowLayoutMutationProvider>,
        )).tree;
        await waitForRecord(tree);
        rowMutation.mockClear();

        const agentRow = tree.root
            .findAllByProps({ testID: 'workflow-card-agent-wf_1-agent-1' })
            .find((node) => typeof node.props.onPress === 'function');
        await pressTestInstanceAsync(agentRow, 'workflow agent row');
        const detailToggle = tree.root.findByProps({
            testID: 'workflow-card-agent-wf_1-agent-1-detail-show-more',
        });
        await pressTestInstanceAsync(detailToggle, 'workflow agent detail');

        expect(rowMutation.mock.calls).toEqual([
            [{
                reason: 'expand',
                sourceId: 'workflow-agent:workflow-card-agent-wf_1-agent-1',
            }],
            [{
                reason: 'expand',
                sourceId: 'workflow-agent-detail:workflow-card-agent-wf_1-agent-1-detail',
            }],
        ]);
    });
});
