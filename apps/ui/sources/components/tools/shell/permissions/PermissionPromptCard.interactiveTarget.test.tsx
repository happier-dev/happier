import { renderWithSessionTranscriptSource as renderBoundScreen, createTestSessionTranscriptSource } from '@/dev/testkit';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PendingPermissionRequest } from '@/utils/sessions/sessionUtils';
import { standardCleanup } from '@/dev/testkit';
import { createSessionFixture, makeToolCall } from '@/dev/testkit';
import type { ToolCallMessage } from '@happier-dev/session-core/messages';
import { setPendingNavigationLanding, markSessionPendingAnswer } from '@/activity/source/pendingNavigationRuntime';
import { installPermissionShellCommonModuleMocks } from './permissionShellTestHelpers';

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

    beforeEach(() => {
        platformEnvironment.platform = 'web';
        standardCleanup();
    });

    it.each([
        { platform: 'web', minimumSize: 44 },
        { platform: 'android', minimumSize: 48 },
    ] as const)(
        'keeps the View Tool hit target at least $minimumSize on $platform without enlarging its icon',
        async ({ platform, minimumSize }) => {
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
            expect(flattenStyle(viewToolAction.props.style)).toMatchObject({
                minWidth: minimumSize,
                minHeight: minimumSize,
            });
            expect(viewToolAction.findByType('Icon' as any).props.size).toBe(18);
        },
    );
});
