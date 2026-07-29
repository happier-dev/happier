import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createUseSettingMock, pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';
import { installTranscriptCommonModuleMocks } from './transcriptTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const hostState = vi.hoisted(() => ({
    legendList: null as any,
    legendGeometry: {
        current: {} as Record<string, unknown>,
    },
    messageViewProps: [] as Array<Record<string, any>>,
    motionConfigs: [] as Array<Record<string, any> | null>,
    nowMs: 1_000,
    workflowDetail: null as any,
    workflowListeners: new Set<() => void>(),
}));

installTranscriptCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'ios',
                select: <T,>(options: { ios?: T; native?: T; default?: T; web?: T }) =>
                    options.ios ?? options.native ?? options.default ?? options.web,
            },
        });
    },
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSetting: createUseSettingMock({ fallback: () => undefined }),
            },
        });
    },
});

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => true,
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        getSyncTuning: () => ({
            transcriptBackwardPrefetchThresholdPx: 800,
            transcriptEstimatedItemSizePx: 120,
            transcriptOlderLoadCooldownMs: 2500,
            transcriptOlderLoadSpinnerDelayMs: 0,
        }),
    },
}));

vi.mock('@legendapp/list/react-native', async () => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    const legendList = createCapturingLegendListMock({
        resolveState: () => hostState.legendGeometry.current,
    });
    hostState.legendList = legendList.state;
    return legendList.module;
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/sessions/workState/useSessionWorkflowActivity', async () => {
    const ReactModule = await import('react');
    return {
        useWorkflowRunForToolUseId: () => {
            const detail = ReactModule.useSyncExternalStore(
                (listener) => {
                    hostState.workflowListeners.add(listener);
                    return () => hostState.workflowListeners.delete(listener);
                },
                () => hostState.workflowDetail,
                () => hostState.workflowDetail,
            );
            return { runHeadline: null, detail };
        },
    };
});

vi.mock('@/components/sessions/transcript/MessageView', async () => {
    const { useTranscriptMotion } = await import('./motion/TranscriptMotionContext');
    const { WorkflowActivityView } = await import('@/components/tools/renderers/workflow/WorkflowActivityView');
    const { WorkflowAgentRow } = await import('@/components/tools/renderers/workflow/WorkflowAgentRow');
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
                        metadata={null}
                        messages={[]}
                        sessionId="s1"
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

describe('ChainTranscriptList row-layout mutation ownership', () => {
    afterEach(() => {
        hostState.legendList?.reset();
        hostState.legendList?.refHandle.scrollToOffset.mockReset();
        hostState.legendGeometry.current = {};
        hostState.messageViewProps.length = 0;
        hostState.motionConfigs.length = 0;
        hostState.nowMs = 1_000;
        hostState.workflowDetail = null;
        hostState.workflowListeners.clear();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        standardCleanup();
    });

    it('keeps the real Legend visible anchor stable across a nested workflow-row expansion', async () => {
        vi.spyOn(Date, 'now').mockImplementation(() => hostState.nowMs);
        const animationFrames = installAnimationFrameQueue();
        let positions = [0, 240, 480, 720, 960];
        setDetachedNativeGeometry(positions, 1_200);
        const { ChainTranscriptList } = await import('./ChainTranscriptList');
        const screen = await renderScreen(
            <ChainTranscriptList
                sessionId="s1"
                datasetKey={JSON.stringify(['s1', 'sidechain-a'])}
                messages={transcriptMessages('workflow-agent')}
                metadata={null}
                interaction={{ canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true }}
            />,
        );
        installNativeOffsetCommit();
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
        hostState.workflowDetail = { state: 'loading', runId: 'workflow-run' };
        const { ChainTranscriptList } = await import('./ChainTranscriptList');
        const renderTranscript = () => (
            <ChainTranscriptList
                sessionId="s1"
                datasetKey={JSON.stringify(['s1', 'sidechain-a'])}
                messages={transcriptMessages('workflow-hydration')}
                metadata={null}
                interaction={{ canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true }}
            />
        );
        await renderScreen(renderTranscript());
        installNativeOffsetCommit();
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
            hostState.workflowDetail = {
                state: 'loaded',
                runId: 'workflow-run',
                snapshot: {
                    runId: 'workflow-run',
                    title: 'Hydrated workflow',
                    status: 'active',
                    totalAgents: 1,
                    completedAgents: 0,
                    phases: [],
                    agents: [{
                        id: 'agent-1',
                        title: 'Hydrated worker',
                        status: 'active',
                        updatedAt: 2,
                    }],
                },
            };
            for (const listener of hostState.workflowListeners) listener();
        });

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
        const { ChainTranscriptList } = await import('./ChainTranscriptList');
        await renderScreen(
            <ChainTranscriptList
                sessionId="s1"
                datasetKey={JSON.stringify(['s1', 'sidechain-a'])}
                messages={[{
                    kind: 'agent-text',
                    id: 'assistant-1',
                    localId: null,
                    createdAt: 1,
                    text: 'Hello',
                }]}
                metadata={null}
                interaction={{ canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true }}
            />,
        );

        expect(hostState.motionConfigs).toContainEqual(expect.objectContaining({
            preset: 'off',
            animateNewItemsEnabled: false,
        }));
    });
});
