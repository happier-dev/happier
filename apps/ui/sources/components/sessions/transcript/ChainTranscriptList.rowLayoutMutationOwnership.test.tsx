import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { collectHostText, createDeferred, flushHookEffects, makeSessionWorkflowActivityMetadata, makeSessionWorkflowRunHeadline, makeSessionWorkflowRunSnapshot, pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';
import { createTestSessionTranscriptSource, wrapWithSessionTranscriptSource } from '@/dev/testkit/sessionTranscriptSource';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createSessionSystemRecordHttpFixture } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { buildWorkflowRunSystemRecordLocalId} from '@happier-dev/protocol/sessions/system/records/activity/activitySystemRecordKinds';
import { projectSessionAccessCapabilitiesV1} from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { SessionSystemRecordStoredSchema, type SessionSystemRecordStored } from '@happier-dev/protocol/sessions/system/records/sessionSystemRecordRoutes';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const hostState = vi.hoisted(() => ({
    legendList: null as any,
    legendGeometry: {
        current: {} as Record<string, unknown>,
    },
    messageViewProps: [] as Array<Record<string, any>>,
    motionConfigs: [] as Array<Record<string, any> | null>,
    nowMs: 1_000,
    workflowMetadata: null as ReturnType<typeof createSessionFixture>['metadata'],
    workflowServerId: '',
}));

vi.mock('react-native', async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            AccessibilityInfo: {
                isReduceMotionEnabled: async () => true,
                addEventListener: () => ({ remove() {} }),
            },
            Platform: {
                OS: 'ios',
                select: <T,>(options: { ios?: T; native?: T; default?: T; web?: T }) =>
                    options.ios ?? options.native ?? options.default ?? options.web,
            },
        });
});
vi.mock('react-native-unistyles', async () =>
    (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () =>
    (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }));
vi.mock('@/modal', async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

vi.mock('@legendapp/list/react-native', async (importOriginal) => {
    const original = await importOriginal<typeof import('@legendapp/list/react-native')>();
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    const legendList = createCapturingLegendListMock({
        original,
        resolveState: () => hostState.legendGeometry.current,
    });
    hostState.legendList = legendList.state;
    return legendList.module;
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/sessions/transcript/MessageView', async () => {
    const { useTranscriptMotion } = await import('./motion/TranscriptMotionContext');
    const { WorkflowActivityView } = await import('@/components/tools/renderers/workflow/WorkflowActivityView');
    const { WorkflowAgentRow } = await import('@/components/workflows/presentation/WorkflowAgentRow');
    return {
        MessageViewWithSessionCommon: (props: Record<string, any>) => {
            hostState.motionConfigs.push(useTranscriptMotion()?.config ?? null);
            hostState.messageViewProps.push(props);
            if (props.message?.id === 'workflow-agent') {
                return (
                    <WorkflowAgentRow
                        title="Nested worker"
                        status="complete"
                        summary="Nested workflow detail"
                        testID="nested-workflow-agent"
                    />
                );
            }
            if (props.message?.id === 'workflow-hydration') {
                return (
                    <WorkflowActivityView
                        tool={{
                            id: 'workflow-tool',
                            name: 'Workflow',
                            state: 'running',
                            input: { name: 'Hydrating workflow' },
                            result: null,
                            createdAt: 1,
                            startedAt: null,
                            completedAt: null,
                        } as any}
                        metadata={hostState.workflowMetadata}
                        messages={[]}
                        sessionId="s1"
                        serverId={hostState.workflowServerId}
                        detailLevel="summary"
                    />
                );
            }
            return React.createElement('MessageViewWithSessionCommon', props);
        },
    };
});

function transcriptMessages(mutationMessageId: 'workflow-agent' | 'workflow-hydration') {
    return ['before', mutationMessageId, 'visible-anchor', 'after-1', 'after-2'].map((id, index) => ({
        kind: 'agent-text' as const,
        id,
        localId: null,
        createdAt: index + 1,
        text: id,
    }));
}

function setDetachedNativeGeometry(positions: readonly number[], contentLength: number): void {
    hostState.legendGeometry.current = {
        contentLength,
        end: 4,
        isAtEnd: false,
        isNearEnd: false,
        isWithinMaintainScrollAtEndThreshold: false,
        positionAtIndex: (index: number) => positions[index],
        scroll: 500,
        scrollLength: 600,
        sizeAtIndex: () => 240,
        start: 1,
        startBuffered: 1,
        endBuffered: 4,
    };
}

function installAnimationFrameQueue(): FrameRequestCallback[] {
    const callbacks: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
        callbacks.push(callback);
        return callbacks.length;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    return callbacks;
}

function installNativeOffsetCommit(): void {
    hostState.legendList.refHandle.scrollToOffset.mockImplementation(
        ({ offset }: Readonly<{ offset: number }>) => {
            hostState.legendGeometry.current = {
                ...hostState.legendGeometry.current,
                scroll: offset,
            };
            return Promise.resolve();
        },
    );
}

function readAnchorViewportTop(positions: readonly number[]): number {
    return positions[2] - Number(hostState.legendGeometry.current.scroll);
}


function createChainTestRoot(Content: typeof import('./ChainTranscriptList')['ChainTranscriptList']) {
    return function ChainTestRoot(props: React.ComponentProps<typeof Content>) {
        const [source] = React.useState(() => createTestSessionTranscriptSource({
            sessionId: props.sessionId, serverId: props.serverId, messages: props.messages,
            metadata: props.metadata, interaction: props.interaction,
            loadSidechain: async () => 'not_ready',
            history: { loadOlder: props.loadOlder ?? (async () => ({ loaded: 0, hasMore: false, status: 'not_ready' })) },
        }));
        return wrapWithSessionTranscriptSource(React.createElement(Content, props), source);
    };
}

const { installDisconnectedServerSocketBoundary } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
installDisconnectedServerSocketBoundary();
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { getStorage } = await import('@/sync/domains/state/storageStore');
const initialSettings = getStorage().getState().settings;
const records: SessionSystemRecordStored[] = [];
const recordHttp = createSessionSystemRecordHttpFixture({ sessionId: 's1', records,
    effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
        capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) },
});
let recordGate: ReturnType<typeof createDeferred<void>> | undefined;
const recordRequests: string[] = [];
const runtime = installSessionPaneRuntimeTestHarness({
    features: () => {
        const features = createRootLayoutFeaturesResponse();
        return { ...features, capabilities: { ...features.capabilities,
            session: { ...features.capabilities.session, systemRecords: { protocolVersions: [1] } },
        } };
    },
    request: async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (!path.endsWith('/system-records/record')) return null;
        recordRequests.push(path);
        await recordGate?.promise;
        return recordHttp.request(url, init);
    },
});
// Cold module loading is fixture setup, before the test clock and queued animation frames.
const { ChainTranscriptList: ChainContent } = await import('./ChainTranscriptList');

