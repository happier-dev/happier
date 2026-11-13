import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

const navigateToSessionMock = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
}));
vi.mock('@/components/sessions/runs/ExecutionRunStatusPill', () => ({
    ExecutionRunStatusPill: (props: any) => React.createElement('ExecutionRunStatusPill', props),
}));
vi.mock('@/hooks/session/useNavigateToSession', () => ({ useNavigateToSession: () => navigateToSessionMock }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession', () => ({
    usePreferredServerIdForSession: () => 'server-a',
}));
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key, values) => {
            if (key === 'executionRunDelivery.queued') return 'Queued for Lead, delivery pending';
            if (key === 'visibleAgents.role') return `Role: ${String(values?.value)}`;
            if (key === 'visibleAgents.model') return `Model: ${String(values?.value)}`;
            return key;
        },
    });
});

describe('ExecutionRunRow', () => {
    it('shows the linked child delivery receipt state without promoting a queued relay to sent', async () => {
        const { ExecutionRunRow } = await import('./ExecutionRunRow');
        const screen = await renderScreen(<ExecutionRunRow run={{
            runId: 'run-1',
            intent: 'review',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            status: 'running',
            display: null,
            visibility: 'session',
            role: { id: 'reviewer', name: 'Reviewer', assignmentId: 'assignment-1' },
            modelId: 'gpt-test',
            permissionMode: 'read_only',
            linkedSessionId: 'child-1',
            linkState: {
                report: { turnEpoch: 5, ack: 'accepted', reportedAt: 100, attempts: 1 },
                relay: { turnEpoch: 5, status: 'queued', localId: 'completion-1', at: 110 },
            },
        } as any} />);

        const delivery = screen.findByTestId('execution-run-delivery-status-run-1');
        expect(delivery?.props.children).toBe('Queued for Lead, delivery pending');
        expect(String(screen.findByTestId('execution-run-controls-run-1')?.props.children)).toContain('Reviewer');
        expect(String(screen.findByTestId('execution-run-controls-run-1')?.props.children)).toContain('gpt-test');
        expect(JSON.stringify(screen.tree.toJSON())).not.toContain('Sent to Lead');
    });

    it('opens the linked child through the child session server scope', async () => {
        navigateToSessionMock.mockReset();
        const { ExecutionRunRow } = await import('./ExecutionRunRow');
        const screen = await renderScreen(<ExecutionRunRow run={{
            runId: 'run-1',
            intent: 'review',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            status: 'running',
            display: null,
            linkedSessionId: 'child-1',
        } as any} />);

        await screen.pressByTestIdAsync('execution-run-linked-session-run-1');

        expect(navigateToSessionMock).toHaveBeenCalledWith('child-1', { serverId: 'server-a' });
    });
});
