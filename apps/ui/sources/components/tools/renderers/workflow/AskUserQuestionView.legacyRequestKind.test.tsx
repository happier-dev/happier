import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ToolCall } from "@happier-dev/session-core/messages";
import { makeToolCall, makeToolViewProps, standardCleanup, createSessionFixture } from '@/dev/testkit';
import { createTestSessionTranscriptSource, pressTestInstanceAsync, renderWithSessionTranscriptSource, renderScreen, wrapWithSessionTranscriptSource } from '@/dev/testkit';
import { setPendingNavigationLanding } from '@/activity/source/pendingNavigationRuntime';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { PendingNavigationSettledNotice } from '@/components/sessions/pendingNavigation/PendingNavigationSettledNotice';
import { installWorkflowRendererCommonModuleMocks } from './workflowRendererTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sessionAllowWithAnswers = vi.fn();
const focusPlatform = vi.hoisted(() => ({ platform: 'web' as 'web' | 'ios' }));

function PaneWrapper(props: Readonly<{ children?: React.ReactNode }>) {
    return <AppPaneProvider>{props.children}</AppPaneProvider>;
}

function hasHostTestId(element: React.ReactElement, testID: string): boolean {
    if (React.isValidElement<{ testID?: string }>(element)) return element.props.testID === testID;
    // react-test-renderer may pass a plain native host descriptor to createNodeMock.
    const props: unknown = element.props;
    return props !== null && typeof props === 'object' && 'testID' in props && props.testID === testID;
}

installWorkflowRendererCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock(
            {
                Platform: {
                    get OS() { return focusPlatform.platform; },
                    select: <T,>(values: { web?: T; ios?: T; native?: T; default?: T }) =>
                        values[focusPlatform.platform] ?? values.native ?? values.default,
                },
                findNodeHandle: () => 31,
                AccessibilityInfo: { setAccessibilityFocus: vi.fn() },
                View: (props: any) => React.createElement('View', props, props.children),
                Text: (props: any) => React.createElement('Text', props, props.children),
                TouchableOpacity: (props: any) => React.createElement('TouchableOpacity', props, props.children),
                TextInput: (props: any) => React.createElement('TextInput', props, null),
                ActivityIndicator: (props: any) => React.createElement('ActivityIndicator', props, null),
            }
        );
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            storage: {
                getState: () => ({
                    sessions: {
                        s1: {
                            agentState: {
                                requests: {
                                    toolu_1: {
                                        tool: 'AskUserQuestion',
                                        arguments: {},
                                        createdAt: 1,
                                    },
                                },
                            },
                        },
                    },
                }),
            },
        });
    },
});

// Exercise the real app presentation adapters; only their native hosts are test boundaries.
vi.doUnmock('@/components/ui/text/Text');
vi.doUnmock('../../shell/presentation/ToolSectionView');

// Warm the real owners at collection only after their platform boundary has been installed.
const { AskUserQuestionView } = await import('./AskUserQuestionView');
const { ExitPlanToolView } = await import('./ExitPlanToolView');
const { ToolView } = await import('../../shell/views/ToolView');
const { ToolTimelineRow } = await import('../../shell/views/ToolTimelineRow');

