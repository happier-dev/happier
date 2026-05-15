import * as React from 'react';

import { Modal } from '@/modal';

import type { SessionListMoveSheetTarget } from './buildSessionListMoveSheetTargets';

export type OpenSessionListMoveSheetParams = Readonly<{
    sourceLabel: string;
    targets: ReadonlyArray<SessionListMoveSheetTarget>;
}>;

export type UseSessionListMoveSheetResult = Readonly<{
    openMoveSheet: (params: OpenSessionListMoveSheetParams) => Promise<SessionListMoveSheetTarget | null>;
}>;

export function useSessionListMoveSheet(): UseSessionListMoveSheetResult {
    const openMoveSheet = React.useCallback(async (params: OpenSessionListMoveSheetParams) => {
        const { SessionListMoveSheet } = await import('./SessionListMoveSheet');
        return new Promise<SessionListMoveSheetTarget | null>((resolve) => {
            let settled = false;
            let modalId: string | null = null;

            const settle = (target: SessionListMoveSheetTarget | null) => {
                if (settled) return;
                settled = true;
                if (modalId) {
                    Modal.hide(modalId);
                }
                resolve(target);
            };

            modalId = Modal.show({
                component: SessionListMoveSheet,
                chrome: { kind: 'card' },
                closeOnBackdrop: true,
                onRequestClose: () => settle(null),
                props: {
                    sourceLabel: params.sourceLabel,
                    targets: params.targets,
                    onSelectTarget: settle,
                    onCancel: () => settle(null),
                },
            });
        });
    }, []);

    return { openMoveSheet };
}
