import * as React from 'react';
import { Modal } from '@/modal';
import type { SessionProjectAssignment } from '@/sync/domains/session/organization/projectAssignment';
import { SessionProjectMoveSheet, type SessionProjectMoveTarget } from './SessionProjectMoveSheet';

export function useSessionProjectMoveSheet() {
    const openProjectMoveSheet = React.useCallback((params: Readonly<{ targets: readonly SessionProjectMoveTarget[]; canRestore: boolean }>) => (
        new Promise<SessionProjectAssignment | null | undefined>((resolve) => {
            let settled = false;
            let modalId: string | null = null;
            const settle = (project: SessionProjectAssignment | null | undefined) => {
                if (settled) return;
                settled = true;
                if (modalId) Modal.hide(modalId);
                resolve(project);
            };
            modalId = Modal.show({ component: SessionProjectMoveSheet, chrome: { kind: 'card' }, closeOnBackdrop: true,
                onRequestClose: () => settle(undefined),
                props: { ...params, onSelect: settle, onCancel: () => settle(undefined) },
            });
        })
    ), []);
    return { openProjectMoveSheet };
}
