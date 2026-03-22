import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

import type { PendingPermissionRequest } from '@/utils/sessions/sessionUtils';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
            View: 'View',
            Text: 'Text',
            Pressable: 'Pressable',
            Platform: {
                OS: 'ios',
                select: (v: any) => v.ios,
            },
            AppState: {
                currentState: 'active',
                addEventListener: () => ({ remove: () => {} }),
            },
        }
    );
});

const routerPush = vi.fn();

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const routerMock = createExpoRouterMock({
        router: { push: routerPush },
    });
    return routerMock.module;
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@/components/tools/shell/permissions/presentation/buildPermissionPromptModel', () => ({
    buildPermissionPromptModel: () => ({
        request: { id: 'ua1', tool: 'ask_user', arguments: { question: 'Continue?' } },
        tool: {
            name: 'ask_user',
            state: 'running',
            input: { question: 'Continue?' },
            createdAt: 1,
            startedAt: 1,
            completedAt: null,
            description: null,
            result: null,
            permission: { id: 'ua1', status: 'pending' },
        },
        headerText: { normalizedToolName: 'ask_user', title: 'Question', subtitle: 'Continue?', statusText: null },
    }),
}));

vi.mock('@/components/tools/shell/views/ToolInlineBody', () => ({
    ToolInlineBody: (props: any) => React.createElement('ToolInlineBody', props),
}));

describe('UserActionPromptCard (preview)', () => {
    it('hides the open-details action when the prompt location is not durably addressable', async () => {
        const { UserActionPromptCard } = await import('./UserActionPromptCard');

        const request = {
            id: 'ua1',
            tool: 'ask_user',
            kind: 'user_action',
            arguments: { question: 'Continue?' },
        } as PendingPermissionRequest;

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(
                <UserActionPromptCard
                    request={request}
                    location={{
                        kind: 'top',
                        messageId: 'v0k1hmbmnud',
                        seq: null,
                    }}
                    sessionId="session-1"
                    metadata={null}
                    canApprovePermissions={true}
                />,
            );
        });

        expect(() => tree!.root.findByProps({ testID: 'user-action-prompt-view-tool' })).toThrow();
        expect(routerPush).not.toHaveBeenCalled();
    });
});
