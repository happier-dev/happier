import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import type { AgentInputPermissionRequests as AgentInputPermissionRequestsComponent } from './AgentInputPermissionRequests';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const capturedPermissionPromptCardProps: Array<Record<string, unknown>> = [];
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

vi.mock('@/components/tools/shell/userActions/UserActionPromptCard', () => ({
    UserActionPromptCard: (props: any) => {
        capturedUserActionPromptCardProps.push(props);
        return React.createElement('UserActionPromptCard', props);
    },
}));

describe('AgentInputPermissionRequests', () => {
    it('renders a single outer chrome wrapper and uses inline cards with dividers', async () => {
        const { AgentInputPermissionRequests } = await import('./AgentInputPermissionRequests');
        capturedPermissionPromptCardProps.length = 0;
        capturedUserActionPromptCardProps.length = 0;

        const screen = await renderScreen(React.createElement(AgentInputPermissionRequests, {
            sessionId: 's1',
            permissionRequests: [
                { id: 'p1', kind: 'permission', tool: 'execute', arguments: { command: 'pwd' }, createdAt: null },
                { id: 'p2', kind: 'permission', tool: 'execute', arguments: { command: 'ls' }, createdAt: null },
            ],
            userActionRequests: [
                { id: 'u1', kind: 'user_action', tool: 'execute', arguments: { command: 'whoami' }, createdAt: null },
            ],
            permissionLocationsById: new Map(),
            metadata: null,
            canApprovePermissions: true,
            maxHeightPx: 200,
            clampedHeightPx: 200,
            onContentSizeChange: () => {},
            onLayout: () => {},
            onScroll: () => {},
            fadeVisibility: { top: false, bottom: false },
        } satisfies React.ComponentProps<typeof AgentInputPermissionRequestsComponent>));

        expect(screen.findByTestId('agentInput.permissionRequests.chrome')).toBeTruthy();

        expect(capturedPermissionPromptCardProps).toHaveLength(2);
        expect(capturedUserActionPromptCardProps).toHaveLength(1);
        expect(capturedPermissionPromptCardProps[0].chrome).toBe('inline');
        expect(capturedUserActionPromptCardProps[0].chrome).toBe('inline');

        // 3 rows => 2 dividers (each divider is attached to the row after it).
        expect(screen.findByTestId('agentInput.permissionRequests.divider:p2')).toBeTruthy();
        expect(screen.findByTestId('agentInput.permissionRequests.divider:u1')).toBeTruthy();
    });

    it('does not render when approvals are disabled due to inactive session', async () => {
        const { AgentInputPermissionRequests } = await import('./AgentInputPermissionRequests');
        capturedPermissionPromptCardProps.length = 0;
        capturedUserActionPromptCardProps.length = 0;

        const screen = await renderScreen(React.createElement(AgentInputPermissionRequests, {
            sessionId: 's1',
            permissionRequests: [
                { id: 'p1', kind: 'permission', tool: 'execute', arguments: { command: 'pwd' }, createdAt: null },
            ],
            userActionRequests: [],
            permissionLocationsById: new Map(),
            metadata: null,
            canApprovePermissions: false,
            disabledReason: 'inactive',
            maxHeightPx: 200,
            clampedHeightPx: 200,
            onContentSizeChange: () => {},
            onLayout: () => {},
            onScroll: () => {},
            fadeVisibility: { top: false, bottom: false },
        } satisfies React.ComponentProps<typeof AgentInputPermissionRequestsComponent>));

        expect(screen.findByTestId('agentInput.permissionRequests.chrome')).toBeNull();
        expect(capturedPermissionPromptCardProps).toHaveLength(0);
    });

});
