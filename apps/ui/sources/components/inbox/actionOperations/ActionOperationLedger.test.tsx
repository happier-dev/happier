import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { actionOperationReentry } from '@/sync/domains/actionOperations/actionOperationReentry';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => ({
            'inbox.actionOperations.sections.inProgress': 'In progress',
            'inbox.actionOperations.sections.needsAttention': 'Needs attention',
            'inbox.actionOperations.sections.recent': 'Recent',
            'inbox.actionOperations.clearRecent': 'Clear recent',
            'inbox.actionOperations.status.reconnecting': 'Reconnecting',
            'inbox.actionOperations.status.unavailable': 'Status unavailable',
            'inbox.actionOperations.status.setupNeedsAttention': 'Session created; setup needs attention',
            'inbox.actionOperations.status.accepted': 'Accepted',
            'inbox.actionOperations.status.running': 'Running',
            'inbox.actionOperations.status.succeeded': 'Succeeded',
            'inbox.actionOperations.status.failed': 'Failed',
            'inbox.actionOperations.status.cancelled': 'Cancelled',
            'inbox.actionOperations.dismiss': 'Dismiss',
            'inbox.actionOperations.openHint': 'Opens operation details',
            'inbox.actionOperations.detail.status': 'Status',
            'inbox.actionOperations.detail.progress': 'Progress',
            'inbox.actionOperations.detail.error': 'Error',
            'inbox.actionOperations.detail.warning': 'Warning',
            'inbox.actionOperations.detail.result': 'Result',
            'inbox.actionOperations.detail.recoveryReference': 'Recovery reference',
            'common.done': 'Done',
            'common.collapse': 'Collapse',
            'common.status.running': 'Running',
            'common.status.failed': 'Failed',
            'common.status.succeeded': 'Succeeded',
            'common.status.cancelled': 'Cancelled',
        }[key] ?? key),
    });
});
vi.mock('@/hooks/session/useNavigateToSession', () => ({
    useNavigateToSession: () => vi.fn(),
}));

afterEach(async () => {
    await standardCleanup();
});

function runningOperation(): ActionOperationSnapshotV1 {
    return {
        version: 1,
        operationId: 'operation-1',
        revision: 2,
        actionId: 'session.handoff',
        state: 'running',
        scope: { accountId: 'account-1', machineId: 'machine-1', sessionId: 'session-1' },
        title: 'Hand off session',
        createdAt: 1_700_000_000_000,
        startedAt: 1_700_000_030_000,
        progress: { kind: 'phase', phase: 'transfer', label: 'Transferring workspace' },
        cancellation: 'supported',
    };
}

