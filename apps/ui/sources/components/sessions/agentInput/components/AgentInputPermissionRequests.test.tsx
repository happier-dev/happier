import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import type { AgentInputPermissionRequests as AgentInputPermissionRequestsComponent } from './AgentInputPermissionRequests';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const capturedPermissionPromptCardProps: Array<Record<string, unknown>> = [];
const capturedApprovalPromptCardProps: Array<Record<string, unknown>> = [];
const capturedUserActionPromptCardProps: Array<Record<string, unknown>> = [];

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: (props: any) => React.createElement('View', props, props.children),
        ScrollView: (props: any) => React.createElement('ScrollView', props, props.children),
        Platform: {
            OS: 'web',
            select: (value: any) => value.web ?? value.default ?? null,
        },
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                divider: '#ddd',
                surfaceHighest: '#fff',
                input: { background: '#f7f7f7' },
                textSecondary: '#666',
            },
        },
    });
});

vi.mock('@/components/ui/scroll/ScrollEdgeFades', () => ({
    ScrollEdgeFades: () => null,
}));

vi.mock('@/components/ui/scroll/ScrollEdgeIndicators', () => ({
    ScrollEdgeIndicators: () => null,
}));

vi.mock('@/components/tools/shell/permissions/PermissionPromptCard', () => ({
    PermissionPromptCard: (props: any) => {
        capturedPermissionPromptCardProps.push(props);
        return React.createElement('PermissionPromptCard', props);
    },
}));

vi.mock('@/components/tools/shell/approvals/ApprovalPromptCard', () => ({
    ApprovalPromptCard: (props: any) => {
        capturedApprovalPromptCardProps.push(props);
        return React.createElement('ApprovalPromptCard', props);
    },
}));

vi.mock('@/components/tools/shell/userActions/UserActionPromptCard', () => ({
    UserActionPromptCard: (props: any) => {
        capturedUserActionPromptCardProps.push(props);
        return React.createElement('UserActionPromptCard', props);
    },
}));

// Load the component graph before timed cases; a cold import is not a render deadline.
const { AgentInputPermissionRequests } = await import('./AgentInputPermissionRequests');

