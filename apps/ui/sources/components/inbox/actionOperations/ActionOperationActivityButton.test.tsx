import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { actionOperationSelectors } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { Popover } from '@/components/ui/popover';
import { readHitArea } from '@/dev/testkit/harness/hitFrameReach';

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

vi.mock('@/components/ui/popover', async (importOriginal) =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal,
        { maxHeight: 560, maxWidth: 396, placement: 'bottom' }),
);

function operation(overrides: Partial<ActionOperationSnapshotV1> = {}): ActionOperationProjection {
    return {
        serverId: 'server-1',
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
    beforeEach(() => actionOperationStore.reset());
    afterEach(() => {
        standardCleanup();
        actionOperationStore.reset();
        vi.restoreAllMocks();
    });

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
        const projectedOperation = operation();
        const { ActionOperationActivityButtonView } = await import('./ActionOperationActivityButton');
        const screen = await renderScreen(
            <ActionOperationActivityButtonView
                operations={[projectedOperation]}
                hasAttention={true}
                preferredSessionAddress={{ serverId: 'server-1', sessionId: 'session-1' }}
                onOpenOperation={onOpenOperation}
                onMarkVisibleTerminalSeen={markSeen}
            />,
            {
                // The anchor wraps the button's own box: its rect is what the popover anchors to on the web.
                createNodeMock: (element) => (
                    (element as { props?: { collapsable?: boolean } }).props?.collapsable === false
                        ? { getBoundingClientRect: () => ({ left: 262, top: 6, width: 44, height: 44 }) }
                        : null
                ),
            },
        );

        await act(async () => {
            await screen.findByTestId('action-operation-activity-button')?.props.onPress();
        });

        expect(screen.findAllByType(Popover)).toHaveLength(1);
        expect(screen.findByTestId('inbox.action-operation.operation-1')).not.toBeNull();
        const popoverProps = screen.findAllByType(Popover)[0]?.props;
        expect(popoverProps?.placement).toBe('bottom');
        expect(popoverProps?.anchor).toEqual({
            kind: 'rect',
            rect: { left: 262, top: 6, width: 44, height: 44 },
            coordinateSpace: 'window',
        });
        expect(popoverProps?.boundaryRef).toBeNull();
        expect(popoverProps?.portal).toEqual({
            web: { target: 'body' },
            native: true,
            matchAnchorWidth: false,
            anchorAlign: 'end',
        });
        expect(markSeen).toHaveBeenCalled();

        act(() => {
            screen.findByTestId('inbox.action-operation.operation-1')?.props.onPress();
        });
        expect(onOpenOperation).toHaveBeenCalledWith(projectedOperation);
        expect(screen.findAllByType(Popover)).toHaveLength(0);
    });

    it('opens the exact Home-qualified projection when operation ids collide across Homes', async () => {
        const onOpenOperation = vi.fn();
        const first = operation();
        const second = { ...operation(), serverId: 'server-2' };
        const { ActionOperationActivityButtonView } = await import('./ActionOperationActivityButton');
        const screen = await renderScreen(
            <ActionOperationActivityButtonView
                operations={[first, second]}
                hasAttention={true}
                onOpenOperation={onOpenOperation}
                onMarkVisibleTerminalSeen={() => {}}
            />,
        );

        await screen.pressByTestIdAsync('action-operation-activity-button');
        const matchingRows = screen.findAllByTestId('inbox.action-operation.operation-1')
            .filter((node) => typeof node.type === 'string');
        expect(matchingRows).toHaveLength(2);

        act(() => matchingRows[1]?.props.onPress());
        expect(onOpenOperation).toHaveBeenCalledWith(second);
        expect(onOpenOperation).not.toHaveBeenCalledWith(first);
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
        expect(screen.findAllByType(Popover)).toHaveLength(1);
        expect(markSeen).toHaveBeenCalled();

        await screen.pressByTestIdAsync('action-operations-clear-recent');
        expect(clearRecent).toHaveBeenCalledOnce();
        expect(screen.findAllByType(Popover)).toHaveLength(0);
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

    it('draws the header glyph at the shared icon-button size: a finger reaches it through the hit area, not a larger box', async () => {
        const { ActionOperationActivityButtonView } = await import('./ActionOperationActivityButton');
        const screen = await renderScreen(
            <ActionOperationActivityButtonView
                operations={[operation()]}
                hasAttention={true}
                onOpenOperation={() => {}}
                onMarkVisibleTerminalSeen={() => {}}
            />,
        );

        const button = screen.findHostByTestId('action-operation-activity-button')!;
        expect(readHitArea(button).drawn).toEqual({ width: 28, height: 28 });
    });

    it('subscribes to ledger details only while the activity popover is open', async () => {
        actionOperationStore.mergeSnapshots({ serverId: 'server-1', snapshots: [operation().snapshot] });
        // Observe the real detail selector without replacing its decision or result.
        const detailReads = vi.spyOn(actionOperationSelectors, 'selectAll');
        const { ActionOperationActivityButton } = await import('./ActionOperationActivityButton');
        const screen = await renderScreen(<ActionOperationActivityButton />);

        expect(screen.findByTestId('action-operation-activity-count')).not.toBeNull();
        expect(detailReads).not.toHaveBeenCalled();

        await act(async () => actionOperationStore.mergeSnapshots({ serverId: 'server-1', snapshots: [
            operation({ revision: 2, progress: { kind: 'phase', phase: 'copying', label: 'Copying files' } }).snapshot,
        ] }));
        expect(detailReads).not.toHaveBeenCalled();

        await screen.pressByTestIdAsync('action-operation-activity-button');

        expect(detailReads).toHaveBeenCalled();
        expect(screen.findByTestId('inbox.action-operation.operation-1')).not.toBeNull();
        expect(screen.findByTestId('inbox.action-operation.operation-1')?.props.accessibilityLabel).toContain('Copying files');

        await screen.pressByTestIdAsync('action-operation-activity-button');
        detailReads.mockClear();
        await act(async () => actionOperationStore.mergeSnapshots({ serverId: 'server-1', snapshots: [
            operation({ revision: 3, progress: { kind: 'phase', phase: 'finishing', label: 'Finishing copy' } }).snapshot,
        ] }));
        expect(detailReads).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('action-operation-activity-button');
        expect(screen.findByTestId('inbox.action-operation.operation-1')?.props.accessibilityLabel).toContain('Finishing copy');
    });
});
