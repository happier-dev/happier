import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

import { ActionOperationLedgerView } from './ActionOperationLedger';

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

afterEach(async () => {
    await standardCleanup();
});

describe('ActionOperationLedgerView', () => {
    it('offers a restrained bulk clear only for successful recent rows', async () => {
        const onClearRecent = vi.fn();
        const screen = await renderScreen(
            <ActionOperationLedgerView
                operations={[{
                    snapshot: {
                        version: 1,
                        operationId: 'operation-success',
                        revision: 2,
                        actionId: 'session.spawn_new',
                        state: 'succeeded',
                        scope: { accountId: 'account-1', machineId: 'machine-1' },
                        title: 'Create session',
                        createdAt: 100,
                        startedAt: 110,
                        settledAt: 120,
                        cancellation: 'unsupported',
                    },
                    observation: 'available',
                    isUnavailableProjection: false,
                }]}
                onOpenOperation={vi.fn()}
                onClearRecent={onClearRecent}
            />,
        );

        await screen.pressByTestIdAsync('action-operations-clear-recent');
        expect(onClearRecent).toHaveBeenCalledTimes(1);
    });

    it('offers Stop on a cancellable running row without opening its detail', async () => {
        const onOpenOperation = vi.fn();
        const onCancelOperation = vi.fn();
        const screen = await renderScreen(
            <ActionOperationLedgerView
                operations={[{
                    snapshot: {
                        version: 1,
                        operationId: 'operation-1',
                        revision: 2,
                        actionId: 'session.fork',
                        state: 'running',
                        scope: { accountId: 'account-1', machineId: 'machine-1', sessionId: 'session-1' },
                        title: 'Fork session',
                        createdAt: 100,
                        startedAt: 120,
                        cancellation: 'supported',
                    },
                    observation: 'available',
                    isUnavailableProjection: false,
                }]}
                onOpenOperation={onOpenOperation}
                onCancelOperation={onCancelOperation}
            />,
        );

        await screen.pressByTestIdAsync('action-operation-stop.operation-1');
        expect(onCancelOperation).toHaveBeenCalledWith('operation-1');
        expect(onOpenOperation).not.toHaveBeenCalled();
    });

    it('moves unavailable active work to attention with Dismiss, no Stop, and status only in accessibility', async () => {
        const onOpenOperation = vi.fn();
        const onCancelOperation = vi.fn();
        const onDismissOperation = vi.fn();
        const screen = await renderScreen(
            <ActionOperationLedgerView
                operations={[{
                    snapshot: {
                        version: 1,
                        operationId: 'operation-unavailable',
                        revision: 2,
                        actionId: 'session.fork',
                        state: 'running',
                        scope: { accountId: 'account-1', machineId: 'machine-1', sessionId: 'session-1' },
                        title: 'Fork session',
                        createdAt: 100,
                        startedAt: 120,
                        cancellation: 'supported',
                    },
                    observation: 'unavailable',
                    isUnavailableProjection: true,
                }]}
                onOpenOperation={onOpenOperation}
                onCancelOperation={onCancelOperation}
                onDismissOperation={onDismissOperation}
            />,
        );

        expect(screen.getTextContent()).toContain('Needs attention');
        expect(screen.getTextContent()).not.toContain('Status unavailable');
        expect(screen.findByTestId('action-operation-stop.operation-unavailable')).toBeNull();
        expect(screen.findByTestId('action-operation-dismiss.operation-unavailable')).not.toBeNull();
        expect(screen.findByTestId('inbox.action-operation.operation-unavailable')?.props.accessibilityLabel)
            .toContain('Status unavailable');

        await screen.pressByTestIdAsync('action-operation-dismiss.operation-unavailable');
        expect(onDismissOperation).toHaveBeenCalledWith('operation-unavailable');
        expect(onCancelOperation).not.toHaveBeenCalled();
        expect(onOpenOperation).not.toHaveBeenCalled();
    });

    it('keeps terminal and reconnecting status words out of visible ledger copy', async () => {
        const screen = await renderScreen(
            <ActionOperationLedgerView
                operations={[
                    {
                        snapshot: {
                            version: 1,
                            operationId: 'operation-success',
                            revision: 2,
                            actionId: 'session.spawn_new',
                            state: 'succeeded',
                            scope: { accountId: 'account-1', machineId: 'machine-1' },
                            title: 'Create session',
                            createdAt: 100,
                            settledAt: 120,
                            cancellation: 'unsupported',
                        },
                        observation: 'available',
                        isUnavailableProjection: false,
                    },
                    {
                        snapshot: {
                            version: 1,
                            operationId: 'operation-reconnecting',
                            revision: 1,
                            actionId: 'session.fork',
                            state: 'running',
                            scope: { accountId: 'account-1', machineId: 'machine-2' },
                            title: 'Fork session',
                            createdAt: 100,
                            cancellation: 'unsupported',
                        },
                        observation: 'reconnecting',
                        isUnavailableProjection: false,
                    },
                ]}
                onOpenOperation={vi.fn()}
            />,
        );

        expect(screen.getTextContent()).not.toContain('Completed');
        expect(screen.getTextContent()).not.toContain('Reconnecting');
        expect(screen.findByTestId('inbox.action-operation.operation-success')?.props.accessibilityLabel)
            .toContain('Completed');
        expect(screen.findByTestId('inbox.action-operation.operation-reconnecting')?.props.accessibilityLabel)
            .toContain('Reconnecting');
    });
});
