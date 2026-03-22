import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

import type { ToolCall } from '@/sync/domains/messages/messageTypes';
import { makeToolCall, makeToolViewProps, findPressableByText } from '../../shell/views/ToolView.testHelpers';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sessionAllowWithAnswers = vi.fn();

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
            View: (props: any) => React.createElement('View', props, props.children),
            Text: (props: any) => React.createElement('Text', props, props.children),
            TouchableOpacity: (props: any) => React.createElement('TouchableOpacity', props, props.children),
            TextInput: (props: any) => React.createElement('TextInput', props, null),
            ActivityIndicator: (props: any) => React.createElement('ActivityIndicator', props, null),
        }
    );
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                surfaceHighest: '#fafafa',
                text: '#000',
                textSecondary: '#666',
                input: { background: '#fff' },
                button: { primary: { background: '#000', tint: '#fff' } },
                radio: { active: '#0af', inactive: '#999' },
                success: '#0a0',
                border: '#ddd',
            },
        },
    });
});

vi.mock('../../shell/presentation/ToolSectionView', () => ({
    ToolSectionView: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

vi.mock('@/sync/ops', () => ({
    sessionAllowWithAnswers: (...args: any[]) => sessionAllowWithAnswers(...args),
}));

vi.mock('@/sync/domains/state/storage', async () => {
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
});

describe('AskUserQuestionView legacy request-kind fallback', () => {
    it('allows submitting when the matching legacy request omits kind', async () => {
        sessionAllowWithAnswers.mockReset();
        sessionAllowWithAnswers.mockResolvedValueOnce(undefined);

        const { AskUserQuestionView } = await import('./AskUserQuestionView');
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

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(React.createElement(AskUserQuestionView, makeToolViewProps(tool, { sessionId: 's1' })))).tree;

        const option = findPressableByText(tree!, 'A');
        expect(option).toBeTruthy();
        await act(async () => {
            option!.props.onPress();
        });

        const submit = findPressableByText(tree!, 'tools.askUserQuestion.submit');
        expect(submit).toBeTruthy();
        await act(async () => {
            submit!.props.onPress();
            await Promise.resolve();
        });

        expect(sessionAllowWithAnswers).toHaveBeenCalledTimes(1);
        expect(sessionAllowWithAnswers).toHaveBeenCalledWith('s1', 'toolu_1', { 'Pick one': 'A' });
    });
});
