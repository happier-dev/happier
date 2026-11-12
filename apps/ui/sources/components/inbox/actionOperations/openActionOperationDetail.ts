import * as React from 'react';

import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { actionOperationSelectors } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { refreshActionOperationSnapshot } from '@/sync/domains/actionOperations/consumeActionOperationSnapshotPush';
import { Modal } from '@/modal';
import { t } from '@/text';
import type { ActionOperationAddress } from '@/sync/domains/actionOperations/qualifiedActionOperation';

import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import { retryableLazy } from '@/components/ui/performance/retryableLazy';

const DetailContent = retryableLazy(async () => ({
    default: (await import('./ActionOperationDetailModal')).ActionOperationDetailModal,
}));

function ActionOperationDetail(props: React.ComponentProps<typeof DetailContent>) {
    return React.createElement(React.Suspense, { fallback: React.createElement(PaneLoadingFallback) },
        React.createElement(DetailContent, props));
}

/** Canonical imperative entrypoint for launcher receipt binding and Inbox row reopen. */
export function openActionOperationDetail(address: ActionOperationAddress): void {
    if (!address.serverId?.trim()) return;
    Modal.show({
        component: ActionOperationDetail,
        props: address,
        closeOnBackdrop: true,
        accessibilityLabel: t('inbox.actionOperations.detailAccessibilityLabel'),
    });
    actionOperationStore.markTerminalSeen(address);
    const operation = actionOperationSelectors.selectById(actionOperationStore.getSnapshot(), address);
    if (operation) {
        // Activity keeps a result-free summary; Details reads the retained owner result.
        void refreshActionOperationSnapshot({
            operation,
            readSnapshot: async operationId => {
                const { getActionOperation } = await import('@/sync/ops/actionOperations');
                return getActionOperation({
                    serverId: operation.serverId,
                    accountId: operation.snapshot.scope.accountId,
                    machineId: operation.snapshot.scope.machineId,
                    operationId,
                });
            },
        });
    }
}