describe('AskUserQuestionView legacy request-kind fallback', () => {
    beforeEach(() => { focusPlatform.platform = 'web'; });
    afterEach(standardCleanup);

    it.each(['card', 'timeline'] as const)('reveals the %s transcript permission answer even when prompts normally live by the composer', async (rowStyle) => {
        const focus = vi.fn();
        const respondToPermission = vi.fn();
        setPendingNavigationLanding({ serverId: 'home-a', sessionId: 's1' }, 'read-1', 'pending', 'transcript');
        const Row = rowStyle === 'card' ? ToolView : ToolTimelineRow;
        const tool = makeToolCall({ name: 'Read', state: 'running', input: { file_path: 'file.ts' },
            permission: { id: 'read-1', status: 'pending' } });
        const metadata = { ...createSessionFixture().metadata!, flavor: 'claude' };
        const source = createTestSessionTranscriptSource({ sessionId: 's1', serverId: 'home-a',
            metadata,
            interaction: { canSendMessages: true, canApprovePermissions: true },
            actions: { respondToPermission, answerUserAction: async () => {}, abort: async () => {}, submitMessage: async () => {} },
        });
        const screen = await renderScreen(wrapWithSessionTranscriptSource(
            <Row tool={tool} metadata={metadata} sessionId="s1" messageId="message-1"
                displaySettings={{
                    toolViewDetailLevelDefault: 'title',
                    toolViewDetailLevelDefaultLocalControl: settingsDefaults.toolViewDetailLevelDefaultLocalControl,
                    toolViewDetailLevelByToolName: {},
                    toolViewExpandedDetailLevelDefault: 'summary',
                    toolViewExpandedDetailLevelByToolName: {},
                    toolViewTapAction: 'expand',
                    permissionPromptSurface: 'composer',
                    toolViewTimelineFeedDefaultExpanded: false,
                }} />, source,
        ), { wrapper: PaneWrapper, createNodeMock: (element) => hasHostTestId(element, 'permission-footer.allow') ? { focus } : null });
        expect(screen.findHostByTestId('permission-footer.allow')).toBeTruthy();
        expect(focus).toHaveBeenCalledOnce();
        expect(respondToPermission).not.toHaveBeenCalled();
    });

    it.each(['card', 'timeline'] as const)('reveals a collapsed %s transcript question without focusing the composer copy', async (rowStyle) => {
        const promptFocus = vi.fn();
        const transcriptFocus = vi.fn();
        const answerUserAction = vi.fn();
        setPendingNavigationLanding({ serverId: 'home-a', sessionId: 's1' }, 'question-1', 'pending', 'transcript');
        const Row = rowStyle === 'card' ? ToolView : ToolTimelineRow;
        const tool = makeToolCall({ name: 'AskUserQuestion', state: 'running',
            input: { questions: [{ id: 'answer', question: 'Describe it', selection: 'text', required: true }] },
            permission: { id: 'question-1', status: 'pending' },
        });
        const source = createTestSessionTranscriptSource({ sessionId: 's1', serverId: 'home-a',
            interaction: { canSendMessages: true, canApprovePermissions: true },
            agentState: { requests: { 'question-1': { tool: 'AskUserQuestion', arguments: {}, createdAt: 1 } } },
            actions: { answerUserAction, respondToPermission: async () => {}, abort: async () => {}, submitMessage: async () => {} },
        });
        let answerControlIndex = 0;
        const screen = await renderScreen(wrapWithSessionTranscriptSource(<>
            <AskUserQuestionView {...makeToolViewProps(tool, { sessionId: 's1' })} />
            <Row tool={tool} metadata={null} sessionId="s1" messageId="message-1"
                displaySettings={{
                    toolViewDetailLevelDefault: 'title',
                    toolViewDetailLevelDefaultLocalControl: settingsDefaults.toolViewDetailLevelDefaultLocalControl,
                    toolViewDetailLevelByToolName: {},
                    toolViewExpandedDetailLevelDefault: 'summary',
                    toolViewExpandedDetailLevelByToolName: {},
                    toolViewTapAction: 'expand',
                    permissionPromptSurface: 'composer',
                    toolViewTimelineFeedDefaultExpanded: false,
                }} />
        </>, source), { wrapper: PaneWrapper, createNodeMock: (element) => hasHostTestId(element, 'ask-user-question.freeform:0')
            ? { focus: answerControlIndex++ === 0 ? promptFocus : transcriptFocus } : null });
        expect(screen.findAllHostsByTestId('ask-user-question.freeform:0')).toHaveLength(2);
        expect(promptFocus).not.toHaveBeenCalled();
        expect(transcriptFocus).toHaveBeenCalledOnce();
        expect(answerUserAction).not.toHaveBeenCalled();
    });

    it('focuses the custom ExitPlan approve control without approving the plan', async () => {
        const focus = vi.fn();
        const respondToPermission = vi.fn();
        setPendingNavigationLanding({ serverId: 'home-a', sessionId: 's1' }, 'plan-1', 'pending', 'transcript');
        const tool = makeToolCall({ name: 'ExitPlanMode', state: 'running', input: { plan: 'Build the feature' },
            permission: { id: 'plan-1', status: 'pending' } });
        const source = createTestSessionTranscriptSource({ sessionId: 's1', serverId: 'home-a',
            interaction: { canSendMessages: true, canApprovePermissions: true },
            actions: { respondToPermission, answerUserAction: async () => {}, abort: async () => {}, submitMessage: async () => {} },
        });
        const screen = await renderScreen(wrapWithSessionTranscriptSource(
            <ExitPlanToolView {...makeToolViewProps(tool, { sessionId: 's1', messageId: 'message-1' })} />, source,
        ), { wrapper: PaneWrapper, createNodeMock: (element) => hasHostTestId(element, 'exit-plan-approve') ? { focus } : null });
        expect(screen.findHostByTestId('exit-plan-approve')).toBeTruthy();
        expect(focus).toHaveBeenCalledOnce();
        expect(respondToPermission).not.toHaveBeenCalled();
    });

    it.each(['web', 'ios'] as const)('focuses the first %s answer field on a Next landing without selecting or submitting', async (platform) => {
        focusPlatform.platform = platform;
        expect((await import('react-native')).Platform.OS).toBe(platform);
        const focus = vi.fn();
        const answerUserAction = vi.fn();
        setPendingNavigationLanding({ serverId: 'home-a', sessionId: 's1' }, 'question-1');
        const tool = makeToolCall({ name: 'AskUserQuestion', state: 'running',
            input: { questions: [{ id: 'answer', question: 'Describe it', selection: 'text', required: true }] },
            permission: { id: 'question-1', status: 'pending' },
        });
        const source = createTestSessionTranscriptSource({
            sessionId: 's1', serverId: 'home-a',
            interaction: { canSendMessages: true, canApprovePermissions: true },
            agentState: { requests: { 'question-1': { tool: 'AskUserQuestion', arguments: {}, createdAt: 1 } } },
            actions: { answerUserAction, respondToPermission: async () => {}, abort: async () => {}, submitMessage: async () => {} },
        });
        const screen = await renderScreen(wrapWithSessionTranscriptSource(
            <AskUserQuestionView {...makeToolViewProps(tool, { sessionId: 's1' })} />, source,
        ), { wrapper: PaneWrapper, createNodeMock: (element) => hasHostTestId(element, 'ask-user-question.freeform:0') ? { focus } : null });
        expect(screen.findHostByTestId('ask-user-question.freeform:0')?.props.value).toBe('');
        expect(focus).toHaveBeenCalledOnce();
        expect(answerUserAction).not.toHaveBeenCalled();
    });

    it('allows submitting when the matching legacy request omits kind', async () => {
        sessionAllowWithAnswers.mockReset();
        sessionAllowWithAnswers.mockResolvedValueOnce(undefined);

        const tool: ToolCall = makeToolCall({
            name: 'AskUserQuestion',
            state: 'running',
            input: {
                questions: [
                    {
                        header: 'Q1',
                        question: 'Pick one',
                        multiSelect: false,
                        options: [{ label: 'A', description: '' }, { label: 'B', description: '' }],
                    },
                ],
            },
            permission: { id: 'toolu_1', status: 'pending' },
        });

        const address = { serverId: 'home-a', sessionId: 's1' };
        setPendingNavigationLanding(address, 'toolu_1');
        const source = createTestSessionTranscriptSource({
            ...address,
            interaction: { canSendMessages: true, canApprovePermissions: true },
            agentState: { requests: { toolu_1: { tool: 'AskUserQuestion', arguments: {}, createdAt: 1 } } },
            actions: { answerUserAction: async (params) => {
                await sessionAllowWithAnswers(params);
                source.update({ messages: [], reducerState: null, metadata: null, agentState: { requests: {} } });
            }, respondToPermission: async () => {}, abort: async () => {}, submitMessage: async () => {} },
        });
        const screen = await renderWithSessionTranscriptSource(<AppPaneProvider>
            <AskUserQuestionView {...makeToolViewProps(tool, { sessionId: 's1' })} />
            <PendingNavigationSettledNotice address={address} />
        </AppPaneProvider>, source);
        const option = screen.findHostByTestId('ask-user-question.option:0:0');
        expect(option).toBeTruthy();
        await pressTestInstanceAsync(option, 'A');

        const submit = screen.findHostByTestId('ask-user-question.submit');
        expect(submit).toBeTruthy();
        await pressTestInstanceAsync(submit, 'tools.askUserQuestion.submit');

        expect(sessionAllowWithAnswers).toHaveBeenCalledTimes(1);
        expect(sessionAllowWithAnswers).toHaveBeenCalledWith({ id: 'toolu_1', answers: { 'Pick one': ['A'] } });
        expect(screen.findHostByTestId('pending-navigation-settled')).toBeNull();
    });
});