describe('AgentInputPermissionRequests', () => {
    it('renders a single outer chrome wrapper and uses inline cards with dividers', async () => {
        capturedPermissionPromptCardProps.length = 0;

        const screen = await renderScreen(React.createElement(AgentInputPermissionRequests, {
            sessionId: 's1',
            permissionRequests: [
                { id: 'p1', kind: 'permission', tool: 'execute', arguments: { command: 'pwd' }, createdAt: null },
                { id: 'p2', kind: 'permission', tool: 'execute', arguments: { command: 'ls' }, createdAt: null },
            ],
            permissionLocationsById: new Map(),
            metadata: null,
            canApprovePermissions: true,
            maxHeightPx: 200,
            onContentSizeChange: () => {},
            onLayout: () => {},
            onScroll: () => {},
            fadeVisibility: { top: false, bottom: false },
        } satisfies React.ComponentProps<typeof AgentInputPermissionRequestsComponent>));

        expect(screen.findByTestId('agentInput.permissionRequests.chrome')).toBeTruthy();

        expect(capturedPermissionPromptCardProps).toHaveLength(2);
        expect(capturedPermissionPromptCardProps[0].chrome).toBe('inline');

        // 2 rows => 1 divider (attached to the second row).
        expect(screen.findByTestId('agentInput.permissionRequests.divider:p2')).toBeTruthy();
    });

    it('presents one request at a time on a phone, with a pager that follows decided requests', async () => {
        const { act } = await import('react-test-renderer');
        const request = (id: string) => ({ id, kind: 'permission' as const, tool: 'execute', arguments: { command: id }, createdAt: null });
        const props = (ids: readonly string[]) => ({
            sessionId: 's1',
            permissionRequests: ids.map(request),
            permissionLocationsById: new Map(),
            metadata: null,
            canApprovePermissions: true,
            maxHeightPx: 280,
            presentation: 'oneAtATime',
            onContentSizeChange: () => {},
            onLayout: () => {},
            onScroll: () => {},
            fadeVisibility: { top: false, bottom: false },
        } satisfies React.ComponentProps<typeof AgentInputPermissionRequestsComponent>);
        const shownIds = () => screen.findAll((node) => node.type === 'PermissionPromptCard').map((node) => node.props.request.id);

        // The Session's open requests change under the tray while it stays mounted.
        let setIds: (ids: readonly string[]) => void = () => {};
        function Harness() {
            const [ids, update] = React.useState<readonly string[]>(['p1', 'p2', 'p3']);
            setIds = update;
            return React.createElement(AgentInputPermissionRequests, props(ids));
        }
        const screen = await renderScreen(React.createElement(Harness));
        expect(shownIds()).toEqual(['p1']);
        expect(screen.findByTestId('agentInput.permissionRequests.pager')).toBeTruthy();

        await screen.pressByTestIdAsync('agentInput.permissionRequests.next');
        expect(shownIds()).toEqual(['p2']);

        // Deciding the request on screen shows the one that took its place.
        await act(async () => setIds(['p1', 'p3']));
        expect(shownIds()).toEqual(['p3']);

        await act(async () => setIds(['p1']));
        expect(shownIds()).toEqual(['p1']);
        expect(screen.findByTestId('agentInput.permissionRequests.pager')).toBeNull();
    });

    it('renders approval requests and ignores explicit user action requests inside the composer chrome', async () => {
        capturedPermissionPromptCardProps.length = 0;
        capturedApprovalPromptCardProps.length = 0;
        capturedUserActionPromptCardProps.length = 0;

        const screen = await renderScreen(React.createElement(AgentInputPermissionRequests, {
            sessionId: 's1',
            permissionRequests: [
                { id: 'p1', kind: 'permission', tool: 'execute', arguments: { command: 'pwd' }, createdAt: null },
            ],
            approvalRequests: [
                {
                    artifact: {
                        id: 'approval-1',
                        header: { v: 1, kind: 'approval_request.v1', title: 'Approve', approvalStatus: 'open', sessionId: 's1' },
                    },
                    approval: {
                        v: 1,
                        status: 'open',
                        createdAtMs: 1,
                        updatedAtMs: 1,
                        createdBy: { surface: 'agent', sessionId: 's1' },
                        requestedSurface: 'agent',
                        actionId: 'session.list',
                        actionArgs: {},
                        summary: 'List sessions',
                    },
                },
            ],
            permissionLocationsById: new Map(),
            metadata: null,
            canApprovePermissions: true,
            maxHeightPx: 200,
            onContentSizeChange: () => {},
            onLayout: () => {},
            onScroll: () => {},
            fadeVisibility: { top: false, bottom: false },
        } satisfies React.ComponentProps<typeof AgentInputPermissionRequestsComponent>));

        expect(screen.findByTestId('agentInput.permissionRequests.chrome')).toBeTruthy();
        expect(capturedPermissionPromptCardProps).toHaveLength(1);
        expect(capturedApprovalPromptCardProps).toHaveLength(1);
        expect(capturedUserActionPromptCardProps).toHaveLength(0);
        expect(capturedApprovalPromptCardProps[0]).toEqual(expect.objectContaining({ chrome: 'inline' }));
        expect(screen.findByTestId('agentInput.permissionRequests.divider:approval:approval-1')).toBeTruthy();
        expect(screen.findByTestId('agentInput.permissionRequests.divider:userAction:u1')).toBeNull();
    });

    it('passes resolved tool locations to approval prompt cards', async () => {
        capturedApprovalPromptCardProps.length = 0;

        await renderScreen(React.createElement(AgentInputPermissionRequests, {
            sessionId: 's1',
            permissionRequests: [],
            approvalRequests: [
                {
                    artifact: {
                        id: 'approval-1',
                        header: { v: 1, kind: 'approval_request.v1', title: 'Approve', approvalStatus: 'open', sessionId: 's1' },
                    },
                    approval: {
                        v: 1,
                        status: 'open',
                        createdAtMs: 1,
                        updatedAtMs: 1,
                        createdBy: { surface: 'agent', sessionId: 's1' },
                        requestedSurface: 'agent',
                        actionId: 'session.list',
                        actionArgs: {},
                        summary: 'List sessions',
                    },
                },
            ],
            permissionLocationsById: new Map(),
            approvalLocationsByArtifactId: new Map([
                ['approval-1', { kind: 'top' as const, messageId: 'tool:call-1', seq: 10 }],
            ]),
            metadata: null,
            canApprovePermissions: true,
            maxHeightPx: 200,
            onContentSizeChange: () => {},
            onLayout: () => {},
            onScroll: () => {},
            fadeVisibility: { top: false, bottom: false },
        } satisfies React.ComponentProps<typeof AgentInputPermissionRequestsComponent>));

        expect(capturedApprovalPromptCardProps).toHaveLength(1);
        expect(capturedApprovalPromptCardProps[0].location).toEqual({ kind: 'top', messageId: 'tool:call-1', seq: 10 });
    });

    it('does not render when approvals are disabled due to inactive session', async () => {
        capturedPermissionPromptCardProps.length = 0;

        const screen = await renderScreen(React.createElement(AgentInputPermissionRequests, {
            sessionId: 's1',
            permissionRequests: [
                { id: 'p1', kind: 'permission', tool: 'execute', arguments: { command: 'pwd' }, createdAt: null },
            ],
            permissionLocationsById: new Map(),
            metadata: null,
            canApprovePermissions: false,
            disabledReason: 'inactive',
            maxHeightPx: 200,
            onContentSizeChange: () => {},
            onLayout: () => {},
            onScroll: () => {},
            fadeVisibility: { top: false, bottom: false },
        } satisfies React.ComponentProps<typeof AgentInputPermissionRequestsComponent>));

        expect(screen.findByTestId('agentInput.permissionRequests.chrome')).toBeNull();
        expect(capturedPermissionPromptCardProps).toHaveLength(0);
    });

    it('does not render permission requests when the session is inactive even if canApprovePermissions is incorrectly true', async () => {
        capturedPermissionPromptCardProps.length = 0;

        const screen = await renderScreen(React.createElement(AgentInputPermissionRequests, {
            sessionId: 's1',
            permissionRequests: [
                { id: 'p1', kind: 'permission', tool: 'mcp__playwright__browser_close', arguments: {}, createdAt: null },
            ],
            permissionLocationsById: new Map(),
            metadata: null,
            canApprovePermissions: true,
            disabledReason: 'inactive',
            maxHeightPx: 200,
            onContentSizeChange: () => {},
            onLayout: () => {},
            onScroll: () => {},
            fadeVisibility: { top: false, bottom: false },
        } satisfies React.ComponentProps<typeof AgentInputPermissionRequestsComponent>));

        expect(screen.findByTestId('agentInput.permissionRequests.chrome')).toBeNull();
        expect(capturedPermissionPromptCardProps).toHaveLength(0);
    });

    it('renders artifact approvals while hiding process-bound requests on inactive sessions', async () => {
        const UntypedAgentInputPermissionRequests = AgentInputPermissionRequests as React.ComponentType<any>;
        capturedPermissionPromptCardProps.length = 0;
        capturedApprovalPromptCardProps.length = 0;
        capturedUserActionPromptCardProps.length = 0;

        const screen = await renderScreen(React.createElement(UntypedAgentInputPermissionRequests, {
            sessionId: 's1',
            permissionRequests: [
                { id: 'p1', kind: 'permission', tool: 'execute', arguments: { command: 'pwd' }, createdAt: null },
            ],
            approvalRequests: [
                {
                    artifact: {
                        id: 'approval-1',
                        header: { v: 1, kind: 'approval_request.v1', title: 'Approve', approvalStatus: 'open', sessionId: 's1' },
                        title: 'Approve',
                        headerVersion: 1,
                        seq: 1,
                        createdAt: 1,
                        updatedAt: 1,
                        isDecrypted: true,
                    },
                    approval: {
                        v: 1,
                        status: 'open',
                        createdAtMs: 1,
                        updatedAtMs: 1,
                        createdBy: { surface: 'agent', sessionId: 's1' },
                        requestedSurface: 'agent',
                        actionId: 'session.list',
                        actionArgs: {},
                        summary: 'List sessions',
                    },
                },
            ],
            userActionRequests: [
                {
                    id: 'u1',
                    kind: 'user_action',
                    tool: 'AskUserQuestion',
                    arguments: { question: 'How should Claude resume this session?' },
                    createdAt: null,
                },
            ],
            permissionLocationsById: new Map(),
            metadata: null,
            canApprovePermissions: false,
            disabledReason: 'inactive',
            maxHeightPx: 200,
            onContentSizeChange: () => {},
            onLayout: () => {},
            onScroll: () => {},
            fadeVisibility: { top: false, bottom: false },
        }));

        expect(screen.findByTestId('agentInput.permissionRequests.chrome')).toBeTruthy();
        expect(capturedPermissionPromptCardProps).toHaveLength(0);
        expect(capturedApprovalPromptCardProps).toHaveLength(1);
        expect(capturedUserActionPromptCardProps).toHaveLength(0);
    });
});
