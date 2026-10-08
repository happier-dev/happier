import * as React from 'react';
import type { EntityDropOutcomeV1 } from '@happier-dev/protocol/plugins/ui';
import type { EntityDragDropRuntime } from '@/components/ui/treeDragDrop';
import { Modal } from '@/modal';
import { t } from '@/text';
import { HappyError } from '@/utils/errors/errors';

type SessionListMoveSheetSource = Readonly<{ sourceId: string; dispose: () => void }>;
export type OpenSessionListMoveSheetParams = Readonly<{
    sourceLabel: string;
    runtime: EntityDragDropRuntime;
    prepareSource: () => SessionListMoveSheetSource | null;
}>;
export type UseSessionListMoveSheetResult = Readonly<{ openMoveSheet: (params: OpenSessionListMoveSheetParams) => Promise<EntityDropOutcomeV1 | null> }>;

export function useSessionListMoveSheet(): UseSessionListMoveSheetResult {
    const openMoveSheet = React.useCallback(async (params: OpenSessionListMoveSheetParams) => {
        let source: SessionListMoveSheetSource | null = null;
        try {
            source = params.prepareSource();
            if (!source) {
                Modal.alert(t('sessionsList.moveToFolder'), t('sessionsList.moveSheetEmpty'));
                return null;
            }
            const sourceId = source.sourceId;
            const { SessionListMoveSheet } = await import('./SessionListMoveSheet');
            return await new Promise<EntityDropOutcomeV1 | null>(resolve => {
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
                    props: { sourceLabel: params.sourceLabel, runtime: params.runtime, sourceId, onComplete: settle, onCancel: () => settle(null) },
                });
            });
        } catch (error) {
            Modal.alert(t('common.error'), error instanceof HappyError ? error.message : t('errors.unknownError'));
            return null;
        } finally {
            source?.dispose();
        }
    }, []);
    return { openMoveSheet };
}
