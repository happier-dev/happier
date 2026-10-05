import * as React from 'react';
import type { EntityDropOutcomeV1 } from '@happier-dev/protocol/plugins/ui';
import type { EntityDragDropRuntime } from '@/components/ui/treeDragDrop';
import { Modal } from '@/modal';
import { t } from '@/text';

export type OpenSessionListMoveSheetParams = Readonly<{ sourceLabel: string; runtime: EntityDragDropRuntime; sourceId: string }>;
export type UseSessionListMoveSheetResult = Readonly<{ openMoveSheet: (params: OpenSessionListMoveSheetParams) => Promise<EntityDropOutcomeV1 | null> }>;

export function useSessionListMoveSheet(): UseSessionListMoveSheetResult {
    const openMoveSheet = React.useCallback(async (params: OpenSessionListMoveSheetParams) => {
        const { SessionListMoveSheet } = await import('./SessionListMoveSheet');
        return new Promise<EntityDropOutcomeV1 | null>(resolve => {
            let settled = false;
            let modalId: string | null = null;
            const settle = (outcome: EntityDropOutcomeV1 | null) => {
                if (settled) return;
                settled = true;
                if (modalId) Modal.hide(modalId);
                resolve(outcome);
            };
            modalId = Modal.show({ component: SessionListMoveSheet,
                chrome: { kind: 'card', title: t('sessionsList.moveSheetTitle', { item: params.sourceLabel }) },
                closeOnBackdrop: true, onRequestClose: () => settle(null),
                props: { ...params, onComplete: settle, onCancel: () => settle(null) },
            });
        });
    }, []);
    return { openMoveSheet };
}
