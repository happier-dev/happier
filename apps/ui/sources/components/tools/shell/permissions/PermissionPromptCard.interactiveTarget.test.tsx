import { renderWithSessionTranscriptSource as renderBoundScreen, createTestSessionTranscriptSource } from '@/dev/testkit';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PendingPermissionRequest } from '@/utils/sessions/sessionUtils';
import { standardCleanup } from '@/dev/testkit';
import { createSessionFixture, makeToolCall } from '@/dev/testkit';
import type { ToolCallMessage } from '@happier-dev/session-core/messages';
import { setPendingNavigationLanding, markSessionPendingAnswer } from '@/activity/source/pendingNavigationRuntime';
import { installPermissionShellCommonModuleMocks } from './permissionShellTestHelpers';
import { AgentStateSchema } from '@happier-dev/session-core/state';
import { createReducer, reducer } from '@happier-dev/session-core/reducer';
import { listPendingPermissionRequests } from '@happier-dev/session-core/pending';

const platformEnvironment = vi.hoisted(() => ({
    platform: 'web' as 'web' | 'android',
}));
function renderWithSessionTranscriptSource(element: React.ReactElement) {
    return renderBoundScreen(element, createTestSessionTranscriptSource({ sessionId: 'session-1', navigate: () => {} }));
}

installPermissionShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Text: 'Text',
            Pressable: 'Pressable',
            Platform: {
                get OS() {
                    return platformEnvironment.platform;
                },
                select: <T,>(values: { web?: T; android?: T; default?: T }) =>
                    values[platformEnvironment.platform] ?? values.default,
            },
        });
    },
    storage: async (importOriginal) => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            importOriginal,
            useSetting: (key: string) => key === 'toolViewDetailLevelDefault' ? 'title' : null,
        });
    },
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

function flattenStyle(style: unknown): Record<string, unknown> {
    if (typeof style === 'function') {
        return flattenStyle(style({ pressed: false }));
    }
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map(flattenStyle));
    }
    return style && typeof style === 'object' ? style as Record<string, unknown> : {};
}

