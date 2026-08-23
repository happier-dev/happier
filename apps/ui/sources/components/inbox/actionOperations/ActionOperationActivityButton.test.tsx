import * as React from 'react';
import { View } from 'react-native';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol';

import { renderScreen } from '@/dev/testkit';
import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key === 'inbox.updates' ? 'Activity' : key });
});

const capturedPopoverProps: { current: Readonly<Record<string, unknown>> | null } = { current: null };
type CapturedPopoverProps = Readonly<Record<string, unknown>> & Readonly<{
    open: boolean;
    children: React.ReactNode | ((renderProps: Readonly<{ maxHeight: number; maxWidth: number; placement: 'bottom' }>) => React.ReactNode);
}>;
vi.mock('@/components/ui/popover', () => ({
    Popover: React.memo((props: CapturedPopoverProps) => {
        capturedPopoverProps.current = props;
        if (!props.open) return null;
        const content = typeof props.children === 'function'
            ? props.children({ maxHeight: 560, maxWidth: 396, placement: 'bottom' })
            : props.children;
        return <View testID="action-operation-activity-popover">{content}</View>;
    }),
}));
vi.mock('@/components/ui/overlays/FloatingOverlay', () => ({
    FloatingOverlay: React.memo((props: { children: React.ReactNode }) => <View>{props.children}</View>),
}));

function operation(overrides: Partial<ActionOperationSnapshotV1> = {}): ActionOperationProjection {
    return {
        snapshot: {
            version: 1,
            operationId: 'operation-1',
            revision: 1,
            actionId: 'session.fork',
            state: 'running',
            scope: { accountId: 'account-1', machineId: 'machine-1', sessionId: 'session-1' },
            title: 'Fork session',
            createdAt: 100,
            startedAt: 110,
            cancellation: 'unsupported',
            ...overrides,
        },
        observation: 'available',
        isUnavailableProjection: false,
    };
}

describe('ActionOperationActivityButtonView', () => {
    it('stays absent when there is no active or unseen operation', async () => {
        const { ActionOperationActivityButtonView } = await import('./ActionOperationActivityButton');
        const screen = await renderScreen(
            <ActionOperationActivityButtonView
                operations={[]}
                hasAttention={false}
                onOpenOperation={() => {}}
                onMarkVisibleTerminalSeen={() => {}}
            />,
        );

        expect(screen.findByTestId('action-operation-activity-button')).toBeNull();
    });

    it('opens the shared responsive ledger and preserves its portal contract', async () => {
        const onOpenOperation = vi.fn();
        const markSeen = vi.fn();
        const { ActionOperationActivityButtonView } = await import('./ActionOperationActivityButton');
        const screen = await renderScreen(
            <ActionOperationActivityButtonView
                operations={[operation()]}
                hasAttention={true}
                preferredSessionId="session-1"
                onOpenOperation={onOpenOperation}
                onMarkVisibleTerminalSeen={markSeen}
            />,
        );

        await act(async () => {
            await screen.findByTestId('action-operation-activity-button')?.props.onPress({
                currentTarget: {
                    getBoundingClientRect: () => ({ left: 262, top: 6, width: 44, height: 44 }),
                },
            });
        });

        expect(screen.findByTestId('action-operation-activity-popover')).not.toBeNull();
        expect(screen.findByTestId('inbox.action-operation.operation-1')).not.toBeNull();
        expect(capturedPopoverProps.current?.placement).toBe('bottom');
        expect(capturedPopoverProps.current?.anchor).toEqual({
            kind: 'rect',
            rect: { left: 262, top: 6, width: 44, height: 44 },
            coordinateSpace: 'window',
        });
        expect(capturedPopoverProps.current?.boundaryRef).toBeNull();
        expect(capturedPopoverProps.current?.portal).toEqual({
            web: { target: 'body' },
            native: true,
            matchAnchorWidth: false,
            anchorAlign: 'end',
        });
        expect(markSeen).toHaveBeenCalled();

        act(() => {
            screen.findByTestId('inbox.action-operation.operation-1')?.props.onPress();
        });
        expect(onOpenOperation).toHaveBeenCalledWith('operation-1');
    });

    it('keeps an unseen terminal ledger mounted while marking it seen', async () => {
        const markSeen = vi.fn();
        const clearRecent = vi.fn();
        const { ActionOperationActivityButtonView } = await import('./ActionOperationActivityButton');
        const screen = await renderScreen(
            <ActionOperationActivityButtonView
                operations={[operation({ state: 'succeeded', settledAt: 200 })]}
                hasAttention={true}
                onOpenOperation={() => {}}
                onMarkVisibleTerminalSeen={markSeen}
                onClearRecent={clearRecent}
            />,
        );

        await screen.pressByTestIdAsync('action-operation-activity-button');
        expect(screen.findByTestId('action-operation-activity-popover')).not.toBeNull();
        expect(markSeen).toHaveBeenCalled();

        await screen.pressByTestIdAsync('action-operations-clear-recent');
        expect(clearRecent).toHaveBeenCalledOnce();
        expect(screen.findByTestId('action-operation-activity-popover')).toBeNull();
    });

    it('uses an attention dot instead of counting unavailable active projections', async () => {
        const { ActionOperationActivityButtonView } = await import('./ActionOperationActivityButton');
        const screen = await renderScreen(
            <ActionOperationActivityButtonView
                operations={[{ ...operation(), observation: 'unavailable', isUnavailableProjection: true }]}
                hasAttention={true}
                onOpenOperation={() => {}}
                onMarkVisibleTerminalSeen={() => {}}
            />,
        );

        expect(screen.findByTestId('action-operation-activity-attention-dot')).not.toBeNull();
        expect(screen.findByTestId('action-operation-activity-count')).toBeNull();
    });

    it('counts a listed active row but not an omitted active row from the same machine', async () => {
        const { ActionOperationActivityButtonView } = await import('./ActionOperationActivityButton');
        const screen = await renderScreen(
            <ActionOperationActivityButtonView
                operations={[
                    operation({ operationId: 'operation-listed' }),
                    {
                        ...operation({ operationId: 'operation-omitted' }),
                        observation: 'unavailable',
                        isUnavailableProjection: true,
                    },
                ]}
                hasAttention={true}
                onOpenOperation={() => {}}
                onMarkVisibleTerminalSeen={() => {}}
            />,
        );

        expect(screen.findByTestId('action-operation-activity-count')).not.toBeNull();
        expect(screen.getTextContent()).toContain('1');
        expect(screen.findByTestId('action-operation-activity-attention-dot')).toBeNull();
    });
});
