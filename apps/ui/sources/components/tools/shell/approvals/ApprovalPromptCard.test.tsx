import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';
import { collectRenderedTestIds, pressTestInstanceAsync, renderScreen } from '@/dev/testkit';

import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const executeAction = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const sessionAllow = vi.hoisted(() => vi.fn(async () => {}));
const sessionDeny = vi.hoisted(() => vi.fn(async () => {}));
const routerPush = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
            React.createElement('View', props, props.children),
        Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
            React.createElement('Text', props, props.children),
        Pressable: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
            React.createElement('Pressable', props, props.children),
        ActivityIndicator: (props: Record<string, unknown>) =>
            React.createElement('ActivityIndicator', props, null),
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props, null),
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: routerPush }),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/sync/ops', () => ({
    sessionAllow,
    sessionDeny,
}));

vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
    createDefaultActionExecutor: () => ({
        execute: executeAction,
    }),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
    resolvePreferredServerIdForSessionId: () => 'server-from-session',
}));

function approvalArtifact(): DecryptedArtifact {
    return {
        id: 'approval-1',
        header: {
            v: 1,
            kind: 'approval_request.v1',
            title: 'Approve',
            approvalStatus: 'open',
            sessionId: 's1',
            serverId: 'server-from-header',
        },
        title: 'Approve',
        sessions: ['s1'],
        body: null,
        headerVersion: 1,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        isDecrypted: true,
    };
}

function approvalRequest() {
    return {
        v: 1,
        status: 'open',
        createdAtMs: 1,
        updatedAtMs: 1,
        createdBy: { surface: 'session_agent', sessionId: 's1' },
        requestedSurface: 'session_agent',
        actionId: 'session.list',
        actionArgs: {},
        summary: 'List sessions',
        preview: { summary: 'Recent sessions will be listed.' },
    } as const;
}

describe('ApprovalPromptCard', () => {
    it('renders stable approval selectors and decides through the approval action', async () => {
        const { ApprovalPromptCard } = await import('./ApprovalPromptCard');
        executeAction.mockClear();
        sessionAllow.mockClear();
        sessionDeny.mockClear();

        const screen = await renderScreen(
            <ApprovalPromptCard
                artifact={approvalArtifact()}
                approval={approvalRequest()}
                sessionId="s1"
                metadata={null}
                canApprovePermissions={true}
            />,
        );

        expect(screen.findByTestId('approval-prompt-card')).toBeTruthy();

        const approve = screen.findByTestId('approval-prompt-approve');
        expect(approve).toBeTruthy();
        await pressTestInstanceAsync(approve, 'approval-prompt-approve');

        expect(executeAction).toHaveBeenCalledWith(
            'approval.request.decide',
            { artifactId: 'approval-1', decision: 'approve' },
            { surface: 'ui', serverId: 'server-from-header' },
        );
        expect(sessionAllow).not.toHaveBeenCalled();
        expect(sessionDeny).not.toHaveBeenCalled();
    });

    it('rejects through the approval action', async () => {
        const { ApprovalPromptCard } = await import('./ApprovalPromptCard');
        executeAction.mockClear();

        const screen = await renderScreen(
            <ApprovalPromptCard
                artifact={approvalArtifact()}
                approval={approvalRequest()}
                sessionId="s1"
                metadata={null}
                canApprovePermissions={true}
            />,
        );

        const reject = screen.findByTestId('approval-prompt-reject');
        expect(reject).toBeTruthy();
        await pressTestInstanceAsync(reject, 'approval-prompt-reject');

        expect(executeAction).toHaveBeenCalledWith(
            'approval.request.decide',
            { artifactId: 'approval-1', decision: 'reject' },
            { surface: 'ui', serverId: 'server-from-header' },
        );
    });

    it('places the primary approve action before the reject action', async () => {
        const { ApprovalPromptCard } = await import('./ApprovalPromptCard');

        const screen = await renderScreen(
            <ApprovalPromptCard
                artifact={approvalArtifact()}
                approval={approvalRequest()}
                sessionId="s1"
                metadata={null}
                canApprovePermissions={true}
            />,
        );

        const testIdOrder = collectRenderedTestIds(screen.tree.toJSON());

        expect(testIdOrder.indexOf('approval-prompt-approve')).toBeGreaterThanOrEqual(0);
        expect(testIdOrder.indexOf('approval-prompt-reject')).toBeGreaterThanOrEqual(0);
        expect(testIdOrder.indexOf('approval-prompt-approve')).toBeLessThan(
            testIdOrder.indexOf('approval-prompt-reject'),
        );
    });

    it('renders the approval preview summary', async () => {
        const { ApprovalPromptCard } = await import('./ApprovalPromptCard');

        const screen = await renderScreen(
            <ApprovalPromptCard
                artifact={approvalArtifact()}
                approval={approvalRequest()}
                sessionId="s1"
                metadata={null}
                canApprovePermissions={true}
            />,
        );

        expect(screen.getTextContent()).toContain('Recent sessions will be listed.');
    });

    it('opens the originating transcript tool when a location is available', async () => {
        const { ApprovalPromptCard } = await import('./ApprovalPromptCard');
        routerPush.mockClear();

        const screen = await renderScreen(
            <ApprovalPromptCard
                artifact={approvalArtifact()}
                approval={approvalRequest()}
                sessionId="s1"
                metadata={null}
                canApprovePermissions={true}
                location={{ kind: 'top', messageId: 'tool:tool-1', seq: 10 }}
            />,
        );

        const viewTool = screen.findByTestId('approval-prompt-view-tool');
        expect(viewTool).toBeTruthy();
        await pressTestInstanceAsync(viewTool, 'approval-prompt-view-tool');

        expect(routerPush).toHaveBeenCalledWith('/session/s1?jumpSeq=10');
    });

    it('renders a disabled explanation instead of decision controls when approval is not allowed', async () => {
        const { ApprovalPromptCard } = await import('./ApprovalPromptCard');

        const screen = await renderScreen(
            <ApprovalPromptCard
                artifact={approvalArtifact()}
                approval={approvalRequest()}
                sessionId="s1"
                metadata={null}
                canApprovePermissions={false}
                disabledReason="readOnly"
            />,
        );

        expect(screen.getTextContent()).toContain('session.sharing.permissionApprovalsDisabledTitle');
        expect(screen.getTextContent()).toContain('session.sharing.permissionApprovalsDisabledReadOnly');
        expect(screen.findByTestId('approval-prompt-approve')).toBeNull();
        expect(screen.findByTestId('approval-prompt-reject')).toBeNull();
    });
});