describe('ActionOperationLedger', () => {
    it('shows successful custody with failed setup as a needs-attention Activity row', async () => {
        const registration = actionOperationReentry.registerNewSession({
            requestId: 'spawn-setup-attention',
            draftScope: { serverId: 'server-1', accountId: 'account-1' },
            draftId: '8e0a5dd1-b1df-43dd-b51e-b7787b30362e',
        });
        if (!registration) throw new Error('expected new-session workflow registration');
        registration.markSetupNeedsAttention('session-created');
        const succeeded: ActionOperationSnapshotV1 = {
            ...runningOperation(),
            operationId: 'operation-setup-attention',
            requestId: 'spawn-setup-attention',
            actionId: 'session.spawn_new',
            revision: 3,
            state: 'succeeded',
            settledAt: 1_700_000_120_000,
            result: { sessionId: 'session-created' },
        };
        const { ActionOperationLedger } = await import('./ActionOperationLedger');
        const screen = await renderScreen(
            <ActionOperationLedger
                operations={[succeeded]}
                onOpenOperation={() => {}}
                nowMs={1_700_000_120_000}
            />,
        );

        expect(screen.getTextContent()).toContain('Needs attention');
        expect(screen.getTextContent()).not.toContain('Session created; setup needs attention');
        expect(screen.getTextContent()).not.toContain('Succeeded');
        expect(screen.findByTestId('action-operation-row-operation-setup-attention')?.props.accessibilityLabel)
            .toContain('Session created; setup needs attention');
    });

    it('offers restrained recent cleanup without routing active or failed rows through it', async () => {
        const onClearRecent = vi.fn();
        const { ActionOperationLedger } = await import('./ActionOperationLedger');
        const failed: ActionOperationSnapshotV1 = {
            ...runningOperation(),
            operationId: 'operation-failed',
            revision: 3,
            state: 'failed',
            settledAt: 1_700_000_120_000,
            error: { errorCode: 'failed', error: 'Failed' },
        };
        const succeeded: ActionOperationSnapshotV1 = {
            ...runningOperation(),
            operationId: 'operation-succeeded',
            revision: 3,
            state: 'succeeded',
            settledAt: 1_700_000_120_000,
        };
        const screen = await renderScreen(
            <ActionOperationLedger
                operations={[runningOperation(), failed, succeeded]}
                onOpenOperation={() => {}}
                onClearRecent={onClearRecent}
                nowMs={1_700_000_120_000}
            />,
        );

        expect(screen.findByTestId('action-operation-row-operation-1')).not.toBeNull();
        expect(screen.findByTestId('action-operation-row-operation-failed')).not.toBeNull();
        expect(screen.findByTestId('action-operation-row-operation-succeeded')).not.toBeNull();
        await screen.pressByTestIdAsync('action-operation-clear-recent');
        expect(onClearRecent).toHaveBeenCalledTimes(1);
    });

    it('renders a truthful reconnecting row with a keyboard-capable Item press target', async () => {
        const onOpenOperation = vi.fn();
        const { ActionOperationLedger } = await import('./ActionOperationLedger');
        const screen = await renderScreen(
            <ActionOperationLedger
                operations={[runningOperation()]}
                observationForOperation={() => 'reconnecting'}
                onOpenOperation={onOpenOperation}
                nowMs={1_700_000_120_000}
            />,
        );

        const row = screen.findByTestId('action-operation-row-operation-1');
        expect(row?.props.accessibilityState?.busy).toBe(true);
        expect(row?.props.accessibilityLabel).toContain('Reconnecting');
        expect(screen.getTextContent()).toContain('Transferring workspace');
        expect(screen.getTextContent()).not.toContain('Reconnecting');
        row?.props.onPress();
        expect(onOpenOperation).toHaveBeenCalledWith('operation-1');
    });

    it('shows status with a compact glyph only and lets an unavailable active row be dismissed', async () => {
        const onDismissOperation = vi.fn();
        const onCancelOperation = vi.fn();
        const { ActionOperationLedger } = await import('./ActionOperationLedger');
        const operation = { ...runningOperation(), progress: undefined };
        const screen = await renderScreen(
            <ActionOperationLedger
                operations={[operation]}
                observationForOperation={() => 'status_unavailable'}
                contextForOperation={() => 'leeroy-mbp'}
                onOpenOperation={() => {}}
                onCancelOperation={onCancelOperation}
                canDismissOperation={() => true}
                onDismissOperation={onDismissOperation}
                nowMs={1_700_000_120_000}
            />,
        );

        expect(screen.getTextContent()).toContain('Needs attention');
        expect(screen.getTextContent()).toContain('leeroy-mbp');
        expect(screen.getTextContent()).not.toContain('Status unavailable');
        expect(screen.findByTestId('action-operation-stop-operation-1')).toBeNull();
        await screen.pressByTestIdAsync('action-operation-dismiss-operation-1');
        expect(onDismissOperation).toHaveBeenCalledWith('operation-1');
        expect(onCancelOperation).not.toHaveBeenCalled();
    });

    it('does not repeat terminal status as visible row text', async () => {
        const { ActionOperationLedger } = await import('./ActionOperationLedger');
        const succeeded: ActionOperationSnapshotV1 = {
            ...runningOperation(),
            revision: 3,
            state: 'succeeded',
            settledAt: 1_700_000_120_000,
            progress: undefined,
        };
        const screen = await renderScreen(
            <ActionOperationLedger
                operations={[succeeded]}
                contextForOperation={() => 'leeroy-mbp'}
                onOpenOperation={() => {}}
                nowMs={1_700_000_120_000}
            />,
        );

        expect(screen.getTextContent()).not.toContain('Succeeded');
        expect(screen.findByTestId('action-operation-row-operation-1')?.props.accessibilityLabel).toContain('Succeeded');
    });

    it('renders a successful handoff cleanup warning and terminal Done affordance', async () => {
        const { ActionOperationDetail } = await import('./ActionOperationDetail');
        const operation: ActionOperationSnapshotV1 = {
            ...runningOperation(),
            revision: 7,
            state: 'succeeded',
            settledAt: 1_700_000_120_000,
            result: {
                handoffId: 'handoff-1',
                status: { status: 'completed' },
                warning: { code: 'source_cleanup_failed', message: 'Source cleanup requires attention' },
            },
            domainRef: { kind: 'handoff', id: 'handoff-1' },
        };
        const screen = await renderScreen(
            <ActionOperationDetail
                operation={operation}
                observation="available"
                onClose={() => {}}
            />,
        );

        expect(screen.getTextContent()).toContain('Warning');
        expect(screen.getTextContent()).toContain('Source cleanup requires attention');
        expect(screen.getTextContent()).toContain('handoff-1 · completed');
        expect(screen.getTextContent()).not.toContain('Recovery reference');
        expect(screen.getTextContent()).toContain('Done');
        expect(screen.getTextContent()).not.toContain('Collapse');
    });

    it('keeps an active detail collapsible and exposes its acknowledged Stop action', async () => {
        const { ActionOperationDetail } = await import('./ActionOperationDetail');
        const onCancel = vi.fn();
        const screen = await renderScreen(
            <ActionOperationDetail
                operation={runningOperation()}
                observation="available"
                onClose={() => {}}
                onCancel={onCancel}
            />,
        );

        expect(screen.getTextContent()).toContain('Collapse');
        expect(screen.getTextContent()).not.toContain('Done');
        await screen.pressByTestIdAsync('action-operation-stop');
        expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it('offers the same Stop action directly on a cancellable running ledger row', async () => {
        const onCancelOperation = vi.fn();
        const onOpenOperation = vi.fn();
        const { ActionOperationLedger } = await import('./ActionOperationLedger');
        const screen = await renderScreen(
            <ActionOperationLedger
                operations={[runningOperation()]}
                onOpenOperation={onOpenOperation}
                onCancelOperation={onCancelOperation}
                nowMs={1_700_000_120_000}
            />,
        );

        await screen.pressByTestIdAsync('action-operation-stop-operation-1');
        expect(onCancelOperation).toHaveBeenCalledWith('operation-1');
        expect(onOpenOperation).not.toHaveBeenCalled();
    });

    it('marks the same visible detail seen only when its running operation terminalizes', async () => {
        const operationId = 'operation-visible-transition';
        const running: ActionOperationSnapshotV1 = {
            ...runningOperation(),
            operationId,
        };
        actionOperationStore.merge(running);
        const { ActionOperationDetailModal } = await import('./openActionOperationDetail');
        await renderScreen(
            <ActionOperationDetailModal
                operationId={operationId}
                onClose={() => {}}
                refreshDetail={async () => {}}
            />,
        );
        expect(actionOperationStore.getState().terminalSeenAtById.has(operationId)).toBe(false);

        await act(async () => {
            actionOperationStore.merge({
                ...running,
                revision: running.revision + 1,
                state: 'succeeded',
                settledAt: 1_700_000_120_000,
                result: { type: 'success', sessionId: 'session-created' },
            });
        });

        expect(actionOperationStore.getState().terminalSeenAtById.has(operationId)).toBe(true);
    });
});
