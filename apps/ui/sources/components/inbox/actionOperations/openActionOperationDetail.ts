import * as React from 'react';

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
}