describe('PermissionPromptCard interactive targets', () => {
    it('offers only invocation approval for a projected native Edit after AgentState unloads', async () => {
        const { PermissionPromptCard } = await import('./PermissionPromptCard');
        const { messages } = reducer(createReducer(), [], AgentStateSchema.parse({ requests: {
            edit: { tool: 'Edit', arguments: { file_path: 'example.ts' }, createdAt: 1,
                turnId: 'native-turn', source: 'native_tool_approval_once' },
        } }));
        const [request] = listPendingPermissionRequests({ sessionId: 'session-1', active: true, agentState: null,
            actionConfirmations: null, presentationCompletedRequests: null, projected: null }, messages);
        if (!request) throw new Error('Missing projected native request');
        const respondToPermission = vi.fn(async () => {});
        const source = createTestSessionTranscriptSource({ sessionId: 'session-1', agentState: null,
            interaction: { canApprovePermissions: true, canSendMessages: true },
            actions: { respondToPermission, answerUserAction: vi.fn(), abort: vi.fn(), submitMessage: vi.fn() },
        });
        const screen = await renderBoundScreen(<PermissionPromptCard sessionId="session-1" request={request}
            location={null} metadata={createSessionFixture({ metadata: {
                path: '/fixture', host: 'fixture', flavor: 'claude',
            } }).metadata} canApprovePermissions />, source);
        const reusableGrants = screen.findAll(node => typeof node.type === 'string'
            && node.props.accessibilityRole === 'button' && typeof node.props.onPress === 'function'
            && node.props.testID === undefined);
        expect(reusableGrants).toHaveLength(0);
        await screen.pressByTestIdAsync('permission-footer.allow');
        expect(respondToPermission).toHaveBeenCalledWith({ id: 'edit', approved: true, turnId: 'native-turn' });
    });

    it('shows the settled landing after the request disappears without stale answer controls', async () => {
        setPendingNavigationLanding({ serverId: 'home-a', sessionId: 'session-1' }, 'answered-request', 'settled');
        const { SessionPendingPromptCards } = await import('./SessionPendingPromptCards');
        const source = createTestSessionTranscriptSource({ sessionId: 'session-1', serverId: 'home-a' });
        const screen = await renderBoundScreen(<SessionPendingPromptCards testID="pending-cards"
            sessionId="session-1" serverId="home-a" session={createSessionFixture({ active: true })}
            permissions={[]} userActions={[]} />, source);
        expect(screen.findHostByTestId('pending-navigation-settled')).toBeTruthy();
        expect(screen.findByTestId('permission-footer.allow')).toBeNull();
    });

    it('shows a disappeared request until this client accepts an answer for that exact request', async () => {
        const address = { serverId: 'home-a', sessionId: 'session-1' };
        const { SessionPendingPromptCards } = await import('./SessionPendingPromptCards');
        const source = createTestSessionTranscriptSource({ ...address, agentState: { requests: {
            p1: { tool: 'Read', arguments: {}, createdAt: 1 },
        } } });
        const card = <SessionPendingPromptCards testID="pending-cards" {...address}
            session={createSessionFixture({ active: true })} permissions={[]} userActions={[]} />;
        setPendingNavigationLanding(address, 'p1');
        const screen = await renderBoundScreen(card, source);
        expect(screen.findHostByTestId('pending-navigation-settled')).toBeNull();
        await React.act(async () => {
            source.update({ messages: [], reducerState: null, metadata: null, agentState: { requests: {} } });
        });
        await screen.update(card);
        expect(screen.findHostByTestId('pending-navigation-settled')).toBeTruthy();
        await React.act(async () => { markSessionPendingAnswer(address, 'p2'); });
        await screen.update(card);
        expect(screen.findHostByTestId('pending-navigation-settled')).toBeTruthy();
        await React.act(async () => { markSessionPendingAnswer(address, 'p1'); });
        await screen.update(card);
        expect(Boolean(screen.findHostByTestId('pending-navigation-settled'))).toBe(false);
        await React.act(async () => { markSessionPendingAnswer(address, 'p2'); });
        await screen.update(card);
        expect(Boolean(screen.findHostByTestId('pending-navigation-settled'))).toBe(false);
    });

    it('opens the pending card at its transcript location in the exact Home', async () => {
        const navigate = vi.fn();
        const { SessionPendingPromptCards } = await import('./SessionPendingPromptCards');
        const message: ToolCallMessage = { kind: 'tool-call', id: 'message-1', localId: null, createdAt: 1,
            tool: makeToolCall({ id: 'tool-1', name: 'Read', permission: { id: 'permission-1', status: 'pending' } }),
            children: [], seq: 4,
        };
        const source = createTestSessionTranscriptSource({ sessionId: 'session-1', serverId: 'home-a', messages: [message], navigate });
        const screen = await renderBoundScreen(<SessionPendingPromptCards testID="pending-cards"
            sessionId="session-1" serverId="home-a" session={createSessionFixture({ active: true })}
            permissions={[{ id: 'permission-1', kind: 'permission', tool: 'Read', arguments: {}, createdAt: 1 }]} userActions={[]} />, source);
        await screen.pressByTestIdAsync('permission-prompt-view-tool');
        expect(navigate).toHaveBeenCalledWith('/session/session-1?jumpSeq=4&serverId=home-a');
    });

    it('keeps a waiting card untouched while unrelated transcript messages arrive', async () => {
        const { SessionPendingPromptCards } = await import('./SessionPendingPromptCards');
        const { PermissionPromptCard } = await import('./PermissionPromptCard');
        const message: ToolCallMessage = { kind: 'tool-call', id: 'message-1', localId: null, createdAt: 1,
            tool: makeToolCall({ id: 'tool-1', name: 'Read', permission: { id: 'permission-1', status: 'pending' } }),
            children: [], seq: 4,
        };
        const source = createTestSessionTranscriptSource({ sessionId: 'session-1', serverId: 'home-a', messages: [message] });
        const permissions: PendingPermissionRequest[] = [{ id: 'permission-1', kind: 'permission', tool: 'Read', arguments: {}, createdAt: 1 }];
        const card = <SessionPendingPromptCards testID="pending-cards" sessionId="session-1" serverId="home-a"
            session={createSessionFixture({ active: true })} permissions={permissions} userActions={[]} />;
        const screen = await renderBoundScreen(card, source);
        const before = screen.findAllByType(PermissionPromptCard)[0]?.props.location;
        expect(before).toMatchObject({ kind: 'top', seq: 4 });
        await React.act(async () => {
            source.update({ messages: [message, { kind: 'agent-text', id: 'text-5', localId: null, createdAt: 2, seq: 5, text: 'Working' }],
                reducerState: null, metadata: null, agentState: null });
        });
        await screen.update(card);
        // The memoized card redraws only when its own request or location changes, not per transcript write.
        expect(screen.findAllByType(PermissionPromptCard)[0]?.props.location).toBe(before);
    });

    beforeEach(() => {
        platformEnvironment.platform = 'web';
        standardCleanup();
    });

    it.each([
        { platform: 'web' },
        { platform: 'android' },
    ] as const)(
        'draws the View Tool button at its padded icon size on $platform; the touch target is its hit area',
        async ({ platform }) => {
            platformEnvironment.platform = platform;
            const { PermissionPromptCard } = await import('./PermissionPromptCard');
            const request = {
                id: 'permission-1',
                tool: 'Edit',
                arguments: { path: 'file.ts' },
            } as PendingPermissionRequest;
            const screen = await renderWithSessionTranscriptSource(
                <PermissionPromptCard
                    request={request}
                    location={{
                        kind: 'nested',
                        parentMessageId: 'tool:call:parent/1',
                        messageId: 'tool:call:child/2',
                        seq: 12,
                    }}
                    sessionId="session-1"
                    metadata={null}
                    canApprovePermissions
                />,
            );

            const viewToolAction = screen.findByTestId('permission-prompt-view-tool');
            expect(viewToolAction).toBeTruthy();
            if (!viewToolAction) {
                throw new Error('Expected the View Tool action to be rendered');
            }
            expect(flattenStyle(viewToolAction.props.style).minWidth).toBeUndefined();
            expect(flattenStyle(viewToolAction.props.style).minHeight).toBeUndefined();
            expect(viewToolAction.findByType('Icon' as any).props.size).toBe(18);
        },
    );
});