describe('ChainTranscriptList row-layout mutation ownership', () => {
    beforeEach(() => {
        getStorage().setState({ settings: {
            ...initialSettings,
            transcriptGroupingMode: 'linear',
            transcriptGroupToolCalls: false,
        } });
        records.length = 0;
        recordHttp.recordReads.length = 0;
        recordRequests.length = 0;
        recordGate = undefined;
        hostState.workflowMetadata = null;
        hostState.workflowServerId = runtime.serverId;
    });
    afterEach(() => {
        hostState.legendList?.reset();
        hostState.legendList?.refHandle.scrollToOffset.mockReset();
        hostState.legendGeometry.current = {};
        hostState.messageViewProps.length = 0;
        hostState.motionConfigs.length = 0;
        hostState.nowMs = 1_000;
        recordGate?.resolve();
        recordGate = undefined;
        hostState.workflowMetadata = null;
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        standardCleanup();
        getStorage().setState({ settings: initialSettings });
    });

    it('keeps the real Legend visible anchor stable across a nested workflow-row expansion', async () => {
        vi.spyOn(Date, 'now').mockImplementation(() => hostState.nowMs);
        const animationFrames = installAnimationFrameQueue();
        let positions = [0, 240, 480, 720, 960];
        setDetachedNativeGeometry(positions, 1_200);
        const ChainTranscriptList = createChainTestRoot(ChainContent);
        const screen = await renderScreen(
            <ChainTranscriptList
                sessionId="s1"
                serverId={runtime.serverId}
                datasetKey={JSON.stringify(['s1', 'sidechain-a'])}
                messages={transcriptMessages('workflow-agent')}
                metadata={null}
                interaction={{ canSendMessages: true, canApprovePermissions: true }}
            />,
        );
        installNativeOffsetCommit();
        expect(hostState.legendList.props.data).toHaveLength(positions.length);
        const anchorViewportTop = readAnchorViewportTop(positions);
        expect(typeof hostState.legendList.props.onScrollBeginDrag).toBe('function');
        expect(typeof hostState.legendList.props.onScrollEndDrag).toBe('function');
        act(() => {
            hostState.legendList.props.onScrollBeginDrag({
                nativeEvent: { contentOffset: { x: 0, y: 500 } },
            });
            hostState.legendList.props.onScrollEndDrag({
                nativeEvent: { contentOffset: { x: 0, y: 500 } },
            });
        });
        hostState.nowMs = 5_000;
        hostState.legendList.refHandle.scrollToOffset.mockClear();

        const nestedAgent = screen.findAllByProps({ testID: 'nested-workflow-agent' })
            .find((node) => typeof node.props.onPress === 'function');
        await pressTestInstanceAsync(nestedAgent, 'nested workflow agent');

        positions = [0, 240, 2_480, 2_720, 2_960];
        setDetachedNativeGeometry(positions, 3_200);
        hostState.nowMs = 5_400;
        await act(async () => {
            hostState.legendList.props.onItemSizeChanged({ index: 1, previous: 240, size: 2_240 });
            animationFrames.splice(0, animationFrames.length).forEach((callback) => callback(hostState.nowMs));
        });

        expect(hostState.legendList.refHandle.scrollToOffset).toHaveBeenCalledTimes(1);
        expect(readAnchorViewportTop(positions)).toBe(anchorViewportTop);
    });

    it('keeps the real Legend visible anchor stable when a workflow shell hydrates into records', async () => {
        vi.spyOn(Date, 'now').mockImplementation(() => hostState.nowMs);
        const animationFrames = installAnimationFrameQueue();
        let positions = [0, 240, 480, 720, 960];
        setDetachedNativeGeometry(positions, 1_200);
        recordGate = createDeferred<void>();
        hostState.workflowMetadata = createSessionFixture().metadata;
        hostState.workflowMetadata = {
            ...hostState.workflowMetadata!,
            ...makeSessionWorkflowActivityMetadata([
                makeSessionWorkflowRunHeadline({ runId: 'workflow-run', workflowToolUseId: 'workflow-tool' }),
            ]),
        };
        const ChainTranscriptList = createChainTestRoot(ChainContent);
        const renderTranscript = () => (
            <ChainTranscriptList
                sessionId="s1"
                serverId={runtime.serverId}
                datasetKey={JSON.stringify(['s1', 'sidechain-a'])}
                messages={transcriptMessages('workflow-hydration')}
                metadata={null}
                interaction={{ canSendMessages: true, canApprovePermissions: true }}
            />
        );
        const screen = await renderScreen(renderTranscript());
        await vi.waitFor(() => expect(recordRequests).toEqual(['/v2/sessions/s1/system-records/record']));
        installNativeOffsetCommit();
        expect(hostState.legendList.props.data).toHaveLength(positions.length);
        const anchorViewportTop = readAnchorViewportTop(positions);
        expect(typeof hostState.legendList.props.onScrollBeginDrag).toBe('function');
        expect(typeof hostState.legendList.props.onScrollEndDrag).toBe('function');
        act(() => {
            hostState.legendList.props.onScrollBeginDrag({
                nativeEvent: { contentOffset: { x: 0, y: 500 } },
            });
            hostState.legendList.props.onScrollEndDrag({
                nativeEvent: { contentOffset: { x: 0, y: 500 } },
            });
        });
        hostState.nowMs = 5_000;
        hostState.legendList.refHandle.scrollToOffset.mockClear();

        await act(async () => {
            const snapshot = makeSessionWorkflowRunSnapshot({
                runId: 'workflow-run', title: 'Hydrated workflow', workflowToolUseId: 'workflow-tool',
                totalAgents: 1, completedAgents: 0, phases: [],
                agents: [{ id: 'agent-1', title: 'Hydrated worker', status: 'active', updatedAt: 2 }],
            });
            records.push(SessionSystemRecordStoredSchema.parse({
                id: 'sysrec_1',
                address: { owner: 'host', namespace: 'activity', kind: 'workflow_run.v1',
                    localId: buildWorkflowRunSystemRecordLocalId({ runId: snapshot.runId }) },
                revision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ',
                content: { t: 'plain', v: snapshot },
                createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z',
            }));
            recordGate?.resolve();
            await flushHookEffects({ cycles: 40 });
        });
        expect(collectHostText(screen.tree)).toContain('Hydrated workflow');
        expect(recordHttp.recordReads).toEqual([buildWorkflowRunSystemRecordLocalId({ runId: 'workflow-run' })]);

        positions = [0, 240, 2_480, 2_720, 2_960];
        setDetachedNativeGeometry(positions, 3_200);
        hostState.nowMs = 5_400;
        await act(async () => {
            hostState.legendList.props.onItemSizeChanged({ index: 1, previous: 240, size: 2_240 });
            animationFrames.splice(0, animationFrames.length).forEach((callback) => callback(hostState.nowMs));
        });

        expect(hostState.legendList.refHandle.scrollToOffset).toHaveBeenCalledTimes(1);
        expect(readAnchorViewportTop(positions)).toBe(anchorViewportTop);
    });

    it('installs the effective reduced-motion config for the sidechain transcript surface', async () => {
        const ChainTranscriptList = createChainTestRoot(ChainContent);
        await renderScreen(
            <ChainTranscriptList
                sessionId="s1"
                serverId={runtime.serverId}
                datasetKey={JSON.stringify(['s1', 'sidechain-a'])}
                messages={[{
                    kind: 'agent-text',
                    id: 'assistant-1',
                    localId: null,
                    createdAt: 1,
                    text: 'Hello',
                }]}
                metadata={null}
                interaction={{ canSendMessages: true, canApprovePermissions: true }}
            />,
        );

        expect(hostState.motionConfigs).toContainEqual(expect.objectContaining({
            preset: 'off',
            animateNewItemsEnabled: false,
        }));
    });
});
